import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProjectDirs, routeOutboxes, type InstanceRouting } from "../src/mailbox.js";
import { RouteJournal, setFaultHook } from "../src/message-store.js";
import { inboxDir, outboxDir } from "../src/policy.js";
import { bindRunProject } from "../src/run-store.js";
import { makeEnv, withSections, write, type TestEnv } from "./helpers.js";

// Spec 23.7.1 (routing with held mail), 23.3 (who may set `parallel`), D-02, D-15, R3/R4 at the router.

let env: TestEnv;
afterEach(() => env?.cleanup());

const INSTANCES = { roles: { "fe-member": ["fe-member", "fe-member--2"] } };

function setup(opts: { table?: typeof INSTANCES; cap?: number; capReason?: string; memberMayMessage?: boolean } = {}) {
  env = makeEnv();
  if (opts.memberMayMessage) env.editProjectYaml((t) => t.replace("  qa-member:\n    can_message: [lead]", "  qa-member:\n    can_message: [lead, fe-member]"));
  const runDir = path.join(env.project().paths.runs, "run-1");
  const project = bindRunProject(env.project(), runDir, "run", opts.table);
  ensureProjectDirs(project);
  const held = new Set<string>(opts.table ? Object.keys(opts.table.roles) : []);
  const calls: string[] = [];
  const ignored: { reason: string; to: string }[] = [];
  const routing: InstanceRouting = {
    cap: () => ({ n: opts.cap ?? 4, ...(opts.capReason ? { reason: opts.capReason } : {}) }),
    held: (r) => held.has(r),
    enable: (r) => {
      calls.push(`enable:${r}`);
      // what the dispatcher guarantees: the slot table is durable before any file of the mail is written
      calls.push(`files-at-enable:${countMd(inboxDir(project, r))}`);
      held.add(r);
    },
    ignored: (reason, m) => ignored.push({ reason, to: m.to }),
  };
  return { project, runDir, routing, calls, ignored, held };
}

