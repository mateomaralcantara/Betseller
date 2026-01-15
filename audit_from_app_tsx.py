#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
audit_from_app_tsx.py (robusto)

Arreglos:
- Si --app apunta a un archivo que no existe, auto-busca App.tsx en el proyecto.
- No crashea si App.tsx no existe: reporta el problema y continúa.
- Sigue validando package.json, env usage y JSONs tipo engine output.

Uso recomendado:
  python audit_from_app_tsx.py --project . --app auto --report audit_report.json
  python audit_from_app_tsx.py --project . --report audit_report.json        (auto por defecto)
"""

from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


ENGINE_TOP_KEYS = {
    "ok",
    "needs_input",
    "dashboard",
    "generated_section",
    "project_state_updated",
    "master_document",
    "merge",
}

ALLOWED_STATUS_SIMPLE = {"PENDING", "COMPLETED"}
ALLOWED_STATUS_OUTLINE = {"PENDING", "DRAFTED", "COMPLETED"}
ALLOWED_STATUS_GENERATED = {"NONE", "PENDING", "COMPLETED"}

IMPORT_RE = re.compile(r"^\s*import\s+.*?\s+from\s+['\"](.+?)['\"];?\s*$")
WORD_SPLIT = re.compile(r"\s+")


@dataclass
class Finding:
    level: str  # ERROR | WARN | INFO
    code: str
    message: str
    file: Optional[str] = None
    pointer: Optional[str] = None


@dataclass
class AuditReport:
    project_root: str
    app_file_used: Optional[str]
    findings: List[Finding]
    summary: Dict[str, Any]


def add(findings: List[Finding], level: str, code: str, message: str,
        file: Optional[str] = None, pointer: Optional[str] = None) -> None:
    findings.append(Finding(level, code, message, file, pointer))


def read_text(p: Path) -> str:
    # utf-8-sig tolera BOM; errors ignore evita romper por caracteres raros
    return p.read_text(encoding="utf-8-sig", errors="ignore")


def count_words(text: str) -> int:
    t = (text or "").strip()
    if not t:
        return 0
    return len([w for w in WORD_SPLIT.split(t) if w])


def is_engine_output(obj: Any) -> bool:
    if not isinstance(obj, dict):
        return False
    overlap = len(set(obj.keys()).intersection(ENGINE_TOP_KEYS))
    return overlap >= 4


# ----------------------------
# Auto-discovery App.tsx
# ----------------------------

def find_app_tsx(project_root: Path) -> List[Path]:
    """
    Busca App.tsx en el proyecto.
    Prioriza rutas típicas: src/App.tsx, app/App.tsx, etc.
    """
    candidates: List[Path] = []

    # Prioridad alta (típico)
    for rel in ["src/App.tsx", "app/App.tsx", "App.tsx"]:
        p = (project_root / rel).resolve()
        if p.exists():
            candidates.append(p)

    # Búsqueda total si no aparece en lugares comunes
    if not candidates:
        for dirpath, _, filenames in os.walk(project_root):
            for fn in filenames:
                if fn.lower() == "app.tsx":
                    candidates.append((Path(dirpath) / fn).resolve())

    # Ordenar por ruta más corta (más probable sea la principal)
    candidates = sorted(list(dict.fromkeys(candidates)), key=lambda p: len(str(p)))
    return candidates


def resolve_app_path(project_root: Path, app_arg: str, findings: List[Finding]) -> Optional[Path]:
    """
    Si app_arg es 'auto' o vacío, auto-busca.
    Si apunta a un archivo que no existe, intenta auto-buscar.
    """
    app_arg = (app_arg or "auto").strip()

    # Caso auto
    if app_arg.lower() == "auto":
        found = find_app_tsx(project_root)
        if not found:
            add(findings, "ERROR", "APP_NOT_FOUND",
                "No encontré App.tsx en el proyecto. Pasa la ruta correcta con --app o revisa tu estructura.",
                file=str(project_root))
            return None
        if len(found) > 1:
            add(findings, "WARN", "MULTIPLE_APP_FILES",
                f"Encontré múltiples App.tsx. Usaré el primero: {found[0].relative_to(project_root)}",
                file=str(project_root))
        else:
            add(findings, "INFO", "APP_AUTO_FOUND",
                f"App.tsx encontrado: {found[0].relative_to(project_root)}",
                file=str(project_root))
        return found[0]

    # Caso ruta explícita
    app_path = Path(app_arg).expanduser()
    if not app_path.is_absolute():
        app_path = (project_root / app_path).resolve()

    if app_path.exists():
        add(findings, "INFO", "APP_PATH_OK",
            f"Usando App.tsx: {app_path.relative_to(project_root)}",
            file=str(app_path))
        return app_path

    # Si no existe, auto-buscar
    add(findings, "WARN", "APP_PATH_MISSING",
        f"No existe: {app_path}. Intentaré auto-encontrar App.tsx.",
        file=str(app_path))

    found = find_app_tsx(project_root)
    if not found:
        add(findings, "ERROR", "APP_NOT_FOUND",
            "No pude auto-encontrar App.tsx. Tu --app no existe y no hay App.tsx en el repo.",
            file=str(project_root))
        return None

    add(findings, "INFO", "APP_FALLBACK_FOUND",
        f"Fallback App.tsx: {found[0].relative_to(project_root)}",
        file=str(project_root))
    return found[0]


# ----------------------------
# Estructura desde App.tsx
# ----------------------------

def parse_imports_from_app(app_text: str) -> List[str]:
    imports: List[str] = []
    for line in app_text.splitlines():
        m = IMPORT_RE.match(line)
        if not m:
            continue
        mod = m.group(1).strip()
        if mod.startswith("."):
            imports.append(mod)
    return imports


def resolve_relative_import(project_root: Path, app_path: Path, mod: str) -> Optional[Path]:
    base_dir = app_path.parent
    raw = (base_dir / mod).resolve()

    candidates: List[Path] = []
    exts = [".tsx", ".ts", ".jsx", ".js", ".json"]
    for ext in exts:
        candidates.append(Path(str(raw) + ext))
    for ext in exts:
        candidates.append(raw / ("index" + ext))

    for c in candidates:
        try:
            c.relative_to(project_root.resolve())
        except ValueError:
            continue
        if c.exists():
            return c

    if raw.exists() and raw.is_file():
        return raw
    return None


def check_structure(project_root: Path, app_path: Optional[Path], findings: List[Finding]) -> None:
    if not app_path or not app_path.exists():
        add(findings, "ERROR", "APP_MISSING",
            "No se pudo validar estructura porque App.tsx no existe/no fue localizado.",
            file=str(project_root))
        return

    app_text = read_text(app_path)
    imports = parse_imports_from_app(app_text)
    if not imports:
        add(findings, "WARN", "NO_IMPORTS_PARSED",
            "No pude parsear imports relativos desde App.tsx (regex simple). Puede ser OK.",
            file=str(app_path))
        return

    missing = 0
    for mod in imports:
        resolved = resolve_relative_import(project_root, app_path, mod)
        if not resolved:
            missing += 1
            add(findings, "ERROR", "IMPORT_TARGET_MISSING",
                f"Import relativo no resuelto: {mod}. Falta archivo/módulo.",
                file=str(app_path), pointer=f"import:{mod}")
        else:
            add(findings, "INFO", "IMPORT_OK",
                f"Import OK: {mod} -> {resolved.relative_to(project_root)}",
                file=str(app_path))

    if missing == 0:
        add(findings, "INFO", "STRUCTURE_OK", "Todos los imports relativos de App.tsx se resolvieron.")


# ----------------------------
# package.json y env usage
# ----------------------------

def load_package_json(project_root: Path) -> Optional[Dict[str, Any]]:
    pj = project_root / "package.json"
    if not pj.exists():
        return None
    try:
        return json.loads(read_text(pj))
    except Exception:
        return None


def detect_tooling(pkg: Dict[str, Any]) -> str:
    scripts = (pkg.get("scripts") or {})
    if isinstance(scripts, dict):
        s = " ".join(str(v) for v in scripts.values())
        if "vite" in s:
            return "vite"
        if "react-scripts" in s:
            return "cra"
        if "next" in s:
            return "next"

    deps = {}
    for k in ("dependencies", "devDependencies"):
        if isinstance(pkg.get(k), dict):
            deps.update(pkg[k])

    if "vite" in deps:
        return "vite"
    if "react-scripts" in deps:
        return "cra"
    if "next" in deps:
        return "next"
    return "unknown"


def check_deps_and_env(project_root: Path, app_path: Optional[Path], findings: List[Finding]) -> None:
    pkg = load_package_json(project_root)
    if not pkg:
        add(findings, "WARN", "PACKAGE_JSON_MISSING",
            "No encuentro/leo package.json. No puedo validar dependencias ni tooling.",
            file=str(project_root / "package.json"))
        return

    tooling = detect_tooling(pkg)
    add(findings, "INFO", "TOOLING_DETECTED", f"Tooling detectado: {tooling}", file=str(project_root / "package.json"))

    deps = {}
    for k in ("dependencies", "devDependencies"):
        if isinstance(pkg.get(k), dict):
            deps.update(pkg[k])

    # Dep opcional: @google/genai
    if "@google/genai" not in deps:
        add(findings, "WARN", "MISSING_DEP_GOOGLE_GENAI",
            "No veo @google/genai en package.json. Si tu app lo importa, te faltará instalarlo.",
            file=str(project_root / "package.json"))
    else:
        add(findings, "INFO", "DEP_OK_GOOGLE_GENAI",
            f"@google/genai presente: {deps.get('@google/genai')}",
            file=str(project_root / "package.json"))

    if not app_path or not app_path.exists():
        add(findings, "WARN", "SKIP_ENV_CHECK_NO_APP",
            "Salté verificación de env vars en App.tsx porque no se encontró App.tsx.",
            file=str(project_root))
        return

    app_text = read_text(app_path)

    # Detectar patrones comunes de env
    uses_process_api_key = "process.env.API_KEY" in app_text
    uses_vite = "import.meta.env" in app_text
    uses_react_app = "REACT_APP_" in app_text
    uses_vite_prefix = "VITE_" in app_text

    if uses_process_api_key:
        if tooling == "vite":
            add(findings, "WARN", "ENV_VAR_VITE_MISMATCH",
                "Vite detectado pero App.tsx usa process.env.API_KEY. En Vite normalmente es import.meta.env.VITE_API_KEY.",
                file=str(app_path), pointer="process.env.API_KEY")
        elif tooling == "cra":
            add(findings, "WARN", "ENV_VAR_CRA_MISMATCH",
                "CRA detectado pero App.tsx usa process.env.API_KEY. En CRA normalmente es process.env.REACT_APP_API_KEY.",
                file=str(app_path), pointer="process.env.API_KEY")
        else:
            add(findings, "INFO", "ENV_VAR_FOUND",
                "App.tsx usa process.env.API_KEY. Verifica que tu bundler lo soporte.",
                file=str(app_path), pointer="process.env.API_KEY")

    # Si es Vite pero no veo import.meta.env, aviso
    if tooling == "vite" and not uses_vite:
        add(findings, "INFO", "VITE_ENV_NOTE",
            "Vite detectado. Asegúrate de usar import.meta.env.VITE_* para variables de entorno.",
            file=str(app_path))


# ----------------------------
# Validación de JSONs del engine
# ----------------------------

def validate_engine_json(obj: Dict[str, Any], findings: List[Finding], file: str) -> None:
    for k in ENGINE_TOP_KEYS:
        if k not in obj:
            add(findings, "ERROR", "MISSING_TOP_KEY",
                f"Falta clave top-level '{k}'. Tu UI probablemente la espera.",
                file=file, pointer=k)

    gs = obj.get("generated_section")
    if not isinstance(gs, dict):
        add(findings, "ERROR", "GENERATED_SECTION_MISSING",
            "generated_section falta o no es objeto.",
            file=file, pointer="generated_section")
    else:
        st = gs.get("status")
        if st not in ALLOWED_STATUS_GENERATED:
            add(findings, "ERROR", "GENERATED_STATUS_INVALID",
                f"generated_section.status inválido/faltante: {st!r}.",
                file=file, pointer="generated_section.status")

    psu = obj.get("project_state_updated")
    if not isinstance(psu, dict):
        add(findings, "ERROR", "PSU_MISSING",
            "project_state_updated falta o no es objeto. Esto suele causar crash en .status.",
            file=file, pointer="project_state_updated")
        return

    prop = psu.get("proposal")
    if not isinstance(prop, dict):
        add(findings, "ERROR", "PROPOSAL_MISSING",
            "project_state_updated.proposal falta o no es objeto (UI lee proposal.status).",
            file=file, pointer="project_state_updated.proposal")
    else:
        st = prop.get("status")
        if st not in ALLOWED_STATUS_SIMPLE:
            add(findings, "ERROR", "PROPOSAL_STATUS_INVALID",
                f"proposal.status inválido/faltante: {st!r}.",
                file=file, pointer="project_state_updated.proposal.status")

    intro = psu.get("introduction")
    if not isinstance(intro, dict):
        add(findings, "ERROR", "INTRO_MISSING",
            "project_state_updated.introduction falta o no es objeto (UI lee introduction.status).",
            file=file, pointer="project_state_updated.introduction")
    else:
        st = intro.get("status")
        if st not in ALLOWED_STATUS_SIMPLE:
            add(findings, "ERROR", "INTRO_STATUS_INVALID",
                f"introduction.status inválido/faltante: {st!r}.",
                file=file, pointer="project_state_updated.introduction.status")

    outline = psu.get("outline_12")
    if not isinstance(outline, list):
        add(findings, "ERROR", "OUTLINE_NOT_LIST",
            "project_state_updated.outline_12 falta o no es lista (UI hace outline_12.forEach).",
            file=file, pointer="project_state_updated.outline_12")
    else:
        for i, o in enumerate(outline):
            ptr = f"project_state_updated.outline_12[{i}]"
            if not isinstance(o, dict):
                add(findings, "ERROR", "OUTLINE_ITEM_NOT_OBJECT",
                    "Item de outline_12 no es objeto.",
                    file=file, pointer=ptr)
                continue
            st = o.get("status")
            if st not in ALLOWED_STATUS_OUTLINE:
                add(findings, "ERROR", "OUTLINE_STATUS_INVALID",
                    f"outline_12[{i}].status inválido/faltante: {st!r}.",
                    file=file, pointer=f"{ptr}.status")

    md = obj.get("master_document")
    if not isinstance(md, dict):
        add(findings, "ERROR", "MASTER_DOC_MISSING",
            "master_document falta o no es objeto.",
            file=file, pointer="master_document")
    else:
        if not isinstance(md.get("text"), str):
            add(findings, "ERROR", "MASTER_TEXT_INVALID",
                "master_document.text debe ser string.",
                file=file, pointer="master_document.text")
        chunks = md.get("chunks")
        if not isinstance(chunks, list) or len(chunks) < 1:
            add(findings, "ERROR", "MASTER_CHUNKS_INVALID",
                "master_document.chunks debe ser lista con >=1.",
                file=file, pointer="master_document.chunks")


def scan_for_engine_jsons(project_root: Path, findings: List[Finding], samples: Optional[Path] = None) -> None:
    roots = [project_root]
    if samples and samples.exists() and samples.is_dir():
        roots.append(samples)

    checked = 0
    validated = 0

    skip_names = {"package-lock.json", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"}

    for root in roots:
        for dirpath, _, filenames in os.walk(root):
            for fn in filenames:
                if not fn.lower().endswith(".json"):
                    continue
                p = Path(dirpath) / fn
                if p.name in skip_names:
                    continue
                checked += 1
                rel = str(p.relative_to(project_root)) if project_root in p.parents else str(p)
                try:
                    obj = json.loads(read_text(p))
                except Exception:
                    continue
                if is_engine_output(obj):
                    validated += 1
                    validate_engine_json(obj, findings, file=rel)

    add(findings, "INFO", "JSON_SCAN_DONE",
        f"JSON escaneados: {checked}. Outputs tipo engine validados: {validated}.")


def _top_codes(findings: List[Finding], level: str, n: int = 8) -> List[Dict[str, Any]]:
    counts: Dict[str, int] = {}
    for f in findings:
        if f.level == level:
            counts[f.code] = counts.get(f.code, 0) + 1
    top = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:n]
    return [{"code": c, "count": k} for c, k in top]


def summarize(findings: List[Finding]) -> Dict[str, Any]:
    return {
        "errors": sum(1 for f in findings if f.level == "ERROR"),
        "warnings": sum(1 for f in findings if f.level == "WARN"),
        "info": sum(1 for f in findings if f.level == "INFO"),
        "top_error_codes": _top_codes(findings, "ERROR"),
        "top_warn_codes": _top_codes(findings, "WARN"),
        "most_likely_crash_reason": (
            "Si ves PROPOSAL_MISSING / INTRO_MISSING / OUTLINE_NOT_LIST, "
            "tu UI va a crashear al leer .status o al hacer outline_12.forEach."
        ),
        "next_step": (
            "Corrige el output JSON del engine (si falta status/keys) y/o pon fallbacks en el render: item?.status ?? 'PENDING'."
        ),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=".", help="Ruta raíz del proyecto")
    ap.add_argument("--app", default="auto", help="Ruta a App.tsx (relativa a --project) o 'auto'")
    ap.add_argument("--samples", default=None, help="Carpeta opcional con JSONs de respuestas (logs/fixtures)")
    ap.add_argument("--report", default="audit_report.json", help="Archivo JSON de salida")
    args = ap.parse_args()

    project_root = Path(args.project).expanduser().resolve()
    if not project_root.exists():
        print(f"[FATAL] Project root no existe: {project_root}")
        return 2

    findings: List[Finding] = []
    app_path = resolve_app_path(project_root, args.app, findings)

    check_structure(project_root, app_path, findings)
    check_deps_and_env(project_root, app_path, findings)

    samples_dir = Path(args.samples).expanduser().resolve() if args.samples else None
    scan_for_engine_jsons(project_root, findings, samples=samples_dir)

    report = AuditReport(
        project_root=str(project_root),
        app_file_used=str(app_path) if app_path else None,
        findings=findings,
        summary=summarize(findings),
    )

    out = Path(args.report).expanduser().resolve()
    out.write_text(json.dumps(asdict(report), ensure_ascii=False, indent=2), encoding="utf-8")

    s = report.summary
    print("\n=== AUDIT SUMMARY ===")
    print(f"App usado: {report.app_file_used}")
    print(f"Errors:   {s['errors']}")
    print(f"Warnings: {s['warnings']}")
    print(f"Info:     {s['info']}")
    print("Top errors:", s["top_error_codes"])
    print("Top warns: ", s["top_warn_codes"])
    print("\nReporte:", out)

    # Exit code: 1 si hay errores
    return 1 if s["errors"] > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
