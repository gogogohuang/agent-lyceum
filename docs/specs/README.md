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
| [19](19-open-concurrency.md) | 零設定並行（移除 owns 與併發設定） | 高 | 高（並行、run 鎖、相容） | — |
| [20](20-llm-fallback.md) | LLM 備援（主要模型失敗時切換備用） | 中 | 中（錯誤分類、權限一致性） | [plan](../plans/2026-10-16-20-llm-fallback.md) |
| [21](21-launcher-exit.md) | wrapper 消失時取消 run／call／tidy | 中 | 低（只在 wrapper 底下武裝） | — |
| [22](22-context-continuity-fixes.md) | context 連續性修正（C 類處置、重做脈絡） | 中 | 中（prompt 與 attempt 編號） | — |
| [23](23-dynamic-instances.md) | 同角色動態多實例（lead 標 `parallel: true`） | 中 | 高（state v3、路由重播、memory 寫入範圍） | — |
| [24](24-model-tiers.md) | 模型分級（`model` 是上限，lead 在 task 標 `tier`） | 中 | 中（fallback 順序、重複信判定、各模型分開 session） | — |
| [25](25-sandbox-allowances.md) | 每個 agent 的 sandbox 放寬（`sandbox.write`／`network`／`local_binding`） | 中 | 中（受保護路徑檢查、Codex 網路全有全無、fallback 拒絕） | — |
| [26](26-lead-parked-session.md) | Claude lead 在回合之間留下同一個行程 | 無（不做） | 高（行程生命週期、與成員批次互斥） | — |

建議順序：01 → 02 → 04（只做 tsconfig 與 lint）→ 03 → 04（重構）→ 05 → 06。

共通限制（沿用 `docs/plans/2026-10-06-agent-lyceum-improvements.md`）：Node >=20、macOS/Linux、不新增非必要依賴、舊 run 與舊 `project.yaml` 必須可讀、破壞相容性時更新中英文 README。
