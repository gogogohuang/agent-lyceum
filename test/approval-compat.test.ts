import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClaudeInvocation } from "../src/adapters/claude.js";
import { buildCodexInvocation } from "../src/adapters/codex.js";
import type { WakeInput } from "../src/adapters/index.js";
import { callProject, callsDir, resolveCallAgent } from "../src/call.js";
import type { ResolvedAgent, ResolvedProject } from "../src/config.js";
import { diagnoseProject, formatDoctor } from "../src/doctor.js";
import { enforcementFor, setOsSandboxForTest, writePolicy, type WritePolicy } from "../src/policy.js";
import { buildCallUserPrompt, buildSoloSystemPrompt, buildSystemPrompt, buildTidyPrompts, buildUserPrompt } from "../src/prompt.js";
import { soloProject } from "../src/solo.js";
import type { AgentWorkspace } from "../src/worktree.js";
import { bindRunProject } from "../src/run-store.js";
import { protectedPathsFor } from "../src/sandbox-invocation.js";
import { initGitRepo, makeEnv, type TestEnv } from "./helpers.js";

// Fixtures were generated from pre-feature revision f4936b0, NOT from the approval implementation.
// In an extracted f4936b0 tree with this test copied in, regenerate deliberately with:
// UPDATE_APPROVAL_COMPAT_FIXTURES=1 npx vitest run test/approval-compat.test.ts --configLoader runner
// Compare here WITHOUT that flag. Only disposable roots are normalized; messages and ordering stay exact.
const FIXTURES = path.join(__dirname, "fixtures", "approval-compat");

// Exercise doctor's real runtime-capability interpretation without installed CLIs or child processes.
vi.mock("../src/process-runner.js", () => ({
  runInvocation: vi.fn(async (inv: { cmd: string; args: string[] }) => ({
    ok: true,
    text: inv.args.includes("--version")
      ? `${inv.cmd} fixture-version`
      : "--output-format --resume --settings --effort --json --sandbox --config",
  })),
}));

vi.setConfig({ testTimeout: 30_000 }); // real git setup can exceed 5 s in the full suite
let env: TestEnv | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setOsSandboxForTest(undefined);
  env?.cleanup();
  env = undefined;
});

// Read once: the run-time tests below replace process.env with a pinned set.
const UPDATE = process.env.UPDATE_APPROVAL_COMPAT_FIXTURES === "1";

function fixture(name: string, bytes: string, root: string): void {
  const normalized = [root, fs.realpathSync(root)]
    .sort((a, b) => b.length - a.length)
    .reduce((text, prefix) => text.split(prefix).join("<ROOT>"), bytes);
  const file = path.join(FIXTURES, name);
  if (UPDATE) {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(file, normalized);
  } else {
    expect(fs.existsSync(file), `missing ${name}; regenerate only at f4936b0`).toBe(true);
    expect(normalized, name).toBe(fs.readFileSync(file, "utf8"));
  }
}

