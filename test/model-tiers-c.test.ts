import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeResult } from "../src/adapters/index.js";
import { flattenResolved, resolveProjectWithSources } from "../src/config.js";
import { runTeam } from "../src/dispatcher.js";
import { deliver, PENDING_DIR, routeOutboxes, type InstanceRouting } from "../src/mailbox.js";
import { inboxDir, outboxDir } from "../src/policy.js";
import { bindRunProject, loadRunState, newRunState, saveRunState } from "../src/run-store.js";
import { FULL_DONE, makeEnv, type TestEnv, withSections, write } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());
const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const CC = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
const editGlobal = (fn: (t: string) => string) => {
  const f = path.join(env.home, "team.yaml");
  fs.writeFileSync(f, fn(fs.readFileSync(f, "utf8")));
};
const withLadder = (rt = "claude-code") => {
  editGlobal((t) => `model_tiers:\n  ${rt}: [${CC.join(", ")}]\n${t.replaceAll("    runtime: claude-code", "    runtime: claude-code\n    model: claude-opus-5-5")}`);
};
const here = path.dirname(fileURLToPath(import.meta.url));
const cliRun = (args: string[]) => spawnSync(path.join(here, "..", "node_modules", ".bin", "tsx"), [path.join(here, "..", "src", "cli.ts"), "--home", env.home, ...args], { encoding: "utf8" });

describe("doctor --resolved lists the per-agent ladder (spec 24.9)", () => {
  it("team ladder: rows and sources point at the team file's model_tiers.<runtime>", () => {
    env = makeEnv();
    withLadder();
    const r = resolveProjectWithSources(env.home, "demo");
    const team = path.join(env.home, "team.yaml");
    const v = flattenResolved(r.project);
    expect(v["model_tiers.claude-code"]).toEqual(CC);
    expect(v["agents.fe-member.model_tiers"]).toEqual(CC);
    expect(r.sources["agents.fe-member.model_tiers"]).toEqual({ file: team, key: "model_tiers.claude-code" });
    const text = cliRun(["doctor", "--resolved", "-p", "demo"]).stdout;
    expect(text).toMatch(/agents\.fe-member\.model_tiers\s*=\s*\["claude-haiku-5-5","claude-sonnet-5-5","claude-opus-5-5"\]\s+team\.yaml/);
    const j = JSON.parse(cliRun(["doctor", "--resolved", "-p", "demo", "--json"]).stdout);
    expect(j.values["agents.fe-member.model_tiers"]).toEqual(CC);
    expect(j.sources["agents.fe-member.model_tiers"]).toEqual({ file: team, key: "model_tiers.claude-code" });
  });
  it("project ladder overrides: the source is the project file", () => {
    env = makeEnv();
    withLadder();
    env.editProjectYaml((t) => `model_tiers:\n  claude-code: [claude-haiku-5-5, claude-opus-5-5]\n${t}`);
    const r = resolveProjectWithSources(env.home, "demo");
    expect(flattenResolved(r.project)["agents.fe-member.model_tiers"]).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    expect(r.sources["agents.fe-member.model_tiers"]).toEqual({ file: path.join(env.home, "projects/demo/project.yaml"), key: "model_tiers.claude-code" });
  });
  it("no ladder: no per-agent model_tiers key or source", () => {
    env = makeEnv();
    const r = resolveProjectWithSources(env.home, "demo");
    expect(Object.keys(flattenResolved(r.project)).filter((k) => k.includes("model_tiers"))).toEqual([]);
    expect(Object.keys(r.sources).filter((k) => k.includes("model_tiers"))).toEqual([]);
  });
});

function setupRoute(tiers: string[] | null = ["m-low", "m-high"]) {
  env = makeEnv();
  const p = env.project();
  const run = bindRunProject(p, path.join(p.paths.runs, "tiers"), "run");
  if (tiers) run.agents["fe-member"]!.tiers = tiers;
  return run;
}
let n = 0;
const sendTask = (p: ReturnType<typeof setupRoute>, fm: string, body = "implement the whole feature with all of its tests please") =>
  write(path.join(outboxDir(p, "lead"), `m-${++n}.md`), `---\nto: fe-member\ntype: task\nsubject: held probe\n${fm}---\n${withSections("task", body)}`);

describe("held mail (spec 23 pending/) and tier duplicates (T-15 held)", () => {
  const routing: InstanceRouting = { cap: () => 2, held: () => true, enable: () => {}, ignored: () => {} };
  const pending = (p: ReturnType<typeof setupRoute>) => {
    const d = path.join(inboxDir(p, "fe-member"), PENDING_DIR);
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".md")) : [];
  };
  it("a held task resent with another tier is delivered; the same tier is a duplicate", () => {
    const p = setupRoute();
    sendTask(p, "tier: low\n");
    routeOutboxes(p, routing);
    expect(pending(p)).toHaveLength(1);
    sendTask(p, "tier: high\n");
    routeOutboxes(p, routing);
    expect(pending(p)).toHaveLength(2);
    sendTask(p, "tier: low\n");
    const r = routeOutboxes(p, routing);
    expect(pending(p)).toHaveLength(2);
    expect(r.rejected.length + r.warnings.length).toBeGreaterThan(0);
  });
});

