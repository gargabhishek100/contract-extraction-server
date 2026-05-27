require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const pdf = require("pdf-parse");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

console.log("🔑 Loaded OpenAI key:", process.env.OPENAI_API_KEY ? "✅ Found" : "❌ Missing");

const upload = multer({ dest: "uploads/" });

// ✅ Proper OpenAI initialization
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Sanity check: verify API key actually works
(async () => {
  try {
    await openai.models.list();
    console.log("✅ OpenAI connection successful!");
  } catch (err) {
    console.error("❌ OpenAI connection failed:", err.message);
  }
})();

app.post("/api/summarize", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const dataBuffer = fs.readFileSync(req.file.path);
    const pdfData = await pdf(dataBuffer);
    const pdfText = pdfData.text;

    fs.unlinkSync(req.file.path);

    const textSnippet = pdfText.slice(0, 8000);
    const prompt = `
      Summarize the following PDF content in clear, concise bullet points:
      ---
      ${textSnippet}
    `;

    // 🧠 Use latest API call syntax (v4+)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful summarization assistant." },
        { role: "user", content: prompt },
      ],
    });

    const summary = completion.choices[0].message.content.trim();
    res.json({ summary });
  } catch (err) {
    console.error("❌ Summarization error:", err);
    if (err.code === "insufficient_quota" || err.status === 429) {
      res.status(429).json({ error: "Your OpenAI API key is invalid or out of quota." });
    } else {
      res.status(500).json({ error: "Summarization failed." });
    }
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
