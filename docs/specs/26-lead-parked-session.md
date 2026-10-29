# 26 lead 停駐（回合之間留下同一個 Claude 行程）

狀態：**不做**（2026-10-29）。量測閘已跑過：協定能跨回合，省 cache 沒入帳，空等用量上升。D-03 以後不實作、不改 dispatcher、不再量測。評估：[lead 停駐](../evaluations/lead-parked-session.md)。

行號以 `a722ac1` 為準。真實 `claude`／`codex` 的行為，除了該日 `--help` 的文字，都標**未驗證**。`claude -p --help` 同時寫了「Print response and exit」與「stream-json 即時輸入、after each turn」。本 spec 不規定 stream-json 的 JSON 形狀；形狀以閘跑出來的紀錄為準。

## 26.1 目標與限制

**目標：** `resume: true` 的 Claude lead，在同一輪 run 裡用同一個子行程跨多個回合。成員做工的時候這個行程停著（模型沒有在跑），成員的回信作為下一回合的使用者訊息送進同一個行程。要省的是 lead 第二次以後整段 session 的 cache 重讀。

**非目標：**

- 成員停駐。成員維持每次新 session（`src/config.ts:275`）。
- Codex lead。`codex exec` 這次說明沒有多回合輸入；Codex lead 繼續一封 prompt、一個行程。
- 用 `--bg`／`attach`。那是終端機工作階段；已在跑的 session 再 resume 會開複本。
- 改星狀信路、`can_message`、worktree 整合順序、信件格式、`MAIL_BATCH_LIMIT`。
- 直接把作者的 reply 轉給下一手。
- 把 lead 的 session 切掉換新（那是另一種省法，不在這份）。
- 讓模型還在跑的時候與成員平行。停駐只發生在回合已結束之後。

## 26.2 決議總表

| # | 決議 | 理由 |
|---|---|---|
| D-01 | 只有 `runtime: claude-code` 且 `resume: true` 的 lead 可以停駐。其餘 agent 的喚醒與今天相同 | 成員要的是乾淨 context；Codex 沒有對等輸入。lead 預設就是 `resume: true` |
| D-02 | 量測閘不過，D-03 以後都不做 | 省下的 cache 未驗證。不過閘時現況就是對的行為 |
| D-03 | 停駐 = 同一個 PID 還在、這一回合的結果已經解析完、模型沒有未完成的工具呼叫、stdin 仍開著 | 行程還在才有可能不重送歷史；回合沒結束就不能 `settle` |
| D-04 | 停駐中的 lead 不算 `pickBatch` 的一批。它的未讀信不 spawn 第二個 Claude | 說明寫了已在跑的 session 再 resume 會開複本（`src/run-session.ts:625-630`） |
| D-05 | 下一回合只送「這次要處理的信」那段，外加自上一回合以來整合進來的路徑清單。`COMMON.md`／records 的檔案 mtime 有變才重送現有的截斷視圖；沒變就不送 | 系統提示在行程啟動時已經給過。每次重送整包就回到今天的重讀 |
| D-06 | 行程死了、第二回合寫不進去、或閘沒留下可用的事件紀錄：關掉殘行程，改走今天的 `--resume` 新行程。記一次 `park_lost` | 失敗要回到已上線的行為，而不是停住整輪 run |
| D-07 | `wake_timeout_sec` 只計算一回合：從把使用者訊息寫進 stdin 到該回合結果解析完。停駐等信的時間不算 | 今天的 timeout 會殺掉整個 process group（`src/process-runner.ts:238`）。停駐若沿用，第一個空檔就會被殺掉 |
| D-08 | 換模型（備援或 tier step-up）時殺掉停駐行程，新模型用自己的新行程 | 一個行程綁一個模型。跨模型續接未驗證，spec 24 已拒絕 |
| D-09 | 不升 state `schema_version`，不改信件格式。停駐只活在這個 dispatcher 行程的記憶體裡。dispatcher 自己死了就不會去接舊 PID；`resume` run 時用已記下的 session id 開新行程 | 重接活著的 PID 在崩潰之後站不住 |
| D-10 | `settle()` 跑完才可以寫下一回合。整合仍在「任何人讀信之前」做完（`src/run-session.ts:887-889`、`:1324`） | 停駐的 lead 若在整合寫到它的 worktree 時還在跑工具，兩邊會一起改同一棵樹 |
| D-11 | 一回合處理的信 = 今天的 `pickMessages` 回傳值。不在這份 spec 改批次上限 | `feat/lead-reply-batch` 若併入，一回合可能多於 5 封；停駐不依賴那個數字 |
| D-12 | 測試用假的行程協定，不斷言 Claude 的 JSON 形狀。真的 CLI 只出現在閘，而且是手動的 | 形狀未驗證。把猜的 schema 寫進測試會鎖錯 |

