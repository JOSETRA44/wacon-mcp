import type { MessageRow } from "../core/store.js";
import type { StatusInfo, SendResult } from "../core/service.js";
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
  searchContacts(query: string, limit?: number): Promise<unknown[]>;
  groupInfo(groupJid: string): Promise<GroupInfo>;
  send(chat: string, text: string, clientName: string): Promise<SendResult>;
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
    searchContacts: async (query, limit) => service.searchContacts(query, limit),
    groupInfo: (groupJid) => service.groupInfo(groupJid),
    send: (chat, text, clientName) => service.send(chat, text, clientName),
    getProfile: async (chat) => service.getProfile(chat),
    observe: async (chat, section, observation) => service.observe(chat, section, observation),
    analyzeContact: async (chat) => service.analyzeContact(chat),
    getPersona: async () => service.getPersona(),
    initAll: async (minMessages, minOutgoing) => service.initAll(minMessages, minOutgoing),
    logout: () => service.logout(),
  };
}
