import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_INSTANCES,
  type HeldMsg,
  type OwnersCtx,
  type Plan,
  type PlanInput,
  instanceCap,
  involves,
  ownersOf,
  parallelFlag,
  parseSlotName,
  planAssignments,
  slotName,
} from "../src/instances.js";

// Pure functions of spec 23 (docs/specs/23-dynamic-instances.md). Test ids (T-…) are the ones named in 23.15.

describe("slotName / parseSlotName (23.5)", () => {
  it("slot 1 is the bare role, the others are <role>--<k>", () => {
    expect(slotName("frontend", 1)).toBe("frontend");
    expect(slotName("frontend", 2)).toBe("frontend--2");
    expect(slotName("fe-member", 4)).toBe("fe-member--4");
  });
  it("parses only <role>--<k> with k >= 2 and no leading zero", () => {
    expect(parseSlotName("frontend--2")).toEqual({ role: "frontend", k: 2 });
    expect(parseSlotName("fe-member--12")).toEqual({ role: "fe-member", k: 12 });
    expect(parseSlotName("frontend")).toBeUndefined();
    expect(parseSlotName("frontend--1")).toBeUndefined();
    expect(parseSlotName("frontend--02")).toBeUndefined();
    expect(parseSlotName("fe--x")).toBeUndefined(); // regression: an existing agent named like this is just an agent
    expect(parseSlotName("--2")).toBeUndefined();
  });
  it("round-trips", () => {
    for (const k of [2, 3, 8]) expect(parseSlotName(slotName("qa", k))).toEqual({ role: "qa", k });
  });
});

describe("instanceCap (23.4, without the containment check)", () => {
  const base = { lead: "lead", dispatcher: {}, run: { id: "r", dir: "/r", layout: "run" as const }, agents: { lead: {}, frontend: {}, qa: {} } };
  it("is the default 4 in worktree mode, and dispatcher.max_instances when written", () => {
    expect(DEFAULT_MAX_INSTANCES).toBe(4);
    expect(instanceCap(base, "worktree", "frontend")).toEqual({ n: 4 });
    expect(instanceCap({ ...base, dispatcher: { max_instances: 2 } }, "worktree", "frontend")).toEqual({ n: 2 });
    expect(instanceCap({ ...base, dispatcher: { max_instances: 1 } }, "worktree", "frontend").n).toBe(1);
  });
  it("is 1 with a reason in shared mode, for solo runs, the legacy layout, the lead and a name that is not a branch name", () => {
    expect(instanceCap(base, "shared", "frontend")).toMatchObject({ n: 1, reason: expect.stringContaining("take turns") });
    expect(instanceCap({ ...base, solo: "run" as const }, "worktree", "frontend").n).toBe(1);
    expect(instanceCap({ ...base, run: { id: "r", dir: "/r", layout: "legacy" as const } }, "worktree", "frontend").n).toBe(1);
    expect(instanceCap(base, "worktree", "lead")).toMatchObject({ n: 1 });
    expect(instanceCap({ ...base, agents: { ...base.agents, "bad name": {} } }, "worktree", "bad name")).toMatchObject({ n: 1, reason: expect.stringContaining("bad name") });
  });
  it("stops before the first instance whose name is already a configured agent (regression: fe--x, fe--2)", () => {
    const p = { ...base, agents: { ...base.agents, fe: {}, "fe--x": {} } };
    expect(instanceCap(p, "worktree", "fe").n).toBe(4); // fe--x is not an instance name
    const clash = { ...base, agents: { ...base.agents, fe: {}, "fe--3": {} } };
    expect(instanceCap(clash, "worktree", "fe")).toMatchObject({ n: 2, reason: expect.stringContaining('"fe--3"') });
    const first = { ...base, agents: { ...base.agents, fe: {}, "fe--2": {} } };
    expect(instanceCap(first, "worktree", "fe")).toMatchObject({ n: 1, reason: expect.stringContaining('"fe--2"') });
  });
  it("does not treat an instance that is already open as a collision", () => {
    const bound = { ...base, agents: { ...base.agents, "frontend--2": {} } };
    expect(instanceCap(bound, "worktree", "frontend").n).toBe(1);
    expect(instanceCap(bound, "worktree", "frontend", undefined, ["frontend", "frontend--2"]).n).toBe(4);
  });
  it("cuts at the first slot the injected check refuses and names its reason", () => {
    const check = (_role: string, k: number) => (k >= 3 ? `slot ${k} overlaps` : undefined);
    expect(instanceCap(base, "worktree", "frontend", check)).toEqual({ n: 2, reason: 'instance 3 of "frontend" slot 3 overlaps' });
    expect(instanceCap(base, "worktree", "frontend", (_r, k) => (k === 2 ? "overlap at 2" : undefined))).toEqual({ n: 1, reason: 'instance 2 of "frontend" overlap at 2' });
  });
});

