import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClaudeInvocation } from "../src/adapters/claude.js";
import { buildCodexInvocation } from "../src/adapters/codex.js";
import type { WakeInput } from "../src/adapters/index.js";
import { callProject, callsDir, resolveCallAgent } from "../src/call.js";
import type { ResolvedAgent, ResolvedProject } from "../src/config.js";
import { runTeam } from "../src/dispatcher.js";
import { enforcementFor, outboxDir, setOsSandboxForTest, writePolicy, type WritePolicy } from "../src/policy.js";
import { buildCallUserPrompt, buildSoloSystemPrompt, buildSystemPrompt, buildTidyPrompts, buildUserPrompt } from "../src/prompt.js";
import { loadRunState, bindRunProject } from "../src/run-store.js";
import { protectedPathsFor } from "../src/sandbox-invocation.js";
import { soloProject } from "../src/solo.js";
import { buildStatusReport, formatStatusWithLog } from "../src/status.js";
import { prepareTask } from "../src/task.js";
import { writeAskReply, readAskReply } from "../src/ask-reply.js";
import type { AgentWorkspace } from "../src/worktree.js";
import { initGitRepo, makeEnv, withSections, write, type TestEnv } from "./helpers.js";

// Zero-difference baseline for approval stage 3 (default-off promise).
// Fixtures are captured from the 734e64d archive, NOT from stage-3 code; see fixtures/approval-stage3-baseline/SOURCE.txt.
// Regenerate ONLY inside an extracted 734e64d tree with this file copied in:
//   UPDATE_STAGE3_BASELINE_FIXTURES=1 npx vitest run test/approval-stage3-baseline.test.ts --configLoader runner
// Without the flag the test only compares. It has no literal expectations and uses only APIs that exist at 734e64d.
//
// Normalization (identical for baseline and current code; nothing else is rewritten):
//   * the disposable root (and its realpath) -> <ROOT>
//   * generated ids at the exact positions in the table below (claim/attempt file names, inbox file names)
// Timestamps are NOT normalized: the run uses a fixed clock (FIXED_NOW), so they are exact and a changed
// started_at/ended_at/at must fail the comparison.
const FIXTURES = path.join(__dirname, "fixtures", "approval-stage3-baseline");
const FIXED_NOW = Date.UTC(2026, 10, 17, 0, 0, 0);
// Exact generated-value positions only. Fixed-clock timestamps are deliberately NOT normalized (see below).
const VOLATILE: [RegExp, string][] = [
  [/[\w.-]*agent-lyceum-test-[A-Za-z0-9]{6}/g, "<TMPROOT>"],
  // claim id `<base36 time>-<agent>-<randomBytes(3) hex>` and its `-aN` attempt file (src/message-store.ts)
  [/(?<=\b[0-9a-z]{6,9}-[a-z][a-z-]*-)[0-9a-f]{6}(?=(?:-a\d+)?\.json\b)/g, "<ID6>"],
  // inbox file `<stamp>Z-<from>-<id>.md`: 6 hex = randomBytes(3) mail id, longer = other generated ids
  [/(?<=\dZ-[a-z][a-z-]*-)[0-9a-f]{6}(?=\.md\b)/g, "<ID6>"],
  [/(?<=\dZ-[a-z][a-z-]*-)[0-9a-f]{8,}(?=\.md\b)/g, "<HEX>"],
];

vi.setConfig({ testTimeout: 60_000 }); // real git setup can exceed 5 s in the full suite

let env: TestEnv | undefined;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setOsSandboxForTest(undefined); // the OS sandbox is pinned per test below, never taken from the host
  env?.cleanup();
  env = undefined;
});

const STAMP_SEQ = /(?<=\d{8}T\d{6})\d{3}(?=Z-)/g;
let ignoreStampSequence = false; // only the all-letter test sets this; it is not part of UPDATE runs
const UPDATE = process.env.UPDATE_STAGE3_BASELINE_FIXTURES === "1";