describe("approval default-off byte compatibility with f4936b0", () => {
  for (const scenario of ["plain", "sandbox", "home-dir", "instances-fallback"] as const) {
    it(`${scenario}: doctor and write/enforcement/protected policies are byte-identical without executors.yaml`, async () => {
      env = makeEnv();
      const userHome = path.join(env.root, "user");
      fs.mkdirSync(userHome);
      const bin = path.join(env.root, "bin");
      fs.mkdirSync(bin); // deliberately empty: gh detection cannot depend on the host
      vi.spyOn(os, "homedir").mockReturnValue(userHome);
      vi.stubEnv("CODEX_HOME", path.join(userHome, ".codex"));
      setOsSandboxForTest(true);
      initGitRepo(env.repo);
      if (scenario === "home-dir") env.editProjectYaml((text) => text.replace(/^dir:.*$/m, 'dir: "~"'));
      if (scenario === "sandbox") {
        const grant = path.join(env.root, "external-write");
        fs.mkdirSync(grant);
        env.editProjectYaml((text) => text.replace("  qa-member:\n", `  qa-member:\n    can_edit_agent_md: true\n    sandbox:\n      write: [${grant}]\n      network: [example.com]\n      unix_sockets: [${path.join(env.root, "missing.sock")}]\n`));
      }
      if (scenario === "instances-fallback") {
        env.editProjectYaml((text) => text
          .replace("dispatcher:\n", "dispatcher:\n  max_instances: 3\n  fallback: [{runtime: codex, model: fixture-model}]\n")
          + `  fe-member--2:\n    runtime: claude-code\n    agent_md: ${path.join(env!.home, "agents/fe-member/AGENT.md")}\n    can_message: [lead]\n`);
      }
      expect(fs.existsSync(path.join(env.home, "executors.yaml"))).toBe(false);
      const project = env.project();
      if (scenario === "home-dir") expect(project.dir).toBe(userHome);
      if (scenario === "sandbox") {
        expect(project.agents["qa-member"]!.canEditAgentMd).toBe(true);
        expect(project.agents["qa-member"]!.sandbox!.write).toHaveLength(1);
      }
      if (scenario === "instances-fallback") {
        expect(project.dispatcher.max_instances).toBe(3);
        expect(project.agents["fe-member"]!.fallback).toHaveLength(1);
        expect(project.agents["fe-member--2"]).toBeDefined();
      }
      const report = await diagnoseProject(project, { env: { PATH: bin } });
      fixture(`${scenario}.doctor.json`, JSON.stringify(report, null, 2) + "\n", env.root);
      fixture(`${scenario}.doctor.txt`, formatDoctor(report) + "\n", env.root);
      // Bound run policy also covers handoff/mail deny paths, without starting any agents.
      const bound = bindRunProject(project, path.join(project.paths.runs, "fixture-run"), "run");
      for (const name of ["lead", "fe-member", "qa-member"]) {
        const agent = bound.agents[name]!;
        fixture(`${scenario}.${name}.json`, JSON.stringify({
          writePolicy: writePolicy(bound, agent),
          enforcementFor: enforcementFor(bound, agent),
          protectedPathsFor: {
            static: protectedPathsFor(bound, agent, false),
            deep: protectedPathsFor(bound, agent, true),
          },
        }, null, 2) + "\n", env.root);
      }
    });
  }
});

// Stage 2b-1: the same default-off promise at run time. Three situations must give identical bytes (and match f4936b0):
// (a) no executors.yaml, (b) a valid file whose allow lists are empty, (c) a valid file that lists other tuples only
// (same-named agent in another project, a `call` entry for another agent, an unknown agent of this project).
const RT_SCENARIOS: Record<string, string | undefined> = {
  "no-file": undefined,
  "empty-allow": "executors:\n  x:\n    command: [/opt/x/tool]\n    allow: []\n    timeout_sec: 5\n    env:\n      TOKEN: not-a-real-secret\n",
  "other-tuples": "executors:\n  x:\n    command: [/opt/x/tool]\n    allow:\n      - {project: other, agent: fe-member}\n      - {project: demo, agent: ghost}\n      - {call: ghost}\n    timeout_sec: 5\n",
};
const PINNED_ENV = (root: string): Record<string, string> => ({
  PATH: "/usr/bin:/bin", HOME: path.join(root, "user"), LANG: "C.UTF-8", TERM: "xterm", TMPDIR: path.join(root, "tmp"),
  USER: "fixture-user", FAKE_SECRET_TOKEN: "fixture-secret-do-not-leak", AGENT_LYCEUM_AGENT: "stale-identity",
});

describe("approval default-off byte compatibility at run time (invocations, settings, prompts, policies)", () => {
  for (const [scenario, executors] of Object.entries(RT_SCENARIOS)) {
    it(`${scenario}: adapters, raw settings, prompts and policies match f4936b0`, () => {
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
        fixture("rt.claude.json", run((i) => buildClaudeInvocation(i), true), root);
        fixture("rt.codex.json", run((i) => buildCodexInvocation(i), false), root);

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
        fixture("rt.prompts.json", JSON.stringify(prompts, null, 2) + "\n", root);

        const pol: Record<string, unknown> = {};
        for (const [key, { project, agent }] of Object.entries(wakes)) {
          pol[key] = { writePolicy: writePolicy(project, agent), enforcementFor: enforcementFor(project, agent), protectedPathsFor: { static: protectedPathsFor(project, agent, false), deep: protectedPathsFor(project, agent, true) } };
        }
        fixture("rt.policies.json", JSON.stringify(pol, null, 2) + "\n", root);
        expect(JSON.stringify(bound)).not.toMatch(/enrolled|approval/);
      } finally {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, saved);
      }
    });
  }
});
