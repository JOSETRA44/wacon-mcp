import type { Store, MessageRow } from "./store.js";
import type { WhatsAppConnection, ConnectionState } from "./connection.js";
import { loadConfig } from "./config.js";
import { checkSend } from "./guardrails.js";
import { WatchRegistry, MAX_WATCH_MINUTES, type WatchRule, type WatchSession, type WatchEvent } from "./watch.js";
import { suggestWatchWindow, type WatchWindowSuggestion } from "./activity.js";
import { analyzeStyle, analyzeDynamics, describeStyle, isAuthoredText, type StyleStats } from "../memory/analyzer.js";
import { recall, type RecallResult } from "../memory/recall.js";
import { readProfile, writeProfileStats, appendObservation, type ProfileSection, type ContactProfile } from "../memory/profiles.js";
import { readPersona, writePersonaStats } from "../memory/persona.js";
import { normalizeCategory, factGaps, renderFacts, type FactCategory } from "../memory/facts.js";
import { consultPlaybook, type PlaybookResult } from "../knowledge/notebook.js";
import { readFileSync } from "node:fs";
import { runDoctor, type DoctorReport } from "./doctor.js";
import { ProactiveScheduler } from "./scheduler.js";
import { AnalysisRunner, type AnalysisScope, type AnalysisJob } from "../analysis/runner.js";
import { extractFacts, extractActionables } from "../analysis/extractors.js";
import { pendingReplies, openCommitments } from "../analysis/productivity.js";
import { logError, GUIDANCE, type Guided } from "./errors.js";
import { fetchMedia } from "../media/media.js";
import { transcribe } from "../media/transcription.js";
import { prepareMedia, toMessageContent } from "../media/send-media.js";
import { importPack, indexOwnStickers, stickerAffinity, MOODS } from "../media/stickers.js";
import type { FactRow, EventRow, TaskRow, ErrorRow } from "./store.js";

export interface StatusInfo {
  state: ConnectionState;
  selfJid: string | null;
  presence: string;
  activeWatches: number;
  cursor: number;
  stats: { chats: number; contacts: number; messages: number; outgoing: number };
}

export interface WaitResult {
  events: {
    seq: number;
    chat: string;
    chatName: string | null;
    from: string | null;
    at: string;
    text: string | null;
    type: string;
    priority: number;
    reasons: string[];
  }[];
  cursor: number;
  timedOut: boolean;
}

export interface DigestEntry {
  chat: string;
  name: string | null;
  isGroup: boolean;
  incoming: number;
  lastAt: string;
  preview: string | null;
}

export interface SendResult {
  sent: boolean;
  dryRun: boolean;
  messageId: string | null;
  reason?: string;
}

/** Accepts a full JID or a bare phone number and normalizes to a JID. */
export function normalizeJid(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  return `${digits}@s.whatsapp.net`;
}

/**
 * The single behavioral surface of Wacon. The daemon exposes these methods
 * over HTTP; MCP tools and CLI commands are thin adapters over them.
 */
export class WaconService {
  readonly watch: WatchRegistry;
  readonly scheduler: ProactiveScheduler;
  readonly analysis: AnalysisRunner;

  constructor(
    private store: Store,
    private connection: WhatsAppConnection
  ) {
    this.watch = new WatchRegistry(store);
    // The connection stays unaware of attention concerns; the service wires them.
    this.connection.on("message", (msg) => this.watch.ingest(msg, this.connection.selfJid));
    this.scheduler = new ProactiveScheduler(store, this.watch, loadConfig().proactivePollSeconds);
    this.analysis = new AnalysisRunner(store);
  }

  status(): StatusInfo {
    return {
      state: this.connection.state,
      selfJid: this.connection.selfJid,
      presence: this.connection.presence,
      activeWatches: this.watch.activeSessions().length,
      cursor: this.watch.cursor,
      stats: this.store.stats(),
    };
  }

  qr(): { state: ConnectionState; qr: string | null } {
    return { state: this.connection.state, qr: this.latestQr() };
  }

  private latestQr(): string | null {
    return this.connection.state === "waiting_qr" ? this.connection.latestQr : null;
  }

  /**
   * Resolve any name / phone / JID to the chat JID that actually holds the
   * messages — transparently crossing the @lid ↔ phone split. Analysis and
   * read methods run inputs through this so agents never hit the "no messages
   * for <number>" trap that comes from WhatsApp's privacy addressing.
   */
  private resolveChatJid(input: string): string {
    const direct = normalizeJid(input);
    const hits = this.store.resolveChat(input);
    if (hits.length === 0) return direct;
    return hits.find((h) => h.jid === direct)?.jid ?? hits[0]!.jid;
  }

  resolveContact(query: string) {
    return this.store.resolveChat(query);
  }

  analysisTargets(limit = 25) {
    return this.store.analysisTargets(limit);
  }

  // ── automated analysis pipeline (brute force, no LLM) ────

  runBulkAnalysis(scope: AnalysisScope): AnalysisJob {
    return this.analysis.start(scope);
  }

