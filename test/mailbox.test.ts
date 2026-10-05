import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deliver, ensureProjectDirs, listUnread, markRead, readMessage, routeOutboxes } from "../src/mailbox.js";
import { outboxDir } from "../src/policy.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

function send(project: ReturnType<TestEnv["project"]>, from: string, name: string, fm: string, body = "hello") {
  write(path.join(outboxDir(project, from), name), `---\n${fm}\n---\n\n${body}\n`);
}

describe("mailbox routing", () => {
  it("delivers allowed mail and stamps sender/id/thread itself", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    send(p, "fe-member", "a.md", "to: lead\nfrom: qa-member\nsubject: done\nreply_to: abc123");
    const r = routeOutboxes(p);
    expect(r.rejected).toEqual([]);
    expect(r.delivered).toHaveLength(1);
    const [m] = listUnread(p, "lead");
    expect(m.meta.from).toBe("fe-member"); // spoofed `from` ignored
    expect(m.meta.thread).toBe("abc123");
    expect(m.meta.subject).toBe("done");
    expect(m.body).toBe("hello");
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
    expect(routeOutboxes(p).done).toEqual({ from: "lead", subject: "shipped", body: "summary" });
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
