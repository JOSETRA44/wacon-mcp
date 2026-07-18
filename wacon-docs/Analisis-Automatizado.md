---
tags: [wacon, analisis, automatizacion, rag]
---

# Análisis Automatizado (motor de dos niveles)

Responde a la pregunta clave: **¿siempre tiene que intervenir un agente LLM para analizar?** No. Wacon hace el trabajo duro por fuerza bruta (sin tokens) y deja al agente como pulido opcional sobre datos pre-masticados.

## Tier 1 — Extractor determinístico (`src/analysis/`, 0 tokens)

`wacon init [all|<chat>|--contacts|--groups|--courses]` lanza un **job en el daemon** que recorre los chats y por cada uno produce:

| Salida | Cómo | Reusa |
|---|---|---|
| Estilo + dinámica + perfil | `analyzeStyle`/`analyzeDynamics` | [[Analyzer]] |
| Episodios + **digest extractivo** | segmentación + `extractiveDigest` (elige mensajes salientes) | [[Episodios]] |
| **Hechos candidatos** | `extractors.ts`: regex español (fechas, ocupación, gustos, lugares, relación) → baja confianza, `(?)`, `source_msg_id` | [[Sistema-de-Memoria]] |
| **Accionables de grupos** | `extractActionables`: examen/entrega/TIF/fecha → `suggested_events` (NO calendario) | — |

Todo local, sin dependencias, sin IA. Verificado sobre 37k mensajes reales: 67 chats en segundos → 31 perfiles, 1326 episodios, 152 sugerencias.

## Progreso visible

El daemon expone un `AnalysisJob` mutable; el CLI lo consulta cada 500 ms y pinta una barra:

```
[■■■■■■■■■■■■■□□□□□□□□□□□] 36/67  Microeconomía - 2 "A"  8h 966ep 78sug
```

Como el daemon hace el trabajo, **el humano (`wacon init`) o un agente (`analysis_status`) ven el mismo progreso**.

## Tier 2 — Enriquecimiento por agente (OPCIONAL, barato)

El agente ya no lee historial crudo. `get_analysis_bundle(chat)` le entrega **todo pre-masticado**: estilo, dinámica, hechos confirmados, **hechos candidatos** (confirma los buenos con `remember_fact`, ignora el resto), episodios con digest, y accionables. Enriquecer un bundle cuesta una fracción de leer el chat entero.

## Calidad / honestidad

- Hechos auto: confianza 0.3–0.5, marcados `(?)`, con `source_msg_id`. El extractor a veces sobre-captura (p.ej. "objetivo: trabajar entonces…") — por eso son tentativos y descartables. Nunca se presentan como certeros.
- Digests: prefijados `[auto]`; el agente los reescribe a narrativa.
- Accionables: **solo sugerencias**; `confirm_suggested_event` las promueve a evento real tras revisión (el calendario nunca se llena solo).

## Herramientas

CLI: `wacon init [all|--contacts|--groups|--courses|<chat>]`, `wacon suggested [--confirm id|--dismiss id]`.
MCP: `run_bulk_analysis`, `analysis_status`, `get_analysis_bundle`, `list_suggested_events`, `confirm_suggested_event`, `dismiss_suggested_event`.

Relacionado: [[Sistema-de-Memoria]], [[Inteligencia-y-Playbook]], [[Herramientas-MCP]], [[Roadmap]]
