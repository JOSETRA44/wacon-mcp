import type { MessageRow } from "../core/store.js";
import type { StatusInfo, SendResult, WaitResult, DigestEntry } from "../core/service.js";
import type { RecallResult } from "../memory/recall.js";
import type { WatchRule, WatchSession } from "../core/watch.js";
import type { WatchWindowSuggestion } from "../core/activity.js";
import type { ContactProfile, ProfileSection } from "../memory/profiles.js";
import type { StyleStats } from "../memory/analyzer.js";
import type { ConnectionState } from "../core/connection.js";

export interface PersonaDoc {
  stats: Partial<StyleStats> | null;
  body: string;
}

export interface GroupInfo {
  jid: string;
  subject: string;
  description: string | null;
  participantCount: number;
  participants: { jid: string; isAdmin: boolean }[];
}

/**
 * Everything the MCP tools and the CLI can do. Implemented twice:
 * - localApi(service): direct calls, used inside the daemon
 * - DaemonClient: HTTP calls to the daemon, used by the stdio shim and CLI
 */
export interface WaconApi {
  status(): Promise<StatusInfo>;
  qr(): Promise<{ state: ConnectionState; qr: string | null }>;
  listChats(limit?: number): Promise<unknown[]>;
  readMessages(chat: string, limit?: number, beforeTs?: number): Promise<MessageRow[]>;
  searchMessages(query: string, chat?: string, limit?: number): Promise<(MessageRow & { snippet: string })[]>;
  recall(query: string, chat?: string, limit?: number): Promise<RecallResult>;
  listEpisodes(chat: string, limit?: number): Promise<unknown[]>;
  readEpisode(episodeId: number): Promise<unknown>;
  summarizeEpisode(episodeId: number, summary: string): Promise<unknown>;
  searchContacts(query: string, limit?: number): Promise<unknown[]>;
  groupInfo(groupJid: string): Promise<GroupInfo>;
  send(chat: string, text: string, clientName: string, typingMs?: number): Promise<SendResult>;
  startWatch(rule: Partial<WatchRule>, durationMinutes: number, clientName: string): Promise<WatchSession>;
  stopWatch(sessionId?: string): Promise<{ stopped: number }>;
  watchStatus(): Promise<{ sessions: (WatchSession & { minutesLeft: number })[]; cursor: number }>;
  waitForMessages(opts: { since?: number; sessionId?: string; timeoutSeconds?: number }): Promise<WaitResult>;
  suggestWatchWindow(chat?: string): Promise<WatchWindowSuggestion & { maxWatchMinutes: number }>;
  digest(sinceMinutes?: number, limit?: number): Promise<{ since: string; chats: DigestEntry[]; totalIncoming: number }>;
  setPresence(presence: "available" | "unavailable" | "composing" | "recording" | "paused", chat?: string): Promise<{ presence: string }>;
  markRead(chat: string, limit?: number): Promise<{ marked: number }>;
  getProfile(chat: string): Promise<{ profile: ContactProfile | null; persona: PersonaDoc | null }>;
  observe(chat: string, section: ProfileSection, observation: string): Promise<void>;
  analyzeContact(chat: string): Promise<{ stats: StyleStats; summary: string }>;
  getPersona(): Promise<PersonaDoc | null>;
  initAll(minMessages?: number, minOutgoing?: number): Promise<{ personaMessages: number; profilesCreated: string[] }>;
  logout(): Promise<void>;
}

import type { WaconService } from "../core/service.js";

export function localApi(service: WaconService): WaconApi {
  return {
    status: async () => service.status(),
    qr: async () => service.qr(),
    listChats: async (limit) => service.listChats(limit),
    readMessages: async (chat, limit, beforeTs) => service.readMessages(chat, limit, beforeTs),
    searchMessages: async (query, chat, limit) => service.searchMessages(query, chat, limit),
    recall: async (query, chat, limit) => service.recall(query, chat, limit),
    listEpisodes: async (chat, limit) => service.listEpisodes(chat, limit),
    readEpisode: async (episodeId) => service.readEpisode(episodeId),
    summarizeEpisode: async (episodeId, summary) => service.summarizeEpisode(episodeId, summary),
    searchContacts: async (query, limit) => service.searchContacts(query, limit),
    groupInfo: (groupJid) => service.groupInfo(groupJid),
    send: (chat, text, clientName, typingMs) => service.send(chat, text, clientName, typingMs),
    startWatch: async (rule, durationMinutes, clientName) => service.startWatch(rule, durationMinutes, clientName),
    stopWatch: async (sessionId) => service.stopWatch(sessionId),
    watchStatus: async () => service.watchStatus(),
    waitForMessages: (opts) => service.waitForMessages(opts),
    suggestWatchWindow: async (chat) => service.suggestWatchWindow(chat),
    digest: async (sinceMinutes, limit) => service.digest(sinceMinutes, limit),
    setPresence: (presence, chat) => service.setPresence(presence, chat),
    markRead: (chat, limit) => service.markRead(chat, limit),
    getProfile: async (chat) => service.getProfile(chat),
    observe: async (chat, section, observation) => service.observe(chat, section, observation),
    analyzeContact: async (chat) => service.analyzeContact(chat),
    getPersona: async () => service.getPersona(),
    initAll: async (minMessages, minOutgoing) => service.initAll(minMessages, minOutgoing),
    logout: () => service.logout(),
  };
}
