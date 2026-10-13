import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deliver } from "../src/mailbox.js";
import { buildStatusReport } from "../src/status.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

function writeRun(env: TestEnv): void {
  write(
    path.join(env.project().paths.runs, "20260101-000000", "state.json"),
    JSON.stringify({ run_id: "20260101-000000", rounds: 1, max_rounds: 10, last_wake: {}, wakes: [], pid: process.pid }),
  );
}

describe("status --json: graph data", () => {
  it("lists who each agent may message, with `all` expanded and the agent itself left out", () => {
    env = makeEnv();
    const agents = buildStatusReport(env.project()).agents;
    const by = Object.fromEntries(agents.map((a) => [a.name, a.can_message]));
    expect([...(by.lead ?? [])].sort()).toEqual(["fe-member", "qa-member"]);
    expect(by["fe-member"]).toEqual(["lead"]);
    expect(by["qa-member"]).toEqual(["lead"]);
  });

  it("gives queued mail a brief and a digest", () => {
    env = makeEnv();
    writeRun(env);
    const p = env.project();
    deliver(p, { from: "lead", to: "fe-member", type: "task", subject: "Build UI", body: "## Goal\nShip the login form\n\n## Acceptance criteria\n- /login opens\n" });
    const report = buildStatusReport(p);
    const q = report.run?.queue.find((x) => x.agent === "fe-member");
    expect(q?.brief).toBe("Ship the login form");
    expect(q?.digest).toEqual([
      { label: "目標", lines: ["Ship the login form"] },
      { label: "驗收", lines: ["/login opens"] },
    ]);
    expect(report.schema_version).toBe(1);
  });
});
