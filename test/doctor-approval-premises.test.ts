import { describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ armed: false }));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  const wrap = <T extends (...a: never[]) => unknown>(f: T): T =>
    ((...a: never[]) => { if (guard.armed) throw new Error("fs touched"); return f(...a); }) as T;
  const w = Object.fromEntries(Object.entries(real).map(([k, v]) => [k, typeof v === "function" ? wrap(v as never) : v]));
  return { ...w, default: { ...real, ...w } };
});

import type { ExecutorConfig, ExecutorsConfig } from "../src/approval-executors.js";
import type { ResolvedAgent, ResolvedProject } from "../src/config.js";
import { agentPremiseChecks, projectPremiseChecks } from "../src/doctor-approval-premises.js";
import { AgentPartial, ProjectConfig } from "../src/schema.js";

const ok = { platform: "darwin" as const, sandboxAvailable: () => true };
const exec = (allow: ExecutorConfig["allow"]): ExecutorConfig => ({ command: ["/bin/x"], allow, timeout_sec: 5, env: {}, expires_days: 7, max_pending: 10, max_payload_bytes: 4096 });
const cfg = (...allows: ExecutorConfig["allow"][]): ExecutorsConfig => ({
  executors: Object.fromEntries(allows.map((a, i) => [`e${i}`, exec(a)])),
  limits: { max_total_pending: 50, max_scan_entries: 200, retention_days: 90 },
});
const ag = (name: string, x: Partial<ResolvedAgent> = {}): ResolvedAgent =>
  ({ name, runtime: "claude-code", canEditAgentMd: false, fallback: [], ...x }) as ResolvedAgent;
const sb = (x: Partial<NonNullable<ResolvedAgent["sandbox"]>>) => ({ write: [], network: [], localBinding: false, unixSockets: [], ...x });
const proj = (agents: Record<string, ResolvedAgent>, x: Record<string, unknown> = {}): ResolvedProject =>
  ({ name: "X", lead: "lead", dispatcher: { max_instances: 1 }, agents, ...x }) as unknown as ResolvedProject;
const msgs = (c: { message: string }[]) => c.map((x) => x.message);
const has = (c: { message: string }[], stem: string) => c.filter((x) => x.message.startsWith(stem));

