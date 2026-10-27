import type { ResolvedAgent } from "./config.js";
import type { Effort, ErrorKind, Runtime } from "./schema.js";

/** One model a wake may run on: the agent's own (`primary`) or a link of its fallback chain. */
export interface Candidate {
  runtime: Runtime;
  /** Unset = the runtime's own default model. */
  model?: string;
  effort?: Effort;
  primary: boolean;
  /** The cheaper model a lead's `tier` picked (spec 24.7): not the primary, and not a fallback either. */
  tiered?: true;
  /** `<runtime>/<model>`; the cooldown and session key. */
  key: string;
}

/** `<runtime>/<model>`, the model trimmed and lowercased (no model = ""), so entries naming the same model share one key. */
const keyOf = (runtime: Runtime, model: string | undefined) => `${runtime}/${(model ?? "").trim().toLowerCase()}`;

/**
 * The primary model followed by the agent's fallback chain, in order. An entry with the same key as the primary or as an
 * earlier entry is dropped: a chain shared through `dispatcher.fallback` may list the agent's own primary (spec 20.12).
 */
export function candidatesFor(agent: ResolvedAgent, tierModel?: string): Candidate[] {
  // `validate` refuses an agent without a runtime before anything is woken.
  const runtime = agent.runtime as Runtime;
  const primary: Candidate = { runtime, model: agent.model, effort: agent.effort, primary: true, key: keyOf(runtime, agent.model) };
  const out = [primary];
  const seen = new Set([primary.key]);
  // A tier's cheaper model goes first (spec 24.7.1); one that is the ceiling itself adds nothing.
  if (tierModel && keyOf(runtime, tierModel) !== primary.key) {
    const key = keyOf(runtime, tierModel);
    out.unshift({ runtime, model: tierModel, effort: agent.effort, primary: false, tiered: true, key });
    seen.add(key);
  }
  for (const f of agent.fallback) {
    const model = f.model || undefined;
    const key = keyOf(f.runtime, model);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ runtime: f.runtime, model, effort: f.effort, primary: false, key });
  }
  return out;
}

/**
 * The agent as it runs on candidate `c`: itself for the primary; for a backup, the same agent on the backup's runtime, model
 * and effort, at the primary's effective web level (spec 20.12). A set `allow_web` carries over. Unset, claude-code has no web
 * tools while codex keeps its own default, which may search: a codex backup of such an agent gets `none`.
 */
export function agentForCandidate(agent: ResolvedAgent, c: Candidate): ResolvedAgent {
  if (c.primary) return agent;
  if (c.tiered) return { ...agent, model: c.model };
  const allowWeb = agent.allowWeb ?? (agent.runtime === "claude-code" && c.runtime === "codex" ? "none" : undefined);
  return { ...agent, runtime: c.runtime, model: c.model, effort: c.effort, allowWeb };
}

/** Models that failed with `rate_limit`/`quota`, and until when (epoch ms) wakes skip them. Shared by a run, kept in `state.json`. */
export class Cooldowns {
  private table = new Map<string, { until: number; kind: ErrorKind }>();

  /** Cool `key` down for `sec` seconds from `now`; never shortens a longer cooldown already in place. */
  mark(key: string, kind: ErrorKind, now: number, sec: number): void {
    if (sec <= 0) return;
    const until = now + sec * 1000;
    if ((this.table.get(key)?.until ?? 0) >= until) return;
    this.table.set(key, { until, kind });
  }

  /** Milliseconds of cooldown left for `key` at `now`; 0 = none. */
  active(key: string, now: number): number {
    const until = this.table.get(key)?.until ?? 0;
    return Math.max(0, until - now);
  }

  toJSON(): Record<string, { until: string; kind: ErrorKind }> {
    return Object.fromEntries([...this.table].map(([k, v]) => [k, { until: new Date(v.until).toISOString(), kind: v.kind }]));
  }

  /** Rebuild from `toJSON()` output; a missing table (older `state.json`) is an empty one. */
  static from(json?: Record<string, { until: string; kind: ErrorKind }>): Cooldowns {
    const c = new Cooldowns();
    for (const [k, v] of Object.entries(json ?? {})) {
      const until = Date.parse(v.until);
      if (Number.isFinite(until)) c.table.set(k, { until, kind: v.kind });
    }
    return c;
  }
}

/** The candidates for one wake: the chain minus those cooling down, or the whole chain when every one is (something must be tried). */
export function planAttempts(all: readonly Candidate[], cooldowns: Cooldowns, now: number): Candidate[] {
  const warm = all.filter((c) => cooldowns.active(c.key, now) === 0);
  return warm.length ? warm : [...all];
}

export type Step = "retry-same" | "next-candidate" | "stop";

/**
 * What to do after a failed call (spec 20.2 decisions 2 and 5). `attemptsOnCurrent` counts the calls made on the current
 * candidate, the failed one included; each candidate gets `retry` retries. `legacy` (the agent has no fallback chain)
 * keeps the old loop: every kind is retried `retry` times, then the wake fails.
 */
