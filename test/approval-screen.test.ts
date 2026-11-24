import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PAGE_BYTES,
  cellWidth,
  paginatePayload,
  proposerLabel,
  renderAudit,
  renderList,
  renderPayloadPage,
  renderShow,
  statusLabel,
  uniquePrefixLength,
} from '../src/approval-screen.js';
import type { AuditEvent, AuditModel, ListModel, ListProblemModel, ListRowModel, ShowModel } from '../src/approval-screen.js';
import type { ApprovalRecord, ApprovalState, Origin, SourceKey } from '../src/approval-types.js';

const HASH = 'ab'.repeat(32);
const OTHER = '1'.repeat(64);
const CMD = 'cd'.repeat(32);
const TIME = '2026-11-14T00:00:00.000Z';
const EXP = '2026-11-21T00:00:00.000Z';
const ID = 'a'.repeat(24);

const callOrigin = (role = 'origin-role'): Origin => ({
  kind: 'call', call_id: 'c1', project_dir: '/proj', role, full_writable: { dirs: [], files: [] },
});
const runOrigin: Origin = {
  kind: 'run', project: 'proj', run_id: 'run1', project_dir: '/proj', role: 'writer', full_writable: { dirs: [], files: [] },
};

function pendingRecord(over: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const key: SourceKey = {
    kind: 'call', source_id: 'c1', slot: 'src-slot', seq: 1, variant: 'payload', filename: 'a.req', payload_sha256: HASH,
  };
  return {
    schema_version: 1, id: ID, source_key: key, origin: callOrigin(), proposer: { role: 'prop-role', slot: 'prop-slot' },
    created_at: TIME, expires_at: EXP, executor: 'deploy', summary: 'do the thing', payload_sha256: HASH, payload_bytes: 12,
    qualification: { schema_version: 1, sha256: HASH, premises: [{ check: 'disk', ok: true, code: 'OK' }] },
    disposition: 'pending', ...over,
  } as ApprovalRecord;
}

function showModel(over: Partial<ShowModel> = {}): ShowModel {
  return {
    record: pendingRecord(), label: 'pending',
    payload: { kind: 'bytes', bytes: Buffer.from('hello\nworld\n'), observed_sha256: HASH },
    executor: { kind: 'ok', name: 'deploy', real: '/usr/bin/deploy', sha256: CMD },
    same: [], prefixLength: 8, ...over,
  };
}

const text = (rows: readonly string[]): string => `${rows.join('\n')}\n`;

const normalShow = [
  'Approval aaaaaaaaaaaaaaaaaaaaaaaa',
  '  status:   pending',
  '  proposer: call:origin-role (call c1)  slot prop-slot',
  '  created:  2026-11-14T00:00:00.000Z',
  '  expires:  2026-11-21T00:00:00.000Z',
  '  payload:  12 bytes  sha256 abababababababab (recorded)  abababababababab (read now)',
  '  same payload: none',
  '[agent statement, unverified]',
  '│ do the thing',
  '[executor]',
  '  name:    deploy',
  '  command: /usr/bin/deploy',
  '  sha256:  cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
  '[payload, complete content] page 1/1, bytes 0-11 of 12',
  '│ hello',
  '│ world',
  '└ end of payload (12 bytes)',
];

function listRow(over: Partial<ListRowModel> = {}): ListRowModel {
  return {
    kind: 'request', id: ID, label: 'pending', executor: 'deploy', origin: runOrigin,
    created_at: TIME, expires_at: EXP, note: null, ...over,
  };
}

function reconstruct(payload: Buffer, columns: number, pageBytes = PAGE_BYTES): Buffer {
  const pages = paginatePayload(payload, pageBytes);
  const rows = pages.flatMap((page) => renderPayloadPage(payload, page, columns));
  let out = '';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? '';
    expect(row.startsWith('│ ') || row.startsWith('┆ ')).toBe(true);
    const body = row.slice(2);
    if (i === 0) out += body;
    else if (row.startsWith('│ ')) out += `\n${body}`;
    else out += body;
  }
  if (payload.length > 0 && payload[payload.length - 1] === 0x0a) out += '\n';
  return Buffer.from(out, 'utf8');
}

