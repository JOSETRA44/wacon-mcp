---
tags: [wacon, productividad, grupos]
---

# Productividad

Wacon no es solo para *contestar*: su mayor valor es **ayudarte a ponerte al día** con una bandeja que se te fue de las manos. Todo determinístico, sin tokens.

## `get_inbox` — qué te falta responder

Chats donde **el último mensaje lo mandó la otra persona** → la pelota está en tu campo. Ordenados por prioridad:

| Señal | Peso |
|---|---|
| Chat directo (no grupo) | +35 |
| Te preguntaron algo (`?`) | +25 |
| Mensajes acumulados sin responder | hasta +20 |
| Reciente (<48h) | +20 |

> [!warning] Los canales no cuentan
> Los **canales de WhatsApp (`@newsletter`)** son de solo difusión: no puedes responderles. Al principio inundaban la bandeja con "641 mensajes sin responder" y enterraban a las personas reales. Se excluyen (junto a `@bot` y `@broadcast`) de la bandeja y del análisis de contactos.

## `get_commitments` — lo que prometiste

Busca mensajes tuyos con forma de promesa (*"te aviso"*, *"mañana te mando"*, *"yo te confirmo"*) donde **no volviste a escribir en ese chat después** — pelotas caídas probables.

Deliberadamente conservador: si seguiste conversando, se asume que lo resolviste; y el pasado (*"ya te envié los archivos"*) no es una promesa. Mejor no detectar nada que acusarte en falso — verificado sobre datos reales, donde devolvió **cero** correctamente.

## `get_briefing` — empezar el día

Una llamada: hora actual, pendientes por responder, compromisos abiertos, qué llegó desde la última vez, próximos eventos y tareas. Es el "ponme al día" completo.

CLI: `wacon inbox`, `wacon commitments`, `wacon brief`.

---

# Perfilado de miembros de grupo

Un grupo es una **mina de datos**: decenas de personas escribiendo miles de mensajes. Como cada participante tiene un **identificador estable**, sus mensajes se pueden analizar por separado.

- `list_group_members(group)` — quién participa, cuánto escribe, si ya tiene perfil.
- `analyze_group_members(group)` — construye para **cada miembro** un perfil de estilo (cómo escribe) + hechos candidatos que reveló sobre sí mismo.

Así, cuando esa persona te escriba en privado —o necesites dirigirte a ella en el grupo— ya hay contexto. Es ingesta masiva: un grupo → muchas memorias de contacto, sin gastar un token.

Verificado en un grupo real: identificó 10 participantes por nombre y construyó 9 perfiles individuales.

> [!note] Limitación de datos
> El autor de un mensaje de grupo viaja en `key.participant`, pero el **history sync** lo entregaba vacío: los mensajes históricos de grupo quedaron sin autor y esos miembros no son perfilables hasta re-sincronizar. `toRow` ahora prueba todos los campos conocidos (`participant`, `participantAlt`, `msg.participant`), así que todo lo nuevo sí se atribuye.

Relacionado: [[Atencion-y-Tokens]], [[Analisis-Automatizado]], [[Herramientas-MCP]]
