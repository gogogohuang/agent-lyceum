# LLM 備援（failover）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主要 LLM 因限流、額度、逾時、網路或 CLI 崩潰失敗時，agent 的這次 wake 自動改用設定好的備用模型（可跨 runtime）完成，並在 `status`、`log.jsonl`、失敗報告裡標示。

**Architecture:** 新增純邏輯模組 `src/fallback.ts`（候選序列、重試或切換的決策、run 內冷卻表）。兩個 adapter 各自把失敗輸出分類成 `ErrorKind`，經 `Parsed` → `WakeResult.kind` 往上傳。`RunSession.wake` 與 `call` 都改用 `fallback.ts`，備用候選就是覆寫了 `runtime`／`model`／`effort` 的 `ResolvedAgent` 丟給同一個 `invoke`，adapter 不知道備援的存在。設定在 `schema.ts`／`config.ts` 解析成 `ResolvedAgent.fallback`，載入時由 `validate.ts` fail closed。

**Tech Stack:** TypeScript ESM、Node `fs`、zod、Vitest、Biome。不新增依賴。

**Spec:** `docs/specs/20-llm-fallback.md`（決議 1–11）。

## Global Constraints

- Node >=20，macOS 與 Linux；不新增依賴。
- 沒設 `fallback`（agent 與 `dispatcher.fallback` 都沒有）時行為與輸出必須與現在逐字相同：既有 `retry` 迴圈、`state.json`、`log.jsonl`、`status --json`、`failure` 的既有欄位都不變；新欄位只在有備援時才出現，或只是新增。
- 舊 `state.json`（沒有 `cooldowns`、`wakes[]` 沒有新欄位）必須可讀可續跑。
- 只對 `rate_limit`、`quota`、`timeout`、`network`、`crash` 切換；`auth` 直接報錯；`unknown` 在同一個模型重試 `retry` 次後報錯，不切換。
- 備援不得放寬限制：載入時 `validate` 對 adapter 保證不了的限制報 `error`，不是執行時才警告。
- 切換後是全新 session，重做用 `retryPrompt`，不帶前一個模型的部分輸出。
- 程式、prompt、文件與測試不得寫死任何 agent 名稱。
- 每個 Task 結束時 `npm run typecheck`、`npm test`、`npm run lint` 都要通過；碰到文件時另跑 `npm run check:docs`。
- Commit 訊息結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`（執行時若系統提示給了別的 attribution，以系統提示為準）。發版不在這份計畫內。

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/schema.ts` | `ERROR_KINDS`／`ErrorKind`、`FallbackEntry`、`AgentPartial.fallback`、`DispatcherPartial.fallback`、`fallback_cooldown_sec`、`DispatcherSettings` 預設 |
| `src/config.ts` | 兩層 `fallback` 解析成 `ResolvedAgent.fallback`、`sources.fallback` |
| `src/validate.ts` | 備援項目驗證（能力、effort、與主要相同） |
| `src/adapters/types.ts` | `Parsed.kind`、`WakeResult.kind` |
| `src/adapters/claude.ts`、`codex.ts` | `classifyError` 與規則表，`interpretClaude`／`finishCodex` 帶出 `kind` |
| `src/process-runner.ts` | 逾時、spawn `ENOENT` 帶出 `kind` |
| `src/fallback.ts`（新增） | `planAttempts`、`nextStep`、`Cooldowns`、`backoffMs` |
| `src/run-store.ts` | `RunState.cooldowns`、`WakeRecord` 新欄位、`failure.tried`、舊 state 預設值 |
| `src/run-session.ts` | `wake` 迴圈改用 `fallback.ts`；session key；冷卻存取 |
| `src/run-outcome.ts` | `failureGuide` 列出 `tried` |
| `src/call.ts` | 改走共用切換函式 |
| `src/status.ts`、`plugins/status-monitor/` | 顯示目前模型、備援標記、冷卻 |
| `src/cli.ts` | `doctor` 檢查備援鏈 CLI |
| `test/fixtures/runtime/fake-claude.mjs`（及 codex 對應 fixture） | 模擬各種失敗 |
| `test/fallback.test.ts`（新增）、`test/fallback-lifecycle.test.ts`（新增）、`test/adapters.test.ts` | 本計畫全部新測試 |
| `README*.md`、`docs/{configuration,how-it-works,commands,monitor}*.md`、`docs/specs/20-*.md`、`docs/specs/README.md` | 文件與狀態 |

