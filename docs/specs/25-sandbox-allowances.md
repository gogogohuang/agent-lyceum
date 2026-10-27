# 25 每個 agent 的 sandbox 放寬（`project.yaml` 的 `sandbox`）

狀態：**修訂 2，待第 2 輪審查**（cli-architect-reviewer）。輸入：lead 任務 b24b3daf（使用者任務 c0f62d 第 2 部分）。

修訂依據：lead 任務 196c0ea9（審查 0effa0f2、Part 1 綜合 d4023e8b）。本輪核對 `src/call.ts:48-65,165-197` 與 `src/policy.ts:64-203`；其他行號沿用 draft 1，未全部重新核對。本文描述新增行為均為設計；runtime 探測引用 Part 1，不宣稱本輪親測，證據層級見 25.3、25.11。

## 25.1 目標與限制

**目標**：讓使用者替單一 agent 開四種 sandbox 放寬，預設全關：

```yaml
agents:
  fe-member:
    sandbox:
      write: [~/.cache/foo, /tmp/bar]   # repo 之外額外可寫的路徑
      network: [registry.npmjs.org]     # Bash 可連的網域
      local_binding: true               # macOS：本機任意 IP bind/inbound + localhost outbound
      unix_sockets: [/private/tmp/tsx-501] # 該路徑下 Unix socket bind + connect
```

**硬性限制**：
1. 沒寫 `sandbox` → 產生的 Claude settings、Claude／Codex 參數、log、`doctor --resolved`、`status --json` 與今天逐位元組相同。
2. `allowUnsandboxedCommands: false`（`src/adapters/claude.ts:45`）永不放寬；本 spec 不給任何 agent（含 lead）任何在 sandbox 外執行的途徑。
3. 不能用 `write` 打開任何受保護路徑（25.4.3）。
4. 沒有新依賴。

**非目標**：放寬讀取（write scope 本來就不管讀，見 lesson `write-scope-is-not-read-isolation`）；Codex 逐網域網路（25.5，未驗證是否存在）；`excludedCommands` 等其他 sandbox 鍵；讓 lead 執行 sandbox 外的指令。

## 25.2 決議總表

| # | 決議 | 理由 |
|---|---|---|
| D-01 | `sandbox` 是 agent 欄位，與 `allow_web` 同層（`src/schema.ts:68`），`team.yaml`／`project.yaml` 都可寫；project 整個物件取代 team（`pick`，`src/config.ts:160-170`），不逐鍵合併 | 合併只會讓放寬變大；project 必須能收窄 |
| D-02 | 四個子鍵都可省略；`write: []`、`network: []`、`local_binding: false`、`unix_sockets: []` 與不寫相同，不輸出任何設定 | 硬性限制 1 |
| D-03 | `write` 展開 `~`、要求展開後是絕對路徑、`path.resolve` 正規化；檢查與輸出都用 `canonicalPath`（`src/paths.ts:86`）| `/tmp` 在 macOS 是 `/private/tmp` 的 symlink；Seatbelt 比對的是真實路徑（未驗證，所以兩者都檢查、輸出真實路徑） |
| D-04 | `write` 加進 `writePolicy().allowDirs`（`src/policy.ts:126-132`），由既有程式碼一路帶到 Claude `Edit` allow、`allowWrite`、`--add-dir` 與 Codex `writable_roots` | 一個插入點；`doctor` 既有的「writes outside repo」行（`src/validate.ts:158`）自動列出 |
| D-05 | 等於、在其內、或包含受保護路徑 → 錯誤；載入時早期檢查，每次 invocation 前再查當次具體路徑 | 25.4.3 |
| D-06 | `network`：Claude → `sandbox.network.allowedDomains`；Codex → 有任何網域就 `sandbox_workspace_write.network_access=true`（全開），`doctor` 警告不是逐網域 | Codex 沒有已驗證的逐網域設定 |
| D-07 | `local_binding`：Claude → `sandbox.network.allowLocalBinding: true`；Codex 沒有對應鍵 → 不輸出任何東西、`doctor` 警告 | 不替使用者把「只要 bind」擴大成「整個網路」 |
| D-08 | fallback：備援的實際套用能力 tuple 任一分量比主要的大 → 載入錯誤（Claude 逐網域 → Codex 全開 = 拒絕） | 沿用「備援不能保護更少」（`src/validate.ts:116-145`） |
| D-09 | 每次 invocation（有放寬時）寫一筆 log `sandbox`，列出實際套用的放寬 | 25.8 |
| D-10 | lead 沒有任何不同待遇 | 25.6 |
| D-11 | 無 OS sandbox：Claude write 只改 Edit 規則；Codex prompt-only；其餘無作用 | 25.7 |
| D-12 | `unix_sockets` → Claude `sandbox.network.allowUnixSockets`；Codex 不輸出並警告 | 不使用 `allowAllUnixSockets`；路徑規則與 write 相同 |

