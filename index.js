/**
 * ImpoTech Bd - Complete Production Master Bot Code
 *
 * MODELS (OpenRouter):
 *   TEXT:   google/gemini-2.5-flash-lite
 *   VOICE:  google/gemini-2.5-flash-lite
 *   VISION: google/gemini-3.1-flash-lite
 *
 * ENVIRONMENT VARIABLES REQUIRED (Render):
 *   PAGE_ACCESS_TOKEN
 *   VERIFY_TOKEN
 *   OPENROUTER_API_KEY (or GEMINI_API_KEY)
 *   GITHUB_TOKEN
 *   GITHUB_REPO=impotechaibot/Impotech-bot
 */

const express = require('express');
const axios = require('axios');

const app = express();

app.use(express.json({ limit: '25mb' }));

// =========================================================
// ENVIRONMENT & CONFIGURATION
// =========================================================

const PORT = process.env.PORT || 10000;

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'impotechaibot/Impotech-bot';

// =========================================================
// OPENROUTER AI MODELS
// =========================================================

const TEXT_MODEL = 'google/gemini-2.5-flash-lite';
const VOICE_MODEL = 'google/gemini-2.5-flash-lite';
const VISION_MODEL = 'google/gemini-3.1-flash-lite';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// =========================================================
// CATALOG & MEMORY LIMITS
// =========================================================

const CATALOG_FILE = 'catalog.json';

const MAX_PRODUCTS_TO_GEMINI = 3;
const MAX_FAQS_TO_GEMINI = 4;

const MAX_OUTPUT_TOKENS = 250;
const MAX_HISTORY_ITEMS = 8; // বর্ধিত মেমোরি যাতে ঠিকানা ভুলে না যায়

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20MB Limit

// =========================================================
// IN-MEMORY STORAGE
// =========================================================

let products = [];
let faqs = [];

const pausedCustomers = new Set();
const processedMessageIds = new Set();
const customerHistory = new Map();

// =========================================================
// HELPER FUNCTIONS
// =========================================================

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

// =========================================================
// SEARCH & RELEVANCE ALGORITHM
// =========================================================

function scoreRecord(query, record, fields) {
  const q = normalizeText(query);
  const queryTokens = tokenize(q);

  if (!queryTokens.length) return 0;

  let score = 0;

  for (const field of fields) {
    const value = normalizeText(record?.[field] || '');
    if (!value) continue;

    if (q.length >= 4 && value.includes(q)) {
      score += 20;
    }

    for (const token of queryTokens) {
      if (value === token) {
        score += 12;
      } else if (value.includes(token)) {
        score += 4;
      }
    }
  }

  return score;
}