function normalize(bytes: string, root: string, volatile: boolean): string {
  const text = [root, fs.realpathSync(root)]
    .sort((a, b) => b.length - a.length)
    .reduce((t, prefix) => t.split(prefix).join("<ROOT>"), bytes);
  return volatile ? VOLATILE.reduce((t, [re, to]) => t.replace(re, to), text) : text;
}
function fixture(name: string, bytes: string, root: string, volatile = false): void {
  let normalized = normalize(bytes, root, volatile);
  const file = path.join(FIXTURES, name);
  if (UPDATE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, normalized);
  } else {
    expect(fs.existsSync(file), `missing ${name}; regenerate only from the 734e64d archive`).toBe(true);
    let expected = fs.readFileSync(file, "utf8");
    if (ignoreStampSequence) { // the mail stamp counter is process-global; a later test in the file starts above the fixture's
      normalized = normalized.replace(STAMP_SEQ, "<N>");
      expected = expected.replace(STAMP_SEQ, "<N>");
    }
    expect(normalized, name).toBe(expected);
  }
}

const RT_SCENARIOS: Record<string, string | undefined> = {
  "no-file": undefined,
  "empty-allow": "executors:\n  x:\n    command: [/opt/x/tool]\n    allow: []\n    timeout_sec: 5\n    env:\n      TOKEN: not-a-real-secret\n",
  "other-tuples": "executors:\n  x:\n    command: [/opt/x/tool]\n    allow:\n      - {project: other, agent: fe-member}\n      - {project: demo, agent: ghost}\n      - {call: ghost}\n    timeout_sec: 5\n",
};
const PINNED_ENV = (root: string): Record<string, string> => ({
  PATH: "/usr/bin:/bin", HOME: path.join(root, "user"), LANG: "C.UTF-8", TERM: "xterm", TMPDIR: path.join(root, "tmp"),
  USER: "fixture-user", FAKE_SECRET_TOKEN: "fixture-secret-do-not-leak", AGENT_LYCEUM_AGENT: "stale-identity",
});