## 25.3 設定鍵出處（Claude、Codex）

| 用途 | 鍵 | 證據 | 狀態 |
|---|---|---|---|
| Claude 額外可寫 | `sandbox.filesystem.allowWrite` | 已在用（`src/adapters/claude.ts:46-48`）；binary 字串 `allowWrite` 39 次（`strings` Claude 2.1.311） | 已在用 |
| Claude 網域 | `sandbox.network.allowedDomains` | binary 字串 `allowedDomains` 30 次；文件 https://code.claude.com/docs/en/sandboxing（本次未擷取） | 鍵名：binary 字串；行為與萬用字元語法：未驗證 |
| Claude 本機 bind | `sandbox.network.allowLocalBinding` | binary 字串 26 次，其中一段系統提示原文：「tell the user that `sandbox.network.allowLocalBinding: true` in their settings … allows it without leaving the sandbox」 | 鍵名與路徑：binary 字串 |
| Claude Unix sockets | `sandbox.network.allowUnixSockets` | lead 綜合 d4023e8b 的 2.1.311 profile（25.11） | profile 支援 scoped bind/connect；tsx 端到端未驗證 |
| Claude 不放行沙箱外 | `sandbox.allowUnsandboxedCommands: false` | `src/adapters/claude.ts:45` | 已在用、不改 |
| Codex 可寫根 | `sandbox_workspace_write.writable_roots` | 已在用（`src/adapters/codex.ts:66-67`） | 已在用 |
| Codex 網路 | `sandbox_workspace_write.network_access` | binary 字串 `network_access` 42 次（`strings` codex-cli 0.163.0）；Codex `docs/config.md`（未擷取） | 鍵名：binary 字串；`-c` 寫法與 bind 是否因此可用：未驗證 |
| Codex 逐網域 | （binary 有 `allowed_domains` 字串） | 出處與所屬設定不明 | 未驗證，不使用（25.15 R-04） |
| Codex 本機 bind | 無已知鍵 | — | 未驗證 |

`claude --help` 與 `codex --help` 沒有列 settings 鍵，所以上表沒有 CLI help 出處。node-engineer 實作前，runtime-debugger 要用真實 CLI 各跑一次（25.13 開放項 1-3）。

## 25.4 解析與驗證

### 25.4.1 Schema（`src/schema.ts`）

```ts
const DOMAIN_RE = /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const SandboxPartial = z.object({
  write: z.array(z.string().trim().min(1)).optional(),
  network: z.array(z.string().trim().toLowerCase().regex(DOMAIN_RE, "expected a host name like registry.npmjs.org or *.example.com (no scheme, port, path or IP)")).optional(),
  local_binding: z.boolean().optional(),
  unix_sockets: z.array(z.string().trim().min(1)).optional(),
}).strict();
// AgentPartial 加一行：sandbox: SandboxPartial.optional(),
```

- `.strict()`：未知鍵（例如 `sandbox.net`）是 ConfigError。錯誤格式沿用 `src/config.ts:103`：`agents.fe-member.sandbox.network.0: expected a host name …`（zod 路徑以 `.` 接，索引是 `.0` 不是 `[0]`，與現有錯誤一致，不另做格式）。
- 網域：小寫化；只接受主機名，可有一個前綴 `*.`；拒絕 `*`、scheme、port、路徑、IP。Claude 是否支援 `*.` 未驗證（開放項 1）；若不支援，改成拒絕 `*.` 而不是靜默傳下去。
- `unix_sockets` 與 `write` 共用路徑解析及保護檢查；僅展開 `~`，**不展開 `$TMPDIR`、其他環境變數或 shell substitution**。使用者先在 shell 執行 `printf '%s\n' "$TMPDIR/tsx-$(id -u)"`，將結果的絕對路徑貼入 YAML；也可用已知的絕對路徑。
- 兩類路徑一律拒絕 Claude pattern metacharacters：`* ? [ ] { } ( ) !`、反斜線及控制字元（包含換行／NUL），raw、展開與 canonical 結果都檢查，錯誤指名鍵與索引；不嘗試自行 escaping。JSON encoding 不能防止 runtime 把字串當 pattern。
- `write` 的型別錯誤（非字串、空字串）在 schema 擋；路徑規則（絕對路徑、受保護路徑）在 25.4.2–25.4.3，因為需要已解析的 project。

### 25.4.2 解析（`src/config.ts`）

