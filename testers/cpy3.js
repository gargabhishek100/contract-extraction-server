// quota-friendly-summarizer.js - Version optimized for limited OpenAI quotas

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs").promises;
const pdf = require("pdf-parse");
const OpenAI = require("openai");
const rateLimit = require("express-rate-limit");

const app = express();

// Basic middleware setup
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting - more restrictive for quota conservation
const rateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Only 5 requests per hour to conserve quota
  message: {
    error: 'Quota conservation: Only 5 requests per hour allowed.',
    retryAfter: '1 hour'
  }
});

app.use('/api/', rateLimiter);

// File upload configuration
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024, // Reduced to 10MB to limit processing
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files allowed'), false);
    }
  }
});

// OpenAI setup with conservative settings
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30000,
  maxRetries: 1 // Reduced retries to save quota
});

// Check connection but be quota-aware
(async () => {
  try {
    console.log("🔑 OpenAI API Key:", process.env.OPENAI_API_KEY ? "✅ Found" : "❌ Missing");

    // Skip expensive model listing call to save quota
    console.log("⚡ Quota-friendly mode: Skipping model detection to save credits");
    console.log("🤖 Will use: gpt-3.5-turbo (most cost-effective)");

  } catch (err) {
    console.error("❌ Setup error:", err.message);
  }
})();

// QUOTA-FRIENDLY text processing - Single chunk approach
function createSingleChunk(text, maxSize = 12000) {
  if (text.length <= maxSize) {
    return text;
  }

  // Take first part and last part to capture key sections
  const firstPart = text.slice(0, maxSize * 0.6);
  const lastPart = text.slice(-maxSize * 0.3);

  return firstPart + "\n\n[MIDDLE SECTION TRUNCATED FOR QUOTA EFFICIENCY]\n\n" + lastPart;
}

// Single API call summarization to minimize quota usage
async function generateQuotaFriendlySummary(text, originalFileName) {
  try {
    console.log("💰 Using quota-friendly single-call approach");

    // Use most cost-effective model
    const model = 'gpt-3.5-turbo';

    const systemPrompt = `You are analyzing a contract document. Create a comprehensive summary covering:

1. **Document Type & Parties**: Who are the main parties and what type of contract is this?
2. **Key Terms**: What are the main obligations, deliverables, and requirements?
3. **Financial Terms**: Payment amounts, schedules, penalties, or costs mentioned
4. **Timeline**: Important dates, deadlines, duration, or milestones
5. **Notable Clauses**: Any unusual, risky, or important legal provisions
6. **Missing Information**: What key details are unclear or not specified?

IMPORTANT: Only use information explicitly stated in the contract. If something is unclear, say "Not clearly specified" rather than guessing.

Be thorough but concise. Use bullet points for clarity.`;

    const userPrompt = `Analyze this contract document: "${originalFileName}"

CONTRACT TEXT:
---
${text}
---

Provide a structured summary following the 6 categories above.`;

    const completion = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.1,
      max_tokens: 1500, // Reasonable limit to control costs
    });

    return {
      summary: completion.choices[0].message.content.trim(),
      model: model,
      processingMethod: 'single_call_quota_friendly',
      tokensUsed: completion.usage?.total_tokens || 'unknown'
    };

  } catch (error) {
    console.error('❌ Summary generation failed:', error.message);
    throw error;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    mode: 'quota-friendly',
    timestamp: new Date().toISOString()
  });
});

// Quota-friendly summarization endpoint
app.post("/api/summarize", upload.single("pdf"), async (req, res) => {
  let filePath;

  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: "No PDF file uploaded", 
        code: "NO_FILE" 
      });
    }

    filePath = req.file.path;
    console.log(`📄 Processing: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)}MB)`);

    // Extract PDF text
    const dataBuffer = await fs.readFile(filePath);
    const pdfData = await pdf(dataBuffer);

    if (!pdfData.text || pdfData.text.trim().length === 0) {
      await fs.unlink(filePath).catch(console.error);
      return res.status(400).json({ 
        error: "PDF contains no extractable text", 
        code: "EMPTY_PDF" 
      });
    }

    // Create single chunk to minimize API calls
    const processedText = createSingleChunk(pdfData.text.trim());

    console.log(`📊 Text stats: ${pdfData.text.length} chars → ${processedText.length} chars (optimized)`);
    console.log(`💰 Using single API call to minimize quota usage`);

    // Generate summary with single API call
    const summaryResult = await generateQuotaFriendlySummary(processedText, req.file.originalname);

    // Clean up file
    await fs.unlink(filePath).catch(console.error);

    // Return response
    res.json({
      success: true,
      summary: summaryResult.summary,
      metadata: {
        originalFileName: req.file.originalname,
        fileSize: req.file.size,
        originalWordCount: pdfData.text.split(' ').length,
        processedWordCount: processedText.length,
        processingMethod: summaryResult.processingMethod,
        model: summaryResult.model,
        tokensUsed: summaryResult.tokensUsed,
        quotaOptimized: true,
        processedAt: new Date().toISOString()
      },
      note: "This is a quota-friendly version. For full document analysis, please add credits to your OpenAI account and use the full version."
    });

  } catch (err) {
    console.error("❌ Error:", err);

    if (filePath) {
      await fs.unlink(filePath).catch(console.error);
    }

    // Handle quota-specific errors
    if (err.status === 429 || err.code === 'insufficient_quota') {
      return res.status(429).json({ 
        error: "OpenAI quota exceeded. Please add credits to your OpenAI account at platform.openai.com/account/billing", 
        code: "QUOTA_EXCEEDED",
        solution: "Add $5-10 to your OpenAI account to continue processing documents",
        billingUrl: "https://platform.openai.com/account/billing"
      });
    }

    if (err.status === 401) {
      return res.status(500).json({ 
        error: "Invalid OpenAI API key", 
        code: "AUTH_ERROR" 
      });
    }

    res.status(500).json({ 
      error: "Processing failed", 
      code: "PROCESSING_ERROR",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Error handlers
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ 
        error: "File too large. Maximum size is 10MB in quota-friendly mode.", 
        code: "FILE_TOO_LARGE" 
      });
    }
  }

  res.status(500).json({ 
    error: "Server error", 
    code: "SERVER_ERROR" 
  });
});

app.use((req, res) => {
  res.status(404).json({ 
    error: "Endpoint not found", 
    code: "NOT_FOUND" 
  });
});

const PORT = process.env.PORT || 5001; // Different port to avoid conflicts

app.listen(PORT, () => {
  console.log(`\n🚀 Quota-Friendly Contract Summarizer Started`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`💰 Mode: Quota-conserving (single API call per document)`);
  console.log(`⚡ Ready to process up to 10MB PDFs efficiently!`);
  console.log(`\n💡 To unlock full features, add credits at: https://platform.openai.com/account/billing\n`);
});