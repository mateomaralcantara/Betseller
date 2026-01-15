#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Optimize / sanitize BestSeller projects JSON.

What it does (safe by default):
- Detects placeholder text (e.g. "...") and marks those sections as PENDING
- Recomputes words from actual text (fixes fake word counts)
- Normalizes outline_12 statuses to match chapter reality
- Recomputes dashboard.progress + generation_progress from actual content
- Optionally rebuilds master_document.text from sections (proposal/intro/chapters)
- Optionally drops redundant fields (chapter_title duplicates, master_document.chunks, etc.)

Usage examples:
  python optimize_projects_json.py projects.json --out projects.optimized.json
  python optimize_projects_json.py projects.json --inplace
  python optimize_projects_json.py projects.json --out projects.optimized.json --rebuild-master
  python optimize_projects_json.py projects.json --out projects.optimized.json --drop-master-chunks --drop-dup-chapter-title
"""

from __future__ import annotations

import argparse
import json
import os
import re
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Tuple, Optional


WORD_RE = re.compile(r"\b[\wÀ-ÿ]+\b", flags=re.UNICODE)


def read_json_text(path: Path) -> str:
    # utf-8-sig eats BOM if present
    raw = path.read_text(encoding="utf-8-sig")
    if not raw.strip():
        raise ValueError(f"JSON vacío o solo espacios: {path}")
    return raw


def safe_json_load(path: Path) -> Any:
    raw = read_json_text(path)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        # Give a clearer error with context
        snippet = raw[:200].replace("\n", "\\n")
        raise ValueError(
            f"JSON inválido en {path}: {e}\n"
            f"Primeros 200 chars: {snippet}"
        ) from e


def safe_json_dump(obj: Any, pretty: bool = True) -> str:
    if pretty:
        return json.dumps(obj, ensure_ascii=False, indent=2)
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def ensure_str(x: Any) -> str:
    return x if isinstance(x, str) else ""


def ensure_list(x: Any) -> List[Any]:
    return x if isinstance(x, list) else []


def ensure_dict(x: Any) -> Dict[str, Any]:
    return x if isinstance(x, dict) else {}


def word_count(text: str) -> int:
    t = text.strip()
    if not t:
        return 0
    return len(WORD_RE.findall(t))


def is_placeholder(text: Any) -> bool:
    """
    Detect the classic "..." placeholder and other cheap truncations.
    We keep it conservative: real chapters can be short, but a chapter that's
    literally '...' or has multiple ellipses markers is placeholder.
    """
    t = ensure_str(text).strip()
    if not t:
        return True

    # Pure dots
    if re.fullmatch(r"\.{3,}", t):
        return True

    ellipses = t.count("...")

    # Common pattern in your master_document: sections separated by headings then "..."
    # If it has multiple ellipses blocks, it's placeholder-heavy
    if ellipses >= 2:
        return True

    # One ellipsis + too few words usually means placeholder
    wc = word_count(t)
    if ellipses >= 1 and wc < 400:
        return True

    # Some models produce "…"
    if "…" in t and wc < 400:
        return True

    return False


def section_status_from_text(text: str) -> str:
    return "COMPLETED" if (text.strip() and not is_placeholder(text)) else "PENDING"


def normalize_section(sec: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Returns (updated_section, metrics)
    """
    s = deepcopy(sec)
    txt = ensure_str(s.get("text", "")).strip()
    ph = is_placeholder(txt)
    wc = 0 if ph else word_count(txt)

    s["text"] = txt
    s["words"] = wc
    s["status"] = "COMPLETED" if (txt and not ph) else "PENDING"
    s["placeholder"] = bool(ph)

    metrics = {"placeholder": ph, "words": wc, "status": s["status"]}
    return s, metrics


def find_chapter(state: Dict[str, Any], chapter_number: int) -> Optional[Dict[str, Any]]:
    for ch in ensure_list(state.get("chapters")):
        if ensure_dict(ch).get("chapter_number") == chapter_number:
            return ensure_dict(ch)
    return None


