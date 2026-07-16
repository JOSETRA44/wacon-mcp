---
tags: [wacon, memoria]
---

# Sistema de Memoria

El reto central: que un agente escriba **como el usuario le escribe a ESA persona**. Tres capas, cada una con el mecanismo más barato que la resuelve:

## 1. Capa cuantitativa — [[Analyzer]]

Estadísticas determinísticas (regex + conteos, sin LLM) sobre los mensajes salientes del usuario: emojis, formalidad, tuteo/usted/voseo, tildes, abreviaciones, estilo de risa, longitud, ráfagas, latencia de respuesta, iniciativa. Milisegundos por contacto. Viven en el frontmatter YAML de `profiles/<jid>.md`.

## 2. Capa cualitativa — agentes

Lo que las regex no ven: dinámica de la relación, bromas internas, qué evitar. Los agentes lo escriben en el cuerpo Markdown del perfil vía `update_contact_profile` y lo leen antes de cada envío. **El perfil es legible y editable por el humano** — Markdown plano, sin base de datos opaca.

## 3. Capa de recuperación — [[RAG-Hibrido]] + [[Episodios]]

El contexto compartido (planes, promesas, temas en curso) se recupera con búsqueda híbrida, y las conversaciones cerradas se consolidan en resúmenes indexados semánticamente.

## persona.md

La voz **global** del usuario + reglas duras para agentes ("no reveles que eres IA", "no comprometas dinero"). Semillada por `wacon init` desde TODOS los mensajes salientes; el usuario la edita a mano y es la máxima autoridad.

> [!tip] Por qué Markdown y no una DB
> Los perfiles son contratos entre humano y agentes. Ambos deben poder leerlos, corregirlos y versionarlos (git). La parte que sí necesita índices (mensajes, vectores) vive en SQLite.

Relacionado: [[Arquitectura]], [[Herramientas-MCP]]
