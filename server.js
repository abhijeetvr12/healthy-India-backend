const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const tesseract = require('tesseract.js');
const { OpenAI } = require('openai');

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// Configure MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('Mongo error:', err));

// Setup OpenAI/DeepSeek
const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com"
});

// Multer config for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// OCR & DeepSeek Route
// OCR & DeepSeek Route
app.post('/analyze', upload.single('image'), async (req, res) => {
  try {
    const imageBuffer = req.file.buffer;

    // Step 1: OCR using tesseract.js
    const { data: { text: ocrText } } = await tesseract.recognize(imageBuffer);

    // Step 2: DeepSeek prompt
    const prompt = `
Given the following list of ingredients extracted from a food product:

${ocrText}

1. Is it healthy for me? (Respond with: "Healthy" or "Unhealthy")
2. If Unhealthy, which ingredients are causing this and how unhealthy are they?
3. What is the impact of these ingredients on my health and the approximate time to observe these effects?

Respond strictly in this JSON format:
{
  "is_healthy": "Healthy/Unhealthy",
  "unhealthy_ingredients": {
    "Ingredient A": "Very Unhealthy"
  },
  "health_impacts": {
    "Ingredient A": "Raises blood pressure (6 months)"
  }
}
`;

    const chatResponse = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "You are a health assistant that evaluates ingredients." },
        { role: "user", content: prompt }
      ]
    });

    const content = chatResponse.choices[0].message.content;

    // 🔧 Extract JSON safely using regex
    const match = content.match(/\{[\s\S]*?\}/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid or missing JSON in DeepSeek response.' });
    }

    let result;
    try {
      result = JSON.parse(match[0]);
    } catch (jsonErr) {
      console.error('JSON parse error:', jsonErr);
      return res.status(500).json({ error: 'Failed to parse DeepSeek JSON response.' });
    }

    res.json(result);
  } catch (err) {
    console.error('OCR/AI Error:', err);
    res.status(500).json({ error: 'Server error during analysis.' });
  }
});


// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