---

### Task 1: 設定、解析與載入時驗證

**Files:**
- Modify: `src/schema.ts`、`src/config.ts`、`src/validate.ts`
- Test: `test/config.test.ts`、`test/validate.test.ts`

**Interfaces:**
- Produces（後續 Task 依賴這些名稱與形狀）：
  - `export const ERROR_KINDS = ["rate_limit", "quota", "timeout", "network", "crash", "auth", "unknown"] as const; export type ErrorKind`
  - `export interface FallbackEntry { runtime: Runtime; model: string; effort?: Effort }`（解析後；原始檔案允許省略 `runtime`）
  - `ResolvedAgent.fallback: FallbackEntry[]`
  - `DispatcherSettings.fallback_cooldown_sec: number`（預設 300）

- [ ] **Step 1: 寫失敗測試**
  - `config.test.ts`：agent 的 `fallback` 覆蓋 `dispatcher.fallback`；agent 設 `[]` 不備援；project 覆蓋 global；`{ model: sonnet }` 由 `inferRuntime` 補出 `claude-code`；推斷不出來沿用 agent 的 runtime；沒設任何 `fallback` 時 `ResolvedAgent.fallback` 是 `[]`，`sources.fallback` 為 `"default"`。
  - `validate.test.ts`：項目沒有 `model` 也沒有 `runtime` ⇒ error；`effort` 不在該項目 runtime 的 `RUNTIME_EFFORTS` ⇒ error；與主要的 `runtime`＋`model` 相同 ⇒ error；備援 runtime 無法保證 agent 的限制 ⇒ error（能力表見 Step 3）。
- [ ] **Step 2: 跑測試確認失敗**（`npx vitest run test/config.test.ts test/validate.test.ts`）。
- [ ] **Step 3: 實作**
  - `schema.ts`：`FallbackEntryPartial = z.object({ runtime: z.enum(RUNTIMES).optional(), model: z.string().optional(), effort: z.enum(EFFORTS).optional() }).strict()`；`AgentPartial.fallback`、`DispatcherPartial.fallback` 為其陣列；`DispatcherPartial.fallback_cooldown_sec: z.number().int().min(0).optional()`；`DISPATCHER_DEFAULTS.fallback_cooldown_sec = 300`。
  - `config.ts`：優先序 agent（project > global）> `dispatcher.fallback` > `[]`；填滿 `runtime`（`inferRuntime(model)`，再沿用 agent 的 runtime）；`sources.fallback`。
  - `validate.ts`：能力表 `RUNTIME_CAPS: Record<Runtime, { webLevels: WebLevel[]; ... }>` 放在 `src/schema.ts` 旁或 `src/adapters/`，逐項列出現有 adapter 對 `allow_web`、`can_ask_user`、write-scope 強制層級的支援；備援項目的 runtime 若保證不了 agent 的設定，`error` 訊息為 `agent <name>: fallback <runtime>/<model> cannot enforce <setting>`。**這一步先讀 `src/policy.ts` 的 `enforcementFor` 與兩個 adapter，列出實際差異再寫表，不要憑印象。**
- [ ] **Step 4: 測試通過，`npm run typecheck && npm test && npm run lint`**。
- [ ] **Step 5: commit**（`feat(fallback): config, resolution and load-time validation`）。

---

### Task 2: 錯誤分類與 fake runtime

