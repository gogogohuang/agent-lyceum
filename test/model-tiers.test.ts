import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flattenResolved, resolveProject, resolveProjectWithSources } from "../src/config.js";
import { TIERS, type Tier } from "../src/schema.js";
import { availableTiers, effectiveTier, isTier, modelForTier, tierFlag, wakeTier } from "../src/tiers.js";
import { validateProject } from "../src/validate.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const CC = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
const issues = (e: TestEnv, level: "error" | "warn") => validateProject(e.project()).issues.filter((i) => i.level === level).map((i) => i.message);
const editGlobal = (e: TestEnv, fn: (t: string) => string) => {
  const f = path.join(e.home, "team.yaml");
  fs.writeFileSync(f, fn(fs.readFileSync(f, "utf8")));
};
const setModels = (e: TestEnv, model: string) => editGlobal(e, (t) => t.replaceAll("    runtime: claude-code", `    runtime: claude-code\n    model: ${model}`));

describe("T-1 modelForTier", () => {
  // [ladder length, ceiling position] -> expected index for low/mid/high
  const L = ["L0", "L1", "L2", "L3"];
  const rows: [number, number, number, number, number][] = [
    [1, 0, 0, 0, 0], [2, 0, 0, 0, 0], [2, 1, 0, 1, 1], [3, 0, 0, 0, 0], [3, 1, 0, 1, 1], [3, 2, 0, 1, 2],
    [4, 0, 0, 0, 0], [4, 1, 0, 1, 1], [4, 2, 0, 1, 2], [4, 3, 0, 2, 3],
  ];
  for (const [len, cap, lo, mid, hi] of rows) {
    it(`ladder ${len}, ceiling L${cap}`, () => {
      const ladder = L.slice(0, len);
      const a = availableTiers(ladder, ladder[cap]);
      const tiers = a ?? [ladder[cap] as string]; // length-1 availability is "no tiers": the ceiling alone
      expect(modelForTier(tiers, "low")).toBe(L[lo]);
      expect(modelForTier(tiers, "mid")).toBe(L[mid]);
      expect(modelForTier(tiers, "high")).toBe(L[hi]);
    });
  }
});

describe("T-2 availableTiers", () => {
  it("is the ladder prefix up to the ceiling", () => expect(availableTiers(CC, "claude-sonnet-5-5")).toEqual(CC.slice(0, 2)));
  it("ignores case and whitespace", () => expect(availableTiers(CC, " Claude-Opus-5-5 ")).toEqual(CC));
  it("is undefined without model, ladder, or when the ceiling is not on it or is the lowest", () => {
    expect(availableTiers(CC, undefined)).toBeUndefined();
    expect(availableTiers(undefined, "claude-opus-5-5")).toBeUndefined();
    expect(availableTiers([], "claude-opus-5-5")).toBeUndefined();
    expect(availableTiers(CC, "claude-fable-5-1")).toBeUndefined();
    expect(availableTiers(CC, "claude-haiku-5-5")).toBeUndefined();
  });
});

describe("T-3 validation", () => {
  it("accepts a good ladder and reports nothing", () => {
    env = makeEnv();
    editGlobal(env, (t) => `model_tiers:\n  claude-code: [${CC.join(", ")}]\n${t}`);
    setModels(env, "claude-opus-5-5");
    expect(issues(env, "error")).toEqual([]);
    expect(issues(env, "warn")).toEqual([]);
  });
  it("rejects an entry of the other runtime, a duplicate, and a model off the ladder (exact texts)", () => {
    env = makeEnv();
    editGlobal(env, (t) => `model_tiers:\n  claude-code: [claude-haiku-5-5, gpt-6.1-mini, " Claude-Haiku-5-5 "]\n${t}`);
    setModels(env, "claude-opus-5-5");
    const e = issues(env, "error");
    expect(e).toContain('model_tiers.claude-code[1]: "gpt-6.1-mini" is not a claude-code model (recognised as codex). List only claude-code models, lowest first.');
    expect(e).toContain('model_tiers.claude-code: "Claude-Haiku-5-5" is listed twice.');
    expect(e).toContain(
      'Agent "lead": model "claude-opus-5-5" is not on model_tiers.claude-code (claude-haiku-5-5, gpt-6.1-mini, Claude-Haiku-5-5). Add it to the ladder, or set model_tiers.claude-code: [] in project.yaml to turn the ladder off for this project.',
    );
  });
  it("says 'nothing' for an unrecognised entry", () => {
    env = makeEnv();
    editGlobal(env, (t) => `model_tiers:\n  claude-code: [mystery]\n${t}`);
    expect(issues(env, "error")).toContain('model_tiers.claude-code[0]: "mystery" is not a claude-code model (recognised as nothing). List only claude-code models, lowest first.');
  });
  it("warns for an agent without model and when no member can go lower", () => {
    env = makeEnv();
    editGlobal(env, (t) => `model_tiers:\n  claude-code: [${CC.join(", ")}]\n${t}`);
    const w = issues(env, "warn");
    expect(w).toContain(`Agent "fe-member" has no model, so model_tiers.claude-code does not apply to it: it always runs on its runtime's default model.`);
    expect(w).toContain("model_tiers is set, but no member can run below its model (each member's model is the lowest entry of its ladder): tiers have no effect.");
  });
  it("project `[]` turns the team ladder off without error", () => {
    env = makeEnv();
    editGlobal(env, (t) => `model_tiers:\n  claude-code: [${CC.join(", ")}]\n${t}`);
    setModels(env, "claude-fable-5-1");
    expect(issues(env, "error").join("\n")).toMatch(/is not on model_tiers\.claude-code/);
    env.editProjectYaml((t) => `model_tiers:\n  claude-code: []\n${t}`);
    expect(issues(env, "error")).toEqual([]);
    expect(issues(env, "warn")).toEqual([]);
  });
});

