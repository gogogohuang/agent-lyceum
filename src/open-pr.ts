import { execFileSync } from "node:child_process";
import path from "node:path";
import { atomicWrite } from "./fs-util.js";

/** Runs `git` or `gh` in `cwd`. Injected so tests never touch a network or a real remote. */
export type CommandRunner = (cmd: "git" | "gh", args: string[], cwd: string) => { ok: boolean; out: string };

/** The real thing: runs outside any agent sandbox, with the user's own git and gh credentials. */
export const realRunner: CommandRunner = (cmd, args, cwd) => {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    return { ok: true, out: out.trim() };
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message: string };
    return { ok: false, out: String(err.stderr ?? err.message).trim() };
  }
};

/** The one line that says who opened the pull request. It names no agent and no role. */
export const PR_FOOTER = "🤖 Opened by agent-lyceum";

const TITLE_MAX = 72;
const BODY_MAX = 60_000; // GitHub rejects bodies over 65536 characters

/** First non-empty line of the task summary, cut to 72 characters. */
export function prTitle(taskSummary: string): string {
  const first = taskSummary.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "agent-lyceum task";
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
}

/** The lead's `done` report as written, then one footer line. */
export function prBody(doneBody: string): string {
  return `${doneBody.trim().slice(0, BODY_MAX)}\n\n${PR_FOOTER}\n`;
}

/** The repo's default branch: `origin/HEAD`, else what `gh` says, else `main`. */
export function defaultBase(cwd: string, run: CommandRunner): string {
  const sym = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  const m = sym.ok ? /^origin\/(.+)$/.exec(sym.out) : null;
  if (m?.[1]) return m[1];
  const gh = run("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], cwd);
  return gh.ok && gh.out ? gh.out : "main";
}

export type OpenPrResult =
  | { status: "opened"; url: string }
  | { status: "failed"; step: "push" | "create"; reason: string; manual: string[] };

/** What happened to a requested pull request; `skipped` means it was asked for but the run could not support it. */
export type PrOutcome = OpenPrResult | { status: "skipped"; reason: string };

export interface OpenPrInput {
  /** The lead's worktree: where the branch is checked out. */
  cwd: string;
  branch: string;
  title: string;
  body: string;
  /** Where the description is written for `gh --body-file` (and for finishing by hand). */
  bodyFile: string;
  run: CommandRunner;
}

const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "no output";

/** Push the branch and open a pull request against the default branch. Never throws; says how to finish by hand when a step fails. */
export function openPullRequest(i: OpenPrInput): OpenPrResult {
  const base = defaultBase(i.cwd, i.run);
  atomicWrite(i.bodyFile, i.body);
  const createArgs = ["pr", "create", "--head", i.branch, "--base", base, "--title", i.title, "--body-file", i.bodyFile];
  const manualPush = `git -C ${i.cwd} push -u origin ${i.branch}`;
  const manualCreate = `gh pr create --head ${i.branch} --base ${base} --title ${JSON.stringify(i.title)} --body-file ${path.resolve(i.bodyFile)}`;

  const push = i.run("git", ["push", "-u", "origin", i.branch], i.cwd);
  if (!push.ok) return { status: "failed", step: "push", reason: firstLine(push.out), manual: [manualPush, manualCreate] };

  const created = i.run("gh", createArgs, i.cwd);
  if (!created.ok) return { status: "failed", step: "create", reason: firstLine(created.out), manual: [manualCreate] };
  const url = created.out.split(/\s+/).find((w) => /^https?:\/\//.test(w));
  if (!url) return { status: "failed", step: "create", reason: `gh printed no URL: ${firstLine(created.out)}`, manual: [manualCreate] };
  return { status: "opened", url };
}
