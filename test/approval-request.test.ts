import { describe, expect, it } from 'vitest';
import type { ExecutorsConfig } from '../src/approval-executors.js';
import { GLOBAL_READ_CAP, parseRequest } from '../src/approval-request.js';

const config: ExecutorsConfig = {
  executors: {
    'exec-a': { command: ['/bin/true'], allow: [], timeout_sec: 60, env: {}, expires_days: 7, max_pending: 10, max_payload_bytes: 64 },
    '__proto__x': { command: ['/bin/true'], allow: [], timeout_sec: 60, env: {}, expires_days: 7, max_pending: 10, max_payload_bytes: 8 },
  },
  limits: { max_total_pending: 50, max_scan_entries: 200, retention_days: 90 },
};
const parse = (s: string | Buffer) => parseRequest(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'), config);
const req = (body: string, head = 'executor: exec-a') => `${head}\n\n${body}`;

describe('parseRequest', () => {
  it('header and whitelist table', () => {
    // valid shapes
    const ok = parse(req('hello\tworld\nline2'));
    expect(ok).toMatchObject({ kind: 'valid', executor: 'exec-a', summary: null });
    expect((ok as { payload: Buffer }).payload.toString()).toBe('hello\tworld\nline2');
    expect(parse(req('x', 'executor: exec-a\nsummary: 摘要　全形空白 ok'))).toMatchObject({ kind: 'valid', summary: '摘要　全形空白 ok' });
    expect(parse(req('x', 'summary: s\nexecutor: exec-a'))).toMatchObject({ kind: 'valid', summary: 's' });
    expect(parse(req('全形　空白 U+3000 allowed'))).toMatchObject({ kind: 'valid' });
    expect(parse('executor: exec-a\n\n')).toMatchObject({ kind: 'valid' }); // empty payload is a payload

    // whitelist: each refused code point, in the payload and in the summary
    const refused: Array<[string, string]> = [
      ['ESC', '\u001b'], ['CR', '\r'], ['DEL', '\u007f'], ['NUL', '\u0000'], ['C1 NEL', '\u0085'], ['VT', '\u000b'],
      ['LRM', '‎'], ['bidi RLO', '‮'], ['bidi isolate', '⁦'], ['ZWSP', '​'], ['ZWJ', '‍'], ['ZWNJ', '‌'],
      ['WORD JOINER', '⁠'], ['BOM', '﻿'], ['tag char', '\u{e0041}'], ['NBSP', ' '], ['LINE SEP', ' '],
      ['PARA SEP', ' '], ['EN QUAD', ' '], ['THIN SPACE', ' '], ['HANGUL FILLER 3164', 'ㅤ'],
      ['115F', 'ᅟ'], ['1160', 'ᅠ'], ['FFA0', 'ﾠ'], ['BRAILLE BLANK', '⠀'], ['VS16', '️'], ['VS1', '︀'],
      ['VS supplement', '\u{e0100}'], ['CGJ', '͏'], ['MONGOLIAN FVS', '᠋'], ['KHMER 17B4', '឴'], ['SOFT HYPHEN', '­'],
    ];
    for (const [label, ch] of refused) {
      expect(parse(req(`a${ch}b`)), `payload ${label}`).toEqual({ kind: 'denied', reason: 'bad_content' });
      expect(parse(req('x', `executor: exec-a\nsummary: a${ch}b`)), `summary ${label}`).toEqual({ kind: 'denied', reason: 'bad_content' });
    }
    // refused even where only the header can see it, and anywhere in the file
    expect(parse(`executor: exec-a​\n\nx`)).toEqual({ kind: 'denied', reason: 'bad_content' });
    // invalid UTF-8 (lone continuation, overlong, truncated sequence) is bad_content, never decoded leniently
    for (const bad of [[0x80], [0xc0, 0xaf], [0xe2, 0x82], [0xff]]) {
      expect(parse(Buffer.concat([Buffer.from('executor: exec-a\n\n'), Buffer.from(bad)])), `bytes ${bad}`).toEqual({ kind: 'denied', reason: 'bad_content' });
    }
    // a leading BOM is refused, not silently dropped by the decoder
    expect(parse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(req('x'))]))).toEqual({ kind: 'denied', reason: 'bad_content' });
    // never sanitizes: the payload is the byte-exact tail after the first blank line
    const body = ' lead  trail \n\n\nmore  ';
    expect((parse(req(body)) as { payload: Buffer }).payload.toString()).toBe(body);
  });

  it('header shape, order of checks and caps', () => {
    const bad = (s: string | Buffer, reason: string) => expect(parse(s)).toEqual({ kind: 'denied', reason });
    bad('executor: exec-a', 'bad_header'); // no blank line
    bad('executor: exec-a\n', 'bad_header');
    bad(req('x', 'executor: exec-a\nsummary: s\nextra: y'), 'bad_header'); // three lines
    bad(req('x', 'executor: exec-a\nexecutor: exec-a'), 'bad_header'); // duplicate key
    bad(req('x', 'executor: exec-a\nsummary: a\nsummary: b'), 'bad_header');
    bad(req('x', 'executor: exec-a\nowner: me'), 'bad_header'); // unknown key
    bad(req('x', 'executor:exec-a'), 'bad_header'); // no space after colon
    bad(req('x', 'Executor: exec-a'), 'bad_header'); // case sensitive
    bad(req('x', 'just text'), 'bad_header');
    // bad header wins over a missing executor
    bad(req('x', 'summary: s\nextra: y'), 'bad_header');
    bad(req('x', 'nope'), 'bad_header');
    // missing / unregistered executor
    bad('\n\nx', 'bad_executor');
    bad(req('x', 'summary: only a summary'), 'bad_executor');
    bad(req('x', 'executor: nope'), 'bad_executor');
    bad(req('x', 'executor: toString'), 'bad_executor'); // prototype names are not executors
    bad(req('x', 'executor: __proto__'), 'bad_executor');
    bad(req('x', 'executor: '), 'bad_executor');
    // summary length counted in code points
    expect(parse(req('x', `executor: exec-a\nsummary: ${'字'.repeat(300)}`))).toMatchObject({ kind: 'valid' });
    bad(req('x', `executor: exec-a\nsummary: ${'字'.repeat(301)}`), 'bad_header');
    expect(parse(req('x', `executor: exec-a\nsummary: ${'\u{1f600}'.repeat(300)}`))).toMatchObject({ kind: 'valid' });
    bad(req('x', `executor: exec-a\nsummary: ${'\u{1f600}'.repeat(301)}`), 'bad_header');
    // header total length (including the separator) is at most 2048 bytes
    // (a summary is capped at 300 code points, so only a very long registered executor name can reach it)
    const longConfig: ExecutorsConfig = { ...config, executors: {
      ['e'.repeat(2036)]: config.executors['exec-a'] as never, ['e'.repeat(2037)]: config.executors['exec-a'] as never } };
    const longParse = (name: string) => parseRequest(Buffer.from(`executor: ${name}\n\nx`), longConfig);
    expect(Buffer.byteLength(`executor: ${'e'.repeat(2036)}`) + 2).toBe(2048);
    expect(longParse('e'.repeat(2036))).toMatchObject({ kind: 'valid' });
    expect(longParse('e'.repeat(2037))).toEqual({ kind: 'denied', reason: 'bad_header' }); // registered, but the header is 2049 bytes
    // per-executor max_payload_bytes after the executor is known; exactly at the limit is fine
    expect(parse(req('x'.repeat(64)))).toMatchObject({ kind: 'valid' });
    bad(req('x'.repeat(65)), 'too_large');
    bad(req('x'.repeat(9), 'executor: __proto__x'), 'too_large');
    // bad content (whitelist) is judged before the header shape and before the executor
    bad(`nope​\n\nx`, 'bad_content');
    // the global cap comes first of all: even invalid content past the cap is too_large
    bad(Buffer.alloc(GLOBAL_READ_CAP + 1, 0x1b), 'too_large');
    expect(GLOBAL_READ_CAP).toBe(67584);
    expect(parse(Buffer.concat([Buffer.from('executor: exec-a\n\n'), Buffer.alloc(GLOBAL_READ_CAP - 18, 0x61)])))
      .toEqual({ kind: 'denied', reason: 'too_large' }); // within the global cap, over exec-a's 64 bytes
  });

  it('is pure: same bytes give the same result and the input buffer is never modified or aliased', () => {
    const input = Buffer.from(req('payload'), 'utf8');
    const copy = Buffer.from(input);
    const a = parse(input);
    const b = parse(input);
    expect(a).toEqual(b);
    expect(input.equals(copy)).toBe(true);
    const payload = (a as { payload: Buffer }).payload;
    payload[0] = 0x58;
    expect(input.equals(copy)).toBe(true); // the returned payload is a copy of the same read, not a view
  });
});
