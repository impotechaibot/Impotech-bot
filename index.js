'use strict';

/**
 * =============================================================================
 * IMPOTECH AI MESSENGER BOT & ADMIN BACKEND
 * =============================================================================
 * AI          : OpenRouter Gemini
 * CATALOG     : GitHub catalog.json + Local cache
 * STORAGE     : storage_data.json
 * MEDIA       : Product-specific Facebook URLs
 * HUMAN       : Per-customer + Global takeover
 * ADMIN       : Catalog, customers, messages, orders, bot status
 *
 * SAFETY:
 * - Never guess a product price.
 * - Verify exact product identity before quoting a price.
 * - Never guess motorcycle H4 compatibility.
 * - Reject truncated AI responses.
 * - Never silently truncate Messenger messages.
 * - Configure secrets through Render environment variables.
 * =============================================================================
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

app.disable('x-powered-by');
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

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

// =============================================================================
// 2. CONFIGURATION
// =============================================================================

const PORT = Number(process.env.PORT) || 10000;

const PAGE_ACCESS_TOKEN =
  process.env.PAGE_ACCESS_TOKEN ||
  process.env.META_ACCESS_TOKEN ||
  '';

const VERIFY_TOKEN =
  process.env.VERIFY_TOKEN || '';

const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY || '';

const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN || '';

const GITHUB_REPO =
  process.env.GITHUB_REPO || 'impotechaibot/Impotech-bot';

const GITHUB_BRANCH =
  process.env.GITHUB_BRANCH || 'main';

const CATALOG_FILE =
  process.env.CATALOG_FILE || 'data/catalog.json';

const ADMIN_SECRET =
  process.env.ADMIN_SECRET || '';

const OPENROUTER_URL =
  'https://openrouter.ai/api/v1/chat/completions';

const TEXT_MODEL =
  process.env.TEXT_MODEL || 'google/gemini-3.1-flash-lite';

const VOICE_MODEL =
  process.env.VOICE_MODEL || TEXT_MODEL;

const MAX_PRODUCTS_TO_AI = 5;
const MAX_FAQS_TO_AI = 5;
const MAX_OUTPUT_TOKENS = 700;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_MESSENGER_TEXT_LENGTH = 2000;

const LOCAL_CATALOG_PATH =
  path.join(__dirname, 'catalog.json');

const DATA_FILE =
  path.join(__dirname, 'storage_data.json');

const GRAPH_API_VERSION =
  process.env.GRAPH_API_VERSION || 'v18.0';

const REQUIRE_ADMIN_SECRET =
  process.env.REQUIRE_ADMIN_SECRET !== 'false';

const HISTORY_LIMIT = 10;

// =============================================================================
// 3. MEMORY AND STORAGE
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
const processedMessageIds = new Map();
const pendingBikeQuestions = new Map();

function loadStorage() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;

    const saved = JSON.parse(
      fs.readFileSync(DATA_FILE, 'utf8')
    );

    db = {
      isGlobalPaused: false,
      takeovers: {},
      customers: {},
      messages: [],
      orders: [],
      ...saved
    };

    if (!db.takeovers || typeof db.takeovers !== 'object') {
      db.takeovers = {};
    }

    if (!db.customers || typeof db.customers !== 'object') {
      db.customers = {};
    }

    if (!Array.isArray(db.messages)) db.messages = [];
    if (!Array.isArray(db.orders)) db.orders = [];
  } catch (err) {
    console.error('[STORAGE] Load error:', err.message);
  }
}

function saveStorage() {
  try {
    const tempPath = DATA_FILE + '.tmp';

    fs.writeFileSync(
      tempPath,
      JSON.stringify(db, null, 2),
      'utf8'
    );

    fs.renameSync(tempPath, DATA_FILE);
  } catch (err) {
    console.error('[STORAGE] Save error:', err.message);
  }
}

function applyCatalog(data, source = 'local') {
  validateCatalogShape(data);

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
    console.error('[CATALOG] Local load error:', err.message);

    return {
      products,
      faqs,
      version: catalogMeta.version,
      updatedAt: catalogMeta.updatedAt
    };
  }
}

function saveLocalCatalog(data, source = 'local') {
  validateCatalogShape(data);

  const tempPath = LOCAL_CATALOG_PATH + '.tmp';

  fs.writeFileSync(
    tempPath,
    JSON.stringify(data, null, 2),
    'utf8'
  );

  fs.renameSync(tempPath, LOCAL_CATALOG_PATH);
  applyCatalog(data, source);
}

loadStorage();
loadLocalCatalog();

// =============================================================================
// 4. ADMIN AUTHENTICATION
// =============================================================================

function requireAdmin(req, res, next) {
  if (!REQUIRE_ADMIN_SECRET) return next();

  if (!ADMIN_SECRET) {
    return res.status(503).json({
      success: false,
      message: 'ADMIN_SECRET is not configured'
    });
  }

  const supplied = String(
    req.get('x-admin-secret') ||
    req.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    ''
  );

  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_SECRET);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
  }

  next();
}

// Protect administrative routes.
// Public health endpoints and the Facebook webhook remain accessible.
app.use('/api', (req, res, next) => {
  const publicPaths = [
    '/health',
    '/status'
  ];

  if (publicPaths.includes(req.path)) return next();

  return requireAdmin(req, res, next);
});

// =============================================================================
// 5. CATALOG VALIDATION AND SEARCH
// =============================================================================

function validateCatalogShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Catalog must be a JSON object');
  }

  if (!Array.isArray(data.products)) {
    throw new Error('Catalog must contain a products array');
  }

  const ids = new Set();

  for (const product of data.products) {
    if (!product || typeof product !== 'object') {
      throw new Error('Every product must be an object');
    }

    const id = String(product.id ?? '').trim();

    if (!id) {
      throw new Error('Every product must have an ID');
    }

    if (ids.has(id)) {
      throw new Error('Duplicate product ID: ' + id);
    }

    ids.add(id);
  }

  if (data.faqs !== undefined && !Array.isArray(data.faqs)) {
    throw new Error('Catalog FAQs must be an array');
  }

  return true;
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

function scoreRecord(query, record, fields) {
  const q = normalizeText(query);
  const tokens = tokenize(q);

  if (!tokens.length) return 0;

  let score = 0;

  for (const field of fields) {
    const raw = record?.[field];

    const value = normalizeText(
      Array.isArray(raw) ? raw.join(' ') : raw || ''
    );

    if (!value) continue;

    if (q.length >= 4 && value === q) score += 50;
    else if (q.length >= 4 && value.includes(q)) score += 20;

    for (const token of tokens) {
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
    'tags',
    'aliases'
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

  while (history.length > HISTORY_LIMIT) {
    history.shift();
  }

  customerHistory.set(id, history);
}

// =============================================================================
// 6. PRICE GUARD
// =============================================================================

function isPriceQuestion(text = '') {
  const value = normalizeText(text);

  return (
    /\b(price|prices|cost|how much|rate)\b/.test(value) ||
    /দাম|প্রাইস|মূল্য|কত টাকা|কত দাম|দাম কত|দামটা|কততে/.test(value)
  );
}

function isGenericPriceQuestion(text = '') {
  if (!isPriceQuestion(text)) return false;

  const value = normalizeText(text);

  const generic = [
    /^দাম$/,
    /^দাম কত$/,
    /^দামটা কত$/,
    /^প্রাইস$/,
    /^প্রাইস কত$/,
    /^মূল্য$/,
    /^মূল্য কত$/,
    /^কত টাকা$/,
    /^কত দাম$/,
    /^price$/,
    /^price please$/,
    /^how much$/,
    /^how much is it$/,
    /^what is the price$/
  ];

  return generic.some(pattern => pattern.test(value));
}

function findExactProductForPrice(query) {
  const q = normalizeText(query);

  if (!q) return null;

  const matches = products.filter(product => {
    const candidates = [
      product.name,
      product.id,
      product.sku,
      product.model,
      product.brand,
      ...(Array.isArray(product.aliases) ? product.aliases : [])
    ]
      .filter(Boolean)
      .map(normalizeText);

    return candidates.some(candidate => {
      if (!candidate) return false;

      // Require the complete product name/alias to be present.
      return q.includes(candidate);
    });
  });

  // Ambiguous queries must not select the first result.
  if (matches.length !== 1) return null;

  return matches[0];
}

function getPriceReply(product) {
  if (
    product.price === undefined ||
    product.price === null ||
    String(product.price).trim() === ''
  ) {
    return `দুঃখিত, ${product.name} পণ্যের মূল্য বর্তমানে ক্যাটালগে উল্লেখ নেই। সঠিক দাম জানতে আমাদের প্রতিনিধির সঙ্গে যোগাযোগ করুন।`;
  }

  return `${product.name}-এর দাম ${product.price} টাকা।`;
}

function getPriceClarificationReply() {
  return 'আপনি কোন পণ্যটির দাম জানতে চাচ্ছেন? পণ্যের সঠিক নাম বা মডেলটি বললে ক্যাটালগ থেকে দাম জানাতে পারব।';
}

// =============================================================================
// 7. MOTORCYCLE H4 COMPATIBILITY
// =============================================================================

function isBikeCompatibilityQuestion(text = '') {
  const value = normalizeText(text);

  return (
    /h4|devil eye|হেডলাইট|headlight|head lamp|plug and play|প্লাগ অ্যান্ড প্লে/.test(value) &&
    /বাইক|মোটরসাইকেল|motorcycle|bike|হবে|ফিট|fit|সাপোর্ট|support|socket|plug|সকেট|বাল্ব|bulb/.test(value)
  );
}

function hasBikeIdentity(text = '') {
  const value = normalizeText(text);

  return (
    /\b(honda|yamaha|suzuki|bajaj|tvs|hero|ktm|apache|pulsar|fz|r15|gixxer|hornet|fzs|mt-15|discover|platina|gixxer|gsx)\b/i.test(value) ||
    /হোন্ডা|ইয়ামাহা|ইয়ামাহা|সুজুকি|বাজাজ|টিভিএস|হিরো/.test(value)
  );
}

/**
 * Expected catalog format for a VERIFIED fitment entry:
 *
 * {
 *   "brand": "Yamaha",
 *   "model": "FZ-S V3",
 *   "originalH4Socket": true,
 *   "verified": true,
 *   "source": "Official service manual URL"
 * }
 *
 * Put entries in catalog.json:
 * {
 *   "bikeCompatibility": [ ... ]
 * }
 *
 * Unknown or unverified entries are never treated as confirmation.
 */

