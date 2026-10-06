import fs from "node:fs";
import path from "node:path";
import { realInvoker, type Invoker, type WakeResult } from "./adapters/index.js";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { briefOf, parseSteps } from "./format.js";
import { ProtectedGuard } from "./guard.js";
import { deliver, ensureProjectDirs, listUnread, markRead, routeOutboxes } from "./mailbox.js";
import { isInside } from "./paths.js";
import { ownsDirs } from "./policy.js";
import { buildSystemPrompt, buildUserPrompt, pickMessages } from "./prompt.js";
import { bindRunProject, newRunId, newRunState, saveRunState, type EndReason, type RunState, type SentTopic } from "./run-store.js";
import { taskMessageBody, type PreparedTask } from "./task.js";

export { newRunId };
export type { ActiveWake, EndReason, RunState, SentTopic, WakeRecord, WakeTopic } from "./run-store.js";

export const RESULT_FILE = "result.md";

export interface RunSummary {
  runId: string;
  runDir: string;
  rounds: number;
  endReason: EndReason;
  doneMessage?: { subject: string; body: string };
}

export interface RunOptions {
  project: ResolvedProject;
  /** The task for a new run; omit when resuming. */
  task?: PreparedTask;
  /** Continue this earlier run (same run dir, sessions and counters) instead of starting a new one. */
  resume?: RunState;
  runDir: string;
  invoker?: Invoker;
  log?: (line: string) => void;
}

