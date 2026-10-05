import fs from "node:fs";
import path from "node:path";
import { realInvoker, type Invoker, type WakeResult } from "./adapters/index.js";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { ProtectedGuard } from "./guard.js";
import { atomicWrite, deliver, ensureProjectDirs, listUnread, markRead, routeOutboxes } from "./mailbox.js";
import { isInside } from "./paths.js";
import { ownsDirs } from "./policy.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { taskMessageBody, type PreparedTask } from "./task.js";

export type EndReason = "done" | "idle" | "max_rounds" | "lead_failed";

export interface RunState {
  run_id: string;
  project: string;
  task_source: "text" | "file";
  task_path?: string;
  started_at: string;
  ended_at?: string;
  rounds: number;
  max_rounds: number;
  end_reason?: EndReason;
  sessions: Record<string, string>;
  cost_usd: number;
  last_wake: Record<string, { at: string; ok: boolean; error?: string }>;
}

export interface RunSummary {
  runId: string;
  runDir: string;
  rounds: number;
  endReason: EndReason;
  doneMessage?: { subject: string; body: string };
}

export interface RunOptions {
  project: ResolvedProject;
  task: PreparedTask;
  runDir: string;
  invoker?: Invoker;
  log?: (line: string) => void;
}

export function newRunId(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export async function runTeam(opts: RunOptions): Promise<RunSummary> {
  const { project, task, runDir } = opts;
  const invoke = opts.invoker ?? realInvoker;
  const say = opts.log ?? ((s: string) => console.log(s));
  const cfg = project.dispatcher;
  const runId = path.basename(runDir);

  ensureProjectDirs(project);
  fs.mkdirSync(runDir, { recursive: true });
  const logFile = path.join(runDir, "log.jsonl");
  const log = (event: string, data: Record<string, unknown> = {}) =>
    fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n");

  const state: RunState = {
    run_id: runId,
    project: project.name,
    task_source: task.source,
    task_path: task.sourcePath,
    started_at: new Date().toISOString(),
    rounds: 0,
    max_rounds: cfg.max_rounds,
    sessions: {},
    cost_usd: 0,
    last_wake: {},
  };
  const saveState = () => atomicWrite(path.join(runDir, "state.json"), JSON.stringify(state, null, 2));

  const guard = new ProtectedGuard(project);
  guard.saveSnapshot(path.join(runDir, "snapshots"));

  const t = taskMessageBody(task);
  deliver(project, { from: "user", to: project.lead, type: "task", subject: t.subject, body: t.body });
  log("start", { task_source: task.source, bytes: task.bytes, inline: task.inline });
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
    const unread = listUnread(project, agent.name);
    if (unread.length === 0) return { ok: true };
    const workDir = path.join(runDir, "agents", agent.name);
    const base = {
      project,
      agent,
      workDir,
      systemPrompt: buildSystemPrompt(project, agent),
      userPrompt: buildUserPrompt(project, agent, unread),
      timeoutSec: cfg.wake_timeout_sec,
    };
    let result: WakeResult | undefined;
    for (let attempt = 0; attempt <= cfg.retry; attempt++) {
      if (state.rounds >= cfg.max_rounds) {
        result = { ok: false, text: "", exitCode: null, timedOut: false, error: "round limit reached" };
        break;
      }
      state.rounds++;
      const started = Date.now();
      say(`[round ${state.rounds}/${cfg.max_rounds}] waking ${agent.name} (${agent.runtime})${attempt ? ` — retry ${attempt}` : ""}`);
      const sessionId = agent.resume ? state.sessions[agent.name] : undefined;
      result = await invoke({ ...base, sessionId }).catch((e: Error) => ({
        ok: false,
        text: "",
        exitCode: null,
        timedOut: false,
        error: e.message,
      }));
      if (result.sessionId && agent.resume) state.sessions[agent.name] = result.sessionId;
      if (result.costUsd) state.cost_usd += result.costUsd;
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

  while (!endReason) {
    const pending = pendingAgents();
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
      log("done", { subject: route.done.subject });
      endReason = "done";
      break;
    }
    const leadIdx = batch.findIndex((a) => a.name === project.lead);
    if (leadIdx >= 0 && !results[leadIdx].ok) {
      endReason = "lead_failed";
      break;
    }
  }

  state.end_reason = endReason;
  state.ended_at = new Date().toISOString();
  log("end", { reason: endReason, rounds: state.rounds });
  saveState();
  return { runId, runDir, rounds: state.rounds, endReason, doneMessage };
}
