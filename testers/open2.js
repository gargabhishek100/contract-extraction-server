require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
const pdf = require("pdf-parse");
const OpenAI = require("openai");
const rateLimit = require("express-rate-limit");

const app = express();

// ============================================================================
// MIDDLEWARE CONFIGURATION
// ============================================================================

// CORS configuration
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting configuration - prevents API abuse
const rateLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: process.env.NODE_ENV === 'production' ? 50 : 100, // limit each IP to 50/100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again after 24 hours.',
    retryAfter: '24 hours'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: (req) => {
    // Skip rate limiting for health check endpoints
    return req.path === '/health';
  }
});

app.use('/api/', rateLimiter);

// ============================================================================
// FILE UPLOAD CONFIGURATION
// ============================================================================

// Enhanced multer configuration with better security and validation
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = 'uploads/';
    try {
      await fs.access(uploadDir);
    } catch {
      await fs.mkdir(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename with timestamp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `contract-${uniqueSuffix}.pdf`);
  }
});

// Enhanced file filter for better security
const fileFilter = (req, file, cb) => {
  // Check file extension and MIME type
  const allowedExtensions = ['.pdf'];
  const allowedMimeTypes = ['application/pdf'];

  const fileExtension = path.extname(file.originalname).toLowerCase();
  const mimeType = file.mimetype;

  if (allowedExtensions.includes(fileExtension) && allowedMimeTypes.includes(mimeType)) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed. Please upload a valid contract document.'), false);
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB limit for large contract documents
    files: 1
  },
  fileFilter: fileFilter
});

// ============================================================================
// OPENAI CONFIGURATION WITH ERROR HANDLING
// ============================================================================

// Validate OpenAI API key on startup
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

console.log("🔑 OpenAI API Key:", process.env.OPENAI_API_KEY ? "✅ Found" : "❌ Missing");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 60000, // 60 seconds timeout
  maxRetries: 3, // Retry failed requests up to 3 times
});

// Validate OpenAI connection on startup
(async () => {
  try {
    console.log("🧪 Testing OpenAI connection...");
    const models = await openai.models.list();
    console.log("✅ OpenAI connection successful!");

    // Check if GPT-4 models are available
    const availableModels = models.data.map(model => model.id);
    const preferredModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4'];
    const modelToUse = preferredModels.find(model => availableModels.includes(model)) || 'gpt-3.5-turbo';

    console.log(`🤖 Using model: ${modelToUse}`);
    process.env.SELECTED_MODEL = modelToUse;

  } catch (err) {
    console.error("❌ OpenAI connection failed:", err.message);
    if (err.status === 401) {
      console.error("💡 Please check your OPENAI_API_KEY in the .env file");
    }
    // Don't exit in development mode to allow testing other endpoints
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
})();

// ============================================================================
// TEXT PROCESSING UTILITIES
// ============================================================================

/**
 * Smart text chunking for large documents
 * Implements semantic chunking with overlap to preserve context
 */
function smartChunkText(text, maxChunkSize = 6000, overlapSize = 200) {
  const sentences = text.match(/[^\.!?]+[\.!?]+/g) || [text];
  const chunks = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    const cleanSentence = sentence.trim();

    // If adding this sentence would exceed the chunk size, start a new chunk
    if (currentChunk.length + cleanSentence.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());

      // Add overlap from the end of the current chunk to maintain context
      const words = currentChunk.trim().split(' ');
      const overlapWords = words.slice(-Math.floor(overlapSize / 6)); // Approximate 6 chars per word
      currentChunk = overlapWords.join(' ') + ' ' + cleanSentence;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + cleanSentence;
    }
  }

  // Add the last chunk if it has content
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Clean and preprocess extracted PDF text
 */
function preprocessText(text) {
  return text
    .replace(/\n\s+/g, ' ') // Remove excessive whitespace and newlines
    .replace(/[\r\n]+/g, ' ') // Normalize line breaks
    .replace(/\s{2,}/g, ' ') // Collapse multiple spaces
    .replace(/[\u00A0]/g, ' ') // Replace non-breaking spaces
    .trim();
}

// ============================================================================
// AI SUMMARIZATION WITH ANTI-HALLUCINATION MEASURES
// ============================================================================

