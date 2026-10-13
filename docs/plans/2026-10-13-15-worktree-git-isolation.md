# dispatcher 不信任 agent 可寫的 git 狀態 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dispatcher 對 agent worktree 的每一次 git 呼叫都釘住 `GIT_DIR`／`GIT_COMMON_DIR`／`GIT_WORK_TREE` 並關掉 fsmonitor 與 hooks，使 agent 改寫 `.git` 指標或 `commondir` 也無法讓 dispatcher 在沙箱外執行它的程式碼。

**Architecture:** `src/worktree.ts` 新增唯一入口 `agentGit(ws, args, env?)`；`AgentWorkspace` 增加 `commonDir`，`gitDir`／`commonDir` 在 worktree 建立當下存進 meta 檔，之後只讀 meta。以 worktree 為目標或來源的函式改收 `AgentWorkspace`。`src/policy.ts` 對 Claude 加幾個 `denyWrite` 作為縱深防禦。

**Tech Stack:** TypeScript ESM、Node `child_process`、真實 `git`（測試用本地 repo，不用網路）、Vitest、Biome。不新增依賴。

**Spec:** `docs/specs/15-worktree-git-isolation.md`（決議 1–8、驗收 15.4）

## Global Constraints

- Node >=20，macOS 與 Linux。不新增依賴。
- 沒有 agent worktree 的 run（預設 `max_concurrent_runs: 1` 且 `max_parallel: 1`）完全不經過 `agentGit`，行為與測試期望不變；既有測試除了簽名改動外不改期望值。
- 使用者自己 repo 的 git 呼叫（`git(top, …)`、`snapshotHead`、`worktree add/remove/prune`、`branch -D`）不動（spec 決議 8）。
- `gitDir`／`commonDir` 只能在 worktree 剛建立、agent 尚未執行之前取得，之後只讀 `${root}.json` meta；任何時候都不得再用 `cwd: <agent 目錄>` 讓 git 自己探索，也不得對 agent 目錄呼叫 `toplevel()`。
- 測試用真實 git 重現攻擊，且每個攻擊變體都有「沒釘住就會觸發」的對照組，證明測試不是空的。
- 每個 Task 結束時 `npm run typecheck`、`npm test`、`npm run lint` 都要通過。
- 新增文字不得寫死任何 agent 名稱。Commit 訊息結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`（執行時若系統提示給了別的 attribution，以系統提示為準）。發版不在這份計畫內。

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/worktree.ts` | `commonDir`、meta 擴充與舊 meta fallback、`agentGit`、所有 agent 目錄的 git 呼叫改走它、簽名改動 |
| `test/worktree-isolation.test.ts`（新增） | 攻擊夾具與對每個函式的回歸測試（含對照組） |
| `test/worktree.test.ts`、`test/integration.test.ts`、`test/run-cleanup.test.ts` | 簽名調整 |
| `src/run-session.ts`、`src/run-cleanup.ts` | 傳 `AgentWorkspace` 而不是 `.root` |
| `src/policy.ts` + `test/adapters.test.ts` | Claude 的縱深 deny、Codex 不加 |
| `README.md`、`README.zh-TW.md`、`docs/specs/15-…`、`docs/specs/README.md` | 說明與狀態 |

---

### Task 1: 釘住的 git 入口，並讓所有 agent 目錄的 git 呼叫經過它

**Files:**
- Modify: `src/worktree.ts`
- Modify: `src/run-session.ts`、`src/run-cleanup.ts`（只因簽名改動）
- Create: `test/worktree-isolation.test.ts`
- Modify: `test/worktree.test.ts`、`test/integration.test.ts`、`test/run-cleanup.test.ts`（只因簽名改動）

**Interfaces:**
- Produces（Task 2 與文件依賴）：
  - `AgentWorkspace` 增加 `commonDir: string`（絕對路徑，使用者 repo 的 git common dir）。
  - `export function agentGit(ws: Pick<AgentWorkspace, "root" | "gitDir" | "commonDir">, args: string[], env?: NodeJS.ProcessEnv): string`（失敗時丟例外，同 `git()`）與 `tryAgentGit(…)`（失敗回 `undefined`）。
  - 簽名：`commitWorkspace(ws: AgentWorkspace, message: string)`、`snapshotBase(project, runId, n, from?: AgentWorkspace)`、`integrateAgentChanges(project, changes, target?: AgentWorkspace)`、`inspectWorkspace(project, runId, agent, target?: AgentWorkspace)`。`collectAgentChanges(ws, owns)`、`finishLeadBranch(ws, …)` 簽名不變（本來就收 `AgentWorkspace`）。
  - `WorkspaceMeta` 增加 `gitDir?: string; commonDir?: string`（舊 meta 沒有）。

核心程式（`agentGit` 的形狀，放在 `git()` 與 `tryGit()` 之後）：

