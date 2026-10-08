# 09 人工問答（human-in-the-loop）

狀態：設計已與使用者逐題確認（brainstorming），尚未實作。

## 9.1 問題

- 現在遇到未定事項，lead 只能猜、或把 run 以 `partial`／`blocked` 結束，使用者沒有「回答後接續」的出口。
- 同類專案（LangGraph interrupt、AutoGen `UserProxyAgent`、OpenHands 確認模式）都提供暫停等人的機制。

## 9.2 決議

| # | 決議 |
|---|---|
| 1 | 新信件類型 `type: ask`。提問者預設只有 lead；成員需在 agent 設定開 `can_ask_user: true`（預設 `false`，lead 預設 `true`）。其餘成員的疑問仍回信給 lead。 |
| 2 | 問題與回答放在**一封固定信件**：`runs/<run-id>/mail/ask-reply.md`，一個 run 只有一封，批次提問都寫在裡面。內容用 XML 標籤（見 9.3）。 |
| 3 | dispatcher 驗證 `ask` 後轉寫進 `ask-reply.md`，run 進入新狀態 `waiting`，行程結束、專案鎖釋放。結束碼 `3`（與 `0`／`1`／`2`／`130` 區分）。等待期間不消耗 `max_rounds`。 |
| 4 | 回答有兩條路並存：`agent-lyceum answer <run-id> -p <project>`（用 `$EDITOR` 開信、存檔後驗證、通過即自動 resume；`--no-edit` 只驗證已手動改好的信），或使用者自己直接編輯信件後執行 `answer --no-edit` 或 `resume`。進入等待時，終端機輸出與 `status` 都印出信件完整路徑。 |
| 5 | 互動式終端機（TTY）：`run`／`resume` 進入 `waiting` 時直接開編輯器，等於內建執行一次 `answer`。非互動環境印出路徑後結束。 |
| 6 | 驗證通過後，dispatcher 把整理好的 `<answers>` 區塊作為 `type: reply` 信送給提問者，再繼續 run。`resume` 遇到 `waiting` 但未答完時拒絕，並列出缺哪題。 |
| 7 | 預設一律等待。`run`／`resume`／`answer` 加 `--assume-defaults` 時，沒填答案但有 `<suggested>` 的題目採用建議值並標記 `by="default"`；沒有建議值的題仍然等待。 |
| 8 | `ask` 格式錯誤（XML 無法解析、題目缺 `id` 或 `text`、重複 `id`、超過 10 題）退回提問者，最多 2 次，之後視為 `failure` 回報 lead（與 `done` 驗證一致）。 |
| 9 | 追加新一批題目時在同一個根標籤內加新的 `<question>`，已回答的保留；根標籤的 `round` 只記最近一批。 |

## 9.3 信件格式

```xml
<ask-reply status="pending" asked_by="lead" round="7">
  <question id="q1">
    <text>登入要用 session 還是 JWT？</text>
    <options>
      <option>session</option>
      <option>jwt</option>
    </options>
    <suggested reason="既有程式已用 cookie">session</suggested>
    <answer></answer>
  </question>
  <question id="q2">
    <text>要不要支援舊版 API？</text>
    <answer></answer>
  </question>
</ask-reply>
```

- 使用者只需填 `<answer>`。選項題填其中一個選項，或以 `other:` 開頭寫自訂文字；沒有 `<options>` 表示開放式。
- 驗證是機械式的：每題有唯一 `id`、`<answer>` 非空、選項題的答案必須是選項之一或以 `other:` 開頭。全部通過後 `status` 改為 `answered`。
- 回答來源以 `<answer by="user">`／`<answer by="default">` 標記。
- 送給提問者的 `reply` 信內容是同格式的 `<answers>` 區塊。

## 9.4 影響的檔案

- `src/message-store.ts`、`src/mailbox.ts`：`ask` 類型、`can_message` 之外的 `can_ask_user` 檢查、轉寫 `ask-reply.md`。
- 新增 `src/ask-reply.ts`：XML 解析、驗證、追加批次、套用預設值。
- `src/schema.ts`、`src/config.ts`、`src/validate.ts`：`can_ask_user` 欄位與預設、`waiting` 狀態、結束碼 `3`。
- `src/run-session.ts`、`src/run-outcome.ts`：進入／離開 `waiting`、不消耗 `max_rounds`、釋放鎖。
- `src/cli.ts`：`answer` 指令、`--assume-defaults`、TTY 時內建編輯流程、`resume` 的驗證。
- `src/prompt.ts`：協議新增 `ask` 規則（遇到會改變方向且無法從程式碼或記憶推斷的事項才問，一次批次問完，盡量附選項與 `suggested`）。
- `src/status.ts`：顯示 `waiting`、未答題數與信件路徑；status-monitor 同步顯示。
- `README.md`、`README.zh-TW.md`、`docs/commands.md`（含 zh-TW）：新指令、新結束碼、`can_ask_user`。

## 9.5 驗收

先寫失敗測試再實作：

1. `ask-reply.ts`：解析、選項驗證、`other:`、缺答案、重複 `id`、超過 10 題、追加批次保留已答題。
2. lead 送 `ask` 後 run 進入 `waiting`、鎖釋放、結束碼 `3`、`max_rounds` 未增加。
3. 非 `can_ask_user` 的成員送 `ask` 被拒並通知。
4. `answer --no-edit`：缺答案拒絕並列題；全部答完後送出 `reply` 並自動 resume。
5. `--assume-defaults`：有建議值者採用並標 `by="default"`，無建議值者仍等待。
6. `resume` 在未答完時拒絕。
7. 格式錯誤的 `ask` 退回兩次後轉為 `failure`。
8. `status --json` 含 `waiting` 與信件路徑。
9. 整合測試：用 `test/fixtures/runtime/fake-claude.mjs` 跑完 ask → waiting → answer → completed。
10. 沒有 `ask` 的既有 run 與測試行為不變，舊 run 可讀。

## 9.6 範圍外

由 agent 設定逾時自動採用預設值、多人同時回答、從 Slack／網頁回答、成員直接對使用者即時對話。
