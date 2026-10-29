# 放寬自己的專案目錄寫入範圍 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓每位成員可寫 `projects/<本專案>/agents/<自己>/` 與 `shared/common/`（含 `COMMON.md` 與 `records/`），其餘受保護路徑維持不可寫。

**Architecture:** 只改 `writePolicy` 的 `allowDirs`／`deny`／`readDirs`。兩個新目錄本身不含仍要拒絕的檔，Claude 與 Codex 共用這份清單。`mayEditProtected` 與 `checkRecords` 把這兩個目錄裡的改動視為授權。Prompt 與 write-scope 文件改成同一套規則。

**Tech Stack:** TypeScript ESM（import 結尾 `.js`）、vitest、biome、Node 20+。

**Spec:** `docs/superpowers/specs/2026-10-29-project-write-scope-design.md`

## Global Constraints

- repo 的 worktree 寫入範圍不變；使用者的主工作目錄仍然不寫。
- repo 的 `CLAUDE.md`／`AGENTS.md` 仍只有 `can_edit_agent_md` 的 lead 能改。交接筆記 `task-memory/<run>/_shared/` 仍只有 lead 能寫。
- 別人的 `agents/<別人>/`、記憶、inbox、outbox 維持拒絕。自己的 inbox 仍由 dispatcher 寫入。
- `project.yaml`、`runs/`、`locks/`、`worktrees/`、`cleanup/`、`team.yaml`、其他專案、全域 `agents/` 維持拒絕。
- 全域 `AGENT.md`（`~/agent-lyceum-config/agents/...`）留在 `deny`，除非原本的 `can_edit_agent_md` 已允許。
- `sandbox.write` 的 blanket ban 不變。這次是預設 `allowDirs`，不是 `sandbox.write`。網路、`local_binding`、`unix_sockets` 不改。
- 實例 2 以上拿到 `agents/<實例名>/`，不含角色的 `agents/<角色>/`；它們可以寫 `shared/common/`。
- `agents/<自己>/` 若含有別人的 `AGENT.md`、記憶、inbox 或 outbox，就不加入。

## 檔案結構

- 修改 `src/policy.ts`：新增 `projectAgentDir`、`projectCommonDir`、`ownAgentDirAllowed`；`writePolicy` 加入兩個目錄並調整 deny／readDirs；`mayEditProtected` 認得這兩個目錄。
- 修改 `src/guard.ts`：`checkRecords` 把本批任一 agent 視為授權。
- 修改 `src/prompt.ts`：規則與記憶句子改成與政策一致。
- 新增 `test/project-write-scope.test.ts`。
- 修改既有斷言：`test/adapters.test.ts`、`test/shared-memory.test.ts`、`test/project-records.test.ts`、`test/guard-concurrent-runs.test.ts`、`test/dispatcher.test.ts`、`test/solo.test.ts`。
- 重新產生 `test/fixtures/instances/*.policy.json`（`UPDATE_INSTANCES_FIXTURES=1`）。
- 修改 `docs/write-scope.md`、`docs/write-scope.zh-TW.md`、`docs/how-it-works.md`、`docs/how-it-works.zh-TW.md`。

---

### Task 1：writePolicy 加上兩個目錄

**Files:**
- Modify: `src/policy.ts`（`recordsDir` 上方的註解、`writePolicy`、檔尾新增三個函式）
- Test: `test/project-write-scope.test.ts`（新增）
- Modify: `test/adapters.test.ts`（約 60–70 行）、`test/shared-memory.test.ts`（約 45、51 行）、`test/project-records.test.ts`（約 100–110 行）、`test/solo.test.ts`（約 58–63 行）
- Modify: `test/fixtures/instances/*.policy.json`（用指令重生，不要手改）