function getBikeCompatibilityEntries() {
  const entries = [];

  for (const entry of products) {
    if (Array.isArray(entry.bikeCompatibility)) {
      entries.push(...entry.bikeCompatibility);
    }

    if (
      entry.bikeCompatibility &&
      !Array.isArray(entry.bikeCompatibility)
    ) {
      entries.push(entry.bikeCompatibility);
    }
  }

  for (const faq of faqs) {
    if (Array.isArray(faq.bikeCompatibility)) {
      entries.push(...faq.bikeCompatibility);
    }
  }

  return entries;
}

function identifyBikeModel(text = '') {
  const value = normalizeText(text);

  const entries = getBikeCompatibilityEntries();

  const matches = entries
    .filter(entry => entry && entry.verified === true)
    .map(entry => {
      const brand = normalizeText(entry.brand || '');
      const model = normalizeText(entry.model || '');
      const full = normalizeText(`${brand} ${model}`);

      return {
        entry,
        full,
        model,
        brand
      };
    })
    .filter(item => {
      return (
        item.full &&
        item.model &&
        value.includes(item.full)
      );
    })
    .sort((a, b) => b.full.length - a.full.length);

  if (!matches.length) return null;

  // Two equally specific entries must not be guessed.
  if (
    matches.length > 1 &&
    matches[0].full.length === matches[1].full.length &&
    matches[0].entry.originalH4Socket !==
      matches[1].entry.originalH4Socket
  ) {
    return null;
  }

  return matches[0];
}

