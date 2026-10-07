const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

// এনভায়রনমেন্ট ভ্যারিয়েবল
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'impotech_secret_token_123';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

// আলাদা ফাইল পাথ (index.js কখনোই পরিবর্তন করতে হবে না!)
const CATALOG_FILE = path.join(__dirname, 'catalog.json');
const TAKEOVER_FILE = path.join(__dirname, 'takeover.json');

// ডিফল্ট ক্যাটালগ
const DEFAULT_CATALOG = {
  storeName: "ImpoTech Bd (ইম্পোটেক বিডি)",
  delivery: {
    insideGazipur: 50,
    outsideGazipur: 100,
    timeInside: "১-২ কার্যদিবস",
    timeOutside: "২-৩ কার্যদিবস",
    paymentMethod: "১০০% ক্যাশ অন ডেলিভারি (কোনো অগ্রিম নেই)",
    checkingPolicy: "ডেলিভারিম্যানের সামনে ১২V লাইনে লাইট জ্বালিয়ে চেক করে দেখে তারপর মূল্য পরিশোধ করতে পারবেন।"
  },
  products: [
    {
      id: "prod_wings_650",
      name: "মোটরসাইকেল এঞ্জেল উইংস, ডানা লাইট (Motorcycle Angel Wings Light)",
      price: "650",
      category: "স্মার্ট গ্যাজেট",
      inStock: true,
      description: "১ জোড়া (বাম ও ডান ২ টি লাইট)। দাম: ৬৫০ টাকা জোড়া। কালার: সাদা, নীল ও লাল। ৯V-৪৫V DC সাপোর্ট করে। ১০০% ওয়াটারপ্রুফ। ৭ দিনের রিপ্লেসমেন্ট গ্যারান্টি।\nছবি: https://www.facebook.com/61580138349610/posts/122147550645004611/?app=fbl\nভিডিও: https://www.facebook.com/reel/1391152963087497/"
    },
    {
      id: "prod_fog_12",
      name: "12 Lens Fog Light (১২ লেন্স ফগ লাইট)",
      price: "750",
      category: "ফগ লাইট",
      inStock: true,
      description: "দাম: ৭৫০ টাকা পিস। মোট ৬টি মোড: সাদা, হলুদ ও পুলিশ লাইট। হাই বিম ও লো বিম। IP67/IP68 ওয়াটারপ্রুফ।"
    },
    {
      id: "prod_fog_5",
      name: "5 Lens Fog Light (৫ লেন্স ফগ লাইট)",
      price: "450",
      category: "ফগ লাইট",
      inStock: true,
      description: "দাম: ৪৫০ টাকা পিস। মোট ৬টি মোড। IP67/IP68 ওয়াটারপ্রুফ।"
    },
    {
      id: "prod_devil_60w",
      name: "60W Red/Blue Devil Eye Headlight (৬০ ওয়াট লাল/নীল ডেভিল আই হেডলাইট)",
      price: "1099",
      category: "হেডলাইট",
      inStock: true,
      description: "দাম: ১০৯৯ টাকা। H4 Plug and Play। ২০০ দিনের ফুল রিপ্লেসমেন্ট ওয়ারেন্টি।"
    }
  ],
  faqs: []
};

// ক্যাটালগ পড়ার ফাংশন
function loadCatalog() {
  try {
    if (fs.existsSync(CATALOG_FILE)) {
      return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    }
  } catch (err) {}
  return DEFAULT_CATALOG;
}

// ক্যাটালগ সংরক্ষণের ফাংশন
function saveCatalog(data) {
  try {
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) { return false; }
}

// টেকওভার পড়ার ফাংশন
function loadTakeover() {
  try {
    if (fs.existsSync(TAKEOVER_FILE)) {
      return JSON.parse(fs.readFileSync(TAKEOVER_FILE, 'utf8'));
    }
  } catch (_) {}
  return { isGlobalPaused: false, pausedCustomers: [] };
}

