import { describe, it, expect } from "vitest";
import { isAuthoredText, analyzeStyle } from "../src/memory/analyzer.js";
import { draftPersonaBody, isTemplateBody } from "../src/memory/persona.js";
import { Store, type MessageRow } from "../src/core/store.js";

function msg(text: string): MessageRow {
  return { id: Math.random().toString(36).slice(2), chat_jid: "c@s.whatsapp.net", sender_jid: null, from_me: 1, timestamp: Date.now(), text, message_type: "text", quoted_id: null };
}

describe("isAuthoredText — what counts as the user's own writing", () => {
  it("rejects Wacon's own media placeholders", () => {
    // These were silently teaching the persona to speak like our tooling.
    expect(isAuthoredText("[imagen] usa view_image(message_id)")).toBe(false);
    expect(isAuthoredText("[nota de voz 0:12] usa transcribe_audio(message_id)")).toBe(false);
    expect(isAuthoredText("[sticker]")).toBe(false);
  });

  it("rejects pasted code/SQL and bare links", () => {
    expect(isAuthoredText("id uuid NOT NULL DEFAULT gen_random_uuid()")).toBe(false);
    expect(isAuthoredText("CREATE TABLE users (id int)")).toBe(false);
    expect(isAuthoredText("const x = () => 1")).toBe(false);
    expect(isAuthoredText("https://example.com/a/b/c")).toBe(false);
  });

  it("keeps real conversational writing", () => {
    expect(isAuthoredText("Holaa Nayda")).toBe(true);
    expect(isAuthoredText("Técnicamente si, cae un sábado")).toBe(true);
    expect(isAuthoredText("mira esto https://x.com/y")).toBe(true); // has real words
  });
});

describe("style analysis is not polluted", () => {
  it("ignores placeholders when measuring length and phrases", () => {
    const noisy = [
      msg("[imagen] usa view_image(message_id)"),
      msg("[imagen] usa view_image(message_id)"),
      msg("holaa"),
      msg("ya voy"),
    ];
    const stats = analyzeStyle(noisy);
    expect(stats.messageCount).toBe(2); // only the real ones
    expect(stats.avgMessageLength).toBeLessThan(12);
    expect(stats.topPhrases.some((p) => p.phrase.includes("view"))).toBe(false);
  });

  it("strips URL tokens from recurring phrases", () => {
    const withLinks = Array.from({ length: 5 }, () => msg("mira esto https://ssl.cf2.rackcdn.com/foto.jpg que buena"));
    const stats = analyzeStyle(withLinks);
    expect(stats.topPhrases.some((p) => /rackcdn|https|www/.test(p.phrase))).toBe(false);
  });
});

describe("persona drafting", () => {
  it("recognises the untouched template and replaces it with evidence", () => {
    const template = "## Mi voz\n\n_(Edita esta sección a mano — nadie conoce tu voz mejor que tú. Los agentes...)_\n\n- Cosas que JAMÁS diría:\n- Muletillas que sí uso:\n";
    expect(isTemplateBody(template)).toBe(true);

    const stats = analyzeStyle([msg("holaa"), msg("ya voy jaja"), msg("sale nos vemos")]);
    const body = draftPersonaBody(stats, ["holaa", "sale nos vemos"]);
    expect(isTemplateBody(body)).toBe(false);
    expect(body).toContain("Tono general");
    expect(body).toContain("Cómo sueno");
    expect(body).toContain("holaa"); // real sample included
    expect(body).toContain("Reglas para agentes");
  });
});

describe("balanced persona sampling", () => {
  it("caps how much a single heavy chat contributes", () => {
    const store = new Store(":memory:");
    const base = Date.now();
    // One chat with 300 messages, another with 10.
    for (let i = 0; i < 300; i++) {
      store.insertMessage({ ...msg(`bot chat ${i}`), chat_jid: "bot@s.whatsapp.net", timestamp: base + i });
    }
    for (let i = 0; i < 10; i++) {
      store.insertMessage({ ...msg(`amigo ${i}`), chat_jid: "amigo@s.whatsapp.net", timestamp: base + i });
    }
    const sample = store.balancedOutgoingSample(50);
    const fromBot = sample.filter((m) => m.chat_jid === "bot@s.whatsapp.net").length;
    expect(fromBot).toBe(50); // capped, not 300
    expect(sample.filter((m) => m.chat_jid === "amigo@s.whatsapp.net").length).toBe(10);
    store.close();
  });
});
