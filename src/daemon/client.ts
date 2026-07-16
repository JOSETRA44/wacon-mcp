import type { WaconApi } from "../mcp/api.js";
import { ensureDaemon, type DaemonInfo } from "./lifecycle.js";

/**
 * HTTP implementation of WaconApi. Used by the CLI and the MCP stdio shim;
 * both auto-start the daemon on first call if it is not running.
 */
export class DaemonClient implements WaconApi {
  private info: DaemonInfo | null = null;

  private async rpc<T>(method: keyof WaconApi, args: unknown[] = []): Promise<T> {
    this.info ??= await ensureDaemon();
    const res = await fetch(`http://127.0.0.1:${this.info.port}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.info.token}`,
      },
      body: JSON.stringify({ method, args }),
    });
    const body = (await res.json()) as { result?: T; error?: string };
    if (!res.ok || body.error) {
      throw new Error(body.error ?? `Daemon RPC failed with status ${res.status}`);
    }
    return body.result as T;
  }

  status(): ReturnType<WaconApi["status"]> {
    return this.rpc("status");
  }
  qr(): ReturnType<WaconApi["qr"]> {
    return this.rpc("qr");
  }
  listChats(limit?: number): ReturnType<WaconApi["listChats"]> {
    return this.rpc("listChats", [limit]);
  }
  readMessages(chat: string, limit?: number, beforeTs?: number): ReturnType<WaconApi["readMessages"]> {
    return this.rpc("readMessages", [chat, limit, beforeTs]);
  }
  searchMessages(query: string, chat?: string, limit?: number): ReturnType<WaconApi["searchMessages"]> {
    return this.rpc("searchMessages", [query, chat, limit]);
  }
  searchContacts(query: string, limit?: number): ReturnType<WaconApi["searchContacts"]> {
    return this.rpc("searchContacts", [query, limit]);
  }
  groupInfo(groupJid: string): ReturnType<WaconApi["groupInfo"]> {
    return this.rpc("groupInfo", [groupJid]);
  }
  send(chat: string, text: string, clientName: string): ReturnType<WaconApi["send"]> {
    return this.rpc("send", [chat, text, clientName]);
  }
  getProfile(chat: string): ReturnType<WaconApi["getProfile"]> {
    return this.rpc("getProfile", [chat]);
  }
  async observe(chat: string, section: Parameters<WaconApi["observe"]>[1], observation: string): Promise<void> {
    await this.rpc("observe", [chat, section, observation]);
  }
  analyzeContact(chat: string): ReturnType<WaconApi["analyzeContact"]> {
    return this.rpc("analyzeContact", [chat]);
  }
  getPersona(): ReturnType<WaconApi["getPersona"]> {
    return this.rpc("getPersona");
  }
  initAll(minMessages?: number, minOutgoing?: number): ReturnType<WaconApi["initAll"]> {
    return this.rpc("initAll", [minMessages, minOutgoing]);
  }
  async logout(): Promise<void> {
    await this.rpc("logout");
  }
}
