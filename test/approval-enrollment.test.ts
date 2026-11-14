import { describe, expect, it } from "vitest";
import { applyEnrollment, enrolled } from "../src/approval-enrollment.js";
import type { ExecutorConfig, ExecutorsConfig } from "../src/approval-executors.js";
import type { ResolvedAgent, ResolvedProject } from "../src/config.js";

const exec = (allow: ExecutorConfig["allow"]): ExecutorConfig => ({
  command: ["/bin/x"], allow, timeout_sec: 5, env: {}, expires_days: 7, max_pending: 10, max_payload_bytes: 4096,
});
const cfg = (executors: Record<string, ExecutorConfig>): ExecutorsConfig => ({
  executors, limits: { max_total_pending: 50, max_scan_entries: 200, retention_days: 90 },
});
const agent = (name: string, extra: Partial<ResolvedAgent> = {}): ResolvedAgent => ({ name, ...extra }) as ResolvedAgent;
const project = (agents: Record<string, ResolvedAgent>): ResolvedProject => ({ name: "p", agents }) as unknown as ResolvedProject;

describe("enrolled", () => {
  const c = cfg({ a: exec([{ project: "p", agent: "dev" }]), b: exec([{ project: "p", agent: "qa" }, { call: "helper" }]) });
  const agents = { dev: agent("dev"), qa: agent("qa"), "dev--2": agent("dev--2", { instance: { role: "dev", k: 2 } }), other: agent("other") };
  it("matches union members by project", () => {
    expect(enrolled({ project: "p" }, agents, "dev", c)).toBe(true);
    expect(enrolled({ project: "p" }, agents, "qa", c)).toBe(true);
    expect(enrolled({ project: "p" }, agents, "other", c)).toBe(false);
  });
  it("excludes the same name in another project", () => {
    expect(enrolled({ project: "q" }, agents, "dev", c)).toBe(false);
  });
  it("call identity matches only call entries", () => {
    expect(enrolled({ project: null }, { helper: agent("helper") }, "helper", c)).toBe(true);
    expect(enrolled({ project: null }, agents, "dev", c)).toBe(false);
    expect(enrolled({ project: "p" }, { helper: agent("helper") }, "helper", c)).toBe(false);
  });
  it("bound instances map to their role; a literal suffix name does not", () => {
    expect(enrolled({ project: "p" }, agents, "dev--2", c)).toBe(true);
    expect(enrolled({ project: "p" }, { ...agents, "dev--3": agent("dev--3") }, "dev--3", c)).toBe(false);
  });
  it("absent config is never enrolled", () => {
    expect(enrolled({ project: "p" }, agents, "dev", null)).toBe(false);
  });
});

describe("applyEnrollment", () => {
  const c = cfg({ a: exec([{ project: "p", agent: "dev" }]) });
  it("flags members, omits the property elsewhere, and does not mutate the input", () => {
    const p = project({ dev: agent("dev"), qa: agent("qa", { enrolled: true }), "dev--2": agent("dev--2", { instance: { role: "dev", k: 2 } }) });
    const snapshot = JSON.stringify(p);
    const out = applyEnrollment(p, { project: "p" }, c);
    expect(JSON.stringify(p)).toBe(snapshot);
    expect(out).not.toBe(p);
    expect(out.agents.dev?.enrolled).toBe(true);
    expect(out.agents["dev--2"]?.enrolled).toBe(true);
    expect("enrolled" in (out.agents.qa as object)).toBe(false);
    expect(p.agents.qa?.enrolled).toBe(true);
  });
  it("null config clears stale flags", () => {
    const out = applyEnrollment(project({ dev: agent("dev", { enrolled: true }) }), { project: "p" }, null);
    expect("enrolled" in (out.agents.dev as object)).toBe(false);
  });
  it("call identity", () => {
    const cc = cfg({ a: exec([{ call: "dev" }]) });
    const out = applyEnrollment(project({ dev: agent("dev") }), { project: null }, cc);
    expect(out.agents.dev?.enrolled).toBe(true);
    expect(applyEnrollment(project({ dev: agent("dev") }), { project: "p" }, cc).agents.dev?.enrolled).toBeUndefined();
  });
});
