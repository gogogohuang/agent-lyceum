# 27 `done` 前由 dispatcher 執行確定性驗證（verify）

狀態：**提案**（2026-11-01）。對應「Harness, Loops, Graphs」的 L3（檢查）。後續另開 spec：28 = L4（同樣結果重複就停）、29 = L6（通過就凍結、只重跑失敗步驟）。28、29 都要用到本 spec 留下的紀錄（27.7），本 spec 不實作它們。

行號以 `55ae675`（0.31.1）為準。真實 `claude`／`codex` 的行為本 spec 不依賴。

## 27.1 問題

- `done` 目前只檢查結構：要有 `outcome` 和規定標題，`completed` 要 Steps 全勾（`src/format.ts` 的 `doneContract`）。報告內容是真是假，dispatcher 不檢查；`docs/how-it-works.md` 也明說 "does not verify what the lead reports"。
- 結果是：lead 可以在測試沒過的情況下回報 `completed`，並且 `open_pr: true` 會照樣開出 PR（`completed` 是唯一條件，見 spec 14.2-3）。
- 「dispatcher 直接執行專案指令」之前被擋下，因為指令會執行 agent 寫的程式碼，等於在 agent 的 sandbox 外跑（`docs/evaluations/graph-engineering.md` §4）。本 spec 正面處理這個風險，而不是繞開它（27.5）。

## 27.2 目標與非目標

**目標：** 使用者在 `project.yaml` 列出幾條驗證指令。lead 送出 `completed` 的 `done` 時，dispatcher 在 lead 的工作區依序執行；全部通過才接受，否則把輸出退回給 lead。判定依據是 exit code，不是任何 agent 的文字。

**非目標：**

- 不讓 agent 設定或改動 verify 指令。指令只能由使用者寫在 `project.yaml`（agent 寫不到設定家目錄，見 `docs/write-scope.md`）。
- 不在 `partial`／`blocked`／`failed` 的 `done` 上跑驗證。
- 不做成員層級的 gate（每次成員 `reply` 都驗）。那屬於 29。
- 不解析測試框架的輸出、不算失敗指紋、不偵測重複失敗。那屬於 28。
- 不自動修復、不重試指令。
- 不替 agent 的 sandbox 放寬任何東西。
- 不為 verify 另建容器或 OS sandbox 的 runner（27.5 說明為什麼、何時重新評估）。

## 27.3 決議總表

| # | 決議 | 理由 |
|---|---|---|
| D-01 | 預設不跑任何驗證。沒有 `verify` 設定的專案，行為與 0.31.1 完全相同 | 相容；執行專案指令必須是使用者明確選擇的 |
| D-02 | 設定放在 `project.yaml` 的 `verify`（見 27.4），不放 `team.yaml`，不能由 agent 或 task 內容指定 | 指令的來源必須是使用者，不是 agent 或任務文字 |
| D-03 | 只在 lead 的 `done` 宣告 `outcome: completed`、且通過 `doneContract` 之後才跑 | 契約不全的 `done` 本來就會被退回；`partial`／`blocked`／`failed` 沒有宣稱成功，不需要驗 |
| D-04 | 跑的時機是成員工作已整合進 lead 工作區之後（`routeOutboxes` 之前的 `integrateMember` 已完成，`src/run-session.ts:984-988`），在 lead 的工作區（worktree 模式）或 `project.dir`（非 worktree 模式）執行 | 驗的是 lead 真正會提交的那棵樹 |
| D-05 | 指令依序執行，遇到第一個失敗就停（`fail_fast`，固定行為，不開設定） | 後面的指令常依賴前面的（build 才有 test）；少跑也省時間 |
| D-06 | 全部通過：接受 `done`。把驗證結果寫進 `result.md` 與 `done-<n>.md` 的 `## Dispatcher verification` 區段，與 lead 自己寫的 `## Verification` 分開 | 讓讀者分得出「dispatcher 跑的」和「lead 說的」 |
| D-07 | 有失敗：不結束 run，`done` 退回 lead，附指令、exit code、輸出尾端（每條至多 4 KB）。退回次數有上限 `max_rejections`（預設 2），與 `done_rejections` 分開計 | 沿用 `doneContract` 的退回模式；失敗要給方向（L4 的前提） |
| D-08 | 退回用完仍失敗：接受 `done`，但 `outcome` 降為 `partial`，note 寫明哪條指令失敗。不會因此開 PR | 與契約不全的處理一致（`resolveDoneOutcome`）；`open_pr` 只認 `completed` 本來就不會開 |
| D-09 | 指令本身無法執行（找不到執行檔、逾時、被取消）：逾時視為失敗；找不到執行檔視為失敗並在輸出裡說明；取消（Ctrl-C）不產生判定，run 以 `cancelled` 結束 | 不能把「沒跑成」當成「通過」 |
| D-10 | 每條指令有自己的逾時（`timeout_sec`，預設 600，與 `wake_timeout_sec` 無關）。逾時殺掉整個 process group | 與 agent 喚醒的逾時行為一致（`src/process-runner.ts:238`） |
| D-11 | 輸出完整寫入 `runs/<run-id>/verify/<n>-<name>.log`（上限 1 MiB，超過保留尾端並標註），`state.json` 只存摘要 | 避免 state 膨脹；28 要用的原始輸出不會遺失 |
| D-12 | 不升 `schema_version`。`state.json` 新增選填欄位 `verify`；舊 run 照常載入 | 沿用過去的相容作法 |
| D-13 | 重開（`resume <run> "<follow-up>"`）後的新 `done` 重新驗證；上一段的驗證結果保留在 `done-<n>.md` | 每個 segment 各自負責 |
| D-14 | `doctor` 在設定了 `verify` 時列出每條指令，並明確警告「這些指令在 agent 的 sandbox 外、以你的權限執行」 | 使用者必須知情 |
| D-15 | 這個功能對 `run --agent`（單獨 agent）同樣適用，`call` 不適用 | 單獨 agent 就是它那個一人團隊的 lead（spec 14.2-9）；`call` 沒有專案與工作區 |

