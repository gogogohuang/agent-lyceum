import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { briefOf, parseSteps } from "../src/format.js";
import { deliver } from "../src/mailbox.js";
import { acquireProjectLock } from "../src/project-lock.js";
import { loadRunState } from "../src/run-store.js";
import { formatRunDetail, formatStatus, formatTaskList } from "../src/status.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const NOW = Date.parse("2026-01-01T00:01:00Z");

function writeRun(env: TestEnv, state: Record<string, unknown>): void {
  const dir = path.join(env.project().paths.runs, "20260101-000000");
  write(
    path.join(dir, "state.json"),
    JSON.stringify({
      run_id: "20260101-000000",
      rounds: 1,
      max_rounds: 10,
      last_wake: {},
      wakes: [],
      ...state,
    }),
  );
  fs.mkdirSync(dir, { recursive: true });
}

const active = { lead: { round: 1, since: "2026-01-01T00:00:18Z", handling: [{ from: "user", type: "task", subject: "Build it" }] } };

describe("status: active now", () => {
  it("says idle when there is no run", () => {
    env = makeEnv();
    expect(formatStatus(env.project(), NOW)).toContain("現在：    閒置");
  });

  it("shows a working agent with elapsed time and handled message", () => {
    env = makeEnv();
    writeRun(env, { pid: process.pid, active });
    expect(formatStatus(env.project(), NOW)).toContain('lead 工作中 42s，處理 來自 user 的 task：「Build it」');
  });

  it("marks a dead run's active agent as interrupted", () => {
    env = makeEnv();
    writeRun(env, { pid: 2 ** 22 + 12345, active });
    const out = formatStatus(env.project(), NOW);
    expect(out).toContain("曾在工作（已中斷）");
    expect(out).not.toContain("工作中");
  });
});

describe("status: progress, next, flow", () => {
  it("shows checklist progress and the next step", () => {
    env = makeEnv();
    writeRun(env, { pid: process.pid, steps: [{ text: "design", done: true }, { text: "build", done: false }, { text: "test", done: false }] });
    expect(formatStatus(env.project(), NOW)).toContain("目前：build");
  });

  it("warns when the lead is done with unticked steps", () => {
    env = makeEnv();
    writeRun(env, { pid: process.pid, end_reason: "done", steps: [{ text: "design", done: true }, { text: "build", done: false }] });
    const out = formatStatus(env.project(), NOW);
    expect(out).toContain("步驟「build」尚未勾選");
    expect(out).not.toContain("下一步：");
  });

  it("falls back to rounds when there is no checklist", () => {
    env = makeEnv();
    writeRun(env, { pid: process.pid });
    expect(formatStatus(env.project(), NOW)).toContain("無清單；已用 1/10 輪");
  });

  it("names who is woken next, lead first", () => {
    env = makeEnv();
    writeRun(env, { pid: process.pid });
    const p = env.project();
    deliver(p, { from: "lead", to: "fe-member", type: "task", subject: "Build UI", body: "x" });
    deliver(p, { from: "qa-member", to: "lead", type: "reply", subject: "Tested", body: "x" });
    const out = formatStatus(p, NOW);
    expect(out).toContain('下一個：  lead ← 來自 qa-member 的 reply：「Tested」');
    expect(out).toContain('fe-member ← 來自 lead 的 task：「Build UI」');
  });

  it("shows what the last wake handed off and the flow", () => {
    env = makeEnv();
    const w = (round: number, agent: string, sent: unknown[]) => ({ round, agent, at: "t", duration_ms: 1000, ok: true, handling: [], sent });
    writeRun(env, {
      pid: process.pid,
      wakes: [
        w(1, "lead", [{ to: "fe-member", type: "task", subject: "Build UI" }]),
        w(2, "fe-member", [{ to: "lead", type: "reply", subject: "UI built" }]),
      ],
      active: { lead: { round: 3, since: "2026-01-01T00:00:50Z", handling: [] } },
    });
    const out = formatStatus(env.project(), NOW);
    expect(out).toContain('上一次：  #2 fe-member 成功 → lead ← reply「UI built」');
    expect(out).toContain("流程：    lead → fe-member → [lead]");
  });

  it("includes a brief of the handled message", () => {
    env = makeEnv();
    const h = [{ from: "lead", type: "task", subject: "Review", brief: "check the auth middleware" }];
    writeRun(env, { pid: process.pid, active: { lead: { round: 1, since: "2026-01-01T00:00:50Z", handling: h } } });
    expect(formatStatus(env.project(), NOW)).toContain('「Review」 — check the auth middleware');
  });
});