**Interfaces:**
- Consumes: `ResolvedProject`、`ResolvedAgent`、`memoryDirs`、`inboxDir`、`outboxDir`。
- Produces:
  - `projectAgentDir(project: ResolvedProject, agentName: string): string` → `path.join(project.paths.agentsDir, agentName)`
  - `projectCommonDir(project: ResolvedProject): string` → `path.join(project.paths.shared, "common")`
  - `ownAgentDirAllowed(project: ResolvedProject, agent: ResolvedAgent): boolean`
  - `writePolicy` 的 `allowDirs` 在允許時含 `projectAgentDir(project, agent.name)`，並且一律含 `projectCommonDir(project)`。`records/` 不再只給 lead，也不再出現在非 lead 的 `readDirs`。

- [ ] **Step 1: 寫會失敗的測試**

新增 `test/project-write-scope.test.ts`：

```ts
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { synthesizeSlots } from "../src/instances.js";
import {
  commonFile,
  enforcementFor,
  ownAgentDirAllowed,
  projectAgentDir,
  projectCommonDir,
  recordsDir,
  repoInstructionFiles,
  writePolicy,
} from "../src/policy.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("project write scope", () => {
  it("a member may write agents/<self>/ and shared/common/, and may not write another agent's persona or the records deny", () => {
    env = makeEnv();
    const p = env.project();
    const member = p.agents["fe-member"]!;
    const pol = writePolicy(p, member);
    const own = projectAgentDir(p, "fe-member");
    const common = projectCommonDir(p);
    expect(pol.allowDirs).toContain(own);
    expect(pol.allowDirs).toContain(common);
    expect(pol.allowDirs).not.toContain(recordsDir(p));
    expect(pol.deny).not.toContain(commonFile(p));
    expect(pol.deny).not.toContain(recordsDir(p));
    expect(pol.readDirs).not.toContain(recordsDir(p));
    expect(pol.deny).toContain(member.agentMd);
    expect(pol.deny).toContain(p.agents["qa-member"]!.agentMd);
    expect(pol.deny).toContain(p.paths.config);
    expect(pol.deny).toContain(p.paths.runs);
    for (const f of repoInstructionFiles(p)) expect(pol.deny).toContain(f);
    expect(enforcementFor(p, member).writablePaths).toEqual(expect.arrayContaining([own, common]));
  });

  it("does not add agents/<self>/ when that directory contains another agent's memory", () => {
    env = makeEnv();
    const p = env.project();
    const dir = projectAgentDir(p, "fe-member");
    const poisoned = {
      ...p,
      agents: {
        ...p.agents,
        "qa-member": {
          ...p.agents["qa-member"]!,
          memory: { ...p.agents["qa-member"]!.memory, project: path.join(dir, "qa-memory") },
        },
      },
    };
    const member = poisoned.agents["fe-member"]!;
    expect(ownAgentDirAllowed(poisoned, member)).toBe(false);
    const pol = writePolicy(poisoned, member);
    expect(pol.allowDirs).not.toContain(dir);
    expect(pol.allowDirs).toContain(projectCommonDir(p));
  });

  it("instance 2 gets agents/<slot>/ and shared/common/, not the role directory", () => {
    env = makeEnv();
    const p = env.project();
    const agents = synthesizeSlots(p.agents, { roles: { "fe-member": ["fe-member--2"] } }, (slot) => path.join(p.paths.taskMemory, "run-1", slot));
    const slot = agents["fe-member--2"]!;
    const bound = { ...p, agents };
    const pol = writePolicy(bound, slot);
    expect(pol.allowDirs).toContain(projectAgentDir(p, "fe-member--2"));
    expect(pol.allowDirs).not.toContain(projectAgentDir(p, "fe-member"));
    expect(pol.allowDirs).toContain(projectCommonDir(p));
    expect(pol.deny).toContain(p.agents["fe-member"]!.agentMd);
  });

  it("a project-level AGENT.md inside agents/<self>/ is not denied", () => {
    env = makeEnv();
    const p = env.project();
    const projectMd = path.join(projectAgentDir(p, "fe-member"), "AGENT.md");
    const member = { ...p.agents["fe-member"]!, agentMd: projectMd };
    const bound = { ...p, agents: { ...p.agents, "fe-member": member } };
    const pol = writePolicy(bound, member);
    expect(pol.deny).not.toContain(projectMd);
    expect(pol.deny).toContain(p.agents.lead.agentMd);
  });
});
```