describe("parallelFlag (23.3, T-R4)", () => {
  const ok = { senderIsLead: true, type: "task", cap: { n: 4 } };
  it("absent when the field is not there, whatever else is wrong", () => {
    expect(parallelFlag({ ...ok, value: undefined })).toBe("absent");
    expect(parallelFlag({ ...ok, value: undefined, senderIsLead: false, type: "reply" })).toBe("absent");
  });
  it("T-R4-1/2: a sender other than the lead is ignored whatever the value is (no rejection)", () => {
    expect(parallelFlag({ ...ok, value: true, senderIsLead: false })).toEqual({ ignored: "not-lead" });
    expect(parallelFlag({ ...ok, value: "yes", senderIsLead: false })).toEqual({ ignored: "not-lead" });
    expect(parallelFlag({ ...ok, value: false, senderIsLead: false })).toEqual({ ignored: "not-lead" });
  });
  it("a lead's non-boolean value is invalid; false is absent", () => {
    for (const v of ["yes", "true", 1, 0, null, [], {}]) expect(parallelFlag({ ...ok, value: v })).toBe("invalid");
    expect(parallelFlag({ ...ok, value: false })).toBe("absent");
  });
  it("is ignored on anything but a new task: a reply, another type, reply_to or thread", () => {
    expect(parallelFlag({ ...ok, value: true, type: "reply" })).toEqual({ ignored: "not-a-new-task" });
    expect(parallelFlag({ ...ok, value: true, type: "done" })).toEqual({ ignored: "not-a-new-task" });
    expect(parallelFlag({ ...ok, value: true, replyTo: "abc123" })).toEqual({ ignored: "not-a-new-task" });
    expect(parallelFlag({ ...ok, value: true, thread: "abc123" })).toEqual({ ignored: "not-a-new-task" });
    expect(parallelFlag({ ...ok, value: true, replyTo: "", thread: null })).toBe("on");
  });
  it("is ignored with the cap's reason when the role cannot have a second instance", () => {
    expect(parallelFlag({ ...ok, value: true, cap: { n: 1, reason: "agents take turns in the checkout (not a git repository)" } })).toEqual({
      ignored: "parallel tasks run one at a time in this run: agents take turns in the checkout (not a git repository)",
    });
    expect(parallelFlag({ ...ok, value: true, cap: { n: 1 } })).toMatchObject({ ignored: expect.stringContaining("one at a time") });
  });
  it("is on for a lead's `parallel: true` on a new task with room for more than one instance", () => {
    expect(parallelFlag({ ...ok, value: true })).toBe("on");
  });
});

// ---- planAssignments -------------------------------------------------------------------------------------------------------------

const held = (id: string, extra: Partial<HeldMsg> = {}): HeldMsg => ({ file: `f-${id}.md`, id, to: "frontend", parallel: false, ...extra });
function plan(over: Partial<PlanInput> & { held: HeldMsg[] }) {
  return planAssignments({
    role: "frontend",
    opened: ["frontend"],
    cap: 4,
    owners: () => undefined,
    recorded: () => undefined,
    acceptsNew: () => true,
    busy: () => false,
    coolingDown: false,
    mayOpen: () => true,
    ...over,
  });
}