def rebuild_master(project_title: str, state: Dict[str, Any]) -> str:
    """
    Build master_document.text from proposal/introduction/chapters.
    For missing/incomplete sections we insert a clean marker, not '...'.
    """
    parts: List[str] = []
    title = project_title or ensure_str(state.get("book_title")) or "Libro"
    parts.append(f"# {title}\n")

    def add_block(h2: str, body: str):
        parts.append("\n---\n")
        parts.append(f"\n## {h2}\n\n")
        parts.append(body.strip() + "\n")

    proposal = ensure_dict(state.get("proposal"))
    intro = ensure_dict(state.get("introduction"))

    prop_txt = ensure_str(proposal.get("text")).strip()
    intro_txt = ensure_str(intro.get("text")).strip()

    add_block("Propuesta editorial", prop_txt if prop_txt and not is_placeholder(prop_txt) else "[PENDIENTE]")
    add_block("Introducción", intro_txt if intro_txt and not is_placeholder(intro_txt) else "[PENDIENTE]")

    # Prefer outline order, fallback to chapters list order
    outline = ensure_list(state.get("outline_12"))
    ordered_numbers = [ensure_dict(o).get("chapter_number") for o in outline if isinstance(ensure_dict(o).get("chapter_number"), int)]
    if not ordered_numbers:
        ordered_numbers = [ensure_dict(c).get("chapter_number") for c in ensure_list(state.get("chapters")) if isinstance(ensure_dict(c).get("chapter_number"), int)]

    for n in ordered_numbers:
        ch = find_chapter(state, int(n))
        ch_title = ""
        ch_txt = ""
        if ch:
            ch_title = ensure_str(ch.get("title")) or ensure_str(ch.get("chapter_title"))
            ch_txt = ensure_str(ch.get("text")).strip()
        if not ch_title:
            # try outline
            o = next((ensure_dict(x) for x in outline if ensure_dict(x).get("chapter_number") == n), {})
            ch_title = ensure_str(o.get("chapter_title")) or f"Capítulo {n}"

        body = ch_txt if ch_txt and not is_placeholder(ch_txt) else "[PENDIENTE]"
        add_block(ch_title, body)

    return "".join(parts).strip() + "\n"


def update_dashboard(project: Dict[str, Any], state: Dict[str, Any]) -> None:
    """
    Recompute dashboard.progress + generation_progress coherently.
    We keep structure but overwrite the lying parts.
    """
    dash = ensure_dict(project.get("dashboard"))
    gp = ensure_dict(project.get("generation_progress"))

    # Proposal/Intro
    proposal = ensure_dict(state.get("proposal"))
    intro = ensure_dict(state.get("introduction"))

    prop_done = proposal.get("status") == "COMPLETED"
    intro_done = intro.get("status") == "COMPLETED"

    gp["proposal"] = "completed" if prop_done else "pending"
    gp["intro"] = "completed" if intro_done else "pending"

    chapters_words_list: List[Dict[str, Any]] = []
    total_words = 0

    # Chapters
    for ch in ensure_list(state.get("chapters")):
        chd = ensure_dict(ch)
        n = chd.get("chapter_number")
        if not isinstance(n, int):
            continue
        done = chd.get("status") == "COMPLETED"
        w = int(chd.get("words") or 0)
        chapters_words_list.append({"chapter_number": n, "words": w, "status": "COMPLETED" if done else "PENDING"})
        total_words += w
        gp[f"chap-{n}"] = "completed" if done else "pending"

    prop_words = int(proposal.get("words") or 0)
    intro_words = int(intro.get("words") or 0)
    total_words += prop_words + intro_words

    # Completion estimate: based on outline items with real text completed
    outline = ensure_list(state.get("outline_12"))
    if outline:
        total_items = 2 + len(outline)  # proposal + intro + chapters
        done_items = (1 if prop_done else 0) + (1 if intro_done else 0)
        # done chapters based on state.chapters completion
        done_ch = sum(1 for ch in ensure_list(state.get("chapters")) if ensure_dict(ch).get("status") == "COMPLETED")
        done_items += done_ch
        completion_percent = int(round((done_items / max(total_items, 1)) * 100))
    else:
        completion_percent = 0

    progress = ensure_dict(dash.get("progress"))
    progress["proposal_words"] = prop_words
    progress["introduction_words"] = intro_words
    progress["chapters_words"] = sorted(chapters_words_list, key=lambda x: x["chapter_number"])
    progress["total_words"] = total_words
    progress["completion_percent_est"] = completion_percent

    dash["progress"] = progress
    project["dashboard"] = dash
    project["generation_progress"] = gp