describe("agentPremiseChecks", () => {
  it("clean agent passes", () => expect(agentPremiseChecks("X/a", ag("a"), ok)).toEqual([]));
  it("win32 errors", () => {
    const r = has(agentPremiseChecks("X/a", ag("a"), { ...ok, platform: "win32" }), "Approval enrollment is unsupported on Windows:");
    expect(r).toHaveLength(1); expect(r[0]?.level).toBe("error");
  });
  it("sandbox probe false errors and names bwrap-only", () => {
    const r = has(agentPremiseChecks("X/a", ag("a"), { ...ok, sandboxAvailable: () => false }), "Approval enrollment requires an OS sandbox:");
    expect(r).toHaveLength(1); expect(r[0]?.message).toMatch(/only the presence of bwrap/);
  });
  const keys: [string, Partial<ResolvedAgent>, string][] = [
    ["unix_sockets", { sandbox: sb({ unixSockets: ["/s"] }) }, "Approval-enrolled candidate permits sandbox.unix_sockets:"],
    ["network", { sandbox: sb({ network: ["h"] }) }, "Approval-enrolled candidate permits sandbox.network:"],
    ["local_binding", { sandbox: sb({ localBinding: true }) }, "Approval-enrolled candidate permits sandbox.local_binding:"],
    ["allow_web search", { allowWeb: "search" }, "Approval-enrolled candidate permits allow_web"],
    ["allow_web fetch", { allowWeb: "fetch" }, "Approval-enrolled candidate permits allow_web"],
  ];
  for (const [n, extra, stem] of keys) {
    it(`premise 3 ${n}: primary fails`, () => {
      const r = has(agentPremiseChecks("X/a", ag("a", extra), ok), stem);
      expect(r).toHaveLength(1); expect(r[0]?.level).toBe("error"); expect(r[0]?.message).toContain("(primary)");
    });
    it(`premise 3 ${n}: effective via fallback candidate fails`, () => {
      // primary clean on a different model key; the shared fallback entry inherits the grant
      const a = ag("a", { ...extra, fallback: [{ runtime: "claude-code", model: "other" }] as never });
      const r = has(agentPremiseChecks("X/a", a, ok), stem);
      expect(r.map((x) => x.message.includes("(fallback)"))).toContain(true);
    });
  }
  it("premise 3 effective false/empty passes (D9)", () => {
    expect(agentPremiseChecks("X/a", ag("a", { sandbox: sb({}), allowWeb: "none" }), ok)).toEqual([]);
  });
  it("Codex primary fails", () => {
    const r = has(agentPremiseChecks("X/a", ag("a", { runtime: "codex" }), ok), "Approval-enrolled candidate uses Codex:");
    expect(r).toHaveLength(1);
  });
  it("Codex only as fallback fails even with web none", () => {
    const a = ag("a", { fallback: [{ runtime: "codex", model: "m" }] as never });
    const r = has(agentPremiseChecks("X/a", a, ok), "Approval-enrolled candidate uses Codex:");
    expect(r).toHaveLength(1); expect(r[0]?.message).toContain("(fallback)");
  });
  it("Claude-only chain passes premise 4", () => {
    expect(has(agentPremiseChecks("X/a", ag("a", { fallback: [{ runtime: "claude-code", model: "m" }] as never }), ok), "Approval-enrolled candidate uses Codex")).toEqual([]);
  });
  it("can_edit_agent_md warns", () => {
    const r = agentPremiseChecks("X/a", ag("a", { canEditAgentMd: true }), ok);
    expect(r).toHaveLength(1); expect(r[0]).toMatchObject({ level: "warn", subject: "approval" });
    expect(r[0]?.message).toMatch(/^Approval-enrolled agent has can_edit_agent_md:/);
  });
});

