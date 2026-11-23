# 單獨執行 agent 的 lesson 提案 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `run --agent` 與 `call -p` 的單獨 agent 可以把 lesson／decision 寫成提案（附證據）；**只有 lead** 能把提案決議為 `accepted`／`rejected` 並寫正式 records（一般 run，或 `proposals review` 喚醒）。

**Architecture:** 提案放在 `<project root>/proposals/<kind>/`（在 `records/` 與 handoff 目錄之外，避開 `policy.ts:219` 的 deny）。`src/proposals.ts`（新）放解析與 D-09 兩層檢查的純函式，供 `mailbox`（`done`）、`proposals review` 的 post-check、`doctor`、prompt 共用。`guard.ts` 修授權條件並監看提案區。`proposals review` 沿用 `tidy` 的喚醒機制（exclusive lock、policy 覆寫可寫範圍、snapshot／restore），**不經 guard，CLI 本身不寫任何提案或 record**。

**Tech Stack:** TypeScript ESM、Node `fs`、Vitest、Biome。不新增依賴。

**Spec:** `docs/specs/30-solo-lesson-proposals.md`（v4，D-01 ~ D-18，驗收 1–19）。**狀態：三次獨立審查後的草案，v4 修正處尚未再審，尚未實作。** 測試檔名以實際存在者為準：guard 用 `test/guard-concurrent-runs.test.ts`（既有）與新增 `test/guard-proposals.test.ts`；policy 用 `test/project-write-scope.test.ts`；prompt 用既有 `test/prompt-*.test.ts` 或新增 `test/prompt-proposals.test.ts`；records 相關用 `test/project-records.test.ts`。計畫中寫「新建」的測試檔才需要建立。

## Global Constraints

