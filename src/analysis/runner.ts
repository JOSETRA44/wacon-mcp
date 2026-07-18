import type { Store } from "../core/store.js";
import { analyzeStyle, analyzeDynamics } from "../memory/analyzer.js";
import { writeProfileStats } from "../memory/profiles.js";
import { extractFacts, extractActionables } from "./extractors.js";
import { extractiveDigest } from "./summarize.js";

export interface AnalysisScope {
  mode: "all" | "contacts" | "groups" | "courses" | "chat";
  chat?: string;
  minMessages?: number;
  minOutgoing?: number;
}

export interface AnalysisJob {
  running: boolean;
  scope: string;
  total: number;
  processed: number;
  currentChat: string | null;
  factsFound: number;
  episodesSummarized: number;
  suggestionsFound: number;
  profilesBuilt: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

const COURSE_RE = /(econom|estad[ií]stic|microeconom|matem[aá]tic|ecolog|derecho|contab|c[aá]lculo|f[ií]sica|qu[ií]mic|historia|filosof|curso|secc|aula|semestre|grupo\s|2\s*["“]?[a-d]|desarrollo)/i;
const JUNK_RE = /(venta|c\/v|free\s*fire|recarga|cuenta|apuesta|gol\s|anali[sz]ta|combo|promo|s[/.]?\d|precio|delivery|taxi|trans\.|qawa)/i;

/**
 * The brute-force analysis engine. Runs the deterministic Tier-1 pipeline over
 * the selected chats, updating a live job object so the CLI/agents can watch.
 * No LLM, no tokens.
 */
export class AnalysisRunner {
  job: AnalysisJob | null = null;

  constructor(private store: Store) {}

  get status(): AnalysisJob | null {
    return this.job;
  }

  private selectChats(scope: AnalysisScope): string[] {
    if (scope.mode === "chat" && scope.chat) return [scope.chat];
    const minOutgoing = scope.minOutgoing ?? 10;
    const targets = this.store.analysisTargets(1000, minOutgoing);
    return targets
      .filter((t) => {
        if (scope.mode === "contacts") return !t.isGroup;
        if (scope.mode === "groups") return t.isGroup;
        if (scope.mode === "courses") {
          const name = t.displayName ?? "";
          return t.isGroup && COURSE_RE.test(name) && !JUNK_RE.test(name);
        }
        return true; // all
      })
      .map((t) => t.jid);
  }

  /** Start the job (idempotent while running). Returns immediately; work continues async. */
  start(scope: AnalysisScope): AnalysisJob {
    if (this.job?.running) return this.job;
    const chats = this.selectChats(scope);
    this.job = {
      running: true,
      scope: scope.mode,
      total: chats.length,
      processed: 0,
      currentChat: null,
      factsFound: 0,
      episodesSummarized: 0,
      suggestionsFound: 0,
      profilesBuilt: 0,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    };
    void this.run(chats, scope);
    return this.job;
  }

  private async run(chats: string[], scope: AnalysisScope): Promise<void> {
    const job = this.job!;
    try {
      for (const jid of chats) {
        job.currentChat = this.store.resolveDisplayName(jid) ?? jid;
        const isGroup = jid.endsWith("@g.us");
        const all = this.store.allMessages(jid, 5000);

        if (!isGroup) {
          // Style + dynamics + profile (existing deterministic analysis).
          const outgoing = all.filter((m) => m.from_me && m.text);
          if (outgoing.length >= (scope.minOutgoing ?? 5)) {
            const dynamics = analyzeDynamics(all);
            writeProfileStats(jid, this.store.resolveDisplayName(jid), analyzeStyle(outgoing, dynamics));
            job.profilesBuilt++;
          }
          // Candidate facts from their incoming messages.
          const incoming = all.filter((m) => !m.from_me);
          for (const f of extractFacts(incoming)) {
            this.store.upsertFact({ jid, category: f.category, fact: f.fact, confidence: f.confidence, sourceMsgId: f.sourceMsgId });
            job.factsFound++;
          }
        } else {
          // Groups: extract actionables as suggestions (no calendar writes).
          for (const a of extractActionables(all)) {
            this.store.addSuggestedEvent({ chatJid: jid, title: a.title, whenTs: a.whenTs, rawText: a.rawText, sourceMsgId: a.sourceMsgId });
            job.suggestionsFound++;
          }
        }

        // Episodes + extractive digests for any episode still without a summary.
        this.store.rebuildEpisodes(jid);
        for (const ep of this.store.listEpisodes(jid, 100)) {
          if (ep.summary) continue;
          const msgs = this.store.messagesInRange(ep.chat_jid, ep.start_ts, ep.end_ts);
          const digest = extractiveDigest(msgs, (m) => (m.from_me ? "yo" : "él/ella"));
          if (digest) {
            this.store.setEpisodeSummary(ep.id, digest);
            job.episodesSummarized++;
          }
        }

        job.processed++;
        // Yield so the HTTP server stays responsive and progress is observable.
        await new Promise((r) => setImmediate(r));
      }
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.running = false;
      job.currentChat = null;
      job.finishedAt = Date.now();
    }
  }
}
