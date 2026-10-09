require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Render PostgreSQL Connection Pool Setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') 
        ? false 
        : { rejectUnauthorized: false }
});

// Capture Raw Body Buffer for Signature Verification
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(cors());

// In-Memory Global Caches for Catalog and FAQs
let catalogCache = [];
let faqCache = [];

// ==========================================
// 1. GITHUB API INTEGRATION HELPERS
// ==========================================

async function getGithubFile(filePath) {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const token = process.env.GITHUB_TOKEN;

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'IMPOTECH-Bot-Backend'
            }
        });
        const contentStr = Buffer.from(response.data.content, 'base64').toString('utf-8');
        return {
            sha: response.data.sha,
            data: JSON.parse(contentStr)
        };
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return { sha: null, data: [] };
        }
        console.error(`[GitHub REST API] Error reading ${filePath}:`, error.message);
        throw error;
    }
}

async function updateGithubFile(filePath, contentObj, commitMessage, sha = null) {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const token = process.env.GITHUB_TOKEN;

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
    const base64Content = Buffer.from(JSON.stringify(contentObj, null, 2)).toString('base64');

    let currentSha = sha;
    if (!currentSha) {
        try {
            const fileInfo = await getGithubFile(filePath);
            currentSha = fileInfo.sha;
        } catch (e) {
            currentSha = null;
        }
    }

    const requestBody = {
        message: commitMessage,
        content: base64Content,
        branch: branch
    };
    if (currentSha) {
        requestBody.sha = currentSha;
    }

    const response = await axios.put(url, requestBody, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'IMPOTECH-Bot-Backend'
        }
    });

    return response.data;
}

async function reloadCaches() {
    try {
        const catalogFile = await getGithubFile('catalog.json');
        catalogCache = catalogFile.data || [];

        const faqFile = await getGithubFile('faqs.json');
        faqCache = faqFile.data || [];

        console.log('[System] In-memory Catalog and FAQ Caches updated successfully.');
    } catch (error) {
        console.error('[System] Failed to load initial cache from GitHub:', error.message);
    }
}

// ==========================================
// 2. DATABASE INITIALIZATION & MIGRATIONS
// ==========================================

async function initDatabase() {
    const migrationSQL = `
        CREATE TABLE IF NOT EXISTS customers (
            id SERIAL PRIMARY KEY,
            psid VARCHAR(255) UNIQUE NOT NULL,
            name VARCHAR(255),
            phone VARCHAR(50),
            address TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id SERIAL PRIMARY KEY,
            customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
            psid VARCHAR(255) UNIQUE NOT NULL,
            is_human_agent BOOLEAN DEFAULT FALSE,
            unread_count INT DEFAULT 0,
            last_message TEXT,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
            sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('user', 'ai', 'human')),
            message_text TEXT,
            attachment_type VARCHAR(50),
            attachment_url TEXT,
            mid VARCHAR(255) UNIQUE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY,
            customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
            psid VARCHAR(255) NOT NULL,
            items JSONB NOT NULL,
            total_amount NUMERIC(10, 2) NOT NULL,
            status VARCHAR(50) DEFAULT 'pending',
            delivery_address TEXT,
            phone_number VARCHAR(50),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_customers_psid ON customers(psid);
        CREATE INDEX IF NOT EXISTS idx_conversations_psid ON conversations(psid);
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_messages_mid ON messages(mid);
        CREATE INDEX IF NOT EXISTS idx_orders_psid ON orders(psid);
    `;
    try {
        await pool.query(migrationSQL);
        console.log('[Database] Schema verified and initialized.');
    } catch (error) {
        console.error('[Database] Migration Error:', error.message);
    }
}

// ==========================================
// 3. SECURITY MIDDLEWARES
// ==========================================

function verifyAdminToken(req, res, next) {
    const token = req.headers['x-admin-token'] || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
    if (!token || token !== process.env.ADMIN_API_TOKEN) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid Admin Token' });
    }
    next();
}

