# 預設從 remote 開分支 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 有 commit 且 ref 是 `files` 的 git repo，新 run 在借得到工作目錄時從 `origin` 的預設分支開 `agent-lyceum/<run-id>/<lead>` 並在專案資料夾切過去；借不到才為 lead 開 worktree。

**Architecture:** `resolveRemoteBase` 只負責基準 commit 與 push URL。`planWorkspace` 回傳執行期 plan（checkout 仍是 `{ mode: "worktree", leadWorktree: false, taskBranch }`）。CLI 負責鎖的降級。`RunSession` 把有 `taskBranch` 的 state 存成 `workspace_mode: "checkout"`、schema 4，不讓執行期的 `"worktree"` 寫回去。分支的建立、提交、清除、推送各自一個函式，HEAD 檢查都讀 state 的 `task_branch`。

**Tech Stack:** TypeScript、NodeNext、vitest、現有 `src/worktree.ts` 的 git 呼叫與 `PINNED_CONFIG`。

**Spec:** `docs/superpowers/specs/2026-11-27-checkout-branch-design.md`

## Global Constraints

- 沒有 `origin` 的預設分支時，維持現況：lead worktree 從本地 `HEAD` 切。`shared`（非 git、無 commit、reftable）不 fetch、不開任務分支。
- 本地 `main`／`master` 的 ref 不移動。checkout 結束後 HEAD 留在 `task_branch`。
- 執行期不新增 `WorkspaceMode`。持久化 `workspace_mode` 才是 `"checkout" | "worktree" | "shared"`。
- `STATE_SCHEMA_VERSION` 升到 4。只有 checkout run 寫 4。非 checkout 新 run 仍是 2；開 instances 仍升到 3。版本已是 4 時 `routing().enable` 不寫 3。
- fetch：`GIT_TERMINAL_PROMPT=0`、ssh `BatchMode=yes`、逾時 60 秒、不停 hooks。失敗不讓 run 失敗。
- `origin_url` 是 `git remote get-url --push origin` 的結果，不是 `remote.origin.url`。
- `task_branch` 一旦寫下就不從當下的 lead 重算。印出的 `git merge` 用 `task_branch`。
- 快照前 HEAD 不是 `task_branch`：`lead_failed`。整合前不是：`refusedIntegration`。提交前不是：不提交、不設 `result_branch`。
- 推送只套 `PINNED_CONFIG`。`core.sshCommand`、`credential.helper`、`gh` 內部的 git 這次不固定。
- 不加跨專案鎖。不為 checkout 新做 pinned 的 `snapshotBase`／`integrateAgentChanges`。
- 接續不要求工作目錄乾淨。`task_sent !== true` 的 checkout 不進入 run，由 `RunSession` 拒絕，不能只寫在 `continueRun`。
- 中止的啟動在取得該 run 的鎖之後才刪目錄或切回 `checkout_from`。切回失敗則留下 state、HEAD、分支，不第二次切換。
- 程式風格：雙引號、分號、相對 import 加 `.js`。`npm run lint` 須過。
- 英文與繁中文件成對更新。
- **Commit：** 僅在使用者明確要求執行本 plan 且要求 commit 時，才在 task 末 commit。
- 不 bump version、不寫 changelog，除非使用者另要求。

## File Structure

| File | Responsibility |
| --- | --- |
| `src/worktree.ts` | `resolveRemoteBase`、`planWorkspace` 的新欄位、`checkoutLeadBranch`、`finishCheckoutBranch`、export `PINNED_CONFIG`、重切條件 |
| `src/project-lock.ts` | export `CheckoutBusyError` |
| `src/run-store.ts` | `workspace_mode` 加 `"checkout"`；`task_branch`、`base_ref`、`base_sha`、`origin_url`、`checkout_from`、`task_sent`；`STATE_SCHEMA_VERSION = 4` |
| `src/cli.ts` | 鎖 busy 或取鎖後條件失敗時改取 worktree 鎖。中止啟動的處理放在取鎖之後 |
| `src/run-session.ts` | 有 `taskBranch` 時持久化 checkout／schema 4；`task_sent` 在任務信送出後才設；接續時沒送出就拒絕；快照／整合／提交的 HEAD 檢查；`routing().enable` 不降 4 |
| `src/run-cleanup.ts` | lead 任務分支以尖端是否為 HEAD 祖先決定刪除；留著的分支印在保留清單 |
| `src/open-pr.ts` | push 套 `PINNED_CONFIG`；可傳入 base，有 `base_ref` 時不用 `defaultBase` |
| `test/worktree.test.ts` | 基準、plan、重切、提交前的 HEAD |
| `test/project-lock.test.ts`（既有則擴充，沒有就建） | `CheckoutBusyError` |
| `test/run-cleanup.test.ts`（既有檔名以 repo 為準） | 尖端判斷 |
| `docs/how-it-works.md` 與 `.zh-TW.md`、`docs/commands.md` 與 `.zh-TW.md`、`docs/configuration.md` 與 `.zh-TW.md` | 行為說明 |

