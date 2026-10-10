'use strict';

/**
 * =============================================================================
 * IMPOTECH AI MESSENGER BOT & ADMIN BACKEND
 * =============================================================================
 * AI          : OpenRouter Gemini
 * CATALOG     : GitHub catalog.json + Local cache
 * STORAGE     : storage_data.json
 * MEMORY      : Persistent customer memory + last 20 messages
 * FOLLOW-UP   : Scheduled around 23 hours after customer interaction
 * HUMAN       : Persistent per-customer + global takeover
 * ADMIN       : Catalog, customers, messages, orders, bot status
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

  if (req.method === 'OPTIONS') return res.sendStatus(200);
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
const CATALOG_FILE = process.env.CATALOG_FILE || 'data/catalog.json';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

const OPENROUTER_URL =
  'https://openrouter.ai/api/v1/chat/completions';

const TEXT_MODEL =
  process.env.TEXT_MODEL || 'google/gemini-3.1-flash-lite';

const VOICE_MODEL = process.env.VOICE_MODEL || TEXT_MODEL;

const HELPLINE = '+8809611042598';
const WHATSAPP_NUMBER = '01884332067';

const MAX_PRODUCTS_TO_AI = 5;
const MAX_FAQS_TO_AI = 5;
const MAX_OUTPUT_TOKENS = 500;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_MESSENGER_TEXT_LENGTH = 2000;
const MAX_AI_LINES = 5;

const HISTORY_LIMIT = 20;
const MESSAGE_RETENTION_LIMIT = 20000;
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

// Follow-up is scheduled at 23 hours, leaving a safety margin
// before the standard 24-hour Messenger messaging window closes.
const FOLLOWUP_DELAY_MS = 23 * 60 * 60 * 1000;
const FOLLOWUP_CHECK_INTERVAL_MS = 60 * 1000;

const LOCAL_CATALOG_PATH = path.join(__dirname, 'catalog.json');
const DATA_FILE = path.join(__dirname, 'storage_data.json');

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v18.0';
const REQUIRE_ADMIN_SECRET =
  process.env.REQUIRE_ADMIN_SECRET !== 'false';

const HANDOVER_MARKER = '[HANDOVER_REQUIRED]';

const ORDER_CONFIRMATION =
  'আপনার অর্ডারটি গ্রহণ করা হয়েছে। আমাদের প্রতিনিধি শীঘ্রই আপনার অর্ডারটি কনফার্ম করবেন।';

const FOLLOWUP_MESSAGE =
  'আপনি কি পণ্যটি সম্পর্কে আরও কিছু জানতে চান? কোনো প্রশ্ন থাকলে জানাবেন, আমরা সাহায্য করতে প্রস্তুত।';

// =============================================================================
// 3. STATE AND STORAGE
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
  orders: [],
  customerMemory: {},
  scheduledFollowups: {}
};

const customerHistory = new Map();
const processedMessageIds = new Map();
const customerQueues = new Map();
const followupTimers = new Map();

function ensureStorageShape() {
  if (!db || typeof db !== 'object') db = {};

  if (typeof db.isGlobalPaused !== 'boolean') {
    db.isGlobalPaused = false;
  }

  if (!db.takeovers || typeof db.takeovers !== 'object') {
    db.takeovers = {};
  }

  if (!db.customers || typeof db.customers !== 'object') {
    db.customers = {};
  }

  if (!Array.isArray(db.messages)) db.messages = [];
  if (!Array.isArray(db.orders)) db.orders = [];

  if (!db.customerMemory || typeof db.customerMemory !== 'object') {
    db.customerMemory = {};
  }

  if (
    !db.scheduledFollowups ||
    typeof db.scheduledFollowups !== 'object'
  ) {
    db.scheduledFollowups = {};
  }
}

function loadStorage() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.log('[STORAGE] No storage file found; using empty storage');
      ensureStorageShape();
      return;
    }

    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

    db = {
      isGlobalPaused: false,
      takeovers: {},
      customers: {},
      messages: [],
      orders: [],
      customerMemory: {},
      scheduledFollowups: {},
      ...saved
    };

    ensureStorageShape();
    customerHistory.clear();

    for (const message of db.messages) {
      const senderId = String(message.senderId || '');
      if (!senderId) continue;

      let role;

      if (['customer', 'user'].includes(message.sender)) {
        role = 'user';
      } else if (
        ['bot', 'assistant', 'admin'].includes(message.sender)
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
      `[STORAGE] Restored ${db.messages.length} messages, ` +
      `${db.orders.length} orders and ` +
      `${Object.keys(db.customerMemory).length} customer memories`
    );
  } catch (err) {
    console.error('[STORAGE] Load error:', err.message);
    ensureStorageShape();
  }
}

function saveStorage() {
  try {
    ensureStorageShape();

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

// =============================================================================
// 4. PERSISTENT CUSTOMER MEMORY
// =============================================================================

// Memory is intentionally conservative: store customer-provided facts and
// preferences, not guesses. Full message history remains available separately.
function getCustomerMemory(senderId) {
  const id = String(senderId || '');
  if (!id) return null;

  if (!db.customerMemory[id]) {
    db.customerMemory[id] = {
      senderId: id,
      facts: [],
      preferences: [],
      summary: '',
      updatedAt: null
    };
  }

  const memory = db.customerMemory[id];

  if (!Array.isArray(memory.facts)) memory.facts = [];
  if (!Array.isArray(memory.preferences)) memory.preferences = [];
  if (typeof memory.summary !== 'string') memory.summary = '';

  return memory;
}

function addUniqueMemoryItem(list, value, maxItems = 30) {
  const text = String(value || '').trim();
  if (!text || text.length > 220) return list;

  const key = normalizeText(text);
  if (!key) return list;

  if (!list.some(item => normalizeText(item) === key)) {
    list.push(text);
  }

  if (list.length > maxItems) {
    list.splice(0, list.length - maxItems);
  }

  return list;
}

function updateCustomerMemory(senderId, customerText) {
  const text = String(customerText || '').trim();
  if (!senderId || !text || text.length > 1000) return;

  const memory = getCustomerMemory(senderId);
  const customer = db.customers[String(senderId)] || {};

  // Save explicit product/model context, without inventing a match.
  const matchedProducts = products
    .map(product => ({
      product,
      score: productScore(text, product)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (
    matchedProducts.length &&
    (
      matchedProducts.length === 1 ||
      matchedProducts[0].score > matchedProducts[1].score
    )
  ) {
    addUniqueMemoryItem(
      memory.facts,
      `আলোচিত পণ্য: ${matchedProducts[0].product.name} (ID: ${matchedProducts[0].product.id})`
    );
  }

  // Only retain phone numbers when the customer explicitly provides one.
  const phoneMatch = text.match(
    /(?:\+?8801|01)[0-9\s-]{8,14}/
  );

  if (phoneMatch) {
    customer.phone = phoneMatch[0].replace(/[\s-]/g, '');
  }

  const preferencePatterns = [
    /আমি (?:সাধারণত )?(?:কালো|সাদা|লাল|নীল|কালার|রঙের)[^।.!?]{0,100}/i,
    /আমার (?:বাইক|মোটরসাইকেল|গাড়ি)[^।.!?]{0,120}/i,
    /আমার (?:পছন্দ|বাজেট)[^।.!?]{0,120}/i,
    /বাজেট [^।.!?]{0,80}/i,
    /ডেলিভারি (?:গাজীপুর|ঢাকা|চট্টগ্রাম|সিলেট|রাজশাহী|খুলনা)[^।.!?]{0,80}/i
  ];

  for (const pattern of preferencePatterns) {
    const match = text.match(pattern);
    if (match) addUniqueMemoryItem(memory.preferences, match[0], 20);
  }

  // Keep a bounded, durable summary of recent customer-provided information.
  if (text.length >= 8 && !/^(হ্যাঁ|না|ok|okay|ধন্যবাদ|thanks)$/i.test(text)) {
    memory.summary = [
      memory.summary,
      `গ্রাহক বলেছেন: ${text.slice(0, 240)}`
    ].filter(Boolean).slice(-8).join('\n');
  }

  memory.updatedAt = new Date().toISOString();
  customer.lastMemoryUpdatedAt = memory.updatedAt;

  saveStorage();
}

function buildCustomerMemoryContext(senderId) {
  const memory = getCustomerMemory(senderId);
  if (!memory) return 'কোনো সংরক্ষিত গ্রাহক মেমোরি নেই।';

  const facts = memory.facts.slice(-15);
  const preferences = memory.preferences.slice(-10);

  return [
    facts.length
      ? `গুরুত্বপূর্ণ তথ্য:\n- ${facts.join('\n- ')}`
      : '',
    preferences.length
      ? `গ্রাহকের পছন্দ/প্রসঙ্গ:\n- ${preferences.join('\n- ')}`
      : '',
    memory.summary
      ? `সংরক্ষিত কথোপকথনের সারাংশ:\n${memory.summary}`
      : ''
  ].filter(Boolean).join('\n\n') || 'কোনো সংরক্ষিত গ্রাহক মেমোরি নেই।';
}

// =============================================================================
// 5. CATALOG VALIDATION AND LOADING
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

    if (!id) throw new Error('Every product must have an ID');
    if (ids.has(id)) throw new Error('Duplicate product ID: ' + id);

    ids.add(id);
  }

  if (data.faqs !== undefined && !Array.isArray(data.faqs)) {
    throw new Error('Catalog FAQs must be an array');
  }

  return true;
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
// 6. ADMIN AUTHENTICATION
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
  if (['/health', '/status'].includes(req.path)) return next();
  return requireAdmin(req, res, next);
});

// =============================================================================
// 7. PRODUCT AND FAQ SEARCH
// =============================================================================

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
    'id', 'name', 'description', 'shortDescription', 'category',
    'brand', 'model', 'sku', 'keywords', 'tags', 'aliases'
  ]);
}

function findRelevantProducts(query) {
  return products
    .map(product => ({ product, score: productScore(query, product) }))
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
        'question', 'answer', 'category', 'keywords'
      ])
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FAQS_TO_AI)
    .map(item => item.faq);
}

// =============================================================================
// 8. CONVERSATION HISTORY
// =============================================================================

function getHistory(senderId) {
  const id = String(senderId || '');
  if (!id) return [];

  if (customerHistory.has(id)) return customerHistory.get(id);

  const history = [];

  for (const message of db.messages) {
    if (String(message.senderId) !== id) continue;

    let role;

    if (['customer', 'user'].includes(message.sender)) {
      role = 'user';
    } else if (['bot', 'assistant', 'admin'].includes(message.sender)) {
      role = 'assistant';
    } else {
      continue;
    }

    history.push({
      role,
      text: String(message.text || ''),
      timestamp: new Date(message.timestamp || Date.now()).getTime()
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
  return [
    ...getHistory(senderId).slice(-HISTORY_LIMIT).map(item => item.text),
    additionalText
  ].filter(Boolean).join('\n');
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
        if (history[j].role === 'assistant') return history[j].text;
      }
    }
  }

  return null;
}

// =============================================================================
// 9. EXACT PRODUCT MATCHING AND PRICE PROTECTION
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
    /^দাম$/, /^দাম কত$/, /^দামটা কত$/, /^প্রাইস$/,
    /^প্রাইস কত$/, /^মূল্য$/, /^মূল্য কত$/, /^কত টাকা$/,
    /^কত দাম$/, /^price$/, /^price please$/, /^how much$/,
    /^how much is it$/, /^what is the price$/
  ].some(pattern => pattern.test(value));
}

function getProductIdentifiers(product) {
  return [
    product.name,
    product.id,
    product.sku,
    product.model,
    ...(Array.isArray(product.aliases) ? product.aliases : [])
  ]
    .filter(Boolean)
    .map(normalizeText)
    .filter(Boolean);
}

// Match a product only when a full identifier is present. A partial name
// or one common token must not be enough to disclose the wrong price.
function findExactProductForPrice(query) {
  const q = normalizeText(query);
  if (!q) return null;

  const matches = [];

  for (const product of products) {
    const identifiers = getProductIdentifiers(product);

    const matched = identifiers.some(identifier => {
      if (identifier.length < 3) return false;

      const escaped = identifier.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      );

      const pattern = new RegExp(
        `(^|\\s)${escaped.replace(/\s+/g, '\\s+')}(?=\\s|$)`,
        'i'
      );

      return pattern.test(q);
    });

    if (matched) matches.push(product);
  }

  // If identifiers collide across products, do not guess.
  return matches.length === 1 ? matches[0] : null;
}

function findProductFromRecentContext(senderId) {
  const history = getHistory(senderId);

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'user') continue;

    const previousText = history[i].text || '';
    const match = findExactProductForPrice(previousText);

    if (match) return match;
  }

  const memory = getCustomerMemory(senderId);
  const recentFacts = (memory?.facts || []).slice().reverse();

  for (const fact of recentFacts) {
    const match = findExactProductForPrice(fact);
    if (match) return match;
  }

  return null;
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
// 10. MOTORCYCLE H4 COMPATIBILITY
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
      const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
      const names = [`${entry.brand} ${entry.model}`, ...aliases]
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
    item.entry.originalH4Socket !== best.entry.originalH4Socket
  );

  return conflicting ? null : best;
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

  const model = `${entry.brand} ${entry.model}`.trim();

  if (entry.originalH4Socket) {
    return (
      `ক্যাটালগের যাচাইকৃত তথ্য অনুযায়ী ${model}-এর ` +
      'Original Headlight-এ H4 Socket আছে। Variant বা উৎপাদন সাল আলাদা হলে সেটিও মিলিয়ে নেওয়া প্রয়োজন।'
    );
  }

  return (
    `ক্যাটালগের যাচাইকৃত তথ্য অনুযায়ী ${model}-এর ` +
    'Original Headlight-এ H4 Socket নেই। Variant বা Headlight পরিবর্তন করা থাকলে সেটি জানালে যাচাই করতে পারব।'
  );
}

function extractBikeYear(text = '') {
  const matches = String(text).match(/\b(?:19[89]\d|20[0-3]\d)\b/g);
  return matches ? matches[matches.length - 1] : null;
}

function customerConfirmedH4(senderId, currentText = '') {
  const context = getRecentConversationText(senderId, currentText);
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
      'আপনার বাইকের সঠিক ব্র্যান্ড, মডেল এবং কত সালের মডেল জানাবেন? ' +
      'যেমন: Yamaha FZ, 2022। এগুলো মিলিয়ে H4 Socket ও ফিটমেন্ট যাচাই করে জানাব।'
    );
  }

  return null;
}

// =============================================================================
// 11. PRODUCT MEDIA
// =============================================================================

function getMediaType(text = '') {
  const value = normalizeText(text);

  if (/ভিডিও|video|রিল|reel|clip/.test(value)) return 'videos';

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
  const exact = findExactProductForPrice(query);
  if (exact) return exact;

  const q = normalizeText(query);

  const candidates = products
    .map(product => ({ product, score: productScore(q, product) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (
    candidates.length &&
    (
      candidates.length === 1 ||
      candidates[0].score > candidates[1].score
    )
  ) {
    return candidates[0].product;
  }

  return findProductFromRecentContext(senderId);
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
      `${mediaType === 'images' ? 'ছবি' : 'ভিডিও'} লিংক বর্তমান ক্যাটালগে পাওয়া যাচ্ছে না।`
    );
  }

  const label = mediaType === 'images' ? 'ছবি' : 'ভিডিও';

  return (
    `অবশ্যই! ${product.name} পণ্যের ${label} লিংক:\n` +
    urls.map((url, index) => `${index + 1}. ${url}`).join('\n')
  );
}

// =============================================================================
// 12. ORDER INTENT AND ORDER STORAGE
// =============================================================================

function isExplicitOrderIntent(text = '') {
  const value = normalizeText(text);
  if (!value) return false;

  const patterns = [
    /\b(i want to order|i would like to order|place my order|order this|i will buy|i want to buy|buy this|confirm my order|i will take it|i want this)\b/i,
    /\b(order kore din|order korbo|order dibo|order dite chai|order korte chai|kinbo|kine nibo|eta nibo|eta kinbo)\b/i,
    /অর্ডার করতে চাই|অর্ডার করব|অর্ডার করবো|অর্ডার দিন|অর্ডার করে দিন|অর্ডার দিব|অর্ডার দেব|অর্ডার দিতে চাই|অর্ডার কনফার্ম|কিনতে চাই|কিনব|কিনবো|নিতে চাই|নিব|নেব|পণ্যটি নেব|পণ্যটা নেব|এটা নেব|এটি নেব|এটা কিনব|এটি কিনব|কিনে নেব|কিনে নিব/
  ];

  return patterns.some(pattern => pattern.test(value));
}

function identifyOrderedProduct(senderId, customerText) {
  const exact = findExactProductForPrice(customerText);
  if (exact) return exact;

  const currentMatches = products
    .map(product => ({
      product,
      score: productScore(customerText, product)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (
    currentMatches.length &&
    (
      currentMatches.length === 1 ||
      currentMatches[0].score > currentMatches[1].score
    )
  ) {
    return currentMatches[0].product;
  }

  return findProductFromRecentContext(senderId);
}

function createMessengerOrder(senderId, customerText, messageId) {
  const id = String(senderId || '').trim();
  if (!id) throw new Error('Customer sender ID is required');

  if (messageId) {
    const existing = db.orders.find(
      order => order.sourceMessageId === messageId
    );

    if (existing) return { order: existing, created: false };
  }

  const customer = db.customers[id] || {};
  const product = identifyOrderedProduct(id, customerText);

  const order = {
    id: 'order_' + crypto.randomUUID(),
    senderId: id,
    customerId: id,
    customerName: customer.name || `Customer ${id.slice(-4)}`,
    customerPhone: customer.phone || null,
    productId: product?.id || null,
    productName: product?.name || null,
    productPrice: product?.price ?? null,
    quantity: 1,
    customerMessage: String(customerText || '').trim(),
    source: 'MESSENGER',
    sourceMessageId: messageId || null,
    status: 'PENDING_CONFIRMATION',
    humanTakeover: true,
    createdAt: new Date().toISOString()
  };

  db.orders.push(order);

  if (!db.customers[id]) {
    db.customers[id] = {
      id,
      name: `Customer ${id.slice(-4)}`,
      messageCount: 0,
      lastActive: new Date().toISOString()
    };
  }

  db.customers[id].lastOrderId = order.id;
  db.customers[id].lastOrderAt = order.createdAt;

  cancelFollowup(id);

  if (!saveStorage()) {
    db.orders = db.orders.filter(item => item.id !== order.id);
    throw new Error('Could not persist the customer order');
  }

  return { order, created: true };
}

// =============================================================================
// 13. HUMAN TAKEOVER
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
      name: `Customer ${id.slice(-4)}`,
      messageCount: 0
    };
  }

  db.customers[id].isPaused = isEnabled;
  db.customers[id].takeover = isEnabled;
  db.customers[id].takeoverUpdatedAt = timestamp;

  if (isEnabled) cancelFollowup(id);

  if (!saveStorage()) {
    console.error('[Takeover] Failed to persist state');
  }

  console.log(
    `[Takeover] ${id}: ${isEnabled ? 'PAUSED' : 'ACTIVE'}`
  );

  return isEnabled;
}

async function transferToHuman(senderId, reason, customMessage) {
  await setTakeoverState(
    senderId,
    true,
    reason || 'Critical issue requiring human support'
  );

  const message = customMessage ||
    `আপনার বিষয়টি আমাদের প্রতিনিধির সহায়তা প্রয়োজন। আমি কথোপকথনটি প্রতিনিধির কাছে হস্তান্তর করছি। এখন থেকে প্রতিনিধি উত্তর দেবেন। জরুরি প্রয়োজনে হেল্পলাইন: ${HELPLINE}। WhatsApp: ${WHATSAPP_NUMBER}।`;

  return sendFacebookMessage(senderId, message);
}

// =============================================================================
// 14. MESSENGER SEND AND RESPONSE LENGTH
// =============================================================================

function limitToFiveLines(text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length <= MAX_AI_LINES) return lines.join('\n');

  return lines.slice(0, MAX_AI_LINES).join('\n');
}

async function sendFacebookMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('[Messenger] PAGE_ACCESS_TOKEN is missing');
    return false;
  }

  const finalText = String(text || '').trim();
  if (!finalText) return false;

  if (finalText.length > MAX_MESSENGER_TEXT_LENGTH) {
    console.error('[Messenger] Message exceeds length limit');
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
// 15. AUTOMATIC FOLLOW-UP SCHEDULER
// =============================================================================

// Follow-ups are persisted so pending tasks can be restored after a restart.
// A follow-up is sent only if the customer has not messaged again, no order
// exists, takeover is inactive, and the standard messaging window is valid.

function cancelFollowup(senderId) {
  const id = String(senderId || '');
  if (!id) return;

  const timer = followupTimers.get(id);
  if (timer) clearTimeout(timer);

  followupTimers.delete(id);

  if (db.scheduledFollowups[id]) {
    delete db.scheduledFollowups[id];
    saveStorage();
  }
}

function customerHasOrder(senderId) {
  const id = String(senderId || '');

  return db.orders.some(order =>
    String(order.senderId || order.customerId || '') === id &&
    !['CANCELLED', 'CANCELED', 'REJECTED'].includes(
      String(order.status || '').toUpperCase()
    )
  );
}

function scheduleFollowup(senderId, lastCustomerMessageAt = Date.now()) {
  const id = String(senderId || '');
  if (!id) return;

  cancelFollowup(id);

  if (getTakeoverState(id) || customerHasOrder(id)) return;

  const customer = db.customers[id] || {};
  const lastAt = new Date(lastCustomerMessageAt).getTime();

  if (!Number.isFinite(lastAt)) return;

  db.scheduledFollowups[id] = {
    senderId: id,
    dueAt: lastAt + FOLLOWUP_DELAY_MS,
    lastCustomerMessageAt: lastAt,
    lastMessageId: customer.lastMessageId || null,
    status: 'PENDING'
  };

  saveStorage();
  armFollowupTimer(id);
}

function armFollowupTimer(senderId) {
  const id = String(senderId || '');
  const task = db.scheduledFollowups[id];

  if (!task || task.status !== 'PENDING') return;

  const existing = followupTimers.get(id);
  if (existing) clearTimeout(existing);

  const delay = Math.max(0, Number(task.dueAt) - Date.now());

  const timer = setTimeout(async () => {
    followupTimers.delete(id);
    await executeFollowup(id);
  }, Math.min(delay, 2147483647));

  if (typeof timer.unref === 'function') timer.unref();

  followupTimers.set(id, timer);
}

async function executeFollowup(senderId) {
  const id = String(senderId || '');
  const task = db.scheduledFollowups[id];

  if (!task || task.status !== 'PENDING') return;

  const customer = db.customers[id];

  if (!customer || getTakeoverState(id) || customerHasOrder(id)) {
    delete db.scheduledFollowups[id];
    saveStorage();
    return;
  }

  const dueAt = Number(task.dueAt);
  if (Date.now() < dueAt) {
    armFollowupTimer(id);
    return;
  }

  const lastCustomerAt = new Date(
    customer.lastCustomerMessageAt || customer.lastActive || 0
  ).getTime();

  // Do not send outside the standard 24-hour customer-service window.
  // If the saved timestamp is missing or invalid, fail closed.
  if (
    !Number.isFinite(lastCustomerAt) ||
    lastCustomerAt <= 0 ||
    Date.now() - lastCustomerAt >= 24 * 60 * 60 * 1000
  ) {
    delete db.scheduledFollowups[id];
    saveStorage();
    console.log(`[FOLLOWUP] Skipped ${id}: messaging window expired`);
    return;
  }

  // If a newer message was received, the older follow-up is stale.
  if (lastCustomerAt > Number(task.lastCustomerMessageAt || 0)) {
    scheduleFollowup(id, lastCustomerAt);
    return;
  }

  const sent = await sendFacebookMessage(id, FOLLOWUP_MESSAGE);

  task.status = sent ? 'SENT' : 'FAILED';
  task.sentAt = new Date().toISOString();
  task.result = sent ? 'sent' : 'send_failed';

  saveStorage();

  console.log(
    `[FOLLOWUP] ${id}: ${sent ? 'sent' : 'failed'}`
  );
}

function restoreFollowupTasks() {
  for (const [senderId, task] of Object.entries(db.scheduledFollowups)) {
    if (!task || task.status !== 'PENDING') continue;

    if (getTakeoverState(senderId) || customerHasOrder(senderId)) {
      delete db.scheduledFollowups[senderId];
      continue;
    }

    armFollowupTimer(senderId);
  }

  saveStorage();
}

// =============================================================================
// 16. GITHUB CATALOG SYNC
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
// 17. AI SYSTEM PROMPT
// =============================================================================

function buildSystemPrompt(
  relevantProducts,
  relevantFaqs,
  history,
  memoryContext
) {
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
আপনি ImpoTech BD ফেসবুক পেজের বিক্রয় সহকারী ও কাস্টমার সাপোর্ট অ্যাসিস্ট্যান্ট।

হেল্পলাইন: ${HELPLINE}
WhatsApp: ${WHATSAPP_NUMBER}
ঠিকানা: ভাওয়াল গড়, ভবানীপুর, জয়দেবপুর, গাজীপুর।

ডেলিভারি:
- গাজীপুরের ভেতরে ৫০ টাকা।
- গাজীপুরের বাইরে ১০০ টাকা।

কঠোর নিয়ম:
১. সহজ, স্বাভাবিক ও ভদ্র বাংলায় উত্তর দিন। গ্রাহক ইংরেজিতে লিখলে ইংরেজিতে উত্তর দিতে পারেন।
২. প্রতিটি উত্তর সর্বোচ্চ ৫টি লাইনে রাখুন। অপ্রয়োজনীয় ব্যাখ্যা দেবেন না।
৩. ক্যাটালগের বাইরে দাম, স্টক, ওয়ারেন্টি বা বৈশিষ্ট্য বানিয়ে বলবেন না।
৪. পণ্যের দাম কেবল ক্যাটালগ থেকে বলবেন। সঠিক পণ্য শনাক্ত না হলে অনুমান করবেন না।
৫. প্রশ্ন অস্পষ্ট হলে একটি সংক্ষিপ্ত প্রশ্ন করুন।
৬. শেষ ২০টি বার্তার পাশাপাশি নিচের সংরক্ষিত গ্রাহক মেমোরিও ব্যবহার করুন।
৭. পণ্যের নাম, ID, দাম বা মিডিয়া URL পরিবর্তন করবেন না।
৮. বিক্রয়ের ক্ষেত্রে কাস্টমারকে চাপ দেবেন না।
৯. অর্ডারের অনুরোধ শনাক্ত হলে ব্যাকএন্ড অর্ডার সংরক্ষণ করে Human Takeover চালু করবে।
১০. সাধারণ প্রশ্নের জন্য Human Takeover চাইবেন না।
১১. H4 Compatibility নিশ্চিত না হলে অনুমানকে নিশ্চিত তথ্য হিসেবে বলবেন না।
১২. বাইকের মডেল, উৎপাদন সাল বা Variant প্রয়োজন হলে জিজ্ঞেস করুন।
১৩. কাস্টমার নিজে H4 Socket নিশ্চিত করলে একই প্রশ্ন আবার করবেন না।
১৪. গুরুতর অভিযোগ, নিরাপত্তা বা পেমেন্ট সমস্যা সত্যিই মানব সহায়তা চাইলে উত্তরের শুরুতে ${HANDOVER_MARKER} লিখুন।
১৫. মার্কারটি কাস্টমারের কাছে পাঠানো হবে না; ব্যাকএন্ড এটি শনাক্ত করবে।
১৬. Takeover চালু থাকলে AI-এর উত্তর পাঠানো হবে না।
১৭. গ্রাহকের ব্যক্তিগত তথ্য অপ্রয়োজনে প্রকাশ করবেন না।
১৮. সংরক্ষিত মেমোরিতে তথ্য না থাকলে সেটি আছে বলে দাবি করবেন না।

সংরক্ষিত গ্রাহক মেমোরি:
${memoryContext || 'কোনো মেমোরি নেই।'}

প্রাসঙ্গিক পণ্য:
${productContext}

প্রাসঙ্গিক FAQ:
${faqContext}

পূর্ববর্তী কথোপকথন:
${historyContext}
  `.trim();
}

// =============================================================================
// 18. OPENROUTER AI
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

async function generateAIResponse(
  customerText,
  attachments = [],
  senderId
) {
  const query = customerText || 'ছবিটি বা পাঠানো ফাইলটি দেখে সাহায্য করুন';

  const history = getHistory(senderId).slice();

  // Incoming customer message is already stored.
  if (
    history.length &&
    history[history.length - 1].role === 'user' &&
    history[history.length - 1].text === query
  ) {
    history.pop();
  }

  const context = getRecentConversationText(senderId, query);
  const memoryContext = buildCustomerMemoryContext(senderId);

  const systemPrompt = buildSystemPrompt(
    findRelevantProducts(context),
    findRelevantFaqs(context),
    history,
    memoryContext
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

      const reply = await callOpenRouter([
        { role: 'system', content: systemPrompt },
        ...priorMessages,
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'গ্রাহকের ভয়েস বুঝে বাংলায় সর্বোচ্চ ৫ লাইনে উত্তর দিন।'
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

      return limitToFiveLines(reply);
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

      const reply = await callOpenRouter([
        { role: 'system', content: systemPrompt },
        ...priorMessages,
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `${query}\nছবিটি দেখে সাহায্য করুন। ` +
                'যা নিশ্চিতভাবে বোঝা যায় না তা অনুমান করবেন না। সর্বোচ্চ ৫ লাইনে উত্তর দিন।'
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

      return limitToFiveLines(reply);
    } catch (err) {
      console.error('[VISION] Processing failed:', err.message);
    }
  }

  const reply = await callOpenRouter([
    { role: 'system', content: systemPrompt },
    ...priorMessages,
    { role: 'user', content: query }
  ]);

  return limitToFiveLines(reply);
}

// =============================================================================
// 19. CRITICAL HANDOVER
// =============================================================================

function isCriticalHandoverQuestion(text = '') {
  const value = normalizeText(text);

  return (
    /প্রতারণা|fraud|scam|আইনগত ব্যবস্থা|legal action|মামলা|মারাত্মক দুর্ঘটনা|serious injury|আগুন লেগেছে|fire hazard|ব্যাটারি বিস্ফোরণ|battery exploded|চার্জে আগুন|payment deducted twice|দুইবার টাকা কাটা|ভুল পেমেন্ট|টাকা কেটে নিয়েছে/.test(value)
  );
}

// =============================================================================
// 20. CUSTOMER MESSAGE PROCESSING
// =============================================================================

async function processCustomerMessage(
  senderId,
  text,
  attachments = [],
  messageId = null
) {
  if (getTakeoverState(senderId)) {
    console.log(`[Takeover] ${senderId} paused; AI skipped`);
    return;
  }

  const customerText = String(text || '').trim();

  try {
    // 1. ORDER INTENT
    if (isExplicitOrderIntent(customerText)) {
      const result = createMessengerOrder(
        senderId,
        customerText,
        messageId
      );

      if (!result.created) {
        await setTakeoverState(
          senderId,
          true,
          `Order already exists: ${result.order.id}`
        );
        return;
      }

      const order = result.order;

      await setTakeoverState(
        senderId,
        true,
        `Automatic takeover after order ${order.id}`
      );

      console.log(
        `[ORDER] ${order.id} created for ${senderId}; ` +
        `product=${order.productName || 'not identified'}`
      );

      const sent = await sendFacebookMessage(
        senderId,
        ORDER_CONFIRMATION
      );

      if (!sent) {
        console.error(
          `[ORDER] ${order.id} saved, but confirmation could not be sent`
        );
      }

      return;
    }

    // 2. CRITICAL ISSUES
    if (isCriticalHandoverQuestion(customerText)) {
      await transferToHuman(
        senderId,
        'Critical customer issue',
        `আপনার বিষয়টি গুরুত্ব দিয়ে দেখা প্রয়োজন। আমি কথোপকথনটি আমাদের প্রতিনিধির কাছে হস্তান্তর করছি। হেল্পলাইন: ${HELPLINE}। WhatsApp: ${WHATSAPP_NUMBER}।`
      );
      return;
    }

    // 3. MOTORCYCLE / H4
    if (isBikeCompatibilityQuestion(customerText)) {
      const context = getRecentConversationText(senderId, customerText);
      const match = identifyBikeModel(context);
      const verifiedReply = getH4CompatibilityReply(match);

      if (verifiedReply) {
        await sendFacebookMessage(senderId, limitToFiveLines(verifiedReply));
        return;
      }

      if (customerConfirmedH4(senderId, customerText)) {
        const reply = await generateAIResponse(
          customerText,
          attachments,
          senderId
        );

        if (reply.includes(HANDOVER_MARKER)) {
          await sendFacebookMessage(
            senderId,
            'আপনি জানিয়েছেন যে আপনার বাইকে H4 Socket আছে। পণ্যের মডেল বা Connector-এর তথ্যটি জানালে বাকি Compatibility মিলিয়ে বলতে পারব।'
          );
          return;
        }

        if (!getTakeoverState(senderId)) {
          await sendFacebookMessage(senderId, limitToFiveLines(reply));
        }

        return;
      }

      const clarification = getBikeClarificationReply(
        senderId,
        customerText
      );

      if (clarification) {
        await sendFacebookMessage(senderId, limitToFiveLines(clarification));
        return;
      }

      const bikeReply = await generateAIResponse(
        customerText,
        attachments,
        senderId
      );

      if (bikeReply.includes(HANDOVER_MARKER)) {
        await sendFacebookMessage(
          senderId,
          'বাইকের মডেল ও সাল বুঝতে পেরেছি। নিশ্চিতভাবে Socket মিলিয়ে বলতে Original Headlight Socket-এর ছবি বা Socket-এর লেখা পাঠাতে পারবেন?'
        );
        return;
      }

      if (!getTakeoverState(senderId)) {
        await sendFacebookMessage(senderId, limitToFiveLines(bikeReply));
      }

      return;
    }

    // 4. PRICE QUESTIONS
    if (isPriceQuestion(customerText)) {
      let product = findExactProductForPrice(customerText);

      // Generic "price?" messages use the most recent explicit product.
      if (!product && isGenericPriceQuestion(customerText)) {
        product = findProductFromRecentContext(senderId);
      }

      if (!product) {
        await sendFacebookMessage(
          senderId,
          getPriceClarificationReply()
        );
        return;
      }

      const priceReply = getPriceReply(product);

      if (!priceReply) {
        await sendFacebookMessage(
          senderId,
          `দুঃখিত, ${product.name}-এর দাম বর্তমানে ক্যাটালগে উল্লেখ নেই।`
        );
        return;
      }

      await sendFacebookMessage(senderId, limitToFiveLines(priceReply));
      return;
    }

    // 5. PRODUCT MEDIA
    if (isMediaRequest(customerText)) {
      const mediaReply = getProductMediaReply(customerText, senderId);

      if (mediaReply) {
        await sendFacebookMessage(senderId, limitToFiveLines(mediaReply));
        return;
      }
    }

    // 6. NORMAL AI RESPONSE
    let aiReply = await generateAIResponse(
      customerText,
      attachments,
      senderId
    );

    if (!aiReply) throw new Error('AI returned an empty response');

    if (aiReply.includes(HANDOVER_MARKER)) {
      const explanation = aiReply
        .replaceAll(HANDOVER_MARKER, '')
        .trim();

      if (isCriticalHandoverQuestion(customerText)) {
        await transferToHuman(
          senderId,
          'AI identified a critical support issue',
          explanation
            ? `${limitToFiveLines(explanation)}\nআমি বিষয়টি প্রতিনিধির কাছে হস্তান্তর করছি। হেল্পলাইন: ${HELPLINE}। WhatsApp: ${WHATSAPP_NUMBER}।`
            : undefined
        );
        return;
      }

      await sendFacebookMessage(
        senderId,
        limitToFiveLines(
          explanation ||
          'আপনার প্রশ্নটি আরও ভালোভাবে বুঝতে একটি তথ্য জানতে চাই। আপনি কোন পণ্য বা মডেলটির কথা বলছেন?'
        )
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
        'আগের উত্তরে বিষয়টি জানিয়েছি। কোন অংশটি আরও পরিষ্কার করতে হবে বলুন, আমি সাহায্য করছি।';
    }

    // Recheck takeover immediately before sending.
    if (getTakeoverState(senderId)) return;

    await sendFacebookMessage(senderId, limitToFiveLines(aiReply));
  } catch (err) {
    console.error('[AI] Response error:', err.message);

    if (getTakeoverState(senderId)) return;

    await sendFacebookMessage(
      senderId,
      'দুঃখিত, এই মুহূর্তে উত্তর তৈরি করতে সমস্যা হচ্ছে। একটু পরে আবার লিখবেন? জরুরি প্রয়োজনে হেল্পলাইন: ' +
      HELPLINE +
      '। WhatsApp: ' +
      WHATSAPP_NUMBER +
      '।'
    );
  }
       }
// =============================================================================
// 21. FACEBOOK WEBHOOK
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
  // Acknowledge Meta immediately to prevent webhook retries.
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

        if (messageId && processedMessageIds.has(messageId)) {
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
            // Persistent duplicate guard after a restart.
            if (
              messageId &&
              db.messages.some(item => item.messageId === messageId)
            ) {
              return;
            }

            const nowIso = new Date().toISOString();
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
              timestamp: nowIso,
              messageId: messageId || null
            });

            if (!db.customers[senderId]) {
              db.customers[senderId] = {
                id: senderId,
                name: `Customer ${senderId.slice(-4)}`,
                messageCount: 1,
                lastActive: nowIso,
                lastCustomerMessageAt: nowIso,
                lastMessageId: messageId || null,
                isPaused,
                takeover: isPaused,
                lastMessageText: text || '[Media]'
              };
            } else {
              const customer = db.customers[senderId];

              customer.messageCount =
                (customer.messageCount || 0) + 1;

              customer.lastActive = nowIso;
              customer.lastCustomerMessageAt = nowIso;
              customer.lastMessageId = messageId || null;
              customer.lastMessageText = text || '[Media]';
            }

            // Keep a persistent customer memory in addition to history.
            if (text) updateCustomerMemory(senderId, text);

            // A new customer message invalidates the old follow-up.
            // Schedule a new follow-up only if takeover/order rules allow it.
            if (!isPaused && !customerHasOrder(senderId)) {
              scheduleFollowup(senderId, Date.now());
            } else {
              cancelFollowup(senderId);
            }

            if (!saveStorage()) {
              console.error('[Webhook] Failed to persist incoming message');
            }

            if (isPaused) {
              console.log(
                `[Takeover] ${senderId} paused; AI response skipped`
              );
              return;
            }

            await processCustomerMessage(
              senderId,
              text,
              attachments,
              messageId || null
            );
          });

        customerQueues.set(senderId, currentTask);

        currentTask.finally(() => {
          if (customerQueues.get(senderId) === currentTask) {
            customerQueues.delete(senderId);
          }
        }).catch(err => {
          console.error('[Webhook] Customer task failed:', err.message);
        });
      }
    }
  } catch (err) {
    console.error('[Webhook] Processing error:', err.message);
  }
});

// =============================================================================
// 22. CATALOG ADMIN API
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
        `Catalog processed: ${products.length} products, ${faqs.length} FAQs`,
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
// 23. BOT STATUS AND TAKEOVER APIs
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

  if (db.isGlobalPaused) {
    for (const senderId of Object.keys(db.scheduledFollowups)) {
      cancelFollowup(senderId);
    }
  }

  const saved = saveStorage();

  res.json({
    success: saved,
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
// 24. CUSTOMERS, MESSAGES, MEMORY AND ORDERS APIs
// =============================================================================

app.get('/api/customers', (req, res) => {
  const list = Object.values(db.customers).map(customer => ({
    senderId: customer.id,
    displayName:
      customer.name || `Customer ${String(customer.id).slice(-4)}`,
    phone: customer.phone || null,
    lastMessageText: customer.lastMessageText || null,
    lastMessageAt: customer.lastActive || null,
    messageCount: customer.messageCount || 0,
    lastOrderId: customer.lastOrderId || null,
    lastOrderAt: customer.lastOrderAt || null,
    takeover: getTakeoverState(customer.id),
    isPaused: getTakeoverState(customer.id),
    takeoverReason: db.takeovers[customer.id]?.reason || null,
    takeoverUpdatedAt: db.takeovers[customer.id]?.timestamp || null,
    memoryUpdatedAt: customer.lastMemoryUpdatedAt || null
  }));

  res.json({
    success: true,
    total: list.length,
    data: list
  });
});

// New API: inspect one customer's saved memory.
app.get('/api/customers/:senderId/memory', (req, res) => {
  const senderId = String(req.params.senderId);
  const memory = db.customerMemory[senderId] || null;

  res.json({
    success: true,
    senderId,
    memory
  });
});

// New API: update customer memory from the admin panel.
app.put('/api/customers/:senderId/memory', (req, res) => {
  const senderId = String(req.params.senderId);
  const body = req.body || {};
  const memory = getCustomerMemory(senderId);

  if (Array.isArray(body.facts)) {
    memory.facts = body.facts
      .filter(value => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean)
      .slice(-30);
  }

  if (Array.isArray(body.preferences)) {
    memory.preferences = body.preferences
      .filter(value => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean)
      .slice(-20);
  }

  if (typeof body.summary === 'string') {
    memory.summary = body.summary.slice(0, 3000);
  }

  memory.updatedAt = new Date().toISOString();

  if (!saveStorage()) {
    return res.status(500).json({
      success: false,
      message: 'Could not save customer memory'
    });
  }

  res.json({
    success: true,
    senderId,
    memory
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
  const status = req.query.status
    ? String(req.query.status)
    : null;

  const senderId = req.query.senderId
    ? String(req.query.senderId)
    : null;

  let orders = db.orders;

  if (status) {
    orders = orders.filter(
      order => String(order.status) === status
    );
  }

  if (senderId) {
    orders = orders.filter(
      order => String(order.senderId || order.customerId) === senderId
    );
  }

  res.json({
    success: true,
    total: orders.length,
    data: orders.slice().reverse()
  });
});

app.post('/api/orders', (req, res) => {
  const order = req.body || {};

  const senderId = String(
    order.senderId || order.customerId || ''
  ).trim();

  if (!senderId) {
    return res.status(400).json({
      success: false,
      message: 'senderId or customerId is required'
    });
  }

  if (
    order.sourceMessageId &&
    db.orders.some(item =>
      item.sourceMessageId === order.sourceMessageId
    )
  ) {
    return res.status(200).json({
      success: true,
      duplicate: true,
      order: db.orders.find(item =>
        item.sourceMessageId === order.sourceMessageId
      )
    });
  }

  const newOrder = {
    ...order,
    senderId,
    customerId: senderId,
    id: order.id || 'order_' + crypto.randomUUID(),
    status: order.status || 'PENDING',
    createdAt: order.createdAt || new Date().toISOString()
  };

  db.orders.push(newOrder);

  if (!saveStorage()) {
    db.orders = db.orders.filter(item => item.id !== newOrder.id);

    return res.status(500).json({
      success: false,
      message: 'Could not save order'
    });
  }

  cancelFollowup(senderId);

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

  res.json({ success: true, order });
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

  const oldOrder = db.orders[index];

  db.orders[index] = {
    ...oldOrder,
    ...req.body,
    id: oldOrder.id,
    updatedAt: new Date().toISOString()
  };

  if (!saveStorage()) {
    db.orders[index] = oldOrder;

    return res.status(500).json({
      success: false,
      message: 'Could not update order'
    });
  }

  if (customerHasOrder(oldOrder.senderId || oldOrder.customerId)) {
    cancelFollowup(oldOrder.senderId || oldOrder.customerId);
  }

  res.json({ success: true, order: db.orders[index] });
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

  if (!saveStorage()) {
    db.orders.splice(index, 0, removed);

    return res.status(500).json({
      success: false,
      message: 'Could not delete order'
    });
  }

  res.json({
    success: true,
    deleted: removed.id
  });
});

// Admin sends a message from the admin chat UI.
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
// 25. HEALTH, STATUS AND MEDIA DIAGNOSTICS
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
    customers: Object.keys(db.customers).length,
    messages: db.messages.length,
    orders: db.orders.length,
    customerMemories: Object.keys(db.customerMemory).length,
    pendingFollowups: Object.values(db.scheduledFollowups)
      .filter(task => task && task.status === 'PENDING').length,
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
// 26. START SERVER
// =============================================================================

async function startServer() {
  await pullCatalogFromGitHub();

  // Restore scheduled follow-ups from storage after restart.
  restoreFollowupTasks();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] ImpoTech Master Bot running on port ${PORT}`);

    console.log(
      `[CATALOG] ${products.length} products, ` +
      `${faqs.length} FAQs; source=${catalogMeta.source}`
    );

    console.log(`[CONTACT] Helpline: ${HELPLINE}`);
    console.log(`[CONTACT] WhatsApp: ${WHATSAPP_NUMBER}`);
    console.log(`[MEMORY] Last ${HISTORY_LIMIT} messages + persistent customer memory`);
    console.log('[FOLLOWUP] Scheduled follow-up enabled');

    if (catalogMeta.lastSyncError) {
      console.warn('[CATALOG] GitHub warning: ' + catalogMeta.lastSyncError);
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

// =============================================================================
// 27. CLEANUP AND PERIODIC FOLLOW-UP VALIDATION
// =============================================================================

setInterval(() => {
  const cutoff = Date.now() - DUPLICATE_WINDOW_MS;

  for (const [id, timestamp] of processedMessageIds) {
    if (timestamp < cutoff) processedMessageIds.delete(id);
  }
}, 60 * 1000).unref();

// Periodic validation helps remove stale follow-ups and restore overdue tasks.
setInterval(() => {
  for (const [senderId, task] of Object.entries(db.scheduledFollowups)) {
    if (!task || task.status !== 'PENDING') continue;

    if (getTakeoverState(senderId) || customerHasOrder(senderId)) {
      cancelFollowup(senderId);
      continue;
    }

    if (!followupTimers.has(senderId)) {
      armFollowupTimer(senderId);
    }
  }
}, FOLLOWUP_CHECK_INTERVAL_MS).unref();
