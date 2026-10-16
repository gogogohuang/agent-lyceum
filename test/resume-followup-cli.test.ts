import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeAskReply } from "../src/ask-reply.js";
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
  const sh = (args: string[]) => {
    const r = spawnSync(tsx, [cli, "--home", env.home, ...args, "-p", "demo"], { encoding: "utf8", env: vars, stdio: ["ignore", "pipe", "pipe"] });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  /** A refused command must not prompt or read stdin: stdin is a pipe that is never closed, so a read would hang until the timeout. */
  sh.probe = (args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string; timedOut: boolean }>((resolve) => {
      const c = spawn(tsx, [cli, "--home", env.home, ...args, "-p", "demo"], { env: vars, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let timedOut = false;
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      const t = setTimeout(() => {
        timedOut = true;
        c.kill("SIGKILL");
      }, 20_000);
      c.on("close", (code) => {
        clearTimeout(t);
        resolve({ code, out, err, timedOut });
      });
    });
  sh.calls = () => (fs.existsSync(`${scriptFile}.count`) ? Number(fs.readFileSync(`${scriptFile}.count`, "utf8")) : 0);
  return sh;
}

const runDirs = () => fs.readdirSync(env.project().paths.runs).sort();
const dirOf = (id: string) => path.join(env.project().paths.runs, id);

/** Every file under the runs dir with its bytes, to prove a refused command changed nothing. */
function snapshot(): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(`${f}\n${fs.readFileSync(f, "utf8")}`);
    }
  };
  walk(env.project().paths.runs);
  return out.join("\n--\n");
}
const lockFiles = () => {
  const d = path.join(env.project().paths.root, "locks");
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};
const state = (id: string, name: string | undefined, extra: object = {}) =>
  JSON.stringify({ run_id: id, ...(name ? { name } : {}), rounds: 1, max_rounds: 10, last_wake: {}, wakes: [], task_summary: `Task ${id}`, ...extra });

