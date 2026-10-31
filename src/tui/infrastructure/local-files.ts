import { readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, basename, join, sep } from "node:path";
import type { FilePort } from "../application/ports.js";

/** FilePort over node:fs. Hidden files are skipped unless asked for with ".". */
export class LocalFiles implements FilePort {
  home(): string {
    return homedir() + sep;
  }

  exists(path: string): boolean {
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  }

  complete(partial: string): string[] {
    const expanded = partial.startsWith("~") ? join(homedir(), partial.slice(1)) : partial;
    const endsWithSep = /[\\/]$/.test(expanded);
    const dir = endsWithSep ? expanded : dirname(expanded);
    const prefix = endsWithSep ? "" : basename(expanded).toLowerCase();
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.name.toLowerCase().startsWith(prefix) && (prefix.startsWith(".") || !d.name.startsWith(".")))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .slice(0, 50)
        .map((d) => join(dir, d.name) + (d.isDirectory() ? sep : ""));
    } catch {
      return [];
    }
  }
}
