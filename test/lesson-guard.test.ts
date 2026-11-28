import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lessonGuardFindings, listRecords, type ProjectRecord } from "../src/records.js";
import { recordsKindDir } from "../src/policy.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

function lesson(partial: Partial<ProjectRecord> & Pick<ProjectRecord, "id" | "title">): ProjectRecord {
  return {
    kind: "lessons",
    file: `${partial.id}.md`,
    status: "active",
    date: "2026-11-27",
    supersedes: [],
    body: "",
    ...partial,
  };
}

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("lessonGuardFindings", () => {
  it("warns when a lesson was seen twice and has no guard", () => {
    const found = lessonGuardFindings([lesson({ id: "a", title: "Run tests", seen: 2 })], 0);
    expect(found.map((f) => f.level)).toEqual(["warn"]);
  });
  it("errors when it asks for verify commands and none are configured", () => {
    const found = lessonGuardFindings([lesson({ id: "a", title: "Run tests", seen: 2, guard: "verify-configured" })], 0);
    expect(found.map((f) => f.level)).toEqual(["error"]);
  });
  it("stays quiet when verify commands exist", () => {
    expect(lessonGuardFindings([lesson({ id: "a", title: "Run tests", seen: 2, guard: "verify-configured" })], 1)).toEqual([]);
  });
  it("warns on duplicate titles", () => {
    const found = lessonGuardFindings([lesson({ id: "a", title: "Run tests" }), lesson({ id: "b", title: "run   tests" })], 1);
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.level === "warn")).toBe(true);
  });
  it("marks a lesson invalid when seen is not a positive integer", () => {
    env = makeEnv();
    const dir = recordsKindDir(env.project(), "lessons");
    fs.mkdirSync(dir, { recursive: true });
    write(
      path.join(dir, "run-tests.md"),
      "---\nstatus: active\ndate: 2026-11-27\ntitle: Run tests\nseen: twice\n---\n\nbody\n",
    );
    const rec = listRecords(env.project(), "lessons").find((r) => r.id === "run-tests");
    expect(rec?.invalid).toContain("seen");
    expect(rec?.seen).toBeUndefined();
  });
});
