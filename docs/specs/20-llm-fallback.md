# 20 LLM 備援（failover）

狀態：已實作（計畫：docs/plans/2026-10-16-20-llm-fallback.md）。實作與原設計的差異見 20.12。

## 20.1 問題

- 使用者：「我想作 llm backup 機制」。
- 現況：每次呼叫 LLM 都走 `Invoker`（`src/adapters/types.ts`），唯一實作 `realInvoker` 啟動本地 CLI（`claude` 或 `codex`）。主要模型限流、額度用完、逾時或 CLI 崩潰時，只有 `RunSession.wake` 裡同 runtime、同 model 的重試迴圈（`retry`，預設 2，無 backoff，`src/run-session.ts`），三次都失敗就以 `agent_failed`／`lead_failed` 結束 run。
- 失敗只由離開碼與輸出判斷（`claude.ts`、`codex.ts`），`WakeResult` 沒有錯誤種類；限流、額度、認證、逾時全被一視同仁地重試。
- `call`（`src/call.ts`）單次呼叫，沒有重試也沒有備援。
- 沒有任何備援機制（repo 內 `backup`／`fallback` 字樣都與此無關）。

## 20.2 決議

| # | 決議 |
|---|---|
| 1 | 做 failover：主要 LLM 失敗時自動改用備用 LLM 繼續。不做雙模型互相驗證，也不做狀態備份（run 的續跑已由 `state.json` 與 mail 機制負責）。 |
| 2 | 只對暫時性失敗切換：`rate_limit`、`quota`、`timeout`、`network`、`crash`。`auth` 與輸出品質問題直接報錯，不切換。`unknown`（認不出的錯誤）照現況：同一個模型重試 `retry` 次後報錯，不切換。 |
| 3 | 備用來源是有序鏈，項目可以是同 runtime 的另一個 model，也可以是另一個 runtime（`claude-code` ↔ `codex`）。 |
| 4 | 設定兩層：agent 的 `fallback`（`team.yaml` 或 `project.yaml`，沿用 project 覆蓋 global 的優先序）與 `project.yaml` 的 `dispatcher.fallback`（該專案所有 agent 共用）。agent 沒設才用 dispatcher 那條；agent 設成空陣列 `[]` 表示這個 agent 不備援。 |
| 5 | 順序：`rate_limit`、`quota` 重試也沒用，直接切下一個；`timeout`、`network`、`crash` 先在同一個模型上重試 `retry` 次（加 backoff），仍失敗才切換。 |
| 6 | 切換後是全新 session：沿用 `retryPrompt` 附 Retry notice 重做這個 wake，未讀信件本來就會重新送達；不帶前一個模型的部分輸出。session id 以 `runtime+model` 為 key 存進 `state.sessions`，不與主要模型的 id 混用。 |
| 7 | 每個任務（wake）重新從主要模型開始，但主要模型因 `rate_limit` 或 `quota` 失敗後，在這次 run 內冷卻，期間所有 wake 直接從備用開始。冷卻表以 `runtime+model` 為 key、run 內共用（平行 wake 也共用，更新在單一同步點），存在 `state.json`，不跨 run。 |
| 8 | 載入設定時驗證（fail closed）：備用鏈裡任何項目的 adapter 若無法保證該 agent 的限制（`allow_web`、write-scope、worktree 隔離、`can_ask_user` 等），`validate` 報 `error`，拒絕載入。`doctor` 另外檢查備用鏈裡每個 CLI 是否已安裝並登入。 |
| 9 | `call` 與 `RunSession.wake` 共用同一個切換函式，不寫兩份。 |
| 10 | 呈現：切換時印一行並寫進 note；`failure` 多 `tried`；`status` 與 `log.jsonl` 標示（20.5）；monitor 只加小標記。 |
| 11 | 沒設 `fallback` 的專案行為完全不變（既有 `retry` 迴圈、`failure` 形狀的既有欄位不動）。 |

## 20.3 設定

```yaml
# project.yaml
dispatcher:
  fallback:                    # 全專案預設備援鏈（有序）
    - { model: sonnet }        # 同 runtime（由 model 推斷），省略 runtime
    - { runtime: codex, model: gpt-5, effort: high }
agents:
  reviewer:
    fallback: []               # 這個 agent 不備援
  web:
    fallback:
      - { runtime: claude-code, model: haiku }
```

