# agent-lyceum 改善實作計畫

> **For agentic workers:** 使用 `superpowers:executing-plans` 逐項執行；只有使用者指定委派時才使用 subagent。以核取方塊追蹤進度。

**Goal:** 改善任務隔離、中斷復原、平行寫入安全、完成判定、程序管理與操作體驗，涵蓋本次評估的全部八個方向。

**Architecture:** 保留 TypeScript CLI、檔案信箱與 runtime adapter 架構。先建立 run 儲存與鎖定邊界，再加入可復原的訊息處理、獨立 worktree 與明確結果狀態；診斷和機器可讀輸出沿用相同資料模型。

**Tech Stack:** Node.js 20+、TypeScript ESM、Commander、YAML、Zod、Vitest、Git worktree；macOS 與 Linux。

**Spec:** 本文件的「需求與決策」為實作規格，來源為本次專案評估與使用者要求全部納入 plan。此階段僅建立文件，尚未實作或驗證下列功能。

## 全域限制

- 維持 Node.js >=20 與 macOS/Linux 支援。
- 工具設定、信箱、log、任務記憶放在 agent-lyceum home；agent 的工作成果依執行模式寫入 repo 或 worktree。
- 使用既有依賴；只有既有工具無法合理完成需求時才新增依賴。
- 舊 run 與舊 project.yaml 必須可讀；新增狀態檔使用 `schema_version: 2`。
- 破壞相容性的 exit code 與信箱行為，必須更新中英文 README 並記錄升級方式。
- 每項任務可獨立提交；以下測試是未來實作的驗收工作，本次文件建立不執行測試。
- 不自動發布、不自動 push，也不自動覆蓋使用者未提交的 repo 修改。

## 需求與決策

1. 同一專案只允許一個 dispatcher 執行；不同專案可同時執行。run ID 使用 UTC 毫秒時間加 128-bit 隨機值。
2. 新 run 信箱放在 `runs/<run-id>/mail/{inbox,outbox}/<agent>/`，訊息具 `run_id`。跨 run 的信件拒絕投遞。舊 run 沿用既有共享信箱並顯示 legacy 警告，不自動搬移無法判定歸屬的信件。
3. 信箱採至少一次處理與投遞去重；不承諾任意 agent shell 操作恰好執行一次。復原時明示可能已發生的外部副作用。
4. 平行執行預設每個非 lead agent 使用獨立 worktree；lead 在主 repo 整合。無法提供隔離時拒絕平行執行，仍允許序列模式。
5. 結束原因與工作結果分開表示。只有明確 `completed` 才回傳 exit 0；部分完成、受阻或 idle 回傳 2，失敗回傳 1，取消回傳 130。
6. 支援正常取消、timeout 與子程序樹清理；完整輸出寫檔，記憶體中只保留最多 64 KiB 的錯誤尾端。
7. 提供 `doctor`、`config show --resolved`、`status --json`，補足 adapter 相容性與故障情境測試。
8. 最小團隊為兩人，且 lead 必須存在；`clear` 一併處理 run、任務記憶及 worktree，長期記憶保留。

## Review Focus

- 兩個程序同時啟動或 resume：只能有一個取得專案鎖（Task 2）。
- 多收件者投遞途中中斷：resume 不重複投遞已成功的收件者（Task 4）。
- agent 已產生副作用後失敗：重試須有可追蹤 attempt，不能把舊 outbox 當新成功成果（Task 5）。
- worktree 整合時主 repo 有未提交修改或衝突：保留雙方成果並標示受阻（Task 7、8）。
- timeout 後孫程序仍持有 stdout：dispatcher 必須在有界時間結束（Task 9）。

## 檔案責任

