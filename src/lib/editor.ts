// src/lib/editor.ts
// Shared editor/state helpers for App.tsx
import type { Project, ProjectState } from "../../types";

export type AnyRecord = Record<string, unknown>;

export type GenerationStatus = "pending" | "generating" | "completed" | "error";
export type GenerationProgress = Record<string, GenerationStatus>;

export type EngineResult = {
  ok: boolean;
  dashboard?: unknown;
  project_state_updated?: unknown;
  master_document?: unknown;
  needs_input?: { message?: string };
};

export type ProcessCtx = { action?: string; chapterNum?: number };

const WORD_RE = /\S+/g;

export function isRecord(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function ensureArray<T>(v: unknown, fallback: T[] = []): T[] {
  return Array.isArray(v) ? (v as T[]) : fallback;
}

export function ensureString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function normalizeError(e: unknown): string {
  if (typeof e === "string") return e;
  if (isRecord(e) && "message" in e) return String((e as AnyRecord).message);
  return "Error desconocido";
}

export function countWordsQuick(text: string): number {
  const t = (text ?? "").trim();
  if (!t) return 0;
  const m = t.match(WORD_RE);
  return m ? m.length : 0;
}

export function isPlaceholderText(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  const compact = t.replace(/\s+/g, "");
  if (compact === "..." || compact === "…") return true;
  const dots = (t.match(/\.\.\./g) ?? []).length;
  const wc = countWordsQuick(t);
  if (dots >= 2 && wc < 120) return true;
  if (wc > 0 && wc < 40 && /\.\.\.|…/.test(t)) return true;
  return false;
}

/** ✅ Business rule: complete means reaching target (if provided). */
export function chapterIsComplete(text: string, targetWords?: number): boolean {
  const wc = countWordsQuick(text);
  if (!wc) return false;
  if (isPlaceholderText(text)) return false;
  const target = typeof targetWords === "number" && Number.isFinite(targetWords) ? Math.floor(targetWords) : 0;
  return target > 0 ? wc >= target : wc >= 900;
}

/* ----------------------------- engine parse ----------------------------- */

export function safeJsonParse(text: string): unknown {
  const t = (text ?? "").trim();
  if (!t) throw new Error("Respuesta vacía.");
  try {
    return JSON.parse(t);
  } catch {
    const first = t.indexOf("{");
    const last = t.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(t.slice(first, last + 1));
    throw new Error("No se pudo parsear JSON.");
  }
}

export function validateEngineResult(raw: unknown): EngineResult {
  if (!isRecord(raw)) throw new Error("Respuesta no es JSON object.");
  if ((raw as AnyRecord).ok !== true) {
    const needs = (raw as AnyRecord).needs_input;
    const msg = isRecord(needs) ? ensureString(needs.message, "") : "";
    throw new Error(msg || "Error del motor editorial.");
  }
  if (!("project_state_updated" in raw)) throw new Error("Respuesta inválida: falta project_state_updated.");
  if (!("master_document" in raw)) throw new Error("Respuesta inválida: falta master_document.");
  if (!("dashboard" in raw)) throw new Error("Respuesta inválida: falta dashboard.");
  return raw as EngineResult;
}

/* -------------------------- master + normalize + merge -------------------------- */

export function buildMasterFromState(state: ProjectState, title?: string): string {
  const parts: string[] = [];
  const bookTitle = (title || (state as any).book_title || "Documento maestro").trim();
  parts.push(`# ${bookTitle}\n`);

  const proposalText = ensureString((state as any).proposal?.text, "").trim();
  if (proposalText) parts.push(`## Propuesta editorial\n\n${proposalText}`);

  const introText = ensureString((state as any).introduction?.text, "").trim();
  if (introText) parts.push(`## Introducción\n\n${introText}`);

  const chapters = ensureArray<any>((state as any).chapters, [])
    .slice()
    .sort((a, b) => (Number(a?.chapter_number ?? 0) || 0) - (Number(b?.chapter_number ?? 0) || 0));

  for (const ch of chapters) {
    const t = ensureString(ch?.text, "").trim();
    if (!t) continue;
    const n = ch?.chapter_number ?? "";
    const chTitle = ensureString(ch?.title, n ? `Capítulo ${n}` : "Capítulo").trim();
    parts.push(`## ${chTitle}\n\n${t}`);
  }

  return parts.join("\n\n---\n\n").trim() + "\n";
}

export function normalizeProjectState(input: unknown): ProjectState {
  const state: AnyRecord = isRecord(input) ? { ...(input as AnyRecord) } : {};

  const proposal = isRecord((state as any).proposal) ? { ...((state as any).proposal as AnyRecord) } : {};
  (proposal as any).id = ensureString((proposal as any).id, "sec_proposal");
  (proposal as any).text = ensureString((proposal as any).text, "");
  (proposal as any).status = (proposal as any).status === "COMPLETED" ? "COMPLETED" : "PENDING";
  (proposal as any).words = typeof (proposal as any).words === "number" ? (proposal as any).words : 0;
  (state as any).proposal = proposal;

  const introduction = isRecord((state as any).introduction) ? { ...((state as any).introduction as AnyRecord) } : {};
  (introduction as any).id = ensureString((introduction as any).id, "sec_introduction");
  (introduction as any).text = ensureString((introduction as any).text, "");
  (introduction as any).status = (introduction as any).status === "COMPLETED" ? "COMPLETED" : "PENDING";
  (introduction as any).words = typeof (introduction as any).words === "number" ? (introduction as any).words : 0;
  (state as any).introduction = introduction;

  (state as any).outline_12 = ensureArray<any>((state as any).outline_12, []).map((o: any, idx: number) => {
    const chapterNum =
      typeof o?.chapter_number === "number"
        ? o.chapter_number
        : typeof o?.chapterNumber === "number"
          ? o.chapterNumber
          : idx + 1;

    const normalized: AnyRecord = isRecord(o) ? { ...(o as AnyRecord) } : {};
    (normalized as any).id = ensureString((normalized as any).id, `outline_${String(chapterNum).padStart(2, "0")}`);
    (normalized as any).chapter_number = chapterNum;
    (normalized as any).chapter_title = ensureString(
      (normalized as any).chapter_title,
      ensureString((normalized as any).title, `Capítulo ${chapterNum}`)
    );
    (normalized as any).status =
      (normalized as any).status === "COMPLETED" || (normalized as any).status === "DRAFTED"
        ? (normalized as any).status
        : "PENDING";
    (normalized as any).target_words = typeof (normalized as any).target_words === "number" ? (normalized as any).target_words : 0;
    (normalized as any).objective = ensureString((normalized as any).objective, "");
    (normalized as any).key_points = ensureArray((normalized as any).key_points, []);
    (normalized as any).subheads_h2 = ensureArray((normalized as any).subheads_h2, []);
    return normalized;
  });

  (state as any).chapters = ensureArray<any>((state as any).chapters, []).map((c: any, idx: number) => {
    const cn = Number(c?.chapter_number ?? c?.chapterNumber ?? idx + 1) || idx + 1;
    const normalized: AnyRecord = isRecord(c) ? { ...(c as AnyRecord) } : {};
    (normalized as any).chapter_number = cn;
    (normalized as any).id = ensureString((normalized as any).id, `sec_chapter_${String(cn).padStart(2, "0")}`);
    (normalized as any).title = ensureString((normalized as any).title, `Capítulo ${cn}`).trim();
    (normalized as any).text = ensureString((normalized as any).text, "");
    (normalized as any).status = (normalized as any).status === "COMPLETED" ? "COMPLETED" : "PENDING";
    (normalized as any).words = typeof (normalized as any).words === "number" ? (normalized as any).words : 0;
    return normalized;
  });

  const continuity = isRecord((state as any).continuity_pack) ? { ...((state as any).continuity_pack as AnyRecord) } : {};
  (continuity as any).style_guide = ensureString((continuity as any).style_guide, "");
  (continuity as any).canon = ensureString((continuity as any).canon, "");
  (continuity as any).outline_progress = ensureString((continuity as any).outline_progress, "");
  (continuity as any).open_loops = ensureArray((continuity as any).open_loops, []);
  (continuity as any).chapter_summaries = ensureArray((continuity as any).chapter_summaries, []);
  (continuity as any).next_chapter_plan = ensureArray((continuity as any).next_chapter_plan, []);
  (state as any).continuity_pack = continuity;

  (state as any).project_id = ensureString((state as any).project_id, ensureString((state as any).projectId, `proj_${Date.now()}`));
  (state as any).book_title = ensureString((state as any).book_title, ensureString((state as any).bookTitle, "Libro sin título"));
  (state as any).book_topic = ensureString((state as any).book_topic, ensureString((state as any).bookTopic, ""));
  (state as any).audience = ensureString((state as any).audience, "");
  (state as any).tone_style = ensureString((state as any).tone_style, "");

  return state as unknown as ProjectState;
}

export function shouldPreservePrevText(prevText: string, nextText: string): boolean {
  const prev = (prevText ?? "").trim();
  const next = (nextText ?? "").trim();
  if (!prev) return false;
  if (!next) return true;
  if (isPlaceholderText(next)) return true;

  if (next.length < Math.max(160, Math.floor(prev.length * 0.7))) return true;

  const prevW = countWordsQuick(prev);
  const nextW = countWordsQuick(next);
  if (prevW >= 220 && nextW < Math.max(80, Math.floor(prevW * 0.6))) return true;

  return false;
}

export function mergeProjectState(prev: ProjectState | undefined, next: ProjectState): ProjectState {
  if (!prev) return next;

  const merged: AnyRecord = { ...(prev as any), ...(next as any) };

  merged.proposal = { ...(prev as any).proposal, ...(next as any).proposal };
  if (!ensureString((merged.proposal as any)?.text, "").trim() && ensureString((prev as any).proposal?.text, "").trim()) {
    merged.proposal = { ...(prev as any).proposal };
  }

  merged.introduction = { ...(prev as any).introduction, ...(next as any).introduction };
  if (
    !ensureString((merged.introduction as any)?.text, "").trim() &&
    ensureString((prev as any).introduction?.text, "").trim()
  ) {
    merged.introduction = { ...(prev as any).introduction };
  }

  const prevOutline = ensureArray<any>((prev as any).outline_12, []);
  const nextOutline = ensureArray<any>((next as any).outline_12, []);
  const outlineByNum = new Map<number, any>();
  for (const o of prevOutline) outlineByNum.set(o.chapter_number, o);
  for (const o of nextOutline) outlineByNum.set(o.chapter_number, { ...outlineByNum.get(o.chapter_number), ...o });
  merged.outline_12 = Array.from(outlineByNum.values()).sort((a, b) => (a.chapter_number ?? 0) - (b.chapter_number ?? 0));

  const prevCh = ensureArray<any>((prev as any).chapters, []);
  const nextCh = ensureArray<any>((next as any).chapters, []);
  const byNum = new Map<number, any>();

  for (const c of prevCh) {
    const cn = Number(c?.chapter_number ?? 0) || 0;
    if (cn > 0) byNum.set(cn, c);
  }

  for (const c of nextCh) {
    const cn = Number(c?.chapter_number ?? 0) || 0;
    if (!cn) continue;

    const existing = byNum.get(cn);
    const mergedC = { ...(existing || {}), ...c, chapter_number: cn };

    if (existing) {
      const prevText = ensureString(existing?.text, "");
      const nextText = ensureString(c?.text, "");
      if (shouldPreservePrevText(prevText, nextText)) {
        mergedC.text = existing.text;
        mergedC.status = existing.status;
        mergedC.words = existing.words;
      }
    }

    byNum.set(cn, mergedC);
  }

  merged.chapters = Array.from(byNum.values()).sort((a, b) => (a.chapter_number ?? 0) - (b.chapter_number ?? 0));
  merged.continuity_pack = { ...(prev as any).continuity_pack, ...(next as any).continuity_pack };

  return merged as unknown as ProjectState;
}

export function recomputeGenerationProgress(project: Project): GenerationProgress {
  const prev = ((project as any).generation_progress as AnyRecord) || {};
  const progress: GenerationProgress = { ...(prev as GenerationProgress) };
  const st = ((project as any).state as AnyRecord) || {};

  const proposalText = ensureString((st as any).proposal?.text, "");
  const introText = ensureString((st as any).introduction?.text, "");

  const proposalDone =
    (ensureString((st as any).proposal?.status, "") === "COMPLETED" || countWordsQuick(proposalText) >= 200) &&
    !isPlaceholderText(proposalText);

  const introDone =
    (ensureString((st as any).introduction?.status, "") === "COMPLETED" || countWordsQuick(introText) >= 200) &&
    !isPlaceholderText(introText);

  if (progress.proposal !== "generating") progress.proposal = proposalDone ? "completed" : "pending";
  if (progress.intro !== "generating") progress.intro = introDone ? "completed" : "pending";

  const outline = ensureArray<any>((st as any).outline_12, []);
  const chapters = ensureArray<any>((st as any).chapters, []);

  const byNum = new Map<number, any>();
  for (const c of chapters) {
    const cn = Number(c?.chapter_number ?? 0) || 0;
    if (cn > 0) byNum.set(cn, c);
  }

  for (const o of outline) {
    const n = Number(o?.chapter_number ?? 0) || 0;
    if (!n) continue;
    const id = `chap-${n}`;
    if (progress[id] === "generating") continue;
    const ch = byNum.get(n);
    const text = ensureString(ch?.text, "");
    progress[id] = chapterIsComplete(text, o?.target_words) ? "completed" : "pending";
  }

  return progress;
}

/* ----------------------- composer compaction helpers ----------------------- */

export function clipText(s: string, maxChars: number): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return `[[CLIPPED ${t.length - maxChars} chars]]\n` + t.slice(t.length - maxChars);
}

