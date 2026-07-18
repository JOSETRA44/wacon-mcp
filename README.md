# Wacon — WhatsApp AI CLI + MCP Server

Wacon conecta tu WhatsApp con agentes de IA (Claude Code, o cualquier cliente MCP) y con tu terminal. Su diferencial: **memoria de estilo por contacto** — los agentes no solo pueden leer y enviar mensajes, sino hacerlo imitando cómo TÚ le hablas a cada persona.

> ⚠️ **Advertencia**: Wacon usa [Baileys](https://github.com/WhiskeySockets/Baileys), una librería no oficial de ingeniería inversa del protocolo de WhatsApp Web. Esto **viola los Términos de Servicio de WhatsApp** y tu número puede ser **baneado permanentemente**. Úsalo bajo tu propio riesgo, idealmente con un número secundario. El rate-limit integrado reduce el riesgo, no lo elimina.

## Instalación

**Desde npm** (recomendado, cuando esté publicado):

```bash
npm install -g wacon
```

**Directo desde GitHub** (sin esperar el registro — compila solo al instalar):

```bash
npm install -g github:JOSETRA44/wacon-mcp
```

**Sin instalar nada** (npx):

```bash
npx wacon login
```

**Desarrollo local**:

```bash
git clone https://github.com/JOSETRA44/wacon-mcp && cd wacon-mcp
npm install && npm link
```

## Primeros pasos

```bash
wacon login     # escanea el QR desde WhatsApp > Dispositivos vinculados
wacon status    # mira cómo crece la sincronización del historial
wacon init      # cuando haya miles de mensajes: construye persona.md y perfiles
```

Después de `wacon init`, **edita `~/.wacon/persona.md` a mano**. Es la fuente de verdad de tu voz: los agentes la leen antes de cada mensaje que envían en tu nombre.

## Registrar en Claude Code (u otro agente)

```bash
claude mcp add wacon -- wacon mcp
# o sin instalación global:
claude mcp add wacon -- npx -y wacon mcp
```

Cualquier otro cliente MCP local puede conectarse de dos formas:

- **stdio**: comando `wacon mcp`
- **HTTP**: `POST http://127.0.0.1:8317/mcp` con header `Authorization: Bearer <token>` (el token vive en `~/.wacon/daemon.json`)

Todos los clientes comparten la misma sesión: un daemon en background es el único dueño del socket de WhatsApp y arranca solo cuando hace falta.

## Arquitectura

```
agentes (stdio/HTTP) ─┐
                      ├─► wacon daemon ─► Baileys (1 socket WA)
humano (CLI) ─────────┘        │
                               ├─► ~/.wacon/wacon.db      (SQLite + FTS5)
                               ├─► ~/.wacon/profiles/*.md (estilo por contacto)
                               ├─► ~/.wacon/persona.md    (tu voz global)
                               └─► ~/.wacon/auth/         (credenciales de sesión)
```

## Sistema de memoria (3 capas)

| Capa | Quién la escribe | Qué contiene |
|---|---|---|
| Stats (frontmatter YAML) | `analyze_contact` / `wacon init` — determinístico, sin LLM | emojis, formalidad, **tuteo/usted/voseo**, idioma, uso de tildes, abreviaciones, estilo de risa, longitud, frases recurrentes, **dinámica** (latencia de respuesta, iniciativa, ráfagas) |
| Notas cualitativas (cuerpo .md) | Agentes vía `update_contact_profile` (y tú, a mano) | dinámica de la relación, temas, bromas internas, qué evitar |
| `persona.md` | `wacon init` + **tú** | tu voz global y reglas duras para los agentes |

### Recuperación híbrida (RAG local, sin modelos externos)

`recall_context` combina keyword (FTS5/BM25) + similitud semántica (vectores de n-gramas hasheados, robustos a typos: "q onda" ≈ "qué onda") + recencia, fusionados con RRF. Y **memoria episódica**: el historial se segmenta en conversaciones (>3h de silencio); los agentes las consolidan con `summarize_episode` y esos resúmenes emergen en recalls futuros. Wacon mejora con cada uso.

Flujo de un agente: `get_contact_profile` → `read_messages` → `recall_context` → redactar → `send_message` → `update_contact_profile` + `summarize_episode`.

## Atención y ahorro de tokens

Un agente que hace polling (`list_chats` cada 30s) gasta ~100k tokens por hora para aprender "no pasó nada". Wacon invierte eso: **el daemon espera y filtra gratis**.

- **`wait_for_messages`** — long-poll: bloquea server-side y responde en el instante en que llega un mensaje (o al expirar, máx 120s). La misma hora de vigilancia ≈ 2.4k tokens (~40× menos). Un `cursor` monotónico garantiza no perder ni repetir eventos.
- **`start_watch`** — reglas declarativas (chats, keywords, grupos, prioridad mínima) + **triaje determinístico sin LLM**: cada mensaje recibe un score 0-100 (chat directo +40, te mencionan +45, contacto frecuente +20, pregunta +10…). Solo te despiertan los que importan. Expiran solas (máx 240 min).
- **`suggest_watch_window`** — "¿vale la pena esperar aquí?" respondido con un modelo de Poisson sobre 8 semanas de tu historial. Si la franja está muerta recomienda **0 minutos** y señala la próxima ventana activa.
- **`get_digest`** — catch-up comprimido por chat en una sola llamada.
- **`set_presence`** — `unavailable` (default) es **modo sigilo**: recibes todo mientras apareces desconectado. Nadie ve "en línea" a las 3am porque un agente despertó. Leer nunca marca como leído: los tics azules exigen `mark_read` explícito.

## Inteligencia: razonar antes de responder

Memoria **bidimensional** por contacto (las dos dimensiones no se mezclan porque viven en almacenamientos distintos):

- **Hechos de la persona** (dim 1) — quién es, gustos, cumpleaños, objetivos. Átomos en SQLite con dedup y detección de huecos: `remember_fact`, `get_contact_facts`. Re-registrar un hecho cambiado lo **actualiza**, no duplica.
- **Dinámica de interacción** (dim 2) — confianza, bromas internas, tono. Markdown editable: `update_contact_profile`.

**Playbook externo (NotebookLM)** para chats especiales: etiqueta un chat (`tag_chat` con `seduccion`, `ventas`, `debate`…) y Wacon consulta tus libros cargados en NotebookLM (`consult_playbook`) para dar consejos con citas, **fusionados con los hechos del contacto**. Wacon orquesta la consulta internamente vía el CLI `nlm` — cualquier agente lo aprovecha sin configurar nada. Si NotebookLM falla, **degrada** con elegancia (nunca rompe la respuesta). Configura el mapeo tag→notebook en `~/.wacon/notebooks.json`.

**`prepare_reply(chat, situation)`** es el centro: **una llamada** arma el briefing completo (persona + hechos + dinámica + recall + playbook si el chat es especial) y activa "escribiendo…". Reemplaza 5 llamadas → ahorra tokens; los chats no especiales saltan NotebookLM.

**`wacon doctor`** diagnostica todo: WhatsApp, DB, daemon, NotebookLM (nlm autenticado + notebooks existen) y disco.

## Multimedia, tiempo y proactividad

Wacon ya no es ciego, sordo ni atemporal:

- **Vista y oído (agnóstico, sin inflar el paquete):** cuando un contacto manda una imagen o nota de voz, `read_messages` lo marca con un placeholder; `view_image` la devuelve como **bloque de imagen MCP** (el agente la ve con su visión nativa) y `transcribe_audio` como **bloque de audio MCP** (agentes multimodales la escuchan). Capa 2 opcional, configurable en `~/.wacon/config.json`: describir imágenes por API de visión, o transcribir audio con un endpoint compatible OpenAI (Groq/OpenAI/local) o `whisper.cpp` local — se instalan a demanda, nada pesa por defecto.
- **Regla anti-fraude:** si algo multimedia falla (descarga rota, audio corrupto, API caída), Wacon **nunca** devuelve un error crudo al agente ni al chat; registra el error real localmente y entrega una directriz natural ("no pude escuchar esta nota de voz; pídele que te la escriba"). Revísalos con `wacon errors`.
- **Conciencia del tiempo + agenda:** `prepare_reply` y `get_agenda` inyectan la fecha/hora actual (el agente entiende "el próximo viernes"). El agente puede `schedule_event`/`add_task`; tú los ves con **`wacon calendar`** y **`wacon tasks`**.
- **Motor proactivo:** el daemon vigila la agenda y, a la hora de aviso de un evento, despierta a un agente que esté escuchando con **`wait_for_triggers`** (long-poll que devuelve mensajes entrantes **y** eventos vencidos). El agente decide si envía un mensaje proactivo ("Hola María, ¿sigue en pie lo de las 5?"). **El daemon nunca envía solo.** Patrón de uso: corre un agente en bucle (p.ej. `/loop` de Claude Code) llamando `wait_for_triggers`.

## Análisis automatizado (fuerza bruta, sin tokens)

`wacon init` ya no es solo estadísticas: es un **motor de dos niveles** que evita analizar chat por chat.

- **Tier 1 (determinístico, 0 tokens):** `wacon init [all | --contacts | --groups | --courses | <chat>]` lanza un job en el daemon que, por cada chat, construye perfil de estilo+dinámica, segmenta episodios con **resúmenes extractivos**, extrae **hechos candidatos** (regex: fechas, trabajo, gustos, lugares — baja confianza, marcados `(?)`, confirmables) y recoge **accionables de grupos** (exámenes, entregas) como **sugerencias**. Con una **barra de progreso en vivo** — el humano o un agente ven el mismo avance (`analysis_status`). Probado: 67 chats reales en segundos.
- **Tier 2 (agente, opcional y barato):** el agente llama `get_analysis_bundle(chat)` y recibe todo **pre-masticado** (estilo, hechos, candidatos, episodios, accionables) — enriquece en vez de leer el historial crudo. **Ya no hace falta un agente para tener datos**; solo para pulirlos.
- **Sugerencias, no auto-agenda:** los accionables de grupos van a `wacon suggested`; `--confirm <id>` los promueve a evento real (el calendario nunca se llena solo).

```bash
wacon init all          # todo (incluidos grupos), barra de progreso en vivo
wacon init --courses    # solo grupos de cursos de la universidad
wacon suggested         # accionables detectados; --confirm <id> para agendar
```

## Stickers

Donde tú pondrías un sticker, el agente ahora **elige uno y lo manda**:

- **Tus propios stickers primero** (los que realmente enviaste, ya en webp), más un **pack de gatitos incluido** (10 webp 512×512 generados desde [Twemoji](https://github.com/jdecked/twemoji), CC-BY 4.0) como respaldo — sin dependencias de imagen en runtime.
- **El significado se aprende del contexto, sin IA:** el texto anterior al sticker define su mood (tras "Perdón, me pasé" → `disculpa`; tras "jajaja" → `risa`).
- **Cuándo enviarlo:** `list_stickers({chat})` mide tu **afinidad real** con ese contacto (con Nayda: 27% de tus mensajes son stickers → "encajan de forma natural"; si fuera <8%, el agente manda solo texto).

```bash
wacon stickers --sync        # indexa pack + tus stickers
wacon stickers -c nayda      # afinidad y moods con ese contacto
```

## Herramientas MCP (57)

**Sesión**: `whatsapp_status`, `whatsapp_login` (QR como imagen)
**Lectura**: `list_chats`, `read_messages`, `search_messages`, `recall_context` (híbrido), `search_contacts`, `get_group_info`
**Atención**: `wait_for_messages`, `start_watch`, `stop_watch`, `watch_status`, `suggest_watch_window`, `get_digest`, `set_presence`, `mark_read`
**Memoria**: `get_contact_profile`, `update_contact_profile`, `analyze_contact`, `get_persona`, `list_episodes`, `read_episode`, `summarize_episode`, `wacon_init`
**Inteligencia**: `prepare_reply`, `remember_fact`, `forget_fact`, `get_contact_facts`, `tag_chat`, `untag_chat`, `list_special_chats`, `consult_playbook`, `wacon_doctor`
**Análisis**: `run_bulk_analysis`, `analysis_status`, `get_analysis_bundle`, `list_suggested_events`, `confirm_suggested_event`, `dismiss_suggested_event`, `resolve_contact`, `list_analysis_targets`
**Stickers**: `list_stickers`, `send_sticker`, `sync_stickers`
**Multimedia**: `view_image`, `transcribe_audio`, `get_error_log`
**Tiempo/agenda**: `schedule_event`, `list_events`, `cancel_event`, `complete_event`, `add_task`, `list_tasks`, `complete_task`, `get_agenda`, `wait_for_triggers`
**Envío**: `send_message` (con `typing_ms` para simular "escribiendo…")

Más resources (`wacon://persona`, `wacon://profile/{chat}`) y el prompt `reply_in_style`.

## Skill para agentes

Dos skills, una por trabajo:

- **`wacon-whatsapp`** — conversar: leer, responder en tu voz, stickers, proactividad.
- **`wacon-knowledge`** — analizar: construir y mantener la base de conocimiento (análisis masivo, bundles, hechos, episodios, persona).

Instalación: `npx skills add JOSETRA44/wacon-mcp` o copia las carpetas a `~/.claude/skills/`. Viajan dentro del paquete npm (`node_modules/wacon/skills/`).

## Calidad de datos

La personalización solo sirve si mide bien. Wacon distingue **tu prosa real** del ruido: descarta sus propios placeholders de media, código/SQL pegado y links sueltos; quita las URLs antes de extraer vocabulario; y equilibra el muestreo por chat para que un chat pesado (un bot, un grupo enorme) no defina tu voz. Eso bajó tu longitud media medida de 162 a 53 caracteres y cambió tus "frases recurrentes" de `"not null"`/`"message id"` a `"buenas noches"`/`"muchas gracias"`. Detalle en `wacon-docs/Calidad-de-Datos.md`.

Tu `persona.md` ya no nace vacía: `wacon init` redacta un borrador **con evidencia** (tono, longitud, cómo te ríes, tildes, abreviaciones y ejemplos de mensajes tuyos reales) que luego editas a mano — `wacon doctor` te avisa si sigue en blanco.

## Documentación de diseño

`wacon-docs/` es un vault de Obsidian con el "cerebro" del proyecto: arquitectura, decisiones, sistema de memoria y roadmap, todo enlazado con wikilinks. Ábrelo como vault en Obsidian.

## Guardrails (`~/.wacon/config.json`)

```json
{
  "dryRun": false,              // true = los envíos se loguean pero NO salen
  "sendRateLimitPerMinute": 10, // tope duro de envíos
  "allowedChats": [],           // si no está vacío, SOLO se puede enviar a estos JIDs
  "blockedChats": [],           // envíos siempre rechazados
  "daemonPort": 8317
}
```

Recomendado para las primeras pruebas: `"dryRun": true`, o `allowedChats` con solo tu propio JID. Todo envío queda auditado en la tabla `sent_log` con el nombre del cliente que lo hizo.

## CLI

```
wacon login | logout | status | presence <available|unavailable> | doctor
wacon chats | read <chat> | send <chat> <texto> | search <query> | contacts <nombre>
wacon watch [-m 30] [-p 40] [-g] | digest [-m 60] | window
wacon init | profile <chat> [--note "..."] | persona
wacon facts <chat> [--add "..." --category ...] | tag <chat> <tag> | untag | special
wacon playbook <chat> "<situación>"
wacon calendar [-d 30] | tasks | errors [--tail 20]
wacon daemon start|stop|log | config | mcp
```

`wacon doctor` verifica que todo (incluido NotebookLM) esté sano; `wacon playbook` consulta tus libros de persuasión para un chat especial.

`wacon watch` es vigilancia en vivo en la terminal con triaje por prioridad; `wacon window` te dice si vale la pena estar en línea ahora mismo.

## Seguridad

- El daemon escucha solo en `127.0.0.1` y exige un token aleatorio por sesión.
- Las credenciales de WhatsApp viven en `~/.wacon/auth/` **en claro** (igual que en cualquier setup Baileys): protege tu cuenta de usuario de Windows.
- Nada sale de tu máquina: mensajes, perfiles y análisis son 100% locales.
