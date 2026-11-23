import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ResolvedProject } from "./config.js";
import { readRegularFileNoFollow } from "./fs-util.js";
import { proposalsKindDir, recordsDir, recordsKindDir } from "./policy.js";
import { RECORD_KINDS, type RecordKind } from "./records.js";
import { git, isGitRepo } from "./worktree.js";

/**
 * Proposals of lessons and decisions from agents that run alone (spec 30). Everything here only reads: a proposal is written
 * by the agent (status `proposed`) and decided by the lead, and no code in this file writes either.
 */

export type ProposalKind = RecordKind;
export const PROPOSAL_KINDS: readonly ProposalKind[] = RECORD_KINDS;
export type ProposalStatus = "proposed" | "accepted" | "rejected";

/** One proposal file is at most this big; a larger one is "not in the right format" (D-11). */
export const PROPOSAL_MAX_BYTES = 8 * 1024;
/** The lead's prompt lists at most this many pending proposals (D-11). */
export const PENDING_SHOWN = 10;

const ID_RE = /^[a-z0-9-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

export type Evidence =
  | { type: "path"; file: string; line?: number; commit?: string }
  | { type: "commit"; commit: string }
  | { type: "mail"; value: string }
  | { type: "output"; value: string };

export interface Proposal {
  kind: ProposalKind;
  /** The file name without `.md`: `<short id>-<slug>`. */
  id: string;
  file: string;
  /** Undefined when the file has no readable `status` of the three values. */
  status?: ProposalStatus;
  date: string;
  title: string;
  proposedBy: string;
  run: string;
  evidence: Evidence[];
  repo?: string;
  scope?: string;
  supersedes: string[];
  rejectReason?: string;
  acceptedAs?: string;
  decided?: string;
  body: string;
  bytes: number;
  /** Why the file is not in the right format (empty when it is). Never makes the listing throw. */
  problems: string[];
}

/** The part of a run or call id that is unique: its first 8 lowercase letters or digits after the timestamp (D-10). */
export function shortIdOf(runId: string): string {
  const rest = runId.includes("-") ? runId.slice(runId.indexOf("-") + 1) : runId;
  return rest.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
}

/** The id's own prefix: what comes before the first `-`. */
export const prefixOf = (id: string): string => id.split("-")[0] ?? "";

const isoDate = (v: unknown): string | undefined => {
  // YAML parses an unquoted 2026-01-02 as a Date.
  const d = v instanceof Date ? v.toISOString().slice(0, 10) : v;
  return typeof d === "string" && DATE_RE.test(d) ? d : undefined;
};

const oneLine = (v: unknown): string | undefined => (typeof v === "string" && v.trim() && !/[\r\n]/.test(v.trim()) ? v.trim() : undefined);

function parseEvidenceItem(item: unknown): Evidence | string {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "an evidence entry must be a mapping (path, commit, mail or output)";
  const keys = Object.keys(item);
  if (keys.length !== 1) return "an evidence entry must have exactly one of path, commit, mail, output";
  const key = keys[0]!;
  const val = (item as Record<string, unknown>)[key];
  if (typeof val !== "string" || !val.trim()) return `evidence ${key} must be a non-empty string`;
  const v = val.trim();
  if (key === "commit") return SHA_RE.test(v) ? { type: "commit", commit: v } : "evidence commit must be a hex sha (7 to 40 characters)";
  if (key === "mail") return { type: "mail", value: v };
  if (key === "output") return { type: "output", value: v };
  if (key === "path") {
    const m = /^(.+?)(?::(\d+))?(?:\s+@\s+([0-9a-f]{7,40}))?$/.exec(v);
    if (!m) return "evidence path must look like `file[:line] [@ <commit sha>]`";
    const file = m[1]!.trim();
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) return "evidence path must be relative to the repository and stay inside it";
    return { type: "path", file, ...(m[2] ? { line: Number(m[2]) } : {}), ...(m[3] ? { commit: m[3] } : {}) };
  }
  return `unknown evidence kind "${key}"`;
}

