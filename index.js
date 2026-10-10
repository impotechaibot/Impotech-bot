'use strict';

/**
 * =============================================================================
 * IMPOTECH AI MESSENGER BOT & ADMIN BACKEND
 * =============================================================================
 * AI          : OpenRouter Gemini
 * CATALOG     : GitHub catalog.json + Local cache
 * STORAGE     : storage_data.json
 * MEDIA       : Product-specific Facebook URLs
 * HUMAN       : Persistent per-customer + global takeover
 * ADMIN       : Catalog, customers, messages, orders, bot status
 *
 * FEATURES:
 * - Sales assistant and customer support
 * - Last 20 conversation messages in AI context
 * - Conversation history restored from storage_data.json
 * - Motorcycle model/year/H4 compatibility assistance
 * - Ask clarification before handover
 * - Human takeover only for critical cases
 * - Takeover remains enabled until admin turns it off
 * - Messenger duplicate protection
 * - Customer-specific message queue
 * - Price and product media protection
 * - Admin chat send/takeover APIs
 * - GitHub catalog pull/push
 * - Helpline and WhatsApp
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
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
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

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const GITHUB_REPO =
  process.env.GITHUB_REPO || 'impotechaibot/Impotech-bot';

const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const CATALOG_FILE =
  process.env.CATALOG_FILE || 'data/catalog.json';

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

const OPENROUTER_URL =
  'https://openrouter.ai/api/v1/chat/completions';

const TEXT_MODEL =
  process.env.TEXT_MODEL || 'google/gemini-3.1-flash-lite';

const VOICE_MODEL =
  process.env.VOICE_MODEL || TEXT_MODEL;

const HELPLINE = '+8809611042598';
const WHATSAPP_NUMBER = '01884332067';

const MAX_PRODUCTS_TO_AI = 5;
const MAX_FAQS_TO_AI = 5;
const MAX_OUTPUT_TOKENS = 800;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_MESSENGER_TEXT_LENGTH = 2000;

const HISTORY_LIMIT = 20;
const MESSAGE_RETENTION_LIMIT = 20000;
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

const LOCAL_CATALOG_PATH =
  path.join(__dirname, 'catalog.json');

const DATA_FILE =
  path.join(__dirname, 'storage_data.json');

const GRAPH_API_VERSION =
  process.env.GRAPH_API_VERSION || 'v18.0';

const REQUIRE_ADMIN_SECRET =
  process.env.REQUIRE_ADMIN_SECRET !== 'false';

const HANDOVER_MARKER = '[HANDOVER_REQUIRED]';

// =============================================================================
// 3. IN-MEMORY STATE AND FILE STORAGE
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
const customerQueues = new Map();

function loadStorage() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.log('[STORAGE] No storage file found; using empty storage');
      return;
    }

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

    customerHistory.clear();

    // Restore customer conversation history after restart.
    for (const message of db.messages) {
      const senderId = String(message.senderId || '');

      if (!senderId) continue;

      let role;

      if (
        message.sender === 'customer' ||
        message.sender === 'user'
      ) {
        role = 'user';
      } else if (
        message.sender === 'bot' ||
        message.sender === 'assistant' ||
        message.sender === 'admin'
      ) {
        role = 'assistant';
      } else {
        continue;
      }

      const history = customerHistory.get(senderId) || [];

      history.push({
        role,
        text: String(message.text || ''),
        timestamp: new Date(
          message.timestamp || Date.now()
        ).getTime()
      });

      if (history.length > HISTORY_LIMIT) {
        history.splice(0, history.length - HISTORY_LIMIT);
      }

      customerHistory.set(senderId, history);
    }

    console.log(
      `[STORAGE] Restored ${db.messages.length} stored messages; ` +
      `${customerHistory.size} customer histories`
    );
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
    return true;
  } catch (err) {
    console.error('[STORAGE] Save error:', err.message);
    return false;
  }
}

function addStoredMessage(message) {
  db.messages.push(message);

  if (db.messages.length > MESSAGE_RETENTION_LIMIT) {
    db.messages.splice(
      0,
      db.messages.length - MESSAGE_RETENTION_LIMIT
    );
  }
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

app.use('/api', (req, res, next) => {
  if (['/health', '/status'].includes(req.path)) {
    return next();
  }

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

// =============================================================================
// 6. PERSISTENT CONVERSATION HISTORY
// =============================================================================

function getHistory(senderId) {
  const id = String(senderId || '');

  if (!id) return [];

  if (customerHistory.has(id)) {
    return customerHistory.get(id);
  }

  const history = [];

  for (const message of db.messages) {
    if (String(message.senderId) !== id) continue;

    let role;

    if (
      message.sender === 'customer' ||
      message.sender === 'user'
    ) {
      role = 'user';
    } else if (
      message.sender === 'bot' ||
      message.sender === 'assistant' ||
      message.sender === 'admin'
    ) {
      role = 'assistant';
    } else {
      continue;
    }

    history.push({
      role,
      text: String(message.text || ''),
      timestamp: new Date(
        message.timestamp || Date.now()
      ).getTime()
    });
  }

  const limited = history.slice(-HISTORY_LIMIT);
  customerHistory.set(id, limited);

  return limited;
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

  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT);
  }

  customerHistory.set(id, history);
}

function getRecentConversationText(senderId, additionalText = '') {
  const history = getHistory(senderId);

  return [
    ...history.slice(-HISTORY_LIMIT).map(item => item.text),
    additionalText
  ]
    .filter(Boolean)
    .join('\n');
}

function getPreviousAssistantReply(senderId, userText) {
  const history = getHistory(senderId);
  const normalized = normalizeText(userText);

  for (let i = history.length - 2; i >= 0; i--) {
    if (
      history[i].role === 'user' &&
      normalizeText(history[i].text) === normalized
    ) {
      for (let j = i + 1; j < history.length; j++) {
        if (history[j].role === 'assistant') {
          return history[j].text;
        }
      }
    }
  }

  return null;
}

// =============================================================================
// 7. PRICE GUARD
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

  return [
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
  ].some(pattern => pattern.test(value));
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
      ...(Array.isArray(product.aliases) ? product.aliases : [])
    ]
      .filter(Boolean)
      .map(normalizeText);

    return candidates.some(candidate =>
      candidate && q.includes(candidate)
    );
  });

  return matches.length === 1 ? matches[0] : null;
}

function getPriceReply(product) {
  if (
    product.price === undefined ||
    product.price === null ||
    String(product.price).trim() === ''
  ) {
    return null;
  }

  return `${product.name}-এর দাম ${product.price} টাকা।`;
}

function getPriceClarificationReply() {
  return 'আপনি কোন পণ্যটির দাম জানতে চাচ্ছেন? পণ্যের সঠিক নাম বা মডেলটি বললে সঠিক দাম জানাতে পারব।';
}

// =============================================================================
// 8. MOTORCYCLE H4 COMPATIBILITY
// =============================================================================

function isBikeCompatibilityQuestion(text = '') {
  const value = normalizeText(text);

  const hasLightingTerm =
    /h4|devil eye|headlight|head lamp|headlamp|হেডলাইট|হেড লাইট|plug and play|প্লাগ অ্যান্ড প্লে|socket|সকেট|বাল্ব|bulb/.test(value);

  const hasBikeTerm =
    /বাইক|মোটরসাইকেল|motorcycle|motorbike|bike|মডেল|model|সাল|বছর|year|ফিট|fit|হবে|সাপোর্ট|support|socket|সকেট/.test(value);

  return hasLightingTerm && hasBikeTerm;
}

function getBikeCompatibilityEntries() {
  const entries = [];

  for (const product of products) {
    if (Array.isArray(product.bikeCompatibility)) {
      entries.push(...product.bikeCompatibility);
    } else if (product.bikeCompatibility) {
      entries.push(product.bikeCompatibility);
    }
  }

  for (const faq of faqs) {
    if (Array.isArray(faq.bikeCompatibility)) {
      entries.push(...faq.bikeCompatibility);
    } else if (faq.bikeCompatibility) {
      entries.push(faq.bikeCompatibility);
    }
  }

  return entries;
}

function identifyBikeModel(text = '') {
  const value = normalizeText(text);

  const matches = getBikeCompatibilityEntries()
    .filter(entry =>
      entry &&
      entry.verified === true &&
      typeof entry.originalH4Socket === 'boolean' &&
      entry.brand &&
      entry.model &&
      entry.source
    )
    .map(entry => {
      const aliases = Array.isArray(entry.aliases)
        ? entry.aliases
        : [];

      const names = [
        `${entry.brand} ${entry.model}`,
        ...aliases
      ]
        .map(normalizeText)
        .filter(Boolean);

      const matchedName = names
        .filter(name => value.includes(name))
        .sort((a, b) => b.length - a.length)[0];

      return {
        entry,
        matchedName,
        score: matchedName ? matchedName.length : 0
      };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!matches.length) return null;

  const best = matches[0];

  const conflicting = matches.some(item =>
    item.score === best.score &&
    item.entry.originalH4Socket !==
      best.entry.originalH4Socket
  );

  if (conflicting) return null;

  return best;
}

function getH4CompatibilityReply(match) {
  if (!match?.entry) return null;

  const entry = match.entry;

  if (
    entry.verified !== true ||
    typeof entry.originalH4Socket !== 'boolean' ||
    !entry.source
  ) {
    return null;
  }

  const model =
    `${entry.brand} ${entry.model}`.trim();

  if (entry.originalH4Socket) {
    return (
      `ক্যাটালগের যাচাইকৃত তথ্য অনুযায়ী ${model}-এর ` +
      `Original Headlight-এ H4 Socket আছে। ` +
      `তবে বাইকের উৎপাদন সাল বা Variant আলাদা হলে ` +
      `সেটি মিলিয়ে নেওয়া প্রয়োজন হতে পারে।`
    );
  }

  return (
    `ক্যাটালগের যাচাইকৃত তথ্য অনুযায়ী ${model}-এর ` +
    `Original Headlight-এ H4 Socket নেই। ` +
    `আপনার বাইকের Variant বা Headlight পরিবর্তন করা থাকলে ` +
    `সেটি জানালে আরও নির্দিষ্টভাবে যাচাই করতে পারব।`
  );
}

function extractBikeYear(text = '') {
  const matches = String(text).match(
    /\b(?:19[89]\d|20[0-3]\d)\b/g
  );

  return matches ? matches[matches.length - 1] : null;
}

function customerConfirmedH4(senderId, currentText = '') {
  const context = getRecentConversationText(
    senderId,
    currentText
  );

  const hasH4 = /\bh.?4\b/i.test(context);

  const confirmation =
    /আমার বাইকে h.?4 আছে|আমার বাইকে h.?4 সকেট আছে|বাইকে h.?4 socket আছে|h.?4 সকেট আছে|h.?4 socket আছে|already h.?4|it has h.?4|my bike has h.?4/i;

  return hasH4 && confirmation.test(context);
}

function getBikeClarificationReply(senderId, text = '') {
  const context = getRecentConversationText(senderId, text);
  const year = extractBikeYear(context);

  if (!year) {
    return (
      'আপনার বাইকের সঠিক ব্র্যান্ড, মডেল এবং কত সালের মডেল ' +
      'তা জানাবেন? যেমন: Yamaha FZ, 2022। ' +
      'এগুলো মিলিয়ে H4 Socket ও সরাসরি ফিট হওয়ার বিষয়টি যাচাই করে জানাব।'
    );
  }

  return null;
}

// =============================================================================
// 9. PRODUCT MEDIA
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

  const candidates = products
    .map(product => ({
      product,
      score: productScore(q, product)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (candidates.length) {
    if (
      candidates.length > 1 &&
      candidates[0].score === candidates[1].score
    ) {
      return null;
    }

    return candidates[0].product;
  }

  const history = getHistory(senderId);

  const previousProductQuery = history
    .filter(item => item.role === 'user')
    .slice(-5)
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

function getProductMediaReply(query, senderId) {
  const mediaType = getMediaType(query);

  if (!mediaType) return null;

  const product = findProductForMedia(query, senderId);

  if (!product) {
    return 'আপনি কোন পণ্যের ছবি বা ভিডিও দেখতে চান? পণ্যের নাম বা মডেলটি বলুন।';
  }

  const urls = getProductMediaUrls(product, mediaType);

  if (!urls.length) {
    return (
      `দুঃখিত, ${product.name}-এর ` +
      `${mediaType === 'images' ? 'ছবি' : 'ভিডিও'} লিংক ` +
      'বর্তমান ক্যাটালগে পাওয়া যাচ্ছে না। অন্য কোনো পণ্যের তথ্য চাইলে বলুন।'
    );
  }

  const label = mediaType === 'images' ? 'ছবি' : 'ভিডিও';

  return (
    `অবশ্যই! ${product.name} পণ্যের ${label} লিংক:\n\n` +
    urls.map((url, index) => `${index + 1}. ${url}`).join('\n') +
    '\n\nলিংকে চাপ দিয়ে দেখতে পারবেন।'
  );
}

// =============================================================================
// 10. HUMAN TAKEOVER
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
  const timestamp = new Date().toISOString();

  db.takeovers[id] = {
    isPaused: isEnabled,
    reason: reasonStr || (
      isEnabled ? 'Human takeover' : 'Admin resumed AI'
    ),
    timestamp
  };

  if (!db.customers[id]) {
    db.customers[id] = {
      id,
      name: 'Customer ' + id.slice(-4),
      messageCount: 0,
      isPaused: isEnabled,
      takeover: isEnabled,
      takeoverUpdatedAt: timestamp
    };
  } else {
    db.customers[id].isPaused = isEnabled;
    db.customers[id].takeover = isEnabled;
    db.customers[id].takeoverUpdatedAt = timestamp;
  }

  saveStorage();

  console.log(
    `[Takeover] ${id}: ${isEnabled ? 'PAUSED' : 'ACTIVE'}`
  );

  return isEnabled;
}

async function transferToHuman(senderId, reason, customMessage) {
  // Persist takeover before sending the notification.
  await setTakeoverState(
    senderId,
    true,
    reason || 'Critical issue requiring human support'
  );

  const message = customMessage ||
    `আপনার বিষয়টি আমাদের প্রতিনিধির সহায়তা প্রয়োজন। আমি কথোপকথনটি প্রতিনিধির কাছে হস্তান্তর করছি। এখন থেকে প্রতিনিধি উত্তর দেবেন। জরুরি প্রয়োজনে হেল্পলাইন: ${HELPLINE}। WhatsApp: ${WHATSAPP_NUMBER}।`;

  const sent = await sendFacebookMessage(senderId, message);

  if (!sent) {
    console.error(
      `[Takeover] Enabled, but transfer notification failed for ${senderId}`
    );
  }

  return sent;
}

// =============================================================================
// 11. MESSENGER SEND
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

    addStoredMessage({
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
// 12. GITHUB CATALOG SYNC
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
    return {
      synced: false,
      message: 'GitHub Token is not configured'
    };
  }

  try {
    validateCatalogShape(catalogData);
  } catch (err) {
    return { synced: false, error: err.message };
  }

  const url =
    `https://api.github.com/repos/${repo}/contents/${filePath}`;

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
// 13. SALES ASSISTANT SYSTEM PROMPT
// =============================================================================

function buildSystemPrompt(relevantProducts, relevantFaqs, history) {
  const productContext = relevantProducts.length
    ? relevantProducts.map((p, i) => [
        `[পণ্য ${i + 1}]`,
        `ID: ${p.id || 'N/A'}`,
        `নাম: ${p.name || 'N/A'}`,
        `ব্র্যান্ড: ${p.brand || 'N/A'}`,
        `মডেল: ${p.model || 'N/A'}`,
        `মূল্য: ${p.price ?? 'ক্যাটালগে নেই'} টাকা`,
        `স্টক: ${p.stockStatus || (p.inStock === true ? 'IN_STOCK' : 'তথ্য নেই')}`,
        `বিবরণ: ${p.shortDescription || p.description || 'N/A'}`,
        `বৈশিষ্ট্য: ${Array.isArray(p.features) ? p.features.join(', ') : 'N/A'}`,
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
        `${item.role === 'assistant' ? 'বট/প্রতিনিধি' : 'গ্রাহক'}: ${item.text}`
      ).join('\n')
    : 'পূর্ববর্তী কথোপকথন নেই।';

  return `
আপনি ImpoTech BD ফেসবুক পেজের বিক্রয় সহকারী এবং কাস্টমার সাপোর্ট অ্যাসিস্ট্যান্ট।

যোগাযোগ:
হেল্পলাইন: ${HELPLINE}
WhatsApp: ${WHATSAPP_NUMBER}

ব্যবসার ঠিকানা:
ভাওয়াল গড়, ভবানীপুর, জয়দেবপুর, গাজীপুর।

ডেলিভারি:
গাজীপুরের ভেতরে ৫০ টাকা।
গাজীপুরের বাইরে ১০০ টাকা।

আপনার কাজ:
- কাস্টমারকে সাহায্য করা এবং বিক্রয় বাড়াতে সহায়তা করা।
- পণ্যের বৈশিষ্ট্য সহজ ভাষায় বোঝানো।
- কাস্টমারের প্রয়োজন বুঝে উপযুক্ত পণ্য বেছে নিতে সাহায্য করা।
- উপযুক্ত হলে কাস্টমার অর্ডার করতে চান কি না জিজ্ঞেস করা।
- বন্ধুত্বপূর্ণ, ভদ্র, স্বাভাবিক ও বিশ্বাসযোগ্যভাবে কথা বলা।
- কথোপকথন সংক্ষিপ্ত রাখা; অপ্রয়োজনীয় দীর্ঘ উত্তর না দেওয়া।

বিক্রয় সংক্রান্ত নিয়ম:
১. কাস্টমার কী খুঁজছেন তা আগে বুঝুন।
২. প্রাসঙ্গিক পণ্যের সুবিধা বলুন, তবে কেবল উপলভ্য তথ্যের ভিত্তিতে।
৩. কাস্টমার কিনতে আগ্রহী হলে অর্ডার করার পরবর্তী ধাপ বুঝিয়ে দিন।
৪. কাস্টমারকে চাপ দেবেন না এবং মিথ্যা জরুরি অবস্থা তৈরি করবেন না।
৫. দাম ক্যাটালগে থাকলে সেই দাম বলুন। দাম না থাকলে অনুমান করবেন না।
৬. স্টক, ওয়ারেন্টি, ডেলিভারি সময়, গ্যারান্টি বা বৈশিষ্ট্য বানিয়ে বলবেন না।
৭. পণ্যের ID, দাম বা মিডিয়া URL পরিবর্তন করবেন না।
৮. কাস্টমার কোন পণ্য বোঝাচ্ছেন তা পরিষ্কার না হলে একটি সংক্ষিপ্ত প্রশ্ন করুন।
৯. ক্যাটালগে কোনো তথ্য না থাকলেই Human Takeover চাইবেন না।
১০. একই প্রশ্ন বারবার করে কাস্টমারকে বিরক্ত করবেন না।

কথোপকথনের স্মৃতি:
১. নিচে দেওয়া আগের কথোপকথনের সর্বশেষ ২০টি বার্তা বিবেচনা করুন।
২. কাস্টমার আগে কোন মডেল, সাল, পণ্য বা বাজেট বলেছেন তা মনে রাখুন।
৩. কাস্টমার ইতিমধ্যে তথ্য দিয়ে থাকলে আবার সেই তথ্য জিজ্ঞেস করবেন না।
৪. আগের উত্তর ভুল বা অসম্পূর্ণ হলে নতুন তথ্যের ভিত্তিতে সংশোধন করুন।
৫. একই প্রশ্নের উত্তর হুবহু পুনরাবৃত্তি না করে প্রয়োজন অনুযায়ী পরের ধাপে এগিয়ে যান।
৬. অ্যাডমিন বা মানব প্রতিনিধি ইতিমধ্যে উত্তর দিয়ে থাকলে সেটিও কথোপকথনের অংশ হিসেবে বিবেচনা করুন।

বাইক, গাড়ি, মডেল ও H4 Socket:
১. বাইকের ব্র্যান্ড, মডেল, উৎপাদন সাল ও Variant গুরুত্বপূর্ণ হতে পারে।
২. প্রয়োজনীয় তথ্য না থাকলে প্রথমে মডেল এবং উৎপাদন সাল জানতে চান।
৩. কাস্টমার যদি ইতিমধ্যে মডেল ও সাল বলে থাকেন, সেগুলো আবার জিজ্ঞেস করবেন না।
৪. কাস্টমার নিজে বলেন যে তাঁর বাইকে H4 Socket আছে, তাহলে সেই কথাকে বর্তমান কথোপকথনের নিশ্চিত করা তথ্য হিসেবে নিন।
৫. কাস্টমার নিজে H4 Socket নিশ্চিত করলে অযথা আবার H4 আছে কি না জিজ্ঞেস করবেন না।
৬. কাস্টমার নিজে Socket নিশ্চিত করলেও পণ্যের Connector, Voltage, Wattage বা অন্য কোনো অপরিহার্য বিষয় নিয়ে তথ্য না থাকলে কেবল সেই নির্দিষ্ট বিষয়টি জিজ্ঞেস করুন।
৭. সাধারণ জ্ঞান দিয়ে সম্ভাব্য তথ্য ব্যাখ্যা করতে পারেন, কিন্তু অনুমানকে শতভাগ নিশ্চিত তথ্য হিসেবে বলবেন না।
৮. একই মডেলের বিভিন্ন সাল বা Variant-এ পার্থক্য হতে পারে। তথ্য অস্পষ্ট হলে তা ব্যাখ্যা করে একটি প্রয়োজনীয় প্রশ্ন করুন।
৯. কাস্টমারের মডেল ও সাল জানা থাকলে সেগুলো ক্যাটালগের যাচাইকৃত তথ্যের সঙ্গে মিলিয়ে দেখুন।
১০. ক্যাটালগে রেকর্ড না থাকলেই সরাসরি Human Takeover করবেন না।
১১. নিশ্চিত না হলে কোন তথ্যটি অনিশ্চিত তা পরিষ্কারভাবে বলুন এবং কাস্টমারের কাছে প্রয়োজনীয় তথ্য চান।
১২. বাইক বা গাড়ির Compatibility নিয়ে উত্তর দিতে গিয়ে অপ্রাসঙ্গিকভাবে প্রতিনিধির কাছে পাঠাবেন না।

Human Takeover:
১. সাধারণ প্রশ্ন, শুভেচ্ছা, পণ্যের তথ্য, মডেল যাচাই বা সাধারণ অনিশ্চয়তায় Human Takeover করবেন না।
২. প্রথমে একটি পরিষ্কার প্রশ্ন করে প্রয়োজনীয় তথ্য সংগ্রহের চেষ্টা করুন।
৩. শুধু দাম, মডেল বা ক্যাটালগের তথ্য না থাকার কারণে Human Takeover করবেন না।
৪. গুরুতর অভিযোগ, প্রতারণা/নিরাপত্তা-সংক্রান্ত অভিযোগ, সংবেদনশীল অর্ডার বা পেমেন্ট সমস্যা, অথবা মানব প্রতিনিধির সিদ্ধান্ত সত্যিই প্রয়োজন হলে তবেই নিচের মার্কার ব্যবহার করুন।
৫. প্রযুক্তিগতভাবে উত্তর তৈরি করতে ব্যর্থ হলে আগে একবার পুনরায় চেষ্টা করুন; তবুও সম্ভব না হলে কাস্টমারকে প্রয়োজনীয় তথ্য জিজ্ঞেস করুন।
৬. সত্যিই মানব সহায়তা প্রয়োজন হলে উত্তরের একেবারে শুরুতে ঠিক এই মার্কার লিখুন:
${HANDOVER_MARKER}
৭. মার্কারের পরে এক বাক্যে কারণ লিখুন।
৮. এই মার্কার কাস্টমারের কাছে পাঠানোর জন্য নয়; ব্যাকএন্ড মার্কার শনাক্ত করে Takeover চালু করবে।
৯. সাধারণ অনিশ্চয়তার অজুহাতে মার্কার ব্যবহার করবেন না।
১০. Takeover চালু থাকলে AI উত্তর পাঠাবে না; অ্যাডমিন নিজে চালু না করা পর্যন্ত এই অবস্থা থাকবে।

অন্যান্য নিয়ম:
- সহজ ও স্বাভাবিক বাংলায় উত্তর দিন।
- কাস্টমার ইংরেজিতে লিখলে প্রয়োজনমতো ইংরেজিতে উত্তর দিতে পারেন।
- কোম্পানি সম্পর্কে বানানো তথ্য দেবেন না।
- কাস্টমারের ব্যক্তিগত তথ্য প্রকাশ করবেন না।
- পণ্য কেনার সিদ্ধান্ত নিতে সহায়ক বাস্তব তথ্য দিন।
- ক্যাটালগের তথ্যকে অগ্রাধিকার দিন।

প্রাসঙ্গিক পণ্য:
${productContext}

প্রাসঙ্গিক FAQ:
${faqContext}

পূর্ববর্তী কথোপকথন:
${historyContext}
  `.trim();
}

// =============================================================================
// 14. OPENROUTER
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
      temperature: 0.25
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

  if (!choice) {
    throw new Error('OpenRouter returned no response');
  }

  let reply = choice.message?.content;

  if (Array.isArray(reply)) {
    reply = reply.map(item => item?.text || '').join('');
  }

  reply = String(reply || '').trim();

  if (!reply) {
    throw new Error('OpenRouter returned an empty response');
  }

  if (choice.finish_reason === 'length') {
    throw new Error('AI response was truncated');
  }

  return reply;
}

// =============================================================================
// 15. AI TEXT, VISION AND VOICE
// =============================================================================

async function generateAIResponse(
  customerText,
  attachments = [],
  senderId
) {
  const query = customerText || 'ছবিটি বা পাঠানো ফাইলটি দেখে সাহায্য করুন';

  const allHistory = getHistory(senderId);
  const history = allHistory.slice();

  // Incoming customer message has already been stored.
  // Avoid sending it twice to the AI.
  if (
    history.length &&
    history[history.length - 1].role === 'user' &&
    history[history.length - 1].text === query
  ) {
    history.pop();
  }

  const relevantProducts = findRelevantProducts(
    getRecentConversationText(senderId, query)
  );

  const relevantFaqs = findRelevantFaqs(
    getRecentConversationText(senderId, query)
  );

  const systemPrompt = buildSystemPrompt(
    relevantProducts,
    relevantFaqs,
    history
  );

  const priorMessages = history.map(item => ({
    role: item.role === 'assistant' ? 'assistant' : 'user',
    content: item.text
  }));

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

      const audioBase64 =
        Buffer.from(audioResponse.data).toString('base64');

      return await callOpenRouter([
        { role: 'system', content: systemPrompt },
        ...priorMessages,
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'গ্রাহকের ভয়েস বুঝে উত্তর দিন। ' +
                'প্রয়োজন হলে তাঁর প্রশ্নটি সংক্ষেপে পরিষ্কার করুন।'
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

      const imageBase64 =
        Buffer.from(imageResponse.data).toString('base64');

      const contentType =
        imageResponse.headers['content-type'] || 'image/jpeg';

      return await callOpenRouter([
        { role: 'system', content: systemPrompt },
        ...priorMessages,
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `${query}\nছবিটি দেখে প্রাসঙ্গিক পণ্য বা তথ্য শনাক্ত করুন। ` +
                'যা নিশ্চিতভাবে বোঝা যায় না তা অনুমান করে বলবেন না।'
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
    ...priorMessages,
    { role: 'user', content: query }
  ], TEXT_MODEL);
}

// =============================================================================
// 16. CRITICAL HANDOVER CLASSIFICATION
// =============================================================================

function isCriticalHandoverQuestion(text = '') {
  const value = normalizeText(text);

  return (
    /প্রতারণা|fraud|scam|আইনগত ব্যবস্থা|legal action|মামলা|মারাত্মক দুর্ঘটনা|serious injury|আগুন লেগেছে|fire hazard|ব্যাটারি বিস্ফোরণ|battery exploded|চার্জে আগুন|payment deducted twice|দুইবার টাকা কাটা|ভুল পেমেন্ট|টাকা কেটে নিয়েছে/.test(value)
  );
}

// =============================================================================
// 17. MESSAGE PROCESSING
// =============================================================================

async function processCustomerMessage(
  senderId,
  text,
  attachments = []
) {
  if (getTakeoverState(senderId)) {
    console.log(`[Takeover] ${senderId} is paused; skipping AI`);
    return;
  }

  const customerText = String(text || '').trim();

  try {
    // -----------------------------------------------------------------------
    // 1. Critical issue: transfer directly to a representative.
    // -----------------------------------------------------------------------

    if (isCriticalHandoverQuestion(customerText)) {
      await transferToHuman(
        senderId,
        'Critical customer issue',
        `আপনার বিষয়টি গুরুত্ব দিয়ে দেখা প্রয়োজন। আমি কথোপকথনটি আমাদের প্রতিনিধির কাছে হস্তান্তর করছি। হেল্পলাইন: ${HELPLINE}। WhatsApp: ${WHATSAPP_NUMBER}।`
      );

      return;
    }

    // -----------------------------------------------------------------------
    // 2. H4 compatibility: use verified catalog information first.
    // -----------------------------------------------------------------------

    if (isBikeCompatibilityQuestion(customerText)) {
      const context = getRecentConversationText(
        senderId,
        customerText
      );

      const match = identifyBikeModel(context);
      const verifiedReply = getH4CompatibilityReply(match);

      if (verifiedReply) {
        await sendFacebookMessage(senderId, verifiedReply);
        return;
      }

      // If the customer personally confirms H4, do not ask the same
      // question again. Let AI explain next compatibility requirements.
      if (customerConfirmedH4(senderId, customerText)) {
        const reply = await generateAIResponse(
          customerText,
          attachments,
          senderId
        );

        if (reply.includes(HANDOVER_MARKER)) {
          // Do not transfer for an ordinary fitment uncertainty.
          await sendFacebookMessage(
            senderId,
            'আপনি জানিয়েছেন যে আপনার বাইকে H4 Socket আছে। এখন পণ্যের মডেল বা Connector-এর তথ্যটি জানালে বাকি Compatibility মিলিয়ে বলতে পারব।'
          );
          return;
        }

        await sendFacebookMessage(senderId, reply);
        return;
      }

      // Ask for model/year first instead of sending every question
      // to the human representative.
      const clarification = getBikeClarificationReply(
        senderId,
        customerText
      );

      if (clarification) {
        await sendFacebookMessage(senderId, clarification);
        return;
      }

      // Model/year may already be in the conversation.
      // Let the AI use its general knowledge and available catalog context.
      // Uncertainty alone must not trigger human takeover.
      const bikeReply = await generateAIResponse(
        customerText,
        attachments,
        senderId
      );

      if (bikeReply.includes(HANDOVER_MARKER)) {
        await sendFacebookMessage(
          senderId,
          'বাইকের মডেল ও সাল বুঝতে পেরেছি। নিশ্চিতভাবে Socket মিলিয়ে বলতে আপনার Original Headlight Socket-এর ছবি বা Socket-এর লেখা পাঠাতে পারবেন? তাহলে আরও নির্ভুলভাবে সাহায্য করতে পারব।'
        );
        return;
      }

      await sendFacebookMessage(senderId, bikeReply);
      return;
    }

    // -----------------------------------------------------------------------
    // 3. Product price.
    // -----------------------------------------------------------------------

    if (isPriceQuestion(customerText)) {
      if (isGenericPriceQuestion(customerText)) {
        await sendFacebookMessage(
          senderId,
          getPriceClarificationReply()
        );
        return;
      }

      const product = findExactProductForPrice(customerText);

      if (!product) {
        await sendFacebookMessage(
          senderId,
          'আপনি কোন পণ্যটির দাম জানতে চাচ্ছেন? সঠিক নাম বা মডেলটি বললে ক্যাটালগ থেকে দাম মিলিয়ে জানাতে পারব।'
        );
        return;
      }

      const priceReply = getPriceReply(product);

      if (!priceReply) {
        // Missing price is not, by itself, a critical issue.
        await sendFacebookMessage(
          senderId,
          `দুঃখিত, ${product.name}-এর দাম বর্তমানে ক্যাটালগে উল্লেখ নেই। আপনি চাইলে পণ্যটির অন্য তথ্য জানাতে পারি।`
        );
        return;
      }

      await sendFacebookMessage(senderId, priceReply);
      return;
    }

    // -----------------------------------------------------------------------
    // 4. Product media.
    // -----------------------------------------------------------------------

    if (isMediaRequest(customerText)) {
      const mediaReply = getProductMediaReply(
        customerText,
        senderId
      );

      if (mediaReply) {
        await sendFacebookMessage(senderId, mediaReply);
        return;
      }
    }

    // -----------------------------------------------------------------------
    // 5. Normal AI sales/support response.
    // -----------------------------------------------------------------------

    let aiReply = await generateAIResponse(
      customerText,
      attachments,
      senderId
    );

    if (!aiReply) {
      throw new Error('AI returned an empty response');
    }

    // AI marker is reserved for genuinely critical human support.
    if (aiReply.includes(HANDOVER_MARKER)) {
      const explanation = aiReply
        .replaceAll(HANDOVER_MARKER, '')
        .trim();

      if (isCriticalHandoverQuestion(customerText)) {
        await transferToHuman(
          senderId,
          'AI identified a critical support issue',
          explanation
            ? `${explanation}\n\nআমি বিষয়টি আমাদের প্রতিনিধির কাছে হস্তান্তর করছি। হেল্পলাইন: ${HELPLINE}। WhatsApp: ${WHATSAPP_NUMBER}।`
            : undefined
        );

        return;
      }

      // If it is not a critical issue, keep helping instead of pausing AI.
      await sendFacebookMessage(
        senderId,
        explanation ||
        'আপনার প্রশ্নটি আরও ভালোভাবে বুঝতে একটি তথ্য জানতে চাই। আপনি কোন পণ্য বা মডেলটির কথা বলছেন?'
      );

      return;
    }

    const previousReply = getPreviousAssistantReply(
      senderId,
      customerText
    );

    if (
      previousReply &&
      normalizeText(previousReply) === normalizeText(aiReply)
    ) {
      aiReply =
        'আগের উত্তরে বিষয়টি জানিয়েছি। আপনি চাইলে কোন অংশটি আরও পরিষ্কার করতে হবে বলুন, আমি সাহায্য করছি।';
    }

    // Check takeover immediately before sending.
    if (getTakeoverState(senderId)) return;

    await sendFacebookMessage(senderId, aiReply);
  } catch (err) {
    console.error('[AI] Response error:', err.message);

    if (getTakeoverState(senderId)) return;

    // A transient API error should not automatically disable the bot.
    // Tell the customer briefly and allow later messages to work.
    await sendFacebookMessage(
      senderId,
      'দুঃখিত, এই মুহূর্তে উত্তর তৈরি করতে সমস্যা হচ্ছে। আপনি একটু পরে আবার লিখবেন? জরুরি প্রয়োজনে হেল্পলাইন: ' +
      HELPLINE +
      '। WhatsApp: ' +
      WHATSAPP_NUMBER +
      '।'
    );
  }
}

// =============================================================================
// 18. FACEBOOK WEBHOOK
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

        const previousTask =
          customerQueues.get(senderId) || Promise.resolve();

        const currentTask = previousTask
          .catch(() => {})
          .then(async () => {
            const isPaused = getTakeoverState(senderId);

            appendHistory(
              senderId,
              'user',
              text || '[Media File]'
            );

            addStoredMessage({
              id: 'msg_' + crypto.randomUUID(),
              senderId,
              sender: 'customer',
              text: text || `[Media: ${attachments[0]?.type || 'file'}]`,
              timestamp: new Date().toISOString(),
              messageId: messageId || null
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

              customer.messageCount =
                (customer.messageCount || 0) + 1;

              customer.lastActive = new Date().toISOString();
              customer.lastMessageText = text || '[Media]';
            }

            saveStorage();

            if (isPaused) {
              console.log(
                `[Takeover] ${senderId} paused; AI response skipped`
              );
              return;
            }

            await processCustomerMessage(
              senderId,
              text,
              attachments
            );
          });

        customerQueues.set(senderId, currentTask);

        currentTask.finally(() => {
          if (customerQueues.get(senderId) === currentTask) {
            customerQueues.delete(senderId);
          }
        }).catch(err => {
          console.error(
            '[Webhook] Customer task failed:',
            err.message
          );
        });
      }
    }
  } catch (err) {
    console.error('[Webhook] Processing error:', err.message);
  }
});

// =============================================================================
// 19. CATALOG ADMIN API
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
      message:
        `Catalog processed: ${products.length} products, ` +
        `${faqs.length} FAQs`,
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

    const targetCatalog =
      catalogPayload || loadLocalCatalog();

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
      message:
        `Catalog uploaded to ${githubRepo || GITHUB_REPO}@` +
        `${githubBranch || GITHUB_BRANCH}`,
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
// 20. BOT STATUS AND TAKEOVER API
// =============================================================================

app.get('/api/bot-status', (req, res) => {
  res.json({
    success: true,
    isGlobalPaused: !!db.isGlobalPaused,
    reason: db.isGlobalPaused
      ? 'Global human takeover active'
      : 'AI bot active',
    totalPausedCustomers: Object.values(db.takeovers)
      .filter(item => item && item.isPaused).length
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

  await setTakeoverState(
    senderId,
    isPaused,
    req.body.reason
  );

  res.json({
    success: true,
    senderId,
    isPaused,
    takeover: isPaused,
    message: isPaused
      ? 'Human takeover enabled. AI remains paused until an admin resumes it.'
      : 'AI resumed for this customer.'
  });
});

app.get('/api/customers/:senderId/status', (req, res) => {
  const { senderId } = req.params;
  const isPaused = getTakeoverState(senderId);

  res.json({
    success: true,
    senderId,
    isPaused,
    takeover: isPaused,
    reason: db.takeovers[senderId]?.reason || null,
    updatedAt: db.takeovers[senderId]?.timestamp || null
  });
});

// Convenience endpoints for admin chat UI.
app.post('/api/customers/:senderId/takeover/enable', async (req, res) => {
  const { senderId } = req.params;

  await setTakeoverState(
    senderId,
    true,
    req.body?.reason || 'Enabled from admin chat'
  );

  res.json({
    success: true,
    senderId,
    takeover: true,
    isPaused: true
  });
});

app.post('/api/customers/:senderId/takeover/disable', async (req, res) => {
  const { senderId } = req.params;

  await setTakeoverState(
    senderId,
    false,
    req.body?.reason || 'Disabled from admin chat'
  );

  res.json({
    success: true,
    senderId,
    takeover: false,
    isPaused: false
  });
});

// =============================================================================
// 21. CUSTOMERS, MESSAGES AND ORDERS API
// =============================================================================

app.get('/api/customers', (req, res) => {
  const list = Object.values(db.customers).map(customer => ({
    senderId: customer.id,
    displayName:
      customer.name ||
      `Customer ${String(customer.id).slice(-4)}`,
    phone: customer.phone || null,
    lastMessageText: customer.lastMessageText || null,
    lastMessageAt: customer.lastActive || null,
    messageCount: customer.messageCount || 0,
    takeover: getTakeoverState(customer.id),
    isPaused: getTakeoverState(customer.id),
    takeoverReason: db.takeovers[customer.id]?.reason || null,
    takeoverUpdatedAt: db.takeovers[customer.id]?.timestamp || null
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

// Admin sends a message from the chat UI.
app.post('/api/customers/:senderId/send', async (req, res) => {
  const { senderId } = req.params;
  const { text } = req.body || {};

  if (!text || !String(text).trim()) {
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
// 22. HEALTH AND DIAGNOSTICS
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
    helpline: HELPLINE,
    whatsapp: WHATSAPP_NUMBER,
    historyLimit: HISTORY_LIMIT,
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
// 23. START SERVER
// =============================================================================

async function startServer() {
  await pullCatalogFromGitHub();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[SERVER] ImpoTech Master Bot running on port ${PORT}`
    );

    console.log(
      `[CATALOG] ${products.length} products, ` +
      `${faqs.length} FAQs; source=${catalogMeta.source}`
    );

    console.log(`[CONTACT] Helpline: ${HELPLINE}`);
    console.log(`[CONTACT] WhatsApp: ${WHATSAPP_NUMBER}`);
    console.log(`[MEMORY] Last ${HISTORY_LIMIT} conversation messages`);

    if (catalogMeta.lastSyncError) {
      console.warn(
        '[CATALOG] GitHub warning: ' +
        catalogMeta.lastSyncError
      );
    }

    if (!ADMIN_SECRET && REQUIRE_ADMIN_SECRET) {
      console.error(
        '[SECURITY] ADMIN_SECRET is missing. ' +
        'Admin API requests will be rejected.'
      );
    }
  });
}

startServer().catch(err => {
  console.error('[SERVER] Startup error:', err.message);
  process.exit(1);
});

// =============================================================================
// 24. CLEANUP
// =============================================================================

setInterval(() => {
  const cutoff = Date.now() - DUPLICATE_WINDOW_MS;

  for (const [id, timestamp] of processedMessageIds) {
    if (timestamp < cutoff) {
      processedMessageIds.delete(id);
    }
  }
}, 60 * 1000).unref();