describe('payload pager', () => {
  it('payload rows reconstruct the exact bytes and every row is prefixed', () => {
    const samples = ['', 'hello', 'hello\n', 'hello\nworld', 'hello\nworld\n', 'a\n\nb', '\n', '\ncd', 'ab\ncd', '中文', 'a😀b', 'a\tb', 'x'.repeat(100), `${'一'.repeat(30)}\n${'b'.repeat(50)}`];
    for (const sample of samples) {
      const buf = Buffer.from(sample, 'utf8');
      expect(reconstruct(buf, 40)).toEqual(buf);
      expect(reconstruct(buf, 30, 5)).toEqual(buf);
      expect(reconstruct(buf, 22, 4)).toEqual(buf);
    }
  });

  it('paginatePayload cuts at most 4096 bytes on character boundaries', () => {
    expect(PAGE_BYTES).toBe(4096);
    const payload = Buffer.alloc(4106, 0x62);
    const pages = paginatePayload(payload);
    expect(pages).toEqual([{ index: 0, start: 0, end: 4096 }, { index: 1, start: 4096, end: 4106 }]);
    expect(pages.reduce((sum, page) => sum + (page.end - page.start), 0)).toBe(payload.length);
    for (const page of pages) expect(page.end - page.start).toBeLessThanOrEqual(4096);
    expect(paginatePayload(Buffer.alloc(0))).toEqual([{ index: 0, start: 0, end: 0 }]);
    expect(renderPayloadPage(Buffer.alloc(0), { index: 0, start: 0, end: 0 }, 80)).toEqual([]);
  });

  it('a multi-byte character straddling the page boundary moves to the next page', () => {
    const han = Buffer.from('一');
    expect([...han]).toEqual([0xe4, 0xb8, 0x80]);
    const payload = Buffer.concat([Buffer.alloc(4095, 0x61), han, Buffer.from('Z')]);
    expect(payload[4096]! & 0xc0).toBe(0x80);
    const pages = paginatePayload(payload);
    expect(pages).toEqual([
      { index: 0, start: 0, end: 4095 },
      { index: 1, start: 4095, end: payload.length },
    ]);
    expect(pages[0]!.end - pages[0]!.start).toBeLessThanOrEqual(4096);
    expect(reconstruct(payload, 80)).toEqual(payload);
  });

  it('a line over 4096 bytes spans pages and wraps on character boundaries', () => {
    const payload = Buffer.concat([Buffer.alloc(4090, 0x78), Buffer.from('一'), Buffer.alloc(20, 0x79)]);
    const pages = paginatePayload(payload);
    expect(pages.map((page) => [page.start, page.end])).toEqual([[0, 4096], [4096, payload.length]]);
    for (const page of pages) {
      expect(page.end - page.start).toBeLessThanOrEqual(4096);
      if (page.end < payload.length) expect(payload[page.end]! & 0xc0).not.toBe(0x80);
    }
    const rows = pages.flatMap((page) => renderPayloadPage(payload, page, 80));
    expect(rows[0]?.startsWith('│ ')).toBe(true);
    expect(rows.slice(1).every((row) => row.startsWith('┆ '))).toBe(true);
    const bodies = rows.map((row) => row.slice(2));
    expect(bodies.join('')).toBe(payload.toString('utf8'));
    expect(bodies.filter((body) => body.includes('一'))).toHaveLength(1);
    for (const body of bodies) {
      let width = 0;
      for (const ch of body) width += cellWidth(ch.codePointAt(0) as number);
      expect(width).toBeLessThanOrEqual(78);
    }
  });

  it('wrap width follows columns with a 20 column floor', () => {
    const y79 = Buffer.from('y'.repeat(79));
    expect(renderPayloadPage(y79, { index: 0, start: 0, end: 79 }, 80)).toEqual([`│ ${'y'.repeat(78)}`, '┆ y']);
    const y21 = Buffer.from('y'.repeat(21));
    expect(renderPayloadPage(y21, { index: 0, start: 0, end: 21 }, 10)).toEqual([`│ ${'y'.repeat(20)}`, '┆ y']);
    const y20 = Buffer.from('y'.repeat(20));
    expect(renderPayloadPage(y20, { index: 0, start: 0, end: 20 }, 22)).toEqual([`│ ${'y'.repeat(20)}`]);
    expect(renderPayloadPage(Buffer.from('\t\t\t'), { index: 0, start: 0, end: 3 }, 22)).toEqual(['│ \t\t', '┆ \t']);
    const wide = Buffer.from('一'.repeat(11));
    expect(renderPayloadPage(wide, { index: 0, start: 0, end: wide.length }, 22)).toEqual([`│ ${'一'.repeat(10)}`, '┆ 一']);
    expect(cellWidth(0x09)).toBe(8);
    expect(cellWidth(0x4e00)).toBe(2);
    expect(cellWidth(0x61)).toBe(1);
    expect(cellWidth(0x0301)).toBe(1);
    const src = readFileSync(new URL('../src/approval-screen.ts', import.meta.url), 'utf8');
    expect(src).toContain('Combining marks count as 1');
    expect(src).toContain('TAB always counts as 8');
    expect(src).toContain('only affects wrap position');
    expect(src).not.toMatch(/node:fs|node:child_process|Date\.now|process\./);
  });
});

