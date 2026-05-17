// App.supabase.tsx
// ✅ Persistencia 100% en Supabase (sin localStorage para proyectos/libros)
// - Carga/selección de proyectos desde DB
// - Guardado de secciones (propuesta/intro/capítulos) en `sections`
// - Snapshot del master en `master_documents` vía RPC `build_master_text`
// - Single-flight global: solo 1 generación a la vez (incluye proyectos “anteriores”)

import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, ChatMessage, ProjectState } from './types';
import TableOfContents from './components/TableOfContents';
import ChatInterface from './components/ChatInterface';
import BookViewer from './components/BookViewer';
import GenerationDashboard from './components/GenerationDashboard';
import { PenSquareIcon, RocketIcon, BookOpenIcon } from './components/Icons';

// ✅ Supabase repo
import {
  signInMagicLink,
  getSession,
  listProjects,
  createProject,
  getProjectFull,
  upsertSection,
  insertSectionVersion,
  buildMasterServer,
  insertMasterSnapshot,
  // Nota: agrega estas funciones en repo.ts (te dejo el snippet en la respuesta)
  updateProject,
  deleteProject,
} from './src/data/repo';

/**
 * BUILD TAG (sanity check)
 */
const BUILD_TAG = 'App.supabase.tsx v1.1.0 (2026-05-17)';
const GEMINI_MODEL = import.meta.env.VITE_GEMINI_MODEL ?? 'gemini-3-flash-preview';

// Para no reventar tokens/latencia: recortamos el master antes de mandarlo al modelo.
const MAX_MASTER_CHARS_TO_SEND = 35_000;

type GenerationStatus = 'pending' | 'generating' | 'completed' | 'error';
type GenerationProgress = Record<string, GenerationStatus>;

type ComposerTask = {
  action:
    | 'BUILD_FULL_DOSSIER'
    | 'GENERATE_PROPOSAL'
    | 'GENERATE_INTRODUCTION'
    | 'GENERATE_CHAPTER'
    | 'REVISE_SECTION'
    | 'REBUILD_MASTER';
  chapter_number?: number;
  target_length_words?: number;
  active_view?: 'MASTER' | 'DOSSIER' | 'OUTLINE' | 'PROPOSAL' | 'INTRODUCTION' | 'CHAPTER';
};

type EngineResult = {
  ok: boolean;
  dashboard?: unknown;
  project_state_updated?: unknown;
  master_document?: unknown;
  needs_input?: { message?: string };
};

type AnyRecord = Record<string, unknown>;

const initialWelcomeMessage: ChatMessage = {
  id: 'welcome-0',
  role: 'model',
  content:
    '¡Bienvenido! Soy **BOOK_DOSSIER_CANVAS_ENGINE**. Para empezar, cuéntame de qué quieres que trate tu libro o simplemente dime un título para generar el expediente completo.',
};

/* ----------------------------- tiny helpers ----------------------------- */

function isRecord(v: unknown): v is AnyRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function ensureArray<T>(v: unknown, fallback: T[] = []): T[] {
  return Array.isArray(v) ? (v as T[]) : fallback;
}

function ensureString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function normalizeError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (isRecord(e) && 'message' in e) return String((e as AnyRecord).message);
  return 'Error desconocido';
}

/* ----------------------------- engine parse ----------------------------- */

function safeJsonParse(text: string): unknown {
  const t = (text ?? '').trim();
  if (!t) throw new Error('Respuesta vacía.');
  try {
    return JSON.parse(t);
  } catch {
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(t.slice(first, last + 1));
    throw new Error('No se pudo parsear JSON.');
  }
}

function validateEngineResult(raw: unknown): EngineResult {
  if (!isRecord(raw)) throw new Error('Respuesta no es JSON object.');
  if ((raw as AnyRecord).ok !== true) {
    const needs = (raw as AnyRecord).needs_input;
    const msg = isRecord(needs) ? ensureString(needs.message, '') : '';
    throw new Error(msg || 'Error del motor editorial.');
  }
  if (!('project_state_updated' in raw)) throw new Error('Respuesta inválida: falta project_state_updated.');
  if (!('master_document' in raw)) throw new Error('Respuesta inválida: falta master_document.');
  if (!('dashboard' in raw)) throw new Error('Respuesta inválida: falta dashboard.');
  return raw as EngineResult;
}

/* ------------------- word count + placeholder detection ------------------- */

const WORD_RE = /\S+/g;
function countWordsQuick(text: string): number {
  const t = (text ?? '').trim();
  if (!t) return 0;
  const m = t.match(WORD_RE);
  return m ? m.length : 0;
}

function isPlaceholderText(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  const compact = t.replace(/\s+/g, '');
  if (compact === '...' || compact === '…') return true;
  const dots = (t.match(/\.\.\./g) ?? []).length;
  const wc = countWordsQuick(t);
  if (dots >= 2 && wc < 120) return true;
  if (wc > 0 && wc < 40 && /\.\.\.|…/.test(t)) return true;
  return false;
}

function chapterIsComplete(chText: string, targetWords?: number): boolean {
  const wc = countWordsQuick(chText);
  if (!wc) return false;
  if (isPlaceholderText(chText)) return false;
  const target = typeof targetWords === 'number' && Number.isFinite(targetWords) ? targetWords : 0;
  const minWords = target > 0 ? Math.max(250, Math.floor(target * 0.4)) : 250;
  return wc >= minWords;
}

/* ----------------------- progress computed from text ----------------------- */

