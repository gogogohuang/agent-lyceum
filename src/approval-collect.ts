import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pidStart } from './project-lock.js';
import { creatorLiveness, defaultProbe, type CreatorProbe } from './approval-liveness.js';
import { type CollectOp, type DirIo, SCAN_WORK_BUDGET, ScanBudgetExceeded, budgetedIo, defaultDirIo, scanBudget } from './approval-budget.js';
import { ApprovalError } from './approval-error.js';
import type { ExecutorsConfig } from './approval-executors.js';
import { advanceHighWater, readHighWater } from './approval-high-water.js';
import { approvalId, isRequestFilename } from './approval-id.js';
import { assertRealDir, publishExclusive, readApprovalFile } from './approval-io.js';
import { checkApprovalLinks } from './approval-link-check.js';
import { type SnapshotInput, qualificationHash } from './approval-origin.js';
import { type SlotRef, requestPaths, storePaths } from './approval-paths.js';
import { GLOBAL_READ_CAP, parseRequest } from './approval-request.js';
import { CoordHeldError, type RotationDestination, createRotation } from './approval-rotation.js';
import { type StoreFaultPoint, publishRecord, readRecord } from './approval-store.js';
import { readCurrent, transition } from './approval-state.js';
import type { Actor, ApprovalRecord, DeniedReason, Origin, PremiseResult, Sequence, SourceBase, SourceKey } from './approval-types.js';
import type { GateVerdict } from './approval-wake-gate.js';
import { readRegularFileCappedNoFollow } from './fs-util.js';

/**
 * Collection core (spec 4.4, plan S2/D2-D5/D9). One pass per slot, synchronous, under the slot's `.coord` lock and a bounded fs-call
 * budget (D3). It finishes every un-`.done` `collected/<seq>`, then (when it may) rotates `proposals/` and processes the new directory.
 * Nothing here wires into a run (S3). Re-entry after a crash at any point is safe: ids are deterministic, `record.json` is the
 * commit point and is never overwritten, `.done` is written last and only after every kept entry has a record.
 *
 * Failures never escape: they become a `skipped` verdict (the slot is not woken) and one `approval_collect` log line that carries
 * fixed classes only, never a path, an errno text, a file name or a payload (D9).
 */

export type CollectClass = 'held' | 'not_directory' | 'symlink' | 'missing' | 'corrupt' | 'unsupported' | 'permission' |
  'race' | 'mismatch' | 'budget' | 'cancelled' | 'io';
export interface CollectLog { readonly slot: string; readonly op: CollectOp; readonly class: CollectClass;
  readonly seq?: number; readonly id?: string; readonly count?: number }
export interface CollectInput {
  readonly home: string; readonly slot: SlotRef; readonly agent: string; readonly runDir: string;
  readonly config: ExecutorsConfig; readonly origin: Origin; readonly inputs: ReadonlyMap<string, SnapshotInput>;
  readonly premises: readonly PremiseResult[];
  /** What the slot's latest attempt says about output found in `proposals/`; absent = leftover output is undeterminable (prepare) / collectable (collect). */
  readonly current?: { readonly attemptId: string; readonly outcome: 'collect' | 'park' };
}
export interface CollectDeps {
  readonly io: DirIo; readonly budget: number; readonly now: () => Date; readonly token: () => string;
  readonly actor: () => Actor; readonly probe: CreatorProbe;
  /** A throw simulates a process crash at that point. */
  readonly fault: (point: string) => void;
  readonly log: (event: 'approval_collect', fields: CollectLog) => void;
}
export interface CollectResult { readonly created: number; readonly existing: number; readonly denied: number; readonly verdict: GateVerdict }

export function defaultCollectDeps(log: CollectDeps['log']): CollectDeps {
  return { io: defaultDirIo, budget: SCAN_WORK_BUDGET, now: () => new Date(), token: () => `${process.pid}-${Math.random().toString(36).slice(2)}`,
    actor: () => ({ user: os.userInfo().username, tty: null, pid: process.pid, pid_started: pidStart(process.pid) ?? null }),
    probe: defaultProbe, fault: () => undefined, log };
}

/** Denied requests of one (project or call, role) keep a full record up to this count; later ones are only counted. */
export const DENIED_FULL_RECORDS = 100;
const ID_RE = /^[0-9a-f]{24}$/;
const DAY_MS = 86_400_000;
const DENIED_COUNT_LIMIT = 32;

