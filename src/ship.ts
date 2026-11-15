import fs from "node:fs";
import path from "node:path";
import { canonicalPath } from "./paths.js";
import { runCommand, tailText, VERIFY_TAIL_BYTES } from "./verify.js";

export interface ShipEdit {
  path: string;
  search: string;
  replace: string;
  replace_all?: boolean;
}

export type ShipStatus = "SHIPPED_AND_VERIFIED" | "ABORTED_BEFORE_WRITE" | "FAILED_AND_ROLLED_BACK" | "FAILED_ROLLBACK_PARTIAL";

export interface ShipResult {
  status: ShipStatus;
  summary: string;
  filesModified: string[];
}

export interface ShipVerifyOutcome {
  ok: boolean;
  exit: number | null;
  output: string;
  /** The verify run was cancelled through the signal; its verdict is withheld and the edits are rolled back. */
  cancelled?: boolean;
}

export type ShipVerifyRunner = (cmd: string, cwd: string, timeoutSec: number, signal?: AbortSignal) => Promise<ShipVerifyOutcome>;

export interface RunShipArgs {
  root: string;
  edits: ShipEdit[];
  verify: string;
  timeoutSec?: number;
  /** Absolute paths (and their descendants) ship must not write. */
  deny?: string[];
  /** Injected for tests; default runs `sh -c` via `runCommand`. */
  runVerify?: ShipVerifyRunner;
  /** Aborts a running verify; ship then rolls every edit back. Process signal handlers belong to the CLI, not here. */
  signal?: AbortSignal;
}

/** True when `abs` equals or sits under a deny entry (canonical comparison). */
export function isDeniedPath(abs: string, deny: string[] | undefined): boolean {
  if (!deny?.length) return false;
  let target: string;
  try {
    target = canonicalPath(abs);
  } catch {
    target = path.resolve(abs);
  }
  for (const d of deny) {
    let denied: string;
    try {
      denied = canonicalPath(d);
    } catch {
      denied = path.resolve(d);
    }
    // Case-folded: on case-insensitive filesystems `SECRET/x` is the same file as `secret/x`.
    const t = target.toLowerCase();
    const dl = denied.toLowerCase();
    if (t === dl || t.startsWith(dl + path.sep)) return true;
  }
  return false;
}

interface Snapshot {
  rel: string;
  abs: string;
  existed: boolean;
  bytes: Buffer;
  mode?: number;
}

interface Planned {
  rel: string;
  abs: string;
  next: Buffer;
  snap: Snapshot;
}

function defaultVerify(cmd: string, cwd: string, timeoutSec: number, signal?: AbortSignal): Promise<ShipVerifyOutcome> {
  return runCommand(cmd, { cwd, timeoutSec, signal }).then((r) => {
    if (r.cancelled) return { ok: false, exit: null, output: "(cancelled)", cancelled: true };
    const output = tailText(r.output, VERIFY_TAIL_BYTES);
    if (r.timedOut) return { ok: false, exit: r.exit, output: `${output}\n(timed out)` };
    if (r.error) return { ok: false, exit: r.exit, output: r.error };
    return { ok: r.exit === 0, exit: r.exit, output };
  });
}

/** Resolve `rel` under `root`; reject escapes, leaf symlinks, and deny-list hits. */
export function resolveUnderRoot(
  root: string,
  rel: string,
  deny?: string[],
): { ok: true; abs: string; rel: string } | { ok: false; reason: string } {
  if (!rel || rel.includes("\0")) return { ok: false, reason: "path is empty or invalid" };
  if (path.isAbsolute(rel)) return { ok: false, reason: `path must be relative to the ship root: ${rel}` };
  const rootReal = canonicalPath(root);
  const abs = path.resolve(rootReal, rel);
  const relPosix = path.relative(rootReal, abs);
  if (relPosix === ".." || relPosix.startsWith(`..${path.sep}`) || path.isAbsolute(relPosix)) {
    return { ok: false, reason: `path escapes the ship root: ${rel}` };
  }
  // Refuse editing through symlinks (aliases to the same inode / escape). Missing path is fine.
  let check = abs;
  while (check !== rootReal && check !== path.dirname(check)) {
    try {
      if (fs.lstatSync(check).isSymbolicLink()) {
        return { ok: false, reason: `path must not be a symlink: ${rel}` };
      }
    } catch {
      /* missing */
    }
    check = path.dirname(check);
  }
  if (isDeniedPath(abs, deny)) return { ok: false, reason: `path is denied by write policy: ${rel}` };
  // Also refuse `.git` anywhere under the ship root (defence in depth).
  const parts = relPosix.split(path.sep);
  if (parts.some((part) => part.toLowerCase() === ".git")) return { ok: false, reason: `path must not touch .git: ${rel}` };
  return { ok: true, abs, rel: relPosix.split(path.sep).join("/") };
}

