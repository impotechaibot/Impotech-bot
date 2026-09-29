const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'impotech_secret_123';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.8-flash';

const SYSTEM_INSTRUCTION = `
You are a polite, helpful e-commerce support assistant for 'ImpoTech Bd' in Bangladesh.
Rules:
1. Reply politely in natural Bengali (বাংলা).
2. Delivery info: Dhaka 70 BDT, outside Dhaka 130 BDT with Cash on Delivery (COD).
3. If they ask to order, politely ask for their Name, Full Address, and Phone Number.
4. If an image is sent, examine the product and reply politely.
5. If a voice message is sent, listen to what they said in Bengali and answer their query.
6. Keep it concise, professional, and friendly (within 2-3 sentences).
`;

// ১. ফেসবুকের সাথে কানেক্ট (Webhook Verification)
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// ২. ফেসবুক থেকে মেসেজ/ভয়েস/ছবি রিসিভ করা ও জেমিনাই দিয়ে উত্তর দেওয়া
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      for (const event of entry.messaging) {
        const senderId = event.sender?.id;
        const msg = event.message;

        if (!msg || msg.is_echo) continue;

        let userText = msg.text || '';
        let mediaBase64 = null;
        let mimeType = 'image/jpeg';

        if (msg.attachments && msg.attachments.length > 0) {
          const att = msg.attachments[0];
          const mediaUrl = att.payload?.url;
          if (mediaUrl) {
            try {
              const fileResp = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
              mediaBase64 = Buffer.from(fileResp.data).toString('base64');
              mimeType = fileResp.headers['content-type']?.split(';')[0] || (att.type === 'audio' ? 'audio/mp4' : 'image/jpeg');
            } catch (err) {
              console.error('Media download error:', err.message);
            }
          }
        }

        const parts = [];
        if (mediaBase64) {
          parts.push({ inline_data: { mime_type: mimeType, data: mediaBase64 } });
        }
        parts.push({ text: `${SYSTEM_INSTRUCTION}\n\nCustomer: ${userText}` });

        try {
          const geminiResp = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            { contents: [{ parts }] }
          );

          const aiReply = geminiResp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 
                          'আসসালামু আলাইকুম! ImpoTech Bd-তে আপনাকে স্বাগতম। আমাদের প্রতিনিধি দ্রুত যোগাযোগ করবে।';

          await axios.post(
            `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            {
              recipient: { id: senderId },
              message: { text: aiReply }
            }
          );
        } catch (e) {
          console.error('AI Error:', e.response?.data || e.message);
        }
      }
    }
  }
});

app.get('/', (req, res) => res.send('ImpoTech Bd AI Bot is Running!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
