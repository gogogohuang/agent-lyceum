import { describe, expect, it } from "vitest";
import {
  addBatch,
  applyDefaults,
  askersWithAnswers,
  checkAnswers,
  describeCheck,
  isComplete,
  markDelivered,
  parseAskBody,
  parseAskReply,
  renderAnswers,
  renderAskReply,
  type AskReply,
} from "../src/ask-reply.js";

const ASK = `<ask>
  <question id="q1">
    <text>登入要用 session 還是 JWT？</text>
    <options><option>session</option><option>jwt</option></options>
    <suggested reason="既有程式已用 cookie">session</suggested>
  </question>
  <question id="q2"><text>要不要支援舊版 API？</text></question>
</ask>`;

function parsed() {
  const r = parseAskBody(ASK);
  if (!r.ok) throw new Error(r.error);
  return r.questions;
}
const fresh = (): AskReply => {
  const r = addBatch(undefined, "lead", 7, parsed());
  if (!r.ok) throw new Error(r.error);
  return r.reply;
};
const answer = (r: AskReply, id: string, value: string): AskReply => ({
  ...r,
  questions: r.questions.map((q) => (q.id === id ? { ...q, answer: { value, by: "user" as const } } : q)),
});

describe("parseAskBody", () => {
  it("reads questions, options and suggested values", () => {
    const qs = parsed();
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatchObject({ id: "q1", text: "登入要用 session 還是 JWT？", options: ["session", "jwt"], suggested: { value: "session", reason: "既有程式已用 cookie" } });
    expect(qs[1]).toMatchObject({ id: "q2", text: "要不要支援舊版 API？" });
    expect(qs[1]?.options).toBeUndefined();
  });

  it("tolerates prose around the block and unescapes entities", () => {
    const r = parseAskBody(`I need input.\n<ask><question id="a"><text>use a &lt; b &amp; c?</text></question></ask>\nThanks`);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.questions[0]?.text).toBe("use a < b & c?");
  });

  it.each([
    ["no <ask> block", "just words", /<ask>/],
    ["a question without id", `<ask><question><text>x</text></question></ask>`, /id/],
    ["a question without text", `<ask><question id="a"></question></ask>`, /text/],
    ["a duplicate id", `<ask><question id="a"><text>x</text></question><question id="a"><text>y</text></question></ask>`, /duplicate/i],
    ["zero questions", `<ask></ask>`, /at least one/i],
    ["a suggested value that is not an option", `<ask><question id="a"><text>x</text><options><option>p</option></options><suggested>z</suggested></question></ask>`, /suggested/],
  ])("rejects %s", (_name, body, why) => {
    const r = parseAskBody(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(why);
  });

  it("rejects more than 10 questions", () => {
    const many = Array.from({ length: 11 }, (_, i) => `<question id="q${i}"><text>t${i}</text></question>`).join("");
    const r = parseAskBody(`<ask>${many}</ask>`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/10/);
  });
});

describe("ask-reply file", () => {
  it("renders and parses back to the same thing", () => {
    const r = answer(fresh(), "q2", "不用");
    const back = parseAskReply(renderAskReply(r));
    expect(back).toEqual(r);
    expect(renderAskReply(r)).toContain(`<ask-reply status="pending" asked_by="lead" round="7">`);
  });

  it("escapes special characters in answers and reads a hand-edited file", () => {
    const text = renderAskReply(fresh()).replace(`<answer></answer>`, `<answer>a < b</answer>`);
    const back = parseAskReply(text);
    expect(back.questions[0]?.answer).toEqual({ value: "a < b", by: "user" });
    expect(renderAskReply(back)).toContain("a &lt; b");
  });

  it("throws a readable error for a file without the root tag", () => {
    expect(() => parseAskReply("nothing here")).toThrow(/ask-reply/);
  });
});

