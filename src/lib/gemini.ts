// src/lib/gemini.ts
// DEV composer + Turbo chapter extension.
// PROD composer lives at /api/composer (Vercel Function).
import type { Project } from "../../types";
import type { ComposerTask } from "./types.local"; // local helper typing (see below)
import {
  countWordsQuick,
  ensureArray,
  ensureString,
  safeJsonParse,
  validateEngineResult,
  processEngineResult,
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
  endpoint?: string; // default /api/composer
  maxOutputTokensHint?: number; // optional
};

export type EngineResult = ReturnType<typeof validateEngineResult>;

/* ----------------------- retry helpers ----------------------- */

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetriableGeminiError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e ?? "");
  return /503|UNAVAILABLE|Service Unavailable|RESOURCE_EXHAUSTED|quota|rate limit|429|ETIMEDOUT|ECONNRESET|fetch failed/i.test(msg);
}

async function withRetry<T>(fn: () => Promise<T>, opts?: { attempts?: number; baseMs?: number; maxMs?: number }): Promise<T> {
  const attempts = opts?.attempts ?? 6;
  const baseMs = opts?.baseMs ?? 900;
  const maxMs = opts?.maxMs ?? 20_000;

  let lastErr: any = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetriableGeminiError(e) || i === attempts - 1) throw e;
      const jitter = Math.floor(Math.random() * 250);
      const wait = Math.min(maxMs, Math.floor(baseMs * Math.pow(2, i)) + jitter);
      // eslint-disable-next-line no-console
      console.warn(`Gemini retry ${i + 1}/${attempts} in ${wait}ms`, (e as any)?.message ?? e);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/* ----------------------- call composer (dev or prod) ----------------------- */

export async function callComposer(opts: ComposerCallOpts): Promise<EngineResult> {
  const { task, state, model, isDev } = opts;

  if (isDev) {
    const apiKey = opts.devApiKey ?? "";
    if (!apiKey) throw new Error("Falta VITE_GEMINI_API_KEY en .env.local (solo dev).");
    const systemPrompt = opts.devSystemPrompt ?? "";

    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });

    const prompt = `TASK:\n${JSON.stringify(task)}\n\nPROJECT_STATE:\n${JSON.stringify(state)}`;

    const targetW =
      typeof (task as any).target_length_words === "number" && Number.isFinite((task as any).target_length_words)
        ? Math.max(0, Math.floor((task as any).target_length_words))
        : 0;

    const isChapter = (task as any).action === "GENERATE_CHAPTER";
    const maxOut =
      opts.maxOutputTokensHint ??
      (isChapter ? Math.min(32_000, Math.max(16_000, Math.floor(targetW > 0 ? targetW * 3.2 : 20_000))) : 8192);

    const resp = await withRetry(() =>
      ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          maxOutputTokens: maxOut,
          temperature: isChapter ? 0.85 : 0.6,
        } as any,
      })
    );

    const parsed = safeJsonParse((resp as any)?.text || "");
    return validateEngineResult(parsed);
  }

  const endpoint = opts.endpoint ?? "/api/composer";
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, state, model }),
  });

  const raw = await r.text();
  const data = safeJsonParse(raw) as any;
  if (!r.ok) throw new Error(ensureString(data?.error, ensureString(data?.message, `HTTP ${r.status}`)));
  return validateEngineResult(data);
}

/* ----------------------- Turbo: auto-extend chapter in DEV ----------------------- */

function trimOverlap(existing: string, addition: string): string {
  const a = (existing ?? "").trim();
  const b = (addition ?? "").trim();
  if (!a) return b;
  if (!b) return "";
  const aTail = a.slice(-1600);
  for (let k = Math.min(1200, aTail.length); k >= 120; k -= 40) {
    const suffix = aTail.slice(-k);
    if (b.startsWith(suffix)) return b.slice(k).trimStart();
  }
  return b;
}

function getChapterTextFromProject(p: Project, chapterNum: number): { idx: number; text: string; title: string } {
  const st: any = (p as any).state ?? {};
  const chs = ensureArray<any>(st?.chapters, []);
  const idx = chs.findIndex((c: any) => Number(c?.chapter_number ?? 0) === chapterNum);
  const ch = idx >= 0 ? chs[idx] : null;
  return {
    idx,
    text: ensureString(ch?.text, ""),
    title: ensureString(ch?.title, `Capítulo ${chapterNum}`),
  };
}

