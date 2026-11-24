import type { Display } from './approval-display.js';
import type { ApprovalErrorCode } from './approval-error.js';
import { blockLines, passesAllowList, sanitizeExternal } from './approval-text.js';
import type {
  ApprovalRecord,
  ApprovalState,
  DeniedReason,
  IsoTime,
  Origin,
  SourceKey,
} from './approval-types.js';

export const PAGE_BYTES = 4096;

export interface PayloadPage {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

export function paginatePayload(payload: Buffer, pageBytes = PAGE_BYTES): PayloadPage[] {
  if (payload.length === 0) return [{ index: 0, start: 0, end: 0 }];
  const pages: PayloadPage[] = [];
  let start = 0;
  let index = 0;
  while (start < payload.length) {
    let end = Math.min(payload.length, start + pageBytes);
    if (end < payload.length && isContinuation(payload[end])) {
      while (end > start && isContinuation(payload[end])) end -= 1;
    }
    if (end === start) end = Math.min(payload.length, start + 1);
    pages.push({ index, start, end });
    start = end;
    index += 1;
  }
  return pages;
}

/**
 * Combining marks count as 1 and TAB always counts as 8, regardless of column.
 * Width only affects wrap position (appearance), not the payload content.
 */
export function cellWidth(codePoint: number): 1 | 2 | 8 {
  if (codePoint === 0x09) return 8;
  if (isWide(codePoint)) return 2;
  return 1;
}

export function renderPayloadPage(payload: Buffer, page: PayloadPage, columns: number): string[] {
  const width = Math.max(20, columns - 2);
  if (page.end <= page.start) return [];
  let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload.subarray(page.start, page.end));
  let lineStart = page.start === 0 || payload[page.start - 1] === 0x0a;
  if (!lineStart && text.startsWith('\n')) {
    text = text.slice(1);
    lineStart = true;
  }
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  const rows: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const trueLineStart = i === 0 ? lineStart : true;
    const prefix: '│ ' | '┆ ' = trueLineStart ? '│ ' : '┆ ';
    rows.push(...wrapRows(parts[i] ?? '', width, prefix));
  }
  return rows;
}

export function uniquePrefixLength(ids: readonly string[]): number {
  for (let length = 8; length < 24; length++) {
    const seen = new Set<string>();
    let unique = true;
    for (const id of ids) {
      const prefix = id.slice(0, length);
      if (seen.has(prefix)) {
        unique = false;
        break;
      }
      seen.add(prefix);
    }
    if (unique) return length;
  }
  return 24;
}

export function statusLabel(
  s: { readonly display: Display; readonly reason: DeniedReason | null } | { readonly corrupted: ApprovalErrorCode },
): string {
  if ('corrupted' in s) return `corrupted (${s.corrupted})`;
  if (s.display.persisted === 'denied') return `denied (${s.reason ?? 'denied'})`;
  if (s.display.unrecorded && s.display.persisted === 'pending' && s.display.computed === 'expired') {
    return 'expired (not yet recorded)';
  }
  if (s.display.unrecorded && s.display.persisted === 'executing' && s.display.computed === 'unknown') {
    return 'executing, creator dead (not yet recorded)';
  }
  return s.display.computed;
}

export function proposerLabel(origin: Origin): string {
  if (origin.kind === 'run') {
    return `${sanitizeExternal(origin.project)}:${sanitizeExternal(origin.role)} (run ${sanitizeExternal(origin.run_id)})`;
  }
  return `call:${sanitizeExternal(origin.role)} (call ${sanitizeExternal(origin.call_id)})`;
}

export interface ListRowModel {
  readonly kind: 'request';
  readonly id: string;
  readonly label: string;
  readonly executor: string | null;
  readonly origin: Origin;
  readonly created_at: IsoTime;
  readonly expires_at: IsoTime;
  readonly note: 'recorded' | { readonly failed: ApprovalErrorCode } | null;
}
export interface ListProblemModel {
  readonly kind: 'problem';
  readonly id: string;
  readonly code: ApprovalErrorCode;
  readonly path: string;
}
export interface ListModel {
  readonly all: boolean;
  readonly rows: readonly ListRowModel[];
  readonly problems: readonly ListProblemModel[];
  readonly hidden: number;
  readonly prefixLength: number;
}