function recomputeGenerationProgress(project: Project): GenerationProgress {
  const prev = ((project as any).generation_progress as AnyRecord) || {};
  const progress: GenerationProgress = { ...(prev as GenerationProgress) };
  const st = ((project as any).state as AnyRecord) || {};

  const proposalText = ensureString((st as any).proposal?.text, '');
  const introText = ensureString((st as any).introduction?.text, '');

  const proposalDone =
    (ensureString((st as any).proposal?.status, '') === 'COMPLETED' || countWordsQuick(proposalText) >= 200) &&
    !isPlaceholderText(proposalText);

  const introDone =
    (ensureString((st as any).introduction?.status, '') === 'COMPLETED' || countWordsQuick(introText) >= 200) &&
    !isPlaceholderText(introText);

  if (progress.proposal !== 'generating') progress.proposal = proposalDone ? 'completed' : 'pending';
  if (progress.intro !== 'generating') progress.intro = introDone ? 'completed' : 'pending';

  const outline = ensureArray<any>((st as any).outline_12, []);
  const chapters = ensureArray<any>((st as any).chapters, []);

  const byNum = new Map<number, any>();
  for (const c of chapters) {
    const cn = Number(c?.chapter_number ?? c?.chapterNumber ?? 0) || 0;
    if (cn > 0) byNum.set(cn, c);
  }

  for (const o of outline) {
    const n = Number(o?.chapter_number ?? 0) || 0;
    if (!n) continue;
    const id = `chap-${n}`;
    if (progress[id] === 'generating') continue;
    const ch = byNum.get(n);
    const text = ensureString(ch?.text, '');
    progress[id] = chapterIsComplete(text, o?.target_words) ? 'completed' : 'pending';
  }

  return progress;
}

/* -------------------------- master doc reconstruction -------------------------- */

function buildMasterFromState(state: ProjectState, title?: string): string {
  const parts: string[] = [];
  const bookTitle = (title || (state as any).book_title || 'Documento maestro').trim();
  parts.push(`# ${bookTitle}\n`);

  const proposalText = ensureString((state as any).proposal?.text, '').trim();
  if (proposalText) parts.push(`## Propuesta editorial\n\n${proposalText}`);

  const introText = ensureString((state as any).introduction?.text, '').trim();
  if (introText) parts.push(`## Introducción\n\n${introText}`);

  const chapters = ensureArray<any>((state as any).chapters, [])
    .slice()
    .sort((a, b) => (Number(a?.chapter_number ?? 0) || 0) - (Number(b?.chapter_number ?? 0) || 0));

  for (const ch of chapters) {
    const t = ensureString(ch?.text, '').trim();
    if (!t) continue;
    const n = ch?.chapter_number ?? '';
    const chTitle = ensureString(ch?.title, n ? `Capítulo ${n}` : 'Capítulo').trim();
    parts.push(`## ${chTitle}\n\n${t}`);
  }

  return parts.join('\n\n---\n\n').trim() + '\n';
}

/* -------------------------- normalize / merge state -------------------------- */

function normalizeProjectState(input: unknown): ProjectState {
  const state: AnyRecord = isRecord(input) ? { ...(input as AnyRecord) } : {};

  const proposal = isRecord((state as any).proposal) ? { ...((state as any).proposal as AnyRecord) } : {};
  (proposal as any).id = ensureString((proposal as any).id, 'sec_proposal');
  (proposal as any).text = ensureString((proposal as any).text, '');
  (proposal as any).status = (proposal as any).status === 'COMPLETED' ? 'COMPLETED' : 'PENDING';
  (proposal as any).words = typeof (proposal as any).words === 'number' ? (proposal as any).words : 0;
  (state as any).proposal = proposal;

  const introduction = isRecord((state as any).introduction)
    ? { ...((state as any).introduction as AnyRecord) }
    : {};
  (introduction as any).id = ensureString((introduction as any).id, 'sec_introduction');
  (introduction as any).text = ensureString((introduction as any).text, '');
  (introduction as any).status = (introduction as any).status === 'COMPLETED' ? 'COMPLETED' : 'PENDING';
  (introduction as any).words = typeof (introduction as any).words === 'number' ? (introduction as any).words : 0;
  (state as any).introduction = introduction;

  (state as any).outline_12 = ensureArray<any>((state as any).outline_12, []).map((o: any, idx: number) => {
    const chapterNum = typeof o?.chapter_number === 'number' ? o.chapter_number : idx + 1;
    const normalized: AnyRecord = isRecord(o) ? { ...(o as AnyRecord) } : {};
    (normalized as any).id = ensureString((normalized as any).id, `outline_${String(chapterNum).padStart(2, '0')}`);
    (normalized as any).chapter_number = chapterNum;
    (normalized as any).chapter_title = ensureString(
      (normalized as any).chapter_title,
      ensureString((normalized as any).title, `Capítulo ${chapterNum}`)
    );
    (normalized as any).status =
      (normalized as any).status === 'COMPLETED' || (normalized as any).status === 'DRAFTED'
        ? (normalized as any).status
        : 'PENDING';
    (normalized as any).target_words = typeof (normalized as any).target_words === 'number' ? (normalized as any).target_words : 0;
    return normalized;
  });

  (state as any).chapters = ensureArray<any>((state as any).chapters, []).map((c: any, idx: number) => {
    const cn = Number(c?.chapter_number ?? c?.chapterNumber ?? idx + 1) || (idx + 1);
    const normalized: AnyRecord = isRecord(c) ? { ...(c as AnyRecord) } : {};
    (normalized as any).chapter_number = cn;
    (normalized as any).id = ensureString((normalized as any).id, `sec_chapter_${String(cn).padStart(2, '0')}`);
    (normalized as any).title = ensureString((normalized as any).title, `Capítulo ${cn}`).trim();
    (normalized as any).text = ensureString((normalized as any).text, '');
    (normalized as any).status = (normalized as any).status === 'COMPLETED' ? 'COMPLETED' : 'PENDING';
    (normalized as any).words = typeof (normalized as any).words === 'number' ? (normalized as any).words : 0;
    return normalized;
  });

  const continuity = isRecord((state as any).continuity_pack) ? { ...((state as any).continuity_pack as AnyRecord) } : {};
  (continuity as any).style_guide = ensureString((continuity as any).style_guide, '');
  (continuity as any).canon = ensureString((continuity as any).canon, '');
  (continuity as any).outline_progress = ensureString((continuity as any).outline_progress, '');
  (continuity as any).open_loops = ensureArray((continuity as any).open_loops, []);
  (continuity as any).chapter_summaries = ensureArray((continuity as any).chapter_summaries, []);
  (continuity as any).next_chapter_plan = ensureArray((continuity as any).next_chapter_plan, []);
  (state as any).continuity_pack = continuity;

  (state as any).project_id = ensureString((state as any).project_id, ensureString((state as any).projectId, `proj_${Date.now()}`));
  (state as any).book_title = ensureString((state as any).book_title, ensureString((state as any).bookTitle, 'Libro sin título'));
  (state as any).book_topic = ensureString((state as any).book_topic, ensureString((state as any).bookTopic, ''));
  (state as any).audience = ensureString((state as any).audience, '');
  (state as any).tone_style = ensureString((state as any).tone_style, '');

  return state as unknown as ProjectState;
}