---

### Task 1: 基準 commit 與 plan 意圖

**Files:**
- Modify: `src/worktree.ts`（`WorkspacePlan`、新增 `resolveRemoteBase`、`planWorkspace`）
- Test: `test/worktree.test.ts`

**Interfaces:**
- Consumes: 現有 `isolationBlocker`、`tryGit`、`dirtyPaths`
- Produces:

```ts
export interface RemoteBase {
  ref: string;
  sha: string;
  originUrl?: string;
}

export interface WorkspacePlan {
  mode: "shared" | "worktree";
  leadWorktree: boolean;
  taskBranch?: string;
  baseRef?: string;
  baseSha?: string;
  originUrl?: string;
  reason?: string;
}

export function resolveRemoteBase(dir: string, run?: GitRunner): RemoteBase | undefined
```

`GitRunner` 沿用檔內已有的 git 呼叫形狀；預設 runner 對 `fetch` 設 `GIT_TERMINAL_PROMPT=0`、`GIT_SSH_COMMAND` 含 `BatchMode=yes`，並以 60 秒逾時。逾時與非 0 都當成失敗，不丟出。

- [ ] **Step 1: 寫會失敗的測試**

在 `test/worktree.test.ts` 的 `planWorkspace` describe 加上。`initGitRepo` 沒有 origin，既有「clean repo → leadWorktree true」保持不動。

```ts
function addOrigin(repo: string, sha: string, head = "main"): void {
  git(repo, "update-ref", `refs/remotes/origin/${head}`, sha);
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${head}`);
  git(repo, "remote", "add", "origin", "https://example.invalid/repo.git");
}

it("borrows a clean checkout sitting on the remote base", () => {
  env = makeEnv();
  initGitRepo(env.repo);
  const sha = git(env.repo, "rev-parse", "HEAD");
  addOrigin(env.repo, sha);
  const plan = planWorkspace(env.project(), undefined, { fetch: () => ({ ok: false }) });
  expect(plan.mode).toBe("worktree");
  expect(plan.leadWorktree).toBe(false);
  expect(plan.taskBranch).toBeUndefined();
  expect(plan.baseRef).toBe("origin/main");
  expect(plan.baseSha).toBe(sha);
  expect(plan.originUrl).toBe("https://example.invalid/repo.git");
});
```

`taskBranch` 在這個 task 還不填：分支名含 run id，而 `planWorkspace` 目前沒有 run id。run id 由 CLI 在建立 run 目錄後補上 `agent-lyceum/<run-id>/<lead>`。plan 只決定「借得到」：`leadWorktree: false` 且有 `baseSha`。Task 4 用這兩個欄位組 `task_branch`。

同檔再加：

- 工作目錄有未提交檔案、或本地 `main` 比 `origin/main` 多一個 commit、或 `symbolic-ref HEAD` 是 `refs/heads/agent-lyceum/r/lead`：`leadWorktree: true`，`baseSha` 仍是 remote 那顆。
- 沒有 `origin/HEAD` 但有 `origin/main` 與 `origin/master`：用 `main`。只有 `origin/develop` 且 `origin/HEAD` 指向它：用 `develop`。兩者都沒有：`leadWorktree: true` 且沒有 `baseRef`，`reason` 含沒有 remote 基準。
- fetch runner 被呼叫時收到的 env 含 `GIT_TERMINAL_PROMPT=0`。runner 回失敗時仍用本地 `origin/main`。
- resume `workspace_mode: "checkout"` 且 `task_branch: "agent-lyceum/r/lead"`：`{ mode: "worktree", leadWorktree: false, taskBranch: "agent-lyceum/r/lead" }`，不讀現在的 lead 名。
- 非 git、無 commit、reftable 仍是 `shared`，且 fetch runner 不被呼叫。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/worktree.test.ts -t "borrows a clean checkout"`

