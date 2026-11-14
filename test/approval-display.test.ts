import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { approvalId } from '../src/approval-id.js';
import { computeDisplay } from '../src/approval-display.js';
import { serializeApprovalList } from '../src/approval-json.js';
import type { ApprovalRecord, ApprovalState, Current, SourceKey } from '../src/approval-types.js';

const time = '2026-11-14T00:00:00.000Z';
const hash = createHash('sha256').update('payload-secret').digest('hex');
const key: SourceKey = { kind: 'call', source_id: 'c1', slot: 'writer', seq: 1,
  variant: 'payload', filename: 'a.req', payload_sha256: hash };
const record: ApprovalRecord = { schema_version: 1, id: approvalId(key), source_key: key,
  origin: { kind: 'call', call_id: 'c1', project_dir: '/p', role: 'writer', full_writable: { dirs: [], files: [] } },
  proposer: { role: 'writer', slot: 'writer' }, created_at: time, expires_at: time, executor: 'local',
  summary: 'summary-secret', payload_sha256: hash, payload_bytes: 14,
  qualification: { schema_version: 1, sha256: hash, premises: [] }, disposition: 'pending' };
const current: Current = { record, n: 0, state: null };
const executing: ApprovalState = { schema_version: 1, n: 1, previous: 0, updated_at: time,
  actor: { user: 'u', tty: null, pid: 1, pid_started: 'start' }, status: 'executing',
  owner: { pid: 1, pid_started: 'start' }, timeout_sec: 1, viewed_bytes: 14,
  viewed_sha256: hash, command_sha256: hash };
const now = Date.parse(time);
const item = { id: record.id, origin: record.origin, proposer: record.proposer, executor: record.executor,
  created_at: time, expires_at: time, display: computeDisplay(current, now, null), reason: null,
  payload_sha256: hash, payload_bytes: 14 };

describe('computeDisplay', () => {
  it('expires only strictly after expiry and preserves persisted sequence/time without mutation', () => {
    const before = JSON.stringify(current);
    expect(computeDisplay(current, now, null)).toEqual({ persisted: 'pending', computed: 'pending', unrecorded: false, n: 0, updated_at: time });
    expect(computeDisplay(current, now + 1, null)).toEqual({ persisted: 'pending', computed: 'expired', unrecorded: true, n: 0, updated_at: time });
    expect(JSON.stringify(current)).toBe(before);
  });
  it('executing needs explicit dead evidence to display unknown, never elapsed time alone', () => {
    const c = { record, n: 1, state: executing };
    expect(() => computeDisplay(c, now + 999999, null)).toThrow();
    expect(computeDisplay(c, now, { alive: true, reason: 'matching_start' }).computed).toBe('executing');
    expect(computeDisplay(c, now, { alive: false, reason: 'missing_pid' })).toEqual({
      persisted: 'executing', computed: 'unknown', unrecorded: true, n: 1, updated_at: time });
    expect(c.state.status).toBe('executing');
  });
  it('keeps terminal state, rejects invalid time/current', () => {
    expect(computeDisplay({ record, n: 1, state: { schema_version: 1, n: 1, previous: 0, updated_at: time, actor: executing.actor, status: 'rejected', reason: 'no' } }, now + 1, null))
      .toEqual({ persisted: 'rejected', computed: 'rejected', unrecorded: false, n: 1, updated_at: time });
    expect(() => computeDisplay(current, Number.NaN, null)).toThrow();
    expect(() => computeDisplay({ ...current, n: 1 }, now, null)).toThrow();
  });
  it('denied disposition never becomes expired, and persisted unknown stays unknown', () => {
    const source: SourceKey = { kind: 'call', source_id: 'c1', slot: 'writer', seq: 1, variant: 'denied_entry', filename: 'bad.req', reason: 'not_regular' };
    const denied: ApprovalRecord = { ...record, id: approvalId(source), source_key: source, disposition: 'denied',
      reason: 'not_regular', ignored_count: null, executor: null, payload_sha256: null, payload_bytes: null, qualification: null };
    expect(computeDisplay({ record: denied, state: null, n: 0 }, now + 1, null)).toEqual({
      persisted: 'denied', computed: 'denied', unrecorded: false, n: 0, updated_at: time });
    const state: ApprovalState = { schema_version: 1, n: 1, previous: 0, updated_at: time, actor: executing.actor,
      status: 'unknown', reason: 'interrupted', detail: 'detail' };
    expect(computeDisplay({ record, state, n: 1 }, now + 1, null).computed).toBe('unknown');
  });

});

