# 24 模型分級（`model` 是上限，lead 依任務選 tier）

狀態：**草稿修訂 1，待第 2 輪審查**（cli-architect-reviewer）。輸入：lead 任務 495e9355（使用者決策 bd3cfc 的三條定案）；修訂 1 依審查 2ba16ab4 與 lead 決定 1dd8aca7。

修訂 1 摘要：降級模型改用自己的 session key、永不跨模型續接（D-08、24.6，原「換模型續接」的未驗證風險因此不存在）；候選清單只建一次再交給 `planAttempts`（24.7.1）；重複信判定納入有效 tier（D-15、24.5.4）；降級候選不算備援、從降級換到上限記為 tier step-up（24.7.3）；README 加降級（舊版）說明（24.16）。

所有 `檔案:行號` 都在目前 HEAD（`fbffc40`）重新開檔確認過。模型分級尚不存在，凡是「新程式會怎樣」都是設計；凡是真實 `claude`／`codex` 的行為（換模型續接 session、prompt cache）都標「未驗證」。本 spec 寫作時 `claude --help`、`codex exec resume --help` 在 agent sandbox 內沒有輸出，所以沒有任何 runtime 行為是實測過的。

## 24.1 目標與限制

**目標**：agent 設定的 `model` 變成**上限**（ceiling）。lead 派工時在 `task` 上標難度 `tier`，dispatcher 依該 agent 所屬 runtime 的模型階梯（ladder）挑對應的模型喚醒它，絕不超過上限。省的是成員簡單任務的花費。

**使用者定案（不重新辯論）**：
1. 難度由 lead 派工時決定（`task` 上的 `tier`），不自動判斷。
2. 階梯按 runtime 分：`claude-code` 一條、`codex` 一條；agent 只在自己 runtime 的階梯上移動。「reviewer 與被審者在不同 runtime」的規則不受影響。
3. agent 的 `model` 是上限；沒給 `tier` 或沒設階梯 → 用上限，與今天完全相同。

**非目標**：自動判斷難度；跨 runtime 的分級（低 tier 換到另一個 runtime）；每個 tier 各自的 `effort`（24.7 D-09）；lead 自己的分級（lead 只收 reply，24.4）；fallback 鏈項目的分級（備援仍用它自己設定的模型）；每個 agent 自己的階梯（延後，24.15）。

## 24.2 決議總表

| # | 決議 | 理由（詳見各節） |
|---|---|---|
| D-01 | 設定鍵是頂層 `model_tiers`，`team.yaml` 與 `project.yaml` 都可寫；同一 runtime 以 project 整條取代 team，`[]` 表示這個專案關掉該 runtime 的階梯 | 階梯有順序，合併沒有意義；`[]` 沿用 `fallback: []` 的「空也是值」慣例（`src/config.ts:204`） |
| D-02 | 可用 tier = 階梯從最低到 `model`（含）的前綴；`model` 不在階梯上是錯誤；agent 沒寫 `model` 時階梯不適用（警告） | 上限必須在階梯上才知道「比它低」是什麼 |
| D-03 | `low` = 最低、`high` = 上限、`mid` = 第 `floor(n/2)` 項（偶數取偏高的中間） | 降錯一級的代價是整個重做（一次喚醒），升錯一級只是單價差 |
| D-04 | `tier` 是 frontmatter 欄位，只在 **lead 寄出的 `task`** 上有效（新 thread 或後續 task 都可） | 使用者定案 1；沿用 `parallel` 的「只認 outbox 擁有者」（`src/instances.ts:65-74`） |
| D-05 | lead 寫錯值 → 退回（format 通知）；非 lead、非 task、收件者沒有可降的 tier → 照常投遞、忽略、log＋一次 note | 與 `parallel` 的 invalid／ignored 分法相同（`src/mailbox.ts:400-410`、`src/run-session.ts:423-431`） |
| D-06 | 驗證過的 tier 由 dispatcher 寫進投遞後信件的 frontmatter `tier`；**作用範圍是處理那封信的那次喚醒**（含其 retry 與 resume 重做），不延續到 thread | 信件檔本來就隨 resume 留在 inbox；最壞情況是被改成上限＝今天的行為 |
| D-07 | 一次喚醒處理多封信時：每封都有有效 tier 才降級，取最高；任一封沒有 → 上限 | task 從不批次（`src/prompt.ts:42`、`:271-283`），實際上只有一封；取最高是安全方向 |
| D-08 | 降級（非上限）模型用**自己的 session key** `<agent>@<runtime>/<model>`，與備援同形（`src/run-session.ts:47`）；上限仍用 agent 名稱。**永不跨模型續接** | 跨模型續接在真實 runtime 未驗證，被拒時沒有安全的復原（24.6）；代價只落在 `resume: true` 的成員，成員預設 `resume: false`（`src/config.ts:241`），lead 不分級 |
| D-09 | `effort` 不變，沿用 agent 設定 | 每 tier 的 effort 要多一層設定；先量測再說 |
| D-10 | 候選順序：降級模型 → 上限（原 primary）→ fallback 鏈；清單**只建一次**（含降級模型）再交給 `planAttempts`；冷卻鍵仍是 `<runtime>/<model>` | 降級模型失敗時往上走、不超過上限；冷卻按模型分本來就對；兩處各建一次清單正是審查找到的遺失 tier 的原因（24.7.1） |
| D-15 | 降級候選**不是備援**：`Candidate.tiered` 標記；`fallback_from` 只在跑鏈上項目時寫；降級 → 上限記 `tier_step_up` | 否則降級的第一次嘗試會被記成「從自己備援」（24.7.3） |
| D-16 | 重複信判定加入**有效 tier**（沒寫 ≡ `high`） | 否則 lead 把同一 task 從 `low` 改 `high` 重寄會被當重複退回，且通知 2 次後靜默（24.5.4） |
| D-11 | 動態實例（spec 23）自動適用：`synthesizeSlots` 以 `...a` 複製 agent（`src/instances.ts:291-297`），tier 跟著信件檔移動 | 不需要額外程式 |
| D-12 | lead 系統提示只在「至少一個成員有 ≥2 個可用 tier」時附加固定段落 `## Task tiers` | 沒有階梯時提示逐位元相同（同 spec 23 D-13 的作法） |
| D-13 | 紀錄：`state.wakes[]`、`last_wake`、`log.jsonl` 的 `wake` 事件在降級喚醒時加 `runtime`／`model`／`tier`；`tier_ignored`、`tier_step_up` log 事件；`status --json` 只增不改 | 硬限制：status-monitor 依賴 `status --json` |
| D-14 | 不升 state `schema_version`、不升 mail 格式 | 新欄位都是選填；`wakes` 以 `z.any()` 讀（`src/run-store.ts:213`）；`readMessage` 把 frontmatter 原樣轉成 meta（`src/mailbox.ts:173-177`），舊版沒有程式讀 `tier`，等於忽略 |