describe("addBatch", () => {
  it("keeps answered questions and appends the new batch", () => {
    const first = answer(fresh(), "q1", "jwt");
    const more = addBatch(first, "fe-member", 9, [{ id: "q3", text: "新問題" }]);
    expect(more.ok).toBe(true);
    if (!more.ok) return;
    expect(more.reply.round).toBe(9);
    expect(more.reply.askedBy).toBe("fe-member");
    expect(more.reply.status).toBe("pending");
    expect(more.reply.questions.map((q) => [q.id, q.asker])).toEqual([["q1", "lead"], ["q2", "lead"], ["q3", "fe-member"]]);
    expect(more.reply.questions[0]?.answer?.value).toBe("jwt");
  });

  it("is idempotent for the same id with the same text (a re-routed ask after a crash)", () => {
    const first = fresh();
    const again = addBatch(first, "lead", 7, parsed());
    expect(again).toEqual({ ok: true, reply: first });
  });

  it("rejects an id already used with different text", () => {
    const r = addBatch(fresh(), "lead", 8, [{ id: "q1", text: "something else" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/q1/);
  });
});

describe("checkAnswers", () => {
  it("lists unanswered questions", () => {
    const c = checkAnswers(fresh());
    expect(c.missing).toEqual(["q1", "q2"]);
    expect(isComplete(c)).toBe(false);
    expect(describeCheck(c).join("\n")).toMatch(/q1/);
  });

  it("accepts an option, an other: answer and any text for open questions", () => {
    let r = answer(fresh(), "q1", "other: oauth");
    r = answer(r, "q2", "不用");
    expect(isComplete(checkAnswers(r))).toBe(true);
    expect(isComplete(checkAnswers(answer(r, "q1", "jwt")))).toBe(true);
  });

  it("rejects an answer that is not one of the options", () => {
    const c = checkAnswers(answer(answer(fresh(), "q1", "cookie"), "q2", "x"));
    expect(c.invalid).toEqual([{ id: "q1", reason: expect.stringMatching(/session.*jwt.*other:/) }]);
  });

  it("treats a bare 'other:' as empty", () => {
    expect(checkAnswers(answer(fresh(), "q1", "other:")).invalid.map((i) => i.id)).toEqual(["q1"]);
  });

  it("ignores questions that were already delivered", () => {
    let r = answer(answer(fresh(), "q1", "jwt"), "q2", "x");
    r = markDelivered(r);
    const more = addBatch(r, "lead", 9, [{ id: "q3", text: "t" }]);
    if (!more.ok) throw new Error(more.error);
    expect(checkAnswers(more.reply).missing).toEqual(["q3"]);
  });
});

describe("applyDefaults", () => {
  it("fills unanswered questions that have a suggestion, marked by=default, and leaves the rest", () => {
    const r = applyDefaults(fresh());
    expect(r.questions[0]?.answer).toEqual({ value: "session", by: "default" });
    expect(r.questions[1]?.answer).toBeUndefined();
    expect(checkAnswers(r).missing).toEqual(["q2"]);
  });

  it("never overwrites an answer the user gave", () => {
    const r = applyDefaults(answer(fresh(), "q1", "jwt"));
    expect(r.questions[0]?.answer).toEqual({ value: "jwt", by: "user" });
  });
});

describe("answers for the asker", () => {
  it("renders an <answers> block only for that asker's undelivered questions", () => {
    let r = answer(answer(fresh(), "q1", "jwt"), "q2", "不用");
    const more = addBatch(r, "fe-member", 9, [{ id: "q3", text: "t3" }]);
    if (!more.ok) throw new Error(more.error);
    r = answer(more.reply, "q3", "yes");
    expect(askersWithAnswers(r).sort()).toEqual(["fe-member", "lead"]);
    const lead = renderAnswers(r, "lead");
    expect(lead).toContain(`<answers>`);
    expect(lead).toContain(`id="q1"`);
    expect(lead).toContain("jwt");
    expect(lead).not.toContain(`id="q3"`);
  });

  it("markDelivered flags every answered question and sets status answered", () => {
    const r = markDelivered(answer(answer(fresh(), "q1", "jwt"), "q2", "x"));
    expect(r.status).toBe("answered");
    expect(r.questions.every((q) => q.delivered)).toBe(true);
    expect(askersWithAnswers(r)).toEqual([]);
  });
});
