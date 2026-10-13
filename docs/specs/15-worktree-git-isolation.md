# 15 dispatcher 不信任 agent 可寫的 git 狀態

狀態：設計已與使用者確認（2026-10-13 授權另開分支修補），尚未實作。

## 15.1 問題

agent 的沙箱允許寫它自己的 worktree（含根目錄的 `.git` 指標檔），以及 `<repo>/.git/worktrees/<agent>`（它的 per-worktree git 目錄，`policy.ts` 的 `allowDirs`；Claude `allowWrite`、Codex `writable_roots`）。這兩處決定 git 如何找到「共用 git 目錄」與設定：

- 改寫 `<gitDir>/commondir`，或把 `<root>/.git` 改成 `gitdir: <假目錄>`，git 就會去讀 agent 自己造的 common dir：它的 `config`、`hooks/`、`info/attributes`。
- 那份設定可以放 `core.fsmonitor`、`core.hooksPath`、`core.sshCommand`、`credential.helper`、`diff.external`、`remote.*.url`；`hooks/` 可以放 `post-commit`、`pre-push` 等。`--no-verify` 只略過 pre-commit／commit-msg，擋不住 `post-commit` 與 `core.fsmonitor`。
- 若使用者開了 `extensions.worktreeConfig`，`<gitDir>/config.worktree`（agent 可寫）也會被讀。

dispatcher 在沙箱外、用使用者的憑證，以那個 worktree 為 cwd 執行 git（`git add -A`、`commit`、`diff`、`status`、`reset`、`apply`…）時，就會執行 agent 埋的程式碼。已用真實 git 在拋棄式 repo 重現（spec 14 最終 review）。

受影響且已在 `main`：`commitWorkspace`（`finishLead`，spec 07）、`collectAgentChanges` 與 `integrateAgentChanges`（成員 worktree，並行模式早已存在）、`inspectWorkspace`、`finishLeadBranch`、`prepareAgentWorkspace`（重用既有 worktree 時的 `status`／`reset`）、以及併發模式下以 lead 的 worktree 為目標或來源的 `snapshotBase(from)`／`integrateAgentChanges(target)`／`inspectWorkspace(target)`（連 `toplevel(from)` 都是向 agent 目錄查詢）。spec 14 的 PR 步驟已改成從主 repo 執行，不在此列。

## 15.2 決議

| # | 決議 |
|---|---|
| 1 | dispatcher 對 agent worktree 的**每一次** git 呼叫都經過同一個入口 `agentGit(ws, args, env?)`，不再用 `cwd: <agent 目錄>` 讓 git 自己探索。 |
| 2 | `agentGit` 釘住：`GIT_DIR=<ws.gitDir>`、`GIT_COMMON_DIR=<ws.commonDir>`、`GIT_WORK_TREE=<ws.root>`，並加 `-c core.fsmonitor=false -c core.hooksPath=/dev/null`，diff 類指令加 `--no-ext-diff --no-textconv`。`.git` 指標檔與 `commondir` 檔因此不再被讀。 |
| 3 | `gitDir` 與 `commonDir` 在 worktree **剛建立、agent 還沒碰過它之前**取得並存進 `${root}.json` meta（該檔在 worktree 旁邊，不在 agent 的可寫範圍）；之後只讀 meta，絕不再向 worktree 詢問。`commonDir` 取自使用者 repo（`project.dir`）的 `git rev-parse --path-format=absolute --git-common-dir`。 |
| 4 | 舊版建立、meta 沒有這兩個欄位的 worktree：`commonDir` 從 `project.dir` 取得；`gitDir` 在 `<commonDir>/worktrees/*/gitdir` 中找內容等於 `<root>/.git` 的那一個，**必須剛好一個符合**，否則拒絕使用並說明（不猜）。 |
| 5 | 以 worktree 為「目標」或「來源」的函式不再收字串路徑，改收 `AgentWorkspace`：`snapshotBase(project, runId, n, from?: AgentWorkspace)`、`integrateAgentChanges(project, changes, target?: AgentWorkspace)`、`inspectWorkspace(project, runId, agent, target?: AgentWorkspace)`、`commitWorkspace(ws, message)`。不再對 agent 目錄呼叫 `toplevel()`。 |
| 6 | 縱深防禦（只對能表達「禁止單一檔案」的 runtime，即 Claude）：`denyWrite` 加上 `<root>/.git`、`<gitDir>/commondir`、`<gitDir>/config.worktree`、`<gitDir>/gitdir`。Codex 做不到，靠決議 1–5。不為此改變 agent 本來能做的事（agent 本來就不能寫共用 objects，無法在 worktree 內 commit）。 |
| 7 | 行為不變：沒有 agent worktree 的 run（預設 `max_concurrent_runs: 1` 且 `max_parallel: 1`）完全不經過 `agentGit`；既有測試除了簽名改動外不改期望值。 |
| 8 | 不改使用者 repo 的呼叫（`git(top, …)`、`snapshotHead`、`worktree add/remove`）：那是使用者自己的 repo，agent 寫不進去。 |
| 9 | （實作時用真實 git 驗證後補）只釘環境變數不夠：git 的 ref store 仍會跟著 `<gitDir>/commondir` 走；`-c` 擋不住 `config.worktree` 裡的 filter driver 與 `gpg.program`；`git commit` 會透過符號連結寫 `COMMIT_EDITMSG`、`logs/HEAD`。所以 `agentGit` 之前先做 `assertWorkspaceIntact`，發現被動過就**拒絕使用該 worktree**，不試圖讓 git 安全處理：`commondir` 被改向、`config.worktree` 與建立當下的指紋不同、`COMMIT_EDITMSG`／`logs/HEAD` 是連結、worktree 根或 git dir 被換成符號連結。`git apply` 需要 cwd 在 work tree 內，因此 `agentGit` 的 cwd 是 `ws.root`，同時保留三個環境變數。 |
| 10 | （同上）內嵌的 git repo 會讓 `git add -A` 去執行它自己的設定：拒絕含未追蹤內嵌 repo 的 worktree（`git ls-files -o --exclude-standard -z` 出現以 `/` 結尾的項目），也拒絕 index 中不在 base commit 裡的 gitlink（agent 可改寫 index）；使用者 repo 本來就有的 submodule（base 內的 gitlink）照常運作。拒絕的結果走既有路徑：成員的整合被擋下並回報（blocked integration），lead 的結尾提交只留下說明、工作留在 worktree。 |

