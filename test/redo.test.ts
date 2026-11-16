import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginAttempt, claimMessages, parkOutbox, recoverRunMail, setFaultHook } from "../src/message-store.js";
import { collectDrafts, priorFailedAttempts, redoUserPrompt } from "../src/redo.js";

let runDir: string;
afterEach(() => {
  setFaultHook(undefined);
  vi.restoreAllMocks();
  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
});

const AGENT = "fe-member";
const mail = (...p: string[]) => path.join(runDir, "mail", ...p);
const writeJson = (file: string, v: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v));
};
const fresh = () => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-redo-"));
  fs.mkdirSync(mail("attempts"), { recursive: true });
  fs.mkdirSync(mail("claims"), { recursive: true });
};
const addClaim = (id: string, over: Record<string, unknown> = {}) =>
  writeJson(mail("claims", `${id}.json`), { id, agent: AGENT, message_ids: ["m1"], files: [], status: "abandoned", created: "2026-01-01T00:00:00Z", ...over });
const addAttempt = (claimId: string, n: number, over: Record<string, unknown> = {}) =>
  writeJson(mail("attempts", `${claimId}-a${n}.json`), {
    id: `${claimId}-a${n}`,
    claim_id: claimId,
    agent: AGENT,
    n,
    status: "failed",
    started_at: `2026-01-01T00:0${n}:00Z`,
    finished_at: `2026-01-01T00:0${n}:30Z`,
    error: "boom",
    parked: [],
    ...over,
  });
const draft = (attemptId: string, name: string, content: string | Buffer) => {
  fs.mkdirSync(mail("attempts", attemptId, "outbox"), { recursive: true });
  fs.writeFileSync(mail("attempts", attemptId, "outbox", name), content);
};
const C1 = "k1-fe-member-aa11aa";
const C2 = "k2-fe-member-bb22bb";
const prior = (ids = ["m1"], exclude = "none") => priorFailedAttempts(runDir, AGENT, ids, exclude);

describe("priorFailedAttempts (T6)", () => {
  it("selects this agent's failed attempts on the same message, newest first, and nothing else", () => {
    fresh();
    addClaim(C1);
    addAttempt(C1, 1);
    addAttempt(C1, 2);
    addAttempt(C1, 3, { status: "started", finished_at: undefined });
    addClaim(C2, { status: "claimed" });
    addAttempt(C2, 1, { started_at: "2026-01-01T01:00:00Z", finished_at: "2026-01-01T01:00:30Z" });
    // not candidates: another agent's claim, other message ids, a committed claim
    addClaim("k3-be-member-cc33cc", { agent: "be-member" });
    addAttempt("k3-be-member-cc33cc", 1, { agent: "be-member" });
    addClaim("k4-fe-member-dd44dd", { message_ids: ["m9"] });
    addAttempt("k4-fe-member-dd44dd", 1);
    addClaim("k5-fe-member-ee55ee", { status: "committed" });
    addAttempt("k5-fe-member-ee55ee", 1);
    const r = prior();
    expect(r.prior.map((a) => a.id)).toEqual([`${C2}-a1`, `${C1}-a2`, `${C1}-a1`]);
    expect(r.skipped).toEqual([]);
    expect(r.prior[0]).toMatchObject({ claimId: C2, n: 1, error: "boom" });
    // the attempt being started is excluded by id, and an overlapping id list is enough
    expect(prior(["m1", "mX"], `${C2}-a1`).prior.map((a) => a.id)).toEqual([`${C1}-a2`, `${C1}-a1`]);
  });

  it("an old run without mail/attempts has no candidates and no skips", () => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-redo-"));
    expect(prior()).toEqual({ prior: [], skipped: [] });
  });

  it("an attempt whose record is gone is recovered from its folder name and claim", () => {
    fresh();
    addClaim(C1);
    draft(`${C1}-a2`, "x.md", "d");
    const r = prior();
    expect(r.prior.map((a) => [a.id, a.error])).toEqual([[`${C1}-a2`, "unknown (attempt record unreadable)"]]);
  });
});

