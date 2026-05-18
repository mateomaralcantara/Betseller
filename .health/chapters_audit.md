# Chapter Length Audit

Generated: 2026-05-17T20:50:29.852Z

Projects: **0**

Chapters in DB: **0**

> Si esto falla por RLS, usa SUPABASE_SERVICE_ROLE_KEY en .env.local (solo local, no lo subas).


## Interpretación rápida

- Si **target_words** (outline) es 3000–6000 pero en DB ves 400–800 palabras: el modelo está generando corto o tu app está pidiendo corto.
- Si ves flag **TRUNCATED?**: podría estar cortándose por tokens/stop; revisa finish reason (MAX_TOKENS) y configura maxOutputTokens.
- Token tip: 100 tokens ~ 60–80 palabras; un capítulo de 6000 palabras puede necesitar ~8k–10k tokens de salida. :contentReference[oaicite:0]{index=0}
- gemini-3.1-flash-lite soporta hasta ~65k output tokens, así que 6000 palabras deberían caber si le das maxOutputTokens suficiente. :contentReference[oaicite:1]{index=1}

