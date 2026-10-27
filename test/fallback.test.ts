import { describe, expect, it } from "vitest";
import type { ResolvedAgent } from "../src/config.js";
import {
  backoffMs,
  type Candidate,
  agentForCandidate,
  candidatesFor,
  Cooldowns,
  defaultSleep,
  nextStep,
  deferredAttempts,
  planAttempts,
  runWithFallback,
  type RunWithFallbackOptions,
} from "../src/fallback.js";
import type { ErrorKind, FallbackEntry } from "../src/schema.js";

const agentWith = (fallback: FallbackEntry[] = []): ResolvedAgent =>
  ({ name: "dev", runtime: "claude-code", model: "opus", effort: "high", fallback }) as unknown as ResolvedAgent;
const CHAIN: FallbackEntry[] = [
  { runtime: "claude-code", model: "sonnet" },
  { runtime: "codex", model: "", effort: "low" },
];

describe("candidatesFor", () => {
  it("puts the primary first, then the chain, keyed by runtime/model", () => {
    const cs = candidatesFor(agentWith(CHAIN));
    expect(cs).toEqual([
      { runtime: "claude-code", model: "opus", effort: "high", primary: true, key: "claude-code/opus" },
      { runtime: "claude-code", model: "sonnet", effort: undefined, primary: false, key: "claude-code/sonnet" },
      { runtime: "codex", model: undefined, effort: "low", primary: false, key: "codex/" },
    ]);
  });
  it("is only the primary without a chain", () => {
    expect(candidatesFor(agentWith()).map((c) => c.key)).toEqual(["claude-code/opus"]);
  });
  it("drops entries equal to the primary or to an earlier entry (a shared dispatcher.fallback chain)", () => {
    const a = { ...agentWith([{ runtime: "claude-code", model: "opus" }, { runtime: "claude-code", model: "haiku" }]), fallbackShared: true } as ResolvedAgent;
    expect(candidatesFor(a).map((c) => c.key)).toEqual(["claude-code/opus", "claude-code/haiku"]);
    const b = { ...agentWith(), model: "sonnet", fallback: [{ runtime: "claude-code", model: "sonnet" }, { runtime: "claude-code", model: "haiku" }] } as ResolvedAgent;
    expect(candidatesFor(b).map((c) => c.key)).toEqual(["claude-code/sonnet", "claude-code/haiku"]);
  });
  it("compares models trimmed and case-blind, with an empty model the same as none", () => {
    const a = {
      ...agentWith([
        { runtime: "claude-code", model: " Opus " },
        { runtime: "codex", model: "" },
        { runtime: "codex", model: "GPT-5" },
        { runtime: "codex", model: "gpt-5 " },
        { runtime: "codex", model: "" },
      ]),
    } as ResolvedAgent;
    const cs = candidatesFor(a);
    expect(cs.map((c) => c.key)).toEqual(["claude-code/opus", "codex/", "codex/gpt-5"]);
    expect(cs.map((c) => c.primary)).toEqual([true, false, false]);
    const none = { ...agentWith([{ runtime: "claude-code", model: "" }, { runtime: "codex", model: "" }]), model: undefined } as ResolvedAgent;
    expect(candidatesFor(none).map((c) => c.key)).toEqual(["claude-code/", "codex/"]);
  });
  it("is only the primary when every entry repeats it", () => {
    expect(candidatesFor(agentWith([{ runtime: "claude-code", model: "OPUS" }])).map((c) => c.key)).toEqual(["claude-code/opus"]);
  });
});