export function parseProposal(kind: ProposalKind, file: string): Proposal {
  const id = path.basename(file, ".md");
  const base: Proposal = { kind, id, file, date: "", title: path.basename(file), proposedBy: "", run: "", evidence: [], supersedes: [], body: "", bytes: 0, problems: [] };
  // Never open a symlink or a FIFO/device (spec 30, acceptance 11).
  const buf = readRegularFileNoFollow(file);
  if (!buf) return { ...base, problems: ["not a readable regular file (symlinks and special files are never read)"] };
  const bytes = buf.length;
  const text = buf.toString("utf8");
  const problems: string[] = [];
  if (bytes > PROPOSAL_MAX_BYTES) problems.push(`larger than ${PROPOSAL_MAX_BYTES} bytes`);
  if (!ID_RE.test(id)) problems.push("file name must be lowercase letters, digits and -");
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!m) return { ...base, bytes, body: text.trim(), problems: [...problems, "missing frontmatter"] };
  const body = (m[2] ?? "").trim();
  let fm: unknown;
  try {
    fm = parseYaml(m[1]!);
  } catch (e) {
    return { ...base, bytes, body, problems: [...problems, `frontmatter is not valid YAML: ${(e as Error).message.split("\n")[0]}`] };
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) return { ...base, bytes, body, problems: [...problems, "frontmatter is not a mapping"] };
  const f = fm as Record<string, unknown>;

  const status = f.status === "proposed" || f.status === "accepted" || f.status === "rejected" ? f.status : undefined;
  if (!status) problems.push("status must be proposed, accepted or rejected");
  const date = isoDate(f.date);
  if (!date) problems.push("date must be YYYY-MM-DD");
  const title = oneLine(f.title);
  if (!title) problems.push("title must be one non-empty line");
  const proposedBy = oneLine(f.proposed_by);
  if (!proposedBy) problems.push("proposed_by is required");
  const run = oneLine(f.run);
  if (!run) problems.push("run is required");

  const evidence: Evidence[] = [];
  if (!Array.isArray(f.evidence) || f.evidence.length === 0) problems.push("evidence is required: at least one entry");
  else
    for (const item of f.evidence) {
      const e = parseEvidenceItem(item);
      if (typeof e === "string") problems.push(e);
      else evidence.push(e);
    }

  let supersedes: string[] = [];
  if (f.supersedes !== undefined) {
    if (Array.isArray(f.supersedes) && f.supersedes.every((x) => typeof x === "string")) supersedes = f.supersedes as string[];
    else problems.push("supersedes must be a list of ids");
  }
  const repo = f.repo === undefined ? undefined : oneLine(f.repo);
  if (f.repo !== undefined && (!repo || !path.isAbsolute(repo))) problems.push("repo must be an absolute path");
  const decided = f.decided === undefined ? undefined : isoDate(f.decided);
  if (f.decided !== undefined && !decided) problems.push("decided must be YYYY-MM-DD");

  return {
    kind,
    id,
    file,
    ...(status ? { status } : {}),
    date: date ?? "",
    title: title ?? path.basename(file),
    proposedBy: proposedBy ?? "",
    run: run ?? "",
    evidence,
    ...(repo && path.isAbsolute(repo) ? { repo } : {}),
    ...(oneLine(f.scope) ? { scope: oneLine(f.scope)! } : {}),
    supersedes,
    ...(oneLine(f.reject_reason) ? { rejectReason: oneLine(f.reject_reason)! } : {}),
    ...(oneLine(f.accepted_as) ? { acceptedAs: oneLine(f.accepted_as)! } : {}),
    ...(decided ? { decided } : {}),
    body,
    bytes,
    problems,
  };
}

/** Every `*.md` proposal of one kind, sorted by id. A missing or symlinked folder lists nothing; `.archive/` is never read. */
export function listKindProposals(project: ResolvedProject, kind: ProposalKind): Proposal[] {
  const dir = proposalsKindDir(project, kind);
  let names: string[];
  try {
    // A symlinked proposals/ or kind folder could point outside the project: list nothing, never descend.
    for (const d of [path.dirname(dir), dir]) if (!fs.lstatSync(d).isDirectory()) return [];
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => parseProposal(kind, path.join(dir, n)));
}

export const listProposals = (project: ResolvedProject): Proposal[] => PROPOSAL_KINDS.flatMap((k) => listKindProposals(project, k));

/** Proposals waiting for the lead: `status: proposed`, or with no readable status (they are shown as "format problem", never lost). */
export const pendingProposals = (project: ResolvedProject): Proposal[] => listProposals(project).filter((p) => p.status === undefined || p.status === "proposed");

export function oldestPending(pending: Proposal[]): string | undefined {
  const dates = pending.map((p) => p.date).filter(Boolean).sort();
  return dates[0];
}

export interface DecisionProblem {
  file: string;
  problem: string;
}

