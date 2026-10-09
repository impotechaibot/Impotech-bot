
/**
 * =============================================================================
 * IMPOTECH AI MESSENGER BOT & ADMIN BACKEND
 * =============================================================================
 *
 * TEXT / VISION / VOICE : OpenRouter Gemini
 * CATALOG               : GitHub catalog.json + Local cache
 * MEDIA                 : Product-specific Facebook image/video links
 * HUMAN TAKEOVER         : Per-customer + Global bot control
 * ADMIN API              : Catalog, customers, messages, orders, bot status
 *
 * IMPORTANT:
 * - Existing product IDs, prices and media URLs are not changed.
 * - Existing API routes are retained.
 * - Do not commit API tokens or passwords to GitHub.
 * =============================================================================
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

// =============================================================================
// 1. CORS
// =============================================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-admin-secret'
  );

  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// =============================================================================
// 2. CONFIGURATION
// =============================================================================
const PORT = process.env.PORT || 10000;

const PAGE_ACCESS_TOKEN =
  process.env.PAGE_ACCESS_TOKEN ||
  process.env.META_ACCESS_TOKEN ||
  '';

const VERIFY_TOKEN =
  process.env.VERIFY_TOKEN ||
  'impotech_secret_token_123';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const GITHUB_REPO =
  process.env.GITHUB_REPO || 'impotechaibot/Impotech-bot';

const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const CATALOG_FILE = process.env.CATALOG_FILE || 'data/catalog.json';

const ADMIN_SECRET =
  process.env.ADMIN_SECRET || 'impotech_secret_token_123';

const OPENROUTER_URL =
  'https://openrouter.ai/api/v1/chat/completions';

const TEXT_MODEL = 'google/gemini-3.1-flash-lite';
const VOICE_MODEL = 'google/gemini-3.1-flash-lite';

const MAX_PRODUCTS_TO_AI = 3;
const MAX_FAQS_TO_AI = 4;
const MAX_OUTPUT_TOKENS = 200;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const LOCAL_CATALOG_PATH = path.join(__dirname, 'catalog.json');
const DATA_FILE = path.join(__dirname, 'storage_data.json');

// =============================================================================
// 3. MEMORY AND LOCAL STORAGE
// =============================================================================
let products = [];
let faqs = [];

let catalogMeta = {
  version: null,
  updatedAt: null,
  source: 'local',
  lastSyncAt: null,
  lastSyncError: null
};

let db = {
  isGlobalPaused: false,
  takeovers: {},
  customers: {},
  messages: [],
  orders: []
};

const customerHistory = new Map();
const processedMessageIds = new Set();

function loadStorage() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;

    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

    // Preserve compatibility with existing storage_data.json.
    db = {
      isGlobalPaused: false,
      takeovers: {},
      customers: {},
      messages: [],
      orders: [],
      ...saved
    };
  } catch (err) {
    console.warn('[STORAGE] Load warning:', err.message);
  }
}

function saveStorage() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('[STORAGE] Save error:', err.message);
  }
}

function applyCatalog(data, source = 'local') {
  if (!data || !Array.isArray(data.products)) {
    throw new Error('Invalid catalog: products must be an array');
  }

  products = data.products;
  faqs = Array.isArray(data.faqs) ? data.faqs : [];

  catalogMeta = {
    version: data.version ?? null,
    updatedAt: data.updatedAt ?? null,
    source,
    lastSyncAt: new Date().toISOString(),
    lastSyncError: null
  };
}

function loadLocalCatalog() {
  try {
    if (!fs.existsSync(LOCAL_CATALOG_PATH)) {
      return {
        products,
        faqs,
        version: catalogMeta.version,
        updatedAt: catalogMeta.updatedAt
      };
    }

    const data = JSON.parse(
      fs.readFileSync(LOCAL_CATALOG_PATH, 'utf8')
    );

    applyCatalog(data, 'local');
    return data;
  } catch (err) {
    console.warn('[CATALOG] Local load warning:', err.message);
    return { products, faqs };
  }
}

function saveLocalCatalog(data, source = 'local') {
  // Validate before replacing the current in-memory catalog.
  if (!data || !Array.isArray(data.products)) {
    throw new Error('Invalid catalog: products must be an array');
  }

  const tempPath = LOCAL_CATALOG_PATH + '.tmp';

  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, LOCAL_CATALOG_PATH);

  applyCatalog(data, source);
}

loadStorage();
loadLocalCatalog();

// =============================================================================
// 4. TEXT NORMALIZATION AND PRODUCT SEARCH
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
    const raw = record?.[field];
    const value = normalizeText(
      Array.isArray(raw) ? raw.join(' ') : raw || ''
    );

    if (!value) continue;

    if (q.length >= 4 && value.includes(q)) score += 20;

    for (const token of queryTokens) {
      if (value === token) score += 12;
      else if (value.includes(token)) score += 4;
    }
  }

  return score;
}

function productScore(query, product) {
  return scoreRecord(query, product, [
    'id',
    'name',
    'description',
    'shortDescription',
    'category',
    'brand',
    'model',
    'sku',
    'keywords',
    'tags'
  ]);
}

function findRelevantProducts(query) {
  return products
    .map(product => ({
      product,
      score: productScore(query, product)
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
      score: scoreRecord(query, faq, [
        'question',
        'answer',
        'category',
        'keywords'
      ])
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FAQS_TO_AI)
    .map(item => item.faq);
}

function getHistory(senderId) {
  return customerHistory.get(String(senderId)) || [];
}

function appendHistory(senderId, role, text) {
  if (!senderId || !text) return;

  const id = String(senderId);
  const history = getHistory(id);

  history.push({
    role,
    text: String(text).trim(),
    timestamp: Date.now()
  });

  while (history.length > 6) history.shift();
  customerHistory.set(id, history);
}

// =============================================================================
// 5. MEDIA REQUEST DETECTION
// =============================================================================
function getMediaType(text = '') {
  const value = normalizeText(text);

  const asksVideo =
    /ভিডিও|video|রিল|reel|clip/.test(value);

  const asksImage =
    /ছবি|ফটো|পিকচার|ইমেজ|image|photo|picture/.test(value);

  if (asksVideo) return 'videos';
  if (asksImage) return 'images';

  return null;
}

function isMediaRequest(text = '') {
  return Boolean(getMediaType(text));
}

function isFacebookLink(url) {
  try {
    const parsed = new URL(url);

    return (
      parsed.protocol === 'https:' &&
      (
        parsed.hostname === 'facebook.com' ||
        parsed.hostname.endsWith('.facebook.com')
      )
    );
  } catch (_) {
    return false;
  }
}

function getProductMediaUrls(product, mediaType) {
  const media = product?.media;

  if (!media || !Array.isArray(media[mediaType])) return [];

  return media[mediaType]
    .filter(url => typeof url === 'string' && isFacebookLink(url));
}

function getProductNameText(product) {
  return normalizeText([
    product?.id,
    product?.name,
    product?.shortDescription,
    product?.keywords || [],
    product?.tags || []
  ].flat().join(' '));
}

/**
 * Select a product for a media request.
 *
 * Use the current message plus recent customer messages so that:
 * "হেডলাইট দেখাও" followed by "ছবি দাও"
 * can refer to the same product.
 *
 * If there is no confident match, ask the customer to clarify instead of
 * sending media belonging to an unrelated product.
 */
