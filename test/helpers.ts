import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProject, type ResolvedProject } from "../src/config.js";
import { addProject, initHome } from "../src/scaffold.js";

export interface TestEnv {
  root: string;
  home: string;
  repo: string;
  project: () => ResolvedProject;
  editProjectYaml: (fn: (text: string) => string) => void;
  cleanup: () => void;
}

export function makeEnv(name = "demo"): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lyceum-test-"));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  initHome(home);
  addProject(home, name, repo);
  const cfg = path.join(home, "projects", name, "project.yaml");
  return {
    root,
    home,
    repo,
    project: () => resolveProject(home, name),
    editProjectYaml: (fn) => fs.writeFileSync(cfg, fn(fs.readFileSync(cfg, "utf8"))),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** A `done` body that meets the completion contract for `outcome: completed`. */
export const FULL_DONE = "## Result\nShipped.\n\n## Files\n- src/x.ts\n\n## Verification\nnpm test: passed\n\n## Not done\nNone\n";

export function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
}

/** A git repo with one commit holding `files` (default: src/web/a.txt and tests/t.txt). */
export function initGitRepo(dir: string, files: Record<string, string> = { "src/web/a.txt": "a\n", "tests/t.txt": "t\n" }): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  for (const [f, c] of Object.entries(files)) write(path.join(dir, f), c);
  write(path.join(dir, ".gitignore"), "ignored.log\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
}

/** Configure the demo project for parallel runs: 2 parallel, disjoint owns. */
export function makeParallel(env: TestEnv): void {
  env.editProjectYaml((t) =>
    t
      .replace("max_parallel: 1", "max_parallel: 2")
      .replace('    # owns: ["src/web/**"]', '    owns: ["src/web/**"]')
      .replace('    # owns: ["tests/**"]', '    owns: ["tests/**"]'),
  );
}
