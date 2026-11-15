import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { lintTaskContent } from "../src/task.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const full = "# T\n\n## Scope\nx\n\n## Acceptance criteria\n- a\n\n## Verification\nnpm test\n";

describe("lintTaskContent", () => {
  it("accepts a complete template", () => expect(lintTaskContent(full)).toEqual([]));
  it("warns once when Acceptance is missing", () => {
    const w = lintTaskContent("# T\n\n## Verification\nnpm test\n");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/Acceptance criteria/);
  });
  it("warns once when Verification is missing", () => {
    const w = lintTaskContent("# T\n\n## Acceptance criteria\n- a\n");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/Verification/);
  });
  it("warns twice when both are missing and points to the template", () => {
    const w = lintTaskContent("just do it\n");
    expect(w).toHaveLength(2);
    expect(w.join("\n")).toMatch(/docs\/task-template\.md/);
  });
  it("counts Chinese headings", () => {
    expect(lintTaskContent("# T\n\n## 驗收條件\n- a\n\n## 驗證\nnpm test\n")).toEqual([]);
  });
  it("ignores heading-like lines inside fenced blocks", () => {
    expect(lintTaskContent("# T\n\n```markdown\n## Acceptance criteria\n## Verification\n```\n~~~\n## Verification\n~~~\n")).toHaveLength(2);
  });
  it("counts heading levels 1 to 6", () => {
    for (let n = 1; n <= 6; n++) {
      const h = "#".repeat(n);
      expect(lintTaskContent(`${h} Acceptance\n\n${h} verification steps\n`)).toEqual([]);
    }
  });
  it("does not count the word in body text", () => {
    expect(lintTaskContent("# T\n\nAcceptance and verification are described here.\n- Verification: yes\n")).toHaveLength(2);
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

let env: TestEnv;
afterEach(() => env?.cleanup());

function setup() {
  env = makeEnv();
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const scriptFile = path.join(env.root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify({ calls: [{ agent: "fe-member", mail: [{ type: "done", subject: "r", outcome: "completed" }] }, { agent: "fe-member", mail: [{ type: "done", subject: "r", outcome: "completed" }] }] }));
  const vars = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SCRIPT: scriptFile };
  const sync = (args: string[]) => {
    const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8", env: vars, stdio: ["ignore", "pipe", "pipe"] });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const file = (name: string, body: string) => {
    const p = path.join(env.root, name);
    fs.writeFileSync(p, body);
    return p;
  };
  return { sync, file };
}

describe("task file lint in the CLI", { timeout: 60_000 }, () => {
  it("run --task-file warns on stderr for a bare file and still runs", () => {
    const t = setup();
    const bare = t.sync(["run", "--task-file", t.file("bare.md", "# Do it\n\nplease\n"), "--agent", "fe-member", "-p", "demo"]);
    expect(bare.err).toMatch(/warning: task file .*no Acceptance criteria section/);
    expect(bare.err).toMatch(/warning: task file .*no Verification section/);
    expect(bare.out).not.toMatch(/warning: task file/);
    const ok = t.sync(["run", "--task-file", t.file("ok.md", full), "--agent", "fe-member", "-p", "demo"]);
    expect(ok.err).not.toMatch(/warning: task file/);
    expect(bare.code).toBe(ok.code);
  });

  it("run with inline text never warns", () => {
    const t = setup();
    const r = t.sync(["run", "do it", "--agent", "fe-member", "-p", "demo"]);
    expect(r.err).not.toMatch(/warning: task file/);
  });

  it("doctor --task-file shows warn checks without changing the exit code", () => {
    const t = setup();
    const base = t.sync(["doctor", "-p", "demo", "--task-file", t.file("ok.md", full)]);
    const bare = t.sync(["doctor", "-p", "demo", "--task-file", t.file("bare.md", "# Do it\n")]);
    expect(bare.out).toMatch(/warn\s+task file .*Acceptance criteria/);
    expect(bare.out).toMatch(/warn\s+task file .*Verification/);
    expect(base.out).not.toMatch(/task file .*Acceptance criteria section/);
    expect(bare.code).toBe(base.code);
  });
});
