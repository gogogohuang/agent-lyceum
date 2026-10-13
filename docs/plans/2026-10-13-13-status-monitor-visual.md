# status-monitor 圖形化面板 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 status-monitor 面板改成「每個 agent 一個區塊、依 `can_message` 畫關係、區塊內顯示正在做什麼與可讀的信件重點」，並可用 `v` 切回文字版。

**Architecture:** CLI 端只加欄位：`format.ts` 新增 `digestOf`，`run-session.ts` 與 `status.ts` 把 `digest` 寫進 `handling` 與 `queue`，`AgentReport` 加 `can_message`。mod 端新增純函式模組 `hooks/graph.ts`（區塊資料、版面、連結符號、文字行）與一層薄薄的 Ink 檢視 `hooks/graph-view.tsx`，`register.tsx` 只負責接線與 `v` 切換。

**Tech Stack:** TypeScript ESM、Vitest（`vitest run`，CLI 與 mod 的純函式都在同一輪跑）、Ink（透過 `$.ui.resolve(e)` 取得 `Box`／`Text`）、Biome。不新增依賴。

**Spec:** `docs/specs/13-status-monitor-visual.md`

## Global Constraints

- Node >=20，macOS 與 Linux；不新增依賴。
- `status --json` 只加欄位，`schema_version` 維持 `1`；舊測試與舊 state.json 不用改。
- 新面板遇到沒有 `can_message` 或 `digest` 的舊 CLI 要能運作（不畫關係線；`digest` 缺就退回 `brief`，再缺就只顯示主旨）。
- 每段 digest 最多 3 行、每行最多 80 字；`None` 的段落略過。
- 寬度少於 70 欄時區塊直向堆疊、不畫連結符號。
- `plugins/status-monitor` 的純函式測試檔名是 `*.test.ts`（會被 `vitest run` 與 `npm run typecheck:plugin` 涵蓋）；需要真正 mod 執行環境的才用 `*.mod.test.ts`。
- `docs/commands*.md`、`README*.md` 成對文件的標題結構必須一致（`npm run check:docs`）。
- Commit 訊息結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`（執行時若系統提示給了別的 attribution，以系統提示為準）。
- 發版不在這份計畫內，由使用者另外指示。

## File Structure

| 檔案 | 這次的責任 |
|---|---|
| `src/format.ts` | 新增 `DigestSection`、`digestOf(type, body)` |
| `src/run-store.ts` | `WakeTopic` 加 `digest?` |
| `src/run-session.ts` | 組 `handling` 時寫入 `digest` |
| `src/status.ts` | `QueueItem` 加 `brief?`／`digest?` 並在 `queueOf` 產生；`AgentReport.can_message` |
| `test/format-digest.test.ts`（新增） | `digestOf` 各信種 |
| `test/status-graph-data.test.ts`（新增） | `status --json` 的 `can_message`、`queue` 的 `digest` |
| `test/dispatcher.test.ts` | 既有測試多兩個 `digest` 斷言 |
| `plugins/status-monitor/types/index.d.ts` | 同步型別、`view` atom 狀態 |
| `plugins/status-monitor/hooks/graph.ts`（新增） | 純函式：`blocks`、`layout`、`leadLink`、`blockLines`、`bar`、`padCenter`、`paneWidth` |
| `plugins/status-monitor/hooks/graph.test.ts`（新增） | 上述純函式的測試 |
| `plugins/status-monitor/hooks/graph-view.tsx`（新增） | 薄薄一層 Ink 檢視 `graphView()` |
| `plugins/status-monitor/hooks/register.tsx` | `view` atom、`v` 按鈕、圖形模式接線 |
| `plugins/status-monitor/tsconfig.ci.json` | include 新增的純函式檔 |
| `README.md`、`README.zh-TW.md`、`docs/commands.md`、`docs/commands.zh-TW.md` | mod 說明與 `status --json` 新欄位 |
| `docs/specs/13-status-monitor-visual.md`、`docs/specs/README.md` | 狀態更新；修正 13.3 一句不實的敘述 |

---

### Task 1: `digestOf`

**Files:**
- Modify: `src/format.ts`（檔尾新增）
- Test: `test/format-digest.test.ts`（新增）

**Interfaces:**
- Produces: `export interface DigestSection { label: string; lines: string[] }` 與 `export function digestOf(type: string, body: string): DigestSection[]`。Task 2、3 依賴這個名稱與形狀。

- [ ] **Step 1: 寫失敗的測試**

建立 `test/format-digest.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { digestOf } from "../src/format.js";

