import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../src/mailbox.js";
import { memoryDirs } from "../src/policy.js";
import { buildCallUserPrompt, buildUserPrompt } from "../src/prompt.js";
import { bindRunProject } from "../src/run-store.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

function bound() {
  env = makeEnv();
  const base = env.project();
  return bindRunProject(base, path.join(base.paths.runs, "run-a"), "run");
}
const msg = (i: number, subject = `s${i}`): Message => ({
  meta: { id: `id${i}`, from: "fe-member", to: "lead", thread: "t", type: "reply", subject, created: "2026-01-01T00:00:00Z" },
  body: `body ${i}`,
  file: `/inbox/lead/m${i}.md`,
});

describe("injected data is wrapped in tags", () => {
  it("wraps COMMON.md, each memory index and an empty message list", () => {
    const p = bound();
    const out = buildUserPrompt(p, p.agents.lead, [], 1);
    expect(out).toContain('<shared_context source="COMMON.md">');
    expect(out).toContain("</shared_context>");
    expect(out).toMatch(/<memory scope="(global|project|task)" dir="[^"]+" index="MEMORY\.md">/);
    expect(out).toContain("</memory>");
    expect(out).toContain('<messages count="0">\n(no message)\n</messages>');
    expect(out).not.toMatch(/^# (Shared team context|Your .* memory index|Messages? to handle now|Queued messages|Task)\b/m); // the old harness headings are gone
  });

  it("puts one mail in <message>, several in <message n of>, and keeps the header lines", () => {
    const p = bound();
    const one = buildUserPrompt(p, p.agents.lead, [msg(1)], 1);
    expect(one).toContain('<messages count="1">');
    expect(one).toMatch(/<message>\nid: id1\nfrom: .*\ntype: reply\nthread: t\nsubject: s1\n\nbody 1\n<\/message>\n<\/messages>/);

    const two = buildUserPrompt(p, p.agents.lead, [msg(1), msg(2)], 2);
    expect(two).toContain('<messages count="2" order="oldest first" note="decide on them together">');
    expect(two).toContain('<message n="1" of="2">');
    expect(two).toContain('<message n="2" of="2">');
  });

  it("lists mails beyond the handle count as titles inside <queued_messages>", () => {
    const p = bound();
    const out = buildUserPrompt(p, p.agents.lead, [msg(1), msg(2, "second job")], 1);
    expect(out).toMatch(/<queued_messages note="[^"]+">\n- from .* \[reply\] "second job" -> \/inbox\/lead\/m2\.md\n<\/queued_messages>/);
    expect(out.indexOf("</messages>")).toBeLessThan(out.indexOf("<queued_messages"));
  });

  it("leaves the data inside a block untouched (no escaping of < or &)", () => {
    const p = bound();
    const dir = memoryDirs(p.agents.lead)[0]!;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "- use `a < b && c` in tests\n");
    const out = buildUserPrompt(p, p.agents.lead, [], 1);
    expect(out).toContain("- use `a < b && c` in tests");
  });

  it("wraps the task of a `call` in <task> after the memory blocks", () => {
    const p = bound();
    const out = buildCallUserPrompt(p.agents.lead, "  do the thing\n");
    expect(out).toMatch(/<memory scope="[a-z]+" dir="[^"]+" index="MEMORY\.md">[\s\S]*<\/memory>\n\n<task>\ndo the thing\n<\/task>$/);
  });
});
