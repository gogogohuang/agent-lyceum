import { sectionText } from "./format.js";

/** Commands named in `## Verification`: a bullet that is only one backtick span, or a non-empty line inside a fence. */
export function boundCommands(taskMarkdown: string): string[] {
  const text = sectionText(taskMarkdown, "Verification");
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const t = raw.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!fence && (trimmed === "```" || /^```[^\s`]*$/.test(trimmed))) {
      fence = true;
      continue;
    }
    if (fence && trimmed === "```") {
      fence = false;
      continue;
    }
    if (fence) {
      if (trimmed) add(line);
      continue;
    }
    const bullet = /^[ \t]*[-*][ \t]+`([^`\n]+)`[ \t]*$/.exec(line);
    if (bullet?.[1]) add(bullet[1]);
  }
  return out;
}

/** Commands the task names that are not an exact `verify.commands[].run`. */
export function unboundCommands(taskMarkdown: string, runs: readonly string[]): string[] {
  const known = new Set(runs);
  return boundCommands(taskMarkdown).filter((c) => !known.has(c));
}
