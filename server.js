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

// Configure MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Initialize OpenAI / DeepSeek client
const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

// Multer config for in-memory file uploads
const upload = multer({ storage: multer.memoryStorage() });

// OCR & DeepSeek analysis route
app.post('/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided.' });
    }

    // 1) OCR
    const { data: { text: ocrText } } = await tesseract.recognize(req.file.buffer);

    // 2) Build prompt: raw JSON only, no fences or extra text
    const prompt = `
You are a health assistant that evaluates food ingredients.
Given the following list of ingredients extracted from a food product:

${ocrText}

Respond with a single valid JSON object, with no markdown fences or extra commentary:

{
  "is_healthy": "Healthy" or "Unhealthy",
  "unhealthy_ingredients": {
    "Ingredient A": ""
  },
  "health_impacts": {
    "Ingredient A": "Raises blood pressure (6 months)"
  }
}
`;

    // 3) Call DeepSeek chat completion
    const chatResponse = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a health assistant that evaluates ingredients.' },
        { role: 'user', content: prompt.trim() },
      ],
    });

    const raw = chatResponse.choices[0].message.content;
    console.log('💬 DeepSeek raw response:', raw);

    // 4) Strip code fences if any, then extract JSON block
    let jsonText = raw
      .trim()
      .replace(/^```json\s*/, '')
      .replace(/^```\s*/, '')
      .replace(/```$/, '')
      .trim();

    const match = jsonText.match(/\{[\s\S]*\}$/);
    if (!match) {
      console.error('❌ No JSON object found in DeepSeek response.');
      return res.status(400).json({ error: 'Invalid or missing JSON in DeepSeek response.' });
    }

    // 5) Parse JSON
    let result;
    try {
      result = JSON.parse(match[0]);
    } catch (parseErr) {
      console.error('❌ JSON.parse error:', parseErr);
      return res.status(500).json({ error: 'Failed to parse DeepSeek JSON response.' });
    }

    // 6) Return structured result
    return res.json(result);
  } catch (err) {
    console.error('🛑 OCR/AI error:', err);
    return res.status(500).json({ error: 'Server error during analysis.' });
  }
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