- `ResolvedAgent` 加 `sandbox?: { write: string[]; network: string[]; localBinding: boolean; unixSockets: string[] }`；四者全空／false 時**不設**此欄位（硬性限制 1 的唯一開關）。
- `write`：`expandHome`（`src/paths.ts:7-12`）後必須 `path.isAbsolute`，否則 ConfigError `agents.<a>.sandbox.write.<i>: must be an absolute path or start with ~/ (got "<raw>")`。**不用** `absPath`：相對路徑相對於哪個檔案在兩層設定下會不同，乾脆拒絕。再 `path.resolve` 去掉 `..`／尾斜線，去重。
- `sources.sandbox` 照 `pick` 記錄；`AGENT_FIELDS`（`src/config.ts:363`）加 `"sandbox"`；`flattenResolved`（`src/config.ts:434` 附近）**只在 `a.sandbox` 有值時**輸出 `agents.<a>.sandbox`，讓沒用的人 `doctor --resolved` 不變（同 `fallback`、`model_tiers` 的作法，`src/config.ts:435-436`）。

### 25.4.3 受保護路徑（`src/validate.ts` + `src/policy.ts`）

新增純函式 `sandboxPathConflicts(entries, protectedPaths)`，放 `src/policy.ts`。輸入為已 canonical 的 `{ key, index, path }` 與具理由的 protected paths；回傳 `{ key, index, path, protectedPath, relation: "equal" | "inside" | "contains" }[]`。I/O 蒐集與 canonicalization 留在呼叫邊界，純函式只比 containment。`write`、`unix_sockets` 都檢查 equal／inside／contains；錯誤範例：

`agent fe-member: sandbox.write[0] /Users/x contains protected path /Users/x/agent-lyceum-config (agent-lyceum home); pick a narrower directory.`

**載入時早期檢查**：保留 `project.home`、`project.dir` 根及其祖先的 blanket ban，兩個根底下任何路徑都不能用這兩個欄位放寬，**自己的 memory 也一樣**（它原本已可寫）。另外 canonicalize 所有 agents 的 agentMd、所有 memoryDirs（含自己）、sharedContextFiles、repoInstructionFiles、recordsDir，以及 `~/.claude`、`$CODEX_HOME`（未設用 `~/.codex`）。禁止其祖先，不接受以「本來已可寫」為由繞過驗證。

**每次 invocation 的共同邊界**：新增小函式 `invokeWithSandboxChecks`（建議 `src/sandbox-invocation.ts`），作為所有 adapter invocations 的唯一入口；run wake、resume redo、dynamic instance、lazy workspace 後的 member、fallback attempt 與 `call` 都必經，包含 injected fake Invoker。不得只把檢查放 `realInvoker`，否則 fake fixture 會繞過。此函式先以當次已綁定的 project、agent、override policy、cwd 產生 concrete policy，重新 canonicalize entries 與保護對象，做 path conflict + 25.9 fallback parity，成功後記 25.8 的事件，最後才呼叫底層 invoker。無 sandbox 時直接走原路，不產生額外輸出／探測。

當次 protected set = 載入時各項 + **當次 WritePolicy.deny** + recordsDir（即使 lead 可寫）+ 所有 sharedContextFiles、所有 agents 的 agentMd、所有 memoryDirs + concrete run dir（call 用 callDir）+ worktrees root + 所有已綁定 workspace root/gitDir + cwd/main repo 的 git dir **與 git common dir**。以既有 pinned workspace metadata 為先；缺 common dir 時用參數陣列呼叫 `git rev-parse --git-common-dir`，相對輸出依該 cwd 解析。git common dir 不可由 gitDir 的父目錄推測。明確的 git repo 探測失敗或路徑 realpath 發生權限／I/O 錯誤 → fail closed 並指名路徑；非 git 的 call cwd 可略過 git 項。

不可只 canonicalize home：home 裡的 records、memory 等 descendant 可能是指向 home 外的 symlink，需逐項 canonicalize。每次都從最新 lazy-bound workspace 取得 set；找出衝突時拒絕該 invocation，訊息標 `(checked before invocation)`，不 spawn、不當成 runtime failure 切換備援。載入錯誤仍保留作早期回饋。Fallback parity 是設定錯誤，不得被 runWithFallback 的 generic catch 吞掉或重試。

路徑在檢查與 spawn 間仍可能被換（TOCTOU）；此設計不宣稱抵抗惡意並行 symlink 替換。輸出用這次驗證的 canonical entries，OS sandbox 才是主要執行邊界，post-hoc guard 不新增保護能力。不要為此重設 locks 或 run 格式。

**不存在的路徑**：允許（例如 `~/.cache/foo` 第一次用前還沒有）；`doctor` info：`sandbox.write[0] ~/.cache/foo does not exist yet`。agent-lyceum 不替使用者建立它。Codex 對不存在的 `writable_roots` 的反應未驗證（開放項 3）。

## 25.5 套用到 runtime

### Claude（`buildClaudeSettings`，`src/adapters/claude.ts:25-52`）

