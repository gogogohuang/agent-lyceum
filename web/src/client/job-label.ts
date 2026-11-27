import type { JobSummary } from "./api";
import type { TidyBadgeInfo } from "./run-state";

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
  const tidy = flags.includes("--tidy") || /tidy/i.test(after("--name") ?? "");
  const cmd = argv[0];
  let target: string | undefined;
  if (cmd === "run") target = after("--name") ?? excerpt(rest[0]);
  else if (cmd === "resume") target = rest[0];
  else if (cmd === "call") target = [flags[1], excerpt(rest[0])].filter(Boolean).join("：") || undefined;
  return { project, target, tidy };
}

/** Badge for a background tidy job, from its argv, state, exit code and signal. Not tidy → none. A job killed by a signal (the runner records exit null plus the signal) counts as interrupted. */
export function jobTidyBadge(job: Pick<JobSummary, "argv" | "state" | "exit" | "signal">): TidyBadgeInfo | undefined {
  if (!jobLabel(job.argv).tidy) return undefined;
  if (job.state === "running") return { text: "tidy 進行中", tone: "progress" };
  if (job.state === "ended" && job.exit === 0) return { text: "已 tidy", tone: "ok" };
  const interrupted = job.state === "lost" || (job.state === "ended" && (job.exit === 2 || job.exit === 3 || job.exit === 130 || (job.exit == null && !!job.signal)));
  if (interrupted) return { text: "tidy 未完成", tone: "warn" };
  return { text: "tidy 失敗", tone: "fail" };
}

function excerpt(text: string | undefined): string | undefined {
  const line = text?.split("\n").find((l) => l.trim())?.trim();
  if (!line) return undefined;
  return line.length > EXCERPT ? `${line.slice(0, EXCERPT)}…` : line;
}