describe("projectPremiseChecks", () => {
  const c = cfg([{ project: "X", agent: "dev" }]);
  it("no enrolled agent: nothing but clashes", () => {
    expect(projectPremiseChecks(proj({ lead: ag("lead"), dev: ag("dev") }), cfg([{ project: "Y", agent: "zzz" }]), ok)).toEqual([]);
  });
  it("enrolled clean project: only the open_pr warning", () => {
    const r = projectPremiseChecks(proj({ lead: ag("lead"), dev: ag("dev") }), c, ok);
    expect(msgs(r)).toHaveLength(1);
    expect(r[0]).toMatchObject({ level: "warn", subject: "approval" });
    expect(r[0]?.message).toMatch(/^Approval-enrolled project lead may request open_pr:/);
  });
  it("open_pr warns once with two enrolled members and a non-enrolled lead", () => {
    const r = projectPremiseChecks(proj({ lead: ag("lead"), dev: ag("dev"), qa: ag("qa") }), cfg([{ project: "X", agent: "dev" }, { project: "X", agent: "qa" }]), ok);
    expect(has(r, "Approval-enrolled project lead may request open_pr:")).toHaveLength(1);
  });
  it("verify.commands: one errors, empty/absent passes", () => {
    const base = { lead: ag("lead"), dev: ag("dev") };
    const v = (commands: unknown[]) => projectPremiseChecks(proj(base, { verify: { max_rejections: 2, commands } }), c, ok);
    const bad = has(v([{ name: "t", run: "x", timeout_sec: 1 }]), "Approval-enrolled project has verify.commands:");
    expect(bad).toHaveLength(1); expect(bad[0]?.level).toBe("error");
    expect(has(v([]), "Approval-enrolled project has verify.commands:")).toEqual([]);
    expect(has(projectPremiseChecks(proj(base), c, ok), "Approval-enrolled project has verify.commands:")).toEqual([]);
  });
  it("verify.commands without an enrolled agent does not error", () => {
    const r = projectPremiseChecks(proj({ lead: ag("lead") }, { verify: { max_rejections: 2, commands: [{ name: "t", run: "x", timeout_sec: 1 }] } }), c, ok);
    expect(r).toEqual([]);
  });
  const cap = (d: Record<string, unknown>) => has(projectPremiseChecks(proj({ lead: ag("lead"), dev: ag("dev") }, { dispatcher: d }), c, ok), "Approval-enrolled role has effective instance cap 1:");
  it("max_instances: 1 passes; 2 and omitted warn", () => {
    expect(cap({ max_instances: 1 })).toEqual([]);
    expect(cap({ max_instances: 2 })).toHaveLength(1);
    const o = cap({});
    expect(o).toHaveLength(1); expect(o[0]?.level).toBe("warn"); expect(o[0]?.message).toContain("default 4");
  });
  it("runs agent checks only for enrolled agents, labelled by project", () => {
    const bad = ag("x", { sandbox: sb({ network: ["h"] }) });
    const r = projectPremiseChecks(proj({ lead: ag("lead"), dev: ag("dev", { allowWeb: "fetch" }), other: bad }), c, ok);
    expect(has(r, "Approval-enrolled candidate permits allow_web")).toHaveLength(1);
    expect(has(r, "Approval-enrolled candidate permits allow_web")[0]?.message).toContain("X/dev");
    expect(has(r, "Approval-enrolled candidate permits sandbox.network:")).toEqual([]);
  });
  it("instance names use roleOfName: enrolled role covers dev--2", () => {
    const agents = { lead: ag("lead"), dev: ag("dev"), "dev--2": ag("dev--2", { allowWeb: "search", instance: { role: "dev", k: 2 } }) };
    const r = has(projectPremiseChecks(proj(agents), c, ok), "Approval-enrolled candidate permits allow_web");
    expect(r).toHaveLength(1); expect(r[0]?.message).toContain("X/dev--2");
  });
  it("clash: allow names role in project Y; X's role stays unflagged", () => {
    const r = projectPremiseChecks(proj({ lead: ag("lead"), a: ag("a", { allowWeb: "fetch" }) }), cfg([{ project: "Y", agent: "a" }]), ok);
    expect(msgs(r)).toEqual([expect.stringMatching(/^Agent is not approval-enrolled despite matching an enrolled role name: X\/a/)]);
    expect(r[0]?.level).toBe("warn");
  });
  it("clash: call allow names the role; bound instance dedupes to its role", () => {
    const agents = { lead: ag("lead"), a: ag("a"), "a--2": ag("a--2", { instance: { role: "a", k: 2 } }) };
    const r = has(projectPremiseChecks(proj(agents), cfg([{ call: "a" }]), ok), "Agent is not approval-enrolled despite");
    expect(r).toHaveLength(1);
  });
  it("no clash for a role enrolled in X itself or an unrelated name", () => {
    expect(has(projectPremiseChecks(proj({ lead: ag("lead"), dev: ag("dev") }), cfg([{ project: "X", agent: "dev" }, { project: "Y", agent: "dev" }]), ok), "Agent is not approval-enrolled")).toEqual([]);
  });
});

describe("purity and schema", () => {
  it("touches no fs", () => {
    guard.armed = true;
    try {
      agentPremiseChecks("X/a", ag("a", { canEditAgentMd: true }), ok);
      projectPremiseChecks(proj({ lead: ag("lead"), dev: ag("dev") }, { dispatcher: {} }), cfg([{ project: "X", agent: "dev" }, { call: "lead" }]), ok);
    } finally { guard.armed = false; }
  });
  it("strict schema cannot express a sandbox bypass (premise 4 flags)", () => {
    for (const bad of [{ dangerously_skip_permissions: true }, { sandbox_mode: "danger-full-access" }, { args: ["--dangerously-bypass-approvals-and-sandbox"] }, { bypass: true }]) {
      expect(AgentPartial.safeParse(bad).success).toBe(false);
    }
    expect(ProjectConfig.safeParse({ dir: "/x", agents: { a: { sandbox_mode: "none" } } }).success).toBe(false);
  });
});
