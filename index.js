/**
 * Universal H4 / 3-Pin Headlight E-Commerce AI Automation Agent
 * Framework: Express.js & Google Gen AI SDK (Gemini 3.1 Flash Light)
 * Search Engine: Linkup Search API (api.linkup.so)
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());

// Initialize Google Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Environment Configuration
const PORT = process.env.PORT || 3000;
const LINKUP_API_KEY = process.env.LINKUP_API_KEY;

// Built-in Default Vehicle Database (Bikes, Cars, CNGs, Trucks, Buses)
const BUILTIN_VEHICLE_DATABASE = [
    // --- BIKES ---
    { model: 'pulsar 150', brand: 'Bajaj', vehicleType: 'bike', hasH4Plug: true },
    { model: 'pulsar 180', brand: 'Bajaj', vehicleType: 'bike', hasH4Plug: true },
    { model: 'pulsar ns200', brand: 'Bajaj', vehicleType: 'bike', hasH4Plug: true },
    { model: 'pulsar 220f', brand: 'Bajaj', vehicleType: 'bike', hasH4Plug: true },
    { model: 'discover', brand: 'Bajaj', vehicleType: 'bike', hasH4Plug: true },
    { model: 'platina', brand: 'Bajaj', vehicleType: 'bike', hasH4Plug: true },
    { model: 'fz', brand: 'Yamaha', vehicleType: 'bike', hasH4Plug: true },
    { model: 'fzs', brand: 'Yamaha', vehicleType: 'bike', hasH4Plug: true },
    { model: 'fz v2', brand: 'Yamaha', vehicleType: 'bike', hasH4Plug: true },
    { model: 'fz v3', brand: 'Yamaha', vehicleType: 'bike', hasH4Plug: true },
    { model: 'r15', brand: 'Yamaha', vehicleType: 'bike', hasH4Plug: true },
    { model: 'fazer', brand: 'Yamaha', vehicleType: 'bike', hasH4Plug: true },
    { model: 'sz-rr', brand: 'Yamaha', vehicleType: 'bike', hasH4Plug: true },
    { model: 'apache rtr 160', brand: 'TVS', vehicleType: 'bike', hasH4Plug: true },
    { model: 'apache 160 4v', brand: 'TVS', vehicleType: 'bike', hasH4Plug: true },
    { model: 'apache rtr 180', brand: 'TVS', vehicleType: 'bike', hasH4Plug: true },
    { model: 'metro', brand: 'TVS', vehicleType: 'bike', hasH4Plug: true },
    { model: 'splendor', brand: 'Hero', vehicleType: 'bike', hasH4Plug: true },
    { model: 'passion pro', brand: 'Hero', vehicleType: 'bike', hasH4Plug: true },
    { model: 'hf deluxe', brand: 'Hero', vehicleType: 'bike', hasH4Plug: true },
    { model: 'hunk', brand: 'Hero', vehicleType: 'bike', hasH4Plug: true },
    { model: 'glamour', brand: 'Hero', vehicleType: 'bike', hasH4Plug: true },
    { model: 'cb shine', brand: 'Honda', vehicleType: 'bike', hasH4Plug: true },
    { model: 'unicorn', brand: 'Honda', vehicleType: 'bike', hasH4Plug: true },
    { model: 'hornet', brand: 'Honda', vehicleType: 'bike', hasH4Plug: true },
    { model: 'livo', brand: 'Honda', vehicleType: 'bike', hasH4Plug: true },
    { model: 'gixxer', brand: 'Suzuki', vehicleType: 'bike', hasH4Plug: true },
    { model: 'gixxer sf', brand: 'Suzuki', vehicleType: 'bike', hasH4Plug: true },
    { model: 'gs150r', brand: 'Suzuki', vehicleType: 'bike', hasH4Plug: true },
    // --- CARS ---
    { model: 'axio', brand: 'Toyota', vehicleType: 'car', hasH4Plug: true },
    { model: 'premio', brand: 'Toyota', vehicleType: 'car', hasH4Plug: true },
    { model: 'allion', brand: 'Toyota', vehicleType: 'car', hasH4Plug: true },
    { model: 'corolla', brand: 'Toyota', vehicleType: 'car', hasH4Plug: true },
    { model: 'corolla 141', brand: 'Toyota', vehicleType: 'car', hasH4Plug: true },
    { model: 'probox', brand: 'Toyota', vehicleType: 'car', hasH4Plug: true },
    { model: 'succeed', brand: 'Toyota', vehicleType: 'car', hasH4Plug: true },
    { model: 'hiace', brand: 'Toyota', vehicleType: 'car', hasH4Plug: true },
    { model: 'townace', brand: 'Toyota', vehicleType: 'car', hasH4Plug: true },
    { model: 'liteace', brand: 'Toyota', vehicleType: 'car', hasH4Plug: true },
    { model: 'pajero', brand: 'Mitsubishi', vehicleType: 'car', hasH4Plug: true },
    { model: 'lancer', brand: 'Mitsubishi', vehicleType: 'car', hasH4Plug: true },
    // --- CNG / AUTO / TRUCK / BUS ---
    { model: 'cng', brand: 'Bajaj', vehicleType: 'cng', hasH4Plug: true },
    { model: 'cng auto', brand: 'Bajaj', vehicleType: 'cng', hasH4Plug: true },
    { model: 'auto rickshaw', brand: 'Generic', vehicleType: 'cng', hasH4Plug: true },
    { model: 'tata ace', brand: 'Tata', vehicleType: 'truck', hasH4Plug: true },
    { model: 'mahindra pickup', brand: 'Mahindra', vehicleType: 'truck', hasH4Plug: true }
];

// In-Memory Dynamic Storage Containers
let catalogDatabase = []; 
const userSessions = new Map(); 

// 20 Days Retention Period in Milliseconds
const RETENTION_PERIOD_MS = 20 * 24 * 60 * 60 * 1000;

/**
 * Cleanup Sessions Older Than 20 Days
 */
