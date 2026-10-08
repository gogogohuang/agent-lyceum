import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { missingSections } from "../src/format.js";
import { deliver, ensureProjectDirs, listUnread, markRead, readMessage, routeOutboxes, unreadFiles } from "../src/mailbox.js";
import { inboxDir, outboxDir } from "../src/policy.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const REPLY_BODY = "## Changes\nNone\n## Verification\nNone\n## Open items\nNone\n## Risks\nNone";

function send(project: ReturnType<TestEnv["project"]>, from: string, name: string, fm: string, body = "hello") {
  write(path.join(outboxDir(project, from), name), `---\n${fm}\n---\n\n${body}\n`);
}

describe("mailbox routing", () => {
  it("delivers allowed mail and stamps sender/id/thread itself", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    send(p, "fe-member", "a.md", "to: lead\nfrom: qa-member\nsubject: done\nreply_to: abc123", REPLY_BODY);
    const r = routeOutboxes(p);
    expect(r.rejected).toEqual([]);
    expect(r.delivered).toHaveLength(1);
    const [m] = listUnread(p, "lead");
    expect(m.meta.from).toBe("fe-member"); // spoofed `from` ignored
    expect(m.meta.thread).toBe("abc123");
    expect(m.meta.subject).toBe("done");
    expect(m.body).toBe(REPLY_BODY);
    expect(fs.existsSync(path.join(outboxDir(p, "fe-member"), "a.md"))).toBe(false);
  });

  it("rejects recipients outside can_message and tells the sender", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    send(p, "fe-member", "x.md", "to: qa-member\nsubject: hi");
    const r = routeOutboxes(p);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toMatch(/only message: lead/);
    expect(listUnread(p, "qa-member")).toHaveLength(0);
    const [note] = listUnread(p, "fe-member");
    expect(note.meta.type).toBe("failure");
    expect(note.meta.from).toBe("dispatcher");
    expect(fs.existsSync(path.join(outboxDir(p, "fe-member"), "rejected", "x.md"))).toBe(true);
  });

  it("lets the lead message anyone and only the lead send done", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    send(p, "lead", "t.md", "to: [fe-member, qa-member]\ntype: task\nsubject: go");
    send(p, "qa-member", "d.md", "type: done\nsubject: all done");
    const r = routeOutboxes(p);
    expect(r.delivered.map((d) => d.to).sort()).toEqual(["fe-member", "qa-member"]);
    expect(r.done).toBeUndefined();
    expect(r.rejected[0].reason).toMatch(/only the lead/);

    send(p, "lead", "d2.md", "type: done\nsubject: shipped", "summary");
    expect(routeOutboxes(p).done).toMatchObject({ from: "lead", subject: "shipped", body: "summary" });
  });

  it("rejects malformed mail", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    write(path.join(outboxDir(p, "lead"), "bad.md"), "no frontmatter here");
    send(p, "lead", "t.md", "type: failure\nto: fe-member\nsubject: x");
    send(p, "lead", "n.md", "type: reply\nsubject: x");
    const r = routeOutboxes(p);
    expect(r.rejected.map((x) => x.reason).join("\n")).toMatch(/frontmatter/);
    expect(r.rejected).toHaveLength(3);
  });

  it("moves handled mail to read/ and keeps order by timestamp", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    const a = deliver(p, { from: "user", to: "lead", type: "task", subject: "first", body: "1" });
    const b = deliver(p, { from: "fe-member", to: "lead", type: "reply", subject: "second", body: "2" });
    const unread = listUnread(p, "lead");
    expect(unread.map((m) => m.meta.subject)).toEqual(["first", "second"]);
    markRead(unread.map((m) => m.file));
    expect(listUnread(p, "lead")).toHaveLength(0);
    expect(readMessage(path.join(path.dirname(a.file), "read", path.basename(a.file))).body).toBe("1");
    expect(b.meta.id).not.toBe(a.meta.id);
  });
});

