# 監控 mod（Claude Code）

`plugins/status-monitor` 是 Claude Code **mod**，不是一般的 plugin：它依 Claude Code 的 mod hooks API 撰寫（`import type { Register } from 'claude-code'`），在 Claude Code session 內執行，提供通知與 `/status-monitor` 面板，資料來自 `agent-lyceum status --json --watch`：一個長駐程序，run 的檔案有變動才輸出一行（不輪詢）。需要支援 mod 的 Claude Code 版本；不會改變 agent-lyceum 本身的運作。會顯示一個或多個專案的即時執行狀態。

**載入。** 先 build（`npm run build`；mod 會執行 `dist/cli.js`），再用下面的指令啟動 session：

```
claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor
```

`--plugin-dir` 只在 session 啟動時生效，已開著的 session 要重開（`claude --resume --plugin-dir ...` 可保留對話）。想每次都載入，就在 shell rc 加 `alias claude='claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor'`；無法帶參數的環境（桌面 app、SDK）則把 `CLAUDE_CODE_PLUGIN_DIRS` 設成 mod 資料夾。session 執行中儲存 mod 資料夾內的檔案會自動 hot reload。

**操作。**
- **通知：** 執行完成、被中斷或某個 agent 喚醒失敗時會跳出訊息（監看多個專案時前面加 `[專案名]`），不需要任何操作。
- **`/status-monitor`：** 輸入即開啟面板（已開著則關閉）。session 啟動時預設不開，除非設定 `autoOpen`。在 **fullscreen 版面**（`~/.claude/settings.json` 設 `"tui": "fullscreen"` 後重開 session；`/tui fullscreen` 效果相同）且終端寬度 110 欄以上時，面板會靠右 dock 在終端寬度的一半（可拖曳到任何寬度），分頁與 **關閉** 都可以用滑鼠點。否則顯示在輸入框上方；版面在 session 啟動時就固定，從主畫面啟動的 session 不會變。鍵盤操作兩種版面都能用：`x` 關閉，`v` 切換圖形／文字，`e` 展開／收合細節，`1`-`9` 或 Tab/Enter 切換任務，Esc 回到輸入框，再執行一次指令也會關閉。面板把 agent 畫成一棵樹：lead 在最上面，每位成員是下面的一個分支，**每個 agent 各有一個圓角外框**，框線顏色代表狀態（綠：進行中、黃：排隊、紅：上次喚醒失敗、灰：閒置）。分支符號畫在框外、貼著框的上緣，依 `can_message` 表示誰能寫給誰（`▼` lead 可寄給成員、`▲` 成員可寄給 lead、`↕` 雙向、`─` 兩者都不行；黃色表示最近一次交接）；後面還有成員時，框的左側會有一條 `│`。成員依需要看的順序排：進行中、失敗、排隊，最後才是閒置。有 agent 上次喚醒失敗時，樹的最上方多一行紅色提示，列出是哪幾位。收合時每個框只有一行標題與狀態（進行中顯示輪次與經過時間，排隊顯示封數，使用備用模型時標 `備援中`），三位以上閒置的成員合併成一行「另有 N 個閒置：…」。信件每封只顯示一行重點：依信種挑出它在講什麼（task 是目標，reply 是變更，done 是結果），再加上信裡回報的待辦、風險或未完成（寫 None 就不顯示）——不是把開頭截短。按 `e` 展開：每封信的每個段落（task 看目標與驗收，reply 看變更、驗證、待辦與風險，done 看結果與未完成）、喚醒次數與輸出 token（附一條相對於用量最多的 agent 的長條）、可寄信對象的「→」一行（最近一次寄信的對象標「●」），以及完整的步驟清單；收合時清單只有進度條與目前步驟。框內文字自動換行而不截斷。樹的上方是執行 id 與狀態、輸出與快取 token、任務（固定一行，太長以 `…` 收尾）、進度條與清單；下方是受阻的整合、備註與結果摘要。按 `v` 切換成純文字清單（各 runtime 的 token、各 agent 統計、最近 8 次喚醒）。每個未完成的任務是一個分頁，最新的排最前面，標題吃掉一行剩下的寬度（被截斷時以 `…` 收尾；多專案時前面加專案名稱，最寬 20 格）：執行中的、已中斷的、等待回答的，以及已結束但未完成（部分完成、受阻、失敗、已取消）的都會留著，分頁標題標出狀態。任務只有在完成（或被你 `clear`）後才會離開面板。run 的檔案一有變動就更新。
- **`/status-monitor band`：** 把同一份狀態改顯示成輸入框上方、使用整個終端機寬度的橫幅，不佔右側面板（再輸入一次就隱藏，`/status-monitor` 會回到面板）。內容與按鍵相同。

**設定。** 在 `~/.claude/settings.json` 的 `pluginConfigs."status-monitor@inline"`（`options`）：

