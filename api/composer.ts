import { GoogleGenAI } from '@google/genai';

/**
 * Vercel Serverless Function: POST /api/composer
 * - Guarda GEMINI_API_KEY como env privada en Vercel (NO VITE_).
 * - Body esperado: { task: object, state: object, model?: string }
 *
 * Nota: No importamos ../src/constants para evitar errores de path.
 * Si quieres un prompt más largo, reemplaza SYSTEM_PROMPT aquí (server-side).
 */
const SYSTEM_PROMPT = `Eres BOOK_DOSSIER_CANVAS_ENGINE.
Responde SIEMPRE en JSON válido (sin Markdown) con:
{ ok, dashboard, project_state_updated, master_document, needs_input? }.
Nunca borres texto existente si no estás seguro: si una sección no se está modificando, déjala intacta.`.trim();

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

async function readJsonBody(req: any): Promise<any> {
  // Vercel normalmente ya entrega req.body parseado para JSON.
  if (req?.body && typeof req.body === 'object') return req.body;

  // Fallback: leer stream
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

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing GEMINI_API_KEY in server env' });

  try {
    const body = await readJsonBody(req);
    const task = body?.task;
    const state = body?.state;
    const model = body?.model || 'gemini-3-flash-preview';

    if (!task || !state) return res.status(400).json({ error: 'Missing task/state' });

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
    const msg = e?.message || 'Server error';

    // Si Google devuelve 429/RESOURCE_EXHAUSTED, lo pasamos como 429 para que el frontend lo maneje bien
    if (/RESOURCE_EXHAUSTED|quota|rate limit|429/i.test(msg)) {
      return res.status(429).json({ error: msg });
    }

    return res.status(500).json({ error: msg });
  }
}