function getH4CompatibilityReply(match) {
  const model = match?.entry
    ? `${match.entry.brand || ''} ${match.entry.model || ''}`.trim()
    : '';

  if (!match || !model) {
    return 'আপনার বাইকের ব্র্যান্ড ও নির্দিষ্ট মডেলটি জানাবেন?';
  }

  const entry = match.entry;

  // Only a verified, explicitly boolean value is accepted.
  if (
    entry.verified !== true ||
    typeof entry.originalH4Socket !== 'boolean' ||
    !entry.source
  ) {
    return `আপনার ${model}-এর Original Headlight-এ H4 Plug/Socket আছে কি না নিশ্চিতভাবে যাচাই করা যাচ্ছে না। বিস্তারিত জানতে আমাদের একজন এডমিন বা প্রতিনিধি খুব শীঘ্রই আপনার সাথে সরাসরি যোগাযোগ করবেন।`;
  }

  if (entry.originalH4Socket === true) {
    return `জি, আপনার ${model}-এর Original Headlight-এ H4 Plug/Socket ব্যবহার করা হয়েছে। তাই এই H4 Plug Devil Eye Headlight আপনার বাইকে Plug and Play হিসেবে ব্যবহার করা যাবে।`;
  }

  return `আপনার ${model}-এর Original Headlight-এ H4 Plug/Socket ব্যবহার করা হয়নি। তাই এই H4 Plug Devil Eye Headlight সরাসরি Plug and Play হিসেবে ব্যবহার করা যাবে না।`;
}

// =============================================================================
// 8. PRODUCT MEDIA
// =============================================================================

function getMediaType(text = '') {
  const value = normalizeText(text);

  if (/ভিডিও|video|রিল|reel|clip/.test(value)) {
    return 'videos';
  }

  if (/ছবি|ফটো|পিকচার|ইমেজ|image|photo|picture/.test(value)) {
    return 'images';
  }

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
        parsed.hostname.endsWith('.facebook.com') ||
        parsed.hostname === 'fb.watch'
      )
    );
  } catch (_) {
    return false;
  }
}

