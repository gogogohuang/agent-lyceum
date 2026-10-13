# 14 run 結束時由 dispatcher 開 PR

狀態：已實作（計畫：docs/plans/2026-10-13-14-open-pr.md）。

## 14.1 問題

- agent 在沙箱內只能改 workspace（`src/adapters/claude.ts` 的 `allowUnsandboxedCommands: false`；`src/prompt.ts` 禁止 worktree agent commit／push）。`git push`、`gh pr create` 需要網路、`.git`、`gh` 憑證，沙箱內做不到，也不該為此放寬。
- 目前 run 結束後使用者要自己 commit、push、開 PR。

## 14.2 決議

| # | 決議 |
|---|---|
| 1 | agent 的沙箱與「禁止 commit／push」規則不變（prompt 只多一條 `open_pr` 說明，見 2）。PR 由 dispatcher 在沙箱外、run 結束時開。 |
| 2 | 沒有旗標，也不改 `project.yaml`。是否開 PR 直接依使用者輸入的 task 內容：lead（或 `run --agent` 的單獨 agent）讀 task，task 要求開 PR（例如「做完開 PR」「open a PR」）時，在 `done` 的 frontmatter 加 `open_pr: true`；task 沒提就不寫，行為與現在相同。dispatcher 只認這個欄位，不解析 task 文字。prompt 的 `done` 說明加一條規則：「只有 task 明確要求開 PR 時才寫 `open_pr: true`，不要自行決定」。 |
| 3 | 只在 `open_pr: true` 且 `outcome` 為 `completed` 時開。`open_pr: true` 但 outcome 不是 `completed`、或 run 以 `partial`／`failed`／`cancelled`／`waiting` 結束，都不開，結果訊息說明原因；工作照舊保留。`doneContract` 對 `open_pr` 只做讀取，值不是 `true` 一律視為沒要求。 |
| 4 | 流程：在 `agent-lyceum/<run-id>` 分支提交（身分 `agent-lyceum <agent-lyceum@localhost>`，訊息含 run id 與任務摘要）→ `git push -u origin` → `gh pr create --base <repo 預設分支>`。標題取任務摘要。 |
| 5 | PR 描述：lead 的完成報告摘要，結尾一行 `🤖 Opened by agent-lyceum`。描述除了 lead 的報告原文與這一行署名，不含 dispatcher 自己加的任何 agent 或角色名稱。 |
| 6 | 不碰使用者目前的 working tree 與分支：提交在 run 自己的 worktree／分支上完成。需要 git repo、`origin` 與已登入的 `gh`。因為是否開 PR 要到 `done` 才知道，run 開始時不能預檢；改為 `doctor` 檢查並提示，真正缺少時在開 PR 那一步失敗，依決議 7 處理（分支保留、印手動指令）。 |
| 7 | 推送或 `gh` 失敗不改變 run 的 `outcome`：分支與 commit 保留，結果訊息印出可手動執行的 `git push` 與 `gh pr create` 指令。 |
| 8 | PR 開出後 run 即結束（`end_reason: done`），結果訊息印出 PR 網址並寫入 `state.json`（`pr_url`）。不等 CI 或 merge，不自動 merge。 |
| 9 | 沙箱外的動作只有團隊設為 `lead` 的 agent 能觸發（使用者規則，2026-10-13）：`open_pr` 只認 lead 的 `done`（`run --agent` 的單獨 agent 是它那個一人團隊的 lead）；非 lead 的 agent 即使在信件或回覆文字裡寫了 `open_pr: true` 也一律忽略，不開 PR、不報錯。lead 本身不拿到不受限的 shell：沙箱設定不變，commit、push、`gh pr create` 都由 dispatcher 在沙箱外執行（Claude 與 Codex 都適用，不需要 `allowUnsandboxedCommands` 或 `danger-full-access`）。判斷依據是設定裡的 `project.lead`，程式與 prompt 不寫死任何 agent 名稱。 |
| 10 | （開工前補）PR 要從 lead 分支開，而這個分支只有「有自己 worktree 的 run」（`max_concurrent_runs > 1`）才有。沒有 lead worktree 的 run 要求開 PR 時不開，在結果與 `notes` 說明並指向 `max_concurrent_runs`，不改 `outcome`。不為了開 PR 而替預設模式的 run 另外建分支或提交使用者的 working tree。 |

## 14.3 與其他 spec 的關係

- 07 已實作（lead worktree 與結束時提交）；14 直接使用 07 的 lead 分支。

## 14.4 影響的檔案

- `src/format.ts`：`doneContract` 讀 `open_pr`。
- `src/prompt.ts`：lead 與單獨 agent 的 `done` 說明加 `open_pr` 規則。
- `src/run-session.ts`：run 結束（`done`、`completed`）後呼叫開 PR 步驟。
- 新增 `src/open-pr.ts`：提交、推送、`gh pr create`、組 PR 描述（純函式拆出以便測試）。
- `src/run-store.ts`：`pr_url` 欄位（可省略，舊 run 可讀）。
- `src/doctor.ts`：`gh` 與 `origin` 檢查。
- `README.md`、`README.zh-TW.md`、`docs/commands.md`（含 zh-TW）。

## 14.5 驗收

先寫失敗測試再實作（`gh` 與 `git push` 以 fake 取代）：

1. `done` 帶 `open_pr: true` 且 `completed`：呼叫順序為 commit → push → `gh pr create`；描述結尾有 `Opened by agent-lyceum`，且描述正好是 lead 的報告原文加那一行署名，沒有 dispatcher 加的任何名稱。
2. `done` 沒有 `open_pr`（或不是 `true`）：不 push、不呼叫 `gh`。
   prompt 含「只有 task 明確要求才寫」的規則。
3. `open_pr: true` 但 outcome 為 `partial`／`blocked`／`failed`：不開 PR，訊息說明原因。
4. push 失敗：`outcome` 不變，分支保留，訊息含手動指令。
5. 缺 `gh`、未登入或沒有 `origin`：開 PR 步驟失敗，處理同第 4 點；`doctor` 會提示。
6. 使用者的 working tree 與目前分支未被改動。
7. 只有 lead：非 lead 的 agent 寄出帶 `open_pr: true` 的信或 `done` 時不開 PR；`run --agent` 單獨 agent 的 `done` 帶 `open_pr: true` 時會開；lead 與非 lead 的沙箱設定（Claude `allowUnsandboxedCommands: false`、Codex `-s workspace-write`）與現在完全相同。

## 14.6 範圍外

自動 merge、等 CI／review 後才結束、草稿 PR、多個 PR、非 GitHub 的託管服務。
