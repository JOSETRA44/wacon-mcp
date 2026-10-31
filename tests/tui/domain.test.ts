import { describe, it, expect } from "vitest";
import { foldIdentities, matchesQuery, previewLine, initials, toSummary, byRecency, type ChatSummary, type OverviewRow } from "../../src/tui/domain/chat.js";
import { cleanText, kindOf, mergeMessages, mediaLabel, type ChatMessage } from "../../src/tui/domain/message.js";
import { buildTimeline } from "../../src/tui/domain/timeline.js";
import { listTime, dayLabel } from "../../src/tui/domain/time.js";
import { wrap, truncate, cells } from "../../src/tui/domain/text.js";
import { parseDroppedPath, commonPrefix } from "../../src/tui/domain/input.js";
import { shouldNotify } from "../../src/tui/domain/notify.js";

const row = (over: Partial<OverviewRow>): OverviewRow => ({
  jid: "a@s.whatsapp.net", is_group: 0, unread_count: 0, last_message_ts: 1000, display_name: "Ana",
  alt_jid: null, last_text: "hola", last_from_me: 0, last_type: "text", last_sender_name: null, ...over,
});
const chat = (over: Partial<ChatSummary>): ChatSummary => ({ ...toSummary(row({})), ...over });
const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: Math.random().toString(36), chatJid: "a", senderJid: "a", fromMe: false, ts: 0, text: "x", kind: "text", status: "received", ...over,
});

describe("chat list rules", () => {
  it("folds an @lid and its phone number into ONE row, summing unread and keeping the real name", () => {
    const lid = toSummary(row({ jid: "123@lid", display_name: null, alt_jid: "51987@s.whatsapp.net", unread_count: 2, last_message_ts: 2000 }));
    const pn = toSummary(row({ jid: "51987@s.whatsapp.net", display_name: "Nayda", alt_jid: "123@lid", unread_count: 1, last_message_ts: 1000 }));
    const out = foldIdentities([lid, pn]);
    expect(out).toHaveLength(1);
    expect(out[0]!.jid).toBe("123@lid"); // newest half is where WhatsApp routes now
    expect(out[0]!.name).toBe("Nayda");
    expect(out[0]!.unread).toBe(3);
    expect(out[0]!.aliases).toContain("51987@s.whatsapp.net");
  });

  it("orders by recency only — unread never jumps the queue", () => {
    const sorted = [chat({ jid: "old", lastTs: 1, unread: 9 }), chat({ jid: "new", lastTs: 5 })].sort(byRecency);
    expect(sorted.map((c) => c.jid)).toEqual(["new", "old"]);
  });

  it("search ignores accents/case and also matches numbers and preview text", () => {
    const c = chat({ name: "José Pérez", jid: "51987654321@s.whatsapp.net", preview: { text: "nos vemos mañana", fromMe: false, senderName: null, kind: "text" } });
    expect(matchesQuery(c, "jose")).toBe(true);
    expect(matchesQuery(c, "PEREZ")).toBe(true);
    expect(matchesQuery(c, "987654")).toBe(true);
    expect(matchesQuery(c, "manana")).toBe(true);
    expect(matchesQuery(c, "carlos")).toBe(false);
  });

  it("previews read like WhatsApp", () => {
    expect(previewLine(chat({ preview: { text: "ok", fromMe: true, senderName: null, kind: "text" } }))).toBe("Tú: ok");
    expect(previewLine(chat({ isGroup: true, preview: { text: "", fromMe: false, senderName: "Luis Gómez", kind: "image" } }))).toBe("Luis: 📷 Foto");
    expect(initials("Ana María")).toBe("AM");
    expect(initials("+51 987")).toBe("#");
  });
});

describe("messages", () => {
  it("strips agent-facing hints from media placeholders", () => {
    expect(cleanText("[imagen: la playa] usa view_image(message_id)", "image")).toBe("la playa");
    expect(cleanText("[nota de voz 0:12] usa transcribe_audio(message_id)", "voice")).toBe("0:12");
    expect(kindOf("audio", "[nota de voz 0:12]")).toBe("voice");
    expect(mediaLabel("voice", "0:12")).toBe("🎤 Nota de voz 0:12");
  });

  it("merging keeps local in-flight sends and dedupes by id", () => {
    const local = msg({ id: "local-1", fromMe: true, status: "pending", ts: 5 });
    const merged = mergeMessages([msg({ id: "a", ts: 1 }), local], [msg({ id: "a", ts: 1 }), msg({ id: "b", ts: 3 })]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "local-1"]);
  });
});

