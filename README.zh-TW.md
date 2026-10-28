# agent-lyceum

[![npm version](https://img.shields.io/npm/v/agent-lyceum)](https://www.npmjs.com/package/agent-lyceum)

[English](README.md) | **繁體中文**

把任務交給一個 **agent 團隊**（Claude Code 和／或 Codex），而不是塞給單一個負荷過重的 session。lead 拆分工作，前端、reviewer、PM 等專長角色在你的 repo 裡各做各的，lead 回報 done 即結束。

## 為什麼用它

- **角色不會跑掉。** 每個 agent 有自己的人設（`AGENT.md`）與長期記憶，reviewer 會一直做 review，不會漸漸變成在寫程式。
- **agent 改不了規則。** agent 只能寫自己的記憶與寄件匣（outbox），不能改其他 agent 的 context，也不能改自己的人設；能做到的地方由 OS 沙箱強制，而不只靠 prompt。見 [Write scope](docs/write-scope.zh-TW.md)。
- **混用 runtime。** Claude Code 與 Codex agent 可在同一個團隊。
- **備用模型。** 模型被限流、額度用完或連不上時，run 可以改用備用的模型或 runtime 繼續，而不是直接停下。見[設定](docs/configuration.zh-TW.md#備援模型)。
- **沒有黑箱。** agent 透過純檔案信箱溝通，每則訊息、決策與記憶都是你能讀、能 grep、能 diff 的檔案；dispatcher 不會替你 merge。

**不適合**小而單次的修改：單一 Claude Code 或 Codex session 更快更省。任務大到值得拆分、review 或平行執行時，再用團隊。

## 快速開始

需求：Node 20+，以及 `PATH` 中有 `claude` 和／或 `codex`（已登入）。支援 macOS 與 Linux（Linux 需要 `bwrap` 才有 OS 沙箱）；Windows 只會顯示警告。

```bash
npx agent-lyceum demo                       # 3 個 agent 在拋棄式沙箱裡修好一個失敗的測試（真實呼叫）

# 用在你自己的 repo：
npx agent-lyceum init                       # 建立 home 與全域 agent 庫
npx agent-lyceum project add web --dir ~/code/web-app
npx agent-lyceum doctor --project web       # 檢查設定並顯示各項防護等級
npx agent-lyceum run --task-file spec.md    # 在 repo 內執行時會自動偵測專案
npx agent-lyceum status
```

要跑尚未發佈的最新程式碼：`npx github:gogogohuang/agent-lyceum <command>`。

## 運作方式

1. 你的任務會成為寄給 **lead** 的第一封信。
2. dispatcher 喚醒有未讀信的 agent（無頭模式的 `claude -p` / `codex exec`）。
3. agent 把回信寫進自己的 `outbox/`，dispatcher 檢查 `can_message` 後投遞。
4. lead 寄出 `done` 時，run 結束。

工具自己的資料（設定、信箱、log、記憶、worktree）放在 `~/agent-lyceum-config/`，不放進你的 repo。並行不需要任何設定。在有 commit 的 git repo 裡，每個 run 都在自己的 git worktree 工作，並結束在自己的 branch（`agent-lyceum/<run>/…`）；有待處理信件的成員會平行喚醒，同時也可有任意多個 run；結果不會寫進你的工作目錄，請用 `git merge <branch>` 或 `open_pr`，且 run 從 `HEAD` 起跑，看不到你未提交的修改。在非 git 資料夾、沒有 commit 的 repo 或使用 reftable 的 repo，run 直接在該資料夾工作、一次只跑一個 agent（會有一行說明原因），且同時只能有一個這樣的 run。lead 可以把互不相依的 task 標成 `parallel: true`，讓一位成員同時處理多件，各在自己的 worktree（僅 worktree 模式、由 lead 決定、每位成員最多 `dispatcher.max_instances` 個，預設 4）；見[一次執行如何運作](docs/how-it-works.zh-TW.md#同一成員的平行實例)。agent-lyceum 不會幫你合併。從有 `owns`、`max_parallel`、`max_concurrent_runs` 或 `workspace_mode` 的版本升級：見[升級](docs/upgrading-run-v2.md)。詳見[一次執行如何運作](docs/how-it-works.zh-TW.md)、[設定](docs/configuration.zh-TW.md)。

## 指令

| 指令 | 功能 |
|---|---|
| `init` | 建立 home 與全域 agent 庫。 [詳細](docs/commands.zh-TW.md#init) |
| `project add` / `project` / `project remove` | 註冊、列出或移除專案。 [詳細](docs/commands.zh-TW.md#project-add) |
| `doctor` | 不執行 agent，檢查設定、git、鎖與 runtime CLI。 [詳細](docs/commands.zh-TW.md#doctor) |
| `status` | 顯示 agent、信件、目前的喚醒與過去的 run。`status --web` 在瀏覽器看全部已註冊專案。 [詳細](docs/commands.zh-TW.md#status) |
| `run` | 把任務交給 lead，執行到完成。 [詳細](docs/commands.zh-TW.md#run) |
| `resume` | 繼續中斷的 run，或用追加需求重開已完成的 run。 [詳細](docs/commands.zh-TW.md#resume) |
| `clear` | 刪除 run，或移除殘留的鎖。 [詳細](docs/commands.zh-TW.md#clear) |
| `call <agent>` | 在任何專案之外單獨呼叫一個全域 agent。 [詳細](docs/commands.zh-TW.md#call) |
| `demo` | 在拋棄式範例 repo 上試跑 3 個 agent 的團隊。 [詳細](docs/commands.zh-TW.md#demo) |
| `tidy` | 讓 agent 整理自己的記憶（只封存，不刪除）。 [詳細](docs/commands.zh-TW.md#tidy) |

`agent-lyceum <指令> --help` 會印出完整選項。Ctrl-C 可乾淨取消；腳本可依[結束碼](docs/commands.zh-TW.md#退出碼)判斷 run 的結果。

## 設定

`team.yaml` 定義可重複使用的 agent；`project.yaml` 選定團隊並覆寫欄位：

```yaml
# project.yaml
dir: ~/code/web-app
team: { lead: lead }
agents:
  lead:      { can_message: all, can_edit_agent_md: true }
  fe-member: { runtime: codex, can_message: [lead] }
  pm:        { can_message: [lead], allow_web: fetch }
```

資料夾結構、所有 agent 欄位與 `doctor` 檢查的規則：[設定](docs/configuration.zh-TW.md)。

## 降級（改用舊版）

舊版程式會拒絕載入含 `model_tiers` 的 `team.yaml` 或 `project.yaml`（載入錯誤，「Unrecognized key」）。改用舊版前，請先從每個 `project.yaml` 與 `team.yaml` 拿掉 `model_tiers`。其他信件與 run 狀態不受影響：舊版會忽略信件中的 `tier` 行。見[模型分級](docs/configuration.zh-TW.md#模型分級)。（spec 24.3.2、24.13）

## 主題

| 主題 | 閱讀 |
|---|---|
| run 的生命週期、平行 agent、同時多個 run、追加需求、開 PR | [一次執行如何運作](docs/how-it-works.zh-TW.md) |
| agent 能寫什麼、沙箱等級、已知缺口 | [寫入範圍](docs/write-scope.zh-TW.md) |
| 讓 agent 搜尋或讀取網頁 | [網路存取](docs/web-access.zh-TW.md) |
| 在 Claude Code 內看即時 run 狀態（每個 agent 一個依狀態上色的外框，樹狀排列；面板或整寬橫幅） | [監控 mod](docs/monitor.zh-TW.md) |
| 所有指令的完整說明 | [指令](docs/commands.zh-TW.md) |
| 從舊版升級 | [升級到 run v2](docs/upgrading-run-v2.md) |
