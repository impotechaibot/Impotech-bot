'use strict';

/**
 * ImpoTech AI Messenger Bot & Admin Backend
 * AI: OpenRouter Gemini 3.1 Flash-Lite
 * Storage: PostgreSQL (DATABASE_URL / POSTGRES_URL)
 * Catalog: GitHub catalog.json + local cache
 * Memory: last 20 messages + customer facts/preferences (20-day retention)
 * Human handover: automatic for completed orders/calls; consent for unclear questions
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
const TEXT_MODEL = 'google/gemini-3.1-flash-lite';
const VOICE_MODEL = TEXT_MODEL;
const HELPLINE = process.env.HELPLINE || '+8809611042598';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '01884332067';
const MAX_PRODUCTS_TO_AI = 3;
const MAX_FAQS_TO_AI = 3;
const MAX_OUTPUT_TOKENS = 350;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_MESSENGER_TEXT_LENGTH = 2000;
const MAX_AI_LINES = 9;
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
const FIRST_CONTACT_INTRO = 'আমি ইমপোটেকের AI সহকারী। পণ্য বা সার্ভিস সম্পর্কে যেকোনো প্রশ্ন করতে পারেন। অর্ডার করতে চাইলে সরাসরি জানাতে পারেন।';
const VEHICLE_FITMENT_HANDOFF_REPLY = 'আমাদের হেডলাইটের সকেট ও প্লাগ আপনার বাইক বা গাড়িতে সঠিকভাবে ফিট হবে কিনা তা আপনি নিজে সকেট দেখে নিশ্চিত হতে পারেন, অথবা আমাদের প্রতিনিধি আপনার সঙ্গে যোগাযোগ করে নিশ্চিত করবেন। হেল্পলাইন: ' + HELPLINE;

if (!DATABASE_URL) {
  console.warn('[DB] DATABASE_URL/POSTGRES_URL missing. Using in-memory fallback.');
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
// State and Storage
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
    try {
      if (fs.existsSync(LEGACY_DATA_FILE)) {
        const saved = JSON.parse(fs.readFileSync(LEGACY_DATA_FILE, 'utf8'));
        db = { ...db, ...saved };
        ensureStorageShape();
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
  }
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

function updateCustomerMemory(senderId, customerText) {
  const text = String(customerText || '').trim();
  if (!senderId || !text || text.length > 1000) return;
  const id = String(senderId), memory = getCustomerMemory(id), customer = db.customers[id] || {};
  const matches = products.map(product => ({ product, score: productScore(text, product) })).filter(x => x.score > 0).sort((a,b) => b.score-a.score);
  if (matches.length && (matches.length === 1 || matches[0].score > matches[1].score)) {
    addUniqueMemoryItem(memory.facts, `আলোচিত পণ্য: ${matches[0].product.name} (ID: ${matches[0].product.id})`);
    customer.activeProductId = matches[0].product.id;
    customer.activeProductName = matches[0].product.name || null;
  }
  const phone = text.match(/(?:\+?8801|01)[0-9\s-]{8,14}/);
  if (phone) customer.phone = phone[0].replace(/[\s-]/g, '');
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
}

// -----------------------------------------------------------------------------
// Catalog
// -----------------------------------------------------------------------------
function validateCatalogShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Catalog must be a JSON object');
  if (!Array.isArray(data.products)) throw new Error('Catalog must contain a products array');
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
// Product lookup, price, media & Smart Billing
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
  addUniqueMemoryItem(memory.facts, `আলোচিত পণ্য: ${product.name} (ID: ${product.id})`);
  saveStorage();
}

function findProductFromRecentContext(senderId) {
  const active = findActiveProduct(senderId);
  if (active) return active;
  const history = getHistory(senderId);
  for (let i = history.length - 1; i >= 0; i--) { if (history[i].role !== 'user') continue; const p = findExactProduct(history[i].text); if (p) return p; }
  return null;
}

function isPriceQuestion(text='') { return /\b(price|cost|how much|rate)\b|দাম|প্রাইস|মূল্য|কত টাকা|কত দাম|দাম কত|দামটা|কততে/i.test(normalizeText(text)); }
function isGenericPriceQuestion(text='') { return isPriceQuestion(text) && /^(দাম|দাম কত|দামটা কত|প্রাইস|প্রাইস কত|মূল্য|মূল্য কত|কত টাকা|কত দাম|price|how much|how much is it|what is the price)$/.test(normalizeText(text)); }
function getPriceReply(p) { return p && p.price !== undefined && p.price !== null && String(p.price).trim() !== '' ? `${p.name}-এর মূল্য ${p.price} টাকা।` : null; }

function isBillingQuestion(text='') { return /মোট|সর্বমোট|বিল|বিলিং|invoice|bill|total|grand total|সব মিলিয়ে|সব মিলিয়ে|ডেলিভারি চার্জ|delivery charge|কুরিয়ার চার্জ|কুরিয়ার চার্জ|ডেলিভারি খরচ|কত পড়বে|কত পড়বে|কত হবে|quantity|পরিমাণ|পিস|টি কিনলে/i.test(normalizeText(text)); }

function extractQuantity(text='') {
  const t=String(text||'').replace(/[০-৯]/g,d=>String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
  const patterns=[/(?:পরিমাণ|quantity|qty|পিস|টি)\s*[:=]?\s*(\d{1,3})/i,/(\d{1,3})\s*(?:পিস|টি|টা|pcs|pieces)/i];
  for(const re of patterns){const m=t.match(re);if(m){const n=Number(m[1]);if(Number.isInteger(n)&&n>=1&&n<=1000)return n;}}
  return null;
}

function getDeliveryFee(addressOrText='') {
  const t=normalizeText(addressOrText);
  if(!t) return 100; // Default outside Gazipur rate
  if(/গাজীপুর|gazipur/.test(t)) return 50;
  return 100; // Standard all-Bangladesh rate outside Gazipur
}

function buildSmartBillReply(product, quantity, deliveryFee, locationName = '') {
  const unit = Number(product?.price);
  if (!product || !Number.isFinite(unit) || unit < 0 || String(product.price ?? '').trim() === '') {
    return `দুঃখিত, ${product?.name || 'এই পণ্য'}-এর নির্ভরযোগ্য মূল্য ক্যাটালগে নেই।`;
  }
  const subtotal = unit * quantity;
  const locText = locationName ? ` (${locationName})` : '';
  return `স্মার্ট বিল হিসাব:\nপণ্য: ${product.name}\nএকক মূল্য: ${unit} টাকা × ${quantity} = ${subtotal} টাকা\nডেলিভারি চার্জ${locText}: ${deliveryFee} টাকা\nসর্বমোট বিল: ${subtotal + deliveryFee} টাকা`;
}

function isFacebookLink(url) { try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === 'facebook.com' || u.hostname.endsWith('.facebook.com') || u.hostname === 'fb.watch'); } catch (_) { return false; } }
function getProductMediaUrls(p, type) { const media = p?.media; return media && Array.isArray(media[type]) ? media[type].filter(url => typeof url === 'string' && isFacebookLink(url)) : []; }
function getMediaType(text='') { const v=normalizeText(text); if (/ভিডিও|video|রিল|reel|clip/.test(v)) return 'videos'; if (/ছবি|ছবিটা|ছবি কই|ফটো|পিকচার|ইমেজ|image|photo|picture/.test(v)) return 'images'; return null; }
function getProductMediaReply(text, senderId) {
  const type = getMediaType(text); if (!type) return null;
  const p = findExactProduct(text) || findRelevantProducts(text)[0] || findProductFromRecentContext(senderId);
  if (!p) return 'আপনি কোন পণ্যের ছবি বা ভিডিও দেখতে চান? পণ্যের নাম বা মডেলটি বলুন।';
  const urls = getProductMediaUrls(p, type); if (!urls.length) return `${p.name}-এর ${type==='images'?'ছবি':'ভিডিও'} লিংক বর্তমান ক্যাটালগে পাওয়া যাচ্ছে না।`;
  return `${p.name}-এর ${type==='images'?'ছবি':'ভিডিও'} লিংক:\n${urls.map((u,i)=>`${i+1}. ${u}`).join('\n')}`;
}

// -----------------------------------------------------------------------------
// Intent & Interrupt Detection
// -----------------------------------------------------------------------------
function isGlobalInterrupt(text = '') {
  const t = normalizeText(text);
  return /^(না|নিব না|নিবো না|করব না|করবো না|রাজি নই|দরকার নেই|পরে জানাব|পরে জানাচ্ছি|পরে নিব|বাতিল|cancel|stop|ছবি কই|ছবি দেন|ভিডিও দেন|দাম কত|কত টাকা|ডেলিভারি চার্জ কত|ডেলিভারি খরচ কত|ফিট হবে কি)$/i.test(t) ||
         /(?:ছবি কই|ছবি দেখান|ভিডিও দেখান|দাম কত|প্রাইস কত|পরে কথা বলব|অর্ডার করব না|নিব না)/i.test(t);
}

function isExplicitOrderIntent(text='') {
  return /\b(i want to order|place my order|order this|i will buy|i want to buy|confirm my order|send me this)\b|অর্ডার করতে চাই|অর্ডার করব|অর্ডার করবো|অর্ডার দিন|অর্ডার করে দিন|অর্ডার দিতে চাই|অর্ডার কনফার্ম|অর্ডার নেন|পাঠিয়ে দিন|পাঠিয়ে দেন|কিনে নিব|পার্সেল পাঠান/i.test(text);
}

function isYes(text='') { return /^(হ্যাঁ|হ্যা|জি|জ্বি|রাজি|সম্মতি|ঠিক আছে|দেন|yes|yeah|y|ok|okay|sure)$/i.test(normalizeText(text)); }
function isNo(text='') { return /^(না|না ধন্যবাদ|রাজি নই|সম্মতি নেই|করবেন না|no|nope|n|don't|do not)$/i.test(normalizeText(text)); }

function extractPhone(text='') {
  const m = String(text).match(/(?:\+?8801|01)[0-9\s-]{8,14}/);
  if (!m) return null;
  const n = m[0].replace(/[\s-]/g, '');
  return (/^\+?8801\d{9}$/.test(n) || /^01\d{9}$/.test(n)) ? n : null;
}

function extractAddress(text='') {
  const t = String(text || '').trim();
  if (!t || extractPhone(t)) return null;
  // If user is just asking a question with a city name, it's not a full delivery address
  if (/(মোট\s*বিল|বিল\s*কত|ডেলিভারি\s*চার্জ|দাম\s*কত|কত\s*টাকা|ফিট\s*হবে|হবে\s*কি|price|bill|how\s*much)/i.test(t)) return null;
  const explicit = t.match(/(?:ঠিকানা|address|বাসা|বাড়ি|গ্রাম|রোড|road|থানা|উপজেলা|জেলা|এলাকা)\s*[:：-]?\s*(.{5,220})/i);
  if (explicit) return explicit[1].trim().replace(/[।.!?]+$/, '');
  const hasLandmark = /(উপজেলা|থানা|গ্রাম|রোড|road|বাসা|বাড়ি|ওয়ার্ড|লেন|মহল্লা|বাজার)/i.test(t);
  const parts = t.split(/[,،\n]/).map(x => x.trim()).filter(Boolean);
  if (parts.length >= 3 || (t.length >= 15 && hasLandmark)) return t.slice(0, 220);
  return null;
}

function identifyOrderedProduct(senderId, text) {
  const p = findExactProduct(text); if (p) return p;
  const matches = findRelevantProducts(text);
  if (matches.length === 1) return matches[0];
  return findProductFromRecentContext(senderId);
}

function customerHasOrder(senderId) {
  const id = String(senderId || '');
  return db.orders.some(o => String(o.senderId || o.customerId || '') === id && !['CANCELLED','CANCELED','REJECTED'].includes(String(o.status || '').toUpperCase()));
}

function cancelFollowup(senderId) {
  const id = String(senderId || '');
  const timer = followupTimers.get(id);
  if (timer) clearTimeout(timer);
  followupTimers.delete(id);
  if (db.scheduledFollowups[id]) { delete db.scheduledFollowups[id]; saveStorage(); }
}

function getTakeoverState(customerId) {
  if (!customerId) return !!db.isGlobalPaused;
  const id = String(customerId).trim();
  if (db.isGlobalPaused) return true;
  if (db.takeovers[id] && typeof db.takeovers[id].isPaused === 'boolean') return db.takeovers[id].isPaused;
  if (db.customers[id] && typeof db.customers[id].takeover === 'boolean') return db.customers[id].takeover;
  return false;
}

async function setTakeoverState(customerId, enabled, reasonStr) {
  if (!customerId) return false;
  const id = String(customerId).trim(), on = Boolean(enabled), timestamp = new Date().toISOString();
  db.takeovers[id] = { isPaused: on, reason: reasonStr || (on ? 'Human takeover' : 'Admin resumed AI'), timestamp };
  if (!db.customers[id]) db.customers[id] = { id, name: `Customer ${id.slice(-4)}`, messageCount: 0 };
  Object.assign(db.customers[id], { isPaused: on, takeover: on, takeoverUpdatedAt: timestamp });
  if (on) cancelFollowup(id);
  saveStorage();
  return on;
}

async function sendFacebookMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) { console.error('[Messenger] PAGE_ACCESS_TOKEN missing'); return false; }
  const finalText = String(text || '').trim();
  if (!finalText || finalText.length > MAX_MESSENGER_TEXT_LENGTH) return false;
  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
    const response = await axios.post(url, { recipient: { id: recipientId }, message: { text: finalText }, messaging_type: 'RESPONSE' }, { timeout: 15000 });
    appendHistory(recipientId, 'assistant', finalText);
    addStoredMessage({ id: 'msg_bot_' + crypto.randomUUID(), senderId: recipientId, sender: 'bot', text: finalText, timestamp: new Date().toISOString(), messageId: response.data?.message_id || null });
    saveStorage();
    return true;
  } catch (err) {
    console.error('[Messenger] Send error:', err.response?.data?.error?.message || err.message);
    return false;
  }
}

async function askHandoverConsent(senderId, reason, extraMessage) {
  db.pendingHandover[String(senderId)] = { reason: reason || 'Customer support request', createdAt: new Date().toISOString(), extraMessage: extraMessage || null };
  saveStorage();
  return sendFacebookMessage(senderId, 'আপনার বিষয়টি স্পষ্টভাবে সমাধান করতে আমাদের একজন প্রতিনিধির সাহায্য প্রয়োজন। আমি কি কথোপকথনটি প্রতিনিধির কাছে হস্তান্তর করব? “হ্যাঁ” বা “না” লিখুন। হেল্পলাইন: ' + HELPLINE);
}

async function transferToHuman(senderId, reason, customMessage) {
  await setTakeoverState(senderId, true, reason || 'Customer consented to human handover');
  delete db.pendingHandover[String(senderId)];
  saveStorage();
  return sendFacebookMessage(senderId, customMessage || `কথোপকথনটি আমাদের প্রতিনিধির কাছে হস্তান্তর করা হয়েছে। প্রতিনিধি শীঘ্রই যোগাযোগ করবেন। হেল্পলাইন: ${HELPLINE}।`);
}

function createMessengerOrder(senderId, draft, messageId) {
  const id = String(senderId || '').trim();
  const customer = db.customers[id] || {}, product = draft.product;
  const quantity = Math.max(1, Number(draft.quantity) || 1);
  const unitPrice = Number(product?.price);
  const hasPrice = product?.price !== undefined && product?.price !== null && Number.isFinite(unitPrice) && unitPrice >= 0;
  const subtotal = hasPrice ? unitPrice * quantity : null;
  const deliveryFee = getDeliveryFee(draft.address || customer.address || '');
  const total = subtotal !== null && deliveryFee !== null ? subtotal + deliveryFee : null;

  const order = {
    id: 'order_' + crypto.randomUUID(),
    senderId: id, customerId: id, customerName: customer.name || `Customer ${id.slice(-4)}`,
    customerPhone: draft.phone || customer.phone || null,
    customerAddress: draft.address || customer.address || null,
    productId: product?.id || null, productName: product?.name || null, productPrice: product?.price ?? null,
    quantity, subtotal, deliveryFee, total, billingCurrency: 'BDT',
    customerMessage: draft.customerMessage || '', source: 'MESSENGER', sourceMessageId: messageId || null,
    status: 'PENDING_CONFIRMATION', humanTakeover: true, createdAt: new Date().toISOString()
  };
  db.orders.push(order);
  db.customers[id] = { ...customer, lastOrderId: order.id, lastOrderAt: order.createdAt, phone: order.customerPhone, address: order.customerAddress };
  cancelFollowup(id);
  saveStorage();
  return { order, created: true };
}

// -----------------------------------------------------------------------------
// Order Flow with Fallback Counter & Intent Protection
// -----------------------------------------------------------------------------
async function handleOrderFlow(senderId, text, messageId) {
  const id = String(senderId);
  const customer = db.customers[id] || {};
  const draft = db.orderDrafts[id] || { retryCount: 0 };

  // 1. Check Global Interrupts
  if (isGlobalInterrupt(text)) {
    delete db.orderDrafts[id];
    saveStorage();
    return false; // Yield to standard AI/Query processing
  }

  // 2. Identify Product, Phone, Address if provided
  const product = identifyOrderedProduct(id, text);
  if (product) draft.product = product;
  const phone = extractPhone(text);
  if (phone) { draft.phone = phone; customer.phone = phone; }
  const address = extractAddress(text);
  if (address) { draft.address = address; customer.address = address; }
  db.customers[id] = customer;

  // 3. Stepwise Collection with Max Retry Count (Fallback Counter)
  if (!draft.product) {
    draft.retryCount = (draft.retryCount || 0) + 1;
    if (draft.retryCount >= 2) {
      delete db.orderDrafts[id]; saveStorage();
      return false; // Exit order loop, let AI answer
    }
    db.orderDrafts[id] = draft; saveStorage();
    await sendFacebookMessage(id, 'আপনি কোন পণ্যটি অর্ডার করতে চান? পণ্যের নাম বা মডেলটি বলুন।');
    return true;
  }

  if (!draft.phone) {
    draft.retryCount = (draft.retryCount || 0) + 1;
    if (draft.retryCount >= 2) {
      delete db.orderDrafts[id]; saveStorage();
      return false;
    }
    db.orderDrafts[id] = draft; saveStorage();
    await sendFacebookMessage(id, `${draft.product.name} অর্ডারের জন্য আপনার মোবাইল নম্বরটি দিন।`);
    return true;
  }

  if (!draft.address) {
    draft.retryCount = (draft.retryCount || 0) + 1;
    if (draft.retryCount >= 2) {
      // User is talking about something else rather than giving address; break loop!
      delete db.orderDrafts[id]; saveStorage();
      return false;
    }
    db.orderDrafts[id] = draft; saveStorage();
    await sendFacebookMessage(id, 'ডেলিভারির সম্পূর্ণ ঠিকানা লিখুন (এলাকা/গ্রাম, থানা/উপজেলা ও জেলা সহ)।');
    return true;
  }

  // 4. All info present -> Create Order & Handover
  const created = createMessengerOrder(id, draft, messageId);
  delete db.orderDrafts[id]; delete db.pendingHandover[id]; saveStorage();
  await setTakeoverState(id, true, `Order created: ${created.order.id}`);

  const billLines = created.order.total !== null
    ? `\nবিল বিবরণ: ${created.order.productName} (${created.order.quantity} টি) = ${created.order.subtotal} টাকা + ডেলিভারি ${created.order.deliveryFee} টাকা = সর্বমোট ${created.order.total} টাকা।`
    : '';
  await sendFacebookMessage(id, `ধন্যবাদ! আপনার ${draft.product.name} অর্ডারের তথ্য সংরক্ষণ করা হয়েছে।${billLines}\nআমাদের প্রতিনিধি আপনার সঙ্গে যোগাযোগ করে অর্ডারটি কনফার্ম করবেন।`);
  return true;
}

// -----------------------------------------------------------------------------
// Follow-up scheduler
// -----------------------------------------------------------------------------
function scheduleFollowup(senderId, lastAt = Date.now()) {
  const id = String(senderId || ''); if (!id) return;
  cancelFollowup(id);
  if (getTakeoverState(id) || customerHasOrder(id)) return;
  const at = new Date(lastAt).getTime(); if (!Number.isFinite(at)) return;
  db.scheduledFollowups[id] = { senderId: id, dueAt: at + FOLLOWUP_DELAY_MS, lastCustomerMessageAt: at, status: 'PENDING' };
  saveStorage();
  armFollowupTimer(id);
}

function armFollowupTimer(senderId) {
  const id = String(senderId), task = db.scheduledFollowups[id];
  if (!task || task.status !== 'PENDING') return;
  const old = followupTimers.get(id); if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    followupTimers.delete(id);
    executeFollowup(id).catch(e => console.error('[FOLLOWUP]', e.message));
  }, Math.min(Math.max(0, Number(task.dueAt) - Date.now()), 2147483647));
  if (timer.unref) timer.unref();
  followupTimers.set(id, timer);
}

async function executeFollowup(senderId) {
  const id = String(senderId), task = db.scheduledFollowups[id];
  if (!task || task.status !== 'PENDING') return;
  const c = db.customers[id];
  if (!c || getTakeoverState(id) || customerHasOrder(id)) { delete db.scheduledFollowups[id]; saveStorage(); return; }
  const sent = await sendFacebookMessage(id, FOLLOWUP_MESSAGE);
  task.status = sent ? 'SENT' : 'FAILED'; task.sentAt = new Date().toISOString();
  saveStorage();
}

function restoreFollowupTasks() {
  for (const [id, t] of Object.entries(db.scheduledFollowups)) {
    if (!t || t.status !== 'PENDING') continue;
    if (getTakeoverState(id) || customerHasOrder(id)) { delete db.scheduledFollowups[id]; continue; }
    armFollowupTimer(id);
  }
}

// -----------------------------------------------------------------------------
// GitHub catalog sync
// -----------------------------------------------------------------------------
function replaceCatalogAtomically(data, source = 'admin') {
  validateCatalogShape(data);
  const normalized = { ...data, version: data.version ?? Date.now(), updatedAt: data.updatedAt ?? new Date().toISOString(), products: data.products, faqs: Array.isArray(data.faqs) ? data.faqs : [] };
  saveLocalCatalog(normalized, source);
  return normalized;
}

async function pullCatalogFromGitHub() {
  if (!GITHUB_TOKEN) return false;
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${CATALOG_FILE}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
    const r = await axios.get(url, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Impotech-Admin-Server' }, timeout: 15000 });
    if (!r.data?.content) return false;
    const parsed = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
    replaceCatalogAtomically(parsed, 'github');
    return true;
  } catch (err) {
    console.error('[GITHUB] Pull failed:', err.message);
    return false;
  }
}

async function pushCatalogToGitHub(data, customToken, customRepo, customBranch, customPath) {
  const token = customToken || GITHUB_TOKEN, repo = customRepo || GITHUB_REPO, branch = customBranch || GITHUB_BRANCH, filePath = customPath || CATALOG_FILE;
  if (!token) return { synced: false, message: 'GitHub Token is not configured' };
  try { validateCatalogShape(data); } catch (e) { return { synced: false, error: e.message }; }
  const url = `https://api.github.com/repos/${repo}/contents/${filePath}`, headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Impotech-Admin-Server' };
  let sha = null;
  try { const r = await axios.get(`${url}?ref=${encodeURIComponent(branch)}`, { headers, timeout: 10000 }); sha = r.data?.sha || null; } catch (e) { if (e.response?.status !== 404) return { synced: false, error: e.response?.data?.message || e.message }; }
  const payload = { message: `Update Impotech catalog ${data.version || Date.now()}`, content: Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64'), branch };
  if (sha) payload.sha = sha;
  try { const r = await axios.put(url, payload, { headers, timeout: 20000 }); replaceCatalogAtomically(data, 'github'); return { synced: true, commit: r.data?.commit?.sha || 'synced', totalProducts: products.length, totalFaqs: faqs.length }; } catch (e) { return { synced: false, error: e.response?.data?.message || e.message }; }
}

// -----------------------------------------------------------------------------
// AI Prompt with Negative Constraints
// -----------------------------------------------------------------------------
function limitToFiveLines(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(x => x.trim()).filter(Boolean);
  return lines.slice(0, MAX_AI_LINES).join('\n');
}

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
    : 'কোনো নির্দিষ্ট পণ্য পাওয়া যায়নি।';

  const faqContext = relevantFaqs.length
    ? relevantFaqs.map((f, i) => `[FAQ ${i + 1}] ${f.question || ''}\n${f.answer || ''}`).join('\n\n')
    : 'প্রাসঙ্গিক FAQ নেই।';

  const historyContext = history.length
    ? history.map(x => `${x.role === 'assistant' ? 'বট/প্রতিনিধি' : 'গ্রাহক'}: ${x.text}`).join('\n')
    : 'পূর্ববর্তী কথোপকথন নেই।';

  return `আপনি ImpoTech BD ফেসবুক পেজের স্মার্ট ও বিনয়ী কাস্টমার সাপোর্ট সহকারী।
হেল্পলাইন: ${HELPLINE}; WhatsApp: ${WHATSAPP_NUMBER}।
ডেলিভারি চার্জ নীতি: গাজীপুরের ভেতরে ৫০ টাকা, গাজীপুরের বাইরে সমগ্র বাংলাদেশে ১০০ টাকা।

কঠোর নিয়মাবলি (Negative Constraints):
১. কাস্টমার নিজে থেকে "অর্ডার করব", "অর্ডার নিতে চাই", "পাঠিয়ে দেন" এমন স্পষ্ট ইচ্ছা প্রকাশ না করা পর্যন্ত কাস্টমারের কাছে ডেলিভারির ঠিকানা বা ফোন নম্বর চাওয়া সম্পূর্ণ নিষিদ্ধ।
২. কাস্টমার যদি কোনো এলাকার নাম বলে (যেমন: পাবনা, রাজশাহী, চট্টগ্রাম ইত্যাদি) বা বাইকের মডেল বলে (যেমন: Discover 125, Pulsar), তবে কোনোভাবেই ডেলিভারির ঠিকানা চাইবেন না; শুধুমাত্র তার প্রশ্নের সরাসরি উত্তর ও সংশ্লিষ্ট ডেলিভারি চার্জ (যেমন: গাজীপুরের বাইরে ১০০ টাকা) এবং ফিটিং সংক্রান্ত তথ্য জানাবেন।
৩. হেডলাইট সকেট ও ফিটমেন্ট নিয়ম: বাইক বা গাড়ির যেকোনো মডেলে হেডলাইট বা সকেট (H4 / 3-pin Plug) মিলবে কিনা তা এআই নিজে বানিয়ে শতভাগ নিশ্চিত করবে না। স্পষ্টভাবে বলবেন যে: "হেডলাইটের সকেট ও প্লাগ আপনার বাইকে ফিট হবে কিনা তা আপনি নিজে সকেট দেখে নিশ্চিত হতে পারেন, অথবা আমাদের প্রতিনিধি যোগাযোগ করে নিশ্চিত করবেন।"
৪. গ্রাহক যে ভাষায় প্রশ্ন করবেন, সেই ভাষায় সংক্ষিপ্ত, ভদ্র ও সর্বোচ্চ ৪-৫ লাইনের মধ্যে উত্তর দিন।
৫. ক্যাটালগ ও FAQ-তে থাকা তথ্যের বাইরে কাল্পনিক কোনো দাম, স্টক বা ওয়ারেন্টি বলবেন না।

গ্রাহক মেমোরি:
${memoryContext}

প্রাসঙ্গিক পণ্য তালিকা:
${productContext}

FAQ:
${faqContext}

পূর্ববর্তী কথোপকথন:
${historyContext}`;
}

async function callOpenRouter(messages, model = TEXT_MODEL) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing');
  const r = await axios.post(OPENROUTER_URL, {
    model, messages, max_tokens: MAX_OUTPUT_TOKENS, temperature: 0.2
  }, {
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 30000
  });
  const reply = r.data?.choices?.[0]?.message?.content;
  return String(reply || '').trim();
}

async function generateAIResponse(customerText, attachments = [], senderId) {
  const query = customerText || 'ছবিটি দেখে সাহায্য করুন';
  let history = getHistory(senderId).slice();
  if (history.length && history[history.length - 1].role === 'user' && history[history.length - 1].text === query) history.pop();
  const context = getRecentConversationText(senderId, query);
  const memory = buildCustomerMemoryContext(senderId);

  const explicitProduct = findExactProduct(query);
  if (explicitProduct) rememberActiveProduct(senderId, explicitProduct);
  const activeProduct = explicitProduct || findActiveProduct(senderId);
  const relevantProducts = activeProduct ? [activeProduct] : findRelevantProducts(context);
  const relevantFaqs = findRelevantFaqs(context);

  const system = buildSystemPrompt(relevantProducts, relevantFaqs, history, memory);
  const prior = history.map(x => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: x.text }));

  const image = attachments.find(x => x.type === 'image' && x.payload?.url);
  if (image) {
    try {
      const r = await axios.get(image.payload.url, { responseType: 'arraybuffer', timeout: 15000, maxContentLength: MAX_ATTACHMENT_BYTES });
      const base64 = Buffer.from(r.data).toString('base64');
      return limitToFiveLines(await callOpenRouter([{ role: 'system', content: system }, ...prior, {
        role: 'user',
        content: [
          { type: 'text', text: `${query}\nছবিটি দেখে পণ্যের বিবরণ দিন। নিজে থেকে যানবাহনে ফিটমেন্টের মিথ্যা নিশ্চয়তা দেবেন না এবং অর্ডার না চাইলে ঠিকানা চাইবেন না।` },
          { type: 'image_url', image_url: { url: `data:${r.headers['content-type'] || 'image/jpeg'};base64,${base64}` } }
        ]
      }]));
    } catch (e) { console.error('[VISION] Failed:', e.message); }
  }

  return limitToFiveLines(await callOpenRouter([{ role: 'system', content: system }, ...prior, { role: 'user', content: query }]));
}

// -----------------------------------------------------------------------------
// Message Processing Flow
// -----------------------------------------------------------------------------
async function processCustomerMessage(senderId, text, attachments = [], messageId = null) {
  const id = String(senderId), customerText = String(text || '').trim();
  if (getTakeoverState(id)) return;

  try {
    // 1. Check if user explicitly wants to order
    if (isExplicitOrderIntent(customerText) || db.orderDrafts[id]) {
      const handled = await handleOrderFlow(id, customerText, messageId);
      if (handled) return; // If successfully handled or collecting, stop here
      // If handled is false (due to interrupt or retry exceeded), fall through to normal AI
    }

    // 2. Billing & Delivery Charges Query (Without asking for address)
    if (isBillingQuestion(customerText)) {
      const context = getRecentConversationText(id, customerText);
      const p = findExactProduct(customerText) || findExactProduct(context) || findProductFromRecentContext(id);
      if (p) {
        const quantity = extractQuantity(customerText) || extractQuantity(context) || 1;
        const fee = getDeliveryFee(customerText);
        const loc = /গাজীপুর|gazipur/i.test(customerText) ? 'গাজীপুর' : 'গাজীপুরের বাইরে';
        await sendFacebookMessage(id, buildSmartBillReply(p, quantity, fee, loc));
        return;
      }
    }

    // 3. Price Query
    if (isPriceQuestion(customerText)) {
      const p = findExactProduct(customerText) || (isGenericPriceQuestion(customerText) ? findProductFromRecentContext(id) : null);
      if (p) {
        const reply = getPriceReply(p);
        await sendFacebookMessage(id, reply || `${p.name}-এর মূল্য জানতে হেল্পলাইনে যোগাযোগ করুন।`);
        return;
      }
    }

    // 4. Media (Images/Videos) Query
    if (getMediaType(customerText)) {
      const reply = getProductMediaReply(customerText, id);
      if (reply) { await sendFacebookMessage(id, limitToFiveLines(reply)); return; }
    }

    // 5. Generate Standard AI Response
    let reply = await generateAIResponse(customerText, attachments, id);
    if (!reply) throw new Error('AI returned empty response');

    if (reply.includes(HANDOVER_MARKER)) {
      const clean = reply.replaceAll(HANDOVER_MARKER, '').trim();
      await askHandoverConsent(id, 'AI handover requested', clean);
      return;
    }

    if (!getTakeoverState(id)) {
      await sendFacebookMessage(id, limitToFiveLines(reply));
    }
  } catch (err) {
    console.error('[AI] Error:', err.message);
    if (!getTakeoverState(id)) {
      await sendFacebookMessage(id, 'আপনার মেসেজটি পেয়েছি। বিস্তারিত জানতে সরাসরি আমাদের হেল্পলাইনে যোগাযোগ করতে পারেন: ' + HELPLINE + ' অথবা WhatsApp: ' + WHATSAPP_NUMBER);
    }
  }
}

// -----------------------------------------------------------------------------
// Facebook Webhook Endpoints
// -----------------------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  try {
    if (req.body?.object !== 'page') return;
    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        const senderId = event.sender?.id, message = event.message, messageId = message?.mid;

        // Admin Echo & Takeover Commands (.ai / .human)
        if (message?.is_echo && message?.text && event.recipient?.id) {
          const echoCommand = normalizeText(message.text).replace(/\s+/g, '');
          const targetCustomerId = String(event.recipient.id);
          if (['.human', '.stop', '.pause'].includes(echoCommand)) {
            await setTakeoverState(targetCustomerId, true, `Admin command ${echoCommand}`);
          } else if (['.ai', '.resume'].includes(echoCommand)) {
            delete db.pendingHandover[targetCustomerId];
            await setTakeoverState(targetCustomerId, false, `Admin command ${echoCommand}`);
          }
          continue;
        }

        if (event.call && senderId) {
          await setTakeoverState(senderId, true, 'Incoming call event');
          await sendFacebookMessage(senderId, `কল করার জন্য ধন্যবাদ। জরুরি প্রয়োজনে সরাসরি যোগাযোগ করুন: ${HELPLINE}`);
          continue;
        }

        if (event.postback && senderId) {
          const payload = String(event.postback.payload || '').toUpperCase();
          if (payload === 'HANDOVER_YES') await transferToHuman(senderId, 'Postback handover consent');
          else if (payload === 'HANDOVER_NO') { delete db.pendingHandover[String(senderId)]; saveStorage(); await sendFacebookMessage(senderId, 'ঠিক আছে, আমি আপনাকে সাহায্য করছি।'); }
          continue;
        }

        if (!message || message.is_echo || !senderId) continue;
        if (messageId && processedMessageIds.has(messageId)) continue;
        if (messageId) processedMessageIds.set(messageId, Date.now());

        const text = String(message.text || '').trim(), attachments = message.attachments || [];
        const previous = customerQueues.get(senderId) || Promise.resolve();

        const task = previous.catch(() => {}).then(async () => {
          const now = new Date().toISOString(), paused = getTakeoverState(senderId);
          appendHistory(senderId, 'user', text || '[Media File]');
          addStoredMessage({ id: 'msg_' + crypto.randomUUID(), senderId, sender: 'customer', text: text || `[Media]`, timestamp: now, messageId: messageId || null });

          if (!db.customers[senderId]) {
            db.customers[senderId] = { id: senderId, name: `Customer ${senderId.slice(-4)}`, messageCount: 1, lastActive: now, lastMessageText: text };
          } else {
            const c = db.customers[senderId]; c.messageCount = (c.messageCount || 0) + 1; c.lastActive = now; c.lastMessageText = text;
          }

          if (text) updateCustomerMemory(senderId, text);

          // One-time introduction per customer
          const customerRecord = db.customers[senderId] || {};
          const command = normalizeText(text).replace(/\s+/g, '');
          if (!customerRecord.introSent && !['.human', '.stop', '.pause', '.ai', '.resume'].includes(command)) {
            customerRecord.introSent = true; db.customers[senderId] = customerRecord; saveStorage();
            await sendFacebookMessage(senderId, FIRST_CONTACT_INTRO);
          }

          if (['.human', '.stop', '.pause'].includes(command)) {
            await setTakeoverState(senderId, true, `Chat command ${command}`);
            await sendFacebookMessage(senderId, 'Human takeover সক্রিয় করা হয়েছে। আমাদের প্রতিনিধি কথা বলবেন।');
            return;
          }

          if (['.ai', '.resume'].includes(command)) {
            await setTakeoverState(senderId, false, `Chat command ${command}`);
            await sendFacebookMessage(senderId, 'AI সহকারী পুনরায় চালু হয়েছে। আপনাকে কীভাবে সাহায্য করতে পারি?');
            return;
          }

          if (!paused && !customerHasOrder(senderId)) scheduleFollowup(senderId, Date.now());
          else cancelFollowup(senderId);
          saveStorage();

          if (paused) return;

          if (normalizeText(text) === 'প্রতিনিধি' || normalizeText(text) === 'human' || normalizeText(text) === 'agent') {
            await askHandoverConsent(senderId, 'Customer requested agent');
            return;
          }

          await processCustomerMessage(senderId, text, attachments, messageId || null);
        });

        customerQueues.set(senderId, task);
        task.finally(() => { if (customerQueues.get(senderId) === task) customerQueues.delete(senderId); });
      }
    }
  } catch (err) { console.error('[Webhook] Processing error:', err.message); }
});

// -----------------------------------------------------------------------------
// Catalog & Admin APIs
// -----------------------------------------------------------------------------
app.get('/api/catalog', (req, res) => { const catalog = loadLocalCatalog(); res.json({ success: true, catalog, products: catalog.products || [], faqs: catalog.faqs || [], meta: catalogMeta }); });
app.post('/api/catalog/sync', async (req, res) => { try { const data = req.body; validateCatalogShape(data); replaceCatalogAtomically(data, 'admin'); let gh = { synced: false }; if (GITHUB_TOKEN) gh = await pushCatalogToGitHub(data); res.json({ success: true, totalProducts: products.length, totalFaqs: faqs.length, githubSynced: gh.synced, meta: catalogMeta }); } catch (e) { res.status(400).json({ success: false, message: e.message }); } });
app.post('/api/github/upload', async (req, res) => { try { const { catalog: payload, githubRepo, githubBranch, githubToken, githubFilePath } = req.body; const result = await pushCatalogToGitHub(payload || loadLocalCatalog(), githubToken || GITHUB_TOKEN, githubRepo || GITHUB_REPO, githubBranch || GITHUB_BRANCH, githubFilePath || CATALOG_FILE); if (!result.synced) return res.status(400).json({ success: false, message: result.error || result.message }); res.json({ success: true, commit: result.commit }); } catch (e) { res.status(400).json({ success: false, message: e.message }); } });

// Health & Status
app.get('/health', (req, res) => res.status(200).json({ success: true, status: 'ok', storage: pool ? 'postgresql' : 'memory-only' }));
app.get('/api/status', (req, res) => res.json({ success: true, status: 'LIVE_PRODUCTION', catalogProducts: products.length, helpline: HELPLINE, whatsapp: WHATSAPP_NUMBER, timestamp: new Date().toISOString() }));

// -----------------------------------------------------------------------------
// Server Initialization
// -----------------------------------------------------------------------------
async function startServer() {
  await initDatabase();
  loadLocalCatalog();
  await pullCatalogFromGitHub();
  restoreFollowupTasks();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] ImpoTech Bot running on port ${PORT}`);
    console.log(`[CATALOG] ${products.length} products, ${faqs.length} FAQs loaded`);
  });
}
startServer().catch(err => { console.error('[SERVER] Startup error:', err.message); process.exit(1); });

setInterval(() => {
  const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
  for (const [id, t] of processedMessageIds) if (t < cutoff) processedMessageIds.delete(id);
}, 60000).unref();

setInterval(() => {
  pruneOldMemory();
  saveStorage();
}, FOLLOWUP_CHECK_INTERVAL_MS).unref();
