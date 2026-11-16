import type { QuotaReport } from "../types";

export type Tone = "ok" | "mid" | "low";

/** Same thresholds as slack-dispatcher's LimitsBar: under half is a warning, under a fifth is nearly out. */
export function allowanceTone(remainingPercent: number): Tone {
  if (remainingPercent < 20) return "low";
  if (remainingPercent < 50) return "mid";
  return "ok";
}

/** Bar width and big number: whole percent, clamped to 0–100. */
export function wholePercent(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function runtimeName(runtime: QuotaReport["runtime"]): string {
  return runtime === "claude" ? "Claude" : "Codex";
}

/** Claude first, Codex second, so the two columns never swap places between reads. */
export function orderReports(reports: QuotaReport[]): QuotaReport[] {
  const rank = (runtime: QuotaReport["runtime"]) => (runtime === "claude" ? 0 : 1);
  return [...reports].sort((a, b) => rank(a.runtime) - rank(b.runtime));
}
