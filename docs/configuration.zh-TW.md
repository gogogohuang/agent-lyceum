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

Agent 欄位：`runtime`（`claude-code`|`codex`；若 `model` 可辨識則可省略：`opus`/`sonnet`/`haiku`/`claude-*` → Claude Code，`gpt-*`/`o3`/`*codex*` → Codex；優先順序：專案 runtime > 專案 model > 全域 runtime > 全域 model）、`model`、`effort`（Claude Code：`low`|`medium`|`high`|`xhigh`|`max`，經 `--effort`；Codex：`minimal`|`low`|`medium`|`high`|`xhigh`，經 `model_reasoning_effort`；未設則用 CLI 預設）、`agent_md`、`memory.global` / `memory.project`、`resume`、`can_message`（`all` 或清單；預設 `[lead]`，lead 預設 `all`）、`can_edit_agent_md`（預設只有 lead）、`can_ask_user`（可用 `type: ask` 信件向你提問並暫停 run 等待回答；預設只有 lead）、`allow_web`（`none`|`search`|`fetch`：agent 可以使用多少網路，不設就是不開；見下方「網路存取」）、`sandbox`（`write`、`network`、`local_binding`、`unix_sockets`：以 agent 為單位的 sandbox 放寬，不設就全關；見 [Sandbox 放寬](#sandbox-放寬)）。

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

## Sandbox 放寬

以 agent 為單位、需明確開啟的 OS sandbox 放寬。預設全關；沒寫 `sandbox` 的 agent 拿到的設定與以前完全相同。設計見 [spec 25](specs/25-sandbox-allowances.md)。spec 25 已在 0.28.0 實作；標「未驗證」的端到端效果尚未實測。

```yaml
# project.yaml（或 team.yaml）
agents:
  fe-member:
    sandbox:
      write: [~/.cache/foo, /tmp/bar]        # repo 之外額外可寫的路徑
      network: [registry.npmjs.org]          # Bash 可連的主機
      local_binding: true                    # 在本機 bind 連接埠／接受連線
      unix_sockets: [/private/tmp/tsx-501]   # 此路徑下的 Unix socket（bind 與 connect）
```

四個鍵都可省略；`[]` 與 `false` 等同不寫。`sandbox` 底下的未知鍵是設定錯誤。`project.yaml` 的 `sandbox` 整個取代 `team.yaml` 的，不逐鍵合併，所以專案可以收窄團隊檔允許的範圍。lead 與其他 agent 同樣處理。

**路徑規則**（`write` 與 `unix_sockets`）：

- 會展開 `~`。**不會**展開 `$TMPDIR` 與其他環境變數：請自行解出，例如 `printf '%s\n' "$TMPDIR/tsx-$(id -u)"`，把結果的絕對路徑貼進去。
- 展開 `~` 後必須是絕對路徑；相對路徑會被拒絕。
- 拒絕 pattern 字元 `* ? [ ] { } ( ) !`、反斜線與控制字元。
- 路徑不得等於、位於或包含受保護路徑。禁止範圍（來自 `src/sandbox-invocation.ts` 的 `protectedPathsFor`）：agent-lyceum 設定資料夾與 repo（含自己的記憶）、所有 agent 的 `AGENT.md`、記憶資料夾、inbox 與 outbox、`COMMON.md` 等共用情境檔、repo 的 `CLAUDE.md`／`AGENTS.md`、紀錄資料夾、`~/.claude`、`$CODEX_HOME`（未設為 `~/.codex`），以及這些路徑的任何祖先（例如 `~`）。invocation 當下的檢查還涵蓋該 run 的資料夾、worktrees 根目錄、其他 agent 的 worktree 與 git 目錄、git common dir，以及該 agent 的寫入保護路徑。錯誤訊息會指出鍵、索引與受保護路徑。每次 invocation 前會在真實路徑（解開 symlink）上再檢查一次。
- **拒絕。** 被拒絕的 invocation 不會啟動 runtime。它寫一筆 `sandbox-refused` 事件（`agent`、`runtime`、`reason`，有路徑時加 `path`），並回傳 `config` 失敗：不重試、不 backoff、不換備援。在 run 裡，被拒的喚醒仍佔一個 round，run 以 `agent_failed` 結束（被拒的是 lead 則為 `lead_failed`），原因寫在 run 的失敗紀錄（`state.failure.error`），不會喚醒 lead。`agent-lyceum call` 做同樣的檢查，把 `sandbox` 與 `sandbox-refused` 事件以 JSON 行印在 stderr，被拒時以非零 exit 結束（`Call failed: …`，`src/cli.ts:607`）。
- 尚不存在的路徑允許（`doctor` 印 info）；agent-lyceum 不會替你建立。

`network` 填含點的主機名，如 `registry.npmjs.org`（轉小寫；最多一個開頭的 `*.`；不可有 scheme、port、路徑、IP 或單獨的 `*`；`localhost` 這類單一標籤主機會被拒絕，見 `src/schema.ts` 的 `DOMAIN_RE`）。Claude 是否支援 `*.` 未驗證。

**各 runtime 實際拿到的：**

| 鍵 | Claude Code | Codex |
|---|---|---|
| `write` | 加進 `Edit` 規則、sandbox `allowWrite` 與 `--add-dir` | 加進 `sandbox_workspace_write.writable_roots` |
| `network` | `sandbox.network.allowedDomains`（逐網域） | 只要有任何網域就開 `network_access=true`：**所有主機**，不只列出的；`doctor` 警告 |
| `local_binding` | `sandbox.network.allowLocalBinding: true` | 不套用；`doctor` 警告 |
| `unix_sockets` | `sandbox.network.allowUnixSockets` | 不套用；`doctor` 警告 |

帶 policy override 的喚醒（例如記憶整理）不會套用任何放寬。沒有 OS sandbox（Windows、沒有 `bwrap` 的 Linux）時：Claude 的 `write` 只擴大 `Edit` 工具規則，Bash 可繞過，其他鍵無作用；Codex 只靠提示，沒有任何放寬被強制。`doctor` 會逐 agent 說明。各鍵真正放行的範圍見 [寫入範圍](write-scope.zh-TW.md#sandbox-放寬)。

`doctor` 逐 agent 列出要求的放寬（`writes outside repo`、`network`、`local_binding`、`unix_sockets`，以及 runtime 是否套用）和上述警告；`doctor --resolved` 只對有設定的 agent 顯示 `agents.<name>.sandbox`。它顯示的是 agent-lyceum 產生的內容，不是 runtime 算出的合併後 policy（使用者層級的 Claude `settings.json` 可能再疊加；未驗證）。每次帶放寬的喚醒會在 run log 寫一筆 `sandbox` 事件，並列要求值與實際套用值。

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
- 備援透過 `sandbox` 被允許的比主要的更多：只計 runtime 與平台實際會套用的部分，依 `network`（none < domains < all）、`local_binding`（off < on）、`unix_sockets`（off < on）比較。例如 `claude-code` 主要模型設了 `network: [registry.npmjs.org]` 而備援是 `codex`，會被拒絕，因為 Codex 會連所有主機；Codex 主要模型的 `local_binding: true`（未套用）搭配 macOS 上的 Claude Code 備援也會被拒絕。每次 invocation 前會重查整條備援鏈。見 [Sandbox 放寬](#sandbox-放寬)。

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

## 節省 token

每次喚醒都會重讀 agent 的整個 context，所以喚醒次數是一次 run 的主要成本。使用者在 3 次 run 上的實測：輸出約 156k token、cache 讀取約 12.5M token，每次喚醒約重讀 300k token 的 context。其中一次 run 的 13 輪裡有 6 輪是 lead 重新派工或收信的喚醒；一行的修改跑了 code review、docs review、QA 與 QA review，QA 加其 review（輸出約 14.6k token）的花費是實作的兩倍。以上是單一使用者的量測，不是 benchmark。

### Lead 的 prompt 規則

lead 的 prompt 有只給 lead 的 `## Keeping wake-ups few` 段落。摘要如下，它要求 lead：

- 把彼此獨立的工作在同一次喚醒送出（例如實作與對應的文件），回覆都回來後只決定一次；
- 小修改跳過 QA 層（驗證角色與其 reviewer）：幾行程式、一個修改前失敗修改後通過的重現測試、加上 code review 核可。大型、跨模組或使用者可見的變更才送 QA；
- 只在三個時刻使用最強（最貴）的模型：計畫定稿前、同一個錯誤第二次出現時、`done` 之前。

這些是 prompt 規則，模型是否遵守並未量測。dispatcher 不會延後喚醒：單獨抵達的每封回覆仍會喚醒 lead。同時在等的回覆會被合併（最多 5 封，見 `src/prompt.ts` 的 `LEAD_BATCH_LIMIT`），所以節省來自信件變少，而不是 dispatcher 壓住喚醒。

### 各角色的模型選擇

模型寫在你自己的 `team.yaml` 或 `project.yaml`；repo 不會改你的設定。別名 `opus`、`sonnet`、`haiku` 都接受並推斷為 `claude-code` runtime（`src/schema.ts` 的 `inferRuntime`）。別名由 Claude CLI 解析成實際模型，結果取決於你的供應商與 CLI 版本（在 Anthropic API 上 `haiku` 是 Haiku 5.5，即 `claude-haiku-5-5`；見 [Model aliases](https://code.claude.com/docs/en/model-config#model-aliases)）；需要固定模型時請寫完整 model ID。

```yaml
# team.yaml（或 project.yaml 的 agents:）
agents:
  tech-lead:      { runtime: claude-code, model: opus }
  cli-architect:  { runtime: claude-code, model: opus }
  node-engineer:  { runtime: claude-code, model: sonnet }
  code-explorer:  { runtime: claude-code, model: haiku }   # 唯讀搜尋
```

較便宜的搜尋模型可能漏掉東西；當它的回答會影響決策時，保留該角色的 reviewer。

Codex：reviewer 放在另一個 runtime（`codex`），搜尋與實作用 Claude。這裡沒有查證過的便宜 Codex model id，所以 Codex 維持 CLI 預設，並照原樣使用現有的 [`fallback`](#備援模型) 備援鏈。

### 什麼時候不需要整個團隊

成本以喚醒次數計，而團隊 run 一開始就是多 agent（單一使用者的一次 65 次喚醒的 run 裡，lead 佔了 27 次）。單人模式已經存在。對任務問四個問題：

1. 是否需要另一個 runtime 上的 maker-checker review？
2. 工作是否能切成獨立、可平行的部分？
3. 是否需要不同的專長？
4. 單一 agent 的 context 是否會不夠用？

四題都是「否」時，用 `run --agent <name>` 把任務交給單一成員（見 [run](commands.zh-TW.md#run) 的 `--agent` 選項）；不在任何專案內時用 [call](commands.zh-TW.md#call)。

這是為本專案改寫的經驗法則，不是照抄「Graph Engineering」文章的規則（「任何一題答否就維持單一迴圈」）：問題不同，規則也不同（這裡是四題都答「否」才用單人）。它對成本與品質的影響沒有量測，所以不保證任何結果，也沒有節省比例。在本專案中第一題通常是「是」，因為跨 runtime review 是刻意的設計。

### max_rounds 能限制什麼

`dispatcher.max_rounds` 限制的是喚醒嘗試次數，重試與備援嘗試都算在內：每次 invoke 嘗試 `state.rounds` 加一（`src/run-session.ts` 的 `const round = ++state.rounds;`），在每次嘗試前與每個批次前檢查。可以用它來限制一次 run 做多少工作。

它不是 token 或金額預算，也不保證花費上限：每次喚醒的成本隨模型、重試、輸出長度與 cache 命中而不同。上面約 300k token 的數字是單一使用者的量測，不是 benchmark。

- 到達上限時 run 以 `partial` 結束（「Stopped at the round limit before the lead sent done.」，`src/run-outcome.ts`），[`resume`](commands.zh-TW.md#resume) 在調高上限前會拒絕執行（`src/cli.ts`）。重開之後，上限從重開時起算；見同一頁的 `resume`。
- 預設是 `0`，代表不限（`src/schema.ts`；驗證為不小於 0 的整數）。

### 未做

- `claude --advisor`：本機 claude 2.1.310 的 `claude --help` 沒有這個旗標。
- 「JEV」：repo 與 CLI 裡都找不到，無法查證。
