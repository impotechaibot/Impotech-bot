/**
 * ==============================================================================
 * IMPOTECH AI ASSISTANT - PRODUCTION BACKEND (WITH APP SYNC & VISION AI)
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

const PORT = process.env.PORT || 3000;

// Flexible OpenRouter API Key Detection
const OPENROUTER_API_KEY = (
  process.env.OPENROUTER_API_KEY ||
  process.env.OPEN_ROUTER_API_KEY ||
  process.env.OPENROUTER_KEY ||
  process.env.OPENROUTER_TOKEN ||
  process.env.GEMINI_API_KEY ||
  ''
).trim();

// Models
const DEFAULT_TEXT_MODEL = (
  process.env.OPENROUTER_TEXT_MODEL ||
  process.env.OPENROUTER_MODEL ||
  process.env.AI_MODEL ||
  'google/gemini-3.1-flash-001'
).trim();

const DEFAULT_VISION_MODEL = (
  process.env.OPENROUTER_VISION_MODEL ||
  process.env.OPENROUTER_MODEL ||
  process.env.AI_MODEL ||
  'google/gemini-3.1-flash-001'
).trim();

const STEADFAST_API_KEY = (process.env.STEADFAST_API_KEY || '').trim();
const STEADFAST_SECRET_KEY = (process.env.STEADFAST_SECRET_KEY || '').trim();
const PAGE_ACCESS_TOKEN = (process.env.PAGE_ACCESS_TOKEN || '').trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || 'impotech_secure_token').trim();
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const DATA_RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '20', 10);

console.log(`[CONFIG] OPENROUTER_API_KEY: ${OPENROUTER_API_KEY ? '✅ FOUND' : '❌ MISSING (401 RISK)'}`);
console.log(`[CONFIG] Models: Text=${DEFAULT_TEXT_MODEL} | Vision=${DEFAULT_VISION_MODEL}`);

// Shop Info
const SHOP_INFO = {
  name: "Impotech BD",
  address: "গাজীপুর, ভবানীপুর",
  whatsapp: "01884332067",
  delivery_inside_gazipur: 50,
  delivery_outside_gazipur: 100,
  payment_method: "100% Cash on Delivery (COD) - কোনো অগ্রিম টাকা লাগবে না"
};

// Disk Catalogs
const CATALOG_FILE_PATH = path.join(__dirname, 'catalog.json');
const FAQS_FILE_PATH = path.join(__dirname, 'faqs.json');
let productCatalog = [];
let faqCatalog = [];
let deliveryRulesList = [];
let isGlobalHumanTakeoverActive = false;

function loadCatalogFromDisk() {
  try {
    if (fs.existsSync(CATALOG_FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(CATALOG_FILE_PATH, 'utf8'));
      if (Array.isArray(data)) productCatalog = data;
      else if (data.products && Array.isArray(data.products)) productCatalog = data.products;
    }
    if (fs.existsSync(FAQS_FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(FAQS_FILE_PATH, 'utf8'));
      if (Array.isArray(data)) faqCatalog = data;
    }
  } catch (err) {
    console.error('[LOAD CATALOG ERROR]', err.message);
  }
}
loadCatalogFromDisk();

function saveCatalogToDisk() {
  try {
    fs.writeFileSync(CATALOG_FILE_PATH, JSON.stringify(productCatalog, null, 2), 'utf8');
    fs.writeFileSync(FAQS_FILE_PATH, JSON.stringify(faqCatalog, null, 2), 'utf8');
    console.log(`[CATALOG SAVED] ${productCatalog.length} products & ${faqCatalog.length} FAQs saved.`);
  } catch (err) {
    console.error('[SAVE CATALOG ERROR]', err.message);
  }
}

// Memory & Takeover
const humanTakeoverMap = new Map();
const localMemoryMap = new Map();

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

// -------------------------------------------------------------
// 🚀 অ্যাপ সিঙ্ক এন্ডপয়েন্ট (যা মিসিং থাকার কারণে ৪০৪ আসছিল)
// -------------------------------------------------------------
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
        photo_url: p.photo_url || p.fileUri || p.imageUrl || '',
        video_url: p.video_url || p.videoUrl || ''
      }));
    }

    if (Array.isArray(faqs)) {
      faqCatalog = faqs;
    }

    if (typeof isHumanTakeoverGlobal === 'boolean') {
      isGlobalHumanTakeoverActive = isHumanTakeoverGlobal;
    }

    saveCatalogToDisk();

    res.json({
      success: true,
      message: "সফলভাবে ক্যাটালগ ও এআই ট্রেইনিং সিঙ্ক হয়েছে!",
      productsCount: productCatalog.length,
      faqsCount: faqCatalog.length
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

app.get('/api/status', (req, res) => {
  loadCatalogFromDisk();
  res.json({
    isOnline: true,
    hasOpenRouterKey: !!OPENROUTER_API_KEY,
    productsCount: productCatalog.length,
    faqsCount: faqCatalog.length
  });
});

app.get('/health', (req, res) => {
  loadCatalogFromDisk();
  res.status(200).json({
    status: 'Healthy',
    hasOpenRouterKey: !!OPENROUTER_API_KEY,
    products: productCatalog.length,
    faqs: faqCatalog.length
  });
});

app.get('/', (req, res) => {
  res.send('ImpoTech Bd AI Engine is Online & Running! 🚀');
});

// Webhook for Messenger
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
        const event = entry.messaging ? entry.messaging[0] : null;
        if (!event) continue;

        const senderId = event.sender.id;
        const recipientId = event.recipient.id;

        // ডট (.) হিউম্যান টেকওভার
        if (event.message && event.message.is_echo) {
          const adminText = (event.message.text || '').trim();
          if (adminText.startsWith('.') || adminText.includes('.')) {
            if (['.on', '.start', '.ai', '.resume'].includes(adminText.toLowerCase())) {
              humanTakeoverMap.delete(recipientId);
              console.log(`[AI RESUMED] Customer: ${recipientId}`);
            } else {
              humanTakeoverMap.set(recipientId, { paused: true, pausedAt: Date.now() });
              console.log(`[AI PAUSED] Customer: ${recipientId}`);
            }
          }
          continue;
        }

        if (event.message) {
          const customerText = event.message.text || '';
          let imageUrl = null;
          if (event.message.attachments && event.message.attachments.length > 0) {
            const att = event.message.attachments[0];
            if (att.type === 'image' && att.payload && att.payload.url) imageUrl = att.payload.url;
          }

          if (isAiPausedForCustomer(senderId)) continue;

          // এআই সেলস ও ভিশন রিপ্লাই তৈরি
          const aiResponse = await generateAiReply(customerText, imageUrl);

          if (aiResponse && PAGE_ACCESS_TOKEN) {
            await sendMessengerTextMessage(senderId, aiResponse.replyText);
          }
        }
      }
      res.status(200).send('EVENT_RECEIVED');
    } else res.sendStatus(404);
  } catch (e) {
    res.status(200).send('ERROR_HANDLED');
  }
});

// এআই জেমিনি ও ভিশন সেলস ইঞ্জিন
async function generateAiReply(userPrompt, imageUrl, attempt = 1) {
  try {
    if (!OPENROUTER_API_KEY) {
      console.error('[OPENROUTER ERROR] OPENROUTER_API_KEY is missing!');
      return {
        replyText: `ধন্যবাদ আপনার বার্তার জন্য! আমাদের শোরুম: ${SHOP_INFO.address}, WhatsApp: ${SHOP_INFO.whatsapp}। আমরা দ্রুত যোগাযোগ করছি। ❤️`
      };
    }

    loadCatalogFromDisk();

    const systemPrompt = `You are the expert sales AI for "${SHOP_INFO.name}".
Showroom: ${SHOP_INFO.address} | WhatsApp: ${SHOP_INFO.whatsapp}
Delivery Inside Gazipur: 50 TK | Outside Gazipur: 100 TK
100% Cash on Delivery (COD) - কোনো অগ্রিম টাকা লাগবে না।
Products: ${JSON.stringify(productCatalog)}
FAQs: ${JSON.stringify(faqCatalog)}

RULES:
1. কাস্টমার যদি ছবি/স্ক্রিনশট দেয়, ছবির ভেতরের লেখা ও প্রডাক্ট চিনে দাম, ওয়ারেন্টি ও ডেলিভারি চার্জসহ সুন্দর উত্তর দিন।
2. কাস্টমার মোট বিল জানতে চাইলে পণ্যের দামের সাথে ৫০ বা ১০০ যোগ করে মেমো আকারে বলুন।
3. অর্ডার করতে চাইলে নাম, মোবাইল নম্বর এবং সম্পূর্ণ ঠিকানা চান।`;

    const messages = [{ role: 'system', content: systemPrompt }];

    let currentContent = [];
    if (userPrompt && userPrompt.trim().length > 0) {
      currentContent.push({ type: 'text', text: userPrompt });
    } else if (imageUrl) {
      currentContent.push({
        type: 'text',
        text: 'কাস্টমার এই ছবিটি/স্ক্রিনশটটি পাঠিয়েছেন। ছবিটি দেখে ক্যাটালগ থেকে পণ্যটির নাম, দাম ও ডেলিভারি চার্জসহ সুন্দরভাবে উত্তর দিন।'
      });
    }

    if (imageUrl) {
      currentContent.push({ type: 'image_url', image_url: { url: imageUrl } });
    }

    messages.push({ role: 'user', content: currentContent });

    const targetModel = imageUrl ? DEFAULT_VISION_MODEL : DEFAULT_TEXT_MODEL;

    // ওপেনরাউটার কল (নিশ্চিত হেডারসহ)
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: targetModel,
        messages: messages
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://impotechbd.com',
          'X-Title': 'Impotech AI Bot'
        },
        timeout: 25000
      }
    );

    const replyText = response.data.choices[0].message.content;
    return { replyText };

  } catch (err) {
    console.error(`[OPENROUTER API ERR - Attempt ${attempt}]:`, err.response?.data || err.message);
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 2000));
      return await generateAiReply(userPrompt, imageUrl, attempt + 1);
    }
    return {
      replyText: `ধন্যবাদ ভাইয়া! শোরুম: ${SHOP_INFO.address}, WhatsApp: ${SHOP_INFO.whatsapp}। সাময়িক সমস্যার জন্য দুঃখিত, আমরা দ্রুত উত্তর দিচ্ছি।`
    };
  }
}

async function sendMessengerTextMessage(recipientId, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, message: { text } }
    );
  } catch (e) {
    console.error('[MESSENGER SEND ERR]:', e.response?.data?.error?.message || e.message);
  }
}

app.listen(PORT, () => {
  console.log(`[SERVER RUNNING] Port: ${PORT}`);
});
