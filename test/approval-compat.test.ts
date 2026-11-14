import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnoseProject, formatDoctor } from "../src/doctor.js";
import { enforcementFor, setOsSandboxForTest, writePolicy } from "../src/policy.js";
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

function fixture(name: string, bytes: string, root: string): void {
  const normalized = [root, fs.realpathSync(root)]
    .sort((a, b) => b.length - a.length)
    .reduce((text, prefix) => text.split(prefix).join("<ROOT>"), bytes);
  const file = path.join(FIXTURES, name);
  if (process.env.UPDATE_APPROVAL_COMPAT_FIXTURES === "1") {
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