- Node >=20，macOS 與 Linux；不新增依賴。
- **只有 lead 能寫正式 records 與決議提案**；solo agent 只能新建 `proposed`；CLI 行程不直接寫提案或 record（spec 30.3）。
- 沒有任何提案的既有專案，lead 與一般成員的 prompt 位元組與現在完全相同（驗收 16）；`run --agent` 的 prompt 在沒有提案時也不變，除了 solo 的提案規則段（驗收 10 對 `run --agent` 的限定見 spec D-16）。
- 程式、prompt、文件與測試不得寫死 agent 名稱。
- 破壞相容性或新增行為時，同步更新 `README.md`、`README.zh-TW.md`、`docs/commands*.md` 等，並通過 `npm run check:docs`（中英標題結構一致）。
- **驗證節奏（依專案偏好）：** 每個 commit 只跑 type-check 加範圍內的測試；完整 `npm test`、`lint`、`check:docs` 只在 Task 10 跑一次。
- 每個 Task 一個 commit（**例外：Task 7.0 的純重構獨立成一個 commit，先於 7.1**），結尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`（以系統提示給的 attribution 為準）。發版不在本計畫內。
- Task 2 會改變既有行為（solo 寫 records 開始被還原），要在文件與說明寫明。

## 已查證的事實（Task 0 已結案的項目）

| 項目 | 結論 | 來源 |
|---|---|---|
| tidy 是否經 guard | 否。`tidyMemory` 路徑沒有 `ProtectedGuard`；`project.solo` 是 `undefined`；靠 `invoke({ policy })`＋snapshot／fingerprint／restore | `src/cli.ts:665`、`src/memory-tidy.ts:370-390`、`:121-125` |
| D-03 對 tidy／review／一般 lead 的影響 | 無（`lead && !project.solo` 對它們不變） | 同上 |
| `policy.ts` 的 `shared` | 是 `task-memory/<run>/_shared` handoff 目錄，不是 records 所在的 `paths.shared`；`mayWriteShared` 對 solo 是 true | `src/policy.ts:73-76`、`:183` |
| 提案區的 parent deny | 沒有。`proposals/` 是 root 的同層目錄；deny 只有 agentMd、他人 memory／outbox／inbox、handoff 目錄、`recordsDir`、run 細項、`project.yaml`、`team.yaml`、他人 worktree | `src/policy.ts:214-222` |
| `project.home` 受保護 | 已整個列入受保護路徑，提案區天然在其內，spec 25 只需加註 | `src/sandbox-invocation.ts:86` |
| 各 runtime 強制程度 | Claude／Codex 有 OS 沙箱時擋 records；Cursor 只擋工具層；無沙箱時只剩 guard | `src/adapters/codex.ts:14`、spec 30.1.1 |
| `call` 的 guard 範圍 | 監看全域 agent 的 `AGENT.md`、callDir 的 `COMMON.md`、`--dir` 的 CLAUDE.md／AGENTS.md，invoke 後檢查一次（`:209`）；沒有 `otherLiveRuns`、沒有 `run`（不存違規副本） | `src/call.ts:166-167`、`:209`、`src/guard.ts:99-101` |
| `call -p` 的最小解析 | 新 helper `resolveProjectRef`（`projectPaths`＋檢查 `project.yaml`＋只讀 `dir`）；不可重用 `loadProject`；`callProject` 的 `paths.root` 是 callDir，需 `ResolvedProject.proposalsRef` | `src/paths.ts`、`src/cli.ts:61`、`src/call.ts:70-93` |
| call id 格式 | 就是 `newRunId()`，與 run id 同格式，短 id 取法相同（Task 0.2 已結案） | `src/call.ts:159` |
| guard 對提案區 | 目前完全不知道提案區；一般成員寫提案區不被偵測（Task 0.3 已結案，本版不做） | `src/guard.ts` |
| `done` 對 solo | `sender.name === project.lead` 對 solo 也成立；D-09 第 (1) 層必須在 `project.solo` 時跳過 | `src/mailbox.ts:392-397` |
| `prompt.ts` 的 `isLead` | `:216,354,376` 沒有 `!solo`，只有 `:128` 有；待審提示要自己帶 `!project.solo` | `src/prompt.ts` |
| tidy 的 records 前提 | 在 `memory-tidy.ts:326-331`、`:424`、`:437`；`:299` 是 `recordsInScope` | `src/memory-tidy.ts` |

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/policy.ts` | `proposalsDir`／`proposalsKindDir`；solo 的 `allowDirs`；其他人對提案區唯讀 |
| `src/proposals.ts`（新） | 提案解析、D-09 第 (1)(2) 層檢查、待審清單、強弱證據 |
| `src/guard.ts` | 修 `checkRecords` 授權條件；提案區監看；選用 `{ recordsRoot, proposalsRoot }` |
| `src/prompt.ts` | solo 規則與判準（30.12）、`call -p` 標題清單；lead 待審提示；review 喚醒 prompt |
| `src/mailbox.ts` | `done` 時的 D-09 第 (1) 層 |
| `src/call.ts`、`src/cli.ts`、`src/paths.ts` | `call -p`；`proposals review`／`list` |
| `src/memory-tidy.ts` | 提案區納入 tidy 與 undo；只有提案區的專案不 skip |
| `src/status.ts`、`src/doctor.ts` | 待審數量、最舊日期、格式檢查 |
| `docs/*`、spec 11 與 spec 25 | 中英文件與註記 |

## Interfaces

- `proposals.ts` 產出：`parseProposal(file)`、`listProposals(project)`、`checkDecisions(proposals, project)`（D-09 第 1 層，回傳違規清單）、`checkEvidence(proposal, root)`（第 2 層，回傳強弱證據）、`pendingProposals(project)`。
- Task 5（`mailbox`）與 Task 7（`review` post-check）都消費 `checkDecisions`；Task 4（prompt）、Task 8（doctor／status）消費 `listProposals`、`pendingProposals`、`checkEvidence`。
- Task 2（guard）消費 `proposalsDir`（Task 1）；Task 3（policy）與 Task 6（`call -p`）消費同一個 `proposalsDir`。

### Task 0：剩餘待確認項（只讀查證；結論回填 spec 30.9 與本節末尾，這是文件修改）

- [x] 0.1 `rebase()` 與前綴判定無關（已結案）；剩下：D-03 (b) 的「基準版本 status」如何從 guard 的 `readTree` 取得（在 Task 2 先讀程式再實作）。
- [x] 0.2 已結案：call id＝`newRunId()`。
- [x] 0.3 已結案：guard 不知道提案區，一般成員偵測本版不做（spec 30.8 #12）。
- [x] 0.4 `web/` 是否消費 `status --json` 的固定欄位（結案：不加欄位，見末尾 Task 0 結論）。
- [x] 0.5 「records 存在才處理」前提改成「records 或提案區存在」的最小改動，位置是 `memory-tidy.ts:326-331`、`:424`、`:437`（不是 `:299`）。
- [x] 0.6 `proposals review` 的 post-check 與回滾要重用 `tidyOne` 的哪些函式（含 `watched` 監看 `COMMON.md`，`memory-tidy.ts:336`）。

