import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { NOTEBOOKS_PATH, ensureDirs } from "./paths.js";

/**
 * Maps chat tags to external knowledge notebooks (NotebookLM). When an agent
 * asks for a playbook on a tagged chat, Wacon queries the mapped notebook.
 */
const NotebookMapping = z.object({
  /** NotebookLM id or alias (nlm accepts either). */
  notebook: z.string(),
  /** What this notebook is FOR — shapes the question sent to it. */
  purpose: z.string(),
});

const NotebooksConfigSchema = z.object({
  tags: z.record(z.string(), NotebookMapping).default({}),
  /** Override the nlm executable path if it isn't on PATH. */
  nlmPath: z.string().default("nlm"),
  /** Per-query timeout. NotebookLM can take a while; the user said latency is fine. */
  timeoutSeconds: z.number().int().min(10).max(300).default(240),
});

export type NotebooksConfig = z.infer<typeof NotebooksConfigSchema>;
export type NotebookMappingT = z.infer<typeof NotebookMapping>;

/** Ships with a working default: the persuasion notebook the user already built. */
const DEFAULT_CONFIG: NotebooksConfig = {
  nlmPath: "nlm",
  timeoutSeconds: 240,
  tags: {
    seduccion: { notebook: "wacon", purpose: "tácticas de seducción y coqueteo por chat" },
    ventas: { notebook: "wacon", purpose: "persuasión y cierre de ventas" },
    persuasion: { notebook: "wacon", purpose: "principios de persuasión e influencia" },
    debate: { notebook: "wacon", purpose: "argumentación y retórica para debates" },
    amistad: { notebook: "wacon", purpose: "construir rapport y cercanía" },
  },
};

export function loadNotebooksConfig(): NotebooksConfig {
  ensureDirs();
  if (!existsSync(NOTEBOOKS_PATH)) {
    writeFileSync(NOTEBOOKS_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return DEFAULT_CONFIG;
  }
  try {
    return NotebooksConfigSchema.parse(JSON.parse(readFileSync(NOTEBOOKS_PATH, "utf8")));
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Resolve the notebook mapping for a set of tags (first tag that maps wins). */
export function mappingForTags(config: NotebooksConfig, tags: string[]): { tag: string; mapping: NotebookMappingT } | null {
  for (const tag of tags) {
    const mapping = config.tags[tag];
    if (mapping) return { tag, mapping };
  }
  return null;
}