| 檔案 | 責任 |
|---|---|
| `src/run-store.ts`（新增） | run ID、狀態 schema、舊狀態正規化、run 路徑 |
| `src/project-lock.ts`（新增） | 原子專案鎖、heartbeat、持有者識別與釋放 |
| `src/message-store.ts`（新增） | 處理 journal、投遞去重與復原 |
| `src/worktree.ts`（新增） | agent worktree 建立、變更提交、整合與保留 |
| `src/process-runner.ts`（新增） | 串流 log、程序樹、取消與 timeout |
| `src/doctor.ts`（新增） | runtime 能力探測與診斷 |
| `src/run-cleanup.ts`（新增） | 可預覽且可重試的任務清理 |
| `src/dispatcher.ts` | 排程、attempt、狀態轉移，委派儲存與程序管理 |
| `src/cli.ts` | 新指令、exit code、鎖定生命週期 |
| `src/mailbox.ts`、`src/prompt.ts`、`src/policy.ts` | run 信箱、協定與寫入政策 |
| `src/config.ts`、`src/schema.ts`、`src/validate.ts` | 新設定、來源資訊與驗證 |
| `src/status.ts`、`src/adapters/*` | 新結果顯示、結構化輸出與 adapter 串流解析 |
| `test/*.test.ts`、`test/fixtures/runtime/*`（新增） | 各項功能與模擬 CLI 驗收 |

## 實作順序

Phase A：Task 1 → 2 → 3 → 4 → 5 → 6，先交付穩定的序列執行。

Phase B：Task 7、8 與 9，補齊平行隔離及程序管理。

Phase C：Task 10、11、12，交付診斷、設定體驗與完整清理。

Task 13 完成跨功能驗收與文件。每一階段均能獨立驗收；不需一次發布所有變更。

### Task 1：版本化 run 儲存與唯一 ID

**Files:** 新增 `src/run-store.ts`、`test/run-store.test.ts`；修改 `src/dispatcher.ts`、`src/status.ts`、`src/cli.ts`。

**Interfaces:** `newRunId(date?: Date): string`；`loadRunState(runDir: string): RunState`；`saveRunState(runDir: string, state: RunState): void`。`RunState` 新增 `schema_version: 2`、`mail_layout: "run" | "legacy"`，既有欄位保持可讀。

- [x] 寫測試：固定同一時間產生 10,000 個 ID，全部唯一且通過 `assertName`（含長度與 `NAME_RE` 限制，以及作為路徑與 git ref 片段合法）；舊格式 ID（現有 `newRunId`，`src/dispatcher.ts:94`）仍可被讀取與 resume；舊狀態缺少 `active`、`wakes` 時補成空集合；壞 JSON 或未知版本提供明確錯誤。
- [x] 執行 `npm test -- test/run-store.test.ts`，確認新增案例先失敗。
- [x] 集中 ID 與 state 的讀寫邏輯；使用 Zod 驗證，禁止 CLI/status 直接將任意 JSON cast 成 RunState；state 保持原子寫入。
- [x] 執行上述測試及 `npm run typecheck`，預期全部通過。
- [x] 提交：`refactor: centralize versioned run storage`。

### Task 2：專案鎖與可靠的執行中判定

**Files:** 新增 `src/project-lock.ts`、`test/project-lock.test.ts`；修改 `src/cli.ts`、`src/status.ts`、`src/dispatcher.ts`。

**Interfaces:** `acquireProjectLock(projectRoot: string, runId: string): ProjectLease`；`ProjectLease.release(): void`；`inspectProjectLock(projectRoot: string): LockInfo | undefined`。LockInfo 包含 token、hostname、pid、run_id、heartbeat_at。

