---
tags: [wacon, inteligencia, memoria, notebooklm]
---

# Inteligencia y Playbook

La capa de razonamiento **antes de enviar**. Dos aportes: memoria bidimensional de contacto y conocimiento externo (NotebookLM) para chats especiales.

## Memoria bidimensional: separación física = separación de propósito

El usuario pidió dos dimensiones que "no deben mezclarse". Wacon lo garantiza a nivel de almacenamiento — cada una vive donde mejor sirve a su propósito y al ahorro de tokens:

| Dimensión | Almacenamiento | Herramientas |
|---|---|---|
| **1. Hechos de la persona** (quién es, gustos, fechas) | SQLite `contact_facts` — átomos con dedup, confianza, categoría | `remember_fact`, `forget_fact`, `get_contact_facts` |
| **2. Dinámica de interacción** (confianza, bromas, tono) | Markdown (cuerpo del perfil) — narrativo, editable | `update_contact_profile` |
| Estilo (cómo escribe) | Frontmatter YAML | `analyze_contact` |

### Por qué los hechos son átomos en SQLite ([[Sistema-de-Memoria]])
- **Dinámicos**: `remember_fact` deduplica por texto normalizado (sin tildes/mayúsculas), así "le gusta el reggaetón" **actualiza** en vez de duplicar. La memoria crece y se corrige sola.
- **Token-eficientes**: se traen solo los relevantes, agrupados por categoría (`renderFacts`), nunca un ensayo.
- **Huecos**: `factGaps` detecta categorías de alto valor vacías (cumpleaños, ocupación, cómo se conocieron) → el agente sabe qué preguntar de forma natural. Costo 0, piggyback sobre el razonamiento que el agente ya hace.

Categorías: `identidad, ocupacion, relacion, fechas, gustos, disgustos, contexto, salud, objetivos` (`src/memory/facts.ts`).

## Playbook externo (NotebookLM)

Para chats etiquetados (`tag_chat`) como especiales, Wacon consulta libros cargados en NotebookLM antes de aconsejar.

### Decisión: **Wacon orquesta** (no el agente)
El daemon ejecuta `nlm query notebook <id> "<pregunta>" --json` (`src/knowledge/notebook.ts`). Ventajas: funciona para cualquier agente sin configurar su propio MCP, ahorra tokens (respuesta compacta), y controla el flujo. Solo **a demanda** — nunca automático.

### El flujo (`consultPlaybook`)
1. Resuelve los tags del chat → notebook (config `~/.wacon/notebooks.json`).
2. **Resuelve título→ID** (`resolveNotebookId`): el usuario configura "wacon", Wacon busca el ID real vía `nlm notebook list`. Cacheado.
3. Construye la pregunta **fusionando la situación con los hechos del contacto** (dim 1). Ejemplo real: sabiendo que le gusta "reggaetón y salsa", el consejo propuso usar justamente esa pasión como pretexto de la invitación.
4. Cache por `(tag, hash situación)` en `playbook_cache` — situaciones repetidas no re-consultan.
5. Devuelve `{advice, citations}`.

### Degradación elegante (requisito del usuario)
NotebookLM es externo y flaky (timeouts, errores API). Ante CUALQUIER fallo, `consultPlaybook` **nunca lanza**: devuelve `{degraded: true, note: "...responde con tu conocimiento general..."}`. El flujo de respuesta jamás se rompe. El parser lee el error real del cuerpo JSON aunque nlm salga con código ≠0.

### UX humana
La consulta tarda 10-30s (o más). Es **deseable**: Wacon activa presencia `composing` mientras piensa, así el contacto ve "escribiendo…" en vez de una respuesta instantánea de bot.

## `prepare_reply`: el centro

Una sola llamada arma TODO el briefing (`src/core/service.ts`):

```
prepare_reply(chat, situation?)
  → persona global + hechos (dim1) + huecos + dinámica/estilo (dim2)
    + últimos mensajes + recall del RAG + playbook (SOLO si tagged)
  · activa composing
```

**1 llamada reemplaza 5** → ahorro directo de tokens. Un chat **sin etiqueta salta NotebookLM por completo** (verificado: 0.1s vs 10-30s). Después el agente redacta, envía con `send_message` (+`typing_ms`), y persiste lo aprendido (`remember_fact`, `update_contact_profile`, `summarize_episode`).

## `wacon doctor` (`src/core/doctor.ts`)

Diagnóstico con ✓/⚠/✗ y sugerencia por ítem: sesión WhatsApp, DB local, daemon, **NotebookLM** (nlm en PATH + autenticado + notebooks del playbook existen, vía consulta real), y espacio en disco. Si NotebookLM falta, guía al usuario sin instalar nada sin permiso.

Relacionado: [[Sistema-de-Memoria]], [[RAG-Hibrido]], [[Herramientas-MCP]], [[Atencion-y-Tokens]]
