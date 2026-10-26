import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRunState } from "../src/run-store.js";
import { buildStatusReport, formatStatusReport } from "../src/status.js";
import { newWorld, run, send, type Script, type World } from "./instances-harness.js";

// Real git and several wake-ups per test: the default 5 s is too short when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });

// Spec 23.13 / eval 9.7: status --json and the text page show instances; a run that never used them has no new key.

let world: World;
afterEach(() => world?.env.cleanup());

describe("status of a run with instances", () => {
  it("lists the instance rows with role and number, the roles' instances, held mail in the queue, and no unread for held mail", async () => {
    world = newWorld();
    const stall: Script = (w) => {
      if (w.agent === "lead") {
        if (w.n === 1) {
          send(w.i, "fe-member", "task one", "task", "parallel: true\n");
          send(w.i, "fe-member", "task two", "task", "parallel: true\n");
        } else send(w.i, "lead", "bye", "done");
        return;
      }
      send(w.i, "lead", `finished by ${w.agent}`, "reply");
      return;
    };
    await run(world, stall);
    const rep = buildStatusReport(world.project, "run-1");
    const names = rep.agents.map((a) => a.name);
    expect(names).toContain("fe-member--2");
    expect(rep.agents.find((a) => a.name === "fe-member--2")).toMatchObject({ role: "fe-member", instance: 2 });
    expect(rep.agents.find((a) => a.name === "fe-member")).toMatchObject({ role: "fe-member", instance: 1 });
    expect(rep.agents.find((a) => a.name === "lead")).not.toHaveProperty("role");
    expect(rep.run?.instances).toEqual({ "fe-member": ["fe-member", "fe-member--2"] });
    expect(Object.keys(rep.run?.last_wake ?? {})).toEqual(expect.arrayContaining(["fe-member", "fe-member--2"]));
    const text = formatStatusReport(rep, Date.now(), false);
    expect(text).toContain("fe-member #2");
  });

  it("held mail appears in the queue under the role with held: true and is not counted as unread", () => {
    world = newWorld();
    const runDir = world.runDir;
    fs.mkdirSync(path.join(runDir, "mail", "inbox", "fe-member", "pending"), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "mail", "inbox", "fe-member", "pending", "20260101T000000000Z-lead-aaaa1111.md"),
      "---\nid: aaaa1111\nfrom: lead\nto: fe-member\ntype: task\nthread: aaaa1111\nsubject: waiting job\ncreated: 2026-01-01T00:00:00.000Z\n---\n\nbody\n",
    );
    const state = {
      run_id: "run-1",
      schema_version: 3,
      started_at: "2026-01-01T00:00:00.000Z",
      rounds: 1,
      max_rounds: 30,
      output_tokens: 0,
      task_source: "text",
      task_summary: "t",
      active: {},
      wakes: [],
      last_wake: {},
      mail_layout: "run",
      pid: 1,
      instances: { roles: { "fe-member": ["fe-member", "fe-member--2"] } },
    };
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(state));
    expect(loadRunState(runDir).instances?.roles["fe-member"]).toHaveLength(2);
    const rep = buildStatusReport(world.project, "run-1");
    expect(rep.run?.queue).toEqual([expect.objectContaining({ agent: "fe-member", held: true, subject: "waiting job" })]);
    expect(rep.agents.find((a) => a.name === "fe-member")?.unread).toBe(0);
  });
});
