import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ApprovalError } from "./approval-error.js";
import { type ExecutorsConfig, qualificationOf } from "./approval-executors.js";
import { type ApprovalIo, ancestorsExist, defaultApprovalIo } from "./approval-io.js";
import { type CandidateSnapshot, type OriginErrorCode, type OriginResolver, type SnapshotInput, qualificationHash, revalidateQualification, staticWritable } from "./approval-origin.js";
import { type SlotRef, requestPaths } from "./approval-paths.js";
import { loadFreshConfig, loadFreshEnrollment } from "./approval-runtime.js";
import type { Origin, PremiseResult, Sha256, WritableSet } from "./approval-types.js";
import { type ResolvedAgent, type ResolvedProject, resolveProjectFrom } from "./config.js";
import { approvalContainmentChecks } from "./doctor-approval-containment.js";
import { type PremiseOptions, agentPremiseChecks, projectPremiseChecks } from "./doctor-approval-premises.js";
import { agentForCandidate, candidatesFor } from "./fallback.js";
import { atomicWrite, readRegularFileCappedNoFollow } from "./fs-util.js";
import { roleOfName } from "./instances.js";
import { latestSlotAttempt, mailDir } from "./message-store.js";
import { canonicalPath, homePaths, projectPaths } from "./paths.js";
import { outboxDir, sharedDir, sharedIndex, writePolicy } from "./policy.js";
import { GlobalConfig, ProjectConfig } from "./schema.js";

/**
 * Per-wake gate, pure building blocks (stage 2b-2, slice 1). Nothing here is wired into a run yet.
 * Every verdict, text and file written from here carries only slot names, fixed codes and fixed text: never a path, a YAML or zod
 * message, or an executor value (lesson `cross-model-review-evidence`).
 */
export type GateCode = OriginErrorCode | "NO_BASELINE" | "DIR_ANOMALY" | "RESIDUAL_OUTPUT" | "UNDETERMINABLE";
export type PremiseId = "project-premises" | "containment";
export type GateVerdict = { kind: "wake" } | { kind: "refused" | "skipped"; code: GateCode; premises?: readonly PremiseId[] };
export interface SlotBaseline { readonly slot: string; readonly origin: Origin; readonly hashes: ReadonlyMap<string, Sha256> }
export interface FreshView { readonly project: ResolvedProject; readonly bound: ResolvedProject; readonly config: ExecutorsConfig; readonly premises: readonly PremiseResult[] }
export interface GateDeps {
  loadFresh(): { ok: true; view: FreshView } | { ok: false; code: OriginErrorCode };
  slotDir(slot: string): GateVerdict;
  now(): Date;
}

const GATE_FILE = "approval-gate.json";
const YAML_LIMIT = 1024 * 1024;
const GATE_FILE_LIMIT = 64 * 1024;
const PREMISE_IDS: readonly string[] = ["project-premises", "containment"];

const refused = (code: GateCode, premises?: readonly PremiseId[]): GateVerdict => (premises ? { kind: "refused", code, premises } : { kind: "refused", code });
const skipped = (code: GateCode): GateVerdict => ({ kind: "skipped", code });