export function compactStateForComposer(project: Project, maxMasterChars: number): AnyRecord {
  const st = ((project as any).state as AnyRecord) ?? {};
  const dash = ((project as any).dashboard as AnyRecord) ?? {};
  const md = ((project as any).master_document as AnyRecord) ?? {};
  return {
    ...st,
    dashboard: dash,
    master_document: {
      title: ensureString((md as any).title, ""),
      text: clipText(ensureString((md as any).text, ""), maxMasterChars),
    },
  };
}

/* ----------------------- Apply engine result -> project ----------------------- */

export function processEngineResult(
  result: EngineResult,
  currentProject: Project | undefined,
  ctx?: ProcessCtx
): Project {
  const dashboard = isRecord(result.dashboard) ? (result.dashboard as AnyRecord) : {};
  const nextState = normalizeProjectState(result.project_state_updated);

  // anti-motor-loco: if generating chapter N, treat response as patch of that chapter only
  if (ctx?.action === "GENERATE_CHAPTER" && ctx?.chapterNum) {
    const expected = ctx.chapterNum;
    const chs = ensureArray<any>((nextState as any).chapters, []);
    const pickWords = (x: any) => countWordsQuick(ensureString(x?.text, ""));

    let chosen = chs.find((c: any) => Number(c?.chapter_number ?? 0) === expected);
    if (!chosen) {
      chosen = chs
        .filter((c: any) => ensureString(c?.text, "").trim())
        .slice()
        .sort((a: any, b: any) => pickWords(b) - pickWords(a))[0];
    }
    (nextState as any).chapters = chosen ? [{ ...chosen, chapter_number: expected }] : [];
  }

  const mergedState = mergeProjectState((currentProject as any)?.state as any, nextState);
  const stateMaster = buildMasterFromState(mergedState, ensureString(dashboard.book_title, (currentProject as any)?.title)).trim();
  const prevMaster = ensureString((currentProject as any)?.master_document?.text, "").trim();
  const finalMaster = stateMaster || prevMaster;

  const updatedProject: Project = {
    id: ensureString((currentProject as any)?.id, ensureString((mergedState as any).project_id, `proj_${Date.now()}`)),
    title: ensureString(dashboard.book_title, (currentProject as any)?.title || ensureString((mergedState as any).book_title, "Libro sin título")),
    state: mergedState,
    master_document: {
      title: ensureString(dashboard.book_title, ensureString((mergedState as any).book_title, "Documento maestro")),
      text: finalMaster,
      chunks: finalMaster ? [{ index: 1, total: 1, text: finalMaster }] : [],
    } as any,
    dashboard: result.dashboard as any,
    generation_progress: currentProject ? ({ ...(((currentProject as any).generation_progress as AnyRecord) || {}) } as any) : ({} as any),
  } as Project;

  (updatedProject as any).generation_progress = recomputeGenerationProgress(updatedProject);
  return updatedProject;
}