Expected: FAIL，`plan.leadWorktree` 為 `true` 或 `baseRef` 為 `undefined`。

- [ ] **Step 3: 實作**

`resolveRemoteBase` 的順序寫死：`origin/HEAD`、否則 `origin/main`、否則 `origin/master`。`git remote get-url --push origin` 失敗則 `originUrl` 省略。

`planWorkspace` 第三個參數 `{ fetch?: GitRunner }` 只給測試。正式路徑用預設 runner。新 run：

- `isolationBlocker` 有值：現況 `shared`。
- 沒有 `RemoteBase`：現況 `{ mode: "worktree", leadWorktree: true, reason }`。
- 有 `RemoteBase` 且四條件都成立（乾淨、`HEAD^{commit}` 等於 `sha`、symbolic-ref 不是 `refs/heads/agent-lyceum/*` 或根本沒有 symbolic-ref、呼叫端尚未傳入「已有 checkout 鎖」）：`{ mode: "worktree", leadWorktree: false, baseRef, baseSha, originUrl }`。
- 否則 `{ mode: "worktree", leadWorktree: true, baseRef, baseSha, originUrl, reason }`。

鎖是否被佔用由 Task 2 的 CLI 決定，不在 `planWorkspace` 裡取鎖。`planWorkspace` 增加可選 `checkoutHeldByOther: boolean`，預設 false。CLI 傳入。

resume：`workspace_mode === "checkout"` 回傳 `leadWorktree: false` 與 state 的 `task_branch`。其餘 resume 行為不變。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/worktree.test.ts`

Expected: PASS。既有「沒有 origin 的 clean repo → leadWorktree true」仍 PASS。

- [ ] **Step 5: Commit**（僅當使用者已要求執行本 plan 且要求 commit）

```bash
git add src/worktree.ts test/worktree.test.ts
git commit -m "$(cat <<'EOF'
Decide checkout vs worktree from the remote base.

EOF
)"
```

---

### Task 2: checkout 鎖可辨識，忙或變髒就改走 worktree

**Files:**
- Modify: `src/project-lock.ts`（`checkoutBusyError`）
- Modify: `src/cli.ts`（`run` 取鎖處，約 `takeLock` 呼叫）
- Test: 既有 lock 測試檔；沒有 `CheckoutBusyError` 測試就加在該檔

**Interfaces:**
- Consumes: Task 1 的 `WorkspacePlan`（`leadWorktree === false` 且有 `baseSha` 表示意圖是借目錄）
- Produces:

```ts
export class CheckoutBusyError extends Error {
  readonly holder: LockInfo;
  constructor(holder: LockInfo, dir: string, reason: string)
}
```

- [ ] **Step 1: 寫會失敗的測試**

對 `checkoutBusyError` 的公開型別：佔用 checkout 的 holder 讓第二次 `acquireProjectLock(..., { checkout: true })` 丟出 `CheckoutBusyError`，`instanceof` 為 true。訊息仍含 holder 的 run id。

CLI 行為用抽出的純函式測，避免啟動整個 commander：

```ts
export function lockForPlan(intended: WorkspacePlan, acquire: (checkout: boolean) => ProjectLease, recheck: () => boolean): { lease: ProjectLease; plan: WorkspacePlan }
```

- `recheck` 回 true：以 `checkout: true` 取得的 lease 與原 plan。
- `acquire(true)` 丟 `CheckoutBusyError`：改 `acquire(false)`，plan 變成 `leadWorktree: true`，`taskBranch` 刪掉，`baseRef`／`baseSha`／`originUrl` 保留。
- `acquire(true)` 成功但 `recheck` 回 false：先 `lease.release()`，再 `acquire(false)`，plan 同樣改成 lead worktree。
- 其他錯誤原樣丟出。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/project-lock.test.ts -t "CheckoutBusyError"`

