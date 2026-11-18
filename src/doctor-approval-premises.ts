import { applyEnrollment } from './approval-enrollment.js';
import type { ExecutorsConfig } from './approval-executors.js';
import type { ResolvedAgent, ResolvedProject } from './config.js';
import type { DoctorCheck } from './doctor.js';
import { agentForCandidate, candidatesFor } from './fallback.js';
import { DEFAULT_MAX_INSTANCES, roleOfName } from './instances.js';

/** Injected facts, so the checks stay pure (no fs, no process access). */
export interface PremiseOptions { platform: NodeJS.Platform; sandboxAvailable: () => boolean }

const SUBJECT = 'approval';
const err = (message: string): DoctorCheck => ({ level: 'error', subject: SUBJECT, message });
const warn = (message: string): DoctorCheck => ({ level: 'warn', subject: SUBJECT, message });

/**
 * Local premises 1, 3, 4 (config part), 6 and the `can_edit_agent_md` warning for ONE enrolled agent (project member or call).
 * Premise 3/4 are judged per candidate (primary, then fallback chain) at its effective settings; empty/false grants pass.
 * Dangerous bypass flags are not expressible in the strict config schema, so there is nothing to scan (test proves the schema).
 */
export function agentPremiseChecks(label: string, agent: ResolvedAgent, opts: PremiseOptions): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  if (opts.platform === 'win32') out.push(err(`Approval enrollment is unsupported on Windows: ${label}`));
  if (!opts.sandboxAvailable()) {
    out.push(err(`Approval enrollment requires an OS sandbox: ${label} (no OS sandbox found; on Linux only the presence of bwrap is checked, backend startup is unverified)`));
  }
  for (const c of candidatesFor(agent)) {
    const eff = agentForCandidate(agent, c);
    const at = `${label} candidate ${c.key}${c.primary ? ' (primary)' : ' (fallback)'}`;
    if (eff.sandbox?.unixSockets.length) out.push(err(`Approval-enrolled candidate permits sandbox.unix_sockets: ${at}`));
    if (eff.sandbox?.network.length) out.push(err(`Approval-enrolled candidate permits sandbox.network: ${at}`));
    if (eff.sandbox?.localBinding) out.push(err(`Approval-enrolled candidate permits sandbox.local_binding: ${at}`));
    if (eff.allowWeb === 'search' || eff.allowWeb === 'fetch') out.push(err(`Approval-enrolled candidate permits allow_web=${eff.allowWeb}: ${at}`));
    if (c.runtime === 'codex') out.push(err(`Approval-enrolled candidate uses Codex: ${at}`));
  }
  if (agent.canEditAgentMd) out.push(warn(`Approval-enrolled agent has can_edit_agent_md: ${label}`));
  return out;
}

/**
 * Per-project premises for project X: agent checks for each enrolled agent, premise 7 (`verify.commands`), the open_pr warning,
 * the instance-cap warning (once per project with an enrolled agent) and the same-name-not-enrolled clash warning.
 */
export function projectPremiseChecks(project: ResolvedProject, config: ExecutorsConfig, opts: PremiseOptions): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const applied = applyEnrollment(project, { project: project.name }, config);
  const enrolledNames = Object.keys(applied.agents).filter((n) => applied.agents[n]?.enrolled);
  for (const n of enrolledNames) out.push(...agentPremiseChecks(`${project.name}/${n}`, applied.agents[n] as ResolvedAgent, opts));
  if (enrolledNames.length) {
    if (project.verify?.commands.length) out.push(err(`Approval-enrolled project has verify.commands: ${project.name} (${project.verify.commands.length} command(s))`));
    out.push(warn(`Approval-enrolled project lead may request open_pr: ${project.name} (lead ${project.lead})`));
    const max = project.dispatcher.max_instances ?? DEFAULT_MAX_INSTANCES;
    if (max !== 1) {
      const how = project.dispatcher.max_instances === undefined ? `default ${DEFAULT_MAX_INSTANCES}` : `dispatcher.max_instances: ${max}`;
      out.push(warn(`Approval-enrolled role has effective instance cap 1: ${project.name} (${how} is ignored for enrolled roles)`));
    }
  }
  const allowed = new Set<string>();
  const clash = new Set<string>();
  for (const e of Object.values(config.executors)) for (const a of e.allow) {
    if ('call' in a) allowed.add(a.call);
    else if (a.project !== project.name) allowed.add(a.agent);
  }
  for (const n of Object.keys(applied.agents)) {
    const role = roleOfName(applied.agents, n);
    if (!applied.agents[n]?.enrolled && allowed.has(role)) clash.add(role);
  }
  for (const role of [...clash].sort()) {
    out.push(warn(`Agent is not approval-enrolled despite matching an enrolled role name: ${project.name}/${role} (enrollment is per project or call identity)`));
  }
  return out;
}