/**
 * Generate contract summary with enhanced prompting to prevent hallucinations
 */
async function generateContractSummary(textChunks, originalFileName = 'contract') {
  try {
    const model = process.env.SELECTED_MODEL || 'gpt-3.5-turbo';

    // If document is small enough, process as single chunk
    if (textChunks.length === 1 && textChunks[0].length <= 6000) {
      return await processSingleChunk(textChunks[0], originalFileName, model);
    } else {
      // For large documents, process in chunks and then create consolidated summary
      return await processMultipleChunks(textChunks, originalFileName, model);
    }

  } catch (error) {
    console.error('❌ Error in generateContractSummary:', error);
    throw new Error(`Failed to generate summary: ${error.message}`);
  }
}

async function processSingleChunk(text, fileName, model) {
  const systemPrompt = `You are an expert legal document analyzer specializing in contract summarization. Your task is to create accurate, comprehensive summaries of contract documents while strictly adhering to anti-hallucination principles.

CRITICAL INSTRUCTIONS:
1. Base your summary ONLY on the information explicitly provided in the contract text
2. If any section is unclear or information is missing, state "Information not clearly specified" or "Details not provided"
3. Never make assumptions or add information not present in the document
4. Use direct quotes from the contract when citing specific clauses
5. Clearly distinguish between what is stated vs. what is implied

SUMMARY STRUCTURE - Provide exactly these sections:
- Document Type & Parties
- Key Terms & Obligations
- Financial Provisions
- Duration & Termination
- Risk Factors & Important Clauses
- Missing or Unclear Information

Be thorough but concise. Use bullet points for clarity.`;

  const userPrompt = `Please analyze this contract document and provide a comprehensive summary following the specified structure:

DOCUMENT NAME: ${fileName}
CONTRACT TEXT:
---
${text}
---

Remember: Only include information that is explicitly stated in the contract. If something is unclear, mention that explicitly.`;

  const completion = await openai.chat.completions.create({
    model: model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.1, // Low temperature for consistency and accuracy
    max_tokens: 2000,
    presence_penalty: 0,
    frequency_penalty: 0.1
  });

  return {
    summary: completion.choices[0].message.content.trim(),
    wordCount: text.split(' ').length,
    processingMethod: 'single_chunk',
    model: model
  };
}

