import type { Store, MessageRow } from "../core/store.js";
import { vectorize, cosine, fromBlob } from "./vectorizer.js";

export interface RecallHit {
  message: MessageRow;
  score: number;
  matchedBy: ("keyword" | "semantic" | "recency")[];
}

export interface EpisodeHit {
  id: number;
  chat_jid: string;
  start_ts: number;
  end_ts: number;
  message_count: number;
  summary: string;
  similarity: number;
}

export interface RecallResult {
  messages: RecallHit[];
  episodes: EpisodeHit[];
}

const RRF_K = 60;

/**
 * Hybrid retrieval over the message history:
 *   1. keyword candidates from FTS5 (BM25 order)
 *   2. semantic candidates from hashed-feature vectors (cosine order)
 *   3. recency ranking over the union
 * fused with Reciprocal Rank Fusion — robust without score calibration.
 * Episode summaries written by agents are searched semantically as well,
 * so consolidated memories surface next to raw messages.
 */
export function recall(store: Store, query: string, opts: { chatJid?: string; limit?: number } = {}): RecallResult {
  const limit = opts.limit ?? 12;
  const queryVec = vectorize(query);

  // 1) keyword candidates
  const ftsRows = store.searchMessages(query, { chatJid: opts.chatJid, limit: 150 });
  const keywordRank = new Map<string, number>();
  ftsRows.forEach((m, i) => keywordRank.set(`${m.chat_jid}|${m.id}`, i));

  // 2) semantic candidates (brute-force cosine over stored vectors; typed
  //    arrays make this a few ms per 10k messages)
  const vecRows = store.vectorCandidates(opts.chatJid);
  const scored: { key: string; rowid: number; sim: number; ts: number }[] = [];
  for (const row of vecRows) {
    const sim = cosine(queryVec, fromBlob(row.vec));
    if (sim > 0.08) scored.push({ key: "", rowid: row.rowid, sim, ts: row.timestamp });
  }
  scored.sort((a, b) => b.sim - a.sim);
  const topSemantic = scored.slice(0, 150);
  const semanticMsgs = store.messagesByRowids(topSemantic.map((s) => s.rowid));
  const semanticRank = new Map<string, number>();
  const rowidToKey = new Map<number, string>();
  semanticMsgs.forEach((m) => rowidToKey.set(m.rowid, `${m.chat_jid}|${m.id}`));
  topSemantic.forEach((s, i) => {
    const key = rowidToKey.get(s.rowid);
    if (key) semanticRank.set(key, i);
  });

  // 3) union + recency rank + RRF fusion
  const byKey = new Map<string, MessageRow>();
  for (const m of ftsRows) byKey.set(`${m.chat_jid}|${m.id}`, m);
  for (const m of semanticMsgs) byKey.set(`${m.chat_jid}|${m.id}`, m);

  const union = [...byKey.entries()];
  const recencyOrder = union
    .slice()
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .map(([key]) => key);
  const recencyRank = new Map<string, number>();
  recencyOrder.forEach((key, i) => recencyRank.set(key, i));

  const hits: RecallHit[] = union.map(([key, message]) => {
    const matchedBy: RecallHit["matchedBy"] = [];
    let score = 0;
    const kw = keywordRank.get(key);
    if (kw !== undefined) {
      score += 1 / (RRF_K + kw);
      matchedBy.push("keyword");
    }
    const sem = semanticRank.get(key);
    if (sem !== undefined) {
      score += 1 / (RRF_K + sem);
      matchedBy.push("semantic");
    }
    const rec = recencyRank.get(key)!;
    score += 0.5 / (RRF_K + rec); // recency is a tie-breaker, half weight
    if (rec < 20) matchedBy.push("recency");
    return { message, score, matchedBy };
  });
  hits.sort((a, b) => b.score - a.score);

  // 4) episode summaries, semantically
  const episodes: EpisodeHit[] = [];
  for (const ep of store.episodesWithSummaries(opts.chatJid)) {
    const sim = cosine(queryVec, fromBlob(ep.summary_vec));
    if (sim > 0.12) {
      episodes.push({
        id: ep.id,
        chat_jid: ep.chat_jid,
        start_ts: ep.start_ts,
        end_ts: ep.end_ts,
        message_count: ep.message_count,
        summary: ep.summary,
        similarity: Number(sim.toFixed(3)),
      });
    }
  }
  episodes.sort((a, b) => b.similarity - a.similarity);

  return { messages: hits.slice(0, limit), episodes: episodes.slice(0, 3) };
}
