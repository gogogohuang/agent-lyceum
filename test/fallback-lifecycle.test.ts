import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import type { ResolvedProject } from "../src/config.js";
import { runTeam } from "../src/dispatcher.js";
import { deliver, listUnread } from "../src/mailbox.js";
import { mailDir } from "../src/message-store.js";
import { inboxDir, outboxDir } from "../src/policy.js";
import { buildCodexInvocation } from "../src/adapters/codex.js";
import { failureGuide } from "../src/run-outcome.js";
import { bindRunProject, loadRunState, newRunState, saveRunState } from "../src/run-store.js";
import type { ErrorKind, FallbackEntry } from "../src/schema.js";
import { prepareTask } from "../src/task.js";
import { FULL_DONE, initGitRepo, makeEnv, withSections, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const fail = (kind: ErrorKind, error: string = `${kind} error`): WakeResult => ({ ok: false, text: "", exitCode: 1, timedOut: false, error, kind });
const send = (p: Parameters<typeof outboxDir>[0], from: string, to: string, subject: string, type = "reply") =>
  write(
    path.join(outboxDir(p, from), `${subject.replace(/\W+/g, "-")}-${Math.random().toString(16).slice(2)}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${type === "done" ? FULL_DONE : withSections(type, `body of ${subject}`)}\n`,
  );
const subjectsIn = (dir: string) =>
  (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith(".md")).map((f) => /subject: (.*)/.exec(fs.readFileSync(path.join(dir, f), "utf8"))![1]);
const allMail = (p: Parameters<typeof inboxDir>[0], agent: string) => [...subjectsIn(inboxDir(p, agent)), ...subjectsIn(path.join(inboxDir(p, agent), "read"))];
const attemptsOf = (runDir: string) => {
  const dir = path.join(mailDir(runDir), "attempts");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
};
const logEvents = (runDir: string, event: string) =>
  fs.readFileSync(path.join(runDir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === event);
/** `name:runtime/model` of the agent a call was made for. */
const who = (i: WakeInput) => `${i.agent.name}:${i.agent.runtime}/${i.agent.model ?? ""}`;

const BACKUP: FallbackEntry = { runtime: "claude-code", model: "backup" };
const CODEX: FallbackEntry = { runtime: "codex", model: "gpt-5" };

/** The project with these agents' fallback chains (and optionally their primary model) set, as `config` would resolve them. */
function withChains(project: ResolvedProject, chains: Record<string, FallbackEntry[]>, models: Record<string, string> = {}): ResolvedProject {
  for (const [name, chain] of Object.entries(chains)) project.agents[name]!.fallback = chain;
  for (const [name, model] of Object.entries(models)) project.agents[name]!.model = model;
  return project;
}

async function start(invoker: Invoker, chains: Record<string, FallbackEntry[]>, o: { git?: boolean; models?: Record<string, string>; yaml?: (text: string) => string } = {}) {
  env = makeEnv();
  if (o.git) initGitRepo(env.repo);
  if (o.yaml) env.editProjectYaml(o.yaml);
  const project = withChains(env.project(), chains, o.models);
  const runDir = path.join(project.paths.runs, "run-a");
  const task = prepareTask({ text: "go", cwd: env.root, runDir });
  const lines: string[] = [];
  const sleeps: number[] = [];
  const s = await runTeam({ project, task, runDir, invoker, log: (l) => lines.push(l), sleep: async (ms: number) => void sleeps.push(ms) });
  return { s, runDir, lines, sleeps, project, bound: bindRunProject(project, runDir, "run") };
}

describe("fallback in a run", () => {
  it("(a) rate_limit on the primary: the primary is called once, the backup finishes the run", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const { s, runDir, lines, sleeps } = await start(
      async (i) => {
        calls.push(who(i));
        prompts.push(i.userPrompt);
        if (i.agent.model !== "backup") return fail("rate_limit", "API Error: 429");
        send(i.project, "lead", "lead", "shipped", "done");
        return OK;
      },
      { lead: [BACKUP] },
    );
    expect(calls).toEqual(["lead:claude-code/", "lead:claude-code/backup"]);
    expect(s.endReason).toBe("done");
    expect(s.outcome).toBe("completed");
    expect(sleeps).toEqual([]);
    expect(prompts[1]).toMatch(/# Retry notice\nYour previous attempt at this wake-up failed \(API Error: 429\)/);
    expect(lines).toContain("  lead falling back to claude-code/backup (rate_limit)");
    const state = loadRunState(runDir);
    expect(state.rounds).toBe(2);
    expect(state.notes!.join("\n")).toMatch(/lead fell back from claude-code to claude-code\/backup \(rate_limit\).*side effects may have happened/);
    expect(state.wakes.map((w) => ({ ok: w.ok, runtime: w.runtime, model: w.model, fallback_from: w.fallback_from, kind: w.kind }))).toEqual([
      { ok: false, runtime: "claude-code", model: undefined, fallback_from: undefined, kind: "rate_limit" },
      { ok: true, runtime: "claude-code", model: "backup", fallback_from: "claude-code", kind: undefined },
    ]);
    expect(state.last_wake.lead).toMatchObject({ ok: true, runtime: "claude-code", model: "backup" });
    expect(Object.keys(state.cooldowns ?? {})).toEqual(["claude-code/"]);
    expect(state.cooldowns!["claude-code/"]!.kind).toBe("rate_limit");
    const wakes = logEvents(runDir, "wake");
    expect(wakes.map((w) => [w.runtime, w.model, w.fallback_from, w.kind])).toEqual([
      ["claude-code", undefined, undefined, "rate_limit"],
      ["claude-code", "backup", "claude-code", undefined],
    ]);
    expect(attemptsOf(runDir).map((a) => a.status)).toEqual(["failed", "committed"]);
  });

  it("(a2) a shared dispatcher.fallback that lists the primary: the primary is called once, the next distinct backup finishes", async () => {
    const calls: string[] = [];
    const { s, runDir, lines } = await start(
      async (i) => {
        calls.push(who(i));
        if (i.agent.name !== "lead") return OK;
        if (i.agent.model !== "haiku") return fail("rate_limit", "API Error: 429");
        send(i.project, "lead", "lead", "shipped", "done");
        return OK;
      },
      {},
      {
        models: { lead: "sonnet" },
        yaml: (t) => t.replace(/dispatcher:[^\n]*\n/, "dispatcher:\n  fallback: [{ model: sonnet }, { model: haiku }]\n"),
      },
    );
    expect(calls).toEqual(["lead:claude-code/sonnet", "lead:claude-code/haiku"]);
    expect(s.endReason).toBe("done");
    expect(lines).toContain("  lead falling back to claude-code/haiku (rate_limit)");
    const state = loadRunState(runDir);
    expect(Object.keys(state.cooldowns ?? {})).toEqual(["claude-code/sonnet"]);
    expect(state.wakes.map((w) => [w.model, w.fallback_from, w.kind])).toEqual([
      ["sonnet", undefined, "rate_limit"],
      ["haiku", "claude-code/sonnet", undefined],
    ]);
  });

  it("a codex backup of a claude-code agent with allow_web unset runs with web search disabled", async () => {
    const args: string[][] = [];
    const { s } = await start(
      async (i) => {
        if (i.agent.runtime !== "codex") return fail("rate_limit", "API Error: 429");
        args.push(buildCodexInvocation(i).args);
        send(i.project, "lead", "lead", "shipped", "done");
        return OK;
      },
      { lead: [CODEX] },
    );
    expect(s.endReason).toBe("done");
    expect(args).toHaveLength(1);
    expect(args[0]).toContain('web_search="disabled"');
  });

  it("(b) network error: the primary is retried `retry` times with backoff, then the backup takes over", async () => {
    const calls: string[] = [];
    const { s, runDir, sleeps, lines } = await start(
      async (i) => {
        calls.push(who(i));
        if (i.agent.model !== "backup") return fail("network", "ECONNRESET");
        send(i.project, "lead", "lead", "shipped", "done");
        return OK;
      },
      { lead: [BACKUP] },
    );
    expect(calls).toEqual(["lead:claude-code/", "lead:claude-code/", "lead:claude-code/", "lead:claude-code/backup"]);
    expect(sleeps).toEqual([5000, 15000]);
    expect(s.endReason).toBe("done");
    expect(lines).toContain("  lead falling back to claude-code/backup (network)");
    const state = loadRunState(runDir);
    expect(state.rounds).toBe(4);
    expect(state.cooldowns).toBeUndefined(); // only rate_limit / quota cool a model down
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"))).not.toHaveProperty("cooldowns");
  });

  it.each([
    ["auth", 1],
    ["unknown", 3],
  ] as const)("(c) %s never switches: the run fails and failure.tried lists only the primary", async (kind, n) => {
    const calls: string[] = [];
    const { s, runDir, lines } = await start(
      async (i) => {
        calls.push(who(i));
        return fail(kind, `${kind} trouble`);
      },
      { lead: [BACKUP] },
    );
    expect(calls).toEqual(Array(n).fill("lead:claude-code/"));
    expect(s.endReason).toBe("lead_failed");
    expect(s.failure).toEqual({ agent: "lead", error: `${kind} trouble`, attempts: n, tried: [{ runtime: "claude-code", kind, error: `${kind} trouble` }] });
    expect(loadRunState(runDir).failure).toEqual(s.failure);
    expect(lines.some((l) => l.includes("falling back"))).toBe(false);
  });

  it("(d) every candidate fails: failure.tried lists each in order and failureGuide shows them", async () => {
    const calls: string[] = [];
    const { s, runDir } = await start(
      async (i) => {
        calls.push(who(i));
        if (i.agent.runtime === "codex") return fail("network", "ENOTFOUND");
        return i.agent.model === "backup" ? fail("quota", "out of credits") : fail("rate_limit", "429");
      },
      { lead: [BACKUP, CODEX] },
    );
    expect(calls).toEqual(["lead:claude-code/", "lead:claude-code/backup", "lead:codex/gpt-5", "lead:codex/gpt-5", "lead:codex/gpt-5"]);
    expect(s.endReason).toBe("lead_failed");
    expect(s.failure).toEqual({
      agent: "lead",
      error: "ENOTFOUND",
      attempts: 5,
      tried: [
        { runtime: "claude-code", kind: "rate_limit", error: "429" },
        { runtime: "claude-code", model: "backup", kind: "quota", error: "out of credits" },
        { runtime: "codex", model: "gpt-5", kind: "network", error: "ENOTFOUND" },
      ],
    });
    const state = loadRunState(runDir);
    expect(state.failure).toEqual(s.failure);
    expect(state.rounds).toBe(5);
    expect(Object.keys(state.cooldowns ?? {}).sort()).toEqual(["claude-code/", "claude-code/backup"]);
    const g = failureGuide("demo", "run-a", s.failure!, runDir);
    expect(g).toContain("lead was called 5 time(s) and failed every time (ENOTFOUND)");
    expect(g).toContain("  1. claude-code: rate_limit (429)");
    expect(g).toContain("  2. claude-code/backup: quota (out of credits)");
    expect(g).toContain("  3. codex/gpt-5: network (ENOTFOUND)");
    expect(g).toContain("agent-lyceum resume run-a -p demo");
  });

  it("(e) a cooled-down primary is skipped by the next wake of the same agent", async () => {
    const calls: string[] = [];
    let lead = 0;
    const { s } = await start(
      async (i) => {
        calls.push(who(i));
        if (i.agent.name === "fe-member") {
          send(i.project, "fe-member", "lead", "fe done");
          return OK;
        }
        if (i.agent.model !== "backup") return fail("rate_limit");
        lead++;
        if (lead === 1) send(i.project, "lead", "fe-member", "job", "task");
        else send(i.project, "lead", "lead", "shipped", "done");
        return OK;
      },
      { lead: [BACKUP] },
    );
    expect(s.endReason).toBe("done");
    expect(calls).toEqual(["lead:claude-code/", "lead:claude-code/backup", "fe-member:claude-code/", "lead:claude-code/backup"]);
  });

  it("(e) parallel members share one cooldown table", async () => {
    const calls: string[] = [];
    let replies = 0;
    let second = false;
    const { s, runDir } = await start(
      async (i) => {
        calls.push(who(i));
        if (i.agent.name === "lead") {
          if (replies === 0) for (const m of ["fe-member", "qa-member"]) send(i.project, "lead", m, "job 1", "task");
          else if (replies >= 2 && !second) {
            second = true;
            for (const m of ["fe-member", "qa-member"]) send(i.project, "lead", m, "job 2", "task");
          } else if (replies >= 4) send(i.project, "lead", "lead", "shipped", "done");
          return OK;
        }
        if (i.agent.name === "fe-member" && i.agent.model === "main") return fail("rate_limit");
        replies++;
        send(i.project, i.agent.name, "lead", `${i.agent.name} done ${replies}`);
        return OK;
      },
      { "fe-member": [BACKUP], "qa-member": [BACKUP] },
      { git: true, models: { "fe-member": "main", "qa-member": "main" } },
    );
    expect(s.endReason).toBe("done");
    // qa-member was planned before fe-member's rate limit, so its first wake used the primary; its second starts at the backup.
    expect(calls.filter((c) => c.startsWith("qa-member"))).toEqual(["qa-member:claude-code/main", "qa-member:claude-code/backup"]);
    expect(calls.filter((c) => c.startsWith("fe-member"))).toEqual(["fe-member:claude-code/main", "fe-member:claude-code/backup", "fe-member:claude-code/backup"]);
    expect(Object.keys(loadRunState(runDir).cooldowns ?? {})).toEqual(["claude-code/main"]);
  });

  it("(f) the backup's session is kept under agent@runtime/model and the primary's key is untouched", async () => {
    const seen: [string, string | undefined][] = [];
    let lead = 0;
    let feDone = 0;
    let failedOnce = false;
    const { s, runDir } = await start(
      async (i) => {
        if (i.agent.name === "fe-member") {
          send(i.project, "fe-member", "lead", `fe done ${++feDone}`);
          return OK;
        }
        seen.push([i.agent.model ?? "", i.sessionId]);
        lead++;
        if (lead === 1) {
          send(i.project, "lead", "fe-member", "job 1", "task");
          return { ...OK, sessionId: "s-main" };
        }
        if (i.agent.model !== "backup") {
          failedOnce = true;
          return { ...fail("rate_limit"), sessionId: "s-main-2" };
        }
        if (failedOnce && lead === 3) send(i.project, "lead", "fe-member", "job 2", "task");
        else send(i.project, "lead", "lead", "shipped", "done");
        return { ...OK, sessionId: "s-backup" };
      },
      { lead: [BACKUP] },
    );
    expect(s.endReason).toBe("done");
    expect(seen).toEqual([
      ["", undefined],
      ["", "s-main"],
      ["backup", undefined], // never the primary's session
      ["backup", "s-backup"],
    ]);
    expect(loadRunState(runDir).sessions).toEqual({ lead: "s-main-2", "lead@claude-code/backup": "s-backup" });
  });

  it("(g) after a switch the member's mail is handled by the backup, nothing stale is routed, and each call is one round and one attempt", async () => {
    const prompts: string[] = [];
    const { s, runDir, bound } = await start(
      async (i) => {
        if (i.agent.name === "lead") {
          if (i.userPrompt.includes("fe done")) send(i.project, "lead", "lead", "shipped", "done");
          else send(i.project, "lead", "fe-member", "job", "task");
          return OK;
        }
        prompts.push(i.userPrompt);
        if (i.agent.model !== "backup") {
          send(i.project, "fe-member", "lead", "stale half result");
          return fail("quota");
        }
        send(i.project, "fe-member", "lead", "fe done");
        return OK;
      },
      { "fe-member": [BACKUP] },
    );
    expect(s.endReason).toBe("done");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("job");
    expect(allMail(bound, "lead")).toContain("fe done");
    expect(allMail(bound, "lead")).not.toContain("stale half result");
    expect(listUnread(bound, "fe-member")).toEqual([]);
    const fe = attemptsOf(runDir).filter((a) => a.agent === "fe-member");
    expect(fe.map((a) => a.status)).toEqual(["failed", "committed"]);
    expect(subjectsIn(path.join(mailDir(runDir), "attempts", fe[0].id, "outbox"))).toEqual(["stale half result"]);
    const state = loadRunState(runDir);
    expect(state.wakes.map((w) => w.round)).toEqual(Array.from({ length: state.rounds }, (_, k) => k + 1));
    expect(state.wakes.filter((w) => w.agent === "fe-member").map((w) => [w.model, w.ok])).toEqual([
      [undefined, false],
      ["backup", true],
    ]);
  });

  it("stops at the round limit between candidates like it does between retries", async () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("max_rounds: 0", "max_rounds: 1"));
    const project = withChains(env.project(), { lead: [BACKUP] });
    const runDir = path.join(project.paths.runs, "run-a");
    const calls: string[] = [];
    const s = await runTeam({
      project,
      task: prepareTask({ text: "go", cwd: env.root, runDir }),
      runDir,
      invoker: async (i) => {
        calls.push(who(i));
        return fail("rate_limit");
      },
      log: () => {},
      sleep: async () => {},
    });
    expect(calls).toEqual(["lead:claude-code/"]);
    expect(s.endReason).toBe("max_rounds");
    expect(s.failure).toBeUndefined();
    expect(listUnread(bindRunProject(project, runDir, "run"), "lead")).toHaveLength(1);
  });

  it("a cancel during the backoff ends the wake as cancelled without calling again or announcing a switch", async () => {
    env = makeEnv();
    const project = withChains(env.project(), { lead: [BACKUP] });
    const runDir = path.join(project.paths.runs, "run-a");
    const ac = new AbortController();
    const calls: string[] = [];
    const lines: string[] = [];
    const s = await runTeam({
      project,
      task: prepareTask({ text: "go", cwd: env.root, runDir }),
      runDir,
      signal: ac.signal,
      invoker: async (i) => {
        calls.push(who(i));
        return fail("network");
      },
      log: (l) => lines.push(l),
      sleep: async () => ac.abort(),
    });
    expect(calls).toEqual(["lead:claude-code/"]);
    expect(s.endReason).toBe("cancelled");
    expect(s.failure).toBeUndefined();
    expect(lines).toContain("  lead stopped (cancelled)");
    expect(listUnread(bindRunProject(project, runDir, "run"), "lead")).toHaveLength(1);
  });

  it("a cancel that ends the call itself does not announce a switch", async () => {
    env = makeEnv();
    const project = withChains(env.project(), { lead: [BACKUP] });
    const runDir = path.join(project.paths.runs, "run-a");
    const ac = new AbortController();
    const lines: string[] = [];
    const calls: string[] = [];
    const s = await runTeam({
      project,
      task: prepareTask({ text: "go", cwd: env.root, runDir }),
      runDir,
      signal: ac.signal,
      invoker: async (i) => {
        calls.push(who(i));
        ac.abort(); // e.g. Ctrl-C while the CLI reported a rate limit
        return fail("rate_limit");
      },
      log: (l) => lines.push(l),
      sleep: async () => {},
    });
    expect(calls).toEqual(["lead:claude-code/"]);
    expect(s.endReason).toBe("cancelled");
    expect(lines.some((l) => l.includes("falling back"))).toBe(false);
  });

  it("(i) an older state.json without cooldowns or the new wake fields resumes", async () => {
    let failing = true;
    const invoker: Invoker = async (i) => {
      if (failing) return fail("auth");
      send(i.project, "lead", "lead", "shipped", "done");
      return OK;
    };
    const { s, runDir, project } = await start(invoker, { lead: [BACKUP] });
    expect(s.endReason).toBe("lead_failed");
    const file = path.join(runDir, "state.json");
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    delete old.cooldowns;
    for (const w of old.wakes) for (const k of ["runtime", "model", "fallback_from", "kind"]) delete w[k];
    for (const w of Object.values(old.last_wake) as Record<string, unknown>[]) for (const k of ["runtime", "model"]) delete w[k];
    delete old.failure.tried;
    fs.writeFileSync(file, JSON.stringify(old));
    failing = false;
    const again = await runTeam({ project, resume: loadRunState(runDir), runDir, invoker, log: () => {}, sleep: async () => {} });
    expect(again.endReason).toBe("done");
    expect(loadRunState(runDir).wakes.at(-1)).toMatchObject({ ok: true, runtime: "claude-code" });
  });
});

/** A resumed run whose state already holds `sessions`, with a task waiting for `agent`; the agents get `chains`. */
async function resumedWith(agent: string, sessions: Record<string, string>, invoker: Invoker, chains: Record<string, FallbackEntry[]>) {
  env = makeEnv();
  const project = withChains(env.project(), chains);
  project.agents[agent]!.resume = true;
  const runDir = path.join(project.paths.runs, "run-a");
  fs.mkdirSync(runDir, { recursive: true });
  const p = bindRunProject(project, runDir, "run");
  saveRunState(runDir, { ...newRunState({ run_id: "run-a", project: project.name, max_rounds: 10, rounds: 1, pid: 1, task_summary: "t" }), sessions });
  deliver(p, { from: "lead", to: agent, type: "task", subject: "job", body: "x" });
  const s = await runTeam({ project, resume: loadRunState(runDir), runDir, invoker, log: () => {}, sleep: async () => {} });
  return { s, runDir, project };
}

describe("fallback note says whether the backup resumes a session (T13)", () => {
  const run = async (sessions: Record<string, string>) => {
    const { runDir } = await resumedWith(
      "lead",
      sessions,
      async (i) => {
        if (i.agent.model !== "backup") return fail("rate_limit", "429");
        send(i.project, "lead", "lead", "shipped", "done");
        return OK;
      },
      { lead: [BACKUP] },
    );
    return loadRunState(runDir).notes!.find((n) => n.includes("fell back"))!;
  };

  it("names the backup's own earlier session when it has one", async () => {
    expect(await run({ "lead@claude-code/backup": "SB" })).toContain("the backup resumes its own earlier session and redoes this wake-up");
  });

  it("still says a fresh session when the backup has none", async () => {
    const note = await run({ lead: "S0" });
    expect(note).toContain("the backup starts a fresh session and redoes this wake-up");
    expect(note).toContain("side effects may have happened");
  });
});

describe("a backup gets the failed model's draft whatever the sessions (T17c)", () => {
  const MARKER = "T17C-DRAFT-BODY";
  const run = async (sessions: Record<string, string>) => {
    const calls: WakeInput[] = [];
    await resumedWith(
      "fe-member",
      sessions,
      async (i) => {
        if (i.agent.name === "lead") {
          if (i.userPrompt.includes("fe finished")) send(i.project, "lead", "lead", "all good", "done");
          return OK;
        }
        calls.push(i);
        if (i.agent.model !== "backup") {
          write(path.join(outboxDir(i.project, "fe-member"), "draft.md"), `---\nto: lead\ntype: reply\nsubject: half\n---\n\n${MARKER}\n`);
          return { ...fail("rate_limit", "429"), sessionId: "SA" };
        }
        send(i.project, "fe-member", "lead", "fe finished");
        return OK;
      },
      { "fe-member": [BACKUP] },
    );
    return calls;
  };

  it("resumes the backup's own session and still carries the draft", async () => {
    const calls = await run({ "fe-member@claude-code/backup": "SB" });
    expect(calls.map((c) => c.agent.model ?? "")).toEqual(["", "backup"]);
    expect(calls[1]!.sessionId).toBe("SB");
    expect(calls[1]!.userPrompt).toContain(MARKER);
  });

  it("with no session of its own the backup starts fresh and still carries the draft", async () => {
    const calls = await run({});
    expect(calls[1]!.agent.model).toBe("backup");
    expect(calls[1]!.sessionId).toBeUndefined();
    expect(calls[1]!.userPrompt).toContain(MARKER);
  });
});

describe("no fallback configured (spec 20.2 decision 11)", () => {
  it("keeps state.json, log.jsonl, the failure and the printed lines exactly as before", async () => {
    let feCalls = 0;
    let slept = false;
    env = makeEnv();
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-a");
    const lines: string[] = [];
    const s = await runTeam({
      project,
      task: prepareTask({ text: "go", cwd: env.root, runDir }),
      runDir,
      invoker: async (i) => {
        if (i.agent.name === "lead") {
          send(i.project, "lead", "fe-member", "job", "task");
          return { ...OK, sessionId: "s1" };
        }
        feCalls++;
        return fail("rate_limit", "boom"); // adapters classify every failure now; without a chain that changes nothing
      },
      log: (l) => lines.push(l),
      sleep: async () => {
        slept = true;
      },
    });
    expect(feCalls).toBe(3);
    expect(slept).toBe(false);
    expect(s.failure).toEqual({ agent: "fe-member", error: "boom", attempts: 3 });
    expect(Object.keys(s.failure!)).toEqual(["agent", "error", "attempts"]);
    const raw = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
    expect(raw).not.toHaveProperty("cooldowns");
    expect(Object.keys(raw.failure)).toEqual(["agent", "error", "attempts"]);
    expect(raw.sessions).toEqual({ lead: "s1" });
    expect(raw.wakes.map((w: object) => Object.keys(w))).toEqual([
      ["round", "agent", "at", "duration_ms", "ok", "handling", "sent"],
      ["round", "agent", "at", "duration_ms", "ok", "handling", "error"],
      ["round", "agent", "at", "duration_ms", "ok", "handling", "error"],
      ["round", "agent", "at", "duration_ms", "ok", "handling", "error"],
    ]);
    expect(Object.fromEntries(Object.entries(raw.last_wake).map(([k, v]) => [k, Object.keys(v as object)]))).toEqual({
      lead: ["at", "ok"],
      "fe-member": ["at", "ok", "error"],
    });
    expect(logEvents(runDir, "wake").map((e) => Object.keys(e))).toEqual([
      ["ts", "event", "agent", "runtime", "attempt", "ok", "exit_code", "timed_out", "duration_ms", "messages"],
      ["ts", "event", "agent", "runtime", "attempt", "ok", "exit_code", "timed_out", "duration_ms", "messages", "error"],
      // a retry names the failed attempts it redoes (spec 22.5.5)
      ["ts", "event", "agent", "runtime", "attempt", "ok", "exit_code", "timed_out", "duration_ms", "messages", "error", "redo_of"],
      ["ts", "event", "agent", "runtime", "attempt", "ok", "exit_code", "timed_out", "duration_ms", "messages", "error", "redo_of"],
    ]);
    expect(logEvents(runDir, "wake").map((e) => e.attempt)).toEqual([0, 0, 1, 2]);
    expect(lines.filter((l) => !/agents take turns|format warning/.test(l))).toEqual([
      "[round 1] waking lead (claude-code)",
      "[round 2] waking fe-member (claude-code)",
      "  fe-member failed: boom",
      "  fe-member attempt 1 failed (boom). Anything it already did outside its mailbox (file edits, commands) was not undone: side effects may have happened.",
      "[round 3] waking fe-member (claude-code) — retry 1",
      "  fe-member failed: boom",
      "  fe-member attempt 2 failed (boom). Anything it already did outside its mailbox (file edits, commands) was not undone: side effects may have happened.",
      "[round 4] waking fe-member (claude-code) — retry 2",
      "  fe-member failed: boom",
      "  fe-member attempt 3 failed (boom). Anything it already did outside its mailbox (file edits, commands) was not undone: side effects may have happened.",
    ]);
  });
});

describe("fallback through the real CLI and fake runtime", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.join(here, "..", "src", "cli.ts");
  const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
  const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

  it("a rate-limited lead falls back to its backup model and the run completes", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("  lead:\n", "  lead:\n    fallback: [{ model: backup }]\n"));
    const bin = path.join(env.root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
    const r = spawnSync(tsx, [cli, "--home", env.home, "run", "do it", "-p", "demo"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_FAIL: "rate_limit:1", FAKE_FAIL_COUNT: path.join(env.root, "fails"), FAKE_MODE: "completed" },
    });
    expect(r.stdout).toContain("lead falling back to claude-code/backup (rate_limit)");
    expect(r.stdout).toMatch(/outcome: completed/);
    expect(r.status).toBe(0);
  }, 60_000);
});