/** Fixed texts for the lead's mail and for human `status`, one per code. Nothing is interpolated. */
export const GATE_TEXT: Readonly<Record<GateCode, { mail: string; status: string }>> = {
  PROJECT_MISSING: { mail: "The project configuration no longer exists, so this agent is not woken for the rest of this run.", status: "project configuration is gone" },
  PROJECT_PATH_MISMATCH: { mail: "The project directory is no longer the one this run started with, so this agent is not woken for the rest of this run.", status: "project directory changed" },
  AGENT_MISSING: { mail: "The agent is no longer part of the team configuration, so it is not woken for the rest of this run.", status: "agent no longer in the team" },
  EXECUTOR_MISSING: { mail: "An executor this agent was enrolled with no longer exists, so it is not woken for the rest of this run.", status: "executor removed" },
  NOT_ALLOWED: { mail: "The agent is no longer allowed to use an executor it was enrolled with, so it is not woken for the rest of this run.", status: "no longer allowed by executors.yaml" },
  PREMISE_FAILED: { mail: "An approval premise check failed (run `agent-lyceum doctor`), so this agent is not woken for the rest of this run.", status: "approval premise check failed; run `agent-lyceum doctor`" },
  SNAPSHOT_MISMATCH: { mail: "The effective configuration of this agent changed since the run started, so it is not woken for the rest of this run.", status: "effective configuration changed" },
  CONFIG_INVALID: { mail: "A configuration file could not be read safely, so this agent is not woken for the rest of this run.", status: "configuration file unreadable or invalid" },
  ORIGIN_UNREADABLE: { mail: "The agent's qualification could not be recomputed, so it is not woken for the rest of this run.", status: "qualification could not be recomputed" },
  NO_BASELINE: { mail: "The run has no recorded qualification for this agent, so it is not woken for the rest of this run.", status: "no qualification recorded for this run" },
  DIR_ANOMALY: { mail: "The agent's approval request directory is not a plain directory chain, so it is not woken until that is fixed.", status: "request directory is unsafe" },
  RESIDUAL_OUTPUT: { mail: "Earlier approval output of this agent is still waiting to be collected, so it is not woken until then.", status: "earlier approval output is waiting" },
  UNDETERMINABLE: { mail: "The state of this agent's earlier approval output could not be determined, so it is not woken until that is resolved.", status: "approval state could not be determined" },
};

// ---- baseline and qualification ----

const abs = (p: string): string => canonicalPath(p);
const setOf = (dirs: readonly string[], files: readonly string[]): WritableSet => ({ dirs: dirs.map(abs), files: files.map(abs) });

/**
 * What `qualificationHash` is computed from, for each executor `slot`'s role is allowed to use. `bound` is the project bound to the run
 * (same binding as the session). Run-only entries (task memory, outbox, `_shared` and its index) are removed so the hash is run-independent;
 * `enrolled` is dropped before `writePolicy` so no approval deny scan runs (the allow lists do not depend on it).
 */
export function slotSnapshotInputs(bound: ResolvedProject, slot: string, config: ExecutorsConfig): Map<string, SnapshotInput> {
  const out = new Map<string, SnapshotInput>();
  const agent = bound.agents[slot];
  if (!agent) return out;
  const role = roleOfName(bound.agents, slot);
  const { executors } = qualificationOf(config, { project: bound.name, role });
  if (executors.length === 0) return out;
  const { enrolled: _e, approval: _a, ...plain } = agent;
  const pol = writePolicy(bound, plain as ResolvedAgent);
  const shared = sharedDir(bound);
  const index = sharedIndex(bound);
  const staticSet = staticWritable({
    effective: setOf(pol.allowDirs, pol.allowFiles),
    run_only: setOf([agent.memory.task, outboxDir(bound, slot), shared].filter((x): x is string => !!x), index ? [index] : []),
    static_duplicates: { dirs: [], files: [] },
  });
  const candidates: CandidateSnapshot[] = candidatesFor(agent).map((c) => {
    const eff = agentForCandidate(agent, c);
    return {
      runtime: c.runtime,
      sandbox: eff.sandbox ? { write: [...eff.sandbox.write], network: [...eff.sandbox.network], local_binding: eff.sandbox.localBinding, unix_sockets: [...eff.sandbox.unixSockets] } : null,
      allow_web: eff.allowWeb ?? null,
    };
  });
  for (const name of executors) {
    const executor = config.executors[name];
    if (executor) out.set(name, { runtime_candidates: candidates, writable: staticSet, project_dir: abs(bound.dir), executor });
  }
  return out;
}

export function baselineFor(bound: ResolvedProject, slot: string, config: ExecutorsConfig, runId: string): SlotBaseline {
  const inputs = slotSnapshotInputs(bound, slot, config);
  const first = inputs.values().next().value as SnapshotInput | undefined;
  const hashes = new Map<string, Sha256>();
  for (const [name, input] of inputs) hashes.set(name, qualificationHash(input));
  const origin: Origin = { kind: "run", project: bound.name, run_id: runId, project_dir: abs(bound.dir), role: roleOfName(bound.agents, slot),
    full_writable: first?.writable ?? { dirs: [], files: [] } };
  return { slot, origin, hashes };
}

