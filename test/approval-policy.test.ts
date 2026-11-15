import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalError } from "../src/approval-error.js";
import { approvalDenyInventory, approvalDenyPaths, approvalDenyPathsStrict, type DenyScanIo } from "../src/approval-policy.js";
import { canonicalPath } from "../src/paths.js";
import { callProject, callsDir, resolveCallAgent } from "../src/call.js";
import type { ResolvedProject } from "../src/config.js";
import { writePolicy } from "../src/policy.js";
import { bindRunProject } from "../src/run-store.js";
import { soloProject } from "../src/solo.js";
import { validateProject } from "../src/validate.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const EXEC = (allow: string, limit = 50, command = "/opt/x/tool"): string =>
  `executors:\n  x:\n    command: ["${command}"]\n    allow: ${allow}\n    timeout_sec: 5\n  y:\n    command: ["/opt/y/tool"]\n    allow: []\n    timeout_sec: 5\nlimits:\n  max_scan_entries: ${limit}\n`;
const req = (...p: string[]): string => path.join(env.home, "requests", ...p);
const mkdirs = (...rels: string[]): void => { for (const r of rels) fs.mkdirSync(req(r), { recursive: true }); };
const enrolledProject = (allow = "[{project: demo, agent: fe-member}]", limit = 50, command = "/opt/x/tool"): ResolvedProject => {
  fs.writeFileSync(path.join(env.home, "executors.yaml"), EXEC(allow, limit, command));
  return env.project();
};
const bound = (p: ResolvedProject, instances?: Parameters<typeof bindRunProject>[3]): ResolvedProject =>
  bindRunProject(p, path.join(p.paths.runs, "fixture-run"), "run", instances);
const SLOTS = ["projects/demo/run-a/fe-member", "projects/demo/run-a/qa-member", "projects/demo/fixture-run/fe-member",
  "projects/demo/fixture-run/fe-member--2", "projects/other/r1/lead", "calls/call-1"];

/** An io that counts opens and closes and lets a test break one step. */
function traced(over: Partial<{ lstat: (p: string) => void; open: (p: string) => void; read: (n: number) => void; close: (p: string) => void }> = {}) {
  const t = { opens: 0, closes: 0 };
  let reads = 0;
  const io: DenyScanIo = {
    lstatSync: ((p: string) => { over.lstat?.(p); return fs.lstatSync(p); }) as typeof fs.lstatSync,
    opendirSync: (p: string) => {
      over.open?.(p);
      const d = fs.opendirSync(p);
      t.opens++;
      return { readSync: () => { over.read?.(++reads); return d.readSync(); }, closeSync: () => { t.closes++; d.closeSync(); over.close?.(p); } };
    },
  };
  return { io, t };
}
const fail = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
const throwing: DenyScanIo = { lstatSync: fail("EIO") as never, opendirSync: fail("EIO") };

describe("non-enrolled agents: no I/O, no change", () => {
  it("returns [] without touching the io, even when other agents are enrolled", () => {
    env = makeEnv();
    const p = bound(enrolledProject());
    for (const n of ["lead", "qa-member"]) {
      expect(approvalDenyPaths(p, p.agents[n]!, throwing)).toEqual([]);
      expect(approvalDenyInventory(p, p.agents[n]!, throwing)).toEqual({ ready: true, paths: [] });
      expect(approvalDenyPathsStrict(p, p.agents[n]!, throwing)).toEqual([]);
    }
  });

  it("writePolicy of a non-enrolled agent is identical with and without an executors file", () => {
    env = makeEnv();
    const before = JSON.stringify(writePolicy(bound(env.project()), bound(env.project()).agents["qa-member"]!));
    const p = bound(enrolledProject());
    expect(JSON.stringify(writePolicy(p, p.agents["qa-member"]!))).toBe(before);
  });
});

