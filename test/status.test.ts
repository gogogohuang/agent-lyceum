import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatStatus } from "../src/status.js";
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
    expect(formatStatus(env.project(), NOW)).toContain("Active now: idle");
  });

  it("shows a working agent with elapsed time and handled message", () => {
    env = makeEnv();
    writeRun(env, { pid: process.pid, active });
    expect(formatStatus(env.project(), NOW)).toContain('#1 lead WORKING for 42s — task from user: "Build it"');
  });

  it("marks a dead run's active agent as interrupted", () => {
    env = makeEnv();
    writeRun(env, { pid: 2 ** 22 + 12345, active });
    const out = formatStatus(env.project(), NOW);
    expect(out).toContain("interrupted (was working on)");
    expect(out).not.toContain("WORKING");
  });
});
