import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import { callAgent, callProject, callsDir, resolveCallAgent } from "../src/call.js";
import { ConfigError } from "../src/config.js";
import { buildClaudeSettings } from "../src/adapters/claude.js";
import { writePolicy } from "../src/policy.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const reply = (text: string): WakeResult => ({ ok: true, text, exitCode: 0, timedOut: false });
const CANCELLED: WakeResult = { ok: false, text: "", exitCode: null, timedOut: false, cancelled: true };
const FAIL: WakeResult = { ok: false, text: "", exitCode: 1, timedOut: false, error: "boom" };

const opts = (invoker: Invoker, over: Partial<Parameters<typeof callAgent>[0]> = {}) => ({
  home: env.home,
  agent: "fe-member",
  task: "what is in this repo?",
  dir: env.repo,
  invoker,
  say: () => {},
  ...over,
});

describe("resolveCallAgent", () => {
  it("resolves a global agent: global persona and global memory only, no mail, no ask", () => {
    env = makeEnv();
    const a = resolveCallAgent(env.home, "fe-member");
    expect(a.agentMd).toBe(path.join(env.home, "agents/fe-member/AGENT.md"));
    expect(a.memory).toEqual({ global: path.join(env.home, "agents/fe-member/memory") });
    expect([a.canMessage, a.canAskUser, a.canEditAgentMd, a.resume]).toEqual([[], false, false, false]);
  });

  it("falls back to <home>/agents/<name>/memory when team.yaml sets no memory", () => {
    env = makeEnv();
    write(path.join(env.home, "agents/pm/AGENT.md"), "# pm\n");
    fs.appendFileSync(path.join(env.home, "team.yaml"), "  pm:\n    runtime: claude-code\n");
    expect(resolveCallAgent(env.home, "pm").memory).toEqual({ global: path.join(env.home, "agents/pm/memory") });
  });

  it("lists the global agents when the name is not one of them", () => {
    env = makeEnv();
    expect(() => resolveCallAgent(env.home, "nobody")).toThrow(ConfigError);
    expect(() => resolveCallAgent(env.home, "nobody")).toThrow(/lead, fe-member, qa-member/);
  });

  it("refuses an agent without a runtime", () => {
    env = makeEnv();
    write(path.join(env.home, "agents/pm/AGENT.md"), "# pm\n");
    fs.appendFileSync(path.join(env.home, "team.yaml"), "  pm: {}\n");
    expect(() => resolveCallAgent(env.home, "pm")).toThrow(/no runtime/);
  });
});

describe("what a call may write", () => {
  it("is the working directory and the agent's own global memory, with no outbox and no AGENT.md", () => {
    env = makeEnv();
    const agent = resolveCallAgent(env.home, "fe-member");
    const project = callProject(env.home, agent, env.repo, path.join(callsDir(env.home), "c1"));
    const pol = writePolicy(project, agent);
    expect(project.dir).toBe(env.repo);
    expect(pol.allowDirs).toEqual([path.join(env.home, "agents/fe-member/memory")]);
    expect(pol.allowFiles).toEqual([]);
    expect(pol.deny).toContain(agent.agentMd);
    expect(pol.deny).toContain(path.join(env.home, "team.yaml"));
  });

  it("lets the sandbox write only the working directory and the agent's own memory, never the home or another agent's files", () => {
    env = makeEnv();
    const agent = resolveCallAgent(env.home, "fe-member");
    const project = callProject(env.home, agent, env.repo, path.join(callsDir(env.home), "c1"));
    const sandbox = buildClaudeSettings(project, agent).sandbox as { filesystem: { allowWrite: string[] } };
    expect(sandbox.filesystem.allowWrite).toEqual([env.repo, path.join(env.home, "agents/fe-member/memory")]);
  });
});