/** Pure: is the slot still what the run started with? Hints from `resolveOrigin` carry paths and are discarded. */
export function qualificationVerdict(baseline: SlotBaseline, view: FreshView): GateVerdict {
  const slot = baseline.slot;
  if (baseline.hashes.size === 0) return refused("NO_BASELINE");
  if (!view.bound.agents[slot]) return refused("AGENT_MISSING");
  const q = qualificationOf(view.config, { project: view.bound.name, role: roleOfName(view.bound.agents, slot) });
  const inputs = slotSnapshotInputs(view.bound, slot, view.config);
  const failedPremises = view.premises.filter((p) => !p.ok && PREMISE_IDS.includes(p.check)).map((p) => p.check as PremiseId);
  const resolver: OriginResolver = (_origin, executor) => {
    const input = inputs.get(executor);
    if (!input) return { ok: false, code: view.config.executors[executor] ? "NOT_ALLOWED" : "EXECUTOR_MISSING", hint: "" };
    return { ok: true, resolved: { qualification: q, snapshot_input: input, premises: view.premises } };
  };
  for (const executor of [...baseline.hashes.keys()].sort()) {
    const r = revalidateQualification(baseline.origin, executor, baseline.hashes.get(executor) as Sha256, resolver);
    if (!r.ok) return r.code === "PREMISE_FAILED" ? refused("PREMISE_FAILED", failedPremises) : refused(r.code);
  }
  const now = [...q.executors].sort();
  const was = [...baseline.hashes.keys()].sort();
  if (now.length !== was.length || now.some((n, i) => n !== was[i])) return refused("SNAPSHOT_MISMATCH");
  return { kind: "wake" };
}

// ---- fresh view, read with bounds ----

export interface FreshOptions {
  home: string;
  project: string;
  userHome: string;
  /** The session's own binding (solo, run dir, instances), so run-only entries match the baseline's. */
  bind(project: ResolvedProject): ResolvedProject;
  premise: PremiseOptions;
  io?: ApprovalIo;
}

type Loaded<T> = { ok: true; value: T } | { ok: false; code: OriginErrorCode };

/** One bounded, no-follow, non-blocking read of a YAML file; over-limit, FIFO, symlink, unreadable or invalid content all fail closed. */
function readYamlBounded<S extends z.ZodTypeAny>(file: string, schema: S, missing: OriginErrorCode): Loaded<z.infer<S>> {
  const r = readRegularFileCappedNoFollow(file, YAML_LIMIT);
  if (!r.ok) return { ok: false, code: r.reason === "open_error:ENOENT" ? missing : "CONFIG_INVALID" };
  if (r.truncated) return { ok: false, code: "CONFIG_INVALID" };
  try {
    const parsed = schema.safeParse(YAML.parse(r.buf.toString("utf8")) ?? {});
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: "CONFIG_INVALID" };
  } catch {
    return { ok: false, code: "CONFIG_INVALID" };
  }
}

/**
 * The fresh project as a gate pass sees it: global and project YAML read with the bounded reader (not `loadGlobal`/`loadProjectRaw`),
 * `executors.yaml` through the runtime's fresh enrollment helper, merged by the pure `resolveProjectFrom`, then bound by the caller.
 * Premises are computed only when some agent is enrolled; they are `project-premises` (doctor's agent and project checks) and
 * `containment`, each failing on any `error`. Never throws; no failure carries a message.
 */
