import type { MessageType } from "./mailbox.js";
import { type RunOutcome } from "./schema.js";

/** Required `##` sections per message type. `done` and `failure` are exempt. */
export const REQUIRED_SECTIONS: Partial<Record<MessageType, string[]>> = {
  task: ["Goal", "Acceptance criteria", "Scope", "Upstream"],
  reply: ["Changes", "Verification", "Open items", "Risks"],
};

/** Required sections that have no Markdown heading in `body` (case-insensitive, any heading level). */
export function missingSections(type: MessageType, body: string): string[] {
  const required = REQUIRED_SECTIONS[type];
  if (!required) return [];
  const headings = new Set(
    [...body.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*:?[ \t]*#*[ \t]*$/gm)].map((m) => m[1].trim().toLowerCase()),
  );
  return required.filter((s) => !headings.has(s.toLowerCase()));
}

export function formatWarning(type: MessageType, missing: string[]): string {
  return `[agent-team] Format warning: this ${type} is missing required section(s): ${missing.map((s) => `\`## ${s}\``).join(", ")}.`;
}

export interface Step {
  text: string;
  done: boolean;
}

/** Checklist items (`- [ ] x` / `- [x] x`). With `section`, only those under a `## Steps` heading; otherwise the whole text. */
export function parseSteps(body: string, section = true): Step[] {
  let text = body;
  if (section) {
    const m = /^#{1,6}[ \t]+steps[ \t]*:?[ \t]*#*[ \t]*$/im.exec(body);
    if (!m) return [];
    const rest = body.slice(m.index + m[0].length);
    const next = /^#{1,6}[ \t]+\S/m.exec(rest);
    text = next ? rest.slice(0, next.index) : rest;
  }
  return [...text.matchAll(/^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+(.+?)[ \t]*$/gm)].map((m) => ({
    text: m[2],
    done: m[1] !== " ",
  }));
}

/** One line saying what a message is about: the first line under Changes/Goal, else its first prose line. */
export function briefOf(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const clean = (l: string) =>
    l
      .trim()
      .replace(/^[-*]\s+(\[[ xX]\]\s+)?/, "")
      .trim();
  const usable = (l: string) => l !== "" && !l.startsWith("#") && !l.startsWith("[agent-team]") && !/^none\.?$/i.test(l);
  for (const want of ["changes", "goal"]) {
    const i = lines.findIndex((l) => new RegExp(`^#{1,6}[ \\t]+${want}[ \\t]*:?[ \\t]*#*[ \\t]*$`, "i").test(l));
    if (i < 0) continue;
    for (const l of lines.slice(i + 1)) {
      if (l.trim().startsWith("#")) break;
      const c = clean(l);
      if (usable(c)) return c;
    }
  }
  return lines.map(clean).find(usable);
}

const HEADING = /^#{1,6}[ \t]+(.+?)[ \t]*:?[ \t]*#*[ \t]*$/gm;

/** Text under the `##` heading `name` (case-insensitive) up to the next heading, or undefined if there is no such heading. */
export function sectionText(body: string, name: string): string | undefined {
  const heads = [...body.matchAll(HEADING)];
  const i = heads.findIndex((m) => m[1].trim().toLowerCase() === name.toLowerCase());
  if (i < 0) return undefined;
  const start = heads[i].index! + heads[i][0].length;
  const end = heads[i + 1]?.index ?? body.length;
  return body.slice(start, end).trim();
}

/** Outcomes a lead may declare in `done`; `cancelled` is only ever the dispatcher's. */
export const DECLARABLE_OUTCOMES = ["completed", "partial", "blocked", "failed"] as const;

export interface DoneContract {
  /** The declared outcome, when it is a valid one. */
  outcome?: RunOutcome;
  /** What the report lacks; empty when the contract is met. */
  missing: string[];
  /** First lines of `## Verification`, for display. */
  verification?: string;
}

/**
 * The completion contract of a `done` report: frontmatter `outcome`, and `## Result` and `## Not done`;
 * a `completed` report must also carry `## Files` and `## Verification` and leave no checklist step unticked
 * (the report's own `## Steps`, else the run's latest `stateSteps`).
 */
export function doneContract(meta: Record<string, unknown>, body: string, stateSteps?: Step[]): DoneContract {
  const missing: string[] = [];
  const declared = String(meta.outcome ?? "").trim().toLowerCase();
  const outcome = (DECLARABLE_OUTCOMES as readonly string[]).includes(declared) ? (declared as RunOutcome) : undefined;
  if (!outcome) missing.push(`\`outcome: ${DECLARABLE_OUTCOMES.join("|")}\` in the frontmatter${declared ? ` (got "${declared}")` : ""}`);

  const need = outcome === "completed" || !outcome ? ["Result", "Files", "Verification", "Not done"] : ["Result", "Not done"];
  const have = new Set([...body.matchAll(HEADING)].map((m) => m[1].trim().toLowerCase()));
  for (const h of need) if (!have.has(h.toLowerCase())) missing.push(`\`## ${h}\``);

  if (outcome === "completed") {
    const own = parseSteps(body);
    const open = (own.length ? own : (stateSteps ?? [])).filter((x) => !x.done);
    if (open.length) missing.push(`unfinished steps: ${open.slice(0, 3).map((x) => `"${x.text}"`).join(", ")}${open.length > 3 ? ", ..." : ""} (finish and tick them, or report \`partial\`)`);
  }

  const v = sectionText(body, "Verification");
  const verification = v
    ? v
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/^[-*]\s+/, ""))
        .filter(Boolean)
        .join(" ")
        .slice(0, 400) || undefined
    : undefined;
  return { outcome, missing, verification };
}
