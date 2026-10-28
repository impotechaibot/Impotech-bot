'use strict';

/**
 * ImpoTech AI Messenger Bot & Admin Backend  (v2 - audited & fixed)
 * AI: OpenRouter xiaomi/mimo-v2.6-flash (single-call text, voice transcription and vision)
 * Storage: PostgreSQL (DATABASE_URL / POSTGRES_URL)
 * Catalog: admin app / GitHub catalog.json + local cache, AUTO-REFRESHED (no stale data)
 * Memory: last 20 messages + customer facts/preferences (20-day retention) + active product/category topic
 * Human handover: automatic for completed contact details, orders, and call events; consent for unclear-question handover
 * Reply delay: every customer message is answered REPLY_DELAY_MS (default 5 s) after it was received
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

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
const APP_SECRET = process.env.APP_SECRET || process.env.META_APP_SECRET || ''; // optional: verifies Meta webhook signatures
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
const TEXT_MODEL = 'xiaomi/mimo-v2.6-flash';
// All OpenRouter tasks use the same requested model; VOICE_MODEL env overrides are intentionally ignored.
const VOICE_MODEL = TEXT_MODEL;
const HELPLINE = process.env.HELPLINE || '+8809611042598';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '01884332067';
const MAX_PRODUCTS_TO_AI = 2;
const MAX_FAQS_TO_AI = 3;
const MAX_OUTPUT_TOKENS = 400;
const TRANSCRIPTION_MAX_TOKENS = 1000;
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
const MAX_VOICE_FAILURES_BEFORE_HANDOVER = 2;
// Every customer message is answered this long AFTER it was received (default 5 seconds).
const REPLY_DELAY_MS = (() => {
  const n = Number(process.env.REPLY_DELAY_MS);
  return process.env.REPLY_DELAY_MS !== undefined && Number.isFinite(n) && n >= 0 ? Math.min(n, 30000) : 5000;
})();
// true  = phone number alone also starts human takeover. false (default) = phone AND address are both required.
const AUTO_HANDOVER_ON_PHONE_ONLY = process.env.AUTO_HANDOVER_ON_PHONE_ONLY === 'true';
// 'replace' (default): the admin app is the source of truth, FAQs/products you save fully replace the old ones.
// 'merge': legacy behaviour, old products/FAQs are always retained.
const CATALOG_SYNC_MODE = String(process.env.CATALOG_SYNC_MODE || 'replace').toLowerCase() === 'merge' ? 'merge' : 'replace';
// How often the server checks GitHub for catalog changes made outside this server (0 = off).
const CATALOG_REFRESH_INTERVAL_MS = (() => {
  const raw = process.env.CATALOG_REFRESH_INTERVAL_MS ?? process.env.CATALOG_AUTO_REFRESH_MS; // v5 name accepted too
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n)) return 120000;
  return n <= 0 ? 0 : Math.max(n, 30000);
})();
const LOCAL_CATALOG_PATH = path.join(__dirname, 'catalog.json');
const LOCAL_CATALOG_BACKUP_PATH = path.join(__dirname, 'catalog.backup.json');
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
let catalogExtras = {};
let catalogMeta = { version: null, updatedAt: null, source: 'local', lastSyncAt: null, lastPullAt: null, lastSyncError: null };
let catalogEtag = null;
let lastCatalogSha = null;
let catalogSyncInProgress = false;
let catalogDirty = false; // true when an admin change could not be pushed to GitHub yet
let db = {
  isGlobalPaused: false, takeovers: {}, customers: {}, messages: [], orders: [],
  customerMemory: {}, scheduledFollowups: {}, pendingHandover: {}, orderDrafts: {}, campaignAttribution: {}
};
const customerHistory = new Map();
const processedMessageIds = new Map();
const customerQueues = new Map();
const followupTimers = new Map();
let persistChain = Promise.resolve();
let persistQueued = false;

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
        await pool.query('INSERT INTO impotech_app_state(state_key,state_json) VALUES($1,$2::jsonb) ON CONFLICT(state_key) DO NOTHING', ['main', JSON.stringify(stateForPersist())]);
        console.log('[DB] Migrated legacy storage_data.json into PostgreSQL.');
      }
    } catch (err) { console.error('[DB] Legacy migration failed:', err.message); }
  }
  ensureStorageShape();
  await initMessageTable();
}

// Writes are coalesced: many saveStorage() calls in a burst produce ONE database write of the latest state.
function saveStorage() {
  ensureStorageShape();
  if (!pool) return true;
  if (persistQueued) return true;
  persistQueued = true;
  persistChain = persistChain.then(async () => {
    persistQueued = false;
    try {
      await pool.query(
        'INSERT INTO impotech_app_state(state_key,state_json,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(state_key) DO UPDATE SET state_json=EXCLUDED.state_json, updated_at=NOW()',
        ['main', JSON.stringify(stateForPersist())]
      );
    } catch (err) { console.error('[DB] State persistence failed:', err.message); }
  });
  return true;
}

// -----------------------------------------------------------------------------
// Text utilities
// NOTE: Bangla vowel signs / virama / nukta are Unicode "marks" (\p{M}), not letters (\p{L}).
// They MUST be kept, otherwise "দাম" becomes "দ ম" and every Bangla check silently fails.
// -----------------------------------------------------------------------------
function normalizeText(value = '') {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s৳$.-]/gu, ' ').replace(/\s+/g, ' ').trim();
}
const STOPWORDS = new Set([
  'এর','এই','এটা','এটি','ওটা','ওই','সেই','কি','কী','কত','কতো','কেমন','কোন','কোনটা','কিভাবে','কীভাবে','হবে','হয়','হলে','আছে','নেই',
  'আমি','আমার','আমাকে','আপনি','আপনার','আপনাদের','দেন','দিন','দাও','করে','করুন','করেন','করব','করবো','জন্য','থেকে','সাথে','সঙ্গে',
  'আর','নাকি','যে','তো','টা','টি','গুলো','একটু','একটা','বলেন','বলুন','জানতে','চাই','ভাই','ভাইয়া','আপু','স্যার','প্লিজ','হ্যালো','হাই',
  'the','is','are','an','of','to','for','and','in','on','it','this','that','what','how','much','can','you','me','my','do','does','please','hi','hello','ok'
].map(normalizeText));
function tokenize(value = '') { return normalizeText(value).split(/\s+/).filter(word => word.length >= 2 && !STOPWORDS.has(word)); }
function bnToEnDigits(value = '') { return String(value ?? '').replace(/[০-৯]/g, d => String('০১২৩৪৫৬৭৮৯'.indexOf(d))); }
function simpleReply(text = '') { return normalizeText(text).replace(/[.\-]+$/g, '').trim(); }
function addStoredMessage(message) {
  db.messages.push(message);
  if (db.messages.length > MESSAGE_RETENTION_LIMIT) db.messages.splice(0, db.messages.length - MESSAGE_RETENTION_LIMIT);
  insertMessageRow(message);
}
function ensureCustomer(senderId) {
  const id = String(senderId || '');
  if (!db.customers[id]) db.customers[id] = { id, name: `Customer ${id.slice(-4)}`, messageCount: 0 };
  return db.customers[id];
}
function isFreshTimestamp(iso) {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  return !Number.isFinite(t) || Date.now() - t <= MEMORY_RETENTION_MS;
}
function limitToFiveLines(text, max = MAX_AI_LINES) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(x => x.trim()).filter(Boolean);
  return lines.slice(0, max).join('\n');
}

// -----------------------------------------------------------------------------
// Customer memory
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

// -----------------------------------------------------------------------------
// Scoring / search over catalog and FAQ
// -----------------------------------------------------------------------------
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
    const words = new Set(value.split(' '));
    for (const token of tokens) {
      if (value === token) score += 12;
      else if (words.has(token)) score += 8;
      else if (token.length >= 3 && value.includes(token)) score += 4;
    }
  }
  return score;
}
function productScore(query, product) {
  return scoreRecord(query, product, ['id','name','description','shortDescription','category','brand','model','sku','keywords','tags','aliases']);
}
function findRelevantProducts(query) {
  return products.map(product => ({ product, score: productScore(query, product) }))
    .filter(x => x.score >= 8).sort((a,b) => b.score-a.score).slice(0, MAX_PRODUCTS_TO_AI).map(x => x.product);
}
function findRelevantFaqs(query) {
  return faqs.map(faq => ({ faq, score: scoreRecord(query, faq, ['question','q','answer','category','keywords']) }))
    .filter(x => x.score >= 8).sort((a,b) => b.score-a.score).slice(0, MAX_FAQS_TO_AI).map(x => x.faq);
}
// Meta FAQ / automation intent: recognize common Bangla, English and Banglish question forms.
function getFaqIntent(text = '') {
  const t = normalizeText(text);
  if (/ওয়ারেন্টি|গ্যারান্টি|warranty|guarantee|replacement|রিপ্লেস/i.test(t)) return 'warranty';
  if (/(?:^|\s)দাম(?:টা|টি|ের)?(?=$|\s|[?।!])|মূল্য|প্রাইস|price|\bcost\b|how much|কত\s*টাকা|কত\s*দাম|dam\s*koto|price\s*koto|rate\s*koto|\brate\b/i.test(t)) return 'price';
  if (/ডেলিভারি\s*চার্জ|কুরিয়ার\s*চার্জ|delivery\s*charge|courier\s*fee|shipping\s*cost/i.test(t)) return 'delivery';
  if (/ইনস্টল|installation|install|মেকানিক|mechanic/i.test(t)) return 'installation';
  if (/স্টক\s*আছে|পাওয়া\s*যাবে|available|availability|in\s*stock|stock\s*status/i.test(t)) return 'stock';
  if (/রিটার্ন|ফেরত|return\s*policy|refund|exchange|এক্সচেঞ্জ/i.test(t)) return 'return';
  return null;
}
function faqIntentScore(query, faq) {
  const intent = getFaqIntent(query);
  if (!intent) return 0;
  const values = [faq?.question, faq?.q, faq?.category, ...(Array.isArray(faq?.keywords) ? faq.keywords : [faq?.keywords])];
  const fields = normalizeText(values.filter(Boolean).join(' '));
  const patterns = {
    warranty: /ওয়ারেন্টি|গ্যারান্টি|warranty|guarantee|replacement/i,
    price: /দাম|মূল্য|প্রাইস|price|cost|rate|টাকা|price list/i,
    delivery: /ডেলিভারি|কুরিয়ার|delivery|courier|shipping/i,
    installation: /ইনস্টল|installation|install|মেকানিক|mechanic/i,
    stock: /স্টক|available|availability|in stock|পাওয়া যাবে/i,
    return: /রিটার্ন|ফেরত|return|refund|exchange|এক্সচেঞ্জ/i
  };
  return patterns[intent]?.test(fields) ? 30 : 0;
}
// A FAQ is sent verbatim only when it clearly answers the question AND does not contradict the customer's current topic.
function findBestFaqMatch(query, senderId) {
  const intent = getFaqIntent(query);
  // Price/stock of a product the customer named explicitly must come from the live catalog, not a generic FAQ.
  if ((intent === 'price' || intent === 'stock') && findExactProduct(query)) return null;
  const candidates = faqs
    .filter(faq => String(faq.answer || '').trim())
    .map(faq => {
      const base = scoreRecord(query, faq, ['question', 'q', 'keywords']);
      const boost = faqIntentScore(query, faq);
      return { faq, base, boost, score: base + boost };
    })
    .sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    const confident = c.boost > 0 ? c.score >= 30 : c.base >= 24;
    if (!confident) continue;
    if (senderId && faqConflictsWithTopic(c.faq, senderId)) continue;
    if (intent === 'price') {
      const topicProduct = getCurrentTopic(senderId).product || findExactProduct(query);
      if (faqPriceLooksStale(c.faq, topicProduct)) continue;
    }
    return c.faq;
  }
  return null;
}
// If the FAQ names a product but quotes a price different from the live catalog price, the FAQ is stale: use the catalog.
function faqPriceLooksStale(faq, product) {
  if (!product || product.price === undefined || product.price === null || String(product.price).trim() === '') return false;
  const answerRaw = String(faq?.answer || '');
  const named = findExactProduct(answerRaw);
  if (!named || String(named.id) !== String(product.id)) return false;
  const answer = bnToEnDigits(answerRaw).replace(/,/g, '');
  const price = bnToEnDigits(String(product.price)).replace(/,/g, '').trim();
  return Boolean(price) && !answer.includes(price);
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

// -----------------------------------------------------------------------------
// Product category + conversation topic ("active memory")
// The customer's current topic = active product and/or active category.
//  - Generic follow-ups (photo, video, price, delivery, "আলো কেমন") ALWAYS stay on the current topic.
//  - Only an explicit product name or category name (Fog Light, Headlight, Angel Wings) switches the topic.
// -----------------------------------------------------------------------------
const PRODUCT_CATEGORY_RULES = [
  { key: 'angelwings', label: 'Angel Wings', pattern: /(?:angel\s*wings?|angle\s*wings?|এঞ্জেল\s*উইংস?|এঙ্গেল\s*উইংস?|অ্যাঞ্জেল\s*উইংস?|এঞ্জেলউইং)/i },
  { key: 'foglight', label: 'Fog Light', pattern: /(?:fog\s*(?:lights?|lamps?)|foglights?|foglamps?|ফগ\s*(?:লাইট|ল্যাম্প)|ফগলাইট)/i },
  { key: 'headlight', label: 'Headlight', pattern: /(?:head\s*(?:lights?|lamps?)|headlights?|headlamps?|হেড\s*(?:লাইট|ল্যাম্প)|হেডলাইট)/i }
];
function detectCategoryKeys(text = '') {
  const t = normalizeText(text);
  return PRODUCT_CATEGORY_RULES.filter(rule => rule.pattern.test(t)).map(rule => rule.key);
}
function getCategoryLabel(key) { return PRODUCT_CATEGORY_RULES.find(r => r.key === key)?.label || key; }
function getExplicitProductCategoryIntent(text = '') { return detectCategoryKeys(text)[0] || null; }
function getProductCategoryKey(product) {
  if (!product) return null;
  const text = [
    product.name, product.category, product.brand, product.model,
    ...(Array.isArray(product.aliases) ? product.aliases : []),
    ...(Array.isArray(product.tags) ? product.tags : []),
    ...(Array.isArray(product.keywords) ? product.keywords : [])
  ].filter(Boolean).join(' ');
  return detectCategoryKeys(text)[0] || null;
}
function getProductsByExplicitCategory(category) {
  if (!category) return [];
  return products.filter(p => getProductCategoryKey(p) === category);
}
const ACTIVE_PRODUCT_FACT_RE = /^বর্তমান আলোচ্য পণ্য:|^আলোচিত পণ্য:/;

function findActiveProduct(senderId) {
  const customer = db.customers[String(senderId || '')] || {};
  const id = customer.activeProductId;
  if (!id || !isFreshTimestamp(customer.activeProductUpdatedAt)) return null;
  return products.find(p => String(p.id) === String(id)) || null; // always the LIVE catalog object
}
function getActiveCategory(senderId) {
  const customer = db.customers[String(senderId || '')] || {};
  return customer.activeCategory && isFreshTimestamp(customer.activeCategoryUpdatedAt) ? customer.activeCategory : null;
}
function rememberActiveProduct(senderId, product) {
  if (!senderId || !product) return;
  const id = String(senderId), c = ensureCustomer(id), now = new Date().toISOString();
  c.activeProductId = product.id;
  c.activeProductName = product.name || null;
  c.activeProductUpdatedAt = now;
  c.activeCategory = getProductCategoryKey(product) || null;
  c.activeCategoryUpdatedAt = now;
  const memory = getCustomerMemory(id);
  memory.facts = memory.facts.filter(item => !ACTIVE_PRODUCT_FACT_RE.test(String(item)));
  addUniqueMemoryItem(memory.facts, `বর্তমান আলোচ্য পণ্য: ${product.name} (ID: ${product.id})`);
  memory.updatedAt = now;
  c.lastMemoryUpdatedAt = now;
  saveStorage();
}
function clearActiveProduct(senderId) {
  const id = String(senderId || ''), c = ensureCustomer(id);
  delete c.activeProductId; delete c.activeProductName; delete c.activeProductUpdatedAt;
  const memory = getCustomerMemory(id);
  memory.facts = memory.facts.filter(item => !ACTIVE_PRODUCT_FACT_RE.test(String(item)));
}
function setActiveCategory(senderId, category) {
  const c = ensureCustomer(senderId);
  c.activeCategory = category || null;
  c.activeCategoryUpdatedAt = new Date().toISOString();
  saveStorage();
}
function getCurrentTopic(senderId) {
  const product = findActiveProduct(senderId);
  const category = product ? getProductCategoryKey(product) : getActiveCategory(senderId);
  return { product, category: category || null };
}
// If a FAQ is about a different product/category than the customer is talking about, it must not be sent verbatim.
function faqConflictsWithTopic(faq, senderId) {
  const topic = getCurrentTopic(senderId);
  if (!topic.product && !topic.category) return false;
  const answer = String(faq?.answer || '');
  const faqText = [faq?.question, faq?.q, faq?.category, ...(Array.isArray(faq?.keywords) ? faq.keywords : [faq?.keywords]), answer].filter(Boolean).join(' ');
  const namedProduct = findExactProduct(answer);
  if (topic.product && namedProduct && String(namedProduct.id) !== String(topic.product.id)) return true;
  const faqCategories = detectCategoryKeys(faqText);
  if (topic.category && faqCategories.length && !faqCategories.includes(topic.category)) return true;
  return false;
}
// Single source of truth: which product / category is this message about?
// Returns { product, categoryProducts, category, explicit }.
function resolveConversationTopic(text, senderId) {
  const id = String(senderId || '');
  const out = (product, categoryProducts = [], category = null, explicit = false) =>
    ({ product: product || null, categoryProducts, category: category || (product ? getProductCategoryKey(product) : null), explicit });
  const named = findExactProduct(text);
  if (named) { rememberActiveProduct(id, named); return out(named, [], null, true); }
  const requested = getExplicitProductCategoryIntent(text);
  if (requested) {
    const active = findActiveProduct(id);
    if (active && getProductCategoryKey(active) === requested) { setActiveCategory(id, requested); return out(active, [], requested, true); }
    // Clear topic switch (e.g. Headlight -> Fog Light): forget the old product.
    clearActiveProduct(id);
    setActiveCategory(id, requested);
    const choices = getProductsByExplicitCategory(requested);
    if (choices.length === 1) { rememberActiveProduct(id, choices[0]); return out(choices[0], [], requested, true); }
    return out(null, choices.slice(0, 3), requested, true);
  }
  const active = findActiveProduct(id);
  if (active) return out(active);
  const category = getActiveCategory(id);
  if (category) {
    const choices = getProductsByExplicitCategory(category);
    if (choices.length === 1) { rememberActiveProduct(id, choices[0]); return out(choices[0], [], category); }
    if (choices.length > 1) return out(null, choices.slice(0, 3), category);
  }
  return out(findProductFromRecentContext(id), [], null);
}
// A catalog-matched product explicitly named by the latest AI answer may switch the active topic.
// Do not silently keep the old product simply because one is already active.
// FAQ answers use allowSwitch:false because a general FAQ can mention another product incidentally.
function syncActiveProductFromReply(senderId, replyText, options = {}) {
  if (!senderId || !String(replyText || '').trim()) return;
  const named = findExactProduct(replyText);
  if (!named) return;
  const active = findActiveProduct(senderId);
  if (active && String(active.id) === String(named.id)) return;
  if (active && options.allowSwitch === false) return;
  // The product is chosen by code only after it is matched against the live catalog.
  rememberActiveProduct(senderId, named);
}

// -----------------------------------------------------------------------------
// Conversation history and memory updates
// -----------------------------------------------------------------------------
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
  const id = String(senderId), memory = getCustomerMemory(id), customer = ensureCustomer(id);
  // Topic: an explicitly named product/category switches the topic; generic follow-ups keep it.
  resolveConversationTopic(text, id);
  const knownVehicle = rememberVehicleModel(id, text);
  if (knownVehicle) customer.vehicleModelName = knownVehicle.model;
  const phone = extractPhone(text);
  if (phone) customer.phone = phone;
  const vehicle = text.match(/(?:আমার|my)\s*(?:বাইক|মোটরসাইকেল|গাড়ি|bike|motorcycle|car)[^।.!?\n]{0,120}/i);
  if (vehicle) addUniqueMemoryItem(memory.preferences, vehicle[0], 20);
  const address = extractAddress(text);
  if (address) { customer.address = address.slice(0, 220); addUniqueMemoryItem(memory.facts, `ঠিকানা: ${customer.address}`); }
  const preference = text.match(/(?:আমার পছন্দ|আমার বাজেট|বাজেট|ডেলিভারি|রং|কালার)[^।.!?\n]{0,120}/i);
  if (preference) addUniqueMemoryItem(memory.preferences, preference[0], 20);
  if (text.length >= 2 && text.length <= 300) { memory.recentQuestions = Array.isArray(memory.recentQuestions) ? memory.recentQuestions : []; memory.recentQuestions.push(text.slice(0, 200)); if (memory.recentQuestions.length > 10) memory.recentQuestions.splice(0, memory.recentQuestions.length - 10); }
  memory.updatedAt = new Date().toISOString(); customer.lastMemoryUpdatedAt = memory.updatedAt;
  saveStorage();
}
function buildCustomerMemoryContextLegacy(senderId) {
  const m = getCustomerMemory(senderId);
  if (!m) return 'কোনো সংরক্ষিত মেমোরি নেই।';
  return [m.facts.length ? `তথ্য:\n- ${m.facts.slice(-15).join('\n- ')}` : '', m.preferences.length ? `পছন্দ/প্রসঙ্গ:\n- ${m.preferences.slice(-10).join('\n- ')}` : '', m.summary ? `সারাংশ:\n${m.summary}` : ''].filter(Boolean).join('\n\n') || 'কোনো সংরক্ষিত মেমোরি নেই।';
}
function pruneOldMemory() {
  const cutoff = Date.now() - MEMORY_RETENTION_MS;
  let changed = false;
  for (const [id, m] of Object.entries(db.customerMemory)) {
    const updated = new Date(m.updatedAt || 0).getTime();
    if (!updated || updated < cutoff) { delete db.customerMemory[id]; changed = true; }
  }
  for (const [id, c] of Object.entries(db.customers)) {
    const active = new Date(c.lastActive || 0).getTime();
    if (active && active < cutoff) {
      // Keep customer/order records for admin history; only trim conversational memory and the old topic.
      if (c.activeProductId || c.activeCategory) {
        delete c.activeProductId; delete c.activeProductName; delete c.activeProductUpdatedAt;
        delete c.activeCategory; delete c.activeCategoryUpdatedAt; changed = true;
      }
      customerHistory.delete(id);
    }
  }
  return changed;
}

// -----------------------------------------------------------------------------
// Catalog (products + FAQs). The admin app is the source of truth: saved changes replace old data
// and are used by the bot immediately. GitHub is polled so outside edits are picked up automatically.
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
function faqKey(f) { return String(f?.id ?? f?.question ?? f?.q ?? '').trim().toLowerCase(); }
function getCatalogSnapshot() {
  return { ...catalogExtras, version: catalogMeta.version, updatedAt: catalogMeta.updatedAt, products, faqs };
}
// Decides how an incoming catalog is combined with the current one.
//  - replace mode (default): incoming products/FAQs fully REPLACE the old ones (edited or deleted items disappear).
//  - a payload with fewer than half of the existing products is treated as a PARTIAL update and merged safely.
//  - replaceAll:true / fullSync:true always replaces; deleteProductIds always deletes; an empty product list never wipes the catalog.
function mergeCatalogData(current, incoming) {
  validateCatalogShape(incoming);
  const oldProducts = Array.isArray(current?.products) ? current.products : [];
  const oldFaqs = Array.isArray(current?.faqs) ? current.faqs : [];
  const incomingProducts = incoming.products;
  const deleteIds = Array.isArray(incoming.deleteProductIds) ? incoming.deleteProductIds.map(String) : [];
  const explicitReplace = incoming.replaceAll === true || incoming.fullSync === true;
  if (oldProducts.length && incomingProducts.length === 0 && !explicitReplace && !deleteIds.length) {
    throw new Error('Refusing empty product catalog update because it would risk deleting existing products. Use replaceAll:true only for an intentional full replacement.');
  }
  const looksPartial = oldProducts.length >= 4 && incomingProducts.length < oldProducts.length * 0.5;
  const replaceMode = explicitReplace || (CATALOG_SYNC_MODE === 'replace' && incoming.replaceAll !== false && !looksPartial);

  let mergedProducts;
  if (replaceMode) {
    mergedProducts = incomingProducts.map(p => ({ ...p, id: String(p.id) }));
  } else {
    const productMap = new Map(oldProducts.map(p => [String(p.id), { ...p }]));
    for (const p of incomingProducts) {
      const id = String(p.id);
      productMap.set(id, productMap.has(id) ? { ...productMap.get(id), ...p, id } : { ...p, id });
    }
    mergedProducts = Array.from(productMap.values());
  }
  if (deleteIds.length) mergedProducts = mergedProducts.filter(p => !deleteIds.includes(String(p.id)));

  let mergedFaqs;
  const incomingFaqs = Array.isArray(incoming.faqs) ? incoming.faqs : null;
  if (incomingFaqs === null) mergedFaqs = oldFaqs.map(f => ({ ...f }));
  else if (explicitReplace || (replaceMode && !(oldFaqs.length && incomingFaqs.length === 0))) mergedFaqs = incomingFaqs.map(f => ({ ...f }));
  else {
    const faqMap = new Map(oldFaqs.map((f, i) => [faqKey(f) || `__old_${i}`, { ...f }]));
    for (const f of incomingFaqs) {
      const key = faqKey(f) || `__new_${crypto.randomUUID()}`;
      faqMap.set(key, faqMap.has(key) ? { ...faqMap.get(key), ...f } : { ...f });
    }
    mergedFaqs = Array.from(faqMap.values());
  }
  const result = { ...current, ...incoming, products: mergedProducts, faqs: mergedFaqs, version: incoming.version ?? Date.now(), updatedAt: incoming.updatedAt ?? new Date().toISOString() };
  delete result.deleteProductIds; delete result.replaceAll; delete result.fullSync;
  return result;
}
function getCatalogQualityWarnings(catalogProducts = products, catalogFaqs = faqs) {
  const warnings=[];
  const ids=new Set();
  for(const p of catalogProducts){
    const id=String(p?.id??'').trim(), name=String(p?.name??'').trim();
    if(!name)warnings.push({type:'missing_name',productId:id||null,message:'Product is missing name'});
    if(!id)warnings.push({type:'missing_id',productName:name||null,message:'Product is missing ID'});
    if(id&&ids.has(id))warnings.push({type:'duplicate_id',productId:id,message:'Duplicate product ID'});
    if(id)ids.add(id);
    if(p?.price===undefined||p?.price===null||String(p.price).trim()==='')warnings.push({type:'missing_price',productId:id||null,productName:name||null,message:'Product price is missing'});
    const aliases=Array.isArray(p?.aliases)?p.aliases:[];
    if(name&&aliases.some(a=>normalizeText(a)===normalizeText(name)))warnings.push({type:'redundant_alias',productId:id||null,message:'Alias duplicates product name'});
    if(!p?.description&&!p?.shortDescription)warnings.push({type:'missing_description',productId:id||null,productName:name||null,message:'Product description is missing'});
  }
  for(const f of catalogFaqs){if(!String(f?.answer||'').trim())warnings.push({type:'missing_faq_answer',faq:String(f?.question||f?.q||f?.id||'').slice(0,100),message:'FAQ answer is missing'});}
  return warnings.slice(0,500);
}
function applyCatalog(data, source = 'local') {
  validateCatalogShape(data);
  products = data.products.map(p => ({ ...p }));
  faqs = Array.isArray(data.faqs) ? data.faqs.map(f => ({ ...f })) : [];
  catalogExtras = { ...data };
  delete catalogExtras.products; delete catalogExtras.faqs; delete catalogExtras.version; delete catalogExtras.updatedAt;
  catalogMeta = { ...catalogMeta, version: data.version ?? null, updatedAt: data.updatedAt ?? null, source, lastSyncAt: new Date().toISOString(), lastSyncError: null };
  const qualityWarnings=getCatalogQualityWarnings(products,faqs);
  if(qualityWarnings.length) console.warn('[CATALOG QUALITY] Review recommended:', JSON.stringify({count:qualityWarnings.length,sample:qualityWarnings.slice(0,12)}));
}
function loadLocalCatalog() {
  try {
    if (!fs.existsSync(LOCAL_CATALOG_PATH)) return getCatalogSnapshot();
    const data = JSON.parse(fs.readFileSync(LOCAL_CATALOG_PATH, 'utf8'));
    validateCatalogShape(data);
    applyCatalog(data, 'local');
    return data;
  } catch (err) { console.error('[CATALOG] Local load error:', err.message); catalogMeta.lastSyncError = err.message; return getCatalogSnapshot(); }
}
function saveLocalCatalog(data, source = 'local') {
  validateCatalogShape(data);
  try { if (fs.existsSync(LOCAL_CATALOG_PATH)) fs.copyFileSync(LOCAL_CATALOG_PATH, LOCAL_CATALOG_BACKUP_PATH); } catch (_) { /* best-effort backup */ }
  const temp = LOCAL_CATALOG_PATH + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, LOCAL_CATALOG_PATH);
  applyCatalog(data, source); // in-memory catalog changes instantly: the very next customer message uses the new data
}
loadLocalCatalog();

