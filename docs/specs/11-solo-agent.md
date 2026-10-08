# 11 單獨呼叫某個 agent（solo）

狀態：已實作（plan：docs/plans/2026-10-08-11-solo-agent.md）。

## 11.1 問題

- 目前只能 `run` 整個專案：任務交給 lead，lead 再分派給隊友。想請某一個 agent 單獨做一件事（例如請 pm 釐清需求、請某個 reviewer 看一段程式），只能繞過 lead，或先把 agent 掛進專案。
- 新增的 global agent（如 `pm`）還沒掛進任何專案時，完全無法使用。

## 11.2 決議

| # | 決議 |
|---|---|
| 1 | 兩個入口，都是**完全 solo**：只喚醒這一個 agent，不能寄信給別人，也不能問使用者（`type: ask`）。 |
| 2 | **`run --agent <name>`**：專案內，agent 必須是 `project.yaml` 已列出的成員。算一個 run（有 run id、專案鎖、`status`／monitor 可見、可 `resume`／`clear`）。 |
| 3 | **`call <agent> ["task"] [--task-file f] [--dir d]`**：獨立於專案，agent 取自 `team.yaml`（global agent），不讀任何 `project.yaml`，不取專案鎖。 |
| 4 | `run --agent`：沿用 `runTeam`，不改 lead／`done` 協議。把專案換成只含該 agent 的衍生設定：`lead = <name>`、`can_message = []`、`can_ask_user = false`、`can_edit_agent_md = false`。agent 以 `type: done` 結束 run（照現有完成契約）。結果摘要與 exit code 同 `run`。 |
| 5 | `run --agent` 的人格與記憶仍用該 agent 在專案內的解析結果（專案層覆蓋 global 層）。被指定的 agent 若原本是專案 lead，仍套用 solo 限制。 |
| 6 | `run --agent` 與 `--assume-defaults` 無意義（不會有 waiting）：帶了就警告並忽略。 |
| 7 | `call`：工作目錄是 `--dir`，沒給就是目前目錄（必須存在）。寫入範圍只有該目錄與該 agent 自己的 **global memory**；沒有 outbox／inbox，不能改任何 `AGENT.md`、`COMMON.md`、設定檔。 |
| 8 | `call` 的記憶：只用 global 層；`team.yaml` 條目有 `memory.global` 就用它，沒有就用 `<home>/agents/<name>/memory`。沒有 project／task 記憶層。 |
| 9 | `call` 的紀錄：每次在 `<home>/calls/<call-id>/` 留 `task.md`、`log/`（runtime 的 log）、`result.md`（agent 最終回答）。不進 `status`／monitor，`clear` 不處理它。 |
| 10 | `call` 的輸出：終端印出 agent 的最終回答。exit code：成功 `0`、失敗或逾時 `1`、Ctrl-C 取消 `130`。逾時用 `dispatcher.wake_timeout_sec` 的預設值。 |
| 11 | `call` 同一個 agent 同時只能一個：用 `<home>/calls/.lock-<agent>` 輕量鎖（pid 檔，死掉的 pid 視為過期）。被鎖住就拒絕並指出佔用者，不排隊。 |
| 12 | `call` 不接 `resume`：失敗就重新呼叫。 |
| 13 | 工作目錄不是 git repo 也可以呼叫，不要求 worktree。 |

實作時 soloProject 保留專案所有成員（只改指定 agent 的權限），讓其他成員的 AGENT.md、記憶與信箱仍受 deny 規則與 ProtectedGuard 保護；他們沒有信就不會被喚醒。

### 實作時的補充

- `run --agent` 的 run 狀態要記下 `solo_agent`，`resume` 時套用同一組限制；沒有這個欄位的舊 run 照舊行為。
- `run --agent <name>` 找不到該成員：列出專案成員後以 `1` 結束。若 `<name>` 只存在於 `team.yaml`，提示改用 `call`。
- `call <name>` 不在 `team.yaml`：列出可用的 global agent 後以 `1` 結束。
- solo 時 system prompt 要去掉隊友、信箱與 `ask` 的說明（沒有可寄的對象）；`run --agent` 保留 `done` 契約，`call` 完全不提 `done`／信箱，改成「直接用文字回答」。
- `call` 沒有專案，因此需要一個由 cwd／`--dir` 與 agent 組出的暫時 `ResolvedProject`（`name` 取 `(call)`，`paths` 指向 `<home>/calls/<call-id>/`）。實作前要先確認 `buildSystemPrompt`、`writePolicy`、`ProtectedGuard` 與 `realInvoker` 對這個暫時專案沒有隱含假設（例如要求 outbox 存在）；若有，抽出共用的最小介面而不是塞假目錄。
- `validate` 增加 `--agent` 的檢查是可選的，第一版不做；`doctor` 不變。

## 11.3 影響的檔案

- 新增 `src/solo.ts`：`soloProject`。
- 新增 `src/call.ts`：`call` 的解析、暫時專案、輕量鎖與流程。
- `src/config.ts`：`resolveProjectFrom`、`ResolvedProject.solo`。
- `src/policy.ts`：solo 的寫入範圍。
- `src/prompt.ts`：`buildSystemPrompt` 的 solo 變體。
- `src/run-store.ts`：`RunState.solo_agent`（選填，舊 run 可讀）。
- `src/run-session.ts`／`src/dispatcher.ts`：resume 時套用 `solo_agent`；其餘不改。
- `src/cli.ts`：`run --agent`、`call`。
- `README.md`、`README.zh-TW.md`、`docs/commands.md`（含 zh-TW）。

## 11.4 驗收

先寫失敗測試再實作：

1. `run --agent a`：只喚醒 a；a 的 system prompt 沒有隊友與 ask；a 寄 `done` 後 run 結束，exit code 與 `run` 一致。
2. `run --agent` 找不到成員、成員只在 `team.yaml`：訊息正確、exit `1`。
3. solo 的 agent 即使是專案 lead，也不能寄信給別人、不能 `ask`、不能改 `AGENT.md`。
4. `resume` 一個 solo run 仍套用同一組限制；沒有 `solo_agent` 的舊 run 行為不變。
5. `call`：寫入範圍只含工作目錄與 global memory；寫 outbox、`AGENT.md`、其他 agent 的記憶都被擋。
6. `call` 的紀錄目錄內容正確；終端印出最終回答；exit `0`／`1`／`130`。
7. `call` 不取專案鎖，不出現在 `status`；同一 agent 同時第二次呼叫被拒絕，過期的鎖可被接手。
8. 不在 git repo 的目錄、`--dir` 不存在、agent 不在 `team.yaml`：訊息正確。
9. 整合測試：用 `test/fixtures/runtime/fake-claude.mjs` 跑 `run --agent` 與 `call`。
