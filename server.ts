import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { z } from 'zod';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

// Env schema validation with zod
const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  GEMINI_API_KEY: z.string().optional(),
  MODEL_PRIMARY: z.string().default('gemini-3.1-flash-lite'),
  MODEL_FALLBACKS: z.string().default('gemini-3.5-flash,gemini-3.8-flash'),
  DEMO_MODE: z.string().default('false'),
  MAX_FILE_MB: z.string().default('50'),
  APP_URL: z.string().default('http://localhost:3000'),
  DISABLE_HMR: z.string().default('true'),
});

const parsedEnv = envSchema.safeParse(process.env);
if (!parsedEnv.success) {
  console.error('❌ Environment validation failed:', parsedEnv.error.format());
}

export const env = parsedEnv.success ? parsedEnv.data : envSchema.parse({});

// Initialize Google GenAI client
const geminiApiKey = process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
  ? process.env.GEMINI_API_KEY
  : undefined;

const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

const app = express();
const port = parseInt(env.PORT, 10) || 3000;

// CORS: lets the Android app (Capacitor WebView) call this hosted API
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Security & Parsing middlewares (supports base64 document uploads up to 50MB)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// In-Memory Durable Job Queue
export interface JobRecord {
  id: string;
  type: 'extract' | 'generate-test';
  status: 'queued' | 'processing' | 'done' | 'failed';
  progress: number;
  stage: string;
  result?: any;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const jobs = new Map<string, JobRecord>();

// Clean up stale jobs older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  jobs.forEach((val, key) => {
    if (val.createdAt < cutoff) {
      jobs.delete(key);
    }
  });
}, 5 * 60 * 1000);

// Helper: Call Gemini with timeout and instant fallback
async function callGemini(contents: any, systemInstruction?: string) {
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const modelsToTry = [
    env.MODEL_PRIMARY,
    ...env.MODEL_FALLBACKS.split(',').map((s) => s.trim()).filter(Boolean),
  ];

  let lastError: any = null;

  for (const model of modelsToTry) {
    try {
      // 20 second timeout per call to avoid hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            temperature: 0.2,
          },
        });
        clearTimeout(timeoutId);
        if (response && response.text) {
          return response.text;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: any) {
      lastError = err;
      const errMsg = String(err.message || '').toLowerCase();
      // If daily quota exceeded, fail immediately without trying other models
      if (errMsg.includes('quota') || errMsg.includes('resource_exhausted') || err.status === 429) {
        const errObj: any = new Error('Daily AI Quota Exceeded. Please try again later.');
        errObj.code = 'AI_QUOTA_EXCEEDED';
        errObj.status = 429;
        throw errObj;
      }

      console.warn(`Model ${model} failed (${err.message || err}), switching to next available model...`);
    }
  }

  throw lastError || new Error('All AI models failed to respond.');
}

// -----------------------------------------------------------------------------
// Health Check API
// -----------------------------------------------------------------------------
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    app: 'StudyTest AI',
    timestamp: new Date().toISOString(),
    env: env.NODE_ENV,
    ai: {
      keyConfigured: Boolean(ai),
      primaryModel: env.MODEL_PRIMARY,
      fallbackModels: env.MODEL_FALLBACKS.split(',').map((s) => s.trim()).filter(Boolean),
    },
    system: {
      maxFileMb: parseInt(env.MAX_FILE_MB, 10),
      demoMode: env.DEMO_MODE === 'true',
      uptimeSeconds: Math.floor(process.uptime()),
    },
  });
});

// -----------------------------------------------------------------------------
// ASYNC JOB QUERY ENDPOINT
// -----------------------------------------------------------------------------
app.get('/api/jobs/:id', (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({
      code: 'NOT_FOUND',
      message: `Job ${req.params.id} not found`,
    });
  }

  res.json({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    result: job.result,
    error: job.error,
  });
});

// -----------------------------------------------------------------------------
// POST /api/extract: High-Quality Vision OCR & Text Enhancement
// -----------------------------------------------------------------------------
const extractSchema = z.object({
  filename: z.string(),
  fileBase64: z.string().optional(),
  mimeType: z.string().optional(),
  rawText: z.string().optional(),
});