function verifyFacebookSignature(req, res, buf, encoding) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
        return true;
    }
    const signatureHash = signature.split('=')[1];
    const expectedHash = crypto
        .createHmac('sha256', process.env.APP_SECRET)
        .update(buf)
        .digest('hex');

    if (signatureHash !== expectedHash) {
        console.error('[Security] Meta Webhook Signature Mismatch');
        return false;
    }
    return true;
}

// ==========================================
// 4. MESSENGER & OPENROUTER ENGINE
// ==========================================

async function sendMessengerMessage(psid, responsePayload) {
    const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`;
    const data = {
        recipient: { id: psid },
        messaging_type: 'RESPONSE',
        message: responsePayload
    };

    try {
        const response = await axios.post(url, data);
        return response.data;
    } catch (error) {
        console.error('[Messenger API] Send Error:', error.response ? error.response.data : error.message);
        throw error;
    }
}

async function processOpenRouterAI(psid, userMessageText, imageUrl = null) {
    const systemPrompt = `
You are the official AI Customer Support Agent for IMPOTECH BD.
Be extremely polite, helpful, clear, and professional in Bengali (or English if requested).

PRODUCT CATALOG DATA:
${JSON.stringify(catalogCache, null, 2)}

FREQUENTLY ASKED QUESTIONS (FAQ) DATA:
${JSON.stringify(faqCache, null, 2)}

INSTRUCTIONS:
1. Provide accurate answers using exclusively the Catalog and FAQ data provided above.
2. If a customer wishes to place an order, collect their Product ID/Title, Quantity, Delivery Address, and Contact Phone Number.
3. Do not invent products or offer unlisted discounts.
4. Keep answers clear, structured, and friendly for Messenger chat format.
`;

    const userContent = [];
    if (userMessageText) {
        userContent.push({ type: 'text', text: userMessageText });
    }
    if (imageUrl) {
        userContent.push({ type: 'image_url', image_url: { url: imageUrl } });
    }

    const payload = {
        model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent.length === 1 && userContent[0].type === 'text' ? userMessageText : userContent }
        ]
    };

    try {
        const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', payload, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://impotechbd.com',
                'X-Title': 'IMPOTECH BD Bot',
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('[OpenRouter API] Completion Error:', error.response ? error.response.data : error.message);
        return 'দুঃখিত, এই মুহূর্তে তথ্য প্রসেসিংয়ে সাময়িক বিলম্ব হচ্ছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।';
    }
}

async function handleIncomingMessengerEvent(event) {
    const psid = event.sender.id;
    if (!event.message) return;

    const { mid, text, attachments } = event.message;

    // Deduplication Check via Unique Message ID (mid)
    if (mid) {
        const existingMsg = await pool.query('SELECT id FROM messages WHERE mid = $1', [mid]);
        if (existingMsg.rows.length > 0) {
            console.log(`[Deduplication] Message ID ${mid} already processed. Dropping event.`);
            return;
        }
    }

    // Customer Record Resolution
    let customerRes = await pool.query('SELECT id FROM customers WHERE psid = $1', [psid]);
    let customerId;
    if (customerRes.rows.length === 0) {
        const newCust = await pool.query(
            'INSERT INTO customers (psid) VALUES ($1) RETURNING id',
            [psid]
        );
        customerId = newCust.rows[0].id;
    } else {
        customerId = customerRes.rows[0].id;
    }

    // Conversation State Resolution
    let convRes = await pool.query('SELECT id, is_human_agent FROM conversations WHERE psid = $1', [psid]);
    let convId;
    let isHumanAgent = false;

    if (convRes.rows.length === 0) {
        const newConv = await pool.query(
            'INSERT INTO conversations (customer_id, psid, is_human_agent, unread_count, last_message, updated_at) VALUES ($1, $2, false, 1, $3, NOW()) RETURNING id',
            [customerId, psid, text || '[Attachment]']
        );
        convId = newConv.rows[0].id;
    } else {
        convId = convRes.rows[0].id;
        isHumanAgent = convRes.rows[0].is_human_agent;
        await pool.query(
            'UPDATE conversations SET unread_count = unread_count + 1, last_message = $1, updated_at = NOW() WHERE id = $2',
            [text || '[Attachment]', convId]
        );
    }

    // Extract Media Attachments
    let attachmentType = null;
    let attachmentUrl = null;
    if (attachments && attachments.length > 0) {
        attachmentType = attachments[0].type;
        attachmentUrl = attachments[0].payload ? attachments[0].payload.url : null;
    }

    // Persist Incoming User Message
    await pool.query(
        'INSERT INTO messages (conversation_id, sender_type, message_text, attachment_type, attachment_url, mid) VALUES ($1, $2, $3, $4, $5, $6)',
        [convId, 'user', text || '', attachmentType, attachmentUrl, mid]
    );

    // CRITICAL: Prevent AI Response when Human Takeover Mode is Active
    if (isHumanAgent) {
        console.log(`[Human Takeover] Session PSID ${psid} is in Human Agent Mode. AI Response Blocked.`);
        return;
    }

    // Parse Multimodal Context
    let effectiveText = text;
    let effectiveImageUrl = null;

    if (attachmentType === 'image') {
        effectiveImageUrl = attachmentUrl;
    } else if (attachmentType === 'audio') {
        effectiveText = effectiveText 
            ? `${effectiveText} [Voice Message Attachment: ${attachmentUrl}]` 
            : `[Voice Message Attachment: ${attachmentUrl}]`;
    }

    // Generate AI Reply
    const aiResponseText = await processOpenRouterAI(psid, effectiveText, effectiveImageUrl);

    // Dispatch AI Reply to Facebook Messenger
    await sendMessengerMessage(psid, { text: aiResponseText });

    // Persist AI Outgoing Message
    await pool.query(
        'INSERT INTO messages (conversation_id, sender_type, message_text) VALUES ($1, $2, $3)',
        [convId, 'ai', aiResponseText]
    );

    // Update Conversation Summary Status
    await pool.query(
        'UPDATE conversations SET last_message = $1, updated_at = NOW() WHERE id = $2',
        [aiResponseText, convId]
    );
}

// ==========================================
// 5. WEBHOOK CONTROLLER ENDPOINTS
// ==========================================

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
            console.log('[Webhook] Challenge verification succeeded.');
            return res.status(200).send(challenge);
        } else {
            return res.sendStatus(403);
        }
    }
    res.sendStatus(400);
});

app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        res.status(200).send('EVENT_RECEIVED'); // Immediate 200 OK Response

        for (const entry of body.entry) {
            if (entry.messaging) {
                for (const webhookEvent of entry.messaging) {
                    try {
                        await handleIncomingMessengerEvent(webhookEvent);
                    } catch (err) {
                        console.error('[Webhook] Processing Execution Error:', err.message);
                    }
                }
            }
        }
    } else {
        res.sendStatus(404);
    }
});

// ==========================================
// 6. ADMIN API: PRODUCTS (GITHUB SYNC)
// ==========================================

app.get('/api/admin/products', verifyAdminToken, (req, res) => {
    res.json({ success: true, data: catalogCache });
});

app.post('/api/admin/products', verifyAdminToken, async (req, res) => {
    try {
        const newProduct = req.body;
        if (!newProduct.id || !newProduct.title || !newProduct.price) {
            return res.status(400).json({ success: false, error: 'Missing mandatory fields: id, title, price' });
        }

        const fileInfo = await getGithubFile('catalog.json');
        let products = fileInfo.data || [];

        if (products.some(p => String(p.id) === String(newProduct.id))) {
            return res.status(409).json({ success: false, error: 'Product with this ID already exists' });
        }

        products.push(newProduct);
        await updateGithubFile('catalog.json', products, `Add product: ${newProduct.title}`, fileInfo.sha);
        
        catalogCache = products; // Sync local cache ONLY after verified GitHub commit
        res.json({ success: true, message: 'Product created and committed to GitHub successfully', data: newProduct });
    } catch (error) {
        console.error('[Admin Product Create Error]:', error.message);
        res.status(500).json({ success: false, error: 'Failed to commit product to GitHub repository' });
    }
});

app.put('/api/admin/products/:id', verifyAdminToken, async (req, res) => {
    try {
        const productId = req.params.id;
        const updatedFields = req.body;

        const fileInfo = await getGithubFile('catalog.json');
        let products = fileInfo.data || [];

        const index = products.findIndex(p => String(p.id) === String(productId));
        if (index === -1) {
            return res.status(404).json({ success: false, error: 'Product not found in catalog' });
        }

        products[index] = { ...products[index], ...updatedFields };
        await updateGithubFile('catalog.json', products, `Update product ID: ${productId}`, fileInfo.sha);

        catalogCache = products;
        res.json({ success: true, message: 'Product updated and committed to GitHub successfully', data: products[index] });
    } catch (error) {
        console.error('[Admin Product Update Error]:', error.message);
        res.status(500).json({ success: false, error: 'Failed to update product on GitHub' });
    }
});

app.delete('/api/admin/products/:id', verifyAdminToken, async (req, res) => {
    try {
        const productId = req.params.id;

        const fileInfo = await getGithubFile('catalog.json');
        let products = fileInfo.data || [];

        const filteredProducts = products.filter(p => String(p.id) !== String(productId));
        if (products.length === filteredProducts.length) {
            return res.status(404).json({ success: false, error: 'Product ID not found' });
        }

        await updateGithubFile('catalog.json', filteredProducts, `Delete product ID: ${productId}`, fileInfo.sha);

        catalogCache = filteredProducts;
        res.json({ success: true, message: 'Product deleted from GitHub repository successfully' });
    } catch (error) {
        console.error('[Admin Product Delete Error]:', error.message);
        res.status(500).json({ success: false, error: 'Failed to delete product from GitHub' });
    }
});

// ==========================================
// 7. ADMIN API: FAQS (GITHUB SYNC)
// ==========================================

app.get('/api/admin/faqs', verifyAdminToken, (req, res) => {
    res.json({ success: true, data: faqCache });
});

app.post('/api/admin/faqs', verifyAdminToken, async (req, res) => {
    try {
        const newFaq = req.body;
        if (!newFaq.id || !newFaq.question || !newFaq.answer) {
            return res.status(400).json({ success: false, error: 'Missing mandatory FAQ fields: id, question, answer' });
        }

        const fileInfo = await getGithubFile('faqs.json');
        let faqs = fileInfo.data || [];

        if (faqs.some(f => String(f.id) === String(newFaq.id))) {
            return res.status(409).json({ success: false, error: 'FAQ entry with this ID already exists' });
        }

        faqs.push(newFaq);
        await updateGithubFile('faqs.json', faqs, `Add FAQ ID: ${newFaq.id}`, fileInfo.sha);

        faqCache = faqs;
        res.json({ success: true, message: 'FAQ committed to GitHub successfully', data: newFaq });
    } catch (error) {
        console.error('[Admin FAQ Create Error]:', error.message);
        res.status(500).json({ success: false, error: 'Failed to commit FAQ to GitHub' });
    }
});

app.put('/api/admin/faqs/:id', verifyAdminToken, async (req, res) => {
    try {
        const faqId = req.params.id;
        const updatedFields = req.body;

        const fileInfo = await getGithubFile('faqs.json');
        let faqs = fileInfo.data || [];

        const index = faqs.findIndex(f => String(f.id) === String(faqId));
        if (index === -1) {
            return res.status(404).json({ success: false, error: 'FAQ entry not found' });
        }

        faqs[index] = { ...faqs[index], ...updatedFields };
        await updateGithubFile('faqs.json', faqs, `Update FAQ ID: ${faqId}`, fileInfo.sha);

        faqCache = faqs;
        res.json({ success: true, message: 'FAQ updated on GitHub successfully', data: faqs[index] });
    } catch (error) {
        console.error('[Admin FAQ Update Error]:', error.message);
        res.status(500).json({ success: false, error: 'Failed to update FAQ on GitHub' });
    }
});

app.delete('/api/admin/faqs/:id', verifyAdminToken, async (req, res) => {
    try {
        const faqId = req.params.id;

        const fileInfo = await getGithubFile('faqs.json');
        let faqs = fileInfo.data || [];

        const filteredFaqs = faqs.filter(f => String(f.id) !== String(faqId));
        if (faqs.length === filteredFaqs.length) {
            return res.status(404).json({ success: false, error: 'FAQ ID not found' });
        }

        await updateGithubFile('faqs.json', filteredFaqs, `Delete FAQ ID: ${faqId}`, fileInfo.sha);

        faqCache = filteredFaqs;
        res.json({ success: true, message: 'FAQ deleted from GitHub successfully' });
    } catch (error) {
        console.error('[Admin FAQ Delete Error]:', error.message);
        res.status(500).json({ success: false, error: 'Failed to delete FAQ from GitHub' });
    }
});

// ==========================================
// 8. ADMIN API: CONVERSATIONS & HUMAN TAKEOVER
// ==========================================

app.get('/api/admin/conversations', verifyAdminToken, async (req, res) => {
    try {
        const query = `
            SELECT c.id, c.psid, c.is_human_agent, c.unread_count, c.last_message, c.updated_at,
                   cust.name, cust.phone, cust.address
            FROM conversations c
            LEFT JOIN customers cust ON c.customer_id = cust.id
            ORDER BY c.updated_at DESC
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('[Admin Conversations Fetch Error]:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch conversations from database' });
    }
});

