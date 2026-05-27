/**********************************************************************
  Gemini Contract Analyzer
  - Fast in-memory upload (no disk I/O)
  - Extracts 19 exact fields in strict JSON
  - Zero hallucination policy (null when absent)
**********************************************************************/

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const pdf = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const PORT = process.env.PORT || 5004;
const GEMINI_APIKey = process.env.GEMINI_API_KEY;
if (!GEMINI_APIKey) {
  console.error('❌  GEMINI_API_KEY missing in .env'); process.exit(1);
}

/* ───────────────── App & Middleware ────────────────────────────── */
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* keep file in RAM for speed */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (req, f, cb) =>
    f.mimetype === 'application/pdf'
      ? cb(null, true)
      : cb(new Error('Only PDF files are allowed'), false)
});

/* ───────────────── Gemini Init ─────────────────────────────────── */
const genAI = new GoogleGenerativeAI(GEMINI_APIKey);
const geminiInfo = { model: 'gemini-2.5-flash' };          // fastest
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

/* ───────────────── Helpers ─────────────────────────────────────── */
const FIELD_LIST = [
  'ClientName', 'FundingAgency', 'BiddingSystem', 'NameOfWork',
  'ProjectLocation', 'CompletionPeriod', 'EstimatedCost',
  'TenderDocumentCost', 'EMD', 'ImportantDates', 'BidValidity',
  'TenderSecurity', 'JointVenture', 'PowerOfAttorney',
  'GroundsForBidRejection', 'EligibilityCriteria', 'SiteVisit',
  'GeotechnicalReports', 'LandAvailability', 'OtherLandAvailability'
];

const preprocess = txt => txt
  .replace(/\s+/g, ' ')
  .replace(/[\u00A0]/g, ' ')
  .trim();

const smartChunks = (txt, max = 8000, ov = 300) => {
  if (txt.length <= max) return [txt];
  const s = txt.match(/[^.!?]+[.!?]+/g) || [txt];
  const out = []; let cur = '';
  for (const sent of s) {
    if (cur.length + sent.length > max && cur) {
      out.push(cur.trim());
      const w = cur.split(' ');
      cur = w.slice(-Math.floor(ov / 6)).join(' ') + ' ' + sent;
    } else cur += (cur ? ' ' : '') + sent.trim();
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};

const buildPrompt = (name, txt) => `
You are an expert construction-contract analyst.
Task: extract the following 19 fields.  Return *strict* JSON exactly
matching this interface; if a field is NOT explicitly present, output null.

interface ContractInfo{
${FIELD_LIST.map(f => `  ${f}: string | null;`).join('\n')}
}

Never invent data.  Keep original wording for numbers and dates.

Document «${name}»:
<<<
${txt}
>>>`;

/* ───────────────── Endpoints ───────────────────────────────────── */
app.get('/health', (req, res) => res.json({
  status: 'healthy', ai_provider: 'google-gemini', model: geminiInfo.model,
  ts: new Date().toISOString()
}));

function extractJson(text) {
  // 1. remove markdown fences such as ``````
  let clean = text.replace(/``````/g, m =>
    m.replace(/``````$/, '')
  ).trim();

  // 2. quick attempt
  try { return JSON.parse(clean); } catch { }

  // 3. fallback: take content between first '{' and last '}'
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first !== -1 && last !== -1) {
    const candidate = clean.slice(first, last + 1);
    return JSON.parse(candidate);        // may still throw
  }
  throw new Error('Model response is not valid JSON');
}

app.post('/api/summarize', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
    const parsed = await pdf(req.file.buffer);
    const text = preprocess(parsed.text || '');
    if (!text) return res.status(400).json({ error: 'Empty / non-text PDF' });

    /* one Gemini call (flash can take big context) */
    const prompt = buildPrompt(req.file.originalname, text);
    const gRes = await geminiModel.generateContent(prompt, {
      generationConfig: { temperature: 0.1 },
      safetySettings: [{ category: 'HARM_CATEGORY_DANGEROUS', threshold: 'BLOCK_NONE' }]
    });

    /* strip possible markdown fencing */
    // const raw = gRes.response.text()
    //   .replace(/^``````$/,'').trim();
    // const data = JSON.parse(raw);          // throws if model malformed

    const rawText = gRes.response.text();
    const data = extractJson(rawText);    // <= replace old parsing lines
    for (const k of FIELD_LIST) if (!(k in data)) data[k] = null;

    /* sanity: ensure all keys exist */
    for (const k of FIELD_LIST) if (!(k in data)) data[k] = null;

    return res.json({
      success: true,
      fields: data,
      meta: { words: text.split(' ').length, model: geminiInfo.model }
    });

  } catch (e) {
    console.error('❌', e);
    const code = /quota/i.test(e.message) ? 429 : 500;
    return res.status(code).json({ error: e.message });
  }
});



/* ───────── submittal-extraction helper ───────── */
const submittalPrompt = (name, txt) => `
You are an expert bid-document reviewer.

GOAL: return an array called "submittals".  
Include every document / certificate / schedule / form that the bidder
must submit with the bid *and* every page that contains blanks
(______, ________) to be filled by the bidder.

Return STRICT JSON:

interface Submittal {
  item:  string;   // e.g. "Bid Security", "Form of Tender"
  page:  number | null; // page where requirement appears; null if unknown
  reason?: string; // optional short note
}
interface Response { submittals: Submittal[] }

RULES
• The array may be empty if the PDF does not specify submittals.
• If page number cannot be found, use null.
• Never invent items. Only what is explicitly in the document.

DOCUMENT «${name}»:
<<<
${txt}
>>>`;

/* ───────── NEW END-POINT ───────── */
app.post('/api/submittals', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

    const parsed = await pdf(req.file.buffer);
    const clean  = preprocess(parsed.text || '');
    if (!clean)  return res.status(400).json({ error: 'No text in PDF' });

    const gRes = await geminiModel.generateContent(
      submittalPrompt(req.file.originalname, clean),
      { generationConfig:{temperature:0.1} }
    );

    const data = extractJson(gRes.response.text());   // use safe helper

    return res.json({ success:true, ...data });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error:e.message });
  }
});



/* ───────────────── Start ───────────────────────────────────────── */
app.listen(PORT, () => console.log(
  `🚀 Gemini Analyzer on http://localhost:${PORT}  (model ${geminiInfo.model})`
));