| 選項 | 說明 | 預設 |
|---|---|---|
| `command` | 要執行的 CLI，以空白分隔，例如 `node /path/to/agent-lyceum/dist/cli.js` | `agent-lyceum` |
| `project` | 已註冊的專案名稱（`-p`）；用逗號分隔可同時監看多個；留空則依 session 所在目錄推斷 | 空 |
| `intervalSeconds` | `status --watch` 啟動失敗或結束後，改用的輪詢間隔 | `1` |
| `maxColumns` | 面板開啟寬度（終端的一半）與樹狀圖繪製寬度的上限 | `250` |
| `autoOpen` | session 啟動時自動開啟面板（未經操作開啟時，終端需 144 欄以上才會顯示） | `false` |

設定變更要等下次啟動 session 才生效。面板若顯示 `無法取得狀態：...`，通常是 `command` 跑不起來（多半是還沒 build `dist/cli.js`），或專案名稱沒有註冊。

**備援標記。** 設有備援鏈的 agent 正在使用備用模型時，它的區塊標題會多一個小小的 `備援中` 標記，其他版面不變。從哪個模型切換、原因，以及冷卻狀態，請看 `agent-lyceum status`。

**快取用量。** 執行那一行也會顯示這個 run 讀取與寫入的 prompt 快取輸入 token，以及讀取所占比例（`快取 讀 … 寫 … 命中 …%`），`agent-lyceum status` 的顯示相同。只記錄 `claude` agent；這項記錄出現之前的 run 與 codex agent 不顯示。

**如何保持最新。** mod 對每個監看的專案啟動一個 `agent-lyceum status --json --watch`。它監看專案的 `runs/` 目錄（debounce 100 ms，因為一輪會寫好幾個檔），結果與上一行不同時才輸出一行 JSON（專案報告加上每個未完成 task 各一份）；剛完成的 task 會再多帶一次，讓通知能觸發。`--heartbeat <秒>`（預設 5）是慢速補查，處理檔案事件看不到的情況（鎖的持有者死掉、`runs/` 當時還不存在）。父程序消失時它會自行結束。若它跑不起來，mod 會把原因寫進 debug log，並改回依 `intervalSeconds` 輪詢。

**監看程序升級。** 安裝新版 CLI **與** mod 後，必須先重開 Claude Code session 一次：既有的舊程序無法自行更新。監看程序會在 heartbeat 檢查自己現有的程式碼目錄；指紋改變後，連續兩次讀取相同便以 `75` 結束，並向 stderr 寫出標記 `status --watch: agent-lyceum code changed on disk; restart to load it`。這是 debounce，不代表 build 已完成。mod 只在子程序以該標記結束後依序重啟，每個滾動的一分鐘內最多五次。替代程序失敗、其他結束原因或達到重啟上限，都會改為輪詢，直到重開 session。替換期間完成的任務可能漏掉通知。`npx agent-lyceum@latest` 更新若使用另一個快取目錄，也必須重開 session。

**存活判斷範圍。** 修正保留 C／中文啟動時間辨識，並對一般以一刻鐘為單位的 UTC 時差加入保守辨識；目標是不新增把存活程序誤判為死亡的情況。寫入端與讀取端使用不同時區時，任意非一刻鐘的 POSIX `TZ` 時差仍是既有的限制，並非保證支援所有時區。在 macOS 與 Linux 備援路徑上，鎖的寫入端把 `pid_started` 記錄為行程繼承的語系與時區下的 `ps -o lstart=` 文字，與 agent-lyceum 0.29.0 之前相同；Linux 上 `/proc` 可讀時則改記錄 `proc:<ticks>`（`src/project-lock.ts:74–80`）（v0.29.0 寫入 C 語系文字，較舊、使用中文語系的 agent-lyceum 可能因此判定存活者已死亡）。相同語系／時區的舊版讀取端接受該鎖；v0.29.0 讀取端接受 C 與中文文字，但遇到以其他語系（例如日文）寫入的鎖可能誤判。此修正尚未在真實 macOS `ps` 上驗證。詳見[核准契約與相容性限制](decisions/status-liveness-watch-restart.md)。

**平行實例。** 當一位成員以多個實例執行（見[同一成員的平行實例](how-it-works.zh-TW.md#同一成員的平行實例)），每個實例在樹狀圖裡都是獨立的一塊，與所有成員區塊一起依狀態（working、failed、waiting、idle）排序，不會緊鄰它的成員，狀態顯示和一般 agent 相同。編號 2 以上的實例標題為 `frontend #2`；實例 1 沿用成員本名。等待實例的 task 是標有 `held` 的佇列項目，顯示在成員名稱下。把實例收在成員底下分組的樹狀檢視還沒做；文字頁面只對真正的實例顯示 `role #k`，名稱剛好以 `--k` 結尾的設定 agent 不算。這些欄位（`status --json` 的 `role`、`instance`、`held`、每個 run report 的 `instances`；`role`、`instance` 在有實例的成員的 agent 列上，`held` 在它等待中的佇列項目上）只在 run 用過實例之後才出現；其他 run 的輸出與以前相同。文字頁面把編號 2 以上的實例顯示為 `role #k`，並在保留中的信件後標示「（保留中，等待空閒實例）」。（`src/status.ts`、`plugins/status-monitor/hooks/graph.ts`）
