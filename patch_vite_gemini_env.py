#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
patch_vite_gemini_env.py

Arregla el mismatch entre vite.config.ts y .env.local para Gemini.

Hace:
1) Parchea vite.config.ts:
   - Reemplaza env.GEMINI_API_KEY -> env.VITE_GEMINI_API_KEY
   - Reemplaza env.API_KEY -> env.VITE_GEMINI_API_KEY (por si acaso)
   - Asegura define de:
       'process.env.API_KEY' y 'process.env.GEMINI_API_KEY'
     apuntando a env.VITE_GEMINI_API_KEY
   - Si hay envPrefix y no incluye VITE_, lo corrige a incluir VITE_.
2) Verifica .env.local en la raíz del proyecto.
3) Crea backups .bak antes de modificar archivos.

Uso:
  python patch_vite_gemini_env.py --project .
"""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path

ENV_KEY = "VITE_GEMINI_API_KEY"
ENV_MODEL = "VITE_GEMINI_MODEL"
DEFAULT_MODEL = "gemini-3-pro-preview"

RE_DEFINE_APIKEY_LINE = re.compile(r"(['\"]process\.env\.API_KEY['\"]\s*:\s*JSON\.stringify\(\s*env\.(.+?)\s*\)\s*,?)")
RE_ENV_GEMINI = re.compile(r"\benv\.GEMINI_API_KEY\b")
RE_ENV_API = re.compile(r"\benv\.API_KEY\b")
RE_ENVPREFIX = re.compile(r"\benvPrefix\s*:\s*([^,\n]+)")

def read_text(p: Path) -> str:
    return p.read_text(encoding="utf-8-sig", errors="ignore")

def write_text(p: Path, content: str) -> None:
    p.write_text(content, encoding="utf-8", newline="\n")

def ensure_backup(p: Path) -> Path:
    bak = p.with_suffix(p.suffix + ".bak")
    if not bak.exists():
        shutil.copy2(p, bak)
    return bak

def ensure_env_local(root: Path) -> None:
    env_local = root / ".env.local"
    if not env_local.exists():
        write_text(env_local, f"{ENV_KEY}=\n{ENV_MODEL}={DEFAULT_MODEL}\n")
        print(f"[FIX] Creé {env_local} (placeholder).")
        return

    txt = read_text(env_local)
    if ENV_MODEL not in txt:
        txt = txt.rstrip() + f"\n{ENV_MODEL}={DEFAULT_MODEL}\n"
        write_text(env_local, txt)
        print(f"[FIX] Agregué {ENV_MODEL} en .env.local.")

def env_local_has_key(root: Path) -> bool:
    env_local = root / ".env.local"
    if not env_local.exists():
        return False
    for ln in read_text(env_local).splitlines():
        if ln.strip().startswith(ENV_KEY + "="):
            val = ln.split("=", 1)[1].strip().strip('"').strip("'")
            return len(val) > 10
    return False

def patch_envprefix(cfg: str) -> tuple[str, bool]:
    """
    Si existe envPrefix pero no incluye VITE_, lo reescribe para incluirlo.
    Maneja:
      envPrefix: 'GEMINI_'
      envPrefix: ['GEMINI_']
      envPrefix: ['GEMINI_', 'X_']
    """
    m = RE_ENVPREFIX.search(cfg)
    if not m:
        return cfg, False

    raw = m.group(1).strip()
    if "VITE_" in raw:
        return cfg, False

    # Caso string: envPrefix: 'GEMINI_'
    if raw.startswith(("'", '"')):
        replacement = "['VITE_']"
    # Caso array
    elif raw.startswith("["):
        # inserta VITE_ al inicio
        replacement = raw
        # naïve: si ya es array, metemos 'VITE_' al principio
        replacement = re.sub(r"^\[\s*", "['VITE_', ", replacement)
    else:
        # expresión rara: lo dejamos seguro
        replacement = "['VITE_']"

    new_cfg = cfg[:m.start(1)] + replacement + cfg[m.end(1):]
    return new_cfg, True

def ensure_define_lines(cfg: str) -> tuple[str, bool]:
    """
    Garantiza que existan:
      'process.env.API_KEY': JSON.stringify(env.VITE_GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.VITE_GEMINI_API_KEY),
    dentro de define: { ... }
    Si no encuentra "define:", no inventa estructura: solo corrige referencias env.*
    """
    if "define" not in cfg:
        return cfg, False

    changed = False

    # Reemplazos de env.GEMINI_API_KEY / env.API_KEY por env.VITE_GEMINI_API_KEY
    new_cfg = RE_ENV_GEMINI.sub(f"env.{ENV_KEY}", cfg)
    if new_cfg != cfg:
        cfg = new_cfg
        changed = True

    new_cfg = RE_ENV_API.sub(f"env.{ENV_KEY}", cfg)
    if new_cfg != cfg:
        cfg = new_cfg
        changed = True

    # Si ya existe process.env.API_KEY, lo dejamos (ya quedó apuntando a env.VITE_GEMINI_API_KEY por reemplazo)
    has_api = "'process.env.API_KEY'" in cfg or '"process.env.API_KEY"' in cfg
    has_gem = "'process.env.GEMINI_API_KEY'" in cfg or '"process.env.GEMINI_API_KEY"' in cfg

    # Intento insertar GEMINI_API_KEY define justo después de API_KEY define si existe
    if has_api and not has_gem:
        # Inserta una línea gemini debajo de API_KEY
        pattern = r"(['\"]process\.env\.API_KEY['\"].*?\n)"
        m = re.search(pattern, cfg)
        if m:
            insert = m.group(1) + f"      'process.env.GEMINI_API_KEY': JSON.stringify(env.{ENV_KEY}),\n"
            cfg = cfg[:m.start(1)] + insert + cfg[m.end(1):]
            changed = True

    return cfg, changed

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=".", help="Root del proyecto")
    args = ap.parse_args()

    root = Path(args.project).expanduser().resolve()
    if not root.exists():
        print(f"[FATAL] No existe: {root}")
        return 2

    vite_cfg = root / "vite.config.ts"
    if not vite_cfg.exists():
        print(f"[FATAL] No encuentro vite.config.ts en {root}")
        return 2

    # Asegurar .env.local
    ensure_env_local(root)

    cfg = read_text(vite_cfg)
    original = cfg

    # Parche envPrefix si existe y está bloqueando VITE_
    cfg, changed_prefix = patch_envprefix(cfg)

    # Parche define/env references
    cfg, changed_define = ensure_define_lines(cfg)

    if cfg != original:
        bak = ensure_backup(vite_cfg)
        write_text(vite_cfg, cfg)
        print(f"[FIX] Parché vite.config.ts (backup: {bak.name}).")
        if changed_prefix:
            print("[FIX] Corregí envPrefix para incluir VITE_.")
        if changed_define:
            print(f"[FIX] Alineé define/env.* para usar env.{ENV_KEY}.")
    else:
        print("[OK] vite.config.ts no requirió cambios (ya estaba alineado).")

    # Veredicto
    has_key = env_local_has_key(root)
    print("\n=== VERDICT ===")
    print(f".env.local tiene {ENV_KEY} no vacío? {'SI' if has_key else 'NO'}")
    print("Siguiente paso: reinicia Vite (Ctrl+C y luego npm run dev).")

    return 0

if __name__ == "__main__":
    raise SystemExit(main())
