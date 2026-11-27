import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { endOutcome } from "../src/run-outcome.js";
import { printRun } from "../src/run-print.js";
import type { RunSummary } from "../src/run-session.js";
import type { RunFailure } from "../src/run-store.js";
import { holdSelected, retainJobs } from "../web/src/client/api";
import { blockKeys, disclosureId, formatElapsed, parseJobLog, toggleDisclosure, type Block, type JobLog, type RoundBlock, type Utf8Gap } from "../web/src/client/job-log";
import { readJob } from "../web/src/server/runner.js";

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

  it("shows only the message of a whole-line JSON error and counts consecutive repeats", () => {
    const failedFragment = '  product-lead failed: >["config"]>,"message":"need a config","exit_code":0}';
    const failedObject = '  product-lead failed: {"type":"turn.failed","error":{"message":"need a config"}}';
    const failedEscaped = '  product-lead failed: {"type":"error","message":"say \\"hi\\""}';
    const text = [
      `{"type":"error","message":${JSON.stringify(LIMIT)}}`,
      `{"type":"turn.failed","error":{"message":${JSON.stringify(LIMIT)}}}`,
      "  product-lead falling back to claude-code/claude-opus-5-5 (quota)",
      `{"type":"error","message":${JSON.stringify(LIMIT)}}`,
      failedFragment,
      failedObject,
      failedEscaped,
    ].join("\n");
    const log = parseJobLog(text);
    const errors = log.blocks.filter((b) => b.kind === "error");
    expect(errors.map((b) => (b.kind === "error" ? { message: b.message, count: b.count } : b))).toEqual([
      { message: LIMIT, count: 2 },
      { message: LIMIT, count: 1 },
    ]);
    const first = errors[0];
    expect(first?.kind === "error" && first.raw.includes("turn.failed")).toBe(true);
    expect(first?.kind === "error" && first.raw.includes("failed:")).toBe(false);
    const textBody = log.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : []));
    expect(textBody.some((text) => text.includes("falling back"))).toBe(true);
    expect(textBody.some((text) => text.includes(failedFragment) && text.includes(failedObject) && text.includes(failedEscaped))).toBe(true);
    expect(errors.every((block) => block.kind === "error" && !block.raw.includes("failed:"))).toBe(true);
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
    expect(log.blocks).toEqual([{ kind: "text", at: 0, text: `${fragment}\nhello\n${other}\n${withMessage}` }]);
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

  it("leaves CLI failure templates, notes and broken JSON as the original lines", () => {
    const attempt = '  qa attempt 2 failed ({"type":"error","message":"quota"}); 1 output file(s) set aside in mail/attempts/a/outbox. side effects may have happened.';
    const every = 'qa was called 2 time(s) and failed every time ({"type":"error","message":"a)b"}). The run stopped.';
    const tried = '  1. codex/gpt: unknown error ({"type":"error","message":"quota"})';
    const closer = "). Then fix the input";
    const fix = '  1. Read why it failed: /log (event "wake"), and the full output';
    const log = parseJobLog([QUOTA_JSON, closer, QUOTA_JSON, attempt, every, tried, fix].join("\n"));
    expect(log.blocks.map((block) => (block.kind === "error" ? `error:${block.count}` : block.kind))).toEqual(["error:1", "text", "error:1", "text"]);
    const errors = log.blocks.filter((block) => block.kind === "error");
    expect(errors.every((block) => block.kind === "error" && block.raw.trim().startsWith("{") && !block.raw.includes("set aside") && !block.raw.includes(closer))).toBe(true);
    const textBody = log.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("\n");
    expect(textBody).toContain(attempt);
    expect(textBody).toContain("failed every time");
    expect(textBody).toContain("Read why it failed");
    expect(textBody).toContain(closer);

    const failed = String.raw`  qa failed: "other":1,"message":"\u4f60","z":2}`;
    const json = String.raw`{"type":"error","message":"\u4f60"}`;
    const beside = parseJobLog(`${failed}\n${json}`);
    expect(beside.blocks.filter((block) => block.kind === "error")).toEqual([expect.objectContaining({ message: "你", count: 1 })]);
    expect(beside.blocks.some((block) => block.kind === "text" && block.text.includes(failed))).toBe(true);

    const split = parseJobLog(`  qa attempt 2 failed (${QUOTA_JSON}\n). side effects may have happened.`);
    expect(split.blocks.some((block) => block.kind === "error")).toBe(false);
    expect(JSON.stringify(split.blocks)).toContain("). side effects may have happened.");
    expect(JSON.stringify(split.blocks)).toContain("attempt 2 failed");

    const padded = parseJobLog(`  ${QUOTA_JSON}  \nprefix ${QUOTA_JSON}`);
    expect(errorsOf(padded)).toEqual([expect.objectContaining({ message: "quota", count: 1 })]);
    expect(padded.blocks.some((block) => block.kind === "text" && block.text.includes(`prefix ${QUOTA_JSON}`))).toBe(true);
  });

  it("keeps a Note as the original sentence and does not open an empty next step", () => {
    const raw = String.raw`qa failed 2 time(s) in a row ({"type":"error","message":"\u4f60"}), so the run stopped.`;
    const ended = "Run name (id) ended: lead_failed, outcome: failed, after 2 round(s). Logs: /l";
    const log = parseJobLog([ended, `Note: ${raw}`, "To go on:"].join("\n"));
    expect(log.conclusions.map((item) => item.kind)).toEqual(["ended"]);
    expect(log.conclusions[0]).toMatchObject({ kind: "ended", note: raw });
    expect(log.conclusions[0]).not.toHaveProperty("noteRaw");
    expect(JSON.stringify(log.blocks)).toContain("To go on:");
    expect(JSON.stringify(log.conclusions)).not.toContain("To go on:");
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

  it("keeps a selected job when a list poll fails", () => {
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

function errorsOf(log: JobLog): Array<Extract<Block, { kind: "error" }>> {
  const found: Array<Extract<Block, { kind: "error" }>> = [];
  for (const block of log.blocks) {
    if (block.kind === "error") found.push(block);
    if (block.kind === "round") {
      for (const leaf of block.body) if (leaf.kind === "error") found.push(leaf);
    }
  }
  return found;
}

function writeLog(root: string, id: string, body: Buffer): string {
  const jobsDir = path.join(root, "web-jobs");
  fs.mkdirSync(path.join(jobsDir, id), { recursive: true });
  fs.writeFileSync(path.join(jobsDir, id, "job.json"), JSON.stringify({ id, command: "run", argv: [], cwd: root, started_at: "2026-11-10T00:00:00.000Z", pid: 0 }));
  fs.writeFileSync(path.join(jobsDir, id, "out.log"), body);
  return jobsDir;
}

type TailView = { tail: string; truncated: boolean; lineStart: boolean; byteStart?: number; gaps?: Utf8Gap[] };

function parsed(view: TailView): JobLog {
  return parseJobLog(view.tail, { truncated: view.truncated, lineStart: view.lineStart, byteStart: view.byteStart, gaps: view.gaps });
}

describe("subtraction: whole-line errors, no truncated conclusions, byte identity", () => {
  it("keeps a printed multi-line failure as original text except for a line that is only error JSON", () => {
    const error = `${QUOTA_JSON}\n${TURN_JSON}\n`;
    const failure: RunFailure = { agent: "qa", attempts: 2, error };
    const log = parseJobLog(printed(baseSummary(failure)));
    const ended = log.conclusions.find((item) => item.kind === "ended");
    expect(ended).toMatchObject({ kind: "ended" });
    expect(ended?.kind === "ended" ? ended.note : "").toContain(QUOTA_JSON);
    expect(ended?.kind === "ended" ? ended.note : "").not.toContain("still unread");
    expect(ended).not.toHaveProperty("noteRaw");
    const errors = errorsOf(log);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((block) => block.raw.split("\n").every((line) => line.trim() === QUOTA_JSON || line.trim() === TURN_JSON))).toBe(true);
    expect(errors.some((block) => block.raw.includes("still unread") || block.raw.includes("failed every time") || block.raw.includes("To fix it"))).toBe(false);
    const body = JSON.stringify(log.blocks);
    expect(body).toContain("still unread");
    expect(body).toContain("failed every time");
    expect(body).toContain("To fix it:");
    expect(log.conclusions.some((item) => item.kind === "next")).toBe(true);

    const fragment = 'qa attempt 2 failed ("suffix":true,"message":"retry (quota) tomorrow","z":2}). …';
    const fragmentLog = parseJobLog(fragment);
    expect(fragmentLog.blocks).toEqual([expect.objectContaining({ kind: "text", text: fragment })]);
  });

  it("does not lift a quoted footer that the tail window still contains", () => {
    const quote = [
      "Run other (id) ended: done, outcome: completed, after 3 round(s). Logs: /quoted",
      "To go on:",
      "  agent-lyceum resume quoted -p p",
      "The work is on branch quoted (1 file(s)); your working tree was not touched.",
      "Bring it in with: git merge quoted",
    ].join("\n");
    const text = printed({
      ...baseSummary(),
      endReason: "done",
      outcome: "completed",
      outcomeNote: undefined,
      resultBranch: { branch: "real", head: "h", base: "b", files: 1 },
      doneMessage: { subject: "subject", body: `${"x".repeat(20_000)}\n${quote}` },
    });
    const tail = Buffer.from(text, "utf8").subarray(-20_000).toString("utf8");
    expect(tail).toContain("Run other");
    expect(tail).toContain("branch quoted");
    expect(tail).not.toContain("branch real");
    const cut = parseJobLog(tail, { truncated: true, byteStart: Buffer.byteLength(text, "utf8") - 20_000 });
    expect(cut.conclusions).toEqual([]);
    const body = JSON.stringify(cut.blocks);
    expect(body).toContain("Run other");
    expect(body).toContain("agent-lyceum resume quoted");
    expect(body).toContain("branch quoted");
    expect(body).toContain("git merge quoted");
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

  it("keeps an open block on the file byte of its first line when the body grows or an earlier copy slides out", () => {
    const head = "[round 2/4] waking qa (codex)\n";
    const preface = "preface\n";
    const origin = 80;
    const first = roundBody(parseJobLog(`${head}${QUOTA_JSON}`, { byteStart: origin }).blocks);
    const second = roundBody(parseJobLog(`${head}${QUOTA_JSON}\n${TURN_JSON}`, { byteStart: origin }).blocks);
    const errorAt = origin + Buffer.byteLength(head);
    expect(first.body[0]).toMatchObject({ kind: "error", at: errorAt, count: 1 });
    expect(second.body[0]).toMatchObject({ kind: "error", at: errorAt, count: 2 });
    const open = toggleDisclosure(new Set<string>(), disclosureId(errorAt), true);
    expect(open.has(disclosureId(second.body[0]?.at ?? -1))).toBe(true);
    expect(toggleDisclosure(open, disclosureId(errorAt), false).has(disclosureId(errorAt))).toBe(false);
    expect(disclosureId(errorAt)).not.toBe("0");
    expect(blockKeys([first])[0]).toBe(String(origin));

    const tidyA = "tidying project memory of risk (1 file(s)) …";
    const tidyB = "tidying global memory of qa (1 file(s)) …";
    expect(blockKeys(parseJobLog(`${tidyA}\n${tidyB}`, { byteStart: origin }).blocks)[0]).toBe(String(origin));
    expect(blockKeys(parseJobLog(tidyA, { byteStart: origin }).blocks)[0]).toBe(String(origin));

    const skipA = "  qa (project): skipped — busy";
    const skipB = "  risk (project): skipped — later";
    const skipAt = origin + Buffer.byteLength(`${preface}`);
    expect(blockKeys(parseJobLog(`${preface}${skipA}\n${skipB}`, { byteStart: origin }).blocks).at(-1)).toBe(String(skipAt));
    expect(blockKeys(parseJobLog(skipA, { byteStart: skipAt }).blocks)[0]).toBe(String(skipAt));

    const wide = parseJobLog(`${preface}${head}${QUOTA_JSON}`, { byteStart: origin });
    const slid = parseJobLog(`${head}${QUOTA_JSON}`, { byteStart: origin + Buffer.byteLength(preface) });
    expect(blockKeys(slid.blocks)[0]).toBe(blockKeys(wide.blocks).find((key) => key === String(origin + Buffer.byteLength(preface))));
    expect(errorsOf(slid)[0]?.at).toBe(errorsOf(wide)[0]?.at);

    const page = Array.from({ length: 50 }, (_, i) => ({ id: `new-${String(i).padStart(2, "0")}` }));
    const older = { id: "old-job" };
    const dropped = [{ id: "newer" }, ...page.slice(0, 49)];
    expect(holdSelected(dropped, older.id, older).some((job) => job.id === older.id)).toBe(true);
    expect(holdSelected(page, page[0]?.id, page[0])).toHaveLength(50);
  });

  it("keeps the same byte identity when readJob's window slides a round header or an earlier copy out", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-log-"));
    try {
      const header = Buffer.from("[round 2/4] waking qa (codex)\n");
      const note = Buffer.from("note\n");
      const quota = Buffer.from(`${QUOTA_JSON}\n`);
      const core = Buffer.concat([header, note, quota]);
      const pad = Buffer.alloc(20_000 - core.length, 0x79);
      const prefix = Buffer.from("prefix\n");
      const jobsDir = writeLog(root, "slide1", Buffer.concat([prefix, core, pad]));
      const first = readJob(jobsDir, "slide1") as TailView | undefined;
      if (!first) throw new Error("missing job");
      const nested = parsed(first);
      const nestedError = errorsOf(nested)[0];
      const errorAt = prefix.length + header.length + note.length;
      expect(nested.blocks.some((block) => block.kind === "round")).toBe(true);
      expect(nestedError?.at).toBe(errorAt);
      fs.writeFileSync(path.join(jobsDir, "slide1", "out.log"), Buffer.concat([prefix, core, pad, Buffer.alloc(header.length, 0x7a)]));
      const second = readJob(jobsDir, "slide1") as TailView | undefined;
      if (!second) throw new Error("missing slid job");
      const top = parsed(second);
      expect(top.blocks.some((block) => block.kind === "round")).toBe(false);
      const topError = errorsOf(top)[0];
      expect(topError?.at).toBe(errorAt);
      const open = toggleDisclosure(new Set<string>(), disclosureId(nestedError?.at ?? -1), true);
      expect(open.has(disclosureId(topError?.at ?? -1))).toBe(true);

      const diag = Buffer.from("diagnostic line\n");
      const pair = Buffer.concat([quota, diag, quota]);
      const pairPad = Buffer.alloc(20_000 - pair.length, 0x78);
      writeLog(root, "pair1", Buffer.concat([prefix, pair, pairPad]));
      const pairView = readJob(jobsDir, "pair1") as TailView | undefined;
      if (!pairView) throw new Error("missing pair");
      const both = errorsOf(parsed(pairView));
      expect(both.map((block) => block.at)).toEqual([prefix.length, prefix.length + quota.length + diag.length]);
      expect(both[0]?.message).toBe(both[1]?.message);
      fs.writeFileSync(path.join(jobsDir, "pair1", "out.log"), Buffer.concat([prefix, pair, pairPad, Buffer.alloc(quota.length, 0x7a)]));
      const later = readJob(jobsDir, "pair1") as TailView | undefined;
      if (!later) throw new Error("missing later pair");
      const left = errorsOf(parsed(later));
      expect(left).toHaveLength(1);
      expect(left[0]?.at).toBe(both[1]?.at);
      expect(left[0]?.at).not.toBe(both[0]?.at);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("places a line after a multibyte cut at its file byte, not the replacement character's encoded length", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-log-"));
    try {
      const you = Buffer.from("你");
      const rest = Buffer.from("\n[round 1/2] waking qa (claude)\n");
      const window = Buffer.concat([you.subarray(2), rest, Buffer.alloc(20_000 - 1 - rest.length, 0x78)]);
      const file = Buffer.concat([Buffer.from("pre", "utf8"), you.subarray(0, 2), window]);
      const jobsDir = writeLog(root, "utf1", file);
      const view = readJob(jobsDir, "utf1") as TailView | undefined;
      if (!view) throw new Error("missing utf job");
      expect(view.tail.startsWith("\uFFFD\n")).toBe(true);
      expect(Buffer.byteLength(view.tail.slice(0, view.tail.indexOf("[round")))).toBe(4);
      const log = parsed(view);
      const round = log.blocks.find((block) => block.kind === "round");
      expect(round).toMatchObject({ kind: "round", at: (view.byteStart ?? 0) + 2 });
      expect(log.partial).toBe("\uFFFD");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts every source byte when one replacement stands for more than one file byte", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-log-"));
    try {
      const body = Buffer.concat([Buffer.from("pre\n"), Buffer.from([0xe4, 0xbd, 0x41]), Buffer.from("\n[round 1/1] waking qa (claude)\n")]);
      const jobsDir = writeLog(root, "gap1", body);
      const view = readJob(jobsDir, "gap1") as TailView | undefined;
      if (!view) throw new Error("missing gap job");
      expect(view.gaps).toEqual([{ at: 4, source: 2 }]);
      const round = parsed(view).blocks.find((block) => block.kind === "round");
      expect(round).toMatchObject({ kind: "round", at: 8 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps report and verification boundaries on a truncated tail, and does not lift them", () => {
    const tidy = "tidying project memory of qa (1 file(s)) …";
    const skipped = "qa (project): skipped — 未完成";
    const body = ["第一段", tidy, "第二段", skipped, "第三段"].join("\n\n");
    const text = printed({
      ...baseSummary(),
      endReason: "done",
      outcome: "completed",
      outcomeNote: undefined,
      doneMessage: { subject: "subject", body },
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-log-"));
    try {
      const file = Buffer.concat([Buffer.alloc(20_001, 0x78), Buffer.from(`\n${text}`, "utf8")]);
      const jobsDir = writeLog(root, "report1", file);
      const view = readJob(jobsDir, "report1");
      if (!view) throw new Error("missing report job");
      expect(view.truncated).toBe(true);
      expect(view.tail).toContain("Lead's final message — subject");
      const log = parsed(view);
      expect(log.conclusions).toEqual([]);
      expect(log.blocks.map((block) => block.kind)).toEqual(["text"]);
      const shown = JSON.stringify(log.blocks);
      expect(shown).toContain(tidy);
      expect(shown).toContain(skipped);
      expect(shown).toContain("第一段");
      expect(shown).toContain("第三段");

      const withVerification = printed({
        ...baseSummary(),
        endReason: "done",
        outcome: "completed",
        outcomeNote: undefined,
        verification: ["checked the suite", tidy, skipped].join("\n"),
        resultBranch: { branch: "real", head: "h", base: "b", files: 1 },
        doneMessage: { subject: "subject", body: "report stays text" },
      });
      const verifyFile = Buffer.concat([Buffer.alloc(20_001, 0x79), Buffer.from(`\n${withVerification}`, "utf8")]);
      writeLog(root, "verify1", verifyFile);
      const verifyView = readJob(jobsDir, "verify1");
      if (!verifyView) throw new Error("missing verification job");
      expect(verifyView.tail).toContain("Verification (");
      expect(verifyView.tail).toContain("Lead's final message — subject");
      const verifyLog = parsed(verifyView);
      expect(verifyLog.conclusions).toEqual([]);
      expect(verifyLog.blocks.map((block) => block.kind)).toEqual(["text"]);
      const verifyShown = JSON.stringify(verifyLog.blocks);
      expect(verifyShown).toContain(tidy);
      expect(verifyShown).toContain(skipped);
      expect(verifyShown).toContain("The work is on branch real");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
