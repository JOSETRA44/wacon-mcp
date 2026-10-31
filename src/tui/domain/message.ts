/**
 * Domain model for a message as the chat UI understands it. Pure: no I/O, no
 * terminal, no daemon — only the rules for what a message IS and how it reads.
 */

export type MessageKind = "text" | "image" | "video" | "audio" | "voice" | "document" | "sticker" | "location" | "contact" | "poll" | "other";

/** Lifecycle of a message: ours go pending → sent | failed; theirs are received. */
export type DeliveryStatus = "pending" | "sent" | "failed" | "received";

export interface ChatMessage {
  /** Server id, or a `local-*` id while an optimistic send is in flight. */
  id: string;
  chatJid: string;
  senderJid: string | null;
  fromMe: boolean;
  ts: number;
  /** Human text with Wacon's agent hints removed (see cleanText). */
  text: string;
  kind: MessageKind;
  status: DeliveryStatus;
  /** Why a send failed, shown next to the message. */
  error?: string;
  /** Wall-clock arrival, for the brief "just arrived" highlight. */
  arrivedAt?: number;
}

/**
 * Classify from the daemon's message_type plus the placeholder text it
 * stores for media ("[nota de voz 0:12] usa transcribe_audio(...)").
 */
export function kindOf(messageType: string | null | undefined, text: string | null | undefined): MessageKind {
  const type = (messageType ?? "").toLowerCase();
  const t = text ?? "";
  if (type.includes("sticker")) return "sticker";
  if (type.includes("location")) return "location";
  if (type.startsWith("contact")) return "contact";
  if (type.startsWith("pollcreation")) return "poll";
  if (type === "ptv") return "video";
  if (type.includes("image")) return "image";
  if (type.includes("video")) return "video";
  if (type.includes("audio")) return /^\s*\[nota de voz/i.test(t) ? "voice" : "audio";
  if (type.includes("document")) return "document";
  if (/^\s*\[imagen/i.test(t)) return "image";
  if (/^\s*\[nota de voz/i.test(t)) return "voice";
  if (/^\s*\[audio/i.test(t)) return "audio";
  if (/^\s*\[video/i.test(t)) return "video";
  if (/^\s*\[documento/i.test(t)) return "document";
  if (/^\s*\[sticker\]/i.test(t)) return "sticker";
  if (type === "" || type === "text" || type === "conversation" || type === "extendedtext") return "text";
  return t ? "text" : "other";
}

export const isMedia = (k: MessageKind): boolean => k !== "text" && k !== "other";

/** Kinds backed by a downloadable file — what "↵ abrir" can actually open. */
export const isOpenable = (k: MessageKind): boolean => ["image", "video", "audio", "voice", "document", "sticker"].includes(k);

/**
 * The daemon writes media placeholders aimed at AI agents
 * ("[imagen: playa] usa view_image(message_id)"). A person should read
 * "playa", not tool names.
 */
export function cleanText(text: string | null | undefined, kind: MessageKind): string {
  const raw = (text ?? "").replace(/\s*usa (view_image|transcribe_audio)\(message_id\)\s*$/i, "").trim();
  if (kind === "text" || kind === "other") return raw;
  // "[imagen: caption]" → "caption"; "[nota de voz 0:12]" → "0:12"
  const m = /^\[(?:imagen|video|documento|audio|nota de voz|sticker)\s*:?\s*([^\]]*)\]\s*(.*)$/i.exec(raw);
  if (!m) return raw;
  return [m[1]?.trim(), m[2]?.trim()].filter(Boolean).join(" ");
}

const KIND_ICON: Record<MessageKind, string> = {
  text: "",
  image: "📷",
  video: "🎥",
  audio: "🎵",
  voice: "🎤",
  document: "📄",
  sticker: "💟",
  location: "📍",
  contact: "👤",
  poll: "📊",
  other: "",
};
const KIND_LABEL: Record<MessageKind, string> = {
  text: "",
  image: "Foto",
  video: "Video",
  audio: "Audio",
  voice: "Nota de voz",
  document: "Documento",
  sticker: "Sticker",
  location: "Ubicación",
  contact: "Contacto",
  poll: "Encuesta",
  other: "Mensaje no compatible",
};

/** "📷 Foto", "🎤 Nota de voz 0:12", "📄 informe.pdf" — the WhatsApp phrasing. */
export function mediaLabel(kind: MessageKind, detail: string): string {
  if (!isMedia(kind)) return detail || KIND_LABEL.other;
  const icon = KIND_ICON[kind];
  if (kind === "voice" || kind === "audio") return `${icon} ${KIND_LABEL[kind]}${detail ? ` ${detail}` : ""}`;
  return `${icon} ${detail || KIND_LABEL[kind]}`;
}

/** Merge two message lists: server truth wins by id, local in-flight sends survive. */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of current) byId.set(m.id, m);
  for (const m of incoming) {
    const prev = byId.get(m.id);
    // Keep the arrival highlight if the server echoes a message we just showed.
    byId.set(m.id, prev?.arrivedAt ? { ...m, arrivedAt: prev.arrivedAt } : m);
  }
  return [...byId.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
}