// -----------------------------------------------------------------------------
// Admin authentication
// -----------------------------------------------------------------------------
const adminFailures = new Map(); // ip -> { count, windowStart }
function requireAdmin(req, res, next) {
  if (!REQUIRE_ADMIN_SECRET) return next();
  if (!ADMIN_SECRET) return res.status(503).json({ success: false, message: 'ADMIN_SECRET is not configured' });
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const rec = adminFailures.get(ip);
  if (rec && Date.now() - rec.windowStart < 10 * 60 * 1000 && rec.count >= 20) return res.status(429).json({ success: false, message: 'Too many failed attempts. Try again later.' });
  const supplied = String(req.get('x-admin-secret') || req.get('authorization')?.replace(/^Bearer\s+/i, '') || '');
  const a = Buffer.from(supplied), b = Buffer.from(ADMIN_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const fresh = !rec || Date.now() - rec.windowStart >= 10 * 60 * 1000;
    adminFailures.set(ip, fresh ? { count: 1, windowStart: Date.now() } : { count: rec.count + 1, windowStart: rec.windowStart });
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  adminFailures.delete(ip);
  next();
}
app.use('/api', (req, res, next) => ['/health','/status'].includes(req.path) ? next() : requireAdmin(req, res, next));
// v7: audit every successful admin write (registered right after authentication, so it covers all routes)
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  res.on('finish', () => auditAppend({ method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ip: req.ip || req.socket?.remoteAddress || null, fields: Object.keys(req.body || {}).slice(0, 20) }));
  next();
});

