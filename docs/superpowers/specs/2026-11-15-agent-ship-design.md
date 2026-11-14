# 單一 agent `ship`（CLI；Claude Code + Codex）

日期：2026-11-15　狀態：改為 CLI 主路徑（雙 runtime）

## 1. 目標

在 **單一 agent 的 wake** 內提供 `ship`：一次套用多檔 exact search/replace、跑 verify、失敗則逐 byte 還原。目標是變乾淨、減少返工；不改 mail／dispatcher／`done`。

**入口是本套件 CLI**（`agent-lyceum ship`），不是 Turnpack、不是外部 MCP。Claude Code 與 Codex **共用同一 CLI 與同一 `runShip` 核心**。

## 2. 非目標

- Turnpack／第三方套件
- MCP 作為正式入口
- `pack`／`batch`
- 強制所有寫入走 ship
- 模糊 matching（僅 exact + 可選 `replace_all`）

## 3. 契約

### 3.1 `runShip`（核心）

與先前相同：root、edits、verify、deny、timeout；寫入中途失敗必須 rollback；拒 symlink／`.git`／deny；非 UTF-8 拒寫。

### 3.2 Wake 掛載（雙 runtime）

1. `ship` 開啟且能解析 verify 時，在 agent `workDir` 寫入 `ship-session.json`：`{ root, verify, deny, timeoutSec }`。
2. `applyShipToWake` 把**完整 CLI 命令**附加到 system prompt（Claude 與 Codex 皆然）。
3. Agent 以 Bash／同等執行：`… ship --session <abs> <<'EOF'` + `{"edits":[…]}`。
4. 請求 body **不可**帶 `verify`；只使用 session 內指令。
5. Policy wake（tidy 等）不寫 session。
6. Claude：`--add-dir` 含 workDir，方便讀 session；**不**把 workDir 加進 Codex `writable_roots`（避免 session 被寫爛）。

### 3.3 CLI

`agent-lyceum ship --session <file> [--edits <file>]`：stdin 或檔案為 edits JSON；exit 0 僅 `SHIPPED_AND_VERIFIED`。

## 4. 安全

- deny 來自 `writePolicy`；verify 固定於 session。
- Agent 仍可用 Edit 繞過；ship 是「用對時變乾淨」，不是強制沙箱替代。
- verify／shell 風險與 agent 既有 Bash 同類，文件需揭露。