/** The directory/file under a slot changed while it was being processed; retry in a later pass. */
class Race extends Error {}
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const codeOf = (e: unknown): string | undefined => {
  const code = (e as NodeJS.ErrnoException | null)?.code ?? ((e as { cause?: unknown } | null)?.cause as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
};

type Cand = { readonly name: string; readonly st: fs.Stats };
const before = (a: Cand, b: Cand): boolean => a.st.mtimeMs < b.st.mtimeMs || (a.st.mtimeMs === b.st.mtimeMs && Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)) < 0);

/** Store/io helpers re-wrap what their fs calls throw (with `cause`); a budget stop or a race inside one must still read as itself. */
function rootOf(e: unknown): unknown {
  let cur = e;
  for (let depth = 0; depth < 4 && cur !== null && typeof cur === 'object' && 'cause' in cur; depth++) {
    const next = (cur as { cause?: unknown }).cause;
    if (next instanceof ScanBudgetExceeded || next instanceof Race) return next;
    cur = next;
  }
  return e;
}

function classOf(raw: unknown): CollectClass {
  const e = rootOf(raw);
  if (e instanceof ScanBudgetExceeded) return 'budget';
  if (e instanceof Race) return 'race';
  if (e instanceof CoordHeldError) return 'held';
  if (e instanceof ApprovalError) {
    switch (e.code) {
      case 'UNSAFE_PATH': return 'not_directory';
      case 'UNSUPPORTED_LINK': return 'unsupported';
      case 'CORRUPT_HIGH_WATER': case 'CORRUPT_RECORD': case 'CORRUPT_STATE': return 'corrupt';
      case 'PAYLOAD_MISMATCH': case 'SOURCE_MISMATCH': return 'mismatch';
      default: break;
    }
  }
  const code = codeOf(e);
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  if (code === 'ENOENT') return 'race';
  if (code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EXDEV' || code === 'ENOSYS') return 'unsupported';
  if (code === 'ELOOP') return 'symlink';
  if (code === 'ENOTDIR') return 'not_directory';
  return 'io';
}

/** Only errors this module can explain are "known"; anything else is an unexpected throw and means the slot state is undeterminable. */
const known = (e: unknown): boolean => e instanceof ScanBudgetExceeded || e instanceof Race || e instanceof ApprovalError || codeOf(e) !== undefined;

const DIRECTORY_OPS = new Set<CollectOp>(['coord', 'high_water', 'link_probe', 'rotate', 'park', 'list']);

function verdictFor(raw: unknown, op: CollectOp): GateVerdict {
  const e = rootOf(raw);
  const skip = (code: 'DIR_ANOMALY' | 'RESIDUAL_OUTPUT' | 'UNDETERMINABLE'): GateVerdict => ({ kind: 'skipped', code });
  if (!known(e)) return skip('UNDETERMINABLE');
  if (op === 'inventory') return skip('UNDETERMINABLE');
  if (e instanceof ScanBudgetExceeded || e instanceof Race) return skip('RESIDUAL_OUTPUT');
  const cls = classOf(e);
  if (DIRECTORY_OPS.has(op) || cls === 'held' || cls === 'not_directory' || cls === 'symlink' || cls === 'unsupported') return skip('DIR_ANOMALY');
  return skip('RESIDUAL_OUTPUT');
}

/** Runs one pass. `mode` decides what an unexplained non-empty `proposals/` means: prepare refuses it, collect collects it. */
function runPass(input: CollectInput, deps: CollectDeps, mode: 'collect' | 'prepare'): CollectResult & { proposals?: string } {
  const { home, config } = input;
  const tally = { created: 0, existing: 0, denied: 0 };
  const budget = scanBudget(deps.budget);
  const bio = budgetedIo(deps.io, budget);
  // The lock is taken and released on the unbudgeted io: running out of budget must never leave a `.coord` behind.
  const coord = createRotation({ io: deps.io, fault: deps.fault });
  const work = createRotation({ io: bio, fault: deps.fault });
  const slotName = input.slot.kind === 'run' ? input.slot.slot : input.agent;
  const p = requestPaths(home, input.slot);
  const approvals = storePaths(home).approvals;
  let seq: number | undefined;
  let id: string | undefined;
  const phase = (op: CollectOp): void => { budget.op = op; };
  const done = (verdict: GateVerdict, proposals?: string): CollectResult & { proposals?: string } =>
    ({ ...tally, verdict, ...(proposals === undefined ? {} : { proposals }) });

  if (input.premises.some((x) => !x.ok)) return done({ kind: 'skipped', code: 'PREMISE_FAILED' }); // nothing is touched, nothing is denied

  const base = (n: Sequence): SourceBase => (input.slot.kind === 'run'
    ? { kind: 'run', source_id: input.slot.run_id, slot: input.slot.slot, seq: n }
    : { kind: 'call', source_id: input.slot.call_id, slot: input.agent, seq: n });
  const proposer = { role: input.origin.role, slot: slotName };

  let linksChecked = false;
  const ensureLinks = (): void => {
    if (linksChecked) return;
    phase('link_probe');
    try { bio.mkdirSync(approvals, { mode: 0o700 }); } catch (e) { if (codeOf(e) !== 'EEXIST') throw e; }
    assertRealDir(bio, approvals);
    checkApprovalLinks(home, p.root, { io: bio, token: deps.token });
    checkApprovalLinks(home, approvals, { io: bio, token: deps.token });
    linksChecked = true;
  };

  // ---- quota inventory (lazy, once per pass; D3) ----
  type Counts = { total: number; groups: Map<string, number> };
  let counts: Counts | undefined;
  const groupKey = (o: Origin, executor: string): string =>
    JSON.stringify([o.kind, o.kind === 'run' ? o.project : '', o.role, executor]);
  const inventory = (): Counts => {
    if (counts) return counts;
    phase('inventory');
    const out: Counts = { total: 0, groups: new Map() };
    let names: string[] = [];
    try {
      assertRealDir(bio, approvals);
      names = bio.readdirSync(approvals) as string[];
    } catch (e) {
      if (codeOf(e) !== 'ENOENT') throw e;
    }
    const nowMs = deps.now().getTime();
    for (const name of names) {
      if (!ID_RE.test(name)) continue;
      // Payload-only directories from interrupted publication have no committed occupancy.
      if (readRecord(home, name, bio) === null) continue;
      let cur: ReturnType<typeof readCurrent>;
      try { cur = readCurrent(home, name, bio); } catch (error) {
        if (rootOf(error) instanceof ScanBudgetExceeded) throw error;
        throw new ApprovalError('CORRUPT_STATE', 'Committed approval state is unreadable', undefined, { cause: error });
      }
      const origin = cur.record.origin;
      const needsLazy = (cur.n === 0 && cur.record.disposition === 'pending' && nowMs > Date.parse(cur.record.expires_at)) || cur.state?.status === 'executing';
      if (needsLazy && origin.kind === input.origin.kind && origin.role === input.origin.role &&
          (origin.kind !== 'run' || (input.origin.kind === 'run' && origin.project === input.origin.project))) {
        const result = transition(home, name, latest => {
          const at = deps.now().getTime();
          const state = latest.state;
          const creator = state?.status === 'executing'
            ? creatorLiveness(state.owner, state.updated_at, state.timeout_sec, at, deps.probe) : null;
          return { event: { type: 'lazy', trigger: 'collect', creator }, context: { now_ms: at, actor: deps.actor() } };
        }, { io: bio, token: deps.token, fault: pt => deps.fault(pt) });
        if (result.kind === 'contended') throw new Race();
        cur = result.current;
      }
      const rec = cur.record;
      if (rec.disposition !== 'pending') continue;
      const status = cur.n === 0 ? 'pending' : (cur.state?.status ?? 'pending');
      if (status === 'pending' ? nowMs > Date.parse(rec.expires_at) : status !== 'executing' && status !== 'unknown') continue;
      out.total += 1;
      const k = groupKey(rec.origin, rec.executor);
      out.groups.set(k, (out.groups.get(k) ?? 0) + 1);
    }
    counts = out;
    return out;
  };

  // ---- denied counter (approximate, one file per project/call + role) ----
  const counterFile = (): string => {
    const o = input.origin;
    return o.kind === 'run' ? path.join(storePaths(home).denied_count, 'run', o.project, o.role) : path.join(storePaths(home).denied_count, 'call', o.role);
  };
  const readDenied = (): number => {
    const buf = readApprovalFile(counterFile(), DENIED_COUNT_LIMIT, home, bio);
    if (buf === null) return 0;
    const m = /^(0|[1-9][0-9]*)\n$/.exec(buf.toString('utf8'));
    const n = m ? Number(m[1]) : Number.NaN;
    if (!m || !Number.isSafeInteger(n)) throw new ApprovalError('CORRUPT_RECORD', 'Denied counter is not a decimal number', counterFile());
    return n;
  };
  const writeDenied = (n: number): void => {
    const file = counterFile();
    let cur = home;
    for (const part of path.relative(home, path.dirname(file)).split(path.sep)) {
      cur = path.join(cur, part);
      try { bio.mkdirSync(cur, { mode: 0o700 }); } catch (e) { if (codeOf(e) !== 'EEXIST') throw e; }
      assertRealDir(bio, cur);
    }
    const tmp = path.join(path.dirname(file), `.count-${deps.token()}.tmp`);
    const c = fs.constants;
    const fd = bio.openSync(tmp, c.O_CREAT | c.O_EXCL | c.O_WRONLY | c.O_NOFOLLOW, 0o600);
    try {
      try { bio.writeSync(fd, Buffer.from(`${n}\n`, 'utf8')); }
      finally { bio.closeSync(fd); }
      bio.renameSync(tmp, file);
    } catch (e) {
      try { bio.unlinkSync(tmp); } catch { /* own temp only */ }
      throw e;
    }
  };

  // ---- records ----
  const storeDeps = { io: bio, token: deps.token, fault: (pt: StoreFaultPoint) => deps.fault(pt) };
  const stamp = (): { created_at: string; at: Date } => { const at = deps.now(); return { created_at: at.toISOString(), at }; };
  const publishDenied = (key: SourceKey, reason: DeniedReason, ignored: number | null): void => {
    phase('publish');
    id = approvalId(key);
    if (readRecord(home, id, bio) !== null) { tally.existing += 1; return; }
    phase('counter');
    const seen = readDenied();
    phase('publish');
    if (seen < DENIED_FULL_RECORDS) {
      const { created_at } = stamp();
      const record = { schema_version: 1, id, source_key: key, origin: input.origin, proposer, created_at,
        expires_at: created_at, executor: null, summary: null, payload_sha256: null, payload_bytes: null, qualification: null,
        disposition: 'denied', reason, ignored_count: ignored } as ApprovalRecord;
      if (publishRecord(home, record, null, storeDeps).kind === 'existing') { tally.existing += 1; return; }
    }
    phase('counter');
    writeDenied(seen + 1);
    tally.denied += 1;
  };

  /** Hash and copy come from the same Buffer. Existing record first (re-entry adopts it, quota never re-applies), then allow, then quota. */
  const publishRequest = (n: Sequence, name: string, bytes: Buffer): void => {
    const bytesKey = (reason: Exclude<DeniedReason, 'not_regular' | 'scan_limit'>): SourceKey =>
      ({ ...base(n), variant: 'denied_bytes', filename: name, reason, request_sha256: sha256(bytes) });
    phase('publish');
    // Look up every byte-derived committed variant before parsing against mutable config.
    const sep = bytes.indexOf('\n\n');
    const payloadKey: SourceKey | undefined = sep < 0 ? undefined
      : { ...base(n), variant: 'payload', filename: name, payload_sha256: sha256(bytes.subarray(sep + 2)) };
    const reasons = ['bad_content', 'bad_header', 'bad_executor', 'too_large', 'not_allowed', 'quota'] as const;
    for (const candidate of [...(payloadKey ? [payloadKey] : []), ...reasons.map(bytesKey)]) {
      id = approvalId(candidate);
      if (readRecord(home, id, bio) !== null) { tally.existing += 1; return; }
    }
    const parsed = parseRequest(bytes, config);
    if (parsed.kind === 'denied') { publishDenied(bytesKey(parsed.reason), parsed.reason, null); return; }
    const key: SourceKey = { ...base(n), variant: 'payload', filename: name, payload_sha256: sha256(parsed.payload) };
    id = approvalId(key);
    const snapshot = input.inputs.get(parsed.executor);
    if (!snapshot) { publishDenied(bytesKey('not_allowed'), 'not_allowed', null); return; }
    const executor = config.executors[parsed.executor];
    if (!executor) { publishDenied(bytesKey('bad_executor'), 'bad_executor', null); return; }
    const inv = inventory();
    phase('publish');
    const k = groupKey(input.origin, parsed.executor);
    if ((inv.groups.get(k) ?? 0) >= executor.max_pending || inv.total >= config.limits.max_total_pending) {
      publishDenied(bytesKey('quota'), 'quota', null);
      return;
    }
    const { created_at, at } = stamp();
    const record: ApprovalRecord = {
      schema_version: 1, id, source_key: key, origin: input.origin, proposer, created_at,
      expires_at: new Date(at.getTime() + executor.expires_days * DAY_MS).toISOString(),
      executor: parsed.executor, summary: parsed.summary, payload_sha256: sha256(parsed.payload), payload_bytes: parsed.payload.length,
      qualification: { schema_version: 1, sha256: qualificationHash(snapshot), premises: [...input.premises] }, disposition: 'pending',
    };
    const out = publishRecord(home, record, parsed.payload, storeDeps);
    if (out.kind === 'created') {
      tally.created += 1;
      inv.total += 1;
      inv.groups.set(k, (inv.groups.get(k) ?? 0) + 1);
    } else tally.existing += 1;
  };

  // ---- one collected/<seq> directory ----
  const lstatReal = (file: string): fs.Stats => {
    try { return bio.lstatSync(file); } catch (e) { if (codeOf(e) === 'ENOENT') throw new Race(); throw e; }
  };

  const processDir = (n: Sequence): void => {
    seq = n;
    const dir = path.join(p.collected, String(n));
    phase('scan');
    if (!lstatReal(dir).isDirectory()) throw new ApprovalError('UNSAFE_PATH', 'Collected entry is not a real directory'); // a swapped-in link is never read through
    ensureLinks();
    phase('scan');
    const cap = config.limits.max_scan_entries;
    const kept: Cand[] = [];
    let total = 0;
    const d = bio.opendirSync(dir);
    try {
      for (let ent = d.readSync(); ent !== null; ent = d.readSync()) {
        if (!isRequestFilename(ent.name)) continue; // one unit for the dirent, never stat'ed, never a record
        const cand: Cand = { name: ent.name, st: lstatReal(path.join(dir, ent.name)) };
        total += 1;
        // Max-heap: the newest retained candidate is at the root, O(log cap) per entry.
        if (kept.length < cap) {
          kept.push(cand);
          let at = kept.length - 1;
          while (at > 0) {
            const parent = Math.floor((at - 1) / 2);
            if (!before(kept[parent] as Cand, kept[at] as Cand)) break;
            [kept[parent], kept[at]] = [kept[at] as Cand, kept[parent] as Cand];
            at = parent;
          }
        } else if (cap > 0 && before(cand, kept[0] as Cand)) {
          kept[0] = cand;
          let at = 0;
          for (;;) {
            const left = at * 2 + 1;
            if (left >= kept.length) break;
            const right = left + 1;
            const child = right < kept.length && before(kept[left] as Cand, kept[right] as Cand) ? right : left;
            if (!before(kept[at] as Cand, kept[child] as Cand)) break;
            [kept[at], kept[child]] = [kept[child] as Cand, kept[at] as Cand];
            at = child;
          }
        }
      }
    } finally {
      d.closeSync();
    }
    deps.fault('collection:enumerated');
    kept.sort((a, b) => before(a, b) ? -1 : before(b, a) ? 1 : 0);
    for (const cand of kept) {
      const file = path.join(dir, cand.name);
      const entry = (): SourceKey => ({ ...base(n), variant: 'denied_entry', filename: cand.name, reason: 'not_regular' });
      if (!cand.st.isFile()) { publishDenied(entry(), 'not_regular', null); continue; }
      phase('read');
      const r = readRegularFileCappedNoFollow(file, GLOBAL_READ_CAP, () => budget.spend());
      if (!r.ok) {
        if (r.reason === 'symlink' || r.reason === 'not_regular') { publishDenied(entry(), 'not_regular', null); continue; }
        const code = r.reason.startsWith('open_error:') ? r.reason.slice('open_error:'.length) : 'EIO';
        if (code === 'ENOENT') throw new Race();
        throw Object.assign(new Error('read failed'), { code });
      }
      const after = lstatReal(file);
      if (r.ino !== cand.st.ino || r.dev !== cand.st.dev || !after.isFile() || after.ino !== r.ino || after.dev !== r.dev) throw new Race();
      if (r.truncated || r.size > GLOBAL_READ_CAP) {
        publishDenied({ ...base(n), variant: 'denied_size', filename: cand.name, reason: 'too_large', size: r.size }, 'too_large', null);
        continue;
      }
      publishRequest(n, cand.name, r.buf);
    }
    if (total > kept.length) publishDenied({ ...base(n), variant: 'denied_scan', reason: 'scan_limit' }, 'scan_limit', total - kept.length);
    phase('done');
    deps.fault('collection:before-done');
    publishExclusive(path.join(p.collected, `${n}.done`), Buffer.from('done\n', 'utf8'), { root: home, io: bio, token: deps.token });
    deps.fault('collection:done');
    id = undefined;
  };

  // ---- the pass ----
  const body = (): string => {
    phase('high_water');
    const persisted = readHighWater(p.root, home, bio);
    phase('list');
    let names: string[] = [];
    try {
      if (!bio.lstatSync(p.collected).isDirectory()) throw new ApprovalError('UNSAFE_PATH', 'collected is not a real directory');
      names = bio.readdirSync(p.collected) as string[];
    } catch (e) {
      if (codeOf(e) !== 'ENOENT') throw e;
    }
    const dirs = new Set<number>();
    const marked = new Set<number>();
    let max = persisted;
    for (const name of names) {
      const m = /^([0-9]+)(\.done)?$/.exec(name);
      if (!m) continue;
      const num = Number(m[1]);
      if (!/^[1-9][0-9]*$/.test(m[1] as string) || !Number.isSafeInteger(num)) throw new ApprovalError('CORRUPT_HIGH_WATER', 'Alias or overflow sequence name');
      (m[2] ? marked : dirs).add(num);
      if (num > max) max = num;
    }
    for (const n of [...dirs].sort((a, b) => a - b)) if (!marked.has(n)) processDir(n);
    // After the old directories are finished (a pass cut short by the budget changes nothing): a crash between a rotation and its high-water advance leaves the directory ahead of `collected.seq`: catch the file up.
    if (max > persisted) { phase('high_water'); advanceHighWater(p.root, max, { root: home, io: bio, token: deps.token }); }

    // Rotate what the slot's latest wake left behind.
    phase('rotate');
    const proposalsState = (): 'missing' | 'empty' | 'nonempty' => {
      let st: fs.Stats;
      try { st = bio.lstatSync(p.proposals); } catch (e) { if (codeOf(e) === 'ENOENT') return 'missing'; throw e; }
      if (!st.isDirectory()) throw new ApprovalError('UNSAFE_PATH', 'proposals is not a real directory');
      const d = bio.opendirSync(p.proposals);
      try { return d.readSync() === null ? 'empty' : 'nonempty'; } finally { d.closeSync(); }
    };
    if (mode === 'prepare' && input.current === undefined && proposalsState() === 'nonempty') {
      throw Object.assign(new Error('undeterminable'), { undeterminable: true });
    }
    if (max >= Number.MAX_SAFE_INTEGER) throw new ApprovalError('SEQUENCE_OVERFLOW', 'Slot sequence would exceed the safe integer range');
    const dest: RotationDestination = input.current?.outcome === 'park'
      ? { kind: 'parked', attempt_id: input.current.attemptId }
      : { kind: 'collected', seq: max + 1 };
    const rotated = work.rotate(home, input.slot, dest);
    if (rotated.kind === 'rotated' && dest.kind === 'collected') {
      deps.fault('collection:high-water');
      processDir(dest.seq);
    }
    return rotated.proposals;
  };

  try {
    phase('coord');
    return done({ kind: 'wake' }, coord.withSlotCoord(home, input.slot, body));
  } catch (e) {
    const op = budget.op;
    const undeterminable = (e as { undeterminable?: boolean } | null)?.undeterminable === true;
    const fields: CollectLog = { slot: slotName, op, class: undeterminable ? 'io' : classOf(e), ...(seq === undefined ? {} : { seq }),
      ...(id === undefined ? {} : { id }), count: budget.used };
    try { deps.log('approval_collect', fields); } catch { /* logging must never change the verdict */ }
    return done(undeterminable ? { kind: 'skipped', code: 'UNDETERMINABLE' } : verdictFor(e, op));
  }
}

/** Settle-time collection: finish un-done directories, then rotate and process the slot's new output. Never throws. */
export function collectSlot(input: CollectInput, deps: CollectDeps): CollectResult {
  const { proposals: _p, ...result } = runPass(input, deps, 'collect');
  return result;
}

/** Pre-wake: as `collectSlot`, but undetermined leftover output is refused. On `wake`, `proposals` is the canonical, existing, empty directory. Never throws. */
export function prepareSlot(input: CollectInput, deps: CollectDeps): CollectResult & { proposals?: string } {
  return runPass(input, deps, 'prepare');
}