function getProductMediaUrls(product, mediaType) {
  const media = product?.media;

  if (!media || !Array.isArray(media[mediaType])) return [];

  return media[mediaType].filter(
    url => typeof url === 'string' && isFacebookLink(url)
  );
}

function findProductForMedia(query, senderId) {
  const q = normalizeText(query);
  const history = getHistory(senderId);

  const candidates = products
    .map(product => ({
      product,
      score: productScore(q, product)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    const previousProductQuery = history
      .filter(item => item.role === 'user')
      .slice(-3)
      .map(item => item.text)
      .join(' ');

    if (!previousProductQuery) return null;

    const previous = products
      .map(product => ({
        product,
        score: productScore(previousProductQuery, product)
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (
      previous.length > 1 &&
      previous[0].score === previous[1].score
    ) {
      return null;
    }

    return previous[0]?.product || null;
  }

  if (
    candidates.length > 1 &&
    candidates[0].score === candidates[1].score
  ) {
    return null;
  }

  return candidates[0].product;
}

function getProductMediaReply(query, senderId) {
  const mediaType = getMediaType(query);

  if (!mediaType) return null;

  const product = findProductForMedia(query, senderId);

  if (!product) {
    return 'আপনি কোন পণ্যের ছবি বা ভিডিও দেখতে চান? পণ্যটির নাম বা মডেলটি বলুন।';
  }

  const urls = getProductMediaUrls(product, mediaType);

  if (!urls.length) {
    const label = mediaType === 'images' ? 'ছবির' : 'ভিডিওর';

    return `দুঃখিত, ${product.name} পণ্যের ${label} লিংক বর্তমানে ক্যাটালগে নেই। বিস্তারিত জানতে আমাদের প্রতিনিধির সঙ্গে যোগাযোগ করুন।`;
  }

  const label = mediaType === 'images' ? 'ছবি' : 'ভিডিও';

  return (
    `অবশ্যই! ${product.name} পণ্যের ${label} লিংক:\n\n` +
    urls.map((url, index) => `${index + 1}. ${url}`).join('\n') +
    '\n\nলিংকে চাপ দিয়ে দেখতে পারবেন।'
  );
}

// =============================================================================
// 9. HUMAN TAKEOVER
// =============================================================================

function getTakeoverState(customerId) {
  if (!customerId) return !!db.isGlobalPaused;

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

  db.takeovers[id] = {
    isPaused: isEnabled,
    reason: reasonStr || (
      isEnabled ? 'Admin takeover' : 'Admin resumed AI'
    ),
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
    `[Takeover] ${id}: ${isEnabled ? 'PAUSED' : 'ACTIVE'}`
  );

  return isEnabled;
}

// =============================================================================
// 10. MESSENGER SEND
// =============================================================================

async function sendFacebookMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('[Messenger] PAGE_ACCESS_TOKEN is missing');
    return false;
  }

  const finalText = String(text || '').trim();

  if (!finalText) return false;

  if (finalText.length > MAX_MESSENGER_TEXT_LENGTH) {
    console.error(
      `[Messenger] Message blocked: ${finalText.length} characters`
    );

    return false;
  }

  try {
    const url =
      `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages` +
      `?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;

    const response = await axios.post(
      url,
      {
        recipient: { id: recipientId },
        message: { text: finalText },
        messaging_type: 'RESPONSE'
      },
      { timeout: 15000 }
    );

    console.log(
      `[Messenger] Sent to ${recipientId}; ` +
      `message_id=${response.data?.message_id || 'accepted'}`
    );

    appendHistory(recipientId, 'assistant', finalText);

    db.messages.push({
      id: 'msg_bot_' + crypto.randomUUID(),
      senderId: recipientId,
      sender: 'bot',
      text: finalText,
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
// 11. GITHUB CATALOG SYNC
// =============================================================================

function replaceCatalogAtomically(catalogData, source = 'admin') {
  validateCatalogShape(catalogData);

  const normalized = {
    ...catalogData,
    version: catalogData.version ?? Date.now(),
    updatedAt: catalogData.updatedAt ?? new Date().toISOString(),
    products: catalogData.products,
    faqs: Array.isArray(catalogData.faqs) ? catalogData.faqs : []
  };

  saveLocalCatalog(normalized, source);

  console.log(
    `[CATALOG] Replaced from ${source}: ` +
    `${products.length} products, ${faqs.length} FAQs`
  );

  return normalized;
}

async function pullCatalogFromGitHub() {
  if (!GITHUB_TOKEN) {
    catalogMeta.lastSyncError = 'GITHUB_TOKEN is not configured';

    console.warn('[GITHUB] Token missing; local catalog retained');
    return false;
  }

  try {
    const url =
      `https://api.github.com/repos/${GITHUB_REPO}` +
      `/contents/${CATALOG_FILE}` +
      `?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Impotech-Admin-Server'
      },
      timeout: 15000
    });

    if (!response.data?.content) {
      throw new Error('GitHub response contains no file content');
    }

    const parsed = JSON.parse(
      Buffer.from(response.data.content, 'base64').toString('utf8')
    );

    validateCatalogShape(parsed);
    replaceCatalogAtomically(parsed, 'github');

    return true;
  } catch (err) {
    catalogMeta.lastSyncError =
      err.response?.data?.message || err.message;

    console.error('[GITHUB] Pull failed:', catalogMeta.lastSyncError);
    return false;
  }
}

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
    return { synced: false, message: 'GitHub Token is not configured' };
  }

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

  let sha = null;

  try {
    const existing = await axios.get(
      `${url}?ref=${encodeURIComponent(branch)}`,
      { headers, timeout: 10000 }
    );

    sha = existing.data?.sha || null;
  } catch (err) {
    if (err.response?.status !== 404) {
      return {
        synced: false,
        error: err.response?.data?.message || err.message
      };
    }
  }

  const payload = {
    message: `Update Impotech catalog ${catalogData.version || Date.now()}`,
    content: Buffer.from(
      JSON.stringify(catalogData, null, 2),
      'utf8'
    ).toString('base64'),
    branch
  };

  if (sha) payload.sha = sha;

  try {
    const result = await axios.put(url, payload, {
      headers,
      timeout: 20000
    });

    replaceCatalogAtomically(catalogData, 'github');

    return {
      synced: true,
      commit: result.data?.commit?.sha || 'synced',
      totalProducts: products.length,
      totalFaqs: faqs.length
    };
  } catch (err) {
    return {
      synced: false,
      error: err.response?.data?.message || err.message
    };
  }
}

// =============================================================================
// 12. AI SYSTEM PROMPT
// =============================================================================

function buildSystemPrompt(relevantProducts, relevantFaqs, history) {
  const productContext = relevantProducts.length
    ? relevantProducts.map((p, i) => [
        `[পণ্য ${i + 1}]`,
        `ID: ${p.id || 'N/A'}`,
        `নাম: ${p.name || 'N/A'}`,
        `ব্র্যান্ড: ${p.brand || 'N/A'}`,
        `মডেল: ${p.model || 'N/A'}`,
        `মূল্য: ${p.price ?? 'N/A'} টাকা`,
        `স্টক: ${p.stockStatus || (p.inStock ? 'IN_STOCK' : 'N/A')}`,
        `বিবরণ: ${p.shortDescription || p.description || 'N/A'}`,
        `ছবি: ${getProductMediaUrls(p, 'images').join(' | ') || 'নেই'}`,
        `ভিডিও: ${getProductMediaUrls(p, 'videos').join(' | ') || 'নেই'}`
      ].join('\n')).join('\n\n')
    : 'কোনো প্রাসঙ্গিক পণ্য পাওয়া যায়নি।';

  const faqContext = relevantFaqs.length
    ? relevantFaqs.map((f, i) =>
        `[FAQ ${i + 1}] ${f.question || ''}\n${f.answer || ''}`
      ).join('\n\n')
    : 'প্রাসঙ্গিক FAQ পাওয়া যায়নি।';

  const historyContext = history.length
    ? history.map(item =>
        `${item.role === 'assistant' ? 'বট' : 'গ্রাহক'}: ${item.text}`
      ).join('\n')
    : 'পূর্ববর্তী কথোপকথন নেই।';

  return `
আপনি ImpoTech BD ফেসবুক পেজের অফিসিয়াল AI সাপোর্ট অ্যাসিস্ট্যান্ট।

ব্যবসার তথ্য:
ঠিকানা: ভাওয়াল গড়, ভবানীপুর, জয়দেবপুর, গাজীপুর।
হেল্পলাইন: 01884332067।
ডেলিভারি: গাজীপুরের ভেতরে ৫০ টাকা, বাইরে ১০০ টাকা।
পেমেন্ট: Cash on Delivery; ক্যাটালগে অগ্রিম প্রয়োজন নেই বলা থাকলে তবেই সেটি নিশ্চিত করুন।

বাধ্যতামূলক নিয়ম:
১. সহজ, ভদ্র ও স্বাভাবিক বাংলায় সংক্ষিপ্ত উত্তর দিন।
২. গ্রাহকের সব প্রশ্নের উত্তর দিন, কিন্তু অনুমান করবেন না।
৩. পণ্যের ID, দাম, স্টক ও মিডিয়া URL পরিবর্তন করবেন না।
৪. ক্যাটালগে নেই এমন দাম, ওয়ারেন্টি বা বৈশিষ্ট্য তৈরি করবেন না।
৫. গ্রাহক শুধু দাম জানতে চাইলে প্রথমে পণ্যের নাম জানতে চান।
৬. পণ্য নিশ্চিত না হলে কোনো পণ্যের দাম বলবেন না।
৭. একাধিক পণ্য মিলে গেলে পণ্যের নাম বা মডেল পরিষ্কার করুন।
৮. নির্দিষ্ট পণ্য শনাক্ত হলে শুধু সেই পণ্যের মূল্য ব্যবহার করুন।
৯. ক্যাটালগে দাম না থাকলে স্পষ্টভাবে জানান।
১০. বাইকের Original Headlight-এর H4 Plug/Socket সম্পর্কে নিশ্চিত তথ্য ছাড়া Compatibility নিশ্চিত করবেন না।
১১. বাইকের নাম দেখে অনুমান করে H4 বলবেন না।
১২. H4 Compatibility-এর যাচাইকৃত তথ্য না থাকলে Admin/Representative-এর সহায়তা নিতে বলুন।
১৩. শুধু H4 Plug নিশ্চিত হলেই এই FAQ অনুযায়ী Plug and Play বলা যাবে।
১৪. অন্য Modification প্রয়োজন কি না তথ্য না থাকলে অনুমান করবেন না।
১৫. ছবি ও ভিডিওর জন্য শুধু সংশ্লিষ্ট পণ্যের লিংক ব্যবহার করুন।
১৬. গ্রাহক সম্পূর্ণ বিবরণ চাইলে ক্যাটালগের গুরুত্বপূর্ণ তথ্য দিন।
১৭. অসম্পূর্ণ উত্তর, বানানো তথ্য ও অপ্রয়োজনীয় পুনরাবৃত্তি এড়িয়ে চলুন।

প্রাসঙ্গিক পণ্য:
${productContext}

প্রাসঙ্গিক FAQ:
${faqContext}

পূর্ববর্তী কথোপকথন:
${historyContext}
  `.trim();
}

// =============================================================================
// 13. OPENROUTER
// =============================================================================

async function callOpenRouter(messages, model = TEXT_MODEL) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const response = await axios.post(
    OPENROUTER_URL,
    {
      model,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2
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

  const choice = response.data?.choices?.[0];

  if (!choice) throw new Error('OpenRouter returned no response');

  let reply = choice.message?.content;

  if (Array.isArray(reply)) {
    reply = reply.map(item => item?.text || '').join('');
  }

  reply = String(reply || '').trim();

  if (!reply) throw new Error('OpenRouter returned an empty response');

  if (choice.finish_reason === 'length') {
    throw new Error('AI response was truncated');
  }

  return reply;
}

// =============================================================================
// 14. AI TEXT, VISION AND VOICE
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

  const audioAttachment = attachments.find(
    item => item.type === 'audio' && item.payload?.url
  );

  if (audioAttachment) {
    try {
      const audioResponse = await axios.get(
        audioAttachment.payload.url,
        {
          responseType: 'arraybuffer',
          timeout: 15000,
          maxContentLength: MAX_ATTACHMENT_BYTES
        }
      );

      const audioBase64 = Buffer.from(audioResponse.data).toString('base64');

      return await callOpenRouter([
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
              text: 'গ্রাহকের ভয়েস বুঝে বাংলায় সংক্ষিপ্ত ও সম্পূর্ণ উত্তর দিন।'
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
      ], VOICE_MODEL);
    } catch (err) {
      console.error('[VOICE] Processing failed:', err.message);
    }
  }

  const imageAttachment = attachments.find(
    item => item.type === 'image' && item.payload?.url
  );

  if (imageAttachment) {
    try {
      const imageResponse = await axios.get(
        imageAttachment.payload.url,
        {
          responseType: 'arraybuffer',
          timeout: 15000,
          maxContentLength: MAX_ATTACHMENT_BYTES
        }
      );

      const imageBase64 = Buffer.from(imageResponse.data).toString('base64');
      const contentType =
        imageResponse.headers['content-type'] || 'image/jpeg';

      return await callOpenRouter([
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
              text: `${query}\nছবিটি দেখে ক্যাটালগের সঙ্গে মিলিয়ে উত্তর দিন।`
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${contentType};base64,${imageBase64}`
              }
            }
          ]
        }
      ], TEXT_MODEL);
    } catch (err) {
      console.error('[VISION] Processing failed:', err.message);
    }
  }

  return callOpenRouter([
    { role: 'system', content: systemPrompt },
    ...history.map(item => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: item.text
    })),
    { role: 'user', content: query }
  ], TEXT_MODEL);
}