  analysisStatus(): AnalysisJob | null {
    return this.analysis.status;
  }

  /**
   * The pre-chewed work package for a chat: everything Tier-1 extracted, so an
   * agent enriches instead of reading raw history. If the chat hasn't been
   * batch-analyzed yet, this computes the candidates on the fly.
   */
  getAnalysisBundle(chatOrPhone: string) {
    const jid = this.resolveChatJid(chatOrPhone);
    const all = this.store.allMessages(jid, 5000);
    const isGroup = jid.endsWith("@g.us");
    const profile = readProfile(jid);
    const facts = this.store.listFacts(jid);
    const episodes = this.store.listEpisodes(jid, 40).map((e) => ({
      id: e.id,
      from: new Date(e.start_ts).toISOString(),
      to: new Date(e.end_ts).toISOString(),
      messages: e.message_count,
      summary: e.summary,
    }));
    const candidateFacts = isGroup ? [] : extractFacts(all.filter((m) => !m.from_me));
    const actionables = isGroup ? extractActionables(all) : [];
    return {
      chat: jid,
      displayName: this.store.resolveDisplayName(jid),
      isGroup,
      tags: this.store.chatTags(jid),
      stats: profile?.stats ?? null,
      styleSummary: profile?.stats ? describeStyle(profile.stats as StyleStats) : null,
      facts,
      candidateFacts,
      dynamicsNotes: profile?.body ?? null,
      episodes,
      actionables,
      messageTotals: { total: all.length, outgoing: all.filter((m) => m.from_me).length },
    };
  }

  listSuggestedEvents(status = "suggested", limit = 50) {
    return this.store.listSuggestedEvents(status, limit).map((s) => ({
      id: s.id,
      chat: s.chat_jid,
      chatName: this.store.resolveDisplayName(s.chat_jid),
      title: s.title,
      when: s.when_ts ? new Date(s.when_ts).toISOString() : null,
      raw: s.raw_text,
    }));
  }

  confirmSuggestedEvent(id: number, notifyBeforeMinutes = 720): { confirmed: boolean; eventId?: number } {
    const s = this.store.getSuggestedEvent(id);
    if (!s) return { confirmed: false };
    const startTs = s.when_ts ?? Date.now() + 86_400_000; // default: tomorrow if no date parsed
    const ev = this.store.createEvent({
      chatJid: s.chat_jid,
      title: s.title,
      startTs,
      notifyTs: startTs - notifyBeforeMinutes * 60_000,
      createdBy: "suggested",
      notes: `Confirmado desde sugerencia #${id}`,
    });
    this.store.setSuggestedStatus(id, "confirmed");
    return { confirmed: true, eventId: ev.id };
  }

  dismissSuggestedEvent(id: number): { dismissed: boolean } {
    return { dismissed: this.store.setSuggestedStatus(id, "dismissed") };
  }

  listChats(limit = 30) {
    return this.store.listChats(limit);
  }

  readMessages(chatJid: string, limit = 30, beforeTs?: number): MessageRow[] {
    return this.store.readMessages(this.resolveChatJid(chatJid), limit, beforeTs);
  }

  searchMessages(query: string, chatJid?: string, limit = 20) {
    return this.store.searchMessages(query, { chatJid: chatJid ? this.resolveChatJid(chatJid) : undefined, limit });
  }

  /** Hybrid memory retrieval: keyword (BM25) + semantic (hashed vectors) + recency, RRF-fused, plus matching episode summaries. */
  recall(query: string, chatJid?: string, limit = 12): RecallResult {
    return recall(this.store, query, { chatJid: chatJid ? this.resolveChatJid(chatJid) : undefined, limit });
  }

  listEpisodes(chatJid: string, limit = 20) {
    const jid = this.resolveChatJid(chatJid);
    this.store.rebuildEpisodes(jid);
    return this.store.listEpisodes(jid, limit);
  }

  readEpisode(episodeId: number) {
    const ep = this.store.getEpisode(episodeId);
    if (!ep) throw new Error(`Episode ${episodeId} not found. Use list_episodes first.`);
    return { episode: ep, messages: this.store.messagesInRange(ep.chat_jid, ep.start_ts, ep.end_ts) };
  }

  summarizeEpisode(episodeId: number, summary: string) {
    const ep = this.store.getEpisode(episodeId);
    if (!ep) throw new Error(`Episode ${episodeId} not found. Use list_episodes first.`);
    this.store.setEpisodeSummary(episodeId, summary);
    return { saved: true, episodeId };
  }

  searchContacts(query: string, limit = 20) {
    return this.store.searchContacts(query, limit);
  }

  async groupInfo(groupJid: string) {
    const meta = await this.connection.groupMetadata(normalizeJid(groupJid));
    return {
      jid: meta.id,
      subject: meta.subject,
      description: meta.desc ?? null,
      participantCount: meta.participants.length,
      participants: meta.participants.map((p) => ({
        jid: p.id,
        isAdmin: p.admin === "admin" || p.admin === "superadmin",
      })),
    };
  }