export function renderList(m: ListModel): string {
  const requests = [...m.rows].sort((a, b) => compareText(a.created_at, b.created_at) || compareText(a.id, b.id));
  const problems = [...m.problems].sort((a, b) => compareText(a.id, b.id));
  const lines: string[] = [];
  if (requests.length === 0 && !(m.all && problems.length > 0)) {
    lines.push(m.all ? 'No approval requests.' : 'No pending approval requests.');
  }
  for (const row of requests) lines.push(requestLine(row, m.prefixLength));
  if (!m.all && m.hidden > 0) {
    lines.push(`${m.hidden} more request(s) not pending; approvals list --all shows every state.`);
  }
  for (const problem of problems) lines.push(problemLine(problem, m.prefixLength));
  return `${lines.join('\n')}\n`;
}

export type ExecutorView =
  | { readonly kind: 'ok'; readonly name: string; readonly real: string; readonly sha256: string }
  | { readonly kind: 'unregistered'; readonly name: string }
  | { readonly kind: 'config_error'; readonly name: string; readonly code: string }
  | { readonly kind: 'uninspectable'; readonly name: string; readonly configured: string; readonly code: string }
  | { readonly kind: 'none' };
export type PayloadView =
  | { readonly kind: 'bytes'; readonly bytes: Buffer; readonly observed_sha256: string }
  | { readonly kind: 'unreadable'; readonly code: ApprovalErrorCode }
  | { readonly kind: 'none' };
export interface ShowModel {
  readonly record: ApprovalRecord;
  readonly label: string;
  readonly payload: PayloadView;
  readonly executor: ExecutorView;
  readonly same: readonly { readonly id: string; readonly label: string }[];
  readonly prefixLength: number;
}

export function renderShow(m: ShowModel, columns: number): { readonly stdout: string; readonly withheld: boolean; readonly mismatch: boolean } {
  const record = m.record;
  const summary = showSummary(record.summary);
  const zone = payloadZone(record, m.payload, columns);
  const mismatch = record.disposition !== 'denied' && m.payload.kind === 'bytes' && m.payload.observed_sha256 !== record.payload_sha256;
  const lines = [
    `Approval ${record.id}`,
    `  status:   ${m.label}`,
    `  proposer: ${proposerLabel(record.origin)}  slot ${sanitizeExternal(record.proposer.slot)}`,
    `  created:  ${record.created_at}`,
    `  expires:  ${record.expires_at}`,
    payloadHeader(record, m.payload, mismatch),
  ];
  if (record.disposition !== 'denied') lines.push(samePayloadLine(m.same, m.prefixLength));
  lines.push('[agent statement, unverified]', ...summary.lines, '[executor]', ...executorLines(m.executor), ...zone.lines);
  return { stdout: `${lines.join('\n')}\n`, withheld: summary.withheld || zone.withheld, mismatch };
}

export type AuditEvent =
  | { readonly n: number; readonly state: ApprovalState }
  | { readonly n: number; readonly code: ApprovalErrorCode; readonly path: string };
export interface AuditModel {
  readonly record: ApprovalRecord;
  readonly events: readonly AuditEvent[];
  readonly current: string;
}

