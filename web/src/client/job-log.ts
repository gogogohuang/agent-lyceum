/** A finished run, lifted out of the log so it can sit above the rounds. */
export type EndedConclusion = {
  kind: "ended";
  endReason: string;
  outcome: string;
  rounds: string;
  logs: string;
  note?: string;
};

/** The commands under `To go on:`. Absent when that heading has no command line. */
export type NextConclusion = { kind: "next"; lines: string[] };

/** `The work is on branch ...`, plus the merge and optional patch lines. */
export type BranchConclusion = {
  kind: "branch";
  branch: string;
  files: string;
  bringIn: string;
  patch?: string;
};

export type Conclusion = EndedConclusion | NextConclusion | BranchConclusion;

/** One U+FFFD in the decoded tail, and how many file bytes it replaced. */
export type Utf8Gap = { at: number; source: number };

export type TextBlock = { kind: "text"; at: number; text: string };
export type ErrorBlock = { kind: "error"; at: number; message: string; count: number; raw: string };

export type RoundBlock = {
  kind: "round";
  at: number;
  n: string;
  max?: string;
  agent: string;
  runtime: string;
  model?: string;
  tier?: string;
  retry?: string;
  body: Array<TextBlock | ErrorBlock>;
};

export type SkippedItem = { agent: string; layer: string; reason: string };
export type SkippedBlock = { kind: "skipped"; at: number; count: number; items: SkippedItem[] };

export type TidiedBlock = {
  kind: "tidied";
  at: number;
  agent: string;
  layer: string;
  archive: string;
  undo: string;
  records?: string;
  proposals?: string;
};

export type PromotedBlock = { kind: "promoted"; at: number; text: string };

/** One or more `tidying … memory of <agent>` headers, collapsed. Every line is kept. */
export type TidyingBlock = { kind: "tidying"; at: number; lines: string[] };

export type Block = TextBlock | ErrorBlock | RoundBlock | SkippedBlock | TidiedBlock | TidyingBlock | PromotedBlock;

export type JobLog = {
  truncated: boolean;
  /** The cut-off first line, only when `truncated` and the tail did not start on a line boundary. */
  partial?: string;
  /** File byte of `partial`. */
  partialAt?: number;
  conclusions: Conclusion[];
  blocks: Block[];
};

export type ParseOptions = {
  truncated?: boolean;
  /** The byte before the window was a newline, so the first line is whole. */
  lineStart?: boolean;
  /** File byte of the first byte of `text`. Defaults to 0. */
  byteStart?: number;
  /** Where a decoded U+FFFD stands in for fewer file bytes than its own UTF-8 length. */
  gaps?: readonly Utf8Gap[];
};

type Leaf = TextBlock | ErrorBlock;
type SourceLine = { text: string; at: number };

const encoder = new TextEncoder();

/** Identity of a block: the file byte where its first line starts. */
export function disclosureId(at: number): string {
  return String(at);
}

export function blockKeys(blocks: Block[]): string[] {
  return blocks.map((block) => disclosureId(block.at));
}

/** Open state kept by the page, so a block can move in the tree without losing it. */
export function toggleDisclosure(open: ReadonlySet<string>, id: string, nextOpen: boolean): ReadonlySet<string> {
  if (open.has(id) === nextOpen) return open;
  const next = new Set(open);
  if (nextOpen) next.add(id);
  else next.delete(id);
  return next;
}

