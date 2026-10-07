# 01 測試與 CI

## 問題

- `vitest.config.ts` 排除 `plugins/**`，因為 plugin 測試 import 只存在於 Claude Code 內的 `claude-code/testing`。結果 `plugins/status-monitor/hooks/summary.test.ts` 與 `register.tsx`（234 行）完全不在 CI 內，status 解析邏輯壞了也不會被發現。
- CI 沒有檢查 plugin 的型別（`plugins/status-monitor/tsconfig.json` 存在但沒人跑）。
- CI 最後一步 `npm run build` 與 `npm ci` 觸發的 `prepare` 重複；也沒有確認發佈內容。

## 目標

1. `summary.ts` 的邏輯測試在 CI 執行。
2. plugin 的型別檢查在 CI 執行。
3. 發佈內容有自動檢查。

## 需求

1. 確認 `summary.ts` 與 `summary.test.ts` 是否真的依賴 `claude-code`。若 `summary.ts` 是純函式：
   - 測試只 import `summary.ts`，不 import `claude-code/testing`。
   - 依賴 `claude-code/testing` 的測試（若有）移到獨立檔名（例如 `*.mod.test.ts`），維持排除。
2. `vitest.config.ts` 改為排除 `plugins/**/*.mod.test.ts`，而不是整個 `plugins/**`。
3. （2026-10-07 修正：`register.tsx` 依賴 Claude Code 產生且被 gitignore 的型別，CI 無法檢查，所以只檢查 `summary.ts`、`summary.test.ts` 與 `types/index.d.ts`，使用 `tsconfig.ci.json`。）新增 script `typecheck:plugin`：`tsc -p plugins/status-monitor/tsconfig.json --noEmit`；`types/index.d.ts` 已提供 `claude-code` 型別宣告，應可直接通過。`typecheck` 串接兩者，或 CI 分開跑。
4. CI 新增 `npm pack --dry-run --json`，驗證 tarball 只含 `dist/**`、`package.json`、`README*`、`LICENSE`，不含 `.map`、`test/`、`plugins/`。以簡單 shell 斷言即可，不新增依賴。
5. 移除 CI 最後重複的 `npm run build`，或改成明確註解它是在驗證乾淨 build（二選一）。

## 驗收

- 故意改壞 `summary.ts` 的一個分支，`npm test` 會失敗。
- 故意在 `register.tsx` 製造型別錯誤，CI 會失敗。
- 在 `package.json` 的 `files` 加入多餘路徑，pack 檢查會失敗。
- 既有 210 個測試仍全數通過。

## 不做

- 不 mock 整個 Claude Code mod runtime。
- 不在 CI 跑需要真實 `claude` / `codex` 的端對端測試（沿用 README 對 `doctor` 的說明）。
