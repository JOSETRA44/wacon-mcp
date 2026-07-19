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

## Si usas la CLI en vez del MCP

Algunos agentes prefieren la terminal. Perfecto — pero **añade siempre `--json`**:

```bash
wacon inbox --json      # ✅ objeto limpio, cero códigos ANSI
wacon inbox             # ❌ pensado para humanos: colores que ensucian tu contexto
```

Con `--json` el comando imprime el objeto tal cual y los errores llegan como
`{"ok":false,"error":"..."}` con código de salida 1. Funciona en `inbox`,
`brief`, `commitments`, `chats`, `read`, `search`, `resolve`, `targets`,
`status`, `doctor` y demás comandos de datos.

`wacon chat` es la excepción: es interactivo y **solo para humanos** — no lo
lances, se quedaría bloqueado.

## Conexión

- Tools disponibles si el MCP `wacon` está registrado (`claude mcp add wacon -- wacon mcp`).
- Si un tool falla, llama `whatsapp_status`. Si el estado no es `connected`,
  usa `whatsapp_login` y muéstrale el QR al usuario (imagen) para que lo escanee
  desde su teléfono. La sesión persiste después.
- Los chats se identifican por JID (`5215512345678@s.whatsapp.net`, grupos `...@g.us`).
  Si solo tienes un nombre, resuélvelo con `search_contacts`.

## El workflow obligatorio para responder

Nunca envíes a ciegas. La forma más eficiente es **una sola llamada**:

**`prepare_reply(chat, situation)`** arma TODO el briefing de una vez y ahorra
tokens (reemplaza 5 llamadas): la persona global del usuario, los **hechos** de
la persona (dim 1: quién es, gustos, fechas) + huecos por descubrir, la
**dinámica y estilo** (dim 2: emojis, formalidad, tuteo/usted, bromas internas,
qué evitar), los últimos mensajes, el recall de memoria relevante, y —solo si el
chat está etiquetado como especial— el consejo del **playbook** (NotebookLM) con
citas. Activa "escribiendo…" mientras procesa. Pásale `situation` (qué quieres
lograr) para habilitar el recall y el playbook.

