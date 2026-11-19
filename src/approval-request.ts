import type { ExecutorsConfig } from './approval-executors.js';
import type { DeniedReason } from './approval-types.js';

/**
 * Pure request-file parser (spec 4.3, plan S2). No I/O, no clock, no sanitizing: bytes are accepted
 * exactly as read or refused. `payload` is a copy of the very Buffer the caller hashes, so the
 * hash and the stored copy cannot disagree.
 */

/** Global read cap: 65536 payload bytes + 2048 header bytes. A longer file is `too_large` before any parsing. */
export const GLOBAL_READ_CAP = 65536 + 2048;
export const HEADER_LIMIT = 2048;
export const SUMMARY_LIMIT = 300;

export type ParseDenial = Extract<DeniedReason, 'too_large' | 'bad_content' | 'bad_header' | 'bad_executor'>;
export type ParsedRequest =
  | { readonly kind: 'valid'; readonly executor: string; readonly summary: string | null; readonly payload: Buffer }
  | { readonly kind: 'denied'; readonly reason: ParseDenial };

const denied = (reason: ParseDenial): ParsedRequest => ({ kind: 'denied', reason });

/**
 * Everything that is not plain visible text: Cc (all of C0/C1 incl. DEL), Cf (bidi, ZWJ/ZWNJ, U+FEFF, tags), Zs/Zl/Zp,
 * variation selectors, Default_Ignorable_Code_Point, and the blank-looking Hangul/braille fillers. LF, TAB, U+0020 and U+3000
 * are allowed back in by `visible`.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{Variation_Selector}\p{Default_Ignorable_Code_Point}ᅟᅠㅤﾠ⠀]/u;

export function visible(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x0a || cp === 0x09 || cp === 0x20 || cp === 0x3000) continue;
    if (HIDDEN.test(ch)) return false;
  }
  return true;
}

const LINE = /^([A-Za-z_]+): (.*)$/;

export function parseRequest(bytes: Buffer, config: ExecutorsConfig): ParsedRequest {
  if (bytes.length > GLOBAL_READ_CAP) return denied('too_large');
  let text: string;
  try {
    // ignoreBOM keeps a leading U+FEFF in the text so the Cf rule refuses it instead of the decoder dropping it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return denied('bad_content');
  }
  if (!visible(text)) return denied('bad_content');

  const sep = bytes.indexOf('\n\n');
  if (sep < 0 || sep + 2 > HEADER_LIMIT) return denied('bad_header');
  const head = bytes.subarray(0, sep).toString('utf8');
  const lines = head === '' ? [] : head.split('\n');
  if (lines.length > 2) return denied('bad_header');
  const seen = new Map<string, string>();
  for (const line of lines) {
    const m = LINE.exec(line);
    if (!m || (m[1] !== 'executor' && m[1] !== 'summary') || seen.has(m[1])) return denied('bad_header');
    seen.set(m[1], m[2] as string);
  }
  const summary = seen.get('summary') ?? null;
  if (summary !== null && [...summary].length > SUMMARY_LIMIT) return denied('bad_header');

  const executor = seen.get('executor');
  if (executor === undefined || !Object.hasOwn(config.executors, executor)) return denied('bad_executor');
  const payload = Buffer.from(bytes.subarray(sep + 2));
  if (payload.length > (config.executors[executor]?.max_payload_bytes ?? 0)) return denied('too_large');
  return { kind: 'valid', executor, summary, payload };
}