- [x] 寫程序級競爭測試：同專案兩程序只一個成功、不同專案皆成功、release 不刪除不同 token 的鎖；活程序但 heartbeat 延遲時不能搶鎖。
- [x] 執行 `npm test -- test/project-lock.test.ts`，確認先失敗。
- [x] 以 `open` 的 `wx` 原子建立鎖；每 5 秒更新 heartbeat。鎖檔放在專案 home（`projects/<name>/lock.json`），不在使用者 repo；`projectRoot` 指專案 home。鎖在 run 目錄建立與任務寫入前取得，run/resume/clear 共用鎖。LockInfo 另記錄程序啟動時間（`ps` 的 lstart，跨重開機也不會相同），避免 PID 重用誤判；原子建立改用「寫入暫存檔再 hard link」，效果等同 `wx` 且鎖檔內容不會只寫一半；僅在確認該程序（pid＋啟動時間）不存在時回收，不依賴 hostname（macOS 會隨網路變動）。無法判定歸屬的鎖要求人工處理，不憑 heartbeat 過期強行搶鎖。
- [x] 新增 `unlock [-p name] --force`：顯示鎖資訊並要求確認後移除，作為人工處理的出口；補測試（PID 重用、hostname 改變、unlock 流程）。
- [x] 將鎖資訊作為執行中判定依據，PID 僅為輔助；在 `finally` 釋放自己的 token。
- [x] 執行鎖測試、`test/status.test.ts` 及 typecheck，預期全部通過。
- [x] 提交：`fix: serialize dispatchers with project leases`。

### Task 3：信箱依 run 隔離

**Files:** 修改 `src/run-store.ts`、`src/mailbox.ts`、`src/policy.ts`、`src/prompt.ts`、`src/dispatcher.ts`、`src/status.ts`；新增 `test/run-mailbox.test.ts`。

**Interfaces:** `bindRunProject(project: ResolvedProject, runDir: string, layout: "run" | "legacy"): ResolvedProject`，回傳信箱與 task memory 路徑已綁定的副本；MessageMeta 新增 `run_id?: string`，新格式必填，legacy 可省略。

- [x] 寫測試：同專案 run A 的未讀信件不能被 run B 看見；A 的 outbox 宣告 B 的 run_id 時進 rejected；resume 沿用 A；legacy 不搬移信件。
- [x] 執行 `npm test -- test/run-mailbox.test.ts`，確認先失敗。
- [x] 實作 run 路徑綁定並讓 prompt、adapter 寫入根目錄和 status 一致使用；dispatcher 蓋上可信 run_id，不信任 agent 自訂的寄件者。
- [x] 為 status 未指定 run 時採用最新 run；task detail 使用指定 run；README 說明 legacy 共享信箱限制。
- [x] 執行新測試、mailbox/dispatcher/status 測試及 typecheck，預期全部通過。
- [x] 提交：`feat: isolate mailboxes by run`。

### Task 4：訊息處理 journal 與投遞去重

**Files:** 新增 `src/message-store.ts`、`test/message-store.test.ts`；修改 `src/mailbox.ts`、`src/dispatcher.ts`、`src/run-store.ts`。

**Interfaces:** `claimMessages(runDir: string, agent: string, messageIds: string[]): ClaimRecord`；`commitClaim(runDir: string, claimId: string): void`；`recoverRunMail(runDir: string): RecoveryReport`。路由 journal 以 `(source_id, recipient)` 唯一識別投遞。attempt 概念由 Task 5 在此之上加入。

- [x] 寫故障注入測試：每個 journal/rename/投遞步驟後模擬中斷；重啟後已提交訊息不再喚醒，未提交訊息仍可處理，雙收件者各收到一份。
- [x] 執行 `npm test -- test/message-store.test.ts`，確認先失敗。
- [x] 原子保存輸入 claim，保存輸出副本和路由 journal，完成投遞後才標記輸入已讀並提交；收件者使用決定性 ID，resume 驗證既有內容而非重新產生隨機 ID。
- [x] 在開始喚醒前復原 journal；將 done 的持久化納入相同流程，避免 done 已搬走但 result/state 未存的缺口。此處只處理持久化順序；done 的內容契約與 outcome 由 Task 6 負責，Task 6 不得改動 journal 流程。
- [x] 執行故障注入、mailbox/dispatcher 測試及 typecheck，預期全部通過。
- [x] 提交：`fix: recover mail routing with durable journals`。

