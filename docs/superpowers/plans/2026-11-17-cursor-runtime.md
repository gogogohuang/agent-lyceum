# Cursor runtime（Grok）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增與 `claude-code`／`codex` 同級的 `cursor` runtime adapter，讓使用者可用 Cursor Agent CLI + Grok（`grok-*`）當 lyceum 團隊的一員。

**Architecture:** `src/adapters/cursor.ts` 將 `WakeInput` 編成 `agent -p --force --trust --sandbox enabled …`；permissions 寫入 `workDir` 的 `cli-config.json` 並設 `CURSOR_CONFIG_DIR`；schema／validate／doctor／policy 擴充第三 runtime。框架（mailbox、rounds）不改。

**Tech Stack:** TypeScript（NodeNext）、vitest、既有 `runInvocation`／`WakeInput` 契約；外部 binary：`agent`（Cursor CLI）。

**Spec:** `docs/superpowers/specs/2026-11-17-cursor-runtime-design.md`

## Global Constraints

- 遵守 spec：v1 model 必須存在且（大小寫不敏感）以 `grok` 開頭；拒絕 Auto／Composer；`RUNTIME_EFFORTS.cursor = []`；enrolled → 拒絕 spawn（同 Codex）。
- 不污染 repo 的 `.cursor/cli.json`；用 `CURSOR_CONFIG_DIR=<workDir>`。
- 不改凍結的 `test/approval-compat.test.ts`／`test/approval-stage3-baseline.test.ts` fixtures，除非另開任務且有明確理由。
- 程式風格：雙引號、分號、相對 import 加 `.js`；`npm run lint`（biome）須過。
- 回應／文件使用者可見字：繁中文件對 `configuration.zh-TW.md`／`write-scope.zh-TW.md`，英文對偶檔同步。
- **Commit：** 僅在使用者明確要求執行本 plan 後，才在各 task 末 commit；未經要求不 commit。
- 不 bump version、不寫 changelog，除非使用者另要求。

## Clarifications（規劃時釘死）

1. **Grok 判定：** `isGrokModel(m)` = `m.trim().toLowerCase().startsWith("grok")`。`inferRuntime` 在既有 Claude／Codex 規則之後：`isGrokModel` → `"cursor"`。
2. **Prompt：** 合併 `systemPrompt + "\n\n=====\n\n" + userPrompt`（同 Codex 分隔）。以 `-p` 的下一個 CLI 引數傳遞（Cursor 文件主路徑）。Task 1 spike 若發現必須用 stdin，改 `Invocation.stdin` 並更新測試；不得 silently 兩種並用。
3. **輸出：** `--output-format stream-json`；實作 `stream()`；session id 從事件欄位 `session_id`／`chatId`／`id`（實測後釘死一個優先序，測試用 fixture 字串）。
4. **ship：** 呼叫 `applyShipToWake`；不把 `workDir` 當可寫 workspace 根（對齊 Codex：session 檔不可被 agent 改寫）。
5. **effort 錯誤文案：** 當 `RUNTIME_EFFORTS[rt].length === 0` 時訊息為 `effort is not supported by ${rt}`（不要 `use ` 空列表）。

## File Structure

| File | Responsibility |
| --- | --- |
| `src/schema.ts` | `RUNTIMES`、`inferRuntime`、`RUNTIME_EFFORTS`、`ModelTiersPartial`、匯出 `isGrokModel` |
| `src/validate.ts` | cursor 必須有 grok model；fallback／tiers；effort 空列表文案；「無 runtime」提示含 grok |
| `src/adapters/cursor.ts` | `buildCursorInvocation`、`classifyCursorError`、permissions 寫入、enrolled 拒絕 |
| `src/adapters/index.ts` | `case "cursor"` |
| `src/doctor.ts` | `BINARY.cursor = "agent"`；probe 分支 |
| `src/doctor-approval-premises.ts` | enrolled + cursor → error（同 codex） |
| `src/policy.ts` | `enforcementFor`／`sandboxNotes`／`sandboxCaps` 的 cursor 分支 |
| `test/schema-cursor.test.ts`（或擴充既有 schema／validate 測試） | infer／白名單 |
| `test/adapters-cursor.test.ts` | invocation／permissions／enrolled／classify |
| `test/doctor-*.test.ts` 等 | binary／enrolled premise |
| `docs/configuration.md`、`docs/configuration.zh-TW.md` | 設定說明 |
| `docs/write-scope.md`、`docs/write-scope.zh-TW.md` | Cursor enforcement 邊界 |