- [ ] **Step 2: 跑測試，確認失敗**

Run: `npx vitest run test/project-write-scope.test.ts`

Expected: FAIL。`ownAgentDirAllowed` 尚未匯出，或 `allowDirs` 不含 `shared/common`。

- [ ] **Step 3: 實作**

在 `src/policy.ts` 的 `recordsDir` 註解改成：每位成員都可寫，不再只限 lead。

在 `writePolicy` 之前加上：

```ts
export function projectAgentDir(project: ResolvedProject, agentName: string): string {
  return path.join(project.paths.agentsDir, agentName);
}

export function projectCommonDir(project: ResolvedProject): string {
  return path.join(project.paths.shared, "common");
}

function covers(dir: string, target: string): boolean {
  const root = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return target === dir || target.startsWith(root);
}

/** True when `agents/<name>/` does not contain another agent's persona, memory, inbox or outbox. */
export function ownAgentDirAllowed(project: ResolvedProject, agent: ResolvedAgent): boolean {
  const dir = projectAgentDir(project, agent.name);
  for (const other of Object.values(project.agents)) {
    if (other.name === agent.name) continue;
    const paths = [other.agentMd, inboxDir(project, other.name), outboxDir(project, other.name), ...memoryDirs(other)];
    if (paths.some((p) => covers(dir, p))) return false;
  }
  return true;
}
```

`writePolicy` 的 `allowDirs` 改成（拿掉 lead 專用的 `recordsDir`）：

```ts
  const ownDir = projectAgentDir(project, agent.name);
  const commonDir = projectCommonDir(project);
  const grantOwnDir = ownAgentDirAllowed(project, agent);
  const allowDirs = [
    ...memoryDirs(agent),
    ...(project.solo === "call" ? [] : [outboxDir(project, agent.name)]),
    ...(ws ? [ws.gitDir] : []),
    ...(shared && mayWriteShared ? [shared] : []),
    ...(grantOwnDir ? [ownDir] : []),
    commonDir,
    ...(agent.sandbox?.write ?? []).map(canonicalPath),
  ];
```

`addDeny` 改成略過這兩個新根裡的路徑：

```ts
  const grantedRoots = [...(grantOwnDir ? [ownDir] : []), commonDir];
  const addDeny = (p: string) => {
    if (!allowedFileSet.has(p) && !grantedRoots.some((d) => covers(d, p))) deny.push(p);
  };
```

刪掉 `if (!isLead) deny.push(recordsDir(project));`。

`readDirs` 拿掉非 lead 的 `recordsDir`：

```ts
    readDirs: [...(shared && !mayWriteShared ? [shared] : []), ...Object.values(agent.sharedMemory ?? {})],
```

- [ ] **Step 4: 改既有斷言**

`test/adapters.test.ts` 成員的 `allowDirs` 期望改成：

```ts
    expect(pol.allowDirs).toEqual([
      path.join(env.home, "agents/fe-member/memory"),
      path.join(p.paths.outboxRoot, "fe-member"),
      path.join(p.paths.agentsDir, "fe-member"),
      path.join(p.paths.shared, "common"),
    ]);
```

同一測試裡 `expect(pol.deny).toContain(commonFile(p));` 改成 `expect(pol.deny).not.toContain(commonFile(p));`。`agentMd` 仍 `toContain`（makeEnv 的人設在全域 `agents/`）。

`test/shared-memory.test.ts`：

```ts
    expect(member.readDirs).toEqual([dir]);
```

以及 run 外：

```ts
    expect(writePolicy(p, p.agents["fe-member"]).readDirs).toEqual([]);
```

