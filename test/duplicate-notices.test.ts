import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTeam } from "../src/dispatcher.js";
import { duplicateNoticeKey, shouldNotifyDuplicate } from "../src/duplicate-notices.js";
import { formatRejectionKey } from "../src/format-rejections.js";
import { deliver, listUnread, routeOutboxes } from "../src/mailbox.js";
import { setFaultHook } from "../src/message-store.js";
import { outboxDir } from "../src/policy.js";
import { bindRunProject, loadRunState } from "../src/run-store.js";
import { makeEnv, type TestEnv, withSections, write } from "./helpers.js";

let env: TestEnv;
let n = 0;
afterEach(() => {
  setFaultHook(undefined);
  env?.cleanup();
});
function setup(layout: "run" | "legacy" = "run") {
  env = makeEnv();
  const p = env.project();
  return bindRunProject(p, path.join(p.paths.runs, "review"), layout);
}
type P = ReturnType<typeof setup>;
function send(p: P, from: string, to: string | string[], body = "the same long completed result") {
  write(path.join(outboxDir(p, from), `mail-${++n}.md`), `---\nto: ${JSON.stringify(to)}\ntype: reply\nsubject: probe\n---\n${withSections("reply", body)}`);
}
const failures = (p: P, agent = "fe-member") => listUnread(p, agent).filter((m) => m.meta.type === "failure").length;
function crashOnce(p: P) {
  setFaultHook((step) => {
    if (step === "route:intent") throw new Error("crash");
  });
  expect(() => routeOutboxes(p)).toThrow("crash");
  setFaultHook(undefined);
  routeOutboxes(p);
}

describe("duplicate notice accounting", () => {
  it("a crash on the 1st notice, replayed, still leaves two notices in total", () => {
    const p = setup();
    send(p, "fe-member", "lead");
    routeOutboxes(p);
    send(p, "fe-member", "lead");
    crashOnce(p);
    send(p, "fe-member", "lead");
    routeOutboxes(p);
    send(p, "fe-member", "lead");
    routeOutboxes(p);
    expect(failures(p)).toBe(2);
  });
  it("a crash on the 2nd notice, replayed, still delivers it", () => {
    const p = setup();
    for (let i = 0; i < 2; i++) {
      send(p, "fe-member", "lead");
      routeOutboxes(p);
    }
    send(p, "fe-member", "lead");
    crashOnce(p);
    expect(failures(p)).toBe(2);
    send(p, "fe-member", "lead");
    routeOutboxes(p);
    expect(failures(p)).toBe(2);
  });
  it("a source counted before the crash is neither counted again nor silenced", () => {
    const p = setup();
    const dir = p.run!.dir;
    const key = duplicateNoticeKey("a", [["lead", "x"]]);
    expect(shouldNotifyDuplicate(dir, key, "s1")).toBe(true);
    expect(shouldNotifyDuplicate(dir, key, "s1")).toBe(true);
    expect(shouldNotifyDuplicate(dir, key, "s2")).toBe(true);
    expect(shouldNotifyDuplicate(dir, key, "s2")).toBe(true);
    expect(shouldNotifyDuplicate(dir, key, "s3")).toBe(false);
  });
  it("keeps its budget apart from format rejections (sender reply/to lead vs sender duplicate/type reply)", () => {
    const p = setup();
    const dir = p.run!.dir;
    const id = "123456ab";
    const dup = duplicateNoticeKey("reply", [["lead", id]]);
    expect(dup).not.toBe(formatRejectionKey("duplicate", "reply", `lead:${id}`));
    expect(shouldNotifyDuplicate(dir, dup, "s1")).toBe(true);
    expect(shouldNotifyDuplicate(dir, dup, "s2")).toBe(true);
    expect(shouldNotifyDuplicate(dir, duplicateNoticeKey("duplicate", [["reply", `lead:${id}`]]), "s3")).toBe(true);
  });
  it("caps notices in the legacy layout too", () => {
    const p = setup("legacy");
    for (let i = 0; i < 6; i++) {
      send(p, "fe-member", "lead");
      routeOutboxes(p);
    }
    expect(failures(p)).toBe(2);
  });
  it("a legacy run with max_rounds 0 ends idle within a few wakes", async () => {
    const p = setup("legacy");
    const dir = p.run!.dir;
    write(path.join(dir, "state.json"), JSON.stringify({ run_id: "review", project: p.name, rounds: 1, max_rounds: 0, end_reason: "idle", last_wake: {}, wakes: [] }));
    deliver(p, { from: "lead", to: "fe-member", type: "task", subject: "start", body: withSections("task", "start the implementation") });
    let wakes = 0;
    const s = await runTeam({
      project: env.project(),
      runDir: dir,
      resume: loadRunState(dir),
      log: () => {},
      invoker: async (i) => {
        if (i.agent.name === "fe-member") {
          if (++wakes > 30) throw new Error("loop fuse");
          send(i.project, "fe-member", "lead");
          send(i.project, "fe-member", "lead");
        }
        return { ok: true, text: "", exitCode: 0, timedOut: false };
      },
    });
    expect(wakes).toBeLessThanOrEqual(4);
    expect(s.endReason).toBe("idle");
  });
});
