import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAskReply, writeAskReply } from "../src/ask-reply.js";
import { createConsoleDeps } from "../src/web-console.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

function seedAsk(runId = "r1") {
  const runDir = path.join(env.home, "projects", "demo", "runs", runId);
  fs.mkdirSync(path.join(runDir, "mail"), { recursive: true });
  writeAskReply(runDir, {
    status: "pending",
    askedBy: "lead",
    round: 3,
    questions: [
      { id: "q1", text: "Session or JWT?", asker: "lead", options: ["session", "jwt"], suggested: { value: "session", reason: "cookies exist" } },
      { id: "q2", text: "Name it?", asker: "lead" },
    ],
  });
  return runDir;
}

describe("createConsoleDeps", () => {
  it("launches the CLI with the current node and the given script", () => {
    env = makeEnv();
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    expect(deps.cli.execPath).toBe(process.execPath);
    expect(deps.cli.args.at(-1)).toBe("/x/cli.js");
    expect(deps.home).toBe(env.home);
  });
  it("projectDir finds a registered project and nothing else", () => {
    env = makeEnv();
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    expect(deps.projectDir("demo")).toBe(env.repo);
    expect(deps.projectDir("nope")).toBeUndefined();
  });
  it("readAsk returns the questions and undefined without a file", () => {
    env = makeEnv();
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    expect(deps.readAsk("demo", "r1")).toBeUndefined();
    seedAsk();
    const view = deps.readAsk("demo", "r1");
    expect(view?.status).toBe("pending");
    expect(view?.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(view?.questions[0]).toMatchObject({ options: ["session", "jwt"], suggested: { value: "session" }, delivered: false });
    expect(deps.readAsk("demo", "../../etc")).toBeUndefined();
    expect(deps.readAsk("other", "r1")).toBeUndefined();
  });
  it("saveAnswers stores user answers and says what is still missing", () => {
    env = makeEnv();
    const runDir = seedAsk();
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    const partial = deps.saveAnswers("demo", "r1", { q1: "b" }, false);
    expect(partial.complete).toBe(false);
    expect(partial.problems.join(" ")).toContain("q2");
    const saved = readAskReply(runDir);
    expect(saved?.questions[0]?.answer).toEqual({ value: "jwt", by: "user" });
    const done = deps.saveAnswers("demo", "r1", { q2: "Ada" }, false);
    expect(done).toEqual({ complete: true, problems: [] });
  });
  it("saveAnswers with assumeDefaults takes the suggestion", () => {
    env = makeEnv();
    const runDir = seedAsk();
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    const r = deps.saveAnswers("demo", "r1", { q2: "Ada" }, true);
    expect(r.complete).toBe(true);
    expect(readAskReply(runDir)?.questions[0]?.answer).toEqual({ value: "session", by: "default" });
  });
  it("saveAnswers on a run with no questions is not complete", () => {
    env = makeEnv();
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    expect(deps.saveAnswers("demo", "r9", { q1: "a" }, false).complete).toBe(false);
  });
  it("unknown project, unknown run and unregistered names never touch the disk", () => {
    env = makeEnv();
    const runDir = seedAsk();
    // A run dir under a project that exists on disk but is not registered.
    const ghost = path.join(env.home, "projects", "ghost", "runs", "r1");
    fs.mkdirSync(path.join(ghost, "mail"), { recursive: true });
    fs.copyFileSync(path.join(runDir, "mail", "ask-reply.md"), path.join(ghost, "mail", "ask-reply.md"));
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    expect(deps.readAsk("ghost", "r1")).toBeUndefined();
    expect(deps.readAsk("demo", "nope")).toBeUndefined();
    expect(deps.saveAnswers("ghost", "r1", { q1: "a", q2: "b" }, false).complete).toBe(false);
    expect(deps.saveAnswers("demo", "nope", { q1: "a" }, false).complete).toBe(false);
    expect(deps.saveAnswers("demo", "../r1", { q1: "a" }, false).complete).toBe(false);
    expect(readAskReply(ghost)?.questions[0]?.answer).toBeUndefined();
    expect(fs.existsSync(path.join(env.home, "projects", "demo", "runs", "nope"))).toBe(false);
  });
});
