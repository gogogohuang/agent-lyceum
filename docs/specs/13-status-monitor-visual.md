# 13 status-monitor 圖形化面板

狀態：已實作（plan：docs/plans/2026-10-13-13-status-monitor-visual.md）。

## 13.1 問題

- `plugins/status-monitor` 的面板是純文字清單（Ink `Text`）：輪次、步驟、各 agent 的統計與最近喚醒各占幾行。要知道「現在誰在做什麼、誰在等誰、剛收到什麼」得自己從多行文字拼起來。
- 團隊的結構（誰能寄信給誰）完全沒有呈現，雖然它由 `can_message` 決定，也是理解信件流向的關鍵。
- 信件內容只有一行 `brief`（`briefOf()` 取 Goal／Changes 下第一行）。排隊中的信（`queue`）連 `brief` 都沒有，看不出內容。

## 13.2 決議

| # | 決議 |
|---|---|
| 1 | 面板改成**每個 agent 一個區塊**；區塊之間依 `can_message` 畫關係。範圍只在 Claude Code 面板內的終端機圖形，不做瀏覽器儀表板。 |
| 2 | 區塊顯示該 agent「正在做什麼」與「收到的信件內容」，信件內容轉成可閱讀的重點段落（見 13.3 的 `digest`），不顯示全文。 |
| 3 | `status --json` 的 `AgentReport` 新增 `can_message: string[]`：設定裡的 `all` 展開成其他所有 agent，並排除自己。 |
| 4 | `status --json` 的 `handling`（進行中與每次喚醒）與 `queue` 的每封信新增 `digest`。`brief` 保留不動。 |
| 5 | 只加欄位，`schema_version` 維持 `1`。新面板遇到沒有 `can_message` 或 `digest` 的舊 CLI 要能運作（見 13.5）。 |
| 6 | 保留現有文字版，面板內按 `v` 在圖形版與文字版之間切換。 |
| 7 | 版面計算與 `digestOf` 寫成純函式並用 vitest 測；Ink 元件只做薄薄一層。不新增依賴。 |

## 13.3 CLI 端：`digestOf`

新函式 `digestOf(type, body)` 放在 `src/format.ts`（與 `briefOf`、`sectionText` 同處，重用 `sectionText`）。回傳 `{ label: string; lines: string[] }[]`。

| 信種 | 取哪些段落（`##` 標題，不分大小寫） |
|---|---|
| `task` | Goal、Acceptance criteria |
| `reply` | Changes、Verification；Open items 與 Risks 只有內容不是 `None` 才出現 |
| `done` | Result、Not done |
| `ask` | 每一題 `<text>` 的內容（label 用題目 id） |
| `failure` | 內文第一段（label 為「訊息」） |
| 其他或沒有任何符合的標題 | 退回 `briefOf(body)`（label 為「摘要」）；連它也沒有則回傳 `[]` |

規則：

- 每段最多 3 行；超過就在最後一行加 `…`。
- 每行去掉 markdown 符號：行首的 `-`、`*`、`[ ]`／`[x]`，以及 `**`、`` ` ``，之後截到 80 字。
- 空段落與整段是 `None`（不分大小寫、可帶句點）的段落略過。
- `[agent-lyceum]` 開頭的警告行略過（與 `briefOf` 相同）。
- 解析失敗不丟錯：回傳 `[]`，面板退回顯示 `brief`。

`run-session.ts` 在組 `handling` 時除了 `brief` 一併寫入 `digest`；`status.ts` 的 `QueueItem` 與 `ActiveWake.handling` 型別加 `digest?`，並在建 `queue` 時讀出信件本文產生 `brief` 與 `digest`。`wakes[].handling` 已存在於 state.json 的欄位自然帶出，舊 run 沒有 `digest` 就是缺欄位。

`can_message` 在 `status.ts` 組 `AgentReport` 時由 `ResolvedProject` 的 agent 設定展開。

## 13.4 面板版面

```
┌ lead ─ claude-code ─ ● 進行中 #7 1m05s ┐
│ 處理 fe-member 的 reply：登入頁 UI 完成   │
│   Changes  新增 src/web/login.tsx          │
│   Verification  tsc --noEmit 通過          │
│ ▓▓▓▓░░ 12.3k tok · 喚醒 3 次               │
└───────┬──────────────┬───────────────────┘
        │              │
