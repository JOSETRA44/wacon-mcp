---
tags: [wacon, atencion, tokens, arquitectura]
---

# Atención y Tokens

El subsistema que decide **cuándo despertar a un agente**. Su tesis: los tokens de un agente son el recurso caro; esperar y filtrar son gratis si los hace el daemon.

## El problema

Un agente que quiere "estar pendiente del WhatsApp" tradicionalmente hace polling:

```
list_chats → "nada nuevo" → sleep → list_chats → "nada nuevo" → ...
```

Cada vuelta cuesta la llamada + el resultado + el razonamiento (~800 tokens). Una hora vigilando a 30s por vuelta = 120 llamadas ≈ **100k tokens para aprender "no pasó nada"**.

## La solución: tres mecanismos

### 1. Long-poll (`wait_for_messages`)

El daemon bloquea server-side y responde **en el instante** en que llega un mensaje, o al expirar el timeout (máx 120s). Una llamada sustituye a todo el bucle: la misma hora de vigilancia son ~30 llamadas de ~80 tokens ≈ **2.4k tokens**. Orden de magnitud: ~40× menos.

> [!note] Patrón validado por la industria
> Es el mismo movimiento que la extensión *Tasks* del spec MCP de 2026 y los "triggers" tipo webhook: dejar de preguntar, empezar a ser notificado.

### 2. Triaje determinístico (`start_watch`)

El daemon puntúa cada mensaje entrante **sin LLM** (`core/watch.ts`):

| Señal | Puntos |
|---|---|
| Chat directo (no grupo) | +40 |
| Te mencionan en un grupo | +45 |
| Contacto frecuente (VIP) | +20 |
| Responde a un mensaje tuyo | +15 |
| Contiene pregunta | +10 |
| Mensaje de grupo (base) | +5 |
| Media adjunta | +5 |

El agente declara una regla una sola vez (chats, keywords, grupos sí/no, `minPriority`) y solo lo despiertan los mensajes que la cumplen. Filtrar 200 mensajes de grupo cuesta 0 tokens.

### 3. Cursor monotónico

Cada evento lleva un `seq`. El agente devuelve el último que vio como `since` y recibe **exactamente** lo que se perdió: ni eventos duplicados ni huecos, aunque estuviera desconectado. El buffer está acotado (300 eventos) para que un agente ausente no infle la memoria del daemon.

## Predecir cuánto vigilar (`suggest_watch_window`)

`core/activity.ts` responde "¿vale la pena esperar aquí?" con datos, no con intuición. Las llegadas de mensajes se modelan como un **proceso de Poisson**: del histograma de 8 semanas se saca λ (msg/h) para la franja *día-de-semana + hora* actual, y de ahí el tiempo necesario para tener 80% de probabilidad de captar algo:

$$t = \frac{-\ln(1 - 0.8)}{\lambda}$$

- λ alto (franja activa) → ventana corta y rentable
- λ ≈ 0 → **recomienda 0 minutos**: vigilar quemaría tokens para nada
- λ bajo pero hay un pico cercano → recomienda 0 y señala la próxima ventana activa ("vuelve en ~1h, hay 12× más tráfico")

Medido en la cuenta real: jueves 19:00 ≈ 0.25 msg/h → *no vigilar*; 20:00 ≈ 3.13 msg/h → ventana rentable.

## Catch-up comprimido (`get_digest`)

En vez de `list_chats` + `read_messages` por cada chat, un resumen agregado por chat: cuántos entrantes, cuándo, y un preview de 120 caracteres. Ponerse al día tras horas fuera cuesta una llamada.

## Presencia: encender y apagar (`set_presence`)

- `unavailable` (**por defecto**): modo sigilo. Wacon recibe todo mientras la cuenta aparece desconectada — nadie ve "en línea" a las 3am porque un agente despertó.
- `available`: aparecer presente cuando el usuario de verdad va a conversar.
- `composing` + `typing_ms` en `send_message`: "escribiendo…" antes de mandar. Nadie responde un párrafo en 200ms.

Leer **nunca** marca como leído. Los tics azules exigen `mark_read` explícito: un agente que escanea chats no debería anunciarle a todo el mundo que el usuario los vio.

## Límites de seguridad

- Una vigilancia muere sola (`MAX_WATCH_MINUTES` = 240): un agente que crashea no deja al daemon ocupado para siempre.
- `releaseAll()` al apagar libera a todo agente bloqueado en vez de dejarlo colgado.
- Los mensajes propios nunca despiertan a nadie.

Relacionado: [[Arquitectura]], [[Herramientas-MCP]], [[Guardrails-y-Seguridad]]
