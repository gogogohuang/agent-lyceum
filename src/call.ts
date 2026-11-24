import fs from "node:fs";
import path from "node:path";
import { invokeWithSandboxChecks } from "./sandbox-invocation.js";
import { realInvoker, type Invoker, type WakeResult } from "./adapters/index.js";
import { must } from "./assert.js";
import os from "node:os";
import { appendApprovalDiagnostic, callApprovalView, collectCallApproval, publishCallApprovalOk, type CallApprovalOk } from "./approval-call.js";
import { defaultCollectDeps, type CollectDeps, type CollectLog } from "./approval-collect.js";
import { ApprovalError } from "./approval-error.js";
import { requestPaths, type SlotRef } from "./approval-paths.js";
import { assertApprovalConfig, enrollProject } from "./approval-runtime.js";
import { createRotation } from "./approval-rotation.js";
import { snapshotInputs } from "./approval-snapshot.js";
import { GATE_TEXT, callGateVerdict } from "./approval-wake-gate.js";
import type { PremiseOptions } from "./doctor-approval-premises.js";
import { ConfigError, loadGlobal, loadProjectRaw, resolveProjectFrom, type ResolvedAgent, type ResolvedProject } from "./config.js";
import { agentForCandidate, type Candidate, candidatesFor, Cooldowns, runWithFallback, type Tried } from "./fallback.js";
import { atomicWrite } from "./fs-util.js";
import { otherCallPrefixes, ProtectedGuard, runsStartedAfter } from "./guard.js";
import { fault } from "./message-store.js";
import { assertName, canonicalPath, configPath, homePaths, isInside, projectPaths, type ProjectPaths } from "./paths.js";
import { memoryDirs, osSandboxAvailable } from "./policy.js";
import { acquireProjectLock, listRunLocks, lockHolderAlive, type LockInfo, type ProjectLease } from "./project-lock.js";
import { shortIdOf } from "./proposals.js";
import { buildCallUserPrompt, buildSoloSystemPrompt, buildSystemPrompt } from "./prompt.js";
import { newRunId } from "./run-store.js";
import { DISPATCHER_DEFAULTS } from "./schema.js";

export const CALL_PROJECT = "(call)";

export const callsDir = (home: string): string => path.join(home, "calls");

export interface CallOptions {
  home: string;
  agent: string;
  task: string;
  /** Working directory; must exist. */
  dir: string;
  /** `call -p`: a registered project this call may write proposals to (spec 30). Without it a call reads and writes no project. */
  project?: string;
  invoker?: Invoker;
  signal?: AbortSignal;
  say?: (line: string) => void;
  /** Only used with a fallback chain, to wait out a cooldown; tests pass one that does not wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Approval gate: platform and sandbox facts for the premise checks of an enrolled agent; tests inject them. Default: this process. */
  approvalPremise?: PremiseOptions;
  /** Collector dependencies for an enrolled call. Tests inject the clock, tokens and filesystem. Production omits it. */
  approvalCollect?: CollectDeps;
}

export interface CallResult {
  callId: string;
  callDir: string;
  ok: boolean;
  cancelled: boolean;
  /** The agent's final reply (empty when the call failed). */
  text: string;
  error?: string;
  /** With a fallback chain: each model that failed, in order. */
  tried?: Tried[];
  /** Protected files the agent changed and agent-lyceum put back. */
  reverted: string[];
}

/** A global agent (from team.yaml) as a `call` uses it: global persona and memory, nobody to mail, nothing to ask, nothing to edit. */
export function resolveCallAgent(home: string, name: string): ResolvedAgent {
  assertName("agent", name);
  const g = loadGlobal(home);
  if (!g.agents[name]) {
    throw new ConfigError(`"${name}" is not an agent of the global library (${homePaths(home).globalConfig}). Global agents: ${Object.keys(g.agents).join(", ") || "(none)"}.`);
  }
  const p = enrollProject(resolveProjectFrom(home, CALL_PROJECT, g, { dir: home, team: { lead: name }, dispatcher: {}, agents: { [name]: {} } }), { project: null });
  assertApprovalConfig(p);
  const a = must(p.agents[name], "the resolved agent");
  if (!a.runtime) throw new ConfigError(`Agent "${name}" has no runtime: set runtime (or a model) for it in team.yaml.`);
  if (!fs.existsSync(a.agentMd)) throw new ConfigError(`AGENT.md of "${name}" not found: ${a.agentMd}`);
  return {
    ...a,
    memory: { global: a.memory.global ?? path.join(homePaths(home).globalAgentsDir, name, "memory") },
    resume: false,
    canMessage: [],
    canAskUser: false,
    canEditAgentMd: false,
  };
}