export function renderAudit(m: AuditModel): string {
  const record = m.record;
  const lines = [
    `Approval ${record.id}`,
    'record.json',
    field('disposition:', record.disposition === 'denied' ? `denied (${record.reason})` : 'pending'),
    field('source:', sourceValue(record.source_key)),
    field('origin:', `${proposerLabel(record.origin)}  dir ${sanitizeExternal(record.origin.project_dir)}`),
    ...writableLines(record.origin.full_writable),
    field('proposer:', `role ${sanitizeExternal(record.proposer.role)}  slot ${sanitizeExternal(record.proposer.slot)}`),
    field('executor:', record.executor === null ? '-' : sanitizeExternal(record.executor)),
    ...summaryField(record.summary),
    field('payload:', payloadFact(record)),
    field('created:', record.created_at),
    field('expires:', record.expires_at),
    ...qualificationLines(record),
    'state events',
  ];
  const events = [...m.events].sort((a, b) => a.n - b.n);
  if (events.length === 0) lines.push('  none (status comes from record.json)');
  for (const event of events) {
    if ('state' in event) {
      lines.push(eventHead(event.n, event.state), ...stateDetails(event.state));
    } else {
      lines.push(`  #${event.n}  corrupted (${event.code})  ${sanitizeExternal(event.path)}`);
    }
  }
  lines.push(`current: ${m.current}`);
  return `${lines.join('\n')}\n`;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function isWide(codePoint: number): boolean {
  return (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3041 && codePoint <= 0x33ff)
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xa000 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
    || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd);
}