const countMd = (dir: string): number => {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countMd(path.join(dir, e.name)) : e.name.endsWith(".md") ? 1 : 0;
  return n;
};
const mdIn = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : []);
const journalLines = (runDir: string): Record<string, unknown>[] =>
  fs.readFileSync(path.join(runDir, "mail", "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
let n = 0;
const outbox = (project: ReturnType<typeof setup>["project"], from: string, to: string, front: string, type = "task", subject = `job ${++n}`) =>
  write(path.join(outboxDir(project, from), `m${n}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${front}---\n\n${withSections(type, `unique body ${n} for ${subject} ${Math.random()}`)}\n`);

describe("a lead's parallel task activates the role before any file of the mail is written", () => {
  it("calls enable once, with nothing yet in the role's inbox, and delivers into pending/ with held+parallel in the journal", () => {
    const s = setup();
    outbox(s.project, "lead", "fe-member", "parallel: true\n");
    const r = routeOutboxes(s.project, s.routing);
    expect(s.calls).toEqual(["enable:fe-member", "files-at-enable:0"]);
    expect(r.delivered).toHaveLength(1);
    expect(mdIn(inboxDir(s.project, "fe-member"))).toEqual([]);
    expect(mdIn(path.join(inboxDir(s.project, "fe-member"), "pending"))).toHaveLength(1);
    const intent = journalLines(s.runDir).find((l) => l.t === "intent");
    expect(intent).toMatchObject({ to: "fe-member", held: true, parallel: true });
    expect(intent).not.toHaveProperty("from"); // the lead's role has no instances
    // the delivered mail itself carries no `parallel` (decision: the flag lives in the journal only)
    const file = path.join(inboxDir(s.project, "fe-member"), "pending", mdIn(path.join(inboxDir(s.project, "fe-member"), "pending"))[0] as string);
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/parallel/);
  });

  it("a second parallel task does not enable again", () => {
    const s = setup();
    outbox(s.project, "lead", "fe-member", "parallel: true\n");
    outbox(s.project, "lead", "fe-member", "parallel: true\n");
    routeOutboxes(s.project, s.routing);
    expect(s.calls.filter((c) => c.startsWith("enable"))).toHaveLength(1);
    expect(mdIn(path.join(inboxDir(s.project, "fe-member"), "pending"))).toHaveLength(2);
  });
});

describe("T-R4: only the lead can start parallel instances", () => {
  it("T-R4-1: a member's `parallel: true` is delivered as an ordinary task, ignored with reason not-lead, nothing is held", () => {
    const s = setup({ memberMayMessage: true });
    outbox(s.project, "qa-member", "fe-member", "parallel: true\n");
    routeOutboxes(s.project, s.routing);
    expect(s.calls).toEqual([]);
    expect(s.ignored).toEqual([{ reason: "not-lead", to: "fe-member" }]);
    expect(mdIn(inboxDir(s.project, "fe-member"))).toHaveLength(1);
    expect(fs.existsSync(path.join(inboxDir(s.project, "fe-member"), "pending"))).toBe(false);
    const intent = journalLines(s.runDir).find((l) => l.t === "intent") as Record<string, unknown>;
    expect(intent).not.toHaveProperty("held");
    expect(intent).not.toHaveProperty("parallel");
  });

  it("T-R4-2: a member's `parallel: \"yes\"` is not rejected either", () => {
    const s = setup({ memberMayMessage: true });
    outbox(s.project, "qa-member", "fe-member", 'parallel: "yes"\n');
    const r = routeOutboxes(s.project, s.routing);
    expect(r.rejected).toEqual([]);
    expect(r.delivered).toHaveLength(1);
    expect(s.ignored[0]?.reason).toBe("not-lead");
  });

  it("T-R4-3: after activation a member's `parallel: true` task is held without `parallel` in the journal", () => {
    const s = setup({ table: INSTANCES, memberMayMessage: true });
    outbox(s.project, "qa-member", "fe-member", "parallel: true\n");
    routeOutboxes(s.project, s.routing);
    const intent = journalLines(s.runDir).find((l) => l.t === "intent") as Record<string, unknown>;
    expect(intent).toMatchObject({ held: true });
    expect(intent).not.toHaveProperty("parallel");
    expect(s.ignored[0]?.reason).toBe("not-lead");
  });
});

describe("the lead's mistakes with `parallel` (D-02)", () => {
  it("a non-boolean value is sent back", () => {
    const s = setup();
    outbox(s.project, "lead", "fe-member", 'parallel: "yes"\n');
    const r = routeOutboxes(s.project, s.routing);
    expect(r.delivered).toEqual([]);
    expect(r.rejected[0]?.reason).toMatch(/parallel must be true or false/);
    expect(s.calls).toEqual([]);
  });

  it("`parallel: true` on a reply (reply_to) is delivered as an ordinary mail and noted", () => {
    const s = setup();
    outbox(s.project, "lead", "fe-member", "reply_to: abc123\nparallel: true\n");
    const r = routeOutboxes(s.project, s.routing);
    expect(r.delivered).toHaveLength(1);
    expect(s.ignored[0]?.reason).toBe("not-a-new-task");
    expect(s.calls).toEqual([]);
    expect(mdIn(inboxDir(s.project, "fe-member"))).toHaveLength(1);
  });

  it("a role whose cap is 1 ignores it with the cap's reason, mail goes to the member's inbox, no activation", () => {
    const s = setup({ cap: 1, capReason: "agents take turns in the checkout" });
    outbox(s.project, "lead", "fe-member", "parallel: true\n");
    routeOutboxes(s.project, s.routing);
    expect(s.ignored[0]?.reason).toMatch(/one at a time.*agents take turns in the checkout/);
    expect(s.calls).toEqual([]);
    expect(mdIn(inboxDir(s.project, "fe-member"))).toHaveLength(1);
  });
});

describe("held roles: every mail to the role or one of its instances waits in pending/ (D-07, D-15, R3)", () => {
  it("an unflagged task to the role and a task addressed to an instance both go to the role's pending/", () => {
    const s = setup({ table: INSTANCES });
    outbox(s.project, "lead", "fe-member", "");
    outbox(s.project, "lead", "fe-member--2", "");
    routeOutboxes(s.project, s.routing);
    expect(mdIn(inboxDir(s.project, "fe-member--2"))).toEqual([]);
    expect(mdIn(inboxDir(s.project, "fe-member"))).toEqual([]);
    expect(mdIn(path.join(inboxDir(s.project, "fe-member"), "pending"))).toHaveLength(2);
    const intents = journalLines(s.runDir).filter((l) => l.t === "intent");
    expect(intents.map((i) => i.to).sort()).toEqual(["fe-member", "fe-member--2"]); // the journal keeps the name on the mail
    expect(intents.every((i) => i.held === true)).toBe(true);
  });

  it("a mail from an instance records `from`, instance 1 included", () => {
    const s = setup({ table: INSTANCES });
    outbox(s.project, "fe-member--2", "lead", "", "reply");
    outbox(s.project, "fe-member", "lead", "", "reply");
    routeOutboxes(s.project, s.routing);
    const intents = journalLines(s.runDir).filter((l) => l.t === "intent");
    expect(intents.map((i) => i.from).sort()).toEqual(["fe-member", "fe-member--2"]);
    expect(intents.every((i) => i.held === undefined)).toBe(true); // to the lead: delivered directly
    expect(mdIn(inboxDir(s.project, "lead"))).toHaveLength(2);
  });

  it("an instance cannot message another instance of its role, in either direction", () => {
    const s = setup({ table: INSTANCES });
    outbox(s.project, "fe-member--2", "fe-member", "", "reply");
    outbox(s.project, "fe-member", "fe-member--2", "", "reply");
    const r = routeOutboxes(s.project, s.routing);
    expect(r.delivered).toEqual([]);
    expect(r.rejected.map((x) => x.reason).every((x) => /another instance of your own role/.test(x))).toBe(true);
    expect(r.rejected).toHaveLength(2);
  });

  it("an instance can message other roles (the qa member), and instance names that are not open are unknown agents", () => {
    const s = setup({ table: INSTANCES, memberMayMessage: true });
    outbox(s.project, "fe-member--2", "lead", "", "reply");
    outbox(s.project, "lead", "fe-member--3", "");
    const r = routeOutboxes(s.project, s.routing);
    expect(r.delivered).toHaveLength(1);
    expect(r.rejected[0]?.reason).toMatch(/no such agent "fe-member--3"/);
  });

  it("a duplicate of mail already sitting in another instance's inbox is caught", () => {
    const s = setup({ table: INSTANCES });
    const body = withSections("task", "exactly the same text for both, long enough to compare");
    const send = (name: string) => write(path.join(outboxDir(s.project, "lead"), name), `---\nto: fe-member\ntype: task\nsubject: same\n---\n\n${body}\n`);
    send("a.md");
    routeOutboxes(s.project, s.routing);
    const pending = path.join(inboxDir(s.project, "fe-member"), "pending");
    // the assigner moved it to instance 2 and it was read
    const f = mdIn(pending)[0] as string;
    fs.mkdirSync(path.join(inboxDir(s.project, "fe-member--2"), "read"), { recursive: true });
    fs.renameSync(path.join(pending, f), path.join(inboxDir(s.project, "fe-member--2"), "read", f));
    send("b.md");
    const r = routeOutboxes(s.project, s.routing);
    expect(r.delivered).toEqual([]);
    expect(r.rejected[0]?.reason).toMatch(/duplicate/);
  });

  it("dispatcher mail to an instance (a rejection notice) is written straight into its inbox, not held", () => {
    const s = setup({ table: INSTANCES });
    write(path.join(outboxDir(s.project, "fe-member--2"), "bad.md"), "no frontmatter at all");
    routeOutboxes(s.project, s.routing);
    expect(mdIn(inboxDir(s.project, "fe-member--2"))).toHaveLength(1);
    expect(fs.existsSync(path.join(inboxDir(s.project, "fe-member"), "pending"))).toBe(false);
  });
});

describe("replay of held deliveries (23.8)", () => {
  it("a replay writes the same pending file; if the file was already assigned away it is not written again", () => {
    const s = setup({ table: INSTANCES });
    outbox(s.project, "lead", "fe-member", "");
    const file = path.join(outboxDir(s.project, "lead"), `m${n}.md`);
    const copy = fs.readFileSync(file, "utf8");
    const mtime = fs.statSync(file).mtime;
    routeOutboxes(s.project, s.routing);
    const pending = path.join(inboxDir(s.project, "fe-member"), "pending");
    const f = mdIn(pending)[0] as string;
    const before = fs.readFileSync(path.join(pending, f), "utf8");
    // the assigner placed it (journal assign + move) but the outbox file was never archived (crash before source-done)
    const j = new RouteJournal(s.runDir);
    const entry = j.byFile(f);
    expect(entry?.delivered).toBe(true);
    j.assign({ msg_id: entry?.msg_id as string, file: f, role: "fe-member", slot: "fe-member--2" });
    fs.renameSync(path.join(pending, f), path.join(inboxDir(s.project, "fe-member--2"), f));
    fs.rmSync(path.join(outboxDir(s.project, "lead"), "sent"), { recursive: true, force: true });
    write(file, copy);
    fs.utimesSync(file, mtime, mtime); // the same outbox file, as after a crash before it was archived
    const r = routeOutboxes(s.project, s.routing);
    expect(r.delivered).toEqual([]); // not fresh
    expect(mdIn(pending)).toEqual([]);
    expect(fs.readFileSync(path.join(inboxDir(s.project, "fe-member--2"), f), "utf8")).toBe(before);
    expect(r.rejected).toEqual([]);
  });

  it("an intent planned before activation (not held) replays into the role's inbox even though the role is held now", () => {
    const s = setup({ table: INSTANCES });
    outbox(s.project, "lead", "fe-member", "");
    // the first attempt planned it while the role was not held, then crashed right after the intent
    let hits = 0;
    setFaultHook((step) => {
      if (step === "route:intent" && hits++ === 0) throw new Error("crash");
    });
    try {
      expect(() => routeOutboxes(s.project, { ...s.routing, held: () => false })).toThrow("crash");
    } finally {
      setFaultHook(undefined);
    }
    routeOutboxes(s.project, s.routing);
    expect(mdIn(inboxDir(s.project, "fe-member"))).toHaveLength(1);
    expect(fs.existsSync(path.join(inboxDir(s.project, "fe-member"), "pending"))).toBe(false);
  });
});