Expected: FAIL，錯誤不是 `CheckoutBusyError`（若測試檔名不同，用 `rg -l "acquireProjectLock" test` 找到的那個檔）。

- [ ] **Step 3: 實作**

`checkoutBusyError` 改為 `throw new CheckoutBusyError(...)`。`cli.ts` 的新 run 在 `plan.leadWorktree === false && plan.baseSha` 時走 `lockForPlan`。`recheck` 再查一次：乾淨、HEAD 等於 `baseSha`、不在 `agent-lyceum/*`。改道原因在 stderr 印一行；run log 等 state 出現後由 Task 4 補。

`runTeam` 沒有傳 plan 時仍呼叫 `planWorkspace`。新 run 若得到借目錄意圖，在 `dispatcher.ts` 降為 `leadWorktree: true`（不借目錄）。resume 且 `workspace_mode === "checkout"` 不降級。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/project-lock.test.ts test/worktree.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**（僅當使用者已要求）

```bash
git add src/project-lock.ts src/cli.ts src/dispatcher.ts test/project-lock.test.ts
git commit -m "$(cat <<'EOF'
Fall back to a worktree lock when the checkout cannot be borrowed.

EOF
)"
```

---

### Task 3: state 持久化與未送出任務的拒絕

**Files:**
- Modify: `src/run-store.ts`（`STATE_SCHEMA_VERSION`、`RunState`、zod）
- Modify: `src/run-session.ts`（建構子兩處 `workspace_mode: wsMode`、`newRunState`、`routing().enable`）
- Test: `test/run-store` 既有測試與 `test/run-lifecycle.test.ts` 或新建 `test/checkout-state.test.ts`

**Interfaces:**
- Consumes: `WorkspacePlan.taskBranch`、`baseRef`、`baseSha`、`originUrl`
- Produces: `RunState` 選填欄位 `task_branch`、`base_ref`、`base_sha`、`origin_url`、`checkout_from`、`task_sent?: true`。`workspace_mode` 含 `"checkout"`。`STATE_SCHEMA_VERSION = 4`。

- [ ] **Step 1: 寫會失敗的測試**

```ts
expect(STATE_SCHEMA_VERSION).toBe(4);
expect(() => assertSupportedVersion(4, 3, "state.json")).toThrow(/schema_version 4/);
```

另測：給 `RunSession` 一個帶 `taskBranch` 的 plan 與已寫好的 schema 4 state（測法沿用 `test/run-lifecycle.test.ts` 的假 runtime，不真的喚醒）。建構子返回前（或第一次 `saveRunState` 的內容）：

- `workspace_mode` 是 `"checkout"`，不是 `"worktree"`
- `schema_version` 是 4
- `task_branch`、`base_ref`、`base_sha`、`origin_url`、`checkout_from` 仍在
- `task_sent` 在任務信寫入 lead inbox 之後才是 `true`

resume 同一份 state 但刪掉 `task_sent`：建構子丟錯，訊息含 `task_branch`，且不把 `end_reason` 設成 `idle`。`project.yaml` 的 lead 改名後，錯誤與之後的 HEAD 檢查仍用原來的 `task_branch`。

`routing().enable` 在 schema 4 的 state 上呼叫後，`schema_version` 仍是 4，`instances` 仍寫入。schema 2 的 state 仍變成 3。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/checkout-state.test.ts`

Expected: FAIL，`STATE_SCHEMA_VERSION` 仍是 3，或 session 把 mode 寫成 `worktree`。

- [ ] **Step 3: 實作**

`run-session.ts` 約 314 與 358 行：`plan.taskBranch` 存在時 `workspace_mode` 寫 `"checkout"`，否則維持 `wsMode`。新 run 不要用會重設 schema 的 `newRunState` 蓋掉已寫的 4；沿用該物件再補執行中欄位。`enable` 改成：

```ts
if (state.schema_version !== 4) state.schema_version = 3;
```

resume 且 `workspace_mode === "checkout"` 且 `task_sent !== true`：在取鎖的呼叫端之後才會進到 session；session 自己仍要拒絕（直接呼叫 `runTeam` 的路徑）。丟錯前不寫 `end_reason`。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/checkout-state.test.ts test/run-lifecycle.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**（僅當使用者已要求）

```bash
git add src/run-store.ts src/run-session.ts test/checkout-state.test.ts
git commit -m "$(cat <<'EOF'
Persist checkout runs as schema 4 without dropping the task branch.

