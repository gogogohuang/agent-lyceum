import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { storePaths } from "./approval-paths.js";
import type { ExecutorsConfig } from "./approval-executors.js";
import { CALL_PROJECT, callProject } from "./call.js";
import { type ResolvedAgent, type ResolvedProject, resolveProjectFrom } from "./config.js";
import type { DoctorCheck } from "./doctor.js";
import { agentForCandidate, candidatesFor } from "./fallback.js";
import { canonicalPath, homePaths, isInside, projectPaths } from "./paths.js";
import { writePolicy } from "./policy.js";
import { GlobalConfig, ProjectConfig } from "./schema.js";

/** Result of the global (all projects, all calls) part of premise 2. `calls` are the resolved global agents, as a `call` would run them. */
export interface ApprovalInventory {
  checks: DoctorCheck[];
  calls: { role: string; agent: ResolvedAgent }[];
}

export interface ApprovalContainmentOptions {
  /** Reserved: `~` in project configs is expanded by `resolveProjectFrom` from the process environment, as in every other path. */
  userHome?: string;
  platform?: NodeJS.Platform;
}

const MAX_CONFIG_BYTES = 1024 * 1024;
const HEADER_BYTES = 4096;
const MAX_WALK_ENTRIES = 20000;
const MAX_WALK_DEPTH = 8;

const STEM_INCOMPLETE = "Approval containment scan is incomplete:";
const STEM_OVERLAP = "Approval protected path overlaps an agent writable range:";
const STEM_UNVERIFIED = "Approval executable or path cannot be verified:";
const STEM_CWD = "Approval containment does not validate future call --dir values:";

const NATIVE_MAGIC = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], // Mach-O
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal
];

const code = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? (e as Error).message;

/** Like `canonicalPath`, but any realpath error other than ENOENT/ENOTDIR throws (the check then reports "cannot be verified"). */
function strictCanonical(p: string): string {
  for (let head = path.resolve(p); ; head = path.dirname(head)) {
    try {
      fs.realpathSync.native(head);
      break;
    } catch (e) {
      const c = (e as NodeJS.ErrnoException).code;
      if (c !== "ENOENT" && c !== "ENOTDIR") throw new Error(`cannot resolve ${head} (${c ?? (e as Error).message})`);
      if (path.dirname(head) === head) break;
    }
  }
  return canonicalPath(p);
}

/** Bounded regular-file read: nofollow, nonblocking, size-capped, always closed. Throws an Error naming the problem. */
function readBounded(file: string, limit: number): Buffer {
  const c = fs.constants;
  let fd: number;
  try {
    fd = fs.openSync(file, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK);
  } catch (e) {
    throw new Error(code(e) === "ELOOP" ? "is a symlink" : code(e) === "ENOENT" ? "is missing" : `cannot be opened (${code(e)})`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error("is not a regular file");
    if (st.size > limit) throw new Error(`is larger than ${limit} bytes`);
    const buf = Buffer.alloc(limit + 1);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > limit) throw new Error(`is larger than ${limit} bytes`);
    }
    return buf.subarray(0, total);
  } finally {
    try { fs.closeSync(fd); } catch { /* the read result already decided */ }
  }
}

