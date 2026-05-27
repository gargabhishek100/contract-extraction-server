require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs").promises;
const pdf = require("pdf-parse");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// File upload configuration
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  }
});

// Initialize Gemini AI
if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY not found in .env file');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
let geminiModel = null;

// Initialize Gemini model and test connection
(async () => {
  try {
    console.log("🔑 Gemini API Key:", process.env.GEMINI_API_KEY ? "✅ Found" : "❌ Missing");
    console.log("🧪 Testing Gemini connection...");

    // Use Gemini Pro model (free tier available)
    geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    // Test with a simple prompt
    const testResult = await geminiModel.generateContent("Hello");
    const testText = testResult.response.text();

    console.log("✅ Gemini connection successful!");
    console.log("🤖 Model: gemini-pro");
    console.log("📝 Test response:", testText.substring(0, 50) + "...");

  } catch (error) {
    console.error("❌ Gemini connection failed:", error.message);
    if (error.message.includes('API_KEY_INVALID')) {
      console.log("💡 Check your GEMINI_API_KEY in .env file");
      console.log("🔗 Get key at: https://makersuite.google.com/app/apikey");
    }
  }
})();

// Smart text chunking for large documents
function smartChunkText(text, maxChunkSize = 8000, overlapSize = 300) {
  if (text.length <= maxChunkSize) {
    return [text];
  }

  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    const cleanSentence = sentence.trim();

    if (currentChunk.length + cleanSentence.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());

      // Add overlap for context preservation
      const words = currentChunk.trim().split(' ');
      const overlapWords = words.slice(-Math.floor(overlapSize / 6));
      currentChunk = overlapWords.join(' ') + ' ' + cleanSentence;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + cleanSentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

// Clean and preprocess text
function preprocessText(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\u00A0]/g, ' ')
    .trim();
}

// Generate contract summary using Gemini
async function generateContractSummary(textChunks, fileName) {
  try {
    if (!geminiModel) {
      throw new Error("Gemini model not initialized");
    }

    console.log(`📋 Processing ${textChunks.length} chunks with Gemini AI...`);

    if (textChunks.length === 1) {
      // Single chunk processing
      return await processSingleChunk(textChunks[0], fileName);
    } else {
      // Multi-chunk processing
      return await processMultipleChunks(textChunks, fileName);
    }

  } catch (error) {
    console.error('❌ Gemini generation error:', error);
    throw new Error(`Contract analysis failed: ${error.message}`);
  }
}

async function processSingleChunk(text, fileName) {
  const systemPrompt = `You are an expert legal document analyst specializing in contract analysis. Analyze the contract document and provide a comprehensive, structured summary.

CRITICAL INSTRUCTIONS:
- Base your analysis ONLY on information explicitly stated in the contract
- If information is unclear or missing, explicitly state "Information not clearly specified"
- Never make assumptions or add information not present in the document
- Use direct quotes from the contract when referencing specific clauses
- Be thorough but concise

Provide your analysis in exactly this structure:

## DOCUMENT OVERVIEW & PARTIES
- Document type and main parties involved
- Contract purpose and scope

## KEY TERMS & OBLIGATIONS  
- Primary obligations of each party
- Main deliverables and requirements
- Performance standards

## FINANCIAL PROVISIONS
- Payment terms, amounts, and schedules
- Cost structures and financial obligations
- Penalties or additional fees

## TIMELINE & DEADLINES
- Project duration and milestones
- Important dates and deadlines
- Renewal or extension terms

## RISK FACTORS & NOTABLE CLAUSES
- Unusual or high-risk provisions
- Termination conditions
- Liability and penalty clauses
- Compliance requirements

## MISSING OR UNCLEAR INFORMATION
- Information that needs clarification
- Missing standard contract elements
- Areas requiring legal review`;

  const userPrompt = `Please analyze this contract document: "${fileName}"

CONTRACT CONTENT:
---
${text}
---

Provide a detailed analysis following the exact structure specified above. Remember to only include information explicitly stated in the contract.`;

  try {
    const result = await geminiModel.generateContent(userPrompt + "\n\n" + systemPrompt);
    const responseText = result.response.text();

    return {
      summary: responseText,
      model: "gemini-pro",
      processingMethod: "single_chunk",
      chunks: 1
    };

  } catch (error) {
    console.error('❌ Single chunk processing failed:', error);
    throw error;
  }
}

