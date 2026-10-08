# 人工問答（human-in-the-loop）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 可以用 `type: ask` 向使用者提問，run 進入 `waiting`（結束碼 `3`、釋放鎖），使用者填完 `ask-reply.md` 後 `answer`／`resume` 接續，答案以 `reply` 信送回提問者。

**Architecture:** 問題與回答集中在 `runs/<run-id>/mail/ask-reply.md`，由新模組 `src/ask-reply.ts`（純函式：解析、驗證、追加批次、預設值、渲染）管理。`routeOutboxes` 只檢查權限並收集 `ask`；`RunSession.settle` 解析、記錄退回次數、寫檔並以新的 `EndReason`/`RunOutcome` `waiting` 結束；`resume` 時在喚醒任何人之前由 `RunSession` 把答案送給提問者。CLI 新增 `answer` 指令與 `--assume-defaults`，`run`／`resume` 在互動終端機進入 `waiting` 時內建編輯流程。

**Tech Stack:** TypeScript ESM、Node `fs`／`child_process`、Commander、Vitest、Biome。不新增依賴（XML 只用到一小撮固定標籤，自己解析）。

**Spec:** `docs/specs/09-human-in-the-loop.md`

## Global Constraints

- Node >=20，macOS 與 Linux；不新增非必要依賴。
- 沒有 `ask` 的既有 run、測試與舊 `project.yaml`、舊 `state.json` 行為不變且必須可讀；`schema_version: 2` 不變。
- 結束碼：`0` 完成、`1` 失敗、`2` 部分／受阻、`3` 等待回答（新）、`130` 取消。
- 預設一律等待；只有 `--assume-defaults` 才採用 `<suggested>`。
- 一個 run 只有一封 `ask-reply.md`；一批最多 10 題；格式錯誤的 `ask` 退回提問者最多 2 次，第 3 次起改以 `failure` 回報 lead。
- 等待期間不消耗 `max_rounds`；進入 `waiting` 時專案鎖照常釋放（CLI 的 `finally`）。
- 新增指令或設定時，同步更新 `README.md`、`README.zh-TW.md`、`docs/commands.md`、`docs/commands.zh-TW.md`，並通過 `npm run check:docs`。
- 每個 Task 結束時 `npm run typecheck`、`npm test`、`npm run lint` 都要通過。

## 對 spec 的兩處補充（實作需要，Task 9 回寫到 spec）