Si prefieres granular, el orden y su razón:
1. **`get_contact_profile`** — perfil (dim 2) + hechos (dim 1) + tags + persona
   global. Las reglas de la persona ("nunca reveles que eres IA", "no tomes
   compromisos sin confirmar") son inquebrantables.
2. **`get_contact_facts`** — hechos de la persona y huecos de alto valor.
3. **`read_messages`** — el contexto vivo.
4. **`recall_context`** — recupera lo del pasado (planes, promesas, temas).
5. **`consult_playbook`** — solo para chats especiales (ver abajo).
6. **Redacta imitando** — calibra con las estadísticas del perfil:
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

## Chats especiales: el playbook (NotebookLM)

Algunos chats se etiquetan como especiales (`tag_chat`: `seduccion`, `ventas`,
`debate`, `amistad`…). Para esos, antes de aconsejar puedes consultar libros
cargados en NotebookLM:

- **`consult_playbook(chat, situation)`** — devuelve consejos concretos con citas
  de las fuentes, ya fusionados con los hechos que conoces del contacto. Tarda
  10-30s (Wacon muestra "escribiendo…" — es deseable, parece humano). Solo tiene
  efecto en chats etiquetados.
- Si NotebookLM falla, la herramienta **degrada**: te dice "responde con tu
  conocimiento general". Nunca se rompe el flujo — sigue adelante con lo que sabes.
- `prepare_reply` ya incluye el playbook automáticamente si el chat está
  etiquetado, así que normalmente no necesitas llamarlo aparte.
- ¿Algo no funciona con el playbook? `wacon_doctor` diagnostica nlm/auth/notebook.

## Después de conversar: consolida memoria

Esto es lo que hace a Wacon mejor con cada uso. Dedica 30 segundos:

- **`remember_fact`** — hecho nuevo sobre la PERSONA (dim 1): su trabajo, un
  cumpleaños, un gusto fuerte, un objetivo. Se deduplica y actualiza solo. Es
  distinto de update_contact_profile (que es sobre cómo interactúan, dim 2).
- **`update_contact_profile`** — observación sobre la DINÁMICA (dim 2): relación,
  tema recurrente, broma interna, algo a evitar. Secciones: `Dinámica`,
  `Temas recurrentes`, `Bromas internas`, `Qué evitar`, `Notas de agentes`.
- **`summarize_episode`** — al cerrar una conversación, busca el episodio con
  `list_episodes`, léelo con `read_episode` si hace falta, y escribe un resumen
  factual de ≤3 frases. Los resúmenes se indexan y aparecen en `recall_context`
  futuro: así las conversaciones se vuelven memoria de largo plazo.

## Imágenes y notas de voz

Si `read_messages` muestra `[imagen] usa view_image(message_id)` o
`[nota de voz 0:12] usa transcribe_audio(message_id)`, NO ignores el contenido:

- **`view_image(chat, message_id)`** — te devuelve la imagen como bloque nativo
  para que la veas con tu propia visión. Descríbela solo a partir de lo que
  realmente ves.
- **`transcribe_audio(chat, message_id)`** — te devuelve el audio como bloque
  nativo (escúchalo si eres multimodal) o su transcripción si hay backend.
- **Regla de oro (anti-fraude):** si cualquiera de estas devuelve `ok:false` con
  una `guidance`, es un fallo real: **sigue esa directriz, NUNCA inventes** lo
  que decía el audio o mostraba la imagen, y jamás respondas el error al chat.
  Si no puedes procesar el medio, es mejor no comentar ese elemento.

## Enviar archivos

`send_file(chat, path, caption?, as_voice_note?)` manda cualquier archivo local:
imágenes y videos con vista previa, audio (o **nota de voz** con
`as_voice_note`), y PDFs/Word/Excel/zip como documento con su nombre. El tipo se
deduce de la extensión, así que no tienes que decidirlo.

Necesita una **ruta absoluta** en esta máquina. Si el usuario te pide "mándale el
informe", localiza el archivo primero y confirma cuál es antes de enviarlo — un
archivo equivocado es difícil de retirar. Si falla, recibes una directriz: sigue
en texto en vez de inventar que se envió.

## Stickers (cuándo y cuál)

El usuario manda stickers con algunos contactos y con otros no. **Replica su
hábito, no lo inventes**:

1. **`list_stickers({ chat })`** — te da la **afinidad** (qué % de sus mensajes a
   ese contacto son stickers) y los moods que usa ahí. Si dice "casi nunca",
   manda solo texto.
2. **`list_stickers({ mood, chat })`** — candidatos para el momento. Moods:
   `risa`, `carino`, `saludo`, `ok`, `travieso`, `beso`, `sorpresa`, `disculpa`,
   `molesto`, `neutral`. **Prefiere los `[propio]`** (son sus stickers reales)
   sobre los del pack de gatitos.
3. **`send_sticker(chat, sticker_id)`** — normalmente DESPUÉS del texto, en el
   beat emocional: cierre de broma (`risa`), saludo (`saludo`), calidez
   (`carino`), confirmar (`ok`), suavizar una disculpa (`disculpa`).

Nunca metas un sticker en un mensaje serio o logístico salvo que su historial lo
respalde. Si `send_sticker` falla, te devuelve una directriz: sigue en texto y no
menciones el problema al contacto.

## Tiempo, agenda y proactividad

- `prepare_reply` y `get_agenda` te dan la **fecha/hora actual** — úsala para
  resolver "mañana", "el próximo viernes".
- Si en la conversación surge una cita o pendiente, **agéndalo**:
  `schedule_event(title, start, chat?, notify_before_minutes?)` o
  `add_task(title, due?)`. El humano lo ve con `wacon calendar`/`wacon tasks`.
- **Ser proactivo:** si el usuario quiere que tomes la iniciativa, corre
  `wait_for_triggers` en bucle. Te despierta cuando llega un mensaje O cuando se
  acerca un evento agendado. Al recibir un trigger de evento (ej. "Cita con
  María — 30 min hasta inicio"), TÚ decides si mandas un mensaje proactivo
  ("¿sigue en pie lo de las 5?"). Confirma con el criterio del perfil/persona;
  ante duda, no envíes.

## Ponerse al día (productividad)

Si el usuario dice "ponme al día", "qué me falta responder", "ayúdame con mis
mensajes" o "qué quedé en hacer", **no listes chats a ciegas**:

- **`get_briefing`** — una llamada: pendientes, compromisos, novedades, agenda.
  Es la mejor forma de abrir una sesión.
- **`get_inbox`** — chats donde la otra persona habló último, priorizados (te
  preguntaron algo, mensajes acumulados, recencia). Los canales de difusión no
  aparecen porque no se les puede responder.
- **`get_commitments`** — promesas suyas sin cumplir. Verifica antes de darlas
  por incumplidas: pudo resolverlo por otro medio.

Preséntaselo por prioridad y ofrécele ayuda concreta con los primeros, no un
volcado de todo.

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

## Construir la base de conocimiento sin leer todo

No analices chat por chat leyendo el historial crudo — es caro. Wacon hace el
trabajo duro por fuerza bruta (sin tokens):

1. **`run_bulk_analysis({ mode })`** — dispara el análisis masivo (`contacts`,
   `groups`, `courses`, `all`, o `chat`). Responde al instante; corre en el daemon.
2. **`analysis_status`** — púlsalo para ver el progreso (o dile al usuario que
   mire `wacon init` con su barra en vivo).
3. **`get_analysis_bundle(chat)`** — te da TODO pre-masticado de un chat: estilo,
   dinámica, hechos confirmados, **hechos candidatos** (regex, baja confianza),
   episodios con resumen, y accionables. **Enriquece** esto: confirma los hechos
   candidatos buenos con `remember_fact`, reescribe los digests `[auto]` de
   episodios a resúmenes narrativos con `summarize_episode`. No leas el historial
   crudo salvo que el bundle no alcance.
4. **Accionables de grupos**: `list_suggested_events` → revisa → `confirm_suggested_event(id)`
   para agendar los reales (nunca se auto-agendan por seguridad).

Regla: los hechos candidatos vienen con confianza baja y `(?)` — trátalos como
hipótesis a verificar, no como certezas.

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
