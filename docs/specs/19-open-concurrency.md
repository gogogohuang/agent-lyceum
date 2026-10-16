# 19 零設定的並行

狀態：設計（task 565edb）。

## 19.1 問題

- 使用者（565edb）：「現在跑 concurrent 設定太繁複，不應該要設定 own。直接開放就好，其他設定都取消」。
- 目前要並行得同時設 `max_parallel > 1`、每個成員互不重疊的 `owns`、可能還有 `max_concurrent_runs`、`workspace_mode`；`validate` 會因 `owns` 重疊、工作區有未 commit 修改、`workspace_mode: shared` 搭配並行而拒跑。
- 實際隔離早已由 git worktree 與整合檢查（`integrateAgentChanges` 拒收「agent 起跑後 repo 裡又被改過」的檔案並通知 lead）負責；`owns` 只是額外的預先切分。

## 19.2 決議

| # | 決議 |
|---|---|
| 1 | 移除使用者可設定的 `agents.<name>.owns`、`dispatcher.max_parallel`、`dispatcher.max_concurrent_runs`、`dispatcher.workspace_mode`。 |
| 2 | 新 run 啟動前探測 `project.dir`：是 git repo、有至少一個 commit、ref storage 不是 reftable ⇒「隔離模式」：等同今天 `max_concurrent_runs > 1`（lead 在自己的 worktree、從 HEAD snapshot 起跑、結果落在自己的 branch），每個非 lead 成員有自己的 worktree，所有有待讀 mail 的非 lead 成員同一批平行喚醒，不設上限；lead 仍不與成員同批（沿用）。 |
| 3 | 探測不通過 ⇒「共用模式」：今天的 sequential shared（一次一個 agent，直接在 checkout 裡做）。不報錯；run 開始時印一行、doctor 給 `info`。 |
| 4 | 同一專案的 run 數不設上限，但「在 checkout 裡做事」的 run（共用模式、或舊的 lead 不在 worktree 的 run）同時只能一個，因為它們寫同一份檔案。見 19.4。 |
| 5 | 衝突只靠整合檢查：不再有 `owns`，`collectAgentChanges` 不再收 owns 參數；同一檔被兩個成員改，後整合者被拒、工作留在其 branch、lead 收到 `failure` mail（現行機制）。 |
| 6 | 舊設定照樣載入：四個鍵被接受但忽略，`validate` 給一條 `warn`（19.5）。舊 run 依 `state.json` 記錄的模式續跑，不看現在的探測結果。 |
| 7 | `status --json` 形狀不變：`workspace_mode` 仍來自 run state（新 run 為 `"worktree"` 或 `"shared"`）。 |
| 8 | `--exclusive` 鎖保留（`clear --tidy-memory`／restore 仍需獨占專案）；`takeLock` 的 `ignoreLimit` 選項移除（不再有上限可略過）。checkout run 的鎖另帶 `exclusive: true`，讓舊 binary 也不會再開第二個 checkout run（19.4）。 |

## 19.3 解析後行為

新 run（含 `run --agent` 單獨 agent）：

| `project.dir` 狀態 | 模式 | lead | 成員 | 同時 run 數 | 提示 |
|---|---|---|---|---|---|
| git、有 commit、files refs、乾淨 | 隔離 | 自己的 worktree，從 HEAD，結果在 branch | 各自 worktree，全部平行 | 不限 | 無 |
| 同上但有未 commit 修改 | 隔離 | 同上；未 commit 修改不進 run、不被碰 | 同上 | 不限 | 開始行沿用「your N uncommitted file(s) are not part of this run」；doctor `info` |
| git、沒有 commit | 共用 | checkout | checkout，一次一個 | 1 個共用 run（可與隔離 run 並存，但此狀態不會有隔離 run） | `info`：`no commit yet` |
| git、reftable | 共用 | 同上 | 同上 | 同上 | `info`：`reftable ref storage` |
| 不是 git repo | 共用 | 同上 | 同上 | 同上 | `info`：`not a git repository` |

