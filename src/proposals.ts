import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ResolvedProject } from "./config.js";
import { isVerdict } from "./attribution.js";
import { parseSlotName } from "./instances.js";
import { readRegularFileNoFollow } from "./fs-util.js";
import { proposalsKindDir, recordsDir, recordsKindDir, reviewerNames } from "./policy.js";
import { RECORD_KINDS, type RecordKind } from "./records.js";
import { git, isGitRepo } from "./worktree.js";

/**
 * Proposals of lessons and decisions from agents that run alone (spec 30). Everything here only reads: a proposal is written
 * by the agent (status `proposed`) and decided by the lead, and no code in this file writes either.
 */

export type ProposalKind = RecordKind;
export const PROPOSAL_KINDS: readonly ProposalKind[] = RECORD_KINDS;
export type ProposalStatus = "proposed" | "accepted" | "rejected";

/** A reviewer's blocker or major finding. `severity` is kept even when it is not blocker or major, so a warning can name it. */
export interface Finding {
  mail: string;
  severity: string;
  className: string;
}

/** Where a `finding.mail` file stands while its run directory still exists. `skip` means the run is gone or its mail is not in the run folder. */
export type FindingMail = "skip" | "ok" | "missing" | "not-a-verdict-reply";

/** One proposal file is at most this big; a larger one is "not in the right format" (D-11). */
export const PROPOSAL_MAX_BYTES = 8 * 1024;
/** The lead's prompt lists at most this many pending proposals (D-11). */
export const PENDING_SHOWN = 10;

const ID_RE = /^[a-z0-9-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
/** A run id is a timestamp, a hyphen, then lowercase letters or digits (`newRunId`). Nothing else is joined onto `runs/`. */
const RUN_ID_RE = /^\d{8}T\d+Z-[a-z0-9]+$/;

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
  /** The evidence values as written, so a record can be checked for a verbatim copy. */
  evidenceText: string[];
  /** Set when the file has a `finding` mapping. Absent when the key is omitted (a solo proposal). */
  finding?: Finding;
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

/** The `status` in a proposal's frontmatter, or undefined when the text has none of the three values (or is not a proposal at all). */
export function proposalStatusOf(buf: Buffer): ProposalStatus | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(buf.toString("utf8"));
  if (!m) return undefined;
  try {
    const fm = parseYaml(m[1]!) as Record<string, unknown> | null;
    const st = fm && typeof fm === "object" ? fm.status : undefined;
    return st === "proposed" || st === "accepted" || st === "rejected" ? st : undefined;
  } catch {
    return undefined;
  }
}

/** The id's own prefix: what comes before the first `-`. */
export const prefixOf = (id: string): string => id.split("-")[0] ?? "";

export { isReviewer, reviewerNames } from "./policy.js";

/** A run id (`newRunId`): timestamp, hyphen, then lowercase letters or digits. Solo proposals are not held to this. */
export const isRunId = (value: string): boolean => RUN_ID_RE.test(value);

/**
 * The reviewer a team file name belongs to. `id` is the file name without `.md`: `<8 lowercase letters or digits>-<agent>-<slug>`.
 * When one reviewer name is a prefix of another (`cli-reviewer` and `cli-reviewer--2`), the longer name wins. A `<role>--<k>-<slug>`
 * file belongs to that slot when the role is one of `names`, even if the slot itself is not. A solo `<short id>-<slug>` has no owner.
 */
export function proposalOwner(id: string, names: readonly string[]): string | undefined {
  const rest = /^[a-z0-9]{8}-(.+)$/.exec(id)?.[1];
  if (!rest) return undefined;
  // `<role>--<k>-<slug>` belongs to that slot when the role is a reviewer, even if the slot is not in `names` (a later run, or doctor, has no instance table).
  const slot = /^(.+--(?:[2-9]|[1-9]\d+))-([a-z0-9][a-z0-9-]*)$/.exec(rest);
  if (slot?.[1] && slot[2]) {
    const parsed = parseSlotName(slot[1]);
    if (parsed && (names.includes(parsed.role) || names.includes(slot[1]))) return slot[1];
  }
  let best: string | undefined;
  for (const name of names) {
    if ((rest === name || rest.startsWith(`${name}-`)) && (best === undefined || name.length > best.length)) best = name;
  }
  if (!best || !rest.startsWith(`${best}-`) || rest.length === best.length + 1) return undefined;
  const slug = rest.slice(best.length + 1);
  if (slug.startsWith("-") || !/^[a-z0-9-]+$/.test(slug)) return undefined;
  return best;
}

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

