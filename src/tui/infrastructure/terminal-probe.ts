/**
 * Ask the terminal what it can do, BEFORE Ink takes over stdin:
 *   CSI 16 t  → the size of one character cell in pixels
 *   CSI c     (DA1) → a reply containing ";4" means sixel graphics
 * Terminals that don't answer simply time out — then we assume no sixel and
 * a typical 10×20 cell, and the app falls back to the OS image viewer.
 */
export interface TerminalCaps {
  sixel: boolean;
  cellWidth: number;
  cellHeight: number;
}

const FALLBACK: TerminalCaps = { sixel: false, cellWidth: 10, cellHeight: 20 };

export function parseCaps(reply: string): TerminalCaps {
  const da1 = /\x1b\[\?([\d;]+)c/.exec(reply);
  const sixel = !!da1 && da1[1]!.split(";").includes("4");
  const cell = /\x1b\[6;(\d+);(\d+)t/.exec(reply);
  const cellHeight = cell ? Number(cell[1]) : FALLBACK.cellHeight;
  const cellWidth = cell ? Number(cell[2]) : FALLBACK.cellWidth;
  return { sixel, cellWidth: cellWidth || FALLBACK.cellWidth, cellHeight: cellHeight || FALLBACK.cellHeight };
}

export async function probeTerminal(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
  timeoutMs = 350
): Promise<TerminalCaps> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") return FALLBACK;
  return new Promise((resolve) => {
    let buf = "";
    const wasRaw = stdin.isRaw;
    const finish = () => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(parseCaps(buf));
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      // DA1 is answered last (it is sent last), so its arrival means done.
      if (/\x1b\[\?[\d;]+c/.test(buf)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdout.write("\x1b[16t\x1b[c");
  });
}