### Task 1：提案的路徑、解析與兩層檢查

**Files:** `src/policy.ts`、新 `src/proposals.ts`、新 `test/proposals.test.ts`

- [x] 1.1 先寫測試：frontmatter 解析（必填欄位含 `decided`〔accepted／rejected 時〕、`run`／`proposed_by` 與檔名前綴一致、`status` 三值、`evidence` 至少一項且格式合法、`repo` 規則、單檔 8 KB 上限）；`checkDecisions`（**`accepted` 才做完整檢查，`rejected` 只檢查 `reject_reason`／`decided`**，格式不符或超過 8 KB 的 `rejected` 不阻擋；`decided`／`date` 未加引號被 YAML 轉成 Date 時沿用 `records.ts:50-52` 的處理；`accepted` 缺 `accepted_as`、`accepted_as` 指向不存在的 record〔records `.archive/` 內的算存在〕、`rejected` 缺 `reject_reason`、缺 `decided`）；`checkEvidence`（`path:` 與 `commit:` 存在性與行號、帶 commit 與不帶的強弱證據、`repo` 不存在則弱證據、`mail:`／`output:` 只檢查格式）；不跟隨 symlink；id 字元集與短 id 前綴。
- [x] 1.2 實作 `proposalsDir`／`proposalsKindDir`（`src/policy.ts`）與 `proposals.ts` 的函式。
- [x] 1.3 驗收對應：9、11（列舉部分）、19。

### Task 2：修 guard 授權條件並監看提案區

**Files:** `src/guard.ts`、新 `test/guard-proposals.test.ts`（並確認既有 `test/guard-concurrent-runs.test.ts`、`test/project-write-scope.test.ts` 不因授權修正而失敗）

- [ ] 2.1 先寫測試（會先失敗）：solo run 寫 `records/lessons/x.md` 被還原並記違規；非 solo 的 lead 仍可寫；單一 live run 下：寫別人前綴的新檔或改既有、寫 `accepted`、基準已 `accepted`／`rejected` 的提案（含自己前綴、同 run id resume）被改動或改回 `proposed`，都被還原並記違規；自己前綴、基準 `proposed` 或不存在、結果仍 `proposed` 允許；有其他 live run 時走 `unattributed`；`proposals/lessons` 換成 symlink 時不跟隨、還原不寫到區外。**不測 tidy／review 喚醒**（它們不經 guard，移到 Task 7）。
- [ ] 2.1b 加測試：路徑限制（只有 `proposals/(lessons|decisions)/<短id>-<slug>.md` 可被 solo 新增或變更，`.archive/`、別人前綴、其他子目錄與**刪除**別人的提案違規）；自家檔 frontmatter 壞掉放行；**其他 run 在本 guard 基準之後啟動又結束，lead 的寫入不被還原**（`run --agent` 與 `call -p` 各一）；`otherLiveRuns` 每次 `check` 重取。
- [ ] 2.2 `authorized` 改為 `a.name === lead && !project.solo`（`guard.ts:159`）。
- [ ] 2.3 新增提案區監看（D-03 a–d，重用 `realDirs`／`isLink`；(b) 的基準 status 直接解析 `this.records` 的 Buffer）。**簽名：保留第二個位置參數 `otherLiveRuns`，新增第三個選用 opts `{ recordsRoot, proposalsRoot, shortId, violationsDir }`**，既有呼叫與 `guard-concurrent-runs.test.ts` 不改。「其他 run」＝當下存活者＋id 大於本基準 id 的 run（`run-store.ts:210`），且不計 `kind: "call"` 的鎖。
- [ ] 2.4 驗收對應：1（guard 半邊）、2、3、11。

### Task 3：write policy 放行提案區

**Files:** `src/policy.ts`、`src/config.ts`（`ResolvedProject.proposalsRef` 型別，只加型別不加行為）、`src/run-session.ts`（solo run 啟動時 `mkdir`）、`test/project-write-scope.test.ts`

