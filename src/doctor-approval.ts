import os from "node:os";
import { ApprovalError } from "./approval-error.js";
import { loadExecutors, qualificationOf } from "./approval-executors.js";
import { storePaths } from "./approval-paths.js";
import type { ResolvedProject } from "./config.js";
import type { DoctorCheck } from "./doctor.js";
import { approvalContainmentChecks, escapeControl } from "./doctor-approval-containment.js";
import { agentPremiseChecks, projectPremiseChecks } from "./doctor-approval-premises.js";
import { osSandboxAvailable } from "./policy.js";

export interface DoctorApprovalOptions {
  /** The agent-lyceum home holding executors.yaml; default: the home the project was loaded from. */
  home?: string;
  userHome?: string;
  platform?: NodeJS.Platform;
  sandboxAvailable?: () => boolean;
}

/**
 * Approval-gate diagnostics for `doctor` (spec section 3). The only reader of `executors.yaml` outside its own module.
 * A missing file, or one whose `allow` entries are all empty, returns `[]` with no further I/O, so doctor output stays byte-identical.
 * Read-only diagnostics, not enforcement.
 */
export function diagnoseApproval(project: ResolvedProject, opts: DoctorApprovalOptions = {}): DoctorCheck[] {
  const home = opts.home ?? project.home;
  const userHome = opts.userHome ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const popts = { platform, sandboxAvailable: opts.sandboxAvailable ?? osSandboxAvailable };

  let config: NonNullable<ReturnType<typeof loadExecutors>["config"]>;
  try {
    const loaded = loadExecutors(home, userHome);
    if (!loaded.enabled || !loaded.config) return [];
    config = loaded.config;
  } catch (e) {
    // ApprovalError messages are written to be safe (no payloads or secrets); anything else is not echoed.
    let file = home;
    try { file = storePaths(home).executors; } catch { /* keep home */ }
    const why = e instanceof ApprovalError ? e.message : "unexpected error while reading the file";
    return [{ level: "error", subject: "approval", message: escapeControl(`Approval executors configuration is invalid: ${file}: ${why}`) }];
  }

  const inventory = approvalContainmentChecks(home, config, { platform, userHome });
  const checks = [...inventory.checks, ...projectPremiseChecks(project, config, popts)];
  for (const { role, agent } of inventory.calls) {
    if (qualificationOf(config, { project: null, role }).enrolled) checks.push(...agentPremiseChecks(`call/${role}`, agent, popts));
  }
  const seen = new Set<string>();
  return checks.map((c) => ({ ...c, message: escapeControl(c.message) })).filter((c) => {
    const key = `${c.level}\0${c.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