function findProductForMedia(query, senderId) {
  const history = getHistory(senderId);
  const previousCustomerText = history
    .filter(item => item.role === 'user')
    .slice(-4)
    .map(item => item.text)
    .join(' ');

  const currentText = normalizeText(query);
  const combinedQuery = normalizeText(
    `${previousCustomerText} ${currentText}`
  );

  // Prefer products matched by the current request itself.
  const ranked = products
    .map(product => {
      const currentScore = productScore(currentText, product);
      const combinedScore = productScore(combinedQuery, product);

      return {
        product,
        currentScore,
        combinedScore
      };
    })
    .sort((a, b) => {
      if (b.currentScore !== a.currentScore) {
        return b.currentScore - a.currentScore;
      }

      return b.combinedScore - a.combinedScore;
    });

  if (!ranked.length) return null;

  const first = ranked[0];
  const second = ranked[1];

  // A generic "ছবি দাও" request should not select an arbitrary product.
  if (first.currentScore === 0 && first.combinedScore === 0) {
    return null;
  }

  // If the current query has a direct product match, use it.
  if (first.currentScore > 0) {
    return first.product;
  }

  // Otherwise only use conversation history when there is a clear winner.
  if (
    first.combinedScore > 0 &&
    (
      !second ||
      first.combinedScore > second.combinedScore
    )
  ) {
    return first.product;
  }

  return null;
}

