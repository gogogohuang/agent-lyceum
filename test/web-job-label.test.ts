import { afterEach, describe, expect, it, vi } from "vitest";
import { getJobs, retainJobs } from "../web/src/client/api";
import { jobLabel } from "../web/src/client/job-label";

describe("jobLabel", () => {
  it("run: project and name, tidy flag", () => {
    expect(jobLabel(["run", "-p", "biz", "--name", "lt-1-tidy", "--tidy", "--", "do it"])).toEqual({ project: "biz", target: "lt-1-tidy", tidy: true });
  });
  it("run without a name: first line of the task, cut", () => {
    expect(jobLabel(["run", "-p", "biz", "--", "\nfirst line\nsecond"])).toEqual({ project: "biz", target: "first line", tidy: false });
    expect(jobLabel(["run", "-p", "biz", "--", "x".repeat(80)]).target).toBe(`${"x".repeat(60)}…`);
  });
  it("task text that looks like a flag is not read as one", () => {
    expect(jobLabel(["run", "-p", "biz", "--", "--tidy -p other"])).toMatchObject({ project: "biz", tidy: false });
  });
  it("resume and call", () => {
    expect(jobLabel(["resume", "-p", "biz", "--", "run-1", "more"])).toEqual({ project: "biz", target: "run-1", tidy: false });
    expect(jobLabel(["call", "bot", "--dir", "/d", "--", "hi"])).toEqual({ project: undefined, target: "bot：hi", tidy: false });
  });
  it("a memory tidy carries the tag; a preview or an undo does not", () => {
    expect(jobLabel(["tidy", "-p", "biz"])).toEqual({ project: "biz", target: "全部", tidy: true });
    expect(jobLabel(["tidy", "-p", "biz", "--agent", "lead", "--layer", "project"])).toMatchObject({ tidy: true, target: "lead" });
    expect(jobLabel(["tidy", "-p", "biz", "--dry-run"])).toMatchObject({ tidy: false, target: "全部" });
    expect(jobLabel(["tidy", "-p", "biz", "--agent", "lead", "--undo", "20261110T010203Z"])).toMatchObject({ tidy: false, target: "lead" });
  });
});

describe("getJobs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports a failed list request as null and an empty list as an empty array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    expect(await getJobs()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    expect(await getJobs()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })));
    expect(await getJobs()).toEqual([]);
  });
});

describe("retainJobs", () => {
  it("keeps the previous list when a poll fails, and replaces it when the poll succeeds", () => {
    const prev = [{ id: "a" }];
    expect(retainJobs(prev, null)).toBe(prev);
    expect(retainJobs(undefined, null)).toBeUndefined();
    expect(retainJobs(prev, [])).toEqual([]);
    expect(retainJobs(prev, [{ id: "b" }])).toEqual([{ id: "b" }]);
  });
});