┌ fe-member ─ codex ┐ ┌ qa-member ─ claude-code ┐
│ ○ 閒置            │ │ ◐ 排隊 1 封             │
│ ...               │ │   task 為登入頁寫測試   │
└───────────────────┘ └─────────────────────────┘
```

連結符號只畫 lead 與成員之間（▼ ▲ ↕）；每個區塊底部的「→」一行列出該 agent 的所有 `can_message` 對象（含 lead 與成員之間的），最近的一次標 ●。

- 上方保留步驟進度條與輪次進度條；下方保留備註、受阻整合與結果摘要（現有內容，改成緊湊呈現）。
- lead 的區塊在上，其他成員在下面一排，排不下就換行。
- 關係線依 `can_message`：lead 與每位成員之間（一般是雙向）用連線畫出；成員之間的邊，以及線會交錯的情況，不畫線，改在區塊底部標「可寄給：…」。
- 最近一次實際寄出信件的那條邊（取自 `wakes[].sent`）用強調色標出。
- 區塊標題列：名稱、runtime、lead 標記、狀態點。狀態點：進行中（綠）、排隊中（黃）、閒置（灰）、上次喚醒失敗（紅）。
- 區塊內文：進行中顯示輪次與已經過時間，其下是正在處理的每封信（`來自 X 的 type：主旨`，接 `digest` 各段）；排隊的信用同格式縮成每封一到兩行。底部是 token 長條、喚醒與失敗次數。

## 13.5 窄面板、舊資料、切換

- 面板寬度不足（暫定少於 70 欄）：區塊直向堆疊，不畫連線，每個區塊底下一行「→ 可寄給：…」。
- `can_message` 缺失（舊 CLI）：不畫關係線，其餘照常。
- `digest` 缺失：顯示 `brief`；兩者都沒有就只顯示主旨。
- `v`：圖形版 ↔ 文字版（現有畫面原樣保留），選擇存在 plugin 的 atom，不寫檔。

## 13.6 影響的檔案

- `src/format.ts`：新增 `digestOf`。`src/run-session.ts`：`handling` 加 `digest`。`src/status.ts`：`AgentReport.can_message`、`QueueItem`／`ActiveWake.handling` 的 `brief`／`digest`。
- `plugins/status-monitor/types/index.d.ts`：同步型別（`Agent.can_message?`、`Mail.digest?`）。
- `plugins/status-monitor/hooks/`：新增純函式模組（版面計算、區塊內容、強調邊的判斷）與對應測試；`register.tsx` 加圖形版元件與 `v` 切換。
- `test/`：`digestOf`、`status --json` 的新欄位。
- `docs/commands.md`、`docs/commands.zh-TW.md` 的 `status --json` 說明與 README 的 mod 一節（中英文結構一致）。

## 13.7 驗收

- `digestOf`：`task`、`reply`、`done`、`ask`、`failure` 各一份範例信，輸出符合 13.3；`None` 的段落被略過；超過 3 行會加 `…`；空本文與畸形本文回傳 `[]`。
- `status --json`：每個 agent 有 `can_message`（`all` 已展開、不含自己）；進行中、排隊中、每次喚醒的信有 `digest`；`schema_version` 仍為 `1`；沒有用到的舊測試不用改。
- 版面純函式：寬、窄兩種寬度；一位成員、多位成員換行；成員間有邊與沒有邊；沒有 `can_message`；沒有任何進行中的 run。
- 實際開面板看過：有進行中的 agent、有排隊的信、有失敗的喚醒時，畫面與 13.4 相符；`v` 可切換；窄面板可讀。
- `npm run typecheck`、`npm test`、`npm run check:docs`、`npx biome check src` 全過。

## 13.8 範圍外

- 瀏覽器儀表板、任何本機 server。
- 按真實時間排列的時間軸（喚醒紀錄沒有開始時間，只有耗時）。
- 信件全文、可點開的信件檢視。
- 多專案同時顯示時的跨專案關係（沿用現有每個任務一個頁籤）。
- `can_message` 之外的關係（例如 `owns` 重疊）。
