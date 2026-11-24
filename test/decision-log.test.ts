import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProject } from "../src/config.js";
import { decisionLogId, saveRunDecisions } from "../src/decision-log.js";
import { listDecisionLog } from "../src/records.js";
import { createConsoleDeps } from "../src/web-console.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const RUN = "20261108T064809631Z-24114016848c953824d6a493d0d2e792";

function seed(result: string) {
  const dir = path.join(env.home, "projects", "demo", "runs", RUN);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "result.md"), result);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ task_summary: "Let /robots.txt skip auth", started_at: "2026-11-08T06:48:11.057Z" }));
}

describe("saveRunDecisions", () => {
  it("keeps Decisions with the task as context, once, and the web page can read it", () => {
    env = makeEnv();
    seed("# P0-1 robots\n\n**Outcome:** completed\n\n## Result\nx\n\n## Decisions\n- Anchored `robots\\.txt$` instead of a bare prefix.\n\n## Not done\n- Check production after deploy.\n\n## Steps\n- [x] a\n");
    const project = resolveProject(env.home, "demo");
    const first = saveRunDecisions(project, RUN);
    expect(first.status).toBe("saved");
    expect(first.id).toBe(decisionLogId(RUN));
    const text = fs.readFileSync(first.file!, "utf8");
    expect(text).toContain("## Context\nLet /robots.txt skip auth");
    expect(text).toContain("## Decision\n- Anchored");
    expect(text).toContain("## Consequences\n- Check production");
    expect(text).not.toContain("Steps");
    expect(listDecisionLog(project)[0]).toMatchObject({ status: "active", date: "2026-11-08", title: "P0-1 robots", run: RUN });
    expect(saveRunDecisions(project, RUN).status).toBe("exists");
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    expect(deps.listDecisions().find((g) => g.project === "demo")?.decisions.map((d) => d.id)).toEqual([first.id]);
    expect(deps.readDecision("demo", first.id!)?.markdown).toContain("## Decision");
  });
  it("saves nothing when the report has no decision, or there is no report", () => {
    env = makeEnv();
    const project = resolveProject(env.home, "demo");
    expect(saveRunDecisions(project, RUN).status).toBe("none");
    for (const body of ["## Decisions\nNone\n", "## Decisions\n- None\n", "## Decisions\n\n## Not done\nx\n", "## Result\nx\n"]) {
      seed(`# T\n\n${body}`);
      expect(saveRunDecisions(project, RUN).status).toBe("none");
    }
    expect(listDecisionLog(project)).toEqual([]);
  });
});