## 27.4 設定

```yaml
# project.yaml
verify:
  max_rejections: 2          # 選填，0–5，預設 2
  commands:
    - { name: typecheck, run: "npm run typecheck" }
    - { name: test,      run: "npm test", timeout_sec: 900 }
```

- `commands` 至少一條才算啟用；空陣列或沒有 `verify` 等於關閉。
- `name`：小寫字母、數字、`-`，在同一份設定內不可重複；用於 log 檔名與訊息。
- `run`：交給 `sh -c` 執行的單一字串（Windows 不支援，與整體平台限制一致）。
- `timeout_sec`：1–7200，預設 600。
- schema 一律 `.strict()`。未知的鍵載入失敗並指出鍵名。
- **降版：** 舊版本會因 `verify` 是未知的鍵而拒絕載入 `project.yaml`（"Unrecognized key"），與 `model_tiers` 相同。README 的 Downgrading 區段與 `docs/upgrading-run-v2.md` 要補上。

## 27.5 安全：指令會執行 agent 寫的程式碼

**事實：** `npm test` 這類指令會執行 agent 剛改過的測試與程式。dispatcher 用使用者的權限跑它們，等於 agent 寫的程式碼在 agent 的 sandbox 外執行。agent 可以藉由改測試或 build 腳本做任何使用者帳號能做的事。

**本 spec 的處理：**

1. 預設關閉，且只有使用者能開（D-01、D-02）。
2. 只在 lead 宣稱 `completed` 時才跑，不是每次喚醒（D-03），減少暴露次數。
3. `doctor` 與文件明講風險（D-14）。
4. 工作區是 lead 的 worktree，不是使用者的主工作樹（worktree 模式）；指令的 cwd 在 worktree。這**不是**隔離：指令仍可寫到 worktree 以外。
5. 環境變數：繼承 dispatcher 的環境，不做過濾。過濾清單（哪些是機密）無法可靠判斷，做了反而給人錯誤的安心。
6. 這和使用者自己 `git merge` 後跑 `npm test` 的風險是同一類，只是時機提前。

**未解決，要另案：**

- 在 OS sandbox 內跑 verify（macOS／Linux）。可行性、寫入範圍（要寫 `node_modules/.cache`、`/tmp` 等）與已知會在 sandbox 內失敗的測試（`docs/sandbox-blocks.md`）互相牽制，**未驗證**。
- 重新評估條件：出現使用者因 verify 指令的副作用受損的實例，或 spec 25 的 sandbox 放寬機制併入 `main` 且證明可重用。

## 27.6 流程

在 `run-session.ts` 接受 `done` 的位置（`:990-1021` 契約檢查之後、`:1049` 之前）：

1. `doneContract` 通過，且 `outcome === "completed"`，且 `verify.commands` 非空 → 進入驗證。
2. 依序執行；每條執行前後 `log("verify-start"|"verify-end", {name, exit, ms})`。
3. 全過 → 記錄結果，走原本的接受流程（D-06）。
4. 有失敗且 `state.verify_rejections < max_rejections` → `state.verify_rejections += 1`，用 `deliverOnce` 送 `failure` 給 lead，subject `Your done report failed verification`，內容含失敗指令、exit code、輸出尾端、第幾次；`rejectDone(route.done.file)`；`route.done = undefined`；log `verify-rejected`。
5. 有失敗且次數用完 → 接受 `done`，`outcome` 降為 `partial`（D-08）。
6. 退回訊息使用 `deliverOnce`，key 為 `verify-reject:<source id>`，與 `done-reject` 一樣冪等。

