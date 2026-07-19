import type { WaconApi } from "../mcp/api.js";
import { ensureDaemon, type DaemonInfo } from "./lifecycle.js";

/**
 * HTTP implementation of WaconApi. Used by the CLI and the MCP stdio shim;
 * both auto-start the daemon on first call if it is not running.
 */
export class DaemonClient implements WaconApi {
  private info: DaemonInfo | null = null;

  private async rpc<T>(method: keyof WaconApi, args: unknown[] = [], timeoutMs = 60_000): Promise<T> {
    this.info ??= await ensureDaemon();
    const res = await fetch(`http://127.0.0.1:${this.info.port}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.info.token}`,
      },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(timeoutMs),
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
  recall(query: string, chat?: string, limit?: number): ReturnType<WaconApi["recall"]> {
    return this.rpc("recall", [query, chat, limit]);
  }
  listEpisodes(chat: string, limit?: number): ReturnType<WaconApi["listEpisodes"]> {
    return this.rpc("listEpisodes", [chat, limit]);
  }
  readEpisode(episodeId: number): ReturnType<WaconApi["readEpisode"]> {
    return this.rpc("readEpisode", [episodeId]);
  }
  summarizeEpisode(episodeId: number, summary: string): ReturnType<WaconApi["summarizeEpisode"]> {
    return this.rpc("summarizeEpisode", [episodeId, summary]);
  }
  groupInfo(groupJid: string): ReturnType<WaconApi["groupInfo"]> {
    return this.rpc("groupInfo", [groupJid]);
  }
  send(chat: string, text: string, clientName: string, typingMs?: number): ReturnType<WaconApi["send"]> {
    return this.rpc("send", [chat, text, clientName, typingMs]);
  }
  startWatch(rule: Parameters<WaconApi["startWatch"]>[0], durationMinutes: number, clientName: string): ReturnType<WaconApi["startWatch"]> {
    return this.rpc("startWatch", [rule, durationMinutes, clientName]);
  }
  stopWatch(sessionId?: string): ReturnType<WaconApi["stopWatch"]> {
    return this.rpc("stopWatch", [sessionId]);
  }
  watchStatus(): ReturnType<WaconApi["watchStatus"]> {
    return this.rpc("watchStatus");
  }
  waitForMessages(opts: Parameters<WaconApi["waitForMessages"]>[0]): ReturnType<WaconApi["waitForMessages"]> {
    // Long-poll: the daemon blocks up to 120s, so this request must outlive
    // the default fetch expectations. Give it headroom over the server cap.
    return this.rpc("waitForMessages", [opts], 150_000);
  }
  suggestWatchWindow(chat?: string): ReturnType<WaconApi["suggestWatchWindow"]> {
    return this.rpc("suggestWatchWindow", [chat]);
  }
  digest(sinceMinutes?: number, limit?: number): ReturnType<WaconApi["digest"]> {
    return this.rpc("digest", [sinceMinutes, limit]);
  }
  setPresence(presence: Parameters<WaconApi["setPresence"]>[0], chat?: string): ReturnType<WaconApi["setPresence"]> {
    return this.rpc("setPresence", [presence, chat]);
  }
  markRead(chat: string, limit?: number): ReturnType<WaconApi["markRead"]> {
    return this.rpc("markRead", [chat, limit]);
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
  rememberFact(chat: string, category: string, fact: string, confidence?: number): ReturnType<WaconApi["rememberFact"]> {
    return this.rpc("rememberFact", [chat, category, fact, confidence]);
  }
  forgetFact(chat: string, factId: number): ReturnType<WaconApi["forgetFact"]> {
    return this.rpc("forgetFact", [chat, factId]);
  }
  getFacts(chat: string): ReturnType<WaconApi["getFacts"]> {
    return this.rpc("getFacts", [chat]);
  }
  tagChat(chat: string, tag: string): ReturnType<WaconApi["tagChat"]> {
    return this.rpc("tagChat", [chat, tag]);
  }
  untagChat(chat: string, tag: string): ReturnType<WaconApi["untagChat"]> {
    return this.rpc("untagChat", [chat, tag]);
  }
  listSpecialChats(): ReturnType<WaconApi["listSpecialChats"]> {
    return this.rpc("listSpecialChats");
  }
  consultPlaybook(chat: string, situation: string): ReturnType<WaconApi["consultPlaybook"]> {
    // NotebookLM can take a while; give it room over the server-side timeout.
    return this.rpc("consultPlaybook", [chat, situation], 270_000);
  }
  prepareReply(chat: string, situation?: string): ReturnType<WaconApi["prepareReply"]> {
    return this.rpc("prepareReply", [chat, situation], 270_000);
  }
  doctor(): ReturnType<WaconApi["doctor"]> {
    return this.rpc("doctor", [], 45_000);
  }
  viewImage(chat: string, messageId: string): ReturnType<WaconApi["viewImage"]> {
    return this.rpc("viewImage", [chat, messageId], 120_000);
  }
  transcribeAudio(chat: string, messageId: string): ReturnType<WaconApi["transcribeAudio"]> {
    return this.rpc("transcribeAudio", [chat, messageId], 180_000);
  }
  errorLog(limit?: number, chat?: string): ReturnType<WaconApi["errorLog"]> {
    return this.rpc("errorLog", [limit, chat]);
  }
  scheduleEvent(input: Parameters<WaconApi["scheduleEvent"]>[0]): ReturnType<WaconApi["scheduleEvent"]> {
    return this.rpc("scheduleEvent", [input]);
  }
  listEvents(opts?: Parameters<WaconApi["listEvents"]>[0]): ReturnType<WaconApi["listEvents"]> {
    return this.rpc("listEvents", [opts]);
  }
  cancelEvent(id: number): ReturnType<WaconApi["cancelEvent"]> {
    return this.rpc("cancelEvent", [id]);
  }
  completeEvent(id: number): ReturnType<WaconApi["completeEvent"]> {
    return this.rpc("completeEvent", [id]);
  }
  addTask(input: Parameters<WaconApi["addTask"]>[0]): ReturnType<WaconApi["addTask"]> {
    return this.rpc("addTask", [input]);
  }
  listTasks(includeDone?: boolean): ReturnType<WaconApi["listTasks"]> {
    return this.rpc("listTasks", [includeDone]);
  }
  completeTask(id: number): ReturnType<WaconApi["completeTask"]> {
    return this.rpc("completeTask", [id]);
  }
  getAgenda(withinDays?: number): ReturnType<WaconApi["getAgenda"]> {
    return this.rpc("getAgenda", [withinDays]);
  }
  waitForTriggers(opts: Parameters<WaconApi["waitForTriggers"]>[0]): ReturnType<WaconApi["waitForTriggers"]> {
    return this.rpc("waitForTriggers", [opts], 150_000);
  }
  resolveContact(query: string): ReturnType<WaconApi["resolveContact"]> {
    return this.rpc("resolveContact", [query]);
  }
  analysisTargets(limit?: number): ReturnType<WaconApi["analysisTargets"]> {
    return this.rpc("analysisTargets", [limit]);
  }
  runBulkAnalysis(scope: Parameters<WaconApi["runBulkAnalysis"]>[0]): ReturnType<WaconApi["runBulkAnalysis"]> {
    return this.rpc("runBulkAnalysis", [scope]);
  }
  analysisStatus(): ReturnType<WaconApi["analysisStatus"]> {
    return this.rpc("analysisStatus");
  }
  getAnalysisBundle(chat: string): ReturnType<WaconApi["getAnalysisBundle"]> {
    return this.rpc("getAnalysisBundle", [chat]);
  }
  listSuggestedEvents(status?: string, limit?: number): ReturnType<WaconApi["listSuggestedEvents"]> {
    return this.rpc("listSuggestedEvents", [status, limit]);
  }
  confirmSuggestedEvent(id: number, notifyBeforeMinutes?: number): ReturnType<WaconApi["confirmSuggestedEvent"]> {
    return this.rpc("confirmSuggestedEvent", [id, notifyBeforeMinutes]);
  }
  dismissSuggestedEvent(id: number): ReturnType<WaconApi["dismissSuggestedEvent"]> {
    return this.rpc("dismissSuggestedEvent", [id]);
  }
  readReceiptsMode(): ReturnType<WaconApi["readReceiptsMode"]> {
    return this.rpc("readReceiptsMode", [], 20_000);
  }
  inbox(limit?: number, includeGroups?: boolean): ReturnType<WaconApi["inbox"]> {
    return this.rpc("inbox", [limit, includeGroups]);
  }
  commitments(sinceDays?: number): ReturnType<WaconApi["commitments"]> {
    return this.rpc("commitments", [sinceDays]);
  }
  briefing(sinceMinutes?: number): ReturnType<WaconApi["briefing"]> {
    return this.rpc("briefing", [sinceMinutes]);
  }
  groupMembers(group: string, minMessages?: number): ReturnType<WaconApi["groupMembers"]> {
    return this.rpc("groupMembers", [group, minMessages]);
  }
  analyzeGroupMembers(group: string, minMessages?: number): ReturnType<WaconApi["analyzeGroupMembers"]> {
    return this.rpc("analyzeGroupMembers", [group, minMessages], 180_000);
  }
  syncStickers(): ReturnType<WaconApi["syncStickers"]> {
    return this.rpc("syncStickers", [], 120_000);
  }
  listStickers(opts?: Parameters<WaconApi["listStickers"]>[0]): ReturnType<WaconApi["listStickers"]> {
    return this.rpc("listStickers", [opts]);
  }
  sendSticker(chat: string, stickerId: string, clientName: string): ReturnType<WaconApi["sendSticker"]> {
    return this.rpc("sendSticker", [chat, stickerId, clientName], 120_000);
  }
  sendFile(chat: string, filePath: string, opts?: Parameters<WaconApi["sendFile"]>[2]): ReturnType<WaconApi["sendFile"]> {
    return this.rpc("sendFile", [chat, filePath, opts], 180_000);
  }
  async logout(): Promise<void> {
    await this.rpc("logout");
  }
}