const ROUND_RE = /^\[round (\d+)(?:\/(\d+))?\] waking (\S+) \(([^)]+)\)(?: — retry (\d+))?$/;
const ENDED_RE = /^Run (.+) ended: ([^,]+), outcome: ([^,]+), after (\d+) round\(s\)\. Logs: (.+)$/;
const NOTE_RE = /^Note: (.*)$/;
const BRANCH_RE = /^The work is on branch (\S+) \((\d+) file\(s\)\); your working tree was not touched\.$/;
const BRING_RE = /^Bring it in with: (.+)$/;
const PATCH_RE = /^\(or apply the patch: (.+)\)$/;
const SKIP_RE = /^\s*(\S+) \((project|global)\): skipped — (.*)$/;
const TIDIED_RE = /^\s*(\S+) \((project|global)\): tidied\. Archive: (.+) — undo with: (.+)$/;
const PROMOTED_RE = /^promoted \d+ decision\(s\) into the project records: /;
const TIDYING_RE = /^tidying (?:project|global) memory of \S+ \(/;
const REPORT_RE = /^Lead's final message — /;
const VERIFICATION_RE = /^Verification \(/;

/** How long a job has been running, for the detail summary. Negative or non-finite values read as zero. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 秒";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小時 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/**
 * Turn a job's stdout/stderr tail into sections a person can read.
 * A truncated tail does not lift conclusions. Report and verification boundaries still hold. Only a line that is entirely an error JSON object is folded.
 * Nothing is discarded: merged and lifted lines stay on the result, and the page also keeps the raw tail.
 */
export function parseJobLog(text: string, opts?: ParseOptions): JobLog {
  const truncated = opts?.truncated === true;
  const byteStart = opts?.byteStart ?? 0;
  const gaps = opts?.gaps ?? [];
  if (text === "") return { truncated, conclusions: [], blocks: [] };
  const peeled = peel(sourceLines(text, byteStart, gaps), text, truncated, opts?.lineStart === true);
  const lines = peeled.body;
  const conclusions: Conclusion[] = [];
  const blocks: Block[] = [];
  let round: RoundBlock | undefined;
  let skipped: SkippedBlock | undefined;
  let tidying: TidyingBlock | undefined;
  let separated = false;
  let phase: "log" | "footer" | "verification" | "report" = "log";
  let prevBlank = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    if (REPORT_RE.test(line.text) && (phase !== "verification" || prevBlank)) phase = "report";
    if (phase === "report") {
      separated = absorb(bucket(round, blocks), { kind: "text", at: line.at, text: line.text }, separated);
      prevBlank = line.text === "";
      continue;
    }
    if (phase === "verification") {
      if (line.text !== "" && prevBlank && officialAfterVerification(line.text)) phase = "footer";
      else {
        separated = absorb(bucket(round, blocks), { kind: "text", at: line.at, text: line.text }, separated);
        prevBlank = line.text === "";
        continue;
      }
    }
    if (phase === "footer" && VERIFICATION_RE.test(line.text)) {
      phase = "verification";
      separated = absorb(bucket(round, blocks), { kind: "text", at: line.at, text: line.text }, separated);
      prevBlank = false;
      continue;
    }
    if (phase === "log" && ENDED_RE.test(line.text)) phase = "footer";
    if (!truncated && phase === "footer") {
      const lifted = liftFooter(lines, i);
      if (lifted) {
        conclusions.push(lifted.conclusion);
        separated = true;
        prevBlank = lines[lifted.next - 1]?.text === "";
        i = lifted.next - 1;
        continue;
      }
    }

    const roundHead = parseRound(line);
    if (roundHead) {
      round = roundHead;
      blocks.push(round);
      separated = true;
      prevBlank = false;
      continue;
    }

    if (TIDYING_RE.test(line.text)) {
      round = undefined;
      if (!tidying) {
        tidying = { kind: "tidying", at: line.at, lines: [] };
        blocks.push(tidying);
      }
      tidying.lines.push(line.text);
      separated = true;
      prevBlank = false;
      continue;
    }

    const skip = line.text.match(SKIP_RE);
    if (skip?.[1] && skip[2] && skip[3] !== undefined) {
      round = undefined;
      if (!skipped) {
        skipped = { kind: "skipped", at: line.at, count: 0, items: [] };
        blocks.push(skipped);
      }
      skipped.items.push({ agent: skip[1], layer: skip[2], reason: skip[3] });
      skipped.count = skipped.items.length;
      separated = true;
      prevBlank = false;
      continue;
    }

    const tidied = parseTidied(line);
    if (tidied) {
      round = undefined;
      blocks.push(tidied);
      separated = true;
      prevBlank = false;
      continue;
    }

    if (PROMOTED_RE.test(line.text)) {
      round = undefined;
      blocks.push({ kind: "promoted", at: line.at, text: line.text });
      separated = true;
      prevBlank = false;
      continue;
    }

    const message = wholeLineError(line.text);
    if (message !== undefined) {
      separated = absorb(bucket(round, blocks), { kind: "error", at: line.at, message, count: 1, raw: line.text }, separated);
      prevBlank = false;
      continue;
    }
    separated = absorb(bucket(round, blocks), { kind: "text", at: line.at, text: line.text }, separated);
    prevBlank = line.text === "";
  }

  const log: JobLog = { truncated, conclusions, blocks };
  if (peeled.partial) {
    log.partial = peeled.partial.text;
    log.partialAt = peeled.partial.at;
  }
  return log;
}

function sourceLines(text: string, byteStart: number, gaps: readonly Utf8Gap[]): SourceLine[] {
  const gapAt = new Map(gaps.map((gap) => [gap.at, gap.source]));
  const lines: SourceLine[] = [];
  let file = byteStart;
  let lineAt = byteStart;
  let start = 0;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\n") {
      lines.push({ text: text.slice(start, i), at: lineAt });
      file += gapAt.get(i) ?? 1;
      i += 1;
      start = i;
      lineAt = file;
      continue;
    }
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    const width = cp > 0xffff ? 2 : 1;
    const replaced = gapAt.get(i);
    file += replaced ?? encoder.encode(text.slice(i, i + width)).length;
    i += width;
  }
  if (!text.endsWith("\n")) lines.push({ text: text.slice(start), at: lineAt });
  return lines;
}

