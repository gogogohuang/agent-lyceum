import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { missingSections } from "../src/format.js";
import { deliver, ensureProjectDirs, listUnread, markRead, readMessage, routeOutboxes, unreadFiles } from "../src/mailbox.js";
import { inboxDir, outboxDir } from "../src/policy.js";
import { bindRunProject } from "../src/run-store.js";
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

  describe("duplicate content", () => {
    const TEXT = "## Changes\nAdded the login page and its tests\n## Verification\nnpm test passed\n## Open items\nNone\n## Risks\nNone";
    const setup = () => {
      env = makeEnv();
      const p = env.project();
      ensureProjectDirs(p);
      return p;
    };

    it("does not send the same text to the same agent again, and tells the sender why", () => {
      const p = setup();
      send(p, "fe-member", "a.md", "to: lead\ntype: reply\nsubject: first", TEXT);
      expect(routeOutboxes(p).delivered).toHaveLength(1);
      send(p, "fe-member", "b.md", "to: lead\ntype: reply\nsubject: second try", `${TEXT.replace(/\n/g, "\n\n")}  `); // only whitespace differs
      const r = routeOutboxes(p);
      expect(r.delivered).toEqual([]);
      expect(r.rejected).toHaveLength(1);
      expect(r.rejected[0]?.reason).toMatch(/duplicate.*to "lead" it repeats mail .*first/);
      expect(listUnread(p, "lead").filter((m) => m.meta.type === "reply")).toHaveLength(1);
      const note = listUnread(p, "fe-member").find((m) => m.meta.type === "failure");
      expect(note?.body).toMatch(/Do not send it again/);
      expect(fs.existsSync(path.join(outboxDir(p, "fe-member"), "rejected", "b.md"))).toBe(true);
    });

    it("still finds it after the recipient has read the first one", () => {
      const p = setup();
      send(p, "fe-member", "a.md", "to: lead\ntype: reply\nsubject: first", TEXT);
      routeOutboxes(p);
      markRead(unreadFiles(p, "lead"));
      send(p, "fe-member", "b.md", "to: lead\ntype: reply\nsubject: first", TEXT);
      expect(routeOutboxes(p).rejected).toHaveLength(1);
    });

    it("is not a duplicate when the text, the type, the reply target, the sender or the recipient differs, or the text is tiny", () => {
      const p = setup();
      send(p, "lead", "a.md", "to: fe-member\ntype: task\nsubject: t1", TEXT);
      routeOutboxes(p);
      send(p, "lead", "b.md", "to: fe-member\ntype: task\nsubject: t2", `${TEXT}\nand one more thing`); // other text
      send(p, "lead", "c.md", "to: fe-member\ntype: reply\nsubject: t3", TEXT); // other type
      send(p, "lead", "d.md", "to: qa-member\ntype: task\nsubject: t4", TEXT); // other recipient
      send(p, "lead", "e.md", "to: fe-member\ntype: task\nsubject: t5\nreply_to: x1", TEXT); // other reply target
      send(p, "qa-member", "f.md", "to: lead\ntype: task\nsubject: t6", TEXT); // other sender
      send(p, "lead", "g.md", "to: fe-member\ntype: reply\nsubject: ok", "ok");
      send(p, "lead", "h.md", "to: fe-member\ntype: reply\nsubject: ok2", "ok");
      const r = routeOutboxes(p);
      expect(r.rejected).toEqual([]);
      expect(r.delivered).toHaveLength(7);
    });

    it("sends to the other recipients and names the repeated one when only some targets are duplicates", () => {
      const p = setup();
      send(p, "lead", "a.md", "to: fe-member\ntype: task\nsubject: t1", TEXT);
      routeOutboxes(p);
      send(p, "lead", "b.md", "to: [fe-member, qa-member]\ntype: task\nsubject: t1", TEXT);
      const r = routeOutboxes(p);
      expect(r.delivered.map((d) => d.to)).toEqual(["qa-member"]);
      expect(r.rejected[0]?.reason).toMatch(/to "fe-member" it repeats/);
      expect(listUnread(p, "lead").find((m) => m.meta.type === "failure")?.body).toMatch(/was delivered, except that to "fe-member"/);
    });

    it("running the pass again after a crash does not mistake mail it already delivered for a repeat", () => {
      const base = setup();
      const p = bindRunProject(base, path.join(base.paths.runs, "run-a"), "run");
      ensureProjectDirs(p);
      send(p, "fe-member", "a.md", "to: lead\ntype: reply\nsubject: first", TEXT);
      const file = path.join(outboxDir(p, "fe-member"), "a.md");
      const original = { text: fs.readFileSync(file, "utf8"), mtime: fs.statSync(file).mtime };
      const first = routeOutboxes(p);
      expect(first.delivered).toHaveLength(1);
      // the very same outbox file comes back, as if the crash happened before it was moved
      fs.writeFileSync(file, original.text);
      fs.utimesSync(file, original.mtime, original.mtime);
      const again = routeOutboxes(p);
      expect(again.rejected).toEqual([]);
      expect(listUnread(p, "lead")).toHaveLength(1);
    });
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
