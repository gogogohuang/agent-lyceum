import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunSession } from "../src/run-session.js";
import { assertSupportedVersion, bindRunProject, loadRunState, newRunState, saveRunState, STATE_SCHEMA_VERSION, type RunState } from "../src/run-store.js";
import { inboxDir } from "../src/policy.js";
import { prepareTask } from "../src/task.js";
import { planWorkspace, type WorkspacePlan } from "../src/worktree.js";
import { initGitRepo, makeEnv, type TestEnv } from "./helpers.js";

// Checkout runs (the lead works in the project checkout on its own branch) are persisted as schema 4 and are never resumed
// when their task did not reach the lead.

let env: TestEnv;
afterEach(() => env?.cleanup());

const BRANCH = "agent-lyceum/run-1/lead";
const PLAN: WorkspacePlan = {
  mode: "worktree",
  leadWorktree: false,
  taskBranch: BRANCH,
  baseRef: "origin/main",
  baseSha: "a".repeat(40),
  originUrl: "git@example.com:o/r.git",
};

const stateFile = (runDir: string) => path.join(runDir, "state.json");
const rawState = (runDir: string) => JSON.parse(fs.readFileSync(stateFile(runDir), "utf8")) as Record<string, unknown>;

/** Starts a new run with `plan` (the constructor writes the state and delivers the task; nothing is woken). */
function start(plan: WorkspacePlan, runId = "run-1") {
  const project = env.project();
  const runDir = path.join(project.paths.runs, runId);
  const task = prepareTask({ text: "build the thing", cwd: env.root, runDir });
  const session = new RunSession({ project, plan, task, runDir, log: () => {}, invoker: async () => ({ ok: true, text: "", exitCode: 0, timedOut: false }) });
  return { project, runDir, session };
}

function resumeOf(runDir: string, state: RunState = loadRunState(runDir)) {
  const project = env.project();
  const plan = planWorkspace(project, state);
  return new RunSession({ project, plan, resume: state, runDir, log: () => {}, invoker: async () => ({ ok: true, text: "", exitCode: 0, timedOut: false }) });
}

describe("state schema 4", () => {
  it("is the newest version this build reads; a v5 state is refused; a new non-checkout run is still v2", () => {
    expect(STATE_SCHEMA_VERSION).toBe(4);
    expect(() => assertSupportedVersion(4, 3, "state.json")).toThrow(/schema_version 4/);
    expect(() => assertSupportedVersion(5, 4, "state.json")).toThrow(/schema_version 5/);
    expect(() => assertSupportedVersion(4, 4, "state.json")).not.toThrow();
    expect(newRunState({ run_id: "r" }).schema_version).toBe(2);
  });
});

describe("a new checkout run", () => {
  it("is written as schema 4 in mode checkout, with its branch and base, and task_sent only once the task is in the lead's inbox", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const { project, runDir } = start(PLAN);
    const s = rawState(runDir);
    expect(s).toMatchObject({
      schema_version: 4,
      workspace_mode: "checkout",
      task_branch: BRANCH,
      base_ref: "origin/main",
      base_sha: PLAN.baseSha,
      origin_url: PLAN.originUrl,
      task_sent: true,
    });
    expect(s.lead_workspace).toBeUndefined();
    expect(fs.readdirSync(inboxDir(bindRunProject(project, runDir, "run"), project.lead)).length).toBeGreaterThan(0);
    expect(loadRunState(runDir).task_sent).toBe(true);
  });

  it("task_sent is set after the task was delivered, never before", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "build the thing", cwd: env.root, runDir });
    const bound = bindRunProject(project, runDir, "run");
    const seen: { inbox: number; sent: unknown }[] = [];
    const real = fs.writeFileSync;
    // Whatever writes state.json, record what the lead's inbox held at that moment.
    const spy = (file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      if (typeof file === "string" && file.includes("state.json")) {
        const inbox = fs.existsSync(inboxDir(bound, project.lead)) ? fs.readdirSync(inboxDir(bound, project.lead)).filter((f) => f.endsWith(".md")).length : 0;
        seen.push({ inbox, sent: JSON.parse(String(data)).task_sent });
      }
      return (real as (...a: unknown[]) => void)(file, data, ...rest);
    };
    (fs as { writeFileSync: unknown }).writeFileSync = spy;
    try {
      new RunSession({ project, plan: PLAN, task, runDir, log: () => {}, invoker: async () => ({ ok: true, text: "", exitCode: 0, timedOut: false }) });
    } finally {
      (fs as { writeFileSync: unknown }).writeFileSync = real;
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const w of seen) if (w.sent === true) expect(w.inbox).toBeGreaterThan(0);
    expect(seen.at(-1)?.sent).toBe(true);
  });

  it("a new run without a task branch keeps its mode and schema 2, and has no task_sent", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const { runDir } = start({ mode: "worktree", leadWorktree: true });
    const s = rawState(runDir);
    expect(s).toMatchObject({ schema_version: 2, workspace_mode: "worktree", lead_workspace: true });
    expect(s).not.toHaveProperty("task_sent");
    expect(s).not.toHaveProperty("task_branch");
  });
});

