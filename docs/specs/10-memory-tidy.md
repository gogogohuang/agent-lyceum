# 10 記憶整理與淘汰（memory tidy）

狀態：已實作（plan：`docs/plans/2026-10-08-10-memory-tidy.md`）。

## 10.1 問題

- 記憶分 global、project、task 三層，agent 只會往 `MEMORY.md` 索引追加，沒有任何整理機制。時間一久，索引（每次喚醒都注入 prompt）會膨脹，內容也會重複，或與程式碼現況脫節（提到已刪除或改名的檔案）。
- 同類專案（Letta/MemGPT、CrewAI 記憶）都有記憶摘要或淘汰機制。

## 10.2 決議

| # | 決議 |
|---|---|
| 1 | **只能手動觸發，不做任何自動整理。** run 結束、記憶過大、repo 變化都不會自動觸發。`status`／`doctor` 最多提示「建議執行 `memory tidy`」，不會自己執行。 |
| 2 | 指令：`agent-lyceum memory tidy -p <project> [--agent a] [--layer project\|global] [--dry-run]`。預設對該專案所有 agent 的 **project** 記憶執行；**global** 記憶需明確指定 `--layer global`（它跨專案共用，不由某個專案的變化觸發）。task 記憶不整理，`clear` 本來就會刪它。 |
| 3 | 執行者是 agent 自己：每個被整理的 agent 以專用 wake-up 執行一次。此 wake-up 不屬於任何 run，不影響 `max_rounds`，寫入範圍不變：只能動自己的 memory，不能動 `AGENT.md`。 |
| 4 | 執行時取專案鎖；專案有 run 在跑則拒絕。 |
| 5 | **隨 project 變化更新**：`memory/.tidy-state.json` 記錄上次整理時的 `HEAD` sha。prompt 附上自該 sha 以來的 `git log --oneline` 與 `git diff --stat` 摘要，以及記憶中提到的路徑目前是否存在（機械式檢查，標出已不存在者）。第一次整理沒有基準，只做路徑檢查。 |
| 6 | prompt 附上每個記憶檔的大小與最後修改時間、`MEMORY.md` 索引，與整理守則：合併重複、改寫過時內容、不確定的保留。 |
| 7 | 淘汰 = 封存，不直接刪：過時或重複的檔案搬到 `memory/.archive/<時間戳>/`，不再進 prompt 索引。agent 結束前必須在該目錄寫 `tidy-report.md`（合併了什麼、封存了什麼與理由、仍存疑的項目）。 |
| 8 | dispatcher 驗證**檔案守恆**：整理前的每個檔案，整理後不是仍在原處、就是在本次 `.archive` 裡（內容被合併改寫者由 `tidy-report.md` 說明）；`.archive` 之外不得有憑空消失的檔案。驗證通過才更新 `.tidy-state.json`。 |
| 9 | 還原：`agent-lyceum memory restore <時間戳> -p <project> --agent a` 把該次封存的檔案移回，並補回索引條目。 |
| 10 | 失敗（超時或驗證失敗）：以整理前的快照還原記憶目錄，不更新基準，印出原因。 |
| 11 | `--dry-run`：只印出各 agent 的記憶統計與會附上的 project 變化摘要，不喚醒 agent、不改任何檔。 |

### 實作時的補充

- 時間戳格式 `YYYYMMDDTHHMMSSZ`（UTC）；`restore` 只接受這個格式。
- 檔案守恆：整理前（含先前的 `.archive` 內容）每個檔案，整理後必須仍在原路徑，或在本次 `.archive/<時間戳>/` 的**相同相對路徑**；`MEMORY.md` 不得被封存；`tidy-report.md` 必須非空。
- agent 不得改動它的其他記憶層（整理 project 時不得動 global）：dispatcher 比對其他層整理前後的內容雜湊。
- 「已不存在的路徑」只看 Markdown 檔裡以反引號包起來、含 `/` 的詞：絕對路徑與 `~/` 直接檢查，相對路徑以專案 repo 為基準（global 層不檢查相對路徑）。
- 整理的暫存（快照與 log）在 `<專案根>/tidy-work/<時間戳>/<agent>/`，成功後只刪快照。
- `restore` 不覆蓋現有同名檔，並為 `MEMORY.md` 沒提到的 `.md` 補索引。
- 專案範本只替 agent 設 global 記憶；預設的 project 層要先設 `memory.project` 才有目標。沒有目標時指令說明並以 `0` 結束。
- `status`／`doctor` 的提示條件：`MEMORY.md` 超過注入 prompt 的上限（4096 bytes），或自上次整理已 50 個以上 commit；只提示。

## 10.3 影響的檔案

- 新增 `src/memory-tidy.ts`：統計、快照與還原、檔案守恆驗證、`.tidy-state.json`、路徑存在檢查、git 摘要。
- `src/prompt.ts`：整理專用 prompt（與一般協議分開）。
- `src/cli.ts`：`memory tidy`、`memory restore`。
- `src/policy.ts`：確認 `.archive` 與 `.tidy-state.json` 落在可寫範圍內。
- `src/status.ts`、`src/doctor.ts`：記憶過大或基準過舊時的提示（只提示）。
- `README.md`、`README.zh-TW.md`、`docs/commands.md`（含 zh-TW）。

## 10.4 驗收

先寫失敗測試再實作：

1. 檔案守恆：憑空消失的檔案使驗證失敗並還原；全部在原處或在 `.archive` 則通過。
2. `.archive` 之外不得刪檔；agent 寫入範圍不超出自己的 memory。
3. `--dry-run` 不喚醒 agent、不改任何檔。
4. 專案有 run 在跑時拒絕。
5. 基準 sha 更新與變化摘要：有基準時含 log 與 diff stat；無基準只含路徑檢查；已刪除的路徑被標出。
6. `restore`：檔案與索引條目回復。
7. 失敗回復：超時或驗證失敗後記憶目錄與整理前一致，基準不變。
8. `--layer global` 需明確指定，預設不碰 global。
9. 確認沒有任何自動觸發：run 結束、記憶過大都不會喚醒整理。
10. 整合測試：用 `test/fixtures/runtime/fake-claude.mjs` 跑完 tidy → 封存 → restore。

## 10.5 範圍外

任何自動觸發、archive 的自動清理、跨 agent 去重、向量檢索、task 記憶整理。
