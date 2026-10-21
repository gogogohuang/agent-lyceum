# 監控 mod（Claude Code）

`plugins/status-monitor` 是 Claude Code **mod**，不是一般的 plugin：它依 Claude Code 的 mod hooks API 撰寫（`import type { Register } from 'claude-code'`），在 Claude Code session 內執行，提供通知與 `/status-monitor` 面板，資料來自 `agent-lyceum status --json --watch`：一個長駐程序，run 的檔案有變動才輸出一行（不輪詢）。需要支援 mod 的 Claude Code 版本；不會改變 agent-lyceum 本身的運作。會顯示一個或多個專案的即時執行狀態。

**載入。** 先 build（`npm run build`；mod 會執行 `dist/cli.js`），再用下面的指令啟動 session：

```
claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor
```

`--plugin-dir` 只在 session 啟動時生效，已開著的 session 要重開（`claude --resume --plugin-dir ...` 可保留對話）。想每次都載入，就在 shell rc 加 `alias claude='claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor'`；無法帶參數的環境（桌面 app、SDK）則把 `CLAUDE_CODE_PLUGIN_DIRS` 設成 mod 資料夾。session 執行中儲存 mod 資料夾內的檔案會自動 hot reload。

**操作。**
- **通知：** 執行完成、被中斷或某個 agent 喚醒失敗時會跳出訊息（監看多個專案時前面加 `[專案名]`），不需要任何操作。
- **`/status-monitor`：** 輸入即開啟面板（已開著則關閉）。session 啟動時預設不開，除非設定 `autoOpen`。在 **fullscreen 版面**（`~/.claude/settings.json` 設 `"tui": "fullscreen"` 後重開 session；`/tui fullscreen` 效果相同）且終端寬度 110 欄以上時，面板會靠右 dock 在終端寬度的一半，分頁與 **關閉** 都可以用滑鼠點。否則顯示在輸入框上方；版面在 session 啟動時就固定，從主畫面啟動的 session 不會變。鍵盤操作兩種版面都能用：`x` 關閉，`v` 切換圖形／文字，`e` 展開／收合細節，`1`-`9` 或 Tab/Enter 切換任務，Esc 回到輸入框，再執行一次指令也會關閉。面板為每個 agent 畫一個區塊，並依 `can_message` 在 lead 與各成員之間畫出連結（`▼` lead 可寄給成員、`▲` 成員可寄給 lead、`↕` 雙向；黃色表示最近一次寄信的那條邊）。每個區塊顯示該 agent 現在在做什麼、正在處理與排隊中的信，每封信預設只顯示一行重點：依信種挑出它在講什麼（task 是目標，reply 是變更，done 是結果），再加上信裡回報的待辦、風險或未完成（寫 None 就不顯示）——不是把開頭截短。按 `e` 展開：每封信的每個段落（task 看目標與驗收，reply 看變更、驗證、待辦與風險，done 看結果與未完成）和完整的步驟清單；收合時清單只有進度條與目前步驟。每個區塊也顯示喚醒次數與輸出 token。正在運作的 agent 會被放大：它的區塊獨佔一整列、使用全寬，文字自動換行而不截斷；閒置與排隊中的區塊維持精簡。圖形上方是執行 id 與狀態、任務、進度條與清單；下方是受阻的整合、備註與結果摘要。按 `v` 切換成純文字清單（各 runtime 的 token、各 agent 統計、最近 8 次喚醒）。每個區塊以「→」一行列出它可以寄信的對象，最近一次寄信的對象標 「●」（成員之間的對象也在此，不畫符號）。當圖形區域寬度少於 70 欄（以面板本身的寬度比較，由 host 回報），區塊改成單欄堆疊，不畫連結符號。每個未完成的任務是一個分頁，最新的排最前面：執行中的、已中斷的、等待回答的，以及已結束但未完成的（部分完成、受阻、失敗、已取消）都會留著，分頁標題標出狀態。任務只有在完成（或被你 `clear`）後才會離開面板。面板開著時會依輪詢間隔自動更新。

**設定。** 在 `~/.claude/settings.json` 的 `pluginConfigs."status-monitor@inline"`（`options`）：

| 選項 | 說明 | 預設 |
|---|---|---|
| `command` | 要執行的 CLI，以空白分隔，例如 `node /path/to/agent-lyceum/dist/cli.js` | `agent-lyceum` |
| `project` | 已註冊的專案名稱（`-p`）；用逗號分隔可同時監看多個；留空則依 session 所在目錄推斷 | 空 |
| `intervalSeconds` | 只有 `status --watch` 起不來（舊版 CLI）時才用：改成每隔這麼久輪詢一次 | `1` |
| `autoOpen` | session 啟動時自動開啟面板（未經操作開啟時，終端需 144 欄以上才會顯示） | `false` |

設定變更要等下次啟動 session 才生效。面板若顯示 `無法取得狀態：...`，通常是 `command` 跑不起來（多半是還沒 build `dist/cli.js`），或專案名稱沒有註冊。

**備援標記。** 設有備援鏈的 agent 正在使用備用模型時，它的區塊標題會多一個小小的 `備援中` 標記，其他版面不變。從哪個模型切換、原因，以及冷卻狀態，請看 `agent-lyceum status`。

**如何保持最新。** mod 對每個監看的專案啟動一個 `agent-lyceum status --json --watch`。它監看專案的 `runs/` 目錄（debounce 100 ms，因為一輪會寫好幾個檔），結果與上一行不同時才輸出一行 JSON（專案報告加上每個未完成 task 各一份）；剛完成的 task 會再多帶一次，讓通知能觸發。`--heartbeat <秒>`（預設 5）是慢速補查，處理檔案事件看不到的情況（鎖的持有者死掉、`runs/` 當時還不存在）。父程序消失時它會自行結束。若它跑不起來，mod 會把原因寫進 debug log，並改回依 `intervalSeconds` 輪詢。
