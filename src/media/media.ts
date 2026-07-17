import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WACON_HOME } from "../core/paths.js";
import type { WhatsAppConnection } from "../core/connection.js";

const MEDIA_DIR = join(WACON_HOME, "media");

export interface DownloadedMedia {
  buffer: Buffer;
  mimetype: string | null;
  kind: string;
  base64: string;
  bytes: number;
}

/**
 * Download a media message once and cache the bytes on disk, so repeated
 * view/transcribe calls for the same message don't re-hit WhatsApp.
 * Enforces a size ceiling to avoid handing giant blobs to an agent.
 */
export async function fetchMedia(
  connection: WhatsAppConnection,
  chatJid: string,
  msgId: string,
  maxBytes: number
): Promise<DownloadedMedia> {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const cacheKey = createHash("sha1").update(`${chatJid}|${msgId}`).digest("hex");
  const cachePath = join(MEDIA_DIR, cacheKey);
  const metaPath = `${cachePath}.json`;

  if (existsSync(cachePath) && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { mimetype: string | null; kind: string };
    const buffer = readFileSync(cachePath);
    return { buffer, mimetype: meta.mimetype, kind: meta.kind, base64: buffer.toString("base64"), bytes: buffer.length };
  }

  const { buffer, mimetype, kind } = await connection.downloadMedia(chatJid, msgId);
  if (buffer.length > maxBytes) {
    throw new Error(`media too large: ${buffer.length} bytes > ${maxBytes}`);
  }
  writeFileSync(cachePath, buffer);
  writeFileSync(metaPath, JSON.stringify({ mimetype, kind }));
  return { buffer, mimetype, kind, base64: buffer.toString("base64"), bytes: buffer.length };
}
