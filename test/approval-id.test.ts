import { describe, expect, it } from 'vitest';
import { approvalId, encodeSourceKey, isRequestFilename, lp } from '../src/approval-id.js';
import type { SourceKey } from '../src/approval-types.js';

const base = { kind: 'run', source_id: 'run.1', slot: 'agent--2', seq: 1 } as const;
const payload = { ...base, variant: 'payload', filename: 'a.req', payload_sha256: 'a'.repeat(64) } as const;

// Full fixtures independently calculated with Python hashlib over explicit v1 tuples.
const goldens: readonly (readonly [SourceKey, string, string])[] = [
  [{ ...base, "variant": "payload", "filename": "a.req", "payload_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "33313a6167656e742d6c796365756d2f617070726f76616c2d736f757263652f7631373a7061796c6f6164333a72756e353a72756e2e31383a6167656e742d2d32313a31353a612e72657136343a61616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161", "a5981394d4232743467a5f91"],
  [{ ...base, "variant": "denied_bytes", "filename": "a.req", "reason": "too_large", "request_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, "33313a6167656e742d6c796365756d2f617070726f76616c2d736f757263652f763131323a64656e6965645f6279746573333a72756e353a72756e2e31383a6167656e742d2d32313a31353a612e726571393a746f6f5f6c6172676536343a62626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262", "3fbef2e4d1e8ac2cd339a23d"],
  [{ ...base, "variant": "denied_bytes", "filename": "a.req", "reason": "bad_content", "request_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, "33313a6167656e742d6c796365756d2f617070726f76616c2d736f757263652f763131323a64656e6965645f6279746573333a72756e353a72756e2e31383a6167656e742d2d32313a31353a612e72657131313a6261645f636f6e74656e7436343a62626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262", "a2dfe4d1e8590600ab470abb"],
  [{ ...base, "variant": "denied_bytes", "filename": "a.req", "reason": "bad_executor", "request_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, "33313a6167656e742d6c796365756d2f617070726f76616c2d736f757263652f763131323a64656e6965645f6279746573333a72756e353a72756e2e31383a6167656e742d2d32313a31353a612e72657131323a6261645f6578656375746f7236343a62626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262", "49ba6b0e275c9839b0fda1cb"],
  [{ ...base, "variant": "denied_bytes", "filename": "a.req", "reason": "bad_header", "request_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, "33313a6167656e742d6c796365756d2f617070726f76616c2d736f757263652f763131323a64656e6965645f6279746573333a72756e353a72756e2e31383a6167656e742d2d32313a31353a612e72657131303a6261645f68656164657236343a62626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262", "e60ebbc7f14af1e6a5c2f501"],
  [{ ...base, "variant": "denied_bytes", "filename": "a.req", "reason": "not_allowed", "request_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, "33313a6167656e742d6c796365756d2f617070726f76616c2d736f757263652f763131323a64656e6965645f6279746573333a72756e353a72756e2e31383a6167656e742d2d32313a31353a612e72657131313a6e6f745f616c6c6f77656436343a62626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262", "ab0cca520bb18e607f0d8507"],
  [{ ...base, "variant": "denied_bytes", "filename": "a.req", "reason": "quota", "request_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, "33313a6167656e742d6c796365756d2f617070726f76616c2d736f757263652f763131323a64656e6965645f6279746573333a72756e353a72756e2e31383a6167656e742d2d32313a31353a612e726571353a71756f746136343a62626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262", "a647b8c8b6e7aa8b7944dfa8"],
  [{ ...base, "variant": "denied_entry", "filename": "a.req", "reason": "not_regular" }, "33313a6167656e742d6c796365756d2f617070726f76616c2d736f757263652f763131323a64656e6965645f656e747279333a72756e353a72756e2e31383a6167656e742d2d32313a31353a612e72657131313a6e6f745f726567756c6172", "e355f73676426def3e0cf09a"],
  [{ ...base, "variant": "denied_size", "filename": "a.req", "reason": "too_large", "size": 67585 }, "33313a6167656e742d6c796365756d2f617070726f76616c2d736f757263652f763131313a64656e6965645f73697a65333a72756e353a72756e2e31383a6167656e742d2d32313a31353a612e726571393a746f6f5f6c61726765353a3637353835", "a2b0ded1977544d925299bd7"],
  [{ ...base, "variant": "denied_scan", "reason": "scan_limit" }, "33313a6167656e742d6c796365756d2f617070726f76616c2d736f757263652f763131313a64656e6965645f7363616e333a72756e353a72756e2e31383a6167656e742d2d32313a3131303a7363616e5f6c696d6974", "416f547d8e469a49e5cf7186"],
];
describe('approval source v1', () => {
  it.each(goldens)('locks the complete bytes and digest for %j', (key, hex, id) => {
    expect(encodeSourceKey(Object.freeze(key)).toString('hex')).toBe(hex);
    expect(approvalId(key)).toBe(id);
  });
  it('keeps all nine denial cases distinct and scan identity independent of count', () => {
    expect(new Set(goldens.map(([key]) => approvalId(key))).size).toBe(10);
    const scan = { ...base, variant: 'denied_scan', reason: 'scan_limit' } as const;
    expect(approvalId({ ...scan, ignored_count: 1 } as SourceKey)).toBe(approvalId({ ...scan, ignored_count: 99 } as SourceKey));
  });
  it('separates kind, source, slot, sequence, filename, hash and oversized size', () => {
    const changed: SourceKey[] = [payload, { ...payload, kind: 'call' }, { ...payload, source_id: 'run.2' },
      { ...payload, slot: 'agent' }, { ...payload, seq: 2 }, { ...payload, filename: 'b.req' },
      { ...payload, payload_sha256: 'b'.repeat(64) }];
    expect(new Set(changed.map(approvalId)).size).toBe(changed.length);
    expect(approvalId({ ...base, variant: 'denied_size', filename: 'a.req', reason: 'too_large', size: 1 }))
      .not.toBe(approvalId({ ...base, variant: 'denied_size', filename: 'a.req', reason: 'too_large', size: 2 }));
  });
  it('encodes arbitrary UTF8 primitives without normalization or implicit delimiters', () => {
    expect(lp('中').toString('hex')).toBe('333ae4b8ad');
    expect(lp('').toString('hex')).toBe('303a');
    expect(lp(':\n😀').toString('hex')).toBe('363a3a0af09f9880');
    expect(lp('é')).not.toEqual(lp('e\u0301'));
    expect(Buffer.concat([lp('a'), lp('bc')])).not.toEqual(Buffer.concat([lp('ab'), lp('c')]));
    expect(Buffer.concat([lp('a:'), lp('\n')]).toString()).toBe('2:a:1:\n');
    for (const s of ['\ud800', '\udfff', 'a\ud800b']) expect(() => lp(s)).toThrowError();
  });
  it('does not mutate frozen source inputs or reuse a caller-modifiable buffer', () => {
    const key = Object.freeze({ ...payload });
    const before = JSON.stringify(key);
    encodeSourceKey(key).fill(0);
    expect(approvalId(key)).toBe(goldens[0]?.[2]);
    expect(JSON.stringify(key)).toBe(before);
  });
  it.each([
    { source_id: '' }, { source_id: '..' }, { source_id: '../x' }, { source_id: '中' },
    { slot: '-bad' }, { slot: 'a/b' }, { slot: 'a\ud800' },
    { seq: 0 }, { seq: -1 }, { seq: 1.5 }, { seq: NaN }, { seq: Infinity }, { seq: Number.MAX_SAFE_INTEGER + 1 },
    { filename: '.a.req' }, { filename: '../a.req' }, { filename: '中.req' }, { filename: 'a.req\n' },
    { filename: 'a'.repeat(65) + '.req' }, { filename: '.req' },
    { payload_sha256: 'A'.repeat(64) }, { payload_sha256: 'a'.repeat(63) }, { payload_sha256: 'a'.repeat(64) + '\n' },
    { kind: 'other' }, { variant: 'other' },
  ])('rejects malformed source fields %j', (patch) => {
    expect(() => encodeSourceKey({ ...payload, ...patch } as SourceKey)).toThrowError();
  });
  it.each(['a..b', 'a.', 'a-.b_', 'A'])('accepts run/call id %j', (source_id) => {
    for (const kind of ['run', 'call'] as const) expect(approvalId({ ...payload, kind, source_id })).toMatch(/^[0-9a-f]{24}$/);
  });
  it.each(['.a', '..', '.', '-a', '_a', 'a/b', 'a\n'])('rejects run/call id %j', (source_id) => {
    for (const kind of ['run', 'call'] as const) expect(() => encodeSourceKey({ ...payload, kind, source_id })).toThrowError();
  });
  it('shares one request filename grammar', () => {
    expect(['a.req', '.a.req', '.req', 'a.req\n', 'a', '中.req', `${'a'.repeat(64)}.req`, `${'a'.repeat(65)}.req`, 1]
      .map(isRequestFilename)).toEqual([true, false, false, false, false, false, true, false, false]);
  });
  it('accepts canonical boundary names, ids, sequence and filename lengths', () => {
    expect(approvalId({ ...payload, source_id: 'A_-.1', slot: 'A_--1', seq: Number.MAX_SAFE_INTEGER,
      filename: 'a'.repeat(64) + '.req' })).toMatch(/^[0-9a-f]{24}$/);
  });
  it('rejects mismatched reasons, invalid denied hash and unsafe sizes', () => {
    for (const size of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => approvalId({ ...base, variant: 'denied_size', filename: 'a.req', reason: 'too_large', size })).toThrowError();
    }
    for (const key of [
      { ...base, variant: 'denied_scan', reason: 'quota' },
      { ...base, variant: 'denied_entry', filename: 'a.req', reason: 'too_large' },
      { ...base, variant: 'denied_size', filename: 'a.req', reason: 'quota', size: 0 },
      { ...base, variant: 'denied_bytes', filename: 'a.req', reason: 'scan_limit', request_sha256: 'a'.repeat(64) },
      { ...base, variant: 'denied_bytes', filename: 'a.req', reason: 'quota', request_sha256: 'bad' },
    ]) expect(() => encodeSourceKey(key as SourceKey)).toThrowError();
    expect(approvalId({ ...base, variant: 'denied_size', filename: 'a.req', reason: 'too_large', size: 0 })).toMatch(/^[a-f0-9]{24}$/);
  });
});
