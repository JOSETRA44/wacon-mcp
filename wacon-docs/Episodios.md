---
tags: [wacon, memoria, episodios]
---

# Episodios

Memoria episódica al estilo humano: el historial de cada chat se segmenta en **conversaciones** separadas por >3h de silencio (`rebuildEpisodes`, upsert por `(chat_jid, start_ts)` que preserva resúmenes existentes).

## El ciclo de consolidación

1. `list_episodes` — muestra episodios; los que no tienen resumen son trabajo pendiente.
2. `read_episode` — el agente lee la conversación completa.
3. `summarize_episode` — escribe ≤3 frases factuales (qué pasó, decisiones, hilos abiertos). El resumen se vectoriza y entra al índice de [[RAG-Hibrido]].

> [!note] División de trabajo deliberada
> El sistema **segmenta** (barato, determinístico); el agente **comprende y resume** (caro, LLM — pero el agente ya está corriendo cuando conversa). Wacon nunca paga tokens por sí mismo: convierte el uso normal de los agentes en memoria de largo plazo.

## Efecto acumulativo

Cada conversación atendida por un agente deja: contexto consolidado (episodio) + observaciones de estilo (perfil). Wacon mejora con el uso — la personalización es creciente, no estática.

Relacionado: [[Sistema-de-Memoria]], [[Herramientas-MCP]]