describe("planAssignments (23.7.2 rules 0-4)", () => {
  it("rule 4: an unflagged new task goes to instance 1 even while it is busy", () => {
    const r = plan({ held: [held("a")], busy: () => true });
    expect(r.assign).toEqual([{ file: "f-a.md", slot: "frontend", rule: "default" }]);
    expect(r.waiting).toEqual([]);
  });
  it("rule 0: a recorded assignment wins over everything and is not re-decided", () => {
    const r = plan({ held: [held("a", { parallel: true })], opened: ["frontend", "frontend--2"], recorded: (id) => (id === "a" ? "frontend--2" : undefined), acceptsNew: () => "blocked" });
    expect(r.assign).toEqual([{ file: "f-a.md", slot: "frontend--2", rule: "recorded" }]);
  });
  it("rule 1 / T-R3-2: a revision goes back to its instance even when it is blocked, refused or over the cap", () => {
    for (const why of ["blocked", "refused", "cap"] as const) {
      const r = plan({ held: [held("a", { replyTo: "m1" })], opened: ["frontend", "frontend--2"], owners: (id) => (id === "m1" ? "frontend--2" : undefined), acceptsNew: () => why });
      expect(r.assign).toEqual([{ file: "f-a.md", slot: "frontend--2", rule: "affinity" }]);
    }
  });
  it("rule 1 / T-R5: replyTo and thread are looked up one by one; the first that has an owner decides", () => {
    const owners = (id: string) => ({ other: undefined, mine: "frontend--2" })[id as "other" | "mine"];
    expect(plan({ held: [held("a", { replyTo: "other", thread: "mine" })], opened: ["frontend", "frontend--2"], owners }).assign[0]).toMatchObject({ slot: "frontend--2", rule: "affinity" });
    expect(plan({ held: [held("a", { replyTo: "mine", thread: "other" })], opened: ["frontend", "frontend--2"], owners }).assign[0]).toMatchObject({ slot: "frontend--2", rule: "affinity" });
    const none = plan({ held: [held("a", { replyTo: "other", thread: "other2" })], opened: ["frontend", "frontend--2"], owners });
    expect(none.assign[0]).toMatchObject({ slot: "frontend", rule: "default" }); // T-R5-3: no affinity, then rules 2-4
  });
  it("rule 1: a thread equal to the message's own id is not an affinity candidate", () => {
    const seen: string[] = [];
    plan({ held: [held("a", { thread: "a" })], owners: (id) => {
        seen.push(id);
        return undefined;
      },
    });
    expect(seen).toEqual([]);
  });
  it("rule 1 notes the instance a message was addressed to when affinity chose another", () => {
    const r = plan({ held: [held("a", { replyTo: "m1", to: "frontend--3" })], opened: ["frontend", "frontend--2", "frontend--3"], owners: () => "frontend--2" });
    expect(r.assign[0]).toEqual({ file: "f-a.md", slot: "frontend--2", rule: "affinity", addressed: "frontend--3" });
  });
  it("T-R3-1/5: instance 1 blocked, an unflagged new task is held with reason blocked", () => {
    const r = plan({ held: [held("a")], acceptsNew: (s) => (s === "frontend" ? "blocked" : true), opened: ["frontend", "frontend--2"] });
    expect(r.assign).toEqual([]);
    expect(r.waiting).toEqual([{ file: "f-a.md", reason: "blocked" }]);
  });
  it("T-R3-3: a new task addressed to an instance that is blocked, refused or over the cap is held", () => {
    for (const why of ["blocked", "refused", "cap"] as const) {
      const r = plan({ held: [held("a", { to: "frontend--2" })], opened: ["frontend", "frontend--2"], acceptsNew: (s) => (s === "frontend--2" ? why : true) });
      expect(r.assign).toEqual([]);
      expect(r.waiting).toEqual([{ file: "f-a.md", reason: why }]);
    }
  });
  it("rule 2: a new task addressed to an open instance goes there even when it is busy", () => {
    const r = plan({ held: [held("a", { to: "frontend--2" })], opened: ["frontend", "frontend--2"], busy: () => true });
    expect(r.assign).toEqual([{ file: "f-a.md", slot: "frontend--2", rule: "addressed" }]);
  });
  it("T-R3-4: once the blocker is gone, held mail is placed in file order", () => {
    const msgs = [held("a"), held("b")];
    const blocked = plan({ held: msgs, acceptsNew: () => "blocked" });
    expect(blocked.waiting.map((w) => w.file)).toEqual(["f-a.md", "f-b.md"]);
    const later = plan({ held: msgs });
    expect(later.assign.map((a) => a.file)).toEqual(["f-a.md", "f-b.md"]);
  });
  it("rule 3: a parallel task takes the lowest free acceptable instance", () => {
    const r = plan({ held: [held("a", { parallel: true })], opened: ["frontend", "frontend--2"], busy: (s) => s === "frontend" });
    expect(r.assign).toEqual([{ file: "f-a.md", slot: "frontend--2", rule: "parallel" }]);
  });
  it("rule 3: an instance is given at most one parallel task per round", () => {
    const r = plan({ held: [held("a", { parallel: true }), held("b", { parallel: true })], cap: 1 });
    expect(r.assign.map((a) => a.slot)).toEqual(["frontend"]);
    expect(r.waiting).toEqual([{ file: "f-b.md", reason: "busy" }]);
  });
  it("rule 3: opens the next instance when none is free and there is room, naming it", () => {
    const r = plan({ held: [held("a", { parallel: true }), held("b", { parallel: true }), held("c", { parallel: true })], cap: 2 });
    expect(r.assign).toEqual([
      { file: "f-a.md", slot: "frontend", rule: "parallel" },
      { file: "f-b.md", slot: "frontend--2", open: "frontend--2", rule: "parallel" },
    ]);
    expect(r.waiting).toEqual([{ file: "f-c.md", reason: "busy" }]); // saturated: stays queued (FIFO), not pushed onto instance 1
  });
  it("rule 3: a held parallel task blocks the parallel tasks behind it (FIFO) but not an affinity revision", () => {
    const msgs = [held("a", { parallel: true }), held("b", { parallel: true }), held("c", { replyTo: "m1" })];
    const r = plan({ held: msgs, cap: 1, busy: () => true, owners: (id) => (id === "m1" ? "frontend" : undefined) });
    expect(r.waiting.map((w) => w.file)).toEqual(["f-a.md", "f-b.md"]);
    expect(r.assign).toEqual([{ file: "f-c.md", slot: "frontend", rule: "affinity" }]);
  });
  it("rule 3 / cooling down: no new instance, but an idle open one is used", () => {
    const cold = plan({ held: [held("a", { parallel: true })], opened: ["frontend", "frontend--2"], busy: (s) => s === "frontend", coolingDown: true });
    expect(cold.assign).toEqual([{ file: "f-a.md", slot: "frontend--2", rule: "parallel" }]);
    const none = plan({ held: [held("a", { parallel: true })], busy: () => true, coolingDown: true });
    expect(none.assign).toEqual([]);
    expect(none.waiting).toEqual([{ file: "f-a.md", reason: "cooldown" }]);
  });
  it("rule 3: a name clash or a containment conflict stops opening and says why", () => {
    for (const why of ["collision", "containment"] as const) {
      const r = plan({ held: [held("a", { parallel: true })], busy: () => true, mayOpen: () => why });
      expect(r.waiting).toEqual([{ file: "f-a.md", reason: why }]);
    }
  });
  it("rule 3: blocked or refused instances are not used and the cap holds", () => {
    const r = plan({ held: [held("a", { parallel: true })], cap: 2, opened: ["frontend", "frontend--2"], acceptsNew: () => "blocked" });
    expect(r.waiting).toEqual([{ file: "f-a.md", reason: "cap" }]);
  });
  it("T-R4-3: a message without parallel in the journal never opens an instance (rule 4)", () => {
    const r = plan({ held: [held("a")], busy: () => true, cap: 4 });
    expect(r.assign[0]).toMatchObject({ slot: "frontend", rule: "default" });
    expect(r.assign[0].open).toBeUndefined();
  });
});

