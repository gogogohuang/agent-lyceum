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
