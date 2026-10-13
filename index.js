/**
 * ImpoTech AI Messenger Bot — server.js
 * Node.js 20+ | Express | OpenRouter Gemini 3.1 Flash-Lite | Meta Messenger | Render
 *
 * Required Render environment variables:
 *   PAGE_ACCESS_TOKEN       Facebook Page access token
 *   VERIFY_TOKEN            Custom webhook verification token
 *   OPENROUTER_API_KEY      OpenRouter API key
 *   ADMIN_TOKEN             Long random secret for protected admin endpoints
 *
 * Recommended:
 *   LINKUP_API_KEY          Linkup API key for live vehicle socket research
 *   OPENROUTER_MODEL        google/gemini-3.1-flash-lite (default)
 *   GRAPH_API_VERSION       v23.0 (or a version supported by your Meta app)
 *   GITHUB_CATALOG_URL      Optional URL returning a JSON product/catalog array
 *   HUMAN_PHONE             Customer-facing support phone number
 *   DATA_FILE               Persistent-disk path for storage_data.json
 *   PORT                    Supplied by Render automatically
 *
 * Render notes:
 * - Use Node 20+.
 * - Start command: node server.js
 * - Add secrets in Render Environment, never commit them to Git.
 * - Render's local disk can be ephemeral. Attach a persistent disk and set
 *   DATA_FILE to its mount path if customer data must survive deploys.
 * - Meta Messenger Page webhooks do not normally deliver ordinary phone-call
 *   events. /webhook accepts call-like events only if an integrated provider
 *   actually sends them; real calls require a telephony integration.
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 10000);
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-3.1-flash-lite';
const LINKUP_API_KEY = process.env.LINKUP_API_KEY || '';
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v23.0';
const GITHUB_CATALOG_URL = process.env.GITHUB_CATALOG_URL || '';
const HUMAN_PHONE = process.env.HUMAN_PHONE || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'storage_data.json');

const RETENTION_MS = 20 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 80;
const MAX_REPLY_LINES = 5;

const isoNow = () => new Date().toISOString();
const now = () => Date.now();
const clean = (value, max = 4000) => String(value ?? '').trim().slice(0, max);
const normalize = value => clean(value).toLowerCase().replace(/\s+/g, ' ').trim();

const BUILTIN_VEHICLE_DATABASE = [
  {
    terms: ['pulsar', 'bajaj pulsar', 'pulsar 150', 'pulsar 180', 'pulsar ns', 'pulsar n160', 'pulsar n250'],
    make: 'Bajaj', models: 'Pulsar series',
    socket: 'মডেল, বছর ও ভ্যারিয়েন্ট অনুযায়ী সকেট যাচাই প্রয়োজন',
    confidence: 'needs_verification'
  },
  {
    terms: ['fz', 'yamaha fz', 'fz-s', 'fz v2', 'fz v3', 'fz fi'],
    make: 'Yamaha', models: 'FZ series',
    socket: 'মডেল, বছর ও ভ্যারিয়েন্ট অনুযায়ী সকেট যাচাই প্রয়োজন',
    confidence: 'needs_verification'
  },
  {
    terms: ['apache', 'tvs apache', 'apache rtr', 'apache 160', 'apache 200'],
    make: 'TVS', models: 'Apache series',
    socket: 'মডেল, বছর ও ভ্যারিয়েন্ট অনুযায়ী সকেট যাচাই প্রয়োজন',
    confidence: 'needs_verification'
  },
  {
    terms: ['axio', 'toyota axio', 'corolla axio'],
    make: 'Toyota', models: 'Axio',
    socket: 'গ্রেড, বছর ও হেডলাইট ইউনিট অনুযায়ী সকেট যাচাই প্রয়োজন',
    confidence: 'needs_verification'
  },
  {
    terms: ['premio', 'toyota premio'],
    make: 'Toyota', models: 'Premio',
    socket: 'গ্রেড, বছর ও হেডলাইট ইউনিট অনুযায়ী সকেট যাচাই প্রয়োজন',
    confidence: 'needs_verification'
  },
  {
    terms: ['hiace', 'toyota hiace'],
    make: 'Toyota', models: 'HiAce',
    socket: 'মডেল, বছর ও হেডলাইট ইউনিট অনুযায়ী সকেট যাচাই প্রয়োজন',
    confidence: 'needs_verification'
  },
  {
    terms: ['cng', 'cng auto', 'cng auto rickshaw', 'auto rickshaw', 'অটো', 'সিএনজি'],
    make: 'Various', models: 'CNG/Auto-rickshaw',
    socket: 'গাড়ির হেডলাইট ইউনিট ও প্লাগ দেখে যাচাই প্রয়োজন',
    confidence: 'needs_verification'
  },
  {
    terms: ['private car', 'car', 'bus', 'truck', 'প্রাইভেট কার', 'বাস', 'ট্রাক'],
    make: 'Various', models: 'Vehicle category',
    socket: 'শুধু H4/3-pin (P43t/PX43t) প্লাগ হলে ব্যবহারযোগ্য',
    confidence: 'conditional'
  }
];

const DEFAULT_FAQ = [
  {
    q: 'কোন গাড়িতে লাগবে',
    a: 'এই হেডলাইট H4/3-pin (P43t/PX43t) সকেটের জন্য। আপনার গাড়ির প্লাগ মিলিয়ে নিশ্চিত হতে হবে।'
  },
  {
    q: 'ইউনিভার্সাল কি না',
    a: 'এটি H4/3-pin প্লাগে ব্যবহারযোগ্য; সব গাড়িতে একই সকেট থাকে না, তাই প্লাগ মিলিয়ে নিন।'
  },
  {
    q: 'সকেট',
    a: 'সামঞ্জস্যের জন্য H4 বা 3-pin (P43t/PX43t) প্লাগ থাকা প্রয়োজন।'
  }
];

function emptyStore() {
  return {
    version: 1,
    updatedAt: isoNow(),
    dynamicCatalog: [],
    faq: DEFAULT_FAQ,
    customers: {},
    orders: [],
    events: []
  };
}

let store = emptyStore();
let saveQueue = Promise.resolve();

function saveStore() {
  const snapshot = JSON.stringify(store, null, 2);
  saveQueue = saveQueue.then(async () => {
    await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const temporaryFile = `${DATA_FILE}.tmp`;
    await fs.promises.writeFile(temporaryFile, snapshot, 'utf8');
    await fs.promises.rename(temporaryFile, DATA_FILE);
  }).catch(error => console.error('Storage save failed:', error.message));
  return saveQueue;
}

function pruneExpiredData(persist = true) {
  const cutoff = now() - RETENTION_MS;

  for (const [psid, customer] of Object.entries(store.customers || {})) {
    customer.messages = (customer.messages || []).filter(message =>
      Date.parse(message.at || '') > cutoff
    );

    customer.memory = customer.memory || {};
    for (const [key, fact] of Object.entries(customer.memory)) {
      const stamp = Date.parse(fact.updatedAt || fact.at || customer.updatedAt || '');
      if (!Number.isFinite(stamp) || stamp <= cutoff) delete customer.memory[key];
    }

    const messageTimes = customer.messages.map(message => Date.parse(message.at || '') || 0);
    const latestActivity = Math.max(Date.parse(customer.updatedAt || '') || 0, ...messageTimes);
    if (latestActivity <= cutoff) delete store.customers[psid];
  }

  store.orders = (store.orders || []).filter(order => Date.parse(order.createdAt || '') > cutoff);
  store.events = (store.events || []).filter(event => Date.parse(event.at || '') > cutoff);

  if (persist) saveStore();
}

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      store = { ...emptyStore(), ...parsed };
      if (!store.customers || typeof store.customers !== 'object') store.customers = {};
      if (!Array.isArray(store.dynamicCatalog)) store.dynamicCatalog = [];
      if (!Array.isArray(store.orders)) store.orders = [];
      if (!Array.isArray(store.events)) store.events = [];
      if (!Array.isArray(store.faq)) store.faq = DEFAULT_FAQ;
      pruneExpiredData(false);
    } else {
      saveStore();
    }
  } catch (error) {
    console.error('Could not load storage file:', error.message);
    store = emptyStore();
  }
}

function recordEvent(type, details = {}) {
  store.events.push({ type, at: isoNow(), ...details });
  store.events = store.events.filter(event => Date.parse(event.at || '') > now() - RETENTION_MS);
  if (store.events.length > 5000) store.events.splice(0, store.events.length - 5000);
}

function getCustomer(psid) {
  if (!store.customers[psid]) {
    store.customers[psid] = {
      psid,
      createdAt: isoNow(),
      updatedAt: isoNow(),
      messages: [],
      memory: {},
      handover: { active: false, reason: '', startedAt: null },
      pendingHandoverQuestion: false
    };
  }
  return store.customers[psid];
}

function addMessage(customer, role, text) {
  customer.messages.push({ role, text: clean(text, 5000), at: isoNow() });
  customer.messages = customer.messages.slice(-MAX_HISTORY_MESSAGES);
  customer.updatedAt = isoNow();
}

function setMemory(customer, key, value) {
  customer.memory[key] = { value: clean(value, 1000), updatedAt: isoNow() };
  customer.updatedAt = isoNow();
}

function memoryValue(customer, key) {
  return customer.memory?.[key]?.value || '';
}

function stripMarkdownAndLimitLines(text) {
  let result = clean(text, 2500)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = result.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > MAX_REPLY_LINES) result = lines.slice(0, MAX_REPLY_LINES).join('\n');
  return result || 'দুঃখিত, নির্ভরযোগ্য উত্তর দিতে পারছি না। প্রয়োজনে আমাদের প্রতিনিধির সহায়তা নিন।';
}

function extractPhone(text) {
  const match = String(text || '').match(/(?:\+?880|00880)?\s*01[3-9](?:[\s-]?\d){8}/);
  return match ? match[0].replace(/[^\d+]/g, '') : '';
}

function looksLikeAddress(text) {
  const t = normalize(text);
  const bengaliTerms = /(ঠিকানা|বাসা|বাড়ি|বাড়ি|গ্রাম|রোড|এলাকা|থানা|উপজেলা|জেলা|পোস্ট অফিস|ওয়ার্ড|ওয়ার্ড|লেন|মহল্লা|বাজার|সড়ক|সড়ক)/;
  const englishTerms = /\b(address|road|street|village|house|holding|area|thana|upazila|district|post office|ward|lane|market)\b/i;
  return (bengaliTerms.test(t) || englishTerms.test(t)) && t.length >= 10;
}

function extractAddress(text) {
  return looksLikeAddress(text) ? clean(text, 700) : '';
}

function hasOrderIntent(text) {
  return /(অর্ডার|order|কিনতে চাই|নিতে চাই|নিশ্চিত করছি|কনফার্ম|confirm order|place order|অর্ডার কনফার্ম)/i.test(text);
}

function saysYes(text) {
  return /^(হ্যাঁ|হ্যা|জি|জী|হ্যাঁ দিন|ঠিক আছে|করুন|হ্যাঁ করুন|yes|yeah|yep|ok|okay|please|সম্মতি আছে)[.!。\s]*$/i.test(normalize(text));
}

function saysNo(text) {
  return /^(না|না ধন্যবাদ|এখন না|no|no thanks|not now)[.!。\s]*$/i.test(normalize(text));
}

function requestsHuman(text) {
  return /(প্রতিনিধি|মানুষের সাথে|মানুষের সঙ্গে|কাস্টমার সার্ভিস|সাপোর্টে|সাপোর্ট চাই|কথা বলতে চাই|কল করব|কল করুন|human|agent|support person)/i.test(text);
}

function activateHandover(customer, reason) {
  customer.handover = { active: true, reason: clean(reason, 250), startedAt: isoNow() };
  customer.pendingHandoverQuestion = false;
  customer.updatedAt = isoNow();
  recordEvent('handover_activated', { psid: customer.psid, reason: customer.handover.reason });
  saveStore();
}

function phoneAndAddressPresent(customer) {
  return Boolean(memoryValue(customer, 'phone') && memoryValue(customer, 'address'));
}

function matchDynamicCatalog(vehicleText) {
  const query = normalize(vehicleText);
  if (!query) return null;

  for (const item of store.dynamicCatalog) {
    const aliases = Array.isArray(item.aliases) ? item.aliases : [];
    const searchable = normalize([
      item.name, item.title, item.model, item.make, item.vehicle, item.compatibility,
      ...aliases
    ].filter(Boolean).join(' '));

    if (searchable && (searchable.includes(query) || query.includes(searchable))) return item;
  }
  return null;
}

function matchBuiltin(vehicleText) {
  const query = normalize(vehicleText);
  if (!query) return null;
  return BUILTIN_VEHICLE_DATABASE.find(item =>
    item.terms.some(term => query.includes(normalize(term)) || normalize(term).includes(query))
  ) || null;
}

function hasVehicleMention(text) {
  return /(বাইক|মোটরসাইকেল|গাড়ি|গাড়ি|মডেল|সকেট|হেডলাইট|pulsar|fz|apache|axio|premio|hiace|cng|toyota|yamaha|bajaj|tvs|h4|p43t|px43t|3[\s-]?pin)/i.test(text);
}

function isExplicitSocketConfirmation(text) {
  return /(আমার.*(h4|3[\s-]?pin|p43t|px43t)|h4.*আছে|3[\s-]?pin.*আছে|প্লাগ.*(h4|3[\s-]?pin)|হ্যাঁ.*(h4|পিন)|হ্যাঁ,?\s*আছে)/i.test(text);
}

async function linkupSearch(vehicleText) {
  if (!LINKUP_API_KEY) return { confirmed: false, summary: 'Linkup API key configured হয়নি।' };

  try {
    const response = await fetch('https://api.linkup.so/v1/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LINKUP_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        q: `${vehicleText} headlight bulb socket H4 3 pin P43t PX43t`,
        depth: 'standard',
        outputType: 'sourcedAnswer',
        includeImages: false
      }),
      signal: AbortSignal.timeout(15000)
    });

    const raw = await response.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {}

    if (!response.ok) {
      console.error('Linkup search failed:', response.status, raw.slice(0, 300));
      return { confirmed: false, summary: 'অনলাইন সার্চ থেকে নির্ভরযোগ্য ফল পাওয়া যায়নি।' };
    }

    const summary = clean(
      data.answer || data.sourcedAnswer || data.summary ||
      (Array.isArray(data.results) ? data.results.map(item => item.content || item.title || '').join(' ') : ''),
      1800
    );

    // Only count clear, explicit socket evidence as a confirmation.
    const saysH4 = /\bH4\b|P43t|PX43t/i.test(summary);
    const saysOtherSocket = /(HS1|H7|H11|9003|HB3|HB4|9005|9006)/i.test(summary);
    const explicitFit = /(uses|fitted with|socket is|bulb type|সকেট|ব্যবহার করে|প্লাগ হলো|plug type)/i.test(summary);
    const confirmed = Boolean(saysH4 && explicitFit && !saysOtherSocket);

    return { confirmed, summary: summary || 'সার্চে যাচাইযোগ্য তথ্য পাওয়া যায়নি।' };
  } catch (error) {
    console.error('Linkup request error:', error.message);
    return { confirmed: false, summary: 'অনলাইন সার্চ সাময়িকভাবে পাওয়া যাচ্ছে না।' };
  }
}

async function checkVehicleFitment(vehicleText, customer) {
  const dynamicMatch = matchDynamicCatalog(vehicleText);
  if (dynamicMatch) {
    const fitment = clean(dynamicMatch.socket || dynamicMatch.compatibility || dynamicMatch.fitment || '', 600);
    const explicitlyConfirmed = dynamicMatch.socketType && /h4|p43t|px43t|3.pin/i.test(String(dynamicMatch.socketType));
    if (explicitlyConfirmed || /h4|p43t|px43t|3.pin/i.test(fitment)) {
      return {
        confirmed: true,
        source: 'dynamic_catalog',
        reply: `${clean(dynamicMatch.name || dynamicMatch.title || vehicleText, 120)}-এর ক্যাটালগ তথ্য অনুযায়ী ${fitment || 'H4/3-pin সকেটের তথ্য পাওয়া গেছে'}। গাড়ির প্লাগ মিলিয়ে নিন।`
      };
    }
    return {
      confirmed: false,
      source: 'dynamic_catalog',
      reply: `ক্যাটালগে ${clean(dynamicMatch.name || dynamicMatch.title || vehicleText, 120)} পাওয়া গেছে, তবে সকেট নিশ্চিত নয়। গাড়িতে H4 বা 3-pin (P43t/PX43t) প্লাগ আছে কি না যাচাই করবেন?`
    };
  }

  const builtin = matchBuiltin(vehicleText);
  if (builtin) {
    // The built-in database deliberately avoids claiming model-specific fitment
    // when year/trim/socket evidence is not actually known.
    if (builtin.confidence === 'conditional') {
      return {
        confirmed: false,
        source: 'builtin_database',
        reply: `${builtin.models}: শুধু H4/3-pin (P43t/PX43t) প্লাগ থাকলেই এই হেডলাইট ব্যবহারযোগ্য। প্লাগটি যাচাই করে জানাবেন?`
      };
    }
    return {
      confirmed: false,
      source: 'builtin_database',
      reply: `${builtin.models}-এর সকেট মডেল/বছর/ভ্যারিয়েন্ট অনুযায়ী বদলাতে পারে। গাড়িতে H4 বা 3-pin (P43t/PX43t) প্লাগ আছে কি না যাচাই করে জানাবেন?`
    };
  }

  const webResult = await linkupSearch(vehicleText);
  if (webResult.confirmed) {
    setMemory(customer, 'lastFitmentCheck', `${vehicleText}: ${webResult.summary}`);
    return {
      confirmed: true,
      source: 'linkup',
      reply: `অনলাইন সূত্রে ${vehicleText}-এর জন্য H4/3-pin সকেটের ইঙ্গিত পাওয়া গেছে। কেনার আগে গাড়ির প্লাগ মিলিয়ে নিন।`
    };
  }

  setMemory(customer, 'pendingVehicleSocketCheck', vehicleText);
  return {
    confirmed: false,
    source: 'unconfirmed',
    reply: `${vehicleText}-এর সকেট নির্ভরযোগ্যভাবে নিশ্চিত করতে পারিনি। গাড়িতে H4 বা 3-pin (P43t/PX43t) প্লাগ আছে কি না দেখে জানাবেন?`
  };
}

async function askOpenRouter(messages) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || 'https://impotech-bot.onrender.com',
      'X-Title': 'ImpoTech AI Messenger Bot'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      temperature: 0.15,
      max_tokens: 350,
      messages
    }),
    signal: AbortSignal.timeout(25000)
  });

  const body = await response.text();
  let data = {};
  try { data = JSON.parse(body); } catch {}

  if (!response.ok) {
    console.error('OpenRouter error:', response.status, body.slice(0, 500));
    throw new Error(`OpenRouter returned ${response.status}`);
  }

  const answer = data.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('OpenRouter returned an empty answer');
  return stripMarkdownAndLimitLines(answer);
}

function buildSystemPrompt(customer) {
  const catalogText = JSON.stringify(store.dynamicCatalog.slice(0, 100)).slice(0, 9000);
  const faqText = JSON.stringify(store.faq.slice(0, 50)).slice(0, 4000);
  const memoryText = JSON.stringify(Object.fromEntries(
    Object.entries(customer.memory || {}).map(([key, fact]) => [key, fact.value])
  )).slice(0, 3000);

  return [
    'আপনি ImpoTech-এর Messenger সহকারী।',
    'সবসময় সহজ, প্রমিত বাংলায় উত্তর দিন; সর্বোচ্চ ৫টি লাইনে উত্তর দিন।',
    'কখনো তথ্য বানিয়ে বলবেন না। ক্যাটালগ/FAQ/মেমোরিতে তথ্য না থাকলে তা স্পষ্ট করে বলুন।',
    'পণ্যটি H4/3-pin (P43t/PX43t) প্লাগের জন্য। সব গাড়িতে এই সকেট থাকে—এমন দাবি করবেন না।',
    'গাড়ির সকেট বিষয়ে নিশ্চিত তথ্য ছাড়া ফিট হবে বলে নিশ্চয়তা দেবেন না।',
    'অর্ডার/কেনার নিশ্চয়তা/প্রতিনিধির অনুরোধ এলে সংক্ষিপ্তভাবে জানান যে প্রতিনিধি সহায়তা করবেন।',
    'কঠিন বা অস্পষ্ট প্রশ্নে ঠিক এই বাক্যটি ব্যবহার করুন: "আমার প্রশ্নটা বুঝতে সমস্যা হচ্ছে, আমি কী আমাদের প্রতিনিধির কাছে প্রশ্নটা হস্তান্তর করবো?"',
    'জটিল সিদ্ধান্ত বা সমস্যায় বলুন: "আপনি সরাসরি কল করুন তাহলে আরো ভালো দ্রুত সার্ভিস পাবেন।"',
    `কাস্টমার মেমোরি: ${memoryText}`,
    `ডাইনামিক ক্যাটালগ: ${catalogText}`,
    `FAQ: ${faqText}`
  ].join('\n');
}

async function createAIReply(customer, userText) {
  const history = customer.messages.slice(-12).map(message => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.text
  }));

  return askOpenRouter([
    { role: 'system', content: buildSystemPrompt(customer) },
    ...history,
    { role: 'user', content: userText }
  ]);
}

async function sendMessengerMessage(psid, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('PAGE_ACCESS_TOKEN is not configured; message not sent.');
    return false;
  }

  try {
    const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: psid },
        messaging_type: 'RESPONSE',
        message: { text: stripMarkdownAndLimitLines(text) }
      }),
      signal: AbortSignal.timeout(15000)
    });

    const body = await response.text();
    if (!response.ok) {
      console.error('Messenger send failed:', response.status, body.slice(0, 500));
      return false;
    }
    return true;
  } catch (error) {
    console.error('Messenger send error:', error.message);
    return false;
  }
}

function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return false;
  const provided = clean(req.get('x-admin-token') || req.query.token || req.body?.adminToken || '');
  return provided.length > 0 && provided === ADMIN_TOKEN;
}

function requireAdmin(req, res, next) {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

async function fetchCatalogFromUrl(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Catalog source returned ${response.status}`);
  const data = await response.json();
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.products)) return data.products;
  if (Array.isArray(data.catalog)) return data.catalog;
  throw new Error('Catalog JSON must be an array or contain products/catalog array');
}

function normalizeCatalogItems(items) {
  if (!Array.isArray(items)) throw new Error('items must be an array');
  return items.slice(0, 5000).map(item => {
    if (!item || typeof item !== 'object') return null;
    return {
      id: clean(item.id || item.sku || item.product_id || '', 120),
      name: clean(item.name || item.title || item.product_name || '', 250),
      title: clean(item.title || item.name || item.product_name || '', 250),
      description: clean(item.description || item.details || '', 2500),
      price: item.price ?? item.sale_price ?? null,
      category: clean(item.category || '', 120),
      model: clean(item.model || '', 200),
      make: clean(item.make || '', 120),
      vehicle: clean(item.vehicle || '', 250),
      aliases: Array.isArray(item.aliases) ? item.aliases.map(v => clean(v, 100)).slice(0, 50) : [],
      compatibility: clean(item.compatibility || item.fitment || '', 600),
      socketType: clean(item.socketType || item.socket_type || '', 100),
      stock: item.stock ?? item.quantity ?? null,
      updatedAt: isoNow()
    };
  }).filter(item => item && (item.name || item.title || item.id));
}

async function syncCatalog(items, source = 'admin') {
  const normalizedItems = normalizeCatalogItems(items);
  // Full flush: replace all dynamic catalog records with the incoming dataset.
  store.dynamicCatalog = normalizedItems;
  store.updatedAt = isoNow();
  recordEvent('catalog_synced', { source, count: normalizedItems.length });
  await saveStore();
  return normalizedItems.length;
}

async function handleCustomerText(psid, userText) {
  const customer = getCustomer(psid);
  const text = clean(userText, 4000);
  if (!text) return;

  addMessage(customer, 'user', text);

  const phone = extractPhone(text);
  if (phone) setMemory(customer, 'phone', phone);

  const address = extractAddress(text);
  if (address) setMemory(customer, 'address', address);

  if (phoneAndAddressPresent(customer)) {
    activateHandover(customer, 'Customer supplied phone number and address');
    await sendMessengerMessage(psid, 'আপনার ফোন নম্বর ও ঠিকানা পেয়েছি। আমাদের প্রতিনিধি এখন আপনার অর্ডার/অনুরোধটি দেখবেন।');
    addMessage(customer, 'assistant', 'আপনার ফোন নম্বর ও ঠিকানা পেয়েছি। আমাদের প্রতিনিধি এখন আপনার অর্ডার/অনুরোধটি দেখবেন।');
    await saveStore();
    return;
  }

  // Once a human has taken over, do not let AI resume automatically.
  if (customer.handover?.active) {
    await saveStore();
    return;
  }

  if (customer.pendingHandoverQuestion) {
    if (saysYes(text)) {
      activateHandover(customer, 'Customer accepted human handover');
      const reply = 'ঠিক আছে, আপনার প্রশ্নটি আমাদের প্রতিনিধির কাছে হস্তান্তর করছি।';
      addMessage(customer, 'assistant', reply);
      await sendMessengerMessage(psid, reply);
      await saveStore();
      return;
    }
    if (saysNo(text)) {
      customer.pendingHandoverQuestion = false;
      const reply = 'ঠিক আছে। আপনার প্রশ্নটি আরেকটু বিস্তারিত লিখলে সাহায্য করার চেষ্টা করব।';
      addMessage(customer, 'assistant', reply);
      await sendMessengerMessage(psid, reply);
      await saveStore();
      return;
    }
  }

  if (hasOrderIntent(text)) {
    const order = {
      id: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      psid,
      createdAt: isoNow(),
      status: 'needs_human_confirmation',
      customerPhone: memoryValue(customer, 'phone'),
      customerAddress: memoryValue(customer, 'address'),
      request: text
    };
    store.orders.push(order);
    activateHandover(customer, 'Customer wants to place/confirm an order');
    const reply = 'আপনার অর্ডারের অনুরোধটি পেয়েছি। আমাদের প্রতিনিধি অর্ডার নিশ্চিত করতে সহায়তা করবেন।';
    addMessage(customer, 'assistant', reply);
    await sendMessengerMessage(psid, reply);
    await saveStore();
    return;
  }

  if (requestsHuman(text)) {
    activateHandover(customer, 'Customer requested a representative');
    const reply = 'ঠিক আছে, আপনার কথাটি আমাদের প্রতিনিধির কাছে হস্তান্তর করছি।';
    addMessage(customer, 'assistant', reply);
    await sendMessengerMessage(psid, reply);
    await saveStore();
    return;
  }

  if (isExplicitSocketConfirmation(text) && memoryValue(customer, 'pendingVehicleSocketCheck')) {
    const vehicle = memoryValue(customer, 'pendingVehicleSocketCheck');
    setMemory(customer, 'vehicleSocketConfirmation', `${vehicle}: customer reports H4/3-pin socket; ${text}`);
    setMemory(customer, 'pendingVehicleSocketCheck', '');
    const reply = 'ধন্যবাদ, আপনার দেওয়া তথ্যটি মনে রাখলাম। আপনার গাড়িতে H4/3-pin প্লাগ থাকলে এই হেডলাইট ব্যবহারযোগ্য।';
    addMessage(customer, 'assistant', reply);
    await sendMessengerMessage(psid, reply);
    await saveStore();
    return;
  }

  // If the customer asks about a vehicle, check sources in the required order.
  if (hasVehicleMention(text)) {
    const knownVehicle = memoryValue(customer, 'pendingVehicleSocketCheck') ||
      (text.match(/(?:pulsar|fz(?:-s)?|apache|axio|premio|hiace|cng(?: auto)?|সিএনজি|সিএনজি অটো|toyota|yamaha|bajaj|tvs)[^,.!?।\n]{0,50}/i)?.[0] || text);

    const fitment = await checkVehicleFitment(knownVehicle, customer);
    if (!fitment.confirmed) setMemory(customer, 'lastFitmentQuestion', knownVehicle);
    addMessage(customer, 'assistant', fitment.reply);
    await sendMessengerMessage(psid, fitment.reply);
    await saveStore();
    return;
  }

  let reply;
  try {
    reply = await createAIReply(customer, text);
  } catch (error) {
    console.error('AI reply error:', error.message);
    customer.pendingHandoverQuestion = true;
    reply = 'আমার প্রশ্নটা বুঝতে সমস্যা হচ্ছে, আমি কী আমাদের প্রতিনিধির কাছে প্রশ্নটা হস্তান্তর করবো?';
  }

  // Ask for handover when the model cannot provide a reliable answer.
  if (/(নিশ্চিত নই|নিশ্চিতভাবে বলতে পারছি না|তথ্য নেই|বুঝতে পারছি না|জানি না|নির্ভরযোগ্য তথ্য নেই|cannot confirm|not sure|don't know)/i.test(reply)) {
    customer.pendingHandoverQuestion = true;
    reply = 'আমার প্রশ্নটা বুঝতে সমস্যা হচ্ছে, আমি কী আমাদের প্রতিনিধির কাছে প্রশ্নটা হস্তান্তর করবো?';
  }

  // A complex issue can be escalated without pretending it was resolved.
  if (/(আইনি সমস্যা|বৈদ্যুতিক শর্ট|ধোঁয়া|আগুন|স্পার্ক|গুরুতর সমস্যা|জটিল সমস্যা)/i.test(text)) {
    reply = HUMAN_PHONE
      ? `আপনি সরাসরি কল করুন তাহলে আরো ভালো দ্রুত সার্ভিস পাবেন। ফোন: ${HUMAN_PHONE}`
      : 'আপনি সরাসরি কল করুন তাহলে আরো ভালো দ্রুত সার্ভিস পাবেন।';
  }

  reply = stripMarkdownAndLimitLines(reply);
  addMessage(customer, 'assistant', reply);
  await sendMessengerMessage(psid, reply);
  await saveStore();
}

function extractMessengerText(event) {
  if (event.message?.text) return event.message.text;
  if (event.postback?.title) return event.postback.title;
  if (event.postback?.payload) return event.postback.payload;
  return '';
}

async function handleWebhookEvent(event) {
  // Optional telephony providers may forward their call events to this webhook.
  const eventType = normalize(event.event || event.type || event.call?.status || '');
  const callLike = /(call|phone_call|voice_call|incoming_call|call_started|call_received)/i.test(eventType);
  if (callLike) {
    const psid = clean(event.sender?.id || event.psid || event.customer_id || '');
    if (psid) {
      const customer = getCustomer(psid);
      activateHandover(customer, 'Incoming call event');
      recordEvent('call_event_received', { psid, eventType });
      await saveStore();
    } else {
      recordEvent('call_event_received', { eventType, source: 'external_provider' });
      await saveStore();
    }
    return;
  }

  const senderId = event.sender?.id;
  const text = extractMessengerText(event);
  if (!senderId || !text) return;

  if (event.message?.is_echo) return;
  await handleCustomerText(senderId, text);
}

app.get('/', (_req, res) => {
  res.status(200).send('ImpoTech AI Messenger Bot is running.');
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'impotech-messenger-bot',
    model: OPENROUTER_MODEL,
    openRouterConfigured: Boolean(OPENROUTER_API_KEY),
    linkupConfigured: Boolean(LINKUP_API_KEY),
    pageTokenConfigured: Boolean(PAGE_ACCESS_TOKEN),
    dataFileConfigured: Boolean(DATA_FILE),
    dynamicCatalogCount: store.dynamicCatalog.length,
    uptimeSeconds: Math.round(process.uptime())
  });
});

// Meta webhook verification.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Configure this URL as the Messenger webhook callback in Meta Developer settings.
app.post('/webhook', async (req, res) => {
  // Acknowledge quickly; process events asynchronously.
  res.sendStatus(200);
  try {
    const body = req.body || {};
    if (body.object === 'page' && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        for (const event of (entry.messaging || [])) {
          await handleWebhookEvent(event);
        }
        // Provider-specific call events, if any, may arrive in changes.
        for (const change of (entry.changes || [])) {
          if (change.value && (change.value.event || change.value.type)) {
            await handleWebhookEvent(change.value);
          }
        }
      }
    } else if (body.event || body.type || body.call) {
      // Optional integration endpoint for a telephony provider forwarding call events.
      await handleWebhookEvent(body);
    }
  } catch (error) {
    console.error('Webhook processing error:', error.message);
  }
});

// Optional direct call-event endpoint for a connected telephony provider.
// Protect it with X-Admin-Token. This endpoint cannot detect phone calls by itself.
app.post('/api/call-event', requireAdmin, async (req, res) => {
  const psid = clean(req.body?.psid || req.body?.customerId || '');
  const eventType = clean(req.body?.event || req.body?.type || 'incoming_call');
  if (psid) {
    const customer = getCustomer(psid);
    activateHandover(customer, `Call event: ${eventType}`);
  }
  recordEvent('call_event_received', { psid: psid || null, eventType });
  await saveStore();
  res.json({ ok: true, handoverActivated: Boolean(psid) });
});

// Admin status and catalog endpoints.
app.get('/api/admin/status', requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    model: OPENROUTER_MODEL,
    dynamicCatalogCount: store.dynamicCatalog.length,
    customerCount: Object.keys(store.customers).length,
    pendingOrders: store.orders.filter(order => order.status !== 'completed').length,
    activeHandovers: Object.values(store.customers).filter(customer => customer.handover?.active).length,
    retentionDays: 20,
    updatedAt: store.updatedAt
  });
});

app.get('/api/catalog', (_req, res) => {
  res.json({ ok: true, count: store.dynamicCatalog.length, products: store.dynamicCatalog });
});

// Replace entire dynamic catalog. Old dynamic entries are removed, not merged.
app.post('/api/admin/catalog/sync', requireAdmin, async (req, res) => {
  try {
    let items = req.body?.items;
    let source = 'admin_payload';

    if (!Array.isArray(items) && GITHUB_CATALOG_URL) {
      items = await fetchCatalogFromUrl(GITHUB_CATALOG_URL);
      source = 'github_url';
    }

    if (!Array.isArray(items)) {
      return res.status(400).json({
        ok: false,
        error: 'Send JSON body { "items": [...] } or configure GITHUB_CATALOG_URL.'
      });
    }

    const count = await syncCatalog(items, source);
    res.json({ ok: true, message: 'Dynamic catalog fully replaced.', count });
  } catch (error) {
    console.error('Catalog sync error:', error.message);
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/admin/catalog/sync-github', requireAdmin, async (_req, res) => {
  if (!GITHUB_CATALOG_URL) {
    return res.status(400).json({ ok: false, error: 'GITHUB_CATALOG_URL is not configured.' });
  }
  try {
    const items = await fetchCatalogFromUrl(GITHUB_CATALOG_URL);
    const count = await syncCatalog(items, 'github_url');
    res.json({ ok: true, message: 'Dynamic catalog fully replaced from GitHub.', count });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/admin/catalog/clear', requireAdmin, async (_req, res) => {
  store.dynamicCatalog = [];
  store.updatedAt = isoNow();
  recordEvent('catalog_cleared', { source: 'admin' });
  await saveStore();
  res.json({ ok: true, count: 0 });
});

app.get('/api/admin/customers', requireAdmin, (_req, res) => {
  const customers = Object.values(store.customers).map(customer => ({
    psid: customer.psid,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
    messageCount: customer.messages.length,
    memory: Object.fromEntries(Object.entries(customer.memory || {}).map(([key, fact]) => [key, fact.value])),
    handover: customer.handover
  }));
  res.json({ ok: true, customers });
});

app.get('/api/admin/orders', requireAdmin, (_req, res) => {
  res.json({ ok: true, orders: store.orders });
});

app.post('/api/admin/handover/:psid/resolve', requireAdmin, async (req, res) => {
  const customer = store.customers[clean(req.params.psid, 200)];
  if (!customer) return res.status(404).json({ ok: false, error: 'Customer not found' });

  customer.handover = {
    active: false,
    reason: 'Resolved by admin',
    startedAt: null,
    resolvedAt: isoNow()
  };
  customer.pendingHandoverQuestion = false;
  customer.updatedAt = isoNow();
  recordEvent('handover_resolved', { psid: customer.psid });
  await saveStore();
  res.json({ ok: true });
});

app.post('/api/admin/customer/:psid/message', requireAdmin, async (req, res) => {
  const psid = clean(req.params.psid, 200);
  const message = clean(req.body?.message, 2000);
  if (!psid || !message) return res.status(400).json({ ok: false, error: 'psid and message are required' });

  const sent = await sendMessengerMessage(psid, message);
  if (sent) {
    const customer = getCustomer(psid);
    addMessage(customer, 'assistant', message);
    await saveStore();
  }
  res.status(sent ? 200 : 502).json({ ok: sent });
});

// Manual cleanup endpoint for administrators.
app.post('/api/admin/cleanup', requireAdmin, async (_req, res) => {
  pruneExpiredData(false);
  await saveStore();
  res.json({ ok: true, retentionDays: 20 });
});

loadStore();

app.listen(PORT, () => {
  console.log(`ImpoTech AI Messenger Bot listening on port ${PORT}`);
  console.log(`Model: ${OPENROUTER_MODEL}`);
  console.log(`Data file: ${DATA_FILE}`);
  if (!PAGE_ACCESS_TOKEN) console.warn('WARNING: PAGE_ACCESS_TOKEN is missing.');
  if (!VERIFY_TOKEN) console.warn('WARNING: VERIFY_TOKEN is missing.');
  if (!OPENROUTER_API_KEY) console.warn('WARNING: OPENROUTER_API_KEY is missing.');
  if (!ADMIN_TOKEN) console.warn('WARNING: ADMIN_TOKEN is missing; admin endpoints will reject all requests.');
});