/**
 * Drop a leading partial line only when the read started mid-line.
 * `lineStart` means the byte before the window was a newline.
 * A leading newline is the same boundary when the newline itself is inside the window.
 */
function peel(lines: SourceLine[], text: string, truncated: boolean, lineStart: boolean): { body: SourceLine[]; partial?: SourceLine } {
  if (!truncated) return { body: lines };
  if (lineStart || text.startsWith("\n")) {
    if (text.startsWith("\n") && lines[0]?.text === "") return { body: lines.slice(1) };
    return { body: lines };
  }
  const [first, ...rest] = lines;
  if (!first) return { body: [] };
  return { partial: first, body: rest };
}

function liftFooter(lines: SourceLine[], i: number): { conclusion: Conclusion; next: number } | undefined {
  return takeEnded(lines, i) ?? takeNext(lines, i) ?? takeBranch(lines, i);
}

function takeEnded(lines: SourceLine[], i: number): { conclusion: EndedConclusion; next: number } | undefined {
  const line = lines[i];
  const matched = line?.text.match(ENDED_RE);
  if (!matched?.[2] || !matched[3] || !matched[4] || !matched[5]) return undefined;
  let next = i + 1;
  const noteLine = lines[next]?.text.match(NOTE_RE);
  const note = noteLine?.[1];
  if (noteLine) next += 1;
  return {
    conclusion: {
      kind: "ended",
      endReason: matched[2],
      outcome: matched[3],
      rounds: matched[4],
      logs: matched[5],
      ...(note ? { note } : {}),
    },
    next,
  };
}

function takeNext(lines: SourceLine[], i: number): { conclusion: NextConclusion; next: number } | undefined {
  if (lines[i]?.text !== "To go on:") return undefined;
  const collected: string[] = [];
  let next = i + 1;
  while (next < lines.length) {
    const line = lines[next]?.text;
    if (line === undefined || !/^\s+\S/.test(line)) break;
    collected.push(line.trim());
    next += 1;
  }
  if (collected.length === 0) return undefined;
  return { conclusion: { kind: "next", lines: collected }, next };
}

function takeBranch(lines: SourceLine[], i: number): { conclusion: BranchConclusion; next: number } | undefined {
  const matched = lines[i]?.text.match(BRANCH_RE);
  if (!matched?.[1] || !matched[2]) return undefined;
  let next = i + 1;
  const bring = lines[next]?.text.match(BRING_RE);
  if (!bring?.[1]) return undefined;
  const bringIn = bring[1];
  next += 1;
  const patch = lines[next]?.text.match(PATCH_RE)?.[1];
  if (patch) next += 1;
  return {
    conclusion: {
      kind: "branch",
      branch: matched[1],
      files: matched[2],
      bringIn,
      ...(patch ? { patch } : {}),
    },
    next,
  };
}