function saveTakeover(data) {
  try { fs.writeFileSync(TAKEOVER_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch (_) {}
}

// ক্যাটালগ ফাইল থেকে লাইভ এআই প্রম্পট তৈরি
function generateDynamicPrompt() {
  const catalog = loadCatalog();
  const d = catalog.delivery || DEFAULT_CATALOG.delivery;

  let prompt = `
You are the official smart AI Customer Support Assistant for "${catalog.storeName || 'ImpoTech Bd'}" on Facebook Messenger.

DELIVERY & ORDER RULES:
1. Always reply politely in natural Bengali (বাংলা).
2. Delivery Charges:
   - গাজীপুরের ভেতরে: ${d.insideGazipur || 50} টাকা (${d.timeInside || '১-২ কার্যদিবস'})।
   - গাজীপুরের বাইরে (পুরো বাংলাদেশে): ${d.outsideGazipur || 100} টাকা (${d.timeOutside || '২-৩ কার্যদিবস'})।
   - একাধিক পণ্য অর্ডার করলেও ডেলিভারি চার্জ একই থাকবে।
3. Payment: ${d.paymentMethod || '১০০% ক্যাশ অন ডেলিভারি (কোনো অগ্রিম নেই)'}।
4. Checking: ${d.checkingPolicy || 'ডেলিভারিম্যানের সামনে চেক করে দেখে পেমেন্ট করতে পারবেন।'}
5. Order: গ্রাহক অর্ডার করতে চাইলে নাম, সম্পূর্ণ ঠিকানা (থানা ও জেলাসহ) এবং সচল মোবাইল নম্বর চেয়ে নিন।

CURRENT CATALOG IN STOCK:
`;

  if (catalog.products && catalog.products.length > 0) {
    catalog.products.forEach((p, i) => {
      prompt += `\n[${i + 1}] ${p.name} | মূল্য: ৳${p.price} | স্টক: ${p.inStock !== false ? 'ইন-স্টক' : 'স্টক আউট'}\nবিবরণ: ${p.description || ''}\n`;
    });
  }

  if (catalog.faqs && catalog.faqs.length > 0) {
    prompt += `\nFREQUENTLY ASKED QUESTIONS (FAQs):\n`;
    catalog.faqs.forEach((faq) => {
      prompt += `প্রশ্ন: ${faq.question}\nউত্তর: ${faq.answer}\n`;
    });
  }

  prompt += `\nKeep responses helpful, friendly, and under 2-3 sentences.`;
  return prompt;
}

// ----------------- এপিআই রাউট (অ্যাপ থেকে সিঙ্ক) -----------------

// ১. ট্রেনিং সিঙ্ক: সরাসরি catalog.json-এ ডাটা সেভ করে (index.js বদলাতে হয় না)
app.post('/api/training', (req, res) => {
  const current = loadCatalog();
  if (req.body.products) current.products = req.body.products;
  if (req.body.faqs) current.faqs = req.body.faqs;
  if (req.body.delivery) current.delivery = req.body.delivery;
  current.updatedAt = new Date().toISOString();

  saveCatalog(current);
  console.log(`✅ ক্যাটালগ ফাইল আপডেট হয়েছে: ${current.products?.length || 0} টি পণ্য, ${current.faqs?.length || 0} টি প্রশ্নোত্তর।`);

  res.json({
    success: true,
    message: "ক্যাটালগ সফলভাবে catalog.json-এ সিঙ্ক হয়েছে!",
    totalProducts: current.products?.length || 0,
    totalFaqs: current.faqs?.length || 0
  });
});

app.get('/api/training', (req, res) => {
  res.json({ success: true, catalog: loadCatalog() });
});

// ২. সরাসরি ক্যাটালগ আপডেট ও রিড
app.post('/api/catalog/update', (req, res) => {
  const current = loadCatalog();
  if (req.body.products) current.products = req.body.products;
  saveCatalog(current);
  res.json({ success: true, message: "ক্যাটালগ আপডেট সফল!" });
});

app.get('/api/catalog', (req, res) => {
  res.json({ success: true, products: loadCatalog().products || [] });
});

// ৩. হিউম্যান টেকওভার কন্ট্রোল (মাস্টার সুইচ)
app.get('/api/bot-status', (req, res) => {
  const takeover = loadTakeover();
  res.json({
    success: true,
    isGlobalPaused: !!takeover.isGlobalPaused,
    reason: takeover.isGlobalPaused ? 'হিউম্যান টেকওভার সক্রিয়' : 'এআই বট সক্রিয়',
    totalPausedCustomers: (takeover.pausedCustomers || []).length
  });
});

app.post('/api/toggle-bot', (req, res) => {
  const takeover = loadTakeover();
  takeover.isGlobalPaused = !!req.body.isPaused;
  saveTakeover(takeover);
  console.log(`হিউম্যান টেকওভার মোড: ${takeover.isGlobalPaused ? 'চালু (বট বন্ধ)' : 'বন্ধ (বট চালু)'}`);
  res.json({ success: true, isGlobalPaused: takeover.isGlobalPaused });
});

app.post('/api/customers/:senderId/takeover', (req, res) => {
  const { senderId } = req.params;
  const { isPaused } = req.body;
  const takeover = loadTakeover();
  const list = new Set(takeover.pausedCustomers || []);

  if (isPaused) list.add(senderId);
  else list.delete(senderId);

  takeover.pausedCustomers = Array.from(list);
  saveTakeover(takeover);
  res.json({ success: true, senderId, isPaused: !!isPaused });
});

// ----------------- ফেসবুক মেসেঞ্জার ও এআই ওয়েবহুক -----------------

// ফেসবুক ভেরিফিকেশন (GET /webhook)
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('✅ Facebook Webhook Verified!');
    return res.status(200).send(req.query['hub.challenge']);
  }
  return res.sendStatus(403);
});

