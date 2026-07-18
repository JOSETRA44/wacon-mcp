import { describe, it, expect } from "vitest";
import { inferMood, loadPack, importPack, indexOwnStickers, stickerAffinity } from "../src/media/stickers.js";
import { Store, type MessageRow } from "../src/core/store.js";

function msg(over: Partial<MessageRow>): MessageRow {
  return { id: Math.random().toString(36).slice(2), chat_jid: "c@s.whatsapp.net", sender_jid: null, from_me: 1, timestamp: Date.now(), text: null, message_type: "text", quoted_id: null, ...over };
}

describe("mood inference from context", () => {
  it("maps the preceding text to the right mood", () => {
    expect(inferMood("jajaja no manches")).toBe("risa");
    expect(inferMood("Perdón, me pasé verdad?")).toBe("disculpa");
    expect(inferMood("Hola Nayda")).toBe("saludo");
    expect(inferMood("listo listo, ntp")).toBe("ok");
    expect(inferMood("gracias, te quiero mucho")).toBe("carino");
    expect(inferMood("en serio?? no puede ser")).toBe("sorpresa");
  });

  it("falls back to neutral", () => {
    expect(inferMood(null)).toBe("neutral");
    expect(inferMood("mañana reviso el documento")).toBe("neutral");
  });
});

describe("bundled cat pack", () => {
  it("loads with an open license and mood-tagged stickers", () => {
    const pack = loadPack("cats");
    expect(pack).not.toBeNull();
    expect(pack!.license).toContain("CC-BY");
    expect(pack!.stickers.length).toBeGreaterThanOrEqual(8);
    const moods = pack!.stickers.map((s) => s.mood);
    expect(moods).toContain("risa");
    expect(moods).toContain("disculpa");
  });

  it("imports into the library and is listable by mood", () => {
    const store = new Store(":memory:");
    const n = importPack(store, "cats");
    expect(n).toBeGreaterThan(0);
    const risa = store.listStickers({ mood: "risa" });
    expect(risa.length).toBe(1);
    expect(risa[0]!.id).toBe("cats:risa");
    expect(risa[0]!.origin).toBe("pack");
    store.close();
  });
});

describe("own stickers & habits", () => {
  it("tags own stickers with the mood of the preceding message and learns habits", () => {
    const store = new Store(":memory:");
    const chat = "friend@s.whatsapp.net";
    const t = Date.now();
    store.insertMessage(msg({ chat_jid: chat, from_me: 1, text: "jajaja que risa", timestamp: t }));
    store.insertMessage(msg({ chat_jid: chat, from_me: 1, message_type: "sticker", text: "[sticker]", timestamp: t + 1000 }));
    const { habits } = indexOwnStickers(store);
    expect(habits).toBe(1);
    expect(store.stickerHabits(chat)[0]!.mood).toBe("risa");
    store.close();
  });

  it("computes per-contact sticker affinity", () => {
    const store = new Store(":memory:");
    const heavy = "heavy@s.whatsapp.net";
    for (let i = 0; i < 6; i++) store.insertMessage(msg({ chat_jid: heavy, from_me: 1, text: `t${i}`, timestamp: Date.now() + i }));
    for (let i = 0; i < 4; i++) store.insertMessage(msg({ chat_jid: heavy, from_me: 1, message_type: "sticker", text: "[sticker]", timestamp: Date.now() + 100 + i }));
    const a = stickerAffinity(store, heavy);
    expect(a.stickersPerMessage).toBeGreaterThan(0.25);
    expect(a.advice).toContain("seguido");

    const light = "light@s.whatsapp.net";
    for (let i = 0; i < 20; i++) store.insertMessage(msg({ chat_jid: light, from_me: 1, text: `t${i}`, timestamp: Date.now() + i }));
    expect(stickerAffinity(store, light).advice).toContain("Casi nunca");
    store.close();
  });
});
