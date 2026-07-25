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