const logEvents = (runDir: string, event: string) =>
  fs.readFileSync(path.join(runDir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === event);
const mailOut = (p: Parameters<typeof outboxDir>[0], from: string, to: string, subject: string, type: string, fm = "") =>
  write(path.join(outboxDir(p, from), `${subject.replace(/\W+/g, "-")}-${Math.random().toString(16).slice(2)}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}${fm}---\n\n${type === "done" ? FULL_DONE : withSections(type as "task", `body of ${subject}`)}\n`);

async function e2e(o: { ladder: boolean; leadFm: string; memberFm?: string; leadType?: string; leadMails?: number; memberMails?: number }) {
  env = makeEnv();
  const project = env.project();
  const a = project.agents["fe-member"]!;
  a.model = "opus";
  a.resume = true;
  if (o.ladder) a.tiers = ["haiku", "sonnet", "opus"];
  const runDir = path.join(project.paths.runs, "run-e");
  fs.mkdirSync(runDir, { recursive: true });
  const p = bindRunProject(project, runDir, "run");
  saveRunState(runDir, { ...newRunState({ run_id: "run-e", project: project.name, max_rounds: 20, rounds: 1, pid: 1, task_summary: "t" }), sessions: {} });
  deliver(p, { from: "user", to: "lead", type: "task", subject: "go", body: "start" });
  const seen: { agent: string; model?: string }[] = [];
  let leadWakes = 0;
  const invoker: Invoker = async (i) => {
    seen.push({ agent: i.agent.name, model: i.agent.model });
    if (i.agent.name === "lead") {
      if (++leadWakes === 1) for (let k = 1; k <= (o.leadMails ?? 1); k++) mailOut(i.project, "lead", "fe-member", k === 1 ? "do it" : `do it ${k}`, o.leadType ?? "task", o.leadFm);
      else mailOut(i.project, "lead", "lead", "shipped", "done");
      return OK;
    }
    for (let k = 1; k <= (o.memberMails ?? 1); k++) mailOut(i.project, "fe-member", "lead", k === 1 ? "finished" : `finished ${k}`, "reply", o.memberFm ?? "");
    return { ...OK, sessionId: `S-${i.agent.model}` };
  };
  const s = await runTeam({ project, resume: loadRunState(runDir), runDir, invoker, log: () => {}, sleep: async () => {} });
  return { s, seen, runDir, state: loadRunState(runDir), inbox: p };
}

describe("tier_ignored wiring in the run loop", () => {
  it("e2e: lead task tier low wakes the member on the low model with its own session key", async () => {
    const r = await e2e({ ladder: true, leadFm: "tier: low\n" });
    expect(r.seen.filter((x) => x.agent === "fe-member").map((x) => x.model)).toEqual(["haiku"]);
    expect(Object.keys(r.state.sessions)).toContain("fe-member@claude-code/haiku");
    expect(logEvents(r.runDir, "tier_ignored")).toEqual([]);
  });
  it("e2e: no ladder: the tier is dropped, the ceiling is used and tier_ignored (no-tiers) is logged without a note", async () => {
    const r = await e2e({ ladder: false, leadFm: "tier: low\n" });
    expect(r.seen.filter((x) => x.agent === "fe-member").map((x) => x.model)).toEqual(["opus"]);
    expect(logEvents(r.runDir, "tier_ignored").map((e) => [e.from, e.to, e.reason])).toEqual([["lead", "fe-member", "no-tiers"]]);
    expect((r.state.notes ?? []).filter((t) => t.includes("tier"))).toEqual([]);
  });
  it("a member's reply carrying tier is logged as not-lead and noted once", async () => {
    const r = await e2e({ ladder: true, leadFm: "", memberFm: "tier: low\n" });
    const ev = logEvents(r.runDir, "tier_ignored");
    expect(ev.map((e) => [e.from, e.reason])).toEqual([["fe-member", "not-lead"]]);
    expect(ev[0]).toHaveProperty("id");
    const notes = (r.state.notes ?? []).filter((t) => t.includes("`tier`"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("only the lead (lead) can choose a member's tier: it was delivered without one.");
  });
  it("not-lead: a second mail from the same sender adds no second note", async () => {
    const r = await e2e({ ladder: true, leadFm: "", memberFm: "tier: low\n", memberMails: 2 });
    expect(logEvents(r.runDir, "tier_ignored").map((e) => e.reason)).toEqual(["not-lead", "not-lead"]);
    expect((r.state.notes ?? []).filter((t) => t.includes("`tier`"))).toHaveLength(1);
  });
  it("not-a-task: the note has the exact 24.5.2 text and a second mail from the same sender adds none", async () => {
    const r = await e2e({ ladder: true, leadFm: "tier: low\n", leadType: "reply", leadMails: 2 });
    expect(logEvents(r.runDir, "tier_ignored").map((e) => e.reason)).toEqual(["not-a-task", "not-a-task"]);
    const notes = (r.state.notes ?? []).filter((t) => t.includes("`tier`"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^lead's mail \S+ \("do it"\) has `tier` but is a reply: tiers apply to tasks only, so it was delivered without one\.$/);
  });
  it("the lead's reply carrying tier is logged as not-a-task and noted with the type", async () => {
    // fe-member is told by lead via a reply: not a task, so the tier is dropped
    env = makeEnv();
    const p0 = env.project();
    p0.agents["fe-member"]!.tiers = ["m-low", "m-high"];
    const run = bindRunProject(p0, path.join(p0.paths.runs, "x"), "run");
    run.agents["fe-member"]!.tiers = ["m-low", "m-high"];
    mailOut(run, "lead", "fe-member", "fyi", "reply", "tier: low\n");
    const r = routeOutboxes(run);
    expect(r.tierIgnored.map((t) => [t.reason, t.type])).toEqual([["not-a-task", "reply"]]);
  });
});
