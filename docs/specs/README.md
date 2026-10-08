# 優化 spec 索引

2026-10-07 專案 review 的結論，依類別拆成獨立 spec。每份可單獨實作、單獨提交。

| 編號 | 類別 | 優先 | 風險 | Plan |
|---|---|---|---|---|
| [01](01-testing-ci.md) | 測試與 CI | 高 | 低 | [plan](../plans/2026-10-07-01-testing-ci.md) |
| [02](02-safety-guard.md) | 安全與保護機制 | 高 | 低 | [plan](../plans/2026-10-07-02-safety-guard.md) |
| [03](03-reliability-performance.md) | 可靠性與效能 | 中 | 中 | [plan](../plans/2026-10-07-03-reliability-performance.md) |
| [04](04-code-quality.md) | 程式品質與維護性 | 高（tsconfig）／中（重構） | 低／高 | [plan](../plans/2026-10-07-04-code-quality.md) |
| [05](05-dependencies-release.md) | 依賴與發佈 | 低 | 中 | [plan](../plans/2026-10-07-05-dependencies-release.md) |
| [06](06-documentation.md) | 文件 | 低 | 無 | [plan](../plans/2026-10-07-06-documentation.md) |
| [09](09-human-in-the-loop.md) | 人工問答 | 中 | 中 | [plan](../plans/2026-10-08-09-human-in-the-loop.md) |
| [10](10-memory-tidy.md) | 記憶整理 | 中 | 中 | [plan](../plans/2026-10-08-10-memory-tidy.md) |

建議順序：01 → 02 → 04（只做 tsconfig 與 lint）→ 03 → 04（重構）→ 05 → 06。

共通限制（沿用 `docs/plans/2026-10-06-agent-lyceum-improvements.md`）：Node >=20、macOS/Linux、不新增非必要依賴、舊 run 與舊 `project.yaml` 必須可讀、破壞相容性時更新中英文 README。