describe('uniquePrefixLength', () => {
  it('uniquePrefixLength covers hidden and problem ids', () => {
    expect(uniquePrefixLength([])).toBe(8);
    expect(uniquePrefixLength(['a'.repeat(24)])).toBe(8);
    expect(uniquePrefixLength(['a'.repeat(24), 'b'.repeat(24)])).toBe(8);
    const hidden = `ff00aa11${'c'.repeat(16)}`;
    const problem = `ff00aa11${'d'.repeat(16)}`;
    const other = `abcdef1234${'a'.repeat(14)}`;
    const twin = `abcdef1234${'b'.repeat(14)}`;
    expect(uniquePrefixLength([hidden, problem])).toBe(9);
    expect(uniquePrefixLength([other, twin])).toBe(11);
    const mixed = [hidden, problem, other, 'a'.repeat(24)];
    const n = uniquePrefixLength(mixed);
    expect(n).toBeGreaterThanOrEqual(8);
    expect(n).toBeLessThanOrEqual(24);
    expect(new Set(mixed.map((id) => id.slice(0, n))).size).toBe(mixed.length);
    expect(uniquePrefixLength(['a'.repeat(24), 'a'.repeat(24)])).toBe(24);
  });
});

describe('labels', () => {
  const display = (persisted: 'pending' | 'expired' | 'executing' | 'unknown' | 'denied' | 'rejected', computed: 'pending' | 'expired' | 'executing' | 'unknown' | 'denied' | 'rejected') => ({
    persisted, computed, unrecorded: persisted !== computed, n: 0, updated_at: TIME,
  });

  it('statusLabel and proposerLabel use the C1 label table', () => {
    expect(statusLabel({ display: display('pending', 'pending'), reason: null })).toBe('pending');
    expect(statusLabel({ display: display('pending', 'expired'), reason: null })).toBe('expired (not yet recorded)');
    expect(statusLabel({ display: display('executing', 'unknown'), reason: null })).toBe('executing, creator dead (not yet recorded)');
    expect(statusLabel({ display: display('denied', 'denied'), reason: 'bad_content' })).toBe('denied (bad_content)');
    expect(statusLabel({ display: display('rejected', 'rejected'), reason: null })).toBe('rejected');
    expect(statusLabel({ corrupted: 'CORRUPT_STATE' })).toBe('corrupted (CORRUPT_STATE)');
    expect(proposerLabel(runOrigin)).toBe('proj:writer (run run1)');
    expect(proposerLabel(callOrigin('writer'))).toBe('call:writer (call c1)');
    expect(proposerLabel({ ...runOrigin, project: 'pr\x1b[31moj' })).toBe('proj:writer (run run1)');
  });
});

