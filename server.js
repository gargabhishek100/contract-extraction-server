/**********************************************************************
  Gemini Contract Analyzer - Async Version
  - Immediately returns pending status
  - Processes in background and updates status
**********************************************************************/

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const pdf = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mongoose = require("mongoose");

const PORT = process.env.PORT || 5004;
const GEMINI_APIKey = process.env.GEMINI_API_KEY;
if (!GEMINI_APIKey) {
  console.error('❌  GEMINI_API_KEY missing in .env'); process.exit(1);
}
if (!process.env.MONGO_URL) {
  console.error('❌  MONGO_URL missing in .env'); process.exit(1);
}

/* ───────────────── App & Middleware ────────────────────────────── */
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

/////////////////////////////////// DB Connection ///////////////////////////////////
let mongoStatus = 'connecting';
mongoose.connect(process.env.MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true });

mongoose.connection.on('connected', async () => {
  mongoStatus = 'connected';
  const dbName = mongoose.connection.db.databaseName;
  console.log(`✅ MongoDB connection successful (using database: "${dbName}")`);
});
mongoose.connection.on('error', err => {
  mongoStatus = 'error';
  console.error('❌ MongoDB connection error:', err.message);
});
mongoose.connection.on('disconnected', () => {
  mongoStatus = 'disconnected';
  console.warn('⚠️  MongoDB connection lost');
});
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('MongoDB disconnected on app termination');
  process.exit(0);
});

const SubmittalSchema = new mongoose.Schema({
  item: { type: String, required: true },
  page: { type: Number, default: null },
  reason: { type: String, default: '' }
}, { _id: false });

const ContractSchema = new mongoose.Schema({
  pdfName: String,
  fields: mongoose.Schema.Types.Mixed,
  submittals: [SubmittalSchema],
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  errorMessage: String,
  createdAt: { type: Date, default: Date.now }
}, { collection: 'contracts' });

const Contract = mongoose.model("Contract", ContractSchema);

/* ───────────────── Gemini Init ─────────────────────────────────── */
const genAI = new GoogleGenerativeAI(GEMINI_APIKey);
const geminiInfo = { model: 'gemini-2.5-flash' };
let geminiModel;
(async () => {
  try {
    geminiModel = genAI.getGenerativeModel(geminiInfo);
    const t = await geminiModel.generateContent('Ping');
    console.log('✅ Gemini ready →', t.response.text().slice(0, 30), '…');
  } catch (e) {
    console.error('Gemini init failed:', e.message); process.exit(1);
  }
})();

/* ───────────────── Helpers & Prompts ───────────────────────────── */
const FIELD_LIST = [
  'ClientName', 'FundingAgency', 'BiddingSystem', 'NameOfWork', 'ProjectLocation', 
  'CompletionPeriod', 'EstimatedCost', 'TenderDocumentCost', 'EMD', 'ImportantDates', 
  'BidValidity', 'TenderSecurity', 'JointVenture', 'PowerOfAttorney', 
  'GroundsForBidRejection', 'EligibilityCriteria', 'SiteVisit', 
  'GeotechnicalReports', 'LandAvailability', 'OtherLandAvailability'
];

const preprocess = txt => txt.replace(/\s+/g, ' ').replace(/[\u00A0]/g, ' ').trim();

const buildPrompt = (name, txt) => `
You are an expert construction-contract analyst.
Task: extract the following fields. Return *strict* JSON. If a field is NOT explicitly present, output null.
interface ContractInfo{ ${FIELD_LIST.map(f => `${f}:string|null;`).join('')} }
Document «${name}»: <<<${txt}>>>`;

const submittalPrompt = (name, txt) => `
You are an expert bid-document reviewer.
GOAL: return an array called "submittals".  
Include every document / certificate / schedule / form that the bidder
must submit with the bid *and* every page that contains blanks
(______, ________) to be filled by the bidder.

Return STRICT JSON:
interface Submittal {
  item:  string;
  page:  number | null;
  reason?: string;
}
interface Response { submittals: Submittal[] }

RULES
• The array may be empty if the PDF does not specify submittals.
• If page number cannot be found, use null.
• Never invent items. Only what is explicitly in the document.
DOCUMENT «${name}»: <<<${txt}>>>`;

function extractJson(text) {
  let clean = text.replace(/``````/g, '').trim();
  try { return JSON.parse(clean); } catch { }
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first !== -1 && last !== -1) {
    return JSON.parse(clean.slice(first, last + 1));
  }
  throw new Error('Model response is not valid JSON');
}

