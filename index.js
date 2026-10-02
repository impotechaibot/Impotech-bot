/**
 * ImpoTech Bd - Smart Messenger AI Assistant (OpenRouter Edition)
 * Features: PostgreSQL Memory, Auto Cleanup, Steadfast Courier, Vision AI,
 * Human Takeover, Media Sync & Dynamic Catalog Indexing.
 */

const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '25mb' }));

// =========================
// ENVIRONMENT VARIABLES
// =========================
const PORT = process.env.PORT || 10000;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'impotech_secure_token';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

const STEADFAST_API_KEY = process.env.STEADFAST_API_KEY;
const STEADFAST_SECRET_KEY = process.env.STEADFAST_SECRET_KEY;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'impotechaibot/Impotech-bot';
const CATALOG_FILE = 'catalog.json';

const DATA_RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '20', 10);

// =========================
// POSTGRESQL DATABASE SETUP
// =========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') 
    ? { rejectUnauthorized: false } 
    : false,
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        psid VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_psid_created ON conversations(psid, created_at);
    `);
    console.log('[DB] PostgreSQL initialized successfully.');
  } catch (err) {
    console.error('[DB Init Error]', err.message);
  }
}
initDB();

// =========================
// IN-MEMORY STATE & INDEX
// =========================
let products = [];
let faqs = [];
let catalogIndex = new Map(); // Dynamic Indexing
const pausedCustomers = new Set();

// =========================
// HELPER FUNCTIONS
// =========================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s৳$.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value = '') {
  return normalizeText(value)
    .split(/\s+/)
    .filter(word => word.length >= 2);
}

function isValidHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// =========================
// INDEX & CATALOG MANAGER
// =========================
function rebuildCatalogIndex() {
  catalogIndex.clear();
  
  products.forEach(p => {
    const keywords = [
      p.name, p.brand, p.model, p.sku, p.category, 
      ...(Array.isArray(p.keywords) ? p.keywords : [])
    ];
    keywords.forEach(kw => {
      if (kw) {
        const tokens = tokenize(kw);
        tokens.forEach(token => {
          if (!catalogIndex.has(token)) catalogIndex.set(token, new Set());
          catalogIndex.get(token).add(p);
        });
      }
    });
  });
  console.log(`[INDEX] Catalog index updated with ${catalogIndex.size} active tokens.`);
}

function searchCatalog(query) {
  const tokens = tokenize(query);
  if (!tokens.length) return products.slice(0, 3);

  const productScores = new Map();

  tokens.forEach(token => {
    if (catalogIndex.has(token)) {
      catalogIndex.get(token).forEach(product => {
        const currentScore = productScores.get(product) || 0;
        productScores.set(product, currentScore + 10);
      });
    }
  });

  products.forEach(p => {
    const normName = normalizeText(p.name || '');
    const normQuery = normalizeText(query);
    if (normName.includes(normQuery)) {
      const current = productScores.get(p) || 0;
      productScores.set(p, current + 25);
    }
  });

  return Array.from(productScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(entry => entry[0]);
}

// =========================
// GITHUB CATALOG SYNC
// =========================
async function githubRequest(method, url, data = undefined) {
  return axios({
    method,
    url,
    data,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    timeout: 15000
  });
}

async function pullCatalogFromGitHub() {
  if (!GITHUB_TOKEN) return false;
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${CATALOG_FILE}`;
    const response = await githubRequest('GET', url);
    const json = JSON.parse(Buffer.from(response.data.content, 'base64').toString('utf8'));

    products = Array.isArray(json.products) ? json.products : [];
    faqs = Array.isArray(json.faqs) ? json.faqs : [];

    rebuildCatalogIndex();
    console.log(`[GITHUB] Catalog loaded: ${products.length} Products, ${faqs.length} FAQs`);
    return true;
  } catch (error) {
    console.error('[GITHUB] Pull Error:', error.message);
    return false;
  }
}