---

### Task 1: CLI spike（本機 `agent`，寫進本 plan 附錄）

**Files:**
- Modify: `docs/superpowers/plans/2026-11-17-cursor-runtime.md`（僅附錄「Spike 結果」）

**Interfaces:**
- Produces: 釘死的 flags／json 欄位名（供 Task 3）

- [ ] **Step 1: 跑只讀探測**

```bash
agent --version
agent --help
agent -p --help 2>&1 | head -80
```

記錄：`--output-format` 是否含 `stream-json`、`--resume`、`--sandbox`、`--workspace`、`--trust`、`-p` 是否吃位置引數。

- [ ] **Step 2: 可選（需已 login）極短 headless**

```bash
cd /tmp && agent -p "Reply with exactly: pong" --model grok-4.7 --output-format json --trust 2>&1 | head -c 4000
```

從輸出記下 session／result 欄位名。若未 login，跳過並在附錄寫「未跑 live；parser 先支援常見欄位 + 測試 fixture」。

- [ ] **Step 3: 把結論寫進本檔文末「Spike 結果」**（不得留 TBD）

- [ ] **Step 4: Commit**（僅當使用者已要求執行 plan）

```bash
git add docs/superpowers/plans/2026-11-17-cursor-runtime.md
git commit -m "$(cat <<'EOF'
docs: record Cursor CLI spike for cursor runtime plan

EOF
)"
```

---

### Task 2: Schema — `cursor` + Grok infer

**Files:**
- Modify: `src/schema.ts`
- Test: `test/schema-cursor.test.ts`（新建）

**Interfaces:**
- Produces:
  - `export function isGrokModel(model: string | undefined): boolean`
  - `RUNTIMES` 含 `"cursor"`
  - `RUNTIME_EFFORTS.cursor: []`
  - `ModelTiersPartial` 含 `cursor?: string[]`
  - `inferRuntime`：Grok → `"cursor"`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { inferRuntime, isGrokModel, RUNTIME_EFFORTS, RUNTIMES } from "../src/schema.js";

