import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { listUnread } from "../src/mailbox.js";
import { listAttempts, mailDir } from "../src/message-store.js";
import { outboxDir } from "../src/policy.js";
import { bindRunProject, loadRunState } from "../src/run-store.js";
import { exitCodeForOutcome } from "../src/schema.js";
import { prepareTask } from "../src/task.js";
import { FULL_DONE, makeEnv, write, type TestEnv } from "./helpers.js";
import type { ResolvedProject } from "../src/config.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const CANCELLED: WakeResult = { ok: false, text: "", exitCode: null, timedOut: false, cancelled: true, error: "cancelled" };
const done = (p: ResolvedProject) =>
  write(path.join(outboxDir(p, "lead"), `${Math.random()}.md`), `---\ntype: done\nsubject: bye\noutcome: completed\n---\n\n${FULL_DONE}\n`);

describe("cancelling a run", () => {
  function setup() {
    env = makeEnv();
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    return { project, runDir, task: prepareTask({ text: "go", cwd: env.root, runDir }) };
  }

  it("ends cancelled, keeps the unread mail, reports nothing as failed, and resumes to completion", async () => {
    const { project, runDir, task } = setup();
    const ac = new AbortController();
    const invoker: Invoker = (i) =>
      new Promise((resolve) => {
        // the lead is "working": write half an answer, then get cancelled
        write(path.join(outboxDir(i.project, "lead"), "half.md"), "---\nto: fe-member\ntype: task\nsubject: half\n---\n\nunfinished\n");
        setTimeout(() => ac.abort(), 50);
        i.signal!.addEventListener("abort", () => resolve(CANCELLED));
      });
    const s = await runTeam({ project, task, runDir, invoker, signal: ac.signal, log: () => {} });
    expect(s.endReason).toBe("cancelled");
    expect(s.outcome).toBe("cancelled");
    expect(exitCodeForOutcome(s.outcome)).toBe(130);

    const st = loadRunState(runDir);
    expect(st.end_reason).toBe("cancelled");
    expect(st.active).toEqual({});
    const bound = bindRunProject(env.project(), runDir, "run");
    expect(listUnread(bound, "lead")).toHaveLength(1); // the task is still waiting
    expect(listUnread(bound, "lead").some((m) => /fail/i.test(m.meta.type))).toBe(false);
    expect(listUnread(bound, "fe-member")).toHaveLength(0); // the half-written task was not delivered
    const att = listAttempts(runDir);
    expect(att.map((a) => [a.status, a.error])).toEqual([["failed", "cancelled"]]);
    expect(fs.existsSync(path.join(mailDir(runDir), "attempts", att[0].id, "outbox", "half.md"))).toBe(true);

    const r = await runTeam({ project: env.project(), resume: loadRunState(runDir), runDir, invoker: async (i) => {
      done(i.project);
      return OK;
    }, log: () => {} });
    expect(r.endReason).toBe("done");
    expect(r.outcome).toBe("completed");
  });

  it("does not wake anyone when it is cancelled before the first wake-up", async () => {
    const { project, runDir, task } = setup();
    const ac = new AbortController();
    ac.abort();
    let woken = 0;
    const s = await runTeam({ project, task, runDir, invoker: async () => {
      woken++;
      return OK;
    }, signal: ac.signal, log: () => {} });
    expect(s.endReason).toBe("cancelled");
    expect(woken).toBe(0);
  });
});

describe("the CLI on Ctrl-C", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.join(here, "..", "src", "cli.ts");
  const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
  const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (cond: () => boolean, ms = 15000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  };
  const cliRun = (home: string, bin: string, args: string[], extraEnv: Record<string, string>) =>
    spawn(tsx, [cli, "--home", home, ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = (c: ReturnType<typeof spawn>) => new Promise<number | null>((r) => c.on("exit", (code) => r(code)));

  it("stops the agents, releases the lock, exits 130, and a later resume finishes the job (exit 0)", async () => {
    env = makeEnv();
    const bin = path.join(env.root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
    const marker = path.join(env.root, "marker.json");

    const first = cliRun(env.home, bin, ["run", "do it", "-p", "demo"], { FAKE_MODE: "sleep", FAKE_MARKER: marker });
    await until(() => fs.existsSync(marker));
    expect(fs.existsSync(marker)).toBe(true);
    const pids = JSON.parse(fs.readFileSync(marker, "utf8")) as { pid: number; grandchild: number };
    expect(fs.existsSync(path.join(env.project().paths.root, "lock.json"))).toBe(true);

    first.kill("SIGINT");
    const code = await exited(first);
    expect(code).toBe(130);
    await until(() => !alive(pids.pid) && !alive(pids.grandchild));
    expect(alive(pids.pid)).toBe(false);
    expect(alive(pids.grandchild)).toBe(false);
    expect(fs.existsSync(path.join(env.project().paths.root, "lock.json"))).toBe(false);

    const second = cliRun(env.home, bin, ["resume", "-p", "demo"], { FAKE_MODE: "completed" });
    expect(await exited(second)).toBe(0);
  }, 90_000);
});