describe("resuming a checkout run", () => {
  it("keeps mode checkout, schema 4 and every checkout field", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const { runDir } = start(PLAN);
    const written = { ...loadRunState(runDir), checkout_from: "main" };
    saveRunState(runDir, written);
    resumeOf(runDir);
    expect(rawState(runDir)).toMatchObject({
      schema_version: 4,
      workspace_mode: "checkout",
      task_branch: BRANCH,
      base_ref: "origin/main",
      base_sha: PLAN.baseSha,
      origin_url: PLAN.originUrl,
      checkout_from: "main",
      task_sent: true,
    });
  });

  it("is refused when task_sent is missing: the error names the branch and end_reason stays untouched", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const { runDir } = start(PLAN);
    const state = loadRunState(runDir);
    delete state.task_sent;
    state.end_reason = "cancelled";
    saveRunState(runDir, state);
    const before = fs.readFileSync(stateFile(runDir), "utf8");
    expect(() => resumeOf(runDir, state)).toThrow(/task_branch/);
    expect(() => resumeOf(runDir, state)).toThrow(BRANCH);
    expect(fs.readFileSync(stateFile(runDir), "utf8")).toBe(before);
    expect(rawState(runDir).end_reason).toBe("cancelled");
  });

  it("keeps using the recorded task branch after project.yaml renames the lead", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const { runDir } = start(PLAN);
    env.editProjectYaml((t) => t.replace("lead: lead", "lead: fe-member"));
    expect(env.project().lead).toBe("fe-member");

    const ok = loadRunState(runDir);
    resumeOf(runDir, ok);
    expect(rawState(runDir).task_branch).toBe(BRANCH);

    const missing = loadRunState(runDir);
    delete missing.task_sent;
    expect(() => resumeOf(runDir, missing)).toThrow(BRANCH);
  });

  it("a worktree or shared run is resumed as before, with no task_sent requirement", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const { runDir } = start({ mode: "worktree", leadWorktree: false });
    const state = loadRunState(runDir);
    expect(state.task_sent).toBeUndefined();
    resumeOf(runDir, state);
    expect(rawState(runDir)).toMatchObject({ schema_version: 2, workspace_mode: "worktree" });
  });
});

describe("opening instances", () => {
  const enable = (session: RunSession, role: string) => (session as unknown as { routing(): { enable(role: string): void } }).routing().enable(role);

  it("on a schema 4 state keeps 4 and still writes the slot table", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const { runDir, session } = start(PLAN);
    enable(session, "fe-member");
    expect(rawState(runDir)).toMatchObject({ schema_version: 4, instances: { roles: { "fe-member": ["fe-member"] } } });
  });

  it("on a schema 2 state still makes it 3", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const { runDir, session } = start({ mode: "worktree", leadWorktree: true });
    expect(rawState(runDir).schema_version).toBe(2);
    enable(session, "fe-member");
    expect(rawState(runDir)).toMatchObject({ schema_version: 3, instances: { roles: { "fe-member": ["fe-member"] } } });
  });
});

