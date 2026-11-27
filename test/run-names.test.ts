// test/run-names.test.ts
import { describe, expect, it } from "vitest";
import { newRunState, pickRunName, resolveRun, roundLimit, slugify, uniqueName, type RunRef } from "../src/run-store.js";

const ref = (run_id: string, name?: string): RunRef => ({ dir: `/r/${run_id}`, state: newRunState({ run_id, name }) });

describe("slugify", () => {
  it("lowercases, joins words with -, keeps 30 chars", () => {
    expect(slugify("Login: Session or JWT?")).toBe("login-session-or-jwt");
    expect(slugify("a".repeat(50))).toHaveLength(30);
  });
  it("falls back to task when nothing usable is left", () => {
    expect(slugify("登入功能")).toBe("task");
    expect(slugify("  ---  ")).toBe("task");
  });
});

describe("uniqueName", () => {
  it("adds -2, -3 … when the name is taken", () => {
    expect(uniqueName("login", [])).toBe("login");
    expect(uniqueName("login", ["login"])).toBe("login-2");
    expect(uniqueName("login", ["login", "login-2"])).toBe("login-3");
  });
  it("never exceeds 30 characters, even with a suffix", () => {
    const base = slugify("a".repeat(50));
    expect(base).toHaveLength(30);
    const two = uniqueName(base, [base]);
    expect(two.length).toBeLessThanOrEqual(30);
    expect(two.endsWith("-2")).toBe(true);
    const dashed = `${"a".repeat(27)}-bb`; // trimming the base must not leave a trailing "-"
    expect(uniqueName(dashed, [dashed]).length).toBeLessThanOrEqual(30);
    expect(uniqueName(dashed, [dashed])).not.toMatch(/--/);
  });
});

describe("resolveRun", () => {
  const runs = [ref("20261014T010000Z-aaa", "login"), ref("20261014T020000Z-bbb", "login-2"), ref("20261013T010000Z-ccc")];
  it("matches a full id, an exact name, and a unique prefix", () => {
    expect(resolveRun(runs, "20261014T010000Z-aaa")).toMatchObject({ ok: true, run: { dir: "/r/20261014T010000Z-aaa" } });
    expect(resolveRun(runs, "login")).toMatchObject({ ok: true, run: { dir: "/r/20261014T010000Z-aaa" } });
    expect(resolveRun(runs, "login-2")).toMatchObject({ ok: true, run: { dir: "/r/20261014T020000Z-bbb" } });
    expect(resolveRun(runs, "20261013")).toMatchObject({ ok: true, run: { dir: "/r/20261013T010000Z-ccc" } });
  });
  it("an exact name or id wins over a longer prefix match", () => {
    expect(resolveRun(runs, "login")).toMatchObject({ ok: true });
  });
  it("reports ambiguous prefixes and unknown names", () => {
    expect(resolveRun(runs, "2026101")).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(resolveRun(runs, "nope")).toMatchObject({ ok: false, reason: "none" });
  });
});