function getProductMediaReply(query, senderId) {
  const mediaType = getMediaType(query);
  if (!mediaType) return null;

  const product = findProductForMedia(query, senderId);

  if (!product) {
    return 'আপনি কোন পণ্যের ছবি বা ভিডিও দেখতে চান, দয়া করে পণ্যটির নামটি বলবেন?';
  }

  const urls = getProductMediaUrls(product, mediaType);
  const label = mediaType === 'images' ? 'ছবির' : 'ভিডিওর';

  if (!urls.length) {
    console.log(
      `[MEDIA] No ${mediaType} URL for product ${product.id}`
    );

    return `দুঃখিত, ${product.name} পণ্যের ${label} লিংক বর্তমানে ক্যাটালগে নেই। আমাদের প্রতিনিধি আপনাকে সাহায্য করবেন।`;
  }

  console.log(
    `[MEDIA] Product=${product.id}, type=${mediaType}, count=${urls.length}`
  );

  const links = urls
    .map((url, index) => `${index + 1}. ${url}`)
    .join('\n');

  return (
    `অবশ্যই! ${product.name} পণ্যের ${label} লিংক নিচে দেওয়া হলো:\n\n` +
    `${links}\n\n` +
    'এগুলো আমাদের ক্যাটালগে সংরক্ষিত Facebook লিংক। লিংকে চাপ দিয়ে মূল পোস্ট বা ভিডিও দেখতে পারবেন।'
  );
}

// =============================================================================
// 6. HUMAN TAKEOVER
// =============================================================================
function getTakeoverState(customerId) {
  if (!customerId) return db.isGlobalPaused;

  const id = String(customerId).trim();

  if (db.isGlobalPaused) return true;

  if (
    db.takeovers[id] &&
    typeof db.takeovers[id].isPaused === 'boolean'
  ) {
    return db.takeovers[id].isPaused;
  }

  if (
    db.customers[id] &&
    typeof db.customers[id].takeover === 'boolean'
  ) {
    return db.customers[id].takeover;
  }

  return false;
}