- [ ] 3.1 先寫測試：solo agent 的 `allowDirs` 含提案區且不含 `recordsDir`；其他成員對提案區唯讀；lead 一般 run 可讀可寫；三種 runtime 的 `allowDirs` 都含提案區（目錄存在時）；`AgentEnforcement` 是否加 `proposals` 欄位的決定。
- [ ] 3.2 實作；solo run 啟動時 `mkdir -p proposals/`（在 `run-session.ts`，D-18），不改 `ensureProjectDirs`；`call -p`、`review` 的 `mkdir` 分別在 Task 6、7。`proposalsDir` 有 `proposalsRef` 時取它的路徑。
- [ ] 3.3 驗收對應：1、18（solo run 部分）。

### Task 4：prompt（solo、lead、call -p）

**Files:** `src/prompt.ts`、新 `test/prompt-proposals.test.ts`

- [ ] 4.1 先寫測試：`run --agent` 的 solo prompt 含 30.12 的提案規則與判準，且 records 區塊與現況位元組相同；**solo agent 的 prompt 不含「待審提示」**；lead prompt 顯示待審筆數、路徑、剩餘預算、最多 10 條，以筆數 > 0 為條件且帶 `!project.solo`；沒有任何提案或目錄為空時 lead 與一般成員的 prompt 位元組與現在相同。**`call` 與 `call -p` 的 prompt 測試移到 Task 6**（`-p` 解析在那裡）。
- [ ] 4.2 實作；逐字文字已在 spec 30.12，實作時以它為準：`{{prefix}}` 由 dispatcher 填字面短 id（`run --agent` 由 run-session 算），handoff 子句只在 `run --agent` 輸出。**提案規則段只在有 `proposalsRef` 或 `run --agent` 時輸出，使 `call` 無 `-p` 的 prompt 在 Task 4 到 6 之間不變**；`buildCallUserPrompt` 的簽名改動留到 Task 6。lead 待審提示條件寫成 `agent.name === project.lead && !project.solo`。
- [ ] 4.3 驗收對應：5（prompt 部分）、6、9（prompt 半邊：標「無可機械驗證的證據」）、10（`run --agent` 部分）、16。

### Task 5：`done` 時的決議完整性檢查

**Files:** `src/mailbox.ts`、mailbox 既有測試檔（先 `ls test | grep mailbox` 確認，沒有則新建 `test/mailbox-proposals.test.ts`）

- [ ] 5.1 先寫測試：一般 run 中存在 `accepted` 缺 `accepted_as`／`decided`、或 `rejected` 缺 `reject_reason`／`decided` 的提案時，lead 的 `done` 被退回並指出路徑；`proposed` 的待審提案不影響 `done`；證據不存在**不**擋 `done`；**`project.solo` 時同樣的提案不擋 `done`**。
- [ ] 5.2 在 `mailbox.ts:397` 同處呼叫 `checkDecisions`，以 `!project.solo` 為條件。
- [ ] 5.3 驗收對應：5、9（不擋 `done` 的部分）。

### Task 6：`call -p`

**Files:** `src/call.ts`、`src/cli.ts`、`src/paths.ts`、`src/config.ts`、`src/prompt.ts`（`buildCallUserPrompt` 加選用 project 參數）、既有 call 測試檔（先 `ls test | grep call` 確認）

- [ ] 6.1 先寫測試：無 `-p` 不可寫、prompt 無提案區、不取專案鎖；有 `-p` 可寫、prompt 含提案規則與既有 active records **標題清單**（不含內文）、取非 exclusive 專案鎖、guard 監看真實專案的 `recordsRoot`／`proposalsRoot` 且傳入 `otherLiveRuns`；**`call -p` 進行中另一個 run 的 lead 新增 record 或標 `accepted`，不被還原**；專案不存在 exit 非 0；`-p` 與 `--dir` 不同時的證據根目錄與 `repo:` 規則；`call -p` 進行中 `proposals review` 被 exclusive lock 拒絕；同 agent 第二個 call 被 `lockAgent` 擋、兩個不同 agent 各寫一條都保留。
- [ ] 6.2 實作：新 helper `resolveProjectRef`（`projectPaths` 是純函式，不在其中加檢查；helper 內檢查 `project.yaml` 並只讀 `dir`），不重用 `loadProject`；設 `proposalsRef`；取非 exclusive 專案鎖，**鎖檔寫 `kind: "call"`**（`project-lock.ts` 的 `readLockFile` 只驗 `token`／`pid`／`run_id`，多欄位可行；`listRunLocks` 的呼叫端排除 `kind: "call"`）；`call -p` 啟動時 `mkdir -p proposals/`（D-18）；`callAgent` 以 call id 算出 `shortId` 放進 `proposalsRef`，prompt 與 guard 共用；guard 傳 `otherLiveRuns`（每次重取，含 id 大於 call id 的 run）與 `violationsDir`；**`writeScopeRules`（`prompt.ts:128-137`）有 `proposalsRef` 時改用真實 `recordsRoot` 與 COMMON.md 路徑**。
- [ ] 6.3 驗收對應：4、7、10（`call -p` 部分）、18（`call -p` 部分）。