### Task 5：attempt 追蹤與安全重試

**Files:** 修改 `src/message-store.ts`、`src/dispatcher.ts`、`src/run-store.ts`、`test/message-store.test.ts`；新增 `test/attempt.test.ts`。

**Interfaces:** `beginAttempt(runDir: string, claimId: string): AttemptRecord`；`finishAttempt(runDir: string, attemptId: string, status: "committed" | "failed"): void`。AttemptRecord 狀態為 `started | output_ready | committed | failed`，輸出目錄以 attempt ID 隔離。

- [x] 寫測試：第一次 attempt 寫出 outbox 後失敗，舊輸出被隔離在該 attempt 目錄，不混入第二次成果；重試次數有上限；報告記錄可能已產生 repo 副作用。
- [x] 執行 `npm test -- test/attempt.test.ts`，確認先失敗。
- [x] 將 claim 之後的喚醒包成 attempt：輸出先寫入 attempt 目錄，成功才交給 Task 4 的路由 journal；失敗的 attempt 保留供檢視，不當作成果。
- [x] 復原時對 `started` 或 `output_ready` 的 attempt 明示「外部副作用可能已發生」，並出現在 status 與 log。
- [x] 執行 attempt、message-store、dispatcher 測試及 typecheck，預期全部通過。
- [x] 提交：`feat: track attempts and isolate retry output`。

### Task 6：結果狀態與完成契約

**Files:** 修改 `src/schema.ts`、`src/mailbox.ts`、`src/dispatcher.ts`、`src/cli.ts`、`src/status.ts`、`src/prompt.ts`；新增 `test/outcome.test.ts`。

**Interfaces:** `RunOutcome = "completed" | "partial" | "blocked" | "failed" | "cancelled"`；`exitCodeForOutcome(outcome: RunOutcome): 0 | 1 | 2 | 130`；done frontmatter 新增 `outcome`，body 要求 `## Result`、`## Files`、`## Verification`、`## Not done`。

- [x] 寫測試：idle 不回傳 0；blocked/partial 回傳 2；failed 回傳 1；cancelled 回傳 130；缺完成欄位或仍有未完成 Steps 時不能宣告 completed。
- [x] 執行 `npm test -- test/outcome.test.ts`，確認先失敗。
- [x] done 內容驗證失敗（缺標題、缺 outcome、仍有未完成 Steps）時，dispatcher 不結束 run，而是回信給 lead 說明缺漏並要求補寫，最多 2 次；仍失敗則以 `partial` 結束並保留原報告。寫測試覆蓋補寫成功、超過次數降級、不無限迴圈。
- [x] 分離 `end_reason` 與 `outcome`；legacy done 缺 outcome 時保留報告並正規化為 partial，提示補完成契約，不默認成功。
- [x] 對 legacy 已結束 run 保留原始資訊並註記結果未驗證；不將 checklist 或 agent 自述視為獨立測試證據。顯示驗證摘要與可追溯 log 路徑。
- [x] 執行 outcome、dispatcher/status 測試與 typecheck，預期全部通過；更新兩份 README 的 exit code。
- [x] 提交：`feat: distinguish run outcomes from stop reasons`。

### Task 7：worktree 工作區與平行隔離

**Files:** 新增 `src/worktree.ts`、`test/worktree.test.ts`；修改 `src/config.ts`、`src/schema.ts`、`src/validate.ts`、`src/dispatcher.ts`、`src/adapters/types.ts`、兩個 adapter、`src/policy.ts`。

**Interfaces:** `snapshotBase(project: ResolvedProject, runId: string, n: number): string`（回傳快照 ref）；`prepareAgentWorkspace(project: ResolvedProject, runId: string, agent: string, baseRef: string): AgentWorkspace`；`removeAgentWorkspace(workspace: AgentWorkspace): void`。

