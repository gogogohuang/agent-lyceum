import { visible } from './approval-request.js';

/** Visible mark substituted for CR, U+2028, and U+2029. */
export const CR_MARK = '⏎';
/** Same code-point cap as `SUMMARY_LIMIT` in approval-request.ts. */
export const REASON_LIMIT = 300;

const STRING_7BIT = new Set<number>([0x5d, 0x50, 0x58, 0x5e, 0x5f]); // ] P X ^ _

/**
 * D3 steps 1–7, in order. Idempotent. Escape removal is one scan plus a last-terminator
 * index so a run of unterminated OSC introducers stays linear.
 */
export function sanitizeExternal(text: string): string {
  return stripControls(stripSequences(replaceLoneSurrogates(text)));
}

export function blockLines(text: string, prefix = '│ '): string[] {
  const clean = sanitizeExternal(text);
  if (clean === '') return [];
  const parts = clean.split('\n');
  if (clean.endsWith('\n')) parts.pop();
  return parts.map((line) => `${prefix}${line}`);
}

export function passesAllowList(text: string): boolean {
  return visible(text);
}

export type ReasonCheck =
  | { readonly ok: true; readonly reason: string | null }
  | { readonly ok: false; readonly message: string };

export function checkReason(raw: string | undefined): ReasonCheck {
  if (raw === undefined) return { ok: true, reason: null };
  if (raw === '') return { ok: false, message: '--reason must not be empty; nothing was changed.' };
  if (codePointLength(raw) > REASON_LIMIT) {
    return { ok: false, message: '--reason must be at most 300 characters; nothing was changed.' };
  }
  if (raw.includes('\n') || raw.includes('\t') || !passesAllowList(raw)) {
    return {
      ok: false,
      message: '--reason must be one line of visible text (no control, format or invisible characters); nothing was changed.',
    };
  }
  return { ok: true, reason: raw };
}

/** Sanitize, then keep the first 64 code points and append … when the rest was cut. */
export function clipArg(raw: string): string {
  const clean = sanitizeExternal(raw);
  const chars = [...clean];
  if (chars.length <= 64) return clean;
  return `${chars.slice(0, 64).join('')}…`;
}

function codePointLength(text: string): number {
  return [...text].length;
}

function replaceLoneSurrogates(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
    }
    return replaceLoneSurrogatesSlow(text);
  }
  return text;
}

function replaceLoneSurrogatesSlow(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text.slice(i, i + 2);
        i += 1;
        continue;
      }
      out += '\uFFFD';
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      out += '\uFFFD';
      continue;
    }
    out += text.charAt(i);
  }
  return out;
}

function lastTerminator(text: string): number {
  let last = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x07 || c === 0x9c) last = i;
    else if (c === 0x1b && text.charCodeAt(i + 1) === 0x5c) last = i;
  }
  return last;
}

function stringIntroLength(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c === 0x90 || c === 0x98 || c === 0x9d || c === 0x9e || c === 0x9f) return 1;
  if (c === 0x1b && STRING_7BIT.has(text.charCodeAt(i + 1))) return 2;
  return 0;
}

function terminatorEnd(text: string, from: number, last: number): number {
  for (let j = from; j <= last && j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === 0x07 || c === 0x9c) return j + 1;
    if (c === 0x1b && text.charCodeAt(j + 1) === 0x5c) return j + 2;
  }
  return -1;
}

function csiLength(text: string, i: number): number {
  const c = text.charCodeAt(i);
  let k: number;
  if (c === 0x1b && text.charCodeAt(i + 1) === 0x5b) k = i + 2;
  else if (c === 0x9b) k = i + 1;
  else return 0;
  while (k < text.length && text.charCodeAt(k) >= 0x30 && text.charCodeAt(k) <= 0x3f) k += 1;
  while (k < text.length && text.charCodeAt(k) >= 0x20 && text.charCodeAt(k) <= 0x2f) k += 1;
  const finalByte = text.charCodeAt(k);
  if (k < text.length && finalByte >= 0x40 && finalByte <= 0x7e) return k + 1 - i;
  return 0;
}

function otherEscapeLength(text: string, i: number): number {
  if (text.charCodeAt(i) !== 0x1b) return 0;
  let k = i + 1;
  while (k < text.length && text.charCodeAt(k) >= 0x20 && text.charCodeAt(k) <= 0x2f) k += 1;
  const finalByte = text.charCodeAt(k);
  if (k < text.length && finalByte >= 0x30 && finalByte <= 0x7e) return k + 1 - i;
  return 0;
}

function stripSequences(text: string): string {
  const last = lastTerminator(text);
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const intro = stringIntroLength(text, i);
    if (intro > 0) {
      if (last < 0 || i > last) {
        i += intro;
        continue;
      }
      const end = terminatorEnd(text, i + intro, last);
      i = end < 0 ? i + intro : end;
      continue;
    }
    const csi = csiLength(text, i);
    if (csi > 0) {
      i += csi;
      continue;
    }
    const other = otherEscapeLength(text, i);
    if (other > 0) {
      i += other;
      continue;
    }
    parts.push(text.charAt(i));
    i += 1;
  }
  return parts.join('');
}

function stripControls(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      out += text.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (c === 0x0d || c === 0x2028 || c === 0x2029) {
      out += CR_MARK;
      continue;
    }
    if (c === 0x09) {
      out += ' ';
      continue;
    }
    if (c === 0x0a) {
      out += '\n';
      continue;
    }
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) continue;
    out += text.charAt(i);
  }
  return out.replace(/\p{Cf}/gu, '');
}
