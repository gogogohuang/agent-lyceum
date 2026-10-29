import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findProjectForCwd } from "../src/config.js";
import { addProject } from "../src/scaffold.js";
import { ProtectedGuard } from "../src/guard.js";
import { escapesParent, isInside } from "../src/paths.js";
import { recordsDir } from "../src/policy.js";
import { bindRunProject } from "../src/run-store.js";
import { collectAgentChanges, prepareAgentWorkspace, snapshotHead } from "../src/worktree.js";
import { initGitRepo, makeConcurrent, makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("a relative path that merely starts with '..' is not an escape", () => {
  it("escapesParent is segment exact", () => {
    expect(escapesParent("..")).toBe(true);
    expect(escapesParent("../x")).toBe(true);
    expect(escapesParent("/x")).toBe(true);
    expect(escapesParent("..x")).toBe(false);
    expect(escapesParent("x/..y")).toBe(false);
    expect(escapesParent("..\\x", "\\")).toBe(true);
  });

  it("isInside accepts ..work children, still rejects real escapes", () => {
    expect(isInside("/h", "/h/..work")).toBe(true);
    expect(isInside("/h", "/h/x/..work")).toBe(true);
    expect(isInside("/h", "/h/../x")).toBe(false);
    expect(isInside("/h", "/x")).toBe(false);
    expect(isInside("/h", "/h")).toBe(true);
  });

  it("the guard keeps a member's new file under records/..x/ (members may write records)", () => {
    env = makeEnv();
    const p = bindRunProject(env.project(), path.join(env.root, "run-1"), "run");
    const g = new ProtectedGuard(p);
    const f = path.join(recordsDir(p), "..x", "note.md");
    write(f, "member wrote this\n");
    expect(g.check([p.agents["fe-member"]!]).map((x) => x.file)).not.toContain(f);
    expect(fs.existsSync(f)).toBe(true);
  });

  it("the guard keeps a member's edit under records/..x/ (members may write records)", () => {
    env = makeEnv();
    const p = bindRunProject(env.project(), path.join(env.root, "run-1"), "run");
    const f = path.join(recordsDir(p), "..x", "note.md");
    write(f, "lead wrote this\n");
    const g = new ProtectedGuard(p);
    write(f, "member changed it\n");
    expect(g.check([p.agents["fe-member"]!]).map((x) => x.file)).not.toContain(f);
    expect(fs.readFileSync(f, "utf8")).toBe("member changed it\n");
  });

  describe("worktree symlink containment", () => {
    const violationsFor = (link: string, target: string): string[] => {
      env?.cleanup();
      env = makeEnv();
      initGitRepo(env.repo);
      makeConcurrent(env, 2);
      const p = env.project();
      const ws = prepareAgentWorkspace(p, "run-1", "fe-member", snapshotHead(p, "run-1"));
      fs.mkdirSync(path.dirname(path.join(ws.dir, link)), { recursive: true });
      fs.symlinkSync(target, path.join(ws.dir, link));
      return collectAgentChanges(ws).violations;
    };
    it("a link to a ..env sibling inside the project is allowed", () => {
      expect(violationsFor("link", "..env")).toEqual([]);
    });
    it("a link to ../x outside the project, or to '..' itself, is flagged", () => {
      expect(violationsFor("link", "../x").join()).toMatch(/leaves the project/);
      expect(violationsFor("link", "..").join()).toMatch(/leaves the project/);
    });
  });
});

describe("findProjectForCwd treats '..'-prefixed names as children", () => {
  it("matches ..work children, rejects siblings, longest nested project wins", () => {
    env = makeEnv();
    const { home, repo } = env;
    for (const sub of ["..work", path.join("x", "..work")]) {
      const cwd = path.join(repo, sub);
      fs.mkdirSync(cwd, { recursive: true });
      expect(findProjectForCwd(home, cwd)).toBe("demo");
    }
    const other = path.join(repo, "..", "other");
    fs.mkdirSync(other, { recursive: true });
    expect(findProjectForCwd(home, other)).toBeUndefined();

    const inner = path.join(repo, "pkg");
    fs.mkdirSync(path.join(inner, "..x"), { recursive: true });
    addProject(home, "inner", inner);
    expect(findProjectForCwd(home, path.join(inner, "..x"))).toBe("inner");
    expect(findProjectForCwd(home, path.join(repo, "..work"))).toBe("demo");
  });
});