function shouldPreservePrevText(prevText: string, nextText: string): boolean {
  const prev = (prevText ?? '').trim();
  const next = (nextText ?? '').trim();
  if (!prev) return false;
  if (!next) return true;
  if (isPlaceholderText(next)) return true;
  if (next.length < Math.max(160, Math.floor(prev.length * 0.7))) return true;
  const prevW = countWordsQuick(prev);
  const nextW = countWordsQuick(next);
  if (prevW >= 220 && nextW < Math.max(80, Math.floor(prevW * 0.6))) return true;
  return false;
}

function mergeProjectState(prev: ProjectState | undefined, next: ProjectState): ProjectState {
  if (!prev) return next;

  const merged: AnyRecord = { ...(prev as any), ...(next as any) };

  merged.proposal = { ...(prev as any).proposal, ...(next as any).proposal };
  if (!ensureString((merged.proposal as any)?.text, '').trim() && ensureString((prev as any).proposal?.text, '').trim()) {
    merged.proposal = { ...(prev as any).proposal };
  }

  merged.introduction = { ...(prev as any).introduction, ...(next as any).introduction };
  if (
    !ensureString((merged.introduction as any)?.text, '').trim() &&
    ensureString((prev as any).introduction?.text, '').trim()
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
    const prevText = ensureString(existing?.text, '');
    const nextText = ensureString(c?.text, '');
    const mergedC = { ...(existing || {}), ...c, chapter_number: cn };
    if (existing && shouldPreservePrevText(prevText, nextText)) {
      mergedC.text = existing.text;
      mergedC.status = existing.status;
      mergedC.words = existing.words;
    }
    byNum.set(cn, mergedC);
  }

  merged.chapters = Array.from(byNum.values()).sort((a, b) => (a.chapter_number ?? 0) - (b.chapter_number ?? 0));

  merged.continuity_pack = { ...(prev as any).continuity_pack, ...(next as any).continuity_pack };
  for (const k of ['style_guide', 'canon', 'outline_progress'] as const) {
    if (
      !ensureString((merged.continuity_pack as any)?.[k], '').trim() &&
      ensureString((prev as any).continuity_pack?.[k], '').trim()
    ) {
      (merged.continuity_pack as any)[k] = (prev as any).continuity_pack[k];
    }
  }

  return merged as unknown as ProjectState;
}

/* ----------------------- composer state compaction ----------------------- */

function clipText(s: string, maxChars: number): string {
  const t = (s ?? '').trim();
  if (!t) return '';
  if (t.length <= maxChars) return t;
  return `[[CLIPPED ${t.length - maxChars} chars]]\n` + t.slice(t.length - maxChars);
}

function compactStateForComposer(project: Project): AnyRecord {
  const st = ((project as any).state as AnyRecord) ?? {};
  const dash = ((project as any).dashboard as AnyRecord) ?? {};
  const md = ((project as any).master_document as AnyRecord) ?? {};

  return {
    ...st,
    dashboard: dash,
    master_document: {
      title: ensureString((md as any).title, ''),
      text: clipText(ensureString((md as any).text, ''), MAX_MASTER_CHARS_TO_SEND),
    },
  };
}

/* ----------------------- Supabase <-> UI mapping ----------------------- */

