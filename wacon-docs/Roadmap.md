---
tags: [wacon, roadmap]
---

# Roadmap

## Hecho (v0.1.x)

- [x] Daemon único + shims stdio/HTTP/CLI ([[Arquitectura]])
- [x] Sync de historial a SQLite FTS5
- [x] Perfiles Markdown + persona ([[Sistema-de-Memoria]])
- [x] [[Analyzer]] v2: idioma, pronombres, tildes, abreviaciones, dinámica
- [x] [[RAG-Hibrido]]: vectores locales + BM25 + recencia (RRF)
- [x] [[Episodios]] con consolidación agéntica
- [x] [[Skill-para-Agentes]]
- [x] [[Atencion-y-Tokens]]: long-poll, triaje por prioridad, cursor, predicción Poisson, digest, presencia/sigilo
- [x] `wacon watch` — vigilancia en vivo en terminal
- [x] Empaquetado npm/GitHub/npx + CI y workflow de publicación
- [x] Tests (analyzer, vectorizador, recall e2e, watch/long-poll/actividad)

- [x] [[Multimedia-y-Proactividad]]: recibir imágenes/audio (bloques MCP nativos + backends opcionales), regla anti-fraude con error_log, calendario/tareas y motor proactivo (`wait_for_triggers`)

- [x] **Resolución `@lid` ↔ número** (`resolve_contact`, `list_analysis_targets`): captura del mapeo LID↔PN desde `key.remoteJidAlt`, contactos y `lid-mapping.update`; nombres propagados al chat `@lid`; auto-resolución en todos los métodos de lectura/análisis; backfill por saludos para historial. Analizar por nombre o número "simplemente funciona".

## Siguiente

- [ ] **Enviar** media (imágenes/audio/documentos) — hoy solo recibimos; Baileys ya soporta el envío
- [ ] Algunos chats `@lid` de personas sin contacto guardado ni saludo por nombre siguen como "(sin nombre)" — se resuelven al reconectar (history sync trae `lidPnMappings`)
- [ ] Auto-resumen de episodios al cerrarse (hoy requiere que un agente lo pida)
- [ ] Eventos recurrentes / recordatorios repetidos en el scheduler
- [ ] Push real hacia el agente (MCP notifications) en vez de long-poll cuando el spec lo permita
- [ ] Embeddings reales opcionales (sqlite-vec + modelo local) detrás de `vectorCandidates`
- [ ] Cifrado de `~/.wacon/auth/` con DPAPI en Windows
- [ ] Multi-cuenta (varios números → varios daemons con WACON_HOME distintos)

## Ideas

- Grafo de relaciones entre contactos (grupos compartidos, menciones)
- "Personalidad del día": el usuario ajusta el tono global temporalmente
- Export de perfiles a vault Obsidian del usuario
