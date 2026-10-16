import type { ResolvedAgent } from "./config.js";
import type { Effort, ErrorKind, Runtime } from "./schema.js";

/** One model a wake may run on: the agent's own (`primary`) or a link of its fallback chain. */
export interface Candidate {
  runtime: Runtime;
  /** Unset = the runtime's own default model. */
  model?: string;
  effort?: Effort;
  primary: boolean;
  /** `<runtime>/<model>`; the cooldown and session key. */
  key: string;
}

const keyOf = (runtime: Runtime, model: string | undefined) => `${runtime}/${model ?? ""}`;

/** The primary model followed by the agent's fallback chain, in order. */
export function candidatesFor(agent: ResolvedAgent): Candidate[] {
  // `validate` refuses an agent without a runtime before anything is woken.
  const runtime = agent.runtime as Runtime;
  const primary: Candidate = { runtime, model: agent.model, effort: agent.effort, primary: true, key: keyOf(runtime, agent.model) };
  return [
    primary,
    ...agent.fallback.map((f) => {
      const model = f.model || undefined;
      return { runtime: f.runtime, model, effort: f.effort, primary: false, key: keyOf(f.runtime, model) };
    }),
  ];
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
export function planAttempts(agent: ResolvedAgent, cooldowns: Cooldowns, now: number): Candidate[] {
  const all = candidatesFor(agent);
  const warm = all.filter((c) => cooldowns.active(c.key, now) === 0);
  return warm.length ? warm : all;
}

export type Step = "retry-same" | "next-candidate" | "stop";

/**
 * What to do after a failed call (spec 20.2 decisions 2 and 5). `attemptsOnCurrent` counts the calls made on the current
 * candidate, the failed one included; each candidate gets `retry` retries. `legacy` (the agent has no fallback chain)
 * keeps the old loop: every kind is retried `retry` times, then the wake fails.
 */
export function nextStep(kind: ErrorKind | undefined, attemptsOnCurrent: number, retry: number, hasNext: boolean, legacy: boolean): Step {
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