/** The registered project a `call -p` proposes to: where its trees are and its repository. Reads only `project.yaml`; no members, no permissions, never a guess from the current directory. */
export function resolveProjectRef(home: string, name: string): { paths: ProjectPaths; dir: string } {
  assertName("project", name);
  const paths = projectPaths(home, name);
  const raw = loadProjectRaw(home, name); // throws a ConfigError when there is no such project
  return { paths, dir: configPath(raw.dir, paths.root) };
}

/** The made-up project a call runs in: the working directory is its repo, and every other path is inside the call's own folder. */
export function callProject(home: string, agent: ResolvedAgent, dir: string, callDir: string): ResolvedProject {
  const paths: ProjectPaths = {
    root: callDir,
    config: path.join(callDir, "call.yaml"),
    agentsDir: path.join(callDir, "agents"),
    shared: path.join(callDir, "shared"),
    inboxRoot: path.join(callDir, "mail", "inbox"),
    outboxRoot: path.join(callDir, "mail", "outbox"),
    runs: path.join(callDir, "runs"),
    taskMemory: path.join(callDir, "task-memory"),
  };
  return {
    home,
    name: CALL_PROJECT,
    dir,
    lead: agent.name,
    dispatcher: DISPATCHER_DEFAULTS,
    agents: { [agent.name]: agent },
    modelTiers: {},
    modelTiersFrom: {},
    paths,
    solo: "call",
  };
}

interface Holder {
  pid: number;
  call_id: string;
}

function readHolder(file: string): Holder | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof j?.pid === "number" && typeof j?.call_id === "string" ? j : undefined;
  } catch {
    return undefined;
  }
}

/** One call per agent at a time (two would write the same global memory). A lock whose process is gone, or that cannot be read, is taken over. */
export function lockAgent(home: string, agent: string, callId: string): { release(): void } {
  const dir = callsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `.lock-${agent}`);
  const mine = JSON.stringify({ pid: process.pid, call_id: callId });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, mine, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const cur = readHolder(file);
      if (cur && lockHolderAlive({ pid: cur.pid } as LockInfo)) throw new Error(`${agent} is already being called (call ${cur.call_id}, pid ${cur.pid}). Wait for it to finish.`);
      if (attempt >= 1) throw new Error(`Could not take ${file}; try again.`);
      fs.rmSync(file, { force: true });
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    if (readHolder(file)?.call_id === callId) fs.rmSync(file, { force: true });
  };
  process.on("exit", release);
  return { release };
}

const preflightError = (callId: string): string =>
  `Approval call not started: proposals could not be confirmed empty. Run agent-lyceum doctor; inspect requests/calls/${callId}.`;
const parkError = (callId: string): string =>
  `Approval call stopped: failed-attempt proposals could not be parked. Inspect requests/calls/${callId}.`;
const markerError = (callId: string): string =>
  `Approval call success marker could not be committed; no collection was attempted. Inspect requests/calls/${callId}/ok.json.`;
const retainedError = (callId: string, code: string): string =>
  `Call ${callId}: approval collection retained (${code}); fix configuration or run agent-lyceum doctor, then retry approvals collect --call ${callId}.`;

/** A simulated crash has no errno. Approval and filesystem failures stay inside the call. */
function faultEscape(e: unknown): boolean {
  if (e instanceof ApprovalError) return false;
  return typeof (e as { code?: unknown } | null)?.code !== "string";
}

