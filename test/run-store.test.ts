import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertName } from "../src/paths.js";
import { loadRunState, newRunId, newRunState, saveRunState } from "../src/run-store.js";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "run-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("newRunId", () => {
  it("is unique across 10,000 ids generated at the same instant and always a valid name", () => {
    const at = new Date("2026-10-06T01:02:03.456Z");
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const id = newRunId(at);
      assertName("run", id);
      expect(id.length).toBeLessThanOrEqual(64);
      ids.add(id);
    }
    expect(ids.size).toBe(10_000);
  });

  it("starts with the UTC time down to the millisecond so ids sort by start time", () => {
    expect(newRunId(new Date("2026-10-06T01:02:03.456Z"))).toMatch(/^20261006T010203456Z-[0-9a-f]{32}$/);
    expect(newRunId(new Date("2026-10-06T01:02:03.456Z")) < newRunId(new Date("2026-10-06T01:02:03.457Z"))).toBe(true);
  });
});

describe("loadRunState", () => {
  it("fills missing collections of a v1 state and marks its mailbox as legacy", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "state.json"), JSON.stringify({ run_id: "r1", rounds: 2, max_rounds: 9, last_wake: {}, end_reason: "done" }));
    const s = loadRunState(d);
    expect(s.schema_version).toBe(1);
    expect(s.mail_layout).toBe("legacy");
    expect(s.active).toEqual({});
    expect(s.wakes).toEqual([]);
    expect(s.sessions).toEqual({});
    expect(s.output_tokens).toBe(0);
    expect(s.end_reason).toBe("done");
  });

  it("round-trips a v2 state", () => {
    const d = tmp();
    const s = newRunState({ run_id: "r2", project: "p" });
    saveRunState(d, s);
    const back = loadRunState(d);
    expect(back.schema_version).toBe(2);
    expect(back.mail_layout).toBe("run");
    expect(back.run_id).toBe("r2");
  });

  it("explains broken JSON, an unknown schema version and wrongly typed fields", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "state.json"), "{not json");
    expect(() => loadRunState(d)).toThrow(/not valid JSON/);
    fs.writeFileSync(path.join(d, "state.json"), JSON.stringify({ run_id: "r", schema_version: 99 }));
    expect(() => loadRunState(d)).toThrow(/schema_version 99/);
    fs.writeFileSync(path.join(d, "state.json"), JSON.stringify({ run_id: "r", rounds: "many" }));
    expect(() => loadRunState(d)).toThrow(/rounds/);
    expect(() => loadRunState(path.join(d, "missing"))).toThrow(/state\.json/);
  });
});

describe("legacy state", () => {
  it("still reads a state.json written before schema_version existed", () => {
    const dir = tmp();
    const here = path.dirname(fileURLToPath(import.meta.url));
    fs.copyFileSync(path.join(here, "fixtures", "legacy", "state-v1.json"), path.join(dir, "state.json"));
    const s = loadRunState(dir);
    expect(s.mail_layout).toBe("legacy");
    expect(s.rounds).toBe(3);
    expect(s.sessions).toEqual({ lead: "sess-1" });
    expect(s.wakes).toHaveLength(1);
  });

  it("names the field when state.json is invalid", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ run_id: "r", rounds: "three" }));
    expect(() => loadRunState(dir)).toThrow(/Run state is invalid .*rounds/);
  });
});

describe("waiting runs", () => {
  it("round-trips end_reason waiting and the ask rejection counts", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "al-rs-"));
    const s = { ...newRunState({ run_id: "r1" }), end_reason: "waiting" as const, outcome: "waiting" as const, ask_rejections: { lead: 1 } };
    saveRunState(d, s);
    const back = loadRunState(d);
    expect(back.end_reason).toBe("waiting");
    expect(back.outcome).toBe("waiting");
    expect(back.ask_rejections).toEqual({ lead: 1 });
  });
});
