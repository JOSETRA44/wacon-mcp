---
tags: [wacon, stickers, multimedia, personalizacion]
---

# Stickers

Cierra el último hueco de autenticidad: donde el usuario pondría un sticker, el agente ya no escribe `[sticker]` — **elige uno y lo manda**.

## Dos orígenes (por autenticidad)

| Origen | Qué es | Por qué |
|---|---|---|
| `own` | Stickers que el usuario **realmente envió** (webp de WhatsApp, re-descargados de su mensaje original) | Lo más auténtico: son SUS stickers |
| `pack` | Pack **gatitos** incluido (10 webp 512×512) | Respaldo cuando la librería propia es escasa |

El pack de gatitos se generó desde **Twemoji (CC-BY 4.0)** con `scripts/build-cat-stickers.mjs` y se versiona como assets ya renderizados → **cero dependencias de imagen en runtime**. Se eligieron caras de gato porque cada una ya codifica una emoción distinta: 😹 risa · 😻 cariño · 😺 saludo · 😸 ok · 😼 travieso · 😽 beso · 🙀 sorpresa · 😿 disculpa · 😾 molesto · 🐱 neutral.

## El significado se aprende del contexto (sin IA)

`inferMood()` mira **el texto que precede** a cada sticker que el usuario envió:

| Texto previo | Mood |
|---|---|
| "jajaja que risa" | `risa` |
| "Perdón, me pasé verdad?" | `disculpa` |
| "Hola Nayda" | `saludo` |
| "Si me parece bien" | `ok` |

Verificado sobre datos reales: los stickers que José mandó tras disculparse con Nayda quedaron etiquetados `disculpa` automáticamente.

## Cuándo enviarlo — afinidad por contacto

`stickerAffinity()` mide qué fracción de los mensajes del usuario a ESE contacto son stickers, y devuelve un consejo:

- **≥25%** → "los usas muy seguido, encajan de forma natural" (con Nayda: **27%**)
- 8–25% → "de vez en cuando, uno puntual está bien"
- **<8%** → "casi nunca — mejor solo texto"

Así el agente **replica el hábito real** en vez de espolvorear stickers. También expone los moods que el usuario usa con ese contacto.

## Herramientas

- `list_stickers({ mood?, chat? })` — candidatos por mood + afinidad/hábitos del contacto.
- `send_sticker(chat, sticker_id)` — envía por Baileys (`sendMessage({ sticker })`).
- `sync_stickers` — reindexa packs + stickers propios.
- CLI: `wacon stickers [--sync] [-m mood] [-c chat]`.

## Guardrails y degradación

Mismo tratamiento que el texto: rate-limit, `dryRun`, allow/block lists, y registro en `sent_log`. Si el sticker no existe o no se puede cargar, **degrada con directriz natural** ("continúa con texto — no menciones el problema al contacto"), nunca un error crudo. Verificado.

## Nota sobre la librería propia

Los stickers históricos solo son re-descargables si se capturó su *stub* de medios. Eso faltaba en el history sync (bug corregido: ahora `messaging-history.set` también captura medios), por lo que hoy hay pocos propios indexados; la librería crece sola con cada sticker nuevo. Los **hábitos** (176) sí se aprendieron de todo el historial, porque solo necesitan el texto.

Relacionado: [[Multimedia-y-Proactividad]], [[Sistema-de-Memoria]], [[Herramientas-MCP]]