// =============================================================================
// 15. FACEBOOK WEBHOOK
// =============================================================================

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (
    mode === 'subscribe' &&
    VERIFY_TOKEN &&
    token === VERIFY_TOKEN
  ) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  // Acknowledge Meta immediately.
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

        if (
          messageId &&
          processedMessageIds.has(messageId)
        ) {
          continue;
        }

        if (messageId) {
          processedMessageIds.set(messageId, Date.now());
        }

        const text = String(message.text || '').trim();
        const attachments = message.attachments || [];

        const isPaused = getTakeoverState(senderId);

        appendHistory(
          senderId,
          'user',
          text || '[Media File]'
        );

        db.messages.push({
          id: 'msg_' + crypto.randomUUID(),
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
          const customer = db.customers[senderId];

          customer.messageCount = (customer.messageCount || 0) + 1;
          customer.lastActive = new Date().toISOString();
          customer.lastMessageText = text || '[Media]';
        }

        saveStorage();

        if (isPaused) {
          console.log(`[Takeover] ${senderId} paused`);
          continue;
        }

        try {
          // ---------------------------------------------------------------
          // 1. Bike compatibility guard
          // ---------------------------------------------------------------

          if (isBikeCompatibilityQuestion(text)) {
            const match = identifyBikeModel(text);

            if (!match) {
              pendingBikeQuestions.set(senderId, {
                timestamp: Date.now()
              });

              await sendFacebookMessage(
                senderId,
                'আপনার বাইকের ব্র্যান্ড ও নির্দিষ্ট মডেলটি জানাবেন? Original Headlight-এ H4 Plug/Socket আছে কি না যাচাই করে জানাব।'
              );

              continue;
            }

            await sendFacebookMessage(
              senderId,
              getH4CompatibilityReply(match)
            );

            continue;
          }

          // ---------------------------------------------------------------
          // 2. Price guard
          // ---------------------------------------------------------------

          if (isPriceQuestion(text)) {
            if (isGenericPriceQuestion(text)) {
              await sendFacebookMessage(
                senderId,
                getPriceClarificationReply()
              );

              continue;
            }

            const product = findExactProductForPrice(text);

            if (!product) {
              await sendFacebookMessage(
                senderId,
                'আপনি কোন পণ্যটির দাম জানতে চাচ্ছেন? পণ্যের সঠিক নাম বা মডেলটি বললে সঠিক মূল্য জানাতে পারব।'
              );

              continue;
            }

            await sendFacebookMessage(
              senderId,
              getPriceReply(product)
            );

            continue;
          }

          // ---------------------------------------------------------------
          // 3. Product-specific media
          // ---------------------------------------------------------------

          if (isMediaRequest(text)) {
            const mediaReply = getProductMediaReply(text, senderId);

            if (mediaReply) {
              await sendFacebookMessage(senderId, mediaReply);
              continue;
            }
          }

          // ---------------------------------------------------------------
          // 4. Normal AI
          // ---------------------------------------------------------------

          const aiReply = await generateAIResponse(
            text,
            attachments,
            senderId
          );

          if (!aiReply) {
            throw new Error('AI returned an empty response');
          }

          await sendFacebookMessage(senderId, aiReply);
        } catch (err) {
          console.error('[AI] Response error:', err.message);

          await sendFacebookMessage(
            senderId,
            'দুঃখিত, এই মুহূর্তে সম্পূর্ণ উত্তর দিতে পারছি না। বিস্তারিত জানতে আমাদের কল করুন: 01884332067'
          );
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Processing error:', err.message);
  }
});