`test/project-records.test.ts` 的「只有 lead 能寫 records」改成：

```ts
  it("every member may write shared/common, which contains the records", () => {
    env = makeEnv();
    const p = env.project();
    const lead = writePolicy(p, p.agents.lead);
    const member = writePolicy(p, p.agents["fe-member"]);
    expect(lead.allowDirs).toContain(projectCommonDir(p));
    expect(member.allowDirs).toContain(projectCommonDir(p));
    expect(member.deny).not.toContain(recordsDir(p));
    expect(member.readDirs).not.toContain(recordsDir(p));
  });
```

import 補上 `projectCommonDir`。

`test/solo.test.ts`：測試名稱改成 solo agent 可經 `allowDirs` 寫 `shared/common`。保留 `allowFiles` 不含 `commonFile` 的斷言，並加上：

```ts
    expect(pol.allowDirs).toContain(projectCommonDir(p));
```

import 補上 `projectCommonDir`。

- [ ] **Step 5: 重生 policy fixture**

Run: `UPDATE_INSTANCES_FIXTURES=1 npx vitest run test/instances-compat.test.ts`

Expected: PASS。diff 只出現在 `*.policy.json`：`allowDirs` 多了 `agents/<name>` 與 `shared/common`，`readDirs` 少了 `records`，`deny` 少了 `COMMON.md` 與 `records`。全域 `AGENT.md` 仍在 `deny`。若 diff 出現 repo 路徑或 `runs/` 從 deny 消失，停下來，不要提交。

- [ ] **Step 6: 跑測試**

Run: `npx vitest run test/project-write-scope.test.ts test/adapters.test.ts test/shared-memory.test.ts test/project-records.test.ts test/solo.test.ts test/instances-compat.test.ts`

Expected: PASS。`project-records` 裡「只有 lead 的 prompt 提到 records」這條仍會過（prompt 還沒改）。

- [ ] **Step 7: Commit**

```bash
git add src/policy.ts test/project-write-scope.test.ts test/adapters.test.ts test/shared-memory.test.ts test/project-records.test.ts test/solo.test.ts test/fixtures/instances
git commit -m "$(cat <<'EOF'
feat: let each member write their project agent dir and shared/common

EOF
)"
```

---

### Task 2：guard 把這兩個目錄的改動視為授權

**Files:**
- Modify: `src/policy.ts` 的 `mayEditProtected`（約 254 行）
- Modify: `src/guard.ts` 的 `checkRecords`（約 144–173 行）
- Modify: `test/shared-memory.test.ts`（約 96–155 行）
- Modify: `test/guard-concurrent-runs.test.ts`（約 14–48 行）
- Modify: `test/dispatcher.test.ts`（約 249 行）
- Test: `test/project-write-scope.test.ts`（加 guard 案例）

**Interfaces:**
- Consumes: Task 1 的 `projectAgentDir`、`projectCommonDir`、`writePolicy`。
- Produces: `mayEditProtected(project, agent, file): boolean`。檔案在 `allowFiles`，或在該 agent 已允許的 `agents/<自己>/`、`shared/common/` 裡，回傳 true。`checkRecords` 在 `running.length > 0` 時不還原，並把 `this.records` 更新成現況。

- [ ] **Step 1: 寫會失敗的測試**

在 `test/project-write-scope.test.ts` 加上：

