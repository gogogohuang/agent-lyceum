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
  it("network requested -> all; local_binding and unix_sockets are not applied", () => {
    expect(sandboxCaps(agent(sb({ network: ["a.com"], localBinding: true, unixSockets: ["/s"] })))).toEqual({ network: "all", localBinding: false, unixSockets: false });
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
  it("explains cursor limits in Cursor wording, not Codex", () => {
    env = makeEnv();
    const p = env.project();
    const a = { ...p.agents["fe-member"]!, runtime: "cursor" as const, sandbox: sb({ network: ["a.com"], localBinding: true, unixSockets: ["/tmp/s.sock"] }) };
    const e = enforcementFor(p, a);
    const text = e.notes.join("\n");
    expect(e.runtime).toBe("cursor");
    expect(text).toContain("Cursor");
    expect(text).not.toMatch(/codex/i);
    expect(text).toContain("cursor: all hosts");
    expect(text).toContain("all-or-nothing on Cursor");
    expect(text).toContain("local_binding: requested, not supported by cursor");
    expect(text).toContain("not applied by cursor");
    expect(e.repoInstructions).toBe("post-hoc");
  });
});
