import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../src/mailbox.js";
import { MAIL_BATCH_LIMIT, MAIL_BODY_LIMIT, buildUserPrompt } from "../src/prompt.js";
import { bindRunProject } from "../src/run-store.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

function bound() {
  env = makeEnv();
  const base = env.project();
  return bindRunProject(base, path.join(base.paths.runs, "run-a"), "run");
}
const msg = (i: number, body: string, type: Message["meta"]["type"] = "reply"): Message => ({
  meta: { id: `id${i}`, from: "fe-member", to: "lead", thread: "t", type, subject: `s${i}`, created: "2026-01-01T00:00:00Z" },
  body,
  file: `/inbox/lead/m${i}.md`,
});

describe("mail body cap in the wake-up prompt", () => {
  it("cuts a 20,000 B mail at 16 KiB and points at the original file", () => {
    const p = bound();
    const body = `${"x".repeat(19_980)}\nLAST-LINE-MARKER`;
    const prompt = buildUserPrompt(p, p.agents.lead, [msg(1, body)], 1);
    expect(prompt).not.toContain("LAST-LINE-MARKER");
    expect(prompt).toContain(`cut at ${MAIL_BODY_LIMIT} of ${Buffer.byteLength(body)} bytes`);
    expect(prompt).toContain("`/inbox/lead/m1.md`");
    expect(prompt).toContain("id: id1"); // header untouched
  });

  it("does not cut a 15 KiB mail", () => {
    const p = bound();
    const body = `${"y".repeat(15 * 1024 - 5)}\nEND`;
    const prompt = buildUserPrompt(p, p.agents.lead, [msg(1, body)], 1);
    expect(prompt).toContain(body);
    expect(prompt).not.toContain("this message was cut");
  });

  it("cuts on a UTF-8 boundary when a 3-byte character straddles the limit", () => {
    const p = bound();
    const body = `ab${"中".repeat(8000)}`; // 2 + 24000 bytes; byte 16384 is inside a character
    const prompt = buildUserPrompt(p, p.agents.lead, [msg(1, body)], 1);
    expect(prompt).not.toContain("�");
    expect(prompt).toContain("cut at 16382 of 24002 bytes");
  });

  it("holds a batch of 5 mails of 15 KiB to 64 KiB in total: the 5th is cut", () => {
    const p = bound();
    const msgs = [1, 2, 3, 4, 5].map((i) => msg(i, `${String(i).repeat(15 * 1024 - 8)}\nEND${i}`));
    const prompt = buildUserPrompt(p, p.agents.lead, msgs, 5);
    for (const i of [1, 2, 3, 4]) expect(prompt).toContain(`END${i}`);
    expect(prompt).not.toContain("END5");
    expect(prompt).toMatch(/`\/inbox\/lead\/m5\.md`/);
    expect(prompt).not.toMatch(/`\/inbox\/lead\/m4\.md`/);
    expect(MAIL_BATCH_LIMIT).toBe(64 * 1024);
  });
});
