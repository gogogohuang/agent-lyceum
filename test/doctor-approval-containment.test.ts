import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorsConfig } from "../src/approval-executors.js";
import { approvalContainmentChecks } from "../src/doctor-approval-containment.js";

const OVERLAP = "Approval protected path overlaps an agent writable range:";
const INCOMPLETE = "Approval containment scan is incomplete:";
const UNVERIFIED = "Approval executable or path cannot be verified:";
const CWD = "Approval containment does not validate future call --dir values:";

let root: string;
let home: string;
let repo: string;
let tool: string;

const mk = (p: string, text = "", mode?: number): string => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (mode !== undefined) fs.chmodSync(p, mode);
  return p;
};

interface Proj { dir?: string; agentYaml?: string; extra?: string }
/** Write team.yaml and project.yaml files directly (no scaffold): `globals` are global agent blocks. */
function setup(projects: Record<string, Proj>, globals = ""): void {
  mk(path.join(home, "team.yaml"), `agents:${globals ? `\n${globals}` : " {}"}\n`);
  for (const [name, p] of Object.entries(projects)) {
    mk(path.join(home, "projects", name, "project.yaml"),
      `dir: ${p.dir ?? repo}\nteam:\n  lead: dev\nagents:\n  dev:\n    runtime: claude-code\n${p.agentYaml ?? ""}${p.extra ?? ""}`);
  }
}
const cfg = (command = tool, allow: unknown[] = [{ project: "p", agent: "dev" }], name = "x"): ExecutorsConfig => ({
  executors: { [name]: { command: [command], allow: allow as never, timeout_sec: 5, env: {}, expires_days: 7, max_pending: 10, max_payload_bytes: 4096 } },
  limits: { max_total_pending: 50, max_scan_entries: 200, retention_days: 90 },
});
const msgs = (c: ExecutorsConfig, o?: Parameters<typeof approvalContainmentChecks>[2]): string[] => approvalContainmentChecks(home, c, o).checks.map((x) => x.message);
const has = (all: string[], stem: string, ...parts: string[]): boolean => all.some((m) => m.startsWith(stem) && parts.every((p) => m.includes(p)));

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "approval-contain-")));
  home = path.join(root, "home");
  repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  tool = mk(path.join(root, "exec", "bin", "tool"), "#!/bin/sh\nexit 0\n", 0o755);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("clean configuration", () => {
  it("reports nothing for a project whose grants stay away from every protected path", () => {
    setup({ p: {} });
    expect(approvalContainmentChecks(home, cfg())).toEqual({ checks: [], calls: [] });
  });
  it("warns once about future call --dir values when a global agent exists, and returns the resolved call agents", () => {
    setup({ p: {} }, "  helper:\n    runtime: claude-code\n");
    const inv = approvalContainmentChecks(home, cfg());
    expect(inv.calls.map((c) => c.role)).toEqual(["helper"]);
    expect(inv.calls[0]?.agent.canEditAgentMd).toBe(false);
    expect(inv.checks.filter((c) => c.level === "warn").map((c) => c.message.startsWith(CWD))).toEqual([true]);
    expect(inv.checks.every((c) => c.subject === "approval")).toBe(true);
    expect(inv.checks.some((c) => c.level === "error")).toBe(false);
    expect(fs.existsSync(path.join(home, "calls"))).toBe(false);
  });
});

