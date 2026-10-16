import fs from "node:fs";
import path from "node:path";
import { realInvoker, type Invoker, type WakeResult } from "./adapters/index.js";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import type { DispatcherSettings } from "./schema.js";
import { briefOf, digestOf, doneContract, mergeSteps, parseSteps, type DoneContract } from "./format.js";
import { ProtectedGuard } from "./guard.js";
import { addBatch, askersWithAnswers, askReplyPath, checkAnswers, describeCheck, isComplete, markDelivered, parseAskBody, readAskReply, renderAnswers, resolveOptionLetters, writeAskReply } from "./ask-reply.js";
import { deliver, deliverOnce, ensureProjectDirs, finishDone, listUnread, rejectDone, routeOutboxes, unreadFiles, type RouteResult } from "./mailbox.js";
import { abandonClaim, attemptLogDir, sourceIdOf, beginAttempt, claimMessages, commitClaim, finishAttempt, markOutputReady, parkOutbox, recoverRunMail, RouteJournal, type AttemptRecord, type ClaimRecord } from "./message-store.js";
import { createRunLog } from "./run-log.js";
import { endOutcome, resolveDoneOutcome } from "./run-outcome.js";
import { outboxDir, sharedIndex } from "./policy.js";
import { buildSystemPrompt, buildUserPrompt, pickMessages } from "./prompt.js";
import { atomicWrite, readFileCapped } from "./fs-util.js";
import type { RunOutcome } from "./schema.js";
import { assertWorktreeRunnable, collectAgentChanges, dirtyPaths, existingAgentWorkspace, finishLeadBranch, integrateAgentChanges, prepareAgentWorkspace, recutLeadWorkspace, refusedIntegration, snapshotBase, snapshotHead, toplevel, type AgentWorkspace, type ChangeSet, type IntegrationResult, type ResultBranch, type WorkspacePlan, type WorkspaceMode } from "./worktree.js";
import { bindRunProject, newRunId, newRunState, roundLimit, roundsLabel, saveRunState, type EndReason, type RunState, type SentTopic } from "./run-store.js";
import { soloProject } from "./solo.js";
import { taskMessageBody, type PreparedTask } from "./task.js";
import { must } from "./assert.js";
import { openPullRequest, prBody, prTitle, realRunner, type CommandRunner, type PrOutcome } from "./open-pr.js";

export { newRunId };
export type { ActiveWake, EndReason, RunState, SentTopic, WakeRecord, WakeTopic } from "./run-store.js";

export const RESULT_FILE = "result.md";
/** How many times a non-conforming `done` goes back to the lead before it is accepted as `partial`. */
export const MAX_DONE_REJECTIONS = 2;
/** How many times a malformed `ask` goes back to its sender before the lead is told instead. */
export const MAX_ASK_REJECTIONS = 2;

/** How much of the handoff index is compared; the prompts show far less. */
const INDEX_COMPARE_LIMIT = 1024 * 1024;

/** The text of a file, "" when it is missing, undefined when there is no such file for this run (no handoff folder). */
function readIndex(file: string | undefined): string | undefined {
  if (!file) return undefined;
  return readFileCapped(file, INDEX_COMPARE_LIMIT)?.text ?? "";
}

/** Prompt for a repeat attempt: the earlier one failed and may have changed things already. */
function retryPrompt(prompt: string, error?: string): string {
  return `${prompt}\n\n# Retry notice\nYour previous attempt at this wake-up failed${error ? ` (${error})` : ""} after possibly changing files already. Its mail was discarded. Check the current state of the repository before redoing the work, and send the mail again.`;
}

export interface RunSummary {
  runId: string;
  /** The run's name; absent on runs from older versions. */
  name?: string;
  runDir: string;
  rounds: number;
  endReason: EndReason;
  /** How the work turned out; only "completed" means success. */
  outcome: RunOutcome;
  outcomeNote?: string;
  verification?: string;
  doneMessage?: { subject: string; body: string };
  /** Set when the run waits for the user: the file with the questions. */
  askReplyPath?: string;
  /** Concurrent runs: the branch holding the lead's work. */
  resultBranch?: ResultBranch;
  /** The lead asked for a pull request: what became of it. */
  pr?: PrOutcome;
  /** The project's name, for the commands printed after the run. */
  project: string;
  /** The run stopped because this agent kept failing. */
  failure?: { agent: string; error?: string; attempts: number };
}