**Files:**
- Modify: `src/adapters/types.ts`、`src/adapters/claude.ts`、`src/adapters/codex.ts`、`src/process-runner.ts`、`test/fixtures/runtime/fake-claude.mjs`（及 codex 對應 fixture）
- Test: `test/adapters.test.ts`、`test/process-runner.test.ts`

**Interfaces:**
- Produces：`Parsed.kind?: ErrorKind`、`WakeResult.kind?: ErrorKind`；`export function classifyClaudeError(out: { code: number | null; stdout: string; stderr: string; result?: string }): ErrorKind`，`classifyCodexError` 同形。

- [ ] **Step 1: 蒐集真實樣本**：從 `~/agent-lyceum-config` 與 `.agent-lyceum` 下既有 run 的 `mail/attempts/*/stderr.log`、`stdout.log` 找實際的失敗輸出；找不到的類別（例如額度用完）用官方文件的錯誤字串，並在測試註解標明來源。**樣本不足的類別在 plan 結果裡回報，規則先寫保守版本，不要憑空編字串。**
- [ ] **Step 2: 寫失敗測試**：每條規則一個樣本字串 ⇒ 預期 `kind`；沒有符合的輸出 ⇒ `unknown`；成功輸出 ⇒ `kind` 為 `undefined`；`process-runner` 逾時 ⇒ `timeout`、`ENOENT` ⇒ `crash`、取消不帶 `kind`。
- [ ] **Step 3: 實作**：規則表放在各 adapter 檔內（有序，先符合先用）；`interpretClaude`／`finishCodex` 失敗時呼叫 `classify*Error` 填 `kind`；`process-runner` 的逾時與 spawn 錯誤直接設 `kind`；非 0 離開且沒有任何規則符合 ⇒ `unknown`，不要預設成 `crash`（避免 Task 3 的決策誤切換）。
- [ ] **Step 4: 擴充 fake runtime**：支援 `FAKE_FAIL=<kind>[:<times>]`（或 script 裡 `fail: "<kind>"`），輸出對應 `ErrorKind` 的真實樣本字串與離開碼；`times` 讓前 N 次失敗之後成功。兩個 fixture 都要。
- [ ] **Step 5: `npm run typecheck && npm test && npm run lint`，commit**（`feat(fallback): classify runtime errors`）。

---

### Task 3: `fallback.ts` 純邏輯

**Files:**
- Create: `src/fallback.ts`
- Test: `test/fallback.test.ts`

**Interfaces:**
- Produces（Task 4、5 依賴）：
  - `export interface Candidate { runtime: Runtime; model?: string; effort?: Effort; primary: boolean; key: string }`，`key = "<runtime>/<model>"`。
  - `export function candidatesFor(agent: ResolvedAgent): Candidate[]` — 主要 + `agent.fallback`。
  - `export class Cooldowns { mark(key, kind, now, sec): void; active(key, now): number /* 剩餘 ms，0 = 無 */; toJSON(): Record<string, { until: string; kind: ErrorKind }>; static from(json?): Cooldowns }`
  - `export function planAttempts(agent, cooldowns, now): Candidate[]` — 略過冷卻中的候選；若全部在冷卻，回傳全部（不能因此什麼都不試）。
  - `export function nextStep(kind: ErrorKind | undefined, attemptsOnCurrent: number, retry: number, hasNext: boolean): "retry-same" | "next-candidate" | "stop"`。
  - `export function backoffMs(n: number): number` — `min(5 * 3 ** (n - 1), 60) * 1000`。

- [ ] **Step 1: 寫失敗測試**：`nextStep` 決策表（`rate_limit`／`quota` 有下一個 ⇒ `next-candidate`，沒有 ⇒ `stop`；`timeout`／`network`／`crash` 先 `retry-same` 到 `retry` 次再 `next-candidate`／`stop`；`auth` ⇒ `stop`；`unknown` ⇒ 重試到 `retry` 次後 `stop`，永不 `next-candidate`；`kind` 為 `undefined`（沒有分類）等同 `unknown`）；`Cooldowns` mark／active／過期／序列化；`planAttempts` 略過冷卻、全部冷卻時回傳全部；`backoffMs` 序列 5s、15s、45s、60s。
- [ ] **Step 2: 實作**：純函式，不碰 IO、不碰時鐘（`now` 由呼叫者給）。
- [ ] **Step 3: `npm run typecheck && npm test && npm run lint`，commit**（`feat(fallback): attempt planning, decision table and cooldowns`）。

