---
tags: [wacon, memoria, lenguaje]
---

# Analyzer — análisis determinístico del lenguaje

`memory/analyzer.ts`. Dos funciones puras:

## `analyzeStyle(salientes, dynamics?)` → StyleStats

Sobre los mensajes **que el usuario envió** en un chat:

- `formality` (formal/neutral/casual) por marcadores léxicos ES + risa + emojis
- `pronounStyle`: **tuteo / usted / voseo** (los marcadores de voseo pesan ×3 por ser raros pero inequívocos: "tenés", "sos", "decíme")
- `language`: es / en / mixed (stopwords comparadas 3:1)
- `tildeUsage`: fracción de mensajes con acentos — muchísima gente no escribe tildes en chat y un mensaje con tildes perfectas la delataría
- `abbreviations`: cuáles usa realmente (xq, tqm, ntp, tmb…)
- `laughterStyle`: jaja/jeje/jsjs/haha/xd/lol — la firma más personal del chat hispano
- `topEmojis`, `topPhrases` (bigramas, stopwords filtradas), `avgMessageLength`, `startsLowercaseRatio`, puntuación final, `peakHours`

## `analyzeDynamics(bidireccional)` → RelationshipDynamics

Sobre **ambos lados** del chat (cronológico):

- `medianReplySeconds` — mediana de latencia al responder al contacto
- `initiationRatio` — fracción de episodios iniciados por el usuario
- `avgBurstLength` — mensajes consecutivos por turno (¿escribe "en ráfagas"?)
- `messagesPerWeek` — intensidad de la relación

> [!tip] Por qué determinístico
> Regex + conteos = milisegundos, reproducible, gratis, auditable. La comprensión profunda (bromas, dinámica emocional) se delega a los agentes en la capa cualitativa de [[Sistema-de-Memoria]].

`describeStyle(stats)` genera el resumen en prosa que ven agentes y humanos en el frontmatter del perfil.