describe("drafts are read from the directory (T7)", () => {
  const setup = () => {
    fresh();
    const outbox = path.join(runDir, "agents", AGENT, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(path.join(outbox, "a.md"), "draft A");
    fs.writeFileSync(path.join(outbox, "b.md"), "draft B");
    const claim = claimMessages(runDir, AGENT, [{ file: "/x/m1.md", meta: { id: "m1" } }]);
    const att = beginAttempt(runDir, claim.id);
    return { outbox, att };
  };
  const names = (text: string) => [...text.matchAll(/^## mail\/attempts\/\S+\/outbox\/(\S+) /gm)].map((m) => m[1]);

  it("(a) a crash after the first file was set aside: recover sets aside the rest and both are returned", () => {
    const { outbox, att } = setup();
    let n = 0;
    setFaultHook((step) => {
      if (step === "park:moved" && ++n === 1) throw new Error("crash");
    });
    expect(() => parkOutbox(runDir, outbox, att.id)).toThrow(/crash/);
    setFaultHook(undefined);
    recoverRunMail(runDir, { outboxOf: () => outbox });
    const p = prior();
    const d = collectDrafts(runDir, p.prior);
    expect(names(d.text)).toEqual(["a.md", "b.md"]);
    expect(d.reconciled).toEqual([{ attempt: att.id, onlyOnDisk: ["a.md"], onlyInRecord: [] }]);
  });

  it("(b) a crash after every file was set aside, before the attempt was finished: parked is [] but the files are returned", () => {
    const { outbox, att } = setup();
    parkOutbox(runDir, outbox, att.id);
    recoverRunMail(runDir, { outboxOf: () => outbox });
    const d = collectDrafts(runDir, prior().prior);
    expect(names(d.text)).toEqual(["a.md", "b.md"]);
    expect(d.reconciled).toEqual([{ attempt: att.id, onlyOnDisk: ["a.md", "b.md"], onlyInRecord: [] }]);
  });

  it("(c) a damaged attempt record: the claim and the folder are enough", () => {
    const { outbox, att } = setup();
    parkOutbox(runDir, outbox, att.id);
    fs.writeFileSync(mail("attempts", `${att.id}.json`), "{ not json");
    recoverRunMail(runDir, { outboxOf: () => outbox });
    const p = prior();
    expect(p.prior.map((a) => [a.id, a.error])).toEqual([[att.id, "unknown (attempt record unreadable)"]]);
    expect(names(collectDrafts(runDir, p.prior).text)).toEqual(["a.md", "b.md"]);
  });
});

/** One failed attempt with a valid claim, and its outbox folder ready for planting things in. */
function oneAttempt(): string {
  fresh();
  addClaim(C1);
  addAttempt(C1, 1);
  fs.mkdirSync(mail("attempts", `${C1}-a1`, "outbox"), { recursive: true });
  return `${C1}-a1`;
}
const inject = () => collectDrafts(runDir, prior().prior);
const reasons = (r: { skipped: { reason: string }[] }) => r.skipped.map((s) => s.reason);

/** Run `code` (which gets `runDir`) in a child with a hard 10 s limit: a read that blocks shows up as ETIMEDOUT. */
function inChild(code: string): { out: string; timedOut: boolean } {
  const root = path.resolve(import.meta.dirname, "..");
  const script = path.join(runDir, "child.mjs");
  fs.writeFileSync(script, `import * as r from ${JSON.stringify(path.join(root, "src/redo.ts"))};\nconst runDir = ${JSON.stringify(runDir)};\n${code}\n`);
  const res = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
  return { out: res.stdout, timedOut: (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" };
}

describe("draft reading is safe (T8)", () => {
  it("skips a symlinked file, a symlinked outbox and a symlinked attempt folder, and never reads their targets", () => {
    const id = oneAttempt();
    const outside = path.join(runDir, "..", `outside-${path.basename(runDir)}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.md"), "SECRET");
    fs.symlinkSync(path.join(outside, "secret.md"), mail("attempts", id, "outbox", "link.md"));
    draft(id, "ok.md", "fine");
    let r = inject();
    expect(r.text).toContain("fine");
    expect(r.text).not.toContain("SECRET");
    expect(reasons(r)).toContain("symlink");

    fs.rmSync(mail("attempts", id, "outbox"), { recursive: true });
    fs.symlinkSync(outside, mail("attempts", id, "outbox"));
    r = inject();
    expect(r.text).toBe("");
    expect(reasons(r)).toContain("ancestor_symlink");

    fs.rmSync(mail("attempts", id, "outbox"));
    fs.rmSync(mail("attempts", id), { recursive: true });
    fs.symlinkSync(outside, mail("attempts", id));
    fs.mkdirSync(path.join(outside, "outbox"), { recursive: true });
    fs.writeFileSync(path.join(outside, "outbox", "s.md"), "SECRET");
    r = inject();
    expect(r.text).not.toContain("SECRET");
    expect(reasons(r)).toContain("ancestor_symlink");
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("a FIFO among the drafts does not block, and the other drafts are still read", () => {
    const id = oneAttempt();
    draft(id, "ok.md", "fine");
    expect(spawnSync("mkfifo", [mail("attempts", id, "outbox", "pipe.md")]).status).toBe(0);
    const { out, timedOut } = inChild(`const p = r.priorFailedAttempts(runDir, "${AGENT}", ["m1"], "x");\nconst d = r.collectDrafts(runDir, p.prior);\nconsole.log(JSON.stringify({ text: d.text, skipped: d.skipped }));`);
    expect(timedOut).toBe(false);
    const got = JSON.parse(out) as { text: string; skipped: { reason: string }[] };
    expect(got.text).toContain("fine");
    expect(got.skipped.map((s) => s.reason)).toContain("not_regular");
  });

  it("reads at most the remaining budget + 1 byte of a 64 MB sparse file", () => {
    const id = oneAttempt();
    const f = mail("attempts", id, "outbox", "big.md");
    fs.writeFileSync(f, "a".repeat(8000));
    fs.truncateSync(f, 64 * 1024 * 1024);
    const p = prior().prior;
    const spy = vi.spyOn(fs, "readSync");
    const r = collectDrafts(runDir, p);
    const total = spy.mock.calls.reduce((s, c) => s + (c[3] as number), 0);
    expect(total).toBeLessThanOrEqual(4096 + 1);
    expect(r.injected[0]).toMatchObject({ truncated: true });
    expect(r.text).toContain(`[truncated: mail/attempts/${id}/outbox/big.md, ${64 * 1024 * 1024} B]`);
  });

  it("skips a file with a NUL byte and a dot file, and scans at most 64 entries", () => {
    const id = oneAttempt();
    draft(id, "bin.md", Buffer.from([0x61, 0, 0x62]));
    draft(id, ".hidden.md", "h");
    draft(id, "text.md", "t");
    let r = inject();
    expect(r.text).toContain("t");
    expect(reasons(r)).toContain("binary");
    for (let i = 0; i < 80; i++) draft(id, `f${String(i).padStart(3, "0")}.md`, "x");
    r = inject();
    expect(reasons(r)).toContain("over_entry_cap");
  });
});

describe("metadata reading is safe (T8m)", () => {
  /** A second, valid candidate that must survive whatever is wrong with the first. */
  const good = () => {
    addClaim(C2);
    addAttempt(C2, 1);
  };
  const outside = () => {
    const d = path.join(os.tmpdir(), `lyceum-redo-out-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  it("(a) a symlinked attempt JSON is skipped; the other candidate stays", () => {
    fresh();
    good();
    addClaim(C1);
    const out = outside();
    writeJson(path.join(out, "a.json"), { id: `${C1}-a1`, claim_id: C1, agent: AGENT, n: 1, status: "failed", error: "x" });
    fs.symlinkSync(path.join(out, "a.json"), mail("attempts", `${C1}-a1.json`));
    const r = prior();
    expect(r.prior.map((a) => a.id)).toEqual([`${C2}-a1`]);
    expect(r.skipped).toContainEqual({ path: `mail/attempts/${C1}-a1.json`, reason: "symlink" });
    fs.rmSync(out, { recursive: true, force: true });
  });

  it("(b) a symlinked claim JSON drops its attempts only", () => {
    fresh();
    good();
    addAttempt(C1, 1);
    const out = outside();
    writeJson(path.join(out, "c.json"), { id: C1, agent: AGENT, message_ids: ["m1"], files: [], status: "abandoned", created: "x" });
    fs.symlinkSync(path.join(out, "c.json"), mail("claims", `${C1}.json`));
    const r = prior();
    expect(r.prior.map((a) => a.id)).toEqual([`${C2}-a1`]);
    expect(r.skipped).toContainEqual({ path: `mail/claims/${C1}.json`, reason: "symlink" });
    fs.rmSync(out, { recursive: true, force: true });
  });

  it("(c) a symlinked mail/claims or mail/attempts gives no candidates", () => {
    for (const which of ["claims", "attempts"]) {
      fresh();
      good();
      const out = outside();
      fs.cpSync(mail(which), out, { recursive: true });
      fs.rmSync(mail(which), { recursive: true });
      fs.symlinkSync(out, mail(which));
      const r = prior();
      expect(r.prior).toEqual([]);
      expect(r.skipped).toEqual([{ path: `mail/${which}`, reason: "ancestor_symlink" }]);
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it("(d, e) a FIFO as an attempt JSON or as a claim JSON does not block and is reported not_regular", () => {
    for (const kind of ["attempt", "claim"]) {
      fresh();
      good();
      if (kind === "attempt") {
        addClaim(C1);
        expect(spawnSync("mkfifo", [mail("attempts", `${C1}-a1.json`)]).status).toBe(0);
      } else {
        addAttempt(C1, 1);
        expect(spawnSync("mkfifo", [mail("claims", `${C1}.json`)]).status).toBe(0);
      }
      const { out, timedOut } = inChild(`console.log(JSON.stringify(r.priorFailedAttempts(runDir, "${AGENT}", ["m1"], "x")));`);
      expect(timedOut).toBe(false);
      const got = JSON.parse(out) as { prior: { id: string }[]; skipped: { reason: string }[] };
      expect(got.prior.map((a) => a.id)).toEqual([`${C2}-a1`]);
      expect(got.skipped.map((s) => s.reason)).toContain("not_regular");
    }
  });

  it("(f) a 70 KiB attempt JSON and a 64 MB sparse claim JSON are metadata_too_large and read at most 64 KiB + 1", () => {
    fresh();
    good();
    addClaim(C1);
    const big = JSON.stringify({ id: `${C1}-a1`, claim_id: C1, agent: AGENT, n: 1, status: "failed", error: "e".repeat(70 * 1024) });
    writeJson(mail("attempts", `${C1}-a1.json`), big);
    const C3 = "k3-fe-member-cc33cc";
    addAttempt(C3, 1);
    const f = mail("claims", `${C3}.json`);
    fs.closeSync(fs.openSync(f, "w"));
    fs.truncateSync(f, 64 * 1024 * 1024);
    const spy = vi.spyOn(fs, "readSync");
    const r = prior();
    const biggest = Math.max(...spy.mock.calls.map((c) => c[3] as number));
    expect(biggest).toBeLessThanOrEqual(64 * 1024 + 1);
    expect(r.prior.map((a) => a.id)).toEqual([`${C2}-a1`]);
    expect(r.skipped.map((s) => s.reason).filter((x) => x === "metadata_too_large")).toHaveLength(2);
  });

  it("(g) a mismatched id, a claim_id that escapes the folder and a claim whose id differs are bad_record", () => {
    fresh();
    good();
    addClaim(C1);
    addAttempt(C1, 1, { id: `${C1}-a7` }); // id differs from the file name
    writeJson(mail("attempts", "evil-a1.json"), { id: "evil-a1", claim_id: "../../x", agent: AGENT, n: 1, status: "failed" });
    writeJson(mail("attempts", "dots-a1.json"), { id: "dots-a1", claim_id: "..", agent: AGENT, n: 1, status: "failed" });
    const C4 = "k4-fe-member-dd44dd";
    writeJson(mail("claims", `${C4}.json`), { id: "other", agent: AGENT, message_ids: ["m1"], files: [], status: "abandoned", created: "x" });
    addAttempt(C4, 1);
    const opened = vi.spyOn(fs, "openSync");
    const r = prior();
    expect(r.prior.map((a) => a.id)).toEqual([`${C2}-a1`]);
    expect(reasons(r).filter((x) => x === "bad_record").length).toBeGreaterThanOrEqual(4);
    for (const c of opened.mock.calls) expect(String(c[0]).startsWith(runDir)).toBe(true);
  });
});

describe("draft budget (T9)", () => {
  it("keeps the block within 4096 B and 5 files, with a marker for the rest", () => {
    const id = oneAttempt();
    for (let i = 0; i < 8; i++) draft(id, `f${i}.md`, `file ${i} ${"z".repeat(300 + i)}`);
    const d = inject();
    expect(Buffer.byteLength(d.text)).toBeLessThanOrEqual(4096);
    expect(d.injected).toHaveLength(5);
    expect(d.text).toContain(`(3 more draft file(s) not shown: mail/attempts/${id}/outbox/)`);
    expect(d.text).toContain("# Drafts from your failed attempt (unverified, not delivered)");
  });

  it("truncates a file that does not fit, keeps the whole block in budget and never splits a character", () => {
    const id = oneAttempt();
    draft(id, "big.md", "中".repeat(5000));
    const d = inject();
    expect(Buffer.byteLength(d.text)).toBeLessThanOrEqual(4096);
    expect(d.text).not.toContain("�");
    expect(d.text).toContain(`[truncated: mail/attempts/${id}/outbox/big.md, 15000 B]`);
    expect(d.injected[0]).toMatchObject({ truncated: true });
  });

  it("the fence is longer than any run of backticks in the content", () => {
    const id = oneAttempt();
    draft(id, "f.md", "before\n````\ninside\n````\nafter");
    const d = inject();
    expect(d.text).toContain("\n`````\nbefore");
    expect(d.text).toContain("after\n`````");
  });
});

describe("draft dedup (T10)", () => {
  it("shows identical small files once, from the newest attempt", () => {
    fresh();
    addClaim(C1);
    addAttempt(C1, 1);
    addAttempt(C1, 2);
    draft(`${C1}-a1`, "x.md", "same text");
    draft(`${C1}-a2`, "x.md", "same text");
    const d = inject();
    expect(d.injected.map((i) => i.path)).toEqual([`mail/attempts/${C1}-a2/outbox/x.md`]);
  });

  it("shows files that share a prefix but differ at the end", () => {
    fresh();
    addClaim(C1);
    addAttempt(C1, 1);
    addAttempt(C1, 2);
    const prefix = "p".repeat(900);
    draft(`${C1}-a1`, "x.md", `${prefix}-one`);
    draft(`${C1}-a2`, "x.md", `${prefix}-two`);
    const d = inject();
    expect(d.injected).toHaveLength(2);
    expect(d.text).toContain("-one");
    expect(d.text).toContain("-two");
  });
});

describe("redoUserPrompt", () => {
  const p = { id: "k-a1", claimId: "k", n: 1, error: "interrupted", at: 0 };
  it("is the base text when there is nothing to redo", () => {
    expect(redoUserPrompt("BASE", { attempt: 0, prior: [], drafts: "", taskMemory: "/tm" })).toBe("BASE");
  });
  it("adds a Redo notice, the task memory sentence and the drafts", () => {
    const t = redoUserPrompt("BASE", { attempt: 0, prior: [p], drafts: "DRAFTS", taskMemory: "/tm" });
    expect(t.startsWith("BASE\n\n# Redo notice\n")).toBe(true);
    expect(t).toContain("(interrupted; attempt k-a1)");
    expect(t).toContain("not delivered: see the drafts below.");
    expect(t).toContain("Read your task memory (`/tm`) first");
    expect(t.endsWith("\n\nDRAFTS")).toBe(true);
  });
  it("keeps the old Retry text, plus the task memory sentence only when there is one", () => {
    const old = "BASE\n\n# Retry notice\nYour previous attempt at this wake-up failed (boom) after possibly changing files already. Its mail was discarded. Check the current state of the repository before redoing the work, and send the mail again.";
    expect(redoUserPrompt("BASE", { attempt: 1, error: "boom", prior: [], drafts: "" })).toBe(old);
    expect(redoUserPrompt("BASE", { attempt: 1, error: "boom", prior: [], drafts: "", taskMemory: "/tm" })).toBe(`${old} Read your task memory (\`/tm\`) first: progress you recorded there survives a failed attempt.`);
    const withDrafts = redoUserPrompt("BASE", { attempt: 1, error: "boom", prior: [p], drafts: "DRAFTS" });
    expect(withDrafts).not.toContain("discarded");
    expect(withDrafts).toContain("Its mail was set aside, not delivered: see the drafts below.");
    expect(withDrafts.endsWith("\n\nDRAFTS")).toBe(true);
  });
});

describe("draft block bounds (round 1 fixes)", () => {
  it("O1: stays within 4096 B when the next attempt has a longer path than the first", () => {
    fresh();
    const long = `${"z".repeat(190)}`;
    addClaim("c");
    addClaim(long);
    addAttempt("c", 1, { started_at: "2026-02-01T00:00:00Z", finished_at: "2026-02-01T00:00:30Z" });
    addAttempt(long, 1);
    draft("c-a1", "x.md", "a".repeat(9000));
    draft(`${long}-a1`, "x.md", "second");
    const d = inject();
    expect(d.injected).toHaveLength(1);
    expect(Buffer.byteLength(d.text)).toBeLessThanOrEqual(4096);
  });

  for (const ch of ["é", "中", "😀"]) {
    for (let pad = 0; pad < 4; pad++) {
      it(`O2: no replacement character for ${Buffer.byteLength(ch)}-byte chars at offset ${pad}`, () => {
        const id = oneAttempt();
        draft(id, "x.md", "a".repeat(pad) + ch.repeat(4000));
        const d = inject();
        expect(d.text).not.toContain("�");
        expect(Buffer.byteLength(d.text)).toBeLessThanOrEqual(4096);
        expect(d.injected[0]).toMatchObject({ truncated: true });
      });
    }
  }

  it("O3: a missing or invalid timestamp falls back to the attempt directory mtime", () => {
    fresh();
    addClaim("n");
    addClaim("o");
    addAttempt("n", 1, { started_at: "invalid", finished_at: undefined });
    addAttempt("o", 1, { started_at: "2026-01-01T00:00:00Z", finished_at: undefined });
    fs.mkdirSync(mail("attempts", "n-a1"), { recursive: true });
    const t = new Date("2026-10-01T00:00:00Z");
    fs.utimesSync(mail("attempts", "n-a1"), t, t);
    const r = prior();
    expect(r.prior.map((a) => a.id)).toEqual(["n-a1", "o-a1"]);
    expect(r.prior[0]?.at).toBe(t.getTime());
  });
});