describe("enrolled agent: the deny list, item by item", () => {
  it("lists store, executors file, every executor command, repo settings and every OTHER slot; nothing coarser", () => {
    env = makeEnv();
    mkdirs(...SLOTS);
    const p = bound(enrolledProject());
    const own = req("projects/demo/fixture-run/fe-member");
    const deny = writePolicy(p, p.agents["fe-member"]!).deny;
    const expected = [
      path.join(env.home, "approvals"), path.join(env.home, "executors.yaml"), "/opt/x/tool", "/opt/y/tool",
      path.join(p.dir, ".claude", "settings.json"), path.join(p.dir, ".claude", "settings.local.json"),
      ...SLOTS.map((s) => req(s)).filter((s) => s !== own).sort(),
    ];
    for (const e of expected) expect(deny, e).toContain(e);
    expect(deny).not.toContain(own);
    for (const coarse of ["", "projects", "projects/demo", "projects/demo/fixture-run", "calls"]) expect(deny).not.toContain(req(coarse).replace(/\/$/, ""));
    expect(deny.some((d) => d.includes("proposals"))).toBe(false);
    expect(new Set(deny).size).toBe(deny.length);
    // every entry in raw form, then its canonical form when different (macOS: /var is /private/var); fixed entries first, then the slots
    const forms = (xs: string[]): string[] => xs.flatMap((e) => [e, canonicalPath(e)]);
    const exact = [...new Set([...forms(expected.slice(0, 6)), ...forms(expected.slice(6))])];
    expect(approvalDenyPaths(p, p.agents["fe-member"]!)).toEqual(exact);
    expect(approvalDenyPathsStrict(p, p.agents["fe-member"]!)).toEqual(exact);
  });

  it("excludes the own slot even when its directory does not exist yet", () => {
    env = makeEnv();
    mkdirs("projects/demo/run-a/qa-member");
    const p = bound(enrolledProject());
    expect(approvalDenyPaths(p, p.agents["fe-member"]!)).toContain(req("projects/demo/run-a/qa-member"));
    expect(approvalDenyPaths(p, p.agents["fe-member"]!)).not.toContain(req("projects/demo/fixture-run/fe-member"));
  });

  it("another instance of the same role is another slot; the instance's own slot is excluded", () => {
    env = makeEnv();
    mkdirs("projects/demo/fixture-run/fe-member", "projects/demo/fixture-run/fe-member--2");
    const p = bound(enrolledProject(), { roles: { "fe-member": ["fe-member--2"] } });
    expect(approvalDenyPaths(p, p.agents["fe-member"]!)).toEqual(expect.arrayContaining([req("projects/demo/fixture-run/fe-member--2")]));
    expect(approvalDenyPaths(p, p.agents["fe-member"]!)).not.toContain(req("projects/demo/fixture-run/fe-member"));
    const inst = approvalDenyPaths(p, p.agents["fe-member--2"]!);
    expect(inst).toContain(req("projects/demo/fixture-run/fe-member"));
    expect(inst).not.toContain(req("projects/demo/fixture-run/fe-member--2"));
  });

  it("a call excludes its own call root only", () => {
    env = makeEnv();
    fs.writeFileSync(path.join(env.home, "executors.yaml"), EXEC("[{call: fe-member}]"));
    mkdirs("calls/mine", "calls/theirs", "projects/demo/r/fe-member");
    const agent = resolveCallAgent(env.home, "fe-member");
    const cp = callProject(env.home, agent, env.repo, path.join(callsDir(env.home), "mine"));
    const deny = approvalDenyPaths(cp, cp.agents["fe-member"]!);
    expect(deny).toContain(req("calls/theirs"));
    expect(deny).toContain(req("projects/demo/r/fe-member"));
    expect(deny).not.toContain(req("calls/mine"));
  });

  it("an unbound project (tidy, direct) has no own slot: every slot is listed", () => {
    env = makeEnv();
    mkdirs(...SLOTS);
    const p = enrolledProject();
    const deny = approvalDenyPaths(p, p.agents["fe-member"]!);
    for (const s of SLOTS) expect(deny).toContain(req(s));
  });

  it("includes the agent's worktree settings, deduplicated with the main repo's", () => {
    env = makeEnv();
    const p = bound(enrolledProject());
    const wt = path.join(env.root, "wt");
    const withWt = { ...p, workspaces: { "fe-member": { agent: "fe-member", root: wt, dir: wt, gitDir: path.join(env.root, "gd"), commonDir: path.join(env.root, "gc") } } } as unknown as ResolvedProject;
    const deny = approvalDenyPaths(withWt, withWt.agents["fe-member"]!);
    expect(deny).toEqual(expect.arrayContaining([path.join(wt, ".claude", "settings.json"), path.join(wt, ".claude", "settings.local.json"), path.join(p.dir, ".claude", "settings.json")]));
    const mainSettings = approvalDenyPaths(p, p.agents["fe-member"]!).filter((d) => d.endsWith("settings.json") && canonicalPath(d) === canonicalPath(path.join(p.dir, ".claude", "settings.json")));
    expect(new Set(mainSettings).size).toBe(mainSettings.length);
    expect(mainSettings.length).toBeLessThanOrEqual(2);
  });

  it("a missing requests/ is an empty inventory, not an error", () => {
    env = makeEnv();
    const p = bound(enrolledProject());
    const inv = approvalDenyInventory(p, p.agents["fe-member"]!);
    expect(inv.ready).toBe(true);
    expect(approvalDenyPathsStrict(p, p.agents["fe-member"]!)).toEqual(approvalDenyPaths(p, p.agents["fe-member"]!));
  });

  it("an enrolled agent without an approval context is unavailable, not silently empty", () => {
    env = makeEnv();
    const p = bound(enrolledProject());
    const a = { ...p.agents["fe-member"]!, approval: undefined };
    expect(approvalDenyInventory(p, a).ready).toBe(false);
    expect(() => approvalDenyPathsStrict(p, a)).toThrow(ApprovalError);
  });
});

