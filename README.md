# Wacon — WhatsApp AI CLI + MCP Server

Wacon conecta tu WhatsApp con agentes de IA (Claude Code, o cualquier cliente MCP) y con tu terminal. Su diferencial: **memoria de estilo por contacto** — los agentes no solo pueden leer y enviar mensajes, sino hacerlo imitando cómo TÚ le hablas a cada persona.

> ⚠️ **Advertencia**: Wacon usa [Baileys](https://github.com/WhiskeySockets/Baileys), una librería no oficial de ingeniería inversa del protocolo de WhatsApp Web. Esto **viola los Términos de Servicio de WhatsApp** y tu número puede ser **baneado permanentemente**. Úsalo bajo tu propio riesgo, idealmente con un número secundario. El rate-limit integrado reduce el riesgo, no lo elimina.

## Instalación

```bash
npm install
npm run build
npm link        # deja el comando `wacon` disponible globalmente
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

## Sistema de memoria

| Capa | Quién la escribe | Qué contiene |
|---|---|---|
| Stats (frontmatter YAML) | `analyze_contact` / `wacon init` — determinístico, sin LLM | emojis frecuentes, formalidad, estilo de risa, longitud, frases recurrentes, horarios |
| Notas cualitativas (cuerpo .md) | Agentes vía `update_contact_profile` (y tú, a mano) | dinámica de la relación, temas, bromas internas, qué evitar |
| `persona.md` | `wacon init` + **tú** | tu voz global y reglas duras para los agentes |

Flujo esperado de un agente antes de enviar: `get_contact_profile` → `read_messages` → redactar → `send_message` → `update_contact_profile`.

## Herramientas MCP

`whatsapp_status`, `whatsapp_login` (QR como imagen), `list_chats`, `read_messages`, `search_messages` (full-text), `search_contacts`, `get_group_info`, `send_message`, `get_contact_profile`, `update_contact_profile`, `analyze_contact`, `get_persona`, `wacon_init` — más resources (`wacon://persona`, `wacon://profile/{chat}`) y el prompt `reply_in_style`.

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
wacon login | logout | status
wacon chats | read <chat> | send <chat> <texto> | search <query> | contacts <nombre>
wacon init | profile <chat> [--note "..." --section "..."] | persona
wacon daemon start|stop|log | config | mcp
```

## Seguridad

- El daemon escucha solo en `127.0.0.1` y exige un token aleatorio por sesión.
- Las credenciales de WhatsApp viven en `~/.wacon/auth/` **en claro** (igual que en cualquier setup Baileys): protege tu cuenta de usuario de Windows.
- Nada sale de tu máquina: mensajes, perfiles y análisis son 100% locales.