1. 每題多一個 `asker="<agent>"` 屬性：批次可能來自不同提問者（lead 與 `can_ask_user` 成員），答案要送回各自的提問者。根標籤的 `asked_by` 仍記最近一批的提問者。
2. 答案送出後該題標上 `delivered="true"`：第二批提問時，已答且已送出的題目不會重送，也不再要求回答。

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/ask-reply.ts`（新） | `ask-reply.md` 的資料模型與純函式：`parseAskBody`、`parseAskReply`、`renderAskReply`、`addBatch`、`checkAnswers`、`applyDefaults`、`renderAnswers`、`markDelivered`、檔案讀寫 |
| `src/ask-answer.ts`（新） | CLI 用的 I/O：`prepareAnswers`（套用預設、回報缺題）、`openInEditor` |
| `src/schema.ts`、`src/config.ts` | `can_ask_user` 欄位與預設；`RunOutcome` 加 `waiting`、結束碼 `3` |
| `src/run-store.ts`、`src/run-outcome.ts` | `EndReason` 加 `waiting`、`ask_rejections` 狀態、`endOutcome("waiting")` |
| `src/mailbox.ts` | `ask` 信件類型、權限檢查、`RouteResult.asks` |
| `src/run-session.ts` | 處理 `ask`、進入 `waiting`、resume 時送出答案 |
| `src/prompt.ts` | 協議新增 `ask` 規則 |
| `src/status.ts` | `waiting` 狀態、`ask` 欄位與顯示 |
| `src/cli.ts` | `answer`、`--assume-defaults`、`resume` 的檢查、`reportRun` 的等待提示、TTY 編輯流程 |
| `test/ask-reply.test.ts`（新）、`test/run-ask.test.ts`（新）、`test/ask-flow.test.ts`（新） | 單元、run 層、CLI 整合測試 |

---

### Task 1: 設定 `can_ask_user`

**Files:**
- Modify: `src/schema.ts`（`AgentPartial`）
- Modify: `src/config.ts`（`ResolvedAgent`、解析、`AGENT_FIELDS`、`flattenResolved`）
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `ResolvedAgent.canAskUser: boolean`（lead 預設 `true`，其餘 `false`）；project.yaml／global team.yaml 的 agent 欄位 `can_ask_user: boolean`。

- [ ] **Step 1: 寫失敗的測試**

在 `test/config.test.ts` 末端加入（沿用檔內既有的 `makeEnv` 用法；若檔頭尚未 import 就補上）：

```ts
describe("can_ask_user", () => {
  it("defaults to true for the lead and false for everyone else", () => {
    const env = makeEnv();
    try {
      const p = env.project();
      expect(p.agents.lead?.canAskUser).toBe(true);
      expect(p.agents["fe-member"]?.canAskUser).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("can be switched on for a member in project.yaml and shows in config --resolved", () => {
    const env = makeEnv();
    try {
      env.editProjectYaml((t) => t.replace("  fe-member:\n    can_message: [lead]", "  fe-member:\n    can_message: [lead]\n    can_ask_user: true"));
      const p = env.project();
      expect(p.agents["fe-member"]?.canAskUser).toBe(true);
      expect(flattenResolved(p)["agents.fe-member.can_ask_user"]).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});
```

並確認 `test/config.test.ts` 頂端有 `import { flattenResolved } from "../src/config.js";`（沒有就加）。

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run test/config.test.ts -t can_ask_user`
Expected: FAIL（`canAskUser` 為 `undefined`；第二個測試因 schema `.strict()` 拒絕未知欄位而拋錯）

- [ ] **Step 3: 實作**

`src/schema.ts` 的 `AgentPartial` 在 `can_edit_agent_md` 之後加：

```ts
    can_ask_user: z.boolean().optional(),
```

`src/config.ts`：

`ResolvedAgent` 加欄位（在 `canEditAgentMd` 之後）：

```ts
  /** May send `type: ask` mail to the user (the run then waits for the answer). */
  canAskUser: boolean;
```

在 `const canEdit = pick("can_edit_agent_md");` 之後加 `const canAsk = pick("can_ask_user");`，並把 `["can_edit_agent_md", canEdit],` 後面加 `["can_ask_user", canAsk],`。`agents[agentName] = {...}` 內 `canEditAgentMd: canEdit ?? isLead,` 之後加：

```ts
      canAskUser: canAsk ?? isLead,
```

`AGENT_FIELDS` 陣列在 `"can_edit_agent_md"` 後加入 `"can_ask_user"`。`flattenResolved` 在 `can_edit_agent_md` 那行後加：

```ts
    v[`${p}.can_ask_user`] = a.canAskUser;
```

> 若 `pick` 的型別簽名只認 `AgentPartialT` 的鍵，上面的 schema 變更已經涵蓋；`typecheck` 會指出任何漏掉的地方。

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run test/config.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts src/config.ts test/config.test.ts
git commit -m "feat(ask): can_ask_user agent setting (lead on by default)"
```

---

### Task 2: `ask-reply.ts`（資料模型與純函式）

**Files:**
- Create: `src/ask-reply.ts`
- Test: `test/ask-reply.test.ts`

**Interfaces:**
- Produces（Task 4～8 依賴，名稱與型別必須一致）：

```ts
export const MAX_QUESTIONS_PER_ASK = 10;
export const ASK_REPLY_FILE = "ask-reply.md";
export type AnswerSource = "user" | "default";
export interface AskQuestion {
  id: string;
  text: string;
  options?: string[];
  suggested?: { value: string; reason?: string };
  asker: string;
  answer?: { value: string; by: AnswerSource };
  delivered?: boolean;
}
export interface AskReply { status: "pending" | "answered"; askedBy: string; round: number; questions: AskQuestion[] }
export type NewQuestion = Omit<AskQuestion, "asker" | "answer" | "delivered">;

export const askReplyPath = (runDir: string): string;               // <runDir>/mail/ask-reply.md
export function parseAskBody(body: string): { ok: true; questions: NewQuestion[] } | { ok: false; error: string };
export function parseAskReply(text: string): AskReply;               // throws Error on malformed
export function renderAskReply(r: AskReply): string;
export function addBatch(existing: AskReply | undefined, asker: string, round: number, qs: NewQuestion[]): { ok: true; reply: AskReply } | { ok: false; error: string };
export interface AnswerCheck { missing: string[]; invalid: { id: string; reason: string }[] }
export function checkAnswers(r: AskReply): AnswerCheck;              // only questions not yet delivered
export const isComplete = (c: AnswerCheck): boolean;
export function describeCheck(c: AnswerCheck): string[];            // human lines, one per problem
export function applyDefaults(r: AskReply): AskReply;
export function askersWithAnswers(r: AskReply): string[];            // askers having undelivered questions
export function renderAnswers(r: AskReply, asker: string): string;   // the <answers> block for the reply mail
export function markDelivered(r: AskReply): AskReply;                // delivered=true on all answered; status "answered"
export function readAskReply(runDir: string): AskReply | undefined;
export function writeAskReply(runDir: string, r: AskReply): void;
```

- [ ] **Step 1: 寫失敗的測試**

建立 `test/ask-reply.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  addBatch,
  applyDefaults,
  askersWithAnswers,
  checkAnswers,
  describeCheck,
  isComplete,
  markDelivered,
  parseAskBody,
  parseAskReply,
  renderAnswers,
  renderAskReply,
  type AskReply,
} from "../src/ask-reply.js";

const ASK = `<ask>
  <question id="q1">
    <text>登入要用 session 還是 JWT？</text>
    <options><option>session</option><option>jwt</option></options>
    <suggested reason="既有程式已用 cookie">session</suggested>
  </question>
  <question id="q2"><text>要不要支援舊版 API？</text></question>
</ask>`;

function parsed() {
  const r = parseAskBody(ASK);
  if (!r.ok) throw new Error(r.error);
  return r.questions;
}
const fresh = (): AskReply => {
  const r = addBatch(undefined, "lead", 7, parsed());
  if (!r.ok) throw new Error(r.error);
  return r.reply;
};
const answer = (r: AskReply, id: string, value: string): AskReply => ({
  ...r,
  questions: r.questions.map((q) => (q.id === id ? { ...q, answer: { value, by: "user" as const } } : q)),
});

describe("parseAskBody", () => {
  it("reads questions, options and suggested values", () => {
    const qs = parsed();
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatchObject({ id: "q1", text: "登入要用 session 還是 JWT？", options: ["session", "jwt"], suggested: { value: "session", reason: "既有程式已用 cookie" } });
    expect(qs[1]).toMatchObject({ id: "q2", text: "要不要支援舊版 API？" });
    expect(qs[1]?.options).toBeUndefined();
  });

  it("tolerates prose around the block and unescapes entities", () => {
    const r = parseAskBody(`I need input.\n<ask><question id="a"><text>use a &lt; b &amp; c?</text></question></ask>\nThanks`);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.questions[0]?.text).toBe("use a < b & c?");
  });

  it.each([
    ["no <ask> block", "just words", /<ask>/],
    ["a question without id", `<ask><question><text>x</text></question></ask>`, /id/],
    ["a question without text", `<ask><question id="a"></question></ask>`, /text/],
    ["a duplicate id", `<ask><question id="a"><text>x</text></question><question id="a"><text>y</text></question></ask>`, /duplicate/i],
    ["zero questions", `<ask></ask>`, /at least one/i],
    ["a suggested value that is not an option", `<ask><question id="a"><text>x</text><options><option>p</option></options><suggested>z</suggested></question></ask>`, /suggested/],
  ])("rejects %s", (_name, body, why) => {
    const r = parseAskBody(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(why);
  });

  it("rejects more than 10 questions", () => {
    const many = Array.from({ length: 11 }, (_, i) => `<question id="q${i}"><text>t${i}</text></question>`).join("");
    const r = parseAskBody(`<ask>${many}</ask>`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/10/);
  });
});

describe("ask-reply file", () => {
  it("renders and parses back to the same thing", () => {
    const r = answer(fresh(), "q2", "不用");
    const back = parseAskReply(renderAskReply(r));
    expect(back).toEqual(r);
    expect(renderAskReply(r)).toContain(`<ask-reply status="pending" asked_by="lead" round="7">`);
  });

  it("escapes special characters in answers and reads a hand-edited file", () => {
    const text = renderAskReply(fresh()).replace(`<answer></answer>`, `<answer>a < b</answer>`);
    const back = parseAskReply(text);
    expect(back.questions[0]?.answer).toEqual({ value: "a < b", by: "user" });
    expect(renderAskReply(back)).toContain("a &lt; b");
  });

  it("throws a readable error for a file without the root tag", () => {
    expect(() => parseAskReply("nothing here")).toThrow(/ask-reply/);
  });
});

describe("addBatch", () => {
  it("keeps answered questions and appends the new batch", () => {
    const first = answer(fresh(), "q1", "jwt");
    const more = addBatch(first, "fe-member", 9, [{ id: "q3", text: "新問題" }]);
    expect(more.ok).toBe(true);
    if (!more.ok) return;
    expect(more.reply.round).toBe(9);
    expect(more.reply.askedBy).toBe("fe-member");
    expect(more.reply.status).toBe("pending");
    expect(more.reply.questions.map((q) => [q.id, q.asker])).toEqual([["q1", "lead"], ["q2", "lead"], ["q3", "fe-member"]]);
    expect(more.reply.questions[0]?.answer?.value).toBe("jwt");
  });

  it("is idempotent for the same id with the same text (a re-routed ask after a crash)", () => {
    const first = fresh();
    const again = addBatch(first, "lead", 7, parsed());
    expect(again).toEqual({ ok: true, reply: first });
  });

  it("rejects an id already used with different text", () => {
    const r = addBatch(fresh(), "lead", 8, [{ id: "q1", text: "something else" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/q1/);
  });
});

describe("checkAnswers", () => {
  it("lists unanswered questions", () => {
    const c = checkAnswers(fresh());
    expect(c.missing).toEqual(["q1", "q2"]);
    expect(isComplete(c)).toBe(false);
    expect(describeCheck(c).join("\n")).toMatch(/q1/);
  });

  it("accepts an option, an other: answer and any text for open questions", () => {
    let r = answer(fresh(), "q1", "other: oauth");
    r = answer(r, "q2", "不用");
    expect(isComplete(checkAnswers(r))).toBe(true);
    expect(isComplete(checkAnswers(answer(r, "q1", "jwt")))).toBe(true);
  });

  it("rejects an answer that is not one of the options", () => {
    const c = checkAnswers(answer(answer(fresh(), "q1", "cookie"), "q2", "x"));
    expect(c.invalid).toEqual([{ id: "q1", reason: expect.stringMatching(/session.*jwt.*other:/) }]);
  });

  it("treats a bare 'other:' as empty", () => {
    expect(checkAnswers(answer(fresh(), "q1", "other:")).invalid.map((i) => i.id)).toEqual(["q1"]);
  });

  it("ignores questions that were already delivered", () => {
    let r = answer(answer(fresh(), "q1", "jwt"), "q2", "x");
    r = markDelivered(r);
    const more = addBatch(r, "lead", 9, [{ id: "q3", text: "t" }]);
    if (!more.ok) throw new Error(more.error);
    expect(checkAnswers(more.reply).missing).toEqual(["q3"]);
  });
});

describe("applyDefaults", () => {
  it("fills unanswered questions that have a suggestion, marked by=default, and leaves the rest", () => {
    const r = applyDefaults(fresh());
    expect(r.questions[0]?.answer).toEqual({ value: "session", by: "default" });
    expect(r.questions[1]?.answer).toBeUndefined();
    expect(checkAnswers(r).missing).toEqual(["q2"]);
  });

  it("never overwrites an answer the user gave", () => {
    const r = applyDefaults(answer(fresh(), "q1", "jwt"));
    expect(r.questions[0]?.answer).toEqual({ value: "jwt", by: "user" });
  });
});

describe("answers for the asker", () => {
  it("renders an <answers> block only for that asker's undelivered questions", () => {
    let r = answer(answer(fresh(), "q1", "jwt"), "q2", "不用");
    const more = addBatch(r, "fe-member", 9, [{ id: "q3", text: "t3" }]);
    if (!more.ok) throw new Error(more.error);
    r = answer(more.reply, "q3", "yes");
    expect(askersWithAnswers(r).sort()).toEqual(["fe-member", "lead"]);
    const lead = renderAnswers(r, "lead");
    expect(lead).toContain(`<answers>`);
    expect(lead).toContain(`id="q1"`);
    expect(lead).toContain("jwt");
    expect(lead).not.toContain(`id="q3"`);
  });

  it("markDelivered flags every answered question and sets status answered", () => {
    const r = markDelivered(answer(answer(fresh(), "q1", "jwt"), "q2", "x"));
    expect(r.status).toBe("answered");
    expect(r.questions.every((q) => q.delivered)).toBe(true);
    expect(askersWithAnswers(r)).toEqual([]);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run test/ask-reply.test.ts`
Expected: FAIL（`Cannot find module '../src/ask-reply.js'`）

- [ ] **Step 3: 實作**

建立 `src/ask-reply.ts`：

```ts
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
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run test/ask-reply.test.ts && npm run typecheck && npm run lint`
Expected: PASS。若 `round-trip` 測試因 `answer` 空白或屬性順序失敗，調整 `renderAskReply`／`parseAskReply` 直到 `parse(render(x)) == x`，不要放寬測試。

- [ ] **Step 5: Commit**

```bash
git add src/ask-reply.ts test/ask-reply.test.ts
git commit -m "feat(ask): ask-reply model — parse, validate, batches, defaults"
```

---

### Task 3: `waiting` 結束原因、結果與結束碼 `3`

**Files:**
- Modify: `src/schema.ts`（`RUN_OUTCOMES`、`exitCodeForOutcome`）
- Modify: `src/run-store.ts`（`EndReason`、`WireState` enums、`ask_rejections`）
- Modify: `src/run-outcome.ts`（`endOutcome`）
- Modify: `src/status.ts`（`OUTCOME_ZH`）
- Test: `test/outcome.test.ts`、`test/run-store.test.ts`

**Interfaces:**
- Consumes: 無。
- Produces: `RunOutcome` 與 `EndReason` 皆含 `"waiting"`；`exitCodeForOutcome("waiting") === 3`；`RunState.ask_rejections?: Record<string, number>`；`endOutcome("waiting")` 回 `{ outcome: "waiting", note: <指向 answer 指令的說明> }`。

- [ ] **Step 1: 寫失敗的測試**

`test/outcome.test.ts`：把「exit codes」測試的預期陣列改成（`waiting` 加在 `cancelled` 前）：

```ts
    expect(RUN_OUTCOMES.map((o) => [o, exitCodeForOutcome(o)])).toEqual([
      ["completed", 0],
      ["partial", 2],
      ["blocked", 2],
      ["failed", 1],
      ["waiting", 3],
      ["cancelled", 130],
    ]);
```

同檔加入：

```ts
describe("waiting", () => {
  it("is an outcome of its own, not a failure", () => {
    const o = endOutcome("waiting");
    expect(o.outcome).toBe("waiting");
    expect(o.note).toMatch(/answer/);
  });
});
```

（確認檔頭有 `import { endOutcome } from "../src/run-outcome.js";`，沒有就補。）

`test/run-store.test.ts` 加：

```ts
  it("round-trips a waiting run and its ask rejection counts", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "al-rs-"));
    const s = { ...newRunState({ run_id: "r1" }), end_reason: "waiting" as const, outcome: "waiting" as const, ask_rejections: { lead: 1 } };
    saveRunState(d, s);
    const back = loadRunState(d);
    expect(back.end_reason).toBe("waiting");
    expect(back.outcome).toBe("waiting");
    expect(back.ask_rejections).toEqual({ lead: 1 });
  });
```

（沿用檔內既有 import；缺的 `fs`／`os`／`path`／`newRunState`／`saveRunState` 補上。）

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run test/outcome.test.ts test/run-store.test.ts`
Expected: FAIL（型別錯誤／`waiting` 不在 enum）

- [ ] **Step 3: 實作**

`src/schema.ts`：

```ts
export const RUN_OUTCOMES = ["completed", "partial", "blocked", "failed", "waiting", "cancelled"] as const;
```

`exitCodeForOutcome` 的回傳型別與 switch：

```ts
export function exitCodeForOutcome(outcome: RunOutcome): 0 | 1 | 2 | 3 | 130 {
  switch (outcome) {
    case "completed":
      return 0;
    case "failed":
      return 1;
    case "waiting":
      return 3;
    case "cancelled":
      return 130;
    default:
      return 2;
  }
}
```

`src/run-store.ts`：`EndReason` 加 `| "waiting"`；`WireState` 內 `end_reason` 與 `outcome` 兩個 `z.enum` 各加 `"waiting"`；`RunState` 加欄位：

```ts
  /** How many malformed `ask` mails each agent had sent back (the limit is MAX_ASK_REJECTIONS). */
  ask_rejections?: Record<string, number>;
```

`WireState` 加 `ask_rejections: z.record(z.string(), nonNeg).optional(),`。

`outcomeOf` 的後備推論：`s.end_reason === "waiting" ? "waiting"` 要放在 `cancelled` 判斷旁：

```ts
  return { outcome: s.end_reason === "lead_failed" ? "failed" : s.end_reason === "cancelled" ? "cancelled" : s.end_reason === "waiting" ? "waiting" : "partial", verified: false };
```

`src/run-outcome.ts` 的 `endOutcome` 加：

```ts
    case "waiting":
      return { outcome: "waiting", note: "Waiting for your answers. Fill in ask-reply.md or run `agent-lyceum answer <run-id>`, then continue with `agent-lyceum resume`." };
```

`src/status.ts` 的 `OUTCOME_ZH` 加 `waiting: "等待回答"`。

- [ ] **Step 4: 執行測試與型別檢查**

Run: `npx vitest run test/outcome.test.ts test/run-store.test.ts && npm run typecheck`
Expected: PASS。`typecheck` 若在其他 `switch`／`Record<RunOutcome,…>` 抱怨缺 `waiting`，逐一補上（不要用 `default` 掩蓋）。

- [ ] **Step 5: 全套測試後 Commit**

Run: `npm test && npm run lint`

```bash
git add src test
git commit -m "feat(ask): waiting end reason/outcome and exit code 3"
```

---

### Task 4: 信箱接受 `type: ask`

**Files:**
- Modify: `src/mailbox.ts`（`MESSAGE_TYPES`、`RouteResult`、`routeOutboxes`）
- Test: `test/mailbox.test.ts`

**Interfaces:**
- Consumes: `ResolvedAgent.canAskUser`（Task 1）。
- Produces:

```ts
export const MESSAGE_TYPES = ["task", "reply", "failure", "done", "ask"] as const;
// RouteResult 新增：
asks: { from: string; subject: string; body: string; file: string; source: string }[];
```

`ask` 信不寫進任何收件匣；檔案留在寄件者 outbox，由呼叫端（`RunSession`）接手並移走，與 `done` 相同。`source` 是 `sourceIdOf(sender, file)`，供去重用。

- [ ] **Step 1: 寫失敗的測試**

在 `test/mailbox.test.ts` 加入（沿用檔內 `makeEnv`、`bindRunProject`、`outboxDir`、`write` 的 import 與寫信輔助函式；若檔內沒有可重用的寫信 helper，用下面的 `put`）：

```ts
describe("ask mail", () => {
  const ASK_BODY = `<ask><question id="q1"><text>JWT?</text></question></ask>`;
  const put = (project: ResolvedProject, from: string, type: string, body = ASK_BODY) =>
    write(path.join(outboxDir(project, from), `${Math.random()}.md`), `---\nto: lead\ntype: ${type}\nsubject: need input\n---\n\n${body}\n`);

  it("hands an ask from the lead to the caller instead of delivering it", () => {
    env = makeEnv();
    const p = bindRunProject(env.project(), path.join(env.project().paths.runs, "r1"), "run");
    ensureProjectDirs(p);
    put(p, "lead", "ask");
    const res = routeOutboxes(p);
    expect(res.asks).toHaveLength(1);
    expect(res.asks[0]).toMatchObject({ from: "lead", subject: "need input" });
    expect(res.asks[0]?.body).toContain("<ask>");
    expect(res.delivered).toEqual([]);
    expect(res.rejected).toEqual([]);
    expect(fs.existsSync(res.asks[0]!.file)).toBe(true); // stays in the outbox until the session has stored the questions
  });

  it("rejects an ask from a member without can_ask_user and tells it to write to the lead", () => {
    env = makeEnv();
    const p = bindRunProject(env.project(), path.join(env.project().paths.runs, "r1"), "run");
    ensureProjectDirs(p);
    put(p, "fe-member", "ask");
    const res = routeOutboxes(p);
    expect(res.asks).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]?.reason).toMatch(/can_ask_user/);
    expect(listUnread(p, "fe-member").some((m) => m.meta.subject.includes("rejected"))).toBe(true);
  });

  it("accepts an ask from a member once can_ask_user is on", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("  fe-member:\n    can_message: [lead]", "  fe-member:\n    can_message: [lead]\n    can_ask_user: true"));
    const p = bindRunProject(env.project(), path.join(env.project().paths.runs, "r1"), "run");
    ensureProjectDirs(p);
    put(p, "fe-member", "ask");
    expect(routeOutboxes(p).asks.map((a) => a.from)).toEqual(["fe-member"]);
  });

  it("does not need a `to` for an ask", () => {
    env = makeEnv();
    const p = bindRunProject(env.project(), path.join(env.project().paths.runs, "r1"), "run");
    ensureProjectDirs(p);
    write(path.join(outboxDir(p, "lead"), "a.md"), `---\ntype: ask\nsubject: s\n---\n\n${ASK_BODY}\n`);
    expect(routeOutboxes(p).asks).toHaveLength(1);
  });
});
```

並補 import：`ResolvedProject`（type）、`ensureProjectDirs`、`listUnread`、`routeOutboxes`（來自 `../src/mailbox.js`）、`bindRunProject`、`outboxDir`、`write`、`makeEnv`、`fs`、`path`。

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run test/mailbox.test.ts -t "ask mail"`
Expected: FAIL（`ask` 被當成未知類型而拒絕；`res.asks` 為 `undefined`）

- [ ] **Step 3: 實作**

`src/mailbox.ts`：

```ts
export const MESSAGE_TYPES = ["task", "reply", "failure", "done", "ask"] as const;
```

`RouteResult` 加：

```ts
  /** Questions for the user. Like `done`, the file stays in the outbox until the caller has stored the questions. */
  asks: { from: string; subject: string; body: string; file: string; source: string }[];
```

`routeOutboxes` 開頭 `const res: RouteResult = { delivered: [], rejected: [], warnings: [], asks: [] };`。

類型檢查那段（`!MESSAGE_TYPES.includes(type) || type === "failure"`）的錯誤訊息改為 `(use task, reply, ask or done)`，並在 `if (type === "done") {…}` 之前加：

```ts
      if (type === "ask") {
        if (!sender.canAskUser) {
          reject(`you may not ask the user directly (can_ask_user is off for "${sender.name}"). Put the question in a reply to the lead ("${project.lead}"), who can ask.`);
          continue;
        }
        res.asks.push({ from: sender.name, subject, body: parsed.body, file, source });
        continue;
      }
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run test/mailbox.test.ts && npm run typecheck && npm test`
Expected: PASS（既有 mailbox 測試中檢查拒絕訊息文字的，若含 `(use task, reply or done)` 請同步更新預期）

- [ ] **Step 5: Commit**

```bash
git add src/mailbox.ts test/mailbox.test.ts
git commit -m "feat(ask): mailbox accepts type ask (can_ask_user only)"
```

---

### Task 5: `RunSession` 進入與離開 `waiting`

**Files:**
- Modify: `src/run-session.ts`
- Test: `test/run-ask.test.ts`（新）

**Interfaces:**
- Consumes: Task 2 的 `parseAskBody`／`addBatch`／`readAskReply`／`writeAskReply`／`checkAnswers`／`describeCheck`／`isComplete`／`askersWithAnswers`／`renderAnswers`／`markDelivered`；Task 3 的 `waiting`；Task 4 的 `RouteResult.asks`。
- Produces: `export const MAX_ASK_REJECTIONS = 2;`、`RunSummary.askReplyPath?: string`（`waiting` 時給 CLI 印出）。`runTeam` 在 lead 送出合法 `ask` 後回傳 `endReason: "waiting"`、`outcome: "waiting"`；`resume` 一個 `waiting` 的 run 時，答案已全數填妥才會繼續，否則拋出 `Error`（訊息含缺題列表）。

- [ ] **Step 1: 寫失敗的測試**

建立 `test/run-ask.test.ts`：

```ts
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeResult } from "../src/adapters/index.js";
import { askReplyPath, parseAskReply, readAskReply, renderAskReply, writeAskReply } from "../src/ask-reply.js";
import { runTeam } from "../src/dispatcher.js";
import { listUnread } from "../src/mailbox.js";
import { outboxDir } from "../src/policy.js";
import { bindRunProject, loadRunState } from "../src/run-store.js";
import { prepareTask } from "../src/task.js";
import { FULL_DONE, makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const ASK = (id = "q1", text = "JWT?") => `<ask><question id="${id}"><text>${text}</text><options><option>session</option><option>jwt</option></options><suggested>session</suggested></question></ask>`;

function mail(project: ReturnType<typeof bindRunProject>, from: string, type: string, body: string, to = "lead") {
  write(path.join(outboxDir(project, from), `${Math.random()}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: ${type}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${body}\n`);
}

/** Runs with a scripted invoker: step i is what the i-th wake-up does. */
function scripted(steps: ((agent: string, project: ReturnType<typeof bindRunProject>) => void)[]): { invoker: Invoker; woken: string[] } {
  const woken: string[] = [];
  let i = 0;
  const invoker: Invoker = async (input) => {
    woken.push(input.agent.name);
    steps[i++]?.(input.agent.name, input.project as ReturnType<typeof bindRunProject>);
    return OK;
  };
  return { invoker, woken };
}

function start(invoker: Invoker, runId = "run-a") {
  const project = env.project();
  const runDir = path.join(project.paths.runs, runId);
  const task = prepareTask({ text: "build it", cwd: env.root, runDir });
  return { project, runDir, run: () => runTeam({ project, task, runDir, invoker, log: () => {} }) };
}
const resume = (project: ReturnType<typeof env.project>, runDir: string, invoker: Invoker) =>
  runTeam({ project, resume: loadRunState(runDir), runDir, invoker, log: () => {} });

describe("ask → waiting", () => {
  it("ends the run as waiting after the lead's ask, writes ask-reply.md and does not use up a round", async () => {
    env = makeEnv();
    const { invoker, woken } = scripted([(a, p) => mail(p, a, "ask", ASK())]);
    const { runDir, run } = start(invoker);
    const s = await run();
    expect(s.endReason).toBe("waiting");
    expect(s.outcome).toBe("waiting");
    expect(s.askReplyPath).toBe(askReplyPath(runDir));
    expect(woken).toEqual(["lead"]);
    expect(s.rounds).toBe(1); // the lead's own wake-up counts; waiting adds none
    const r = readAskReply(runDir)!;
    expect(r.status).toBe("pending");
    expect(r.questions.map((q) => [q.id, q.asker])).toEqual([["q1", "lead"]]);
    const st = loadRunState(runDir);
    expect(st.end_reason).toBe("waiting");
    expect(st.outcome).toBe("waiting");
  });

  it("keeps every other mailbox intact so resume can continue", async () => {
    env = makeEnv();
    const { invoker } = scripted([(a, p) => mail(p, a, "ask", ASK())]);
    const { project, runDir, run } = start(invoker);
    await run();
    const bound = bindRunProject(project, runDir, "run");
    expect(listUnread(bound, "lead")).toHaveLength(0); // the task was consumed, the ask was taken from the outbox
    expect(fs.readdirSync(outboxDir(bound, "lead")).filter((f) => f.endsWith(".md"))).toEqual([]);
  });

  it("rejects an ask from a member without can_ask_user (the lead is told to relay it)", async () => {
    env = makeEnv();
    const { invoker } = scripted([
      (a, p) => mail(p, a, "task", "## Goal\ng\n\n## Acceptance criteria\na\n\n## Scope\ns\n\n## Upstream\nNone", "fe-member"),
      (a, p) => mail(p, a, "ask", ASK()),
      (a, p) => mail(p, a, "done", FULL_DONE),
    ]);
    const { run } = start(invoker);
    const s = await run();
    expect(s.endReason).toBe("done");
  });
});

describe("malformed ask", () => {
  it("sends it back twice, then reports a failure to the lead", async () => {
    env = makeEnv();
    const seen: string[] = [];
    const { invoker } = scripted([
      (a, p) => mail(p, a, "ask", "no xml"),
      (a, p) => mail(p, a, "ask", "still no xml"),
      (a, p) => mail(p, a, "ask", "nope"),
      (a, p) => mail(p, a, "done", FULL_DONE),
    ]);
    const wrapped: Invoker = async (i) => {
      seen.push(i.userPrompt);
      return invoker(i);
    };
    const { run } = start(wrapped);
    const s = await run();
    expect(s.endReason).toBe("done"); // never waiting: nothing valid was asked
    expect(seen[1]).toMatch(/ask was not accepted/);
    expect(seen[2]).toMatch(/ask was not accepted/);
    expect(seen[3]).toMatch(/rejected 3 times/);
  });
});

describe("resume from waiting", () => {
  async function waiting() {
    env = makeEnv();
    const first = scripted([(a, p) => mail(p, a, "ask", ASK())]);
    const s = start(first.invoker);
    await s.run();
    return s;
  }

  it("refuses while questions are unanswered and lists which", async () => {
    const { project, runDir } = await waiting();
    await expect(resume(project, runDir, scripted([]).invoker)).rejects.toThrow(/q1/);
    expect(loadRunState(runDir).end_reason).toBe("waiting"); // the refusal changed nothing
  });

  it("delivers the answers to the asker as a reply and finishes", async () => {
    const { project, runDir } = await waiting();
    const r = readAskReply(runDir)!;
    writeAskReply(runDir, { ...r, questions: r.questions.map((q) => ({ ...q, answer: { value: "jwt", by: "user" as const } })) });
    let prompt = "";
    const { invoker, woken } = scripted([(a, p) => mail(p, a, "done", FULL_DONE)]);
    const spy: Invoker = async (i) => {
      prompt = i.userPrompt;
      return invoker(i);
    };
    const s = await resume(project, runDir, spy);
    expect(s.endReason).toBe("done");
    expect(woken).toEqual(["lead"]);
    expect(prompt).toContain("<answers>");
    expect(prompt).toContain("jwt");
    const after = readAskReply(runDir)!;
    expect(after.status).toBe("answered");
    expect(after.questions[0]?.delivered).toBe(true);
  });

  it("a second ask keeps the first answers and only waits for the new question", async () => {
    const { project, runDir } = await waiting();
    const r = readAskReply(runDir)!;
    writeAskReply(runDir, { ...r, questions: r.questions.map((q) => ({ ...q, answer: { value: "jwt", by: "user" as const } })) });
    const second = scripted([(a, p) => mail(p, a, "ask", ASK("q2", "second?"))]);
    const s = await resume(project, runDir, second.invoker);
    expect(s.endReason).toBe("waiting");
    const again = readAskReply(runDir)!;
    expect(again.questions.map((q) => [q.id, q.delivered ?? false])).toEqual([["q1", true], ["q2", false]]);
    await expect(resume(project, runDir, scripted([]).invoker)).rejects.toThrow(/q2/);
  });
});

describe("runs without ask", () => {
  it("are unaffected: no ask-reply.md is created", async () => {
    env = makeEnv();
    const { invoker } = scripted([(a, p) => mail(p, a, "done", FULL_DONE)]);
    const { runDir, run } = start(invoker);
    const s = await run();
    expect(s.endReason).toBe("done");
    expect(fs.existsSync(askReplyPath(runDir))).toBe(false);
  });
});
```

> 注意：`readAskReply`／`writeAskReply`／`parseAskReply`／`renderAskReply` 若有未使用的 import，Biome 會警告，請依實際使用刪減。

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run test/run-ask.test.ts`
Expected: FAIL（`ask` 目前沒有被處理；`askReplyPath` 不在 summary）

- [ ] **Step 3: 實作**

`src/run-session.ts`：

(a) import 與常數：

```ts
import { addBatch, askersWithAnswers, askReplyPath, checkAnswers, describeCheck, isComplete, markDelivered, parseAskBody, readAskReply, renderAnswers, writeAskReply } from "./ask-reply.js";
// mailbox.js 的 import 加上 type RouteResult
```

```ts
/** How many times a malformed `ask` goes back to its sender before the lead is told instead. */
export const MAX_ASK_REJECTIONS = 2;
```

`RunSummary` 加 `askReplyPath?: string;`。

(b) 建構子最前面（`const { task, resume, runDir } = opts;` 之後）加入保護，使被拒絕的 resume 不會改動 `state.json`：

```ts
    if (resume?.end_reason === "waiting") RunSession.assertAnswered(runDir, resume.run_id);
```

並在類別內加：

```ts
  /** A waiting run only continues once every unanswered question has a valid answer. */
  private static assertAnswered(runDir: string, runId: string): void {
    const reply = readAskReply(runDir);
    if (!reply) return;
    const check = checkAnswers(reply);
    if (!isComplete(check)) {
      throw new Error(`Run ${runId} is still waiting for answers in ${askReplyPath(runDir)}:\n${describeCheck(check).map((l) => `  ${l}`).join("\n")}`);
    }
  }
```

(c) `recover()` 內，`const rec = recoverRunMail(...)` 之前加：

```ts
    if (this.resume?.end_reason === "waiting") this.deliverAnswers();
```

並加方法：

```ts
  /** The user answered: send each asker its answers as a `reply`, then mark them delivered. Safe to repeat after a crash. */
  private deliverAnswers(): void {
    const { runDir, project, log } = this;
    const reply = readAskReply(runDir);
    if (!reply) return;
    const ids = reply.questions.filter((q) => !q.delivered).map((q) => q.id).join(",");
    for (const asker of askersWithAnswers(reply)) {
      deliverOnce(project, this.journal(), `ask-answer:${ids}:${asker}`, {
        from: "user",
        to: asker,
        type: "reply",
        subject: "Answers to your questions",
        body: renderAnswers(reply, asker),
      });
    }
    writeAskReply(runDir, markDelivered(reply));
    log("ask-answered", { questions: ids });
  }
```

(d) `settle()`：在 `for (const d of route.delivered) log("route", d);` **之前**插入 ask 處理（它需要在 claims 提交與 done 處理之前完成，且寫檔後才移走 outbox 檔）：

```ts
    const askAccepted = this.handleAsks(route);
```

並在 `if (route.done) { this.doneMessage = …` 區塊結束之後、`const leadIdx = …` 之前加：

```ts
    if (askAccepted) {
      this.endReason = "waiting";
      return;
    }
```

`route.done` 的區塊自己 `return`，因此同時有 `done` 與 `ask` 時以 `done` 為準；`handleAsks` 在這種情況需要知道 done 存在，所以簽名接 `route` 並自行檢查 `route.done`。

加方法：

```ts
  /** Store the questions of this pass's valid `ask` mails; malformed ones go back to their sender. Returns true when the run should now wait. */
  private handleAsks(route: RouteResult): boolean {
    const { say, runDir, project, log, state } = this;
    if (route.asks.length === 0) return false;
    let reply = readAskReply(runDir);
    const accepted: string[] = [];
    for (const a of route.asks) {
      const parsed = parseAskBody(a.body);
      const added = parsed.ok ? addBatch(reply, a.from, state.rounds, parsed.questions) : parsed;
      if (!added.ok) {
        const n = (state.ask_rejections?.[a.from] ?? 0) + 1;
        state.ask_rejections = { ...state.ask_rejections, [a.from]: n };
        rejectDone(a.file);
        const reason = added.error;
        say(`  ask from ${a.from} rejected: ${reason}`);
        log("ask-rejected", { from: a.from, reason, count: n });
        if (n <= MAX_ASK_REJECTIONS) {
          deliverOnce(project, this.journal(), `ask-reject:${a.source}`, {
            from: "dispatcher",
            to: a.from,
            type: "failure",
            subject: "Your ask was not accepted",
            body: `Your \`ask\` was not accepted: ${reason}.\n\nSend it again with this shape (at most 10 questions; \`options\` and \`suggested\` are optional):\n\n<ask>\n  <question id="q1">\n    <text>Question?</text>\n    <options><option>a</option><option>b</option></options>\n    <suggested reason="why">a</suggested>\n  </question>\n</ask>\n\n(Reminder ${n} of ${MAX_ASK_REJECTIONS}.)`,
          });
        } else {
          deliverOnce(project, this.journal(), `ask-reject:${a.source}`, {
            from: "dispatcher",
            to: project.lead,
            type: "failure",
            subject: `${a.from}'s ask was rejected ${n} times`,
            body: `${a.from} sent a malformed \`ask\` ${n} times (last problem: ${reason}). It was dropped. Decide without asking the user, or send the question yourself in the correct format.`,
          });
        }
        continue;
      }
      reply = added.reply;
      accepted.push(a.file);
    }
    if (!accepted.length || !reply) return false;
    if (route.done) {
      for (const f of accepted) finishDone(f);
      this.note("An ask was ignored because the lead also sent done in the same round.");
      return false;
    }
    // Questions are stored first, the outbox file moves second: a crash in between re-routes the same ask, and addBatch skips it.
    writeAskReply(runDir, reply);
    for (const f of accepted) finishDone(f);
    log("ask", { questions: reply.questions.filter((q) => !q.delivered).map((q) => q.id) });
    say(`  waiting for your answers: ${askReplyPath(runDir)}`);
    return true;
  }
```

> 不變式：先 `writeAskReply`、後 `finishDone`；`addBatch` 的冪等性涵蓋「寫入後、移檔前」的崩潰。

(e) `run()` 結尾的 `return { … }` 加上 `askReplyPath: endReason === "waiting" ? askReplyPath(runDir) : undefined`。

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run test/run-ask.test.ts && npm run typecheck && npm test && npm run lint`
Expected: PASS。「rejects an ask from a member…」與「malformed ask」兩個測試依賴 prompt 內容：`buildUserPrompt` 會把未讀的 `failure` 信放進 `userPrompt`，因此 `seen[n]` 能看到「Your ask was not accepted」。若 `seen` 索引與實際喚醒順序不符，以 `woken`／`seen.length` 先印出確認再調整斷言，不要放寬成永遠為真的斷言。

- [ ] **Step 5: Commit**

```bash
git add src/run-session.ts test/run-ask.test.ts
git commit -m "feat(ask): run waits for answers and resumes with them delivered"
```

---

### Task 6: 協議 prompt 新增 `ask`

**Files:**
- Modify: `src/prompt.ts`
- Test: `test/dispatcher.test.ts`（或既有測 `buildSystemPrompt` 的測試檔；用 `grep -ln buildSystemPrompt test/*.ts` 找）

**Interfaces:**
- Consumes: `ResolvedAgent.canAskUser`。
- Produces: 有 `canAskUser` 的 agent，系統 prompt 的 type 清單含 `ask`，並多一節 `## Asking the user`；其餘 agent 的 prompt 逐字不變。

- [ ] **Step 1: 寫失敗的測試**

```ts
describe("ask protocol in the system prompt", () => {
  it("explains ask to the lead and to members with can_ask_user, and to nobody else", () => {
    const env = makeEnv();
    try {
      env.editProjectYaml((t) => t.replace("  qa-member:\n    can_message: [lead]", "  qa-member:\n    can_message: [lead]\n    can_ask_user: true"));
      const p = env.project();
      const lead = buildSystemPrompt(p, p.agents.lead!);
      const fe = buildSystemPrompt(p, p.agents["fe-member"]!);
      const qa = buildSystemPrompt(p, p.agents["qa-member"]!);
      expect(lead).toContain("## Asking the user");
      expect(lead).toContain("<ask>");
      expect(lead).toMatch(/task \| reply \| ask \| done/);
      expect(qa).toContain("## Asking the user");
      expect(qa).toMatch(/task \| reply \| ask/);
      expect(fe).not.toContain("Asking the user");
      expect(fe).not.toContain("<ask>");
    } finally {
      env.cleanup();
    }
  });
});
```

（補 import：`buildSystemPrompt`、`makeEnv`。）

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run -t "ask protocol"`
Expected: FAIL

- [ ] **Step 3: 實作**

`src/prompt.ts` 把 `"type: reply        # task | reply" + (isLead ? " | done" : ""),` 改為：

```ts
    `type: reply        # task | reply${agent.canAskUser ? " | ask" : ""}${isLead ? " | done" : ""}`,
```

在 `"## Message format"` 那一節的 `lines.push(...)` 之後、`...(isLead ? ["", "## Progress tracking …` 之前，加入條件區塊（可併在同一個 spread 清單）：

```ts
    ...(agent.canAskUser
      ? [
          "",
          "## Asking the user",
          "You may ask the human user with `type: ask` (no `to` needed). The run then pauses until they answer, so ask only when the answer changes what you do next and you cannot work it out from the code, the memory or the task. Ask everything you need in ONE batch (at most 10 questions); prefer questions with `<options>` and a `<suggested>` value (with a `reason`) so the user can answer quickly. The body is exactly this:",
          "",
          "```",
          "<ask>",
          '  <question id="q1">',
          "    <text>Session or JWT for login?</text>",
          "    <options><option>session</option><option>jwt</option></options>",
          '    <suggested reason="existing code already uses cookies">session</suggested>',
          "  </question>",
          "</ask>",
          "```",
          "",
          "The answers come back to you as a `reply` mail containing an `<answers>` block. A user answer that starts with `other:` is free text. Do not ask what you could decide yourself, and do not ask again for something already answered.",
        ]
      : []),
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS（既有 prompt 快照／逐字比對測試若比對 lead 的 type 行，改成含 `ask` 的新字串）

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts test
git commit -m "feat(ask): protocol text for agents that may ask the user"
```

---

### Task 7: `status` 顯示 `waiting`

**Files:**
- Modify: `src/status.ts`（`RunReport`、`buildRunReport`、`runStateLabel`、`summaryBlock`）
- Test: `test/status.test.ts`

**Interfaces:**
- Consumes: `readAskReply`／`checkAnswers`／`askReplyPath`（Task 2）。
- Produces: `RunReport.state` 多一個 `"waiting"`；`RunReport.ask?: { path: string; total: number; unanswered: number }`（只在 `end_reason === "waiting"` 時有）。

- [ ] **Step 1: 寫失敗的測試**

在 `test/status.test.ts` 加入（沿用該檔建立 run 的方式；若沒有現成 helper，直接用 `saveRunState`＋`newRunState` 建一個 `end_reason: "waiting"` 的 state，並用 `writeAskReply` 寫入兩題、其中一題已答）：

```ts
describe("a waiting run", () => {
  it("is reported as waiting with the ask-reply path and the number of open questions", () => {
    const env = makeEnv();
    try {
      const project = env.project();
      const dir = path.join(project.paths.runs, "run-w");
      fs.mkdirSync(path.join(dir, "mail"), { recursive: true });
      saveRunState(dir, { ...newRunState({ run_id: "run-w", project: "demo", task_summary: "t" }), end_reason: "waiting", outcome: "waiting" });
      writeAskReply(dir, {
        status: "pending",
        askedBy: "lead",
        round: 1,
        questions: [
          { id: "q1", text: "a?", asker: "lead", answer: { value: "x", by: "user" } },
          { id: "q2", text: "b?", asker: "lead" },
        ],
      });
      const report = buildStatusReport(project, "run-w");
      expect(report.run?.state).toBe("waiting");
      expect(report.run?.ask).toEqual({ path: askReplyPath(dir), total: 2, unanswered: 1 });
      expect(formatStatusReport(report, Date.now(), false)).toContain(askReplyPath(dir));
      expect(formatStatusReport(report, Date.now(), false)).toContain("等待回答");
    } finally {
      env.cleanup();
    }
  });

  it("leaves ordinary runs without an ask field", () => {
    // reuse an existing ended-run fixture of this file and assert: expect(report.run?.ask).toBeUndefined()
  });
});
```

（第二個測試請用檔內既有的 done run fixture 實作，不要留空殼；補齊 import：`saveRunState`、`newRunState`、`writeAskReply`、`askReplyPath`、`buildStatusReport`、`formatStatusReport`、`fs`、`path`。）

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run test/status.test.ts -t "waiting run"`
Expected: FAIL

- [ ] **Step 3: 實作**

`RunReport` 的 `state` 改為 `"running" | "interrupted" | "ended" | "waiting"`，並加：

```ts
  /** Present while the run waits for the user: the file to fill in and how many questions are still open. */
  ask?: { path: string; total: number; unanswered: number };
```

`buildRunReport`：

```ts
  const waiting = s.end_reason === "waiting";
  let ask: RunReport["ask"];
  if (waiting) {
    try {
      const r = readAskReply(run.dir);
      if (r) {
        const open = r.questions.filter((q) => !q.delivered);
        ask = { path: askReplyPath(run.dir), total: open.length, unanswered: open.length - open.filter((q) => q.answer?.value.trim()).length };
      }
    } catch {
      ask = { path: askReplyPath(run.dir), total: 0, unanswered: 0 };
    }
  }
```

回傳物件：`state: waiting ? "waiting" : s.end_reason ? "ended" : live ? "running" : "interrupted",`，並加 `...(ask ? { ask } : {}),`。

`runStateLabel`：`s.end_reason === "waiting"` 時回傳 `"等待回答"`（放在 `if (s.end_reason) {` 內第一行）。`OUTCOME_ZH.waiting` 已在 Task 3 加入。

`summaryBlock`：在 `lines.push(\`${L("流程：")}…\`)` 之前加：

```ts
  if (s.ask) lines.push(`${L("等你回答：")}${s.ask.unanswered}/${s.ask.total} 題未答 → ${s.ask.path}`, c.dim(`          填完後執行 agent-lyceum answer ${s.run_id}（或 resume）`));
```

> `L()` 的欄寬是 10 欄位寬度；「等你回答：」是 5 個全形字（寬 10），剛好對齊。若 `status.test.ts` 有全頁快照，更新快照。

- [ ] **Step 4: 執行測試確認通過**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS（`formatMonitor`、`formatTaskList` 若對 `state` 做窮舉，`typecheck` 會指出；一併補上 `waiting`）

- [ ] **Step 5: Commit**

```bash
git add src/status.ts test/status.test.ts
git commit -m "feat(ask): status shows waiting runs and the ask-reply path"
```

---

### Task 8: CLI — `answer`、`--assume-defaults`、`resume` 的檢查與互動編輯

**Files:**
- Create: `src/ask-answer.ts`
- Modify: `src/cli.ts`
- Test: `test/ask-flow.test.ts`（新，真的啟動 CLI，用 `fake-claude.mjs`）

**Interfaces:**
- Consumes: Task 2 的檔案 API、Task 5 的 `RunSession` 行為。
- Produces（`src/ask-answer.ts`）：

```ts
export interface PrepareResult { complete: boolean; problems: string[]; path: string }
/** Read ask-reply.md of a waiting run; with assumeDefaults fill in suggestions (and save). */
export function prepareAnswers(runDir: string, opts: { assumeDefaults?: boolean }): PrepareResult;
/** Open `file` in $VISUAL / $EDITOR (default vi) and wait. Throws when the editor fails. */
export function openInEditor(file: string, env?: NodeJS.ProcessEnv): void;
```

CLI：`agent-lyceum answer <run-id> -p <project> [--no-edit] [--assume-defaults]`；`run`／`resume` 新增 `--assume-defaults`。結束碼：仍有題目未答 → `3`；其餘沿用。

- [ ] **Step 1: 寫失敗的測試**

建立 `test/ask-flow.test.ts`（結構沿用 `test/integration.test.ts` 的 `setup`，這裡不需要 worktree，所以不呼叫 `makeParallel`／`initGitRepo`）：

```ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readAskReply, writeAskReply } from "../src/ask-reply.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

let env: TestEnv;
afterEach(() => env?.cleanup());

const ASK = `<ask><question id="q1"><text>JWT?</text><options><option>session</option><option>jwt</option></options><suggested reason="cookies">session</suggested></question><question id="q2"><text>old API?</text></question></ask>`;

function setup(script: object) {
  env = makeEnv();
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const scriptFile = path.join(env.root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  const base = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SCRIPT: scriptFile };
  const sync = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8", env: { ...base, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { sync };
}
const runDirOf = () => {
  const root = env.project().paths.runs;
  return path.join(root, fs.readdirSync(root)[0]!);
};
const fillAll = (dir: string, values: Record<string, string>) => {
  const r = readAskReply(dir)!;
  writeAskReply(dir, { ...r, questions: r.questions.map((q) => (values[q.id] ? { ...q, answer: { value: values[q.id]!, by: "user" as const } } : q)) });
};

const SCRIPT = {
  calls: [
    { agent: "lead", mail: [{ type: "ask", subject: "need input", body: ASK }] },
    { agent: "lead", mail: [{ to: "lead", type: "done", subject: "shipped", outcome: "completed" }] },
  ],
};

describe("ask → waiting → answer → completed", () => {
  it("exits 3 with the file path, refuses answer --no-edit until complete, then finishes", () => {
    const t = setup(SCRIPT);
    const first = t.sync(["run", "build it", "-p", "demo"]);
    expect(first.code).toBe(3);
    expect(first.out).toContain("ask-reply.md");
    expect(first.out).toMatch(/waiting/i);

    const dir = runDirOf();
    const status = JSON.parse(t.sync(["status", "-p", "demo", "--json"]).out);
    expect(status.run).toMatchObject({ state: "waiting", end_reason: "waiting", outcome: "waiting" });
    expect(status.run.ask).toMatchObject({ total: 2, unanswered: 2 });

    const early = t.sync(["answer", path.basename(dir), "-p", "demo", "--no-edit"]);
    expect(early.code).toBe(3);
    expect(early.err + early.out).toMatch(/q1/);
    expect(early.err + early.out).toMatch(/q2/);
    expect(t.sync(["resume", path.basename(dir), "-p", "demo"]).code).toBe(3); // resume refuses too

    fillAll(dir, { q1: "jwt", q2: "no" });
    const done = t.sync(["answer", path.basename(dir), "-p", "demo", "--no-edit"]);
    expect(done.code).toBe(0);
    expect(done.out).toMatch(/outcome: completed/);
    expect(readAskReply(dir)?.status).toBe("answered");
  });

  it("lets plain `resume` continue once the file is filled in by hand", () => {
    const t = setup(SCRIPT);
    t.sync(["run", "build it", "-p", "demo"]);
    const dir = runDirOf();
    fillAll(dir, { q1: "other: oauth", q2: "yes" });
    expect(t.sync(["resume", "-p", "demo"]).code).toBe(0);
  });

  it("`answer` without --no-edit opens $EDITOR on the file and validates what it saved", () => {
    const t = setup(SCRIPT);
    t.sync(["run", "build it", "-p", "demo"]);
    const dir = runDirOf();
    const editor = path.join(env.root, "editor.mjs");
    fs.writeFileSync(editor, `import fs from "node:fs";\nconst f = process.argv[2];\nlet t = fs.readFileSync(f, "utf8");\nt = t.replace(/<answer><\\/answer>/g, "<answer>jwt</answer>");\nfs.writeFileSync(f, t);\n`);
    const r = t.sync(["answer", path.basename(dir), "-p", "demo"], { EDITOR: `${process.execPath} ${editor}` });
    // q1 accepts "jwt"; q2 is open-ended so "jwt" is a valid free answer too
    expect(r.code).toBe(0);
  });
});

describe("--assume-defaults", () => {
  it("uses suggestions (marked by=default) but still waits for questions without one", () => {
    const t = setup(SCRIPT);
    t.sync(["run", "build it", "-p", "demo"]);
    const dir = runDirOf();
    const r = t.sync(["answer", path.basename(dir), "-p", "demo", "--no-edit", "--assume-defaults"]);
    expect(r.code).toBe(3);
    const file = readAskReply(dir)!;
    expect(file.questions[0]?.answer).toEqual({ value: "session", by: "default" });
    expect(file.questions[1]?.answer).toBeUndefined();
    expect(r.err + r.out).toMatch(/q2/);
  });

  it("`run --assume-defaults` goes straight on when every question has a suggestion", () => {
    const allSuggested = `<ask><question id="q1"><text>JWT?</text><suggested>session</suggested></question></ask>`;
    const t = setup({
      calls: [
        { agent: "lead", mail: [{ type: "ask", subject: "s", body: allSuggested }] },
        { agent: "lead", mail: [{ to: "lead", type: "done", subject: "shipped", outcome: "completed" }] },
      ],
    });
    const r = t.sync(["run", "build it", "-p", "demo", "--assume-defaults"]);
    expect(r.code).toBe(0);
    expect(readAskReply(runDirOf())?.questions[0]?.answer).toEqual({ value: "session", by: "default" });
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run test/ask-flow.test.ts`
Expected: FAIL（`answer` 指令不存在；`run` 以 `waiting` 結束時結束碼為 2 或崩潰）

- [ ] **Step 3: 實作**

建立 `src/ask-answer.ts`：

```ts
import { spawnSync } from "node:child_process";
import { applyDefaults, askReplyPath, checkAnswers, describeCheck, isComplete, readAskReply, writeAskReply } from "./ask-reply.js";

export interface PrepareResult {
  complete: boolean;
  problems: string[];
  path: string;
}

/** Read the ask-reply file of a waiting run. With `assumeDefaults`, unanswered questions that have a suggestion take it (and the file is saved). */
export function prepareAnswers(runDir: string, opts: { assumeDefaults?: boolean }): PrepareResult {
  const file = askReplyPath(runDir);
  let reply = readAskReply(runDir);
  if (!reply) return { complete: false, problems: ["ask-reply.md does not exist"], path: file };
  if (opts.assumeDefaults) {
    reply = applyDefaults(reply);
    writeAskReply(runDir, reply);
  }
  const check = checkAnswers(reply);
  return { complete: isComplete(check), problems: describeCheck(check), path: file };
}

export function openInEditor(file: string, env: NodeJS.ProcessEnv = process.env): void {
  const editor = env.VISUAL || env.EDITOR || "vi";
  const r = spawnSync(`${editor} ${JSON.stringify(file)}`, { shell: true, stdio: "inherit", env });
  if (r.error || (r.status ?? 0) !== 0) throw new Error(`The editor "${editor}" failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}.`);
}
```

`src/cli.ts`：

(1) import：

```ts
import { openInEditor, prepareAnswers } from "./ask-answer.js";
```

(2) 把 `resume` 動作內「取鎖 → `runTeam` → 釋放」抽成函式（供 `resume`／`answer`／互動迴圈共用）：

```ts
/** Take the lock and continue a run; the lock is released when it stops (also when it stops because it waits for answers). */
async function continueRun(pr: ResolvedProject, dir: string, runId: string): Promise<RunSummary> {
  const lease = takeLock(pr, runId);
  const cancel = cancelOnSignals();
  try {
    console.log(`Project ${pr.name} — repo ${pr.dir}`);
    const state = loadRunState(dir);
    console.log(`Resuming run ${state.run_id} (${state.end_reason ?? "interrupted"}) at round ${state.rounds}/${pr.dispatcher.max_rounds}: ${state.task_summary}`);
    return await runTeam({ project: pr, resume: loadRunState(dir), runDir: dir, signal: cancel.signal });
  } finally {
    cancel.dispose();
    lease.release();
  }
}
```

(3) 等待處理：

```ts
const interactive = (): boolean => !!process.stdin.isTTY && !!process.stdout.isTTY;

function printWaiting(pr: ResolvedProject, runId: string, file: string, problems: string[]): void {
  console.log(`\nRun ${runId} is waiting for your answers.\n  File: ${file}`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log(`Answer with: agent-lyceum answer ${runId} -p ${pr.name}   (or edit the file, then: agent-lyceum resume ${runId} -p ${pr.name})`);
}

/**
 * Keep going while the run stops to ask and the questions can be settled right now: by --assume-defaults, or (in a terminal)
 * by opening the editor. Otherwise print where to answer and exit 3.
 */
async function driveRun(pr: ResolvedProject, runDir: string, first: RunSummary, assumeDefaults: boolean): Promise<never> {
  let summary = first;
  while (summary.outcome === "waiting") {
    let prep = prepareAnswers(runDir, { assumeDefaults });
    while (!prep.complete && interactive()) {
      console.log(`\nRun ${summary.runId} needs your answers (${prep.path}).`);
      openInEditor(prep.path);
      prep = prepareAnswers(runDir, { assumeDefaults: false });
      if (!prep.complete) {
        console.log("Some answers are missing or invalid:");
        for (const p of prep.problems) console.log(`  - ${p}`);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const again = (await rl.question("Edit again? [Y/n] ")).trim().toLowerCase();
        rl.close();
        if (again === "n" || again === "no") break;
      }
    }
    if (!prep.complete) {
      reportRun(summary, runDir);
      printWaiting(pr, summary.runId, prep.path, prep.problems);
      process.exit(3);
    }
    summary = await continueRun(pr, runDir, summary.runId);
  }
  return reportRun(summary, runDir);
}
```

`reportRun` 對 `waiting` 要避免印 `Result saved`（沒有 `doneMessage` 自然不印），並在最後 `process.exit(exitCodeForOutcome(...))` 之前保持原樣；`driveRun` 在 `!prep.complete` 時先呼叫 `reportRun`——但 `reportRun` 是 `never`（會 `process.exit`）。因此改成：把 `reportRun` 拆成 `printRun(summary, runDir): void` 與 `reportRun = (s, d) => { printRun(s, d); process.exit(exitCodeForOutcome(s.outcome)); }`，`driveRun` 在需要時先 `printRun` 再 `printWaiting` 再 `process.exit(3)`。

(4) `run` 動作：加 `.option("--assume-defaults", "when the run stops to ask, use the suggested answer for every question that has one")`，把最後的 `reportRun(summary, runDir);` 換成 `await driveRun(pr, runDir, summary, !!opts.assumeDefaults);`。opts 型別補 `assumeDefaults?: boolean`。

(5) `resume` 動作：加同一個選項；在取鎖前加入等待檢查：

```ts
      if (state.end_reason === "waiting") {
        const prep = prepareAnswers(dir, { assumeDefaults: !!opts.assumeDefaults });
        if (!prep.complete) {
          printWaiting(pr, state.run_id, prep.path, prep.problems);
          process.exit(3);
        }
      }
```

並把原本內嵌的「取鎖 → runTeam」換成 `const summary = await continueRun(pr, dir, state.run_id); await driveRun(pr, dir, summary, !!opts.assumeDefaults);`（刪掉重複的 `console.log(\`Project…\`)` 與 `Resuming run…` 行，已在 `continueRun` 內）。

(6) 新指令（放在 `resume` 之後）：

```ts
program
  .command("answer <run-id>")
  .description("Answer the questions a waiting run asked: opens ask-reply.md in $EDITOR, checks the answers, then continues the run. With --no-edit it only checks a file you already edited.")
  .option("-p, --project <name>")
  .option("--no-edit", "do not open the editor; check the file as it is")
  .option("--assume-defaults", "use the suggested answer for every unanswered question that has one")
  .action(async (runId: string, opts: { project?: string; edit: boolean; assumeDefaults?: boolean }) => {
    try {
      assertName("run", runId);
      const pr = loadProject(opts.project);
      const dir = path.join(pr.paths.runs, runId);
      if (!fs.existsSync(path.join(dir, "state.json"))) fail(`Run "${runId}" not found in ${pr.paths.runs}.`);
      const state = loadRunState(dir);
      if (state.end_reason !== "waiting") fail(`Run ${runId} is not waiting for answers (${state.end_reason ?? "not finished"}).`);
      if (opts.edit) openInEditor(prepareAnswers(dir, {}).path);
      const prep = prepareAnswers(dir, { assumeDefaults: !!opts.assumeDefaults });
      if (!prep.complete) {
        printWaiting(pr, runId, prep.path, prep.problems);
        process.exit(3);
      }
      const res = validateProject(pr);
      if (!res.ok) fail("Configuration is invalid; fix the errors (see `agent-lyceum validate`).");
      await preflight(pr);
      const summary = await continueRun(pr, dir, runId);
      await driveRun(pr, dir, summary, !!opts.assumeDefaults);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : (e as Error).message);
    }
  });
```

> Commander 的 `--no-edit` 會把 `opts.edit` 預設為 `true`、加旗標後為 `false`。`answer` 在編輯器流程不論是否為 TTY 都會開編輯器（`$EDITOR` 由使用者提供；整合測試用腳本編輯器）。

(7) `reportRun`／`printRun` 的第一行對 `waiting` 已能正確顯示 `ended: waiting, outcome: waiting`；`outcomeNote` 會印出 `endOutcome("waiting")` 的說明。

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run test/ask-flow.test.ts && npm test && npm run typecheck && npm run lint`
Expected: PASS。整合測試會多次啟動 `tsx`，若逾時，加大 `it` 的 timeout（`}, 30000)`），不要放寬斷言。

- [ ] **Step 5: 手動驗證互動流程（無法自動化的一條）**

在真實終端機（TTY）用 fake claude 跑：

```bash
EDITOR=nano AGENT_LYCEUM_HOME=<test-home> npx tsx src/cli.ts run "demo" -p demo   # PATH 指到 fake claude
```

預期：lead 提問後直接開 `nano` 編輯 `ask-reply.md`，存檔後（答案齊全）自動接續並以結束碼 `0` 結束；故意留一題空白時顯示缺題並詢問「Edit again?」。把觀察結果寫進 PR 描述。

- [ ] **Step 6: Commit**

```bash
git add src/ask-answer.ts src/cli.ts test/ask-flow.test.ts
git commit -m "feat(ask): answer command, --assume-defaults, editor flow, exit code 3"
```

---

### Task 9: 文件與 spec 狀態

**Files:**
- Modify: `README.md`、`README.zh-TW.md`、`docs/commands.md`、`docs/commands.zh-TW.md`
- Modify: `docs/specs/09-human-in-the-loop.md`、`docs/specs/README.md`

**Interfaces:** 無（文件）。

- [ ] **Step 1: 找出要改的位置**

Run: `grep -n "exit code\|結束碼\|can_edit_agent_md\|resume \[run-id\]\|130" README.md README.zh-TW.md docs/commands.md docs/commands.zh-TW.md`

- [ ] **Step 2: 更新四份文件（中英結構一致）**

每一份都要：
- 結束碼表加上 `3`：英文「waiting for your answers」、中文「等待回答」。
- 指令一覽加入 `answer <run-id> [-p] [--no-edit] [--assume-defaults]`，並在 `run`／`resume` 補 `--assume-defaults`。
- agent 設定欄位表加入 `can_ask_user`（預設：lead `true`、其餘 `false`）。
- 新增一小節說明流程：agent 送 `ask` → run 進入 `waiting` 並印出 `ask-reply.md` 路徑 → `answer`／手動編輯＋`resume` → 答案以 `reply` 送回；附 9.3 的 XML 範例與 `other:` 規則。
- `status` 小節補一句：等待中的 run 會顯示未答題數與信件路徑。

兩種語言新增的 `##`／`###` 標題數量與層級必須相同（`check:docs` 會比對）。

