import fs from "node:fs";
import path from "node:path";
import { realInvoker, type Invoker, type WakeResult } from "./adapters/index.js";
import { must } from "./assert.js";
import { ConfigError, loadGlobal, resolveProjectFrom, type ResolvedAgent, type ResolvedProject } from "./config.js";
import { atomicWrite } from "./fs-util.js";
import { ProtectedGuard } from "./guard.js";
import { assertName, homePaths, isInside, type ProjectPaths } from "./paths.js";
import { memoryDirs } from "./policy.js";
import { lockHolderAlive, type LockInfo } from "./project-lock.js";
import { buildCallUserPrompt, buildSoloSystemPrompt } from "./prompt.js";
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
  invoker?: Invoker;
  signal?: AbortSignal;
  say?: (line: string) => void;
}

export interface CallResult {
  callId: string;
  callDir: string;
  ok: boolean;
  cancelled: boolean;
  /** The agent's final reply (empty when the call failed). */
  text: string;
  error?: string;
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
  const p = resolveProjectFrom(home, CALL_PROJECT, g, { dir: home, team: { lead: name }, dispatcher: {}, agents: { [name]: {} } });
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
    owns: [],
  };
}

/** The made-up project a call runs in: the working directory is its repo, and every other path is inside the call's own folder. */
export function callProject(home: string, agent: ResolvedAgent, dir: string, callDir: string): ResolvedProject {
  const paths: ProjectPaths = {
    root: callDir,
    config: path.join(callDir, "call.yaml"),
    agentsDir: path.join(callDir, "agents"),
    shared: path.join(callDir, "shared"),
    common: path.join(callDir, "shared", "COMMON.md"),
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
    dispatcher: { ...DISPATCHER_DEFAULTS, max_parallel: 1, workspace_mode: "shared" },
    agents: { [agent.name]: agent },
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

  const callId = newRunId();
  const callDir = path.join(callsDir(o.home), callId);
  const lease = lockAgent(o.home, agent.name, callId);
  try {
    fs.mkdirSync(path.join(callDir, "log"), { recursive: true });
    fs.writeFileSync(path.join(callDir, "task.md"), o.task);
    for (const d of memoryDirs(agent)) fs.mkdirSync(d, { recursive: true });
    const project = callProject(o.home, agent, dir, callDir);
    const guard = new ProtectedGuard(project);

    say(`Calling ${agent.name} in ${dir} (call ${callId})`);
    const invoke = o.invoker ?? realInvoker;
    const result: WakeResult = await invoke({
      project,
      agent,
      workDir: callDir,
      systemPrompt: buildSoloSystemPrompt(project, agent),
      userPrompt: buildCallUserPrompt(agent, o.task),
      timeoutSec: project.dispatcher.wake_timeout_sec,
      signal: o.signal,
      logDir: path.join(callDir, "log"),
    }).catch((e: Error) => ({ ok: false, text: "", exitCode: null, timedOut: false, error: e.message }));

    const reverted = guard.check([agent]).map((v) => v.file);
    for (const f of reverted) say(`warn   ${agent.name} changed ${f}; it was put back.`);
    const cancelled = !!result.cancelled;
    const error = result.ok ? undefined : cancelled ? "cancelled" : (result.error ?? (result.timedOut ? "timed out" : "failed"));
    atomicWrite(path.join(callDir, "result.md"), result.ok ? `${result.text.trimEnd()}\n` : `# Call ${cancelled ? "cancelled" : "failed"}\n\n${error}\n`);
    return { callId, callDir, ok: result.ok, cancelled, text: result.ok ? result.text : "", error, reverted };
  } finally {
    lease.release();
  }
}
