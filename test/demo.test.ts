import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProject } from "../src/config.js";
import { prepareDemo } from "../src/demo.js";
import { validateProject } from "../src/validate.js";
import { git } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

let tmp: string;
const fresh = () => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lyceum-demo-test-")));
afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

describe("prepareDemo", () => {
  it("builds a committed repo with a failing test and a valid project using one runtime", () => {
    const d = prepareDemo(path.join(fresh(), "box"), "codex");
    expect(git(d.repo, "log", "--oneline")).toMatch(/slugify is not implemented/);
    expect(git(d.repo, "status", "--porcelain")).toBe("");
    const test = spawnSync("npm", ["test"], { cwd: d.repo, encoding: "utf8" });
    expect(test.status).not.toBe(0);

    const pr = resolveProject(d.home, "demo");
    expect(Object.values(pr.agents).map((a) => a.runtime)).toEqual(["codex", "codex", "codex"]);
    expect(validateProject(pr).issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("refuses a directory that already has files, and writes nothing outside it", () => {
    const root = fresh();
    fs.writeFileSync(path.join(root, "keep.txt"), "x");
    expect(() => prepareDemo(root, "claude-code")).toThrow(/not empty/);
    expect(fs.readdirSync(root)).toEqual(["keep.txt"]);
  });
});

describe("demo command", { timeout: 60_000 }, () => {
  function run(args: string[], script?: object) {
    const root = fresh();
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENT_LYCEUM_HOME: path.join(root, "unused-home") };
    if (script) {
      fs.writeFileSync(path.join(root, "script.json"), JSON.stringify(script));
      env.FAKE_SCRIPT = path.join(root, "script.json");
    }
    const r = spawnSync(tsx, [cli, "demo", "--dir", path.join(root, "box"), ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    return { code: r.status, out: r.stdout, err: r.stderr, box: path.join(root, "box"), root };
  }

  it("--setup-only prepares the sandbox, runs no agent and leaves the real home alone", () => {
    const r = run(["--setup-only"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Run the team yourself/);
    expect(fs.existsSync(path.join(r.box, "repo", "src", "slug.js"))).toBe(true);
    expect(fs.readFileSync(path.join(r.box, "task.md"), "utf8")).toMatch(/slugify/);
    expect(fs.existsSync(path.join(r.root, "unused-home"))).toBe(false);
  });

  it("runs the team to done with the detected runtime", () => {
    const r = run(["--yes"], { calls: [{ agent: "lead", mail: [{ to: "lead", type: "done", subject: "slugify works", outcome: "completed" }] }] });
    expect(r.out + r.err).toMatch(/Done\. See what happened/);
    expect(r.code).toBe(0);
  });

  it("rejects an unknown runtime", () => {
    const r = run(["--setup-only", "--runtime", "gpt"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Unknown runtime/);
  });
});