續跑（`run` 接已存在的 run）：

| state.json | 行為 |
|---|---|
| `lead_workspace: true` | 隔離模式（lead 回到自己的 worktree），與今天相同 |
| 無 `lead_workspace`，`workspace_mode: "worktree"`（舊 `max_parallel > 1` run） | lead 在 checkout、成員 worktree、成員全部平行（不再看 owns）；鎖視為 checkout run |
| 無 `lead_workspace`，`workspace_mode` 為 `"shared"` 或缺 | 共用模式 |

續跑時 repo 變成非 git／reftable：`assertWorktreeRunnable` 照舊拒絕（訊息改寫，不再提已移除的鍵）。

`call`：不經 RunSession，永遠在當前目錄做事，行為不變；只刪 `callProject` 裡的 dispatcher 覆寫。

開始行（共用模式，`say`）：`  agents take turns in <dir> (no separate git worktrees: <reason>); commit to a git repo to run them in parallel`

## 19.4 run 鎖

- `LockOptions.maxConcurrent` 移除，新增 `checkout?: boolean`：此 run 直接寫 `project.dir`。`LockInfo` 新增 `checkout?: boolean`；新版一律寫出 `true` 或 `false`。
- **checkout run 的鎖同時寫 `checkout: true` 與 `exclusive: true`**。理由：舊 binary（v0.12.0 起，`src/project-lock.ts` L285）只要看到任何活的 `exclusive` 鎖就拒絕取得任何鎖，不看自己的 `max_concurrent_runs`；所以即使舊版 project.yaml 還寫著 `max_concurrent_runs: 2`，舊 binary 也無法在新 binary 的 checkout run 進行中再續跑／開一個共用 run。`.admit` 互斥從 v0.12.0 起相同，兩版的判斷不會交錯。
- 鎖的分類（新版，`lockKind(l)`，純函式）：`exclusive && checkout === true` ⇒ `checkout`；`exclusive`（其他，含舊 tidy 鎖）⇒ `whole`（tidy／restore）；`checkout === false` ⇒ `worktree`；沒有 `checkout` 欄位的非 exclusive 鎖（舊版 run）與 `lock.json` ⇒ `checkout`（保守）。
- 取得鎖時（`withAdmission` 內）：同 run 已活 ⇒ `heldError`；有活的 `whole` ⇒ `exclusiveError`；自己 `whole`（`exclusive` 且非 checkout）且有任何活鎖 ⇒ `needsIdleError`；自己 checkout 且有任一活鎖為 `checkout` ⇒ `checkoutBusyError`；其餘放行（`worktree` 與一個 `checkout` 可並存）。`limitError` 刪除。
- `checkoutBusyError` 文字：`Run <id> (pid <n>) is working directly in <dir>, and this run would too (<reason>), so only one can be active. Wait for it to end or stop it; in a git repo with a commit, runs work in their own worktrees and can run side by side.`
- 模式要在拿鎖前決定：`cli.ts` 先呼叫 `planWorkspace`（19.6），把 `checkout: !plan.leadWorktree` 傳給 `takeLock`，再把 plan 傳給 `runTeam`，RunSession 不重算（避免兩次探測結果不同）。續跑同樣先由 state 決定（19.3 續跑表）。`clear` 拿 `checkout: false`、非 exclusive 的鎖。
- 新版 tidy／restore 對 checkout 鎖：自己是 `whole` ⇒ `needsIdleError`（與今天相同）；checkout run 遇到進行中的 tidy ⇒ `exclusiveError`（相同）。沒有其他程式讀 `exclusive`（`status`／`doctor`／plugin 皆不讀，已 grep）。

舊 binary 與新 binary 同時用同一專案，保證如下：

