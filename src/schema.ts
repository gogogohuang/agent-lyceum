import { z } from "zod";

export const RUNTIMES = ["claude-code", "codex"] as const;
export type Runtime = (typeof RUNTIMES)[number];

/** Union of both runtimes' levels; `validate` rejects the ones a given runtime does not accept. */
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Levels each runtime's CLI accepts (`claude --effort`, codex `model_reasoning_effort`). */
export const RUNTIME_EFFORTS: Record<Runtime, readonly Effort[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

/** Guess the runtime from a model name: Claude aliases/IDs -> claude-code, GPT/o-series/codex names -> codex. */
export function inferRuntime(model: string | undefined): Runtime | undefined {
  if (!model) return undefined;
  const m = model.trim().toLowerCase();
  if (/^(claude|anthropic|opus|sonnet|haiku|fable|best|default|opusplan)\b/.test(m) || m.includes("claude")) return "claude-code";
  if (/^(gpt|codex|o\d)/.test(m) || m.includes("codex")) return "codex";
  return undefined;
}

/** How much of the web an agent may use: nothing, search only, or search plus fetching pages. Unset leaves each runtime's own default alone. */
export const WEB_LEVELS = ["none", "search", "fetch"] as const;
export type WebLevel = (typeof WEB_LEVELS)[number];

/** Why a wake failed, as far as the CLI's output reveals; decides whether to retry, fall back, or stop. */
export const ERROR_KINDS = ["rate_limit", "quota", "timeout", "network", "crash", "auth", "unknown"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** One link of a fallback chain after resolution: runtime and model are filled in (model "" = the runtime's own default). */
export interface FallbackEntry {
  runtime: Runtime;
  model: string;
  effort?: Effort;
}

/**
 * What each adapter can guarantee, read off `buildClaudeSettings`/`buildCodexInvocation` and `enforcementFor`:
 * - allow_web: claude-code maps none/search/fetch to its WebSearch/WebFetch tools, codex to `web_search` disabled/cached/live.
 * - can_ask_user: mail-level (`mailbox.ts`), no runtime involved.
 * - worktree: the adapter only runs in `repoDirFor(...)`, so both honour a per-agent worktree.
 * - writeScope: best level reachable with the OS sandbox; without it claude-code falls back to tool rules, codex to prompt-only/post-hoc.
 */
export interface RuntimeCaps {
  webLevels: WebLevel[];
  canAskUser: boolean;
  worktree: boolean;
  writeScope: "os";
}

export const RUNTIME_CAPS: Record<Runtime, RuntimeCaps> = {
  "claude-code": { webLevels: ["none", "search", "fetch"], canAskUser: true, worktree: true, writeScope: "os" },
  codex: { webLevels: ["none", "search", "fetch"], canAskUser: true, worktree: true, writeScope: "os" },
};

const Memory = z
  .object({
    global: z.string().optional(),
    project: z.string().optional(),
  })
  .strict();

/** A fallback entry as written in a file: `runtime` may be omitted (inferred from `model`, else the agent's). */
export const FallbackEntryPartial = z
  .object({
    runtime: z.enum(RUNTIMES).optional(),
    model: z.string().optional(),
    effort: z.enum(EFFORTS).optional(),
  })
  .strict();
export type FallbackEntryPartialT = z.infer<typeof FallbackEntryPartial>;

export const AgentPartial = z
  .object({
    runtime: z.enum(RUNTIMES).optional(),
    model: z.string().optional(),
    effort: z.enum(EFFORTS).optional(),
    agent_md: z.string().optional(),
    memory: Memory.optional(),
    resume: z.boolean().optional(),
    can_message: z.union([z.literal("all"), z.array(z.string())]).optional(),
    can_edit_agent_md: z.boolean().optional(),
    can_ask_user: z.boolean().optional(),
    allow_web: z.enum(WEB_LEVELS).optional(),
    fallback: z.array(FallbackEntryPartial).optional(),
    /** Removed setting: still accepted (any value) so old files load; ignored, with a warning from `validate`. */
    owns: z.unknown().optional(),
  })
  .strict();
export type AgentPartialT = z.infer<typeof AgentPartial>;

export const DispatcherPartial = z
  .object({
    max_rounds: z.number().int().min(0).optional(),
    max_parallel: z.unknown().optional(),
    max_concurrent_runs: z.unknown().optional(),
    wake_timeout_sec: z.number().int().positive().optional(),
    retry: z.number().int().min(0).optional(),
    strict: z.boolean().optional(),
    workspace_mode: z.unknown().optional(),
    log_max_bytes: z.number().int().min(0).optional(),
    fallback: z.array(FallbackEntryPartial).optional(),
    fallback_cooldown_sec: z.number().int().min(0).optional(),
  })
  .strict();

/** Settings that no longer exist; files that still carry them load, and `validate` warns. */
export const REMOVED_DISPATCHER_KEYS = ["max_parallel", "max_concurrent_runs", "workspace_mode"] as const;
export const REMOVED_AGENT_KEYS = ["owns"] as const;

export const GlobalConfig = z
  .object({
    agents: z.record(z.string(), AgentPartial).default({}),
  })
  .strict();

export const ProjectConfig = z
  .object({
    dir: z.string(),
    team: z.object({ lead: z.string() }).strict(),
    dispatcher: DispatcherPartial.default({}),
    agents: z.record(z.string(), AgentPartial).default({}),
  })
  .strict();

export interface DispatcherSettings {
  max_rounds: number;
  wake_timeout_sec: number;
  retry: number;
  strict: boolean;
  /** log.jsonl is rotated to log.1.jsonl past this size; 0 = never. */
  log_max_bytes: number;
  /** How long a primary that hit rate_limit/quota is skipped within a run, unless the CLI says when to come back. */
  fallback_cooldown_sec: number;
}

export const DISPATCHER_DEFAULTS: DispatcherSettings = {
  max_rounds: 0,
  wake_timeout_sec: 600,
  retry: 2,
  strict: false,
  log_max_bytes: 8 * 1024 * 1024,
  fallback_cooldown_sec: 300,
};

/** How a run turned out, independent of why it stopped (`EndReason`). Only "completed" means success. */
export const RUN_OUTCOMES = ["completed", "partial", "blocked", "failed", "waiting", "cancelled"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export function exitCodeForOutcome(outcome: RunOutcome): 0 | 1 | 2 | 3 | 130 {
  switch (outcome) {
    case "completed":
      return 0;
    case "failed":
      return 1;
    case "waiting":
      return 3;
    case "cancelled":
      return 130;
    default:
      return 2;
  }
}
