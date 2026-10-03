/**
 * ==============================================================================
 * IMPOTECH AI ASSISTANT - PRODUCTION BACKEND (WITH APP SYNC & GEMINI VISION)
 * ==============================================================================
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;

// Helper: ক্লিন ও ট্রিম করা কী রিডার
function cleanKey(val) {
  if (!val) return '';
  let s = String(val).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

// যে নামেই রেন্ডারে সেভ থাকুক না কেন অটো-ডিটেকশন
const OPENROUTER_API_KEY = cleanKey(
  process.env.OPENROUTER_API_KEY ||
  process.env.OPEN_ROUTER_API_KEY ||
  process.env.OPENROUTER_KEY ||
  process.env.OPENROUTER_TOKEN ||
  process.env.GEMINI_API_KEY
);

// ওপেনরাউটার মডেল
const AI_MODEL = cleanKey(
  process.env.OPENROUTER_MODEL ||
  process.env.OPENROUTER_TEXT_MODEL ||
  process.env.AI_MODEL ||
  'google/gemini-2.5-flash'
);

const PAGE_ACCESS_TOKEN = cleanKey(process.env.PAGE_ACCESS_TOKEN);
const VERIFY_TOKEN = cleanKey(process.env.VERIFY_TOKEN) || 'impotech_secure_token';

console.log('====================================================');
console.log(`[BOOT] Server Starting on Port: ${PORT}`);
if (OPENROUTER_API_KEY) {
  console.log(`[BOOT] OPENROUTER_API_KEY: ✅ FOUND (Length: ${OPENROUTER_API_KEY.length})`);
} else {
  console.log(`[BOOT] OPENROUTER_API_KEY: ❌ MISSING! (দয়া করে রেন্ডারে OPENROUTER_API_KEY যুক্ত করুন)`);
}
console.log(`[BOOT] Active AI Model: ${AI_MODEL}`);
console.log('====================================================');

// শপ তথ্য
const SHOP_INFO = {
  name: "Impotech BD",
  address: "গাজীপুর, ভবানীপুর",
  whatsapp: "01884332067",
  delivery_inside_gazipur: 50,
  delivery_outside_gazipur: 100,
  payment_method: "100% Cash on Delivery (COD) - কোনো অগ্রিম টাকা লাগবে না"
};

// লোকাল ক্যাটালগ ও এফএকিউ সংরক্ষণ ব্যবস্থা
const CATALOG_FILE_PATH = path.join(__dirname, 'catalog.json');
const FAQS_FILE_PATH = path.join(__dirname, 'faqs.json');
let productCatalog = [];
let faqCatalog = [];
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
  } catch (e) {
    console.error('[LOAD DISK ERROR]:', e.message);
  }
}
loadCatalogFromDisk();

function saveCatalogToDisk() {
  try {
    fs.writeFileSync(CATALOG_FILE_PATH, JSON.stringify(productCatalog, null, 2), 'utf8');
    fs.writeFileSync(FAQS_FILE_PATH, JSON.stringify(faqCatalog, null, 2), 'utf8');
    console.log(`[DISK SYNC] Saved ${productCatalog.length} products & ${faqCatalog.length} FAQs.`);
  } catch (e) {
    console.error('[SAVE DISK ERROR]:', e.message);
  }
}

// হিউম্যান টেকওভার ট্র্যাকার
const humanTakeoverMap = new Map();

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
// 🚀 মোবাইল অ্যাপ লাইভ সিঙ্ক এন্ডপয়েন্ট (যাতে আর ৪০৪ না আসে)
// -------------------------------------------------------------
app.post('/api/training', (req, res) => {
  try {
    const { products, faqs, isHumanTakeoverGlobal } = req.body;

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

    console.log(`[APP SYNC SUCCESS] Products: ${productCatalog.length}, FAQs: ${faqCatalog.length}`);
    res.json({
      success: true,
      message: "সফলভাবে ক্যাটালগ ও এআই ট্রেইনিং সিঙ্ক হয়েছে!",
      itemCount: productCatalog.length,
      faqCount: faqCatalog.length
    });
  } catch (err) {
    console.error('[SYNC ERROR]:', err.message);
    res.status(500).json({ success: false, message: `Sync failed: ${err.message}` });
  }
});

app.get('/api/training', (req, res) => {
  loadCatalogFromDisk();
  res.json({
    products: productCatalog,
    faqs: faqCatalog,
    isHumanTakeoverGlobal: isGlobalHumanTakeoverActive
  });
});

app.get('/api/status', (req, res) => {
  loadCatalogFromDisk();
  res.json({
    status: 'online',
    uptime: process.uptime(),
    activeModel: AI_MODEL,
    hasOpenRouterKey: !!OPENROUTER_API_KEY,
    productsCount: productCatalog.length,
    faqsCount: faqCatalog.length
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'Healthy',
    uptime: process.uptime(),
    hasOpenRouterKey: !!OPENROUTER_API_KEY,
    products: productCatalog.length
  });
});

app.get('/', (req, res) => {
  res.status(200).send('ImpoTech Bd AI Engine is Online & Running! 🚀');
});

// -------------------------------------------------------------
// 💬 ফেসবুক মেসেঞ্জার ওয়েব হুক
// -------------------------------------------------------------
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
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

        // ডট (.) হিউম্যান টেকওভার লজিক
        if (event.message && event.message.is_echo) {
          const adminText = (event.message.text || '').trim();
          if (adminText.startsWith('.') || adminText.includes('.')) {
            if (['.on', '.start', '.ai', '.resume'].includes(adminText.toLowerCase())) {
              humanTakeoverMap.delete(recipientId);
              console.log(`[AI RESUMED] Customer: ${recipientId}`);
            } else {
              humanTakeoverMap.set(recipientId, { paused: true, pausedAt: Date.now() });
              console.log(`[AI PAUSED BY ADMIN] Customer: ${recipientId}`);
            }
          }
          continue;
        }

        // কাস্টমার মেসেজ
        if (event.message) {
          const customerText = event.message.text || '';
          let imageUrl = null;
          if (event.message.attachments && event.message.attachments.length > 0) {
            const att = event.message.attachments[0];
            if (att.type === 'image' && att.payload && att.payload.url) {
              imageUrl = att.payload.url;
            }
          }

          if (isAiPausedForCustomer(senderId)) continue;

          // এআই জেমিনি ভিশন ও সেলস রিপ্লাই
          const aiReply = await generateAiReply(customerText, imageUrl);

          if (aiReply && PAGE_ACCESS_TOKEN) {
            await sendMessengerTextMessage(senderId, aiReply);
          }
        }
      }
      res.status(200).send('EVENT_RECEIVED');
    } else {
      res.sendStatus(404);
    }
  } catch (e) {
    res.status(200).send('ERROR_HANDLED');
  }
});

// -------------------------------------------------------------
// 🧠 এআই জেমিনি ভিশন ও সেলস ইঞ্জিন
// -------------------------------------------------------------
async function generateAiReply(userPrompt, imageUrl, attempt = 1) {
  try {
    if (!OPENROUTER_API_KEY) {
      console.error('[OPENROUTER ERROR] OPENROUTER_API_KEY is not set!');
      return `ধন্যবাদ আপনার বার্তার জন্য! আমাদের শোরুম: ${SHOP_INFO.address}, WhatsApp: ${SHOP_INFO.whatsapp}। আমরা দ্রুত আপনার সাথে যোগাযোগ করছি। ❤️`;
    }

    loadCatalogFromDisk();

    const systemPrompt = `You are the friendly, expert sales AI for "${SHOP_INFO.name}".
Showroom Address: ${SHOP_INFO.address} | Official WhatsApp: ${SHOP_INFO.whatsapp}
Delivery Fee: Inside Gazipur ${SHOP_INFO.delivery_inside_gazipur} TK, Outside Gazipur ${SHOP_INFO.delivery_outside_gazipur} TK.
Payment: 100% Cash on Delivery (COD) - কোনো অগ্রিম টাকা লাগবে না।
Products Catalog: ${JSON.stringify(productCatalog)}
FAQs: ${JSON.stringify(faqCatalog)}

RULES:
1. কাস্টমার ছবি বা স্ক্রিনশট দিলে ছবির ভেতরের লেখা (OCR) ও পণ্য চিনে দাম, ওয়ারেন্টি ও ডেলিভারি চার্জসহ সুন্দর সেলস উত্তর দিন।
2. কাস্টমার মোট বিল জানতে চাইলে পণ্যের দামের সাথে ৫০ বা ১০০ টাকা যোগ করে মেমো আকারে জানান।
3. অর্ডার করতে চাইলে ক্রেতার নাম, মোবাইল নম্বর এবং সম্পূর্ণ ডেলিভারি ঠিকানা চেয়ে নিন।
4. সবসময় মার্জিত, আন্তরিক বাংলায় ২-৩ বাক্যে উত্তর দিন।`;

    const messages = [{ role: 'system', content: systemPrompt }];

    let userContent = [];
    if (userPrompt && userPrompt.trim().length > 0) {
      userContent.push({ type: 'text', text: userPrompt });
    } else if (imageUrl) {
      userContent.push({
        type: 'text',
        text: 'কাস্টমার এই ছবিটি/স্ক্রিনশটটি পাঠিয়েছেন। ছবিটি দেখে ক্যাটালগ থেকে পণ্য শনাক্ত করে পণ্যের নাম, দাম ও ডেলিভারি চার্জসহ উত্তর দিন।'
      });
    }

    if (imageUrl) {
      userContent.push({ type: 'image_url', image_url: { url: imageUrl } });
    }

    messages.push({ role: 'user', content: userContent });

    const targetModel = AI_MODEL;
    console.log(`[OPENROUTER CALL] Dispatching to ${targetModel} (Attempt ${attempt})...`);

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
          'X-Title': 'Impotech AI Sales Engine'
        },
        timeout: 25000
      }
    );

    const reply = response.data?.choices?.[0]?.message?.content;
    return reply || `ধন্যবাদ ভাইয়া! আমাদের শোরুম: ${SHOP_INFO.address}। WhatsApp: ${SHOP_INFO.whatsapp}`;

  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error(`[OPENROUTER API ERR - Attempt ${attempt}]:`, JSON.stringify(errData));

    // ফলব্যাক ট্রাই
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 2000));
      return await generateAiReply(userPrompt, imageUrl, attempt + 1);
    }

    return `ধন্যবাদ ভাইয়া! শোরুম: ${SHOP_INFO.address}, WhatsApp: ${SHOP_INFO.whatsapp}। সাময়িক সমস্যার জন্য দুঃখিত, আমরা দ্রুত উত্তর দিচ্ছি। ❤️`;
  }
}

async function sendMessengerTextMessage(recipientId, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, message: { text } }
    );
  } catch (e) {
    console.error('[MESSENGER SEND ERROR]:', e.response?.data?.error?.message || e.message);
  }
}

app.listen(PORT, () => {
  console.log(`[READY] Server running on port ${PORT}`);
});
