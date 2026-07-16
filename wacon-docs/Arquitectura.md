---
tags: [wacon, arquitectura]
---

# Arquitectura

## Principio rector

WhatsApp multi-device tolera **una sola conexión WebSocket por sesión**. Todo lo demás se deriva de ahí: un daemon es el único dueño del socket [[Baileys]], y humanos + N agentes son clientes ligeros.

```
agentes MCP (stdio: `wacon mcp`) ─┐
agentes MCP (HTTP: POST /mcp)  ───┤→ daemon (127.0.0.1:8317, Bearer token)
humano (CLI `wacon <cmd>`)     ───┘        │
                                           ├→ Baileys socket (1 conexión WA)
                                           ├→ ~/.wacon/wacon.db  (SQLite WAL + FTS5 + vectores)
                                           ├→ ~/.wacon/profiles/*.md + persona.md
                                           └→ ~/.wacon/auth/ (credenciales)
```

## Piezas

| Módulo | Rol |
|---|---|
| `core/connection.ts` | Socket Baileys, QR, reconexión con backoff, eventos → store |
| `core/store.ts` | SQLite: chats, contactos, mensajes, FTS5, vectores, [[Episodios\|episodios]], sent_log |
| `core/service.ts` | **Única superficie de comportamiento** (WaconService) |
| `daemon/server.ts` | Express: `/health` público, `/rpc` whitelisted, `/mcp` Streamable HTTP |
| `daemon/lifecycle.ts` | daemon.json (puerto+token+pid), auto-spawn detached, health-poll |
| `mcp/server.ts` | `buildMcpServer(api)` — tools definidos UNA vez |
| `mcp/api.ts` | Interfaz `WaconApi`: `localApi(service)` en-daemon, `DaemonClient` por HTTP |

## Decisiones clave

- **RPC única** (`POST /rpc {method, args}` con whitelist) en vez de REST por-endpoint: el cliente HTTP es trivial y los tools tienen una sola fuente de verdad.
- **Auto-spawn**: cualquier comando o shim detecta daemon caído (health) y lo relanza detached. El usuario nunca gestiona procesos.
- **`/health` sin auth** (solo loopback): necesario para que el spawner detecte daemons vivos con token stale sin ciclos de puerto ocupado.
- **Mismo `buildMcpServer` para stdio y HTTP**: cero divergencia entre transportes.

Relacionado: [[Sistema-de-Memoria]], [[Guardrails-y-Seguridad]]
