# Cursor runtime adapter（Grok via Cursor Agent CLI）

日期：2026-11-17　狀態：設計已核准，待實作計畫

## 1. 目標

在 agent-lyceum 框架內新增第三個 **runtime**：`cursor`，透過 **Cursor Agent CLI**（`agent`）喚醒 agent，v1 以 **Grok**（`grok-*`）為唯一允許的 model 族。

agent-lyceum 仍是框架（團隊、mailbox、rounds、policy、fallback、doctor），不是 LLM 產品。`cursor` 與既有 `claude-code`／`codex` 同級：把 `WakeInput` 編成 invocation、解析結果與錯誤種類。

使用者設定與其他 runtime 同形：

```yaml
agents:
  lead: { runtime: cursor, model: grok-4.7 }
```

帳號：Cursor Plus（或更高）已能使用 Grok；以 `agent login` 或 `CURSOR_API_KEY` 認證。不依賴 xAI 獨立的 `grok`／Grok Build CLI。

## 2. 非目標（v1）

- `model: auto`、Composer、或其他非 `grok-*` model（日後可放寬白名單，不必改框架契約）
- 直接呼叫 xAI HTTP API
- xAI `grok` binary adapter
- approval enrollment（enrolled agent 使用 `cursor` 時 **拒絕**，同 Codex）
- 保證 Cursor permissions／sandbox 與 Claude OS sandbox 逐項等價（能對多少寫清；對不齊的標「未套用」）
- 在 lyceum 內做 model router／Auto／自研 coding agent

## 3. 角色邊界

| 層 | 負責 |
|---|---|
| agent-lyceum | 團隊、mailbox、rounds、write policy、fallback、doctor、status |
| Cursor Agent CLI | 推理與工具執行 |
| `src/adapters/cursor.ts` | WakeInput → `agent` invocation；parse／stream；錯誤分類 |

`RunSession`／mailbox／rounds 契約不變；`buildInvocation` 增加 `case "cursor"`。

## 4. 設定

### 4.1 最小

```yaml
# project.yaml 或 team.yaml
agents:
  lead:      { runtime: cursor, model: grok-4.7 }
  engineer:  { runtime: cursor, model: grok-4.6, can_message: [lead] }
```

### 4.2 推斷

`inferRuntime`：model 符合 `grok-*`（大小寫不敏感的慣例與現有規則一致）→ `cursor`。因此可寫：

```yaml
agents:
  lead: { model: grok-4.7 }
```

### 4.3 混用／fallback／tiers

與現有 runtime 相同語意；不強制使用者開 fallback 或 `model_tiers` 才能用。

```yaml
dispatcher:
  fallback:
    - { runtime: cursor, model: grok-4.7 }

model_tiers:
  cursor:
    - grok-4.5
    - grok-4.6
    - grok-4.7
```

### 4.4 Model 白名單（v1）

- 允許規則（唯一）：trim 後大小寫不敏感，`model` 以 `grok` 開頭（例如 `grok-4.7`、`grok-4.6`、`Grok-4.5`）
- 拒絕：`auto`、`composer*`、第三方 Claude／GPT id，以及任何不以 `grok` 開頭的字串
- **`runtime: cursor` 必須有 `model`**，且通過上列規則；未寫 `model` → 載入錯誤（避免 CLI 預設落到非 Grok）
- fallback／`model_tiers.cursor` 的每一項若帶 `model`，同樣套用白名單；只寫 `runtime: cursor` 不寫 model 的 fallback 項 → 載入錯誤

### 4.5 Effort

Cursor CLI 無穩定公開的 effort flag；Plus 上 Grok 固定設定。`RUNTIME_EFFORTS.cursor = []`。agent 或 fallback 項設定了 `effort` → 載入錯誤（與「該 runtime 不合法 effort」一致）。

## 5. Invocation 契約

**Binary：** `agent`

**每次 wake（概念）：**

```text
agent -p --force --trust
  --sandbox enabled
  --workspace <repo|scratch cwd>
  --model <grok-*>          # 若 agent.model 有設
  --output-format stream-json
  [--resume <sessionId>]
  <combined prompt>
```

| Wake／agent 欄位 | Cursor 對應 |
|---|---|
| `systemPrompt` + `userPrompt` | 合併進單一 prompt（同 Codex；無 Claude 的 append-system-prompt-file） |
| `sessionId` | `--resume <id>`；從 json／stream-json 取出可存回的 session／chat id |
| `model` | `--model` |
| `effort` | 不支援（見 4.5） |
| write policy | 見 §6 |
| `allow_web` | permissions 的 `WebFetch` allow／deny（見 §6） |
| timeout／cancel | 既有 `runInvocation`／`signal` |
| ship | 呼叫既有 `applyShipToWake`（與 Claude／Codex 同一掛載）；不把 `workDir` 加進可寫範圍以致 session 被改寫（對齊 Codex 精神） |

