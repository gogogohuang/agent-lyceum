import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { readRegularFileNoFollow } from "./fs-util.js";
import { escapesParent } from "./paths.js";
import { mayEditProtected, recordsDir, repoInstructionFiles, sharedContextFiles, sharedIndex } from "./policy.js";

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
  /** Other runs that were live at the last `rebase()` (or at `check()` time); computed once per batch. */
  private liveAtBase: string[] = [];

  /** `otherLiveRuns`: ids of the project's other runs that have a live lock holder right now. */
  constructor(
    private project: ResolvedProject,
    private otherLiveRuns: () => string[] = () => [],
  ) {
    this.rebase();
  }

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
    this.liveAtBase = this.otherLiveRuns();
    for (const f of ProtectedGuard.protectedFiles(this.project)) this.baseline.set(f, read(f));
    this.records = readTree(recordsDir(this.project));
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
    const run = this.project.run;
    if (!content || !run) return {};
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const dir = path.join(run.dir, "violations");
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
    const other = [...new Set([...this.liveAtBase, ...this.otherLiveRuns()])];
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
    return violations;
  }

  private checkRecords(running: ResolvedAgent[], violations: Violation[], other: string[]): void {
    const root = recordsDir(this.project);
    // Never write through a symlinked parent of the records tree: skip its protection for this batch.
    if (isLink(path.dirname(root)) || isLink(path.dirname(path.dirname(root)))) return;
    const now = readTree(root);
    const authorized = running.some((a) => a.name === this.project.lead);
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
