import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Store, MessageRow } from "../core/store.js";

/**
 * Sticker support. Two sources, in order of authenticity:
 *  1. 'own'  — stickers the user actually sent (already webp, indexed from
 *              history). Their MEANING is inferred from the text right before
 *              each send, so we learn what the user uses a sticker *for*.
 *  2. 'pack' — bundled, openly-licensed packs (cats) for when the own library
 *              is thin. Ships as pre-rendered webp: no image lib at runtime.
 */

export const MOODS = ["risa", "carino", "saludo", "ok", "travieso", "beso", "sorpresa", "disculpa", "molesto", "neutral"] as const;
export type Mood = (typeof MOODS)[number];

/** What the text right before a sticker tells us about why it was sent. */
const MOOD_CUES: { mood: Mood; re: RegExp }[] = [
  { mood: "risa", re: /\b(jaja|jeje|jsjs|jajaj|xd|lol|chistoso|gracioso)/i },
  { mood: "disculpa", re: /\b(perd[oó]n|disc[uú]lpa|lo siento|mi culpa|me pas[eé])/i },
  { mood: "saludo", re: /\b(hola|holi|buenas|buen d[ií]a|buenas noches|buenas tardes|hey)\b/i },
  { mood: "ok", re: /\b(listo|ya est[aá]|sale|dale|vale|ok|oka|dalee|dale pues|dsp|me parece|perfecto)\b/i },
  { mood: "carino", re: /\b(te quiero|tqm|extra[ñn]|lindo|linda|bonit|gracias|amor|cari[ñn])/i },
  { mood: "sorpresa", re: /\b(en serio|enserio|no way|qu[eé]\?|whaaa|no puede ser|asu|wow)/i },
  { mood: "molesto", re: /\b(no me gust|molest|fastidi|enoj|rabia|pesado)/i },
  { mood: "beso", re: /\b(beso|besito|muack|te amo)/i },
  { mood: "travieso", re: /\b(jeje|picar|travies|malandr|mentira|broma)/i },
];

/** Infer the mood of a sticker from the message that preceded it. */
export function inferMood(previousText: string | null): Mood {
  if (!previousText) return "neutral";
  for (const cue of MOOD_CUES) {
    if (cue.re.test(previousText)) return cue.mood;
  }
  return "neutral";
}

export interface PackSticker {
  id: string;
  mood: string;
  file: string;
  emoji: string;
  description: string;
}

function packDir(pack: string): string {
  // Source layout is src/media/stickers.ts; the build bundles flat into dist/.
  // Try both depths so it resolves either way.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ["..", join("..", "..")]) {
    const candidate = join(here, up, "assets", "stickers", pack);
    if (existsSync(candidate)) return candidate;
  }
  return join(here, "..", "assets", "stickers", pack);
}

export function loadPack(pack = "cats"): { stickers: PackSticker[]; dir: string; license?: string } | null {
  const dir = packDir(pack);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { stickers: PackSticker[]; license?: string };
    return { stickers: m.stickers, dir, license: m.license };
  } catch {
    return null;
  }
}

/** Register a bundled pack into the library (idempotent). */
export function importPack(store: Store, pack = "cats"): number {
  const loaded = loadPack(pack);
  if (!loaded) return 0;
  let n = 0;
  for (const s of loaded.stickers) {
    store.upsertSticker({
      id: s.id,
      origin: "pack",
      pack,
      mood: s.mood,
      filePath: join(loaded.dir, s.file),
      chatJid: null,
      msgId: null,
      description: `${s.emoji} ${s.description}`,
    });
    n++;
  }
  return n;
}

/**
 * Catalog the stickers the user SENT, tagging each with the mood inferred from
 * the preceding message, and learn per-contact sticker habits.
 * Only stickers with a downloadable stub can actually be re-sent.
 */
export function indexOwnStickers(store: Store): { indexed: number; habits: number } {
  const sent = store.ownStickerMessages();
  let indexed = 0;
  let habits = 0;
  for (const s of sent) {
    const mood = inferMood(s.prev_text);
    store.bumpStickerHabit(s.chat_jid, mood);
    habits++;
    if (!store.getMedia(s.chat_jid, s.msg_id)) continue; // not downloadable (no stub)
    store.upsertSticker({
      id: `own:${s.chat_jid}|${s.msg_id}`,
      origin: "own",
      pack: null,
      mood,
      filePath: null,
      chatJid: s.chat_jid,
      msgId: s.msg_id,
      description: s.prev_text ? `usado tras: "${s.prev_text.slice(0, 40)}"` : null,
    });
    indexed++;
  }
  return { indexed, habits };
}

export type StickerRow = {
  id: string; origin: string; pack: string | null; mood: string | null;
  file_path: string | null; chat_jid: string | null; msg_id: string | null;
  uses: number; description: string | null;
};

/**
 * Should a sticker even be sent to this contact, and how often? Mirrors the
 * user's real habit instead of sprinkling stickers everywhere.
 */
export function stickerAffinity(store: Store, chatJid: string): { stickersPerMessage: number; advice: string } {
  const { stickers, outgoing } = store.stickerUsageFor(chatJid);
  const ratio = outgoing > 0 ? stickers / outgoing : 0;
  const advice =
    ratio >= 0.25
      ? "Con este contacto usas stickers muy seguido — encajan de forma natural."
      : ratio >= 0.08
        ? "Usas stickers de vez en cuando aquí — está bien uno puntual."
        : "Casi nunca mandas stickers a este contacto — mejor solo texto.";
  return { stickersPerMessage: Number(ratio.toFixed(3)), advice };
}
