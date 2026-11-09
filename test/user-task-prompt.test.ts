import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../src/mailbox.js";
import { USER_TASK_LIMIT, buildUserPrompt } from "../src/prompt.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

function mail(body: string): Message {
  return { meta: { id: "m1", from: "lead", to: "fe-member", thread: "t1", type: "task", subject: "s", created: "" }, body, file: "/x/20260101000001-lead-m1.md" };
}

describe("user_task in a teammate's wake-up prompt", () => {
  it("shows the user's original task to a non-lead agent", () => {
    env = makeEnv();
    const p = env.project();
    const out = buildUserPrompt(p, p.agents["fe-member"]!, [mail("do it")], 1, false, { text: "Make the button blue\n", file: "/run/task.md" });
    expect(out).toContain("<user_task");
    expect(out).toContain("Make the button blue");
    expect(out.indexOf("<user_task")).toBeLessThan(out.indexOf("<messages"));
  });

  it("does not show it to the lead", () => {
    env = makeEnv();
    const p = env.project();
    expect(buildUserPrompt(p, p.agents[p.lead]!, [mail("x")], 1, false, { text: "Make the button blue" })).not.toContain("<user_task");
  });

  it("does not duplicate it when a mail already carries the tag", () => {
    env = makeEnv();
    const p = env.project();
    const out = buildUserPrompt(p, p.agents["fe-member"]!, [mail("<user_task>Make the button blue</user_task>")], 1, false, { text: "Make the button blue" });
    expect(out.match(/<user_task/g)).toHaveLength(1);
  });

  it("is absent without a task, and cut at the limit with a pointer to the file", () => {
    env = makeEnv();
    const p = env.project();
    const member = p.agents["fe-member"]!;
    expect(buildUserPrompt(p, member, [mail("x")], 1, false)).not.toContain("<user_task");
    const out = buildUserPrompt(p, member, [mail("x")], 1, false, { text: "a".repeat(USER_TASK_LIMIT + 500), file: "/run/task.md" });
    expect(out).toContain("cut at");
    expect(out).toContain("/run/task.md");
  });
});
