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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-test-"));
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

export function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