describe('renderList', () => {
  it('renders C1 list lines, order, notes, and empty sentences', () => {
    const later: ListRowModel = listRow({
      id: 'b'.repeat(24), label: 'expired (not yet recorded)', executor: null,
      created_at: '2026-11-15T00:00:00.000Z', expires_at: '2026-11-16T00:00:00.000Z',
    });
    const problems: ListProblemModel[] = [
      { kind: 'problem', id: 'd'.repeat(24), code: 'IO_ERROR', path: '/tmp/d' },
      { kind: 'problem', id: 'c'.repeat(24), code: 'CORRUPT_STATE', path: '/tmp/c' },
    ];
    const model: ListModel = { all: false, rows: [later, listRow()], problems, hidden: 2, prefixLength: 8 };
    expect(renderList(model)).toBe(text([
      'aaaaaaaa  pending  deploy  proj:writer (run run1)  created 2026-11-14T00:00:00.000Z  expires 2026-11-21T00:00:00.000Z',
      'bbbbbbbb  expired (not yet recorded)  -  proj:writer (run run1)  created 2026-11-15T00:00:00.000Z  expires 2026-11-16T00:00:00.000Z',
      '2 more request(s) not pending; approvals list --all shows every state.',
      'cccccccc  corrupted (CORRUPT_STATE)  /tmp/c',
      'dddddddd  unreadable (IO_ERROR)  /tmp/d',
    ]));
    expect(renderList({ all: false, rows: [listRow({ note: 'recorded' })], problems: [], hidden: 0, prefixLength: 8 })).toBe(text([
      'aaaaaaaa  pending  deploy  proj:writer (run run1)  created 2026-11-14T00:00:00.000Z  expires 2026-11-21T00:00:00.000Z  [recorded now]',
    ]));
    expect(renderList({ all: true, rows: [listRow({ note: { failed: 'IO_ERROR' } })], problems: [], hidden: 4, prefixLength: 8 })).toBe(text([
      'aaaaaaaa  pending  deploy  proj:writer (run run1)  created 2026-11-14T00:00:00.000Z  expires 2026-11-21T00:00:00.000Z  [not recorded: IO_ERROR]',
    ]));
    expect(renderList({ all: false, rows: [], problems: [], hidden: 0, prefixLength: 8 })).toBe('No pending approval requests.\n');
    expect(renderList({ all: true, rows: [], problems: [], hidden: 0, prefixLength: 8 })).toBe('No approval requests.\n');
    expect(renderList({
      all: false, rows: [], problems: [{ kind: 'problem', id: 'c'.repeat(24), code: 'UNSUPPORTED_VERSION', path: '/tmp/\x1b[2Jc' }], hidden: 1, prefixLength: 8,
    })).toBe(text([
      'No pending approval requests.',
      '1 more request(s) not pending; approvals list --all shows every state.',
      'cccccccc  corrupted (UNSUPPORTED_VERSION)  /tmp/c',
    ]));
    expect(renderList({
      all: true, rows: [listRow({ executor: '\x1b[31mdeploy\r' })], problems: [{ kind: 'problem', id: 'e'.repeat(24), code: 'UNSAFE_PATH', path: '/tmp/\re' }], hidden: 0, prefixLength: 8,
    })).toBe(text([
      'aaaaaaaa  pending  deploy⏎  proj:writer (run run1)  created 2026-11-14T00:00:00.000Z  expires 2026-11-21T00:00:00.000Z',
      'eeeeeeee  unreadable (UNSAFE_PATH)  /tmp/⏎e',
    ]));
  });
});