app.post('/api/admin/takeover', verifyAdminToken, async (req, res) => {
    try {
        const { psid } = req.body;
        if (!psid) {
            return res.status(400).json({ success: false, error: 'PSID parameter is required' });
        }

        const result = await pool.query(
            'UPDATE conversations SET is_human_agent = true, updated_at = NOW() WHERE psid = $1 RETURNING *',
            [psid]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Conversation session not found for provided PSID' });
        }

        res.json({ success: true, message: 'Human Takeover mode activated successfully. AI disabled.', data: result.rows[0] });
    } catch (error) {
        console.error('[Admin Takeover Activation Error]:', error.message);
        res.status(500).json({ success: false, error: 'Failed to set takeover mode' });
    }
});

app.post('/api/admin/resume-ai', verifyAdminToken, async (req, res) => {
    try {
        const { psid } = req.body;
        if (!psid) {
            return res.status(400).json({ success: false, error: 'PSID parameter is required' });
        }

        const result = await pool.query(
            'UPDATE conversations SET is_human_agent = false, updated_at = NOW() WHERE psid = $1 RETURNING *',
            [psid]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Conversation session not found for provided PSID' });
        }

        res.json({ success: true, message: 'AI Agent resumed successfully for this PSID', data: result.rows[0] });
    } catch (error) {
        console.error('[Admin Resume AI Error]:', error.message);
        res.status(500).json({ success: false, error: 'Failed to resume AI agent' });
    }
});

