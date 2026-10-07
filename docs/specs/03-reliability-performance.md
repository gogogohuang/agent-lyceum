# 03 可靠性與效能

狀態：已實作並提交於分支 `chore/03-reliability-performance`（PR #40）。

## 3.1 `ps` / `which` 的外部程序依賴

**問題**
- `src/project-lock.ts:34` `pidStart()` 用 `ps -o lstart=` 判斷程序啟動時間，用來辨識 PID 被重用。輸出格式隨 locale 與 `ps` 實作而異；精簡容器可能沒有 `ps`，此時回傳 `undefined`，PID 重用的防護就失效。
- `src/policy.ts:129` 以 `which bwrap` 偵測沙箱；沒有 `which` 的環境會被誤判為沒裝 bwrap。

**需求**
1. `pidStart`：Linux 優先讀 `/proc/<pid>/stat` 的 starttime 欄位（搭配 `/proc/stat` 的 btime 或直接比較原始 tick 值，鎖檔記錄同一種表示法）；macOS 與讀取失敗時退回 `ps`。回傳值維持字串，鎖檔格式的相容性見下。
2. 鎖檔新增欄位若改變 start 表示法，必須讀得懂舊鎖：舊鎖的 start 與新算法不同值時，視為「無法比對」，退回只用 PID 存活判斷，不可誤判成 PID 已重用而搶鎖。
3. `osSandboxAvailable`：改為掃描 `process.env.PATH` 找可執行的 `bwrap`（`fs.accessSync(..., X_OK)`），不依賴 `which`。
4. 兩者都要可在測試中注入（參數或模組內可替換的函式），避免測試依賴真實系統。

**驗收**
- 單元測試：以假的 `/proc` 內容與假的 PATH 驗證解析。
- 既有 `project-lock.test.ts` 通過；新增「舊格式鎖不被誤搶」測試。

## 3.2 `log.jsonl` 與 `state.json` 成長

**問題**
- `dispatcher.ts:71` 以 `appendFileSync` 逐行寫 `log.jsonl`，無上限；長 run 的 `wake`、`route`、`integrate` 事件會累積。目前只有 dispatcher 寫、使用者手動看，沒有程式讀它，所以輪替不會破壞其他功能。
- `state.json` 每次 `saveState()` 整份重寫（`wake` 內每個 attempt 前後各一次），其中 `wakes` 陣列隨 run 線性成長。

**需求**
1. `log.jsonl` 超過 8 MiB 時輪替為 `log.1.jsonl`（只保留一份舊檔），輪替動作在寫入前檢查大小。上限可由 `dispatcher.log_max_bytes` 設定，預設 8 MiB；`0` 代表不限制。
2. `state.json` 的 `wakes` 保持現狀（`status` 與 monitor 依賴它的最近項目與統計），但 spec 要求先量測：用 500 輪的模擬 run 量 `saveState` 總耗時與檔案大小，若單次寫入超過 10 ms 或檔案超過 1 MiB 才進入下一步：把超過最近 200 筆的 wakes 搬到 `wakes.jsonl` 並在 state 內保留統計彙總。未達門檻則不改，並把量測結果寫進 PR 描述。
3. `RUN_ENTRIES`（`src/policy.ts:54`）加入 `log.1.jsonl`（與 `wakes.jsonl`，若實作），讓 agent 寫入政策與 `clear` 都認得。

**驗收**
- 測試：寫入超過上限後出現 `log.1.jsonl`，新檔從頭開始，事件不遺失、不重複。
- `clear` 刪除輪替檔。
- 量測腳本與結果附在 PR，不進 repo。

**量測結果（2026-10-07）：** 500 輪的模擬 run，單次 `saveRunState` 0.61 ms、`state.json` 281 KiB（100 輪：0.23 ms／56 KiB），未超過門檻（10 ms／1 MiB），因此不拆 `wakes`。

## 3.3 每輪重複掃描信箱

**問題**
`pendingAgents()` 對每個 agent 呼叫 `listUnread`，後者 `readdirSync` 並 `readFileSync` 解析每封信（`src/mailbox.ts:144-164`）。主迴圈每輪最少呼叫兩次（nudge 時三次），`wake` 內再對該 agent 掃一次。

**需求**
1. 新增 `hasUnread(project, agent)` / 或讓 `pendingAgents` 只用檔名排序決定順序與是否有未讀，僅在 `wake` 時才解析內容。
2. 排序依據維持現狀（第一封信的檔名），行為不得改變。

**驗收**
- 既有 dispatcher 與 mailbox 測試全數通過（行為不變）。
- 新測試：未讀信格式錯誤時，`pendingAgents` 仍把該 agent 列為待處理（以前由解析決定，現在由檔案存在決定；格式錯誤改由 wake 時的路徑處理，需確認結果與現況一致，若不一致，以現況為準）。

## 不做

- 不引入資料庫或新的儲存格式。
- 不改變信箱協定與 `schema_version: 2`。
