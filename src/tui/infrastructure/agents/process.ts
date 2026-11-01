import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Child-process plumbing shared by every agent runtime.
 *
 * Windows details that matter here: npm installs agents as `.cmd` shims,
 * which Node can only start through a shell (and a shell mangles multi-line
 * arguments — so prompts always travel on stdin, never argv); and killing the
 * shell does not kill the node process behind it, so we kill the whole tree.
 */

export const needsShell = (command: string) => process.platform === "win32" && /\.(cmd|bat)$/i.test(command);

/**
 * One command line for cmd.exe. Node deprecates passing an args array with
 * `shell: true` (it only concatenates them, and prints a warning that would
 * corrupt the TUI screen), so we quote each argument ourselves.
 */
export function shellLine(command: string, args: string[]): string {
  const q = (a: string) => (/^[\w.\-\/:=@+,]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
  return [`"${command}"`, ...args.map(q)].join(" ");
}

export function spawnAgent(command: string, args: string[], cwd: string, env: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  const shell = needsShell(command);
  return spawn(shell ? shellLine(command, args) : command, shell ? [] : args, {
    cwd,
    env: { ...process.env, ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    shell,
    windowsHide: true,
  });
}

export function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch {
    // already gone
  }
}

/** Split a stream into lines, tolerating chunks that end mid-line. */
export function onLines(stream: NodeJS.ReadableStream, fn: (line: string) => void): void {
  let buf = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string | Buffer) => {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.trim()) fn(line);
    }
  });
  stream.on("end", () => {
    if (buf.trim()) fn(buf);
    buf = "";
  });
}

/** Keep the last bytes of stderr: the only explanation a crashing agent gives. */
export function stderrTail(child: ChildProcessWithoutNullStreams, max = 2000): () => string {
  let tail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    tail = (tail + d).slice(-max);
  });
  return () => tail.replace(/\x1b\[[0-9;]*m/g, "").trim();
}

/** Tool output as plain text, whatever shape the agent wraps it in. */
export function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => textOf(v) ?? "").join("\n");
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.content !== undefined) return textOf(o.content);
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return String(value);
}
