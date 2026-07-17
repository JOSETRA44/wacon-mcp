import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./paths.js";
import { vectorize, toBlob } from "../memory/vectorizer.js";

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

CREATE TABLE IF NOT EXISTS message_vectors (
  rowid INTEGER PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vectors_chat ON message_vectors (chat_jid);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  summary TEXT,
  summary_vec BLOB,
  UNIQUE (chat_jid, start_ts)
);
CREATE INDEX IF NOT EXISTS idx_episodes_chat ON episodes (chat_jid, start_ts DESC);

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
    const result = this.db
      .prepare(
        `INSERT INTO messages (id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id)
         VALUES (@id, @chat_jid, @sender_jid, @from_me, @timestamp, @text, @message_type, @quoted_id)
         ON CONFLICT(chat_jid, id) DO NOTHING`
      )
      .run(msg);
    if (result.changes > 0 && msg.text && msg.text.length >= 4) {
      this.db
        .prepare(`INSERT OR REPLACE INTO message_vectors (rowid, chat_jid, timestamp, vec) VALUES (?, ?, ?, ?)`)
        .run(result.lastInsertRowid, msg.chat_jid, msg.timestamp, toBlob(vectorize(msg.text)));
    }
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

  // ── vectors & episodes (hybrid memory) ───────────────────

  /** Index any messages missing from message_vectors. Idempotent; run at daemon start. */
  backfillVectors(): number {
    const missing = this.db
      .prepare(
        `SELECT m.rowid AS rowid, m.chat_jid, m.timestamp, m.text
         FROM messages m LEFT JOIN message_vectors v ON v.rowid = m.rowid
         WHERE v.rowid IS NULL AND m.text IS NOT NULL AND LENGTH(m.text) >= 4`
      )
      .all() as { rowid: number; chat_jid: string; timestamp: number; text: string }[];
    const insert = this.db.prepare(`INSERT OR REPLACE INTO message_vectors (rowid, chat_jid, timestamp, vec) VALUES (?, ?, ?, ?)`);
    const tx = this.db.transaction((rows: typeof missing) => {
      for (const r of rows) insert.run(r.rowid, r.chat_jid, r.timestamp, toBlob(vectorize(r.text)));
    });
    tx(missing);
    return missing.length;
  }

  vectorCandidates(chatJid?: string): { rowid: number; timestamp: number; vec: Buffer }[] {
    if (chatJid) {
      return this.db
        .prepare(`SELECT rowid, timestamp, vec FROM message_vectors WHERE chat_jid = ?`)
        .all(chatJid) as { rowid: number; timestamp: number; vec: Buffer }[];
    }
    return this.db.prepare(`SELECT rowid, timestamp, vec FROM message_vectors`).all() as {
      rowid: number;
      timestamp: number;
      vec: Buffer;
    }[];
  }

  messagesByRowids(rowids: number[]): (MessageRow & { rowid: number })[] {
    if (rowids.length === 0) return [];
    const placeholders = rowids.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT rowid, id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
         FROM messages WHERE rowid IN (${placeholders})`
      )
      .all(...rowids) as (MessageRow & { rowid: number })[];
  }

  /**
   * Segment a chat's history into conversation episodes (silence gap > 3h).
   * Existing episodes keep their agent-written summaries when boundaries match.
   */
  rebuildEpisodes(chatJid: string, gapMs = 3 * 3600_000): number {
    const msgs = this.db
      .prepare(`SELECT timestamp FROM messages WHERE chat_jid = ? ORDER BY timestamp ASC`)
      .all(chatJid) as { timestamp: number }[];
    if (msgs.length === 0) return 0;

    const episodes: { start: number; end: number; count: number }[] = [];
    let start = msgs[0]!.timestamp;
    let prev = start;
    let count = 0;
    for (const m of msgs) {
      if (m.timestamp - prev > gapMs) {
        episodes.push({ start, end: prev, count });
        start = m.timestamp;
        count = 0;
      }
      prev = m.timestamp;
      count++;
    }
    episodes.push({ start, end: prev, count });

    const upsert = this.db.prepare(
      `INSERT INTO episodes (chat_jid, start_ts, end_ts, message_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_jid, start_ts) DO UPDATE SET end_ts = excluded.end_ts, message_count = excluded.message_count`
    );
    const tx = this.db.transaction(() => {
      for (const ep of episodes) upsert.run(chatJid, ep.start, ep.end, ep.count);
    });
    tx();
    return episodes.length;
  }

  listEpisodes(chatJid: string, limit = 20): { id: number; chat_jid: string; start_ts: number; end_ts: number; message_count: number; summary: string | null }[] {
    return this.db
      .prepare(
        `SELECT id, chat_jid, start_ts, end_ts, message_count, summary
         FROM episodes WHERE chat_jid = ? ORDER BY start_ts DESC LIMIT ?`
      )
      .all(chatJid, limit) as { id: number; chat_jid: string; start_ts: number; end_ts: number; message_count: number; summary: string | null }[];
  }

  getEpisode(id: number): { id: number; chat_jid: string; start_ts: number; end_ts: number; message_count: number; summary: string | null } | null {
    return (
      (this.db
        .prepare(`SELECT id, chat_jid, start_ts, end_ts, message_count, summary FROM episodes WHERE id = ?`)
        .get(id) as { id: number; chat_jid: string; start_ts: number; end_ts: number; message_count: number; summary: string | null } | undefined) ?? null
    );
  }

  setEpisodeSummary(id: number, summary: string): void {
    this.db
      .prepare(`UPDATE episodes SET summary = ?, summary_vec = ? WHERE id = ?`)
      .run(summary, toBlob(vectorize(summary)), id);
  }

  episodesWithSummaries(chatJid?: string): { id: number; chat_jid: string; start_ts: number; end_ts: number; message_count: number; summary: string; summary_vec: Buffer }[] {
    const where = chatJid ? "AND chat_jid = ?" : "";
    const args = chatJid ? [chatJid] : [];
    return this.db
      .prepare(
        `SELECT id, chat_jid, start_ts, end_ts, message_count, summary, summary_vec
         FROM episodes WHERE summary IS NOT NULL AND summary_vec IS NOT NULL ${where}`
      )
      .all(...args) as { id: number; chat_jid: string; start_ts: number; end_ts: number; message_count: number; summary: string; summary_vec: Buffer }[];
  }

  /** All messages of a chat in a time range (for episode reading/summarizing). */
  messagesInRange(chatJid: string, startTs: number, endTs: number, limit = 500): MessageRow[] {
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
         FROM messages WHERE chat_jid = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC LIMIT ?`
      )
      .all(chatJid, startTs, endTs, limit) as MessageRow[];
  }

  /** Full bidirectional history of a chat — needed for dynamics analysis. */
  allMessages(chatJid: string, limit = 2000): MessageRow[] {
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
         FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?`
      )
      .all(chatJid, limit) as MessageRow[];
  }

  // ── attention & activity ─────────────────────────────────

  /** Chats the user engages with most — the basis for VIP triage. */
  topChats(limit = 15): { chat_jid: string; total: number }[] {
    return this.db
      .prepare(
        `SELECT chat_jid, COUNT(*) AS total FROM messages
         WHERE chat_jid NOT LIKE '%@g.us'
         GROUP BY chat_jid ORDER BY total DESC LIMIT ?`
      )
      .all(limit) as { chat_jid: string; total: number }[];
  }

  /**
   * Inbound-message counts per (weekday, hour) over a recent window.
   * Feeds the "is it worth staying online right now?" prediction.
   */
  inboundActivityHistogram(windowDays = 56, chatJid?: string): { dow: number; hour: number; count: number }[] {
    const since = Date.now() - windowDays * 24 * 3600_000;
    const filter = chatJid ? "AND chat_jid = ?" : "";
    const args: (number | string)[] = chatJid ? [since, chatJid] : [since];
    // SQLite strftime works on seconds; timestamps are ms. '%w'=weekday, '%H'=hour, localtime
    return this.db
      .prepare(
        `SELECT CAST(strftime('%w', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) AS dow,
                CAST(strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                COUNT(*) AS count
         FROM messages
         WHERE from_me = 0 AND timestamp >= ? ${filter}
         GROUP BY dow, hour`
      )
      .all(...args) as { dow: number; hour: number; count: number }[];
  }

  /** Compact catch-up: what arrived per chat since a timestamp. */
  digestSince(sinceTs: number, limit = 40): {
    chat_jid: string;
    display_name: string | null;
    is_group: number;
    incoming: number;
    last_ts: number;
    last_text: string | null;
  }[] {
    return this.db
      .prepare(
        `SELECT m.chat_jid,
                COALESCE(c.name, ct.name, ct.notify_name) AS display_name,
                COALESCE(c.is_group, 0) AS is_group,
                COUNT(*) AS incoming,
                MAX(m.timestamp) AS last_ts,
                (SELECT text FROM messages m2
                  WHERE m2.chat_jid = m.chat_jid AND m2.from_me = 0
                  ORDER BY m2.timestamp DESC LIMIT 1) AS last_text
         FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid
         LEFT JOIN contacts ct ON ct.jid = m.chat_jid
         WHERE m.from_me = 0 AND m.timestamp > ?
         GROUP BY m.chat_jid
         ORDER BY last_ts DESC
         LIMIT ?`
      )
      .all(sinceTs, limit) as {
      chat_jid: string;
      display_name: string | null;
      is_group: number;
      incoming: number;
      last_ts: number;
      last_text: string | null;
    }[];
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
