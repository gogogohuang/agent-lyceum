/** A finished run, lifted out of the log so it can sit above the rounds. */
export type EndedConclusion = {
  kind: "ended";
  endReason: string;
  outcome: string;
  rounds: string;
  logs: string;
  note?: string;
};

/** The commands under `To go on:`. */
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

export type TextBlock = { kind: "text"; text: string };
export type ErrorBlock = { kind: "error"; message: string; count: number; raw: string };

export type RoundBlock = {
  kind: "round";
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
export type SkippedBlock = { kind: "skipped"; count: number; items: SkippedItem[] };

export type TidiedBlock = {
  kind: "tidied";
  agent: string;
  layer: string;
  archive: string;
  undo: string;
  records?: string;
  proposals?: string;
};

export type PromotedBlock = { kind: "promoted"; text: string };

export type Block = TextBlock | ErrorBlock | RoundBlock | SkippedBlock | TidiedBlock | PromotedBlock;

export type JobLog = {
  truncated: boolean;
  /** The cut-off first line, only when `truncated` and the tail did not start on a line boundary. */
  partial?: string;
  conclusions: Conclusion[];
  blocks: Block[];
};

type Leaf = TextBlock | ErrorBlock;

const ROUND_RE = /^\[round (\d+)(?:\/(\d+))?\] waking (\S+) \(([^)]+)\)(?: — retry (\d+))?$/;
const ENDED_RE = /^Run (.+) ended: ([^,]+), outcome: ([^,]+), after (\d+) round\(s\)\. Logs: (.+)$/;
const NOTE_RE = /^Note: (.*)$/;
const BRANCH_RE = /^The work is on branch (\S+) \((\d+) file\(s\)\); your working tree was not touched\.$/;
const BRING_RE = /^Bring it in with: (.+)$/;
const PATCH_RE = /^\(or apply the patch: (.+)\)$/;
const SKIP_RE = /^\s*(\S+) \((project|global)\): skipped — (.*)$/;
const TIDIED_RE = /^\s*(\S+) \((project|global)\): tidied\. Archive: (.+) — undo with: (.+)$/;
const PROMOTED_RE = /^promoted \d+ decision\(s\) into the project records: /;

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
 * Nothing is discarded: merged and lifted lines stay on the result, and the page also keeps the raw tail.
 */
export function parseJobLog(text: string, opts?: { truncated?: boolean }): JobLog {
  const truncated = opts?.truncated === true;
  if (text === "") return { truncated, conclusions: [], blocks: [] };
  const peeled = peel(text, truncated);
  const lines = splitLines(peeled.body);
  const conclusions: Conclusion[] = [];
  const blocks: Block[] = [];
  let round: RoundBlock | undefined;
  let skipped: SkippedBlock | undefined;
  let separated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    const ended = takeEnded(lines, i);
    if (ended) {
      conclusions.push(ended.conclusion);
      i = ended.next - 1;
      separated = false;
      continue;
    }
    const nextStep = takeNext(lines, i);
    if (nextStep) {
      conclusions.push(nextStep.conclusion);
      i = nextStep.next - 1;
      separated = false;
      continue;
    }
    const branch = takeBranch(lines, i);
    if (branch) {
      conclusions.push(branch.conclusion);
      i = branch.next - 1;
      separated = false;
      continue;
    }

    const roundHead = parseRound(line);
    if (roundHead) {
      round = roundHead;
      blocks.push(round);
      separated = false;
      continue;
    }

    const skip = line.match(SKIP_RE);
    if (skip?.[1] && skip[2] && skip[3] !== undefined) {
      round = undefined;
      if (!skipped) {
        skipped = { kind: "skipped", count: 0, items: [] };
        blocks.push(skipped);
      }
      skipped.items.push({ agent: skip[1], layer: skip[2], reason: skip[3] });
      skipped.count = skipped.items.length;
      separated = false;
      continue;
    }

    const tidied = parseTidied(line);
    if (tidied) {
      round = undefined;
      blocks.push(tidied);
      separated = false;
      continue;
    }

    if (PROMOTED_RE.test(line)) {
      round = undefined;
      blocks.push({ kind: "promoted", text: line });
      separated = false;
      continue;
    }

    const message = errorMessage(line);
    if (message !== undefined) {
      separated = absorb(bucket(round, blocks), { kind: "error", message, count: 1, raw: line }, separated);
      continue;
    }
    separated = absorb(bucket(round, blocks), { kind: "text", text: line }, separated);
  }

  const log: JobLog = { truncated, conclusions, blocks };
  if (peeled.partial !== undefined) log.partial = peeled.partial;
  return log;
}