- 項目欄位：`runtime?`、`model?`、`effort?`。`runtime` 省略時由 `inferRuntime(model)` 推斷，推斷不出來則沿用該 agent 的 runtime；`model` 與 `runtime` 都省略視為錯誤。`effort` 要符合該項目 runtime 的 `RUNTIME_EFFORTS`。
- `schema.ts`：`AgentPartial.fallback` 與 `DispatcherPartial.fallback` 為 `z.array(FallbackEntry)`；`ResolvedAgent.fallback: ResolvedFallback[]`（解析後 runtime、model、effort 都已填）。
- 優先序：agent 的 `fallback`（project 覆蓋 global）> `dispatcher.fallback` > 空。來源記進 `sources.fallback`，沿用現有設定來源表。
- 備援項目與主要模型相同（runtime 與 model 都一樣）視為錯誤，避免空轉。
- 預設值（本 spec 的建議，審稿時可改）：冷卻 `fallback_cooldown_sec: 300`，backoff 為 `5s、15s`（第 n 次重試等 `5 × 3^(n-1)` 秒，上限 60 秒）。兩者放 `DispatcherSettings`，`DISPATCHER_DEFAULTS` 給預設，`docs/configuration.md` 說明。

## 20.4 錯誤分類與切換流程

- `WakeResult` 新增 `kind?: ErrorKind`，`ErrorKind = "rate_limit" | "quota" | "timeout" | "network" | "crash" | "auth" | "unknown"`；成功時為 `undefined`。
- 每個 adapter 提供 `classifyError(out)`，放在 `claude.ts` 與 `codex.ts` 旁邊，輸入是離開碼、stdout／stderr 尾段與 `timedOut`，輸出 `ErrorKind`。比對規則（例如 `429`、`rate limit`、`overloaded`、`quota`、`insufficient`、`ECONNRESET`、`ENOTFOUND`、`401`、`not logged in`）寫成表，每條規則附一條來自真實輸出的樣本字串做單元測試。`process-runner` 的逾時固定為 `timeout`；spawn `ENOENT` 為 `crash`（鏈上下一個可能是別的 CLI，所以允許切換）。
- 新模組 `src/fallback.ts`（純邏輯，不碰 IO）：
  - `planAttempts(agent, cooldowns, now)` 回傳這次 wake 的候選序列：主要模型（若在冷卻中則略過）接上備援鏈（略過冷卻中的項目）。
  - `nextStep(kind, attemptOnCurrent, cfg)` 回傳 `retry-same | next-candidate | stop`，實作決議 2 與 5。
  - `Cooldowns`：`mark(key, kind, now)`、`active(key, now)`、`toJSON/fromJSON`。
- `RunSession.wake`：現有 `for attempt` 迴圈改為「對每個候選、依 `nextStep` 重試或前進」。`state.rounds`、`beginAttempt`／`finishAttempt`、`parkOutbox`、abort 與 `max_rounds` 的處理保持原樣，每次呼叫仍各算一輪、各有自己的 attempt 記錄。切換時 `say("  <agent> falling back to <runtime>/<model> (<kind>)")`，並 `note`。
- 備用候選的呼叫：用一份覆寫了 `runtime`、`model`、`effort` 的 `ResolvedAgent` 呼叫同一個 `invoke`；`buildInvocation` 本來就依 `agent.runtime` 分派，adapter 不必知道備援。
- `call`：同一個函式，傳入 `invoke`、agent、候選序列與 cooldown（單次呼叫用一個空的暫時冷卻表）。
- 冷卻：`rate_limit`、`quota` 發生時 `mark`；CLI 若回報 retry-after 則用它（上限 1 小時），否則用 `fallback_cooldown_sec`。冷卻只影響「是否先試主要模型」，不影響已在進行的 wake。
- 全鏈失敗：run 以現有的 `agent_failed`／`lead_failed` 結束；`failure` 形狀為 `{agent, error, attempts, tried?}`，`tried: {runtime, model, kind, error}[]` 依序列出每個試過的候選（只有設了備援才有此欄，舊形狀不變）。`failureGuide` 逐層列出，並提示 `agent-lyceum resume`。

