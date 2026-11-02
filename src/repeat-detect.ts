import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { VerifyCommandRecord, VerifyRecord } from "./run-store.js";

/** Spec 28: has the same verify failure come back on an unchanged workspace? Pure functions except `fingerprintPaths`. */

/** How much of a command's raw output is looked at before it is cut into lines. */
export const FINGERPRINT_WINDOW_BYTES = 256 * 1024;
export const FINGERPRINT_LINES = 100;

/** A literal path and what it is replaced with. */
export type PathRule = [literal: string, replacement: string];

const TMP = /(?<![\w./-])(?:\/private)?(?:\/tmp|\/var\/tmp|\/var\/folders\/[^\s/]+\/[^\s/]+\/T)(?:\/[^\s:'"`()[\]<>,;]*)?/g;
const STAMP = /(?<![\w.:-])\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?(?![\w:])/g;
const CLOCK = /(?<![\w.:-])\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?![\w:])/g;
const DUR = /(?<![\w./-])(?:\d+h\s?)?(?:\d+m\s?)?\d+(?:\.\d+)?(?:ms|µs|ns|s|secs?|seconds?|mins?|minutes?)(?![\w/-]|\.\w)/g;

/** The paths of this run that should not make two outputs differ: the working directory, the run directory and the temp directory. */
export function fingerprintPaths(cwd: string, runDir: string): PathRule[] {
  const rules: PathRule[] = [];
  const add = (p: string, to: string) => {
    if (p && !rules.some(([l]) => l === p)) rules.push([p, to]);
  };
  const real = (p: string): string | undefined => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return undefined;
    }
  };
  for (const [p, to] of [[cwd, "<cwd>"], [runDir, "<run-dir>"], [os.tmpdir(), "/tmp"]] as const) {
    add(p, to);
    const r = real(p);
    if (r) add(r, to);
  }
  return rules;
}

const PATH_NEXT = /[\w.-]/;

/** Replace each literal that is not directly followed by a name character (`/w/x` does not eat `/w/x2` or `/w/x.bak`). */
function replacePaths(line: string, paths: PathRule[]): string {
  let s = line;
  for (const [literal, to] of [...paths].sort((a, b) => b[0].length - a[0].length)) {
    if (!literal || literal === to) continue;
    let out = "";
    let from = 0;
    for (;;) {
      const i = s.indexOf(literal, from);
      if (i < 0) break;
      const next = s[i + literal.length];
      out += s.slice(from, i);
      if (next !== undefined && PATH_NEXT.test(next)) out += literal;
      else out += to;
      from = i + literal.length;
    }
    s = out + s.slice(from);
  }
  return s;
}

/** The last FINGERPRINT_LINES lines of `text` with ANSI codes, overwritten progress, clock times, durations and this run's paths removed. */
export function normalizeOutput(text: string, paths: PathRule[]): string {
  const lines = stripVTControlCharacters(text)
    .split("\n")
    .map((l) => {
      const noCr = l.replace(/\r+$/, "");
      return noCr.slice(noCr.lastIndexOf("\r") + 1).trimEnd();
    });
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines
    .slice(-FINGERPRINT_LINES)
    .map((l) => replacePaths(l, paths).replace(TMP, "<tmp>").replace(STAMP, "<time>").replace(CLOCK, "<time>").replace(DUR, "<duration>"))
    .join("\n");
}

/** 16 hex characters over the command name, how it failed, and the normalised tail of its output. */
export function failureFingerprint(c: Pick<VerifyCommandRecord, "name" | "exit" | "timed_out" | "error">, tail: string, paths: PathRule[]): string {
  const status = c.error ? `error:${normalizeOutput(c.error, paths)}` : c.timed_out ? "timeout" : c.exit === null ? "signal" : `exit:${c.exit}`;
  return createHash("sha256").update(`${c.name}\0${status}\0${normalizeOutput(tail, paths)}`).digest("hex").slice(0, 16);
}

export type HashRelation = "same" | "changed" | "unknown" | "no-worktree";
export type RepeatAction = "none" | "label" | "stop" | "limit";
export interface RepeatComparison {
  previous?: string;
  sameFingerprint: boolean;
  hash: HashRelation;
}

/** Compared with the newest record of the last rejected `done` of this segment, never with the current one (a replay adds a second record for the same source). */
export function compareWithLastRejection(a: { source: string; fingerprint: string; hash: string | undefined; worktree: boolean; records: VerifyRecord[] | undefined; rejected: string[] | undefined }): RepeatComparison {
  const records = a.records ?? [];
  let last: VerifyRecord | undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (r.source !== a.source && (a.rejected ?? []).includes(r.source)) {
      last = r;
      break;
    }
  }
  const prev = last?.commands.find((c) => typeof c.fingerprint === "string")?.fingerprint;
  const hash: HashRelation = !a.worktree ? "no-worktree" : a.hash === undefined || last?.diff_hash === undefined ? "unknown" : a.hash === last.diff_hash ? "same" : "changed";
  return { ...(last ? { previous: last.source } : {}), sameFingerprint: prev !== undefined && prev === a.fingerprint, hash };
}

/** True when this `done` was already stopped as a repeat in this segment (`segment` is the number of reopens so far). */
export function stoppedInSegment(records: VerifyRecord[] | undefined, source: string, segment: number): boolean {
  return (records ?? []).some((r) => r.source === source && r.repeat_stop_segment === segment);
}

export function repeatAction(cmp: RepeatComparison, s: { counted: boolean; stoppedBefore: boolean; left: number }): RepeatAction {
  if (s.counted) return cmp.sameFingerprint ? "label" : "none";
  if (s.stoppedBefore) return "stop";
  if (s.left <= 0) return "limit";
  if (!cmp.sameFingerprint) return "none";
  return cmp.hash === "same" ? "stop" : "label";
}

/** The label at the top of a rejection mail; the message itself is unchanged. */
export function withRepeatLabel(action: RepeatAction, hash: HashRelation, message: string): string {
  if (action !== "label") return message;
  const changed = hash === "changed" ? " The workspace changed since then, but this result did not." : "";
  return `**Same failure as your last rejected \`done\`** (same command, same exit status, same last lines of output; times and paths ignored).${changed}\n\n${message}`;
}

/** The outcome note when a repeated failure on an unchanged workspace is accepted as partial; `failure` is `describeFailure`'s text. */
export function repeatStopNote(name: string, run: string, failure: string, log: string, used: number, max: number): string {
  return `Verification stopped early: \`${name}\` (\`${run}\`) ${failure}; this is the same failure as the last rejected attempt and the workspace has not changed since, so no progress is likely and the \`done\` was not sent back again (${used} of ${max} rejection(s) used); see ${log}. Reported as partial; the lead's report is kept as written.`;
}