export interface RunOptions {
  project: ResolvedProject;
  /** Name for a new run: already decided and not used by another run of the project. */
  name?: string;
  /** Run only this member of the project, alone (`run --agent`). A resumed run uses the one recorded in its state. */
  soloAgent?: string;
  /** The task for a new run; omit when resuming. */
  task?: PreparedTask;
  /** Continue this earlier run (same run dir, sessions and counters) instead of starting a new one. */
  resume?: RunState;
  /** Where the run's agents work, decided by `planWorkspace` before the run's lock was taken; the session never recomputes it. */
  plan: WorkspacePlan;
  /** Reopen a done run: this text becomes a new task for the lead. Only with `resume` of a run that ended `done`. */
  followup?: { text: string };
  runDir: string;
  invoker?: Invoker;
  /** Runs git and gh for the pull request. Tests pass a fake; the default is the real thing. */
  pr?: CommandRunner;
  /** Stop the run when this fires: running agents are killed, unread mail is kept, the run ends `cancelled` and can be resumed. */
  signal?: AbortSignal;
  log?: (line: string) => void;
}


export class RunSession {
  private readonly opts: RunOptions;
  private readonly resume: RunState | undefined;
  /** The handoff index as this segment started; the lead is noted when it is the same at `done`. */
  private readonly sharedAtStart: string | undefined;
  private readonly invoke: Invoker;
  private readonly say: (line: string) => void;
  private readonly cfg: DispatcherSettings;
  private readonly runId: string;
  private readonly runDir: string;
  /** The project bound to this run (own memory dirs and mailboxes). */
  private readonly project: ResolvedProject;
  private readonly wsMode: WorkspaceMode;
  private readonly log: ReturnType<typeof createRunLog>;
  private readonly guard: ProtectedGuard;
  private readonly state: RunState;
  private endReason: EndReason | undefined;
  private doneMessage: RunSummary["doneMessage"];
  /** The lead's done file; it leaves the outbox only after the result and end state are stored. */
  private pendingDoneFile: string | undefined;
  private doneOutcome: RunOutcome | undefined;
  private doneNote: string | undefined;
  private failure: { agent: string; error?: string; attempts: number } | undefined;
  private doneVerification: string | undefined;
  /** The accepted `done` carried `open_pr: true` (only the lead can send `done`). */
  private openPrRequested = false;
  private readonly prRunner: CommandRunner;
  /** Inbox mail each agent in the current batch is working on; it is marked read only after its output is routed. */
  private readonly claims = new Map<string, ClaimRecord>();
  private readonly noSessionNoted = new Set<string>();
  /** Git worktrees of the non-lead agents in the batch being woken (empty in shared mode and for the lead). */
  private batchSpaces: Record<string, AgentWorkspace> = {};
  /** Members whose worktree was refused (its git files were tampered with): never woken again in this run. */
  private readonly refused = new Set<string>();
  /** Concurrent runs: the lead's own git worktree for the whole run. */
  private readonly leadSpace: AgentWorkspace | undefined;
  /** The attempt that produced each batch member's output; committed together with its claim. */
  private readonly attempts = new Map<string, AttemptRecord>();

