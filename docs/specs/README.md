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
| [07](07-concurrent-runs.md) | 同專案多 task 併發 | 中 | 高 | [plan](../plans/2026-10-07-07-concurrent-runs.md) |
| [09](09-human-in-the-loop.md) | 人工問答 | 中 | 中 | [plan](../plans/2026-10-08-09-human-in-the-loop.md) |
| [10](10-memory-tidy.md) | 記憶整理 | 中 | 中 | [plan](../plans/2026-10-08-10-memory-tidy.md) |
| [11](11-solo-agent.md) | 單獨呼叫 agent | 中 | 中 | [plan](../plans/2026-10-08-11-solo-agent.md) |
| [12](12-flatten-subcommands.md) | 收掉巢狀子指令 | 低 | 低（破壞舊寫法） | [plan](../plans/2026-10-12-12-flatten-subcommands.md) |
| [13](13-status-monitor-visual.md) | status-monitor 圖形化面板 | 中 | 低（只加欄位） | [plan](../plans/2026-10-13-13-status-monitor-visual.md) |
| [14](14-open-pr.md) | run 結束時開 PR | 中 | 低（預設不變） | [plan](../plans/2026-10-13-14-open-pr.md) |
| [15](15-worktree-git-isolation.md) | dispatcher 不信任 agent 可寫的 git 狀態 | 高 | 中（簽名改動） | [plan](../plans/2026-10-13-15-worktree-git-isolation.md) |
| [16](16-task-names-and-reopen.md) | task 名稱與重開已完成的 run | 中 | 中 | [plan](../plans/2026-10-14-16-task-names-and-reopen.md) |
| [17](17-run-shared-memory.md) | task 接續用的共享 memory | 中 | 中（write guard） | [plan](../plans/2026-10-14-17-run-shared-memory.md) |
| [18](18-command-consolidation.md) | 合併頂層指令（10 → 6） | 中 | 中（破壞相容） | 見 spec 18.11 |

建議順序：01 → 02 → 04（只做 tsconfig 與 lint）→ 03 → 04（重構）→ 05 → 06。

共通限制（沿用 `docs/plans/2026-10-06-agent-lyceum-improvements.md`）：Node >=20、macOS/Linux、不新增非必要依賴、舊 run 與舊 `project.yaml` 必須可讀、破壞相容性時更新中英文 README。
