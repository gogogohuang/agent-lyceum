# 依賴與發佈 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓依賴更新自動化，並在**不放棄 Node 20 支援**的前提下，把落後的依賴升到相容的最新版。

**Architecture:** 先加 Dependabot 與 CI 矩陣（Task 1），再逐一升級，一個依賴一個 PR（Task 2–5）。每個升級都以 `typecheck`、`test`、`build` 全過為準（Plan 01、04 完成後再加上 `lint`、`check:pack`）。

**Tech Stack:** npm、Dependabot、GitHub Actions。

**Spec:** `docs/specs/05-dependencies-release.md`

## 已驗證的事實（2026-10-07，在專案副本上實測，Node 22）

| 項目 | 結果 |
|---|---|
| `commander@15` | `engines.node >=22.12.0` → **與本專案 `engines >=20` 衝突，不採用**。`commander@14`（`>=20`）可用。 |
| `vitest@5` | `engines.node ^22.12 \|\| ^24 \|\| >=26` → **Node 20 不支援，不採用**。`vitest@4`（`^20 \|\| ^22 \|\| >=24`）為 Node 20 上的最高版本。`vitest@5` 另需自行安裝 `vite@8`（peer）。 |
| `zod@4.6.5` | 型別檢查 8 個錯誤，全部來自 5 處 `z.record(x)` 單參數用法（`src/run-store.ts:119,121,124`、`src/schema.ts:60,69`；另 3 個錯誤是它們的連鎖影響）；改成 `z.record(z.string(), x)` 後 0 錯誤、210 測試全過。 |
| `typescript@7.0.2` | 預設不再自動載入 `@types/*`，需在 `tsconfig.json` 加 `"types": ["node"]`；加上後 0 錯誤、210 測試全過。 |
| `@types/node` | 最新為 26；`engines.node >=20` 下應使用 `^20`，避免用到 Node 20 沒有的 API 仍通過型別檢查。 |

> `vitest@4` 與 `commander@14` 尚未在副本完整驗證；Task 2、3 的測試步驟就是驗證。若 `vitest@4` 失敗，退到 `vitest@^3`（`^18 \|\| ^20 \|\| >=22`）。

## Global Constraints

- `engines.node` 維持 `>=20`；不得為了新版依賴而提高。
- 舊的 `state.json` 與舊 `project.yaml` 在 zod 升級後仍必須能讀（Task 4 有專門測試）。
- 每個依賴一個 PR；PR 描述列出實際遇到的破壞性變更。
- 不自動發布、不自動 push。

---

### Task 1: Dependabot、CI 矩陣、`@types/node`

**Files:**
- Create: `.github/dependabot.yml`
- Modify: `.github/workflows/ci.yml`（矩陣）
- Modify: `package.json`、`package-lock.json`（`@types/node`）

- [ ] **Step 1: 建立 `.github/dependabot.yml`**

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 5
    groups:
      dev-minor-patch:
        dependency-type: development
        update-types: [minor, patch]
      runtime-minor-patch:
        dependency-type: production
        update-types: [minor, patch]
    ignore:
      # These majors require Node >=22; this package supports Node >=20.
      - dependency-name: commander
        versions: [">=15"]
      - dependency-name: vitest
        versions: [">=5"]
      - dependency-name: "@types/node"
        update-types: ["version-update:semver-major"]
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

- [ ] **Step 2: CI 矩陣加入 Node 24**

`.github/workflows/ci.yml`：`node: [20, 22]` 改為 `node: [20, 22, 24]`。

- [ ] **Step 3: `@types/node` 對齊最低支援版本**

Run: `npm i -D @types/node@^20 && npm run typecheck && npm test`
Expected: 全 PASS（若出現只存在於 Node 22 的 API 的型別錯誤，代表程式其實用了 Node 20 沒有的 API，需修正而不是退回）

- [ ] **Step 4: Commit**

```bash
git add .github/dependabot.yml .github/workflows/ci.yml package.json package-lock.json
git commit -m "chore(deps): add Dependabot, test on Node 24, pin @types/node to the Node 20 floor"
```

---

### Task 2: vitest ^4

**Files:** `package.json`、`package-lock.json`

- [ ] **Step 1: 升級**

Run: `npm i -D vitest@^4`
Expected: 安裝成功。若 npm 回報 peer 衝突（需要特定 `vite`），依訊息一併安裝它要求的 `vite` 範圍（只限 `engines` 含 Node 20 的版本，例如 `vite@^7`）。

- [ ] **Step 2: 驗證**

Run: `npm run typecheck && npm test && npm run build`
Expected: 全 PASS。特別留意 `test/process-runner.test.ts`、`test/cancel.test.ts`、`test/project-lock.test.ts`（會啟動子程序，對逾時與平行度較敏感）。

