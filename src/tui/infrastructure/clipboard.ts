import type { ClipboardPort } from "../application/ports.js";

/**
 * OSC 52: ask the terminal itself to put text on the system clipboard. No
 * native module, no `clip.exe`, and it works over SSH because the terminal on
 * YOUR machine does the copying. Windows Terminal, WezTerm, iTerm2, kitty and
 * most modern terminals honour it.
 */
export class TerminalClipboard implements ClipboardPort {
  constructor(private readonly out: NodeJS.WriteStream = process.stdout) {}

  copy(text: string): void {
    this.out.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
  }
}
