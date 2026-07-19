import { statSync, readFileSync, existsSync } from "node:fs";
import { basename, extname } from "node:path";

/**
 * Outgoing media. WhatsApp treats each kind differently (an image previews, a
 * voice note shows a waveform, a PDF shows a file card), so the kind is chosen
 * from the extension rather than making the caller specify it — sending a file
 * should be as easy as naming it.
 */

export type MediaKind = "image" | "video" | "audio" | "document";

const MIME: Record<string, { kind: MediaKind; mimetype: string }> = {
  // images
  ".jpg": { kind: "image", mimetype: "image/jpeg" },
  ".jpeg": { kind: "image", mimetype: "image/jpeg" },
  ".png": { kind: "image", mimetype: "image/png" },
  ".webp": { kind: "image", mimetype: "image/webp" },
  ".gif": { kind: "image", mimetype: "image/gif" },
  // video
  ".mp4": { kind: "video", mimetype: "video/mp4" },
  ".mov": { kind: "video", mimetype: "video/quicktime" },
  ".mkv": { kind: "video", mimetype: "video/x-matroska" },
  ".webm": { kind: "video", mimetype: "video/webm" },
  // audio
  ".ogg": { kind: "audio", mimetype: "audio/ogg; codecs=opus" },
  ".opus": { kind: "audio", mimetype: "audio/ogg; codecs=opus" },
  ".mp3": { kind: "audio", mimetype: "audio/mpeg" },
  ".m4a": { kind: "audio", mimetype: "audio/mp4" },
  ".wav": { kind: "audio", mimetype: "audio/wav" },
  ".aac": { kind: "audio", mimetype: "audio/aac" },
  // documents
  ".pdf": { kind: "document", mimetype: "application/pdf" },
  ".doc": { kind: "document", mimetype: "application/msword" },
  ".docx": { kind: "document", mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ".xls": { kind: "document", mimetype: "application/vnd.ms-excel" },
  ".xlsx": { kind: "document", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  ".ppt": { kind: "document", mimetype: "application/vnd.ms-powerpoint" },
  ".pptx": { kind: "document", mimetype: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  ".txt": { kind: "document", mimetype: "text/plain" },
  ".csv": { kind: "document", mimetype: "text/csv" },
  ".zip": { kind: "document", mimetype: "application/zip" },
};

export function classify(filePath: string): { kind: MediaKind; mimetype: string } {
  // Anything unknown still sends fine — as a document, which is WhatsApp's own
  // fallback and never loses the file.
  return MIME[extname(filePath).toLowerCase()] ?? { kind: "document", mimetype: "application/octet-stream" };
}

export interface PreparedMedia {
  kind: MediaKind;
  mimetype: string;
  fileName: string;
  buffer: Buffer;
  bytes: number;
}

/** Read and validate a file for sending. Throws with a plain reason on failure. */
export function prepareMedia(filePath: string, maxBytes: number): PreparedMedia {
  if (!existsSync(filePath)) throw new Error(`no existe el archivo: ${filePath}`);
  const stat = statSync(filePath);
  if (!stat.isFile()) throw new Error(`no es un archivo: ${filePath}`);
  if (stat.size === 0) throw new Error("el archivo está vacío");
  if (stat.size > maxBytes) throw new Error(`archivo demasiado grande: ${(stat.size / 1048576).toFixed(1)} MB (máximo ${(maxBytes / 1048576).toFixed(0)} MB)`);
  const { kind, mimetype } = classify(filePath);
  return { kind, mimetype, fileName: basename(filePath), buffer: readFileSync(filePath), bytes: stat.size };
}

/**
 * Build the Baileys message content for a prepared file.
 * @param asVoiceNote send audio as a real voice note (waveform) instead of an
 *   audio file — only meaningful for audio.
 */
export function toMessageContent(
  media: PreparedMedia,
  opts: { caption?: string; asVoiceNote?: boolean } = {}
): Record<string, unknown> {
  const caption = opts.caption?.trim() || undefined;
  switch (media.kind) {
    case "image":
      return { image: media.buffer, caption, mimetype: media.mimetype };
    case "video":
      return { video: media.buffer, caption, mimetype: media.mimetype };
    case "audio":
      return { audio: media.buffer, mimetype: media.mimetype, ptt: opts.asVoiceNote === true };
    default:
      return { document: media.buffer, fileName: media.fileName, mimetype: media.mimetype, caption };
  }
}
