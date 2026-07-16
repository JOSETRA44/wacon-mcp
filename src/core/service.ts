import type { Store, MessageRow } from "./store.js";
import type { WhatsAppConnection, ConnectionState } from "./connection.js";
import { loadConfig } from "./config.js";
import { checkSend } from "./guardrails.js";
import { analyzeStyle, describeStyle, type StyleStats } from "../memory/analyzer.js";
import { readProfile, writeProfileStats, appendObservation, type ProfileSection, type ContactProfile } from "../memory/profiles.js";
import { readPersona, writePersonaStats } from "../memory/persona.js";

export interface StatusInfo {
  state: ConnectionState;
  selfJid: string | null;
  stats: { chats: number; contacts: number; messages: number; outgoing: number };
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
  constructor(
    private store: Store,
    private connection: WhatsAppConnection
  ) {}

  status(): StatusInfo {
    return {
      state: this.connection.state,
      selfJid: this.connection.selfJid,
      stats: this.store.stats(),
    };
  }

  qr(): { state: ConnectionState; qr: string | null } {
    return { state: this.connection.state, qr: this.latestQr() };
  }

  private latestQr(): string | null {
    return this.connection.state === "waiting_qr" ? this.connection.latestQr : null;
  }

  listChats(limit = 30) {
    return this.store.listChats(limit);
  }

  readMessages(chatJid: string, limit = 30, beforeTs?: number): MessageRow[] {
    return this.store.readMessages(normalizeJid(chatJid), limit, beforeTs);
  }

  searchMessages(query: string, chatJid?: string, limit = 20) {
    return this.store.searchMessages(query, { chatJid: chatJid ? normalizeJid(chatJid) : undefined, limit });
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

  async send(chatJidOrPhone: string, text: string, clientName: string): Promise<SendResult> {
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
    const { id } = await this.connection.sendText(chatJid, text);
    this.store.logSent({ chatJid, text, clientName, dryRun: false });
    return { sent: true, dryRun: false, messageId: id };
  }

  async logout(): Promise<void> {
    await this.connection.logout();
  }

  // ── memory ───────────────────────────────────────────────

  /**
   * Profile lookup with lazy analysis: if no profile exists yet but there is
   * history with this contact, compute the stats on the spot.
   */
  getProfile(jidOrPhone: string): { profile: ContactProfile | null; persona: ReturnType<typeof readPersona> } {
    const jid = normalizeJid(jidOrPhone);
    let profile = readProfile(jid);
    if (!profile || !profile.stats) {
      const outgoing = this.store.outgoingMessages(jid);
      if (outgoing.length >= 5) {
        writeProfileStats(jid, this.store.resolveDisplayName(jid), analyzeStyle(outgoing));
        profile = readProfile(jid);
      }
    }
    return { profile, persona: readPersona() };
  }

  observe(jidOrPhone: string, section: ProfileSection, observation: string): void {
    const jid = normalizeJid(jidOrPhone);
    appendObservation(jid, section, observation, this.store.resolveDisplayName(jid));
  }

  analyzeContact(jidOrPhone: string): { stats: StyleStats; summary: string } {
    const jid = normalizeJid(jidOrPhone);
    const outgoing = this.store.outgoingMessages(jid);
    if (outgoing.length === 0) {
      throw new Error(`No outgoing messages found for ${jid}. Sync more history or check the JID.`);
    }
    const stats = analyzeStyle(outgoing);
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
    const allOutgoing = this.store.allOutgoingMessages();
    if (allOutgoing.length > 0) {
      writePersonaStats(analyzeStyle(allOutgoing));
    }
    const profilesCreated: string[] = [];
    for (const chat of this.store.chatsWithMessageCounts(minMessages)) {
      if (chat.outgoing < minOutgoing) continue;
      if (chat.chat_jid.endsWith("@g.us")) continue; // group style differs per member; skip in bulk pass
      const outgoing = this.store.outgoingMessages(chat.chat_jid);
      if (outgoing.length < minOutgoing) continue;
      writeProfileStats(chat.chat_jid, this.store.resolveDisplayName(chat.chat_jid), analyzeStyle(outgoing));
      profilesCreated.push(chat.chat_jid);
    }
    return { personaMessages: allOutgoing.length, profilesCreated };
  }
}
