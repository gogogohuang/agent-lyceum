import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import type { ResolvedAgent, ResolvedProject } from "../src/config.js";
import { runTeam } from "../src/dispatcher.js";
import { agentForCandidate, candidatesFor, Cooldowns, planAttempts } from "../src/fallback.js";
import { deliver, listUnread, serialize } from "../src/mailbox.js";
import { outboxDir } from "../src/policy.js";
import { buildSystemPrompt, PARALLEL_SECTION, TIER_SECTION } from "../src/prompt.js";
import { bindRunProject, loadRunState, newRunState, saveRunState, type RunState } from "../src/run-store.js";
import type { ErrorKind, FallbackEntry, Tier } from "../src/schema.js";
import { buildStatusReport, formatStatusReport } from "../src/status.js";
import { FULL_DONE, makeEnv, withSections, write, type TestEnv } from "./helpers.js";

const envs: TestEnv[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.cleanup();
});

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const fail = (kind: ErrorKind, error: string = `${kind} error`): WakeResult => ({ ok: false, text: "", exitCode: 1, timedOut: false, error, kind });
const LADDER = ["haiku", "sonnet", "opus"];
const MEMBER = "fe-member";
const key = (m: string) => `claude-code/${m}`;
const sessionKey = (m: string) => `${MEMBER}@${key(m)}`;