## 24.3 設定

### 24.3.1 YAML

```yaml
# ~/agent-lyceum-config/team.yaml（全域）或 projects/<name>/project.yaml
model_tiers:
  claude-code: [claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5]   # 低 → 高
  codex: [gpt-6.1-mini, gpt-6.1-sol]

agents:
  node-engineer: { model: claude-opus-5-5 }      # 可用：haiku, sonnet, opus
  docs-writer:   { model: claude-sonnet-5-5 }    # 可用：haiku, sonnet（上限 sonnet）
  cli-reviewer:  { model: gpt-6.1-sol }          # 可用：gpt-6.1-mini, gpt-6.1-sol
```

`project.yaml` 想關掉全域的 codex 階梯：`model_tiers: { codex: [] }`。

### 24.3.2 zod（`src/schema.ts`）

```ts
/** One runtime's model ladder, lowest first; `[]` = no ladder for that runtime (overrides team.yaml). */
export const ModelTiersPartial = z
  .object({
    "claude-code": z.array(z.string().trim().min(1)).optional(),
    codex: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

export const TIERS = ["low", "mid", "high"] as const;
export type Tier = (typeof TIERS)[number];
```

`GlobalConfig`（`src/schema.ts:97-101`）與 `ProjectConfig`（`src/schema.ts:103-110`）各加 `model_tiers: ModelTiersPartial.optional()`。兩者都是 `.strict()`，所以**舊版程式讀到含 `model_tiers` 的檔會拒絕載入**，錯誤由 `readYaml` 產生（`src/config.ts:92-96`），形如 `Global config is invalid (...): - (root): Unrecognized key(s) ...`（zod 的確切字句未實測）。這是使用者自己寫的設定，失敗是大聲的，可接受（與 spec 23 加 `max_instances` 時相同）。

### 24.3.3 解析（`src/config.ts`）

- `ResolvedProject` 加 `modelTiers: Partial<Record<Runtime, string[]>>`，只放非空階梯。合併：`project.model_tiers[rt] !== undefined ? project 的 : team 的`（整條取代；`[]` 也是值）。
- `ResolvedAgent` 加選填 `tiers?: string[]`：該 agent 的**可用 tier 列表**（階梯前綴，到 `model` 為止，保留階梯裡的寫法）。只在下列全部成立時設定：agent 有 runtime、有 `model`、該 runtime 有非空階梯、`model` 在階梯上（比對用 trim＋lowercase，與 `keyOf` 相同，`src/fallback.ts:16`）、前綴長度 ≥ 2。長度 1（上限就是最低項）不設定，因為沒有可降的。
- `sources` 加 `model_tiers.<runtime>`：`{ file, key: "model_tiers.<runtime>" }`（project 或 team 檔）；不設預設來源，沒有階梯時完全不出現。

### 24.3.4 驗證（`src/validate.ts`，加在 `validateProject` 的 agent 迴圈前後）

錯誤（`err`）：

| 情況 | 訊息 |
|---|---|
| 階梯項目推不出 runtime 或推出別的 runtime（`inferRuntime`，`src/schema.ts:17-23`） | `` model_tiers.<rt>[<i>]: "<m>" is not a <rt> model (recognised as <other\|nothing>). List only <rt> models, lowest first. `` |
| 同一階梯重複（trim＋lowercase） | `` model_tiers.<rt>: "<m>" is listed twice. `` |
| agent 的 runtime 有非空階梯，`model` 不在上面 | `` Agent "<a>": model "<m>" is not on model_tiers.<rt> (<list>). Add it to the ladder, or set model_tiers.<rt>: [] in project.yaml to turn the ladder off for this project. `` |

警告（`warn`）：

