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

## 平行實例

lead 可以讓一位成員同時以多個實例執行；見[同一成員的平行實例](how-it-works.zh-TW.md#同一成員的平行實例)。唯一的設定是選填的：

```yaml
# project.yaml
dispatcher:
  max_instances: 2   # 選填，1–8；沒寫 = 4；1 = 不平行
```

- `max_instances` 是一位成員在一個 run 裡最多可有的實例數，值為 `1`–`8` 的整數；其他值會載入失敗並指出 `dispatcher.max_instances`。除非你明寫，`doctor --resolved` 不會顯示它。（規格 23.4、23.13）
- 不論怎麼設定，下列情況有效上限都是 1：run 不在 worktree 模式（見[一次執行如何運作](how-it-works.zh-TW.md#同時執行多個-task)）、lead、solo run、使用舊版 mailbox 配置的 run、以及名稱不能當 branch 名稱的成員。下列兩種情況則是調低上限而非設為 1：設定中有 agent 取了實例會得到的名字（見「名稱」），以及在特定 run 中某個實例可能寫入成員的共用記憶（見下）。實例從 2 起依序檢查，上限停在第一個衝突實例之前（上限 `k-1`）。（`src/instances.ts` 的 `instanceCap`）
- **混用版本：** 舊版 binary 會以「Unrecognized key」拒絕含 `dispatcher.max_instances` 的 `project.yaml`（和任何新鍵一樣），也看不到用過實例的 run（state `schema_version: 3`）；見[升級](upgrading-run-v2.md#parallel-instances-run-state-v3)。若會在版本之間切換，請不要寫這個鍵（預設是 4）。（23.4、23.10）
- **記憶路徑：** 成員的 `memory.global`／`memory.project` 不可在 run 資料資料夾（`task-memory/`、`runs/`、`worktrees/`、repo 的 git dir）之內或包含它們，因為該成員的其他實例會在那裡寫入。只有在某個 run 裡共用記憶確實與該實例的可寫路徑（其 worktree、git dir 或 run 資料夾）重疊時，上限才會降低：這是逐 run、逐實例判斷，有衝突的實例不會被開啟（上限 `k-1`）。`doctor` 的檢查範圍較廣，其警告僅供參考：確定衝突（記憶包含某個資料夾）的措辭是「runs one task at a time」，記憶位在其中一個資料夾之內則是「may prevent extra instances for some runs」。已有實例的 run，若其中某實例現在會有寫入共用記憶的能力，`resume` 會拒絕。`doctor` 還有其他關於實例的訊息（主體都是 `instances`）：你明寫 `max_instances` 大於 1、但這裡的 run 在 checkout 內輪流執行時給警告；成員名稱不是有效 branch 名稱時給 info；Codex 且沒有 OS sandbox 的成員，給 info（若你明寫了 `max_instances` 則是警告），說明只有成員本身會寫它的記憶，其他實例只是被告知不要寫。（`src/instance-containment.ts`、`src/instances.ts`、`src/doctor-instances.ts`）
- **名稱：** 設定中有 agent 取了實例的名字（`frontend` 也是角色時的 `frontend--2`），會讓 `frontend` 的實例數受限，並產生指出衝突 agent 的 `doctor` 警告。（`src/doctor-instances.ts`）

### Lead AGENT.md 平行 task 指引

功能可用時，harness 會在 lead 的系統提示加上 `## Parallel tasks` 段落。`init` 也會在它建立的 lead persona 放一條簡短規則，但不會改動現有的 `AGENT.md`：harness 加入的原文是 `src/prompt.ts` 的 `PARALLEL_SECTION`，`init` 寫入的那行是 `src/scaffold.ts` 的 `LEAD_PARALLEL_HINT`。要讓你自己的 lead 有類似規則，下面的段落是可自行調整的範例（較短的改寫，不是 harness 的原文）。（23.12）

```markdown
## Parallel tasks
- Mark a task `parallel: true` only when it is independent of the other open tasks and changes different files.
- Before sending tasks you want in parallel, list in each task's `## Scope` the files it will touch. If two lists overlap, do not mark them parallel.
- Work on shared components, types, routes, configuration or design tokens goes first, alone and without the flag; send the dependent tasks after it is integrated.
- Send each parallel task as its own new `task` (not a reply). Instance 1 keeps the member's name; the others are `<member>--2`, `<member>--3`.
- Send revisions as a reply (`reply_to`) to the mail of the instance that did the work. An instance whose work is blocked takes no new task until that work is in the repo: reply to the failure about it to redo it.
- After parallel work is back, have one member type-check and test the combined result before you send `done`.
```

（上面的範例是給 agent 讀的 AGENT.md 內容，所以保留英文。）

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

## 模型分級

agent 的 `model` 可以是「上限」而不是固定選擇：lead 在 task 上標 `tier: low|mid|high`，dispatcher 就用同一 runtime 上較便宜的模型喚醒成員，絕不超過它的 `model`。tier 如何選擇與套用見[每個 task 的模型分級](how-it-works.zh-TW.md#每個-task-的模型分級)。（spec 24.1）

```yaml
# team.yaml（全域）或 projects/<name>/project.yaml
model_tiers:
  claude-code: [claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5]   # 低 → 高
  codex: [gpt-6.1-mini, gpt-6.1-sol]
agents:
  node-engineer: { model: claude-opus-5-5 }    # 可用：haiku、sonnet、opus
  docs-writer:   { model: claude-sonnet-5-5 }  # 可用：haiku、sonnet（上限 sonnet）
  cli-reviewer:  { model: gpt-6.1-sol }        # 可用：gpt-6.1-mini、gpt-6.1-sol
```

- **寫在哪、如何合併：** `model_tiers` 是頂層鍵，每個 runtime（`claude-code`、`codex`）一條清單，由低到高排列；`team.yaml` 與 `project.yaml` 都可寫。同一 runtime 以 project 整條取代 team；在 `project.yaml` 寫 `model_tiers: { codex: [] }` 即在該專案關掉 Codex 階梯。（24.2 D-01、24.3）
- **`model` 是上限：** agent 可用階梯上從最低到它的 `model`（含）的項目，更高的永遠不用。`model` 必須在它所屬 runtime 的階梯上。沒寫 `model`、或 `model` 就是最低項的 agent 沒有可降的，照舊運作。（D-02、24.3.3）
- **runtime 互不影響：** agent 只在自己 runtime 的階梯上移動；與被審者在不同 runtime 的 reviewer 不受影響，tier 不會換 runtime。`effort` 不分級：每個 tier 都用 agent 自己的設定。（24.1、D-09）
- **對應：** 可用項目 `A` 共 `n` 項（由低到高，`A[n-1]` 為上限）：`low` = `A[0]`、`high` = `A[n-1]`、`mid` = `A[floor(n/2)]`，所以 `n` 為偶數時 `mid` 取偏高者。（D-03、24.4）

  | 可用項目數 | `low` | `mid` | `high` |
  |---|---|---|---|
  | 1 | 第 1 項 | 第 1 項 | 第 1 項（不適用分級） |
  | 2 | 第 1 項 | 第 2 項 | 第 2 項 |
  | 3 | 第 1 項 | 第 2 項 | 第 3 項 |

- **預設關閉：** 沒有階梯、或 task 沒寫 `tier`，就用成員自己的 `model`，與先前完全相同。lead 自己的模型不分級。（24.1）

下列情況設定載入失敗（`doctor` 與 `run` 回報錯誤）：（24.3.4）

- 階梯項目不是該 runtime 的模型（`model_tiers.<rt>[<i>]: "<m>" is not a <rt> model ...`）；
- 同一條階梯重複列出同一模型；
- agent 的 `model` 不在它 runtime 的階梯上（`Agent "<a>": model "<m>" is not on model_tiers.<rt> ...`）。請把它加進階梯，或在 `project.yaml` 設 `model_tiers.<rt>: []`。

`doctor` 在 agent 沒寫 `model`（階梯對它不適用）、以及沒有任何成員能低於自己的 `model`（分級沒有效果）時發出警告。

`doctor --resolved` 會列出 `model_tiers.<runtime>` 與它的來源檔，以及 `agents.<name>.model_tiers`（該 agent 可用的項目）；沒設階梯時兩行都不出現。（24.9）

**混用版本：** 舊版程式會拒絕載入含 `model_tiers` 的 `team.yaml` 或 `project.yaml`；見[降級（改用舊版）](../README.zh-TW.md#降級改用舊版)。（24.3.2、24.13 R-4）

**Lead 指引：** 至少一個成員能低於自己的 `model` 時，harness 會在 lead 的系統提示加 `## Task tiers` 段落；沒有階梯時提示不變。續接的 Claude lead 可能保留舊系統提示，run 中途新增階梯時它可能看不到（未驗證）。（24.10）