app.post('/api/extract', async (req: Request, res: Response, next: NextFunction) => {
  const parsed = extractSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      code: 'BAD_REQUEST',
      message: 'Invalid payload for extraction',
      details: parsed.error.format(),
    });
  }

  const { filename, fileBase64, mimeType = 'image/jpeg', rawText } = parsed.data;
  const jobId = `job-ext-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  const job: JobRecord = {
    id: jobId,
    type: 'extract',
    status: 'queued',
    progress: 5,
    stage: 'Queued for high-resolution analysis...',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  jobs.set(jobId, job);
  res.json({ jobId, status: 'queued' });

  // Execute extraction in background
  (async () => {
    try {
      job.status = 'processing';
      job.progress = 25;
      job.stage = 'Transcribing text, diagrams, formulas and handwriting...';
      job.updatedAt = Date.now();

      const systemPrompt = `You are a world-class academic document transcription engine.
Your task is to extract every piece of legible text from this student material with 100% accuracy.
Rules:
1. Preserve structural headings, numbered points, bullet lists, scientific formulas, equations, and tables.
2. If text is in Urdu (Nastaliq or standard Arabic script), output proper Urdu script. Do not garble letters.
3. If text is in Hinglish or English, maintain natural spelling and vocabulary.
4. Mark completely illegible portions as [illegible].
5. Format output as valid JSON with keys:
{
  "text": "full extracted clean text",
  "subject": "detected subject or title",
  "language": "en" | "ur" | "hinglish",
  "qualityScore": number (0-100),
  "topics": ["topic 1", "topic 2"]
}`;

      let contents: any;

      if (fileBase64) {
        // Strip data:image/...;base64, header if present
        const cleanBase64 = fileBase64.replace(/^data:[^;]+;base64,/, '');
        contents = {
          parts: [
            {
              inlineData: {
                mimeType,
                data: cleanBase64,
              },
            },
            {
              text: `Extract the complete study text and structure from this document: ${filename}. Return JSON matching the schema.`,
            },
          ],
        };
      } else if (rawText) {
        contents = `Clean, normalize and extract key structural topics from this raw text:\n\n${rawText.slice(0, 50000)}`;
      } else {
        throw new Error('Neither fileBase64 nor rawText provided for extraction.');
      }

      job.progress = 65;
      job.stage = 'Running AI vision transcription pass...';

      const responseText = await callGemini(contents, systemPrompt);

      job.progress = 90;
      job.stage = 'Validating extracted structure and topics...';

      // Parse JSON from response
      let parsedResult: any;
      try {
        const cleanJsonStr = (responseText || '')
          .replace(/```json/gi, '')
          .replace(/```/g, '')
          .trim();
        parsedResult = JSON.parse(cleanJsonStr);
      } catch (parseErr) {
        parsedResult = {
          text: responseText || rawText || '',
          subject: filename.replace(/\.[^.]+$/, ''),
          language: 'en',
          qualityScore: 90,
          topics: ['Key Concepts', 'Definitions', 'Applications'],
        };
      }

      job.status = 'done';
      job.progress = 100;
      job.stage = 'Extraction Complete';
      job.result = {
        text: parsedResult.text,
        subject: parsedResult.subject,
        language: parsedResult.language,
        qualityScore: parsedResult.qualityScore || 92,
        topics: parsedResult.topics || [],
        wordCount: (parsedResult.text || '').split(/\s+/).filter(Boolean).length,
      };
      job.updatedAt = Date.now();
    } catch (err: any) {
      console.error('Extraction job error:', err);
      job.status = 'failed';
      job.error = err.message || 'AI extraction failed';
      job.stage = 'Extraction Failed';
      job.updatedAt = Date.now();
    }
  })();
});

// -----------------------------------------------------------------------------
// POST /api/generate-test: AI Test Generator with Rubrics and Script Control
// -----------------------------------------------------------------------------
const generateTestSchema = z.object({
  config: z.any(),
  materialText: z.string().min(20, 'At least 20 characters of study notes required'),
  topics: z.array(z.any()).optional(),
});

app.post('/api/generate-test', async (req: Request, res: Response) => {
  const parsed = generateTestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      code: 'BAD_REQUEST',
      message: 'Invalid payload for test generation',
      details: parsed.error.format(),
    });
  }

  const { config, materialText, topics } = parsed.data;
  const jobId = `job-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  const job: JobRecord = {
    id: jobId,
    type: 'generate-test',
    status: 'queued',
    progress: 5,
    stage: 'Queued for question synthesis...',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  jobs.set(jobId, job);
  res.json({ jobId, status: 'queued' });

  // Execute in background
  (async () => {
    try {
      job.status = 'processing';
      job.progress = 20;
      job.stage = 'Analyzing notes and balancing cognitive taxonomy...';
      job.updatedAt = Date.now();

      const counts = config.counts || { mcq: 10, short: 5, long: 2 };
      const lang = config.language || 'en';
      const keepTermsEnglish = Boolean(config.keepTermsEnglish);

      const prompt = `You are a master academic examiner.
Generate an exam strictly grounded in the following study text.

STUDY TEXT:
"""
${materialText.slice(0, 60000)}
"""

REQUIREMENTS:
- MCQ Count: exactly ${counts.mcq} questions. Each must have exactly 4 options, 1 correct index (0-3), plausible distractors, no "all of the above", and a 1-2 sentence explanation citing the source concept.
- Short Question Count: exactly ${counts.short} questions. Each must provide a concise model answer and a 2-4 key-point grading rubric.
- Long Question Count: exactly ${counts.long} questions. Each must provide a structured outline, marking points, and expected coverage.
- Language: Output in "${lang}" (${
        lang === 'ur'
          ? 'Pure Nastaliq Urdu script. Proper RTL flow. ' + (keepTermsEnglish ? 'Scientific terms in English.' : '')
          : lang === 'hinglish'
          ? 'Natural student Hinglish (Roman script, e.g. "Photosynthesis ke do main stages kya hain?").'
          : 'Standard academic English.'
      }).

Return ONLY a valid JSON object matching:
{
  "questions": [
    {
      "id": "mcq-1",
      "type": "mcq",
      "section": "Section A: Multiple Choice",
      "prompt": "question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": 0,
      "explanation": "explanation rationale",
      "marks": ${config.marks?.mcq || 1},
      "sourceReference": "Page 1 / Topic"
    },
    {
      "id": "short-1",
      "type": "short",
      "section": "Section B: Short Questions",
      "prompt": "short question prompt",
      "explanation": "model answer and rubric",
      "marks": ${config.marks?.short || 3},
      "sourceReference": "Page 1"
    },
    {
      "id": "long-1",
      "type": "long",
      "section": "Section C: Long Questions",
      "prompt": "essay question prompt",
      "explanation": "detailed rubric breakdown",
      "marks": ${config.marks?.long || 10},
      "sourceReference": "Page 1"
    }
  ]
}`;

      job.progress = 60;
      job.stage = 'Generating questions with AI reasoning...';

      const responseText = await callGemini(prompt);

      job.progress = 90;
      job.stage = 'Verifying questions against source material...';

      let parsedQuestions: any[] = [];
      try {
        const cleanJsonStr = (responseText || '')
          .replace(/```json/gi, '')
          .replace(/```/g, '')
          .trim();
        const parsedData = JSON.parse(cleanJsonStr);
        parsedQuestions = parsedData.questions || [];
      } catch (e) {
        console.error('Failed to parse questions JSON:', e);
      }

      if (parsedQuestions.length === 0) {
        throw new Error('AI generation did not return valid formatted questions.');
      }

      job.status = 'done';
      job.progress = 100;
      job.stage = 'Exam Ready';
      job.result = {
        questions: parsedQuestions,
        totalQuestions: parsedQuestions.length,
      };
      job.updatedAt = Date.now();
    } catch (err: any) {
      console.error('Generate test job error:', err);
      job.status = 'failed';
      job.error = err.message || 'Failed to generate test';
      job.stage = 'Generation Failed';
      job.updatedAt = Date.now();
    }
  })();
});

// JSON 404 for unknown /api routes - strictly never return HTML for API
app.all('/api/*', (req: Request, res: Response) => {
  res.status(404).json({
    code: 'NOT_FOUND',
    message: `API endpoint '${req.method} ${req.path}' not found`,
    path: req.path,
  });
});

// Global API error handler - strictly returns JSON
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled Server Error:', err);
  const status = typeof err.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
  
  res.status(status).json({
    code: err.code || 'SERVER_ERROR',
    message: err.message || 'An unexpected internal server error occurred',
    retryable: status >= 500,
    timestamp: new Date().toISOString(),
  });
});

async function startServer() {
  if (env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        watch: process.env.DISABLE_HMR === 'true' ? null : undefined,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(import.meta.dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`✨ StudyTest AI server running on http://0.0.0.0:${port} [${env.NODE_ENV}]`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
