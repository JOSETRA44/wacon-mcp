import { spawn } from "node:child_process";
import type { DaemonClient } from "../daemon/client.js";

/**
 * Presentation-agnostic helpers shared by both terminal clients — the
 * line-based `wacon chat` (chat.ts) and the full-screen `wacon chat ultra`
 * (ultra.ts). Keeping them here means neither reimplements target resolution,
 * media classification, or opening files.
 */

export interface ChatTarget {
  jid: string;
  name: string;
}

export const shortTime = (ts: number | string): string =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * WhatsApp never shows a raw jid to a human — it shows a saved name, or
 * falls back to a nicely formatted phone number. Without this, an unnamed
 * chat/contact rendered as its literal jid (e.g. "51987654321@s.whatsapp.net",
 * or worse, a meaningless `@lid` id that isn't even a real phone number).
 */
export function friendlyName(jid: string, name: string | null | undefined): string {
  if (name) return name;
  if (jid.endsWith("@g.us")) return "Grupo sin nombre";
  if (jid.endsWith("@lid")) return "Contacto sin nombre";
  const digits = jid.split("@")[0]?.replace(/\D/g, "") ?? "";
  if (!digits) return jid;
  // Right-to-left triplets read as a phone number for most numbering plans
  // (e.g. Peru's 51 + 9-digit mobile groups into "+51 987 654 321").
  const groups: string[] = [];
  for (let i = digits.length; i > 0; i -= 3) groups.unshift(digits.slice(Math.max(0, i - 3), i));
  return `+${groups.join(" ")}`;
}

/**
 * Clean a pasted file path. Windows' "Copy as path" wraps the path in double
 * quotes and terminals often keep them, so a straight paste produced a path
 * that does not exist and a confusing "file not found". Also handles the
 * single quotes shells add and stray surrounding whitespace.
 */
export function unquotePath(raw: string): string {
  const trimmed = raw.trim();
  const unwrapped =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  return unwrapped.trim();
}

/** Resolve a name/number/JID to a chat (handles the @lid privacy split). */
export async function resolveTarget(client: DaemonClient, query: string): Promise<ChatTarget | null> {
  const hits = await client.resolveContact(query);
  if (hits.length === 0) return null;
  const best = hits[0]!;
  return { jid: best.jid, name: friendlyName(best.jid, best.displayName) };
}

export type MediaKind = "image" | "audio" | "other";

/** Classify a message as viewable media so both clients can offer view/transcribe. */
export function mediaKindOf(messageType: string | undefined, text: string | null): MediaKind | null {
  const type = (messageType ?? "").toLowerCase();
  if (type.includes("image") || type.includes("video") || type.includes("sticker")) return "image";
  if (type.includes("audio")) return "audio";
  if (/^\s*\[(imagen|nota de voz|audio|video|documento)/i.test(text ?? "")) return "other";
  return null;
}

/**
 * Terminals can't reliably display images, so we save the file and hand it to
 * the OS viewer — what the user would do anyway, and it works everywhere.
 */
export function openWithSystemViewer(filePath: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", filePath]]
      : process.platform === "darwin"
        ? ["open", [filePath]]
        : ["xdg-open", [filePath]];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
