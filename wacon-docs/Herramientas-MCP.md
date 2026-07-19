---
tags: [wacon, mcp, tools]
---

# Herramientas MCP

57 tools, 2 resources, 1 prompt. Definidos una sola vez en `mcp/server.ts` contra la interfaz `WaconApi` (ver [[Arquitectura]]).

## Análisis automatizado — [[Analisis-Automatizado]]
| Tool | Nota |
|---|---|
| `run_bulk_analysis` | ⭐ Fuerza bruta sobre muchos chats (sin IA); responde ya, corre en el daemon |
| `analysis_status` | Progreso del job (para barra/monitoreo) |
| `get_analysis_bundle` | ⭐ Paquete pre-masticado por chat: el agente enriquece, no lee crudo |
| `list_suggested_events` / `confirm_suggested_event` / `dismiss_suggested_event` | Accionables de grupos (sugerencia → evento) |

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
| `resolve_contact` | ⭐ Nombre/número/JID → chat real con mensajes (resuelve el split `@lid`) |
| `list_analysis_targets` | Lista de trabajo priorizada para construir la base de conocimiento |
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

## Productividad — [[Productividad]]
| Tool | Nota |
|---|---|
| `get_inbox` | ⭐ Qué te falta responder, priorizado (canales excluidos) |
| `get_commitments` | Promesas tuyas sin cumplir |
| `get_briefing` | Ponte al día: pendientes + agenda + novedades |
| `list_group_members` / `analyze_group_members` | Perfil por persona dentro de un grupo |

## Multimedia y proactividad — [[Multimedia-y-Proactividad]]
| Tool | Nota |
|---|---|
| `list_stickers` / `send_sticker` / `sync_stickers` | ⭐ [[Stickers]]: candidatos por mood + afinidad del contacto |
| `view_image` | Devuelve image block MCP (visión nativa); anti-fraude |
| `transcribe_audio` | Audio block MCP (capa 1) o transcripción (capa 2); anti-fraude |
| `get_error_log` | Errores internos registrados (no se filtran al chat) |
| `schedule_event` / `list_events` / `cancel_event` / `complete_event` | Calendario |
| `add_task` / `list_tasks` / `complete_task` | Tareas |
| `get_agenda` | Hora actual + eventos + tareas (conciencia del tiempo) |
| `wait_for_triggers` | ⭐ Long-poll proactivo: mensaje entrante O evento vencido |

## Inteligencia (razonar antes de enviar) — [[Inteligencia-y-Playbook]]
| Tool | Nota |
|---|---|
| `prepare_reply` | ⭐ El centro: 1 llamada arma persona+hechos+dinámica+recall+playbook |
| `remember_fact` / `forget_fact` / `get_contact_facts` | Dim 1: hechos de la persona (dedup, huecos) |
| `tag_chat` / `untag_chat` / `list_special_chats` | Marcar chats especiales |
| `consult_playbook` | Consulta NotebookLM (persuasión); degrada elegante |
| `wacon_doctor` | Diagnóstico WhatsApp/DB/daemon/NotebookLM/disco |

## Memoria
| Tool | Nota |
|---|---|
| `get_contact_profile` | Obligatorio antes de enviar; ahora incluye facts+tags |
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
