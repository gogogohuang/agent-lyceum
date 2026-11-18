import type { ResolvedAgent } from "../config.js";

/** The only inherited variables an approval-enrolled agent gets. `USER` is needed for the macOS login (spec section 8). */
export const ENROLLED_ENV_KEYS = ["PATH", "HOME", "LANG", "TERM", "TMPDIR", "USER"] as const;

/**
 * The environment of a wake-up. Enrolled: exactly the present subset of the whitelist (empty strings kept, nothing added, no identity variable).
 * Everyone else: unchanged, `...source` plus the identity the fake runtimes read.
 */
export function runtimeEnv(agent: Pick<ResolvedAgent, "name" | "enrolled">, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!agent.enrolled) return { ...source, AGENT_LYCEUM_AGENT: agent.name };
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENROLLED_ENV_KEYS) if (source[k] !== undefined) env[k] = source[k];
  return env;
}