/** Real empty directory, or a missing one rebuilt by rotation. A nonempty or unsafe directory is refused, not collected. */
function confirmEmptyProposals(home: string, slot: SlotRef, attemptId: string, rotation: ReturnType<typeof createRotation>): string {
  return rotation.withSlotCoord(home, slot, () => {
    const proposals = requestPaths(home, slot).proposals;
    let exists = false;
    try {
      if (!fs.lstatSync(proposals).isDirectory()) throw new ApprovalError("UNSAFE_PATH", "proposals is not a real directory");
      exists = true;
    } catch (e) {
      if (e instanceof ApprovalError) throw e;
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (exists) {
      const dir = fs.opendirSync(proposals);
      try {
        if (dir.readSync() !== null) throw new ApprovalError("UNSAFE_PATH", "proposals is not empty");
      } finally { dir.closeSync(); }
    }
    return rotation.rotate(home, slot, { kind: "parked", attempt_id: attemptId }).proposals;
  });
}

/** Wake one global agent once, alone, in `dir`. Leaves task.md, log/ and result.md in `<home>/calls/<call-id>/`. */
export async function callAgent(o: CallOptions): Promise<CallResult> {
  const say = o.say ?? ((s: string) => console.error(s));
  const agent = resolveCallAgent(o.home, o.agent);
  const dir = path.resolve(o.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Working directory not found: ${dir}`);
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const realDir = real(dir);
  const realHome = real(o.home);
  // The called agent is the only one listed, so only its files are protected: nothing may run where the rest of the home is writable.
  if (isInside(realHome, realDir) || isInside(realDir, realHome)) {
    throw new Error(`Working directory ${dir} overlaps the agent-lyceum home ${o.home}: a call could change other agents' files there. Pass a --dir that is neither inside nor above the agent-lyceum home.`);
  }
  if (!o.task.trim()) throw new Error("No task given: pass it as text or with --task-file.");
  const ref = o.project ? resolveProjectRef(o.home, o.project) : undefined;

  // The id, directory and project are only computed here (nothing is created); the gate sees the very project the call will run with.
  const callId = newRunId();
  const callDir = path.join(callsDir(o.home), callId);
  const base = callProject(o.home, agent, dir, callDir);
  const project: ResolvedProject = ref
    ? { ...base, proposalsRef: { projectRoot: ref.paths.root, recordsRoot: path.join(ref.paths.shared, "common", "records"), proposalsRoot: path.join(ref.paths.root, "proposals"), dir: ref.dir, shortId: shortIdOf(callId) } }
    : base;

  const premise = o.approvalPremise ?? { platform: process.platform, sandboxAvailable: osSandboxAvailable };
  // An enrolled agent is checked again now (premises and containment, as doctor does) before any call directory or lease exists.
  if (agent.enrolled) {
    const v = callGateVerdict({ home: o.home, agent, actual: project, userHome: os.homedir(), premise });
    if (v.kind !== "wake") {
      const failed = v.premises?.length ? ` (failed: ${v.premises.join(", ")})` : "";
      throw new ConfigError(`${agent.name} was not called: ${GATE_TEXT[v.code].status}${failed}. No agent was started.${GATE_TEXT[v.code].status.includes("doctor") ? "" : " Run `agent-lyceum doctor` for details."}`);
    }
  }

  const lease = lockAgent(o.home, agent.name, callId);
  let projectLease: ProjectLease | undefined;
  try {
    // A `call -p` is active in the project like a run without being one: a memory tidy or `proposals review` must wait for it, other runs need not (spec 30, D-04).
    if (ref) projectLease = acquireProjectLock(ref.paths.root, callId, { call: true });
    fs.mkdirSync(path.join(callDir, "log"), { recursive: true });
    fs.writeFileSync(path.join(callDir, "task.md"), o.task);
    for (const d of memoryDirs(agent)) fs.mkdirSync(d, { recursive: true });
    if (project.proposalsRef) fs.mkdirSync(project.proposalsRef.proposalsRoot, { recursive: true });
    // Another run of the project that is live, or began and ended while this call worked, may have written the shared files legitimately; this call may not.
    const guard = ref
      ? new ProtectedGuard(
          project,
          () => listRunLocks(ref.paths.root).filter((l) => !l.call && lockHolderAlive(l)).map((l) => l.run_id),
          { recordsRoot: project.proposalsRef!.recordsRoot, proposalsRoot: project.proposalsRef!.proposalsRoot, shortId: project.proposalsRef!.shortId, violationsDir: path.join(callDir, "guard-violations"), startedAfter: (stamp) => runsStartedAfter(ref.paths.runs, stamp), otherPrefixes: otherCallPrefixes(o.home, ref.paths.root, callId) },
        )
      : new ProtectedGuard(project);

    say(`Calling ${agent.name} in ${dir} (call ${callId})`);
    const invoke = o.invoker ?? realInvoker;
    const all = candidatesFor(agent);
    const chain = all.length > 1;
    // The primary logs to log/ as always; each backup to a directory of its own, so its run does not overwrite the primary's logs.
    const logDirFor = (c: Candidate) => (c.primary ? path.join(callDir, "log") : path.join(callDir, "log", `fallback-${all.indexOf(c)}`));
    const sink = { event: (name: string, fields: Record<string, unknown>) => say(JSON.stringify({ event: name, ...fields })) };
    let logged = false;
    const diagnose = (fields: CollectLog): void => {
      logged = true;
      try {
        appendApprovalDiagnostic(path.join(callDir, "log.jsonl"), project.dispatcher.log_max_bytes, fields);
      } catch {
        say("Approval call diagnostics could not be persisted.");
      }
    };
    const legacyInvoke = (c: Candidate, ctx: { attempt: number }) =>
      invokeWithSandboxChecks(
        invoke,
        {
          project,
          agent: agentForCandidate(agent, c),
          workDir: callDir,
          systemPrompt: buildSoloSystemPrompt(project, agent),
          userPrompt: buildCallUserPrompt(agent, o.task, project),
          timeoutSec: project.dispatcher.wake_timeout_sec,
          signal: o.signal,
          logDir: logDirFor(c),
        },
        agent,
        sink,
        ctx.attempt,
      ).catch((e: Error) => ({ ok: false, text: "", exitCode: null, timedOut: false, error: e.message }));
    let baseline: Record<string, string> | undefined;
    let successAttempt = 0;
    let successFull: CallApprovalOk["full_writable"] | undefined;
    const rotation = agent.enrolled ? createRotation({ fault: (point) => fault(point) }) : undefined;
    const slot: SlotRef = { kind: "call", call_id: callId };
    const enrolledInvoke = async (c: Candidate, ctx: { attempt: number }): Promise<WakeResult> => {
      if (o.signal?.aborted) return { ok: false, text: "", exitCode: null, timedOut: false, cancelled: true };
      const n = String(ctx.attempt + 1);
      const stop = (error: string, op: CollectLog["op"]): WakeResult => {
        say(error);
        diagnose({ slot: agent.name, op, class: "io" });
        return { ok: false, text: "", exitCode: null, timedOut: false, kind: "config", error };
      };
      const view = callApprovalView({ home: o.home, callId, role: agent.name, projectDir: dir, premise, expected: baseline });
      if (!view.ok) return stop(preflightError(callId), "pass");
      if (!baseline) baseline = { ...view.qualifications };
      let proposals: string;
      try {
        proposals = canonicalPath(confirmEmptyProposals(o.home, slot, n, rotation!));
      } catch (e) {
        if (faultEscape(e)) throw e;
        return stop(preflightError(callId), "pass");
      }
      const snap = snapshotInputs(view.project, view.agent.name, view.config, proposals);
      let result: WakeResult;
      try {
        result = await invokeWithSandboxChecks(invoke, {
          project: view.project,
          agent: agentForCandidate(view.agent, c),
          workDir: callDir,
          systemPrompt: buildSystemPrompt(view.project, view.agent, proposals),
          userPrompt: `${buildCallUserPrompt(view.agent, o.task, project)}\n\nApproval request directory (see the system prompt): ${proposals}`,
          timeoutSec: view.project.dispatcher.wake_timeout_sec,
          signal: o.signal,
          logDir: logDirFor(c),
          requestDir: proposals,
        }, view.agent, sink, ctx.attempt);
      } catch (e) {
        result = { ok: false, text: "", exitCode: null, timedOut: false, error: (e as Error).message };
      }
      if (!result.ok || result.cancelled) {
        try { rotation!.park(o.home, slot, n); }
        catch (e) {
          if (faultEscape(e)) throw e;
          diagnose({ slot: agent.name, op: "park", class: "io" });
          if (result.cancelled) return result;
          const error = parkError(callId);
          say(error);
          return { ok: false, text: "", exitCode: null, timedOut: false, kind: "config", error };
        }
        fault("call:failed-proposals-parked");
        return result;
      }
      successAttempt = ctx.attempt + 1;
      successFull = { dirs: [...snap.full.dirs], files: [...snap.full.files] };
      return result;
    };
    // A call is a single shot: no retries on one model, and cooldowns that live only as long as it does.
    const outcome = await runWithFallback<WakeResult>({
      candidates: all,
      legacy: !chain,
      retry: 0,
      cooldowns: new Cooldowns(),
      cooldownSec: project.dispatcher.fallback_cooldown_sec,
      signal: o.signal,
      sleep: o.sleep,
      onSwitch: (_from, to, kind) => {
        if (o.signal?.aborted) return;
        say(`  ${agent.name} falling back to ${to.model ? `${to.runtime}/${to.model}` : to.runtime} (${kind ?? "unknown error"})`);
      },
      invoke: agent.enrolled ? enrolledInvoke : legacyInvoke,
    });
    const result = must(outcome.result, "the call's result");
    const tried = chain ? outcome.tried : undefined;

    const reverted = guard.check([agent]).map((v) => v.file);
    for (const f of reverted) say(`warn   ${agent.name} changed ${f}; it was put back.`);
    let published = false;
    if (agent.enrolled && result.ok && !result.cancelled && baseline && successFull) {
      const marker: CallApprovalOk = {
        schema_version: 1, call_id: callId, role: agent.name, project_dir: canonicalPath(dir),
        successful_attempt: successAttempt, full_writable: successFull, qualifications: baseline,
      };
      try { publishCallApprovalOk(o.home, marker); }
      catch (e) {
        if (faultEscape(e)) throw e;
        throw new Error(markerError(callId));
      }
      published = true;
      fault("call:ok-published");
    }
    const cancelled = !!result.cancelled;
    const error = result.ok ? undefined : cancelled ? "cancelled" : (result.error ?? (result.timedOut ? "timed out" : "failed"));
    const triedList = !result.ok && !cancelled && tried?.length ? `\nTried:\n${tried.map((t) => `- ${t.model ? `${t.runtime}/${t.model}` : t.runtime} (${t.kind ?? "unknown"}): ${t.error ?? "failed"}`).join("\n")}\n` : "";
    atomicWrite(path.join(callDir, "result.md"), result.ok ? `${result.text.trimEnd()}\n` : `# Call ${cancelled ? "cancelled" : "failed"}\n\n${error}\n${triedList}`);
    if (published) fault("call:result-written");
    if (published && baseline && successFull) {
      const injected = o.approvalCollect;
      const collect = {
        ...(injected ?? defaultCollectDeps(() => undefined)),
        fault: (point: string) => { fault(point); injected?.fault(point); },
        log: (event: "approval_collect", fields: CollectLog) => { diagnose(fields); injected?.log(event, fields); },
      };
      try {
        const collected = collectCallApproval(o.home, {
          schema_version: 1, call_id: callId, role: agent.name, project_dir: canonicalPath(dir),
          successful_attempt: successAttempt, full_writable: successFull, qualifications: baseline,
        }, { premise, collect, log: (_event, fields) => diagnose(fields) });
        if (collected.verdict.kind !== "wake") {
          say(retainedError(callId, collected.verdict.code));
          if (!logged) diagnose({ slot: agent.name, op: "pass", class: "io" });
        }
      } catch {
        say(retainedError(callId, "UNDETERMINABLE"));
        if (!logged) diagnose({ slot: agent.name, op: "pass", class: "io" });
      }
      fault("call:collection-finished");
    }
    return { callId, callDir, ok: result.ok, cancelled, text: result.ok ? result.text : "", error, ...(tried ? { tried } : {}), reverted };
  } finally {
    projectLease?.release();
    lease.release();
  }
}
