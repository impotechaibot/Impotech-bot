/**
 * ==============================================================================
 * IMPOTECH AI ASSISTANT - PERMANENT ENGINE (DYNAMIC JSON CATALOG INTEGRATION)
 * ==============================================================================
 * 17 Core Features Fully Activated:
 * 1. Admin Dot (.) Human Takeover & (.on / .start) Resume
 * 2. Smart Billing Engine (Gazipur Inside: 50 TK, Gazipur Outside: 100 TK)
 * 3. OpenRouter Gemini AI Sales Engine
 * 4. Steadfast Courier 1-Click Parcel Booking API (/api/courier/book)
 * 5. Meta Messenger & Make.com Webhooks
 * 6. Android App Live Sync (POST /api/training -> Auto-updates catalog.json)
 * 7. Android App Remote Takeover Control (/api/takeover/toggle)
 * 8. Server Health & Uptime Check (/health & /api/status)
 * 9. Enhanced Vision + OCR (Base64 injection, reads screenshots & text)
 * 10. Showroom Address: গাজীপুর, ভবানীপুর | WhatsApp: 01884332067
 * 11. Multi-lingual Intelligence & FAQs
 * 12. Auto Retry Mechanism with 3-4s Delay
 * 13. Dynamic Decoupled Catalog (Lives in catalog.json)
 * 14. Render Environment Variables Support
 * 15. Product Photo & Video Dispatcher
 * 16. Persistent Customer Memory (File Storage + PostgreSQL)
 * 17. Automatic Data Retention Cleanup (DATA_RETENTION_DAYS)
 * ==============================================================================
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- CONFIGURATION & ENVIRONMENT VARIABLES ---
const PORT = process.env.PORT || 3000;

const OPENROUTER_API_KEY = (
  process.env.OPENROUTER_API_KEY ||
  process.env.OPEN_ROUTER_API_KEY ||
  process.env.OPENROUTER_KEY ||
  process.env.OPENROUTER_TOKEN ||
  process.env.GEMINI_API_KEY ||
  ''
).trim();

const STEADFAST_API_KEY = (process.env.STEADFAST_API_KEY || '').trim();
const STEADFAST_SECRET_KEY = (process.env.STEADFAST_SECRET_KEY || '').trim();
const PAGE_ACCESS_TOKEN = (process.env.PAGE_ACCESS_TOKEN || '').trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || 'impotech_secure_token').trim();
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const DATA_RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '20', 10);

console.log(`=======================================================`);
console.log(`[AUTH CHECK] OPENROUTER_API_KEY: ${OPENROUTER_API_KEY ? '✅ SET (' + OPENROUTER_API_KEY.slice(0, 10) + '...)' : '❌ MISSING IN RENDER ENVIRONMENT!'}`);
console.log(`[AUTH CHECK] PAGE_ACCESS_TOKEN: ${PAGE_ACCESS_TOKEN ? '✅ SET' : '❌ MISSING'}`);
console.log(`=======================================================`);

// --- SHOP CONTACT & FIXED BUSINESS RULES ---
const SHOP_INFO = {
  name: "Impotech BD",
  address: "গাজীপুর, ভবানীপুর",
  whatsapp: "01884332067",
  delivery_inside_gazipur: 50,
  delivery_outside_gazipur: 100,
  payment_method: "100% Cash on Delivery (COD) - কোনো অগ্রিম টাকা লাগবে না"
};

// --- DYNAMIC CATALOG & FAQS (LOADED DIRECTLY FROM catalog.json) ---
const CATALOG_FILE_PATH = path.join(__dirname, 'catalog.json');
const FAQS_FILE_PATH = path.join(__dirname, 'faqs.json');
const PRODUCTS_ALT_PATH = path.join(__dirname, 'products.json');

let productCatalog = [];
let faqCatalog = [];
let deliveryRulesList = [];
let isGlobalHumanTakeoverActive = false;

// Function to Load Catalog from disk (catalog.json)
function loadCatalogFromDisk() {
  try {
    if (fs.existsSync(CATALOG_FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(CATALOG_FILE_PATH, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        productCatalog = data;
        return;
      } else if (data.products && Array.isArray(data.products)) {
        productCatalog = data.products;
        return;
      }
    }
    if (fs.existsSync(PRODUCTS_ALT_PATH)) {
      const data = JSON.parse(fs.readFileSync(PRODUCTS_ALT_PATH, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        productCatalog = data;
        return;
      }
    }
  } catch (err) {
    console.error('[CATALOG LOAD ERROR]', err.message);
  }
}
loadCatalogFromDisk();

// Function to Save Catalog to catalog.json
function saveCatalogToDisk() {
  try {
    fs.writeFileSync(CATALOG_FILE_PATH, JSON.stringify(productCatalog, null, 2), 'utf8');
    console.log(`[CATALOG DISK SYNC] Saved ${productCatalog.length} products to catalog.json`);
  } catch (err) {
    console.error('[CATALOG DISK SYNC ERROR]', err.message);
  }
}

// Memory & Takeover Storage
const humanTakeoverMap = new Map();
const localMemoryMap = new Map();
const MEMORY_FILE_PATH = path.join(__dirname, 'conversations_memory.json');

function loadLocalMemoryFromFile() {
  try {
    if (fs.existsSync(MEMORY_FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE_PATH, 'utf8'));
      for (const [cid, history] of Object.entries(data)) {
        if (Array.isArray(history)) localMemoryMap.set(cid, history);
      }
    }
  } catch (err) {
    console.error('[FILE MEMORY LOAD ERROR]', err.message);
  }
}
loadLocalMemoryFromFile();

function saveLocalMemoryToFile() {
  try {
    const memoryObj = {};
    for (const [cid, history] of localMemoryMap.entries()) memoryObj[cid] = history;
    fs.writeFileSync(MEMORY_FILE_PATH, JSON.stringify(memoryObj, null, 2), 'utf8');
  } catch (err) {
    console.error('[FILE MEMORY SAVE ERROR]', err.message);
  }
}

// PostgreSQL with strict validation
let dbPool = null;
let isPostgresHealthy = false;

const isProperPostgresUri = 
  (DATABASE_URL.startsWith('postgres://') || DATABASE_URL.startsWith('postgresql://')) &&
  DATABASE_URL.length > 20 &&
  !DATABASE_URL.includes('@base') &&
  DATABASE_URL !== 'base';

if (isProperPostgresUri) {
  try {
    dbPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000
    });

    dbPool.query(`
      CREATE TABLE IF NOT EXISTS conversation_history (
        id SERIAL PRIMARY KEY,
        customer_id VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_customer_created ON conversation_history(customer_id, created_at);
    `).then(() => {
      isPostgresHealthy = true;
      runAutoCleanup();
    }).catch(err => {
      isPostgresHealthy = false;
    });
  } catch (err) {
    isPostgresHealthy = false;
  }
}

// Auto Cleanup
async function runAutoCleanup() {
  const retentionCutoff = Date.now() - (DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  for (const [cid, history] of localMemoryMap.entries()) {
    const filtered = history.filter(item => (item.created_at || Date.now()) >= retentionCutoff);
    if (filtered.length !== history.length) localMemoryMap.set(cid, filtered);
  }
  saveLocalMemoryToFile();

  if (dbPool && isPostgresHealthy) {
    try {
      await dbPool.query(`DELETE FROM conversation_history WHERE created_at < NOW() - INTERVAL '${DATA_RETENTION_DAYS} days'`);
    } catch (e) {}
  }
}
setInterval(runAutoCleanup, 24 * 60 * 60 * 1000);

async function saveMessageToMemory(customerId, role, content, imageUrl = null) {
  if (!localMemoryMap.has(customerId)) localMemoryMap.set(customerId, []);
  const localHistory = localMemoryMap.get(customerId);
  localHistory.push({ role, content, imageUrl, created_at: Date.now() });
  if (localHistory.length > 30) localHistory.shift();
  saveLocalMemoryToFile();

  if (dbPool && isPostgresHealthy) {
    try {
      await dbPool.query(
        'INSERT INTO conversation_history (customer_id, role, content, image_url) VALUES ($1, $2, $3, $4)',
        [customerId, role, content, imageUrl]
      );
    } catch (err) {
      isPostgresHealthy = false;
    }
  }
}

async function getCustomerRecentHistory(customerId, limit = 8) {
  if (dbPool && isPostgresHealthy) {
    try {
      const res = await dbPool.query(
        `SELECT role, content, image_url FROM conversation_history WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [customerId, limit]
      );
      if (res.rows && res.rows.length > 0) return res.rows.reverse();
    } catch (err) {
      isPostgresHealthy = false;
    }
  }
  const list = localMemoryMap.get(customerId) || [];
  return list.slice(-limit);
}

function isAiPausedForCustomer(customerId) {
  if (isGlobalHumanTakeoverActive) return true;
  if (!humanTakeoverMap.has(customerId)) return false;
  const data = humanTakeoverMap.get(customerId);
  if (Date.now() - data.pausedAt > 24 * 60 * 60 * 1000) {
    humanTakeoverMap.delete(customerId);
    return false;
  }
  return data.paused;
}

async function fetchImageAsBase64(imageUrl) {
  if (!imageUrl) return null;
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 15000
    });
    const contentType = response.headers['content-type'] || 'image/jpeg';
    const base64Data = Buffer.from(response.data, 'binary').toString('base64');
    return `data:${contentType};base64,${base64Data}`;
  } catch (err) {
    return imageUrl;
  }
}

// Endpoints
app.get('/', (req, res) => res.send('Impotech AI Assistant Engine is Running!'));

app.get('/api/status', (req, res) => {
  loadCatalogFromDisk();
  res.json({
    isOnline: true,
    hasOpenRouterKey: !!OPENROUTER_API_KEY,
    productsCount: productCatalog.length,
    activeModel: 'google/gemini-2.0-flash-001'
  });
});

app.get('/health', (req, res) => {
  loadCatalogFromDisk();
  res.status(200).json({
    status: 'online',
    app: 'Impotech AI Assistant',
    hasOpenRouterKey: !!OPENROUTER_API_KEY,
    products_in_catalog: productCatalog.length,
    customers_in_memory: localMemoryMap.size
  });
});

// App Live Sync (Writes to catalog.json)
app.post('/api/training', (req, res) => {
  try {
    const { products, faqs, deliveryRules, isHumanTakeoverGlobal } = req.body;
    
    if (Array.isArray(products) && products.length > 0) {
      productCatalog = products.map(p => ({
        id: p.id || `prod_${Date.now()}`,
        name: p.name || p.title || '',
        price: Number(p.price || 0),
        warranty: p.warranty || '',
        description: p.description || '',
        photo_url: p.photo_url || p.imageUrl || p.photoUrl || '',
        video_url: p.video_url || p.videoUrl || ''
      }));
      saveCatalogToDisk();
    }

    if (Array.isArray(faqs)) {
      faqCatalog = faqs;
    }

    if (typeof isHumanTakeoverGlobal === 'boolean') {
      isGlobalHumanTakeoverActive = isHumanTakeoverGlobal;
    }

    res.json({
      success: true,
      message: "সফলভাবে ক্যাটালগ ও এআই ট্রেইনিং সিঙ্ক হয়েছে!",
      count: productCatalog.length
    });
  } catch (err) {
    res.status(500).json({ success: false, message: `Sync failed: ${err.message}` });
  }
});

app.get('/api/training', (req, res) => {
  loadCatalogFromDisk();
  res.json({
    products: productCatalog,
    faqs: faqCatalog,
    deliveryRules: deliveryRulesList,
    isHumanTakeoverGlobal: isGlobalHumanTakeoverActive
  });
});

app.post('/api/takeover', (req, res) => {
  const { isGlobal, enabled, pause, customerId } = req.body;
  if (typeof isGlobal === 'boolean') isGlobalHumanTakeoverActive = isGlobal;
  if (typeof enabled === 'boolean') isGlobalHumanTakeoverActive = enabled;
  if (customerId) {
    if (pause) humanTakeoverMap.set(customerId, { paused: true, pausedAt: Date.now() });
    else humanTakeoverMap.delete(customerId);
  }
  res.json({ success: true, isGlobalHumanTakeoverActive });
});

app.post('/api/takeover/toggle', (req, res) => {
  const { customerId, pause } = req.body;
  if (!customerId) return res.status(400).json({ success: false, message: "customerId required" });
  if (pause) humanTakeoverMap.set(customerId, { paused: true, pausedAt: Date.now() });
  else humanTakeoverMap.delete(customerId);
  res.json({ success: true, isPaused: pause, customerId });
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object === 'page') {
      for (const entry of body.entry) {
        const webhook_event = entry.messaging ? entry.messaging[0] : null;
        if (!webhook_event) continue;

        const senderId = webhook_event.sender.id;
        const recipientId = webhook_event.recipient.id;

        // Admin Takeover Echo
        if (webhook_event.message && webhook_event.message.is_echo) {
          const adminText = (webhook_event.message.text || '').trim();
          if (adminText.startsWith('.') || adminText.includes('.') || adminText === '..') {
            if (['.on', '.start', '.ai', '.open', '.resume'].includes(adminText.toLowerCase())) {
              humanTakeoverMap.delete(recipientId);
            } else {
              humanTakeoverMap.set(recipientId, { paused: true, pausedAt: Date.now() });
            }
          }
          continue;
        }

        // Customer Message
        if (webhook_event.message) {
          const customerText = webhook_event.message.text || '';
          let imageUrl = null;
          if (webhook_event.message.attachments && webhook_event.message.attachments.length > 0) {
            const att = webhook_event.message.attachments[0];
            if (att.type === 'image' && att.payload && att.payload.url) imageUrl = att.payload.url;
          }

          if (isAiPausedForCustomer(senderId)) continue;

          await saveMessageToMemory(senderId, 'user', customerText || '[Customer sent image]', imageUrl);
          const previousHistory = await getCustomerRecentHistory(senderId, 8);

          let imageBase64OrUrl = null;
          if (imageUrl) imageBase64OrUrl = await fetchImageAsBase64(imageUrl);

          const aiResponseData = await generateAiReplyWithRetry(customerText, imageBase64OrUrl, previousHistory);

          if (aiResponseData && PAGE_ACCESS_TOKEN) {
            await saveMessageToMemory(senderId, 'assistant', aiResponseData.replyText);
            await sendMessengerTextMessage(senderId, aiResponseData.replyText);
            if (aiResponseData.mediaUrlToSend) {
              await sendMessengerMedia(senderId, aiResponseData.mediaTypeToSend, aiResponseData.mediaUrlToSend);
            }
          }
        }
      }
      res.status(200).send('EVENT_RECEIVED');
    } else res.sendStatus(404);
  } catch (error) {
    res.status(200).send('ERROR_HANDLED');
  }
});

// AI Engine
async function generateAiReplyWithRetry(userPrompt, imagePayload, conversationHistory, attempt = 1) {
  try {
    if (!OPENROUTER_API_KEY) {
      return {
        replyText: `ধন্যবাদ আপনার বার্তার জন্য! আমাদের শোরুম: ${SHOP_INFO.address}। WhatsApp: ${SHOP_INFO.whatsapp}। আমরা দ্রুত আপনার সাথে যোগাযোগ করছি। ❤️`
      };
    }

    loadCatalogFromDisk();

    const systemPrompt = `You are the friendly, expert sales AI assistant for "${SHOP_INFO.name}".

BUSINESS & SHOP DETAILS:
- Showroom/Shop Address: ${SHOP_INFO.address}
- Official WhatsApp: ${SHOP_INFO.whatsapp}
- Delivery Inside Gazipur: ${SHOP_INFO.delivery_inside_gazipur} BDT
- Delivery Outside Gazipur: ${SHOP_INFO.delivery_outside_gazipur} BDT
- Payment: 100% Cash on Delivery (COD) - কোনো অগ্রিম টাকা লাগবে না।
- Dynamic Products Catalog (from catalog.json): ${JSON.stringify(productCatalog)}
- Frequently Asked Questions (FAQs): ${JSON.stringify(faqCatalog)}

CORE INSTRUCTIONS:
1. 👁️ ENHANCED IMAGE & SCREENSHOT RECOGNITION (OCR + VISION):
   - When an image or screenshot is provided:
     * Read and extract ALL visible Bengali and English text, model names (e.g. Motorcycle Angel's Wings Welcome Light / ডানা লাইট), dimensions, labels, or captions.
     * Compare with catalog. Confirm the product name, its price, warranty, and delivery charges.
     * If product is an accessory (like bike wings light), confirm: "জি ভাইয়া! আপনি মোটরসাইকেলের Angel Wings Welcome Light (ডানা লাইট)-এর ছবিটি পাঠিয়েছেন। এটার দাম [দাম] টাকা।"
     * Never say you cannot see the image. Always be confident, natural, and sales-focused!
2. 🧮 SMART BILLING & CALCULATIONS:
   - Inside Gazipur: Product Price + 50 TK.
   - Outside Gazipur: Product Price + 100 TK.
   - Show billing clearly:
     📦 পণ্যের দাম: [দাম] টাকা
     🚚 ডেলিভারি চার্জ: [৫০/১০০] টাকা
     💰 সর্বমোট বিল: [মোট টাকা] টাকা (ক্যাশ অন ডেলিভারি)
3. 🎬 MEDIA (PHOTOS & VIDEOS):
   - If customer asks for photo/video, include URL from catalog if available.
4. 🧠 PERSISTENT MEMORY:
   - Remember the product from previous messages (e.g. if they sent a photo and then ask "দাম কত?" or "ডানা লাইট আছে?").
5. 🌍 LANGUAGE:
   - Reply in the same language as customer (Bangla, English, Banglish). Always provide WhatsApp (${SHOP_INFO.whatsapp}) for direct help.`;

    const messages = [{ role: 'system', content: systemPrompt }];

    if (Array.isArray(conversationHistory)) {
      for (const hist of conversationHistory) {
        if (hist.role === 'user') messages.push({ role: 'user', content: hist.content });
        else if (hist.role === 'assistant') messages.push({ role: 'assistant', content: hist.content });
      }
    }

    let currentContent = [];
    if (userPrompt && userPrompt.trim().length > 0) currentContent.push({ type: 'text', text: userPrompt });
    else if (imagePayload) {
      currentContent.push({
        type: 'text',
        text: 'কাস্টমার এই ছবিটি/স্ক্রিনশটটি পাঠিয়েছেন। ছবির ভেতরের লেখাগুলো (OCR) পড়ে এবং ছবিটি দেখে আমাদের ক্যাটালগ থেকে পণ্যটি শনাক্ত করুন। এরপর পণ্যের নাম, দাম, ওয়ারেন্টি ও ডেলিভারি চার্জসহ সুন্দরভাবে বাংলায় উত্তর দিন।'
      });
    }

    if (imagePayload) {
      currentContent.push({ type: 'image_url', image_url: { url: imagePayload } });
    }

    messages.push({ role: 'user', content: currentContent });

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-2.0-flash-001',
        messages: messages
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 22000
      }
    );

    const replyText = response.data.choices[0].message.content;

    let mediaUrlToSend = null;
    let mediaTypeToSend = 'image';
    const lowerPrompt = (userPrompt || '').toLowerCase();
    if (lowerPrompt.includes('ছবি') || lowerPrompt.includes('photo')) {
      for (const p of productCatalog) {
        if (replyText.toLowerCase().includes(p.name.toLowerCase()) && p.photo_url) {
          mediaUrlToSend = p.photo_url;
          break;
        }
      }
    }

    return { replyText, mediaUrlToSend, mediaTypeToSend };

  } catch (err) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 3500));
      return await generateAiReplyWithRetry(userPrompt, imagePayload, conversationHistory, attempt + 1);
    }
    return {
      replyText: `ধন্যবাদ ভাইয়া! আমাদের শোরুম: ${SHOP_INFO.address}, WhatsApp: ${SHOP_INFO.whatsapp}। সাময়িক প্রযুক্তিগত সমস্যার কারণে একটু বিলম্ব হচ্ছে, দয়া করে কিছুক্ষণ পর আবার চেষ্টা করুন। ❤️`
    };
  }
}

async function sendMessengerTextMessage(recipientId, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, message: { text } }
    );
  } catch (e) {}
}

async function sendMessengerMedia(recipientId, type, mediaUrl) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: { attachment: { type: 'image', payload: { url: mediaUrl, is_reusable: true } } }
      }
    );
  } catch (e) {}
}

// Steadfast API
app.post('/api/courier/book', async (req, res) => {
  try {
    const { invoice, recipient_name, recipient_phone, recipient_address, cod_amount, note } = req.body;
    const response = await axios.post(
      'https://portal.packzy.com/api/v1/create_order',
      { invoice: invoice || `INV-${Date.now()}`, recipient_name, recipient_phone, recipient_address, cod_amount: Number(cod_amount || 0), note: note || "Fragile" },
      { headers: { 'Api-Key': STEADFAST_API_KEY, 'Secret-Key': STEADFAST_SECRET_KEY, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, data: response.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/catalog', (req, res) => {
  loadCatalogFromDisk();
  res.json({ success: true, catalog: productCatalog });
});

app.post('/api/catalog/update', (req, res) => {
  const { catalog } = req.body;
  if (Array.isArray(catalog)) {
    productCatalog = catalog;
    saveCatalogToDisk();
    return res.json({ success: true, message: "Catalog updated successfully", count: productCatalog.length });
  }
  res.status(400).json({ success: false, message: "Invalid catalog format" });
});

app.listen(PORT, () => {
  console.log(`[SERVER RUNNING] Port: ${PORT} | Products: ${productCatalog.length}`);
});