describe("agentForCandidate", () => {
  const as = (runtime: "claude-code" | "codex", allowWeb?: "none" | "search" | "fetch") =>
    ({ ...agentWith(), runtime, allowWeb, model: "m", effort: "high" }) as ResolvedAgent;
  const cand = (runtime: "claude-code" | "codex", primary = false) => ({ runtime, model: "b", effort: "low" as const, primary, key: `${runtime}/b` });
  it("returns the agent itself for the primary", () => {
    const a = as("claude-code");
    expect(agentForCandidate(a, cand("claude-code", true))).toBe(a);
  });
  it("swaps runtime, model and effort for a backup", () => {
    expect(agentForCandidate(as("claude-code"), cand("claude-code"))).toMatchObject({ runtime: "claude-code", model: "b", effort: "low", allowWeb: undefined });
  });
  it("inherits a set allow_web on any runtime", () => {
    for (const level of ["none", "search", "fetch"] as const) {
      expect(agentForCandidate(as("claude-code", level), cand("codex")).allowWeb).toBe(level);
      expect(agentForCandidate(as("codex", level), cand("claude-code")).allowWeb).toBe(level);
    }
  });
  it("turns web off for a codex backup of a claude-code agent with allow_web unset", () => {
    expect(agentForCandidate(as("claude-code"), cand("codex")).allowWeb).toBe("none");
  });
  it("keeps allow_web unset for a backup of a codex agent with it unset", () => {
    expect(agentForCandidate(as("codex"), cand("claude-code")).allowWeb).toBeUndefined();
    expect(agentForCandidate(as("codex"), cand("codex")).allowWeb).toBeUndefined();
  });
});

describe("nextStep", () => {
  const step = (kind: ErrorKind | undefined, n: number, hasNext = true, legacy = false) => nextStep(kind, n, 2, hasNext, legacy);
  it("moves on at once for rate_limit and quota, or stops at the end of the chain", () => {
    for (const k of ["rate_limit", "quota"] as const) {
      expect(step(k, 1)).toBe("next-candidate");
      expect(step(k, 1, false)).toBe("stop");
    }
  });
  it("retries timeout/network/crash `retry` times, then moves on or stops", () => {
    for (const k of ["timeout", "network", "crash"] as const) {
      expect(step(k, 1)).toBe("retry-same");
      expect(step(k, 2)).toBe("retry-same");
      expect(step(k, 3)).toBe("next-candidate");
      expect(step(k, 3, false)).toBe("stop");
    }
  });
  it("stops on auth", () => {
    expect(step("auth", 1)).toBe("stop");
  });
  it("retries unknown (and unclassified) `retry` times, then stops, never switching", () => {
    for (const k of ["unknown", undefined] as const) {
      expect(step(k, 1)).toBe("retry-same");
      expect(step(k, 2)).toBe("retry-same");
      expect(step(k, 3)).toBe("stop");
    }
  });
  it("legacy (no chain) retries every kind `retry` times, auth and rate_limit included", () => {
    for (const k of [...(["rate_limit", "quota", "timeout", "network", "crash", "auth", "unknown"] as const), undefined]) {
      expect(step(k, 1, false, true)).toBe("retry-same");
      expect(step(k, 2, false, true)).toBe("retry-same");
      expect(step(k, 3, false, true)).toBe("stop");
    }
  });
});

describe("backoffMs", () => {
  it("goes 5s, 15s, 45s, then caps at 60s", () => {
    expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual([5000, 15000, 45000, 60000, 60000]);
  });
});

describe("Cooldowns", () => {
  it("is active until it expires", () => {
    const c = new Cooldowns();
    c.mark("claude-code/opus", "rate_limit", 1000, 10);
    expect(c.active("claude-code/opus", 1000)).toBe(10000);
    expect(c.active("claude-code/opus", 6000)).toBe(5000);
    expect(c.active("claude-code/opus", 11000)).toBe(0);
    expect(c.active("codex/", 1000)).toBe(0);
  });
  it("does nothing for a zero cooldown and never shortens one", () => {
    const c = new Cooldowns();
    c.mark("k", "quota", 0, 0);
    expect(c.active("k", 0)).toBe(0);
    c.mark("k", "quota", 0, 100);
    c.mark("k", "rate_limit", 0, 10);
    expect(c.active("k", 0)).toBe(100000);
  });
  it("round-trips through JSON and tolerates a missing table", () => {
    const c = new Cooldowns();
    c.mark("claude-code/opus", "quota", Date.parse("2026-10-16T00:00:00.000Z"), 60);
    const json = c.toJSON();
    expect(json).toEqual({ "claude-code/opus": { until: "2026-10-16T00:01:00.000Z", kind: "quota" } });
    const back = Cooldowns.from(JSON.parse(JSON.stringify(json)));
    expect(back.active("claude-code/opus", Date.parse("2026-10-16T00:00:30.000Z"))).toBe(30000);
    expect(Cooldowns.from(undefined).toJSON()).toEqual({});
  });
});