| 舊 binary 版本 | 新 binary 持有 | 舊 binary 想做 | 結果 |
|---|---|---|---|
| ≥ 0.12.0 | checkout 鎖（`exclusive+checkout`） | 開／續跑任何 run、`clear`、tidy | 被拒：`<id> (pid <n>) needs the project to itself (a memory tidy or restore); wait for it to finish, then try again.`（原因字樣不準，但安全；README 升級段說明） |
| ≥ 0.12.0 | 只有 worktree 鎖 | 開／續跑 run | 依舊版 `max_concurrent_runs` 計數（預設 1 ⇒ 拒）；若放行且是共用 run，其鎖無 `checkout` 欄，新 binary 之後的 checkout run 被 `checkoutBusyError` 擋 |
| < 0.12.0 | 任何 | 任何 | 只看 `lock.json`、不看 `locks/`，今天 0.12+ 與它就不互相協調；不在此保證內，README 升級段要求先停掉舊版 run 再升級 |

即（保證範圍僅限有新版鎖參與的互斥）：兩邊都是 ≥ 0.12.0 時，新 binary 的 checkout run 進行中，舊 binary 完全不能啟動；新 binary 也不會在任何舊版 run（無 `checkout` 欄）活著時再開 checkout run。**不保證**舊 binary 彼此之間：舊版依自己的 `max_concurrent_runs` 放行，若舊設定 > 1，舊 binary 仍可同時續跑兩個無 `lead_workspace` 的舊共用 run（例如旁邊只有新 worktree 鎖時），兩者同寫 checkout。這是舊版既有缺口，新鎖協定無法修補已發行的舊 binary。升級要求（README 升級段）：混用期間舊 binary 的 checkout（共用）run 至多一個，最好先停掉所有舊版 run 再升級；凍結 fixture 測試同時涵蓋此負向案例（舊版在只有 worktree 鎖時放行兩個舊 run），作為文件化的已知限制。

## 19.5 舊設定相容

- `schema.ts`：四個鍵改為 `z.unknown().optional()`（任何舊值都不讓載入失敗），保留 `.strict()` 擋其他未知鍵。
- `config.ts`：讀 global 與 project 後，收集出現的已移除鍵（完整路徑，如 `dispatcher.max_parallel`、`agents.web.owns`）與所在檔案，寫入 `ResolvedProject.ignoredSettings?: { file: string; keys: string[] }[]`；這些值不進 `DispatcherSettings`／`ResolvedAgent`。`AGENT_FIELDS` 與設定來源表（`config.ts` L273、L327）刪 `owns`。
- `validate.ts`：每個檔一條 `warn`，訊息固定為：
  `<file>: ignoring removed setting(s) <keys, comma-separated>. Concurrency needs no configuration now: in a git repo with a commit every run and every agent gets its own worktree. Delete these lines.`
- 因為 `run`／`doctor`／tidy 都已把 validate 的 issues 印到 stderr，不另外印，避免重複；`strict: true` 不會把 warn 升級（現行 L106 只檢查強制層級），不阻擋。

## 19.6 檔案與函式