export function loadFreshView(o: FreshOptions): { ok: true; view: FreshView } | { ok: false; code: OriginErrorCode } {
  try {
    const g = readYamlBounded(homePaths(o.home).globalConfig, GlobalConfig, "CONFIG_INVALID");
    if (!g.ok) return g;
    const p = readYamlBounded(projectPaths(o.home, o.project).config, ProjectConfig, "PROJECT_MISSING");
    if (!p.ok) return p;
    const project = resolveProjectFrom(o.home, o.project, g.value, p.value);
    const fresh = loadFreshEnrollment(project, { project: o.project }, { io: o.io ?? defaultApprovalIo, userHome: o.userHome });
    if (!fresh.ok) return fresh;
    const { project: enrolledProject, config } = fresh;
    const bound = o.bind(enrolledProject);
    const premises: PremiseResult[] = [];
    if (Object.values(enrolledProject.agents).some((a) => a.enrolled)) {
      const projectOk = !projectPremiseChecks(project, config, o.premise).some((c) => c.level === "error");
      const contained = !approvalContainmentChecks(o.home, config, { platform: o.premise.platform, userHome: o.userHome }).checks.some((c) => c.level === "error");
      premises.push({ check: "project-premises", ok: projectOk, code: projectOk ? "ok" : "failed" }, { check: "containment", ok: contained, code: contained ? "ok" : "failed" });
    }
    return { ok: true, view: { project: enrolledProject, bound, config, premises } };
  } catch {
    return { ok: false, code: "CONFIG_INVALID" };
  }
}

// ---- slot directory ----

/**
 * Is the slot's request directory safe to wake into? Absent is fine (2b-2 never creates it). A symlink or non-directory anywhere on
 * the chain, or any lstat error: `DIR_ANOMALY`. A non-empty `proposals/` means earlier output nobody collected (stage 3 does that):
 * `RESIDUAL_OUTPUT` when the latest attempt is judged settled, otherwise `UNDETERMINABLE`. Never throws.
 */
export function slotDirVerdict(home: string, ref: SlotRef, runDir: string, slot: string, maxScan: number, io: ApprovalIo = defaultApprovalIo): GateVerdict {
  try {
    const { proposals } = requestPaths(home, ref);
    if (!ancestorsExist(io, home, proposals)) return { kind: "wake" };
    try {
      if (!io.lstatSync(proposals).isDirectory()) return skipped("DIR_ANOMALY");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "wake" };
      return skipped("DIR_ANOMALY");
    }
    const dir = fs.opendirSync(proposals);
    let empty: boolean;
    let closeFailed = false;
    try {
      empty = dir.readSync() === null;
    } finally {
      try { dir.closeSync(); } catch { closeFailed = true; }
    }
    // A close that fails is an I/O error: it can never turn "empty" into a wake. A refusal found below is kept.
    if (empty) return closeFailed ? skipped("DIR_ANOMALY") : { kind: "wake" };
    const latest = latestSlotAttempt(runDir, slot, maxScan);
    if (latest.kind === "found" && (latest.claim === "output_ready" || latest.claim === "committed" || latest.claim === "abandoned" || latest.attempt.status === "failed")) {
      return skipped("RESIDUAL_OUTPUT");
    }
    return skipped("UNDETERMINABLE");
  } catch (e) {
    return skipped(e instanceof ApprovalError && (e.code === "UNSAFE_PATH" || e.code === "IO_ERROR") ? "DIR_ANOMALY" : "UNDETERMINABLE");
  }
}

// ---- side file ----

export interface GateEntry { class: "refused" | "skipped"; code: GateCode; at: string }
const CODES = ["PROJECT_MISSING", "PROJECT_PATH_MISMATCH", "AGENT_MISSING", "EXECUTOR_MISSING", "NOT_ALLOWED", "PREMISE_FAILED", "SNAPSHOT_MISMATCH",
  "CONFIG_INVALID", "ORIGIN_UNREADABLE", "NO_BASELINE", "DIR_ANOMALY", "RESIDUAL_OUTPUT", "UNDETERMINABLE"] as const satisfies readonly GateCode[];
const GateFile = z.strictObject({
  schema_version: z.literal(1),
  slots: z.record(z.string(), z.strictObject({ class: z.enum(["refused", "skipped"]), code: z.enum(CODES), at: z.string() })),
});

/** Atomic whole-file write of the current reasons. Throws on I/O failure; the caller decides what a failed record means. */
export function writeGateFile(runDir: string, slots: Readonly<Record<string, GateEntry>>): void {
  atomicWrite(path.join(runDir, GATE_FILE), `${JSON.stringify({ schema_version: 1, slots }, null, 2)}\n`);
}