describe("planAttempts", () => {
  it("skips candidates in cooldown", () => {
    const c = new Cooldowns();
    c.mark("claude-code/opus", "rate_limit", 0, 60);
    expect(planAttempts(candidatesFor(agentWith(CHAIN)), c, 1000).map((x) => x.key)).toEqual(["claude-code/sonnet", "codex/"]);
    expect(planAttempts(candidatesFor(agentWith(CHAIN)), c, 61000).map((x) => x.key)).toEqual(["claude-code/opus", "claude-code/sonnet", "codex/"]);
  });
  it("tries everything when everything is in cooldown", () => {
    const c = new Cooldowns();
    for (const x of candidatesFor(agentWith(CHAIN))) c.mark(x.key, "quota", 0, 60);
    expect(planAttempts(candidatesFor(agentWith(CHAIN)), c, 0).map((x) => x.key)).toEqual(["claude-code/opus", "claude-code/sonnet", "codex/"]);
  });
});

interface R {
  ok: boolean;
  kind?: ErrorKind;
  cancelled?: boolean;
  error?: string;
  tag?: string;
}
const ok = (tag = "ok"): R => ({ ok: true, tag });
const fail = (kind: ErrorKind | undefined, error = `${kind} error`): R => ({ ok: false, kind, error });

/** A driver run with scripted results per candidate key (consumed in order) and a recording sleep. */
function harness(agent: ResolvedAgent, script: Record<string, R[]>, extra: Partial<RunWithFallbackOptions<R>> = {}) {
  const calls: { key: string; attempt: number; candidateAttempt: number; previous?: R; switchedFrom?: string }[] = [];
  const sleeps: number[] = [];
  const switches: string[] = [];
  const cooldowns = extra.cooldowns ?? new Cooldowns();
  const candidates = extra.candidates ?? planAttempts(candidatesFor(agent), cooldowns, 0);
  const run = runWithFallback<R>({
    candidates,
    legacy: candidatesFor(agent).length === 1,
    retry: 2,
    cooldowns,
    cooldownSec: 300,
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    invoke: async (c, ctx) => {
      calls.push({ key: c.key, attempt: ctx.attempt, candidateAttempt: ctx.candidateAttempt, previous: ctx.previous, switchedFrom: ctx.switchedFrom?.key });
      const next = script[c.key]?.shift();
      if (!next) throw new Error(`no scripted result for ${c.key}`);
      return next;
    },
    onSwitch: (from, to, kind) => switches.push(`${from.key}->${to.key} (${kind})`),
    ...extra,
  });
  return { run, calls, sleeps, switches, cooldowns };
}

describe("deferredAttempts", () => {
  it("lists the cooling candidates, soonest to recover first", () => {
    const c = new Cooldowns();
    c.mark("claude-code/opus", "quota", 0, 100);
    c.mark("claude-code/sonnet", "rate_limit", 0, 30);
    expect(deferredAttempts(candidatesFor(agentWith(CHAIN)), c, 1000).map((x) => x.key)).toEqual(["claude-code/sonnet", "claude-code/opus"]);
    expect(deferredAttempts(candidatesFor(agentWith(CHAIN)), c, 200000)).toEqual([]);
  });
});