// =============================================================================
// 16. CATALOG ADMIN API
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

    validateCatalogShape(catalogData);
    replaceCatalogAtomically(catalogData, 'admin');

    let githubResult = { synced: false };

    if (GITHUB_TOKEN) {
      githubResult = await pushCatalogToGitHub(catalogData);
    }

    res.json({
      success: true,
      message: `Catalog processed: ${products.length} products, ${faqs.length} FAQs`,
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
        message: result.error || result.message
      });
    }

    res.json({
      success: true,
      message: `Catalog uploaded to ${githubRepo || GITHUB_REPO}@${githubBranch || GITHUB_BRANCH}`,
      totalProducts: result.totalProducts,
      totalFaqs: result.totalFaqs,
      commit: result.commit
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err.message
    });
  }
});

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
// 17. BOT STATUS AND TAKEOVER API
// =============================================================================

app.get('/api/bot-status', (req, res) => {
  res.json({
    success: true,
    isGlobalPaused: !!db.isGlobalPaused,
    reason: db.isGlobalPaused ? 'Human takeover active' : 'AI bot active',
    totalPausedCustomers: Object.values(db.takeovers)
      .filter(item => item.isPaused).length
  });
});

app.post('/api/toggle-bot', (req, res) => {
  db.isGlobalPaused = !!req.body.isPaused;

  saveStorage();

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

// =============================================================================
// 18. CUSTOMERS, MESSAGES AND ORDERS API
// =============================================================================

app.get('/api/customers', (req, res) => {
  const list = Object.values(db.customers).map(customer => ({
    senderId: customer.id,
    displayName: customer.name || `Customer ${String(customer.id).slice(-4)}`,
    phone: customer.phone || null,
    lastMessageText: customer.lastMessageText || null,
    lastMessageAt: customer.lastActive || null,
    messageCount: customer.messageCount || 0,
    takeover: getTakeoverState(customer.id),
    isPaused: getTakeoverState(customer.id)
  }));

  res.json({
    success: true,
    data: list
  });
});

app.get('/api/messages', (req, res) => {
  const senderId = req.query.senderId
    ? String(req.query.senderId)
    : null;

  const limit = Math.min(
    Math.max(Number(req.query.limit) || 100, 1),
    1000
  );

  let messages = db.messages;

  if (senderId) {
    messages = messages.filter(
      message => String(message.senderId) === senderId
    );
  }

  res.json({
    success: true,
    total: messages.length,
    data: messages.slice(-limit)
  });
});

app.get('/api/orders', (req, res) => {
  res.json({
    success: true,
    total: db.orders.length,
    data: db.orders
  });
});

app.post('/api/orders', (req, res) => {
  const order = req.body || {};

  if (!order.senderId && !order.customerId) {
    return res.status(400).json({
      success: false,
      message: 'senderId or customerId is required'
    });
  }

  const newOrder = {
    ...order,
    id: order.id || 'order_' + crypto.randomUUID(),
    status: order.status || 'PENDING',
    createdAt: order.createdAt || new Date().toISOString()
  };

  db.orders.push(newOrder);
  saveStorage();

  res.status(201).json({
    success: true,
    order: newOrder
  });
});

app.get('/api/orders/:orderId', (req, res) => {
  const order = db.orders.find(
    item => String(item.id) === String(req.params.orderId)
  );

  if (!order) {
    return res.status(404).json({
      success: false,
      message: 'Order not found'
    });
  }

  res.json({
    success: true,
    order
  });
});

app.put('/api/orders/:orderId', (req, res) => {
  const index = db.orders.findIndex(
    item => String(item.id) === String(req.params.orderId)
  );

  if (index === -1) {
    return res.status(404).json({
      success: false,
      message: 'Order not found'
    });
  }

  db.orders[index] = {
    ...db.orders[index],
    ...req.body,
    id: db.orders[index].id,
    updatedAt: new Date().toISOString()
  };

  saveStorage();

  res.json({
    success: true,
    order: db.orders[index]
  });
});

app.delete('/api/orders/:orderId', (req, res) => {
  const index = db.orders.findIndex(
    item => String(item.id) === String(req.params.orderId)
  );

  if (index === -1) {
    return res.status(404).json({
      success: false,
      message: 'Order not found'
    });
  }

  const removed = db.orders.splice(index, 1)[0];

  saveStorage();

  res.json({
    success: true,
    deleted: removed.id
  });
});

app.post('/api/customers/:senderId/send', async (req, res) => {
  const { senderId } = req.params;
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({
      success: false,
      message: 'Text required'
    });
  }

  const sent = await sendFacebookMessage(senderId, text);

  if (!sent) {
    return res.status(500).json({
      success: false,
      message: 'Message sending failed'
    });
  }

  res.json({
    success: true,
    message: 'Message sent'
  });
});

// =============================================================================
// 19. HEALTH AND DIAGNOSTICS
// =============================================================================

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok'
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'LIVE_PRODUCTION',
    isGlobalPaused: !!db.isGlobalPaused
  });
});

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
// 20. START SERVER
// =============================================================================

async function startServer() {
  await pullCatalogFromGitHub();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] ImpoTech Master Bot running on port ${PORT}`);

    console.log(
      `[CATALOG] ${products.length} products, ${faqs.length} FAQs; ` +
      `source=${catalogMeta.source}`
    );

    if (catalogMeta.lastSyncError) {
      console.warn(
        '[CATALOG] GitHub warning: ' + catalogMeta.lastSyncError
      );
    }

    if (!ADMIN_SECRET && REQUIRE_ADMIN_SECRET) {
      console.error(
        '[SECURITY] ADMIN_SECRET is missing. Admin API requests will be rejected.'
      );
    }
  });
}

startServer().catch(err => {
  console.error('[SERVER] Startup error:', err.message);
  process.exit(1);
});

// Periodically expire webhook deduplication entries.
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;

  for (const [id, timestamp] of processedMessageIds) {
    if (timestamp < cutoff) {
      processedMessageIds.delete(id);
    }
  }
}, 60 * 1000).unref();
