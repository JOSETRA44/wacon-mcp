---
name: wacon-knowledge
description: >
  Build and maintain Wacon's knowledge base from the user's WhatsApp history:
  bulk-analyze chats, extract facts about each contact, consolidate conversation
  episodes, review actionable suggestions, and keep the user's persona accurate.
  Use this skill whenever the user asks to analyze/understand their chats, build
  or refresh the memory, "aliméntate de mis conversaciones", "analiza mis chats",
  "qué sabes de <persona>", "construye la base de datos/RAG", "actualiza los
  perfiles", after a fresh WhatsApp login or a big history sync, or when a reply
  came out generic because the memory was thin. This is the ANALYSIS job — for
  actually reading and sending messages as the user, use wacon-whatsapp instead.
---

# Wacon — construir la base de conocimiento

Tu trabajo aquí no es conversar: es **convertir el historial de WhatsApp en memoria estructurada** (perfiles de estilo, hechos por contacto, episodios resumidos, sugerencias accionables, persona del usuario).

La idea central: **Wacon ya hace el trabajo duro sin gastar tokens.** Tú no lees chats crudos uno por uno — disparas el análisis masivo determinístico y luego *enriqueces* lo que quedó pre-masticado. Leer historial completo es el último recurso, no el primero.

## Si prefieres la CLI

Todos los comandos de datos aceptan **`--json`**, que imprime el objeto tal cual
sin códigos de color (esos ensucian tu contexto). Úsalo siempre:
`wacon targets --json`, `wacon facts <chat> --json`, `wacon doctor --json`.
Nunca lances `wacon chat`: es interactivo, para humanos, y te bloquearía.

## El flujo

### 1. Comprueba que hay con qué trabajar
`whatsapp_status` (¿conectado? ¿cuántos mensajes?) y `wacon_doctor` si algo falla. Sin historial sincronizado no hay nada que analizar.

### 2. Dispara la fuerza bruta (gratis)
`run_bulk_analysis({ mode })` — corre en el daemon y responde al instante:

| mode | Cuándo |
|---|---|
| `contacts` | Por defecto: personas (chats 1-a-1) |
| `courses` | Solo grupos de cursos/universidad |
| `groups` | Todos los grupos |
| `all` | Todo |
| `chat` | Un chat concreto (`scope.chat`) |

Luego `analysis_status` para seguir el progreso (procesados/total, hechos, episodios, sugerencias). Esto construye perfiles de estilo, segmenta episodios con resúmenes extractivos, extrae **hechos candidatos** y recoge accionables — todo sin IA.

### 3. Decide dónde profundizar
`list_analysis_targets` te da la lista priorizada: quién tiene más conversación y **quién todavía no tiene hechos**. Empieza por ahí.

Filtra con criterio: los grupos de ventas, juegos o apuestas casi nunca aportan conocimiento útil sobre las personas. Los de cursos, trabajo y familia sí.

### 4. Enriquece con `get_analysis_bundle(chat)`
Te devuelve **todo lo que ya se extrajo**: estilo, dinámica, hechos confirmados, hechos candidatos, episodios (muchos con resumen `[auto]`) y accionables. Sobre eso:

- **Confirma hechos candidatos** con `remember_fact`. Vienen con confianza baja y marcados `(?)` porque los sacó una regex: son **hipótesis, no verdades**. Verifica contra los mensajes reales antes de confirmar uno, y descarta los que sean ruido (una frase partida a la mitad no es un hecho).
- **Reescribe los resúmenes `[auto]`** con `summarize_episode`: 2-3 frases factuales (qué pasó, decisiones, hilos abiertos). Los resúmenes se indexan semánticamente, así que un buen resumen mejora todas las búsquedas futuras.
- **Añade la dinámica** con `update_contact_profile`: cómo es la relación, temas recurrentes, bromas internas, qué evitar. Esto es lo que ninguna regla puede deducir y donde más valor aportas.

Si el bundle no alcanza para entender algo, ahí sí usa `read_messages` o `recall_context` — pero puntualmente, no para leerlo todo.

### 5. Revisa las sugerencias
`list_suggested_events` trae exámenes, entregas y fechas detectadas en grupos. **No están en el calendario a propósito.** Verifica que la fecha tenga sentido y promueve solo las reales con `confirm_suggested_event`; descarta el resto con `dismiss_suggested_event`.

### 6. Cuida la persona
`get_persona`. Si sigue siendo la plantilla vacía, corre `wacon init` (o pídeselo al usuario) para generar un borrador con sus datos reales, y **dile que la edite a mano**: los agentes la leen antes de cada mensaje, así que una persona en blanco degrada todo lo demás.

## Los grupos son una mina: perfila a cada miembro

Un grupo tiene decenas de personas y miles de mensajes, y cada participante
tiene un **identificador estable**. Eso permite convertir un grupo en muchas
memorias de contacto:

- `list_group_members(group)` — quién habla y cuánto, y quién ya tiene perfil.
- `analyze_group_members(group)` — construye el perfil de estilo de **cada**
  miembro más los hechos que reveló. Gratis y determinístico.

Hazlo en los grupos que importan (familia, cursos, trabajo); sáltate los de
ventas o juegos. Así, cuando alguien de ese grupo escriba en privado, ya hay
contexto sobre cómo habla.

## El detalle que más confunde: los `@lid`

WhatsApp guarda los chats 1-a-1 bajo IDs de privacidad (`...@lid`), **no** bajo el número. Si `read_messages` o `get_contact_profile` vuelven vacíos para alguien que sabes que existe, no asumas que no hay datos: usa **`resolve_contact("nombre o número")`** para encontrar el chat real. La mayoría de tools ya resuelven solo, pero cuando algo no cuadre, ese es el primer sitio donde mirar.

## Criterio de calidad

Lo que hace útil a esta memoria no es el volumen, es que sea **fiable**:

- Un hecho confirmado debería poder rastrearse hasta un mensaje concreto. Si no lo encuentras, no lo confirmes.
- Distingue lo duradero de lo circunstancial: "trabaja de enfermera" es un hecho; "hoy sale tarde" no.
- Los hechos son sobre **la otra persona** (`remember_fact`); cómo el usuario interactúa con ella va al perfil (`update_contact_profile`). Mezclarlos hace que el contexto pierda utilidad.
- No inventes para rellenar huecos. `get_contact_facts` te muestra qué falta (cumpleaños, ocupación…) — eso es una pista de qué aprender más adelante, no permiso para suponerlo.

## Al terminar

Resume al usuario qué cambió en términos que le importen: cuántos contactos tienen memoria ahora, qué aprendiste de los más relevantes, qué fechas encontraste, y qué le conviene revisar a mano (empezando por su persona). Si detectaste algo dudoso —una regla que produce ruido, un chat que no se resuelve— dilo en vez de dejarlo pasar.
