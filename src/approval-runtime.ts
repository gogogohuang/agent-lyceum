import os from 'node:os';
import { ApprovalError } from './approval-error.js';
import { applyEnrollment, type EnrollmentIdentity } from './approval-enrollment.js';
import { loadExecutors, type ExecutorsConfig } from './approval-executors.js';
import { defaultApprovalIo, type ApprovalIo } from './approval-io.js';
import { storePaths } from './approval-paths.js';
import { ConfigError, type ApprovalContext, type ApprovalLoadError, type ResolvedProject } from './config.js';

/**
 * Run-time enrollment (stage 2b-1, decision D1). In-memory only: nothing here is persisted, cached or added to any output.
 * Missing file or all-empty `allow` lists: the project is returned untouched (byte-identical to before).
 * A file that exists but cannot be read or parsed: the project is returned with `approvalError` set and no agent enrolled;
 * `assertApprovalConfig` is what makes the agent-starting commands refuse. This function never throws.
 */
export function enrollProject(project: ResolvedProject, identity: EnrollmentIdentity,
  opts: { io?: ApprovalIo; userHome?: string } = {}): ResolvedProject {
  let file = project.home;
  try {
    file = storePaths(project.home).executors;
    const loaded = loadExecutors(project.home, opts.userHome ?? os.homedir(), opts.io ?? defaultApprovalIo);
    if (!loaded.enabled || !loaded.config) return project;
    const { config } = loaded;
    const approval: ApprovalContext = {
      identity: { project: identity.project },
      commands: [...new Set(Object.values(config.executors).map((e) => e.command[0]))].sort(),
      maxScanEntries: config.limits.max_scan_entries,
    };
    const applied = applyEnrollment(project, identity, config);
    const agents = Object.fromEntries(Object.entries(applied.agents)
      .map(([n, a]) => [n, a.enrolled ? { ...a, approval } : a]));
    return { ...applied, agents };
  } catch (e) {
    // Reasons are fixed category texts. Parser and schema messages can quote keys, tags and values, so they are never copied.
    const code = e instanceof ApprovalError ? e.code : 'IO_ERROR';
    const error: ApprovalLoadError = { file: e instanceof ApprovalError && e.path ? safe(e.path) : safe(file), code, reason: categoryOf(e) };
    return { ...project, approvalError: error };
  }
}

/** Fixed text per failure class; the only thing that reaches `approvalError.reason`. */
function categoryOf(e: unknown): string {
  if (!(e instanceof ApprovalError)) return 'cannot read file';
  const m = e.message;
  if (e.code === 'UNSAFE_PATH') return 'not a regular file, or a symlink, or outside the approval home';
  if (e.code === 'CORRUPT_RECORD') return /exceeds \d+ bytes/.test(m) ? 'file too large' : 'file is not valid UTF-8 text or changed while it was read';
  if (e.code === 'INVALID_INPUT') {
    return m === 'Invalid executors file: YAML aliases are not allowed' ? 'YAML aliases are not allowed'
      : 'invalid content (YAML syntax error, or unknown or invalid field); run `agent-lyceum doctor` for details';
  }
  return 'cannot read file';
}

const safe = (s: string): string => [...s].map((c) => { const n = c.charCodeAt(0); return n < 0x20 || (n >= 0x7f && n <= 0x9f) ? '?' : c; }).join('');

/** The configuration error the agent-starting commands (`run`, `resume`, solo, `call`) stop with before any agent is invoked. */
export function approvalConfigError(e: ApprovalLoadError): ConfigError {
  return new ConfigError(`Approval executors configuration is invalid: ${e.file}: ${e.reason}. No agent was started. ` +
    'Fix or remove the file (`agent-lyceum doctor` shows the same check).');
}

export function assertApprovalConfig(project: ResolvedProject): void {
  if (project.approvalError) throw approvalConfigError(project.approvalError);
}

const NO_EXECUTORS: ExecutorsConfig = { executors: {}, limits: { max_total_pending: 50, max_scan_entries: 200, retention_days: 90 } };

/** The executors configuration as it is on disk now; a missing file or one with no `allow` entry gives an empty or inert config. Fixed code on failure. */
export function loadFreshConfig(home: string, opts: { io?: ApprovalIo; userHome?: string } = {}): { ok: true; config: ExecutorsConfig } | { ok: false; code: "CONFIG_INVALID" } {
  try {
    const loaded = loadExecutors(home, opts.userHome ?? os.homedir(), opts.io ?? defaultApprovalIo);
    return { ok: true, config: loaded.config ?? NO_EXECUTORS };
  } catch {
    return { ok: false, code: "CONFIG_INVALID" };
  }
}

/**
 * Read-only commands (`approvals show` and friends): the executors configuration as it is on disk now, keeping the specific `ApprovalError` code on a
 * failure so the screen can say why `executors.yaml` cannot be read. A missing file gives `config: null`. Anything that is not an `ApprovalError` is rethrown.
 */
export function loadConfigForDisplay(home: string, opts: { io?: ApprovalIo; userHome?: string } = {}): { ok: true; config: ExecutorsConfig | null } | { ok: false; code: ApprovalError["code"] } {
  try {
    return { ok: true, config: loadExecutors(home, opts.userHome ?? os.homedir(), opts.io ?? defaultApprovalIo).config };
  } catch (e) {
    if (e instanceof ApprovalError) return { ok: false, code: e.code };
    throw e;
  }
}

/**
 * For the per-wake gate: read `executors.yaml` again and enroll `project` from it. A missing file, or one with no `allow` entry, gives an empty config and
 * nothing enrolled (the gate then reports the slot as no longer allowed). Any read or parse failure is a fixed code, never a message.
 */
export function loadFreshEnrollment(project: ResolvedProject, identity: EnrollmentIdentity,
  opts: { io?: ApprovalIo; userHome?: string } = {}): { ok: true; project: ResolvedProject; config: ExecutorsConfig } | { ok: false; code: "CONFIG_INVALID" } {
  const r = loadFreshConfig(project.home, opts);
  if (!r.ok) return r;
  try {
    return { ok: true, project: applyEnrollment(project, identity, r.config), config: r.config };
  } catch {
    return { ok: false, code: "CONFIG_INVALID" };
  }
}
