import { describe, it, expect } from "vitest";
import { vectorize, cosine, toBlob, fromBlob } from "../src/memory/vectorizer.js";
import { analyzeDynamics } from "../src/memory/analyzer.js";
import { recall } from "../src/memory/recall.js";
import { Store, type MessageRow } from "../src/core/store.js";

describe("vectorizer", () => {
  it("scores typo'd variants closer than unrelated text", () => {
    const a = vectorize("que onda como estas");
    const typo = vectorize("q onda cmo estas");
    const unrelated = vectorize("informe trimestral de contabilidad");
    expect(cosine(a, typo)).toBeGreaterThan(cosine(a, unrelated));
    expect(cosine(a, typo)).toBeGreaterThan(0.3);
  });

  it("roundtrips through blobs", () => {
    const v = vectorize("hola mundo");
    const back = fromBlob(toBlob(v));
    expect(cosine(v, back)).toBeCloseTo(1, 5);
  });

  it("handles accents as equivalent", () => {
    expect(cosine(vectorize("qué onda"), vectorize("que onda"))).toBeCloseTo(1, 5);
  });
});

describe("analyzeDynamics", () => {
  it("computes initiation and reply latency", () => {
    const HOUR = 3600_000;
    const msgs: { from_me: number; timestamp: number }[] = [];
    let t = 0;
    // 5 episodes, all started by the contact; user replies after 2 minutes
    for (let ep = 0; ep < 5; ep++) {
      t += 5 * HOUR;
      msgs.push({ from_me: 0, timestamp: t });
      msgs.push({ from_me: 1, timestamp: t + 2 * 60_000 });
      msgs.push({ from_me: 1, timestamp: t + 2.5 * 60_000 });
    }
    const d = analyzeDynamics(msgs, 3 * HOUR)!;
    expect(d.initiationRatio).toBe(0);
    expect(d.medianReplySeconds).toBe(120);
    expect(d.avgBurstLength).toBe(2);
  });

  it("returns null for tiny histories", () => {
    expect(analyzeDynamics([{ from_me: 1, timestamp: 1 }])).toBeNull();
  });
});

describe("recall (end-to-end, in-memory store)", () => {
  function seed(): Store {
    const store = new Store(":memory:");
    const base = Date.now() - 30 * 24 * 3600_000;
    const rows: MessageRow[] = [
      { id: "1", chat_jid: "a@s.whatsapp.net", sender_jid: "a@s.whatsapp.net", from_me: 0, timestamp: base, text: "oye vamos al cine el viernes?", message_type: "text", quoted_id: null },
      { id: "2", chat_jid: "a@s.whatsapp.net", sender_jid: null, from_me: 1, timestamp: base + 60_000, text: "sale, yo compro las entradas", message_type: "text", quoted_id: null },
      { id: "3", chat_jid: "a@s.whatsapp.net", sender_jid: null, from_me: 1, timestamp: base + 10 * 24 * 3600_000, text: "ya pagué la renta del depa", message_type: "text", quoted_id: null },
      { id: "4", chat_jid: "b@s.whatsapp.net", sender_jid: "b@s.whatsapp.net", from_me: 0, timestamp: base + 11 * 24 * 3600_000, text: "el informe de contabilidad está listo", message_type: "text", quoted_id: null },
    ];
    for (const r of rows) store.insertMessage(r);
    return store;
  }

  it("finds semantically related messages despite typos", () => {
    const store = seed();
    const result = recall(store, "peliculas cine bines", { chatJid: "a@s.whatsapp.net" });
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0]!.message.text).toContain("cine");
    store.close();
  });

  it("surfaces summarized episodes in recall", () => {
    const store = seed();
    store.rebuildEpisodes("a@s.whatsapp.net");
    const eps = store.listEpisodes("a@s.whatsapp.net");
    expect(eps.length).toBe(2); // cine day + renta day (10 days apart)
    const cineEp = eps.find((e) => e.start_ts <= Date.now() - 29 * 24 * 3600_000)!;
    store.setEpisodeSummary(cineEp.id, "Acordaron ir al cine el viernes; el usuario quedó en comprar las entradas.");
    const result = recall(store, "quien compra los boletos del cine", { chatJid: "a@s.whatsapp.net" });
    expect(result.episodes.length).toBeGreaterThan(0);
    expect(result.episodes[0]!.summary).toContain("entradas");
    store.close();
  });

  it("keyword search still works via FTS path", () => {
    const store = seed();
    const result = recall(store, "renta");
    expect(result.messages.some((m) => m.message.text?.includes("renta"))).toBe(true);
    store.close();
  });
});