describe("pickRunName", () => {
  const exists = (name: string) => `A run named "${name}" already exists in project demo.`;
  const holder = (over: Partial<{ name: string; tidy?: boolean; outcome?: string; end_reason?: string; state?: string; live: boolean; run_id: string }> = {}) => ({
    name: "x",
    tidy: true,
    outcome: "failed",
    live: false,
    run_id: "r1",
    ...over,
  });

  it("keeps a free name", () => {
    expect(pickRunName({ name: "x", tidy: true, project: "demo", taken: [], holders: [] })).toEqual({ ok: true, name: "x" });
    expect(pickRunName({ name: "x", tidy: false, project: "demo", taken: ["other"], holders: [] })).toEqual({ ok: true, name: "x" });
  });

  it("renames when an unfinished tidy run holds the name, and steps past x-2", () => {
    const once = pickRunName({ name: "x", tidy: true, project: "demo", taken: ["x"], holders: [holder()] });
    expect(once).toEqual({ ok: true, name: "x-2", note: `note: "x" is held by an unfinished tidy run (failed, r1); this run is named "x-2".` });
    const twice = pickRunName({ name: "x", tidy: true, project: "demo", taken: ["x", "x-2"], holders: [holder(), holder({ name: "x-2", run_id: "r2" })] });
    expect(twice).toEqual({ ok: true, name: "x-3", note: `note: "x" is held by an unfinished tidy run (failed, r1); this run is named "x-3".` });
  });

  it("renames a name-only legacy tidy holder that never completed", () => {
    const picked = pickRunName({
      name: "legacy-tidy",
      tidy: true,
      project: "demo",
      taken: ["legacy-tidy"],
      holders: [holder({ name: "legacy-tidy", tidy: undefined, outcome: undefined, state: "interrupted", run_id: "old" })],
    });
    expect(picked).toEqual({
      ok: true,
      name: "legacy-tidy-2",
      note: `note: "legacy-tidy" is held by an unfinished tidy run (interrupted, old); this run is named "legacy-tidy-2".`,
    });
  });

  it("refuses every other collision with the existing message", () => {
    const unfinished = [holder()];
    expect(pickRunName({ name: "x", tidy: false, project: "demo", taken: ["x"], holders: unfinished })).toEqual({ ok: false, error: exists("x") });
    expect(pickRunName({ name: "x", tidy: true, project: "demo", taken: ["x"], holders: [holder({ tidy: false, name: "x" })] })).toEqual({ ok: false, error: exists("x") });
    expect(pickRunName({ name: "plain", tidy: true, project: "demo", taken: ["plain"], holders: [holder({ name: "plain", tidy: undefined })] })).toEqual({ ok: false, error: exists("plain") });
    expect(pickRunName({ name: "x", tidy: true, project: "demo", taken: ["x"], holders: [holder({ outcome: "completed", end_reason: "done" })] })).toEqual({ ok: false, error: exists("x") });
    expect(pickRunName({ name: "x", tidy: true, project: "demo", taken: ["x"], holders: [holder({ live: true })] })).toEqual({ ok: false, error: exists("x") });
  });

  it("refuses when any exact holder is finished, not tidy, or live, whichever comes first", () => {
    const failed = holder({ run_id: "fail1" });
    const finished = holder({ outcome: "completed", end_reason: "done", run_id: "done1" });
    const plain = holder({ tidy: false, run_id: "plain1" });
    const live = holder({ live: true, run_id: "live1" });
    for (const blockers of [finished, plain, live]) {
      for (const holders of [
        [failed, blockers],
        [blockers, failed],
      ]) {
        expect(pickRunName({ name: "x", tidy: true, project: "demo", taken: ["x"], holders })).toEqual({ ok: false, error: exists("x") });
      }
    }
  });

  it("renames when every exact holder is an unfinished tidy run, naming the first holder", () => {
    const two = pickRunName({
      name: "x",
      tidy: true,
      project: "demo",
      taken: ["x"],
      holders: [holder({ run_id: "newer" }), holder({ run_id: "older", outcome: "partial" })],
    });
    expect(two).toEqual({ ok: true, name: "x-2", note: `note: "x" is held by an unfinished tidy run (failed, newer); this run is named "x-2".` });
    const stepped = pickRunName({
      name: "x",
      tidy: true,
      project: "demo",
      taken: ["x", "x-2"],
      holders: [holder({ run_id: "newer" }), holder({ run_id: "older" })],
    });
    expect(stepped).toEqual({ ok: true, name: "x-3", note: `note: "x" is held by an unfinished tidy run (failed, newer); this run is named "x-3".` });
  });

  it("treats completed without end_reason done as unfinished", () => {
    expect(pickRunName({ name: "x", tidy: true, project: "demo", taken: ["x"], holders: [holder({ outcome: "completed", run_id: "r1" })] })).toEqual({
      ok: true,
      name: "x-2",
      note: `note: "x" is held by an unfinished tidy run (completed, r1); this run is named "x-2".`,
    });
  });
});

describe("roundLimit", () => {
  it("is max_rounds counted from the last reopen", () => {
    expect(roundLimit({}, 30)).toBe(30);
    expect(roundLimit({ round_floor: 12 }, 30)).toBe(42);
  });
});
