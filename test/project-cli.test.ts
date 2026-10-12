import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");

let env: TestEnv | undefined;
let emptyHome: string | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
  if (emptyHome) fs.rmSync(emptyHome, { recursive: true, force: true });
  emptyHome = undefined;
});

function run(home: string, args: string[]) {
  const r = spawnSync(tsx, [cli, "--home", home, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("project (no subcommand)", { timeout: 60_000 }, () => {
  it("lists the registered projects", () => {
    env = makeEnv();
    const r = run(env.home, ["project"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^demo {2}-> {2}\S+/m);
  });

  it("says so when no project is registered", () => {
    emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lyceum-empty-"));
    const r = run(emptyHome, ["project"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/No projects registered\./);
  });

  it("the old `project list` is gone", () => {
    env = makeEnv();
    const r = run(env.home, ["project", "list"]);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toMatch(/demo/);
  });
});
