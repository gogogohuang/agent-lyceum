import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedAgent } from "../src/config.js";
import { enforcementFor, sandboxCaps, setOsSandboxForTest } from "../src/policy.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => setOsSandboxForTest(true));
afterEach(() => {
  setOsSandboxForTest(undefined);
  env?.cleanup();
});

const sb = (x: Partial<NonNullable<ResolvedAgent["sandbox"]>>) => ({ write: [], network: [], localBinding: false, unixSockets: [], ...x });
const agent = (sandbox: ResolvedAgent["sandbox"]) => ({ name: "a", runtime: "cursor", sandbox }) as unknown as ResolvedAgent;

describe("sandboxCaps for cursor", () => {
  it("network, local_binding and unix_sockets are never applied", () => {
    expect(sandboxCaps(agent(sb({ network: ["a.com"], localBinding: true, unixSockets: ["/s"] })))).toEqual({ network: "none", localBinding: false, unixSockets: false });
  });
  it("no network requested -> none", () => {
    expect(sandboxCaps(agent(sb({})))).toEqual({ network: "none", localBinding: false, unixSockets: false });
  });
  it("without an OS sandbox nothing is applied", () => {
    setOsSandboxForTest(false);
    expect(sandboxCaps(agent(sb({ network: ["a.com"] })))).toEqual({ network: "none", localBinding: false, unixSockets: false });
  });
});

describe("enforcementFor cursor", () => {
  it("uses tool-rules (not os) and explains Cursor limits without Codex wording", () => {
    env = makeEnv();
    const p = env.project();
    const a = { ...p.agents["fe-member"]!, runtime: "cursor" as const, sandbox: sb({ network: ["a.com"], localBinding: true, unixSockets: ["/tmp/s.sock"] }) };
    const e = enforcementFor(p, a);
    const text = e.notes.join("\n");
    expect(e.runtime).toBe("cursor");
    // Cursor permissions + --sandbox are not Claude/Codex OS per-path enforcement; strict must not treat them as "os".
    expect(e.memory).toBe("tool-rules");
    expect(e.agentMd).toBe("tool-rules");
    expect(e.otherContext).toBe("tool-rules");
    expect(e.shared).toBe("tool-rules");
    expect(e.repoInstructions).toBe("post-hoc");
    expect(text).toContain("Cursor");
    expect(text).not.toMatch(/codex/i);
    expect(text).toContain("network: a.com (not applied by cursor)");
    expect(text).not.toContain("all hosts");
    expect(text).not.toContain("all-or-nothing");
    expect(text).toContain("local_binding: requested, not supported by cursor");
    expect(text).toContain("not applied by cursor");
  });
});

describe("cursor sandbox reporting and protected paths", () => {
  it("never reports an OS sandbox, network setting or sockets for a cursor agent", async () => {
    setOsSandboxForTest(true);
    const { invokeWithSandboxChecks } = await import("../src/sandbox-invocation.js");
    const env = makeEnv();
    try {
      const p = env.project();
      const a = { ...p.agents["fe-member"]!, runtime: "cursor" as const, sandbox: sb({}) } as unknown as ResolvedAgent;
      const events: Record<string, unknown>[] = [];
      await invokeWithSandboxChecks(async () => ({ ok: true, text: "", exitCode: 0, timedOut: false }), { project: p, agent: a, workDir: env.root, systemPrompt: "", userPrompt: "", timeoutSec: 1 }, a, { event: (_n, f) => events.push(f) }, 1);
      expect(events[0]?.applied).toEqual({ write: "tool-rules", network: "unrestricted", local_binding: "unrestricted", unix_sockets: "unrestricted" });
    } finally {
      env.cleanup();
      setOsSandboxForTest(undefined);
    }
  });

  it("protects the Cursor config dir like ~/.claude and ~/.codex", async () => {
    const { protectedPathsFor } = await import("../src/sandbox-invocation.js");
    const { canonicalPath } = await import("../src/paths.js");
    const env = makeEnv();
    const prev = process.env.CURSOR_CONFIG_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-cfg-"));
    process.env.CURSOR_CONFIG_DIR = dir;
    try {
      const p = env.project();
      expect(protectedPathsFor(p, p.agents["fe-member"]!, false).map((x) => x.path)).toContain(canonicalPath(dir));
    } finally {
      if (prev === undefined) delete process.env.CURSOR_CONFIG_DIR;
      else process.env.CURSOR_CONFIG_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
      env.cleanup();
    }
  });
});