function mapDbFullToProject(db: any, sections: any[], masterLatest: any): Project {
  const proposal = sections.find((s: any) => s?.type === 'PROPOSAL');
  const intro = sections.find((s: any) => s?.type === 'INTRODUCTION');
  const chapters = sections
    .filter((s: any) => s?.type === 'CHAPTER')
    .slice()
    .sort((a: any, b: any) => (a?.chapter_number ?? 0) - (b?.chapter_number ?? 0))
    .map((s: any) => ({
      chapter_number: s?.chapter_number ?? 0,
      title: ensureString(s?.title, s?.chapter_number ? `Capítulo ${s.chapter_number}` : 'Capítulo'),
      text: ensureString(s?.content, ''),
      status: s?.status === 'COMPLETED' ? 'COMPLETED' : 'PENDING',
      words: countWordsQuick(ensureString(s?.content, '')),
    }));

  const stateInput: AnyRecord = {
    project_id: ensureString(db?.id, ''),
    book_title: ensureString(db?.title, 'Libro sin título'),
    book_topic: ensureString(db?.topic, ''),
    audience: ensureString(db?.audience, ''),
    tone_style: ensureString(db?.tone_style, ''),
    outline_12: ensureArray<any>(db?.outline_12, []),
    continuity_pack: (db?.continuity_pack ?? {}) as any,
    proposal: {
      id: 'sec_proposal',
      text: ensureString(proposal?.content, ''),
      status: proposal?.status === 'COMPLETED' ? 'COMPLETED' : 'PENDING',
      words: countWordsQuick(ensureString(proposal?.content, '')),
    },
    introduction: {
      id: 'sec_introduction',
      text: ensureString(intro?.content, ''),
      status: intro?.status === 'COMPLETED' ? 'COMPLETED' : 'PENDING',
      words: countWordsQuick(ensureString(intro?.content, '')),
    },
    chapters,
  };

  const state = normalizeProjectState(stateInput);
  const masterText = ensureString(masterLatest?.content, '').trim() || buildMasterFromState(state, ensureString(db?.title, '')).trim();

  const p: Project = {
    id: ensureString(db?.id, ''),
    title: ensureString(db?.title, 'Libro sin título'),
    state,
    dashboard: db?.dossier ?? null,
    master_document: {
      title: ensureString(masterLatest?.title, ensureString(db?.title, 'Documento maestro')),
      text: masterText,
      chunks: masterText ? [{ index: 1, total: 1, text: masterText }] : [],
    } as any,
    generation_progress: {} as any,
  } as Project;

  (p as any).generation_progress = recomputeGenerationProgress(p);
  return p;
}

/* ----------------------------------- App ----------------------------------- */

const App: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([initialWelcomeMessage]);
  const [isLoading, setIsLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'plan' | 'book'>('plan');
  const [error, setError] = useState<string | null>(null);

  // auth
  const [session, setSession] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  // Ref sync: evita closures viejas
  const projectsRef = useRef<Project[]>(projects);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  // Single-flight global: solo 1 generación a la vez
  const globalGenLockRef = useRef(false);
  const requestSeqRef = useRef<Record<string, number>>({});
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );

  const updateProjectById = useCallback((projectId: string, updater: (p: Project) => Project) => {
    const run = () => setProjects((prev) => prev.map((p) => (p.id === projectId ? updater(p) : p)));
    if (typeof startTransition === 'function') startTransition(run);
    else run();
  }, []);

  const setSectionProgress = useCallback(
    (projectId: string, sectionId: string, status: GenerationStatus) => {
      updateProjectById(projectId, (p) => ({
        ...p,
        generation_progress: { ...(((p as any).generation_progress as AnyRecord) || {}), [sectionId]: status } as any,
      }));
    },
    [updateProjectById]
  );

  const anyGenerating = useMemo(() => {
    for (const p of projects) {
      const gp = (p as any).generation_progress || {};
      if (Object.values(gp).some((v) => v === 'generating')) return true;
    }
    return false;
  }, [projects]);

  /* --------------------------- Supabase loading --------------------------- */

  const hydrateProject = useCallback(async (projectId: string) => {
    const { project, sections, masterLatest } = await getProjectFull(projectId);
    const full = mapDbFullToProject(project, sections, masterLatest);
    setProjects((prev) => {
      const has = prev.some((p) => p.id === projectId);
      if (!has) return [full, ...prev];
      return prev.map((p) => (p.id === projectId ? full : p));
    });
    return full;
  }, []);

  const refreshList = useCallback(async () => {
    const list = await listProjects();
    // mantenemos objetos existentes si ya están hidratados
    setProjects((prev) => {
      const prevById = new Map(prev.map((p) => [p.id, p]));
      const next: Project[] = [];
      for (const row of list) {
        const existing = prevById.get(row.id);
        if (existing) next.push(existing);
        else {
          // stub mínimo
          next.push({
            id: row.id,
            title: row.title,
            state: normalizeProjectState({ project_id: row.id, book_title: row.title, book_topic: row.topic ?? '', outline_12: [] }),
            master_document: { title: row.title, text: '', chunks: [] } as any,
            dashboard: null,
            generation_progress: {} as any,
          } as any);
        }
      }
      return next;
    });
  }, []);

  // ✅ Auto-selección SOLO una vez por sesión (evita que “Crear nuevo” te rebote al primer proyecto).
  const didAutoSelectRef = useRef(false);
  const sessionUserId = session?.user?.id ?? null;

  useEffect(() => {
    // reset cuando cambia el usuario (login/logout)
    didAutoSelectRef.current = false;
  }, [sessionUserId]);

  useEffect(() => {
    if (!session) return;
    if (didAutoSelectRef.current) return;

    // si ya hay uno seleccionado, marcamos y salimos
    if (activeProjectId) {
      didAutoSelectRef.current = true;
      return;
    }

    // si tenemos lista, seleccionamos el primero UNA sola vez
    if (projects.length > 0) {
      didAutoSelectRef.current = true;
      setActiveProjectId(projects[0].id);
    }
  }, [session, projects, activeProjectId]);



  useEffect(() => {
    (async () => {
      try {
        const s = await getSession();
        setSession(s);
        if (s) {
          await refreshList();
        }
      } catch (e) {
        setError(normalizeError(e));
      }
    })();
  }, [refreshList]);

  // Auto-hidratación cuando seleccionas proyecto
  useEffect(() => {
    if (!session || !activeProjectId) return;
    const p = projects.find((x) => x.id === activeProjectId);
    // si no tiene outline/chapters/master, hidratamos
    const st: any = (p as any)?.state ?? {};
    const maybeEmpty = !p || (!ensureArray(st?.chapters, []).length && !ensureString((p as any)?.master_document?.text, '').trim());
    if (maybeEmpty) {
      hydrateProject(activeProjectId).catch((e) => setError(normalizeError(e)));
    }
  }, [activeProjectId, hydrateProject, projects, session]);

  /* --------------------------- Supabase persistence --------------------------- */

  const persistProjectMeta = useCallback(async (proj: Project) => {
    const st: any = proj.state ?? {};
    await updateProject(proj.id, {
      title: proj.title,
      topic: st.book_topic ?? null,
      audience: st.audience ?? null,
      tone_style: st.tone_style ?? null,
      dossier: (proj as any).dashboard ?? (st.dossier ?? {}) ?? {},
      outline_12: st.outline_12 ?? [],
      continuity_pack: st.continuity_pack ?? {},
    });
  }, []);

  const upsertOneSectionFromState = useCallback(async (proj: Project, kind: 'proposal' | 'intro' | 'chapter', chapterNum?: number) => {
    const st: any = proj.state ?? {};
    if (kind === 'proposal') {
      const text = ensureString(st?.proposal?.text, '');
      const sid = await upsertSection({
        project_id: proj.id,
        type: 'PROPOSAL',
        chapter_number: null,
        title: 'Propuesta editorial',
        content: text,
        status: ensureString(st?.proposal?.status, 'PENDING') === 'COMPLETED' ? 'COMPLETED' : 'PENDING',
      });
      await insertSectionVersion(sid, text);
      return;
    }

    if (kind === 'intro') {
      const text = ensureString(st?.introduction?.text, '');
      const sid = await upsertSection({
        project_id: proj.id,
        type: 'INTRODUCTION',
        chapter_number: null,
        title: 'Introducción',
        content: text,
        status: ensureString(st?.introduction?.status, 'PENDING') === 'COMPLETED' ? 'COMPLETED' : 'PENDING',
      });
      await insertSectionVersion(sid, text);
      return;
    }

    const n = Number(chapterNum ?? 0) || 0;
    if (!n) return;
    const ch = ensureArray<any>(st?.chapters, []).find((c: any) => Number(c?.chapter_number ?? 0) === n);
    const title = ensureString(ch?.title, `Capítulo ${n}`);
    const text = ensureString(ch?.text, '');
    const sid = await upsertSection({
      project_id: proj.id,
      type: 'CHAPTER',
      chapter_number: n,
      title,
      content: text,
      status: ensureString(ch?.status, 'PENDING') === 'COMPLETED' ? 'COMPLETED' : 'PENDING',
    });
    await insertSectionVersion(sid, text);
  }, []);

  const rebuildAndSnapshotMaster = useCallback(async (proj: Project) => {
    const masterText = await buildMasterServer(proj.id);
    await insertMasterSnapshot(proj.id, proj.title, masterText);
    return masterText;
  }, []);

  /* ------------------------------ composer calls ------------------------------ */

  
