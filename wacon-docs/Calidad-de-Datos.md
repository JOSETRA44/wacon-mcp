---
tags: [wacon, calidad, persona, analisis]
---

# Calidad de datos (qué cuenta como "tu voz")

Lección aprendida analizando WhatsApp real: **medir mal es peor que no medir**. La persona salía contaminada y ningún agente lo habría notado.

## El problema que encontramos

`persona.md` describía a José así:

- longitud media **162 caracteres** (su media real con amigos: ~24)
- frases recurrentes: `"not null"`, `"message id"`, `"usa view"`, `"image message"`, `"id uuid"`
- se ríe con `"xd"`, emojis ✅💡✨🔗📝

Nada de eso era su voz. Tres fuentes de contaminación:

1. **Los placeholders de Wacon.** Al recibir media guardamos `"[imagen] usa view_image(message_id)"` como texto del mensaje. El analizador los contaba como palabras suyas → la persona estaba aprendiendo a "hablar" como nuestra propia herramienta. **Bug nuestro.**
2. **Código y SQL pegados.** `id uuid NOT NULL DEFAULT…` no dice nada de cómo alguien chatea.
3. **Un chat dominante.** El chat con Meta AI (755 mensajes suyos) ahogaba sus conversaciones humanas.

## Las tres correcciones

### `isAuthoredText()` (`memory/analyzer.ts`)
Filtra lo que **no** es prosa del usuario: placeholders de media, código/SQL/JSON, y links solos. Se aplica en `analyzeStyle` y también en los extractores de hechos (un placeholder nunca es una afirmación sobre una persona).

### URLs fuera del vocabulario
Un mensaje como *"mira esto https://…"* **sí** es escritura real, así que no se descarta: se le **quitan las URLs** antes de analizar. Eso eliminó `"https www"`, `"ssl cf2"`, `"rackcdn com"` de las frases recurrentes.

### Muestreo equilibrado (`balancedOutgoingSample`)
Para la persona global se toma un máximo por chat (120) y solo chats 1-a-1. Así ningún chat pesado —un asistente de IA, un grupo de trabajo— define la voz del usuario.

## Resultado medible

| | Antes | Después |
|---|---|---|
| Longitud media | 162 car. | **53 car.** |
| Frases top | "not null", "message id", "usa view" | **"buenas noches", "buenas tardes", "muchas gracias"** |

## La persona ya no es una plantilla vacía

`draftPersonaBody()` genera un borrador **con evidencia**: tono, longitud, cómo se ríe, si usa tildes, abreviaciones — y una sección **"Cómo sueno"** con mensajes reales suyos ("Holaa Nayda", "Técnicamente si, cae un sábado"). Las ediciones a mano nunca se pisan: solo se reemplaza la plantilla intacta (`isTemplateBody`).

`wacon doctor` avisa si la persona sigue en blanco, porque una persona vacía degrada **cada** mensaje que un agente envía.

## Principio

Los datos que alimentan la personalización necesitan la misma exigencia que el código: **si no puedes rastrear un dato hasta un mensaje real del usuario, no es un dato sobre el usuario.** Lo mismo aplica a los hechos auto-extraídos, que por eso van con confianza baja y `(?)`.

Relacionado: [[Analyzer]], [[Analisis-Automatizado]], [[Sistema-de-Memoria]]
