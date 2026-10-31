import { render } from "ink";
import type { DaemonClient } from "../daemon/client.js";
import { UltraController } from "./application/controller.js";
import { DaemonGateway } from "./infrastructure/daemon-gateway.js";
import { LocalFiles } from "./infrastructure/local-files.js";
import { App } from "./presentation/App.js";

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

  const controller = new UltraController(new DaemonGateway(client));
  process.title = "Wacon";
  const app = render(<App controller={controller} files={new LocalFiles()} />, {
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
    app.unmount();
    process.stderr.write(`\nWacon se cerró por un error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  };
  process.on("unhandledRejection", crash);
  process.on("uncaughtException", crash);

  void controller.start(initialQuery);
  await app.waitUntilExit();
  controller.stop();
  // The long-poll keeps a socket open; leave without waiting for it.
  process.exit(0);
}
