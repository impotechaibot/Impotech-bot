const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'impotech_secret_123';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;

const CATALOG_FILE = path.join(__dirname, 'catalog.json');

const GITHUB_FILE_URL = GITHUB_REPO
  ? `https://api.github.com/repos/${GITHUB_REPO}/contents/catalog.json`
  : null;


/* =========================================================
   MEMORY
========================================================= */

const processedMessageIds = new Set();
const pausedCustomers = new Set();


/* =========================================================
   DEFAULT TRAINING
========================================================= */

let currentTraining = {
  isHumanTakeoverGlobal: false,

  deliveryRules: {
    dhakaDeliveryFee: 70,
    outsideDeliveryFee: 130,
    deliveryTimeDays: '২-৩ দিন',
    isCodAvailable: true,
    freeDeliveryAbove: 0,
    customInstructions:
      'সবসময় ভদ্র, স্বাভাবিক ও আন্তরিক বাংলায় উত্তর দিন। কাস্টমারের প্রশ্ন অনুযায়ী সংক্ষিপ্ত উত্তর দিন।'
  },

  products: [],

  faqs: []
};


/* =========================================================
   LOAD LOCAL CATALOG
========================================================= */

function loadLocalCatalog() {
  if (!fs.existsSync(CATALOG_FILE)) {
    console.log('[BOOT] catalog.json not found. Using empty catalog.');
    return;
  }

  try {
    const raw = fs.readFileSync(CATALOG_FILE, 'utf8');

    if (!raw.trim()) {
      console.log('[BOOT] catalog.json is empty.');
      return;
    }

    const parsed = JSON.parse(raw);

    currentTraining = {
      ...currentTraining,
      ...parsed,
      deliveryRules: {
        ...currentTraining.deliveryRules,
        ...(parsed.deliveryRules || {})
      },
      products: Array.isArray(parsed.products) ? parsed.products : [],
      faqs: Array.isArray(parsed.faqs) ? parsed.faqs : []
    };

    console.log(
      `[BOOT] Local catalog loaded: ${currentTraining.products.length} products, ${currentTraining.faqs.length} FAQs`
    );
  } catch (error) {
    console.error('[BOOT] Error reading catalog.json:', error.message);
  }
}


/* =========================================================
   SAVE LOCAL CATALOG
========================================================= */

function saveLocalCatalog() {
  try {
    fs.writeFileSync(
      CATALOG_FILE,
      JSON.stringify(currentTraining, null, 2),
      'utf8'
    );

    console.log('[LOCAL] catalog.json saved');
  } catch (error) {
    console.error('[LOCAL] Save error:', error.message);
  }
}


/* =========================================================
   DELAY
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/* =========================================================
   GITHUB - PULL LATEST CATALOG
========================================================= */

async function syncFromGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_FILE_URL) {
    console.log('[GITHUB] Pull skipped: GitHub environment variables missing.');
    return false;
  }

  try {
    const response = await axios.get(GITHUB_FILE_URL, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Impotech-Bot'
      },
      timeout: 10000
    });

    const encodedContent = response.data?.content;

    if (!encodedContent) {
      console.log('[GITHUB] catalog.json content not found.');
      return false;
    }

    const cleanBase64 = encodedContent.replace(/\n/g, '');

    const decoded = Buffer.from(cleanBase64, 'base64').toString('utf8');

    const parsed = JSON.parse(decoded);

    currentTraining = {
      ...currentTraining,
      ...parsed,

      deliveryRules: {
        ...currentTraining.deliveryRules,
        ...(parsed.deliveryRules || {})
      },

      products: Array.isArray(parsed.products)
        ? parsed.products
        : [],

      faqs: Array.isArray(parsed.faqs)
        ? parsed.faqs
        : []
    };

    saveLocalCatalog();

    console.log(
      `[GITHUB] Pulled latest catalog: ${currentTraining.products.length} products, ${currentTraining.faqs.length} FAQs`
    );

    return true;

  } catch (error) {

    if (error.response?.status === 404) {
      console.log('[GITHUB] catalog.json not found in repository yet.');
      return false;
    }

    console.error(
      '[GITHUB] Pull error:',
      error.response?.data?.message || error.message
    );

    return false;
  }
}