| 情況 | 訊息 |
|---|---|
| agent 的 runtime 有階梯但 agent 沒寫 `model` | `` Agent "<a>" has no model, so model_tiers.<rt> does not apply to it: it always runs on its runtime's default model. `` |
| 有階梯但沒有任何非 lead 成員有 ≥2 個可用 tier | `` model_tiers is set, but no member can run below its model (each member's model is the lowest entry of its ladder): tiers have no effect. `` |

不需要新的「備援不能比 primary 弱」檢查：降級模型與上限同 runtime，`enforcementFor` 不看 model（`src/policy.ts` 裡沒有 `model`；`grep -n model src/policy.ts` 無輸出），而既有的檢查（`src/validate.ts:111-119`）只比 runtime 造成的強制等級。

## 24.4 tier → 模型對應

可用列表 `A`（長度 `n`，`A[n-1]` = 上限）：`low = A[0]`、`mid = A[floor(n/2)]`、`high = A[n-1]`。

| 階梯長度 | 上限位置 | n | low | mid | high |
|---|---|---|---|---|---|
| 1 | L0 | 1 | L0 | L0 | L0（不設 `tiers`，等同沒有階梯） |
| 2 | L0 | 1 | L0 | L0 | L0 |
| 2 | L1 | 2 | L0 | L1 | L1 |
| 3 | L0 | 1 | L0 | L0 | L0 |
| 3 | L1 | 2 | L0 | L1 | L1 |
| 3 | L2 | 3 | L0 | L1 | L2 |
| 4 | L0 | 1 | L0 | L0 | L0 |
| 4 | L1 | 2 | L0 | L1 | L1 |
| 4 | L2 | 3 | L0 | L1 | L2 |
| 4 | L3 | 4 | L0 | L2 | L3 |

上限以上的項目永遠不用。n=2 時 `mid` 等於上限；n=4 時 `mid` 取偏高的 L2（D-03）。

純函式（新模組 `src/tiers.ts`）：

```ts
export function availableTiers(ladder: readonly string[] | undefined, model: string | undefined): string[] | undefined;
export function modelForTier(tiers: readonly string[], tier: Tier): string; // tiers = ResolvedAgent.tiers
```

## 24.5 `tier` 欄位

### 24.5.1 語法

lead 的 outbox 信件 frontmatter：`tier: low`、`tier: mid` 或 `tier: high`（YAML 字串，小寫）。可與 `parallel: true` 並用。

### 24.5.2 判定（`src/tiers.ts` 的 `tierFlag`，仿 `parallelFlag`，`src/instances.ts:65-74`）

```ts
export type TierFlag = "absent" | "invalid" | Tier | { ignored: "not-lead" | "not-a-task" | "no-tiers" };
export function tierFlag(i: { value: unknown; senderIsLead: boolean; type: string; recipientTiers?: string[] }): TierFlag;
```

依序：

| 條件 | 結果 | 動作 |
|---|---|---|
| 沒有 `tier`（`undefined`／`null`／`""`） | `absent` | 照常投遞，上限 |
| 寄件人不是 lead（以 outbox 擁有者判定，不看 `from`） | `ignored: not-lead` | 照常投遞，信件**不帶** `tier`；log＋note |
| 值不是 `low`/`mid`/`high` 之一（含大寫、數字、布林） | `invalid` | 只有 lead 會到這步：整封退回，訊息見下 |
| `type` 不是 `task`（`reply`、`done` 等） | `ignored: not-a-task` | 照常投遞，不帶 `tier`；log＋note |
| 收件者沒有 `tiers`（無階梯、上限是最低項、沒 `model`） | `ignored: no-tiers` | 照常投遞，不帶 `tier`；只 log（lead 提示已列出誰能降級，不另發 note） |
| 其他 | 該 tier | 投遞時信件 frontmatter 寫 `tier: <值>` |

`done` 走另一條路徑（`src/mailbox.ts:356-372`），不會看 `tier`；`not-a-task` 實際上只出現在 `reply`。多個收件者時逐一判定（同 `parallel` 的 `flags` map，`src/mailbox.ts:400-406`）。`tierFlag` 在 `parallel` 判定的同一處計算（`src/mailbox.ts:400-410`），也就是在缺段落檢查（`:413-423`）與重複信檢查（`:427-432`）**之前**：invalid 先退回，重複信檢查要用到結果（24.5.4）。

退回訊息（經 `reject`，與 `parallel` 的 invalid 同路徑）：

```
tier must be low, mid or high, not <JSON 值>. Write `tier: low` (or mid/high) on a task to run it on a cheaper model, or leave the line out to use the member's own model.
```

note（每個寄件人＋原因一次，同 `src/run-session.ts:425-427` 的去重）：
- not-lead：`` <from>'s mail <id> has `tier`, but only the lead (<lead>) can choose a member's tier: it was delivered without one. ``
- not-a-task：`` <from>'s mail <id> ("<subject>") has `tier` but is a <type>: tiers apply to tasks only, so it was delivered without one. ``

log 事件：`{ "event": "tier_ignored", "from", "id", "to", "reason" }`。

### 24.5.3 寫到哪裡、作用多久（D-06、D-07）

- `DeliverInput`（`src/mailbox.ts:79-87`）加選填 `tier?: Tier`；`deliver` 與 `deliveredMeta` 只在有值時寫 `tier`。`MessageMeta`（`src/mailbox.ts:21-32`）加選填 `tier?: Tier`。沒 tier 的信件序列化結果與今天逐位元相同。
- 重播：`deliverOnce` 會把要寫的內容與既有檔比對（`src/mailbox.ts:134-140`）；`tier` 來自同一個 outbox 檔，重播時值相同，內容一致（前提：重播前收件者的 ladder 設定未變。若重啟前把 ladder 拿掉，重算的 `tierFlag` 不再帶 `tier`，`deliverOnce` 以新內容覆寫，該信改用上限，這是可接受的結果；審查 M-2）。
- 為什麼不像 `parallel` 只記在 journal：`parallel` 決定實例路由，必須不能被 agent 改；`tier` 被改的最壞結果是用到上限（＝今天的行為），且沒有 journal 的專案層 mailbox（`journal` 為 `undefined`，`src/mailbox.ts:114`）也要能用。
- 喚醒時：`wake()` 取 `unread`（`src/run-session.ts:616`）後算 `wakeTier(unread.map(m => m.meta.tier))`：每封都是有效 tier → 取最高；否則 `undefined`（上限）。讀信件時再驗一次值（不是 `TIERS` 之一就當沒有），並確認 agent 有 `tiers`（設定在 run 中途被改掉的情況）。
- 作用範圍：只有這次喚醒（含 in-wake retry 與 resume 後的重做，因為信件仍在 inbox 未讀）。同 thread 之後的 `reply`／`failure` 用上限。**被接受的代價**：dispatcher 給成員的 failure（例如格式退回）會在上限上處理。不採用 thread 範圍：需要在 state 存 thread→tier 表，且 lead 本來就每封後續 task 重新標（24.10 提示這樣寫）。

### 24.5.4 重複信判定納入 tier（D-16）

**現況**：`earlierDuplicate`（`src/mailbox.ts:263-283`）只比寄件人、收件者、`type`、`reply_to` 與正規化後的內文（`sameText`，`:255-257`）。lead 把同一封 task 從 `tier: low` 改成 `tier: high` 重寄，內文相同 → 被當重複退回（`:446-448`），而同一個重複的通知 2 次後靜默（`MAX_DUPLICATE_NOTICES`，`src/duplicate-notices.ts:6`、`:25-33`）。這正是「降級做不好、改用上限重派」最需要的動作。

**決定**：重複的條件多一項「**有效 tier** 相同」。

- 新信對收件者 `t` 的有效 tier：`tierFlag` 結果是 `Tier` → 該值；其他（`absent`、各種 `ignored`）→ `high`。也就是「投遞後檔案裡會寫的 `tier`，沒寫就是 `high`」。
- 既有信件的有效 tier：`isTier(m.meta.tier) ? m.meta.tier : "high"`（值不合法也當 `high`，與 24.5.3 讀信時的規則相同）。
- `earlierDuplicate` 加參數 `tier: Tier`（呼叫處傳上述有效值），比對條件加 `effectiveTier(m.meta) === tier`。
- 規則對所有寄件人一致，但只有 lead 的 task 能讓結果不同：非 lead 寄的信與 `reply` 投遞時都不帶 `tier`（24.5.2），兩邊都是 `high`，判定與今天相同。
- 沒寫 ≡ `high`：lead 先寄沒寫 tier、再寄 `tier: high` 的同一封 → 仍是重複（兩者都是上限，重寄不改變任何事）。
- 完全相同的重寄（同內文、同有效 tier）仍是重複；通知上限、`duplicateNoticeKey`（以收件者＋既有信件 id 為 key，`src/duplicate-notices.ts:10-12`）、每個 outbox 來源只算一次（`:28`）都不變，所以崩潰重播不會重複計數。
- 保留佇列（spec 23）：`held` 時掃描所有實例 inbox、其 `read/` 與 `pending/`（`src/mailbox.ts:268-269`）；這些檔案的 frontmatter 都帶著投遞時寫入的 `tier`（`rename` 不改內容，24.8），比對規則相同。
- 舊版程式不比 tier：在舊版上「只改 tier 重寄」仍被當重複（24.13 R-4）。

## 24.6 Session key（D-08）

**確認現況**：primary 的 key 就是 agent 名稱，只有非 primary 候選用 `<agent>@<runtime>/<model>`（`src/run-session.ts:47`：`c.primary ? agent.name : \`${agent.name}@${c.key}\``；`Candidate.key` 是 `<runtime>/<model>`，`src/fallback.ts:11-16`）。

**決定**：降級模型用自己的 key `<agent>@<runtime>/<model>`；上限仍用 `agent.name`。降級候選是 `primary: false`（24.7），所以 `sessionKeyOf` **一行都不用改**，現有的非 primary 分支就產生這個 key。結果：在 agent 設定不變的前提下，**tier 造成的換模型永遠不會跨模型續接**；每個 session 只以建立它的模型續接。（範圍限定：若使用者在續跑前改了 agent 的上限 `model` 或 runtime，上限 session 仍用 `agent.name` key 續接，這是今天就有的行為，本 spec 不處理；審查 M-3。）

- 為什麼不共用一個 key：兩個 adapter 續接時都把模型傳下去（Claude `--resume` 加 `--model`，`src/adapters/claude.ts:79-81`；Codex `exec resume <id> ... -m <model>`，`src/adapters/codex.ts:72-77`），但真實 CLI 是否接受「續接 X、改用模型 Y」**未驗證**（sandbox 內 `--help` 無輸出）。若被拒，錯誤多半分類為 `unknown`；`nextStep("unknown", 2, 1, true, false)` 回 `stop`（`src/fallback.ts:107-111`，審查者實測），喚醒失敗、信件留在未讀（`src/run-session.ts:778-779`），resume 只會重複同一次呼叫。安全的做法需要新的復原路徑（偵測拒絕後改開新 session），而拒絕的錯誤字樣無法在 sandbox 驗證。按模型分 key 讓這個問題不存在。
- 代價（被接受）：`resume: true` 的成員換 tier 時看不到另一個模型的對話歷史；每個模型各自累積。例：上限喚醒建 `S1`（key `node-engineer`）→ `tier: low` 喚醒建 `S2`（key `node-engineer@claude-code/claude-haiku-5-5`）→ 再以上限喚醒續接 `S1`，看不到 `S2` 做過的事（只看得到信件與 repo）。成員預設 `resume: false`（`src/config.ts:241`，`resume ?? isLead`），預設設定下每次都是新 session，沒有代價；lead 不分級（24.1 非目標），lead 的 session 不受影響。
- 與 fallback 鏈共用 key：若某個降級模型也出現在 fallback 鏈上（同 runtime、同 model，`keyOf` 相同，`src/fallback.ts:16`），兩者用同一個 key、同一個 session。這是**有意的**：同一個 runtime 上的同一個模型，續接自己的 session 沒有跨模型問題；而且 `candidatesFor` 的 `seen` 去重本來就讓它在同一次喚醒的候選裡只出現一次（24.7）。
- 從降級換到上限（24.7.3）時，上限續接的是自己的 `agent.name` session（若有），`onSwitch` 的 `resumes` 依 `sessionKeyOf(agent, to)` 計算（`src/run-session.ts:661`），文字正確。
- prompt cache：換 tier 本來就換模型，快取不共用（是否按模型分開對 Claude **未驗證**）；按模型分 session 不增加這個成本。

## 24.7 Fallback 與冷卻（D-09、D-10、D-15）

### 24.7.1 候選清單只建一次

`candidatesFor`（`src/fallback.ts:22-35`）加第二個參數：

```ts
export function candidatesFor(agent: ResolvedAgent, tierModel?: string): Candidate[];
```

`Candidate` 加 `tiered?: true`。`tierModel` 有值且 key 不等於上限的 key 時，在最前面插入 `{ runtime, model: tierModel, effort: agent.effort, primary: false, tiered: true, key }`，後面接原本的 primary（上限）與鏈；既有的 `seen` 去重會把鏈裡等於降級模型的項目拿掉。`tierModel` 等於上限（`high`、或對應到上限）或未給時，結果與今天完全相同。

**現況的缺口**（審查 finding 2）：`wake()` 先 `all = candidatesFor(agent)`（`src/run-session.ts:632`），再呼叫 `planAttempts(agent, cooldowns, now)`（`:634`），而 `planAttempts` 內部又 `candidatesFor(agent)` 重建一次（`src/fallback.ts:83-86`）。只在第一處加 tier，第二處會把它丟掉。

**決定**：`planAttempts` 改收**候選清單**，不再收 agent：

```ts
export function planAttempts(all: readonly Candidate[], cooldowns: Cooldowns, now: number): Candidate[];
// body: const warm = all.filter((c) => cooldowns.active(c.key, now) === 0); return warm.length ? [...warm] : [...all];
```

`wake()` 只建一次：`all = candidatesFor(agent, tierModel)`，`candidates = chain ? planAttempts(all, cooldowns, now) : all`。去重與順序由 `candidatesFor` 決定，`planAttempts` 只過濾；全部冷卻中時照舊回整條（「總要試一個」），此時從降級模型開始。選清單而不是加 `tierModel` 參數：清單只有一個來源，之後不會再出現兩處建清單不一致；代價是 `test/fallback.test.ts:162,163,168,188` 四處呼叫改成傳 `candidatesFor(...)`，行為不變。其他呼叫者：`src/call.ts:168` 只用 `candidatesFor`（不分級，不變）；`src/status.ts:407` 與保留佇列（`src/run-session.ts:516`、`:571`）呼叫 `candidatesFor(x)` 不帶 tier，結果與今天相同。

### 24.7.2 順序與重試

- 順序：降級模型 → 上限 → fallback 鏈。降級模型 `rate_limit`／`quota` → 冷卻並換到上限；`timeout`／`network`／`crash` → 重試 `retry` 次再換；`auth`、`unknown` → 依 `nextStep` 停（`src/fallback.ts:100-117`），不往上走（與今天對 primary 的處理相同；因為不跨模型續接，`unknown` 不會來自 session 被拒）。
- 有降級候選時 `chain = all.length > 1` 為真（`src/run-session.ts:633`），所以這次喚醒走非 legacy 迴圈：重試有退避、會記冷卻，`state.wakes` 與 `last_wake` 自動帶 `runtime`／`model`（`:708`、`:722`）。沒有降級（上限）的喚醒照舊。
- 冷卻鍵仍是 `<runtime>/<model>`：降級模型冷卻中時 `planAttempts` 跳過它，直接從上限開始。
- 保留佇列的冷卻判斷（`src/run-session.ts:516`、`:571`）仍看 `candidatesFor(roleAgent)[0]`（不帶 tier ＝上限），不變：上限沒冷卻就有東西可跑。
- `sessionKeyOf`（`src/run-session.ts:47`）不改（24.6）。
- `agentForCandidate`（`src/fallback.ts:43-47`）：加 `tiered` 分支 → `{ ...agent, model: c.model }`（runtime、effort、`allowWeb` 都不變；不走備援分支，因為那一支會把 `allowWeb` 改寫成顯式的 `undefined` 鍵）。
- `effort` 不變（D-09）。不採用每 tier 的 effort：上限是 opus+`high` 的 agent 降到 haiku 仍用 `high` 是否合理需要量測；先不加設定。

### 24.7.3 降級不是備援（D-15）

**現況的缺口**（審查 finding 4）：`replaced` 初值是「`candidates[0]` 不是 primary 就取 `all[0]`」（`src/run-session.ts:636`），紀錄的 `fallback_from` 是「非 primary 且有 `replaced`」（`:708`），`status` 看到最後一次喚醒有 `fallback_from` 就報告備援（`src/status.ts:395-405`）。降級候選是 `primary: false`，第一次嘗試就會被記成「從自己（`all[0]`）備援」。

**決定**：`fallback_from` 與 `replaced` 只跟**鏈上項目**（`!primary && !tiered`）有關；從降級往上走記為 tier step-up。

- `ceiling = all.find((c) => c.primary)`（一定存在）。
- `replaced` 初值：`candidates[0].primary || candidates[0].tiered ? undefined : ceiling`（今天沒有降級時 `all[0]` 就是 ceiling，結果相同）。
- `onSwitch(from, to)`：`from.tiered` 時**不**設 `replaced`；否則照舊 `replaced = from`。
- 紀錄：`fallback_from: c.primary || c.tiered ? undefined : modelLabel(replaced ?? ceiling)`。降級與上限都冷卻、直接從鏈開始時，`fallback_from` 是上限（鏈項目替代的是上限，不是降級模型）。
- step-up 的輸出：
  - `onSwitch` 在 `from.tiered` 時：終端 `` `  <a> stepping up from tier <tier> (<from label>) to <to label> (<kind>)` ``；note `` <a>'s tier <tier> model <from label> failed (<kind>); it is woken again on <to label>, which <resumes its own earlier session|starts a fresh session>, and redoes this wake-up. Anything the failed attempts already did outside the mailbox (file edits, commands) was not undone: side effects may have happened. ``；log `{ "event": "tier_step_up", "agent", "tier", "from", "to", "reason": <kind> }`。
  - 開始時降級模型在冷卻（`all[0].tiered && !candidates[0].tiered`）：終端 `` `  <a> tier <tier> model <label> is cooling down (<kind>, <n>s left): starting on <candidates[0] label>` ``；log `tier_step_up`，`reason: "cooldown"`。不發 note（沒有失敗的嘗試，不必提醒副作用）。
  - 喚醒行（`src/run-session.ts:681`）在降級喚醒時加 tier：`waking <a> (<runtime>/<model>, tier <tier>)`。
- `status`：不擴充 `fallbackView`。理由：它只對有鏈的 agent 輸出（`src/status.ts:388`），加入 tier 冷卻會讓沒有鏈的 agent 也多出 `cooldowns` 欄位；而降級模型冷卻只會讓喚醒改用上限，不會卡住工作，不需要操作者處理。冷卻仍完整保存在 `state.cooldowns`，並由上面的終端行與 `tier_step_up` log 呈現。`status --json` 因此不變（只有 `wakes` 多出選填欄位，24.9）。

## 24.8 動態實例（spec 23）

- `synthesizeSlots` 用 `...a` 建實例（`src/instances.ts:287-297`），`tiers` 一起複製；實例與角色同模型、同階梯。
- 保留佇列：`deliverOnce` 把含 `tier` 的信件寫進 `pending/`，指派器用 `rename` 移到實例 inbox（`src/run-session.ts:549-551`），frontmatter 不變。
- `tierFlag` 的收件者判定用 `roleOf(t)` 的 agent（實例名解析到角色），與 `parallel` 的 `routing.cap(role)` 相同作法。

## 24.9 doctor / status / log

### `doctor --resolved`（`src/cli.ts:564-580`、`flattenResolved` `src/config.ts:383-406`）

只有存在非空階梯時才多出這些行（沒有階梯時輸出逐位元相同）：

現有格式是 `<key> = <值>` 補齊後接來源檔（相對 home 的路徑），陣列以 JSON 顯示（`src/cli.ts:574-579`）。例（階梯寫在 team.yaml、node-engineer 的 model 寫在 project.yaml）：

```
model_tiers.claude-code = ["claude-haiku-5-5","claude-sonnet-5-5","claude-opus-5-5"]            team.yaml
agents.node-engineer.model = claude-opus-5-5                                                       projects/agent-lyceum/project.yaml
agents.node-engineer.model_tiers = ["claude-haiku-5-5","claude-sonnet-5-5","claude-opus-5-5"]   team.yaml
agents.docs-writer.model_tiers = ["claude-haiku-5-5","claude-sonnet-5-5"]                        team.yaml
```

`flattenResolved` 加 `model_tiers.<rt>`（非空階梯）與 `agents.<a>.model_tiers`（= `tiers`，有才加）；`resolveProjectWithSources` 加對應 sources，否則印出迴圈會略過（`src/cli.ts:576` 只列有 source 的鍵）。`agents.<a>.model_tiers` 的來源是 `{ file, key: "model_tiers.<rt>" }`，與 `dispatcher.fallback` 繼承的寫法相同（`src/config.ts:374-375`）；`--json` 的 `sources` 因此看得到 key。上限就是 `agents.<a>.model` 那一行，不重複。

### `doctor`（檢查模式）

24.3.4 的錯誤與警告經 `validateProject` 顯示，不另加段落。

### log（`log.jsonl`）

`wake` 事件（`src/run-session.ts:723-736`）：這次喚醒有有效 tier（`wakeTier` 有值，含 `high`）時加 `tier`；降級喚醒有降級候選，`chain` 為真，`model` 本來就會寫（`:735`）。例：

```json
{"event":"wake","agent":"node-engineer","runtime":"claude-code","attempt":0,"ok":true,"model":"claude-haiku-5-5","tier":"low", "...": "..."}
```

`tier_ignored` 見 24.5.2；`tier_step_up` 見 24.7.3。降級候選的 `wake` 事件**不帶** `fallback_from`（24.7.3）。

### state

- `WakeRecord`（`src/run-store.ts:50-71`）加 `tier?: Tier`（規則同 log）。降級喚醒時 `runtime`、`model` 由現有的 `chain` 寫法帶出（`src/run-session.ts:708`），`fallback_from` 依 24.7.3。
- `last_wake[agent]` 降級喚醒時由現有寫法帶 `runtime`、`model`（`src/run-session.ts:722`）。
- `state.sessions` 多出 `<agent>@<runtime>/<model>` 形式的 key（只在 `resume: true` 成員的降級喚醒），與備援 key 同形，沒有讀取端要改（`grep -rn "sessions\[" src` 只出現在 `src/run-session.ts`；`src/run-store.ts:250` 整個表原樣載入）。
- 沒 tier 的喚醒：紀錄逐位元相同。

### `status` / `status --json`

- `--json`：run 報告的 `wakes` 原樣輸出 state（`src/status.ts:368`），所以只多出選填 `tier`／`model`，是增量。`AgentReport` 不改：`fallbackView` 只對有鏈的 agent 作用（`src/status.ts:388`），降級喚醒不寫 `fallback_from`，所以不會被報成備援；只屬於 tier 的冷卻 key 不放進 `cooldowns`（理由見 24.7.3）；例外：降級模型若同時是 fallback 鏈成員（共用 key，24.6），它本來就在 `candidatesFor(a)` 的鏈 key 裡，`src/status.ts:407-411` 照舊顯示，保留此行為（審查 M-1，T-14 加這個重疊案例）。status-monitor 不需改。
- 文字：在 `formatStatus` 現有「備援中」行（`src/status.ts:627`）旁，最後一次喚醒是降級時加一行：`` `  <a> tier <tier>（<runtime>/<model>）` ``。

## 24.10 lead 提示（D-12）

`buildSystemPrompt` 結尾（`src/prompt.ts:266-267`）：lead、且至少一個非 lead 成員有 `tiers` 時，在 `PARALLEL_SECTION`（若有）**之後**附加：

```
## Task tiers
Some members can run a task on a cheaper model than their own. Add the frontmatter line `tier: low`, `tier: mid` or `tier: high` to a `task` you send them; without it they use their own model. Pick by difficulty: `low` for mechanical work with an exact spec (renames, a one-line fix, running a given command), `mid` for routine changes in one module, `high` (or no tier) for design, debugging, reviews and anything unclear. A tier lasts for that one task: replies and later mail on the thread run on the member's own model, so put `tier` again on each follow-up task. Each model keeps its own session, so a member that resumes sessions does not see what it did on another model; say in the task what it needs. If a tiered task comes back poor, send it again with a higher tier.
Members and the models each tier uses:
- node-engineer: low claude-haiku-5-5, mid claude-sonnet-5-5, high claude-opus-5-5
- docs-writer: low claude-haiku-5-5, mid claude-sonnet-5-5, high claude-sonnet-5-5
```

成員列表依 agent 名稱排序，只列有 `tiers` 的成員，不列實例名。無尾端換行（同 `PARALLEL_SECTION`）。段落**不承諾任何失敗後的復原**（是否往上限走取決於錯誤種類，24.7.2）；「提高 tier 重寄」可行，因為重複信判定納入 tier（24.5.4）。

**與 `WAKE_ECONOMY_SECTION`**：該段在 HEAD 不存在（`grep -n WAKE_ECONOMY_SECTION src/prompt.ts` 無輸出；它在任務 1b01e3 的 run 分支上，未合併）。若先合併，順序為：經濟段落（在原本位置）→ `## Parallel tasks` → `## Task tiers`；兩段不互相引用，tier 段落不重複「只在三個時點用最貴模型」的規則（那條講的是 lead 自己的模型）。

**已知限制**：續接的 Claude lead 可能保留舊系統提示（cli-architect 的 project memory `skill-claude-resume-system-prompt-snapshot`；專案 lesson `claude-wake-loads-user-claude-md` 也記了 `--system-prompt-snapshot` 預設開啟，未實測），run 中途加階梯時 lead 可能看不到段落；新 run 一定看得到。

## 24.11 逐模組改動（node-engineer）

| 檔案 | 改動 |
|---|---|
| `src/schema.ts` | `ModelTiersPartial`、`TIERS`/`Tier`；`GlobalConfig`、`ProjectConfig` 加 `model_tiers` |
| `src/tiers.ts`（新） | `availableTiers`、`modelForTier`、`tierFlag`、`wakeTier`、`isTier`、`effectiveTier(meta)`、`TIER_SECTION(agents)`，全部純函式 |
| `src/config.ts` | 合併 `modelTiers`、`ResolvedAgent.tiers`、sources、`flattenResolved` 只在有值時加行 |
| `src/validate.ts` | 24.3.4 的錯誤與警告 |
| `src/fallback.ts` | `Candidate.tiered`、`candidatesFor(agent, tierModel?)`、`planAttempts(all, cooldowns, now)`（24.7.1）、`agentForCandidate` 的 tiered 分支 |
| `src/mailbox.ts` | `MessageMeta.tier`、`DeliverInput.tier`、`routeOutboxes` 在 `parallel` 判定處呼叫 `tierFlag`，invalid 退回、ignored 交給 `routing`／log；`earlierDuplicate` 加 `tier` 參數（24.5.4） |
| `src/run-session.ts` | `wake()` 算 `wakeTier`→`modelForTier`→`all = candidatesFor(agent, m)`→`planAttempts(all, …)`；`replaced`／`fallback_from`／`onSwitch` 依 24.7.3；`tier_step_up` 終端行、note、log；紀錄 `tier`；`tier_ignored` note 去重。`sessionKeyOf` 不改 |
| `src/run-store.ts` | `WakeRecord.tier`、`last_wake` 型別 |
| `src/prompt.ts` | 附加 `## Task tiers` |
| `src/status.ts` | 24.9 的文字行（`fallbackView` 不改） |
| `src/cli.ts` | 無（`doctor --resolved` 走 `flattenResolved`／sources） |
| `test/fallback.test.ts` | `planAttempts` 四處呼叫改傳候選清單（`:162`、`:163`、`:168`、`:188`），預期值不變 |

`call`（solo）不收 lead 的 task，不套用 tier。

## 24.12 測試（qa 驗證，node-engineer 撰寫）

全部用暫存 `AGENT_LYCEUM_HOME`、假 runtime（fake invoker），不碰真實 `claude`／`codex`。

1. **T-1 對應表**：`modelForTier` 對 24.4 表格的每一列（長度 1..4、每個上限位置、三個 tier）。
2. **T-2 可用列表**：`availableTiers`——上限不在階梯、沒有 model、大小寫與空白差異、長度 1 回 `undefined`。
3. **T-3 驗證**：24.3.4 每條訊息逐字比對；`[]` 關掉 team 階梯不報錯。
4. **T-4 合併與來源**：team 有、project 覆寫、project `[]`；`doctor --resolved --json` 的值與來源。
5. **T-5 `tierFlag`**：24.5.2 表格每一列；lead 寫 `tier: High`、`tier: 1`、`tier: true` → 退回且訊息逐字。
6. **T-6 路由**：lead 的 task 投遞後 inbox 檔含 `tier: low`；成員寄的 `tier` 被拿掉且有 `tier_ignored` log 與一則 note；崩潰重播（`route:intent` 後故障）檔案內容不變。
7. **T-7 喚醒用的模型**：fake invoker 收到的 `agent.model` = 降級模型、`agent.effort` 不變；`high` 與無 tier 收到上限。
8. **T-8 session key（必要）**：`resume: true` 的成員：
   a. 上限喚醒拿到 `S1` → `tier: low` 喚醒：invoker 收到 `sessionId === undefined`、`model` 為降級模型；回傳 `S2` 後 `state.sessions` 有 `<agent>: S1` 與 `<agent>@claude-code/<low>: S2`。
   b. 接著上限喚醒：invoker 收到 `sessionId === S1`（不是 `S2`）。再一次 `tier: low`：收到 `S2`。
   c. session 先在降級模型上建立（第一次喚醒就是 `tier: low`）：key 只有 `<agent>@...`；之後上限喚醒不帶 sessionId。
   d. fallback 鏈有一項與降級模型同 `<runtime>/<model>`（大小寫不同也算）：`candidatesFor(agent, low)` 只有一個該 key 的候選（`tiered: true`）；鏈上備援與降級喚醒用同一個 `<agent>@...` key（有意共用，24.6）；與其他鏈項目的 key 不相撞。
   e. `resume: false` 時任何 tier 都不帶 sessionId，`state.sessions` 不變。
9. **T-9 候選規劃（`planAttempts(all, …)`）**，`all = candidatesFor(agent, low)`，鏈有一項：
   a. 全部未冷卻 → `[low, ceiling, chain]`。
   b. 降級模型冷卻 → `[ceiling, chain]`；喚醒有 `tier_step_up` log（`reason: "cooldown"`），紀錄沒有 `fallback_from`。
   c. 上限冷卻 → `[low, chain]`；降級模型 `rate_limit` → 下一次呼叫是鏈項目，其紀錄 `fallback_from` = 上限的 label。
   d. 全部冷卻 → 整條 `[low, ceiling, chain]`。
   e. 無 tier／無階梯：`planAttempts(candidatesFor(agent), …)` 與改動前 `planAttempts(agent, …)` 結果相同（既有 `test/fallback.test.ts:158-170` 的預期值不改）。
   f. 順序：降級模型回 `rate_limit` → 下一次呼叫是上限，再失敗才進鏈；`state.cooldowns` 有降級模型的 key；下一次 `tier: low` 喚醒直接從上限開始。降級模型回 `auth` 或 `unknown`（重試用完）→ 停，不換。
10. **T-10 批次**：`wakeTier`——全有 tier 取最高；任一缺 → `undefined`。
11. **T-11 實例**：`parallel: true` + `tier: low` 的兩封 task → `<role>--2` 的喚醒也用降級模型。
12. **T-12 lead 提示**：有/無階梯時 `buildSystemPrompt` 的結尾；與 `PARALLEL_SECTION` 同時存在的順序；成員排序；段落逐字（不含任何「自動以上限重試」的承諾）。
13. **T-13 向下相容（必要）**：
   a. 既有完整 fixture（沒有 `model_tiers`）跑一個 run，`state.json`、`log.jsonl`（去掉時間欄）、所有信件檔、lead 與成員的系統／使用者提示，與改動前逐位元相同。
   b. 有階梯、但 task 沒寫 `tier`：成員的提示、invoker 輸入、`state.json`、`log.jsonl`、信件檔與 a 相同（只有 lead 系統提示多 `## Task tiers`）。
   c. `tier: high`（以及對應到上限的 `mid`，例如 n=2）：invoker 輸入、session key、候選清單與 a 相同；差異只有投遞後信件的 `tier:` 行與 `wake` 事件／`WakeRecord` 的 `tier` 欄。
   d. agent 有既有 fallback 鏈、沒有 tier：鏈上備援的 `fallback_from`、`state.sessions` key、note 文字與改動前相同。
   e. 舊 `state.json`（無 `tier`）與含 `tier` 的 `state.json` 都能載入。
14. **T-14 status --json**：降級喚醒後 `wakes[-1]` 多 `tier`/`model`，其餘鍵與值不變；有鏈的 agent 只做了降級喚醒時 `agents[a].fallback` 不存在；status-monitor 的 `*.mod.test.ts` 照過。
15. **T-15 重複信與 tier（必要）**：
   a. lead 寄 task（`tier: low`），再寄同內文 `tier: high` → 投遞，不是重複。
   b. 同內文、同 tier 再寄 → 退回為重複；通知上限仍是 2（第 3 次靜默）。
   c. 先寄沒寫 tier、再寄 `tier: high`（或反過來）→ 重複。
   d. 收件者沒有 `tiers`：`tier: low` 與沒寫 tier 的同內文 → 重複（兩者投遞時都不帶 tier）。
   e. 保留佇列：角色已啟用實例，第一封在 `pending/` 或另一個實例 inbox 的 `read/`，改 tier 重寄 → 投遞；同 tier → 重複。
   f. 崩潰重播：重複信的通知在 `shouldNotifyDuplicate` 記錄後、搬到 `rejected/` 前故障，重播後 `duplicate-notices.json` 該 key 只有一筆 source。
16. **T-16 降級不是備援**：
   a. 降級模型第一次就成功：`WakeRecord`／`wake` 事件無 `fallback_from`；`status` 不報備援。
   b. 降級模型 `rate_limit` → 上限：上限那筆無 `fallback_from`；有 `tier_step_up`（`reason: "rate_limit"`）log 與 note。
   c. 接著上限也 `rate_limit` → 鏈項目：該筆 `fallback_from` = 上限 label，`status` 報備援來自上限。
17. **T-17 中斷後 resume 沿用 tier（必要）**：
   a. `tier: low` 喚醒中途 cancel（signal abort）→ run 中斷；`run` 續跑 → 第一次呼叫的 `agent.model` 是降級模型（信件仍在未讀，`src/run-session.ts:770-776`）。
   b. `tier: low` 喚醒的所有候選都 `timeout` 用完重試 → 喚醒失敗、run 停（`:778-779`）；續跑 → 第一次呼叫仍是降級模型（timeout 不記冷卻）。
   c. `resume: true` 時，a 的續跑帶的是 `<agent>@...` key 的 session（若中斷前已記下），不是上限的。

## 24.13 風險與未驗證

- **R-2** lead 標太低會讓任務品質下降或多一次喚醒；提示要求不明確就用 `high`。效果未量測。
- **R-3** 降級喚醒走非 legacy 重試迴圈（退避、冷卻），沒有鏈的 agent 首次看到這些訊息。
- **R-4** 舊版程式遇到含 `model_tiers` 的設定檔拒絕載入（大聲失敗，README 會寫要先拿掉，24.16）；遇到含 `tier` 的信件或 state 則忽略（用上限）；舊版的重複信判定不看 tier，只改 tier 重寄會被退回。
- **R-5** `resume: true` 的成員換 tier 時看不到另一個模型 session 的對話（24.6）；只有信件與 repo 是共通的。lead 提示已要求把需要的資訊寫進 task。
- 編號從 R-2 起：修訂 1 前的跨模型續接風險已隨 D-08 移除。

## 24.14 Dimension coverage

- **相容與格式**：新設定鍵選填；無階梯、或有階梯但沒寫 tier 時，提示（lead 除外）、state、log、信件逐位元相同（T-13）；不升 `schema_version`；舊版遇新設定 → strict zod 錯誤（README 降級說明），遇新信件／state → 忽略欄位（24.3.2、D-14）；`state.sessions` 新 key 與備援同形。
- **檔案與行程安全**：寫入範圍、sandbox 不變；降級模型與上限同 runtime，強制等級相同（24.3.4）。inbox 是否對 agent 可寫本 spec 未查證；即使 agent 改了自己 inbox 信件的 `tier`，最壞結果也只是用到上限＝今天，或用自己 key 的降級 session。
- **並發與復原**：投遞重播內容一致（24.5.3）；重複信通知每個來源只算一次（24.5.4）；resume 重做讀同一封信，tier 與 session key 不變（T-17）；冷卻表照舊存在 state。無新鎖。不跨模型續接，所以沒有「session 被拒→卡住」的復原問題。
- **平台與可維運**：macOS/Linux 無差異；兩個 runtime 都已在 adapter 傳模型；不依賴任何未驗證的 runtime 行為；無新依賴。
- **可測試與可維護**：新邏輯集中在純函式模組 `src/tiers.ts`；`planAttempts` 只過濾、清單只建一次；全部可用 fake invoker 測（24.12）。
- **可觀測與可診斷**：`wake` log 與 `state.wakes` 帶 `tier`/`model`；`tier_ignored`、`tier_step_up` log＋終端行（step-up 失敗時加 note）；`fallback_from` 只表示真正的備援；錯誤訊息指出 `model_tiers.<rt>[i]` 或 agent 名稱；`doctor --resolved` 顯示階梯、上限與來源。
- **成本**（本任務特有）：省的是成員簡單任務的單價；代價是錯標的重做，以及 `resume: true` 成員換 tier 時各模型分開累積 session（24.6）。

## 24.15 不採用的方案

- **自動判斷難度**：使用者定案 1 排除。
- **thread 範圍的 tier**：要在 state 存 thread→tier 對應並處理 resume、實例親和性；lead 每封後續 task 重新標就夠（24.5.3）。
- **降級與上限共用一個 session key（跨模型續接）**：真實 runtime 是否接受「續接 X、改用模型 Y」未驗證；被拒時多半是 `unknown`，`nextStep` 在重試用完後停（`src/fallback.ts:107-111`），喚醒失敗、信件留在未讀（`src/run-session.ts:778-779`），resume 重複同一次呼叫，沒有安全的復原；要補就得加一條偵測拒絕後開新 session 的路徑（24.6）。初版曾採用，修訂 1 改掉。
- **`planAttempts` 加選填 `tierModel` 參數**：可讓既有呼叫不動，但清單仍在兩處各建一次，正是遺失 tier 的成因（24.7.1）。
- **把 tier 冷卻放進 `status` 的 `fallbackView`**：沒有鏈的 agent 會多出 `cooldowns`，而降級冷卻不需操作者處理（24.7.3）。
- **重複信判定不看 tier、改為 lead 免除重複檢查**：會讓 lead 真正重複的信也穿過，失去 `duplicate-notice-cap` 防止的迴圈保護。
- **降級模型失敗直接進 fallback 鏈、不經上限**：上限通常是同帳號裡最可能成功的；跳過它會更早換 runtime。
- **只記在 route journal（像 `parallel`）**：專案層 mailbox 沒有 journal；tier 被竄改無安全影響（24.5.3）。
- **`mid` 取偏低的中間**：降錯一級的重做成本高於單價差（D-03）。
- **每個 agent 自己的 `model_tiers`**：先用 runtime 層級；有需要再加（延後）。
- **把 tier 放進 `dispatcher` 區塊**：`team.yaml` 沒有 `dispatcher`（`src/schema.ts:97-101`），只能放 project；使用者要兩處都可寫。

## 24.16 分工

- **node-engineer**：24.11 全部與 24.12 的測試。
- **qa**：跑 24.12，特別是 T-8、T-9、T-13、T-15、T-17。不需要真實 runtime 驗證（D-08 後沒有依賴未驗證 runtime 行為的路徑）。
- **docs-writer**：
  - `docs/configuration*.md` 加 `model_tiers` 與 `tier`（中英），含「每個模型各自一個 session」與「改 tier 重寄不算重複」。
  - `docs/how-it-works*.md` 的喚醒與 fallback 段落（降級 → 上限 → 鏈；tier step-up 不是備援）。
  - `docs/commands*.md` 的 `doctor --resolved` 範例（若列出設定行）。
  - `README.md` 與 `README.zh-TW.md` 各加一段短的降級說明（兩邊同標題）：舊版程式會拒絕含 `model_tiers` 的設定；改用舊版前先從 `project.yaml` 與 `team.yaml` 拿掉 `model_tiers`。設定鍵本身是選填，新版對舊設定不是破壞性改動，但降級方向會大聲失敗，所以要寫。