EOF
)"
```

---

### Task 4: 切分支，以及中止的啟動

**Files:**
- Modify: `src/worktree.ts`（`checkoutLeadBranch`）
- Modify: `src/cli.ts` 或 `src/run-session.ts`（誰持有 run 鎖，誰在鎖內處理 `task_sent !== true`）
- Test: `test/worktree.test.ts`

**Interfaces:**
- Consumes: `baseSha`、`checkout_from`、`task_branch`、`CheckoutBusyError` 的鎖流程
- Produces:

```ts
export function checkoutLeadBranch(dir: string, branch: string, sha: string): { moved: boolean }
```

用 `git checkout -b <branch> <sha>`，不停 hooks。HEAD 是否移動用切換前後的 `symbolic-ref -q HEAD`，沒有則用 `rev-parse HEAD`，不看結束碼。

- [ ] **Step 1: 寫會失敗的測試**

在暫時 repo：

- 乾淨且 HEAD 等於 `sha`：之後 `branch --show-current` 是任務分支，`main` 的 sha 不變，HEAD 的 sha 仍是 `sha`。
- 分支已存在：丟錯，HEAD 不變，不用 `-B`。
- 裝一個失敗的 `post-checkout` hook，但 HEAD 已在新分支：回傳 `moved: true`。
- hook 失敗且 HEAD 未動：`moved: false`。

中止啟動（另測，鎖用既有 `acquireProjectLock`）：

- state 已寫、`task_sent` 沒有、分支不存在：另一個行程在**取得該 run 鎖之後**刪掉整個 run 目錄（含 `task.md`）。鎖仍被原行程持有時，第二個呼叫被 `heldError` 擋下，目錄還在。
- 分支尖端仍是 `base_sha`、目錄乾淨、HEAD 在任務分支：取鎖後切回 `checkout_from` 並刪 run 目錄。`checkout_from` 的分支已被刪：不切第二次，留下 state 與 HEAD，錯誤訊息含兩個名字。
- 任務分支已有自己的 commit：拒絕，不刪。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/worktree.test.ts -t "checkoutLeadBranch"`

Expected: FAIL，函式不存在。

- [ ] **Step 3: 實作**

CLI 在 `lockForPlan` 成功且仍是借目錄之後、送任務信之前：

1. 寫 schema 4 的 state（含 `task_branch`、`checkout_from`，無 `task_sent`）。
2. 呼叫 `checkoutLeadBranch`。
3. `moved === false`：釋放鎖，`fs.rm` 整個 run 目錄，丟錯。
4. 之後、任務信送出前失敗：嘗試 `git checkout <checkout_from>`。成功且新分支尖端仍是 `base_sha` 就刪分支，再刪整個 run 目錄。`checkout` 失敗：留下 state 與 HEAD，訊息含兩者，不再切一次。

`continueRun` 看到 checkout 且 `task_sent !== true`：先 `takeLock`。拿到鎖才做上面三種清理。拿不到鎖就讓現有的 `heldError` 發生。`task_sent === true` 但 HEAD 的 symbolic-ref 不是 `task_branch`：取鎖之後拒絕，印出 `task_branch`，不切換、不改成 worktree。`run --agent` 的 `task_branch` 用那個成員的名字，因為他就是該 run 的 lead。

任務信成功寫入 lead inbox 後才把 `task_sent: true` 存檔。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/worktree.test.ts test/checkout-state.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**（僅當使用者已要求）

```bash
git add src/worktree.ts src/cli.ts src/run-session.ts test/worktree.test.ts test/checkout-state.test.ts
git commit -m "$(cat <<'EOF'
Check out the task branch only after the run lock is held.

EOF
)"
```