function readYamlSafe<T>(file: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }): T {
  const text = readBounded(file, MAX_CONFIG_BYTES).toString("utf8");
  let raw: unknown;
  try {
    raw = YAML.parse(text) ?? {};
  } catch (e) {
    throw new Error(`is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new Error(`is invalid: ${i?.path.join(".") || "(root)"}: ${i?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/** `oneWay`: a symlink hop or its directory. Only a grant that equals or contains it matters (a grant inside it cannot replace the link). */
interface Protected { kind: string; src: string; canon: string; oneWay?: true }
interface Grant { who: string; setting: string; src: string; canon: string }

const MAX_HOPS = 40;

/** True when an absolute spelling has a `.`, `..` or empty component (other than the leading root): `link/..` would be erased before the link is followed. */
function hasDotComponent(p: string): boolean {
  return p.split(path.sep).slice(1).some((c, i, all) => c === "." || c === ".." || (c === "" && !(all.length === 1 && i === 0 && p === path.sep)));
}
const DOT_REASON = "path contains '.' or '..' components (or an empty one, '//'); spell it without them";

/** JSON-style escape of C0/C1 control characters and DEL, so a path or file-derived string cannot steer a terminal. */
export function escapeControl(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.charCodeAt(0);
    out += n < 0x20 || (n >= 0x7f && n <= 0x9f) ? `\\u${n.toString(16).padStart(4, "0")}` : ch;
  }
  return out;
}

/**
 * Resolve `input` component by component (lstat + readlink, at most MAX_HOPS links, loops are an error). Returns every symlink
 * that was followed, in order: each is a place whose replacement redirects the path. A missing tail is not an error.
 */
function symlinkHops(input: string): string[] {
  const hops: string[] = [];
  let pending = path.resolve(input).split(path.sep).filter(Boolean);
  let cur: string = path.sep;
  while (pending.length > 0) {
    const comp = pending[0] as string;
    pending = pending.slice(1);
    if (comp === ".") continue;
    if (comp === "..") {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, comp);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch (e) {
      if (["ENOENT", "ENOTDIR"].includes(code(e))) break;
      throw new Error(`cannot resolve ${next} (${code(e)})`);
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    if (hops.length >= MAX_HOPS) throw new Error(`more than ${MAX_HOPS} symlinks (a loop?) while resolving ${input}`);
    hops.push(next);
    const target = fs.readlinkSync(next);
    if (path.isAbsolute(target)) cur = path.sep;
    pending = [...target.split(path.sep).filter(Boolean), ...pending];
  }
  return hops;
}

/** Header facts of an executable file; throws an Error naming what is wrong. Never executes anything. */
function inspectExecutableFile(file: string): { real: string; shebang: string[] | undefined } {
  const real = fs.realpathSync.native(file);
  for (const dir of new Set([path.dirname(file), path.dirname(real)])) {
    const dm = fs.statSync(dir).mode;
    if (dm & 0o002) throw new Error(`directory ${dir} is world-writable`);
  }
  const c = fs.constants;
  const fd = fs.openSync(real, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${real} is not a regular file`);
    if (!(st.mode & 0o111)) throw new Error(`${real} is not executable`);
    if (st.mode & 0o002) throw new Error(`${real} is world-writable`);
    if (st.nlink > 1) throw new Error(`${real} has ${st.nlink} hard links (another name for the same file may be writable)`);
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    const head = buf.subarray(0, n);
    if (head[0] === 0x23 && head[1] === 0x21) {
      const nl = head.indexOf(0x0a);
      if (nl < 0) throw new Error(`${real} has a #! line longer than ${HEADER_BYTES} bytes`);
      const parts = head.subarray(2, nl).toString("utf8").trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0 || parts.length > 2) throw new Error(`${real} has a #! line this check does not support (an interpreter and at most one argument)`);
      return { real, shebang: parts };
    }
    if (NATIVE_MAGIC.some((m) => m.every((b, i) => head[i] === b))) return { real, shebang: undefined };
    throw new Error(`${real} is neither a #! script nor a recognised native binary (ELF/Mach-O)`);
  } finally {
    fs.closeSync(fd);
  }
}

/** The protected set of one executor command: spellings, real paths, their directories, and a direct absolute interpreter. */
function protectedFor(name: string, command: string, add: (kind: string, p: string) => void, unverified: (msg: string) => void): void {
  const label = `executor "${name}" command`;
  if (hasDotComponent(command)) {
    unverified(`${label} ${command}: ${DOT_REASON}`);
    return;
  }
  add(label, command);
  let info: { real: string; shebang: string[] | undefined };
  try {
    info = inspectExecutableFile(command);
  } catch (e) {
    unverified(`${label} ${command}: ${(e as Error).message.replace(/^(ENOENT|EACCES|ELOOP)[^:]*: /, "")}${code(e) === "ENOENT" ? " (missing)" : ""}`);
    return;
  }
  add(`${label} real path`, info.real);
  add(`${label} directory`, path.dirname(command));
  add(`${label} real directory`, path.dirname(info.real));
  if (!info.shebang) return;
  const interp = info.shebang[0] as string;
  if (!path.isAbsolute(interp)) {
    unverified(`${label} ${command}: interpreter "${interp}" is not an absolute path`);
    return;
  }
  if (path.basename(interp) === "env") {
    unverified(`${label} ${command}: "#!${interp}" resolves the interpreter through PATH`);
    return;
  }
  const ilabel = `${label} interpreter`;
  if (hasDotComponent(interp)) {
    unverified(`${ilabel} ${interp}: ${DOT_REASON}`);
    return;
  }
  add(ilabel, interp);
  try {
    const i = inspectExecutableFile(interp);
    if (i.shebang) {
      unverified(`${ilabel} ${interp} is itself a script (nested interpreters are not followed)`);
      return;
    }
    add(`${ilabel} real path`, i.real);
    add(`${ilabel} directory`, path.dirname(interp));
    add(`${ilabel} real directory`, path.dirname(i.real));
  } catch (e) {
    unverified(`${ilabel} ${interp}: ${(e as Error).message}`);
  }
}

/** `git rev-parse --git-common-dir` of `cwd`; undefined when `cwd` is not in a checkout; throws when it is but git cannot say. */
function gitCommonDir(cwd: string): string | undefined {
  if (!fs.existsSync(cwd)) return undefined;
  const inCheckout = (): boolean => {
    for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, ".git"))) return true;
      if (path.dirname(d) === d) return false;
    }
  };
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
    if (out) return path.resolve(cwd, out);
  } catch (e) {
    if (!inCheckout()) return undefined;
    throw new Error(`git rev-parse --git-common-dir failed in ${cwd}: ${(e as Error).message.split("\n")[0]}`);
  }
  if (inCheckout()) throw new Error(`git rev-parse --git-common-dir printed nothing in ${cwd}`);
  return undefined;
}