- [ ] **Step 3: 更新 spec**

`docs/specs/09-human-in-the-loop.md`：
- 第 3 行「狀態」改為「狀態：已實作（見 `docs/plans/2026-10-08-09-human-in-the-loop.md`）。」
- 在 9.3 末尾加兩條：每題 `asker="…"` 屬性；已送出的題目標 `delivered="true"`，第二批提問時不再要求回答（理由：批次可來自不同提問者、答案不重送）。

`docs/specs/README.md`：索引表加一列（編號 09、類別「人工問答」、Plan 連到本檔）；若表中尚無 07／08 以外的列，維持既有格式即可。

- [ ] **Step 4: 驗證**

Run: `npm run check:docs && npm test && npm run typecheck && npm run lint`
Expected: 全部通過

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh-TW.md docs
git commit -m "docs(ask): answer command, exit code 3, can_ask_user, spec status"
```

---

## 驗收對照（spec 9.5）

| # | 驗收 | 對應 |
|---|---|---|
| 1 | `ask-reply.ts` 解析／選項／`other:`／缺答案／重複 id／超過 10 題／追加保留已答 | Task 2 |
| 2 | lead `ask` → `waiting`、鎖釋放、結束碼 `3`、`max_rounds` 未增加 | Task 3（碼）、Task 5（狀態與輪數）、Task 8（鎖與碼，CLI） |
| 3 | 非 `can_ask_user` 成員送 `ask` 被拒並通知 | Task 4 |
| 4 | `answer --no-edit` 缺答案拒絕並列題；答完送 `reply` 並自動 resume | Task 8 |
| 5 | `--assume-defaults` 採用建議值並標 `by="default"`，無建議者仍等待 | Task 2（`applyDefaults`）、Task 8 |
| 6 | `resume` 未答完時拒絕 | Task 5（`RunSession`）、Task 8（CLI） |
| 7 | 格式錯誤的 `ask` 退回兩次後轉為 `failure` | Task 5 |
| 8 | `status --json` 含 `waiting` 與信件路徑 | Task 7、Task 8 |
| 9 | 整合測試 ask → waiting → answer → completed | Task 8 |
| 10 | 沒有 `ask` 的既有 run 與測試行為不變，舊 run 可讀 | Task 3（舊 state 讀取）、Task 5（無 ask 的 run）、每個 Task 的全套測試 |

## 風險與備註

- `RunOutcome` 新增 `waiting` 會讓所有窮舉 `switch`／`Record<RunOutcome,…>` 在 `typecheck` 失敗——這是預期的，逐一補上，不用 `default` 掩蓋。
- 舊版 agent-lyceum 讀到 `end_reason: "waiting"` 的 `state.json` 會因 zod enum 失敗；這是向前相容（舊版不認識新狀態），不影響舊 run 在新版的讀取。升級說明寫在 Task 9 的 README 即可。
- XML 以固定標籤的小型解析器處理：只支援本計畫定義的標籤與 `& < > "` 四個實體；使用者在答案裡寫 `<` 時，解析器以非貪婪方式找到 `</answer>` 前的內容並還原實體，裸的 `<` 也會被保留。
