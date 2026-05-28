// src/lib/gemini.ts
// FIX PREMIUM:
// - BUILD_FULL_DOSSIER usa JSON porque es estructura corta.
// - GENERATE_PROPOSAL, GENERATE_INTRODUCTION y GENERATE_CHAPTER usan TEXTO PLANO.
// - Evita: JSON inválido por comillas, saltos de línea o textos largos.
// - Evita retries eternos cuando Free Tier está agotado.

import type { ComposerTask } from "./types.local";
import type { Project } from "../../types";
import {
  safeJsonParse,
  validateEngineResult,
  ensureString,
  ensureArray,
  countWordsQuick,
  normalizeProjectState,
  buildMasterFromState,
  recomputeGenerationProgress,
} from "./editor";

export type ComposerCallOpts = {
  task: ComposerTask;
  state: any;
  model: string;
  isDev: boolean;
  devApiKey?: string;
  devSystemPrompt?: string;
  endpoint?: string;
  maxOutputTokensHint?: number;
};

export type EngineResult = ReturnType<typeof validateEngineResult>;
type LongAction = "GENERATE_PROPOSAL" | "GENERATE_INTRODUCTION" | "GENERATE_CHAPTER";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureText(v: unknown): string {
  return String(v || "").trim();
}

function cleanPlainText(raw: unknown): string {
  return String(raw || "")
    .replace(/```json/gi, "")
    .replace(/```txt/gi, "")
    .replace(/```markdown/gi, "")
    .replace(/```/g, "")
    .trim();
}