---

### Task 4: `RunSession.wake` 整合、state 與失敗報告

**Files:**
- Modify: `src/run-session.ts`、`src/run-store.ts`、`src/run-outcome.ts`
- Test: `test/fallback-lifecycle.test.ts`（新增）、`test/run-store.test.ts`、`test/run-outcome.test.ts`

**Interfaces:**
- Consumes：Task 3 的 `candidatesFor`／`planAttempts`／`nextStep`／`backoffMs`／`Cooldowns`。
- Produces：`RunState.cooldowns?: Record<string, { until: string; kind: ErrorKind }>`；`WakeRecord` 新增 `runtime`、`model`、`fallback_from?`、`kind?`；`failure.tried?: { runtime: Runtime; model?: string; kind?: ErrorKind; error?: string }[]`；`state.sessions` 備用 key `agent@runtime/model`。

- [ ] **Step 1: 寫失敗測試**（`fallback-lifecycle.test.ts`，用 Task 2 的 fake runtime）：
  - (a) 限流 ⇒ 主要只呼叫一次、備用完成，run 成功；
  - (b) 網路錯誤 ⇒ 主要重試 `retry` 次後切備用；
  - (c) `auth`、`unknown` ⇒ 不切換、報錯，`failure.tried` 只有主要；
  - (d) 全鏈失敗 ⇒ `failure.tried` 依序完整，`failureGuide` 列出每層；
  - (e) 冷卻 ⇒ 第二個 wake 直接從備用開始（觀察呼叫次數）；平行成員共用冷卻；
  - (f) 備用 session 存在 `agent@runtime/model`，不覆寫主要 key；
  - (g) 切換後未讀信件不丟、`state.rounds` 與 attempt 記錄各算一輪；
  - (h) 沒設 `fallback` ⇒ `state.json`、`log.jsonl` 與改動前逐欄位相同（用既有 `run-lifecycle` 測試當回歸，另加一個 snapshot）；
  - (i) 缺 `cooldowns`、`wakes[]` 缺新欄位的舊 `state.json` 可續跑。
- [ ] **Step 2: 實作 `wake`**：保留 `claimMessages`、`beginAttempt`／`finishAttempt`、`parkOutbox`、abort 與 `max_rounds` 的所有現有行為；把 `for attempt` 改成「取得 `planAttempts` 序列，對當前候選呼叫 `invoke`（備用候選用 `{ ...agent, runtime, model, effort }`）→ `nextStep` 決定重試（先 `await sleep(backoffMs)`，可被 `opts.signal` 中斷）、前進或停止」。`rate_limit`／`quota` 時 `cooldowns.mark(key, kind, now, cfg.fallback_cooldown_sec)` 後存 state。切換時 `say("  <agent> falling back to <runtime>/<model> (<kind>)")`，`note` 附「副作用可能已發生」警語。沒有備援鏈時，候選序列長度為 1，`nextStep` 的結果必須與現有迴圈等價（含不對 `rate_limit` 以外做任何新行為；註：沒有備援時 `rate_limit` 仍重試 `retry` 次，與現狀一致，不得提前 `stop`）。
- [ ] **Step 3: state 與 session key**：`run-store.ts` zod 與預設補新欄位；主要候選沿用 `state.sessions[agent]`，備用候選用 `agent@runtime/model`。
- [ ] **Step 4: 失敗報告**：只有設了備援時 `failure.tried` 才出現；`failureGuide` 逐層列出，並保留 `agent-lyceum resume` 提示。
- [ ] **Step 5: `npm run typecheck && npm test && npm run lint`，commit**（`feat(fallback): switch to backup models in RunSession.wake`）。