## 15.3 影響的檔案

- `src/worktree.ts`：`AgentWorkspace.commonDir`、`WorkspaceMeta` 擴充、`agentGit`、所有對 agent 目錄的 git 呼叫改走它、簽名改動、舊 meta 的 fallback。
- `src/run-session.ts`、`src/run-cleanup.ts`：傳 `AgentWorkspace` 而不是 `.root`。
- `src/policy.ts`：決議 6 的 deny 項。
- `test/worktree.test.ts`、`test/integration.test.ts`、`test/run-cleanup.test.ts`：簽名調整＋新的真實 git 回歸測試。
- `README.md`、`README.zh-TW.md`：「已知缺口」段落更新（把 worktree 這項從缺口改成說明）。

## 15.4 驗收（先寫失敗測試）

用真實 git、本地 bare remote，不用網路。對每個攻擊變體都有**對照組**（沒有釘住時，標記檔會出現），證明測試不是空的：

1. `<gitDir>/commondir` 改指向含 `config`（`core.fsmonitor=<寫標記檔的腳本>`）與 `hooks/post-commit` 的假目錄。
2. `<root>/.git` 改成 `gitdir: <假目錄>`。
3. 使用者 repo 開 `extensions.worktreeConfig`，agent 在 `<gitDir>/config.worktree` 放 `core.fsmonitor`／`core.hooksPath`。
4. `diff.external` 設在假設定裡。

對下列函式各自斷言「標記檔不存在，且功能結果正確」：`commitWorkspace`、`collectAgentChanges`、`inspectWorkspace`、`finishLeadBranch`、`prepareAgentWorkspace`（既有 worktree 的 status／reset）、`integrateAgentChanges(target = lead 的 workspace)`、`snapshotBase(from = lead 的 workspace)`。另測：meta 記了 `gitDir`／`commonDir`；舊 meta 的 fallback（剛好一個符合才用，0 或 2 個就拒絕）；`policy` 對 Claude 產生決議 6 的 deny、Codex 不產生；預設路徑（無 worktree）不經 `agentGit`。

5. 內嵌 repo（變體 E）：放在 worktree 內的未追蹤內嵌 repo，其設定裡的程式在 `commitWorkspace`、`collectAgentChanges`、`finishLeadBranch` 都不會執行，且該 worktree 被拒絕並回報；index 中偽造的 gitlink 同樣被拒絕；base commit 內本來就有的 gitlink 被接受。
6. 竄改偵測（決議 9）：`commondir` 被改向、`config.worktree` 被改、`COMMIT_EDITMSG`／`logs/HEAD` 被換成連結，各自讓 worktree 被拒絕。
7. 拒絕的呈現：成員 → 既有的 blocked integration 路徑（訊息說明原因與位置）；lead → `finishLead` 的 note，工作留在 worktree，run 的結果不變。

## 15.5 範圍外

- 使用者自己 repo 裡的 hook／設定被 agent 污染（agent 寫不進去）。
- 沙箱本身的繞過（Claude／Codex 的 runtime 行為）。
- 阻止 agent 在自己的 worktree 裡放惡意檔案內容（那只是資料，由使用者在 merge 前審查）。
