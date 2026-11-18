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

/** Display name and column order per runtime; a Record so a new runtime fails type-checking until it is listed. */
const RUNTIME_VIEW: Record<QuotaReport["runtime"], { name: string; rank: number }> = {
  claude: { name: "Claude", rank: 0 },
  codex: { name: "Codex", rank: 1 },
  cursor: { name: "Cursor", rank: 2 },
};

export function runtimeName(runtime: QuotaReport["runtime"]): string {
  return RUNTIME_VIEW[runtime].name;
}

/** Claude, Codex, then Cursor — fixed column order between reads. */
export function orderReports(reports: QuotaReport[]): QuotaReport[] {
  return [...reports].sort((a, b) => RUNTIME_VIEW[a.runtime].rank - RUNTIME_VIEW[b.runtime].rank);
}
