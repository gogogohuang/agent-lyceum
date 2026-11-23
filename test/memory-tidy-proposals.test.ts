import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeResult } from "../src/adapters/index.js";
import { fingerprint, restoreMemory, tidyMemory } from "../src/memory-tidy.js";
import { proposalsDir } from "../src/policy.js";
import { makeMemoryEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const now = () => new Date("2026-11-23T10:00:00Z");
const prop = (fm: string, date = "2026-01-01") => `---\n${fm}\ndate: ${date}\ntitle: T-${fm.length}\nproposed_by: fe-member\nrun: r\nevidence:\n  - mail: m1\n---\nfacts\n`;
const OLD = "status: rejected\nreject_reason: no\ndecided: 2026-10-01"; // 53 days before now
const RECENT = "status: accepted\naccepted_as: lessons/x\ndecided: 2026-11-20"; // 3 days before now
const PENDING = "status: proposed";

function seed() {
  env = makeMemoryEnv();
  const p = env.project();
  const at = (kind: string, name: string) => path.join(proposalsDir(p), kind, `${name}.md`);
  write(at("lessons", "ab12cd34-old"), prop(OLD));
  write(at("lessons", "ab12cd34-recent"), prop(RECENT, "2026-01-01")); // proposed long ago, decided just now
  write(at("decisions", "ab12cd34-wait"), prop(PENDING, "2026-01-01"));
  return { p, at };
}
const archiveDirOf = (prompt: string) => /^Proposals archive directory: (.*)$/m.exec(prompt)![1]!;
const archiveFile = (dir: string, rel: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
};
const tidy = (p: ReturnType<TestEnv["project"]>, invoker: Invoker) => tidyMemory({ project: p, layer: "project", agent: "lead", invoker, say: () => {}, now });

describe("tidy of the proposals (spec 30, D-12)", () => {
  it("tidies a project that has only proposals, marks what may be archived by the decision date, and archives it", async () => {
    const { p, at } = seed();
    let prompt = "";
    const res = await tidy(p, async (i) => {
      prompt = i.userPrompt;
      const arc = archiveDirOf(i.userPrompt);
      archiveFile(arc, "lessons/x");
      fs.renameSync(at("lessons", "ab12cd34-old"), path.join(arc, "lessons", "ab12cd34-old.md"));
      write(path.join(arc, "tidy-report.md"), "## Archived\nold one\n\n## Unsure\nNone\n");
      return OK;
    });
    expect(res[0]).toMatchObject({ status: "tidied", problems: [], proposalsDir: proposalsDir(p) });
    expect(prompt).toContain("# Proposals");
    expect(prompt).toMatch(/lessons\/ab12cd34-old\.md .*\[ELIGIBLE\]/);
    expect(prompt).not.toMatch(/ab12cd34-recent\.md .*\[ELIGIBLE\]/); // decided 3 days ago, though proposed in January
    expect(prompt).not.toMatch(/ab12cd34-wait\.md .*\[ELIGIBLE\]/);
    expect(fs.existsSync(at("lessons", "ab12cd34-old"))).toBe(false);
    expect(fs.existsSync(at("lessons", "ab12cd34-recent"))).toBe(true);
    expect(fs.existsSync(at("decisions", "ab12cd34-wait"))).toBe(true);
  });

  it("does nothing, and wakes nobody, when there are no proposals, records or memory", async () => {
    env = makeMemoryEnv();
    let woken = false;
    await tidy(env.project(), async () => {
      woken = true;
      return OK;
    }).catch(() => undefined);
    expect(woken).toBe(false);
  });

  const rolledBack = async (name: string, act: (arc: string, at: (k: string, n: string) => string) => void, re: RegExp) => {
    const { p, at } = seed();
    const before = fingerprint(proposalsDir(p));
    const res = await tidy(p, async (i) => {
      const arc = archiveDirOf(i.userPrompt);
      fs.mkdirSync(arc, { recursive: true });
      write(path.join(arc, "tidy-report.md"), "## Archived\nx\n\n## Unsure\nNone\n");
      act(arc, at);
      return OK;
    });
    expect(res[0]!.status, name).toBe("failed");
    expect(res[0]!.problems.join("\n"), name).toMatch(re);
    expect(fingerprint(proposalsDir(p)), name).toEqual(before);
  };

  it("rolls everything back when a still-pending proposal is archived", () =>
    rolledBack("pending", (arc, at) => (archiveFile(arc, "decisions/x"), fs.renameSync(at("decisions", "ab12cd34-wait"), path.join(arc, "decisions", "ab12cd34-wait.md"))), /not decided more than 30 days ago/));

  it("rolls everything back when a proposal decided only days ago is archived", () =>
    rolledBack("recent", (arc, at) => (archiveFile(arc, "lessons/x"), fs.renameSync(at("lessons", "ab12cd34-recent"), path.join(arc, "lessons", "ab12cd34-recent.md"))), /not decided more than 30 days ago/));

  it("rolls everything back when a proposal is edited, even a legitimate archive in the same wake", () =>
    rolledBack(
      "edit",
      (arc, at) => {
        archiveFile(arc, "lessons/x");
        fs.renameSync(at("lessons", "ab12cd34-old"), path.join(arc, "lessons", "ab12cd34-old.md"));
        write(at("decisions", "ab12cd34-wait"), prop("status: accepted"));
      },
      /was changed; a tidy may only move proposals/,
    ));

  it("rolls everything back when a proposal is deleted, or the report is missing", async () => {
    await rolledBack("delete", (_arc, at) => fs.rmSync(at("lessons", "ab12cd34-old")), /is gone/);
    const { p } = seed();
    const res = await tidy(p, async () => OK); // no report, nothing moved
    expect(res[0]).toMatchObject({ status: "failed" });
    expect(res[0]!.problems.join("\n")).toMatch(/tidy-report\.md is missing or empty/);
  });

  it("is undone by `tidy --undo`, which moves the proposal back", async () => {
    const { p, at } = seed();
    const res = await tidy(p, async (i) => {
      const arc = archiveDirOf(i.userPrompt);
      archiveFile(arc, "lessons/x");
      fs.renameSync(at("lessons", "ab12cd34-old"), path.join(arc, "lessons", "ab12cd34-old.md"));
      write(path.join(arc, "tidy-report.md"), "## Archived\nold\n\n## Unsure\nNone\n");
      return OK;
    });
    const stamp = res[0]!.archive!;
    expect(fs.existsSync(at("lessons", "ab12cd34-old"))).toBe(false);
    const r = restoreMemory({ project: p, agent: "lead", layer: "project", stamp });
    expect(r.proposals?.restored).toEqual(["lessons/ab12cd34-old.md"]);
    expect(fs.existsSync(at("lessons", "ab12cd34-old"))).toBe(true);
  });

  it("only mentions proposals in the lead's prompt when there are some", async () => {
    env = makeMemoryEnv();
    const p = env.project();
    write(path.join(p.paths.root, "agents", "lead", "memory", "MEMORY.md"), "- [a](a.md)\n");
    write(path.join(p.paths.root, "agents", "lead", "memory", "a.md"), "x");
    let prompt = "";
    await tidy(p, async (i) => {
      prompt = i.systemPrompt + i.userPrompt;
      return OK;
    });
    expect(prompt).not.toMatch(/Proposals|proposals/);
  });
});