function countExact(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return n;
    n++;
    from = at + needle.length;
  }
}

/** Exact search/replace; ambiguous without `replace_all` is a miss. */
export function applyExactEdit(
  text: string,
  search: string,
  replace: string,
  replaceAll?: boolean,
): { ok: true; text: string; count: number } | { ok: false; message: string } {
  if (!search) return { ok: false, message: "search must not be empty" };
  const n = countExact(text, search);
  if (n === 0) return { ok: false, message: "search text not found" };
  if (n > 1 && !replaceAll) {
    return { ok: false, message: `search text matches ${n} places (ambiguous). Pass replace_all: true or add neighbouring context.` };
  }
  if (replaceAll) return { ok: true, text: text.split(search).join(replace), count: n };
  return { ok: true, text: text.replace(search, () => replace), count: 1 };
}

function snapshot(abs: string, rel: string): Snapshot {
  try {
    const st = fs.statSync(abs);
    const bytes = fs.readFileSync(abs);
    return { rel, abs, existed: true, bytes, mode: st.mode };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { rel, abs, existed: false, bytes: Buffer.alloc(0) };
    throw e;
  }
}

function restore(snaps: Snapshot[]): string[] {
  const errors: string[] = [];
  for (const s of snaps) {
    try {
      if (s.existed) {
        fs.mkdirSync(path.dirname(s.abs), { recursive: true });
        fs.writeFileSync(s.abs, s.bytes, s.mode !== undefined ? { mode: s.mode } : undefined);
        if (s.mode !== undefined) fs.chmodSync(s.abs, s.mode);
      } else if (fs.existsSync(s.abs)) {
        fs.unlinkSync(s.abs);
      }
    } catch (e) {
      errors.push(`${s.rel}: ${(e as Error).message}`);
    }
  }
  return errors;
}

/**
 * Apply multi-file exact edits under `root`, run verify, roll back on failure.
 * Pure relative to injected `runVerify` (tests); production uses `runCommand`.
 */
