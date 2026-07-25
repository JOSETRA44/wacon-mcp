---
tags: [wacon, cli, terminal, agentes]
---

# CLI y Terminal

Wacon tiene **dos audiencias con necesidades opuestas**. Los humanos quieren color, interactividad y mensajes en vivo; los agentes se **envenenan** con eso — un código ANSI perdido en su contexto es un bug real, no una molestia estética.

La decisión fue **separarlas en vez de buscar un punto medio**, porque una interfaz interactiva no se puede automatizar y una salida limpia no es agradable de leer.

| Audiencia | Superficie | Forma |
|---|---|---|
| **Humano** | `wacon chat` | Interactivo, con color, en vivo |
| **Agente** | Resto de comandos + MCP | No interactivo, `--json`, cero ANSI |

## El problema que había (verificado)

```
$ wacon inbox | cat -v
^[[33m[55]^[[39m ^[[1mLazo^[[22m  ^[[2mhace 1h^[[22m
```

Cualquier agente que usara la CLI se llevaba eso al contexto. **Ya no**:

```
$ wacon inbox --json | cat -v | grep -c '\^\['
0
```

## Cómo se garantiza

Todo comando de datos pasa por `emit(data, render)` (`src/cli/output.ts`):

- Con `--json` imprime el objeto del daemon **tal cual**, y el renderizador humano **ni siquiera se ejecuta**.
- El color se apaga con `--no-color`, con `NO_COLOR`, en modo json, y **cuando `stdout` no es un TTY**. No se confía solo en la detección de la librería: la prueba de arriba demostró que no bastaba.
- Los errores también son estructurados en modo json (`{ok:false, error}`), siempre con código de salida 1.

Centralizarlo en un helper evita que un comando futuro se olvide.

## `wacon chat` — WhatsApp en la terminal

Cliente de chat clásico, **sin dependencias nuevas** (`readline` + ANSI mínimo). Se eligió sobre una TUI de pantalla completa porque conserva el **scrollback y el copiar/pegar nativos** de la terminal, arranca al instante y no añade peso.

```
── Nayda Quispe UTP · conectado · vistos: off ──────────
 08:12 p.m.  Nayda  nos reuniremos a las 9.30
 07:55 p.m.  yo     Si me parece bien
> _
```

- `wacon chat` → lista las conversaciones **pendientes** (reusa `inbox`) para elegir.
- `wacon chat <contacto>` → abre directo; resuelve nombre/número/JID (maneja el split `@lid`).
- **En vivo**: long-poll (`waitForMessages`) imprime lo entrante **encima** de tu línea de escritura sin romper lo que estás tecleando.
- **Escribiendo…**: manda presencia `composing` mientras tecleas, como un cliente real.
- Comandos: `/chats`, `/switch`, `/read`, `/search`, `/sticker <mood>`, `/who`, `/help`, `/quit`.
- Enviar pasa por los guardrails de siempre (rate limit, `dryRun`, allowlist); si se bloquea, se dice.

Es **solo para humanos** a propósito: una TUI interactiva necesita pty y bloquea, así que un agente no puede pilotarla. `wacon chat --json` lo rechaza con un error parseable en vez de colgarse.

## Enviar archivos

Un solo camino para todo: `send_file` detecta el tipo por la extensión y lo manda como WhatsApp espera.

| Extensión | Cómo llega |
|---|---|
| `.jpg .png .webp .gif` | Imagen con vista previa (+ caption) |
| `.mp4 .mov .mkv` | Video con vista previa |
| `.ogg .mp3 .m4a .wav` | Audio — o **nota de voz** real con `as_voice_note` |
| `.pdf .docx .xlsx .zip`… | Documento con su nombre de archivo |
| cualquier otra | Documento (nada queda sin poder enviarse) |

Desde el chat: `/send C:\ruta\informe.pdf mira esto` · `/send nota.ogg --voz`
Para agentes: la tool MCP `send_file` (rutas absolutas).

Mismos guardrails que el texto (rate limit, `dryRun`, allowlist) y degradación con directriz si falla — verificado: archivo inexistente devuelve guía natural, nunca una excepción.

## Dos clientes humanos, un solo motor

| Comando | Qué es | Cuándo |
|---|---|---|
| `wacon chat` | Cliente línea a línea, cero dependencias | Rápido, por SSH, terminales pobres, un vistazo |
| `wacon chat ultra` (alias `wacon tui`) | **App de pantalla completa** estilo WhatsApp Web | Vivir en WhatsApp desde la terminal |

Ambos son **pura presentación** sobre el mismo `DaemonClient` — cero lógica de WhatsApp duplicada. Comparten helpers en `src/cli/chat-core.ts` (resolución de contacto `@lid`, clasificación de media, apertura en el visor del SO).

## `wacon chat ultra` — la app de terminal

