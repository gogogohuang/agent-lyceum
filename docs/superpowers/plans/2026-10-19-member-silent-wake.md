# 成員靜默喚醒通知（P0-1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 成員處理完一封 `task`、喚醒成功但沒寄任何信時，dispatcher 自動寄一封 `type: failure` 給 lead，不再讓 run 悄悄以 `idle` 結束。

**Architecture:** 在 `RunSession.settle()` 路由完信件後（`routeOutboxes` 已回傳 `RouteResult`），對本批每個成功喚醒的成員檢查：它這次處理的信含 `task`、且 `route` 裡沒有它寄出、被拒、`ask` 的任何信，就用 `deliverOnce`（冪等 key 含 run id、agent、round）寄 `failure` 給 lead。lead 因此有未讀信，下一輪被喚醒，run 不會 idle。團隊協定 prompt 補一句要求成員每次喚醒都要寄回覆。

**Tech Stack:** TypeScript（ESM）、vitest、既有 `deliverOnce`／`RouteJournal`。無新依賴。

**Spec:** `docs/evaluation-orbital.md` §3 P0-1（在 branch `agent-lyceum/20261019T055553060Z-7408c8d722d7bbbdd400d967c4880e66/tech-lead`；用 `git show <branch>:docs/evaluation-orbital.md` 讀）。

## Global Constraints

- 只借 Orbital 的概念，不參考、不複製其程式碼（GPL-3.0；本專案 MIT）。
- 不新增依賴；信件仍是檔案，log 多一筆事件即可。
- `state.json` 的 `schema_version` 不變；不新增 `end_reason`。
- 不自動重喚成員；不改 lead 的既有 nudge 邏輯（`src/run-session.ts` 的 `leadWasLast`／`nudged`）。
- 僅對「輸入含 `task`」的喚醒觸發；只處理 `reply`／`failure` 的成員不觸發。
- `run --agent`／`call` 的單人 run（成員即 lead）不觸發：條件是 `agent.name !== project.lead`。
- 測試用 `npx vitest run <file>`；完整檢查用 `npm test`（先看 `package.json` 的 scripts 確認）。

---

## File Structure

- Modify `src/run-session.ts`：`settle()` 末端新增私有方法 `notifySilentMembers(batch, results, route)` 並呼叫。
- Modify `src/prompt.ts`（約 154 行）：成員的「Each wake-up handles one message」句補上必須寄回覆。
- Test `test/dispatcher.test.ts`：新增 2 個測試（沿用檔內 `run()`／`mail()`／`OK` helper）。
- Modify `docs/how-it-works.md`、`docs/how-it-works.zh-TW.md`：結束條件段補一句。

### Task 1: 成員靜默喚醒 → 寄 failure 給 lead

**Files:**
- Modify: `src/run-session.ts`（`settle()` 結尾，約 696–700 行 `failedIdx` 區塊之後）
- Test: `test/dispatcher.test.ts`

**Interfaces:**
- Consumes: `RouteResult`（`src/mailbox.ts:189`：`delivered[].from`、`rejected[].from`、`asks[].from`、`done?.from`）、`deliverOnce(project, journal, sourceKey, input)`（`src/mailbox.ts:106`）、`state.wakes`（每筆有 `agent`、`round`、`ok`、`handling[].type`）。
- Produces: 私有方法 `RunSession.notifySilentMembers(batch: ResolvedAgent[], results: WakeOutcome[], route: RouteResult): void`；log 事件 `"silent-member"`。

- [ ] **Step 1: 寫會失敗的測試（靜默成員 → lead 被通知、run 不以 idle 結束）**

加在 `test/dispatcher.test.ts` 的 `describe("dispatcher", …)` 內（緊接第一個測試之後）：

```ts
  it("tells the lead when a member handles a task and sends nothing", async () => {
    env = makeEnv();
    const seen: string[] = [];
    const leadPrompts: string[] = [];
    const s = await run(async (i) => {
      seen.push(i.agent.name);
      if (i.agent.name === "lead") {
        leadPrompts.push(i.userPrompt);
        if (seen.filter((n) => n === "lead").length === 1) mail(i, "fe-member", "implement login", "task");
        else mail(i, "lead", "gave up on silent member", "done");
      }
      return OK; // fe-member: succeeds but writes no mail
    });
    expect(seen).toEqual(["lead", "fe-member", "lead"]);
    expect(s.endReason).toBe("done");
    expect(leadPrompts[1]).toContain("fe-member");
    expect(leadPrompts[1]).toContain("implement login");
    expect(events(s.runDir).some((e) => e.event === "silent-member" && e.agent === "fe-member")).toBe(true);
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/dispatcher.test.ts -t "tells the lead when a member"`
Expected: FAIL（`seen` 只有 `["lead","fe-member"]`，run 以 `idle` 結束）

- [ ] **Step 3: 實作**

在 `src/run-session.ts` 的 `settle()` 最後（`failedIdx` 區塊結束的 `}` 之後、方法結尾 `}` 之前）加入呼叫：

```ts
    this.notifySilentMembers(batch, results, route);
```

並在 `settle()` 之前新增方法：

