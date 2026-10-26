'use strict';

/**
 * ImpoTech AI Messenger Bot & Admin Backend
 * AI: OpenRouter Gemini 2.5 Flash-Lite (text, voice and vision)
 * Storage: PostgreSQL (DATABASE_URL / POSTGRES_URL)
 * Catalog: GitHub catalog.json + local cache
 * Search: No external search API (Exa removed)
 * Memory: last 20 messages + customer facts/preferences (20-day retention)
 * Human handover: automatic for completed contact details, orders, and call events; consent for unclear-question handover
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-secret');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 10000;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'impotechaibot/Impotech-bot';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const CATALOG_FILE = process.env.CATALOG_FILE || 'data/catalog.json';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v18.0';
const REQUIRE_ADMIN_SECRET = process.env.REQUIRE_ADMIN_SECRET !== 'false';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TEXT_MODEL = 'google/gemini-2.5-flash-lite';
const VOICE_MODEL = TEXT_MODEL;
const HELPLINE = process.env.HELPLINE || '+8809611042598';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '01884332067';
const MAX_PRODUCTS_TO_AI = 2;
const MAX_FAQS_TO_AI = 3;
const MAX_OUTPUT_TOKENS = 200;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_MESSENGER_TEXT_LENGTH = 2000;
const MAX_AI_LINES = 5;
const HISTORY_LIMIT = 20;
const MESSAGE_RETENTION_LIMIT = 20000;
const MEMORY_RETENTION_DAYS = 20;
const MEMORY_RETENTION_MS = MEMORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const FOLLOWUP_DELAY_MS = 23 * 60 * 60 * 1000;
const FOLLOWUP_CHECK_INTERVAL_MS = 60 * 1000;
const CUSTOMER_REPLY_DELAY_MS = 5000;
const CATALOG_AUTO_REFRESH_MS = Math.max(30000, Number(process.env.CATALOG_AUTO_REFRESH_MS) || 60000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const LOCAL_CATALOG_PATH = path.join(__dirname, 'catalog.json');
const LEGACY_DATA_FILE = path.join(__dirname, 'storage_data.json');
const HANDOVER_MARKER = '[HANDOVER_REQUIRED]';
const ORDER_CONFIRMATION = 'আপনার অর্ডারের তথ্য সংরক্ষণ করা হয়েছে। আমাদের প্রতিনিধি আপনার সঙ্গে যোগাযোগ করে অর্ডারটি নিশ্চিত করবেন।';
const FOLLOWUP_MESSAGE = 'আপনি কি পণ্যটি সম্পর্কে আরও কিছু জানতে চান? কোনো প্রশ্ন থাকলে জানাবেন, আমরা সাহায্য করতে প্রস্তুত।';
const FIRST_CONTACT_INTRO = 'আমি ইমপোটেকের AI চ্যাটবট। পণ্য ও সেবা সম্পর্কে আপনাকে সাহায্য করব। কোনো সমস্যা হলে আমাদের প্রতিনিধির সঙ্গে কথা বলতে পারেন।';

if (!DATABASE_URL) {
  console.warn('[DB] DATABASE_URL/POSTGRES_URL is missing. PostgreSQL persistence is unavailable; server will use in-memory state only. Configure DATABASE_URL for durable storage.');
}
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;
if (pool) pool.on('error', err => console.error('[DB] Unexpected pool error:', err.message));

// -----------------------------------------------------------------------------
// State and PostgreSQL persistence
// -----------------------------------------------------------------------------
let products = [];
let faqs = [];
let catalogMeta = { version: null, updatedAt: null, source: 'local', lastSyncAt: null, lastSyncError: null };
let db = {
  isGlobalPaused: false, takeovers: {}, customers: {}, messages: [], orders: [],
  customerMemory: {}, scheduledFollowups: {}, pendingHandover: {}, orderDrafts: {}, campaignAttribution: {}
};
const customerHistory = new Map();
const processedMessageIds = new Map();
const customerQueues = new Map();
const followupTimers = new Map();
let persistChain = Promise.resolve();

function ensureStorageShape() {
  if (!db || typeof db !== 'object' || Array.isArray(db)) db = {};
  if (typeof db.isGlobalPaused !== 'boolean') db.isGlobalPaused = false;
  for (const key of ['takeovers', 'customers', 'customerMemory', 'scheduledFollowups', 'pendingHandover', 'orderDrafts', 'campaignAttribution']) {
    if (!db[key] || typeof db[key] !== 'object' || Array.isArray(db[key])) db[key] = {};
  }
  if (!Array.isArray(db.messages)) db.messages = [];
  if (!Array.isArray(db.orders)) db.orders = [];
}

async function initDatabase() {
  if (!pool) {
    // Best-effort legacy import for local development only.
    try {
      if (fs.existsSync(LEGACY_DATA_FILE)) {
        const saved = JSON.parse(fs.readFileSync(LEGACY_DATA_FILE, 'utf8'));
        db = { ...db, ...saved };
        ensureStorageShape();
        console.log('[STORAGE] Loaded legacy storage_data.json (not durable on ephemeral hosts).');
      }
    } catch (err) { console.error('[STORAGE] Legacy load failed:', err.message); }
    return;
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS impotech_app_state (
    state_key TEXT PRIMARY KEY,
    state_json JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const result = await pool.query('SELECT state_json FROM impotech_app_state WHERE state_key = $1', ['main']);
  if (result.rows[0]?.state_json) {
    db = { ...db, ...result.rows[0].state_json };
    ensureStorageShape();
    console.log(`[DB] Restored ${db.messages.length} messages, ${db.orders.length} orders, ${Object.keys(db.customerMemory).length} memories`);
  } else {
    // Migrate the legacy JSON file once, when the PostgreSQL row is empty.
    try {
      if (fs.existsSync(LEGACY_DATA_FILE)) {
        const saved = JSON.parse(fs.readFileSync(LEGACY_DATA_FILE, 'utf8'));
        db = { ...db, ...saved };
        ensureStorageShape();
        await pool.query('INSERT INTO impotech_app_state(state_key,state_json) VALUES($1,$2::jsonb) ON CONFLICT(state_key) DO NOTHING', ['main', JSON.stringify(db)]);
        console.log('[DB] Migrated legacy storage_data.json into PostgreSQL.');
      }
    } catch (err) { console.error('[DB] Legacy migration failed:', err.message); }
  }
  ensureStorageShape();
}

function saveStorage() {
  ensureStorageShape();
  if (!pool) return true;
  const snapshot = JSON.stringify(db);
  persistChain = persistChain
    .then(() => pool.query(
      'INSERT INTO impotech_app_state(state_key,state_json,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(state_key) DO UPDATE SET state_json=EXCLUDED.state_json, updated_at=NOW()',
      ['main', snapshot]
    ))
    .catch(err => { console.error('[DB] State persistence failed:', err.message); });
  return true;
}

function normalizeText(value = '') {
  return String(value).toLowerCase().normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s৳$.-]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(value = '') { return normalizeText(value).split(/\s+/).filter(word => word.length >= 2); }
function addStoredMessage(message) {
  db.messages.push(message);
  if (db.messages.length > MESSAGE_RETENTION_LIMIT) db.messages.splice(0, db.messages.length - MESSAGE_RETENTION_LIMIT);
}

// -----------------------------------------------------------------------------
// Customer memory and conversation history
// -----------------------------------------------------------------------------
function getCustomerMemory(senderId) {
  const id = String(senderId || '');
  if (!id) return null;
  if (!db.customerMemory[id]) db.customerMemory[id] = { senderId: id, facts: [], preferences: [], summary: '', updatedAt: null };
  const m = db.customerMemory[id];
  if (!Array.isArray(m.facts)) m.facts = [];
  if (!Array.isArray(m.preferences)) m.preferences = [];
  if (typeof m.summary !== 'string') m.summary = '';
  return m;
}
function addUniqueMemoryItem(list, value, maxItems = 30) {
  const text = String(value || '').trim();
  if (!text || text.length > 220) return list;
  const key = normalizeText(text);
  if (key && !list.some(item => normalizeText(item) === key)) list.push(text);
  if (list.length > maxItems) list.splice(0, list.length - maxItems);
  return list;
}
function scoreRecord(query, record, fields) {
  const q = normalizeText(query), tokens = tokenize(q);
  if (!tokens.length) return 0;
  let score = 0;
  for (const field of fields) {
    const raw = record?.[field];
    const value = normalizeText(Array.isArray(raw) ? raw.join(' ') : raw || '');
    if (!value) continue;
    if (q.length >= 4 && value === q) score += 50;
    else if (q.length >= 4 && value.includes(q)) score += 20;
    for (const token of tokens) if (value === token) score += 12; else if (value.includes(token)) score += 4;
  }
  return score;
}
function productScore(query, product) {
  return scoreRecord(query, product, ['id','name','description','shortDescription','category','brand','model','sku','keywords','tags','aliases']);
}
function findRelevantProducts(query) {
  return products.map(product => ({ product, score: productScore(query, product) }))
    .filter(x => x.score > 0).sort((a,b) => b.score-a.score).slice(0, MAX_PRODUCTS_TO_AI).map(x => x.product);
}
function findRelevantFaqs(query) {
  return faqs.map(faq => ({ faq, score: scoreRecord(query, faq, ['question','answer','category','keywords']) }))
    .filter(x => x.score > 0).sort((a,b) => b.score-a.score).slice(0, MAX_FAQS_TO_AI).map(x => x.faq);
}
// Meta FAQ / automation intent: recognize common Bangla, English and Banglish question forms.
function getFaqIntent(text = '') {
  const t = normalizeText(text);
  if (/(ওয়ারেন্টি|ওয়ারেন্টি|গ্যারান্টি|warranty|guarantee|replacement|কত দিনের রিপ্লেস|কত দিনের গ্যারান্টি)/i.test(t)) return 'warranty';
  if (/(দাম|মূল্য|প্রাইস|price|cost|how much|কত টাকা|কত দাম|dam koto|dam koto taka|price koto|rate koto)/i.test(t)) return 'price';
  if (/(ডেলিভারি চার্জ|কুরিয়ার চার্জ|কুরিয়ার চার্জ|delivery charge|courier fee|shipping cost)/i.test(t)) return 'delivery';
  if (/(ইনস্টল|installation|install|মেকানিক|mechanic)/i.test(t)) return 'installation';
  if (/(স্টক আছে|পাওয়া যাবে|পাওয়া যাবে|available|availability|in stock|stock status)/i.test(t)) return 'stock';
  if (/(রিটার্ন|ফেরত|return policy|refund|exchange|এক্সচেঞ্জ)/i.test(t)) return 'return';
  return null;
}
function faqIntentScore(query, faq) {
  const intent = getFaqIntent(query);
  if (!intent) return 0;
  const values = [faq?.question, faq?.q, faq?.category, ...(Array.isArray(faq?.keywords) ? faq.keywords : [faq?.keywords])];
  const fields = normalizeText(values.filter(Boolean).join(' '));
  const patterns = {
    warranty: /ওয়ারেন্টি|ওয়ারেন্টি|গ্যারান্টি|warranty|guarantee|replacement/i,
    price: /দাম|মূল্য|প্রাইস|price|cost|rate|টাকা|price list/i,
    delivery: /ডেলিভারি|কুরিয়ার|কুরিয়ার|delivery|courier|shipping/i,
    installation: /ইনস্টল|installation|install|মেকানিক|mechanic/i,
    stock: /স্টক|available|availability|in stock|পাওয়া যাবে|পাওয়া যাবে/i,
    return: /রিটার্ন|ফেরত|return|refund|exchange|এক্সচেঞ্জ/i
  };
  return patterns[intent]?.test(fields) ? 30 : 0;
}
function findBestFaqMatch(query) {
  const candidates = faqs.map(faq => ({ faq, score: scoreRecord(query, faq, ['question','q','answer','category','keywords']) + faqIntentScore(query, faq) }))
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best && best.score >= 20 && String(best.faq.answer || '').trim() ? best.faq : null;
}
function extractUrls(text = '') {
  return [...String(text || '').matchAll(/https?:\/\/[^\s<>"']+/gi)].map(m => m[0].replace(/[),.!?;]+$/g, ''));
}
function catalogProductForUrl(url) {
  let wanted;
  const canonical = value => { try { const u = new URL(value); return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`; } catch (_) { return ''; } };
  wanted = canonical(url); if (!wanted) return null;
  const matches = products.filter(product => {
    const values = [];
    const walk = (obj, key = '') => {
      if (obj == null) return;
      if (typeof obj === 'string') { if (/url|link|website|page|image|video|reel|media/i.test(key) && /^https?:\/\//i.test(obj)) values.push(obj); return; }
      if (Array.isArray(obj)) { for (const item of obj) walk(item, key); return; }
      if (typeof obj === 'object') for (const [k, v] of Object.entries(obj)) walk(v, k);
    };
    walk(product);
    return values.some(value => canonical(value) === wanted);
  });
  return matches.length === 1 ? matches[0] : null;
}

// Explicit category intents are deliberately separate from generic words like "light".
// Generic media follow-ups must keep the customer's currently active product.
function getExplicitProductCategoryIntent(text = '') {
  const t = normalizeText(text);
  if (/(?:angel\s*wings?|angle\s*wings?|এঞ্জেল\s*উইংস|এঞ্জেল\s*উইং|এঙ্গেল\s*উইংস|এঙ্গেল\s*উইং)/i.test(t)) return 'angelwings';
  if (/(?:fog\s*lights?|foglamps?|fog\s*lamps?|ফগ\s*লাইট|ফগলাইট|ফগ\s*ল্যাম্প)/i.test(t)) return 'foglight';
  if (/(?:head\s*lights?|headlamps?|হেড\s*লাইট|হেডলাইট)/i.test(t)) return 'headlight';
  return null;
}
function getProductCategoryKey(product) {
  if (!product) return null;
  const text = normalizeText([
    product.name, product.category, product.brand, product.model,
    ...(Array.isArray(product.aliases) ? product.aliases : []),
    ...(Array.isArray(product.tags) ? product.tags : []),
    ...(Array.isArray(product.keywords) ? product.keywords : [])
  ].filter(Boolean).join(' '));
  if (/(?:angel\s*wings?|angle\s*wings?|এঞ্জেল\s*উইংস|এঙ্গেল\s*উইংস)/i.test(text)) return 'angelwings';
  if (/(?:fog\s*lights?|foglamps?|fog\s*lamps?|ফগ\s*লাইট|ফগলাইট|ফগ\s*ল্যাম্প)/i.test(text)) return 'foglight';
  if (/(?:head\s*lights?|headlamps?|হেড\s*লাইট|হেডলাইট)/i.test(text)) return 'headlight';
  return null;
}
function getProductsByExplicitCategory(category) {
  if (!category) return [];
  return products.filter(p => getProductCategoryKey(p) === category);
}
function hasClearCategorySwitch(text, senderId) {
  const requested = getExplicitProductCategoryIntent(text);
  if (!requested) return false;
  const active = findActiveProduct(senderId) || findProductFromRecentContext(senderId);
  const activeCategory = getProductCategoryKey(active);
  // Explicit Fog Light / Angel Wings requests should not be answered with generic headlight FAQ.
  if (requested === 'foglight' || requested === 'angelwings') return activeCategory !== requested;
  return Boolean(activeCategory && activeCategory !== requested);
}
function resolveMediaProduct(text, senderId) {
  const explicit = findExactProduct(text);
  if (explicit) { rememberActiveProduct(senderId, explicit); return { product: explicit, categoryProducts: [] }; }
  const category = getExplicitProductCategoryIntent(text);
  const active = findActiveProduct(senderId);
  if (category) {
    if (active && getProductCategoryKey(active) === category) return { product: active, categoryProducts: [] };
    const choices = getProductsByExplicitCategory(category);
    if (choices.length === 1) { rememberActiveProduct(senderId, choices[0]); return { product: choices[0], categoryProducts: [] }; }
    if (choices.length > 1) return { product: null, categoryProducts: choices.slice(0, 3) };
  }
  // Critical: do NOT run fuzzy product search on "light photo/video". It can switch to fog lights.
  return { product: active || findProductFromRecentContext(senderId), categoryProducts: [] };
}

function getHistory(senderId) {
  const id = String(senderId || '');
  if (!id) return [];
  if (customerHistory.has(id)) return customerHistory.get(id);
  const history = [];
  for (const m of db.messages) {
    if (String(m.senderId) !== id) continue;
    let role;
    if (['customer','user'].includes(m.sender)) role = 'user';
    else if (['bot','assistant','admin'].includes(m.sender)) role = 'assistant';
    else continue;
    history.push({ role, text: String(m.text || ''), timestamp: new Date(m.timestamp || Date.now()).getTime() });
  }
  const limited = history.slice(-HISTORY_LIMIT);
  customerHistory.set(id, limited);
  return limited;
}
function appendHistory(senderId, role, text) {
  if (!senderId || !text) return;
  const id = String(senderId), history = getHistory(id);
  history.push({ role, text: String(text).trim(), timestamp: Date.now() });
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  customerHistory.set(id, history);
}
function getRecentConversationText(senderId, additionalText = '') {
  return [...getHistory(senderId).slice(-HISTORY_LIMIT).map(x => x.text), additionalText].filter(Boolean).join('\n');
}
function getPreviousAssistantReply(senderId, userText) {
  const history = getHistory(senderId), normalized = normalizeText(userText);
  for (let i = history.length - 2; i >= 0; i--) if (history[i].role === 'user' && normalizeText(history[i].text) === normalized) {
    for (let j = i + 1; j < history.length; j++) if (history[j].role === 'assistant') return history[j].text;
  }
  return null;
}
function updateCustomerMemory(senderId, customerText) {
  const text = String(customerText || '').trim();
  if (!senderId || !text || text.length > 1000) return;
  const id = String(senderId), memory = getCustomerMemory(id), customer = db.customers[id] || {};
  // Do not use fuzzy word overlap for active-product memory: "light photo/video" must
  // continue the existing topic, not switch to a Fog Light or another light category.
  const explicitlyNamedProduct = findExactProduct(text);
  if (explicitlyNamedProduct) {
    memory.facts = memory.facts.filter(item => !/^বর্তমান আলোচ্য পণ্য:|^আলোচিত পণ্য:/i.test(String(item)));
    addUniqueMemoryItem(memory.facts, `বর্তমান আলোচ্য পণ্য: ${explicitlyNamedProduct.name} (ID: ${explicitlyNamedProduct.id})`);
    customer.activeProductId = explicitlyNamedProduct.id;
    customer.activeProductName = explicitlyNamedProduct.name || null;
    customer.activeProductUpdatedAt = new Date().toISOString();
  }
  // Keep the bike/car model separately from the current product topic.
  const knownVehicle = rememberVehicleModel(id, text);
  if (knownVehicle) customer.vehicleModelName = knownVehicle.model;
  const phone = text.match(/(?:\+?8801|01)[0-9\s-]{8,14}/);
  if (phone) customer.phone = phone[0].replace(/[\s-]/g, '');
  const vehicle = text.match(/(?:আমার|my)\s*(?:বাইক|মোটরসাইকেল|গাড়ি|bike|motorcycle|car)[^।.!?\n]{0,120}/i);
  if (vehicle) addUniqueMemoryItem(memory.preferences, vehicle[0], 20);
  const address = text.match(/(?:ঠিকানা|address|বাসা|গ্রাম|রোড|road|থানা|উপজেলা|জেলা|গ্রাম)[\s:：-]*[^।.!?\n]{5,180}/i);
  if (address) { customer.address = address[0].slice(0, 220); addUniqueMemoryItem(memory.facts, `ঠিকানা: ${customer.address}`); }
  const preference = text.match(/(?:আমার পছন্দ|আমার বাজেট|বাজেট|ডেলিভারি|রং|কালার)[^।.!?\n]{0,120}/i);
  if (preference) addUniqueMemoryItem(memory.preferences, preference[0], 20);
  if (text.length >= 8 && !/^(হ্যাঁ|না|ok|okay|ধন্যবাদ|thanks)$/i.test(text)) memory.summary = [...(memory.summary ? [memory.summary] : []), `গ্রাহক বলেছেন: ${text.slice(0, 180)}`].slice(-8).join('\n');
  memory.updatedAt = new Date().toISOString(); customer.lastMemoryUpdatedAt = memory.updatedAt;
  db.customers[id] = customer; saveStorage();
}
function buildCustomerMemoryContext(senderId) {
  const m = getCustomerMemory(senderId);
  if (!m) return 'কোনো সংরক্ষিত মেমোরি নেই।';
  return [m.facts.length ? `তথ্য:\n- ${m.facts.slice(-15).join('\n- ')}` : '', m.preferences.length ? `পছন্দ/প্রসঙ্গ:\n- ${m.preferences.slice(-10).join('\n- ')}` : '', m.summary ? `সারাংশ:\n${m.summary}` : ''].filter(Boolean).join('\n\n') || 'কোনো সংরক্ষিত মেমোরি নেই।';
}
function pruneOldMemory() {
  const cutoff = Date.now() - MEMORY_RETENTION_MS;
  for (const [id, m] of Object.entries(db.customerMemory)) {
    const updated = new Date(m.updatedAt || 0).getTime();
    if (!updated || updated < cutoff) delete db.customerMemory[id];
  }
  for (const [id, c] of Object.entries(db.customers)) {
    const active = new Date(c.lastActive || 0).getTime();
    if (active && active < cutoff && !db.orders.some(o => String(o.senderId || o.customerId) === id && !['CANCELLED','CANCELED','REJECTED'].includes(String(o.status).toUpperCase()))) {
      // Keep customer/order records for admin history; only trim conversational memory.
      customerHistory.delete(id);
    }
  }
}

// -----------------------------------------------------------------------------
// Catalog
// -----------------------------------------------------------------------------
function validateCatalogShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Catalog must be a JSON object');
  if (!Array.isArray(data.products)) throw new Error('Catalog must contain a products array');
  const ids = new Set();
  for (const p of data.products) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Every product must be an object');
    const id = String(p.id ?? '').trim();
    if (!id) throw new Error('Every product must have an ID');
    if (ids.has(id)) throw new Error('Duplicate product ID: ' + id);
    ids.add(id);
  }
  if (data.faqs !== undefined && !Array.isArray(data.faqs)) throw new Error('Catalog FAQs must be an array');
  return true;
}

// Default catalog updates are MERGES, not full replacements. Missing products are retained.
// To intentionally remove products, pass deleteProductIds: ["id1", "id2"].
// To intentionally replace the entire catalog, pass replaceAll: true.
function mergeCatalogData(current, incoming) {
  validateCatalogShape(incoming);
  const oldProducts = Array.isArray(current?.products) ? current.products : [];
  const oldFaqs = Array.isArray(current?.faqs) ? current.faqs : [];
  const incomingProducts = incoming.products;
  if (oldProducts.length && incomingProducts.length === 0 && incoming.replaceAll !== true && !(Array.isArray(incoming.deleteProductIds) && incoming.deleteProductIds.length)) {
    throw new Error('Refusing empty product catalog update because it would risk deleting existing products. Use replaceAll:true only for an intentional full replacement.');
  }

  const productMap = new Map(oldProducts.map(p => [String(p.id), { ...p }]));
  for (const p of incomingProducts) {
    const id = String(p.id);
    productMap.set(id, productMap.has(id) ? { ...productMap.get(id), ...p, id } : { ...p, id });
  }
  if (Array.isArray(incoming.deleteProductIds)) {
    for (const id of incoming.deleteProductIds) productMap.delete(String(id));
  }
  let mergedProducts = Array.from(productMap.values());
  if (incoming.replaceAll === true) {
    mergedProducts = incomingProducts.map(p => ({ ...p }));
    if (Array.isArray(incoming.deleteProductIds)) mergedProducts = mergedProducts.filter(p => !incoming.deleteProductIds.map(String).includes(String(p.id)));
  }

  const faqKey = f => String(f?.id ?? f?.question ?? f?.q ?? '').trim().toLowerCase();
  const faqMap = new Map(oldFaqs.map((f, i) => [faqKey(f) || `__old_${i}`, { ...f }]));
  for (const f of (Array.isArray(incoming.faqs) ? incoming.faqs : [])) {
    const key = faqKey(f) || `__new_${crypto.randomUUID()}`;
    faqMap.set(key, faqMap.has(key) ? { ...faqMap.get(key), ...f } : { ...f });
  }
  if (incoming.replaceAll === true) {
    faqMap.clear();
    for (const f of (Array.isArray(incoming.faqs) ? incoming.faqs : [])) faqMap.set(faqKey(f) || `__new_${crypto.randomUUID()}`, { ...f });
  }
  if (Array.isArray(incoming.deleteFaqIds)) {
    for (const id of incoming.deleteFaqIds.map(String)) {
      for (const [key, faq] of faqMap) if (String(faq.id ?? faq.question ?? faq.q ?? '') === id) faqMap.delete(key);
    }
  }
  const result = { ...current, ...incoming, products: mergedProducts, faqs: Array.from(faqMap.values()), version: incoming.version ?? Date.now(), updatedAt: incoming.updatedAt ?? new Date().toISOString() };
  delete result.deleteProductIds;
  delete result.deleteFaqIds;
  delete result.replaceAll;
  return result;
}
function applyCatalog(data, source = 'local') {
  validateCatalogShape(data);
  products = data.products.map(p => ({ ...p }));
  faqs = Array.isArray(data.faqs) ? data.faqs.map(f => ({ ...f })) : [];
  catalogMeta = { version: data.version ?? null, updatedAt: data.updatedAt ?? null, source, lastSyncAt: new Date().toISOString(), lastSyncError: null };
}
function loadLocalCatalog() {
  try {
    if (!fs.existsSync(LOCAL_CATALOG_PATH)) return { products, faqs, version: catalogMeta.version, updatedAt: catalogMeta.updatedAt };
    const data = JSON.parse(fs.readFileSync(LOCAL_CATALOG_PATH, 'utf8'));
    validateCatalogShape(data);
    // Existing local file is the persisted baseline; load it as-is at startup.
    applyCatalog(data, 'local');
    return data;
  } catch (err) { console.error('[CATALOG] Local load error:', err.message); catalogMeta.lastSyncError = err.message; return { products, faqs, version: catalogMeta.version, updatedAt: catalogMeta.updatedAt }; }
}
function saveLocalCatalog(data, source = 'local') {
  validateCatalogShape(data);
  const temp = LOCAL_CATALOG_PATH + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, LOCAL_CATALOG_PATH);
  applyCatalog(data, source);
}
loadLocalCatalog();

// -----------------------------------------------------------------------------
// Admin authentication
// -----------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  if (!REQUIRE_ADMIN_SECRET) return next();
  if (!ADMIN_SECRET) return res.status(503).json({ success: false, message: 'ADMIN_SECRET is not configured' });
  const supplied = String(req.get('x-admin-secret') || req.get('authorization')?.replace(/^Bearer\s+/i, '') || '');
  const a = Buffer.from(supplied), b = Buffer.from(ADMIN_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ success: false, message: 'Unauthorized' });
  next();
}
app.use('/api', (req, res, next) => ['/health','/status'].includes(req.path) ? next() : requireAdmin(req, res, next));

// -----------------------------------------------------------------------------
// Product lookup, price and media
// -----------------------------------------------------------------------------
const GENERIC_PRODUCT_IDENTIFIERS = new Set([
  'light','lights','headlight','head light','headlamp','head lamp','fog light','fog lights','fog lamp','fog lamps',
  'bulb','led','projector','angel wings','angle wings','picture','pic','photo','image','video','reel',
  'লাইট','হেডলাইট','হেড লাইট','বাল্ব','প্রজেক্টর','ফগ লাইট','ছবি','ফটো','ভিডিও','দাম','price'
].map(normalizeText));
function getProductIdentifiers(p) {
  const aliases = (Array.isArray(p.aliases) ? p.aliases : []).filter(alias => !GENERIC_PRODUCT_IDENTIFIERS.has(normalizeText(alias)));
  return [p.name,p.id,p.sku,p.model,...aliases].filter(Boolean).map(normalizeText).filter(Boolean);
}
function findExactProduct(query) {
  const q = normalizeText(query); if (!q) return null;
  const matches = products.filter(p => getProductIdentifiers(p).some(name => name.length >= 3 && (` ${q} `).includes(` ${name} `)));
  return matches.length === 1 ? matches[0] : null;
}
function findActiveProduct(senderId) {
  const customer = db.customers[String(senderId || '')] || {};
  const id = customer.activeProductId;
  return id ? (products.find(p => String(p.id) === String(id)) || null) : null;
}
function rememberActiveProduct(senderId, product) {
  if (!senderId || !product) return;
  const id = String(senderId);
  if (!db.customers[id]) db.customers[id] = { id, name: `Customer ${id.slice(-4)}`, messageCount: 0 };
  db.customers[id].activeProductId = product.id;
  db.customers[id].activeProductName = product.name || null;
  const memory = getCustomerMemory(id);
  memory.facts = memory.facts.filter(item => !/^বর্তমান আলোচ্য পণ্য:|^আলোচিত পণ্য:/i.test(String(item)));
  addUniqueMemoryItem(memory.facts, `বর্তমান আলোচ্য পণ্য: ${product.name} (ID: ${product.id})`);
  memory.updatedAt = new Date().toISOString();
  db.customers[id].lastMemoryUpdatedAt = memory.updatedAt;
  saveStorage();
}
function findProductFromRecentContext(senderId) {
  const active = findActiveProduct(senderId);
  if (active) return active;
  const history = getHistory(senderId);
  for (let i = history.length - 1; i >= 0; i--) { if (history[i].role !== 'user') continue; const p = findExactProduct(history[i].text); if (p) return p; }
  const memory = getCustomerMemory(senderId);
  for (const fact of [...(memory?.facts || [])].reverse()) { const p = findExactProduct(fact); if (p) return p; }
  return null;
}
function isPriceQuestion(text='') { return /\b(price|cost|how much|rate)\b|দাম|প্রাইস|মূল্য|কত টাকা|কত দাম|দাম কত|দামটা|কততে/i.test(normalizeText(text)); }
function isGenericPriceQuestion(text='') { return isPriceQuestion(text) && /^(দাম|দাম কত|দামটা কত|প্রাইস|প্রাইস কত|মূল্য|মূল্য কত|কত টাকা|কত দাম|price|how much|how much is it|what is the price)$/.test(normalizeText(text)); }
function getPriceReply(p) { return p && p.price !== undefined && p.price !== null && String(p.price).trim() !== '' ? `${p.name}-এর দাম ${p.price} টাকা।` : null; }
// Smart Billing: quote only from catalog prices and the published delivery rates.
function isBillingQuestion(text='') { return /মোট|সর্বমোট|বিল|বিলিং|invoice|bill|total|grand total|সব মিলিয়ে|সব মিলিয়ে|ডেলিভারি চার্জ|delivery charge|কুরিয়ার চার্জ|কুরিয়ার চার্জ|কত পড়বে|কত পড়বে|কত হবে|quantity|পরিমাণ|পিস|টি কিনলে/i.test(normalizeText(text)); }
function extractQuantity(text='') {
  const t=String(text||'').replace(/[০-৯]/g,d=>String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
  const patterns=[/(?:পরিমাণ|quantity|qty|পিস|টি)\s*[:=]?\s*(\d{1,3})/i,/(\d{1,3})\s*(?:পিস|টি|টা|pcs|pieces)/i];
  for(const re of patterns){const m=t.match(re);if(m){const n=Number(m[1]);if(Number.isInteger(n)&&n>=1&&n<=1000)return n;}}
  return null;
}
function getDeliveryFee(addressOrText='') {
  const t=normalizeText(addressOrText);
  if(!t)return null;
  if(/গাজীপুর|gazipur/.test(t))return 50;
  // Published policy: Gazipur 50 BDT; any confirmed address outside Gazipur 100 BDT.
  return 100;
}
function buildSmartBillReply(product, quantity, deliveryFee) {
  const unit=Number(product?.price);
  if(!product || !Number.isFinite(unit) || unit<0 || String(product.price??'').trim()==='')return `দুঃখিত, ${product?.name||'এই পণ্য'}-এর নির্ভরযোগ্য মূল্য ক্যাটালগে নেই, তাই সঠিক বিল হিসাব করা যাচ্ছে না।`;
  const subtotal=unit*quantity;
  if(deliveryFee===null)return `${product.name} × ${quantity} = ${subtotal} টাকা। ডেলিভারি চার্জ ও সর্বমোট হিসাব করতে আপনার ডেলিভারি এলাকা/জেলার নাম বলুন।`;
  return `স্মার্ট বিল\nপণ্য: ${product.name}\nএকক মূল্য: ${unit} টাকা × ${quantity} = ${subtotal} টাকা\nডেলিভারি: ${deliveryFee} টাকা\nসর্বমোট: ${subtotal+deliveryFee} টাকা`;
}
function isFacebookLink(url) { try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === 'facebook.com' || u.hostname.endsWith('.facebook.com') || u.hostname === 'fb.watch'); } catch (_) { return false; } }
function getProductMediaUrls(p, type) { const media = p?.media; return media && Array.isArray(media[type]) ? media[type].filter(url => typeof url === 'string' && isFacebookLink(url)) : []; }
function getMediaType(text='') { const v=normalizeText(text); if (/ভিডিও|ভিডিয়ো|video|reel|রিল|clip|ভিডিওটা|ভিডিও দেন|ভিডিও দাও/i.test(v)) return 'videos'; if (/ছবি|ফটো|পিকচার|ইমেজ|image|photo|picture|\bpic\b|pic den|pic dao|ছবি দেন|ছবি দিন|ছবি দাও/i.test(v)) return 'images'; return null; }
function getProductMediaReply(text, senderId) {
  const type = getMediaType(text); if (!type) return null;
  const resolved = resolveMediaProduct(text, senderId);
  if (resolved.categoryProducts.length) {
    const lines = [];
    for (const p of resolved.categoryProducts) {
      const urls = getProductMediaUrls(p, type);
      if (urls.length) lines.push(`${p.name}: ${urls.slice(0, 2).join(' | ')}`);
    }
    if (lines.length) return `ক্যাটালগে পাওয়া ${type === 'images' ? 'ছবি' : 'ভিডিও'}:\n${lines.join('\n')}`;
    return `এই ক্যাটাগরির পণ্যের ${type === 'images' ? 'ছবি' : 'ভিডিও'} লিংক ক্যাটালগে পাওয়া যাচ্ছে না।`;
  }
  const p = resolved.product;
  if (!p) return 'এই কথোপকথনে কোন পণ্যের কথা হচ্ছে তা শনাক্ত করতে পারিনি। অনুগ্রহ করে পণ্যের ছবি বা সঠিক নাম/মডেল পাঠান।';
  const urls = getProductMediaUrls(p, type);
  if (!urls.length) return `${p.name}-এর ${type==='images'?'ছবি':'ভিডিও'} লিংক বর্তমান ক্যাটালগে পাওয়া যাচ্ছে না।`;
  return `${p.name}-এর ${type==='images'?'ছবি':'ভিডিও'} লিংক:\n${urls.slice(0, 3).map((u,i)=>`${i+1}. ${u}`).join('\n')}`;
}

// -----------------------------------------------------------------------------
// Vehicle/headlight reference table (based on the user's supplied compatibility list).
// Values are used as the configured business reference; they have not been independently verified.
// -----------------------------------------------------------------------------
const VEHICLE_FITMENT_DATA = String.raw`BAJAJ~Pulsar 150 (Single / Twin Disc / Neon / SD)~Pulsar 150;Pulsar 150 SD;Pulsar 150 Neon;Pulsar 150 Single Disc;Pulsar 150 Twin Disc;পালসার 150~2001-2026~149 CC~H4 / HS1~Direct Plug-and-Play (DC Conversion Required)
BAJAJ~Pulsar 125 / Pulsar NS125~Pulsar 125;Pulsar NS125;NS 125;পালসার 125~2019-2026~124.4 CC~H4 / HS1~Direct Plug-and-Play
BAJAJ~Pulsar 135 LS~Pulsar 135;Pulsar 135 LS;পালসার 135~2010-2018~135 CC~H4~Direct Plug-and-Play
BAJAJ~Pulsar 180 / 180 Neon / 220F (Halogen)~Pulsar 180;Pulsar 180 Neon;Pulsar 220F;220F Halogen;পালসার 180;পালসার 220~2002-2021~178.6-220 CC~H4~Direct Plug-and-Play
BAJAJ~Discover 100 / 100M / 100T~Discover 100;Discover 100M;Discover 100T;ডিসকভার 100;ডিসকভার 100m;ডিসকভার 100t~2009-2020~94.3-102 CC~HS1 / H4~Direct Fit (DC Conversion Required)
BAJAJ~Discover 110~Discover 110;ডিসকভার 110~2018-2022~115.5 CC~HS1 / H4~Direct Plug-and-Play
BAJAJ~Discover 125 / 125 ST / Disc~Discover 125;Discover 125 ST;Discover 125 Disc;ডিসকভার 125~2004-2026~124.5 CC~HS1 / H4~Direct Plug-and-Play
BAJAJ~Discover 135 Disc~Discover 135;Discover 135 Disc;ডিসকভার 135~2007-2012~134.2 CC~H4~Direct Plug-and-Play
BAJAJ~Discover 150 / 150F / 150S~Discover 150;Discover 150F;Discover 150S;ডিসকভার 150~2010-2016~144.8 CC~H4~Direct Plug-and-Play
BAJAJ~Platina 100 / ES / Comfortec~Platina 100;Platina ES;Platina Comfortec;প্লাটিনা 100~2006-2026~99.3 CC~HS1 / H4~Direct Fit (DC Conversion Required)
BAJAJ~Platina 110 H-Gear / ES~Platina 110;Platina 110 H-Gear;Platina 110 ES;প্লাটিনা 110~2019-2026~115.4 CC~HS1 / H4~Direct Plug-and-Play
BAJAJ~CT 100 / CT 100 ES / CT 110~CT 100;CT 100 ES;CT 110;বাজাজ CT 100~2003-2026~99.3-115 CC~HS1 / H4~Direct Fit (DC Conversion Required)
BAJAJ~Avenger 150 / 160 Street~Avenger 150;Avenger 160;Avenger 160 Street;অ্যাভেঞ্জার 150~2016-2026~150-160 CC~H4~Direct Plug-and-Play
BAJAJ~V15 / V12~Bajaj V15;Bajaj V12;V15;V12~2016-2020~124.5-149.5 CC~H4~Direct Plug-and-Play
YAMAHA~FZ V1 / FZ-S V1~Yamaha FZ V1;FZ V1;FZ-S V1;FZS V1;ইয়ামাহা FZ V1;ইয়ামাহা FZ V1~2008-2015~153 CC~H4~Direct Plug-and-Play
YAMAHA~FZ V2 / FZ-S V2 / FZER V2~Yamaha FZ V2;FZ V2;FZ-S V2;FZS V2;FZER V2;FZ ER V2;ইয়ামাহা FZ V2;ইয়ামাহা FZ V2~2014-2021~149 CC~H4~Direct Plug-and-Play
YAMAHA~FAZER V1 / FAZER V2~Yamaha Fazer V1;Fazer V1;Fazer V2;FAZER V1;FAZER V2;ফেজার V1;ফেজার V2~2009-2020~149-153 CC~H4 (Dual)~Direct Plug-and-Play
YAMAHA~SZ-R 153 / SZ-RR V2~Yamaha SZ-R 153;SZ-R 153;SZ-RR V2;SZRR V2~2011-2021~149-153 CC~H4~Direct Plug-and-Play
YAMAHA~Saluto 125 / Disc~Yamaha Saluto 125;Saluto 125;Saluto;Saluto Disc~2016-2022~125 CC~H4 / HS1~Direct Plug-and-Play
YAMAHA~YBR 125 / Custom / YBX~Yamaha YBR 125;YBR 125;YBR Custom;YBX;Yamaha YBX~2011-2017~124 CC~H4~Direct Plug-and-Play
YAMAHA~Crux 106~Yamaha Crux 106;Crux 106;ক্রুক্স 106~2003-2014~106 CC~H4 / HS1~Direct Fit (DC Conversion Required)
YAMAHA~RayZR 113 / Alpha (Halogen Trim)~Yamaha RayZR 113;RayZR 113;RayZR;Ray ZR 113;Yamaha Alpha;Alpha Halogen~2016-2020~113 CC~HS1 / H4~Direct Plug-and-Play
TVS~Apache RTR 150 / Hyper Edge~TVS Apache RTR 150;Apache RTR 150;Apache Hyper Edge;Hyper Edge~2007-2012~149.7 CC~HS1 / H4~Direct Plug-and-Play
TVS~Apache RTR 160 2V (Single / Twin Disc)~TVS Apache RTR 160 2V;Apache RTR 160 2V;Apache 160 2V;Apache RTR 160 Single Disc;Apache RTR 160 Twin Disc~2008-2026~159.7 CC~H4 / HS1~Direct Plug-and-Play
TVS~Apache RTR 180 2V~TVS Apache RTR 180;Apache RTR 180 2V;Apache 180 2V~2011-2019~177.4 CC~H4~Direct Plug-and-Play
TVS~Apache RTR 160 4V (Carb Halogen Trim)~Apache RTR 160 4V;TVS Apache 160 4V Carb;Apache 160 4V Halogen~2018-2020~159.7 CC~H4~Direct Fit
TVS~Metro 100 / KLS / ELS~TVS Metro 100;Metro 100;Metro KLS;Metro ELS;TVS Metro~2009-2026~99.7 CC~HS1 / H4~Direct Fit (DC Conversion Required)
TVS~Metro Plus 110 / RE~TVS Metro Plus 110;Metro Plus 110;Metro RE~2014-2026~109.7 CC~H4 / HS1~Direct Plug-and-Play
TVS~Stryker 125~TVS Stryker 125;Stryker 125~2016-2022~124.53 CC~H4~Direct Plug-and-Play
TVS~Radeon 110~TVS Radeon 110;Radeon 110~2019-2026~109.7 CC~H4~Direct Plug-and-Play
TVS~Star City / Star City Plus~TVS Star City;Star City Plus;TVS Star City Plus~2005-2020~99.7-109.7 CC~HS1 / H4~Direct Fit (DC Conversion Required)
TVS~Victor 110~TVS Victor 110;Victor 110~2016-2020~109.7 CC~H4 / HS1~Direct Plug-and-Play
TVS~XL 100 / Heavy Duty / i-Touch~TVS XL 100;XL 100 Heavy Duty;XL 100 i-Touch;XL100~2017-2026~99.7 CC~HS1 / H4~Direct Fit (DC Conversion Required)
TVS~Jupiter 110 / Wego 110~TVS Jupiter 110;Jupiter 110;Jupiter;TVS Wego 110;Wego 110;Wego;TVS Wego~2013-2022~109.7 CC~HS1 / H4~Direct Plug-and-Play
HONDA~CB Shine 125 / Shine SP~Honda CB Shine 125;CB Shine 125;Shine 125;Shine;Honda Shine SP;Shine SP;হোন্ডা শাইন 125~2012-2026~124.73 CC~H4~Direct Plug-and-Play
HONDA~CB Unicorn 150 / Unicorn 160~Honda CB Unicorn 150;CB Unicorn 150;Honda Unicorn 160;Unicorn 160;ইউনিকর্ন 150~2010-2021~149.2-162.7 CC~H4~Direct Plug-and-Play
HONDA~CB Trigger 150~Honda CB Trigger 150;CB Trigger 150;Honda Trigger 150~2013-2018~149.1 CC~H4~Direct Plug-and-Play
HONDA~CB Hornet 160R (Halogen Version)~Honda CB Hornet 160R;CB Hornet 160R;Hornet 160R Halogen~2016-2019~162.7 CC~H4~Direct Plug-and-Play
HONDA~Livo 110 / Disc~Honda Livo 110;Livo 110;Honda Livo Disc;Livo Disc~2015-2026~109.19 CC~H4~Direct Plug-and-Play
HONDA~Dream Neo 110 / Dream 110 / CD 110~Honda Dream Neo 110;Dream Neo 110;Honda Dream 110;Dream 110;Honda CD 110;CD 110~2014-2026~109.19 CC~H4~Direct Plug-and-Play
HONDA~Dio 110 / Activa (Halogen Trim)~Honda Dio 110;Dio 110;Dio;Honda Activa;Activa;Activa Halogen;Honda Activa Halogen~2015-2020~109.2 CC~HS1 / H4~Direct Plug-and-Play
SUZUKI~Gixxer 155 / Gixxer SF (Halogen Carb)~Suzuki Gixxer 155;Gixxer 155;Gixxer SF Halogen;Gixxer SF Carb;Gixxer SF~2015-2019~154.9 CC~H4~Direct Plug-and-Play
SUZUKI~GSX 125~Suzuki GSX 125;GSX125~2020-2026~125 CC~H4~Direct Plug-and-Play
SUZUKI~GS150R~Suzuki GS150R;GS 150 R~2010-2016~149.5 CC~H4~Direct Plug-and-Play
SUZUKI~Hayate 110 / Hayate EP~Suzuki Hayate 110;Hayate 110;Hayate EP~2015-2022~113 CC~H4~Direct Plug-and-Play
SUZUKI~Slingshot 125~Suzuki Slingshot 125;Slingshot 125~2011-2015~124 CC~H4~Direct Plug-and-Play
SUZUKI~Access 125 / Let’s 110~Suzuki Access 125;Access 125;Suzuki Lets 110;Suzuki Let’s 110;Lets 110;Let’s 110~2014-2020~112.8-124 CC~HS1 / H4~Direct Plug-and-Play
HERO~Hunk 150 / Matt Edition / DD~Hero Hunk 150;Hunk 150;Hunk Matt Edition;Hunk DD~2008-2022~149.2 CC~H4~Direct Plug-and-Play
HERO~Glamour 125 / BS4 / i3S~Hero Glamour 125;Glamour 125;Glamour BS4;Glamour i3S~2006-2026~124.7 CC~H4 / HS1~Direct Plug-and-Play
HERO~Passion Pro / Passion XPro / XTec~Hero Passion Pro;Passion Pro;Passion XPro;Passion XTec;Passion Xtec~2010-2026~97.2-109.1 CC~H4 / HS1~Direct Plug-and-Play
HERO~Splendor Plus / Pro / iSmart 110~Hero Splendor Plus;Splendor Plus;Hero Splendor Pro;Splendor Pro;Hero iSmart 110;Splendor iSmart 110~2004-2026~97.2-109.1 CC~HS1 / H4~Direct Fit (DC Conversion Required)
HERO~HF Deluxe / Dawn~Hero HF Deluxe;HF Deluxe;Hero Dawn;Hero HF Dawn~2012-2026~97.2 CC~HS1 / H4~Direct Fit (DC Conversion Required)
HERO~Xtreme 150 / Xtreme Sports~Hero Xtreme 150;Xtreme 150;Hero Xtreme Sports;Xtreme Sports~2011-2019~149.2 CC~H4~Direct Plug-and-Play
HERO~Achiever 150~Hero Achiever 150;Achiever 150~2012-2019~149.1 CC~H4~Direct Plug-and-Play
HERO~Ignitor 125~Hero Ignitor 125;Ignitor 125~2018-2023~124.7 CC~H4~Direct Plug-and-Play
HERO~Pleasure 100 / Maestro Edge 110 (Halogen)~Hero Pleasure 100;Pleasure 100;Pleasure;Hero Maestro Edge 110;Maestro Edge 110;Maestro Edge 110 Halogen;Maestro Edge Halogen~2012-2020~102-110 CC~HS1 / H4~Direct Plug-and-Play
RUNNER / OTHER~Turbo 125~Runner Turbo 125;Turbo 125;রানার টার্বো 125~2013-2026~124.8 CC~H4~Direct Plug-and-Play
RUNNER / OTHER~Knight Rider 150~Runner Knight Rider 150;Knight Rider 150~2017-2023~150 CC~H4~Direct Plug-and-Play
RUNNER / OTHER~Royal 110 / Cheeta 100~Runner Royal 110;Royal 110;Runner Cheeta 100;Cheeta 100;Runner Cheetah 100~2012-2026~100-110 CC~HS1 / H4~Direct Fit (DC Conversion Required)
RUNNER / OTHER~Bullet 100 / V2~Runner Bullet 100;Bullet 100;Runner Bullet V2;Bullet V2~2013-2026~100 CC~HS1 / H4~Direct Fit (DC Conversion Required)
RUNNER / OTHER~Skymate 110 / AD80S~Runner Skymate 110;Skymate 110;Runner AD80S;AD80S~2010-2026~85-110 CC~HS1 / H4~Direct Fit (DC Conversion Required)
RUNNER / OTHER~Keeway RKS 125 / RKS 150 / CBS~Keeway RKS 125;RKS 125;Keeway RKS 150;RKS 150;Keeway RKS CBS;RKS CBS~2015-2023~124.8-148 CC~H4~Direct Plug-and-Play
RUNNER / OTHER~Keeway Superlight 150 / K-Light 150/200~Keeway Superlight 150;Superlight 150;Keeway K-Light 150;K-Light 150;Keeway K-Light 200;K-Light 200~2016-2026~149.3-197 CC~H4~Direct Plug-and-Play
RUNNER / OTHER~Keeway Magnet 100~Keeway Magnet 100;Magnet 100~2016-2022~99 CC~HS1 / H4~Direct Plug-and-Play
RUNNER / OTHER~Lifan KPR 150 / KPR 165 (Halogen)~Lifan KPR 150;KPR 150;Lifan KPR 165;KPR 165 Halogen~2015-2026~149-165 CC~H4~Direct Plug-and-Play
RUNNER / OTHER~Lifan Victor R 100 / KP Mini 150~Lifan Victor R 100;Victor R 100;Lifan KP Mini 150;KP Mini 150~2016-2024~100-150 CC~H4 / HS1~Direct Plug-and-Play
RUNNER / OTHER~Speeder Countryman 165~Speeder Countryman 165;Countryman 165~2018-2026~163.7 CC~H4~Direct Plug-and-Play
RUNNER / OTHER~Speeder FX 150~Speeder FX 150;FX 150~2017-2023~150 CC~H4~Direct Plug-and-Play
TOYOTA~Corolla X / G (E120 Chassis)~Toyota Corolla X;Corolla X;Corolla;Corolla X E120;Toyota Corolla G;Corolla G;Corolla G E120;Corolla E120~2000-2006~1500 CC~H4 Dual Filament~Direct Plug-and-Play
TOYOTA~Axio X-Grade (E140 & E160)~Toyota Axio X Grade;Axio X Grade;Axio E140;Axio E160;Axio;Toyota Axio~2006-2020~1500 CC~H4 Halogen~Direct Plug-and-Play
TOYOTA~Probox / Succeed~Toyota Probox;Probox;Toyota Succeed;Succeed~2002-2026~1300-1500 CC~H4 Halogen~Direct Plug-and-Play
TOYOTA~Premio / Allion (NZT240 Halogen Grade)~Toyota Premio;Premio;Premio NZT240;Toyota Allion;Allion;Allion NZT240~2001-2007~1500-1800 CC~H4 Halogen~Direct Mountable
TOYOTA~Vitz / Yaris (XP10 / XP90 Halogen)~Toyota Vitz;Vitz;Vitz XP10;Vitz XP90;Toyota Yaris;Yaris;Yaris XP10;Yaris XP90~1999-2010~1000-1300 CC~H4 Halogen~Direct Plug-and-Play
TOYOTA~TownAce / LiteAce Van~Toyota TownAce;TownAce;TownAce Van;Toyota LiteAce;LiteAce;LiteAce Van~2008-2026~1500 CC~H4 Halogen~Direct Fit
TOYOTA~HiAce Van (H200 Halogen Trim)~Toyota HiAce;HiAce;Toyota HiAce H200;HiAce H200 Halogen;HiAce Van~2004-2019~2000-2700 CC~H4 Halogen~Direct Plug-and-Play
SUZUKI~Alto (BD & Japanese HA25/HA36)~Suzuki Alto;Alto;Alto BD;Alto HA25;Alto HA36;Suzuki Alto HA25;Suzuki Alto HA36~2000-2026~660-1000 CC~H4 Halogen~Direct Plug-and-Play
SUZUKI~Wagon R (FX Trim)~Suzuki Wagon R;Wagon R;Wagon R FX;Wagon R FX Trim~2010-2026~660-1000 CC~H4 Halogen~Direct Plug-and-Play
SUZUKI~Swift (Halogen Trim)~Suzuki Swift;Swift;Swift Halogen~2005-2017~1200-1300 CC~H4 Halogen~Direct Plug-and-Play
HYUNDAI~Grand i10 / i10~Hyundai Grand i10;Grand i10;Hyundai i10;i10~2008-2020~1000-1200 CC~H4 Halogen~Direct Fit
HYUNDAI~Eon~Hyundai Eon;Eon~2012-2019~800-1000 CC~H4 Halogen~Direct Fit
NISSAN~Sunny / Sun FB15~Nissan Sunny;Sunny FB15;Nissan Sun FB15;Sun FB15~1998-2004~1300-1500 CC~H4 Halogen~Direct Fit
NISSAN~AD Van / NV150 AD~Nissan AD Van;AD Van;Nissan NV150 AD;NV150 AD~2006-2021~1200-1500 CC~H4 Halogen~Direct Plug-and-Play`.trim().split(/\r?\n/).map((line, index) => {
  const [brand, model, aliases, years, cc, socket, fitment] = line.split('~');
  return { id: index + 1, brand, model, aliases: String(aliases || '').split(';').filter(Boolean), years, cc, socket, fitment };
});
function compactVehicleText(value = '') {
  return normalizeText(value).replace(/[^\p{L}\p{N}]/gu, '');
}
function findVehicleCompatibility(text = '') {
  const query = compactVehicleText(text);
  if (!query) return null;
  const hits = [];
  for (const row of VEHICLE_FITMENT_DATA) {
    const aliases = [...row.aliases, row.model, `${row.brand} ${row.model}`]
      .map(compactVehicleText).filter(alias => alias.length >= 4);
    const matched = aliases.filter(alias => query.includes(alias)).sort((a, b) => b.length - a.length)[0];
    if (matched) hits.push({ row, score: matched.length, matched });
  }
  hits.sort((a, b) => b.score - a.score);
  if (!hits.length) return null;
  // A specific longer name beats a short alias; same-length competing models are ambiguous.
  if (hits.length > 1 && hits[0].score === hits[1].score && hits[0].row.id !== hits[1].row.id) return null;
  return hits[0].row;
}
function rememberVehicleModel(senderId, text) {
  const row = findVehicleCompatibility(text);
  if (!row || !senderId) return row;
  const id = String(senderId);
  if (!db.customers[id]) db.customers[id] = { id, name: `Customer ${id.slice(-4)}`, messageCount: 0 };
  Object.assign(db.customers[id], {
    vehicleModelId: row.id, vehicleModelName: row.model, vehicleBrand: row.brand,
    vehicleModelYears: row.years, vehicleModelUpdatedAt: new Date().toISOString()
  });
  const memory = getCustomerMemory(id);
  addUniqueMemoryItem(memory.facts, `গ্রাহকের যানবাহন: ${row.brand} ${row.model} (${row.years})`);
  memory.updatedAt = new Date().toISOString();
  saveStorage();
  return row;
}
function getKnownVehicleCompatibility(senderId, currentText = '', contextText = '') {
  const currentMatch = findVehicleCompatibility(currentText);
  if (currentMatch) return currentMatch;
  const customer = db.customers[String(senderId || '')] || {};
  if (customer.vehicleModelId) {
    const saved = VEHICLE_FITMENT_DATA.find(row => row.id === Number(customer.vehicleModelId));
    if (saved) return saved;
  }
  return findVehicleCompatibility(contextText);
}
function buildVehicleFitmentReply(row) {
  if (!row) return VEHICLE_FITMENT_HANDOFF_REPLY;
  const socketText = `Socket: ${row.socket}`;
  if (/DC Conversion Required/i.test(row.fitment)) {
    const connection = /Direct Plug-and-Play/i.test(row.fitment) ? 'কনভার্সনের পরে Direct Plug-and-Play; ' : 'Direct Fit; ';
    return `আপনার ${row.brand} ${row.model} (${row.years}, ${row.cc}) সম্পর্কে দেওয়া তালিকা অনুযায়ী ${socketText}। ${connection}তবে হেডলাইট লাগানোর আগে বাইকের AC supply-কে DC-তে convert করতে হবে।`;
  }
  if (/Direct Plug-and-Play/i.test(row.fitment)) return `আপনার ${row.brand} ${row.model} (${row.years}, ${row.cc}) সম্পর্কে দেওয়া তালিকা অনুযায়ী ${socketText} এবং fitment: Direct Plug-and-Play।`;
  return `আপনার ${row.brand} ${row.model} (${row.years}, ${row.cc}) সম্পর্কে দেওয়া তালিকায় ${socketText} এবং fitment: ${row.fitment} উল্লেখ আছে।`;
}

const VEHICLE_FITMENT_HANDOFF_REPLY = 'আমাদের দেওয়া তালিকায় আপনার বাইক/গাড়ির নির্দিষ্ট মডেলটি নিশ্চিতভাবে মেলেনি। সঠিক ফিটমেন্ট নিশ্চিত করতে আমাদের প্রতিনিধি সাহায্য করবে।';
function isVehicleHeadlightFitmentInquiry(currentText='', recentContext='') {
  const current = String(currentText || '').trim();
  const context = `${String(recentContext || '')}\n${current}`;
  const asksFitOrMatch = /(?:fit(?:s|ment)?|ফিট(?:িং)?|compatible|compatibility|will\s+it\s+fit|does\s+it\s+fit|match(?:es|ing)?|ম্যাচ|মিলবে|মিলে\s*কি|মিলবে\s*কি|হবে\s*কি|ফিট\s*হবে|লাগবে\s*কি|সাপোর্ট\s*করবে|support\s*(?:it|my)|কাজ\s*করবে\s*কি)/i.test(current);
  const genericFitmentFollowup = /(?:এটা|এটি|ওটা|ওইটা|এইটা|সেটা|লাইটটা|হেডলাইটটা)\s*(?:(?:কি|কী)\s*)?(?:হবে|লাগবে|ফিট\s*হবে|মিলবে)|(?:ফিট\s*হবে|হবে\s*কি|লাগবে\s*কি|মিলবে\s*কি)/i.test(current)
    && !/(?:দাম|মূল্য|price|কত\s*টাকা|খরচ|বিল|bill|delivery|ডেলিভারি|quantity|পরিমাণ)/i.test(current);
  const mentionsPlugOrSocket = /(?:plug|প্লাগ|socket|সকেট|h\s*-?\s*4|hs\s*-?\s*1|3\s*-?\s*pin|৩\s*পিন|তিন\s*পিন)/i.test(current);
  const asksPlugMatch = mentionsPlugOrSocket && /(?:মিলবে|মিলে|ম্যাচ|match|fit|ফিট|হবে|লাগবে|সাপোর্ট|support|compatible)/i.test(current);
  const vehicleMentioned = /(?:বাইক|মোটরসাইকেল|bike|motorcycle|motorbike|গাড়ি|গাড়ি|কার|car|cng|সিএনজি|বাস|bus|ট্রাক|truck|ভ্যান|van|পিকআপ|pickup|যানবাহন|vehicle|মডেল|model|discover|ডিসকভার|pulsar|পালসার|apache|অ্যাপাচি|yamaha|bajaj|tvs|hero|honda|suzuki|gixxer|splendor|fz\s*\d*|r15|corolla|allion|premio|hiace|civic|alto|wagon\s*r|swift|nissan|toyota|mahindra|tata|mitsubishi)/i.test(context);
  const headlightContext = /(?:হেড\s*লাইট|হেডলাইট|head\s*light|headlight|headlamp|head\s*lamp|বাল্ব|bulb|projector|প্রজেক্টর|plug|প্লাগ|socket|সকেট|h\s*-?\s*4|hs\s*-?\s*1|3\s*-?\s*pin|৩\s*পিন|তিন\s*পিন)/i.test(context);
  const knownModelInContext = Boolean(findVehicleCompatibility(current) || findVehicleCompatibility(context));
  return (vehicleMentioned || knownModelInContext) && (headlightContext || knownModelInContext) && (asksFitOrMatch || asksPlugMatch || genericFitmentFollowup);
}

// -----------------------------------------------------------------------------
// Orders, phone/address collection, automatic contact-detail handover
// -----------------------------------------------------------------------------
function isExplicitOrderIntent(text='') { const t=normalizeText(text); if (/(?:করব|করবো|কিনব|কিনবো|নেব|নিব|নিতে)\s*না|অর্ডার\s*(?:করব|করবো)?\s*না|not\s+(?:buy|order)|don't\s+(?:buy|order)|do not\s+(?:buy|order)/i.test(t)) return false; return /\b(i want to order|place my order|order this|i will buy|i want to buy|confirm my order|i want this|send it to me)\b|অর্ডার করতে চাই|অর্ডার করব|অর্ডার করবো|অর্ডার দিন|পাঠিয়ে দিন|পাঠিয়ে দিন|অর্ডার করে দিন|অর্ডার দিতে চাই|অর্ডার কনফার্ম|কিনতে চাই|কিনব|কিনবো|নিতে চাই|নিব|নেব|এটা নেব|এটি নেব|এটা কিনব|কিনে নেব|কিনে নিব/i.test(t); }
function isYes(text='') { return /^(হ্যাঁ|হ্যা|জি|জ্বি|রাজি|সম্মতি|সম্মতি দিচ্ছি|ঠিক আছে|করুন|দেন|yes|yeah|y|ok|okay|sure|i agree|agree)$/i.test(normalizeText(text)); }
function isNo(text='') { return /^(?:না(?:\s|$)|রাজি নই|সম্মতি নেই|করবেন না|করব না|করবো না|নিবো না|নেব না|কিনব না|কিনবো না|অর্ডার করব না|অর্ডার করবো না|থাক|লাগবে না|দরকার নেই|no(?:\s|$)|no thanks|nope|n|don't|do not|not now)/i.test(normalizeText(text)); }
function extractPhone(text='') { const m=String(text).match(/(?:\+?8801|01)[0-9\s-]{8,14}/); if (!m) return null; const n=m[0].replace(/[\s-]/g,''); return /^\+?8801\d{9}$/.test(n) || /^01\d{9}$/.test(n) ? n : null; }
function extractAddress(text='') {
  const t=String(text||'').trim();
  if (!t || extractPhone(t)) return null;
  // A city name inside a question (e.g. “রাজশাহীতে মোট বিল কত”) is not a delivery address.
  if (/(মোট\s*বিল|বিল\s*কত|ডেলিভারি\s*চার্জ|দাম\s*কত|কত\s*টাকা|কত\s*হবে|price|bill|delivery\s*charge|how\s*much|total\s*cost)/i.test(t)) return null;
  const explicit=t.match(/(?:ঠিকানা|address|বাসা|বাড়ি|বাড়ি|গ্রাম|রোড|road|থানা|উপজেলা|জেলা|এলাকা|এলাকার নাম)\s*[:：-]?\s*(.{5,220})/i);
  if (explicit) return explicit[1].trim().replace(/[।.!?]+$/,'');
  const hasAddressLandmark=/(উপজেলা|থানা|গ্রাম|রোড|road|বাসা|বাড়ি|বাড়ি|ওয়ার্ড|ওয়ার্ড|লেন|lane|মহল্লা|বাজার|বাড়ি নম্বর|বাড়ি নম্বর)/i.test(t);
  const hasMultipleParts=t.split(/[,،]/).map(x=>x.trim()).filter(Boolean).length>=3;
  if (/(ঢাকা|গাজীপুর|চট্টগ্রাম|সিলেট|রাজশাহী|খুলনা|বরিশাল|রংপুর|ময়মনসিংহ|ময়মনসিংহ|কুমিল্লা|নারায়ণগঞ্জ|নারায়ণগঞ্জ)/i.test(t) && t.length >= 12 && (hasAddressLandmark || hasMultipleParts)) return t.slice(0,220);
  return null;
}
function identifyOrderedProduct(senderId, text) {
  const p=findExactProduct(text); if(p) return p;
  const matches=findRelevantProducts(text);
  if(matches.length===1) return matches[0];
  const history=getHistory(senderId);
  for(let i=history.length-1;i>=0;i--) if(history[i].role==='user') { const old=findExactProduct(history[i].text); if(old)return old; }
  const memory=getCustomerMemory(senderId);
  for(const fact of [...(memory?.facts||[])].reverse()){const old=findExactProduct(fact);if(old)return old;}
  return null;
}
function customerHasOrder(senderId) { const id=String(senderId||''); return db.orders.some(o=>String(o.senderId||o.customerId||'')===id && !['CANCELLED','CANCELED','REJECTED'].includes(String(o.status||'').toUpperCase())); }
function cancelFollowup(senderId) { const id=String(senderId||''); const timer=followupTimers.get(id); if(timer)clearTimeout(timer); followupTimers.delete(id); if(db.scheduledFollowups[id]){delete db.scheduledFollowups[id];saveStorage();} }
function getTakeoverState(customerId) {
  if(!customerId)return !!db.isGlobalPaused; const id=String(customerId).trim(); if(db.isGlobalPaused)return true;
  if(db.takeovers[id]&&typeof db.takeovers[id].isPaused==='boolean')return db.takeovers[id].isPaused;
  if(db.customers[id]&&typeof db.customers[id].takeover==='boolean')return db.customers[id].takeover;
  return false;
}
async function setTakeoverState(customerId, enabled, reasonStr) {
  if(!customerId)return false; const id=String(customerId).trim(), on=Boolean(enabled), timestamp=new Date().toISOString();
  db.takeovers[id]={isPaused:on,reason:reasonStr||(on?'Human takeover':'Admin resumed AI'),timestamp};
  if(!db.customers[id])db.customers[id]={id,name:`Customer ${id.slice(-4)}`,messageCount:0};
  Object.assign(db.customers[id],{isPaused:on,takeover:on,takeoverUpdatedAt:timestamp});
  if(on)cancelFollowup(id); saveStorage(); return on;
}
async function sendFacebookMessage(recipientId, text) {
  if(!PAGE_ACCESS_TOKEN){console.error('[Messenger] PAGE_ACCESS_TOKEN missing');return false;}
  const finalText=String(text||'').trim(); if(!finalText||finalText.length>MAX_MESSENGER_TEXT_LENGTH)return false;
  try {
    const url=`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
    const response=await axios.post(url,{recipient:{id:recipientId},message:{text:finalText},messaging_type:'RESPONSE'},{timeout:15000});
    appendHistory(recipientId,'assistant',finalText);
    addStoredMessage({id:'msg_bot_'+crypto.randomUUID(),senderId:recipientId,sender:'bot',text:finalText,timestamp:new Date().toISOString(),messageId:response.data?.message_id||null});
    saveStorage(); return true;
  } catch(err){console.error('[Messenger] Send error:',err.response?.data?.error?.message||err.message);return false;}
}
async function askHandoverConsent(senderId, reason, extraMessage) {
  db.pendingHandover[String(senderId)]={reason:reason||'Customer support request',createdAt:new Date().toISOString(),extraMessage:extraMessage||null};
  saveStorage();
  return sendFacebookMessage(senderId, 'আপনার বিষয়টি আমাদের প্রতিনিধির সাহায্য নিয়ে সমাধান করা ভালো হবে। আমি কি কথোপকথনটি আমাদের প্রতিনিধির কাছে হস্তান্তর করব? সম্মতি দিতে “হ্যাঁ” এবং না চাইলে “না” লিখুন। জরুরি প্রয়োজনে হেল্পলাইন: '+HELPLINE+'। WhatsApp: '+WHATSAPP_NUMBER+'।');
}
async function transferToHuman(senderId, reason, customMessage) {
  // This function is used only after consent or explicit admin action.
  await setTakeoverState(senderId,true,reason||'Customer consented to human handover');
  delete db.pendingHandover[String(senderId)]; saveStorage();
  return sendFacebookMessage(senderId,customMessage||`আপনার সম্মতির জন্য ধন্যবাদ। কথোপকথনটি আমাদের প্রতিনিধির কাছে হস্তান্তর করা হয়েছে। হেল্পলাইন: ${HELPLINE}। WhatsApp: ${WHATSAPP_NUMBER}।`);
}
function createMessengerOrder(senderId, draft, messageId) {
  const id=String(senderId||'').trim(); if(!id)throw new Error('Customer sender ID is required');
  if(messageId){const existing=db.orders.find(o=>o.sourceMessageId===messageId);if(existing)return {order:existing,created:false};}
  const customer=db.customers[id]||{}, product=draft.product;
  const quantity=Math.max(1,Number(draft.quantity)||1), unitPrice=Number(product?.price), hasPrice=product?.price!==undefined&&product?.price!==null&&String(product.price).trim()!==''&&Number.isFinite(unitPrice)&&unitPrice>=0, subtotal=hasPrice?unitPrice*quantity:null, deliveryFee=getDeliveryFee(draft.address||customer.address||''), total=subtotal!==null&&deliveryFee!==null?subtotal+deliveryFee:null;
  const order={id:'order_'+crypto.randomUUID(),senderId:id,customerId:id,customerName:customer.name||`Customer ${id.slice(-4)}`,customerPhone:draft.phone||customer.phone||null,customerAddress:draft.address||customer.address||null,productId:product?.id||null,productName:product?.name||null,productPrice:product?.price??null,quantity,subtotal,deliveryFee,total,billingCurrency:'BDT',customerMessage:draft.customerMessage||'',source:'MESSENGER',sourceMessageId:messageId||null,status:'PENDING_CONFIRMATION',humanTakeover:true,createdAt:new Date().toISOString()};
  db.orders.push(order); if(!db.customers[id])db.customers[id]={id,name:order.customerName,messageCount:0};
  db.customers[id].lastOrderId=order.id;db.customers[id].lastOrderAt=order.createdAt;db.customers[id].phone=order.customerPhone;db.customers[id].address=order.customerAddress;cancelFollowup(id);saveStorage();return {order,created:true};
}
async function handleOrderFlow(senderId, text, messageId) {
  const id = String(senderId), customer = db.customers[id] || {}, old = db.orderDrafts[id] || {};
  const draft = { ...old, customerMessage: [old.customerMessage, text].filter(Boolean).join('\n').slice(-1000) };
  const product = identifyOrderedProduct(id, text); if (product) draft.product = product;
  const phone = extractPhone(text); if (phone) { draft.phone = phone; customer.phone = phone; }
  const address = extractAddress(text); if (address) { draft.address = address; customer.address = address; }
  db.customers[id] = customer;
  if (!draft.product) {
    db.orderDrafts[id] = draft; saveStorage();
    if (draft.lastAskedField !== 'product') { draft.lastAskedField = 'product'; saveStorage(); await sendFacebookMessage(id, 'আপনি কোন পণ্যটি অর্ডার করতে চান? পণ্যের সঠিক নাম বা মডেলটি লিখুন।'); }
    else await sendFacebookMessage(id, 'পণ্যের নাম/মডেল জানালে অর্ডারটি এগিয়ে নিতে পারব। চাইলে অর্ডার না করেও পণ্য সম্পর্কে প্রশ্ন করতে পারেন।');
    return true;
  }
  if (!draft.phone) {
    db.orderDrafts[id] = draft; saveStorage();
    if (draft.lastAskedField !== 'phone') { draft.lastAskedField = 'phone'; saveStorage(); await sendFacebookMessage(id, `${draft.product.name} অর্ডারের জন্য আপনার সচল মোবাইল নম্বরটি দিন।`); }
    else await sendFacebookMessage(id, 'অর্ডার চালিয়ে যেতে চাইলে আপনার সচল মোবাইল নম্বরটি পাঠাতে পারেন।');
    return true;
  }
  if (!draft.address) {
    db.orderDrafts[id] = draft; saveStorage();
    if (draft.lastAskedField !== 'address') { draft.lastAskedField = 'address'; saveStorage(); await sendFacebookMessage(id, 'ডেলিভারির সম্পূর্ণ ঠিকানা লিখুন—এলাকা/গ্রাম, থানা/উপজেলা ও জেলা সহ।'); }
    else await sendFacebookMessage(id, 'অর্ডার চালিয়ে যেতে চাইলে ডেলিভারির সম্পূর্ণ ঠিকানা পাঠাতে পারেন।');
    return true;
  }
  draft.messageId = messageId || draft.messageId || null;
  const created = createMessengerOrder(id, draft, draft.messageId);
  delete db.orderDrafts[id]; delete db.pendingHandover[id]; saveStorage();
  await setTakeoverState(id, true, `Order automatically handed to human ${created.order.id}`);
  const billLines = created.order.total !== null ? `\nবিল: ${created.order.productName} × ${created.order.quantity} = ${created.order.subtotal} টাকা; ডেলিভারি ${created.order.deliveryFee} টাকা; সর্বমোট ${created.order.total} টাকা।` : '\nচূড়ান্ত বিল প্রতিনিধি পণ্যের মূল্য ও ডেলিভারি চার্জ যাচাই করে জানাবেন।';
  await sendFacebookMessage(id, `আপনার ${draft.product.name} অর্ডারের তথ্য প্রতিনিধি টিমের কাছে পাঠানো হয়েছে।${billLines}\nপণ্য, ফোন ও ঠিকানা প্রতিনিধি যাচাই করে আপনার সঙ্গে যোগাযোগ করবেন। ${HELPLINE}`);
  return true;
}

// -----------------------------------------------------------------------------
// Follow-up scheduler
// -----------------------------------------------------------------------------
function scheduleFollowup(senderId,lastAt=Date.now()) {
  const id=String(senderId||'');if(!id)return;cancelFollowup(id);if(getTakeoverState(id)||customerHasOrder(id))return;
  const at=new Date(lastAt).getTime();if(!Number.isFinite(at))return;
  db.scheduledFollowups[id]={senderId:id,dueAt:at+FOLLOWUP_DELAY_MS,lastCustomerMessageAt:at,lastMessageId:db.customers[id]?.lastMessageId||null,status:'PENDING'};saveStorage();armFollowupTimer(id);
}
function armFollowupTimer(senderId) {
  const id=String(senderId),task=db.scheduledFollowups[id];if(!task||task.status!=='PENDING')return;
  const old=followupTimers.get(id);if(old)clearTimeout(old);
  const timer=setTimeout(()=>{followupTimers.delete(id);executeFollowup(id).catch(e=>console.error('[FOLLOWUP]',e.message));},Math.min(Math.max(0,Number(task.dueAt)-Date.now()),2147483647));
  if(timer.unref)timer.unref();followupTimers.set(id,timer);
}
async function executeFollowup(senderId) {
  const id=String(senderId),task=db.scheduledFollowups[id];if(!task||task.status!=='PENDING')return;
  const c=db.customers[id];if(!c||getTakeoverState(id)||customerHasOrder(id)){delete db.scheduledFollowups[id];saveStorage();return;}
  if(Date.now()<Number(task.dueAt)){armFollowupTimer(id);return;}
  const last=new Date(c.lastCustomerMessageAt||c.lastActive||0).getTime();
  if(!last||Date.now()-last>=24*60*60*1000){delete db.scheduledFollowups[id];saveStorage();return;}
  if(last>Number(task.lastCustomerMessageAt||0)){scheduleFollowup(id,last);return;}
  const sent=await sendFacebookMessage(id,FOLLOWUP_MESSAGE);task.status=sent?'SENT':'FAILED';task.sentAt=new Date().toISOString();saveStorage();
}
function restoreFollowupTasks(){for(const [id,t] of Object.entries(db.scheduledFollowups)){if(!t||t.status!=='PENDING')continue;if(getTakeoverState(id)||customerHasOrder(id)){delete db.scheduledFollowups[id];continue;}armFollowupTimer(id);}saveStorage();}

// -----------------------------------------------------------------------------
// GitHub catalog sync
// -----------------------------------------------------------------------------
function replaceCatalogAtomically(data,source='admin') {
  const current = { version: catalogMeta.version, updatedAt: catalogMeta.updatedAt, products, faqs };
  const normalized = mergeCatalogData(current, data);
  saveLocalCatalog(normalized, source);
  return normalized;
}
async function pullCatalogFromGitHub() {
  if(!GITHUB_TOKEN){catalogMeta.lastSyncError='GITHUB_TOKEN is not configured';return false;}
  try {
    const url=`https://api.github.com/repos/${GITHUB_REPO}/contents/${CATALOG_FILE}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
    const r=await axios.get(url,{headers:{Authorization:`Bearer ${GITHUB_TOKEN}`,Accept:'application/vnd.github+json','User-Agent':'Impotech-Admin-Server'},timeout:15000});
    if(!r.data?.content)throw new Error('GitHub response contains no file content');
    const parsed=JSON.parse(Buffer.from(r.data.content,'base64').toString('utf8')); parsed.replaceAll = true; replaceCatalogAtomically(parsed,'github');return true;
  }catch(err){catalogMeta.lastSyncError=err.response?.data?.message||err.message;console.error('[GITHUB] Pull failed:',catalogMeta.lastSyncError);return false;}
}
async function pushCatalogToGitHub(data,customToken,customRepo,customBranch,customPath) {
  const token=customToken||GITHUB_TOKEN,repo=customRepo||GITHUB_REPO,branch=customBranch||GITHUB_BRANCH,filePath=customPath||CATALOG_FILE;
  if(!token)return {synced:false,message:'GitHub Token is not configured'};
  let safeData;
  try { safeData = mergeCatalogData({ version: catalogMeta.version, updatedAt: catalogMeta.updatedAt, products, faqs }, data); validateCatalogShape(safeData); }
  catch(e) { return {synced:false,error:e.message}; }
  const url=`https://api.github.com/repos/${repo}/contents/${filePath}`,headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','User-Agent':'Impotech-Admin-Server'};let sha=null;
  try{const r=await axios.get(`${url}?ref=${encodeURIComponent(branch)}`,{headers,timeout:10000});sha=r.data?.sha||null;}catch(e){if(e.response?.status!==404)return {synced:false,error:e.response?.data?.message||e.message};}
  const payload={message:`Update Impotech catalog ${safeData.version||Date.now()}`,content:Buffer.from(JSON.stringify(safeData,null,2),'utf8').toString('base64'),branch};if(sha)payload.sha=sha;
  try{const r=await axios.put(url,payload,{headers,timeout:20000});replaceCatalogAtomically(safeData,'github');return {synced:true,commit:r.data?.commit?.sha||'synced',totalProducts:products.length,totalFaqs:faqs.length};}catch(e){return {synced:false,error:e.response?.data?.message||e.message};}
}

// -----------------------------------------------------------------------------
// AI prompt and OpenRouter
// -----------------------------------------------------------------------------
function limitToFiveLines(text) { const lines=String(text||'').replace(/\r/g,'').split('\n').map(x=>x.trim()).filter(Boolean);return lines.slice(0,MAX_AI_LINES).join('\n'); }
function buildSystemPrompt(relevantProducts, relevantFaqs, history, memoryContext) {
  const productContext = relevantProducts.length
    ? relevantProducts.map((p, i) => [
        `[পণ্য ${i + 1}]`, `ID: ${p.id || 'N/A'}`, `নাম: ${p.name || 'N/A'}`,
        `ব্র্যান্ড: ${p.brand || 'N/A'}`, `মডেল: ${p.model || 'N/A'}`,
        `মূল্য: ${p.price ?? 'ক্যাটালগে নেই'} টাকা`,
        `স্টক: ${p.stockStatus || (p.inStock === true ? 'IN_STOCK' : 'তথ্য নেই')}`,
        `বিবরণ: ${p.shortDescription || p.description || 'N/A'}`,
        `বৈশিষ্ট্য: ${Array.isArray(p.features) ? p.features.join(', ') : 'N/A'}`,
        `ছবি: ${getProductMediaUrls(p, 'images').join(' | ') || 'নেই'}`,
        `ভিডিও: ${getProductMediaUrls(p, 'videos').join(' | ') || 'নেই'}`
      ].join('\n')).join('\n\n')
    : 'কোনো প্রাসঙ্গিক পণ্য পাওয়া যায়নি।';
  const faqContext = relevantFaqs.length
    ? relevantFaqs.map((f, i) => `[FAQ ${i + 1}] ${f.question || f.q || ''}\n${f.answer || ''}`).join('\n\n')
    : 'প্রাসঙ্গিক FAQ পাওয়া যায়নি।';
  const historyContext = history.length
    ? history.map(x => `${x.role === 'assistant' ? 'বট/প্রতিনিধি' : 'গ্রাহক'}: ${x.text}`).join('\n')
    : 'পূর্ববর্তী কথোপকথন নেই।';
  return `আপনি ImpoTech BD ফেসবুক পেজের অত্যন্ত পেশাদার, স্মার্ট ও সাহায্যকারী কাস্টমার সাপোর্ট এজেন্ট।
হেল্পলাইন: ${HELPLINE}; WhatsApp: ${WHATSAPP_NUMBER}; ঠিকানা: ভাওয়াল গড়, ভবানীপুর, জয়দেবপুর, গাজীপুর।
ডেলিভারি চার্জ: গাজীপুরের ভেতরে ৫০ টাকা, গাজীপুরের বাইরে ১০০ টাকা।

কঠোর কনভার্সেশনাল নিয়ম:
১) প্রশ্ন বনাম অর্ডার: গ্রাহক স্পষ্টভাবে অর্ডার করার ইচ্ছা না জানানো পর্যন্ত কখনো ফোন নম্বর, ডেলিভারি ঠিকানা বা ব্যক্তিগত তথ্য চাইবে না। পণ্যের বিবরণ, দাম, স্টক, ছবি/ভিডিও, বাইকের মডেল, ফিটমেন্ট বা ডেলিভারি চার্জের প্রশ্নের সরাসরি উত্তর দেবে। শুধু “দাম কত”, “ফিট হবে?”, “ছবি দিন” বা “ডেলিভারি চার্জ কত” বললে অর্ডার শুরু করবে না।
২) অর্ডার শুরু: কেবল “অর্ডার করতে চাই”, “পাঠিয়ে দিন”, “কিনব/নেব” বা সমার্থক স্পষ্ট সম্মতির পর ব্যাকএন্ডের অর্ডার প্রক্রিয়া চলবে। অর্ডার চলাকালে আগের কথোপকথন ও draft-এ থাকা পণ্য, ফোন এবং ঠিকানা ব্যবহার করবে; ইতিমধ্যে পাওয়া তথ্য আবার চাইবে না।
৩) Anti-loop: একই প্রশ্ন/মেসেজ পরপর পুনরাবৃত্তি করবে না। গ্রাহক “না”, “করব না”, “করবো না”, “নেব না”, “নিবো না”, “লাগবে না” বা অর্ডার প্রত্যাখ্যান করলে ঠিকানা/ফোন চাওয়া বন্ধ করবে। সংক্ষেপে বলবে: “ঠিক আছে, কোনো সমস্যা নেই। অন্য কোনো তথ্য জানার থাকলে বলবেন, সাহায্য করতে পেরে আনন্দিত হব।” অর্ডার বাতিল হলে অর্ডার ড্রাফটও বাতিল করবে।
৪) ক্যাটালগ-ভিত্তিক তথ্য: পণ্যের নাম, দাম, স্টক, বৈশিষ্ট্য, ওয়ারেন্টি বা স্পেসিফিকেশন বানিয়ে বলবে না। catalog.json ও FAQ-ই পণ্যের তথ্যের মূল উৎস। ক্যাটালগে থাকা ছবি, Facebook Reel বা ভিডিওর সঠিক URL হুবহু দেবে; URL বানাবে বা বদলাবে না। তথ্য না থাকলে স্পষ্টভাবে বলবে যে ক্যাটালগে তথ্যটি নেই।
৫) হেডলাইট/বাইক/গাড়ি ফিটমেন্ট: প্রথমে কোডে থাকা VEHICLE_FITMENT_DATA তালিকায় গ্রাহকের উল্লেখ করা সঠিক মডেল মিলিয়ে দেখবে। মিল পাওয়া গেলে শুধু সেই রেকর্ডের years/socket/fitment এবং DC Conversion Required তথ্য অনুযায়ী উত্তর দেবে; AC-to-DC conversion প্রয়োজন থাকলে স্পষ্ট বলবে। মডেল তালিকায় না থাকলে অনুমান করবে না; উত্তর হবে: “${VEHICLE_FITMENT_HANDOFF_REPLY}”。
৬) মেমোরি ও প্রসঙ্গ: পূর্ববর্তী কথোপকথন, customer memory, সক্রিয় পণ্য ও বর্তমান অর্ডার ড্রাফট ব্যবহার করবে। সর্বশেষ স্পষ্টভাবে নাম বলা পণ্যই Active Product। গ্রাহক সেই পণ্যের দাম জিজ্ঞেস করার পর “লাইটের আলো কেমন”, “ছবি/ভিডিও/অডিও দেন”, “বিস্তারিত বলুন”, “ডেলিভারি/ওয়ারেন্টি” ইত্যাদি বললে একই পণ্য বোঝাবে; অন্য পণ্যের তথ্য, ছবি বা ভিডিও দেবে না। শুধু গ্রাহক স্পষ্টভাবে নতুন পণ্যের নাম/ক্যাটাগরি বললে Active Product পরিবর্তন করবে। সাধারণ “লাইট” শব্দ দিয়ে Headlight থেকে Fog Light বা অন্য পণ্যে কখনো বদলাবে না। বর্তমান Active Product-এর তথ্য না থাকলে সেটি স্পষ্ট বলবে, বিকল্প পণ্য ধরে উত্তর দেবে না।
৭) মানব প্রতিনিধি: সাধারণ প্রশ্নের উত্তর নিজে দেবে। অন্য সমস্যা সমাধান করা সম্ভব না হলে সম্মতি চাইবে; সম্মতি ছাড়া সাধারণ প্রশ্নে takeover চালু করবে না। ${HANDOVER_MARKER} নিজে থেকে লিখবে না।
৮) ভাষা ও দৈর্ঘ্য: গ্রাহক যে ভাষায় লিখবে—বাংলা, English বা Banglish—সেই ভাষায় স্বাভাবিক, সরাসরি ও সংক্ষিপ্ত উত্তর দেবে। সর্বোচ্চ ৪–৫টি ছোট লাইন; অপ্রয়োজনীয় ভূমিকা বা একই কথা পুনরাবৃত্তি নয়।

গ্রাহক মেমোরি:
${memoryContext}

প্রাসঙ্গিক পণ্য:
${productContext}

FAQ:
${faqContext}

কথোপকথন:
${historyContext}`;
}
async function callOpenRouter(messages,model=TEXT_MODEL) {
  if(!OPENROUTER_API_KEY)throw new Error('OPENROUTER_API_KEY is not configured');
  console.log('[OpenRouter] Request started', { model, messageCount: messages.length });
  try {
    const r=await axios.post(OPENROUTER_URL,{model,messages,max_tokens:MAX_OUTPUT_TOKENS,temperature:0.2},{headers:{Authorization:`Bearer ${OPENROUTER_API_KEY}`,'Content-Type':'application/json','HTTP-Referer':'https://github.com/impotechaibot/Impotech-bot','X-Title':'ImpoTech Messenger AI Bot'},timeout:30000,maxContentLength:MAX_ATTACHMENT_BYTES,maxBodyLength:MAX_ATTACHMENT_BYTES});
    const choice=r.data?.choices?.[0];if(!choice)throw new Error('OpenRouter returned no response');let reply=choice.message?.content;if(Array.isArray(reply))reply=reply.map(x=>x?.text||'').join('');reply=String(reply||'').trim();if(!reply||choice.finish_reason==='length')throw new Error('AI response empty or truncated');
    console.log('[OpenRouter] Response received', { model, replyLength: reply.length });
    return reply;
  } catch (e) {
    console.error('[OpenRouter] Request failed', {
      status: e.response?.status ?? null,
      code: e.response?.data?.error?.code ?? e.response?.data?.code ?? e.code ?? null,
      message: e.response?.data?.error?.message ?? e.response?.data?.message ?? e.message,
      model
    });
    throw e;
  }
}
async function generateAIResponse(customerText,attachments=[],senderId) {
  const query=customerText||'ছবিটি বা পাঠানো ফাইলটি দেখে সাহায্য করুন';let history=getHistory(senderId).slice();
  if(history.length&&history[history.length-1].role==='user'&&history[history.length-1].text===query)history.pop();
  const context=getRecentConversationText(senderId,query), memory=buildCustomerMemoryContext(senderId);
  const explicitProduct = findExactProduct(query);
  if (explicitProduct) rememberActiveProduct(senderId, explicitProduct);
  const requestedCategory = getExplicitProductCategoryIntent(query);
  let activeProduct = explicitProduct || findActiveProduct(senderId);
  let relevantProducts;
  if (requestedCategory && hasClearCategorySwitch(query, senderId)) {
    const categoryChoices = getProductsByExplicitCategory(requestedCategory);
    relevantProducts = categoryChoices.length ? categoryChoices.slice(0, MAX_PRODUCTS_TO_AI) : (activeProduct ? [activeProduct] : findRelevantProducts(context));
    if (categoryChoices.length === 1) { activeProduct = categoryChoices[0]; rememberActiveProduct(senderId, activeProduct); }
  } else {
    // Generic follow-ups such as "light photo/video please" retain the active model.
    relevantProducts = activeProduct ? [activeProduct] : findRelevantProducts(context);
  }
  const relevantFaqs=findRelevantFaqs(context);
  const system=buildSystemPrompt(relevantProducts,relevantFaqs,history,memory);
  const prior=history.map(x=>({role:x.role==='assistant'?'assistant':'user',content:x.text}));
  const audio=attachments.find(x=>x.type==='audio'&&x.payload?.url);
  if(audio){
    try {
      const r=await axios.get(audio.payload.url,{responseType:'arraybuffer',timeout:20000,maxContentLength:MAX_ATTACHMENT_BYTES});
      const contentType=String(r.headers['content-type']||'').toLowerCase();
      const urlPath=String(audio.payload.url).split('?')[0].toLowerCase();
      let audioFormat='mp3';
      if(/ogg|opus/.test(contentType)||/\.(ogg|opus)$/.test(urlPath)) audioFormat='ogg';
      else if(/wav/.test(contentType)||/\.wav$/.test(urlPath)) audioFormat='wav';
      else if(/mp4|m4a|aac/.test(contentType)||/\.(m4a|mp4|aac)$/.test(urlPath)) audioFormat='mp4';
      else if(/mpeg|mp3/.test(contentType)||/\.mp3$/.test(urlPath)) audioFormat='mp3';
      const base64=Buffer.from(r.data).toString('base64');
      return limitToFiveLines(await callOpenRouter([{role:'system',content:system},...prior,{role:'user',content:[
        {type:'text',text:'এটি গ্রাহকের পাঠানো ভয়েস মেসেজ। আগে কথাগুলো যথাসম্ভব সঠিকভাবে বুঝে/ট্রান্সক্রাইব করুন, তারপর গ্রাহকের উদ্দেশ্য অনুযায়ী সরাসরি উত্তর দিন। বাংলা, English ও Banglish উচ্চারণ/শব্দ বিবেচনা করুন। শোনা যায়নি এমন তথ্য অনুমান করবেন না। সর্বোচ্চ ৫টি ছোট লাইন।'},
        {type:'input_audio',input_audio:{data:base64,format:audioFormat}}
      ]}],VOICE_MODEL));
    } catch(e) { console.error('[VOICE] Failed:',e.response?.data?.error?.message||e.message); }
  }
  const images = attachments.filter(x => x.type === 'image' && x.payload?.url).slice(0, 4);
  if (images.length) {
    try {
      const imageParts = [];
      for (let i = 0; i < images.length; i++) {
        const image = images[i];
        try {
          const r = await axios.get(image.payload.url, { responseType: 'arraybuffer', timeout: 18000, maxContentLength: MAX_ATTACHMENT_BYTES });
          const contentType = String(r.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
          if (!contentType.startsWith('image/')) { console.warn('[VISION] Attachment is not an image', { index: i, contentType }); continue; }
          const base64 = Buffer.from(r.data).toString('base64');
          imageParts.push({ type: 'text', text: `গ্রাহকের ছবি ${i + 1}:` });
          imageParts.push({ type: 'image_url', image_url: { url: `data:${contentType};base64,${base64}` } });
        } catch (imageError) { console.error('[VISION] Failed to fetch image', { index: i, message: imageError.response?.status || imageError.message }); }
      }
      if (imageParts.some(part => part.type === 'image_url')) {
        const visionPrompt = `${query || 'এই ছবিগুলো দেখে পণ্য শনাক্ত করুন'}
একই মেসেজে একাধিক ছবি থাকলে সবগুলো মিলিয়ে বিশ্লেষণ করুন। ছবিতে দৃশ্যমান পণ্যের নাম, মডেল নম্বর, ব্র্যান্ড, প্যাকেটের লেখা এবং বৈশিষ্ট্য পড়ার চেষ্টা করুন। শনাক্তকৃত পণ্য ক্যাটালগের তথ্যের সঙ্গে মিলিয়ে দেখুন; প্রমাণ ছাড়া পণ্যের নাম বা দাম নিশ্চিত করবেন না। কাস্টমারকে ইতিমধ্যে দেওয়া তথ্য অকারণে আবার জিজ্ঞেস করবেন না। যানবাহনে হেডলাইট ফিটমেন্ট বা প্লাগ-ম্যাচিং নিজে নিশ্চিত করবেন না; এ বিষয়ে নির্দিষ্ট মানব-প্রতিনিধির বার্তাই ব্যবহার করুন। সংক্ষিপ্ত ও সরাসরি উত্তর দিন।`;
        const response = await callOpenRouter([{ role: 'system', content: system }, ...prior, { role: 'user', content: [{ type: 'text', text: visionPrompt }, ...imageParts] }]);
        return limitToFiveLines(response);
      }
      console.warn('[VISION] No image attachments could be fetched; falling back to text-only');
    } catch (e) { console.error('[VISION] Failed:', e.response?.data?.error?.message || e.message); }
  }
  return limitToFiveLines(await callOpenRouter([{role:'system',content:system},...prior,{role:'user',content:query}]));
}
function isCriticalHandoverQuestion(text='') { return /প্রতারণা|fraud|scam|আইনগত ব্যবস্থা|legal action|মামলা|মারাত্মক দুর্ঘটনা|serious injury|আগুন লেগেছে|fire hazard|ব্যাটারি বিস্ফোরণ|battery exploded|চার্জে আগুন|payment deducted twice|দুইবার টাকা কাটা|ভুল পেমেন্ট|টাকা কেটে নিয়েছে/i.test(text); }
function isConfusionReply(text='') { return /^(হ্যাঁ|হ্যা|জি|জ্বি|রাজি|সম্মতি|ঠিক আছে|yes|yeah|y|ok|okay|sure|না|no|nope|n)$/i.test(normalizeText(text)); }

// -----------------------------------------------------------------------------
// Main message flow
// -----------------------------------------------------------------------------
async function processCustomerMessage(senderId,text,attachments=[],messageId=null) {
  const id=String(senderId), customerText=String(text||'').trim();
  if(getTakeoverState(id)){console.log(`[Takeover] ${id} paused; AI skipped`);return;}
  try {
    const incomingUrls = extractUrls(customerText);
    const linkedProducts = [...new Map(incomingUrls.map(url => catalogProductForUrl(url)).filter(Boolean).map(product => [String(product.id), product])).values()];
    if (linkedProducts.length === 1) rememberActiveProduct(id, linkedProducts[0]);
    // FAQ intent normally has top priority and is returned verbatim with no extra model question.
    // However, a clearly named new category (Fog Light / Angel Wings) must not receive an
    // unrelated generic Headlight price FAQ.
    const explicitCategory = getExplicitProductCategoryIntent(customerText);
    const categorySwitch = hasClearCategorySwitch(customerText, id);
    // A clearly named category is a topic change. Persist it when it maps to one product;
    // generic words such as "light", "photo", "video" never change the active product.
    if (explicitCategory && categorySwitch) {
      const categoryMatches = getProductsByExplicitCategory(explicitCategory);
      if (categoryMatches.length === 1) rememberActiveProduct(id, categoryMatches[0]);
    }
    const shouldResolveCategoryInsteadOfGenericFaq = categorySwitch || explicitCategory === 'foglight' || explicitCategory === 'angelwings';
    const matchedFaq = shouldResolveCategoryInsteadOfGenericFaq ? null : findBestFaqMatch(customerText);
    if (matchedFaq) {
      const faqAnswer = String(matchedFaq.answer || '').trim();
      if (faqAnswer) {
        console.log(`[FAQ] Direct FAQ match for ${id}; category=${matchedFaq.category || 'unspecified'}`);
        await sendFacebookMessage(id, faqAnswer);
        return;
      }
    }
    const hasFacebookLink = incomingUrls.some(url => /(^|\.)facebook\.com\//i.test(url) || /(^|\.)fb\.watch\//i.test(url));
    if (hasFacebookLink && !linkedProducts.length && !attachments.some(x => x.type === 'image' && x.payload?.url)) {
      await sendFacebookMessage(id, 'লিংকটি থেকে পণ্যটি নিশ্চিতভাবে শনাক্ত করতে পারিনি। অনুগ্রহ করে পণ্যের একটি স্ক্রিনশট বা সঠিক নাম/মডেল পাঠান।');
      return;
    }
    // Deterministic fitment answer from the customer-provided motorcycle/car reference table.
    // If their model is not listed, never guess: send the representative-contact fallback.
    const fitmentContext = [getRecentConversationText(id, customerText), db.customers[id]?.vehicleModelName || '', db.customers[id]?.activeProductName || ''].filter(Boolean).join('\n');
    if (isVehicleHeadlightFitmentInquiry(customerText, fitmentContext)) {
      const vehicle = getKnownVehicleCompatibility(id, customerText, fitmentContext);
      await sendFacebookMessage(id, buildVehicleFitmentReply(vehicle));
      return;
    }
    // Delivery-charge questions are informational, not order intent; never request address/phone for them.
    if (/(?:ডেলিভারি|কুরিয়ার|কুরিয়ার)\s*(?:চার্জ|খরচ)|delivery\s*charge|courier\s*(?:fee|charge)/i.test(customerText) && !/(?:সর্বমোট|মোট বিল|grand total|total bill|invoice)/i.test(customerText)) {
      const place = normalizeText(customerText);
      if (/গাজীপুরের\s*(?:ভেতরে|মধ্যে|ভিতরে)|inside\s*gazipur|within\s*gazipur/i.test(place)) await sendFacebookMessage(id, 'গাজীপুরের ভেতরে ডেলিভারি চার্জ ৫০ টাকা।');
      else if (/গাজীপুরের\s*(?:বাইরে)|outside\s*gazipur|outside\s*of\s*gazipur/i.test(place)) await sendFacebookMessage(id, 'গাজীপুরের বাইরে ডেলিভারি চার্জ ১০০ টাকা।');
      else await sendFacebookMessage(id, 'ডেলিভারি চার্জ গাজীপুরের ভেতরে ৫০ টাকা এবং গাজীপুরের বাইরে ১০০ টাকা।');
      return;
    }
    // A billing question must still be answered while an order draft or handover prompt is pending.
    if (isBillingQuestion(customerText)) {
      const context=getRecentConversationText(id,customerText);
      const p=findExactProduct(customerText)||findExactProduct(context)||findProductFromRecentContext(id);
      if (p) {
        const quantity=extractQuantity(customerText)||extractQuantity(context)||Number(db.orderDrafts[id]?.quantity)||1;
        const address=extractAddress(customerText)||db.orderDrafts[id]?.address||db.customers[id]?.address||extractAddress(context)||'';
        const deliveryFee=getDeliveryFee(address);
        await sendFacebookMessage(id,limitToFiveLines(buildSmartBillReply(p,quantity,deliveryFee)));
        return;
      }
    }
    // Pending handover only consumes a clear yes/no. A new substantive question cancels the prompt and is handled normally.
    if(db.pendingHandover[id] && !db.pendingHandover[id].orderDraft) {
      if(isYes(customerText)){await transferToHuman(id,db.pendingHandover[id].reason);return;}
      if(isNo(customerText)){delete db.pendingHandover[id];saveStorage();await sendFacebookMessage(id,'ঠিক আছে, আপাতত AI সহায়তা চালু থাকছে। কীভাবে সাহায্য করতে পারি?');return;}
      delete db.pendingHandover[id]; saveStorage();
      console.log(`[Handover] Cleared stale consent prompt for ${id}; processing new message normally`);
    }
    // Explicit refusal during an order draft cancels it and stops all detail requests.
    if (db.orderDrafts[id] && isNo(customerText)) {
      delete db.orderDrafts[id]; delete db.pendingHandover[id]; saveStorage();
      await sendFacebookMessage(id, 'ঠিক আছে, কোনো সমস্যা নেই। অন্য কোনো তথ্য জানার থাকলে বলবেন, সাহায্য করতে পেরে আনন্দিত হব।');
      return;
    }
    // Order draft in progress. A yes is consent to save/transfer only after all details are gathered.
    if(db.orderDrafts[id]) {
      const draft=db.orderDrafts[id];
      if(db.pendingHandover[id]?.orderDraft) {
        if(isYes(customerText)) {
          const created=createMessengerOrder(id,draft,draft.messageId||messageId);
          delete db.orderDrafts[id];delete db.pendingHandover[id];saveStorage();
          await setTakeoverState(id,true,`Customer consented to order handover ${created.order.id}`);
          await sendFacebookMessage(id,ORDER_CONFIRMATION);return;
        }
        if(isNo(customerText)){delete db.orderDrafts[id];delete db.pendingHandover[id];saveStorage();await sendFacebookMessage(id,'ঠিক আছে, অর্ডারটি জমা দেওয়া হয়নি এবং আপনার তথ্য প্রতিনিধির কাছে পাঠানো হবে না। চাইলে পরে আবার অর্ডার করতে পারবেন।');return;}
        // If the customer is sending corrected details rather than consent, update and show confirmation again.
        const phone=extractPhone(customerText);if(phone)draft.phone=phone;
        const address=extractAddress(customerText);if(address)draft.address=address;
        const p=identifyOrderedProduct(id,customerText);if(p)draft.product=p;
        db.orderDrafts[id]=draft;saveStorage();
        await sendFacebookMessage(id,'অর্ডার জমা ও প্রতিনিধির কাছে হস্তান্তরের জন্য “হ্যাঁ”, বাতিল করতে “না” লিখুন।');return;
      }
      await handleOrderFlow(id,customerText,messageId);return;
    }
    if(isExplicitOrderIntent(customerText)){await handleOrderFlow(id,customerText,messageId);return;}
    if(isCriticalHandoverQuestion(customerText)){await askHandoverConsent(id,'Critical customer issue');return;}
    if(isBillingQuestion(customerText)) {
      const context=getRecentConversationText(id,customerText);
      const p=findExactProduct(customerText)||findExactProduct(context)||findProductFromRecentContext(id);
      if(!p){await sendFacebookMessage(id,'স্মার্ট বিল তৈরি করতে পণ্যের নাম/মডেল, কতটি নেবেন এবং ডেলিভারি এলাকা/জেলা লিখুন।');return;}
      const quantity=extractQuantity(customerText)||extractQuantity(context)||1;
      const address=extractAddress(customerText)||extractAddress(context)||db.customers[id]?.address||'';
      const deliveryFee=getDeliveryFee(address);
      await sendFacebookMessage(id,limitToFiveLines(buildSmartBillReply(p,quantity,deliveryFee)));return;
    }
    if(isPriceQuestion(customerText)) {
      const explicit = findExactProduct(customerText);
      const category = getExplicitProductCategoryIntent(customerText);
      let p = explicit;
      if (!p && category && (category === 'foglight' || category === 'angelwings' || hasClearCategorySwitch(customerText, id))) {
        const candidates = getProductsByExplicitCategory(category);
        if (candidates.length === 1) p = candidates[0];
        else if (candidates.length > 1) {
          const priceLines = candidates.slice(0, 3).map(item => getPriceReply(item) || `${item.name}-এর দাম ক্যাটালগে উল্লেখ নেই।`);
          await sendFacebookMessage(id, priceLines.join('\n'));
          return;
        }
      }
      if (!p && (isGenericPriceQuestion(customerText) || !category)) p = findProductFromRecentContext(id);
      if(!p){await sendFacebookMessage(id,'এই ক্যাটাগরির নির্দিষ্ট পণ্য শনাক্ত করতে পারিনি। ক্যাটালগে একাধিক মডেল থাকলে পণ্যের ছবি বা মডেল পাঠান।');return;}
      if (explicit || (category && getProductCategoryKey(p) === category)) rememberActiveProduct(id, p);
      const reply=getPriceReply(p);await sendFacebookMessage(id,reply||`দুঃখিত, ${p.name}-এর দাম বর্তমানে ক্যাটালগে উল্লেখ নেই।`);return;
    }
    if(getMediaType(customerText)){const reply=getProductMediaReply(customerText,id);if(reply){await sendFacebookMessage(id,limitToFiveLines(reply));return;}}
    let reply=await generateAIResponse(customerText,attachments,id);
    if(!reply)throw new Error('AI returned empty response');
    if(reply.includes(HANDOVER_MARKER)) { const clean=reply.replaceAll(HANDOVER_MARKER,'').trim(); await askHandoverConsent(id,'AI requested human assistance',clean);return; }
    if(/আমার প্রশ্নটা বুঝতে সমস্যা|বুঝতে সমস্যা হচ্ছে|প্রশ্নটি বুঝতে পারিনি|দুঃখিত.*বুঝতে পারছি না/i.test(reply)) {
      await sendFacebookMessage(id,'আমার প্রশ্নটা বুঝতে সমস্যা হচ্ছে, আমি কি আমাদের প্রতিনিধির কাছে প্রশ্নটা হস্তান্তর করবো? “হ্যাঁ” বা “না” লিখুন.');
      db.pendingHandover[id]={reason:'AI could not understand customer question',createdAt:new Date().toISOString()};saveStorage();return;
    }
    const previous=getPreviousAssistantReply(id,customerText);
    if(previous&&normalizeText(previous)===normalizeText(reply))reply='আগের উত্তরে বিষয়টি জানিয়েছি। কোন অংশটি আরও পরিষ্কার করতে হবে বলুন, আমি সাহায্য করছি।';
    if(!getTakeoverState(id))await sendFacebookMessage(id,limitToFiveLines(reply));
  } catch(err) {
    console.error('[AI] Response error:',err.message);if(getTakeoverState(id))return;
    await sendFacebookMessage(id,'আমার প্রশ্নটা বুঝতে সমস্যা হচ্ছে, আমি কি আমাদের প্রতিনিধির কাছে প্রশ্নটা হস্তান্তর করবো? “হ্যাঁ” বা “না” লিখুন। সিদ্ধান্ত নিতে সমস্যা হলে সরাসরি কল করুন: '+HELPLINE+'। WhatsApp: '+WHATSAPP_NUMBER+'।'); db.pendingHandover[id]={reason:'AI failed to answer; awaiting customer consent',createdAt:new Date().toISOString()}; saveStorage();
  }
}

// -----------------------------------------------------------------------------
// Facebook webhook
// -----------------------------------------------------------------------------
app.get('/webhook',(req,res)=>{const mode=req.query['hub.mode'],token=req.query['hub.verify_token'],challenge=req.query['hub.challenge'];if(mode==='subscribe'&&VERIFY_TOKEN&&token===VERIFY_TOKEN)return res.status(200).send(challenge);return res.sendStatus(403);});
app.post('/webhook',async(req,res)=>{
  const incomingEntries = Array.isArray(req.body?.entry) ? req.body.entry : [];
  let incomingEvents = 0;
  let incomingEchoes = 0;
  for (const entry of incomingEntries) {
    const events = Array.isArray(entry.messaging) ? entry.messaging : [];
    incomingEvents += events.length;
    incomingEchoes += events.filter(event => event.message?.is_echo === true).length;
  }
  console.log('[Webhook] POST received', {
    object: req.body?.object ?? null,
    entryCount: incomingEntries.length,
    messagingEvents: incomingEvents,
    echoEvents: incomingEchoes,
    time: new Date().toISOString()
  });
  res.status(200).send('EVENT_RECEIVED');
  try {
    if(req.body?.object!=='page')return;
    for(const entry of req.body.entry||[])for(const event of entry.messaging||[]) {
      const senderId=event.sender?.id,message=event.message,messageId=message?.mid;
      // Meta Click-to-Messenger attribution can arrive on the first message, postback, or referral event.
      // Preserve the first known paid-ad attribution; later messages without referral must not erase it.
      if (senderId) {
        const referral = message?.referral || event.referral || event.postback?.referral || event.referral?.referral || null;
        const adContext = referral?.ads_context_data || {};
        const adId = referral?.ad_id || adContext?.ad_id || null;
        const refCode = referral?.ref || null;
        if (referral && (adId || refCode || adContext?.ad_title || adContext?.photo_url)) {
          const id = String(senderId), previous = db.campaignAttribution[id] || {};
          const attribution = {
            senderId: id,
            source: referral.source || previous.source || 'UNKNOWN',
            type: referral.type || previous.type || null,
            adId: adId ? String(adId) : (previous.adId || null),
            ref: refCode || previous.ref || null,
            adTitle: adContext.ad_title || previous.adTitle || null,
            photoUrl: adContext.photo_url || previous.photoUrl || null,
            firstCapturedAt: previous.firstCapturedAt || new Date().toISOString(),
            lastCapturedAt: new Date().toISOString(),
            campaignName: previous.campaignName || null,
            attributionStatus: adId ? 'AD_ID_CAPTURED' : 'REFERRAL_CAPTURED'
          };
          db.campaignAttribution[id] = attribution;
          if (db.customers[id]) db.customers[id].campaignAttribution = attribution;
          saveStorage();
          console.log(`[Attribution] Messenger referral captured for ${id}; adId=${attribution.adId || 'unknown'}`);
        }
      }
      // Admin/page message echoes can control takeover for the customer thread.
      if (message?.is_echo && message?.text && event.recipient?.id) {
        const echoCommand = normalizeText(message.text).replace(/\s+/g, '');
        const targetCustomerId = String(event.recipient.id);
        if (['.human','.stop','.pause'].includes(echoCommand)) {
          await setTakeoverState(targetCustomerId, true, `Admin chat command ${echoCommand}`);
          console.log(`[Takeover] Admin enabled human takeover for ${targetCustomerId} via ${echoCommand}`);
        } else if (['.ai','.resume'].includes(echoCommand)) {
          delete db.pendingHandover[targetCustomerId];
          await setTakeoverState(targetCustomerId, false, `Admin chat command ${echoCommand}`);
          console.log(`[Takeover] Admin resumed AI for ${targetCustomerId} via ${echoCommand}`);
        }
        continue;
      }
      if(event.call && senderId) {
        await setTakeoverState(senderId,true,'Incoming Messenger call event');
        await sendFacebookMessage(senderId,`আপনার কলের অনুরোধের জন্য Human takeover চালু করা হয়েছে। দ্রুত সহায়তার জন্য সরাসরি কল করুন: ${HELPLINE}`);
        continue;
      }
      if(event.postback && senderId) {
        const payload=String(event.postback.payload||'').trim();
        const command=payload.toUpperCase();
        if(command==='HANDOVER_YES') { await transferToHuman(senderId,'Customer consented via postback'); continue; }
        if(command==='HANDOVER_NO') { delete db.pendingHandover[String(senderId)];saveStorage();await sendFacebookMessage(senderId,'ঠিক আছে, AI সহায়তা চালু থাকছে।'); continue; }
        const buttonText=String(event.postback.title||event.postback.payload||'').trim();
        if(buttonText) {
          const task=(customerQueues.get(senderId)||Promise.resolve()).catch(()=>{}).then(async()=>{
            appendHistory(senderId,'user',buttonText);
            addStoredMessage({id:'msg_'+crypto.randomUUID(),senderId,sender:'customer',text:buttonText,timestamp:new Date().toISOString(),messageId:null});
            if(!db.customers[senderId])db.customers[senderId]={id:senderId,name:`Customer ${String(senderId).slice(-4)}`,messageCount:1,lastActive:new Date().toISOString(),lastCustomerMessageAt:new Date().toISOString(),lastMessageText:buttonText};
            else {const c=db.customers[senderId];c.messageCount=(c.messageCount||0)+1;c.lastActive=new Date().toISOString();c.lastCustomerMessageAt=c.lastActive;c.lastMessageText=buttonText;}
            saveStorage();
            if(!getTakeoverState(senderId)) await processCustomerMessage(senderId,buttonText,[],null);
          });
          customerQueues.set(senderId,task); task.finally(()=>{if(customerQueues.get(senderId)===task)customerQueues.delete(senderId);}).catch(e=>console.error('[Webhook] Postback task failed:',e.message));
        }
        continue;
      }
      if(!message||message.is_echo||!senderId)continue;
      if(messageId&&processedMessageIds.has(messageId))continue;
      if(messageId)processedMessageIds.set(messageId,Date.now());
      const text=String(message.text||message.quick_reply?.payload||'').trim(),attachments=message.attachments||[];
      const previous=customerQueues.get(senderId)||Promise.resolve();
      const task=previous.catch(()=>{}).then(async()=>{
        if(messageId&&db.messages.some(m=>m.messageId===messageId))return;
        // Small deliberate reply delay so the bot does not answer instantly.
        await sleep(CUSTOMER_REPLY_DELAY_MS);
        const now=new Date().toISOString(),paused=getTakeoverState(senderId);
        appendHistory(senderId,'user',text||'[Media File]');
        addStoredMessage({id:'msg_'+crypto.randomUUID(),senderId,sender:'customer',text:text||`[Media: ${attachments[0]?.type||'file'}]`,timestamp:now,messageId:messageId||null});
        if(!db.customers[senderId])db.customers[senderId]={id:senderId,name:`Customer ${senderId.slice(-4)}`,messageCount:1,lastActive:now,lastCustomerMessageAt:now,lastMessageId:messageId||null,isPaused:paused,takeover:paused,lastMessageText:text||'[Media]'};
        else {const c=db.customers[senderId];c.messageCount=(c.messageCount||0)+1;c.lastActive=now;c.lastCustomerMessageAt=now;c.lastMessageId=messageId||null;c.lastMessageText=text||'[Media]';}
        if(text)updateCustomerMemory(senderId,text);
        // One-time introduction; persisted so it is not repeated on every message.
        const customerRecord = db.customers[senderId] || {};
        const command = normalizeText(text).replace(/\s+/g, '');
        if (!customerRecord.introSent && !['.human','.stop','.pause','.ai','.resume'].includes(command)) {
          customerRecord.introSent = true; db.customers[senderId] = customerRecord; saveStorage();
          await sendFacebookMessage(senderId, FIRST_CONTACT_INTRO);
        }
        if (['.human','.stop','.pause'].includes(command)) {
          await setTakeoverState(senderId, true, `Chat command ${command}`);
          await sendFacebookMessage(senderId, 'Human takeover চালু হয়েছে। এখন প্রতিনিধি কথোপকথন পরিচালনা করবেন। AI আবার চালু করতে অ্যাডমিন চ্যাট থেকে .ai লিখুন।');
          return;
        }
        if (['.ai','.resume'].includes(command)) {
          await sendFacebookMessage(senderId, getTakeoverState(senderId) ? 'এই কথোপকথনে Human takeover চালু আছে। AI চালু করতে আমাদের প্রতিনিধি অ্যাডমিন চ্যাট থেকে .ai কমান্ড দেবেন।' : 'AI চ্যাটবট চালু আছে। কীভাবে সাহায্য করতে পারি?');
          return;
        }
        // Accumulate phone/address and hand over when contact details are shared.
        const c=db.customers[senderId]||{}; const phone=extractPhone(text); const address=extractAddress(text);
        if(phone)c.phone=phone; if(address)c.address=address; db.customers[senderId]=c;
        const completeAddress=String(c.address||'').trim().length>=10;
        if(phone || address) { const mem=getCustomerMemory(senderId); if(phone)addUniqueMemoryItem(mem.facts,`ফোন: ${phone}`); if(address)addUniqueMemoryItem(mem.facts,`ঠিকানা: ${address}`); mem.updatedAt=new Date().toISOString(); c.lastMemoryUpdatedAt=mem.updatedAt; }
        // User requirement: either a detected phone number or a usable address triggers human takeover.
        // Do not ask the AI to continue handling personal contact details after they arrive.
        if((phone || (address && completeAddress)) && !getTakeoverState(senderId)) {
          saveStorage();
          await setTakeoverState(senderId,true,phone ? 'Customer provided phone number' : 'Customer provided address');
          await sendFacebookMessage(senderId,`আপনার ${phone ? 'ফোন নম্বর' : 'ঠিকানা'} পেয়েছি। Human takeover চালু করে বিষয়টি আমাদের প্রতিনিধি টিমের কাছে হস্তান্তর করা হয়েছে। প্রয়োজনে কল করুন: ${HELPLINE}`);
          return;
        }
        if(!paused&&!customerHasOrder(senderId))scheduleFollowup(senderId,Date.now());else cancelFollowup(senderId);
        saveStorage();if(paused)return;
        if(event.call || /(?:আমি\s*কল করছি|কল করতে চাই|আপনাদের কল করছি|call me|calling you|i want to call|call your number|ফোন করছি)/i.test(text)) { await setTakeoverState(senderId,true,'Customer initiated/asked for a call'); await sendFacebookMessage(senderId,`আপনার জন্য Human takeover চালু করা হয়েছে। দ্রুত সহায়তার জন্য সরাসরি কল করুন: ${HELPLINE}`); return; }
        if(normalizeText(text)==='প্রতিনিধি'||normalizeText(text)==='human'||normalizeText(text)==='agent'){await askHandoverConsent(senderId,'Customer requested representative');return;}
        await processCustomerMessage(senderId,text,attachments,messageId||null);
      });
      customerQueues.set(senderId,task);task.finally(()=>{if(customerQueues.get(senderId)===task)customerQueues.delete(senderId);}).catch(e=>console.error('[Webhook] Customer task failed:',e.message));
    }
  }catch(err){console.error('[Webhook] Processing error:',err.message);}
});

// -----------------------------------------------------------------------------
// Catalog Admin APIs
// -----------------------------------------------------------------------------
app.get('/api/catalog',(req,res)=>{const catalog=loadLocalCatalog();res.json({success:true,catalog,products:catalog.products||[],faqs:catalog.faqs||[],meta:catalogMeta});});
app.post('/api/catalog/sync',async(req,res)=>{try{const data=req.body;validateCatalogShape(data);const merged=replaceCatalogAtomically(data,'admin');let gh={synced:false};if(GITHUB_TOKEN)gh=await pushCatalogToGitHub(merged);res.json({success:true,message:`Catalog applied to the live bot immediately: ${products.length} products, ${faqs.length} FAQs. GitHub sync: ${gh.synced?'successful':(gh.error||gh.message||'not configured')}.`,totalProducts:products.length,totalFaqs:faqs.length,githubSynced:gh.synced,githubError:gh.error||gh.message||null,meta:catalogMeta});}catch(e){res.status(400).json({success:false,message:e.message});}});
app.post('/api/github/upload',async(req,res)=>{try{const {catalog:payload,githubRepo,githubBranch,githubToken,githubFilePath}=req.body;const result=await pushCatalogToGitHub(payload||loadLocalCatalog(),githubToken||GITHUB_TOKEN,githubRepo||GITHUB_REPO,githubBranch||GITHUB_BRANCH,githubFilePath||CATALOG_FILE);if(!result.synced)return res.status(400).json({success:false,message:result.error||result.message});res.json({success:true,message:`Catalog uploaded to ${githubRepo||GITHUB_REPO}@${githubBranch||GITHUB_BRANCH}`,totalProducts:result.totalProducts,totalFaqs:result.totalFaqs,commit:result.commit});}catch(e){res.status(400).json({success:false,message:e.message});}});
app.post('/api/catalog/refresh',async(req,res)=>{const synced=await pullCatalogFromGitHub();res.status(synced?200:503).json({success:synced,totalProducts:products.length,totalFaqs:faqs.length,meta:catalogMeta});});

// -----------------------------------------------------------------------------
// Status, takeover and customer APIs
// -----------------------------------------------------------------------------
app.get('/api/bot-status',(req,res)=>res.json({success:true,isGlobalPaused:!!db.isGlobalPaused,reason:db.isGlobalPaused?'Global human takeover active':'AI bot active',totalPausedCustomers:Object.values(db.takeovers).filter(x=>x&&x.isPaused).length}));
app.post('/api/toggle-bot',(req,res)=>{db.isGlobalPaused=!!req.body.isPaused;if(db.isGlobalPaused)for(const id of Object.keys(db.scheduledFollowups))cancelFollowup(id);saveStorage();res.json({success:true,isGlobalPaused:db.isGlobalPaused});});
app.post('/api/customers/:senderId/takeover',async(req,res)=>{const {senderId}=req.params;const on=req.body.isPaused!==undefined?!!req.body.isPaused:req.body.takeover!==undefined?!!req.body.takeover:true;await setTakeoverState(senderId,on,req.body.reason);res.json({success:true,senderId,isPaused:on,takeover:on,message:on?'Human takeover enabled. AI remains paused until admin resumes it.':'AI resumed for this customer.'});});
app.get('/api/customers/:senderId/status',(req,res)=>{const id=String(req.params.senderId),on=getTakeoverState(id);res.json({success:true,senderId:id,isPaused:on,takeover:on,reason:db.takeovers[id]?.reason||null,updatedAt:db.takeovers[id]?.timestamp||null});});
app.post('/api/customers/:senderId/takeover/enable',async(req,res)=>{await setTakeoverState(req.params.senderId,true,req.body?.reason||'Enabled from admin chat');res.json({success:true,senderId:req.params.senderId,takeover:true,isPaused:true});});
app.post('/api/customers/:senderId/takeover/disable',async(req,res)=>{await setTakeoverState(req.params.senderId,false,req.body?.reason||'Disabled from admin chat');res.json({success:true,senderId:req.params.senderId,takeover:false,isPaused:false});});
app.get('/api/customers',(req,res)=>{const list=Object.values(db.customers).map(c=>({senderId:c.id,displayName:c.name||`Customer ${String(c.id).slice(-4)}`,phone:c.phone||null,address:c.address||null,lastMessageText:c.lastMessageText||null,lastMessageAt:c.lastActive||null,messageCount:c.messageCount||0,lastOrderId:c.lastOrderId||null,lastOrderAt:c.lastOrderAt||null,takeover:getTakeoverState(c.id),isPaused:getTakeoverState(c.id),takeoverReason:db.takeovers[c.id]?.reason||null,takeoverUpdatedAt:db.takeovers[c.id]?.timestamp||null,memoryUpdatedAt:c.lastMemoryUpdatedAt||null}));res.json({success:true,total:list.length,data:list});});
app.get('/api/campaign-attribution', (req,res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const rows = Object.values(db.campaignAttribution || {}).map(a => {
    const c = db.customers[String(a.senderId)] || {};
    return { ...a, displayName: c.name || `Customer ${String(a.senderId).slice(-4)}`, lastMessageText: c.lastMessageText || null, lastActive: c.lastActive || null, messageCount: c.messageCount || 0, takeover: getTakeoverState(a.senderId) };
  }).sort((a,b) => new Date(b.lastCapturedAt || b.firstCapturedAt || 0) - new Date(a.lastCapturedAt || a.firstCapturedAt || 0)).slice(0,limit);
  res.json({success:true,total:Object.keys(db.campaignAttribution || {}).length,data:rows, note:'Meta webhook referral data may not include campaign name; adId can be mapped to campaign via Meta Marketing API if permissions are configured.'});
});
app.get('/api/campaign-attribution/:senderId', (req,res) => {
  const id = String(req.params.senderId), attribution = (db.campaignAttribution || {})[id];
  if (!attribution) return res.status(404).json({success:false,message:'No campaign referral data captured for this customer'});
  res.json({success:true,attribution,customer:db.customers[id] || null});
});
app.get('/api/customers/:senderId/memory',(req,res)=>res.json({success:true,senderId:String(req.params.senderId),memory:db.customerMemory[String(req.params.senderId)]||null}));
app.put('/api/customers/:senderId/memory',(req,res)=>{const id=String(req.params.senderId),body=req.body||{},m=getCustomerMemory(id);if(Array.isArray(body.facts))m.facts=body.facts.filter(x=>typeof x==='string').map(x=>x.trim()).filter(Boolean).slice(-30);if(Array.isArray(body.preferences))m.preferences=body.preferences.filter(x=>typeof x==='string').map(x=>x.trim()).filter(Boolean).slice(-20);if(typeof body.summary==='string')m.summary=body.summary.slice(0,3000);m.updatedAt=new Date().toISOString();saveStorage();res.json({success:true,senderId:id,memory:m});});
app.get('/api/messages',(req,res)=>{const id=req.query.senderId?String(req.query.senderId):null,limit=Math.min(Math.max(Number(req.query.limit)||100,1),1000);let list=db.messages;if(id)list=list.filter(m=>String(m.senderId)===id);res.json({success:true,total:list.length,data:list.slice(-limit)});});
app.get('/api/orders',(req,res)=>{const status=req.query.status?String(req.query.status):null,id=req.query.senderId?String(req.query.senderId):null;let list=db.orders;if(status)list=list.filter(o=>String(o.status)===status);if(id)list=list.filter(o=>String(o.senderId||o.customerId)===id);res.json({success:true,total:list.length,data:list.slice().reverse()});});
app.post('/api/orders',(req,res)=>{const o=req.body||{},id=String(o.senderId||o.customerId||'').trim();if(!id)return res.status(400).json({success:false,message:'senderId or customerId is required'});if(o.sourceMessageId){const old=db.orders.find(x=>x.sourceMessageId===o.sourceMessageId);if(old)return res.json({success:true,duplicate:true,order:old});}const order={...o,senderId:id,customerId:id,id:o.id||'order_'+crypto.randomUUID(),status:o.status||'PENDING',createdAt:o.createdAt||new Date().toISOString()};db.orders.push(order);saveStorage();cancelFollowup(id);res.status(201).json({success:true,order});});
app.get('/api/orders/:orderId',(req,res)=>{const o=db.orders.find(x=>String(x.id)===String(req.params.orderId));if(!o)return res.status(404).json({success:false,message:'Order not found'});res.json({success:true,order:o});});
app.put('/api/orders/:orderId',(req,res)=>{const i=db.orders.findIndex(x=>String(x.id)===String(req.params.orderId));if(i<0)return res.status(404).json({success:false,message:'Order not found'});const old=db.orders[i];db.orders[i]={...old,...req.body,id:old.id,updatedAt:new Date().toISOString()};saveStorage();if(customerHasOrder(old.senderId||old.customerId))cancelFollowup(old.senderId||old.customerId);res.json({success:true,order:db.orders[i]});});
app.delete('/api/orders/:orderId',(req,res)=>{const i=db.orders.findIndex(x=>String(x.id)===String(req.params.orderId));if(i<0)return res.status(404).json({success:false,message:'Order not found'});const o=db.orders.splice(i,1)[0];saveStorage();res.json({success:true,deleted:o.id});});
app.post('/api/customers/:senderId/send',async(req,res)=>{const text=String(req.body?.text||'').trim();if(!text)return res.status(400).json({success:false,message:'Text required'});const sent=await sendFacebookMessage(req.params.senderId,text);if(!sent)return res.status(500).json({success:false,message:'Message sending failed'});res.json({success:true,message:'Message sent'});});

app.get('/admin/campaign-tracking', (req,res) => {
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ImpoTech Campaign Leads</title><style>
  body{font:14px system-ui,Arial;margin:0;background:#f4f6fa;color:#172033}.wrap{max-width:1100px;margin:auto;padding:20px}h1{font-size:22px}.top{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.muted{color:#64748b}.pill{background:#e0f2fe;padding:4px 8px;border-radius:12px}.card{background:white;border-radius:12px;padding:14px;margin:12px 0;box-shadow:0 2px 12px #0f172a0d}.row{display:grid;grid-template-columns:1.2fr 1fr 1fr 1.5fr;gap:12px;align-items:start;border-top:1px solid #e5e7eb;padding:12px 0}.row:first-child{border-top:0}button{padding:9px 12px;border:0;border-radius:8px;background:#1d4ed8;color:white;cursor:pointer}.alert{position:fixed;right:20px;bottom:20px;background:#111827;color:white;padding:16px 18px;border-radius:12px;max-width:340px;box-shadow:0 8px 32px #0003;display:none}.alert button{background:#374151;margin-left:8px}@media(max-width:700px){.row{grid-template-columns:1fr 1fr}.wrap{padding:12px}}
  </style></head><body><div class="wrap"><div class="top"><div><h1>ImpoTech Ad Campaign Leads</h1><div class="muted">Facebook Messenger referral attribution • auto-refresh every 15 seconds</div></div><div style="margin-left:auto"><button id="refresh">Refresh now</button> <button id="key">Set admin key</button></div></div><div class="card"><b id="total">Loading leads…</b><p class="muted">Campaign name is shown only when Meta supplies it or you map the captured Ad ID. Missing attribution is never guessed.</p><div id="rows"></div></div></div><div id="popup" class="alert"><b>New ad lead captured</b><div id="popupText" style="margin-top:8px"></div><div style="margin-top:12px;text-align:right"><button id="dismiss">Dismiss</button></div></div><script>
  let known=new Set(),firstLoad=true;const keyName='impotech_campaign_admin_secret';
  function getKey(){return sessionStorage.getItem(keyName)||''}function setKey(){const k=prompt('Enter ADMIN_SECRET (sent only to your protected API):');if(k!==null){sessionStorage.setItem(keyName,k);load()}}
  async function load(){try{let r=await fetch('/api/campaign-attribution?limit=200',{headers:{'x-admin-secret':getKey()}});if(r.status===401||r.status===503){document.getElementById('total').textContent='Admin authentication required. Click “Set admin key”.';return}if(!r.ok)throw Error('HTTP '+r.status);let j=await r.json();document.getElementById('total').textContent=String(j.total)+' attributed Messenger lead(s)';document.getElementById('rows').innerHTML=j.data.map(a=>{let id=String(a.senderId);let name=esc(a.displayName||('Customer '+id.slice(-4)));let campaign=esc(a.campaignName||'Campaign name unavailable');let ad=esc(a.adTitle||'Ad title unavailable');let adid=esc(a.adId||'Ad ID unavailable');let status=esc(a.attributionStatus||'REFERRAL_CAPTURED');if(!firstLoad&&!known.has(id)){document.getElementById('popupText').textContent=name+' • '+campaign+' • '+adid;document.getElementById('popup').style.display='block'}known.add(id);return '<div class="row"><div><b>'+name+'</b><div class="muted">PSID: '+esc(id)+'</div><div class="muted">'+esc(a.firstCapturedAt||'')+'</div></div><div><span class="pill">'+status+'</span><div>'+campaign+'</div><div class="muted">'+ad+'</div></div><div><b>Ad ID</b><div>'+adid+'</div><div class="muted">Source: '+esc(a.source||'unknown')+' / '+esc(a.type||'unknown')+'</div></div><div>'+esc(a.lastMessageText||'No message text')+'<div class="muted">Messages: '+(Number(a.messageCount)||0)+'</div></div></div>'}).join('')||'<p class="muted">No Messenger ad referrals captured yet.</p>';firstLoad=false}catch(e){document.getElementById('total').textContent='Could not load leads: '+e.message}}
  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  document.getElementById('refresh').onclick=load;document.getElementById('key').onclick=setKey;document.getElementById('dismiss').onclick=()=>document.getElementById('popup').style.display='none';if(!getKey())setTimeout(setKey,100);load();setInterval(load,15000);
</script></body></html>`);
});

// -----------------------------------------------------------------------------
// Health and diagnostics
// -----------------------------------------------------------------------------
app.get('/health',(req,res)=>res.status(200).json({success:true,status:'ok',storage:pool?'postgresql':'memory-only'}));
app.get('/api/health',(req,res)=>res.status(200).json({success:true,status:'LIVE_PRODUCTION',storage:pool?'postgresql':'memory-only',isGlobalPaused:!!db.isGlobalPaused}));
app.get('/api/status',(req,res)=>res.json({success:true,status:'LIVE_PRODUCTION',storage:pool?'postgresql':'memory-only',catalogProducts:products.length,catalogFaqs:faqs.length,catalogFile:CATALOG_FILE,githubRepo:GITHUB_REPO,githubBranch:GITHUB_BRANCH,catalogMeta,globalBotPaused:!!db.isGlobalPaused,helpline:HELPLINE,whatsapp:WHATSAPP_NUMBER,aiModel:TEXT_MODEL,vehicleFitmentEntries:VEHICLE_FITMENT_DATA.length,historyLimit:HISTORY_LIMIT,memoryRetentionDays:MEMORY_RETENTION_DAYS,replyDelayMs:CUSTOMER_REPLY_DELAY_MS,catalogAutoRefreshMs:CATALOG_AUTO_REFRESH_MS,customers:Object.keys(db.customers).length,messages:db.messages.length,orders:db.orders.length,customerMemories:Object.keys(db.customerMemory).length,pendingFollowups:Object.values(db.scheduledFollowups).filter(x=>x&&x.status==='PENDING').length,timestamp:new Date().toISOString()}));
app.get('/api/catalog/media-status',(req,res)=>res.json({success:true,products:products.map(p=>({id:p.id,name:p.name,images:getProductMediaUrls(p,'images').length,videos:getProductMediaUrls(p,'videos').length}))}));

// -----------------------------------------------------------------------------
// Start and periodic tasks
// -----------------------------------------------------------------------------
async function startServer() {
  await initDatabase();
  loadLocalCatalog();
  await pullCatalogFromGitHub();
  restoreFollowupTasks();
  app.listen(PORT,'0.0.0.0',()=>{
    console.log(`[SERVER] ImpoTech Master Bot running on port ${PORT}`);
    console.log(`[STORAGE] ${pool?'PostgreSQL configured':'WARNING: in-memory fallback only'}`);
    console.log(`[CATALOG] ${products.length} products, ${faqs.length} FAQs; source=${catalogMeta.source}`);
    console.log(`[CONTACT] Helpline ${HELPLINE}; WhatsApp ${WHATSAPP_NUMBER}`);
    if(!ADMIN_SECRET&&REQUIRE_ADMIN_SECRET)console.error('[SECURITY] ADMIN_SECRET missing; admin API will reject requests.');
    if(!PAGE_ACCESS_TOKEN)console.warn('[CONFIG] PAGE_ACCESS_TOKEN missing');
    if(!VERIFY_TOKEN)console.warn('[CONFIG] VERIFY_TOKEN missing');
    if(!OPENROUTER_API_KEY)console.warn('[CONFIG] OPENROUTER_API_KEY missing');
  });
}
startServer().catch(err=>{console.error('[SERVER] Startup error:',err.message);process.exit(1);});
setInterval(()=>{const cutoff=Date.now()-DUPLICATE_WINDOW_MS;for(const [id,t] of processedMessageIds)if(t<cutoff)processedMessageIds.delete(id);},60000).unref();
setInterval(()=>{for(const [id,task] of Object.entries(db.scheduledFollowups)){if(!task||task.status!=='PENDING')continue;if(getTakeoverState(id)||customerHasOrder(id)){cancelFollowup(id);continue;}if(!followupTimers.has(id))armFollowupTimer(id);}pruneOldMemory();saveStorage();},FOLLOWUP_CHECK_INTERVAL_MS).unref();
// Keep the runtime catalog fresh after admin/GitHub edits; GitHub catalog is authoritative.
setInterval(()=>{pullCatalogFromGitHub().catch(err=>{catalogMeta.lastSyncError=err.message;console.error('[CATALOG] Auto-refresh failed:',err.message);});},CATALOG_AUTO_REFRESH_MS).unref();
process.on('SIGTERM',async()=>{try{await persistChain;if(pool)await pool.end();}finally{process.exit(0);}});
process.on('SIGINT',async()=>{try{await persistChain;if(pool)await pool.end();}finally{process.exit(0);}});
