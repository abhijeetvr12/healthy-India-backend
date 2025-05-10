// server.js
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const tesseract = require("tesseract.js");
const { OpenAI } = require("openai");

const authRoutes = require("./routes/auth");

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api/auth", authRoutes);

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

    // a) Run OCR on the uploaded image
    const {
      data: { text: ocrText },
    } = await tesseract.recognize(req.file.buffer);

    // b) Build FSSAI‐aligned prompt
    const prompt = `
You are a food safety expert aligned with FSSAI (India) and global food safety standards.

Given the scanned image text of the food product's ingredient section:
${ocrText.trim()}

Perform the following steps:

1. **Extract the list of ingredients** from the scanned text. Focus only on the actual ingredients list and ignore other details like nutritional info, usage, or manufacturer data.

2. For **each ingredient**, provide the following classification:
   - Type: "Artificial", "Natural", or "Synthetic"
   - Processing Level: "Processed" or "Unprocessed"
   - Safety Level (as per FSSAI): "Above Safe Limit", "Below Safe Limit", or "Limit Not Specified"
   - Health Impact: Known effects on human health (e.g., "Linked to diabetes", "Potential allergen", "No known adverse effect")

3. **Generate Alerts**:
   - Total number of concerning ingredients based on being artificial/synthetic, above safe limits, or having harmful health impacts
   - Product Labels:
     - If any ingredient is artificial → Add "Contains Artificial Substances"
     - If any ingredient is synthetic → Add "Contains Synthetic Substances"
     - If any ingredient is above the FSSAI safe limit → Add "Unhealthy"
     - Based on cumulative health impacts → Add an overall label such as "Potentially Harmful", "Caution Advised", or "Safe"

4. **Suggest 2–3 healthier alternatives** from **Indian brands** that:
   - Offer a similar product type (e.g., chips, cookies, drinks)
   - Use only natural or minimally processed ingredients
   - Do not contain the identified harmful substances
   - Include a **buy link that redirects through our site** to the actual product on the merchant website.

Respond in the exact JSON format below (no markdown fences):

{
  "ingredients_analyzed": [
    {
      "name": "ingredient1",
      "type": "Artificial" | "Natural" | "Synthetic",
      "processing_level": "Processed" | "Unprocessed",
      "safety_level": "Above Safe Limit" | "Below Safe Limit" | "Limit Not Specified",
      "health_impact": "Brief summary of health effects"
    },
    ...
  ],
  "product_labels": [
    "Contains Artificial Substances",
    "Unhealthy",
    "Potentially Harmful"
  ],
  "total_alerts": 3,
  "suggested_alternatives": [
    {
      "name": "Ragi Cookies",
      "brand": "Tata Soulfull",
      "category": "Cookies",
      "buy_link": "https://yourplatform.com/redirect/tata-soulfull-ragi-cookies"
    },
    {
      "name": "Jowar Chips",
      "brand": "Too Yumm",
      "category": "Snacks",
      "buy_link": "https://yourplatform.com/redirect/too-yumm-jowar-chips"
    }
  ]
}
`;

    // c) Call DeepSeek chat completion
    const chatResponse = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content:
            "You are a health assistant that evaluates food ingredients.",
        },
        { role: "user", content: prompt },
      ],
    });

    const raw = chatResponse.choices[0].message.content;

    // d) Strip any code fences and isolate JSON
    let jsonText = raw
      .trim()
      .replace(/^```json\s*/, "")
      .replace(/^```\s*/, "")
      .replace(/```$/, "")
      .trim();

    const match = jsonText.match(/\{[\s\S]*\}$/);
    if (!match) {
      return res
        .status(400)
        .json({ error: "Invalid JSON in DeepSeek response." });
    }

    // e) Parse JSON safely
    let result;
    try {
      result = JSON.parse(match[0]);
    } catch (parseErr) {
      return res
        .status(500)
        .json({ error: "Failed to parse JSON from DeepSeek." });
    }

    // f) Send final structured result
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
