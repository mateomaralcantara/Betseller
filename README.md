# BestSeller Jobs Architecture — capítulos completos sin romperse

Esta base cambia la lógica:

ANTES:
Click → Gemini genera capítulo largo → app espera → JSON roto.

AHORA:
Click → crea job → worker genera por bloques → guarda capítulo → frontend consulta progreso.

## Pasos

1. Ejecuta `supabase/migrations/20260525_generation_jobs.sql` en Supabase SQL Editor.
2. Copia los archivos `src/lib`, `src/hooks`, `src/components` y `worker`.
3. Instala dependencias:

```powershell
npm install @supabase/supabase-js @google/genai dotenv tsx
```

4. Crea `worker/.env` usando `worker/.env.example`.
5. En `package.json`, agrega:

```json
"worker": "tsx worker/generationWorker.ts"
```

6. Aplica los parches de `docs/APP_PATCH.md` y `docs/DASHBOARD_PATCH.md`.

## Ejecutar

Terminal 1:

```powershell
npm run dev
```

Terminal 2:

```powershell
npm run worker
```

## Importante

Ningún sistema serio puede garantizar que un capítulo largo sea instantáneo.
Lo que sí hace esta arquitectura:

- no bloquea la UI;
- evita JSON roto;
- genera por bloques;
- guarda progreso;
- permite varios workers;
- soporta más usuarios con cola.
