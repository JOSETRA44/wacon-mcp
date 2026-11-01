import { render } from "ink";
import { join } from "node:path";
import type { DaemonClient } from "../daemon/client.js";
import { UltraController } from "./application/controller.js";
import { DaemonGateway } from "./infrastructure/daemon-gateway.js";
import { LocalFiles } from "./infrastructure/local-files.js";
import { PreferencesFile } from "./infrastructure/preferences-file.js";
import { TerminalClipboard } from "./infrastructure/clipboard.js";
import { probeTerminal } from "./infrastructure/terminal-probe.js";
import { SixelImages } from "./infrastructure/sixel-images.js";
import { App } from "./presentation/App.js";
import { AgentController } from "./application/agent-controller.js";
import { AgendaController } from "./application/agenda-controller.js";
import { AgentHistoryFile } from "./infrastructure/agent-history-file.js";
import { LocalAgentCatalog } from "./infrastructure/agents/catalog.js";
import { AgentRuntime } from "./infrastructure/agents/runtime.js";
import { WACON_HOME } from "../core/paths.js";

/**
 * Composition root of `wacon chat ultra`: the only place that knows every
 * layer. Infrastructure adapters are built here and injected inward —
 * domain → application → presentation never import infrastructure.
 */
export async function runTui(client: DaemonClient, initialQuery?: string): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write("`wacon chat ultra` necesita una terminal interactiva. Para scripts usa los comandos con --json.\n");
    process.exit(1);
  }

  const gateway = new DaemonGateway(client);
  const controller = new UltraController(gateway, Date.now, new PreferencesFile());
  const agenda = new AgendaController(gateway, (text, tone) => controller.inform(text, tone));
  // Ask the terminal about graphics BEFORE Ink owns stdin. WACON_SIXEL=1/0
  // overrides detection for terminals that answer the query wrongly.
  const caps = await probeTerminal();
  if (process.env.WACON_SIXEL === "1") caps.sixel = true;
  if (process.env.WACON_SIXEL === "0") caps.sixel = false;
  const images = await new SixelImages(caps).init();
  // Modo IA: the user's own agents, each given Wacon's small read-only
  // toolset (no send tools) and a neutral working directory — never a repo.
  const waconEntry = process.argv[1] ?? "";
  const agent = new AgentController(controller, new LocalAgentCatalog(WACON_HOME), new AgentRuntime(join(WACON_HOME, "agent-models.json")), (a) => ({
    cwd: WACON_HOME,
    mcp: { command: process.execPath, args: [waconEntry, "mcp", "--toolset", "tui"], env: { WACON_CLIENT_NAME: `ia-${a.id}` } },
  }), new AgentHistoryFile(WACON_HOME));
  process.title = "Wacon";
  const app = render(<App controller={controller} files={new LocalFiles()} clipboard={new TerminalClipboard()} images={images} agent={agent} agenda={agenda} contacts={gateway} />, {
    // Own screen like vim/htop: your shell history is restored on exit.
    alternateScreen: true,
    exitOnCtrlC: false,
    // Lets terminals that support it report Shift+Enter (new line).
    kittyKeyboard: { mode: "auto" },
    // Redraw only what changed — the technique that keeps Claude Code smooth.
    incrementalRendering: true,
    maxFps: 30,
  });

  // Whatever escapes, restore the terminal before printing — a crash must
  // never leave the user staring at a frozen alternate screen.
  const crash = (err: unknown) => {
    controller.stop();
    agent.stop();
    app.unmount();
    process.stderr.write(`\nWacon se cerró por un error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  };
  process.on("unhandledRejection", crash);
  process.on("uncaughtException", crash);

  void controller.start(initialQuery);
  await app.waitUntilExit();
  controller.stop();
  agent.stop(); // never leave an agent process running behind us
  // The long-poll keeps a socket open; leave without waiting for it.
  process.exit(0);
}
