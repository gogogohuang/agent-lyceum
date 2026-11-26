import { describe, expect, it } from "vitest";
import { endOutcome } from "../src/run-outcome.js";
import { printRun } from "../src/run-print.js";
import type { RunSummary } from "../src/run-session.js";
import type { RunFailure } from "../src/run-store.js";
import { holdSelected, retainJobs } from "../web/src/client/api";
import { blockKeys, formatElapsed, leafKeys, parseJobLog, type Block, type RoundBlock } from "../web/src/client/job-log";

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
    expect(log.blocks.map((b) => b.kind)).toEqual(["tidying", "skipped", "tidied", "tidied", "promoted"]);
    expect(log.blocks[0]).toMatchObject({ kind: "tidying", lines: ["tidying project memory of risk (1 file(s)) …"] });
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

  it("extracts messages from the CLI failure templates and keeps the surrounding text on the raw span", () => {
    const attempt = '  qa attempt 2 failed ({"type":"error","message":"quota"}). side effects may have happened.';
    const every = 'qa was called 2 time(s) and failed every time ({"type":"error","message":"a)b"}). The run stopped.';
    const tried = '  1. codex/gpt: unknown error ({"type":"error","message":"quota"})';
    const fix = '  1. Read why it failed: /log (event "wake"), and the full output';
    const log = parseJobLog([attempt, every, tried, fix].join("\n"));
    const errors = log.blocks.filter((b) => b.kind === "error");
    expect(errors.map((b) => (b.kind === "error" ? { message: b.message, count: b.count } : b))).toEqual([
      { message: "quota", count: 1 },
      { message: "a)b", count: 1 },
      { message: "quota", count: 1 },
    ]);
    expect(errors[0]).toMatchObject({ kind: "error", raw: attempt });
    expect(JSON.stringify(log.blocks)).toContain("Read why it failed");
    expect(log.blocks.some((b) => b.kind === "text" && b.text.includes("side effects"))).toBe(false);
  });

  it("decodes JSON string escapes so a failed: fragment and a JSON line count as one message", () => {
    const failed = String.raw`  qa failed: "other":1,"message":"\u4f60","z":2}`;
    const json = String.raw`{"type":"error","message":"\u4f60"}`;
    const log = parseJobLog(`${failed}\n${json}`);
    expect(log.blocks.filter((b) => b.kind === "error")).toEqual([expect.objectContaining({ message: "你", count: 2 })]);
  });

  it("folds a template closer that follows a JSON error line into that error's raw text", () => {
    const log = parseJobLog('{"type":"error","message":"quota"}\n). side effects may have happened.');
    const errors = log.blocks.filter((b) => b.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "error", message: "quota" });
    expect(errors[0]?.kind === "error" && errors[0].raw.includes("). side effects")).toBe(true);
    expect(log.blocks.some((b) => b.kind === "text")).toBe(false);

    const split = parseJobLog('  qa attempt 2 failed ({"type":"error","message":"quota"}\n). side effects may have happened.');
    const splitError = split.blocks.find((b) => b.kind === "error");
    expect(splitError).toMatchObject({ kind: "error", message: "quota" });
    expect(splitError?.kind === "error" && splitError.raw.includes("). side effects")).toBe(true);
    expect(split.blocks.some((b) => b.kind === "text")).toBe(false);
  });

  it("shows the decoded message of a Note error and keeps the original note", () => {
    const raw = String.raw`qa failed 2 time(s) in a row ({"type":"error","message":"\u4f60"}), so the run stopped.`;
    const log = parseJobLog(["Run name (id) ended: lead_failed, outcome: failed, after 2 round(s). Logs: /l", `Note: ${raw}`].join("\n"));
    expect(log.conclusions[0]).toMatchObject({
      kind: "ended",
      note: "qa failed 2 time(s) in a row (你), so the run stopped.",
      noteRaw: raw,
    });
  });

  it("reads tier names and does not leave them on the model", () => {
    const log = parseJobLog("[round 4/9] waking qa (codex/gpt-6, tier low) — retry 1\n[round 5/9] waking qa (claude-code/claude-opus-5-5, tier high)\n[round 6] waking qa (claude, tier mid)");
    expect(log.blocks[0]).toMatchObject({ kind: "round", runtime: "codex", model: "gpt-6", tier: "low", retry: "1" });
    expect(log.blocks[1]).toMatchObject({ kind: "round", runtime: "claude-code", model: "claude-opus-5-5", tier: "high" });
    expect(log.blocks[2]).toMatchObject({ kind: "round", runtime: "claude", tier: "mid" });
    expect(log.blocks[2]).not.toHaveProperty("model");
  });

  it("collapses tidying headers into one block and keeps every line", () => {
    const first = "tidying project memory of risk (1 file(s)) …";
    const second = "tidying global memory of qa (2 file(s), 3 project record file(s), 1 proposal file(s)) …";
    const log = parseJobLog(`${first}\n  risk (project): skipped — busy\n${second}`);
    expect(log.blocks[0]).toMatchObject({ kind: "tidying", lines: [first, second] });
    expect(log.blocks.filter((b) => b.kind === "tidying")).toHaveLength(1);
    expect(log.blocks.some((b) => b.kind === "text" && b.text.includes("tidying"))).toBe(false);
    expect(log.blocks.some((b) => b.kind === "skipped")).toBe(true);
  });

  it("leaves quotes inside the lead report in the body, and ignores a branch line without its bring-in line", () => {
    const text = [
      "Run name (id) ended: done, outcome: completed, after 1 round(s). Logs: /l",
      "The work is on branch real (1 file(s)); your working tree was not touched.",
      "Bring it in with: git merge real",
      "Lead's final message — subject",
      "To go on:",
      "  arbitrary text",
      "The work is on branch demo (2 file(s)); your working tree was not touched.",
      "The work is on branch quoted (3 file(s)); your working tree was not touched.",
      "Bring it in with: git merge quoted",
    ].join("\n");
    const log = parseJobLog(text);
    expect(log.conclusions.map((c) => c.kind)).toEqual(["ended", "branch"]);
    expect(log.conclusions[1]).toMatchObject({ branch: "real", bringIn: "git merge real" });
    const body = JSON.stringify(log.blocks);
    expect(body).toContain("arbitrary text");
    expect(body).toContain("branch demo");
    expect(body).toContain("branch quoted");
    expect(JSON.stringify(log.conclusions)).not.toContain("arbitrary text");
    expect(JSON.stringify(log.conclusions)).not.toContain("demo");

    const lone = parseJobLog("The work is on branch demo (2 file(s)); your working tree was not touched.\nstill here");
    expect(lone.conclusions).toEqual([]);
    expect(JSON.stringify(lone.blocks)).toContain("still here");
  });

  it("does not merge the same error across a lifted ending line", () => {
    const line = '{"type":"error","message":"x"}';
    const ended = "Run name (id) ended: lead_failed, outcome: failed, after 1 round(s). Logs: /l";
    const log = parseJobLog(`${line}\n${ended}\n${line}`);
    expect(log.blocks.filter((b) => b.kind === "error")).toHaveLength(2);
  });

  it("keeps a full first line when the tail was cut just after a newline", () => {
    const head = "[round 2/4] waking qa (codex)\ndiagnostic\n";
    const aligned = parseJobLog(`before\n${head}`, { truncated: true, lineStart: true });
    expect(aligned.partial).toBeUndefined();
    expect(aligned.blocks[0]).toMatchObject({ kind: "text", text: "before" });
    expect(aligned.blocks[1]).toMatchObject({ kind: "round", n: "2", agent: "qa", runtime: "codex" });
    expect(JSON.stringify(aligned.blocks)).toContain("diagnostic");

    const slid = parseJobLog(`e\n${head}`, { truncated: true });
    expect(slid.partial).toBe("e");
    expect(slid.blocks[0]).toMatchObject({ kind: "round", n: "2", agent: "qa" });

    const torn = parseJobLog("\uFFFD\n[round 1/2] waking qa (claude)\nkept", { truncated: true });
    expect(torn.partial).toBe("\uFFFD");
    expect(torn.blocks[0]).toMatchObject({ kind: "round", agent: "qa" });
    expect(JSON.stringify(torn.blocks)).toContain("kept");
  });

  it("keeps the open round and its error when the tail slides and a list poll fails", () => {
    const head = '[round 2/4] waking qa (codex)\nhello\n  qa failed: {"type":"error","message":"quota"}\n';
    const wide = parseJobLog(`before\n${head}`, { truncated: true, lineStart: true });
    const slid = parseJobLog(`e\n${head}`, { truncated: true });
    const wideKey = blockKeys(wide.blocks).find((key) => key.startsWith("round-2-qa"));
    const slidKey = blockKeys(slid.blocks).find((key) => key.startsWith("round-2-qa"));
    expect(slidKey).toBe(wideKey);
    const added = parseJobLog(`[round 2/4] waking qa (codex)\nnote\n${head.slice(head.indexOf("\n") + 1)}`);
    const baseRound = wide.blocks.find((block) => block.kind === "round");
    const addedRound = added.blocks.find((block) => block.kind === "round");
    const baseLeaves = baseRound?.kind === "round" ? leafKeys(baseRound.body) : [];
    const addedLeaves = addedRound?.kind === "round" ? leafKeys(addedRound.body) : [];
    expect(addedLeaves.filter((key) => key.startsWith("e-"))).toEqual(baseLeaves.filter((key) => key.startsWith("e-")));
    const jobs = [{ id: "job-1" }];
    const kept = [jobs, null, jobs].reduce<(typeof jobs) | undefined>((prev, next) => retainJobs(prev, next), undefined);
    expect(kept?.some((job) => job.id === "job-1")).toBe(true);
  });
});

