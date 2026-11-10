# 網頁操作台

在 `status --web` 頁面執行 agent-lyceum 的所有指令。僅限本機使用；見[安全](#安全)。

## 各指令在哪裡

| CLI | 頁面上的位置 |
| --- | --- |
| `run` | 專案頁，**新任務** |
| `resume`（追問、續跑） | 專案頁，在沒有執行中的任務上按**續跑／追問** |
| `resume --answer` | 專案頁，在等待回答的任務上按**回答問題** |
| `clear` | 專案頁，**刪除這次任務** |
| `tidy` | 專案頁，**整理記憶** |
| `doctor` | 專案頁，**檢查設定** |
| `project`、`project add`、`project remove` | **工具**（`#!tools`） |
| `call`、`demo`、`init` | **工具**（`#!tools`） |
| `clear --lock --force` | **工具**（`#!tools`） |
| `status` | 頁面本身 |

可能跑很久的指令（`run`、`resume`、`call`、`tidy`、`demo`）以背景工作啟動，關掉頁面或停掉 `status --web` 後仍會繼續。每個工作有自己的資料夾 `<home>/web-jobs/<id>/`，裡面有 `out.log`，結束後還有 `exit.json`。輸出在**任務輸出**（`#!jobs`）。`tidy --dry-run`、`tidy --undo` 與 `demo --setup-only` 很快結束，輸出直接回傳。

## 確認

確認等級由伺服器強制執行，頁面只是先問一次。等級可能隨請求內容而變，以 `web/src/commands.ts` 為準。

- 一般：直接執行。包括 `run`、`resume`、`call`、`doctor`、`init`、`project add`、`demo`，以及 `clear` 與 `tidy` 的預覽（dry-run）。
- 確認：`clear`、`tidy`、`project remove`（`clear --dry-run` 與 `tidy --dry-run` 除外）。有預覽的指令，頁面會先顯示預覽再詢問。請求沒帶 `confirm: true` 時，伺服器回 HTTP 428。
- 輸入確認：`project remove --purge` 與 `clear --lock --force`。你要輸入專案名稱或任務 id；`confirmText` 與它不完全相同時，伺服器回 HTTP 428。

## 安全

- **限制：**整個 `/api/*`（讀取與寫入）都只限本機。`--host` 不是 loopback 位址時，`/api/*` 的每種 method 都回 HTTP 403，無法執行任何指令。沒有旗標可以開啟；不支援把操作台暴露到網路上。在此之前，非 loopback 的 `--host` 會關掉寫入路由的檢查。
- `POST /api/*` 需要有效的 `Host`、同源的 `Origin`（一定要有）與放在 `X-Lyceum-Token` 的每次啟動專屬 token。token 在每次伺服器啟動時隨機產生，並注入 `index.html` 的 `<meta name="lyceum-token">`。重複出現的 `Origin` 或 token 標頭會被拒絕。`POST /quota` 維持原規則（`Origin` 可有可無）。
- 每個指令都以 `process.execPath` 加參數陣列啟動，不經過 shell。任務這類自由文字放在 `--` 之後，不會被當成選項。
- 500 回應只有通用訊息；細節印在伺服器的 console。

## 限制

- 請求本文最大 256 KB；短指令超過 120 秒會被停止，並回傳到那時為止的輸出。
- 頁面開著時若伺服器重新啟動，下一個動作會被拒絕，頁面會請你重新整理（token 已更換）。
- 工作的結束碼存在 `exit.json`。工作的程序已消失、卻沒寫下它時，頁面顯示「已結束（結束碼不明）」。
