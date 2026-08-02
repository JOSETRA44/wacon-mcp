import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WACON_HOME } from "../core/paths.js";
import { c } from "./output.js";

/**
 * Progressive discovery. A terminal client hides its features behind commands
 * nobody knows to type, so instead of a wall of help on entry we surface one
 * tip at a time, at moments when it's relevant, and never repeat one the user
 * has already seen. Learning the tool shouldn't require reading a manual.
 */

const TIPS_FILE = join(WACON_HOME, "tips-seen.json");

export interface Tip {
  id: string;
  text: string;
}

/** Ordered roughly by how soon a newcomer needs them. */
export const CHAT_TIPS: Tip[] = [
  { id: "back", text: `Pulsa ${c.bold("Esc")} para volver a la lista de chats (o escribe ${c.bold("/atras")}).` },
  { id: "tab", text: `${c.bold("Tab")} autocompleta comandos y nombres: prueba ${c.bold("/switch na")} + Tab.` },
  { id: "send", text: `Para adjuntar: ${c.bold("/send C:\\ruta\\archivo.pdf")} — imágenes, audios, PDFs, lo que sea.` },
  { id: "voice", text: `Nota de voz real: ${c.bold("/send audio.ogg --voz")}.` },
  { id: "jump", text: `Si otro te escribe, verás su número: pulsa ${c.bold("/2")} para saltar a ese chat.` },
  { id: "media", text: `Cuando recibas una imagen o audio, ${c.bold("/ver 1")} lo abre en tu visor.` },
  { id: "sticker", text: `Stickers con ${c.bold("/sticker risa")} — usa los tuyos, respetando tu ritmo con cada persona.` },
  { id: "search", text: `${c.bold("/search palabra")} busca dentro de esta conversación.` },
  { id: "resume", text: `Al reabrir ${c.bold("wacon chat")}, pulsa enter para continuar donde lo dejaste.` },
];

/**
 * Same idea for `chat ultra`, separate pool: the keys are entirely different
 * (Ctrl+N/Ctrl+K instead of slash commands) and this text is rendered inside
 * blessed's own `{tag}` widgets, not printed to a raw ANSI terminal — so it
 * must stay plain, no `c.bold`/`c.dim` (those emit real ANSI escapes, which
 * blessed would show as literal garbage instead of formatting).
 */
export const ULTRA_TIPS: Tip[] = [
  { id: "ultra-switch", text: "Ctrl+N / Ctrl+P cambian de chat sin salir de lo que estás escribiendo." },
  { id: "ultra-jump", text: "Ctrl+K busca y salta a cualquier chat al vuelo." },
  { id: "ultra-list", text: "Esc o Tab te llevan a la lista, justo donde te quedaste." },
  { id: "ultra-attach", text: "Ctrl+O abre un explorador para adjuntar archivos (no hace falta escribir rutas); Ctrl+S manda un sticker." },
  { id: "ultra-media", text: "Enter sobre la conversación abre la última imagen o audio recibido." },
  { id: "ultra-help", text: "? o F1 muestran todos los atajos cuando los necesites." },
];

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(TIPS_FILE, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  try {
    writeFileSync(TIPS_FILE, JSON.stringify([...seen]));
  } catch {
    // a tip we can't remember is not worth an error
  }
}

/**
 * Next unseen tip, marked as seen. Returns null once the user has seen them
 * all — at that point they know the tool and the hints just become noise.
 */
export function nextTip(pool: Tip[] = CHAT_TIPS): string | null {
  const seen = loadSeen();
  const tip = pool.find((t) => !seen.has(t.id));
  if (!tip) return null;
  seen.add(tip.id);
  saveSeen(seen);
  return tip.text;
}

/**
 * One-shot markers that share the tips storage. Used for things shown once
 * ever rather than once per session — the ultra welcome screen, for example,
 * should greet a newcomer and then never interrupt again.
 */
export function hasSeen(id: string): boolean {
  return loadSeen().has(id);
}

export function markSeen(id: string): void {
  const seen = loadSeen();
  seen.add(id);
  saveSeen(seen);
}

/** Force a specific tip (e.g. right after the user fumbles a command). */
export function tipById(id: string): string | null {
  const tip = CHAT_TIPS.find((t) => t.id === id);
  if (!tip) return null;
  const seen = loadSeen();
  seen.add(id);
  saveSeen(seen);
  return tip.text;
}

export function renderTip(text: string): string {
  return `${c.cyan("💡")} ${c.dim(text)}`;
}
