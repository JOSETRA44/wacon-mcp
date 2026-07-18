---
tags: [wacon, index]
---

# 🧠 Wacon — Cerebro del proyecto

Wacon es un CLI + servidor MCP que conecta WhatsApp con agentes de IA, con **memoria de estilo por contacto** para que los agentes escriban con la voz real del usuario.

> [!warning] Riesgo asumido
> Usa [[Baileys]] (ingeniería inversa, viola ToS de WhatsApp). Riesgo de ban mitigado — no eliminado — por los [[Guardrails-y-Seguridad|guardrails]].

## Mapa

- [[Arquitectura]] — daemon único, shims, flujo de datos
- [[Sistema-de-Memoria]] — las tres capas de personalización
- [[RAG-Hibrido]] — retrieval sin modelos externos
- [[Episodios]] — memoria episódica consolidada por agentes
- [[Analyzer]] — análisis determinístico del lenguaje
- [[Atencion-y-Tokens]] — long-poll, triaje y predicción de actividad
- [[Inteligencia-y-Playbook]] — memoria bidimensional + NotebookLM
- [[Multimedia-y-Proactividad]] — vista/oído, anti-fraude, calendario proactivo
- [[Analisis-Automatizado]] — motor de dos niveles: fuerza bruta + pulido opcional del agente
- [[Herramientas-MCP]] — los 54 tools + resources + prompt
- [[Guardrails-y-Seguridad]]
- [[Skill-para-Agentes]] — la skill instalable
- [[Roadmap]]

## Estado (2026-07-16)

- v0.1.0 funcional, sesión real vinculada, historial sincronizando
- Memoria v2 (RAG híbrido + episodios + analyzer v2) integrada
- [[Atencion-y-Tokens|Atención v1]]: long-poll verificado, triaje determinístico, predicción Poisson
- [[Inteligencia-y-Playbook|Inteligencia v1]]: hechos por contacto + NotebookLM (playbook real verificado con citas)
- [[Multimedia-y-Proactividad|Multimedia v1]]: imágenes/audio por bloques MCP nativos, anti-fraude, calendario proactivo (trigger real verificado)
- 49 tests en verde; typecheck estricto limpio
- Empaquetado: instalable por npm / GitHub / npx
