# 評估：讓 lead 的行程在回合之間留著

日期：2026-10-29。結案：**不做**。沒有修改程式。契約在 [spec 26](../specs/26-lead-parked-session.md)；量測見附錄 A。不再量測、不開工。

- 程式行號以 `a722ac1` 為準。
- 數字分三類：**觀察**（repo 裡已寫下的量測或本機 `claude --help`／`claude -p --help`／`codex exec --help` 的文字）、**推論**（用那些數字做的算術）、**未驗證**（真實 runtime 還沒跑過）。
- 「輸入等價」用 API 權重粗算：cache 讀取 × 0.1、輸出 × 5。這不是 `claude /usage` 的 5 小時百分比，也不是訂閱制的實測計價。

## 1. 結論

- **值得寫成 spec，不值得直接改 dispatcher。** 省下的是 lead 第二次以後把整段 session 再讀一遍的 cache。成員的喚醒、lead 的輸出、lead 的第一次喚醒都不在裡頭。
- **帳面最大的一筆約是該次 run 的 28% 輸入等價**（65 次喚醒那次，推論，算法在 §3）。另一個算法把偏大的 cache 全算在 lead 身上，會到約 57%。兩個數差一倍，因為現有的 `state.json` 沒有把 cache 拆開到 lead。
- **這筆能不能入帳取決於 CLI。** 同一個行程若仍把舊對話計成 cache 讀取，省下的是 0。`claude -p` 的說明同時寫了「印完就退出」和「stream-json 即時輸入、每一回合之後」（觀察，§2）。
- **量測閘（2026-10-29，觀察，附錄 A）。** 同一支 `claude -p` 在第一個結果之後仍活著，第二回合記得短字，`cache_read` 從 649 降到 0（低於 20% 門檻）。同一回合卻新寫了 103,862 的 cache（第二個 `system/init` 把工具從 0 個變成 119 個）。空等 60 秒時 Current session 從 73% 升到 75%。規格 26.9：超過 1 個百分點就不做 D-03 以後。
- **結案：** 停駐不做。協定能跨回合，省 cache 這一筆沒入帳。Codex lead 維持現狀。不再跑同一前綴的第二輪閘。

## 2. 現況

一次喚醒是一個會結束的子行程。

- Claude 用 `claude -p`，prompt 從 stdin 送進去，stdin 隨即關閉（`src/adapters/claude.ts:77-96`、`src/process-runner.ts:284`）。有 session id 才加 `--resume`（`src/adapters/claude.ts:90`）。`--resume` 是下一次新行程，不是把舊行程留著。
- runner 等行程結束才解析結果，timeout 與取消都會殺掉整個 process group（`src/process-runner.ts:166-169`、`:225-232`、`:273-284`）。
- dispatcher 在 `wake()` 返回之後才 `settle()`：還原違規寫入、把成員檔案併進 lead 的樹、投信（`src/run-session.ts:1289`、`:1324`、`:887-889`）。
- lead 信箱有未讀時，這一批只有 lead（`src/run-session.ts:625-630`）。成員不會跟 lead 同時做。
- lead 預設 `resume: true`，成員預設每次新 session（`src/config.ts:275`）。

`claude -p --help`（2026-10-29，本機）寫了：

- `-p`：「Print response and exit」。
- `--input-format stream-json`：「realtime streaming input」，只搭配 `--print`。
- `--output-format stream-json`：「realtime streaming」。
- `--prompt-suggestions`：在 print／SDK 模式「after each turn」送出建議。
- `--bg`／`attach` 是背景工作階段加終端機接上。說明寫：session 已在跑時再 `--resume`，會另外開一份複本。

`codex exec --help` 的同一輪輸出裡，輸入是一份 stdin prompt，續接是子指令 `resume`。沒有看到與 stream-json 對等的多回合輸入。

## 3. 能省多少

材料（觀察，出處都是 repo 裡已寫的量測，不是這次新跑的）：

| 材料 | 數字 | 出處 |
|---|---|---|
| 3 次 run | 輸出約 15.6 萬、cache 讀取約 1,250 萬、每次喚醒約重讀 30 萬 | `docs/configuration.md` 的 Saving tokens |
| 28 次有記錄的喚醒 | cache 讀取中位數 343,591 | `docs/analysis-context-sharing-need.md` |
| 一次 65 喚醒的 run | lead 27 次、輸出 853,648、cache 讀取 94,694,908 | `docs/evaluations/graph-engineering.md` 附錄 A |

65 次那次的輸入等價（推論）：

- cache：94,694,908 × 0.1 = 9,469,491
- 輸出：853,648 × 5 = 4,268,240
- 合計 13,737,731，約 **1,374 萬**

**算法 A（每次喚醒的 cache 一樣大）。** lead 佔 27／65。lead 的 cache 約 3,933 萬。留下第一次、拿掉後面 26 次重讀：約 3,788 萬 cache，約 **379 萬輸入等價**，約該次的 **28%**。

**算法 B（中位數 34 萬是成員，多出來的 cache 都在 lead）。** 38 次成員 × 343,591 ≈ 1,306 萬，lead 約 8,164 萬。拿掉 26／27：約 7,861 萬 cache，約 **786 萬輸入等價**，約該次的 **57%**。中位數來自另一批 28 次喚醒，不是這 65 次的拆帳，所以 B 比 A 弱。

