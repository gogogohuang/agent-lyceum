import type { ExecutorsConfig } from './approval-executors.js';
import { qualificationOf } from './approval-executors.js';
import type { ResolvedAgent, ResolvedProject } from './config.js';
import { roleOfName } from './instances.js';

/** Who is asking: a project (by name) or a `call` (project null). */
export interface EnrollmentIdentity { readonly project: string | null }

/**
 * Pure: is agent `name` (a base role or a bound instance name) in some executor's `allow`?
 * Instances map to their role through their `instance` metadata, never a name suffix pattern.
 */
export function enrolled(identity: EnrollmentIdentity, agents: Record<string, ResolvedAgent | undefined>,
  name: string, config: ExecutorsConfig | null): boolean {
  return qualificationOf(config, { project: identity.project, role: roleOfName(agents, name) }).enrolled;
}

/** Pure: a copy of `project` whose agents carry `enrolled: true` for union members; stale flags are removed. */
export function applyEnrollment(project: ResolvedProject, identity: EnrollmentIdentity,
  config: ExecutorsConfig | null): ResolvedProject {
  const agents: Record<string, ResolvedAgent> = {};
  for (const [n, a] of Object.entries(project.agents)) {
    const { enrolled: _stale, ...rest } = a;
    agents[n] = enrolled(identity, project.agents, n, config) ? { ...rest, enrolled: true } : rest;
  }
  return { ...project, agents };
}