- `write`：經 D-04 進 `pol.allowDirs`，既有迴圈產生 `Edit(//<p>/**)`（`:34`）、`allowWrite`（`:47`）、`--add-dir`（`:66,82`）。沿用既有輸出。
- `network` 非空 → `sandbox.network = { allowedDomains: [...] }`；`local_binding` → 同一物件加 `allowLocalBinding: true`。`unix_sockets` 非空 → 同一物件加 `allowUnixSockets: [canonical paths]`。三者都沒有 → **不輸出 `network` 鍵**。
- 鍵順序：`network` 放在 `filesystem` 之後，固定順序，讓 snapshot 測試穩定。
- 有 policy override 的喚醒（`override`，`:25`；例如 scratch cwd 的特殊喚醒）：`write` 不跟（override 的 policy 取代整個 `allowDirs`），`network`／`local_binding`／`unix_sockets` 也不跟——override 本來就是最小權限的喚醒。

`local_binding` 的 macOS scope 是任意本機 IP 的 bind/inbound，加上連到 localhost services 的 outbound；不是只在 localhost serving。Claude 官方文件說 Linux/WSL2 此鍵無效果。`unix_sockets` 是指定 subpath 下 bind **與 connect**，可能接觸該路徑中的服務，不只是測試 listen。兩者不能混為一個權限。

### Codex（`buildCodexInvocation`，`src/adapters/codex.ts:56-79`）

- `write`：經 D-04 進 `codexWritableRoots`（`:7-12`）。不改。
- `network` 非空 → `common.push("-c", "sandbox_workspace_write.network_access=true")`，放在 `writable_roots` 之後；`exec` 與 `exec resume` 都用 `common`（`:76-78`），所以兩條路都有。
- `unix_sockets`：不輸出；doctor warn `agent X (codex): sandbox.unix_sockets has no per-socket Codex control; no setting emitted.`
- `local_binding`：不輸出（D-07）。`doctor` warn：`agent X (codex): sandbox.local_binding has no Codex setting; whether a workspace-write sandbox lets it bind ports is unverified. sandbox.network turns on all network access, not only binding.`
- `network` 非空時 `doctor` warn：`agent X (codex): sandbox.network is all-or-nothing on Codex: this agent may reach any host, not only <domains>.`

## 25.6 安全

- **沒有沙箱外途徑**：`allowUnsandboxedCommands: false` 不改；Claude 的 `permissions.allow` 不加新工具；Codex 的 `-s workspace-write`／`sandbox_mode="workspace-write"`（`src/adapters/codex.ts:77-78`）不改，不出現 `danger-full-access`。schema 沒有任何鍵能改這些。
- **lead 沒有不同待遇**：`sandbox` 對 lead 與成員同樣套用、同樣受 25.4.3 限制。今天唯一「在 sandbox 外」發生的事是 run 結束時 dispatcher（不是 agent）替 lead 推分支、開 PR：條件是被接受的 `done` 帶 `open_pr: true`，而只有 lead 能送 `done`（依 `src/run-session.ts:198` 的註解；`:1034` 設旗標、`:1160` 據以開 PR；「只有 lead 能送 done」的檢查點本 spec 未逐行追），lead 是設定的 `project.lead`，沒有寫死 `tech-lead`。本 spec 不碰這段，也不新增任何以角色名判斷的程式。
- **為何多擋 `~/.claude`、`~/.codex`**：放寬 `write` 是唯一能讓 agent 寫到 home 之外的新途徑；寫得到 runtime 設定，就可能讓下一次喚醒載入使用者層級的 hook 或設定。Claude 的 `--settings` 與使用者 `settings.json` 的優先順序本 spec 沒驗證，所以直接不讓這兩個目錄（及其祖先，例如 `~`）出現在 `write`。
- **網路**：網域只由使用者寫在設定檔；agent 改不到設定檔（`project.paths.config`、`team.yaml` 已在 deny，`src/policy.ts:156`）。
- **注入**：網域經 regex，路徑是 JSON 陣列元素（`JSON.stringify`，`src/adapters/codex.ts:67`；Claude 是 JSON 檔），沒有 shell 拼接。

## 25.7 沒有 OS sandbox 時（Windows、Linux 沒有 bwrap）

`osSandboxAvailable()`（`src/policy.ts:173-179`）為 false 時：Claude 只剩 Edit 工具規則（Bash 可繞過，`:196`），Codex 是 prompt-only（`:199`）。無 OS sandbox 的診斷必須依 runtime 分支（`src/policy.ts:193-203`）：

- Claude：`write` 仍擴大 Edit 工具規則；Bash 可繞過。`network/local_binding/unix_sockets` 無作用。doctor：`agent X (claude-code): no OS sandbox; sandbox.write changes Edit tool rules only; network/local_binding/unix_sockets have no effect.`
- Codex：prompt-only，這四項都不提供 OS 強制。doctor：`agent X (codex): no OS sandbox; enforcement is prompt-only; sandbox allowances provide no OS enforcement.` 不得聲稱 Codex 有 Edit 規則。
- prompt 不新增放寬文字；Windows 僅警告，沿用現有支援範圍。