describe("starting a checkout run (the branch is cut after the state is written, before the task is sent)", () => {
  const BR = "agent-lyceum/run-1/lead";
  const hook = (name: string, body: string) => {
    const f = path.join(env.repo, ".git", "hooks", name);
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(f, 0o755);
  };
  const setup = () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const sha = execFileSync("git", ["-C", env.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "build the thing", cwd: env.root, runDir });
    const plan: WorkspacePlan = { mode: "worktree", leadWorktree: false, taskBranch: BR, baseRef: "origin/main", baseSha: sha, checkoutFrom: "main" };
    const begin = () => new RunSession({ project, plan, task, runDir, startCheckout: true, log: () => {}, invoker: async () => ({ ok: true, text: "", exitCode: 0, timedOut: false }) });
    return { project, runDir, sha, begin };
  };
  const branch = () => execFileSync("git", ["-C", env.repo, "branch", "--show-current"], { encoding: "utf8" }).trim();

  it("saves the schema 4 state (task_branch, checkout_from, no task_sent) before git switches; task_sent only after the task is delivered", () => {
    const { runDir, sha, begin } = setup();
    const seen = path.join(env.root, "state-at-checkout.json");
    hook("post-checkout", `cp "${stateFile(runDir)}" "${seen}"`);
    begin();
    expect(JSON.parse(fs.readFileSync(seen, "utf8"))).toMatchObject({ schema_version: 4, workspace_mode: "checkout", task_branch: BR, checkout_from: "main", base_sha: sha });
    expect(JSON.parse(fs.readFileSync(seen, "utf8"))).not.toHaveProperty("task_sent");
    expect(branch()).toBe(BR);
    expect(rawState(runDir)).toMatchObject({ task_branch: BR, checkout_from: "main", task_sent: true });
  });

  it("an existing task branch: the start throws, the run dir is gone, HEAD stays", () => {
    const { runDir, sha, begin } = setup();
    execFileSync("git", ["-C", env.repo, "branch", BR, sha]);
    expect(begin).toThrow(BR);
    expect(fs.existsSync(runDir)).toBe(false);
    expect(branch()).toBe("main");
  });

  it("HEAD did not move: the start throws and the whole run dir is gone", () => {
    const { runDir, begin } = setup();
    hook("reference-transaction", '[ "$1" = prepared ] && exit 1\nexit 0');
    expect(begin).toThrow(/HEAD did not move/);
    expect(fs.existsSync(runDir)).toBe(false);
    expect(branch()).toBe("main");
  });

  it("a failure after the switch and before the task is sent puts the checkout back and removes the branch and the run dir", () => {
    const { runDir, begin } = setup();
    fs.writeFileSync(path.join(runDir, "snapshots"), "in the way"); // the snapshot step runs after the switch and cannot make its folder
    expect(begin).toThrow();
    expect(branch()).toBe("main");
    expect(execFileSync("git", ["-C", env.repo, "branch", "--list", BR], { encoding: "utf8" })).toBe("");
    expect(fs.existsSync(runDir)).toBe(false);
  });

  it("a checkout that cannot be put back keeps its state and HEAD, and the error names both the failure and the branches", () => {
    const { runDir, begin } = setup();
    fs.writeFileSync(path.join(runDir, "snapshots"), "in the way");
    hook("post-checkout", `[ "$3" = 1 ] && [ -e "${runDir}/snapshots" ] && git branch -D main >/dev/null 2>&1; exit 0`);
    expect(begin).toThrow(new RegExp(`${BR}[\\s\\S]*main|main[\\s\\S]*${BR}`));
    expect(branch()).toBe(BR);
    expect(fs.existsSync(stateFile(runDir))).toBe(true);
  });
});

describe("what a new run tells the user", () => {
  const WORKTREE: WorkspacePlan = { mode: "worktree", leadWorktree: true };
  const begin = (plan: WorkspacePlan) => {
    env?.cleanup();
    env = makeEnv();
    initGitRepo(env.repo);
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "build the thing", cwd: env.root, runDir });
    const said: string[] = [];
    new RunSession({ project, plan, task, runDir, log: (s) => said.push(s), invoker: async () => ({ ok: true, text: "", exitCode: 0, timedOut: false }) });
    const events = fs.readFileSync(path.join(runDir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    return { project, said, events, out: said.join("\n") };
  };

  it("a checkout run says which ref and sha it starts from and that the lead works in the project folder on the task branch, and logs it", () => {
    const { project, said, events } = begin(PLAN);
    const line = said.find((l) => l.includes("starting from"));
    expect(line).toBe(`  starting from origin/main ${"a".repeat(8)}; ${project.lead} works in the project folder ${project.dir} on branch ${BRANCH}`);
    expect(events.find((e) => e.event === "checkout-start")).toMatchObject({ ref: "origin/main", sha: PLAN.baseSha, branch: BRANCH, dir: project.dir });
  });

  it("a worktree run does not get the checkout line", () => {
    const { events, out } = begin(WORKTREE);
    expect(out).not.toContain("works in the project folder");
    expect(events.some((e) => e.event === "checkout-start")).toBe(false);
  });

  it("prints one line when the fetch of origin failed, and goes on", () => {
    const { said } = begin({ ...WORKTREE, fetchFailed: true });
    expect(said.filter((l) => l.includes("git fetch origin"))).toEqual(["  git fetch origin failed or timed out; using the remote refs already in the repo"]);
    expect(begin(WORKTREE).out).not.toContain("git fetch origin");
    expect(begin({ ...PLAN, fetchFailed: true }).said.filter((l) => l.includes("git fetch origin"))).toHaveLength(1);
  });

  it("prints why a worktree run has no remote base, as it does for a shared one", () => {
    const reason = "no remote base: origin/HEAD, origin/main and origin/master are all missing";
    const { project, said } = begin({ ...WORKTREE, reason });
    expect(said).toContain(`  ${project.lead} works in its own git worktree (${reason})`);
    expect(begin(WORKTREE).out).not.toContain("its own git worktree (");
  });

  it("logs the reason of a fallback to a worktree once the state exists, and does not repeat it on screen", () => {
    const reason = "the project checkout is in use by another run";
    const { said, events } = begin({ ...WORKTREE, lockFallback: reason });
    expect(events.find((e) => e.event === "workspace-fallback")).toMatchObject({ reason });
    expect(said.join("\n")).not.toContain(reason); // the CLI already printed it on stderr
  });
});
