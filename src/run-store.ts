import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ResolvedProject } from "./config.js";
import type { DigestSection, Step } from "./format.js";
import { atomicWrite } from "./fs-util.js";
import type { RunOutcome } from "./schema.js";
import type { ResultBranch } from "./worktree.js";

export const STATE_FILE = "state.json";
export const STATE_SCHEMA_VERSION = 2;

export type EndReason = "done" | "idle" | "max_rounds" | "lead_failed" | "cancelled" | "waiting";
export type MailLayout = "run" | "legacy";

export interface WakeTopic {
  from: string;
  type: string;
  subject: string;
  /** What the message is about, in one line. */
  brief?: string;
  /** The same, as short readable sections by message type (see `digestOf`). */
  digest?: DigestSection[];
}

export interface SentTopic {
  to: string;
  type: string;
  subject: string;
}

export interface ActiveWake {
  round: number;
  since: string;
  handling: WakeTopic[];
}

export interface WakeRecord {
  round: number;
  agent: string;
  at: string;
  duration_ms: number;
  ok: boolean;
  output_tokens?: number;
  handling: WakeTopic[];
  /** Mail this wake handed to others; `to` is "(done)" for the lead's final message. */
  sent?: SentTopic[];
  error?: string;
}

export interface RunState {
  /** 1 for runs written before versioning; 2 for runs with their own mailboxes. */
  schema_version: number;
  /** "run": mail lives under the run dir. "legacy": the shared project mailboxes of older versions. */
  mail_layout: MailLayout;
  run_id: string;
  project: string;
  task_source: "text" | "file";
  task_path?: string;
  started_at: string;
  ended_at?: string;
  rounds: number;
  max_rounds: number;
  end_reason?: EndReason;
  /** How the work turned out; absent on runs that ended before outcomes existed. */
  outcome?: RunOutcome;
  /** Why the outcome is not what the lead declared (completion contract not met, legacy done, ...). */
  outcome_note?: string;
  /** First lines of the lead's `## Verification`, for display. */
  verification?: string;
  /** How many `done` mails were sent back because they broke the completion contract. */
  done_rejections?: number;
  /** How many malformed `ask` mails each agent had sent back (the limit is MAX_ASK_REJECTIONS). */
  ask_rejections?: Record<string, number>;
  /** Recovery remarks (interrupted attempts whose side effects may have happened). */
  notes?: string[];
  /** "worktree": non-lead agents work in their own git worktrees. */
  workspace_mode?: "shared" | "worktree";
  /** Set when the run was started with `run --agent <name>`: that member works alone (a resumed run keeps it). */
  solo_agent?: string;
  /** Agents whose finished work could not be brought into the repo yet; their work is kept on their branch. */
  blocked_integrations?: { agent: string; branch: string; reason: string; report: string }[];
  /** Snapshots of the repo taken so far (`refs/agent-lyceum/<run>/base-<n>`). */
  snapshots?: number;
  /** Concurrent runs: where the lead's work ended up (`git merge <branch>`). Set when the run ends. */
  result_branch?: ResultBranch;
  /** Set when the run started with the lead in its own worktree (max_concurrent_runs > 1 then); its resumes keep that, whatever the config says later. */
  lead_workspace?: true;
  /** The pull request the dispatcher opened for this run (when the lead asked for one and it worked). */
  pr_url?: string;
  sessions: Record<string, string>;
  output_tokens: number;
  last_wake: Record<string, { at: string; ok: boolean; error?: string }>;
  /** Process running this dispatcher, so a monitor can tell "running" from "interrupted". */
  pid: number;
  /** One line describing the run's task. */
  task_summary: string;
  /** Agents being woken right now and what they were asked to handle. */
  active: Record<string, ActiveWake>;
  /** Finished wakes, oldest first. */
  wakes: WakeRecord[];
  /** Checklist progress: seeded from the task, then replaced by the lead's latest `## Steps`. */
  steps?: Step[];
  /** Readable name; lets `resume`, `clear` and `status` find the run without its id. Absent on runs from older versions. */
  name?: string;
  /** One entry per time a finished run was reopened with a follow-up. */
  reopened?: { at: string }[];
  /** `rounds` at the last reopen; the round limit counts from here. */
  round_floor?: number;
}

/** `20261006T010203456Z-<128 random bits>`: sorts by start time and cannot collide, even for two starts in one millisecond. */
export function newRunId(d = new Date()): string {
  const t = d.toISOString().replace(/[-:]/g, "").replace(/\.(\d+)Z$/, "$1Z");
  return `${t}-${crypto.randomBytes(16).toString("hex")}`;
}

const nonNeg = z.number().finite();
const WireState = z
  .object({
    schema_version: z.number().int().optional(),
    mail_layout: z.enum(["run", "legacy"]).optional(),
    run_id: z.string().min(1),
    project: z.string().optional(),
    task_source: z.enum(["text", "file"]).optional(),
    task_path: z.string().optional(),
    started_at: z.string().optional(),
    ended_at: z.string().optional(),
    rounds: nonNeg.optional(),
    max_rounds: nonNeg.optional(),
    end_reason: z.enum(["done", "idle", "max_rounds", "lead_failed", "cancelled", "waiting"]).optional(),
    outcome: z.enum(["completed", "partial", "blocked", "failed", "waiting", "cancelled"]).optional(),
    outcome_note: z.string().optional(),
    verification: z.string().optional(),
    done_rejections: nonNeg.optional(),
    notes: z.array(z.string()).optional(),
    ask_rejections: z.record(z.string(), nonNeg).optional(),
    sessions: z.record(z.string(), z.string()).optional(),
    output_tokens: nonNeg.optional(),
    last_wake: z.record(z.string(), z.any()).optional(),
    pid: z.number().optional(),
    task_summary: z.string().optional(),
    active: z.record(z.string(), z.any()).optional(),
    wakes: z.array(z.any()).optional(),
    solo_agent: z.string().optional(),
    steps: z.array(z.object({ text: z.string(), done: z.boolean() })).optional(),
    name: z.string().optional(),
    reopened: z.array(z.object({ at: z.string() })).optional(),
    round_floor: nonNeg.optional(),
  })
  .passthrough();