```ts
import fs from "node:fs";
import { ProtectedGuard } from "../src/guard.js";
import { mayEditProtected } from "../src/policy.js";
import { bindRunProject } from "../src/run-store.js";
import { write } from "./helpers.js";

function bound() {
  return bindRunProject(env.project(), path.join(env.root, "run-1"), "run");
}

it("keeps a member's edit of COMMON.md, records, and a project-level AGENT.md", () => {
  env = makeEnv();
  const p = bound();
  const projectMd = path.join(projectAgentDir(p, "fe-member"), "AGENT.md");
  fs.mkdirSync(path.dirname(projectMd), { recursive: true });
  fs.writeFileSync(projectMd, "persona\n");
  const member = { ...p.agents["fe-member"]!, agentMd: projectMd };
  const project = { ...p, agents: { ...p.agents, "fe-member": member } };
  expect(mayEditProtected(project, member, commonFile(project))).toBe(true);
  expect(mayEditProtected(project, member, projectMd)).toBe(true);
  expect(mayEditProtected(project, member, project.agents.lead.agentMd)).toBe(false);
  const dec = path.join(recordsDir(project), "decisions", "keep.md");
  write(commonFile(project), "v1\n");
  write(dec, "original\n");
  const g = new ProtectedGuard(project);
  write(commonFile(project), "v2\n");
  write(dec, "member edit\n");
  write(projectMd, "rewritten\n");
  write(project.agents.lead.agentMd, "stolen\n");
  const v = g.check([member]);
  expect(v.map((x) => x.file)).toEqual([project.agents.lead.agentMd]);
  expect(fs.readFileSync(commonFile(project), "utf8")).toBe("v2\n");
  expect(fs.readFileSync(dec, "utf8")).toBe("member edit\n");
  expect(fs.readFileSync(projectMd, "utf8")).toBe("rewritten\n");
  expect(fs.readFileSync(project.agents.lead.agentMd, "utf8")).not.toBe("stolen\n");
});
```

`mayEditProtected` 已從 `../src/policy.js` 匯入時，不要重複 import。把 `commonFile` 留在既有 policy import 裡。

- [ ] **Step 2: 跑測試，確認失敗**

Run: `npx vitest run test/project-write-scope.test.ts`

Expected: FAIL。`mayEditProtected` 對 `COMMON.md` 回傳 false，或 guard 把 member 的 record 還原。

- [ ] **Step 3: 實作**

`mayEditProtected` 改成：

```ts
export function mayEditProtected(project: ResolvedProject, agent: ResolvedAgent, file: string): boolean {
  const pol = writePolicy(project, agent);
  if (pol.allowFiles.includes(file)) return true;
  const roots = [projectAgentDir(project, agent.name), projectCommonDir(project)].filter((d) => pol.allowDirs.includes(d));
  return roots.some((d) => file === d || file.startsWith(d + path.sep));
}
```

`checkRecords` 裡把 `const lead = running.some(...)` 改成 `const authorized = running.length > 0;`。`if (lead) continue;` 改成 `if (authorized) continue;`。函式結尾 `if (lead || other.length)` 改成 `if (authorized || other.length)`。

- [ ] **Step 4: 改既有 guard 測試**

`test/shared-memory.test.ts` 的「reverts non-lead changes anywhere under records/」改成「keeps a member's records edits」。斷言改成：

```ts
    const v = g.check([member]);
    expect(v).toEqual([]);
    expect(fs.readFileSync(dec, "utf8")).toBe("tampered\n");
    expect(fs.existsSync(arc)).toBe(false);
    expect(fs.readFileSync(added, "utf8")).toBe("x\n");
```

後面 lead 再改的那段刪掉（member 已經留下改動，沒有第二段可還原的基準）。

同檔「does not write through a records root or kind folder swapped for a symlink」改成：member 的替換留下，guard 不寫進 symlink 目標。

```ts
      const v = g.check([p.agents["fe-member"]!]);
      expect(v).toEqual([]);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("sentinel\n");
      expect(fs.readFileSync(path.join(outside, "decisions", "keep.md"), "utf8")).toBe("sentinel-nested\n");
```

`test/guard-concurrent-runs.test.ts`：

- 「keeps another run's COMMON.md / records / AGENT.md」：`fe-member` 的 `agentMd` 是全域檔，仍不可寫。`COMMON.md` 與 record 現在是授權改動，不進 `takeUnattributed`。期望改成 `takeUnattributed()` 的 file 只有 `agentMd`。`COMMON.md` 與 record 的內容仍留下。
- 「still reverts the same edits when no other run is live」：`COMMON.md` 與 record 留下且沒有 violation；不要再期望 `restored`／`removed`。這個案例若只為了證明「沒有其他 run 就還原」，改寫成改別人的全域 `AGENT.md`（`p.agents.lead.agentMd`）時期望 `restored`。