const callComposer = useCallback(async (task: ComposerTask, state: AnyRecord): Promise<EngineResult> => {
  // ✅ Gemini corre en backend (Vercel Function /api/composer). La API Key vive allí como GEMINI_API_KEY (privada).
  const r = await fetch('/api/composer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task,
      state,
      model: GEMINI_MODEL,
    }),
  });

  const raw = await r.text();

  let data: any;
  try {
    data = safeJsonParse(raw);
  } catch {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { ok: false, error: raw || `HTTP ${r.status}` };
    }
  }

  if (!r.ok) {
    const msg =
      ensureString(data?.error?.message, '') ||
      ensureString(data?.error, '') ||
      ensureString(data?.message, '') ||
      `Error HTTP ${r.status}`;
    // Mensaje más útil para rate limits
    if (r.status === 429) throw new Error(`Rate limit / cuota: ${msg}`);
    throw new Error(msg);
  }

  return validateEngineResult(data);
}, []);

const processResponse = useCallback(
    (result: EngineResult, currentProject?: Project, ctx?: { action?: string; chapterNum?: number }): Project => {
      const dashboard = isRecord(result.dashboard) ? (result.dashboard as AnyRecord) : {};
      const nextState = normalizeProjectState(result.project_state_updated);

      // 🔒 anti-motor-loco: si generas capítulo N, tratamos respuesta como patch solo de ese capítulo
      if (ctx?.action === 'GENERATE_CHAPTER' && ctx?.chapterNum) {
        const expected = ctx.chapterNum;
        const chs = ensureArray<any>((nextState as any).chapters, []);
        const pickWords = (x: any) => countWordsQuick(ensureString(x?.text, ''));
        let chosen = chs.find((c: any) => Number(c?.chapter_number ?? 0) === expected);
        if (!chosen) {
          chosen = chs
            .filter((c: any) => ensureString(c?.text, '').trim())
            .slice()
            .sort((a: any, b: any) => pickWords(b) - pickWords(a))[0];
        }
        if (chosen) {
          (chosen as any).chapter_number = expected;
          (chosen as any).title = ensureString((chosen as any).title, `Capítulo ${expected}`);
          (nextState as any).chapters = [chosen];
        } else {
          (nextState as any).chapters = [];
        }
      }

      const mergedState = mergeProjectState(currentProject?.state as any, nextState);
      const stateMaster = buildMasterFromState(mergedState, ensureString(dashboard.book_title, currentProject?.title)).trim();
      const prevMaster = ensureString((currentProject as any)?.master_document?.text, '').trim();
      const finalMaster = stateMaster || prevMaster;

      const updatedProject: Project = {
        id: ensureString((currentProject as any)?.id, ensureString((mergedState as any).project_id, `proj_${Date.now()}`)),
        title: ensureString(dashboard.book_title, currentProject?.title || ensureString((mergedState as any).book_title, 'Libro sin título')),
        state: mergedState,
        master_document: {
          title: ensureString(dashboard.book_title, ensureString((mergedState as any).book_title, 'Documento maestro')),
          text: finalMaster,
          chunks: finalMaster ? [{ index: 1, total: 1, text: finalMaster }] : [],
        } as any,
        dashboard: result.dashboard as any,
        generation_progress: currentProject ? ({ ...(((currentProject as any).generation_progress as AnyRecord) || {}) } as any) : ({} as any),
      } as Project;

      (updatedProject as any).generation_progress = recomputeGenerationProgress(updatedProject);
      return updatedProject;
    },
    []
  );

  /* ------------------------------ UI handlers ------------------------------ */

  const handleAuth = useCallback(async () => {
    setError(null);
    setAuthNotice(null);
    try {
      const e = email.trim();
      if (!e) throw new Error('Escribe tu email.');
      await signInMagicLink(e);
      setAuthNotice('Listo: revisa tu correo (magic link). Cuando entres, recarga la página.');
    } catch (e) {
      setError(normalizeError(e));
    }
  }, [email]);

  const handleSelectProject = useCallback(
    async (id: string) => {
      setActiveProjectId(id);
      setViewMode('plan');
      setError(null);
      try {
        await hydrateProject(id);
      } catch (e) {
        setError(normalizeError(e));
      }
    },
    [hydrateProject]
  );

  const handleDeleteProject = useCallback(async (id: string) => {
    setError(null);
    try {
      await deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
      if (activeProjectId === id) {
        const next = projectsRef.current.filter((p) => p.id !== id);
        setActiveProjectId(next[0]?.id ?? null);
      }
    } catch (e) {
      setError(normalizeError(e));
    }
  }, [activeProjectId]);

  const handleStartNewBook = useCallback(
    async (idea: string) => {
      setIsLoading(true);
      setError(null);

      try {
        const title = idea.length < 70 ? idea.trim() : 'Libro sin título';
        const dbProject = await createProject({ title, topic: idea });

        // Genera dossier/outline con project_id real de Supabase
        const task: ComposerTask = { action: 'BUILD_FULL_DOSSIER', target_length_words: 1500, active_view: 'DOSSIER' };
        const seedState: Partial<ProjectState> = {
          project_id: dbProject.id,
          book_title: dbProject.title,
          book_topic: idea,
          outline_12: [],
        };

        const result = await callComposer(task, seedState as AnyRecord);

        // Procesa a estado UI
        const baseStub: Project = {
          id: dbProject.id,
          title: dbProject.title,
          state: normalizeProjectState(seedState as AnyRecord),
          master_document: { title: dbProject.title, text: '', chunks: [] } as any,
          dashboard: null,
          generation_progress: {} as any,
        } as any;

        const updated = processResponse(result, baseStub);

        // Persistimos: meta + secciones + master
        await persistProjectMeta(updated);
        await upsertOneSectionFromState(updated, 'proposal');
        await upsertOneSectionFromState(updated, 'intro');

        // Si el engine ya metió capítulos (a veces), los persistimos
        const chs = ensureArray<any>((updated.state as any).chapters, []);
        for (const c of chs) {
          const n = Number(c?.chapter_number ?? 0) || 0;
          if (n) await upsertOneSectionFromState(updated, 'chapter', n);
        }

        const masterText = await rebuildAndSnapshotMaster(updated);
        const updatedWithMaster = {
          ...updated,
          master_document: { ...(updated as any).master_document, text: masterText, chunks: [{ index: 1, total: 1, text: masterText }] },
        } as Project;
        (updatedWithMaster as any).generation_progress = recomputeGenerationProgress(updatedWithMaster);

        setProjects((prev) => [updatedWithMaster, ...prev.filter((p) => p.id !== updatedWithMaster.id)]);
        setActiveProjectId(updatedWithMaster.id);
        setViewMode('plan');

        const now = Date.now();
        setMessages((prev) => [
          ...prev,
          { id: `user-${now}`, role: 'user', content: idea },
          {
            id: `ai-${now + 1}`,
            role: 'model',
            content: `Expediente generado para **${updatedWithMaster.title}**. ¿Generamos propuesta, introducción o capítulo 1?`,
          },
        ]);
      } catch (e) {
        setError(normalizeError(e));
      } finally {
        setIsLoading(false);
      }
    },
    [callComposer, persistProjectMeta, processResponse, rebuildAndSnapshotMaster, upsertOneSectionFromState]
  );

  const handleGenerateSection = useCallback(
    async (action: string, chapterNum?: number) => {
      const proj = projectsRef.current.find((p) => p.id === activeProjectId);
      if (!proj) return false;

      setError(null);

      // Single-flight global
      if (globalGenLockRef.current || anyGenerating) {
        setError('Ya hay una generación en curso. Termina esa y luego lanzas otra.');
        return false;
      }
      globalGenLockRef.current = true;

      const sectionId =
        action === 'GENERATE_INTRODUCTION'
          ? 'intro'
          : action === 'GENERATE_PROPOSAL'
            ? 'proposal'
            : `chap-${chapterNum}`;

      setSectionProgress(proj.id, sectionId, 'generating');

      const seq = (requestSeqRef.current[proj.id] ?? 0) + 1;
      requestSeqRef.current[proj.id] = seq;

      try {
        const task: ComposerTask = {
          action: action as ComposerTask['action'],
          chapter_number: chapterNum,
          target_length_words: action === 'GENERATE_CHAPTER' ? 1800 : 1200,
          active_view: action === 'GENERATE_PROPOSAL' ? 'PROPOSAL' : action === 'GENERATE_INTRODUCTION' ? 'INTRODUCTION' : 'CHAPTER',
        };

        const stateForComposer = compactStateForComposer(proj);
        const result = await callComposer(task, stateForComposer);

        // out-of-order guard
        if ((requestSeqRef.current[proj.id] ?? 0) !== seq) return false;

        const updatedProj = processResponse(result, proj, { action, chapterNum });

        // Persistimos patch (meta + sección afectada) + master
        await persistProjectMeta(updatedProj);
        if (action === 'GENERATE_PROPOSAL') await upsertOneSectionFromState(updatedProj, 'proposal');
        if (action === 'GENERATE_INTRODUCTION') await upsertOneSectionFromState(updatedProj, 'intro');
        if (action === 'GENERATE_CHAPTER') await upsertOneSectionFromState(updatedProj, 'chapter', chapterNum);

        const masterText = await rebuildAndSnapshotMaster(updatedProj);
        const updatedWithMaster = {
          ...updatedProj,
          master_document: { ...(updatedProj as any).master_document, text: masterText, chunks: [{ index: 1, total: 1, text: masterText }] },
        } as Project;

        updateProjectById(proj.id, () => updatedWithMaster);

        setSectionProgress(proj.id, sectionId, 'completed');
        return true;
      } catch (e) {
        if ((requestSeqRef.current[proj.id] ?? 0) !== seq) return false;
        setError(`Error: ${normalizeError(e)}`);
        setSectionProgress(proj.id, sectionId, 'error');
        return false;
      } finally {
        globalGenLockRef.current = false;
      }
    },
    [activeProjectId, anyGenerating, callComposer, persistProjectMeta, processResponse, rebuildAndSnapshotMaster, setSectionProgress, updateProjectById, upsertOneSectionFromState]
  );

  const handleGenerateRemaining = useCallback(async () => {
    if (globalGenLockRef.current || anyGenerating) return;
    globalGenLockRef.current = true;

    setIsLoading(true);
    setError(null);

    try {
      const getFresh = () => projectsRef.current.find((p) => p.id === activeProjectId);
      let current = getFresh();
      if (!current) return;

      const st1: any = current.state as any;
      if ((st1 as any).proposal?.status !== 'COMPLETED') {
        const ok = await handleGenerateSection('GENERATE_PROPOSAL');
        if (!ok) return;
      }

      current = getFresh();
      if (!current) return;

      const st2: any = current.state as any;
      if ((st2 as any).introduction?.status !== 'COMPLETED') {
        const ok = await handleGenerateSection('GENERATE_INTRODUCTION');
        if (!ok) return;
      }

      current = getFresh();
      if (!current) return;

      const st3: any = current.state as any;
      for (const item of ensureArray<any>((st3 as any).outline_12, [])) {
        const key = `chap-${item.chapter_number}`;
        const status = (((current as any).generation_progress || {})[key] as GenerationStatus | undefined);
        if (status === 'generating') break;
        // si está completed, igual permitimos “regenerar” manual, pero aquí skippeamos
        if (status === 'completed') continue;
        const ok = await handleGenerateSection('GENERATE_CHAPTER', item.chapter_number);
        if (!ok) break;
        current = getFresh();
        if (!current) break;
      }
    } finally {
      setIsLoading(false);
      globalGenLockRef.current = false;
    }
  }, [activeProjectId, anyGenerating, handleGenerateSection]);

  const handleEditSection = useCallback(
    async (payload: any) => {
      const proj = projectsRef.current.find((p) => p.id === activeProjectId);
      if (!proj) return;
      setError(null);
      try {
        // 1) Update state local
        const next = (() => {
          const st: any = proj.state ?? {};
          const draft = JSON.parse(JSON.stringify(st));

          if (payload.kind === 'proposal') {
            draft.proposal = { ...(draft.proposal ?? {}), text: payload.text, status: 'COMPLETED' };
          } else if (payload.kind === 'intro') {
            draft.introduction = { ...(draft.introduction ?? {}), text: payload.text, status: 'COMPLETED' };
          } else if (payload.kind === 'chapter') {
            const n = Number(payload.chapterNumber ?? 0) || 0;
            const chs = ensureArray<any>(draft.chapters, []);
            const idx = chs.findIndex((c: any) => Number(c?.chapter_number ?? 0) === n);
            const base = idx >= 0 ? chs[idx] : { chapter_number: n };
            const updated = {
              ...base,
              chapter_number: n,
              title: ensureString(payload.title, ensureString(base?.title, `Capítulo ${n}`)),
              text: payload.text,
              status: 'COMPLETED',
            };
            if (idx >= 0) chs[idx] = updated;
            else chs.push(updated);
            draft.chapters = chs;
          }

          const merged = normalizeProjectState(draft);
          const masterLocal = buildMasterFromState(merged, proj.title);
          const out: Project = {
            ...proj,
            state: merged,
            master_document: { ...(proj as any).master_document, text: masterLocal, chunks: [{ index: 1, total: 1, text: masterLocal }] },
          } as any;
          (out as any).generation_progress = recomputeGenerationProgress(out);
          return out;
        })();

        updateProjectById(proj.id, () => next);

        // 2) Persist section
        if (payload.kind === 'proposal') await upsertOneSectionFromState(next, 'proposal');
        if (payload.kind === 'intro') await upsertOneSectionFromState(next, 'intro');
        if (payload.kind === 'chapter') await upsertOneSectionFromState(next, 'chapter', payload.chapterNumber);

        // 3) Rebuild master + snapshot
        const masterText = await rebuildAndSnapshotMaster(next);
        updateProjectById(proj.id, (p) => ({
          ...p,
          master_document: { ...(p as any).master_document, text: masterText, chunks: [{ index: 1, total: 1, text: masterText }] },
        }) as any);
      } catch (e) {
        setError(normalizeError(e));
      }
    },
    [activeProjectId, rebuildAndSnapshotMaster, updateProjectById, upsertOneSectionFromState]
  );

  const handleSaveSnapshot = useCallback(async () => {
    const proj = projectsRef.current.find((p) => p.id === activeProjectId);
    if (!proj) return;
    setError(null);
    try {
      const masterText = await rebuildAndSnapshotMaster(proj);
      updateProjectById(proj.id, (p) => ({
        ...p,
        master_document: { ...(p as any).master_document, text: masterText, chunks: [{ index: 1, total: 1, text: masterText }] },
      }) as any);
    } catch (e) {
      setError(normalizeError(e));
    }
  }, [activeProjectId, rebuildAndSnapshotMaster, updateProjectById]);

  /* ----------------------------------- UI ----------------------------------- */

  if (!session) {
    return (
      <div className="min-h-screen w-full bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <div className="flex items-center gap-3">
            <PenSquareIcon className="w-8 h-8 text-indigo-400" />
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-tight text-white truncate">BestSeller AI</h1>
              <div className="text-[10px] text-slate-500 font-mono truncate">{BUILD_TAG}</div>
            </div>
          </div>

          <div className="mt-6 space-y-3">
            <div className="text-sm text-slate-300">
              Para guardar todo en Supabase necesitas iniciar sesión. Te mando un magic link.
            </div>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@email.com"
              className="w-full bg-slate-950/60 border border-slate-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            />
            <button
              onClick={handleAuth}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-xl font-black text-xs uppercase tracking-widest transition-colors"
            >
              Enviar Magic Link
            </button>
            {authNotice && <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded p-3">{authNotice}</div>}
            {error && <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded p-3">{error}</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full bg-slate-950 text-slate-100">
      <div className="flex h-full min-h-0 font-sans">
        <aside className="w-1/4 min-w-[280px] h-full bg-slate-900 border-r border-slate-800 flex flex-col">
          <div className="p-4 border-b border-slate-800">
            <div className="flex items-center gap-3">
              <PenSquareIcon className="w-8 h-8 text-indigo-400" />
              <div className="min-w-0">
                <h1 className="text-xl font-bold tracking-tight text-white truncate">BestSeller AI</h1>
                <div className="text-[10px] text-slate-500 font-mono truncate">{BUILD_TAG}</div>
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            <TableOfContents
              projects={projects}
              activeProjectId={activeProjectId}
              onSelectProject={handleSelectProject}
              onSave={handleSaveSnapshot}
              onCreateNew={() => {
                didAutoSelectRef.current = true;
                setActiveProjectId(null);
                setMessages([initialWelcomeMessage]);
                setError(null);
              }}
              onDeleteProject={handleDeleteProject as any}
              isLoading={isLoading || anyGenerating}
            />
          

<div className="mt-4 text-[11px] text-slate-400 bg-slate-950/40 border border-slate-800 rounded p-3 leading-relaxed">
  Gemini corre en backend: <span className="font-mono">POST /api/composer</span>. En Vercel configura{' '}
  <span className="font-mono">GEMINI_API_KEY</span> (privada, sin <span className="font-mono">VITE_</span>).
</div>
</div>
        </aside>

        <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-slate-950">
          {activeProject && (
            <div className="shrink-0 bg-slate-900 border-b border-slate-800 flex">
              <button
                onClick={() => setViewMode('plan')}
                className={`flex-1 py-3 text-sm font-bold border-b-2 transition-all ${
                  viewMode === 'plan'
                    ? 'border-indigo-500 text-indigo-300 bg-indigo-500/10'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <RocketIcon className="w-4 h-4 inline mr-2" /> Arquitectura Editorial
              </button>

              <button
                onClick={() => setViewMode('book')}
                className={`flex-1 py-3 text-sm font-bold border-b-2 transition-all ${
                  viewMode === 'book'
                    ? 'border-indigo-500 text-indigo-300 bg-indigo-500/10'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <BookOpenIcon className="w-4 h-4 inline mr-2" /> Documento Maestro
              </button>
            </div>
          )}

          <div className="relative flex-1 min-h-0 overflow-y-auto">
            {activeProject ? (
              viewMode === 'plan' ? (
                <div className="min-h-full bg-slate-950">
                  <GenerationDashboard
                    project={activeProject}
                    onGenerate={handleGenerateSection}
                    onGenerateRemaining={handleGenerateRemaining}
                    onOpenBookView={() => setViewMode('book')}
                    isGeneratingGlobal={isLoading || anyGenerating}
                  />
                </div>
              ) : (
                <div className="min-h-full bg-slate-950">
                  <BookViewer project={activeProject} onEditSection={handleEditSection as any} />
                </div>
              )
            ) : (
              <div className="min-h-full bg-slate-950">
                <ChatInterface messages={messages} isLoading={isLoading} onSendMessage={handleStartNewBook} error={error} />
              </div>
            )}

            {error && (
              <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 bg-red-500/15 border border-red-500/30 text-red-200 px-4 py-2 rounded text-sm">
                {error}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
};

export default App;
