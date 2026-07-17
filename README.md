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

## Herramientas MCP (25)

**Sesión**: `whatsapp_status`, `whatsapp_login` (QR como imagen)
**Lectura**: `list_chats`, `read_messages`, `search_messages`, `recall_context` (híbrido), `search_contacts`, `get_group_info`
**Atención**: `wait_for_messages`, `start_watch`, `stop_watch`, `watch_status`, `suggest_watch_window`, `get_digest`, `set_presence`, `mark_read`
**Memoria**: `get_contact_profile`, `update_contact_profile`, `analyze_contact`, `get_persona`, `list_episodes`, `read_episode`, `summarize_episode`, `wacon_init`
**Envío**: `send_message` (con `typing_ms` para simular "escribiendo…")

Más resources (`wacon://persona`, `wacon://profile/{chat}`) y el prompt `reply_in_style`.

## Skill para agentes

En `skills/wacon-whatsapp/` hay una skill con el workflow completo. Instalación: `npx skills add JOSETRA44/wacon-mcp` o copia la carpeta a `~/.claude/skills/`. La skill también viaja dentro del paquete npm (`node_modules/wacon/skills/`).

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
wacon login | logout | status | presence <available|unavailable>
wacon chats | read <chat> | send <chat> <texto> | search <query> | contacts <nombre>
wacon watch [-m 30] [-p 40] [-g] | digest [-m 60] | window
wacon init | profile <chat> [--note "..." --section "..."] | persona
wacon daemon start|stop|log | config | mcp
```

`wacon watch` es vigilancia en vivo en la terminal con triaje por prioridad; `wacon window` te dice si vale la pena estar en línea ahora mismo.

## Seguridad

- El daemon escucha solo en `127.0.0.1` y exige un token aleatorio por sesión.
- Las credenciales de WhatsApp viven en `~/.wacon/auth/` **en claro** (igual que en cualquier setup Baileys): protege tu cuenta de usuario de Windows.
- Nada sale de tu máquina: mensajes, perfiles y análisis son 100% locales.
