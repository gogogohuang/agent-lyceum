# 信件改善實作計畫

> **給執行的 agent：** 必須使用子技能 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans 逐個 task 實作本計畫。步驟用核取方塊（`- [ ]`）追蹤進度。

**目標：** 讓 agent 之間的信件少流失資訊：成員能一次處理同一 thread 的信、漏掉必要 `##` 標題的信會被退回而不只是加警告，並更新文件。

**架構：** 在現有信件流程上做兩個小而獨立的改動。(1) `src/prompt.ts` 的 `pickMessages` 讓非 lead 的 agent 也能批次處理連續、同 thread 的 `reply`/`failure`。(2) `src/mailbox.ts` 的 `routeOutboxes` 對缺必要標題的 `task`/`reply` 先退回，每個「寄件人＋主旨」以 run 目錄裡的小計數檔限制次數，超過後回到現行的「加警告後送達」，所以 run 不會因格式問題卡住。

**技術：** TypeScript（ESM，import 要加 `.js`）、vitest、biome。

**Spec：** 沒有獨立 spec。起點是本次對話中對信件流程的檢視（第 1、3、5 點）。第 5 點（檢查 `done` 的內容）刻意不放進本計畫，見「不在範圍內」。

## 全域限制

- Node 20+；ESM 的 import 路徑結尾用 `.js`。
- 每個 task 完成後，`npm test`（vitest run）、`npm run lint`（biome lint）、`npm run build`（tsc）都必須通過。
- 信件不跨 run；沒有 `project.run` 的舊版佈局，行為完全維持不變。
- `done` 和 `failure` 信維持免檢查必要標題（見 `src/format.ts` 的 `REQUIRED_SECTIONS`）。
- 每個使用者看得到的行為改動，都要寫進 `docs/how-it-works.md` 和 `docs/how-it-works.zh-TW.md`。

## 檔案結構

- 修改 `src/prompt.ts`：`pickMessages` 的批次規則。
- 新增 `src/format-rejections.ts`：每個 run 的格式退回計數器，存成 run 目錄下的 `format-rejections.json`。
- 修改 `src/mailbox.ts`：在 `routeOutboxes` 使用計數器。
- 修改 `test/mailbox.test.ts`，新增 `test/pick-messages.test.ts` 和 `test/format-rejections.test.ts`。
- 修改 `docs/how-it-works.md`、`docs/how-it-works.zh-TW.md`。

---

### Task 1：成員批次處理同 thread 的回信

**檔案：**
- 修改：`src/prompt.ts:227-237`（`pickMessages`）
- 測試：`test/pick-messages.test.ts`（新增）

**介面：**
- 使用：`src/mailbox.ts` 的 `Message`、`src/config.ts` 的 `ResolvedProject`/`ResolvedAgent`、`src/prompt.ts` 既有的 `BATCHABLE`、`LEAD_BATCH_LIMIT`。
- 提供：`pickMessages(project, agent, queue): Message[]`，簽名不變。非 lead 的 agent 新規則：最舊的未讀信若是 `reply`/`failure`，就取它，加上其後同樣是 `reply`/`failure` **且 `meta.thread` 相同**的信，最多 `LEAD_BATCH_LIMIT` 封。lead 的規則不變（任何連續的 `reply`/`failure`，不看 thread）。`task` 和 `ask` 永不批次。

- [ ] **步驟 1：寫會失敗的測試**