function purgeExpiredSessions() {
    const now = Date.now();
    for (const [userId, session] of userSessions.entries()) {
        if (now - session.lastUpdated > RETENTION_PERIOD_MS) {
            userSessions.delete(userId);
        }
    }
}
setInterval(purgeExpiredSessions, 12 * 60 * 60 * 1000); // Runs twice daily

/**
 * Get or Create User Session with Stateful Retention
 */
function getOrCreateSession(userId) {
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {
            userId: userId,
            messages: [],
            humanHandover: false,
            extractedPhone: null,
            extractedAddress: null,
            userVerifiedPlugType: null,
            awaitingHandoverConfirmation: false,
            lastUpdated: Date.now()
        });
    }
    const session = userSessions.get(userId);
    session.lastUpdated = Date.now();
    return session;
}

/**
 * Multi-Turn Phone and Address Extractor
 */
function parseContactInformation(text, session) {
    // Regex for Bangladeshi Phone Numbers (+8801... or 01...)
    const phoneRegex = /(?:\+?88)?01[3-9]\d{8}/g;
    const phoneMatches = text.match(phoneRegex);
    
    if (phoneMatches && phoneMatches.length > 0) {
        session.extractedPhone = phoneMatches[0];
    }

    // Heuristic analysis for physical address indicators
    const addressKeywords = ['ঠিকানা', 'বাসা', 'রোড', 'জেলা', 'থানা', 'গ্রাম', 'হাউজ', 'ব্লক', 'address', 'house', 'road', 'dhaka', 'chittagong'];
    const lowerText = text.toLowerCase();
    const hasAddressWord = addressKeywords.some(word => lowerText.includes(word));
    
    if (hasAddressWord || (text.length > 12 && /\d+/.test(text) && session.extractedPhone)) {
        if (!session.extractedAddress) {
            session.extractedAddress = text;
        } else if (!session.extractedAddress.includes(text)) {
            session.extractedAddress += ", " + text;
        }
    }

    // Trigger handover if both phone and valid address are present
    if (session.extractedPhone && session.extractedAddress && session.extractedAddress.length > 6) {
        session.humanHandover = true;
    }
}

