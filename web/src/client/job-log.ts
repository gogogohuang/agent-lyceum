/** A finished run, lifted out of the log so it can sit above the rounds. */
export type EndedConclusion = {
  kind: "ended";
  endReason: string;
  outcome: string;
  rounds: string;
  logs: string;
  note?: string;
  /** Set when `note` was rewritten so a JSON error inside it reads as its message. */
  noteRaw?: string;
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

/** One or more `tidying … memory of <agent>` headers, collapsed. Every line is kept. */
export type TidyingBlock = { kind: "tidying"; lines: string[] };

export type Block = TextBlock | ErrorBlock | RoundBlock | SkippedBlock | TidiedBlock | TidyingBlock | PromotedBlock;

export type JobLog = {
  truncated: boolean;
  /** The cut-off first line, only when `truncated` and the tail did not start on a line boundary. */
  partial?: string;
  conclusions: Conclusion[];
  blocks: Block[];
};

type Leaf = TextBlock | ErrorBlock;

/**
 * Keys that stay put when a block grows or an earlier block slides out of the tail.
 * The identity is the block's start, not its length. A repeated start gets a `#n` suffix;
 * that suffix can change if an earlier copy of the same start slides away.
 */
export function blockKeys(blocks: Block[]): string[] {
  return enumerate(blocks.map(blockIdentity));
}

/** Keys for the lines inside one round. Appending to a leaf does not change its key. */
export function leafKeys(leaves: Leaf[]): string[] {
  return enumerate(leaves.map((leaf) => (leaf.kind === "error" ? `e-${leaf.message}-${firstLine(leaf.raw)}` : `t-${firstLine(leaf.text)}`)));
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl < 0 ? text : text.slice(0, nl);
}

function enumerate(bases: string[]): string[] {
  const seen = new Map<string, number>();
  return bases.map((base) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

function blockIdentity(block: Block): string {
  switch (block.kind) {
    case "round":
      return `round-${block.n}-${block.agent}-${block.retry ?? ""}`;
    case "tidied":
      return `tidied-${block.agent}-${block.layer}-${block.archive}`;
    case "error":
      return `error-${block.message}-${firstLine(block.raw)}`;
    case "skipped": {
      const first = block.items[0];
      return first ? `skipped-${first.agent}/${first.layer}/${first.reason}` : "skipped";
    }
    case "tidying":
      return `tidying-${block.lines[0] ?? ""}`;
    case "text":
      return `text-${firstLine(block.text)}`;
    case "promoted":
      return `promoted-${block.text}`;
  }
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
export function parseJobLog(text: string, opts?: { truncated?: boolean; lineStart?: boolean }): JobLog {
  const truncated = opts?.truncated === true;
  const lineStart = opts?.lineStart === true;
  if (text === "") return { truncated, conclusions: [], blocks: [] };
  const peeled = peel(text, truncated, lineStart);
  const lines = splitLines(peeled.body);
  const conclusions: Conclusion[] = [];
  const blocks: Block[] = [];
  let round: RoundBlock | undefined;
  let skipped: SkippedBlock | undefined;
  let tidying: TidyingBlock | undefined;
  let separated = false;
  // Conclusions are lifted only after the footer anchor (`Run … ended`). Verification and the lead report stay as text.
  let phase: "log" | "footer" | "verification" | "report" = "log";
  let prevBlank = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (REPORT_RE.test(line) && (phase !== "verification" || prevBlank)) phase = "report";

    if (phase === "report") {
      separated = absorb(bucket(round, blocks), { kind: "text", text: line }, separated);
      prevBlank = line === "";
      continue;
    }

    if (phase === "verification") {
      if (line !== "" && prevBlank && officialAfterVerification(line)) phase = "footer";
      else {
        separated = absorb(bucket(round, blocks), { kind: "text", text: line }, separated);
        prevBlank = line === "";
        continue;
      }
    }

    if (phase === "footer" && VERIFICATION_RE.test(line)) {
      phase = "verification";
      separated = absorb(bucket(round, blocks), { kind: "text", text: line }, separated);
      prevBlank = false;
      continue;
    }

    if (phase === "log" && ENDED_RE.test(line)) phase = "footer";

    if (phase === "footer") {
      const ended = takeEnded(lines, i);
      if (ended) {
        conclusions.push(ended.conclusion);
        separated = true;
        prevBlank = lines[ended.next - 1] === "";
        i = ended.next - 1;
        continue;
      }
      const nextStep = takeNext(lines, i);
      if (nextStep) {
        conclusions.push(nextStep.conclusion);
        separated = true;
        prevBlank = lines[nextStep.next - 1] === "";
        i = nextStep.next - 1;
        continue;
      }
      const branch = takeBranch(lines, i);
      if (branch) {
        conclusions.push(branch.conclusion);
        separated = true;
        prevBlank = lines[branch.next - 1] === "";
        i = branch.next - 1;
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

    if (TIDYING_RE.test(line)) {
      round = undefined;
      if (!tidying) {
        tidying = { kind: "tidying", lines: [] };
        blocks.push(tidying);
      }
      tidying.lines.push(line);
      separated = true;
      prevBlank = false;
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

    if (PROMOTED_RE.test(line)) {
      round = undefined;
      blocks.push({ kind: "promoted", text: line });
      separated = true;
      prevBlank = false;
      continue;
    }

    const cli = takeCliError(lines, i);
    if (cli) {
      separated = absorb(bucket(round, blocks), { kind: "error", message: cli.message, count: 1, raw: cli.raw }, separated);
      prevBlank = lines[cli.next - 1] === "";
      i = cli.next - 1;
      continue;
    }
    separated = absorb(bucket(round, blocks), { kind: "text", text: line }, separated);
    prevBlank = line === "";
  }

  const log: JobLog = { truncated, conclusions, blocks };
  if (peeled.partial !== undefined) log.partial = peeled.partial;
  return log;
}

/**
 * Drop a leading partial line only when the read started mid-line.
 * `lineStart` means the byte before the window was a newline, so the first line is whole even though this string does not start with one.
 * A leading newline is the same boundary when the newline itself is inside the window.
 */
function peel(text: string, truncated: boolean, lineStart: boolean): { body: string; partial?: string } {
  if (!truncated) return { body: text };
  if (lineStart || text.startsWith("\n")) return { body: text.startsWith("\n") ? text.slice(1) : text };
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
  const note = lines[next] !== undefined && NOTE_RE.test(lines[next] ?? "") ? consumeNote(lines, next) : undefined;
  if (note) next = note.next;
  const shown = note ? readableNote(note.body) : undefined;
  return {
    conclusion: {
      kind: "ended",
      endReason: m[2],
      outcome: m[3],
      rounds: m[4],
      logs: m[5],
      ...(shown ? { note: shown.note, ...(shown.noteRaw ? { noteRaw: shown.noteRaw } : {}) } : {}),
    },
    next,
  };
}

/** A `Note:` line, plus the following lines when they finish an unclosed failure template. */
function consumeNote(lines: string[], i: number): { body: string; next: number } {
  const first = lines[i] ?? "";
  const open = wrapOpen(first);
  const grown = open === undefined ? undefined : growWrapped(lines, i, open);
  const raw = grown?.raw ?? first;
  return { body: raw.replace(/^Note: /, ""), next: grown?.next ?? i + 1 };
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
  // The official print always follows the branch sentence with this line. A quote of the sentence alone stays in the body.
  if (!bring?.[1]) return undefined;
  const bringIn = bring[1];
  next += 1;
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
  const tierMatch = raw.match(/^(.*), tier (low|mid|high|\d+)$/);
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

const VERIFICATION_RE = /^Verification \(/;
const FORMAL_CLOSER = /^\)(?:\.|, so the run stopped|; \d+ output file\(s\) set aside)/;
const WRAP_RES = [
  /attempt \d+ failed \(/,
  /failed \d+ time\(s\) in a row \(/,
  /failed every time \(/,
  /^\s*\d+\. \S+: (?:rate_limit|quota|timeout|network|crash|auth|config|unknown error|unknown) \(/,
];

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

/** An error the CLI printed in a complete template, a whole JSON line, or a `failed:` fragment. */
function takeCliError(lines: string[], i: number): { message: string; raw: string; next: number } | undefined {
  const line = lines[i];
  if (line === undefined) return undefined;
  const open = wrapOpen(line);
  if (open !== undefined) {
    const grown = growWrapped(lines, i, open);
    if (!grown) return undefined;
    const message = messageFromPayload(grown.inside);
    if (message === undefined) return undefined;
    return { message, raw: grown.raw, next: grown.next };
  }
  const fromJson = jsonLineMessage(line);
  if (fromJson === undefined) {
    if (!line.includes("failed:")) return undefined;
    const message = lastMessage(line);
    if (message === undefined) return undefined;
    return { message, raw: line, next: i + 1 };
  }
  const closer = lines[i + 1];
  if (closer !== undefined && FORMAL_CLOSER.test(closer)) return { message: fromJson, raw: `${line}\n${closer}`, next: i + 2 };
  return { message: fromJson, raw: line, next: i + 1 };
}

type Scan = { inside: string; closed: boolean; inString: boolean; depth: number };

/** Join following lines only while they still belong to an unclosed template, and only when the `)` is found. */
function growWrapped(lines: string[], i: number, open: number): { raw: string; inside: string; next: number } | undefined {
  let end = i;
  let joined = lines[i] ?? "";
  let scan = scanParen(joined, open);
  while (!scan.closed && end + 1 < lines.length) {
    const next = lines[end + 1];
    if (next === undefined || !continuesTemplate(scan, next)) break;
    end += 1;
    joined = `${joined}\n${next}`;
    scan = scanParen(joined, open);
  }
  if (!scan.closed) return undefined;
  return { raw: joined, inside: scan.inside, next: end + 1 };
}

function continuesTemplate(scan: Scan, nextLine: string): boolean {
  if (ROUND_RE.test(nextLine) || ENDED_RE.test(nextLine) || nextLine === "To go on:" || REPORT_RE.test(nextLine) || TIDYING_RE.test(nextLine) || VERIFICATION_RE.test(nextLine)) return false;
  if (scan.inString || scan.depth > 0) return true;
  if (FORMAL_CLOSER.test(nextLine)) return true;
  return nextLine.trimStart().startsWith("{");
}

/** Find the template's `)`, skipping `)` inside JSON strings and unclosed objects. */
function scanParen(text: string, open: number): Scan {
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (ch === ")" && depth === 0) return { inside: text.slice(open + 1, i), closed: true, inString, depth };
  }
  return { inside: text.slice(open + 1), closed: false, inString, depth };
}

function wrapOpen(line: string): number | undefined {
  for (const re of WRAP_RES) {
    const found = line.match(re);
    if (found?.index !== undefined) return found.index + found[0].length - 1;
  }
  return undefined;
}

function messageFromPayload(inside: string): string | undefined {
  const trimmed = inside.trim();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith("{")) {
    const obj = sliceJsonValue(trimmed);
    if (obj) {
      const parsed = messageOfValue(obj);
      if (parsed !== undefined) return parsed;
      if (obj.length === trimmed.length) return undefined;
    }
  }
  const field = lastMessage(trimmed);
  if (field !== undefined) return field;
  if (!trimmed.includes("{") && !trimmed.includes('"')) return trimmed;
  return undefined;
}

function jsonLineMessage(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  return messageOfValue(trimmed);
}

function messageOfValue(obj: string): string | undefined {
  try {
    const value = JSON.parse(obj) as { type?: unknown; message?: unknown; error?: { message?: unknown } };
    if (value.type === "error" && typeof value.message === "string") return value.message;
    if (value.type === "turn.failed" && typeof value.error?.message === "string") return value.error.message;
    return undefined;
  } catch {
    return undefined;
  }
}

function sliceJsonValue(text: string): string | undefined {
  if (!text.startsWith("{")) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return undefined;
}

/** Replace a complete template payload in a note with its message. The original stays on `noteRaw` when the text changes. */
function readableNote(note: string): { note: string; noteRaw?: string } {
  const open = wrapOpen(note);
  if (open === undefined) return { note };
  const span = scanParen(note, open);
  if (!span.closed) return { note };
  const message = messageFromPayload(span.inside);
  if (message === undefined || message === span.inside) return { note };
  const closeAt = open + 1 + span.inside.length;
  const replaced = `${note.slice(0, open + 1)}${message}${note.slice(closeAt)}`;
  if (replaced === note) return { note };
  return { note: replaced, noteRaw: note };
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

/** Decode one JSON string body (no surrounding quotes) with JSON's own escape rules, including `\uXXXX`. */
function unescapeJson(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
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