describe("unavailable: never partial, never following links, always closed", () => {
  const cases: Record<string, (setup: () => void) => { io: DenyScanIo; t: { opens: number; closes: number } }> = {
    "lstat EIO on a slot": () => traced({ lstat: (p) => { if (p.endsWith("qa-member")) fail("EIO")(); } }),
    "opendir EACCES on a run dir": () => traced({ open: (p) => { if (p.endsWith("run-a")) fail("EACCES")(); } }),
    "readdir EIO after the first entry": () => traced({ read: (n) => { if (n >= 3) fail("EIO")(); } }),
    "entry vanished between list and lstat": () => traced({ lstat: (p) => { if (p.endsWith("projects/other/r1")) fail("ENOENT")(); } }),
  };
  for (const [label, make] of Object.entries(cases)) {
    it(`${label}: structured result, fixed denies only, strict throws, all handles closed`, () => {
      env = makeEnv();
      mkdirs(...SLOTS);
      const p = bound(enrolledProject());
      const { io, t } = make(() => {});
      const inv = approvalDenyInventory(p, p.agents["fe-member"]!, io);
      expect(inv.ready).toBe(false);
      expect(t.opens).toBe(t.closes);
      const fixed = approvalDenyPaths(p, p.agents["fe-member"]!, io);
      expect(fixed.some((d) => d.startsWith(req("")))).toBe(false);
      expect(fixed).toContain(path.join(env.home, "approvals"));
      expect(() => approvalDenyPathsStrict(p, p.agents["fe-member"]!, io)).toThrow(ApprovalError);
    });
  }

  const unsafe: Record<string, () => void> = {
    "requests is a symlink": () => { fs.mkdirSync(path.join(env.root, "elsewhere")); fs.symlinkSync(path.join(env.root, "elsewhere"), req("")); },
    "projects is a symlink": () => { fs.mkdirSync(path.join(env.root, "e")); fs.mkdirSync(req("")); fs.symlinkSync(path.join(env.root, "e"), req("projects")); },
    "a project dir is a symlink": () => { mkdirs("projects"); fs.mkdirSync(path.join(env.root, "e")); fs.symlinkSync(path.join(env.root, "e"), req("projects/demo")); },
    "a run dir is a symlink": () => { mkdirs("projects/demo"); fs.mkdirSync(path.join(env.root, "e")); fs.symlinkSync(path.join(env.root, "e"), req("projects/demo/r")); },
    "a slot is a symlink": () => { mkdirs("projects/demo/r"); fs.mkdirSync(path.join(env.root, "e")); fs.symlinkSync(path.join(env.root, "e"), req("projects/demo/r/qa-member")); },
    "a call is a symlink": () => { mkdirs("calls"); fs.mkdirSync(path.join(env.root, "e")); fs.symlinkSync(path.join(env.root, "e"), req("calls/c1")); },
    "a slot is a regular file": () => { mkdirs("projects/demo/r"); fs.writeFileSync(req("projects/demo/r/qa-member"), "x"); },
    "an invalid project name": () => mkdirs("projects/Bad Name/r/qa-member"),
    "an invalid run id": () => mkdirs("projects/demo/-bad/qa-member"),
    "an invalid slot name": () => mkdirs("projects/demo/r/.hidden"),
    "an invalid call id": () => mkdirs("calls/.x"),
    "a stray entry in requests/": () => { mkdirs("calls"); fs.writeFileSync(req(".DS_Store"), ""); },
  };
  for (const [label, setup] of Object.entries(unsafe)) {
    it(`${label}: unavailable, no slot list, no widening`, () => {
      env = makeEnv();
      const p = bound(enrolledProject());
      setup();
      const { io, t } = traced();
      expect(approvalDenyInventory(p, p.agents["fe-member"]!, io).ready).toBe(false);
      expect(t.opens).toBe(t.closes);
      const fixed = approvalDenyPaths(p, p.agents["fe-member"]!, io);
      expect(fixed.some((d) => d.startsWith(req("")))).toBe(false);
      expect(() => approvalDenyPathsStrict(p, p.agents["fe-member"]!, io)).toThrow(ApprovalError);
    });
  }

  it("more entries than max_scan_entries (50) in total: unavailable, even though no single directory is large", () => {
    env = makeEnv();
    for (let i = 0; i < 20; i++) mkdirs(`projects/demo/r${i}/slot-a`, `projects/demo/r${i}/slot-b`);
    const p = bound(enrolledProject());
    const { io, t } = traced();
    const inv = approvalDenyInventory(p, p.agents["fe-member"]!, io);
    expect(inv.ready).toBe(false);
    expect(t.opens).toBe(t.closes);
    if (!inv.ready) expect(inv.error.message).toContain("50");
  });

  it("the cap is exact: limit == entries read passes, limit == entries - 1 is unavailable", () => {
    env = makeEnv();
    mkdirs(...Array.from({ length: 7 }, (_, i) => `projects/demo/r${i}/s`)); // requests: 1 (projects); projects: 1 (demo); demo: 7 runs; 7 slots => 16 entries
    const ok = bound(enrolledProject("[{project: demo, agent: fe-member}]", 16));
    expect(approvalDenyInventory(ok, ok.agents["fe-member"]!).ready).toBe(true);
    const over = bound(enrolledProject("[{project: demo, agent: fe-member}]", 15));
    expect(approvalDenyInventory(over, over.agents["fe-member"]!).ready).toBe(false);
  });
});

