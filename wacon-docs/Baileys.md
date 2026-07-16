---
tags: [wacon, dependencias]
---

# Baileys

`@whiskeysockets/baileys` **7.0.0-rc13** — la librería de ingeniería inversa del protocolo WhatsApp Web más mantenida (2026). Habla el WebSocket multi-device directamente: sin Chromium, sin Puppeteer.

## Por qué esta y no otras
- **whatsapp-web.js**: necesita un Chromium headless completo (pesado, frágil ante cambios de UI)
- **whatsmeow** (Go): excelente, pero partiría el stack (MCP SDK y tooling en TS)

## Cómo la usamos (`core/connection.ts`)
- `useMultiFileAuthState(~/.wacon/auth)` + `makeCacheableSignalKeyStore`
- `syncFullHistory: true`, `markOnlineOnConnect: false` (ver [[Guardrails-y-Seguridad]])
- Eventos consumidos: `connection.update` (QR/reconexión), `messaging-history.set` (sync masivo), `messages.upsert`, `chats.upsert`, `contacts.upsert`, `creds.update`
- Reconexión: backoff exponencial 2s→60s; `loggedOut` limpia credenciales

## Gotchas conocidos
- `makeInMemoryStore` fue eliminado en v7 → nuestro store SQLite propio es obligatorio (y mejor)
- JIDs `@lid` (privacy LIDs) conviven con `@s.whatsapp.net` → pendiente mapear ([[Roadmap]])
- Timestamps a veces `Long` → normalizados con `toMillis`

Relacionado: [[Arquitectura]]
