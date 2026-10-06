import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ResolvedProject } from "./config.js";
import type { Step } from "./format.js";
import { atomicWrite } from "./fs-util.js";
import type { RunOutcome } from "./schema.js";

export const STATE_FILE = "state.json";
export const STATE_SCHEMA_VERSION = 2;

export type EndReason = "done" | "idle" | "max_rounds" | "lead_failed" | "cancelled";
export type MailLayout = "run" | "legacy";

export interface WakeTopic {
  from: string;
  type: string;
  subject: string;
  /** What the message is about, in one line. */
  brief?: string;
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
  /** Recovery remarks (interrupted attempts whose side effects may have happened). */
  notes?: string[];
  /** "worktree": non-lead agents work in their own git worktrees. */
  workspace_mode?: "shared" | "worktree";
  /** Agents whose finished work could not be brought into the repo yet; their work is kept on their branch. */
  blocked_integrations?: { agent: string; branch: string; reason: string; report: string }[];
  /** Snapshots of the repo taken so far (`refs/agent-team/<run>/base-<n>`). */
  snapshots?: number;
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
    end_reason: z.enum(["done", "idle", "max_rounds", "lead_failed", "cancelled"]).optional(),
    outcome: z.enum(["completed", "partial", "blocked", "failed", "cancelled"]).optional(),
    outcome_note: z.string().optional(),
    verification: z.string().optional(),
    done_rejections: nonNeg.optional(),
    notes: z.array(z.string()).optional(),
    sessions: z.record(z.string()).optional(),
    output_tokens: nonNeg.optional(),
    last_wake: z.record(z.any()).optional(),
    pid: z.number().optional(),
    task_summary: z.string().optional(),
    active: z.record(z.any()).optional(),
    wakes: z.array(z.any()).optional(),
    steps: z.array(z.object({ text: z.string(), done: z.boolean() })).optional(),
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
      `Run state ${file} uses schema_version ${parsed.data.schema_version}, newer than this agent-team understands (${STATE_SCHEMA_VERSION}). Upgrade agent-team.`,
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
  return { outcome: s.end_reason === "lead_failed" ? "failed" : s.end_reason === "cancelled" ? "cancelled" : "partial", verified: false };
}
