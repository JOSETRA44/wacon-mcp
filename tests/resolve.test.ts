import { describe, it, expect } from "vitest";
import { Store, type MessageRow } from "../src/core/store.js";

const LID = "114547264335883@lid";
const PN = "51946848014@s.whatsapp.net";

function msg(chat: string, from_me: number, text: string): MessageRow {
  return { id: Math.random().toString(36).slice(2), chat_jid: chat, sender_jid: from_me ? null : chat, from_me, timestamp: Date.now(), text, message_type: "text", quoted_id: null };
}

describe("@lid ↔ phone resolution", () => {
  it("maps lid↔pn both directions", () => {
    const store = new Store(":memory:");
    store.mapJids(LID, PN);
    expect(store.pnForLid(LID)).toBe(PN);
    expect(store.lidForPn(PN)).toBe(LID);
    store.close();
  });

  it("resolves a phone number to the @lid chat that holds the messages", () => {
    const store = new Store(":memory:");
    store.upsertContact({ jid: PN, name: "Nayda Quispe UTP" });
    store.mapJids(LID, PN);
    store.insertMessage(msg(LID, 1, "Hola Nayda"));
    store.insertMessage(msg(LID, 0, "Joseeeee"));
    const hits = store.resolveChat(PN);
    expect(hits[0]!.jid).toBe(LID);
    expect(hits[0]!.total).toBe(2);
    store.close();
  });

  it("resolves by name via the greeting FTS fallback (no map needed)", () => {
    const store = new Store(":memory:");
    // No jid_map, no contact under the lid — only the greeting in outgoing text.
    store.insertMessage(msg(LID, 1, "Hola Nayda buenas noches"));
    store.insertMessage(msg(LID, 0, "hola"));
    const hits = store.resolveChat("Nayda");
    expect(hits.some((h) => h.jid === LID)).toBe(true);
    store.close();
  });

  it("shows the contact name on the @lid chat via the mapping", () => {
    const store = new Store(":memory:");
    store.upsertContact({ jid: PN, name: "Nayda Quispe UTP" });
    store.mapJids(LID, PN);
    store.insertMessage(msg(LID, 1, "hi"));
    expect(store.resolveDisplayName(LID)).toBe("Nayda Quispe UTP");
    store.close();
  });

  it("a direct JID with messages resolves to itself", () => {
    const store = new Store(":memory:");
    store.insertMessage(msg("friend@s.whatsapp.net", 1, "hey"));
    const hits = store.resolveChat("friend@s.whatsapp.net");
    expect(hits[0]!.jid).toBe("friend@s.whatsapp.net");
    store.close();
  });

  it("listChats resolves a name saved under the phone-number jid for an @lid chat", () => {
    // Root cause of "names show as numbers": a chat lives under @lid but the
    // saved contact name only exists under the phone-number jid (or vice
    // versa) — listChats used to join contacts by exact jid match only.
    const store = new Store(":memory:");
    store.upsertContact({ jid: PN, name: "Nayda Quispe UTP" });
    store.mapJids(LID, PN);
    store.upsertChat({ jid: LID, lastMessageTs: Date.now() });
    const chats = store.listChats(10);
    expect(chats.find((c) => c.jid === LID)!.display_name).toBe("Nayda Quispe UTP");
    store.close();
  });

  it("groupMembers resolves a member's name across the @lid/phone-number split", () => {
    // Group participant jids are almost always @lid (WhatsApp hides phone
    // numbers inside groups) even when that person is saved as a contact
    // under their real phone number.
    const store = new Store(":memory:");
    const group = "120363@g.us";
    store.upsertContact({ jid: PN, name: "Nayda Quispe UTP" });
    store.mapJids(LID, PN);
    for (let i = 0; i < 5; i++) store.insertMessage({ id: `g${i}`, chat_jid: group, sender_jid: LID, from_me: 0, timestamp: Date.now(), text: `msg ${i}`, message_type: "text", quoted_id: null });
    const members = store.groupMembers(group, 1);
    expect(members[0]!.sender_jid).toBe(LID);
    expect(members[0]!.display_name).toBe("Nayda Quispe UTP");
    store.close();
  });

  it("analysisTargets ranks by outgoing and flags facts", () => {
    const store = new Store(":memory:");
    for (let i = 0; i < 20; i++) store.insertMessage(msg("a@s.whatsapp.net", 1, `m${i}`));
    for (let i = 0; i < 16; i++) store.insertMessage(msg("b@s.whatsapp.net", 1, `m${i}`));
    store.upsertFact({ jid: "a@s.whatsapp.net", category: "gustos", fact: "café" });
    const targets = store.analysisTargets(10);
    expect(targets[0]!.jid).toBe("a@s.whatsapp.net");
    expect(targets[0]!.hasFacts).toBe(true);
    expect(targets.find((t) => t.jid === "b@s.whatsapp.net")!.hasFacts).toBe(false);
    store.close();
  });
});