describe("protected kinds x grant kinds", () => {
  const protectedKinds: [string, () => string][] = [
    ["approvals/", () => path.join(home, "approvals")],
    ["requests/", () => path.join(home, "requests")],
    ["executors.yaml", () => path.join(home, "executors.yaml")],
    ["command", () => tool],
    ["command directory", () => path.dirname(tool)],
  ];
  const grantKinds: [string, (target: string) => { agentYaml?: string; dir?: string; globals?: string }][] = [
    ["sandbox.write", (t) => ({ agentYaml: `    sandbox:\n      write: ["${t}"]\n` })],
    ["memory dir (allowDirs)", (t) => ({ agentYaml: `    memory:\n      project: ${t}\n` })],
    ["agent_md with can_edit_agent_md (allowFiles)", (t) => ({ agentYaml: `    agent_md: ${t}\n    can_edit_agent_md: true\n` })],
    ["project dir", (t) => ({ dir: t })],
  ];
  for (const [pk, pathOf] of protectedKinds) {
    for (const [gk, build] of grantKinds) {
      it(`${gk} equal to ${pk}`, () => {
        const target = pathOf();
        setup({ p: build(target) });
        expect(has(msgs(cfg()), OVERLAP, "same path as", "Conservative overlap", "project \"p\"")).toBe(true);
      });
    }
  }
  it("an ancestor grant covers a protected path, a descendant grant lies inside it", () => {
    setup({ p: { agentYaml: `    sandbox:\n      write: ["${root}"]\n` } });
    expect(has(msgs(cfg()), OVERLAP, "lies inside", "sandbox.write")).toBe(true);
    setup({ p: { agentYaml: `    sandbox:\n      write: ["${path.join(home, "requests", "projects", "p")}"]\n` } });
    expect(has(msgs(cfg()), OVERLAP, "contains", "requests directory")).toBe(true);
  });
  it("a project with dir: ~ whose home holds the executor", () => {
    vi.stubEnv("HOME", path.join(root, "exec"));
    setup({ p: { dir: "\"~\"" } });
    expect(has(msgs(cfg()), OVERLAP, "project dir")).toBe(true);
  });
  it("a global agent run as a call", () => {
    setup({ p: {} }, `  helper:\n    runtime: claude-code\n    memory:\n      global: ${path.join(home, "approvals")}\n`);
    expect(has(msgs(cfg()), OVERLAP, "call agent \"helper\"", "write allowDirs")).toBe(true);
  });
  it("a fallback chain does not hide the grant, and the call does not choke on it", () => {
    setup({ p: { agentYaml: `    sandbox:\n      write: ["${path.join(home, "requests")}"]\n    fallback:\n      - runtime: codex\n` } });
    expect(has(msgs(cfg()), OVERLAP, "requests directory")).toBe(true);
  });
  it("a NON-enrolled sibling project's grant counts (D4)", () => {
    setup({ p: {}, other: { agentYaml: `    sandbox:\n      write: ["${path.join(home, "requests")}"]\n` } });
    const all = msgs(cfg());
    expect(has(all, OVERLAP, "project \"other\" agent \"dev\"")).toBe(true);
    expect(has(all, OVERLAP, "project \"p\" agent")).toBe(false);
  });
  it("a symlink alias to a protected directory is compared by its real path", () => {
    const link = path.join(root, "alias");
    fs.mkdirSync(path.join(home, "requests"), { recursive: true });
    fs.symlinkSync(path.join(home, "requests"), link);
    setup({ p: { agentYaml: `    sandbox:\n      write: ["${link}"]\n` } });
    expect(has(msgs(cfg()), OVERLAP, `canonical ${path.join(home, "requests")}`)).toBe(true);
  });
  it("/foo is not an ancestor of /foobar", () => {
    setup({ p: { agentYaml: `    sandbox:\n      write: ["${path.join(home, "requestsX")}", "${path.join(home, "approvals-old")}"]\n` } });
    expect(has(msgs(cfg()), OVERLAP)).toBe(false);
  });
  it("macOS comparison ignores case, Linux does not", () => {
    setup({ p: { agentYaml: `    sandbox:\n      write: ["${path.join(home, "REQUESTS")}"]\n` } });
    expect(has(msgs(cfg(), { platform: "darwin" }), OVERLAP, "requests directory")).toBe(true);
    expect(has(msgs(cfg(), { platform: "linux" }), OVERLAP)).toBe(false);
  });
});