async function setTakeoverState(customerId, enabled, reasonStr) {
  if (!customerId) return false;

  const id = String(customerId).trim();
  const isEnabled = Boolean(enabled);

  const reason =
    reasonStr ||
    (isEnabled ? 'Admin takeover' : 'Admin resumed AI');

  db.takeovers[id] = {
    isPaused: isEnabled,
    reason,
    timestamp: new Date().toISOString()
  };

  if (!db.customers[id]) {
    db.customers[id] = {
      id,
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

  console.log(
    `[Takeover] ${id}: ${isEnabled ? 'PAUSED' : 'ACTIVE'} (${reason})`
  );

  return isEnabled;
}

// =============================================================================
// 7. MESSENGER SEND API
// =============================================================================
async function sendFacebookMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn('[Messenger] PAGE_ACCESS_TOKEN is missing');
    return false;
  }

  try {
    const url =
      `https://graph.facebook.com/v18.0/me/messages` +
      `?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;

    const payload = {
      recipient: { id: recipientId },
      message: { text: String(text).slice(0, 2000) },
      messaging_type: 'RESPONSE'
    };

    const response = await axios.post(url, payload, {
      timeout: 15000
    });

    console.log(
      `[Messenger] Text sent to ${recipientId}; message_id=${response.data?.message_id || 'accepted'}`
    );

    appendHistory(recipientId, 'assistant', text);

    db.messages.push({
      id: 'msg_bot_' + Date.now(),
      senderId: recipientId,
      sender: 'bot',
      text,
      timestamp: new Date().toISOString()
    });

    saveStorage();
    return true;
  } catch (err) {
    console.error(
      '[Messenger] Send error:',
      err.response?.data?.error?.message || err.message
    );

    return false;
  }
}

// =============================================================================
// 8. GITHUB CATALOG SYNC (FULL AUTO-PURGE / NO STALE DATA)
// =============================================================================
/**
 * এই সেকশনটি অ্যাডমিন অ্যাপ থেকে পাঠানো ক্যাটালগ GitHub-এ সিঙ্ক করে এবং
 * পুরনো প্রোডাক্ট সম্পূর্ণভাবে মুছে ফেলে যাতে Render API-তে কোনো স্টেল
 * (পুরনো) ডেটা না থাকে।
 *
 * গুরুত্বপূর্ণ:
 * - শুধুমাত্র products + faqs রিপ্লেস হয়। customers/messages/orders অক্ষত থাকে।
 * - লোকাল catalog.json সবসময় সর্বশেষ সোর্স অফ ট্রুথ হিসেবে রিপ্লেস হয়।
 * - GitHub-এ প্রোডাক্ট ডিলিট করলে লোকাল ক্যাটালগ থেকেও সাথে সাথে বাদ পড়ে।
 * - পুরনো ডেটা রয়ে যাওয়ার কোনো সুযোগ নেই কারণ saveLocalCatalog() পুরো
 *   ফাইলটি ওভাররাইট করে (temp file → rename, atomic)।
 */

/**
 * একটি ক্যাটালগ অবজেক্টকে ভ্যালিডেট করে।
 * ভুল ডেটা দিয়ে চলমান ক্যাটালগ নষ্ট হতে দেবে না।
 */
function validateCatalogShape(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Catalog must be a JSON object');
  }

  if (!Array.isArray(data.products)) {
    throw new Error('Catalog must contain a "products" array');
  }

  const seenIds = new Set();

  for (const product of data.products) {
    if (!product || typeof product !== 'object') {
      throw new Error('Each product must be an object');
    }

    const id = String(product.id ?? '').trim();

    if (!id) {
      throw new Error('Every product must have a non-empty "id"');
    }

    if (seenIds.has(id)) {
      throw new Error(`Duplicate product id detected: ${id}`);
    }

    seenIds.add(id);
  }

  if (data.faqs !== undefined && !Array.isArray(data.faqs)) {
    throw new Error('Catalog "faqs" must be an array when provided');
  }

  return true;
}

/**
 * পুরনো ক্যাটালগ ফাইল ও মেমোরি থেকে সম্পূর্ণভাবে মুছে নতুন ক্যাটালগ বসায়।
 * এটিই একমাত্র পথ যার মাধ্যমে products/faqs আপডেট হয়।
 */
function replaceCatalogAtomically(catalogData, source = 'admin') {
  validateCatalogShape(catalogData);

  const normalized = {
    version: catalogData.version ?? Date.now(),
    updatedAt: catalogData.updatedAt ?? new Date().toISOString(),
    products: catalogData.products, // ← নতুন পুরো লিস্ট (পুরনো কিছু থাকবে না)
    faqs: Array.isArray(catalogData.faqs) ? catalogData.faqs : []
  };

  // saveLocalCatalog() আগেই validate করে, temp file লিখে atomic rename করে
  saveLocalCatalog(normalized, source);

  // মেমোরি ও লোকাল ফাইল থেকে নিশ্চিতভাবে পুরনো রেফারেন্স বাদ
  products = normalized.products;
  faqs = normalized.faqs;

  console.log(
    `[CATALOG] Replaced from ${source}: ${products.length} products, ${faqs.length} FAQs, version=${normalized.version}`
  );

  return normalized;
}

/**
 * GitHub থেকে সর্বশেষ ক্যাটালগ টেনে আনে এবং লোকাল + মেমোরি সম্পূর্ণ রিপ্লেস করে।
 * পুরনো ডেটা অটোমেটিক্যালি মুছে যায়।
 */
async function pullCatalogFromGitHub() {
  if (!GITHUB_TOKEN) {
    catalogMeta.lastSyncError = 'GITHUB_TOKEN is not configured';
    console.warn('[GITHUB] Token missing; retaining local catalog');
    return false;
  }

  try {
    const url =
      `https://api.github.com/repos/${GITHUB_REPO}` +
      `/contents/${CATALOG_FILE}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Impotech-Admin-Server'
      },
      timeout: 15000
    });

    if (!response.data?.content) {
      throw new Error('GitHub response does not contain file content');
    }

    const parsed = JSON.parse(
      Buffer.from(response.data.content, 'base64').toString('utf8')
    );

    // ভুল ডেটা দিয়ে চলমান ক্যাটালগ নষ্ট করবে না
    validateCatalogShape(parsed);

    // পুরনো প্রোডাক্ট মুছে নতুন ক্যাটালগ বসাও (atomic + memory replace)
    replaceCatalogAtomically(parsed, 'github');

    console.log(
      `[GITHUB] Pulled & purged old catalog. Now: ${products.length} products, ${faqs.length} FAQs, version=${catalogMeta.version}`
    );

    return true;
  } catch (err) {
    catalogMeta.lastSyncError =
      err.response?.data?.message || err.message;

    console.error(
      '[GITHUB] Catalog sync failed:',
      catalogMeta.lastSyncError
    );

    return false;
  }
}

/**
 * অ্যাডমিন অ্যাপ থেকে পাঠানো ক্যাটালগ GitHub-এ পুশ করে এবং লোকাল +
 * মেমোরি সম্পূর্ণ রিপ্লেস করে। ফলে Render API-তে পুরনো ডেটা থাকবে না।
 *
 * রিটার্ন: { synced, commit?, error?, totalProducts, totalFaqs }
 */
async function pushCatalogToGitHub(
  catalogData,
  customToken,
  customRepo,
  customBranch,
  customPath
) {
  const token = customToken || GITHUB_TOKEN;
  const repo = customRepo || GITHUB_REPO;
  const branch = customBranch || GITHUB_BRANCH;
  const filePath = customPath || CATALOG_FILE;

  if (!token) {
    return {
      synced: false,
      message: 'GitHub Token is not configured'
    };
  }

  // পুশ করার আগেই ভ্যালিডেট
  try {
    validateCatalogShape(catalogData);
  } catch (err) {
    return { synced: false, error: err.message };
  }

  const url = `https://api.github.com/repos/${repo}/contents/${filePath}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Impotech-Admin-Server'
  };

  // আগের sha বের করা (থাকলে)
  let sha = null;

  try {
    const getResponse = await axios.get(
      `${url}?ref=${encodeURIComponent(branch)}`,
      { headers, timeout: 10000 }
    );

    sha = getResponse.data?.sha || null;
  } catch (err) {
    if (err.response?.status !== 404) {
      return {
        synced: false,
        error: err.response?.data?.message || err.message
      };
    }
  }

  // পুরনো ফাইল পুরোপুরি ওভাররাইট হবে (replace, merge নয়)
  const fileContentBase64 = Buffer
    .from(JSON.stringify(catalogData, null, 2), 'utf8')
    .toString('base64');

  const payload = {
    message: `Replace catalog (purge old) from Impotech Admin v${catalogData.version || Date.now()}`,
    content: fileContentBase64,
    branch
  };

  if (sha) payload.sha = sha;

  try {
    const putResponse = await axios.put(url, payload, {
      headers,
      timeout: 20000
    });

    // সফল পুশ → লোকাল + মেমোরি সম্পূর্ণ রিপ্লেস (পুরনো ডেটা বাদ)
    replaceCatalogAtomically(catalogData, 'github');

    console.log(
      `[GITHUB] Pushed & purged old catalog to ${repo}@${branch}. Now: ${products.length} products, ${faqs.length} FAQs`
    );

    return {
      synced: true,
      commit: putResponse.data?.commit?.sha || 'synced',
      totalProducts: products.length,
      totalFaqs: faqs.length
    };
  } catch (err) {
    const error = err.response?.data?.message || err.message;

    console.error('[GITHUB] Upload failed:', error);

    return { synced: false, error };
  }
}