// ---- ownersOf / involves -------------------------------------------------------------------------------------------------------

type Rec = ReturnType<OwnersCtx["rec"]>;
function ctx(recs: Record<string, Rec>, over: Partial<OwnersCtx> = {}): OwnersCtx {
  return { opened: ["frontend", "frontend--2"], rec: (id) => recs[id], mark: 100, claimAgent: () => undefined, ...over };
}
const intent = (over: Partial<NonNullable<NonNullable<Rec>["intent"]>> = {}) => ({ seq: 1, to: "qa", file: "S-lead-M.md", source: "abc", msg_id: "M", ...over });

describe("ownersOf (23.7.2 rule 1, lead arbitration F1/F2)", () => {
  it("T-F1-1: a message sent by frontend--2 and assigned to qa--2 gives each role its own owner", () => {
    const rec = { M: { from: "frontend--2", assign: "qa--2", intent: intent({ seq: 5 }) } };
    expect(ownersOf("M", "frontend", ctx(rec, { opened: ["frontend", "frontend--2"] }))).toBe("frontend--2");
    expect(ownersOf("M", "qa", ctx(rec, { opened: ["qa", "qa--2"] }))).toBe("qa--2");
  });
  it("prefers assign over from over about, among instances the role has opened", () => {
    const opened = ["frontend", "frontend--2", "frontend--3"];
    expect(ownersOf("M", "frontend", ctx({ M: { assign: "frontend--3", from: "frontend--2", about: "frontend" } }, { opened }))).toBe("frontend--3");
    expect(ownersOf("M", "frontend", ctx({ M: { from: "frontend--2", about: "frontend" } }, { opened }))).toBe("frontend--2");
    expect(ownersOf("M", "frontend", ctx({ M: { about: "frontend--3" } }, { opened }))).toBe("frontend--3");
  });
  it("ignores an owner that is not one of the role's open instances (R5)", () => {
    expect(ownersOf("M", "frontend", ctx({ M: { assign: "qa--2" } }))).toBeUndefined();
    expect(ownersOf("M", "frontend", ctx({ M: { assign: "frontend--9" } }))).toBeUndefined();
  });
  it("T-F2: an id the journal does not know is a new thread", () => {
    expect(ownersOf("nope", "frontend", ctx({}))).toBeUndefined();
  });
  it("T-F2-1/2: older work that involves the role by name belongs to instance 1; the activation mark decides what is older", () => {
    const sent = { T: { intent: intent({ seq: 3, to: "frontend", file: "S-lead-T.md", msg_id: "T" }) } };
    expect(ownersOf("T", "frontend", ctx(sent, { mark: 10 }))).toBe("frontend");
    expect(ownersOf("T", "frontend", ctx(sent, { mark: 3 }))).toBeUndefined(); // at or after the mark: not "earlier"
    expect(ownersOf("T", "frontend", ctx(sent, { mark: undefined }))).toBe("frontend"); // mark not in the journal yet: everything is earlier
  });
  it("T-F2-3: older mail that does not involve the role, or that came after activation, gets no affinity", () => {
    const toQa = { Q: { intent: intent({ seq: 3, to: "qa", file: "S-lead-Q.md", msg_id: "Q" }) } };
    expect(ownersOf("Q", "frontend", ctx(toQa))).toBeUndefined();
    const pending = { P: { intent: intent({ seq: 200, to: "frontend", file: "S-lead-P.md", msg_id: "P" }) } };
    expect(ownersOf("P", "frontend", ctx(pending))).toBeUndefined();
  });
  it("T-F2-1: an old integration failure about the role belongs to instance 1 (found through its claim)", () => {
    const fail = { F: { intent: intent({ seq: 4, to: "lead", file: "S-dispatcher-F.md", source: "integration:k1-frontend-aa", msg_id: "F" }) } };
    expect(ownersOf("F", "frontend", ctx(fail, { claimAgent: (c) => (c === "k1-frontend-aa" ? "frontend" : undefined) }))).toBe("frontend");
    expect(ownersOf("F", "frontend", ctx(fail, { claimAgent: () => "qa" }))).toBeUndefined();
  });
});

