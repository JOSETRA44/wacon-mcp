import type { Store } from "./store.js";

/**
 * Anti-fraud error handling. The core rule: a media/external failure must NEVER
 * reach the chat as a raw technical error, and must never crash the reply flow.
 * We record the real error locally (for the human/dev to review with
 * `wacon errors`) and hand the agent a NATURAL directive instead.
 */

export interface Guided {
  ok: false;
  guidance: string;
}

/** Record an error and return a natural, in-character directive for the agent. */
export function logError(
  store: Store,
  entry: { operation: string; chatJid?: string | null; error: unknown; context?: unknown; client?: string | null },
  guidance: string
): Guided {
  const errorText = entry.error instanceof Error ? `${entry.error.name}: ${entry.error.message}` : String(entry.error);
  try {
    store.logErrorRow({
      operation: entry.operation,
      chatJid: entry.chatJid ?? null,
      error: errorText,
      contextJson: entry.context !== undefined ? JSON.stringify(entry.context) : null,
      client: entry.client ?? null,
    });
  } catch {
    // Even logging must never throw — the whole point is resilience.
  }
  return { ok: false, guidance };
}

/** Ready-made directives so failures read naturally, never like a bug. */
export const GUIDANCE = {
  imageFailed:
    "No pude ver esta imagen (falló la descarga). No inventes su contenido: si parece importante, pregúntale con naturalidad de qué se trata; si no, puedes continuar sin comentarla.",
  audioFailed:
    "No pude escuchar esta nota de voz. No adivines lo que dice: si el mensaje parece importante, pídele con naturalidad que te lo escriba; si no, puedes no responder a ese audio.",
  transcriptionFailed:
    "El transcriptor no está disponible ahora mismo. Si tu agente puede procesar audio, usa el bloque de audio adjunto; de lo contrario, pídele amablemente que te escriba el mensaje.",
  mediaTooLarge: "Este archivo es demasiado grande para procesarlo aquí. Si necesitas su contenido, pídele al contacto que te lo resuma por texto.",
  notFound: "No encontré ese elemento multimedia (quizá ya expiró en los servidores de WhatsApp). Pídele que lo reenvíe si hace falta.",
} as const;