async function processMultipleChunks(textChunks, fileName, model) {
  const chunkSummaries = [];

  // Process each chunk
  for (let i = 0; i < textChunks.length; i++) {
    console.log(`📋 Processing chunk ${i + 1}/${textChunks.length}`);

    const chunkSystemPrompt = `You are analyzing a section of a contract document. Extract and summarize only the key information from this specific section. Focus on:
- Parties and roles mentioned
- Specific obligations, terms, and conditions  
- Financial information (amounts, payment terms, etc.)
- Important dates and deadlines
- Risk factors or penalties
- Any unusual or notable clauses

IMPORTANT: Only report what is explicitly stated. If information seems incomplete, note that this is "a partial section."`;

    const chunkUserPrompt = `Analyze this section from a contract document (Part ${i + 1} of ${textChunks.length}):

${textChunks[i]}

Provide a concise summary of the key information in this section.`;

    try {
      const chunkCompletion = await openai.chat.completions.create({
        model: model,
        messages: [
          { role: "system", content: chunkSystemPrompt },
          { role: "user", content: chunkUserPrompt }
        ],
        temperature: 0.1,
        max_tokens: 500
      });

      chunkSummaries.push({
        chunkIndex: i + 1,
        summary: chunkCompletion.choices[0].message.content.trim()
      });

      // Add delay to respect rate limits
      if (i < textChunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

    } catch (error) {
      console.error(`❌ Error processing chunk ${i + 1}:`, error.message);
      chunkSummaries.push({
        chunkIndex: i + 1,
        summary: `Error processing this section: ${error.message}`
      });
    }
  }

  // Consolidate chunk summaries into final summary
  const consolidationPrompt = `You are creating a final comprehensive contract summary by consolidating information from multiple sections. 

SECTION SUMMARIES:
${chunkSummaries.map(chunk => `Section ${chunk.chunkIndex}: ${chunk.summary}`).join('\n\n')}

Create a comprehensive contract summary with these sections:
- Document Overview & Parties
- Key Terms & Obligations  
- Financial Provisions
- Timeline & Termination Conditions
- Risk Factors & Notable Clauses
- Areas Needing Clarification

CRITICAL: Only include information explicitly mentioned in the section summaries. If sections seem contradictory, note the discrepancy. If information is incomplete, clearly state what's missing.`;

  const finalCompletion = await openai.chat.completions.create({
    model: model,
    messages: [
      { role: "system", content: "You are a legal expert consolidating contract analysis from multiple document sections. Focus on accuracy and completeness while avoiding hallucinations." },
      { role: "user", content: consolidationPrompt }
    ],
    temperature: 0.1,
    max_tokens: 2000
  });

  return {
    summary: finalCompletion.choices[0].message.content.trim(),
    wordCount: textChunks.join(' ').split(' ').length,
    processingMethod: 'multi_chunk',
    chunksProcessed: textChunks.length,
    model: model
  };
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// Main PDF summarization endpoint
app.post("/api/summarize", upload.single("pdf"), async (req, res) => {
  let filePath;

  try {
    // Validate file upload
    if (!req.file) {
      return res.status(400).json({ 
        error: "No PDF file uploaded", 
        code: "NO_FILE" 
      });
    }

    filePath = req.file.path;
    console.log(`📄 Processing file: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)}MB)`);

    // Extract text from PDF
    const dataBuffer = await fs.readFile(filePath);
    const pdfData = await pdf(dataBuffer);

    if (!pdfData.text || pdfData.text.trim().length === 0) {
      await fs.unlink(filePath).catch(console.error);
      return res.status(400).json({ 
        error: "PDF appears to be empty or contains no extractable text", 
        code: "EMPTY_PDF" 
      });
    }

    // Preprocess and chunk the text
    const cleanedText = preprocessText(pdfData.text);
    const textChunks = smartChunkText(cleanedText);

    console.log(`📊 Document stats: ${cleanedText.length} characters, ${textChunks.length} chunks`);

    // Generate AI summary
    const summaryResult = await generateContractSummary(textChunks, req.file.originalname);

    // Clean up uploaded file
    await fs.unlink(filePath).catch(console.error);

    // Return successful response
    res.json({
      success: true,
      summary: summaryResult.summary,
      metadata: {
        originalFileName: req.file.originalname,
        fileSize: req.file.size,
        wordCount: summaryResult.wordCount,
        chunksProcessed: summaryResult.chunksProcessed || 1,
        processingMethod: summaryResult.processingMethod,
        model: summaryResult.model,
        processedAt: new Date().toISOString()
      }
    });

  } catch (err) {
    console.error("❌ Summarization error:", err);

    // Clean up file if it exists
    if (filePath) {
      await fs.unlink(filePath).catch(console.error);
    }

    // Handle specific OpenAI errors
    if (err.status === 401) {
      return res.status(500).json({ 
        error: "OpenAI authentication failed. Please check API key configuration.", 
        code: "AUTH_ERROR" 
      });
    }

    if (err.status === 429) {
      return res.status(429).json({ 
        error: "OpenAI rate limit exceeded. Please try again in a few minutes.", 
        code: "RATE_LIMIT",
        retryAfter: "5 minutes"
      });
    }

    if (err.status === 413 || err.message.includes('token')) {
      return res.status(413).json({ 
        error: "Document too large to process. Please try a smaller contract.", 
        code: "DOCUMENT_TOO_LARGE" 
      });
    }

    // Generic error response
    res.status(500).json({ 
      error: "Failed to process document. Please try again or contact support.", 
      code: "PROCESSING_ERROR",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ 
        error: "File too large. Maximum size is 25MB.", 
        code: "FILE_TOO_LARGE" 
      });
    }
    return res.status(400).json({ 
      error: error.message, 
      code: "UPLOAD_ERROR" 
    });
  }

  res.status(500).json({ 
    error: "An unexpected error occurred", 
    code: "SERVER_ERROR" 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: "Endpoint not found", 
    code: "NOT_FOUND" 
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Contract Summarization Server Started`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🤖 AI Model: ${process.env.SELECTED_MODEL || 'detecting...'}`);
  console.log(`⚡ Ready to process contract documents!\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});