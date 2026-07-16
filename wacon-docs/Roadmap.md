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
- [x] Tests (analyzer, vectorizador, recall e2e)

## Siguiente

- [ ] Media: enviar/recibir imágenes, audio, documentos (Baileys ya lo soporta)
- [ ] Resolución de JIDs `@lid` → contactos reales (WhatsApp está migrando a LIDs de privacidad; hoy algunos chats salen "(sin nombre)")
- [ ] `wacon watch` — modo escucha: notificar a un agente cuando llegan mensajes (webhook local o cola)
- [ ] Scheduler: recordatorios/mensajes programados vía episodios abiertos
- [ ] Embeddings reales opcionales (sqlite-vec + modelo local) detrás de `vectorCandidates`
- [ ] Cifrado de `~/.wacon/auth/` con DPAPI en Windows
- [ ] Multi-cuenta (varios números → varios daemons con WACON_HOME distintos)

## Ideas

- Grafo de relaciones entre contactos (grupos compartidos, menciones)
- "Personalidad del día": el usuario ajusta el tono global temporalmente
- Export de perfiles a vault Obsidian del usuario