```ts
// test/pick-messages.test.ts
import { afterEach, describe, expect, it } from "vitest";
import type { Message, MessageType } from "../src/mailbox.js";
import { pickMessages } from "../src/prompt.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

function mail(n: number, type: MessageType, thread: string): Message {
  const file = `/x/2026010100000${n}-lead-m${n}.md`;
  return { meta: { id: `m${n}`, from: "lead", to: "fe-member", thread, type, subject: `s${n}`, created: "" }, body: "b", file };
}

describe("pickMessages", () => {
  it("lets a member take consecutive same-thread replies together", () => {
    env = makeEnv();
    const p = env.project();
    const member = p.agents["fe-member"]!;
    const got = pickMessages(p, member, [mail(1, "reply", "t1"), mail(2, "reply", "t1"), mail(3, "reply", "t2")]);
    expect(got.map((m) => m.meta.id)).toEqual(["m1", "m2"]);
  });

  it("never batches a member's task, and keeps one message when threads differ", () => {
    env = makeEnv();
    const p = env.project();
    const member = p.agents["fe-member"]!;
    expect(pickMessages(p, member, [mail(1, "task", "t1"), mail(2, "reply", "t1")]).map((m) => m.meta.id)).toEqual(["m1"]);
    expect(pickMessages(p, member, [mail(1, "reply", "t1"), mail(2, "reply", "t2")]).map((m) => m.meta.id)).toEqual(["m1"]);
  });
});
```

- [ ] **步驟 2：執行，確認會失敗**

執行：`npx vitest run test/pick-messages.test.ts`
預期：FAIL；第一個測試得到 `["m1"]`，不是 `["m1", "m2"]`。

- [ ] **步驟 3：實作**

把 `src/prompt.ts` 裡 `pickMessages` 的內容換成：

```ts
export function pickMessages(project: ResolvedProject, agent: ResolvedAgent, queue: Message[]): Message[] {
  const sorted = [...queue].sort((a, b) => path.basename(a.file).localeCompare(path.basename(b.file)));
  const first = sorted[0];
  if (!first || !BATCHABLE.has(first.meta.type)) return sorted.slice(0, 1);
  const isLead = agent.name === project.lead;
  const run: Message[] = [];
  for (const m of sorted) {
    if (!BATCHABLE.has(m.meta.type) || run.length >= LEAD_BATCH_LIMIT) break;
    if (!isLead && m.meta.thread !== first.meta.thread) break;
    run.push(m);
  }
  return run;
}
```

同時把上方的 doc comment 改成：「一次喚醒處理的信：最舊的一封，或一串 `reply`/`failure`（最多 LEAD_BATCH_LIMIT 封），讓 agent 一次對全部做決定；lead 可取任何這樣的一串，其他 agent 只取同一 thread 的。」

- [ ] **步驟 4：執行測試**

執行：`npx vitest run test/pick-messages.test.ts && npm test && npm run lint && npm run build`
預期：全部 PASS。若有其他測試固定了成員「每次喚醒一封」的舊行為，改成新規則，並在 commit 訊息裡說明。

- [ ] **步驟 5：Commit**

```bash
git add src/prompt.ts test/pick-messages.test.ts
git commit -m "feat: members handle same-thread replies in one wake-up"
```

---

### Task 2：退回缺必要標題的信（有次數上限）

**檔案：**
- 新增：`src/format-rejections.ts`
- 修改：`src/mailbox.ts:363-364`（`routeOutboxes` 內）
- 測試：`test/format-rejections.test.ts`（新增）、`test/mailbox.test.ts`（加一個案例）

**介面：**
- 使用：`src/fs-util.ts` 的 `atomicWrite`；`project.run.dir`；`src/format.ts` 的 `missingSections`、`formatWarning`；`routeOutboxes` 內既有的 `reject(reason)` 閉包。
- 提供：
  - `export const MAX_FORMAT_REJECTIONS = 2;`
  - `export function formatRejectionKey(from: string, type: string, subject: string): string`
  - `export function countFormatRejection(runDir: string, key: string): number`：加一並回傳新計數，存在 `<runDir>/format-rejections.json`。
  - `export function formatRejections(runDir: string, key: string): number`：讀目前計數。
- 行為：在 run 內（`project.run` 有值），缺標題的 `task`/`reply` 在 `formatRejections < MAX_FORMAT_REJECTIONS` 時被退回並寫明原因，同時計數加一；達到上限後，改成現行的「加警告後送達」。沒有 `project.run` 時行為不變（加警告後送達）。

