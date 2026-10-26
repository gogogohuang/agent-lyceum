import crypto from "node:crypto";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import path from "node:path";
import { NAME_RE, isInside } from "./paths.js";
import type { WorkspaceMode } from "./worktree.js";

// Same-role dynamic instances (docs/specs/23-dynamic-instances.md). Pure functions only: the caller injects every file read.

/** Instances one role may have at the same time when `dispatcher.max_instances` is not written. */
export const DEFAULT_MAX_INSTANCES = 4;

/** Instance 1 is the role itself; the others are `<role>--<k>`. */
export const slotName = (role: string, k: number): string => (k === 1 ? role : `${role}--${k}`);

/** `<role>--<k>` with k >= 2 (no leading zero) → its parts. A name like `fe--x` is just an agent, never an instance. */
export function parseSlotName(name: string): { role: string; k: number } | undefined {
  const m = /^(.+)--([2-9]|[1-9]\d+)$/.exec(name);
  return m?.[1] && m[2] ? { role: m[1], k: Number(m[2]) } : undefined;
}

export interface InstanceCap {
  /** How many instances the role may have at once (1 = no parallel). */
  n: number;
  /** Why `n` is 1 (or lower than configured); set whenever the limit is not simply the configured one. */
  reason?: string;
}

type CapProject = Pick<ResolvedProject, "lead" | "solo" | "run" | "dispatcher"> & { agents: Record<string, unknown> };

/**
 * The most instances `role` may have in this run. `check(role, k)` is the caller's extra refusal for slot k (a path
 * overlap, spec D-17): it returns a reason, and the cap stops before that slot. `opened` are instance names already in the
 * run's slot table; they are not name clashes even though a bound project lists them among its agents.
 */
export function instanceCap(
  project: CapProject,
  mode: WorkspaceMode,
  role: string,
  check?: (role: string, k: number) => string | undefined,
  opened: readonly string[] = [],
): InstanceCap {
  if (mode !== "worktree") return { n: 1, reason: "agents take turns in the checkout, not in separate git worktrees" };
  if (project.solo) return { n: 1, reason: "a single agent runs alone" };
  if (project.run?.layout !== "run") return { n: 1, reason: "this run uses the legacy mailbox layout" };
  if (role === project.lead) return { n: 1, reason: `the lead (${role}) is never run as several instances` };
  if (!NAME_RE.test(role)) return { n: 1, reason: `"${role}" is not a valid branch name, so its instances cannot be named` };
  const max = project.dispatcher.max_instances ?? DEFAULT_MAX_INSTANCES;
  for (let k = 2; k <= max; k++) {
    const name = slotName(role, k);
    if (name in project.agents && !opened.includes(name)) return { n: k - 1, reason: `agent "${name}" has the name instance ${k} of "${role}" would get, so "${role}" runs at most ${k - 1} instance(s) at a time` };
    const refused = check?.(role, k);
    if (refused) return { n: k - 1, reason: `instance ${k} of "${role}" ${refused}` };
  }
  return { n: max };
}

export type ParallelFlag = "absent" | "invalid" | "on" | { ignored: string };

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

/**
 * What a mail's `parallel` field means (spec 23.3). `senderIsLead` is the router's own knowledge (the outbox owner), never the
 * mail's `from`. `invalid` is a lead's mistake (the mail is sent back); `ignored` mail is delivered as an ordinary one.
 */
export function parallelFlag(input: { value: unknown; senderIsLead: boolean; type: string; replyTo?: unknown; thread?: unknown; cap: InstanceCap }): ParallelFlag {
  const { value } = input;
  if (value === undefined) return "absent";
  if (!input.senderIsLead) return { ignored: "not-lead" };
  if (typeof value !== "boolean") return "invalid";
  if (!value) return "absent";
  if (input.type !== "task" || present(input.replyTo) || present(input.thread)) return { ignored: "not-a-new-task" };
  if (input.cap.n <= 1) return { ignored: `parallel tasks run one at a time in this run${input.cap.reason ? `: ${input.cap.reason}` : ""}` };
  return "on";
}

// ---- who owns a message (affinity) ----