describe('serializeApprovalList', () => {
  it('validates v1 and sorts copied requests/problems, returning JSON + LF', () => {
    const a = { ...item, id: 'a'.repeat(24) };
    const b = { ...item, id: 'b'.repeat(24) };
    const problems = [
      { id: b.id, path: '/z', code: 'CORRUPT_RECORD', hint: 'Unreadable record' },
      { id: a.id, path: '/z', code: 'UNSAFE_PATH', hint: 'Unsafe path' },
      { id: a.id, path: '/a', code: 'IO_ERROR', hint: 'Read error' },
      { id: a.id, path: '/a', code: 'CORRUPT_STATE', hint: 'Invalid state' },
    ];
    const input = { schema_version: 1 as const, requests: [b, a], problems };
    const before = JSON.stringify(input);
    const json = serializeApprovalList(input);
    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json)).toEqual({ schema_version: 1, requests: [a, b],
      problems: [problems[3], problems[2], problems[1], problems[0]] });
    expect(JSON.stringify(input)).toBe(before);
    const reversedKeys = Object.fromEntries(Object.entries(a).reverse());
    expect(serializeApprovalList({ ...input, requests: [b, reversedKeys],
      problems: problems.map((p) => Object.fromEntries(Object.entries(p).reverse())) })).toBe(json);
    expect(() => serializeApprovalList({ ...input, schema_version: 2 } as never)).toThrow();
  });
  it('reports corrupt items as problems rather than throwing or leaking fields', () => {
    const input = { schema_version: 1 as const, requests: [item, { ...item, created_at: 'bad' }], problems: [] };
    const json = serializeApprovalList(input);
    const parsed = JSON.parse(json);
    expect(parsed.requests).toEqual([item]);
    expect(parsed.problems).toEqual([{ id: record.id, path: 'requests[1]', code: 'CORRUPT_RECORD', hint: 'Invalid approval list item' }]);
    expect(json).not.toContain('summary-secret');
    for (const field of ['payload', 'summary', 'qualification', 'env', 'stdout', 'stderr', 'result']) {
      const value = JSON.parse(serializeApprovalList({ ...input, requests: [{ ...item, [field]: 'secret' }] }));
      expect(value.requests).toEqual([]);
      expect(value.problems).toHaveLength(1);
      expect(JSON.stringify(value)).not.toContain('secret');
    }
  });
  it('rejects malformed list envelopes/problems; reports invalid request fields', () => {
    expect(() => serializeApprovalList({ schema_version: 1, requests: [], problems: [{ id: null, path: null, code: 'BAD' }] } as never)).toThrow();
    expect(() => serializeApprovalList({ schema_version: 1, requests: [], problems: [], extra: true } as never)).toThrow();
    for (const bad of [{ ...item, payload_bytes: -1 }, { ...item, display: { ...item.display, n: 1.5 } },
      { ...item, payload_sha256: 'bad' }, { ...item, reason: 'quota' }, { ...item, executor: null },
      { ...item, display: { ...item.display, unrecorded: true } }, { ...item, display: { ...item.display, n: 1 } }, { ...item, origin: { ...item.origin, env: 'secret' } }]) {
      expect(JSON.parse(serializeApprovalList({ schema_version: 1, requests: [bad], problems: [] })).problems).toHaveLength(1);
    }
  });
});