- [ ] **步驟 1：寫會失敗的計數器測試**

```ts
// test/format-rejections.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countFormatRejection, formatRejectionKey, formatRejections } from "../src/format-rejections.js";

describe("format rejection counter", () => {
  it("counts per key and survives a reload", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-"));
    const k = formatRejectionKey("fe-member", "reply", "Done");
    expect(formatRejections(dir, k)).toBe(0);
    expect(countFormatRejection(dir, k)).toBe(1);
    expect(countFormatRejection(dir, k)).toBe(2);
    expect(formatRejections(dir, k)).toBe(2);
    expect(formatRejections(dir, formatRejectionKey("fe-member", "reply", "Other"))).toBe(0);
  });

  it("treats a corrupt file as empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-"));
    fs.writeFileSync(path.join(dir, "format-rejections.json"), "{not json");
    expect(formatRejections(dir, "x")).toBe(0);
  });
});
```

- [ ] **步驟 2：執行，確認會失敗**

執行：`npx vitest run test/format-rejections.test.ts`
預期：FAIL，找不到模組 `../src/format-rejections.js`。

- [ ] **步驟 3：實作計數器**

```ts
// src/format-rejections.ts
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./fs-util.js";

/** How many times one sender's mail (same type and subject) is sent back for missing sections before it is delivered with a warning instead. */
export const MAX_FORMAT_REJECTIONS = 2;

const FILE = "format-rejections.json";

export function formatRejectionKey(from: string, type: string, subject: string): string {
  return `${from}|${type}|${subject.trim().toLowerCase()}`;
}

function load(runDir: string): Record<string, number> {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(runDir, FILE), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function formatRejections(runDir: string, key: string): number {
  return load(runDir)[key] ?? 0;
}

/** Record one more rejection for `key` and return the new count. */
export function countFormatRejection(runDir: string, key: string): number {
  const all = load(runDir);
  const n = (all[key] ?? 0) + 1;
  all[key] = n;
  atomicWrite(path.join(runDir, FILE), `${JSON.stringify(all, null, 2)}\n`);
  return n;
}
```

- [ ] **步驟 4：執行計數器測試**

執行：`npx vitest run test/format-rejections.test.ts`
預期：PASS。

- [ ] **步驟 5：寫會失敗的路由測試**

加到 `test/mailbox.test.ts` 的 `describe("mailbox routing", ...)` 裡；需要和 `test/run-mailbox.test.ts` 一樣建立綁定 run 的 project：

```ts
  it("sends back a reply without its sections twice, then delivers it with a warning", () => {
    env = makeEnv();
    const base = env.project();
    const p = bindRunProject(base, path.join(base.paths.runs, "run-a"), "run");
    ensureProjectDirs(p);
    for (let i = 0; i < 2; i++) {
      send(p, "fe-member", `bad${i}.md`, "to: lead\nsubject: finished", "all good");
      const r = routeOutboxes(p);
      expect(r.delivered).toEqual([]);
      expect(r.rejected[0]?.reason).toMatch(/Changes/);
    }
    send(p, "fe-member", "bad2.md", "to: lead\nsubject: finished", "all good, really");
    const r = routeOutboxes(p);
    expect(r.delivered).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
  });
```

註：第三封的內文刻意和前兩封不同，避免干擾既有的重複信檢查（被退回的信不會進收件人的 inbox，但內文分開寫，測試意圖才清楚）。

- [ ] **步驟 6：執行，確認會失敗**

執行：`npx vitest run test/mailbox.test.ts -t "sends back a reply"`
預期：FAIL；第一次路由就把信加警告後送達了。

- [ ] **步驟 7：實作退回**

在 `src/mailbox.ts` 加 import：`import { countFormatRejection, formatRejectionKey, formatRejections, MAX_FORMAT_REJECTIONS } from "./format-rejections.js";`，並把 363-364 行換成：