`test/dispatcher.test.ts` 約 249 行：

```ts
      expect(ev.filter((e) => e.event === "protected-change-unattributed")).toEqual([]);
```

檔案內容的兩條 `toBe`／`toBe(true)` 維持。`fe-member` 現在有權改這兩個路徑，所以不再記 unattributed。

- [ ] **Step 5: 跑測試**

Run: `npx vitest run test/project-write-scope.test.ts test/shared-memory.test.ts test/guard-concurrent-runs.test.ts test/dispatcher.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/policy.ts src/guard.ts test/project-write-scope.test.ts test/shared-memory.test.ts test/guard-concurrent-runs.test.ts test/dispatcher.test.ts
git commit -m "$(cat <<'EOF'
feat: keep member edits under shared/common and their project persona

EOF
)"
```

---

### Task 3：prompt 與文件

**Files:**
- Modify: `src/prompt.ts`（`buildSoloSystemPrompt` 約 124–141 行、`buildSystemPrompt` 約 263–283 行）
- Modify: `test/project-records.test.ts`（約 112–118 行）
- Modify: `test/project-write-scope.test.ts`
- Modify: `docs/write-scope.md`、`docs/write-scope.zh-TW.md`、`docs/how-it-works.md`、`docs/how-it-works.zh-TW.md`

**Interfaces:**
- Consumes: `projectAgentDir`、`projectCommonDir`、`ownAgentDirAllowed`、`commonFile`、`recordsKindDir`。
- Produces: `buildSystemPrompt`／`buildSoloSystemPrompt` 的規則文字。沒有新的匯出函式。

- [ ] **Step 1: 寫會失敗的測試**

`test/project-records.test.ts` 的「only the lead's system prompt describes the records」改成：

```ts
  it("every member's system prompt describes the records; nothing is created on disk", () => {
    env = makeEnv();
    const p = env.project();
    for (const name of ["lead", "fe-member"] as const) {
      const sys = buildSystemPrompt(p, p.agents[name]!);
      expect(sys).toContain(recordsKindDir(p, "decisions"));
      expect(sys).toContain(recordsKindDir(p, "lessons"));
      expect(sys).toContain(commonFile(p));
      expect(sys).not.toContain("(read-only)");
    }
    expect(fs.existsSync(recordsDir(p))).toBe(false);
  });
```

在 `test/project-write-scope.test.ts` 加上：

```ts
import { buildSystemPrompt } from "../src/prompt.js";

it("tells a member to edit COMMON.md and not another agent's AGENT.md; a global persona is not offered", () => {
  env = makeEnv();
  const p = env.project();
  const sys = buildSystemPrompt(p, p.agents["fe-member"]!);
  expect(sys).toContain(commonFile(p));
  expect(sys).toContain(projectCommonDir(p));
  expect(sys).toContain(projectAgentDir(p, "fe-member"));
  expect(sys).not.toContain(`You may edit your project persona \`${p.agents["fe-member"]!.agentMd}\``);
  expect(sys).toContain("Never edit another agent's AGENT.md");
});

it("does not tell instance 2 to edit the role persona", () => {
  env = makeEnv();
  const p = env.project();
  const agents = synthesizeSlots(p.agents, { roles: { "fe-member": ["fe-member--2"] } }, (slot) => path.join(p.paths.taskMemory, "run-1", slot));
  const slot = agents["fe-member--2"]!;
  const sys = buildSystemPrompt({ ...p, agents }, slot);
  expect(sys).toContain(projectCommonDir(p));
  expect(sys).not.toContain(`You may edit your project persona \`${slot.agentMd}\``);
  expect(sys).toContain("cannot write the shared memory");
});

