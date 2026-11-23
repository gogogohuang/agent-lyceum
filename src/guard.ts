import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { readRegularFileNoFollow } from "./fs-util.js";
import { escapesParent } from "./paths.js";
import { mayEditProtected, proposalsDir, recordsDir, repoInstructionFiles, sharedContextFiles, sharedIndex } from "./policy.js";
import { listRunLocks, lockHolderAlive } from "./project-lock.js";
import { prefixOf, proposalStatusOf, shortIdOf } from "./proposals.js";

export interface Violation {
  file: string;
  action: "restored" | "removed";
  suspects: string[];
  /** Where the rejected version was kept (only for a project bound to a run, and when the file still existed). */
  saved?: string;
  sha256?: string;
  /** The kept copy is cut to MAX_KEEP_BYTES. */
  truncated?: boolean;
}

/** A change to a cross-run shared file that no agent of the batch may make, while another run of the project was live. */
export interface Unattributed {
  file: string;
  agents: string[];
  otherRuns: string[];
}

export const MAX_KEEP_BYTES = 1024 * 1024;

/** Options for a guard that watches more than the project it was made for (spec 30): a `call -p` watches the real project, and a solo agent's proposals. */
export interface GuardOptions {
  /** The records tree to watch, when it is not `recordsDir(project)` (a `call -p` project is a temporary one). */
  recordsRoot?: string;
  /** The proposals tree to watch, when it is not `proposalsDir(project)`. */
  proposalsRoot?: string;
  /** The only file-name prefix this agent may write in the proposals tree. Without it (and without `project.run`) proposals are not watched. */
  shortId?: string;
  /** Where rejected versions are kept for a project that is bound to no run (a `call -p`). */
  violationsDir?: string;
  /**
   * Run ids that started after the given run-id timestamp (see `runStamp`), alive or not. A run that began and ended
   * inside one watched window leaves no live lock for `check()` to see, yet its lead may have written to the shared files.
   */
  startedAfter?: (stamp: string) => string[];
  /**
   * File-name prefixes (short ids) of the other `call -p` and `run --agent` agents that wrote proposals while this one worked,
   * live or already finished (see `otherCallPrefixes`). Their proposals sit in the same tree: changes under those prefixes are theirs, not this agent's.
   */
  otherPrefixes?: (stamp: string) => string[];
}

/** The short ids of the calls other than `selfId` that hold a live project lock, or that started after `stamp` (their ids sort by start time). */
export function otherCallPrefixes(home: string, projectRoot: string, selfId: string): (stamp: string) => string[] {
  return (stamp) => {
    const ids = new Set<string>();
    for (const l of listRunLocks(projectRoot)) if (l.call && l.run_id !== selfId && lockHolderAlive(l)) ids.add(l.run_id);
    try {
      for (const n of fs.readdirSync(path.join(home, "calls"))) if (n !== selfId && /^\d{8}T\d+Z-/.test(n) && n.slice(0, n.indexOf("-")) > stamp) ids.add(n);
    } catch {
      /* no calls yet */
    }
    return [...ids].map(shortIdOf);
  };
}

/** The timestamp part of a run id, for `Date` (the same text `newRunId` starts with). */
export const runStamp = (d: Date = new Date()): string => d.toISOString().replace(/[-:]/g, "").replace(/\.(\d+)Z$/, "$1Z");

/** Ids under `runsDir` whose timestamp is after `stamp`, except `selfId`. Run ids sort by start time. */
export function runsStartedAfter(runsDir: string, stamp: string, selfId?: string): string[] {
  try {
    return fs
      .readdirSync(runsDir)
      .filter((n) => n !== selfId && /^\d{8}T\d+Z-/.test(n) && n.slice(0, n.indexOf("-")) > stamp);
  } catch {
    return [];
  }
}

function safeName(file: string): string {
  return file.replace(/[\\/:]/g, "_").replace(/^_+/, "");
}

/**
 * Detects (and reverts) changes to protected files made by agents that may not edit them.
 * This is the runtime-independent safety net behind the OS/tool-level enforcement.
 */
