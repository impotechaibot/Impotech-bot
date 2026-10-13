'use strict';

/**
 * =============================================================================
 * IMPOTECH AI MESSENGER BOT & ADMIN BACKEND
 * =============================================================================
 * AI TEXT   : Google Gemini 2.5 Flash Lite via OpenRouter
 * AI VOICE  : Google Gemini 2.5 Flash Lite via OpenRouter
 * AI VISION : Google Gemini 2.5 Flash Lite via OpenRouter
 * CATALOG   : GitHub catalog.json + Local cache
 * STORAGE   : storage_data.json
 * MEMORY    : Persistent customer memory + last 20 messages
 * FOLLOW-UP : Scheduled after approximately 23 hours
 * HUMAN     : Persistent per-customer + global takeover
 * ORDER     : Persistent order storage + multi-message order collection
 * CALL      : Human handover on supported call events
 * ADMIN     : Catalog, customers, messages, memory, orders, bot status
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
// 1. CONFIGURATION
// =============================================================================

const PORT = Number(process.env.PORT) || 10000;

const PAGE_ACCESS_TOKEN =
  process.env.PAGE_ACCESS_TOKEN ||
  process.env.META_ACCESS_TOKEN ||
  '';

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

const GITHUB_REPO =
  process.env.GITHUB_REPO || 'impotechaibot/Impotech-bot';

const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const CATALOG_FILE = process.env.CATALOG_FILE || 'data/catalog.json';

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v18.0';

const OPENROUTER_URL =
  'https://openrouter.ai/api/v1/chat/completions';

const TEXT_MODEL =
  process.env.TEXT_MODEL || 'google/gemini-2.5-flash-lite';

const VOICE_MODEL =
  process.env.VOICE_MODEL || 'google/gemini-2.5-flash-lite';

const VISION_MODEL =
  process.env.VISION_MODEL || 'google/gemini-2.5-flash-lite';

const HELPLINE = '+8809611042598';
const WHATSAPP_NUMBER = '01884332067';

const DATA_FILE = path.join(__dirname, 'storage_data.json');
const LOCAL_CATALOG_PATH = path.join(__dirname, 'catalog.json');

const REQUIRE_ADMIN_SECRET =
  process.env.REQUIRE_ADMIN_SECRET !== 'false';

const HISTORY_LIMIT = 20;
const MESSAGE_RETENTION_LIMIT = 20000;
const MAX_OUTPUT_TOKENS = 500;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_MESSENGER_TEXT_LENGTH = 2000;
const MAX_AI_LINES = 5;
const MAX_PRODUCTS_TO_AI = 5;
const MAX_FAQS_TO_AI = 5;

const FOLLOWUP_DELAY_MS = 23 * 60 * 60 * 1000;
const FOLLOWUP_CHECK_INTERVAL_MS = 60 * 1000;
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const CUSTOMER_RETENTION_DAYS = 20;

// Pending order collection expires after seven days.
const PENDING_ORDER_RETENTION_MS =
  7 * 24 * 60 * 60 * 1000;

const HANDOVER_MARKER = '[HANDOVER_REQUIRED]';

const ORDER_CONFIRMATION =
  'আপনার অর্ডারটি গ্রহণ করা হয়েছে। আমাদের প্রতিনিধি শীঘ্রই আপনার অর্ডারটি কনফার্ম করবেন।';

const FOLLOWUP_MESSAGE =
  'আপনি কি পণ্যটি সম্পর্কে আরও কিছু জানতে চান? কোনো প্রশ্ন থাকলে জানাবেন, আমরা সাহায্য করতে প্রস্তুত।';

// =============================================================================
// 2. CORS
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
// 3. DATABASE STATE
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
  scheduledFollowups: {},
  callEvents: [],
  pendingOrders: {}
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

  for (const key of [
    'takeovers',
    'customers',
    'customerMemory',
    'scheduledFollowups',
    'pendingOrders'
  ]) {
    if (
      !db[key] ||
      typeof db[key] !== 'object' ||
      Array.isArray(db[key])
    ) {
      db[key] = {};
    }
  }

  for (const key of ['messages', 'orders', 'callEvents']) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
}

function loadStorage() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      ensureStorageShape();
      return;
    }

    const parsed = JSON.parse(
      fs.readFileSync(DATA_FILE, 'utf8')
    );

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid storage JSON');
    }

    db = parsed;
    ensureStorageShape();

    console.log('[STORAGE] Loaded persistent storage');
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

function newId(prefix) {
  return prefix + '_' + crypto.randomUUID();
}

function customerDisplayName(senderId) {
  return 'Customer ' + String(senderId || '').slice(-4);
}

loadStorage();

// =============================================================================
// 4. CUSTOMER HISTORY
// =============================================================================

function getHistory(senderId) {
  const id = String(senderId || '');
  if (!id) return [];

  if (customerHistory.has(id)) {
    return customerHistory.get(id);
  }

  const history = db.messages
    .filter(message => String(message.senderId) === id)
    .filter(message =>
      message.role === 'user' || message.role === 'assistant'
    )
    .map(message => ({
      role: message.role,
      text: String(message.text || ''),
      timestamp: Number(message.timestamp) || Date.now()
    }))
    .slice(-HISTORY_LIMIT);

  customerHistory.set(id, history);
  return history;
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
    ...getHistory(senderId).map(item => item.text),
    additionalText
  ].filter(Boolean).join('\n');
}

function storeConversationMessage(
  senderId,
  role,
  text,
  messageId = null
) {
  const message = {
    id: newId('msg'),
    senderId: String(senderId),
    role,
    text: String(text || '').slice(0, 10000),
    messageId: messageId || null,
    timestamp: Date.now(),
    createdAt: new Date().toISOString()
  };

  addStoredMessage(message);
  appendHistory(senderId, role, message.text);

  const customer = db.customers[String(senderId)];

  if (customer) {
    customer.messageCount = Number(customer.messageCount || 0) + 1;
    customer.lastActive = new Date().toISOString();
  }

  return message;
}

// =============================================================================
// 5. PERSISTENT CUSTOMER MEMORY
// =============================================================================

function getCustomerMemory(senderId) {
  const id = String(senderId || '');
  if (!id) return null;

  if (!db.customerMemory[id]) {
    db.customerMemory[id] = {
      senderId: id,
      facts: [],
      preferences: [],
      summary: '',
      productDiscussions: [],
      updatedAt: null
    };
  }

  const memory = db.customerMemory[id];

  if (!Array.isArray(memory.facts)) memory.facts = [];
  if (!Array.isArray(memory.preferences)) memory.preferences = [];

  if (!Array.isArray(memory.productDiscussions)) {
    memory.productDiscussions = [];
  }

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

function recordProductDiscussion(
  senderId,
  product,
  customerQuestion,
  botAnswer
) {
  if (!senderId || !product) return;

  const memory = getCustomerMemory(senderId);

  memory.productDiscussions.push({
    productId: String(product.id || ''),
    productName: String(product.name || ''),
    customerQuestion: String(customerQuestion || '').slice(0, 300),
    botAnswer: String(botAnswer || '').slice(0, 400),
    at: new Date().toISOString()
  });

  if (memory.productDiscussions.length > 60) {
    memory.productDiscussions.splice(
      0,
      memory.productDiscussions.length - 60
    );
  }

  addUniqueMemoryItem(
    memory.facts,
    `আলোচিত পণ্য: ${product.name} (ID: ${product.id})`
  );

  memory.updatedAt = new Date().toISOString();
}

function updateCustomerMemory(senderId, customerText) {
  const id = String(senderId || '');
  const text = String(customerText || '').trim();

  if (!id || !text || text.length > 1000) return;

  const memory = getCustomerMemory(id);

  if (!db.customers[id]) {
    db.customers[id] = {
      id,
      name: customerDisplayName(id),
      messageCount: 0,
      lastActive: new Date().toISOString()
    };
  }

  const customer = db.customers[id];

  const phone = extractPhoneNumber(text);

  if (phone) {
    customer.phone = phone;
    addUniqueMemoryItem(memory.facts, `ফোন: ${phone}`);
  }

  const address = extractAddressText(text);

  if (address) {
    customer.address = address;
    addUniqueMemoryItem(memory.facts, `ঠিকানা: ${address}`);
  }

  const nameMatch = text.match(
    /(?:আমার নাম|my name is|name)[:\s]+([\p{L}\s.]{2,40})/iu
  );

  if (nameMatch) {
    customer.name = nameMatch[1].trim();

    addUniqueMemoryItem(
      memory.facts,
      `নাম: ${customer.name}`
    );
  }

  const matched = products
    .map(product => ({
      product,
      score: productScore(text, product)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (
    matched.length &&
    (matched.length === 1 ||
      matched[0].score > matched[1].score)
  ) {
    addUniqueMemoryItem(
      memory.facts,
      `আলোচিত পণ্য: ${matched[0].product.name} (ID: ${matched[0].product.id})`
    );
  }

  const preferences = [
    /আমার (?:বাইক|মোটরসাইকেল|গাড়ি)[^।.!?\n]{0,100}/i,
    /আমার (?:পছন্দ|বাজেট)[^।.!?\n]{0,100}/i,
    /বাজেট [^।.!?\n]{0,80}/i,
    /ডেলিভারি (?:গাজীপুর|ঢাকা|চট্টগ্রাম|সিলেট|রাজশাহী|খুলনা)[^।.!?\n]{0,80}/i
  ];

  for (const pattern of preferences) {
    const match = text.match(pattern);

    if (match) {
      addUniqueMemoryItem(memory.preferences, match[0], 20);
    }
  }

  if (
    text.length >= 8 &&
    !/^(হ্যাঁ|না|ok|okay|ধন্যবাদ|thanks)$/i.test(text)
  ) {
    const summaryLines = memory.summary
      ? memory.summary.split('\n')
      : [];

    summaryLines.push(`গ্রাহক বলেছেন: ${text.slice(0, 240)}`);

    memory.summary = summaryLines.slice(-8).join('\n');
  }

  memory.updatedAt = new Date().toISOString();
  customer.lastMemoryUpdatedAt = memory.updatedAt;

  saveStorage();
}

function buildCustomerMemoryContext(senderId) {
  const memory = getCustomerMemory(senderId);

  if (!memory) return 'কোনো সংরক্ষিত মেমোরি নেই।';

  const facts = memory.facts.slice(-15);
  const preferences = memory.preferences.slice(-10);

  const discussions = memory.productDiscussions
    .slice(-8)
    .map((item, index) =>
      `${index + 1}. পণ্য: ${item.productName}\n` +
      `গ্রাহকের প্রশ্ন: ${item.customerQuestion}\n` +
      `আগের উত্তর: ${item.botAnswer}`
    )
    .join('\n');

  return [
    facts.length ? `তথ্য:\n- ${facts.join('\n- ')}` : '',
    preferences.length
      ? `পছন্দ:\n- ${preferences.join('\n- ')}`
      : '',
    discussions ? `আগের পণ্য আলোচনা:\n${discussions}` : '',
    memory.summary ? `সারাংশ:\n${memory.summary}` : ''
  ].filter(Boolean).join('\n\n') || 'কোনো সংরক্ষিত মেমোরি নেই।';
}

function findPreviousDiscussionAboutProduct(senderId, product) {
  if (!senderId || !product) return null;

  const memory = getCustomerMemory(senderId);
  const id = String(product.id || '');

  for (
    let i = memory.productDiscussions.length - 1;
    i >= 0;
    i--
  ) {
    const entry = memory.productDiscussions[i];

    if (String(entry.productId) === id) {
      return entry;
    }
  }

  return null;
}

// =============================================================================
// 6. CATALOG LOADING AND VALIDATION
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

    if (
      product.id === undefined ||
      product.id === null ||
      String(product.id).trim() === ''
    ) {
      throw new Error('Every product must have an ID');
    }

    const id = String(product.id);

    if (ids.has(id)) {
      throw new Error(`Duplicate product ID: ${id}`);
    }

    ids.add(id);

    if (
      product.media !== undefined &&
      (!product.media || typeof product.media !== 'object')
    ) {
      throw new Error(`Invalid media object for product ${id}`);
    }
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

  validateCatalogShape(data);

  products = data.products;
  faqs = Array.isArray(data.faqs) ? data.faqs : [];

  catalogMeta = {
    version: data.version ?? null,
    updatedAt: data.updatedAt ?? null,
    source: 'local',
    lastSyncAt: null,
    lastSyncError: null
  };

  return data;
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

function replaceCatalogAtomically(data, source = 'admin') {
  validateCatalogShape(data);

  const normalized = {
    ...data,
    version: data.version ?? Date.now(),
    updatedAt: data.updatedAt ?? new Date().toISOString(),
    products: data.products,
    faqs: Array.isArray(data.faqs) ? data.faqs : []
  };

  saveLocalCatalog(normalized, source);

  console.log(
    `[CATALOG] Replaced from ${source}: ` +
    `${products.length} products, ${faqs.length} FAQs`
  );

  return normalized;
}

try {
  loadLocalCatalog();
} catch (err) {
  console.error('[CATALOG] Local catalog error:', err.message);
}

// =============================================================================
// 7. ADMIN AUTHENTICATION
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
// 8. PRODUCT AND FAQ SEARCH
// =============================================================================

function fieldValues(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null) return [];
  return [String(value)];
}

function scoreRecord(query, record, fields) {
  const q = normalizeText(query);
  const tokens = tokenize(q);

  if (!tokens.length || !record) return 0;

  let score = 0;

  for (const field of fields) {
    const values = fieldValues(record[field])
      .map(normalizeText)
      .filter(Boolean);

    for (const value of values) {
      if (value === q) {
        score += field === 'name' || field === 'id' ? 30 : 20;
      } else if (value.includes(q)) {
        score += 12;
      }

      for (const token of tokens) {
        if (value.includes(token)) score += 2;
      }
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
// 9. EXACT PRODUCT AND PRICE PROTECTION
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
    return getProductIdentifiers(product).some(identifier => {
      return identifier === q ||
        (
          identifier.length >= 3 &&
          new RegExp(
            `(^|\\s)${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`
          ).test(q)
        );
    });
  });

  return matches.length === 1 ? matches[0] : null;
}

function findProductFromRecentContext(senderId) {
  const history = getHistory(senderId);

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'user') continue;

    const product = findExactProductForPrice(history[i].text);

    if (product) return product;
  }

  const memory = getCustomerMemory(senderId);

  for (const discussion of memory.productDiscussions.slice().reverse()) {
    const product = products.find(
      item => String(item.id) === String(discussion.productId)
    );

    if (product) return product;
  }

  return null;
}

function getPriceReply(product) {
  if (
    !product ||
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
// 10. MOTORCYCLE BULB COMPATIBILITY
// =============================================================================

const BUILTIN_BIKE_DATABASE = [
  {
    brand: 'Yamaha',
    model: 'FZ',
    aliases: ['fz', 'fz-s', 'fz s', 'fz16', 'fz 16', 'fzs']
  },
  {
    brand: 'Yamaha',
    model: 'FZ25',
    aliases: ['fz25', 'fz 25']
  },
  {
    brand: 'Yamaha',
    model: 'R15',
    aliases: ['r15', 'r 15', 'r15 v2', 'r15 v3', 'r15 v4']
  },
  {
    brand: 'Yamaha',
    model: 'MT-15',
    aliases: ['mt15', 'mt 15']
  },
  {
    brand: 'Bajaj',
    model: 'Pulsar 150',
    aliases: ['pulsar 150', 'pulsar150', 'p150']
  },
  {
    brand: 'Bajaj',
    model: 'Pulsar NS200',
    aliases: ['ns200', 'ns 200', 'pulsar ns200']
  },
  {
    brand: 'TVS',
    model: 'Apache RTR 160',
    aliases: ['apache rtr 160', 'rtr160', 'apache 160']
  },
  {
    brand: 'TVS',
    model: 'Apache RTR 200',
    aliases: ['apache rtr 200', 'rtr200']
  },
  {
    brand: 'Hero',
    model: 'Splendor',
    aliases: ['splendor', 'splendor plus']
  },
  {
    brand: 'Honda',
    model: 'CB Shine',
    aliases: ['cb shine', 'cbshine', 'shine']
  },
  {
    brand: 'Suzuki',
    model: 'Gixxer',
    aliases: ['gixxer', 'gixxer 150', 'gixxer sf']
  }
];

function identifyBikeModel(text = '') {
  const value = normalizeText(text);

  for (const entry of BUILTIN_BIKE_DATABASE) {
    const identifiers = [
      `${entry.brand} ${entry.model}`,
      entry.model,
      ...(entry.aliases || [])
    ].map(normalizeText);

    if (identifiers.some(identifier =>
      identifier.length >= 3 && value.includes(identifier)
    )) {
      return {
        entry,
        verified: false
      };
    }
  }

  return null;
}

function getCatalogBikeCompatibility(text = '') {
  const value = normalizeText(text);
  const matches = [];

  for (const product of products) {
    const entries = Array.isArray(product.bikeCompatibility)
      ? product.bikeCompatibility
      : product.bikeCompatibility
        ? [product.bikeCompatibility]
        : [];

    for (const entry of entries) {
      if (!entry || entry.verified !== true) continue;

      const identifiers = [
        `${entry.brand || ''} ${entry.model || ''}`,
        entry.model,
        ...(Array.isArray(entry.aliases) ? entry.aliases : [])
      ].map(normalizeText).filter(Boolean);

      if (identifiers.some(identifier =>
        identifier.length >= 3 && value.includes(identifier)
      )) {
        matches.push(entry);
      }
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

function isBikeCompatibilityQuestion(text = '') {
  const value = normalizeText(text);

  const lighting =
    /h4|hs1|h6m|h7|h11|h13|headlight|head lamp|হেডলাইট|বাল্ব|socket|সকেট|plug and play|ফিট হবে/.test(value);

  const bike =
    /বাইক|মোটরসাইকেল|motorcycle|motorbike|bike|মডেল|model|সাল|বছর|year|ফিট|fit|সাপোর্ট|support/.test(value);

  return lighting && bike;
}

function getBikeClarificationReply() {
  return 'আপনার বাইকের ব্র্যান্ড, সঠিক মডেল ও সাল জানাবেন? সম্ভব হলে বর্তমান বাল্বের বেস/সকেটের ছবিও দিন। যাচাই করে ফিটমেন্ট জানাতে পারব।';
}

function getH4CompatibilityReply(text = '') {
  const match = getCatalogBikeCompatibility(text);

  if (match) {
    if (match.originalH4Socket === false) {
      return 'ক্যাটালগ অনুযায়ী এই মডেলের স্টক সকেট আমাদের LED হেডলাইটের সঙ্গে সরাসরি মেলে না। সঠিক অ্যাডাপ্টার বা বিকল্প যাচাই করা দরকার।';
    }

    if (
      match.originalH4Socket === true &&
      match.ledPlugAndPlay === true
    ) {
      return 'ক্যাটালগে এই বাইকের ফিটমেন্ট যাচাই করা আছে। আপনার বাইকের সাল ও বর্তমান সকেট মিলিয়ে নিলে সরাসরি ফিটমেন্ট নিশ্চিত করা যাবে।';
    }
  }

  return getBikeClarificationReply();
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
  return getMediaType(text) !== null;
}

function isFacebookLink(url) {
  try {
    const parsed = new URL(url);

    return (
      parsed.protocol === 'https:' &&
      (
        parsed.hostname === 'facebook.com' ||
        parsed.hostname.endsWith('.facebook.com') ||
        parsed.hostname === 'fb.watch' ||
        parsed.hostname.endsWith('.fb.watch')
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

  const candidates = products
    .map(product => ({
      product,
      score: productScore(query, product)
    }))
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
    return `দুঃখিত, ${product.name}-এর ${mediaType === 'images' ? 'ছবি' : 'ভিডিও'} লিংক ক্যাটালগে পাওয়া যাচ্ছে না।`;
  }

  const label = mediaType === 'images' ? 'ছবি' : 'ভিডিও';

  return `অবশ্যই! ${product.name}-এর ${label} লিংক:\n` +
    urls.map((url, index) => `${index + 1}. ${url}`).join('\n');
}

// =============================================================================
// 12. PHONE, ADDRESS AND ORDER HELPERS
// =============================================================================

function extractPhoneNumber(text = '') {
  const match = String(text).match(
    /(?:\+?8801|01)[0-9\s-]{8,14}/
  );

  if (!match) return null;

  let phone = match[0].replace(/[\s-]/g, '');

  if (phone.startsWith('+880')) phone = phone.slice(1);

  // Normalize +8801XXXXXXXXX to 01XXXXXXXXX.
  if (/^8801\d{9}$/.test(phone)) {
    phone = '0' + phone.slice(3);
  }

  if (!/^01\d{9}$/.test(phone)) return null;

  return phone;
}

function extractAddressText(text = '') {
  const patterns = [
    /(?:আমার ঠিকানা|ডেলিভারি ঠিকানা|ঠিকানা|address|গ্রাম|বাসা|বাজার|রোড|road|village|house|জেলা|জিলা|district)\s*[:：-]?\s*[^\n।.!?]{2,160}/i,
    /(?:গাজীপুর|ঢাকা|চট্টগ্রাম|সিলেট|রাজশাহী|খুলনা|বরিশাল|রংপুর|ময়মনসিংহ)[^\n।.!?]{2,160}/i
  ];

  for (const pattern of patterns) {
    const match = String(text).match(pattern);

    if (match) return match[0].trim();
  }

  return null;
}

function isExplicitOrderIntent(text = '') {
  const value = normalizeText(text);

  const patterns = [
    /\b(i want to order|i would like to order|place my order|order this|i will buy|i want to buy|buy this|confirm my order|i will take it|i want this)\b/i,
    /\b(order korbo|order dibo|order dite chai|order korte chai|kinbo|kine nibo|eta nibo|eta kinbo)\b/i,
    /অর্ডার করতে চাই|অর্ডার করব|অর্ডার করবো|অর্ডার দিন|অর্ডার করে দিন|অর্ডার দিব|অর্ডার দেব|অর্ডার দিতে চাই|অর্ডার কনফার্ম|কিনতে চাই|কিনব|কিনবো|নিতে চাই|নিব|নেব|পণ্যটি নেব|পণ্যটা নেব|এটা নেব|এটি নেব|এটা কিনব|এটি কিনব|কিনে নেব|কিনে নিব/
  ];

  return patterns.some(pattern => pattern.test(value));
}

function identifyOrderedProduct(senderId, customerText) {
  const exact = findExactProductForPrice(customerText);

  if (exact) return exact;

  const candidates = products
    .map(product => ({
      product,
      score: productScore(customerText, product)
    }))
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

function getPendingOrder(senderId) {
  const id = String(senderId || '');
  if (!id) return null;

  const pending = db.pendingOrders[id];

  if (!pending) return null;

  const updatedAt = Number(pending.updatedAt || pending.createdAt || 0);

  if (
    updatedAt &&
    Date.now() - updatedAt > PENDING_ORDER_RETENTION_MS
  ) {
    delete db.pendingOrders[id];
    saveStorage();
    return null;
  }

  return pending;
}

function updatePendingOrderFromMessage(senderId, customerText) {
  const id = String(senderId || '');
  const text = String(customerText || '').trim();

  const pending = getPendingOrder(id);

  if (!pending || !text) return pending;

  const customer = db.customers[id] || {};
  const phone = extractPhoneNumber(text);
  const address = extractAddressText(text);
  const product = identifyOrderedProduct(id, text);

  if (phone) {
    pending.customerPhone = phone;
    customer.phone = phone;
  } else if (!pending.customerPhone && customer.phone) {
    pending.customerPhone = customer.phone;
  }

  if (address) {
    pending.customerAddress = address;
    customer.address = address;
  } else if (!pending.customerAddress && customer.address) {
    pending.customerAddress = customer.address;
  }

  if (product) {
    pending.productId = product.id;
    pending.productName = product.name;
    pending.productPrice = product.price ?? null;
  }

  const quantityMatch = text.match(
    /(?:পরিমাণ|কয়টি|কয়টি|quantity|qty)\s*[:：]?\s*(\d{1,3})/i
  );

  if (quantityMatch) {
    const quantity = Number(quantityMatch[1]);

    if (quantity >= 1 && quantity <= 100) {
      pending.quantity = quantity;
    }
  }

  pending.updatedAt = Date.now();
  pending.updatedAtISO = new Date().toISOString();

  db.customers[id] = customer;
  db.pendingOrders[id] = pending;

  saveStorage();

  return pending;
}

function startPendingOrder(senderId, customerText, messageId) {
  const id = String(senderId || '').trim();

  if (!id) throw new Error('Customer sender ID is required');

  const customer = db.customers[id] || {};
  const product = identifyOrderedProduct(id, customerText);
  const phone = extractPhoneNumber(customerText) || customer.phone || null;
  const address = extractAddressText(customerText) || customer.address || null;

  const existing = getPendingOrder(id);

  const pending = existing || {
    senderId: id,
    createdAt: Date.now(),
    createdAtISO: new Date().toISOString(),
    quantity: 1,
    sourceMessageId: messageId || null
  };

  pending.orderIntentConfirmed = true;
  pending.lastOrderIntentText = String(customerText || '').slice(0, 1000);
  pending.updatedAt = Date.now();
  pending.updatedAtISO = new Date().toISOString();

  if (product) {
    pending.productId = product.id;
    pending.productName = product.name;
    pending.productPrice = product.price ?? null;
  }

  if (phone) pending.customerPhone = phone;
  if (address) pending.customerAddress = address;

  if (customer.phone && !pending.customerPhone) {
    pending.customerPhone = customer.phone;
  }

  if (customer.address && !pending.customerAddress) {
    pending.customerAddress = customer.address;
  }

  db.pendingOrders[id] = pending;

  cancelFollowup(id);
  saveStorage();

  return pending;
}

function getMissingOrderFields(pending) {
  const missing = [];

  if (!pending.productId || !pending.productName) {
    missing.push('product');
  }

  if (!pending.customerPhone) {
    missing.push('phone');
  }

  if (!pending.customerAddress) {
    missing.push('address');
  }

  return missing;
}

function getOrderInformationRequest(pending) {
  const missing = getMissingOrderFields(pending);

  if (missing.includes('product')) {
    return 'আপনি কোন পণ্যটি অর্ডার করতে চান? পণ্যের সঠিক নাম বা মডেলটি জানাবেন।';
  }

  if (missing.includes('phone') && missing.includes('address')) {
    return 'অর্ডারটি সম্পন্ন করতে আপনার মোবাইল নম্বর ও সম্পূর্ণ ডেলিভারি ঠিকানা পাঠাবেন।';
  }

  if (missing.includes('phone')) {
    return 'অর্ডারটি সম্পন্ন করতে আপনার সচল মোবাইল নম্বরটি পাঠাবেন।';
  }

  if (missing.includes('address')) {
    return 'অর্ডারটি সম্পন্ন করতে আপনার সম্পূর্ণ ডেলিভারি ঠিকানা পাঠাবেন—এলাকা, থানা/উপজেলা ও জেলা-সহ।';
  }

  return null;
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

function cancelFollowup(senderId) {
  const id = String(senderId || '');

  const timer = followupTimers.get(id);

  if (timer) clearTimeout(timer);

  followupTimers.delete(id);

  if (db.scheduledFollowups[id]) {
    delete db.scheduledFollowups[id];
    saveStorage();
  }
}

async function setTakeoverState(customerId, enabled, reason) {
  if (!customerId) return false;

  const id = String(customerId).trim();
  const isEnabled = Boolean(enabled);
  const timestamp = new Date().toISOString();

  db.takeovers[id] = {
    isPaused: isEnabled,
    reason: reason || (
      isEnabled ? 'Human takeover' : 'Admin resumed AI'
    ),
    timestamp
  };

  if (!db.customers[id]) {
    db.customers[id] = {
      id,
      name: customerDisplayName(id),
      messageCount: 0
    };
  }

  db.customers[id].isPaused = isEnabled;
  db.customers[id].takeover = isEnabled;
  db.customers[id].takeoverUpdatedAt = timestamp;
  db.customers[id].takeoverReason = reason || null;

  if (isEnabled) cancelFollowup(id);

  const saved = saveStorage();

  if (!saved) {
    console.error('[Takeover] Could not persist takeover state');
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
    reason || 'Human support required'
  );

  const message = customMessage ||
    `আপনার বিষয়টি আমাদের প্রতিনিধির সহায়তা প্রয়োজন। ` +
    `আমি কথোপকথনটি প্রতিনিধির কাছে হস্তান্তর করছি। ` +
    `জরুরি প্রয়োজনে হেল্পলাইন: ${HELPLINE}। ` +
    `WhatsApp: ${WHATSAPP_NUMBER}।`;

  return sendFacebookMessage(senderId, message);
}

// =============================================================================
// 14. ORDER CREATION
// =============================================================================

function createMessengerOrder(senderId, customerText, messageId) {
  const id = String(senderId || '').trim();

  if (!id) throw new Error('Customer sender ID is required');

  if (messageId) {
    const existing = db.orders.find(
      order => order.sourceMessageId === messageId
    );

    if (existing) return { order: existing, created: false };
  }

  // Prevent duplicate active orders for the same customer and product.
  const pendingData = getPendingOrder(id);
  const product = identifyOrderedProduct(
    id,
    customerText || pendingData?.productName || ''
  );

  const productId =
    product?.id ??
    pendingData?.productId ??
    null;

  const existingActiveOrder = db.orders.find(order =>
    String(order.senderId || order.customerId || '') === id &&
    String(order.productId || '') === String(productId || '') &&
    !['CANCELLED', 'CANCELED', 'REJECTED', 'COMPLETED']
      .includes(String(order.status || '').toUpperCase()) &&
    Date.now() - new Date(order.createdAt || 0).getTime() <
      PENDING_ORDER_RETENTION_MS
  );

  if (existingActiveOrder) {
    return {
      order: existingActiveOrder,
      created: false,
      duplicate: true
    };
  }

  const customer = db.customers[id] || {};
  const phone =
    pendingData?.customerPhone ||
    extractPhoneNumber(customerText) ||
    customer.phone ||
    null;

  const address =
    pendingData?.customerAddress ||
    extractAddressText(customerText) ||
    customer.address ||
    null;

  if (!productId || !phone || !address) {
    throw new Error('Order is missing required product, phone, or address');
  }

  const order = {
    id: newId('order'),
    senderId: id,
    customerId: id,
    customerName: customer.name || customerDisplayName(id),
    customerPhone: phone,
    customerAddress: address,
    productId,
    productName: product?.name || pendingData?.productName || null,
    productPrice: product?.price ?? pendingData?.productPrice ?? null,
    quantity: Number(pendingData?.quantity) || 1,
    customerMessage: String(customerText || '').trim(),
    source: 'MESSENGER',
    sourceMessageId: messageId || pendingData?.sourceMessageId || null,
    status: 'PENDING_CONFIRMATION',
    humanTakeover: true,
    createdAt: new Date().toISOString()
  };

  db.orders.push(order);

  if (!db.customers[id]) {
    db.customers[id] = {
      id,
      name: customerDisplayName(id),
      messageCount: 0,
      lastActive: new Date().toISOString()
    };
  }

  db.customers[id].phone = phone;
  db.customers[id].address = address;
  db.customers[id].lastOrderId = order.id;
  db.customers[id].lastOrderAt = order.createdAt;

  delete db.pendingOrders[id];

  cancelFollowup(id);

  if (!saveStorage()) {
    db.orders = db.orders.filter(item => item.id !== order.id);
    throw new Error('Could not persist the customer order');
  }

  return { order, created: true };
}

// =============================================================================
// 15. MESSENGER MESSAGE SENDING
// =============================================================================

function limitToFiveLines(text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  return lines.slice(0, MAX_AI_LINES).join('\n');
}

async function sendFacebookMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('[Messenger] PAGE_ACCESS_TOKEN is missing');
    return false;
  }

  const finalText = String(text || '').trim();

  if (!finalText || finalText.length > MAX_MESSENGER_TEXT_LENGTH) {
    console.error('[Messenger] Empty or oversized message');
    return false;
  }

  try {
    const url =
      `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages`;

    await axios.post(
      url,
      {
        recipient: { id: String(recipientId) },
        message: { text: finalText }
      },
      {
        params: { access_token: PAGE_ACCESS_TOKEN },
        timeout: 15000
      }
    );

    storeConversationMessage(recipientId, 'assistant', finalText);
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
// 16. FOLLOW-UP SCHEDULER
// =============================================================================

function customerHasOrder(senderId) {
  const id = String(senderId || '');

  return db.orders.some(order =>
    String(order.senderId || order.customerId || '') === id &&
    !['CANCELLED', 'CANCELED', 'REJECTED', 'COMPLETED'].includes(
      String(order.status || '').toUpperCase()
    )
  );
}

function scheduleFollowup(senderId, lastCustomerMessageAt = Date.now()) {
  const id = String(senderId || '');

  if (!id) return;

  cancelFollowup(id);

  if (
    getTakeoverState(id) ||
    customerHasOrder(id) ||
    getPendingOrder(id)
  ) {
    return;
  }

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

  if (
    !customer ||
    getTakeoverState(id) ||
    customerHasOrder(id) ||
    getPendingOrder(id)
  ) {
    delete db.scheduledFollowups[id];
    saveStorage();
    return;
  }

  if (Date.now() < Number(task.dueAt)) {
    armFollowupTimer(id);
    return;
  }

  const lastAt = new Date(
    customer.lastCustomerMessageAt || customer.lastActive || 0
  ).getTime();

  if (
    !Number.isFinite(lastAt) ||
    lastAt <= 0 ||
    Date.now() - lastAt >= 24 * 60 * 60 * 1000
  ) {
    delete db.scheduledFollowups[id];
    saveStorage();

    console.log(`[FOLLOWUP] Skipped ${id}: messaging window expired`);
    return;
  }

  if (lastAt > Number(task.lastCustomerMessageAt || 0)) {
    scheduleFollowup(id, lastAt);
    return;
  }

  const sent = await sendFacebookMessage(id, FOLLOWUP_MESSAGE);

  task.status = sent ? 'SENT' : 'FAILED';
  task.sentAt = new Date().toISOString();

  saveStorage();

  console.log(`[FOLLOWUP] ${id}: ${sent ? 'sent' : 'failed'}`);
}

function restoreFollowupTasks() {
  for (const [senderId, task] of Object.entries(db.scheduledFollowups)) {
    if (!task || task.status !== 'PENDING') continue;

    if (
      getTakeoverState(senderId) ||
      customerHasOrder(senderId) ||
      getPendingOrder(senderId)
    ) {
      delete db.scheduledFollowups[senderId];
      continue;
    }

    armFollowupTimer(senderId);
  }

  saveStorage();
}

// =============================================================================
// 17. GITHUB CATALOG SYNC
// =============================================================================

async function pullCatalogFromGitHub() {
  if (!GITHUB_TOKEN) {
    catalogMeta.lastSyncError = 'GITHUB_TOKEN is not configured';
    console.warn('[GITHUB] Token missing; using local catalog');
    return false;
  }

  try {
    const url =
      `https://api.github.com/repos/${GITHUB_REPO}/contents/` +
      `${CATALOG_FILE}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Impotech-Admin-Server'
      },
      timeout: 15000
    });

    const decoded = Buffer.from(
      response.data.content,
      'base64'
    ).toString('utf8');

    const data = JSON.parse(decoded);

    validateCatalogShape(data);
    saveLocalCatalog(data, 'github');

    console.log('[GITHUB] Catalog pulled successfully');

    return true;
  } catch (err) {
    catalogMeta.lastSyncError =
      err.response?.data?.message || err.message;

    console.error('[GITHUB] Pull error:', catalogMeta.lastSyncError);

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
    return { synced: false, error: 'GitHub Token is not configured' };
  }

  try {
    validateCatalogShape(catalogData);

    const url =
      `https://api.github.com/repos/${repo}/contents/${filePath}`;

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Impotech-Admin-Server'
    };

    let sha = null;

    try {
      const existing = await axios.get(url, {
        params: { ref: branch },
        headers,
        timeout: 10000
      });

      sha = existing.data.sha;
    } catch (err) {
      if (err.response?.status !== 404) throw err;
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

    const result = await axios.put(url, payload, {
      headers,
      timeout: 20000
    });

    return {
      synced: true,
      sha: result.data.content?.sha || null,
      path: filePath,
      branch
    };
  } catch (err) {
    return {
      synced: false,
      error: err.response?.data?.message || err.message
    };
  }
}

// =============================================================================
// 18. AI SYSTEM PROMPT
// =============================================================================

function buildSystemPrompt(
  relevantProducts,
  relevantFaqs,
  history,
  memoryContext
) {
  const productContext = relevantProducts.length
    ? relevantProducts.map((p, index) => [
        `[পণ্য ${index + 1}]`,
        `ID: ${p.id || 'N/A'}`,
        `নাম: ${p.name || 'N/A'}`,
        `ব্র্যান্ড: ${p.brand || 'N/A'}`,
        `মডেল: ${p.model || 'N/A'}`,
        `মূল্য: ${p.price ?? 'ক্যাটালগে নেই'} টাকা`,
        `স্টক: ${p.stockStatus || 'তথ্য নেই'}`,
        `বিবরণ: ${p.shortDescription || p.description || 'N/A'}`,
        `বৈশিষ্ট্য: ${
          Array.isArray(p.features) ? p.features.join(', ') : 'N/A'
        }`,
        `ছবি: ${getProductMediaUrls(p, 'images').join(' | ') || 'নেই'}`,
        `ভিডিও: ${getProductMediaUrls(p, 'videos').join(' | ') || 'নেই'}`
      ].join('\n')).join('\n\n')
    : 'কোনো প্রাসঙ্গিক পণ্য পাওয়া যায়নি।';

  const faqContext = relevantFaqs.length
    ? relevantFaqs.map((faq, index) =>
        `[FAQ ${index + 1}] ${faq.question || ''}\n${faq.answer || ''}`
      ).join('\n\n')
    : 'প্রাসঙ্গিক FAQ পাওয়া যায়নি।';

  const historyContext = history.length
    ? history.map(item =>
        `${item.role === 'assistant' ? 'বট/প্রতিনিধি' : 'গ্রাহক'}: ${item.text}`
      ).join('\n')
    : 'পূর্ববর্তী কথোপকথন নেই।';

  return `
আপনি ImpoTech BD ফেসবুক পেজের বিক্রয় সহকারী।

হেল্পলাইন: ${HELPLINE}
WhatsApp: ${WHATSAPP_NUMBER}
ঠিকানা: ভাওয়াল গড়, ভবানীপুর, জয়দেবপুর, গাজীপুর।

ডেলিভারি:
- গাজীপুরের ভেতরে ৫০ টাকা।
- গাজীপুরের বাইরে ১০০ টাকা।

কঠোর নিয়ম:
১. সহজ, স্বাভাবিক ও ভদ্র বাংলায় উত্তর দিন।
২. সর্বোচ্চ ৫টি ছোট লাইন ব্যবহার করুন।
৩. ক্যাটালগের বাইরে দাম, স্টক, ওয়ারেন্টি বা বৈশিষ্ট্য বানাবেন না।
৪. সঠিক পণ্য শনাক্ত না হলে দাম অনুমান করবেন না।
৫. প্রশ্ন অস্পষ্ট হলে একটি ছোট প্রশ্ন করুন।
৬. সর্বশেষ ২০টি মেসেজ ও সংরক্ষিত মেমোরি ব্যবহার করুন।
৭. পণ্যের নাম, ID, দাম বা URL পরিবর্তন করবেন না।
৮. কাস্টমারকে চাপ না দিয়ে প্রাসঙ্গিকভাবে বিক্রয়ে সাহায্য করুন।
৯. অর্ডারের ইচ্ছা থাকলে ব্যাকএন্ড অর্ডার তৈরি ও মানব প্রতিনিধির কাছে হস্তান্তর করবে।
১০. বাইকের ফিটমেন্ট যাচাই ছাড়া নিশ্চিত দাবি করবেন না।
১১. গুরুতর অভিযোগ বা পেমেন্ট সমস্যায় উত্তরের শুরুতে ${HANDOVER_MARKER} লিখুন।
১২. মার্কারটি গ্রাহকের কাছে পাঠানো যাবে না।
১৩. Human Takeover চালু থাকলে AI-এর উত্তর পাঠানো যাবে না।
১৪. মেমোরিতে নেই এমন তথ্য মনে আছে বলে দাবি করবেন না।
১৫. একই পণ্য নিয়ে আগের আলোচনা থাকলে সেটি বিবেচনা করুন।
১৬. ছবি থেকে পণ্য নিশ্চিতভাবে শনাক্ত না হলে সংক্ষেপে পণ্যের নাম জিজ্ঞেস করুন।
১৭. ক্যাটালগে তথ্য না থাকলে স্পষ্টভাবে বলুন যে তথ্যটি যাচাই করতে হবে।

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
// 19. OPENROUTER AI: TEXT, VOICE AND VISION
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
      timeout: 45000,
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

async function fetchAttachmentAsBase64(
  url,
  maxBytes = MAX_ATTACHMENT_BYTES
) {
  const parsed = new URL(url);

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('Unsupported attachment URL');
  }

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes
  });

  if (Buffer.byteLength(response.data) > maxBytes) {
    throw new Error('Attachment exceeds allowed size');
  }

  return {
    base64: Buffer.from(response.data).toString('base64'),
    contentType: response.headers['content-type'] ||
      'application/octet-stream'
  };
}

function isImageContentType(type = '') {
  return /^image\/(jpeg|png|webp|gif)$/i.test(type);
}

function isAudioContentType(type = '') {
  return /^audio\/(mpeg|mp3|wav|ogg|webm|mp4|aac|m4a|x-wav)/i.test(type);
}

async function generateAIResponse(
  customerText,
  attachments = [],
  senderId
) {
  const query = customerText ||
    'পাঠানো ফাইলটি দেখে সাহায্য করুন।';

  const history = getHistory(senderId).slice();

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

  const audio = attachments.find(item =>
    item.type === 'audio' && item.payload?.url
  );

  const imageAttachment = attachments.find(item =>
    item.type === 'image' && item.payload?.url
  );

  if (audio) {
    const { base64, contentType } =
      await fetchAttachmentAsBase64(audio.payload.url);

    if (!isAudioContentType(contentType)) {
      return 'দুঃখিত, পাঠানো অডিও ফাইলটি সমর্থিত ফরম্যাটে নেই। অন্যভাবে পাঠাতে পারবেন?';
    }

    const reply = await callOpenRouter([
      { role: 'system', content: systemPrompt },
      ...priorMessages,
      {
        role: 'user',
        content: [
          { type: 'text', text: query },
          {
            type: 'input_audio',
            input_audio: {
              data: base64,
              format: contentType.includes('wav') ? 'wav' : 'mp3'
            }
          }
        ]
      }
    ], VOICE_MODEL);

    return limitToFiveLines(reply);
  }

  if (imageAttachment) {
    const { base64, contentType } =
      await fetchAttachmentAsBase64(imageAttachment.payload.url);

    if (!isImageContentType(contentType)) {
      return 'দুঃখিত, পাঠানো ছবির ফরম্যাটটি সমর্থিত নয়। JPG, PNG বা WebP ছবি পাঠান।';
    }

    const reply = await callOpenRouter([
      { role: 'system', content: systemPrompt },
      ...priorMessages,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: query || 'ছবিতে থাকা পণ্যটি শনাক্ত করে সাহায্য করুন।'
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${contentType};base64,${base64}`
            }
          }
        ]
      }
    ], VISION_MODEL);

    return limitToFiveLines(reply);
  }

  const reply = await callOpenRouter([
    { role: 'system', content: systemPrompt },
    ...priorMessages,
    { role: 'user', content: query }
  ], TEXT_MODEL);

  return limitToFiveLines(reply);
}

// =============================================================================
// 20. CRITICAL HANDOVER
// =============================================================================

function isCriticalHandoverQuestion(text = '') {
  const value = normalizeText(text);

  return (
    /প্রতারণা|fraud|scam|আইনগত ব্যবস্থা|legal action|মামলা|মারাত্মক দুর্ঘটনা|serious injury|আগুন লেগেছে|fire hazard|ব্যাটারি বিস্ফোরণ|battery exploded|চার্জে আগুন|payment deducted twice|দুইবার টাকা কাটা|ভুল পেমেন্ট|টাকা কেটে নিয়েছে/.test(value)
  );
}

// =============================================================================
// 21. FACEBOOK CALL EVENTS
// =============================================================================

async function handleCallEvent(event) {
  const senderId = String(event.sender?.id || '').trim();

  if (!senderId) return;

  const callData = event.call || {};

  db.callEvents.push({
    id: newId('call'),
    senderId,
    callId: callData.call_id || null,
    event: callData.event || 'unknown',
    timestamp: new Date().toISOString()
  });

  if (db.callEvents.length > 2000) {
    db.callEvents.splice(0, db.callEvents.length - 2000);
  }

  await setTakeoverState(
    senderId,
    true,
    `Automatic takeover: call event (${callData.event || 'unknown'})`
  );

  saveStorage();
}

// =============================================================================
// 22. CUSTOMER MESSAGE PROCESSING
// =============================================================================

async function processCustomerMessage(
  senderId,
  text,
  attachments = [],
  messageId = null
) {
  const id = String(senderId || '').trim();

  if (!id) return;

  if (getTakeoverState(id)) {
    console.log(`[Takeover] ${id} paused; AI skipped`);
    return;
  }

  if (messageId && processedMessageIds.has(messageId)) {
    return;
  }

  if (messageId) {
    processedMessageIds.set(messageId, Date.now());
  }

  const customerText = String(text || '').trim();

  if (!db.customers[id]) {
    db.customers[id] = {
      id,
      name: customerDisplayName(id),
      messageCount: 0,
      lastActive: new Date().toISOString()
    };
  }

  const customer = db.customers[id];

  customer.lastActive = new Date().toISOString();
  customer.lastCustomerMessageAt = Date.now();
  customer.lastMessageId = messageId || null;

  storeConversationMessage(
    id,
    'user',
    customerText || '[Attachment]',
    messageId
  );

  updateCustomerMemory(id, customerText);

  // An existing pending order prevents sales follow-up scheduling.
  if (!getPendingOrder(id)) {
    scheduleFollowup(id, customer.lastCustomerMessageAt);
  } else {
    cancelFollowup(id);
  }

  try {
    if (isCriticalHandoverQuestion(customerText)) {
      await transferToHuman(
        id,
        'Critical customer issue',
        'আপনার বিষয়টি আমাদের প্রতিনিধির কাছে হস্তান্তর করছি। প্রতিনিধি আপনাকে সহায়তা করবেন।'
      );

      return;
    }

    // -------------------------------------------------------------------------
    // MULTI-MESSAGE ORDER FLOW
    //
    // A customer must express order intent before an order can be started.
    // Once started, product, phone and address may arrive in separate messages.
    // -------------------------------------------------------------------------

    let pendingOrder = getPendingOrder(id);

    if (isExplicitOrderIntent(customerText)) {
      pendingOrder = startPendingOrder(
        id,
        customerText,
        messageId
      );
    } else if (pendingOrder?.orderIntentConfirmed) {
      pendingOrder = updatePendingOrderFromMessage(
        id,
        customerText
      );
    }

    if (pendingOrder?.orderIntentConfirmed) {
      const missing = getMissingOrderFields(pendingOrder);

      if (missing.length > 0) {
        const request = getOrderInformationRequest(pendingOrder);

        if (request) {
          await sendFacebookMessage(id, request);
        }

        return;
      }

      // All required order details are available.
      const result = createMessengerOrder(
        id,
        customerText,
        messageId
      );

      if (result.created || result.duplicate) {
        // Send acknowledgement before activating takeover.
        const acknowledgementSent = await sendFacebookMessage(
          id,
          ORDER_CONFIRMATION
        );

        // Even if Messenger delivery fails, the persisted order remains
        // available to the representative and AI must not continue selling.
        await setTakeoverState(
          id,
          true,
          result.duplicate
            ? 'Existing order detected; human confirmation required'
            : 'Customer order completed; human confirmation required'
        );

        if (!acknowledgementSent) {
          console.error(
            `[ORDER] Order saved for ${id}, but confirmation message failed`
          );
        }

        return;
      }
    }

    if (isPriceQuestion(customerText)) {
      let product = findExactProductForPrice(customerText);

      if (!product && isGenericPriceQuestion(customerText)) {
        product = findProductFromRecentContext(id);
      }

      if (product) {
        const reply = getPriceReply(product);

        if (reply) {
          recordProductDiscussion(id, product, customerText, reply);
          await sendFacebookMessage(id, reply);
          return;
        }
      }

      if (isGenericPriceQuestion(customerText)) {
        await sendFacebookMessage(
          id,
          getPriceClarificationReply()
        );

        return;
      }
    }

    if (isBikeCompatibilityQuestion(customerText)) {
      const reply = getH4CompatibilityReply(customerText);

      await sendFacebookMessage(id, reply);
      return;
    }

    if (isMediaRequest(customerText)) {
      const reply = getProductMediaReply(customerText, id);

      if (reply) {
        await sendFacebookMessage(id, reply);
        return;
      }
    }

    const reply = await generateAIResponse(
      customerText,
      attachments,
      id
    );

    if (reply.includes(HANDOVER_MARKER)) {
      const cleanReply = reply
        .replaceAll(HANDOVER_MARKER, '')
        .trim();

      await transferToHuman(
        id,
        'AI requested human support',
        cleanReply || undefined
      );

      return;
    }

    // Re-check takeover after the asynchronous AI call.
    if (getTakeoverState(id)) {
      console.log(`[Takeover] ${id} became paused during AI generation`);
      return;
    }

    const finalReply = limitToFiveLines(reply);

    if (finalReply.length > MAX_MESSENGER_TEXT_LENGTH) {
      console.warn('[AI] Reply too long; not sent');
      return;
    }

    const matched = findRelevantProducts(customerText);

    if (matched.length === 1) {
      recordProductDiscussion(
        id,
        matched[0],
        customerText,
        finalReply
      );
    }

    await sendFacebookMessage(id, finalReply);

    saveStorage();
  } catch (err) {
    console.error('[AI] Response error:', err.message);

    if (!getTakeoverState(id)) {
      await sendFacebookMessage(
        id,
        'দুঃখিত, এই মুহূর্তে উত্তর দিতে সমস্যা হচ্ছে। অনুগ্রহ করে কিছুক্ষণ পরে আবার চেষ্টা করুন।'
      );
    }
  }
}

// =============================================================================
// 23. FACEBOOK WEBHOOK
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

app.post('/webhook', (req, res) => {
  // Acknowledge Meta quickly; process events asynchronously.
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;

  if (!body || body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const senderId = String(event.sender?.id || '');

      if (!senderId || event.sender?.id === event.recipient?.id) {
        continue;
      }

      if (event.call) {
        handleCallEvent(event).catch(err =>
          console.error('[CALL] Event error:', err.message)
        );

        continue;
      }

      const message = event.message;

      if (!message || message.is_echo) continue;

      const attachments = Array.isArray(message.attachments)
        ? message.attachments
        : [];

      const normalizedAttachments = attachments.map(item => ({
        type: item.type,
        payload: item.payload || {}
      }));

      const text = message.text || '';

      const task = () => processCustomerMessage(
        senderId,
        text,
        normalizedAttachments,
        message.mid || null
      );

      // Process messages from one customer sequentially.
      const previous = customerQueues.get(senderId) ||
        Promise.resolve();

      const current = previous
        .catch(() => {})
        .then(task)
        .catch(err =>
          console.error('[QUEUE] Processing error:', err.message)
        );

      customerQueues.set(senderId, current);
    }
  }
});

// =============================================================================
// 24. CATALOG ADMIN API
// =============================================================================

app.get('/api/catalog', (req, res) => {
  res.json({
    success: true,
    catalog: {
      version: catalogMeta.version,
      updatedAt: catalogMeta.updatedAt,
      products,
      faqs
    },
    products,
    faqs,
    meta: catalogMeta
  });
});

app.post('/api/catalog/sync', (req, res) => {
  try {
    const catalogData = req.body.catalog || req.body;

    replaceCatalogAtomically(catalogData, 'admin');

    res.json({
      success: true,
      totalProducts: products.length,
      totalFaqs: faqs.length,
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
    } = req.body || {};

    if (!catalogPayload) {
      return res.status(400).json({
        success: false,
        message: 'catalog is required'
      });
    }

    const result = await pushCatalogToGitHub(
      catalogPayload,
      githubToken,
      githubRepo,
      githubBranch,
      githubFilePath
    );

    if (!result.synced) {
      return res.status(502).json({
        success: false,
        ...result
      });
    }

    replaceCatalogAtomically(catalogPayload, 'admin-github-upload');

    res.json({
      success: true,
      ...result,
      totalProducts: products.length,
      totalFaqs: faqs.length
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
// 25. BOT STATUS AND TAKEOVER APIs
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
  } else {
    restoreFollowupTasks();
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
      ? 'Human takeover enabled until admin disables it'
      : 'AI resumed for this customer'
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
    req.body?.reason || 'Enabled from admin'
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
    req.body?.reason || 'Disabled from admin'
  );

  res.json({
    success: true,
    senderId,
    takeover: false,
    isPaused: false
  });
});

// =============================================================================
// 26. CUSTOMERS AND MEMORY APIs
// =============================================================================

app.get('/api/customers', (req, res) => {
  const list = Object.values(db.customers).map(customer => {
    const takeover = db.takeovers[customer.id] || {};

    return {
      ...customer,
      isPaused: getTakeoverState(customer.id),
      takeoverReason: takeover.reason || null,
      hasPendingOrder: !!getPendingOrder(customer.id)
    };
  });

  res.json({
    success: true,
    total: list.length,
    data: list
  });
});

app.get('/api/customers/:senderId/memory', (req, res) => {
  const senderId = String(req.params.senderId);

  res.json({
    success: true,
    senderId,
    memory: db.customerMemory[senderId] || null
  });
});

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

  if (Array.isArray(body.productDiscussions)) {
    memory.productDiscussions = body.productDiscussions.slice(-60);
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

// =============================================================================
// 27. MESSAGE APIs
// =============================================================================

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
// 28. ORDER APIs
// =============================================================================

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

app.post('/api/orders', async (req, res) => {
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
    return res.json({
      success: true,
      duplicate: true,
      order: db.orders.find(
        item => item.sourceMessageId === order.sourceMessageId
      )
    });
  }

  const newOrder = {
    ...order,
    senderId,
    customerId: senderId,
    id: order.id || newId('order'),
    status: order.status || 'PENDING',
    createdAt: order.createdAt || new Date().toISOString()
  };

  db.orders.push(newOrder);

  if (!saveStorage()) {
    db.orders = db.orders.filter(item => item.id !== newOrder.id);

    return res.status(500).json({
      success: false,
      message: 'Could not persist order'
    });
  }

  cancelFollowup(senderId);

  await setTakeoverState(
    senderId,
    true,
    'Order created through admin API'
  );

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

// =============================================================================
// 29. HEALTH, STATUS AND MEDIA DIAGNOSTICS
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
    models: {
      text: TEXT_MODEL,
      voice: VOICE_MODEL,
      vision: VISION_MODEL
    },
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
    pendingOrders: Object.keys(db.pendingOrders).length,
    customerMemories: Object.keys(db.customerMemory).length,
    pendingFollowups: Object.values(db.scheduledFollowups)
      .filter(task => task && task.status === 'PENDING').length,
    totalTakeovers: Object.keys(db.takeovers).length,
    activeTakeovers: Object.values(db.takeovers)
      .filter(item => item && item.isPaused).length,
    callEvents: db.callEvents.length,
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
// 30. RETENTION CLEANUP
// =============================================================================

function cleanupOldData() {
  const cutoff = Date.now() -
    CUSTOMER_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const oldCustomerIds = new Set();

  for (const [id, customer] of Object.entries(db.customers)) {
    const lastActive = new Date(
      customer.lastActive || customer.createdAt || 0
    ).getTime();

    if (lastActive > 0 && lastActive < cutoff) {
      oldCustomerIds.add(id);
    }
  }

  for (const id of oldCustomerIds) {
    if (getTakeoverState(id)) continue;

    delete db.customers[id];
    delete db.customerMemory[id];
    delete db.takeovers[id];
    delete db.scheduledFollowups[id];
    delete db.pendingOrders[id];

    customerHistory.delete(id);

    db.messages = db.messages.filter(
      message => String(message.senderId) !== id
    );

    db.orders = db.orders.filter(
      order => String(order.senderId || order.customerId) !== id
    );
  }

  // Remove expired pending order drafts, even if the customer is still active.
  for (const [id, pending] of Object.entries(db.pendingOrders)) {
    const updatedAt = Number(
      pending?.updatedAt || pending?.createdAt || 0
    );

    if (
      updatedAt &&
      Date.now() - updatedAt > PENDING_ORDER_RETENTION_MS
    ) {
      delete db.pendingOrders[id];
    }
  }

  if (oldCustomerIds.size || Object.keys(db.pendingOrders).length) {
    saveStorage();
  }

  if (oldCustomerIds.size) {
    console.log(
      `[CLEANUP] Removed ${oldCustomerIds.size} inactive customers`
    );
  }
}

// =============================================================================
// 31. START SERVER
// =============================================================================

async function startServer() {
  try {
    await pullCatalogFromGitHub();
  } catch (err) {
    console.error('[GITHUB] Startup sync error:', err.message);
  }

  restoreFollowupTasks();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[SERVER] ImpoTech Master Bot running on port ${PORT}`
    );

    console.log(`[AI] Text model: ${TEXT_MODEL}`);
    console.log(`[AI] Voice model: ${VOICE_MODEL}`);
    console.log(`[AI] Vision model: ${VISION_MODEL}`);
    console.log(`[CATALOG] Products loaded: ${products.length}`);
  });
}

startServer().catch(err => {
  console.error('[SERVER] Startup error:', err.message);
  process.exit(1);
});

// =============================================================================
// 32. PERIODIC TASKS
// =============================================================================

setInterval(() => {
  const cutoff = Date.now() - DUPLICATE_WINDOW_MS;

  for (const [id, timestamp] of processedMessageIds) {
    if (timestamp < cutoff) {
      processedMessageIds.delete(id);
    }
  }
}, 60 * 1000).unref();

setInterval(() => {
  for (const [senderId, task] of Object.entries(db.scheduledFollowups)) {
    if (task && task.status === 'PENDING') {
      armFollowupTimer(senderId);
    }
  }
}, FOLLOWUP_CHECK_INTERVAL_MS).unref();

setInterval(() => {
  saveStorage();
}, 5 * 60 * 1000).unref();

setInterval(() => {
  cleanupOldData();
}, 6 * 60 * 60 * 1000).unref();

// =============================================================================
// 33. REQUIRED ENVIRONMENT VARIABLES
// =============================================================================

/*
PORT=10000

PAGE_ACCESS_TOKEN=your_facebook_page_access_token
VERIFY_TOKEN=your_webhook_verify_token

OPENROUTER_API_KEY=your_openrouter_api_key

TEXT_MODEL=google/gemini-2.5-flash-lite
VOICE_MODEL=google/gemini-2.5-flash-lite
VISION_MODEL=google/gemini-2.5-flash-lite

GITHUB_TOKEN=your_github_token
GITHUB_REPO=impotechaibot/Impotech-bot
GITHUB_BRANCH=main
CATALOG_FILE=data/catalog.json

ADMIN_SECRET=your_strong_random_admin_secret
REQUIRE_ADMIN_SECRET=true

GRAPH_API_VERSION=v18.0
*/
