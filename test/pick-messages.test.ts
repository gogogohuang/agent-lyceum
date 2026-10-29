import { afterEach, describe, expect, it } from "vitest";
import type { Message, MessageType } from "../src/mailbox.js";
import { LEAD_REPLY_CAP, MAIL_BODY_LIMIT, buildSystemPrompt, buildUserPrompt, pickMessages } from "../src/prompt.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

function mail(n: number, type: MessageType, thread: string, body = "b"): Message {
  const file = `/x/20260101000${String(n).padStart(3, "0")}-lead-m${n}.md`;
  return { meta: { id: `m${n}`, from: "lead", to: "fe-member", thread, type, subject: `s${n}`, created: "" }, body, file };
}

describe("pickMessages", () => {
  it("lets a member take consecutive same-thread replies together", () => {
    env = makeEnv();
    const p = env.project();
    const member = p.agents["fe-member"]!;
    const got = pickMessages(p, member, [mail(1, "reply", "t1"), mail(2, "reply", "t1"), mail(3, "reply", "t2")]);
    expect(got.map((m) => m.meta.id)).toEqual(["m1", "m2"]);
  });

  it("never batches a member's task, and keeps one message when threads differ", () => {
    env = makeEnv();
    const p = env.project();
    const member = p.agents["fe-member"]!;
    expect(pickMessages(p, member, [mail(1, "task", "t1"), mail(2, "reply", "t1")]).map((m) => m.meta.id)).toEqual(["m1"]);
    expect(pickMessages(p, member, [mail(1, "reply", "t1"), mail(2, "reply", "t2")]).map((m) => m.meta.id)).toEqual(["m1"]);
  });

  it("lets the lead batch replies across threads", () => {
    env = makeEnv();
    const p = env.project();
    const got = pickMessages(p, p.agents[p.lead]!, [mail(1, "reply", "t1"), mail(2, "failure", "t2")]);
    expect(got.map((m) => m.meta.id)).toEqual(["m1", "m2"]);
  });

  it("gives the lead every short reply that is already waiting", () => {
    env = makeEnv();
    const p = env.project();
    const queue = [1, 2, 3, 4, 5, 6].map((n) => mail(n, "reply", `t${n}`));
    expect(pickMessages(p, p.agents[p.lead]!, queue).map((m) => m.meta.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
  });

  it("leaves a lead reply unread when none of its body fits the batch budget", () => {
    env = makeEnv();
    const p = env.project();
    const fat = "x".repeat(MAIL_BODY_LIMIT);
    const queue = [1, 2, 3, 4, 5].map((n) => mail(n, "reply", `t${n}`, fat));
    const got = pickMessages(p, p.agents[p.lead]!, queue);
    expect(got.map((m) => m.meta.id)).toEqual(["m1", "m2", "m3", "m4"]);
    const prompt = buildUserPrompt(p, p.agents[p.lead]!, queue, got.length);
    expect(prompt).toContain('from lead [reply] "s5"');
    expect(prompt).not.toContain("id: m5");
  });

  it("still hands the lead a reply that only partly fits, and keeps the one after it unread", () => {
    env = makeEnv();
    const p = env.project();
    const chunk = "x".repeat(15 * 1024);
    const queue = [1, 2, 3, 4, 5, 6].map((n) => mail(n, "reply", `t${n}`, chunk));
    expect(pickMessages(p, p.agents[p.lead]!, queue).map((m) => m.meta.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("caps the lead at LEAD_REPLY_CAP waiting replies even when their bodies are tiny", () => {
    env = makeEnv();
    const p = env.project();
    const queue = Array.from({ length: LEAD_REPLY_CAP + 1 }, (_, i) => mail(i + 1, "reply", `t${i + 1}`));
    expect(pickMessages(p, p.agents[p.lead]!, queue)).toHaveLength(LEAD_REPLY_CAP);
  });

  it("keeps a member to five same-thread replies", () => {
    env = makeEnv();
    const p = env.project();
    const member = p.agents["fe-member"]!;
    const queue = [1, 2, 3, 4, 5, 6].map((n) => mail(n, "reply", "t1"));
    expect(pickMessages(p, member, queue).map((m) => m.meta.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("states the member batching rule in the system prompt and keeps the lead's line", () => {
    env = makeEnv();
    const p = env.project();
    expect(buildSystemPrompt(p, p.agents["fe-member"]!)).toContain(
      "except that consecutive `reply`/`failure` messages on the same thread may be handed to you together",
    );
    expect(buildSystemPrompt(p, p.agents[p.lead]!)).toContain(
      "except that several `reply`/`failure` messages waiting together are handed to you in one wake-up",
    );
  });
});