- [x] 寫臨時 Git repo 測試：成員修改彼此不可見；run 啟動時主 repo 已有使用者未提交修改則拒絕平行模式（記錄 `baseline_dirty_paths` 於 run state）；run 期間 lead 自己產生的修改不觸發拒絕，且成員 worktree 能看到它們；沒有 Git 時僅序列可用。
- [x] 執行 `npm test -- test/worktree.test.ts`，確認先失敗。
- [x] 平行回合開始前，以 `git commit-tree` 對主 repo 工作樹（含 lead 未提交修改）建立快照 commit，存為 `refs/agent-lyceum/<run-id>/base-<n>`，不改動 HEAD 與使用者 branch。不屬於 tracked 或 lead 產生的無關未追蹤檔案處理方式須在文件說明。
- [x] worktree 放在專案 home 的 `worktrees/<run-id>/<agent>`，以同一快照建立專屬 branch；新增 `dispatcher.workspace_mode: "auto" | "shared" | "worktree"`，auto 在 max_parallel >1 使用 worktree，shared 與平行組合拒絕。
- [x] adapter cwd 與 writable roots 使用 agent workspace；resume 重用既有 worktree。
- [x] 執行 worktree、validate、adapters、dispatcher 測試及 typecheck，預期全部通過；文件說明 worktree 仍不能隔離外部服務副作用。
- [x] 提交：`feat: isolate parallel agents in git worktrees`。

### Task 8：變更收集與整合

**Files:** 修改 `src/worktree.ts`、`src/dispatcher.ts`、`src/policy.ts`、`test/worktree.test.ts`；新增 `test/integration.test.ts`。

**Interfaces:** `collectAgentChanges(workspace: AgentWorkspace, owns: string[]): ChangeSet`；`integrateAgentChanges(project: ResolvedProject, changes: ChangeSet): IntegrationResult`。IntegrationResult 為 `integrated | blocked` 並包含原因及保存路徑。

- [x] 寫臨時 Git repo 測試：越出 owns 的 diff 被拒絕整合；刪除與 rename 都驗證邊界；符號連結逃逸被拒絕；整合衝突保留 agent commit 與報告。
- [x] 補測試：兩成員修改不同檔案皆整合成功；同檔衝突時 blocked 並保留兩邊；整合前同一路徑又被修改時標示 blocked，不 reset 或覆寫；整合結果不移動使用者的 HEAD 或 branch。
- [x] 執行 `npm test -- test/integration.test.ts`，確認先失敗。
- [x] 成員完成後在其 worktree 提交；整合以 `git diff base-<n>..<member>` 搭配 `git apply --3way` 套用到主 repo 工作樹，且僅在這些路徑自快照後未被改動時進行，否則 blocked。owns 以 repo-relative diff 驗證。
- [x] 整合在專案鎖下序列進行，與 lead 不並行；blocked 時結果對應 Task 6 的 `blocked` outcome。
- [x] 執行 integration、worktree、dispatcher 測試及 typecheck，預期全部通過。
- [x] 提交：`feat: integrate agent worktree changes safely`。

### Task 9：取消、timeout 與串流程序輸出

**Files:** 新增 `src/process-runner.ts`、`test/process-runner.test.ts`、`test/fixtures/runtime/process-tree.mjs`；修改 `src/adapters/index.ts`、`src/adapters/types.ts`、兩個 adapter、`src/dispatcher.ts`、`src/cli.ts`。

**Interfaces:** WakeInput 新增 `signal?: AbortSignal`；`runInvocation(inv: Invocation, opts: { timeoutSec: number; signal?: AbortSignal; logDir: string }): Promise<WakeResult>`；adapter 解析改為逐事件累積必要結果，完整 raw stdout/stderr 寫檔。