// -----------------------------------------------------------------------------
// Product lookup, price, billing helpers and media
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
function findProductFromRecentContext(senderId) {
  const active = findActiveProduct(senderId);
  if (active) return active;
  const history = getHistory(senderId);
  for (let i = history.length - 1; i >= 0; i--) { if (history[i].role !== 'user') continue; const p = findExactProduct(history[i].text); if (p) return p; }
  const memory = getCustomerMemory(senderId);
  for (const fact of [...(memory?.facts || [])].reverse()) { const p = findExactProduct(fact); if (p) return p; }
  return null;
}
function isPriceQuestion(text='') { return /\b(price|cost|how much|rate)\b|(?:^|\s)দাম(?:টা|টি|ের)?(?=$|\s|[?।!])|প্রাইস|মূল্য|কত\s*টাকা|কত\s*দাম|দাম\s*কত|দামটা|কততে|dam\s*koto/i.test(normalizeText(text)); }
function isGenericPriceQuestion(text='') { return isPriceQuestion(text) && /^(দাম|দাম কত|দামটা কত|প্রাইস|প্রাইস কত|মূল্য|মূল্য কত|কত টাকা|কত দাম|price|how much|how much is it|what is the price)$/.test(normalizeText(text)); }
function getPriceReply(p) { return p && p.price !== undefined && p.price !== null && String(p.price).trim() !== '' ? `${p.name}-এর দাম ${p.price} টাকা।` : null; }
// Smart Billing: quote only from catalog prices and the published delivery rates.
function isBillingQuestion(text='') {
  const t = normalizeText(bnToEnDigits(text));
  return /মোট|সর্বমোট|বিল(?:িং)?(?:\s|$)|invoice|\bbill\b|\btotal\b|grand total|সব মিলিয়ে|quantity|পরিমাণ|কত\s*পড়বে|টি\s*কিনলে|(?:\d+|এক|দুই|তিন|চার|পাঁচ)\s*(?:পিস|টা|টি|pcs|pieces)\s*(?:নিলে|কিনলে|লাগলে)/i.test(t);
}
function extractQuantity(text='') {
  const t = bnToEnDigits(text);
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
function getMediaTypes(text='') {
  const v = normalizeText(text), types = [];
  if (/ভিডিও|ভিডিয়ো|video|vdo|\bvid\b|reel|রিল|clip|ক্লিপ|অডিও\s*(?:দেন|দাও|দিন)/i.test(v)) types.push('videos');
  if (/ছবি|ফটো|পিকচার|ইমেজ|image|photo|picture|\bpics?\b|chobi/i.test(v)) types.push('images');
  return types;
}
function getMediaType(text='') { return getMediaTypes(text)[0] || null; }
function mediaLabel(type) { return type === 'images' ? 'ছবি' : 'ভিডিও'; }
// "লাইটের আলো কেমন হবে", "ব্রাইট কেমন", "দেখতে কেমন" => the customer wants to SEE the product (video first, then photo).
function isLightQualityQuestion(text='') {
  const t = normalizeText(text);
  return /আলো\s*(?:কেমন|কতটা|কত\s*টুকু|কি\s*রকম|কী\s*রকম|ভালো|কম|বেশি|বেশী|জ্বলে|দেয়|দিবে)|কেমন\s*আলো|আলোর\s*(?:মান|কোয়ালিটি|ব্রাইটনেস|পারফরম্যান্স)|আলোটা\s*কেমন|লাইট(?:ের|টা|টি)?\s*(?:কেমন|কি\s*রকম|কী\s*রকম|জ্বলে|ব্রাইট)|ব্রাইট|উজ্জ্বল|ফোকাস|কাট\s*অফ|cut\s*off|\bbeam\b|brightness|\bbright\b|how\s*(?:bright|good\s+is\s+the\s+(?:light|beam))|light\s*(?:output|quality|performance|test|demo)|\bdemo\b|ডেমো|রাতে\s*(?:আলো|কেমন)|দেখতে\s*কেমন|কেমন\s*দেখ(?:ায়|া\s*যায়|াবে)|লাইট\s*টেস্ট/i.test(t);
}
function getProductMediaReply(text, senderId, opts = {}) {
  const implicit = Array.isArray(opts.implicitTypes);
  const types = implicit ? opts.implicitTypes : getMediaTypes(text);
  if (!types.length) return null;
  const topic = resolveConversationTopic(text, senderId);
  const targets = topic.product ? [topic.product] : topic.categoryProducts;
  if (!targets.length) return implicit ? null : 'এই কথোপকথনে কোন পণ্যের কথা হচ্ছে তা শনাক্ত করতে পারিনি। অনুগ্রহ করে পণ্যের নাম/মডেল বা ছবি পাঠান।';
  const single = targets.length === 1;
  const sections = [];
  for (const type of types) {
    const label = mediaLabel(type);
    const found = targets.map(p => ({ p, urls: getProductMediaUrls(p, type) })).filter(x => x.urls.length);
    if (!found.length) continue;
    if (single) {
      const { p, urls } = found[0];
      const head = implicit ? `${p.name}-এর আলো কেমন তা ${type === 'videos' ? 'ভিডিওতে' : 'ছবিতে'} দেখুন:` : `${p.name}-এর ${label} লিংক:`;
      sections.push([head, ...urls.slice(0, 3).map((u, i) => `${i + 1}. ${u}`)].join('\n'));
    } else {
      sections.push([`ক্যাটালগে পাওয়া ${label}:`, ...found.map(x => `${x.p.name}: ${x.urls.slice(0, 2).join(' | ')}`)].join('\n'));
    }
    if (implicit) break; // first available media type is enough
  }
  if (sections.length) return sections.join('\n');
  if (implicit) return null;
  return single
    ? `${targets[0].name}-এর ${mediaLabel(types[0])} লিংক বর্তমান ক্যাটালগে পাওয়া যাচ্ছে না।`
    : `এই ক্যাটাগরির পণ্যের ${mediaLabel(types[0])} লিংক ক্যাটালগে পাওয়া যাচ্ছে না।`;
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
YAMAHA~FZ V1 / FZ-S V1~Yamaha FZ V1;FZ V1;FZ-S V1;FZS V1;ইয়ামাহা FZ V1~2008-2015~153 CC~H4~Direct Plug-and-Play
YAMAHA~FZ V2 / FZ-S V2 / FZER V2~Yamaha FZ V2;FZ V2;FZ-S V2;FZS V2;FZER V2;FZ ER V2;ইয়ামাহা FZ V2~2014-2021~149 CC~H4~Direct Plug-and-Play
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
  return normalizeText(bnToEnDigits(value)).replace(/[^\p{L}\p{M}\p{N}]/gu, '');
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
  const id = String(senderId), customer = ensureCustomer(id);
  Object.assign(customer, {
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
const VEHICLE_FITMENT_HANDOFF_REPLY = 'আমাদের দেওয়া তালিকায় আপনার বাইক/গাড়ির নির্দিষ্ট মডেলটি নিশ্চিতভাবে মেলেনি। সঠিক ফিটমেন্ট নিশ্চিত করতে আমাদের প্রতিনিধি সাহায্য করবে।';
function buildVehicleFitmentReply(row) {
  if (!row) return VEHICLE_FITMENT_HANDOFF_REPLY;
  const socketText = `Socket: ${row.socket}`;
  if (/DC Conversion Required/i.test(row.fitment)) {
    const connection = /Direct Plug-and-Play/i.test(row.fitment) ? 'কনভার্সনের পরে Direct Plug-and-Play; ' : 'Direct Fit; ';
    return `আপনার ${row.brand} ${row.model} (${row.years}, ${row.cc}) সম্পর্কে দেওয়া তালিকা অনুযায়ী ${socketText}। ${connection}তবে হেডলাইট লাগানোর আগে বাইকের AC supply-কে DC-তে convert করতে হবে।`;
  }
  if (/Direct Plug-and-Play/i.test(row.fitment)) return `আপনার ${row.brand} ${row.model} (${row.years}, ${row.cc}) সম্পর্কে দেওয়া তালিকা অনুযায়ী ${socketText} এবং fitment: Direct Plug-and-Play।`;
  return `আপনার ${row.brand} ${row.model} (${row.years}, ${row.cc}) সম্পর্কে দেওয়া তালিকায় ${socketText} এবং fitment: ${row.fitment} উল্লেখ আছে।`;
}
function isVehicleHeadlightFitmentInquiry(currentText='', recentContext='') {
  const current = String(currentText || '').normalize('NFKC').trim();
  const context = `${String(recentContext || '').normalize('NFKC')}\n${current}`;
  const asksFitOrMatch = /(?:fit(?:s|ment)?|ফিট(?:িং)?|compatible|compatibility|will\s+it\s+fit|does\s+it\s+fit|match(?:es|ing)?|ম্যাচ|মিলবে|মিলে\s*কি|মিলবে\s*কি|হবে\s*কি|ফিট\s*হবে|লাগবে\s*কি|সাপোর্ট\s*করবে|support\s*(?:it|my)|কাজ\s*করবে\s*কি)/i.test(current);
  const genericFitmentFollowup = /(?:এটা|এটি|ওটা|ওইটা|এইটা|সেটা|লাইটটা|হেডলাইটটা)\s*(?:(?:কি|কী)\s*)?(?:হবে|লাগবে|ফিট\s*হবে|মিলবে)|(?:ফিট\s*হবে|হবে\s*কি|লাগবে\s*কি|মিলবে\s*কি)/i.test(current)
    && !/(?:দাম|মূল্য|price|কত\s*টাকা|খরচ|বিল|bill|delivery|ডেলিভারি|quantity|পরিমাণ)/i.test(current);
  const mentionsPlugOrSocket = /(?:plug|প্লাগ|socket|সকেট|h\s*-?\s*4|hs\s*-?\s*1|3\s*-?\s*pin|৩\s*পিন|তিন\s*পিন)/i.test(current);
  const asksPlugMatch = mentionsPlugOrSocket && /(?:মিলবে|মিলে|ম্যাচ|match|fit|ফিট|হবে|লাগবে|সাপোর্ট|support|compatible)/i.test(current);
  const vehicleMentioned = /(?:বাইক|মোটরসাইকেল|bike|motorcycle|motorbike|গাড়ি|কার|\bcar\b|cng|সিএনজি|বাস|\bbus\b|ট্রাক|truck|ভ্যান|\bvan\b|পিকআপ|pickup|যানবাহন|vehicle|মডেল|\bmodel\b|discover|ডিসকভার|pulsar|পালসার|apache|অ্যাপাচি|yamaha|bajaj|\btvs\b|hero|honda|suzuki|gixxer|splendor|fz\s*\d*|r15|corolla|allion|premio|hiace|civic|alto|wagon\s*r|swift|nissan|toyota|mahindra|\btata\b|mitsubishi)/i.test(context);
  const headlightContext = /(?:হেড\s*লাইট|হেডলাইট|head\s*light|headlight|headlamp|head\s*lamp|বাল্ব|bulb|projector|প্রজেক্টর|plug|প্লাগ|socket|সকেট|h\s*-?\s*4|hs\s*-?\s*1|3\s*-?\s*pin|৩\s*পিন|তিন\s*পিন)/i.test(context);
  const knownModelInContext = Boolean(findVehicleCompatibility(current) || findVehicleCompatibility(context));
  return (vehicleMentioned || knownModelInContext) && (headlightContext || knownModelInContext) && (asksFitOrMatch || asksPlugMatch || genericFitmentFollowup);
}

// -----------------------------------------------------------------------------
// Orders, phone/address collection, automatic contact-detail handover
// -----------------------------------------------------------------------------
function isExplicitOrderIntent(text='') {
  const t = normalizeText(text);
  if (/(?:করব|করবো|কিনব|কিনবো|নেব|নিব|নিতে)\s*না|অর্ডার\s*(?:করব|করবো)?\s*না|not\s+(?:buy|order)|don't\s+(?:buy|order)|do not\s+(?:buy|order)/i.test(t)) return false;
  // "কিভাবে অর্ডার করব?" / "where can I buy" are questions, not an order.
  if (/কিভাবে|কীভাবে|কোথায়|কোথা\s*থেকে|how\s+(?:to|can|do)|where\s+(?:can|to|do)/i.test(t) && !/(?:করতে\s*চাই|করে\s*দিন|কনফার্ম|পাঠিয়ে\s*দিন)/i.test(t)) return false;
  return /\b(i want to order|place my order|order this|i will buy|i want to buy|confirm my order|i want this|send it to me)\b|অর্ডার\s*করতে\s*চাই|অর্ডার\s*করব|অর্ডার\s*করবো|অর্ডার\s*দিন|পাঠিয়ে\s*দিন|অর্ডার\s*করে\s*দিন|অর্ডার\s*দিতে\s*চাই|অর্ডার\s*কনফার্ম|কিনতে\s*চাই|কিনব|কিনবো|নিতে\s*চাই|নিব|নেব|কিনে\s*নেব|কিনে\s*নিব/i.test(t);
}
function isYes(text='') { return /^(?:জি\s*)?(?:হ্যাঁ|হ্যা|হা|জি|জ্বি|রাজি|সম্মতি|সম্মতি দিচ্ছি|ঠিক আছে|করুন|দেন|অবশ্যই|yes|yeah|yep|y|ok|okay|sure|i agree|agree)(?:\s*(?:জি|ভাই|করুন|দেন|please))?$/i.test(simpleReply(text)); }
function isNo(text='') { return /^(?:না|nah|nope|no|n|থাক|রাজি নই|সম্মতি নেই|করবেন না|করব না|করবো না|নিবো না|নেব না|কিনব না|কিনবো না|অর্ডার করব না|অর্ডার করবো না|লাগবে না|দরকার নেই|no thanks|not now|don't|do not)(?:\s|$)/i.test(simpleReply(text)); }

// Bangladeshi mobile numbers: 01[3-9]XXXXXXXX, with optional +88 / 88, spaces or hyphens, English OR Bangla digits.
const PHONE_RE = /(?<!\d)(?:\+?88[\s-]?(?:0[\s-]?)?|0)1[3-9](?:[\s-]?\d){8}(?!\d)/;
function extractPhone(text='') {
  const m = bnToEnDigits(String(text || '').normalize('NFKC')).match(PHONE_RE);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, '');
  const local = digits.startsWith('88') ? digits.slice(2) : digits;
  return /^01[3-9]\d{8}$/.test(local) ? local : null;
}
function stripPhones(text='') {
  const original = String(text || '').normalize('NFKC'), converted = bnToEnDigits(original);
  const globalRe = new RegExp(PHONE_RE.source, 'g');
  let out = '', last = 0;
  for (const m of converted.matchAll(globalRe)) { out += original.slice(last, m.index) + ' '; last = m.index + m[0].length; }
  return (out + original.slice(last)).replace(/\s+/g, ' ').trim();
}
function looksLikeQuestion(text='') {
  const t = normalizeText(text);
  if (/[??]/.test(String(text))) return true;
  if (/(?:^|\s)(?:কি|কী|কত|কেমন|কীভাবে|কিভাবে|কোথায়|কখন|কেন|কোন|কোনটা)(?:\s|$)/.test(t)) return true;
  return /মোট\s*বিল|বিল\s*কত|ডেলিভারি\s*চার্জ|দাম\s*কত|কত\s*টাকা|কত\s*হবে|\bprice\b|\bbill\b|delivery\s*charge|how\s*much|total\s*cost|পাওয়া\s*যাবে|হবে\s*কি|যাবে\s*কি|আছে\s*কি/i.test(t);
}
const BD_PLACES_BN = ['ঢাকা','গাজীপুর','নারায়ণগঞ্জ','নরসিংদী','মানিকগঞ্জ','মুন্সিগঞ্জ','মুন্সীগঞ্জ','কিশোরগঞ্জ','টাঙ্গাইল','ফরিদপুর','গোপালগঞ্জ','মাদারীপুর','শরীয়তপুর','রাজবাড়ী','চট্টগ্রাম','কক্সবাজার','কুমিল্লা','ব্রাহ্মণবাড়িয়া','চাঁদপুর','ফেনী','নোয়াখালী','লক্ষ্মীপুর','খাগড়াছড়ি','রাঙ্গামাটি','রাঙামাটি','বান্দরবান','রাজশাহী','নাটোর','নওগাঁ','চাঁপাইনবাবগঞ্জ','পাবনা','সিরাজগঞ্জ','বগুড়া','জয়পুরহাট','খুলনা','বাগেরহাট','সাতক্ষীরা','যশোর','ঝিনাইদহ','মাগুরা','নড়াইল','কুষ্টিয়া','চুয়াডাঙ্গা','মেহেরপুর','বরিশাল','ভোলা','পটুয়াখালী','পিরোজপুর','ঝালকাঠি','বরগুনা','সিলেট','মৌলভীবাজার','হবিগঞ্জ','সুনামগঞ্জ','রংপুর','দিনাজপুর','গাইবান্ধা','কুড়িগ্রাম','লালমনিরহাট','নীলফামারী','ঠাকুরগাঁও','পঞ্চগড়','ময়মনসিংহ','জামালপুর','নেত্রকোণা','শেরপুর'];
const BD_PLACES_EN = ['dhaka','gazipur','narayanganj','narsingdi','tangail','chattogram','chittagong','sylhet','rajshahi','khulna','barisal','barishal','rangpur','mymensingh','comilla','cumilla','bogra','bogura','jessore','jashore','cox\'s bazar'];
const BD_PLACE_RE = new RegExp(`${BD_PLACES_BN.join('|')}|\\b(?:${BD_PLACES_EN.join('|')})\\b`, 'i');
const ADDRESS_LANDMARK_RE = /(উপজেলা|থানা|গ্রাম|রোড|\broad\b|বাসা|বাড়ি|বাড়ী|ওয়ার্ড|\bward\b|লেন|\blane\b|মহল্লা|বাজার|হাউজ|\bhouse\b|ব্লক|\bblock\b|সেক্টর|\bsector\b|পোস্ট\s*অফিস|ইউনিয়ন|\bunion\b|ডাকঘর|মোড়|পাড়া|সড়ক|এভিনিউ|\bavenue\b|ফ্ল্যাট|\bflat\b|এলাকা)/i;
function cleanAddress(value) { return String(value || '').trim().replace(/[।.!?]+$/, '').trim().slice(0, 220); }
// Works when the phone number is in the SAME message (the phone is removed first), accepts Bangla digits,
// and ignores questions such as "রাজশাহীতে মোট বিল কত".
function extractAddress(text='') {
  const original = String(text || '').normalize('NFKC').trim();
  if (!original) return null;
  const hadPhone = Boolean(extractPhone(original));
  const t = stripPhones(original);
  if (t.length < 5) return null;
  const strong = t.match(/(?:ঠিকানা|address)\s*[::-]?\s*(.{5,220})/i);
  if (strong) return cleanAddress(strong[1]);
  if (looksLikeQuestion(t)) return null;
  const weak = t.match(/(?:বাসা|বাড়ি|বাড়ী|গ্রাম|রোড|থানা|উপজেলা|জেলা|এলাকা|এলাকার নাম)\s*[::-]\s*(.{5,220})/i);
  if (weak) return cleanAddress(weak[1]);
  const parts = t.split(/[,،\n]/).map(x => x.trim()).filter(Boolean);
  const hasPlace = BD_PLACE_RE.test(t), hasLandmark = ADDRESS_LANDMARK_RE.test(t);
  if (t.length >= 10 && hasPlace && (hasLandmark || parts.length >= 2 || hadPhone)) return cleanAddress(t);
  if (t.length >= 12 && hasLandmark && (parts.length >= 2 || /[0-9০-৯]/.test(t))) return cleanAddress(t);
  return null;
}
function identifyOrderedProduct(senderId, text) {
  const topic = resolveConversationTopic(text, senderId);
  if (topic.product) return topic.product;
  if (topic.categoryProducts.length > 1) return null; // ambiguous category: the bot asks which one
  const matches = findRelevantProducts(text);
  if (matches.length === 1) return matches[0];
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
  ensureCustomer(id);
  Object.assign(db.customers[id],{isPaused:on,takeover:on,takeoverUpdatedAt:timestamp});
  if(on)cancelFollowup(id); saveStorage(); return on;
}
function splitForMessenger(text, limit) {
  const parts = []; let rest = String(text);
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
// Messenger sends plain text, so Markdown links are converted before delivery (kept from v5).
// [https://x.com](https://x.com) -> https://x.com ; [Watch](https://x.com/v) -> Watch: https://x.com/v
function normalizeMessengerLinks(text = '') {
  return String(text || '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, (match, label, url) => {
      const cleanLabel = String(label || '').trim(), cleanUrl = String(url || '').trim();
      if (!cleanLabel || cleanLabel === cleanUrl) return cleanUrl;
      return `${cleanLabel}: ${cleanUrl}`;
    })
    .replace(/^\s*[-*]\s+(https?:\/\/\S+)\s*$/gim, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
async function sendFacebookMessage(recipientId, text) {
  if (evalCapture) { evalCapture.push({ to: recipientId, text: normalizeMessengerLinks(text) }); return true; }
  if(!PAGE_ACCESS_TOKEN){console.error('[Messenger] PAGE_ACCESS_TOKEN missing');return false;}
  const finalText=normalizeMessengerLinks(text); if(!finalText)return false;
  try {
    const url=`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
    // Long texts are split into several messages instead of being silently dropped.
    for (const part of splitForMessenger(finalText, MAX_MESSENGER_TEXT_LENGTH - 100)) {
      const response=await axios.post(url,{recipient:{id:recipientId},message:{text:part},messaging_type:'RESPONSE'},{timeout:15000});
      const isConfusion = /প্রশ্নটা বুঝতে সমস্যা|বুঝতে সমস্যা হচ্ছে|প্রশ্নটি বুঝতে পারিনি|কোন পণ্যের কথা হচ্ছে তা শনাক্ত করতে পারিনি|পণ্যের নাম\/মডেল বা ছবি পাঠান/i.test(String(part));
      if (!isConfusion) {
        appendHistory(recipientId,'assistant',part);
        addStoredMessage({id:'msg_bot_'+crypto.randomUUID(),senderId:recipientId,sender:'bot',text:part,timestamp:new Date().toISOString(),messageId:response.data?.message_id||null});
      }
    }
    saveStorage(); return true;
  } catch(err){console.error('[Messenger] Send error:',err.response?.data?.error?.message||err.message);return false;}
}
async function sendSenderAction(recipientId, action) {
  if (!PAGE_ACCESS_TOKEN || !recipientId) return false;
  try {
    await axios.post(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, { recipient: { id: recipientId }, sender_action: action }, { timeout: 8000 });
    return true;
  } catch (_) { return false; }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Answer every customer message REPLY_DELAY_MS (default 5 s) after it was received. Shows "typing..." while waiting.
async function waitBeforeReply(senderId, receivedAt) {
  const remaining = Number(receivedAt || Date.now()) + REPLY_DELAY_MS - Date.now();
  if (remaining <= 0) return;
  sendSenderAction(senderId, 'typing_on').catch(() => {});
  await sleep(remaining);
}
function enqueueCustomerTask(senderId, fn) {
  const previous = customerQueues.get(senderId) || Promise.resolve();
  const task = previous.catch(() => {}).then(fn);
  customerQueues.set(senderId, task);
  task.catch(e => console.error('[Webhook] Customer task failed:', e.message))
    .finally(() => { if (customerQueues.get(senderId) === task) customerQueues.delete(senderId); });
  return task;
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
  db.orders.push(order); ensureCustomer(id);
  db.customers[id].lastOrderId=order.id;db.customers[id].lastOrderAt=order.createdAt;db.customers[id].phone=order.customerPhone;db.customers[id].address=order.customerAddress;cancelFollowup(id);saveStorage();return {order,created:true};
}
async function handleOrderFlow(senderId, text, messageId) {
  const id = String(senderId), customer = ensureCustomer(id), old = db.orderDrafts[id] || {};
  const draft = { ...old, customerMessage: [old.customerMessage, text].filter(Boolean).join('\n').slice(-1000) };
  // Keep the product already chosen unless the customer explicitly names a different product/category.
  const found = identifyOrderedProduct(id, text);
  if (found && (!draft.product || findExactProduct(text) || getExplicitProductCategoryIntent(text))) draft.product = found;
  const phone = extractPhone(text); if (phone) { draft.phone = phone; customer.phone = phone; }
  let address = extractAddress(text);
  if (!address && draft.lastAskedField === 'address' && !phone) {
    // The bot just asked for the address: accept a plain reply (e.g. "মিরপুর, ঢাকা") that is not a question.
    const plain = stripPhones(text);
    if (plain.length >= 8 && !looksLikeQuestion(plain)) address = cleanAddress(plain);
  }
  if (address) { draft.address = address; customer.address = address; }
  const quantity = extractQuantity(stripPhones(text)); if (quantity) draft.quantity = quantity;
  if (!draft.product) {
    db.orderDrafts[id] = draft;
    const choices = resolveConversationTopic(text, id).categoryProducts;
    const list = choices.length ? '\n' + choices.map((p, i) => `${i + 1}. ${p.name}`).join('\n') : '';
    if (draft.lastAskedField !== 'product') { draft.lastAskedField = 'product'; saveStorage(); await sendFacebookMessage(id, `আপনি কোন পণ্যটি অর্ডার করতে চান? পণ্যের সঠিক নাম বা মডেলটি লিখুন।${list}`); }
    else { saveStorage(); await sendFacebookMessage(id, 'পণ্যের নাম/মডেল জানালে অর্ডারটি এগিয়ে নিতে পারব। চাইলে অর্ডার না করেও পণ্য সম্পর্কে প্রশ্ন করতে পারেন।'); }
    return true;
  }
  if (!draft.phone) {
    db.orderDrafts[id] = draft;
    if (draft.lastAskedField !== 'phone') { draft.lastAskedField = 'phone'; saveStorage(); await sendFacebookMessage(id, `${draft.product.name} অর্ডারের জন্য আপনার সচল মোবাইল নম্বরটি দিন।`); }
    else { saveStorage(); await sendFacebookMessage(id, 'অর্ডার চালিয়ে যেতে চাইলে আপনার সচল মোবাইল নম্বরটি পাঠাতে পারেন।'); }
    return true;
  }
  if (!draft.address) {
    db.orderDrafts[id] = draft;
    if (draft.lastAskedField !== 'address') { draft.lastAskedField = 'address'; saveStorage(); await sendFacebookMessage(id, 'ডেলিভারির সম্পূর্ণ ঠিকানা লিখুন—এলাকা/গ্রাম, থানা/উপজেলা ও জেলা সহ।'); }
    else { saveStorage(); await sendFacebookMessage(id, 'অর্ডার চালিয়ে যেতে চাইলে ডেলিভারির সম্পূর্ণ ঠিকানা পাঠাতে পারেন।'); }
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
  const sent=await sendFacebookMessage(id,buildFollowupText(id));task.status=sent?'SENT':'FAILED';task.sentAt=new Date().toISOString();saveStorage();
}
function restoreFollowupTasks(){for(const [id,t] of Object.entries(db.scheduledFollowups)){if(!t||t.status!=='PENDING')continue;if(getTakeoverState(id)||customerHasOrder(id)){delete db.scheduledFollowups[id];continue;}armFollowupTimer(id);}saveStorage();}

// -----------------------------------------------------------------------------
// Catalog sync: admin app -> this server -> GitHub, and GitHub -> this server (auto refresh)
// -----------------------------------------------------------------------------
// options.exact = true: use `data` exactly as given (GitHub is the source of truth). Otherwise merge by CATALOG_SYNC_MODE rules.
function replaceCatalogAtomically(data, source = 'admin', options = {}) {
  const current = getCatalogSnapshot();
  let normalized;
  if (options.exact) {
    validateCatalogShape(data);
    if (!data.products.length && current.products.length && data.replaceAll !== true) throw new Error('Refusing to replace the catalog with an empty product list');
    normalized = { ...data, faqs: Array.isArray(data.faqs) ? data.faqs : current.faqs, version: data.version ?? Date.now(), updatedAt: data.updatedAt ?? new Date().toISOString() };
    delete normalized.replaceAll; delete normalized.deleteProductIds; delete normalized.fullSync;
  } else {
    normalized = mergeCatalogData(current, data);
  }
  saveLocalCatalog(normalized, source);
  return normalized;
}
async function withCatalogLock(fn) {
  catalogSyncInProgress = true;
  try { return await fn(); } finally { catalogSyncInProgress = false; }
}
async function pullCatalogFromGitHub(force = false) {
  if(!GITHUB_TOKEN){catalogMeta.lastSyncError='GITHUB_TOKEN is not configured';return false;}
  if(!force && catalogSyncInProgress)return true;
  try {
    const url=`https://api.github.com/repos/${GITHUB_REPO}/contents/${CATALOG_FILE}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
    const baseHeaders={Authorization:`Bearer ${GITHUB_TOKEN}`,Accept:'application/vnd.github+json','User-Agent':'Impotech-Admin-Server'};
    const headers={...baseHeaders};
    if(!force&&catalogEtag)headers['If-None-Match']=catalogEtag; // 304 responses are free and do not count toward rate limits
    const r=await axios.get(url,{headers,timeout:15000,validateStatus:s=>(s>=200&&s<300)||s===304});
    catalogMeta.lastPullAt=new Date().toISOString();
    if(r.status===304){catalogMeta.lastSyncError=null;return true;}
    if(!force&&r.data?.sha&&r.data.sha===lastCatalogSha){catalogEtag=r.headers?.etag||catalogEtag;catalogMeta.lastSyncError=null;return true;}
    let text=r.data?.content?Buffer.from(r.data.content,'base64').toString('utf8'):null;
    if(!text){ // files over 1 MB are not inlined by the GitHub contents API: fetch the raw file instead
      const raw=await axios.get(url,{headers:{...baseHeaders,Accept:'application/vnd.github.raw+json'},timeout:20000,responseType:'text',transformResponse:x=>x});
      text=typeof raw.data==='string'?raw.data:JSON.stringify(raw.data);
    }
    if(!text)throw new Error('GitHub response contains no file content');
    const parsed=JSON.parse(text);
    replaceCatalogAtomically(parsed,'github',{exact:true});
    lastCatalogSha=r.data?.sha||null;catalogEtag=r.headers?.etag||null;catalogMeta.lastSyncError=null;
    console.log(`[CATALOG] Updated from GitHub: ${products.length} products, ${faqs.length} FAQs`);
    return true;
  }catch(err){catalogMeta.lastSyncError=err.response?.data?.message||err.message;console.error('[GITHUB] Pull failed:',catalogMeta.lastSyncError);return false;}
}
async function pushCatalogToGitHub(data,customToken,customRepo,customBranch,customPath,options={}) {
  const token=customToken||GITHUB_TOKEN,repo=customRepo||GITHUB_REPO,branch=customBranch||GITHUB_BRANCH,filePath=customPath||CATALOG_FILE;
  if(!token)return {synced:false,message:'GitHub Token is not configured'};
  let safeData;
  try {
    if (options.exact) { validateCatalogShape(data); safeData = { ...data }; }
    else { safeData = mergeCatalogData(getCatalogSnapshot(), data); validateCatalogShape(safeData); }
  } catch(e) { return {synced:false,error:e.message}; }
  const url=`https://api.github.com/repos/${repo}/contents/${filePath}`,headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','User-Agent':'Impotech-Admin-Server'};let sha=null;
  try{const r=await axios.get(`${url}?ref=${encodeURIComponent(branch)}`,{headers,timeout:10000});sha=r.data?.sha||null;}catch(e){if(e.response?.status!==404)return {synced:false,error:e.response?.data?.message||e.message};}
  const payload={message:`Update Impotech catalog ${safeData.version||Date.now()}`,content:Buffer.from(JSON.stringify(safeData,null,2),'utf8').toString('base64'),branch};if(sha)payload.sha=sha;
  try{
    const r=await axios.put(url,payload,{headers,timeout:20000});
    replaceCatalogAtomically(safeData,'github',{exact:true});
    if(repo===GITHUB_REPO&&branch===GITHUB_BRANCH&&filePath===CATALOG_FILE){lastCatalogSha=r.data?.content?.sha||lastCatalogSha;catalogEtag=null;}
    return {synced:true,commit:r.data?.commit?.sha||'synced',totalProducts:products.length,totalFaqs:faqs.length};
  }catch(e){return {synced:false,error:e.response?.data?.message||e.message};}
}
// Saves an exact catalog (used by the single product / FAQ endpoints): memory + local file immediately, GitHub right after.
async function commitCatalogChange(nextCatalog) {
  return withCatalogLock(async () => {
    const next = { ...nextCatalog, version: Date.now(), updatedAt: new Date().toISOString() };
    validateCatalogShape(next);
    saveLocalCatalog(next, 'admin');
    let gh = { synced: false };
    if (GITHUB_TOKEN) { gh = await pushCatalogToGitHub(next, undefined, undefined, undefined, undefined, { exact: true }); catalogDirty = !gh.synced; }
    return gh;
  });
}
// Polls GitHub so products/FAQs edited outside this server (or on another instance) reach the bot automatically.
function startCatalogAutoRefresh() {
  if (!GITHUB_TOKEN || CATALOG_REFRESH_INTERVAL_MS <= 0) { console.log('[CATALOG] Auto refresh disabled'); return; }
  const timer = setInterval(async () => {
    if (catalogSyncInProgress) return;
    try {
      if (catalogDirty) { // an admin change is not on GitHub yet: push it first, never overwrite it with an older GitHub copy
        const gh = await withCatalogLock(() => pushCatalogToGitHub(getCatalogSnapshot(), undefined, undefined, undefined, undefined, { exact: true }));
        if (gh.synced) catalogDirty = false;
        return;
      }
      await pullCatalogFromGitHub(false);
    } catch (e) { console.error('[CATALOG] Auto refresh failed:', e.message); }
  }, CATALOG_REFRESH_INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log(`[CATALOG] Auto refresh every ${Math.round(CATALOG_REFRESH_INTERVAL_MS / 1000)}s (mode: ${CATALOG_SYNC_MODE})`);
}

// -----------------------------------------------------------------------------
// AI prompt and OpenRouter
// -----------------------------------------------------------------------------
function buildSystemPromptBase(relevantProducts, relevantFaqs, history, memoryContext, topicContext) {
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
৪) ক্যাটালগ-ভিত্তিক তথ্য: পণ্যের নাম, দাম, স্টক, বৈশিষ্ট্য, ওয়ারেন্টি বা স্পেসিফিকেশন বানিয়ে বলবে না। নিচে দেওয়া “প্রাসঙ্গিক পণ্য” ও “FAQ” অংশই সর্বশেষ ও সঠিক তথ্য। কথোপকথনের ইতিহাসে বা মেমোরিতে আগে বলা দাম, স্টক, অফার, ওয়ারেন্টি বা বিবরণ নিচের ক্যাটালগের সাথে না মিললে ক্যাটালগের তথ্যই সঠিক; পুরোনো তথ্য কখনো পুনরাবৃত্তি করবে না। ক্যাটালগে থাকা ছবি, Facebook Reel বা ভিডিওর সঠিক URL হুবহু দেবে; URL বানাবে বা বদলাবে না। গ্রাহক আলো/কোয়ালিটি/দেখতে কেমন জানতে চাইলে ক্যাটালগে ভিডিও বা ছবির লিংক থাকলে আগে সেটি দেবে। তথ্য না থাকলে স্পষ্টভাবে বলবে যে ক্যাটালগে তথ্যটি নেই।
৫) হেডলাইট/বাইক/গাড়ি ফিটমেন্ট: প্রথমে কোডে থাকা VEHICLE_FITMENT_DATA তালিকায় গ্রাহকের উল্লেখ করা সঠিক মডেল মিলিয়ে দেখবে। মিল পাওয়া গেলে শুধু সেই রেকর্ডের years/socket/fitment এবং DC Conversion Required তথ্য অনুযায়ী উত্তর দেবে; AC-to-DC conversion প্রয়োজন থাকলে স্পষ্ট বলবে। মডেল তালিকায় না থাকলে অনুমান করবে না; উত্তর হবে: “${VEHICLE_FITMENT_HANDOFF_REPLY}”।
৬) মেমোরি ও প্রসঙ্গ (সবচেয়ে গুরুত্বপূর্ণ): সাধারণ text follow-up-এ নিচের “বর্তমান আলোচ্য বিষয়” ধরে উত্তর দেবে। গ্রাহক নতুন পণ্যের নাম লিখলে সেই পণ্য ধরবে। গ্রাহক নতুন ছবি পাঠালে ছবিটি বর্তমান পণ্যের পরিচয় যাচাই/পরিবর্তনের প্রধান উৎস; পুরোনো active product বা আগের বটের অনুমান দিয়ে নতুন ছবিকে শ্রেণিবদ্ধ করবে না। “এটা”, “ওটা”, “দাম কত”, “ছবিটা” ইত্যাদির ক্ষেত্রে প্রয়োজনমতো ইতিহাস ও মেমোরি ব্যবহার করবে, কিন্তু নতুন সংযুক্ত ছবি পুরোনো প্রসঙ্গের চেয়ে অগ্রাধিকার পাবে। একই তথ্য অকারণে আবার চাইবে না।
৭) মানব প্রতিনিধি: সাধারণ প্রশ্নের উত্তর নিজে দেবে। অন্য সমস্যা সমাধান করা সম্ভব না হলে সম্মতি চাইবে; সম্মতি ছাড়া সাধারণ প্রশ্নে takeover চালু করবে না। ${HANDOVER_MARKER} নিজে থেকে লিখবে না।
৮) ভাষা ও দৈর্ঘ্য: গ্রাহক যে ভাষায় লিখবে—বাংলা, English বা Banglish—সেই ভাষায় স্বাভাবিক, সরাসরি ও সংক্ষিপ্ত উত্তর দেবে। সর্বোচ্চ ৪–৫টি ছোট লাইন; অপ্রয়োজনীয় ভূমিকা বা একই কথা পুনরাবৃত্তি নয়।

বর্তমান আলোচ্য বিষয়:
${topicContext}

গ্রাহক মেমোরি:
${memoryContext}

প্রাসঙ্গিক পণ্য (সর্বশেষ ক্যাটালগ):
${productContext}

FAQ (সর্বশেষ):
${faqContext}

কথোপকথন:
${historyContext}`;
}
function trimToSentence(text) {
  const idx = Math.max(text.lastIndexOf('।'), text.lastIndexOf('.'), text.lastIndexOf('?'), text.lastIndexOf('!'), text.lastIndexOf('\n'));
  return idx > 20 ? text.slice(0, idx + 1).trim() : text;
}
async function callOpenRouter(messages, model = TEXT_MODEL, options = {}) {
  if(!OPENROUTER_API_KEY)throw new Error('OPENROUTER_API_KEY is not configured');
  console.log('[OpenRouter] Request started', { model, messageCount: messages.length });
  try {
    let r;
    for (let attempt = 1; ; attempt++) {
      try {
        r=await axios.post(OPENROUTER_URL,{model,messages,max_tokens:options.maxTokens||MAX_OUTPUT_TOKENS,temperature:options.temperature??0.2},{headers:{Authorization:`Bearer ${OPENROUTER_API_KEY}`,'Content-Type':'application/json','HTTP-Referer':'https://github.com/impotechaibot/Impotech-bot','X-Title':'ImpoTech Messenger AI Bot'},timeout:45000,maxContentLength:MAX_ATTACHMENT_BYTES,maxBodyLength:MAX_ATTACHMENT_BYTES});
        break;
      } catch (err) {
        const status = err.response?.status;
        const transient = status === 429 || (status >= 500 && status <= 599) || ['ECONNABORTED','ETIMEDOUT','ECONNRESET'].includes(err.code);
        if (!transient || attempt >= 3) throw err;
        await new Promise(res => setTimeout(res, 1500 * attempt)); // 1.5 s, then 3 s
      }
    }
    const choice=r.data?.choices?.[0];if(!choice)throw new Error('OpenRouter returned no response');
    let reply=choice.message?.content;if(Array.isArray(reply))reply=reply.map(x=>x?.text||'').join('');
    reply=String(reply||'').normalize('NFKC').trim();
    if(!reply)throw new Error('AI response empty');
    if(choice.finish_reason==='length'&&!options.allowTruncated){
      // A long answer is cut at the last complete sentence instead of failing the whole reply.
      reply=trimToSentence(reply);
      if(reply.length<15)throw new Error('AI response truncated');
    }
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

// ---- Voice: transcribe first, then run the transcript through the normal pipeline (price, photo, order, memory...) ----
function detectAudioFormat(buffer, contentType = '', url = '') {
  const head = buffer.subarray(0, 12), ascii = head.toString('latin1');
  if (ascii.slice(4, 8) === 'ftyp') return 'm4a';          // Messenger voice clips are MP4/AAC containers
  if (ascii.startsWith('OggS')) return 'ogg';
  if (ascii.startsWith('RIFF')) return 'wav';
  if (ascii.startsWith('fLaC')) return 'flac';
  if (ascii.startsWith('ID3')) return 'mp3';
  if (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) return (head[1] & 0x06) === 0 ? 'aac' : 'mp3';
  const mime = String(contentType).split(';')[0].trim().toLowerCase();
  const byMime = { 'audio/mpeg':'mp3','audio/mp3':'mp3','audio/mp4':'m4a','audio/x-m4a':'m4a','audio/m4a':'m4a','video/mp4':'m4a','audio/aac':'aac','audio/x-aac':'aac','audio/ogg':'ogg','audio/opus':'ogg','audio/wav':'wav','audio/x-wav':'wav','audio/flac':'flac','audio/aiff':'aiff' };
  if (byMime[mime]) return byMime[mime];
  const ext = ((String(url).split('?')[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1] || '').toLowerCase();
  if (['mp3','wav','aac','ogg','flac','m4a','aiff'].includes(ext)) return ext;
  return 'm4a';
}
function cleanTranscript(raw) {
  const t = String(raw || '').normalize('NFKC').replace(/^["“”'`]+|["“”'`]+$/g, '').trim();
  if (!t || t.length < 2 || /UNINTELLIGIBLE/i.test(t)) return null;
  return t.slice(0, 900);
}
async function transcribeAudioOpenRouter(url) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: MAX_ATTACHMENT_BYTES });
  const buffer = Buffer.from(r.data);
  if (!buffer.length) throw new Error('Empty audio file');
  const base64 = buffer.toString('base64');
  const detected = detectAudioFormat(buffer, r.headers?.['content-type'], url);
  const formats = [detected, ...['m4a', 'mp3', 'aac', 'wav'].filter(f => f !== detected)].slice(0, 3);
  let lastError;
  for (const format of formats) {
    try {
      const raw = await callOpenRouter([
        { role: 'system', content: 'You are an accurate speech-to-text transcriber for customers in Bangladesh. The audio is usually Bangla (Bengali), sometimes English or mixed Banglish. Write exactly what the speaker says, in Bangla script (keep English product names and model numbers in English letters; write numbers and phone digits as digits). Output ONLY the transcript, with no explanation and no answer. If the audio is silent or impossible to understand, output exactly: UNINTELLIGIBLE' },
        { role: 'user', content: [{ type: 'text', text: 'এই ভয়েস মেসেজটি হুবহু লিখে দিন।' }, { type: 'input_audio', input_audio: { data: base64, format } }] }
      ], VOICE_MODEL, { maxTokens: TRANSCRIPTION_MAX_TOKENS, temperature: 0, allowTruncated: true });
      return cleanTranscript(raw);
    } catch (e) {
      lastError = e;
      const status = e.response?.status;
      if (status !== 400 && status !== 415 && status !== 422) break; // only a format problem is worth retrying with another format
    }
  }
  throw lastError || new Error('Voice transcription failed');
}

async function generateAIResponse(customerText, attachments = [], senderId, incomingMessageId = null) {
  const query = customerText || 'গ্রাহক একটি ছবি/ফাইল পাঠিয়েছেন। ছবিকে নতুন ইনপুট হিসেবে দেখে পণ্য শনাক্ত করে সাহায্য করুন।';
  const imageAttachments = attachments.filter(x => x.type === 'image' && x.payload?.url).slice(0, 4);
  const hasIncomingImages = imageAttachments.length > 0;

  // Download the current images before building topic context. A new customer image has
  // priority over the previous active product; otherwise old context can bias vision.
  const imageParts = [];
  for (let i = 0; i < imageAttachments.length; i++) {
    try {
      const r = await axios.get(imageAttachments[i].payload.url, {
        responseType: 'arraybuffer', timeout: 18000, maxContentLength: MAX_ATTACHMENT_BYTES
      });
      const contentType = String(r.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
      if (!contentType.startsWith('image/')) {
        console.warn('[VISION] Attachment is not an image', { index: i, contentType });
        continue;
      }
      imageParts.push({ type: 'text', text: `বর্তমান মেসেজের গ্রাহকের ছবি ${i + 1}:` });
      imageParts.push({ type: 'image_url', image_url: { url: `data:${contentType};base64,${Buffer.from(r.data).toString('base64')}` } });
    } catch (e) {
      console.error('[VISION] Failed to fetch image', { index: i, message: e.response?.status || e.message });
    }
  }
  const hasImages = imageParts.some(part => part.type === 'image_url');

  let history = getHistory(senderId).slice();
  if (history.length && history[history.length - 1].role === 'user' && history[history.length - 1].text === query) history.pop();
  if (hasIncomingImages && history.length && history[history.length - 1].role === 'user' && /^\[(?:ছবি পাঠানো হয়েছে|Media File)/i.test(history[history.length - 1].text)) history.pop();
  // If the incoming message contains an image, do not pass an old active-product claim as
  // the selected topic. Keep useful customer context, but remove earlier assistant product
  // claims so a previous visual misclassification cannot bias the new image.
  const topic = hasImages
    ? { product: null, categoryProducts: [], category: null, explicit: true }
    : resolveConversationTopic(query, senderId);
  let memory = buildCustomerMemoryContext(senderId);
  if (hasImages) {
    memory = memory
      .replace(/^বর্তমান আলোচনার পণ্য:.*(?:\n|$)/gm, '')
      .replace(/^বর্তমান আলোচনার ক্যাটাগরি:.*(?:\n|$)/gm, '')
      .trim();
  }
  const context = getRecentConversationText(senderId, query);
  let relevantProducts;
  if (hasImages) {
    // The prior product must not be the only product offered to vision. The complete compact
    // catalog index below is used for visual matching instead.
    relevantProducts = [];
  } else {
    relevantProducts = topic.product ? [topic.product]
      : topic.categoryProducts.length ? topic.categoryProducts.slice(0, MAX_PRODUCTS_TO_AI)
      : findRelevantProducts(query);
    if (!relevantProducts.length) relevantProducts = findRelevantProducts(context);
  }
  let relevantFaqs = findRelevantFaqs(query);
  if (!relevantFaqs.length && !hasImages) relevantFaqs = findRelevantFaqs(context);

  const promptHistory = hasImages
    ? history.filter(item => {
        if (item.role !== 'assistant') return true;
        const replyText = normalizeText(item.text);
        return !products.some(p => {
          const name = normalizeText(p.name || '');
          return name.length >= 5 && replyText.includes(name);
        });
      })
    : history;
  const topicContext = hasImages
    ? 'সর্বশেষ মেসেজে নতুন ছবি এসেছে। এই ছবিই বর্তমান পণ্য শনাক্তকরণের প্রধান উৎস; আগের active product বা আগের বটের অনুমানকে বর্তমান ছবির পরিচয় হিসেবে ধরবেন না।'
    : topic.product
      ? `বর্তমান আলোচ্য পণ্য: ${topic.product.name} (ID: ${topic.product.id})${topic.category ? `; ক্যাটাগরি: ${getCategoryLabel(topic.category)}` : ''}`
      : topic.category
        ? `বর্তমান আলোচ্য ক্যাটাগরি: ${getCategoryLabel(topic.category)} (নির্দিষ্ট মডেল এখনো ঠিক হয়নি)`
        : 'নির্দিষ্ট কোনো পণ্য বা ক্যাটাগরি এখনো শনাক্ত হয়নি।';

  // Keep the catalog JSON complete; slicing a JSON string at an arbitrary character can
  // cut off later products or corrupt the candidate list. Descriptions are deliberately compact.
  const catalogChoices = products.map(p => ({
    id: String(p.id),
    name: String(p.name || ''),
    category: String(p.category || ''),
    brand: String(p.brand || ''),
    model: String(p.model || ''),
    price: p.price ?? null,
    aliases: Array.isArray(p.aliases) ? p.aliases.slice(0, 12) : [],
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 8) : [],
    keywords: Array.isArray(p.keywords) ? p.keywords.slice(0, 12) : [],
    description: String(p.shortDescription || p.description || '').slice(0, 180),
    features: Array.isArray(p.features) ? p.features.slice(0, 5) : []
  }));
  const catalogChoicesText = JSON.stringify(catalogChoices);
  const systemBase = buildSystemPrompt(relevantProducts, relevantFaqs, promptHistory, memory, topicContext, null);
  const visualPriorityRule = hasImages ? `

বিশেষ নিয়ম—সর্বশেষ ছবিকে অগ্রাধিকার:
- এই মেসেজের ছবিই এখনকার পণ্য নির্ধারণের প্রধান প্রমাণ। আগের active product, আগের উত্তরে বলা পণ্য, বা আগের ছবির বর্ণনা দেখে বর্তমান ছবিকে পুরোনো পণ্য বলবেন না।
- ছবিতে আগের পণ্যের চেয়ে অন্য পণ্য দেখা গেলে LIVE catalog থেকে নতুন পণ্যটির ID দিন; কোড সেটি যাচাই করে active product আপডেট করবে।
- শুধু দেখতে বাইক-লাইটের মতো হলেই H4 LED Mini Projector/Headlight বলবেন না। ডান/বাম ডানা, feather/wing আকৃতি, রং, অবস্থান এবং পণ্যের দৃশ্যমান ধরন মিলিয়ে ক্যাটালগের সঙ্গে তুলনা করুন।
- ছবি যদি Angel Wings Light-এর মতো ডানা-আকৃতির accessory দেখায়, শুধু আগের হেডলাইট প্রসঙ্গের কারণে সেটিকে হেডলাইট বলবেন না। একইভাবে ছবিতে যা নেই এমন Devil Eye/DRL/Projector feature অনুমান করবেন না।
- "productId" হবে নিচের LIVE catalog থেকে মিল পাওয়া একটিমাত্র ID। নির্ভরযোগ্য মিল না পেলে null দিন; ভুল ID অনুমান করবেন না। "imageDescription"-এ ছবির দৃশ্যমান বস্তু/রং/আকৃতি লিখুন।
- গ্রাহক শুধু “কি”, “এটা কী”, “এইটা কী আছে” বললেও ছবিটিকে বর্ণনা করে সঠিক ক্যাটালগ পণ্য শনাক্ত করুন; অকারণে আগের পণ্যের বর্ণনা পুনরাবৃত্তি বা অর্ডারের প্রশ্ন করবেন না।` : '';
  const outputContract = `

আউটপুট ফরম্যাট বাধ্যতামূলক: বৈধ JSON object দিন, Markdown code fence নয়। ফিল্ড: "reply" (গ্রাহককে পাঠানোর সংক্ষিপ্ত উত্তর), "productId" (নিচের LIVE catalog product ID থেকে একটি string, না মিললে null), "imageDescription" (ছবিতে দৃশ্যমান বস্তু/রং/আকৃতি/লেখার সংক্ষিপ্ত বর্ণনা; ছবি না থাকলে খালি string), "confidence" (0 থেকে 1)। customer reply-তে JSON বা metadata দেখাবেন না। পণ্য নির্বাচন কেবল নিচের ক্যাটালগ থেকে করবেন; আন্দাজ করে ID বানাবেন না।
LIVE catalog choices: ${catalogChoicesText}
বর্তমান পণ্য থাকলে সাধারণ text follow-up-এ সেটিই রাখুন। তবে নতুন ছবি এলে ছবিকে অগ্রাধিকার দিন: ছবিতে নতুন পণ্য ক্যাটালগে মিলে গেলে সেটিই নির্বাচন করুন এবং আগের পণ্যকে ধরে রাখবেন না। গ্রাহক যদি শুধু রং জিজ্ঞেস করেন এবং নতুন ছবি না থাকে, বর্তমান পণ্য ধরে উত্তর দিন। ছবি বুঝতে না পারলে মিথ্যা শনাক্তকরণ করবেন না।${visualPriorityRule}`;
  const system = systemBase + outputContract;

  const prior = promptHistory.map(x => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: x.text }));
  let userContent;
  if (hasImages) {
    userContent = [{
      type: 'text',
      text: `বর্তমান গ্রাহক বার্তা: ${query}\nএখন সংযুক্ত নতুন ছবিগুলো দেখুন। আগের ছবি বা আগের পণ্যের নামকে বর্তমান ছবির পরিচয় ধরে নেবেন না। ছবিতে দৃশ্যমান বস্তু/আকৃতি/রং এবং LIVE catalog choices মিলিয়ে পণ্য শনাক্ত করুন।`
    }, ...imageParts];
  } else {
    userContent = query;
  }

  // One OpenRouter call per AI response; existing text, vision, and voice flows are retained.
  const raw = await callOpenRouter(
    [{ role: 'system', content: system }, ...prior, { role: 'user', content: userContent }],
    TEXT_MODEL,
    { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.1 }
  );
  let parsed = null;
  try {
    const trimmed = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try { parsed = JSON.parse(trimmed); }
    catch (_) {
      const candidate = trimmed.match(/\{[\s\S]*\}/)?.[0];
      if (candidate) parsed = JSON.parse(candidate);
    }
  } catch (e) {
    console.warn('[AI] Structured output parse failed; using plain response.');
  }

  const reply = String(parsed?.reply || raw).trim();
  const imageDescription = String(parsed?.imageDescription || '').trim().slice(0, 500);
  const selectedId = parsed?.productId == null ? '' : String(parsed.productId);
  let selectedProduct = selectedId ? products.find(p => String(p.id) === selectedId) : null;
  const previousActive = findActiveProduct(senderId);

  // Fallback only when the answer names one exact catalog product different from the old topic.
  // This allows a clearly named new product to switch, but avoids syncing an old hallucinated name
  // back over a different product selected from the current image.
  if (hasImages && !selectedProduct) {
    const mentioned = findExactProduct(reply);
    if (mentioned && (!previousActive || String(mentioned.id) !== String(previousActive.id))) {
      selectedProduct = mentioned;
    }
  }

  if (selectedProduct) {
    // A newly attached image is an explicit context boundary; catalog-validated selection wins
    // even if a previous activeProductId already exists.
    if (hasImages || !previousActive || String(previousActive.id) !== String(selectedProduct.id)) {
      rememberActiveProduct(senderId, selectedProduct);
    }
  } else if (!hasImages) {
    const exact = findExactProduct(query);
    if (exact) rememberActiveProduct(senderId, exact);
  } else {
    // Do not let a stale product silently remain active after a new image failed to match.
    // The visual description is still saved below so a later follow-up retains the image context.
    clearActiveProduct(senderId);
    const c = ensureCustomer(senderId);
    delete c.activeCategory;
    delete c.activeCategoryUpdatedAt;
    saveStorage();
  }

  // Store image description + catalog match in the current user-history entry and durable DB
  // record even when the customer attached a caption. The previous code only replaced entries
  // whose text was exactly a media placeholder, so captioned images were not remembered.
  if (hasImages) {
    const selectedSummary = selectedProduct
      ? `শনাক্ত পণ্য: ${selectedProduct.name} | ID: ${selectedProduct.id}`
      : 'ক্যাটালগ পণ্য নিশ্চিতভাবে শনাক্ত হয়নি';
    const persistedDescription = imageDescription || (selectedProduct
      ? `ক্যাটালগে ${selectedProduct.name} পণ্যের সঙ্গে মিল পাওয়া গেছে; ছবির বিস্তারিত বর্ণনা পাওয়া যায়নি।`
      : 'ছবি বিশ্লেষণ করা হয়েছে, কিন্তু ক্যাটালগে নির্ভরযোগ্য পণ্য-মিল পাওয়া যায়নি।');
    const messageSummary = `[নতুন ছবির বর্ণনা: ${persistedDescription}] [${selectedSummary}]${query && query !== '[Media File]' ? ` [গ্রাহকের বার্তা: ${query}]` : ''}`;

    const currentHistory = getHistory(senderId);
    for (let i = currentHistory.length - 1; i >= 0; i--) {
      if (currentHistory[i].role === 'user') {
        currentHistory[i].text = messageSummary;
        break;
      }
    }

    let latest = null;
    if (incomingMessageId) {
      latest = [...db.messages].reverse().find(m => String(m.senderId) === String(senderId) && m.sender === 'customer' && String(m.messageId || '') === String(incomingMessageId));
    }
    if (!latest) {
      latest = [...db.messages].reverse().find(m => String(m.senderId) === String(senderId) && m.sender === 'customer' && Date.now() - new Date(m.timestamp || 0).getTime() < 120000);
    }
    if (latest) {
      latest.text = messageSummary;
      if (pool) pool.query('UPDATE impotech_messages SET text=$1 WHERE id=$2', [latest.text, latest.id])
        .catch(e => console.error('[DB] Image-description history update failed:', e.message));
    }

    const customer = ensureCustomer(senderId);
    customer.lastImageDescription = persistedDescription;
    customer.lastImageProductId = selectedProduct ? String(selectedProduct.id) : null;
    customer.lastImageUpdatedAt = new Date().toISOString();
    const mem = getCustomerMemory(senderId);
    addUniqueMemoryItem(mem.facts, `সর্বশেষ ছবির বর্ণনা: ${persistedDescription}`, 15);
    if (selectedProduct) addUniqueMemoryItem(mem.facts, `সর্বশেষ ছবিতে শনাক্ত পণ্য: ${selectedProduct.name} (ID: ${selectedProduct.id})`, 15);
    mem.updatedAt = new Date().toISOString();
    customer.lastMemoryUpdatedAt = mem.updatedAt;
    saveStorage();
  }
  return limitToFiveLines(reply);
}
function isCriticalHandoverQuestion(text='') { return /প্রতারণা|fraud|scam|আইনগত ব্যবস্থা|legal action|মামলা|মারাত্মক দুর্ঘটনা|serious injury|আগুন লেগেছে|fire hazard|ব্যাটারি বিস্ফোরণ|battery exploded|চার্জে আগুন|payment deducted twice|দুইবার টাকা কাটা|ভুল পেমেন্ট|টাকা কেটে নিয়েছে/i.test(String(text || '').normalize('NFKC')); }
function isConfusionReply(text='') { return /^(হ্যাঁ|হ্যা|জি|জ্বি|রাজি|সম্মতি|ঠিক আছে|yes|yeah|y|ok|okay|sure|না|no|nope|n)$/i.test(normalizeText(text)); }