describe("involves (23.7.2, T-F2-4)", () => {
  const none = () => undefined;
  const rec = (over: Partial<Parameters<typeof involves>[0]>) => ({ to: "lead", file: "20261025T072434377Z-lead-m1.md", source: "s", msg_id: "m1", ...over });
  it("the recipient is the role", () => {
    expect(involves(rec({ to: "frontend" }), "frontend", none)).toBe(true);
    expect(involves(rec({ to: "fe-x" }), "fe", none)).toBe(false);
  });
  it("the sender is the role: from the file name <stamp>-<from>-<id>.md, never confused with a neighbour name", () => {
    expect(involves(rec({ file: "20261025T072434377Z-fe-m1.md", msg_id: "m1" }), "fe", none)).toBe(true);
    expect(involves(rec({ file: "20261025T072434377Z-fe-x-m1.md", msg_id: "m1" }), "fe", none)).toBe(false);
    expect(involves(rec({ file: "20261025T072434377Z-fe-x-m1.md", msg_id: "m1" }), "fe-x", none)).toBe(true);
    expect(involves(rec({ file: "20261025T072434377Z-fe-m1.md", msg_id: "m1" }), "fe-x", none)).toBe(false);
    expect(involves(rec({ file: "20261025T072434377Z-fe-other.md", msg_id: "m1" }), "fe", none)).toBe(false);
  });
  it("an integration failure is about the member recorded in its claim", () => {
    const src = "integration:k1-fe-ab12cd";
    expect(involves(rec({ source: src }), "fe", (c) => (c === "k1-fe-ab12cd" ? "fe" : undefined))).toBe(true);
    expect(involves(rec({ source: src }), "fe", () => "qa")).toBe(false); // the claim belongs to someone else
  });
  it("with no claim file, only the fallback key <role>-<rounds> counts: R-7 is R, R-x-7 is not", () => {
    expect(involves(rec({ source: "integration:fe-7" }), "fe", none)).toBe(true);
    expect(involves(rec({ source: "integration:fe-x-7" }), "fe", none)).toBe(false);
    expect(involves(rec({ source: "integration:fe-x-7" }), "fe-x", none)).toBe(true);
    expect(involves(rec({ source: "integration:fe-7x" }), "fe", none)).toBe(false);
  });
  it("a claim answer wins over the fallback pattern", () => {
    expect(involves(rec({ source: "integration:fe-7" }), "fe", () => "qa")).toBe(false);
  });
  it("a key with a path separator or .. is refused without asking for a claim", () => {
    let asked = 0;
    const spy = () => {
      asked++;
      return "fe";
    };
    for (const key of ["a/b", "..", "a\\b", "x..y", "../x", ""]) expect(involves(rec({ source: `integration:${key}` }), "fe", spy)).toBe(false);
    expect(asked).toBe(0);
  });
  it("a refused-worktree notice names the member as the last part of its key", () => {
    expect(involves(rec({ source: "refused:run-1:fe" }), "fe", none)).toBe(true);
    expect(involves(rec({ source: "refused:run-1:fe-x" }), "fe", none)).toBe(false);
    expect(involves(rec({ source: "refused:run-1:fe" }), "qa", none)).toBe(false);
  });
  it("other dispatcher sources (reject, dup, nudge, done-reject, a plain hash) do not involve a role by themselves", () => {
    for (const source of ["reject:x", "dup:x", "nudge:x", "done-reject:x", "0123456789abcdef"]) expect(involves(rec({ source }), "fe", none)).toBe(false);
  });
});