```ts
/** What the dispatcher never lets git read from a place an agent can write: hooks, fsmonitor, external diff and textconv programs. */
const PINNED_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

/**
 * Run git against an agent's worktree without letting git discover anything from it. The agent may rewrite the worktree's `.git`
 * pointer file and its per-worktree git dir (`commondir`, `config.worktree`); git is told exactly where the git dir, the common dir
 * and the work tree are, so none of that is read. `ws.gitDir` and `ws.commonDir` come from the workspace meta, recorded before
 * the agent ever ran in it.
 */
export function agentGit(ws: Pick<AgentWorkspace, "root" | "gitDir" | "commonDir">, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return git(ws.commonDir, [...PINNED_CONFIG, ...args], { ...env, GIT_DIR: ws.gitDir, GIT_COMMON_DIR: ws.commonDir, GIT_WORK_TREE: ws.root });
}
```
（cwd 用 `ws.commonDir`，一個 agent 寫不進去的目錄，而不是 `ws.root`。實作者要確認 git 在 `GIT_DIR`＋`GIT_WORK_TREE` 都設了時不依賴 cwd；若某些指令需要 cwd 在 work tree 內，改用 `ws.root` 作 cwd 但仍保留三個環境變數，並在報告說明。）

- [ ] **Step 1: 寫失敗的測試（攻擊夾具與回歸測試）**

建立 `test/worktree-isolation.test.ts`。夾具用真實 git 建一個 repo、一個 bare remote，用 `prepareAgentWorkspace` 建 worktree，再執行攻擊。用 `makeEnv`／`initGitRepo`／`makeParallel`／`makeConcurrent`／`write`（`test/helpers.ts`）建專案；沿用 `test/worktree.test.ts` 的 import 與清理方式。攻擊與標記檔：

```ts
/** A script that records that it ran. Everything an attacker would run outside the sandbox ends up writing the marker. */
function markerScript(dir: string, marker: string): string {
  const f = path.join(dir, `run-${path.basename(marker)}.sh`);
  fs.writeFileSync(f, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 });
  return f;
}

/** Variant A: point `commondir` at a fake common dir whose config and hooks run the marker script. */
function plantCommondir(ws: AgentWorkspace, marker: string, scratch: string): void {
  const fake = path.join(scratch, "fake-common");
  fs.cpSync(ws.commonDir, fake, { recursive: true });
  const script = markerScript(scratch, marker);
  fs.appendFileSync(path.join(fake, "config"), `\n[core]\n\tfsmonitor = ${script}\n`);
  fs.mkdirSync(path.join(fake, "hooks"), { recursive: true });
  for (const h of ["post-commit", "post-checkout", "post-merge", "pre-push"]) fs.copyFileSync(script, path.join(fake, "hooks", h));
  fs.writeFileSync(path.join(ws.gitDir, "commondir"), `${fake}\n`);
}

/** Variant B: rewrite the worktree's `.git` pointer file to a fake git dir. */
function plantPointer(ws: AgentWorkspace, marker: string, scratch: string): void { /* build a fake gitdir like A, then write `gitdir: <fake>` into path.join(ws.root, ".git") */ }

/** Variant C: the user enabled extensions.worktreeConfig; the agent writes config.worktree. */
function plantWorktreeConfig(ws: AgentWorkspace, marker: string, scratch: string): void { /* git config extensions.worktreeConfig true in the main repo (trusted setup), then write core.fsmonitor and core.hooksPath into path.join(ws.gitDir, "config.worktree") */ }
```
（把 B、C 的函式主體補完，寫法同 A。）對照組：在同一個被攻擊的 worktree 上，用**未釘住**的 `git` 以 `cwd: ws.root` 執行 `git status`（觸發 fsmonitor）與 `git commit`（觸發 `post-commit`），斷言標記檔**出現**（證明攻擊本身有效；若某平台的 git 版本不吃某變體，該變體的對照組與測試一起 `it.skipIf`，並在報告說明）。測試本體：對每個變體 × 下列每個函式，攻擊後呼叫該函式，斷言標記檔**不存在**且函式結果與未被攻擊時相同：`commitWorkspace`、`collectAgentChanges`、`inspectWorkspace`、`finishLeadBranch`、`prepareAgentWorkspace`（對既有 worktree 再呼叫，走 `status`／`reset --hard` 路徑，需讓 base 改變且 worktree 乾淨）、`integrateAgentChanges(project, changes, leadWorkspace)`、`snapshotBase(project, runId, n, leadWorkspace)`。另加：