/* ───────────────── Background Processing Function ───────────────── */
async function processContract(docId, pdfBuffer, pdfName) {
  try {
    // Update status to processing
    await Contract.findByIdAndUpdate(docId, { status: 'processing' });
    console.log(`🔄 Processing document ${docId}...`);

    const parsed = await pdf(pdfBuffer);
    const text = preprocess(parsed.text || '');
    
    if (!text) {
      await Contract.findByIdAndUpdate(docId, { 
        status: 'failed', 
        errorMessage: 'Empty or non-text PDF' 
      });
      return;
    }

    // Process submittals first
    const submittalsResponse = await geminiModel.generateContent(
      submittalPrompt(pdfName, text),
      { generationConfig: { temperature: 0.1, maxOutputTokens: 1024 } }
    );

    // Wait before second call
    await new Promise(res => setTimeout(res, 15000));

    // Process fields
    const fieldsResponse = await geminiModel.generateContent(
      buildPrompt(pdfName, text),
      { generationConfig: { temperature: 0.1, maxOutputTokens: 2048 } }
    );

    const fieldsData = extractJson(fieldsResponse.response.text());
    for (const k of FIELD_LIST) {
      if (!(k in fieldsData)) fieldsData[k] = null;
    }

    const submittalsData = extractJson(submittalsResponse.response.text());
    let submittals = submittalsData.submittals || [];
    submittals = submittals.map(x => ({
      item: x.item || '',
      page: x.page == null ? null : x.page,
      reason: x.reason || ''
    }));

    // Update with results and mark as completed
    await Contract.findByIdAndUpdate(docId, {
      fields: fieldsData,
      submittals: submittals,
      status: 'completed'
    });

    console.log(`✅ Document ${docId} processing completed!`);

  } catch (e) {
    console.error(`❌ Error processing document ${docId}:`, e);
    await Contract.findByIdAndUpdate(docId, {
      status: 'failed',
      errorMessage: e.message
    });
  }
}

/* ───────────────── API Endpoints ───────────────────────────────── */
app.get('/health', (req, res) => res.json({
  status: 'healthy', ai_provider: 'google-gemini', model: geminiInfo.model,
  db: mongoStatus, ts: new Date().toISOString()
}));

// Async upload endpoint - returns immediately
app.post('/api/summarize', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

    const pdfName = req.file.originalname;
    const pdfBuffer = req.file.buffer;

    // Create document with pending status
    const doc = await new Contract({
      pdfName: pdfName,
      status: 'pending'
    }).save();

    // Start background processing (don't await!)
    processContract(doc._id, pdfBuffer, pdfName);

    // Return immediately
    return res.json({
      success: true,
      _id: doc._id,
      pdfName: doc.pdfName,
      status: 'pending',
      message: 'Document uploaded successfully. Processing started.'
    });

  } catch (e) {
    console.error('❌', e);
    return res.status(500).json({ error: e.message });
  }
});

// Check status of a document
app.get('/api/status/:id', async (req, res) => {
  try {
    const doc = await Contract.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    
    res.json({
      success: true,
      _id: doc._id,
      pdfName: doc.pdfName,
      status: doc.status,
      errorMessage: doc.errorMessage || null,
      hasFields: !!doc.fields,
      hasSubmittals: doc.submittals && doc.submittals.length > 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetches history of all processed documents
app.get('/api/history', async (req, res) => {
  try {
    const docs = await Contract.find({}, { 
      pdfName: 1, createdAt: 1, status: 1 
    }).sort({ createdAt: -1 });
    res.json({
      success: true,
      files: docs.map(d => ({ 
        _id: d._id, 
        pdfName: d.pdfName, 
        createdAt: d.createdAt,
        status: d.status 
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetches the main summary fields for a specific document ID
app.get('/api/summarize/:id', async (req, res) => {
  try {
    const doc = await Contract.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json({ 
      success: true, 
      fields: doc.fields, 
      pdfName: doc.pdfName,
      status: doc.status 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetches ONLY the submittals for a specific document ID from the database
app.get('/api/submittals/:id', async (req, res) => {
  try {
    const doc = await Contract.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json({ 
      success: true, 
      submittals: doc.submittals || [], 
      pdfName: doc.pdfName,
      status: doc.status 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ───────────────── Server Start ────────────────────────────────── */
app.listen(PORT, () => console.log(
  `🚀 Gemini Analyzer on http://localhost:${PORT} (model ${geminiInfo.model})`
));
