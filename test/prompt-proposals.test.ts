import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { proposalsDir } from "../src/policy.js";
import { buildSoloSystemPrompt, buildSystemPrompt, buildUserPrompt } from "../src/prompt.js";
import { RECORDS_BUDGET } from "../src/records.js";
import { bindRunProject } from "../src/run-store.js";
import { soloProject } from "../src/solo.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const RUN = "20261123T010203456Z-ab12cd34ef56ab12cd34ef56ab12cd34";
const prop = (status: string, date: string, title: string, extra = "") =>
  `---\nstatus: ${status}\ndate: ${date}\ntitle: ${title}\nproposed_by: fe-member\nrun: ${RUN}\nevidence:\n  - mail: m1\n${extra}---\nfacts\n`;
const put = (p: ReturnType<TestEnv["project"]>, name: string, text: string, kind = "lessons") => write(path.join(proposalsDir(p), kind, `${name}.md`), text);

describe("the solo agent's prompt (spec 30)", () => {
  it("names the proposals folder and the fixed file-name prefix, and keeps the handoff clause for run --agent", () => {
    env = makeEnv();
    const p = bindRunProject(soloProject(env.project(), "fe-member"), path.join(env.root, RUN), "run");
    const text = buildSoloSystemPrompt(p, p.agents["fe-member"]!);
    expect(text).toContain("## Proposals");
    expect(text).toContain(`\`ab12cd34-<slug>.md\``);
    expect(text).toContain(`${proposalsDir(p)}/lessons/`);
    expect(text).toMatch(/never set `status` to anything but `proposed`/);
    expect(text).toMatch(/handoff notes are for the state/);
  });

  it("says nothing about proposals to a plain `call`, and never shows a solo agent the lead's pending note", () => {
    env = makeEnv();
    const base = soloProject(env.project(), "fe-member");
    const call = { ...base, solo: "call" as const };
    expect(buildSoloSystemPrompt(call, call.agents["fe-member"]!)).not.toContain("Proposals");
    const run = bindRunProject(base, path.join(env.root, RUN), "run");
    put(run, "ab12cd34-a", prop("proposed", "2026-11-20", "A"));
    expect(buildUserPrompt(run, run.agents["fe-member"]!, [])).not.toContain("Proposals waiting for you");
  });

  it("tells a `call -p` agent the real project's prefix and paths, without the handoff clause", () => {
    env = makeEnv();
    const base = { ...soloProject(env.project(), "fe-member"), solo: "call" as const };
    const real = path.join(env.root, "real");
    const p = { ...base, proposalsRef: { projectRoot: real, recordsRoot: path.join(real, "shared/common/records"), proposalsRoot: path.join(real, "proposals"), dir: env.repo, shortId: "cd34ab12" } };
    const text = buildSoloSystemPrompt(p, p.agents["fe-member"]!);
    expect(text).toContain("`cd34ab12-<slug>.md`");
    expect(text).toContain(`${path.join(real, "proposals")}/lessons/`);
    expect(text).not.toMatch(/handoff notes/);
    expect(text).toContain(path.join(real, "shared/common/records", "lessons"));
    expect(text).toContain(path.join(real, "shared/common", "COMMON.md"));
  });
});

describe("the lead's pending note (spec 30)", () => {
  const lead = () => {
    const p = bindRunProject(env.project(), path.join(env.root, "run-1"), "run");
    return { p, agent: p.agents[p.lead]! };
  };

  it("is absent with no proposals, with an empty folder, and with only decided proposals: the prompt is byte-identical", () => {
    env = makeEnv();
    const { p, agent } = lead();
    const plain = buildUserPrompt(p, agent, []);
    write(path.join(proposalsDir(p), "lessons", ".keep"), "");
    expect(buildUserPrompt(p, agent, [])).toBe(plain);
    put(p, "ab12cd34-done", prop("rejected", "2026-11-20", "D", "reject_reason: no\ndecided: 2026-11-21\n"));
    expect(buildUserPrompt(p, agent, [])).toBe(plain);
    const member = p.agents["fe-member"]!;
    const memberPlain = buildUserPrompt(p, member, []);
    put(p, "ab12cd34-wait", prop("proposed", "2026-11-22", "W"));
    expect(buildUserPrompt(p, member, [])).toBe(memberPlain);
  });

  it("lists the count, the oldest date, the path, the title, the evidence strength and the budget", () => {
    env = makeEnv();
    const { p, agent } = lead();
    put(p, "ab12cd34-old", prop("proposed", "2026-11-10", "Old one"));
    put(p, "ab12cd34-new", prop("proposed", "2026-11-22", "New one"), "decisions");
    put(p, "ab12cd34-bad", "no frontmatter\n");
    const text = buildUserPrompt(p, agent, []);
    expect(text).toContain("## Proposals waiting for you");
    expect(text).toContain("3 proposals await a decision (oldest: 2026-11-10). Showing 3:");
    expect(text).toContain(path.join(proposalsDir(p), "lessons", "ab12cd34-old.md"));
    expect(text).toContain("Old one — no machine-verifiable evidence");
    expect(text).toContain("format problem: missing frontmatter");
    expect(text).toContain(`decisions 0 of ${RECORDS_BUDGET} bytes, lessons 0 of ${RECORDS_BUDGET} bytes`);
    expect(text).toContain("decided: <today's date>");
  });

  it("shows at most 10 and still gives the total", () => {
    env = makeEnv();
    const { p, agent } = lead();
    for (let i = 0; i < 12; i++) put(p, `ab12cd34-p${String(i).padStart(2, "0")}`, prop("proposed", `2026-11-${String(i + 1).padStart(2, "0")}`, `T${i}`));
    const text = buildUserPrompt(p, agent, []);
    expect(text).toContain("12 proposals await a decision (oldest: 2026-11-01). Showing 10:");
    expect(text.match(/ab12cd34-p\d\d\.md/g)).toHaveLength(10);
  });

  it("does not change the system prompt of an ordinary agent", () => {
    env = makeEnv();
    const { p, agent } = lead();
    const before = buildSystemPrompt(p, agent);
    put(p, "ab12cd34-a", prop("proposed", "2026-11-20", "A"));
    expect(buildSystemPrompt(p, agent)).toBe(before);
  });
});