describe("a slot that is given a message this round is not free for a parallel task (phase B)", () => {
  const base = { role: "fe", held: [] as never[], opened: ["fe", "fe--2"], cap: 4, owners: () => undefined, recorded: () => undefined, acceptsNew: () => true as const, busy: () => false, coolingDown: false, mayOpen: () => true as const };
  it("a recorded assignment (crash replay) occupies its slot, so the next parallel task takes another one", () => {
    const plan = planAssignments({
      ...base,
      held: [
        { file: "a.md", id: "a", to: "fe", parallel: true },
        { file: "b.md", id: "b", to: "fe", parallel: true },
      ],
      recorded: (id) => (id === "a" ? "fe" : undefined),
    });
    expect(plan.assign.map((a) => [a.file, a.slot, a.rule])).toEqual([["a.md", "fe", "recorded"], ["b.md", "fe--2", "parallel"]]);
  });
});

describe("every earlier destination of a batch is occupied; ownership from earlier in the batch (review 0708f19f)", () => {
  const base = { role: "fe", held: [] as HeldMsg[], opened: ["fe", "fe--2"], cap: 4, owners: () => undefined as string | undefined, recorded: () => undefined as string | undefined, acceptsNew: () => true as const, busy: () => false, coolingDown: false, mayOpen: () => true as const };
  const m = (id: string, extra: Partial<HeldMsg> = {}): HeldMsg => ({ file: `${id}.md`, id, to: "fe", parallel: false, ...extra });
  const slots = (p: Plan) => p.assign.map((a) => [a.file, a.slot, a.rule]);
  // fe is busy with something else, so only fe--2 is a free slot for a parallel task
  const feBusy = (slot: string) => slot === "fe";

  it("default + parallel: a default task takes instance 1, so the parallel one opens a new slot", () => {
    const p = planAssignments({ ...base, opened: ["fe"], held: [m("a"), m("b", { parallel: true })] });
    expect(slots(p)).toEqual([["a.md", "fe", "default"], ["b.md", "fe--2", "parallel"]]);
  });
  it("affinity + parallel", () => {
    const p = planAssignments({ ...base, busy: feBusy, held: [m("a", { replyTo: "old" }), m("b", { parallel: true })], owners: (id) => (id === "old" ? "fe--2" : undefined) });
    expect(slots(p)).toEqual([["a.md", "fe--2", "affinity"], ["b.md", "fe--3", "parallel"]]);
  });
  it("recorded + parallel", () => {
    const p = planAssignments({ ...base, busy: feBusy, held: [m("a", { parallel: true }), m("b", { parallel: true })], recorded: (id) => (id === "a" ? "fe--2" : undefined) });
    expect(slots(p)).toEqual([["a.md", "fe--2", "recorded"], ["b.md", "fe--3", "parallel"]]);
  });
  it("addressed + parallel: fe busy, a addressed to fe--2, parallel b must not go to fe--2", () => {
    const p = planAssignments({ ...base, busy: feBusy, held: [m("a", { to: "fe--2" }), m("b", { parallel: true })] });
    expect(slots(p)).toEqual([["a.md", "fe--2", "addressed"], ["b.md", "fe--3", "parallel"]]);
  });
  it("a reply to a message placed earlier in the same batch follows it (destination already open)", () => {
    const p = planAssignments({ ...base, busy: feBusy, held: [m("a", { parallel: true }), m("b", { replyTo: "a" })] });
    expect(slots(p)).toEqual([["a.md", "fe--2", "parallel"], ["b.md", "fe--2", "affinity"]]);
  });
  it("a reply to a message whose instance is opened by this same plan follows it", () => {
    const p = planAssignments({ ...base, opened: ["fe"], busy: feBusy, held: [m("a", { parallel: true }), m("b", { thread: "a" })] });
    expect(p.assign[0]).toMatchObject({ slot: "fe--2", open: "fe--2" });
    expect(p.assign[1]).toMatchObject({ file: "b.md", slot: "fe--2", rule: "affinity" });
  });
  it("reply_to still wins over thread, and the overlay wins over the journal lookup of the same id", () => {
    const p = planAssignments({ ...base, busy: feBusy, owners: (id) => (id === "t" ? "fe" : id === "a" ? "fe" : undefined), held: [m("a", { parallel: true }), m("b", { replyTo: "a", thread: "t" })] });
    expect(p.assign[1]).toMatchObject({ slot: "fe--2", rule: "affinity" });
  });
});