// =============================================================================
// 9. AI SYSTEM PROMPT
// =============================================================================
function buildSystemPrompt(relevantProducts, relevantFaqs, history) {
  const productContext = relevantProducts.length
    ? relevantProducts.map((p, i) => {
        const imageUrls = getProductMediaUrls(p, 'images');
        const videoUrls = getProductMediaUrls(p, 'videos');

        return [
          `[পণ্য ${i + 1}]`,
          `ID: ${p.id || 'N/A'}`,
          `নাম: ${p.name || 'N/A'}`,
          `মূল্য: ৳${p.price ?? 'N/A'}`,
          `স্টক: ${p.stockStatus || (p.inStock ? 'IN_STOCK' : 'N/A')}`,
          `বিবরণ: ${p.shortDescription || p.description || 'N/A'}`,
          `ছবির লিংক: ${imageUrls.join(' | ') || 'ক্যাটালগে নেই'}`,
          `ভিডিওর লিংক: ${videoUrls.join(' | ') || 'ক্যাটালগে নেই'}`
        ].join('\n');
      }).join('\n\n')
    : 'ক্যাটালগে কোনো পণ্য মেলেনি।';

  const faqContext = relevantFaqs.length
    ? relevantFaqs.map((f, i) =>
        `[FAQ ${i + 1}] প্রশ্ন: ${f.question || ''}\nউত্তর: ${f.answer || ''}`
      ).join('\n\n')
    : 'কোনো নির্দিষ্ট FAQ মেলেনি।';

  const historyContext = history.length
    ? history.map(item =>
        `${item.role === 'assistant' ? 'বট' : 'গ্রাহক'}: ${item.text}`
      ).join('\n')
    : 'পূর্বের কোনো কথোপকথন নেই।';

  return `
আপনি ImpoTech BD (ইম্পোটেক বিডি) ফেসবুক পেজের অফিসিয়াল AI সাপোর্ট অ্যাসিস্ট্যান্ট।
ঠিকানা: ভাওয়াল গড়, ভবানীপুর, জয়দেবপুর, গাজীপুর।
হেল্পলাইন: 01884332067।
ডেলিভারি চার্জ: গাজীপুরের ভেতরে ৫০ টাকা, বাইরে ১০০ টাকা।
পেমেন্ট: Cash on Delivery; ক্যাটালগ অনুযায়ী অগ্রিম প্রয়োজন নেই।

কঠোর নিয়ম:
১. ক্যাটালগ ও FAQ-এর তথ্যের ওপর ভিত্তি করে সংক্ষিপ্ত ও বিনম্র বাংলায় উত্তর দিন।
২. দাম, স্টক, ওয়ারেন্টি বা বৈশিষ্ট্য বানিয়ে বলবেন না।
৩. গ্রাহক ছবি বা ভিডিও চাইলে শুধু অনুমান করে URL তৈরি করবেন না।
৪. ক্যাটালগে থাকা মিডিয়া লিংকই ব্যবহার করতে হবে।
৫. মিডিয়া লিংক না থাকলে তা স্পষ্ট করে বলুন।
৬. এক পণ্যের ছবি বা ভিডিও অন্য পণ্যের জন্য দেবেন না।
৭. গ্রাহকের ছবি বা ভয়েস মেসেজ এলে সেটি বুঝে উত্তর দিন।
৮. তথ্য না থাকলে প্রতিনিধির সাহায্য নিতে বলুন।

প্রাসঙ্গিক পণ্য:
${productContext}

FAQ:
${faqContext}

পূর্ববর্তী কথোপকথন:
${historyContext}
`.trim();
}

