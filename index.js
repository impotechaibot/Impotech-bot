const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'impotech_secret_123';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;

const CATALOG_FILE = path.join(__dirname, 'catalog.json');

// ডুপ্লিকেট মেসেজ ফিল্টার করার ক্যাশ (একই মেসেজের উত্তর বারবার দেবে না)
const processedMessageIds = new Set();
const pausedCustomers = new Set();

let currentTraining = {
  isHumanTakeoverGlobal: false,
  deliveryRules: {
    dhakaDeliveryFee: 70,
    outsideDeliveryFee: 130,
    deliveryTimeDays: '২-৩ দিন',
    isCodAvailable: true,
    freeDeliveryAbove: 0,
    customInstructions: 'সবসময় ভদ্র ও আন্তরিক বাংলায় উত্তর দিন। ক্যাটালগ ও প্রশ্নোত্তর দেখে সঠিক তথ্য দিন।'
  },
  products: [],
  faqs: []
};

// স্টার্টআপে ফাইল রিড
if (fs.existsSync(CATALOG_FILE)) {
  try {
    const raw = fs.readFileSync(CATALOG_FILE, 'utf8');
    currentTraining = JSON.parse(raw);
    console.log(`[BOOT] Loaded ${currentTraining.products?.length || 0} products from catalog.json`);
  } catch (e) {
    console.error('[BOOT] Error reading catalog.json:', e.message);
  }
}

// GitHub অটো-কমিট
async function autoCommitToGitHub(data) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  try {
    const fileUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/catalog.json`;
    let sha = null;
    try {
      const getResp = await axios.get(fileUrl, {
        headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'Impotech-Bot' }
      });
      sha = getResp.data.sha;
    } catch (_) {}

    const contentBase64 = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    await axios.put(fileUrl, {
      message: 'Auto-sync catalog from ImpoTech App',
      content: contentBase64,
      sha: sha || undefined
    }, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'Impotech-Bot' }
    });
    console.log('[GITHUB] Successfully synced to GitHub');
  } catch (err) {
    console.error('[GITHUB] Sync error:', err.response?.data?.message || err.message);
  }
}

// এআই প্রম্পট জেনারেটর (সরাসরি লাইভ রুলস থেকে তথ্য নেবে)
function buildSystemPrompt() {
  const rules = currentTraining.deliveryRules || {};
  const dhakaFee = rules.dhakaDeliveryFee !== undefined ? rules.dhakaDeliveryFee : 70;
  const outsideFee = rules.outsideDeliveryFee !== undefined ? rules.outsideDeliveryFee : 130;
  const time = rules.deliveryTimeDays || '২-৩ দিন';
  const cod = rules.isCodAvailable ? 'ক্যাশ অন ডেলিভারি সুবিধা আছে' : 'ক্যাশ অন ডেলিভারি বন্ধ আছে';

  const pList = (currentTraining.products || []).map((p, idx) => 
    `${idx + 1}. পণ্য: ${p.name} | দাম: ${p.price} টাকা | মিডিয়া: ${p.mediaType || 'IMAGE'} | লিংক: ${p.mediaUrl || 'নেই'} | বিবরণ: ${p.description || 'নেই'}`
  ).join('\n');

  const fList = (currentTraining.faqs || []).map((f, idx) => 
    `প্রশ্নোত্তর ${idx + 1}:\nপ্রশ্ন: ${f.question}\nউত্তর: ${f.answer}`
  ).join('\n\n');

  return `
You are the official smart sales assistant of 'ImpoTech Bd' in Bangladesh.

[CURRENT LIVE STORE RULES]
- ডেলিভারি চার্জ: ঢাকায় ${dhakaFee} টাকা, ঢাকার বাইরে ${outsideFee} টাকা।
- ডেলিভারি সময়: ${time}।
- পেমেন্ট পদ্ধতি: ${cod}।
- অর্ডার কনফার্ম করতে কাস্টমারের নাম, পূর্ণ ঠিকানা ও সক্রিয় ফোন নম্বর চাইতে হবে।

[INSTRUCTIONS]
1. Answer strictly based on the Customer's question. DO NOT repeat the same product answer if not asked.
2. If customer asks about delivery fee or rules, use the LIVE STORE RULES above.
3. If customer asks about a specific product, match with the Official Product Catalog or FAQs below.
4. Reply in natural, polite Bengali within 2-3 short sentences.

[OFFICIAL PRODUCT CATALOG]
${pList || 'বর্তমানে কোনো পণ্য তালিকাভুক্ত নেই।'}

[STORE FAQS]
${fList || 'কোনো সাধারণ প্রশ্নোত্তর নেই।'}

[SPECIAL BEHAVIOR]
${rules.customInstructions || 'সবসময় ভদ্র ও আন্তরিক বাংলায় উত্তর দিন।'}
`;
}

// অটো-রিট্রাই জেমিনাই কল
async function callGeminiWithSmartRetry(parts) {
  const models = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-1.5-flash'];
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const model = models[attempt - 1] || 'gemini-1.5-flash';
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        { contents: [{ parts }] },
        { timeout: 14000 }
      );
      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text && text.trim().length > 0) {
        return text.trim();
      }
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  // ফেইল করলে লাইভ নিয়মের ডেলিভারি চার্জ দিয়ে উত্তর দেবে (হার্ডকোডেড নয়)
  const rules = currentTraining.deliveryRules || {};
  return `আসসালামু আলাইকুম! ImpoTech -তে স্বাগতম। আমাদের ডেলিভারি চার্জ: গাজীপুর ${rules.dhakaDeliveryFee || 50} টাকা, গাজীপুর বাইরে ${rules.outsideDeliveryFee || 100} টাকা। অর্ডার কনফার্ম করতে আপনার নাম, পূর্ণ ঠিকানা ও মোবাইল নম্বর দিন।`;
}

// ফেসবুক মিডিয়া পাঠানো
async function sendMediaAttachment(recipientId, mediaUrl, mediaType) {
  try {
    const type = (mediaType && mediaType.toUpperCase() === 'VIDEO') ? 'video' : 'image';
    await axios.post(
      `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: {
          attachment: { type: type, payload: { url: mediaUrl, is_reusable: true } }
        }
      }
    );
  } catch (err) {
    console.error('Media send error:', err.response?.data?.error?.message || err.message);
  }
}