- [ ] **Step 3: 若有測試因逾時或平行度失敗**

先單獨重跑該檔確認是否穩定；若只在平行時失敗，才在 `vitest.config.ts` 的 `test` 內為該情況加設定，並在 PR 說明原因。不得為了通過而放寬斷言。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore(deps): vitest 4"
```

---

### Task 3: commander ^14

**Files:** `package.json`、`package-lock.json`；必要時 `src/cli.ts`、`test/cli.test.ts`

- [ ] **Step 1: 先記錄升級前的 CLI 行為基準**

Run:
```bash
npm run build
mkdir -p "$TMPDIR/cli-before" && for c in "--help" "run --help" "status --help" "clear" "bogus-command"; do f="$TMPDIR/cli-before/$(echo $c | tr ' ' '_').txt"; node dist/cli.js $c > "$f" 2>&1; echo "exit=$?" >> "$f"; done
```
Expected: `$TMPDIR/cli-before/` 下有 5 個檔案，每個結尾有 exit code。

- [ ] **Step 2: 升級**

Run: `npm i commander@^14`

- [ ] **Step 3: 驗證**

Run: `npm run typecheck && npm test && npm run build`
Expected: 全 PASS。`test/cli.test.ts` 涵蓋 exit code 與 `--json` 輸出。

- [ ] **Step 4: 與基準比對**

Run:
```bash
mkdir -p "$TMPDIR/cli-after" && for c in "--help" "run --help" "status --help" "clear" "bogus-command"; do f="$TMPDIR/cli-after/$(echo $c | tr ' ' '_').txt"; node dist/cli.js $c > "$f" 2>&1; echo "exit=$?" >> "$f"; done
diff -r "$TMPDIR/cli-before" "$TMPDIR/cli-after" && echo SAME
```
Expected: `SAME`。有差異時逐一判斷：說明文字的排版差異可接受並在 PR 說明；exit code 改變、或「原本接受的呼叫現在被拒絕」不可接受。後者通常是 commander 13 起對多餘引數預設報錯，用 `.allowExcessArguments()` 恢復舊行為，並在 `test/cli.test.ts` 加一個測試固定它。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/cli.ts test/cli.test.ts
git commit -m "chore(deps): commander 14"
```

---

### Task 4: zod ^4

**Files:**
- Modify: `src/run-store.ts:119,121,124`、`src/schema.ts:60,69`
- Create: `test/fixtures/legacy/state-v1.json`
- Test: `test/run-store.test.ts`、`test/config.test.ts`

- [ ] **Step 1: 在升級「之前」建立舊格式 fixture 與測試（先用 zod 3 通過）**

`test/fixtures/legacy/state-v1.json`（沒有 `schema_version`、`mail_layout`、`outcome` 的舊 run）：

```json
{
  "run_id": "20250101T000000000Z-legacy",
  "project": "demo",
  "started_at": "2025-01-01T00:00:00.000Z",
  "ended_at": "2025-01-01T00:05:00.000Z",
  "rounds": 3,
  "max_rounds": 30,
  "end_reason": "done",
  "sessions": { "lead": "sess-1" },
  "last_wake": { "lead": { "at": "2025-01-01T00:04:00.000Z", "ok": true } },
  "wakes": [{ "round": 1, "agent": "lead", "at": "2025-01-01T00:01:00.000Z", "duration_ms": 1000, "ok": true }]
}
```

在 `test/run-store.test.ts` 加入。讀取 `state.json` 的函式名稱以 `src/run-store.ts` 實際匯出為準：先執行 `grep -n "export function" src/run-store.ts`，下面以 `loadRunState(runDir)` 代稱，實際名稱不同就換成實際名稱。檔頭若缺 `fs`、`os`、`path`、`fileURLToPath` 的 import 就補上：