// =============================================================================
// 10. OPENROUTER
// =============================================================================
async function callOpenRouter(messages, model = TEXT_MODEL) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  console.log(`[OPENROUTER] Request -> ${model}`);

  const response = await axios.post(
    OPENROUTER_URL,
    {
      model,
      messages,
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

  let reply = response.data?.choices?.[0]?.message?.content;

  if (Array.isArray(reply)) {
    reply = reply.map(item => item?.text || '').join('');
  }

  return String(reply || '').trim();
}

// =============================================================================
// 11. TEXT, VISION AND VOICE PROCESSOR
// =============================================================================
async function generateAIResponse(customerText, attachments = [], senderId) {
  const query = customerText || 'পণ্য সম্পর্কে তথ্য দিন';

  const relevantProducts = findRelevantProducts(query);
  const relevantFaqs = findRelevantFaqs(query);
  const history = getHistory(senderId);

  const systemPrompt = buildSystemPrompt(
    relevantProducts,
    relevantFaqs,
    history
  );

  // Voice messages
  const audioAttachment = attachments.find(
    item => item.type === 'audio' && item.payload?.url
  );

  if (audioAttachment) {
    try {
      console.log('[VOICE] Downloading audio');

      const audioResponse = await axios.get(
        audioAttachment.payload.url,
        {
          responseType: 'arraybuffer',
          timeout: 15000,
          maxContentLength: MAX_ATTACHMENT_BYTES
        }
      );

      const audioBase64 = Buffer
        .from(audioResponse.data)
        .toString('base64');

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map(item => ({
          role: item.role === 'assistant' ? 'assistant' : 'user',
          content: item.text
        })),
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'গ্রাহকের ভয়েস শুনে বাংলায় উত্তর দিন।'
            },
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
    } catch (err) {
      console.warn('[VOICE] Processing failed:', err.message);
    }
  }

  // Image messages sent by customers
  const imageAttachment = attachments.find(
    item => item.type === 'image' && item.payload?.url
  );

  if (imageAttachment) {
    try {
      console.log('[VISION] Downloading image');

      const imageResponse = await axios.get(
        imageAttachment.payload.url,
        {
          responseType: 'arraybuffer',
          timeout: 15000,
          maxContentLength: MAX_ATTACHMENT_BYTES
        }
      );

      const imageBase64 = Buffer
        .from(imageResponse.data)
        .toString('base64');

      const contentType =
        imageResponse.headers['content-type'] || 'image/jpeg';

      const dataUrl =
        `data:${contentType};base64,${imageBase64}`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map(item => ({
          role: item.role === 'assistant' ? 'assistant' : 'user',
          content: item.text
        })),
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: query
                ? `${query}\nএই ছবিটি দেখে ক্যাটালগের সঙ্গে মিলিয়ে উত্তর দিন।`
                : 'ছবিটি দেখে পণ্য শনাক্ত করে ক্যাটালগ অনুযায়ী উত্তর দিন।'
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl }
            }
          ]
        }
      ];

      return await callOpenRouter(messages, TEXT_MODEL);
    } catch (err) {
      console.warn('[VISION] Processing failed:', err.message);
    }
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(item => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: item.text
    })),
    { role: 'user', content: query }
  ];

  return await callOpenRouter(messages, TEXT_MODEL);
}