```ts
      const missing = missingSections(type, parsed.body);
      if (missing.length && project.run) {
        const key = formatRejectionKey(sender.name, type, subject);
        if (formatRejections(project.run.dir, key) < MAX_FORMAT_REJECTIONS) {
          const n = countFormatRejection(project.run.dir, key);
          reject(
            `this ${type} is missing required section(s): ${missing.map((s) => `\`## ${s}\``).join(", ")}. Add them (write \`None\` where a section is empty) and send it again. (Attempt ${n} of ${MAX_FORMAT_REJECTIONS}; after that it is delivered with a warning.)`,
          );
          continue;
        }
      }
      const body = missing.length ? `${formatWarning(type, missing)}\n\n${parsed.body}` : parsed.body;
```

- [ ] **步驟 8：跑完整測試並修掉連帶失敗**

執行：`npm test && npm run lint && npm run build`
預期：新測試 PASS。既有測試若用綁定 run 的 project 送沒有標題的 `reply`/`task`（例如 `test/run-mailbox.test.ts` 的 `send` 助手，內文是 `body`），現在會被退回。逐一把那些測試的信件內文改成帶四個必要標題（用 `test/mailbox.test.ts` 的 `REPLY_BODY`），不要放寬規則。重跑到全綠。

- [ ] **步驟 9：Commit**

```bash
git add src/format-rejections.ts src/mailbox.ts test
git commit -m "feat: send back mail missing required sections, at most twice per subject"
```

---

### Task 3：更新文件

**檔案：**
- 修改：`docs/how-it-works.md`（步驟 3「每次喚醒一封」、步驟 4「格式標題」）、`docs/how-it-works.zh-TW.md`（同樣兩處）

- [ ] **步驟 1：修改 `docs/how-it-works.md`**

步驟 3 裡，把「(one message per wake-up; the lead instead takes a run of up to 5 `reply`/`failure` messages at once and decides on them together)」改成「(one message per wake-up; the lead instead takes a run of up to 5 `reply`/`failure` messages at once, and any other agent takes up to 5 consecutive `reply`/`failure` messages of the same thread, and decides on them together)」。

步驟 4 裡，把「Mail missing a heading is still delivered, with a warning note prepended and a `format-warning` entry in the run log.」換成「A `task` or `reply` missing a heading is sent back to its sender (a `failure` mail names the missing headings), at most twice per sender, type and subject in a run; after that it is delivered with a warning note prepended and a `format-warning` entry in the run log. Runs of the legacy layout always deliver with the warning.」

- [ ] **步驟 2：對 `docs/how-it-works.zh-TW.md` 做同樣兩處修改**

打開檔案，找到對應的句子，用該文件既有的繁體中文用語表達同樣意思。

- [ ] **步驟 3：驗證並 commit**

執行：`npm test && npm run lint`
預期：PASS。

```bash
git add docs/how-it-works.md docs/how-it-works.zh-TW.md
git commit -m "docs: member batching and format rejection"
```

---

## 不在範圍內（需先做決定才能寫計畫）

- **檢查 `done` 的內容**（第 5 點）：要先決定檢查怎麼設定（每個專案一個 `verify` 指令？由 agent-lyceum 跑還是由 lead 跑？）以及檢查失敗時對結果的影響，需要先有 spec。
- **更聰明的重複信偵測**（第 4 點）、**並行喚醒上限**（第 6 點）、**單一成員失敗時 run 要不要繼續**（第 7 點）、**`COMMON.md` 跨 run 覆蓋**（第 8 點）：各自是獨立的設計問題。

## 自我檢查

- Spec 涵蓋：第 1、3 點對應 Task 1、2；Task 3 是文件。第 2、4 到 8 點刻意列為不在範圍內。
- 佔位符：沒有；每個程式碼步驟都有程式碼。Task 3 步驟 2 是「照兩句話的意思改繁中版」的指示，因為寫計畫時沒有讀 zh-TW 檔。
- 型別：`pickMessages`、`MAX_FORMAT_REJECTIONS`、`formatRejectionKey`、`formatRejections`、`countFormatRejection` 在各處拼法一致。
