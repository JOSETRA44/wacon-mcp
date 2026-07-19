import pc from "picocolors";

/**
 * Output policy for the CLI.
 *
 * Wacon serves two audiences with opposite needs: humans want colour and
 * formatting, agents get their context poisoned by ANSI escapes. Rather than
 * compromise, every data command routes through `emit()`: agents pass --json
 * and receive the daemon's object verbatim; humans get the pretty rendering.
 *
 * Colour is also disabled whenever it can't help (piped output, NO_COLOR,
 * --no-color) — relying on the colour library's own TTY detection proved
 * unreliable, and a stray escape code in an agent's context is a real bug.
 */

let jsonMode = false;
let colorEnabled = true;

export function configureOutput(opts: { json?: boolean; noColor?: boolean }): void {
  jsonMode = opts.json === true;
  const suppressed =
    opts.noColor === true ||
    jsonMode ||
    process.env.NO_COLOR !== undefined ||
    process.env.WACON_NO_COLOR === "1" ||
    !process.stdout.isTTY;
  colorEnabled = !suppressed;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** Colour helpers that go quiet when colour is off — call these, not picocolors. */
export const c = {
  bold: (s: string) => (colorEnabled ? pc.bold(s) : s),
  dim: (s: string) => (colorEnabled ? pc.dim(s) : s),
  red: (s: string) => (colorEnabled ? pc.red(s) : s),
  green: (s: string) => (colorEnabled ? pc.green(s) : s),
  yellow: (s: string) => (colorEnabled ? pc.yellow(s) : s),
  cyan: (s: string) => (colorEnabled ? pc.cyan(s) : s),
  magenta: (s: string) => (colorEnabled ? pc.magenta(s) : s),
};

/**
 * The single output path for data commands.
 * @param data   what an agent should receive (printed verbatim as JSON)
 * @param render how to show it to a human (only called outside --json)
 */
export function emit(data: unknown, render: () => void): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  render();
}

/** Errors: structured in json mode, readable otherwise. Always exit code 1. */
export function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  else process.stderr.write(`${c.red(`error: ${message}`)}\n`);
  process.exit(1);
}