function stripChapterHeader(text: string): string {
  let out = cleanPlainText(text);
  out = out.replace(/^\s{0,3}#{1,3}\s*cap[ií]tulo\b[^\n]*\n+/i, "");
  out = out.replace(/^\s*cap[ií]tulo\s*\d+\s*[:\-–—]?\s*/i, "");
  return out.trimStart();
}

function extractJsonFromMessage(msg: string): any | null {
  const t = String(msg || "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(t.slice(first, last + 1));
  } catch {
    return null;
  }
}

function getErrorMessage(e: unknown): string {
  if (!e) return "";
  if (typeof e === "string") return e;
  const anyE = e as any;
  if (typeof anyE?.message === "string") return anyE.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function getStatusFromError(e: unknown): number | null {
  const msg = getErrorMessage(e);
  const j = extractJsonFromMessage(msg);
  const code = j?.error?.code ?? j?.code ?? null;
  if (typeof code === "number") return code;
  if (/RESOURCE_EXHAUSTED|quota|rate limit|429/i.test(msg)) return 429;
  if (/UNAVAILABLE|Service Unavailable|503/i.test(msg)) return 503;
  return null;
}

function isDailyQuotaExhausted(e: unknown): boolean {
  const msg = getErrorMessage(e);
  return (
    /GenerateRequestsPerDayPerProjectPerModel-FreeTier/i.test(msg) ||
    /GenerateContentInputTokensPerModelPerDay-FreeTier/i.test(msg) ||
    /quotaValue["']?\s*:\s*["']?20/i.test(msg) ||
    /limit:\s*20/i.test(msg) ||
    /limit:\s*0/i.test(msg)
  );
}

function parseRetryDelayMs(e: unknown): number | null {
  const msg = getErrorMessage(e);
  const j = extractJsonFromMessage(msg);
  const retryDelay =
    j?.error?.details?.find?.((d: any) => d?.retryDelay)?.retryDelay ||
    j?.details?.find?.((d: any) => d?.retryDelay)?.retryDelay;

  if (typeof retryDelay === "string") {
    const m = retryDelay.match(/^(\d+(\.\d+)?)\s*s$/i);
    if (m) return Math.ceil(Number(m[1]) * 1000);
  }

  const m2 = msg.match(/retry in\s+(\d+(\.\d+)?)s/i);
  if (m2) return Math.ceil(Number(m2[1]) * 1000);
  return null;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: any = null;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;

      if (isDailyQuotaExhausted(e)) {
        throw new Error(
          "Cuota diaria de Gemini agotada para este modelo/proyecto. Activa billing/prepay o espera el reset diario. No se reintenta porque sería perder tiempo."
        );
      }

      const code = getStatusFromError(e);
      const retriable = code === 429 || code === 503 || /ETIMEDOUT|ECONNRESET|fetch failed/i.test(getErrorMessage(e));
      if (!retriable || i === attempts - 1) throw e;

      const retryFromServer = parseRetryDelayMs(e);
      const wait = retryFromServer ?? Math.min(45000, 2500 * Math.pow(2, i) + Math.floor(Math.random() * 700));
      console.warn(`Gemini retry ${i + 1}/${attempts} in ${wait}ms`, getErrorMessage(e));
      await sleep(wait);
    }
  }

  throw last;
}

function getFallbackModels(primary: string): string[] {
  const raw = (import.meta as any)?.env?.VITE_GEMINI_FALLBACK_MODELS ?? "";
  const envList = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // No metas 2.5-pro en Free si tu cuenta marca limit 0.
  const defaults = ["gemini-2.5-flash", "gemini-3.1-flash-lite"];
  return Array.from(new Set([primary, ...envList, ...defaults].map((s) => s.trim()).filter(Boolean)));
}

function getBookTitle(state: any): string {
  return ensureString(state?.book_title, ensureString(state?.bookTitle, "Libro sin título"));
}

function getBookTopic(state: any): string {
  return ensureString(state?.book_topic, ensureString(state?.bookTopic, ""));
}

function getChapterTitle(state: any, n: number): string {
  const outline = ensureArray<any>(state?.outline_12, []);
  const item = outline.find((x: any) => Number(x?.chapter_number ?? 0) === n);
  const fromOutline = ensureString(item?.chapter_title, ensureString(item?.title, ""));
  if (fromOutline.trim()) return fromOutline.trim();

  const chapters = ensureArray<any>(state?.chapters, []);
  const ch = chapters.find((x: any) => Number(x?.chapter_number ?? 0) === n);
  const fromChapter = ensureString(ch?.title, "");
  if (fromChapter.trim()) return fromChapter.trim();

  return `Capítulo ${n}`;
}

function getOutlineHints(state: any, n: number) {
  const outline = ensureArray<any>(state?.outline_12, []);
  const item = outline.find((x: any) => Number(x?.chapter_number ?? 0) === n);
  return {
    objective: ensureString(item?.objective, ""),
    keyPoints: ensureArray<any>(item?.key_points, []).map(String).filter(Boolean).slice(0, 14),
    subheads: ensureArray<any>(item?.subheads_h2, []).map(String).filter(Boolean).slice(0, 14),
  };
}

function buildPlainPrompt(action: LongAction, task: ComposerTask, state: any): string {
  const title = getBookTitle(state);
  const topic = getBookTopic(state);
  const audience = ensureString(state?.audience, "");
  const tone = ensureString(state?.tone_style, "editorial, claro, profundo y profesional");
  const targetWords = Math.max(800, Math.floor(Number((task as any)?.target_length_words ?? 0) || 0));

  if (action === "GENERATE_PROPOSAL") {
    return `
Eres un editor senior de libros.

Escribe la PROPUESTA EDITORIAL completa del libro.
Devuelve SOLO TEXTO PLANO. NO JSON. NO Markdown fences. NO comentarios externos.

Libro:
- Título: ${title}
- Tema: ${topic}
- Audiencia: ${audience}
- Tono: ${tone}
- Objetivo mínimo: ${Math.max(2000, targetWords)} palabras

Requisitos:
- Vende con claridad la promesa del libro.
- Explica enfoque, alcance, lector ideal, valor diferencial y estructura.
- Mantén voz editorial seria y convincente.
- No uses placeholders.
- No termines a mitad de frase.
`.trim();
  }

  if (action === "GENERATE_INTRODUCTION") {
    return `
Eres un editor senior de libros.

Escribe la INTRODUCCIÓN completa del libro.
Devuelve SOLO TEXTO PLANO. NO JSON. NO Markdown fences. NO comentarios externos.

Libro:
- Título: ${title}
- Tema: ${topic}
- Audiencia: ${audience}
- Tono: ${tone}
- Objetivo mínimo: ${Math.max(1400, targetWords)} palabras

Requisitos:
- Abre con fuerza narrativa.
- Presenta el problema central.
- Promete el recorrido del libro sin sonar genérico.
- No repitas "Introducción" como encabezado.
- No uses placeholders.
- No termines a mitad de frase.
`.trim();
  }

  const n = Number((task as any)?.chapter_number ?? 0) || 0;
  const chapterTitle = getChapterTitle(state, n);
  const hints = getOutlineHints(state, n);

  return `
Eres un escritor editorial profesional.

Escribe el CAPÍTULO ${n} completo.
Devuelve SOLO TEXTO PLANO. NO JSON. NO Markdown fences. NO comentarios externos.

Libro:
- Título: ${title}
- Tema: ${topic}
- Audiencia: ${audience}
- Tono: ${tone}

Capítulo:
- Número: ${n}
- Título: ${chapterTitle}
- Objetivo mínimo: ${Math.max(1800, targetWords)} palabras
- Objetivo editorial: ${hints.objective || "(no especificado)"}
- Puntos clave: ${hints.keyPoints.length ? hints.keyPoints.join("; ") : "(no especificado)"}
- Subtítulos sugeridos: ${hints.subheads.length ? hints.subheads.join("; ") : "(no especificado)"}

Reglas duras:
- No incluyas encabezado "Capítulo ${n}".
- No repitas el título al inicio.
- Puedes usar subtítulos internos con ### si aportan orden.
- Debe ser denso, claro, humano y publicable.
- No uses placeholders.
- No termines a mitad de frase.
`.trim();
}

async function callGeminiPlain(args: {
  apiKey: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
  temperature: number;
}): Promise<string> {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: args.apiKey });
  const models = getFallbackModels(args.model);
  let lastErr: any = null;

  for (const m of models) {
    try {
      const resp = await withRetry(() =>
        ai.models.generateContent({
          model: m,
          contents: [{ role: "user", parts: [{ text: args.prompt }] }],
          config: {
            maxOutputTokens: args.maxOutputTokens,
            temperature: args.temperature,
          } as any,
        })
      );

      const text = cleanPlainText((resp as any)?.text || "");
      if (countWordsQuick(text) < 40) throw new Error(`Respuesta demasiado corta del modelo ${m}.`);
      return text;
    } catch (e) {
      lastErr = e;
      if (isDailyQuotaExhausted(e)) throw e;
      const code = getStatusFromError(e);
      if (code === 429 || code === 503) {
        console.warn(`Plain model ${m} failed (${code}). Trying fallback…`);
        continue;
      }
      throw e;
    }
  }

  throw lastErr ?? new Error("Error llamando Gemini en texto plano.");
}

