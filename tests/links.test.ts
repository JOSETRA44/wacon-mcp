import { describe, it, expect } from "vitest";
import { Store, type MessageRow } from "../src/core/store.js";
import { classifyLink, extractUrls, patternsFor } from "../src/core/links.js";
import { agentBrief, toolLabel, TUI_TOOLSET } from "../src/tui/domain/agent.js";

let n = 0;
const m = (chat: string, text: string, over: Partial<MessageRow> = {}): MessageRow => ({
  id: `L${n++}`, chat_jid: chat, sender_jid: chat, from_me: 0, timestamp: 1_790_000_000_000 + n * 1000, text, message_type: "text", quoted_id: null, ...over,
});

describe("shared links", () => {
  it("extracts and classifies the links people actually share", () => {
    expect(extractUrls("llenen esto https://docs.google.com/spreadsheets/d/1AbC/edit?usp=sharing, gracias")).toEqual(["https://docs.google.com/spreadsheets/d/1AbC/edit?usp=sharing"]);
    expect(classifyLink("https://forms.gle/xyz")).toBe("forms");
    expect(classifyLink("https://docs.google.com/forms/d/e/1/viewform")).toBe("forms");
    expect(classifyLink("https://docs.google.com/spreadsheets/d/1")).toBe("sheets");
    expect(classifyLink("[documento: notas.xlsx]")).toBe("sheets");
    expect(classifyLink("https://meet.google.com/abc")).toBe("meet");
    expect(patternsFor(["any"])).toContain("https://");
  });

  it("finds sheets and forms across ALL chats — where full-text search finds nothing", () => {
    const s = new Store(":memory:");
    const grupo = "120363000000000001@g.us";
    const ana = "111@lid";
    s.insertMessages([
      m(grupo, "Llenen la asistencia https://docs.google.com/spreadsheets/d/1AbC/edit"),
      m(ana, "el formulario: https://forms.gle/Q1w2E3"),
      m(ana, "te paso el excel", { message_type: "document", text: "[documento: notas finales.xlsx]" }),
      m(grupo, "nos vemos en https://meet.google.com/aaa-bbbb-ccc"),
      m(ana, "hola, ¿cómo estás?"),
    ]);
    // The word never appears next to the link: FTS cannot answer the question.
    expect(s.searchMessages("sheets")).toEqual([]);
    const hits = s.findLinks(patternsFor(["sheets", "forms"]));
    expect(hits.map((h) => h.text)).toEqual([
      "[documento: notas finales.xlsx]",
      "el formulario: https://forms.gle/Q1w2E3",
      "Llenen la asistencia https://docs.google.com/spreadsheets/d/1AbC/edit",
    ]);
    expect(s.findLinks(patternsFor(["sheets"]), { chatJids: [grupo] })).toHaveLength(1);
    expect(s.findLinks(patternsFor(["any"]), { text: "asistencia" })).toHaveLength(1);
  });
});

describe("Modo IA sees the whole WhatsApp, not just the open chat", () => {
  it("offers the cross-chat tools and tells the agent it may use them", () => {
    for (const t of ["list_chats", "resolve_contact", "find_links", "search_messages"]) expect(TUI_TOOLSET).toContain(t);
    const brief = agentBrief("a@lid");
    expect(brief).toContain("TODO su WhatsApp");
    expect(brief).toContain("find_links");
    expect(brief).not.toContain("Para cualquier herramienta, el chat es");
  });

  it("labels global searches so the user sees the scope", () => {
    expect(toolLabel("mcp__wacon__find_links", { kinds: ["sheets", "forms"] })).toBe("🔗 Buscando enlaces (sheets, forms) en todos tus chats");
    expect(toolLabel("search_messages", { query: "viaje" })).toBe("🔎 Buscando «viaje» en todos tus chats");
    expect(toolLabel("search_messages", { query: "viaje", chat: "a@lid" })).toBe("🔎 Buscando «viaje»");
  });
});