export function nextStep(kind: ErrorKind | undefined, attemptsOnCurrent: number, retry: number, hasNext: boolean, legacy: boolean): Step {
  // A refused configuration cannot get better by trying again or on another model (spec 25.19.1).
  if (kind === "config") return "stop";
  const retriesLeft = attemptsOnCurrent <= retry;
  if (legacy) return retriesLeft ? "retry-same" : "stop";
  switch (kind) {
    case "rate_limit":
    case "quota":
      return hasNext ? "next-candidate" : "stop";
    case "timeout":
    case "network":
    case "crash":
      return retriesLeft ? "retry-same" : hasNext ? "next-candidate" : "stop";
    case "auth":
      return "stop";
    default:
      // `unknown` and unclassified failures: same model only, as before fallback existed.
      return retriesLeft ? "retry-same" : "stop";
  }
}

/** Wait before the `n`th retry (1-based) on the same candidate: 5s, 15s, 45s, then 60s. */
export function backoffMs(n: number): number {
  return Math.min(5 * 3 ** (n - 1), 60) * 1000;
}

/** `setTimeout` as a promise that resolves early (never rejects) when `signal` aborts. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** What the driver needs to know about a call's result. */
export interface AttemptResult {
  ok: boolean;
  kind?: ErrorKind;
  cancelled?: boolean;
  error?: string;
}

export interface AttemptCtx<R> {
  /** Calls made so far in this wake, across candidates (0 = the first). */
  attempt: number;
  /** Calls made so far on this candidate; restarts at 0 on a switch. */
  candidateAttempt: number;
  /** The previous call's failed result, for a retry prompt. */
  previous?: R;
  /** Set on the first call after switching: the candidate given up on. */
  switchedFrom?: Candidate;
}

/** A failed call, in order, for `failure.tried`. */
export interface Tried {
  runtime: Runtime;
  model?: string;
  kind?: ErrorKind;
  error?: string;
}

export interface RunWithFallbackOptions<R extends AttemptResult> {
  /** From `planAttempts`; tried in order. */
  candidates: Candidate[];
  /** The agent has no fallback chain (see `nextStep`): no backoff, no cooldowns. */
  legacy: boolean;
  /** Retries per candidate (`dispatcher.retry`). */
  retry: number;
  /** Marked on `rate_limit`/`quota` failures. */
  cooldowns: Cooldowns;
  cooldownSec: number;
  invoke(candidate: Candidate, ctx: AttemptCtx<R>): Promise<R>;
  /** Runs before each call; "stop" ends the loop without calling (e.g. the round limit). */
  beforeAttempt?(candidate: Candidate, ctx: AttemptCtx<R>): "stop" | undefined;
  /** Runs after each call, awaited before the next decision. */
  afterAttempt?(candidate: Candidate, result: R, ctx: AttemptCtx<R>): void | Promise<void>;
  onSwitch?(from: Candidate, to: Candidate, kind: ErrorKind | undefined, result: R): void;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  now?(): number;
  signal?: AbortSignal;
}

export interface FallbackOutcome<R> {
  /** The last call's result; undefined only when stopped before the first call. */
  result: R | undefined;
  tried: Tried[];
  /** The candidate of the last call (or the first one, when none was made). */
  used: Candidate;
  /** Why the loop ended without a final verdict from a call: `beforeAttempt` said stop, or the signal aborted during a backoff. */
  stopped?: "beforeAttempt" | "aborted";
}

/**
 * The one retry/fallback loop shared by `RunSession.wake` and `call` (spec 20.2 decision 9): call each candidate,
 * retry it or move on as `nextStep` says, back off between retries. Success and cancellation end the loop as they are.
 */
export async function runWithFallback<R extends AttemptResult>(o: RunWithFallbackOptions<R>): Promise<FallbackOutcome<R>> {
  const first = o.candidates[0];
  if (!first) throw new Error("runWithFallback needs at least one candidate");
  const sleep = o.sleep ?? defaultSleep;
  const now = o.now ?? Date.now;
  const tried: Tried[] = [];
  let index = 0;
  let used = first;
  let ctx: AttemptCtx<R> = { attempt: 0, candidateAttempt: 0 };
  let result: R | undefined;
  for (;;) {
    if (o.beforeAttempt?.(used, ctx) === "stop") return { result, tried, used, stopped: "beforeAttempt" };
    result = await o.invoke(used, ctx);
    await o.afterAttempt?.(used, result, ctx);
    if (result.ok || result.cancelled) return { result, tried, used };
    tried.push({ runtime: used.runtime, model: used.model, kind: result.kind, error: result.error });
    if (!o.legacy && (result.kind === "rate_limit" || result.kind === "quota")) o.cooldowns.mark(used.key, result.kind, now(), o.cooldownSec);
    const next = o.candidates[index + 1];
    const step = nextStep(result.kind, ctx.candidateAttempt + 1, o.retry, !!next, o.legacy);
    if (step === "stop") return { result, tried, used };
    if (step === "retry-same") {
      if (!o.legacy) {
        await sleep(backoffMs(ctx.candidateAttempt + 1), o.signal);
        if (o.signal?.aborted) return { result, tried, used, stopped: "aborted" };
      }
      ctx = { attempt: ctx.attempt + 1, candidateAttempt: ctx.candidateAttempt + 1, previous: result };
      continue;
    }
    const to = next as Candidate;
    o.onSwitch?.(used, to, result.kind, result);
    ctx = { attempt: ctx.attempt + 1, candidateAttempt: 0, previous: result, switchedFrom: used };
    index++;
    used = to;
  }
}