---

### Task 5: `call` 共用切換邏輯

**Files:**
- Modify: `src/call.ts`，必要時把 Task 4 的核心抽成 `src/fallback.ts` 的 `invokeWithFallback`
- Test: `test/call.test.ts`

- [ ] **Step 1: 寫失敗測試**：限流 ⇒ 切備用成功、`result.md` 正常；全鏈失敗 ⇒ `# Call failed` 附 `tried` 各層；沒設備援 ⇒ 與現在逐字相同（單次呼叫，沒有重試）。
- [ ] **Step 2: 實作**：把「候選迴圈＋決策＋冷卻」抽成一個接受 `invoke`、agent、`retry`、`cooldowns`、`sleep` 的函式，`RunSession.wake` 與 `call` 都用它（`wake` 傳入自己的 attempt 記錄 hook）。**`call` 目前沒有重試：沒備援時 `retry` 傳 0，維持單次呼叫；有備援時 `rate_limit`／`quota` 切換、其餘暫時性失敗在 `call` 內只切換不重試（`retry` 為 0）。**
- [ ] **Step 3: `npm run typecheck && npm test && npm run lint`，commit**（`feat(fallback): shared switch logic for call`）。

---

### Task 6: `status`、`log.jsonl`、monitor、`doctor`

**Files:**
- Modify: `src/status.ts`、`src/run-session.ts`（`log("wake", …)`）、`plugins/status-monitor/`、`src/cli.ts`
- Test: `test/status.test.ts`、`test/status-graph-data.test.ts`、`test/doctor.test.ts`、`test/run-log.test.ts`

- [ ] **Step 1: 寫失敗測試**：`log.jsonl` 的 `wake` 事件含 `model`、`fallback_from`、`kind`；`status --json` 新增 `runtime`、`model`、`fallback`、`cooldowns`，既有欄位與沒備援時的輸出不變；文字版 `status` 備用時標 `fallback: <原因>`、冷卻剩餘時間；`doctor` 在備援鏈 CLI 不存在或未登入時報告。
- [ ] **Step 2: 實作**；monitor 只在 agent 卡片加一個「備援中」小標記，不改版面。`doctor` 沿用現有 `--version`／`--help` 檢查，對備援鏈裡出現的每個 runtime 各檢查一次。
- [ ] **Step 3: `npm run typecheck && npm test && npm run lint`，commit**（`feat(fallback): show fallback in status, log, monitor and doctor`）。

---

### Task 7: 文件與狀態

**Files:**
- Modify: `docs/configuration.md`、`.zh-TW.md`、`docs/how-it-works.md`、`.zh-TW.md`、`docs/commands.md`、`.zh-TW.md`、`docs/monitor.md`、`.zh-TW.md`、`README.md`、`README.zh-TW.md`、`docs/specs/20-llm-fallback.md`（狀態改為「已實作」）、`docs/specs/README.md`（Plan 欄連到本檔）

- [ ] **Step 1: 照 spec 20.8 寫文件**，中英標題結構一致。
- [ ] **Step 2: `npm run check:docs && npm run typecheck && npm test && npm run lint`**。
- [ ] **Step 3: commit**（`docs: LLM fallback in both languages (spec 20)`）。

---

## Self-Review

- 決議 1–11 對應：1、2 ⇒ Task 2、3；3、4 ⇒ Task 1；5 ⇒ Task 3、4；6 ⇒ Task 4；7 ⇒ Task 3、4、6；8 ⇒ Task 1、6；9 ⇒ Task 5；10 ⇒ Task 4、6；11 ⇒ 每個 Task 的回歸測試與 Global Constraints。
- 風險：Task 2 的錯誤字串樣本可能不足，已要求回報而非編造；Task 1 的能力表必須先讀程式碼再寫。
- 實作前提：spec 20 已核可（使用者確認）；plan 本身尚待使用者核可後才開 feature branch 實作。
