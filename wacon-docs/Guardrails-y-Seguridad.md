---
tags: [wacon, seguridad]
---

# Guardrails y Seguridad

## Capa de envío (`core/guardrails.ts`)

Todo envío — CLI, MCP stdio, MCP HTTP — pasa por `checkSend`:

1. `blockedChats` — rechazo absoluto
2. `allowedChats` — si no está vacío, allowlist estricta
3. Rate limit — `sendRateLimitPerMinute` (default 10) contra la tabla `sent_log`
4. `dryRun` — se loguea pero NO sale; el tool devuelve el motivo

Auditoría: cada envío queda en `sent_log` con `client_name` (cli / stdio-agent / http-agent) y flag de dry-run.

## Superficie de red

- Daemon **solo en 127.0.0.1**; token aleatorio de 48 hex por arranque en `~/.wacon/daemon.json`
- `/health` público (loopback) — necesario para el auto-spawn; solo expone estado
- `/rpc` con whitelist de métodos; `/mcp` con el mismo Bearer

## Datos

- Credenciales Baileys en claro en `~/.wacon/auth/` (limitación estándar de Baileys) → la frontera de confianza es la cuenta de usuario del SO
- Nada sale de la máquina: mensajes, vectores, perfiles y análisis son 100% locales

## Riesgo de ban

> [!warning]
> Baileys viola los ToS de WhatsApp. Mitigaciones: rate limit conservador, `markOnlineOnConnect: false`, sin envíos masivos. El riesgo residual lo asume el usuario (idealmente con número secundario).

Relacionado: [[Arquitectura]], [[Herramientas-MCP]]