function buildEngineResultFromText(action: LongAction, task: ComposerTask, state: any, rawText: string): EngineResult {
  const nextState: any = normalizeProjectState(state);
  const text = cleanPlainText(rawText);
  const words = countWordsQuick(text);

  if (action === "GENERATE_PROPOSAL") {
    nextState.proposal = {
      ...(nextState.proposal ?? {}),
      id: "sec_proposal",
      text,
      status: "COMPLETED",
      words,
    };
  }

  if (action === "GENERATE_INTRODUCTION") {
    nextState.introduction = {
      ...(nextState.introduction ?? {}),
      id: "sec_introduction",
      text,
      status: "COMPLETED",
      words,
    };
  }

  if (action === "GENERATE_CHAPTER") {
    const n = Number((task as any)?.chapter_number ?? 0) || 0;
    const chapters = ensureArray<any>(nextState.chapters, []);
    const idx = chapters.findIndex((c: any) => Number(c?.chapter_number ?? 0) === n);
    const chapterText = stripChapterHeader(text);
    const chapter = {
      ...(idx >= 0 ? chapters[idx] : {}),
      id: `sec_chapter_${String(n).padStart(2, "0")}`,
      chapter_number: n,
      title: getChapterTitle(nextState, n),
      text: chapterText,
      status: "COMPLETED",
      words: countWordsQuick(chapterText),
    };

    if (idx >= 0) chapters[idx] = chapter;
    else chapters.push(chapter);

    nextState.chapters = chapters.sort((a, b) => (Number(a?.chapter_number ?? 0) || 0) - (Number(b?.chapter_number ?? 0) || 0));
  }

  const master = buildMasterFromState(nextState as any, getBookTitle(nextState));

  return validateEngineResult({
    ok: true,
    dashboard: (state as any)?.dashboard ?? {},
    project_state_updated: nextState,
    master_document: {
      title: getBookTitle(nextState),
      text: master,
    },
  });
}

