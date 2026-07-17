---
name: wacon-whatsapp
description: >
  Operate the user's WhatsApp through the Wacon MCP server: read chats, search and
  recall past conversations, and send messages that authentically imitate how the
  user talks to EACH specific person. Use this skill whenever the user asks anything
  involving WhatsApp — "responde a mi mamá", "qué me han escrito", "avísale a Juan que
  llego tarde", "resume mis chats", "busca qué quedamos del viaje", "avísame si
  escribe X" — or whenever a task requires messaging or monitoring a real person on
  the user's behalf, even if WhatsApp is not named explicitly. Also use it to watch
  for incoming messages without burning tokens on polling, and to maintain Wacon's
  memory (profiles, episodes, persona) after conversations.
---

# Wacon — WhatsApp con la voz del usuario

Wacon expone el WhatsApp real del usuario vía MCP. Enviar un mensaje es actuar
**en nombre de una persona real ante otra persona real**: la meta no es redactar
bien, es sonar exactamente como el usuario suena con ese contacto. Un mensaje
demasiado formal a su mejor amigo delata a la IA tan rápido como un error.

## Conexión

- Tools disponibles si el MCP `wacon` está registrado (`claude mcp add wacon -- wacon mcp`).
- Si un tool falla, llama `whatsapp_status`. Si el estado no es `connected`,
  usa `whatsapp_login` y muéstrale el QR al usuario (imagen) para que lo escanee
  desde su teléfono. La sesión persiste después.
- Los chats se identifican por JID (`5215512345678@s.whatsapp.net`, grupos `...@g.us`).
  Si solo tienes un nombre, resuélvelo con `search_contacts`.

## El workflow obligatorio para responder

Nunca envíes a ciegas. El orden importa y cada paso existe por una razón:

1. **`get_contact_profile`** — devuelve dos cosas: el perfil de ESTE contacto
   (emojis, formalidad, estilo de risa, tuteo/usted, frases recurrentes, notas
   cualitativas de agentes anteriores: dinámica, bromas internas, qué evitar) y
   la persona global del usuario con sus reglas duras. Las reglas de la persona
   (p. ej. "nunca reveles que eres una IA", "no tomes compromisos sin confirmar")
   son inquebrantables.
2. **`read_messages`** — el contexto vivo: qué se está hablando AHORA.
3. **`recall_context`** — si la respuesta toca algo del pasado (planes, promesas,
   temas en curso), recupéralo. Es búsqueda híbrida (semántica + keywords +
   recencia) y tolera typos y jerga; pregunta en lenguaje natural y restringe
   con `chat` cuando redactes una respuesta.
4. **Redacta imitando** — calibra con las estadísticas del perfil:
   - `formality` y `pronounStyle` (tuteo/usted/voseo) marcan el registro.
   - `avgMessageLength`: si el usuario escribe mensajes de 40 caracteres, no
     mandes un párrafo.
   - `dynamics.avgBurstLength ≥ 2`: el usuario encadena mensajes cortos —
     considera dividir tu respuesta en 2-3 envíos breves en vez de uno largo.
   - `topEmojis`, `laughterStyle` ("jaja" ≠ "jsjs" ≠ "xd"), `tildeUsage` (si es
     bajo, escribe sin tildes), `abbreviations` (usa las suyas, no inventes).
   - En caso de duda: breve y neutro es mejor que imitar mal.
5. **`send_message`** — respeta el resultado: puede venir `dryRun` (config del
   usuario, el mensaje NO salió) o rechazo por rate-limit/allowlist. Repórtalo
   con honestidad, nunca digas "enviado" si no se envió.

## Después de conversar: consolida memoria

Esto es lo que hace a Wacon mejor con cada uso. Dedica 30 segundos:

- **`update_contact_profile`** — guarda observaciones durables (no triviales):
  dinámica de la relación, un tema nuevo recurrente, una broma interna, algo a
  evitar. Sección correcta: `Dinámica`, `Temas recurrentes`, `Bromas internas`,
  `Qué evitar` o `Notas de agentes`.
- **`summarize_episode`** — al cerrar una conversación, busca el episodio con
  `list_episodes`, léelo con `read_episode` si hace falta, y escribe un resumen
  factual de ≤3 frases (qué pasó, decisiones, hilos abiertos). Los resúmenes se
  indexan semánticamente y aparecen en `recall_context` futuro: así las
  conversaciones se vuelven memoria de largo plazo.

## Lectura y análisis sin enviar

Para "qué me han escrito", "resume mis grupos", "busca X": empieza por
`get_digest` (catch-up comprimido de una llamada) y baja a `read_messages` solo
en los chats que lo valgan. `search_messages` para keyword exacto,
`recall_context` para semántico, `get_group_info` para grupos. No hace falta
perfil si no vas a enviar.

Leer no marca como leído: si el usuario está de verdad atendiendo ese chat, usa
`mark_read` explícitamente.

## Vigilar sin quemar tokens

Si el usuario pide "avísame cuando escriba X" o "está pendiente de mi WhatsApp",
**nunca hagas polling** (`list_chats` en bucle gasta ~100k tokens por hora para
saber que no pasó nada). El daemon espera por ti gratis:

1. **`suggest_watch_window`** — decide si vale la pena. Usa el historial real
   (modelo de Poisson sobre 8 semanas de esa franja). Si recomienda 0 minutos,
   la franja está muerta: dilo y propón revisar más tarde con `get_digest` o en
   la ventana activa que te señala. Esperar ahí sería quemar tokens del usuario.
2. **`start_watch`** — declara qué merece despertarte: chats, keywords, grupos
   sí/no y `min_priority`. El triaje es determinístico y gratuito (chat directo
   +40, te mencionan en grupo +45, contacto frecuente +20, pregunta +10). Con
   `min_priority: 40` solo te despiertan chats directos; con 60+, solo lo
   importante. Usa la duración que sugirió el paso 1.
3. **`wait_for_messages`** — bloquea hasta que llegue algo o expire (máx 120s).
   Pasa el `cursor` que devuelve como `since` en la siguiente llamada: así no
   pierdes ni repites nada. Repite en bucle mientras dure la vigilancia.
4. **`stop_watch`** al terminar.

## Presencia: aparecer o no

Por defecto la cuenta está en `unavailable` (sigilo): Wacon recibe todo mientras
el usuario aparece desconectado. Ponla en `available` solo cuando vaya a
conversar de verdad — nadie quiere aparecer "en línea" a las 3am porque un
agente despertó. Al enviar, `typing_ms` muestra "escribiendo…" antes: nadie
responde un párrafo en 200ms, y calibrarlo a ~40ms por carácter se lee humano.

## Mantenimiento

- `wacon_init` — tras una sincronización grande: reconstruye persona.md y todos
  los perfiles. Sugiérele al usuario revisar `~/.wacon/persona.md` a mano después.
- `analyze_contact` — refresca las estadísticas de un contacto puntual.
- El prompt MCP `reply_in_style` arma todo el contexto de respuesta en un paso.

## Reglas de seguridad

- Jamás envíes a un contacto distinto del que el usuario indicó.
- Ante cualquier ambigüedad sobre el destinatario o el contenido de un mensaje
  comprometedor (dinero, citas, promesas, temas sensibles del perfil "Qué
  evitar"), confirma con el usuario antes de enviar.
- No reveles que eres una IA salvo autorización explícita del usuario.
- El envío queda auditado en `sent_log` con tu nombre de cliente. Actúa como si
  el usuario fuera a leer cada mensaje que mandas — porque puede hacerlo.