/* =========================================================
   GITHUB - PUSH CATALOG
========================================================= */

async function autoCommitToGitHub(data) {
  if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_FILE_URL) {
    console.log('[GITHUB] Push skipped: GitHub environment variables missing.');
    return false;
  }

  try {

    let sha = null;

    try {
      const getResponse = await axios.get(GITHUB_FILE_URL, {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Impotech-Bot'
        },
        timeout: 10000
      });

      sha = getResponse.data?.sha || null;

    } catch (error) {

      if (error.response?.status !== 404) {
        console.error(
          '[GITHUB] Existing file check failed:',
          error.response?.data?.message || error.message
        );
      }
    }

    const contentBase64 = Buffer
      .from(JSON.stringify(data, null, 2), 'utf8')
      .toString('base64');

    const body = {
      message: 'Auto-sync catalog from ImpoTech App',
      content: contentBase64
    };

    if (sha) {
      body.sha = sha;
    }

    await axios.put(
      GITHUB_FILE_URL,
      body,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Impotech-Bot',
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    console.log('[GITHUB] Successfully synced to GitHub');

    return true;

  } catch (error) {

    console.error(
      '[GITHUB] Sync error:',
      error.response?.data?.message || error.message
    );

    return false;
  }
}


/* =========================================================
   BUILD SYSTEM PROMPT
========================================================= */