describe("runWithFallback", () => {
  it("returns the first success without retrying", async () => {
    const h = harness(agentWith(CHAIN), { "claude-code/opus": [ok()] });
    const out = await h.run;
    expect(out.result).toEqual(ok());
    expect(out.used.key).toBe("claude-code/opus");
    expect(out.tried).toEqual([]);
    expect(h.sleeps).toEqual([]);
  });

  it("switches at once on rate_limit, marks the cooldown and records what was tried", async () => {
    const h = harness(agentWith(CHAIN), { "claude-code/opus": [fail("rate_limit", "429")], "claude-code/sonnet": [ok("sonnet")] });
    const out = await h.run;
    expect(out.result.tag).toBe("sonnet");
    expect(out.used.key).toBe("claude-code/sonnet");
    expect(out.tried).toEqual([{ runtime: "claude-code", model: "opus", kind: "rate_limit", error: "429" }]);
    expect(h.switches).toEqual(["claude-code/opus->claude-code/sonnet (rate_limit)"]);
    expect(h.calls[1]).toMatchObject({ attempt: 1, candidateAttempt: 0, switchedFrom: "claude-code/opus", previous: fail("rate_limit", "429") });
    expect(h.sleeps).toEqual([]);
    expect(h.cooldowns.active("claude-code/opus", 0)).toBe(300000);
  });

  it("marks quota cooldowns on fallback candidates too", async () => {
    const h = harness(agentWith(CHAIN), { "claude-code/opus": [fail("quota")], "claude-code/sonnet": [fail("quota")], "codex/": [ok()] });
    await h.run;
    expect(Object.keys(h.cooldowns.toJSON())).toEqual(["claude-code/opus", "claude-code/sonnet"]);
  });

  it("retries timeout with backoff, then switches with a fresh retry budget", async () => {
    const h = harness(agentWith(CHAIN), {
      "claude-code/opus": [fail("timeout"), fail("network"), fail("crash")],
      "claude-code/sonnet": [fail("timeout"), ok("sonnet")],
    });
    const out = await h.run;
    expect(out.result.tag).toBe("sonnet");
    expect(h.calls.map((c) => [c.key, c.attempt, c.candidateAttempt])).toEqual([
      ["claude-code/opus", 0, 0],
      ["claude-code/opus", 1, 1],
      ["claude-code/opus", 2, 2],
      ["claude-code/sonnet", 3, 0],
      ["claude-code/sonnet", 4, 1],
    ]);
    expect(h.calls[1]?.previous).toEqual(fail("timeout"));
    expect(h.calls[1]?.switchedFrom).toBeUndefined();
    expect(h.sleeps).toEqual([5000, 15000, 5000]);
    expect(out.tried.map((t) => t.kind)).toEqual(["timeout", "network", "crash", "timeout"]);
    expect(h.switches).toEqual(["claude-code/opus->claude-code/sonnet (crash)"]);
    expect(h.cooldowns.toJSON()).toEqual({});
  });

  it("stops on auth without trying the chain", async () => {
    const h = harness(agentWith(CHAIN), { "claude-code/opus": [fail("auth", "not logged in")] });
    const out = await h.run;
    expect(out.result).toEqual(fail("auth", "not logged in"));
    expect(out.used.key).toBe("claude-code/opus");
    expect(h.calls).toHaveLength(1);
    expect(out.tried).toEqual([{ runtime: "claude-code", model: "opus", kind: "auth", error: "not logged in" }]);
  });

  it("retries unknown on the same model, then stops without switching", async () => {
    const h = harness(agentWith(CHAIN), { "claude-code/opus": [fail("unknown"), fail(undefined), fail("unknown", "last")] });
    const out = await h.run;
    expect(out.result.error).toBe("last");
    expect(h.calls.map((c) => c.key)).toEqual(["claude-code/opus", "claude-code/opus", "claude-code/opus"]);
    expect(h.switches).toEqual([]);
    expect(h.sleeps).toEqual([5000, 15000]);
  });

  it("returns the last failure when the whole chain fails", async () => {
    const h = harness(agentWith(CHAIN), { "claude-code/opus": [fail("rate_limit")], "claude-code/sonnet": [fail("quota")], "codex/": [fail("rate_limit", "end")] });
    const out = await h.run;
    expect(out.result.error).toBe("end");
    expect(out.used.key).toBe("codex/");
    expect(out.tried.map((t) => [t.runtime, t.model, t.kind])).toEqual([
      ["claude-code", "opus", "rate_limit"],
      ["claude-code", "sonnet", "quota"],
      ["codex", undefined, "rate_limit"],
    ]);
  });

  it("without a chain behaves like the old loop: retry times for every kind, no sleeps", async () => {
    for (const kind of ["auth", "rate_limit", "quota", "timeout", "unknown", undefined] as const) {
      const h = harness(agentWith(), { "claude-code/opus": [fail(kind), fail(kind), fail(kind, "last")] });
      const out = await h.run;
      expect(h.calls.map((c) => c.attempt)).toEqual([0, 1, 2]);
      expect(h.calls.map((c) => c.candidateAttempt)).toEqual([0, 1, 2]);
      expect(out.result.error).toBe("last");
      expect(h.sleeps).toEqual([]);
      expect(h.switches).toEqual([]);
      expect(h.cooldowns.toJSON()).toEqual({});
    }
  });

  it("without a chain succeeds on a retry", async () => {
    const h = harness(agentWith(), { "claude-code/opus": [fail("auth"), ok()] });
    const out = await h.run;
    expect(out.result.ok).toBe(true);
    expect(out.tried).toHaveLength(1);
  });

  it("ends at once on cancellation, mid-chain, without recording it", async () => {
    const h = harness(agentWith(CHAIN), { "claude-code/opus": [fail("rate_limit")], "claude-code/sonnet": [{ ok: false, cancelled: true }] });
    const out = await h.run;
    expect(out.result).toEqual({ ok: false, cancelled: true });
    expect(out.used.key).toBe("claude-code/sonnet");
    expect(out.tried.map((t) => t.model)).toEqual(["opus"]);
    expect(h.sleeps).toEqual([]);
  });

  it("stops when beforeAttempt says so, before invoking", async () => {
    const seen: number[] = [];
    const h = harness(agentWith(CHAIN), { "claude-code/opus": [fail("timeout")] }, {
      beforeAttempt: (_c, ctx) => {
        seen.push(ctx.attempt);
        return ctx.attempt === 1 ? "stop" : undefined;
      },
    });
    const out = await h.run;
    expect(out.stopped).toBe("beforeAttempt");
    expect(out.result).toEqual(fail("timeout"));
    expect(seen).toEqual([0, 1]);
    expect(h.calls).toHaveLength(1);
  });

  it("can stop before the first attempt, with no result", async () => {
    const h = harness(agentWith(CHAIN), {}, { beforeAttempt: () => "stop" });
    const out = await h.run;
    expect(out.stopped).toBe("beforeAttempt");
    expect(out.result).toBeUndefined();
    expect(out.used.key).toBe("claude-code/opus");
  });

  it("awaits afterAttempt for every invocation, including the cancelled one", async () => {
    const after: string[] = [];
    const h = harness(agentWith(CHAIN), { "claude-code/opus": [fail("timeout"), { ok: false, cancelled: true }] }, {
      // Asynchronous on purpose: the next attempt must wait for it.
      afterAttempt: async (c, r, ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        after.push(`${c.key}#${ctx.attempt}:${r.cancelled ? "cancelled" : (r.kind ?? "-")}`);
      },
      beforeAttempt: (c, ctx) => {
        after.push(`before ${c.key}#${ctx.attempt}`);
        return undefined;
      },
    });
    await h.run;
    expect(after).toEqual(["before claude-code/opus#0", "claude-code/opus#0:timeout", "before claude-code/opus#1", "claude-code/opus#1:cancelled"]);
  });

  it("uses the planned list, so a primary in cooldown is skipped and fallbacks still switch", async () => {
    const cooldowns = new Cooldowns();
    cooldowns.mark("claude-code/opus", "rate_limit", 0, 60);
    const h = harness(agentWith(CHAIN), { "claude-code/sonnet": [fail("quota")], "codex/": [ok("codex")] }, { cooldowns });
    const out = await h.run;
    expect(h.calls.map((c) => c.key)).toEqual(["claude-code/sonnet", "codex/"]);
    expect(out.result.tag).toBe("codex");
  });

  it("when every candidate is cooling down, still tries them all", async () => {
    const cooldowns = new Cooldowns();
    for (const c of candidatesFor(agentWith(CHAIN))) cooldowns.mark(c.key, "quota", 0, 60);
    const h = harness(agentWith(CHAIN), { "claude-code/opus": [fail("quota")], "claude-code/sonnet": [fail("quota")], "codex/": [ok()] }, { cooldowns });
    const out = await h.run;
    expect(h.calls.map((c) => c.key)).toEqual(["claude-code/opus", "claude-code/sonnet", "codex/"]);
    expect(out.result.ok).toBe(true);
  });

  it("stops as aborted when the signal fires during a backoff", async () => {
    const ac = new AbortController();
    const h = harness(agentWith(CHAIN), { "claude-code/opus": [fail("timeout")] }, {
      signal: ac.signal,
      sleep: async () => ac.abort(),
    });
    const out = await h.run;
    expect(out.stopped).toBe("aborted");
    expect(out.result).toEqual(fail("timeout"));
    expect(h.calls).toHaveLength(1);
  });

  it("throws without candidates", async () => {
    await expect(harness(agentWith(), {}, { candidates: [] as Candidate[] }).run).rejects.toThrow(/candidate/);
  });
});