const QUOTA_JSON = '{"type":"error","message":"quota"}';
const TURN_JSON = '{"type":"turn.failed","error":{"message":"quota"}}';

function printed(summary: RunSummary): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (line?: unknown) => {
    lines.push(String(line ?? ""));
  };
  try {
    printRun(summary, summary.runDir);
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

function baseSummary(failure?: RunFailure): RunSummary {
  const outcome = endOutcome("agent_failed", undefined, failure);
  return {
    runId: "id",
    name: "name",
    runDir: "/tmp/run",
    rounds: 2,
    endReason: "agent_failed",
    outcome: outcome.outcome,
    outcomeNote: outcome.note,
    project: "p",
    ...(failure ? { failure } : {}),
  };
}

function roundBody(blocks: Block[]): RoundBlock {
  const found = blocks.find((block) => block.kind === "round");
  if (found?.kind !== "round") throw new Error("missing round");
  return found;
}

describe("review: incomplete CLI spans, scoped conclusions, stable disclosure", () => {
  it("decodes a complete multi-line failure template and a mid-JSON fragment, and keeps the note's sentence", () => {
    const error = `${QUOTA_JSON}\n${TURN_JSON}\n`;
    const failure: RunFailure = { agent: "qa", attempts: 2, error };
    const log = parseJobLog(printed(baseSummary(failure)));
    const ended = log.conclusions.find((item) => item.kind === "ended");
    expect(ended).toMatchObject({
      kind: "ended",
      note: expect.stringContaining("quota"),
    });
    expect(ended?.kind === "ended" ? ended.note : "").not.toContain('{"type"');
    expect(ended?.kind === "ended" ? ended.note : "").toContain("still unread");
    expect(ended?.kind === "ended" ? ended.noteRaw : "").toContain(QUOTA_JSON);
    expect(ended?.kind === "ended" ? ended.noteRaw : "").toContain("still unread");
    const errors = log.blocks.filter((block) => block.kind === "error");
    expect(errors).toEqual([expect.objectContaining({ kind: "error", message: "quota", count: 1 })]);
    expect(errors[0]?.kind === "error" && errors[0].raw.includes("failed every time") && errors[0].raw.includes("turn.failed")).toBe(true);
    expect(errors[0]?.kind === "error" && errors[0].raw.includes("To fix it")).toBe(false);
    expect(JSON.stringify(log.blocks)).toContain("To fix it:");
    expect(log.conclusions.some((item) => item.kind === "next")).toBe(true);
    expect(errors.some((block) => block.kind === "error" && block.raw.includes("still unread") && !block.raw.includes("failed every time"))).toBe(false);

    const fragment = 'qa attempt 2 failed ("suffix":true,"message":"retry (quota) tomorrow","z":2}). …';
    const fragmentLog = parseJobLog(fragment);
    expect(fragmentLog.blocks).toEqual([{ kind: "error", message: "retry (quota) tomorrow", count: 1, raw: fragment }]);
  });

  it("does not fold diagnostic text that merely starts with a closing paren into an error, or merge across it", () => {
    const diag = ") expected closing paren; fix the input";
    const log = parseJobLog([QUOTA_JSON, diag, QUOTA_JSON].join("\n"));
    expect(log.blocks.map((block) => (block.kind === "error" ? `error:${block.count}` : block.kind))).toEqual(["error:1", "text", "error:1"]);
    expect(log.blocks[1]).toMatchObject({ kind: "text", text: diag });
  });

  it("lifts only the official branch when verification quotes a next step and a branch", () => {
    const verification = ["", "To go on:", "  sample text", "The work is on branch quoted (1 file(s)); your working tree was not touched.", "Bring it in with: git merge quoted"].join("\n");
    const text = printed({
      ...baseSummary(),
      endReason: "done",
      outcome: "completed",
      outcomeNote: undefined,
      verification,
      resultBranch: { branch: "real", head: "h", base: "b", files: 1 },
    });
    const log = parseJobLog(text);
    expect(log.conclusions.map((item) => (item.kind === "branch" ? `branch(${item.branch})` : item.kind))).toEqual(["ended", "branch(real)"]);
    expect(JSON.stringify(log.blocks)).toContain("sample text");
    expect(JSON.stringify(log.blocks)).toContain("branch quoted");
  });

  it("leaves a cut-off report's quoted branch and next step in place, and does not parse round or tidy quotes in the report", () => {
    const quote = ["To go on:", "  sample text", "The work is on branch quoted (2 file(s)); your working tree was not touched.", "Bring it in with: git merge quoted"].join("\n");
    const text = printed({
      ...baseSummary(),
      endReason: "done",
      outcome: "completed",
      outcomeNote: undefined,
      doneMessage: { subject: "subject", body: `${"x".repeat(20_000)}\n${quote}` },
    });
    const tail = text.slice(-20_000);
    expect(tail).not.toContain("Lead's final message");
    const cut = parseJobLog(tail, { truncated: true });
    expect(cut.conclusions).toEqual([]);
    expect(JSON.stringify(cut.blocks)).toContain("sample text");
    expect(JSON.stringify(cut.blocks)).toContain("branch quoted");

    const quoted = printed({
      ...baseSummary(),
      endReason: "done",
      outcome: "completed",
      outcomeNote: undefined,
      resultBranch: { branch: "real", head: "h", base: "b", files: 1 },
      doneMessage: {
        subject: "subject",
        body: ["[round 9/9] waking qa (claude)", "tidying project memory of qa (1 file(s)) …", "To go on:", "  quoted step"].join("\n"),
      },
    });
    const report = parseJobLog(quoted);
    expect(report.blocks.some((block) => block.kind === "round" || block.kind === "tidying")).toBe(false);
    expect(JSON.stringify(report.blocks)).toContain("[round 9/9]");
    expect(JSON.stringify(report.blocks)).toContain("tidying project memory of qa");
    expect(JSON.stringify(report.blocks)).toContain("quoted step");
    expect(report.conclusions.map((item) => (item.kind === "branch" ? item.branch : item.kind))).toEqual(["ended", "real"]);
  });

  it("keeps an already-open block's identity as the same error, tidy rows and skipped rows are appended", () => {
    const head = "[round 2/4] waking qa (codex)";
    const first = roundBody(parseJobLog(`${head}\n${QUOTA_JSON}`).blocks);
    const second = roundBody(parseJobLog(`${head}\n${QUOTA_JSON}\n${TURN_JSON}`).blocks);
    const open = new Set(leafKeys(first.body));
    const grown = leafKeys(second.body);
    expect(grown[0]).toBe(open.values().next().value);
    expect(open.has(grown[0] ?? "")).toBe(true);
    // A leaf index stays "0" when that leaf grows, so equality alone would not go red.
    expect(grown[0]).not.toMatch(/^\d+$/);

    const tidyA = "tidying project memory of risk (1 file(s)) …";
    const tidyB = "tidying global memory of qa (1 file(s)) …";
    expect(blockKeys(parseJobLog(`${tidyA}\n${tidyB}`).blocks)[0]).toBe(blockKeys(parseJobLog(tidyA).blocks)[0]);
    expect(blockKeys(parseJobLog(tidyA).blocks)[0]).not.toMatch(/^\d+$/);

    const skipA = "  qa (project): skipped — busy";
    const skipB = "  risk (project): skipped — later";
    expect(blockKeys(parseJobLog(`${skipA}\n${skipB}`).blocks)[0]).toBe(blockKeys(parseJobLog(skipA).blocks)[0]);

    const preface = parseJobLog(`preface\n${head}\n${QUOTA_JSON}`);
    const slid = parseJobLog(`${head}\n${QUOTA_JSON}`);
    const prefaceKey = blockKeys(preface.blocks).find((key) => key.startsWith("round-"));
    const slidKey = blockKeys(slid.blocks).find((key) => key.startsWith("round-"));
    expect(slidKey).toBe(prefaceKey);
    expect(prefaceKey).not.toBe("1");
    expect(slidKey).not.toBe("0");

    const page = Array.from({ length: 50 }, (_, i) => ({ id: `new-${String(i).padStart(2, "0")}` }));
    const older = { id: "old-job" };
    const dropped = [{ id: "newer" }, ...page.slice(0, 49)];
    expect(holdSelected(dropped, older.id, older).some((job) => job.id === older.id)).toBe(true);
    expect(holdSelected(page, page[0]?.id, page[0])).toHaveLength(50);
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