## 20.5 呈現

- `state.wakes[]` 每筆新增 `runtime`、`model`、`fallback_from?`（被取代的 `runtime/model`）、`kind?`；`state.last_wake[agent]` 同步加 `runtime`、`model`。
- `log.jsonl` 的 `wake` 事件新增 `model`、`fallback_from`、`kind`（`runtime` 已存在，改為實際使用的 runtime）。
- `status`：每個 agent 顯示目前使用的 runtime／model，使用備用時標記 `fallback: <原因>`；冷卻中的主要模型顯示剩餘時間。`status --json` 只新增欄位（`runtime`、`model`、`fallback`、`cooldowns`），既有欄位不變。
- monitor（`docs/monitor.md` 描述的面板）：agent 卡片加一個「備援中」小標記，不改版面。

## 20.6 檔案與函式

| 檔案 | 變更 |
|---|---|
| `src/schema.ts` | `FallbackEntry`、`AgentPartial.fallback`、`DispatcherPartial.fallback`、`fallback_cooldown_sec`、`ErrorKind`；`DISPATCHER_DEFAULTS` |
| `src/config.ts` | 解析兩層 `fallback`、填滿 runtime／effort、`sources.fallback` |
| `src/validate.ts` | 20.2 決議 8、備援項目與主要相同、`effort` 與 runtime 不相容 |
| `src/adapters/types.ts` | `WakeResult.kind`、`classifyError` 型別 |
| `src/adapters/claude.ts`、`codex.ts` | `classifyError` 與規則表 |
| `src/process-runner.ts` | 逾時與 `ENOENT` 帶出 `kind` |
| `src/fallback.ts`（新） | `planAttempts`、`nextStep`、`Cooldowns` |
| `src/run-session.ts` | `wake` 迴圈改用 `fallback.ts`；`state.cooldowns`、`state.sessions` key；`failure.tried` |
| `src/run-store.ts` | `RunState` 新欄位（`cooldowns`、`wakes[].runtime/model/fallback_from/kind`）；舊 `state.json` 缺欄位時視為空 |
| `src/run-outcome.ts` | `failureGuide` 列出 `tried` |
| `src/call.ts` | 改走共用切換函式 |
| `src/status.ts`、monitor 前端 | 20.5 |
| `src/cli.ts`（`doctor`） | 檢查備援鏈 CLI 已安裝並登入 |

`state.sessions` 的 key 目前是 agent 名稱；改為 `agent` 名稱（主要模型，沿用，舊 state 可讀）與 `agent@runtime/model`（備用）兩種，讀取時主要模型先找舊 key。

## 20.7 測試

- 單元：兩個 adapter 的 `classifyError` 表（每條規則一個真實樣本）；`nextStep` 對每個 `ErrorKind` 的決策表；`Cooldowns` 的 mark／active／序列化；`planAttempts` 略過冷卻項目。
- fake runtime：擴充 `test/fixtures/runtime/fake-claude.mjs`（及 codex 的對應 fixture），以環境變數或第一行 prompt 指令模擬限流、額度、網路、崩潰、認證、逾時與成功。
- `run-lifecycle`：(a) 限流 ⇒ 不重試主要、直接切備用並完成；(b) 網路錯誤 ⇒ 主要重試 `retry` 次後切換；(c) `auth` 與 `unknown` ⇒ 不切換，報錯；(d) 全鏈失敗 ⇒ `failure.tried` 完整；(e) 冷卻 ⇒ 第二個 wake 直接從備用開始，且平行 wake 共用冷卻；(f) 切換後 session 用備用 key，不覆寫主要 key；(g) 切換後未讀信件不丟、`state.rounds` 與 attempt 記錄正確；(h) 沒設 `fallback` 時行為與輸出和現在逐字相同；(i) 舊 `state.json` 續跑。
- `call`：限流切換成功與全鏈失敗兩種。
- `validate`：不保證限制的備援項目被拒、effort 與 runtime 不符、備援與主要相同。
- `doctor`：備援 CLI 不存在時報告。

## 20.8 文件（中英成對）