describe("digestOf", () => {
  it("task: Goal and Acceptance criteria, markdown stripped, long lists cut at 3 lines", () => {
    const body = [
      "## Goal",
      "實作登入頁 UI 與表單驗證。",
      "",
      "## Acceptance criteria",
      "- 路由 /login 可開啟",
      "- 驗證失敗時顯示欄位錯誤訊息",
      "- 送出時呼叫 **auth.login**",
      "- 第四行",
      "",
      "## Scope",
      "src/web/**",
      "",
      "## Upstream",
      "a1b2c3",
    ].join("\n");
    expect(digestOf("task", body)).toEqual([
      { label: "目標", lines: ["實作登入頁 UI 與表單驗證。"] },
      { label: "驗收", lines: ["路由 /login 可開啟", "驗證失敗時顯示欄位錯誤訊息", "送出時呼叫 auth.login…"] },
    ]);
  });

  it("reply: Changes and Verification; Open items and Risks only when not None", () => {
    const quiet = "## Changes\n- 新增 `src/web/login.tsx`\n\n## Verification\n- tsc --noEmit 通過\n\n## Open items\nNone\n\n## Risks\nNone.";
    expect(digestOf("reply", quiet)).toEqual([
      { label: "變更", lines: ["新增 src/web/login.tsx"] },
      { label: "驗證", lines: ["tsc --noEmit 通過"] },
    ]);
    const risky = "## Changes\n- a\n\n## Verification\n- b\n\n## Open items\n- 尚未接真實 API\n\n## Risks\nNone";
    expect(digestOf("reply", risky).map((s) => s.label)).toEqual(["變更", "驗證", "待辦"]);
  });

  it("done: Result and Not done", () => {
    const body = "## Result\n登入頁已完成。\n\n## Files\n- a\n\n## Not done\n- 未做 e2e\n- [ ] 未 commit";
    expect(digestOf("done", body)).toEqual([
      { label: "結果", lines: ["登入頁已完成。"] },
      { label: "未完成", lines: ["未做 e2e", "未 commit"] },
    ]);
  });

  it("ask: one section per question, labelled with its id", () => {
    const body = '<ask>\n  <question id="q1">\n    <text>登入要用 session 還是 JWT？</text>\n  </question>\n  <question id="q2" extra="x">\n    <text>要不要支援舊版 API？</text>\n  </question>\n</ask>';
    expect(digestOf("ask", body)).toEqual([
      { label: "q1", lines: ["登入要用 session 還是 JWT？"] },
      { label: "q2", lines: ["要不要支援舊版 API？"] },
    ]);
  });

  it("failure: the first paragraph", () => {
    const body = "Your outbox message `plan-ui.md` was not delivered: you may only message: lead.\nIt was moved to `rejected/`.\n\nSecond paragraph.";
    expect(digestOf("failure", body)).toEqual([
      { label: "訊息", lines: ["Your outbox message plan-ui.md was not delivered: you may only message: lead.", "It was moved to rejected/."] },
    ]);
  });

  it("falls back to the one-line brief, then to nothing", () => {
    expect(digestOf("reply", "# Title\n\nJust text")).toEqual([{ label: "摘要", lines: ["Just text"] }]);
    expect(digestOf("task", "")).toEqual([]);
    expect(digestOf("whatever", "## Goal\nx")).toEqual([{ label: "摘要", lines: ["x"] }]);
  });

  it("caps a line at 80 characters", () => {
    const [s] = digestOf("task", `## Goal\n${"字".repeat(100)}`);
    expect(s?.lines[0]).toHaveLength(80);
    expect(s?.lines[0]?.endsWith("…")).toBe(true);
  });

  it("skips the dispatcher's format warning", () => {
    expect(digestOf("task", "[agent-lyceum] Format warning: x\n\n## Goal\nShip it")).toEqual([{ label: "目標", lines: ["Ship it"] }]);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/format-digest.test.ts`
Expected: FAIL，`digestOf` 不是 `format.js` 的匯出。

- [ ] **Step 3: 實作**

在 `src/format.ts` 檔尾加入：

```ts
export interface DigestSection {
  label: string;
  lines: string[];
}

const DIGEST_MAX_LINES = 3;
const DIGEST_MAX_CHARS = 80;

/** Which `##` sections say what a message of each type is about, and the label the panel shows for them. */
const DIGEST_SECTIONS: Record<string, { name: string; label: string }[]> = {
  task: [
    { name: "Goal", label: "目標" },
    { name: "Acceptance criteria", label: "驗收" },
  ],
  reply: [
    { name: "Changes", label: "變更" },
    { name: "Verification", label: "驗證" },
    { name: "Open items", label: "待辦" },
    { name: "Risks", label: "風險" },
  ],
  done: [
    { name: "Result", label: "結果" },
    { name: "Not done", label: "未完成" },
  ],
};

function digestLine(l: string): string {
  const t = l
    .trim()
    .replace(/^[-*]\s+(\[[ xX]\]\s+)?/, "")
    .replace(/\*\*|`/g, "")
    .trim();
  return t.length > DIGEST_MAX_CHARS ? `${t.slice(0, DIGEST_MAX_CHARS - 1)}…` : t;
}

/** Readable lines of a block of text: markdown marks gone, empty / heading / warning / `None` lines dropped, at most 3 lines. */
function digestLines(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map(digestLine)
    .filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("[agent-lyceum]") && !/^none\.?$/i.test(l));
  return lines.length > DIGEST_MAX_LINES ? [...lines.slice(0, DIGEST_MAX_LINES - 1), `${lines[DIGEST_MAX_LINES - 1]}…`] : lines;
}

/**
 * What a message is about, as short readable sections for the status panel: by type, the lines under the
 * sections that matter (task: Goal, Acceptance criteria; reply: Changes, Verification, Open items, Risks;
 * done: Result, Not done; ask: each question; failure: the first paragraph). With none of those, the one-line brief.
 * Never throws: a body it cannot read gives [].
 */
export function digestOf(type: string, body: string): DigestSection[] {
  try {
    const out: DigestSection[] = [];
    if (type === "ask") {
      for (const m of body.matchAll(/<question\b[^>]*?\bid="([^"]*)"[^>]*>[\s\S]*?<text>([\s\S]*?)<\/text>/g)) {
        const lines = digestLines(m[2] ?? "");
        if (lines.length) out.push({ label: m[1] ?? "問題", lines });
      }
    } else if (type === "failure") {
      const first = body
        .split(/\n[ \t]*\n/)
        .map(digestLines)
        .find((l) => l.length);
      if (first) out.push({ label: "訊息", lines: first });
    } else {
      for (const s of DIGEST_SECTIONS[type] ?? []) {
        const text = sectionText(body, s.name);
        const lines = text === undefined ? [] : digestLines(text);
        if (lines.length) out.push({ label: s.label, lines });
      }
    }
    if (out.length) return out;
    const brief = briefOf(body);
    return brief ? [{ label: "摘要", lines: [digestLine(brief)] }] : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/format-digest.test.ts`
Expected: PASS（8 個測試）。若 "falls back … whatever" 失敗，檢查 `DIGEST_SECTIONS[type] ?? []` 對未知信種回傳空陣列後有走到 `briefOf`。

- [ ] **Step 5: Commit**

```bash
git add src/format.ts test/format-digest.test.ts
git commit -m "feat(format): add digestOf, a readable per-type summary of a message"
```

---

### Task 2: `status --json` 的新欄位

**Files:**
- Modify: `src/run-store.ts:18-22`（`WakeTopic`）
- Modify: `src/run-session.ts:6`（import）、`:271`（`handling`）
- Modify: `src/status.ts:5-11`（import）、`:157-162`（`QueueItem`）、`:202-208`（`AgentReport`）、`:226-235`（`queueOf`）、`:316-322`（agents）
- Test: `test/status-graph-data.test.ts`（新增）、`test/dispatcher.test.ts:66-69`

**Interfaces:**
- Consumes: Task 1 的 `DigestSection`、`digestOf`。
- Produces: `WakeTopic.digest?: DigestSection[]`；`QueueItem.brief?: string`、`QueueItem.digest?: DigestSection[]`；`AgentReport.can_message: string[]`（`all` 已展開、不含自己）。Task 3 的型別照這些名稱寫。

- [ ] **Step 1: 寫失敗的測試**

建立 `test/status-graph-data.test.ts`：

```ts
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deliver } from "../src/mailbox.js";
import { buildStatusReport } from "../src/status.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

function writeRun(env: TestEnv): void {
  write(
    path.join(env.project().paths.runs, "20260101-000000", "state.json"),
    JSON.stringify({ run_id: "20260101-000000", rounds: 1, max_rounds: 10, last_wake: {}, wakes: [], pid: process.pid }),
  );
}

describe("status --json: graph data", () => {
  it("lists who each agent may message, with `all` expanded and the agent itself left out", () => {
    env = makeEnv();
    const agents = buildStatusReport(env.project()).agents;
    const by = Object.fromEntries(agents.map((a) => [a.name, a.can_message]));
    expect([...(by.lead ?? [])].sort()).toEqual(["fe-member", "qa-member"]);
    expect(by["fe-member"]).toEqual(["lead"]);
    expect(by["qa-member"]).toEqual(["lead"]);
  });

  it("gives queued mail a brief and a digest", () => {
    env = makeEnv();
    writeRun(env);
    const p = env.project();
    deliver(p, { from: "lead", to: "fe-member", type: "task", subject: "Build UI", body: "## Goal\nShip the login form\n\n## Acceptance criteria\n- /login opens\n" });
    const report = buildStatusReport(p);
    const q = report.run?.queue.find((x) => x.agent === "fe-member");
    expect(q?.brief).toBe("Ship the login form");
    expect(q?.digest).toEqual([
      { label: "目標", lines: ["Ship the login form"] },
      { label: "驗收", lines: ["/login opens"] },
    ]);
    expect(report.schema_version).toBe(1);
  });
});
```

在 `test/dispatcher.test.ts` 的 `records handoffs, message briefs…` 測試裡，緊接 `expect(state.wakes[1].handling[0].brief).toBe("Build the login form");` 之後加：

```ts
    expect(state.wakes[1].handling[0].digest).toEqual([{ label: "目標", lines: ["Build the login form"] }]);
```

並在 `expect(state.wakes[2].handling[0].brief).toBe("added login.ts");` 之後加：

```ts
    expect(state.wakes[2].handling[0].digest).toEqual([{ label: "變更", lines: ["added login.ts"] }]);
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/status-graph-data.test.ts test/dispatcher.test.ts`
Expected: FAIL（`can_message` 與 `digest` 都是 `undefined`）。

- [ ] **Step 3: 實作**

`src/run-store.ts`：把 `import type { Step } from "./format.js";` 改成 `import type { DigestSection, Step } from "./format.js";`，並在 `WakeTopic` 加欄位：

```ts
export interface WakeTopic {
  from: string;
  type: string;
  subject: string;
  /** What the message is about, in one line. */
  brief?: string;
  /** The same, as short readable sections by message type (see `digestOf`). */
  digest?: DigestSection[];
}
```

`src/run-session.ts`：第 6 行改成

```ts
import { briefOf, digestOf, doneContract, parseSteps, type DoneContract } from "./format.js";
```

第 271 行改成

```ts
      const handling = unread.map((m) => ({ from: m.meta.from, type: m.meta.type, subject: m.meta.subject, brief: briefOf(m.body), digest: digestOf(m.meta.type, m.body) }));
```

`src/status.ts`：第 8 行 `import type { Step } from "./format.js";` 改成

```ts
import { briefOf, digestOf, type DigestSection, type Step } from "./format.js";
```

`QueueItem`：

```ts
export interface QueueItem {
  agent: string;
  from: string;
  type: string;
  subject: string;
  brief?: string;
  digest?: DigestSection[];
}
```

`AgentReport` 加一個欄位（放在 `unread` 之後）：

```ts
  /** Who this agent may send mail to (`all` expanded, itself left out). */
  can_message: string[];
```

`queueOf` 最後一行改成

```ts
  return rows.map((r) => ({
    agent: r.agent,
    from: r.msg.meta.from,
    type: r.msg.meta.type,
    subject: r.msg.meta.subject,
    brief: briefOf(r.msg.body),
    digest: digestOf(r.msg.meta.type, r.msg.body),
  }));
```

`buildStatusReport` 的 agents map 加 `can_message`：

```ts
    agents: Object.values(project.agents).map((a) => ({
      name: a.name,
      runtime: a.runtime,
      lead: a.name === project.lead,
      unread: listUnread(project, a.name).length,
      can_message: (a.canMessage === "all" ? Object.keys(project.agents) : a.canMessage).filter((n) => n !== a.name),
      last_wake: run?.state.last_wake[a.name],
    })),
```

- [ ] **Step 4: 跑測試與型別檢查**

Run: `npx vitest run test/status-graph-data.test.ts test/dispatcher.test.ts test/status.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: 全過。若 `tsc` 抱怨別處建構 `AgentReport` 少了 `can_message`，在該處補上（`rg "AgentReport" src test`）。

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(status): add can_message and per-message digest to status --json"
```

---

### Task 3: mod 的純函式 `graph.ts`

**Files:**
- Modify: `plugins/status-monitor/types/index.d.ts`
- Create: `plugins/status-monitor/hooks/graph.ts`
- Test: `plugins/status-monitor/hooks/graph.test.ts`（新增）
- Modify: `plugins/status-monitor/tsconfig.ci.json`

**Interfaces:**
- Consumes: Task 2 的 JSON 形狀；`summary.ts` 的 `agentStats`、`clip`、`elapsed`、`tokens`（已存在，簽名見該檔）。
- Produces（Task 4 依賴）：
  - `type Tone = 'bold' | 'dim' | 'ok' | 'warn' | 'bad'`、`type Line = { text: string; tone?: Tone }`
  - `type Block`（欄位見下方程式碼）、`blocks(report: Report, now: number): Block[]`（lead 在最前）
  - `layout(bs: Block[], width: number): { narrow: boolean; memberWidth: number; rows: Block[][] }`
  - `leadLink(bs: Block[], member: Block): { glyph: '▼' | '▲' | '↕'; hot: boolean } | undefined`
  - `blockLines(b: Block): Line[]`
  - `bar(done: number, total: number, width?: number): string`、`padCenter(s: string, width: number): string`、`paneWidth(columns: number | undefined, docked: boolean | undefined): number`

- [ ] **Step 1: 同步型別**

`plugins/status-monitor/types/index.d.ts` 改成（只列有變的部分）：

```ts
export type DigestSection = { label: string; lines: string[] }
export type Step = { text: string; done: boolean }
export type Mail = { from: string; type: string; subject: string; brief?: string; digest?: DigestSection[] }
```

`Run` 裡的 `queue` 改成

```ts
  queue: { agent: string; from: string; type: string; subject: string; brief?: string; digest?: DigestSection[] }[]
```

`Agent` 改成

```ts
export type Agent = { name: string; lead: boolean; unread: number; runtime?: string; can_message?: string[]; last_wake?: { at: string; ok: boolean } }
```

檔尾 `PluginState` 改成

```ts
    'status-monitor': { snapshot: Snapshots; tab: string; view: 'graph' | 'text' }
```

- [ ] **Step 2: 寫失敗的測試**

建立 `plugins/status-monitor/hooks/graph.test.ts`：

```ts
import { expect, test } from 'claude-code/testing'
import { bar, blockLines, blocks, layout, leadLink, padCenter, paneWidth } from './graph'
import type { Report, Run } from '../types'

const NOW = Date.parse('2026-01-01T00:01:05Z')
const run = (o: Partial<Run> = {}): Run => ({
  run_id: 'r1', state: 'running', outcome_verified: false, rounds: 3, max_rounds: 30, output_tokens: 0,
  task_summary: 't', active: {}, queue: [], wakes: [], ...o,
})
const report = (r?: Run): Report => ({
  project: { name: 'p', lead: 'lead' },
  agents: [
    { name: 'fe', lead: false, unread: 0, runtime: 'codex', can_message: ['lead'] },
    { name: 'lead', lead: true, unread: 0, runtime: 'claude-code', can_message: ['fe', 'qa'] },
    { name: 'qa', lead: false, unread: 1, runtime: 'claude-code', can_message: ['fe'] },
  ],
  run: r,
})

test('blocks put the lead first and carry what each agent is doing', () => {
  const r = run({
    active: { lead: { since: '2026-01-01T00:00:00Z', round: 3, handling: [{ from: 'fe', type: 'reply', subject: 'UI done', digest: [{ label: '變更', lines: ['新增 login.tsx'] }] }] } },
    queue: [{ agent: 'qa', from: 'lead', type: 'task', subject: 'write tests', digest: [{ label: '目標', lines: ['為登入頁寫測試', '第二行'] }, { label: '驗收', lines: ['x'] }] }],
    wakes: [{ round: 1, agent: 'fe', ok: true, duration_ms: 4000, output_tokens: 1200 }],
  })
  const bs = blocks(report(r), NOW)
  expect(bs.map(b => b.name)).toEqual(['lead', 'fe', 'qa'])
  const lead = bs[0]!
  expect(lead.dot).toBe('active')
  expect(lead.working).toEqual({ round: 3, elapsed: '1m05s' })
  expect(lead.handling[0]!.head).toBe('來自 fe 的 reply：UI done')
  const qa = bs[2]!
  expect(qa.dot).toBe('queued')
  expect(qa.queued[0]!.sections).toEqual([{ label: '目標', lines: ['為登入頁寫測試'] }])
  expect(bs[1]!.wakes).toBe(1)
  expect(bs[1]!.tokens).toBe(1200)
})

test('a failed last wake shows red, an ended run shows everyone idle', () => {
  const failed = report(run())
  failed.agents[0]!.last_wake = { at: 't', ok: false }
  expect(blocks(failed, NOW).find(b => b.name === 'fe')!.dot).toBe('failed')
  const ended = run({ state: 'ended', active: { lead: { since: '2026-01-01T00:00:00Z' } }, queue: [{ agent: 'qa', from: 'lead', type: 'task', subject: 's' }] })
  expect(blocks(report(ended), NOW).map(b => b.dot)).toEqual(['idle', 'idle', 'idle'])
})

test('mail falls back from digest to brief to the subject alone', () => {
  const r = run({ active: { lead: { since: '2026-01-01T00:00:00Z', handling: [
    { from: 'a', type: 'task', subject: 's1', brief: 'one line' },
    { from: 'b', type: 'task', subject: 's2' },
  ] } } })
  const h = blocks(report(r), NOW)[0]!.handling
  expect(h[0]!.sections).toEqual([{ label: '摘要', lines: ['one line'] }])
  expect(h[1]!.sections).toEqual([])
})

test('the latest hand-off marks its edge hot', () => {
  const r = run({ wakes: [
    { round: 1, agent: 'lead', ok: true, duration_ms: 1, sent: [{ to: 'fe', type: 'task', subject: 's' }] },
    { round: 2, agent: 'fe', ok: true, duration_ms: 1, sent: [{ to: 'lead', type: 'reply', subject: 's' }] },
  ] })
  const bs = blocks(report(r), NOW)
  expect(bs.find(b => b.name === 'fe')!.targets).toEqual([{ name: 'lead', hot: true }])
  expect(bs.find(b => b.name === 'lead')!.targets.every(t => !t.hot)).toBe(true)
  const done = run({ wakes: [{ round: 1, agent: 'lead', ok: true, duration_ms: 1, sent: [{ to: '(done)', type: 'done', subject: 's' }] }] })
  expect(blocks(report(done), NOW).flatMap(b => b.targets).every(t => !t.hot)).toBe(true)
})

test('older CLI without can_message: no targets, no link', () => {
  const old = report(run())
  for (const a of old.agents) delete a.can_message
  const bs = blocks(old, NOW)
  expect(bs.every(b => b.targets.length === 0)).toBe(true)
  expect(leadLink(bs, bs[1]!)).toBeUndefined()
})

test('layout: wide puts the lead on top and wraps members; narrow stacks everything', () => {
  const bs = blocks(report(run()), NOW)
  const wide = layout(bs, 90)
  expect(wide.narrow).toBe(false)
  expect(wide.rows.map(r => r.map(b => b.name))).toEqual([['lead'], ['fe', 'qa']])
  expect(wide.memberWidth).toBe(45)
  const tight = layout(bs, 62)
  expect(tight.narrow).toBe(true)
  expect(tight.rows.map(r => r.map(b => b.name))).toEqual([['lead'], ['fe'], ['qa']])
  const many = layout([...bs, { ...bs[1]!, name: 'x' }, { ...bs[1]!, name: 'y' }], 90)
  expect(many.rows.map(r => r.length)).toEqual([1, 3, 1])
})

test('leadLink shows the direction between the lead and a member', () => {
  const bs = blocks(report(run()), NOW)
  expect(leadLink(bs, bs.find(b => b.name === 'fe')!)).toEqual({ glyph: '↕', hot: false })
  expect(leadLink(bs, bs.find(b => b.name === 'qa')!)).toEqual({ glyph: '▼', hot: false })
  expect(leadLink(bs, bs[0]!)).toBeUndefined()
})

test('blockLines tell what the agent is doing and what it received', () => {
  const r = run({
    active: { lead: { since: '2026-01-01T00:00:00Z', round: 3, handling: [{ from: 'fe', type: 'reply', subject: 'UI done', digest: [{ label: '變更', lines: ['新增 login.tsx', '改 auth.ts'] }, { label: '驗證', lines: ['tsc 通過'] }] }] } },
    wakes: [{ round: 1, agent: 'lead', ok: true, duration_ms: 1, output_tokens: 12300, sent: [{ to: 'fe', type: 'task', subject: 's' }] }],
  })
  const lead = blocks(report(r), NOW)[0]!
  expect(blockLines(lead).map(l => l.text)).toEqual([
    '● lead ★ · claude-code',
    '進行中 #3 1m05s',
    '來自 fe 的 reply：UI done',
    '  變更  新增 login.tsx',
    '        改 auth.ts',
    '  驗證  tsc 通過',
    '喚醒 1 次 · 12.3k tok',
    '→ fe ●, qa',
  ])
  expect(blockLines(lead)[1]!.tone).toBe('ok')
})

test('an idle block with nothing to say is short', () => {
  const fe = blocks(report(run()), NOW).find(b => b.name === 'fe')!
  expect(blockLines(fe).map(l => l.text)).toEqual(['○ fe · codex', '閒置', '喚醒 0 次 · 0 tok', '→ lead'])
})

test('queued mail is compact: head plus the first line of the first section', () => {
  const r = run({ queue: [{ agent: 'qa', from: 'lead', type: 'task', subject: 'write tests', digest: [{ label: '目標', lines: ['為登入頁寫測試', '第二行'] }] }] })
  const qa = blocks(report(r), NOW).find(b => b.name === 'qa')!
  expect(blockLines(qa).map(l => l.text)).toContain('  排隊：來自 lead 的 task：write tests')
  expect(blockLines(qa).map(l => l.text)).toContain('    目標  為登入頁寫測試')
})

test('bar, padCenter and paneWidth', () => {
  expect(bar(1, 4, 8)).toBe('▓▓░░░░░░')
  expect(bar(0, 0, 4)).toBe('░░░░')
  expect(bar(9, 4, 4)).toBe('▓▓▓▓')
  expect(padCenter('▼', 9)).toBe('    ▼')
  expect(paneWidth(200, true)).toBe(96)
  expect(paneWidth(100, true)).toBe(96)
  expect(paneWidth(100, false)).toBe(96)
  expect(paneWidth(undefined, undefined)).toBe(56)
  expect(paneWidth(30, false)).toBe(40)
})
```

注意最後一個測試的 `paneWidth` 預期值：docked 且 `columns >= 110` 時取一半再扣 4（200 → 96）；其他情況取整個寬度扣 4（100 → 96、30 → 26 → 下限 40）；沒有 viewport 時用面板開啟時的預設寬度 60 扣 4 = 56。`paneWidth(100, true)` 因為不到 110 欄所以不是 docked 版面，結果與 `false` 相同。

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx vitest run plugins/status-monitor/hooks/graph.test.ts`
Expected: FAIL（找不到 `./graph`）。

- [ ] **Step 4: 實作 `graph.ts`**

建立 `plugins/status-monitor/hooks/graph.ts`：

```ts
import type { DigestSection, Report, Run } from '../types'
import { agentStats, clip, elapsed, tokens } from './summary'

export type Dot = 'active' | 'queued' | 'failed' | 'idle'
export type Tone = 'bold' | 'dim' | 'ok' | 'warn' | 'bad'
export type Line = { text: string; tone?: Tone }
export type MailView = { head: string; sections: DigestSection[] }
export type Target = { name: string; hot: boolean }
export type Block = {
  name: string
  runtime: string
  lead: boolean
  dot: Dot
  working?: { round?: number; elapsed: string }
  handling: MailView[]
  queued: MailView[]
  targets: Target[]
  wakes: number
  failed: number
  tokens: number
}
export type Edge = { from: string; to: string }
type MailLike = { from: string; type: string; subject: string; brief?: string; digest?: DigestSection[] }

/** Below this many columns blocks stack in one column and no link glyphs are drawn. */
export const NARROW = 70
/** The narrowest a member block may get before a row wraps. */
export const MIN_BLOCK = 30
/** The pane's width when it is opened (see register.tsx). */
const OPEN_COLUMNS = 60

/** One message as a head line plus its readable sections (digest, else brief, else nothing); `compact` keeps one line. */
export function mailView(m: MailLike, compact = false): MailView {
  const head = `來自 ${m.from} 的 ${m.type}：${clip(m.subject, 40)}`
  const all: DigestSection[] = m.digest?.length ? m.digest : m.brief ? [{ label: '摘要', lines: [m.brief] }] : []
  return { head, sections: compact ? all.slice(0, 1).map(s => ({ label: s.label, lines: s.lines.slice(0, 1) })) : all }
}

/** The most recent hand-off between two agents (a `done` goes to nobody). */
export function latestEdge(run?: Run): Edge | undefined {
  for (const w of [...(run?.wakes ?? [])].reverse()) {
    const to = [...(w.sent ?? [])].reverse().find(s => s.to !== '(done)')?.to
    if (to) return { from: w.agent, to }
  }
  return undefined
}

/** One block per agent, the lead first. Only a running run has agents working or queued. */
export function blocks(report: Report, now: number): Block[] {
  const run = report.run
  const live = run?.state === 'running'
  const stats = new Map(agentStats(run?.wakes ?? []).map(s => [s.agent, s]))
  const edge = latestEdge(run)
  const all = report.agents.map((a): Block => {
    const act = live ? run?.active[a.name] : undefined
    const queued = live ? (run?.queue ?? []).filter(q => q.agent === a.name).map(q => mailView(q, true)) : []
    const st = stats.get(a.name)
    const dot: Dot = act ? 'active' : live && a.last_wake?.ok === false ? 'failed' : queued.length ? 'queued' : 'idle'
    return {
      name: a.name,
      runtime: a.runtime ?? '?',
      lead: a.lead,
      dot,
      working: act ? { round: act.round, elapsed: elapsed(act.since, now) } : undefined,
      handling: (act?.handling ?? []).map(m => mailView(m)),
      queued,
      targets: (a.can_message ?? []).map(name => ({ name, hot: edge?.from === a.name && edge.to === name })),
      wakes: st?.wakes ?? 0,
      failed: st?.failed ?? 0,
      tokens: st?.tokens ?? 0,
    }
  })
  return [...all.filter(b => b.lead), ...all.filter(b => !b.lead)]
}

export type Layout = { narrow: boolean; memberWidth: number; rows: Block[][] }

/** Rows of blocks: the lead alone on top, members below in as many columns as fit. */
export function layout(bs: Block[], width: number): Layout {
  if (width < NARROW) return { narrow: true, memberWidth: width, rows: bs.map(b => [b]) }
  const lead = bs.filter(b => b.lead)
  const rest = bs.filter(b => !b.lead)
  const cols = Math.max(1, Math.min(rest.length || 1, Math.floor(width / MIN_BLOCK)))
  const rows: Block[][] = lead.length ? [lead] : []
  for (let i = 0; i < rest.length; i += cols) rows.push(rest.slice(i, i + cols))
  return { narrow: false, memberWidth: Math.floor(width / cols), rows }
}

/** The glyph between the lead and a member: who may write to whom; hot when it is the latest hand-off. */
export function leadLink(bs: Block[], member: Block): { glyph: '▼' | '▲' | '↕'; hot: boolean } | undefined {
  const lead = bs.find(b => b.lead)
  if (!lead || member.lead) return undefined
  const down = lead.targets.find(t => t.name === member.name)
  const up = member.targets.find(t => t.name === lead.name)
  if (!down && !up) return undefined
  return { glyph: down && up ? '↕' : down ? '▼' : '▲', hot: !!down?.hot || !!up?.hot }
}

const DOT: Record<Dot, string> = { active: '●', queued: '◐', failed: '✖', idle: '○' }

function mailLines(m: MailView, headTone: Tone | undefined, indent: string): Line[] {
  const out: Line[] = [{ text: `${indent}${m.head}`, tone: headTone }]
  for (const s of m.sections) {
    const pad = ' '.repeat(indent.length + 2)
    s.lines.forEach((l, i) => out.push({ text: i === 0 ? `${pad}${s.label}  ${l}` : `${pad}${' '.repeat(s.label.length * 2 + 2)}${l}` }))
  }
  return out
}

/** The text of one block, line by line, with a tone the view turns into a colour. */
export function blockLines(b: Block): Line[] {
  const status: Line =
    b.dot === 'active' ? { text: `進行中${b.working?.round ? ` #${b.working.round}` : ''} ${b.working?.elapsed ?? ''}`.trimEnd(), tone: 'ok' }
    : b.dot === 'failed' ? { text: '上次喚醒失敗', tone: 'bad' }
    : b.dot === 'queued' ? { text: `排隊 ${b.queued.length} 封`, tone: 'warn' }
    : { text: '閒置', tone: 'dim' }
  const lines: Line[] = [{ text: `${DOT[b.dot]} ${b.name}${b.lead ? ' ★' : ''} · ${b.runtime}`, tone: 'bold' }, status]
  for (const m of b.handling) lines.push(...mailLines(m, 'bold', ''))
  for (const m of b.queued) lines.push(...mailLines({ ...m, head: `排隊：${m.head}` }, 'dim', '  '))
  lines.push({ text: `喚醒 ${b.wakes} 次${b.failed ? `（失敗 ${b.failed}）` : ''} · ${tokens(b.tokens)} tok`, tone: b.failed ? 'bad' : 'dim' })
  if (b.targets.length) lines.push({ text: `→ ${b.targets.map(t => (t.hot ? `${t.name} ●` : t.name)).join(', ')}`, tone: 'dim' })
  return lines
}

/** ▓▓░░░░ for done/total, clamped. */
export function bar(done: number, total: number, width = 10): string {
  const filled = total > 0 ? Math.min(width, Math.max(0, Math.round((done / total) * width))) : 0
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

/** `s` indented so a one-cell glyph sits in the middle of `width` cells. */
export function padCenter(s: string, width: number): string {
  return ' '.repeat(Math.max(0, Math.floor((width - 1) / 2))) + s
}

/**
 * How many cells the graph may use: the pane is docked at half the terminal in the fullscreen layout from 110 columns,
 * otherwise it spans the terminal; less 4 for its border and padding, never below 40.
 */
export function paneWidth(columns: number | undefined, docked: boolean | undefined): number {
  const cols = columns ?? OPEN_COLUMNS
  const width = docked && cols >= 110 ? Math.floor(cols / 2) : cols
  return Math.max(40, width - 4)
}
```

- [ ] **Step 5: 加進 CI 型別檢查，跑測試與型別**

`plugins/status-monitor/tsconfig.ci.json` 的 `include` 改成

```json
  "include": ["hooks/summary.ts", "hooks/summary.test.ts", "hooks/graph.ts", "hooks/graph.test.ts", "types/index.d.ts"]
```

Run: `npx vitest run plugins/status-monitor && npm run typecheck:plugin`
Expected: PASS。常見的修正點：`'queued mail is compact'` 測試期望 `排隊：`前有兩格縮排與區段縮排 4 格，與 `mailLines(…, '  ')` 的 `pad = indent.length + 2` 一致；`bar(0,0,4)` 要得到 `░░░░`。

- [ ] **Step 6: Commit**

```bash
git add plugins/status-monitor
git commit -m "feat(status-monitor): pure graph model, layout and block text for the agent graph"
```

---

### Task 4: Ink 檢視與 `register.tsx` 接線

**Files:**
- Create: `plugins/status-monitor/hooks/graph-view.tsx`
- Modify: `plugins/status-monitor/hooks/register.tsx`

**Interfaces:**
- Consumes: Task 3 的 `blocks`、`layout`、`leadLink`、`blockLines`、`padCenter`、`bar`、`paneWidth`、`Tone`。
- Produces: `graphView(ui, report, now, width)`，回傳 Ink 元素樹；`register.tsx` 的 `view` atom（`'graph' | 'text'`，預設 `'graph'`）。

這一層沒有自動化測試（需要真正的 Claude Code mod 執行環境），靠 Step 4 的實際操作驗收。

- [ ] **Step 1: 建立檢視**

`plugins/status-monitor/hooks/graph-view.tsx`：

```tsx
import type { Report } from '../types'
import { blockLines, blocks, layout, leadLink, padCenter, type Block, type Tone } from './graph'

// The resolved `Box` / `Text` of `$.ui.resolve(e)`. Typed loosely here: the pure model in graph.ts carries the logic.
type Ui = { Box: any; Text: any }

const toneProps = (t?: Tone) =>
  t === 'bold' ? { bold: true } : t === 'dim' ? { dimColor: true } : t === 'ok' ? { color: 'green' } : t === 'warn' ? { color: 'yellow' } : t === 'bad' ? { color: 'red' } : {}

/** One bordered block per agent; between the lead and each member a glyph shows who may write to whom (yellow = the latest hand-off). */
export function graphView({ Box, Text }: Ui, report: Report, now: number, width: number) {
  const bs = blocks(report, now)
  const lay = layout(bs, width)
  const card = (b: Block, w: number) => (
    <Box flexDirection="column" borderStyle="round" borderColor={b.dot === 'active' ? 'green' : b.dot === 'failed' ? 'red' : undefined} width={w} paddingX={1}>
      {blockLines(b).map(l => (
        <Text wrap="truncate-end" {...toneProps(l.tone)}>
          {l.text}
        </Text>
      ))}
    </Box>
  )
  return (
    <Box flexDirection="column">
      {lay.rows.map((row, i) => (
        <Box flexDirection="column">
          {i > 0 && !lay.narrow && (
            <Box>
              {row.map(b => {
                const k = leadLink(bs, b)
                return (
                  <Box width={lay.memberWidth}>
                    <Text {...(k?.hot ? { color: 'yellow', bold: true } : { dimColor: true })}>{k ? padCenter(k.glyph, lay.memberWidth) : ' '}</Text>
                  </Box>
                )
              })}
            </Box>
          )}
          <Box>{row.map(b => card(b, i === 0 || lay.narrow ? width : lay.memberWidth))}</Box>
        </Box>
      ))}
    </Box>
  )
}
```

- [ ] **Step 2: 接進 `register.tsx`**

(a) import 區加入（`./summary` 那行之後）：

```ts
import { bar, paneWidth } from './graph'
import { graphView } from './graph-view'
```

(b) 在 `const tab = atom(…)` 之後加：

```ts
/** 'graph' draws one block per agent; 'text' is the plain list. `v` switches. */
const view = atom({ plugin: 'status-monitor', key: 'view' } as const, 'graph' as 'graph' | 'text')
```

(c) `ui.render` 處理函式開頭，在 `const now = await $.clock.now()` 之後加：

```ts
    const mode = await read($, view)
    const width = paneWidth(e.viewport?.columns, e.viewport?.isFullscreen)
```

(d) `section` 裡，把「`<Text>進度：{progress(run)}</Text>`」改成依模式顯示進度條：

```tsx
            <Text>
              進度：{mode === 'graph' ? `${bar(run.steps?.length ? run.steps.filter(s => s.done).length : run.rounds, run.steps?.length || run.max_rounds)} ` : ''}
              {progress(run)}
            </Text>
```

(e) 在 `section` 裡，把從 `{Object.entries(run.active).map(` 開始、到 `{(run.blocked_integrations ?? []).length > 0 && (` 之前的整段（也就是「進行中」與「排隊」兩塊文字）換成：

```tsx
            {mode === 'graph' ? graphView($.ui.resolve(e), report, now, width) : (
              <Box flexDirection="column">
                {Object.entries(run.active).map(([name, w]) => (
                  <Box flexDirection="column">
                    <Text color="green">
                      進行中：{name} {w.round ? `#${w.round} ` : ''}
                      {elapsed(w.since, now)}
                    </Text>
                    {(w.handling ?? []).map(m => (
                      <Text dimColor>
                        {'  '}處理 {m.from}→{m.type}：{clip(m.subject, 60)}
                      </Text>
                    ))}
                  </Box>
                ))}
                {run.queue.length > 0 && <Text bold>排隊</Text>}
                {run.queue.map(q => (
                  <Text dimColor>
                    {q.agent} ← {q.from} {q.type}：{clip(q.subject, 60)}
                  </Text>
                ))}
              </Box>
            )}
```

(f) 同一個 `section` 裡，把從 `<Text bold>各 LLM output tokens</Text>` 到「最近喚醒」那段 `run.wakes.slice(-8).map(…)` 結束為止，整段用 `{mode === 'text' && (<Box flexDirection="column"> … </Box>)}` 包起來（圖形模式已把喚醒次數與 token 放在區塊底部，不再重複列出）。`受阻整合`、`備註`、`結果摘要` 兩種模式都保留。

(g) 標題列（`<Text bold>agent-lyceum </Text>` 那個 `<Box>`）在「關閉」按鈕之後加切換按鈕：

```tsx
          <Button key="view" label={mode === 'graph' ? '文字版 (v)' : '圖形版 (v)'} hotkey="v" variant="secondary" onPress={() => update($, view, m => (m === 'graph' ? 'text' : 'graph'))} />
```

(h) `command.run` 的說明文字（`Mouse clicks are only reported …` 那句）改為 `… x closes, v switches graph/text, 1-9 (or Tab/Enter) switch task, Esc returns to the prompt, /status-monitor again also closes.`

- [ ] **Step 3: 型別檢查**

Run: `npm run build && npm run typecheck`
Expected: 通過。`typecheck:plugin` 只涵蓋純函式，不會檢查 `.tsx`。若本機有 mod 型別（`plugins/status-monitor/.claude-plugin/types/` 存在），另外跑 `npx tsc -p plugins/status-monitor/tsconfig.json --noEmit`，有關 `Box`／`Text` 屬性的錯誤就把 `graph-view.tsx` 的 `Ui` 型別或該屬性調整到型別接受為止；不要為了通過而改 `graph.ts` 的邏輯。

- [ ] **Step 4: 實際操作驗收**

1. 準備一個有 lead、fe-member、qa-member 的專案（`agent-lyceum init -y`、`project add demo --dir <repo>`）。
2. 用一個會跑一陣子的任務開始 run（`agent-lyceum run "新增登入頁" -p demo`），另開 Claude Code：`claude --plugin-dir <repo>/plugins/status-monitor`，輸入 `/status-monitor`。
3. 逐項確認：
   - 每個 agent 一個區塊，lead 在最上面；成員在下面一排，區塊之間有 `▼`／`▲`／`↕`。
   - 進行中的 agent 邊框為綠色，顯示 `進行中 #輪次 時間`，其下是正在處理的信（`來自 X 的 type：主旨`）與「目標／驗收」或「變更／驗證」等重點行。
   - 排隊中的信以 `排隊：…` 兩行縮小顯示。
   - 剛寄出信的那條邊的符號是黃色，對應 agent 底部的 `→ 名稱 ●`。
   - 按 `v` 切回文字版（與改動前一樣），再按一次回到圖形版。
   - 把終端機縮到 70 欄以下（或不在 fullscreen 版面）：區塊直向堆疊、沒有連結符號、不會破版。
4. 把觀察到的結果（含任何對不上的地方）記在最後的回報裡，不要宣稱沒看過的畫面「正常」。

- [ ] **Step 5: Commit**

```bash
git add plugins/status-monitor
git commit -m "feat(status-monitor): draw one block per agent with can_message links; v toggles the text view"
```

---

### Task 5: 文件、spec 與驗證

**Files:**
- Modify: `README.md`、`README.zh-TW.md`（Monitor mod 一節）
- Modify: `docs/commands.md`、`docs/commands.zh-TW.md`（`status` 一節的 `--json` 說明）
- Modify: `docs/specs/13-status-monitor-visual.md`、`docs/specs/README.md`

- [ ] **Step 1: README（中英文成對）**

`README.md` 的 `/status-monitor` 項目，把 `It shows, per project: …` 之後的描述改成：

```
It draws one block per agent, with the links between the lead and each member taken from `can_message` (`▼` the lead may write to the member, `▲` the member to the lead, `↕` both; yellow marks the latest hand-off). Each block shows what that agent is doing now, the mail it is handling and the mail queued for it as short readable sections by type (task: goal and acceptance criteria; reply: changes, verification, open items, risks; done: result and what is not done), and its wake count and output tokens. Above the graph: the run id and state, task, progress bar and checklist; below it: blocked integrations, notes and the result summary. `v` switches to the plain text list (per-runtime tokens, per-agent statistics, the last 8 wakes). Below 70 columns the blocks stack in one column and the link glyphs are left out. Each running task is a tab, newest first; finished and interrupted runs are not listed. It refreshes with the polling interval while open.
```

同時把同一段的鍵盤說明 `Keyboard (works in both): \`x\` closes,` 改成 `` `x` closes, `v` switches graph/text, ``。

`README.zh-TW.md` 的對應段落（`/status-monitor` 項目）改成同一件事的中文：

```
面板為每個 agent 畫一個區塊，並依 `can_message` 在 lead 與各成員之間畫出連結（`▼` lead 可寄給成員、`▲` 成員可寄給 lead、`↕` 雙向；黃色表示最近一次寄信的那條邊）。每個區塊顯示該 agent 現在在做什麼、正在處理與排隊中的信（依信種整理成可讀的重點：task 看目標與驗收，reply 看變更、驗證、待辦與風險，done 看結果與未完成），以及喚醒次數與輸出 token。圖形上方是執行 id 與狀態、任務、進度條與清單；下方是受阻的整合、備註與結果摘要。按 `v` 切換成純文字清單（各 runtime 的 token、各 agent 統計、最近 8 次喚醒）。寬度少於 70 欄時區塊改成單欄堆疊，不畫連結符號。每個執行中的任務是一個頁籤，最新的排最前面；已結束或已中斷的 run 不列出。開著時依輪詢間隔更新。
```

鍵盤說明的 `` `x` 關閉 `` 之後加 `` `v` 切換圖形／文字 ``（照該句原本的文字風格）。先 `rg -n "鍵盤|Keyboard" README*.md` 找出確切位置再改。

- [ ] **Step 2: `docs/commands*.md`**

在兩份文件 `## status` 一節講 `--json` 的段落後各加一個條列（結構相同，不新增標題）：

英文：
```
- `--json` also carries, per agent, `can_message` (who it may send mail to; `all` expanded, itself left out), and, for every message in `run.active[*].handling`, `run.queue[*]` and `run.wakes[*].handling`, a `digest`: short sections by message type (`[{ "label": "目標", "lines": ["…"] }]`). Both are additive; `schema_version` stays `1`.
```
中文：
```
- `--json` 另外在每個 agent 附上 `can_message`（它可以寄信的對象；`all` 已展開、不含自己），並在 `run.active[*].handling`、`run.queue[*]` 與 `run.wakes[*].handling` 的每封信附上 `digest`：依信種整理的短段落（`[{ "label": "目標", "lines": ["…"] }]`）。兩者都只是新增欄位，`schema_version` 仍是 `1`。
```

- [ ] **Step 3: spec**

`docs/specs/13-status-monitor-visual.md`：

- 把第 3 行 `狀態：設計已核准，尚未實作（plan：待寫）。` 改成 `狀態：已實作（plan：docs/plans/2026-10-13-13-status-monitor-visual.md）。`
- 刪掉 13.3 最後一段裡「`solo` 的專案（`run --agent`）下，成員的 `can_message` 是空陣列。」這一句（`status` 讀的是設定好的專案，不是 solo 衍生出來的版本，這句不成立）。
- 13.4 的示意圖後加一行：`連結符號只畫 lead 與成員之間（▼ ▲ ↕）；其餘的邊列在區塊底部的「→」清單，最近的一次標 ●。`

`docs/specs/README.md`：第 13 列最後一欄 `待寫` 改成 `[plan](../plans/2026-10-13-13-status-monitor-visual.md)`。

- [ ] **Step 4: 全面驗證**

Run:
```bash
npm run typecheck && npm test && npm run check:docs && npx biome lint
```
Expected: 全過。`check:docs` 若報中英文標題層級不一致，確認兩份 `docs/commands*.md` 與 `README*.md` 加的是條列而不是標題。

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh-TW.md docs
git commit -m "docs: status-monitor agent graph, status --json can_message and digest"
```

---

## Self-Review（對照 spec）

- 13.2 #1、#2（區塊、關係、可讀內容）→ Task 3、4；#3、#4 → Task 2；#5（相容舊 CLI）→ Task 3 `older CLI` 與 `mail falls back` 兩個測試；#6（`v` 切換）→ Task 4 (g)；#7（純函式 vitest、不新增依賴）→ Task 1、3。
- 13.3 digest 規則：各信種、3 行／80 字、`None` 略過、警告行略過、不丟錯 → Task 1 測試涵蓋。
- 13.4 版面、強調邊、窄面板 → Task 3 `layout`／`leadLink`／`latestEdge`，Task 4 檢視。spec 的示意圖是示意，實作以 `blockLines` 的文字行為準。
- 13.5 舊資料與切換 → Task 3、4。13.6 影響的檔案 → File Structure 已列。13.7 驗收 → Task 1–5 的測試與 Task 4 Step 4 的實際操作；Task 5 Step 4 是總驗證。
- 型別一致性：`DigestSection` 在 CLI（`src/format.ts`）與 mod（`types/index.d.ts`）各自定義同一形狀；`Block`、`Layout`、`Line` 只在 `graph.ts` 定義，`graph-view.tsx` 以 `import` 使用；`paneWidth(columns, docked)` 在 Task 3 定義、Task 4 以 `paneWidth(e.viewport?.columns, e.viewport?.isFullscreen)` 呼叫。
