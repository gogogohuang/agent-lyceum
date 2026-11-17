import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateProject } from "../src/validate.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const errors = (e: TestEnv) => validateProject(e.project()).issues.filter((i) => i.level === "error").map((i) => i.message);
const feAgent = "  fe-member:\n    can_message: [lead]";
const setFe = (e: TestEnv, body: string) => e.editProjectYaml((t) => t.replace(feAgent, `  fe-member:\n${body}\n    can_message: [lead]`));

describe("validate cursor runtime", () => {
  it("rejects runtime cursor without a model", () => {
    env = makeEnv();
    setFe(env, "    runtime: cursor");
    expect(errors(env).join("\n")).toMatch(/Agent "fe-member": runtime cursor requires a grok-\* model/);
  });

  it("rejects runtime cursor with a non-grok model", () => {
    env = makeEnv();
    setFe(env, "    runtime: cursor\n    model: sonnet");
    expect(errors(env).join("\n")).toMatch(/Agent "fe-member": runtime cursor only allows grok-\* models \(got "sonnet"\)/);
  });

  it("rejects effort on cursor with 'not supported by cursor'", () => {
    env = makeEnv();
    setFe(env, "    runtime: cursor\n    model: grok-4.7\n    effort: high");
    const e = errors(env).join("\n");
    expect(e).toMatch(/not supported by cursor/);
    expect(e).not.toMatch(/use \)/);
  });

  it("rejects a cursor fallback without a model", () => {
    env = makeEnv();
    setFe(env, "    fallback: [{ runtime: cursor }]");
    expect(errors(env).join("\n")).toMatch(/fallback cursor\/\(default model\)/);
  });

  it("rejects a cursor fallback with a non-grok model", () => {
    env = makeEnv();
    setFe(env, "    fallback: [{ runtime: cursor, model: sonnet }]");
    expect(errors(env).join("\n")).toMatch(/fallback cursor\/sonnet.*grok-\*/);
  });

  it("resolves model grok-4.7 without runtime to cursor and validates", () => {
    env = makeEnv();
    setFe(env, "    model: grok-4.7");
    expect(env.project().agents["fe-member"]?.runtime).toBe("cursor");
    expect(errors(env)).toEqual([]);
  });

  it("mentions grok-* in the no-runtime hint", () => {
    env = makeEnv();
    const file = path.join(env.home, "team.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n {4}runtime: claude-code\n {4}agent_md: agents\/fe-member/, "\n    agent_md: agents/fe-member"));
    setFe(env, "    model: mystery-model");
    expect(errors(env).join("\n")).toMatch(/has no runtime.*grok-\*/);
  });
});
