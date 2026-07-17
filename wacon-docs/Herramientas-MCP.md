---
tags: [wacon, mcp, tools]
---

# Herramientas MCP

25 tools, 2 resources, 1 prompt. Definidos una sola vez en `mcp/server.ts` contra la interfaz `WaconApi` (ver [[Arquitectura]]).

## Sesión
| Tool | Nota |
|---|---|
| `whatsapp_status` | Primer diagnóstico si algo falla |
| `whatsapp_login` | QR como image block + texto; rota cada ~30s |

## Lectura
| Tool | Nota |
|---|---|
| `list_chats` | Orden por actividad |
| `read_messages` | Paginado con `before_timestamp` |
| `search_messages` | FTS5 keyword exacto |
| `recall_context` | ⭐ [[RAG-Hibrido]] — el retrieval preferido |
| `search_contacts` | Nombre/número → JID |
| `get_group_info` | Participantes + admins |

## Atención (ahorro de tokens) — [[Atencion-y-Tokens]]
| Tool | Nota |
|---|---|
| `wait_for_messages` | ⭐ Long-poll: bloquea hasta que llega algo. Sustituye el bucle de polling |
| `start_watch` / `stop_watch` / `watch_status` | Reglas + triaje determinístico; expiran solas (máx 240 min) |
| `suggest_watch_window` | ¿Vale la pena esperar? Poisson sobre 8 semanas de historial |
| `get_digest` | Catch-up comprimido por chat |
| `set_presence` | `unavailable` = sigilo (default); `available` = aparecer en línea |
| `mark_read` | Tics azules explícitos — leer nunca los envía solo |

## Memoria
| Tool | Nota |
|---|---|
| `get_contact_profile` | Obligatorio antes de enviar; lazy-genera stats |
| `update_contact_profile` | Observaciones cualitativas por sección |
| `analyze_contact` | Recomputa [[Analyzer\|stats]] |
| `get_persona` | persona.md |
| `list_episodes` / `read_episode` / `summarize_episode` | Ciclo de [[Episodios]] |
| `wacon_init` | Análisis masivo inicial |

## Envío
| Tool | Nota |
|---|---|
| `send_message` | Workflow completo en su descripción; pasa por [[Guardrails-y-Seguridad\|guardrails]] |

## Resources y prompt
- `wacon://persona`, `wacon://profile/{chat}`
- Prompt `reply_in_style` — arma perfil+persona+últimos 25 mensajes y pide la respuesta en la voz del usuario

> [!note] Los tools enseñan el workflow
> La descripción de `send_message` codifica el flujo perfil→contexto→recall→redactar→consolidar. Cualquier agente MCP genérico, sin la [[Skill-para-Agentes|skill]], recibe igualmente las instrucciones críticas.