describe('renderShow', () => {
  it('renders C2 show lines including withheld, MISMATCH, unreadable, denied, empty, and no final newline', () => {
    const before = JSON.stringify(showModel());
    const normal = renderShow(showModel(), 80);
    expect(normal).toEqual({ stdout: text(normalShow), withheld: false, mismatch: false });
    expect(JSON.stringify(showModel())).toBe(before);

    const mismatchRows = normalShow.slice();
    mismatchRows[5] = '  payload:  12 bytes  sha256 abababababababab (recorded)  1111111111111111 (read now)  MISMATCH';
    expect(renderShow(showModel({ payload: { kind: 'bytes', bytes: Buffer.from('hello\nworld\n'), observed_sha256: OTHER } }), 80)).toEqual({
      stdout: text(mismatchRows), withheld: false, mismatch: true,
    });

    const unread = [
      'Approval aaaaaaaaaaaaaaaaaaaaaaaa',
      '  status:   pending',
      '  proposer: call:origin-role (call c1)  slot prop-slot',
      '  created:  2026-11-14T00:00:00.000Z',
      '  expires:  2026-11-21T00:00:00.000Z',
      '  payload:  12 bytes  sha256 abababababababab (recorded)  unreadable (IO_ERROR)',
      '  same payload: none',
      '[agent statement, unverified]',
      '│ do the thing',
      '[executor]',
      '  name:    deploy',
      '  command: /usr/bin/deploy',
      '  sha256:  cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
      '(payload unreadable: IO_ERROR)',
    ];
    expect(renderShow(showModel({ payload: { kind: 'unreadable', code: 'IO_ERROR' } }), 80)).toEqual({
      stdout: text(unread), withheld: false, mismatch: false,
    });

    const noneSummary = normalShow.slice();
    noneSummary[8] = '(none)';
    expect(renderShow(showModel({ record: pendingRecord({ summary: null }) }), 80).stdout).toBe(text(noneSummary));

    const withheldSummary = normalShow.slice();
    withheldSummary[8] = '(withheld: fails the request allow-list)';
    expect(renderShow(showModel({ record: pendingRecord({ summary: 'secret\u200B' }) }), 80)).toEqual({
      stdout: text(withheldSummary), withheld: true, mismatch: false,
    });

    const withheldPayload = normalShow.slice(0, 13);
    withheldPayload.push('(withheld: fails the request allow-list)');
    expect(renderShow(showModel({ payload: { kind: 'bytes', bytes: Buffer.from('hello\x1b[31m'), observed_sha256: HASH } }), 80)).toEqual({
      stdout: text(withheldPayload), withheld: true, mismatch: false,
    });

    const emptyPayload = normalShow.slice(0, 13);
    emptyPayload[5] = '  payload:  0 bytes  sha256 abababababababab (recorded)  abababababababab (read now)';
    emptyPayload.push('[payload, complete content] empty (0 bytes)', '└ end of payload (0 bytes)');
    expect(renderShow(showModel({
      record: pendingRecord({ payload_bytes: 0 }),
      payload: { kind: 'bytes', bytes: Buffer.alloc(0), observed_sha256: HASH },
    }), 80)).toEqual({ stdout: text(emptyPayload), withheld: false, mismatch: false });

    const noNl = normalShow.slice(0, 13);
    noNl[5] = '  payload:  5 bytes  sha256 abababababababab (recorded)  abababababababab (read now)';
    noNl.push('[payload, complete content] page 1/1, bytes 0-4 of 5', '│ hello', '└ end of payload (5 bytes, no final newline)');
    expect(renderShow(showModel({
      record: pendingRecord({ payload_bytes: 5 }),
      payload: { kind: 'bytes', bytes: Buffer.from('hello'), observed_sha256: HASH },
    }), 80).stdout).toBe(text(noNl));

    const denied = [
      'Approval aaaaaaaaaaaaaaaaaaaaaaaa',
      '  status:   denied (bad_content)',
      '  proposer: call:origin-role (call c1)  slot prop-slot',
      '  created:  2026-11-14T00:00:00.000Z',
      '  expires:  2026-11-21T00:00:00.000Z',
      '  payload:  none (denied: bad_content)',
      '[agent statement, unverified]',
      '│ do the thing',
      '[executor]',
      '  name:    -',
      '(no payload)',
    ];
    const deniedKey: SourceKey = { kind: 'call', source_id: 'c1', slot: 'src-slot', seq: 1, variant: 'denied_entry', filename: 'bad.req', reason: 'not_regular' };
    expect(renderShow(showModel({
      label: 'denied (bad_content)',
      record: pendingRecord({
        disposition: 'denied', reason: 'bad_content', ignored_count: null, executor: null, payload_sha256: null,
        payload_bytes: null, qualification: null, source_key: deniedKey,
      }),
      payload: { kind: 'none' }, executor: { kind: 'none' },
      same: [{ id: 'b'.repeat(24), label: 'pending' }],
    }), 80).stdout).toBe(text(denied));

    const scan = denied.slice();
    scan[1] = '  status:   denied (scan_limit)';
    scan[5] = '  payload:  none (denied: scan_limit, 3 entries ignored)';
    const scanKey: SourceKey = { kind: 'call', source_id: 'c1', slot: 'src-slot', seq: 1, variant: 'denied_scan', reason: 'scan_limit' };
    expect(renderShow(showModel({
      label: 'denied (scan_limit)',
      record: pendingRecord({
        disposition: 'denied', reason: 'scan_limit', ignored_count: 3, executor: null, payload_sha256: null,
        payload_bytes: null, qualification: null, source_key: scanKey,
      }),
      payload: { kind: 'none' }, executor: { kind: 'none' },
    }), 80).stdout).toBe(text(scan));

    expect(renderShow(showModel({ executor: { kind: 'unregistered', name: 'deploy' } }), 80).stdout).toContain('  name:    deploy (not registered)\n[payload, complete content] page 1/1, bytes 0-11 of 12\n');
    expect(renderShow(showModel({ executor: { kind: 'config_error', name: 'deploy', code: 'CORRUPT_RECORD' } }), 80).stdout).toContain('  name:    deploy (executors.yaml cannot be read: CORRUPT_RECORD)\n');
    expect(renderShow(showModel({ executor: { kind: 'uninspectable', name: 'de\x1b[31mploy', configured: '/bin/\x1b[2Jdeploy', code: 'ENOENT' } }), 80).stdout).toContain('  name:    deploy\n  command: /bin/deploy (cannot be inspected: ENOENT)\n');
    expect(renderShow(showModel({ label: 'corrupted (CORRUPT_STATE)' }), 80).stdout).toContain('  status:   corrupted (CORRUPT_STATE)\n');
    expect(renderShow(showModel({ label: 'expired (not yet recorded)' }), 80).stdout).toContain('  status:   expired (not yet recorded)\n');

    const same = renderShow(showModel({
      same: [
        { id: 'c'.repeat(24), label: 'pending' },
        { id: 'd'.repeat(24), label: 'corrupted (CORRUPT_STATE)' },
        { id: 'b'.repeat(24), label: 'expired (not yet recorded)' },
      ],
    }), 80).stdout;
    expect(same).toContain('  same payload: bbbbbbbb (expired (not yet recorded)), cccccccc (pending), (dddddddd (corrupted))\n');

    const many = Array.from({ length: 21 }, (_, i) => ({
      id: `${(i + 1).toString(16).padStart(8, '0')}${'a'.repeat(16)}`, label: 'pending',
    }));
    const crowded = renderShow(showModel({ same: many.reverse() }), 80).stdout;
    expect(crowded).toContain('  same payload: 00000001 (pending), 00000002 (pending)');
    expect(crowded).toContain('00000014 (pending), … 1 more\n');
    expect(crowded).not.toContain('00000015');
  });
});