## 25.8 Log

25.4.3 的共同 invocation 函式在檢查成功、spawn 前，每個有 sandbox 的 attempt 記一筆 `sandbox`；不是只在 run-session 單一行號插入。

```json
{"event":"sandbox","agent":"fe-member","runtime":"codex","model":"gpt-5","attempt":1,
 "write":["/private/tmp/bar"],"network":["registry.npmjs.org"],"local_binding":true,
 "unix_sockets":["/private/tmp/tsx-501"],
 "applied":{"write":"os","network":"all","local_binding":"off","unix_sockets":"off"}}
```

`applied.write` = os/tool-rules/none；network = none/domains/all/unrestricted；local_binding、unix_sockets = on/off/unrestricted。Linux Claude local_binding = off（鍵可輸出但無效果）。override 為全部未套用。requested 欄位與 applied 分開，避免把 requested 當 effective。run 使用既有 log.jsonl；`call` 沒有 run event log（`src/call.ts:165-197`），透過既有 `say` stderr sink 輸出單行同格式 JSON，不新建 store，不污染 stdout reply。錯誤在 spawn 前也由呼叫方現有錯誤渠道報告，含 agent、鍵與檔案。log 寫入失敗則拒絕 spawn，stderr 指名目的檔。無設定不產生事件；不改 state.json/status --json。

## 25.9 Fallback（`src/fallback.ts`、`src/validate.ts:116-145`）

`agentForCandidate`（`src/fallback.ts:52-56`）用 `...agent` 展開，`sandbox` 自動帶到備援，不必改。

保留既有 write-protection 比較（`src/validate.ts:139-143`）完全不變，**另外**在載入與共同 invocation 函式檢查 capability tuple：

`{ network: none < domains < all, local_binding: off < on, unix_sockets: off < on }`

只計 runtime/platform **實際會套用**的能力：Claude + OS 的 network 非空 = domains，Codex + OS = all；空 = none。local_binding 僅 Claude macOS 且 true = on；Claude Linux、Codex = off。unix_sockets 僅 Claude + OS 且非空 = on，Codex = off。相同 agent 配置共用相同 domains/paths；若未來可逐 candidate 配置，不能僅靠 enum 比範圍。無 OS sandbox 時雙方均視為 unrestricted 相等；override 的放寬未套用，均為 off/none。

任一分量 backup > primary → ConfigError，指名 agent、candidate、分量和兩個值；不得 spawn backup。例如 Codex-primary local_binding 未套用 → Claude macOS backup on：拒絕；unix_sockets 同理。Claude domains → Codex all 拒絕；Codex all → Claude domains 可收窄，但不抵銷其他分量變寬。每次 invocation 重查整條 chain（不只目前 candidate），以當次 platform/policy 為準。

## 25.10 doctor

`formatEnforcement` 的額外行（`src/validate.ts:158`）：
- `writes outside repo:` 已自動含 `write` 路徑（D-04），不改。
- 新增：`[X] network: registry.npmjs.org (claude-code: per-domain)` 或 `(codex: all hosts)`；`[X] local_binding: on`／`requested, not supported by codex`；`unix_sockets` 列 canonical paths 與 applied on/off。
- 25.5、25.7 的 warn／info，以及 25.4.3 不存在路徑的 info。
- `doctor --resolved`：`agents.X.sandbox = { write, network, local_binding, unix_sockets }`，來源照 25.4.2。

doctor 列 requested/generated allowances，**不是完整 merged effective policy**（runtime/user settings 可能另行合併）。

沒有任何 agent 設 `sandbox` → 輸出完全不變。

## 25.11 Part 1 findings

來源：`docs/sandbox-blocks.md`（runtime-debugger Part 1 報告；本輪輸入 snapshot `sandbox-blocks-r1.md`）及 lead 綜合審查 d4023e8b。