app.post('/api/admin/reply', verifyAdminToken, async (req, res) => {
    try {
        const { psid, text } = req.body;
        if (!psid || !text) {
            return res.status(400).json({ success: false, error: 'PSID and reply text are required' });
        }

        // Deliver Human Agent Reply via Facebook Graph API
        await sendMessengerMessage(psid, { text });

        // Update Database Message Ledger
        const convRes = await pool.query('SELECT id FROM conversations WHERE psid = $1', [psid]);
        if (convRes.rows.length > 0) {
            const convId = convRes.rows[0].id;
            await pool.query(
                'INSERT INTO messages (conversation_id, sender_type, message_text) VALUES ($1, $2, $3)',
                [convId, 'human', text]
            );
            await pool.query(
                'UPDATE conversations SET unread_count = 0, last_message = $1, updated_at = NOW() WHERE id = $2',
                [text, convId]
            );
        }

        res.json({ success: true, message: 'Human response delivered successfully to Facebook Messenger' });
    } catch (error) {
        console.error('[Admin Reply Error]:', error.message);
        res.status(500).json({ success: false, error: 'Failed to dispatch reply via Messenger API' });
    }
});

// ==========================================
// 9. ADMIN API: ORDER MANAGEMENT
// ==========================================

app.get('/api/admin/orders', verifyAdminToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT o.*, c.name as customer_name 
            FROM orders o 
            LEFT JOIN customers c ON o.customer_id = c.id 
            ORDER BY o.created_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('[Admin Orders Fetch Error]:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch order records' });
    }
});

