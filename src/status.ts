import fs from "node:fs";
import path from "node:path";
import type { RunState } from "./dispatcher.js";
import type { ResolvedProject } from "./config.js";
import { listUnread } from "./mailbox.js";
import { enforcementFor } from "./policy.js";

export function latestRun(project: ResolvedProject): { dir: string; state: RunState } | undefined {
  const root = project.paths.runs;
  if (!fs.existsSync(root)) return undefined;
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const d of dirs) {
    const f = path.join(root, d, "state.json");
    if (!fs.existsSync(f)) continue;
    try {
      return { dir: path.join(root, d), state: JSON.parse(fs.readFileSync(f, "utf8")) as RunState };
    } catch {
      /* skip unreadable */
    }
  }
  return undefined;
}

export function formatStatus(project: ResolvedProject): string {
  const run = latestRun(project);
  const rows = [["agent", "runtime", "unread", "protection", "last wake"]];
  for (const a of Object.values(project.agents)) {
    const e = enforcementFor(project, a);
    const lw = run?.state.last_wake[a.name];
    const levels = [...new Set([e.memory, e.agentMd, e.otherContext, e.repoInstructions])].join("/");
    rows.push([
      a.name + (a.name === project.lead ? " (lead)" : ""),
      a.runtime ?? "?",
      String(listUnread(project, a.name).length),
      levels,
      lw ? `${lw.ok ? "ok" : "FAILED"} ${lw.at}` : "-",
    ]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const table = rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd());
  table.splice(1, 0, w.map((n) => "-".repeat(n)).join("  "));

  const lines = [`Project: ${project.name}  (repo: ${project.dir})`, "", ...table, ""];
  if (!run) lines.push("No runs yet.");
  else {
    const s = run.state;
    lines.push(
      `Last run: ${s.run_id}`,
      `  task:    ${s.task_source === "file" ? `file ${s.task_path}` : "text"}`,
      `  rounds:  ${s.rounds}/${s.max_rounds}`,
      `  ended:   ${s.end_reason ?? "still running or interrupted"}`,
      `  cost:    ${s.cost_usd ? `$${s.cost_usd.toFixed(4)} (Claude Code only)` : "n/a"}`,
    );
  }
  return lines.join("\n");
}
