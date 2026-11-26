import { describe, expect, it } from "vitest";
import { formatElapsed, parseJobLog } from "../web/src/client/job-log";

const LIMIT = "You\u2019ve hit your usage limit.";

describe("parseJobLog", () => {
  it("splits rounds and lifts the ending, the branch, and the next step", () => {
    const text = [
      "Project agent-lyceum — repo /Users/u/repo",
      "Resuming run name (20261114T134909611Z-abc) (waiting) at round 9/45: task text",
      "[round 10/45] waking product-lead (codex/gpt-6.1-sol)",
      "  product-lead: 1 changed file(s) brought into the repo",
      "[round 11/45] waking product-lead (claude-code/claude-opus-5-5, tier 2) — retry 2",
      "[round 3] waking qa (claude)",
      "",
      "Run name (20261114T134909611Z-abc) ended: lead_failed, outcome: failed, after 12 round(s). Logs: /Users/u/log.jsonl",
      "Note: product-lead failed 3 time(s) in a row (quota), so the run stopped.",
      "To fix it:",
      "  1. Read why it failed: /Users/u/log.jsonl",
      "To go on:",
      "  agent-lyceum resume name -p agent-lyceum      (the same message is handled again)",
      "  Or give up on it: agent-lyceum clear name -p agent-lyceum",
      "",
      "The work is on branch agent-lyceum/2026/product-lead (1 file(s)); your working tree was not touched.",
      "Bring it in with: git merge agent-lyceum/2026/product-lead",
      "(or apply the patch: git apply /tmp/x.patch)",
    ].join("\n");
    const log = parseJobLog(text);
    expect(log.conclusions.map((c) => c.kind)).toEqual(["ended", "next", "branch"]);
    expect(log.conclusions[0]).toMatchObject({
      endReason: "lead_failed",
      outcome: "failed",
      rounds: "12",
      logs: "/Users/u/log.jsonl",
      note: "product-lead failed 3 time(s) in a row (quota), so the run stopped.",
    });
    expect(log.conclusions[1]).toMatchObject({
      lines: ["agent-lyceum resume name -p agent-lyceum      (the same message is handled again)", "Or give up on it: agent-lyceum clear name -p agent-lyceum"],
    });
    expect(log.conclusions[2]).toMatchObject({
      branch: "agent-lyceum/2026/product-lead",
      files: "1",
      bringIn: "git merge agent-lyceum/2026/product-lead",
      patch: "git apply /tmp/x.patch",
    });
    expect(log.blocks.map((b) => (b.kind === "round" ? `${b.n}/${b.max ?? ""} ${b.agent} ${b.model ? `${b.runtime}/${b.model}` : b.runtime}` : b.kind))).toEqual([
      "text",
      "10/45 product-lead codex/gpt-6.1-sol",
      "11/45 product-lead claude-code/claude-opus-5-5",
      "3/ qa claude",
    ]);
    expect(log.blocks[2]).toMatchObject({ tier: "2", retry: "2" });
    expect(JSON.stringify(log.blocks)).toContain("1 changed file(s)");
    expect(JSON.stringify(log.blocks)).toContain("Project agent-lyceum");
    expect(JSON.stringify(log.blocks)).toContain("To fix it:");
    expect(JSON.stringify(log.conclusions)).not.toContain("To fix it:");
  });

  it("merges tidy skips, even between tidied rows, and keeps archive and undo on the tidied row", () => {
    const text = [
      "tidying project memory of risk (1 file(s)) …",
      "  product-lead (project): skipped — no memory files: nothing to tidy",
      "  risk (project): tidied. Archive: /Users/u/archive/20261125T121854Z — undo with: agent-lyceum tidy --undo 20261125T121854Z -p p --agent risk",
      "  qa (project): skipped — busy",
      "  security (global): tidied. Archive: /g/.archive/20261125T121854Z, records: /r/.archive/20261125T121854Z, proposals: /p/.archive/20261125T121854Z — undo with: agent-lyceum tidy --undo 20261125T121854Z -p p --agent security --layer global",
      "promoted 2 decision(s) into the project records: a, b",
    ].join("\n");
    const log = parseJobLog(text);
    expect(log.blocks.map((b) => b.kind)).toEqual(["text", "skipped", "tidied", "tidied", "promoted"]);
    expect(log.blocks[1]).toMatchObject({
      count: 2,
      items: [
        { agent: "product-lead", layer: "project", reason: "no memory files: nothing to tidy" },
        { agent: "qa", layer: "project", reason: "busy" },
      ],
    });
    expect(log.blocks[2]).toMatchObject({
      agent: "risk",
      layer: "project",
      archive: "/Users/u/archive/20261125T121854Z",
      undo: "agent-lyceum tidy --undo 20261125T121854Z -p p --agent risk",
    });
    expect(log.blocks[3]).toMatchObject({
      agent: "security",
      layer: "global",
      archive: "/g/.archive/20261125T121854Z",
      records: "/r/.archive/20261125T121854Z",
      proposals: "/p/.archive/20261125T121854Z",
      undo: "agent-lyceum tidy --undo 20261125T121854Z -p p --agent security --layer global",
    });
    expect(log.blocks[4]).toMatchObject({ text: "promoted 2 decision(s) into the project records: a, b" });
    expect(JSON.stringify(log)).toContain("tidying project memory");
  });

  it("shows only the message of JSON errors and counts consecutive repeats", () => {
    const text = [
      `{"type":"error","message":${JSON.stringify(LIMIT)}}`,
      `{"type":"turn.failed","error":{"message":${JSON.stringify(LIMIT)}}}`,
      "  product-lead falling back to claude-code/claude-opus-5-5 (quota)",
      `{"type":"error","message":${JSON.stringify(LIMIT)}}`,
      '  product-lead failed: >["config"]>,"message":"need a config","exit_code":0}',
      '  product-lead failed: {"type":"turn.failed","error":{"message":"need a config"}}',
      '  product-lead failed: {"type":"error","message":"say \\"hi\\""}',
    ].join("\n");
    const log = parseJobLog(text);
    const errors = log.blocks.filter((b) => b.kind === "error");
    expect(errors.map((b) => (b.kind === "error" ? { message: b.message, count: b.count } : b))).toEqual([
      { message: LIMIT, count: 2 },
      { message: LIMIT, count: 1 },
      { message: "need a config", count: 2 },
      { message: 'say "hi"', count: 1 },
    ]);
    const first = errors[0];
    expect(first?.kind === "error" && first.raw.includes("turn.failed")).toBe(true);
    expect(JSON.stringify(log.blocks)).toContain("falling back");
  });

  it("does not merge the same error across a blank line", () => {
    const line = '{"type":"error","message":"x"}';
    const log = parseJobLog(`${line}\n\n${line}`);
    expect(log.blocks.filter((b) => b.kind === "error")).toHaveLength(2);
  });

  it("keeps a failed fragment that has no message, and other unrecognized lines", () => {
    const fragment = String.raw`  product-lead failed: >[\"config\"]>;\n","exit_code":0,"status":"completed"}}`;
    const other = '{"type":"item.completed","item":"ok"}';
    const withMessage = '{"type":"item.completed","message":"kept whole"}';
    const log = parseJobLog(`${fragment}\nhello\n${other}\n${withMessage}`);
    expect(log.blocks).toEqual([{ kind: "text", text: `${fragment}\nhello\n${other}\n${withMessage}` }]);
  });

  it("peels a partial first line only when the tail was truncated", () => {
    const cut = parseJobLog("this is cut off mid-li\n[round 1/3] waking qa (claude)\nkept\n", { truncated: true });
    expect(cut.truncated).toBe(true);
    expect(cut.partial).toBe("this is cut off mid-li");
    expect(cut.blocks[0]).toMatchObject({ kind: "round", n: "1", max: "3", agent: "qa", runtime: "claude" });
    expect(JSON.stringify(cut.blocks)).toContain("kept");
    expect(JSON.stringify(cut.blocks)).not.toContain("cut off");

    const aligned = parseJobLog("\n[round 1/1] waking qa (claude)", { truncated: true });
    expect(aligned.partial).toBeUndefined();
    expect(aligned.blocks[0]).toMatchObject({ kind: "round", agent: "qa" });

    const whole = parseJobLog("not a partial\nkept");
    expect(whole.truncated).toBe(false);
    expect(whole.partial).toBeUndefined();
    expect(JSON.stringify(whole.blocks)).toContain("not a partial");
  });

  it("returns an empty log for an empty string", () => {
    expect(parseJobLog("")).toEqual({ truncated: false, conclusions: [], blocks: [] });
    expect(parseJobLog("", { truncated: true })).toEqual({ truncated: true, conclusions: [], blocks: [] });
  });
});

describe("formatElapsed", () => {
  it("formats seconds, minutes and hours, and floors partial seconds", () => {
    expect(formatElapsed(0)).toBe("0 秒");
    expect(formatElapsed(1500)).toBe("1 秒");
    expect(formatElapsed(61_000)).toBe("1 分 1 秒");
    expect(formatElapsed(3_599_000)).toBe("59 分 59 秒");
    expect(formatElapsed(3_600_000)).toBe("1 小時 0 分");
    expect(formatElapsed(-5)).toBe("0 秒");
  });
});