  async send(chatJidOrPhone: string, text: string, clientName: string, typingMs = 0): Promise<SendResult> {
    const chatJid = normalizeJid(chatJidOrPhone);
    const config = loadConfig();
    const check = checkSend(config, this.store, chatJid);
    if (!check.allowed) {
      return { sent: false, dryRun: check.dryRun, messageId: null, reason: check.reason };
    }
    if (check.dryRun) {
      this.store.logSent({ chatJid, text, clientName, dryRun: true });
      return { sent: false, dryRun: true, messageId: null, reason: "dryRun is enabled in config.json — message logged but NOT sent" };
    }
    const { id } = await this.connection.sendText(chatJid, text, typingMs);
    this.store.logSent({ chatJid, text, clientName, dryRun: false });
    return { sent: true, dryRun: false, messageId: id };
  }

  // ── attention control ────────────────────────────────────

  startWatch(rule: Partial<WatchRule>, durationMinutes: number, clientName: string): WatchSession {
    return this.watch.start(rule, durationMinutes, clientName);
  }

  stopWatch(sessionId?: string): { stopped: number } {
    return { stopped: this.watch.stop(sessionId) };
  }

  watchStatus(): { sessions: (WatchSession & { minutesLeft: number })[]; cursor: number } {
    const now = Date.now();
    return {
      sessions: this.watch.activeSessions().map((s) => ({ ...s, minutesLeft: Math.round((s.expiresAt - now) / 60_000) })),
      cursor: this.watch.cursor,
    };
  }

  /**
   * Blocks until a matching message arrives or the timeout expires. One call
   * here replaces an entire polling loop — the daemon does the waiting for free.
   */
  async waitForMessages(opts: { since?: number; sessionId?: string; timeoutSeconds?: number }): Promise<WaitResult> {
    const timeoutMs = Math.min(Math.max(opts.timeoutSeconds ?? 60, 1), 120) * 1000;
    const events = await this.watch.wait({ since: opts.since, sessionId: opts.sessionId ?? null, timeoutMs });
    return {
      events: events.map((e: WatchEvent) => ({
        seq: e.seq,
        chat: e.message.chat_jid,
        chatName: e.chatName,
        from: e.message.sender_jid,
        at: new Date(e.message.timestamp).toISOString(),
        text: e.message.text,
        type: e.message.message_type,
        priority: e.priority,
        reasons: e.reasons,
      })),
      cursor: events.length > 0 ? events[events.length - 1]!.seq : (opts.since ?? this.watch.cursor),
      timedOut: events.length === 0,
    };
  }

  suggestWatchWindow(chatJid?: string): WatchWindowSuggestion & { maxWatchMinutes: number } {
    return {
      ...suggestWatchWindow(this.store, chatJid ? normalizeJid(chatJid) : undefined),
      maxWatchMinutes: MAX_WATCH_MINUTES,
    };
  }

  /** Compact catch-up so an agent doesn't have to read every chat to know what changed. */
  digest(sinceMinutes = 60, limit = 40): { since: string; chats: DigestEntry[]; totalIncoming: number } {
    const sinceTs = Date.now() - sinceMinutes * 60_000;
    const rows = this.store.digestSince(sinceTs, limit);
    return {
      since: new Date(sinceTs).toISOString(),
      totalIncoming: rows.reduce((s, r) => s + r.incoming, 0),
      chats: rows.map((r) => ({
        chat: r.chat_jid,
        name: r.display_name,
        isGroup: !!r.is_group,
        incoming: r.incoming,
        lastAt: new Date(r.last_ts).toISOString(),
        preview: r.last_text ? r.last_text.slice(0, 120) : null,
      })),
    };
  }

  async setPresence(presence: "available" | "unavailable" | "composing" | "recording" | "paused", chatJid?: string): Promise<{ presence: string }> {
    await this.connection.setPresence(presence, chatJid ? normalizeJid(chatJid) : undefined);
    return { presence };
  }

  readReceiptsMode(): Promise<"on" | "off" | "unknown"> {
    return this.connection.readReceiptsMode();
  }

  async markRead(chatJidOrPhone: string, limit = 20): Promise<{ marked: number }> {
    const chatJid = this.resolveChatJid(chatJidOrPhone);
    const unread = this.store
      .readMessages(chatJid, limit)
      .filter((m) => !m.from_me)
      .map((m) => ({ id: m.id, participant: chatJid.endsWith("@g.us") ? m.sender_jid : null }));
    if (unread.length === 0) return { marked: 0 };
    await this.connection.markRead(chatJid, unread);
    return { marked: unread.length };
  }

  async logout(): Promise<void> {
    await this.connection.logout();
  }

  // ── memory ───────────────────────────────────────────────