/** A fresh v2 state; every collection present. */
export function newRunState(init: Partial<RunState> & { run_id: string }): RunState {
  return normalize({ ...init, schema_version: STATE_SCHEMA_VERSION, mail_layout: init.mail_layout ?? "run" });
}

function normalize(w: z.infer<typeof WireState>): RunState {
  const version = w.schema_version ?? 1;
  return {
    ...(w as object),
    schema_version: version,
    mail_layout: version >= 2 ? (w.mail_layout ?? "run") : "legacy",
    run_id: w.run_id,
    project: w.project ?? "",
    task_source: w.task_source ?? "text",
    started_at: w.started_at ?? "",
    rounds: w.rounds ?? 0,
    max_rounds: w.max_rounds ?? 0,
    sessions: w.sessions ?? {},
    output_tokens: w.output_tokens ?? 0,
    last_wake: w.last_wake ?? {},
    pid: w.pid ?? 0,
    task_summary: w.task_summary ?? "",
    active: w.active ?? {},
    wakes: w.wakes ?? [],
  } as RunState;
}

/** Read and validate `<runDir>/state.json`; throws an error naming the file and the problem. */
export function loadRunState(runDir: string): RunState {
  const file = path.join(runDir, STATE_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`Run state not found: ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Run state is not valid JSON (${file}): ${(e as Error).message}`);
  }
  const parsed = WireState.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Run state is invalid (${file}): ${msg}`);
  }
  if ((parsed.data.schema_version ?? 1) > STATE_SCHEMA_VERSION) {
    throw new Error(
      `Run state ${file} uses schema_version ${parsed.data.schema_version}, newer than this agent-lyceum understands (${STATE_SCHEMA_VERSION}). Upgrade agent-lyceum.`,
    );
  }
  return normalize(parsed.data);
}

export function saveRunState(runDir: string, state: RunState): void {
  atomicWrite(path.join(runDir, STATE_FILE), JSON.stringify(state, null, 2));
}

/**
 * The project as one run sees it. Per-task memory is always private to the run. With the "run" layout the
 * mailboxes live inside the run dir; with "legacy" they stay the shared project mailboxes older versions used.
 */
export function bindRunProject(project: ResolvedProject, runDir: string, layout: MailLayout): ResolvedProject {
  const runId = path.basename(runDir);
  const agents = Object.fromEntries(
    Object.entries(project.agents).map(([n, a]) => [n, { ...a, memory: { ...a.memory, task: path.join(project.paths.taskMemory, runId, n) } }]),
  );
  const paths =
    layout === "run"
      ? { ...project.paths, inboxRoot: path.join(runDir, "mail", "inbox"), outboxRoot: path.join(runDir, "mail", "outbox") }
      : project.paths;
  return { ...project, agents, paths, run: { id: runId, dir: runDir, layout } };
}

/**
 * How a finished run turned out. Runs that ended before outcomes existed have none recorded: they read as
 * partial (failed for a failed lead) and `verified: false`, never as a success nobody checked.
 */
export function outcomeOf(s: Pick<RunState, "outcome" | "end_reason">): { outcome: RunOutcome; verified: boolean } | undefined {
  if (s.outcome) return { outcome: s.outcome, verified: true };
  if (!s.end_reason) return undefined;
  return { outcome: s.end_reason === "lead_failed" ? "failed" : s.end_reason === "cancelled" ? "cancelled" : s.end_reason === "waiting" ? "waiting" : "partial", verified: false };
}

const NAME_MAX = 30;

export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_MAX)
    .replace(/-+$/g, "");
  return s || "task";
}

/** `base`, or `base-2`, `base-3` … the first that is not in `taken`. */
export function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    // The result stays within the 30 characters of a slug: trim the base, then any "-" the trim leaves at its end.
    const candidate = `${base.slice(0, Math.max(1, NAME_MAX - suffix.length)).replace(/-+$/g, "")}${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** How a run is named in output: `name (run_id)`, or just the id for a run without a name. */
export const runLabel = (r: { name?: string; run_id: string }): string => (r.name ? `${r.name} (${r.run_id})` : r.run_id);

export type RunRef = { dir: string; state: RunState };
export type Resolved = { ok: true; run: RunRef } | { ok: false; reason: "none" | "ambiguous"; candidates: RunRef[] };

/** Find a run by full id, exact name, or a prefix of either that matches exactly one run. An exact id or name always wins. */
export function resolveRun(runs: RunRef[], query: string): Resolved {
  const exact = runs.filter((r) => r.state.run_id === query || r.state.name === query);
  if (exact.length === 1) return { ok: true, run: exact[0] as RunRef };
  const pool = exact.length ? exact : runs.filter((r) => r.state.run_id.startsWith(query) || (r.state.name ?? "").startsWith(query));
  if (pool.length === 1) return { ok: true, run: pool[0] as RunRef };
  return { ok: false, reason: pool.length ? "ambiguous" : "none", candidates: pool };
}

export const roundLimit = (state: Pick<RunState, "round_floor">, maxRounds: number): number => (state.round_floor ?? 0) + maxRounds;
