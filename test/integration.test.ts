import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTeam } from "../src/dispatcher.js";
import { setFaultHook } from "../src/message-store.js";
import { outboxDir } from "../src/policy.js";
import { bindRunProject, loadRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { collectAgentChanges, globMatch, integrateAgentChanges, prepareAgentWorkspace, snapshotBase, type AgentWorkspace } from "../src/worktree.js";
import { git, initGitRepo, makeEnv, makeParallel, write, type TestEnv } from "./helpers.js";
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

  async function start(invoker: Parameters<typeof runTeam>[0]["invoker"]) {
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    const summary = await runTeam({ project, task, runDir, invoker, log: () => {} });
    return { summary, runDir, bound: bindRunProject(env.project(), runDir, "run") };
  }

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
});
