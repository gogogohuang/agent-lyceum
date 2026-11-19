import { describe, expect, it } from 'vitest';
import { visible } from '../src/approval-request.js';
import { CR_MARK, REASON_LIMIT, blockLines, checkReason, clipArg, passesAllowList, sanitizeExternal } from '../src/approval-text.js';

const C5_EMPTY = '--reason must not be empty; nothing was changed.';
const C5_LENGTH = '--reason must be at most 300 characters; nothing was changed.';
const C5_VISIBLE = '--reason must be one line of visible text (no control, format or invisible characters); nothing was changed.';

describe('sanitizeExternal', () => {
  it('sanitizeExternal strips escape sequences C0 C1 and Cf and marks carriage returns', () => {
    expect(CR_MARK).toBe('⏎');
    expect(sanitizeExternal('\x1b[31mred\x1b[0m')).toBe('red');
    expect(sanitizeExternal('\x9b31mred\x9b0m')).toBe('red');
    expect(sanitizeExternal('keep\x1b]0;title\x07rest')).toBe('keeprest');
    expect(sanitizeExternal('keep\x1b]0;title\x1b\\rest')).toBe('keeprest');
    expect(sanitizeExternal('keep\x1b]0;title\x9crest')).toBe('keeprest');
    expect(sanitizeExternal('\x1bPdata\x1b\\rest')).toBe('rest');
    expect(sanitizeExternal('\x1bXsecret\x9cok')).toBe('ok');
    expect(sanitizeExternal('\x1b]0;title WORLD')).toBe('0;title WORLD');
    expect(sanitizeExternal('\x9dTAIL')).toBe('TAIL');
    expect(sanitizeExternal('\x1bPhi\x07Z')).toBe('Z');
    expect(sanitizeExternal('\x1b]hi\r\x07next')).toBe('next');
    expect(sanitizeExternal('\x1b]a\tb\x07Z')).toBe('Z');
    expect(sanitizeExternal('\x1b(B')).toBe('');
    expect(sanitizeExternal('\x1b7')).toBe('');
    expect(sanitizeExternal('a\x7fb')).toBe('ab');
    expect(sanitizeExternal('a\u0085b')).toBe('ab');
    expect(sanitizeExternal('a\u0000b')).toBe('ab');
    expect(sanitizeExternal('a\u202Eb')).toBe('ab');
    expect(sanitizeExternal('a\u200Bb')).toBe('ab');
    expect(sanitizeExternal('a\uFEFFb')).toBe('ab');
    expect(sanitizeExternal('a\u{E0041}b')).toBe('ab');
    expect(sanitizeExternal('a\r\nb')).toBe(`a${CR_MARK}\nb`);
    expect(sanitizeExternal('a\rb')).toBe(`a${CR_MARK}b`);
    expect(sanitizeExternal('a\tb')).toBe('a b');
    expect(sanitizeExternal('a\uD800b')).toBe('a\uFFFDb');
    expect(sanitizeExternal('a\uDC00b')).toBe('a\uFFFDb');
    expect(sanitizeExternal('a\u2028b')).toBe(`a${CR_MARK}b`);
    expect(sanitizeExternal('a\u2029b')).toBe(`a${CR_MARK}b`);
    expect(sanitizeExternal('a😀b')).toBe('a😀b');
    expect(sanitizeExternal('deploy')).toBe('deploy');
    expect(sanitizeExternal('notes.req')).toBe('notes.req');
    expect(sanitizeExternal('exec-a')).toBe('exec-a');
    const mixed = '\x1b[31mA\r\n\t\u202E\u200B\uFEFF\u2028\u2029\x1b]x';
    expect(sanitizeExternal(sanitizeExternal(mixed))).toBe(sanitizeExternal(mixed));
    expect(sanitizeExternal(mixed)).toBe(`A${CR_MARK}\n ${CR_MARK}${CR_MARK}x`);
  });

  it('sanitizeExternal is linear on unterminated introducers', () => {
    const osc = '\x1b]'.repeat(32 * 1024);
    const c1 = '\x9d'.repeat(64 * 1024);
    expect(osc.length).toBe(64 * 1024);
    expect(c1.length).toBe(64 * 1024);
    const t0 = performance.now();
    const strippedOsc = sanitizeExternal(osc);
    const t1 = performance.now();
    const strippedC1 = sanitizeExternal(c1);
    const t2 = performance.now();
    expect(t1 - t0).toBeLessThan(200);
    expect(t2 - t1).toBeLessThan(200);
    expect(strippedOsc.includes('\u001b')).toBe(false);
    expect([...strippedC1].some((c) => { const n = c.charCodeAt(0); return n === 0x1b || (n >= 0x80 && n <= 0x9f); })).toBe(false);
    expect(strippedOsc).toBe('');
    expect(strippedC1).toBe('');
  });

  it('forged box drawing in external text never starts a line', () => {
    const rows = blockLines('│ fake\n└ end');
    expect(rows).toEqual(['│ │ fake', '│ └ end']);
    for (const row of rows) expect(row.startsWith('│ ')).toBe(true);
    expect(blockLines('')).toEqual([]);
    expect(blockLines('\n│ fake')).toEqual(['│ ', '│ │ fake']);
    expect(blockLines('a\r\n│ b')).toEqual([`│ a${CR_MARK}`, '│ │ b']);
  });

  it("checkReason's three C5 messages", () => {
    expect(REASON_LIMIT).toBe(300);
    expect(checkReason(undefined)).toEqual({ ok: true, reason: null });
    expect(checkReason('')).toEqual({ ok: false, message: C5_EMPTY });
    expect(checkReason('x'.repeat(300))).toEqual({ ok: true, reason: 'x'.repeat(300) });
    expect(checkReason('x'.repeat(301))).toEqual({ ok: false, message: C5_LENGTH });
    expect(checkReason(`${'👍'.repeat(300)}`)).toEqual({ ok: true, reason: '👍'.repeat(300) });
    expect(checkReason('👍'.repeat(301))).toEqual({ ok: false, message: C5_LENGTH });
    expect(checkReason(`nope${'x'.repeat(300)}\n`)).toEqual({ ok: false, message: C5_LENGTH });
    expect(checkReason('a\nb')).toEqual({ ok: false, message: C5_VISIBLE });
    expect(checkReason('a\tb')).toEqual({ ok: false, message: C5_VISIBLE });
    expect(checkReason('a\rb')).toEqual({ ok: false, message: C5_VISIBLE });
    expect(checkReason('a\u0001b')).toEqual({ ok: false, message: C5_VISIBLE });
    expect(checkReason('a\u2028b')).toEqual({ ok: false, message: C5_VISIBLE });
    expect(checkReason('ok')).toEqual({ ok: true, reason: 'ok' });
  });

  it('clipArg sanitizes then keeps 64 code points', () => {
    expect(clipArg('hello')).toBe('hello');
    expect(clipArg('a'.repeat(64))).toBe('a'.repeat(64));
    expect(clipArg('a'.repeat(65))).toBe(`${'a'.repeat(64)}…`);
    expect(clipArg(`\x1b[31m${'a'.repeat(70)}`)).toBe(`${'a'.repeat(64)}…`);
    expect(clipArg('👍'.repeat(65))).toBe(`${'👍'.repeat(64)}…`);
  });

  it('passesAllowList is visible', () => {
    const samples = ['a\nb\tok 　', 'a\u0001', 'a\u2028b', '', 'deploy'];
    for (const sample of samples) expect(passesAllowList(sample)).toBe(visible(sample));
  });
});