export class ProtectedGuard {
  private baseline = new Map<string, Buffer | null>();
  /** Regular files of the records tree (including `.archive/`); any agent in the running batch may change them. */
  private records = new Map<string, Buffer>();

  /** Changes kept (not reverted) because another live run may have made them; see `takeUnattributed`. */
  private unattributed: Unattributed[] = [];
  /** Regular files of the proposals tree, for a solo agent (spec 30): only its own proposed files may change. */
  private proposals = new Map<string, Buffer>();
  /** Other runs that were live at the last `rebase()` (or at `check()` time); computed once per batch. */
  private liveAtBase: string[] = [];
  /** When the current batch's baseline was taken, as a run-id timestamp. */
  private baseStamp = runStamp();

  /** `otherLiveRuns`: ids of the project's other runs that have a live lock holder right now (asked again on every `check`). */
  constructor(
    private project: ResolvedProject,
    private otherLiveRuns: () => string[] = () => [],
    private opts: GuardOptions = {},
  ) {
    this.rebase();
  }

  private recordsRoot = (): string => this.opts.recordsRoot ?? recordsDir(this.project);
  private proposalsRoot = (): string => this.opts.proposalsRoot ?? proposalsDir(this.project);
  private ownPrefix = (): string | undefined => this.opts.shortId ?? (this.project.run ? shortIdOf(this.project.run.id) : undefined);

  /** The unattributed changes since the last call (they were kept and adopted as the baseline). */
  takeUnattributed(): Unattributed[] {
    const out = this.unattributed;
    this.unattributed = [];
    return out;
  }

  /** Files shared by every run of the project: only these can be changed by another run's lead. */
  private crossRunShared(file: string): boolean {
    if (sharedContextFiles(this.project).includes(file)) return true;
    return Object.values(this.project.agents).some((a) => a.agentMd === file);
  }

  /**
   * Take the current files as the baseline. Called right before a batch is woken, so only what changes while it runs is
   * judged: edits made in between (you, or another run of the project) are not the batch's doing.
   */
  rebase(): void {
    this.baseStamp = runStamp();
    this.liveAtBase = this.otherLiveRuns();
    for (const f of ProtectedGuard.protectedFiles(this.project)) this.baseline.set(f, read(f));
    this.records = readTree(this.recordsRoot());
    this.proposals = readTree(this.proposalsRoot());
  }

  static protectedFiles(project: ResolvedProject): string[] {
    const files = new Set<string>();
    for (const a of Object.values(project.agents)) files.add(a.agentMd);
    for (const f of sharedContextFiles(project)) files.add(f);
    for (const f of repoInstructionFiles(project)) files.add(f);
    const handoff = sharedIndex(project);
    if (handoff) files.add(handoff);
    return [...files];
  }