  /**
   * Profile lookup with lazy analysis: if no profile exists yet but there is
   * history with this contact, compute the stats on the spot.
   */
  getProfile(jidOrPhone: string): {
    profile: ContactProfile | null;
    persona: ReturnType<typeof readPersona>;
    facts: FactRow[];
    factGaps: { category: string; prompt: string }[];
    tags: string[];
  } {
    const jid = this.resolveChatJid(jidOrPhone);
    let profile = readProfile(jid);
    if (!profile || !profile.stats) {
      const outgoing = this.store.outgoingMessages(jid);
      if (outgoing.length >= 5) {
        const dynamics = analyzeDynamics(this.store.allMessages(jid));
        writeProfileStats(jid, this.store.resolveDisplayName(jid), analyzeStyle(outgoing, dynamics));
        profile = readProfile(jid);
      }
    }
    const facts = this.store.listFacts(jid);
    return { profile, persona: readPersona(), facts, factGaps: factGaps(facts), tags: this.store.chatTags(jid) };
  }

  // ── contact facts (dimension 1) ──────────────────────────

  rememberFact(jidOrPhone: string, category: string, fact: string, confidence?: number, sourceMsgId?: string | null): { id: number; updated: boolean; category: FactCategory } {
    const jid = this.resolveChatJid(jidOrPhone);
    const cat = normalizeCategory(category);
    const res = this.store.upsertFact({ jid, category: cat, fact, confidence, sourceMsgId });
    return { ...res, category: cat };
  }

  forgetFact(jidOrPhone: string, factId: number): { removed: boolean } {
    return { removed: this.store.deleteFact(factId, this.resolveChatJid(jidOrPhone)) };
  }

  getFacts(jidOrPhone: string): { facts: FactRow[]; gaps: { category: string; prompt: string }[] } {
    const jid = this.resolveChatJid(jidOrPhone);
    const facts = this.store.listFacts(jid);
    return { facts, gaps: factGaps(facts) };
  }

  // ── special chats & playbook (dimension: external knowledge) ──

  tagChat(jidOrPhone: string, tag: string): { tags: string[] } {
    const jid = this.resolveChatJid(jidOrPhone);
    this.store.tagChat(jid, tag);
    return { tags: this.store.chatTags(jid) };
  }

  untagChat(jidOrPhone: string, tag: string): { removed: boolean; tags: string[] } {
    const jid = this.resolveChatJid(jidOrPhone);
    const removed = this.store.untagChat(jid, tag);
    return { removed, tags: this.store.chatTags(jid) };
  }

  listSpecialChats(): { jid: string; name: string | null; tags: string[] }[] {
    return this.store.listTaggedChats().map((c) => ({ jid: c.jid, name: this.store.resolveDisplayName(c.jid), tags: c.tags }));
  }

  /** Consult the external playbook for a tagged chat. Shows "composing" while it thinks. */
  async consultPlaybook(jidOrPhone: string, situation: string): Promise<PlaybookResult> {
    const jid = this.resolveChatJid(jidOrPhone);
    if (this.connection.state === "connected") {
      await this.connection.setPresence("composing", jid).catch(() => undefined);
    }
    try {
      return await consultPlaybook(this.store, jid, situation);
    } finally {
      if (this.connection.state === "connected") {
        await this.connection.setPresence("paused", jid).catch(() => undefined);
      }
    }
  }

  // ── prepare_reply: the reasoning-before-sending centerpiece ──

  /**
   * Assembles the FULL briefing an agent needs to reply authentically, in ONE
   * call: global persona + contact facts (dim 1) + interaction dynamics/style
   * (dim 2) + relevant recall + playbook advice (only if the chat is tagged).
   * Sets "composing" so the contact sees the human-like typing indicator while
   * the (deliberately slow) reasoning happens.
   */
  async prepareReply(jidOrPhone: string, situation?: string): Promise<{
    now: ReturnType<WaconService["now"]>;
    chat: string;
    displayName: string | null;
    persona: ReturnType<typeof readPersona>;
    facts: FactRow[];
    factGaps: { category: string; prompt: string }[];
    profile: ContactProfile | null;
    tags: string[];
    upcomingEvents: EventRow[];
    recent: { at: string; from: string; text: string | null }[];
    recall: RecallResult | null;
    playbook: PlaybookResult;
  }> {
    const jid = this.resolveChatJid(jidOrPhone);
    if (this.connection.state === "connected") {
      await this.connection.setPresence("composing", jid).catch(() => undefined);
    }
    try {
      const base = this.getProfile(jid);
      const recentRows = this.store.readMessages(jid, 20);
      const recent = recentRows
        .slice()
        .reverse()
        .map((m) => ({ at: new Date(m.timestamp).toISOString(), from: m.from_me ? "me" : (m.sender_jid ?? "them"), text: m.text }));

      // Recall only when we have a concrete situation to anchor the search.
      const recallResult = situation ? recall(this.store, situation, { chatJid: jid, limit: 8 }) : null;

      // Playbook only for tagged chats — untagged casual chats skip the external
      // call entirely (token + latency saving).
      const playbook = base.tags.length > 0 && situation
        ? await consultPlaybook(this.store, jid, situation)
        : { consulted: false, degraded: false, note: base.tags.length === 0 ? "Chat sin etiquetas: sin playbook." : "Sin 'situation': no se consultó playbook." };

      return {
        now: this.now(), // time awareness: lets the agent resolve "next friday"
        chat: jid,
        displayName: this.store.resolveDisplayName(jid),
        persona: base.persona,
        facts: base.facts,
        factGaps: base.factGaps,
        profile: base.profile,
        tags: base.tags,
        upcomingEvents: this.store.listEvents({ withinDays: 14 }).filter((e) => !e.chat_jid || e.chat_jid === jid),
        recent,
        recall: recallResult,
        playbook,
      };
    } finally {
      if (this.connection.state === "connected") {
        await this.connection.setPresence("paused", jid).catch(() => undefined);
      }
    }
  }

