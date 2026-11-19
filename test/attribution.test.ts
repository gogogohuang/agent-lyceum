import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { latestReviews, trailers, withTrailers } from "../src/attribution.js";
import { ensureProjectDirs, routeOutboxes } from "../src/mailbox.js";
import { outboxDir } from "../src/policy.js";
import { makeEnv, REPLY_BODY, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("trailers", () => {
  it("names implementer, lead, reviewers (latest verdict each) and the run", () => {
    const t = trailers({
      implementers: [{ agent: "fe-member", model: "claude-sonnet-5-5" }],
      lead: { agent: "lead", model: "claude-opus-5-5" },
      reviews: [
        { reviewer: "qa", model: "gpt-6.1-sol", verdict: "changes_requested", subject: "r1", at: "a" },
        { reviewer: "qa", model: "gpt-6.1-sol", verdict: "pass", subject: "r2", at: "b" },
      ],
      runId: "run-1",
    });
    expect(t.split("\n")).toEqual([
      "Implemented-by: fe-member (claude-sonnet-5-5)",
      "Led-by: lead (claude-opus-5-5)",
      "Reviewed-by: qa (gpt-6.1-sol) [pass]",
      "Run: run-1",
      "Generated-by: agent-lyceum",
    ]);
  });

  it("writes no Reviewed-by when nobody reviewed, and cannot be forged with newlines", () => {
    const t = trailers({ implementers: [{ agent: "x\nReviewed-by: me", model: "m" }] });
    expect(t).not.toMatch(/^Reviewed-by/m);
    expect(t.split("\n")).toHaveLength(2);
    expect(latestReviews([])).toEqual([]);
  });

  it("joins subject, body and trailers with blank lines", () => {
    expect(withTrailers("s", "b", "T: 1")).toBe("s\n\nb\n\nT: 1");
    expect(withTrailers("s", "", "T: 1")).toBe("s\n\nT: 1");
  });
});

describe("verdict in a reply", () => {
  const send = (p: ReturnType<TestEnv["project"]>, fm: string) => write(path.join(outboxDir(p, "qa-member"), "v.md"), `---\n${fm}\n---\n\n${REPLY_BODY}\n`);

  it("is reported on the delivered mail", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    send(p, "to: lead\ntype: reply\nsubject: review\nverdict: pass");
    const r = routeOutboxes(p);
    expect(r.rejected).toEqual([]);
    expect(r.delivered[0]?.verdict).toBe("pass");
  });

  it("rejects an unknown verdict and one on a task", () => {
    env = makeEnv();
    const p = env.project();
    ensureProjectDirs(p);
    send(p, "to: lead\ntype: reply\nsubject: review\nverdict: great");
    expect(routeOutboxes(p).rejected[0]?.reason).toMatch(/verdict must be/);
    send(p, "to: lead\ntype: task\nsubject: review\nverdict: pass");
    expect(routeOutboxes(p).rejected[0]?.reason).toMatch(/only a `reply`/);
  });
});
