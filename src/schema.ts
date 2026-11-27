import { z } from "zod";

export const RUNTIMES = ["claude-code", "codex", "cursor"] as const;
export type Runtime = (typeof RUNTIMES)[number];

/** Union of both runtimes' levels; `validate` rejects the ones a given runtime does not accept. */
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Levels each runtime's CLI accepts (`claude --effort`, codex `model_reasoning_effort`). */
export const RUNTIME_EFFORTS: Record<Runtime, readonly Effort[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  cursor: [],
};

export function isGrokModel(model: string | undefined): boolean {
  return !!model && model.trim().toLowerCase().startsWith("grok");
}

/** Guess the runtime from a model name: Claude aliases/IDs -> claude-code, GPT/o-series/codex names -> codex. */
export function inferRuntime(model: string | undefined): Runtime | undefined {
  if (!model) return undefined;
  const m = model.trim().toLowerCase();
  if (/^(claude|anthropic|opus|sonnet|haiku|fable|best|default|opusplan)\b/.test(m) || m.includes("claude")) return "claude-code";
  if (/^(gpt|codex|o\d)/.test(m) || m.includes("codex")) return "codex";
  if (isGrokModel(m)) return "cursor";
  return undefined;
}

/** How much of the web an agent may use: nothing, search only, or search plus fetching pages. Unset leaves each runtime's own default alone. */
export const WEB_LEVELS = ["none", "search", "fetch"] as const;
export type WebLevel = (typeof WEB_LEVELS)[number];

/** Why a wake failed, as far as the CLI's output reveals; decides whether to retry, fall back, or stop. */
export const ERROR_KINDS = ["rate_limit", "quota", "timeout", "network", "crash", "auth", "config", "unknown"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** One link of a fallback chain after resolution: runtime and model are filled in (model "" = the runtime's own default). */
export interface FallbackEntry {
  runtime: Runtime;
  model: string;
  effort?: Effort;
}

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

const DOMAIN_RE = /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Per-agent sandbox allowances (spec 25); every key is optional and absent = none. */
export const SandboxPartial = z
  .object({
    write: z.array(z.string().trim().min(1)).optional(),
    network: z
      .array(z.string().trim().toLowerCase().regex(DOMAIN_RE, "expected a host name like registry.npmjs.org or *.example.com (no scheme, port, path or IP)"))
      .optional(),
    local_binding: z.boolean().optional(),
    unix_sockets: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();
export type SandboxPartialT = z.infer<typeof SandboxPartial>;

/** Per-agent ship tool (search/replace + verify + rollback). `true` = on with defaults; object may set verify. */
export const ShipPartial = z.union([
  z.boolean(),
  z
    .object({
      verify: z.string().min(1).optional(),
      timeout_sec: z.number().int().min(1).max(7200).optional(),
    })
    .strict(),
]);
export type ShipPartialT = z.infer<typeof ShipPartial>;

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
    /** Exact MCP tool names (`mcp__<server>__<tool>`) the agent may call without a prompt (Claude Code only). No wildcards, so write tools stay out unless named. */
    allow_mcp: z.array(z.string().regex(/^mcp__[\w.-]+__[\w.-]+$/, "must be an exact MCP tool name like mcp__<server>__<tool> (no wildcards)")).optional(),
    fallback: z.array(FallbackEntryPartial).optional(),
    sandbox: SandboxPartial.optional(),
    /** Opt-in: wake writes a ship session and documents the `agent-lyceum ship` CLI (Claude Code and Codex). */
    ship: ShipPartial.optional(),
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
    /** Most instances of one role at a time (spec 23); 1 turns parallel tasks off. Unset = `DEFAULT_MAX_INSTANCES`. */
    max_instances: z.number().int().min(1).max(8).optional(),
    /** Most non-lead agents woken in one worktree round. Unset = `DEFAULT_MAX_AWAKE`. */
    max_awake: z.number().int().min(1).max(16).optional(),
  })
  .strict();

/** Settings that no longer exist; files that still carry them load, and `validate` warns. */
export const REMOVED_DISPATCHER_KEYS = ["max_parallel", "max_concurrent_runs", "workspace_mode"] as const;
export const REMOVED_AGENT_KEYS = ["owns"] as const;

/** One runtime's model ladder, lowest first; `[]` = no ladder for that runtime (overrides team.yaml). */
export const ModelTiersPartial = z
  .object({
    "claude-code": z.array(z.string().trim().min(1)).optional(),
    codex: z.array(z.string().trim().min(1)).optional(),
    cursor: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

export const TIERS = ["low", "mid", "high"] as const;
export type Tier = (typeof TIERS)[number];

export const GlobalConfig = z
  .object({
    model_tiers: ModelTiersPartial.optional(),
    agents: z.record(z.string(), AgentPartial).default({}),
  })
  .strict();

/** Spec 27: commands the dispatcher runs before it accepts a lead's `completed` done. Only the user writes them (project.yaml). */
export const VerifyCommandPartial = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/, "must be lowercase letters, digits and '-'"),
    run: z.string().min(1),
    timeout_sec: z.number().int().min(1).max(7200).optional(),
  })
  .strict();

export const VerifyPartial = z
  .object({
    max_rejections: z.number().int().min(0).max(5).optional(),
    /** When true, a completed done is partial unless every check named in the task is already a verify command. */
    bind_task: z.boolean().optional(),
    commands: z.array(VerifyCommandPartial).default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.commands.forEach((c, i) => {
      if (seen.has(c.name)) ctx.addIssue({ code: "custom", path: ["commands", i, "name"], message: `"${c.name}" is used twice; names must be unique` });
      seen.add(c.name);
    });
  });

export interface VerifySettings {
  max_rejections: number;
  /** Compare the task's Verification section to `commands`. Default false. */
  bind_task: boolean;
  commands: { name: string; run: string; timeout_sec: number }[];
}
export const VERIFY_DEFAULTS = { max_rejections: 2, timeout_sec: 600 } as const;

export const ProjectConfig = z
  .object({
    dir: z.string(),
    team: z.object({ lead: z.string() }).strict(),
    model_tiers: ModelTiersPartial.optional(),
    verify: VerifyPartial.optional(),
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
  /** Most instances of one role at a time. Not in `DISPATCHER_DEFAULTS`, so `doctor --resolved` lists it only when written; the default lives in `instances.ts`. */
  max_instances?: number;
  /** Most non-lead agents woken in one worktree round. Not in `DISPATCHER_DEFAULTS`; the default lives in `wake-cap.ts`. */
  max_awake?: number;
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
