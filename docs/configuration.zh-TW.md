# 目錄結構

```
~/agent-lyceum-config/
├── team.yaml                         # 全域 agent 庫
├── agents/<agent>/{AGENT.md, memory/}  # 全域人設 + 跨專案記憶
├── calls/<call-id>/{task.md, log/, result.md}   # 每次 `call`（不屬於任何專案）一個資料夾，另有 .lock-<agent>
└── projects/<project>/
    ├── project.yaml                  # 團隊、repo 路徑、覆寫設定
    ├── agents/<agent>/{AGENT.md?, memory/}   # 專案層人設（選用）+ 專案記憶
    ├── shared/common/{COMMON.md, records/{decisions,lessons}/<id>.md, records/.archive/}   # 由 lead 維護，其他 agent 唯讀；每個決策／教訓一個檔（frontmatter：status、date、run?、supersedes?、title）；.archive 是 tidy 的輸出，不會放進 prompt
    ├── locks/<run-id>.json           # 該 run 執行期間持有
    ├── task-memory/<run-id>/{<agent>/, _shared/}   # 任務記憶：每次 run 獨立，不與其他任務共用；_shared 是 lead 為追加要求寫的交接筆記
    └── runs/<run-id>/{task.md, log.jsonl, state.json, result.md, done-<n>.md, followups/<n>.md, snapshots/, agents/, mail/{inbox,outbox}/<agent>/}
```

`team.yaml` 定義可重複使用的 agent；`project.yaml` 選擇團隊並覆寫欄位。物件會逐欄位合併，陣列（`can_message`）則整個取代。相對路徑以寫入該路徑的檔案所在資料夾為基準；允許使用 `~`。

```yaml
# project.yaml
dir: ~/code/web-app
team: { lead: lead }
dispatcher: { max_rounds: 0, wake_timeout_sec: 600, retry: 2, strict: false, log_max_bytes: 8388608 }
agents:
  lead:      { resume: true, can_message: all, can_edit_agent_md: true }
  fe-member: { runtime: codex, can_message: [lead] }
  qa-member: { can_message: [lead] }
  pm:        { can_message: [lead], allow_web: fetch }   # pm 可以搜尋並讀網頁；其他人沒有網路工具
```

Agent 欄位：`runtime`（`claude-code`|`codex`；若 `model` 可辨識則可省略：`opus`/`sonnet`/`haiku`/`claude-*` → Claude Code，`gpt-*`/`o3`/`*codex*` → Codex；優先順序：專案 runtime > 專案 model > 全域 runtime > 全域 model）、`model`、`effort`（Claude Code：`low`|`medium`|`high`|`xhigh`|`max`，經 `--effort`；Codex：`minimal`|`low`|`medium`|`high`|`xhigh`，經 `model_reasoning_effort`；未設則用 CLI 預設）、`agent_md`、`memory.global` / `memory.project`、`resume`、`can_message`（`all` 或清單；預設 `[lead]`，lead 預設 `all`）、`can_edit_agent_md`（預設只有 lead）、`can_ask_user`（可用 `type: ask` 信件向你提問並暫停 run 等待回答；預設只有 lead）、`allow_web`（`none`|`search`|`fetch`：agent 可以使用多少網路，不設就是不開；見下方「網路存取」）。

`doctor` 檢查的規則：至少 2 個 agent（lead 加一位成員；範本預設是三位）、lead 在 agent 清單內、每個 agent 都有 runtime（明設或由 `model` 推斷）且 `AGENT.md` 存在、`effort` 對該 runtime 合法（若 `runtime` 與可辨識的 `model` 矛盾則警告）、`can_message` 的目標存在，以及記憶資料夾互不重疊。零設定並行變更中移除的設定（見[升級](upgrading-run-v2.md)）仍可載入，只會產生警告。

並行不需要設定：在有 commit 的 git repo 裡，每個 run 與每個 agent 都有自己的 worktree；否則 run 直接在該資料夾工作、一次一個 agent。見[一次執行如何運作](how-it-works.zh-TW.md#同時執行多個-task)。

## 備援模型

模型因暫時性原因持續失敗時，run 可以改用備用模型繼續，而不是直接停下來；見[喚醒失敗時](how-it-works.zh-TW.md#喚醒失敗時)。備用模型是一個有順序的清單 `fallback`，每個項目的欄位如下：

- `model`、`runtime`、`effort`，都是選填，但每個項目至少要有 `model` 或 `runtime`。沒寫 `runtime` 時由 `model` 推斷（規則與 agent 相同），推斷不出來就沿用該 agent 自己的 runtime。只寫 `runtime` 不寫 `model`，表示用該 runtime 的預設模型。`effort` 必須對該項目的 runtime 合法。沒寫 `effort` 的項目用它那個 runtime 的 CLI 預設，不會沿用主要模型的 `effort`。

寫在哪裡，優先順序由高到低：

1. `project.yaml` 的 `agents.<name>.fallback`；
2. `team.yaml` 中該 agent 的 `fallback`；
3. `project.yaml` 的 `dispatcher.fallback`，由沒有自己清單的所有 agent 共用；
4. 都沒有：該 agent 沒有備用模型。

agent 設成 `fallback: []` 表示不備援，即使有設 `dispatcher.fallback`。`dispatcher.fallback_cooldown_sec`（預設 `300`）是在這次 run 中，遇到 `rate_limit` 或 `quota` 的模型被略過多久；設為 `0` 表示永遠不冷卻。

```yaml
# project.yaml
dispatcher:
  fallback_cooldown_sec: 300
  fallback:                                   # 所有沒有自己清單的 agent 的備用模型
    - { model: sonnet }                       # runtime 由 model 推斷：claude-code
    - { runtime: codex, model: gpt-5, effort: high }
agents:
  reviewer: { fallback: [] }                  # 這個 agent 不切換
  pm:       { fallback: [{ runtime: claude-code, model: haiku }] }
```

下列情況設定會載入失敗（`doctor` 與 `run` 會回報錯誤）：

- 項目既沒有 `model` 也沒有 `runtime`，或推斷不出 runtime；
- 項目的 `effort` 不適用於它的 runtime；
- agent 自己的清單裡，項目與該 agent 自己的 runtime 和 model 都相同。共用的 `dispatcher.fallback` 若剛好含有某個 agent 自己的模型則不算錯誤，該項目對這個 agent 會直接略過；
- 備用模型的防護比主要模型弱：在記憶、`AGENT.md`、其他 agent 的 context、交接筆記或 repo 的 `CLAUDE.md`／`AGENTS.md` 這幾項，備用模型是 `prompt-only` 而主要模型更強。例如沒有 OS 沙箱時，`claude-code` 退到 tool rules，但 `codex` 備援會是 prompt-only，這個切換會被拒絕。見 [Write scope](write-scope.zh-TW.md)。

只要有任何 agent 設了備援，`doctor --resolved` 就會顯示生效的備援鏈與它的來源。
