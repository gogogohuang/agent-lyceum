import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedProject } from "../src/config.js";
import { runTeam } from "../src/dispatcher.js";
import { loadRunState } from "../src/run-store.js";
import { outboxDir } from "../src/policy.js";
import { prepareTask } from "../src/task.js";
import {
  type AgentWorkspace,
  type ChangeSet,
  collectAgentChanges,
  commitWorkspace,
  assertWorktreeRunnable,
  planWorkspace,
  existingAgentWorkspace,
  finishLeadBranch,
  inspectWorkspace,
  integrateAgentChanges,
  prepareAgentWorkspace,
  snapshotBase,
  snapshotHead,
} from "../src/worktree.js";
import { git, initGitRepo, makeConcurrent, makeEnv, makeParallel, withSections, write, type TestEnv } from "./helpers.js";

// Every attack here plants something an agent may write (its worktree, or its own git dir under `.git/worktrees/`) so that
// git would run a program — or write a file — outside the sandbox. The control drives the same planted worktree with plain git,
// as the dispatcher used to, and sees the marker appear; the dispatcher's functions must not.

const posixOnly = process.platform === "win32";
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
let env: TestEnv;

beforeEach(() => {
  // The user's own git config (hooksPath, fsmonitor, ...) must not decide the outcome.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterEach(() => {
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  env?.cleanup();
});

