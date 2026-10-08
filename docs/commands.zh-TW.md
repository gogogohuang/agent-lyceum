# 指令

每個指令的完整說明。[README](../README.zh-TW.md) 只放簡短版本。

## init

**用法:** `init [-y]`

建立 home 與全域 agent 庫（`lead`、`fe-member`、`qa-member`）。建立預設路徑前會先詢問。

## project add

**用法:** `project add <name> --dir <repo>`

註冊專案：建立 `projects/<name>/project.yaml`、共用資料夾與 `COMMON.md`。

## project list and remove

**用法:** `project list` / `project remove <name> [--purge]`

列出專案／取消註冊（除非加 `--purge`，否則保留 context）。

## validate

**用法:** `validate [-p name] [--task-file f]`

驗證合併後的設定，並印出每個 agent 的防護等級。有錯誤時 exit 1。

## run

**用法:** `run ["task"] [--task-file f] [--agent a] [--assume-defaults] [-p name]`

把任務交給 lead，並執行 dispatcher 直到完成。任務文字與 `--task-file` 擇一提供。agent 向你提問時 run 會暫停，見 [answer](#answer)。`--assume-defaults` 讓有建議值的題目直接採用建議值而不暫停（沒有建議值的題目仍然暫停）。

加上 `--agent <name>` 時，任務只交給專案裡的這一個成員，其他人都不會被喚醒：它不能寄信給隊友、不能向你提問、不能修改任何 `AGENT.md`，而且要靠它自己寄出的 `done` 來結束 run（所以它必須寄一封）。其餘行為與一般 run 相同：有 run id 與專案鎖、會出現在 `status`、可以 `resume`（run 會記得它是 solo）與 `clear`。`--assume-defaults` 在這個模式下沒有作用。名字不是專案成員時會拒絕並列出成員；名字只存在於 global 資料庫時，會提示改用 [call](#call)。

## call

**用法:** `call <agent> ["task"] [--task-file f] [--dir d]`

**不經過任何專案**，單獨呼叫 global 資料庫（`team.yaml`）裡的一個 agent：不讀 `project.yaml`、不取專案鎖、不會出現在 `status`。agent 在 `--dir`（預設是目前目錄）工作，使用它的 global `AGENT.md` 與 global 記憶。它可以改該目錄的檔案與自己的 global 記憶；不能寄信、不能向你提問、不能修改任何 `AGENT.md`、`COMMON.md` 或設定（動到受保護檔案會被還原並回報）。任務以文字或 `--task-file` 擇一提供。

agent 的最終回答印在 stdout，其餘訊息（進度、call id）走 stderr，所以可以直接接管線。每次呼叫會在 `<home>/calls/<call-id>/` 留下 `task.md`、`log/` 與 `result.md`（不會自動刪除）。exit code：`0` 成功、`1` 失敗或逾時（預設 `dispatcher.wake_timeout_sec`）、`130` Ctrl-C。同一個 agent 同時只能有一個 call，第二個會被拒絕。call 不能 resume，要再做就重新呼叫。

## resume

**用法:** `resume [run-id] [--assume-defaults] [-p name]`

接續被中斷或失敗的 run（每次 `run` 都是獨立任務；不指定 id 時接續最新一個尚未結束且未在執行的 run，指定 id 則接續該任務）：沿用同一個 run 目錄、session 與輪數，不會重送任務，未讀信件會重新處理。run 仍在執行時會拒絕。對已完成（done）的 run 不會繼續任何工作：只印出已記錄的結果狀態與內容，並以該結果對應的碼結束（`0` completed、`2` partial／blocked、`1` failed；在記錄結果狀態之前就結束的舊 run 視為未驗證的 `partial`，回傳 `2`）。因閒置或達 `max_rounds` 而結束的 run，除非補上新信件，否則已沒有未讀信件，接續後會再次以閒置結束（回傳 `2`）。等待回答中的 run 要等所有未答題目都有有效答案才會繼續，否則 `resume` 會列出缺哪些題並以 `3` 結束。

## answer

**用法:** `answer <run-id> [--no-edit] [--assume-defaults] [-p name]`

回答等待中的 run 提出的問題。agent 以 `type: ask` 信件提問（lead 一律可以；成員需設 `can_ask_user: true`）。dispatcher 把所有問題集中在一個檔案 `runs/<run-id>/mail/ask-reply.md`，讓 run 以 `waiting` 結束（exit `3`、釋放鎖、不消耗輪數）並印出檔案路徑；`status` 也會顯示路徑與未答題數。

```xml
<ask-reply status="pending" asked_by="lead" round="7">
  <question id="q1" asker="lead">
    <text>登入要用 session 還是 JWT？</text>
    <options>
      <option>session</option>
      <option>jwt</option>
    </options>
    <suggested reason="既有程式已用 cookie">session</suggested>
    <answer></answer>
  </question>
</ask-reply>
```

你只需要填 `<answer>` 標籤。有 `<options>` 的題目填其中一個選項，或以 `other:` 開頭寫自訂文字；沒有選項的題目填任何非空文字。`answer` 會用 `$VISUAL`／`$EDITOR`（預設 `vi`）開啟檔案、檢查答案，全部有效後把答案以含 `<answers>` 區塊的 `reply` 信送給提問的 agent，並繼續 run。`--no-edit` 不開編輯器，只檢查你已經編輯好的檔案；自己直接編輯檔案再執行 `resume` 效果相同。有缺漏或無效時會列出問題並以 `3` 結束。在終端機裡，run 進入等待時 `run` 與 `resume` 會自己開編輯器。`--assume-defaults` 讓每個沒答、但有 `<suggested>` 的題目採用建議值（檔案中標記 `by="default"`），其餘仍然等待。已經回答過的題目會留在檔案裡，agent 追加第二批問題時不會再問。

## status

**用法:** `status [-p name] [--monitor]`

顯示 agent、未讀信件、目前正在執行的 agent（耗時、處理中的信件）、上次執行（任務來源、輪數、結束原因、output token 數）。不帶 `--monitor` 時會一併印出最新 run 的完整 wake 紀錄；`--monitor` 會常駐並持續更新，每個 run 只顯示最新三筆 wake。`--task-id <id>` 印出單一任務的完整內容（每次 wake、結果、log 目錄）。`--task-list [project]` 列出專案所有任務（run）的 id、狀態、輪數與任務內容，id 可直接給 `resume` 使用。加上 `--json` 會把同一份報告以 JSON 輸出（`schema_version: 1`、無顏色，stdout 只有 JSON；錯誤走 stderr 並以非零 exit code 結束），可搭配 `--task-list`、`--task-id`。文字與 JSON 由同一份報告產生。

## clear

**用法:** `clear <run-id> [-p name] [--dry-run] [--keep-worktrees]`

依 id 刪除一個任務（run）：它的 run 目錄（狀態、log、結果、被還原的受保護檔案修改的留存副本、信箱）、**任務記憶**，以及各 agent 的 git worktree、branch 與快照 ref。全域與專案層（長期）記憶一律不會動。run 仍在執行，或有 worktree 內的成果不在你的 repo 裡（未提交，或已提交但尚未整合進來）時會拒絕且什麼都不刪，並列出那些成果。`--keep-worktrees` 會保留 worktree 與 branch，其餘照樣清除。`--dry-run` 只列出會刪除與會保留的項目。絕不會順著 symlink 刪到專案 home 之外。進度會記在 `projects/<name>/cleanup/` 的 journal，所以中斷後重跑同一個指令即可完成。id 可用 `status --task-list` 查。

## config show

**用法:** `config show --resolved [-p name] [--json]`

印出每一項生效的設定（全域 agent 庫、專案檔與預設值合併後的結果）與它的來源：檔案與 key、`default`，或在 runtime 是由 `model` 辨識出來時顯示 `inferred from <model 的 key>`。專案的值覆蓋全域；清單（`can_message`、`owns`）是整個取代而非合併；相對路徑以寫它的那個檔案為基準解析。

## doctor

**用法:** `doctor [-p name] [--json]`

在不執行任何 agent 的前提下檢查環境：設定、git（平行 run 需要）、專案鎖，以及各 runtime CLI 支援什麼（從 `--version` 與 `--help` 讀取：JSON 輸出、resume、sandbox 設定、effort，每項都是 `yes`、`no` 或 `unknown`）。只要團隊需要的功能被明確判定不支援就 exit 1。它不讀取憑證，登入狀態會回報為 unknown。`run` 與 `resume` 啟動前會先做同樣的能力檢查：明確 `no` 就拒絕啟動，`unknown` 則警告。要對真實 CLI 做端到端驗證（跑一個很小的任務）會花 token，刻意保留為手動。

## memory tidy

**用法:** `memory tidy [-p name] [--agent a] [--layer project|global] [--dry-run]`

讓 agent 整理自己的長期記憶：合併重複的條目、改寫過時的內容、淘汰不再需要的。**只有你自己執行它才會整理**：run 結束、記憶變大、repo 有變化都不會觸發；`status` 與 `doctor` 最多只會建議。

預設整理所有 agent 的 **project** 記憶。**global** 記憶由所有專案共用，所以只有加 `--layer global` 才會整理；task 記憶不整理（`clear` 會直接刪除）。注意：專案範本只替 agent 設定 global 記憶，要使用 project 記憶需在 `project.yaml` 為 agent 設定 `memory.project`；沒有任何 agent 設定時，指令會說明並以 `0` 結束。

每個 agent 會被喚醒一次來做這件事，不屬於任何 run（不消耗輪數），而且只能改動自己的記憶。淘汰＝封存，不是刪除：檔案會以相同的相對路徑搬到 `memory/.archive/<時間戳>/`，並附上 `tidy-report.md`（合併了什麼、封存了什麼與理由、仍存疑的項目）。agent 會看到每個記憶檔的大小與修改時間、`MEMORY.md` 索引、自上次整理以來 repo 的變化（`git log` 與 `git diff --stat`），以及記憶中提到但已不存在的路徑。`memory/.tidy-state.json` 記錄上次整理時 repo 的 `HEAD`；第一次整理沒有基準，只做路徑檢查。

agent-lyceum 會驗證結果：整理前存在的每個檔案，都必須還在原處或在這次的封存資料夾裡；`tidy-report.md` 必須存在；agent 的其他記憶資料夾不得有變動。喚醒失敗或逾時，或任何一項驗證不過，記憶資料夾會完整還原成整理前的樣子，不更新基準，結束碼為 `1`。這個指令需要專案鎖，所以有 run 在執行時會拒絕。`--dry-run` 只印出記憶大小、專案變化與已不存在的路徑：不喚醒任何 agent、不改任何檔案、也不取鎖。

## memory restore

**用法:** `memory restore <時間戳> -p name --agent a [--layer project|global]`

還原一次整理：把 `memory/.archive/<時間戳>/` 的檔案搬回原處，`MEMORY.md` 沒有提到的就補一行索引。若現在已有同名檔案，不會覆蓋，只會回報並留在封存裡。`tidy` 結束時會印出時間戳。

## unlock

**用法:** `unlock [-p name] --force`

移除當機的 run 留下的專案鎖（同一專案同時只能有一個 run）。不加 `--force` 只會顯示鎖的持有者。

**從舊版升級：** 在 Linux 上，鎖現在以 `proc:<ticks>`（讀自 `/proc`）記錄持有者的啟動時間，舊版寫的是 `ps` 的文字，兩者無法比對，所以舊版寫下的鎖只用 pid 判斷：若該 pid 後來被不相干的程序重用，過期的鎖不會自動回收，需要 `unlock --force`。

## 中止 run

**中止 run：** Ctrl-C（或 SIGTERM）會乾淨地取消 run：執行中的 agent 先收到 SIGTERM，5 秒後 SIGKILL（連同整個子程序樹），未讀信件保留、專案鎖釋放，exit code 為 `130`；之後可用 `agent-lyceum resume` 接續。再按一次 Ctrl-C 會立刻結束。超過 `wake_timeout_sec` 的喚醒也以同樣方式停止，並算作一次失敗的嘗試。每次嘗試完整的 stdout／stderr 都寫在 `runs/<run-id>/mail/attempts/<attempt>/log/`，記憶體中每個串流只保留最後 64 KiB。

## 退出碼

**`run`／`resume` 的 exit code：** `0` 只代表 lead 回報 `outcome: completed`；`2` 代表 `partial` 或 `blocked`（run 閒置或達到 `max_rounds` 而沒有 done 也算）；`1` 代表 `failed`（lead 本身失敗也算）；`3` 代表 run 正在等你回答（見 [answer](#answer)）；`130` 代表 `cancelled`。*升級注意：* 舊版 `idle` 結束會回傳 `0`、lead 失敗回傳 `2`；原本把 `0` 當成「run 結束了」的腳本，現在 `0` 的意思是「工作確實完成」。在記錄結果狀態之前就結束的舊 run 會顯示為「未驗證」（`partial`），不會被當成成功。

## 選擇專案

未指定 `--project` 時，會選用 `dir` 為目前目錄最長前綴的已註冊專案；若沒有符合的專案，指令會列出已註冊專案後停止。