app.post('/api/admin/orders', verifyAdminToken, async (req, res) => {
    try {
        const { psid, items, total_amount, delivery_address, phone_number } = req.body;
        if (!psid || !items || !total_amount) {
            return res.status(400).json({ success: false, error: 'Missing mandatory order fields (psid, items, total_amount)' });
        }

        let customerRes = await pool.query('SELECT id FROM customers WHERE psid = $1', [psid]);
        let customerId = customerRes.rows.length > 0 ? customerRes.rows[0].id : null;

        const result = await pool.query(
            'INSERT INTO orders (customer_id, psid, items, total_amount, delivery_address, phone_number) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [customerId, psid, JSON.stringify(items), total_amount, delivery_address || '', phone_number || '']
        );

        res.json({ success: true, message: 'Order created successfully', data: result.rows[0] });
    } catch (error) {
        console.error('[Admin Order Create Error]:', error.message);
        res.status(500).json({ success: false, error: 'Failed to create order in database' });
    }
});

app.put('/api/admin/orders/:id/status', verifyAdminToken, async (req, res) => {
    try {
        const orderId = req.params.id;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({ success: false, error: 'Status string is required' });
        }

        const result = await pool.query(
            'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
            [status, orderId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Order ID not found' });
        }

        res.json({ success: true, message: 'Order status updated successfully', data: result.rows[0] });
    } catch (error) {
        console.error('[Admin Order Status Error]:', error.message);
        res.status(500).json({ success: false, error: 'Failed to update order status' });
    }
});

// ==========================================
// 10. ADMIN API: CACHE SYNC
// ==========================================

app.post('/api/admin/cache-refresh', verifyAdminToken, async (req, res) => {
    try {
        await reloadCaches();
        res.json({ success: true, message: 'Catalog and FAQ caches reloaded from GitHub successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to refresh caches from GitHub' });
    }
});
// ==========================================
// AI TRAINING & RENDER SYNC ENDPOINT
// ==========================================

app.post('/api/training', async (req, res) => {
    try {
        // গিটহাব থেকে ক্যাটালগ ও FAQ ডেটা ইন-মেমরি ক্যাশে নতুন করে লোড করা
        await reloadCaches();

        return res.json({
            success: true,
            message: 'Render sync and AI training completed successfully',
            catalogCount: catalogCache.length,
            faqCount: faqCache.length
        });
    } catch (error) {
        console.error('[Sync / Training Error]:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to sync with Render backend'
        });
    }
});
// ==========================================
// 11. BOOTSTRAP EXPRESS SERVER
// ==========================================

app.listen(PORT, async () => {
    console.log(`[IMPOTECH Server] Running on port ${PORT}`);
    await initDatabase();
    await reloadCaches();
});