it("offers the project persona only when agentMd lives in agents/<name>/", () => {
  env = makeEnv();
  const p = env.project();
  const projectMd = path.join(projectAgentDir(p, "fe-member"), "AGENT.md");
  fs.mkdirSync(path.dirname(projectMd), { recursive: true });
  fs.writeFileSync(projectMd, "# fe\n");
  const member = { ...p.agents["fe-member"]!, agentMd: projectMd };
  const sys = buildSystemPrompt({ ...p, agents: { ...p.agents, "fe-member": member } }, member);
  expect(sys).toContain(`You may edit your project persona \`${projectMd}\``);
});
```

- [ ] **Step 2: 跑測試，確認失敗**

Run: `npx vitest run test/project-records.test.ts test/project-write-scope.test.ts`

Expected: FAIL。`fe-member` 的 prompt 不含 `records/decisions`，或仍寫 `(read-only)`。

- [ ] **Step 3: 實作 prompt**

`src/prompt.ts` 從 `./policy.js` 補上 `projectAgentDir`、`projectCommonDir`、`ownAgentDirAllowed`。

在 `buildSystemPrompt` 之上加上（兩個 prompt 共用）：

```ts
function writeScopeRules(project: ResolvedProject, agent: ResolvedAgent): string[] {
  const ownDir = projectAgentDir(project, agent.name);
  const ownPersona = agent.agentMd === path.join(ownDir, "AGENT.md") || agent.agentMd.startsWith(ownDir + path.sep);
  const leadClause = agent.canEditAgentMd
    ? " The lead may also edit every `AGENT.md` and the repository's `CLAUDE.md`/`AGENTS.md`; those changes are logged."
    : "";
  return [
    `- You may edit the shared team context \`${commonFile(project)}\` (keep it short) and the project records: decisions in \`${recordsKindDir(project, "decisions")}/\` and lessons in \`${recordsKindDir(project, "lessons")}/\`. The file name without \`.md\` is the entry id (lowercase letters, digits, \`-\`). Each file starts with YAML frontmatter between \`---\` lines: \`status: active|superseded\`, \`date: YYYY-MM-DD\`, \`title: <one line>\`, optionally \`run: <run id>\` and \`supersedes: [<ids of entries of the same kind>]\`; the body is the decision or lesson and its reason. Prompts show only effective-active entries (\`status: active\` and not named in another entry's \`supersedes\`), newest first, up to ${CONTEXT_LIMIT / 1024} KB per kind, and list what does not fit as one line each. When an entry becomes outdated, mark it \`status: superseded\` or name it in a new entry's \`supersedes\`.`,
    ...(ownAgentDirAllowed(project, agent) ? [`- You may write your project agent directory \`${ownDir}/\`.`] : []),
    ...(ownPersona ? [`- You may edit your project persona \`${agent.agentMd}\`.`] : []),
    `- Never edit another agent's \`AGENT.md\`, a global \`AGENT.md\` outside \`${ownDir}/\`, or the repository's own \`CLAUDE.md\`/\`AGENTS.md\`.${leadClause}`,
    "- Never touch another agent's memory, inbox or outbox, or the configuration files of agent-lyceum (`project.yaml`, `team.yaml`, `runs/`).",
  ];
}
```

`buildSoloSystemPrompt` 與 `buildSystemPrompt` 的 `## Rules` 裡，刪掉這三項：

- `Never edit any AGENT.md, COMMON.md...`
- `Never touch another agent's memory...`
- `` The shared team context is in ... (read-only) `` 以及只在 `isLead` 時展開的 records 段落

改成 `...writeScopeRules(project, agent),`，後面仍接 `PR_ATTRIBUTION_RULE` 與 `NO_DAEMONS_RULE`。

兩處「you can write only inside these directories」改成帶上實際目錄。solo 與 team 各一處，句子換成：

