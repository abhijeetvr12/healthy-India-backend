require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const tesseract = require("tesseract.js");
const { OpenAI } = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

// 1) Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// 2) Initialize DeepSeek/OpenAI client
const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

// 3) Multer for in-memory uploads
const upload = multer({ storage: multer.memoryStorage() });

// 4) OCR & Analysis endpoint
app.post("/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided." });
    }

    // a) Run OCR
    const {
      data: { text: ocrText },
    } = await tesseract.recognize(req.file.buffer);

    // b) Build prompt with benefit categories
    const prompt = `
You are a food safety expert aligned with FSSAI (India) and global food safety standards.

Given the scanned image text of the food product's ingredient section:
${ocrText.trim()}

Perform the following steps:

1. Extract the list of ingredients.
2. For each ingredient, classify:
   - Type: Artificial | Natural | Synthetic
   - Processing Level: Processed | Unprocessed
   - Safety Level (FSSAI): Above Safe Limit | Below Safe Limit | Limit Not Specified
   - Health Impact: Brief summary (e.g. “Linked to diabetes”, “Potential allergen”, etc.)

3. Generate Alerts:
   - Total number of concerning ingredients
   - Product Labels: Contains Artificial Substances, Contains Synthetic Substances, Unhealthy, Potentially Harmful, and overall Processed or Unprocessed.

4. Suggest 2–3 healthier alternatives from Indian brands, grouped under these benefit categories:
   - Helps in weight loss
   - Rich in protein
   - Improve gut health

Each alternative needs:
- name
- brand
- category
- buy_link_own (your platform redirect)
- buy_link_amazon (actual Amazon link)

Respond with this JSON exactly (no fences):

{
  "ingredients_analyzed": [ /* … */ ],
  "product_labels": [ /* … */ ],
  "total_alerts": 3,
  "benefit_categories": [
    {
      "label": "Helps in weight loss",
      "alternatives": [
        {
          "name": "Example",
          "brand": "Brand",
          "category": "Snack",
          "buy_link_own": "https://yourplatform.com/redirect/example",
          "buy_link_amazon": "https://www.amazon.in/…"
        }
      ]
    },
    {
      "label": "Rich in protein",
      "alternatives": [ /* … */ ]
    },
    {
      "label": "Improve gut health",
      "alternatives": [ /* … */ ]
    }
  ]
}
`.trim();

    // c) Call DeepSeek chat completion
    const chat = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "You are a health assistant that evaluates food ingredients." },
        { role: "user", content: prompt },
      ],
    });
    let raw = chat.choices[0].message.content;
    raw = raw.replace(/^```json\s*/, "").replace(/```$/, "").trim();
    const match = raw.match(/\{[\s\S]*\}$/);
    if (!match) {
      return res.status(400).json({ error: "Invalid JSON in LLM response." });
    }

    const result = JSON.parse(match[0]);
    return res.json(result);

  } catch (err) {
    console.error("🛑 /analyze error:", err);
    return res.status(500).json({ error: "Server error during analysis." });
  }
});

// 5) Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
