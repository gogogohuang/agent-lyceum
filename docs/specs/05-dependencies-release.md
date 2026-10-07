# 05 依賴與發佈

狀態：已實作並提交於分支 `chore/05-dependencies … chore/05e-typescript-7`（PR #40）。

## 現況

- 已具備：Trusted Publishing（OIDC）、`npm publish --provenance`、`prepublishOnly` 跑 typecheck / test / build、`scripts/release.sh`。**不需要再補 provenance。**
- 落後的依賴（`npm outdated`）：`commander` 12→15、`zod` 3→4、`vitest` 2→5、`typescript` 5.9→7、`@types/node` 22→26。`npm audit --omit=dev` 為 0 漏洞，所以沒有急迫性。
- **實測修正（2026-10-07）：** `commander@15` 與 `vitest@5` 都要求 Node >=22.12，和 `engines >=20` 衝突，因此目標版本改為 `commander@^14`、`vitest@^4`；`typescript@7` 需在 tsconfig 明確加 `"types": ["node"]`；`zod@4` 只需修 5 處 `z.record`。細節見 `docs/plans/2026-10-07-05-dependencies-release.md`。

## 需求

1. **自動追蹤更新：** 新增 `.github/dependabot.yml`，npm 與 github-actions 兩個生態系，每週一次，依賴更新分組（dev 一組、runtime 一組），避免 PR 洪水。
2. **升級順序，一次一個、各自一個 PR：**
   1. `vitest`→`^4`（只影響測試；先確認 `test/fixtures` 的程序樹測試在新版仍穩定）
   2. `commander`→`^14`（影響 CLI 解析；檢查 `cli.test.ts` 與 exit code、`--json` 輸出不變）
   3. `zod`（3→4 有破壞性變更；schema 在 `src/schema.ts`、`run-store.ts`、`config.ts`；先確認舊 `state.json` 與舊 `project.yaml` 仍可解析，這是硬性條件）
   4. `typescript`（最後；`moduleResolution: NodeNext` 行為需複測）
   - `@types/node` 維持與 `engines.node` 最低版本（20）相容的主版本，**不跟最新**；改為 `@types/node@^20`，避免用到 Node 20 沒有的 API 卻通過型別檢查。
3. **`engines` 與 CI 矩陣一致：** 目前矩陣是 Node 20、22，而發佈用 Node 24。矩陣加入 24。
4. 升級後每個 PR 都要通過既有 CI 與 `docs/specs/01` 新增的 pack 檢查。

## 驗收

- 每個升級 PR：`typecheck`、`lint`、`test` 全過；說明中列出實際的破壞性變更與處理方式。
- zod 升級 PR：附一個以舊版建立的 `state.json` / `project.yaml` fixture 的讀取測試。

## 不做

- 不一次升級全部依賴。
- 不為了新版 TypeScript 而放棄 Node 20 支援。
