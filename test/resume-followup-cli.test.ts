import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunState } from "../src/run-store.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

let env: TestEnv;
afterEach(() => env?.cleanup());

const leadDone = (subject: string) => ({ agent: "lead", mail: [{ type: "done", subject, outcome: "completed" }] });

/** The real CLI with a scripted stand-in for `claude`; no TTY on stdin or stdout. */
function setup(calls: object[]) {
  env = makeEnv();
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const scriptFile = path.join(env.root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify({ calls }));
  const vars = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SCRIPT: scriptFile };
  return (args: string[]) => {
    const r = spawnSync(tsx, [cli, "--home", env.home, ...args, "-p", "demo"], { encoding: "utf8", env: vars, stdio: ["ignore", "pipe", "pipe"] });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
}

const runDirs = () => fs.readdirSync(env.project().paths.runs).sort();
const dirOf = (id: string) => path.join(env.project().paths.runs, id);

/** A second finished run: a copy of `from` under an older id, with its own name. */
function cloneRun(from: string, id: string, name: string) {
  fs.cpSync(dirOf(from), dirOf(id), { recursive: true });
  const st = JSON.parse(fs.readFileSync(path.join(dirOf(id), "state.json"), "utf8"));
  write(path.join(dirOf(id), "state.json"), JSON.stringify({ ...st, run_id: id, name }));
}

describe("resume [run] [text]", { timeout: 90_000 }, () => {
  it("with text and no run: the only candidate is reopened and the line says which run", () => {
    const sh = setup([leadDone("first"), leadDone("second")]);
    expect(sh(["run", "Add login"]).code).toBe(0);
    const [id] = runDirs();
    const r = sh(["resume", "Add rate limit\nand more"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Reopening run add-login (follow-up 1): Add rate limit");
    expect(r.out).not.toContain("and more\n");
    expect(fs.readFileSync(path.join(dirOf(id!), "followups", "1.md"), "utf8")).toContain("Add rate limit");
    expect(loadRunState(dirOf(id!)).reopened).toHaveLength(1);
  });

  it("resume <name> text reopens that run; the same call without text only prints the result", () => {
    const sh = setup([leadDone("first"), leadDone("second")]);
    sh(["run", "Add login"]);
    const [id] = runDirs();
    expect(sh(["resume", "add-login", "Also rate limiting"]).code).toBe(0);
    expect(fs.existsSync(path.join(dirOf(id!), "followups", "1.md"))).toBe(true);
    expect(fs.existsSync(path.join(dirOf(id!), "done-1.md"))).toBe(true);
    const again = sh(["resume", "add-login"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already finished (done)");
    expect(fs.existsSync(path.join(dirOf(id!), "followups", "2.md"))).toBe(false);
  });

  it("one argument that is not a run is taken as the follow-up text; --task-file reads it from a file", () => {
    const sh = setup([leadDone("first"), leadDone("second"), leadDone("third")]);
    sh(["run", "Add login"]);
    const [id] = runDirs();
    expect(sh(["resume", "fix the typo"]).out).toContain("(follow-up 1): fix the typo");
    const file = path.join(env.root, "more.md");
    fs.writeFileSync(file, "from a file\nline two\n");
    const r = sh(["resume", "add-login", "--task-file", file]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(follow-up 2): from a file");
    expect(fs.readFileSync(path.join(dirOf(id!), "followups", "2.md"), "utf8")).toContain("line two");
  });

  it("a lone one-word argument that matches no run is a mistyped name: not found, nothing reopened", () => {
    const sh = setup([leadDone("first")]);
    sh(["run", "Add login"]);
    const [id] = runDirs();
    const r = sh(["resume", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not found/);
    expect(fs.existsSync(path.join(dirOf(id!), "followups"))).toBe(false);
  });

  it("a lone non-ASCII argument is follow-up text", () => {
    const sh = setup([leadDone("first"), leadDone("second")]);
    sh(["run", "Add login"]);
    const r = sh(["resume", "加上限流"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(follow-up 1): 加上限流");
  });

  it("several candidates and no TTY: lists them, suggests resume <name>, exits 1 and reopens nothing", () => {
    const sh = setup([leadDone("first")]);
    sh(["run", "Add login"]);
    const [id] = runDirs();
    cloneRun(id!, "20200101-000000", "older-one");
    const r = sh(["resume", "do more"]);
    expect(r.code).toBe(1);
    for (const x of ["add-login", "older-one", id!, "20200101-000000"]) expect(r.err).toContain(x);
    expect(r.err).toContain('resume <name> "..."');
    expect(fs.existsSync(path.join(dirOf(id!), "followups"))).toBe(false);
  });

  it("an ambiguous single argument is reported as ambiguous, not taken as text", () => {
    const sh = setup([leadDone("first")]);
    sh(["run", "Add login"]);
    const [id] = runDirs();
    cloneRun(id!, "20200101-000000", "add-logout");
    const r = sh(["resume", "add-lo"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("matches several runs");
  });

  it("no run at all: fails with a pointer to `run`", () => {
    const sh = setup([]);
    const r = sh(["resume", "something else"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("No run to continue");
  });

  it("a run that is still alive is refused", () => {
    const sh = setup([]);
    write(path.join(dirOf("20261014-010000"), "state.json"), JSON.stringify({ run_id: "20261014-010000", name: "busy", pid: process.pid, rounds: 1, max_rounds: 10, last_wake: {}, wakes: [], task_summary: "Busy" }));
    const r = sh(["resume", "busy", "more please"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("still running");
  });

  it("text for a run that is not done is refused with the way forward", () => {
    const sh = setup([]);
    write(path.join(dirOf("20261014-010000"), "state.json"), JSON.stringify({ run_id: "20261014-010000", name: "half", rounds: 1, max_rounds: 10, last_wake: {}, wakes: [], end_reason: "cancelled", task_summary: "Half" }));
    const r = sh(["resume", "half", "more please"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not finished \(cancelled\); resume it without text first/);
  });

  it("an old run without a name can be reopened by its id", () => {
    const sh = setup([leadDone("first"), leadDone("second")]);
    sh(["run", "Add login"]);
    const [id] = runDirs();
    const st = JSON.parse(fs.readFileSync(path.join(dirOf(id!), "state.json"), "utf8"));
    delete st.name;
    write(path.join(dirOf(id!), "state.json"), JSON.stringify(st));
    const r = sh(["resume", id!, "again"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Reopening run ${id} (follow-up 1): again`);
  });
});
