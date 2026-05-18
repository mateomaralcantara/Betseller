import { GoogleGenAI } from '@google/genai';

/**
 * Vercel Serverless Function: POST /api/composer
 * - GEMINI_API_KEY: env privada (NO VITE_)
 * - COMPOSER_SHARED_SECRET: env privada para proteger endpoint
 * - Body esperado: { task: object, state: object, model?: string }
 */

const SYSTEM_PROMPT = `Eres BOOK_DOSSIER_CANVAS_ENGINE.
Responde SIEMPRE en JSON válido (sin Markdown) con:
{ ok, dashboard, project_state_updated, master_document, needs_input? }.
Nunca borres texto existente si no estás seguro: si una sección no se está modificando, déjala intacta.`.trim();

/** Model allowlist (evita sorpresas) */
const ALLOWED_MODELS = new Set<string>([
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
]);

function safeJsonParse(text: string): any {
  const t = (text ?? '').trim();
  if (!t) throw new Error('Respuesta vacía');
  try {
    return JSON.parse(t);
  } catch {
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(t.slice(first, last + 1));
    throw new Error('No se pudo parsear JSON');
  }
}

function pickErrorMessage(e: any): string {
  if (!e) return 'Server error';
  if (typeof e === 'string') return e;
  if (typeof e.message === 'string') return e.message;

  // Algunas libs meten detalles en "error" o "response"
  const maybe =
    e?.error?.message ||
    e?.error ||
    e?.details?.message ||
    e?.response?.data?.error?.message ||
    e?.response?.data?.error ||
    e?.response?.data?.message;

  if (typeof maybe === 'string') return maybe;

  try {
    return JSON.stringify(e).slice(0, 2000);
  } catch {
    return 'Server error';
  }
}

function looksLikeQuota(msg: string) {
  return /RESOURCE_EXHAUSTED|quota|rate limit|RetryInfo|retryDelay|429/i.test(msg);
}

function parseRetryAfterSeconds(msg: string): number | null {
  // Gemini a veces trae "retryDelay":"46s"
  const m1 = msg.match(/retryDelay["']?\s*:\s*["']?(\d+)\s*s/i);
  if (m1) return Number(m1[1]);

  // o "Please retry in 46.08s"
  const m2 = msg.match(/retry in\s+(\d+(\.\d+)?)s/i);
  if (m2) return Math.ceil(Number(m2[1]));

  return null;
}

async function readJsonBody(req: any): Promise<any> {
  // Vercel muchas veces entrega req.body como objeto si el Content-Type es JSON
  if (req?.body && typeof req.body === 'object') return req.body;

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve());
    req.on('error', reject);
  });

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function enforceSecret(req: any) {
  const secret = process.env.COMPOSER_SHARED_SECRET;
  if (!secret) return; // si no lo configuras, no bloquea (pero recomendado configurarlo)
  const got = req.headers?.['x-composer-secret'];
  if (!got || got !== secret) {
    const err: any = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
}

export default async function handler(req: any, res: any) {
  // (Opcional) CORS preflight si algún día llamas desde otro dominio
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing GEMINI_API_KEY in server env' });

  try {
    // ✅ Protege el endpoint (evita que te quemen cuota)
    enforceSecret(req);

    const contentType = String(req.headers?.['content-type'] ?? '');
    // No lo hacemos súper estricto, pero ayuda a evitar body raro
    if (contentType && !contentType.includes('application/json')) {
      return res.status(415).json({ error: 'Unsupported content-type. Use application/json' });
    }

    let body: any = {};
    try {
      body = await readJsonBody(req);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const task = body?.task;
    const state = body?.state;

    if (!task || !state) return res.status(400).json({ error: 'Missing task/state' });

    const requestedModel = String(body?.model || 'gemini-3-flash-preview');
    const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : 'gemini-3-flash-preview';

    const prompt = `TASK:\n${JSON.stringify(task)}\n\nPROJECT_STATE:\n${JSON.stringify(state)}`;

    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: 'application/json',
      },
    });

    const parsed = safeJsonParse(response.text || '');
    return res.status(200).json(parsed);
  } catch (e: any) {
    const statusCode = typeof e?.statusCode === 'number' ? e.statusCode : 500;
    const msg = pickErrorMessage(e);

    if (looksLikeQuota(msg)) {
      const retryAfter = parseRetryAfterSeconds(msg);
      if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: msg });
    }

    return res.status(statusCode).json({ error: msg });
  }
}