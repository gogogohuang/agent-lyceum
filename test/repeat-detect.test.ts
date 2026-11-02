import { describe, expect, it } from "vitest";
import { compareWithLastRejection, failureFingerprint, FINGERPRINT_LINES, normalizeOutput, repeatAction, repeatStopNote, stoppedInSegment, withRepeatLabel, type PathRule, type RepeatComparison } from "../src/repeat-detect.js";
import type { VerifyRecord } from "../src/run-store.js";

const N = (t: string, p: PathRule[] = []) => normalizeOutput(t, p);

describe("normalizeOutput: what is replaced (spec 28.4 table)", () => {
  it.each([
    ["\x1b[31mFAIL\x1b[0m  test/a.test.ts > parses", "FAIL  test/a.test.ts > parses"],
    ["\x1b]8;;https://x.test\x07link\x1b]8;;\x07 ok", "link ok"],
    [" Duration  3.21s (transform 100ms, setup 0ms, tests 2.9s)", " Duration  <duration> (transform <duration>, setup <duration>, tests <duration>)"],
    ["   Start at  12:00:01", "   Start at  <time>"],
    ["2026-11-01T15:18:23.051Z ERROR boom", "<time> ERROR boom"],
    ["2026-11-01 15:18:23,051 ERROR boom", "<time> ERROR boom"],
    ["finished in 1m 3.2s", "finished in <duration>"],
    ["finished in 2m30s", "finished in <duration>"],
    ["Checked 1 file in 3ms. No fixes applied.", "Checked 1 file in <duration>. No fixes applied."],
    ["Checked 1 file in 9ms. No fixes applied.", "Checked 1 file in <duration>. No fixes applied."],
    ["at parse (/tmp/vitest-abc123/foo.ts:12:3)", "at parse (<tmp>:12:3)"],
    ["cannot open /var/folders/ab/cd12/T/x-1/y.txt: ENOENT", "cannot open <tmp>: ENOENT"],
    ["progress 10%\rprogress 100%\rdone\r\n", "done"],
  ])("%j", (input, out) => {
    expect(N(input)).toBe(out);
  });
});

describe("normalizeOutput: what must stay (spec 28.4 table)", () => {
  it.each([
    "AssertionError: expected 500 to equal 200",
    "Tests  1 failed | 11 passed (12)",
    "at parse (src/tmp/foo.ts:12:3)",
    "date only 2026-11-01 stays",
    "expected 5 s to be 3 s",
    "retry-3s stays and a/5s stays",
    "see v1.2.3s and sha 12s3",
    "wrote 3s.log and 5ms.json",
    "ratio 3:45 stays; port :8080; line 10:30 stays",
  ])("%j", (input) => {
    expect(N(input)).toBe(input);
  });
});

describe("normalizeOutput: lines and paths", () => {
  it("CRLF, trailing \\r and trailing blank lines", () => {
    expect(N("a\r\nb\r\n\r\n\n")).toBe("a\nb");
    expect(N("a\r\nb\r")).toBe("a\nb");
  });
  it("empty output and only blank lines are the empty string", () => {
    expect(N("")).toBe("");
    expect(N("\n\n \n")).toBe("");
  });
  it("only the last 100 lines count, and a longer head does not move them", () => {
    const tail = Array.from({ length: FINGERPRINT_LINES }, (_, i) => `line ${i}`).join("\n");
    expect(N(`extra\nmore\n${tail}\n`)).toBe(tail);
    expect(N(`${"x".repeat(5000)}\n${"y".repeat(9000)}\n${tail}\n`)).toBe(N(`z\n${tail}\n`));
  });
  it("this run's paths are replaced, but not a longer name that begins with them", () => {
    const rules: PathRule[] = [["/w/x", "<cwd>"], ["/w/x/run", "<run-dir>"]];
    expect(N("in /w/x and /w/x/run/a.log", rules)).toBe("in <cwd> and <run-dir>/a.log");
    expect(N("/w/x2 /w/x.bak /w/x-y /w/x_z", rules)).toBe("/w/x2 /w/x.bak /w/x-y /w/x_z");
    expect(N("(/w/x)", rules)).toBe("(<cwd>)");
  });
  it("a custom TMPDIR below /tmp is eaten whole after the rule maps it to /tmp", () => {
    expect(N("open /tmp/custom-abc/sub/f.txt: no", [["/tmp/custom-abc", "/tmp"]])).toBe("open <tmp>: no");
  });
});