function buildSystemPrompt() {

  const rules = currentTraining.deliveryRules || {};

  const dhakaFee =
    rules.dhakaDeliveryFee !== undefined
      ? rules.dhakaDeliveryFee
      : 70;

  const outsideFee =
    rules.outsideDeliveryFee !== undefined
      ? rules.outsideDeliveryFee
      : 130;

  const deliveryTime =
    rules.deliveryTimeDays || '২-৩ দিন';

  const codText =
    rules.isCodAvailable === false
      ? 'ক্যাশ অন ডেলিভারি সুবিধা বর্তমানে নেই'
      : 'ক্যাশ অন ডেলিভারি সুবিধা আছে';

  const freeDelivery =
    Number(rules.freeDeliveryAbove || 0);

  const products = Array.isArray(currentTraining.products)
    ? currentTraining.products
    : [];

  const faqs = Array.isArray(currentTraining.faqs)
    ? currentTraining.faqs
    : [];


  const productList = products
    .map((product, index) => {

      return [
        `পণ্য ${index + 1}:`,
        `নাম: ${product.name || 'নাম নেই'}`,
        `দাম: ${product.price !== undefined ? product.price : 'দাম নেই'} টাকা`,
        `মিডিয়া: ${product.mediaType || 'IMAGE'}`,
        `মিডিয়া লিংক: ${product.mediaUrl || 'নেই'}`,
        `বিবরণ: ${product.description || 'নেই'}`
      ].join(' | ');

    })
    .join('\n');


  const faqList = faqs
    .map((faq, index) => {

      return [
        `FAQ ${index + 1}:`,
        `প্রশ্ন: ${faq.question || ''}`,
        `উত্তর: ${faq.answer || ''}`
      ].join('\n');

    })
    .join('\n\n');


  return `
তুমি "ImpoTech Bd"-এর অফিসিয়াল AI Sales Assistant।

তোমার কাজ হলো Facebook Messenger-এর কাস্টমারকে সঠিক, সংক্ষিপ্ত এবং স্বাভাবিক বাংলায় সাহায্য করা।

========================
LIVE STORE RULES
========================

ঢাকার ডেলিভারি চার্জ: ${dhakaFee} টাকা।
ঢাকার বাইরের ডেলিভারি চার্জ: ${outsideFee} টাকা।
ডেলিভারি সময়: ${deliveryTime}।
${codText}।
${freeDelivery > 0 ? `কত টাকার বেশি অর্ডারে ফ্রি ডেলিভারি: ${freeDelivery} টাকা।` : ''}

========================
IMPORTANT RESPONSE RULES
========================

1. কাস্টমার যে প্রশ্ন করেছে শুধুমাত্র সেটার উত্তর দাও।

2. অপ্রয়োজনীয়ভাবে একই কথা বারবার বলবে না।

3. কাস্টমার পণ্যের দাম জিজ্ঞেস করলে শুধু প্রয়োজনীয় পণ্যের দাম বলবে।

4. কাস্টমার ডেলিভারি চার্জ জিজ্ঞেস করলে শুধু ডেলিভারি চার্জের তথ্য দাও।

5. কাস্টমার ছবি বা ভিডিও চাইলে এবং সংশ্লিষ্ট পণ্যের তথ্য ক্যাটালগে থাকলে সেই পণ্যের তথ্য অনুযায়ী উত্তর দাও।

6. কোনো তথ্য ক্যাটালগ/FAQ-তে না থাকলে বানিয়ে উত্তর দেবে না।

7. নিজের থেকে কোনো পণ্যের দাম, স্টক, ফিচার, অফার বা ডেলিভারি তথ্য তৈরি করবে না।

8. কাস্টমার অর্ডার করতে চাইলে নাম, পূর্ণ ঠিকানা এবং সক্রিয় মোবাইল নম্বর চাইতে পারো।

9. অর্ডার করতে না চাইলে অপ্রয়োজনীয়ভাবে নাম/ঠিকানা/ফোন চাইবে না।

10. উত্তর সাধারণত ১-৩টি ছোট বাক্যে দাও।

11. সবসময় স্বাভাবিক, ভদ্র এবং ব্যবসায়িক বাংলায় উত্তর দাও।

12. কাস্টমার ভয়েস মেসেজ পাঠালে ভয়েসের কথাটি বুঝে নিয়ে তার প্রশ্নের উত্তর দাও।

13. ভয়েস মেসেজের কথাটি না বুঝলে বানিয়ে উত্তর দেবে না। প্রয়োজনে বলবে:
"দুঃখিত, আপনার কথাটি পরিষ্কারভাবে বুঝতে পারিনি। একটু আবার বলবেন?"

14. Customer text যদি খালি হয় কিন্তু audio থাকে, তাহলে audio-কে মূল প্রশ্ন হিসেবে বিবেচনা করবে।

========================
OFFICIAL PRODUCT CATALOG
========================

${productList || 'বর্তমানে কোনো পণ্য তালিকাভুক্ত নেই।'}

========================
STORE FAQ
========================

${faqList || 'বর্তমানে কোনো FAQ নেই।'}

========================
SPECIAL STORE INSTRUCTIONS
========================

${rules.customInstructions || ''}
`;
}


/* =========================================================
   MIME TYPE HELPERS (FIXED FOR VOICE)
========================================================= */

function normalizeMimeType(contentType, attachmentType, attachmentUrl) {
  let mime = (contentType || '').split(';')[0].trim().toLowerCase();

  // Facebook-এর ভয়েস ক্লাইপ যাতে Gemini সরাসরি প্রসেস করতে পারে
  if (attachmentType === 'audio' || mime.includes('audio')) {
    if (mime === 'audio/aac' || mime === 'audio/m4a' || mime === 'audio/mp4') {
      return 'audio/mp4'; 
    }
    if (mime === 'audio/ogg' || mime === 'audio/opus') {
      return 'audio/ogg';
    }
    return 'audio/mp3';
  }

  if (attachmentType === 'image' || mime.includes('image')) {
    if (mime === 'image/png') return 'image/png';
    if (mime === 'image/webp') return 'image/webp';
    return 'image/jpeg';
  }

  if (attachmentType === 'video' || mime.includes('video')) {
    return 'video/mp4';
  }

  return 'audio/mp3';
}

/* =========================================================
   DOWNLOAD FACEBOOK ATTACHMENT
========================================================= */