function wrapRows(line: string, width: number, firstPrefix: '│ ' | '┆ '): string[] {
  if (line === '') return [firstPrefix];
  const rows: string[] = [];
  let buf = '';
  let col = 0;
  let first = true;
  for (const ch of line) {
    const w = cellWidth(ch.codePointAt(0) ?? 0);
    if (buf !== '' && col + w > width) {
      rows.push(`${first ? firstPrefix : '┆ '}${buf}`);
      first = false;
      buf = ch;
      col = w;
    } else {
      buf += ch;
      col += w;
    }
  }
  if (buf !== '') rows.push(`${first ? firstPrefix : '┆ '}${buf}`);
  return rows;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function noteSuffix(note: ListRowModel['note']): string {
  if (note === null) return '';
  if (note === 'recorded') return '  [recorded now]';
  return `  [not recorded: ${note.failed}]`;
}

function requestLine(row: ListRowModel, prefixLength: number): string {
  const executor = row.executor === null ? '-' : sanitizeExternal(row.executor);
  return `${row.id.slice(0, prefixLength)}  ${row.label}  ${executor}  ${proposerLabel(row.origin)}  created ${row.created_at}  expires ${row.expires_at}${noteSuffix(row.note)}`;
}

function problemLine(problem: ListProblemModel, prefixLength: number): string {
  const word = problem.code === 'CORRUPT_STATE' || problem.code === 'CORRUPT_RECORD' || problem.code === 'UNSUPPORTED_VERSION'
    ? 'corrupted'
    : 'unreadable';
  return `${problem.id.slice(0, prefixLength)}  ${word} (${problem.code})  ${sanitizeExternal(problem.path)}`;
}

function showSummary(summary: string | null): { lines: string[]; withheld: boolean } {
  if (summary === null) return { lines: ['(none)'], withheld: false };
  if (!passesAllowList(summary)) return { lines: ['(withheld: fails the request allow-list)'], withheld: true };
  const parts = summary.split('\n');
  if (summary.endsWith('\n')) parts.pop();
  if (parts.length === 0) return { lines: ['│ '], withheld: false };
  return { lines: parts.map((line) => `│ ${line}`), withheld: false };
}

function payloadHeader(record: ApprovalRecord, payload: PayloadView, mismatch: boolean): string {
  if (record.disposition === 'denied') {
    const extra = record.reason === 'scan_limit' && record.ignored_count !== null ? `, ${record.ignored_count} entries ignored` : '';
    return `  payload:  none (denied: ${record.reason}${extra})`;
  }
  const recorded = record.payload_sha256.slice(0, 16);
  if (payload.kind === 'unreadable') {
    return `  payload:  ${record.payload_bytes} bytes  sha256 ${recorded} (recorded)  unreadable (${payload.code})`;
  }
  if (payload.kind !== 'bytes') return `  payload:  ${record.payload_bytes} bytes  sha256 ${recorded} (recorded)`;
  const tail = mismatch ? '  MISMATCH' : '';
  return `  payload:  ${record.payload_bytes} bytes  sha256 ${recorded} (recorded)  ${payload.observed_sha256.slice(0, 16)} (read now)${tail}`;
}

function payloadZone(record: ApprovalRecord, payload: PayloadView, columns: number): { lines: string[]; withheld: boolean } {
  if (record.disposition === 'denied' || payload.kind === 'none') return { lines: ['(no payload)'], withheld: false };
  if (payload.kind === 'unreadable') return { lines: [`(payload unreadable: ${payload.code})`], withheld: false };
  const decoded = decodePayload(payload.bytes);
  if (decoded === null || !passesAllowList(decoded)) {
    return { lines: ['(withheld: fails the request allow-list)'], withheld: true };
  }
  if (payload.bytes.length === 0) {
    return { lines: ['[payload, complete content] empty (0 bytes)', '└ end of payload (0 bytes)'], withheld: false };
  }
  const pages = paginatePayload(payload.bytes);
  const lines: string[] = [];
  for (const page of pages) {
    lines.push(`[payload, complete content] page ${page.index + 1}/${pages.length}, bytes ${page.start}-${page.end - 1} of ${payload.bytes.length}`);
    lines.push(...renderPayloadPage(payload.bytes, page, columns));
  }
  const last = payload.bytes[payload.bytes.length - 1];
  const end = last === 0x0a
    ? `└ end of payload (${payload.bytes.length} bytes)`
    : `└ end of payload (${payload.bytes.length} bytes, no final newline)`;
  lines.push(end);
  return { lines, withheld: false };
}

function decodePayload(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function samePayloadLine(same: ShowModel['same'], prefixLength: number): string {
  if (same.length === 0) return '  same payload: none';
  const sorted = [...same].sort((a, b) => compareText(a.id, b.id));
  const shown = sorted.slice(0, 20);
  const parts: string[] = [];
  for (const item of shown) {
    const prefix = item.id.slice(0, prefixLength);
    parts.push(item.label === 'corrupted' || item.label.startsWith('corrupted ') ? `(${prefix} (corrupted))` : `${prefix} (${item.label})`);
  }
  const rest = sorted.length - shown.length;
  const more = rest > 0 ? `, … ${rest} more` : '';
  return `  same payload: ${parts.join(', ')}${more}`;
}

function executorLines(executor: ExecutorView): string[] {
  if (executor.kind === 'none') return ['  name:    -'];
  const name = sanitizeExternal(executor.name);
  if (executor.kind === 'unregistered') return [`  name:    ${name} (not registered)`];
  if (executor.kind === 'config_error') return [`  name:    ${name} (executors.yaml cannot be read: ${executor.code})`];
  if (executor.kind === 'uninspectable') {
    return [`  name:    ${name}`, `  command: ${sanitizeExternal(executor.configured)} (cannot be inspected: ${executor.code})`];
  }
  return [`  name:    ${name}`, `  command: ${sanitizeExternal(executor.real)}`, `  sha256:  ${executor.sha256}`];
}

function field(label: string, value: string): string {
  const head = `  ${label}`;
  const pad = Math.max(1, 15 - head.length);
  return `${head}${' '.repeat(pad)}${value}`;
}

function sourceValue(key: SourceKey): string {
  const file = 'filename' in key ? `  file ${sanitizeExternal(key.filename)}` : '';
  return `${key.kind} ${sanitizeExternal(key.source_id)}  slot ${sanitizeExternal(key.slot)}  seq ${key.seq}${file}`;
}

function writableLines(set: Origin['full_writable']): string[] {
  const paths = [...set.dirs, ...set.files];
  if (paths.length === 0) return [field('writable:', '(none)')];
  const lines = [field('writable:', sanitizeExternal(paths[0] ?? ''))];
  for (let i = 1; i < paths.length; i++) lines.push(`${' '.repeat(13)}${sanitizeExternal(paths[i] ?? '')}`);
  return lines;
}

function summaryField(summary: string | null): string[] {
  if (summary === null) return [field('summary:', '(none)')];
  if (!passesAllowList(summary)) return [field('summary:', '(withheld: fails the request allow-list)')];
  const parts = summary.split('\n');
  if (summary.endsWith('\n')) parts.pop();
  const lines = [field('summary:', parts[0] ?? '')];
  for (let i = 1; i < parts.length; i++) lines.push(`${' '.repeat(15)}${parts[i] ?? ''}`);
  return lines;
}

function payloadFact(record: ApprovalRecord): string {
  if (record.disposition === 'denied') return 'none';
  return `${record.payload_bytes} bytes  sha256 ${record.payload_sha256}`;
}

function qualificationLines(record: ApprovalRecord): string[] {
  const qualification = record.qualification;
  if (qualification === null) return [field('qualification:', 'none')];
  const lines = [field('qualification:', qualification.sha256)];
  for (const premise of qualification.premises) {
    lines.push(field('premise:', `${sanitizeExternal(premise.check)} ${premise.ok ? 'ok' : 'failed'} ${sanitizeExternal(premise.code)}`));
  }
  return lines;
}

function eventHead(n: number, state: ApprovalState): string {
  const tty = state.actor.tty === null ? '-' : sanitizeExternal(state.actor.tty);
  const started = state.actor.pid_started === null ? '-' : sanitizeExternal(state.actor.pid_started);
  return `  #${n}  ${state.updated_at}  ${state.status}  by ${sanitizeExternal(state.actor.user)}  tty ${tty}  pid ${state.actor.pid}  started ${started}`;
}

function stateDetails(state: ApprovalState): string[] {
  switch (state.status) {
    case 'rejected':
      return reasonLines(state.reason);
    case 'expired':
      return [];
    case 'unknown':
      return [`        reason: ${sanitizeExternal(state.reason)}`, ...textBlock('detail', state.detail)];
    case 'executing':
      return [`        owner pid ${state.owner.pid} started ${sanitizeExternal(state.owner.pid_started)}  timeout ${state.timeout_sec}s  viewed ${state.viewed_bytes} bytes sha256 ${state.viewed_sha256}  command sha256 ${state.command_sha256}`];
    case 'executed':
    case 'failed':
      if (state.method === 'manual') return textBlock('conclusion', state.conclusion);
      return [
        exitLine(state.result),
        ...textBlock('stdout', state.result.stdout.text, state.result.stdout.truncated),
        ...textBlock('stderr', state.result.stderr.text, state.result.stderr.truncated),
      ];
    case 'tampered':
      return [`        observed sha256 ${state.observed_sha256}`];
    default:
      return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected approval state ${JSON.stringify(value)}`);
}

function reasonLines(reason: string | null): string[] {
  if (reason === null) return ['        reason: (none)'];
  const clean = sanitizeExternal(reason);
  if (clean === '') return ['        reason: (none)'];
  const parts = clean.split('\n');
  if (clean.endsWith('\n')) parts.pop();
  const lines = [`        reason: ${parts[0] ?? ''}`];
  for (let i = 1; i < parts.length; i++) lines.push(`        │ ${parts[i] ?? ''}`);
  return lines;
}

function textBlock(title: string, body: string, truncated = false): string[] {
  const note = truncated ? ' (truncated at 65536 bytes)' : '';
  const rows = blockLines(body);
  const lines = [`        ${title}:${note}`];
  if (rows.length === 0) {
    lines.push('        (empty)');
    return lines;
  }
  for (const row of rows) lines.push(`        ${row}`);
  return lines;
}

function exitLine(result: Extract<ApprovalState, { method: 'executor' }>['result']): string {
  const signal = result.signal === null ? '-' : sanitizeExternal(result.signal);
  const failure = result.failure === null ? '-' : result.failure;
  const error = result.error_code === null ? '-' : sanitizeExternal(result.error_code);
  const code = result.exit_code === null ? '-' : String(result.exit_code);
  return `        exit ${code}  signal ${signal}  failure ${failure}  error ${error}`;
}