// =============================================================================
// 12. FACEBOOK WEBHOOK
// =============================================================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Webhook] Verification successful');
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  // Acknowledge Meta promptly; process the event afterward.
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;

    if (body.object !== 'page') return;

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const senderId = event.sender?.id;
        const message = event.message;
        const messageId = message?.mid;

        if (!message || message.is_echo || !senderId) continue;

        if (messageId && processedMessageIds.has(messageId)) continue;

        if (messageId) {
          processedMessageIds.add(messageId);

          setTimeout(() => {
            processedMessageIds.delete(messageId);
          }, 300000);
        }

        const text = message.text || '';
        const attachments = message.attachments || [];
        const isPaused = getTakeoverState(senderId);

        appendHistory(senderId, 'user', text || '[Media File]');

        db.messages.push({
          id: 'msg_' + Date.now(),
          senderId,
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
            isPaused,
            takeover: isPaused,
            lastMessageText: text || '[Media]'
          };
        } else {
          db.customers[senderId].messageCount =
            (db.customers[senderId].messageCount || 0) + 1;

          db.customers[senderId].lastActive =
            new Date().toISOString();

          db.customers[senderId].lastMessageText =
            text || '[Media]';
        }

        saveStorage();

        if (isPaused) {
          console.log(
            `[Takeover] ${senderId} is paused; bot will not respond`
          );
          continue;
        }

        console.log(
          `[AI Response] Processing ${senderId}: "${text}"`
        );

        try {
          // MEDIA REQUESTS ARE HANDLED BEFORE AI TEXT GENERATION.
          if (isMediaRequest(text)) {
            const mediaReply = getProductMediaReply(text, senderId);

            if (mediaReply) {
              await sendFacebookMessage(senderId, mediaReply);
              continue;
            }
          }

          const aiReply = await generateAIResponse(
            text,
            attachments,
            senderId
          );

          if (aiReply) {
            await sendFacebookMessage(senderId, aiReply);
          }
        } catch (err) {
          console.error('[AI] Response error:', err.message);

          await sendFacebookMessage(
            senderId,
            'ধন্যবাদ আপনার মেসেজের জন্য! বিস্তারিত জানতে আমাদের কল করুন: 01884332067'
          );
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Processing error:', err.message);
  }
});

// =============================================================================
// 13. CATALOG API
// =============================================================================
app.get('/api/catalog', (req, res) => {
  const catalog = loadLocalCatalog();

  res.json({
    success: true,
    catalog,
    products: catalog.products || [],
    faqs: catalog.faqs || [],
    meta: catalogMeta
  });
});

app.post('/api/catalog/sync', async (req, res) => {
  try {
    const catalogData = req.body;

    saveLocalCatalog(catalogData, 'admin');

    let githubResult = { synced: false };

    if (GITHUB_TOKEN) {
      githubResult = await pushCatalogToGitHub(catalogData);
    }

    res.json({
      success: true,
      message: `Catalog sync processed: ${products.length} products, ${faqs.length} FAQs`,
      totalProducts: products.length,
      totalFaqs: faqs.length,
      githubSynced: githubResult.synced,
      githubError: githubResult.error || null,
      meta: catalogMeta
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err.message
    });
  }
});

app.post('/api/github/upload', async (req, res) => {
  try {
    const {
      catalog: catalogPayload,
      githubRepo,
      githubBranch,
      githubToken,
      githubFilePath
    } = req.body;

    const targetCatalog = catalogPayload || loadLocalCatalog();

    const result = await pushCatalogToGitHub(
      targetCatalog,
      githubToken || GITHUB_TOKEN,
      githubRepo || GITHUB_REPO,
      githubBranch || GITHUB_BRANCH,
      githubFilePath || CATALOG_FILE
    );

    if (!result.synced) {
      return res.status(400).json({
        success: false,
        message: `GitHub upload failed: ${result.error || result.message}`
      });
    }

    res.json({
      success: true,
      message: `Catalog uploaded to ${githubRepo || GITHUB_REPO}@${githubBranch || GITHUB_BRANCH}`,
      totalProducts: products.length,
      totalFaqs: faqs.length,
      commit: result.commit
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err.message
    });
  }
});

