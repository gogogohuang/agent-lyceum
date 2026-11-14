import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runShip, type ShipVerifyRunner } from "../src/ship.js";

let root: string;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function tmp(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-ship-"));
  return root;
}

function write(rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

const passVerify: ShipVerifyRunner = async () => ({ ok: true, exit: 0, output: "ok\n" });
const failVerify: ShipVerifyRunner = async () => ({ ok: false, exit: 1, output: "FAIL\n" });

describe("runShip", () => {
  it("applies edits and keeps them when verify passes", async () => {
    tmp();
    write("a.ts", "export const x = 1;\n");
    write("b.ts", "import { x } from './a.js';\n");
    const r = await runShip({
      root,
      edits: [
        { path: "a.ts", search: "export const x = 1;", replace: "export const x = 2;" },
        { path: "b.ts", search: "import { x } from './a.js';", replace: "import { x } from './a.js'; // ok" },
      ],
      verify: "true",
      runVerify: passVerify,
    });
    expect(r.status).toBe("SHIPPED_AND_VERIFIED");
    expect(r.filesModified.sort()).toEqual(["a.ts", "b.ts"]);
    expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toBe("export const x = 2;\n");
    expect(fs.readFileSync(path.join(root, "b.ts"), "utf8")).toContain("// ok");
  });

  it("rolls back every file when verify fails", async () => {
    tmp();
    write("a.ts", " const a = 1;\n");
    write("b.ts", "const b = 1;\n");
    const beforeA = fs.readFileSync(path.join(root, "a.ts"));
    const beforeB = fs.readFileSync(path.join(root, "b.ts"));
    const r = await runShip({
      root,
      edits: [
        { path: "a.ts", search: "const a = 1;", replace: "const a = 99;" },
        { path: "b.ts", search: "const b = 1;", replace: "const b = 99;" },
      ],
      verify: "false",
      runVerify: failVerify,
    });
    expect(r.status).toBe("FAILED_AND_ROLLED_BACK");
    expect(r.summary).toContain("FAIL");
    expect(fs.readFileSync(path.join(root, "a.ts"))).toEqual(beforeA);
    expect(fs.readFileSync(path.join(root, "b.ts"))).toEqual(beforeB);
  });

  it("aborts with no writes when search is missing", async () => {
    tmp();
    write("a.ts", "hello\n");
    const before = fs.readFileSync(path.join(root, "a.ts"));
    const r = await runShip({
      root,
      edits: [{ path: "a.ts", search: "missing", replace: "x" }],
      verify: "true",
      runVerify: passVerify,
    });
    expect(r.status).toBe("ABORTED_BEFORE_WRITE");
    expect(fs.readFileSync(path.join(root, "a.ts"))).toEqual(before);
  });

  it("rejects paths that escape the root", async () => {
    tmp();
    write("a.ts", "x\n");
    const r = await runShip({
      root,
      edits: [{ path: "../outside.ts", search: "x", replace: "y" }],
      verify: "true",
      runVerify: passVerify,
    });
    expect(r.status).toBe("ABORTED_BEFORE_WRITE");
    expect(r.summary.toLowerCase()).toMatch(/outside|escape|root/);
  });

  it("replace_all replaces every exact occurrence", async () => {
    tmp();
    write("a.ts", "foo\nfoo\n");
    const r = await runShip({
      root,
      edits: [{ path: "a.ts", search: "foo", replace: "bar", replace_all: true }],
      verify: "true",
      runVerify: passVerify,
    });
    expect(r.status).toBe("SHIPPED_AND_VERIFIED");
    expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toBe("bar\nbar\n");
  });

  it("refuses ambiguous search without replace_all", async () => {
    tmp();
    write("a.ts", "foo\nfoo\n");
    const r = await runShip({
      root,
      edits: [{ path: "a.ts", search: "foo", replace: "bar" }],
      verify: "true",
      runVerify: passVerify,
    });
    expect(r.status).toBe("ABORTED_BEFORE_WRITE");
    expect(r.summary.toLowerCase()).toMatch(/ambiguous|2/);
  });

  it("refuses paths on the deny list", async () => {
    tmp();
    write("CLAUDE.md", "keep\n");
    const denied = path.join(root, "CLAUDE.md");
    const r = await runShip({
      root,
      edits: [{ path: "CLAUDE.md", search: "keep", replace: "gone" }],
      verify: "true",
      deny: [denied],
      runVerify: passVerify,
    });
    expect(r.status).toBe("ABORTED_BEFORE_WRITE");
    expect(r.summary).toMatch(/denied/);
    expect(fs.readFileSync(denied, "utf8")).toBe("keep\n");
  });

  it("rolls back earlier files when a later write fails", async () => {
    tmp();
    write("a.ts", "const a = 1;\n");
    write("b.ts", "const b = 1;\n");
    const beforeA = fs.readFileSync(path.join(root, "a.ts"));
    const beforeB = fs.readFileSync(path.join(root, "b.ts"));
    const realRename = fs.renameSync;
    let renames = 0;
    const spy = ((...args: Parameters<typeof fs.renameSync>) => {
      renames++;
      if (renames === 2) throw new Error("disk full");
      return realRename(...args);
    }) as typeof fs.renameSync;
    const orig = fs.renameSync;
    fs.renameSync = spy;
    try {
      const r = await runShip({
        root,
        edits: [
          { path: "a.ts", search: "const a = 1;", replace: "const a = 9;" },
          { path: "b.ts", search: "const b = 1;", replace: "const b = 9;" },
        ],
        verify: "true",
        runVerify: passVerify,
      });
      expect(r.status).toBe("FAILED_AND_ROLLED_BACK");
      expect(r.summary).toMatch(/disk full/);
    } finally {
      fs.renameSync = orig;
    }
    expect(fs.readFileSync(path.join(root, "a.ts"))).toEqual(beforeA);
    expect(fs.readFileSync(path.join(root, "b.ts"))).toEqual(beforeB);
  });

  it("refuses symlink paths", async () => {
    tmp();
    write("real.ts", "const x = 1;\n");
    fs.symlinkSync(path.join(root, "real.ts"), path.join(root, "alias.ts"));
    const r = await runShip({
      root,
      edits: [{ path: "alias.ts", search: "const x = 1;", replace: "const x = 2;" }],
      verify: "true",
      runVerify: passVerify,
    });
    expect(r.status).toBe("ABORTED_BEFORE_WRITE");
    expect(r.summary).toMatch(/symlink/);
    expect(fs.readFileSync(path.join(root, "real.ts"), "utf8")).toBe("const x = 1;\n");
  });
});