async function downloadMessengerAttachment(attachment) {

  const url = attachment?.payload?.url;

  if (!url) {
    return null;
  }

  try {

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: 20 * 1024 * 1024,
      maxBodyLength: 20 * 1024 * 1024
    });


    const mimeType = normalizeMimeType(
      response.headers['content-type'],
      attachment.type,
      url
    );


    if (!mimeType) {
      console.log('[MEDIA] Unsupported attachment type:', attachment.type);
      return null;
    }


    const buffer = Buffer.from(response.data);

    if (!buffer.length) {
      return null;
    }


    console.log(
      `[MEDIA] Received ${attachment.type || 'unknown'} | ${mimeType} | ${Math.round(buffer.length / 1024)} KB`
    );


    return {
      base64: buffer.toString('base64'),
      mimeType,
      type: attachment.type
    };

  } catch (error) {

    console.error(
      '[MEDIA] Download error:',
      error.response?.status || '',
      error.message
    );

    return null;
  }
}


/* =========================================================
   GEMINI API
========================================================= */

async function callGeminiWithSmartRetry(parts) {

  if (!GEMINI_API_KEY) {
    console.error('[GEMINI] GEMINI_API_KEY missing');
    return getSafeFallbackReply();
  }


  const models = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite'
];

  let lastError = null;


  for (let attempt = 0; attempt < models.length; attempt++) {

    const model = models[attempt];

    try {

      console.log(
        `[GEMINI] Request using ${model}, attempt ${attempt + 1}`
      );


      const response = await axios.post(

        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,

        {
          contents: [
            {
              role: 'user',
              parts
            }
          ],

          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 500
          }
        },

        {
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY
          },

          timeout: 15000
        }
      );


      const candidates = response.data?.candidates || [];

      const generatedText =
        candidates?.[0]?.content?.parts
          ?.map(part => part?.text || '')
          .join('')
          .trim();


      if (generatedText) {

        console.log(
          `[GEMINI] Success using ${model}`
        );

        return generatedText;
      }


      lastError = new Error(
        `Empty Gemini response from ${model}`
      );


    } catch (error) {

      lastError = error;

      const status = error.response?.status;

      console.error(
        `[GEMINI] ${model} error:`,
        status || '',
        error.response?.data?.error?.message || error.message
      );


      if (attempt < models.length - 1) {

        if (
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          !status
        ) {

          await sleep(1200);

        } else {

          await sleep(700);
        }
      }
    }
  }


  console.error(
    '[GEMINI] All models failed:',
    lastError?.message || 'Unknown error'
  );


  return getSafeFallbackReply();
}


/* =========================================================
   SAFE FALLBACK
========================================================= */

function getSafeFallbackReply() {

  const rules = currentTraining.deliveryRules || {};

  const dhakaFee =
    rules.dhakaDeliveryFee !== undefined
      ? rules.dhakaDeliveryFee
      : 70;

  const outsideFee =
    rules.outsideDeliveryFee !== undefined
      ? rules.outsideDeliveryFee
      : 130;

  return `দুঃখিত, এই মুহূর্তে একটু সমস্যা হচ্ছে। আমাদের ডেলিভারি চার্জ ঢাকায় ${dhakaFee} টাকা এবং ঢাকার বাইরে ${outsideFee} টাকা। একটু পরে আবার মেসেজ করুন।`;
}


/* =========================================================
   SEND TEXT TO MESSENGER
========================================================= */

async function sendMessengerText(recipientId, text) {

  try {

    await axios.post(

      `https://graph.facebook.com/v20.0/me/messages`,

      {
        recipient: {
          id: recipientId
        },

        message: {
          text: text
        }
      },

      {
        params: {
          access_token: PAGE_ACCESS_TOKEN
        },

        timeout: 10000
      }
    );


    return true;

  } catch (error) {

    console.error(
      '[FB] Text send error:',
      error.response?.data || error.message
    );

    return false;
  }
}


/* =========================================================
   SEND PRODUCT MEDIA
========================================================= */