async function processMultipleChunks(textChunks, fileName) {
  const chunkSummaries = [];

  // Process each chunk with delay to respect rate limits
  for (let i = 0; i < textChunks.length; i++) {
    console.log(`📄 Processing chunk ${i + 1}/${textChunks.length}...`);

    const chunkPrompt = `Analyze this section of a contract document and extract key information:

SECTION ${i + 1} of ${textChunks.length}:
---
${textChunks[i]}
---

Extract and summarize:
- Any parties, roles, or entities mentioned
- Specific terms, conditions, and obligations
- Financial information (amounts, payment terms)
- Important dates, deadlines, or timeframes  
- Notable clauses, risks, or unusual provisions

IMPORTANT: Only report what is explicitly stated. If this section seems incomplete, note that it's "a partial section of a larger document."`;

    try {
      const result = await geminiModel.generateContent(chunkPrompt);
      const chunkSummary = result.response.text();

      chunkSummaries.push({
        chunkIndex: i + 1,
        summary: chunkSummary
      });

      // Rate limiting delay
      if (i < textChunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

    } catch (error) {
      console.error(`❌ Error processing chunk ${i + 1}:`, error.message);
      chunkSummaries.push({
        chunkIndex: i + 1,
        summary: `Error processing section ${i + 1}: ${error.message}`
      });
    }
  }

  // Consolidate all chunk summaries
  console.log("🔄 Consolidating analysis from all sections...");

  const consolidationPrompt = `Create a comprehensive contract summary by consolidating information from these document sections:

${chunkSummaries.map(chunk => `SECTION ${chunk.chunkIndex}:\n${chunk.summary}\n`).join('\n')}

Create a final comprehensive summary with these sections:

## DOCUMENT OVERVIEW & PARTIES
## KEY TERMS & OBLIGATIONS
## FINANCIAL PROVISIONS  
## TIMELINE & DEADLINES
## RISK FACTORS & NOTABLE CLAUSES
## MISSING OR UNCLEAR INFORMATION

CRITICAL: Only include information explicitly mentioned in the section summaries above. If sections contain contradictory information, note the discrepancy. If information appears incomplete, clearly state what's missing.`;

  try {
    const finalResult = await geminiModel.generateContent(consolidationPrompt);
    const finalSummary = finalResult.response.text();

    return {
      summary: finalSummary,
      model: "gemini-pro", 
      processingMethod: "multi_chunk",
      chunks: textChunks.length
    };

  } catch (error) {
    console.error('❌ Final consolidation failed:', error);
    throw error;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    ai_provider: 'google-gemini',
    model: 'gemini-pro',
    timestamp: new Date().toISOString()
  });
});

// Test Gemini connection endpoint
app.get('/test-gemini', async (req, res) => {
  try {
    if (!geminiModel) {
      return res.status(500).json({
        error: "Gemini model not initialized",
        solution: "Check your GEMINI_API_KEY in .env file"
      });
    }

    const testResult = await geminiModel.generateContent("Test connection - respond with 'Connected successfully'");
    const response = testResult.response.text();

    res.json({
      status: "✅ Gemini API working",
      model: "gemini-pro",
      testResponse: response,
      message: "Ready to analyze contracts!"
    });

  } catch (error) {
    res.status(500).json({
      error: "Gemini API test failed",
      details: error.message,
      solution: error.message.includes('API_KEY_INVALID') ? 
        "Get a valid API key from https://makersuite.google.com/app/apikey" : 
        "Check your internet connection and API key"
    });
  }
});

// Main contract analysis endpoint
app.post("/api/summarize", upload.single("pdf"), async (req, res) => {
  let filePath;

  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No PDF file uploaded",
        code: "NO_FILE"
      });
    }

    if (!geminiModel) {
      return res.status(500).json({
        error: "Gemini AI not available",
        code: "AI_NOT_READY",
        solution: "Check GEMINI_API_KEY in .env file"
      });
    }

    filePath = req.file.path;
    console.log(`\n📄 Processing: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)}MB)`);

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

    // Process and chunk text
    const cleanedText = preprocessText(pdfData.text);
    const textChunks = smartChunkText(cleanedText);

    console.log(`📊 Document stats: ${cleanedText.length} characters, ${textChunks.length} chunks`);

    // Generate AI analysis
    const summaryResult = await generateContractSummary(textChunks, req.file.originalname);

    // Clean up file
    await fs.unlink(filePath).catch(console.error);

    // Return successful response
    res.json({
      success: true,
      summary: summaryResult.summary,
      metadata: {
        originalFileName: req.file.originalname,
        fileSize: req.file.size,
        wordCount: cleanedText.split(' ').length,
        chunksProcessed: summaryResult.chunks,
        processingMethod: summaryResult.processingMethod,
        model: summaryResult.model,
        aiProvider: 'google-gemini',
        processedAt: new Date().toISOString()
      }
    });

    console.log(`✅ Contract analysis completed successfully!`);

  } catch (err) {
    console.error("❌ Contract analysis error:", err);

    if (filePath) {
      await fs.unlink(filePath).catch(console.error);
    }

    // Handle specific Gemini errors
    if (err.message.includes('QUOTA_EXCEEDED') || err.message.includes('quota')) {
      return res.status(429).json({
        error: "Gemini API quota exceeded. Please try again later.",
        code: "QUOTA_EXCEEDED",
        retryAfter: "1 hour"
      });
    }

    if (err.message.includes('API_KEY_INVALID')) {
      return res.status(401).json({
        error: "Invalid Gemini API key",
        code: "INVALID_API_KEY", 
        solution: "Get a new API key from https://makersuite.google.com/app/apikey"
      });
    }

    if (err.message.includes('SAFETY')) {
      return res.status(400).json({
        error: "Content flagged by Gemini safety filters",
        code: "CONTENT_SAFETY",
        solution: "Document may contain content that triggered safety filters"
      });
    }

    // Generic error
    res.status(500).json({
      error: "Contract analysis failed",
      code: "ANALYSIS_FAILED", 
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: "File too large. Maximum size is 25MB.",
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

const PORT = process.env.PORT || 5004;

app.listen(PORT, () => {
  console.log(`\n🚀 Gemini Contract Analyzer Started`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🤖 AI Provider: Google Gemini Pro`);
  console.log(`💰 Free Tier: Generous quotas for students`);
  console.log(`⚡ Ready to analyze contract documents!`);
  console.log(`\n📝 Endpoints:`);
  console.log(`   Health: GET  http://localhost:${PORT}/health`);
  console.log(`   Test AI: GET  http://localhost:${PORT}/test-gemini`);
  console.log(`   Analyze: POST http://localhost:${PORT}/api/summarize`);
  console.log(`\n`);
});