describe("message format check", () => {
  it("matches headings case-insensitively at any level", () => {
    expect(missingSections("reply", "# changes\n### Verification:\n## OPEN ITEMS ##\n## Risks")).toEqual([]);
    expect(missingSections("reply", "## Changes\nx")).toEqual(["Verification", "Open items", "Risks"]);
    expect(missingSections("task", "Goal: do it")).toEqual(["Goal", "Acceptance criteria", "Scope", "Upstream"]);
  });

  it("exempts done and failure", () => {
    expect(missingSections("done", "all good")).toEqual([]);
    expect(missingSections("failure", "oops")).toEqual([]);
  });

  it("delivers non-conforming mail with a warning note instead of rejecting it", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    send(p, "fe-member", "w.md", "to: lead\nsubject: partial", "## Changes\nsrc/a.ts");
    const r = routeOutboxes(p);
    expect(r.rejected).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].missing).toEqual(["Verification", "Open items", "Risks"]);
    const [m] = listUnread(p, "lead");
    expect(m.body).toMatch(/^\[agent-lyceum\] Format warning:.*`## Verification`/);
    expect(m.body).toContain("src/a.ts");
  });

  it("does not warn on conforming mail or on done", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    send(p, "fe-member", "ok.md", "to: lead\nsubject: ok", REPLY_BODY);
    expect(routeOutboxes(p).warnings).toEqual([]);
    send(p, "lead", "d.md", "type: done\nsubject: shipped", "summary");
    expect(routeOutboxes(p).warnings).toEqual([]);
  });
});

describe("unreadFiles", () => {
  it("lists unread .md files sorted by name, skipping dotfiles, other files and folders", () => {
    env = makeEnv();
    const p = env.project();
    const dir = inboxDir(p, "lead");
    fs.mkdirSync(path.join(dir, "read"), { recursive: true });
    fs.writeFileSync(path.join(dir, "b.md"), "x");
    fs.writeFileSync(path.join(dir, "a.md"), "x");
    fs.writeFileSync(path.join(dir, ".hidden.md"), "x");
    fs.writeFileSync(path.join(dir, "note.txt"), "x");
    expect(unreadFiles(p, "lead").map((f) => path.basename(f))).toEqual(["a.md", "b.md"]);
    expect(unreadFiles(p, "nobody")).toEqual([]);
  });

  it("still counts a malformed message as unread (so an agent with only that mail is still woken)", () => {
    env = makeEnv();
    const p = env.project();
    const dir = inboxDir(p, "lead");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.md"), "no frontmatter at all");
    expect(unreadFiles(p, "lead")).toHaveLength(1);
    expect(listUnread(p, "lead")).toHaveLength(1);
  });
});

describe("ask mail", () => {
  const ASK_BODY = `<ask><question id="q1"><text>JWT?</text></question></ask>`;
  const put = (project: ReturnType<TestEnv["project"]>, from: string, fm: string) =>
    write(path.join(outboxDir(project, from), `${Math.random()}.md`), `---\n${fm}\n---\n\n${ASK_BODY}\n`);

  it("hands an ask from the lead to the caller instead of delivering it", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    put(p, "lead", "to: lead\ntype: ask\nsubject: need input");
    const res = routeOutboxes(p);
    expect(res.asks).toHaveLength(1);
    expect(res.asks[0]).toMatchObject({ from: "lead", subject: "need input" });
    expect(res.asks[0]?.body).toContain("<ask>");
    expect(res.delivered).toEqual([]);
    expect(res.rejected).toEqual([]);
    expect(fs.existsSync(res.asks[0]!.file)).toBe(true); // stays in the outbox until the session has stored the questions
  });

  it("rejects an ask from a member without can_ask_user and points it to the lead", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    put(p, "fe-member", "to: lead\ntype: ask\nsubject: need input");
    const res = routeOutboxes(p);
    expect(res.asks).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]?.reason).toMatch(/can_ask_user/);
    expect(listUnread(p, "fe-member").some((m) => m.meta.subject.includes("rejected"))).toBe(true);
  });

  it("accepts an ask from a member once can_ask_user is on", () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("  fe-member:\n    can_message: [lead]", "  fe-member:\n    can_message: [lead]\n    can_ask_user: true"));
    const p = env.project();
    ensureProjectDirs(p);
    put(p, "fe-member", "to: lead\ntype: ask\nsubject: need input");
    expect(routeOutboxes(p).asks.map((a) => a.from)).toEqual(["fe-member"]);
  });

  it("does not need a `to` for an ask", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    put(p, "lead", "type: ask\nsubject: s");
    expect(routeOutboxes(p).asks).toHaveLength(1);
  });
});