// -----------------------------------------------------------------------------
// Main message flow
// Order: handover consent -> order refusal -> critical issue -> quick answers (photo/video, "আলো কেমন",
// FAQ, fitment, delivery, bill, price) -> order flow -> AI. Everything uses the same current topic.
// -----------------------------------------------------------------------------
async function processCustomerMessage(senderId,text,attachments=[],messageId=null) {
  const id=String(senderId), customerText=String(text||'').normalize('NFKC').trim();
  if(getTakeoverState(id)){console.log(`[Takeover] ${id} paused; AI skipped`);return;}
  try {
    const incomingUrls = extractUrls(customerText);
    const linkedProducts = [...new Map(incomingUrls.map(url => catalogProductForUrl(url)).filter(Boolean).map(product => [String(product.id), product])).values()];
    if (linkedProducts.length === 1) rememberActiveProduct(id, linkedProducts[0]);
    // Explicit product / category names switch the topic; generic follow-ups keep the current one.
    resolveConversationTopic(customerText, id);

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
    if(isCriticalHandoverQuestion(customerText)){await askHandoverConsent(id,'Critical customer issue');return;}

    const inDraft = Boolean(db.orderDrafts[id]);
    const orderIntent = isExplicitOrderIntent(customerText);
    const enteringOrderDetails = inDraft && Boolean(extractPhone(customerText) || extractAddress(customerText));
    if (!enteringOrderDetails) {
      // 1) Explicit photo / video request: always for the CURRENT product/category.
      const hasIncomingImage = attachments.some(x => x.type === 'image' && x.payload?.url);
      if (!hasIncomingImage && getMediaTypes(customerText).length) {
        const reply = getProductMediaReply(customerText, id);
        if (reply) { await sendFacebookMessage(id, limitToFiveLines(reply, 8)); markServed(id, resolveConversationTopic(customerText, id).product, getMediaTypes(customerText)); return; }
      }
      // 2) "লাইটের আলো কেমন হবে" / "ব্রাইট" / "দেখতে কেমন": show the video (else photo) of the current product.
      if (!hasIncomingImage && isLightQualityQuestion(customerText) && !alreadyServedMedia(id)) {
        const imageFirst = /দেখতে\s*কেমন|কেমন\s*দেখ/.test(normalizeText(customerText));
        const reply = getProductMediaReply(customerText, id, { implicitTypes: imageFirst ? ['images', 'videos'] : ['videos', 'images'] });
        if (reply) { await sendFacebookMessage(id, limitToFiveLines(reply, 8)); markServed(id, resolveConversationTopic(customerText, id).product, ['videos','images']); return; }
      }
      // 3) FAQ: sent verbatim only if it clearly matches and does not belong to another product/category.
      const matchedFaq = orderIntent ? null : findBestFaqMatch(customerText, id);
      if (matchedFaq) {
        const faqAnswer = String(matchedFaq.answer || '').trim();
        if (faqAnswer) {
          console.log(`[FAQ] Direct FAQ match for ${id}; category=${matchedFaq.category || 'unspecified'}`);
          await sendFacebookMessage(id, faqAnswer);
          syncActiveProductFromReply(id, faqAnswer, { allowSwitch: false });
          return;
        }
      }
      const hasFacebookLink = incomingUrls.some(url => /(^|\.)facebook\.com\//i.test(url) || /(^|\.)fb\.watch\//i.test(url));
      if (hasFacebookLink && !linkedProducts.length && !attachments.some(x => x.type === 'image' && x.payload?.url)) {
        await sendFacebookMessage(id, 'লিংকটি থেকে পণ্যটি নিশ্চিতভাবে শনাক্ত করতে পারিনি। অনুগ্রহ করে পণ্যের একটি স্ক্রিনশট বা সঠিক নাম/মডেল পাঠান।');
        return;
      }
      // 4) Vehicle fitment from the customer-provided motorcycle/car reference table (never guessed).
      const fitmentContext = [getRecentConversationText(id, customerText), db.customers[id]?.vehicleModelName || '', db.customers[id]?.activeProductName || ''].filter(Boolean).join('\n');
      if (isVehicleHeadlightFitmentInquiry(customerText, fitmentContext)) {
        const vehicle = getKnownVehicleCompatibility(id, customerText, fitmentContext);
        await sendFacebookMessage(id, buildVehicleFitmentReply(vehicle));
        return;
      }
      // 5) Delivery-charge questions are informational, not order intent; never request address/phone for them.
      if (/(?:ডেলিভারি|কুরিয়ার)\s*(?:চার্জ|খরচ)|delivery\s*charge|courier\s*(?:fee|charge)/i.test(customerText) && !/(?:সর্বমোট|মোট বিল|grand total|total bill|invoice)/i.test(customerText)) {
        const place = normalizeText(customerText);
        if (/গাজীপুরের\s*(?:ভেতরে|মধ্যে|ভিতরে)|inside\s*gazipur|within\s*gazipur/i.test(place)) await sendFacebookMessage(id, 'গাজীপুরের ভেতরে ডেলিভারি চার্জ ৫০ টাকা।');
        else if (/গাজীপুরের\s*(?:বাইরে)|outside\s*gazipur|outside\s*of\s*gazipur/i.test(place)) await sendFacebookMessage(id, 'গাজীপুরের বাইরে ডেলিভারি চার্জ ১০০ টাকা।');
        else await sendFacebookMessage(id, 'ডেলিভারি চার্জ গাজীপুরের ভেতরে ৫০ টাকা এবং গাজীপুরের বাইরে ১০০ টাকা।');
        return;
      }
      // 6) Smart billing from live catalog prices.
      if (isBillingQuestion(customerText)) {
        const context = getRecentConversationText(id, customerText), draft = db.orderDrafts[id] || {};
        const topic = resolveConversationTopic(customerText, id);
        const p = topic.product || draft.product || findExactProduct(context);
        if (p) {
          const quantity = extractQuantity(customerText) || Number(draft.quantity) || extractQuantity(context) || 1;
          const area = extractAddress(customerText) || (BD_PLACE_RE.test(customerText) ? customerText : '') || draft.address || db.customers[id]?.address || extractAddress(context) || '';
          await sendFacebookMessage(id, limitToFiveLines(buildSmartBillReply(p, quantity, getDeliveryFee(area))));
          return;
        }
        const list = topic.categoryProducts.length ? '\n' + topic.categoryProducts.map((x, i) => `${i + 1}. ${x.name}`).join('\n') : '';
        await sendFacebookMessage(id, `স্মার্ট বিল তৈরি করতে পণ্যের নাম/মডেল, কতটি নেবেন এবং ডেলিভারি এলাকা/জেলা লিখুন।${list}`);
        return;
      }
      // 7) Price from the live catalog for the current product/category.
      if (!orderIntent && isPriceQuestion(customerText)) {
        const topic = resolveConversationTopic(customerText, id);
        if (topic.product) {
          await sendFacebookMessage(id, getPriceReply(topic.product) || `দুঃখিত, ${topic.product.name}-এর দাম বর্তমানে ক্যাটালগে উল্লেখ নেই।`);
          return;
        }
        if (topic.categoryProducts.length) {
          const priceLines = topic.categoryProducts.slice(0, 3).map(item => getPriceReply(item) || `${item.name}-এর দাম ক্যাটালগে উল্লেখ নেই।`);
          await sendFacebookMessage(id, priceLines.join('\n'));
          return;
        }
        await sendFacebookMessage(id, topic.category ? 'এই ক্যাটাগরির নির্দিষ্ট পণ্য শনাক্ত করতে পারিনি। ক্যাটালগে একাধিক মডেল থাকলে পণ্যের ছবি বা মডেল পাঠান।' : 'কোন পণ্যের দাম জানতে চান? পণ্যের নাম/মডেল লিখুন বা পণ্যের ছবি পাঠান।');
        return;
      }
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
        const phone=extractPhone(customerText);if(phone)draft.phone=phone;
        const address=extractAddress(customerText);if(address)draft.address=address;
        const p=identifyOrderedProduct(id,customerText);if(p)draft.product=p;
        db.orderDrafts[id]=draft;saveStorage();
        await sendFacebookMessage(id,'অর্ডার জমা ও প্রতিনিধির কাছে হস্তান্তরের জন্য “হ্যাঁ”, বাতিল করতে “না” লিখুন।');return;
      }
      await handleOrderFlow(id,customerText,messageId);return;
    }
    if(orderIntent){await handleOrderFlow(id,customerText,messageId);return;}
    const lastBotText = [...getHistory(id)].reverse().find(h => h.role === 'assistant')?.text || '';
    if (isYes(customerText) && /(ভিডিও|ছবি|ফটো|video|photo)/i.test(lastBotText)) {
      const wantsVideo = /ভিডিও|video/i.test(lastBotText);
      if (await sendCurrentMedia(id, wantsVideo ? 'videos' : 'images')) return;
    }
    let reply=await generateAIResponse(customerText,attachments,id,messageId);
    if(!reply)throw new Error('AI returned empty response');
    if (reply.split('\n').some(isMediaOfferLine)) {
      if (customerAskedMediaBefore(id) && !alreadyServedMedia(id) && await sendCurrentMedia(id)) return;
      reply = reply.split('\n').filter(l => !isMediaOfferLine(l)).join('\n').trim()
        || 'এই পণ্যের ভিডিও বা ছবির লিংক বর্তমানে ক্যাটালগে নেই। অন্য কিছু জানতে চাইলে বলুন।';
    }
    if(reply.includes(HANDOVER_MARKER)) { const clean=reply.replaceAll(HANDOVER_MARKER,'').trim(); await askHandoverConsent(id,'AI requested human assistance',clean);return; }
    if(/আমার প্রশ্নটা বুঝতে সমস্যা|বুঝতে সমস্যা হচ্ছে|প্রশ্নটি বুঝতে পারিনি|দুঃখিত.*বুঝতে পারছি না/i.test(reply)) {
      await sendFacebookMessage(id,'আমার প্রশ্নটা বুঝতে সমস্যা হচ্ছে, আমি কি আমাদের প্রতিনিধির কাছে প্রশ্নটা হস্তান্তর করবো? “হ্যাঁ” বা “না” লিখুন।');
      db.pendingHandover[id]={reason:'AI could not understand customer question',createdAt:new Date().toISOString()};saveStorage();return;
    }
    const previous=getPreviousAssistantReply(id,customerText);
    if(previous&&normalizeText(previous)===normalizeText(reply))reply='আগের উত্তরে বিষয়টি জানিয়েছি। কোন অংশটি আরও পরিষ্কার করতে হবে বলুন, আমি সাহায্য করছি।';
    if(!getTakeoverState(id)){
      await deliverAIReply(id,limitToFiveLines(reply));
      // The image classifier already writes the catalog-validated product ID. Do not let free-form
      // reply text switch it back to an older product immediately after image analysis.
      if (!attachments.some(x => x.type === 'image' && x.payload?.url)) syncActiveProductFromReply(id,reply,{allowSwitch:true});
    }
  } catch(err) {
    reportError(err,{senderId:id,stage:'processCustomerMessage'});recordFailure(id,customerText,err.message);if(getTakeoverState(id))return;
    await sendFacebookMessage(id,'আমার প্রশ্নটা বুঝতে সমস্যা হচ্ছে, আমি কি আমাদের প্রতিনিধির কাছে প্রশ্নটা হস্তান্তর করবো? “হ্যাঁ” বা “না” লিখুন। সিদ্ধান্ত নিতে সমস্যা হলে সরাসরি কল করুন: '+HELPLINE+'। WhatsApp: '+WHATSAPP_NUMBER+'।'); db.pendingHandover[id]={reason:'AI failed to answer; awaiting customer consent',createdAt:new Date().toISOString()}; saveStorage();
  }
}