describe("transient envelopes (D11)", () => {
  const put = (dir: string): string => mk(path.join(dir, "bin", "tool"), "#!/bin/sh\n", 0o755);
  it.each([
    ["task-memory", () => path.join(home, "projects", "p", "task-memory", "r1", "dev")],
    ["runs", () => path.join(home, "projects", "p", "runs", "r1", "mail", "outbox")],
    ["worktrees", () => path.join(home, "projects", "p", "worktrees", "r1", "dev")],
  ])("an executable under a run's %s", (setting, dir) => {
    setup({ p: {} });
    const exe = put(dir());
    expect(has(msgs(cfg(exe)), OVERLAP, `${setting} (conservative envelope)`)).toBe(true);
  });
  it("an executable under a sibling project's runs", () => {
    setup({ p: {}, q: {} });
    const exe = put(path.join(home, "projects", "q", "runs", "r9"));
    expect(has(msgs(cfg(exe)), OVERLAP, "project \"q\"", "runs (conservative envelope)")).toBe(true);
  });
  it("an executable under a real call id directory", () => {
    setup({ p: {} });
    const exe = put(path.join(home, "calls", "20260101-abc", "agents", "helper"));
    expect(has(msgs(cfg(exe)), OVERLAP, "calls root (conservative envelope)")).toBe(true);
  });
  it("an executable inside the git common dir of the project repo", () => {
    execFileSync("git", ["init", "-q", repo]);
    setup({ p: {} });
    const exe = put(path.join(repo, ".git", "hooks-x"));
    expect(has(msgs(cfg(exe)), OVERLAP, "git common dir (conservative envelope)")).toBe(true);
  });
  it("a linked worktree repo resolves the main repo's common dir", () => {
    const main = path.join(root, "main");
    execFileSync("git", ["init", "-q", main]);
    execFileSync("git", ["-C", main, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "i"]);
    const wt = path.join(root, "wt");
    execFileSync("git", ["-C", main, "worktree", "add", "-q", wt]);
    setup({ p: { dir: wt } });
    const exe = put(path.join(main, ".git", "worktrees", "wt", "x"));
    expect(has(msgs(cfg(exe)), OVERLAP, "git common dir")).toBe(true);
  });
  it("a symlink below an envelope is covered as its own grant", () => {
    setup({ p: {} });
    fs.mkdirSync(path.join(home, "projects", "p", "runs"), { recursive: true });
    fs.symlinkSync(path.dirname(tool), path.join(home, "projects", "p", "runs", "link"));
    expect(has(msgs(cfg()), OVERLAP, "runs alias (conservative envelope)")).toBe(true);
  });
});

describe("incomplete inventory is an error, never skipped", () => {
  it("a FIFO project.yaml does not hang", () => {
    setup({ p: {}, q: {} });
    const f = path.join(home, "projects", "q", "project.yaml");
    fs.rmSync(f);
    execFileSync("mkfifo", [f]);
    const all = msgs(cfg());
    expect(has(all, INCOMPLETE, "project \"q\"", f, "not a regular file")).toBe(true);
  }, 5000);
  it("an oversized project.yaml", () => {
    setup({ p: {}, q: {} });
    fs.appendFileSync(path.join(home, "projects", "q", "project.yaml"), `#${"x".repeat(1024 * 1024)}\n`);
    expect(has(msgs(cfg()), INCOMPLETE, "project \"q\"", "larger than")).toBe(true);
  });
  it("an invalid or symlinked project.yaml and a symlinked project directory", () => {
    setup({ p: {}, q: {}, r: {} });
    mk(path.join(home, "projects", "q", "project.yaml"), "dir: [\n");
    const real = path.join(root, "r-real");
    fs.renameSync(path.join(home, "projects", "r", "project.yaml"), path.join(root, "r.yaml"));
    fs.symlinkSync(path.join(root, "r.yaml"), path.join(home, "projects", "r", "project.yaml"));
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(home, "projects", "s"));
    const all = msgs(cfg());
    expect(has(all, INCOMPLETE, "project \"q\"", "not valid YAML")).toBe(true);
    expect(has(all, INCOMPLETE, "project \"r\"", "is a symlink")).toBe(true);
    expect(has(all, INCOMPLETE, "projects/s", "not a real directory")).toBe(true);
  });
  it("a missing, oversized or FIFO global team.yaml", () => {
    setup({ p: {} });
    fs.rmSync(path.join(home, "team.yaml"));
    expect(has(msgs(cfg()), INCOMPLETE, "global config", "is missing")).toBe(true);
    execFileSync("mkfifo", [path.join(home, "team.yaml")]);
    expect(has(msgs(cfg()), INCOMPLETE, "global config", "not a regular file")).toBe(true);
  }, 5000);
  it("allow entries that name no project, agent or call", () => {
    setup({ p: {} });
    const all = msgs(cfg(tool, [{ project: "nope", agent: "dev" }, { project: "p", agent: "ghost" }, { call: "nocall" }]));
    expect(has(all, INCOMPLETE, 'project "nope"')).toBe(true);
    expect(has(all, INCOMPLETE, 'agent "ghost"')).toBe(true);
    expect(has(all, INCOMPLETE, 'call "nocall"')).toBe(true);
  });
  it("a missing projects directory is simply empty", () => {
    mk(path.join(home, "team.yaml"), "agents: {}\n");
    expect(msgs(cfg(tool, [{ call: "x" }])).filter((m) => m.startsWith(INCOMPLETE)).length).toBe(1); // only the dangling call allow
  });
});

