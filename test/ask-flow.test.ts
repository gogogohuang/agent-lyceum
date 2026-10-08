import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readAskReply, writeAskReply } from "../src/ask-reply.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

let env: TestEnv;
afterEach(() => env?.cleanup());

const ASK = `<ask><question id="q1"><text>JWT?</text><options><option>session</option><option>jwt</option></options><suggested reason="cookies">session</suggested></question><question id="q2"><text>old API?</text></question></ask>`;

function setup(script: object) {
  env = makeEnv();
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const scriptFile = path.join(env.root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  const base = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SCRIPT: scriptFile };
  const sync = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8", env: { ...base, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { sync };
}
const runDirOf = () => {
  const root = env.project().paths.runs;
  return path.join(root, fs.readdirSync(root)[0]!);
};
const fillAll = (dir: string, values: Record<string, string>) => {
  const r = readAskReply(dir)!;
  writeAskReply(dir, { ...r, questions: r.questions.map((q) => (values[q.id] ? { ...q, answer: { value: values[q.id]!, by: "user" as const } } : q)) });
};

const SCRIPT = {
  calls: [
    { agent: "lead", mail: [{ type: "ask", subject: "need input", body: ASK }] },
    { agent: "lead", mail: [{ to: "lead", type: "done", subject: "shipped", outcome: "completed" }] },
  ],
};

describe("ask → waiting → answer → completed", () => {
  it("exits 3 with the file path, refuses answer --no-edit until complete, then finishes", () => {
    const t = setup(SCRIPT);
    const first = t.sync(["run", "build it", "-p", "demo"]);
    expect(first.code).toBe(3);
    expect(first.out).toContain("ask-reply.md");
    expect(first.out).toMatch(/waiting/i);

    const dir = runDirOf();
    const status = JSON.parse(t.sync(["status", "-p", "demo", "--json"]).out);
    expect(status.run).toMatchObject({ state: "waiting", end_reason: "waiting", outcome: "waiting" });
    expect(status.run.ask).toMatchObject({ total: 2, unanswered: 2 });

    const early = t.sync(["answer", path.basename(dir), "-p", "demo", "--no-edit"]);
    expect(early.code).toBe(3);
    expect(early.err + early.out).toMatch(/q1/);
    expect(early.err + early.out).toMatch(/q2/);
    expect(t.sync(["resume", path.basename(dir), "-p", "demo"]).code).toBe(3); // resume refuses too

    fillAll(dir, { q1: "jwt", q2: "no" });
    const done = t.sync(["answer", path.basename(dir), "-p", "demo", "--no-edit"]);
    expect(done.code).toBe(0);
    expect(done.out).toMatch(/outcome: completed/);
    expect(readAskReply(dir)?.status).toBe("answered");
  });

  it("lets plain `resume` continue once the file is filled in by hand", () => {
    const t = setup(SCRIPT);
    t.sync(["run", "build it", "-p", "demo"]);
    const dir = runDirOf();
    fillAll(dir, { q1: "other: oauth", q2: "yes" });
    expect(t.sync(["resume", "-p", "demo"]).code).toBe(0);
  });

  it("`answer` without --no-edit opens $EDITOR on the file and validates what it saved", () => {
    const t = setup(SCRIPT);
    t.sync(["run", "build it", "-p", "demo"]);
    const dir = runDirOf();
    const editor = path.join(env.root, "editor.mjs");
    fs.writeFileSync(editor, `import fs from "node:fs";\nconst f = process.argv[2];\nlet t = fs.readFileSync(f, "utf8");\nt = t.replace(/<answer><\\/answer>/g, "<answer>jwt</answer>");\nfs.writeFileSync(f, t);\n`);
    const r = t.sync(["answer", path.basename(dir), "-p", "demo"], { EDITOR: `${process.execPath} ${editor}` });
    // q1 accepts "jwt"; q2 is open-ended so "jwt" is a valid free answer too
    expect(r.code).toBe(0);
  });
});

describe("--assume-defaults", () => {
  it("uses suggestions (marked by=default) but still waits for questions without one", () => {
    const t = setup(SCRIPT);
    t.sync(["run", "build it", "-p", "demo"]);
    const dir = runDirOf();
    const r = t.sync(["answer", path.basename(dir), "-p", "demo", "--no-edit", "--assume-defaults"]);
    expect(r.code).toBe(3);
    const file = readAskReply(dir)!;
    expect(file.questions[0]?.answer).toEqual({ value: "session", by: "default" });
    expect(file.questions[1]?.answer).toBeUndefined();
    expect(r.err + r.out).toMatch(/q2/);
  });

  it("`run --assume-defaults` goes straight on when every question has a suggestion", () => {
    const allSuggested = `<ask><question id="q1"><text>JWT?</text><suggested>session</suggested></question></ask>`;
    const t = setup({
      calls: [
        { agent: "lead", mail: [{ type: "ask", subject: "s", body: allSuggested }] },
        { agent: "lead", mail: [{ to: "lead", type: "done", subject: "shipped", outcome: "completed" }] },
      ],
    });
    const r = t.sync(["run", "build it", "-p", "demo", "--assume-defaults"]);
    expect(r.code).toBe(0);
    expect(readAskReply(runDirOf())?.questions[0]?.answer).toEqual({ value: "session", by: "default" });
  });
});