describe("timeline", () => {
  const day = 86_400_000;
  const now = new Date(2026, 9, 31, 12).getTime();
  it("inserts day separators and an unread marker, and groups runs by sender", () => {
    const items = buildTimeline(
      [msg({ id: "1", ts: now - day, senderJid: "x" }), msg({ id: "2", ts: now - 60_000, senderJid: "x" }), msg({ id: "3", ts: now - 30_000, senderJid: "x" })],
      now,
      2
    );
    expect(items.map((i) => i.type)).toEqual(["day", "msg", "day", "unread", "msg", "msg"]);
    expect(items[0]).toMatchObject({ label: "AYER" });
    expect(items[2]).toMatchObject({ label: "HOY" });
    const [m2, m3] = items.filter((i) => i.type === "msg").slice(1) as { first: boolean; last: boolean }[];
    expect(m2).toMatchObject({ first: true, last: false });
    expect(m3).toMatchObject({ first: false, last: true });
  });

  it("list time says hour today, 'ayer', weekday, then a date", () => {
    expect(listTime(now - 60_000, now)).toMatch(/^\d{2}:\d{2}$/);
    expect(listTime(now - day, now)).toBe("ayer");
    expect(listTime(now - 3 * day, now)).toMatch(/^[a-záéíóú]+$/);
    expect(listTime(now - 30 * day, now)).toMatch(/\d{2}\/\d{2}\/\d{2}/);
    expect(dayLabel(now, now)).toBe("HOY");
  });
});

describe("text layout by terminal cells", () => {
  it("wraps on words, counts emoji as two cells, hard-breaks long URLs", () => {
    expect(wrap("hola qué tal amigo", 9)).toEqual(["hola qué", "tal amigo"]);
    for (const l of wrap("😀😀😀😀😀", 4)) expect(cells(l)).toBeLessThanOrEqual(4);
    expect(wrap("https://example.com/abcdefgh", 10).every((l) => cells(l) <= 10)).toBe(true);
    expect(truncate("Alejandro Magno", 8)).toBe("Alejand…");
  });
});

describe("dropped files", () => {
  it("recognises paths a terminal pastes when you drag a file in", () => {
    expect(parseDroppedPath('"C:\\Users\\me\\Fotos\\playa 1.jpg"')).toBe("C:\\Users\\me\\Fotos\\playa 1.jpg");
    expect(parseDroppedPath("/home/me/My\\ Docs/cv.pdf")).toBe("/home/me/My Docs/cv.pdf");
    expect(parseDroppedPath("file:///C:/tmp/a%20b.png")).toBe("C:/tmp/a b.png");
    expect(parseDroppedPath("hola, nos vemos a las 5")).toBeNull();
    expect(parseDroppedPath("C:\\Users\\me")).toBeNull(); // folder, not a file
    expect(commonPrefix(["C:\\a\\foto1.jpg", "C:\\a\\foto2.jpg"])).toBe("C:\\a\\foto");
  });
});

describe("notification policy", () => {
  const base = { isGroup: false, text: "hola", selfName: "José", lastNotifiedAt: 0, now: 100_000 };
  it("direct chats notify; a busy group is throttled unless you are mentioned", () => {
    expect(shouldNotify(base)).toBe(true);
    expect(shouldNotify({ ...base, isGroup: true, lastNotifiedAt: 90_000 })).toBe(false);
    expect(shouldNotify({ ...base, isGroup: true, lastNotifiedAt: 90_000, text: "josé ven" })).toBe(true);
  });
});

describe("invisible WhatsApp machinery", () => {
  it("hides reactions, edits and undecodable stubs, but labels locations, contacts and polls", async () => {
    const { isInvisibleMessage } = await import("../../src/core/message-types.js");
    expect(isInvisibleMessage("protocol", null)).toBe(true);
    expect(isInvisibleMessage("reaction", null)).toBe(true);
    expect(isInvisibleMessage("unknown", null)).toBe(true);
    expect(isInvisibleMessage("unknown", "algo")).toBe(false);
    expect(isInvisibleMessage("conversation", "hola")).toBe(false);
    expect(mediaLabel(kindOf("location", null), "")).toBe("📍 Ubicación");
    expect(mediaLabel(kindOf("contactsArray", null), "")).toBe("👤 Contacto");
    expect(mediaLabel(kindOf("pollCreationMessageV3", null), "")).toBe("📊 Encuesta");
  });
});
