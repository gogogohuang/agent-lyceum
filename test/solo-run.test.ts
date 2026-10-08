import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { outboxDir } from "../src/policy.js";
import { loadRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { FULL_DONE, makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const CANCELLED: WakeResult = { ok: false, text: "", exitCode: null, timedOut: false, cancelled: true };
const mail = (project: Parameters<typeof outboxDir>[0], from: string, to: string, type: string, subject: string) =>
  write(
    path.join(outboxDir(project, from), `${subject.replace(/\W+/g, "-")}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${type === "done" ? FULL_DONE : "## Goal\nx\n\n## Acceptance criteria\nx\n\n## Scope\nx\n\n## Upstream\nNone\n"}\n`,
  );

function setup() {
  env = makeEnv();
  const project = env.project();
  const runDir = path.join(project.paths.runs, "run-solo");
  return { project, runDir, task: prepareTask({ text: "clarify the login story", cwd: env.root, runDir }) };
}

describe("runTeam with soloAgent", () => {
  it("wakes only that agent, gives it a solo prompt, and ends on its done", async () => {
    const { project, runDir, task } = setup();
    const woken: string[] = [];
    let system = "";
    let agentSeen: { canMessage: unknown; canAskUser: boolean; canEditAgentMd: boolean } | undefined;
    const invoker: Invoker = async (i) => {
      woken.push(i.agent.name);
      system = i.systemPrompt;
      agentSeen = i.agent;
      mail(i.project, "fe-member", "fe-member", "done", "all done");
      return OK;
    };
    const s = await runTeam({ project, task, runDir, soloAgent: "fe-member", invoker, log: () => {} });
    expect(woken).toEqual(["fe-member"]);
    expect(s.endReason).toBe("done");
    expect(s.outcome).toBe("completed");
    expect(system).toMatch(/working alone/);
    expect(agentSeen).toMatchObject({ canMessage: [], canAskUser: false, canEditAgentMd: false });
    expect(loadRunState(runDir).solo_agent).toBe("fe-member");
  });

  it("also works when the chosen agent is the project's own lead", async () => {
    const { project, runDir, task } = setup();
    const woken: string[] = [];
    let agentSeen: { canMessage: unknown; canAskUser: boolean; canEditAgentMd: boolean } | undefined;
    const invoker: Invoker = async (i) => {
      woken.push(i.agent.name);
      agentSeen = i.agent;
      mail(i.project, "lead", "lead", "done", "all done");
      return OK;
    };
    const s = await runTeam({ project, task, runDir, soloAgent: "lead", invoker, log: () => {} });
    expect(woken).toEqual(["lead"]);
    expect(agentSeen).toMatchObject({ canMessage: [], canAskUser: false, canEditAgentMd: false });
    expect(s.endReason).toBe("done");
  });

  it("never wakes anyone else, even when the solo agent tries to mail the lead", async () => {
    const { project, runDir, task } = setup();
    const woken: string[] = [];
    const invoker: Invoker = async (i) => {
      woken.push(i.agent.name);
      if (woken.length === 1) mail(i.project, "fe-member", "lead", "task", "hand over");
      else mail(i.project, "fe-member", "fe-member", "done", "all done");
      return OK;
    };
    const s = await runTeam({ project, task, runDir, soloAgent: "fe-member", invoker, log: () => {} });
    expect(new Set(woken)).toEqual(new Set(["fe-member"]));
    expect(s.endReason).toBe("done");
  });

  it("a resumed run stays solo even when the caller does not say so", async () => {
    const { project, runDir, task } = setup();
    const ac = new AbortController();
    const first: Invoker = (i) =>
      new Promise((resolve) => {
        setTimeout(() => ac.abort(), 20);
        i.signal!.addEventListener("abort", () => resolve(CANCELLED));
      });
    const s1 = await runTeam({ project, task, runDir, soloAgent: "fe-member", invoker: first, signal: ac.signal, log: () => {} });
    expect(s1.endReason).toBe("cancelled");

    const woken: string[] = [];
    const s2 = await runTeam({
      project: env.project(),
      resume: loadRunState(runDir),
      runDir,
      invoker: async (i) => {
        woken.push(i.agent.name);
        mail(i.project, "fe-member", "fe-member", "done", "all done");
        return OK;
      },
      log: () => {},
    });
    expect(woken).toEqual(["fe-member"]);
    expect(s2.endReason).toBe("done");
    expect(fs.existsSync(path.join(runDir, "result.md"))).toBe(true);
  });

  it("refuses an agent that is not a member of the project, before writing anything", async () => {
    const { project, runDir, task } = setup();
    await expect(runTeam({ project, task, runDir, soloAgent: "nobody", invoker: async () => OK, log: () => {} })).rejects.toThrow(/not a member/);
    expect(fs.existsSync(path.join(runDir, "state.json"))).toBe(false);
  });
});