## 26.3 量測閘

手動，花一次真實 `claude -p` 的額度。不進 CI。

1. 用與正式喚醒相同的權限方向（`--permission-mode dontAsk`、stdin 不關）啟動**一支** `claude -p --input-format stream-json --output-format stream-json`。旗標組合若被 CLI 拒絕，閘失敗。
2. 第一回合問一件只有這次對話知道的事（例如一個隨機短字）。記下 PID、session id、該回合結果裡的 `cache_read`／`cache_write`／output。欄位名稱以 CLI 實際印出的為準；印不出 cache 欄位，閘失敗。
3. 不關行程。第二回合問那個短字是什麼。
4. **通過**要三件同時成立：PID 與第一回合相同；回答含那個短字；第二回合的 `cache_read` < 第一回合的 20%。
5. 20% 的理由：新回合的內文遠小於一次 30 萬 token 的重讀。整段重送時，第二回合的 cache 讀取會接近第一回合，過不了 20%。
6. 通過與失敗都把原始用量行貼回評估文件的附錄，並寫明 CLI 版本（`claude --version`）。不過：spec 停在本節，D-03 以後不實作。

## 26.4 行程

### 26.4.1 啟動

lead 的第一次 Claude 喚醒，在閘通過後改為：

- `claude -p --input-format stream-json --output-format stream-json`，加上今天已有的 `--permission-mode dontAsk`、`--settings`、`--append-system-prompt-file`、`--model`、`--effort`、`--add-dir`。
- **不**在送完第一份 prompt 後關 stdin。
- 第一份使用者訊息的內容與今天的 `buildUserPrompt` 相同。系統提示仍只在啟動時附上。

`--resume` 只用在 D-06 與 D-09 的新行程，不用來把第二回合送進已經活著的 PID。

### 26.4.2 回合結束

runner 今天把 `exit`／`close` 當成唯一的完成（`src/process-runner.ts:273-284`）。停駐要多一種完成：**stdout 上出現這一回合的結果事件，且沒有未完成的工具呼叫，行程仍在。** 結果事件的判準用閘錄到的欄位，不在這份 spec 先猜。

這一回合的 `WakeResult`（session id、output token、cache 讀寫、是否成功）在這個邊界就記入 `state.wakes[]`，與今天一次 `wake()` 相同。`state.rounds` 仍是每次嘗試加一。

### 26.4.3 下一回合

`settle()` 之後，若 lead 有未讀信且行程仍停駐：把 `pickMessages` 選中的信渲染成使用者訊息寫進同一個 stdin。被選中的信沿用今天的 claim：這一回合成功結束才 `commitClaim`；寫入 stdin 失敗則 `abandonClaim`，信留著未讀，並走 D-06。

使用者訊息包含：

- 與今天 prompt 相同的「這次要處理的信」區塊（含 16 KiB／64 KiB 截斷）。
- 上一回合 `settle` 整合進來的 repo 相對路徑，一行一個。沒有就寫 `None`。
- `COMMON.md` 與兩種 records 檔的 mtime 集合若與啟動後（或上次送出後）不同，附上今天 `buildUserPrompt` 的那幾段截斷視圖。相同則省略。