// One incoming Messenger message: voice transcription, storage, memory, 5-second delay, auto handover, answer.
async function handleIncomingMessage({ senderId, text: rawText, attachments, messageId, receivedAt }) {
  if (messageId && db.messages.some(m => m.messageId === messageId)) return;
  let text = rawText, isVoice = false, voiceFailed = false;
  const audio = attachments.find(a => a.type === 'audio' && a.payload?.url);
  if (audio && !text && !getTakeoverState(senderId)) {
    try {
      const transcript = await transcribeAudio(audio.payload.url);
      if (transcript) { text = transcript; isVoice = true; } else voiceFailed = true;
    } catch (e) { console.error('[VOICE] Transcription failed:', e.response?.data?.error?.message || e.message); voiceFailed = true; }
  }
  const now = new Date().toISOString(), paused = getTakeoverState(senderId);
  appendHistory(senderId, 'user', text || (attachments.some(a => a.type === 'image') ? '[ছবি পাঠানো হয়েছে; বর্ণনা অপেক্ষমাণ]' : '[Media File]'));
  addStoredMessage({ id: 'msg_' + crypto.randomUUID(), senderId, sender: 'customer', text: text ? (isVoice ? `🎤 ${text}` : text) : `[Media: ${attachments[0]?.type || 'file'}]`, timestamp: now, messageId: messageId || null });
  const c = ensureCustomer(senderId);
  c.messageCount = (c.messageCount || 0) + 1; c.lastActive = now; c.lastCustomerMessageAt = now; c.lastMessageId = messageId || null; c.lastMessageText = text || '[Media]';
  if (text) { c.voiceFailures = 0; updateCustomerMemory(senderId, text); }

  const command = normalizeText(text).replace(/\s+/g, '');
  if (['.human','.stop','.pause'].includes(command)) {
    await setTakeoverState(senderId, true, `Chat command ${command}`);
    await sendFacebookMessage(senderId, 'Human takeover চালু হয়েছে। এখন প্রতিনিধি কথোপকথন পরিচালনা করবেন। AI আবার চালু করতে অ্যাডমিন চ্যাট থেকে .ai লিখুন।');
    return;
  }
  if (['.ai','.resume'].includes(command)) {
    await sendFacebookMessage(senderId, getTakeoverState(senderId) ? 'এই কথোপকথনে Human takeover চালু আছে। AI চালু করতে আমাদের প্রতিনিধি অ্যাডমিন চ্যাট থেকে .ai কমান্ড দেবেন।' : 'AI চ্যাটবট চালু আছে। কীভাবে সাহায্য করতে পারি?');
    return;
  }
  // Accumulate phone / address across messages (also while paused).
  const phone = extractPhone(text), address = extractAddress(text);
  if (phone) c.phone = phone;
  if (address) c.address = address;
  if (phone || address) {
    const mem = getCustomerMemory(senderId);
    if (phone) addUniqueMemoryItem(mem.facts, `ফোন: ${phone}`);
    if (address) addUniqueMemoryItem(mem.facts, `ঠিকানা: ${address}`);
    mem.updatedAt = new Date().toISOString();
  }
  const completeAddress = String(c.address || '').trim().length >= 10;
  if (!paused && !customerHasOrder(senderId)) scheduleFollowup(senderId, Date.now()); else cancelFollowup(senderId);
  saveStorage();
  if (paused) return;

  // ---- Answer every customer message REPLY_DELAY_MS (5 s) after it was received ----
  if (!inRollout(senderId)) return; // outside the rollout percentage: the bot stays silent for this customer
  await waitBeforeReply(senderId, receivedAt);
  if (getTakeoverState(senderId)) return; // an admin took over during the wait

  if (!c.introSent) { c.introSent = true; saveStorage(); await sendFacebookMessage(senderId, FIRST_CONTACT_INTRO); }

  // Automatic human takeover: phone + full address are known (they may arrive in separate messages, in any order).
  if (!db.orderDrafts[senderId] && ((c.phone && completeAddress && (phone || address)) || (AUTO_HANDOVER_ON_PHONE_ONLY && phone))) {
    const both = Boolean(c.phone && completeAddress);
    await setTakeoverState(senderId, true, both ? 'Customer provided phone number and full address' : 'Customer provided phone number');
    await sendFacebookMessage(senderId, `আপনার ফোন নম্বর ${both ? 'ও সম্পূর্ণ ঠিকানা ' : ''}পেয়েছি। বিষয়টি আমাদের প্রতিনিধি টিমের কাছে হস্তান্তর করা হয়েছে। প্রয়োজনে কল করুন: ${HELPLINE}`);
    return;
  }
  if (voiceFailed) {
    c.voiceFailures = (c.voiceFailures || 0) + 1; saveStorage();
    if (c.voiceFailures >= MAX_VOICE_FAILURES_BEFORE_HANDOVER) { c.voiceFailures = 0; await askHandoverConsent(senderId, 'Voice message could not be understood'); }
    else await sendFacebookMessage(senderId, 'দুঃখিত, আপনার ভয়েস মেসেজটি স্পষ্ট বুঝতে পারিনি। অনুগ্রহ করে আবার পাঠান অথবা লিখে জানান।');
    return;
  }
  if (/(?:আমি\s*কল\s*করছি|কল\s*করতে\s*চাই|আপনাদের\s*কল\s*করছি|call me|calling you|i want to call|call your number|ফোন\s*করছি|কল\s*(?:দিন|দেন|করুন|করবেন)|ফোন\s*(?:দিন|দেন|করুন|করবেন))/i.test(text)) {
    await setTakeoverState(senderId, true, 'Customer initiated/asked for a call');
    await sendFacebookMessage(senderId, `আপনার জন্য Human takeover চালু করা হয়েছে। দ্রুত সহায়তার জন্য সরাসরি কল করুন: ${HELPLINE}`);
    return;
  }
  const humanRequest = normalizeText(text);
  if (/^(?:প্রতিনিধি|human|agent|human agent|কাস্টমার কেয়ার|customer care)$/.test(humanRequest) || /প্রতিনিধির\s*সাথে|প্রতিনিধির\s*সঙ্গে|talk\s*to\s*(?:a\s*)?(?:human|agent|person)|real\s*person/.test(humanRequest)) {
    await askHandoverConsent(senderId, 'Customer requested representative'); return;
  }
  await processCustomerMessage(senderId, text, attachments, messageId || null);
}