  constructor(opts: RunOptions) {

    const { task, resume, runDir } = opts;
    if (resume?.end_reason === "waiting") RunSession.assertAnswered(runDir, resume.run_id);
    if (opts.followup && resume?.end_reason !== "done") throw new Error("followup needs a finished (done) run");
    if (!task && !resume) throw new Error("runTeam needs a task or a run to resume");
    const invoke = opts.invoker ?? realInvoker;
    const say = opts.log ?? ((s: string) => console.log(s));
    const soloName = resume ? resume.solo_agent : opts.soloAgent;
    const base = soloName ? soloProject(opts.project, soloName) : opts.project;
    const cfg = base.dispatcher;
    const runId = path.basename(runDir);
    const layout = resume ? resume.mail_layout : "run";
    // Each run gets its own memory directory per agent and (new runs) its own mailboxes.
    const project = bindRunProject(base, runDir, layout);
    // Where agents work was decided before the lock was taken and is kept for the run's resumes. A resumed run that uses worktrees
    // is refused early (before anything is written) when its repo can no longer give them.
    const { plan } = opts;
    const concurrent = plan.leadWorktree;
    const wsMode = plan.mode;
    if (resume && wsMode === "worktree") assertWorktreeRunnable(project);
    // Concurrent runs: the lead works in its own worktree cut from HEAD, so no other run (and not you) shares its files.
    let leadSpace: AgentWorkspace | undefined;
    let recut = false;
    if (concurrent && resume) {
      leadSpace = existingAgentWorkspace(project, runId, project.lead);
      if (!leadSpace) throw new Error(`Run ${runId} has no worktree for ${project.lead} (was it cleared?), so it cannot be resumed.`);
      if (opts.followup) {
        // A reopened run whose branch you already merged starts on a fresh branch from HEAD (never when work would be lost).
        const r = recutLeadWorkspace(project, runId, project.lead, leadSpace, resume.result_branch?.head);
        leadSpace = r.ws;
        recut = r.recut;
        if (r.recut) say(`  ${project.lead}'s branch was already merged: a fresh branch ${leadSpace.branch} was cut from HEAD ${leadSpace.base.slice(0, 8)}`);
      }
    }
    ensureProjectDirs(project);
    fs.mkdirSync(runDir, { recursive: true });
    const log = createRunLog(path.join(runDir, "log.jsonl"), cfg.log_max_bytes);
    if (concurrent && !resume) {
      // Before the task is delivered or any state written, so a failure here leaves no half-started run.
      leadSpace = prepareAgentWorkspace(project, runId, project.lead, snapshotHead(project, runId));
      const uncommitted = dirtyPaths(project.dir).length;
      say(`  starting from HEAD ${leadSpace.base.slice(0, 8)}${uncommitted ? ` (your ${uncommitted} uncommitted file(s) are not part of this run)` : ""}; ${project.lead} works on branch ${leadSpace.branch}`);
      log("lead-workspace", { base: leadSpace.base, branch: leadSpace.branch, dir: leadSpace.dir, uncommitted });
    }

    if (!resume && plan.mode === "shared" && plan.reason) {
      say(`  agents take turns in ${project.dir} (no separate git worktrees: ${plan.reason}); commit to a git repo to run them in parallel`);
    }

    let state: RunState;
    if (resume) {
      state = { ...resume, max_rounds: roundLimit(resume, cfg.max_rounds), pid: process.pid, ended_at: undefined, end_reason: undefined, failure: undefined, workspace_mode: wsMode, outcome: undefined, outcome_note: undefined, verification: undefined, active: {}, wakes: [...resume.wakes] };
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
      if (opts.followup) {
        state.reopened = [...(resume.reopened ?? []), { at: new Date().toISOString() }];
        state.round_floor = resume.rounds;
        state.max_rounds = roundLimit(state, cfg.max_rounds);
        state.result_branch = undefined;
        state.done_rejections = 0;
        // The progress so far stays shown: the follow-up's own steps are added after it.
        state.step_base = resume.steps;
        if (recut && resume.pr_url) {
          // The recorded pull request is the merged branch's: it must not be mistaken for the new segment's.
          state.notes = [...(resume.notes ?? []), `The earlier pull request ${resume.pr_url} belongs to the merged branch; a new one is opened for the follow-up work.`];
          state.pr_url = undefined;
        }
      }
    } else {
      const t = taskMessageBody(task!);
      state = newRunState({
        run_id: runId,
        name: opts.name,
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
        solo_agent: soloName,
        lead_workspace: concurrent ? true : undefined,
      });
      const seed = parseSteps(task!.content, false);
      if (seed.length) state.steps = seed;
    }
    const saveState = () => saveRunState(runDir, state);

    // Concurrent runs: the repo's instruction files the run can touch are the lead worktree's copies; your own tree is never watched (or restored).
    const guard = new ProtectedGuard(leadSpace ? { ...project, workspaces: { ...project.workspaces, [project.lead]: leadSpace } } : project);
    if (resume) {
      log("resume", { rounds: state.rounds, interrupted: Object.keys(resume.active ?? {}) });
      if (opts.followup) {
        const n = state.reopened?.length ?? 1;
        fs.mkdirSync(path.join(runDir, "followups"), { recursive: true });
        fs.writeFileSync(path.join(runDir, "followups", `${n}.md`), `${opts.followup.text.trimEnd()}\n`);
        // A run finished before done-<n>.md existed has only result.md: keep that report before the next done overwrites it.
        const prev = path.join(runDir, `done-${n}.md`);
        const legacy = path.join(runDir, RESULT_FILE);
        if (!fs.existsSync(prev) && fs.existsSync(legacy)) fs.copyFileSync(legacy, prev);
        const handoffIdx = sharedIndex(project);
        const handoffLine = handoffIdx && fs.existsSync(handoffIdx) ? ` The handoff notes written for follow-ups are in \`${handoffIdx}\`.` : "";
        deliver(project, {
          from: "user",
          to: project.lead,
          type: "task",
          subject: opts.followup.text.split("\n").find((l) => l.trim())?.slice(0, 80) ?? "Follow-up",
          body: `## Goal\n${opts.followup.text.trimEnd()}\n\n## Acceptance criteria\nAs stated in the goal; the earlier result still holds unless the goal changes it.\n\n## Scope\nThis run's earlier work and files.\n\n## Upstream\nThe previous final report is in \`${path.join(runDir, `done-${n}.md`)}\`; the original task is in \`${path.join(runDir, "task.md")}\`.${handoffLine}\n${state.step_base?.length ? "\n## Progress\nThe earlier checklist stays in the progress; your `## Steps` lists only this follow-up's steps, which are shown after it.\n" : ""}`,
        });
        log("reopen", { n });
      }
    } else {
      const t = taskMessageBody(task!);
      guard.saveSnapshot(path.join(runDir, "snapshots"));
      deliver(project, { from: "user", to: project.lead, type: "task", subject: t.subject, body: t.body });
      log("start", { task_source: task!.source, bytes: task!.bytes, inline: task!.inline });
    }
    saveState();
    this.leadSpace = leadSpace;

    this.opts = opts;
    this.prRunner = opts.pr ?? realRunner;
    this.resume = resume;
    this.invoke = invoke;
    this.say = say;
    this.cfg = cfg;
    this.runId = runId;
    this.runDir = runDir;
    this.project = project;
    this.wsMode = wsMode;
    this.log = log;
    this.guard = guard;
    this.state = state;
    // Only a segment that starts here has a baseline: a fresh run or a follow-up reopen. A plain resume continues one begun by an earlier process.
    this.sharedAtStart = !resume || opts.followup ? readIndex(sharedIndex(project)) : undefined;
  }


