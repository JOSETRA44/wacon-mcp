---
tags: [wacon, multimedia, proactividad, calendario]
---

# Multimedia y Proactividad

Wacon deja de ser ciego, sordo, atemporal y puramente reactivo. Tres pilares sobre la arquitectura existente ([[Arquitectura]], [[Atencion-y-Tokens]]).

## Pilar 1 — Vista y oído (multimedia agnóstico)

### Captura
En `connection.ts`, cada mensaje con `imageMessage/audioMessage/videoMessage/documentMessage/stickerMessage` deja:
- un **stub descargable** en la tabla `media` (mediaKey b64, directPath, url, mimetype, duración…) → permite re-descargar tras reinicios vía `downloadContentFromMessage`.
- el `WAMessage` completo en un **LRU en memoria** (200) → vía rápida con `downloadMediaMessage` + reintento si la URL de WhatsApp expiró.
- un **placeholder** en el texto (`[imagen] usa view_image(id)`, `[nota de voz 0:12] usa transcribe_audio(id)`) para que `read_messages`/`prepare_reply` sean coherentes y el agente sepa qué inspeccionar.

### Entrega por capas (sin lock-in, sin peso)
| | Capa 1 (default, zero-dep) | Capa 2 (opcional, config) |
|---|---|---|
| **Imagen** (`view_image`) | **image content block** MCP → el agente lo ve con su visión nativa | `vision.backend` openai-compatible → descripción por API |
| **Audio** (`transcribe_audio`) | **audio content block** MCP → agentes multimodales lo escuchan | `transcription.backend`: `openai-compatible` (fetch, sin deps) o `whispercpp` (binario local) |

`~/.wacon/media/` cachea los binarios descargados. `maxMediaBytes` (16 MB) evita blobs gigantes. `wacon doctor` reporta qué backends hay. Nada nuevo pesa en el paquete: la descarga es de Baileys, la transcripción es `fetch` o un binario que el usuario instala a demanda.

## Pilar 2 — Regla anti-fraude

Ante CUALQUIER fallo multimedia (descarga rota, audio corrupto, API caída) Wacon **jamás** devuelve un error crudo. `src/core/errors.ts`:
- `logError()` registra el error real en la tabla `error_log` y **nunca relanza** (ni siquiera si el propio log falla).
- Devuelve al agente una **directriz natural** (`GUIDANCE`): *"No pude escuchar esta nota de voz; si es importante pídele que te la escriba, o no respondas a ese audio."* El agente nunca ve "Error 500 / decode failed", y nunca responde el error al chat.
- Tool `get_error_log` + CLI **`wacon errors`** para auditar y corregir después.

Verificado: pedir un audio inexistente → el agente recibe la guía natural, el error técnico queda solo en `wacon errors`.

## Pilar 3 — Tiempo, calendario/tareas y motor proactivo

### Conciencia del tiempo
`prepare_reply` y `get_agenda` inyectan `now` (`"viernes, 17 de julio de 2026, 01:11"`, ISO, tz) → el agente resuelve "el próximo viernes", "mañana".

### Agenda local (tablas `events`, `tasks`)
- Tools: `schedule_event`, `list_events`, `cancel_event`, `complete_event`, `add_task`, `list_tasks`, `complete_task`, `get_agenda`.
- CLI para el humano: **`wacon calendar`**, **`wacon tasks`** — total visibilidad de lo que el bot planea.

### Motor proactivo (`src/core/scheduler.ts`)
Un `setInterval` (sin dep de cron) en el daemon escanea eventos con `notify_ts` vencido y `status='scheduled'`, los marca `fired` (una sola vez) y **emite un trigger** al bus de atención (`WatchRegistry.emitTrigger`).

**`wait_for_triggers`** es el long-poll que despierta al agente por un mensaje entrante **o** por un evento vencido. Un agente en bucle (p.ej. `/loop` de Claude Code) recibe *"Cita con María — 30 min hasta inicio"* y **decide** si manda "Hola María, ¿sigue en pie lo de las 5?". **El daemon nunca envía solo** — agente en el loop, confirmado por el usuario. El cursor (`triggerCursor`) evita repetir.

Verificado end-to-end: evento agendado → scheduler disparó → `wait_for_triggers` bloqueado despertó con el contexto correcto.

## Flujo del agente enriquecido
`prepare_reply` (ahora con `now` + eventos próximos) → si hay imagen/audio, `view_image`/`transcribe_audio` → redactar → `send_message` → persistir (`remember_fact`, `schedule_event` si surge una cita, `summarize_episode`).

Relacionado: [[Arquitectura]], [[Atencion-y-Tokens]], [[Inteligencia-y-Playbook]], [[Herramientas-MCP]], [[Roadmap]]
