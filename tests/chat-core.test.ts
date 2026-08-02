import { describe, it, expect } from "vitest";
import { friendlyName, unquotePath } from "../src/cli/chat-core.js";

describe("friendlyName — never show a raw jid to a human", () => {
  it("keeps a real name untouched", () => {
    expect(friendlyName("51987654321@s.whatsapp.net", "Nayda")).toBe("Nayda");
  });

  it("formats a nameless phone-number jid like WhatsApp does", () => {
    expect(friendlyName("51987654321@s.whatsapp.net", null)).toBe("+51 987 654 321");
  });

  it("labels a nameless group instead of showing its jid", () => {
    expect(friendlyName("120363012345678901@g.us", null)).toBe("Grupo sin nombre");
  });

  it("labels a nameless @lid contact instead of showing a meaningless internal id", () => {
    expect(friendlyName("114547264335883@lid", undefined)).toBe("Contacto sin nombre");
  });
});

describe("unquotePath — pasted paths must just work", () => {
  it("strips the double quotes Windows' \"Copy as path\" adds", () => {
    expect(unquotePath('"C:\\Users\\USER\\foto con espacios.jpg"')).toBe("C:\\Users\\USER\\foto con espacios.jpg");
  });

  it("strips single quotes and surrounding whitespace", () => {
    expect(unquotePath("  '/home/user/nota.ogg'  ")).toBe("/home/user/nota.ogg");
  });

  it("leaves an ordinary path untouched", () => {
    expect(unquotePath("C:\\ruta\\informe.pdf")).toBe("C:\\ruta\\informe.pdf");
  });

  it("does not strip a quote that is only on one side", () => {
    // A lone quote is part of the filename, not a wrapper — removing it
    // would produce a path that does not exist.
    expect(unquotePath('mi"archivo.txt')).toBe('mi"archivo.txt');
  });
});