// Webhook Verification
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// App Sync API
app.get('/api/training', (req, res) => res.json(currentTraining));
app.post('/api/training', async (req, res) => {
  if (req.body.products) currentTraining.products = req.body.products;
  if (req.body.faqs) currentTraining.faqs = req.body.faqs;
  if (req.body.deliveryRules) currentTraining.deliveryRules = req.body.deliveryRules;
  if (req.body.isHumanTakeoverGlobal !== undefined) currentTraining.isHumanTakeoverGlobal = req.body.isHumanTakeoverGlobal;

  fs.writeFileSync(CATALOG_FILE, JSON.stringify(currentTraining, null, 2));
  autoCommitToGitHub(currentTraining);

  res.json({
    success: true,
    message: `এআই সফলভাবে ${currentTraining.products.length}টি পণ্য এবং ${currentTraining.faqs.length}টি প্রশ্নোত্তর শিখে নিয়েছে এবং GitHub-এ অটোমেটিক সেভ হয়েছে!`,
    timestamp: Date.now()
  });
});

// Webhook Messages
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      for (const event of entry.messaging) {
        const senderId = event.sender?.id;
        const recipientId = event.recipient?.id;
        const msg = event.message;

        if (!msg) continue;

        // 🛡️ ডুপ্লিকেট মেসেজ প্রতিরোধ (একই উত্তরের পুনরাবৃত্তি বন্ধ)
        const msgId = msg.mid;
        if (msgId && processedMessageIds.has(msgId)) {
          console.log(`[SKIP_DUPLICATE] Duplicate message received: ${msgId}`);
          continue;
        }
        if (msgId) {
          processedMessageIds.add(msgId);
          if (processedMessageIds.size > 2000) processedMessageIds.clear();
        }

        const text = (msg.text || '').trim();

        // ফুলস্টপ টেকওভার
        if (msg.is_echo) {
          if (text === '.') {
            if (pausedCustomers.has(recipientId)) pausedCustomers.delete(recipientId);
            else pausedCustomers.add(recipientId);
          }
          continue;
        }

        if (text === '.') {
          if (pausedCustomers.has(senderId)) pausedCustomers.delete(senderId);
          else pausedCustomers.add(senderId);
          continue;
        }

        if (pausedCustomers.has(senderId) || currentTraining.isHumanTakeoverGlobal) {
          continue;
        }

        // ছবি বা ভিডিও রিকোয়েস্ট চেক
        const isAskingForMedia = /ছবি|পিক|ভিডিও|ভিডিওটি|রিয়েল|দেখতে চাই|image|photo|pic|video/i.test(text);
        let matchedProductWithMedia = null;
        if (isAskingForMedia && currentTraining.products.length > 0) {
          matchedProductWithMedia = currentTraining.products.find(p => 
            p.mediaUrl && (text.toLowerCase().includes(p.name.toLowerCase()) || text.includes(p.name))
          ) || currentTraining.products.find(p => p.mediaUrl);
        }

        // মিডিয়া ডাউনলোড (ভয়েস বা ইমেজ)
        let mediaBase64 = null;
        let mimeType = 'image/jpeg';
        if (msg.attachments && msg.attachments.length > 0) {
          const att = msg.attachments[0];
          if (att.payload?.url) {
            try {
              const fileResp = await axios.get(att.payload.url, { responseType: 'arraybuffer' });
              mediaBase64 = Buffer.from(fileResp.data).toString('base64');
              mimeType = fileResp.headers['content-type']?.split(';')[0] || (att.type === 'audio' ? 'audio/mp4' : 'image/jpeg');
            } catch (_) {}
          }
        }

        const parts = [];
        if (mediaBase64) parts.push({ inline_data: { mime_type: mimeType, data: mediaBase64 } });
        parts.push({ text: `${buildSystemPrompt()}\n\nCustomer: ${text}` });

        const aiReply = await callGeminiWithSmartRetry(parts);

        try {
          await axios.post(
            `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            { recipient: { id: senderId }, message: { text: aiReply } }
          );
        } catch (err) {
          console.error('FB Send Error:', err.response?.data || err.message);
        }

        if (matchedProductWithMedia && matchedProductWithMedia.mediaUrl) {
          await sendMediaAttachment(senderId, matchedProductWithMedia.mediaUrl, matchedProductWithMedia.mediaType);
        }
      }
    }
  }
});

app.get('/api/status', (req, res) => res.json({ status: 'ONLINE', uptime: process.uptime() }));
app.get('/', (req, res) => res.send('ImpoTech Bd AI Bot is Running!'));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
