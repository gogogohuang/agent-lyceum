import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import { callAgent } from "../src/call.js";
import { acquireProjectLock, listRunLocks } from "../src/project-lock.js";
import { proposalsDir, recordsKindDir } from "../src/policy.js";
import { shortIdOf } from "../src/proposals.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const ok: WakeResult = { ok: true, text: "answer", exitCode: 0, timedOut: false };
const opts = (invoker: Invoker, over: Partial<Parameters<typeof callAgent>[0]> = {}) => ({ home: env.home, agent: "fe-member", task: "look around", dir: env.repo, invoker, say: () => {}, ...over });
const prefixIn = (systemPrompt: string) => /`([a-z0-9]{8})-<slug>\.md`/.exec(systemPrompt)?.[1];
const prop = (run: string, title = "T") => `---\nstatus: proposed\ndate: 2026-11-23\ntitle: ${title}\nproposed_by: x\nrun: ${run}\nevidence:\n  - mail: m1\n---\nfacts\n`;
const record = (p: ReturnType<TestEnv["project"]>, id: string, title: string) => write(path.join(recordsKindDir(p, "lessons"), `${id}.md`), `---\nstatus: active\ndate: 2026-11-01\ntitle: ${title}\n---\nbody-never-shown\n`);

describe("call -p (spec 30)", () => {
  it("fails with a clear error when the project does not exist, before waking anyone", async () => {
    env = makeEnv();
    let woken = false;
    await expect(callAgent(opts(async () => ((woken = true), ok), { project: "nope" }))).rejects.toThrow(/Project "nope" config not found/);
    expect(woken).toBe(false);
  });

  it("gives the agent the real project's proposals folder, a fixed prefix from its call id, and the titles (not the bodies) of the existing records", async () => {
    env = makeEnv();
    const p = env.project();
    record(p, "use-sqlite", "Use sqlite for the cache");
    let seen: WakeInput | undefined;
    const r = await callAgent(opts(async (i) => ((seen = i), ok), { project: "demo" }));
    expect(r.ok).toBe(true);
    expect(prefixIn(seen!.systemPrompt)).toBe(shortIdOf(r.callId));
    expect(seen!.systemPrompt).toContain(`${proposalsDir(p)}/lessons/`);
    expect(seen!.systemPrompt).not.toMatch(/handoff notes/);
    expect(seen!.userPrompt).toContain("- [lessons/use-sqlite] Use sqlite for the cache");
    expect(seen!.userPrompt).not.toContain("body-never-shown");
    expect(fs.statSync(proposalsDir(p)).isDirectory()).toBe(true);
  });

  it("holds a non-exclusive, call-marked project lock while it works, and lets go afterwards; proposals review's exclusive lock must wait", async () => {
    env = makeEnv();
    const p = env.project();
    let during: ReturnType<typeof listRunLocks> = [];
    let tryExclusive = "";
    const r = await callAgent(
      opts(async () => {
        during = listRunLocks(p.paths.root);
        try {
          acquireProjectLock(p.paths.root, "tidy-1", { exclusive: true }).release();
        } catch (e) {
          tryExclusive = (e as Error).message;
        }
        return ok;
      }, { project: "demo" }),
    );
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ run_id: r.callId, call: true });
    expect(during[0]!.exclusive).toBeUndefined();
    expect(tryExclusive).toMatch(/needs the project to itself/);
    expect(listRunLocks(p.paths.root)).toEqual([]);
  });

  it("keeps a proposal with its own prefix, removes one with another prefix, and reverts a write to the real records, keeping the rejected copy", async () => {
    env = makeEnv();
    const p = env.project();
    let mine = "";
    const rec = path.join(recordsKindDir(p, "lessons"), "sneaky.md");
    const r = await callAgent(
      opts(async (i) => {
        const pre = prefixIn(i.systemPrompt)!;
        mine = path.join(proposalsDir(p), "lessons", `${pre}-ok.md`);
        write(mine, prop("r"));
        write(path.join(proposalsDir(p), "lessons", "ffffffff-theirs.md"), prop("r"));
        write(rec, "---\nstatus: active\ndate: 2026-11-23\ntitle: S\n---\nx\n");
        return ok;
      }, { project: "demo" }),
    );
    expect(fs.existsSync(mine)).toBe(true);
    expect(fs.existsSync(path.join(proposalsDir(p), "lessons", "ffffffff-theirs.md"))).toBe(false);
    expect(fs.existsSync(rec)).toBe(false);
    expect(r.reverted.sort()).toEqual([path.join(proposalsDir(p), "lessons", "ffffffff-theirs.md"), rec].sort());
    expect(fs.readdirSync(path.join(r.callDir, "guard-violations")).length).toBe(2);
  });

  it("does not revert what another run's lead writes meanwhile, even when that run began and ended inside the call", async () => {
    env = makeEnv();
    const p = env.project();
    const rec = path.join(recordsKindDir(p, "lessons"), "from-the-lead.md");
    const r = await callAgent(
      opts(async () => {
        fs.mkdirSync(path.join(p.paths.runs, "29990101T000000000Z-aaaaaaaa"), { recursive: true });
        write(rec, "---\nstatus: active\ndate: 2026-11-23\ntitle: L\n---\nx\n");
        return ok;
      }, { project: "demo" }),
    );
    expect(fs.existsSync(rec)).toBe(true);
    expect(r.reverted).toEqual([]);
  });

  it("lets two calls to different agents each keep their own proposal, not counting one another's as a violation", async () => {
    env = makeEnv();
    const p = env.project();
    const written: Record<string, string> = {};
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let arrived = 0;
    const invokerFor = (name: string): Invoker => async (i) => {
      const pre = prefixIn(i.systemPrompt)!;
      written[name] = path.join(proposalsDir(p), "lessons", `${pre}-${name}.md`);
      write(written[name], prop("r", name));
      if (++arrived === 2) release();
      await gate; // both have written before either finishes
      return ok;
    };
    const [a, b] = await Promise.all([
      callAgent(opts(invokerFor("fe-member"), { project: "demo", agent: "fe-member" })),
      callAgent(opts(invokerFor("qa-member"), { project: "demo", agent: "qa-member" })),
    ]);
    expect(a.reverted).toEqual([]);
    expect(b.reverted).toEqual([]);
    expect(Object.values(written).every((f) => fs.existsSync(f))).toBe(true);
  });

  it("a call with no -p gets no proposals section, takes no project lock and touches no project", async () => {
    env = makeEnv();
    const p = env.project();
    let seen: WakeInput | undefined;
    let locks = -1;
    await callAgent(opts(async (i) => ((seen = i), (locks = listRunLocks(p.paths.root).length), ok)));
    expect(seen!.systemPrompt).not.toContain("## Proposals");
    expect(seen!.userPrompt).not.toContain("existing_records");
    expect(locks).toBe(0);
    expect(fs.existsSync(proposalsDir(p))).toBe(false);
  });
});
