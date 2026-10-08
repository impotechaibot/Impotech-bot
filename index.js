      return res.json({
        success: true,

        senderId,

        displayName:
          profileName ||
          customerCache.get(
            senderId
          )?.displayName ||
          senderId,

        messages,
      });

    } catch (error) {
      console.error(
        'customer messages fetch error:',
        error.message
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            error.message,
        });
    }
  }
);

// -----------------------------------------------------------------------------
// MANUAL ADMIN REPLY (FROM ANDROID ADMIN APP)
// -----------------------------------------------------------------------------

app.post(
  '/api/customers/:senderId/reply',
  requireAdmin,
  async (req, res) => {
    try {
      const senderId =
        String(
          req.params.senderId ||
          ''
        ).trim();

      if (
        !isValidSenderId(
          senderId
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              'INVALID_SENDER_ID',
          });
      }

      const text =
        safeText(
          req.body?.text ||
          req.body?.message ||
          '',
          5000
        );

      if (!text) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              'MESSAGE_TEXT_REQUIRED',
          });
      }

      /*
       * Sending a manual message automatically enables personal human takeover
       * so AI does not jump in and double-respond to the customer.
       */
      const autoPause =
        req.body?.autoPause !== false;

      if (autoPause) {
        await setPersonalTakeover(
          senderId,
          true,
          'Admin Sent Manual Reply',
          null
        );
      }

      const messageId =
        await sendMessengerText(
          senderId,
          text
        );

      await recordOutgoingMessage(
        senderId,
        text,
        'human'
      );

      await updateCustomerLastMessage(
        senderId,
        text
      );

      return res.json({
        success: true,

        senderId,

        messageId,

        text,

        sentAt:
          nowIso(),

        isPersonallyPaused:
          isPersonalTakeoverActive(
            senderId
          ),
      });

    } catch (error) {
      console.error(
        `❌ Admin manual reply error for ${req.params?.senderId}:`,
        error.response?.data ||
        error.message
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            error.response?.data?.error?.message ||
            error.message,
        });
    }
  }
);

// -----------------------------------------------------------------------------
// ORDERS API
// -----------------------------------------------------------------------------

app.get(
  '/api/orders',
  requireAdmin,
  async (req, res) => {
    try {
      const limitRaw =
        Number(
          req.query.limit ||
          100
        );

      const limit =
        Math.min(
          Math.max(
            Number.isFinite(
              limitRaw
            )
              ? limitRaw
              : 100,
            1
          ),
          500
        );

      if (!pool) {
        return res.json({
          success: true,
          orders:
            savedOrders.slice(
              0,
              limit
            ),
        });
      }

      const result =
        await dbQuery(`
          SELECT
            id,
            sender_id,
            phone,
            message_text,
            created_at

          FROM customer_orders

          ORDER BY
            created_at DESC

          LIMIT $1
        `, [
          limit,
        ]);

      const orders =
        result.rows.map(
          row => ({
            id:
              String(
                row.id
              ),

            senderId:
              String(
                row.sender_id
              ),

            phone:
              row.phone,

            messageText:
              row.message_text,

            createdAt:
              new Date(
                row.created_at
              ).toISOString(),
          })
        );

      return res.json({
        success: true,

        orders,
      });

    } catch (error) {
      return res
        .status(500)
        .json({
          success: false,
          error:
            error.message,
        });
    }
  }
);

// -----------------------------------------------------------------------------
// KNOWLEDGE BASE / CATALOG READ API
// -----------------------------------------------------------------------------

app.get(
  '/api/catalog',
  requireAdmin,
  async (req, res) => {
    return res.json({
      success: true,

      knowledgeBase,

      productsCount:
        products.length,

      faqsCount:
        faqs.length,

      additionalKnowledgeFiles:
        Object.keys(
          additionalKnowledge
        ),
    });
  }
);

// -----------------------------------------------------------------------------
// TRAINING / KNOWLEDGE WRITE API
// -----------------------------------------------------------------------------

app.post(
  '/api/training',
  requireAdmin,
  async (req, res) => {
    try {
      console.log(
        '📥 Received training payload update...'
      );

      const result =
        await pushTrainingToGitHub(
          req.body
        );

      /*
       * Synchronize local memory immediately with updated catalog.
       */
      knowledgeBase =
        result.finalCatalog;

      const arrays =
        extractCatalogArrays(
          knowledgeBase
        );

      products =
        arrays.products;

      faqs =
        arrays.faqs;

      console.log(
        `✅ Catalog training complete: ` +
        `${products.length} products, ` +
        `${faqs.length} FAQs updated.`
      );

      return res.json({
        success: true,

        commitSha:
          result.commitSha,

        commitUrl:
          result.commitUrl,

        branch:
          result.branch,

        file:
          result.file,

        productsCount:
          products.length,

        faqsCount:
          faqs.length,

        indexJsModified:
          false,
      });

    } catch (error) {
      console.error(
        '❌ Training API error:',
        error.response?.data ||
        error.message
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            error.response?.data?.message ||
            error.message,
        });
    }
  }
);

// -----------------------------------------------------------------------------
// DATA RETENTION CLEANUP
// -----------------------------------------------------------------------------

async function runDataRetentionCleanup() {
  if (
    !pool ||
    DATA_RETENTION_DAYS <= 0
  ) {
    return;
  }

  try {
    const deletedMessages =
      await dbQuery(`
        DELETE FROM conversation_messages
        WHERE created_at < NOW() - INTERVAL '1 day' * $1
      `, [
        DATA_RETENTION_DAYS,
      ]);

    const deletedOrders =
      await dbQuery(`
        DELETE FROM customer_orders
        WHERE created_at < NOW() - INTERVAL '1 day' * $1
      `, [
        DATA_RETENTION_DAYS,
      ]);

    if (
      deletedMessages.rowCount > 0 ||
      deletedOrders.rowCount > 0
    ) {
      console.log(
        `🧹 Retention Cleanup (${DATA_RETENTION_DAYS}d): ` +
        `Purged ${deletedMessages.rowCount} old messages, ` +
        `${deletedOrders.rowCount} old orders.`
      );
    }

  } catch (error) {
    console.error(
      'Retention cleanup error:',
      error.message
    );
  }
}

