import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtectedGuard } from "../src/guard.js";
import { archiveFile, decisionsFile, lessonsFile, writePolicy } from "../src/policy.js";
import { CONTEXT_LIMIT, buildSystemPrompt, buildUserPrompt } from "../src/prompt.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("project decisions and lessons", () => {
  it("only the lead may write them (and their archives); members are denied", () => {
    env = makeEnv();
    const p = env.project();
    const files = [decisionsFile(p), lessonsFile(p), archiveFile(decisionsFile(p)), archiveFile(lessonsFile(p))];
    const lead = writePolicy(p, p.agents.lead);
    const member = writePolicy(p, p.agents["fe-member"]);
    for (const f of files) {
      expect(lead.allowFiles).toContain(f);
      expect(lead.deny).not.toContain(f);
      expect(member.deny).toContain(f);
      expect(ProtectedGuard.protectedFiles(p)).toContain(f);
    }
  });

  it("are shown in the user prompt only once they hold something", () => {
    env = makeEnv();
    const p = env.project();
    expect(buildUserPrompt(p, p.agents["fe-member"], [])).not.toContain("DECISIONS.md");
    write(decisionsFile(p), "- use sqlite: no server to run\n");
    write(lessonsFile(p), "- run the build before the tests\n");
    const prompt = buildUserPrompt(p, p.agents["fe-member"], []);
    expect(prompt).toContain("# Project decisions (DECISIONS.md)");
    expect(prompt).toContain("use sqlite");
    expect(prompt).toContain("# Project lessons (LESSONS.md)");
    expect(prompt).toContain("run the build before the tests");
  });

  it("are capped, with a note that points at the archive", () => {
    env = makeEnv();
    const p = env.project();
    write(decisionsFile(p), "x".repeat(CONTEXT_LIMIT + 100));
    const prompt = buildUserPrompt(p, p.agents.lead, []);
    expect(prompt).toContain(`DECISIONS.md was truncated at ${CONTEXT_LIMIT} bytes`);
    expect(prompt).toContain("DECISIONS_ARCHIVE.md");
  });

  it("the lead's rules tell it to keep them; a member's do not", () => {
    env = makeEnv();
    const p = env.project();
    expect(buildSystemPrompt(p, p.agents.lead)).toContain(decisionsFile(p));
    expect(buildSystemPrompt(p, p.agents["fe-member"])).not.toContain(path.basename(decisionsFile(p)));
    expect(fs.existsSync(decisionsFile(p))).toBe(false); // nothing is created behind the user's back
  });
});