function setChapterTextOnProject(
  p: Project,
  chapterNum: number,
  title: string,
  text: string,
  status: "PENDING" | "COMPLETED"
): Project {
  const st: any = JSON.parse(JSON.stringify((p as any).state ?? {}));
  const chs = ensureArray<any>(st?.chapters, []);
  const idx = chs.findIndex((c: any) => Number(c?.chapter_number ?? 0) === chapterNum);

  const updated = {
    ...(idx >= 0 ? chs[idx] : {}),
    chapter_number: chapterNum,
    title,
    text,
    status,
    words: countWordsQuick(text),
  };

  if (idx >= 0) chs[idx] = updated;
  else chs.push(updated);

  st.chapters = chs;
  const merged = normalizeProjectState(st);

  const masterLocal = buildMasterFromState(merged, (p as any).title);
  const out: Project = {
    ...(p as any),
    state: merged,
    master_document: {
      ...((p as any).master_document ?? {}),
      title: ensureString((p as any).master_document?.title, (p as any).title),
      text: masterLocal,
      chunks: [{ index: 1, total: 1, text: masterLocal }],
    } as any,
  } as any;

  (out as any).generation_progress = recomputeGenerationProgress(out);
  return out;
}

export async function autoExtendChapterDev(params: {
  project: Project;
  chapterNum: number;
  targetWords: number;
  model: string;
  devApiKey: string;
}): Promise<Project> {
  const { project, chapterNum, targetWords, model, devApiKey } = params;

  if (!import.meta.env.DEV) return project;
  if (!devApiKey) return project;

  const target = Math.max(0, Math.floor(targetWords || 0));
  if (!target) return project;

  let current = project;
  let { text: chapterText, title } = getChapterTextFromProject(current, chapterNum);

  if (countWordsQuick(chapterText) >= target) {
    return setChapterTextOnProject(current, chapterNum, title, chapterText, "COMPLETED");
  }

  const st: any = (current as any).state ?? {};
  const outline = ensureArray<any>(st?.outline_12, []);
  const o = outline.find((x: any) => Number(x?.chapter_number ?? 0) === chapterNum);

  const objective = ensureString(o?.objective, "");
  const keyPoints = ensureArray<any>(o?.key_points, []).slice(0, 12).filter(Boolean);
  const subheads = ensureArray<any>(o?.subheads_h2, []).slice(0, 12).filter(Boolean);

  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: devApiKey });

  const maxSteps = Math.max(2, Math.min(10, Math.ceil(target / 2400) + 2));

  for (let step = 1; step <= maxSteps; step++) {
    const wcNow = countWordsQuick(chapterText);
    if (wcNow >= target) break;

    const remaining = Math.max(0, target - wcNow);
    const chunkWords =
      remaining >= 3600 ? 2600 :
      remaining >= 2400 ? 2000 :
      remaining >= 1600 ? 1600 :
      Math.max(900, remaining + 220);

    const maxOut = Math.min(32_000, Math.max(12_000, Math.floor(chunkWords * 3.0)));
    const tail = chapterText.slice(-2800);

    const userPrompt = `
CONTINÚA el Capítulo ${chapterNum} SIN REESCRIBIR lo ya escrito.
Devuelve SOLO el texto NUEVO a añadir (Markdown). NO incluyas JSON.

OBJETIVO DEL CAPÍTULO:
${objective || "(no especificado)"}

PUNTOS CLAVE:
${keyPoints.length ? "- " + keyPoints.join("\n- ") : "(no especificado)"}

SUBTÍTULOS SUGERIDOS:
${subheads.length ? "- " + subheads.join("\n- ") : "(no especificado)"}

REQUISITOS:
- Añade un bloque sustancial: ~${chunkWords} palabras (mínimo 1200 si faltan >2000).
- NO repitas el final. NO resumas lo ya dicho.
- Cierra con frase completa.

ÚLTIMO CONTEXTO (NO REPETIR):
<<<CONTEXT
${tail}
CONTEXT
`.trim();

    const resp = await withRetry(() =>
      ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        config: { maxOutputTokens: maxOut, temperature: 0.85 } as any,
      })
    );

    const addRaw = ensureString((resp as any)?.text, "").trim();
    const add = trimOverlap(chapterText, addRaw);
    if (countWordsQuick(add) < 500) continue;

    chapterText = (chapterText.trim() ? chapterText.trim() + "\n\n" : "") + add.trim();
    current = setChapterTextOnProject(current, chapterNum, title, chapterText, "PENDING");
  }

  const finalWords = countWordsQuick(chapterText);
  if (finalWords < target) throw new Error(`Capítulo quedó corto: ${finalWords} palabras. Objetivo: ${target}.`);

  return setChapterTextOnProject(current, chapterNum, title, chapterText, "COMPLETED");
}

/* ----------------------- local type to avoid circular deps ----------------------- */
// We keep this tiny type here so App can import ComposerTask from types.local if desired.