| 檔案 | 變更 |
|---|---|
| `src/schema.ts` | 19.5；`DispatcherSettings`、`DISPATCHER_DEFAULTS` 刪 `max_parallel`、`max_concurrent_runs`、`workspace_mode`。 |
| `src/config.ts` | `ResolvedAgent.owns` 刪除；`ignoredSettings`；`pick("owns")` 等刪除。 |
| `src/worktree.ts` | `resolveWorkspaceMode` 刪除。新增 `isolationBlocker(dir): string \| undefined`（`not a git repository`／`no commit yet`／`reftable ref storage`）與 `planWorkspace(project, resume?: RunState): { mode: WorkspaceMode; leadWorktree: boolean; reason?: string }`（純判斷，19.3 兩表）。`assertWorktreeRunnable(project)` 只留 git／reftable 檢查（續跑用），刪 `fresh`／`concurrent` 參數與乾淨工作區檢查，訊息不提設定鍵。`collectAgentChanges(workspace)` 刪 owns 參數與兩條 owns violation；`globMatch` 只供 owns 使用，刪除；`paths.ts` 的 `globStaticPrefix` 只供 `ownsDirs` 使用，一併刪除。 |
| `src/run-session.ts` | L150-151 改用傳入的 plan（`concurrent = plan.leadWorktree`、`wsMode = plan.mode`），共用模式且有 reason 時印開始行；`state.lead_workspace` 照舊寫。`pickBatch`：有 lead ⇒ `[lead]`；`wsMode !== "worktree"` ⇒ `[pending[0]]`；否則回傳全部 pending（刪 `ownsDirs` 與 max 判斷）。L461 不傳 owns。L727 skip 文字改為 `this run works directly in <dir> (not a git repo with a commit), so there is no branch to push.` |
| `src/project-lock.ts` | 19.4。 |
| `src/cli.ts` | `takeLock(pr, runId, { checkout?, exclusive? })`；`run` 新／續跑都先 `planWorkspace`；L484 `clear` 改傳 `checkout: false`。 |
| `src/policy.ts` | `AgentEnforcement.owns`、`AgentPolicy.owns`、`restrictRepoToOwns`、`ownsDirs` 刪除。 |
| `src/adapters/claude.ts` | L32 owns 的 `Edit` allow 規則刪除（成員在自己的 worktree 可改任何檔，仍受保護檔與專案目錄檢查）。檢查 `adapters/codex.ts` 無對應。 |
| `src/validate.ts` | 刪 L65-96（owns 重疊、max_concurrent_runs/workspace_mode/git 組合錯誤）；強制層級表刪 `owns` 欄；加 19.5 warn。 |
| `src/prompt.ts` | 刪 L224-225 owns 那行；L129 worktree 說明保留。 |
| `src/doctor.ts` | L157-186：`isolationBlocker` 有值 ⇒ `info`：`Runs work directly in <dir>, one agent at a time (<reason>).`；否則有未 commit 修改 ⇒ `info`（現行 concurrent 文字）、乾淨 ⇒ `ok`：`git repo with a commit: runs and agents work in their own worktrees.`；PR 前置檢查條件改為「無 blocker」。 |
| `src/status.ts` | 不改；JSON 欄位 `workspace_mode` 仍讀 state。 |
| `src/solo.ts` | 刪 `max_parallel`／`workspace_mode` 覆寫與 `owns: []`；單獨 agent 照 19.3 探測。 |
| `src/call.ts` | 刪 `owns: []` 與 dispatcher 覆寫（只用 `DISPATCHER_DEFAULTS`）。 |
| `src/scaffold.ts`、`src/demo.ts` | 樣板刪 L98-100 三行與 `# owns:` 註解；`demo.ts` L95 的 owns 替換刪除。 |
| `src/run-store.ts` | 不改格式；L88 註解改為「run 開始時 lead 有自己的 worktree（隔離模式）」。 |

## 19.7 測試（qa／node-engineer）

刪除：`validate.test.ts`「accepts max_concurrent_runs > 1 in a git repo」「rejects … workspace_mode shared」「rejects … not a git repository」「defaults max_concurrent_runs to 1」「max_parallel > 1 requires disjoint owns」；`worktree.test.ts`「uses worktrees when agents can run in parallel, or when asked to」「refuses shared workspaces together with parallel agents」「refuses to start a parallel run while the repo has uncommitted changes」；`integration.test.ts`「flags edits outside owns…」「handles **, *, ? and braces like the owns globs」（若 `globMatch` 刪除）；`adapters.test.ts`「restricts repo edits to owned globs…」；`project-lock.test.ts`「lets two different runs hold a lock when the limit is 2…」；`run-lifecycle.test.ts`「with max_concurrent_runs: 2 a second run is admitted…」。

