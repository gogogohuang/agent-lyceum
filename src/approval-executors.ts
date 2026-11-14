import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ApprovalError } from './approval-error.js';
import { defaultApprovalIo, readApprovalFile } from './approval-io.js';
import type { ApprovalIo } from './approval-io.js';
import { storePaths } from './approval-paths.js';
import { NAME_RE } from './paths.js';

export type ExecutorAllow = { readonly project: string; readonly agent: string } | { readonly call: string };
export interface ExecutorConfig {
  readonly command: readonly [string]; readonly allow: readonly ExecutorAllow[];
  readonly timeout_sec: number; readonly env: Readonly<Record<string, string>>;
  readonly expires_days: number; readonly max_pending: number; readonly max_payload_bytes: number;
}
export interface ExecutorsConfig {
  readonly executors: Readonly<Record<string, ExecutorConfig>>;
  readonly limits: { readonly max_total_pending: number; readonly max_scan_entries: number; readonly retention_days: number };
}
export type ExecutorsLoad = { readonly enabled: boolean; readonly config: ExecutorsConfig | null };
export interface ApprovalQualification { readonly enrolled: boolean; readonly executors: readonly string[] }

const MAX_BYTES = 1024 * 1024;
const name = z.string().regex(NAME_RE);
const posInt = z.number().int().safe().positive();
const allow = z.union([z.strictObject({ project: name, agent: name }), z.strictObject({ call: name })]);
const executor = z.strictObject({
  command: z.tuple([z.string().refine((s) => path.isAbsolute(s) && !s.includes('\0'), 'command must be an absolute path')]),
  allow: z.array(allow),
  timeout_sec: posInt,
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  expires_days: posInt.default(7),
  max_pending: posInt.default(10),
  max_payload_bytes: posInt.max(65536).default(4096),
});
const schema = z.strictObject({
  executors: z.record(name, executor).default({}),
  limits: z.strictObject({ max_total_pending: posInt.default(50), max_scan_entries: posInt.default(200),
    retention_days: posInt.default(90) }).default({ max_total_pending: 50, max_scan_entries: 200, retention_days: 90 }),
});

function expandTilde(value: string, userHome: string): string {
  if (value === '~') return userHome;
  return value.startsWith('~/') ? path.join(userHome, value.slice(2)) : value;
}

/** Strict v1 executors.yaml parser. Pure: shape checks only, no executable/containment/sandbox judgement. */
export function parseExecutors(text: string, file: string, userHome: string): ExecutorsConfig {
  const fail = (why: string): never => { throw new ApprovalError('INVALID_INPUT', `Invalid executors file: ${why}`, file); };
  const doc = YAML.parseDocument(text, { uniqueKeys: true });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) fail(problem.message.split('\n')[0] ?? 'YAML error');
  let alias = false;
  YAML.visit(doc, { Alias() { alias = true; return YAML.visit.BREAK; } });
  if (alias) fail('YAML aliases are not allowed');
  const raw = doc.toJS() ?? {};
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return fail(`${i?.path.join('.') || '(root)'}: ${i?.message ?? 'invalid'}`);
  }
  const executors: Record<string, ExecutorConfig> = {};
  for (const [n, e] of Object.entries(parsed.data.executors)) {
    executors[n] = { ...e, env: Object.fromEntries(Object.entries(e.env).map(([k, v]) => [k, expandTilde(v, userHome)])) };
  }
  return { executors, limits: parsed.data.limits };
}

/** Direct call only. Missing file => disabled; an empty union of allows => disabled (config still returned). */
export function loadExecutors(home: string, userHome: string, io: ApprovalIo = defaultApprovalIo): ExecutorsLoad {
  const file = storePaths(home).executors;
  const bytes = readApprovalFile(file, MAX_BYTES, home, io);
  if (bytes === null) return { enabled: false, config: null };
  const config = parseExecutors(bytes.toString('utf8'), file, userHome);
  return { enabled: Object.values(config.executors).some((e) => e.allow.length > 0), config };
}

/** Allow-union membership. A `call` entry matches a call identity (project null) by role name. */
export function qualificationOf(config: ExecutorsConfig | null,
  identity: { readonly project: string | null; readonly role: string }): ApprovalQualification {
  const names = new Set<string>();
  for (const [n, e] of Object.entries(config?.executors ?? {})) {
    if (e.allow.some((a) => ('call' in a ? identity.project === null && a.call === identity.role
      : a.project === identity.project && a.agent === identity.role))) names.add(n);
  }
  const executors = [...names].sort();
  return { enrolled: executors.length > 0, executors };
}
