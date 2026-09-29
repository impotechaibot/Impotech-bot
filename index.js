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
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Render-এর Environment-এ দেওয়া টোকেন
const GITHUB_REPO = process.env.GITHUB_REPO;   // যেমন: your-username/impotech-bot

// লোকাল ফাইল পাথ
const CATALOG_FILE = path.join(__dirname, 'catalog.json');

// হিউম্যান টেকওভার ট্র্যাকার ও লাইভ ট্রেইনিং স্টোরেজ
const pausedCustomers = new Set();
let currentTraining = {
  isHumanTakeoverGlobal: false,
  deliveryRules: {
    dhakaDeliveryFee: 70,
    outsideDeliveryFee: 130,
    deliveryTimeDays: '২-৩ দিন',
    isCodAvailable: true,
    freeDeliveryAbove: 0,
    customInstructions: 'সবসময় ভদ্র, আন্তরিক ও মার্জিত বাংলায় ২-৩ বাক্যে উত্তর দিন। কাস্টমার অর্ডার করতে চাইলে নাম, পূর্ণ ঠিকানা ও মোবাইল নম্বর চেয়ে নিন।'
  },
  products: [],
  faqs: []
};

// সার্ভার রিস্টার্ট হলে catalog.json থেকে ডাটা রিকভারি
if (fs.existsSync(CATALOG_FILE)) {
  try {
    currentTraining = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    console.log(`[BOOT] Loaded ${currentTraining.products.length} products from catalog.json`);
  } catch (e) {
    console.error('[BOOT] Error reading catalog.json:', e.message);
  }
}

// GitHub-এ স্বয়ংক্রিয়ভাবে catalog.json আপডেট ও কমিট করার ফাংশন
async function autoCommitToGitHub(data) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.log('[GITHUB] GITHUB_TOKEN or GITHUB_REPO not set. Skipping GitHub commit.');
    return;
  }
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
    await axios.put(
      fileUrl,
      {
        message: 'Auto-update catalog from ImpoTech Mobile App',
        content: contentBase64,
        sha: sha || undefined
      },
      {
        headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'Impotech-Bot' }
      }
    );
    console.log('[GITHUB] Successfully auto-committed new catalog to GitHub!');
  } catch (err) {
    console.error('[GITHUB] Auto-commit error:', err.response?.data?.message || err.message);
  }
}

// এআই-এর জন্য প্রম্পট তৈরি
function buildSystemPrompt() {
  const pList = currentTraining.products.map(p => 
    `- ${p.name}: দাম ${p.price} টাকা | মিডিয়া: ${p.mediaType || 'IMAGE'} | লিংক: ${p.mediaUrl || 'নেই'} (${p.description || ''})`
  ).join('\n');
  const fList = currentTraining.faqs.map(f => `প্রশ্ন: ${f.question} -> উত্তর: ${f.answer}`).join('\n');
  const rules = currentTraining.deliveryRules || {};

  return `
You are the official smart sales assistant for 'ImpoTech Bd' in Bangladesh.
Rules:
1. Always respond in natural, polite Bengali (বাংলা) within 2-3 short sentences.
2. Delivery Charges: Inside Dhaka ${rules.dhakaDeliveryFee || 70} BDT, Outside Dhaka ${rules.outsideDeliveryFee || 130} BDT. Delivery time: ${rules.deliveryTimeDays || '২-৩ দিন'}. Cash on Delivery (COD) is ${rules.isCodAvailable ? 'Available' : 'Unavailable'}.
3. To confirm order, ask for: Name, Full Address, Active Phone Number.
4. Only quote prices from our official product catalog below. If customer asks for something not in the list, politely say: "দুঃখিত, এই পণ্যটি বর্তমানে আমাদের স্টকে নেই।"
5. If customer asks for photo, image, or video (e.g. "ছবি দেন", "ভিডিও দেখতে চাই", "পিক দেন"), confirm you are sharing it.
6. If customer sends audio, listen carefully and reply in natural Bengali.

[Official Product Catalog]
${pList || 'No products added yet'}

[Store FAQs]
${fList || 'No FAQs'}

[Guidelines]
${rules.customInstructions || 'সবসময় ভদ্র ও আন্তরিক বাংলায় উত্তর দিন।'}
`;
}