  /** A waiting run only continues once every unanswered question has a valid answer. */
  private static assertAnswered(runDir: string, runId: string): void {
    const read = readAskReply(runDir);
    if (!read) return;
    const reply = resolveOptionLetters(read);
    if (JSON.stringify(reply) !== JSON.stringify(read)) writeAskReply(runDir, reply);
    const check = checkAnswers(reply);
    if (!isComplete(check)) {
      throw new Error(`Run ${runId} is still waiting for answers in ${askReplyPath(runDir)}:\n${describeCheck(check).map((l) => `  ${l}`).join("\n")}`);
    }
  }


  private saveState(): void {
    saveRunState(this.runDir, this.state);
  }


  private journal(): RouteJournal {
    return new RouteJournal(this.runDir);
  }


  private note(text: string): void {
    const { say, log, state } = this;
    state.notes ??= [];
    state.notes.push(text);
    log("note", { text });
    say(`  ${text}`);
  }


  private pendingAgents(): ResolvedAgent[] {
    const { project } = this;
    const rows = Object.values(project.agents)
      .filter((a) => !this.refused.has(a.name))
      .map((a) => ({ a, files: unreadFiles(project, a.name) }))
      .flatMap((r) => (r.files[0] ? [{ a: r.a, first: path.basename(r.files[0]) }] : []));
    rows.sort((x, y) => x.first.localeCompare(y.first));
    return rows.map((r) => r.a);
  }


  private pickBatch(pending: ResolvedAgent[]): ResolvedAgent[] {
    const { project } = this;
    const lead = pending.find((a) => a.name === project.lead);
    if (lead) return [lead];
    if (this.opts.plan.mode !== "worktree") return [must(pending[0], "an agent to wake")];
    return pending;
  }


