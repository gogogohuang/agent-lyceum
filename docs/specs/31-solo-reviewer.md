# 31 solo run 內接 reviewer

狀態：草稿（粗略版，未實作）。追蹤：[#189](https://github.com/gogogohuang/agent-lyceum/issues/189)

## 31.1 問題

- `run --agent <impl>` 是一人團隊，實作者的 `done` 就結束 run（[spec 11](11-solo-agent.md)）。要審查只能另開一個 run：一個任務在 `status` 變成兩個以上。
- `resume` 沿用 `solo_agent`，不能在原 run 換 reviewer；`call` 只能叫 global agent，也不進 `status`。
- reviewer 的 verdict 不會記在實作 run 上。
- 改用 team run 能解，但要付 lead 的喚醒成本。

## 31.2 目標與不做

目標：一次「實作 → 審查 → 修正 → 複審」留在同一個 run，不喚醒 lead。

第一版不做：多位 reviewer；`call` 接 reviewer；`project.yaml` 的預設 reviewer；對沒帶 `--reviewer` 的舊 run 事後補審。

## 31.3 作法比較

| 作法 | 取捨 |
|---|---|
| **A. dispatcher 在 `done` 通過後喚醒 reviewer（建議）** | 流程固定、不靠 prompt 遵守；要在 done 處理加一個階段 |
| B. 讓實作者可寄信給 reviewer（兩人團隊） | 改動少，但何時送審、要不要送由實作者決定，maker-checker 沒有保證 |
| C. `resume <run> --agent <reviewer>` | 彈性高，但要手動接兩次以上，run 的 lead 中途換人，`solo_agent` 語意變複雜 |

以下採 A。

## 31.4 決議

| # | 內容 |
|---|---|
| D-01 | `run --agent <impl> --reviewer <name>`。`--reviewer` 沒有 `--agent`、與 `--agent` 同名、不是專案成員：拒絕，exit `1`。 |
| D-02 | run state 記 `solo_reviewer`；`resume`（含追加任務）沿用。沒有此欄位的 run 行為不變。 |
| D-03 | 實作者仍是 solo 的 lead（不能寄信、不能 `ask`）。reviewer 只能寄一封帶 `verdict` 的 `reply` 給實作者，不能寄 `done`、不能 `ask`、不能改 `AGENT.md`。 |
| D-04 | 順序：實作者寄 `done` → 完成契約 → `verify`（有設定時）→ 送審 → 結束 run。前兩關沒過不送審。 |
| D-05 | 只有 `outcome: completed` 送審。`partial`／`blocked`／`failed` 照現況直接結束。 |
| D-06 | 送審前先把實作者的改動 commit 在其 branch。dispatcher 寄給 reviewer 一封 `task`（`read_only: true`）：原始任務、`done` 報告、`base..head`。 |
| D-07 | `verdict: pass`：照現況結束，`done` 生效；verdict 寫入 `state.reviews`，commit 帶 `Reviewed-by`。 |
| D-08 | `verdict: changes_requested`：退回 `done`，review 內文寄給實作者（沿用 session 與 worktree）。新的 `done` 要重跑 verify 與審查。 |
| D-09 | 每段（run 或一次 reopen）最多退回 2 次；下一次仍是 `changes_requested` 時以 `partial`（exit `2`）結束，未解決的意見寫進 `result.md`。 |
| D-10 | `verdict: fail`：不退回，直接 `partial`。 |
| D-11 | reviewer 沒給 verdict：提醒，最多 2 次，之後 `partial`。喚醒本身失敗：照現有 retry／fallback；用盡後 run 為 `failed`，`resume` 從送審接續。 |
| D-12 | 不強制不同 runtime；兩者 runtime 相同時印一行 warn。`verify.cross_runtime` 不影響 solo run。 |
| D-13 | 送審與修正的喚醒都算進 `max_rounds`。 |

## 31.5 影響的檔案（初估）

- `src/cli.ts`：`--reviewer` 與檢查、preflight 含兩位 agent。
- `src/solo.ts`：兩人版的衍生設定。
- `src/run-store.ts`：`solo_reviewer`、本段退回次數、待審的 `done`。
- `src/run-session.ts`：`done` 之後的送審階段、verdict 處理、崩潰重播。
- `src/policy.ts`、`src/prompt.ts`：reviewer 的寫入範圍與提示。
- `src/status.ts`、web：顯示審查中與 verdict。
- `docs/commands.md`、`how-it-works.md`、README（含 zh-TW）。

## 31.6 驗收（草案）

1. pass：兩次喚醒（實作、審查），一個 run，exit `0`，`state.reviews` 有紀錄。
2. changes_requested 一次後 pass：同一個 run，實作者沿用 session。
3. 超過退回上限、`fail`、沒給 verdict：`partial`，exit `2`。
4. `partial` 的 `done` 不送審。
5. reviewer 改了 repo：改動被還原。
6. 送審中中斷後 `resume`：不重跑已完成的實作，不重複寄審查信。
7. reopen：退回次數重算，上一段的 pass 不沿用。
8. 不帶 `--reviewer`：現有 solo 測試不變。

## 31.7 已確認

| # | 問題 | 決定 |
|---|---|---|
| Q-01 | 退回上限固定 2，還是可設定？ | 固定 2 |
| Q-02 | 超過上限要 `partial` 還是 `failed`？ | `partial` |
| Q-03 | 要不要強制跨 runtime？ | 不強制，只 warn |
| Q-04 | 事後補審（`resume <run> --reviewer`）要不要進第一版？ | 不進 |

## 31.8 實作前要查證

- reviewer 的 worktree 從實作者 branch 切出時，lead 在 project folder（task branch）與在 worktree 兩種模式是否都看得到最新 commit。
- 非 worktree（非 git）專案的唯讀喚醒能否保證還原 reviewer 的改動。
- `project.solo` 目前用來判斷「不是協調者」的地方，對 reviewer（非 lead）是否仍成立。
- [spec 30](30-solo-lesson-proposals.md) 的提案寫入權限是否也給 reviewer。