describe("run [run] [text] (continue and reopen)", { timeout: 90_000 }, () => {
  it("run <run> <text> reopens that run; the line says which; the same call without text only prints the result", () => {
    const sh = setup([leadDone("first"), leadDone("second")]);
    expect(sh(["run", "Add login"]).code).toBe(0);
    const [id] = runDirs();
    const r = sh(["run", "add-login", "Add rate limit\nand more"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Reopening run add-login (${id}) (follow-up 1): Add rate limit`);
    expect(r.out).not.toContain("and more\n");
    expect(fs.readFileSync(path.join(dirOf(id!), "followups", "1.md"), "utf8")).toContain("Add rate limit");
    expect(fs.existsSync(path.join(dirOf(id!), "done-1.md"))).toBe(true);
    expect(loadRunState(dirOf(id!)).reopened).toHaveLength(1);
    const again = sh(["run", "add-login"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already finished (done); nothing to continue (follow up with: agent-lyceum run add-login");
    expect(fs.existsSync(path.join(dirOf(id!), "followups", "2.md"))).toBe(false);
  });

  it("an exact run id continues (a done run prints its result); an exact name does too", () => {
    const sh = setup([leadDone("first")]);
    sh(["run", "Add login"]);
    const [id] = runDirs();
    for (const ref of [id!, "add-login"]) {
      const r = sh(["run", ref]);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain("already finished (done)");
    }
  });

  it("run <run> --task-file reopens with the file; a one-word text with a run is the follow-up", () => {
    const sh = setup([leadDone("first"), leadDone("second"), leadDone("third")]);
    sh(["run", "Add login"]);
    const [id] = runDirs();
    const file = path.join(env.root, "more.md");
    fs.writeFileSync(file, "from a file\nline two\n");
    const r = sh(["run", "add-login", "--task-file", file]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(follow-up 1): from a file");
    expect(fs.readFileSync(path.join(dirOf(id!), "followups", "1.md"), "utf8")).toContain("line two");
    expect(sh(["run", "add-login", "tidy"]).out).toContain("(follow-up 2): tidy");
  });

  it("--task-file with no run starts a new run; a non-ASCII or dotted single argument is a new task, not a follow-up", () => {
    const sh = setup([leadDone("first"), leadDone("second"), leadDone("third"), leadDone("fourth")]);
    sh(["run", "Add login"]);
    const file = path.join(env.root, "task.md");
    fs.writeFileSync(file, "Task from a file\n");
    expect(sh(["run", "--task-file", file]).code).toBe(0);
    expect(sh(["run", "加上限流"]).code).toBe(0);
    expect(sh(["run", "v1.2"]).code).toBe(0);
    expect(runDirs()).toHaveLength(4);
  });

  it("a one-word argument that matches no run is not a task: exit 1, no run dir, no lock", () => {
    const sh = setup([leadDone("first")]);
    sh(["run", "Add login"]);
    const before = snapshot();
    const r = sh(["run", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('"nope" is not a run of project demo, and a one-word task looks like a run name.');
    expect(r.err).toContain("agent-lyceum status --task-list");
    expect(snapshot()).toBe(before);
    expect(lockFiles()).toEqual([]);
  });

  it("run <missing> <text> says not found and never turns into a task", () => {
    const sh = setup([leadDone("first")]);
    sh(["run", "Add login"]);
    const r = sh(["run", "nope", "more please"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Run "nope" not found/);
    expect(runDirs()).toHaveLength(1);
  });

  it("a prefix of one run is refused with the copy-ready command: no runtime call, no stdin read, files unchanged, no new run, no lock", async () => {
    const sh = setup([]);
    const dir = dirOf("20261014-010000");
    write(path.join(dir, "state.json"), state("20261014-010000", "fix-login-mobile", { end_reason: "agent_failed", outcome: "failed" }));
    write(path.join(dir, "log.jsonl"), '{"event":"x"}\n');
    write(path.join(dir, "mail", "inbox", "lead", "m1.md"), "---\nto: lead\n---\nhello\n");
    const before = snapshot();
    const dirsBefore = runDirs();
    const cases: [string[], string][] = [
      [["run", "fix-login"], "agent-lyceum run fix-login-mobile -p demo"],
      [["run", "fix-login", "--answer", "--no-edit"], "agent-lyceum run fix-login-mobile --answer --no-edit -p demo"],
      [["run", "fix-login", "--answer"], "agent-lyceum run fix-login-mobile --answer -p demo"],
      [["run", "fix-login", "more please"], 'agent-lyceum run fix-login-mobile "<follow-up>" -p demo'],
      [["run", "fix-login", "--task-file", "f.md"], "agent-lyceum run fix-login-mobile --task-file f.md -p demo"],
    ];
    for (const [args, cmd] of cases) {
      const r = await sh.probe(args);
      expect(r.timedOut, args.join(" ")).toBe(false);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toContain('"fix-login" is only the start of run fix-login-mobile (20261014-010000); run needs the exact name or id:');
      expect(r.err).toContain(cmd);
    }
    expect(sh.calls()).toBe(0);
    expect(snapshot()).toBe(before);
    expect(runDirs()).toEqual(dirsBefore);
    expect(lockFiles()).toEqual([]);
  });

  it("an exact name wins over a longer name that starts with it", () => {
    const sh = setup([]);
    write(path.join(dirOf("20261014-010000"), "state.json"), state("20261014-010000", "fix-login", { end_reason: "done", outcome: "completed" }));
    write(path.join(dirOf("20261014-010000"), "result.md"), "# Done\n");
    write(path.join(dirOf("20261014-020000"), "state.json"), state("20261014-020000", "fix-login-mobile", { end_reason: "cancelled" }));
    const r = sh(["run", "fix-login"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Run fix-login (20261014-010000) already finished");
  });

  it("several runs sharing a prefix: lists them, asks for the exact name or id, changes nothing", async () => {
    const sh = setup([]);
    write(path.join(dirOf("20261014-010000"), "state.json"), state("20261014-010000", "fix-login-mobile", { end_reason: "cancelled" }));
    write(path.join(dirOf("20261014-020000"), "state.json"), state("20261014-020000", "fix-login-web", { end_reason: "cancelled" }));
    const before = snapshot();
    const dirsBefore = runDirs();
    const r = await sh.probe(["run", "fix-login"]);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(1);
    expect(sh.calls()).toBe(0);
    expect(runDirs()).toEqual(dirsBefore);
    expect(lockFiles()).toEqual([]);
    expect(r.err).toContain('"fix-login" matches several runs only by prefix:');
    for (const x of ["fix-login-mobile", "fix-login-web", "20261014-010000", "20261014-020000"]) expect(r.err).toContain(x);
    expect(r.err).toContain("Give the exact name or id: agent-lyceum run <name-or-id>");
    expect(snapshot()).toBe(before);
  });

  it("bare `run` picks the newest run that is not done or running: here the waiting one", () => {
    const sh = setup([]);
    const waiting = { end_reason: "waiting", outcome: "waiting" };
    write(path.join(dirOf("20261014-010000"), "state.json"), state("20261014-010000", "a", { end_reason: "agent_failed", outcome: "failed" }));
    write(path.join(dirOf("20261014-020000"), "state.json"), state("20261014-020000", "b", waiting));
    writeAskReply(dirOf("20261014-020000"), { status: "answered", askedBy: "lead", round: 1, questions: [{ id: "q1", text: "ok?", asker: "lead", answer: { value: "yes", by: "user" } }] });
    write(path.join(dirOf("20261014-030000"), "state.json"), state("20261014-030000", "c", { pid: process.pid }));
    write(path.join(dirOf("20261014-040000"), "state.json"), state("20261014-040000", "d", { end_reason: "done", outcome: "completed" }));
    const r = sh(["run"]);
    expect(r.out).not.toContain("Resuming run a");
    expect(r.out).toContain("Resuming run b");
  });

  it("bare `run` with nothing unfinished: exit 1 with the new-run usage", () => {
    const sh = setup([leadDone("first")]);
    sh(["run", "Add login"]);
    const r = sh(["run"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('No unfinished run to continue. Start one with: agent-lyceum run "<task>"');
  });

  it("a run that is still alive is refused", () => {
    const sh = setup([]);
    write(path.join(dirOf("20261014-010000"), "state.json"), state("20261014-010000", "busy", { pid: process.pid }));
    const r = sh(["run", "busy", "more please"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("still running");
  });

  it("text for a run that is not done is refused with the way forward", () => {
    const sh = setup([]);
    write(path.join(dirOf("20261014-010000"), "state.json"), state("20261014-010000", "half", { end_reason: "cancelled" }));
    const r = sh(["run", "half", "more please"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not finished \(cancelled\); continue it first: agent-lyceum run half/);
  });

  it("an old run without a name can be reopened by its id", () => {
    const sh = setup([leadDone("first"), leadDone("second")]);
    sh(["run", "Add login"]);
    const [id] = runDirs();
    const st = JSON.parse(fs.readFileSync(path.join(dirOf(id!), "state.json"), "utf8"));
    delete st.name;
    write(path.join(dirOf(id!), "state.json"), JSON.stringify(st));
    const r = sh(["run", id!, "again"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Reopening run ${id} (follow-up 1): again`);
  });

  it("an empty or whitespace-only task fails first: The task is empty.", async () => {
    const sh = setup([]);
    for (const t of ["", "   ", "\n\t"]) {
      const r = await sh.probe(["run", t]);
      expect(r.code, JSON.stringify(t)).toBe(1);
      expect(r.err).toContain("The task is empty.");
    }
    expect(fs.existsSync(env.project().paths.runs) ? runDirs() : []).toEqual([]);
    expect(sh.calls()).toBe(0);
    expect(lockFiles()).toEqual([]);
  });

  it("invalid combinations (18.4.5) exit 1 and wake nothing", () => {
    const sh = setup([]);
    write(path.join(dirOf("20261014-010000"), "state.json"), state("20261014-010000", "half", { end_reason: "cancelled" }));
    write(path.join(env.root, "f.md"), "x\n");
    const before = snapshot();
    const cases: [string[], string][] = [
      [["run", "half", "text", "--task-file", path.join(env.root, "f.md")], "Give the follow-up either as text or with --task-file, not both."],
      [["run", "half", "--name", "other"], '--name only names a new run; run 20261014-010000 is already named "half".'],
      [["run", "half", "--agent", "pm"], "--agent only starts a new solo run; a continued run keeps the agents it started with."],
      [["run", "Do something useful", "--answer"], "--answer continues a run that waits for answers: agent-lyceum run <run> --answer"],
      [["run", "half", "more text", "--answer"], "--answer cannot be combined with a follow-up: answer first (run half --answer), then follow up."],
      [["run", "half", "--no-edit"], "--no-edit only goes with --answer."],
      [["run", "half", "  "], "The follow-up text is empty."],
    ];
    for (const [args, msg] of cases) {
      const r = sh(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err, args.join(" ")).toContain(msg);
    }
    expect(snapshot()).toBe(before);
    expect(lockFiles()).toEqual([]);
  });
});