- `docs/configuration.md` 與 `docs/configuration.zh-TW.md`：`fallback` 欄位、兩層優先序、`fallback_cooldown_sec`、哪些錯誤會切換。
- `docs/how-it-works.md` 與 `.zh-TW.md`：失敗處理一節加入備援流程與冷卻。
- `docs/commands.md` 與 `.zh-TW.md`：`status` 新欄位、`doctor` 新檢查。
- `docs/monitor.md` 與 `.zh-TW.md`：備援中標記。
- `README` 中英：一行功能說明。`scripts/check-docs.mjs` 通過。
- `docs/specs/README.md` 索引加入 20。

## 20.9 不採用的方案

- **雙模型同時跑互相驗證**：成本翻倍，且不是「主要掛了還能繼續」。
- **備份 LLM 的輸出或進度**：續跑已由 `state.json` 與 mail 重送負責。
- **未分類錯誤也切換**：會把認證或設定問題悄悄掩蓋成「換了模型」。
- **永久黏在備用模型**：主要恢復後仍用備用，品質與成本都悄悄變動；改用 run 內冷卻。
- **跨 run 持久化冷卻**：額度狀態會過期，寫進設定或全域狀態只會造成誤判。
- **把部分輸出塞給備用模型**：容易以錯誤上下文帶偏；未讀信件重送已足夠。
- **執行時才警告限制不符**：備援不應悄悄放寬限制，因此載入時 fail closed。

## 20.10 風險

| 風險 | 緩解 |
|---|---|
| 以輸出文字分類脆弱，CLI 改版就失準 | 規則表放在 adapter 旁、每條附真實樣本測試；認不出的歸 `unknown`，不切換，行為退回現況 |
| 備用 runtime 的權限模型不同，限制被放寬 | 載入時 fail closed；plan 階段逐項列出兩個 adapter 的能力表 |
| 備用模型是全新 session，脈絡中斷 | 沿用 `retryPrompt`，未讀信件重送；`resume: true` 的 agent 在切回主要模型時仍用原 session |
| 備用模型已產生副作用後主要又被重做 | 沿用既有「失敗輸出不信任、副作用可能已發生」的 note 文字；切換 note 也附同樣警語 |
| 平行 wake 同時發現限流，冷卻表競態 | 冷卻更新集中在 `RunSession` 單一同步點（Node 單執行緒，無 await 間隙） |
| 費用悄悄上升（備用較貴） | 切換一律印出並記 `log`；`status` 顯示；使用者自行選擇鏈的內容 |

## 20.11 分工

- node-engineer：`schema`／`config`／`fallback.ts`／`run-session`／`call`／`run-store`。
- adapter 負責人：兩個 adapter 的 `classifyError`、fake runtime 擴充。
- qa：20.7 測試。
- docs-writer：20.8，中英成對。

## 20.12 實作時的偏離

以下各點以實際程式為準，取代前文對應的敘述。

1. **retry-after（20.4）：** 這個版本不使用。沒有任何 adapter 提供 retry-after，冷卻一律是 `fallback_cooldown_sec`。
2. **doctor（20.2 #8、20.3）：** `doctor` 只檢查備援鏈裡的 CLI 是否已安裝，不檢查登入。備用 CLI 不存在時是 doctor 的警告（warning），不擋 run；啟動前的檢查（preflight）只看主要模型。
3. **write-scope 規則（20.2 #8）：** 只有在備用模型某一項的防護等級是 `prompt-only`、而主要模型的更強（`os`、`tool-rules`、`post-hoc`）時才 fail closed；備用模型為 `os`、`tool-rules`、`post-hoc` 都接受。
4. **`failure.tried`（20.4）：** 每個模型只列一次，內容是它最後一次的失敗，而不是每次呼叫一筆。
5. **冷卻（20.4）：** 只有 agent 設了備援鏈時才記錄冷卻；沒有備援鏈的行為與狀態和原本完全相同。
6. **codex 斷網（20.4）：** codex 在網路不通時會一直重連，直到逾時，所以實際表現為 `timeout`；它的 `network` 分類在實務上幾乎碰不到。
7. **`state.sessions` 的 key（20.4）：** 主要模型的 key 維持 agent 名稱，備用模型是 `agent@runtime/model`。
