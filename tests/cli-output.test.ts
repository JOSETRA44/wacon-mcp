import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { configureOutput, emit, isJsonMode, c } from "../src/cli/output.js";

const ANSI = /\x1b\[/;

let written: string[] = [];
let logged: string[] = [];

beforeEach(() => {
  written = [];
  logged = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NO_COLOR;
});

describe("agent-safe output", () => {
  it("emits pure JSON with zero ANSI in --json mode", () => {
    configureOutput({ json: true });
    expect(isJsonMode()).toBe(true);

    emit([{ chat: "a@s.whatsapp.net", priority: 75 }], () => console.log("human view"));

    const out = written.join("");
    expect(ANSI.test(out)).toBe(false);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)[0].priority).toBe(75);
    // the human renderer must not run — that's what pollutes an agent's context
    expect(logged).toHaveLength(0);
  });

  it("strips colour helpers in json mode", () => {
    configureOutput({ json: true });
    expect(ANSI.test(c.red("boom"))).toBe(false);
    expect(c.bold("x")).toBe("x");
  });

  it("honours NO_COLOR for the human view", () => {
    process.env.NO_COLOR = "1";
    configureOutput({});
    expect(ANSI.test(c.green("ok"))).toBe(false);
  });

  it("honours an explicit --no-color", () => {
    configureOutput({ noColor: true });
    expect(ANSI.test(c.yellow("warn"))).toBe(false);
  });

  it("runs the human renderer (not JSON) when json is off", () => {
    configureOutput({ noColor: true });
    emit({ hidden: true }, () => console.log("human view"));
    expect(logged).toContain("human view");
    expect(written.join("")).not.toContain("hidden");
  });
});