describe("T-4 merge and sources", () => {
  it("team ladder applies; per-agent tiers are the prefix", () => {
    env = makeEnv();
    editGlobal(env, (t) => `model_tiers:\n  claude-code: [${CC.join(", ")}]\n${t}`);
    editGlobal(env, (t) => t.replace("  fe-member:\n    runtime: claude-code", "  fe-member:\n    runtime: claude-code\n    model: claude-sonnet-5-5"));
    const p = env.project();
    expect(p.modelTiers).toEqual({ "claude-code": CC });
    expect(p.agents["fe-member"].tiers).toEqual(CC.slice(0, 2));
    expect(p.agents.lead.tiers).toBeUndefined();
    const { sources } = resolveProjectWithSources(env.home, "demo");
    expect(sources["model_tiers.claude-code"]).toEqual({ file: path.join(env.home, "team.yaml"), key: "model_tiers.claude-code" });
    expect(flattenResolved(p)["model_tiers.claude-code"]).toEqual(CC);
  });
  it("project replaces the team ladder for that runtime, and sources point at project.yaml", () => {
    env = makeEnv();
    editGlobal(env, (t) => `model_tiers:\n  claude-code: [${CC.join(", ")}]\n${t}`);
    env.editProjectYaml((t) => `model_tiers:\n  claude-code: [claude-haiku-5-5, claude-opus-5-5]\n${t}`);
    const { project, sources } = resolveProjectWithSources(env.home, "demo");
    expect(project.modelTiers["claude-code"]).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    expect(sources["model_tiers.claude-code"]).toEqual({ file: project.paths.config, key: "model_tiers.claude-code" });
  });
  it("project `[]` removes the ladder and its source line", () => {
    env = makeEnv();
    editGlobal(env, (t) => `model_tiers:\n  claude-code: [${CC.join(", ")}]\n${t}`);
    env.editProjectYaml((t) => `model_tiers:\n  claude-code: []\n${t}`);
    const { project, sources } = resolveProjectWithSources(env.home, "demo");
    expect(project.modelTiers).toEqual({});
    expect(sources["model_tiers.claude-code"]).toBeUndefined();
    expect(flattenResolved(project)["model_tiers.claude-code"]).toBeUndefined();
  });
  it("a config with no model_tiers resolves and flattens exactly as before (no new keys)", () => {
    env = makeEnv();
    const p = env.project();
    expect(p.modelTiers).toEqual({});
    expect(Object.keys(flattenResolved(p)).filter((k) => k.includes("tier"))).toEqual([]);
    expect(Object.keys(resolveProjectWithSources(env.home, "demo").sources).filter((k) => k.includes("tier"))).toEqual([]);
    expect(Object.values(p.agents).every((a) => !("tiers" in a))).toBe(true);
    expect(resolveProject(env.home, "demo").agents.lead.sources).not.toHaveProperty("model_tiers");
  });
  it("rejects an unknown runtime key under model_tiers (strict)", () => {
    env = makeEnv();
    editGlobal(env, (t) => `model_tiers:\n  gemini: [x]\n${t}`);
    expect(() => env.project()).toThrow(/Unrecognized key/);
  });
});

describe("T-5 tierFlag and batch helpers", () => {
  const base = { senderIsLead: true, type: "task", recipientTiers: CC };
  it("follows the table in order", () => {
    for (const v of [undefined, null, ""]) expect(tierFlag({ ...base, value: v })).toBe("absent");
    expect(tierFlag({ ...base, value: "low", senderIsLead: false })).toEqual({ ignored: "not-lead" });
    for (const v of ["High", 1, true]) expect(tierFlag({ ...base, value: v })).toBe("invalid");
    expect(tierFlag({ ...base, value: "low", type: "reply" })).toEqual({ ignored: "not-a-task" });
    expect(tierFlag({ ...base, value: "low", recipientTiers: undefined })).toEqual({ ignored: "no-tiers" });
    for (const t of TIERS) expect(tierFlag({ ...base, value: t })).toBe(t);
  });
  it("effectiveTier and wakeTier", () => {
    expect(effectiveTier({})).toBe("high");
    expect(effectiveTier({ tier: "bogus" })).toBe("high");
    expect(effectiveTier({ tier: "low" })).toBe("low");
    expect(isTier("mid")).toBe(true);
    expect(wakeTier(["low", "mid"] as Tier[])).toBe("mid");
    expect(wakeTier(["low", undefined])).toBeUndefined();
    expect(wakeTier([])).toBeUndefined();
  });
});
