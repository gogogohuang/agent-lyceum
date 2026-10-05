import type { MessageType } from "./mailbox.js";

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
