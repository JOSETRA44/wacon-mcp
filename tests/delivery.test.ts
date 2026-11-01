import { describe, it, expect } from "vitest";
import { Store } from "../src/core/store.js";
import { advanceDelivery, deliveryFromAck } from "../src/tui/domain/message.js";
import { parseFfmpegDuration } from "../src/media/video-meta.js";
import { stagingBytesNeeded, toMessageContent } from "../src/media/send-media.js";

describe("delivery receipts", () => {
  it("maps WhatsApp acks to what the bubble shows", () => {
    expect([0, 1, 2, 3, 4, 5, null, undefined].map(deliveryFromAck)).toEqual(["failed", "pending", "sent", "delivered", "read", "read", "sent", "sent"]);
  });

  it("only moves forward, because receipts arrive out of order", () => {
    expect(advanceDelivery("read", "delivered")).toBe("read");
    expect(advanceDelivery("sent", "delivered")).toBe("delivered");
    expect(advanceDelivery("pending", "read")).toBe("read");
    expect(advanceDelivery("received", "read")).toBe("received");
  });

  it("stores receipts, never downgrades, and follows the @lid/phone twin", () => {
    const s = new Store(":memory:");
    s.mapJids("111@lid", "51999@s.whatsapp.net");
    s.insertMessage({ id: "A", chat_jid: "111@lid", sender_jid: null, from_me: 1, timestamp: 1, text: "hola", message_type: "text", quoted_id: null });
    s.updateMessageStatus("111@lid", "A", 2);
    s.updateMessageStatus("51999@s.whatsapp.net", "A", 4); // receipt names the phone half
    s.updateMessageStatus("111@lid", "A", 3); // late delivery receipt
    expect(s.messageStatuses(["A", "missing"])).toEqual([{ id: "A", status: 4 }]);
    expect((s.readMessages("111@lid")[0] as { status?: number }).status).toBe(4);
  });
});

describe("video sending", () => {
  it("reads the duration from ffmpeg's banner", () => {
    expect(parseFfmpegDuration("  Duration: 00:01:02.50, start: 0.000000, bitrate: 900 kb/s")).toBe(63);
    expect(parseFfmpegDuration("  Duration: 00:00:00.20, start")).toBe(1);
    expect(parseFfmpegDuration("no banner")).toBeUndefined();
  });

  it("asks for room for Baileys' two temp copies plus margin", () => {
    expect(stagingBytesNeeded(10 * 1024 * 1024)).toBe(94 * 1024 * 1024);
  });

  it("puts the still frame and duration on the video message", () => {
    const media = { kind: "video" as const, mimetype: "video/mp4", fileName: "v.mp4", buffer: Buffer.from("x"), bytes: 1 };
    const thumb = Buffer.from("jpg");
    expect(toMessageContent(media, { jpegThumbnail: thumb, seconds: 12 })).toMatchObject({ video: media.buffer, jpegThumbnail: thumb, seconds: 12 });
    expect(toMessageContent(media)).not.toHaveProperty("jpegThumbnail");
  });
});
