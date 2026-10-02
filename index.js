/**
 * ==============================================================================
 * IMPOTECH AI ASSISTANT - ENHANCED VISION & OCR MULTIMODAL SALES ENGINE
 * ==============================================================================
 * Features strictly implemented as per all 17 requirements:
 * 1. Admin Dot (.) Human Takeover & (.on / .start) Resume
 * 2. Smart Billing Engine (Gazipur Inside: +50 TK, Gazipur Outside: +100 TK, COD Memo)
 * 3. OpenRouter Gemini AI Sales Engine (Multilingual Bangla/English/Banglish)
 * 4. Steadfast Courier 1-Click Parcel Booking API (/api/courier/book & /api/v1/create_order)
 * 5. Meta Messenger & Make.com Webhooks (Live Echo Tracking & Graph API Sender)
 * 6. Android App Live Sync APIs:
 *    - POST /api/training (Syncs products, faqs, delivery rules directly from App)
 *    - GET /api/training
 *    - GET /api/status
 *    - POST /api/takeover
 *    - GET /api/catalog, POST /api/catalog/update
 * 7. Android App Remote Takeover Control (/api/takeover/toggle & /api/takeover)
 * 8. Server Health & Uptime Check (/health & /)
 * 9. ENHANCED VISION + OCR:
 *    - Base64 direct image injection (prevents CDN 403 blocks)
 *    - Reads ALL Bengali & English text, prices, labels inside screenshots/photos (OCR)
 *    - Accurately matches screenshots to product catalog
 * 10. Showroom Address: গাজীপুর, ভবানীপুর | WhatsApp: 01884332067
 * 11. Comprehensive FAQs & Cross-lingual intelligence
 * 12. Auto Retry Mechanism with 3-4s Delay (2-3 Attempts) on API/Server Errors
 * 13. Dynamic Realtime Product Catalog with Media Links
 * 14. Full Render Environment Variables Setup
 * 15. Intelligent Product Photo & Video Media Dispatcher
 * 16. Persistent Customer Conversation Memory (File System + PostgreSQL Auto-failover)
 * 17. Automatic Data Retention Cleanup (DATA_RETENTION_DAYS, Default: 20 Days)
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

// --- 14. CONFIGURATION & ENVIRONMENT VARIABLES ---
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const STEADFAST_API_KEY = process.env.STEADFAST_API_KEY || '';
const STEADFAST_SECRET_KEY = process.env.STEADFAST_SECRET_KEY || '';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'impotech_secure_token';
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const DATA_RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '20', 10);

// --- 10 & 13. SHOP CONTACT, BUSINESS INFO & PRODUCT CATALOG ---
const SHOP_INFO = {
  name: "Impotech BD",
  address: "গাজীপুর, ভবানীপুর",
  whatsapp: "01884332067",
  delivery_inside_gazipur: 50,
  delivery_outside_gazipur: 100,
  payment_method: "100% Cash on Delivery (COD) - কোনো অগ্রিম টাকা লাগবে না"
};

let productCatalog = [
  {
    id: "prod_01",
    name: "T900 Ultra Smartwatch",
    price: 1250,
    warranty: "৬ মাসের সার্ভিস ওয়ারেন্টি",
    description: "অরিজিনাল T900 Ultra স্মার্টওয়াচ। ব্লুটুথ কলিং, ফুল টাচ ডিসপ্লে, হার্টরেট মনিটর ও ওয়াটার রেসিস্ট্যান্ট।",
    photo_url: "https://images.unsplash.com/photo-1523275335684-37898b6baf30",
    video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  },
  {
    id: "prod_02",
    name: "Bike Mini Driving Fog Light",
    price: 850,
    warranty: "১ বছরের রিপ্লেসমেন্ট গ্যারান্টি",
    description: "হাই পাওয়ার ডুয়াল কালার (সাদা ও হলুদ) মিনি ড্রাইভিং ফগ লাইট। কুয়াশা ও বৃষ্টির মধ্যে ক্লিয়ার ভিশন দেয়।",
    photo_url: "https://images.unsplash.com/photo-1558981806-ec527fa84c39",
    video_url: ""
  }
];

let faqCatalog = [
  {
    question: "ডেলিভারি চার্জ কত?",
    answer: "গাজীপুরের ভেতরে ডেলিভারি চার্জ ৫০ টাকা এবং গাজীপুরের বাইরে ১০০ টাকা।"
  },
  {
    question: "দোকানের ঠিকানা কোথায়?",
    answer: "আমাদের শোরুমের ঠিকানা: গাজীপুর, ভবানীপুর। WhatsApp: 01884332067"
  }
];

let deliveryRulesList = [];
let isGlobalHumanTakeoverActive = false;

// In-Memory Storage for Human Takeover State & Fallback History
const humanTakeoverMap = new Map();
const localMemoryMap = new Map();

// Persistent local file path for zero-loss memory
const MEMORY_FILE_PATH = path.join(__dirname, 'conversations_memory.json');

function loadLocalMemoryFromFile() {
  try {
    if (fs.existsSync(MEMORY_FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE_PATH, 'utf8'));
      for (const [cid, history] of Object.entries(data)) {
        if (Array.isArray(history)) {
          localMemoryMap.set(cid, history);
        }
      }
      console.log(`[FILE MEMORY] Loaded existing conversations for ${localMemoryMap.size} customers from disk.`);
    }
  } catch (err) {
    console.error('[FILE MEMORY LOAD ERROR]', err.message);
  }
}
loadLocalMemoryFromFile();

function saveLocalMemoryToFile() {
  try {
    const memoryObj = {};
    for (const [cid, history] of localMemoryMap.entries()) {
      memoryObj[cid] = history;
    }
    fs.writeFileSync(MEMORY_FILE_PATH, JSON.stringify(memoryObj, null, 2), 'utf8');
  } catch (err) {
    console.error('[FILE MEMORY SAVE ERROR]', err.message);
  }
}

// --- 16 & 17. POSTGRESQL DATABASE WITH STRICT VALIDATION ---
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
      console.log('[DATABASE] PostgreSQL connected & conversation_history table ready.');
      runAutoCleanup();
    }).catch(err => {
      isPostgresHealthy = false;
      console.log(`[DATABASE NOTICE] PostgreSQL connection skipped (${err.message}). Using Persistent File Memory.`);
    });
  } catch (err) {
    isPostgresHealthy = false;
    console.log(`[DATABASE NOTICE] Could not initialize PostgreSQL. Using Persistent File Memory.`);
  }
} else {
  console.log('[DATABASE] Running in Persistent File Memory mode. (No valid external PostgreSQL provided).');
}

// --- 17. AUTO CLEANUP CRON (Runs every 24 hours) ---
async function runAutoCleanup() {
  const retentionCutoff = Date.now() - (DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  let cleanedCount = 0;
  for (const [cid, history] of localMemoryMap.entries()) {
    const filtered = history.filter(item => (item.created_at || Date.now()) >= retentionCutoff);
    if (filtered.length !== history.length) {
      cleanedCount += (history.length - filtered.length);
      localMemoryMap.set(cid, filtered);
    }
  }
  saveLocalMemoryToFile();
  console.log(`[AUTO CLEANUP] Cleaned ${cleanedCount} expired records from local memory.`);

  if (dbPool && isPostgresHealthy) {
    try {
      const query = `
        DELETE FROM conversation_history 
        WHERE created_at < NOW() - INTERVAL '${DATA_RETENTION_DAYS} days';
      `;
      const result = await dbPool.query(query);
      console.log(`[AUTO CLEANUP] Cleaned ${result.rowCount} messages older than ${DATA_RETENTION_DAYS} days from PostgreSQL.`);
    } catch (e) {
      console.error('[AUTO CLEANUP DB ERROR]', e.message);
    }
  }
}
setInterval(runAutoCleanup, 24 * 60 * 60 * 1000);

// Helper: Save message to history (Dual Storage: File + DB)
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
      console.error('[SAVE MEMORY DB WARNING]', err.message);
    }
  }
}

// Helper: Get recent conversation context for customer (Dual Storage: DB -> File fallback)
async function getCustomerRecentHistory(customerId, limit = 8) {
  if (dbPool && isPostgresHealthy) {
    try {
      const res = await dbPool.query(
        `SELECT role, content, image_url FROM conversation_history 
         WHERE customer_id = $1 
         ORDER BY created_at DESC LIMIT $2`,
        [customerId, limit]
      );
      if (res.rows && res.rows.length > 0) {
        return res.rows.reverse();
      }
    } catch (err) {
      isPostgresHealthy = false;
      console.error('[GET MEMORY DB WARNING]', err.message);
    }
  }
  
  const list = localMemoryMap.get(customerId) || [];
  return list.slice(-limit);
}

// --- 1. HELPER: CHECK HUMAN TAKEOVER STATUS ---
function isAiPausedForCustomer(customerId) {
  if (isGlobalHumanTakeoverActive) return true;
  if (!humanTakeoverMap.has(customerId)) return false;
  const data = humanTakeoverMap.get(customerId);
  const twentyFourHours = 24 * 60 * 60 * 1000;
  if (Date.now() - data.pausedAt > twentyFourHours) {
    humanTakeoverMap.delete(customerId);
    return false;
  }
  return data.paused;
}

// --- 9. HELPER: FETCH IMAGE AS BASE64 TO PREVENT CDN 403 BLOCKS ---
async function fetchImageAsBase64(imageUrl) {
  if (!imageUrl) return null;
  try {
    console.log(`[IMAGE DOWNLOAD] Fetching image from Meta CDN for Vision OCR...`);
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 12000
    });
    const contentType = response.headers['content-type'] || 'image/jpeg';
    const base64Data = Buffer.from(response.data, 'binary').toString('base64');
    console.log(`[IMAGE DOWNLOAD SUCCESS] Converted to base64 (${contentType}, ${Math.round(base64Data.length / 1024)} KB)`);
    return `data:${contentType};base64,${base64Data}`;
  } catch (err) {
    console.error(`[IMAGE DOWNLOAD FAILED] ${err.message}. Falling back to direct URL.`);
    return imageUrl;
  }
}

// --- ROOT & STATUS ENDPOINTS ---
app.get('/', (req, res) => {
  res.send('Impotech AI Assistant & Automation Hub is Live!');
});

app.get('/api/status', (req, res) => {
  res.json({
    isOnline: true,
    productsCount: productCatalog.length,
    faqsCount: faqCatalog.length,
    activeModel: 'google/gemini-2.0-flash-001'
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    app: 'Impotech AI Assistant',
    database_mode: isPostgresHealthy ? 'PostgreSQL' : 'Persistent File Storage (Active)',
    retention_days: DATA_RETENTION_DAYS,
    products_in_catalog: productCatalog.length,
    faqs_in_catalog: faqCatalog.length,
    customers_in_memory: localMemoryMap.size
  });
});

// --- 6. 🔄 ANDROID APP LIVE SYNC ENDPOINT (POST /api/training) ---
app.post('/api/training', (req, res) => {
  try {
    const { products, faqs, deliveryRules, isHumanTakeoverGlobal } = req.body;
    
    if (Array.isArray(products)) {
      productCatalog = products.map(p => ({
        id: p.id || `prod_${Date.now()}`,
        name: p.name || p.title || '',
        price: Number(p.price || 0),
        warranty: p.warranty || '',
        description: p.description || '',
        photo_url: p.photo_url || p.imageUrl || p.photoUrl || '',
        video_url: p.video_url || p.videoUrl || ''
      }));
    }

    if (Array.isArray(faqs)) {
      faqCatalog = faqs;
    }

    if (Array.isArray(deliveryRules)) {
      deliveryRulesList = deliveryRules;
    }

    if (typeof isHumanTakeoverGlobal === 'boolean') {
      isGlobalHumanTakeoverActive = isHumanTakeoverGlobal;
    }

    console.log(`[TRAINING SYNCED] Successfully synced ${productCatalog.length} products & ${faqCatalog.length} FAQs from App.`);

    res.json({
      success: true,
      message: "সফলভাবে এআই ট্রেইনিং ও প্রোডাক্ট ক্যাটালগ সিঙ্ক হয়েছে!",
      count: productCatalog.length
    });
  } catch (err) {
    console.error('[TRAINING SYNC ERROR]', err.message);
    res.status(500).json({ success: false, message: `Sync failed: ${err.message}` });
  }
});

app.get('/api/training', (req, res) => {
  res.json({
    products: productCatalog,
    faqs: faqCatalog,
    deliveryRules: deliveryRulesList,
    isHumanTakeoverGlobal: isGlobalHumanTakeoverActive
  });
});

// --- 7. ANDROID APP TAKEOVER ENDPOINTS ---
app.post('/api/takeover', (req, res) => {
  const { isGlobal, enabled, pause, customerId } = req.body;
  if (typeof isGlobal === 'boolean') {
    isGlobalHumanTakeoverActive = isGlobal;
  }
  if (typeof enabled === 'boolean') {
    isGlobalHumanTakeoverActive = enabled;
  }
  if (customerId) {
    if (pause) {
      humanTakeoverMap.set(customerId, { paused: true, pausedAt: Date.now() });
    } else {
      humanTakeoverMap.delete(customerId);
    }
  }
  res.json({ success: true, isGlobalHumanTakeoverActive });
});

app.post('/api/takeover/toggle', (req, res) => {
  const { customerId, pause } = req.body;
  if (!customerId) return res.status(400).json({ success: false, message: "customerId is required" });

  if (pause) {
    humanTakeoverMap.set(customerId, { paused: true, pausedAt: Date.now() });
    console.log(`[APP TAKEOVER] AI paused for customer: ${customerId}`);
  } else {
    humanTakeoverMap.delete(customerId);
    console.log(`[APP TAKEOVER] AI resumed for customer: ${customerId}`);
  }
  res.json({ success: true, isPaused: pause, customerId });
});

// --- 5. META WEBHOOK VERIFICATION (GET) ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[WEBHOOK] Verified successfully.');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- 1, 5, 9, 15, 16. LIVE META / MAKE.COM WEBHOOK EVENT HANDLER (POST) ---
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'page') {
      for (const entry of body.entry) {
        const webhook_event = entry.messaging ? entry.messaging[0] : null;
        if (!webhook_event) continue;

        const senderId = webhook_event.sender.id;
        const recipientId = webhook_event.recipient.id;

        // A. 🛑 1. ADMIN HUMAN TAKEOVER (MESSAGE ECHOES WITH DOT)
        if (webhook_event.message && webhook_event.message.is_echo) {
          const adminText = (webhook_event.message.text || '').trim();
          console.log(`[ADMIN ECHO] Admin sent to ${recipientId}: "${adminText}"`);

          if (adminText.startsWith('.') || adminText.includes('.') || adminText === '..') {
            if (['.on', '.start', '.ai', '.open', '.resume'].includes(adminText.toLowerCase())) {
              humanTakeoverMap.delete(recipientId);
              console.log(`[TAKEOVER] AI RESUMED by Admin for customer: ${recipientId}`);
            } else {
              humanTakeoverMap.set(recipientId, { paused: true, pausedAt: Date.now() });
              console.log(`[TAKEOVER] AI PAUSED (Human Takeover) for customer: ${recipientId}`);
            }
          }
          continue;
        }

        // B. 📩 CUSTOMER INCOMING MESSAGE (TEXT OR IMAGE/SCREENSHOT)
        if (webhook_event.message) {
          const customerText = webhook_event.message.text || '';
          
          let imageUrl = null;
          if (webhook_event.message.attachments && webhook_event.message.attachments.length > 0) {
            const att = webhook_event.message.attachments[0];
            if (att.type === 'image' && att.payload && att.payload.url) {
              imageUrl = att.payload.url;
              console.log(`[CUSTOMER IMAGE ATTACHMENT] Received: ${imageUrl}`);
            }
          }

          console.log(`[CUSTOMER MESSAGE] From ${senderId}: "${customerText}" (Image: ${!!imageUrl})`);

          if (isAiPausedForCustomer(senderId)) {
            console.log(`[AI BLOCKED] Customer ${senderId} is in Human Takeover. AI will not reply.`);
            continue;
          }

          await saveMessageToMemory(senderId, 'user', customerText || '[Customer sent image/screenshot]', imageUrl);

          const previousHistory = await getCustomerRecentHistory(senderId, 8);

          // Convert image to Base64 to ensure OpenRouter Gemini Vision receives it reliably
          let imageBase64OrUrl = null;
          if (imageUrl) {
            imageBase64OrUrl = await fetchImageAsBase64(imageUrl);
          }

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
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error('[WEBHOOK ERROR]', error.message);
    res.status(200).send('ERROR_HANDLED');
  }
});

// --- 2, 3, 9, 10, 11, 12, 15, 16. OPENROUTER AI ENGINE WITH ADVANCED OCR VISION ---
async function generateAiReplyWithRetry(userPrompt, imagePayload, conversationHistory, attempt = 1) {
  const MAX_ATTEMPTS = 3;

  try {
    if (!OPENROUTER_API_KEY) {
      return {
        replyText: `ধন্যবাদ আপনার বার্তার জন্য! আমাদের শোরুম: ${SHOP_INFO.address}। WhatsApp: ${SHOP_INFO.whatsapp}। আমরা দ্রুত আপনার সাথে যোগাযোগ করছি। ❤️`
      };
    }

    const systemPrompt = `You are the friendly, expert sales AI assistant for "${SHOP_INFO.name}".

BUSINESS & SHOP DETAILS:
- Showroom/Shop Address: ${SHOP_INFO.address}
- Official WhatsApp: ${SHOP_INFO.whatsapp}
- Delivery Inside Gazipur: ${SHOP_INFO.delivery_inside_gazipur} BDT
- Delivery Outside Gazipur: ${SHOP_INFO.delivery_outside_gazipur} BDT
- Payment: 100% Cash on Delivery (COD) - কোনো অগ্রিম টাকা লাগবে না।
- Products in Stock Catalog: ${JSON.stringify(productCatalog)}
- Frequently Asked Questions (FAQs): ${JSON.stringify(faqCatalog)}

CORE INSTRUCTIONS:

1. 👁️ ENHANCED IMAGE & SCREENSHOT RECOGNITION (OCR + VISION):
   - When an image or screenshot is provided by the customer:
     * STEP A (OCR - READ ALL TEXT): Read and extract ALL visible Bengali and English text, titles, subtitles, product names, model numbers (e.g. T900 Ultra, Mini Fog Light, etc.), prices, discount stickers, or captions written anywhere in the photo/screenshot.
     * STEP B (VISUAL MATCHING): Examine the visual design, shape, packaging, and colors in the image.
     * STEP C (CATALOG MATCH): Compare the extracted text and visual features with our stock catalog above.
     * STEP D (ACCURATE CONFIRMATION): State clearly and politely which product it is (e.g. "জি ভাইয়া! আপনি আমাদের [পণ্যের নাম]-এর ছবিটি পাঠিয়েছেন।"). State its exact price, warranty, and delivery charges. Never say you cannot see the image or that you are just a text model. Always be confident and sales-focused.

2. 🧮 SMART BILLING & CALCULATIONS:
   - Total Bill = (Product Price * Quantity) + Delivery Charge.
   - Gazipur Inside: Product Price + 50 TK.
   - Gazipur Outside (All other districts/areas): Product Price + 100 TK.
   - If customer location is not specified yet, clearly state both:
     "গাজীপুরের ভেতরে হলে মোট বিল: [দাম + ৫০] টাকা, এবং গাজীপুরের বাইরে হলে মোট বিল: [দাম + ১০০] টাকা।"
   - Show billing clearly:
     📦 পণ্যের দাম: [দাম] টাকা
     🚚 ডেলিভারি চার্জ: [৫০/১০০] টাকা
     💰 সর্বমোট বিল: [মোট টাকা] টাকা (ক্যাশ অন ডেলিভারি)
     "কোনো অগ্রিম টাকা লাগবে না, ডেলিভারিম্যান পৌঁছালে মোট টাকা পরিশোধ করবেন।"

3. 🎬 MEDIA (PHOTOS & VIDEOS) REQUESTS:
   - If customer asks to see photo/video of a product:
     * Check if catalog has photo_url/video_url.
     * Include media URL in your answer and instruct system to deliver it.
     * If photo/video is not available, explicitly state: "দুঃখিত ভাইয়া, এই মুহূর্তে এই পণ্যটির ভিডিও/ছবি ক্যাটালগে নেই।" Never provide incorrect/unrelated media.

4. 🧠 PERSISTENT CONVERSATION MEMORY:
   - Always connect current query with previous dialogue context. If customer previously asked about a specific product (e.g. headlight or smartwatch) and now simply asks "এটার ওয়ারেন্টি কত দিন?" or "এটার দাম কত?", immediately identify that previous product and provide warranty/details without asking which product.
   - Prioritize latest catalog information if prices changed.

5. 🌍 MULTILINGUAL & FAQS:
   - If asked in Bangla, reply in natural Bengali.
   - If asked in English or Banglish, reply in the same language.
   - Always end with helpful next steps or offering WhatsApp (${SHOP_INFO.whatsapp}) for direct help.`;

    const messages = [{ role: 'system', content: systemPrompt }];

    if (Array.isArray(conversationHistory)) {
      for (const hist of conversationHistory) {
        if (hist.role === 'user') {
          messages.push({ role: 'user', content: hist.content });
        } else if (hist.role === 'assistant') {
          messages.push({ role: 'assistant', content: hist.content });
        }
      }
    }

    let currentContent = [];
    if (userPrompt && userPrompt.trim().length > 0) {
      currentContent.push({ type: 'text', text: userPrompt });
    } else if (imagePayload) {
      currentContent.push({
        type: 'text',
        text: 'কাস্টমার এই ছবিটি/স্ক্রিনশটটি পাঠিয়েছেন। ছবির ভেতরের লেখাগুলো (OCR) পড়ে এবং ছবিটি দেখে আমাদের ক্যাটালগ থেকে পণ্যটি শনাক্ত করুন। এরপর পণ্যের নাম, দাম, ওয়ারেন্টি ও ডেলিভারি চার্জসহ সুন্দরভাবে বাংলায় উত্তর দিন।'
      });
    }

    if (imagePayload) {
      currentContent.push({
        type: 'image_url',
        image_url: { url: imagePayload }
      });
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
        timeout: 20000
      }
    );

    const replyText = response.data.choices[0].message.content;

    let mediaUrlToSend = null;
    let mediaTypeToSend = 'image';

    const lowerPrompt = (userPrompt || '').toLowerCase();
    if (lowerPrompt.includes('ছবি') || lowerPrompt.includes('photo') || lowerPrompt.includes('image')) {
      for (const p of productCatalog) {
        if (replyText.toLowerCase().includes(p.name.toLowerCase()) && p.photo_url) {
          mediaUrlToSend = p.photo_url;
          mediaTypeToSend = 'image';
          break;
        }
      }
    } else if (lowerPrompt.includes('ভিডিও') || lowerPrompt.includes('video')) {
      for (const p of productCatalog) {
        if (replyText.toLowerCase().includes(p.name.toLowerCase()) && p.video_url) {
          mediaUrlToSend = p.video_url;
          mediaTypeToSend = 'video';
          break;
        }
      }
    }

    return { replyText, mediaUrlToSend, mediaTypeToSend };

  } catch (err) {
    console.error(`[OPENROUTER ATTEMPT ${attempt} FAILED]:`, err.response?.data || err.message);

    if (attempt < MAX_ATTEMPTS) {
      console.log(`[RETRY] Waiting 3.5s before attempt ${attempt + 1}...`);
      await new Promise(r => setTimeout(r, 3500));
      return await generateAiReplyWithRetry(userPrompt, imagePayload, conversationHistory, attempt + 1);
    }

    return {
      replyText: `ধন্যবাদ ভাইয়া! আপনার ছবিটি পেয়েছি। আমাদের শোরুম: ${SHOP_INFO.address}, WhatsApp: ${SHOP_INFO.whatsapp}। সাময়িক প্রযুক্তিগত সমস্যার কারণে একটু বিলম্ব হচ্ছে, দয়া করে কিছুক্ষণ পর আবার চেষ্টা করুন অথবা সরাসরি WhatsApp-এ যোগাযোগ করুন। ধন্যবাদ! ❤️`
    };
  }
}

// --- 5. SEND MESSENGER TEXT MESSAGE ---
async function sendMessengerTextMessage(recipientId, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: { text: text }
      }
    );
  } catch (e) {
    console.error('[SEND TEXT ERROR]', e.response?.data || e.message);
  }
}

// --- 15. SEND MESSENGER MEDIA ATTACHMENT ---
async function sendMessengerMedia(recipientId, type, mediaUrl) {
  try {
    if (!mediaUrl) return;
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: type === 'video' ? 'video' : 'image',
            payload: {
              url: mediaUrl,
              is_reusable: true
            }
          }
        }
      }
    );
    console.log(`[MEDIA SENT] Sent ${type} to ${recipientId}: ${mediaUrl}`);
  } catch (e) {
    console.error('[SEND MEDIA ERROR]', e.response?.data || e.message);
  }
}

// --- 4. 🚚 STEADFAST 1-CLICK COURIER BOOKING API ---
app.post('/api/courier/book', async (req, res) => {
  try {
    const { invoice, recipient_name, recipient_phone, recipient_address, cod_amount, note } = req.body;

    if (!STEADFAST_API_KEY || !STEADFAST_SECRET_KEY) {
      return res.status(400).json({ success: false, message: "Steadfast API Key or Secret Key missing in environment." });
    }

    const response = await axios.post(
      'https://portal.packzy.com/api/v1/create_order',
      {
        invoice: invoice || `INV-${Date.now()}`,
        recipient_name,
        recipient_phone,
        recipient_address,
        cod_amount: Number(cod_amount || 0),
        note: note || "Fragile - Handle with care"
      },
      {
        headers: {
          'Api-Key': STEADFAST_API_KEY,
          'Secret-Key': STEADFAST_SECRET_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error('[STEADFAST ERROR]', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.post('/api/v1/create_order', async (req, res) => {
  try {
    const response = await axios.post(
      'https://portal.packzy.com/api/v1/create_order',
      req.body,
      {
        headers: {
          'Api-Key': STEADFAST_API_KEY,
          'Secret-Key': STEADFAST_SECRET_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// --- 6. CATALOG APIS ---
app.get('/api/catalog', (req, res) => {
  res.json({ success: true, catalog: productCatalog });
});

app.post('/api/catalog/update', (req, res) => {
  const { catalog } = req.body;
  if (Array.isArray(catalog)) {
    productCatalog = catalog;
    return res.json({ success: true, message: "Catalog updated successfully", count: productCatalog.length });
  }
  res.status(400).json({ success: false, message: "Invalid catalog format" });
});

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Impotech AI Assistant Server running on Port ${PORT}`);
  console.log(`📍 Showroom: ${SHOP_INFO.address} | 📞 WA: ${SHOP_INFO.whatsapp}`);
  console.log(`🚚 Delivery: Gazipur Inside 50 TK, Gazipur Outside 100 TK`);
  console.log(`👁️ Multimodal Vision & OCR Engine Activated`);
  console.log(`=======================================================`);
});