---

### Task 5: 提交、快照與整合的 HEAD 檢查

**Files:**
- Modify: `src/worktree.ts`（export `PINNED_CONFIG`、`finishCheckoutBranch`）
- Modify: `src/run-session.ts`（`finishLead`、快照迴圈約 1474 行、`integrateMember`）
- Test: `test/worktree.test.ts`

**Interfaces:**
- Consumes: `PINNED_CONFIG`、`task_branch`、現有 `refusedIntegration`
- Produces:

```ts
export function finishCheckoutBranch(dir: string, branch: string, baseSha: string, message: string, patchFile: string): ResultBranch | undefined
```

回傳 `undefined` 表示 HEAD 不是 `refs/heads/<branch>`，呼叫端不設 `result_branch`。

- [ ] **Step 1: 寫會失敗的測試**

- HEAD 是任務分支且有未提交檔案：產生一個 commit，`main` 的 sha 不變，`lead.patch` 含該檔。index 沒差異時不產生新 commit，`files` 為 0。
- HEAD 被改到 `main`：回傳 `undefined`，`main` 上沒有新 commit。
- 提交使用的 git 引數含 `-c` `core.hooksPath=/dev/null` 與 `commit.gpgsign=false`（把 runner 注入 `finishCheckoutBranch`，與 `resolveRemoteBase` 同一種測試接法）。

session 層（假 runtime，沿用 lifecycle 測試）：

- 成員快照前把 HEAD 改離 `task_branch`：`end_reason` 是 `lead_failed`，`rounds` 不因空轉增加。
- 成員做完、整合前把 HEAD 改離：`blocked_integrations` 有該成員，lead 收到 failure，run 不把檔案寫進 `main`。
- 結束訊息裡的 `git merge` 用 `task_branch`，即使 `project.lead` 已改名。
- `waiting` 不呼叫 `finishCheckoutBranch`。
- checkout 的 verify 重複失敗不因 worktree 內容相同而提早停止（`leadSpace` 為空時既有的 `no-worktree`）。不要為了讓它提早停止去補一個假的 lead worktree。
- 不改 `pickBatch`。`mode === "worktree"` 時成員本來就會平行喚醒。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/worktree.test.ts -t "finishCheckoutBranch"`

Expected: FAIL，函式不存在。

- [ ] **Step 3: 實作**

`finishCheckoutBranch` 先 `symbolic-ref -q HEAD`。不符回 `undefined`。符則以 `PINNED_CONFIG` 在 `dir` 上 `add -A`，有 staged diff 才 `commit --no-verify`。訊息由 `finishLead` 現有的 trailers 組好傳入。`export const PINNED_CONFIG`。

`run-session.ts`：`leadWorktree === false` 且有 `task_branch` 時，`snapshotBase` 之前檢查 HEAD；不符則 `this.endReason = "lead_failed"` 並 break。`integrateMember` 的 try 裡先檢查，不符就 throw，讓現有 catch 走 `refusedIntegration`。`finishLead` 在沒有 `leadSpace` 但有 `task_branch` 時改呼叫 `finishCheckoutBranch`；`undefined` 只記 note。`say` 的 merge 指令用 `state.task_branch`。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/worktree.test.ts test/run-lifecycle.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**（僅當使用者已要求）

```bash
git add src/worktree.ts src/run-session.ts test/worktree.test.ts
git commit -m "$(cat <<'EOF'
Commit checkout runs only while HEAD is the task branch.