```ts
  /** A member that handled a `task` and woke up fine but sent nothing: the lead is told, instead of the run going quiet and ending idle. */
  private notifySilentMembers(batch: ResolvedAgent[], results: WakeOutcome[], route: RouteResult): void {
    const { project, runId, state, log, say } = this;
    batch.forEach((a, i) => {
      if (a.name === project.lead || !results[i]?.ok) return;
      const wake = [...state.wakes].reverse().find((w) => w.agent === a.name);
      const tasks = (wake?.handling ?? []).filter((h) => h.type === "task");
      if (!wake || tasks.length === 0) return;
      const spoke =
        route.delivered.some((d) => d.from === a.name) ||
        route.rejected.some((r) => r.from === a.name) ||
        route.asks.some((q) => q.from === a.name) ||
        route.done?.from === a.name;
      if (spoke) return;
      say(`  ${a.name} sent no mail after handling a task: telling ${project.lead}`);
      log("silent-member", { agent: a.name, round: wake.round, subjects: tasks.map((t) => t.subject) });
      deliverOnce(project, this.journal(), `silent:${runId}:${a.name}:${wake.round}`, {
        from: "dispatcher",
        to: project.lead,
        type: "failure",
        subject: `${a.name} sent no reply`,
        body: `${a.name} was woken to handle ${tasks.map((t) => `"${t.subject}"`).join(", ")} and finished without sending any mail (no reply, no question). Its work, if any, is in its worktree; its report is not available.\n\nDo not wait for it. Send it a task that asks for a reply (what it did, or why it is blocked), give the work to another agent, or do it yourself.`,
      });
    });
    this.saveState();
  }
```

（`WakeOutcome`、`RouteResult`、`ResolvedAgent`、`deliverOnce` 在檔頭已 import；`RouteResult` 已在第 10 行 import。）

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/dispatcher.test.ts -t "tells the lead when a member"`
Expected: PASS

- [ ] **Step 5: 寫不誤報的測試並確認通過**

```ts
  it("does not warn when the member replied", async () => {
    env = makeEnv();
    const s = await run(async (i) => {
      if (i.agent.name === "lead" && !i.userPrompt.includes("from: fe-member")) mail(i, "fe-member", "implement login", "task");
      else if (i.agent.name === "fe-member") mail(i, "lead", "login implemented");
      else mail(i, "lead", "all good", "done");
      return OK;
    });
    expect(s.endReason).toBe("done");
    expect(events(s.runDir).some((e) => e.event === "silent-member")).toBe(false);
  });
```

Run: `npx vitest run test/dispatcher.test.ts`
Expected: 全部 PASS（含原有測試）

- [ ] **Step 6: 跑全部測試與型別檢查**

Run: `npm run build && npm test`
Expected: 全部通過（`package.json` 無 `build`／`test` 時改用其 scripts 實際名稱）

- [ ] **Step 7: Commit**

```bash
git add src/run-session.ts test/dispatcher.test.ts
git commit -m "feat(run): tell the lead when a member handles a task and sends nothing"
```

### Task 2: 團隊協定與文件

**Files:**
- Modify: `src/prompt.ts:154`
- Modify: `docs/how-it-works.md`、`docs/how-it-works.zh-TW.md`（結束條件段）
- Test: 既有 prompt 相關測試（先 `grep -rn "Do the work it asks" test` 確認是否有斷言整句）

- [ ] **Step 1: 確認沒有測試釘住舊句子**

Run: `grep -rn "then stop" test src | head`
Expected: 只有 `src/prompt.ts`；若有測試斷言，同步更新。

- [ ] **Step 2: 修改 prompt（成員那句）**

把

```ts
      : "Each wake-up handles one message. Do the work it asks, then send the replies that are needed, then stop.",
```

改為

```ts
      : "Each wake-up handles one message. Do the work it asks, then send the replies that are needed, then stop. If you were given a `task`, always end by sending a `reply` to the sender: what you did, or why you are blocked. Finishing without any mail leaves the sender waiting, and the dispatcher reports it to the lead as a failure.",
```

- [ ] **Step 3: 文件**

`docs/how-it-works.md` 第 5 點（結束條件）末尾補：`A member that handles a task and finishes without sending any mail is reported to the lead as a \`failure\` (subject "<agent> sent no reply"), so the run does not go quiet and end idle.` 中文檔補：`成員處理完 task 卻沒寄任何信時，dispatcher 會以 failure 通知 lead（主旨「<agent> sent no reply」），run 不會悄悄以 idle 結束。`

- [ ] **Step 4: 檢查與 commit**

Run: `node scripts/check-docs.mjs && npm test`
Expected: `docs ok`，測試全過

```bash
git add src/prompt.ts docs/how-it-works.md docs/how-it-works.zh-TW.md
git commit -m "docs(run): members must reply to a task; silent members are reported"
```

---

## Self-Review

- 覆蓋：P0-1 的「通知 lead」「只在 task 觸發」「冪等 key」「prompt 補一句」「單人 run 不適用」皆有對應。
- 預期行為變更：成員靜默後 lead 會多醒一輪（已在風險中說明）。
- 型別：`notifySilentMembers` 在 Task 1 定義並只在同檔呼叫；log 事件名 `silent-member` 在測試與實作一致。
- 待實作時確認：`settle()` 在 `done`／`waiting` 時提早 `return`，這兩種情況本來就不需通知，不用處理。