async function syncCatalogToGitHub() {
  if (!GITHUB_TOKEN) return false;
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${CATALOG_FILE}`;
    const getResp = await githubRequest('GET', url);
    const content = Buffer.from(JSON.stringify({ products, faqs }, null, 2)).toString('base64');

    await githubRequest('PUT', url, {
      message: 'Update catalog.json via API',
      content,
      sha: getResp.data.sha
    });

    rebuildCatalogIndex();
    return true;
  } catch (error) {
    console.error('[GITHUB] Sync Error:', error.message);
    return false;
  }
}

// Initial catalog pull
pullCatalogFromGitHub();

// =========================
// POSTGRES MEMORY SERVICE
// =========================
async function saveConversation(psid, role, message) {
  try {
    await pool.query(
      'INSERT INTO conversations (psid, role, message) VALUES ($1, $2, $3)',
      [psid, role, message]
    );
  } catch (err) {
    console.error('[DB Save Error]', err.message);
  }
}

async function getRecentConversation(psid, limit = 6) {
  try {
    const res = await pool.query(
      'SELECT role, message FROM conversations WHERE psid = $1 ORDER BY created_at DESC LIMIT $2',
      [psid, limit]
    );
    return res.rows.reverse();
  } catch (err) {
    console.error('[DB Fetch Error]', err.message);
    return [];
  }
}

// Auto Cleanup Routine (20 days old data)
async function autoCleanupDB() {
  try {
    const result = await pool.query(
      `DELETE FROM conversations WHERE created_at < NOW() - INTERVAL '${DATA_RETENTION_DAYS} days'`
    );
    console.log(`[DB CLEANUP] Automatically deleted ${result.rowCount} records older than ${DATA_RETENTION_DAYS} days.`);
  } catch (err) {
    console.error('[DB Cleanup Error]', err.message);
  }
}
// Run cleanup every 24 hours
setInterval(autoCleanupDB, 24 * 60 * 60 * 1000);

// =========================
// OPENROUTER AI ENGINE (WITH RETRY)
// =========================
async function callOpenRouterWithRetry(messages, retries = 3) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(
        url,
        {
          model: OPENROUTER_MODEL,
          messages,
          max_tokens: 350,
          temperature: 0.3
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://impotechbd.com',
            'X-Title': 'ImpoTech AI Assistant',
            'Content-Type': 'application/json'
          },
          timeout: 25000
        }
      );

      const reply = response.data?.choices?.[0]?.message?.content?.trim();
      if (reply) return reply;
    } catch (err) {
      console.error(`[OPENROUTER API ERR - Attempt ${attempt}/${retries}]:`, err.message);
      if (attempt < retries) await sleep(3500); // 3.5 sec delay before retry
    }
  }

  return 'সাময়িক প্রযুক্তিগত সমস্যা হচ্ছে, অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।';
}

function buildSystemPrompt(relevantProducts, historyText) {
  const productText = relevantProducts.map(p => 
    `পণ্য: ${p.name} | মূল্য: ${p.price} টাকা | ওয়ারেন্টি: ${p.warranty || 'N/A'} | বিবরণ: ${p.description || 'N/A'}`
  ).join('\n');

  return `
তুমি ImpoTech Bd-এর Facebook Messenger Sales & Support Assistant।

📍 ব্যবসার বিবরণ ও শোরুমের তথ্য:
- শোরুম/দোকানের ঠিকানা: গাজীপুর, ভবানীপুর।
- WhatsApp: 01884332067 (যেকোনো তথ্যের জন্য WhatsApp-এ যোগাযোগ করতে বলবে)।

🧮 অটোমেটিক বিল ও ডেলিভারি হিসাব নিয়ম:
- গাজীপুর শহরের ভেতরে: পণ্যের মোট দাম + ৫০ টাকা ডেলিভারি চার্জ।
- গাজীপুর শহরের বাইরে: পণ্যের মোট দাম + ১০০ টাকা ডেলিভারি চার্জ।
- একাধিক প্রোডাক্ট হলে: (পণ্যের দাম × সংখ্যা) + ডেলিভারি চার্জ = মোট বিল।
- ক্যাশ অন ডেলিভারি (COD): কাস্টমারকে স্পট বিল/মেমো আকারে পরিষ্কার জানাবে: "কোনো অগ্রিম টাকা লাগবে না, ডেলিভারিম্যান পৌঁছালে মোট টাকা পরিশোধ করবেন।"

📜 সাধারণ নিয়মাবলী:
১. শুধুমাত্র দেওয়া ক্যাটালগ ও FAQ থেকে সঠিক দাম ও স্পেসিফিকেশন বলবে। নিজের থেকে দাম বানিয়ে বলবে না।
২. কাস্টমার কিনতে চাইলে তার নাম, মোবাইল নম্বর এবং সম্পূর্ণ ঠিকানা আনন্দের সাথে চেয়ে নেবে।
৩. কাস্টমার বাংলা, ইংরেজি বা বাংলিশে কথা বললে সেই ভাষাতেই সুন্দর ও সাবলীল উত্তর দেবে।
৪. উত্তর সংক্ষিপ্ত, স্পষ্ট ও ফ্রেন্ডলি রাখবে (২-৪ বাক্য)।

প্রাসঙ্গিক পণ্যসমূহ:
${productText || 'ক্যাটালগে নির্দিষ্ট পণ্য খুঁজে পাওয়া যায়নি।'}

পূর্ববর্তী কথোপকথন মেমোরি:
${historyText || 'কোনো পূর্ববর্তী কনভারসেশন নেই।'}
`.trim();
}

// =========================
// META MESSENGER API
// =========================
async function sendMessengerText(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) return;
  try {
    await axios.post(
      'https://graph.facebook.com/v23.0/me/messages',
      { recipient: { id: recipientId }, message: { text } },
      { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 15000 }
    );
  } catch (err) {
    console.error('[MESSENGER SEND ERR]', err.response?.data || err.message);
  }
}

async function sendMessengerMedia(recipientId, type, url) {
  if (!PAGE_ACCESS_TOKEN || !isValidHttpUrl(url)) return false;
  try {
    await axios.post(
      'https://graph.facebook.com/v23.0/me/messages',
      {
        recipient: { id: recipientId },
        message: {
          attachment: { type, payload: { url, is_reusable: true } }
        }
      },
      { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 15000 }
    );
    return true;
  } catch (err) {
    console.error('[MEDIA SEND ERR]', err.message);
    return false;
  }
}

// Media request check
function checkMediaRequestAndSend(senderId, text, matchedProducts) {
  const norm = normalizeText(text);
  const mediaKeywords = ['ছবি', 'পিক', 'ভিডিও', 'photo', 'picture', 'image', 'video', 'শো'];
  const isAskingMedia = mediaKeywords.some(kw => norm.includes(kw));

  if (isAskingMedia && matchedProducts.length > 0) {
    const p = matchedProducts[0];
    if (norm.includes('ভিডিও') && p.video_url) {
      sendMessengerMedia(senderId, 'video', p.video_url);
    } else if (p.image_url) {
      sendMessengerMedia(senderId, 'image', p.image_url);
    }
  }
}

// =========================
// WEBHOOK HANDLING
// =========================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of body.entry) {
    const webhookEvent = entry.messaging?.[0];
    if (!webhookEvent) continue;

    const senderId = webhookEvent.sender.id;
    const message = webhookEvent.message;

    if (!message) continue;

    // 1. 🛑 Admin Human Takeover Check (. dot command)
    if (webhookEvent.is_echo) {
      const adminText = message.text?.trim();
      if (adminText === '.') {
        pausedCustomers.add(senderId);
        console.log(`[TAKEOVER] AI PAUSED for PSID: ${senderId}`);
      } else if (adminText === '.on' || adminText === '.start') {
        pausedCustomers.delete(senderId);
        console.log(`[TAKEOVER] AI RESUMED for PSID: ${senderId}`);
      }
      continue;
    }

    // Ignore if AI is paused for this customer
    if (pausedCustomers.has(senderId)) continue;

    // Retrieve Past Conversation History from PostgreSQL
    const history = await getRecentConversation(senderId, 6);
    const historyFormatted = history.map(h => `${h.role}: ${h.message}`).join('\n');

    // 2. 👁️ Image / Vision Request
    const imageAttachment = message.attachments?.find(a => a.type === 'image');
    if (imageAttachment) {
      const imageUrl = imageAttachment.payload.url;
      await saveConversation(senderId, 'customer', '[Sent an Image]');

      const visionPrompt = `
তুমি ImpoTech Bd-এর AI Vision System। 
কাস্টমারের পাঠানো ছবিটি দেখে আমাদের ক্যাটালগ থেকে সঠিক পণ্যটি চিনে নাও।
পণ্যের নাম, নিখুঁত দাম, বৈশিষ্ট্য, ওয়ারেন্টি এবং ডেলিভারি চার্জ (গাজীপুর ৫০ টাকা, বাইরে ১০০ টাকা) সহ সুন্দরভাবে উত্তর দাও।
শোরুম: গাজীপুর, ভবানীপুর | WhatsApp: 01884332067।
      `.trim();

      const matchedProducts = searchCatalog('product');
      const messages = [
        { role: 'system', content: visionPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'এই ছবিটি দেখে পণ্যটি শনাক্ত করো এবং বিবরণ দাও।' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ];

      const aiReply = await callOpenRouterWithRetry(messages);
      await sendMessengerText(senderId, aiReply);
      await saveConversation(senderId, 'assistant', aiReply);
      continue;
    }

    // 3. 💬 Text Message Handling
    if (message.text) {
      const userText = message.text;
      await saveConversation(senderId, 'customer', userText);

      const matchedProducts = searchCatalog(userText);
      const systemPrompt = buildSystemPrompt(matchedProducts, historyFormatted);

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ];

      const aiReply = await callOpenRouterWithRetry(messages);
      await sendMessengerText(senderId, aiReply);
      await saveConversation(senderId, 'assistant', aiReply);

      // Check and send product images/videos automatically if requested
      checkMediaRequestAndSend(senderId, userText, matchedProducts);
    }
  }
});

// =========================
// API ENDPOINTS
// =========================

// 4. 🚚 Steadfast Courier 1-Click Booking
app.post('/api/courier/book', async (req, res) => {
  const { invoice, recipient_name, recipient_phone, recipient_address, cod_amount, note } = req.body;

  if (!STEADFAST_API_KEY || !STEADFAST_SECRET_KEY) {
    return res.status(500).json({ success: false, message: 'Steadfast credentials missing.' });
  }

  try {
    const response = await axios.post(
      'https://portal.steadfast.com.bd/api/v1/create_order',
      {
        invoice,
        recipient_name,
        recipient_phone,
        recipient_address,
        cod_amount,
        note: note || 'Deliver carefully by ImpoTech'
      },
      {
        headers: {
          'Api-Key': STEADFAST_API_KEY,
          'Secret-Key': STEADFAST_SECRET_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    res.json({ success: true, data: response.data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// 6 & 13. 📦 Catalog GET & UPDATE Endpoint
app.get('/api/catalog', (req, res) => {
  res.json({ products, faqs });
});

app.post('/api/catalog/update', async (req, res) => {
  const { products: newProducts, faqs: newFaqs } = req.body;

  if (Array.isArray(newProducts)) products = newProducts;
  if (Array.isArray(newFaqs)) faqs = newFaqs;

  rebuildCatalogIndex();
  const synced = await syncCatalogToGitHub();

  res.json({
    success: true,
    message: 'Catalog updated and dynamic index rebuilt successfully.',
    github_synced: synced,
    total_products: products.length
  });
});

// 7. 📱 Android App Remote Control Sync API
app.post('/api/takeover/toggle', (req, res) => {
  const { psid, pause } = req.body;
  if (!psid) return res.status(400).json({ success: false, message: 'PSID required' });

  if (pause) {
    pausedCustomers.add(psid);
  } else {
    pausedCustomers.delete(psid);
  }

  res.json({
    success: true,
    psid,
    is_paused: pausedCustomers.has(psid)
  });
});

// 8. 🩺 Server Health Check
app.get('/health', async (req, res) => {
  let dbStatus = 'Disconnected';
  try {
    await pool.query('SELECT 1');
    dbStatus = 'Connected';
  } catch (e) {
    dbStatus = 'Error: ' + e.message;
  }

  res.json({
    status: 'Healthy',
    uptime: process.uptime(),
    database: dbStatus,
    active_products: products.length,
    active_index_tokens: catalogIndex.size,
    paused_customers: pausedCustomers.size
  });
});

// Root Route
app.get('/', (req, res) => {
  res.send('ImpoTech Bd AI Engine (OpenRouter) is Running 🚀');
});

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log(`[SERVER] ImpoTech Bot listening on port ${PORT}`);
});
