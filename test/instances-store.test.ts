import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertInstancesResumable, heldStallKey, ownersOf, senderLabel } from "../src/instances.js";
import { RouteJournal } from "../src/message-store.js";
import { assertSupportedVersion, bindRunProject, loadRunState, newRunState, saveRunState, STATE_SCHEMA_VERSION } from "../src/run-store.js";
import { makeEnv, type TestEnv } from "./helpers.js";

// Spec 23.6 (state v3, binding), 23.7.2 (journal records the assigner reads), 23.8.1/23.14 (journal), 23.10 (resume refusals).

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("state schema (23.6)", () => {
  it("a new run is written as v2; this version reads up to v3", () => {
    expect(STATE_SCHEMA_VERSION).toBe(3);
    expect(newRunState({ run_id: "r" }).schema_version).toBe(2);
  });

  it("assertSupportedVersion(3, 2) refuses with 'Upgrade' (the old binary's failure); 2 and 1 pass", () => {
    expect(() => assertSupportedVersion(3, 2, "state.json")).toThrow(/newer than this agent-lyceum understands \(2\)\. Upgrade agent-lyceum\./);
    expect(() => assertSupportedVersion(2, 2, "state.json")).not.toThrow();
    expect(() => assertSupportedVersion(undefined, 2, "state.json")).not.toThrow();
  });

  it("a v3 state with instances round-trips; a v2 state without them loads unchanged", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inst-state-"));
    try {
      const s = newRunState({ run_id: "r" });
      saveRunState(dir, s);
      expect(loadRunState(dir).instances).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"))).not.toHaveProperty("instances");
      s.schema_version = 3;
      s.instances = { roles: { fe: ["fe", "fe--2"] } };
      saveRunState(dir, s);
      const back = loadRunState(dir);
      expect(back.schema_version).toBe(3);
      expect(back.instances).toEqual({ roles: { fe: ["fe", "fe--2"] } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an empty instance list is not a valid slot table", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inst-state-"));
    try {
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ run_id: "r", schema_version: 3, instances: { roles: { fe: [] } } }));
      expect(() => loadRunState(dir)).toThrow(/instances/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bindRunProject with a slot table (23.6 Binding, 23.11 shape)", () => {
  it("without instances the bound project is exactly what it was (no instance fields)", () => {
    env = makeEnv();
    const p = bindRunProject(env.project(), "/x/runs/run-1", "run");
    for (const a of Object.values(p.agents)) {
      expect(a.instance).toBeUndefined();
      expect(a.sharedMemory).toBeUndefined();
    }
  });

  it("adds fe-member--2 after fe-member with its own task memory, read-only shared memory and no can_edit_agent_md", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("    # memory: { project: agents/fe-member/memory }", "    memory: { project: agents/fe-member/memory }"));
    const base = env.project();
    const p = bindRunProject(base, "/x/runs/run-1", "run", { roles: { "fe-member": ["fe-member", "fe-member--2", "fe-member--3"] } });
    const names = Object.keys(p.agents);
    expect(names.slice(names.indexOf("fe-member"), names.indexOf("fe-member") + 3)).toEqual(["fe-member", "fe-member--2", "fe-member--3"]);
    expect(p.agents["fe-member"]?.instance).toEqual({ role: "fe-member", k: 1 });
    const two = p.agents["fe-member--2"];
    expect(two?.instance).toEqual({ role: "fe-member", k: 2 });
    expect(two?.memory).toEqual({ task: path.join(base.paths.taskMemory, "run-1", "fe-member--2") });
    expect(two?.sharedMemory).toEqual({ global: base.agents["fe-member"]?.memory.global, project: base.agents["fe-member"]?.memory.project });
    expect(two?.canEditAgentMd).toBe(false);
    expect(two?.runtime).toBe(base.agents["fe-member"]?.runtime);
    expect(p.agents["fe-member"]?.memory.task).toBe(path.join(base.paths.taskMemory, "run-1", "fe-member"));
    expect(p.agents["fe-member"]?.sharedMemory).toBeUndefined();
    // roles outside the table are untouched
    expect(p.agents["qa-member"]?.instance).toBeUndefined();
  });

  it("ignores a table entry for a role that is no longer configured", () => {
    env = makeEnv();
    const p = bindRunProject(env.project(), "/x/runs/run-1", "run", { roles: { ghost: ["ghost", "ghost--2"] } });
    expect(p.agents["ghost--2"]).toBeUndefined();
  });
});

describe("presentation helpers (decision 8, 23.12.4)", () => {
  it("senderLabel names the role and number for instances, and is the plain name otherwise", () => {
    expect(senderLabel("fe--2", { fe: { instance: undefined } as never, "fe--2": { instance: { role: "fe", k: 2 } } as never })).toBe("fe--2 (fe, instance 2)");
    expect(senderLabel("fe", { fe: { instance: { role: "fe", k: 1 } } as never })).toBe("fe (fe, instance 1)");
    expect(senderLabel("fe", { fe: {} as never })).toBe("fe");
    expect(senderLabel("dispatcher", {})).toBe("dispatcher");
  });

  it("heldStallKey depends only on the set of ids", () => {
    expect(heldStallKey(["b", "a"])).toBe(heldStallKey(["a", "b"]));
    expect(heldStallKey(["a"])).not.toBe(heldStallKey(["a", "b"]));
    expect(heldStallKey(["a"])).toMatch(/^held-stall:[0-9a-f]{16}$/);
  });
});