describe("stage 3 baseline: invocations, prompts and policies are byte-identical to 734e64d", () => {
  for (const [scenario, executors] of Object.entries(RT_SCENARIOS)) {
    it(`${scenario}: adapters, raw settings, prompts and policies`, () => {
      env = makeEnv();
      const userHome = path.join(env.root, "user");
      fs.mkdirSync(userHome);
      vi.spyOn(os, "homedir").mockReturnValue(userHome);
      vi.stubEnv("CODEX_HOME", path.join(userHome, ".codex"));
      setOsSandboxForTest(true);
      initGitRepo(env.repo);
      env.editProjectYaml((text) => text
        .replace("dispatcher:\n", "dispatcher:\n  fallback: [{runtime: codex, model: fixture-model}]\n")
        .replace("  qa-member:\n", "  qa-member:\n    sandbox:\n      network: [example.com]\n"));
      if (executors !== undefined) fs.writeFileSync(path.join(env.home, "executors.yaml"), executors);
      const root = env.root;
      const saved = { ...process.env };
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, PINNED_ENV(root));
      try {
        const bound = bindRunProject(env.project(), path.join(env.project().paths.runs, "fixture-run"), "run");
        const wsFor = (n: string): AgentWorkspace => ({ agent: n, root: path.join(root, "wt", n), dir: path.join(root, "wt", n), gitDir: path.join(root, "gd", n), commonDir: path.join(root, "gc") }) as unknown as AgentWorkspace;
        const solo = soloProject(bound, "fe-member");
        const callAgent = resolveCallAgent(env.home, "fe-member");
        const callProj = callProject(env.home, callAgent, env.repo, path.join(callsDir(env.home), "fixture-call"));
        const override = (project: ResolvedProject): WritePolicy => ({ allowDirs: [path.join(project.paths.root, "scratch-allow")], readDirs: [path.join(root, "read")], allowFiles: [path.join(root, "one.txt")], deny: [path.join(root, "denied")] });
        const wakes: Record<string, { project: ResolvedProject; agent: ResolvedAgent }> = {};
        for (const n of ["lead", "fe-member", "qa-member"]) wakes[`project.${n}`] = { project: bound, agent: bound.agents[n]! };
        wakes["solo.fe-member"] = { project: solo, agent: solo.agents["fe-member"]! };
        wakes["call.fe-member"] = { project: callProj, agent: callAgent };
        const run = (build: (i: WakeInput) => { cmd: string; args: string[]; stdin?: string; cwd: string; env: NodeJS.ProcessEnv }, settings: boolean) => {
          const out: Record<string, unknown> = {};
          for (const [key, { project, agent }] of Object.entries(wakes)) {
            const variants: Record<string, (workDir: string) => WakeInput> = {
              normal: (workDir) => ({ project, agent, workDir, systemPrompt: "SYS", userPrompt: "USER", timeoutSec: 60 }),
              session: (workDir) => ({ project, agent, workDir, systemPrompt: "SYS", userPrompt: "USER", timeoutSec: 60, sessionId: "sess-1" }),
              worktree: (workDir) => ({ project: { ...project, workspaces: { [agent.name]: wsFor(agent.name) } }, agent, workDir, systemPrompt: "SYS", userPrompt: "USER", timeoutSec: 60, workspace: wsFor(agent.name) }),
              policy: (workDir) => ({ project, agent, workDir, systemPrompt: "SYS", userPrompt: "USER", timeoutSec: 60, policy: override(project) }),
            };
            for (const [v, mk] of Object.entries(variants)) {
              const workDir = path.join(root, "work", `${key}.${v}`);
              const inv = build(mk(workDir));
              out[`${key}.${v}`] = {
                cmd: inv.cmd, args: inv.args, stdin: inv.stdin, cwd: inv.cwd,
                env: Object.fromEntries(Object.entries(inv.env).sort(([a], [b]) => a.localeCompare(b))),
                ...(settings ? { settingsRaw: fs.readFileSync(path.join(workDir, "claude-settings.json"), "utf8") } : {}),
              };
            }
          }
          return JSON.stringify(out, null, 2) + "\n";
        };
        fixture(`${scenario}.claude.json`, run((i) => buildClaudeInvocation(i), true), root);
        fixture(`${scenario}.codex.json`, run((i) => buildCodexInvocation(i), false), root);

        const prompts: Record<string, string> = {};
        for (const n of ["lead", "fe-member", "qa-member"]) {
          const a = bound.agents[n]!;
          prompts[`system.${n}`] = buildSystemPrompt(bound, a);
          prompts[`user.${n}`] = buildUserPrompt(bound, a, []);
          prompts[`user-handoff.${n}`] = buildUserPrompt(bound, a, [], 1, true, { text: "the task" });
          prompts[`tidy.${n}`] = JSON.stringify(buildTidyPrompts(a, { layer: "global", dir: a.memory.global, archiveDir: path.join(root, "arch"), files: [], index: "", missing: [] }));
        }
        prompts["system.solo"] = buildSoloSystemPrompt(solo, solo.agents["fe-member"]!);
        prompts["system.call"] = buildSoloSystemPrompt(callProj, callAgent);
        prompts["user.call"] = buildCallUserPrompt(callAgent, "what is here?");
        fixture(`${scenario}.prompts.json`, JSON.stringify(prompts, null, 2) + "\n", root);

        const pol: Record<string, unknown> = {};
        for (const [key, { project, agent }] of Object.entries(wakes)) {
          pol[key] = { writePolicy: writePolicy(project, agent), enforcementFor: enforcementFor(project, agent), protectedPathsFor: { static: protectedPathsFor(project, agent, false), deep: protectedPathsFor(project, agent, true) } };
        }
        fixture(`${scenario}.policies.json`, JSON.stringify(pol, null, 2) + "\n", root);
      } finally {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, saved);
      }
    });
  }
});

