import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprint } from "../src/memory-tidy.js";
import { proposalsDir } from "../src/policy.js";
import { acquireProjectLock } from "../src/project-lock.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

let env: TestEnv;
afterEach(() => env?.cleanup());

function run(args: string[]) {
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const scriptFile = path.join(env.root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify({ calls: [] }));
  const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SCRIPT: scriptFile }, stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const prop = (status: string) => `---\nstatus: ${status}\ndate: 2026-11-20\ntitle: Waiting one\nproposed_by: fe-member\nrun: r\nevidence:\n  - mail: m1\n---\nfacts\n`;

describe("agent-lyceum proposals", () => {
  it("is listed in the help", () => {
    env = makeEnv();
    expect(run(["--help"]).out).toMatch(/proposals\s/);
    expect(run(["proposals", "--help"]).out).toMatch(/list[\s\S]*review/);
  });

  it("`list` reads only: it shows the pending proposal and changes no file", () => {
    env = makeEnv();
    const p = env.project();
    expect(run(["proposals", "list", "-p", "demo"]).out).toContain("No proposals.");
    write(path.join(proposalsDir(p), "lessons", "ab12cd34-a.md"), prop("proposed"));
    const before = fingerprint(env.home);
    const r = run(["proposals", "list", "-p", "demo"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 proposal(s): 1 pending");
    expect(r.out).toContain("Waiting one");
    expect(fingerprint(env.home)).toEqual(before);
  });

  it("`review` with nothing pending wakes nobody and exits 0", () => {
    env = makeEnv();
    const r = run(["proposals", "review", "-p", "demo"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No pending proposals.");
  });

  it("`review` is refused while a run or a `call -p` holds the project", () => {
    env = makeEnv();
    const p = env.project();
    write(path.join(proposalsDir(p), "lessons", "ab12cd34-a.md"), prop("proposed"));
    const held = acquireProjectLock(p.paths.root, "call-1", { call: true });
    try {
      const r = run(["proposals", "review", "-p", "demo"]);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/needs the project to itself/);
    } finally {
      held.release();
    }
  });

  it("`call -p` with a project that does not exist fails with a non-zero exit", () => {
    env = makeEnv();
    const r = run(["call", "fe-member", "hello", "-p", "nope", "--dir", env.repo]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/Project "nope" config not found/);
  });
});
