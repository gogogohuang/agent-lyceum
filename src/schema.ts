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

const Memory = z
  .object({
    global: z.string().optional(),
    project: z.string().optional(),
  })
  .strict();

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
    owns: z.array(z.string()).optional(),
  })
  .strict();
export type AgentPartialT = z.infer<typeof AgentPartial>;

export const DispatcherPartial = z
  .object({
    max_rounds: z.number().int().positive().optional(),
    max_parallel: z.number().int().positive().optional(),
    wake_timeout_sec: z.number().int().positive().optional(),
    retry: z.number().int().min(0).optional(),
    strict: z.boolean().optional(),
  })
  .strict();

export const GlobalConfig = z
  .object({
    agents: z.record(AgentPartial).default({}),
  })
  .strict();

export const ProjectConfig = z
  .object({
    dir: z.string(),
    team: z.object({ lead: z.string() }).strict(),
    dispatcher: DispatcherPartial.default({}),
    agents: z.record(AgentPartial).default({}),
  })
  .strict();

export interface DispatcherSettings {
  max_rounds: number;
  max_parallel: number;
  wake_timeout_sec: number;
  retry: number;
  strict: boolean;
}

export const DISPATCHER_DEFAULTS: DispatcherSettings = {
  max_rounds: 30,
  max_parallel: 1,
  wake_timeout_sec: 600,
  retry: 1,
  strict: false,
};
