import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WakeInput, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { outboxDir } from "../src/policy.js";
import { loadRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { commitWorkspace, existingAgentWorkspace } from "../src/worktree.js";
import { FULL_DONE, initGitRepo, makeEnv, withSections, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
let seq = 0;
const send = (i: WakeInput, to: string, type: string, subject: string, front = "") =>
  write(
    path.join(outboxDir(i.project, i.agent.name), `${String(++seq).padStart(6, "0")}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}${front}---\n\n${type === "done" ? FULL_DONE : withSections(type, subject)}\n`,
  );

function start() {
  env = makeEnv();
  initGitRepo(env.repo);
  const project = env.project();
  const runDir = path.join(project.paths.runs, "run-1");
  const task = prepareTask({ text: "go", cwd: env.root, runDir });
  return { project, runDir, task };
}

const claims = (runDir: string) => {
  const dir = path.join(runDir, "mail", "claims");
  return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as { id: string; agent: string; status: string; read_only?: true; head?: string });
};

describe("read-only wakes", () => {
  it("keeps a writable commit and drops what a later investigate wake committed", async () => {
    const { project, runDir, task } = start();
    let lead = 0;
    let member = 0;
    const summary = await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      invoker: async (i) => {
        if (i.agent.name === "lead") {
          lead += 1;
          if (lead === 1) send(i, "fe-member", "task", "write it");
          else if (lead === 2) send(i, "fe-member", "task", "look", "playbook: investigate\n");
          else send(i, "lead", "done", "bye");
        } else {
          member += 1;
          if (member === 1) write(path.join(i.workspace!.dir, "kept.txt"), "kept\n");
          else {
            write(path.join(i.workspace!.dir, "during.txt"), "during\n");
            commitWorkspace(i.workspace!, "during");
          }
          send(i, "lead", "reply", "done");
        }
        return OK;
      },
    });
    expect(summary.outcome).toBe("completed");
    const again = env.project();
    const fe = existingAgentWorkspace(again, "run-1", "fe-member")!;
    const leadWs = existingAgentWorkspace(again, "run-1", "lead")!;
    expect(fs.readFileSync(path.join(fe.dir, "kept.txt"), "utf8")).toBe("kept\n");
    expect(fs.readFileSync(path.join(leadWs.dir, "kept.txt"), "utf8")).toBe("kept\n");
    expect(fs.existsSync(path.join(fe.dir, "during.txt"))).toBe(false);
    expect(fs.existsSync(path.join(leadWs.dir, "during.txt"))).toBe(false);
  });

  it("drops product code the team lead writes and keeps the member's file", async () => {
    const { project, runDir, task } = start();
    let lead = 0;
    const summary = await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      invoker: async (i) => {
        if (i.agent.name === "lead") {
          lead += 1;
          expect(i.policy).toBeDefined();
          expect(i.workspace).toBeDefined();
          expect(i.policy!.allowDirs).not.toContain(i.workspace!.dir);
          expect(i.systemPrompt).toContain("You do not edit product code.");
          if (lead === 1) {
            write(path.join(i.workspace!.dir, "lead-edit.txt"), "nope\n");
            send(i, "fe-member", "task", "write it");
          } else if (lead > 2) send(i, "lead", "done", "bye");
        } else {
          write(path.join(i.workspace!.dir, "kept.txt"), "kept\n");
          send(i, "lead", "reply", "done");
        }
        return OK;
      },
    });
    expect(summary.outcome).toBe("completed");
    const again = env.project();
    const leadWs = existingAgentWorkspace(again, "run-1", "lead")!;
    expect(fs.existsSync(path.join(leadWs.dir, "lead-edit.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(leadWs.dir, "kept.txt"), "utf8")).toBe("kept\n");
  });

  it("discards a read-only commit when the wake fails, before the claim is abandoned", async () => {
    const { project, runDir, task } = start();
    const summary = await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      invoker: async (i) => {
        if (i.agent.name === "lead") {
          send(i, "fe-member", "task", "look", "playbook: investigate\n");
          return OK;
        }
        write(path.join(i.workspace!.dir, "during.txt"), "during\n");
        commitWorkspace(i.workspace!, "during");
        return { ok: false, error: "boom", text: "", exitCode: 1, timedOut: false };
      },
    });
    expect(summary.endReason).toBe("agent_failed");
    const fe = existingAgentWorkspace(env.project(), "run-1", "fe-member")!;
    expect(fs.existsSync(path.join(fe.dir, "during.txt"))).toBe(false);
    const claim = claims(runDir).find((c) => c.agent === "fe-member");
    expect(claim?.status).toBe("abandoned");
    expect(claim?.read_only).toBe(true);
  });

  it("drops a commit left behind when a read-only wake is resumed", async () => {
    const { project, runDir, task } = start();
    await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      invoker: async (i) => {
        if (i.agent.name === "lead") {
          send(i, "fe-member", "task", "look", "playbook: investigate\n");
          return OK;
        }
        write(path.join(i.workspace!.dir, "during.txt"), "during\n");
        commitWorkspace(i.workspace!, "during");
        return { ok: false, error: "boom", text: "", exitCode: 1, timedOut: false };
      },
    });
    const fe = existingAgentWorkspace(env.project(), "run-1", "fe-member")!;
    write(path.join(fe.dir, "left.txt"), "left\n");
    commitWorkspace(fe, "left");
    const claim = claims(runDir).find((c) => c.agent === "fe-member")!;
    write(path.join(runDir, "mail", "claims", `${claim.id}.json`), JSON.stringify({ ...claim, status: "claimed" }));
    await runTeam({
      project: env.project(),
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      invoker: async (i) => {
        if (i.agent.name === "fe-member") {
          expect(fs.existsSync(path.join(i.workspace!.dir, "left.txt"))).toBe(false);
          send(i, "lead", "reply", "looked");
        } else send(i, "lead", "done", "bye");
        return OK;
      },
    });
    const leadWs = existingAgentWorkspace(env.project(), "run-1", "lead")!;
    expect(fs.existsSync(path.join(leadWs.dir, "left.txt"))).toBe(false);
    expect(fs.existsSync(path.join(fe.dir, "left.txt"))).toBe(false);
  });
});