describe("cursor schema", () => {
  it("lists cursor and accepts no efforts", () => {
    expect(RUNTIMES).toContain("cursor");
    expect(RUNTIME_EFFORTS.cursor).toEqual([]);
  });

  it("isGrokModel and inferRuntime", () => {
    expect(isGrokModel("grok-4.7")).toBe(true);
    expect(isGrokModel("Grok-4.6")).toBe(true);
    expect(isGrokModel("composer-2.5")).toBe(false);
    expect(isGrokModel("auto")).toBe(false);
    expect(inferRuntime("grok-4.7")).toBe("cursor");
    expect(inferRuntime("opus")).toBe("claude-code");
    expect(inferRuntime("gpt-5")).toBe("codex");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run test/schema-cursor.test.ts`

- [ ] **Step 3: Minimal implementation in `src/schema.ts`**

```ts
export const RUNTIMES = ["claude-code", "codex", "cursor"] as const;

export function isGrokModel(model: string | undefined): boolean {
  return !!model && model.trim().toLowerCase().startsWith("grok");
}

export const RUNTIME_EFFORTS: Record<Runtime, readonly Effort[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  cursor: [],
};

export function inferRuntime(model: string | undefined): Runtime | undefined {
  if (!model) return undefined;
  const m = model.trim().toLowerCase();
  if (/^(claude|anthropic|opus|sonnet|haiku|fable|best|default|opusplan)\b/.test(m) || m.includes("claude")) return "claude-code";
  if (/^(gpt|codex|o\d)/.test(m) || m.includes("codex")) return "codex";
  if (isGrokModel(m)) return "cursor";
  return undefined;
}

// ModelTiersPartial 加上：
// cursor: z.array(z.string().trim().min(1)).optional(),
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run test/schema-cursor.test.ts`

- [ ] **Step 5: Commit**（僅當使用者已要求執行 plan）

```bash
git add src/schema.ts test/schema-cursor.test.ts
git commit -m "$(cat <<'EOF'
feat: add cursor runtime and grok inferRuntime

EOF
)"
```

---

### Task 3: Validate — cursor 必須 grok model

**Files:**
- Modify: `src/validate.ts`
- Test: `test/validate-cursor.test.ts`（新建）或擴充既有 validate 測試

**Interfaces:**
- Consumes: `isGrokModel`、`RUNTIME_EFFORTS`
- Produces: 載入錯誤——`runtime: cursor` 無 model；model 非 grok；fallback `cursor` 無／非 grok model；effort 在 cursor 上文案正確

- [ ] **Step 1: Write the failing test**

用 `makeEnv`／既有 helper 寫出最小 `project.yaml` 片段（或直接建 `ResolvedProject` fixture，跟專案既有 validate 測試同一風格）。至少覆蓋：

1. `runtime: cursor` 無 `model` → error  
2. `runtime: cursor, model: sonnet` → error（非 grok）  
3. `runtime: cursor, model: grok-4.7, effort: high` → error，訊息含 `not supported by cursor`  
4. fallback `{ runtime: cursor }` 無 model → error  
5. `model: grok-4.7` 無 runtime → resolve／validate 為 cursor 且 ok  

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

在 `validateProject` agent 迴圈（runtime／effort 檢查附近）加入：

```ts
if (a.runtime === "cursor") {
  if (!a.model?.trim()) err(`Agent "${a.name}": runtime cursor requires a grok-* model.`);
  else if (!isGrokModel(a.model)) err(`Agent "${a.name}": runtime cursor only allows grok-* models (got "${a.model}").`);
}
```

effort 訊息：

```ts
if (a.effort && a.runtime) {
  const allowed = RUNTIME_EFFORTS[a.runtime];
  if (!allowed.includes(a.effort)) {
    err(
      allowed.length
        ? `Agent "${a.name}": effort "${a.effort}" is not supported by ${a.runtime} (use ${allowed.join(", ")}).`
        : `Agent "${a.name}": effort is not supported by ${a.runtime}.`,
    );
  }
}
```

在 `validateFallback`：若 `f.runtime === "cursor"`，要求 `isGrokModel(f.model)`（空字串不行）。

更新「has no runtime」提示字串，加入 `grok-*`。

- [ ] **Step 4: Run — expect PASS**；另跑 `npx vitest run test/validate*.test.ts`（或專案既有 validate 檔名）確保無回歸

- [ ] **Step 5: Commit**（僅當使用者已要求執行 plan）

---

### Task 4: `buildCursorInvocation` + 錯誤分類

**Files:**
- Create: `src/adapters/cursor.ts`
- Modify: `src/adapters/index.ts`
- Test: `test/adapters-cursor.test.ts`

**Interfaces:**
- Consumes: `WakeInput`、`applyShipToWake`、`writePolicy`、`repoDirFor`、`scratchCwd`、`runtimeEnv`、`ApprovalError`
- Produces:
  - `export function buildCursorInvocation(raw: WakeInput): Invocation`
  - `export function classifyCursorError(out: { code: number | null; stdout: string; stderr: string }): ErrorKind`
  - `export function writeCursorCliConfig(workDir: string, input: WakeInput): string`（回傳 config 路徑）

- [ ] **Step 1: Write the failing test**

```ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { buildCursorInvocation, classifyCursorError } from "../src/adapters/cursor.js";
import { ApprovalError } from "../src/approval-error.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const wake = (e: TestEnv, name: string, extra: Record<string, unknown> = {}) => {
  const project = e.project();
  const agent = { ...project.agents[name]!, runtime: "cursor" as const, model: "grok-4.7", effort: undefined };
  return {
    project,
    agent,
    workDir: path.join(e.root, "work", name),
    systemPrompt: "SYS",
    userPrompt: "USER",
    timeoutSec: 5,
    ...extra,
  };
};

describe("cursor adapter", () => {
  it("builds headless agent invocation with grok model and CURSOR_CONFIG_DIR", () => {
    env = makeEnv();
    const inv = buildCursorInvocation(wake(env, "fe-member"));
    expect(inv.cmd).toBe("agent");
    expect(inv.args).toEqual(expect.arrayContaining(["-p", "--force", "--trust", "--sandbox", "enabled", "--model", "grok-4.7", "--output-format", "stream-json"]));
    expect(inv.env?.CURSOR_CONFIG_DIR).toBe(path.join(env.root, "work", "fe-member"));
    expect(fs.existsSync(path.join(inv.env!.CURSOR_CONFIG_DIR!, "cli-config.json"))).toBe(true);
    expect(inv.args.join("\n")).toContain("SYS");
    expect(inv.args.join("\n")).toContain("USER");
  });

  it("passes --resume when sessionId set", () => {
    env = makeEnv();
    const inv = buildCursorInvocation(wake(env, "fe-member", { sessionId: "chat-1" }));
    const i = inv.args.indexOf("--resume");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(inv.args[i + 1]).toBe("chat-1");
  });

  it("refuses enrolled agents", () => {
    env = makeEnv();
    const w = wake(env, "fe-member");
    w.agent = { ...w.agent, enrolled: true };
    expect(() => buildCursorInvocation(w)).toThrow(ApprovalError);
    expect(() => buildCursorInvocation(w)).toThrow(/cannot use Cursor/);
  });

  it("classifies auth and rate limit", () => {
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "Unauthorized: not logged in" })).toBe("auth");
    expect(classifyCursorError({ code: 1, stdout: "", stderr: "429 Too Many Requests" })).toBe("rate_limit");
  });
});
```

（依 Task 1 spike 微調：prompt 在 args 還是 stdin。）

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `src/adapters/cursor.ts`**

要點：

```ts
// enrolled → throw new ApprovalError("INVALID_INPUT", `Approval-enrolled agent cannot use Cursor: ${agent.name}`);
// applyShipToWake
// mkdir workDir; writeCursorCliConfig
// args: ["-p", "--force", "--trust", "--sandbox", "enabled", "--workspace", repo, "--output-format", "stream-json"]
// + optional --model, --resume
// + combined prompt as final arg (or stdin per spike)
// env: { ...runtimeEnv(agent), CURSOR_CONFIG_DIR: workDir }
// parse/stream: extract text + sessionId from stream-json lines; classify on failure
```

`writeCursorCliConfig`：寫入至少：

```json
{
  "version": 1,
  "editor": { "vimMode": false },
  "permissions": {
    "allow": [],
    "deny": ["Write(<each deny path>)", ...]
  }
}
```

deny 來自 `writePolicy`（與 override policy）；`allow_web` 為 unset／`none` 時 deny `WebFetch(*)`；`fetch`／`search` 時按能力加 allow（搜尋若無對應 token，文件＋doctor 標未完整對應，deny 仍保留危險網域默認）。

- [ ] **Step 4: Wire `src/adapters/index.ts`**

```ts
case "cursor":
  return buildCursorInvocation(input);
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx vitest run test/adapters-cursor.test.ts`

- [ ] **Step 6: Commit**（僅當使用者已要求執行 plan）

---

### Task 5: Doctor + policy + approval premises

**Files:**
- Modify: `src/doctor.ts`、`src/policy.ts`、`src/doctor-approval-premises.ts`
- Test: 擴充 `test/doctor-approval-premises.test.ts`；新增或擴充 doctor／policy 測試

**Interfaces:**
- Consumes: `Runtime` 含 cursor
- Produces: probe `agent`；sandbox caps／notes；enrolled cursor premise error

- [ ] **Step 1: Failing tests**

1. `BINARY`／probe：`cursor` 使用 `agent`；help 含 `--output-format` → json yes；`--resume` → resume；`--sandbox` → sandbox；effort → `no`（無 flag）  
2. `sandboxCaps`：cursor 對 `network`／`local_binding`／`unix_sockets` 的套用表——v1 與 Codex 類似：`network` 有設定 → `"all"`（或 `"none"` 若不開），`localBinding: false`，`unixSockets: false`（文件標未套用）  
3. `agentPremiseChecks`：enrolled + cursor candidate → error 含 `Cursor`

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

`doctor.ts`：

```ts
const BINARY: Record<Runtime, string> = { "claude-code": "claude", codex: "codex", cursor: "agent" };
```

在 `probeRuntime` 加 `cursor` 分支（非 claude、非 codex）：

```ts
} else if (runtime === "cursor") {
  caps.json = has(h.out, /--output-format\b/);
  caps.resume = has(h.out, /--resume\b/);
  caps.sandbox = has(h.out, /--sandbox\b/);
  caps.effort = "no";
} else {
  // existing codex branch
}
```

（重構 if／else 時保持 claude／codex 行為不變；先跑既有 doctor 測試。）

`policy.ts`：`enforcementFor`／`sandboxNotes` 對 `cursor` 走「permissions + `--sandbox`；單一檔 deny 靠 permissions；network 等未套用則 note」——實作時對齊 Codex 的 post-hoc 說明語氣，改寫為 Cursor。

`doctor-approval-premises.ts`：

```ts
if (c.runtime === "codex" || c.runtime === "cursor") {
  out.push(err(`Approval-enrolled candidate uses ${c.runtime === "codex" ? "Codex" : "Cursor"}: ${at}`));
}
```

- [ ] **Step 4: Run relevant tests + `npm run typecheck`**

- [ ] **Step 5: Commit**（僅當使用者已要求執行 plan）

---

### Task 6: 使用者文件

**Files:**
- Modify: `docs/configuration.md`、`docs/configuration.zh-TW.md`、`docs/write-scope.md`、`docs/write-scope.zh-TW.md`（若英文 write-scope 存在）
- 跑：`npm run check:docs`（若專案有）

**Interfaces:**
- Produces: 文件寫明 `runtime: cursor | claude-code | codex`、Grok 範例、effort 不適用、enrolled 拒絕、permissions 邊界

- [ ] **Step 1: 更新 configuration 雙語** — 在 Agent 欄位 `runtime` 列加入 `cursor`；範例：

```yaml
agents:
  lead: { runtime: cursor, model: grok-4.7 }
