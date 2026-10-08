import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprint, listArchives, readTidyState } from "../src/memory-tidy.js";
import { acquireProjectLock } from "../src/project-lock.js";
import { makeEnv, makeMemoryEnv, write, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

let env: TestEnv;
afterEach(() => env?.cleanup());

/** A project whose lead has project memory (MEMORY.md, a.md, b.md); `script` gets the lead's memory dir and returns the fake claude's script. */
function setup(script: (memDir: string) => object, makeBase: () => TestEnv = makeMemoryEnv) {
  env = makeBase();
  const memDir = path.join(env.project().paths.root, "agents", "lead", "memory");
  write(path.join(memDir, "MEMORY.md"), "- [a](a.md)\n- [b](b.md)\n");
  write(path.join(memDir, "a.md"), "alpha");
  write(path.join(memDir, "b.md"), "beta");
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const scriptFile = path.join(env.root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(script(memDir)));
  const vars = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SCRIPT: scriptFile };
  const sync = (args: string[]) => {
    const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8", env: vars, stdio: ["ignore", "pipe", "pipe"] });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { sync, memDir, counter: `${scriptFile}.count` };
}

const TIDY = (memDir: string) => ({
  calls: [
    {
      agent: "lead",
      moveAbs: [{ from: path.join(memDir, "b.md"), to: "{ARCHIVE}/b.md" }],
      writeAbs: { [path.join(memDir, "MEMORY.md")]: "- [a](a.md)\n", "{ARCHIVE}/tidy-report.md": "## Merged\nNone\n\n## Archived\nb.md: stale\n\n## Unsure\nNone\n" },
    },
  ],
});

describe("memory tidy → restore", { timeout: 60_000 }, () => {
  it("tidies the lead's project memory, archives b.md, then restore brings it back", () => {
    const t = setup(TIDY);
    const r = t.sync(["memory", "tidy", "-p", "demo", "--agent", "lead"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/tidied/);
    expect(fs.existsSync(path.join(t.memDir, "b.md"))).toBe(false);
    const [stamp] = listArchives(t.memDir);
    expect(stamp).toBeDefined();
    expect(fs.existsSync(path.join(t.memDir, ".archive", stamp!, "b.md"))).toBe(true);
    expect(readTidyState(t.memDir)?.archive).toBe(stamp);

    const back = t.sync(["memory", "restore", stamp!, "-p", "demo", "--agent", "lead"]);
    expect(back.code).toBe(0);
    expect(fs.readFileSync(path.join(t.memDir, "b.md"), "utf8")).toBe("beta");
    expect(fs.readFileSync(path.join(t.memDir, "MEMORY.md"), "utf8")).toMatch(/b\.md/);
  });

  it("--dry-run does not wake the agent or change anything", () => {
    const t = setup(() => ({ calls: [] }));
    const before = fingerprint(t.memDir);
    const r = t.sync(["memory", "tidy", "-p", "demo", "--agent", "lead", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/lead/);
    expect(fs.existsSync(t.counter)).toBe(false); // fake claude never started
    expect(fingerprint(t.memDir)).toEqual(before);
    expect(fs.existsSync(path.join(t.memDir, ".tidy-state.json"))).toBe(false);
  });

  it("exits 1 and leaves the memory as it was when the agent writes no report", () => {
    const t = setup(() => ({ calls: [{ agent: "lead" }] }));
    const before = fingerprint(t.memDir);
    const r = t.sync(["memory", "tidy", "-p", "demo", "--agent", "lead"]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toMatch(/tidy-report/);
    expect(fingerprint(t.memDir)).toEqual(before);
    expect(readTidyState(t.memDir)).toBeUndefined();
  });

  it("refuses while a run holds the project lock", () => {
    const t = setup(() => ({ calls: [] }));
    const lease = acquireProjectLock(env.project().paths.root, "some-run");
    try {
      const r = t.sync(["memory", "tidy", "-p", "demo", "--agent", "lead"]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/some-run|lock/i);
      expect(fs.existsSync(t.counter)).toBe(false);
    } finally {
      lease.release();
    }
  });

  it("does not touch global memory by default, and rejects other layers", () => {
    const t = setup(TIDY);
    const globalDir = env.project().agents.lead!.memory.global!;
    write(path.join(globalDir, "MEMORY.md"), "g");
    const before = fingerprint(globalDir);
    expect(t.sync(["memory", "tidy", "-p", "demo", "--agent", "lead"]).code).toBe(0);
    expect(fingerprint(globalDir)).toEqual(before);
    expect(fs.existsSync(path.join(globalDir, ".tidy-state.json"))).toBe(false);
    expect(t.sync(["memory", "tidy", "-p", "demo", "--layer", "task"]).code).not.toBe(0);
  });

  it("explains how to get project memory when no agent has any", () => {
    const t = setup(() => ({ calls: [] }), makeEnv);
    const r = t.sync(["memory", "tidy", "-p", "demo"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/memory\.project/);
    expect(fs.existsSync(t.counter)).toBe(false);
  });
});
