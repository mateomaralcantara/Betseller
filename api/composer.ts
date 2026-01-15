import { GoogleGenAI } from '@google/genai';
import { SYSTEM_PROMPT } from '../constants';

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

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing GEMINI_API_KEY in server env' });

  try {
    const { task, state, model } = req.body ?? {};
    if (!task || !state) return res.status(400).json({ error: 'Missing task/state' });

    const prompt = `TASK:\n${JSON.stringify(task)}\n\nPROJECT_STATE:\n${JSON.stringify(state)}`;

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: model || 'gemini-3-pro-preview',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { systemInstruction: SYSTEM_PROMPT, responseMimeType: 'application/json' },
    });

    const parsed = safeJsonParse(response.text || '');
    return res.status(200).json(parsed);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