// -----------------------------------------------------------------------------
// Facebook webhook
// -----------------------------------------------------------------------------
function verifyMetaSignature(req) {
  if (!APP_SECRET) return true; // optional: set APP_SECRET to reject forged webhook calls
  const sig = String(req.get('x-hub-signature-256') || '');
  if (!sig.startsWith('sha256=') || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
app.get('/webhook',(req,res)=>{const mode=req.query['hub.mode'],token=req.query['hub.verify_token'],challenge=req.query['hub.challenge'];if(mode==='subscribe'&&VERIFY_TOKEN&&token===VERIFY_TOKEN)return res.status(200).send(challenge);return res.sendStatus(403);});
app.post('/webhook',async(req,res)=>{
  if (!verifyMetaSignature(req)) { console.warn('[Webhook] Invalid signature; request rejected'); return res.sendStatus(403); }
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
      const senderId=event.sender?.id,message=event.message,messageId=message?.mid,receivedAt=Date.now();
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
        await setTakeoverState(senderId,true,'Incoming Messenger call event'); // takeover is immediate, the reply follows the delay
        enqueueCustomerTask(senderId, async () => {
          await waitBeforeReply(senderId, receivedAt);
          await sendFacebookMessage(senderId,`আপনার কলের অনুরোধের জন্য Human takeover চালু করা হয়েছে। দ্রুত সহায়তার জন্য সরাসরি কল করুন: ${HELPLINE}`);
        });
        continue;
      }
      if(event.postback && senderId) {
        const payload=String(event.postback.payload||'').trim();
        const command=payload.toUpperCase();
        if(command==='HANDOVER_YES') { enqueueCustomerTask(senderId, async () => { await waitBeforeReply(senderId, receivedAt); await transferToHuman(senderId,'Customer consented via postback'); }); continue; }
        if(command==='HANDOVER_NO') { enqueueCustomerTask(senderId, async () => { delete db.pendingHandover[String(senderId)];saveStorage(); await waitBeforeReply(senderId, receivedAt); await sendFacebookMessage(senderId,'ঠিক আছে, AI সহায়তা চালু থাকছে।'); }); continue; }
        const buttonText=String(event.postback.title||event.postback.payload||'').normalize('NFKC').trim();
        if(buttonText) {
          enqueueCustomerTask(senderId, async () => {
            const now=new Date().toISOString();
            appendHistory(senderId,'user',buttonText);
            addStoredMessage({id:'msg_'+crypto.randomUUID(),senderId,sender:'customer',text:buttonText,timestamp:now,messageId:null});
            const c=ensureCustomer(senderId);c.messageCount=(c.messageCount||0)+1;c.lastActive=now;c.lastCustomerMessageAt=now;c.lastMessageText=buttonText;
            updateCustomerMemory(senderId,buttonText);
            saveStorage();
            if(getTakeoverState(senderId)) return;
            await waitBeforeReply(senderId, receivedAt);
            if(!getTakeoverState(senderId)) await processCustomerMessage(senderId,buttonText,[],null);
          });
        }
        continue;
      }
      if(!message||message.is_echo||!senderId)continue;
      if(messageId&&!(await claimMessageId(messageId)))continue;
      const text=String(message.text||message.quick_reply?.payload||'').normalize('NFKC').trim(),attachments=message.attachments||[];
      enqueueCustomerTask(senderId, () => handleIncomingMessage({ senderId, text, attachments, messageId, receivedAt }));
    }
  }catch(err){console.error('[Webhook] Processing error:',err.message);}
});

