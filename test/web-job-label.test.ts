import { describe, expect, it } from "vitest";
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
  it("other commands: nothing", () => {
    expect(jobLabel(["tidy", "-p", "biz"])).toEqual({ project: "biz", target: undefined, tidy: false });
  });
});
