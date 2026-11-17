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
  if (runtime === "claude") return "Claude";
  if (runtime === "codex") return "Codex";
  return "Cursor";
}

/** Claude, Codex, then Cursor — fixed column order between reads. */
export function orderReports(reports: QuotaReport[]): QuotaReport[] {
  const rank = (runtime: QuotaReport["runtime"]) => (runtime === "claude" ? 0 : runtime === "codex" ? 1 : 2);
  return [...reports].sort((a, b) => rank(a.runtime) - rank(b.runtime));
}