- [x] 寫測試：spawn ENOENT、SIGINT、SIGTERM、timeout、孫程序持有 pipe、100 MiB 輸出、壞 JSON 行；結果只 settle 一次，尾端緩衝不超過 64 KiB。
- [x] 執行 `npm test -- test/process-runner.test.ts`，確認先失敗。
- [x] POSIX 使用獨立 process group；取消時先 TERM，5 秒後 KILL，最多再等 1 秒即回傳並關閉自身 pipe；stdout/stderr 使用 stream backpressure 寫入 attempt log。
- [x] CLI signal 觸發 AbortController；dispatcher 停止派新工作，保存 cancelled 狀態，未提交輸入保留，釋放專案鎖。不支援 Windows（與全域限制一致），在 doctor 中標示。
- [x] 執行程序測試、adapter/dispatcher 測試及 typecheck，預期全部通過，並檢查 fixture 子孫程序皆已退出。
- [x] 提交：`fix: bound runtime output and clean up process trees`。

### Task 10：doctor 與 runtime 能力檢查

**Files:** 新增 `src/doctor.ts`、`test/doctor.test.ts`、`test/fixtures/runtime/*`；修改 `src/cli.ts`、`src/validate.ts`、`src/adapters/*`、`.github/workflows/ci.yml`。

**Interfaces:** `probeRuntime(runtime: Runtime): Promise<RuntimeCapabilities>`；`diagnoseProject(project: ResolvedProject): Promise<DoctorReport>`；RuntimeCapabilities 包含 binary、version、json、resume、sandbox、effort；未知能力使用 `unknown`。

- [x] 寫 fixture 測試：binary 缺失、版本輸出不同、help 缺 resume、CLI timeout、不同 JSON 結果、session ID 缺失；確認 doctor 不執行付費 agent 任務。
- [x] 執行 `npm test -- test/doctor.test.ts test/adapters.test.ts`，確認新增案例先失敗。
- [x] 新增 `doctor [-p name] [--json]`；以有 timeout 的 version/help 探測能力，登入只在 CLI 提供唯讀診斷介面時檢查，其他情況顯示 unknown；不輸出 credential 或完整環境變數。
- [x] 用 capability 結果取代「Codex resume 未測試」的固定警告；run 遇到明確不支援的必要功能先拒絕，未知能力明示。版本資料使用 fixture 記錄，不依 model 名稱推定功能。
- [x] CI 跑 fake CLI 的程序整合測試；真實 CLI smoke 採手動啟動且說明成本，執行時先查官方文件確認指令相容性。
- [x] 執行 doctor、adapters、validate 測試及 typecheck，預期全部通過。
- [x] 提交：`feat: diagnose runtime capabilities before dispatch`。

### Task 11：設定來源、JSON 狀態與小團隊

**Files:** 修改 `src/config.ts`、`src/schema.ts`、`src/validate.ts`、`src/cli.ts`、`src/status.ts`；新增 `test/cli.test.ts`；修改 `test/config.test.ts`、`test/validate.test.ts`。

**Interfaces:** `resolveProjectWithSources(home: string, name: string): { project: ResolvedProject; sources: Record<string, { file: string; key: string } | { default: true }> }`；`buildStatusReport(project: ResolvedProject, runId?: string): StatusReport`，StatusReport 含 `schema_version: 1`。

- [x] 寫測試：兩人團隊有效、一人無效、lead 缺失無效；runtime/model precedence、陣列替換及相對路徑來源顯示正確。
- [x] 補 CLI 測試：`status --json` stdout 只有 JSON 且不含 ANSI；`--task-id` 與 `--task-list` 同樣可輸出 JSON；錯誤走 stderr 並非零 exit。
- [x] 執行 `npm test -- test/cli.test.ts test/config.test.ts test/validate.test.ts`，確認新增案例先失敗。
- [x] 新增 `config show --resolved [-p name] [--json]`，列出實際生效值與來源；status 的文字和 JSON 都由同一報告生成。最小人數由 3 改為 2（`src/validate.ts:24`），保留預設三人成員範本；檢查 prompt 與協定文字沒有假設存在第三位成員，並新增兩人團隊從 run 到 done 的端到端案例。
- [x] 執行上述測試、status 測試及 typecheck，預期全部通過；更新中英文設定與小團隊範例。
- [x] 提交：`feat: expose resolved configuration and structured status`。

