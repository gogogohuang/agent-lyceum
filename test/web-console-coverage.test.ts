import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../web/src/commands.js";

const cli = fs.readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

/** Commands registered on the CLI: top level (`program\n  .command("x")`) and under `project`. */
function registered(): string[] {
  const top = [...cli.matchAll(/(?:^|\s)program\s*\n\s*\.command\("([a-z-]+)/g)].map((m) => m[1] as string);
  const sub = [...cli.matchAll(/^project\s*\n\s*\.command\("([a-z-]+)/gm)].map((m) => `project ${m[1] as string}`);
  return [...top, ...sub];
}

/** Every CLI command and the web command ids that cover it. */
const COVERED: Record<string, string[]> = {
  init: ["init"],
  project: ["project.list"],
  "project add": ["project.add"],
  "project remove": ["project.remove"],
  run: ["run"],
  call: ["call"],
  resume: ["resume"],
  clear: ["clear", "clear.lock"],
  doctor: ["doctor"],
  tidy: ["tidy"],
  demo: ["demo"],
};

/** Commands the web console deliberately does not run, with the reason. */
const UNSUPPORTED: Record<string, string> = {
  status: "read-only: the live page is the status view, and `status --web` is the server itself",
};

describe("web console covers the CLI", () => {
  it("finds the CLI commands (guards the regex itself)", () => {
    expect(registered()).toEqual(expect.arrayContaining(["init", "run", "resume", "clear", "doctor", "call", "tidy", "status", "demo", "project add", "project remove"]));
  });
  it("every CLI command is covered or explicitly unsupported", () => {
    const missing = registered().filter((c) => !(c in COVERED) && !(c in UNSUPPORTED));
    expect(missing, `CLI commands with no web entry: ${missing.join(", ")}. Add them to web/src/commands.ts, or list them in UNSUPPORTED with a reason.`).toEqual([]);
  });
  it("every covered id exists, and every web id is claimed", () => {
    const claimed = Object.values(COVERED).flat();
    for (const id of claimed) expect(Object.keys(COMMANDS)).toContain(id);
    for (const id of Object.keys(COMMANDS)) expect(claimed).toContain(id);
  });
});