// -----------------------------------------------------------------------------
// Catalog Admin APIs (the admin app calls these; every change is live for the bot immediately)
// -----------------------------------------------------------------------------
app.get('/api/catalog',(req,res)=>{const catalog=getCatalogSnapshot();res.json({success:true,catalog,products:catalog.products||[],faqs:catalog.faqs||[],meta:{...catalogMeta,catalogDirty,syncMode:CATALOG_SYNC_MODE}});});
app.post('/api/catalog/sync',async(req,res)=>{try{const data=req.body;validateCatalogShape(data);const gh=await withCatalogLock(async()=>{replaceCatalogAtomically(data,'admin');let result={synced:false};if(GITHUB_TOKEN){result=await pushCatalogToGitHub(getCatalogSnapshot(),undefined,undefined,undefined,undefined,{exact:true});catalogDirty=!result.synced;}return result;});res.json({success:true,message:`Catalog updated: ${products.length} products, ${faqs.length} FAQs. The bot uses the new data immediately (sync mode: ${CATALOG_SYNC_MODE}).`,totalProducts:products.length,totalFaqs:faqs.length,githubSynced:gh.synced,githubError:gh.error||null,meta:catalogMeta});}catch(e){res.status(400).json({success:false,message:e.message});}});
app.post('/api/github/upload',async(req,res)=>{try{const {catalog:payload,githubRepo,githubBranch,githubToken,githubFilePath}=req.body;const result=await withCatalogLock(()=>pushCatalogToGitHub(payload||getCatalogSnapshot(),githubToken||GITHUB_TOKEN,githubRepo||GITHUB_REPO,githubBranch||GITHUB_BRANCH,githubFilePath||CATALOG_FILE));if(!result.synced)return res.status(400).json({success:false,message:result.error||result.message});catalogDirty=false;res.json({success:true,message:`Catalog uploaded to ${githubRepo||GITHUB_REPO}@${githubBranch||GITHUB_BRANCH}`,totalProducts:result.totalProducts,totalFaqs:result.totalFaqs,commit:result.commit});}catch(e){res.status(400).json({success:false,message:e.message});}});
app.post('/api/catalog/refresh',async(req,res)=>{const synced=await pullCatalogFromGitHub(true);res.status(synced?200:503).json({success:synced,totalProducts:products.length,totalFaqs:faqs.length,meta:catalogMeta});});
// Single-item endpoints: save or delete ONE product / FAQ, live immediately.
function catalogChangeResponse(res, gh, message) {
  return res.json({ success: true, message, totalProducts: products.length, totalFaqs: faqs.length, githubSynced: gh.synced, githubError: gh.error || null });
}
app.put('/api/catalog/products/:id',async(req,res)=>{try{const id=String(req.params.id||'').trim();if(!id)throw new Error('Product id is required');const product={...(req.body?.product||req.body||{}),id};const list=products.map(p=>({...p}));const idx=list.findIndex(p=>String(p.id)===id);if(idx>=0)list[idx]=product;else list.push(product);const gh=await commitCatalogChange({...getCatalogSnapshot(),products:list});catalogChangeResponse(res,gh,`Product ${id} saved`);}catch(e){res.status(400).json({success:false,message:e.message});}});
app.delete('/api/catalog/products/:id',async(req,res)=>{try{const id=String(req.params.id||'').trim();const list=products.filter(p=>String(p.id)!==id);if(list.length===products.length)return res.status(404).json({success:false,message:'Product not found'});const gh=await commitCatalogChange({...getCatalogSnapshot(),products:list});catalogChangeResponse(res,gh,`Product ${id} deleted`);}catch(e){res.status(400).json({success:false,message:e.message});}});
app.put('/api/catalog/faqs/:id',async(req,res)=>{try{const param=String(req.params.id||'').trim();if(!param)throw new Error('FAQ id is required');const faq={...(req.body?.faq||req.body||{})};if(faq.id===undefined&&!faq.question&&!faq.q)faq.id=param;const keys=new Set([param.toLowerCase(),faqKey(faq)].filter(Boolean));const list=faqs.map(f=>({...f}));const idx=list.findIndex(f=>keys.has(faqKey(f)));if(idx>=0)list[idx]=faq;else list.push(faq);const gh=await commitCatalogChange({...getCatalogSnapshot(),faqs:list});catalogChangeResponse(res,gh,'FAQ saved');}catch(e){res.status(400).json({success:false,message:e.message});}});
app.delete('/api/catalog/faqs/:id',async(req,res)=>{try{const key=String(req.params.id||'').trim().toLowerCase();const list=faqs.filter(f=>faqKey(f)!==key);if(list.length===faqs.length)return res.status(404).json({success:false,message:'FAQ not found'});const gh=await commitCatalogChange({...getCatalogSnapshot(),faqs:list});catalogChangeResponse(res,gh,'FAQ deleted');}catch(e){res.status(400).json({success:false,message:e.message});}});

// -----------------------------------------------------------------------------
// Status, takeover and customer APIs
// -----------------------------------------------------------------------------
app.get('/api/bot-status',(req,res)=>res.json({success:true,isGlobalPaused:!!db.isGlobalPaused,reason:db.isGlobalPaused?'Global human takeover active':'AI bot active',totalPausedCustomers:Object.values(db.takeovers).filter(x=>x&&x.isPaused).length}));
app.post('/api/toggle-bot',(req,res)=>{db.isGlobalPaused=!!req.body.isPaused;if(db.isGlobalPaused)for(const id of Object.keys(db.scheduledFollowups))cancelFollowup(id);saveStorage();res.json({success:true,isGlobalPaused:db.isGlobalPaused});});
app.post('/api/customers/:senderId/takeover',async(req,res)=>{const {senderId}=req.params;const on=req.body.isPaused!==undefined?!!req.body.isPaused:req.body.takeover!==undefined?!!req.body.takeover:true;await setTakeoverState(senderId,on,req.body.reason);res.json({success:true,senderId,isPaused:on,takeover:on,message:on?'Human takeover enabled. AI remains paused until admin resumes it.':'AI resumed for this customer.'});});
app.get('/api/customers/:senderId/status',(req,res)=>{const id=String(req.params.senderId),on=getTakeoverState(id);res.json({success:true,senderId:id,isPaused:on,takeover:on,reason:db.takeovers[id]?.reason||null,updatedAt:db.takeovers[id]?.timestamp||null});});
app.post('/api/customers/:senderId/takeover/enable',async(req,res)=>{await setTakeoverState(req.params.senderId,true,req.body?.reason||'Enabled from admin chat');res.json({success:true,senderId:req.params.senderId,takeover:true,isPaused:true});});
app.post('/api/customers/:senderId/takeover/disable',async(req,res)=>{await setTakeoverState(req.params.senderId,false,req.body?.reason||'Disabled from admin chat');res.json({success:true,senderId:req.params.senderId,takeover:false,isPaused:false});});
app.get('/api/customers',(req,res)=>{const list=Object.values(db.customers).map(c=>({senderId:c.id,displayName:c.name||`Customer ${String(c.id).slice(-4)}`,phone:c.phone||null,address:c.address||null,lastMessageText:c.lastMessageText||null,lastMessageAt:c.lastActive||null,messageCount:c.messageCount||0,lastOrderId:c.lastOrderId||null,lastOrderAt:c.lastOrderAt||null,takeover:getTakeoverState(c.id),isPaused:getTakeoverState(c.id),takeoverReason:db.takeovers[c.id]?.reason||null,takeoverUpdatedAt:db.takeovers[c.id]?.timestamp||null,memoryUpdatedAt:c.lastMemoryUpdatedAt||null,activeProductName:findActiveProduct(c.id)?.name||null,activeCategory:getActiveCategory(c.id)}));res.json({success:true,total:list.length,data:list});});
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
  </style></head><body><div class="wrap"><div class="top"><div><h1>ImpoTech Ad Campaign Leads</h1><div class="muted">Facebook Messenger referral attribution • auto-refresh every 15 seconds</div></div><div style="margin-left:auto"><button id="refresh">Refresh now</button> <button id="key">Set admin key</button></div></div><div class="card"><b id="total">Loading leads...</b><p class="muted">Campaign name is shown only when Meta supplies it or you map the captured Ad ID. Missing attribution is never guessed.</p><div id="rows"></div></div></div><div id="popup" class="alert"><b>New ad lead captured</b><div id="popupText" style="margin-top:8px"></div><div style="margin-top:12px;text-align:right"><button id="dismiss">Dismiss</button></div></div><script>
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
app.get('/api/status',(req,res)=>res.json({success:true,status:'LIVE_PRODUCTION',storage:pool?'postgresql':'memory-only',catalogProducts:products.length,catalogFaqs:faqs.length,catalogQualityWarnings:getCatalogQualityWarnings(),catalogFile:CATALOG_FILE,githubRepo:GITHUB_REPO,githubBranch:GITHUB_BRANCH,catalogMeta,catalogSyncMode:CATALOG_SYNC_MODE,catalogAutoRefreshSeconds:Math.round(CATALOG_REFRESH_INTERVAL_MS/1000),catalogDirty,replyDelayMs:REPLY_DELAY_MS,globalBotPaused:!!db.isGlobalPaused,helpline:HELPLINE,whatsapp:WHATSAPP_NUMBER,aiModel:TEXT_MODEL,voiceModel:VOICE_MODEL,vehicleFitmentEntries:VEHICLE_FITMENT_DATA.length,historyLimit:HISTORY_LIMIT,memoryRetentionDays:MEMORY_RETENTION_DAYS,customers:Object.keys(db.customers).length,messages:db.messages.length,orders:db.orders.length,customerMemories:Object.keys(db.customerMemory).length,pendingFollowups:Object.values(db.scheduledFollowups).filter(x=>x&&x.status==='PENDING').length,timestamp:new Date().toISOString()}));
app.get('/api/catalog/media-status',(req,res)=>res.json({success:true,products:products.map(p=>({id:p.id,name:p.name,images:getProductMediaUrls(p,'images').length,videos:getProductMediaUrls(p,'videos').length}))}));

// ============================================================================
// v7 additions: separate message table, single-call AI, catalog quality checks, sales & quality rules,
// learned examples, draft (approval) mode, rollout control, failure log, audit log,
// daily report, live conversation view, evaluation harness, optional STT (OpenAI Whisper),
// optional Redis de-duplication, optional Sentry error reporting.
// ============================================================================
const TWO_STAGE_AI = false; // disabled: requirement is one AI call per response
const STT_PROVIDER = String(process.env.STT_PROVIDER || 'openrouter').toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const REDIS_URL = process.env.REDIS_URL || '';
const SENTRY_DSN = process.env.SENTRY_DSN || '';
const ROLLOUT_PERCENT_ENV = (() => { const n = Number(process.env.ROLLOUT_PERCENT); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 100; })();
let evalCapture = null;   // when set, outgoing messages are collected here instead of sent (used by /api/eval/run)
let sentry = null;
let redisClient = null;

// ---- settings ----
function isDraftMode() {
  if (evalCapture) return false;
  return typeof db.settings?.draftMode === 'boolean' ? db.settings.draftMode : process.env.DRAFT_MODE === 'true';
}
function getRolloutPercent() {
  const n = Number(db.settings?.rolloutPercent);
  return Number.isFinite(n) && db.settings?.rolloutPercent !== undefined ? Math.max(0, Math.min(100, n)) : ROLLOUT_PERCENT_ENV;
}
function inRollout(senderId) {
  const percent = getRolloutPercent();
  if (percent >= 100) return true;
  const h = crypto.createHash('sha256').update(String(senderId)).digest();
  return (h.readUInt32BE(0) % 100) < percent;
}

// ---- optional services (Sentry, Redis) ----
async function initOptionalServices() {
  if (SENTRY_DSN) {
    try { sentry = require('@sentry/node'); sentry.init({ dsn: SENTRY_DSN, tracesSampleRate: 0 }); console.log('[MON] Sentry enabled'); }
    catch (e) { sentry = null; console.warn('[MON] @sentry/node not installed; errors go to logs only'); }
  }
  if (REDIS_URL) {
    try {
      const Redis = require('ioredis');
      redisClient = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
      redisClient.on('error', e => console.error('[REDIS]', e.message));
      console.log('[REDIS] enabled for message de-duplication');
    } catch (e) { redisClient = null; console.warn('[REDIS] ioredis not installed; in-memory de-duplication used'); }
  }
}
function reportError(err, context = {}) {
  console.error('[ERROR]', err?.message || err, JSON.stringify(context).slice(0, 300));
  try { sentry?.captureException(err, { extra: context }); } catch (_) { /* monitoring must never break the bot */ }
}
async function claimMessageId(messageId) {
  if (redisClient) {
    try { return (await redisClient.set('mid:' + messageId, '1', 'EX', 600, 'NX')) === 'OK'; } catch (_) { /* fall back below */ }
  }
  if (processedMessageIds.has(messageId)) return false;
  processedMessageIds.set(messageId, Date.now());
  return true;
}

// ---- message table (separate from the JSON state; scales to large history) ----
function insertMessageRow(m) {
  if (!pool) return Promise.resolve();
  return pool.query(
    'INSERT INTO impotech_messages(id,sender_id,sender,text,message_id,ts) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',
    [m.id, String(m.senderId), String(m.sender), String(m.text ?? ''), m.messageId ? String(m.messageId) : null, m.timestamp || new Date().toISOString()]
  ).catch(err => console.error('[DB] message insert failed:', err.message));
}
async function initMessageTable() {
  db.settings = db.settings && typeof db.settings === 'object' ? db.settings : {};
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS impotech_messages (
    id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, sender TEXT NOT NULL, text TEXT,
    message_id TEXT, ts TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query('CREATE INDEX IF NOT EXISTS impotech_messages_sender_ts ON impotech_messages(sender_id, ts)');
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM impotech_messages');
  if (count.rows[0].n === 0 && db.messages.length) {
    for (const m of db.messages) await insertMessageRow(m); // one-time move from the old JSON state
  }
  const recent = await pool.query('SELECT id, sender_id, sender, text, message_id, ts FROM impotech_messages ORDER BY ts DESC LIMIT $1', [MESSAGE_RETENTION_LIMIT]);
  db.messages = recent.rows.reverse().map(r => ({ id: r.id, senderId: r.sender_id, sender: r.sender, text: r.text, messageId: r.message_id, timestamp: new Date(r.ts).toISOString() }));
}
function stateForPersist() {
  if (!pool) return db;
  const { messages, ...rest } = db; // messages are stored in impotech_messages when PostgreSQL is configured
  return rest;
}

// ---- learning, drafts, failures, audit ----
function learnedExamplesBlock() {
  const ex = Array.isArray(db.learnedExamples) ? db.learnedExamples.slice(-30) : [];
  if (!ex.length) return '';
  return '\n\nঅ্যাডমিনের অনুমোদিত উত্তরের উদাহরণ (একই ধরনের প্রশ্নে এভাবে উত্তর দেবে):\n' + ex.map(e => `প্রশ্ন: ${e.question}\nউত্তর: ${e.answer}`).join('\n\n');
}
function recordFailure(senderId, customerText, reason) {
  db.failedTurns = Array.isArray(db.failedTurns) ? db.failedTurns : [];
  db.failedTurns.push({ senderId: String(senderId), text: String(customerText || '').slice(0, 500), reason: String(reason || '').slice(0, 300), at: new Date().toISOString(), reviewed: false });
  if (db.failedTurns.length > 500) db.failedTurns.splice(0, db.failedTurns.length - 500);
  saveStorage();
}
async function deliverAIReply(id, text) {
  if (isDraftMode()) {
    db.pendingDrafts = Array.isArray(db.pendingDrafts) ? db.pendingDrafts : [];
    db.pendingDrafts.push({ id: 'draft_' + crypto.randomUUID(), senderId: String(id), text: String(text), createdAt: new Date().toISOString(), status: 'PENDING' });
    if (db.pendingDrafts.length > 500) db.pendingDrafts.splice(0, db.pendingDrafts.length - 500);
    saveStorage();
    return true;
  }
  return sendFacebookMessage(id, text);
}
function auditAppend(entry) {
  db.auditLog = Array.isArray(db.auditLog) ? db.auditLog : [];
  db.auditLog.push({ ...entry, at: new Date().toISOString() });
  if (db.auditLog.length > 2000) db.auditLog.splice(0, db.auditLog.length - 2000);
  saveStorage();
}

// ---- product facts and AI prompt (two-stage analysis + richer context + sales rules) ----
const FACT_SKIP = new Set(['id','name','media','aliases','keywords','tags','description','shortDescription','features','stockStatus','price','inStock','sku']);
function productFacts(p) {
  const lines = [];
  for (const [k, v] of Object.entries(p || {})) {
    if (FACT_SKIP.has(k) || v === null || v === undefined || v === '' || typeof v === 'object') continue;
    lines.push(`${k}: ${v}`);
  }
  return lines.slice(0, 25).join('\n') || 'অতিরিক্ত স্পেসিফিকেশন ক্যাটালগে নেই';
}
async function analyzeCustomerMessage(text, senderId) {
  if (!TWO_STAGE_AI || !OPENROUTER_API_KEY || !products.length) return null;
  const catalogList = products.map(p => `${p.id} | ${p.name}`).join('\n').slice(0, 6000);
  const ctx = getRecentConversationText(senderId, text).slice(-1500);
  const system = `আপনি একটি মোটরসাইকেল/গাড়ির লাইটিং দোকানের গ্রাহক বার্তা শ্রেণিবিন্যাস করেন। শুধু JSON দিন, অন্য কিছু নয়। কী: productId (নিচের তালিকা থেকে ID অথবা null), intent (price|media|fitment|delivery|warranty|order|stock|general|handover|other), wantsMedia ("images" | "videos" | null), needsCatalogInfo (true/false), confidence (0 থেকে 1)। "এটা", "ওইটা", "আলো কেমন" ইত্যাদি সর্বনাম কথোপকথন থেকে বুঝে নিন।\nপণ্যের তালিকা:\n${catalogList}`;
  try {
    const raw = await callOpenRouter([{ role: 'system', content: system }, { role: 'user', content: `কথোপকথন:\n${ctx}\n\nসর্বশেষ বার্তা: ${text}` }], TEXT_MODEL, { maxTokens: 150, temperature: 0 });
    const json = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    return { productId: json.productId ? String(json.productId) : null, intent: json.intent || 'general', wantsMedia: json.wantsMedia || null, needsCatalogInfo: Boolean(json.needsCatalogInfo), confidence: Number(json.confidence) || 0 };
  } catch (e) { console.warn('[ANALYZE] skipped:', e.message); return null; }
}
const SALES_AND_QUALITY_RULES = `
৯) বিক্রয়ের আচরণ: প্রশ্নের উত্তর দেওয়ার পর গ্রাহক আগ্রহী মনে হলে একটি ছোট পরবর্তী ধাপ বলুন (যেমন অর্ডার করতে চাইলে জানানো)। ক্যাটালগে নেই এমন পণ্য সাজেস্ট করবেন না। জোর করবেন না। ভিডিও বা ছবি দেখতে চান কি না—এমন প্রশ্ন কখনো করবেন না; গ্রাহক চাইলে লিংক সিস্টেম নিজেই পাঠায়। গ্রাহক যা ইতিমধ্যে চেয়েছেন বা যা পাঠানো হয়েছে, তা আবার জিজ্ঞেস করবেন না।
১৪) বর্তমান পণ্য: মেমোরিতে 'বর্তমান আলোচনার পণ্য' যেটি আছে, শুধু সেই পণ্যের তথ্য দেবেন। গ্রাহক 'দামি', 'ভালো', 'আলো বেশি' ইত্যাদি মান-প্রশ্ন করলে তা দামের প্রশ্ন নয়; বর্তমান পণ্যের আলোর ক্ষমতা (লুমেন/ওয়াটেজ) ও বৈশিষ্ট্য দিয়ে উত্তর দিন।
১০) আপত্তি মোকাবিলা: দাম বেশি মনে হলে দামের সাথে সুবিধা ও ওয়ারেন্টি উল্লেখ করুন; ক্যাটালগের বাইরে কোনো ছাড় বা অফার বানাবেন না। বিশ্বাস নিয়ে সন্দেহ থাকলে ক্যাটালগের তথ্য ও ওয়ারেন্টির শর্ত বলুন।
১১) মেজাজ: গ্রাহক বিরক্ত বা রাগী হলে ছোট, শান্ত ও ক্ষমাপ্রার্থী ভাষায় উত্তর দিন। তাড়াহুড়ো থাকলে সংক্ষিপ্ত উত্তর দিন। ধন্যবাদ বললে সুন্দরভাবে উত্তর দিয়ে প্রয়োজনে অর্ডারের আমন্ত্রণ জানান।
১২) নিশ্চয়তা: ক্যাটালগ বা FAQ-এ না থাকা তথ্য অনুমান করবেন না। বলুন যে তথ্যটি নিশ্চিতভাবে জানা নেই, প্রতিনিধি নিশ্চিত করবেন, এবং প্রয়োজনে হস্তান্তরের প্রস্তাব দিন।
১৩) উত্তরের গঠন: প্রথমে সরাসরি উত্তর, তারপর প্রয়োজনে একটি পরিষ্কার পরবর্তী পদক্ষেপ। অপ্রাসঙ্গিক তথ্য নয়।`;
function buildSystemPrompt(relevantProducts, relevantFaqs, history, memoryContext, topicContext, analysis = null) {
  const base = buildSystemPromptBase(relevantProducts, relevantFaqs, history, memoryContext, topicContext);
  const facts = relevantProducts.length ? '\n\nপণ্যের বিস্তারিত স্পেসিফিকেশন (ক্যাটালগ):\n' + relevantProducts.map(p => `[${p.name}]\n${productFacts(p)}`).join('\n\n') : '';
  const analysisBlock = analysis ? `\n\nপ্রাথমিক বিশ্লেষণ (সন্দেহ হলে ক্যাটালগ অনুসরণ করুন): উদ্দেশ্য=${analysis.intent}; পণ্য-ID=${analysis.productId || 'নেই'}; মিডিয়া=${analysis.wantsMedia || 'নেই'}; নিশ্চয়তা=${analysis.confidence}` : '';
  return base + facts + analysisBlock + '\n' + SALES_AND_QUALITY_RULES + learnedExamplesBlock();
}
function buildFollowupText(senderId) {
  const p = findActiveProduct(senderId);
  if (p) return `${p.name} সম্পর্কে আপনার কোনো প্রশ্ন থাকলে জানাবেন। ছবি, ভিডিও বা দাম দেখতে চাইলেও বলতে পারেন।`;
  return FOLLOWUP_MESSAGE;
}

// ---- voice: OpenAI Whisper when configured, otherwise the OpenRouter model ----
async function transcribeAudioOpenAI(buffer, filename, mime) {
  const boundary = '----impotech' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  const field = (name, value) => parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  field('model', 'whisper-1');
  field('language', 'bn');
  field('response_format', 'text');
  field('prompt', 'বাংলা ভয়েস মেসেজ। পণ্য: হেডলাইট, ফগ লাইট, অ্যাঞ্জেল উইংস, H4, HS1, DC, AC।');
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const r = await axios.post('https://api.openai.com/v1/audio/transcriptions', Buffer.concat(parts), {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    timeout: 45000, maxBodyLength: MAX_ATTACHMENT_BYTES, responseType: 'text', transformResponse: x => x
  });
  return cleanTranscript(String(r.data || ''));
}
async function transcribeAudio(url) {
  if (STT_PROVIDER === 'openai' && OPENAI_API_KEY) {
    try {
      const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: MAX_ATTACHMENT_BYTES });
      const buffer = Buffer.from(r.data);
      if (buffer.length) {
        const format = detectAudioFormat(buffer, r.headers?.['content-type'], url);
        const mimeMap = { m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', aiff: 'audio/aiff' };
        const text = await transcribeAudioOpenAI(buffer, `voice.${format}`, mimeMap[format] || 'application/octet-stream');
        if (text) return text;
      }
    } catch (e) { console.error('[STT] OpenAI failed, using OpenRouter fallback:', e.response?.status || e.message); }
  }
  return transcribeAudioOpenRouter(url);
}

