# agent-lyceum

[![npm version](https://img.shields.io/npm/v/agent-lyceum)](https://www.npmjs.com/package/agent-lyceum)

[English](README.md) | **繁體中文**

在你的 repo 上執行一個由多個 **agent**（Claude Code 和／或 Codex）組成的團隊。agent 之間透過檔案信箱溝通，各自有人設（`AGENT.md`）與長期記憶。agent 只能寫自己的記憶與寄件匣（outbox），不能改其他 agent 的 context，也不能改自己的人設。

## 快速開始

需求：Node 20+，以及 `PATH` 中有 `claude` 和／或 `codex`（已登入）。支援 macOS 與 Linux（Linux 需要 `bwrap` 才有 OS 沙箱）；Windows 只會顯示警告。

```bash
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

工具自己的資料（設定、信箱、log、記憶、worktree）放在 `~/agent-lyceum-config/`，不放進你的 repo。agent 直接修改你的 repo；平行執行時則在各自的 git worktree 修改。agent-lyceum 不會幫你合併。詳見[一次執行如何運作](docs/how-it-works.zh-TW.md)、[設定](docs/configuration.zh-TW.md)。

## 指令

| 指令 | 功能 |
|---|---|
| `init` | 建立 home 與全域 agent 庫。 [詳細](docs/commands.zh-TW.md#init) |
| `project add` / `project` / `project remove` | 註冊、列出或移除專案。 [詳細](docs/commands.zh-TW.md#project-add) |
| `doctor` | 不執行 agent，檢查設定、git、鎖與 runtime CLI。 [詳細](docs/commands.zh-TW.md#doctor) |
| `status` | 顯示 agent、信件、目前的喚醒與過去的 run。 [詳細](docs/commands.zh-TW.md#status) |
| `run` | 把任務交給 lead，執行到完成。 [詳細](docs/commands.zh-TW.md#run) |
| `resume` | 繼續中斷的 run，或用追加需求重開已完成的 run。 [詳細](docs/commands.zh-TW.md#resume) |
| `clear` | 刪除 run，或移除殘留的鎖。 [詳細](docs/commands.zh-TW.md#clear) |
| `call <agent>` | 在任何專案之外單獨呼叫一個全域 agent。 [詳細](docs/commands.zh-TW.md#call) |
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
  fe-member: { runtime: codex, can_message: [lead], owns: ["src/web/**"] }
  pm:        { can_message: [lead], allow_web: fetch }
```

資料夾結構、所有 agent 欄位與 `doctor` 檢查的規則：[設定](docs/configuration.zh-TW.md)。

## 主題

| 主題 | 閱讀 |
|---|---|
| run 的生命週期、平行 agent、同時多個 run、追加需求、開 PR | [一次執行如何運作](docs/how-it-works.zh-TW.md) |
| agent 能寫什麼、沙箱等級、已知缺口 | [寫入範圍](docs/write-scope.zh-TW.md) |
| 讓 agent 搜尋或讀取網頁 | [網路存取](docs/web-access.zh-TW.md) |
| 在 Claude Code 內看即時 run 狀態 | [監控 mod](docs/monitor.zh-TW.md) |
| 所有指令的完整說明 | [指令](docs/commands.zh-TW.md) |
| 從舊版升級 | [升級到 run v2](docs/upgrading-run-v2.md) |