/* ----------------------- DB -> UI mapping ----------------------- */

export function mapDbFullToProject(db: any, sections: any[], masterLatest: any): Project {
  const proposal = sections.find((s: any) => s?.type === "PROPOSAL");
  const intro = sections.find((s: any) => s?.type === "INTRODUCTION");

  const chapters = sections
    .filter((s: any) => s?.type === "CHAPTER")
    .slice()
    .sort((a: any, b: any) => (a?.chapter_number ?? 0) - (b?.chapter_number ?? 0))
    .map((s: any) => ({
      chapter_number: s?.chapter_number ?? 0,
      title: ensureString(s?.title, s?.chapter_number ? `Capítulo ${s.chapter_number}` : "Capítulo"),
      text: ensureString(s?.content, ""),
      status: s?.status === "COMPLETED" ? "COMPLETED" : "PENDING",
      words: countWordsQuick(ensureString(s?.content, "")),
    }));

  const stateInput: AnyRecord = {
    project_id: ensureString(db?.id, ""),
    book_title: ensureString(db?.title, "Libro sin título"),
    book_topic: ensureString(db?.topic, ""),
    audience: ensureString(db?.audience, ""),
    tone_style: ensureString(db?.tone_style, ""),
    outline_12: ensureArray<any>(db?.outline_12, []),
    continuity_pack: (db?.continuity_pack ?? {}) as any,
    proposal: {
      id: "sec_proposal",
      text: ensureString(proposal?.content, ""),
      status: proposal?.status === "COMPLETED" ? "COMPLETED" : "PENDING",
      words: countWordsQuick(ensureString(proposal?.content, "")),
    },
    introduction: {
      id: "sec_introduction",
      text: ensureString(intro?.content, ""),
      status: intro?.status === "COMPLETED" ? "COMPLETED" : "PENDING",
      words: countWordsQuick(ensureString(intro?.content, "")),
    },
    chapters,
  };

  const state = normalizeProjectState(stateInput);
  const masterText =
    ensureString(masterLatest?.content, "").trim() || buildMasterFromState(state, ensureString(db?.title, "")).trim();

  const p: Project = {
    id: ensureString(db?.id, ""),
    title: ensureString(db?.title, "Libro sin título"),
    state,
    dashboard: db?.dossier ?? null,
    master_document: {
      title: ensureString(masterLatest?.title, ensureString(db?.title, "Documento maestro")),
      text: masterText,
      chunks: masterText ? [{ index: 1, total: 1, text: masterText }] : [],
    } as any,
    generation_progress: {} as any,
  } as Project;

  (p as any).generation_progress = recomputeGenerationProgress(p);
  return p;
}
