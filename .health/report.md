# Software Health Report

Generated: **2026-05-17T04:24:38.454Z**

**Files scanned:** 29


## Top refactor candidates (prioridad)

**1. App.tsx** — HIGH (score 12)
- Motivos: archivo grande (1199 líneas), mucho "any" (219), mucho "as any" (174)

**2. components/BookViewer.tsx** — HIGH (score 12)
- Motivos: archivo grande (1126 líneas), mucho "any" (38), mucho "as any" (20)

**3. components/GenerationDashboard.tsx** — HIGH (score 7)
- Motivos: archivo grande (657 líneas), mucho "any" (11), mucho "as any" (5)

**4. src/data/repo.ts** — MED (score 6)
- Motivos: archivo grande (378 líneas), mucho "any" (12), mucho "as any" (5)

**5. components/TableOfContents.tsx** — MED (score 5)
- Motivos: mucho "any" (13), mucho "as any" (4)

**6. scripts/healthcheck.mjs** — MED (score 4)
- Motivos: archivo grande (394 líneas)

**7. scripts/find-components-precise.cjs** — LOW (score 2)
- Motivos: —

**8. scripts/where-css.cjs** — LOW (score 2)
- Motivos: —

**9. scripts/css-engine.cjs** — LOW (score 2)
- Motivos: —

**10. scripts/ui-audit.cjs** — LOW (score 1)
- Motivos: —

## High risk findings

### Nested <button> (HTML inválido)
- Fix: Cambia el contenedor externo a <div role='button' tabIndex={0}> y deja el botón interno como <button> (stopPropagation).
- Archivos:
  - App.tsx
  - components/BookViewer.tsx
  - components/GenerationDashboard.tsx
  - components/TableOfContents.tsx
  - scripts/healthcheck.mjs
  - scripts/masterdoc-static-check.cjs
  - scripts/ui-audit.cjs

### Riesgo de secret exposure (VITE_* y/o GoogleGenAI en frontend)
- Fix: Mueve Gemini a backend (/api/composer) y guarda GEMINI_API_KEY como env privada (sin VITE_).
- Archivos:
  - App.tsx
  - src/lib/supabase.ts

## Quick wins

### .map potencialmente inseguro
- Fix: Usa Array.isArray(x) ? x.map(...) : [] o x?.map?.(...) si aplica; evita undefined.map.
- Archivos:
  - App.tsx
  - components/BookProposalDisplay.tsx
  - components/BookViewer.tsx
  - components/ChatInterface.tsx
  - components/GenerationDashboard.tsx
  - components/TableOfContents.tsx
  - scripts/find-components-precise.cjs
  - scripts/healthcheck.mjs
  - scripts/masterdoc-static-check.cjs
  - scripts/ui-audit.cjs

### localStorage encontrado (si tu objetivo es 100% Supabase)
- Fix: Eliminar persistencia local y centralizar lectura/escritura en repo.ts (Supabase).
- Archivos:
  - components/BookViewer.tsx
  - components/GenerationDashboard.tsx

## Tooling checks (best-effort)

### TypeScript (tsc --noEmit)
Status: **OK**
```

```

### ESLint
No config detectado o no se ejecutó.

### Madge circular deps
Status: **FAIL**
```
npm warn exec The following package was not found and will be installed: madge@8.0.0
npm error code ECOMPROMISED
npm error Lock compromised
npm error A complete log of this run can be found in: C:\Users\martin\AppData\Local\npm-cache\_logs\2026-05-17T04_24_16_573Z-debug-0.log
```

## Raw findings (muestras)

### Nested buttons
- App.tsx
- components/BookViewer.tsx
- components/GenerationDashboard.tsx
- components/TableOfContents.tsx
- scripts/healthcheck.mjs
- scripts/masterdoc-static-check.cjs
- scripts/ui-audit.cjs

### Unsafe .map (muestra)
- App.tsx
  - L249: (state as any).outline_12 = ensureArray<any>((state as any).outline_12, []).map((o: any, idx: number) => {
  - L266: (state as any).chapters = ensureArray<any>((state as any).chapters, []).map((c: any, idx: number) => {
  - L405: .map((s: any) => ({
  - L493: const run = () => setProjects((prev) => prev.map((p) => (p.id === projectId ? updater(p) : p)));
  - L524: return prev.map((p) => (p.id === projectId ? full : p));
  - L533: const prevById = new Map(prev.map((p) => [p.id, p]));
- components/BookProposalDisplay.tsx
  - L54: {proposal.titleOptions.map((title, i) => (
  - L64: {proposal.subtitleOptions.map((subtitle, i) => (
- components/BookViewer.tsx
  - L185: .map((c) => s(c?.text, ''))
  - L242: return React.Children.map(children, (child) => {
  - L304: if (keyPoints.length) outlineParts.push(`**Puntos clave:**\n\n${keyPoints.map((x) => `- ${x}`).join('\n')}`);
  - L307: if (subheads.length) outlineParts.push(`**Subtítulos (H2):**\n\n${subheads.map((x) => `- ${x}`).join('\n')}`);
  - L310: if (tools.length) outlineParts.push(`**Herramientas / Frameworks:**\n\n${tools.map((x) => `- ${x}`).join('\n')}`);
  - L313: if (exercises.length) outlineParts.push(`**Ejercicios:**\n\n${exercises.map((x) => `- ${x}`).join('\n')}`);
  - L327: .map((c, idx) => ({ c, n: getChapterNumber(c, idx) }))
  - L419: if (keyPoints.length) parts.push(`**Puntos clave:**\n\n${keyPoints.map((x) => `- ${x}`).join('\n')}`);
  - L429: .map((c, idx) => ({ c, cn: getChapterNumber(c, idx) }))
  - L478: .map((c, idx) => ({ c, n: getChapterNumber(c, idx) }))
- components/ChatInterface.tsx
  - L46: {messages.map((msg) => (
- components/GenerationDashboard.tsx
  - L284: {list.map((t, i) => (
  - L584: {outline12.map((ch: any) => {

### Autoselect patterns
—

### VITE secrets usage
- App.tsx
- src/lib/supabase.ts

### GoogleGenAI usage in frontend
- App.tsx

### localStorage usage
- components/BookViewer.tsx
- components/GenerationDashboard.tsx
