/**
 * WhatsApp message types that are machinery, not content: edits/deletes
 * (protocol), reactions, poll votes, album containers, key exchanges,
 * undecryptable stubs. The phone never draws them as bubbles, so neither
 * should a chat list preview or a conversation view. Measured on a real
 * account they were ~30% of all stored rows.
 *
 * Pure data, shared by the SQL in store.ts and the TUI domain.
 */
export const INVISIBLE_MESSAGE_TYPES = [
  "protocol",
  "reaction",
  "encReaction",
  "pollUpdate",
  "album",
  "associatedChild",
  "secretEncrypted",
  "keepInChat",
  "pinInChat",
  "placeholder",
  "senderKeyDistribution",
  "messageContextInfo",
  "encComment",
  "botInvoke",
] as const;

/** `unknown` rows carry no text at all — undecodable, nothing to show. */
export function isInvisibleMessage(type: string | null | undefined, text: string | null | undefined): boolean {
  if (!type) return false;
  if (type === "unknown") return !text;
  return (INVISIBLE_MESSAGE_TYPES as readonly string[]).includes(type);
}

/** SQL fragment for "a message a person would actually see". */
export const VISIBLE_MESSAGE_SQL = `message_type NOT IN (${INVISIBLE_MESSAGE_TYPES.map((t) => `'${t}'`).join(", ")}) AND NOT (message_type = 'unknown' AND text IS NULL)`;