async function callLongSectionPlainDev(opts: ComposerCallOpts): Promise<EngineResult> {
  const apiKey = opts.devApiKey ?? "";
  if (!apiKey) throw new Error("Falta VITE_GEMINI_API_KEY en .env.local.");

  const action = String((opts.task as any)?.action || "") as LongAction;
  const targetWords = Math.max(0, Math.floor(Number((opts.task as any)?.target_length_words ?? 0) || 0));
  const prompt = buildPlainPrompt(action, opts.task, opts.state ?? {});

  const maxOutputTokens =
    opts.maxOutputTokensHint ??
    (action === "GENERATE_CHAPTER"
      ? Math.min(26000, Math.max(12000, Math.floor((targetWords || 3000) * 3.1)))
      : action === "GENERATE_PROPOSAL"
        ? 18000
        : 14000);

  const text = await callGeminiPlain({
    apiKey,
    model: opts.model,
    prompt,
    maxOutputTokens,
    temperature: action === "GENERATE_CHAPTER" ? 0.82 : 0.68,
  });

  return buildEngineResultFromText(action, opts.task, opts.state ?? {}, text);
}

async function callDossierJsonDev(opts: ComposerCallOpts): Promise<EngineResult> {
  const apiKey = opts.devApiKey ?? "";
  if (!apiKey) throw new Error("Falta VITE_GEMINI_API_KEY en .env.local.");

  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey });
  const prompt = `TASK:\n${JSON.stringify(opts.task)}\n\nPROJECT_STATE:\n${JSON.stringify(opts.state)}`;
  const models = getFallbackModels(opts.model);
  let lastErr: any = null;

  for (const m of models) {
    try {
      const resp = await withRetry(() =>
        ai.models.generateContent({
          model: m,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: {
            systemInstruction: opts.devSystemPrompt ?? "",
            responseMimeType: "application/json",
            maxOutputTokens: opts.maxOutputTokensHint ?? 12000,
            temperature: 0.55,
          } as any,
        })
      );

      return validateEngineResult(safeJsonParse((resp as any)?.text || ""));
    } catch (e) {
      lastErr = e;
      if (isDailyQuotaExhausted(e)) throw e;
      const code = getStatusFromError(e);
      if (code === 429 || code === 503) {
        console.warn(`Dossier model ${m} failed (${code}). Trying fallback…`);
        continue;
      }
      throw e;
    }
  }

  throw lastErr ?? new Error("Error llamando Gemini para dossier.");
}

export async function callComposer(opts: ComposerCallOpts): Promise<EngineResult> {
  const action = String((opts.task as any)?.action || "");

  if (opts.isDev) {
    if (action === "GENERATE_PROPOSAL" || action === "GENERATE_INTRODUCTION" || action === "GENERATE_CHAPTER") {
      return callLongSectionPlainDev(opts);
    }
    return callDossierJsonDev(opts);
  }

  // Producción actual: conserva endpoint existente.
  // Recomendado: migrar /api/composer con la misma regla: texto largo = texto plano.
  const endpoint = opts.endpoint ?? "/api/composer";
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: opts.task, state: opts.state, model: opts.model }),
  });

  const raw = await r.text();
  const data = safeJsonParse(raw) as any;
  if (!r.ok) throw new Error(ensureString(data?.error, ensureString(data?.message, `HTTP ${r.status}`)));
  return validateEngineResult(data);
}

// Compatibilidad con App.tsx actual.
// Ya no hacemos auto-extend con más llamadas por defecto para no quemar cuota.
// Si quieres worker por bloques, usa la arquitectura de jobs.
export async function autoExtendChapterDev(params: {
  project: Project;
  chapterNum: number;
  targetWords: number;
  model: string;
  apiKey?: string;
  devApiKey?: string;
  minWords?: number;
  maxSteps?: number;
}): Promise<Project> {
  const p = params.project;
  const out: Project = { ...(p as any) } as any;
  (out as any).generation_progress = recomputeGenerationProgress(out as any);
  return out;
}
