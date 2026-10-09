const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS Middleware (মোবাইল অ্যাপ ও ব্রাউজার এক্সেসের জন্য)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-secret');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// -------------------------------------------------------------
// ১. কনফিগারেশন ও এনভায়রনমেন্ট ভেরিয়েবল
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'impotech_secret_token_123';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || '';
const META_PAGE_ID = process.env.META_PAGE_ID || process.env.PAGE_ID || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'impotechaibot/Impotech-bot';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_FILE_PATH = process.env.GITHUB_FILE_PATH || 'data/catalog.json';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'impotech_secret_token_123';

const CATALOG_FILE = path.join(__dirname, 'catalog.json');
const DATA_FILE = path.join(__dirname, 'storage_data.json');

// -------------------------------------------------------------
// ২. লোকাল ডাটাবেজ / স্টোরেজ
// -------------------------------------------------------------
let db = {
  isGlobalPaused: false,
  takeovers: {}, // { [senderId]: { isPaused: boolean, reason: string, timestamp: string } }
  customers: {},
  messages: [],
  orders: []
};

function loadStorage() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('⚠️ storage_data.json লোড এরর:', err.message);
  }
}

function saveStorage() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('❌ storage_data.json সেভ এরর:', err.message);
  }
}
loadStorage();

function loadCatalog() {
  try {
    if (fs.existsSync(CATALOG_FILE)) {
      return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('⚠️ catalog.json লোড এরর:', err.message);
  }
  return { products: [], faqs: [] };
}

function saveCatalog(data) {
  try {
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('❌ catalog.json সেভ এরর:', err.message);
  }
}

// -------------------------------------------------------------
// ৩. হিউম্যান টেকওভার কোর লজিক
// -------------------------------------------------------------
function getTakeoverState(customerId) {
  if (!customerId) return db.isGlobalPaused;
  const id = String(customerId).trim();
  if (db.isGlobalPaused) return true;
  if (db.takeovers[id] && typeof db.takeovers[id].isPaused === 'boolean') {
    return db.takeovers[id].isPaused;
  }
  if (db.customers[id] && typeof db.customers[id].takeover === 'boolean') {
    return db.customers[id].takeover;
  }
  return false;
}

async function setTakeoverState(customerId, enabled, reasonStr) {
  if (!customerId) return false;
  const id = String(customerId).trim();
  const isEnabled = Boolean(enabled);
  const reason = reasonStr || (isEnabled ? 'Admin takeover' : 'Admin resumed AI');

  db.takeovers[id] = {
    isPaused: isEnabled,
    reason: reason,
    timestamp: new Date().toISOString()
  };

  if (!db.customers[id]) {
    db.customers[id] = {
      id: id,
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
  console.log(`[Takeover] গ্রাহক ${id} -> টেকওভার: ${isEnabled ? 'ON (বট বন্ধ)' : 'OFF (বট চালু)'}`);
  return isEnabled;
}

// -------------------------------------------------------------
// ৪. মেটা মেসেঞ্জার ওয়েবহুক (Webhooks)
// -------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object === 'page') {
      const entries = body.entry || [];
      for (const entry of entries) {
        const messaging = entry.messaging || [];
        for (const event of messaging) {
          const senderId = event.sender?.id;
          if (senderId && event.message && event.message.text) {
            const text = event.message.text;
            const isPaused = getTakeoverState(senderId);

            // ডাটাবেজে বার্তা সংরক্ষণ
            db.messages.push({
              id: 'msg_' + Date.now(),
              senderId: senderId,
              sender: 'customer',
              text: text,
              timestamp: new Date().toISOString()
            });

            if (!db.customers[senderId]) {
              db.customers[senderId] = {
                id: senderId,
                name: 'Customer ' + senderId.slice(-4),
                messageCount: 1,
                lastActive: new Date().toISOString(),
                isPaused: isPaused,
                takeover: isPaused
              };
            } else {
              db.customers[senderId].messageCount = (db.customers[senderId].messageCount || 0) + 1;
              db.customers[senderId].lastActive = new Date().toISOString();
            }
            saveStorage();

            // ⚠️ টেকওভার সক্রিয় থাকলে বট উত্তর দেবে না
            if (isPaused) {
              console.log(`[Takeover] গ্রাহক ${senderId}-এর জন্য টেকওভার সক্রিয়। এআই উত্তর স্থগিত।`);
            } else {
              console.log(`[AI Active] বার্তা এসেছে: "${text}"। বট স্বাভাবিক উত্তর দেবে।`);
              // এখানে আপনার এআই রিপ্লাই লজিক কাজ করবে
            }
          }
        }
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    return res.status(200).send('EVENT_RECEIVED');
  }
});

// -------------------------------------------------------------
// ৫. ক্যাটালগ ও গিটহাব সিঙ্ক API এন্ডপয়েন্টস
// -------------------------------------------------------------
app.get('/api/catalog', (req, res) => {
  const cat = loadCatalog();
  res.json({ success: true, catalog: cat, products: cat.products || [], faqs: cat.faqs || [] });
});

app.post('/api/catalog/sync', async (req, res) => {
  try {
    const catalogData = req.body;
    saveCatalog(catalogData);
    res.json({ success: true, message: 'ক্যাটালগ সফলভাবে সিঙ্ক হয়েছে!' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// সরাসরি গিটহাব ক্যাটালগ আপলোড এন্ডপয়েন্ট
app.post('/api/github/upload', async (req, res) => {
  try {
    const { catalog, githubRepo, githubBranch, githubToken, githubFilePath } = req.body;
    const targetCatalog = catalog || loadCatalog();
    const token = githubToken || GITHUB_TOKEN;
    const repo = githubRepo || GITHUB_REPO;
    const branch = githubBranch || GITHUB_BRANCH;
    const filePath = githubFilePath || GITHUB_FILE_PATH;

    if (!token) {
      return res.status(400).json({ success: false, message: 'GitHub Token পাওয়া যায়নি।' });
    }

    const url = `https://api.github.com/repos/${repo}/contents/${filePath}`;
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Impotech-Admin-App'
    };

    let sha = null;
    try {
      const getRes = await axios.get(`${url}?ref=${branch}`, { headers, timeout: 10000 });
      if (getRes.data && getRes.data.sha) sha = getRes.data.sha;
    } catch (_) {}

    const fileContentBase64 = Buffer.from(JSON.stringify(targetCatalog, null, 2), 'utf8').toString('base64');
    const payload = {
      message: `Upload Catalog v${targetCatalog.version || Date.now()} via Impotech Admin`,
      content: fileContentBase64,
      branch: branch
    };
    if (sha) payload.sha = sha;

    await axios.put(url, payload, { headers, timeout: 15000 });
    saveCatalog(targetCatalog);

    res.json({
      success: true,
      message: `ক্যাটালগ সফলভাবে গিটহাবে আপলোড হয়েছে! (${repo}@${branch})`
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// -------------------------------------------------------------
// ৬. হিউম্যান টেকওভার ও গ্রাহক কন্ট্রোল API
// -------------------------------------------------------------
// গ্লোবাল বট কন্ট্রোল
app.get('/api/bot-status', (req, res) => {
  res.json({ success: true, isGlobalPaused: !!db.isGlobalPaused });
});

app.post('/api/toggle-bot', (req, res) => {
  db.isGlobalPaused = !!req.body.isPaused;
  saveStorage();
  res.json({ success: true, isGlobalPaused: db.isGlobalPaused });
});

// প্রতিটি কাস্টমারের জন্য টেকওভার টগল
app.post('/api/customers/:senderId/takeover', async (req, res) => {
  const { senderId } = req.params;
  const isPaused = req.body.isPaused !== undefined ? !!req.body.isPaused : (req.body.takeover !== undefined ? !!req.body.takeover : true);
  await setTakeoverState(senderId, isPaused, req.body.reason);
  res.json({ success: true, senderId, isPaused, takeover: isPaused });
});

app.get('/api/customers/:senderId/status', (req, res) => {
  const { senderId } = req.params;
  const isPaused = getTakeoverState(senderId);
  res.json({ success: true, senderId, isPaused, takeover: isPaused });
});

// গ্রাহক তালিকা
app.get('/api/customers', (req, res) => {
  const list = Object.values(db.customers).map(c => ({
    senderId: c.id,
    displayName: c.name || `Customer ${c.id.slice(-4)}`,
    phone: c.phone || null,
    lastMessageText: c.lastMessageText || null,
    lastMessageAt: c.lastActive || null,
    takeover: getTakeoverState(c.id),
    isPaused: getTakeoverState(c.id)
  }));
  res.json({ success: true, data: list });
});

// অ্যাডমিন সরাসরি মেসেজ পাঠানো
app.post('/api/customers/:senderId/send', (req, res) => {
  const { senderId } = req.params;
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });

  db.messages.push({
    id: 'msg_adm_' + Date.now(),
    senderId,
    sender: 'admin',
    text,
    timestamp: new Date().toISOString()
  });
  saveStorage();
  res.json({ success: true, message: 'Message sent by admin' });
});

// হেলথ চেক
app.get('/health', (req, res) => res.status(200).json({ success: true, status: "ok" }));
app.get('/api/health', (req, res) => res.status(200).json({ status: 'LIVE_PRODUCTION', isGlobalPaused: db.isGlobalPaused }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