小 run 的單位（推論）：一次 30 萬 cache 的重讀約 **3 萬輸入等價**。13 輪裡有 6 輪是 lead 收信或再派工（`docs/configuration.md`）。若其中 5 次是後續重讀，約 **15 萬輸入等價**。

不在這筆裡的：

- 成員每次仍是新行程。
- lead 每一回合的輸出仍要付。算法 A 裡 lead 若也佔 27／65 的輸出，約 35 萬 output，輸入等價約 177 萬，停駐省不到。
- 新一回合的信內文仍要送。一次喚醒的內文合計最多 64 KiB（`src/prompt.ts` 的 `MAIL_BATCH_LIMIT`）。
- 5 小時用量的百分比換不出來。adapter 沒有把 token 換成 `claude /usage` 的 Current session。

## 4. 為什麼不能讓行程一直佔著

lead 的行程若不退出、也不進入「這一回合已結束」的停駐，`settle()` 不會跑，成員不會被叫，新回信也進不了 prompt。停駐要的是：**模型這一回合說完了，行程還在，dispatcher 可以去整合與叫成員。** 模型還在跑工具的時候，批次規則維持現狀，這一批只有 lead。

`--bg` 不適合當這個機制。它是給人 attach 的終端機工作階段，而且說明寫了已在跑的 session 再 resume 會開複本。dispatcher 若在舊行程還活著時又 spawn 一次，就會變成兩份 lead。

## 5. 建議

1. 量測閘已跑過（附錄 A）。26.3 的三個 token 條件成立；26.9 的空等用量不成立。停駐不做，28%／57% 維持假設。這條工作結束。
2. 閘只覆蓋 `claude-code`。Codex lead 維持 `exec`／`exec resume`。
3. 不把「直接轉交回信」放進這份設計。那一跳的帳面約 3–5 萬輸入等價，而且審查者看不到原任務（見同一次討論；此處不重開）。
4. `feat/lead-reply-batch`（lead 依 64 KiB 內文預算一次讀完已在等的回信）是另一條改動。停駐的一回合吃 `pickMessages` 的結果，不依賴「最多 5 封」是否還在。
5. 同一前綴會不會變成 cache 讀取，不再量。

## 附錄 A. 量測閘 2026-10-29

CLI：`2.1.312 (Claude Code)`。目錄：`/tmp/lyceum-gate`。PID `97993`，session `2f32ee7b-7b31-4c60-8035-f865c7ffa9ac`。stdin 形狀（執行檔裡的候選，這次 CLI 接受了）：`{"type":"user","message":{"role":"user","content":"…"}}`。

啟動（比 spec 26.3 多了兩面旗標：`--verbose` 是這個版本的硬性要求；`--tools ""` 想讓回合維持純文字，結果只作用在第一個 `init`）：

```text
claude -p --verbose --input-format stream-json --output-format stream-json --permission-mode dontAsk --tools ""
```

| 檢查 | 結果 |
|---|---|
| 旗標組合被接受 | 是。stderr 空 |
| 第一回合後行程仍在 | 是。PID 97993 |
| 空等 60 秒後行程仍在 | 是 |
| 第二回合同一 PID、同一 session | 是 |
| 回答含 `k7m-gate-29` | 是（`result` 就是這個字） |
| 第二回合 `cache_read` < 第一回合的 20% | 是：0 / 649 = 0 |
| 空等時 Current session 升幅 ≤ 1 個百分點 | 否：73% → 75%（+2） |

第一回合 `usage`（結果事件原文）：

```json
{"input_tokens":2,"cache_creation_input_tokens":4024,"cache_read_input_tokens":649,"output_tokens":95,"cache_creation":{"ephemeral_1h_input_tokens":4024,"ephemeral_5m_input_tokens":0}}
```

第二回合 `usage`（結果事件原文）：

```json
{"input_tokens":2,"cache_creation_input_tokens":103862,"cache_read_input_tokens":0,"output_tokens":10,"cache_creation":{"ephemeral_1h_input_tokens":103862,"ephemeral_5m_input_tokens":0}}
```

`system/init`：第一回合 `tools: []`；第二回合 119 個工具（本機 MCP：Atlassian、Figma、Claude Docs 等）。第二回合的 cache 寫入對應這次前綴變大，不是把第一回合的 4,024 token 再讀一遍。

`claude /usage`（與 `src/quota.ts` 相同的 `claude -p --no-session-persistence --output-format text /usage`）：

- 閘前：Current session 73% · Current week 94%
- 第一回合後：Current session 73% · Current week 94%（24h：1587 requests / 73 sessions）
- 空等 60 秒後、第二回合前：Current session 75% · Current week 94%（24h：1595 requests / 73 sessions）

空等那一分鐘 24h 請求 +8，這台機器同時有別的 session。+2 個百分點不能單獨算在停駐行程上，規格 26.9 仍把「> 1 個百分點」寫成停工條件。

CLI 自己報的 `total_cost_usd`（第二個結果事件是累計）：第一回合 0.017、兩回合合計 0.433。多出來的幾乎都是第二回合那 103,862 的 cache 寫入。

判讀：26.3 的三個 token 條件通過；省下 lead 後續 cache 重讀這筆沒有出現；26.9 的空等條件失敗。D-03 以後不實作。