export async function runShip(args: RunShipArgs): Promise<ShipResult> {
  const root = canonicalPath(args.root);
  if (!args.verify?.trim()) {
    return { status: "ABORTED_BEFORE_WRITE", summary: "verify command is required", filesModified: [] };
  }
  if (!args.edits.length) {
    return { status: "ABORTED_BEFORE_WRITE", summary: "edits must not be empty", filesModified: [] };
  }

  const byFile = new Map<string, { abs: string; rel: string; edits: ShipEdit[] }>();
  const foldedSpelling = new Map<string, string>();
  for (const edit of args.edits) {
    const resolved = resolveUnderRoot(root, edit.path, args.deny);
    if (!resolved.ok) return { status: "ABORTED_BEFORE_WRITE", summary: resolved.reason, filesModified: [] };
    const folded = resolved.rel.toLowerCase();
    const prior = foldedSpelling.get(folded);
    if (prior !== undefined && prior !== resolved.rel) {
      return {
        status: "ABORTED_BEFORE_WRITE",
        summary: `paths differ only in letter case and may name one file on a case-insensitive filesystem: ${prior} vs ${resolved.rel}`,
        filesModified: [],
      };
    }
    foldedSpelling.set(folded, resolved.rel);
    const cur = byFile.get(resolved.rel) ?? { abs: resolved.abs, rel: resolved.rel, edits: [] };
    cur.edits.push(edit);
    byFile.set(resolved.rel, cur);
  }

  const planned: Planned[] = [];
  for (const file of byFile.values()) {
    const label = file.rel || ".";
    let snap: Snapshot;
    try {
      const st = fs.existsSync(file.abs) ? fs.statSync(file.abs) : undefined;
      if (st && !st.isFile()) {
        return { status: "ABORTED_BEFORE_WRITE", summary: `${label}: target is not a regular file`, filesModified: [] };
      }
      snap = snapshot(file.abs, file.rel);
    } catch (e) {
      return { status: "ABORTED_BEFORE_WRITE", summary: `${label}: cannot read target (${(e as Error).message})`, filesModified: [] };
    }
    let text = snap.existed ? snap.bytes.toString("utf8") : "";
    if (snap.existed && Buffer.from(text, "utf8").compare(snap.bytes) !== 0) {
      return { status: "ABORTED_BEFORE_WRITE", summary: `${file.rel}: file is not valid UTF-8 text`, filesModified: [] };
    }
    for (const edit of file.edits) {
      const out = applyExactEdit(text, edit.search, edit.replace, edit.replace_all);
      if (!out.ok) {
        return { status: "ABORTED_BEFORE_WRITE", summary: `${file.rel}: ${out.message}`, filesModified: [] };
      }
      text = out.text;
    }
    planned.push({ rel: file.rel, abs: file.abs, next: Buffer.from(text, "utf8"), snap });
  }

  // Track every file we intend to touch *before* mutating it, so a mid-write failure still rolls back.
  const written: Snapshot[] = [];
  const tmps: string[] = [];
  try {
    for (const p of planned) {
      written.push(p.snap);
      fs.mkdirSync(path.dirname(p.abs), { recursive: true });
      const tmp = `${p.abs}.agent-lyceum-ship.${process.pid}.${Date.now()}.tmp`;
      tmps.push(tmp);
      const writeOpts = p.snap.mode !== undefined ? { mode: p.snap.mode } : undefined;
      fs.writeFileSync(tmp, p.next, writeOpts);
      fs.renameSync(tmp, p.abs);
      tmps.pop();
    }
  } catch (e) {
    for (const t of tmps) {
      try {
        fs.unlinkSync(t);
      } catch {
        /* best-effort */
      }
    }
    const rollbackErrors = restore(written);
    const why = e instanceof Error ? e.message : String(e);
    if (rollbackErrors.length) {
      return {
        status: "FAILED_ROLLBACK_PARTIAL",
        summary: `Write failed (${why}); rollback incomplete: ${rollbackErrors.join("; ")}`,
        filesModified: written.map((s) => s.rel),
      };
    }
    return {
      status: "FAILED_AND_ROLLED_BACK",
      summary: `FAILED_AND_ROLLED_BACK: write failed (${why}). Restored ${written.length} file(s).`,
      filesModified: written.map((s) => s.rel),
    };
  }

  const filesModified = planned.map((p) => p.rel);
  const runVerify = args.runVerify ?? defaultVerify;
  // An abort that arrived before verify started (or that verify did not report) still ends in a restored tree.
  const verified: ShipVerifyOutcome = args.signal?.aborted
    ? { ok: false, exit: null, output: "", cancelled: true }
    : await runVerify(args.verify, root, args.timeoutSec ?? 120, args.signal);
  const cancelled = verified.cancelled === true || args.signal?.aborted === true;
  if (verified.ok && !cancelled) {
    return {
      status: "SHIPPED_AND_VERIFIED",
      summary: `Shipped ${filesModified.length} file(s); verify passed.\n${verified.output}`.trim(),
      filesModified,
    };
  }

  const rollbackErrors = restore(planned.map((p) => p.snap));
  const what = cancelled ? "ship was interrupted (verify cancelled)" : `verify failed (exit ${verified.exit})`;
  if (rollbackErrors.length) {
    return {
      status: "FAILED_ROLLBACK_PARTIAL",
      summary: `${what[0]!.toUpperCase()}${what.slice(1)}; rollback incomplete: ${rollbackErrors.join("; ")}\n${verified.output}`.trim(),
      filesModified,
    };
  }
  return {
    status: "FAILED_AND_ROLLED_BACK",
    summary: `FAILED_AND_ROLLED_BACK: ${what}. Restored ${filesModified.length} file(s).\n${verified.output}`.trim(),
    filesModified,
  };
}
