import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, initGitRepo, makeEnv, makeParallel, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

let env: TestEnv;
afterEach(() => env?.cleanup());

/** The whole tool, as a user runs it: the real CLI on the real dispatcher, with a scripted stand-in for `claude`. */
function setup(script: object) {
  env = makeEnv();
  initGitRepo(env.repo);
  makeParallel(env);
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
    expect(fs.existsSync(path.join(env.project().paths.root, "lock.json"))).toBe(false);
    expect(fs.existsSync(path.join(env.repo, "src/web/feature.txt"))).toBe(false); // nothing reached the repo from the cancelled wake-up

    // 2. the status of the interrupted run, as JSON
    const mid = JSON.parse(t.sync(["status", "-p", "demo", "--json"]).out);
    expect(mid.run).toMatchObject({ state: "ended", end_reason: "cancelled", outcome: "cancelled" });
    expect(mid.run.queue.map((q) => q.agent)).toEqual(["fe-member"]); // its task is still waiting

    // 3. resume: the member redoes the task, its files are brought into the repo, the lead finishes
    const resumed = t.sync(["resume", "-p", "demo"]);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toMatch(/outcome: completed/);
    expect(fs.readFileSync(path.join(env.repo, "src/web/feature.txt"), "utf8")).toBe("built properly\n");
    expect(git(env.repo, "status", "--porcelain")).toBe("?? src/web/feature.txt"); // the user's repo: one new file, nothing staged
    expect(git(env.repo, "rev-list", "--count", "HEAD")).toBe("1"); // HEAD untouched

    const end = JSON.parse(t.sync(["status", "-p", "demo", "--json"]).out);
    expect(end.run).toMatchObject({ state: "ended", end_reason: "done", outcome: "completed", outcome_verified: true });
    const id = end.run.run_id;

    // 4. clear: preview, then do it
    const dry = t.sync(["clear", id, "-p", "demo", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/would delete.*worktree and branch of fe-member/);
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
    // while the member works, someone else edits the same file in the real repo
    const script = JSON.parse(fs.readFileSync(t.scriptFile, "utf8"));
    script.calls[1].writeAbs = { [path.join(env.repo, "src/web/a.txt")]: "someone else's edit\n" };
    fs.writeFileSync(t.scriptFile, JSON.stringify(script));

    const r = t.sync(["run", "edit a.txt", "-p", "demo"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/outcome: blocked/);
    expect(r.out).toMatch(/fe-member.*agent-lyceum\//s);
    expect(fs.readFileSync(path.join(env.repo, "src/web/a.txt"), "utf8")).toBe("someone else's edit\n"); // never overwritten

    const id = JSON.parse(t.sync(["status", "-p", "demo", "--json"]).out).run.run_id;
    const refused = t.sync(["clear", id, "-p", "demo"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/src\/web\/a\.txt/);
    expect(fs.existsSync(path.join(env.project().paths.runs, id))).toBe(true);

    const kept = t.sync(["clear", id, "-p", "demo", "--keep-worktrees"]);
    expect(kept.code).toBe(0);
    expect(git(env.repo, "branch", "--list", `agent-lyceum/${id}/fe-member`)).toContain("fe-member"); // the member's work is still there
  }, 120_000);
});
