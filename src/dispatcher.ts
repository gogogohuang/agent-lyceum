import fs from "node:fs";
import path from "node:path";
import { realInvoker, type Invoker, type WakeResult } from "./adapters/index.js";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { briefOf, doneContract, parseSteps, type DoneContract } from "./format.js";
import { ProtectedGuard } from "./guard.js";
import { deliver, deliverOnce, ensureProjectDirs, finishDone, listUnread, rejectDone, routeOutboxes, unreadFiles } from "./mailbox.js";
import { abandonClaim, attemptLogDir, sourceIdOf, beginAttempt, claimMessages, commitClaim, finishAttempt, markOutputReady, parkOutbox, recoverRunMail, RouteJournal, type AttemptRecord, type ClaimRecord } from "./message-store.js";
import { isInside } from "./paths.js";
import { createRunLog } from "./run-log.js";
import { outboxDir, ownsDirs } from "./policy.js";
import { buildSystemPrompt, buildUserPrompt, pickMessages } from "./prompt.js";
import { atomicWrite } from "./fs-util.js";
import type { RunOutcome } from "./schema.js";
import { assertWorktreeRunnable, collectAgentChanges, existingAgentWorkspace, integrateAgentChanges, prepareAgentWorkspace, resolveWorkspaceMode, snapshotBase, type AgentWorkspace } from "./worktree.js";
import { bindRunProject, newRunId, newRunState, saveRunState, type EndReason, type RunState, type SentTopic } from "./run-store.js";
import { taskMessageBody, type PreparedTask } from "./task.js";
import { must } from "./assert.js";

export { newRunId };
export type { ActiveWake, EndReason, RunState, SentTopic, WakeRecord, WakeTopic } from "./run-store.js";

export const RESULT_FILE = "result.md";
/** How many times a non-conforming `done` goes back to the lead before it is accepted as `partial`. */
export const MAX_DONE_REJECTIONS = 2;

/** Prompt for a repeat attempt: the earlier one failed and may have changed things already. */
function retryPrompt(prompt: string, error?: string): string {
  return `${prompt}\n\n# Retry notice\nYour previous attempt at this wake-up failed${error ? ` (${error})` : ""} after possibly changing files already. Its mail was discarded. Check the current state of the repository before redoing the work, and send the mail again.`;
}

export interface RunSummary {
  runId: string;
  runDir: string;
  rounds: number;
  endReason: EndReason;
  /** How the work turned out; only "completed" means success. */
  outcome: RunOutcome;
  outcomeNote?: string;
  verification?: string;
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
  /** Stop the run when this fires: running agents are killed, unread mail is kept, the run ends `cancelled` and can be resumed. */
  signal?: AbortSignal;
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
  // Parallel agents work in their own git worktrees; refuse early (before anything is written) when that cannot be done.
  const wsMode = resolveWorkspaceMode(cfg);
  if (wsMode === "worktree") assertWorktreeRunnable(project, { fresh: !resume });
  ensureProjectDirs(project);
  fs.mkdirSync(runDir, { recursive: true });
  const log = createRunLog(path.join(runDir, "log.jsonl"), cfg.log_max_bytes);

