import { describe, it, expect } from "vitest";
import { extractFacts, extractActionables } from "../src/analysis/extractors.js";
import { extractiveDigest } from "../src/analysis/summarize.js";
import { AnalysisRunner } from "../src/analysis/runner.js";
import { Store, type MessageRow } from "../src/core/store.js";

function msg(over: Partial<MessageRow>): MessageRow {
  return { id: Math.random().toString(36).slice(2), chat_jid: "c@s.whatsapp.net", sender_jid: null, from_me: 0, timestamp: Date.now(), text: null, message_type: "text", quoted_id: null, ...over };
}

describe("fact extractors (no-LLM)", () => {
  it("extracts occupation, likes, birthday, place", () => {
    const facts = extractFacts([
      msg({ text: "hola, trabajo en una clínica como enfermera" }),
      msg({ text: "me encanta el reggaeton y salir a bailar" }),
      msg({ text: "mi cumpleaños es el 5 de marzo" }),
      msg({ text: "vivo en San Luis, cerca del parque" }),
      msg({ text: "soy ingeniera" }),
    ]);
    const cats = facts.map((f) => f.category);
    expect(cats).toContain("ocupacion");
    expect(cats).toContain("gustos");
    expect(cats).toContain("fechas");
    expect(cats).toContain("contexto");
    expect(facts.every((f) => f.confidence <= 0.5)).toBe(true); // all low-confidence
    expect(facts.find((f) => f.category === "fechas")!.fact).toContain("marzo");
  });

  it("ignores placeholders and short noise", () => {
    const facts = extractFacts([msg({ text: "[imagen] usa view_image(x)" }), msg({ text: "ok" }), msg({ text: "jaja" })]);
    expect(facts).toHaveLength(0);
  });

  it("extracts group actionables with parsed dates", () => {
    const acts = extractActionables([
      msg({ from_me: 0, text: "El 3er examen es el lunes 20 de julio", timestamp: Date.now() }),
      msg({ from_me: 0, text: "Fecha límite del TIF: 22/07", timestamp: Date.now() }),
      msg({ from_me: 0, text: "hola como estan", timestamp: Date.now() }),
    ]);
    expect(acts.length).toBe(2);
    expect(acts.some((a) => a.whenTs !== null)).toBe(true);
  });
});

describe("extractive digest", () => {
  it("picks salient messages and marks auto", () => {
    const d = extractiveDigest(
      [
        msg({ from_me: 0, text: "oe vamos al cine?" }),
        msg({ from_me: 1, text: "sale, el viernes a las 8" }),
        msg({ from_me: 0, text: "ok" }),
      ],
      (m) => (m.from_me ? "yo" : "ella")
    );
    expect(d).toContain("[auto]");
    expect(d).toContain("cine");
    expect(d).toContain("viernes");
  });
});

describe("AnalysisRunner (brute force + progress)", () => {
  it("runs over a 1:1 chat: builds profile, facts, episode summaries", async () => {
    const store = new Store(":memory:");
    const base = Date.now() - 10 * 86400000;
    for (let i = 0; i < 12; i++) store.insertMessage(msg({ chat_jid: "a@s.whatsapp.net", from_me: 1, text: `mensaje mio numero ${i} jaja`, timestamp: base + i * 60000 }));
    store.insertMessage(msg({ chat_jid: "a@s.whatsapp.net", from_me: 0, text: "trabajo en un banco como cajera", timestamp: base }));
    store.insertMessage(msg({ chat_jid: "a@s.whatsapp.net", from_me: 0, text: "me gusta el cafe por las mañanas", timestamp: base + 1000 }));

    const runner = new AnalysisRunner(store);
    runner.start({ mode: "contacts", minOutgoing: 5 });
    // wait for completion
    const deadline = Date.now() + 3000;
    while (runner.status?.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

    expect(runner.status!.running).toBe(false);
    expect(runner.status!.processed).toBeGreaterThan(0);
    expect(runner.status!.factsFound).toBeGreaterThan(0);
    expect(store.listFacts("a@s.whatsapp.net").length).toBeGreaterThan(0);
    store.close();
  });

  it("runs over a group: collects suggestions, not calendar events", async () => {
    const store = new Store(":memory:");
    const g = "120363000000000000@g.us";
    store.upsertChat({ jid: g, name: "Estadística III - Secc A", isGroup: true });
    for (let i = 0; i < 20; i++) store.insertMessage(msg({ chat_jid: g, from_me: 1, text: `msg ${i}`, timestamp: Date.now() }));
    store.insertMessage(msg({ chat_jid: g, from_me: 0, text: "El examen parcial es el 20 de julio", timestamp: Date.now() }));

    const runner = new AnalysisRunner(store);
    runner.start({ mode: "groups", minOutgoing: 5 });
    const deadline = Date.now() + 3000;
    while (runner.status?.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

    expect(runner.status!.suggestionsFound).toBeGreaterThan(0);
    expect(store.listSuggestedEvents("suggested").length).toBeGreaterThan(0);
    expect(store.listEvents({}).length).toBe(0); // never auto-scheduled
    store.close();
  });
});

describe("suggested → confirmed", () => {
  it("promotes a suggestion to a real event", () => {
    const store = new Store(":memory:");
    store.addSuggestedEvent({ chatJid: "g@g.us", title: "Examen 20 jul", whenTs: Date.now() + 86400000, rawText: "…", sourceMsgId: "m1" });
    const s = store.listSuggestedEvents("suggested")[0]!;
    expect(s.title).toContain("Examen");
    store.setSuggestedStatus(s.id, "confirmed");
    expect(store.listSuggestedEvents("suggested").length).toBe(0);
    store.close();
  });
});