/** Drop a leading partial line only when the read started mid-line. A leading newline means the cut landed on a boundary. */
function peel(text: string, truncated: boolean): { body: string; partial?: string } {
  if (!truncated) return { body: text };
  if (text.startsWith("\n")) return { body: text.slice(1) };
  const nl = text.indexOf("\n");
  if (nl < 0) return { body: "", partial: text };
  return { partial: text.slice(0, nl), body: text.slice(nl + 1) };
}

function splitLines(body: string): string[] {
  if (body === "") return [];
  const lines = body.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function takeEnded(lines: string[], i: number): { conclusion: EndedConclusion; next: number } | undefined {
  const line = lines[i];
  const m = line?.match(ENDED_RE);
  if (!m?.[2] || !m[3] || !m[4] || !m[5]) return undefined;
  let next = i + 1;
  const noteLine = lines[next]?.match(NOTE_RE);
  const note = noteLine?.[1];
  if (noteLine) next += 1;
  return {
    conclusion: {
      kind: "ended",
      endReason: m[2],
      outcome: m[3],
      rounds: m[4],
      logs: m[5],
      ...(note !== undefined ? { note } : {}),
    },
    next,
  };
}

function takeNext(lines: string[], i: number): { conclusion: NextConclusion; next: number } | undefined {
  if (lines[i] !== "To go on:") return undefined;
  const collected: string[] = [];
  let next = i + 1;
  while (next < lines.length) {
    const line = lines[next];
    if (line === undefined || !/^\s+\S/.test(line)) break;
    collected.push(line.trim());
    next += 1;
  }
  return { conclusion: { kind: "next", lines: collected }, next };
}

function takeBranch(lines: string[], i: number): { conclusion: BranchConclusion; next: number } | undefined {
  const m = lines[i]?.match(BRANCH_RE);
  if (!m?.[1] || !m[2]) return undefined;
  let next = i + 1;
  const bring = lines[next]?.match(BRING_RE);
  let bringIn = "";
  if (bring?.[1]) {
    bringIn = bring[1];
    next += 1;
  }
  const patchLine = lines[next]?.match(PATCH_RE);
  const patch = patchLine?.[1];
  if (patch) next += 1;
  return {
    conclusion: {
      kind: "branch",
      branch: m[1],
      files: m[2],
      bringIn,
      ...(patch ? { patch } : {}),
    },
    next,
  };
}

function parseRound(line: string): RoundBlock | undefined {
  const m = line.match(ROUND_RE);
  if (!m?.[1] || !m[3] || !m[4]) return undefined;
  const who = parseWho(m[4]);
  const block: RoundBlock = { kind: "round", n: m[1], agent: m[3], runtime: who.runtime, body: [] };
  if (m[2]) block.max = m[2];
  if (who.model) block.model = who.model;
  if (who.tier) block.tier = who.tier;
  if (m[5]) block.retry = m[5];
  return block;
}

function parseWho(raw: string): { runtime: string; model?: string; tier?: string } {
  const tierMatch = raw.match(/^(.*), tier (\d+)$/);
  const main = tierMatch?.[1] ?? raw;
  const tier = tierMatch?.[2];
  const slash = main.indexOf("/");
  const named = slash < 0 ? { runtime: main } : { runtime: main.slice(0, slash), model: main.slice(slash + 1) };
  return tier ? { ...named, tier } : named;
}

function parseTidied(line: string): TidiedBlock | undefined {
  const m = line.match(TIDIED_RE);
  if (!m?.[1] || !m[2] || !m[3] || !m[4]) return undefined;
  const paths = splitArchive(m[3]);
  const block: TidiedBlock = { kind: "tidied", agent: m[1], layer: m[2], archive: paths.archive, undo: m[4] };
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

/** Whole-line error JSON, or a `failed:` line that still contains a `"message"` fragment. Other JSON stays text. */
function errorMessage(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith("{")) {
    try {
      const value = JSON.parse(trimmed) as { type?: unknown; message?: unknown; error?: { message?: unknown } };
      if (value.type === "error" && typeof value.message === "string") return value.message;
      if (value.type === "turn.failed" && typeof value.error?.message === "string") return value.error.message;
      return undefined;
    } catch {
      // A broken fragment may still carry a message field.
    }
  }
  if (!line.includes("failed:")) return undefined;
  return lastMessage(line);
}

function lastMessage(line: string): string | undefined {
  const re = /"message"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let found: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    const raw = match[1];
    if (raw !== undefined) found = unescapeJson(raw);
  }
  return found;
}

function unescapeJson(raw: string): string {
  return raw.replace(/\\(.)/g, (match) => {
    const ch = match[1] ?? "";
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    if (ch === "t") return "\t";
    if (ch === "b") return "\b";
    if (ch === "f") return "\f";
    return ch;
  });
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
