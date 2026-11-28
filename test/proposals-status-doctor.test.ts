import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseProject } from "../src/doctor.js";
import { proposalsDir } from "../src/policy.js";
import { buildStatusReport, formatStatusReport } from "../src/status.js";
import { makeEnv, registerReviewer, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const prop = (fm: string, date = "2026-11-20") => `---\n${fm}\ndate: ${date}\ntitle: T\nproposed_by: fe-member\nrun: r\nevidence:\n  - mail: m1\n---\nfacts\n`;
const put = (p: ReturnType<TestEnv["project"]>, name: string, text: string) => write(path.join(proposalsDir(p), "lessons", `${name}.md`), text);

describe("status and doctor on proposals (spec 30)", () => {
  it("status shows how many wait and the oldest date on the human page, and leaves --json alone", () => {
    env = makeEnv();
    const p = env.project();
    const plain = formatStatusReport(buildStatusReport(p));
    expect(plain).not.toContain("提案");
    put(p, "ab12cd34-a", prop("status: proposed", "2026-11-10"));
    put(p, "ab12cd34-b", prop("status: proposed", "2026-11-22"));
    put(p, "ab12cd34-c", prop("status: rejected\nreject_reason: no\ndecided: 2026-11-21"));
    const report = buildStatusReport(p);
    expect(formatStatusReport(report)).toContain("提案：2 筆待審（最舊 2026-11-10）");
    expect(JSON.stringify(report)).not.toMatch(/proposal|提案/);
  });

  it("doctor reports the waiting count, a badly formed pending proposal and an incomplete decision, but not a badly formed rejected one", async () => {
    env = makeEnv();
    const p = env.project();
    put(p, "ab12cd34-a", prop("status: proposed"));
    put(p, "ab12cd34-bad", "no frontmatter\n");
    put(p, "ab12cd34-half", prop("status: accepted"));
    put(p, "ab12cd34-rej", "---\nstatus: rejected\nreject_reason: junk\ndecided: 2026-11-21\n---\nbroken but rejected\n");
    const report = await diagnoseProject(p, { env: { ...process.env, PATH: path.join(env.root, "empty") } });
    const msgs = report.checks.filter((c) => c.subject === "proposals");
    const text = msgs.map((m) => `${m.level}: ${m.message}`).join("\n");
    expect(text).toMatch(/info: 2 proposal\(s\) wait for the lead/);
    expect(text).toMatch(/warn: .*ab12cd34-bad.md: missing frontmatter/);
    expect(text).toMatch(/warn: .*ab12cd34-half.md: accepted without accepted_as/);
    expect(text).not.toContain("ab12cd34-rej");
  });

  it("warns when a reviewer proposal has no finding or a minor severity, and not for a solo file name", async () => {
    env = makeEnv();
    registerReviewer(env, "cli-reviewer");
    const p = env.project();
    put(p, "ab12cd34-cli-reviewer-no-finding", prop("status: proposed"));
    put(p, "ab12cd34-cli-reviewer-nit", prop("status: proposed\nfinding:\n  mail: m.md\n  severity: nit\n  class: style"));
    put(p, "ab12cd34-use-x", prop("status: proposed"));
    const report = await diagnoseProject(p, { env: { ...process.env, PATH: path.join(env.root, "empty") } });
    const text = report.checks.filter((c) => c.subject === "proposals").map((m) => `${m.level}: ${m.message}`).join("\n");
    expect(text).toMatch(/ab12cd34-cli-reviewer-no-finding.md: finding is required/);
    expect(text).toMatch(/finding.severity must be blocker or major/);
    expect(text).not.toMatch(/use-x.md: finding is required/);
    expect(text).toMatch(/cli-reviewer-no-finding.md: run must be a run id/);
    expect(text).not.toMatch(/use-x.md: run must be a run id/);
  });

  it("neither says anything when there are no proposals", async () => {
    env = makeEnv();
    const report = await diagnoseProject(env.project(), { env: { ...process.env, PATH: path.join(env.root, "empty") } });
    expect(report.checks.filter((c) => c.subject === "proposals")).toEqual([]);
  });
});