### Task 7：`proposals list` 與 `proposals review`

**Files:** `src/cli.ts`、`src/prompt.ts`、`src/memory-tidy.ts`（重用的函式）、既有 CLI 測試檔

- [ ] 7.0 **獨立的純重構 commit（先於 7.1）**：把 review 要重用的 `tidyOne` 部分（鎖、snapshot、restore、`watched`）抽成共用函式，行為不變、既有 tidy 測試全過。Task 9 在此之後做，避免兩者同改 `tidyOne` 而衝突。
- [ ] 7.1 先寫測試：`list` 前後專案檔案位元組不變；`review` 在同專案有活著的 run 或 `call -p` 時被拒；policy 覆寫的可寫範圍只有 `recordsDir` 與 `proposalsDir`；喚醒期間不經 guard；post-check（`checkDecisions`＋與 `done` 共用的 12 KB 預算檢查函式）未過或報告缺少時整批回滾（收下提案使 records 超過預算要被擋）；`review` 與一般 run 對同一批不合格提案結果相同（fake invoker）；收下流程：正式 record 含 `evidence`、`proposed_by`，提案檔 `accepted` 且有 `accepted_as`。
- [ ] 7.2 實作，依 Task 0.6 重用 7.0 抽出的共用函式；review 啟動時 `mkdir -p proposals/`；review 的回滾要監看 `COMMON.md`。
- [ ] 7.3 驗收對應：8、13、14、15、18（review 部分）。

### Task 8：status、doctor

**Files:** `src/status.ts`、`src/doctor.ts`、對應測試

- [ ] 8.1 `status`（僅人類輸出，**不動 `--json`**）、`doctor`、`proposals list` 顯示待審數量與最舊日期（**不**顯示 guard 的 `unattributed` 事件：本版沒有資料通路，列為已知限制，spec 30.3、30.8 #6）；`doctor` 對 `accepted_as` 指向不存在的 record 與格式不符的提案報警；依 Task 0.4 處理 `status --json` 欄位。
- [ ] 8.2 驗收對應：17、19（doctor 半邊：`accepted_as` 指向 records `.archive/` 的 record 不誤報）。

### Task 9：tidy 納入提案區

**Files:** `src/memory-tidy.ts`、`src/cli.ts`（`--undo` 輸出）、`src/prompt.ts`（tidy prompt）、`test/memory-tidy.test.ts`（先確認檔名存在）

**前置：Task 7.0 已完成。**

- [ ] 9.1 先寫測試：`status` 不是 `proposed` 且 **`decided` 超過 30 天**的提案被封存到 `proposals/.archive/<tidy-id>/`（提案日舊但剛決議的不封存），`proposed` 的不動；post-check 驗證沒有檔案消失、被封存的每一個符合規則、**未封存提案的 `fingerprint` 前後相同**；只有提案區的專案也被處理；`tidy --undo` 還原（`restoreMemory` 擴充）；`.archive/` 不進任何 prompt。
- [ ] 9.2 實作（依 Task 0.5，位置 `memory-tidy.ts:326-331`、`:424`、`:437`）。
- [ ] 9.3 驗收對應：12。

### Task 10：文件、註記與最後驗證

**Files:** `README*.md`、`docs/commands*.md`、`docs/how-it-works*.md`、`docs/write-scope*.md`、`docs/configuration*.md`、spec 11 與 spec 25 的註記、spec 30 狀態改為已實作