async function sendMediaAttachment(
  recipientId,
  mediaUrl,
  mediaType
) {

  if (!mediaUrl) {
    return false;
  }


  try {

    const normalizedType =
      String(mediaType || 'IMAGE').toUpperCase();


    const type =
      normalizedType === 'VIDEO'
        ? 'video'
        : 'image';


    await axios.post(

      `https://graph.facebook.com/v20.0/me/messages`,

      {
        recipient: {
          id: recipientId
        },

        message: {
          attachment: {
            type,

            payload: {
              url: mediaUrl,
              is_reusable: true
            }
          }
        }
      },

      {
        params: {
          access_token: PAGE_ACCESS_TOKEN
        },

        timeout: 15000
      }
    );


    console.log(
      `[FB] Product ${type} sent to ${recipientId}`
    );


    return true;

  } catch (error) {

    console.error(
      '[FB] Media send error:',
      error.response?.data?.error?.message ||
      error.message
    );

    return false;
  }
}


/* =========================================================
   PRODUCT MEDIA MATCH
========================================================= */

function findMatchingProductForMedia(text) {

  const products = Array.isArray(currentTraining.products)
    ? currentTraining.products
    : [];


  if (!text || !products.length) {
    return null;
  }


  const lowerText = text.toLowerCase();


  const askingForMedia =
    /ছবি|পিক|ফটো|ফট|ভিডিও|ভিডিওটি|দেখতে চাই|দেখান|রিয়েল|image|photo|pic|picture|video/i
      .test(lowerText);


  if (!askingForMedia) {
    return null;
  }


  const matched = products.find(product => {

    if (!product?.mediaUrl || !product?.name) {
      return false;
    }

    return lowerText.includes(
      String(product.name).toLowerCase()
    );
  });


  return matched || null;
}


/* =========================================================
   WEBHOOK VERIFY
========================================================= */

app.get('/webhook', (req, res) => {

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];


  if (
    mode === 'subscribe' &&
    token === VERIFY_TOKEN
  ) {

    console.log('[WEBHOOK] Verification successful');

    return res.status(200).send(challenge);
  }


  console.log('[WEBHOOK] Verification failed');

  return res.sendStatus(403);
});


/* =========================================================
   GET TRAINING
========================================================= */

app.get('/api/training', (req, res) => {

  res.json(currentTraining);
});


/* =========================================================
   UPDATE TRAINING
========================================================= */

app.post('/api/training', async (req, res) => {

  try {

    if (Array.isArray(req.body.products)) {

      currentTraining.products = req.body.products;
    }


    if (Array.isArray(req.body.faqs)) {

      currentTraining.faqs = req.body.faqs;
    }


    if (req.body.deliveryRules) {

      currentTraining.deliveryRules = {

        ...currentTraining.deliveryRules,

        ...req.body.deliveryRules
      };
    }


    if (
      req.body.isHumanTakeoverGlobal !== undefined
    ) {

      currentTraining.isHumanTakeoverGlobal =
        Boolean(req.body.isHumanTakeoverGlobal);
    }


    saveLocalCatalog();


    const githubSynced =
      await autoCommitToGitHub(currentTraining);


    res.json({

      success: true,

      githubSynced,

      message:
        `এআই সফলভাবে ${currentTraining.products.length}টি পণ্য এবং ${currentTraining.faqs.length}টি প্রশ্নোত্তর শিখে নিয়েছে।` +
        (
          githubSynced
            ? ' GitHub-এও সেভ হয়েছে।'
            : ' তবে GitHub sync করা যায়নি।'
        ),

      timestamp: Date.now()
    });


  } catch (error) {

    console.error(
      '[TRAINING] Update error:',
      error.message
    );


    res.status(500).json({

      success: false,

      message:
        'Training update করার সময় সমস্যা হয়েছে।',

      error: error.message
    });
  }
});


/* =========================================================
   MANUAL GITHUB SYNC
========================================================= */

app.post('/api/github-sync', async (req, res) => {

  const success = await syncFromGitHub();

  res.json({
    success,
    products: currentTraining.products.length,
    faqs: currentTraining.faqs.length,
    timestamp: Date.now()
  });
});