**cwd／workspace：** 一般 wake 的 repo／worktree 與 Claude／Codex 相同（`repoDirFor`）；policy override（tidy）用 scratch cwd，repo 唯讀語意與既有一致。

**Prompt 傳遞：** 預設把合併後的 prompt 當 `agent -p` 的引數；實作計畫第一步用本機 CLI 確認是否支援 stdin。若引數過長失敗，改為 workDir 內檔案並採用 CLI 支援的讀檔方式，測試釘住最終路徑。

**輸出：** 偏好 `stream-json` + `stream()` parser（有界記憶，同 Codex）；`json` 作為 fallback parse 路徑。從結果抽出 `text`、`sessionId`、可取得的 token 用量。

**錯誤分類：** 對 stdout／stderr／exit 套 regex → 既有 `ErrorKind`（auth、rate_limit、quota、timeout、…），供 fallback 決策；無法辨識則 `unknown`。

## 6. Write policy 與 sandbox

### 6.1 Permissions 檔

每次 wake 在該次 `workDir` 寫入 Cursor CLI config（經 `CURSOR_CONFIG_DIR=<workDir>` 或同等、**不**污染 repo 的 `.cursor/cli.json`）：

- `permissions.deny`：對應 `writePolicy`／approval deny 的受保護寫入（`Write(path)`／glob，語意盡量對齊 Claude deny）
- `permissions.allow`：依需要放行 workspace 內寫入與必要 Shell；細節在實作計畫用 TDD 釘住
- `allow_web: none` → deny `WebFetch(*)`（或等效）；`search`／`fetch` → 對應允許規則（能表達多少算多少）

`--force` 仍尊重 deny（Cursor 文件契約）。

### 6.2 Sandbox 旗標

- 預設：`--sandbox enabled`
- `agent.sandbox.network`／`local_binding`／`unix_sockets`：對照 Cursor 實際能力；**套用不到的鍵**在 `sandboxCaps`／`doctor`／docs 標「未套用」（同 Codex 對 `local_binding` 等）

### 6.3 Approval enrollment

`agent.enrolled === true` → 在寫任何檔或 spawn 前拋錯拒絕（同 Codex）。`doctor` 列為 error。

### 6.4 Guard

既有 post-wake 受保護檔雜湊／還原機制繼續適用；不因新 runtime 關閉。

## 7. Schema／Doctor／文件

### 7.1 Schema（`src/schema.ts` 等）

- `RUNTIMES` 含 `"cursor"`
- `inferRuntime` 認 Grok
- model 白名單校驗（agent 與 fallback／tiers 項目）
- `model_tiers` 可含 `cursor` 鍵
- `RUNTIME_EFFORTS.cursor` 為空

### 7.2 Doctor（`src/doctor.ts`）

- `BINARY.cursor = "agent"`
- probe：`--help`／version；json／resume／sandbox 能力記 yes／no／unknown
- 警告：無 `CURSOR_API_KEY` 且無法確認已 login（若 probe 可偵測）
- enrolled + cursor → error

### 7.3 文件

- `docs/configuration.md` 與 `docs/configuration.zh-TW.md`：`runtime: cursor`、Grok 範例、effort 不適用
- write-scope 文件：Cursor 實際 enforcement 邊界與已知缺口
- 不新增獨立 README 專章，除非既有 runtime 文件結構要求對等段落

## 8. 測試（TDD）

- 新／擴充 adapter 測試：args、env（含 `CURSOR_CONFIG_DIR`）、permissions 內容、resume、model 白名單、enrolled 拒絕、錯誤分類樣例
- schema／config 測試：`inferRuntime`、非法 model／effort、`model_tiers.cursor`
- doctor 測試：binary 名稱、enrolled 拒絕
- **不**改動凍結的 approval-compat／stage3 baseline fixtures，除非為支援新 runtime 所必需且另開明確任務
- 真實 `agent` 端到端：非 CI 必跑；文件標「需本機已 login」

## 9. 實作落點（預期）

| 區域 | 變更 |
|---|---|
| `src/adapters/cursor.ts` | 新建 |
| `src/adapters/index.ts` | `case "cursor"` |
| `src/schema.ts` | Runtime、infer、effort、tiers |
| `src/doctor.ts` | BINARY、probe 分支 |
| `src/policy.ts` | `sandboxCaps` 等 runtime 分支 |
| config／resolve 路徑 | 白名單與錯誤訊息 |
| `test/*` | 對應 TDD |
| `docs/configuration*.md`、write-scope | 使用者文件 |

## 10. 驗收標準

1. 可在 `project.yaml` 設 `runtime: cursor, model: grok-4.7` 並通過載入／`doctor`（本機有 `agent` 時）
2. fake／單元測試下 invocation 形狀穩定、可回歸
3. enrolled cursor 被拒絕
4. 非 `grok-*` model 被拒絕
5. fallback 鏈可包含 `cursor`／`grok-*` 項目
6. 框架其餘行為（mail、rounds、guard）不因未使用 cursor 的專案而改變
