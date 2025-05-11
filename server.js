
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");  
const tesseract = require("tesseract.js");
const { OpenAI } = require("openai");
const admin = require("firebase-admin");

// init Firebase Admin
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
app.use(cors());
app.use(express.json());

// connect MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// Mongoose schema for storing results
const AnalysisResultSchema = new mongoose.Schema({
  uid: String,             // Firebase UID
  phone: String,           // user phone
  imageUrl: String,        // local path or hosted URL
  location: {
    latitude: Number,
    longitude: Number,
  },
  ingredients_analyzed: Array,
  product_labels: [String],
  total_alerts: Number,
  suggested_alternatives: Array,
  createdAt: { type: Date, default: Date.now },
});
const AnalysisResult = mongoose.model("AnalysisResult", AnalysisResultSchema);

// init OpenAI/DeepSeek
const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

// multer for image upload
const upload = multer({ storage: multer.memoryStorage() });

// middleware: verify Firebase ID token
async function authenticate(req, res, next) {
  const idToken = req.headers.authorization?.split("Bearer ")[1];
  if (!idToken) return res.status(401).json({ error: "No token" });
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.uid = decoded.uid;
    req.phone = decoded.phone_number;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// OCR & analysis endpoint
app.post("/analyze", authenticate, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });

    // OCR
    const {
      data: { text: ocrText },
    } = await tesseract.recognize(req.file.buffer);

    // build prompt
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
   - Product Labels (include any combination of these and also whether the product itself is Processed or Unprocessed):
     - "Contains Artificial Substances"
     - "Contains Synthetic Substances"
     - "Unhealthy"
     - "Potentially Harmful"
     - **"Processed"** or **"Unprocessed"** (to indicate the product’s overall processing level)

4. **Suggest 2–3 healthier alternatives** from **Indian brands** that:
   - Offer a similar product type (e.g., chips, cookies, drinks)
   - Use only natural or minimally processed ingredients
   - Do not contain the identified harmful substances
   - Include a **buy link** that points to the official brand site, Amazon, or another major retailer (e.g. “https://www.amazon.in/…”)

Respond in the exact JSON format below (no markdown fences):

{
  "ingredients_analyzed": [
    {
      "name": "ingredient1",
      "type": "Artificial" | "Natural" | "Synthetic",
      "processing_level": "Processed" | "Unprocessed",
      "safety_level": "Above Safe Limit" | "Below Safe Limit" | "Limit Not Specified",
      "health_impact": "Brief summary of health effects"
    }
    // … more …
  ],
  "product_labels": [
    "Contains Artificial Substances",
    "Unhealthy",
    "Potentially Harmful",
    "Processed"
  ],
  "total_alerts": 3,
  "suggested_alternatives": [
    {
      "name": "Tata Soulfull Ragi Cookies",
      "brand": "Tata Soulfull",
      "category": "Cookies",
      "buy_link": "https://www.amazon.in/Tata-Soulfull-Organic-Ragi-Cookies/dp/B07XYZ1234"
    },
    {
      "name": "Too Yumm Jowar Chips",
      "brand": "Too Yumm",
      "category": "Snacks",
      "buy_link": "https://www.tooyumm.com/shop/jowar-chips"
    }
    // … more …
  ]
}
`;

    // call DeepSeek
    const chat = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "You are a health assistant..." },
        { role: "user", content: prompt },
      ],
    });
    let raw = chat.choices[0].message.content;
    // strip fences + parse
    raw = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const json = JSON.parse(raw.match(/\{[\s\S]*\}$/)![0]);

    // save to Mongo
    const loc = {
      latitude: parseFloat(req.body.latitude),
      longitude: parseFloat(req.body.longitude),
    };
    const doc = new AnalysisResult({
      uid: req.uid,
      phone: req.phone,
      imageUrl: `uploaded_images/${Date.now()}.jpg`,
      location: loc,
      ...json,
    });
    await doc.save();

    res.json(json);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 5000, () =>
  console.log("🚀 Server running")
);