describe("format helpers", () => {
  it("parses checklists under ## Steps only", () => {
    const body = "## Goal\n- [ ] not a step\n\n## Steps\n- [x] one\n* [ ] two\n\n## Scope\n- [ ] nope";
    expect(parseSteps(body)).toEqual([
      { text: "one", done: true },
      { text: "two", done: false },
    ]);
    expect(parseSteps("- [ ] a\n- [X] b", false)).toEqual([
      { text: "a", done: false },
      { text: "b", done: true },
    ]);
    expect(parseSteps("no steps here")).toEqual([]);
  });

  it("briefs a message from Changes, Goal, or the first prose line", () => {
    expect(briefOf("## Changes\n- added login\n\n## Risks\nNone")).toBe("added login");
    expect(briefOf("[agent-lyceum] Format warning: x\n\n## Goal\nShip it")).toBe("Ship it");
    expect(briefOf("# Title\n\nJust text")).toBe("Just text");
  });
});

describe("status: color", () => {
  it("is plain by default and adds ANSI codes when asked", () => {
    env = makeEnv();
    writeRun(env, { pid: process.pid, active });
    expect(formatStatus(env.project(), NOW)).not.toContain("\x1b[");
    const colored = formatStatus(env.project(), NOW, true);
    expect(colored).toContain("\x1b[32m執行中\x1b[0m");
    expect(colored.replace(/\x1b\[\d+m/g, "")).toBe(formatStatus(env.project(), NOW));
  });
});

describe("status --task-list", () => {
  it("lists every run with id and state, newest first", () => {
    env = makeEnv();
    writeRun(env, { pid: 2 ** 22 + 12345, task_summary: "Build it", steps: [{ text: "a", done: true }, { text: "b", done: false }] });
    write(
      path.join(env.project().paths.runs, "20260102-000000", "state.json"),
      JSON.stringify({ run_id: "20260102-000000", rounds: 3, max_rounds: 10, last_wake: {}, wakes: [], end_reason: "done", task_summary: "Ship it" }),
    );
    const out = formatTaskList(env.project());
    expect(out).toContain("共 2 個任務");
    expect(out.indexOf("20260102-000000")).toBeLessThan(out.indexOf("20260101-000000"));
    expect(out).toMatch(/20260102-000000\s+已結束：完成（未驗證）\s+3\/10\s+-\s+Ship it/);
    expect(out).toMatch(/20260101-000000\s+已中斷\s+1\/10\s+b\s+Build it/);
  });

  it("says so when there are no runs", () => {
    env = makeEnv();
    expect(formatTaskList(env.project())).toContain("無執行紀錄");
  });
});

describe("status: project lock decides whether a run is running", () => {
  it("trusts the lock holder over the recorded pid for schema-2 runs", () => {
    env = makeEnv();
    const pr = env.project();
    writeRun(env, { schema_version: 2, mail_layout: "legacy", pid: 2 ** 22 + 12345, active });
    expect(formatStatus(pr, NOW)).toContain("曾在工作（已中斷）");
    const lease = acquireProjectLock(pr.paths.root, "20260101-000000");
    try {
      expect(formatStatus(pr, NOW)).toContain("lead 工作中 42s");
    } finally {
      lease.release();
    }
  });

  it("does not call a run running because a different run holds the lock", () => {
    env = makeEnv();
    const pr = env.project();
    writeRun(env, { schema_version: 2, mail_layout: "legacy", pid: process.pid, active });
    const lease = acquireProjectLock(pr.paths.root, "some-other-run");
    try {
      expect(formatStatus(pr, NOW)).toContain("曾在工作（已中斷）");
    } finally {
      lease.release();
    }
  });
});

describe("status: recovery notes", () => {
  it("shows what recovery warned about", () => {
    env = makeEnv();
    writeRun(env, { pid: process.pid, notes: ["fe-member attempt 1 was interrupted; side effects may have happened."] });
    const out = formatTaskList(env.project());
    expect(out).toContain("20260101-000000");
    const detail = formatRunDetail({ dir: "/x", state: loadRunState(path.join(env.project().paths.runs, "20260101-000000")) }, NOW);
    expect(detail).toContain("⚠ fe-member attempt 1 was interrupted");
  });
});
