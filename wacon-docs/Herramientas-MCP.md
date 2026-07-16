---
tags: [wacon, mcp, tools]
---

# Herramientas MCP

17 tools, 2 resources, 1 prompt. Definidos una sola vez en `mcp/server.ts` contra la interfaz `WaconApi` (ver [[Arquitectura]]).

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