/** Whether `<kind>/<id>` is a record of the project, live or archived by a tidy (`.archive/<stamp>/<kind>/<id>.md`). */
function recordExists(project: ResolvedProject, ref: string): boolean {
  const m = /^(decisions|lessons)\/([a-z0-9-]+)$/.exec(ref);
  if (!m) return false;
  const kind = m[1] as RecordKind;
  const id = m[2]!;
  if (fs.existsSync(path.join(recordsKindDir(project, kind), `${id}.md`))) return true;
  const archive = path.join(recordsDir(project), ".archive");
  try {
    return fs.readdirSync(archive).some((stamp) => fs.existsSync(path.join(archive, stamp, kind, `${id}.md`)));
  } catch {
    return false;
  }
}

/**
 * Layer 1 of D-09: the lead's decisions are complete. Only decided proposals are looked at. An `accepted` one must be a
 * whole proposal (format, evidence, a prefix that matches its run) with `accepted_as` pointing at a record and a `decided`
 * date. A `rejected` one only needs `reject_reason` and `decided`, so the lead can reject a badly formed one without being
 * sent back for it. Evidence that does not exist on disk is not checked here (layer 2, `checkEvidence`).
 */
export function checkDecisions(proposals: Proposal[], project: ResolvedProject): DecisionProblem[] {
  const out: DecisionProblem[] = [];
  const add = (p: Proposal, problem: string): void => void out.push({ file: p.file, problem });
  for (const p of proposals) {
    if (p.status === "rejected") {
      if (!p.rejectReason) add(p, "rejected without reject_reason");
      if (!p.decided) add(p, "rejected without decided (YYYY-MM-DD)");
    } else if (p.status === "accepted") {
      for (const problem of p.problems) add(p, `accepted but ${problem}`);
      if (p.run && shortIdOf(p.run) !== prefixOf(p.id)) add(p, "accepted but the file name prefix does not match its run");
      if (!p.acceptedAs) add(p, "accepted without accepted_as (<kind>/<id>)");
      else if (!recordExists(project, p.acceptedAs)) add(p, `accepted_as ${p.acceptedAs} is not a record of the project`);
      if (!p.decided) add(p, "accepted without decided (YYYY-MM-DD)");
    }
  }
  return out;
}

export type EvidenceStrength = "verified" | "weak" | "none";

export interface EvidenceCheck {
  strength: EvidenceStrength;
  notes: string[];
}

const tryGit = (cwd: string, args: string[]): string | undefined => {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
};

/**
 * Layer 2 of D-09: does the evidence exist (30.7). `root` is the repository `path:` and `commit:` refer to (`project.dir`);
 * a proposal's own `repo` takes its place, and when that is missing or not a git repository the evidence is only "weak".
 * `mail:` and `output:` are format-only and never count as verified. Nothing here judges whether the lesson is right.
 */
export function checkEvidence(p: Proposal, root: string): EvidenceCheck {
  const notes: string[] = [];
  const repo = p.repo ?? root;
  const usable = fs.existsSync(repo) && isGitRepo(repo);
  if (!usable) {
    const had = p.evidence.some((e) => e.type === "path" || e.type === "commit");
    return { strength: "none", notes: had ? [`the repository ${repo} is not available: evidence was not checked`] : ["no path or commit evidence"] };
  }
  let verified = false;
  let weak = false;
  for (const e of p.evidence) {
    if (e.type === "commit") {
      if (tryGit(repo, ["cat-file", "-t", `${e.commit}^{commit}`]) === "commit") verified = true;
      else notes.push(`commit ${e.commit} does not exist`);
    } else if (e.type === "path") {
      if (e.commit) {
        const content = tryGit(repo, ["show", `${e.commit}:${e.file}`]);
        if (content === undefined) notes.push(`${e.file} does not exist at ${e.commit}`);
        else if (e.line && e.line > lineCount(content)) notes.push(`${e.file} has fewer than ${e.line} lines at ${e.commit}`);
        else verified = true;
      } else {
        const full = path.join(repo, e.file);
        const buf = readRegularFileNoFollow(full);
        if (!buf) notes.push(`${e.file} does not exist`);
        else if (e.line && e.line > lineCount(buf.toString("utf8"))) notes.push(`${e.file} has fewer than ${e.line} lines`);
        else weak = true; // no commit: the line may have moved
      }
    }
  }
  return { strength: verified ? "verified" : weak ? "weak" : "none", notes };
}

const lineCount = (s: string): number => (s === "" ? 0 : s.replace(/\n$/, "").split("\n").length);