```
┌ Chats ───────────┬ Nayda Quispe UTP · vistos: off ────────────────┐
│› Nayda        2  │  08:12  Nayda  nos reuniremos a las 9.30        │
│  Brandon         │  07:55  yo     Si me parece bien                │
│  Anderson     1  │  09:41  yo     Perdón, me pasé verdad?          │
├──────────────────┴────────────────────────────────────────────────┤
│ > escribe un mensaje…                                              │
│  Wacon · N chats · Tab paneles · / buscar · Ctrl+O adjuntar · ?    │
└─────────────────────────────────────────────────────────────────────┘
```

- **Panel izquierdo**: lista de chats (pendientes primero, badge de no leídos, el activo resaltado). Los mensajes que llegan de otros chats **suben ese chat arriba** con su badge.
- **Panel derecho**: conversación con scroll nativo y feed en vivo (mismo long-poll `waitForMessages`).
- **Teclas** (no comandos crípticos): `↑↓` mover · `Tab` alternar panel · `Enter` abrir/enviar · `/` buscar chat · `Ctrl+F` buscar en la conversación · `Ctrl+O` adjuntar archivo · `Ctrl+S` sticker · `Enter` sobre la conversación abre la última media · `?`/`F1` ayuda · `Ctrl+C` sale y **restaura la terminal**.

**Motor**: `neo-blessed` (JS puro, sin binarios nativos), **cargado perezosamente** con `await import()` solo al entrar a este modo — los agentes y el resto de comandos no lo cargan nunca (verificado: `wacon inbox --json` sigue sin ANSI y sin tocar blessed). Sin TTY o sin la dependencia, degrada con un mensaje claro que remite a `wacon chat`.

## Descubribilidad: que se aprenda usándolo

El problema de un cliente de terminal es que **esconde sus funciones detrás de comandos que nadie sabe que existen**. Lo peor era quedarse dentro de un chat sin una salida obvia.

**Tres capas, de menos a más intrusivo:**

1. **Pista permanente** bajo la cabecera: `Esc volver a la lista · /help comandos · Tab autocompletar`. Siempre visible, no hay que recordarla.
2. **Tecla real, no solo comando**: `Esc` (o `Ctrl+B`) vuelve a la lista. Además se aceptan todos los sinónimos que alguien intentaría: `/atras`, `/volver`, `/lista`, `/menu`, `/back`, `/chats`.
3. **Tips progresivos** (`src/cli/tips.ts`): uno por sesión, en orden de necesidad, **sin repetirse nunca** (persistidos en `~/.wacon/tips-seen.json`). El primero enseña justo la salida:

```
💡 Pulsa Esc para volver a la lista de chats (o escribe /atras).
💡 Tab autocompleta comandos y nombres: prueba /switch na + Tab.
```

Cuando se agotan, callan — quien ya sabe usar la herramienta no necesita que le insistan. Y si alguien escribe un comando que no existe, ese es el momento perfecto para recordarle cómo salir.

## Ver imágenes y oír audios

Una terminal no puede mostrar imágenes de forma fiable, así que **no peleamos con eso**: cada archivo recibido se numera y `/ver <n>` lo guarda y lo abre con **el visor de tu sistema** — que es lo que harías igualmente, y funciona en todas partes.

```
 08:12 p.m.  Nayda  [imagen] /ver 2
 08:13 p.m.  Nayda  [nota de voz 0:17] /ver 3
```

- **Imágenes/videos** → se abren en tu visor. Si tienes backend de visión configurado, además verás la descripción (`👁`).
- **Audios** → si hay transcripción configurada, la lees directamente (`🎧`); si no, se abre en tu reproductor.

## Menos fricción en el chat

Cuatro problemas concretos que tenía y cómo se arreglaron:

| Fricción | Solución |
|---|---|
| Si otro te escribía mientras estabas en un chat, **no te enterabas** (se descartaba en silencio) | Aviso en línea: `💬 Brandon: hola · /2 para ir` |
| Cambiar de chat exigía comandos exactos | **`/1`…`/9`** salta al chat que te avisó; `/switch` acepta nombres parciales |
| Al salir perdías dónde estabas | Se recuerda el último chat: **enter** en el selector lo retoma |
| No había autocompletado | **Tab** completa comandos y nombres de contactos |

## Tics azules: se resuelven solos

No se inventó ningún ajuste. Baileys ya consulta la privacidad de la cuenta (`Socket/messages-send.js`):

```js
const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self';
```

Con los vistos **desactivados** (el caso del usuario, verificado: `readReceiptsMode → "off"`), marcar como leído envía `read-self`: se marca en tus dispositivos y **no notifica al otro**. Por eso `wacon chat` marca como leído al abrir con total normalidad, y la cabecera muestra `vistos: on/off` para que no haya sorpresas.

Relacionado: [[Productividad]], [[Arquitectura]], [[Herramientas-MCP]]
