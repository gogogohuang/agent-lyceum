import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAskReply, writeAskReply } from "../src/ask-reply.js";
import { runTeam } from "../src/dispatcher.js";
import { listUnread } from "../src/mailbox.js";
import { setFaultHook } from "../src/message-store.js";
import { commonFile, outboxDir } from "../src/policy.js";
import { RunSession } from "../src/run-session.js";
import { bindRunProject, loadRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { collectAgentChanges, globMatch, integrateAgentChanges, prepareAgentWorkspace, snapshotBase, type AgentWorkspace } from "../src/worktree.js";
import { FULL_DONE, git, initGitRepo, makeConcurrent, makeEnv, makeParallel, write, type TestEnv } from "./helpers.js";
import { PR_FOOTER, type CommandRunner } from "../src/open-pr.js";
import type { ResolvedProject } from "../src/config.js";

let env: TestEnv;
afterEach(() => {
  setFaultHook(undefined);
  env?.cleanup();
});

const FE_OWNS = ["src/web/**"];
const QA_OWNS = ["tests/**"];

function setup() {
  env = makeEnv();
  initGitRepo(env.repo, { "src/web/a.txt": "a\n", "src/web/b.txt": "b\n", "tests/t.txt": "t\n", "CLAUDE.md": "rules\n" });
  makeParallel(env);
  const project = env.project();
  const ref = snapshotBase(project, "run-1", 1);
  const ws = (agent: string) => prepareAgentWorkspace(project, "run-1", agent, ref);
  return { project, ref, ws };
}
const collect = (w: AgentWorkspace, owns: string[]) => collectAgentChanges(w, owns);

describe("globMatch", () => {
  it("handles **, *, ? and braces like the owns globs in project.yaml", () => {
    expect(globMatch("src/web/**", "src/web/a/b/c.ts")).toBe(true);
    expect(globMatch("src/web/**", "src/web")).toBe(false);
    expect(globMatch("src/web/**", "src/webx/a.ts")).toBe(false);
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(globMatch("**/*.md", "docs/x/y.md")).toBe(true);
    expect(globMatch("**/*.md", "y.md")).toBe(true);
    expect(globMatch("src/{web,api}/**", "src/api/x")).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
  });
});

describe("collectAgentChanges", () => {
  it("commits what the agent did in its worktree and lists the files", () => {
    const { ws } = setup();
    const fe = ws("fe-member");
    write(path.join(fe.dir, "src/web/a.txt"), "a changed\n");
    write(path.join(fe.dir, "src/web/new.txt"), "new\n");
    fs.rmSync(path.join(fe.dir, "src/web/b.txt"));
    const c = collect(fe, FE_OWNS);
    expect(c.violations).toEqual([]);
    expect(c.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(["A src/web/new.txt", "D src/web/b.txt", "M src/web/a.txt"]);
    expect(git(fe.root, "status", "--porcelain")).toBe(""); // committed on the agent's branch
    expect(git(fe.root, "log", "--format=%s", "-1")).toMatch(/fe-member/);
  });

  it("reports no changes for an untouched worktree", () => {
    const { ws } = setup();
    expect(collect(ws("fe-member"), FE_OWNS)).toMatchObject({ files: [], violations: [] });
  });

  it("flags edits outside owns, in any form: modify, add, delete and rename", () => {
    const { ws } = setup();
    const fe = ws("fe-member");
    write(path.join(fe.dir, "tests/t.txt"), "sneaky\n"); // modify outside
    write(path.join(fe.dir, "docs/new.md"), "x\n"); // add outside
    git(fe.root, "mv", "src/web/b.txt", "tests/b-moved.txt"); // rename out of owns
    const v = collect(fe, FE_OWNS).violations.join("\n");
    expect(v).toContain("tests/t.txt");
    expect(v).toContain("docs/new.md");
    expect(v).toContain("tests/b-moved.txt");
    const fe2 = ws("qa-member");
    fs.rmSync(path.join(fe2.dir, "src/web/a.txt")); // delete outside qa's owns
    expect(collect(fe2, QA_OWNS).violations.join("\n")).toContain("src/web/a.txt");
  });

  it("flags the repo's protected instruction files", () => {
    const { ws } = setup();
    const fe = ws("fe-member");
    write(path.join(fe.dir, "CLAUDE.md"), "new rules\n");
    expect(collect(fe, []).violations.join("\n")).toMatch(/CLAUDE\.md.*protected/);
  });

  it("flags symlinks that point out of the agent's area, but not harmless ones inside it", () => {
    const { ws } = setup();
    const fe = ws("fe-member");
    fs.symlinkSync("/etc/passwd", path.join(fe.dir, "src/web/abs-link"));
    fs.symlinkSync("../../tests/t.txt", path.join(fe.dir, "src/web/escape-link"));
    fs.symlinkSync("a.txt", path.join(fe.dir, "src/web/fine-link"));
    const v = collect(fe, FE_OWNS).violations.join("\n");
    expect(v).toContain("abs-link");
    expect(v).toContain("escape-link");
    expect(v).not.toContain("fine-link");
  });

  it("without owns, anything inside the project is fine", () => {
    const { ws } = setup();
    const fe = ws("fe-member");
    write(path.join(fe.dir, "anywhere/x.txt"), "x\n");
    expect(collect(fe, []).violations).toEqual([]);
  });

  it("measures a project that is a subfolder of the repo relative to that folder", () => {
    env = makeEnv();
    initGitRepo(env.repo, { "app/src/web/a.txt": "a\n", "other/o.txt": "o\n" });
    env.editProjectYaml((t) => t.replace(/^dir: .*$/m, `dir: ${path.join(env.repo, "app")}`));
    const p = env.project();
    const fe = prepareAgentWorkspace(p, "run-1", "fe-member", snapshotBase(p, "run-1", 1));
    write(path.join(fe.dir, "src/web/a.txt"), "changed\n");
    write(path.join(fe.root, "other/o.txt"), "outside the project\n");
    const c = collect(fe, FE_OWNS);
    expect(c.files.map((f) => f.path)).toContain("app/src/web/a.txt");
    expect(c.violations.join("\n")).toMatch(/other\/o\.txt.*outside the project/);
  });
});

describe("integrateAgentChanges", () => {
  it("applies two members' disjoint changes to the main working tree and touches nothing else", () => {
    const { project, ws } = setup();
    const head = git(env.repo, "rev-parse", "HEAD");
    const fe = ws("fe-member");
    const qa = ws("qa-member");
    write(path.join(fe.dir, "src/web/a.txt"), "fe change\n");
    write(path.join(fe.dir, "src/web/new.txt"), "fe new\n");
    fs.rmSync(path.join(fe.dir, "src/web/b.txt"));
    write(path.join(qa.dir, "tests/t.txt"), "qa change\n");

    expect(integrateAgentChanges(project, collect(fe, FE_OWNS)).status).toBe("integrated");
    expect(integrateAgentChanges(project, collect(qa, QA_OWNS)).status).toBe("integrated");

    expect(fs.readFileSync(path.join(env.repo, "src/web/a.txt"), "utf8")).toBe("fe change\n");
    expect(fs.readFileSync(path.join(env.repo, "src/web/new.txt"), "utf8")).toBe("fe new\n");
    expect(fs.existsSync(path.join(env.repo, "src/web/b.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(env.repo, "tests/t.txt"), "utf8")).toBe("qa change\n");
    expect(git(env.repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(env.repo, "branch", "--show-current")).toBe("main");
    expect(git(env.repo, "diff", "--cached", "--name-only")).toBe(""); // nothing staged in the user's index
  });

  it("keeps both sides and says why when the lead changed the same file after the snapshot", () => {
    const { project, ws } = setup();
    const fe = ws("fe-member");
    write(path.join(fe.dir, "src/web/a.txt"), "fe version\n");
    write(path.join(fe.dir, "src/web/ok.txt"), "also from fe\n");
    write(path.join(env.repo, "src/web/a.txt"), "my later edit\n"); // the lead (or you) edited it meanwhile

    const r = integrateAgentChanges(project, collect(fe, FE_OWNS));
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.reason).toMatch(/src\/web\/a\.txt.*changed since/);
    expect(r.branch).toBe("agent-lyceum/run-1/fe-member");
    expect(fs.readFileSync(path.join(env.repo, "src/web/a.txt"), "utf8")).toBe("my later edit\n"); // not overwritten
    expect(fs.existsSync(path.join(env.repo, "src/web/ok.txt"))).toBe(false); // all or nothing
    expect(git(env.repo, "show", `${r.branch}:src/web/a.txt`)).toBe("fe version"); // agent's work kept on its branch
    expect(fs.readFileSync(r.report, "utf8")).toMatch(/src\/web\/a\.txt/);
    expect(fs.existsSync(r.patch)).toBe(true);
    expect(fs.readFileSync(path.join(fe.dir, "src/web/a.txt"), "utf8")).toBe("fe version\n"); // worktree untouched
  });

  it("blocks changes that leave the agent's area and applies nothing", () => {
    const { project, ws } = setup();
    const fe = ws("fe-member");
    write(path.join(fe.dir, "src/web/a.txt"), "ok\n");
    write(path.join(fe.dir, "tests/t.txt"), "not mine\n");
    const r = integrateAgentChanges(project, collect(fe, FE_OWNS));
    expect(r.status).toBe("blocked");
    expect(fs.readFileSync(path.join(env.repo, "src/web/a.txt"), "utf8")).toBe("a\n");
    expect(fs.readFileSync(path.join(env.repo, "tests/t.txt"), "utf8")).toBe("t\n");
  });

  it("is safe to repeat: changes already applied (a crash before the bookkeeping) are not a conflict", () => {
    const { project, ws } = setup();
    const fe = ws("fe-member");
    write(path.join(fe.dir, "src/web/a.txt"), "fe change\n");
    const c = collect(fe, FE_OWNS);
    expect(integrateAgentChanges(project, c).status).toBe("integrated");
    expect(integrateAgentChanges(project, c).status).toBe("integrated");
    expect(fs.readFileSync(path.join(env.repo, "src/web/a.txt"), "utf8")).toBe("fe change\n");
  });

  it("lets the next wake-up start from the integrated state and report only its own new changes", () => {
    const { project, ws } = setup();
    const fe = ws("fe-member");
    write(path.join(fe.dir, "src/web/a.txt"), "round 1\n");
    expect(integrateAgentChanges(project, collect(fe, FE_OWNS)).status).toBe("integrated");

    write(path.join(env.repo, "src/web/lead.txt"), "lead after round 1\n");
    const fe2 = prepareAgentWorkspace(project, "run-1", "fe-member", snapshotBase(project, "run-1", 2));
    expect(fs.readFileSync(path.join(fe2.dir, "src/web/a.txt"), "utf8")).toBe("round 1\n");
    expect(fs.readFileSync(path.join(fe2.dir, "src/web/lead.txt"), "utf8")).toBe("lead after round 1\n");
    write(path.join(fe2.dir, "src/web/b.txt"), "round 2\n");
    const c2 = collect(fe2, FE_OWNS);
    expect(c2.files.map((f) => f.path)).toEqual(["src/web/b.txt"]);
    expect(integrateAgentChanges(project, c2).status).toBe("integrated");
    expect(fs.readFileSync(path.join(env.repo, "src/web/b.txt"), "utf8")).toBe("round 2\n");
  });

  it("a blocked member keeps its commits and retries on top of them next time", () => {
    const { project, ws } = setup();
    const fe = ws("fe-member");
    write(path.join(fe.dir, "src/web/a.txt"), "fe version\n");
    write(path.join(env.repo, "src/web/a.txt"), "lead version\n");
    expect(integrateAgentChanges(project, collect(fe, FE_OWNS)).status).toBe("blocked");
    // the lead resolves by making the main file match what the agent started from again, then the retry goes through
    write(path.join(env.repo, "src/web/a.txt"), "a\n");
    const again = prepareAgentWorkspace(project, "run-1", "fe-member", snapshotBase(project, "run-1", 2));
    expect(again.base).toBe(fe.base); // still measured against the original snapshot
    expect(integrateAgentChanges(project, collect(again, FE_OWNS)).status).toBe("integrated");
    expect(fs.readFileSync(path.join(env.repo, "src/web/a.txt"), "utf8")).toBe("fe version\n");
  });
});

describe("dispatcher integration", () => {
  const OK = { ok: true, text: "", exitCode: 0, timedOut: false };
  const mail = (p: ResolvedProject, from: string, to: string, subject: string, type = "reply", outcome = "completed") =>
    write(
      path.join(outboxDir(p, from), `${Math.random()}.md`),
      `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? `outcome: ${outcome}\n` : ""}---\n\n${type === "done" ? "## Result\nx\n\n## Files\nx\n\n## Verification\nx\n\n## Not done\nNone\n" : "body"}\n`,
    );

  async function start(invoker: Parameters<typeof runTeam>[0]["invoker"], opts: { pr?: CommandRunner } = {}) {
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    const summary = await runTeam({ project, task, runDir, invoker, log: () => {}, pr: opts.pr });
    return { summary, runDir, bound: bindRunProject(env.project(), runDir, "run") };
  }
  const ask = (p: ResolvedProject) =>
    write(
      path.join(outboxDir(p, "lead"), "ask.md"),
      `---\nto: lead\ntype: ask\nsubject: ask\n---\n\n<ask><question id="q1"><text>JWT?</text><options><option>session</option><option>jwt</option></options><suggested>session</suggested></question></ask>\n`,
    );
  const answer = (runDir: string) => {
    const r = readAskReply(runDir)!;
    writeAskReply(runDir, { ...r, questions: r.questions.map((q) => ({ ...q, answer: { value: "jwt", by: "user" as const } })) });
  };
  const resumeRun = (runDir: string, invoker: Parameters<typeof runTeam>[0]["invoker"]) =>
    runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, log: () => {}, invoker });

  it("a concurrent run works in the lead's own worktree, brings members into it, and commits one branch without touching the repo", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeParallel(env);
    makeConcurrent(env, 2);
    write(path.join(env.repo, "src/web/a.txt"), "uncommitted edit\n"); // yours, and not part of the run
    const headBefore = git(env.repo, "rev-parse", "HEAD");
    let leadCalls = 0;
    let leadDir = "";
    const { summary, runDir } = await start(async (i) => {
      if (i.agent.name === "lead") {
        leadDir = i.workspace!.dir;
        expect(i.workspace!.branch).toBe("agent-lyceum/run-1/lead");
        expect(fs.readFileSync(path.join(leadDir, "src/web/a.txt"), "utf8")).toBe("a\n");
        if (++leadCalls === 1) {
          write(path.join(leadDir, "tests/lead-note.txt"), "lead\n");
          mail(i.project, "lead", "fe-member", "job", "task");
        } else {
          expect(fs.readFileSync(path.join(leadDir, "src/web/feature.txt"), "utf8")).toBe("member built\n"); // brought into the lead's worktree
          mail(i.project, "lead", "lead", "bye", "done");
        }
      } else {
        write(path.join(i.workspace!.dir, "src/web/feature.txt"), "member built\n");
        mail(i.project, i.agent.name, "lead", "finished");
      }
      return OK;
    });
    expect(summary.outcome).toBe("completed");
    expect(summary.resultBranch).toMatchObject({ branch: "agent-lyceum/run-1/lead", files: 2 });
    expect(loadRunState(runDir).result_branch?.head).toBe(summary.resultBranch!.head);
    expect(fs.readFileSync(path.join(runDir, "lead.patch"), "utf8")).toContain("src/web/feature.txt");
    // the repo: HEAD, working tree and index are as they were
    expect(git(env.repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(env.repo, "status", "--porcelain")).toBe("M src/web/a.txt");
    expect(fs.existsSync(path.join(env.repo, "src/web/feature.txt"))).toBe(false);
    // the branch carries the work
    expect(git(env.repo, "show", "agent-lyceum/run-1/lead:src/web/feature.txt")).toBe("member built");
    expect(git(env.repo, "show", "agent-lyceum/run-1/lead:tests/lead-note.txt")).toBe("lead");
  });

  it("a concurrent run guards the lead worktree's CLAUDE.md and leaves yours alone", async () => {
    env = makeEnv();
    initGitRepo(env.repo, { "src/web/a.txt": "a\n", "tests/t.txt": "t\n", "CLAUDE.md": "rules\n" });
    makeConcurrent(env, 2);
    env.editProjectYaml((t) => t.replace("can_edit_agent_md: true", "can_edit_agent_md: false"));
    let leadCalls = 0;
    let leadClaude = "";
    let leadPrompt = "";
    const { summary, runDir } = await start(async (i) => {
      leadClaude = path.join(i.workspace!.dir, "CLAUDE.md");
      if (++leadCalls === 1) {
        write(leadClaude, "lead rewrote the rules\n"); // no sandbox here: only the guard can catch it
        write(path.join(env.repo, "CLAUDE.md"), "my own edit\n"); // you, in your tree, while the lead works
      } else {
        leadPrompt = i.userPrompt;
        mail(i.project, "lead", "lead", "bye", "done");
      }
      return OK;
    });
    expect(summary.endReason).toBe("done");
    const violations = fs.readFileSync(path.join(runDir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "violation");
    expect(violations.map((v) => v.file)).toEqual([leadClaude]); // (i) the lead's own copy, and only it
    expect(fs.readFileSync(leadClaude, "utf8")).toBe("rules\n"); // reverted there
    expect(leadPrompt).toContain("Protected file restored"); // and the lead hears of it
    expect(fs.readFileSync(path.join(env.repo, "CLAUDE.md"), "utf8")).toBe("my own edit\n"); // (ii) yours is left as you wrote it
    expect(git(env.repo, "show", "agent-lyceum/run-1/lead:CLAUDE.md")).toBe("rules");
  });

  it("a run does not undo another run's edit to COMMON.md made before its batch", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    const project = env.project();
    const common = commonFile(project);
    const before = fs.readFileSync(common, "utf8");
    const runDirB = path.join(project.paths.runs, "run-b");
    // Run B starts (its guard takes its baseline); its only agent is a member that may not edit COMMON.md.
    const b = new RunSession({
      project,
      task: prepareTask({ text: "task b", cwd: env.root, runDir: runDirB }),
      runDir: runDirB,
      soloAgent: "fe-member",
      log: () => {},
      invoker: async (i) => {
        mail(i.project, "fe-member", "fe-member", "bye", "done");
        return OK;
      },
    });
    // Meanwhile run A's lead edits COMMON.md, which it may.
    const runDirA = path.join(project.paths.runs, "run-a");
    const a = await runTeam({
      project,
      task: prepareTask({ text: "task a", cwd: env.root, runDir: runDirA }),
      runDir: runDirA,
      log: () => {},
      invoker: async (i) => {
        write(common, `${before}A's rule\n`);
        mail(i.project, "lead", "lead", "bye", "done");
        return OK;
      },
    });
    expect(a.outcome).toBe("completed");
    const sb = await b.run();
    expect(sb.outcome).toBe("completed");
    expect(fs.readFileSync(common, "utf8")).toBe(`${before}A's rule\n`);
    expect(fs.readFileSync(path.join(runDirB, "log.jsonl"), "utf8")).not.toContain('"violation"');
  });

  it("two concurrent runs of one project do not see each other's files", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    const project = env.project();
    const runOne = async (id: string) => {
      const runDir = path.join(project.paths.runs, id);
      const task = prepareTask({ text: `task ${id}`, cwd: env.root, runDir });
      return runTeam({
        project,
        task,
        runDir,
        log: () => {},
        invoker: async (i) => {
          write(path.join(i.workspace!.dir, `src/web/${id}.txt`), `${id}\n`);
          expect(fs.readdirSync(path.join(i.workspace!.dir, "src/web")).filter((f) => f.endsWith(".txt") && f !== "a.txt")).toEqual([`${id}.txt`]);
          mail(i.project, "lead", "lead", "bye", "done");
          return OK;
        },
      });
    };
    const [a, b] = await Promise.all([runOne("run-a"), runOne("run-b")]);
    expect([a.outcome, b.outcome]).toEqual(["completed", "completed"]);
    expect(git(env.repo, "status", "--porcelain")).toBe("");
    expect(git(env.repo, "ls-tree", "--name-only", "agent-lyceum/run-a/lead", "src/web/")).toBe("src/web/a.txt\nsrc/web/run-a.txt");
    expect(git(env.repo, "ls-tree", "--name-only", "agent-lyceum/run-b/lead", "src/web/")).toBe("src/web/a.txt\nsrc/web/run-b.txt");
  });

  it("a concurrent run that stops to ask the user does not commit or announce a branch, and its resume goes on in the same worktree", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    let leadDir = "";
    const { summary, runDir } = await start(async (i) => {
      leadDir = i.workspace!.dir;
      write(path.join(leadDir, "src/web/draft.txt"), "draft\n");
      ask(i.project);
      return OK;
    });
    expect(summary.endReason).toBe("waiting");
    expect(summary.resultBranch).toBeUndefined();
    expect(loadRunState(runDir).result_branch).toBeUndefined();
    expect(git(env.repo, "log", "-1", "--format=%s", "agent-lyceum/run-1/lead")).toBe("init"); // no commit yet
    expect(fs.existsSync(path.join(runDir, "lead.patch"))).toBe(false);
    expect(fs.readFileSync(path.join(leadDir, "src/web/draft.txt"), "utf8")).toBe("draft\n"); // the work waits in the worktree

    answer(runDir);
    let resumedDir = "";
    const s = await resumeRun(runDir, async (i) => {
      resumedDir = i.workspace!.dir;
      mail(i.project, "lead", "lead", "bye", "done");
      return OK;
    });
    expect(resumedDir).toBe(leadDir);
    expect(s.outcome).toBe("completed");
    expect(s.resultBranch).toMatchObject({ branch: "agent-lyceum/run-1/lead", files: 1 });
    expect(git(env.repo, "show", "agent-lyceum/run-1/lead:src/web/draft.txt")).toBe("draft");
  });

  it("a concurrent resume whose lead worktree is gone refuses without touching the stored run", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    let leadRoot = "";
    const { runDir, bound } = await start(async (i) => {
      leadRoot = i.workspace!.root;
      ask(i.project);
      return OK;
    });
    answer(runDir);
    git(env.repo, "worktree", "remove", "--force", leadRoot);
    const stateBefore = fs.readFileSync(path.join(runDir, "state.json"), "utf8");
    const replyBefore = readAskReply(runDir);
    const unreadBefore = listUnread(bound, "lead").length;
    await expect(resumeRun(runDir, async () => OK)).rejects.toThrow(/no worktree for lead/);
    expect(fs.readFileSync(path.join(runDir, "state.json"), "utf8")).toBe(stateBefore);
    expect(loadRunState(runDir).end_reason).toBe("waiting");
    expect(readAskReply(runDir)).toEqual(replyBefore); // the answers are still there, not delivered
    expect(listUnread(bound, "lead")).toHaveLength(unreadBefore);
  });

  it("a run started concurrent resumes in its worktree even after max_concurrent_runs went back to 1", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    let leadDir = "";
    const { runDir } = await start(async (i) => {
      leadDir = i.workspace!.dir;
      write(path.join(leadDir, "src/web/draft.txt"), "draft\n");
      ask(i.project);
      return OK;
    });
    expect(loadRunState(runDir).lead_workspace).toBe(true);
    env.editProjectYaml((t) => t.replace("max_concurrent_runs: 2", "max_concurrent_runs: 1"));
    answer(runDir);
    let resumedDir: string | undefined;
    const s = await resumeRun(runDir, async (i) => {
      resumedDir = i.workspace?.dir;
      write(path.join(i.workspace!.dir, "src/web/more.txt"), "more\n");
      mail(i.project, "lead", "lead", "bye", "done");
      return OK;
    });
    expect(resumedDir).toBe(leadDir);
    expect(s.outcome).toBe("completed");
    expect(s.resultBranch).toMatchObject({ branch: "agent-lyceum/run-1/lead", files: 2 });
    expect(git(env.repo, "status", "--porcelain")).toBe(""); // your tree is untouched
    expect(git(env.repo, "show", "agent-lyceum/run-1/lead:src/web/more.txt")).toBe("more");
  });

  it("a run started non-concurrent resumes as before after max_concurrent_runs was raised", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const { runDir } = await start(async (i) => {
      expect(i.workspace).toBeUndefined();
      ask(i.project);
      return OK;
    });
    expect(loadRunState(runDir).lead_workspace).toBeUndefined();
    makeConcurrent(env, 2);
    answer(runDir);
    let workspace: unknown = "unset";
    const s = await resumeRun(runDir, async (i) => {
      workspace = i.workspace;
      write(path.join(env.repo, "src/web/shared.txt"), "in the repo\n");
      mail(i.project, "lead", "lead", "bye", "done");
      return OK;
    });
    expect(workspace).toBeUndefined();
    expect(s.outcome).toBe("completed");
    expect(s.resultBranch).toBeUndefined();
    expect(loadRunState(runDir).workspace_mode).toBe("shared");
    expect(git(env.repo, "status", "--porcelain")).toBe("?? src/web/shared.txt");
  });

  it("a solo run in a concurrent project works in its own worktree", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    let branch: string | undefined;
    const summary = await runTeam({
      project,
      task,
      runDir,
      soloAgent: "fe-member",
      log: () => {},
      invoker: async (i) => {
        branch = i.workspace?.branch;
        write(path.join(i.workspace!.dir, "src/web/solo.txt"), "solo\n");
        mail(i.project, "fe-member", "fe-member", "bye", "done");
        return OK;
      },
    });
    expect(branch).toBe("agent-lyceum/run-1/fe-member");
    expect(summary.outcome).toBe("completed");
    expect(summary.resultBranch).toMatchObject({ branch: "agent-lyceum/run-1/fe-member", files: 1 });
    expect(git(env.repo, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(env.repo, "src/web/solo.txt"))).toBe(false);
    expect(git(env.repo, "show", "agent-lyceum/run-1/fe-member:src/web/solo.txt")).toBe("solo");
  });

  it("brings a member's files into the repo before the lead hears the member is done", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeParallel(env);
    let seenByLead = "";
    let leadCalls = 0;
    const { summary } = await start(async (i) => {
      if (i.agent.name === "lead") {
        if (++leadCalls === 1) mail(i.project, "lead", "fe-member", "job", "task");
        else {
          seenByLead = fs.existsSync(path.join(env.repo, "src/web/feature.txt")) ? fs.readFileSync(path.join(env.repo, "src/web/feature.txt"), "utf8") : "MISSING";
          mail(i.project, "lead", "lead", "bye", "done");
        }
      } else {
        write(path.join(i.workspace!.dir, "src/web/feature.txt"), "built in the worktree\n");
        mail(i.project, i.agent.name, "lead", "finished");
      }
      return OK;
    });
    expect(summary.endReason).toBe("done");
    expect(summary.outcome).toBe("completed");
    expect(seenByLead).toBe("built in the worktree\n");
  });

  it("tells the lead when integration is blocked and will not call the run completed", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeParallel(env);
    let leadCalls = 0;
    let leadPrompt = "";
    const { summary, runDir } = await start(async (i) => {
      if (i.agent.name === "lead") {
        if (++leadCalls === 1) mail(i.project, "lead", "fe-member", "job", "task");
        else {
          leadPrompt = i.userPrompt;
          mail(i.project, "lead", "lead", "bye", "done"); // claims completed
        }
      } else {
        write(path.join(i.workspace!.dir, "src/web/a.txt"), "member version\n");
        write(path.join(env.repo, "src/web/a.txt"), "someone else's edit\n"); // collides while the member works
        mail(i.project, i.agent.name, "lead", "finished");
      }
      return OK;
    });
    expect(leadPrompt).toContain("could not be brought into the repo");
    expect(leadPrompt).toContain("agent-lyceum/run-1/fe-member");
    expect(fs.readFileSync(path.join(env.repo, "src/web/a.txt"), "utf8")).toBe("someone else's edit\n");
    expect(summary.outcome).toBe("blocked");
    expect(summary.outcomeNote).toMatch(/fe-member.*agent-lyceum\/run-1\/fe-member/);
    expect(loadRunState(runDir).blocked_integrations?.map((b) => b.agent)).toEqual(["fe-member"]);
  });

  it("survives a crash right after a member's files were brought in: resume neither loses nor re-applies them", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeParallel(env);
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    let leadCalls = 0;
    const invoker: Parameters<typeof runTeam>[0]["invoker"] = async (i) => {
      if (i.agent.name === "lead") {
        if (++leadCalls === 1 && !fs.existsSync(path.join(env.repo, "src/web/feature.txt"))) mail(i.project, "lead", "fe-member", "job", "task");
        else mail(i.project, "lead", "lead", "bye", "done");
      } else {
        write(path.join(i.workspace!.dir, "src/web/feature.txt"), "feature\n");
        mail(i.project, i.agent.name, "lead", "finished");
        setFaultHook(() => {
          throw new Error("killed while routing the member's mail");
        });
      }
      return OK;
    };
    await expect(runTeam({ project, task, runDir, invoker, log: () => {} })).rejects.toThrow(/killed/);
    setFaultHook(undefined);
    expect(fs.readFileSync(path.join(env.repo, "src/web/feature.txt"), "utf8")).toBe("feature\n"); // integrated before the crash

    leadCalls = 0;
    const s = await runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, invoker, log: () => {} });
    expect(s.outcome).toBe("completed");
    expect(loadRunState(runDir).blocked_integrations ?? []).toEqual([]);
    expect(fs.readFileSync(path.join(env.repo, "src/web/feature.txt"), "utf8")).toBe("feature\n");
  });

  /** A runner that records every call and answers like a healthy git + gh. */
  function fakePr(over: Partial<Record<string, { ok: boolean; out: string }>> = {}) {
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    const answers: Record<string, { ok: boolean; out: string }> = {
      "git symbolic-ref": { ok: true, out: "origin/main" },
      "git push": { ok: true, out: "" },
      "gh pr": { ok: true, out: "https://github.com/o/r/pull/9\n" },
      ...(over as Record<string, { ok: boolean; out: string }>),
    };
    const run: CommandRunner = (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      return answers[`${cmd} ${args[0]}`] ?? { ok: false, out: "unexpected" };
    };
    return { run, calls };
  }

  /** A `done` mail from `from` with extra frontmatter lines (e.g. "open_pr: true") and the given outcome. */
  function leadDone(i: { project: ResolvedProject }, extra: string, outcome = "completed", from = "lead") {
    write(
      path.join(outboxDir(i.project, from), `${Math.random()}.md`),
      `---\nto: ${from}\ntype: done\nsubject: bye\noutcome: ${outcome}\n${extra}---\n\n${FULL_DONE}\n`,
    );
  }

  describe("opening a pull request", () => {
    function concurrentRepo() {
      env = makeEnv();
      initGitRepo(env.repo);
      makeConcurrent(env, 2);
    }

    it("pushes the lead's branch and opens a PR when the lead's completed done asks for it", async () => {
      concurrentRepo();
      const pr = fakePr();
      let leadRoot = "";
      const { summary, runDir } = await start(async (i) => {
        leadRoot = i.workspace!.root;
        write(path.join(i.workspace!.dir, "src/web/new.txt"), "n\n");
        leadDone(i, "open_pr: true\n");
        return OK;
      }, { pr: pr.run });
      expect(summary.outcome).toBe("completed");
      expect(summary.pr).toEqual({ status: "opened", url: "https://github.com/o/r/pull/9" });
      expect(loadRunState(runDir).pr_url).toBe("https://github.com/o/r/pull/9");
      expect(pr.calls.map((c) => `${c.cmd} ${c.args[0]}`)).toEqual(["git symbolic-ref", "git push", "gh pr"]);
      expect(pr.calls.every((c) => c.cwd === leadRoot)).toBe(true); // git and gh run in the lead's worktree, not in your repo
      expect(leadRoot).not.toBe(env.repo);
      expect(pr.calls[1]!.args).toEqual(["push", "-u", "origin", summary.resultBranch!.branch]);
      const body = fs.readFileSync(path.join(runDir, "pr-body.md"), "utf8");
      expect(body.trimEnd().endsWith(PR_FOOTER)).toBe(true);
      expect(body).not.toMatch(/tech-lead/i);
    });

    it("does nothing when done does not ask for a PR", async () => {
      concurrentRepo();
      const pr = fakePr();
      const { summary, runDir } = await start(async (i) => {
        write(path.join(i.workspace!.dir, "src/web/new.txt"), "n\n");
        leadDone(i, "");
        return OK;
      }, { pr: pr.run });
      expect(summary.pr).toBeUndefined();
      expect(pr.calls).toEqual([]);
      expect(loadRunState(runDir).pr_url).toBeUndefined();
      expect(fs.existsSync(path.join(runDir, "pr-body.md"))).toBe(false);
    });

    it("ignores open_pr unless it is the boolean true", async () => {
      concurrentRepo();
      const pr = fakePr();
      const { summary } = await start(async (i) => {
        write(path.join(i.workspace!.dir, "src/web/new.txt"), "n\n");
        leadDone(i, 'open_pr: "yes"\n');
        return OK;
      }, { pr: pr.run });
      expect(summary.pr).toBeUndefined();
      expect(pr.calls).toEqual([]);
    });

    it("only the lead can ask: a member's mail with open_pr is never read", async () => {
      env = makeEnv();
      initGitRepo(env.repo);
      makeParallel(env);
      makeConcurrent(env, 2);
      const pr = fakePr();
      let leadCalls = 0;
      const { summary } = await start(async (i) => {
        if (i.agent.name === "lead") {
          if (++leadCalls === 1) {
            mail(i.project, "lead", "fe-member", "job", "task");
          } else {
            leadDone(i, "");
          }
        } else {
          write(path.join(i.workspace!.dir, "src/web/feature.txt"), "built\n");
          write(
            path.join(outboxDir(i.project, i.agent.name), `${Math.random()}.md`),
            `---\nto: lead\ntype: reply\nsubject: finished\nopen_pr: true\n---\n\nbody of finished\n`,
          );
        }
        return OK;
      }, { pr: pr.run });
      expect(summary.outcome).toBe("completed");
      expect(summary.pr).toBeUndefined();
      expect(pr.calls).toEqual([]);
    });

    it("does not open a PR for a run that did not complete, and says why", async () => {
      concurrentRepo();
      const pr = fakePr();
      const { summary, runDir } = await start(async (i) => {
        write(path.join(i.workspace!.dir, "src/web/new.txt"), "n\n");
        leadDone(i, "open_pr: true\n", "partial");
        return OK;
      }, { pr: pr.run });
      expect(summary.outcome).toBe("partial");
      expect(summary.pr).toMatchObject({ status: "skipped" });
      expect(pr.calls).toEqual([]);
      expect(loadRunState(runDir).notes?.join("\n")).toMatch(/pull request was asked for but not opened/);
    });

    it("does not open a PR when the lead's branch has no changes", async () => {
      concurrentRepo();
      const pr = fakePr();
      const { summary } = await start(async (i) => {
        leadDone(i, "open_pr: true\n");
        return OK;
      }, { pr: pr.run });
      expect(summary.pr).toMatchObject({ status: "skipped", reason: expect.stringMatching(/no file changes/) });
      expect(pr.calls).toEqual([]);
    });

    it("does not open a PR for a run without its own worktree, and points at max_concurrent_runs", async () => {
      env = makeEnv();
      initGitRepo(env.repo); // max_concurrent_runs stays 1: the lead works in the repo itself
      const pr = fakePr();
      const { summary } = await start(async (i) => {
        leadDone(i, "open_pr: true\n");
        return OK;
      }, { pr: pr.run });
      expect(summary.outcome).toBe("completed");
      expect(summary.pr).toMatchObject({ status: "skipped", reason: expect.stringMatching(/max_concurrent_runs/) });
      expect(pr.calls).toEqual([]);
    });

    it("keeps the outcome and the branch when the push fails, and prints how to finish by hand", async () => {
      concurrentRepo();
      const pr = fakePr({ "git push": { ok: false, out: "remote: denied" } });
      const { summary, runDir } = await start(async (i) => {
        write(path.join(i.workspace!.dir, "src/web/new.txt"), "n\n");
        leadDone(i, "open_pr: true\n");
        return OK;
      }, { pr: pr.run });
      expect(summary.outcome).toBe("completed");
      expect(summary.pr).toMatchObject({ status: "failed", step: "push", reason: "remote: denied" });
      expect(loadRunState(runDir).pr_url).toBeUndefined();
      expect(git(env.repo, "branch", "--list", summary.resultBranch!.branch)).toContain("run-1/lead");
      expect(loadRunState(runDir).notes?.join("\n")).toMatch(/push -u origin/);
    });

    it("a solo agent, which is its own lead, can ask for a PR from its branch", async () => {
      concurrentRepo();
      const project = env.project();
      const runDir = path.join(project.paths.runs, "run-1");
      const task = prepareTask({ text: "go", cwd: env.root, runDir });
      const pr = fakePr();
      const summary = await runTeam({
        project,
        task,
        runDir,
        soloAgent: "fe-member",
        log: () => {},
        pr: pr.run,
        invoker: async (i) => {
          write(path.join(i.workspace!.dir, "src/web/solo.txt"), "solo\n");
          leadDone(i, "open_pr: true\n", "completed", "fe-member");
          return OK;
        },
      });
      expect(summary.outcome).toBe("completed");
      expect(summary.pr).toEqual({ status: "opened", url: "https://github.com/o/r/pull/9" });
      expect(pr.calls[1]!.args).toEqual(["push", "-u", "origin", "agent-lyceum/run-1/fe-member"]);
    });
  });
});