- [ ] 10.1 中英文件同步；說明 Task 2 的行為變更、多 run 並存時的已知限制（spec 30.8 #6）。
- [ ] 10.2 spec 11 決議 3、7 與 spec 25 受保護路徑加註「由 spec 30 修訂」。
- [ ] 10.3 **完整驗證一次**：`npm run typecheck`、`npm test`、`npm run lint`、`npm run check:docs` 通過；驗收 1–19 各有對應測試。
- [ ] 10.4 端到端（真實 `claude`／`codex` 會花 token，刻意手動）：`run --agent` 寫一條提案 → `proposals list` → `proposals review` 收下 → 下一次 run 的 lead prompt 看得到正式 record。

## Self-Review（決議與驗收對應 Task）

| 決議 | Task | 驗收 |
|---|---|---|
| D-01、D-02、D-18 | 1、3 | 1、18 |
| D-03 | 2、6 | 1、2、3、4、11 |
| D-04、D-05 | 6 | 4、7 |
| D-06、D-11、D-15、D-16、D-17 | 4 | 6、10、16 |
| D-07、D-09 | 1、5、7 | 5、9、15、19 |
| D-10 | 1、2、4、6 | 3、4 |
| D-12 | 9 | 12 |
| D-13、D-14 | 7 | 8、13、14、15 |
| `status`、`doctor` | 8 | 17、19 |

驗收 18 分散在 Task 3（solo run）、6（`call -p`）、7（review）；Task 順序依賴：4 不依賴 6（`call` prompt 測試在 6）；9 依賴 7.0。

風險：Task 2 的行為變更（中）、Task 6 的專案鎖改 spec 11（中）、提案區各 runtime 強制程度不同（中）。

## Task 0 結論

Task 0 全部結案（只讀查證，讀的是 `2e87449` 等同 `main` 的 `src/`；沒有跑測試）。

- **0.4 `web/` 與 `status --json`：** `web/src/types.ts` 的 `StatusReport` 是 `schema_version: 1` 的型別，WatchFrame 註明「unchanged, the web stream only wraps it」。`status.ts` 已有先例：`lastVerify`（`:380`）、`:649` 的分級模型都刻意「kept off the report so `status --json` is unchanged」。**決定：待審提案數與最舊日期只進 `status` 的人類輸出與 `doctor`，不加進 `status --json`**，不動 `schema_version`，`web/` 不受影響。
- **0.5 tidy 的 records 前提：** `tidyOne`（`memory-tidy.ts:318` 起）以 `recLive = withRecords ? liveRecordFiles(project) : []`、`recPart = recLive.length > 0`，兩者皆空就 `skipped`；`tidyMemory` 的 `withRecords` 也要求 `liveRecordFiles(...).length > 0`（`:424`）。最小改動：新增 `liveProposalFiles(project)`（同 `liveRecordFiles`，排除 `.archive/`，目錄不存在回空）；`withRecords`、`recPart` 改成「records 或提案區有檔」；`dirs`／`allowDirs` 加 `proposalsDir`（只在它存在時）；提案區自己一份 `recBefore`／`earlierArchives`／`recArchive`（`proposals/.archive/<stamp>/`）／`hasReport`／`verifyConservation`；`recordsContext` 增加提案條目。**注意：只有提案區時 `recordsDir` 可能不存在**，`snapshotDirs`、`allowDirs`、`describeRecords` 要容許缺目錄（`liveRecordFiles` 已用 `isPlainDir` 判斷）。
- **0.6 review 可重用的 `tidyOne` 部分：** `tidyWorkDir`、`snapshotDirs`／`restoreDirs`、`fingerprint`（含 `othersBefore` 比對）、`watched`（`commonFile`）、`hasReport`／`TIDY_REPORT_FILE`、`verifyConservation`、`policy` 組裝（`writePolicy` 的 `deny`＋`readDirs`）、`invoke` 與 `fail` 回滾。Task 7.0 要抽出的共用函式：`wakeWithRollback({ project, agent, dirs, allowDirs, prompts, watched, postCheck(problems) })`，內含 snapshot、policy、invoke、失敗與 post-check 回滾；`tidyOne` 與 `proposals review` 各自提供 prompt 與 `postCheck`。review 的 `allowDirs` ＝ `[recordsDir, proposalsDir]`。
- **0.1 剩餘項：** guard 的 `this.records` 是 `Map<string, Buffer>`，(b) 的基準 status 在 Task 2 直接解析 Buffer，不需另做基準。
