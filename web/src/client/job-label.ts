export type JobLabel = { project?: string; target?: string; tidy: boolean };

const EXCERPT = 60;

/** What a background job is working on, read from its argv: `run -p proj --name n -- task`, `resume -p proj -- run`, `call agent --dir d -- task`. */
export function jobLabel(argv: string[]): JobLabel {
  const sep = argv.indexOf("--");
  const flags = sep < 0 ? argv : argv.slice(0, sep);
  const rest = sep < 0 ? [] : argv.slice(sep + 1);
  const after = (flag: string) => {
    const i = flags.indexOf(flag);
    return i >= 0 ? flags[i + 1] : undefined;
  };
  const project = after("-p");
  const cmd = argv[0];
  const tidy = flags.includes("--tidy") || (cmd === "tidy" && !flags.includes("--dry-run") && !flags.includes("--undo"));
  let target: string | undefined;
  if (cmd === "run") target = after("--name") ?? excerpt(rest[0]);
  else if (cmd === "resume") target = rest[0];
  else if (cmd === "call") target = [flags[1], excerpt(rest[0])].filter(Boolean).join("：") || undefined;
  return { project, target, tidy };
}

function excerpt(text: string | undefined): string | undefined {
  const line = text?.split("\n").find((l) => l.trim())?.trim();
  if (!line) return undefined;
  return line.length > EXCERPT ? `${line.slice(0, EXCERPT)}…` : line;
}