### Task 12：完整且可重試的任務清理

**Files:** 新增 `src/run-cleanup.ts`、`test/run-cleanup.test.ts`；修改 `src/cli.ts`、`src/worktree.ts`、`src/run-store.ts`。

**Interfaces:** `planRunCleanup(project: ResolvedProject, runId: string): CleanupPlan`；`executeRunCleanup(plan: CleanupPlan): CleanupReport`。CleanupPlan 列出 run、task memory、已整合且乾淨的 worktree/branch，及需要保留的成果。「已整合」以 `git merge-base --is-ancestor <member-head> HEAD` 或整合紀錄中的 patch 已套用為準；兩者皆無法證明時視為未整合，拒絕刪除。

- [x] 寫測試：clear 刪除 run 與 task-memory；不影響其他 run、global/project memory；執行中拒絕；中斷後可重試；符號連結不能讓刪除逃出專案 home。
- [x] 補測試：未整合 commit 或髒 worktree 時拒絕清除並列出成果；`--keep-worktrees` 保留 worktree 後仍可清除 run 與 task memory。
- [x] 執行 `npm test -- test/run-cleanup.test.ts`，確認先失敗。
- [x] 新增 `clear <run-id> --dry-run` 與 `--keep-worktrees`；使用 Task 2 鎖。以 Git worktree remove 移除可安全清理的 workspace，再刪 task memory，最後刪 run；清理進度存於專案層 journal，避免刪除自身進度。
- [x] 執行 cleanup、worktree、CLI 測試及 typecheck，預期全部通過；README 清楚列出刪除範圍。
- [x] 提交：`fix: clean run artifacts without losing agent work`。

### Task 13：整體驗收與升級文件

**Files:** 修改 `README.md`、`README.zh-TW.md`、`.github/workflows/ci.yml`；新增 `docs/upgrading-run-v2.md`、`test/run-lifecycle.test.ts`。

**Interfaces:** 使用前述既有介面，不新增執行模型。

- [x] 建立 fake CLI 端到端案例：run → 成員回覆 → done；SIGINT → resume；路由中斷 → 去重；worktree 衝突 → blocked；clear dry-run → clear。
- [x] 執行 `npm test -- test/run-lifecycle.test.ts`；失敗時回到對應任務修復，不以跳過案例結案。
- [x] 編寫 v1/v2 run 差異、legacy 信箱、exit code、dirty repo 限制、doctor unknown、worktree 整合與恢復副作用限制；修正 README「絕不寫入 repo」的描述，區分工具資料與 agent 工作成果。
- [x] 執行 `npm run typecheck`、`npm test`、`npm run build`，預期全部成功；CI 既有 macOS/Linux × Node 20/22 矩陣皆通過。
- [x] 檢查 package 產物仍包含 CLI 需要的模組，執行 `npm pack --dry-run`；檢查中英文指令和新 JSON 範例一致。
- [x] 提交：`docs: document reliable runs and verify lifecycle`。

## 實作紀錄