function findRelevantProducts(query) {
  return products
    .map(product => ({
      product,
      score: scoreRecord(query, product, [
        'name',
        'description',
        'category',
        'brand',
        'model',
        'sku',
        'keywords'
      ])
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PRODUCTS_TO_GEMINI)
    .map(item => item.product);
}

function findRelevantFaqs(query) {
  return faqs
    .map(faq => ({
      faq,
      score: scoreRecord(query, faq, [
        'question',
        'answer',
        'category',
        'keywords'
      ])
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FAQS_TO_GEMINI)
    .map(item => item.faq);
}

// =========================================================
// MEDIA REQUEST DETECTION & SEARCH
// =========================================================

function customerExplicitlyRequestsMedia(text) {
  const q = normalizeText(text);
  const mediaWords = [
    'ছবি', 'ফটো', 'পিক', 'photo', 'picture', 'image',
    'video', 'ভিডিও', 'ছবিটা', 'ছবি দেন', 'ছবি দিন', 'পিক দেন'
  ];
  return mediaWords.some(word => q.includes(normalizeText(word)));
}

function findMediaProduct(text) {
  const q = normalizeText(text);

  const matches = products
    .map(product => {
      const name = normalizeText(product.name || '');
      const model = normalizeText(product.model || '');
      const sku = normalizeText(product.sku || '');

      let score = 0;
      if (name && q.includes(name)) score += 30;
      if (model && q.includes(model)) score += 20;
      if (sku && q.includes(sku)) score += 20;

      return { product, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return matches[0]?.product || null;
}

// =========================================================
// GITHUB INTEGRATION
// =========================================================

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
  if (!GITHUB_TOKEN) {
    console.log('[GITHUB] GITHUB_TOKEN missing; using local catalog.');
    return false;
  }

  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${CATALOG_FILE}`;
    const response = await githubRequest('GET', url);

    if (!response.data?.content) {
      throw new Error('catalog.json content missing');
    }

    const json = JSON.parse(
      Buffer.from(response.data.content, 'base64').toString('utf8')
    );

    products = Array.isArray(json.products) ? json.products : [];
    faqs = Array.isArray(json.faqs) ? json.faqs : [];

    console.log(`[GITHUB] Catalog updated: ${products.length} products, ${faqs.length} FAQs`);
    return true;

  } catch (error) {
    console.error('[GITHUB] Pull error:', error.message);
    return false;
  }
}

async function autoCommitToGitHub() {
  if (!GITHUB_TOKEN) return false;

  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${CATALOG_FILE}`;
    const getResponse = await githubRequest('GET', url);

    const content = JSON.stringify({ products, faqs }, null, 2);
    const encoded = Buffer.from(content, 'utf8').toString('base64');

    await githubRequest('PUT', url, {
      message: 'Update catalog.json from Render Server',
      content: encoded,
      sha: getResponse.data.sha
    });

    console.log('[GITHUB] Successfully synced catalog to GitHub.');
    return true;

  } catch (error) {
    console.error('[GITHUB] Sync error:', error.message);
    return false;
  }
}

// =========================================================
// COMPACT SYSTEM PROMPT
// =========================================================

function buildCompactPrompt(customerText, relevantProducts, relevantFaqs, history) {
  const productContext = relevantProducts.length
    ? relevantProducts
        .map((p, i) => [
          `PRODUCT ${i + 1}`,
          `Name: ${p.name || 'N/A'}`,
          `Price: ${p.price !== undefined ? `${p.price} টাকা` : 'N/A'}`,
          `Category: ${p.category || 'N/A'}`,
          `Model/SKU: ${p.model || p.sku || 'N/A'}`,
          `Description: ${p.description || 'N/A'}`
        ].join(' | '))
        .join('\n')
    : 'No matching product found locally.';

  const faqContext = relevantFaqs.length
    ? relevantFaqs
        .map((f, i) => `FAQ ${i + 1}\nQ: ${f.question || ''}\nA: ${f.answer || ''}`)
        .join('\n\n')
    : 'No matching FAQ found locally.';

  const historyContext = history.length
    ? history.map(item => `${item.role}: ${item.text}`).join('\n')
    : 'No previous conversation context.';

  return `
তুমি ImpoTech Bd-এর Facebook Messenger customer-support ও sales assistant।

কঠোর নিয়মাবলী:
১. কাস্টমার যদি পূর্ববর্তী কথোপকথনে (History) বা বর্তমান মেসেজে নাম, মোবাইল নম্বর, জেলা/ঠিকানা দিয়ে থাকে, তবে তা নিখুঁতভাবে মনে রাখবে।
২. কাস্টমার একবার ঠিকানা বা ফোন নম্বর প্রদান করলে **পুনরায় তার কাছে ঠিকানা/ফোন নম্বর চাবে না**।
৩. কাস্টমার প্রোডাক্ট সিলেক্ট করার পর যদি ঠিকানা ইতোমধ্যে দেওয়া থাকে, সরাসরি অর্ডার সফলভাবে কনফার্ম করা হয়েছে তা জানাবে এবং বিল হিসেব দেবে।
৪. দাম, stock, warranty, specification বা policy বানিয়ে বলবে না। শুধুমাত্র প্রদত্ত ক্যাটালগ অনুসরণ করবে।
৫. কাস্টমার যে ভাষায় কথা বলবে (বাংলা/English) সেই ভাষায় উত্তর দাও।
৬. অপ্রয়োজনীয় বড় উত্তর দেবে না। সাধারণত ২-৪টি ছোট বাক্যে প্রফেশনাল উত্তর দাও।

প্রাসঙ্গিক Products:
${productContext}

প্রাসঙ্গিক FAQs:
${faqContext}

পূর্ববর্তী কথোপকথনের ইতিহাস (History):
${historyContext}

Customer Message:
${customerText || '[Media/Voice message received]'}
`.trim();
}

// =========================================================
// OPENROUTER API CALLS (TEXT, VISION, VOICE)
// =========================================================

async function callOpenRouter(modelName, messagesArray) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is missing');
  }

  const response = await axios.post(
    OPENROUTER_URL,
    {
      model: modelName,
      messages: messagesArray,
      max_tokens: MAX_OUTPUT_TOKENS
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://impotechbd.com',
        'X-Title': 'ImpoTech Bd Assistant'
      },
      timeout: 45000
    }
  );

  const content = response.data?.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('OpenRouter API returned an empty response');
  }

  return content;
}

// 1. TEXT AI
async function callTextGemini(promptText) {
  const messages = [{ role: 'user', content: promptText }];
  return await callOpenRouter(TEXT_MODEL, messages);
}

// 2. VISION AI (Images)
async function callVisionGemini(imageBase64, mimeType, promptText) {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        {
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${imageBase64}` }
        }
      ]
    }
  ];
  return await callOpenRouter(VISION_MODEL, messages);
}

// 3. VOICE AI (Audio)
async function callVoiceGemini(audioBase64, mimeType, promptText) {
  let format = 'aac';
  if (mimeType && mimeType.includes('/')) {
    format = mimeType.split('/')[1].toLowerCase().replace('mpeg', 'mp3');
  }

  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `${promptText}\n\nগুরুত্বপূর্ণ:\nCustomer-এর voice message শুনে সরাসরি সংক্ষেপে তার প্রশ্নের উত্তর দাও।`
        },
        {
          type: 'input_audio',
          input_audio: {
            data: audioBase64,
            format: format
          }
        }
      ]
    }
  ];
  return await callOpenRouter(VOICE_MODEL, messages);
}

// =========================================================
// MESSENGER API INTEGRATION
// =========================================================

async function downloadMessengerAttachment(attachment) {
  const url = attachment?.payload?.url || attachment?.url;
  if (!url || !isValidHttpUrl(url)) return null;

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxContentLength: MAX_ATTACHMENT_BYTES,
      maxBodyLength: MAX_ATTACHMENT_BYTES
    });

    const buffer = Buffer.from(response.data);
    let mimeType = response.headers['content-type']?.split(';')[0];

    return {
      mimeType: mimeType || 'image/jpeg',
      base64: buffer.toString('base64')
    };

  } catch (error) {
    console.error('[MEDIA] Download error:', error.message);
    return null;
  }
}

async function sendMessengerText(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) throw new Error('PAGE_ACCESS_TOKEN is missing');

  await axios.post(
    'https://graph.facebook.com/v23.0/me/messages',
    {
      recipient: { id: recipientId },
      message: { text }
    },
    {
      params: { access_token: PAGE_ACCESS_TOKEN },
      timeout: 15000
    }
  );
}

async function sendMessengerMedia(recipientId, mediaType, mediaUrl) {
  if (!PAGE_ACCESS_TOKEN || !isValidHttpUrl(mediaUrl)) return false;

  await axios.post(
    'https://graph.facebook.com/v23.0/me/messages',
    {
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: mediaType,
          payload: { url: mediaUrl, is_reusable: true }
        }
      }
    },
    {
      params: { access_token: PAGE_ACCESS_TOKEN },
      timeout: 15000
    }
  );

  return true;
}

// =========================================================
// HISTORY MANAGEMENT
// =========================================================

function getHistory(senderId) {
  return customerHistory.get(senderId) || [];
}

function addHistory(senderId, role, text) {
  const history = getHistory(senderId);
  history.push({
    role,
    text: String(text || '').slice(0, 500)
  });

  while (history.length > MAX_HISTORY_ITEMS) {
    history.shift();
  }

  customerHistory.set(senderId, history);
}

// =========================================================
// CORE MESSAGE HANDLER
// =========================================================

async function handleMessengerMessage(senderId, message) {
  if (!senderId || !message) return;

  const text = String(message.text || '').trim();

  // ১. চেক করুন কাস্টমার PAUSED অবস্থায় আছে কিনা
  if (pausedCustomers.has(senderId)) {
    console.log(`[TAKEOVER] AI is paused for customer: ${senderId}`);
    return;
  }

  // ২. মিডিয়া ফাইল গ্রহণ
  let downloadedMedia = null;
  let attachmentType = null;

  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const attachment = message.attachments[0];
    attachmentType = String(attachment.type || '').toLowerCase();
    downloadedMedia = await downloadMessengerAttachment(attachment);
  }

  // ৩. প্রোডাক্ট পিকচার/ভিডিও এর এক্সপ্লিসিট রিকোয়েস্ট চেক
  if (text && customerExplicitlyRequestsMedia(text)) {
    const mediaProduct = findMediaProduct(text);
    if (mediaProduct && mediaProduct.mediaUrl && isValidHttpUrl(mediaProduct.mediaUrl)) {
      const mediaType = String(mediaProduct.mediaType || 'IMAGE').toLowerCase() === 'video' ? 'video' : 'image';
      await sendMessengerMedia(senderId, mediaType, mediaProduct.mediaUrl);
      return;
    }
  }

  // ৪. প্রাসঙ্গিক সার্চ ও প্রম্পট তৈরি
  const relevantProducts = findRelevantProducts(text);
  const relevantFaqs = findRelevantFaqs(text);
  const history = getHistory(senderId);
  const prompt = buildCompactPrompt(text, relevantProducts, relevantFaqs, history);

  try {
    let reply = '';

    // ক) ভয়েস মেসেজ হলে
    if (downloadedMedia && attachmentType === 'audio') {
      reply = await callVoiceGemini(downloadedMedia.base64, downloadedMedia.mimeType, prompt);
    }
    // খ) ইমেজে পাঠালে (Vision)
    else if (downloadedMedia && attachmentType === 'image') {
      reply = await callVisionGemini(downloadedMedia.base64, downloadedMedia.mimeType, prompt);
    }
    // গ) সাধারণ টেক্সট মেসেজ
    else {
      reply = await callTextGemini(prompt);
    }

    await sendMessengerText(senderId, reply);

    if (text) addHistory(senderId, 'Customer', text);
    addHistory(senderId, 'Assistant', reply);

  } catch (error) {
    console.error('[AI ERROR]:', error.message);
    await sendMessengerText(
      senderId,
      'দুঃখিত, এই মুহূর্তে সিস্টেম প্রসেস করতে কিছুটা সমস্যা হচ্ছে। অনুগ্রহ করে কিছুক্ষণ পর আবার মেসেজ দিন।'
    );
  }
}

// =========================================================
// WEBHOOK VERIFICATION & RECEIVER
// =========================================================

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[WEBHOOK] Verified');
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'page') return;

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const message = event.message;
        if (!message) continue;

        // =================================================
        // ADMIN TAKEOVER CHECK (Via message_echoes)
        // =================================================
        const isEcho = message.is_echo || false;

        if (isEcho) {
          // এটি পেজের অ্যাডমিনের পাঠানো মেসেজ
          const targetCustomerId = event.recipient?.id;
          const adminText = String(message.text || '').trim().toLowerCase();

          if (!targetCustomerId) continue;

          // অ্যাডমিন ডট (.) দিলে পজ হবে
          if (adminText === '.') {
            pausedCustomers.add(targetCustomerId);
            console.log(`[TAKEOVER] Admin PAUSED AI for customer: ${targetCustomerId}`);
          }
          // অ্যাডমিন .on বা .start দিলে রিজ্যুম হবে
          else if (adminText === '.on' || adminText === '.start') {
            pausedCustomers.delete(targetCustomerId);
            console.log(`[TAKEOVER] Admin RESUMED AI for customer: ${targetCustomerId}`);
          }

          continue; // ইকো মেসেজের ক্ষেত্রে এআই রিপ্লাই দেবে না
        }

        // =================================================
        // CUSTOMER MESSAGE HANDLING
        // =================================================
        const senderId = event.sender?.id;
        if (!senderId) continue;

        const messageId = message.mid;
        if (messageId) {
          if (processedMessageIds.has(messageId)) continue;

          processedMessageIds.add(messageId);
          if (processedMessageIds.size > 5000) {
            const first = processedMessageIds.values().next().value;
            processedMessageIds.delete(first);
          }
        }

        await handleMessengerMessage(senderId, message);
      }
    }

  } catch (error) {
    console.error('[WEBHOOK ERROR]:', error.message);
  }
});

// =========================================================
// TRAINING & STATUS APIS
// =========================================================

app.post('/api/training', async (req, res) => {
  try {
    const body = req.body || {};

    if (Array.isArray(body.products)) products = body.products;
    if (Array.isArray(body.faqs)) faqs = body.faqs;

    if (body.type === 'product' && body.data) products.push(body.data);
    if (body.type === 'faq' && body.data) faqs.push(body.data);

    const synced = await autoCommitToGitHub();

    return res.json({
      success: true,
      products: products.length,
      faqs: faqs.length,
      githubSynced: synced
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('ImpoTech Bd Complete AI Master Bot is running.');
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    provider: 'OpenRouter',
    textModel: TEXT_MODEL,
    voiceModel: VOICE_MODEL,
    visionModel: VISION_MODEL,
    products: products.length,
    faqs: faqs.length,
    pausedCustomers: pausedCustomers.size
  });
});

// =========================================================
// SERVER STARTUP
// =========================================================

async function startServer() {
  await pullCatalogFromGitHub();

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`TEXT: ${TEXT_MODEL} | VOICE: ${VOICE_MODEL} | VISION: ${VISION_MODEL}`);
  });

  setInterval(async () => {
    await pullCatalogFromGitHub();
  }, 60 * 1000);
}

startServer().catch(error => {
  console.error('[STARTUP FATAL ERROR]:', error);
  process.exit(1);
});