const IDENTITY = { GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" };

interface Scene {
  p: ResolvedProject;
  lead: AgentWorkspace;
  member: AgentWorkspace;
  /** Where the attacker keeps its fake git dirs and scripts. */
  scratch: string;
  /** Written by every planted program. */
  marker: string;
  /** A file outside the sandbox that a planted symlink points at. */
  victim: string;
}

/** A concurrent run: the lead's worktree (with an uncommitted file), a snapshot of it, and a member's worktree with a new file. */
function scene(): Scene {
  env = makeEnv();
  initGitRepo(env.repo);
  const remote = path.join(env.root, "remote.git");
  git(env.root, "init", "-q", "--bare", remote);
  git(env.repo, "remote", "add", "origin", remote);
  git(env.repo, "push", "-q", "origin", "main");
  makeConcurrent(env, 2);
  const p = env.project();
  const lead = prepareAgentWorkspace(p, "run-1", "lead", snapshotHead(p, "run-1"));
  write(path.join(lead.dir, "src/web/lead-note.txt"), "lead was here\n");
  const member = prepareAgentWorkspace(p, "run-1", "fe-member", snapshotBase(p, "run-1", 1, lead));
  write(path.join(member.dir, "src/web/feature.txt"), "built\n");
  const scratch = path.join(env.root, "attacker");
  fs.mkdirSync(scratch);
  const victim = path.join(env.root, "victim.txt");
  fs.writeFileSync(victim, "precious\n");
  return { p, lead, member, scratch, marker: path.join(env.root, "MARKER"), victim };
}

const attacked = (s: Scene): boolean => fs.existsSync(s.marker) || fs.readFileSync(s.victim, "utf8") !== "precious\n";

/** A script that records that it ran. */
function markerScript(s: Scene): string {
  const f = path.join(s.scratch, "run-marker.sh");
  fs.writeFileSync(f, `#!/bin/sh\necho "ran $*" >> ${JSON.stringify(s.marker)}\nexit 0\n`, { mode: 0o755 });
  return f;
}

/** A clean/smudge filter that records that it ran and passes the content through (git fails a filter that eats it). */
function filterScript(s: Scene): string {
  const f = path.join(s.scratch, "run-filter.sh");
  fs.writeFileSync(f, `#!/bin/sh\necho "filter $*" >> ${JSON.stringify(s.marker)}\nexec cat\n`, { mode: 0o755 });
  return f;
}

/** Config that makes git run a program in each of the ways the commands we use could: fsmonitor, external diff, textconv, filters, signing. */
function plantedConfig(s: Scene): string {
  const mark = markerScript(s);
  const filter = filterScript(s);
  return [
    `[core]\n\tfsmonitor = ${mark}`,
    `[diff]\n\texternal = ${mark}`,
    `[diff "t"]\n\ttextconv = ${mark}`,
    `[filter "x"]\n\tclean = ${filter}\n\tsmudge = ${filter}`,
    `[commit]\n\tgpgsign = true`,
    `[gpg]\n\tprogram = ${mark}`,
    "",
  ].join("\n");
}

/** A copy of the repository's common dir with the planted config, hooks and attributes in it. */
function fakeCommonDir(ws: AgentWorkspace, s: Scene): string {
  const fake = path.join(s.scratch, `fake-common-${ws.agent}`);
  fs.cpSync(ws.commonDir, fake, { recursive: true });
  fs.appendFileSync(path.join(fake, "config"), `\n${plantedConfig(s)}`);
  fs.mkdirSync(path.join(fake, "hooks"), { recursive: true });
  for (const h of ["post-commit", "post-checkout", "post-merge", "post-index-change", "pre-auto-gc", "reference-transaction"]) fs.copyFileSync(markerScript(s), path.join(fake, "hooks", h));
  fs.mkdirSync(path.join(fake, "info"), { recursive: true });
  fs.writeFileSync(path.join(fake, "info", "attributes"), "* filter=x diff=t\n");
  return fake;
}

/** A git repository inside the worktree whose own config runs the marker (fsmonitor) and a filter on a file git must re-hash. */
function nestedRepo(ws: AgentWorkspace, s: Scene, at = "src/web/sub"): string {
  const sub = path.join(ws.root, at);
  fs.mkdirSync(sub, { recursive: true });
  git(sub, "init", "-q");
  write(path.join(sub, ".gitattributes"), "* filter=x\n");
  write(path.join(sub, "s.txt"), "s\n");
  git(sub, "add", "-A");
  git(sub, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "s");
  fs.appendFileSync(path.join(sub, ".git", "config"), `\n[core]\n\tfsmonitor = ${markerScript(s)}\n[filter "x"]\n\tclean = ${filterScript(s)}\n`);
  // same size, different time: git has to hash it again, through the filter
  fs.writeFileSync(path.join(sub, "s.txt"), "t\n");
  fs.utimesSync(path.join(sub, "s.txt"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  return sub;
}

interface Variant {
  name: string;
  plant: (ws: AgentWorkspace, s: Scene) => void;
  /** `refused`: the dispatcher refuses to touch the worktree. `same`: it works exactly as without the attack. */
  outcome: "refused" | "same";
}

const VARIANTS: Variant[] = [
  {
    // Pinning GIT_COMMON_DIR keeps git from reading the fake config and hooks, but git's ref store still follows `commondir`
    // (refs would be read from and written to the fake dir), so the dispatcher refuses such a worktree.
    name: "A: commondir points at a fake common dir (config, hooks, attributes, diff.external)",
    outcome: "refused",
    plant: (ws, s) => fs.writeFileSync(path.join(ws.gitDir, "commondir"), `${fakeCommonDir(ws, s)}\n`),
  },
  {
    name: "B: the worktree's .git pointer names a fake git dir (whose commondir is a fake common dir)",
    outcome: "same",
    plant: (ws, s) => {
      const fakeGit = path.join(s.scratch, `fake-gitdir-${ws.agent}`);
      fs.cpSync(ws.gitDir, fakeGit, { recursive: true });
      fs.writeFileSync(path.join(fakeGit, "commondir"), `${fakeCommonDir(ws, s)}\n`);
      fs.writeFileSync(path.join(ws.root, ".git"), `gitdir: ${fakeGit}\n`);
    },
  },
  {
    // -c core.fsmonitor/core.hooksPath would beat it, but a config.worktree can also name filters (picked by the worktree's own
    // .gitattributes) and a signing program, which no -c list can cover: such a worktree is refused.
    name: "C: extensions.worktreeConfig is on and the agent writes config.worktree (fsmonitor, hooksPath, filters, diff.external)",
    outcome: "refused",
    plant: (ws, s) => {
      git(env.repo, "config", "extensions.worktreeConfig", "true"); // the user's own (trusted) setting
      const hooks = path.join(s.scratch, `hooks-${ws.agent}`);
      fs.mkdirSync(hooks, { recursive: true });
      for (const h of ["post-commit", "post-checkout", "reference-transaction"]) fs.copyFileSync(markerScript(s), path.join(hooks, h));
      fs.writeFileSync(path.join(ws.gitDir, "config.worktree"), `${plantedConfig(s)}[core]\n\thooksPath = ${hooks}\n`);
      fs.writeFileSync(path.join(ws.root, ".gitattributes"), "* filter=x diff=t\n");
    },
  },
  {
    // git status / add can visit a nested repository registered as a gitlink and run git there with that repo's own config
    // (seen with add -A even with diff.ignoreSubmodules=dirty): such a worktree is refused before anything walks the tree.
    name: "E: a nested repository the agent registered in its own index carries its own fsmonitor and filter",
    outcome: "refused",
    plant: (ws, s) => {
      const sub = nestedRepo(ws, s);
      git(ws.root, "add", path.relative(ws.root, sub)); // the agent may register it in its own index
    },
  },
  {
    name: "E2: an untracked nested repository carries its own fsmonitor and filter",
    outcome: "refused",
    plant: (ws, s) => {
      nestedRepo(ws, s);
    },
  },
  {
    // Not code, but a write outside the sandbox: git writes COMMIT_EDITMSG and appends to logs/HEAD through a symlink.
    name: "F: COMMIT_EDITMSG and logs/HEAD in the worktree's git dir are symlinks to a file outside the sandbox",
    outcome: "refused",
    plant: (ws, s) => {
      fs.rmSync(path.join(ws.gitDir, "COMMIT_EDITMSG"), { force: true });
      fs.symlinkSync(s.victim, path.join(ws.gitDir, "COMMIT_EDITMSG"));
      fs.rmSync(path.join(ws.gitDir, "logs", "HEAD"), { force: true });
      fs.symlinkSync(s.victim, path.join(ws.gitDir, "logs", "HEAD"));
    },
  },
];

/**
 * Plain git in the worktree, the way the dispatcher ran it before: it discovers the git dir from the worktree.
 * The controls use it, so they prove each attack works against git; they do not prove that each subject function was vulnerable before the fix.
 */
function plainGit(ws: AgentWorkspace, ...args: string[]): void {
  try {
    execFileSync("git", args, { cwd: ws.root, env: { ...process.env, ...IDENTITY }, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    /* a command may fail (e.g. signing); whether the planted program ran is what counts */
  }
}

interface Subject {
  name: string;
  /** The workspaces the function runs git in (they get planted). */
  targets: (s: Scene) => AgentWorkspace[];
  /** Setup before the attack. */
  prep?: (s: Scene) => unknown;
  run: (s: Scene, prepared: unknown) => unknown;
  /** The result when nothing was planted. */
  check: (s: Scene, result: unknown) => void;
  /** What a refusal looks like. */
  refused: (s: Scene, run: () => unknown) => void;
}

const throwsRefusal = (_s: Scene, run: () => unknown) => expect(run).toThrow(/Refusing to run git/);

const SUBJECTS: Subject[] = [
  {
    name: "commitWorkspace",
    targets: (s) => [s.member],
    run: (s) => commitWorkspace(s.member, "agent-lyceum: changes by fe-member"),
    check: (s, r) => {
      const res = r as { head: string; committed: boolean };
      expect(res.committed).toBe(true);
      expect(git(env.repo, "rev-parse", s.member.branch)).toBe(res.head);
      expect(git(env.repo, "show", `${s.member.branch}:src/web/feature.txt`)).toBe("built");
    },
    refused: throwsRefusal,
  },
  {
    name: "collectAgentChanges",
    targets: (s) => [s.member],
    run: (s) => collectAgentChanges(s.member, ["src/web/**"]),
    check: (_s, r) => {
      const c = r as ChangeSet;
      expect(c.files).toEqual([{ path: "src/web/feature.txt", status: "A", mode: "100644" }]);
      expect(c.violations).toEqual([]);
    },
    refused: throwsRefusal,
  },
  {
    name: "inspectWorkspace (member, compared with the lead's worktree)",
    targets: (s) => [s.member, s.lead],
    prep: (s) => commitWorkspace(s.member, "m"), // committed but not in the lead's worktree: the lead's worktree is consulted
    run: (s) => inspectWorkspace(s.p, "run-1", "fe-member", s.lead),
    check: (_s, r) => {
      const w = r as { dirty: string[]; unintegrated: string[]; unknown?: string };
      expect(w.unknown).toBeUndefined();
      expect(w.dirty).toEqual([]);
      expect(w.unintegrated).toEqual(["src/web/feature.txt"]);
    },
    refused: (_s, run) => expect((run() as { unknown?: string }).unknown).toMatch(/Refusing to run git/),
  },
  {
    name: "finishLeadBranch",
    targets: (s) => [s.lead],
    run: (s) => finishLeadBranch(s.lead, "lead's work", path.join(env.root, "lead.patch")),
    check: (s, r) => {
      expect((r as { files: number }).files).toBe(1);
      expect(git(env.repo, "show", `${s.lead.branch}:src/web/lead-note.txt`)).toBe("lead was here");
      expect(fs.readFileSync(path.join(env.root, "lead.patch"), "utf8")).toContain("src/web/lead-note.txt");
    },
    refused: throwsRefusal,
  },
  {
    name: "prepareAgentWorkspace (an existing, clean worktree moved to a newer snapshot)",
    targets: (s) => [s.member],
    prep: (s) => {
      fs.rmSync(path.join(s.member.dir, "src/web/feature.txt"));
      write(path.join(s.lead.dir, "src/web/later.txt"), "later\n");
      return snapshotBase(s.p, "run-1", 2, s.lead);
    },
    run: (s, ref) => prepareAgentWorkspace(s.p, "run-1", "fe-member", ref as string),
    check: (s, r) => {
      expect((r as AgentWorkspace).base).toBe(git(env.repo, "rev-parse", "refs/agent-lyceum/run-1/base-2"));
      expect(fs.readFileSync(path.join(s.member.dir, "src/web/later.txt"), "utf8")).toBe("later\n");
    },
    refused: throwsRefusal,
  },
  {
    name: "integrateAgentChanges (into the lead's worktree)",
    targets: (s) => [s.lead],
    prep: (s) => collectAgentChanges(s.member, ["src/web/**"]),
    run: (s, changes) => integrateAgentChanges(s.p, changes as ChangeSet, s.lead),
    check: (s, r) => {
      expect((r as { status: string }).status).toBe("integrated");
      expect(fs.readFileSync(path.join(s.lead.dir, "src/web/feature.txt"), "utf8")).toBe("built\n");
      expect(fs.existsSync(path.join(env.repo, "src/web/feature.txt"))).toBe(false);
    },
    refused: throwsRefusal,
  },
  {
    name: "snapshotBase (from the lead's worktree)",
    targets: (s) => [s.lead],
    run: (s) => snapshotBase(s.p, "run-1", 2, s.lead),
    check: (_s, r) => {
      expect(r).toBe("refs/agent-lyceum/run-1/base-2");
      expect(git(env.repo, "show", "refs/agent-lyceum/run-1/base-2:src/web/lead-note.txt")).toBe("lead was here");
    },
    refused: throwsRefusal,
  },
];

describe.each(VARIANTS)("$name", (v) => {
  it.skipIf(posixOnly)("control: plain git in the planted worktree runs the planted program (or writes through the planted link)", () => {
    const s = scene();
    v.plant(s.member, s);
    plainGit(s.member, "status", "--porcelain");
    plainGit(s.member, "add", "-A");
    plainGit(s.member, "commit", "-q", "--no-verify", "-m", "control");
    plainGit(s.member, "status", "--porcelain");
    expect(attacked(s)).toBe(true);
  });

  it.skipIf(posixOnly).each(SUBJECTS)("$name does not run it", (subj) => {
    const s = scene();
    const prepared = subj.prep?.(s);
    for (const ws of subj.targets(s)) v.plant(ws, s);
    if (v.outcome === "refused") subj.refused(s, () => subj.run(s, prepared));
    else subj.check(s, subj.run(s, prepared));
    expect(fs.existsSync(s.marker) ? fs.readFileSync(s.marker, "utf8") : "").toBe("");
    expect(fs.readFileSync(s.victim, "utf8")).toBe("precious\n");
  });
});

describe("the same functions with nothing planted", () => {
  it.each(SUBJECTS)("$name", (subj) => {
    const s = scene();
    const prepared = subj.prep?.(s);
    subj.check(s, subj.run(s, prepared));
    expect(attacked(s)).toBe(false);
  });
});

describe("where the git dir comes from", () => {
  const metaOf = (ws: AgentWorkspace) => `${ws.root}.json`;
  const readMeta = (ws: AgentWorkspace) => JSON.parse(fs.readFileSync(metaOf(ws), "utf8")) as Record<string, unknown>;

  it("is recorded in the workspace meta when the worktree is created, and only read from there afterwards", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const p = env.project();
    const ws = prepareAgentWorkspace(p, "run-1", "fe-member", snapshotBase(p, "run-1", 1));
    const meta = readMeta(ws);
    expect(meta.gitDir).toBe(ws.gitDir);
    expect(meta.commonDir).toBe(ws.commonDir);
    expect(fs.realpathSync(ws.gitDir)).toBe(fs.realpathSync(git(ws.root, "rev-parse", "--absolute-git-dir")));
    expect(fs.realpathSync(ws.commonDir)).toBe(fs.realpathSync(path.join(env.repo, ".git")));

    // the worktree's own pointer is never consulted again
    fs.writeFileSync(path.join(ws.root, ".git"), `gitdir: ${path.join(env.root, "elsewhere")}\n`);
    expect(existingAgentWorkspace(p, "run-1", "fe-member")?.gitDir).toBe(ws.gitDir);
    expect(prepareAgentWorkspace(p, "run-1", "fe-member", "refs/agent-lyceum/run-1/base-1").gitDir).toBe(ws.gitDir);
  });

  function legacy() {
    env = makeEnv();
    initGitRepo(env.repo);
    const p = env.project();
    const ref = snapshotBase(p, "run-1", 1);
    const fe = prepareAgentWorkspace(p, "run-1", "fe-member", ref);
    const qa = prepareAgentWorkspace(p, "run-1", "qa-member", ref);
    for (const ws of [fe, qa]) {
      const { gitDir: _g, commonDir: _c, ...old } = readMeta(ws);
      fs.writeFileSync(metaOf(ws), JSON.stringify(old, null, 2));
    }
    return { p, fe, qa };
  }

  it("for a worktree made by an older version, is found when exactly one git dir names it, and written back", () => {
    const { p, fe } = legacy();
    const again = existingAgentWorkspace(p, "run-1", "fe-member");
    expect(again?.gitDir).toBe(fe.gitDir);
    expect(again?.commonDir).toBe(fe.commonDir);
    expect(readMeta(fe).gitDir).toBe(fe.gitDir);
  });

  it("for a worktree made by an older version, is refused when two git dirs claim it", () => {
    const { p, fe, qa } = legacy();
    fs.writeFileSync(path.join(qa.gitDir, "gitdir"), fs.readFileSync(path.join(fe.gitDir, "gitdir")));
    expect(() => existingAgentWorkspace(p, "run-1", "fe-member")).toThrow(/2 git dirs/);
  });

  it("for a worktree made by an older version, is refused when no git dir claims it", () => {
    const { p, fe } = legacy();
    fs.writeFileSync(path.join(fe.gitDir, "gitdir"), `${path.join(env.root, "nowhere", ".git")}\n`);
    expect(() => existingAgentWorkspace(p, "run-1", "fe-member")).toThrow(/0 git dirs/);
    expect(inspectWorkspace(p, "run-1", "fe-member")?.unknown).toMatch(/0 git dirs/);
  });
});

describe("a folder that is not a git repository (shared mode)", () => {
  it("prints its start line, makes no worktree, so nothing goes through agentGit, and completes", async () => {
    env = makeEnv();
    const project = env.project();
    const lines: string[] = [];
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    const seen: (string | undefined)[] = [];
    const s = await runTeam({
      project,
      task,
      runDir,
      log: (l) => lines.push(l),
      invoker: async (i) => {
        seen.push(i.workspace?.root);
        write(path.join(outboxDir(i.project, i.agent.name), "d.md"), "---\nto: lead\ntype: done\nsubject: d\noutcome: partial\n---\n\n## Result\nx\n\n## Not done\nx\n");
        return { ok: true, text: "", exitCode: 0, timedOut: false };
      },
    });
    expect(s.endReason).toBe("done");
    expect(seen).toEqual([undefined]);
    expect(lines.join("\n")).toContain(`agents take turns in ${project.dir} (no separate git worktrees: not a git repository)`);
    // agentGit only takes an AgentWorkspace, and those only exist for a worktree
    expect(fs.existsSync(path.join(project.paths.root, "worktrees"))).toBe(false);
    expect(fs.existsSync(path.join(env.repo, ".git", "worktrees"))).toBe(false);
  });
});

describe("submodules the user's repo really has", () => {
  /** A repo whose commit has a submodule entry at `lib` (worktrees leave it empty), then a concurrent lead worktree. */
  function withSubmodule() {
    env = makeEnv();
    initGitRepo(env.repo);
    const sha = git(env.repo, "rev-parse", "HEAD");
    git(env.repo, "update-index", "--add", "--cacheinfo", `160000,${sha},lib`);
    git(env.repo, "commit", "-q", "-m", "submodule");
    makeConcurrent(env, 2);
    const p = env.project();
    const lead = prepareAgentWorkspace(p, "run-1", "lead", snapshotHead(p, "run-1"));
    const scratch = path.join(env.root, "attacker");
    fs.mkdirSync(scratch);
    const victim = path.join(env.root, "victim.txt");
    fs.writeFileSync(victim, "precious\n");
    const s: Scene = { p, lead, member: lead, scratch, marker: path.join(env.root, "MARKER"), victim };
    return s;
  }

  it.skipIf(posixOnly)("keep working: a submodule entry from the snapshot is accepted", () => {
    const s = withSubmodule();
    write(path.join(s.lead.dir, "src/web/x.txt"), "x\n");
    const rb = finishLeadBranch(s.lead, "m", path.join(env.root, "p.patch"));
    expect(rb.files).toBe(1);
    expect(git(env.repo, "ls-tree", rb.branch, "lib")).toMatch(/^160000 commit/);
    expect(attacked(s)).toBe(false);
  });

  it.skipIf(posixOnly)("a repository placed at the submodule's path is refused, and nothing in it runs", () => {
    const s = withSubmodule();
    fs.rmSync(path.join(s.lead.root, "lib"), { recursive: true, force: true });
    nestedRepo(s.lead, s, "lib");
    expect(() => commitWorkspace(s.lead, "m")).toThrow(/a git repository was placed at the submodule path lib/);
    expect(attacked(s)).toBe(false);
  });
});

describe("a refused worktree during a run", () => {
  const OK = { ok: true, text: "", exitCode: 0, timedOut: false };
  const mail = (p: ResolvedProject, from: string, to: string, subject: string, type = "reply") =>
    write(
      path.join(outboxDir(p, from), `${Math.random()}.md`),
      `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: partial\n" : ""}---\n\n${type === "done" ? "## Result\nx\n\n## Not done\nx\n" : withSections(type, `body of ${subject}`)}\n`,
    );
  async function start(invoker: Parameters<typeof runTeam>[0]["invoker"]) {
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    const summary = await runTeam({ project, task, runDir, invoker, log: () => {} });
    return { summary, runDir };
  }
  function concurrentRun() {
    env = makeEnv();
    initGitRepo(env.repo);
    makeParallel(env);
    makeConcurrent(env, 2);
    const scratch = path.join(env.root, "attacker");
    fs.mkdirSync(scratch);
    const victim = path.join(env.root, "victim.txt");
    fs.writeFileSync(victim, "precious\n");
    return { scratch, victim, marker: path.join(env.root, "MARKER") };
  }

  it.skipIf(posixOnly)("a member's: its changes are reported as not integrated, the lead is told, and the run goes on", async () => {
    const a = concurrentRun();
    let leadCalls = 0;
    let leadMail = "";
    const { summary, runDir } = await start(async (i) => {
      if (i.agent.name === "lead") {
        if (++leadCalls === 1) mail(i.project, "lead", "fe-member", "job", "task");
        else {
          leadMail = i.userPrompt;
          mail(i.project, "lead", "lead", "bye", "done");
        }
      } else {
        write(path.join(i.workspace!.dir, "src/web/feature.txt"), "member built\n");
        nestedRepo(i.workspace!, { ...a, p: i.project, lead: i.workspace!, member: i.workspace! });
        mail(i.project, i.agent.name, "lead", "finished");
      }
      return OK;
    });
    expect(summary.endReason).toBe("done");
    const blocked = loadRunState(runDir).blocked_integrations ?? [];
    expect(blocked.map((b) => b.agent)).toEqual(["fe-member"]);
    expect(blocked[0]?.reason).toMatch(/nested git repository at src\/web\/sub/);
    expect(leadMail).toMatch(/could not be brought into the repo/);
    expect(fs.existsSync(a.marker)).toBe(false);
  });

  it.skipIf(posixOnly)("the lead's: its branch is not committed, a note says why, and the work stays in its worktree", async () => {
    const a = concurrentRun();
    let leadDir = "";
    const { summary, runDir } = await start(async (i) => {
      leadDir = i.workspace!.dir;
      write(path.join(leadDir, "src/web/lead.txt"), "lead\n");
      nestedRepo(i.workspace!, { ...a, p: i.project, lead: i.workspace!, member: i.workspace! });
      mail(i.project, "lead", "lead", "bye", "done");
      return OK;
    });
    expect(summary.endReason).toBe("done");
    expect(summary.resultBranch).toBeUndefined();
    expect(loadRunState(runDir).notes?.join("\n")).toMatch(/Could not commit the work.*nested git repository/);
    expect(fs.readFileSync(path.join(leadDir, "src/web/lead.txt"), "utf8")).toBe("lead\n");
    expect(fs.existsSync(a.marker)).toBe(false);
  });
});

describe("a HEAD that is not the worktree's own branch", () => {
  const headOf = (ws: AgentWorkspace) => path.join(ws.gitDir, "HEAD");

  it.skipIf(posixOnly)("control: plain git in a worktree whose HEAD names main commits onto the user's main", () => {
    const s = scene();
    const mainBefore = git(env.repo, "rev-parse", "main");
    fs.writeFileSync(headOf(s.member), "ref: refs/heads/main\n");
    plainGit(s.member, "add", "-A");
    plainGit(s.member, "commit", "-q", "--no-verify", "-m", "onto main");
    expect(git(env.repo, "rev-parse", "main")).not.toBe(mainBefore);
    expect(git(env.repo, "log", "-1", "--format=%s", "main")).toBe("onto main");
  });

  const forged: Array<[string, (ws: AgentWorkspace) => void]> = [
    ["names the user's main", (ws) => fs.writeFileSync(headOf(ws), "ref: refs/heads/main\n")],
    ["is detached at a commit", (ws) => fs.writeFileSync(headOf(ws), `${ws.base}\n`)],
    [
      "is a symlink (even to the right content)",
      (ws) => {
        const elsewhere = path.join(env.root, `head-${ws.agent}`);
        fs.writeFileSync(elsewhere, fs.readFileSync(headOf(ws)));
        fs.rmSync(headOf(ws));
        fs.symlinkSync(elsewhere, headOf(ws));
      },
    ],
  ];

  describe.each(forged)("HEAD %s", (_name, forge) => {
    it.skipIf(posixOnly)("commitWorkspace, collectAgentChanges and finishLeadBranch refuse, and main is untouched", () => {
      const s = scene();
      const mainBefore = git(env.repo, "rev-parse", "main");
      forge(s.member);
      forge(s.lead);
      expect(() => commitWorkspace(s.member, "m")).toThrow(/is not a plain file naming its own branch agent-lyceum\/run-1\/fe-member/);
      expect(() => collectAgentChanges(s.member, ["src/web/**"])).toThrow(/Refusing to run git.*agent-lyceum clear/s);
      expect(() => finishLeadBranch(s.lead, "m", path.join(env.root, "p.patch"))).toThrow(/Refusing to run git/);
      expect(git(env.repo, "rev-parse", "main")).toBe(mainBefore);
    });
  });

  it("is never refused for a worktree git left alone, through several commits, a reset and a finish", () => {
    const s = scene();
    for (const n of [1, 2, 3]) {
      write(path.join(s.member.dir, `src/web/f${n}.txt`), `${n}\n`);
      expect(commitWorkspace(s.member, `c${n}`).committed).toBe(true);
    }
    expect(collectAgentChanges(s.member, ["src/web/**"]).files.map((f) => f.path)).toEqual(["src/web/f1.txt", "src/web/f2.txt", "src/web/f3.txt", "src/web/feature.txt"]);
    const fresh = prepareAgentWorkspace(s.p, "run-1", "qa-member", snapshotBase(s.p, "run-1", 2, s.lead));
    write(path.join(s.lead.dir, "src/web/later.txt"), "later\n");
    const reset = prepareAgentWorkspace(s.p, "run-1", "qa-member", snapshotBase(s.p, "run-1", 3, s.lead));
    expect(reset.base).not.toBe(fresh.base); // reset --hard
    expect(fs.readFileSync(headOf(reset), "utf8")).toBe("ref: refs/heads/agent-lyceum/run-1/qa-member\n"); // and a reset leaves HEAD alone
    expect(finishLeadBranch(s.lead, "m", path.join(env.root, "p.patch")).files).toBe(2);
    expect(fs.readFileSync(headOf(s.member), "utf8")).toBe("ref: refs/heads/agent-lyceum/run-1/fe-member\n");
  });
});

describe("a refusal between batches", () => {
  const OK = { ok: true, text: "", exitCode: 0, timedOut: false };
  const mail = (p: ResolvedProject, from: string, to: string, subject: string, type = "reply") =>
    write(
      path.join(outboxDir(p, from), `${Math.random()}.md`),
      `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: partial\n" : ""}---\n\n${type === "done" ? "## Result\nx\n\n## Not done\nx\n" : withSections(type, `body of ${subject}`)}\n`,
    );
  async function start(invoker: Parameters<typeof runTeam>[0]["invoker"]) {
    env = makeEnv();
    initGitRepo(env.repo);
    makeParallel(env);
    makeConcurrent(env, 2);
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    const summary = await runTeam({ project, task, runDir, invoker, log: () => {} });
    return { summary, runDir };
  }

  it("of the lead's worktree at the next snapshot ends the run as a lead failure with a note, without throwing", async () => {
    let mainBefore = "";
    let leadDir = "";
    const { summary, runDir } = await start(async (i) => {
      mainBefore ||= git(env.repo, "rev-parse", "main");
      leadDir = i.workspace!.dir;
      write(path.join(leadDir, "src/web/lead.txt"), "lead\n");
      fs.writeFileSync(path.join(i.workspace!.gitDir, "HEAD"), "ref: refs/heads/main\n");
      mail(i.project, "lead", "fe-member", "job", "task");
      return OK;
    });
    expect(summary.endReason).toBe("lead_failed");
    const state = loadRunState(runDir);
    expect(state.end_reason).toBe("lead_failed");
    expect(state.notes?.join("\n")).toMatch(/Could not snapshot lead's worktree.*Refusing to run git/);
    expect(git(env.repo, "rev-parse", "main")).toBe(mainBefore);
    expect(fs.readFileSync(path.join(leadDir, "src/web/lead.txt"), "utf8")).toBe("lead\n"); // the work stays
  });

  it("of a member's worktree when it is reused: it is not woken again, the lead is told, and the run goes on", async () => {
    let leadCalls = 0;
    let memberCalls = 0;
    let leadMail = "";
    const { summary, runDir } = await start(async (i) => {
      if (i.agent.name === "lead") {
        leadCalls++;
        if (leadCalls === 1) mail(i.project, "lead", "fe-member", "job", "task");
        else if (leadCalls === 2) {
          write(path.join(i.workspace!.dir, "src/web/more.txt"), "more\n"); // a new snapshot: the member's worktree gets reused
          mail(i.project, "lead", "fe-member", "again", "task");
        } else {
          leadMail = i.userPrompt;
          mail(i.project, "lead", "lead", "bye", "done");
        }
      } else {
        memberCalls++;
        fs.writeFileSync(path.join(i.workspace!.gitDir, "HEAD"), `${i.workspace!.base}\n`); // detached
        mail(i.project, i.agent.name, "lead", "finished");
      }
      return OK;
    });
    expect(summary.endReason).toBe("done");
    expect(memberCalls).toBe(1);
    const state = loadRunState(runDir);
    expect(state.notes?.join("\n")).toMatch(/fe-member was not woken: Refusing to run git/);
    expect(state.blocked_integrations?.map((b) => b.agent)).toEqual(["fe-member"]);
    expect(leadMail).toMatch(/fe-member cannot be woken/);
  });
});

// git's reftable ref backend keeps a linked worktree's HEAD in `<gitDir>/reftable/` (agent-writable) and writes the file
// `<gitDir>/HEAD` as `ref: refs/heads/.invalid`, so the HEAD check cannot hold the invariant there: such a repository is
// refused up front, instead of every worktree being refused one by one in the middle of a run.
const reftableSupported = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reftable-probe-"));
  try {
    execFileSync("git", ["init", "-q", "--ref-format=reftable", dir], { stdio: "pipe" });
    return true;
  } catch {
    return false; // a git too old to know reftable
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

describe.skipIf(!reftableSupported || posixOnly)("a repository that uses git's reftable ref storage", () => {
  function reftableProject() {
    env = makeEnv();
    fs.mkdirSync(env.repo, { recursive: true });
    git(env.repo, "init", "-q", "-b", "main", "--ref-format=reftable");
    git(env.repo, "config", "user.email", "t@example.com");
    git(env.repo, "config", "user.name", "t");
    write(path.join(env.repo, "src/web/a.txt"), "a\n");
    git(env.repo, "add", "-A");
    git(env.repo, "commit", "-q", "-m", "init");
    expect(git(env.repo, "rev-parse", "--show-ref-format")).toBe("reftable");
  }
  const noWorktreeYet = (project: ResolvedProject) => {
    expect(fs.existsSync(path.join(project.paths.root, "worktrees"))).toBe(false);
    expect(git(env.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
    expect(git(env.repo, "for-each-ref", "refs/agent-lyceum/")).toBe("");
  };

  it("falls back to the shared checkout for a new run, and a resume that needs worktrees is refused before anything is created", () => {
    reftableProject();
    const project = env.project();
    expect(planWorkspace(project)).toEqual({ mode: "shared", leadWorktree: false, reason: "reftable ref storage" });
    expect(() => assertWorktreeRunnable(project)).toThrow(/reftable/);
    noWorktreeYet(project);
  });

  it("runs a new run in the shared checkout without error, and a normal repository is isolated", async () => {
    reftableProject();
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    const s = await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      invoker: async (i) => {
        write(path.join(outboxDir(i.project, i.agent.name), "d.md"), "---\nto: lead\ntype: done\nsubject: d\noutcome: partial\n---\n\n## Result\nx\n\n## Not done\nx\n");
        return { ok: true, text: "", exitCode: 0, timedOut: false };
      },
    });
    expect(s.endReason).toBe("done");
    noWorktreeYet(project);

    env.cleanup();
    env = makeEnv();
    initGitRepo(env.repo);
    expect(planWorkspace(env.project())).toEqual({ mode: "worktree", leadWorktree: true });
    expect(() => assertWorktreeRunnable(env.project())).not.toThrow();
  });
});