  let state: RunState;
  if (resume) {
    state = { ...resume, max_rounds: cfg.max_rounds, pid: process.pid, ended_at: undefined, end_reason: undefined, workspace_mode: wsMode, outcome: undefined, outcome_note: undefined, verification: undefined, active: {}, wakes: [...resume.wakes] };
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
      workspace_mode: wsMode,
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
  /** The lead's done file; it leaves the outbox only after the result and end state are stored. */
  let pendingDoneFile: string | undefined;
  let doneOutcome: RunOutcome | undefined;
  let doneNote: string | undefined;
  let doneVerification: string | undefined;
  /** Inbox mail each agent in the current batch is working on; it is marked read only after its output is routed. */
  const claims = new Map<string, ClaimRecord>();
  const journal = () => new RouteJournal(runDir);
  const noSessionNoted = new Set<string>();
  /** Git worktrees of the non-lead agents in the batch being woken (empty in shared mode and for the lead). */
  let batchSpaces: Record<string, AgentWorkspace> = {};
  /** The attempt that produced each batch member's output; committed together with its claim. */
  const attempts = new Map<string, AttemptRecord>();
  const note = (text: string) => {
    (state.notes ??= []).push(text);
    log("note", { text });
    say(`  ${text}`);
  };

  const pendingAgents = (): ResolvedAgent[] => {
    const rows = Object.values(project.agents)
      .map((a) => ({ a, files: unreadFiles(project, a.name) }))
      .flatMap((r) => (r.files[0] ? [{ a: r.a, first: path.basename(r.files[0]) }] : []));
    rows.sort((x, y) => x.first.localeCompare(y.first));
    return rows.map((r) => r.a);
  };

  const pickBatch = (pending: ResolvedAgent[]): ResolvedAgent[] => {
    const lead = pending.find((a) => a.name === project.lead);
    if (lead || cfg.max_parallel <= 1) return [must(lead ?? pending[0], "an agent to wake")];
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

  const wake = async (agent: ResolvedAgent): Promise<{ ok: boolean; cancelled?: boolean }> => {
    const queue = listUnread(project, agent.name);
    if (queue.length === 0) return { ok: true };
    // Oldest message per wake-up (the lead takes a run of replies at once); the rest stay unread for later wake-ups.
    const unread = pickMessages(project, agent, queue);
    const claim = claimMessages(runDir, agent.name, unread);
    claims.set(agent.name, claim);
    const workDir = path.join(runDir, "agents", agent.name);
    const aproject = Object.keys(batchSpaces).length ? { ...project, workspaces: batchSpaces } : project;
    const base = {
      project: aproject,
      agent,
      workDir,
      workspace: batchSpaces[agent.name],
      systemPrompt: buildSystemPrompt(aproject, agent),
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
      const att = beginAttempt(runDir, claim.id);
      say(`[round ${state.rounds}/${cfg.max_rounds}] waking ${agent.name} (${agent.runtime})${attempt ? ` — retry ${attempt}` : ""}`);
      const sessionId = agent.resume ? state.sessions[agent.name] : undefined;
      const handling = unread.map((m) => ({ from: m.meta.from, type: m.meta.type, subject: m.meta.subject, brief: briefOf(m.body) }));
      state.active[agent.name] = { round, since: new Date(started).toISOString(), handling };
      saveState();
      result = await invoke({ ...base, signal: opts.signal, logDir: attemptLogDir(runDir, att.id), userPrompt: attempt ? retryPrompt(base.userPrompt, result?.error) : base.userPrompt, sessionId }).catch((e: Error) => ({
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
      if (result.ok) {
        attempts.set(agent.name, finishAttempt(runDir, att.id, "output_ready"));
        if (agent.resume && !result.sessionId && !state.sessions[agent.name] && !noSessionNoted.has(agent.name)) {
          noSessionNoted.add(agent.name);
          note(`${agent.name} has resume: true but its ${agent.runtime} CLI reported no session id, so every wake-up starts a fresh session.`);
        }
        break;
      }
      if (result.cancelled) {
        // Stopped on purpose: not a failure to report. Its output is set aside and its input stays unread for the resume.
        const parked = parkOutbox(runDir, outboxDir(project, agent.name), att.id);
        finishAttempt(runDir, att.id, "failed", { error: "cancelled", parked });
        abandonClaim(runDir, claim.id);
        claims.delete(agent.name);
        say(`  ${agent.name} stopped (cancelled)`);
        return { ok: false, cancelled: true };
      }
      // A failed attempt's output is never trusted: park it under the attempt, away from the next attempt's result.
      const parked = parkOutbox(runDir, outboxDir(project, agent.name), att.id);
      finishAttempt(runDir, att.id, "failed", { error: result.error, parked });
      say(`  ${agent.name} failed: ${result.error ?? "unknown error"}`);
      note(
        `${agent.name} attempt ${att.n} failed (${result.error ?? "unknown error"})${parked.length ? `; ${parked.length} output file(s) set aside in ${path.join("mail", "attempts", att.id, "outbox")}` : ""}. ` +
          `Anything it already did outside its mailbox (file edits, commands) was not undone: side effects may have happened.`,
      );
    }
    if (result?.ok) markOutputReady(runDir, claim.id);
    if (!result?.ok) {
      if (agent.name === project.lead) return { ok: false };
      deliverOnce(project, journal(), `wakefail:${claim.id}`, {
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

  /**
   * A finished member's files go from its worktree into the repo before anyone reads its mail, so the lead
   * sees them. When that cannot be done, nothing is applied, the member's work stays on its branch, and the lead is told.
   */
  const integrateMember = (agent: ResolvedAgent, ws: AgentWorkspace, key: string): void => {
    const changes = collectAgentChanges(ws, agent.owns);
    const r = integrateAgentChanges(project, changes);
    log("integrate", { agent: agent.name, status: r.status, files: changes.files.map((f) => `${f.status} ${f.path}`), ...(r.status === "blocked" ? { reason: r.reason, report: r.report } : {}) });
    const blocked = (state.blocked_integrations ?? []).filter((b) => b.agent !== agent.name);
    if (r.status === "integrated") {
      state.blocked_integrations = blocked;
      if (r.files.length) say(`  ${agent.name}: ${r.files.length} changed file(s) brought into the repo`);
      return;
    }
    state.blocked_integrations = [...blocked, { agent: agent.name, branch: r.branch, reason: r.reason, report: r.report }];
    say(`  ${agent.name}: changes NOT brought into the repo (${r.reason.split("\n")[0]})`);
    deliverOnce(project, journal(), `integration:${key}`, {
      from: "dispatcher",
      to: project.lead,
      type: "failure",
      subject: `${agent.name}'s changes could not be brought into the repo`,
      body:
        `${agent.name} finished, but its changes could not be brought into the repo, and nothing was applied.\n\n${r.reason}\n\n` +
        `Its work is kept: branch \`${r.branch}\`, worktree \`${r.workspace}\`, report \`${r.report}\`, patch \`${r.patch}\`.\n` +
        `You can send ${agent.name} a task to redo or adjust it (it continues in the same worktree and the integration is retried after its next wake-up), or apply the patch yourself. ` +
        `Do not report the job \`completed\` while this work is missing from the repo.`,
    });
    saveState();
  };

  /** After a batch (or, on resume, before the first one): revert guarded edits, route mail, detect done / lead failure. */
  const settle = (batch: ResolvedAgent[], results: { ok: boolean; cancelled?: boolean }[]): void => {
    const violations = guard.check(batch);
    for (const v of violations) {
      say(`  protected file ${v.action}: ${v.file} (suspects: ${v.suspects.join(", ")})`);
      log("violation", { ...v });
      deliver(project, {
        from: "dispatcher",
        to: project.lead,
        type: "failure",
        subject: `Protected file ${v.action}`,
        body:
          `\`${v.file}\` was changed without permission and has been ${v.action}. Agents active at the time: ${v.suspects.join(", ")}.` +
          (v.saved ? `\n\nWhat was written is kept at \`${v.saved}\` (sha256 ${v.sha256}${v.truncated ? ", truncated to 1 MiB" : ""}). If it is worth keeping, have an agent that may edit this file redo it.` : ""),
      });
    }

    batch.forEach((a, i) => {
      const ws = batchSpaces[a.name];
      if (ws && results[i]?.ok) integrateMember(a, ws, claims.get(a.name)?.id ?? `${a.name}-${state.rounds}`);
    });
    const route = routeOutboxes(project);
    // A done that breaks the completion contract goes back to the lead (a limited number of times).
    let contract: DoneContract | undefined;
    if (route.done) {
      contract = doneContract(route.done.meta, route.done.body, state.steps);
      if (contract.missing.length && (state.done_rejections ?? 0) < MAX_DONE_REJECTIONS) {
        state.done_rejections = (state.done_rejections ?? 0) + 1;
        const list = contract.missing.map((m) => `- ${m}`).join("\n");
        deliverOnce(project, journal(), `done-reject:${sourceIdOf(route.done.from, route.done.file)}`, {
          from: "dispatcher",
          to: project.lead,
          type: "failure",
          subject: "Your done report was not accepted",
          body: `The run was not ended: your \`done\` report does not meet the completion contract. Missing:\n${list}\n\nSend \`type: done\` again with the frontmatter line \`outcome: completed|partial|blocked|failed\` and the headings \`## Result\`, \`## Files\`, \`## Verification\`, \`## Not done\`. \`completed\` needs all four and every step ticked; if work remains, report \`partial\` or \`blocked\` (those need only \`## Result\` and \`## Not done\`) or \`failed\`, or send the task that continues the work. (Reminder ${state.done_rejections} of ${MAX_DONE_REJECTIONS}.)`,
        });
        rejectDone(route.done.file);
        say(`  done report sent back to ${project.lead}: missing ${contract.missing.join("; ")}`);
        log("done-rejected", { missing: contract.missing, count: state.done_rejections });
        route.done = undefined;
        contract = undefined;
      }
    }
    for (const d of route.delivered) log("route", d);
    const handedOff = (from: string, t: SentTopic) => {
      const w = [...state.wakes].reverse().find((x) => x.agent === from);
      if (w) (w.sent ??= []).push(t);
    };
    for (const d of route.delivered) handedOff(d.from, { to: d.to, type: d.type, subject: d.subject });
    if (route.done) handedOff(route.done.from, { to: "(done)", type: "done", subject: route.done.subject });
    if (route.steps) state.steps = route.steps;
    saveState();
    // Output is routed: only now is the input these wake-ups handled consumed.
    for (const a of batch) {
      const c = claims.get(a.name);
      if (!c) continue;
      commitClaim(runDir, c.id);
      claims.delete(a.name);
      const att = attempts.get(a.name);
      if (att) finishAttempt(runDir, att.id, "committed");
      attempts.delete(a.name);
    }
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
      const ok = !contract || contract.missing.length === 0;
      doneOutcome = ok ? contract!.outcome! : "partial";
      doneVerification = contract?.verification;
      doneNote = ok ? undefined : `Completion contract not met after ${state.done_rejections ?? 0} reminder(s): missing ${contract!.missing.join("; ")}. Reported as partial; the lead's report is kept as written.`;
      const unintegrated = state.blocked_integrations ?? [];
      if (doneOutcome === "completed" && unintegrated.length) {
        doneOutcome = "blocked";
        doneNote = `Not completed: work of ${unintegrated.map((b) => `${b.agent} (branch ${b.branch})`).join(", ")} was never brought into the repo; see ${unintegrated.map((b) => b.report).join(", ")}.`;
      }
      atomicWrite(
        path.join(runDir, RESULT_FILE),
        `# ${route.done.subject}\n\n**Outcome:** ${doneOutcome}${doneNote ? ` (${doneNote})` : ""}\n\n${route.done.body.trimEnd()}\n`,
      );
      pendingDoneFile = route.done.file;
      log("done", { subject: route.done.subject });
      endReason = "done";
      return;
    }
    const leadIdx = batch.findIndex((a) => a.name === project.lead);
    const leadResult = leadIdx >= 0 ? results[leadIdx] : undefined;
    if (leadResult && !leadResult.ok && !leadResult.cancelled) {
      endReason = "lead_failed";
      return;
    }
  };

  if (resume) {
    const rec = recoverRunMail(runDir, { outboxOf: (agent) => outboxDir(project, agent) });
    for (const i of rec.interrupted) {
      note(
        `${i.attempt.agent} attempt ${i.attempt.n} was interrupted${i.parked.length ? `; ${i.parked.length} output file(s) set aside in ${path.join("mail", "attempts", i.attempt.id, "outbox")}` : ""}. ` +
          `Anything it already did outside its mailbox (file edits, commands) may have happened and can happen again when the message is redone: side effects may have happened.`,
      );
    }
    if (rec.abandoned.length || rec.finalized.length || rec.ready.length) {
      log("recover", { abandoned: rec.abandoned.map((c) => c.id), finalized: rec.finalized, ready: rec.ready.map((c) => c.id) });
    }
    // A member whose wake-up finished before the crash: bring its files in (repeating is harmless) before its mail is routed.
    if (wsMode === "worktree") {
      for (const c of rec.ready) {
        const agent = project.agents[c.agent];
        const ws = agent && agent.name !== project.lead ? existingAgentWorkspace(project, runId, agent.name) : undefined;
        if (agent && ws) integrateMember(agent, ws, c.id);
      }
    }
    for (const c of rec.abandoned) say(`  ${c.agent}'s unfinished wake-up is redone: its ${c.message_ids.length} message(s) stay unread`);
    settle([], []);
    // Wake-ups that had finished before the crash: their output is routed now, so their input is consumed.
    for (const c of rec.ready) commitClaim(runDir, c.id);
  }

  // When the lead was the last one woken and left every mailbox empty without a `done`, remind it once instead of ending silently.
  let leadWasLast = false;
  let nudged = false;
  while (!endReason) {
    if (opts.signal?.aborted) {
      endReason = "cancelled";
      break;
    }
    let pending = pendingAgents();
    if (pending.length === 0 && leadWasLast && !nudged) {
      nudged = true;
      say("  lead left no mail and no done: reminding it to send one");
      log("nudge", { to: project.lead });
      deliverOnce(project, journal(), `nudge:${state.rounds}`, {
        from: "dispatcher",
        to: project.lead,
        type: "failure",
        subject: "No done message sent",
        body: `All mailboxes are empty and you have not sent a \`done\` message, so the run would end without a final report. If the job is finished and verified, send \`type: done\` now (with \`outcome: completed|partial|blocked|failed\` in the frontmatter and \`## Result\`, \`## Files\`, \`## Verification\`, \`## Not done\`${state.steps ? " and the full `## Steps` checklist" : ""}). If work remains, send the \`task\` that continues it. Writing a summary in your reply text does not count: only mail is delivered.`,
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
    batchSpaces = {};
    const members = batch.filter((a) => a.name !== project.lead);
    if (wsMode === "worktree" && members.length) {
      state.snapshots = (state.snapshots ?? 0) + 1;
      saveState();
      const ref = snapshotBase(project, runId, state.snapshots);
      for (const a of members) batchSpaces[a.name] = prepareAgentWorkspace(project, runId, a.name, ref);
      log("workspaces", { snapshot: ref, agents: Object.fromEntries(Object.entries(batchSpaces).map(([n, w]) => [n, w.dir])) });
    }
    const results = await Promise.all(batch.map((a) => wake(a)));
    leadWasLast = batch.some((a) => a.name === project.lead);
    if (batch.some((a) => a.name !== project.lead)) nudged = false;
    settle(batch, results);
    if (!endReason && opts.signal?.aborted) endReason = "cancelled";
  }

  const outcome: RunOutcome = endReason === "done" ? doneOutcome ?? "partial" : endReason === "lead_failed" ? "failed" : endReason === "cancelled" ? "cancelled" : "partial";
  const outcomeNote =
    endReason === "done"
      ? doneNote
      : endReason === "idle"
        ? "All mailboxes were empty but the lead never sent a done message."
        : endReason === "max_rounds"
          ? "Stopped at the round limit before the lead sent done."
          : endReason === "cancelled"
            ? "Cancelled before the lead finished. Unread mail was kept; continue with `agent-lyceum resume`."
            : "The lead's wake-up failed.";
  state.end_reason = endReason;
  state.outcome = outcome;
  state.outcome_note = outcomeNote;
  state.verification = doneVerification;
  state.ended_at = new Date().toISOString();
  log("end", { reason: endReason, outcome, rounds: state.rounds });
  saveState();
  if (pendingDoneFile) finishDone(pendingDoneFile);
  return { runId, runDir, rounds: state.rounds, endReason, outcome, outcomeNote, verification: doneVerification, doneMessage };
}
