import fs from "node:fs";
import os from "node:os";
import { ApprovalError } from "./approval-error.js";
import { checkApprovalLinks } from "./approval-link-check.js";
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
  /** Test seam for the D8 hard-link probe; default `checkApprovalLinks`. */
  linkProbe?: (home: string, dir: string) => void;
}

/** Fixed texts per probe class: nothing from the error (path, errno text) is ever echoed. */
const LINK_TEXT: Record<string, string> = {
  UNSUPPORTED_LINK: "UNSUPPORTED_LINK: the approval store's filesystem does not support hard links; use a filesystem with hard links",
  UNSAFE_PATH: "UNSAFE_PATH: the approval store path (or an ancestor under the agent-lyceum home) is not a plain directory; make it one",
  IO_ERROR: "IO_ERROR: the hard-link probe could not complete; check permissions and free space of the agent-lyceum home",
};

/** Premise form for a failed probe; runs only when enrolled (the caller returned earlier otherwise). The nearest real dir of approvals/requests, else home. */
function linkProbeChecks(home: string, probe: (home: string, dir: string) => void): DoctorCheck[] {
  const sp = storePaths(home);
  const dir = [sp.approvals, sp.requests].find((d) => { try { return fs.lstatSync(d).isDirectory(); } catch { return false; } }) ?? home;
  try { probe(home, dir); } catch (e) {
    const code = e instanceof ApprovalError ? e.code : "IO_ERROR";
    return [{ level: "error", subject: "approval", message: `Approval store hard-link probe failed (${LINK_TEXT[code] ?? LINK_TEXT.IO_ERROR})` }];
  }
  return [];
}

/**
 * Approval-gate diagnostics for `doctor` (spec section 3). Since stage 2b-1 the runtime resolver (`approval-runtime.ts`) also reads
 * `executors.yaml`, for enrollment only; this module stays the one that reports problems with it.
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
  const checks = [...inventory.checks, ...linkProbeChecks(home, opts.linkProbe ?? checkApprovalLinks), ...projectPremiseChecks(project, config, popts)];
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