describe("executable and path uncertainty", () => {
  const run = (cmd: string): string[] => { setup({ p: {} }); return msgs(cfg(cmd)); };
  it("a missing command", () => expect(has(run(path.join(root, "nope")), UNVERIFIED, "missing")).toBe(true));
  it("a world-writable command file and a world-writable parent directory", () => {
    const f = mk(path.join(root, "w", "t"), "#!/bin/sh\n", 0o757);
    expect(has(run(f), UNVERIFIED, "world-writable")).toBe(true);
    const d = mk(path.join(root, "wd", "t"), "#!/bin/sh\n", 0o755);
    fs.chmodSync(path.dirname(d), 0o777);
    expect(has(run(d), UNVERIFIED, "directory", "world-writable")).toBe(true);
  });
  it("an env shebang, a relative shebang, a nested script interpreter, an overlong line", () => {
    expect(has(run(mk(path.join(root, "e", "t"), "#!/usr/bin/env sh\n", 0o755)), UNVERIFIED, "PATH")).toBe(true);
    expect(has(run(mk(path.join(root, "r", "t"), "#!sh\n", 0o755)), UNVERIFIED, "not an absolute path")).toBe(true);
    mk(path.join(root, "n", "inner"), "#!/bin/sh\n", 0o755);
    expect(has(run(mk(path.join(root, "n", "t"), `#!${path.join(root, "n", "inner")}\n`, 0o755)), UNVERIFIED, "nested")).toBe(true);
    expect(has(run(mk(path.join(root, "l", "t"), `#!/bin/sh ${"a".repeat(5000)}\n`, 0o755)), UNVERIFIED, "longer than")).toBe(true);
    expect(has(run(mk(path.join(root, "m", "t"), "#!/bin/sh -x -y\n", 0o755)), UNVERIFIED, "at most one argument")).toBe(true);
  });
  it("native binaries pass, unknown formats and non-executable files do not", () => {
    const elf = mk(path.join(root, "b", "t"), "", 0o755);
    fs.writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
    expect(run(elf)).toEqual([]);
    const macho = mk(path.join(root, "b2", "t"), "", 0o755);
    fs.writeFileSync(macho, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
    expect(run(macho)).toEqual([]);
    expect(has(run(mk(path.join(root, "u", "t"), "plain text", 0o755)), UNVERIFIED, "neither")).toBe(true);
    expect(has(run(mk(path.join(root, "x", "t"), "#!/bin/sh\n", 0o644)), UNVERIFIED, "not executable")).toBe(true);
  });
  it("a command that is a FIFO or a directory is never read", () => {
    const fifo = path.join(root, "ff");
    execFileSync("mkfifo", [fifo]);
    expect(has(run(fifo), UNVERIFIED)).toBe(true);
    expect(has(run(root), UNVERIFIED)).toBe(true);
  }, 5000);
  it("a symlinked command is followed to its real path, and both spellings are protected", () => {
    const link = path.join(root, "linkdir", "tool");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(tool, link);
    setup({ p: { agentYaml: `    sandbox:\n      write: ["${path.dirname(tool)}"]\n` } });
    expect(has(msgs(cfg(link)), OVERLAP, "real path")).toBe(true);
  });
  it("a direct interpreter is itself protected", () => {
    const interp = mk(path.join(root, "i", "interp"), "", 0o755);
    fs.writeFileSync(interp, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
    const script = mk(path.join(root, "s", "t"), `#!${interp}\n`, 0o755);
    setup({ p: { agentYaml: `    sandbox:\n      write: ["${path.dirname(interp)}"]\n` } });
    expect(has(msgs(cfg(script)), OVERLAP, "interpreter")).toBe(true);
  });
});

describe("determinism", () => {
  it("repeated runs give identical, sorted output with errors first", () => {
    setup({ p: { agentYaml: `    sandbox:\n      write: ["${path.join(home, "requests")}", "${path.join(home, "approvals")}"]\n` }, q: { dir: path.join(home) } }, "  helper:\n    runtime: claude-code\n");
    const a = approvalContainmentChecks(home, cfg()).checks;
    const b = approvalContainmentChecks(home, cfg()).checks;
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(2);
    const levels = a.map((c) => c.level);
    expect(levels).toEqual([...levels].sort((x, y) => (x === "error" ? -1 : 0) - (y === "error" ? -1 : 0)));
    const errs = a.filter((c) => c.level === "error").map((c) => c.message);
    expect(errs).toEqual([...errs].sort());
  });
});

// ---- Revision 1 (reviews 4f6799ae, 6a228ae7; decisions D18-D20) ----
const hasControl = (m: string): boolean => [...m].some((ch) => ch.charCodeAt(0) < 0x20 || (ch.charCodeAt(0) >= 0x7f && ch.charCodeAt(0) <= 0x9f));
const elf = (p: string): string => {
  mk(p, "", 0o755);
  fs.writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
  return p;
};

describe("symlink chains: every hop is protected (D18)", () => {
  const sym = (target: string, link: string): void => {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
  };
  it("P1: command -> repo/hop -> real, with the repo agent-writable", () => {
    const real = mk(path.join(root, "real", "exec"), "#!/bin/sh\n", 0o755);
    sym(real, path.join(repo, "hop"));
    sym(path.join(repo, "hop"), path.join(root, "bin", "exec"));
    setup({ p: {} });
    expect(has(msgs(cfg(path.join(root, "bin", "exec"))), OVERLAP, "symlink hop", "project dir")).toBe(true);
  });
  it("P1b: a directory component that is a hop through the repo", () => {
    mk(path.join(root, "real", "q", "exec"), "#!/bin/sh\n", 0o755);
    sym(path.join(root, "real"), path.join(repo, "dirhop"));
    sym(path.join(repo, "dirhop"), path.join(root, "p"));
    setup({ p: {} });
    expect(has(msgs(cfg(path.join(root, "p", "q", "exec"))), OVERLAP, "symlink hop")).toBe(true);
  });
  it("P1c: the shebang interpreter reached through a hop in the repo", () => {
    const interp = elf(path.join(root, "realint", "interp"));
    sym(interp, path.join(repo, "sh-hop"));
    sym(path.join(repo, "sh-hop"), path.join(root, "ibin", "interp"));
    const script = mk(path.join(root, "s", "t"), `#!${path.join(root, "ibin", "interp")}\n`, 0o755);
    setup({ p: {} });
    expect(has(msgs(cfg(script)), OVERLAP, "interpreter", "symlink hop")).toBe(true);
  });
  it("a store path (approvals/) that is itself a chain through the repo", () => {
    fs.mkdirSync(path.join(root, "realappr"));
    sym(path.join(root, "realappr"), path.join(repo, "appr-hop"));
    fs.mkdirSync(home, { recursive: true });
    sym(path.join(repo, "appr-hop"), path.join(home, "approvals"));
    setup({ p: {} });
    expect(has(msgs(cfg()), OVERLAP, "approvals directory symlink hop")).toBe(true);
  });
  it("a hop chain in a directory no agent can write is clean", () => {
    sym(tool, path.join(root, "links", "tool"));
    setup({ p: {} });
    expect(msgs(cfg(path.join(root, "links", "tool")))).toEqual([]);
  });
  it("a symlink loop cannot be verified", () => {
    sym(path.join(root, "b"), path.join(root, "a"));
    sym(path.join(root, "a"), path.join(root, "b"));
    setup({ p: {} });
    expect(has(msgs(cfg(path.join(root, "a"))), UNVERIFIED)).toBe(true);
  });
});

describe("alias walk follows directory targets (D18) and skips checkouts (D19)", () => {
  const sym = (target: string, link: string): void => {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
  };
  const runs = (): string => path.join(home, "projects", "p", "runs");
  it("runs/first -> outside, outside/mail/outbox/dev -> the executor's directory", () => {
    setup({ p: {} });
    const outside = path.join(root, "outside");
    sym(path.dirname(tool), path.join(outside, "mail", "outbox", "dev"));
    sym(outside, path.join(runs(), "first"));
    expect(has(msgs(cfg()), OVERLAP, "runs alias")).toBe(true);
  });
  it("cycles terminate without an error (a <-> b, and a directory linking to itself)", () => {
    setup({ p: {} });
    sym(path.join(runs(), "b"), path.join(runs(), "a"));
    sym(path.join(runs(), "a"), path.join(runs(), "b"));
    sym(path.join(runs(), "d"), path.join(runs(), "d", "loop"));
    const all = msgs(cfg());
    expect(has(all, INCOMPLETE)).toBe(false);
  });
  it("coverage that cannot be completed is a named incomplete-scan error", () => {
    setup({ p: {} });
    mk(path.join(runs(), ...Array.from({ length: 12 }, (_, i) => `d${i}`), "f"));
    expect(has(msgs(cfg()), INCOMPLETE, "cannot cover aliases below runs", "deeper")).toBe(true);
  });
  it("a worktree with more entries than the cap no longer makes the scan incomplete", () => {
    setup({ p: {} });
    const wt = path.join(home, "projects", "p", "worktrees", "r1", "dev");
    fs.mkdirSync(wt, { recursive: true });
    for (let i = 0; i < 20050; i++) fs.writeFileSync(path.join(wt, `f${i}`), "");
    expect(has(msgs(cfg()), INCOMPLETE)).toBe(false);
  }, 60000);
});

describe("message hygiene and hard links", () => {
  it("P3: control characters in an alias name are escaped", () => {
    setup({ p: {} });
    fs.mkdirSync(path.join(home, "approvals"), { recursive: true });
    const dir = path.join(home, "projects", "p", "task-memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(home, "approvals"), path.join(dir, "a\r\u001b[2K\u001b[1A\nOK fake line"));
    const all = msgs(cfg());
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) expect(hasControl(m)).toBe(false);
    expect(all.some((m) => m.includes("\\u001b"))).toBe(true);
  });
  it("control characters in a shebang interpreter are escaped", () => {
    setup({ p: {} });
    const all = msgs(cfg(mk(path.join(root, "e2", "t"), "#!rel\u001b[2Kx\n", 0o755)));
    expect(all.some((m) => m.startsWith(UNVERIFIED))).toBe(true);
    for (const m of all) expect(hasControl(m)).toBe(false);
  });
  it("P5: a command or interpreter with another hard link cannot be verified", () => {
    setup({ p: {} });
    fs.linkSync(tool, path.join(repo, "exec-hl"));
    expect(has(msgs(cfg()), UNVERIFIED, "hard link")).toBe(true);
    const interp = elf(path.join(root, "hi", "interp"));
    fs.linkSync(interp, path.join(repo, "interp-hl"));
    const script = mk(path.join(root, "hs", "t"), `#!${interp}\n`, 0o755);
    expect(has(msgs(cfg(script)), UNVERIFIED, "interpreter", "hard link")).toBe(true);
  });
});

describe("'.', '..' and empty components in a spelling fail closed (D21)", () => {
  const REASON = "path contains '.' or '..' components";
  /** safe/link -> repo/hop -> real/dir, with the repo agent-writable: `safe/link/../x` really names real/x. */
  const chain = (): void => {
    fs.mkdirSync(path.join(root, "real", "dir"), { recursive: true });
    fs.symlinkSync(path.join(root, "real", "dir"), path.join(repo, "hop"));
    fs.mkdirSync(path.join(root, "safe"), { recursive: true });
    fs.symlinkSync(path.join(repo, "hop"), path.join(root, "safe", "link"));
  };
  it("a command spelled safe/link/../exec", () => {
    chain();
    mk(path.join(root, "real", "exec"), "#!/bin/sh\n", 0o755);
    setup({ p: {} });
    const all = msgs(cfg(`${root}/safe/link/../exec`));
    expect(has(all, UNVERIFIED, REASON, "safe/link/../exec")).toBe(true);
  });
  it("an interpreter spelled safe/link/../sh", () => {
    chain();
    elf(path.join(root, "real", "sh"));
    const script = mk(path.join(root, "s", "t"), `#!${root}/safe/link/../sh\n`, 0o755);
    setup({ p: {} });
    expect(has(msgs(cfg(script)), UNVERIFIED, REASON, "interpreter")).toBe(true);
  });
  it("a ./ component and a // component", () => {
    setup({ p: {} });
    expect(has(msgs(cfg(`${path.dirname(tool)}/./tool`)), UNVERIFIED, REASON)).toBe(true);
    expect(has(msgs(cfg(`${path.dirname(tool)}//tool`)), UNVERIFIED, REASON)).toBe(true);
  });
  it("the home used for the store paths", () => {
    setup({ p: {} });
    const dotted = `${root}/home/../home`;
    const all = approvalContainmentChecks(dotted, cfg()).checks.map((c) => c.message);
    expect(has(all, UNVERIFIED, REASON, "home")).toBe(true);
  });
  it("the offending path is escaped, and a plain absolute path still passes", () => {
    setup({ p: {} });
    expect(has(msgs(cfg(`${root}/a\u001b[2K/../x`)), UNVERIFIED, "\\u001b")).toBe(true);
    expect(msgs(cfg())).toEqual([]);
  });
});