// Pull the latest catalog on demand.
app.post('/api/catalog/refresh', async (req, res) => {
  const synced = await pullCatalogFromGitHub();

  res.status(synced ? 200 : 503).json({
    success: synced,
    totalProducts: products.length,
    totalFaqs: faqs.length,
    meta: catalogMeta
  });
});

// =============================================================================
// 14. BOT STATUS AND ADMIN CONTROL
// =============================================================================
app.get('/api/bot-status', (req, res) => {
  res.json({
    success: true,
    isGlobalPaused: !!db.isGlobalPaused,
    reason: db.isGlobalPaused
      ? 'Human takeover active'
      : 'AI bot active',
    totalPausedCustomers: Object.values(db.takeovers)
      .filter(item => item.isPaused).length
  });
});

app.post('/api/toggle-bot', (req, res) => {
  db.isGlobalPaused = !!req.body.isPaused;

  saveStorage();

  console.log(
    `[Master Switch] ${db.isGlobalPaused ? 'PAUSED' : 'ACTIVE'}`
  );

  res.json({
    success: true,
    isGlobalPaused: db.isGlobalPaused
  });
});

app.post('/api/customers/:senderId/takeover', async (req, res) => {
  const { senderId } = req.params;

  const isPaused =
    req.body.isPaused !== undefined
      ? !!req.body.isPaused
      : req.body.takeover !== undefined
        ? !!req.body.takeover
        : true;

  await setTakeoverState(senderId, isPaused, req.body.reason);

  res.json({
    success: true,
    senderId,
    isPaused,
    takeover: isPaused
  });
});

app.get('/api/customers/:senderId/status', (req, res) => {
  const { senderId } = req.params;
  const isPaused = getTakeoverState(senderId);

  res.json({
    success: true,
    senderId,
    isPaused,
    takeover: isPaused
  });
});

app.get('/api/customers', (req, res) => {
  const list = Object.values(db.customers).map(customer => ({
    senderId: customer.id,
    displayName:
      customer.name || `Customer ${customer.id.slice(-4)}`,
    phone: customer.phone || null,
    lastMessageText: customer.lastMessageText || null,
    lastMessageAt: customer.lastActive || null,
    takeover: getTakeoverState(customer.id),
    isPaused: getTakeoverState(customer.id)
  }));

  res.json({ success: true, data: list });
});

app.post('/api/customers/:senderId/send', async (req, res) => {
  const { senderId } = req.params;
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Text required' });
  }

  const sent = await sendFacebookMessage(senderId, text);

  if (sent) {
    return res.json({
      success: true,
      message: 'Message sent'
    });
  }

  res.status(500).json({
    success: false,
    message: 'Message sending failed'
  });
});

// =============================================================================
// 15. HEALTH AND DIAGNOSTIC ENDPOINTS
// =============================================================================
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok'
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'LIVE_PRODUCTION',
    isGlobalPaused: !!db.isGlobalPaused
  });
});

// Newly added /api/status endpoint.
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    status: 'LIVE_PRODUCTION',
    catalogProducts: products.length,
    catalogFaqs: faqs.length,
    catalogFile: CATALOG_FILE,
    githubRepo: GITHUB_REPO,
    githubBranch: GITHUB_BRANCH,
    catalogMeta,
    globalBotPaused: !!db.isGlobalPaused,
    timestamp: new Date().toISOString()
  });
});

// Diagnostic view of media availability, without exposing access tokens.
app.get('/api/catalog/media-status', (req, res) => {
  res.json({
    success: true,
    products: products.map(product => ({
      id: product.id,
      name: product.name,
      images: getProductMediaUrls(product, 'images').length,
      videos: getProductMediaUrls(product, 'videos').length
    }))
  });
});

// =============================================================================
// 16. START SERVER AFTER INITIAL CATALOG SYNC
// =============================================================================
async function startServer() {
  // Keep the local catalog available if GitHub is unavailable.
  // But wait for the initial attempt before accepting traffic.
  await pullCatalogFromGitHub();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[SERVER] ImpoTech Master Bot running on port ${PORT}`
    );

    console.log(
      `[CATALOG] ${products.length} products, ${faqs.length} FAQs; source=${catalogMeta.source}`
    );

    if (catalogMeta.lastSyncError) {
      console.warn(
        `[CATALOG] Latest GitHub sync warning: ${catalogMeta.lastSyncError}`
      );
    }
  });
}

startServer().catch(err => {
  console.error('[SERVER] Startup error:', err.message);
  process.exit(1);
});