export async function runTeam(opts: RunOptions): Promise<RunSummary> {
  const { task, resume, runDir } = opts;
  if (!task && !resume) throw new Error("runTeam needs a task or a run to resume");
  const invoke = opts.invoker ?? realInvoker;
  const say = opts.log ?? ((s: string) => console.log(s));
  const cfg = opts.project.dispatcher;
  const runId = path.basename(runDir);
  const layout = resume ? resume.mail_layout : "run";
  // Each run gets its own memory directory per agent and (new runs) its own mailboxes.
  const project = bindRunProject(opts.project, runDir, layout);
  ensureProjectDirs(project);
  fs.mkdirSync(runDir, { recursive: true });
  const logFile = path.join(runDir, "log.jsonl");
  const log = (event: string, data: Record<string, unknown> = {}) =>
    fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n");

  let state: RunState;
  if (resume) {
    state = { ...resume, max_rounds: cfg.max_rounds, pid: process.pid, ended_at: undefined, end_reason: undefined, active: {}, wakes: [...resume.wakes] };
    // A wake that was running when the process died never finished; keep it in the history as interrupted.
    for (const [agent, a] of Object.entries(resume.active ?? {})) {
      state.wakes.push({
        round: a.round,
        agent,
        at: new Date().toISOString(),
        duration_ms: Date.now() - Date.parse(a.since),
        ok: false,
        handling: a.handling,
        error: "interrupted",
      });
    }
  } else {
    const t = taskMessageBody(task!);
    state = newRunState({
      run_id: runId,
      project: project.name,
      task_source: task!.source,
      task_path: task!.sourcePath,
      started_at: new Date().toISOString(),
      rounds: 0,
      max_rounds: cfg.max_rounds,
      pid: process.pid,
      task_summary: t.subject,
      mail_layout: layout,
    });
    const seed = parseSteps(task!.content, false);
    if (seed.length) state.steps = seed;
  }
  const saveState = () => saveRunState(runDir, state);

  const guard = new ProtectedGuard(project);
  if (resume) {
    log("resume", { rounds: state.rounds, interrupted: Object.keys(resume.active ?? {}) });
  } else {
    const t = taskMessageBody(task!);
    guard.saveSnapshot(path.join(runDir, "snapshots"));
    deliver(project, { from: "user", to: project.lead, type: "task", subject: t.subject, body: t.body });
    log("start", { task_source: task!.source, bytes: task!.bytes, inline: task!.inline });
  }
  saveState();

  let endReason: EndReason | undefined;
  let doneMessage: RunSummary["doneMessage"];

  const pendingAgents = (): ResolvedAgent[] => {
    const rows = Object.values(project.agents)
      .map((a) => ({ a, unread: listUnread(project, a.name) }))
      .filter((r) => r.unread.length > 0)
      .map((r) => ({ a: r.a, first: path.basename(r.unread[0].file) }));
    rows.sort((x, y) => x.first.localeCompare(y.first));
    return rows.map((r) => r.a);
  };

  const pickBatch = (pending: ResolvedAgent[]): ResolvedAgent[] => {
    const lead = pending.find((a) => a.name === project.lead);
    if (lead || cfg.max_parallel <= 1) return [lead ?? pending[0]];
    const batch: ResolvedAgent[] = [];
    const taken: string[] = [];
    for (const a of pending) {
      if (batch.length >= cfg.max_parallel) break;
      const mine = ownsDirs(project, a);
      const clash = mine.some((x) => taken.some((y) => isInside(x, y) || isInside(y, x)));
      if (clash || mine.length === 0) {
        if (batch.length === 0) batch.push(a);
        continue;
      }
      batch.push(a);
      taken.push(...mine);
    }
    return batch;
  };

  const wake = async (agent: ResolvedAgent): Promise<{ ok: boolean }> => {
    const queue = listUnread(project, agent.name);
    if (queue.length === 0) return { ok: true };
    // Oldest message per wake-up (the lead takes a run of replies at once); the rest stay unread for later wake-ups.
    const unread = pickMessages(project, agent, queue);
    const workDir = path.join(runDir, "agents", agent.name);
    const base = {
      project,
      agent,
      workDir,
      systemPrompt: buildSystemPrompt(project, agent),
      userPrompt: buildUserPrompt(project, agent, queue, unread.length),
      timeoutSec: cfg.wake_timeout_sec,
    };
    let result: WakeResult | undefined;
    for (let attempt = 0; attempt <= cfg.retry; attempt++) {
      if (state.rounds >= cfg.max_rounds) {
        result = { ok: false, text: "", exitCode: null, timedOut: false, error: "round limit reached" };
        break;
      }
      const round = ++state.rounds;
      const started = Date.now();
      say(`[round ${state.rounds}/${cfg.max_rounds}] waking ${agent.name} (${agent.runtime})${attempt ? ` — retry ${attempt}` : ""}`);
      const sessionId = agent.resume ? state.sessions[agent.name] : undefined;
      const handling = unread.map((m) => ({ from: m.meta.from, type: m.meta.type, subject: m.meta.subject, brief: briefOf(m.body) }));
      state.active[agent.name] = { round, since: new Date(started).toISOString(), handling };
      saveState();
      result = await invoke({ ...base, sessionId }).catch((e: Error) => ({
        ok: false,
        text: "",
        exitCode: null,
        timedOut: false,
        error: e.message,
      }));
      if (result.sessionId && agent.resume) state.sessions[agent.name] = result.sessionId;
      if (result.outputTokens) state.output_tokens += result.outputTokens;
      delete state.active[agent.name];
      state.wakes.push({
        round,
        agent: agent.name,
        at: new Date().toISOString(),
        duration_ms: Date.now() - started,
        ok: result.ok,
        output_tokens: result.outputTokens,
        handling,
        error: result.error,
      });
      state.last_wake[agent.name] = { at: new Date().toISOString(), ok: result.ok, error: result.error };
      log("wake", {
        agent: agent.name,
        runtime: agent.runtime,
        attempt,
        ok: result.ok,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        duration_ms: Date.now() - started,
        messages: unread.map((m) => m.meta.id),
        error: result.error,
      });
      saveState();
      if (result.ok) break;
      say(`  ${agent.name} failed: ${result.error ?? "unknown error"}`);
    }
    markRead(unread.map((m) => m.file));
    if (!result?.ok) {
      if (agent.name === project.lead) return { ok: false };
      deliver(project, {
        from: "dispatcher",
        to: project.lead,
        type: "failure",
        subject: `${agent.name} failed`,
        body: `Agent "${agent.name}" could not handle message(s) "${unread.map((m) => m.meta.subject).join('", "')}".\n\nError: ${result?.error ?? "unknown"}\n\nDecide whether to retry, reassign, or adjust the plan.`,
      });
      return { ok: false };
    }
    return { ok: true };
  };

  /** After a batch (or, on resume, before the first one): revert guarded edits, route mail, detect done / lead failure. */
  const settle = (batch: ResolvedAgent[], results: { ok: boolean }[]): void => {
    const violations = guard.check(batch);
    for (const v of violations) {
      say(`  protected file ${v.action}: ${v.file} (suspects: ${v.suspects.join(", ")})`);
      log("violation", { ...v });
      deliver(project, {
        from: "dispatcher",
        to: project.lead,
        type: "failure",
        subject: `Protected file ${v.action}`,
        body: `\`${v.file}\` was changed without permission and has been ${v.action}. Agents active at the time: ${v.suspects.join(", ")}.`,
      });
    }

    const route = routeOutboxes(project);
    for (const d of route.delivered) log("route", d);
    const handedOff = (from: string, t: SentTopic) => {
      const w = [...state.wakes].reverse().find((x) => x.agent === from);
      if (w) (w.sent ??= []).push(t);
    };
    for (const d of route.delivered) handedOff(d.from, { to: d.to, type: d.type, subject: d.subject });
    if (route.done) handedOff(route.done.from, { to: "(done)", type: "done", subject: route.done.subject });
    if (route.steps) state.steps = route.steps;
    saveState();
    for (const w of route.warnings) {
      say(`  format warning: mail ${w.id} from ${w.from} lacks ${w.missing.join(", ")}`);
      log("format-warning", w);
    }
    for (const r of route.rejected) {
      say(`  rejected mail from ${r.from}: ${r.reason}`);
      log("rejected", r);
    }
    if (route.done) {
      doneMessage = { subject: route.done.subject, body: route.done.body };
      fs.writeFileSync(path.join(runDir, RESULT_FILE), `# ${route.done.subject}\n\n${route.done.body.trimEnd()}\n`);
      log("done", { subject: route.done.subject });
      endReason = "done";
      return;
    }
    const leadIdx = batch.findIndex((a) => a.name === project.lead);
    if (leadIdx >= 0 && !results[leadIdx].ok) {
      endReason = "lead_failed";
      return;
    }
  };

  if (resume) settle([], []);

  // When the lead was the last one woken and left every mailbox empty without a `done`, remind it once instead of ending silently.
  let leadWasLast = false;
  let nudged = false;
  while (!endReason) {
    let pending = pendingAgents();
    if (pending.length === 0 && leadWasLast && !nudged) {
      nudged = true;
      say("  lead left no mail and no done: reminding it to send one");
      log("nudge", { to: project.lead });
      deliver(project, {
        from: "dispatcher",
        to: project.lead,
        type: "failure",
        subject: "No done message sent",
        body: `All mailboxes are empty and you have not sent a \`done\` message, so the run would end without a final report. If the job is finished and verified, send \`type: done\` now (with \`## Result\`, \`## Files\`, \`## Not done\`${state.steps ? " and the full `## Steps` checklist" : ""}). If work remains, send the \`task\` that continues it. Writing a summary in your reply text does not count: only mail is delivered.`,
      });
      pending = pendingAgents();
    }
    if (pending.length === 0) {
      endReason = "idle";
      break;
    }
    if (state.rounds >= cfg.max_rounds) {
      endReason = "max_rounds";
      break;
    }
    const batch = pickBatch(pending);
    const results = await Promise.all(batch.map((a) => wake(a)));
    leadWasLast = batch.some((a) => a.name === project.lead);
    if (batch.some((a) => a.name !== project.lead)) nudged = false;
    settle(batch, results);
  }

  state.end_reason = endReason;
  state.ended_at = new Date().toISOString();
  log("end", { reason: endReason, rounds: state.rounds });
  saveState();
  return { runId, runDir, rounds: state.rounds, endReason, doneMessage };
}
