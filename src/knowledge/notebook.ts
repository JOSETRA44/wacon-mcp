import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Store, FactRow } from "../core/store.js";
import { loadNotebooksConfig, mappingForTags, type NotebooksConfig } from "../core/notebooks-config.js";
import { renderFacts } from "../memory/facts.js";

/**
 * External-knowledge layer. Wacon (not the agent) drives NotebookLM through
 * the `nlm` CLI, so any agent gets playbook advice with zero setup — and if
 * nlm is missing or fails, we degrade gracefully instead of breaking the reply.
 */

export interface NotebookAnswer {
  ok: true;
  answer: string;
  conversationId: string | null;
  citations: { number: string; sourceId: string; text?: string }[];
}

export interface NotebookFailure {
  ok: false;
  reason: string;
}

export type NotebookResult = NotebookAnswer | NotebookFailure;

interface RawNlmResponse {
  answer?: string;
  conversation_id?: string;
  status?: string;
  error?: string;
  citations?: Record<string, string>;
  references?: { source_id: string; citation_number: number; cited_text?: string }[];
}

function safeParse(text: string): RawNlmResponse | null {
  try {
    return JSON.parse(text) as RawNlmResponse;
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idCache = new Map<string, string>();

/**
 * `nlm query` needs a notebook ID, not a title. Let users configure a friendly
 * title (e.g. "wacon") and resolve it to the current id via `nlm notebook list`.
 * IDs are passed straight through. Result cached per process.
 */
export function resolveNotebookId(notebook: string, nlmPath = "nlm"): string | null {
  if (UUID_RE.test(notebook)) return notebook;
  const cached = idCache.get(notebook.toLowerCase());
  if (cached) return cached;
  try {
    const res = spawnSync(nlmPath, ["notebook", "list", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
      shell: process.platform === "win32",
    });
    if (res.status !== 0) return null;
    const start = res.stdout.indexOf("[");
    if (start < 0) return null;
    const list = JSON.parse(res.stdout.slice(start)) as { id?: string; title?: string }[];
    const match = list.find((n) => (n.title ?? "").toLowerCase() === notebook.toLowerCase());
    if (match?.id) {
      idCache.set(notebook.toLowerCase(), match.id);
      return match.id;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Under `shell: true` (needed on Windows to resolve nlm.cmd), spawn does NOT
 * quote args, so cmd.exe would choke on spaces and parentheses in the question.
 * Wrap each arg in double quotes (stripping inner quotes) — inside cmd double
 * quotes, ()&| etc. are literal.
 */
function shellQuote(arg: string): string {
  return `"${arg.replace(/"/g, "")}"`;
}

/** Run `nlm query notebook <id> "<question>" --json` with a hard timeout. */
export function queryNotebook(notebookId: string, question: string, opts: { nlmPath?: string; timeoutSeconds?: number } = {}): Promise<NotebookResult> {
  const nlmPath = opts.nlmPath ?? "nlm";
  const timeoutMs = (opts.timeoutSeconds ?? 120) * 1000;
  const useShell = process.platform === "win32";

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: NotebookResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    const rawArgs = ["query", "notebook", notebookId, question, "--json"];
    const args = useShell ? rawArgs.map(shellQuote) : rawArgs;

    let child;
    try {
      child = spawn(nlmPath, args, {
        shell: useShell, // resolve nlm.cmd / .exe on Windows PATH
      });
    } catch (err) {
      done({ ok: false, reason: `no se pudo ejecutar nlm: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      done({ ok: false, reason: `nlm no respondió en ${opts.timeoutSeconds ?? 120}s` });
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, reason: `nlm no está disponible: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Parse the JSON body regardless of exit code — nlm surfaces API errors
      // (timeouts, not-found) inside the body, sometimes with a non-zero exit.
      const start = stdout.indexOf("{");
      const raw: RawNlmResponse | null = start >= 0 ? safeParse(stdout.slice(start)) : null;

      if (raw && raw.answer && raw.status !== "error") {
        resolve({
          ok: true,
          answer: raw.answer.trim(),
          conversationId: raw.conversation_id ?? null,
          citations: (raw.references ?? []).map((r) => ({
            number: String(r.citation_number),
            sourceId: r.source_id,
            text: r.cited_text?.trim().slice(0, 240),
          })),
        });
        return;
      }
      if (raw && (raw.status === "error" || raw.error)) {
        done({ ok: false, reason: raw.error ?? "NotebookLM reportó un error" });
        return;
      }
      done({
        ok: false,
        reason: code !== 0 ? `nlm salió con código ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}` : "nlm no devolvió una respuesta legible",
      });
    });
  });
}

export interface PlaybookResult {
  consulted: boolean;
  degraded: boolean;
  tag?: string;
  notebook?: string;
  question?: string;
  advice?: string;
  citations?: { number: string; sourceId: string; text?: string }[];
  fromCache?: boolean;
  note?: string;
}

function situationHash(tag: string, situation: string): string {
  return createHash("sha1").update(`${tag}|${situation.toLowerCase().trim()}`).digest("hex").slice(0, 16);
}

/** Build a focused question that fuses the situation with what we know of the contact. */
function buildQuestion(purpose: string, situation: string, facts: FactRow[]): string {
  const factLine = facts.length > 0 ? ` Contexto de la persona: ${renderFacts(facts).replace(/\n/g, " ")}.` : "";
  return `Eres un asesor experto en ${purpose}. Situación: ${situation}.${factLine} Dame 2-3 consejos concretos y accionables para mi próximo mensaje, en español, breves.`;
}

/**
 * The orchestration entry point. Resolves the chat's tags to a notebook,
 * consults it (through cache), and always returns a usable result — even on
 * failure, so the caller can still let the agent reply from general knowledge.
 */
export async function consultPlaybook(
  store: Store,
  jid: string,
  situation: string,
  config: NotebooksConfig = loadNotebooksConfig()
): Promise<PlaybookResult> {
  const tags = store.chatTags(jid);
  if (tags.length === 0) {
    return { consulted: false, degraded: false, note: "El chat no tiene etiquetas especiales; no se consulta ningún playbook." };
  }
  const resolved = mappingForTags(config, tags);
  if (!resolved) {
    return {
      consulted: false,
      degraded: false,
      note: `El chat tiene etiquetas (${tags.join(", ")}) pero ninguna está mapeada a un notebook en notebooks.json.`,
    };
  }

  const { tag, mapping } = resolved;
  const facts = store.listFacts(jid);
  const question = buildQuestion(mapping.purpose, situation, facts);
  const hash = situationHash(tag, situation);

  const cached = store.getCachedPlaybook(tag, hash);
  if (!cached) {
    // Resolve title→id up front so a friendly config value like "wacon" works.
    const notebookId = resolveNotebookId(mapping.notebook, config.nlmPath);
    if (!notebookId) {
      return {
        consulted: true,
        degraded: true,
        tag,
        notebook: mapping.notebook,
        question,
        note: `No se encontró el notebook "${mapping.notebook}" en NotebookLM. Revisa notebooks.json o ejecuta 'wacon doctor'. Responde con tu conocimiento general sobre ${mapping.purpose}.`,
      };
    }
    mapping.notebook = notebookId; // use the resolved id for the query below
  }
  if (cached) {
    return {
      consulted: true,
      degraded: false,
      fromCache: true,
      tag,
      notebook: mapping.notebook,
      question: cached.question,
      advice: cached.answer,
      citations: cached.citations_json ? (JSON.parse(cached.citations_json) as PlaybookResult["citations"]) : [],
    };
  }

  const result = await queryNotebook(mapping.notebook, question, { nlmPath: config.nlmPath, timeoutSeconds: config.timeoutSeconds });
  if (!result.ok) {
    // Graceful degradation: never break the reply flow.
    return {
      consulted: true,
      degraded: true,
      tag,
      notebook: mapping.notebook,
      question,
      note: `No se pudo consultar el playbook (${result.reason}). Responde con tu conocimiento general sobre ${mapping.purpose}.`,
    };
  }

  store.cachePlaybook({ tag, situationHash: hash, question, answer: result.answer, citationsJson: JSON.stringify(result.citations) });
  return {
    consulted: true,
    degraded: false,
    tag,
    notebook: mapping.notebook,
    question,
    advice: result.answer,
    citations: result.citations,
  };
}
