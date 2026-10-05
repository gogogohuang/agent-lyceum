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