/* =========================================================
   MESSENGER WEBHOOK
========================================================= */

app.post('/webhook', async (req, res) => {

  // Facebook-কে দ্রুত 200 response দেওয়া
  res.status(200).send('EVENT_RECEIVED');


  const body = req.body;


  if (body.object !== 'page') {
    return;
  }


  try {

    for (const entry of body.entry || []) {

      for (const event of entry.messaging || []) {

        const senderId = event.sender?.id;
        const recipientId = event.recipient?.id;
        const message = event.message;


        if (!senderId || !message) {
          continue;
        }


        /* =================================================
           DUPLICATE MESSAGE PROTECTION
        ================================================= */

        const messageId = message.mid;


        if (
          messageId &&
          processedMessageIds.has(messageId)
        ) {

          console.log(
            `[SKIP_DUPLICATE] ${messageId}`
          );

          continue;
        }


        if (messageId) {

          processedMessageIds.add(messageId);


          if (processedMessageIds.size > 5000) {

            processedMessageIds.clear();
          }
        }


        const text =
          String(message.text || '').trim();


        /* =================================================
           ECHO MESSAGE / HUMAN TAKEOVER
        ================================================= */

        if (message.is_echo) {

          if (text === '.') {

            const targetId =
              recipientId || senderId;


            if (pausedCustomers.has(targetId)) {

              pausedCustomers.delete(targetId);

              console.log(
                `[TAKEOVER] Bot resumed for ${targetId}`
              );

            } else {

              pausedCustomers.add(targetId);

              console.log(
                `[TAKEOVER] Human takeover enabled for ${targetId}`
              );
            }
          }


          continue;
        }


        /* =================================================
           CUSTOMER "." = TOGGLE HUMAN TAKEOVER
        ================================================= */

        if (text === '.') {

          if (pausedCustomers.has(senderId)) {

            pausedCustomers.delete(senderId);

            console.log(
              `[TAKEOVER] Bot resumed for ${senderId}`
            );

          } else {

            pausedCustomers.add(senderId);

            console.log(
              `[TAKEOVER] Human takeover enabled for ${senderId}`
            );
          }


          continue;
        }


        /* =================================================
           HUMAN TAKEOVER CHECK
        ================================================= */

        if (
          pausedCustomers.has(senderId) ||
          currentTraining.isHumanTakeoverGlobal === true
        ) {

          console.log(
            `[TAKEOVER] Ignored bot reply for ${senderId}`
          );

          continue;
        }


        /* =================================================
           ATTACHMENT PROCESSING
        ================================================= */

        let mediaPart = null;
        let attachmentType = null;


        if (
          Array.isArray(message.attachments) &&
          message.attachments.length > 0
        ) {

          const attachment =
            message.attachments[0];


          attachmentType =
            String(attachment.type || '').toLowerCase();


          const downloaded =
            await downloadMessengerAttachment(
              attachment
            );


          if (downloaded) {

            mediaPart = {
              inlineData: {
                mimeType: downloaded.mimeType,
                data: downloaded.base64
              }
            };


            console.log(
              `[MEDIA] Added ${downloaded.mimeType} to Gemini request`
            );
          }
        }


        /* =================================================
           BUILD GEMINI PARTS
        ================================================= */

        const parts = [];


        if (mediaPart) {

          parts.push(mediaPart);
        }


        let customerInstruction = '';


        if (attachmentType === 'audio') {

          customerInstruction = `
CUSTOMER SENT A VOICE MESSAGE.

এই ভয়েস মেসেজটি শুনে/বুঝে কাস্টমারের কথার অর্থ বের করো।
তারপর কাস্টমারের প্রশ্নের সরাসরি উত্তর বাংলায় দাও।

ভয়েসে কী বলা হয়েছে তা নিয়ে অপ্রয়োজনীয় ব্যাখ্যা করবে না।
ভয়েসের কথা পরিষ্কার না হলে অনুমান করবে না।
`;
        }

        else if (attachmentType === 'image') {

          customerInstruction = `
CUSTOMER SENT AN IMAGE.

ছবিটি দেখে যদি পণ্যের নাম/মডেল/বিষয় বোঝা যায়, তাহলে ক্যাটালগের সঙ্গে মিলিয়ে উত্তর দাও।
শুধু ছবি দেখে কোনো তথ্য নিশ্চিতভাবে জানা না গেলে বানিয়ে বলবে না।
`;
        }

        else if (attachmentType === 'video') {

          customerInstruction = `
CUSTOMER SENT A VIDEO.

ভিডিওর বিষয়বস্তু বুঝে কাস্টমারের প্রশ্নের উত্তর দাও।
ক্যাটালগে না থাকা কোনো তথ্য বানিয়ে বলবে না।
`;
        }


        parts.push({

          text:
            buildSystemPrompt() +
            '\n\n' +
            customerInstruction +
            '\n\nCustomer text:\n' +
            (text || '[কাস্টমার কোনো লিখিত মেসেজ দেয়নি। সংযুক্ত মিডিয়া থেকে প্রশ্ন বুঝুন।]')
        });


        /* =================================================
           GEMINI
        ================================================= */

        const aiReply =
          await callGeminiWithSmartRetry(parts);


        /* =================================================
           SEND AI REPLY
        ================================================= */

        await sendMessengerText(
          senderId,
          aiReply
        );


        /* =================================================
           PRODUCT MEDIA
        ================================================= */

        const matchedProduct =
          findMatchingProductForMedia(text);


        if (
          matchedProduct?.mediaUrl
        ) {

          await sendMediaAttachment(

            senderId,

            matchedProduct.mediaUrl,

            matchedProduct.mediaType
          );
        }
      }
    }

  } catch (error) {

    console.error(
      '[WEBHOOK] Processing error:',
      error.stack || error.message
    );
  }
});