EOF
)"
```

---

### Task 6: worktree 的基準與 follow-up 重切

**Files:**
- Modify: `src/worktree.ts`（`recutLeadWorkspace`、`snapshotHead` 的呼叫端）
- Modify: `src/run-session.ts`（建立 lead worktree 時用 `baseSha`）
- Test: `test/worktree.test.ts` 既有 `recutLeadWorkspace` 測試

**Interfaces:**
- Consumes: `plan.baseSha`、`state.base_sha`、`state.result_branch.head`
- Produces: worktree run 在有 remote 基準時一併寫下 `base_ref`、`base_sha`、`origin_url`

- [ ] **Step 1: 寫會失敗的測試**

既有重切測試：成果已併入使用者 HEAD、HEAD 不在 `agent-lyceum/*` 時，新 worktree 的 base 是本地 HEAD，不是 run 的 `base_sha`。把 HEAD 切到 `agent-lyceum/other/lead`（乾淨、且 `resultHead` 仍是它的祖先）時，`recut` 為 false，原 worktree 還在。

另測：`prepareAgentWorkspace` 的 base ref 在 plan 有 `baseSha` 時是那顆 sha，不是當時的本地 HEAD。本地 HEAD 與 `baseSha` 不同時，啟動輸出含「這次 run 改在 worktree」或「本地尚未進入這顆 commit」兩者之一，依 HEAD 是否為 `agent-lyceum/*`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/worktree.test.ts -t "recut"`

Expected: FAIL，HEAD 在 `agent-lyceum/*` 時仍重切，或新 base 等於 `base_sha`。

- [ ] **Step 3: 實作**

`recutLeadWorkspace` 在重切前讀 `symbolic-ref -q HEAD`。是 `refs/heads/agent-lyceum/*` 則回傳 `{ ws, recut: false }`。否則維持現況：祖先檢查通過後 `snapshotHead`（本地 HEAD）。不要把 `base_sha` 傳進 `prepareAgentWorkspace` 當重切起點。`workspace_mode === "checkout"` 的 follow-up 不呼叫 `recutLeadWorkspace`。

新 run 的 lead worktree（`leadWorktree: true` 且 `baseSha` 有值）改為 `git update-ref refs/agent-lyceum/<run>/base-0 <baseSha>`，`prepareAgentWorkspace(..., baseSha)`。沒有 `baseSha` 時仍用 `snapshotHead`。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/worktree.test.ts test/worktree-isolation.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**（僅當使用者已要求）

```bash
git add src/worktree.ts src/run-session.ts test/worktree.test.ts
git commit -m "$(cat <<'EOF'
Keep follow-up recuts on the user's HEAD unless another task branch owns it.

EOF
)"
```

---

### Task 7: clear 看分支尖端

**Files:**
- Modify: `src/run-cleanup.ts`
- Test: 既有 cleanup 測試（`rg -l "planRunCleanup" test`）

**Interfaces:**
- Consumes: `state.task_branch`、`state.workspace_mode`、`state.result_branch`
- Produces: cleanup plan 的一項 `{ kind: "task-branch", branch, delete: boolean, reason? }`。`delete: false` 的項目進入既有的保留清單輸出。

- [ ] **Step 1: 寫會失敗的測試**

- `workspace_mode: "checkout"`，HEAD 的 symbolic-ref 就是 `task_branch`：plan 拒絕，理由含要先切走。
- HEAD 已離開，尖端是 HEAD 的祖先，且有 `result_branch`：該分支標記刪除。
- 尖端比 `result_branch.head` 多一個 commit：不刪。
- squash 情境：尖端不是 HEAD 祖先：不刪。
- 沒有 `result_branch`：不刪，保留清單的文字含分支名與「沒有已記錄的結果 commit」。
- `keepWorktrees: true`：不刪，保留清單含該分支。
- 成員 worktree 的未整合判斷對照 `result_branch.head`，不對照當時的 HEAD。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/run-cleanup.test.ts -t "task branch"`

檔名以 `rg` 結果為準。Expected: FAIL，plan 沒有這支分支。

- [ ] **Step 3: 實作**

在 `planRunCleanup` 讀 run state。`workspace_mode === "checkout"` 且 `task_branch` 有值時加入上述項目。刪除用既有的 `git branch -D`，只在 `delete: true` 且 HEAD 不是該分支時執行。成員 `inspectWorkspace` 的 `target` 改為對照 `result_branch.head` 的暫時比較，不對照使用者當時的 HEAD。沒有 `result_branch` 時對照 `task_branch` 尖端。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/run-cleanup.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**（僅當使用者已要求）

```bash
git add src/run-cleanup.ts test/run-cleanup.test.ts
git commit -m "$(cat <<'EOF'
Delete a checkout task branch only when its tip is already in HEAD.

EOF
)"
```

---

### Task 8: 開 PR 的 push URL 與 base

**Files:**
- Modify: `src/open-pr.ts`
- Modify: `src/run-session.ts`（`maybeOpenPr`）
- Test: 既有 open PR 測試（`rg -l "openPullRequest" test`）

**Interfaces:**
- Consumes: `PINNED_CONFIG`、`state.origin_url`、`state.base_ref`、`state.result_branch`
- Produces: `openPullRequest` 接受可選 `base?: string` 與 `pinnedGit?: string[]`。有 `base` 時不用 `defaultBase`。push 的 git 引數前綴是 `pinnedGit`。

- [ ] **Step 1: 寫會失敗的測試**

假 `CommandRunner`：

- `base: "develop"` 時 `gh pr create` 的 `--base` 是 `develop`，不呼叫 `gh repo view`。
- push 的 argv 含 `-c` 與 `core.hooksPath=/dev/null`。
- session 在推之前若 runner 的 `git remote get-url --push origin` 與 `origin_url` 不同：`pr.status === "skipped"` 或 note 含不推，且 `git push` 沒被呼叫。`remote.origin.url` 相同但 push URL 不同，仍不推。
- 沒有 `base_ref` 的 worktree run：仍走 `defaultBase`。
- checkout、`completed`、有檔案變更、`open_pr: true`：即使沒有 `leadSpace` 也會推 `result_branch.branch`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/open-pr.test.ts -t "pinned push"`

檔名以 `rg` 為準。Expected: FAIL，push argv 沒有 `hooksPath`。

- [ ] **Step 3: 實作**

`maybeOpenPr` 刪掉「沒有 `leadSpace` 就略過」這條對 checkout 的短路；沒有 `result_branch` 或 `files === 0` 才略過。有 `origin_url` 時先跑 push URL 比較。有 `base_ref` 時把 `origin/` 前綴去掉傳入 `base`。push 傳 `PINNED_CONFIG`。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/open-pr.test.ts test/run-lifecycle.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**（僅當使用者已要求）

```bash
git add src/open-pr.ts src/run-session.ts test/open-pr.test.ts
git commit -m "$(cat <<'EOF'
Open checkout pull requests from the recorded push URL and base.

EOF
)"
```

---

### Task 9: 文件

**Files:**
- Modify: `docs/how-it-works.md`、`docs/how-it-works.zh-TW.md`、`docs/commands.md`、`docs/commands.zh-TW.md`、`docs/configuration.md`、`docs/configuration.zh-TW.md`

**Interfaces:**
- Consumes: 以上任務的行為，不改程式

- [ ] **Step 1: 改六份文件**

每份都寫這四件事，英文與繁中成對、不互相增刪段落：

- 預設從 remote 的預設分支開 `agent-lyceum/<run-id>/<lead>`，人在專案資料夾。
- 目錄不乾淨、HEAD 不是那顆 commit、HEAD 已在 `agent-lyceum/*`、或已有 checkout run 時，lead 改走 worktree，基準仍是那顆 commit。沒有 remote 基準則從本地 HEAD 開 worktree。
- 結束後 HEAD 留在任務分支。接續時人必須還在 `task_branch`。
- 兩個專案共用一個 repo 沒有跨專案鎖。

`commands` 的 `clear` 段補：HEAD 正停在任務分支時拒絕；尖端還沒進目前 HEAD 時不刪。

- [ ] **Step 2: 跑文件檢查與相關測試**

Run: `npm run check:docs && npx vitest run test/worktree.test.ts test/worktree-isolation.test.ts test/checkout-state.test.ts test/run-lifecycle.test.ts test/run-cleanup.test.ts test/open-pr.test.ts && npm run lint`

`check:docs` 或 lint 的檔名若與上面測試檔名不一致，以 Task 2、7、8 實際採用的檔名為準。Expected: 全部 PASS。

- [ ] **Step 3: Commit**（僅當使用者已要求）

```bash
git add docs/how-it-works.md docs/how-it-works.zh-TW.md docs/commands.md docs/commands.zh-TW.md docs/configuration.md docs/configuration.zh-TW.md
git commit -m "$(cat <<'EOF'
Document borrowing the checkout from the remote default branch.

EOF
)"
```