describe("defaultSleep", () => {
  it("wakes early when the signal aborts", async () => {
    const ac = new AbortController();
    const t = Date.now();
    const p = defaultSleep(60_000, ac.signal);
    ac.abort();
    await p;
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it("returns at once for an already-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    await defaultSleep(60_000, ac.signal);
  });
  it("sleeps the given time otherwise", async () => {
    const t = Date.now();
    await defaultSleep(20);
    expect(Date.now() - t).toBeGreaterThanOrEqual(15);
  });
});

describe("runWithFallback with deferred candidates", () => {
  it("waits for a cooling backup to recover after the warm models fail on quota", async () => {
    const cooldowns = new Cooldowns();
    cooldowns.mark("claude-code/sonnet", "quota", 0, 30);
    const all = candidatesFor(agentWith(CHAIN));
    const waits: number[] = [];
    const h = harness(
      agentWith(CHAIN),
      { "claude-code/opus": [fail("quota")], "codex/": [fail("quota")], "claude-code/sonnet": [ok()] },
      { cooldowns, candidates: planAttempts(all, cooldowns, 0), deferred: deferredAttempts(all, cooldowns, 0), onCooldownWait: (_c, ms) => waits.push(ms) },
    );
    const out = await h.run;
    expect(out.result).toEqual(ok());
    expect(out.used.key).toBe("claude-code/sonnet");
    expect(h.calls.map((x) => x.key)).toEqual(["claude-code/opus", "codex/", "claude-code/sonnet"]);
    expect(h.sleeps).toEqual([30000]);
    expect(waits).toEqual([30000]);
  });
  it("does not wait when the deferred candidate has already recovered", async () => {
    const cooldowns = new Cooldowns();
    const all = candidatesFor(agentWith(CHAIN));
    const h = harness(agentWith(CHAIN), { "claude-code/opus": [fail("quota")], "claude-code/sonnet": [ok()] }, { cooldowns, candidates: [all[0] as Candidate], deferred: [all[1] as Candidate] });
    expect((await h.run).result).toEqual(ok());
    expect(h.sleeps).toEqual([]);
  });
  it("stops when the signal aborts during the wait", async () => {
    const cooldowns = new Cooldowns();
    cooldowns.mark("claude-code/sonnet", "quota", 0, 30);
    const all = candidatesFor(agentWith(CHAIN));
    const ac = new AbortController();
    const h = harness(agentWith(CHAIN), { "claude-code/opus": [fail("quota")] }, {
      cooldowns,
      candidates: [all[0] as Candidate],
      deferred: [all[1] as Candidate],
      signal: ac.signal,
      sleep: async () => ac.abort(),
    });
    const out = await h.run;
    expect(out.stopped).toBe("aborted");
    expect(h.calls.map((x) => x.key)).toEqual(["claude-code/opus"]);
  });
});