- meta 檔 `${root}.json` 記有 `gitDir` 與 `commonDir`，且與建立當下 `git rev-parse --absolute-git-dir` 一致。
- 舊 meta（手動刪掉那兩個欄位）：`existingAgentWorkspace` 能在剛好一個 `<commonDir>/worktrees/*/gitdir` 符合時還原；把另一個 admin 目錄的 `gitdir` 檔改成同一個路徑造成兩個符合時，丟出說明性錯誤（不猜）；沒有任何符合時同樣丟錯。
- 預設路徑：`max_concurrent_runs: 1`、`max_parallel: 1` 的一次完整 run 不呼叫 `agentGit`（用 `vi.spyOn` 或對模組出口計數；做不到就以「不建立任何 worktree」斷言代替並說明）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/worktree-isolation.test.ts`
Expected: FAIL（`agentGit`／`commonDir` 不存在、簽名不符；對照組本身應已通過）。

- [ ] **Step 3: 實作**

1. `AgentWorkspace` 加 `commonDir`；`WorkspaceMeta` 加 `gitDir?`、`commonDir?`。
2. `prepareAgentWorkspace`：新建 worktree 後，**立刻**在 `top`（使用者 repo）取 `commonDir = git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"])`，`gitDir = git(top, ["worktree", "list", "--porcelain"])` 解析不可靠時，改用建立前後 `<commonDir>/worktrees/` 的差集（新出現的那一個目錄）；兩者擇一，選不會讀 agent 目錄、也不會誤認的那種，寫進 `${root}.json`。重用既有 worktree 時只讀 meta（舊 meta 走決議 4 的 fallback，找到後把 `gitDir`／`commonDir` 補寫回 meta）。`describeWorkspace` 不得再呼叫 `git(root, …)`。
3. 實作 `agentGit` / `tryAgentGit`（如上），並把 `git(root, …)`、`tryGit(root, …)`、`execFileSync("git", …, { cwd: root | top })`（凡 `root`／`top` 指向 agent 目錄者）全部改走它：`prepareAgentWorkspace` 的 `status`／`rev-parse`／`reset`、`commitWorkspace`、`collectAgentChanges`（`diff --raw`、`show`）、`inspectWorkspace`、`finishLeadBranch`（`diff --name-only`、`diff --binary`）、`integrateAgentChanges` 的 target 路徑（`diff`、`hash-object`、`apply`、`show`）、`snapshotBase` 的 `from` 路徑（`read-tree`、`add -A`、`write-tree`、`commit-tree`、`update-ref`）。`diff` 類指令補 `--no-ext-diff --no-textconv`。需要時重寫 helper（如 `blobAt`、`workingBlob`）讓它們收 `AgentWorkspace | undefined`，`undefined` 表示使用者 repo、走原本的 `git(top, …)`。
4. 簽名改動（見 Interfaces），並更新 `src/run-session.ts`（`integrateAgentChanges(project, changes, this.leadSpace)`、`snapshotBase(…, this.leadSpace)`）與 `src/run-cleanup.ts`（`inspectWorkspace(…, leadWs)`），以及三個既有測試檔裡傳字串根目錄的呼叫。
5. 完成後 `grep -n "cwd: \(root\|top\)" src/worktree.ts` 與 `grep -n "git(root\|tryGit(root" src/worktree.ts`：不得剩下任何指向 agent 目錄的呼叫（若 `top` 是使用者 repo 的呼叫保留，在報告逐條列出）。

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run typecheck && npx vitest run && npm run lint`
Expected: PASS（全部測試；`fatal: path 'ignored.log' exists ...` 是既有測試的預期 stderr）。

- [ ] **Step 5: Commit**

```bash
git add src/worktree.ts src/run-session.ts src/run-cleanup.ts test
git commit -m "fix(worktree): drive every git call into an agent's worktree through a pinned git dir, common dir and work tree"
```

---

### Task 2: 縱深防禦、文件與整體驗證

**Files:**
- Modify: `src/policy.ts`、`test/adapters.test.ts`
- Modify: `README.md`、`README.zh-TW.md`、`docs/specs/15-worktree-git-isolation.md`、`docs/specs/README.md`

**Interfaces:**
- Consumes: Task 1 的 `AgentWorkspace.gitDir`／`root`。
- Produces: 無（政策與文件）。

- [ ] **Step 1: 寫失敗的測試**

在 `test/adapters.test.ts`（沿用該檔建立有 worktree 的專案與 `buildClaudeSettings`／Codex 參數的方式）加：

```ts
  it("denies a Claude agent writes to the git pointers inside its own worktree, and Codex gets no per-file rule", () => {
    // build a project whose lead has a worktree (project.workspaces[lead] = { root, dir, gitDir, ... }) the same way the neighbouring worktree tests do
    const settings = buildClaudeSettings(project, agent) as { sandbox: { filesystem: { denyWrite: string[] } } };
    const deny = settings.sandbox.filesystem.denyWrite;
    expect(deny).toEqual(expect.arrayContaining([
      path.join(ws.root, ".git"),
      path.join(ws.gitDir, "commondir"),
      path.join(ws.gitDir, "config.worktree"),
      path.join(ws.gitDir, "gitdir"),
    ]));
    // Codex: writable_roots unchanged by this rule (it cannot forbid single files); the pinned git of Task 1 is what protects it
  });
