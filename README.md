<div align="center">

# Wacon

**Tu WhatsApp, tu terminal, tus agentes de IA.**

Lee conversaciones, organiza pendientes y prepara respuestas con memoria por contacto.

[![WhatsApp](https://img.shields.io/badge/WhatsApp-CLI_%2B_MCP-25D366?style=flat-square&logo=whatsapp&logoColor=white)](#qué-puedes-hacer)
[![npm](https://img.shields.io/badge/npm-%40josetra%2Fwacon-CB3837?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@josetra/wacon)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5_22.18.0-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Licencia MIT](https://img.shields.io/badge/Licencia-MIT-64748B?style=flat-square)](LICENSE)

[Instalación](#instalación) · [Primeros pasos](#primeros-pasos) · [Conectar un agente](#conectar-un-agente) · [Configuración](#configuración) · [Desarrollo](#desarrollo)

</div>

---
<img width="1917" height="1022" alt="image" src="https://github.com/user-attachments/assets/dc8a062f-f489-43cf-9d84-b8ce1b61a8ba" />
Wacon es un **CLI y servidor MCP para WhatsApp**. Comparte una misma sesión entre la terminal y tus agentes, conserva el contexto de las conversaciones y permite trabajar con mensajes, archivos, recordatorios y perfiles de estilo.

El almacenamiento y el análisis básico funcionan en tu equipo. Las integraciones con modelos, voz y NotebookLM son opcionales.

## Qué puedes hacer

| | Capacidad | Para qué sirve |
| --- | --- | --- |
| 💬 | **Conversaciones en la terminal** | Leer, buscar, responder y abrir una interfaz de pantalla completa. |
| 🧠 | **Memoria por contacto** | Combinar hechos, notas de relación, estilo de escritura e historial relevante. |
| 🔌 | **Herramientas MCP** | Dar acceso a tus agentes a conversaciones, contexto, agenda y envíos. |
| 📥 | **Bandeja y productividad** | Revisar pendientes, compromisos detectados, tareas y eventos. |
| 🖼️ | **Archivos y multimedia** | Enviar documentos, imágenes, stickers y notas de voz con un backend configurado. |
| ⏱️ | **Seguimiento de mensajes** | Esperar novedades con filtros y long polling, sin consultar continuamente el historial. |

## Instalación

Requiere **Node.js 22.18.0 o superior**, npm y una cuenta de WhatsApp para vincular el dispositivo.

### Desde npm

```bash
npm install -g @josetra/wacon
wacon --version
```

El paquete se llama `@josetra/wacon`; el comando instalado es `wacon`.

También puedes ejecutarlo sin instalación global:

```bash
npx -y @josetra/wacon login
```

### Desde GitHub

Disponible para instalar directamente desde el código fuente:

```bash
npm install -g github:JOSETRA44/wacon-mcp
```

Esta vía requiere Git y compila el proyecto durante la instalación. Wacon incluye dependencias nativas; si no hay un binario precompilado compatible con tu plataforma, la instalación puede requerir herramientas de compilación de C++.

## Primeros pasos

**1. Vincula tu cuenta.**

```bash
wacon login
```

En WhatsApp, abre **Dispositivos vinculados → Vincular un dispositivo** y escanea el QR de la terminal.

**2. Comprueba la conexión y explora tus conversaciones.**

```bash
wacon status
wacon chats
wacon inbox
```

**3. Abre el cliente que prefieras.**

```bash
wacon chat          # Chat ligero
wacon chat ultra    # Interfaz de pantalla completa
wacon tui           # Alias de la interfaz de pantalla completa
```

**4. Construye tu memoria de conversación.**

Cuando el historial esté sincronizado:

```bash
wacon init          # Analiza contactos
wacon init --all    # Incluye grupos
wacon persona      # Consulta tu perfil global
```

Revisa y edita `~/.wacon/persona.md`: define tu voz y las reglas que deben seguir los agentes. Los hechos extraídos automáticamente son candidatos de baja confianza; conviene revisarlos antes de usarlos como contexto.

## Conectar un agente

### Claude Code

Con Wacon instalado globalmente:

```bash
claude mcp add wacon -- wacon mcp
```

O usando npx:

```bash
claude mcp add wacon -- npx -y @josetra/wacon mcp
```

### Otros clientes MCP

Añade una entrada equivalente a la configuración de tu cliente:

```json
{
  "mcpServers": {
    "wacon": {
      "command": "npx",
      "args": ["-y", "@josetra/wacon", "mcp"]
    }
  }
}
```

El formato exacto depende del cliente. Si en Windows necesita ejecutar npx a través del intérprete de comandos, utiliza `"command": "cmd"` y `"args": ["/c", "npx", "-y", "@josetra/wacon", "mcp"]`.

También existe un endpoint HTTP local en `http://127.0.0.1:8317/mcp`. Requiere `Authorization: Bearer <token>`; el token de la sesión está en `~/.wacon/daemon.json`.

### Skills incluidas

El paquete contiene dos guías para agentes:

- **`wacon-whatsapp`**: conversaciones, respuestas, archivos y seguimiento.
- **`wacon-knowledge`**: análisis, perfiles, hechos y memoria episódica.

```bash
wacon skills                   # Instala las skills sin sobrescribir las existentes
wacon skills --force           # Actualiza las copias instaladas
wacon skills --target ./skills # Elige otro destino
```

Durante la instalación, Wacon intenta copiarlas a `~/.claude/skills/` si ya existe la configuración de Claude. Puedes omitir este paso con la variable de entorno `WACON_SKIP_POSTINSTALL=1`; también se omite en CI. El destino predeterminado se puede cambiar mediante `WACON_SKILLS_DIR`.

## Uso cotidiano

### Leer, buscar y responder

```bash
wacon contacts "Contacto"
wacon read "Contacto" --limit 20
wacon search "reunión"
wacon send "Contacto" "Confirmado, nos vemos a las cinco."
```

Los comandos de envío actúan sobre WhatsApp. Para ensayar sin enviar, activa `dryRun` en la configuración.

### Revisar pendientes

```bash
wacon inbox
wacon brief
wacon commitments
wacon calendar --days 7
wacon tasks
```

Los compromisos y las sugerencias se extraen del historial; revísalos antes de tratarlos como acuerdos confirmados.

### Analizar y recordar

```bash
wacon init --groups
wacon profile "Contacto"
wacon facts "Contacto"
wacon suggested
wacon suggested --confirm 12
```

Las sugerencias de eventos no se incorporan automáticamente a tu agenda: debes confirmarlas.

### Archivos, stickers y voz

Dentro del chat ligero:

```text
/send ./informe.pdf Aquí está el informe.
/send ./nota.ogg --voz
/voz Confirmado, nos vemos a las cinco.
```

Desde la terminal:

```bash
wacon stickers --sync
wacon voice "Contacto" "Confirmado, nos vemos a las cinco."
```

La síntesis de voz requiere un backend configurado. Los agentes disponen de herramientas como `send_file`, `send_sticker` y `send_voice_message`.

### Seguimiento y automatización

```bash
wacon watch --minutes 30 --min-priority 40
wacon digest --minutes 60
wacon inbox --json
```

Para scripts y agentes, los comandos de datos admiten `--json` y evitan los códigos de color. Las herramientas MCP `wait_for_messages` y `wait_for_triggers` permiten esperar novedades y recordatorios. El daemon notifica los eventos; el agente decide cómo actuar.

Consulta todas las opciones con `wacon --help` o `wacon <comando> --help`.

## Cómo funciona la memoria

Wacon combina tres fuentes de contexto:

| Fuente | Contenido |
| --- | --- |
| **Perfil global** | Tu voz y tus preferencias, editables en `persona.md`. |
| **Perfil por contacto** | Estadísticas de estilo y notas sobre la relación. |
| **Hechos e historial** | Datos estructurados, mensajes recuperados y resúmenes de episodios. |

La recuperación local combina búsqueda de texto, similitud por n-gramas y recencia. No necesita un servicio externo de embeddings. El análisis inicial usa reglas y estadísticas; un agente puede enriquecer o corregir sus resultados.

La herramienta MCP `prepare_reply` reúne el perfil, los hechos y el contexto relevante para preparar una respuesta.

## Configuración

El directorio predeterminado es `~/.wacon/` (`%USERPROFILE%\.wacon\` en Windows). Puedes cambiarlo con `WACON_HOME`.

```text
~/.wacon/
├── auth/          Credenciales de la sesión de WhatsApp
├── profiles/      Perfiles por contacto
├── wacon.db       Mensajes, hechos y agenda
├── persona.md     Tu voz y reglas para agentes
├── config.json    Preferencias y límites
├── notebooks.json Asociaciones con NotebookLM
└── daemon.json    Información de conexión local
```

Ejemplo de `config.json` para probar los flujos sin realizar envíos:

```json
{
  "dryRun": true,
  "sendRateLimitPerMinute": 10,
  "allowedChats": [],
  "blockedChats": [],
  "daemonPort": 8317
}
```

- **`dryRun`**: registra los intentos de envío sin enviarlos. Su valor predeterminado es `false`.
- **`allowedChats`**: si contiene JIDs, limita los envíos a esos chats.
- **`blockedChats`**: impide enviar a los JIDs indicados.
- **`sendRateLimitPerMinute`**: limita la frecuencia de envío.

### Integraciones opcionales

| Integración | Configuración | Uso |
| --- | --- | --- |
| **Voz** | `tts` con un endpoint compatible con OpenAI | Convertir texto en notas de voz. |
| **Transcripción** | `transcription` con API compatible o `whisper.cpp` | Convertir audio a texto. |
| **Visión** | `vision` con un endpoint compatible | Describir imágenes mediante un modelo. |
| **FFmpeg** | Disponible en PATH o mediante `ffmpegPath` | Convertir audio y preparar notas de voz. |
| **NotebookLM** | CLI `nlm` autenticado y `notebooks.json` | Consultar fuentes asociadas a chats etiquetados. |

Estas integraciones se configuran según el proveedor que utilices. Las API externas pueden tener coste y recibir el contenido que les envíes. Sin una API de visión o transcripción configurada, las herramientas MCP pueden entregar imágenes o audio al cliente para que use sus propias capacidades multimodales.

## Arquitectura y privacidad

```text
Terminal / cliente MCP
          │
          ▼
   Daemon local de Wacon
          ├── Sesión de WhatsApp mediante Baileys
          ├── SQLite: mensajes, memoria y agenda
          ├── Perfiles Markdown
          └── Integraciones opcionales
```

El daemon comparte una sesión entre clientes, escucha en `127.0.0.1` y requiere un token de acceso. Los mensajes, perfiles y análisis se almacenan localmente. Al conectar un agente o habilitar un servicio externo, el contenido solicitado puede ser procesado por ese cliente o proveedor.

Las credenciales de WhatsApp se guardan en el directorio `auth/` sin cifrado adicional de Wacon. Protege ese directorio y no lo incluyas en repositorios ni archivos compartidos.

## Diagnóstico

```bash
wacon doctor
wacon errors --tail 20
wacon daemon log
```

`wacon doctor` comprueba el estado local y las integraciones. Para reiniciar el daemon puedes usar `wacon daemon-restart`. Si necesitas volver a vincular la cuenta, revisa primero el diagnóstico y luego ejecuta `wacon login`.

## Desarrollo

```bash
git clone https://github.com/JOSETRA44/wacon-mcp.git
cd wacon-mcp
npm ci
npm run check
npm link
```

| Comando | Función |
| --- | --- |
| `npm run dev` | Compilar al cambiar los archivos. |
| `npm run typecheck` | Verificar tipos de TypeScript. |
| `npm test` | Ejecutar la suite de pruebas. |
| `npm run build` | Generar los ejecutables en `dist/`. |
| `npm run check` | Ejecutar tipos, pruebas y compilación. |

Las notas de arquitectura y diseño están en [wacon-docs](https://github.com/JOSETRA44/wacon-mcp/tree/main/wacon-docs). Para preparar una versión y configurar la publicación, consulta la [guía de releases](https://github.com/JOSETRA44/wacon-mcp/blob/main/docs/RELEASING.md).

Para reportar un problema, incluye la versión de Wacon, Node.js, el sistema operativo y los pasos para reproducirlo en [Issues](https://github.com/JOSETRA44/wacon-mcp/issues). Elimina teléfonos, mensajes privados, tokens y credenciales de los registros que compartas.

## Proyecto y licencia

Wacon es un proyecto independiente que usa [Baileys](https://github.com/WhiskeySockets/Baileys) para integrarse con WhatsApp. No es una aplicación oficial ni está afiliada a WhatsApp o Meta; el uso de clientes no oficiales puede afectar la disponibilidad de la cuenta.

Publicado bajo la [licencia MIT](LICENSE). Los stickers incluidos derivan de [Twemoji](https://github.com/jdecked/twemoji), con licencia CC BY 4.0; su atribución se conserva en el [manifest del pack](assets/stickers/cats/manifest.json).
