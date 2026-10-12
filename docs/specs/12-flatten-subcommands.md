# 12 收掉巢狀子指令

狀態：已實作（plan：docs/plans/2026-10-12-12-flatten-subcommands.md）。

## 12.1 問題

- 0.9.1 有 9 個頂層指令、12 個入口。其中 `memory tidy`、`memory restore`、`project list` 三個入口多打一層字，卻沒有多一個概念：`memory` 底下只有「整理」與「還原那次整理」，`project list` 是 `project` 最常用的動作。
- 0.9.0（#63）已把 `validate`、`config show`、`answer`、`unlock` 併入其他指令。剩下的合併（`resume`、`call` 併進 `run`；`doctor` 併進 `status`）會把指令數換成互斥的旗標組合，總複雜度不降，所以這次不做。

## 12.2 決議

| # | 決議 |
|---|---|
| 1 | `memory tidy [-p] [--agent] [--layer] [--dry-run]` 改為頂層指令 **`tidy`**，選項與行為不變。 |
| 2 | `memory restore <時間戳> -p --agent [--layer]` 改為 **`tidy --undo <時間戳> -p --agent [--layer]`**。還原行為不變：取專案鎖、不覆蓋現有同名檔案、補回 `MEMORY.md` 索引。底層 `restoreMemory()` 不改。 |
| 3 | `--undo` 必須搭配 `--agent`；缺了就報錯並說明要加 `--agent`。 |
| 4 | `--undo` 不能搭配 `--dry-run`；一起給就報錯。 |
| 5 | `tidy` 完成時印的還原提示改為 `agent-lyceum tidy --undo <時間戳> -p <專案> --agent <名字>`（global 層時加 `--layer global`）。 |
| 6 | **`project`** 不帶子指令時列出已註冊專案，輸出與原本的 `project list` 相同。`project list` 移除。 |
| 7 | `project add`、`project remove` 不變。 |
| 8 | `memory` 指令整個移除。舊寫法（`memory …`、`project list`）不留別名、不加「已改為…」提示，得到 commander 預設的 unknown command 錯誤，與 0.9.0 的做法一致。 |
| 9 | `--help` 分層：Project＝`init`、`project`；Diagnose＝`doctor`、`status`；Run＝`run`、`resume`、`clear`、`call`、`tidy`。 |
| 10 | `status` 與 `doctor` 建議整理記憶的提示文字，由 `agent-lyceum memory tidy` 改為 `agent-lyceum tidy`。 |
| 11 | 破壞相容性，發 **0.10.0**。入口 12 → 10，頂層指令仍是 9 個。 |

### 對照表

| 0.9.x | 0.10.0 |
|---|---|
| `memory tidy …` | `tidy …` |
| `memory restore <時間戳> -p <專案> --agent <名字>` | `tidy --undo <時間戳> -p <專案> --agent <名字>` |
| `project list` | `project` |

## 12.3 影響的檔案

- `src/cli.ts`：移除 `memory` 指令與 `project list`；新增頂層 `tidy`（含 `--undo`）；`project` 加上不帶子指令時的 action；更新 `HELP_LAYERS` 與還原提示文字。
- `src/doctor.ts`、`src/status.ts`：提示文字裡的指令名稱。`src/memory-tidy.ts`：註解裡的指令名稱。
- `test/memory-tidy-cli.test.ts`：改用新寫法。`test/status.test.ts`、`test/doctor.test.ts`：比對提示文字的地方。
- `README.md`、`README.zh-TW.md`：指令表。
- `docs/commands.md`、`docs/commands.zh-TW.md`：`memory tidy`、`memory restore` 兩節合併成一節 `tidy`；`project list and remove` 一節改名；修正連到這些節的錨點。兩份文件的標題結構必須一致（`npm run check:docs`）。

## 12.4 驗收

- `agent-lyceum tidy --dry-run -p <專案>` 的輸出與 0.9.1 的 `memory tidy --dry-run` 相同。
- `agent-lyceum tidy --undo <時間戳> -p <專案> --agent <名字>` 還原的結果與 0.9.1 的 `memory restore` 相同。
- `tidy --undo <時間戳>` 缺 `--agent`：非 0 結束，訊息指出要加 `--agent`，不取鎖、不改任何檔案。
- `tidy --undo <時間戳> --agent <名字> --dry-run`：非 0 結束，訊息指出兩者不能並用，不改任何檔案。
- `agent-lyceum project` 列出已註冊專案；沒有專案時印 `No projects registered.`。
- `agent-lyceum memory tidy`、`agent-lyceum project list` 以非 0 結束。
- `agent-lyceum --help` 的 Run 層列出 `tidy`，不再有 `memory`。
- `tidy` 成功後印的還原提示是可以直接貼上執行的新寫法。
- `npm run typecheck`、`npm test`、`npm run check:docs`、`npx biome check src` 全過。

## 12.5 範圍外

- `resume`、`call`、`doctor`、`clear`、`init`、`status`、`run` 的名稱與選項。
- 設定檔欄位、資料夾結構、exit code、`.archive/`、`.tidy-state.json` 的格式。
- 舊指令的隱藏別名或遷移提示。
