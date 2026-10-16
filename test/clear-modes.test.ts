import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProjectLock } from "../src/project-lock.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");

let env: TestEnv;
afterEach(() => env?.cleanup());

function run(args: string[]) {
  const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const seedRun = (id: string) =>
  write(path.join(env.project().paths.runs, id, "state.json"), JSON.stringify({ run_id: id, rounds: 1, max_rounds: 10, last_wake: {}, wakes: [], end_reason: "idle", task_summary: "x" }));
const lockFile = (id: string) => path.join(env.project().paths.root, "locks", `${id}.json`);

describe("clear: modes are exclusive and checked before any side effect", { timeout: 60_000 }, () => {
  const cases: [string[], RegExp][] = [
    [["--tidy-memory", "r1"], /--tidy-memory takes no run.*agent-lyceum clear r1/],
    [["r1", "--tidy-memory"], /--tidy-memory takes no run/],
    [["--tidy-memory", "--lock"], /either --tidy-memory or --lock/],
    [["--tidy-memory", "--force"], /--force do not go with --tidy-memory/],
    [["--tidy-memory", "--keep-worktrees"], /--keep-worktrees do not go with --tidy-memory/],
    [["--tidy-memory", "--force", "--keep-worktrees"], /--force \/ --keep-worktrees do not go with --tidy-memory/],
    [["r1", "--agent", "lead"], /--agent only go with --tidy-memory/],
    [["r1", "--layer", "global"], /--layer only go with --tidy-memory/],
    [["--undo", "20260101T000000Z", "--agent", "lead"], /--undo only go with --tidy-memory/],
    [["--tidy-memory", "--undo", "20260101T000000Z", "--agent", "lead", "--dry-run"], /--undo cannot be combined with --dry-run/],
    [["--tidy-memory", "--undo", "20260101T000000Z"], /--undo needs --agent/],
    [["r1", "--force"], /--force only goes with --lock/],
    [["--lock", "--dry-run"], /--dry-run do not go with --lock/],
    [["--lock", "--keep-worktrees"], /--keep-worktrees do not go with --lock/],
    [[], /Give the run to delete.*--lock.*--tidy-memory/],
  ];
  it.each(cases)("clear %j exits 1 and changes nothing", (args, msg) => {
    env = makeEnv();
    seedRun("r1");
    write(lockFile("r1"), "garbage");
    const r = run(["clear", ...args, "-p", "demo"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(msg);
    expect(fs.existsSync(path.join(env.project().paths.runs, "r1", "state.json"))).toBe(true);
    expect(fs.readFileSync(lockFile("r1"), "utf8")).toBe("garbage");
  });
});

describe("clear --lock: exact lock id first, then an exact run", { timeout: 60_000 }, () => {
  it("removes a lock whose run dir is gone and whose file is unreadable; a prefix is refused", () => {
    env = makeEnv();
    write(lockFile("run-z"), "garbage");
    const prefix = run(["clear", "--lock", "run", "--force", "-p", "demo"]);
    expect(prefix.code).toBe(1);
    expect(fs.existsSync(lockFile("run-z"))).toBe(true);
    const ok = run(["clear", "--lock", "run-z", "--force", "-p", "demo"]);
    expect(ok.code).toBe(0);
    expect(fs.existsSync(lockFile("run-z"))).toBe(false);
  });

  it("refuses a prefix of an existing run, keeping its lock; an exact run name works", () => {
    env = makeEnv();
    seedRun("20261014-010000");
    write(lockFile("20261014-010000"), "garbage");
    const r = run(["clear", "--lock", "20261014-01", "--force", "-p", "demo"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("agent-lyceum clear 20261014-010000 --lock --force -p demo");
    expect(fs.existsSync(lockFile("20261014-010000"))).toBe(true);
    expect(run(["clear", "--lock", "20261014-010000", "--force", "-p", "demo"]).code).toBe(0);
    expect(fs.existsSync(lockFile("20261014-010000"))).toBe(false);
  });

  it("lists a readable and an unreadable lock when no run is given", () => {
    env = makeEnv();
    const lease = acquireProjectLock(env.project().paths.root, "run-ok", { maxConcurrent: 2 });
    try {
      write(lockFile("run-bad"), "garbage");
      const r = run(["clear", "--lock", "-p", "demo"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("run-ok");
      expect(r.err).toContain("run-bad");
      expect(r.err).toMatch(/cannot be read/);
    } finally {
      lease.release();
    }
  });
});