/* =========================================================
   STATUS
========================================================= */

app.get('/api/status', (req, res) => {

  res.json({

    status: 'ONLINE',

    uptime: process.uptime(),

    products:
      currentTraining.products.length,

    faqs:
      currentTraining.faqs.length,

    githubConfigured:
      Boolean(GITHUB_TOKEN && GITHUB_REPO),

    geminiConfigured:
      Boolean(GEMINI_API_KEY),

    facebookConfigured:
      Boolean(PAGE_ACCESS_TOKEN),

    timestamp: Date.now()
  });
});


/* =========================================================
   ROOT
========================================================= */

app.get('/', (req, res) => {

  res.send(
    'ImpoTech Bd AI Bot is Running!'
  );
});


/* =========================================================
   START SERVER
========================================================= */

async function startServer() {

  console.log('====================================');
  console.log('      IMPOTECH BD AI BOT');
  console.log('====================================');


  /* First load local catalog */

  loadLocalCatalog();


  /* Then try GitHub latest catalog */

  await syncFromGitHub();


  /* Start server */

  app.listen(PORT, () => {

    console.log(
      `Server listening on port ${PORT}`
    );

    console.log(
      `Products: ${currentTraining.products.length}`
    );

    console.log(
      `FAQs: ${currentTraining.faqs.length}`
    );

    console.log(
      `GitHub Sync: ${
        GITHUB_TOKEN && GITHUB_REPO
          ? 'ENABLED'
          : 'DISABLED'
      }`
    );

    console.log(
      `Gemini: ${
        GEMINI_API_KEY
          ? 'ENABLED'
          : 'DISABLED'
      }`
    );

    console.log(
      `Facebook: ${
        PAGE_ACCESS_TOKEN
          ? 'ENABLED'
          : 'DISABLED'
      }`
    );
  });


  /* =====================================================
     PERIODIC GITHUB PULL

     Every 60 seconds Render checks GitHub for latest
     catalog/training data.
  ===================================================== */

  setInterval(async () => {

    try {

      await syncFromGitHub();

    } catch (error) {

      console.error(
        '[GITHUB] Periodic sync error:',
        error.message
      );
    }

  }, 60000);
}


/* =========================================================
   START
========================================================= */

startServer();