/** The evidence value as written, for the verbatim copy a record must carry. */
function evidenceRaw(item: unknown): string | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const keys = Object.keys(item);
  if (keys.length !== 1) return undefined;
  const val = (item as Record<string, unknown>)[keys[0]!];
  return typeof val === "string" && val.trim() ? val.trim() : undefined;
}

/** `finding` is optional. A bad severity is still stored, so doctor can name `minor` or `nit`. */
function parseFinding(v: unknown, problems: string[]): Finding | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    problems.push("finding must be a mapping");
    return undefined;
  }
  const f = v as Record<string, unknown>;
  const mail = oneLine(f.mail);
  const severity = oneLine(f.severity);
  const className = oneLine(f.class);
  if (!mail || /[\\/]/.test(mail) || mail.includes("..")) problems.push("finding.mail must be a file name");
  if (!severity || (severity !== "blocker" && severity !== "major")) problems.push("finding.severity must be blocker or major");
  if (!className) problems.push("finding.class must be one non-empty line");
  return { mail: mail ?? "", severity: severity ?? "", className: className ?? "" };
}

export function parseProposal(kind: ProposalKind, file: string): Proposal {
  const id = path.basename(file, ".md");
  const base: Proposal = { kind, id, file, date: "", title: path.basename(file), proposedBy: "", run: "", evidence: [], evidenceText: [], supersedes: [], body: "", bytes: 0, problems: [] };
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
  const evidenceText: string[] = [];
  if (!Array.isArray(f.evidence) || f.evidence.length === 0) problems.push("evidence is required: at least one entry");
  else
    for (const item of f.evidence) {
      const e = parseEvidenceItem(item);
      if (typeof e === "string") problems.push(e);
      else {
        evidence.push(e);
        const raw = evidenceRaw(item);
        if (raw) evidenceText.push(raw);
      }
    }
  const finding = f.finding === undefined ? undefined : parseFinding(f.finding, problems);

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
    evidenceText,
    ...(finding ? { finding } : {}),
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

/** What `proposals list` shows: the counts, the pending ones with their evidence, and every decision that is not complete. Reads only. */
export function describeProposals(project: ResolvedProject): string[] {
  const all = listProposals(project);
  if (all.length === 0) return ["No proposals."];
  const pending = pendingProposals(project);
  const count = (s: ProposalStatus): number => all.filter((p) => p.status === s).length;
  const lines = [`${all.length} proposal(s): ${pending.length} pending, ${count("accepted")} accepted, ${count("rejected")} rejected${oldestPending(pending) ? `; oldest pending ${oldestPending(pending)}` : ""}.`];
  for (const p of [...pending].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    const strength = p.problems.length ? `format problem: ${p.problems.join("; ")}` : (() => {
      const c = checkEvidence(p, project.dir);
      return c.strength === "verified" ? "evidence verified" : c.strength === "weak" ? "weak evidence (no commit)" : "no machine-verifiable evidence";
    })();
    lines.push(`  pending   ${p.file} — ${p.title} (${p.date || "no date"}) — ${strength}`);
  }
  for (const d of checkDecisions(all, project)) lines.push(`  problem   ${d.file}: ${d.problem}`);
  return lines;
}

export interface DecisionProblem {
  file: string;
  problem: string;
}

/** The live or archived file for `<kind>/<id>`, if one exists. */
function recordFile(project: ResolvedProject, ref: string): string | undefined {
  const m = /^(decisions|lessons)\/([a-z0-9-]+)$/.exec(ref);
  if (!m) return undefined;
  const kind = m[1] as RecordKind;
  const id = m[2]!;
  const live = path.join(recordsKindDir(project, kind), `${id}.md`);
  if (fs.existsSync(live)) return live;
  const archive = path.join(recordsDir(project), ".archive");
  try {
    for (const stamp of fs.readdirSync(archive)) {
      const file = path.join(archive, stamp, kind, `${id}.md`);
      if (fs.existsSync(file)) return file;
    }
  } catch {
    // no archive
  }
  return undefined;
}

/** Whether `<kind>/<id>` is a record of the project, live or archived by a tidy (`.archive/<stamp>/<kind>/<id>.md`). */
const recordExists = (project: ResolvedProject, ref: string): boolean => recordFile(project, ref) !== undefined;

/** Body after the frontmatter. A file that is not a regular file counts as empty, so a symlink is never treated as a copy. */
function recordBody(project: ResolvedProject, ref: string): string {
  const file = recordFile(project, ref);
  const buf = file ? readRegularFileNoFollow(file) : undefined;
  if (!buf) return "";
  const text = buf.toString("utf8");
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  return m ? (m[1] ?? "") : text;
}

const hasEvidenceHeading = (body: string): boolean => body.split(/\r?\n/).some((line) => line.trim() === "## Evidence");

function copiesFinding(body: string, p: Proposal): boolean {
  if (!p.finding) return false;
  return [...p.evidenceText, p.finding.mail, p.finding.severity, p.finding.className].every((bit) => bit !== "" && body.includes(bit));
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
      const owner = proposalOwner(p.id, reviewerNames(project));
      if (owner) addReviewerAcceptance(p, project, owner, add);
    }
  }
  return out;
}