// ---- evaluation harness: runs real handlers and reports pass/fail ----
async function runEvalCases(cases) {
  const results = [];
  for (const c of cases.slice(0, 100)) {
    const id = 'eval_' + crypto.randomUUID().slice(0, 8);
    const turns = Array.isArray(c.turns) ? c.turns.map(String) : [String(c.text || '')];
    const previous = evalCapture;
    evalCapture = [];
    try {
      for (const t of turns) await processCustomerMessage(id, t, [], null);
      const out = evalCapture.map(x => x.text).join('\n');
      const pass = (c.expectIncludes || []).every(s => out.includes(s)) && (c.expectNotIncludes || []).every(s => !out.includes(s));
      results.push({ name: c.name || turns.join(' → '), pass, reply: out.slice(0, 500) });
    } catch (e) {
      results.push({ name: c.name || turns.join(' → '), pass: false, reply: 'ERROR: ' + e.message });
    } finally {
      evalCapture = previous;
      delete db.customers[id]; delete db.customerMemory[id]; delete db.orderDrafts[id]; delete db.pendingHandover[id];
      customerHistory.delete(id);
    }
  }
  return results;
}

// ---- daily report ----
function buildDailyReport(dateStr) {
  const day = dateStr || new Date().toISOString().slice(0, 10);
  const inDay = t => String(t || '').slice(0, 10) === day;
  const msgs = db.messages.filter(m => inDay(m.timestamp));
  const customerMsgs = msgs.filter(m => m.sender === 'customer');
  return {
    date: day,
    activeCustomers: new Set(customerMsgs.map(m => String(m.senderId))).size,
    customerMessages: customerMsgs.length,
    botReplies: msgs.filter(m => m.sender === 'bot').length,
    ordersCreated: db.orders.filter(o => inDay(o.createdAt)).length,
    handoversActive: Object.values(db.takeovers).filter(t => t && t.isPaused && inDay(t.timestamp)).length,
    failedTurns: (db.failedTurns || []).filter(f => inDay(f.at)).length,
    pendingDrafts: (db.pendingDrafts || []).filter(d => d.status === 'PENDING').length
  };
}

// ---- v7 admin routes ----
app.get('/api/settings', (req, res) => res.json({ success: true, settings: { draftMode: isDraftMode(), rolloutPercent: getRolloutPercent(), twoStageAi: TWO_STAGE_AI, sttProvider: STT_PROVIDER } }));
app.put('/api/settings', (req, res) => {
  db.settings = db.settings && typeof db.settings === 'object' ? db.settings : {};
  if (typeof req.body?.draftMode === 'boolean') db.settings.draftMode = req.body.draftMode;
  if (req.body?.rolloutPercent !== undefined) {
    const n = Number(req.body.rolloutPercent);
    if (!Number.isFinite(n) || n < 0 || n > 100) return res.status(400).json({ success: false, message: 'rolloutPercent must be 0-100' });
    db.settings.rolloutPercent = n;
  }
  saveStorage();
  res.json({ success: true, settings: { draftMode: isDraftMode(), rolloutPercent: getRolloutPercent() } });
});
app.get('/api/drafts', (req, res) => {
  const status = req.query.status ? String(req.query.status) : 'PENDING';
  const list = (db.pendingDrafts || []).filter(d => d.status === status);
  res.json({ success: true, total: list.length, data: list });
});
app.post('/api/drafts/:id/approve', async (req, res) => {
  const d = (db.pendingDrafts || []).find(x => x.id === req.params.id);
  if (!d || d.status !== 'PENDING') return res.status(404).json({ success: false, message: 'Draft not found or already handled' });
  const finalText = String(req.body?.text || d.text).trim();
  const sent = await sendFacebookMessage(d.senderId, finalText);
  if (!sent) return res.status(500).json({ success: false, message: 'Send failed' });
  d.status = 'SENT'; d.sentText = finalText;
  if (req.body?.learn === true) {
    const lastQuestion = [...getHistory(d.senderId)].reverse().find(h => h.role === 'user')?.text || '';
    db.learnedExamples = Array.isArray(db.learnedExamples) ? db.learnedExamples : [];
    db.learnedExamples.push({ question: lastQuestion, answer: finalText, at: new Date().toISOString() });
  }
  saveStorage();
  res.json({ success: true });
});
app.post('/api/drafts/:id/reject', (req, res) => {
  const d = (db.pendingDrafts || []).find(x => x.id === req.params.id);
  if (!d || d.status !== 'PENDING') return res.status(404).json({ success: false, message: 'Draft not found or already handled' });
  d.status = 'REJECTED'; saveStorage();
  res.json({ success: true });
});
app.get('/api/learned', (req, res) => res.json({ success: true, total: (db.learnedExamples || []).length, data: db.learnedExamples || [] }));
app.post('/api/learned', (req, res) => {
  const question = String(req.body?.question || '').trim(), answer = String(req.body?.answer || '').trim();
  if (!question || !answer) return res.status(400).json({ success: false, message: 'question and answer are required' });
  db.learnedExamples = Array.isArray(db.learnedExamples) ? db.learnedExamples : [];
  db.learnedExamples.push({ question, answer, at: new Date().toISOString() });
  if (db.learnedExamples.length > 200) db.learnedExamples.splice(0, db.learnedExamples.length - 200);
  saveStorage();
  res.status(201).json({ success: true });
});
app.delete('/api/learned/:index', (req, res) => {
  const i = Number(req.params.index);
  if (!Array.isArray(db.learnedExamples) || !Number.isInteger(i) || i < 0 || i >= db.learnedExamples.length) return res.status(404).json({ success: false, message: 'Not found' });
  db.learnedExamples.splice(i, 1); saveStorage();
  res.json({ success: true });
});
app.get('/api/conversations/:senderId', (req, res) => {
  const id = String(req.params.senderId);
  const since = req.query.since ? new Date(String(req.query.since)).getTime() : 0;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const list = db.messages.filter(m => String(m.senderId) === id && new Date(m.timestamp).getTime() > since).slice(-limit);
  const topic = getCurrentTopic(id);
  res.json({ success: true, senderId: id, takeover: getTakeoverState(id), activeProduct: topic.product ? topic.product.name : null, activeCategory: topic.category, pendingDrafts: (db.pendingDrafts || []).filter(d => d.senderId === id && d.status === 'PENDING'), messages: list });
});
app.get('/api/reports/daily', (req, res) => res.json({ success: true, report: buildDailyReport(req.query.date ? String(req.query.date) : null) }));
app.get('/api/failures', (req, res) => {
  const list = (db.failedTurns || []).filter(f => !f.reviewed);
  res.json({ success: true, total: list.length, data: list });
});
app.post('/api/failures/mark-reviewed', (req, res) => {
  for (const f of db.failedTurns || []) f.reviewed = true;
  saveStorage(); res.json({ success: true });
});
app.get('/api/audit', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000);
  res.json({ success: true, data: (db.auditLog || []).slice(-limit).reverse() });
});
app.post('/api/eval/run', async (req, res) => {
  const cases = Array.isArray(req.body?.cases) ? req.body.cases : [];
  if (!cases.length) return res.status(400).json({ success: false, message: 'cases array is required' });
  const results = await runEvalCases(cases);
  const passed = results.filter(r => r.pass).length;
  res.json({ success: true, total: results.length, passed, failed: results.length - passed, results });
});


// ============================================================================
// v8: conversation fixes (media already sent / no repeated offers / structured memory)
// ============================================================================
function markServed(senderId, product, types) {
  if (!product || !types || !types.length) return;
  const c = ensureCustomer(senderId);
  c.servedMedia = c.servedMedia && typeof c.servedMedia === 'object' ? c.servedMedia : {};
  const entry = c.servedMedia[String(product.id)] || {};
  for (const t of types) if (getProductMediaUrls(product, t).length) entry[t === 'videos' ? 'videos' : 'images'] = true;
  c.servedMedia[String(product.id)] = entry;
  saveStorage();
}
function buildCustomerMemoryContext(senderId) {
  const id = String(senderId || '');
  const c = db.customers[id] || {};
  const m = getCustomerMemory(id);
  const lines = [];
  const topic = getCurrentTopic(id);
  if (topic.product) lines.push(`বর্তমান আলোচনার পণ্য: ${topic.product.name} (ID ${topic.product.id})`);
  else if (topic.category) lines.push(`বর্তমান আলোচনার ক্যাটাগরি: ${getCategoryLabel(topic.category)} (নির্দিষ্ট মডেল এখনো ঠিক হয়নি)`);
  for (const [pid, s] of Object.entries(c.servedMedia || {})) {
    const p = products.find(x => String(x.id) === pid);
    if (!p) continue;
    const done = [];
    if (s.videos) done.push('ভিডিও লিংক দেওয়া হয়েছে');
    if (s.images) done.push('ছবি দেওয়া হয়েছে');
    if (done.length) lines.push(`${p.name}: ${done.join(', ')}। এগুলো আবার জিজ্ঞেস করবেন না।`);
  }
  const facts = (m?.facts || []).filter(f => !ACTIVE_PRODUCT_FACT_RE.test(String(f))).slice(-8);
  if (facts.length) lines.push('তথ্য:\n- ' + facts.join('\n- '));
  if (c.vehicleModelName) lines.push(`গ্রাহকের যানবাহন: ${c.vehicleModelName}`);
  const recent = (m?.recentQuestions || []).slice(-5);
  if (recent.length) lines.push('গ্রাহকের সাম্প্রতিক বার্তা (প্রসঙ্গের জন্য):\n- ' + recent.join('\n- '));
  return lines.join('\n') || 'কোনো সংরক্ষিত মেমোরি নেই।';
}
function isMediaOfferLine(line) {
  return /(ভিডিও|ছবি|ফটো|video|photo)/i.test(line) && /(দেখতে\s*চান|চান\s*\?|চান\?|দেখাব|পাঠাব)/i.test(line);
}
function customerAskedMediaBefore(senderId) {
  return getHistory(senderId).filter(h => h.role === 'user').slice(-10)
    .some(h => getMediaTypes(h.text).length || isLightQualityQuestion(h.text));
}
async function sendCurrentMedia(senderId, preferredType) {
  const product = resolveConversationTopic('', senderId).product;
  if (!product) return false;
  const types = preferredType ? [preferredType] : ['videos', 'images'];
  const available = types.filter(t => getProductMediaUrls(product, t).length);
  if (!available.length) return false;
  const reply = getProductMediaReply(available[0] === 'videos' ? 'ভিডিও' : 'ছবি', senderId);
  if (!reply) return false;
  await sendFacebookMessage(senderId, limitToFiveLines(reply, 8));
  markServed(senderId, product, available);
  return true;
}
function alreadyServedMedia(senderId) {
  const product = resolveConversationTopic('', senderId).product;
  if (!product) return false;
  const s = (db.customers[String(senderId)]?.servedMedia || {})[String(product.id)];
  return Boolean(s && (s.videos || s.images));
}

// -----------------------------------------------------------------------------
// Start and periodic tasks
// -----------------------------------------------------------------------------
async function startServer() {
  await initDatabase();
  await initOptionalServices();
  loadLocalCatalog();
  await pullCatalogFromGitHub(true);
  restoreFollowupTasks();
  app.listen(PORT,'0.0.0.0',()=>{
    console.log(`[SERVER] ImpoTech Master Bot running on port ${PORT}`);
    console.log(`[STORAGE] ${pool?'PostgreSQL configured':'WARNING: in-memory fallback only'}`);
    console.log(`[CATALOG] ${products.length} products, ${faqs.length} FAQs; source=${catalogMeta.source}`);
    console.log(`[CONTACT] Helpline ${HELPLINE}; WhatsApp ${WHATSAPP_NUMBER}`);
    console.log(`[REPLY] Every customer message is answered ${REPLY_DELAY_MS} ms after it was received`);
    if(!ADMIN_SECRET&&REQUIRE_ADMIN_SECRET)console.error('[SECURITY] ADMIN_SECRET missing; admin API will reject requests.');
    if(!APP_SECRET)console.warn('[SECURITY] APP_SECRET missing; webhook signatures are NOT verified (set APP_SECRET to your Meta app secret).');
    if(!PAGE_ACCESS_TOKEN)console.warn('[CONFIG] PAGE_ACCESS_TOKEN missing');
    if(!VERIFY_TOKEN)console.warn('[CONFIG] VERIFY_TOKEN missing');
    if(!OPENROUTER_API_KEY)console.warn('[CONFIG] OPENROUTER_API_KEY missing');
    startCatalogAutoRefresh();
  });
}
startServer().catch(err=>{console.error('[SERVER] Startup error:',err.message);process.exit(1);});
setInterval(()=>{const cutoff=Date.now()-DUPLICATE_WINDOW_MS;for(const [id,t] of processedMessageIds)if(t<cutoff)processedMessageIds.delete(id);},60000).unref();
setInterval(()=>{for(const [id,task] of Object.entries(db.scheduledFollowups)){if(!task||task.status!=='PENDING')continue;if(getTakeoverState(id)||customerHasOrder(id)){cancelFollowup(id);continue;}if(!followupTimers.has(id))armFollowupTimer(id);}if(pruneOldMemory())saveStorage();},FOLLOWUP_CHECK_INTERVAL_MS).unref();
process.on('SIGTERM',async()=>{try{await persistChain;if(pool)await pool.end();}finally{process.exit(0);}});
process.on('SIGINT',async()=>{try{await persistChain;if(pool)await pool.end();}finally{process.exit(0);}});
