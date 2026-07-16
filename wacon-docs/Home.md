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
- [[Herramientas-MCP]] — los 17 tools + resources + prompt
- [[Guardrails-y-Seguridad]]
- [[Skill-para-Agentes]] — la skill instalable
- [[Roadmap]]

## Estado (2026-07-16)

- v0.1.0 funcional, sesión real vinculada, historial sincronizando
- Memoria v2 (RAG híbrido + episodios + analyzer v2) integrada
- 11 tests en verde; typecheck estricto limpio