```

說明：需 Cursor CLI（`agent`）與可使用 Grok 的帳號；`inferRuntime` 認 `grok-*`。

- [ ] **Step 2: 更新 write-scope** — 新增 Cursor 列：`--sandbox enabled` + `cli-config.json` deny；不如 Claude OS deny 細；guard 仍 post-hoc。

- [ ] **Step 3: `npm run check:docs` / `npm run typecheck`**

- [ ] **Step 4: Commit**（僅當使用者已要求執行 plan）

---

### Task 7: 回歸閘門

- [ ] **Step 1: 跑**

```bash
npm run typecheck
npx vitest run test/schema-cursor.test.ts test/adapters-cursor.test.ts test/validate-cursor.test.ts
npx vitest run test/adapters.test.ts test/doctor-approval-premises.test.ts test/fallback*.test.ts
```

（validate 測試檔名以 Task 3 為準。）

- [ ] **Step 2: 確認** approval-compat／stage3 baseline **未改** fixtures；若測試仍紅，僅允許既有已知紅項。

- [ ] **Step 3: Commit** 若尚有未提交文件／修正（僅當使用者已要求執行 plan）

---

## Spec coverage（self-review）

| Spec 節 | Task |
| --- | --- |
| §1–3 目標／邊界 | 全域 + Task 4–5 |
| §4 設定／白名單／effort | Task 2–3 |
| §5 Invocation／ship／parse | Task 1、4 |
| §6 permissions／sandbox／enrolled／guard | Task 4–5（guard 既有，不關） |
| §7 schema／doctor／docs | Task 2、5、6 |
| §8 測試 | 各 task TDD + Task 7 |
| §10 驗收 | Task 7 |

## Spike 結果

**環境：** `agent --version` → `2026.11.13-eacade1`（2026-11-17 探測）；`agent status` → 已 login。

### CLI flags（`agent --help`）

| Flag | 存在 | 備註 |
| --- | --- | --- |
| `-p` / `--print` | 是 | headless／腳本用；具工具／shell 權限（help 原文） |
| `--output-format <format>` | 是 | 僅搭配 `-p`：`text` \| `json` \| `stream-json`（預設 `text`） |
| `--stream-partial-output` | 是 | 僅 `-p` + `stream-json` |
| `--resume [chatId]` | 是 | 可選 chat id；另有 `--continue` |
| `--sandbox <mode>` | 是 | `enabled` \| `disabled` |
| `--workspace <path-or-name>` | 是 | 預設 cwd |
| `--trust` | 是 | 略過 workspace 信任提示 |
| `-f` / `--force` | 是 | `--yolo` 為別名 |
| `--model <model>` | 是 | 例：`grok-4.7`（實測可用） |
| effort | **無** | help 無 effort flag（doctor `caps.effort = "no"`） |

**Prompt 傳遞：** Usage 為 `agent [options] [command] [prompt...]`；`prompt` 為**位置引數**（可變長 `[prompt...]`），非必須 stdin。Task 4 以合併後 prompt 作為 `-p` 之後的最後一個（或多個）位置引數。

**其他（adapter 可能用到）：** `--add-dir`、`CURSOR_API_KEY`；config 目錄慣例為 `CURSOR_CONFIG_DIR`（見 plan／spec，本 spike 未再實測寫檔）。

### Live headless（已跑）

```bash
cd /tmp && agent -p "Reply with exactly: pong" --model grok-4.7 --output-format json --trust
```

**`--output-format json`（單行物件）：**

- `type`: `"result"`
- `subtype`: `"success"`
- `is_error`: boolean
- `result`: 助理文字（本測 `"pong"`）
- `session_id`: UUID（**釘死優先欄位**；輸出未見 `chatId`／頂層 `id`）
- `request_id`: UUID
- `duration_ms` / `duration_api_ms` / `usage`（含 token 統計）

**`--output-format stream-json`（NDJSON，每行一事件）：**

- 首行常見 `type: "system"`, `subtype: "init"`，含 `session_id`、`model`、`cwd`
- 中間 `type: "assistant"` → `message.content[].text` 或 `type: "thinking"` deltas
- 末行 `type: "result"`, `subtype: "success"`，含 `result`、`session_id`、`request_id`（與 json 模式同語意）
- **session id 擷取優先序（v1）：** `session_id`（各事件一致）→ 不採 `chatId`／`id`（本次實測無）

### Task 3／4 釘死項（摘要）

- Invocation：`agent -p --force --trust --sandbox enabled --workspace <repo> --output-format stream-json [--model <grok-*>] [--resume <session_id>] <combined-prompt>`
- Parse：讀 NDJSON；最終文字取最後一筆 `type==="result"` 的 `result`；串流可併用 `assistant`／`thinking` delta（可選）
- Session：persist `session_id`；resume 傳 `--resume <session_id>`
- Model CLI 值範例：`grok-4.7`（init 事件顯示帳號側名稱如 `Grok 4.7 256K High Fast`）