/** Relative path, type and permission bits of every entry below `dir` (no contents). */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      const type = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
      out.push(`${type} ${(st.mode & 0o777).toString(8)} ${path.relative(dir, full)}`);
      if (st.isDirectory() && name !== ".git") walk(full);
    }
  };
  walk(dir);
  return out;
}

async function runScenario(scenario: string, executors: string | undefined): Promise<void> {
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] });
  env = makeEnv();
  setOsSandboxForTest(true);
  initGitRepo(env.repo);
  if (executors !== undefined) fs.writeFileSync(path.join(env.home, "executors.yaml"), executors);
  const OK = { ok: true, text: "", exitCode: 0, timedOut: false };
  let counter = 0;
  let leadWakes = 0;
  const mail = (p: ResolvedProject, from: string, to: string, subject: string, type: string): void =>
    write(path.join(outboxDir(p, from), `m${++counter}.md`),
      `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${type === "done" ? "## Result\nx\n\n## Files\nx\n\n## Verification\nx\n\n## Decisions\nNone\n\n## Not done\nNone\n" : withSections(type, `body of ${subject}`)}\n`);
  const project = env.project();
  const runDir = path.join(project.paths.runs, "run-1");
  const task = prepareTask({ text: "go", cwd: env.root, runDir });
  await runTeam({
    project, task, runDir, log: () => {},
    invoker: async (i) => {
      if (i.agent.name === "lead" && ++leadWakes === 1) {
        mail(i.project, "lead", "fe-member", "work", "task");
      } else if (i.agent.name === "lead") {
        write(path.join(outboxDir(i.project, "lead"), "ask.md"),
          `---\nto: lead\ntype: ask\nsubject: ask\n---\n\n<ask><question id="q1"><text>JWT?</text><options><option>session</option><option>jwt</option></options><suggested>session</suggested></question></ask>\n`);
      } else {
        mail(i.project, i.agent.name, "lead", "finished", "reply");
      }
      return OK;
    },
  });
  expect(loadRunState(runDir).lead_workspace).toBe(true);
  const r = readAskReply(runDir)!;
  writeAskReply(runDir, { ...r, questions: r.questions.map((q) => ({ ...q, answer: { value: "jwt", by: "user" as const } })) });
  await runTeam({
    project: env.project(), resume: loadRunState(runDir), runDir, log: () => {},
    invoker: async (i) => {
      mail(i.project, "lead", "lead", "bye", "done");
      return OK;
    },
  });
  const root = env.root;
  fixture(`${scenario}.run.tree.txt`, tree(env.home).map((l) => normalize(l, root, true)).sort().join("\n") + "\n", root);
  fixture(`${scenario}.run.status.txt`, formatStatusWithLog(env.project(), FIXED_NOW, false) + "\n", root, true);
  fixture(`${scenario}.run.status.json`, JSON.stringify(buildStatusReport(env.project(), undefined, FIXED_NOW), null, 2) + "\n", root, true);
}

describe("stage 3 baseline: a fake-runtime run (worktree mode, lead + member, resume) leaves identical disk and status", () => {
  for (const [scenario, executors] of Object.entries(RT_SCENARIOS)) {
    it(`${scenario}: home tree, status and status --json`, () => runScenario(scenario, executors));
  }

  it.skipIf(UPDATE)("all-letter random ids normalize", async () => {
    // claim ids and mail-id suffixes are crypto.randomBytes(3) hex; force values that contain no digit
    let n = 0;
    vi.spyOn(crypto, "randomBytes").mockImplementation(((size: number) =>
      size === 3 ? Buffer.from([0xaa + (n % 6), 0xaa + (Math.floor(n++ / 6) % 6), 0xaa]) : Buffer.alloc(size, 0xab)) as typeof crypto.randomBytes);
    ignoreStampSequence = true;
    try {
      for (const [scenario, executors] of Object.entries(RT_SCENARIOS)) {
        await runScenario(scenario, executors);
        env?.cleanup();
        env = undefined;
      }
    } finally {
      ignoreStampSequence = false;
    }
    expect(n).toBeGreaterThan(0);
  });
});
