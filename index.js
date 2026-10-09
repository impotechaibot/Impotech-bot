/**
 * =============================================================================
 * IMPOTECH AI MESSENGER BOT & ADMIN BACKEND (MASTER ARCHITECTURE)
 * =============================================================================
 *
 * AI ENGINE (OPENROUTER):
 *   TEXT:   google/gemini-3.1-flash-lite
 *   VISION: google/gemini-3.1-flash-lite
 *   VOICE:  google/gemini-3.1-flash-lite
 *
 * PLATFORM:
 *   Facebook Messenger + Android Admin App Integration
 *
 * CATALOG SYNC:
 *   Direct GitHub (catalog.json) + Local Cache
 *
 * HUMAN TAKEOVER:
 *   Per-customer pause/resume + Master Global Bot Control
 * =============================================================================
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS Middleware (মোবাইল অ্যাপ ও ব্রাউজার এক্সেসের জন্য)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-secret');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// =============================================================================
// ১. কনফিগারেশন ও এনভায়রনমেন্ট
// =============================================================================
const PORT = process.env.PORT || 10000;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'impotech_secret_token_123';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'impotechaibot/Impotech-bot';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const CATALOG_FILE = process.env.CATALOG_FILE || 'data/catalog.json';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'impotech_secret_token_123';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TEXT_MODEL = 'google/gemini-3.1-flash-lite';
const VOICE_MODEL = 'google/gemini-3.1-flash-lite';

const MAX_PRODUCTS_TO_AI = 3;
const MAX_FAQS_TO_AI = 4;
const MAX_OUTPUT_TOKENS = 250;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const LOCAL_CATALOG_PATH = path.join(__dirname, 'catalog.json');
const DATA_FILE = path.join(__dirname, 'storage_data.json');

// =============================================================================
// ২. মেমোরি ও ডাটাবেজ হ্যান্ডলিং
// =============================================================================
let products = [];
let faqs = [];

let db = {
  isGlobalPaused: false,
  takeovers: {}, // { [senderId]: { isPaused: boolean, reason: string, timestamp: string } }
  customers: {},
  messages: [],
  orders: []
};

// কাস্টমার কনভারসেশন হিস্ট্রি (মেমোরি)
const customerHistory = new Map();
const processedMessageIds = new Set();

function loadStorage() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('⚠️ storage_data.json লোড ওয়ার্নিং:', err.message);
  }
}

function saveStorage() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('❌ storage_data.json সেভ এরর:', err.message);
  }
}
loadStorage();

function loadLocalCatalog() {
  try {
    if (fs.existsSync(LOCAL_CATALOG_PATH)) {
      const data = JSON.parse(fs.readFileSync(LOCAL_CATALOG_PATH, 'utf8'));
      products = Array.isArray(data.products) ? data.products : [];
      faqs = Array.isArray(data.faqs) ? data.faqs : [];
      return data;
    }
  } catch (err) {
    console.warn('⚠️ catalog.json লোড ওয়ার্নিং:', err.message);
  }
  return { products, faqs };
}

function saveLocalCatalog(data) {
  try {
    fs.writeFileSync(LOCAL_CATALOG_PATH, JSON.stringify(data, null, 2), 'utf8');
    products = Array.isArray(data.products) ? data.products : [];
    faqs = Array.isArray(data.faqs) ? data.faqs : [];
  } catch (err) {
    console.error('❌ catalog.json লোকাল সেভ এরর:', err.message);
  }
}
loadLocalCatalog();

// =============================================================================
// ৩. টেক্সট নরমালাইজেশন ও রিলিভেন্স সার্চ
// =============================================================================
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

function scoreRecord(query, record, fields) {
  const q = normalizeText(query);
  const queryTokens = tokenize(q);
  if (!queryTokens.length) return 0;

  let score = 0;
  for (const field of fields) {
    const value = normalizeText(record?.[field] || '');
    if (!value) continue;
    if (q.length >= 4 && value.includes(q)) score += 20;

    for (const token of queryTokens) {
      if (value === token) score += 12;
      else if (value.includes(token)) score += 4;
    }
  }
  return score;
}

function findRelevantProducts(query) {
  return products
    .map(product => ({
      product,
      score: scoreRecord(query, product, ['name', 'description', 'shortDescription', 'category', 'brand', 'model', 'sku', 'keywords'])
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PRODUCTS_TO_AI)
    .map(item => item.product);
}

function findRelevantFaqs(query) {
  return faqs
    .map(faq => ({
      faq,
      score: scoreRecord(query, faq, ['question', 'answer', 'category', 'keywords'])
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FAQS_TO_AI)
    .map(item => item.faq);
}

// হিস্ট্রি ম্যানেজমেন্ট
function getHistory(senderId) {
  return customerHistory.get(senderId) || [];
}

function appendHistory(senderId, role, text) {
  if (!senderId || !text) return;
  const history = getHistory(senderId);
  history.push({ role, text: String(text).trim(), timestamp: Date.now() });
  while (history.length > 6) history.shift();
  customerHistory.set(senderId, history);
}

// =============================================================================
// ৪. হিউম্যান টেকওভার কোর ইঞ্জিন
// =============================================================================
function getTakeoverState(customerId) {
  if (!customerId) return db.isGlobalPaused;
  const id = String(customerId).trim();
  if (db.isGlobalPaused) return true;
  if (db.takeovers[id] && typeof db.takeovers[id].isPaused === 'boolean') {
    return db.takeovers[id].isPaused;
  }
  if (db.customers[id] && typeof db.customers[id].takeover === 'boolean') {
    return db.customers[id].takeover;
  }
  return false;
}

async function setTakeoverState(customerId, enabled, reasonStr) {
  if (!customerId) return false;
  const id = String(customerId).trim();
  const isEnabled = Boolean(enabled);
  const reason = reasonStr || (isEnabled ? 'Admin takeover' : 'Admin resumed AI');

  db.takeovers[id] = {
    isPaused: isEnabled,
    reason: reason,
    timestamp: new Date().toISOString()
  };

  if (!db.customers[id]) {
    db.customers[id] = {
      id: id,
      name: 'Customer ' + id.slice(-4),
      messageCount: 0,
      isPaused: isEnabled,
      takeover: isEnabled
    };
  } else {
    db.customers[id].isPaused = isEnabled;
    db.customers[id].takeover = isEnabled;
  }

  saveStorage();
  console.log(`[Takeover] গ্রাহক ${id} -> টেকওভার: ${isEnabled ? 'সক্রিয় (বট বন্ধ)' : 'নিষ্ক্রিয় (বট চালু)'} (${reason})`);
  return isEnabled;
}

// =============================================================================
// ৫. ফেসবুক মেসেঞ্জার সেন্ড এপিআই
// =============================================================================
async function sendFacebookMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn('⚠️ PAGE_ACCESS_TOKEN কনফিগার করা নেই।');
    return false;
  }
  try {
    const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
    const payload = {
      recipient: { id: recipientId },
      message: { text: text },
      messaging_type: 'RESPONSE'
    };
    await axios.post(url, payload, { timeout: 10000 });
    console.log(`✅ [Messenger] গ্রাহক ${recipientId}-কে সফলভাবে উত্তর পাঠানো হয়েছে।`);

    appendHistory(recipientId, 'assistant', text);

    db.messages.push({
      id: 'msg_bot_' + Date.now(),
      senderId: recipientId,
      sender: 'bot',
      text: text,
      timestamp: new Date().toISOString()
    });
    saveStorage();
    return true;
  } catch (err) {
    console.error('❌ Messenger Send Error:', err.response?.data?.error?.message || err.message);
    return false;
  }
}

// =============================================================================
// ৬. গিটহাব সিঙ্ক ও পুল মেথড
// =============================================================================
async function pullCatalogFromGitHub() {
  if (!GITHUB_TOKEN) return false;
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${CATALOG_FILE}?ref=${GITHUB_BRANCH}`;
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Impotech-Admin-Server'
      },
      timeout: 10000
    });

    if (res.data?.content) {
      const parsed = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
      saveLocalCatalog(parsed);
      console.log(`[GITHUB] ক্যাটালগ সফলভাবে লোড হয়েছে: ${products.length} পণ্য, ${faqs.length} FAQ`);
      return true;
    }
  } catch (err) {
    console.warn('[GITHUB] লোড এরর:', err.response?.data?.message || err.message);
  }
  return false;
}

async function pushCatalogToGitHub(catalogData, customToken, customRepo, customBranch, customPath) {
  const token = customToken || GITHUB_TOKEN;
  const repo = customRepo || GITHUB_REPO;
  const branch = customBranch || GITHUB_BRANCH;
  const filePath = customPath || CATALOG_FILE;

  if (!token) {
    return { synced: false, message: 'GitHub Token কনফিগার করা নেই' };
  }

  const url = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Impotech-Admin-Server'
  };

  let sha = null;
  try {
    const getRes = await axios.get(`${url}?ref=${branch}`, { headers, timeout: 10000 });
    if (getRes.data && getRes.data.sha) sha = getRes.data.sha;
  } catch (_) {}

  const fileContentBase64 = Buffer.from(JSON.stringify(catalogData, null, 2), 'utf8').toString('base64');
  const payload = {
    message: `Update catalog from Impotech Admin v${catalogData.version || Date.now()}`,
    content: fileContentBase64,
    branch: branch
  };
  if (sha) payload.sha = sha;

  try {
    const putRes = await axios.put(url, payload, { headers, timeout: 15000 });
    saveLocalCatalog(catalogData);
    console.log(`✅ GitHub-এ ক্যাটালগ সফলভাবে পুশ হয়েছে: ${repo}@${branch}`);
    return { synced: true, commit: putRes.data?.commit?.sha || 'synced' };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    console.error(`❌ GitHub পুশ ব্যর্থ: ${errMsg}`);
    return { synced: false, error: errMsg };
  }
}

// সার্ভার চালুর সময় স্বয়ংক্রিয়ভাবে গিটহাব থেকে ক্যাটালগ আনা
pullCatalogFromGitHub();

// =============================================================================
// ৭. প্রম্পট ও OPENROUTER AI কোর
// =============================================================================
function buildSystemPrompt(relevantProducts, relevantFaqs, history) {
  const productContext = relevantProducts.length
    ? relevantProducts.map((p, i) =>
        `[পণ্য ${i + 1}] নাম: ${p.name || 'N/A'} | মূল্য: ৳${p.price || 'N/A'} | স্টক: ${p.stockStatus || (p.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK')} | বিবরণ: ${p.shortDescription || p.description || 'N/A'}`
      ).join('\n')
    : 'ক্যাটালগে কোনো পণ্য মিলেনি।';

  const faqContext = relevantFaqs.length
    ? relevantFaqs.map((f, i) =>
        `[FAQ ${i + 1}] প্রশ্ন: ${f.question || ''}\nউত্তর: ${f.answer || ''}`
      ).join('\n\n')
    : 'কোনো নির্দিষ্ট FAQ মিলেনি।';

  const historyContext = history.length
    ? history.map(item => `${item.role === 'assistant' ? 'বট' : 'গ্রাহক'}: ${item.text}`).join('\n')
    : 'পূর্বের কোনো কথোপকথন নেই।';

  return `
আপনি ImpoTech BD (ইম্পোটেক বিডি) ফেসবুক পেজের অফিশিয়াল এআই সাপোর্ট অ্যাসিস্ট্যান্ট।
ঠিকানা: ভাওয়াল গড়, ভবানীপুর, জয়দেবপুর, গাজীপুর। হেল্পলাইন: 01884332067।
ডেলিভারি চার্জ: গাজীপুরের ভেতরে ৫০ টাকা, বাইরে ১০০ টাকা। ১০০% ক্যাশ অন ডেলিভারি (কোনো অগ্রিম নেই)। লাইট জ্বালিয়ে চেক করে দেখে মূল্য পরিশোধ করা যাবে।

কঠোর নিয়মাবলী:
১. শুধুমাত্র ক্যাটালগ ও FAQ-এর তথ্যের ওপর ভিত্তি করে সংক্ষিপ্ত, স্পষ্ট ও বিনম্র বাংলায় উত্তর দিন (১-৩ বাক্যে)।
২. দাম, স্টক বা ওয়ারেন্টি মনগড়া বানিয়ে বলবেন না।
৩. গ্রাহক ছবি (Image) পাঠালে ছবিতে কী পণ্য দেখা যাচ্ছে তা শনাক্ত করে ক্যাটালগের সাথে মিলিয়ে উত্তর দিন।
৪. গ্রাহক ভয়েস (Voice/Audio) পাঠালে কথাটি শুনে সরাসরি উত্তর দিন (ট্রান্সক্রিপ্ট আলাদা করে দেখাবেন না)।
৫. কোনো তথ্য না থাকলে বিনীতভাবে বলুন যে আমাদের প্রতিনিধি সরাসরি ইনবক্সে কথা বলবেন।

প্রাসঙ্গিক পণ্য তালিকা:
${productContext}

প্রাসঙ্গিক প্রশ্নোত্তর (FAQ):
${faqContext}

পূর্ববর্তী কথোপকথন:
${historyContext}
`.trim();
}

async function callOpenRouter(messages, model = TEXT_MODEL) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY কনফিগার করা নেই');
  }

  console.log(`[OPENROUTER] রিকোয়েস্ট পাঠানো হচ্ছে -> ${model}`);

  const response = await axios.post(
    OPENROUTER_URL,
    {
      model: model,
      messages: messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.3
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/impotechaibot/Impotech-bot',
        'X-Title': 'ImpoTech Messenger AI Bot'
      },
      timeout: 30000,
      maxContentLength: MAX_ATTACHMENT_BYTES,
      maxBodyLength: MAX_ATTACHMENT_BYTES
    }
  );

  let replyText = response.data?.choices?.[0]?.message?.content;
  if (Array.isArray(replyText)) {
    replyText = replyText.map(i => i?.text || '').join('');
  }
  return String(replyText || '').trim();
}

// =============================================================================
// ৮. টেক্সট, ভিশন ও ভয়েস প্রসেসর
// =============================================================================
async function generateAIResponse(customerText, attachments = [], senderId) {
  const query = customerText || 'পণ্য সম্পর্কে তথ্য দিন';
  const relevantProducts = findRelevantProducts(query);
  const relevantFaqs = findRelevantFaqs(query);
  const history = getHistory(senderId);
  const systemPrompt = buildSystemPrompt(relevantProducts, relevantFaqs, history);

  // ১. ভয়েস মেসেজ চেক (Voice/Audio)
  const audioAttachment = attachments.find(a => a.type === 'audio' && a.payload?.url);
  if (audioAttachment) {
    try {
      console.log('[VOICE] অডিও ফাইল ডাউনলোড ও প্রসেসিং শুরু...');
      const audioRes = await axios.get(audioAttachment.payload.url, { responseType: 'arraybuffer', timeout: 15000 });
      const audioBase64 = Buffer.from(audioRes.data).toString('base64');

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.text })),
        {
          role: 'user',
          content: [
            { type: 'text', text: 'গ্রাহক একটি ভয়েস মেসেজ পাঠিয়েছেন। ভয়েস শুনে সঠিক বাংলায় উত্তর দিন।' },
            {
              type: 'input_audio',
              input_audio: {
                data: audioBase64,
                format: 'mp4'
              }
            }
          ]
        }
      ];
      return await callOpenRouter(messages, VOICE_MODEL);
    } catch (voiceErr) {
      console.warn('⚠️ ভয়েস প্রসেসিং ব্যর্থ:', voiceErr.message);
    }
  }

  // ২. ইমেজ / ভিশন চেক (Vision/Image)
  const imageAttachment = attachments.find(a => a.type === 'image' && a.payload?.url);
  if (imageAttachment) {
    try {
      console.log('[VISION] ইমেজ ডাউনলোড ও প্রসেসিং শুরু...');
      const imgRes = await axios.get(imageAttachment.payload.url, { responseType: 'arraybuffer', timeout: 15000 });
      const imgBase64 = Buffer.from(imgRes.data).toString('base64');
      const dataUrl = `data:image/jpeg;base64,${imgBase64}`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.text })),
        {
          role: 'user',
          content: [
            { type: 'text', text: customerText ? `${customerText}\n(এই ছবিটি দেখে তথ্য দিন)` : 'এই ছবিটি দেখে বলুন এটি কোন পণ্য এবং এর মূল্য ও স্টক কত?' },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ];
      return await callOpenRouter(messages, TEXT_MODEL);
    } catch (visionErr) {
      console.warn('⚠️ ভিশন প্রসেসিং ব্যর্থ:', visionErr.message);
    }
  }

  // ৩. সাধারণ টেক্সট মেসেজ (Text)
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.text })),
    { role: 'user', content: customerText }
  ];
  return await callOpenRouter(messages, TEXT_MODEL);
}

// =============================================================================
// ৯. ফেসবুক মেসেঞ্জার ওয়েবহুক (Webhook)
// =============================================================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ ফেসবুক ওয়েবহুক সফলভাবে ভেরিফাই হয়েছে!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object === 'page') {
      const entries = body.entry || [];
      for (const entry of entries) {
        const messaging = entry.messaging || [];
        for (const event of messaging) {
          const senderId = event.sender?.id;
          const msgId = event.message?.mid;

          if (msgId && processedMessageIds.has(msgId)) continue;
          if (msgId) {
            processedMessageIds.add(msgId);
            setTimeout(() => processedMessageIds.delete(msgId), 300000);
          }

          if (event.message && !event.message.is_echo && senderId) {
            const text = event.message.text || '';
            const attachments = event.message.attachments || [];
            const isPaused = getTakeoverState(senderId);

            appendHistory(senderId, 'user', text || '[Media File]');

            // লোকাল ডাটাবেজে বার্তা লগ
            db.messages.push({
              id: 'msg_' + Date.now(),
              senderId: senderId,
              sender: 'customer',
              text: text || `[Media: ${attachments[0]?.type || 'file'}]`,
              timestamp: new Date().toISOString()
            });

            if (!db.customers[senderId]) {
              db.customers[senderId] = {
                id: senderId,
                name: 'Customer ' + senderId.slice(-4),
                messageCount: 1,
                lastActive: new Date().toISOString(),
                isPaused: isPaused,
                takeover: isPaused,
                lastMessageText: text || '[Media]'
              };
            } else {
              db.customers[senderId].messageCount = (db.customers[senderId].messageCount || 0) + 1;
              db.customers[senderId].lastActive = new Date().toISOString();
              db.customers[senderId].lastMessageText = text || '[Media]';
            }
            saveStorage();

            // ⚠️ হিউম্যান টেকওভার গার্ড
            if (isPaused) {
              console.log(`[Takeover] গ্রাহক ${senderId} টেকওভার মোডে আছেন। বট উত্তর দেবে না।`);
            } else {
              console.log(`[AI Response] প্রসেসিং শুরু (${senderId}): "${text}"`);
              try {
                const aiReply = await generateAIResponse(text, attachments, senderId);
                if (aiReply) {
                  await sendFacebookMessage(senderId, aiReply);
                }
              } catch (aiErr) {
                console.error('❌ AI রেসপন্স এরর:', aiErr.message);
                await sendFacebookMessage(senderId, 'ধন্যবাদ আপনার মেসেজের জন্য! বিস্তারিত জানতে আমাদের কল করুন: 01884332067');
              }
            }
          }
        }
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    return res.status(200).send('EVENT_RECEIVED');
  }
});

// =============================================================================
// ১০. ক্যাটালগ ও গিটহাব সিঙ্ক API (অ্যান্ড্রয়েড অ্যাপের জন্য)
// =============================================================================
app.get('/api/catalog', (req, res) => {
  const cat = loadLocalCatalog();
  res.json({ success: true, catalog: cat, products: cat.products || [], faqs: cat.faqs || [] });
});

app.post('/api/catalog/sync', async (req, res) => {
  try {
    const catalogData = req.body;
    saveLocalCatalog(catalogData);

    // গিটহাবে পুশ করার চেষ্টা
    let ghResult = { synced: false };
    if (GITHUB_TOKEN) {
      ghResult = await pushCatalogToGitHub(catalogData);
    }

    res.json({
      success: true,
      message: `ক্যাটালগ সফলভাবে সিঙ্ক হয়েছে! (${products.length} পণ্য, ${faqs.length} FAQ)`,
      totalProducts: products.length,
      totalFaqs: faqs.length,
      githubSynced: ghResult.synced
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// সরাসরি গিটহাব ক্যাটালগ আপলোড এন্ডপয়েন্ট
app.post('/api/github/upload', async (req, res) => {
  try {
    const { catalog: catalogPayload, githubRepo, githubBranch, githubToken, githubFilePath } = req.body;
    const targetCatalog = catalogPayload || loadLocalCatalog();
    const token = githubToken || GITHUB_TOKEN;
    const repo = githubRepo || GITHUB_REPO;
    const branch = githubBranch || GITHUB_BRANCH;
    const filePath = githubFilePath || CATALOG_FILE;

    const ghRes = await pushCatalogToGitHub(targetCatalog, token, repo, branch, filePath);
    if (ghRes.synced) {
      res.json({
        success: true,
        message: `ক্যাটালগ সফলভাবে গিটহাবে আপলোড হয়েছে! (${repo}@${branch})`,
        totalProducts: products.length,
        totalFaqs: faqs.length
      });
    } else {
      res.status(400).json({
        success: false,
        message: `গিটহাব আপলোড ব্যর্থ: ${ghRes.error || ghRes.message}`
      });
    }
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// =============================================================================
// ১১. টেকওভার ও অ্যাডমিন কন্ট্রোল API (অ্যান্ড্রয়েড অ্যাপের জন্য)
// =============================================================================
// গ্লোবাল বট কন্ট্রোল
app.get('/api/bot-status', (req, res) => {
  res.json({
    success: true,
    isGlobalPaused: !!db.isGlobalPaused,
    reason: db.isGlobalPaused ? 'হিউম্যান টেকওভার সক্রিয়' : 'এআই বট চালু',
    totalPausedCustomers: Object.values(db.takeovers).filter(t => t.isPaused).length
  });
});

app.post('/api/toggle-bot', (req, res) => {
  db.isGlobalPaused = !!req.body.isPaused;
  saveStorage();
  console.log(`[Master Switch] গ্লোবাল বট: ${db.isGlobalPaused ? 'স্থগিত (PAUSED)' : 'সচল (ACTIVE)'}`);
  res.json({ success: true, isGlobalPaused: db.isGlobalPaused });
});

// প্রতি কাস্টমারের টেকওভার
app.post('/api/customers/:senderId/takeover', async (req, res) => {
  const { senderId } = req.params;
  const isPaused = req.body.isPaused !== undefined ? !!req.body.isPaused : (req.body.takeover !== undefined ? !!req.body.takeover : true);
  await setTakeoverState(senderId, isPaused, req.body.reason);
  res.json({ success: true, senderId, isPaused, takeover: isPaused });
});

app.get('/api/customers/:senderId/status', (req, res) => {
  const { senderId } = req.params;
  const isPaused = getTakeoverState(senderId);
  res.json({ success: true, senderId, isPaused, takeover: isPaused });
});

app.get('/api/customers', (req, res) => {
  const list = Object.values(db.customers).map(c => ({
    senderId: c.id,
    displayName: c.name || `Customer ${c.id.slice(-4)}`,
    phone: c.phone || null,
    lastMessageText: c.lastMessageText || null,
    lastMessageAt: c.lastActive || null,
    takeover: getTakeoverState(c.id),
    isPaused: getTakeoverState(c.id)
  }));
  res.json({ success: true, data: list });
});

// সরাসরি কাস্টমারকে উত্তর পাঠানো
app.post('/api/customers/:senderId/send', async (req, res) => {
  const { senderId } = req.params;
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });

  const sent = await sendFacebookMessage(senderId, text);
  if (sent) {
    res.json({ success: true, message: 'মেসেজ সরাসরি পাঠানো হয়েছে।' });
  } else {
    res.status(500).json({ success: false, message: 'মেসেজ পাঠানো ব্যর্থ হয়েছে।' });
  }
});

// সিস্টেম হেলথ চেক
app.get('/health', (req, res) => res.status(200).json({ success: true, status: 'ok' }));
app.get('/api/health', (req, res) => res.status(200).json({ status: 'LIVE_PRODUCTION', isGlobalPaused: db.isGlobalPaused }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ImpoTech Master Bot Server running on port ${PORT}`);
});