/**
 * Secondary Search via Linkup API for Vehicle Socket Type
 */
async function queryLinkupApi(vehicleQuery) {
    if (!LINKUP_API_KEY) {
        console.warn("LINKUP_API_KEY is missing in Render environment.");
        return null;
    }

    try {
        const searchQuery = `${vehicleQuery} headlight plug type H4 3 pin socket compatibility`;
        const response = await axios.post(
            'https://api.linkup.so/v1/search',
            {
                q: searchQuery,
                depth: 'fast'
            },
            {
                headers: {
                    'Authorization': `Bearer ${LINKUP_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 6000
            }
        );

        const responseContent = JSON.stringify(response.data).toLowerCase();

        if (responseContent.includes('h4') || responseContent.includes('3 pin') || responseContent.includes('3-pin')) {
            return true;
        } else if (responseContent.includes('h7') || responseContent.includes('h11') || responseContent.includes('hb3') || responseContent.includes('h1')) {
            return false;
        }
        return null;
    } catch (error) {
        console.error("Linkup API Execution Error:", error.message);
        return null;
    }
}

/**
 * ADMIN ENDPOINT: Sync Catalog
 * Completely purges old catalog data and installs new items from admin app.
 */
app.post('/admin/sync-catalog', (req, res) => {
    const { products } = req.body;
    if (!Array.isArray(products)) {
        return res.status(400).json({ success: false, message: "Payload 'products' must be an array." });
    }

    // PURGE OLD CATALOG DATA ENTIRELY
    catalogDatabase = [];

    // POPULATE FRESH CATALOG DATA
    catalogDatabase = products.map(item => ({
        model: item.model ? item.model.toLowerCase() : '',
        vehicleType: item.vehicleType || 'all',
        hasH4Plug: item.hasH4Plug !== undefined ? item.hasH4Plug : true,
        description: item.description || ''
    }));

    return res.status(200).json({
        success: true,
        message: "Old catalog purged successfully. New catalog synchronized.",
        count: catalogDatabase.length
    });
});

/**
 * WEBHOOK ENDPOINT: Messenger Voice/Video Call Events
 */
app.post('/webhook/call-event', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send("User ID required");

    const session = getOrCreateSession(userId);
    session.humanHandover = true;

    return res.status(200).json({
        success: true,
        message: "Call event detected. Human handover activated."
    });
});

/**
 * MAIN WEBHOOK ENDPOINT: Chat Routing Engine
 */
app.post('/webhook/chat', async (req, res) => {
    try {
        const { userId, message, isOrderPlacement, isCallInitiated } = req.body;

        if (!userId || !message) {
            return res.status(400).json({ error: "userId and message parameters are required." });
        }

        const session = getOrCreateSession(userId);

        // 1. Check Existing Handover State
        if (session.humanHandover) {
            return res.json({
                reply: null,
                humanHandover: true,
                status: "Handover active. Managed by human agent."
            });
        }

        // 2. Direct Call Trigger Check
        if (isCallInitiated) {
            session.humanHandover = true;
            return res.json({
                reply: "আপনাকে ধন্যবাদ। কল করার বিষয়টি আমরা নথিভুক্ত করেছি, আমাদের গ্রাহক প্রতিনিধি এখনই যুক্ত হচ্ছেন।",
                humanHandover: true
            });
        }

        // 3. Direct Order Placement Check
        if (isOrderPlacement) {
            session.humanHandover = true;
            return res.json({
                reply: "আপনার অর্ডার অনুরোধটি গ্রহণ করা হয়েছে। অর্ডার চূড়ান্ত করতে প্রতিনিধি আপনার সাথে চ্যাটে যুক্ত হচ্ছেন।",
                humanHandover: true
            });
        }

        // 4. Update and Parse Contact/Address across chat turns
        parseContactInformation(message, session);
        if (session.humanHandover) {
            return res.json({
                reply: `আপনার ঠিকানা এবং ফোন নম্বর (${session.extractedPhone}) সংরক্ষিত হয়েছে। আমাদের প্রতিনিধি দ্রুত আপনার সাথে কথা বলছেন।`,
                humanHandover: true
            });
        }

        // 5. Handover Confirmation Response Parsing
        if (session.awaitingHandoverConfirmation) {
            const affirmativeTerms = ['হ্যাঁ', 'হা', 'yes', 'করুন', 'দিন', 'হস্তান্তর করুন', 'ঠিক আছে'];
            const cleanedInput = message.toLowerCase().trim();
            
            if (affirmativeTerms.some(term => cleanedInput.includes(term))) {
                session.humanHandover = true;
                session.awaitingHandoverConfirmation = false;
                return res.json({
                    reply: "ধন্যবাদ। আমি এখনই আমাদের প্রতিনিধির কাছে আপনার কথাটি হস্তান্তর করছি। অনুগ্রহ করে অপেক্ষা করুন।",
                    humanHandover: true
                });
            } else {
                session.awaitingHandoverConfirmation = false;
            }
        }

        // 6. User Manual Socket Memory
        const lowerMsg = message.toLowerCase();
        if (lowerMsg.includes('h4') || lowerMsg.includes('3 pin') || lowerMsg.includes('থ্রি পিন')) {
            session.userVerifiedPlugType = 'H4_3PIN';
        }

        // 7. Store Message in Session Memory
        session.messages.push({ role: 'user', content: message });

        // 8. Vehicle Fitment Evaluation Logic
        let vehicleContext = "";
        const vehicleKeywords = ['বাইক', 'গাড়ি', 'কার', 'সিএনজি', 'বাস', 'ট্রাক', 'bike', 'car', 'cng', 'bus', 'truck', 'model', 'মডেল', 'ফিট'];
        const isVehicleQuery = vehicleKeywords.some(kw => lowerMsg.includes(kw));

        if (isVehicleQuery) {
            // Level 1A: Internal Dynamic Catalog Search
            let catalogMatch = catalogDatabase.find(item => item.model && lowerMsg.includes(item.model));

            // Level 1B: Fallback to Built-in Default Vehicles Database if not in dynamic catalog
            if (!catalogMatch) {
                catalogMatch = BUILTIN_VEHICLE_DATABASE.find(item => item.model && lowerMsg.includes(item.model));
            }

            if (catalogMatch) {
                if (catalogMatch.hasH4Plug) {
                    vehicleContext = `ডাটাবেস নিশ্চিত করেছে: ${catalogMatch.brand ? catalogMatch.brand + ' ' : ''}${catalogMatch.model} গাড়িতে H4 / 3-Pin সকেট আছে। এটি সম্পূর্ণ ফিট হবে।`;
                } else {
                    vehicleContext = `ডাটাবেস নিশ্চিত করেছে: ${catalogMatch.brand ? catalogMatch.brand + ' ' : ''}${catalogMatch.model} গাড়িতে H4 / 3-Pin সকেট নেই। এটি সরাসরি ফিট হবে না।`;
                }
            } else {
                // Level 2: Linkup Online API Search
                const linkupSearchSuccess = await queryLinkupApi(message);
                
                if (linkupSearchSuccess === true) {
                    vehicleContext = `অনলাইন সার্চের তথ্য অনুযায়ী উক্ত যানবাহনে H4 / 3-Pin সকেট রয়েছে। এটি ব্যবহার করা যাবে।`;
                } else if (linkupSearchSuccess === false) {
                    vehicleContext = `অনলাইন সার্চের তথ্য অনুযায়ী উক্ত যানবাহনে H4 সকেট নেই।`;
                } else {
                    // Level 3: Customer Manual Verification Fallback
                    if (session.userVerifiedPlugType === 'H4_3PIN') {
                        vehicleContext = `কাস্টমার নিশ্চিত করেছেন যে তাদের গাড়িতে H4/3-Pin প্লাগ ব্যবহার করা হয়েছে। অতএব এটি ফিট হবে।`;
                    } else {
                        vehicleContext = `গাড়ির মডেলের সকেটের তথ্য ডাটাবেস বা অনলাইনে তথ্য নিয়ে নিশ্চিত হওয়া যাচ্ছে না। কাস্টমারকে নিজের গাড়িতে H4 plug বা 3 pin plug আছে কিনা তা যাচাই করার অনুরোধ জানান।`;
                    }
                }
            }
        }

        // 9. System Instruction Prompt Construction
        const systemPrompt = `
আপনার নাম ImpoTech AI। আপনি একটি অটোমোবাইল হেডলাইট ই-কমার্স শপের সহায়তাকারী এআই।
পণ্যের স্পেসিফিকেশন:
- আমাদের হেডলাইটটি একটি универсаল (Universal) H4 Plug / 3-Pin Plug হেডলাইট।
- এটি বাইক, কার, সিএনজি, বাস, কিংবা ট্রাক—যেকোনো যানবাহনে ব্যবহার করা যাবে, যদি তাতে H4 plug বা 3 pin plug থাকে।
- H4 plug এবং 3 pin plug একই সকেটকে নির্দেশ করে।

নির্দেশনা:
১. নির্দিষ্ট মডেল সম্পর্কিত উত্তর প্রদান করার ক্ষেত্রে এই কনটেক্সট ব্যবহার করুন: [${vehicleContext}]
২. যদি সকেটের তথ্য নিশ্চিত না হওয়া যায়, তবে স্পষ্টভাবে বলুন যে তথ্যটি স্বয়ংক্রিয়ভাবে যাচাই করা সম্ভব হচ্ছে না এবং কাস্টমারকে তার গাড়িতে H4 plug বা 3 pin plug আছে কিনা তা যাচাই করতে বলুন। কাস্টমার পরবর্তীতে যে তথ্য দেবে তা মনে রাখুন।
৩. কাস্টমার কোনো প্রশ্ন বুঝতে সমস্যা বোধ করলে বা বার্তা অস্পষ্ট হলে লিখুন: "আমার প্রশ্নটা বুঝতে সমস্যা হচ্ছে, আমি কী আমাদের প্রতিনিধির কাছে প্রশ্নটা হস্তান্তর করবো?"
৪. সিদ্ধান্ত নিতে জটিলতা দেখা দিলে লিখুন: "আপনি সরাসরি কল করুন তাহলে আরো ভালো দ্রুত সার্ভিস পাবেন।"
৫. ভাষা হতে হবে মার্জিত ও প্রমিত বাংলা। কোনো অবস্থাতেই মনগড়া বা কাল্পনিক উত্তর দিবেন না।
`;

        // 10. Gemini 3.1 Flash Light Inference
        const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-light',
            contents: [
                { role: 'user', parts: [{ text: systemPrompt }] },
                ...session.messages.slice(-6).map(m => ({
                    role: m.role === 'user' ? 'user' : 'model',
                    parts: [{ text: m.content }]
                })),
                { role: 'user', parts: [{ text: message }] }
            ]
        });

        const replyText = response.text ? response.text.trim() : "আপনি সরাসরি কল করুন তাহলে আরো ভালো দ্রুত সার্ভিস পাবেন।";

        if (replyText.includes("আমাদের প্রতিনিধির কাছে প্রশ্নটা হস্তান্তর করবো")) {
            session.awaitingHandoverConfirmation = true;
        }

        session.messages.push({ role: 'assistant', content: replyText });

        return res.json({
            reply: replyText,
            humanHandover: false
        });

    } catch (err) {
        console.error("Chat Execution Error:", err);
        return res.status(500).json({
            reply: "সিস্টেমে সাময়িক সমস্যা হয়েছে। আপনি সরাসরি কল করুন তাহলে আরো ভালো দ্রুত সার্ভিস পাবেন।",
            humanHandover: false
        });
    }
});

// Start Express Application
app.listen(PORT, () => {
    console.log(`E-Commerce AI Server active on port ${PORT}`);
});
