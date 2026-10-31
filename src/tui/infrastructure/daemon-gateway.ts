import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DaemonClient } from "../../daemon/client.js";
import { openWithSystemViewer } from "../../cli/chat-core.js";
import type { MessageKind } from "../domain/message.js";
import type { ChatGateway, LinkState, Presence, SendOutcome } from "../application/ports.js";

/**
 * Adapter: the app's ChatGateway port implemented over the Wacon daemon's
 * RPC client. Translation only — daemon shapes in, app shapes out — so the
 * controller never sees `Guided`, `SendResult` or base64 payloads.
 */
export class DaemonGateway implements ChatGateway {
  private static readonly CLIENT = "cli-ultra";

  constructor(private readonly client: DaemonClient) {}

  async linkState() {
    const s = await this.client.status();
    return { state: s.state as LinkState, selfName: null };
  }
  async relink() {
    return (await this.client.relogin()).state as LinkState;
  }
  async qr() {
    const r = await this.client.qr();
    return { state: r.state as LinkState, qr: r.qr };
  }

  overview(limit: number) {
    return this.client.chatOverview(limit);
  }
  messages(chatJid: string, limit: number, beforeTs?: number) {
    return this.client.readMessages(chatJid, limit, beforeTs);
  }
  async memberNames(groupJid: string) {
    const rows = (await this.client.groupMembers(groupJid, 1)) as { sender_jid: string; display_name: string | null }[];
    const out: Record<string, string> = {};
    for (const r of rows) if (r.display_name) out[r.sender_jid] = r.display_name;
    return out;
  }
  async presence(chatJid: string): Promise<Presence> {
    const p = await this.client.contactPresence(chatJid, 2);
    return { status: p.status, lastSeenRelative: p.lastSeenRelative };
  }

  async sendText(chatJid: string, text: string): Promise<SendOutcome> {
    const r = await this.client.send(chatJid, text, DaemonGateway.CLIENT);
    return r.sent ? { ok: true, messageId: r.messageId } : { ok: false, reason: r.reason ?? (r.dryRun ? "modo prueba (dryRun)" : "bloqueado") };
  }
  async sendFile(chatJid: string, path: string, caption?: string) {
    const r = await this.client.sendFile(chatJid, path, { clientName: DaemonGateway.CLIENT, caption });
    if ("guidance" in r) return { ok: false as const, reason: r.guidance };
    if (!r.sent) return { ok: false as const, reason: r.reason ?? "bloqueado" };
    return { ok: true as const, messageId: r.messageId, kind: r.kind as MessageKind | undefined, fileName: r.fileName };
  }
  async markRead(chatJid: string) {
    await this.client.markRead(chatJid, 10);
  }

  async waitForMessages(cursor: number, timeoutSeconds: number) {
    const r = await this.client.waitForMessages({ since: cursor, timeoutSeconds });
    return { cursor: r.cursor, events: r.events };
  }
  async currentCursor() {
    return (await this.client.status()).cursor;
  }

  /**
   * Terminals cannot show images reliably, so the file is saved and handed to
   * the OS viewer — what the user would do anyway. Voice notes come back as
   * a transcript when a transcription backend is configured.
   */
  async openMedia(chatJid: string, messageId: string, kind: MessageKind): Promise<string> {
    const dir = join(tmpdir(), "wacon-media");
    mkdirSync(dir, { recursive: true });
    if (kind === "voice" || kind === "audio") {
      const res = await this.client.transcribeAudio(chatJid, messageId);
      if ("guidance" in res) throw new Error(res.guidance);
      if (res.mode === "transcript") return `🎧 “${res.text}”`;
      const file = join(dir, `${messageId}.ogg`);
      writeFileSync(file, Buffer.from(res.base64, "base64"));
      openWithSystemViewer(file);
      return "Reproduciendo el audio en tu reproductor";
    }
    const res = await this.client.viewImage(chatJid, messageId);
    if ("guidance" in res) throw new Error(res.guidance);
    const ext = (res.mimetype.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "") || "bin";
    const file = join(dir, `${messageId}.${ext}`);
    writeFileSync(file, Buffer.from(res.base64, "base64"));
    openWithSystemViewer(file);
    return res.description ? `Abierto en tu visor · ${res.description}` : "Abierto en tu visor de imágenes";
  }

  fileExists(path: string): boolean {
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  }
}