- **(a) confirmed：OS sandbox network policy**。Claude 2.1.311 實際 wake 內 Unix pipe listen 與 TCP listen 均 EPERM；spawn 本身成功，socket 所在目錄可寫。TCP 對應 local_binding；Unix pipes 對應 unix_sockets，不能拿 write 代替。macOS profile 的 allowLocalBinding 產生 `(allow network-bind (local ip "*:*"))`、network-inbound local `*:*`、network-outbound remote `localhost:*`（IP only）。allowUnixSockets profile 產生 AF_UNIX creation 與所列 subpath 的 Unix bind/outbound。此為 profile 證據，非端到端成功證據。
- **tsx 修復仍 UNVERIFIED**：`unix_sockets: [<實際 TMPDIR>/tsx-<uid>]` 尚未端到端測試；[anthropics/claude-code#41817](https://github.com/anthropics/claude-code/issues/41817)（2.1.89）報告 scoped Unix sockets 只能 connect。需以目標版本重測，不承諾一定解決。`$TMPDIR` 不展開，填入方式見 25.4.1。Linux/WSL2 local_binding 無作用的來源：[Claude sandboxing](https://code.claude.com/docs/en/sandboxing)。
- **(b) Claude worktree mode 未被擋**：報告內 rm、restore、revert --no-commit/--abort 成功、清理後狀態乾淨；common git dir 被 Claude 自動加入是觀察結果，非已確認契約。不新增 allowance。Codex committing revert 與 legacy layout 仍未驗證，詳見診斷文件；不得用本設定放寬 git common dir。

## 25.12 逐模組改動（node-engineer）

| 檔案 | 改動 |
|---|---|
| `src/schema.ts` | `SandboxPartial`、`AgentPartial.sandbox` |
| `src/config.ts` | `ResolvedAgent.sandbox`、解析（25.4.2）、`AGENT_FIELDS`、`flattenResolved` 條件輸出 |
| `src/policy.ts` | `writePolicy` 在 `allowDirs` 尾端加 `agent.sandbox?.write ?? []`；`sandboxPathConflicts`；`RUNTIME_CONFIG_DIRS` |
| `src/validate.ts` | 呼叫 `sandboxPathConflicts`；`validateFallback` 的 capability tuple；doctor 額外行與 warn／info |
| `src/adapters/claude.ts` | 條件輸出 `sandbox.network` |
| `src/adapters/codex.ts` | 條件加 `-c sandbox_workspace_write.network_access=true` |
| `src/sandbox-invocation.ts`（新增小模組） | 共用 invocation preflight + record + 底層 invoke；純比較留 policy/validate |
| `src/run-session.ts`、`src/call.ts` | 所有 invoke 接共同入口，傳當次 concrete project/policy 與既有 log/say sink；檢查錯誤不可進 runtime fallback |

僅集中 invocation 入口所需的小幅接線，不做其他重構。

## 25.13 測試計畫（qa 驗證，node-engineer 撰寫）

所有測試用暫存 `AGENT_LYCEUM_HOME` 與 scratch repo；凡比較 enforcement 或輸出的測試都在 `beforeEach` 釘 `setOsSandboxForTest(true)`、`afterEach` 設回 `undefined`（`src/policy.ts:182`），無 OS sandbox 的案例釘 `false`。

| 檔案 | 案例 |
|---|---|
| `test/config.test.ts` | 未知鍵 `sandbox.net` → ConfigError 含 `agents.fe.sandbox.net`；`network: ["https://x.com"]`、`["*"]`、`["1.2.3.4"]`、`["x.com:443"]` → 含 `sandbox.network.0`；`write: ["rel/dir"]` → 含 `sandbox.write.0` 與 `absolute`；`~/a` 展開；`/a/../b/` → `/b`；project 的 `sandbox` 整個取代 team 的；全空 → `a.sandbox` undefined |
| `test/validate.test.ts` | `write` = home、home 內、`~`（包含 home）、`project.dir`、`<repo>/.git`、其他 agent 的自訂 memory、自訂 AGENT.md、`~/.claude`、`$CODEX_HOME` 各一錯誤；自己的 memory 子目錄也報錯（home 內 blanket ban；home 外仍屬 protected memory）；指向 home 的 symlink 被 canonical 抓到；不存在路徑 → info；fallback：Claude+network → Codex 備援錯誤、Codex → Claude 允許、無 network 允許、`setOsSandboxForTest(false)` 下允許 |
| `test/adapters.test.ts` | **沒設 `sandbox` 時 Claude settings JSON 與 Codex args 和改動前的固定值逐位元組相同**（寫死預期字串，不從程式碼產生）；`network` → `allowedDomains`；`local_binding` → `allowLocalBinding`；只有 `local_binding` 時 Codex args 沒有 `network_access`；`network` 時 `exec` 與 `exec resume` 兩條都有；`write` 出現在 `Edit` allow、`allowWrite`、`--add-dir`、`writable_roots`；override 喚醒不帶任何放寬 |
| `test/doctor.test.ts` | 網路行兩種 runtime 的文字；Codex 兩條 warn；`setOsSandboxForTest(false)` 的 info；`--resolved` 有／沒有 `sandbox` 鍵 |
| `test/fallback.test.ts` | `agentForCandidate` 帶上 `sandbox` |
| run 層（fake runtime fixture，沿用既有 run-session 測試檔） | 有放寬時每個 attempt 一筆 `sandbox` log、`applied` 隨 fallback runtime 變；沒放寬時 log 沒有 `sandbox` 事件；每次 invocation 重查：write/unix_sockets 指向 worktrees root 或 home 外 symlinked protected descendant、external git common dir → 不 spawn，錯誤含 `checked before invocation`；later lazy member wake/dynamic instance/resume/call 均覆蓋；fake invoker 同樣不能繞過 |

另加自動測試：兩類路徑的 metacharacters／控制字元、`$TMPDIR` 拒絕與 `~` 展開；unix_sockets Claude scoped output、Codex no-op warning；tuple 每一分量雙向 fallback（特別 Codex→Claude local_binding/unix_sockets 拒絕），保留既有 write parity；Linux local_binding off；兩個 no-OS runtime 訊息不同；call stderr 記錄、不改 stdout、preflight 失敗不啟動 fallback；symlink 在第一與第二次 wake 間更換；log sink 失敗不 spawn。

**qa 需要真實 runtime 的開放項**（由 runtime-debugger 在 sandbox 外或允許的環境驗證，結果回寫 25.3）：
1. Claude 2.1.311：`allowedDomains` 擋下名單外網域、`*.` 萬用字元是否有效、`allowLocalBinding` 讓 `node -e "require('net').createServer().listen(0)"` 成功。
2. Codex 0.163.0：`-c sandbox_workspace_write.network_access=true` 讓 `curl` 成功；不設時 bind 是否失敗；設了之後 bind 是否成功。
3. Codex 對不存在的 `writable_roots` 是否報錯。
4. Claude 目標版本 scoped Unix socket bind+connect 與完整 tsx CLI tests；Linux unix_sockets 行為。若失敗保留 UNVERIFIED/版本限制，禁止改用 allowAllUnixSockets。

## 25.14 文件計畫（docs-writer）

- `docs/configuration.md`：Agent fields（`:31`）加 `sandbox`；新小節「Sandbox allowances」含範例、預設、受保護路徑規則、Codex 限制、local_binding 真正 IP scope、Unix connect 風險、Linux 無效、TMPDIR 不展開與端到端未驗證；fallback 規則（`:99`）加三分量 capability 規則。
- `docs/write-scope.md` + `docs/write-scope.zh-TW.md`：一節說明 `write` 如何擴大可寫範圍、哪些路徑永遠不行、無 OS sandbox 時的意義；兩檔標題一致。
- `docs/specs/README.md`：索引加 25。
- README 不改（非破壞性新增）；`npm run check:docs`。

## 25.15 Dimension coverage

1. **相容與格式**：新增可選欄位；舊 `project.yaml`／`team.yaml` 照常載入；沒設 = 輸出逐位元組相同（25.13 adapters 測試鎖住）。不碰 `state.json`、run 目錄格式、`status --json`。舊 binary 讀到含 `sandbox` 的新設定 → `AgentPartial` 是 `.strict()`（`src/schema.ts:57-73`），會以 `agents.X.sandbox: Unrecognized key` 載入失敗：fail closed、指名鍵，可接受；docs 註明需要的版本。新 log 事件 `sandbox`：讀 log 的程式（`status`）忽略未知事件（未驗證，node-engineer 確認）。
2. **檔案與行程安全**：25.4.3、25.6；全部是 OS 層（有 sandbox 時）或 Edit 工具規則；受保護路徑以 canonical 比對；無 shell 拼接。
3. **並發與復原**：設定由既有載入流程讀，每次 invocation 重驗具體路徑，沒有新狀態 store、沒有新鎖；事件沿用 log/stderr。crash 中斷現有 log append、Ctrl-C/timeout/奇異 runtime exit 均走既有處理，不增加重放或重試；preflight fail closed 不能成為 fallback 觸發器。partial mail 與 stale lock 規則不變；並行 run 各自產生自己的 settings 檔。`resume` 的每個 invocation 重跑檢查，使用者在兩次之間改了設定會被重新驗證。
4. **平台與可維運**：macOS Seatbelt、Linux bwrap 走既有機制；Windows／無 bwrap 見 25.7。Claude 與 Codex 差異寫在 doctor 文字裡。只在有 sandbox 的 invocation 做 O(entries × protected roots) 比較與有界 realpath/git 探測；不在 idle polling 做 I/O。無新依賴。
5. **可測試與可維護**：`sandboxPathConflicts`、capability tuple 是純函式；adapter 輸出可 snapshot；全部用 fake runtime 與 `setOsSandboxForTest`，不需要真實 `claude`／`codex`／`~/agent-lyceum-config`。
6. **可觀測與可診斷**：錯誤指名 agent、鍵、索引、衝突的受保護路徑與關係；`doctor` 列出每個放寬與 runtime 實際效果；`log.jsonl` 的 `sandbox` 事件記錄每次喚醒實際套用的內容。
7. **最小權限（新增）**：`local_binding` 在 Codex 不偷偷升級成全網路；override 喚醒不帶放寬；`write` 不能用來寫 repo 本身。

## 25.16 不採用的方案

- **R-01 `write` 接受相對路徑（相對於設定檔）**：team.yaml 與 project.yaml 的基準不同，同一行在兩處意義不同；拒絕更清楚。
- **R-02 team 與 project 的 `sandbox` 逐鍵合併或取聯集**：只能放大、不能收窄；`pick` 整個取代與其他欄位一致。
- **R-03 Codex 上 `local_binding: true` 就開 `network_access`**：使用者只要 bind，卻得到整個網路；寧可不支援並警告。
- **R-04 使用 Codex binary 裡的 `allowed_domains`**：來源與設定位置都不明，0.163.0 的行為未驗證；等 runtime-debugger 確認再另議。
- **R-05 另列一份受保護路徑常數清單**：會與 `writePolicy` 的 deny 漂移；改以 `project.home`、`project.dir` 這兩個根加上既有函式回傳值為準，只新增 runtime 設定目錄兩項。
- **R-06 只在 run 開始重查 symlink**：漏掉 call、lazy workspace 與後續 wake；改成單一 invocation 邊界。
- **R-07 把放寬寫進 prompt**：放寬不需要自律；新 prompt 文字對 resume 中的 Claude session 不一定生效；改動所有 prompt 的位元組。
- **R-08 允許 lead 有額外的放寬（例如可寫 home）**：lead 已能寫它需要的共享檔；任何 lead 專屬路徑都是以角色判斷的新程式，與「只有 dispatcher 代 lead 做 sandbox 外的事」原則相違。

- **R-09 allowAllUnixSockets**：可連 Docker/ssh-agent 等非指定 sockets，超出需求；僅 scoped paths。
- **R-10 把 Unix sockets 併入 local_binding**：macOS profile 為不同 address families，且 Linux local_binding 無效果；必須分開。

## 25.17 分工

- **node-engineer**：25.12 全部（審查：cli-reviewer）。
- **qa**：25.13 的自動測試驗證；開放項 1-3 交 runtime-debugger（審查：qa-reviewer、runtime-debugger-reviewer）。
- **docs-writer**：25.14（審查：docs-reviewer）。
- **lead**：安排第二輪設計審查；25.11 已依提供的 Part 1 結論填入。

## 25.18 風險與未驗證

1. Claude `allowedDomains` 的萬用字元語法與 Unix sockets/tsx 端到端效果未驗證（25.13 開放項 1）。
2. Seatbelt／bwrap 對 `allowWrite` 裡 symlink 的處理未驗證；本 spec 輸出 canonical 路徑以避開。
3. Codex `network_access` 是全有全無；使用者可能誤以為是逐網域，靠 doctor 警告與 fallback 拒絕緩解。
4. 舊 binary 讀到新設定會載入失敗（fail closed，訊息指名鍵）。
5. `--settings` 與使用者 `~/.claude/settings.json` 的 sandbox 鍵合併規則未驗證：使用者層若已有 `allowedDomains`，實際可達範圍可能是兩者之聯集（未驗證），doctor 列出 requested/generated allowances，不是完整 merged effective policy；適用所有 sandbox 欄位。

## 25.19 Lead 決議（設計審查第二輪後）

第二輪設計審查（9b5cd00b）留下一個 major，已達審查上限，由 lead 決定：

1. **前置檢查失敗不可進 retry／fallback（M1）**。目前兩個呼叫點（`src/run-session.ts:731-742`、`src/call.ts:~197`）會把丟出的錯誤 `.catch` 成一般失敗，`nextStep`（`src/fallback.ts:104-120`）再拿它 retry。決議：`AttemptResult` 加一個終止型 `kind: "config"`，`nextStep` 在檢查 `legacy` 之前就把它對應到 `stop`。前置檢查的包裝器在拒絕時**回傳**這個結果，不丟例外，所以不會 spawn、不 backoff、不換 backup。run：這次 wake 以具名錯誤結束，寫 `sandbox-refused` log 事件（欄位 `agent`、`runtime`、`reason`、`path`），寄給 lead 的 failure 信要寫出原因。`call`：非零 exit，stderr 印出同一個原因。測試：在 run、resume、call 三條路徑上，被拒的前置檢查都只檢查一次、spawn 零次、沒有 backoff、也沒有換 backup。`state.rounds` 是否已遞增照目前程式碼的順序，但要在測試裡寫明。
2. **m1**：`src/memory-tidy.ts:378` 傳入明確的 `policy` override，allowances 不會套用，所以不需要前置檢查；在 25.4.3／25.5 註明「override 呼叫點不需前置檢查」。
3. **m2**：動態實例 `<role>--<k>` 的 `ResolvedAgent` 如何繼承 role 的 `sandbox`：node-engineer 確認並加測試（未驗證）。
4. **m3**：agent 自己的 `ws.root`／`ws.gitDir` 在受保護集合裡，但本來就可寫；錯誤訊息要說「已在 agent 自身寫入範圍內，不需列入」，不要說成「受保護、agent 不可寫」。