  // ── diagnostics ──────────────────────────────────────────

  doctor(daemon: { port: number; pid: number } | null): DoctorReport {
    return runDoctor({ connectionState: this.connection.state, store: this.store, daemon });
  }

  observe(jidOrPhone: string, section: ProfileSection, observation: string): void {
    const jid = this.resolveChatJid(jidOrPhone);
    appendObservation(jid, section, observation, this.store.resolveDisplayName(jid));
  }

  analyzeContact(jidOrPhone: string): { stats: StyleStats; summary: string } {
    const jid = this.resolveChatJid(jidOrPhone);
    const outgoing = this.store.outgoingMessages(jid);
    if (outgoing.length === 0) {
      throw new Error(`No outgoing messages found for ${jid}. Sync more history or check the JID.`);
    }
    const stats = analyzeStyle(outgoing, analyzeDynamics(this.store.allMessages(jid)));
    writeProfileStats(jid, this.store.resolveDisplayName(jid), stats);
    return { stats, summary: describeStyle(stats) };
  }

  getPersona() {
    return readPersona();
  }

  /**
   * `wacon init`: bulk analysis. Builds persona.md from ALL outgoing messages
   * and a profile for every chat with enough history.
   */
  initAll(minMessages = 30, minOutgoing = 10): { personaMessages: number; profilesCreated: string[] } {
    // Balanced sample (capped per chat, 1:1 only) so one heavy chat — an AI
    // assistant, a work group — can't define the user's whole voice.
    const allOutgoing = this.store.balancedOutgoingSample(120);
    if (allOutgoing.length > 0) {
      const stats = analyzeStyle(allOutgoing);
      // Real, representative one-liners so agents can hear the voice, not just read stats.
      const samples = allOutgoing
        .map((m) => m.text ?? "")
        .filter((t) => isAuthoredText(t) && t.length >= 8 && t.length <= 90)
        .slice(0, 40)
        .sort(() => Math.random() - 0.5)
        .slice(0, 8);
      writePersonaStats(stats, samples);
    }
    const profilesCreated: string[] = [];
    for (const chat of this.store.chatsWithMessageCounts(minMessages)) {
      if (chat.outgoing < minOutgoing) continue;
      if (chat.chat_jid.endsWith("@g.us")) continue; // group style differs per member; skip in bulk pass
      const outgoing = this.store.outgoingMessages(chat.chat_jid);
      if (outgoing.length < minOutgoing) continue;
      const dynamics = analyzeDynamics(this.store.allMessages(chat.chat_jid));
      writeProfileStats(chat.chat_jid, this.store.resolveDisplayName(chat.chat_jid), analyzeStyle(outgoing, dynamics));
      this.store.rebuildEpisodes(chat.chat_jid);
      profilesCreated.push(chat.chat_jid);
    }
    return { personaMessages: allOutgoing.length, profilesCreated };
  }

  // ── multimedia (with anti-fraud handling) ────────────────

  /**
   * Download an image and return it as an MCP-ready block. Layer 2: if a vision
   * backend is configured, also attach a text description. On ANY failure,
   * returns natural guidance and logs the real error — never throws.
   */
  async viewImage(chatJidOrPhone: string, msgId: string, client = "mcp"): Promise<
    | { ok: true; base64: string; mimetype: string; description: string | null }
    | Guided
  > {
    const chatJid = this.resolveChatJid(chatJidOrPhone);
    const config = loadConfig();
    try {
      const media = await fetchMedia(this.connection, chatJid, msgId, config.maxMediaBytes);
      let description: string | null = null;
      if (config.vision.backend !== "none") {
        description = await this.describeImage(config, media.base64, media.mimetype ?? "image/jpeg").catch(() => null);
      }
      return { ok: true, base64: media.base64, mimetype: media.mimetype ?? "image/jpeg", description };
    } catch (err) {
      const guidance = /too large/.test(String(err)) ? GUIDANCE.mediaTooLarge : /No media stub/.test(String(err)) ? GUIDANCE.notFound : GUIDANCE.imageFailed;
      return logError(this.store, { operation: "view_image", chatJid, error: err, context: { msgId }, client }, guidance);
    }
  }