改寫：`dispatcher.test.ts`「runs disjoint-owns agents in parallel…」→「wakes every pending member in parallel, never alongside the lead」；`run-lifecycle.test.ts`「refuses to start a second run … max_concurrent_runs is 1」→ 非 git 專案第二個 run 被 `checkoutBusyError` 拒；「clear of a finished run … (limit 1)」去掉 limit；`integration.test.ts` L437／L465 改為「old run state 決定續跑模式，與現在探測無關」；L490 改為「a solo run in a git repo works in its own worktree」；L757 改為非 git 專案的 skip 文字；`integration.test.ts` L104「without owns…」改名；`worktree.test.ts` L156 改為「falls back to shared in a folder that is not a git repository」；`worktree-isolation.test.ts` L708 改為只測續跑時被拒；`doctor.test.ts` L110；`demo.test.ts`、`config.test.ts`、`status.test.ts`、`solo.test.ts`、`memory-tidy-cli.test.ts`、`test/helpers.ts`、`test/fixtures/lock-holder.ts` 移除這些鍵的使用。

新增：
- `planWorkspace`：19.3 每列（不是 git／無 commit／reftable／dirty／乾淨）＋三種舊 state。
- `config.test.ts`「ignores removed settings with one warning per file」：fixture 為 project.yaml 含 `dispatcher.max_parallel`、`dispatcher.max_concurrent_runs`、`dispatcher.workspace_mode` 與 `agents.<a>.owns`；global config 只含舊的 `agents.<a>.owns`（global 本來就沒有 dispatcher，**不**為 GlobalConfig 加 dispatcher 支援）。斷言：載入成功、值不進結果、validate 每檔一條 warn 且文字如 19.5、`strict: true` 下 `ok` 仍為 true。
- `config.test.ts`「still rejects an unknown key」：project.yaml `dispatcher.max_paralel`（拼錯）與 global `agents.<a>.foo` 仍載入失敗（`.strict()` 保留）。
- `project-lock.test.ts`：
  - 「a checkout lock is written with exclusive and checkout」（檔案內容兩欄皆 `true`）。
  - 「two checkout runs: the second is refused, in either order」：A 先 B 後、B 先 A 後各一次，第二個都是 `checkoutBusyError`。
  - 「worktree runs run beside each other and beside one checkout run」；「a checkout run is refused by an old run lock without checkout and by lock.json」。
  - 「tidy is refused while a checkout run is active, and a checkout run is refused while tidy is active」；「clear's lock is admitted beside a checkout run」。
- `project-lock.test.ts`「an old binary cannot admit a second checkout run（mixed versions）」：用 `git show 0c1516e:src/project-lock.ts`（0.17.3，repo 沒有 tag）存為 `test/fixtures/lock-v0.17.3.ts`（凍結、不再改；只把 `./fs-util.js` import 改為 `../../src/fs-util.js`），新版以 checkout 取得 A 的鎖後，以舊版 `acquireProjectLock(root, "B", { maxConcurrent: 2 })` 取鎖 ⇒ 丟出含 `needs the project to itself` 的錯誤、沒有 `locks/B.json`；反向：舊版先持有 B（無 `checkout` 欄）⇒ 新版 checkout 續跑 A 被 `checkoutBusyError` 拒。
- `run-lifecycle.test.ts`「resuming a legacy shared run is refused while another legacy shared run is active」：兩個舊 `state.json`（無 `lead_workspace`、`workspace_mode: "shared"`），project.yaml 仍寫 `max_concurrent_runs: 2`；第一個經 `run` 續跑中，第二個 `run` 續跑以 `checkoutBusyError` 結束、未喚醒任何 agent。
- `dispatcher.test.ts`「wakes 3 members whose old owns overlapped all at once」：project.yaml 給 3 個成員相同的舊 `owns`、同時各有待讀 mail；用假 adapter 記錄每次 invocation 的開始／結束時間，斷言同一批 3 個、時間區間兩兩重疊、lead 不在其中。
- `integration.test.ts`「a same-file conflict refuses the later member and keeps its branch」：兩成員同批改同一檔；斷言後整合者的修改不在 run branch、其 worktree 與 branch 仍在、lead 收到一封 `failure` mail 點名該檔。
- 共用模式 run 開始行出現且 run 正常完成。
- `status --json` 快照：隔離與共用各一，欄位集合與現在相同。

