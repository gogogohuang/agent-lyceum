import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedProject } from "../src/config.js";
import { diagnoseProject } from "../src/doctor.js";
import { setOsSandboxForTest } from "../src/policy.js";
import { initGitRepo, makeEnv, type TestEnv } from "./helpers.js";

// Spec 23.13: what doctor says about same-role instances (T-M1-1 and the other rows of its table).

let env: TestEnv;
afterEach(() => {
  setOsSandboxForTest(undefined);
  env?.cleanup();
});

async function checks(edit: (p: ResolvedProject) => void = () => {}, git = true) {
  env = makeEnv();
  if (git) initGitRepo(env.repo);
  const p = env.project();
  edit(p);
  return (await diagnoseProject(p, { env: { PATH: "/nonexistent" } })).checks.filter((c) => c.subject === "instances");
}

describe("doctor: instances", () => {
  it("is silent for a default project in a git repo", async () => {
    expect(await checks()).toEqual([]);
  });

  it("a written max_instances above 1 in a repo that cannot have worktrees warns that parallel tasks run one at a time", async () => {
    const c = await checks((p) => {
      p.dispatcher.max_instances = 3;
    }, false);
    expect(c).toEqual([expect.objectContaining({ level: "warn", message: expect.stringContaining("parallel tasks run one at a time") })]);
  });

  it("without a written max_instances a non-worktree repo adds nothing (the git info already says it)", async () => {
    expect(await checks(() => {}, false)).toEqual([]);
  });

  it("a configured agent named like an instance warns and names it", async () => {
    const c = await checks((p) => {
      p.agents["fe-member--2"] = structuredClone(p.agents["fe-member"]!);
      p.agents["fe-member--2"]!.name = "fe-member--2";
    });
    expect(c.some((x) => x.level === "warn" && x.message.includes('agent "fe-member--2" has the name instance 2 of "fe-member"'))).toBe(true);
  });

  it("a member name that is not a branch name cannot run as several instances (info)", async () => {
    const c = await checks((p) => {
      p.agents["bad name"] = structuredClone(p.agents["fe-member"]!);
      p.agents["bad name"]!.name = "bad name";
    });
    expect(c).toContainEqual({ level: "info", subject: "instances", message: '"bad name" cannot run as several instances (name is not a valid branch name).' });
  });

  it("a Codex member without an OS sandbox: info by default, warn when max_instances is written", async () => {
    setOsSandboxForTest(false);
    const codex = (p: ResolvedProject) => {
      p.agents["fe-member"]!.runtime = "codex";
    };
    const dflt = await checks(codex);
    expect(dflt).toEqual([{ level: "info", subject: "instances", message: 'only "fe-member" writes its memory; its other instances are only told not to (Codex without an OS sandbox).' }]);
    const written = await checks((p) => {
      codex(p);
      p.dispatcher.max_instances = 2;
    });
    expect(written.map((x) => x.level)).toEqual(["warn"]);
    setOsSandboxForTest(true);
    expect(await checks(codex)).toEqual([]);
  });

  it("T-M1-1: a memory folder inside the task-memory root only may prevent instances; one that contains it surely does", async () => {
    const coarse = await checks((p) => {
      p.agents["fe-member"]!.memory.project = path.join(p.paths.taskMemory, "notes");
    });
    expect(coarse).toHaveLength(1);
    expect(coarse[0]).toMatchObject({ level: "warn" });
    expect(coarse[0]!.message).toContain("may prevent extra instances for some runs");
    expect(coarse[0]!.message).not.toContain("one task at a time");

    const certain = await checks((p) => {
      p.agents["fe-member"]!.memory.project = p.paths.root;
    });
    expect(certain).toHaveLength(1);
    expect(certain[0]).toMatchObject({ level: "warn" });
    expect(certain[0]!.message).toContain('"fe-member" runs one task at a time');
    expect(certain[0]!.message).toContain("contains");
  });

  it("a memory symlink to the run data is seen through", async () => {
    const c = await checks((p) => {
      const link = path.join(p.paths.root, "link-to-runs");
      fs.mkdirSync(p.paths.runs, { recursive: true });
      fs.symlinkSync(p.paths.runs, link);
      p.agents["fe-member"]!.memory.project = link;
    });
    expect(c.some((x) => x.level === "warn")).toBe(true);
  });
});
