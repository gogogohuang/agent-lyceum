import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProjectDirs, routeOutboxes } from "../src/mailbox.js";
import { outboxDir, recordsKindDir } from "../src/policy.js";
import { checkDecisions, listProposals } from "../src/proposals.js";
import { bindRunProject } from "../src/run-store.js";
import { git, initGitRepo, makeEnv, registerReviewer, REPLY_BODY, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const RUN = "20261128T010203456Z-ab12cd34ef56ab12cd34ef56ab12cd34";
const MAIL = "20261128T010203456Z-cli-reviewer-aabbccdd.md";

describe("accepting a reviewer finding (issue 177)", () => {
  function setup() {
    env = makeEnv();
    registerReviewer(env, "cli-reviewer");
    initGitRepo(env.repo, { "src/a.ts": "one\ntwo\nthree\n" });
    const sha = git(env.repo, "rev-parse", "HEAD");
    const runDir = path.join(env.project().paths.runs, RUN);
    const project = bindRunProject(env.project(), runDir, "run");
    write(path.join(runDir, "state.json"), JSON.stringify({ mail_layout: "run" }));
    write(
      path.join(runDir, "mail", "inbox", project.lead, MAIL),
      `---\ntype: reply\nverdict: changes_requested\nsubject: review\n---\n## Changes\nquote yaml\n`,
    );
    const evidence = `src/a.ts:2 @ ${sha}`;
    const proposal = (fm: string, evidenceLines = `  - path: ${evidence}`) =>
      write(
        path.join(project.paths.root, "proposals", "lessons", "ab12cd34-cli-reviewer-quote-yaml.md"),
        `---\n${fm}\ndate: 2026-11-28\ntitle: Quote yaml\nproposed_by: cli-reviewer\nrun: ${RUN}\nfinding:\n  mail: ${MAIL}\n  severity: major\n  class: quote-yaml\nevidence:\n${evidenceLines}\n---\nfacts\n`,
      );
    const record = (body: string) =>
      write(
        path.join(recordsKindDir(project, "lessons"), "from-review.md"),
        `---\nstatus: active\ndate: 2026-11-28\ntitle: From review\n---\n${body}\n`,
      );
    const problems = () => checkDecisions(listProposals(project), project).map((d) => d.problem);
    const copied = `## Evidence\n${evidence}\n${MAIL}\nmajor\nquote-yaml\n`;
    return { project, proposal, record, problems, copied, sha };
  }

  it("accepts a complete reviewer proposal", () => {
    const { proposal, record, problems, copied } = setup();
    proposal("status: accepted\naccepted_as: lessons/from-review\ndecided: 2026-11-28");
    record(copied);
    expect(problems()).toEqual([]);
  });

  it("rejects an acceptance that has no finding", () => {
    const { project, record, problems, copied } = setup();
    record(copied);
    write(
      path.join(project.paths.root, "proposals", "lessons", "ab12cd34-cli-reviewer-quote-yaml.md"),
      `---\nstatus: accepted\naccepted_as: lessons/from-review\ndecided: 2026-11-28\ndate: 2026-11-28\ntitle: Quote yaml\nproposed_by: cli-reviewer\nrun: ${RUN}\nevidence:\n  - commit: ${git(env.repo, "rev-parse", "HEAD")}\n---\nfacts\n`,
    );
    expect(problems()).toContain("accepted but finding is required");
  });

  it("rejects minor and nit severities", () => {
    const { proposal, record, problems, copied } = setup();
    record(copied);
    for (const severity of ["minor", "nit"]) {
      proposal("status: accepted\naccepted_as: lessons/from-review\ndecided: 2026-11-28");
      const file = path.join(env.project().paths.root, "proposals", "lessons", "ab12cd34-cli-reviewer-quote-yaml.md");
      // setup() binds a project whose paths.root is still the project root; the file written by proposal() is there.
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("severity: major", `severity: ${severity}`));
      expect(problems()).toContain("accepted but finding.severity must be blocker or major");
    }
  });

  it("rejects a missing mail and a mail that is not a verdict reply, and skips the check once the run directory is gone", () => {
    const { project, proposal, record, problems, copied } = setup();
    proposal("status: accepted\naccepted_as: lessons/from-review\ndecided: 2026-11-28");
    record(copied);
    const mail = path.join(project.run!.dir, "mail", "inbox", project.lead, MAIL);
    fs.rmSync(mail);
    expect(problems()).toContain("accepted but finding.mail was not found");
    write(mail, "---\ntype: task\nsubject: x\n---\n");
    expect(problems()).toContain("accepted but finding.mail is not a reply with verdict");
    write(mail, "---\ntype: reply\nsubject: x\n---\n");
    expect(problems()).toContain("accepted but finding.mail is not a reply with verdict");
    fs.rmSync(project.run!.dir, { recursive: true, force: true });
    expect(problems()).toEqual([]);
  });

  it("rejects evidence that is only mail or only output", () => {
    const { proposal, record, problems } = setup();
    record("## Evidence\nmail only\n");
    proposal("status: accepted\naccepted_as: lessons/from-review\ndecided: 2026-11-28", "  - mail: m1");
    expect(problems()).toContain("accepted but evidence is not verified");
    proposal("status: accepted\naccepted_as: lessons/from-review\ndecided: 2026-11-28", '  - output: "npm test => 1 failed"');
    expect(problems()).toContain("accepted but evidence is not verified");
  });

  it("rejects a record without ## Evidence, and one that does not copy the evidence and finding", () => {
    const { proposal, record, problems, copied } = setup();
    proposal("status: accepted\naccepted_as: lessons/from-review\ndecided: 2026-11-28");
    record("The lesson, with no heading.");
    expect(problems()).toContain("accepted but the record has no ## Evidence section");
    record("## Evidence\nnothing copied");
    expect(problems()).toContain("accepted but the record does not copy the evidence and finding");
    record(copied);
    expect(problems()).toEqual([]);
  });

  it("lets the lead reject a reviewer proposal that has no finding", () => {
    const { project, problems } = setup();
    write(
      path.join(project.paths.root, "proposals", "lessons", "ab12cd34-cli-reviewer-quote-yaml.md"),
      `---\nstatus: rejected\nreject_reason: not a lesson\ndecided: 2026-11-28\ndate: 2026-11-28\ntitle: T\nproposed_by: cli-reviewer\nrun: ${RUN}\nevidence:\n  - mail: m1\n---\nfacts\n`,
    );
    expect(problems()).toEqual([]);
  });

  it("finds the reply by the outbox file name after it has been routed to sent/", () => {
    const { project, record, problems, sha } = setup();
    ensureProjectDirs(project);
    const draft = "quote-yaml.md";
    write(
      path.join(outboxDir(project, "cli-reviewer"), draft),
      `---\nto: lead\ntype: reply\nsubject: review\nverdict: changes_requested\n---\n${REPLY_BODY}\n`,
    );
    expect(routeOutboxes(project).rejected).toEqual([]);
    expect(fs.existsSync(path.join(outboxDir(project, "cli-reviewer"), "sent", draft))).toBe(true);
    const evidence = `src/a.ts:2 @ ${sha}`;
    write(
      path.join(project.paths.root, "proposals", "lessons", "ab12cd34-cli-reviewer-quote-yaml.md"),
      `---\nstatus: accepted\naccepted_as: lessons/from-review\ndecided: 2026-11-28\ndate: 2026-11-28\ntitle: Quote yaml\nproposed_by: cli-reviewer\nrun: ${RUN}\nfinding:\n  mail: ${draft}\n  severity: major\n  class: quote-yaml\nevidence:\n  - path: ${evidence}\n---\nfacts\n`,
    );
    record(`## Evidence\n${evidence}\n${draft}\nmajor\nquote-yaml\n`);
    expect(problems()).toEqual([]);
  });

  it("still checks the mail when run is only the short id of a directory that exists", () => {
    const { project, proposal, record, problems, copied } = setup();
    proposal("status: accepted\naccepted_as: lessons/from-review\ndecided: 2026-11-28");
    record(copied);
    const file = path.join(project.paths.root, "proposals", "lessons", "ab12cd34-cli-reviewer-quote-yaml.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(`run: ${RUN}`, "run: ab12cd34"));
    expect(problems()).toContain("accepted but run must be a run id");
    expect(problems()).not.toContain("accepted but finding.mail was not found");
    fs.rmSync(path.join(project.run!.dir, "mail", "inbox", project.lead, MAIL));
    expect(problems()).toContain("accepted but finding.mail was not found");
  });

  it("does not follow a run value that leaves the runs directory", () => {
    const { project, proposal, record, problems, copied } = setup();
    proposal("status: accepted\naccepted_as: lessons/from-review\ndecided: 2026-11-28");
    record(copied);
    const outside = path.join(env.root, "outside-run");
    write(path.join(outside, "state.json"), JSON.stringify({ mail_layout: "run" }));
    write(
      path.join(outside, "mail", "inbox", project.lead, MAIL),
      "---\ntype: task\nsubject: x\n---\n",
    );
    const claimed = path.relative(project.paths.runs, outside);
    const file = path.join(project.paths.root, "proposals", "lessons", "ab12cd34-cli-reviewer-quote-yaml.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(`run: ${RUN}`, `run: ${claimed}`));
    const found = problems();
    expect(found).toContain("accepted but run must be a run id");
    expect(found).not.toContain("accepted but finding.mail is not a reply with verdict");
  });

  it("accepts a solo file whose run is only the short id", () => {
    const { project, problems } = setup();
    write(path.join(recordsKindDir(project, "lessons"), "real.md"), "---\nstatus: active\ndate: 2026-11-28\ntitle: T\n---\nbody\n");
    write(
      path.join(project.paths.root, "proposals", "lessons", "ab12cd34-use-x.md"),
      `---\nstatus: accepted\naccepted_as: lessons/real\ndecided: 2026-11-28\ndate: 2026-11-28\ntitle: T\nproposed_by: fe-member\nrun: ab12cd34\nevidence:\n  - mail: m1\n---\nfacts\n`,
    );
    expect(problems()).toEqual([]);
  });

  it("accepts a proposal from a reviewer instance that is not in the agent table", () => {
    const { project, record, problems, copied, sha } = setup();
    const evidence = `src/a.ts:2 @ ${sha}`;
    write(
      path.join(project.paths.root, "proposals", "lessons", "ab12cd34-cli-reviewer--2-quote-yaml.md"),
      `---\nstatus: accepted\naccepted_as: lessons/from-review\ndecided: 2026-11-28\ndate: 2026-11-28\ntitle: Quote yaml\nproposed_by: cli-reviewer--2\nrun: ${RUN}\nfinding:\n  mail: ${MAIL}\n  severity: major\n  class: quote-yaml\nevidence:\n  - path: ${evidence}\n---\nfacts\n`,
    );
    record(copied);
    expect(problems()).toEqual([]);
  });

  it("uses the sent copy when a rejected file has the same name, and ignores another agent's outbox", () => {
    const { project, proposal, record, problems, copied } = setup();
    proposal("status: accepted\naccepted_as: lessons/from-review\ndecided: 2026-11-28");
    record(copied);
    const verdict = "---\ntype: reply\nverdict: changes_requested\nsubject: review\n---\n## Changes\nquote yaml\n";
    write(path.join(project.run!.dir, "mail", "outbox", "cli-reviewer", "sent", MAIL), verdict);
    write(path.join(project.run!.dir, "mail", "outbox", "cli-reviewer", "rejected", MAIL), "---\ntype: task\nsubject: x\n---\n");
    write(path.join(project.run!.dir, "mail", "outbox", "qa-member", "sent", MAIL), "---\ntype: task\nsubject: other\n---\n");
    expect(problems()).toEqual([]);
  });

  it("does not apply the reviewer rules to a solo file name", () => {
    const { project, problems } = setup();
    write(path.join(recordsKindDir(project, "lessons"), "real.md"), "---\nstatus: active\ndate: 2026-11-28\ntitle: T\n---\nbody\n");
    write(
      path.join(project.paths.root, "proposals", "lessons", "ab12cd34-use-x.md"),
      `---\nstatus: accepted\naccepted_as: lessons/real\ndecided: 2026-11-28\ndate: 2026-11-28\ntitle: T\nproposed_by: fe-member\nrun: ${RUN}\nevidence:\n  - mail: m1\n---\nfacts\n`,
    );
    expect(problems()).toEqual([]);
  });
});