/** undefined: no file. 'unreadable': anything that is not a complete v1 file (FIFO, symlink, over 64 KiB, bad JSON, unknown version). */
export function readGateFile(runDir: string): { slots: Record<string, GateEntry> } | "unreadable" | undefined {
  const r = readRegularFileCappedNoFollow(path.join(runDir, GATE_FILE), GATE_FILE_LIMIT);
  if (!r.ok) return r.reason === "open_error:ENOENT" ? undefined : "unreadable";
  if (r.truncated) return "unreadable";
  try {
    const parsed = GateFile.safeParse(JSON.parse(r.buf.toString("utf8")));
    return parsed.success ? { slots: parsed.data.slots as Record<string, GateEntry> } : "unreadable";
  } catch {
    return "unreadable";
  }
}

// ---- recovery preflight (R2) and `call` ----

const RECOVERY_SCAN_CAP = 100_000;
/** `<claim id>.json` and `<claim id>-a<n>.json`, where a claim id is `<base36>-<agent>-<6 hex>`: names only select whose file it is. */
const MAIL_FILE = /^[0-9a-z]+-(.+)-[0-9a-f]{6}(?:-a\d+)?\.json$/;

/** True for the claim or attempt file name of one of `slots`: what recovery must not open for a quarantined slot. */
export function slotFileFilter(slots: ReadonlySet<string>): (name: string) => boolean {
  return (name) => {
    const agent = MAIL_FILE.exec(name)?.[1];
    return agent !== undefined && slots.has(agent);
  };
}

/**
 * Before `recoverRunMail` reads anything: which of `slots` own an attempt or claim file that is damaged, not a regular file, over 64 KiB,
 * ambiguous or too many to scan. Those slots are not woken in this process (and recovery leaves their files alone); a later run or resume looks again.
 * Files of other agents are never opened. Never throws, never blocks.
 */
export function quarantinedSlots(runDir: string, slots: readonly string[]): Set<string> {
  const bad = new Set<string>();
  for (const slot of slots) {
    try {
      if (latestSlotAttempt(runDir, slot, RECOVERY_SCAN_CAP).kind === "undeterminable") bad.add(slot);
    } catch {
      bad.add(slot);
    }
  }
  const dirPath = path.join(mailDir(runDir), "claims");
  let dir: fs.Dir | undefined;
  try {
    dir = fs.opendirSync(dirPath);
    let count = 0;
    for (let ent = dir.readSync(); ent !== null; ent = dir.readSync()) {
      const slot = MAIL_FILE.exec(ent.name)?.[1];
      if (slot === undefined || !slots.includes(slot) || bad.has(slot)) continue;
      if (++count > RECOVERY_SCAN_CAP) { for (const s of slots) bad.add(s); break; }
      const r = readRegularFileCappedNoFollow(path.join(dirPath, ent.name), GATE_FILE_LIMIT);
      let ok = r.ok && !r.truncated;
      if (r.ok && ok) {
        try {
          const j = JSON.parse(r.buf.toString("utf8")) as { agent?: unknown; status?: unknown };
          ok = j.agent === slot && typeof j.status === "string";
        } catch {
          ok = false;
        }
      }
      if (!ok) bad.add(slot);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") for (const s of slots) bad.add(s);
  }
  try {
    dir?.closeSync();
  } catch {
    for (const s of slots) bad.add(s);
  }
  return bad;
}

/** `call`: the premises and containment for one enrolled global agent, judged like doctor does. No hash and no request directory: the call is new. */
export function callGateVerdict(o: { home: string; agent: ResolvedAgent; userHome: string; premise: PremiseOptions; io?: ApprovalIo }): GateVerdict {
  try {
    const cfg = loadFreshConfig(o.home, { io: o.io ?? defaultApprovalIo, userHome: o.userHome });
    if (!cfg.ok) return refused("CONFIG_INVALID");
    const failed: PremiseId[] = [];
    if (agentPremiseChecks(`call/${o.agent.name}`, o.agent, o.premise).some((c) => c.level === "error")) failed.push("project-premises");
    if (approvalContainmentChecks(o.home, cfg.config, { platform: o.premise.platform, userHome: o.userHome }).checks.some((c) => c.level === "error")) failed.push("containment");
    return failed.length ? refused("PREMISE_FAILED", failed) : { kind: "wake" };
  } catch {
    return refused("CONFIG_INVALID");
  }
}