describe("callAgent", () => {
  it("wakes the agent once in the directory and keeps the task, the log dir and the answer", async () => {
    env = makeEnv();
    let seen: WakeInput | undefined;
    const r = await callAgent(opts(async (i) => {
      seen = i;
      return reply("it is a demo repo");
    }));
    expect(r).toMatchObject({ ok: true, cancelled: false, text: "it is a demo repo", reverted: [] });
    expect(seen!.project.dir).toBe(env.repo);
    expect(seen!.systemPrompt).toMatch(/working alone/);
    expect(seen!.systemPrompt).not.toMatch(/type: done/);
    expect(seen!.userPrompt).toMatch(/what is in this repo\?/);
    expect(fs.readFileSync(path.join(r.callDir, "task.md"), "utf8")).toBe("what is in this repo?");
    expect(fs.readFileSync(path.join(r.callDir, "result.md"), "utf8")).toMatch(/it is a demo repo/);
    expect(path.dirname(r.callDir)).toBe(callsDir(env.home));
    expect(fs.existsSync(path.join(env.project().paths.root, "lock.json"))).toBe(false);
  });

  it("creates the global memory directory the agent is told about", async () => {
    env = makeEnv();
    await callAgent(opts(async () => reply("ok")));
    expect(fs.statSync(path.join(env.home, "agents/fe-member/memory")).isDirectory()).toBe(true);
  });

  it("reports a failed wake-up and writes the error to result.md", async () => {
    env = makeEnv();
    const r = await callAgent(opts(async () => FAIL));
    expect(r).toMatchObject({ ok: false, cancelled: false, error: "boom" });
    expect(fs.readFileSync(path.join(r.callDir, "result.md"), "utf8")).toMatch(/boom/);
  });

  it("reports a cancelled call as cancelled, not failed", async () => {
    env = makeEnv();
    const ac = new AbortController();
    const r = await callAgent(opts((i) => new Promise((resolve) => {
      setTimeout(() => ac.abort(), 10);
      i.signal!.addEventListener("abort", () => resolve(CANCELLED));
    }), { signal: ac.signal }));
    expect(r).toMatchObject({ ok: false, cancelled: true });
  });

  it("puts back an AGENT.md the agent changed and says so", async () => {
    env = makeEnv();
    const md = path.join(env.home, "agents/fe-member/AGENT.md");
    const before = fs.readFileSync(md, "utf8");
    const r = await callAgent(opts(async () => {
      fs.writeFileSync(md, "# hijacked\n");
      return reply("done");
    }));
    expect(fs.readFileSync(md, "utf8")).toBe(before);
    expect(r.reverted).toEqual([md]);
  });

  it("refuses a working directory that is the home, inside it or above it, before writing anything", async () => {
    env = makeEnv();
    let called = false;
    const inv: Invoker = async () => {
      called = true;
      return reply("x");
    };
    for (const dir of [env.home, path.join(env.home, "projects"), env.root]) {
      await expect(callAgent(opts(inv, { dir }))).rejects.toThrow(/neither inside nor above/);
    }
    await expect(callAgent(opts(inv, { dir: env.home }))).rejects.toThrow(env.home);
    expect(called).toBe(false);
    expect(fs.existsSync(callsDir(env.home))).toBe(false);
  });

  it("refuses a missing directory, an empty task and an unknown agent before writing anything", async () => {
    env = makeEnv();
    const never: Invoker = async () => {
      throw new Error("must not be woken");
    };
    await expect(callAgent(opts(never, { dir: path.join(env.root, "nope") }))).rejects.toThrow(/Working directory not found/);
    await expect(callAgent(opts(never, { task: "  " }))).rejects.toThrow(/No task/);
    await expect(callAgent(opts(never, { agent: "nobody" }))).rejects.toThrow(ConfigError);
    expect(fs.existsSync(callsDir(env.home))).toBe(false);
  });
});

describe("one call per agent at a time", () => {
  it("rejects a second call to the same agent while the first runs, and allows another agent", async () => {
    env = makeEnv();
    let release!: () => void;
    const first = callAgent(opts((_i) => new Promise((resolve) => {
      release = () => resolve(reply("first"));
    })));
    await new Promise((r) => setTimeout(r, 50));
    await expect(callAgent(opts(async () => reply("second")))).rejects.toThrow(/already being called/);
    const other = await callAgent(opts(async () => reply("other"), { agent: "qa-member" }));
    expect(other.ok).toBe(true);
    release();
    expect((await first).text).toBe("first");
    // the lock is gone afterwards
    expect((await callAgent(opts(async () => reply("third")))).text).toBe("third");
  });

  it("takes over a lock whose process is gone", async () => {
    env = makeEnv();
    write(path.join(callsDir(env.home), ".lock-fe-member"), JSON.stringify({ pid: 2 ** 31 - 2, call_id: "old" }));
    expect((await callAgent(opts(async () => reply("ok")))).ok).toBe(true);
  });

  it("treats an unreadable lock file as stale", async () => {
    env = makeEnv();
    write(path.join(callsDir(env.home), ".lock-fe-member"), "not json");
    expect((await callAgent(opts(async () => reply("ok")))).ok).toBe(true);
  });
});