**崩潰與重播：** 驗證本身不改工作區，重跑是安全的。驗證中途崩潰，重新啟動後該 `done` 仍在 outbox 中，會再走一次驗證；不保留半途結果。這一點實作時要用測試確認（27.9）。

**取消：** Ctrl-C 要殺掉驗證中的 process group，run 以 `cancelled` 結束，不寫判定。

## 27.7 留給 28／29 的紀錄

`state.json` 新增選填欄位（結構細節實作時定稿，這裡只規定要有的資訊）：

- 每次驗證一筆：時間、各指令的 `name`、`exit`、`ms`、log 路徑、是否逾時。
- `verify_rejections` 計數。
- 驗證當下 lead 工作區的 diff hash（28 用來判斷「工作區沒變」）。

28、29 只讀這些欄位，不需要再改本 spec 的行為。

## 27.8 與其他機制的關係

- **`done` 契約（`doneContract`）：** 先契約、後驗證；兩者的退回次數分開，不互相消耗。
- **`open_pr`（spec 14）：** 驗證失敗而降為 `partial` 時不開 PR，不需要改 14 的程式。
- **`max_rounds`：** 驗證退回會讓 lead 多一次喚醒，計入喚醒次數。
- **fallback／tier：** 不受影響。
- **write-scope／guard：** verify 在 agent 喚醒之外執行，不經過 guard。指令若修改了受保護檔案，下一次 guard 比對時會被當成變更處理，**行為未驗證**（27.9 要測）。
- **`run --agent`：** 同一條路徑（D-15）。
- **非 worktree 模式：** 在 `project.dir` 執行，也就是使用者的實際工作目錄。文件要特別標出這一點。

## 27.9 測試與驗證

全部用假指令，不呼叫真實 `claude`／`codex`，不進網路。

- schema：缺鍵、重複 name、未知鍵、`timeout_sec` 超出範圍、`max_rejections` 超出範圍。
- 沒有 `verify`：行為與現在相同（既有測試全過）。
- `completed` + 全過 → 接受；`result.md` 含 `## Dispatcher verification`。
- `completed` + 第一條失敗 → 退回、第二條不執行；訊息含 exit code 與輸出尾端。
- 退回用完 → `partial` 且 note 正確；`open_pr: true` 不開 PR。
- `partial`／`blocked`／`failed` 的 `done` 不跑驗證。
- 逾時 → 殺掉 process group，無殘留子行程。
- 找不到執行檔 → 視為失敗，訊息可讀。
- 取消 → `cancelled`，無判定，無殘留行程。
- 崩潰重播（用既有的 fault seam）：不重複計數退回、不重複送信。
- 重開後重新驗證，舊結果保留。
- 非 worktree 模式的 cwd 正確。
- **未驗證、要實測：** 驗證指令改動受保護檔案時 guard 的行為；輸出超過 1 MiB 的截斷標註；CRLF 輸出。
- `npm run check:docs`、`npm run typecheck`、`npm test`、`npm run lint`。

## 27.10 影響的檔案

- `src/schema.ts`：`VerifyPartial`、`ProjectConfig.verify`。
- `src/config.ts`：解析與預設值。
- 新檔 `src/verify.ts`：執行、逾時、截斷、log 寫入。
- `src/run-session.ts`：D-03～D-08 的流程與 state 欄位。
- `src/run-outcome.ts`：降級與 note。
- `src/run-store.ts`：state 選填欄位。
- `src/doctor.ts`：D-14。
- `src/status.ts`：顯示最近一次驗證結果。
- 文件（中英成對）：`docs/configuration.md`、`docs/how-it-works.md`、`README.md`（含 Downgrading）、`docs/upgrading-run-v2.md`。
- `docs/specs/README.md`：索引加一列。

## 27.11 評估範圍

| 面向 | 狀況 |
|---|---|
| 格式與相容 | 新鍵與新選填 state 欄位；舊 run 可讀；舊版本讀不了新設定（27.4） |
| 取消與部分完成 | 取消不產生判定（D-09）；驗證失敗用盡退回後降為 `partial`（D-08） |
| 安全 | 27.5；本 spec 不聲稱隔離 |
| 並行與恢復 | 驗證在批次之外、整合之後；崩潰重播要測（27.9）；多個 run 各自在自己的 worktree 驗證，互不干擾，但共用機器資源與連接埠，**未驗證** |
| 平台 | macOS／Linux；Windows 不支援 |
| 測試性 | 假指令；真實專案的 `npm test` 只在手動驗收時跑 |
| 可診斷性 | `verify-start`／`verify-end`／`verify-rejected` 事件、完整 log 檔、`status` 顯示 |

## 27.12 待決（實作前要回答）

1. 輸出尾端 4 KB 是否足以讓 lead 修好？第一版固定，之後看實際 run 調整。
2. `fail_fast` 是否需要設定？第一版不開。
3. 是否要允許 `verify` 在 `project.yaml` 以外的層級覆寫（例如個別 agent）？第一版不要。