  /** Copy the current protected files into `dir` for the audit trail. */
  saveSnapshot(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, buf] of this.baseline) {
      if (!buf) continue;
      const safe = safeName(file);
      fs.writeFileSync(path.join(dir, safe), buf);
    }
  }

  /** Keep what an agent wrote into a protected file before it is reverted. Nothing is written without a bound run. */
  private keep(file: string, content: Buffer | null): Pick<Violation, "saved" | "sha256" | "truncated"> {
    const base = this.project.run?.dir ?? this.opts.violationsDir;
    if (!content || !base) return {};
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const dir = this.project.run ? path.join(base, "violations") : base;
    fs.mkdirSync(dir, { recursive: true });
    const n = String(fs.readdirSync(dir).length + 1).padStart(3, "0");
    const saved = path.join(dir, `${n}-${safeName(file)}`);
    const truncated = content.length > MAX_KEEP_BYTES;
    fs.writeFileSync(saved, truncated ? content.subarray(0, MAX_KEEP_BYTES) : content);
    return { saved, sha256, ...(truncated ? { truncated } : {}) };
  }

  /** Compare against the baseline after `running` agents finished; revert unauthorized changes. */
  check(running: ResolvedAgent[]): Violation[] {
    const violations: Violation[] = [];
    const other = [...new Set([...this.liveAtBase, ...this.otherLiveRuns(), ...(this.opts.startedAfter?.(this.baseStamp) ?? [])])];
    for (const [file, before] of this.baseline) {
      if (unsafeToRead(file)) {
        const kept = this.keep(file, null);
        fs.rmSync(file, { force: true });
        if (before !== null) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, before);
        }
        violations.push({ file, action: before === null ? "removed" : "restored", suspects: running.map((a) => a.name), ...kept });
        continue;
      }
      const now = read(file);
      if (same(before, now)) continue;
      const authorized = running.some((a) => mayEditProtected(this.project, a, file));
      if (authorized) {
        this.baseline.set(file, now);
        continue;
      }
      if (other.length && this.crossRunShared(file)) {
        this.baseline.set(file, now);
        this.unattributed.push({ file, agents: running.map((a) => a.name), otherRuns: other });
        continue;
      }
      if (before === null) {
        const kept = this.keep(file, now);
        fs.rmSync(file, { force: true });
        violations.push({ file, action: "removed", suspects: running.map((a) => a.name), ...kept });
      } else {
        const kept = this.keep(file, now);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, before);
        violations.push({ file, action: "restored", suspects: running.map((a) => a.name), ...kept });
      }
    }
    this.checkRecords(running, violations, other);
    this.checkProposals(running, violations, other);
    return violations;
  }

  private checkRecords(running: ResolvedAgent[], violations: Violation[], other: string[]): void {
    const root = this.recordsRoot();
    // Never write through a symlinked parent of the records tree: skip its protection for this batch.
    if (isLink(path.dirname(root)) || isLink(path.dirname(path.dirname(root)))) return;
    const now = readTree(root);
    // A solo agent is the lead of a team of one, but it may not write the records: only a real lead may (spec 30, D-03).
    const authorized = !this.project.solo && running.some((a) => a.name === this.project.lead);
    const suspects = running.map((a) => a.name);
    const fixedDirs = new Set<string>();
    for (const file of new Set([...this.records.keys(), ...now.keys()])) {
      const before = this.records.get(file) ?? null;
      const cur = now.get(file) ?? null;
      if (same(before, cur)) continue;
      if (authorized) continue;
      if (other.length) {
        this.unattributed.push({ file, agents: suspects, otherRuns: other });
        continue;
      }
      const kept = this.keep(file, cur);
      if (before === null) {
        if (!insideRoot(root, path.dirname(file))) continue;
        fs.rmSync(file, { force: true });
        violations.push({ file, action: "removed", suspects, ...kept });
      } else {
        if (!this.realDirs(root, path.dirname(file), fixedDirs, suspects, violations)) continue;
        fs.rmSync(file, { recursive: true, force: true });
        fs.writeFileSync(file, before);
        violations.push({ file, action: "restored", suspects, ...kept });
      }
    }
    if (authorized || other.length) this.records = now;
  }

  /**
   * A solo agent may create and change only its own `proposals/<kind>/<short id>-<slug>.md`, and only while the file is
   * `proposed` (spec 30, D-03). Everything else under the proposals tree is put back: other prefixes, other folders,
   * `.archive/`, deletions, a file that was already decided (even one with its own prefix, e.g. after a resume), and a
   * write of `accepted` or `rejected`. A file that is merely badly formed is let through; D-09 flags it for the lead.
   * Not watched for an ordinary run: its members are held back by the write policy only (30.8).
   */
  private checkProposals(running: ResolvedAgent[], violations: Violation[], other: string[]): void {
    if (!this.project.solo) return;
    const prefix = this.ownPrefix();
    if (!prefix) return;
    const root = this.proposalsRoot();
    if (isLink(path.dirname(root)) || isLink(path.dirname(path.dirname(root)))) return;
    const now = readTree(root);
    const suspects = running.map((a) => a.name);
    const fixedDirs = new Set<string>();
    const theirs = new Set(this.opts.otherPrefixes?.(this.baseStamp) ?? []);
    const own = new RegExp(`^(?:lessons|decisions)${escapeRe(path.sep)}${escapeRe(prefix)}-[a-z0-9-]+\\.md$`);
    for (const file of new Set([...this.proposals.keys(), ...now.keys()])) {
      const before = this.proposals.get(file) ?? null;
      const cur = now.get(file) ?? null;
      if (same(before, cur)) continue;
      if (other.length) {
        this.unattributed.push({ file, agents: suspects, otherRuns: other });
        continue;
      }
      // A proposal of another live or just-finished call is that call's own, not a change by this agent.
      if (theirs.has(prefixOf(path.basename(file)))) continue;
      let ok = own.test(path.relative(root, file));
      if (ok && before && proposalStatusOf(before) !== "proposed" && proposalStatusOf(before) !== undefined) ok = false;
      if (ok && cur) {
        const st = proposalStatusOf(cur);
        if (st === "accepted" || st === "rejected") ok = false;
      }
      if (ok) continue;
      const kept = this.keep(file, cur);
      if (before === null) {
        if (!insideRoot(root, path.dirname(file))) continue;
        fs.rmSync(file, { force: true });
        violations.push({ file, action: "removed", suspects, ...kept });
      } else {
        if (!this.realDirs(root, path.dirname(file), fixedDirs, suspects, violations)) continue;
        fs.rmSync(file, { recursive: true, force: true });
        fs.writeFileSync(file, before);
        violations.push({ file, action: "restored", suspects, ...kept });
      }
    }
    this.proposals = readTree(root);
  }

  /**
   * Make every directory from the records root down to `dir` a real directory. A symlink or file standing in for one is an
   * unauthorized change: unlink it (never follow it), recreate the directory and report it. False when `dir` is not safe to write into.
   */
  private realDirs(root: string, dir: string, done: Set<string>, suspects: string[], violations: Violation[]): boolean {
    const rel = path.relative(root, dir);
    if (escapesParent(rel)) return false;
    let cur = root;
    for (const part of ["", ...(rel ? rel.split(path.sep) : [])]) {
      cur = part ? path.join(cur, part) : cur;
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(cur);
      } catch {}
      if (st?.isDirectory()) continue;
      if (st) {
        fs.rmSync(cur, { force: true });
        if (!done.has(cur)) violations.push({ file: cur, action: "removed", suspects, ...this.keep(cur, null) });
        done.add(cur);
      }
      fs.mkdirSync(cur, { recursive: true });
    }
    return insideRoot(root, dir);
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function insideRoot(root: string, dir: string): boolean {
  try {
    const r = path.relative(fs.realpathSync(root), fs.realpathSync(dir));
    return !escapesParent(r);
  } catch {
    return false;
  }
}

/** Regular files under `dir`, recursively; symlinks and special files are not followed or read. */
function readTree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  try {
    if (!fs.lstatSync(dir).isDirectory()) return out; // a symlinked root is never walked
  } catch {
    return out;
  }
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const f = path.join(d, n);
      try {
        const st = fs.lstatSync(f);
        if (st.isDirectory()) walk(f);
        else if (st.isFile()) {
          const buf = readRegularFileNoFollow(f);
          if (buf) out.set(f, buf);
        }
      } catch {
        // vanished while scanning
      }
    }
  };
  walk(dir);
  return out;
}

const GUARD_READ_MAX = MAX_KEEP_BYTES * 2;

/** A FIFO, device, directory, or a symlink to one. Opening it would block or is not a file the guard can compare. */
function unsafeToRead(file: string): boolean {
  let fd: number | undefined;
  try {
    const listed = fs.lstatSync(file);
    if (listed.isFIFO() || listed.isSocket() || listed.isCharacterDevice() || listed.isBlockDevice() || listed.isDirectory()) return true;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    return !fs.fstatSync(fd).isFile();
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

function read(file: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > GUARD_READ_MAX) return null;
    return fs.readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

function same(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}