// -----------------------------------------------------------------------------
// EXPIRY CHECKER FOR PERSONAL TAKEOVERS
// -----------------------------------------------------------------------------

function checkExpiredTakeovers() {
  const now = Date.now();

  for (
    const [senderId, state]
    of personalTakeoverStates.entries()
  ) {
    if (
      state.isPaused &&
      state.expiresAt &&
      new Date(state.expiresAt).getTime() <= now
    ) {
      personalTakeoverStates.delete(senderId);

      console.log(
        `⏰ Personal takeover expired for ${senderId}. AI restored.`
      );

      if (pool) {
        void dbQuery(`
          UPDATE customer_takeover_states
          SET
            is_paused=FALSE,
            reason='Takeover Expired',
            expires_at=NULL,
            updated_at=NOW()
          WHERE sender_id=$1
        `, [
          senderId,
        ]).catch(
          error =>
            console.error(
              'Takeover expiry update error:',
              error.message
            )
        );
      }
    }
  }
}

// -----------------------------------------------------------------------------
// SYSTEM STATUS / HEALTHCHECK
// -----------------------------------------------------------------------------

app.get(
  '/',
  (req, res) => {
    return res.status(200).send(
      `Impotech AI Messenger Bot is running.\n` +
      `Global AI: ${
        globalPausedState.isPaused
          ? 'PAUSED'
          : 'ACTIVE'
      }\n` +
      `Model: ${AI_MODEL}\n` +
      `Uptime: ${
        serverStartedAt
          ? Math.floor(
              (Date.now() -
                serverStartedAt) /
                1000
            ) + 's'
          : 'n/a'
      }`
    );
  }
);

app.get(
  '/health',
  (req, res) => {
    return res.json({
      status: 'OK',

      uptime:
        serverStartedAt
          ? Math.floor(
              (Date.now() -
                serverStartedAt) /
                1000
            )
          : 0,

      globalPaused:
        globalPausedState.isPaused,

      activePersonalTakeovers:
        getActivePersonalTakeoverCount(),

      productsCount:
        products.length,

      faqsCount:
        faqs.length,

      databaseConnected:
        Boolean(pool),

      timestamp:
        nowIso(),
    });
  }
);

// -----------------------------------------------------------------------------
// SERVER INITIALIZATION & SHUTDOWN
// -----------------------------------------------------------------------------

async function startServer() {
  serverStartedAt = Date.now();

  try {
    if (pool) {
      await initDatabase();
      await restorePersistentState();
    } else {
      console.warn(
        '⚠️ Running in memory-only mode without PostgreSQL persistence.'
      );
    }

    /*
     * Initial catalog pull from GitHub repository.
     */
    await loadCatalogFromGitHub();

    /*
     * Background refresh for catalog sync every 15 minutes.
     */
    catalogSyncTimer =
      setInterval(
        () => {
          void loadCatalogFromGitHub().catch(
            err =>
              console.error(
                'Background catalog sync failed:',
                err.message
              )
          );
        },
        15 * 60 * 1000
      );

    /*
     * Background data retention cleanup once every 12 hours.
     */
    cleanupTimer =
      setInterval(
        () => {
          void runDataRetentionCleanup();
        },
        12 * 60 * 60 * 1000
      );

    /*
     * Run initial cleanup on startup.
     */
    void runDataRetentionCleanup();

    /*
     * Check for expired personal takeover timers every 1 minute.
     */
    expiryTimer =
      setInterval(
        checkExpiredTakeovers,
        60 * 1000
      );

    /*
     * Express Server Listening
     */
    const server =
      app.listen(
        PORT,
        () => {
          console.log(
            `\n🚀 IMPOTECH AI MESSENGER BOT RUNNING ON PORT ${PORT}`
          );
          console.log(
            `🤖 Model: ${AI_MODEL}`
          );
          console.log(
            `📦 Catalog: ${products.length} products, ${faqs.length} FAQs loaded.`
          );
          console.log(
            `⚙️ Global Bot State: ${
              globalPausedState.isPaused
                ? '🔴 PAUSED'
                : '🟢 ACTIVE'
            }`
          );
        }
      );

    /*
     * Graceful Shutdown Handling
     */
    const shutdown = async signal => {
      console.log(
        `\n🛑 Received ${signal}. Gracefully shutting down...`
      );

      if (catalogSyncTimer)
        clearInterval(
          catalogSyncTimer
        );

      if (cleanupTimer)
        clearInterval(
          cleanupTimer
        );

      if (expiryTimer)
        clearInterval(
          expiryTimer
        );

      server.close(
        async () => {
          console.log(
            'HTTP server closed.'
          );

          if (pool) {
            await pool.end();
            console.log(
              'Database connection pool closed.'
            );
          }

          process.exit(0);
        }
      );

      /*
       * Force exit if graceful shutdown takes longer than 10s.
       */
      setTimeout(() => {
        console.error(
          'Could not close connections in time, forcing exit.'
        );
        process.exit(1);
      }, 10000);
    };

    process.on(
      'SIGTERM',
      () =>
        shutdown('SIGTERM')
    );

    process.on(
      'SIGINT',
      () =>
        shutdown('SIGINT')
    );

  } catch (error) {
    console.error(
      '❌ Server failed to start:',
      error
    );

    process.exit(1);
  }
}

startServer();
