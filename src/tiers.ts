import { TIERS, type Tier } from "./schema.js";

const norm = (m: string | undefined) => (m ?? "").trim().toLowerCase();

export function isTier(v: unknown): v is Tier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

/** Index of `model` on `ladder` (trim + lowercase, like the fallback keys), or -1. */
export function ladderIndex(ladder: readonly string[], model: string | undefined): number {
  const m = norm(model);
  return m ? ladder.findIndex((e) => norm(e) === m) : -1;
}

/**
 * The tiers an agent can run on: the ladder from its lowest entry up to and including `model` (the ceiling).
 * `undefined` when there is nothing below the ceiling (no ladder, no model, model not on it, or it is the lowest entry).
 */
export function availableTiers(ladder: readonly string[] | undefined, model: string | undefined): string[] | undefined {
  if (!ladder?.length) return undefined;
  const i = ladderIndex(ladder, model);
  return i >= 1 ? ladder.slice(0, i + 1) : undefined;
}

/** `low` = lowest, `high` = ceiling, `mid` = `tiers[floor(n/2)]` (the higher middle when n is even). */
export function modelForTier(tiers: readonly string[], tier: Tier): string {
  const n = tiers.length;
  return tiers[tier === "low" ? 0 : tier === "high" ? n - 1 : Math.floor(n / 2)] as string;
}

export type TierFlag = "absent" | "invalid" | Tier | { ignored: "not-lead" | "not-a-task" | "no-tiers" };

/** Judge the `tier` frontmatter of one outgoing mail, in the order of spec 24.5.2. Not wired anywhere yet. */
export function tierFlag(i: { value: unknown; senderIsLead: boolean; type: string; recipientTiers?: string[] }): TierFlag {
  if (i.value === undefined || i.value === null || i.value === "") return "absent";
  if (!i.senderIsLead) return { ignored: "not-lead" };
  if (!isTier(i.value)) return "invalid";
  if (i.type !== "task") return { ignored: "not-a-task" };
  if (!i.recipientTiers || i.recipientTiers.length < 2) return { ignored: "no-tiers" };
  return i.value;
}

/** A mail without a valid tier counts as `high` (the ceiling). */
export function effectiveTier(meta: { tier?: unknown }): Tier {
  return isTier(meta.tier) ? meta.tier : "high";
}

/** The tier a wake runs at: the highest of the batch when every mail has a valid one, else `undefined` (the ceiling). */
export function wakeTier(tiers: readonly unknown[]): Tier | undefined {
  if (tiers.length === 0 || !tiers.every(isTier)) return undefined;
  return TIERS[Math.max(...tiers.map((t) => TIERS.indexOf(t)))];
}
