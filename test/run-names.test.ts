// test/run-names.test.ts
import { describe, expect, it } from "vitest";
import { newRunState, resolveRun, roundLimit, slugify, uniqueName, type RunRef } from "../src/run-store.js";

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

describe("roundLimit", () => {
  it("is max_rounds counted from the last reopen", () => {
    expect(roundLimit({}, 30)).toBe(30);
    expect(roundLimit({ round_floor: 12 }, 30)).toBe(42);
  });
});
