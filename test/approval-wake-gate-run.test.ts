import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoker, WakeInput, WakeResult } from '../src/adapters/index.js';
import type { GateDeps } from '../src/approval-wake-gate.js';
import { runTeam, type RunSummary } from '../src/dispatcher.js';
import { inboxDir, outboxDir, setOsSandboxForTest } from '../src/policy.js';
import { bindRunProject, loadRunState } from '../src/run-store.js';
import { prepareTask } from '../src/task.js';
import { FULL_DONE, makeEnv, withSections, write, type TestEnv } from './helpers.js';

vi.setConfig({ testTimeout: 15_000 });

const OK: WakeResult = { ok: true, text: '', exitCode: 0, timedOut: false };
const SECRET = 'SENTINEL-SECRET-4e2b';
const SPATH = 'SENTINEL-PATH-8a1c';
let env: TestEnv;
let tool: string;
let lines: string[];
let proj0: ReturnType<TestEnv['project']>;
beforeEach(() => {
  setOsSandboxForTest(true);
  lines = [];
  proj0 = undefined as never;
});
afterEach(() => {
  setOsSandboxForTest(undefined);
  env?.cleanup();
});

let seq = 0;
const mail = (i: WakeInput, to: string, subject: string, type = 'reply') =>
  write(path.join(outboxDir(i.project, i.agent.name), `${String(++seq).padStart(6, '0')}-${Math.random()}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === 'done' ? 'outcome: completed\n' : ''}---\n\n${type === 'done' ? FULL_DONE : withSections(type, `body of ${subject}`)}\n`);

const execYaml = (allow: string): string =>
  `executors:\n  x:\n    command: ["${tool}"]\n    allow: ${allow}\n    timeout_sec: 5\n    env:\n      TOKEN: ${SECRET}\n`;
const ALLOW_FE = '[{project: demo, agent: fe-member}]';
const ALLOW_BOTH = '[{project: demo, agent: fe-member}, {project: demo, agent: qa-member}]';
const setup = (allow = ALLOW_FE) => {
  env = makeEnv();
  tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(env.home, 'executors.yaml'), execYaml(allow));
  proj0 = env.project();
};
const runDirOf = () => path.join(proj0.paths.runs, 'run-1');
const projYaml = () => path.join(env.home, 'projects', 'demo', 'project.yaml');
const gateFile = () => path.join(runDirOf(), 'approval-gate.json');
const events = () => fs.readFileSync(path.join(runDirOf(), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const gateEntries = () => JSON.parse(fs.readFileSync(gateFile(), 'utf8')).slots;

interface Go { resume?: boolean; gate?: Partial<GateDeps>; solo?: string; signal?: AbortSignal; project?: ReturnType<TestEnv['project']> }
async function go(invoker: Invoker, o: Go = {}): Promise<RunSummary> {
  const project = o.project ?? (proj0 ?? env.project());
  const runDir = path.join(project.paths.runs, 'run-1');
  const common = { project, runDir, invoker, log: (l: string) => void lines.push(l), sleep: async () => {}, signal: o.signal, approvalGate: o.gate, soloAgent: o.solo };
  if (o.resume) return runTeam({ ...common, resume: loadRunState(runDir) });
  const task = prepareTask({ text: 'build the thing', cwd: env.root, runDir });
  return runTeam({ ...common, task });
}
/**
 * The lead sends tasks to `to` on its first wake, then runs `after` (config edits). On later wakes it sends done once it has seen a
 * reply from every agent in `awaitFrom` (default none: done at its second wake, i.e. after the dispatcher's notice); members reply to the lead.
 */
function leadScript(to: string[], after: () => void = () => {}, seen: string[] = [], awaitFrom: string[] = []): Invoker {
  let leadWakes = 0;
  const heard = new Set<string>();
  return async (i) => {
    seen.push(i.agent.name);
    if (i.agent.name === 'lead') {
      for (const n of awaitFrom) if (i.userPrompt.includes(`from: ${n}`)) heard.add(n);
      if (++leadWakes === 1) { for (const t of to) mail(i, t, `work for ${t}`, 'task'); after(); } else if (awaitFrom.every((n) => heard.has(n))) mail(i, 'lead', 'finished', 'done');
    } else mail(i, 'lead', `${i.agent.name} replied`);
    return OK;
  };
}
const filesUnder = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [];
const noticesToLead = (re: RegExp): string[] => {
  const inbox = inboxDir(bindRunProject(proj0, runDirOf(), 'run'), 'lead');
  return [...filesUnder(inbox)].map((f) => fs.readFileSync(f, 'utf8')).filter((t) => re.test(t));
};
const claimsOf = (agent: string): string[] => filesUnder(path.join(runDirOf(), 'mail', 'claims')).concat(filesUnder(path.join(runDirOf(), 'mail', 'attempts'))).filter((f) => path.basename(f).includes(`-${agent}-`));

describe('gate between wakes', () => {
  it('an unchanged enrolled run completes; the side file starts empty and no gate event is logged', async () => {
    setup();
    const seen: string[] = [];
    const s = await go(leadScript(['fe-member'], () => {}, seen));
    expect(seen).toEqual(['lead', 'fe-member', 'lead']);
    expect(s.endReason).toBe('done');
    expect(JSON.parse(fs.readFileSync(gateFile(), 'utf8'))).toEqual({ schema_version: 1, slots: {} });
    expect(events().some((e) => e.event === 'approval_gate')).toBe(false);
  });

  const breakers: [string, string, () => void][] = [
    ['project config edited', 'SNAPSHOT_MISMATCH', () => env.editProjectYaml((t) => t.replace('    can_message: [lead]\n    # memory', `    can_message: [lead]\n    sandbox:\n      write: [${path.join(env.root, 'extra')}]\n    # memory`))],
    ['project removed', 'PROJECT_MISSING', () => fs.rmSync(projYaml())],
    ['project dir moved', 'PROJECT_PATH_MISMATCH', () => { const d = path.join(env.root, 'other'); fs.mkdirSync(d); env.editProjectYaml((t) => t.replace(env.repo, d)); }],
    ['last allow entry removed', 'NOT_ALLOWED', () => fs.writeFileSync(path.join(env.home, 'executors.yaml'), execYaml('[{project: demo, agent: qa-member}]'))],
    ['executors.yaml deleted', 'EXECUTOR_MISSING', () => fs.rmSync(path.join(env.home, 'executors.yaml'))],
  ];
  for (const [name, code, breakIt] of breakers) {
    it(`${name} between wakes: not woken, refused ${code}, stays refused, no claim, one notice, reason in the side file`, async () => {
      setup();
      const seen: string[] = [];
      const s = await go(leadScript(['fe-member'], breakIt, seen));
      // the lead is told once, answers with done
      expect(seen).toEqual(['lead', 'lead']);
      expect(s.endReason).toBe('done');
      expect(gateEntries()['fe-member']).toMatchObject({ class: 'refused', code });
      expect(claimsOf('fe-member')).toEqual([]);
      expect(noticesToLead(/cannot be woken/)).toHaveLength(1);
      expect(events().filter((e) => e.event === 'approval_gate')).toEqual([expect.objectContaining({ slot: 'fe-member', class: 'refused', code })]);
    });
  }

  it('a refused slot stays refused for the rest of the process even if its files are restored', async () => {
    setup();
    const seen: string[] = [];
    const orig = fs.readFileSync(projYaml(), 'utf8');
    let leadWakes = 0;
    const s = await go(async (i) => {
      seen.push(i.agent.name);
      if (i.agent.name !== 'lead') return OK;
      leadWakes++;
      if (leadWakes === 1) { mail(i, 'fe-member', 'w', 'task'); fs.rmSync(projYaml()); }
      else if (leadWakes === 2) { fs.writeFileSync(projYaml(), orig); mail(i, 'fe-member', 'again', 'task'); }
      return OK;
    });
    // the lead's second wake restores the files; the third is the dispatcher's reminder to send done
    expect(seen).toEqual(['lead', 'lead', 'lead']);
    expect(s.endReason).toBe('idle');
  });

  it('resume re-checks: a fixed configuration wakes the slot again', async () => {
    setup();
    const orig = fs.readFileSync(projYaml(), 'utf8');
    const s = await go(async (i) => { if (i.agent.name === 'lead') { mail(i, 'fe-member', 'w', 'task'); fs.rmSync(projYaml(), { force: true }); } return OK; });
    expect(s.endReason).toBe('idle');
    fs.writeFileSync(projYaml(), orig);
    const seen: string[] = [];
    const s2 = await go(async (i) => { seen.push(i.agent.name); mail(i, 'lead', i.agent.name === 'lead' ? 'finished' : 'ok', i.agent.name === 'lead' ? 'done' : 'reply'); return OK; }, { resume: true });
    expect(seen).toContain('fe-member');
    expect(s2.endReason).toBe('done');
    expect(gateEntries()).toEqual({});
  });

  it('a project config that cannot be read safely (FIFO) refuses with CONFIG_INVALID and does not block', async () => {
    setup();
    const s = await go(leadScript(['fe-member'], () => { fs.rmSync(projYaml()); execFileSync('mkfifo', [projYaml()]); }));
    expect(s.endReason).toBe('done');
    expect(gateEntries()['fe-member']).toMatchObject({ class: 'refused', code: 'CONFIG_INVALID' });
    fs.rmSync(projYaml());
    fs.writeFileSync(projYaml(), '');
  });
});

describe('slot directory and attempts', () => {
  const slotRoot = (slot: string) => path.join(env.home, 'requests', 'projects', 'demo', 'run-1', slot);
  const linkSlot = (slot: string) => {
    const elsewhere = path.join(env.root, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(path.dirname(slotRoot(slot)), { recursive: true });
    if (!fs.existsSync(slotRoot(slot))) fs.symlinkSync(elsewhere, slotRoot(slot));
  };
  it('a symlinked slot directory skips only that slot; the others are woken; the skip clears when fixed', async () => {
    setup(ALLOW_BOTH);
    const seen: string[] = [];
    const lead = leadScript(['fe-member', 'qa-member'], () => linkSlot('fe-member'), seen, ['qa-member', 'fe-member']);
    const s = await go(async (i) => {
      if (i.agent.name === 'qa-member') { expect(gateEntries()['fe-member']).toMatchObject({ class: 'skipped', code: 'DIR_ANOMALY' }); fs.rmSync(slotRoot('fe-member')); }
      return lead(i);
    });
    expect(s.endReason).toBe('done');
    const woke = events().filter((e) => e.event === 'wake').map((e) => e.agent);
    expect(woke.indexOf('qa-member')).toBeGreaterThan(-1);
    expect(woke.indexOf('fe-member')).toBeGreaterThan(woke.indexOf('qa-member'));
    expect(gateEntries()).toEqual({});
    expect(noticesToLead(/approval request directory/)).toHaveLength(1);
  });

  it('only skipped slots hold mail: the run ends idle without consuming rounds, and nothing is claimed', async () => {
    setup();
    let leadWakes = 0;
    const s = await go(async (i) => { if (i.agent.name === 'lead' && ++leadWakes === 1) { mail(i, 'fe-member', 'a', 'task'); linkSlot('fe-member'); } return OK; });
    expect(s.endReason).toBe('idle');
    const woke = events().filter((e) => e.event === 'wake').map((e) => e.agent);
    expect(woke.every((n) => n === 'lead')).toBe(true);
    expect(s.rounds).toBe(woke.length);
    expect(claimsOf('fe-member')).toEqual([]);
    expect(gateEntries()['fe-member']).toMatchObject({ class: 'skipped', code: 'DIR_ANOMALY' });
  });

  it('a resume with an anomalous slot completes', async () => {
    setup();
    await go(async (i) => { if (i.agent.name === 'lead') { mail(i, 'fe-member', 'a', 'task'); linkSlot('fe-member'); } return OK; });
    const seen: string[] = [];
    const s = await go(async (i) => { seen.push(i.agent.name); return OK; }, { resume: true });
    expect(s.endReason).toBe('idle');
    expect(seen).not.toContain('fe-member');
  });

  it('non-empty proposals with a corrupt attempt JSON: not woken (UNDETERMINABLE); settled output is RESIDUAL_OUTPUT', async () => {
    setup();
    const seen: string[] = [];
    const s = await go(leadScript(['fe-member'], () => {
      write(path.join(slotRoot('fe-member'), 'proposals', 'p.json'), '{}');
      write(path.join(runDirOf(), 'mail', 'attempts', '1abc-fe-member-aaaaaa-a1.json'), '{broken');
    }, seen));
    expect(seen).toEqual(['lead', 'lead']);
    expect(s.endReason).toBe('done');
    expect(gateEntries()['fe-member']).toMatchObject({ class: 'skipped', code: 'UNDETERMINABLE' });
  });

  it('a slot that throws in the gate does not reject the batch; others are still woken', async () => {
    setup(ALLOW_BOTH);
    const seen: string[] = [];
    const s = await go(leadScript(['fe-member', 'qa-member'], () => {}, seen, ['qa-member']), { gate: { slotDir: (slot) => { if (slot === 'fe-member') throw new Error('boom'); return { kind: 'wake' }; } } });
    expect(seen).toEqual(['lead', 'lead', 'qa-member', 'lead']);
    expect(s.endReason).toBe('done');
    expect(gateEntries()['fe-member']).toMatchObject({ class: 'skipped', code: 'UNDETERMINABLE' });
  });
});

describe('R2: resume with a bad attempt file of an enrolled slot', () => {
  const prep = async () => {
    setup(ALLOW_BOTH);
    const ac = new AbortController();
    const s = await go(async (i) => { mail(i, 'fe-member', 'a', 'task'); mail(i, 'qa-member', 'b', 'task'); ac.abort(); return OK; }, { signal: ac.signal });
    expect(s.endReason).toBe('cancelled');
    // B left a claim that recovery must handle; A has a bad attempt file
    const claims = path.join(runDirOf(), 'mail', 'claims');
    write(path.join(claims, '1abd-qa-member-bbbbbb.json'), JSON.stringify({ id: '1abd-qa-member-bbbbbb', agent: 'qa-member', message_ids: [], files: [], status: 'claimed', created: 'x' }));
    return path.join(runDirOf(), 'mail', 'attempts', '1abc-fe-member-aaaaaa-a1.json');
  };
  const resume = async () => {
    const seen: string[] = [];
    let heard = false;
    const s = await go(async (i) => {
      seen.push(i.agent.name);
      if (i.agent.name === 'lead') { if (i.userPrompt.includes('from: qa-member')) heard = true; if (heard) mail(i, 'lead', 'finished', 'done'); } else mail(i, 'lead', `${i.agent.name} replied`);
      return OK;
    }, { resume: true });
    return { s, seen };
  };
  it('a FIFO attempt file: no hang, the batch is not rejected, A is not woken, B progresses', async () => {
    const f = await prep();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    execFileSync('mkfifo', [f]);
    const { s, seen } = await resume();
    expect(s.endReason).toBe('done');
    expect(seen).not.toContain('fe-member');
    expect(seen).toContain('qa-member');
    expect(gateEntries()['fe-member']).toMatchObject({ class: 'skipped', code: 'UNDETERMINABLE' });
    expect(JSON.parse(fs.readFileSync(path.join(runDirOf(), 'mail', 'claims', '1abd-qa-member-bbbbbb.json'), 'utf8')).status).not.toBe('claimed');
  });
  it('a parseable but malformed attempt file: A is not woken, B progresses', async () => {
    const f = await prep();
    write(f, JSON.stringify({ id: 'x', claim_id: 'y', agent: 'fe-member', n: 'one', status: 'started', started_at: 'when' }));
    const { s, seen } = await resume();
    expect(s.endReason).toBe('done');
    expect(seen).not.toContain('fe-member');
    expect(seen).toContain('qa-member');
    expect(gateEntries()['fe-member']).toMatchObject({ class: 'skipped', code: 'UNDETERMINABLE' });
  });
});

describe('lead, solo and baseline', () => {
  it('a refused lead ends lead_failed with zero wakes and no mail to itself', async () => {
    setup('[{project: demo, agent: lead}]');
    const seen: string[] = [];
    const s = await go(async (i) => { seen.push(i.agent.name); return OK; }, { gate: { loadFresh: () => ({ ok: false, code: 'CONFIG_INVALID' }) } });
    expect(seen).toEqual([]);
    expect(s.endReason).toBe('lead_failed');
    expect(s.rounds).toBe(0);
    expect(gateEntries().lead).toMatchObject({ class: 'refused', code: 'CONFIG_INVALID' });
  });
  it('a solo enrolled agent is gated and passes when unchanged', async () => {
    setup();
    const seen: string[] = [];
    const s = await go(async (i) => { seen.push(i.agent.name); mail(i, 'fe-member', 'finished', 'done'); return OK; }, { solo: 'fe-member' });
    expect(seen).toEqual(['fe-member']);
    expect(s.endReason).toBe('done');
    const seen2: string[] = [];
    fs.rmSync(runDirOf(), { recursive: true, force: true });
    const s2 = await go(async (i) => { seen2.push(i.agent.name); return OK; }, { solo: 'fe-member', gate: { loadFresh: () => ({ ok: false, code: 'PROJECT_MISSING' }) } });
    expect(seen2).toEqual([]);
    expect(s2.endReason).toBe('lead_failed');
  });
  it('an enrolled slot without a baseline is refused NO_BASELINE', async () => {
    setup();
    const project = env.project();
    fs.writeFileSync(path.join(env.home, 'executors.yaml'), execYaml('[{project: demo, agent: qa-member}]'));
    const seen: string[] = [];
    const s = await go(leadScript(['fe-member'], () => {}, seen), { project });
    expect(seen).toEqual(['lead', 'lead']);
    expect(s.endReason).toBe('done');
    expect(gateEntries()['fe-member']).toMatchObject({ class: 'refused', code: 'NO_BASELINE' });
  });
});

describe('R4: the reason file cannot be written', () => {
  it('a reset failure at session start still blocks the slot; a fixed file_error event is logged', async () => {
    setup();
    fs.mkdirSync(gateFile(), { recursive: true });
    const seen: string[] = [];
    const s = await go(leadScript(['fe-member'], () => fs.rmSync(projYaml()), seen));
    expect(seen).toEqual(['lead', 'lead']);
    expect(s.endReason).toBe('done');
    const errs = events().filter((e) => e.event === 'approval_gate_file_error');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatchObject({ phase: 'reset' });
    expect(JSON.stringify(errs)).not.toMatch(/EISDIR|ENOENT|approval-gate/);
    expect(JSON.stringify(errs)).not.toContain(env.root);
  });
  it('an update failure after a good reset still blocks the slot', async () => {
    setup();
    const seen: string[] = [];
    const s = await go(leadScript(['fe-member'], () => { fs.rmSync(gateFile()); fs.mkdirSync(gateFile()); fs.rmSync(projYaml()); }, seen));
    expect(seen).toEqual(['lead', 'lead']);
    expect(s.endReason).toBe('done');
    expect(events().some((e) => e.event === 'approval_gate_file_error' && e.phase === 'update')).toBe(true);
  });
});

describe('fixed text only (integration sentinels)', () => {
  it('a refusal leaks neither the executor env secret nor a sentinel path into mail, log, side file or terminal output', async () => {
    setup();
    const moved = path.join(env.root, SPATH);
    fs.mkdirSync(moved);
    await go(leadScript(['fe-member'], () => env.editProjectYaml((t) => t.replace(env.repo, moved))));
    expect(gateEntries()['fe-member'].code).toBe('PROJECT_PATH_MISMATCH');
    const all = filesUnder(runDirOf()).map((f) => fs.readFileSync(f, 'utf8')).join('\n') + lines.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(SPATH);
    expect(noticesToLead(/cannot be woken/)[0]).toContain('fe-member');
    expect(lines.some((l) => l.includes('fe-member') && /not woken/.test(l))).toBe(true);
  });
  it('the run state carries no gate notes (they would reach status --json)', async () => {
    setup();
    await go(leadScript(['fe-member'], () => fs.rmSync(projYaml())));
    const state = JSON.parse(fs.readFileSync(path.join(runDirOf(), 'state.json'), 'utf8'));
    expect(JSON.stringify(state.notes ?? [])).not.toMatch(/approval|cannot be woken|not woken|PROJECT_MISSING/);
  });
});

describe('default off', () => {
  it('without an enrolled agent the gate is never consulted and nothing is written', async () => {
    env = makeEnv();
    proj0 = env.project();
    const calls = { loadFresh: 0, slotDir: 0, now: 0 };
    const gate: GateDeps = { loadFresh: () => { calls.loadFresh++; return { ok: false, code: 'CONFIG_INVALID' }; }, slotDir: () => { calls.slotDir++; return { kind: 'wake' }; }, now: () => { calls.now++; return new Date(); } };
    const seen: string[] = [];
    const s = await go(leadScript(['fe-member'], () => {}, seen), { gate });
    expect(seen).toEqual(['lead', 'fe-member', 'lead']);
    expect(s.endReason).toBe('done');
    expect(calls).toEqual({ loadFresh: 0, slotDir: 0, now: 0 });
    expect(fs.existsSync(gateFile())).toBe(false);
    expect(events().some((e) => String(e.event).startsWith('approval_gate'))).toBe(false);
  });
});