## 19.8 文件（docs-writer，中英成對）

`README.md`／`README.zh-TW.md`、`docs/configuration*.md`、`docs/commands*.md`、`docs/how-it-works*.md`、`docs/upgrading-run-v2.md`：刪四個鍵與 `owns` 說明，改寫並行段落為 19.3 表格的說法；加一段「升級：舊鍵會被忽略並警告，請刪除；先停掉舊版的 run；新版 run 在 checkout 裡做事時，舊版會說它『needs the project to itself』」；強調單一 run 預設結果在 branch（`git merge <branch>` 或 `open_pr`）。`docs/specs/README.md` 索引加 19。舊 spec／plan（07、11、14、15、16）是歷史紀錄，不改。

## 19.9 不採用的方案

- 保留 `max_parallel` 當選填上限（預設不限）：使用者要求「其他設定都取消」；團隊人數本身就是上限，且不設定的人用不到。若日後真的撞 rate limit，再以環境變數加入，不回到 project.yaml。
- 共用模式也允許多個 run：兩個 run 寫同一 checkout 會互相覆蓋、guard 互相還原，結果不可預期；所以保留 checkout 一次一個（19.4）。
- 由 config 自動推導 `owns`（依 agent 名稱或過去改過的路徑）：猜錯會拒收正確工作，整合檢查已在檔案層級擋衝突。
- 共用模式報錯要求使用者初始化 git：違反「直接開放」與 lead 決議 4。
- checkout 鎖只寫 `checkout: true`、並在文件裡說明舊版風險：舊 binary 不認得此欄，`max_concurrent_runs ≥ 2` 時會再開一個共用 run（review 438160a4 實測），只能靠使用者自律。
- 鎖檔加版本號或改放另一個目錄：舊 binary 看不到或判為 unreadable，前者讓它照樣放行（更不安全），後者讓舊版所有 run 卡住要 `--force`；`exclusive` 是舊版已懂的唯一拒絕訊號。

## 19.10 風險

- **單一 run 預設結果不再寫進工作區**：以前預設 run 直接改你的 checkout；現在在 git repo 裡結果落在 `agent-lyceum/<run>/…` branch，看不到使用者未 commit 的修改。緩解：開始行已說明 branch 與「N 個未 commit 檔不在此 run」，結束時印 `result_branch`（現行）；README 升級段明講。接受此行為改變（使用者要的就是預設可並行，而並行的前提就是 branch）。
- **無上限平行喚醒（成本／rate limit）**：一批最多 = 有待讀 mail 的非 lead 成員數（受 team.yaml 人數限制，lead 永不同批）；被 rate limit 的 wake 走既有 `retry`。明確接受，不加隱藏上限。
- **語意衝突**：兩成員改不同檔但彼此不相容，整合檢查擋不到；以前 `owns` 也擋不到。由 lead 審查與 qa 承擔，接受。
- **未 commit 修改**：使用者若期待 run 接續其未 commit 的工作會落空；doctor `info` 與開始行提示。
- **新舊 binary 並用**：保證範圍見 19.4 表：僅保證有新版鎖參與的互斥（兩邊 ≥ 0.12.0）；舊 binary 彼此之間的 checkout 互斥不保證，升級期間舊版共用 run 至多一個。代價：新 checkout run 進行中，舊 binary 連 worktree run 與 `clear` 都不能做，且錯誤訊息說是「memory tidy or restore」。接受：保守、短暫（升級期間），README 升級段說明。

## 19.11 分工

- node-engineer：19.4–19.6 全部程式與 19.7 測試。
- qa：19.7 新增項目，加上真實 scratch repo 端到端：非 git、無 commit、dirty git 三種各跑一次 `run`，與兩個 run 同時跑。
- docs-writer：19.8。