### 26.4.4 結束與取消

run 結束、取消、D-06、D-08：對停駐行程走今天的 process group SIGTERM，寬限後 SIGKILL（`src/process-runner.ts:225-232`）。不留下背景 Claude。

## 26.5 dispatcher

主迴圈在 `pickBatch` 之前多一個停駐檢查：

1. lead 正在跑一個回合：行為與今天相同。這一批若會叫到 lead，就等它，不另開行程。
2. lead 停駐且信箱有未讀：不把 lead 放進 `pickBatch`。先讓沒有 lead 的那一批成員跑完並 `settle`（成員信箱有信時）。成員那一批 `settle` 完，再送 lead 的下一回合（§26.4.3）。
3. lead 停駐且沒有未讀：成員照今天的規則平行跑。lead 的行程留著。
4. 沒有停駐：與今天相同，包含「lead 有未讀就只有 lead」。

同一時間仍然只有一個 lead 回合或一批成員，沒有第三種重疊。

`leadWasLast` 與「沒有 done 就 nudge」維持今天的規則。nudge 在停駐時是送進現有行程的一封 `failure`，不另 spawn。

## 26.6 失敗

| 情況 | 行為 |
|---|---|
| 閘沒過或未做 | 不啟用停駐 |
| 啟動時 CLI 拒絕 stream-json | 這輪 run 改回今天的一封一行程，記一次 `park_unavailable` |
| 回合 timeout | 只中止這一回合的等待；若行程還在且 stdin 可寫，記失敗並 D-06。行程已死，同樣 D-06 |
| 備援／換模型 | D-08 |
| dispatcher 崩潰後 `resume` run | D-09，不尋找舊 PID |

`park_lost` 與 `park_unavailable` 各記一次 log 事件（`agent`、`reason`）。不升 `schema_version`。

## 26.7 測試

假行程：測試自己起的子行程，讀一行就回一行固定的「回合結果」，行程不退出，直到收到關閉。不斷言該行是 Claude 的 schema。

| # | 行為 |
|---|---|
| T1 | 假 lead 第一回合結束後 PID 仍在；成員的回信送進同一個 stdin；沒有第二次 spawn |
| T2 | 停駐中 lead 有未讀、成員也有未讀：先跑成員並整合，再送 lead。整合發生在 lead 下一回合的寫入之前 |
| T3 | 假行程在第二回合前退出：信留未讀，下一次是新的 spawn，並帶今天的 `--resume` 參數（session id 用假的） |
| T4 | 停駐等信超過 `wake_timeout_sec` 不會殺行程；回合開始之後超時會進入 D-06 |
| T5 | run 結束時停駐行程的 process group 已不在 |
| T6 | Codex lead 與 `resume: false` 的 lead 仍是一封 prompt、stdin 關閉、等退出 |

T1–T6 不呼叫真實 `claude`。閘是手動的，不進 `npm test`。

## 26.8 文件

閘通過且 T1–T6 落地後，才改 `docs/how-it-works.md` 與 `.zh-TW.md`：Claude lead 在回合之間留著同一個行程；成員做工時它是停著的；行程死了就退回 `--resume`。不過閘就不改這兩份說明。

## 26.9 風險

- help 的「print and exit」與「after each turn」衝突。閘就是在解這個衝突；失敗就停。
- 停駐行程若在我們以為閒置時仍握著 worktree 的 git lock，`snapshotBase` 會失敗。T2 用假行程覆蓋不到真實 git。閘的第二步不碰 git；真的 git 衝突留到第一次手動試跑，試跑失敗則 D-06 並停用停駐，不另開修復 spec。
- 閒置的 Claude 行程是否佔 5 小時用量：未驗證。閘的兩回合之間空等 60 秒，若 `claude /usage` 的 Current session 在沒有第二回合 token 時上升，閘仍可通過 token 條件，但評估附錄要寫下用量百分比前後差。上升超過 1 個百分點就不要做 D-03 以後（空等本身在燒額度）。
