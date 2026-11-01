import { describe, it, expect } from "vitest";
import { Store, type MessageRow } from "../src/core/store.js";
import { markSelf, type ChatSummary } from "../src/tui/domain/chat.js";
import { healthWarning } from "../src/tui/domain/health.js";

const SELF_PN = "51900000001@s.whatsapp.net";
const SELF_LID = "900000000000001@lid";
const META = "13135550002@s.whatsapp.net";

let n = 0;
function mine(chat: string, text: string): MessageRow {
  return { id: `m${n++}`, chat_jid: chat, sender_jid: null, from_me: 1, timestamp: Date.now() + n, text, message_type: "text", quoted_id: null };
}

/** The real failure: your notes chat mentions everyone, so a name heuristic claimed it. */
function notesChatStore(): Store {
  const s = new Store(":memory:");
  s.upsertContact({ jid: META, name: "Meta AI" });
  s.upsertContact({ jid: "51911111111@s.whatsapp.net", name: "Unicali Admisión" });
  s.upsertContact({ jid: "51922222222@s.whatsapp.net", name: "Gabriel Torres" });
  s.upsertContact({ jid: "51933333333@s.whatsapp.net", name: "Nayda Quispe" });
  for (const t of ["Meta reunión", "Meta lunes", "Meta pagos", "Unicali notas", "Unicali horario", "Unicali examen", "Gabriel deuda", "Gabriel libro", "Gabriel fiesta"]) {
    s.insertMessage(mine(SELF_LID, t));
  }
  // A real 1:1: only Nayda's name is written there.
  const nayda = "777000000000007@lid";
  for (const t of ["hola Nayda", "Nayda ya llegué", "Nayda gracias"]) s.insertMessage(mine(nayda, t));
  s.upsertChat({ jid: SELF_LID, name: null });
  s.upsertChat({ jid: nayda, name: null });
  return s;
}

describe("self identity", () => {
  it("repairs a self chat that a guess had mapped to Meta AI, and pins it", () => {
    const s = notesChatStore();
    // State the old heuristic left behind.
    s.mapJids(SELF_LID, META);
    s.upsertChat({ jid: SELF_LID, name: "Meta AI" });
    s.upsertContact({ jid: SELF_LID, name: "Meta AI" });

    s.setSelf("51900000001:73@s.whatsapp.net", "900000000000001:73@lid");
    expect(s.pnForLid(SELF_LID)).toBe(SELF_PN);
    expect(s.lidForPn(META)).toBeNull();
    const chat = s.db.prepare("SELECT name FROM chats WHERE jid = ?").get(SELF_LID) as { name: string | null };
    expect(chat.name).toBeNull();
    // Nothing can re-claim our identity afterwards.
    expect(s.mapJids(SELF_LID, META)).toBe(false);
    expect(s.mapJids("123@lid", SELF_PN)).toBe(false);
    expect(s.pnForLid(SELF_LID)).toBe(SELF_PN);
  });

  it("never links a notes chat, but still links a chat only one contact points at", () => {
    const s = notesChatStore();
    s.setSelf(SELF_PN, SELF_LID);
    const linked = s.backfillJidMapFromGreetings();
    expect(linked).toBe(1);
    expect(s.pnForLid("777000000000007@lid")).toBe("51933333333@s.whatsapp.net");
    expect(s.pnForLid(SELF_LID)).toBe(SELF_PN);
    expect(s.lidForPn(META)).toBeNull();
  });

  it("undoes an old guess on a chat that several names point at", () => {
    const s = new Store(":memory:");
    const shared = "555000000000005@lid"; // e.g. a chat with a secretary about many people
    s.upsertContact({ jid: "51944444444@s.whatsapp.net", name: "Marco Paniura" });
    s.upsertContact({ jid: "51955555555@s.whatsapp.net", name: "Maximo Andrade" });
    for (const t of ["Marco a", "Marco b", "Marco c", "Maximo a", "Maximo b", "Maximo c"]) s.insertMessage(mine(shared, t));
    s.mapJids(shared, "51955555555@s.whatsapp.net");
    s.upsertChat({ jid: shared, name: "Maximo Andrade" });
    s.backfillJidMapFromGreetings();
    expect(s.pnForLid(shared)).toBeNull();
    expect((s.db.prepare("SELECT name FROM chats WHERE jid = ?").get(shared) as { name: string | null }).name).toBeNull();
  });
});

describe("TUI self chat + health", () => {
  const chat = (jid: string, aliases: string[] = []): ChatSummary => ({ jid, aliases, name: "Meta AI", isGroup: false, unread: 0, lastTs: 1, preview: null });

  it("shows the chat with yourself as Tú, through either identity", () => {
    const out = markSelf([chat(SELF_LID), chat("x@lid", [SELF_PN]), chat("y@lid")], [SELF_PN, SELF_LID]);
    expect(out.map((c) => [c.name, !!c.isSelf])).toEqual([["Tú", true], ["Tú", true], ["Meta AI", false]]);
  });

  it("warns about a low disk before a session error, and stays quiet when healthy", () => {
    expect(healthWarning({ authError: null, freeDiskBytes: 200 * 1024 ** 2 })).toContain("200 MB libres");
    expect(healthWarning({ authError: "Disco casi lleno", freeDiskBytes: 50 * 1024 ** 3 })).toContain("sesión");
    expect(healthWarning({ authError: null, freeDiskBytes: 50 * 1024 ** 3 })).toBeNull();
    expect(healthWarning(null)).toBeNull();
  });
});
