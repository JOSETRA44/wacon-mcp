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

/** Resolve a name/number/JID to a chat (handles the @lid privacy split). */
export async function resolveTarget(client: DaemonClient, query: string): Promise<ChatTarget | null> {
  const hits = await client.resolveContact(query);
  if (hits.length === 0) return null;
  const best = hits[0]!;
  return { jid: best.jid, name: best.displayName ?? best.jid };
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
