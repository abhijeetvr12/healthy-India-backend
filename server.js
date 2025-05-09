// server.js
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const tesseract = require('tesseract.js');
const { OpenAI } = require('openai');

const authRoutes = require('./routes/auth');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api/auth', authRoutes);

// 1) Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// 2) Initialize DeepSeek/OpenAI client
const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

// 3) Multer for in-memory uploads
const upload = multer({ storage: multer.memoryStorage() });

// 4) OCR & Analysis endpoint
app.post('/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided.' });
    }

    // a) Run OCR on the uploaded image
    const {
      data: { text: ocrText }
    } = await tesseract.recognize(req.file.buffer);

    // b) Build FSSAI‐aligned prompt
    const prompt = `
You are a food safety expert aligned with FSSAI (India) and global food safety standards.

Given the following list of food ingredients:
${ocrText.trim()}

Perform the following tasks:
1. Classify the product as either "Good for Consumption" or "Not Good for Consumption".
2. List specific reasons (e.g., high sugar, artificial preservatives, synthetic colorants, trans fats) clearly linked to the ingredients.
3. Suggest 2–3 healthier packaged food alternatives available in India.

Respond with a single valid JSON object (no markdown fences), in exactly this shape:

{
  "verdict": "Good for Consumption" | "Not Good for Consumption",
  "reasons": [
    "High sugar content",
    "Contains artificial preservatives"
  ],
  "suggested_alternatives": [
    {
      "name": "Organic Oats Muesli"
    },
    {
      "name": "Millet Flakes"
    }
  ]
}
`.trim();

    // c) Call DeepSeek chat completion
    const chatResponse = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a health assistant that evaluates food ingredients.' },
        { role: 'user', content: prompt }
      ]
    });

    const raw = chatResponse.choices[0].message.content;

    // d) Strip any code fences and isolate JSON
    let jsonText = raw
      .trim()
      .replace(/^```json\s*/, '')
      .replace(/^```\s*/, '')
      .replace(/```$/, '')
      .trim();

    const match = jsonText.match(/\{[\s\S]*\}$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid JSON in DeepSeek response.' });
    }

    // e) Parse JSON safely
    let result;
    try {
      result = JSON.parse(match[0]);
    } catch (parseErr) {
      return res.status(500).json({ error: 'Failed to parse JSON from DeepSeek.' });
    }

    // f) Send final structured result
    return res.json(result);

  } catch (err) {
    console.error('🛑 /analyze error:', err);
    return res.status(500).json({ error: 'Server error during analysis.' });
  }
});

// 5) Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