/**
 * Symlinks below `root`, as their own paths, including those below the target directory of a symlink (a chain such as
 * `runs/first -> outside`, `outside/mail/outbox/dev -> exe`). Directories are visited once (device+inode), so cycles end.
 * Throws when the tree is larger or deeper than the bounds, so coverage is never silently partial.
 */
function aliasesBelow(root: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  let seen = 0;
  const visit = (dir: string): boolean => {
    const st = fs.statSync(dir);
    const key = `${st.dev}:${st.ino}`;
    if (visited.has(key)) return false;
    visited.add(key);
    return true;
  };
  const walk = (dir: string, depth: number): void => {
    if (!visit(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++seen > MAX_WALK_ENTRIES) throw new Error(`more than ${MAX_WALK_ENTRIES} entries below ${root}`);
      const p = path.join(dir, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        out.push(p);
        try {
          isDir = fs.statSync(p).isDirectory();
        } catch {
          isDir = false; // dangling or looping link: its own path is already an alias grant
        }
      }
      if (isDir) {
        if (depth >= MAX_WALK_DEPTH) throw new Error(`deeper than ${MAX_WALK_DEPTH} levels below ${root}`);
        walk(p, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Premise 2 of the approval gate, global part (spec section 3, item 2): no protected path (`approvals/`, `requests/`, `executors.yaml`,
 * each executor command, its real path and directory, a direct interpreter) may equal, contain or lie inside a path ANY agent of ANY
 * project, or any global agent run as a `call`, can write. Read-only: nothing is executed or created. Overlaps are conservative
 * (either direction, allowFiles included): they are not proof that the agent could change the file. This is a configuration
 * diagnostic, not enforcement, and it cannot see a future `call --dir`.
 */
export function approvalContainmentChecks(home: string, config: ExecutorsConfig, opts: ApprovalContainmentOptions = {}): ApprovalInventory {
  const platform = opts.platform ?? process.platform;
  const checks: DoctorCheck[] = [];
  const push = (stem: string, msg: string): void => void checks.push({ level: "error", subject: "approval", message: escapeControl(`${stem} ${msg}`) });
  const incomplete = (msg: string): void => push(STEM_INCOMPLETE, msg);
  const unverified = (msg: string): void => push(STEM_UNVERIFIED, msg);
  const norm = (p: string): string => (platform === "darwin" ? p.toLowerCase() : p);

  // 1. The protected set.
  const prot: Protected[] = [];
  const addProtected = (kind: string, src: string): void => {
    try {
      prot.push({ kind, src, canon: strictCanonical(src) });
    } catch (e) {
      unverified(`${kind} ${src}: ${(e as Error).message}`);
      return;
    }
    let hops: string[];
    try {
      hops = symlinkHops(src);
    } catch (e) {
      unverified(`${kind} ${src}: ${(e as Error).message}`);
      return;
    }
    for (const hop of hops) {
      try {
        const dir = strictCanonical(path.dirname(hop));
        prot.push({ kind: `${kind} symlink hop`, src: hop, canon: path.join(dir, path.basename(hop)), oneWay: true });
        prot.push({ kind: `${kind} symlink hop directory`, src: path.dirname(hop), canon: dir, oneWay: true });
      } catch (e) {
        unverified(`${kind} symlink hop ${hop}: ${(e as Error).message}`);
      }
    }
  };
  if (hasDotComponent(home)) {
    unverified(`approval store home ${home}: ${DOT_REASON}`);
  } else {
    const sp = storePaths(home);
    addProtected("approvals directory", sp.approvals);
    addProtected("requests directory", sp.requests);
    addProtected("executors.yaml", sp.executors);
  }
  for (const [name, e] of Object.entries(config.executors).sort(([a], [b]) => a.localeCompare(b))) {
    protectedFor(name, e.command[0], addProtected, unverified);
  }

  // 2. The inventory, from bounded reads of the config files.
  const hp = homePaths(home);
  const calls: ApprovalInventory["calls"] = [];
  const grants: Grant[] = [];
  const seenGrant = new Set<string>();
  const addGrant = (who: string, setting: string, src: string): void => {
    const key = `${who}\0${setting}\0${src}`;
    if (seenGrant.has(key)) return;
    seenGrant.add(key);
    try {
      grants.push({ who, setting, src, canon: strictCanonical(src) });
    } catch (e) {
      unverified(`${who} ${setting} ${src}: ${(e as Error).message}`);
    }
  };
  const envelope = (who: string, setting: string, dir: string, walk = true): void => {
    addGrant(who, `${setting} (conservative envelope)`, dir);
    if (!walk) return; // git checkouts are not alias-walked (D19): only the root is a grant
    let found: string[];
    try {
      found = aliasesBelow(dir);
    } catch (e) {
      if (["ENOENT", "ENOTDIR"].includes(code(e))) return;
      incomplete(`cannot cover aliases below ${setting} ${dir} for ${who}: ${code(e) === (e as Error).message ? (e as Error).message : code(e)}`);
      return;
    }
    for (const a of found) addGrant(who, `${setting} alias (conservative envelope)`, a);
  };

  let global: ReturnType<typeof GlobalConfig.parse> | undefined;
  try {
    global = readYamlSafe(hp.globalConfig, GlobalConfig);
  } catch (e) {
    incomplete(`global config ${hp.globalConfig} ${(e as Error).message}`);
  }

  const projects = new Map<string, ResolvedProject>();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(hp.projectsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    if (code(e) !== "ENOENT") incomplete(`projects directory ${hp.projectsDir} cannot be listed (${code(e)})`);
  }
  for (const ent of entries) {
    const pp = projectPaths(home, ent.name);
    if (!ent.isDirectory()) {
      incomplete(`project entry ${pp.root} is not a real directory (a symlink or file)`);
      continue;
    }
    if (!global) continue;
    try {
      const raw = readYamlSafe(pp.config, ProjectConfig);
      projects.set(ent.name, resolveProjectFrom(home, ent.name, global, raw));
    } catch (e) {
      incomplete(`project "${ent.name}" config ${pp.config} ${(e as Error).message}`);
    }
  }

  // Every agent of every project, primary and each fallback candidate.
  for (const [pname, project] of [...projects].sort(([a], [b]) => a.localeCompare(b))) {
    const who = (a: string): string => `project "${pname}" agent "${a}"`;
    envelope(`project "${pname}"`, "task-memory", project.paths.taskMemory);
    envelope(`project "${pname}"`, "runs", project.paths.runs);
    envelope(`project "${pname}"`, "worktrees", path.join(project.paths.root, "worktrees"), false);
    try {
      const common = gitCommonDir(project.dir);
      if (common) envelope(`project "${pname}"`, "git common dir", common);
    } catch (e) {
      incomplete(`${(e as Error).message}; project "${pname}" worktree admin directories are not covered`);
    }
    for (const [aname, agent] of Object.entries(project.agents).sort(([a], [b]) => a.localeCompare(b))) {
      const cands = agent.runtime ? candidatesFor(agent) : [];
      const variants = cands.length ? cands.map((c, i) => ({ label: c.primary ? "primary" : `fallback ${i}`, agent: agentForCandidate(agent, c) })) : [{ label: "primary", agent }];
      for (const v of variants) {
        const tag = v.label === "primary" ? who(aname) : `${who(aname)} (${v.label})`;
        const pol = writePolicy(project, v.agent);
        for (const d of pol.allowDirs) addGrant(tag, "write allowDirs", d);
        for (const f of pol.allowFiles) addGrant(tag, "write allowFiles", f);
        addGrant(tag, "project dir", project.dir);
        addGrant(tag, "worktrees root", path.join(project.paths.root, "worktrees"));
        for (const w of v.agent.sandbox?.write ?? []) addGrant(tag, "sandbox.write", w);
      }
    }
  }

  // Every global agent as a potential call.
  if (global) {
    envelope("calls", "calls root", path.join(home, "calls"));
    for (const role of Object.keys(global.agents).sort()) {
      try {
        const p = resolveProjectFrom(home, CALL_PROJECT, global, { dir: home, team: { lead: role }, dispatcher: {}, agents: { [role]: {} } });
        const base = p.agents[role] as ResolvedAgent;
        const agent: ResolvedAgent = { ...base, memory: { global: base.memory.global ?? path.join(hp.globalAgentsDir, role, "memory") }, resume: false, canMessage: [], canAskUser: false, canEditAgentMd: false };
        calls.push({ role, agent });
        // A synthetic child of the real calls root gives the static policy paths; nothing is created.
        const cp = callProject(home, agent, home, path.join(home, "calls", `doctor-approval-${role}`));
        const cands = agent.runtime ? candidatesFor(agent) : [];
        const variants = cands.length ? cands.map((c, i) => ({ label: c.primary ? "primary" : `fallback ${i}`, agent: agentForCandidate(agent, c) })) : [{ label: "primary", agent }];
        for (const v of variants) {
          const tag = v.label === "primary" ? `call agent "${role}"` : `call agent "${role}" (${v.label})`;
          const pol = writePolicy(cp, v.agent);
          for (const d of pol.allowDirs) addGrant(tag, "write allowDirs", d);
          for (const f of pol.allowFiles) addGrant(tag, "write allowFiles", f);
          for (const w of v.agent.sandbox?.write ?? []) addGrant(tag, "sandbox.write", w);
        }
      } catch (e) {
        incomplete(`global agent "${role}" cannot be resolved as a call agent (${(e as Error).message.split("\n")[0]})`);
      }
    }
  }

  // Every executor allow entry must name something the inventory found.
  for (const [ename, e] of Object.entries(config.executors).sort(([a], [b]) => a.localeCompare(b))) {
    for (const a of e.allow) {
      if ("call" in a) {
        if (global && !global.agents[a.call]) incomplete(`executor "${ename}" allows call "${a.call}", which is not an agent of ${hp.globalConfig}`);
      } else if (!projects.has(a.project)) {
        if (!entries.some((x) => x.name === a.project)) incomplete(`executor "${ename}" allows project "${a.project}", which is not under ${hp.projectsDir}`);
      } else if (!projects.get(a.project)?.agents[a.agent]) {
        incomplete(`executor "${ename}" allows agent "${a.agent}" of project "${a.project}", which that project does not define`);
      }
    }
  }

  // 3. Compare, both directions, on canonical paths.
  for (const p of prot) {
    for (const g of grants) {
      const pc = norm(p.canon);
      const gc = norm(g.canon);
      const rel = pc === gc ? "is the same path as" : isInside(gc, pc) ? "lies inside" : !p.oneWay && isInside(pc, gc) ? "contains" : undefined;
      if (!rel) continue;
      push(STEM_OVERLAP, `${p.kind} ${p.src}${p.src === p.canon ? "" : ` (canonical ${p.canon})`} ${rel} ${g.who} ${g.setting} ${g.src}${g.src === g.canon ? "" : ` (canonical ${g.canon})`}. Conservative overlap, not proof that the agent can change it. Move the file or narrow the grant.`);
    }
  }

  if (calls.length > 0) {
    checks.push({ level: "warn", subject: "approval", message: `${STEM_CWD} a call's --dir is chosen at run time (checked then only against the home directory), so only the static grants of the ${calls.length} global agent(s) were compared.` });
  }

  const order = (c: DoctorCheck): string => `${c.level === "error" ? 0 : 1}${c.message}`;
  const unique = [...new Map(checks.map((c) => [order(c), c])).values()].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  return { checks: unique, calls };
}
