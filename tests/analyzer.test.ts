import { describe, it, expect } from "vitest";
import { analyzeStyle, describeStyle } from "../src/memory/analyzer.js";
import type { MessageRow } from "../src/core/store.js";

function msg(text: string, hour = 21): MessageRow {
  return {
    id: Math.random().toString(36).slice(2),
    chat_jid: "x@s.whatsapp.net",
    sender_jid: "me@s.whatsapp.net",
    from_me: 1,
    timestamp: new Date(2026, 0, 1, hour).getTime(),
    text,
    message_type: "text",
    quoted_id: null,
  };
}

describe("analyzeStyle", () => {
  it("detects casual style with emojis and jaja laughter", () => {
    const stats = analyzeStyle([
      msg("jajaja no manches wey 😂"),
      msg("va, nos vemos al rato 😂🔥"),
      msg("jajaja obvio que sí"),
      msg("oye bro pásame la ubi"),
      msg("jaja sale, dale"),
    ]);
    expect(stats.messageCount).toBe(5);
    expect(stats.laughterStyle).toBe("jaja");
    expect(stats.formality).toBe("casual");
    expect(stats.topEmojis[0]?.emoji).toBe("😂");
    expect(stats.startsLowercaseRatio).toBeGreaterThan(0.5);
  });

  it("detects formal style", () => {
    const stats = analyzeStyle([
      msg("Buenos días, le agradezco la información."),
      msg("Quedo atento a sus comentarios. Saludos cordiales."),
      msg("Estimado Juan, por favor envíeme el documento cuando usted pueda."),
    ]);
    expect(stats.formality).toBe("formal");
    expect(stats.usesFinalPunctuationRatio).toBe(1);
    expect(stats.laughterStyle).toBeNull();
  });

  it("handles empty input", () => {
    const stats = analyzeStyle([]);
    expect(stats.messageCount).toBe(0);
    expect(describeStyle(stats)).toContain("0 mensajes");
  });
});