/** Extra acceptance rules for a file a reviewer owns (issue 177). A solo file has no owner, so spec 30 is unchanged. */
function addReviewerAcceptance(p: Proposal, project: ResolvedProject, owner: string, add: (p: Proposal, problem: string) => void): void {
  if (!isRunId(p.run)) add(p, "accepted but run must be a run id");
  if (!p.finding) add(p, "accepted but finding is required");
  else if (p.finding.mail && !/[\\/]/.test(p.finding.mail) && !p.finding.mail.includes("..")) {
    const mail = checkFindingMail(project, p.run, p.finding.mail, owner);
    if (mail === "missing") add(p, "accepted but finding.mail was not found");
    else if (mail === "not-a-verdict-reply") add(p, "accepted but finding.mail is not a reply with verdict");
  }
  if (p.proposedBy !== owner) add(p, "accepted but proposed_by does not match the file name");
  if (checkEvidence(p, project.dir).strength !== "verified") add(p, "accepted but evidence is not verified");
  if (!p.acceptedAs || !recordExists(project, p.acceptedAs)) return;
  const body = recordBody(project, p.acceptedAs);
  if (!hasEvidenceHeading(body)) add(p, "accepted but the record has no ## Evidence section");
  else if (!copiesFinding(body, p)) add(p, "accepted but the record does not copy the evidence and finding");
}

/** A real directory, never a symlink. */
function realRunDir(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The run directory whose mail can be checked. `claimedRun` is used only when it is a run id whose short id matches and whose
 * directory is still there. Otherwise the directory is the one under `runs/` with that short id, so a short id or a missing
 * claimed directory cannot skip the check while the run still exists. No such directory means the run was cleared: `skip`.
 * Several directories with the same short id, and none of them the claimed id, is `ambiguous` (checked as missing, never skipped).
 */
function resolveFindingRunDir(project: ResolvedProject, claimedRun: string, shortId: string): "skip" | "ambiguous" | string {
  const root = project.paths.runs;
  if (RUN_ID_RE.test(claimedRun) && shortIdOf(claimedRun) === shortId) {
    const claimed = path.join(root, claimedRun);
    if (realRunDir(claimed) && fs.existsSync(path.join(claimed, "state.json"))) return claimed;
  }
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return "skip";
  }
  const matches: string[] = [];
  for (const name of names) {
    if (!RUN_ID_RE.test(name) || shortIdOf(name) !== shortId) continue;
    const dir = path.join(root, name);
    if (realRunDir(dir) && fs.existsSync(path.join(dir, "state.json"))) matches.push(dir);
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) return "skip";
  return "ambiguous";
}