function parseRound(line: SourceLine): RoundBlock | undefined {
  const matched = line.text.match(ROUND_RE);
  if (!matched?.[1] || !matched[3] || !matched[4]) return undefined;
  const who = parseWho(matched[4]);
  const block: RoundBlock = { kind: "round", at: line.at, n: matched[1], agent: matched[3], runtime: who.runtime, body: [] };
  if (matched[2]) block.max = matched[2];
  if (who.model) block.model = who.model;
  if (who.tier) block.tier = who.tier;
  if (matched[5]) block.retry = matched[5];
  return block;
}

function parseWho(raw: string): { runtime: string; model?: string; tier?: string } {
  const tierMatch = raw.match(/^(.*), tier (low|mid|high|\d+)$/);
  const main = tierMatch?.[1] ?? raw;
  const tier = tierMatch?.[2];
  const slash = main.indexOf("/");
  const named = slash < 0 ? { runtime: main } : { runtime: main.slice(0, slash), model: main.slice(slash + 1) };
  return tier ? { ...named, tier } : named;
}

function parseTidied(line: SourceLine): TidiedBlock | undefined {
  const matched = line.text.match(TIDIED_RE);
  if (!matched?.[1] || !matched[2] || !matched[3] || !matched[4]) return undefined;
  const paths = splitArchive(matched[3]);
  const block: TidiedBlock = { kind: "tidied", at: line.at, agent: matched[1], layer: matched[2], archive: paths.archive, undo: matched[4] };
  if (paths.records) block.records = paths.records;
  if (paths.proposals) block.proposals = paths.proposals;
  return block;
}

function splitArchive(blob: string): { archive: string; records?: string; proposals?: string } {
  const proposalsMark = ", proposals: ";
  const recordsMark = ", records: ";
  let rest = blob;
  let proposals: string | undefined;
  let records: string | undefined;
  const proposalAt = rest.lastIndexOf(proposalsMark);
  if (proposalAt >= 0) {
    proposals = rest.slice(proposalAt + proposalsMark.length);
    rest = rest.slice(0, proposalAt);
  }
  const recordAt = rest.lastIndexOf(recordsMark);
  if (recordAt >= 0) {
    records = rest.slice(recordAt + recordsMark.length);
    rest = rest.slice(0, recordAt);
  }
  return { archive: rest, ...(records !== undefined ? { records } : {}), ...(proposals !== undefined ? { proposals } : {}) };
}

/** A line printRun emits as its own section after the verification paragraph. */
function officialAfterVerification(line: string): boolean {
  return (
    BRANCH_RE.test(line) ||
    line.startsWith("Dispatcher verification (run by agent-lyceum):") ||
    line.startsWith("Pull request ") ||
    line.startsWith("A pull request ") ||
    line.startsWith("The pull request could not be opened")
  );
}

/** The trimmed line is one error JSON object: `type: error` or `type: turn.failed`. */
function wholeLineError(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as { type?: unknown; message?: unknown; error?: { message?: unknown } };
  if (obj.type === "error" && typeof obj.message === "string") return obj.message;
  if (obj.type === "turn.failed" && typeof obj.error?.message === "string") return obj.error.message;
  return undefined;
}

type Bucket = {
  last(): Leaf | undefined;
  push(leaf: Leaf): void;
  setText(text: string): void;
};

function bucket(round: RoundBlock | undefined, blocks: Block[]): Bucket {
  const into: Array<Leaf | Block> = round ? round.body : blocks;
  return {
    last() {
      const prev = into.at(-1);
      if (prev?.kind === "text" || prev?.kind === "error") return prev;
      return undefined;
    },
    push(leaf) {
      into.push(leaf);
    },
    setText(text) {
      const prev = into.at(-1);
      if (prev?.kind === "text") prev.text = text;
    },
  };
}

/** A blank line keeps a text block together, and stops two errors from counting as one run. */
function absorb(into: Bucket, leaf: Leaf, separated: boolean): boolean {
  const prev = into.last();
  if (leaf.kind === "text") {
    if (leaf.text === "") {
      if (prev?.kind === "text") into.setText(`${prev.text}\n`);
      else return true;
      return false;
    }
    if (prev?.kind === "text") into.setText(`${prev.text}\n${leaf.text}`);
    else into.push(leaf);
    return false;
  }
  if (!separated && prev?.kind === "error" && prev.message === leaf.message) {
    prev.count += 1;
    prev.raw = `${prev.raw}\n${leaf.raw}`;
    return false;
  }
  into.push(leaf);
  return false;
}