const sendMail = (p: ResolvedProject, from: string, to: string, subject: string, type = "reply") =>
  write(
    path.join(outboxDir(p, from), `${subject.replace(/\W+/g, "-")}-${Math.random().toString(16).slice(2)}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${type === "done" ? FULL_DONE : withSections(type, `body of ${subject}`)}\n`,
  );

/** A task mail in `to`'s inbox as part B1 will deliver it: the `tier` line in the frontmatter. */
function deliverTask(p: ResolvedProject, to: string, subject: string, tier?: string | number) {
  const m = deliver(p, { from: "lead", to, type: "task", subject, body: "x" });
  if (tier !== undefined) fs.writeFileSync(m.file, serialize({ ...m.meta, tier: tier as Tier }, m.body));
  return m;
}

function setup(o: { tiers?: string[] | null; model?: string; resume?: boolean; chain?: FallbackEntry[] } = {}) {
  const env = makeEnv();
  envs.push(env);
  const project = env.project();
  const a = project.agents[MEMBER]!;
  a.model = o.model ?? "opus";
  if (o.tiers !== null) a.tiers = o.tiers ?? LADDER;
  if (o.resume !== undefined) a.resume = o.resume;
  if (o.chain) a.fallback = o.chain;
  const runDir = path.join(project.paths.runs, "run-a");
  fs.mkdirSync(runDir, { recursive: true });
  return { env, project, runDir };
}

interface Seen {
  model?: string;
  sessionId?: string;
  userPrompt: string;
  systemPrompt: string;
}

/** A resumed run with `mails` (one task each, in order) waiting for the member; the lead says `done` after the last reply. */
async function go(
  o: {
    tiers?: string[] | null;
    model?: string;
    resume?: boolean;
    chain?: FallbackEntry[];
    mails: (string | number | undefined)[];
    sessions?: Record<string, string>;
    cooldowns?: RunState["cooldowns"];
    member?: (i: WakeInput, n: number) => WakeResult | undefined;
    signal?: AbortSignal;
  },
) {
  const { env, project, runDir } = setup(o);
  const p = bindRunProject(project, runDir, "run");
  saveRunState(runDir, {
    ...newRunState({ run_id: "run-a", project: project.name, max_rounds: 20, rounds: 1, pid: 1, task_summary: "t" }),
    sessions: o.sessions ?? {},
    ...(o.cooldowns ? { cooldowns: o.cooldowns } : {}),
  });
  for (const [i, t] of o.mails.entries()) deliverTask(p, MEMBER, `job ${i}`, t);
  const seen: Seen[] = [];
  const leadSeen: Seen[] = [];
  const lines: string[] = [];
  let replies = 0;
  let n = 0;
  const invoker: Invoker = async (i) => {
    const s = { model: i.agent.model, sessionId: i.sessionId, userPrompt: i.userPrompt, systemPrompt: i.systemPrompt };
    if (i.agent.name === "lead") {
      leadSeen.push(s);
      if (replies >= o.mails.length) sendMail(i.project, "lead", "lead", "shipped", "done");
      return OK;
    }
    seen.push(s);
    const r = o.member?.(i, n++);
    if (r) return r;
    replies++;
    sendMail(i.project, MEMBER, "lead", `reply ${replies}`);
    return { ...OK, sessionId: `S-${i.agent.model}` };
  };
  const run = () => runTeam({ project, resume: loadRunState(runDir), runDir, invoker, log: (l) => lines.push(l), sleep: async () => {}, signal: o.signal });
  const s = await run();
  return { s, seen, leadSeen, lines, runDir, project, env, run, p };
}

const logEvents = (runDir: string, event: string) =>
  fs.readFileSync(path.join(runDir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === event);

function agentOf(extra: Partial<ResolvedAgent> = {}): ResolvedAgent {
  const { project } = setup();
  return { ...project.agents[MEMBER]!, model: "opus", tiers: LADDER, ...extra };
}

describe("candidatesFor with a tier model (T-8d, T-9)", () => {
  it("puts the tiered candidate first, as a non-primary that is not a chain entry", () => {
    const cs = candidatesFor(agentOf(), "haiku");
    expect(cs.map((c) => [c.key, c.primary, c.tiered])).toEqual([
      [key("haiku"), false, true],
      [key("opus"), true, undefined],
    ]);
  });

  it("adds nothing for the ceiling or no tier, and dedups a chain entry with the same key (case-insensitive)", () => {
    const a = agentOf({ fallback: [{ runtime: "claude-code", model: "HAIKU" }, { runtime: "codex", model: "gpt-5" }] });
    expect(candidatesFor(a, "OPUS").map((c) => c.key)).toEqual(candidatesFor(a).map((c) => c.key));
    expect(candidatesFor(a).map((c) => c.tiered)).toEqual([undefined, undefined, undefined]);
    const cs = candidatesFor(a, "haiku");
    expect(cs.map((c) => c.key)).toEqual([key("haiku"), key("opus"), "codex/gpt-5"]);
    expect(cs[0]!.tiered).toBe(true);
  });

  it("agentForCandidate: tiered keeps runtime, effort and allow_web and swaps only the model", () => {
    const a = agentOf({ effort: "high", allowWeb: undefined });
    const tiered = agentForCandidate(a, candidatesFor(a, "haiku")[0]!);
    expect(tiered).toEqual({ ...a, model: "haiku" });
    expect("allowWeb" in tiered).toBe("allowWeb" in a);
  });

  const chain = [{ runtime: "codex", model: "gpt-5" } as FallbackEntry];
  const plan = (cool: Record<string, number>) => {
    const all = candidatesFor(agentOf({ fallback: chain }), "haiku");
    const c = new Cooldowns();
    for (const [k, sec] of Object.entries(cool)) c.mark(k, "rate_limit", 0, sec);
    return planAttempts(all, c, 1000).map((x) => x.key);
  };
  it("T-9a..d: planAttempts filters the one list", () => {
    expect(plan({})).toEqual([key("haiku"), key("opus"), "codex/gpt-5"]);
    expect(plan({ [key("haiku")]: 60 })).toEqual([key("opus"), "codex/gpt-5"]);
    expect(plan({ [key("opus")]: 60 })).toEqual([key("haiku"), "codex/gpt-5"]);
    expect(plan({ [key("haiku")]: 60, [key("opus")]: 60, "codex/gpt-5": 60 })).toEqual([key("haiku"), key("opus"), "codex/gpt-5"]);
  });
  it("T-9e: without a tier the result is the old one", () => {
    const a = agentOf({ fallback: chain });
    expect(planAttempts(candidatesFor(a), new Cooldowns(), 0).map((c) => c.key)).toEqual([key("opus"), "codex/gpt-5"]);
  });
});

describe("a tiered wake (T-7, T-8)", () => {
  it("T-7: the member runs on the tier's model, other tiers and no tier on the ceiling; effort is the member's", async () => {
    const r = await go({ mails: ["low", "mid", "high", undefined] });
    expect(r.seen.map((s) => s.model)).toEqual(["haiku", "sonnet", "opus", "opus"]);
    const w = loadRunState(r.runDir).wakes.filter((x) => x.agent === MEMBER);
    expect(w.map((x) => x.tier)).toEqual(["low", "mid", "high", undefined]);
  });

  it("T-8a/b: ceiling -> low -> ceiling -> low use the ceiling's and the low model's own sessions", async () => {
    const r = await go({ resume: true, mails: [undefined, "low", undefined, "low"] });
    expect(r.seen.map((s) => [s.model, s.sessionId])).toEqual([
      ["opus", undefined],
      ["haiku", undefined],
      ["opus", "S-opus"],
      ["haiku", "S-haiku"],
    ]);
    expect(loadRunState(r.runDir).sessions).toEqual({ [MEMBER]: "S-opus", [sessionKey("haiku")]: "S-haiku" });
  });

  it("T-8c: a session first created on the low model never reaches the ceiling", async () => {
    const r = await go({ resume: true, mails: ["low", undefined] });
    expect(r.seen.map((s) => [s.model, s.sessionId])).toEqual([
      ["haiku", undefined],
      ["opus", undefined],
    ]);
    expect(Object.keys(loadRunState(r.runDir).sessions).sort()).toEqual([MEMBER, sessionKey("haiku")].sort());
  });

  it("T-8d: a chain entry on the tier's model shares its session key (on purpose)", async () => {
    const chain: FallbackEntry[] = [{ runtime: "claude-code", model: "Haiku" }];
    const r = await go({ resume: true, chain, mails: ["low"], sessions: { [sessionKey("haiku")]: "S-shared" } });
    expect(r.seen.map((s) => [s.model, s.sessionId])).toEqual([["haiku", "S-shared"]]);
  });

  it("T-8e: resume:false never passes a session id and keeps state.sessions empty", async () => {
    const r = await go({ resume: false, mails: ["low", undefined, "low"] });
    expect(r.seen.map((s) => s.sessionId)).toEqual([undefined, undefined, undefined]);
    expect(loadRunState(r.runDir).sessions).toEqual({});
  });

  it("a tier is ignored for an agent without a ladder, and an invalid value counts as no tier", async () => {
    const r = await go({ tiers: null, mails: ["low"] });
    expect(r.seen.map((s) => s.model)).toEqual(["opus"]);
    expect(loadRunState(r.runDir).wakes.find((w) => w.agent === MEMBER)!.tier).toBeUndefined();
    const bad = await go({ mails: ["Low", 1] });
    expect(bad.seen.map((s) => s.model)).toEqual(["opus", "opus"]);
  });

  it("records tier and model on the wake log line, state.wakes and last_wake", async () => {
    const r = await go({ mails: ["low"] });
    const w = logEvents(r.runDir, "wake").find((e) => e.agent === MEMBER)!;
    expect(w).toMatchObject({ tier: "low", model: "haiku", runtime: "claude-code" });
    expect(w).not.toHaveProperty("fallback_from");
    const st = loadRunState(r.runDir);
    expect(st.wakes.find((x) => x.agent === MEMBER)).toMatchObject({ tier: "low", model: "haiku", runtime: "claude-code" });
    expect(st.wakes.find((x) => x.agent === MEMBER)).not.toHaveProperty("fallback_from");
    expect(st.last_wake[MEMBER]).toMatchObject({ tier: "low", model: "haiku" });
    expect(r.lines.some((l) => l.endsWith(`waking ${MEMBER} (claude-code/haiku, tier low)`))).toBe(true);
  });
});

describe("order, step-up and fallback (T-9b..f, T-16)", () => {
  const CHAIN: FallbackEntry[] = [{ runtime: "claude-code", model: "backup" }];
  const calls = (r: { seen: Seen[] }) => r.seen.map((s) => s.model);

  it("T-9f/T-16b: a rate-limited low model steps up to the ceiling (not a fallback), is cooled, and the next low wake starts on the ceiling", async () => {
    const r = await go({
      chain: CHAIN,
      mails: ["low", "low"],
      member: (i) => (i.agent.model === "haiku" ? fail("rate_limit", "429") : undefined),
    });
    expect(calls(r)).toEqual(["haiku", "opus", "opus"]);
    const st = loadRunState(r.runDir);
    expect(Object.keys(st.cooldowns ?? {})).toEqual([key("haiku")]);
    const ws = st.wakes.filter((w) => w.agent === MEMBER);
    expect(ws.map((w) => [w.model, w.fallback_from, w.kind, w.tier])).toEqual([
      ["haiku", undefined, "rate_limit", "low"],
      ["opus", undefined, undefined, "low"],
      ["opus", undefined, undefined, "low"],
    ]);
    const step = logEvents(r.runDir, "tier_step_up");
    expect(step).toEqual([
      { event: "tier_step_up", agent: MEMBER, tier: "low", from: "claude-code/haiku", to: "claude-code/opus", reason: "rate_limit", ts: expect.anything() },
      { event: "tier_step_up", agent: MEMBER, tier: "low", from: "claude-code/haiku", to: "claude-code/opus", reason: "cooldown", ts: expect.anything() },
    ].map((e) => expect.objectContaining(e)));
    expect(r.lines.some((l) => l.startsWith(`  ${MEMBER} stepping up from tier low (claude-code/haiku) to claude-code/opus (rate_limit)`))).toBe(true);
    expect(r.lines.some((l) => l.includes(`${MEMBER} tier low model claude-code/haiku is cooling down (rate_limit,`) && l.endsWith("starting on claude-code/opus"))).toBe(true);
    expect(st.notes!.join("\n")).toMatch(/fe-member's tier low model claude-code\/haiku failed \(rate_limit\); it is woken again on claude-code\/opus, which starts a fresh session, and redoes this wake-up\. .*side effects may have happened/);
    expect(st.notes!.join("\n")).not.toMatch(/fell back/);
  });

  it("T-9c/T-16c: a rate-limited ceiling after the step-up goes to the chain, whose record names the ceiling", async () => {
    const r = await go({
      chain: CHAIN,
      mails: ["low"],
      member: (i) => (i.agent.model === "backup" ? undefined : fail("rate_limit")),
    });
    expect(calls(r)).toEqual(["haiku", "opus", "backup"]);
    const ws = loadRunState(r.runDir).wakes.filter((w) => w.agent === MEMBER);
    expect(ws.map((w) => w.fallback_from)).toEqual([undefined, undefined, "claude-code/opus"]);
    const report = buildStatusReport(r.project, "run-a");
    expect(report.agents.find((a) => a.name === MEMBER)!.fallback).toEqual({ from: "claude-code/opus", kind: "rate_limit" });
  });

  it("T-9b: a cooling low model is skipped; the ceiling's record has no fallback_from; the chain, if used, replaces the ceiling", async () => {
    const until = new Date(Date.now() + 600_000).toISOString();
    const r = await go({ chain: CHAIN, mails: ["low"], cooldowns: { [key("haiku")]: { until, kind: "rate_limit" } } });
    expect(calls(r)).toEqual(["opus"]);
    expect(loadRunState(r.runDir).wakes.find((w) => w.agent === MEMBER)!.fallback_from).toBeUndefined();
    const cool = await go({
      chain: CHAIN,
      mails: ["low"],
      cooldowns: { [key("haiku")]: { until, kind: "rate_limit" }, [key("opus")]: { until, kind: "quota" } },
    });
    expect(calls(cool)).toEqual(["backup"]);
    expect(loadRunState(cool.runDir).wakes.find((w) => w.agent === MEMBER)!.fallback_from).toBe("claude-code/opus");
  });

  it("T-9d: every candidate cooling down starts on the low model", async () => {
    const until = new Date(Date.now() + 600_000).toISOString();
    const r = await go({
      chain: CHAIN,
      mails: ["low"],
      cooldowns: Object.fromEntries(["haiku", "opus", "backup"].map((m) => [key(m), { until, kind: "rate_limit" as const }])),
    });
    expect(calls(r)[0]).toBe("haiku");
  });

  it.each(["auth", "unknown"] as const)("T-9f: %s on the low model stops; it does not step up", async (kind) => {
    const r = await go({ chain: CHAIN, mails: ["low"], member: () => fail(kind) });
    expect(new Set(calls(r))).toEqual(new Set(["haiku"]));
    expect(r.s.endReason).toBe("agent_failed");
    expect(logEvents(r.runDir, "tier_step_up")).toEqual([]);
  });

  it("T-16a: a first-try success on the low model is not reported as a backup", async () => {
    const r = await go({ chain: CHAIN, mails: ["low"] });
    expect(loadRunState(r.runDir).wakes.find((w) => w.agent === MEMBER)).not.toHaveProperty("fallback_from");
    const report = buildStatusReport(r.project, "run-a");
    expect(report.agents.find((a) => a.name === MEMBER)!.fallback).toBeUndefined();
  });

  it("T-14: status --json adds only tier/model to the wake; a tier model that is also a chain entry stays visible as a cooldown", async () => {
    const chain: FallbackEntry[] = [{ runtime: "claude-code", model: "haiku" }];
    const r = await go({ chain, mails: ["low"], member: (i) => (i.agent.model === "haiku" ? fail("rate_limit") : undefined) });
    const report = buildStatusReport(r.project, "run-a");
    const w = report.run!.wakes.filter((x) => x.agent === MEMBER);
    expect(Object.keys(w[0]!).sort()).toEqual(expect.arrayContaining(["tier", "model", "runtime", "kind"]));
    expect(report.agents.find((a) => a.name === MEMBER)!.cooldowns?.map((c) => c.model)).toEqual([key("haiku")]);
    // the low wake stepped up to the ceiling, so no tier line (24.9)
    expect(formatStatusReport(report)).not.toContain("tier low");
  });

  it("T-14: a tier-only wake leaves the agent's report without fallback fields", async () => {
    const r = await go({ mails: ["low"] });
    const a = buildStatusReport(r.project, "run-a").agents.find((x) => x.name === MEMBER)!;
    expect(a.fallback).toBeUndefined();
    expect(a.cooldowns).toBeUndefined();
    expect(formatStatusReport(buildStatusReport(r.project, "run-a"))).toContain(`${MEMBER} tier low（claude-code/haiku）`);
  });
});

describe("status tier line only for a wake that ran below the ceiling (spec 24.9)", () => {
  const CHAIN: FallbackEntry[] = [{ runtime: "claude-code", model: "backup" }];
  const text = async (o: Parameters<typeof go>[0]) => {
    const r = await go(o);
    return formatStatusReport(buildStatusReport(r.project, "run-a"));
  };
  it("a low wake that stepped up to the ceiling prints no tier line", async () => {
    const t = await text({ chain: CHAIN, mails: ["low"], member: (i) => (i.agent.model === "haiku" ? fail("rate_limit") : undefined) });
    expect(t).not.toContain("tier low");
  });
  it("a mid wake whose model is the ceiling (chain present) prints no tier line", async () => {
    const t = await text({ chain: CHAIN, model: "sonnet", mails: ["mid"] });
    expect(t).not.toContain("tier mid");
  });
  it("a low wake that ran low prints it", async () => {
    expect(await text({ chain: CHAIN, mails: ["low"] })).toContain(`${MEMBER} tier low（claude-code/haiku）`);
  });
  it("a low wake that ended on a chain entry prints the fallback line only", async () => {
    const t = await text({ chain: CHAIN, mails: ["low"], member: (i) => (i.agent.model === "backup" ? undefined : fail("rate_limit")) });
    expect(t).toContain("fallback");
    expect(t).not.toContain("tier low");
  });
});

describe("back-compat (T-13)", () => {
  /** What must not change when no tier applies: the member's calls and records, with ids, paths and times masked. */
  async function fingerprint(o: Parameters<typeof go>[0]) {
    const r = await go(o);
    const mask = (s: string) =>
      s.split(r.env.root).join("ROOT").replace(/\b[0-9a-f]{6,8}\b/g, "ID").replace(/\d{8}T\d{9}Z/g, "STAMP").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "TIME");
    const st = loadRunState(r.runDir);
    return mask(
      JSON.stringify({
        calls: r.seen.map((s) => ({ ...s, systemPrompt: s.systemPrompt })),
        wakes: st.wakes.map(({ at: _a, duration_ms: _d, ...w }) => w),
        sessions: st.sessions,
        cooldowns: st.cooldowns,
        log: logEvents(r.runDir, "wake").map(({ ts: _t, duration_ms: _d, ...e }) => e),
      }),
    );
  }

  it("T-13b: a ladder but no tier on the task changes nothing for the member", async () => {
    const base = await fingerprint({ tiers: null, resume: true, mails: [undefined] });
    expect(await fingerprint({ resume: true, mails: [undefined] })).toBe(base);
  });

  it("T-13c: tier high, and mid when mid is the ceiling, run exactly as without a tier except for the tier field", async () => {
    const strip = (s: string) => s.replace(/,"tier":"(high|mid)"/g, "");
    const base = await fingerprint({ tiers: null, resume: true, mails: [undefined] });
    expect(strip(await fingerprint({ resume: true, mails: ["high"] }))).toBe(base);
    expect(strip(await fingerprint({ resume: true, tiers: ["haiku", "opus"], mails: ["mid"] }))).toBe(base);
  });

  it("T-13d: an existing fallback chain without a tier behaves as before (fallback_from, session key, note)", async () => {
    const r = await go({ chain: [{ runtime: "claude-code", model: "backup" }], resume: true, mails: [undefined], member: (i) => (i.agent.model === "opus" ? fail("rate_limit") : undefined) });
    const st = loadRunState(r.runDir);
    expect(st.wakes.filter((w) => w.agent === MEMBER).map((w) => w.fallback_from)).toEqual([undefined, "claude-code/opus"]);
    expect(Object.keys(st.sessions)).toEqual([sessionKey("backup")]);
    expect(st.notes!.join("\n")).toMatch(/fe-member fell back from claude-code\/opus to claude-code\/backup \(rate_limit\); the backup starts a fresh session/);
    expect(logEvents(r.runDir, "tier_step_up")).toEqual([]);
  });

  it("T-13e: a state.json without tier and one with tier both load", async () => {
    const r = await go({ mails: ["low"] });
    const file = path.join(r.runDir, "state.json");
    const st = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(loadRunState(r.runDir).wakes.some((w) => w.tier === "low")).toBe(true);
    for (const w of st.wakes) delete w.tier;
    for (const w of Object.values(st.last_wake) as Record<string, unknown>[]) delete w.tier;
    fs.writeFileSync(file, JSON.stringify(st));
    expect(loadRunState(r.runDir).wakes.some((w) => w.tier)).toBe(false);
  });
});

describe("interrupted tiered wakes resume on the tier (T-17)", () => {
  it("T-17a/c: a cancel mid-wake keeps the mail unread; the resume starts on the low model with its own session", async () => {
    const ac = new AbortController();
    const r = await go({
      resume: true,
      mails: ["low"],
      sessions: { [sessionKey("haiku")]: "S-low", [MEMBER]: "S-top" },
      signal: ac.signal,
      member: () => {
        ac.abort();
        return { ...fail("crash"), cancelled: true };
      },
    });
    expect(r.s.endReason).toBe("cancelled");
    expect(r.seen.map((s) => [s.model, s.sessionId])).toEqual([["haiku", "S-low"]]);
    expect(listUnread(r.p, MEMBER)).toHaveLength(1);
    const again = await runTeam({ project: r.project, resume: loadRunState(r.runDir), runDir: r.runDir, invoker: async (i) => {
      r.seen.push({ model: i.agent.model, sessionId: i.sessionId, userPrompt: "", systemPrompt: "" });
      if (i.agent.name === "lead") sendMail(i.project, "lead", "lead", "shipped", "done");
      else sendMail(i.project, MEMBER, "lead", "late");
      return OK;
    }, log: () => {}, sleep: async () => {} });
    expect(again.endReason).toBe("done");
    expect(r.seen.slice(1).find((s) => s.model === "haiku" || s.model === "opus")).toMatchObject({ model: "haiku", sessionId: "S-low" });
  });

  it("T-17b: timeouts on every candidate stop the run; the resume's first call is still the low model (no cooldown)", async () => {
    const r = await go({ chain: [{ runtime: "claude-code", model: "backup" }], mails: ["low"], member: () => fail("timeout") });
    expect(r.s.endReason).toBe("agent_failed");
    expect(Object.keys(loadRunState(r.runDir).cooldowns ?? {})).toEqual([]);
    const first: (string | undefined)[] = [];
    await runTeam({ project: r.project, resume: loadRunState(r.runDir), runDir: r.runDir, invoker: async (i) => {
      first.push(i.agent.model);
      return fail("auth");
    }, log: () => {}, sleep: async () => {} });
    expect(first[0]).toBe("haiku");
  });
});

describe("lead prompt (T-12)", () => {
  const lead = (project: ResolvedProject) => buildSystemPrompt(project, project.agents[project.lead]!);

  it("has no tier section without a ladder", () => {
    const { project } = setup({ tiers: null });
    expect(lead(project)).not.toContain("## Task tiers");
  });

  it("ends with the tier section, after Parallel tasks, members sorted and only those with 2+ tiers", () => {
    const { project } = setup();
    project.agents["qa-member"]!.tiers = ["a", "b"];
    project.agents["qa-member"]!.model = "b";
    const withRun = { ...project, run: { id: "r", dir: "d", layout: "run" as const, instances: { max: 3 } } };
    const text = lead(withRun);
    const expectTail = TIER_SECTION([
      { name: MEMBER, low: "haiku", mid: "sonnet", high: "opus" },
      { name: "qa-member", low: "a", mid: "b", high: "b" },
    ]);
    expect(text.endsWith(expectTail)).toBe(true);
    expect(text.indexOf(PARALLEL_SECTION(3))).toBeGreaterThan(-1);
    expect(text.indexOf("## Parallel tasks")).toBeLessThan(text.indexOf("## Task tiers"));
    expect(expectTail).toContain("- fe-member: low haiku, mid sonnet, high opus\n- qa-member: low a, mid b, high b");
    expect(expectTail).not.toMatch(/\n$/);
    expect(expectTail).not.toMatch(/automatic|retried on/i);
  });

  it("is not in a member's prompt", () => {
    const { project } = setup();
    expect(buildSystemPrompt(project, project.agents[MEMBER]!)).not.toContain("## Task tiers");
  });
});