/**
 * Whether `mailBase` is one reply carrying `verdict:` under the run's mail. The file name is the one the reviewer wrote in
 * their outbox: after routing, `sent/<name>` wins over a rejected copy of the same name, and over every other agent's outbox.
 * A delivered copy (a different file name) is looked up in inboxes, including `pending/`. No run directory left, or `mail_layout`
 * other than `run`, means the mail cannot be checked any more: that is `skip`, not a failure. `runId` is never joined onto
 * `runs/` unless it is a single run id.
 */
export function checkFindingMail(project: ResolvedProject, runId: string, mailBase: string, owner?: string): FindingMail {
  if (!mailBase || /[\\/]/.test(mailBase) || mailBase.includes("..")) return "missing";
  const resolved = resolveFindingRunDir(project, runId, shortIdOf(runId));
  if (resolved === "skip") return "skip";
  if (resolved === "ambiguous") return "missing";
  const runDir = resolved;
  const stateFile = path.join(runDir, "state.json");
  if (!fs.existsSync(stateFile)) return "skip";
  let layout: unknown;
  try {
    layout = (JSON.parse(fs.readFileSync(stateFile, "utf8")) as { mail_layout?: unknown }).mail_layout;
  } catch {
    return "skip";
  }
  if (layout !== "run") return "skip";
  const file = locateFindingMail(runDir, mailBase, owner);
  if (!file) return "missing";
  const buf = readRegularFileNoFollow(file);
  if (!buf) return "missing";
  return isVerdictReply(buf.toString("utf8")) ? "ok" : "not-a-verdict-reply";
}

function isRegularFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The owner's `sent/` copy is the one that was routed. A same-named file in `rejected/`, or in another agent's outbox, does not count beside it.
 * Without an outbox copy, one inbox file (including `read/` and `pending/`) is the delivered name.
 */
function locateFindingMail(runDir: string, mailBase: string, owner?: string): string | undefined {
  if (owner && !/[\\/]/.test(owner) && !owner.includes("..")) {
    const base = path.join(runDir, "mail", "outbox", owner);
    const sent = path.join(base, "sent", mailBase);
    if (isRegularFile(sent)) return sent;
    const live = [path.join(base, mailBase), path.join(base, "read", mailBase)].filter(isRegularFile);
    if (live.length > 1) return undefined;
    if (live.length === 1) return live[0];
    const rejected = path.join(base, "rejected", mailBase);
    if (isRegularFile(rejected)) return rejected;
  }
  const hits: string[] = [];
  const root = path.join(runDir, "mail", "inbox");
  let agents: string[];
  try {
    agents = fs.readdirSync(root).filter((name) => {
      try {
        const st = fs.lstatSync(path.join(root, name));
        return st.isDirectory() && !st.isSymbolicLink();
      } catch {
        return false;
      }
    });
  } catch {
    return undefined;
  }
  for (const agent of agents) {
    for (const dir of [path.join(root, agent), path.join(root, agent, "read"), path.join(root, agent, "pending")]) {
      const file = path.join(dir, mailBase);
      if (isRegularFile(file)) hits.push(file);
    }
  }
  return hits.length === 1 ? hits[0] : undefined;
}

/** A reply (type omitted counts as reply, the same as the mailbox) whose `verdict` is one of the three review results. */
function isVerdictReply(text: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return false;
  try {
    const fm = parseYaml(m[1]!) as Record<string, unknown> | null;
    if (!fm || typeof fm !== "object" || Array.isArray(fm)) return false;
    const type = fm.type ?? "reply";
    return type === "reply" && isVerdict(fm.verdict);
  } catch {
    return false;
  }
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
