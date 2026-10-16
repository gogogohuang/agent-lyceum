import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProjectLock, listRunLocks } from "../src/project-lock.js";
import { git, initGitRepo, makeEnv, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

let env: TestEnv;
afterEach(() => env?.cleanup());

/** The whole tool, as a user runs it: the real CLI on the real dispatcher, with a scripted stand-in for `claude`. */
function setup(script: object, opts: { git?: boolean } = {}) {
  env = makeEnv();
  if (opts.git !== false) initGitRepo(env.repo);
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const scriptFile = path.join(env.root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  const envVars = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SCRIPT: scriptFile, FAKE_MARKER: path.join(env.root, "marker.json") };
  const sync = (args: string[]) => {
    const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8", env: envVars });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const start = (args: string[]) => {
    const child = spawn(tsx, [cli, "--home", env.home, ...args], { env: envVars, stdio: ["ignore", "pipe", "pipe"] });
    const done = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    return { child, done };
  };
  return { sync, start, scriptFile, marker: path.join(env.root, "marker.json") };
}
const until = async (cond: () => boolean, ms = 20000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
};

describe("a run from start to clear", () => {
  it("run -> member works in a worktree -> Ctrl-C -> resume -> its files reach the repo -> done; status; clear --dry-run -> clear", async () => {
    const t = setup({
      calls: [
        { agent: "lead", mail: [{ to: "fe-member", type: "task", subject: "build it", body: "## Goal\nbuild\n\n## Acceptance criteria\nworks\n\n## Scope\nsrc/web\n\n## Upstream\nNone\n" }] },
        { agent: "fe-member", sleep: true, writes: { "src/web/feature.txt": "built\n" } }, // killed by Ctrl-C mid-wake
        { agent: "fe-member", writes: { "src/web/feature.txt": "built properly\n" }, mail: [{ to: "lead", subject: "built" }] },
        { agent: "lead", mail: [{ to: "lead", type: "done", subject: "shipped", outcome: "completed" }] },
      ],
    });

    // 1. run; Ctrl-C while the member is working
    const first = t.start(["run", "build the feature", "-p", "demo"]);
    await until(() => fs.existsSync(t.marker));
    first.child.kill("SIGINT");
    expect(await first.done).toBe(130);
    expect(listRunLocks(env.project().paths.root)).toEqual([]);
    expect(fs.existsSync(path.join(env.repo, "src/web/feature.txt"))).toBe(false); // the repo is never touched; the run works in its own worktrees

    // 2. the status of the interrupted run, as JSON
    const mid = JSON.parse(t.sync(["status", "-p", "demo", "--json"]).out);
    expect(mid.run).toMatchObject({ state: "ended", end_reason: "cancelled", outcome: "cancelled" });
    expect(mid.run.queue.map((q) => q.agent)).toEqual(["fe-member"]); // its task is still waiting

    // 3. resume: the member redoes the task, its files are brought into the repo, the lead finishes
    const resumed = t.sync(["resume", "-p", "demo"]);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toMatch(/outcome: completed/);
    expect(git(env.repo, "status", "--porcelain")).toBe(""); // the user's repo is untouched
    expect(git(env.repo, "rev-list", "--count", "HEAD")).toBe("1"); // HEAD untouched

    const end = JSON.parse(t.sync(["status", "-p", "demo", "--json"]).out);
    expect(end.run).toMatchObject({ state: "ended", end_reason: "done", outcome: "completed", outcome_verified: true });
    const id = end.run.run_id;
    expect(git(env.repo, "show", `agent-lyceum/${id}/lead:src/web/feature.txt`)).toBe("built properly"); // the member's files reached the lead's branch

    // 4. clear: preview, then do it
    const dry = t.sync(["clear", id, "-p", "demo", "--dry-run"]);
    expect(dry.code).toBe(1); // the lead's branch holds work that is not in the repo yet
    expect(dry.err + dry.out).toMatch(/lead has work that is not in the repo: src\/web\/feature\.txt/);
    expect(fs.existsSync(path.join(env.project().paths.runs, id))).toBe(true);
    git(env.repo, "merge", "--ff-only", `agent-lyceum/${id}/lead`); // the user brings it in
    const dry2 = t.sync(["clear", id, "-p", "demo", "--dry-run"]);
    expect(dry2.code).toBe(0);
    expect(dry2.out).toMatch(/would delete.*worktree and branch of fe-member/);
    expect(fs.existsSync(path.join(env.project().paths.runs, id))).toBe(true);

    const cleared = t.sync(["clear", id, "-p", "demo"]);
    expect(cleared.code).toBe(0);
    expect(fs.existsSync(path.join(env.project().paths.runs, id))).toBe(false);
    expect(git(env.repo, "branch", "--list", "agent-lyceum/*")).toBe("");
    expect(git(env.repo, "for-each-ref", "refs/agent-lyceum")).toBe("");
    expect(fs.readFileSync(path.join(env.repo, "src/web/feature.txt"), "utf8")).toBe("built properly\n"); // the integrated work stays
  }, 120_000);

  it("a worktree conflict ends the run blocked (exit 2), keeps the member's work, and clear refuses until told to keep it", () => {
    const t = setup({
      calls: [
        { agent: "lead", mail: [{ to: "fe-member", type: "task", subject: "edit a.txt" }] },
        { agent: "fe-member", writes: { "src/web/a.txt": "member version\n" }, mail: [{ to: "lead", subject: "edited" }] },
        { agent: "lead", mail: [{ to: "lead", type: "done", subject: "all good", outcome: "completed" }] },
      ],
    });
    // while the member works, the lead's worktree gets a different edit of the same file
    const script = JSON.parse(fs.readFileSync(t.scriptFile, "utf8"));
    script.calls[1].writeLead = { "src/web/a.txt": "lead's edit\n" };
    fs.writeFileSync(t.scriptFile, JSON.stringify(script));

    const r = t.sync(["run", "edit a.txt", "-p", "demo"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/outcome: blocked/);
    expect(r.out).toMatch(/fe-member.*agent-lyceum\//s);
    const id = JSON.parse(t.sync(["status", "-p", "demo", "--json"]).out).run.run_id;
    const leadFile = path.join(env.project().paths.root, "worktrees", id, "lead", "src/web/a.txt");
    expect(fs.readFileSync(leadFile, "utf8")).toBe("lead's edit\n"); // never overwritten
    const refused = t.sync(["clear", id, "-p", "demo"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/src\/web\/a\.txt/);
    expect(fs.existsSync(path.join(env.project().paths.runs, id))).toBe(true);

    const kept = t.sync(["clear", id, "-p", "demo", "--keep-worktrees"]);
    expect(kept.code).toBe(0);
    expect(git(env.repo, "branch", "--list", `agent-lyceum/${id}/fe-member`)).toContain("fe-member"); // the member's work is still there
  }, 120_000);

  it("refuses to start a checkout run while another checkout run holds the lock", () => {
    const t = setup({ calls: [] }, { git: false }); // not a git repo: the run would work in the checkout
    const lease = acquireProjectLock(env.project().paths.root, "other-run", { checkout: true });
    try {
      const r = t.sync(["run", "x", "-p", "demo"]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/other-run/);
      expect(r.err).toMatch(/only one can be active/);
    } finally {
      lease.release();
    }
  }, 60_000);

  it("resuming a legacy shared run is refused while another legacy shared run is active", async () => {
    const t = setup({ calls: [{ agent: "lead", sleep: true }, { agent: "lead", sleep: true }] }, { git: false });
    env.editProjectYaml((x) => x.replace("dispatcher:\n", "dispatcher:\n  max_concurrent_runs: 2\n"));
    const ids: string[] = [];
    for (const name of ["first", "second"]) {
      fs.rmSync(t.marker, { force: true });
      const r = t.start(["run", `task ${name}`, "-p", "demo", "--name", name]);
      await until(() => fs.existsSync(t.marker));
      r.child.kill("SIGINT");
      expect(await r.done).toBe(130);
    }
    const runs = env.project().paths.runs;
    for (const id of fs.readdirSync(runs)) {
      const file = path.join(runs, id, "state.json");
      const old = JSON.parse(fs.readFileSync(file, "utf8"));
      delete old.lead_workspace;
      old.workspace_mode = "shared"; // as an old binary wrote it
      fs.writeFileSync(file, JSON.stringify(old));
      ids.push(id);
    }
    expect(ids).toHaveLength(2);
    const first = ids.find((id) => JSON.parse(fs.readFileSync(path.join(runs, id, "state.json"), "utf8")).task_summary.includes("first"))!;
    const second = ids.find((id) => id !== first)!;
    const lease = acquireProjectLock(env.project().paths.root, first, { checkout: true }); // the first is resuming
    try {
      fs.rmSync(t.marker, { force: true });
      const r = t.sync(["resume", second, "-p", "demo"]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(new RegExp(`${first}[\\s\\S]*only one can be active`));
      expect(fs.existsSync(t.marker)).toBe(false); // no agent was woken
    } finally {
      lease.release();
    }
  }, 60_000);

  it("clear of a finished run goes ahead while another run is active, but not while that run itself is", () => {
    const t = setup({ calls: [{ agent: "lead", mail: [{ to: "lead", type: "done", subject: "shipped", outcome: "completed" }] }] });
    expect(t.sync(["run", "x", "-p", "demo"]).code).toBe(0);
    const id: string = JSON.parse(t.sync(["status", "-p", "demo", "--json"]).out).run.run_id;
    const root = env.project().paths.root;
    const runDir = path.join(env.project().paths.runs, id);

    const self = acquireProjectLock(root, id); // the run is alive (its process holds its lock)
    try {
      const refused = t.sync(["clear", id, "-p", "demo"]);
      expect(refused.code).toBe(1);
      expect(refused.err).toMatch(new RegExp(id));
      expect(fs.existsSync(runDir)).toBe(true); // nothing deleted
    } finally {
      self.release();
    }

    const other = acquireProjectLock(root, "other-run");
    try {
      const cleared = t.sync(["clear", id, "-p", "demo"]);
      expect(cleared.code).toBe(0);
      expect(fs.existsSync(runDir)).toBe(false);
    } finally {
      other.release();
    }
  }, 60_000);

  it("clear --lock names the lock, needs --force, and with several locks insists on a run id", () => {
    const t = setup({ calls: [] });
    const root = env.project().paths.root;
    const a = acquireProjectLock(root, "run-a", { checkout: false });
    const b = acquireProjectLock(root, "run-b", { checkout: false });
    try {
      const many = t.sync(["clear", "--lock", "-p", "demo", "--force"]);
      expect(many.code).toBe(1);
      expect(many.err).toMatch(/run-a/);
      expect(many.err).toMatch(/run-b/);
      expect(many.err).toMatch(/clear --lock <run-id>/);
      expect(listRunLocks(root)).toHaveLength(2);

      const noForce = t.sync(["clear", "--lock", "run-a", "-p", "demo"]);
      expect(noForce.code).toBe(1);
      expect(listRunLocks(root)).toHaveLength(2);

      const one = t.sync(["clear", "--lock", "run-a", "-p", "demo", "--force"]);
      expect(one.code).toBe(0);
      expect(listRunLocks(root).map((l) => l.run_id)).toEqual(["run-b"]);
    } finally {
      a.release();
      b.release();
    }
  }, 60_000);

  it("clear --lock <run-id> removes an unreadable per-run lock only with --force", () => {
    const t = setup({ calls: [] });
    const file = path.join(env.project().paths.root, "locks", "run-bad.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "garbage");
    const noId = t.sync(["clear", "--lock", "-p", "demo", "--force"]);
    expect(noId.code).toBe(1);
    expect(noId.err).toMatch(/clear --lock run-bad --force/);
    const refused = t.sync(["clear", "--lock", "run-bad", "-p", "demo"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/--force/);
    expect(fs.existsSync(file)).toBe(true);
    const done = t.sync(["clear", "--lock", "run-bad", "-p", "demo", "--force"]);
    expect(done.code).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  }, 60_000);
});

describe("run names", () => {
  const done = { agent: "lead", mail: [{ to: "lead", type: "done", subject: "shipped", outcome: "completed" }] };
  const names = (t: ReturnType<typeof setup>) => (JSON.parse(t.sync(["status", "-p", "demo", "--task-list", "--json"]).out).runs as { name?: string }[]).map((r) => r.name);

  it("a new run is named from its task, a second one gets -2, and --name sets it; a taken --name is refused", () => {
    const t = setup({ calls: [done, done, done] });
    const first = t.sync(["run", "Login with session\n\nmore", "-p", "demo"]);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/Run login-with-session \(\S+\) ended/);
    expect(t.sync(["run", "Login with session", "-p", "demo"]).code).toBe(0);
    expect(t.sync(["run", "x", "--name", "my-task", "-p", "demo"]).code).toBe(0);
    expect(names(t)).toEqual(["my-task", "login-with-session-2", "login-with-session"]);

    const dup = t.sync(["run", "x", "--name", "my-task", "-p", "demo"]);
    expect(dup.code).toBe(1);
    expect(dup.err).toMatch(/"my-task" already exists/);
    const bad = t.sync(["run", "x", "--name", "Bad Name", "-p", "demo"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/Invalid run name/);
    expect(names(t)).toHaveLength(3); // the refused runs left nothing behind
  }, 120_000);
});
