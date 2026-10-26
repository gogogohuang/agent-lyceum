import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listUnread, markRead, routeOutboxes } from "../src/mailbox.js";
import { setFaultHook } from "../src/message-store.js";
import { inboxDir, outboxDir } from "../src/policy.js";
import { bindRunProject } from "../src/run-store.js";
import { makeEnv, type TestEnv, withSections, write } from "./helpers.js";

let env: TestEnv;
let n = 0;
afterEach(() => {
  setFaultHook(undefined);
  env?.cleanup();
});
function setup(tiers: string[] | null = ["m-low", "m-high"]) {
  env = makeEnv();
  const p = env.project();
  const run = bindRunProject(p, path.join(p.paths.runs, "tiers"), "run");
  if (tiers) run.agents["fe-member"]!.tiers = tiers;
  return run;
}
type P = ReturnType<typeof setup>;
const BODY = "implement the whole feature with all of its tests please";
function send(p: P, from: string, to: string, fm: string, type = "task", body = BODY) {
  write(path.join(outboxDir(p, from), `mail-${++n}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: probe\n${fm}---\n${withSections(type as "task", body)}`);
}
const unread = (p: P, a = "fe-member") => listUnread(p, a);
const failures = (p: P, a = "lead") => unread(p, a).filter((m) => m.meta.type === "failure");

describe("tier on lead task mail (spec 24.5)", () => {
  it("T-6 a valid tier is written to the delivered mail", () => {
    const p = setup();
    send(p, "lead", "fe-member", "tier: low\n");
    const r = routeOutboxes(p);
    expect(unread(p)[0]?.meta.tier).toBe("low");
    expect(r.tierIgnored).toEqual([]);
  });
  it("T-6 an invalid tier is rejected back to the lead with the spec text", () => {
    const p = setup();
    send(p, "lead", "fe-member", "tier: LOW\n");
    routeOutboxes(p);
    expect(unread(p)).toHaveLength(0);
    expect(failures(p)[0]?.body).toContain('tier must be low, mid or high, not "LOW".');
  });
  it("mail without tier is byte-identical (no tier line)", () => {
    const p = setup();
    send(p, "lead", "fe-member", "");
    routeOutboxes(p);
    expect(fs.readFileSync(unread(p)[0]!.file, "utf8")).not.toMatch(/^tier:/m);
  });
  it("T-7 not-lead, not-a-task and no-tiers are delivered without tier and reported", () => {
    const p = setup();
    send(p, "fe-member", "lead", "tier: low\n", "reply");
    send(p, "lead", "fe-member", "tier: low\n", "reply");
    const r1 = routeOutboxes(p);
    expect(r1.tierIgnored.map((x) => x.reason).sort()).toEqual(["not-a-task", "not-lead"]);
    for (const a of ["lead", "fe-member"]) expect(unread(p, a).every((m) => m.meta.tier === undefined)).toBe(true);
    const q = setup(null);
    send(q, "lead", "fe-member", "tier: low\n");
    const r2 = routeOutboxes(q);
    expect(r2.tierIgnored.map((x) => x.reason)).toEqual(["no-tiers"]);
    expect(unread(q)[0]?.meta.tier).toBeUndefined();
  });
  it("T-15a a resend with only the tier changed is delivered", () => {
    const p = setup();
    send(p, "lead", "fe-member", "tier: low\n");
    routeOutboxes(p);
    send(p, "lead", "fe-member", "tier: high\n");
    routeOutboxes(p);
    expect(unread(p).map((m) => m.meta.tier)).toEqual(["low", "high"]);
  });
  it("T-15b an exact repeat is a duplicate", () => {
    const p = setup();
    send(p, "lead", "fe-member", "tier: low\n");
    routeOutboxes(p);
    send(p, "lead", "fe-member", "tier: low\n");
    routeOutboxes(p);
    expect(unread(p)).toHaveLength(1);
    expect(failures(p)).toHaveLength(1);
  });
  it("T-15c absent vs high is a duplicate, both ways", () => {
    const p = setup();
    send(p, "lead", "fe-member", "");
    routeOutboxes(p);
    send(p, "lead", "fe-member", "tier: high\n");
    routeOutboxes(p);
    expect(unread(p)).toHaveLength(1);
    send(p, "lead", "fe-member", "tier: mid\n");
    routeOutboxes(p);
    expect(unread(p)).toHaveLength(2);
  });
  it("T-15d recipient without tiers: tier is ignored, so a changed tier is still a duplicate", () => {
    const p = setup(null);
    send(p, "lead", "fe-member", "tier: low\n");
    routeOutboxes(p);
    send(p, "lead", "fe-member", "tier: high\n");
    routeOutboxes(p);
    expect(unread(p)).toHaveLength(1);
  });
  it("T-15e a read earlier mail with a different tier is not a duplicate", () => {
    const p = setup();
    send(p, "lead", "fe-member", "tier: low\n");
    routeOutboxes(p);
    markRead(unread(p).map((m) => m.file));
    send(p, "lead", "fe-member", "tier: high\n");
    routeOutboxes(p);
    expect(unread(p).map((m) => m.meta.tier)).toEqual(["high"]);
    expect(fs.existsSync(path.join(inboxDir(p, "fe-member"), "read"))).toBe(true);
  });
  it("T-15f crash replay keeps the tier and counts one notice", () => {
    const p = setup();
    send(p, "lead", "fe-member", "tier: low\n");
    routeOutboxes(p);
    send(p, "lead", "fe-member", "tier: low\n");
    setFaultHook((s) => {
      if (s === "route:intent") throw new Error("crash");
    });
    expect(() => routeOutboxes(p)).toThrow("crash");
    setFaultHook(undefined);
    routeOutboxes(p);
    expect(failures(p)).toHaveLength(1);
    expect(unread(p)).toHaveLength(1);
    expect(unread(p)[0]?.meta.tier).toBe("low");
    const notices = () => Object.values(JSON.parse(fs.readFileSync(path.join(p.paths.runs, "tiers", "duplicate-notices.json"), "utf8")) as Record<string, string[]>);
    expect(notices().map((v) => v.length)).toEqual([1]);
    // cap 2: the next repeat is announced, the third is set aside silently
    send(p, "lead", "fe-member", "tier: low\n");
    routeOutboxes(p);
    expect(failures(p)).toHaveLength(2);
    send(p, "lead", "fe-member", "tier: low\n");
    routeOutboxes(p);
    expect(failures(p)).toHaveLength(2);
    expect(notices().map((v) => v.length)).toEqual([2]);
    expect(unread(p)).toHaveLength(1);
  });
});