```
並確認：沒有 worktree 的 agent 的 `denyWrite` 與現在完全相同。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/adapters.test.ts`
Expected: FAIL。

- [ ] **Step 3: 實作**

`src/policy.ts` 的 `writePolicy`：有 worktree（`ws`）時，把上述四個路徑加進 `deny`（沿用該函式既有的 `addDeny` 寫法；它們只能在 Claude 以 `denyWrite` 表達，Codex 的 `enforcementFor` 對這幾項不宣稱 `os` 等級，不要讓 `doctor` 把它們算成 Codex 的防護）。確認既有的 `enforcement` 測試與 `doctor` 輸出沒有因此改變（若有，只調整與這四項直接相關的期望並在報告說明）。

文件（中英結構一致，`npm run check:docs` 要過）：
- `README.md`／`README.zh-TW.md` 的「已知缺口」（Known gaps）段落：加一條說明 agent 在 worktree 內可寫 git 指標檔，因此 dispatcher 對 worktree 的所有 git 呼叫都釘住 git dir／common dir／work tree 並關閉 fsmonitor 與 hooks；Claude 另外禁止寫那幾個檔案，Codex 無法禁止單一檔案、只靠釘住。如果該段落已有關於 worktree 的缺口敘述，改寫它而不是重複。
- `docs/specs/15-worktree-git-isolation.md` 第 3 行狀態改為 `狀態：已實作（計畫：docs/plans/2026-10-13-15-worktree-git-isolation.md）。`；`docs/specs/README.md` 表格在 14 之後加一列：

```
| [15](15-worktree-git-isolation.md) | dispatcher 不信任 agent 可寫的 git 狀態 | 高 | 中（簽名改動） | [plan](../plans/2026-10-13-15-worktree-git-isolation.md) |
```

- [ ] **Step 4: 整體驗證**

Run: `npm run typecheck && npm test && npm run lint && npm run check:docs && npm run build`
Expected: 全部通過；`git status` 乾淨（`dist/` 不被追蹤）。

- [ ] **Step 5: Commit**

```bash
git add src/policy.ts test/adapters.test.ts README.md README.zh-TW.md docs/specs/15-worktree-git-isolation.md docs/specs/README.md
git commit -m "fix(policy): forbid a Claude agent to rewrite the git pointers in its worktree; document the isolation"
```

---

## Self-Review

**Spec coverage（對照 `docs/specs/15-worktree-git-isolation.md` §15.2）**

| 決議 | Task |
|---|---|
| 1 單一入口 `agentGit` | Task 1 步驟 3 |
| 2 釘住三個環境變數與 `-c`、`--no-ext-diff` | Task 1 步驟 3 |
| 3 建立當下記錄 `gitDir`／`commonDir`，之後只讀 meta | Task 1 步驟 2、測試「meta 記有…」 |
| 4 舊 meta fallback，剛好一個符合 | Task 1 步驟 2、測試「舊 meta」 |
| 5 簽名改收 `AgentWorkspace` | Task 1 Interfaces、步驟 4 |
| 6 Claude 縱深 deny | Task 2 |
| 7 預設路徑不變 | Global Constraints、Task 1 測試「預設路徑」 |
| 8 使用者 repo 呼叫不動 | Global Constraints、Task 1 步驟 5 |

驗收 §15.4：攻擊變體 A／B／C／D → Task 1 夾具（D 的 `diff.external` 放進 A 的假 config）；各函式 → Task 1 測試；meta、fallback、policy、預設路徑 → 對應測試。

**Placeholder 掃描**：B、C 兩個攻擊夾具函式的主體以註解描述其內容，實作者照 A 的寫法補完；Task 2 的 adapters 測試以「照鄰近 worktree 測試的方式建專案」描述，因為該檔的輔助函式簽名需讀原檔。

**型別一致性**：`agentGit(ws, args, env?)`、`tryAgentGit`、`AgentWorkspace.commonDir`、`WorkspaceMeta.gitDir?/commonDir?`（Task 1 定義）；簽名清單在 Interfaces 與 Self-Review 一致。

**已知取捨（執行者需知）**
- 縱深 deny 只對 Claude 有效；Codex 沒有「禁止單一檔案」的機制，只靠釘住。
- 釘住只管 dispatcher 這一側；agent 在沙箱內自己跑的 git 不受影響（它本來就受沙箱限制）。
- `gitDir` 的取得方式（`worktree add` 前後差集 vs `worktree list`）由實作者選較不會誤認的那一種，並在報告說明理由。
