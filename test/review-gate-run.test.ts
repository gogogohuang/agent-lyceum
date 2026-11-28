import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WakeInput, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { outboxDir } from "../src/policy.js";
import { loadRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { FULL_DONE, initGitRepo, makeEnv, withSections, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
let seq = 0;
const send = (i: WakeInput, to: string, type: string, subject: string) =>
  write(
    path.join(outboxDir(i.project, i.agent.name), `${String(++seq).padStart(6, "0")}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${type === "done" ? FULL_DONE : withSections(type, subject)}\n`,
  );

describe("cross-runtime gate in a run", () => {
  it("turns the third completed done into partial when the other runtime never passes", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    env.editProjectYaml((t) => t.replace("  qa-member:\n    can_message", "  qa-member:\n    runtime: codex\n    can_message"));
    const project = env.project();
    expect(project.agents["qa-member"]?.runtime).toBe("codex");
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "go", cwd: env.root, runDir });
    let lead = 0;
    const summary = await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      invoker: async (i) => {
        if (i.agent.name === "lead") {
          lead += 1;
          if (lead === 1) send(i, "fe-member", "task", "write it");
          else send(i, "lead", "done", "bye");
        } else {
          write(path.join(i.workspace!.dir, "kept.txt"), "kept\n");
          send(i, "lead", "reply", "wrote");
        }
        return OK;
      },
    });
    expect(summary.outcome).toBe("partial");
    expect(summary.outcomeNote).toContain("verdict: pass");
    expect(loadRunState(runDir).done_rejections).toBe(2);
    expect(fs.existsSync(path.join(runDir, "result.md"))).toBe(true);
  });
});