describe("normalizeOutput: cost on adversarial 256 KiB input", () => {
  const cases: [string, string][] = [
    ["digits", "1".repeat(256 * 1024)],
    ["digits and spaces", "12 ".repeat(85_000)],
    ["tmp", "/tmp/".repeat(52_000)],
    ["minutes", "1m ".repeat(85_000)],
    ["hours and minutes", "1h 1m ".repeat(43_000)],
    ["escape starts", "\x1b[".repeat(128 * 1024)],
    ["carriage returns", "a\r".repeat(128 * 1024)],
    ["clock colons", "1:".repeat(128 * 1024)],
    ["dates", "2026-11-01T".repeat(23_000)],
  ];
  it.each(cases)("%s", (_n, text) => {
    const t0 = Date.now();
    N(text, [["/a/b", "<cwd>"]]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("failureFingerprint", () => {
  const c = { name: "test", exit: 1, timed_out: false } as const;
  const fp = (x: Partial<{ name: string; exit: number | null; timed_out: boolean; error: string }>, tail = "out") => failureFingerprint({ ...c, ...x }, tail, []);
  it("is 16 hex characters and stable", () => {
    expect(fp({})).toMatch(/^[0-9a-f]{16}$/);
    expect(fp({})).toBe(fp({}));
  });
  it("differs by name, exit and assertion text", () => {
    expect(fp({ name: "lint" })).not.toBe(fp({}));
    expect(fp({ exit: 2 })).not.toBe(fp({}));
    expect(fp({}, "expected 1 to be 2")).not.toBe(fp({}, "expected 1 to be 3"));
  });
  it("is the same when only the time differs", () => {
    expect(fp({}, "ran at 10:00:01\nfail")).toBe(fp({}, "ran at 11:59:59\nfail"));
    expect(fp({}, "took 1.2s\nfail")).toBe(fp({}, "took 9.9s\nfail"));
  });
  it("a timeout does not depend on the exit code", () => {
    expect(fp({ timed_out: true, exit: null })).toBe(fp({ timed_out: true, exit: 143 }));
    expect(fp({ timed_out: true, exit: null })).not.toBe(fp({ exit: null }));
  });
  it("a signal differs from an exit code", () => {
    expect(fp({ exit: null })).not.toBe(fp({ exit: 1 }));
  });
  it("an error text is normalised: the working directory in it does not matter", () => {
    const at = (cwd: string) => failureFingerprint({ ...c, exit: null, error: `spawn sh ENOENT (sh or the working directory ${cwd} not found)` }, "", [[cwd, "<cwd>"]]);
    expect(at("/a/one")).toBe(at("/a/one"));
    expect(failureFingerprint({ ...c, exit: null, error: "x /a/one y" }, "", [["/a/one", "<cwd>"]])).toBe(failureFingerprint({ ...c, exit: null, error: "x /a/one y" }, "", [["/a/one", "<cwd>"]]));
    expect(failureFingerprint({ ...c, exit: null, error: "x /a/one y" }, "", [["/a/one", "<cwd>"]])).toBe(failureFingerprint({ ...c, exit: null, error: "x /b/two y" }, "", [["/b/two", "<cwd>"]]));
  });
  it("empty output is a stable value", () => {
    expect(fp({}, "")).toBe(fp({}, "\n\n"));
  });
});

const rec = (source: string, fingerprint: string | undefined, diff_hash?: string): VerifyRecord => ({
  at: "",
  passed: false,
  source,
  ...(diff_hash ? { diff_hash } : {}),
  commands: [{ name: "t", exit: 1, ms: 1, timed_out: false, log: "verify/1-t.log", ...(fingerprint ? { fingerprint } : {}) }],
});
const cmpWith = (records: VerifyRecord[], rejected: string[], over: Partial<Parameters<typeof compareWithLastRejection>[0]> = {}) =>
  compareWithLastRejection({ source: "S2", fingerprint: "f1", hash: "h1", worktree: true, records, rejected, ...over });

describe("compareWithLastRejection", () => {
  it("has no one to compare with at the first failure, or with only itself", () => {
    expect(cmpWith([], [])).toEqual({ sameFingerprint: false, hash: "unknown" });
    const own = [rec("S2", "f1", "h1")];
    expect(cmpWith(own, ["S2"])).toMatchObject({ sameFingerprint: false });
    expect(cmpWith(own, ["S2"]).previous).toBeUndefined();
  });
  it("compares with the last rejected done", () => {
    expect(cmpWith([rec("S1", "f1", "h1"), rec("S2", "f1", "h1")], ["S1"])).toEqual({ previous: "S1", sameFingerprint: true, hash: "same" });
    expect(cmpWith([rec("S1", "f1", "h0"), rec("S2", "f1", "h1")], ["S1"])).toMatchObject({ sameFingerprint: true, hash: "changed" });
    expect(cmpWith([rec("S1", "f9", "h1"), rec("S2", "f1", "h1")], ["S1"])).toMatchObject({ sameFingerprint: false, hash: "same" });
  });
  it("takes the newest record of a source that has several, and skips records not in verify_rejected", () => {
    const rs = [rec("S0", "f1", "h1"), rec("S1", "f9", "h9"), rec("S1", "f1", "h1"), rec("S3", "f1", "h1"), rec("S2", "f1", "h1")];
    expect(cmpWith(rs, ["S0", "S1"])).toEqual({ previous: "S1", sameFingerprint: true, hash: "same" });
    expect(cmpWith(rs, ["S0"])).toMatchObject({ previous: "S0" }); // S1 and S3 were not rejected in this segment
  });
  it("a record without a fingerprint never matches", () => {
    expect(cmpWith([rec("S1", undefined, "h1"), rec("S2", "f1", "h1")], ["S1"])).toMatchObject({ previous: "S1", sameFingerprint: false });
  });
  it("without a worktree the hash is ignored even when both exist and are equal", () => {
    expect(cmpWith([rec("S1", "f1", "h1")], ["S1"], { worktree: false })).toMatchObject({ sameFingerprint: true, hash: "no-worktree" });
  });
  it("an unknown hash on either side, or both, is never the same", () => {
    expect(cmpWith([rec("S1", "f1")], ["S1"]).hash).toBe("unknown");
    expect(cmpWith([rec("S1", "f1", "h1")], ["S1"], { hash: undefined }).hash).toBe("unknown");
    expect(cmpWith([rec("S1", "f1")], ["S1"], { hash: undefined }).hash).toBe("unknown");
  });
});

describe("repeatAction (spec 28.7 truth table)", () => {
  const cmp = (sameFingerprint: boolean, hash: RepeatComparison["hash"]): RepeatComparison => ({ sameFingerprint, hash });
  const hashes: RepeatComparison["hash"][] = ["same", "changed", "unknown", "no-worktree"];
  it.each(hashes)("counted (a replay) never stops: label on the same fingerprint, none otherwise (%s)", (h) => {
    for (const stoppedBefore of [true, false]) for (const left of [-1, 0, 1, 2]) {
      expect(repeatAction(cmp(true, h), { counted: true, stoppedBefore, left })).toBe("label");
      expect(repeatAction(cmp(false, h), { counted: true, stoppedBefore, left })).toBe("none");
    }
  });
  it.each(hashes)("a done already stopped in this segment stops again (%s)", (h) => {
    for (const same of [true, false]) for (const left of [0, 1, 2]) expect(repeatAction(cmp(same, h), { counted: false, stoppedBefore: true, left })).toBe("stop");
  });
  it.each(hashes)("no rejections left is the limit of spec 27 (%s)", (h) => {
    for (const same of [true, false]) for (const left of [0, -1]) expect(repeatAction(cmp(same, h), { counted: false, stoppedBefore: false, left })).toBe("limit");
  });
  it("with rejections left: stop only on the same fingerprint and the same tree", () => {
    const s = { counted: false, stoppedBefore: false, left: 1 };
    expect(repeatAction(cmp(true, "same"), s)).toBe("stop");
    for (const h of ["changed", "unknown", "no-worktree"] as const) expect(repeatAction(cmp(true, h), s)).toBe("label");
    for (const h of hashes) expect(repeatAction(cmp(false, h), s)).toBe("none");
  });
});

describe("stoppedInSegment", () => {
  const marked = (source: string, seg?: number): VerifyRecord => ({ ...rec(source, "f"), ...(seg === undefined ? {} : { repeat_stop_segment: seg }) });
  it("0 is a real segment number", () => {
    expect(stoppedInSegment([marked("S", 0)], "S", 0)).toBe(true);
  });
  it("an earlier segment's mark, another source and no mark do not count", () => {
    expect(stoppedInSegment([marked("S", 0)], "S", 1)).toBe(false);
    expect(stoppedInSegment([marked("T", 0)], "S", 0)).toBe(false);
    expect(stoppedInSegment([marked("S")], "S", 0)).toBe(false);
    expect(stoppedInSegment(undefined, "S", 0)).toBe(false);
  });
});

describe("texts", () => {
  const msg = "The run was not ended: x";
  it("the label goes first, with the workspace sentence only when the tree changed", () => {
    expect(withRepeatLabel("none", "same", msg)).toBe(msg);
    expect(withRepeatLabel("limit", "changed", msg)).toBe(msg);
    const plain = withRepeatLabel("label", "unknown", msg);
    expect(plain).toBe(`**Same failure as your last rejected \`done\`** (same command, same exit status, same last lines of output; times and paths ignored).\n\n${msg}`);
    expect(withRepeatLabel("label", "no-worktree", msg)).toBe(plain);
    expect(withRepeatLabel("label", "same", msg)).toBe(plain);
    expect(withRepeatLabel("label", "changed", msg)).toBe(plain.replace("ignored).", "ignored). The workspace changed since then, but this result did not."));
  });
  it("the stop note reads as the spec's example", () => {
    expect(repeatStopNote("test", "npm test", "exited with code 1", "verify/2-test.log", 1, 2)).toBe(
      "Verification stopped early: `test` (`npm test`) exited with code 1; this is the same failure as the last rejected attempt and the workspace has not changed since, so no progress is likely and the `done` was not sent back again (1 of 2 rejection(s) used); see verify/2-test.log. Reported as partial; the lead's report is kept as written.",
    );
  });
});
