import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listPromotable, promoteDecisions, undoPromoted } from "../src/decision-log.js";
import { restoreMemory, tidyMemory } from "../src/memory-tidy.js";
import { decisionLogDir, recordsDir } from "../src/policy.js";
import type { Invoker, WakeResult } from "../src/adapters/index.js";
import { makeMemoryEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const RUN_A = "20261108T064809631Z-aaaa";
const RUN_B = "20261109T064809631Z-bbbb";
const STAMP = "20261125T000000Z";
const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };

function seedRun(runId: string, outcome: string, decisions = "- Chose A over B because C.") {
  const dir = path.join(env.project().paths.runs, runId);
  write(path.join(dir, "result.md"), `# Task ${runId}\n\n**Outcome:** ${outcome}\n\n## Result\nx\n\n## Decisions\n${decisions}\n\n## Not done\n- follow up\n`);
  write(path.join(dir, "state.json"), JSON.stringify({ task_summary: `summary ${runId}`, started_at: "2026-11-08T06:48:11.057Z", outcome }));
}

describe("listPromotable / promoteDecisions", () => {
  it("takes the decisions of completed runs only", () => {
    env = makeMemoryEnv();
    seedRun(RUN_A, "completed");
    seedRun(RUN_B, "partial");
    expect(listPromotable(env.project()).map((e) => e.id)).toEqual(["run-20261108t064809631z-aaaa"]);
  });

  it("skips runs without a decision", () => {
    env = makeMemoryEnv();
    seedRun(RUN_A, "completed", "None");
    expect(listPromotable(env.project())).toEqual([]);
  });

  it("writes records/decisions once, keeps the run, and never brings back an entry a tidy archived", () => {
    env = makeMemoryEnv();
    seedRun(RUN_A, "completed");
    const project = env.project();
    const ids = promoteDecisions(project, STAMP);
    expect(ids).toEqual(["run-20261108t064809631z-aaaa"]);
    const file = path.join(recordsDir(project), "decisions", `${ids[0]}.md`);
    expect(fs.readFileSync(file, "utf8")).toContain("## Decision\n- Chose A over B");
    expect(fs.existsSync(path.join(project.paths.runs, RUN_A, "result.md"))).toBe(true);
    expect(promoteDecisions(project, STAMP)).toEqual([]);
    // a later tidy merged it away: it sits in .archive, and must stay there
    const archived = path.join(recordsDir(project), ".archive", "20261126T000000Z", "decisions", `${ids[0]}.md`);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(file, archived);
    expect(listPromotable(project)).toEqual([]);
  });

  it("migrates completed entries of the decision log, and leaves the rest", () => {
    env = makeMemoryEnv();
    const dir = decisionLogDir(env.project());
    const entry = (outcome: string) => `---\nstatus: active\ndate: 2026-11-01\ntitle: "t"\nrun: "r"\n${outcome ? `outcome: ${outcome}\n` : ""}---\n## Decision\nx\n`;
    write(path.join(dir, "run-done.md"), entry("completed"));
    write(path.join(dir, "run-part.md"), entry("partial"));
    write(path.join(dir, "run-old.md"), entry(""));
    expect(promoteDecisions(env.project(), STAMP)).toEqual(["run-done"]);
    expect(fs.existsSync(path.join(dir, "run-done.md"))).toBe(true);
  });
});

describe("undoPromoted", () => {
  it("removes what the tidy promoted, but not a file changed since", () => {
    env = makeMemoryEnv();
    seedRun(RUN_A, "completed");
    seedRun(RUN_B, "completed");
    const project = env.project();
    promoteDecisions(project, STAMP);
    const keep = path.join(recordsDir(project), "decisions", "run-20261109t064809631z-bbbb.md");
    fs.appendFileSync(keep, "edited by the lead\n");
    const r = undoPromoted(project, STAMP);
    expect(r.removed).toEqual(["decisions/run-20261108t064809631z-aaaa.md"]);
    expect(r.kept.map((k) => k.rel)).toEqual(["decisions/run-20261109t064809631z-bbbb.md"]);
    expect(fs.existsSync(keep)).toBe(true);
  });
});

describe("tidy promotes decisions before it tidies", () => {
  it("--dry-run lists them and writes nothing", async () => {
    env = makeMemoryEnv();
    seedRun(RUN_A, "completed");
    const lines: string[] = [];
    await tidyMemory({ project: env.project(), layer: "project", dryRun: true, say: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("decisions to promote into the project records: run-20261108t064809631z-aaaa");
    expect(fs.existsSync(path.join(recordsDir(env.project()), "decisions"))).toBe(false);
  });

  it("the lead's wake-up sees the promoted decision as a record, and `tidy --undo` takes it back out", async () => {
    env = makeMemoryEnv();
    seedRun(RUN_A, "completed");
    write(path.join(env.project().agents["lead"]!.memory.project!, "MEMORY.md"), "- [a](a.md)\n");
    write(path.join(env.project().agents["lead"]!.memory.project!, "a.md"), "a");
    let leadPrompt = "";
    const invoker: Invoker = async (input) => {
      if (input.agent.name === "lead") leadPrompt = input.userPrompt;
      return OK;
    };
    const lines: string[] = [];
    await tidyMemory({ project: env.project(), layer: "project", agent: "lead", invoker, now: () => new Date("2026-11-25T00:00:00Z"), say: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("promoted 1 decision(s)");
    expect(leadPrompt).toContain("run-20261108t064809631z-aaaa");
    const file = path.join(recordsDir(env.project()), "decisions", "run-20261108t064809631z-aaaa.md");
    expect(fs.existsSync(file)).toBe(true);
    const r = restoreMemory({ project: env.project(), agent: "lead", layer: "project", stamp: "20261125T000000Z" });
    expect(r.promoted?.removed).toEqual(["decisions/run-20261108t064809631z-aaaa.md"]);
    expect(fs.existsSync(file)).toBe(false);
  });
});