  private async wake(agent: ResolvedAgent): Promise<{ ok: boolean; cancelled?: boolean; error?: string; attempts?: number }> {
    const { invoke, say, cfg, runDir, project, log, state, claims, attempts, noSessionNoted, opts } = this;
    const queue = listUnread(project, agent.name);
    if (queue.length === 0) return { ok: true };
    // Oldest message per wake-up (the lead takes a run of replies at once); the rest stay unread for later wake-ups.
    const unread = pickMessages(project, agent, queue);
    const claim = claimMessages(runDir, agent.name, unread);
    claims.set(agent.name, claim);
    const workDir = path.join(runDir, "agents", agent.name);
    const spaces = this.leadSpace ? { ...this.batchSpaces, [project.lead]: this.leadSpace } : this.batchSpaces;
    const aproject = Object.keys(spaces).length ? { ...project, workspaces: spaces } : project;
    const base = {
      project: aproject,
      agent,
      workDir,
      workspace: spaces[agent.name],
      systemPrompt: buildSystemPrompt(aproject, agent),
      userPrompt: buildUserPrompt(project, agent, queue, unread.length, (state.reopened?.length ?? 0) > 0),
      timeoutSec: cfg.wake_timeout_sec,
    };
    let result: WakeResult | undefined;
    for (let attempt = 0; attempt <= cfg.retry; attempt++) {
      if (state.max_rounds > 0 && state.rounds >= state.max_rounds) {
        // The round limit (when one is set) ends the run; this message stays unread for the resume.
        abandonClaim(runDir, claim.id);
        claims.delete(agent.name);
        return { ok: false, cancelled: true };
      }
      const round = ++state.rounds;
      const started = Date.now();
      const att = beginAttempt(runDir, claim.id);
      say(`[round ${roundsLabel(state.rounds, state.max_rounds)}] waking ${agent.name} (${agent.runtime})${attempt ? ` — retry ${attempt}` : ""}`);
      const sessionId = agent.resume ? state.sessions[agent.name] : undefined;
      const handling = unread.map((m) => ({ from: m.meta.from, type: m.meta.type, subject: m.meta.subject, brief: briefOf(m.body), digest: digestOf(m.meta.type, m.body) }));
      // What the panel shows for the message being worked on is uncut; the wake record below keeps the short digest.
      const activeHandling = unread.map((m, i) => ({ ...handling[i]!, digest: digestOf(m.meta.type, m.body, true) }));
      state.active[agent.name] = { round, since: new Date(started).toISOString(), handling: activeHandling };
      this.saveState();
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
      this.saveState();
      if (result.ok) {
        attempts.set(agent.name, finishAttempt(runDir, att.id, "output_ready"));
        if (agent.resume && !result.sessionId && !state.sessions[agent.name] && !noSessionNoted.has(agent.name)) {
          noSessionNoted.add(agent.name);
          this.note(`${agent.name} has resume: true but its ${agent.runtime} CLI reported no session id, so every wake-up starts a fresh session.`);
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
      this.note(
        `${agent.name} attempt ${att.n} failed (${result.error ?? "unknown error"})${parked.length ? `; ${parked.length} output file(s) set aside in ${path.join("mail", "attempts", att.id, "outbox")}` : ""}. ` +
          `Anything it already did outside its mailbox (file edits, commands) was not undone: side effects may have happened.`,
      );
    }
    if (result?.ok) markOutputReady(runDir, claim.id);
    if (!result?.ok) {
      // The agent failed every time it was called: the run stops here (see settle) and its message stays unread for the resume.
      abandonClaim(runDir, claim.id);
      claims.delete(agent.name);
      return { ok: false, error: result?.error, attempts: cfg.retry + 1 };
    }
    return { ok: true };
  }


  /**
   * A finished member's files go from its worktree into the repo before anyone reads its mail, so the lead
   * sees them. When that cannot be done, nothing is applied, the member's work stays on its branch, and the lead is told.
   */
  private integrateMember(agent: ResolvedAgent, ws: AgentWorkspace, key: string): void {
    const { say, project, log, state } = this;
    let changes: ChangeSet | undefined;
    let r: IntegrationResult;
    try {
      changes = collectAgentChanges(ws);
      r = integrateAgentChanges(project, changes, this.leadSpace);
    } catch (e) {
      // e.g. a worktree whose git files were tampered with: nothing is applied, and the lead is told like for any blocked integration
      r = refusedIntegration(project, ws, (e as Error).message);
    }
    log("integrate", { agent: agent.name, status: r.status, files: (changes?.files ?? []).map((f) => `${f.status} ${f.path}`), ...(r.status === "blocked" ? { reason: r.reason, report: r.report } : {}) });
    const blocked = (state.blocked_integrations ?? []).filter((b) => b.agent !== agent.name);
    if (r.status === "integrated") {
      state.blocked_integrations = blocked;
      if (r.files.length) say(`  ${agent.name}: ${r.files.length} changed file(s) brought into the repo`);
      return;
    }
    state.blocked_integrations = [...blocked, { agent: agent.name, branch: r.branch, reason: r.reason, report: r.report }];
    say(`  ${agent.name}: changes NOT brought into the repo (${r.reason.split("\n")[0]})`);
    deliverOnce(project, this.journal(), `integration:${key}`, {
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
    this.saveState();
  }


  /** A member whose worktree was refused: it is not woken again in this run, and the lead is told so it can react. */
  private refuseMember(agent: ResolvedAgent, reason: string): void {
    const { project, runId } = this;
    this.refused.add(agent.name);
    this.note(`${agent.name} was not woken: ${reason.split("\n")[0]}`);
    deliverOnce(project, this.journal(), `refused:${runId}:${agent.name}`, {
      from: "dispatcher",
      to: project.lead,
      type: "failure",
      subject: `${agent.name} cannot be woken: its worktree was refused`,
      body: `${agent.name} has unread mail, but its worktree cannot be used, so it is not woken again in this run and its unread mail stays unread.\n\n${reason}\n\nDo its work yourself or give it to another agent; do not wait for ${agent.name}.`,
    });
    this.saveState();
  }


  /** After a batch (or, on resume, before the first one): revert guarded edits, route mail, detect done / lead failure. */
  private settle(batch: ResolvedAgent[], results: { ok: boolean; cancelled?: boolean; error?: string; attempts?: number }[]): void {
    const { say, runDir, project, log, state, guard, claims, attempts } = this;
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
      const ws = this.batchSpaces[a.name];
      if (ws && results[i]?.ok) this.integrateMember(a, ws, claims.get(a.name)?.id ?? `${a.name}-${state.rounds}`);
    });
    const route = routeOutboxes(project);
    // A done that breaks the completion contract goes back to the lead (a limited number of times).
    let contract: DoneContract | undefined;
    if (route.done) {
      // Steps from before the last reopen were judged by the earlier done; only this segment's must be ticked.
      const earlier = new Set((state.step_base ?? []).map((x) => x.text));
      contract = doneContract(route.done.meta, route.done.body, state.steps?.filter((x) => !earlier.has(x.text)));
      if (contract.missing.length && (state.done_rejections ?? 0) < MAX_DONE_REJECTIONS) {
        state.done_rejections = (state.done_rejections ?? 0) + 1;
        const list = contract.missing.map((m) => `- ${m}`).join("\n");
        deliverOnce(project, this.journal(), `done-reject:${sourceIdOf(route.done.from, route.done.file)}`, {
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
    const askAccepted = this.handleAsks(route);
    for (const d of route.delivered) log("route", d);
    const handedOff = (from: string, t: SentTopic) => {
      const w = [...state.wakes].reverse().find((x) => x.agent === from);
      if (w) {
        w.sent ??= [];
        w.sent.push(t);
      }
    };
    for (const d of route.delivered) handedOff(d.from, { to: d.to, type: d.type, subject: d.subject });
    if (route.done) handedOff(route.done.from, { to: "(done)", type: "done", subject: route.done.subject });
    if (route.steps) state.steps = mergeSteps(state.step_base, route.steps);
    this.saveState();
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
      const handoffIdx = sharedIndex(project);
      const nowShared = handoffIdx && this.sharedAtStart !== undefined ? readIndex(handoffIdx) : undefined;
      if (nowShared !== undefined && nowShared === this.sharedAtStart) {
        this.note(
          nowShared.trim()
            ? `shared-not-updated: the lead did not change the handoff notes (${handoffIdx}) in this segment; a follow-up will see them as they are.`
            : `shared-not-updated: the lead did not write handoff notes (${handoffIdx}) in this segment, so a follow-up will start without handoff notes.`,
        );
      }
      this.doneMessage = { subject: route.done.subject, body: route.done.body };
      this.openPrRequested = route.done.meta.open_pr === true;
      const resolved = resolveDoneOutcome(must(contract, "completion contract of the done report"), state.done_rejections ?? 0, state.blocked_integrations ?? []);
      this.doneOutcome = resolved.outcome;
      this.doneNote = resolved.note;
      this.doneVerification = resolved.verification;
      const report = `# ${route.done.subject}\n\n**Outcome:** ${this.doneOutcome}${this.doneNote ? ` (${this.doneNote})` : ""}\n\n${route.done.body.trimEnd()}\n`;
      atomicWrite(path.join(runDir, RESULT_FILE), report);
      atomicWrite(path.join(runDir, `done-${(state.reopened?.length ?? 0) + 1}.md`), report);
      this.pendingDoneFile = route.done.file;
      log("done", { subject: route.done.subject });
      this.endReason = "done";
      return;
    }
    if (askAccepted) {
      this.endReason = "waiting";
      return;
    }
    const failedIdx = results.findIndex((r) => !r.ok && !r.cancelled);
    if (failedIdx >= 0) {
      const failed = must(batch[failedIdx], "failed agent");
      this.failure = { agent: failed.name, error: results[failedIdx]?.error, attempts: results[failedIdx]?.attempts ?? this.cfg.retry + 1 };
      state.failure = this.failure;
      this.endReason = failed.name === project.lead ? "lead_failed" : "agent_failed";
      return;
    }
  }


  /** The user answered: send each asker its answers as a `reply`, then mark them delivered. Safe to repeat after a crash. */
  private deliverAnswers(): void {
    const { runDir, project, log } = this;
    const reply = readAskReply(runDir);
    if (!reply) return;
    const ids = reply.questions.filter((q) => !q.delivered).map((q) => q.id).join(",");
    for (const asker of askersWithAnswers(reply)) {
      deliverOnce(project, this.journal(), `ask-answer:${ids}:${asker}`, {
        from: "user",
        to: asker,
        type: "reply",
        subject: "Answers to your questions",
        body: renderAnswers(reply, asker),
      });
    }
    writeAskReply(runDir, markDelivered(reply));
    log("ask-answered", { questions: ids });
  }


  /** Store the questions of this pass's valid `ask` mails; malformed ones go back to their sender. Returns true when the run should now wait. */
  private handleAsks(route: RouteResult): boolean {
    const { say, runDir, project, log, state } = this;
    if (route.asks.length === 0) return false;
    let reply = readAskReply(runDir);
    const accepted: string[] = [];
    for (const a of route.asks) {
      const parsed = parseAskBody(a.body);
      const added = parsed.ok ? addBatch(reply, a.from, state.rounds, parsed.questions) : parsed;
      if (!added.ok) {
        const n = (state.ask_rejections?.[a.from] ?? 0) + 1;
        state.ask_rejections = { ...state.ask_rejections, [a.from]: n };
        rejectDone(a.file);
        const reason = added.error;
        say(`  ask from ${a.from} rejected: ${reason}`);
        log("ask-rejected", { from: a.from, reason, count: n });
        if (n <= MAX_ASK_REJECTIONS) {
          deliverOnce(project, this.journal(), `ask-reject:${a.source}`, {
            from: "dispatcher",
            to: a.from,
            type: "failure",
            subject: "Your ask was not accepted",
            body: `Your \`ask\` was not accepted: ${reason}.\n\nSend it again with this shape (at most 10 questions; \`options\` and \`suggested\` are optional):\n\n<ask>\n  <question id="q1">\n    <text>Question?</text>\n    <options><option>a</option><option>b</option></options>\n    <suggested reason="why">a</suggested>\n  </question>\n</ask>\n\n(Reminder ${n} of ${MAX_ASK_REJECTIONS}.)`,
          });
        } else {
          deliverOnce(project, this.journal(), `ask-reject:${a.source}`, {
            from: "dispatcher",
            to: project.lead,
            type: "failure",
            subject: `${a.from}'s ask was rejected ${n} times`,
            body: `${a.from} sent a malformed \`ask\` rejected ${n} times (last problem: ${reason}). It was dropped. Decide without asking the user, or send the question yourself in the correct format.`,
          });
        }
        continue;
      }
      reply = added.reply;
      accepted.push(a.file);
    }
    if (!accepted.length || !reply) return false;
    if (route.done) {
      for (const f of accepted) finishDone(f);
      this.note("An ask was ignored because the lead also sent done in the same round.");
      return false;
    }
    // Questions are stored first, the outbox file moves second: a crash in between re-routes the same ask, and addBatch skips it.
    writeAskReply(runDir, reply);
    for (const f of accepted) finishDone(f);
    log("ask", { questions: reply.questions.filter((q) => !q.delivered).map((q) => q.id) });
    say(`  waiting for your answers: ${askReplyPath(runDir)}`);
    return true;
  }


  /**
   * Concurrent runs, at the end of the run: the lead's work is committed on its branch for you to merge.
   * A run that waits for your answers has not ended (it will be resumed in the same worktree), so it commits nothing.
   */
  private finishLead(endReason: EndReason): ResultBranch | undefined {
    const { say, log, state, runDir, runId, project } = this;
    if (!this.leadSpace || endReason === "waiting") return undefined;
    try {
      const rb = finishLeadBranch(this.leadSpace, `agent-lyceum: ${project.lead}'s work for run ${runId}\n\n${state.task_summary}`, path.join(runDir, "lead.patch"));
      state.result_branch = rb;
      log("lead-branch", { ...rb });
      say(rb.files ? `  work is on branch ${rb.branch} (${rb.files} file(s)); bring it into your repo with: git merge ${rb.branch}` : `  ${rb.branch}: no file changes`);
      return rb;
    } catch (e) {
      this.note(`Could not commit the work on ${this.leadSpace.branch}: ${(e as Error).message.split("\n")[0]}. It is still in ${this.leadSpace.root}.`);
      return undefined;
    }
  }

  /**
   * The lead asked for a pull request in `done`. It is opened from the lead's branch, by the dispatcher, outside any agent sandbox.
   * A request that cannot be honoured is reported and noted; it never changes how the run turned out.
   */
  private maybeOpenPr(endReason: EndReason, outcome: RunOutcome, rb: ResultBranch | undefined): PrOutcome | undefined {
    if (!this.openPrRequested) return undefined;
    const { say, log, state, runDir, project } = this;
    const skip = (reason: string): PrOutcome => {
      this.note(`A pull request was asked for but not opened: ${reason}`);
      return { status: "skipped", reason };
    };
    if (endReason !== "done" || outcome !== "completed") return skip(`the run did not end completed (${endReason}, outcome ${outcome}).`);
    if (!this.leadSpace) return skip(`this run works directly in ${this.project.dir} (not a git repo with a commit), so there is no branch to push.`);
    if (!rb) return skip(`the work could not be committed on ${this.leadSpace.branch}.`);
    if (!rb.files) return skip(`${rb.branch} has no file changes.`);

    const existingUrl = state.pr_url;
    const result = openPullRequest({
      // Never the lead's worktree: the agent can write it (and its git pointers), and git would run what it planted there.
      cwd: toplevel(project.dir),
      branch: rb.branch,
      title: prTitle(state.task_summary),
      body: prBody(this.doneMessage?.body ?? ""),
      bodyFile: path.join(runDir, "pr-body.md"),
      run: this.prRunner,
      existingUrl,
    });
    log("pull-request", { ...result });
    if (result.status === "opened") {
      say(`  pull request ${result.updated ? "updated" : "opened"}: ${result.url}`);
      if (existingUrl && !result.updated && !state.notes?.some((n) => n.includes(existingUrl)))
        this.note(`The earlier pull request ${existingUrl} was no longer open; a new one was opened for the follow-up work.`);
      state.pr_url = result.url;
    } else {
      this.note(`The pull request could not be opened (${result.step}: ${result.reason}). The branch ${rb.branch} is kept.${result.manual.length ? ` To finish by hand:\n${result.manual.map((m) => `  ${m}`).join("\n")}` : ""}`);
    }
    return result;
  }


  /** On resume: sort out what the interrupted process left behind before anything is woken. */
  private recover(): void {
    const { say, runId, runDir, project, wsMode, log } = this;
    if (this.resume?.end_reason === "waiting") this.deliverAnswers();
    const rec = recoverRunMail(runDir, { outboxOf: (agent) => outboxDir(project, agent) });
    for (const i of rec.interrupted) {
      this.note(
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
        if (agent && ws) this.integrateMember(agent, ws, c.id);
      }
    }
    for (const c of rec.abandoned) say(`  ${c.agent}'s unfinished wake-up is redone: its ${c.message_ids.length} message(s) stay unread`);
    this.settle([], []);
    // Wake-ups that had finished before the crash: their output is routed now, so their input is consumed.
    for (const c of rec.ready) commitClaim(runDir, c.id);
  }


  async run(): Promise<RunSummary> {
    if (this.resume) this.recover();

    const { say, runId, runDir, project, wsMode, log, state, opts } = this;
    // When the lead was the last one woken and left every mailbox empty without a `done`, remind it once instead of ending silently.
    let leadWasLast = false;
    let nudged = false;
    while (!this.endReason) {
      if (opts.signal?.aborted) {
        this.endReason = "cancelled";
        break;
      }
      let pending = this.pendingAgents();
      if (pending.length === 0 && leadWasLast && !nudged) {
        nudged = true;
        say("  lead left no mail and no done: reminding it to send one");
        log("nudge", { to: project.lead });
        deliverOnce(project, this.journal(), `nudge:${state.rounds}`, {
          from: "dispatcher",
          to: project.lead,
          type: "failure",
          subject: "No done message sent",
          body: `All mailboxes are empty and you have not sent a \`done\` message, so the run would end without a final report. If the job is finished and verified, send \`type: done\` now (with \`outcome: completed|partial|blocked|failed\` in the frontmatter and \`## Result\`, \`## Files\`, \`## Verification\`, \`## Not done\`${state.steps ? " and the full `## Steps` checklist" : ""}). If work remains, send the \`task\` that continues it. Writing a summary in your reply text does not count: only mail is delivered.`,
        });
        pending = this.pendingAgents();
      }
      if (pending.length === 0) {
        this.endReason = "idle";
        break;
      }
      if (state.max_rounds > 0 && state.rounds >= state.max_rounds) {
        this.endReason = "max_rounds";
        break;
      }
      const batch = this.pickBatch(pending);
      this.batchSpaces = {};
      const members = batch.filter((a) => a.name !== project.lead);
      if (wsMode === "worktree" && members.length) {
        state.snapshots = (state.snapshots ?? 0) + 1;
        this.saveState();
        let ref: string;
        try {
          ref = snapshotBase(project, runId, state.snapshots, this.leadSpace);
        } catch (e) {
          // The lead's worktree was refused (or could not be read): the run cannot go on, and the work stays where it is.
          this.note(`Could not snapshot ${this.leadSpace ? `${project.lead}'s worktree ${this.leadSpace.root}` : "the repo"} for the next batch: ${(e as Error).message.split("\n")[0]}`);
          this.endReason = "lead_failed";
          break;
        }
        for (const a of members) {
          try {
            this.batchSpaces[a.name] = prepareAgentWorkspace(project, runId, a.name, ref);
          } catch (e) {
            this.refuseMember(a, (e as Error).message);
          }
        }
        log("workspaces", { snapshot: ref, agents: Object.fromEntries(Object.entries(this.batchSpaces).map(([n, w]) => [n, w.dir])) });
      }
      this.guard.rebase();
      // a member whose worktree was refused is not woken (it would have no worktree of its own)
      const awake = wsMode === "worktree" ? batch.filter((a) => a.name === project.lead || this.batchSpaces[a.name]) : batch;
      const results = await Promise.all(awake.map((a) => this.wake(a)));
      leadWasLast = awake.some((a) => a.name === project.lead);
      if (awake.some((a) => a.name !== project.lead)) nudged = false;
      this.settle(awake, results);
      if (!this.endReason && opts.signal?.aborted) this.endReason = "cancelled";
    }

    const endReason = must(this.endReason, "end reason");
    const { outcome, note: outcomeNote } = endOutcome(endReason, endReason === "done" ? { outcome: this.doneOutcome ?? "partial", note: this.doneNote } : undefined, this.failure);
    state.end_reason = endReason;
    state.outcome = outcome;
    state.outcome_note = outcomeNote;
    state.verification = this.doneVerification;
    state.ended_at = new Date().toISOString();
    const resultBranch = this.finishLead(endReason);
    let pr: PrOutcome | undefined;
    if (this.openPrRequested) {
      // The network step can take minutes: the run is stored as ended first, so an interruption there loses nothing and a resume does not push again.
      this.saveState();
      if (this.pendingDoneFile) finishDone(this.pendingDoneFile);
      this.pendingDoneFile = undefined;
      pr = this.maybeOpenPr(endReason, outcome, resultBranch);
    }
    log("end", { reason: endReason, outcome, rounds: state.rounds });
    this.saveState();
    if (this.pendingDoneFile) finishDone(this.pendingDoneFile);
    return { runId, name: state.name, runDir, rounds: state.rounds, endReason, outcome, outcomeNote, verification: this.doneVerification, doneMessage: this.doneMessage, askReplyPath: endReason === "waiting" ? askReplyPath(runDir) : undefined, resultBranch, pr, project: project.name, failure: this.failure };
  }
}
