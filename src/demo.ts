import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectPaths } from "./paths.js";
import { addProject, initHome } from "./scaffold.js";
import type { Runtime } from "./schema.js";

export const DEMO_PROJECT = "demo";

export const DEMO_TASK = `The sample repo has a failing test: \`npm test\` fails because slugify() in src/slug.js is not implemented.

Implement slugify(text) so that it lowercases the text, turns every run of non-alphanumeric characters into a single "-", and trims leading and trailing "-". Do not edit the tests.

Plan: the lead hands the implementation to fe-member, then asks qa-member to run \`npm test\` and review the change. Finish with \`done\` only after qa-member's verdict is pass.`;

const FILES: Record<string, string> = {
  "package.json": `{
  "name": "lyceum-demo",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
`,
  "src/slug.js": `// Turn a title into a URL slug: "Hello, World!" -> "hello-world".
export function slugify(text) {
  throw new Error("not implemented");
}
`,
  "test/slug.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slug.js";

test("lowercases and joins words with a dash", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("collapses punctuation and repeated separators", () => {
  assert.equal(slugify("Hello,   World!!"), "hello-world");
});

test("trims leading and trailing separators", () => {
  assert.equal(slugify("  --Agent Lyceum--  "), "agent-lyceum");
});

test("keeps digits", () => {
  assert.equal(slugify("Top 10 tips"), "top-10-tips");
});
`,
};

/** Which runtime CLI is on the PATH and answers `--version`; claude-code wins when both are. */
export function detectRuntime(): Runtime | undefined {
  for (const [runtime, bin] of [["claude-code", "claude"], ["codex", "codex"]] as const) {
    const r = spawnSync(bin, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return runtime;
  }
  return undefined;
}

export interface DemoSetup {
  dir: string;
  home: string;
  repo: string;
}

/** A throwaway sandbox: a tiny git repo with one failing test, plus its own agent-lyceum home with a registered project. Touches nothing outside `dir`. */
export function prepareDemo(dir: string, runtime: Runtime): DemoSetup {
  const root = path.resolve(dir);
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`${root} is not empty. Choose another --dir (or remove it).`);
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  for (const [file, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=agent-lyceum demo", "-c", "user.email=demo@example.com", ...args], { stdio: "ignore" });
  try {
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "demo: slugify is not implemented yet");
  } catch {
    throw new Error("The demo needs `git` on your PATH.");
  }

  initHome(home);
  addProject(home, DEMO_PROJECT, repo);
  const cfg = projectPaths(home, DEMO_PROJECT).config;
  let yaml = fs.readFileSync(cfg, "utf8");
  yaml = yaml.replace("max_rounds: 0 ", "max_rounds: 20");
  // One runtime for the whole team, and the roles scoped to the sample repo.
  for (const agent of ["lead", "fe-member", "qa-member"]) yaml = yaml.replace(`  ${agent}:\n`, `  ${agent}:\n    runtime: ${runtime}\n`);
  fs.writeFileSync(cfg, yaml);
  return { dir: root, home, repo };
}

export function defaultDemoDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-lyceum-demo-"));
}
