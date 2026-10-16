/**
 * ImpoTech BD - Facebook Messenger AI Chatbot & Admin Backend
 * Fully Updated, Robust, Multi-Feature Server 
 * Model: google/gemini-2.5-flash-lite
 * Delivery Charges: Gazipur 50 Tk, Outside Gazipur 100 Tk
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ==========================================
// 1. CONFIGURATION & ENVIRONMENT
// ==========================================
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'impotech_messenger_verify_token_2026';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GRAPH_API_URL = 'https://graph.facebook.com/v19.0';
const DATABASE_URL = process.env.DATABASE_URL || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_CATALOG_PATH = process.env.GITHUB_CATALOG_PATH || 'catalog.json';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'impotech_admin_secret_2026';
const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS || '1200', 10);
const LOCAL_BACKUP_FILE = path.join(__dirname, 'app_state_backup.json');

// Delivery charges configuration (Gazipur 50 Tk, Outside Gazipur 100 Tk)
const DELIVERY_CHARGES = {
  GAZIPUR: 50,
  OUTSIDE_GAZIPUR: 100
};

// ==========================================
// 2. IN-MEMORY STATE & POSTGRESQL SYNC
// ==========================================
let state = {
  catalogs: [],
  customer_memories: {}, // psid -> { name, phone, address, vehicle, socket, retryCount, history: [], lastActivity }
  orders: [],           // array of orders
  takeovers: {},        // psid -> { active: boolean, reason: string, updatedBy: string, timestamp: number }
  campaign_tracking: {},// campaign_id -> { clicks, conversations, orders, revenue }
  metrics: {
    total_messages: 0,
    ai_replies: 0,
    human_takeovers: 0,
    orders_created: 0
  }
};

let pool = null;
if (DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });
    console.log('[DB] PostgreSQL pool configured.');
  } catch (err) {
    console.error('[DB] PostgreSQL init error:', err.message);
  }
}

// Ensure database tables exist
async function initDatabase() {
  if (!pool) {
    loadLocalBackup();
    return;
  }
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS impotech_app_state (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    client.release();
    console.log('[DB] Database tables initialized.');
    await loadStateFromDB();
  } catch (err) {
    console.error('[DB] Error initializing DB table:', err.message);
    loadLocalBackup();
  }
}

// Load state from DB
async function loadStateFromDB() {
  if (!pool) return;
  try {
    const res = await pool.query('SELECT key, value FROM impotech_app_state');
    res.rows.forEach(row => {
      if (state[row.key] !== undefined) {
        state[row.key] = row.value;
      }
    });
    console.log('[DB] State successfully hydrated from PostgreSQL.');
  } catch (err) {
    console.error('[DB] Hydration error:', err.message);
    loadLocalBackup();
  }
}

// Save state to DB & local backup
async function persistState(keys = ['catalogs', 'customer_memories', 'orders', 'takeovers', 'campaign_tracking', 'metrics']) {
  try {
    fs.writeFileSync(LOCAL_BACKUP_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Storage] Local backup write error:', err.message);
  }

  if (!pool) return;
  for (const key of keys) {
    try {
      await pool.query(`
        INSERT INTO impotech_app_state (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key)
        DO UPDATE SET value = $2, updated_at = NOW();
      `, [key, JSON.stringify(state[key])]);
    } catch (err) {
      console.error(`[DB] Error persisting key ${key}:`, err.message);
    }
  }
}

function loadLocalBackup() {
  if (fs.existsSync(LOCAL_BACKUP_FILE)) {
    try {
      const data = fs.readFileSync(LOCAL_BACKUP_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      state = { ...state, ...parsed };
      console.log('[Storage] Hydrated from local backup JSON file.');
    } catch (err) {
      console.error('[Storage] Error reading local backup:', err.message);
    }
  } else {
    if (!state.catalogs || state.catalogs.length === 0) {
      state.catalogs = [
        {
          id: 'imp-led-01',
          name: 'RTD M02E 6-Cobra LED Headlight',
          category: 'Headlight LED',
          price: 1150,
          socket: 'Multi-Socket (H4, HS1, BA20D, etc.)',
          warranty: '6 Months',
          stock: true,
          description: 'High brightness 3500LM AC/DC compatible with cooling fan for all bikes and scooters.'
        },
        {
          id: 'imp-led-02',
          name: 'Novsight N39 Ultra LED Bulb (H4/HS1)',
          category: 'Premium Headlight LED',
          price: 2450,
          socket: 'H4 / HS1',
          warranty: '1 Year Replacement',
          stock: true,
          description: '10000LM, 6000K pure white, cutoff line beam pattern, aviation aluminum.'
        },
        {
          id: 'imp-fog-01',
          name: 'Future Eyes F150 / F20 Dual Beam Fog Light',
          category: 'Auxiliary Fog Light',
          price: 3600,
          socket: 'External Clamp / Bracket Mount',
          warranty: '1 Year Warranty',
          stock: true,
          description: 'Yellow Low Beam + White High Beam, IP68 Waterproof, CNC casing.'
        }
      ];
      persistState(['catalogs']);
    }
  }
}

// ==========================================
// 3. UTILITY & TEXT PROCESSING FUNCTIONS
// ==========================================

// Convert Bengali numerals (à§¦-à§¯) to English (0-9)
function normalizeBengaliNumerals(text) {
  if (!text) return '';
  const bnToEnMap = { 'à§¦': '0', 'à§§': '1', 'à§¨': '2', 'à§©': '3', 'à§ª': '4', 'à§«': '5', 'à§¬': '6', 'à§­': '7', 'à§®': '8', 'à§¯': '9' };
  return text.toString().replace(/[à§¦-à§¯]/g, match => bnToEnMap[match] || match);
}

// Clean markdown escaping generated by LLMs that Messenger breaks on
function cleanMessengerText(text) {
  if (!text) return '';
  let cleaned = text
    .replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .trim();
  return cleaned;
}

// Check if message explicitly intends to purchase
function isExplicitOrderIntent(text) {
  if (!text) return false;
  const normalized = normalizeBengaliNumerals(text.toLowerCase());
  const orderPatterns = [
    /à¦…à¦°à§à¦¡à¦¾à¦°\s*(à¦•à¦°à¦¬|à¦•à¦°à¦¤à§‡\s*à¦šà¦¾à¦‡|à¦¦à¦¿à¦¨|à¦•à¦¨à¦«à¦¾à¦°à§à¦®|à¦¨à§‡à¦¨|à¦°à¦¾à¦–à§à¦¨|à¦ªà¦¾à¦ à¦¾à¦¨)/i,
    /à¦¨à¦¿à¦¤à§‡\s*à¦šà¦¾à¦‡/i,
    /à¦•à¦¿à¦¨à¦¬|à¦•à¦¿à¦¨à¦¤à§‡\s*à¦šà¦¾à¦‡/i,
    /à¦¬à§à¦•\s*à¦•à¦°à¦¤à§‡\s*à¦šà¦¾à¦‡/i,
    /order\s*(now|confirm|place|please)?/i,
    /send\s*me\s*(the\s*product|this|one)/i,
    /parcel|cash\s*on\s*delivery|à¦•à§à¦¯à¦¾à¦¶\s*à¦…à¦¨\s*à¦¡à§‡à¦²à¦¿à¦­à¦¾à¦°à¦¿/i,
    /à¦ à¦¿à¦•à¦¾à¦¨à¦¾\s*à¦¦à¦¿à¦šà§à¦›à¦¿/i
  ];
  return orderPatterns.some(pattern => pattern.test(normalized));
}

// Check if customer asks for human agent
function isHumanHandoverRequest(text) {
  if (!text) return false;
  const normalized = text.toLowerCase();
  const humanPatterns = [
    /à¦®à¦¾à¦¨à§à¦·à§‡à¦°\s*à¦¸à¦¾à¦¥à§‡\s*(à¦•à¦¥à¦¾|à¦†à¦²à¦¾à¦ª)/i,
    /à¦•à¦¥à¦¾\s*à¦¬à¦²à¦¤à§‡\s*à¦šà¦¾à¦‡/i,
    /à¦•à¦¥à¦¾\s*à¦¬à¦²à¦¾\s*à¦¯à¦¾à¦¬à§‡/i,
    /à¦•à¦¾à¦¸à§à¦Ÿà¦®à¦¾à¦°\s*à¦•à§‡à¦¯à¦¼à¦¾à¦°/i,
    /à¦…à¦«à¦¿à¦¸à¦¿à¦¯à¦¼à¦¾à¦²\s*à¦¨à¦®à§à¦¬à¦°/i,
    /à¦•à¦¥à¦¾\s*à¦¬à¦²à¦¬à§‹/i,
    /à¦«à§‹à¦¨\s*(à¦¨à¦®à§à¦¬à¦°|à¦¨à¦¾à¦®à§à¦¬à¦¾à¦°|à¦¦à¦¿à¦¨|à¦•à¦°à§à¦¨)/i,
    /à¦•à¦²\s*(à¦¦à¦¿à¦¨|à¦•à¦°à¦¬à§‡à¦¨|à¦•à¦°à§à¦¨)/i,
    /à¦•à¦¥à¦¾\s*à¦¬à¦²à¦¾\s*à¦¸à¦®à§à¦­à¦¬/i,
    /admin|agent|human|representative|support\s*person/i,
    /à¦¬à¦Ÿ\s*à¦¨à¦¾/i,
    /à¦°à§‹à¦¬à¦Ÿ\s*à¦¨à¦¾/i
  ];
  return humanPatterns.some(p => p.test(normalized));
}

// Check for emergency / high-priority complaints
function isCriticalComplaint(text) {
  if (!text) return false;
  const normalized = text.toLowerCase();
  const complaintPatterns = [
    /à¦¨à¦·à§à¦Ÿ|à¦­à¦¾à¦™à¦¾|à¦•à¦¾à¦œ\s*à¦•à¦°à§‡\s*à¦¨à¦¾|à¦¤à§à¦°à§à¦Ÿà¦¿à¦ªà§‚à¦°à§à¦£/i,
    /à¦§à§‹à¦à¦•à¦¾|à¦ªà§à¦°à¦¤à¦¾à¦°à¦£à¦¾|à¦¬à¦¾à¦Ÿà¦ªà¦¾à¦°à¦¿|à¦œà¦¾à¦²à¦¿à¦¯à¦¼à¦¾à¦¤à¦¿/i,
    /à¦°à¦¿à¦ªà§à¦²à§‡à¦¸à¦®à§‡à¦¨à§à¦Ÿ|à¦°à¦¿à¦Ÿà¦¾à¦°à§à¦¨|à¦Ÿà¦¾à¦•à¦¾\s*à¦«à§‡à¦°à¦¤|à¦“à¦¯à¦¼à¦¾à¦°à§‡à¦¨à§à¦Ÿà¦¿\s*à¦•à§à¦²à§‡à¦®/i,
    /à¦­à§à¦²\s*à¦ªà§à¦°à§‹à¦¡à¦¾à¦•à§à¦Ÿ|à¦…à¦¨à§à¦¯\s*à¦œà¦¿à¦¨à¦¿à¦¸/i,
    /à¦¥à¦¾à¦¨à¦¾|à¦ªà§à¦²à¦¿à¦¶|à¦†à¦‡à¦¨à¦—à¦¤/i
  ];
  return complaintPatterns.some(p => p.test(normalized));
}

// Extract potential phone numbers
function extractPhoneNumber(text) {
  if (!text) return null;
  const normalized = normalizeBengaliNumerals(text);
  const match = normalized.match(/(?:\+?88)?01[3-9]\d{8}/);
  return match ? match[0] : null;
}

// Detect area Gazipur (50 Tk) vs Outside Gazipur (100 Tk)
function detectDeliveryZone(addressText) {
  if (!addressText) return { zone: 'OUTSIDE_GAZIPUR', charge: DELIVERY_CHARGES.OUTSIDE_GAZIPUR, label: 'à¦—à¦¾à¦œà§€à¦ªà§à¦°à§‡à¦° à¦¬à¦¾à¦‡à¦°à§‡' };
  const lower = addressText.toLowerCase();
  const gazipurKeywords = [
    'gazipur', 'à¦—à¦¾à¦œà§€à¦ªà§à¦°', 'à¦Ÿà¦™à§à¦—à§€', 'tongi', 'à¦šà§Œà¦°à¦¾à¦¸à§à¦¤à¦¾', 'chourasta', 'à¦œà¦¯à¦¼à¦¦à§‡à¦¬à¦ªà§à¦°', 'joydebpur',
    'à¦¬à§‹à¦°à§à¦¡ à¦¬à¦¾à¦œà¦¾à¦°', 'board bazar', 'à¦•à¦¾à¦²à¦¿à¦¯à¦¼à¦¾à¦•à§ˆà¦°', 'kaliakair', 'à¦¶à§à¦°à§€à¦ªà§à¦°', 'sreepur', 'à¦•à¦¾à¦ªà¦¾à¦¸à¦¿à¦¯à¦¼à¦¾', 'kapasia'
  ];

  if (gazipurKeywords.some(k => lower.includes(k))) {
    return { zone: 'GAZIPUR', charge: DELIVERY_CHARGES.GAZIPUR, label: 'à¦—à¦¾à¦œà§€à¦ªà§à¦°' };
  }
  return { zone: 'OUTSIDE_GAZIPUR', charge: DELIVERY_CHARGES.OUTSIDE_GAZIPUR, label: 'à¦—à¦¾à¦œà§€à¦ªà§à¦°à§‡à¦° à¦¬à¦¾à¦‡à¦°à§‡' };
}

// ==========================================
// 4. FACEBOOK GRAPH API MESSAGING
// ==========================================

async function sendMessengerPayload(payload) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn('[Messenger] PAGE_ACCESS_TOKEN missing. Output message:', JSON.stringify(payload));
    return;
  }
  try {
    const res = await fetch(`${GRAPH_API_URL}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.error) {
      console.error('[Messenger API Error]:', data.error);
    }
    return data;
  } catch (err) {
    console.error('[Messenger API Exception]:', err.message);
  }
}

async function sendTextMessage(psid, text, quickReplies = null) {
  const cleaned = cleanMessengerText(text);
  const payload = {
    recipient: { id: psid },
    message: { text: cleaned }
  };
  if (quickReplies && Array.isArray(quickReplies) && quickReplies.length > 0) {
    payload.message.quick_replies = quickReplies.map(qr => ({
      content_type: 'text',
      title: qr.title.substring(0, 20),
      payload: qr.payload || qr.title
    }));
  }
  return await sendMessengerPayload(payload);
}

async function sendSenderAction(psid, action = 'typing_on') {
  const payload = {
    recipient: { id: psid },
    sender_action: action
  };
  return await sendMessengerPayload(payload);
}

// ==========================================
// 5. OPENROUTER AI COMPLETION
// ==========================================

function buildSystemPrompt(customerMem, catalogList) {
  const catalogContext = catalogList.map(item =>
    `- [ID: ${item.id}] ${item.name} | à¦¦à¦¾à¦®: à§³${item.price} | à¦¸à¦•à§‡à¦Ÿ/à¦«à¦¿à¦Ÿà¦®à§‡à¦¨à§à¦Ÿ: ${item.socket} | à¦“à¦¯à¦¼à¦¾à¦°à§‡à¦¨à§à¦Ÿà¦¿: ${item.warranty} | à¦¸à§à¦Ÿà¦•: ${item.stock ? 'à¦‰à¦ªà¦²à¦¬à§à¦§ (In Stock)' : 'à¦¸à§à¦Ÿà¦• à¦¶à§‡à¦·'} | à¦¬à¦°à§à¦£à¦¨à¦¾: ${item.description}`
  ).join('\n');

  return `
à¦¤à§à¦®à¦¿ ImpoTech BD (à¦‡à¦®à§à¦ªà§‹à¦Ÿà§‡à¦• à¦¬à¦¿à¦¡à¦¿)-à¦à¦° à¦…à¦«à¦¿à¦¸à¦¿à¦¯à¦¼à¦¾à¦² à¦ªà§à¦°à¦«à§‡à¦¶à¦¨à¦¾à¦² à¦“ à¦¬à¦¨à§à¦§à§à¦­à¦¾à¦¬à¦¾à¦ªà¦¨à§à¦¨ à¦¬à¦¿à¦•à§à¦°à¦¯à¦¼ à¦à¦¬à¦‚ à¦•à¦¾à¦¸à§à¦Ÿà¦®à¦¾à¦° à¦¸à¦¾à¦ªà§‹à¦°à§à¦Ÿ AI à¦…à§à¦¯à¦¾à¦¸à¦¿à¦¸à§à¦Ÿà§à¦¯à¦¾à¦¨à§à¦Ÿà¥¤
ImpoTech BD à¦¬à¦¾à¦‚à¦²à¦¾à¦¦à§‡à¦¶à§‡à¦° à¦à¦•à¦Ÿà¦¿ à¦¬à¦¿à¦¶à§à¦¬à¦¸à§à¦¤ à¦®à§‹à¦Ÿà¦°à¦¸à¦¾à¦‡à¦•à§‡à¦² à¦“ à¦…à¦Ÿà§‹à¦®à§‹à¦¬à¦¾à¦‡à¦² à¦—à§à¦¯à¦¾à¦œà§‡à¦Ÿ, à¦ªà§à¦°à¦¿à¦®à¦¿à¦¯à¦¼à¦¾à¦® à¦¹à§‡à¦¡à¦²à¦¾à¦‡à¦Ÿ LED, à¦«à¦—à¦²à¦¾à¦‡à¦Ÿ à¦à¦¬à¦‚ à¦†à¦¨à§à¦·à¦¾à¦™à§à¦—à¦¿à¦• à¦ªà¦£à§à¦¯à§‡à¦° à¦¶à¦ªà¥¤

[à¦¡à§‡à¦²à¦¿à¦­à¦¾à¦°à¦¿ à¦šà¦¾à¦°à§à¦œ à¦¸à¦‚à¦•à§à¦°à¦¾à¦¨à§à¦¤ à¦¸à§à¦¨à¦¿à¦°à§à¦¦à¦¿à¦·à§à¦Ÿ à¦¨à¦¿à¦¯à¦¼à¦®]
- à¦—à¦¾à¦œà§€à¦ªà§à¦°: à§³${DELIVERY_CHARGES.GAZIPUR} (à¦Ÿà¦™à§à¦—à§€, à¦šà§Œà¦°à¦¾à¦¸à§à¦¤à¦¾, à¦œà¦¯à¦¼à¦¦à§‡à¦¬à¦ªà§à¦°, à¦¬à§‹à¦°à§à¦¡ à¦¬à¦¾à¦œà¦¾à¦°à¦¸à¦¹ à¦ªà§à¦°à§‹ à¦—à¦¾à¦œà§€à¦ªà§à¦° à¦œà§‡à¦²à¦¾)
- à¦—à¦¾à¦œà§€à¦ªà§à¦°à§‡à¦° à¦¬à¦¾à¦‡à¦°à§‡ (à¦¢à¦¾à¦•à¦¾ à¦“ à¦¸à¦¾à¦°à¦¾ à¦¬à¦¾à¦‚à¦²à¦¾à¦¦à§‡à¦¶): à§³${DELIVERY_CHARGES.OUTSIDE_GAZIPUR}
- à¦•à§à¦¯à¦¾à¦¶ à¦…à¦¨ à¦¡à§‡à¦²à¦¿à¦­à¦¾à¦°à¦¿ (Cash on Delivery) à¦¸à§à¦¬à¦¿à¦§à¦¾ à¦¸à¦¾à¦°à¦¾à¦¦à§‡à¦¶à§‡ à¦‰à¦ªà¦²à¦¬à§à¦§à¥¤

[à¦¹à§‡à¦¡à¦²à¦¾à¦‡à¦Ÿ à¦¸à¦•à§‡à¦Ÿ à¦“ à¦«à¦¿à¦Ÿà¦®à§‡à¦¨à§à¦Ÿ à¦…à¦¤à§à¦¯à¦¨à§à¦¤ à¦•à¦ à§‹à¦° à¦¨à¦¿à¦¯à¦¼à¦®]
- à¦•à¦¾à¦¸à§à¦Ÿà¦®à¦¾à¦° à¦¬à¦¾à¦‡à¦• à¦¬à¦¾ à¦—à¦¾à¦¡à¦¼à¦¿à¦° à¦®à¦¡à§‡à¦² à¦¬à¦²à¦²à§‡ (à¦¯à§‡à¦®à¦¨: R15 V3, FZ-S V2, MT-15, Gixxer, Raider 125, Discover, à¦‡à¦¤à§à¦¯à¦¾à¦¦à¦¿) à¦®à¦¨à¦—à¦¡à¦¼à¦¾ à¦•à§‹à¦¨à§‹ à¦¸à¦•à§‡à¦Ÿ à¦¨à¦¿à¦¶à§à¦šà¦¿à¦¤ à¦•à¦°à¦¬à§‡ à¦¨à¦¾à¥¤
- à¦¸à¦°à§à¦¬à¦¦à¦¾ à¦•à¦¾à¦¸à§à¦Ÿà¦®à¦¾à¦°à¦•à§‡ à¦¤à¦¾à¦¦à§‡à¦° à¦¬à¦¾à¦‡à¦•à§‡à¦° à¦¬à¦°à§à¦¤à¦®à¦¾à¦¨ à¦¬à¦¾à¦²à§à¦¬ à¦¸à¦•à§‡à¦Ÿ (H4, HS1, BA20D à¦‡à¦¤à§à¦¯à¦¾à¦¦à¦¿) à¦¨à¦¿à¦¶à§à¦šà¦¿à¦¤ à¦•à¦°à¦¾à¦° à¦…à¦¨à§à¦°à§‹à¦§ à¦•à¦°à¦¬à§‡ à¦…à¦¥à¦¬à¦¾ à¦¸à§à¦ªà¦·à§à¦Ÿà¦­à¦¾à¦¬à§‡ à¦œà¦¾à¦¨à¦¾à¦¬à§‡ à¦¯à§‡ à¦†à¦®à¦¾à¦¦à§‡à¦° à¦ªà§à¦°à¦¤à¦¿à¦¨à¦¿à¦§à¦¿ à¦«à¦¿à¦Ÿà¦®à§‡à¦¨à§à¦Ÿ à¦“ à¦¸à¦•à§‡à¦Ÿ à¦¨à¦¿à¦¶à§à¦šà¦¿à¦¤ à¦•à¦°à¦¤à§‡ à¦¸à¦¹à¦¾à¦¯à¦¼à¦¤à¦¾ à¦•à¦°à¦¤à§‡ à¦ªà¦¾à¦°à¦¬à§‡à¦¨à¥¤
- à¦•à§‹à¦¨à§‹ à¦…à¦¬à¦¸à§à¦¥à¦¾à¦¤à§‡à¦‡ à¦…à¦¸à¦¤à§à¦¯ à¦¬à¦¾ à¦…à¦¨à§à¦®à¦¾à¦¨à§‡à¦° à¦“à¦ªà¦° à¦«à¦¿à¦Ÿà¦®à§‡à¦¨à§à¦Ÿ à¦•à¦¨à¦«à¦¾à¦°à§à¦®à§‡à¦¶à¦¨ à¦¦à§‡à¦¬à§‡ à¦¨à¦¾à¥¤

[à¦…à¦°à§à¦¡à¦¾à¦° à¦¸à¦‚à¦•à§à¦°à¦¾à¦¨à§à¦¤ à¦¨à¦¿à¦¯à¦¼à¦® - à¦•à§‹à¦¨à§‹ à¦²à§à¦ª à¦¤à§ˆà¦°à¦¿ à¦•à¦°à¦¬à§‡ à¦¨à¦¾]
- à¦•à¦¾à¦¸à§à¦Ÿà¦®à¦¾à¦° à¦¯à¦¦à¦¿ à¦¶à§à¦§à§à¦®à¦¾à¦¤à§à¦° à¦ªà¦£à§à¦¯à§‡à¦° à¦¬à¦¿à¦¬à¦°à¦£, à¦¦à¦¾à¦®, à¦à¦²à¦¾à¦•à¦¾ à¦¬à¦¾ à¦¡à§‡à¦²à¦¿à¦­à¦¾à¦°à¦¿ à¦šà¦¾à¦°à§à¦œ à¦œà¦¾à¦¨à¦¤à§‡ à¦šà¦¾à¦¯à¦¼, à¦¸à¦°à¦¾à¦¸à¦°à¦¿ à¦¤à¦¾à¦° à¦‰à¦¤à§à¦¤à¦° à¦¦à¦¾à¦“à¥¤ à¦…à¦¯à¦¥à¦¾ à¦¬à¦¾à¦°à¦¬à¦¾à¦° à¦¨à¦¾à¦®/à¦ à¦¿à¦•à¦¾à¦¨à¦¾/à¦«à§‹à¦¨ à¦¨à¦®à§à¦¬à¦° à¦šà¦¾à¦‡à¦¬à§‡ à¦¨à¦¾!
- à¦¶à§à¦§à§à¦®à¦¾à¦¤à§à¦° à¦¯à¦–à¦¨ à¦•à¦¾à¦¸à§à¦Ÿà¦®à¦¾à¦° à¦¸à§à¦ªà¦·à§à¦Ÿ à¦¬à¦²à¦¬à§‡ à¦¯à§‡ à¦¸à§‡ "à¦…à¦°à§à¦¡à¦¾à¦° à¦•à¦°à¦¤à§‡ à¦šà¦¾à¦¯à¦¼", "à¦¨à¦¿à¦¤à§‡ à¦šà¦¾à¦¯à¦¼", "à¦¬à§à¦• à¦•à¦°à¦¤à§‡ à¦šà¦¾à¦¯à¦¼" à¦¬à¦¾ "à¦•à¦¨à¦«à¦¾à¦°à§à¦® à¦•à¦°à§à¦¨", à¦¤à¦–à¦¨à¦‡ à¦¨à¦®à§à¦°à¦­à¦¾à¦¬à§‡ à¦¨à¦¾à¦®, à¦ªà§‚à¦°à§à¦£ à¦¡à§‡à¦²à¦¿à¦­à¦¾à¦°à¦¿ à¦ à¦¿à¦•à¦¾à¦¨à¦¾ à¦à¦¬à¦‚ à¦¸à¦šà¦² à¦®à§‹à¦¬à¦¾à¦‡à¦² à¦¨à¦®à§à¦¬à¦° à¦šà¦¾à¦‡à¦¬à§‡à¥¤

[à¦•à¦¾à¦¸à§à¦Ÿà¦®à¦¾à¦° à¦¸à¦¾à¦°à§à¦­à¦¿à¦¸ à¦“ à¦¹à¦¿à¦‰à¦®à§à¦¯à¦¾à¦¨ à¦¹à§à¦¯à¦¾à¦¨à§à¦¡à¦“à¦­à¦¾à¦°]
- à¦•à¦¾à¦¸à§à¦Ÿà¦®à¦¾à¦° à¦¯à¦¦à¦¿ à¦ªà§à¦°à¦¤à¦¿à¦¨à¦¿à¦§à¦¿ à¦¬à¦¾ à¦®à¦¾à¦¨à§à¦·à§‡à¦° à¦¸à¦¾à¦¥à§‡ à¦•à¦¥à¦¾ à¦¬à¦²à¦¤à§‡ à¦šà¦¾à¦¯à¦¼ à¦…à¦¥à¦¬à¦¾ à¦•à§‹à¦¨à§‹ à¦œà¦Ÿà¦¿à¦² à¦¸à¦®à¦¸à§à¦¯à¦¾/à¦“à¦¯à¦¼à¦¾à¦°à§‡à¦¨à§à¦Ÿà¦¿ à¦¸à¦‚à¦•à§à¦°à¦¾à¦¨à§à¦¤ à¦…à¦­à¦¿à¦¯à§‹à¦— à¦•à¦°à§‡, à¦†à¦¨à§à¦¤à¦°à¦¿à¦•à¦­à¦¾à¦¬à§‡ à¦¬à¦²à§‹: "à¦†à¦®à¦¾à¦¦à§‡à¦° à¦à¦•à¦œà¦¨ à¦•à¦¾à¦¸à§à¦Ÿà¦®à¦¾à¦° à¦•à§‡à¦¯à¦¼à¦¾à¦° à¦ªà§à¦°à¦¤à¦¿à¦¨à¦¿à¦§à¦¿ à¦–à§à¦¬ à¦¶à§€à¦˜à§à¦°à¦‡ à¦†à¦ªà¦¨à¦¾à¦° à¦¸à¦¾à¦¥à§‡ à¦‡à¦¨à¦¬à¦•à§à¦¸à§‡ à¦¯à§‹à¦—à¦¾à¦¯à§‹à¦— à¦•à¦°à¦¬à§‡à¦¨à¥¤ à¦…à¦¨à§à¦—à§à¦°à¦¹ à¦•à¦°à§‡ à¦à¦•à¦Ÿà§ à¦¸à¦®à¦¯à¦¼ à¦¦à¦¿à¦¨à¥¤"

[à¦‰à¦ªà¦²à¦¬à§à¦§ à¦ªà§à¦°à§‹à¦¡à¦¾à¦•à§à¦Ÿ à¦•à§à¦¯à¦¾à¦Ÿà¦¾à¦²à¦—]
${catalogContext}

[à¦¬à¦°à§à¦¤à¦®à¦¾à¦¨ à¦•à¦¾à¦¸à§à¦Ÿà¦®à¦¾à¦° à¦ªà§à¦°à§‹à¦«à¦¾à¦‡à¦²]
- à¦ªà§‚à¦°à§à¦¬à¦¬à¦°à§à¦¤à§€ à¦¨à¦¾à¦®: ${customerMem.name || 'à¦…à¦œà¦¾à¦¨à¦¾'}
- à¦«à§‹à¦¨: ${customerMem.phone || 'à¦…à¦œà¦¾à¦¨à¦¾'}
- à¦ à¦¿à¦•à¦¾à¦¨à¦¾: ${customerMem.address || 'à¦…à¦œà¦¾à¦¨à¦¾'}
- à¦¬à¦¾à¦‡à¦•/à¦—à¦¾à¦¡à¦¼à¦¿: ${customerMem.vehicle || 'à¦…à¦œà¦¾à¦¨à¦¾'}

[à¦•à¦¥à§‹à¦ªà¦•à¦¥à¦¨à§‡à¦° à¦­à¦¾à¦·à¦¾ à¦“ à¦Ÿà§‹à¦¨]
- à¦¸à¦°à§à¦¬à¦¦à¦¾ à¦¸à¦¾à¦¬à¦²à§€à¦², à¦ªà§à¦°à¦¾à¦žà§à¦œà¦² à¦“ à¦¸à¦®à§à¦®à¦¾à¦¨à¦œà¦¨à¦• à¦¬à¦¾à¦‚à¦²à¦¾ à¦­à¦¾à¦·à¦¾à¦¯à¦¼ à¦‰à¦¤à§à¦¤à¦° à¦¦à¦¾à¦“à¥¤
- à¦•à§‹à¦¨à§‹ à¦ªà§à¦°à¦•à¦¾à¦° à¦­à§à¦² à¦¬à§à¦¯à¦¾à¦•à¦¸à§à¦²à§à¦¯à¦¾à¦¶ à¦¬à¦¾ à¦…à¦ªà§à¦°à¦¯à¦¼à§‹à¦œà¦¨à§€à¦¯à¦¼ à¦®à¦¾à¦°à§à¦•à¦¡à¦¾à¦‰à¦¨ à¦•à§‹à¦¡ à¦ªà¦°à¦¿à¦¹à¦¾à¦° à¦•à¦°à§‹à¥¤
- à¦‰à¦¤à§à¦¤à¦° à¦¸à¦‚à¦•à§à¦·à¦¿à¦ªà§à¦¤, à¦¤à¦¥à§à¦¯à¦¬à¦¹à§à¦² à¦à¦¬à¦‚ à¦Ÿà§-à¦¦à§à¦¯-à¦ªà¦¯à¦¼à§‡à¦¨à§à¦Ÿ à¦°à¦¾à¦–à§‹à¥¤
`;
}

async function generateAIResponse(psid, userMessage, customerMem) {
  if (!OPENROUTER_API_KEY) {
    return 'à¦†à¦®à¦¾à¦¦à§‡à¦° à¦à¦†à¦‡ à¦¸à¦¿à¦¸à§à¦Ÿà§‡à¦® à¦•à¦¨à¦«à¦¿à¦—à¦¾à¦°à§‡à¦¶à¦¨ à¦†à¦ªà¦¡à§‡à¦Ÿ à¦¹à¦šà§à¦›à§‡à¥¤ à¦…à¦¨à§à¦—à§à¦°à¦¹ à¦•à¦°à§‡ à¦à¦•à¦Ÿà§ à¦ªà¦° à¦†à¦¬à¦¾à¦° à¦šà§‡à¦·à§à¦Ÿà¦¾ à¦•à¦°à§à¦¨ à¦…à¦¥à¦¬à¦¾ à¦†à¦®à¦¾à¦¦à§‡à¦° à¦ªà§à¦°à¦¤à¦¿à¦¨à¦¿à¦§à¦¿ à¦¶à§€à¦˜à§à¦°à¦‡ à¦†à¦ªà¦¨à¦¾à¦° à¦¸à¦¾à¦¥à§‡ à¦¯à§‹à¦—à¦¾à¦¯à§‹à¦— à¦•à¦°à¦¬à§‡à¦¨à¥¤';
  }

  const systemPrompt = buildSystemPrompt(customerMem, state.catalogs || []);
  const messagesHistory = (customerMem.history || []).slice(-8).map(h => ({
    role: h.role === 'customer' ? 'user' : 'assistant',
    content: h.text
  }));

  const payload = {
    model: OPENROUTER_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messagesHistory,
      { role: 'user', content: userMessage }
    ],
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.6
  };

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://impotechbd.com',
        'X-Title': 'ImpoTech BD Messenger Bot'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.choices && data.choices.length > 0 && data.choices[0].message) {
      return data.choices[0].message.content.trim();
    } else {
      console.error('[OpenRouter Response Error]:', JSON.stringify(data));
      return 'à¦§à¦¨à§à¦¯à¦¬à¦¾à¦¦ à¦†à¦ªà¦¨à¦¾à¦° à¦¬à¦¾à¦°à§à¦¤à¦¾à¦° à¦œà¦¨à§à¦¯à¥¤ à¦†à¦ªà¦¨à¦¾à¦° à¦…à¦¨à§à¦°à§‹à¦§à¦Ÿà¦¿ à¦ªà§à¦°à¦•à§à¦°à¦¿à¦¯à¦¼à¦¾à¦§à§€à¦¨ à¦°à¦¯à¦¼à§‡à¦›à§‡, à¦†à¦®à¦¾à¦¦à§‡à¦° à¦ªà§à¦°à¦¤à¦¿à¦¨à¦¿à¦§à¦¿ à¦¶à§€à¦˜à§à¦°à¦‡ à¦†à¦ªà¦¨à¦¾à¦° à¦¸à¦¾à¦¥à§‡ à¦¯à§‹à¦—à¦¾à¦¯à§‹à¦— à¦•à¦°à¦¬à§‡à¦¨à¥¤';
    }
  } catch (err) {
    console.error('[OpenRouter API Exception]:', err.message);
    return 'à¦§à¦¨à§à¦¯à¦¬à¦¾à¦¦! à¦†à¦®à¦¾à¦¦à§‡à¦° à¦•à¦¾à¦¸à§à¦Ÿà¦®à¦¾à¦° à¦•à§‡à¦¯à¦¼à¦¾à¦° à¦ªà§à¦°à¦¤à¦¿à¦¨à¦¿à¦§à¦¿ à¦‡à¦¨à¦¬à¦•à§à¦¸à§‡ à¦†à¦ªà¦¨à¦¾à¦° à¦¸à¦¾à¦¥à§‡ à¦¸à¦°à¦¾à¦¸à¦°à¦¿ à¦•à¦¥à¦¾ à¦¬à¦²à¦¬à§‡à¦¨à¥¤';
  }
}

// ==========================================
// 6. ECHO & ADMIN TAKEOVER COMMAND HANDLER
// ==========================================

async function handleEchoEvent(event) {
  const message = event.message;
  const customerPsid = event.recipient ? event.recipient.id : null;
  const text = message && message.text ? message.text.trim() : '';

  if (!customerPsid) return;

  const lowerText = text.toLowerCase();
  console.log(`[Echo Handler] Echo detected for PSID: ${customerPsid} | Text: "${text}"`);

  // Admin takeover activation commands
  if (['.human', '.stop', '.pause', '.handover', '.off', '.admin'].includes(lowerText)) {
    state.takeovers[customerPsid] = {
      active: true,
      reason: 'Admin command in Meta Business Suite (' + lowerText + ')',
      updatedBy: 'Admin (Page Echo)',
      timestamp: Date.now()
    };
    state.metrics.human_takeovers += 1;
    await persistState(['takeovers', 'metrics']);
    console.log(`[Takeover] Human Takeover ACTIVATED for ${customerPsid} via echo command.`);
    return;
  }

  // Admin AI resume commands
  if (['.ai', '.start', '.resume', '.on', '.bot'].includes(lowerText)) {
    state.takeovers[customerPsid] = {
      active: false,
      reason: 'AI Resumed by admin echo command (' + lowerText + ')',
      updatedBy: 'Admin (Page Echo)',
      timestamp: Date.now()
    };
    if (state.customer_memories[customerPsid]) {
      state.customer_memories[customerPsid].retryCount = 0;
    }
    await persistState(['takeovers', 'customer_memories']);
    console.log(`[Takeover] AI Bot RESUMED for ${customerPsid} via echo command.`);
    return;
  }

  // If admin sends a manual reply (not starting with command), automatically pause AI
  if (text && !text.startsWith('.')) {
    state.takeovers[customerPsid] = {
      active: true,
      reason: 'Admin replied manually from Page Inbox',
      updatedBy: 'Admin (Manual Echo)',
      timestamp: Date.now()
    };
    await persistState(['takeovers']);
  }
}

// ==========================================
// 7. INBOUND MESSAGE & ORDER PIPELINE
// ==========================================

async function handleInboundMessage(event) {
  const senderPsid = event.sender.id;
  const message = event.message;
  state.metrics.total_messages += 1;

  let userText = '';
  if (message.text) {
    userText = message.text.trim();
  } else if (message.quick_reply && message.quick_reply.payload) {
    userText = message.quick_reply.payload.trim();
  } else if (message.attachments) {
    userText = '[Attachment received: ' + message.attachments.map(a => a.type).join(', ') + ']';
  }

  if (!userText) return;

  console.log(`[Inbound Message] PSID: ${senderPsid} | Content: "${userText}"`);

  // Initialize or retrieve customer memory
  if (!state.customer_memories[senderPsid]) {
    state.customer_memories[senderPsid] = {
      name: '',
      phone: '',
      address: '',
      vehicle: '',
      socket: '',
      retryCount: 0,
      history: [],
      lastActivity: Date.now()
    };
  }
  const cust = state.customer_memories[senderPsid];
  cust.lastActivity = Date.now();

  // 1. Check if user is currently under Human Takeover
  const takeover = state.takeovers[senderPsid];
  if (takeover && takeover.active) {
    console.log(`[Takeover Active] Skipping AI response for ${senderPsid}. Controlled by human.`);
    cust.history.push({ role: 'customer', text: userText, timestamp: Date.now() });
    await persistState(['customer_memories']);
    return;
  }

  // 2. Global Human Handover Request by Customer
  if (isHumanHandoverRequest(userText)) {
    state.takeovers[senderPsid] = {
      active: true,
      reason: 'Customer requested human agent',
      updatedBy: 'Customer Request',
      timestamp: Date.now()
    };
    state.metrics.human_takeovers += 1;
    cust.history.push({ role: 'customer', text: userText, timestamp: Date.now() });

    const handoverReply = 'à¦œà¦¿ à¦…à¦¬à¦¶à§à¦¯à¦‡! à¦†à¦®à¦¾à¦¦à§‡à¦° à¦à¦•à¦œà¦¨ à¦•à¦¾à¦¸à§à¦Ÿà¦®à¦¾à¦° à¦•à§‡à¦¯à¦¼à¦¾à¦° à¦ªà§à¦°à¦¤à¦¿à¦¨à¦¿à¦§à¦¿ à¦–à§à¦¬ à¦¶à§€à¦˜à§à¦°à¦‡ à¦†à¦ªà¦¨à¦¾à¦° à¦¸à¦¾à¦¥à§‡ à¦¸à¦°à¦¾à¦¸à¦°à¦¿ à¦à¦‡ à¦šà§à¦¯à¦¾à¦Ÿà§‡ à¦¯à§à¦•à§à¦¤ à¦¹à¦šà§à¦›à§‡à¦¨à¥¤ à¦¦à¦¯à¦¼à¦¾ à¦•à¦°à§‡ à¦•à¦¿à¦›à§à¦•à§à¦·à¦£ à¦…à¦ªà§‡à¦•à§à¦·à¦¾ à¦•à¦°à§à¦¨à¥¤';
    await sendTextMessage(senderPsid, handoverReply);
    cust.history.push({ role: 'bot', text: handoverReply, timestamp: Date.now() });
    await persistState(['takeovers', 'customer_memories', 'metrics']);
    return;
  }

  // 3. Critical Complaint or High-Priority Issue Handover
  if (isCriticalComplaint(userText)) {
    state.takeovers[senderPsid] = {
      active: true,
      reason: 'Critical complaint / dispute / return claim detected',
      updatedBy: 'Critical Filter',
      timestamp: Date.now()
    };
    state.metrics.human_takeovers += 1;
    cust.history.push({ role: 'customer', text: userText, timestamp: Date.now() });

    const complaintReply = 'à¦†à¦ªà¦¨à¦¾à¦° à¦¬à¦¾à¦°à§à¦¤à¦¾à¦Ÿà¦¿à¦° à¦—à§à¦°à§à¦¤à§à¦¬ à¦¸à¦¹à¦•à¦¾à¦°à§‡ à¦¬à¦¿à¦¬à§‡à¦šà¦¨à¦¾ à¦•à¦°à¦¾ à¦¹à¦šà§à¦›à§‡à¥¤ à¦†à¦®à¦¾à¦¦à§‡à¦° à¦¸à¦¿à¦¨à¦¿à¦¯à¦¼à¦° à¦¸à¦¾à¦ªà§‹à¦°à§à¦Ÿ à¦Ÿà¦¿à¦® à¦…à¦¤à¦¿ à¦¦à§à¦°à§à¦¤ à¦†à¦ªà¦¨à¦¾à¦° à¦‡à¦¨à¦¬à¦•à§à¦¸à§‡ à¦¯à§‹à¦—à¦¾à¦¯à§‹à¦— à¦•à¦°à§‡ à¦¸à¦®à¦¾à¦§à¦¾à¦¨ à¦¨à¦¿à¦¶à§à¦šà¦¿à¦¤ à¦•à¦°à¦¬à§‡à¥¤';
    await sendTextMessage(senderPsid, complaintReply);
    cust.history.push({ role: 'bot', text: complaintReply, timestamp: Date.now() });
    await persistState(['takeovers', 'customer_memories', 'metrics']);
    return;
  }

  // 4. Extract data (Phone, address, zone) if provided
  const foundPhone = extractPhoneNumber(userText);
  if (foundPhone) cust.phone = foundPhone;

  // 5. Intent-First Order Creation Check
  if (isExplicitOrderIntent(userText) || (cust.phone && userText.length > 15 && !cust.address)) {
    if (foundPhone && userText.length > 20) {
      cust.address = userText;
      const zoneInfo = detectDeliveryZone(userText);

      const orderId = 'IMP-' + Date.now().toString().slice(-6);
      const newOrder = {
        orderId,
        psid: senderPsid,
        phone: cust.phone,
        address: cust.address,
        zone: zoneInfo.zone,
        deliveryCharge: zoneInfo.charge,
        status: 'PENDING_CONFIRMATION',
        createdAt: new Date().toISOString()
      };
      state.orders.push(newOrder);
      state.metrics.orders_created += 1;

      const orderConfirmMsg = `à¦§à¦¨à§à¦¯à¦¬à¦¾à¦¦! à¦†à¦ªà¦¨à¦¾à¦° à¦…à¦°à§à¦¡à¦¾à¦°à§‡à¦° à¦¤à¦¥à§à¦¯ à¦—à§à¦°à¦¹à¦£ à¦•à¦°à¦¾ à¦¹à¦¯à¦¼à§‡à¦›à§‡à¥¤\n\nà¦…à¦°à§à¦¡à¦¾à¦° à¦†à¦‡à¦¡à¦¿: #${orderId}\nà¦«à§‹à¦¨: ${cust.phone}\nà¦¡à§‡à¦²à¦¿à¦­à¦¾à¦°à¦¿ à¦²à§‹à¦•à§‡à¦¶à¦¨: ${zoneInfo.label} (à¦šà¦¾à¦°à§à¦œ: à§³${zoneInfo.charge})\n\nà¦†à¦®à¦¾à¦¦à§‡à¦° à¦à¦•à¦œà¦¨ à¦ªà§à¦°à¦¤à¦¿à¦¨à¦¿à¦§à¦¿ à¦¦à§à¦°à§à¦¤ à¦†à¦ªà¦¨à¦¾à¦° à¦¸à¦¾à¦¥à§‡ à¦¯à§‹à¦—à¦¾à¦¯à§‹à¦— à¦•à¦°à§‡ à¦ªà¦£à§à¦¯ à¦à¦¬à¦‚ à¦¡à§‡à¦²à¦¿à¦­à¦¾à¦°à¦¿ à¦•à¦¨à¦«à¦¾à¦°à§à¦® à¦•à¦°à¦¬à§‡à¦¨à¥¤`;
      await sendTextMessage(senderPsid, orderConfirmMsg, [
        { title: 'à¦ªà§à¦°à¦¤à¦¿à¦¨à¦¿à¦§à¦¿à¦° à¦¸à¦¾à¦¥à§‡ à¦•à¦¥à¦¾', payload: 'à¦®à¦¾à¦¨à§à¦·à§‡à¦° à¦¸à¦¾à¦¥à§‡ à¦•à¦¥à¦¾ à¦¬à¦²à¦¤à§‡ à¦šà¦¾à¦‡' },
        { title: 'à¦†à¦°à¦“ à¦ªà§à¦°à§‹à¦¡à¦¾à¦•à§à¦Ÿ à¦¦à§‡à¦–à§à¦¨', payload: 'à¦ªà§à¦°à§‹à¦¡à¦¾à¦•à§à¦Ÿ à¦¤à¦¾à¦²à¦¿à¦•à¦¾ à¦¦à§‡à¦–à¦¤à§‡ à¦šà¦¾à¦‡' }
      ]);

      cust.history.push({ role: 'customer', text: userText, timestamp: Date.now() });
      cust.history.push({ role: 'bot', text: orderConfirmMsg, timestamp: Date.now() });
      await persistState(['orders', 'customer_memories', 'metrics']);
      return;
    }
  }

  // 6. Show typing indicator and generate AI response
  await sendSenderAction(senderPsid, 'typing_on');

  cust.history.push({ role: 'customer', text: userText, timestamp: Date.now() });
  const aiResponse = await generateAIResponse(senderPsid, userText, cust);

  await sendTextMessage(senderPsid, aiResponse, [
    { title: 'à¦…à¦°à§à¦¡à¦¾à¦° à¦•à¦°à¦¤à§‡ à¦šà¦¾à¦‡', payload: 'à¦†à¦®à¦¿ à¦…à¦°à§à¦¡à¦¾à¦° à¦•à¦°à¦¤à§‡ à¦šà¦¾à¦‡' },
    { title: 'à¦ªà§à¦°à¦¤à¦¿à¦¨à¦¿à¦§à¦¿ à¦¸à¦¾à¦ªà§‹à¦°à§à¦Ÿ', payload: 'à¦®à¦¾à¦¨à§à¦·à§‡à¦° à¦¸à¦¾à¦¥à§‡ à¦•à¦¥à¦¾ à¦¬à¦²à¦¤à§‡ à¦šà¦¾à¦‡' }
  ]);

  cust.history.push({ role: 'bot', text: aiResponse, timestamp: Date.now() });
  state.metrics.ai_replies += 1;

  // Track fallback count if response indicates confusion
  if (aiResponse.includes('à¦ªà§à¦°à¦¤à¦¿à¦¨à¦¿à¦§à¦¿ à¦¶à§€à¦˜à§à¦°à¦‡ à¦†à¦ªà¦¨à¦¾à¦° à¦¸à¦¾à¦¥à§‡') && !isHumanHandoverRequest(userText)) {
    cust.retryCount = (cust.retryCount || 0) + 1;
    if (cust.retryCount >= 2) {
      state.takeovers[senderPsid] = {
        active: true,
        reason: 'Fallback retry count exceeded (2 failed attempts)',
        updatedBy: 'Auto Handover Guard',
        timestamp: Date.now()
      };
      console.log(`[Auto Handover] Takeover initiated for ${senderPsid} due to retryCount >= 2`);
    }
  } else {
    cust.retryCount = 0;
  }

  await persistState(['customer_memories', 'takeovers', 'metrics']);
}

// ==========================================
// 8. EXPRESS ROUTES & WEBHOOKS
// ==========================================

// Health Check
app.get('/', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'ImpoTech BD Messenger AI & Admin Backend',
    uptime_seconds: process.uptime(),
    metrics: state.metrics,
    openrouter_model: OPENROUTER_MODEL,
    delivery_charges: DELIVERY_CHARGES,
    catalogs_count: state.catalogs.length,
    active_takeovers: Object.values(state.takeovers).filter(t => t.active).length
  });
});

// Facebook Webhook Verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('[Webhook] Verification SUCCESS!');
      res.status(200).send(challenge);
    } else {
      console.warn('[Webhook] Verification FAILED. Token mismatch.');
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Facebook Webhook Events (POST)
app.post('/webhook', (req, res) => {
  const body = req.body;
  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');

    body.entry.forEach(entry => {
      const webhookEvent = entry.messaging ? entry.messaging[0] : null;
      if (!webhookEvent) return;

      // Handle Echo Events from Meta Business Suite / Page Inbox
      if (webhookEvent.message && webhookEvent.message.is_echo) {
        handleEchoEvent(webhookEvent).catch(err => console.error('[Echo Error]:', err));
        return;
      }

      // Handle Inbound Customer Messages & Postbacks
      if (webhookEvent.message || webhookEvent.postback) {
        handleInboundMessage(webhookEvent).catch(err => console.error('[Inbound Error]:', err));
      }
    });
  } else {
    res.sendStatus(404);
  }
});

// ==========================================
// 9. ADMIN ENDPOINTS & MANAGEMENT APIS
// ==========================================

// Simple Auth Middleware
function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'] || req.query.secret;
  if (authHeader && (authHeader === ADMIN_SECRET || authHeader === `Bearer ${ADMIN_SECRET}`)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized: Invalid Admin Secret' });
}

// 9.1 Get / Set Takeovers
app.get('/admin/takeovers', requireAdmin, (req, res) => {
  res.json({
    takeovers: state.takeovers,
    active_count: Object.values(state.takeovers).filter(t => t.active).length
  });
});

app.post('/admin/takeover/:psid', requireAdmin, async (req, res) => {
  const psid = req.params.psid;
  const { active, reason } = req.body;
  state.takeovers[psid] = {
    active: !!active,
    reason: reason || (active ? 'Admin dashboard manual takeover' : 'Admin dashboard resumed AI'),
    updatedBy: 'Admin API',
    timestamp: Date.now()
  };
  await persistState(['takeovers']);
  res.json({ success: true, psid, takeover: state.takeovers[psid] });
});

// 9.2 Catalog Management & GitHub Sync
app.get('/admin/catalog', requireAdmin, (req, res) => {
  res.json({ catalogs: state.catalogs });
});

app.post('/admin/catalog', requireAdmin, async (req, res) => {
  const { catalogs } = req.body;
  if (!Array.isArray(catalogs)) {
    return res.status(400).json({ error: 'catalogs must be an array' });
  }
  state.catalogs = catalogs;
  await persistState(['catalogs']);
  res.json({ success: true, count: state.catalogs.length });
});

app.post('/admin/sync-github', requireAdmin, async (req, res) => {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(400).json({ error: 'GITHUB_TOKEN or GITHUB_REPO not configured in environment' });
  }
  try {
    const ghUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_CATALOG_PATH}`;
    const ghRes = await fetch(ghUrl, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'ImpoTech-Messenger-Bot'
      }
    });
    const ghData = await ghRes.json();
    if (ghData.content) {
      const decoded = Buffer.from(ghData.content, 'base64').toString('utf-8');
      const catalogData = JSON.parse(decoded);
      if (Array.isArray(catalogData)) {
        state.catalogs = catalogData;
        await persistState(['catalogs']);
        return res.json({ success: true, source: 'github', count: state.catalogs.length });
      }
    }
    return res.status(500).json({ error: 'Invalid GitHub response format', ghData });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 9.3 Orders List & Status Update
app.get('/admin/orders', requireAdmin, (req, res) => {
  res.json({ orders: state.orders });
});

app.post('/admin/order/:orderId/status', requireAdmin, async (req, res) => {
  const orderId = req.params.orderId;
  const { status } = req.body;
  const order = state.orders.find(o => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.status = status;
  order.updatedAt = new Date().toISOString();
  await persistState(['orders']);
  res.json({ success: true, order });
});

// 9.4 Campaign Tracking Dashboard & API
app.get('/admin/campaign-tracking', requireAdmin, (req, res) => {
  res.json({
    campaigns: state.campaign_tracking,
    metrics: state.metrics
  });
});

// ==========================================
// 10. SERVER STARTUP
// ==========================================
app.listen(PORT, async () => {
  console.log(`=================================================`);
  console.log(`ðŸš€ ImpoTech BD Messenger Bot running on port ${PORT}`);
  console.log(`ðŸ“¡ OpenRouter Model: ${OPENROUTER_MODEL}`);
  console.log(`ðŸšš Delivery Charges: Gazipur à§³${DELIVERY_CHARGES.GAZIPUR}, Outside Gazipur à§³${DELIVERY_CHARGES.OUTSIDE_GAZIPUR}`);
  console.log(`ðŸ›¡ï¸  Human Handover & Echo Command Handler: ACTIVE`);
  console.log(`=================================================`);
  await initDatabase();
});
