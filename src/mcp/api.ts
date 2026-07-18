import type { MessageRow } from "../core/store.js";
import type { StatusInfo, SendResult, WaitResult, DigestEntry } from "../core/service.js";
import type { RecallResult } from "../memory/recall.js";
import type { WatchRule, WatchSession } from "../core/watch.js";
import type { WatchWindowSuggestion } from "../core/activity.js";
import type { ContactProfile, ProfileSection } from "../memory/profiles.js";
import type { StyleStats } from "../memory/analyzer.js";
import type { ConnectionState } from "../core/connection.js";
import type { FactRow, EventRow, TaskRow, ErrorRow } from "../core/store.js";
import type { FactCategory } from "../memory/facts.js";
import type { PlaybookResult } from "../knowledge/notebook.js";
import type { DoctorReport } from "../core/doctor.js";
import type { Guided } from "../core/errors.js";

type ImageResult = { ok: true; base64: string; mimetype: string; description: string | null } | Guided;
type AudioResult = { ok: true; mode: "transcript"; text: string } | { ok: true; mode: "audio-block"; base64: string; mimetype: string; note: string } | Guided;

export interface ContactProfileBundle {
  profile: ContactProfile | null;
  persona: PersonaDoc | null;
  facts: FactRow[];
  factGaps: { category: string; prompt: string }[];
  tags: string[];
}

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
  getProfile(chat: string): Promise<ContactProfileBundle>;
  observe(chat: string, section: ProfileSection, observation: string): Promise<void>;
  analyzeContact(chat: string): Promise<{ stats: StyleStats; summary: string }>;
  getPersona(): Promise<PersonaDoc | null>;
  initAll(minMessages?: number, minOutgoing?: number): Promise<{ personaMessages: number; profilesCreated: string[] }>;
  rememberFact(chat: string, category: string, fact: string, confidence?: number): Promise<{ id: number; updated: boolean; category: FactCategory }>;
  forgetFact(chat: string, factId: number): Promise<{ removed: boolean }>;
  getFacts(chat: string): Promise<{ facts: FactRow[]; gaps: { category: string; prompt: string }[] }>;
  tagChat(chat: string, tag: string): Promise<{ tags: string[] }>;
  untagChat(chat: string, tag: string): Promise<{ removed: boolean; tags: string[] }>;
  listSpecialChats(): Promise<{ jid: string; name: string | null; tags: string[] }[]>;
  consultPlaybook(chat: string, situation: string): Promise<PlaybookResult>;
  prepareReply(chat: string, situation?: string): Promise<unknown>;
  doctor(): Promise<DoctorReport>;
  viewImage(chat: string, messageId: string): Promise<ImageResult>;
  transcribeAudio(chat: string, messageId: string): Promise<AudioResult>;
  errorLog(limit?: number, chat?: string): Promise<ErrorRow[]>;
  scheduleEvent(input: { chat?: string; title: string; start: string; notifyBeforeMinutes?: number; end?: string; notes?: string }): Promise<EventRow>;
  listEvents(opts?: { includeDone?: boolean; withinDays?: number }): Promise<EventRow[]>;
  cancelEvent(id: number): Promise<{ cancelled: boolean }>;
  completeEvent(id: number): Promise<{ done: boolean }>;
  addTask(input: { title: string; due?: string; chat?: string; notes?: string }): Promise<TaskRow>;
  listTasks(includeDone?: boolean): Promise<TaskRow[]>;
  completeTask(id: number): Promise<{ done: boolean }>;
  getAgenda(withinDays?: number): Promise<unknown>;
  waitForTriggers(opts: { sinceMsg?: number; sinceTrigger?: number; timeoutSeconds?: number }): Promise<unknown>;
  resolveContact(query: string): Promise<{ jid: string; displayName: string | null; total: number; outgoing: number; via: string }[]>;
  analysisTargets(limit?: number): Promise<{ jid: string; displayName: string | null; total: number; outgoing: number; isGroup: boolean; hasFacts: boolean }[]>;
  runBulkAnalysis(scope: { mode: "all" | "contacts" | "groups" | "courses" | "chat"; chat?: string; minOutgoing?: number }): Promise<unknown>;
  analysisStatus(): Promise<unknown>;
  getAnalysisBundle(chat: string): Promise<unknown>;
  listSuggestedEvents(status?: string, limit?: number): Promise<{ id: number; chat: string; chatName: string | null; title: string; when: string | null; raw: string | null }[]>;
  confirmSuggestedEvent(id: number, notifyBeforeMinutes?: number): Promise<{ confirmed: boolean; eventId?: number }>;
  dismissSuggestedEvent(id: number): Promise<{ dismissed: boolean }>;
  syncStickers(): Promise<{ packImported: number; ownIndexed: number; habits: number }>;
  listStickers(opts?: { mood?: string; chat?: string; limit?: number }): Promise<unknown>;
  sendSticker(chat: string, stickerId: string, clientName: string): Promise<SendResult | Guided>;
  logout(): Promise<void>;
}

import type { WaconService } from "../core/service.js";

export function localApi(service: WaconService, daemonInfo?: { port: number; pid: number }): WaconApi {
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
    rememberFact: async (chat, category, fact, confidence) => service.rememberFact(chat, category, fact, confidence),
    forgetFact: async (chat, factId) => service.forgetFact(chat, factId),
    getFacts: async (chat) => service.getFacts(chat),
    tagChat: async (chat, tag) => service.tagChat(chat, tag),
    untagChat: async (chat, tag) => service.untagChat(chat, tag),
    listSpecialChats: async () => service.listSpecialChats(),
    consultPlaybook: (chat, situation) => service.consultPlaybook(chat, situation),
    prepareReply: (chat, situation) => service.prepareReply(chat, situation),
    doctor: async () => service.doctor(daemonInfo ?? null),
    viewImage: (chat, messageId) => service.viewImage(chat, messageId),
    transcribeAudio: (chat, messageId) => service.transcribeAudio(chat, messageId),
    errorLog: async (limit, chat) => service.errorLog(limit, chat),
    scheduleEvent: async (input) => service.scheduleEvent(input),
    listEvents: async (opts) => service.listEvents(opts),
    cancelEvent: async (id) => service.cancelEvent(id),
    completeEvent: async (id) => service.completeEvent(id),
    addTask: async (input) => service.addTask(input),
    listTasks: async (includeDone) => service.listTasks(includeDone),
    completeTask: async (id) => service.completeTask(id),
    getAgenda: async (withinDays) => service.getAgenda(withinDays),
    waitForTriggers: (opts) => service.waitForTriggers(opts),
    resolveContact: async (query) => service.resolveContact(query),
    analysisTargets: async (limit) => service.analysisTargets(limit),
    runBulkAnalysis: async (scope) => service.runBulkAnalysis(scope),
    analysisStatus: async () => service.analysisStatus(),
    getAnalysisBundle: async (chat) => service.getAnalysisBundle(chat),
    listSuggestedEvents: async (status, limit) => service.listSuggestedEvents(status, limit),
    confirmSuggestedEvent: async (id, notifyBeforeMinutes) => service.confirmSuggestedEvent(id, notifyBeforeMinutes),
    dismissSuggestedEvent: async (id) => service.dismissSuggestedEvent(id),
    syncStickers: async () => service.syncStickers(),
    listStickers: async (opts) => service.listStickers(opts),
    sendSticker: (chat, stickerId, clientName) => service.sendSticker(chat, stickerId, clientName),
    logout: () => service.logout(),
  };
}