describe("locality: one enrolled agent's inventory failure stays its own", () => {
  it("validateProject, other agents' writePolicy, a non-enrolled solo and the enrolled agent's writePolicy all still work", () => {
    env = makeEnv();
    fs.mkdirSync(path.join(env.root, "e"));
    fs.symlinkSync(path.join(env.root, "e"), req(""));
    const p = enrolledProject();
    expect(approvalDenyInventory(p, p.agents["fe-member"]!).ready).toBe(false);
    const res = validateProject(p);
    expect(res.ok, JSON.stringify(res.issues)).toBe(true);
    const b = bound(p);
    expect(() => writePolicy(b, b.agents["qa-member"]!)).not.toThrow();
    expect(writePolicy(b, b.agents["qa-member"]!).deny.some((d) => d.includes("requests"))).toBe(false);
    const solo = soloProject(b, "qa-member");
    expect(() => writePolicy(solo, solo.agents["qa-member"]!)).not.toThrow();
    const w = writePolicy(b, b.agents["fe-member"]!);
    expect(w.deny).toContain(path.join(env.home, "executors.yaml"));
    expect(w.deny.some((d) => d.startsWith(req("")))).toBe(false);
  });
});

describe("review fixes: command symlink, symlinked home, close errors", () => {
  it("F1: a command that is a symlink into a repo dir is denied by its literal and its real path; a missing command keeps the literal only", () => {
    env = makeEnv();
    const real = path.join(env.repo, "tools", "real-tool");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "#!/bin/sh\n");
    fs.mkdirSync(path.join(env.root, "bin"));
    const link = path.join(env.root, "bin", "tool");
    fs.symlinkSync(real, link);
    const p = bound(enrolledProject("[{project: demo, agent: fe-member}]", 50, link));
    const deny = approvalDenyPaths(p, p.agents["fe-member"]!);
    expect(deny).toContain(link);
    expect(deny).toContain(fs.realpathSync(real));
    const missing = path.join(env.root, "bin", "nope");
    const q = bound(enrolledProject("[{project: demo, agent: fe-member}]", 50, missing));
    const d2 = approvalDenyPaths(q, q.agents["fe-member"]!);
    expect(d2).toContain(missing);
    expect(approvalDenyInventory(q, q.agents["fe-member"]!).ready).toBe(true);
  });

  it("F2: with a symlinked home every entry (store, executors file, slot roots) appears raw and canonical; the own slot in neither form", () => {
    env = makeEnv();
    const link = path.join(env.root, "home-link");
    fs.symlinkSync(env.home, link);
    mkdirs("projects/demo/fixture-run/fe-member", "projects/demo/run-a/qa-member");
    const base = bound(enrolledProject());
    const p = { ...base, home: link } as ResolvedProject;
    const deny = approvalDenyPaths(p, p.agents["fe-member"]!);
    const realHome = fs.realpathSync(env.home);
    for (const item of ["approvals", "executors.yaml", "requests/projects/demo/run-a/qa-member"]) {
      expect(deny, item).toContain(path.join(link, item));
      expect(deny, item).toContain(path.join(realHome, item));
    }
    for (const own of [path.join(link, "requests/projects/demo/fixture-run/fe-member"), path.join(realHome, "requests/projects/demo/fixture-run/fe-member")]) expect(deny).not.toContain(own);
    expect(new Set(deny).size).toBe(deny.length);
    expect(approvalDenyPaths(p, p.agents["fe-member"]!)).toEqual(deny);
  });

  it("a lone close failure makes the inventory unavailable (IO_ERROR naming the directory); a scan error that came first wins", () => {
    env = makeEnv();
    mkdirs(...SLOTS);
    const p = bound(enrolledProject());
    const lone = traced({ close: (d) => { if (d.endsWith("run-a")) fail("EIO")(); } });
    const inv = approvalDenyInventory(p, p.agents["fe-member"]!, lone.io);
    expect(inv.ready).toBe(false);
    if (!inv.ready) {
      expect(inv.error.code).toBe("IO_ERROR");
      expect(inv.error.message).toContain(req("projects/demo/run-a"));
      expect(inv.error.message).toContain("close failed (EIO)");
    }
    expect(lone.t.opens).toBe(lone.t.closes);
    const both = traced({ read: (n) => { if (n >= 3) fail("EACCES")(); }, close: () => fail("EIO")() });
    const inv2 = approvalDenyInventory(p, p.agents["fe-member"]!, both.io);
    expect(inv2.ready).toBe(false);
    if (!inv2.ready) {
      expect(inv2.error.message).toContain("readdir failed (EACCES)");
      expect(inv2.error.message).not.toContain("close failed");
    }
    expect(() => approvalDenyPathsStrict(p, p.agents["fe-member"]!, lone.io)).toThrow(/close failed/);
  });
});
