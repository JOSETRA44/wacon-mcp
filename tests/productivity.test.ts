import { describe, it, expect } from "vitest";
import { Store, type MessageRow } from "../src/core/store.js";
import { pendingReplies, openCommitments } from "../src/analysis/productivity.js";
import { listBundledSkills, bundledSkillsDir } from "../src/core/skills-install.js";

let seq = 0;
function msg(over: Partial<MessageRow>): MessageRow {
  return { id: `m${seq++}`, chat_jid: "a@s.whatsapp.net", sender_jid: null, from_me: 0, timestamp: Date.now(), text: "hola", message_type: "text", quoted_id: null, ...over };
}

describe("inbox — what still needs a reply", () => {
  it("only lists chats where THEY spoke last", () => {
    const store = new Store(":memory:");
    const t = Date.now();
    // waiting: they wrote last
    store.insertMessage(msg({ chat_jid: "waiting@s.whatsapp.net", from_me: 1, text: "hola", timestamp: t - 2000 }));
    store.insertMessage(msg({ chat_jid: "waiting@s.whatsapp.net", from_me: 0, text: "me respondes?", timestamp: t - 1000 }));
    // answered: user wrote last
    store.insertMessage(msg({ chat_jid: "answered@s.whatsapp.net", from_me: 0, text: "hey", timestamp: t - 2000 }));
    store.insertMessage(msg({ chat_jid: "answered@s.whatsapp.net", from_me: 1, text: "ya te dije", timestamp: t - 1000 }));

    const inbox = pendingReplies(store);
    expect(inbox.map((i) => i.chat)).toContain("waiting@s.whatsapp.net");
    expect(inbox.map((i) => i.chat)).not.toContain("answered@s.whatsapp.net");
    store.close();
  });

  it("excludes WhatsApp channels — you cannot reply to a broadcast", () => {
    const store = new Store(":memory:");
    store.insertMessage(msg({ chat_jid: "1203631607@newsletter", from_me: 0, text: "noticia del canal" }));
    store.insertMessage(msg({ chat_jid: "amigo@s.whatsapp.net", from_me: 0, text: "oye" }));
    const chats = pendingReplies(store).map((i) => i.chat);
    expect(chats).toContain("amigo@s.whatsapp.net");
    expect(chats.some((c) => c.endsWith("@newsletter"))).toBe(false);
    store.close();
  });

  it("ranks a direct question above a quiet thread", () => {
    const store = new Store(":memory:");
    const t = Date.now();
    store.insertMessage(msg({ chat_jid: "pregunta@s.whatsapp.net", from_me: 0, text: "vienes mañana?", timestamp: t - 1000 }));
    store.insertMessage(msg({ chat_jid: "quieto@s.whatsapp.net", from_me: 0, text: "ok", timestamp: t - 1000 }));
    const inbox = pendingReplies(store);
    const q = inbox.find((i) => i.chat === "pregunta@s.whatsapp.net")!;
    const s = inbox.find((i) => i.chat === "quieto@s.whatsapp.net")!;
    expect(q.priority).toBeGreaterThan(s.priority);
    expect(q.reasons).toContain("te preguntaron algo");
    store.close();
  });
});

describe("open commitments", () => {
  it("flags a promise that was the user's last word", () => {
    const store = new Store(":memory:");
    const t = Date.now() - 3 * 86400000;
    store.insertMessage(msg({ chat_jid: "juan@s.whatsapp.net", from_me: 1, text: "mañana te mando el archivo", timestamp: t }));
    const open = openCommitments(store, 30);
    expect(open).toHaveLength(1);
    expect(open[0]!.text).toContain("te mando");
    store.close();
  });

  it("ignores a promise the user followed up on", () => {
    const store = new Store(":memory:");
    const t = Date.now() - 3 * 86400000;
    store.insertMessage(msg({ chat_jid: "juan@s.whatsapp.net", from_me: 1, text: "mañana te mando el archivo", timestamp: t }));
    store.insertMessage(msg({ chat_jid: "juan@s.whatsapp.net", from_me: 1, text: "listo, ahi esta", timestamp: t + 60000 }));
    expect(openCommitments(store, 30)).toHaveLength(0);
    store.close();
  });

  it("does not treat a completed action as a promise", () => {
    const store = new Store(":memory:");
    store.insertMessage(msg({ chat_jid: "j@s.whatsapp.net", from_me: 1, text: "ya te envié los dos archivos", timestamp: Date.now() - 86400000 }));
    expect(openCommitments(store, 30)).toHaveLength(0);
    store.close();
  });
});

describe("group members", () => {
  it("groups a group's messages by author", () => {
    const store = new Store(":memory:");
    const g = "120363@g.us";
    for (let i = 0; i < 6; i++) store.insertMessage(msg({ chat_jid: g, sender_jid: "ana@lid", text: `ana ${i}` }));
    for (let i = 0; i < 3; i++) store.insertMessage(msg({ chat_jid: g, sender_jid: "beto@lid", text: `beto ${i}` }));
    const members = store.groupMembers(g, 3);
    expect(members).toHaveLength(2);
    expect(members[0]!.sender_jid).toBe("ana@lid");
    expect(members[0]!.total).toBe(6);
    expect(store.memberMessages(g, "beto@lid")).toHaveLength(3);
    store.close();
  });
});

describe("bundled skills", () => {
  it("ships both skills so one install covers the agent", () => {
    expect(bundledSkillsDir()).not.toBeNull();
    const skills = listBundledSkills();
    expect(skills).toContain("wacon-whatsapp");
    expect(skills).toContain("wacon-knowledge");
  });
});
