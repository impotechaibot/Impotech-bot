'use strict';

/**
 * ImpoTech AI Messenger Bot & Admin Backend
 * AI: OpenRouter Gemini 3.1 Flash-Lite
 * Storage: PostgreSQL (DATABASE_URL / POSTGRES_URL)
 * Catalog: GitHub catalog.json + local cache
 * Search: Exa Search API (EXA_API_KEY)
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
const EXA_API_KEY = process.env.EXA_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'impotechaibot/Impotech-bot';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const CATALOG_FILE = process.env.CATALOG_FILE || 'data/catalog.json';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v4';
const REQUIRE_ADMIN_SECRET = process.env.REQUIRE_ADMIN_SECRET !== 'false';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const EXA_URL = 'https://api.exa.ai/search';
const TEXT_MODEL = 'google/gemini-3.1-flash-lite';
const VOICE_MODEL = TEXT_MODEL;
const HELPLINE = process.env.HELPLINE || '+8809611042598';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '01884332067';
const MAX_PRODUCTS_TO_AI = 2;
const MAX_FAQS_TO_AI = 3;
const MAX_OUTPUT_TOKENS = 150;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_MESSENGER_TEXT_LENGTH = 2000;
const MAX_AI_LINES = 4;
const HISTORY_LIMIT = 20;
const MESSAGE_RETENTION_LIMIT = 20000;
const MEMORY_RETENTION_DAYS = 20;
const MEMORY_RETENTION_MS = MEMORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const FOLLOWUP_DELAY_MS = 23 * 60 * 60 * 1000;
const FOLLOWUP_CHECK_INTERVAL_MS = 60 * 1000;
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
  const matches = products.map(product => ({ product, score: productScore(text, product) })).filter(x => x.score > 0).sort((a,b) => b.score-a.score);
  if (matches.length && (matches.length === 1 || matches[0].score > matches[1].score)) {
    addUniqueMemoryItem(memory.facts, `আলোচিত পণ্য: ${matches[0].product.name} (ID: ${matches[0].product.id})`);
    // A clearly identified new product replaces the previous topic; generic follow-ups do not.
    customer.activeProductId = matches[0].product.id;
    customer.activeProductName = matches[0].product.name || null;
  }
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
    if (!p || typeof p !== 'object') throw new Error('Every product must be an object');
    const id = String(p.id ?? '').trim();
    if (!id) throw new Error('Every product must have an ID');
    if (ids.has(id)) throw new Error('Duplicate product ID: ' + id);
    ids.add(id);
  }
  if (data.faqs !== undefined && !Array.isArray(data.faqs)) throw new Error('Catalog FAQs must be an array');
  return true;
}
function applyCatalog(data, source = 'local') {
  validateCatalogShape(data); products = data.products; faqs = Array.isArray(data.faqs) ? data.faqs : [];
  catalogMeta = { version: data.version ?? null, updatedAt: data.updatedAt ?? null, source, lastSyncAt: new Date().toISOString(), lastSyncError: null };
}
function loadLocalCatalog() {
  try {
    if (!fs.existsSync(LOCAL_CATALOG_PATH)) return { products, faqs, version: catalogMeta.version, updatedAt: catalogMeta.updatedAt };
    const data = JSON.parse(fs.readFileSync(LOCAL_CATALOG_PATH, 'utf8')); applyCatalog(data, 'local'); return data;
  } catch (err) { console.error('[CATALOG] Local load error:', err.message); return { products, faqs, version: catalogMeta.version, updatedAt: catalogMeta.updatedAt }; }
}
function saveLocalCatalog(data, source = 'local') {
  validateCatalogShape(data); const temp = LOCAL_CATALOG_PATH + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8'); fs.renameSync(temp, LOCAL_CATALOG_PATH); applyCatalog(data, source);
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
function getProductIdentifiers(p) { return [p.name,p.id,p.sku,p.model,...(Array.isArray(p.aliases)?p.aliases:[])].filter(Boolean).map(normalizeText).filter(Boolean); }
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
function getMediaType(text='') { const v=normalizeText(text); if (/ভিডিও|video|রিল|reel|clip/.test(v)) return 'videos'; if (/ছবি|ফটো|পিকচার|ইমেজ|image|photo|picture/.test(v)) return 'images'; return null; }
function getProductMediaReply(text, senderId) {
  const type = getMediaType(text); if (!type) return null;
  const p = findExactProduct(text) || findRelevantProducts(text)[0] || findProductFromRecentContext(senderId);
  if (!p) return 'আপনি কোন পণ্যের ছবি বা ভিডিও দেখতে চান? পণ্যের নাম বা মডেলটি বলুন।';
  const urls = getProductMediaUrls(p, type); if (!urls.length) return `${p.name}-এর ${type==='images'?'ছবি':'ভিডিও'} লিংক বর্তমান ক্যাটালগে পাওয়া যাচ্ছে না।`;
  return `${p.name}-এর ${type==='images'?'ছবি':'ভিডিও'} লিংক:\n${urls.map((u,i)=>`${i+1}. ${u}`).join('\n')}`;
}

// -----------------------------------------------------------------------------
// Motorcycle compatibility: do not infer unverified model/year fitment.
// -----------------------------------------------------------------------------
const BUILTIN_BIKE_DATABASE = [
  // Motorcycle model index: names are searchable; socket fitment remains variant/year-specific unless sourced.
  {brand:'Yamaha',model:'FZ',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['fz','fz-s','fzs','fz v2','fz v3','yamaha fz']},
  {brand:'Yamaha',model:'FZ25',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['fz25','fz 25']},
  {brand:'Yamaha',model:'R15',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['r15','r15 v2','r15 v3','r15 v4','r15m']},
  {brand:'Yamaha',model:'Fazer',vehicleType:'motorcycle',fitment:'some year variants listed with H4; verify exact variant',aliases:['fazer','yamaha fazer','fazer fz']},
  {brand:'Yamaha',model:'MT-07',vehicleType:'motorcycle',fitment:'H4 listed for certain model years; verify exact variant',aliases:['mt07','mt 07','yamaha mt-07']},
  {brand:'Yamaha',model:'XT600',vehicleType:'motorcycle',fitment:'H4 listed for certain model years; verify exact variant',aliases:['xt600','xt 600','yamaha xt600']},
  {brand:'Bajaj',model:'Discover 125',vehicleType:'motorcycle',fitment:'variant-dependent; HS1 used on some variants, do not assume direct H4',aliases:['discover 125','discover125','bajaj discover 125','ডিসকভার ১২৫','ডিসকভার 125']},
  {brand:'Bajaj',model:'Discover 100',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['discover 100','discover100','bajaj discover 100']},
  {brand:'Bajaj',model:'Pulsar 125',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['pulsar 125','pulsar125','p125']},
  {brand:'Bajaj',model:'Pulsar 150',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['pulsar 150','pulsar150','p150']},
  {brand:'Bajaj',model:'Pulsar 220',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['pulsar 220','pulsar220','p220']},
  {brand:'Bajaj',model:'Pulsar NS200',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['pulsar ns200','ns200','ns 200']},
  {brand:'Bajaj',model:'Platina',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['platina','platina 100','platina 110']},
  {brand:'Bajaj',model:'CT 100',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['ct100','ct 100','bajaj ct 100']},
  {brand:'TVS',model:'Apache RTR 160',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['apache rtr 160','rtr160','apache 160']},
  {brand:'TVS',model:'Apache RTR 200',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['apache rtr 200','rtr200','apache 200']},
  {brand:'TVS',model:'Metro',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['tvs metro','metro plus']},
  {brand:'TVS',model:'Sport',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['tvs sport','sport 100']},
  {brand:'Hero',model:'Splendor',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['splendor','splendor plus','splendor+']},
  {brand:'Hero',model:'HF Deluxe',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['hf deluxe','hfdeluxe','hero hf deluxe']},
  {brand:'Hero',model:'Glamour',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['hero glamour','glamour 125']},
  {brand:'Honda',model:'CB Shine',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['cb shine','cbshine','shine']},
  {brand:'Honda',model:'Dream 110',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['dream 110','dream neo','honda dream']},
  {brand:'Honda',model:'Unicorn',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['honda unicorn','unicorn 150','unicorn 160']},
  {brand:'Honda',model:'Grom',vehicleType:'motorcycle',fitment:'H4/HS1-base options exist in some market variants; verify exact model',aliases:['honda grom','grom 125','msx125','msx 125']},
  {brand:'Suzuki',model:'Gixxer',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['gixxer','gixxer 150','gixxer sf']},
  {brand:'Yamaha',model:'Saluto',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['saluto','yamaha saluto']},
  {brand:'Yamaha',model:'Fascino',vehicleType:'scooter',fitment:'variant-dependent',aliases:['fascino','yamaha fascino']},
  {brand:'Yamaha',model:'Ray ZR',vehicleType:'scooter',fitment:'variant-dependent',aliases:['ray zr','rayzr','yamaha ray zr']},
  {brand:'KTM',model:'Duke 200',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['duke 200','ktm duke 200']},
  {brand:'KTM',model:'RC 200',vehicleType:'motorcycle',fitment:'variant-dependent',aliases:['rc 200','ktm rc 200']},
  // Cars and utility vehicles: indexed for fast lookup, but model/year/trim must be checked.
  {brand:'Toyota',model:'Corolla',vehicleType:'car',fitment:'variant-dependent',aliases:['toyota corolla','corolla gli','corolla xli','corolla axio','axio']},
  {brand:'Toyota',model:'Allion',vehicleType:'car',fitment:'variant-dependent',aliases:['toyota allion','allion']},
  {brand:'Toyota',model:'Premio',vehicleType:'car',fitment:'variant-dependent',aliases:['toyota premio','premio']},
  {brand:'Toyota',model:'Probox',vehicleType:'car',fitment:'variant-dependent',aliases:['toyota probox','probox']},
  {brand:'Toyota',model:'Hiace',vehicleType:'van',fitment:'variant-dependent',aliases:['toyota hiace','hiace','হাইএস']},
  {brand:'Honda',model:'Civic',vehicleType:'car',fitment:'variant-dependent',aliases:['honda civic','civic']},
  {brand:'Honda',model:'Fit/Jazz',vehicleType:'car',fitment:'variant-dependent',aliases:['honda fit','fit','honda jazz','jazz']},
  {brand:'Honda',model:'City',vehicleType:'car',fitment:'variant-dependent',aliases:['honda city','city']},
  {brand:'Nissan',model:'Sunny',vehicleType:'car',fitment:'variant-dependent',aliases:['nissan sunny','sunny']},
  {brand:'Nissan',model:'AD Van',vehicleType:'van',fitment:'variant-dependent',aliases:['nissan ad','ad van','nissan ad van']},
  {brand:'Suzuki',model:'Alto',vehicleType:'car',fitment:'variant-dependent',aliases:['suzuki alto','alto']},
  {brand:'Suzuki',model:'Wagon R',vehicleType:'car',fitment:'variant-dependent',aliases:['suzuki wagon r','wagon r','wagonr']},
  {brand:'Suzuki',model:'Swift',vehicleType:'car',fitment:'variant-dependent',aliases:['suzuki swift','swift']},
  {brand:'Mitsubishi',model:'Lancer',vehicleType:'car',fitment:'variant-dependent',aliases:['mitsubishi lancer','lancer']},
  {brand:'Tata',model:'Ace',vehicleType:'truck',fitment:'variant-dependent',aliases:['tata ace','ace mini truck','টাটা এস']},
  {brand:'Tata',model:'407',vehicleType:'truck',fitment:'variant-dependent',aliases:['tata 407','407 truck']},
  {brand:'Mahindra',model:'Bolero Pickup',vehicleType:'pickup',fitment:'variant-dependent',aliases:['mahindra bolero pickup','bolero pickup','bolero pikup']},
  {brand:'Ashok Leyland',model:'Dost',vehicleType:'truck',fitment:'variant-dependent',aliases:['ashok leyland dost','leyland dost','dost mini truck']},
  {brand:'CNG',model:'Auto-rickshaw',vehicleType:'cng',fitment:'brand/model and lamp housing vary; verify socket',aliases:['cng','সিএনজি','auto rickshaw','autorickshaw','অটোরিকশা','অটো রিকশা','three wheeler','three-wheeler','থ্রি হুইলার']}
];
function isBikeCompatibilityQuestion(text='') { return /h\s*-?\s*[0-9]+|9003|hb2|hs\s*-?\s*1|headlight|head\s*lamp|হেডলাইট|হেড\s*লাইট|plug\s*and\s*play|socket|সকেট|বাল্ব|bulb|3\s*-?\s*pin|৩\s*পিন|তিন\s*পিন|প্রজেকশন|projector/i.test(text) && /বাইক|মোটরসাইকেল|motorcycle|motorbike|bike|গাড়ি|গাড়ি|কার|car|cng|সিএনজি|বাস|bus|ট্রাক|truck|ভ্যান|van|পিকআপ|pickup|মডেল|model|সাল|বছর|year|ফিট|fit|হবে|সাপোর্ট|support|socket|সকেট|পিন|pin|লাগবে|হেডলাইট|টয়োটা|toyota|honda|nissan|suzuki|yamaha|bajaj|tvs|hero|mahindra|tata|mitsubishi/i.test(text); }
function identifyBikeModel(text='') {
  const v=normalizeText(text);
  for (const entry of BUILTIN_BIKE_DATABASE) for (const name of [entry.model,...entry.aliases]) if (name.length>=3 && (` ${v} `).includes(` ${normalizeText(name)} `)) return entry;
  return null;
}
function isH4Confirmed(text='') { return /\bh\s*-?\s*4\b|\bhs\s*-?\s*1\b|\b9003\b|\bhb2\b|৩\s*পিন|তিন\s*পিন|3\s*-?\s*pin/i.test(text); }
function bikeClarification() { return 'হ্যাঁ—আপনার 60W LED প্রজেকশন হেডলাইটটি H4/3-pin সকেট, নির্ধারিত ভোল্টেজ এবং যানবাহনের বৈদ্যুতিক সিস্টেমের সঙ্গে মিলে গেলে ব্যবহার করা যেতে পারে। মডেল/বছর বা পুরোনো সকেটের ছবি দিলে বাইক, কার, CNG, ভ্যান বা ট্রাক—যে যানই হোক—ফিটমেন্ট মিলিয়ে বলব। শুধু H4-এর মতো দেখতে হলেই সব সকেটে সরাসরি লাগবে ধরে নেওয়া যাবে না।'; }
function bikeReply(text, senderId) {
  const allText=getRecentConversationText(senderId,text);
  if (/\bh\s*-?\s*(?:6m|7|11|13|1|3)\b/i.test(allText) && !isH4Confirmed(allText)) return 'আপনার উল্লেখ করা H1/H3/H7/H11/H13/H6M সকেট H4/3-pin-এর থেকে আলাদা হতে পারে। আপনার 60W LED প্রজেকশন লাইট ব্যবহার করা যাবে কি না, তা সকেট/অ্যাডাপ্টার, ভোল্টেজ ও ফিটমেন্ট মিলিয়ে নিশ্চিত করতে হবে। প্লাগের পরিষ্কার ছবি পাঠান।';
  if (isH4Confirmed(allText)) return 'হ্যাঁ—H4/3-pin সকেট, নির্ধারিত ভোল্টেজ ও কানেক্টর মিলে গেলে আপনার 60W LED প্রজেকশন হেডলাইট ব্যবহার করা যাবে। LED-র প্রকৃত বিদ্যুৎ খরচ মডেলভেদে আলাদা হতে পারে; তাই শুধু “60W” লেখা দেখে কম পাওয়ার নেয় ধরে নিচ্ছি না। HS1 বা অন্য কাছাকাছি সকেট সরাসরি মেলে কি না, তা কানেক্টর/অ্যাডাপ্টার দেখে নিশ্চিত করতে হবে।';
  const knownBike=identifyBikeModel(allText);
  if (knownBike) return `আপনি ${knownBike.brand} ${knownBike.model} (${knownBike.vehicleType}) বলেছেন। এই মডেলটি আমার যানবাহন ইনডেক্সে আছে। ফিটমেন্ট নোট: ${knownBike.fitment}. সকেটটি H4/3-pin হলে এবং নির্ধারিত ভোল্টেজ ও বৈদ্যুতিক সিস্টেম মিলে গেলে আপনার 60W LED প্রজেকশন লাইট ব্যবহার করা যাবে। তবে এই মডেলের সব বছর/ভ্যারিয়েন্টে H4 আছে বলে নিশ্চিত করছি না; মডেল ইয়ার/ভ্যারিয়েন্ট বা পুরোনো সকেটের ছবি দিলে মিলিয়ে বলব।`;
  const vehicle=allText.match(/(?:আমার|my)?\s*(?:গাড়ি|গাড়ি|কার|car|cng|সিএনজি|বাস|bus|ট্রাক|truck|বাইক|bike|মোটরসাইকেল|motorcycle|ভ্যান|van|পিকআপ|pickup)[^।.!?\n]{0,100}/i);
  if(vehicle) return `আপনি ${vehicle[0].trim()} বলেছেন। আপনার 60W LED প্রজেকশন লাইটটি H4/3-pin সকেট, ভোল্টেজ ও বৈদ্যুতিক সিস্টেম মিলে গেলে ব্যবহার করা যাবে। এই নির্দিষ্ট মডেলের সকেট এখনো নিশ্চিত নয়—ব্র্যান্ড, মডেল, সাল/ভ্যারিয়েন্ট অথবা পুরোনো হেডলাইট প্লাগের ছবি পাঠান।`;
  return bikeClarification();
}

// -----------------------------------------------------------------------------
// Orders, phone/address collection, automatic contact-detail handover
// -----------------------------------------------------------------------------
function isExplicitOrderIntent(text='') { return /\b(i want to order|place my order|order this|i will buy|i want to buy|confirm my order|i want this)\b|অর্ডার করতে চাই|অর্ডার করব|অর্ডার করবো|অর্ডার দিন|অর্ডার করে দিন|অর্ডার দিতে চাই|অর্ডার কনফার্ম|কিনতে চাই|কিনব|কিনবো|নিতে চাই|নিব|নেব|এটা নেব|এটি নেব|এটা কিনব|কিনে নেব|কিনে নিব/i.test(text); }
function isYes(text='') { return /^(হ্যাঁ|হ্যা|জি|জ্বি|রাজি|সম্মতি|সম্মতি দিচ্ছি|ঠিক আছে|করুন|দেন|yes|yeah|y|ok|okay|sure|i agree|agree)$/i.test(normalizeText(text)); }
function isNo(text='') { return /^(না|না ধন্যবাদ|রাজি নই|সম্মতি নেই|করবেন না|no|nope|n|don't|do not)$/i.test(normalizeText(text)); }
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
  const id=String(senderId), customer=db.customers[id]||{}, old=db.orderDrafts[id]||{};
  const draft={...old,customerMessage:[old.customerMessage,text].filter(Boolean).join('\n').slice(-1000)};
  const product=identifyOrderedProduct(id,text); if(product)draft.product=product;
  const phone=extractPhone(text); if(phone){draft.phone=phone;customer.phone=phone;}
  const address=extractAddress(text); if(address){draft.address=address;customer.address=address;}
  db.customers[id]=customer;
  if(!draft.product) { db.orderDrafts[id]=draft;saveStorage();await sendFacebookMessage(id,'আপনি কোন পণ্যটি অর্ডার করতে চান? পণ্যের সঠিক নাম বা মডেলটি লিখুন।');return true; }
  if(!draft.phone) { db.orderDrafts[id]=draft;saveStorage();await sendFacebookMessage(id,`${draft.product.name} অর্ডারের জন্য আপনার সচল মোবাইল নম্বরটি দিন।`);return true; }
  if(!draft.address) { db.orderDrafts[id]=draft;saveStorage();await sendFacebookMessage(id,'ডেলিভারির সম্পূর্ণ ঠিকানা লিখুন—এলাকা/গ্রাম, থানা/উপজেলা ও জেলা সহ।');return true; }
  draft.messageId=messageId||draft.messageId||null;
  draft.messageId=messageId||draft.messageId||null;
  const created=createMessengerOrder(id,draft,draft.messageId);
  delete db.orderDrafts[id]; delete db.pendingHandover[id]; saveStorage();
  await setTakeoverState(id,true,`Order automatically handed to human ${created.order.id}`);
  const billLines=created.order.total!==null?`\nবিল: ${created.order.productName} × ${created.order.quantity} = ${created.order.subtotal} টাকা; ডেলিভারি ${created.order.deliveryFee} টাকা; সর্বমোট ${created.order.total} টাকা।`:'\nচূড়ান্ত বিল প্রতিনিধি পণ্যের মূল্য ও ডেলিভারি চার্জ যাচাই করে জানাবেন।';
  await sendFacebookMessage(id,`আপনার ${draft.product.name} অর্ডারের তথ্য প্রতিনিধি টিমের কাছে পাঠানো হয়েছে।${billLines}\nপণ্য, ফোন ও ঠিকানা প্রতিনিধি যাচাই করে আপনার সঙ্গে যোগাযোগ করবেন। ${HELPLINE}`);
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
  validateCatalogShape(data);const normalized={...data,version:data.version??Date.now(),updatedAt:data.updatedAt??new Date().toISOString(),products:data.products,faqs:Array.isArray(data.faqs)?data.faqs:[]};saveLocalCatalog(normalized,source);return normalized;
}
async function pullCatalogFromGitHub() {
  if(!GITHUB_TOKEN){catalogMeta.lastSyncError='GITHUB_TOKEN is not configured';return false;}
  try {
    const url=`https://api.github.com/repos/${GITHUB_REPO}/contents/${CATALOG_FILE}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
    const r=await axios.get(url,{headers:{Authorization:`Bearer ${GITHUB_TOKEN}`,Accept:'application/vnd.github+json','User-Agent':'Impotech-Admin-Server'},timeout:15000});
    if(!r.data?.content)throw new Error('GitHub response contains no file content');
    const parsed=JSON.parse(Buffer.from(r.data.content,'base64').toString('utf8'));replaceCatalogAtomically(parsed,'github');return true;
  }catch(err){catalogMeta.lastSyncError=err.response?.data?.message||err.message;console.error('[GITHUB] Pull failed:',catalogMeta.lastSyncError);return false;}
}
async function pushCatalogToGitHub(data,customToken,customRepo,customBranch,customPath) {
  const token=customToken||GITHUB_TOKEN,repo=customRepo||GITHUB_REPO,branch=customBranch||GITHUB_BRANCH,filePath=customPath||CATALOG_FILE;
  if(!token)return {synced:false,message:'GitHub Token is not configured'};
  try{validateCatalogShape(data);}catch(e){return {synced:false,error:e.message};}
  const url=`https://api.github.com/repos/${repo}/contents/${filePath}`,headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','User-Agent':'Impotech-Admin-Server'};let sha=null;
  try{const r=await axios.get(`${url}?ref=${encodeURIComponent(branch)}`,{headers,timeout:10000});sha=r.data?.sha||null;}catch(e){if(e.response?.status!==404)return {synced:false,error:e.response?.data?.message||e.message};}
  const payload={message:`Update Impotech catalog ${data.version||Date.now()}`,content:Buffer.from(JSON.stringify(data,null,2),'utf8').toString('base64'),branch};if(sha)payload.sha=sha;
  try{const r=await axios.put(url,payload,{headers,timeout:20000});replaceCatalogAtomically(data,'github');return {synced:true,commit:r.data?.commit?.sha||'synced',totalProducts:products.length,totalFaqs:faqs.length};}catch(e){return {synced:false,error:e.response?.data?.message||e.message};}
}

// -----------------------------------------------------------------------------
// Exa search: external evidence is context only, never product price/stock truth.
// -----------------------------------------------------------------------------
async function exaSearch(query) {
  if (!EXA_API_KEY || !query) return [];
  try {
    const r = await axios.post(EXA_URL, {
      query: String(query).slice(0, 500),
      type: 'auto',
      numResults: 5,
      contents: { text: { maxCharacters: 1200 } }
    }, {
      headers: { 'x-api-key': EXA_API_KEY, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    const results = Array.isArray(r.data?.results) ? r.data.results : [];
    return results.slice(0, 5).map(x => ({
      name: String(x.title || x.author || 'Web result').slice(0, 180),
      url: String(x.url || '').slice(0, 500),
      content: String(x.text || x.highlights?.join(' ') || x.summary || '').slice(0, 1200)
    })).filter(x => x.content || x.url);
  } catch (e) {
    console.error('[EXA] Search failed', {
      status: e.response?.status ?? null,
      code: e.response?.data?.error?.code ?? e.response?.data?.code ?? e.code ?? null,
      message: e.response?.data?.error?.message ?? e.response?.data?.message ?? e.message
    });
    return [];
  }
}

// -----------------------------------------------------------------------------
// AI prompt and OpenRouter
// -----------------------------------------------------------------------------
function limitToFiveLines(text) { const lines=String(text||'').replace(/\r/g,'').split('\n').map(x=>x.trim()).filter(Boolean);return lines.slice(0,MAX_AI_LINES).join('\n'); }
function buildSystemPrompt(relevantProducts,relevantFaqs,history,memoryContext,webResults=[]) {
  const productContext=relevantProducts.length?relevantProducts.map((p,i)=>[`[পণ্য ${i+1}]`,`ID: ${p.id||'N/A'}`,`নাম: ${p.name||'N/A'}`,`ব্র্যান্ড: ${p.brand||'N/A'}`,`মডেল: ${p.model||'N/A'}`,`মূল্য: ${p.price??'ক্যাটালগে নেই'} টাকা`,`স্টক: ${p.stockStatus||(p.inStock===true?'IN_STOCK':'তথ্য নেই')}`,`বিবরণ: ${p.shortDescription||p.description||'N/A'}`,`বৈশিষ্ট্য: ${Array.isArray(p.features)?p.features.join(', '):'N/A'}`,`ছবি: ${getProductMediaUrls(p,'images').join(' | ')||'নেই'}`,`ভিডিও: ${getProductMediaUrls(p,'videos').join(' | ')||'নেই'}`].join('\n')).join('\n\n'):'কোনো প্রাসঙ্গিক পণ্য পাওয়া যায়নি।';
  const faqContext=relevantFaqs.length?relevantFaqs.map((f,i)=>`[FAQ ${i+1}] ${f.question||''}\n${f.answer||''}`).join('\n\n'):'প্রাসঙ্গিক FAQ পাওয়া যায়নি।';
  const historyContext=history.length?history.map(x=>`${x.role==='assistant'?'বট/প্রতিনিধি':'গ্রাহক'}: ${x.text}`).join('\n'):'পূর্ববর্তী কথোপকথন নেই।';
  const webContext=webResults.length?webResults.map((x,i)=>`[বাহ্যিক সার্চ ${i+1}] ${x.name}\n${x.content}\nURL: ${x.url}`).join('\n\n'):'কোনো বাহ্যিক সার্চ ফল নেই।';
  return `আপনি ImpoTech BD ফেসবুক পেজের ভদ্র বিক্রয় ও কাস্টমার সাপোর্ট সহকারী।\nহেল্পলাইন: ${HELPLINE}; WhatsApp: ${WHATSAPP_NUMBER}; ঠিকানা: ভাওয়াল গড়, ভবানীপুর, জয়দেবপুর, গাজীপুর।\nডেলিভারি: গাজীপুরের ভেতরে ৫০ টাকা, বাইরে ১০০ টাকা।\nনিয়ম: স্বাভাবিক, বিস্তারিত কিন্তু Messenger-উপযোগী বাংলায় উত্তর দিন (গ্রাহক ইংরেজিতে লিখলে ইংরেজিতে); প্রয়োজনে সর্বোচ্চ ৯টি ছোট লাইন/বুলেট ব্যবহার করুন। Gemini-ধাঁচের প্রাসঙ্গিক উত্তর দিন: প্রথম বাক্যেই সরাসরি উত্তর, তারপর কারণ/ফিটমেন্টের শর্ত এবং প্রয়োজন হলে পরবর্তী পদক্ষেপ। আগের কথোপকথন ও গ্রাহক মেমোরি থেকে ব্র্যান্ড, মডেল, সাল, পণ্য/ছবির প্রসঙ্গ ধরে রাখুন। ‘এটা’, ‘ওটা’, ‘ছবিটা’, ‘হবে?’, ‘দাম কত?’ বা ‘অর্ডার করব’ ধরনের ফলো-আপে আগের প্রাসঙ্গিক পণ্য/গাড়ি/বাইক বুঝে উত্তর দিন; আগে বলা তথ্য আবার জানতে চাইবেন না, যদি তা ইতিহাসে থাকে। গ্রাহক একাধিক মেসেজে তথ্য দিলে সেগুলো একত্রে বিবেচনা করুন। ক্যাটালগে নেই এমন দাম/স্টক/ওয়ারেন্টি/বৈশিষ্ট্য বানাবেন না। পণ্যের ID, নাম, দাম বা লিংক বদলাবেন না। অস্পষ্ট হলে একটি প্রশ্ন করুন। শেষ ২০ বার্তা ও গ্রাহক মেমোরি ব্যবহার করুন। বর্তমান মেসেজের সঙ্গে আগের মেসেজের যোগসূত্র বুঝুন; কথোপকথনে আগে উল্লেখিত মডেল থাকলে অকারণে আবার মডেল জিজ্ঞেস করবেন না। বাইক, কার, CNG, ভ্যান, পিকআপ ও ট্রাকসহ সব যানবাহনের মডেল/ব্র্যান্ড/সালকে BUILTIN_BIKE_DATABASE ইনডেক্সে খুঁজুন। গ্রাহক পরিচিত যানবাহনের নাম বললে সরাসরি উত্তর দিন: H4/3-pin সকেট, নির্ধারিত ভোল্টেজ ও বৈদ্যুতিক সিস্টেম মিলে গেলে আমাদের 60W LED প্রজেকশন লাইট ব্যবহার করা যাবে। তবে মডেল/বছরভেদে সকেট আলাদা হতে পারে, তাই অজানা fitment-কে নিশ্চিত বলবেন না; প্রয়োজনে একটি ছোট প্রশ্নে বছর/ভ্যারিয়েন্ট বা সকেটের ছবি চান। 35W/35/35W উল্লেখ করবেন না। H4/3-pin ও HS1-কে একই ধরে নেবেন না; দরকার হলে অ্যাডাপ্টার যাচাই করুন। Dimension & Clearance Check Rule: গ্রাহক H4 Mini LED Projector সম্পর্কে জানতে চাইলে পণ্যের দেওয়া মাপ হিসেবে লেন্সের ব্যাস 37mm, পেছনে কুলিং ফ্যান/হিটসিংকের জন্য 57mm গভীরতা এবং মোট দৈর্ঘ্য 113mm উল্লেখ করুন। সামনের হাউজিং/রিফ্লেক্টরে অন্তত 37mm ক্লিয়ারেন্স এবং পেছনে অন্তত 57mm খালি জায়গা যাচাই না করে নিশ্চিত ফিট বলবেন না; রাবার ডাস্ট কভার সামান্য কাটতে হতে পারে, তবে কাটার আগে মেকানিক দিয়ে পরীক্ষা করাতে বলুন। Bajaj Discover 125, Pulsar, Apache RTR, FZ বা অন্য কোনো মডেলে শুধু নাম দেখে “সহজেই ফিট হবে” বা “Plug and Play নিশ্চিত” বলবেন না—সঠিক বছর/ভ্যারিয়েন্ট, সকেট এবং বাস্তব জায়গা মিলতে হবে। Pure 12V DC প্রয়োজন: চাবি অন করলেই হেডলাইট জ্বলে বা ইঞ্জিন চালুর পর জ্বলে—এগুলো শুধু প্রাথমিক ইঙ্গিত, AC/DC নিশ্চিত করার নির্ভরযোগ্য পরীক্ষা নয়; মাল্টিমিটার দিয়ে মাপা বা মেকানিক দিয়ে যাচাই করতে বলুন। AC হলে মেকানিক দিয়ে সঠিক fused battery DC connection করানোর পরামর্শ দিন; নিজে সরাসরি তার জোড়া দিতে বলবেন না। সকেট/ডাইমেনশন/ভোল্টেজ নিশ্চিত না হলে অনিশ্চয়তা স্পষ্ট করুন এবং পুরোনো প্লাগ ও হাউজিংয়ের ছবি/মাপ বা মেকানিকের পরীক্ষা চান। পণ্যের প্রকৃত বিদ্যুৎ খরচ প্রমাণ ছাড়া কম বলে দাবি করবেন না। বাহ্যিক সার্চ ফলকে পণ্যের মূল্য/স্টক বা নিশ্চিত ফিটমেন্টের প্রমাণ ধরবেন না। অর্ডার জমা হলে স্বয়ংক্রিয়ভাবে human takeover চালু করুন। গ্রাহক ফোন নম্বর এবং সম্পূর্ণ ঠিকানা দিলে, তথ্য একাধিক মেসেজে এলেও, স্বয়ংক্রিয়ভাবে takeover চালু করুন। গ্রাহক কল করার কথা বললে বা webhook-এ call event এলে takeover চালু করুন। AI প্রশ্ন বুঝতে না পারলে আগে ঠিক এই বাক্যটি বলুন: ‘আমার প্রশ্নটা বুঝতে সমস্যা হচ্ছে, আমি কি আমাদের প্রতিনিধির কাছে প্রশ্নটা হস্তান্তর করবো?’ শুধু গ্রাহক হ্যাঁ বললে takeover চালু করুন। সিদ্ধান্তে অনিশ্চয়তা থাকলে সরাসরি হেল্পলাইনে কল করতে বলুন। হেডলাইটের ক্ষেত্রে বাইক, গাড়ি, CNG, বাস ও ট্রাক—সব যানবাহনে মডেল দেখে অনুমান করবেন না; H4/3-pin প্লাগের মিল যাচাই করুন, না জানলে প্লাগের ছবি/ধরন জানতে চান। ${HANDOVER_MARKER} ব্যবহার করবেন না, ব্যাকএন্ড সম্মতি আলাদাভাবে নেয়। ব্যক্তিগত তথ্য অপ্রয়োজনে প্রকাশ করবেন না।\n\nগ্রাহক মেমোরি:\n${memoryContext}\n\nপ্রাসঙ্গিক পণ্য:\n${productContext}\n\nFAQ:\n${faqContext}\n\nবাহ্যিক সার্চ ফল (শুধু সাধারণ প্রাসঙ্গিকতা):\n${webContext}\n\nকথোপকথন:\n${historyContext}`;
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
  const activeProduct = explicitProduct || findActiveProduct(senderId);
  const relevantProducts = activeProduct ? [activeProduct] : findRelevantProducts(context);
  const relevantFaqs=findRelevantFaqs(context);
  let webResults=[];
  // Search only when catalog/FAQ context is weak and the question is plausibly factual/compatibility-related.
  if (EXA_API_KEY && ((relevantProducts.length===0 && relevantFaqs.length===0 && /বাইক|মডেল|সকেট|হেডলাইট|compatible|compatibility|fit|ফিট|কানেক্টর|connector|স্পেসিফিকেশন|specification|car|truck|cng|toyota|honda|nissan|suzuki|mitsubishi|tata|mahindra|ট্রাক|গাড়ি|গাড়ি|সিএনজি/i.test(query)) || isBikeCompatibilityQuestion(query))) webResults=await exaSearch(query);
  const system=buildSystemPrompt(relevantProducts,relevantFaqs,history,memory,webResults);
  const prior=history.map(x=>({role:x.role==='assistant'?'assistant':'user',content:x.text}));
  const audio=attachments.find(x=>x.type==='audio'&&x.payload?.url);
  if(audio){try{const r=await axios.get(audio.payload.url,{responseType:'arraybuffer',timeout:15000,maxContentLength:MAX_ATTACHMENT_BYTES});const base64=Buffer.from(r.data).toString('base64');return limitToFiveLines(await callOpenRouter([{role:'system',content:system},...prior,{role:'user',content:[{type:'text',text:'গ্রাহকের ভয়েস বুঝে বাংলায় সর্বোচ্চ ৫ লাইনে উত্তর দিন। অনিশ্চিত হলে তা জানান।'},{type:'input_audio',input_audio:{data:base64,format:'mp4'}}]}],VOICE_MODEL));}catch(e){console.error('[VOICE] Failed:',e.message);}}
  const image=attachments.find(x=>x.type==='image'&&x.payload?.url);
  if(image){try{const r=await axios.get(image.payload.url,{responseType:'arraybuffer',timeout:15000,maxContentLength:MAX_ATTACHMENT_BYTES});const base64=Buffer.from(r.data).toString('base64');return limitToFiveLines(await callOpenRouter([{role:'system',content:system},...prior,{role:'user',content:[{type:'text',text:`${query}\nছবিটি বিশ্লেষণ করুন এবং আগের কথোপকথনে উল্লেখিত যানবাহন/পণ্যের সঙ্গে সম্পর্ক মিলিয়ে উত্তর দিন। আগে দেওয়া মডেল বা তথ্য পুনরায় জিজ্ঞেস করবেন না। ছবিতে যা স্পষ্ট দেখা যায় শুধু সেটিই বলুন; সকেট/ফিটমেন্ট নিশ্চিত না হলে তা স্পষ্ট করে জানান।`},{type:'image_url',image_url:{url:`data:${r.headers['content-type']||'image/jpeg'};base64,${base64}`}}]}]));}catch(e){console.error('[VISION] Failed:',e.message);}}
  return limitToFiveLines(await callOpenRouter([{role:'system',content:system},...prior,{role:'user',content:query}]));
}
async function buildVerifiedFitmentReply(senderId, customerText) {
  const allText = getRecentConversationText(senderId, customerText);
  const exactVehicle = identifyBikeModel(allText);
  const vehicleMatch = allText.match(/(?:yamaha|bajaj|tvs|hero|honda|suzuki|toyota|nissan|mitsubishi|mahindra|tata|maruti|suzuki|discover\s*125|pulsar\s*(?:ns)?\s*\d{2,3}|apache\s*(?:rtr)?\s*\d{2,3}|fz\s*v?\s*\d{0,2}|r15|alto|wagon\s*r|swift|corolla|civic|city|vitz|premio|fielder|axio|prius)[^।.!?\n]{0,60}/i);
  const vehicle = (exactVehicle?.brand && exactVehicle?.model)
    ? `${exactVehicle.brand} ${exactVehicle.model}`
    : (vehicleMatch?.[0] || '').trim();
  const yearMatch = allText.match(/(?:19|20)\d{2}|(?:সাল|year|বছর)\s*[:：-]?\s*(\d{2,4})/i);

  if (!vehicle) {
    return 'আপনার গাড়ি/বাইকের ব্র্যান্ড, সঠিক মডেল ও সম্ভব হলে সাল/ভ্যারিয়েন্ট লিখুন। শুধু অনুমান করে সকেট টাইপ নিশ্চিত বলা ঠিক হবে না।';
  }

  if (!EXA_API_KEY) {
    console.warn('[FITMENT] EXA_API_KEY missing; socket fitment cannot be verified');
    return `আপনার ${vehicle}${yearMatch ? ` (${yearMatch[0]})` : ''}-এর সকেট টাইপ এখন অনলাইনে যাচাই করতে পারছি না। মডেল ইয়ার/ভ্যারিয়েন্ট এবং পুরোনো হেডলাইটের প্লাগের পরিষ্কার ছবি পাঠান; অনুমান করে H4/3-pin নিশ্চিত বলব না।`;
  }

  const query = `"${vehicle}" ${yearMatch?.[0] || ''} original headlight bulb socket type H4 HS1 H7 H11 9003 HB2 P43t PX43t connector`;
  const results = await exaSearch(query).catch(() => []);
  const socketPattern = /\bH\s*-?\s*4\b|\bHS\s*-?\s*1\b|\bH\s*-?\s*7\b|\bH\s*-?\s*11\b|\bH\s*-?\s*3\b|\b9003\b|\bHB2\b|\bP43t\b|\bPX43t\b|\bH1\b|\bH13\b|\bH6M\b|\b3[ -]?pin\b|three[- ]pin|৩\s*পিন|তিন\s*পিন/i;
  const vehicleTokens = [vehicle, exactVehicle?.model].filter(Boolean).map(normalizeText).filter(x => x.length >= 3);
  const verified = (Array.isArray(results) ? results : []).map(r => {
    const title = String(r.name || '');
    const content = String(r.content || '');
    const url = String(r.url || '');
    const combined = `${title}\n${content}\n${url}`;
    const normalized = normalizeText(combined);
    const modelMatched = vehicleTokens.some(token => normalized.includes(token)) && (!yearMatch || normalized.includes(normalizeText(yearMatch[0])) || normalized.includes(normalizeText(exactVehicle?.model || '')));
    const socketMatch = combined.match(socketPattern);
    return { title, url, content, modelMatched, socket: socketMatch?.[0] || '' };
  }).find(r => r.modelMatched && r.socket);

  if (verified) {
    const socket = verified.socket.replace(/\s+/g, ' ').trim();
    const dimensionNote = /h4\s*mini|mini\s*led\s*projector|projector\s*lens|মিনি\s*প্রজেক্টর|প্রজেক্টর\s*লেন্স/i.test(allText)
      ? ' H4 Mini LED Projector-এর দেওয়া মাপ: লেন্স 37mm, পেছনে ফ্যানের জন্য 57mm গভীরতা, মোট দৈর্ঘ্য 113mm। হাউজিংয়ে এই ক্লিয়ারেন্স মেপে নিন; ডাস্ট কভার কাটতে হতে পারে। এটি Pure 12V DC-তে চালাতে হবে; AC/DC মেকানিক বা মাল্টিমিটার দিয়ে যাচাই করুন।'
      : '';
    return `অনলাইন সূত্রে ${vehicle}${yearMatch ? ` (${yearMatch[0]})` : ''}-এর জন্য ${socket} সকেটের উল্লেখ পেয়েছি। আপনার লাইটের প্লাগ একই টাইপ হলে সকেটের দিক থেকে ফিট হতে পারে; ভ্যারিয়েন্টভেদে পার্থক্য থাকতে পারে, তাই পুরোনো প্লাগের ছবি মিলিয়ে নিশ্চিত করুন।${dimensionNote}`;
  }

  if (results.length) {
    return `${vehicle}${yearMatch ? ` (${yearMatch[0]})` : ''}-এর সকেট টাইপ নির্ভরযোগ্যভাবে নিশ্চিত করার মতো মিল পাওয়া যায়নি। ভুল ফিটমেন্ট না বলতে মডেল ইয়ার/ভ্যারিয়েন্ট এবং পুরোনো হেডলাইট প্লাগের পরিষ্কার ছবি পাঠান।`;
  }
  return `${vehicle}${yearMatch ? ` (${yearMatch[0]})` : ''}-এর সকেট টাইপ এখন যাচাই করা যায়নি। মডেল ইয়ার/ভ্যারিয়েন্ট এবং পুরোনো হেডলাইট প্লাগের পরিষ্কার ছবি পাঠালে মিলিয়ে জানাব; অনুমান করে H4/3-pin বলব না।`;
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
    const priorVehicleFitmentContext=getRecentConversationText(id,customerText);
    const contextualVehicleFitment = /(?:হবে|ফিট|লাগবে|সাপোর্ট|fit|compatible|will it work|does it fit)/i.test(customerText) && /(?:গাড়ি|গাড়ি|কার|car|cng|সিএনজি|বাস|bus|ট্রাক|truck|বাইক|bike|মডেল|model|toyota|honda|nissan|suzuki|yamaha|bajaj|tvs|hero|mahindra|tata)/i.test(priorVehicleFitmentContext) && /(?:হেডলাইট|headlight|h4|3\s*-?\s*pin|৩\s*পিন|তিন\s*পিন|সকেট|plug|প্লাগ)/i.test(priorVehicleFitmentContext);
    const indexedVehicle = identifyBikeModel(getRecentConversationText(id, customerText));
    const hasFitmentIntentNow = isBikeCompatibilityQuestion(customerText) || /(?:হবে|ফিট|লাগবে|সাপোর্ট|fit|compatible|will it work|does it fit|সকেট|হেডলাইট|প্লাগ|৩\s*পিন|3\s*-?\s*pin|h4)/i.test(customerText);
    const imageFollowup = attachments.some(a => a.type === 'image') && !!indexedVehicle;
    if(isBikeCompatibilityQuestion(customerText) || contextualVehicleFitment || (indexedVehicle && hasFitmentIntentNow) || imageFollowup) {
      // Socket fitment is answered only from Exa evidence tied to the named model.
      // Never infer H4/3-pin merely because the customer mentioned a vehicle or socket.
      const fitmentReply = await buildVerifiedFitmentReply(id, customerText);
      await sendFacebookMessage(id, limitToFiveLines(fitmentReply));
      return;
    }
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
      const p=findExactProduct(customerText)||(isGenericPriceQuestion(customerText)?findProductFromRecentContext(id):null);
      if(!p){await sendFacebookMessage(id,'আপনি কোন পণ্যটির দাম জানতে চাচ্ছেন? পণ্যের সঠিক নাম বা মডেলটি বলুন।');return;}
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
        const payload=String(event.postback.payload||'').toUpperCase();
        if(payload==='HANDOVER_YES') { await transferToHuman(senderId,'Customer consented via postback'); }
        else if(payload==='HANDOVER_NO') { delete db.pendingHandover[String(senderId)];saveStorage();await sendFacebookMessage(senderId,'ঠিক আছে, AI সহায়তা চালু থাকছে।'); }
        continue;
      }
      if(!message||message.is_echo||!senderId)continue;
      if(messageId&&processedMessageIds.has(messageId))continue;
      if(messageId)processedMessageIds.set(messageId,Date.now());
      const text=String(message.text||'').trim(),attachments=message.attachments||[];
      const previous=customerQueues.get(senderId)||Promise.resolve();
      const task=previous.catch(()=>{}).then(async()=>{
        if(messageId&&db.messages.some(m=>m.messageId===messageId))return;
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
        if(phone || address) { const mem=getCustomerMemory(senderId); if(phone)addUniqueMemoryItem(mem.facts,`ফোন: ${phone}`); if(address)addUniqueMemoryItem(mem.facts,`ঠিকানা: ${address}`); mem.updatedAt=new Date().toISOString(); }
        // Do not pause the bot for a city-only mention or phone-only message. Transfer automatically only when both phone and a full address are available, outside an active order flow.
        if(phone && completeAddress && !db.orderDrafts[senderId] && !getTakeoverState(senderId)) { saveStorage(); await setTakeoverState(senderId,true,'Customer provided phone number and full address'); await sendFacebookMessage(senderId,`আপনার ফোন নম্বর ও সম্পূর্ণ ঠিকানা পেয়েছি। বিষয়টি আমাদের প্রতিনিধি টিমের কাছে হস্তান্তর করা হয়েছে। প্রয়োজনে কল করুন: ${HELPLINE}`); return; }
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
app.post('/api/catalog/sync',async(req,res)=>{try{const data=req.body;validateCatalogShape(data);replaceCatalogAtomically(data,'admin');let gh={synced:false};if(GITHUB_TOKEN)gh=await pushCatalogToGitHub(data);res.json({success:true,message:`Catalog processed: ${products.length} products, ${faqs.length} FAQs`,totalProducts:products.length,totalFaqs:faqs.length,githubSynced:gh.synced,githubError:gh.error||null,meta:catalogMeta});}catch(e){res.status(400).json({success:false,message:e.message});}});
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
app.get('/api/status',(req,res)=>res.json({success:true,status:'LIVE_PRODUCTION',storage:pool?'postgresql':'memory-only',catalogProducts:products.length,catalogFaqs:faqs.length,catalogFile:CATALOG_FILE,githubRepo:GITHUB_REPO,githubBranch:GITHUB_BRANCH,catalogMeta,globalBotPaused:!!db.isGlobalPaused,helpline:HELPLINE,whatsapp:WHATSAPP_NUMBER,historyLimit:HISTORY_LIMIT,memoryRetentionDays:MEMORY_RETENTION_DAYS,customers:Object.keys(db.customers).length,messages:db.messages.length,orders:db.orders.length,customerMemories:Object.keys(db.customerMemory).length,pendingFollowups:Object.values(db.scheduledFollowups).filter(x=>x&&x.status==='PENDING').length,exaConfigured:!!EXA_API_KEY,timestamp:new Date().toISOString()}));
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
    if(!EXA_API_KEY)console.warn('[CONFIG] EXA_API_KEY missing; web search disabled');
  });
}
startServer().catch(err=>{console.error('[SERVER] Startup error:',err.message);process.exit(1);});
setInterval(()=>{const cutoff=Date.now()-DUPLICATE_WINDOW_MS;for(const [id,t] of processedMessageIds)if(t<cutoff)processedMessageIds.delete(id);},60000).unref();
setInterval(()=>{for(const [id,task] of Object.entries(db.scheduledFollowups)){if(!task||task.status!=='PENDING')continue;if(getTakeoverState(id)||customerHasOrder(id)){cancelFollowup(id);continue;}if(!followupTimers.has(id))armFollowupTimer(id);}pruneOldMemory();saveStorage();},FOLLOWUP_CHECK_INTERVAL_MS).unref();
process.on('SIGTERM',async()=>{try{await persistChain;if(pool)await pool.end();}finally{process.exit(0);}});
process.on('SIGINT',async()=>{try{await persistChain;if(pool)await pool.end();}finally{process.exit(0);}});