describe("RouteJournal records for the assigner (23.14)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inst-journal-"));
    fs.mkdirSync(path.join(dir, "mail"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const e = (source: string, to: string, extra: object = {}) => ({ source, to, msg_id: `id-${source}`, file: `20260101T000000000Z-lead-id-${source}.md`, created: "2026-01-01T00:00:00.000Z", ...extra });
  const read = () => fs.readFileSync(path.join(dir, "mail", "journal.jsonl"), "utf8");

  it("an intent without the new fields is written byte-for-byte as before", () => {
    new RouteJournal(dir).intent(e("a", "fe"));
    expect(read()).toBe(`${JSON.stringify({ t: "intent", ...e("a", "fe") })}\n`);
  });

  it("keeps held/parallel/from/about across a restart and indexes by msg_id and file", () => {
    const j = new RouteJournal(dir);
    j.intent(e("a", "fe"));
    j.intent(e("b", "fe", { held: true, parallel: true, from: "lead" }));
    j.intent(e("c", "lead", { from: "dispatcher", about: "fe--2" }));
    const k = new RouteJournal(dir);
    const b = k.get("b", "fe");
    expect(b).toMatchObject({ held: true, parallel: true, from: "lead" });
    expect(k.get("a", "fe")?.held).toBeUndefined();
    expect(k.byFile(e("b", "fe").file)?.msg_id).toBe("id-b");
    expect(k.ownership("id-c")).toMatchObject({ about: "fe--2", intent: { to: "lead", source: "c", msg_id: "id-c" } });
    expect(k.ownership("nope")).toBeUndefined();
  });

  it("firstHeld is the line position of the first held intent for a recipient name; earlier plain intents are before it", () => {
    const j = new RouteJournal(dir);
    j.intent(e("a", "fe"));
    j.intent(e("b", "fe", { held: true }));
    j.intent(e("c", "fe", { held: true }));
    const k = new RouteJournal(dir);
    expect(k.firstHeld("lead")).toBeUndefined();
    const mark = k.firstHeld("fe");
    expect(mark).toBeDefined();
    expect(k.ownership("id-a")?.intent?.seq).toBeLessThan(mark as number);
    expect(k.ownership("id-b")?.intent?.seq).toBe(mark);
    expect(k.ownership("id-c")?.intent?.seq).toBeGreaterThan(mark as number);
  });

  it("assign lines are appended, fsynced in order, read back, and a torn assign is ignored", () => {
    const j = new RouteJournal(dir);
    j.intent(e("a", "fe", { held: true }));
    j.assign({ msg_id: "id-a", file: e("a", "fe").file, role: "fe", slot: "fe--2" });
    expect(j.assigned("id-a")).toEqual({ slot: "fe--2", file: e("a", "fe").file, role: "fe" });
    expect(new RouteJournal(dir).assigned("id-a")?.slot).toBe("fe--2");
    expect(new RouteJournal(dir).ownership("id-a")?.assign).toBe("fe--2");
    fs.appendFileSync(path.join(dir, "mail", "journal.jsonl"), `{"t":"assign","msg_id":"id-z","file":"f","role":"fe","slo`);
    const torn = new RouteJournal(dir);
    expect(torn.assigned("id-z")).toBeUndefined();
    torn.assign({ msg_id: "id-y", file: "f", role: "fe", slot: "fe" });
    expect(new RouteJournal(dir).assigned("id-y")?.slot).toBe("fe");
  });

  it("ownership feeds ownersOf: assign beats from beats about, and only open instances count", () => {
    const j = new RouteJournal(dir);
    j.intent(e("a", "qa", { held: true, from: "fe--2" }));
    j.assign({ msg_id: "id-a", file: e("a", "qa").file, role: "qa", slot: "qa--2" });
    const k = new RouteJournal(dir);
    const ctx = (opened: string[]) => ({ opened, rec: (id: string) => k.ownership(id), mark: k.firstHeld("qa"), claimAgent: () => undefined });
    expect(ownersOf("id-a", "fe", ctx(["fe", "fe--2"]))).toBe("fe--2");
    expect(ownersOf("id-a", "qa", ctx(["qa", "qa--2"]))).toBe("qa--2");
  });
});

describe("assertInstancesResumable (23.10)", () => {
  const agents = { lead: {}, fe: {}, "fe--x": {} } as never;
  const base = { lead: "lead", agents } as never;
  it("passes for a table whose roles are configured members and whose slot names are free", () => {
    expect(() => assertInstancesResumable(base, { roles: { fe: ["fe", "fe--2"] } }, "run-1", "demo")).not.toThrow();
  });
  it("refuses a role that is no longer an agent, naming the run, the role and the project", () => {
    expect(() => assertInstancesResumable(base, { roles: { gone: ["gone", "gone--2"] } }, "run-1", "demo")).toThrow(/Run run-1 has instances of "gone", which is no longer an agent of project demo/);
  });
  it("refuses a role that is now the lead", () => {
    expect(() => assertInstancesResumable(base, { roles: { lead: ["lead", "lead--2"] } }, "run-1", "demo")).toThrow(/lead/);
  });
  it("refuses an opened instance name that is now a configured agent", () => {
    const b = { lead: "lead", agents: { lead: {}, fe: {}, "fe--2": {} } } as never;
    expect(() => assertInstancesResumable(b, { roles: { fe: ["fe", "fe--2"] } }, "run-1", "demo")).toThrow(/"fe--2"/);
  });
  it("refuses when the injected containment check names a conflict for an opened instance", () => {
    expect(() => assertInstancesResumable(base, { roles: { fe: ["fe", "fe--2"] } }, "run-1", "demo", (role, k) => (k === 2 ? `${role} conflict` : undefined))).toThrow(/fe--2.*fe conflict/);
  });
});