/** What the route journal holds about one message id; every field is written by the dispatcher, never read from mail text. */
export interface OwnerRecord {
  /** Slot the assigner placed it in. */
  assign?: string;
  /** Instance that sent it. */
  from?: string;
  /** Instance a dispatcher notice is about. */
  about?: string;
  /** Its delivery (intent) line: order in the journal, recipient, inbox file name, route source key. */
  intent?: { seq: number; to: string; file: string; source: string; msg_id: string };
}

export interface OwnersCtx {
  /** `state.instances.roles[role]`: the role's open instances, `[0]` is the role itself. */
  opened: readonly string[];
  rec: (id: string) => OwnerRecord | undefined;
  /** Journal position of the role's first held intent (its activation); undefined while it is not in the journal yet. */
  mark: number | undefined;
  /** `agent` of `mail/claims/<id>.json`; undefined when there is no readable claim. */
  claimAgent: (claimId: string) => string | undefined;
}

/**
 * The instance of `role` that owns message `id`, so a revision goes back to it (spec 23.7.2 rule 1). Only instances the role has
 * open count, then assign > from > about. Work from before the role was activated that involves it by name belongs to instance 1.
 */
export function ownersOf(id: string, role: string, ctx: OwnersCtx): string | undefined {
  const r = ctx.rec(id);
  if (!r) return undefined;
  for (const slot of [r.assign, r.from, r.about]) if (slot !== undefined && ctx.opened.includes(slot)) return slot;
  if (r.intent && (ctx.mark === undefined || r.intent.seq < ctx.mark) && involves(r.intent, role, ctx.claimAgent)) return ctx.opened[0] ?? role;
  return undefined;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a delivery already in the journal concerns `role` by its own name: sent to it, sent by it, or a dispatcher notice about
 * it (a failed integration or a refused worktree). Uses only what the dispatcher wrote: journal fields and claim records.
 */
export function involves(intent: { to: string; file: string; source: string; msg_id: string }, role: string, claimAgent: (claimId: string) => string | undefined): boolean {
  if (intent.to === role) return true;
  // the file is `<stamp>-<from>-<msg_id>.md` and a stamp has no "-", so what follows the first "-" is the sender
  const tail = `-${intent.msg_id}.md`;
  if (intent.file.endsWith(tail)) {
    const head = intent.file.slice(0, -tail.length);
    const dash = head.indexOf("-");
    if (dash > 0 && head.slice(dash + 1) === role) return true;
  }
  if (intent.source.startsWith("integration:")) {
    const key = intent.source.slice("integration:".length);
    if (!key || key.includes("/") || key.includes("\\") || key.includes("..")) return false;
    const agent = claimAgent(key);
    if (agent !== undefined) return agent === role;
    return new RegExp(`^${escapeRe(role)}-\\d+$`).test(key);
  }
  if (intent.source.startsWith("refused:")) {
    const parts = intent.source.split(":");
    return parts.length >= 3 && parts[parts.length - 1] === role;
  }
  return false;
}

// ---- the assigner ----

/** A message waiting in `mail/inbox/<role>/pending/`, as the journal describes it. */
export interface HeldMsg {
  file: string;
  id: string;
  /** The recipient name on the mail: the role or one of its instances. */
  to: string;
  replyTo?: string;
  thread?: string;
  /** The journal says the lead marked it `parallel: true`. */
  parallel: boolean;
}

export type Acceptance = true | "blocked" | "refused" | "cap";

export interface PlanInput {
  role: string;
  /** Waiting mail in delivery (file name) order. */
  held: readonly HeldMsg[];
  /** The role's open instances, `[0]` is the role itself. */
  opened: readonly string[];
  /** Effective instance limit. */
  cap: number;
  /** `ownersOf(id, role)` with everything but the id bound. */
  owners: (id: string) => string | undefined;
  /** The slot the journal already recorded for a message. */
  recorded: (id: string) => string | undefined;
  /** Whether a slot may take a new thread (not refused, not blocked, within the cap). */
  acceptsNew: (slot: string) => Acceptance;
  /** The slot's inbox has unread mail. */
  busy: (slot: string) => boolean;
  /** The role's primary model is cooling down after a rate limit. */
  coolingDown: boolean;
  /** Whether a new instance of that name may be opened. */
  mayOpen: (name: string) => true | "collision" | "containment";
}

export interface Assignment {
  file: string;
  slot: string;
  rule: "recorded" | "affinity" | "addressed" | "parallel" | "default";
  /** Set when the slot has to be opened first. */
  open?: string;
  /** Set when an affinity placed a message addressed to another instance. */
  addressed?: string;
}

export interface Plan {
  assign: Assignment[];
  waiting: { file: string; reason: string }[];
}

/**
 * Where each waiting message of one role goes (spec 23.7.2). A decision never depends on a later message; a message that has to
 * wait only holds back the new threads behind it for the same destination.
 */
export function planAssignments(input: PlanInput): Plan {
  const opened = [...input.opened];
  const taken = new Set<string>();
  const out: Plan = { assign: [], waiting: [] };
  // Where this plan already put each message: a later mail of the same batch that replies to it follows it before the journal is asked.
  const planned = new Map<string, string>();
  const place = (m: HeldMsg, a: Assignment) => {
    taken.add(a.slot);
    planned.set(m.id, a.slot);
    out.assign.push(a);
  };
  let parallelWait: string | undefined;
  const wait = (m: HeldMsg, reason: string) => out.waiting.push({ file: m.file, reason });
  for (const m of input.held) {
    const done = input.recorded(m.id);
    if (done !== undefined) {
      place(m, { file: m.file, slot: done, rule: "recorded" });
      continue;
    }
    let owner: string | undefined;
    for (const c of [m.replyTo, m.thread]) {
      if (!c || c === m.id) continue;
      owner = planned.get(c) ?? input.owners(c);
      if (owner !== undefined) break;
    }
    if (owner !== undefined) {
      place(m, { file: m.file, slot: owner, rule: "affinity", ...(m.to !== input.role && m.to !== owner ? { addressed: m.to } : {}) });
      continue;
    }
    if (m.to !== input.role) {
      const a = opened.includes(m.to) ? input.acceptsNew(m.to) : "unknown-slot";
      if (a === true) {
        place(m, { file: m.file, slot: m.to, rule: "addressed" });
      } else wait(m, a);
      continue;
    }
    if (m.parallel) {
      if (parallelWait !== undefined) {
        wait(m, parallelWait);
        continue;
      }
      const free = opened.find((s) => input.acceptsNew(s) === true && !input.busy(s) && !taken.has(s));
      if (free !== undefined) {
        place(m, { file: m.file, slot: free, rule: "parallel" });
        continue;
      }
      let why: string | undefined;
      if (opened.length < input.cap) {
        const name = slotName(input.role, opened.length + 1);
        const may = input.coolingDown ? "cooldown" : input.mayOpen(name);
        if (may === true) {
          opened.push(name);
          place(m, { file: m.file, slot: name, rule: "parallel", open: name });
          continue;
        }
        why = may;
      } else why = opened.some((s) => input.acceptsNew(s) === true) ? "busy" : "cap";
      parallelWait = why;
      wait(m, why);
      continue;
    }
    const a = input.acceptsNew(input.role);
    if (a === true) {
      place(m, { file: m.file, slot: input.role, rule: "default" });
    } else wait(m, a);
  }
  return out;
}

// ---- binding, presentation, resume ----

/** A run's slot table: `roles[<role>]` lists the role's open instances, `[0]` is the role itself. */
export interface SlotTable {
  roles: Record<string, string[]>;
}

/**
 * The agents of a run with its opened instances added (spec 23.6): each `<role>--<k>` follows its role, copies the role's settings, keeps only
 * its own task memory (the role's global/project memory become read-only `sharedMemory`) and cannot edit AGENT.md. Roles of the table that
 * are not agents any more are skipped (a resume refuses those before it binds, `assertInstancesResumable`).
 */
export function synthesizeSlots(agents: Record<string, ResolvedAgent>, table: SlotTable, taskMemory: (slot: string) => string): Record<string, ResolvedAgent> {
  const out: Record<string, ResolvedAgent> = {};
  for (const [name, a] of Object.entries(agents)) {
    const slots = table.roles[name];
    if (!slots) {
      out[name] = a;
      continue;
    }
    out[name] = { ...a, instance: { role: name, k: 1 } };
    for (const slot of slots) {
      const parsed = parseSlotName(slot);
      if (!parsed || parsed.role !== name) continue;
      out[slot] = {
        ...a,
        name: slot,
        memory: { task: taskMemory(slot) },
        sharedMemory: { ...(a.memory.global ? { global: a.memory.global } : {}), ...(a.memory.project ? { project: a.memory.project } : {}) },
        canEditAgentMd: false,
        instance: { role: name, k: parsed.k },
      };
    }
  }
  return out;
}

/** The role an agent name stands for: the role itself, or the role of a bound instance. */
export const roleOfName = (agents: Record<string, { instance?: { role: string } } | undefined>, name: string): string => agents[name]?.instance?.role ?? name;

/** How the lead is told who a mail came from (decision 8): a bound instance of a role with several shows its role and number. */
export function senderLabel(name: string, agents: Record<string, { instance?: { role: string; k: number } } | undefined>): string {
  const i = agents[name]?.instance;
  return i ? `${name} (${i.role}, instance ${i.k})` : name;
}

/** Key of the one failure sent to the lead about this set of waiting mails (spec D-16). */
export const heldStallKey = (ids: readonly string[]): string => `held-stall:${crypto.createHash("sha256").update([...ids].sort().join("\n")).digest("hex").slice(0, 16)}`;

/**
 * Refuse, before anything is written, to resume a run whose slot table no longer fits the configuration (spec 23.10): a role that
 * is gone or is now the lead, an instance name that is now a configured agent, or an opened instance `check` finds a conflict for.
 */
export function assertInstancesResumable(
  base: { lead: string; agents: Record<string, unknown> },
  table: SlotTable,
  runId: string,
  projectName: string,
  check?: (role: string, k: number) => string | undefined,
): void {
  for (const [role, slots] of Object.entries(table.roles)) {
    if (!(role in base.agents)) {
      throw new Error(`Run ${runId} has instances of "${role}", which is no longer an agent of project ${projectName}. Add "${role}" back to project.yaml to finish or resume this run, or clear it.`);
    }
    if (role === base.lead) throw new Error(`Run ${runId} has instances of "${role}", which is now the lead of project ${projectName}; the lead never runs as several instances. Make "${role}" a member again to resume this run, or clear it.`);
    for (const slot of slots.slice(1)) {
      if (slot in base.agents) throw new Error(`Run ${runId} has the instance "${slot}" of "${role}", but project ${projectName} now has an agent of that name. Rename that agent to resume this run, or clear it.`);
      const parsed = parseSlotName(slot);
      const conflict = parsed ? check?.(role, parsed.k) : undefined;
      if (conflict) throw new Error(`Run ${runId} cannot be resumed: ${slot} ${conflict}`);
    }
  }
}

// ---- containment of the shared memory (spec 23.11, D-17) ----

/** Every directory an instance can write: what its policy allows, the folders of the files it may edit, and its working directory. */
export const slotWritableRoots = (pol: { allowDirs: readonly string[]; allowFiles: readonly string[] }, work: readonly string[]): string[] => [
  ...new Set([...pol.allowDirs, ...pol.allowFiles.map((f) => path.dirname(f)), ...work]),
];

/**
 * The first pair of (shared memory path, writable root) where one contains the other, or undefined. `canon` resolves symlinks (the caller injects
 * it); `caseInsensitive` compares in lower case (macOS volumes), which can only report a conflict that is not one, never miss one.
 */
export function containmentConflict(
  shared: readonly string[],
  roots: readonly string[],
  canon: (p: string) => string,
  caseInsensitive: boolean,
): { shared: string; root: string } | undefined {
  const norm = (p: string): string => (caseInsensitive ? canon(p).toLowerCase() : canon(p));
  for (const s of shared) {
    const cs = norm(s);
    for (const w of roots) {
      const cw = norm(w);
      if (isInside(cs, cw) || isInside(cw, cs)) return { shared: s, root: w };
    }
  }
  return undefined;
}
