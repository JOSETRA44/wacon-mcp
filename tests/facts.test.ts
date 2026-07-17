import { describe, it, expect } from "vitest";
import { Store } from "../src/core/store.js";
import { factGaps, renderFacts, normalizeCategory } from "../src/memory/facts.js";

const JID = "friend@s.whatsapp.net";

describe("contact facts (dimension 1)", () => {
  it("dedupes and updates facts in place ignoring accents/case", () => {
    const store = new Store(":memory:");
    const a = store.upsertFact({ jid: JID, category: "gustos", fact: "le gusta el reggaetón" });
    expect(a.updated).toBe(false);
    const b = store.upsertFact({ jid: JID, category: "gustos", fact: "Le gusta el reggaeton" });
    expect(b.updated).toBe(true);
    expect(b.id).toBe(a.id);
    expect(store.listFacts(JID)).toHaveLength(1);
    store.close();
  });

  it("stores distinct facts separately", () => {
    const store = new Store(":memory:");
    store.upsertFact({ jid: JID, category: "ocupacion", fact: "trabaja de enfermera" });
    store.upsertFact({ jid: JID, category: "fechas", fact: "cumpleaños 5 de marzo" });
    expect(store.listFacts(JID)).toHaveLength(2);
    store.close();
  });

  it("deletes facts scoped to the jid", () => {
    const store = new Store(":memory:");
    const { id } = store.upsertFact({ jid: JID, category: "contexto", fact: "tiene un perro Toby" });
    expect(store.deleteFact(id, "otro@s.whatsapp.net")).toBe(false); // wrong jid
    expect(store.deleteFact(id, JID)).toBe(true);
    expect(store.listFacts(JID)).toHaveLength(0);
    store.close();
  });

  it("reports gaps for high-value empty categories", () => {
    const store = new Store(":memory:");
    store.upsertFact({ jid: JID, category: "ocupacion", fact: "es abogada" });
    const gaps = factGaps(store.listFacts(JID));
    expect(gaps.some((g) => g.category === "ocupacion")).toBe(false); // filled
    expect(gaps.some((g) => g.category === "fechas")).toBe(true); // still empty
    store.close();
  });

  it("normalizes unknown categories to 'contexto'", () => {
    expect(normalizeCategory("GUSTOS")).toBe("gustos");
    expect(normalizeCategory("inventada")).toBe("contexto");
  });

  it("renders facts compactly grouped by category", () => {
    const store = new Store(":memory:");
    store.upsertFact({ jid: JID, category: "gustos", fact: "café" });
    store.upsertFact({ jid: JID, category: "gustos", fact: "salsa" });
    const rendered = renderFacts(store.listFacts(JID));
    expect(rendered).toContain("gustos:");
    expect(rendered).toContain("café");
    expect(rendered).toContain("salsa");
    store.close();
  });

  it("flags low-confidence facts with (?)", () => {
    const store = new Store(":memory:");
    store.upsertFact({ jid: JID, category: "salud", fact: "quizá es alérgica al maní", confidence: 0.3 });
    expect(renderFacts(store.listFacts(JID))).toContain("(?)");
    store.close();
  });
});

describe("chat tags", () => {
  it("adds, lists and removes tags", () => {
    const store = new Store(":memory:");
    store.tagChat(JID, "Seduccion");
    store.tagChat(JID, "amistad");
    expect(store.chatTags(JID)).toEqual(["amistad", "seduccion"]); // lowercased, sorted
    expect(store.untagChat(JID, "seduccion")).toBe(true);
    expect(store.chatTags(JID)).toEqual(["amistad"]);
    store.close();
  });

  it("lists all tagged chats grouped", () => {
    const store = new Store(":memory:");
    store.tagChat("a@s.whatsapp.net", "ventas");
    store.tagChat("a@s.whatsapp.net", "debate");
    store.tagChat("b@s.whatsapp.net", "amistad");
    const tagged = store.listTaggedChats();
    expect(tagged).toHaveLength(2);
    expect(tagged.find((c) => c.jid === "a@s.whatsapp.net")!.tags.sort()).toEqual(["debate", "ventas"]);
    store.close();
  });
});

describe("playbook cache", () => {
  it("stores and retrieves cached answers", () => {
    const store = new Store(":memory:");
    store.cachePlaybook({ tag: "seduccion", situationHash: "abc123", question: "q", answer: "usa reciprocidad", citationsJson: "[]" });
    const cached = store.getCachedPlaybook("seduccion", "abc123");
    expect(cached?.answer).toBe("usa reciprocidad");
    expect(store.getCachedPlaybook("seduccion", "nope")).toBeNull();
    store.close();
  });
});