// ফেসবুক মেসেজ রিসিভার ও অটো-রিপ্লাই (POST /webhook)
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  if (req.body.object !== 'page') return;

  const takeover = loadTakeover();
  const isGlobalPaused = !!takeover.isGlobalPaused;
  const pausedSet = new Set(takeover.pausedCustomers || []);

  for (const entry of (req.body.entry || [])) {
    for (const event of (entry.messaging || [])) {
      const senderId = event.sender?.id;
      const message = event.message;

      if (!message || message.is_echo) continue;

      // 🚨 হিউম্যান টেকওভার চেক:
      // মাস্টার সুইচ অন থাকলে বা নির্দিষ্ট কাস্টমার পজ থাকলে এআই কোনো রিপ্লাই দেবে না!
      if (isGlobalPaused || pausedSet.has(senderId)) {
        console.log(`[Takeover Active] বট বন্ধ, মানুষ কথা বলছে: ${senderId}`);
        continue;
      }

      let userText = message.text || '';
      let mediaBase64 = null;
      let mimeType = 'image/jpeg';

      // অডিও, ছবি বা ভিডিও আসলে প্রসেস করা
      if (message.attachments && message.attachments.length > 0) {
        const att = message.attachments[0];
        if (att.payload?.url) {
          try {
            const resp = await axios.get(att.payload.url, { responseType: 'arraybuffer', timeout: 10000 });
            mediaBase64 = Buffer.from(resp.data).toString('base64');
            mimeType = resp.headers['content-type']?.split(';')[0] || (att.type === 'audio' ? 'audio/mp4' : 'image/jpeg');
          } catch (_) {}
        }
      }

      // ডায়নামিক ক্যাটালগ থেকে তৈরি প্রম্পট
      const parts = [];
      if (mediaBase64) {
        parts.push({ inline_data: { mime_type: mimeType, data: mediaBase64 } });
      }
      parts.push({ text: `${generateDynamicPrompt()}\n\nCustomer Inquiry: "${userText}"` });

      try {
        let aiReply = 'আসসালামু আলাইকুম! ImpoTech Bd-তে স্বাগতম। আমাদের প্রতিনিধি দ্রুত যোগাযোগ করবে।';

        if (GEMINI_API_KEY) {
          const geminiResp = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            { contents: [{ parts }] },
            { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
          );
          const candidate = geminiResp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (candidate) aiReply = candidate.trim();
        }

        if (PAGE_ACCESS_TOKEN) {
          await axios.post(
            `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            { recipient: { id: senderId }, message: { text: aiReply } },
            { headers: { 'Content-Type': 'application/json' } }
          );
          console.log(`✅ উত্তর পাঠানো হয়েছে: ${senderId}`);
        }
      } catch (err) {
        console.error('AI Error:', err.message);
      }
    }
  }
});

// সার্ভার স্ট্যাটাস পেজ
app.get('/', (req, res) => {
  const takeover = loadTakeover();
  const catalog = loadCatalog();
  res.send(`
    <div style="font-family:sans-serif; text-align:center; padding:40px;">
      <h1 style="color:#0284c7;">🚀 ImpoTech Bd - Production AI Hub</h1>
      <p style="font-size:18px; color:${takeover.isGlobalPaused ? '#ef4444' : '#16a34a'};">
        <b>${takeover.isGlobalPaused ? '🚨 হিউম্যান টেকওভার সক্রিয় (বট বন্ধ, মানুষ কথা বলছে)' : '✅ এআই বট সক্রিয় (স্বয়ংক্রিয় রিপ্লাই চলছে)'}</b>
      </p>
      <p>পণ্য ক্যাটালগ: <b>${catalog.products?.length || 0} টি</b> | প্রশ্নোত্তর: <b>${catalog.faqs?.length || 0} টি</b></p>
      <p style="color:#64748b;">(সবকিছু catalog.json ফাইল থেকে ডায়নামিক লোড হচ্ছে)</p>
    </div>
  `);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
