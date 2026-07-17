import { describe, it, expect } from "vitest";
import { Store } from "../src/core/store.js";
import { logError, GUIDANCE } from "../src/core/errors.js";

describe("anti-fraud error handling", () => {
  it("logs the real error and returns natural guidance, never throwing", () => {
    const store = new Store(":memory:");
    const result = logError(
      store,
      { operation: "transcribe_audio", chatJid: "x@s.whatsapp.net", error: new Error("decode failed 0x5"), context: { msgId: "abc" }, client: "test" },
      GUIDANCE.audioFailed
    );
    expect(result.ok).toBe(false);
    expect(result.guidance).toBe(GUIDANCE.audioFailed);
    expect(result.guidance).not.toContain("decode failed"); // raw error never surfaced
    expect(result.guidance).not.toContain("0x5");

    const logged = store.recentErrors(10);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.operation).toBe("transcribe_audio");
    expect(logged[0]!.error).toContain("decode failed 0x5"); // real error kept locally
    expect(logged[0]!.chat_jid).toBe("x@s.whatsapp.net");
    store.close();
  });

  it("never throws even if the store write fails", () => {
    const store = new Store(":memory:");
    store.close(); // writing now would throw internally
    expect(() => logError(store, { operation: "view_image", error: "boom" }, GUIDANCE.imageFailed)).not.toThrow();
  });

  it("filters error log by chat", () => {
    const store = new Store(":memory:");
    store.logErrorRow({ operation: "a", chatJid: "one@s.whatsapp.net", error: "e1" });
    store.logErrorRow({ operation: "b", chatJid: "two@s.whatsapp.net", error: "e2" });
    expect(store.recentErrors(10, "one@s.whatsapp.net")).toHaveLength(1);
    expect(store.recentErrors(10)).toHaveLength(2);
    store.close();
  });
});

describe("media stub storage", () => {
  it("persists and retrieves a media stub", () => {
    const store = new Store(":memory:");
    store.upsertMedia({
      chat_jid: "c@s.whatsapp.net",
      msg_id: "m1",
      kind: "audio",
      mimetype: "audio/ogg; codecs=opus",
      media_key: Buffer.from("key").toString("base64"),
      direct_path: "/v/t62",
      url: "https://mmg.whatsapp.net/x",
      file_length: 1234,
      seconds: 7,
      is_ptt: 1,
      caption: null,
      timestamp: Date.now(),
    });
    const got = store.getMedia("c@s.whatsapp.net", "m1");
    expect(got?.kind).toBe("audio");
    expect(got?.is_ptt).toBe(1);
    expect(got?.seconds).toBe(7);
    expect(store.getMedia("c@s.whatsapp.net", "nope")).toBeNull();
    store.close();
  });
});