describe('renderAudit', () => {
  const actor = { user: 'ada', tty: '/dev/ttys001', pid: 42, pid_started: 'Mon Nov 14 10:00:00 2026' };
  const head = [
    'Approval aaaaaaaaaaaaaaaaaaaaaaaa',
    'record.json',
    '  disposition: pending',
    '  source:      call c1  slot src-slot  seq 1  file a.req',
    '  origin:      call:origin-role (call c1)  dir /proj',
    '  writable:    (none)',
    '  proposer:    role prop-role  slot prop-slot',
    '  executor:    deploy',
    '  summary:     do the thing',
    `  payload:     12 bytes  sha256 ${HASH}`,
    '  created:     2026-11-14T00:00:00.000Z',
    '  expires:     2026-11-21T00:00:00.000Z',
    `  qualification: ${HASH}`,
    '  premise:     disk ok OK',
    'state events',
  ];

  function event(over: Partial<ApprovalState> & Pick<ApprovalState, 'status'>): ApprovalState {
    return {
      schema_version: 1, n: 1, previous: 0, updated_at: TIME, actor, ...over,
    } as ApprovalState;
  }

  function audit(events: readonly AuditEvent[], current: string, record = pendingRecord()): string {
    const model: AuditModel = { record, events, current };
    return renderAudit(model);
  }

  it('renders C3 audit lines for record facts, every state detail, and corrupted events', () => {
    expect(audit([], 'pending')).toBe(text([...head, '  none (status comes from record.json)', 'current: pending']));

    const deniedKey: SourceKey = { kind: 'call', source_id: 'c1', slot: 'src-slot', seq: 1, variant: 'denied_scan', reason: 'scan_limit' };
    const deniedHead = [
      'Approval aaaaaaaaaaaaaaaaaaaaaaaa',
      'record.json',
      '  disposition: denied (scan_limit)',
      '  source:      call c1  slot src-slot  seq 1',
      '  origin:      call:origin-role (call c1)  dir /proj',
      '  writable:    /var/a',
      '             /var/b',
      '             /var/c',
      '  proposer:    role prop-role  slot prop-slot',
      '  executor:    -',
      '  summary:     (none)',
      '  payload:     none',
      '  created:     2026-11-14T00:00:00.000Z',
      '  expires:     2026-11-21T00:00:00.000Z',
      '  qualification: none',
      'state events',
      '  none (status comes from record.json)',
      'current: denied (scan_limit)',
    ];
    expect(audit([], 'denied (scan_limit)', pendingRecord({
      disposition: 'denied', reason: 'scan_limit', ignored_count: 3, executor: null, summary: null,
      payload_sha256: null, payload_bytes: null, qualification: null, source_key: deniedKey,
      origin: { ...callOrigin(), full_writable: { dirs: ['/var/a', '/var/b'], files: ['/var/c'] } },
    }))).toBe(text(deniedHead));

    const withheld = head.slice();
    withheld[8] = '  summary:     (withheld: fails the request allow-list)';
    expect(audit([], 'pending', pendingRecord({ summary: 'no\u202Epe' }))).toBe(text([...withheld, '  none (status comes from record.json)', 'current: pending']));

    const eventHead = '  #1  2026-11-14T00:00:00.000Z  rejected  by ada  tty /dev/ttys001  pid 42  started Mon Nov 14 10:00:00 2026';
    expect(audit([{ n: 1, state: event({ status: 'rejected', reason: 'nope' }) }], 'rejected')).toBe(text([
      ...head, eventHead, '        reason: nope', 'current: rejected',
    ]));
    expect(audit([{ n: 1, state: event({ status: 'rejected', reason: null }) }], 'rejected')).toContain('        reason: (none)\n');
    expect(audit([{ n: 1, state: event({ status: 'expired' }) }], 'expired')).toContain(
      '  #1  2026-11-14T00:00:00.000Z  expired  by ada  tty /dev/ttys001  pid 42  started Mon Nov 14 10:00:00 2026\ncurrent: expired\n',
    );
    expect(audit([{ n: 1, state: event({ status: 'unknown', reason: 'creator_dead', detail: 'boom' }) }], 'executing, creator dead (not yet recorded)')).toContain(text([
      '        reason: creator_dead',
      '        detail:',
      '        │ boom',
    ]).trimEnd());
    expect(audit([{ n: 1, state: event({ status: 'unknown', reason: 'interrupted', detail: '' }) }], 'unknown')).toContain('        reason: interrupted\n        detail:\n        (empty)\n');
    expect(audit([{
      n: 1,
      state: event({
        status: 'executing', owner: { pid: 7, pid_started: 'start-1' }, timeout_sec: 30, viewed_bytes: 12, viewed_sha256: HASH, command_sha256: CMD,
      }),
    }], 'executing')).toContain(`        owner pid 7 started start-1  timeout 30s  viewed 12 bytes sha256 ${HASH}  command sha256 ${CMD}\n`);
    expect(audit([{
      n: 1,
      state: event({
        status: 'executed', method: 'executor',
        result: { exit_code: 0, signal: null, failure: null, error_code: null, stdout: { text: 'out', truncated: false }, stderr: { text: '', truncated: false } },
      }),
    }], 'executed')).toContain(text([
      '        exit 0  signal -  failure -  error -',
      '        stdout:',
      '        │ out',
      '        stderr:',
      '        (empty)',
    ]).trimEnd());
    expect(audit([{
      n: 1,
      state: event({
        status: 'failed', method: 'executor',
        result: {
          exit_code: null, signal: 'TERM', failure: 'spawn', error_code: 'ENOENT',
          stdout: { text: '\x1b[2J\rhacked\n│ fake', truncated: true }, stderr: { text: '', truncated: false },
        },
      }),
    }], 'failed')).toContain(text([
      '        exit -  signal TERM  failure spawn  error ENOENT',
      '        stdout: (truncated at 65536 bytes)',
      '        │ ⏎hacked',
      '        │ │ fake',
      '        stderr:',
      '        (empty)',
    ]).trimEnd());
    expect(audit([{ n: 1, state: event({ status: 'executed', method: 'manual', conclusion: 'looked fine' }) }], 'executed')).toContain('        conclusion:\n        │ looked fine\n');
    expect(audit([{ n: 1, state: event({ status: 'failed', method: 'manual', conclusion: '' }) }], 'failed')).toContain('        conclusion:\n        (empty)\n');
    expect(audit([{ n: 1, state: event({ status: 'tampered', observed_sha256: HASH }) }], 'tampered')).toContain(`        observed sha256 ${HASH}\n`);
    expect(audit([
      { n: 2, code: 'CORRUPT_STATE', path: '/tmp/\x1b[31mstate/2.json' },
      { n: 1, state: event({ status: 'expired' }) },
    ], 'corrupted (CORRUPT_STATE)')).toBe(text([
      ...head,
      '  #1  2026-11-14T00:00:00.000Z  expired  by ada  tty /dev/ttys001  pid 42  started Mon Nov 14 10:00:00 2026',
      '  #2  corrupted (CORRUPT_STATE)  /tmp/state/2.json',
      'current: corrupted (CORRUPT_STATE)',
    ]));
    expect(audit([{
      n: 1,
      state: event({
        status: 'rejected', reason: 'nope',
        actor: { user: 'a\x1b[31mda', tty: '/dev/\rtty', pid: 42, pid_started: null },
      }),
    }], 'rejected')).toContain('  #1  2026-11-14T00:00:00.000Z  rejected  by ada  tty /dev/⏎tty  pid 42  started -\n');
  });
});