  private async describeImage(config: ReturnType<typeof loadConfig>, base64: string, mimetype: string): Promise<string | null> {
    if (!config.vision.endpoint) return null;
    const res = await fetch(config.vision.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.vision.apiKey ? { authorization: `Bearer ${config.vision.apiKey}` } : {}) },
      body: JSON.stringify({
        model: config.vision.model ?? "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe esta imagen en 1-2 frases, en español." },
              { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}` } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout((config.vision.timeoutSeconds ?? 60) * 1000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  }

  /**
   * Transcribe a voice note. Layer 1 (default): return the audio as an MCP block
   * for multimodal agents. Layer 2: if a transcription backend is configured,
   * return text. Anti-fraud: never throws, never leaks a raw error.
   */
  async transcribeAudio(chatJidOrPhone: string, msgId: string, client = "mcp"): Promise<
    | { ok: true; mode: "transcript"; text: string }
    | { ok: true; mode: "audio-block"; base64: string; mimetype: string; note: string }
    | Guided
  > {
    const chatJid = this.resolveChatJid(chatJidOrPhone);
    const config = loadConfig();
    let media;
    try {
      media = await fetchMedia(this.connection, chatJid, msgId, config.maxMediaBytes);
    } catch (err) {
      const guidance = /too large/.test(String(err)) ? GUIDANCE.mediaTooLarge : /No media stub/.test(String(err)) ? GUIDANCE.notFound : GUIDANCE.audioFailed;
      return logError(this.store, { operation: "transcribe_audio", chatJid, error: err, context: { msgId }, client }, guidance);
    }
    // Layer 2 if configured.
    if (config.transcription.backend !== "none") {
      const result = await transcribe(config.transcription, media);
      if (result.ok && result.text) return { ok: true, mode: "transcript", text: result.text };
      // Backend failed → log and fall through to the audio block (still useful).
      logError(this.store, { operation: "transcribe_audio", chatJid, error: result.reason ?? "transcription failed", context: { msgId }, client }, GUIDANCE.transcriptionFailed);
    }
    // Layer 1: native audio block.
    return {
      ok: true,
      mode: "audio-block",
      base64: media.base64,
      mimetype: media.mimetype ?? "audio/ogg",
      note: "Si tu agente puede procesar audio, escúchalo directamente. Si no, configura un backend de transcripción (wacon doctor).",
    };
  }

  // ── productivity ─────────────────────────────────────────

  /** What still needs the user's reply, ranked. */
  inbox(limit = 40, includeGroups = false) {
    return pendingReplies(this.store, { limit, includeGroups });
  }

  /** Promises the user made and may not have kept. */
  commitments(sinceDays = 21) {
    return openCommitments(this.store, sinceDays);
  }

  /** One call to start the day: what's pending, what's due, what arrived. */
  briefing(sinceMinutes = 720) {
    const pending = pendingReplies(this.store, { limit: 12, includeGroups: false });
    const digest = this.digest(sinceMinutes, 12);
    const agenda = this.getAgenda(7);
    return {
      now: this.now(),
      pendingReplies: pending,
      openCommitments: openCommitments(this.store, 21).slice(0, 5),
      newSince: { since: digest.since, totalIncoming: digest.totalIncoming, chats: digest.chats.slice(0, 8) },
      upcomingEvents: agenda.events.slice(0, 8),
      openTasks: agenda.tasks.slice(0, 8),
    };
  }

  // ── group member profiling (mass ingestion) ──────────────

  /**
   * Turn a group's history into per-PERSON memory. Each participant has a
   * stable id, so their messages can be profiled independently: how they write
   * plus candidate facts about them. One group of thousands of messages becomes
   * many usable contact profiles.
   */
  analyzeGroupMembers(groupJidOrName: string, minMessages = 20): {
    group: string;
    groupName: string | null;
    members: { jid: string; name: string | null; messages: number; styleSummary: string | null; factsFound: number }[];
  } {
    const group = this.resolveChatJid(groupJidOrName);
    const members = this.store.groupMembers(group, minMessages);
    const out: { jid: string; name: string | null; messages: number; styleSummary: string | null; factsFound: number }[] = [];

    for (const m of members) {
      const msgs = this.store.memberMessages(group, m.sender_jid);
      const authored = msgs.filter((x) => isAuthoredText(x.text));
      if (authored.length < minMessages) continue;

      // Their writing style (these are THEIR messages, so from_me is irrelevant here).
      const stats = analyzeStyle(authored);
      writeProfileStats(m.sender_jid, m.display_name ?? this.store.resolveDisplayName(m.sender_jid), stats);

      // Candidate facts they revealed about themselves.
      let factsFound = 0;
      for (const f of extractFacts(authored)) {
        this.store.upsertFact({ jid: m.sender_jid, category: f.category, fact: f.fact, confidence: f.confidence, sourceMsgId: f.sourceMsgId });
        factsFound++;
      }
      out.push({ jid: m.sender_jid, name: m.display_name, messages: authored.length, styleSummary: describeStyle(stats), factsFound });
    }
    return { group, groupName: this.store.resolveDisplayName(group), members: out };
  }

  /** Who's in a group and how much they participate (cheap overview). */
  groupMembers(groupJidOrName: string, minMessages = 5) {
    const group = this.resolveChatJid(groupJidOrName);
    return {
      group,
      groupName: this.store.resolveDisplayName(group),
      members: this.store.groupMembers(group, minMessages).map((m) => ({
        jid: m.sender_jid,
        name: m.display_name ?? this.store.resolveDisplayName(m.sender_jid),
        messages: m.total,
        hasProfile: readProfile(m.sender_jid) !== null,
      })),
    };
  }

  /**
   * Send any file — image, video, audio (optionally as a voice note), or a
   * document like a PDF. The kind is inferred from the extension. Same
   * guardrails as text, and failures degrade with guidance instead of throwing.
   */
  async sendFile(
    chatJidOrPhone: string,
    filePath: string,
    opts: { caption?: string; asVoiceNote?: boolean; clientName?: string } = {}
  ): Promise<(SendResult & { kind?: string; fileName?: string }) | Guided> {
    const chatJid = normalizeJid(chatJidOrPhone);
    const clientName = opts.clientName ?? "mcp";
    const config = loadConfig();
    const check = checkSend(config, this.store, chatJid);
    if (!check.allowed) return { sent: false, dryRun: check.dryRun, messageId: null, reason: check.reason };

    let media;
    try {
      media = prepareMedia(filePath, config.maxMediaBytes);
    } catch (err) {
      return logError(
        this.store,
        { operation: "send_file", chatJid, error: err, context: { filePath }, client: clientName },
        `No pude preparar ese archivo (${err instanceof Error ? err.message : String(err)}). Revisa la ruta o el tamaño; si no es esencial, continúa sin él.`
      );
    }

    const label = `[${media.kind}: ${media.fileName}]${opts.caption ? ` ${opts.caption}` : ""}`;
    if (check.dryRun) {
      this.store.logSent({ chatJid, text: label, clientName, dryRun: true });
      return { sent: false, dryRun: true, messageId: null, reason: "dryRun activo — archivo registrado pero NO enviado", kind: media.kind, fileName: media.fileName };
    }

    try {
      const content = toMessageContent(media, { caption: opts.caption, asVoiceNote: opts.asVoiceNote });
      const { id } = await this.connection.sendMedia(chatJid, content);
      this.store.logSent({ chatJid, text: label, clientName, dryRun: false });
      return { sent: true, dryRun: false, messageId: id, kind: media.kind, fileName: media.fileName };
    } catch (err) {
      return logError(
        this.store,
        { operation: "send_file", chatJid, error: err, context: { filePath, kind: media.kind }, client: clientName },
        "No pude enviar el archivo. Si el contenido importa, descríbelo por texto o pide reenviarlo más tarde."
      );
    }
  }

  // ── stickers ─────────────────────────────────────────────

  /** Build/refresh the sticker catalog: bundled packs + the user's own stickers. */
  syncStickers(): { packImported: number; ownIndexed: number; habits: number } {
    const packImported = importPack(this.store, "cats");
    const { indexed, habits } = indexOwnStickers(this.store);
    return { packImported, ownIndexed: indexed, habits };
  }

  listStickers(opts: { mood?: string; chat?: string; limit?: number } = {}) {
    const stickers = this.store.listStickers({ mood: opts.mood, limit: opts.limit ?? 20 });
    const result: {
      stickers: typeof stickers;
      moods: readonly string[];
      affinity?: { stickersPerMessage: number; advice: string };
      contactMoods?: { mood: string; count: number }[];
    } = { stickers, moods: MOODS };
    if (opts.chat) {
      const jid = this.resolveChatJid(opts.chat);
      result.affinity = stickerAffinity(this.store, jid);
      result.contactMoods = this.store.stickerHabits(jid);
    }
    return result;
  }

  /**
   * Send a sticker by library id. Own stickers are re-downloaded from their
   * original message; pack stickers are read from disk. Same guardrails as text
   * (rate limit, dry-run, allow/block lists) and anti-fraud degradation.
   */
  async sendSticker(chatJidOrPhone: string, stickerId: string, clientName = "mcp"): Promise<SendResult | Guided> {
    const chatJid = normalizeJid(chatJidOrPhone);
    const config = loadConfig();
    const check = checkSend(config, this.store, chatJid);
    if (!check.allowed) return { sent: false, dryRun: check.dryRun, messageId: null, reason: check.reason };

    const sticker = this.store.getSticker(stickerId);
    if (!sticker) {
      return logError(
        this.store,
        { operation: "send_sticker", chatJid, error: `unknown sticker ${stickerId}`, client: clientName },
        "No encontré ese sticker. Usa list_stickers para ver los disponibles, o manda el mensaje solo con texto."
      );
    }

    let webp: Buffer;
    try {
      if (sticker.origin === "pack" && sticker.file_path) {
        webp = readFileSync(sticker.file_path);
      } else if (sticker.chat_jid && sticker.msg_id) {
        const media = await fetchMedia(this.connection, sticker.chat_jid, sticker.msg_id, config.maxMediaBytes);
        webp = media.buffer;
      } else {
        throw new Error("sticker has no source");
      }
    } catch (err) {
      return logError(
        this.store,
        { operation: "send_sticker", chatJid, error: err, context: { stickerId }, client: clientName },
        "No pude cargar ese sticker. Continúa con texto — no menciones el problema al contacto."
      );
    }

    if (check.dryRun) {
      this.store.logSent({ chatJid, text: `[sticker ${stickerId}]`, clientName, dryRun: true });
      return { sent: false, dryRun: true, messageId: null, reason: "dryRun activo — sticker registrado pero NO enviado" };
    }
    try {
      const { id } = await this.connection.sendSticker(chatJid, webp);
      this.store.logSent({ chatJid, text: `[sticker ${stickerId}]`, clientName, dryRun: false });
      this.store.markStickerUsed(stickerId);
      return { sent: true, dryRun: false, messageId: id };
    } catch (err) {
      return logError(
        this.store,
        { operation: "send_sticker", chatJid, error: err, context: { stickerId }, client: clientName },
        "No pude enviar el sticker. Si el mensaje importa, mándalo como texto."
      );
    }
  }

  errorLog(limit = 30, chatJid?: string): ErrorRow[] {
    return this.store.recentErrors(limit, chatJid ? normalizeJid(chatJid) : undefined);
  }

  // ── time, calendar & tasks ───────────────────────────────

  now(): { iso: string; human: string; tz: string; weekday: string } {
    const d = new Date();
    const human = d.toLocaleString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
    return { iso: d.toISOString(), human, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, weekday: d.toLocaleDateString("es-ES", { weekday: "long" }) };
  }

  scheduleEvent(input: { chat?: string; title: string; start: string; notifyBeforeMinutes?: number; end?: string; notes?: string; client?: string }): EventRow {
    const startTs = new Date(input.start).getTime();
    if (Number.isNaN(startTs)) throw new Error(`Invalid start date: ${input.start}`);
    const endTs = input.end ? new Date(input.end).getTime() : null;
    const notifyTs = startTs - (input.notifyBeforeMinutes ?? 60) * 60_000;
    return this.store.createEvent({
      chatJid: input.chat ? normalizeJid(input.chat) : null,
      title: input.title,
      startTs,
      endTs: endTs && !Number.isNaN(endTs) ? endTs : null,
      notifyTs,
      createdBy: input.client ?? "agent",
      notes: input.notes ?? null,
    });
  }

  listEvents(opts: { includeDone?: boolean; withinDays?: number } = {}): EventRow[] {
    return this.store.listEvents(opts);
  }

  cancelEvent(id: number): { cancelled: boolean } {
    return { cancelled: this.store.setEventStatus(id, "cancelled") };
  }

  completeEvent(id: number): { done: boolean } {
    return { done: this.store.setEventStatus(id, "done") };
  }

  addTask(input: { title: string; due?: string; chat?: string; notes?: string }): TaskRow {
    const dueTs = input.due ? new Date(input.due).getTime() : null;
    return this.store.createTask({
      title: input.title,
      dueTs: dueTs && !Number.isNaN(dueTs) ? dueTs : null,
      chatJid: input.chat ? normalizeJid(input.chat) : null,
      notes: input.notes ?? null,
    });
  }

  listTasks(includeDone = false): TaskRow[] {
    return this.store.listTasks(includeDone);
  }

  completeTask(id: number): { done: boolean } {
    return { done: this.store.completeTask(id) };
  }

  getAgenda(withinDays = 7): { now: ReturnType<WaconService["now"]>; events: EventRow[]; tasks: TaskRow[] } {
    return { now: this.now(), events: this.store.listEvents({ withinDays }), tasks: this.store.listTasks(false) };
  }

  // ── proactive triggers (long-poll) ───────────────────────

  async waitForTriggers(opts: { sinceMsg?: number; sinceTrigger?: number; timeoutSeconds?: number }): Promise<{
    messages: { chat: string; from: string | null; text: string | null; at: string }[];
    triggers: { eventId: number; chat: string | null; chatName: string | null; title: string; startsAt: string; minutesUntilStart: number | null; notes: string | null }[];
    msgCursor: number;
    triggerCursor: number;
    timedOut: boolean;
  }> {
    const timeoutMs = Math.min(Math.max(opts.timeoutSeconds ?? 60, 1), 120) * 1000;
    const r = await this.watch.waitForTriggers({ sinceMsg: opts.sinceMsg, sinceTrigger: opts.sinceTrigger, timeoutMs });
    return {
      messages: r.messages.map((e) => ({ chat: e.message.chat_jid, from: e.message.from_me ? "me" : e.message.sender_jid, text: e.message.text, at: new Date(e.message.timestamp).toISOString() })),
      triggers: r.triggers.map((t) => ({
        eventId: t.eventId,
        chat: t.chatJid,
        chatName: t.chatName,
        title: t.title,
        startsAt: new Date(t.startTs).toISOString(),
        minutesUntilStart: t.minutesUntilStart,
        notes: t.notes,
      })),
      msgCursor: r.msgCursor,
      triggerCursor: r.triggerCursor,
      timedOut: r.messages.length === 0 && r.triggers.length === 0,
    };
  }
}