```ts
it("still reads a state.json written before schema_version existed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-legacy-"));
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    fs.copyFileSync(path.join(here, "fixtures", "legacy", "state-v1.json"), path.join(dir, "state.json"));
    const s = loadRunState(dir);
    expect(s?.mail_layout).toBe("legacy");
    expect(s?.rounds).toBe(3);
    expect(s?.sessions).toEqual({ lead: "sess-1" });
    expect(s?.wakes).toHaveLength(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

在 `test/config.test.ts` 加入「沒有 `dispatcher:` 區塊的舊專案檔仍可解析」：

```ts
it("resolves an old project file that has no dispatcher block", () => {
  const env = makeEnv();
  try {
    env.editProjectYaml((t) => t.replace(/\ndispatcher:[\s\S]*?(?=\n\S|$)/, "\n"));
    const p = env.project();
    expect(p.dispatcher.max_rounds).toBeGreaterThan(0);
  } finally {
    env.cleanup();
  }
});
```

Run: `npx vitest run test/run-store.test.ts test/config.test.ts`
Expected: PASS（此時還是 zod 3，這兩個測試是升級的安全網；若正規表示式沒有匹配到內容，代表檔案原本就沒有 `dispatcher:` 區塊，測試仍然有效）

- [ ] **Step 2: 升級並確認出現預期的 8 個型別錯誤**

Run: `npm i zod@^4 && npx tsc -p tsconfig.json --noEmit --pretty false 2>&1 | grep -c 'error TS'`
Expected: `8`

- [ ] **Step 3: 修正 5 處 `z.record`**

```ts
// src/run-store.ts
sessions: z.record(z.string(), z.string()).optional(),   // 原 :119
last_wake: z.record(z.string(), z.any()).optional(),     // 原 :121
active: z.record(z.string(), z.any()).optional(),        // 原 :124
// src/schema.ts（兩處，原 :60 與 :69）
agents: z.record(z.string(), AgentPartial).default({}),
```

- [ ] **Step 4: 驗證**

Run: `npm run typecheck && npm test && npm run build`
Expected: 0 型別錯誤、全 PASS（含 Step 1 的兩個舊格式測試）。再 `grep -rn "\.errors\b\|\.format()\|\.flatten()" src`：目前唯一命中 `src/cli.ts:139` 的 `r.errors` 是自家回傳值，不是 ZodError，不需處理；若出現其他命中，檢查是否依賴 zod 3 的錯誤物件 API。

- [ ] **Step 5: 手動確認錯誤訊息仍可讀**

建立一個含錯誤欄位的 `project.yaml`（例如 `dispatcher: { max_rounds: -1 }`）後執行 `node dist/cli.js validate -p <name>`。
Expected: 仍以 `ERROR ...` 形式列出，且指出欄位名稱；若訊息格式與升級前不同，更新 `test/validate.test.ts` 內針對訊息的斷言，並在 PR 說明差異。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/run-store.ts src/schema.ts test
git commit -m "chore(deps): zod 4 (z.record takes a key schema); keep reading pre-v2 state and old project files"
```

---

### Task 5: typescript ^7

**Files:** `package.json`、`package-lock.json`、`tsconfig.json`

- [ ] **Step 1: 升級並確認預期的錯誤**

Run: `npm i -D typescript@^7 && npx tsc --version && npx tsc -p tsconfig.json --noEmit --pretty false 2>&1 | grep -c 'error TS'`
Expected: `Version 7.x`；錯誤數約 145，絕大多數是 `TS2591: Cannot find name 'process' / 'node:fs' / 'Buffer'`（因為不再自動載入 `@types/node`）。

- [ ] **Step 2: 明確指定型別套件**

`tsconfig.json` 的 `compilerOptions` 加入 `"types": ["node"],`。

Run: `npm run typecheck && npm run build && npm test`
Expected: 0 錯誤、全 PASS。

- [ ] **Step 3: 確認輸出相容**

Run: `npm run build && node dist/cli.js --help | head -3`
Expected: CLI 可執行。若 Plan 01 已完成，再跑 `npm run check:pack`，檔案數應與升級前相同（升級前先記錄一次）；`declaration: true` 產生的 `.d.ts` 不得變多或變少。

- [ ] **Step 4: 確認 plugin 型別檢查仍通過（Plan 01 完成後）**

Run: `npm run typecheck:plugin`
Expected: 無錯誤（`tsconfig.ci.json` 已設 `"types": []`，不受影響）

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore(deps): typescript 7 (list @types/node explicitly)"
```

## Self-Review

- Spec 需求 1 → Task 1；2 的順序 → Task 2（vitest）、3（commander）、4（zod）、5（typescript），`@types/node` → Task 1；3（矩陣加 24）→ Task 1；4（每個 PR 全綠）→ 各 Task 的驗證步驟。
- 與 spec 的差異：spec 寫 `commander` 12→15、`vitest` 2→5；實測兩者要求 Node >=22.12，與 `engines >=20` 衝突，改升 14 與 4，並寫進 Dependabot 的 ignore，避免它自動開出不相容的 PR。`docs/specs/05-dependencies-release.md` 已同步更新。
- Task 4 Step 1 讀取 `state.json` 的函式名稱需執行時對照原始碼確定，已寫明查找指令；其餘程式碼完整。
- 名稱一致：`typecheck:plugin`、`check:pack` 來自 Plan 01，只在 Task 5 以「Plan 01 完成後」的條件使用。