```ts
    const extra = [
      ...(ownAgentDirAllowed(project, agent) ? [projectAgentDir(project, agent.name)] : []),
      projectCommonDir(project),
    ];
```

記憶那句的結尾改成：

```ts
      `Keep a \`MEMORY.md\` index in each memory directory (one line per entry, pointing at a file). Its contents are shown in your prompt on every wake-up. You may also write ${extra.map((d) => `\`${d}/\``).join(" and ")}.`,
```

實例 2 的「You cannot write the shared memory...」那段不要刪。

- [ ] **Step 4: 改文件**

`docs/write-scope.md` 表格第二列改成：

```md
| own `agents/<self>/`, `shared/common/` (`COMMON.md`, `records/`) | writable by every member |
| another agent's `AGENT.md`, a global `AGENT.md`, repo `CLAUDE.md`/`AGENTS.md` | read-only; the lead (`can_edit_agent_md`) may edit them |
```

`docs/write-scope.zh-TW.md` 對應列改成：

```md
| 自己的 `agents/<自己>/`、`shared/common/`（`COMMON.md`、`records/`） | 每位成員可寫 |
| 別人的 `AGENT.md`、全域 `AGENT.md`、repo 的 `CLAUDE.md`/`AGENTS.md` | 唯讀；lead（`can_edit_agent_md`）可編輯 |
```

`docs/how-it-works.md` 把這句：

`Only the lead writes records (it may flip status); a change by any other agent is reverted and reported as a violation, except while another run of the project is live, when the change cannot be attributed and is kept and logged instead`

換成：

`Every member may write records (including flipping status). A change is kept. Another agent's AGENT.md, a global AGENT.md, and the repo CLAUDE.md/AGENTS.md stay protected: a change by someone who may not edit them is reverted, except while another run of the project is live, when that change cannot be attributed and is kept and logged instead`

`docs/how-it-works.zh-TW.md` 把這句：

`只有 lead 能寫紀錄（可改 status）；其他 agent 的改動會被還原並記為違規；但若同專案另一個 run 仍存活，該改動無法歸屬，會保留並只記入日誌`

換成：

`每位成員都能寫紀錄（可改 status），改動會留下。別人的 AGENT.md、全域 AGENT.md、repo 的 CLAUDE.md／AGENTS.md 仍受保護：無權編輯者的改動會被還原並記為違規；但若同專案另一個 run 仍存活，該改動無法歸屬，會保留並只記入日誌`

- [ ] **Step 5: 跑測試**

Run: `npx vitest run test/project-records.test.ts test/project-write-scope.test.ts test/shared-memory.test.ts test/solo.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/prompt.ts test/project-records.test.ts test/project-write-scope.test.ts docs/write-scope.md docs/write-scope.zh-TW.md docs/how-it-works.md docs/how-it-works.zh-TW.md
git commit -m "$(cat <<'EOF'
docs: tell members they may write shared context and their project persona

EOF
)"
```

---

### Task 4：整套檢查

**Files:**
- 不新增檔案。若前三個 task 的測試還有漏網的舊斷言，在這個 task 改掉。

**Interfaces:**
- Consumes: Task 1–3 的行為。
- Produces: `npm test`、`npm run lint`、`npm run typecheck` 都通過。

- [ ] **Step 1: 跑整套測試**

Run: `npm test`

Expected: PASS。若失敗，只修「仍假設成員不能寫 `COMMON.md`／`records/`／自己的專案層 `AGENT.md`」的斷言。全域 `AGENT.md`、repo `CLAUDE.md`、交接筆記、別人的記憶被還原的測試必須維持失敗（那些行為不能放寬）。

- [ ] **Step 2: lint 與型別**

Run: `npm run lint && npm run typecheck`

Expected: PASS。

- [ ] **Step 3: Commit（只有 step 1 改到檔案時）**

```bash
git add -u
git commit -m "$(cat <<'EOF'
test: align remaining assertions with project write scope

EOF
)"
```

沒有檔案變更就不要提交。
