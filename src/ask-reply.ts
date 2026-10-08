import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./fs-util.js";

export const MAX_QUESTIONS_PER_ASK = 10;
export const ASK_REPLY_FILE = "ask-reply.md";

export type AnswerSource = "user" | "default";

export interface AskQuestion {
  id: string;
  text: string;
  options?: string[];
  suggested?: { value: string; reason?: string };
  /** The agent that asked; the answer goes back to it. */
  asker: string;
  answer?: { value: string; by: AnswerSource };
  /** The answer was already sent to the asker. */
  delivered?: boolean;
}

export interface AskReply {
  status: "pending" | "answered";
  /** Who asked the latest batch. */
  askedBy: string;
  /** The round of the latest batch. */
  round: number;
  questions: AskQuestion[];
}

export type NewQuestion = Omit<AskQuestion, "asker" | "answer" | "delivered">;

export const askReplyPath = (runDir: string): string => path.join(runDir, "mail", ASK_REPLY_FILE);

// ---- a tiny reader for the few tags used here (no XML dependency) ----

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s: string): string => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

interface Tag {
  attrs: Record<string, string>;
  inner: string;
}

function tags(xml: string, name: string): Tag[] {
  const re = new RegExp(`<${name}((?:\\s+[\\w-]+="[^"]*")*)\\s*(?:/>|>([\\s\\S]*?)</${name}>)`, "g");
  return [...xml.matchAll(re)].map((m) => {
    const attrs: Record<string, string> = {};
    for (const a of (m[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1] as string] = unesc(a[2] as string);
    return { attrs, inner: m[2] ?? "" };
  });
}
const first = (xml: string, name: string): Tag | undefined => tags(xml, name)[0];
const textOf = (t: Tag | undefined): string => unesc((t?.inner ?? "").trim());

// ---- the body of an `ask` mail ----

export function parseAskBody(body: string): { ok: true; questions: NewQuestion[] } | { ok: false; error: string } {
  const block = first(body, "ask");
  if (!block) return { ok: false, error: "the body has no <ask>…</ask> block" };
  const found = tags(block.inner, "question");
  if (found.length === 0) return { ok: false, error: "the <ask> block needs at least one <question>" };
  if (found.length > MAX_QUESTIONS_PER_ASK) return { ok: false, error: `at most ${MAX_QUESTIONS_PER_ASK} questions per ask (got ${found.length}); ask the most important ones first` };
  const seen = new Set<string>();
  const questions: NewQuestion[] = [];
  for (const [i, q] of found.entries()) {
    const id = q.attrs.id?.trim();
    if (!id || !/^[\w.-]+$/.test(id)) return { ok: false, error: `question ${i + 1} needs an id attribute made of letters, digits, "_", "-" or "."` };
    if (seen.has(id)) return { ok: false, error: `duplicate question id "${id}"` };
    seen.add(id);
    const text = textOf(first(q.inner, "text"));
    if (!text) return { ok: false, error: `question "${id}" needs a non-empty <text>` };
    const options = tags(first(q.inner, "options")?.inner ?? "", "option").map((o) => textOf(o)).filter(Boolean);
    const sug = first(q.inner, "suggested");
    const suggested = sug && textOf(sug) ? { value: textOf(sug), ...(sug.attrs.reason ? { reason: sug.attrs.reason } : {}) } : undefined;
    if (suggested && options.length && !options.includes(suggested.value)) return { ok: false, error: `the suggested value of question "${id}" must be one of its options` };
    questions.push({ id, text, ...(options.length ? { options } : {}), ...(suggested ? { suggested } : {}) });
  }
  return { ok: true, questions };
}

// ---- the ask-reply file ----

export function parseAskReply(text: string): AskReply {
  const root = first(text, "ask-reply");
  if (!root) throw new Error("ask-reply.md has no <ask-reply> root tag");
  const askedBy = root.attrs.asked_by ?? "";
  const questions = tags(root.inner, "question").map((q): AskQuestion => {
    const ans = first(q.inner, "answer");
    const value = textOf(ans);
    const options = tags(first(q.inner, "options")?.inner ?? "", "option").map((o) => textOf(o));
    const sug = first(q.inner, "suggested");
    return {
      id: q.attrs.id ?? "",
      text: textOf(first(q.inner, "text")),
      ...(options.length ? { options } : {}),
      ...(sug && textOf(sug) ? { suggested: { value: textOf(sug), ...(sug.attrs.reason ? { reason: sug.attrs.reason } : {}) } } : {}),
      asker: q.attrs.asker ?? askedBy,
      ...(value ? { answer: { value, by: ans?.attrs.by === "default" ? ("default" as const) : ("user" as const) } } : {}),
      ...(q.attrs.delivered === "true" ? { delivered: true } : {}),
    };
  });
  return { status: root.attrs.status === "answered" ? "answered" : "pending", askedBy, round: Number(root.attrs.round) || 0, questions };
}

export function renderAskReply(r: AskReply): string {
  const out = [`<ask-reply status="${r.status}" asked_by="${esc(r.askedBy)}" round="${r.round}">`];
  for (const q of r.questions) {
    out.push(`  <question id="${esc(q.id)}" asker="${esc(q.asker)}"${q.delivered ? ` delivered="true"` : ""}>`);
    out.push(`    <text>${esc(q.text)}</text>`);
    if (q.options?.length) out.push(`    <options>`, ...q.options.map((o) => `      <option>${esc(o)}</option>`), `    </options>`);
    if (q.suggested) out.push(`    <suggested${q.suggested.reason ? ` reason="${esc(q.suggested.reason)}"` : ""}>${esc(q.suggested.value)}</suggested>`);
    out.push(q.answer ? `    <answer by="${q.answer.by}">${esc(q.answer.value)}</answer>` : `    <answer></answer>`);
    out.push(`  </question>`);
  }
  out.push(`</ask-reply>`);
  return out.join("\n") + "\n";
}

export function readAskReply(runDir: string): AskReply | undefined {
  const file = askReplyPath(runDir);
  if (!fs.existsSync(file)) return undefined;
  return parseAskReply(fs.readFileSync(file, "utf8"));
}

export function writeAskReply(runDir: string, r: AskReply): void {
  atomicWrite(askReplyPath(runDir), renderAskReply(r));
}

// ---- batches, answers ----

/** Add a batch of questions, keeping everything already in the file. The same id with the same text is skipped (a re-routed ask after a crash). */
export function addBatch(existing: AskReply | undefined, asker: string, round: number, qs: NewQuestion[]): { ok: true; reply: AskReply } | { ok: false; error: string } {
  const base: AskReply = existing ?? { status: "pending", askedBy: asker, round, questions: [] };
  const added: AskQuestion[] = [];
  for (const q of qs) {
    const old = base.questions.find((x) => x.id === q.id);
    if (old) {
      if (old.text === q.text) continue;
      return { ok: false, error: `question id "${q.id}" is already used in this run for a different question; use a new id` };
    }
    added.push({ ...q, asker });
  }
  if (added.length === 0) return { ok: true, reply: base };
  return { ok: true, reply: { status: "pending", askedBy: asker, round, questions: [...base.questions, ...added] } };
}

export interface AnswerCheck {
  missing: string[];
  invalid: { id: string; reason: string }[];
}

export const isComplete = (c: AnswerCheck): boolean => c.missing.length === 0 && c.invalid.length === 0;

function problem(q: AskQuestion): string | undefined {
  const v = q.answer?.value.trim();
  if (!v) return undefined;
  if (q.options?.length && !q.options.includes(v) && !/^other:\s*\S/.test(v)) return `must be one of: ${q.options.join(", ")} — or start with "other:" and write your own`;
  return undefined;
}

/** Only questions whose answer was not sent yet count. */
export function checkAnswers(r: AskReply): AnswerCheck {
  const c: AnswerCheck = { missing: [], invalid: [] };
  for (const q of r.questions) {
    if (q.delivered) continue;
    if (!q.answer?.value.trim()) c.missing.push(q.id);
    else {
      const reason = problem(q);
      if (reason) c.invalid.push({ id: q.id, reason });
    }
  }
  return c;
}

export function describeCheck(c: AnswerCheck): string[] {
  return [...c.missing.map((id) => `${id}: no answer yet`), ...c.invalid.map((i) => `${i.id}: ${i.reason}`)];
}

export function applyDefaults(r: AskReply): AskReply {
  return {
    ...r,
    questions: r.questions.map((q) => (!q.delivered && !q.answer?.value.trim() && q.suggested ? { ...q, answer: { value: q.suggested.value, by: "default" as const } } : q)),
  };
}

export function askersWithAnswers(r: AskReply): string[] {
  return [...new Set(r.questions.filter((q) => !q.delivered && q.answer?.value.trim()).map((q) => q.asker))];
}

/** The body of the `reply` mail that carries the answers back to `asker`. */
export function renderAnswers(r: AskReply, asker: string): string {
  const out = [`<answers>`];
  for (const q of r.questions.filter((x) => !x.delivered && x.asker === asker && x.answer?.value.trim())) {
    out.push(`  <question id="${esc(q.id)}">`, `    <text>${esc(q.text)}</text>`, `    <answer by="${q.answer?.by}">${esc(q.answer?.value ?? "")}</answer>`, `  </question>`);
  }
  out.push(`</answers>`);
  return out.join("\n");
}

export function markDelivered(r: AskReply): AskReply {
  return { ...r, status: "answered", questions: r.questions.map((q) => (q.answer?.value.trim() ? { ...q, delivered: true } : q)) };
}