def optimize_project(project: Dict[str, Any], args: argparse.Namespace) -> Dict[str, Any]:
    p = deepcopy(project)

    state = ensure_dict(p.get("state"))
    if not state:
        return p

    # Normalize proposal/introduction
    if "proposal" in state:
        state["proposal"], _ = normalize_section(ensure_dict(state["proposal"]))
    if "introduction" in state:
        state["introduction"], _ = normalize_section(ensure_dict(state["introduction"]))

    # Normalize chapters
    chapters = []
    for ch in ensure_list(state.get("chapters")):
        chd = deepcopy(ensure_dict(ch))
        txt = ensure_str(chd.get("text")).strip()
        ph = is_placeholder(txt)
        wc = 0 if ph else word_count(txt)

        chd["text"] = txt
        chd["words"] = wc
        chd["status"] = "COMPLETED" if (txt and not ph) else "PENDING"
        chd["placeholder"] = bool(ph)

        if args.drop_dup_chapter_title and "chapter_title" in chd:
            # Often duplicates 'title'
            if ensure_str(chd.get("chapter_title")) == ensure_str(chd.get("title")):
                chd.pop("chapter_title", None)

        chapters.append(chd)

    state["chapters"] = chapters

    # Normalize outline_12 status based on actual chapter text
    outline = []
    for o in ensure_list(state.get("outline_12")):
        od = deepcopy(ensure_dict(o))
        n = od.get("chapter_number")
        if isinstance(n, int):
            ch = find_chapter(state, n)
            done = bool(ch and ensure_str(ch.get("text")).strip() and not is_placeholder(ch.get("text")))

            od["status"] = "COMPLETED" if done else "PENDING"

            # If target_words is missing, keep; else leave
        outline.append(od)
    state["outline_12"] = outline

    # Optionally rebuild master_document.text
    master = ensure_dict(state.get("master_document"))
    if args.rebuild_master:
        title = ensure_str(p.get("title")) or ensure_str(state.get("book_title"))
        master["title"] = master.get("title") or title
        master["text"] = rebuild_master(title, state)

    # Optionally drop master_document.chunks (usually duplicates of text)
    if args.drop_master_chunks and "chunks" in master:
        master.pop("chunks", None)

    # If chunks exist and we want to re-chunk
    if args.rechunk_master and isinstance(args.max_chunk_chars, int) and args.max_chunk_chars > 0:
        txt = ensure_str(master.get("text"))
        if txt:
            chunks = []
            # split by section separators to keep coherent chunks
            blocks = txt.split("\n---\n")
            current = ""
            idx = 1
            for b in blocks:
                candidate = (current + ("\n---\n" if current else "") + b).strip()
                if len(candidate) > args.max_chunk_chars and current:
                    chunks.append({"index": idx, "total": 0, "text": current.strip()})
                    idx += 1
                    current = b
                else:
                    current = candidate
            if current.strip():
                chunks.append({"index": idx, "total": 0, "text": current.strip()})

            total = len(chunks)
            for i, c in enumerate(chunks, start=1):
                c["index"] = i
                c["total"] = total
            master["chunks"] = chunks

    state["master_document"] = master
    p["state"] = state

    # Dashboard + generation_progress coherence
    update_dashboard(p, state)

    return p


def optimize_all(data: Any, args: argparse.Namespace) -> Any:
    if isinstance(data, list):
        return [optimize_project(ensure_dict(p), args) for p in data]
    if isinstance(data, dict):
        # Some apps store as dict keyed by id; we handle both
        out = {}
        for k, v in data.items():
            out[k] = optimize_project(ensure_dict(v), args)
        return out
    raise ValueError("Formato JSON no soportado: se esperaba list o dict.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Optimize/sanitize projects.json for BestSeller app.")
    ap.add_argument("json_path", type=str, help="Input projects.json path")
    ap.add_argument("--out", type=str, default="", help="Output file path (default: <input>.optimized.json)")
    ap.add_argument("--inplace", action="store_true", help="Overwrite input file (danger).")
    ap.add_argument("--minify", action="store_true", help="Minify JSON output (no pretty indent).")

    ap.add_argument("--rebuild-master", action="store_true", help="Rebuild master_document.text from sections (no ellipses).")
    ap.add_argument("--drop-master-chunks", action="store_true", help="Remove master_document.chunks (usually redundant).")
    ap.add_argument("--rechunk-master", action="store_true", help="Create master_document.chunks from text.")
    ap.add_argument("--max-chunk-chars", type=int, default=8000, help="Chunk size used with --rechunk-master.")
    ap.add_argument("--drop-dup-chapter-title", action="store_true", help="Drop chapter_title when it duplicates title.")

    args = ap.parse_args()

    in_path = Path(args.json_path).resolve()
    data = safe_json_load(in_path)

    before_size = in_path.stat().st_size

    optimized = optimize_all(data, args)

    out_text = safe_json_dump(optimized, pretty=not args.minify)

    if args.inplace:
        out_path = in_path
    else:
        out_path = Path(args.out).resolve() if args.out else in_path.with_suffix(".optimized.json")

    out_path.write_text(out_text, encoding="utf-8")

    after_size = out_path.stat().st_size
    saved = before_size - after_size if out_path != in_path else 0

    print("OK.")
    print(f"Input:  {in_path}  ({before_size} bytes)")
    print(f"Output: {out_path} ({after_size} bytes)")
    if out_path != in_path:
        pct = (saved / max(before_size, 1)) * 100
        print(f"Saved:  {saved} bytes ({pct:.1f}%)")

    # Quick sanity report: how many placeholders remain
    def count_placeholders(obj: Any) -> int:
        if isinstance(obj, dict):
            c = 0
            for k, v in obj.items():
                if k == "text" and isinstance(v, str) and is_placeholder(v):
                    c += 1
                c += count_placeholders(v)
            return c
        if isinstance(obj, list):
            return sum(count_placeholders(x) for x in obj)
        return 0

    ph = count_placeholders(optimized)
    print(f"Placeholder texts detected (remaining): {ph}")


if __name__ == "__main__":
    main()
