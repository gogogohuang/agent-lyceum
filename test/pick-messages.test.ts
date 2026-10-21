import { afterEach, describe, expect, it } from "vitest";
import type { Message, MessageType } from "../src/mailbox.js";
import { buildSystemPrompt, pickMessages } from "../src/prompt.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

function mail(n: number, type: MessageType, thread: string): Message {
  const file = `/x/2026010100000${n}-lead-m${n}.md`;
  return { meta: { id: `m${n}`, from: "lead", to: "fe-member", thread, type, subject: `s${n}`, created: "" }, body: "b", file };
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
