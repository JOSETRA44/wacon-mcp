import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./paths.js";

export interface ChatRow {
  jid: string;
  name: string | null;
  is_group: number;
  unread_count: number;
  last_message_ts: number | null;
}

export interface ContactRow {
  jid: string;
  name: string | null;
  notify_name: string | null;
}

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  from_me: number;
  timestamp: number;
  text: string | null;
  message_type: string;
  quoted_id: string | null;
}

export interface SentLogRow {
  id: number;
  chat_jid: string;
  text: string;
  client_name: string;
  timestamp: number;
  dry_run: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_ts INTEGER
);

CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  name TEXT,
  notify_name TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  sender_jid TEXT,
  from_me INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL,
  text TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  quoted_id TEXT,
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_jid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_from_me ON messages (from_me, timestamp DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS sent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  text TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT 'unknown',
  timestamp INTEGER NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0
);
`;

export class Store {
  readonly db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    ensureDirs();
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── chats ────────────────────────────────────────────────

  upsertChat(chat: { jid: string; name?: string | null; isGroup?: boolean; unreadCount?: number; lastMessageTs?: number | null }): void {
    this.db
      .prepare(
        `INSERT INTO chats (jid, name, is_group, unread_count, last_message_ts)
         VALUES (@jid, @name, @isGroup, @unreadCount, @lastMessageTs)
         ON CONFLICT(jid) DO UPDATE SET
           name = COALESCE(excluded.name, chats.name),
           is_group = MAX(chats.is_group, excluded.is_group),
           unread_count = COALESCE(NULLIF(excluded.unread_count, -1), chats.unread_count),
           last_message_ts = MAX(COALESCE(chats.last_message_ts, 0), COALESCE(excluded.last_message_ts, 0))`
      )
      .run({
        jid: chat.jid,
        name: chat.name ?? null,
        isGroup: chat.isGroup ? 1 : chat.jid.endsWith("@g.us") ? 1 : 0,
        unreadCount: chat.unreadCount ?? -1,
        lastMessageTs: chat.lastMessageTs ?? null,
      });
  }

  listChats(limit = 30): (ChatRow & { display_name: string | null })[] {
    return this.db
      .prepare(
        `SELECT c.*, COALESCE(c.name, ct.name, ct.notify_name) AS display_name
         FROM chats c LEFT JOIN contacts ct ON ct.jid = c.jid
         ORDER BY c.last_message_ts DESC NULLS LAST
         LIMIT ?`
      )
      .all(limit) as (ChatRow & { display_name: string | null })[];
  }

  // ── contacts ─────────────────────────────────────────────

  upsertContact(contact: { jid: string; name?: string | null; notifyName?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO contacts (jid, name, notify_name)
         VALUES (@jid, @name, @notifyName)
         ON CONFLICT(jid) DO UPDATE SET
           name = COALESCE(excluded.name, contacts.name),
           notify_name = COALESCE(excluded.notify_name, contacts.notify_name)`
      )
      .run({ jid: contact.jid, name: contact.name ?? null, notifyName: contact.notifyName ?? null });
  }

  searchContacts(query: string, limit = 20): (ContactRow & { is_group: number })[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    return this.db
      .prepare(
        `SELECT ct.jid, ct.name, ct.notify_name, COALESCE(c.is_group, 0) AS is_group
         FROM contacts ct LEFT JOIN chats c ON c.jid = ct.jid
         WHERE ct.jid LIKE ? OR ct.name LIKE ? OR ct.notify_name LIKE ?
         UNION
         SELECT c.jid, c.name, NULL, c.is_group
         FROM chats c
         WHERE (c.jid LIKE ? OR c.name LIKE ?) AND c.jid NOT IN (SELECT jid FROM contacts)
         LIMIT ?`
      )
      .all(like, like, like, like, like, limit) as (ContactRow & { is_group: number })[];
  }

  resolveDisplayName(jid: string): string | null {
    const row = this.db
      .prepare(
        `SELECT COALESCE(c.name, ct.name, ct.notify_name) AS display_name
         FROM (SELECT ? AS jid) j
         LEFT JOIN chats c ON c.jid = j.jid
         LEFT JOIN contacts ct ON ct.jid = j.jid`
      )
      .get(jid) as { display_name: string | null } | undefined;
    return row?.display_name ?? null;
  }

  // ── messages ─────────────────────────────────────────────

  insertMessage(msg: MessageRow): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id)
         VALUES (@id, @chat_jid, @sender_jid, @from_me, @timestamp, @text, @message_type, @quoted_id)
         ON CONFLICT(chat_jid, id) DO NOTHING`
      )
      .run(msg);
  }

  insertMessages(msgs: MessageRow[]): void {
    const insert = this.db.transaction((rows: MessageRow[]) => {
      for (const row of rows) this.insertMessage(row);
    });
    insert(msgs);
  }

  readMessages(chatJid: string, limit = 30, beforeTs?: number): MessageRow[] {
    if (beforeTs !== undefined) {
      return this.db
        .prepare(
          `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
           FROM messages WHERE chat_jid = ? AND timestamp < ?
           ORDER BY timestamp DESC LIMIT ?`
        )
        .all(chatJid, beforeTs, limit) as MessageRow[];
    }
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
         FROM messages WHERE chat_jid = ?
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(chatJid, limit) as MessageRow[];
  }

  searchMessages(query: string, opts: { chatJid?: string; limit?: number } = {}): (MessageRow & { snippet: string })[] {
    const limit = opts.limit ?? 20;
    // FTS5 special characters break MATCH; quote each term.
    const ftsQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, "")}"`)
      .join(" ");
    if (!ftsQuery) return [];
    const chatFilter = opts.chatJid ? "AND m.chat_jid = @chatJid" : "";
    return this.db
      .prepare(
        `SELECT m.id, m.chat_jid, m.sender_jid, m.from_me, m.timestamp, m.text, m.message_type, m.quoted_id,
                snippet(messages_fts, 0, '>>', '<<', '…', 12) AS snippet
         FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
         WHERE messages_fts MATCH @query ${chatFilter}
         ORDER BY m.timestamp DESC LIMIT @limit`
      )
      .all({ query: ftsQuery, chatJid: opts.chatJid, limit }) as (MessageRow & { snippet: string })[];
  }

  /** Messages sent by the user in one chat — the raw material for style analysis. */
  outgoingMessages(chatJid: string, limit = 500): MessageRow[] {
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
         FROM messages WHERE chat_jid = ? AND from_me = 1 AND text IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(chatJid, limit) as MessageRow[];
  }

  /** All outgoing messages across chats — for the global persona analysis. */
  allOutgoingMessages(limit = 5000): MessageRow[] {
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
         FROM messages WHERE from_me = 1 AND text IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(limit) as MessageRow[];
  }

  chatsWithMessageCounts(minMessages = 20): { chat_jid: string; total: number; outgoing: number }[] {
    return this.db
      .prepare(
        `SELECT chat_jid, COUNT(*) AS total, SUM(from_me) AS outgoing
         FROM messages GROUP BY chat_jid
         HAVING COUNT(*) >= ? ORDER BY total DESC`
      )
      .all(minMessages) as { chat_jid: string; total: number; outgoing: number }[];
  }

  // ── sent log ─────────────────────────────────────────────

  logSent(entry: { chatJid: string; text: string; clientName: string; dryRun: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO sent_log (chat_jid, text, client_name, timestamp, dry_run)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(entry.chatJid, entry.text, entry.clientName, Date.now(), entry.dryRun ? 1 : 0);
  }

  recentSends(withinMs: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM sent_log WHERE timestamp > ? AND dry_run = 0`)
      .get(Date.now() - withinMs) as { n: number };
    return row.n;
  }

  stats(): { chats: number; contacts: number; messages: number; outgoing: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      chats: one("SELECT COUNT(*) AS n FROM chats"),
      contacts: one("SELECT COUNT(*) AS n FROM contacts"),
      messages: one("SELECT COUNT(*) AS n FROM messages"),
      outgoing: one("SELECT COUNT(*) AS n FROM messages WHERE from_me = 1"),
    };
  }
}