// 🛡️ এআই ব্যস্ত থাকলে অটোমেটিক রিট্রাই ইঞ্জিন (Self-Healing AI Auto-Retry)
async function callGeminiWithSmartRetry(parts) {
  const candidateModels = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-1.5-flash'];
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const currentModel = candidateModels[attempt - 1] || 'gemini-1.5-flash';
    try {
      console.log(`[GEMINI_ATTEMPT] চেষ্টা: ${attempt}/${maxAttempts} (মডেল: ${currentModel})...`);
      
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${GEMINI_API_KEY}`,
        { contents: [{ parts }] },
        { timeout: 15000 }
      );

      const generated = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (generated && generated.trim().length > 0) {
        console.log(`[GEMINI_SUCCESS] সফলভাবে উত্তর পাওয়া গেছে (মডেল: ${currentModel})`);
        return generated.trim();
      }
    } catch (err) {
      lastError = err;
      const statusCode = err.response?.status;
      const errorMsg = err.response?.data?.error?.message || err.message;
      console.warn(`[GEMINI_BUSY] এআই সাময়িক ব্যস্ত (Code: ${statusCode || 'Timeout'}): ${errorMsg}`);

      // ব্যর্থ হলে ১.৫ থেকে ২.৫ সেকেন্ড অপেক্ষা করে পুনরায় নিজে থেকে চেষ্টা করবে
      if (attempt < maxAttempts) {
        const delay = attempt === 1 ? 1500 : 2500;
        console.log(`[RETRYING] এআই ব্যস্ত থাকায় ${delay / 1000} সেকেন্ড পর স্বয়ংক্রিয়ভাবে পুনরায় চেষ্টা করা হচ্ছে...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  console.error('[GEMINI_FAILED] সকল চেষ্টা শেষে এরর:', lastError?.message);
  // কাস্টমার কখনো এরর দেখবে না, মার্জিত ডিফল্ট রিপ্লাই পাবে
  return 'আসসালামু আলাইকুম! ImpoTech Bd-তে স্বাগতম। আমাদের ডেলিভারি চার্জ: ঢাকায় ৭০ টাকা, ঢাকার বাইরে ১৩০ টাকা। ক্যাশ অন ডেলিভারি সুবিধা আছে। অর্ডার কনফার্ম করতে অনুগ্রহ করে আপনার নাম, পূর্ণ ঠিকানা ও মোবাইল নম্বর লিখে দিন।';
}

// ফেসবুকে সরাসরি ছবি বা ভিডিও পাঠানোর ফাংশন
async function sendMediaAttachment(recipientId, mediaUrl, mediaType) {
  try {
    const type = (mediaType && mediaType.toUpperCase() === 'VIDEO') ? 'video' : 'image';
    await axios.post(
      `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: type,
            payload: { url: mediaUrl, is_reusable: true }
          }
        }
      }
    );
    console.log(`[MEDIA_SENT] Sent ${type} to customer ${recipientId}`);
  } catch (err) {
    console.error('[MEDIA_ERROR] Failed to send media:', err.response?.data?.error?.message || err.message);
  }
}

// ১. ফেসবুক Webhook ভেরিফিকেশন
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// ২. মোবাইল অ্যাপের জন্য API (এক ক্লিকে রেন্ডার ও GitHub সিঙ্ক)
app.get('/api/training', (req, res) => res.json(currentTraining));
app.post('/api/training', async (req, res) => {
  if (req.body.products) currentTraining.products = req.body.products;
  if (req.body.faqs) currentTraining.faqs = req.body.faqs;
  if (req.body.deliveryRules) currentTraining.deliveryRules = req.body.deliveryRules;
  if (req.body.isHumanTakeoverGlobal !== undefined) currentTraining.isHumanTakeoverGlobal = req.body.isHumanTakeoverGlobal;

  // লোকাল ফাইল সেভ
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(currentTraining, null, 2));

  // GitHub-এ স্বয়ংক্রিয় কমিট
  autoCommitToGitHub(currentTraining);

  res.json({
    success: true,
    message: `এআই সফলভাবে ${currentTraining.products.length}টি পণ্য এবং ${currentTraining.faqs.length}টি প্রশ্নোত্তর শিখে নিয়েছে এবং GitHub-এ অটোমেটিক সেভ হয়েছে!`,
    timestamp: Date.now()
  });
});

// ৩. ফেসবুক মেসেজ রিসিভ, ফুলস্টপ টেকওভার ও রিপ্লাই
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

        const text = (msg.text || '').trim();

        // 🎯 ফুলস্টপ (.) দিয়ে হিউম্যান টেকওভার
        if (msg.is_echo) {
          const targetCustomerId = recipientId;
          if (text === '.') {
            if (pausedCustomers.has(targetCustomerId)) {
              pausedCustomers.delete(targetCustomerId);
              console.log(`[TAKEOVER] এআই পুনরায় চালু হলো কাস্টমার: ${targetCustomerId}-এর জন্য`);
            } else {
              pausedCustomers.add(targetCustomerId);
              console.log(`[TAKEOVER] এআই বন্ধ (Pause) হলো কাস্টমার: ${targetCustomerId}-এর জন্য`);
            }
          }
          continue;
        }

        if (text === '.') {
          if (pausedCustomers.has(senderId)) {
            pausedCustomers.delete(senderId);
            console.log(`[TAKEOVER] এআই পুনরায় চালু হলো: ${senderId}`);
          } else {
            pausedCustomers.add(senderId);
            console.log(`[TAKEOVER] এআই বন্ধ হলো: ${senderId}`);
          }
          continue;
        }

        // হিউম্যান মোড চললে এআই নীরব থাকবে
        if (pausedCustomers.has(senderId) || currentTraining.isHumanTakeoverGlobal) {
          console.log(`[HUMAN_MODE] হিউম্যান মোড সক্রিয়, এআই মেসেজ দেবে না: ${senderId}`);
          continue;
        }

        // কাস্টমার ছবি বা ভিডিও চেয়েছে কি না
        const isAskingForMedia = /ছবি|পিক|ভিডিও|ভিডিওটি|রিয়েল|দেখতে চাই|image|photo|pic|video/i.test(text);
        let matchedProductWithMedia = null;

        if (isAskingForMedia && currentTraining.products.length > 0) {
          matchedProductWithMedia = currentTraining.products.find(p => 
            p.mediaUrl && (text.toLowerCase().includes(p.name.toLowerCase()) || text.includes(p.name))
          ) || currentTraining.products.find(p => p.mediaUrl);
        }

        // মিডিয়া ফাইল ডাউনলোড (ভয়েস বা ইমেজ আসলে)
        let mediaBase64 = null;
        let mimeType = 'image/jpeg';

        if (msg.attachments && msg.attachments.length > 0) {
          const att = msg.attachments[0];
          const mediaUrl = att.payload?.url;
          if (mediaUrl) {
            try {
              const fileResp = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
              mediaBase64 = Buffer.from(fileResp.data).toString('base64');
              mimeType = fileResp.headers['content-type']?.split(';')[0] || (att.type === 'audio' ? 'audio/mp4' : 'image/jpeg');
            } catch (err) {
              console.error('Media download error:', err.message);
            }
          }
        }

        const parts = [];
        if (mediaBase64) {
          parts.push({ inline_data: { mime_type: mimeType, data: mediaBase64 } });
        }
        parts.push({ text: `${buildSystemPrompt()}\n\nCustomer: ${text}` });

        // 🚀 অটো-রিট্রাই সহ জেমিনাই এআই কল
        const aiReply = await callGeminiWithSmartRetry(parts);

        // ফেসবুকে টেক্সট পাঠানো
        try {
          await axios.post(
            `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            {
              recipient: { id: senderId },
              message: { text: aiReply }
            }
          );
        } catch (fbErr) {
          console.error('Facebook Send Error:', fbErr.response?.data || fbErr.message);
        }

        // কাস্টমার যদি ছবি/ভিডিও চেয়ে থাকে এবং প্রোডাক্টে মিডিয়া থাকে, সাথে সাথে তা পাঠানো
        if (matchedProductWithMedia && matchedProductWithMedia.mediaUrl) {
          await sendMediaAttachment(senderId, matchedProductWithMedia.mediaUrl, matchedProductWithMedia.mediaType);
        }
      }
    }
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ONLINE',
    uptime: process.uptime(),
    activeModel: 'gemini-3.8-flash (with auto-fallback)',
    productCount: currentTraining.products.length,
    pausedCount: pausedCustomers.size
  });
});

app.get('/', (req, res) => res.send('ImpoTech Bd AI Bot with Auto-Retry & Auto-Sync is Running!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
