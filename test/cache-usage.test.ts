import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WakeInput, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { outboxDir } from "../src/policy.js";
import { buildStatusReport, cacheText } from "../src/status.js";
import { loadRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { FULL_DONE, makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("prompt-cache token usage", () => {
  it("is recorded per wake, summed over the run, and shown by status", async () => {
    env = makeEnv();
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "t", cwd: env.root, runDir });
    const result: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 100 };
    await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      invoker: async (i: WakeInput) => {
        write(path.join(outboxDir(i.project, i.agent.name), "done.md"), `---\nto: ${i.agent.name}\ntype: done\nsubject: s\noutcome: completed\n---\n\n${FULL_DONE}\n`);
        return result;
      },
    });
    const state = loadRunState(runDir);
    expect(state.wakes[0]).toMatchObject({ cache_read_tokens: 900, cache_write_tokens: 100 });
    expect(state.cache_read_tokens).toBe(900 * state.wakes.length);
    expect(state.cache_write_tokens).toBe(100 * state.wakes.length);
    const run = buildStatusReport(project, "run-1").run;
    expect(run).toMatchObject({ cache_read_tokens: state.cache_read_tokens, cache_write_tokens: state.cache_write_tokens });
  });

  it("cacheText says nothing when no cache usage was recorded", () => {
    expect(cacheText(0, 0)).toBe("");
    expect(cacheText(undefined, undefined)).toBe("");
    expect(cacheText(900, 100)).toBe("快取 讀 900 寫 100 命中 90%");
  });
});
