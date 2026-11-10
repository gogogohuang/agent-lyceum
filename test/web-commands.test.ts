import { describe, expect, it } from "vitest";
import { ArgError, COMMANDS, type Body, type CommandId } from "../web/src/commands.js";

const argv = (id: CommandId, body: Body) => COMMANDS[id].argv(body);
const badField = (id: CommandId, body: Body): string | undefined => {
  try {
    COMMANDS[id].argv(body);
  } catch (e) {
    return e instanceof ArgError ? e.field : "not-an-ArgError";
  }
  return undefined;
};

describe("argv", () => {
  it("run: flags first, the task after `--` as one element", () => {
    expect(argv("run", { project: "web", task: "fix it", name: "fix-it", agent: "fe-member", assumeDefaults: true })).toEqual([
      "run", "-p", "web", "--name", "fix-it", "--agent", "fe-member", "--assume-defaults", "--", "fix it",
    ]);
    expect(argv("run", { project: "web", task: "x" })).toEqual(["run", "-p", "web", "--", "x"]);
  });
  it("run: hostile values stay one argv element", () => {
    const task = "--help; rm -rf / && \"quoted\" $(x)";
    const out = argv("run", { project: "web", task });
    expect(out.at(-1)).toBe(task);
    expect(out.at(-2)).toBe("--");
  });
  it("run: rejects bad input with the field name", () => {
    expect(badField("run", { project: "web" })).toBe("task");
    expect(badField("run", { project: "web", task: "x", name: "Bad Name" })).toBe("name");
    expect(badField("run", { project: "../x", task: "x" })).toBe("project");
    expect(badField("run", { project: "web", task: "a\u0000b" })).toBe("task");
    expect(badField("run", { project: "web", task: "x", assumeDefaults: "yes" })).toBe("assumeDefaults");
    expect(badField("run", { project: "web", task: "x".repeat(200_001) })).toBe("task");
  });
  it("resume", () => {
    expect(argv("resume", { project: "web", run: "r1" })).toEqual(["resume", "-p", "web", "--", "r1"]);
    expect(argv("resume", { project: "web", run: "r1", followup: "also do y" })).toEqual(["resume", "-p", "web", "--", "r1", "also do y"]);
    expect(argv("resume", { project: "web", run: "r1", answer: true, assumeDefaults: true })).toEqual([
      "resume", "-p", "web", "--assume-defaults", "--answer", "--no-edit", "--", "r1",
    ]);
    expect(badField("resume", { project: "web", run: "r1", answer: true, followup: "x" })).toBe("followup");
    expect(badField("resume", { project: "web" })).toBe("run");
    expect(badField("resume", { project: "web", run: "-rf" })).toBe("run");
  });
  it("clear and clear.lock", () => {
    expect(argv("clear", { project: "web", run: "r1", dryRun: true, keepWorktrees: true })).toEqual([
      "clear", "-p", "web", "--dry-run", "--keep-worktrees", "--", "r1",
    ]);
    expect(badField("clear", { project: "web" })).toBe("run");
    expect(argv("clear.lock", { project: "web" })).toEqual(["clear", "-p", "web", "--lock", "--force"]);
    expect(argv("clear.lock", { project: "web", run: "r1" })).toEqual(["clear", "-p", "web", "--lock", "--force", "--", "r1"]);
  });
  it("doctor, init, project.*", () => {
    expect(argv("doctor", { project: "web", resolved: true })).toEqual(["doctor", "-p", "web", "--resolved"]);
    expect(argv("init", {})).toEqual(["init", "-y"]);
    expect(argv("project.list", {})).toEqual(["project"]);
    expect(argv("project.add", { name: "web", dir: "/tmp/repo" })).toEqual(["project", "add", "web", "--dir", "/tmp/repo"]);
    expect(badField("project.add", { name: "web", dir: "relative/dir" })).toBe("dir");
    expect(badField("project.add", { name: "-x", dir: "/tmp/r" })).toBe("name");
    expect(argv("project.remove", { name: "web", purge: true })).toEqual(["project", "remove", "web", "--purge"]);
  });
  it("call", () => {
    expect(argv("call", { agent: "qa-member", dir: "/tmp/repo", task: "review" })).toEqual(["call", "qa-member", "--dir", "/tmp/repo", "--", "review"]);
    expect(badField("call", { agent: "qa-member", task: "review" })).toBe("dir");
  });
  it("tidy", () => {
    expect(argv("tidy", { project: "web", agent: "pm", layer: "global", dryRun: true })).toEqual(["tidy", "-p", "web", "--agent", "pm", "--layer", "global", "--dry-run"]);
    expect(argv("tidy", { project: "web", agent: "pm", undo: "20261110T010203" })).toEqual(["tidy", "-p", "web", "--agent", "pm", "--undo", "20261110T010203"]);
    expect(badField("tidy", { project: "web", undo: "s1" })).toBe("agent");
    expect(badField("tidy", { project: "web", agent: "pm", undo: "s1", dryRun: true })).toBe("undo");
    expect(badField("tidy", { project: "web", layer: "other" })).toBe("layer");
  });
  it("demo", () => {
    expect(argv("demo", { runtime: "codex", setupOnly: true })).toEqual(["demo", "-y", "--runtime", "codex", "--setup-only"]);
    expect(badField("demo", { runtime: "gpt" })).toBe("runtime");
  });
});

describe("tier, target, mode", () => {
  const tier = (id: CommandId, body: Body) => COMMANDS[id].tier(body);
  const mode = (id: CommandId, body: Body) => COMMANDS[id].mode(body);
  it("tiers", () => {
    expect(tier("run", {})).toBe("normal");
    expect(tier("clear", { dryRun: true })).toBe("normal");
    expect(tier("clear", {})).toBe("confirm");
    expect(tier("tidy", { dryRun: true })).toBe("normal");
    expect(tier("tidy", {})).toBe("confirm");
    expect(tier("project.remove", {})).toBe("confirm");
    expect(tier("project.remove", { purge: true })).toBe("typed");
    expect(tier("clear.lock", {})).toBe("typed");
  });
  it("typed targets", () => {
    expect(COMMANDS["project.remove"].target({ name: "web", purge: true })).toBe("web");
    expect(COMMANDS["clear.lock"].target({ project: "web", run: "r1" })).toBe("r1");
    expect(COMMANDS["clear.lock"].target({ project: "web" })).toBe("web");
  });
  it("modes", () => {
    for (const id of ["run", "resume", "call"] as const) expect(mode(id, {})).toBe("detached");
    for (const id of ["doctor", "init", "project.list", "project.add", "project.remove", "clear", "clear.lock"] as const) expect(mode(id, {})).toBe("short");
    expect(mode("tidy", {})).toBe("detached");
    expect(mode("tidy", { dryRun: true })).toBe("short");
    expect(mode("tidy", { undo: "s" })).toBe("short");
    expect(mode("demo", {})).toBe("detached");
    expect(mode("demo", { setupOnly: true })).toBe("short");
  });
});
