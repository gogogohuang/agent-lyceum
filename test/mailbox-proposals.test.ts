import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProjectDirs, routeOutboxes } from "../src/mailbox.js";
import { outboxDir, proposalsDir, recordsKindDir } from "../src/policy.js";
import { soloProject } from "../src/solo.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const RUN = "20261123T010203456Z-ab12cd34ef56ab12cd34ef56ab12cd34";
const prop = (fm: string) => `---\n${fm}\ndate: 2026-11-20\ntitle: T\nproposed_by: fe-member\nrun: ${RUN}\nevidence:\n  - mail: m1\n---\nfacts\n`;
const put = (p: ReturnType<TestEnv["project"]>, name: string, text: string) => write(path.join(proposalsDir(p), "lessons", `${name}.md`), text);
const done = (p: ReturnType<TestEnv["project"]>, from: string, name = "d.md") => write(path.join(outboxDir(p, from), name), "---\ntype: done\nsubject: ship\n---\n\nsummary\n");

describe("the lead's done and the decisions on proposals (spec 30, D-09 layer 1)", () => {
  it("is rejected while an accepted proposal lacks accepted_as or decided, and names the file", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    put(p, "ab12cd34-a", prop("status: accepted"));
    done(p, "lead");
    const r = routeOutboxes(p);
    expect(r.done).toBeUndefined();
    expect(r.rejected[0]!.reason).toContain(path.join(proposalsDir(p), "lessons", "ab12cd34-a.md"));
    expect(r.rejected[0]!.reason).toMatch(/accepted without accepted_as/);
  });

  it("is rejected for a rejected proposal without reject_reason, and goes through once it is complete", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    put(p, "ab12cd34-r", prop("status: rejected"));
    done(p, "lead");
    expect(routeOutboxes(p).done).toBeUndefined();
    put(p, "ab12cd34-r", prop("status: rejected\nreject_reason: duplicate\ndecided: 2026-11-21"));
    done(p, "lead", "d2.md");
    expect(routeOutboxes(p).done).toMatchObject({ subject: "ship" });
  });

  it("is rejected for an accepted proposal that has no evidence, even when the decision fields are complete", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    write(path.join(recordsKindDir(p, "lessons"), "real.md"), "---\nstatus: active\ndate: 2026-11-21\ntitle: R\n---\nx\n");
    const noEvidence = prop("status: accepted\naccepted_as: lessons/real\ndecided: 2026-11-21").replace("evidence:\n  - mail: m1\n", "");
    put(p, "ab12cd34-ne", noEvidence);
    done(p, "lead");
    const r = routeOutboxes(p);
    expect(r.done).toBeUndefined();
    expect(r.rejected[0]!.reason).toMatch(/accepted but evidence is required/);
    // A rejected proposal without evidence is fine: rejecting a malformed proposal must not block done.
    put(p, "ab12cd34-ne", noEvidence.replace("status: accepted\naccepted_as: lessons/real", "status: rejected\nreject_reason: no evidence"));
    done(p, "lead", "d2.md");
    expect(routeOutboxes(p).done).toMatchObject({ subject: "ship" });
  });

  it("accepts a done when the accepted proposal is complete and its record exists", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    write(path.join(recordsKindDir(p, "lessons"), "real.md"), "---\nstatus: active\ndate: 2026-11-21\ntitle: R\n---\nx\n");
    put(p, "ab12cd34-ok", prop("status: accepted\naccepted_as: lessons/real\ndecided: 2026-11-21"));
    done(p, "lead");
    expect(routeOutboxes(p).done).toMatchObject({ subject: "ship" });
  });

  it("is not blocked by pending proposals, however badly formed, or by missing evidence", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    put(p, "ab12cd34-wait", prop("status: proposed"));
    put(p, "ab12cd34-junk", "no frontmatter\n");
    done(p, "lead");
    expect(routeOutboxes(p).done).toMatchObject({ subject: "ship" });
  });

  it("is not checked for a solo run, whose lead is the agent that wrote the proposals", () => {
    env = makeEnv();
    const p = soloProject(env.project(), "fe-member");
    ensureProjectDirs(p);
    put(p, "ab12cd34-a", prop("status: accepted"));
    done(p, "fe-member");
    expect(routeOutboxes(p).done).toMatchObject({ subject: "ship" });
  });
});