- Phase A（Task 1–6）已於分支 `feat/reliable-runs-phase-a` 實作並通過 `npm run typecheck`、`npm test`（117 項）、`npm run build`。
- 與計畫的差異：專案鎖以暫存檔＋hard link 原子建立並記錄 `ps` 啟動時間（不另記 boot id）；新增 `unlock --force` 指令；`recoverRunMail` 另回傳 `ready`、`interrupted` 供 dispatcher 使用。
- Task 7、8 已實作（commit `feat: isolate parallel agents in git worktrees`、`feat: integrate agent worktree changes safely`）。與計畫的差異：快照包含 lead 未提交的修改與「新增且未被 ignore」的檔案（而非只含已追蹤檔）；整合用 `git apply`（不加 `--3way`，因為已先逐檔確認自快照後未被改動，`--3way` 會連帶動到使用者的 index）；run 啟動時主 repo 有未提交修改就拒絕，因此沒有另存 `baseline_dirty_paths`；整合被擋時以 `blocked_integrations` 記在 run state，run 不能以 `completed` 結束。
- Task 9 已實作。與計畫的差異：adapter 新增 `stream()`（逐行讀取 stdout，只保留所需結果），舊的 `parse()` 保留作為備援；每次嘗試的 log 放在 `mail/attempts/<attempt>/log/`；取消時的 outcome 為 `cancelled`（exit 130），未提交的輸入保留給 `resume`，第二次 Ctrl-C 立即結束。有一個用假 `claude` 執行檔、真實 SIGINT 的 CLI 端到端測試。
- Task 10 已實作：`doctor`、啟動前的能力檢查（明確 `no` 拒絕、`unknown` 警告）、移除「Codex resume 未測試」的固定警告；CLI 回報沒有 session id 時，對 `resume: true` 的 agent 記一次提醒。`doctor` 已對本機真實安裝的 `claude` 跑過（能力判定為 json/resume/sandbox/effort 皆 yes）；Codex 只用 fixture 驗證。CI 既有的 `npm test` 已涵蓋假 CLI 整合測試，不另加步驟。
- Task 11 已實作。`status` 改為先建立 `StatusReport`／`RunReport`，文字頁面與 `--json` 都由它產生；`config show --resolved` 與 `resolveProjectWithSources`；最小人數降為 2。JSON 報告刻意不含 session id。
- Task 12 已實作（`src/run-cleanup.ts`）：「已整合」以「agent 提交的檔案內容已在主 repo 工作樹，或其 commit 已是 HEAD 的祖先」判定，無法判定就視為未整合並拒絕；刪除順序為 worktree → 快照 ref → 任務記憶 → run 目錄（最後），進度 journal 放在 `projects/<name>/cleanup/`；刪除前以 realpath 確認在專案 home 內，symlink 只移除連結本身。
- Task 13 已完成：`test/run-lifecycle.test.ts` 以真實 CLI 加劇本化的假 `claude` 跑完整流程（run → worktree 成員 → Ctrl-C → resume → 整合 → done → status --json → clear --dry-run → clear，以及 worktree 衝突 → blocked exit 2 → clear 拒絕 → `--keep-worktrees`）；「路由中斷 → 去重」在 `message-store.test.ts` 以故障注入涵蓋，未經 CLI；`docs/upgrading-run-v2.md` 與兩份 README 已更新；`npm run typecheck`、`npm test`（210 項，連跑 3 次皆過）、`npm run build`、`npm pack --dry-run` 都通過。CI 既有的 macOS／Linux × Node 20／22 矩陣只在本機以 macOS 驗證過，尚未在 CI 實際跑。
- 尚未做：真實 Claude/Codex CLI 的端到端試跑（只用模擬 invoker 與假的 `claude` 執行檔驗證）；worktree 模式下 agent 沙箱規則只以單元測試檢查，未用真實 CLI 驗證。

## 覆蓋與完成標準

| 原始改善方向 | 任務 |
|---|---|
| 任務隔離、專案鎖、唯一 run ID | 1、2、3 |
| 中斷復原、訊息去重與安全重試 | 4、5 |
| 平行寫入隔離與整合 | 7、8 |
| 停止與成功完成的區別 | 6 |
| 程序生命週期、取消、輸出容量 | 9 |
| doctor、設定來源、JSON、CLI 相容性 | 10、11、13 |
| 允許兩人成員團隊 | 11 |
| 清理任務記憶與成果保留 | 12 |

所有任務核取方塊完成、Phase A/B/C 驗收通過、兩份 README 與升級文件完成後，才宣告實作完成。計畫建立不表示上述風險已重現，也不表示功能已交付。
