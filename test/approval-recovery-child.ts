// Runs one enrolled resume scenario in its own process, so a blocking read cannot hang the test runner: the parent test kills this
// process after a timeout. Usage: tsx test/approval-recovery-child.ts <unknown-attempt-fifo|unknown-claim-fifo|malformed-claim>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Invoker, WakeInput } from '../src/adapters/index.js';
import { runTeam } from '../src/dispatcher.js';
import { outboxDir, setOsSandboxForTest } from '../src/policy.js';
import { loadRunState } from '../src/run-store.js';
import { prepareTask } from '../src/task.js';
import { FULL_DONE, makeEnv, withSections, write } from './helpers.js';

const kind = process.argv[2] ?? '';
setOsSandboxForTest(true);
const env = makeEnv();
const tool = path.join(env.root, 'exec', 'bin', 'tool');
write(tool, '#!/bin/sh\nexit 0\n');
fs.chmodSync(tool, 0o755);
fs.writeFileSync(path.join(env.home, 'executors.yaml'), `executors:\n  x:\n    command: ["${tool}"]\n    allow: [{project: demo, agent: fe-member}, {project: demo, agent: qa-member}]\n    timeout_sec: 5\n`);
const project = env.project();
const runDir = path.join(project.paths.runs, 'run-1');
const approvalPremise = { platform: 'linux' as const, sandboxAvailable: () => true };
let seq = 0;
const mail = (i: WakeInput, to: string, subject: string, type: string) =>
  write(path.join(outboxDir(i.project, i.agent.name), `${String(++seq).padStart(6, '0')}-${Math.random()}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === 'done' ? 'outcome: completed\n' : ''}---\n\n${type === 'done' ? FULL_DONE : withSections(type, 'b')}\n`);
const ac = new AbortController();
const first: Invoker = async (i) => { mail(i, 'fe-member', 'a', 'task'); mail(i, 'qa-member', 'b', 'task'); ac.abort(); return { ok: true, text: '', exitCode: 0, timedOut: false }; };
const task = prepareTask({ text: 't', cwd: env.root, runDir });
const s1 = await runTeam({ project, task, runDir, invoker: first, log: () => {}, sleep: async () => {}, signal: ac.signal, approvalPremise });
if (s1.endReason !== 'cancelled') throw new Error(`setup: ${s1.endReason}`);
const mailDir = path.join(runDir, 'mail');
fs.mkdirSync(path.join(mailDir, 'attempts'), { recursive: true });
fs.mkdirSync(path.join(mailDir, 'claims'), { recursive: true });
if (kind === 'unknown-attempt-fifo') execFileSync('mkfifo', [path.join(mailDir, 'attempts', 'fe-member.json')]);
else if (kind === 'unknown-claim-fifo') execFileSync('mkfifo', [path.join(mailDir, 'claims', 'fe-member.json')]);
else if (kind === 'malformed-claim') write(path.join(mailDir, 'claims', '1abc-fe-member-aaaaaa.json'), JSON.stringify({ id: '1abc-fe-member-aaaaaa', agent: 'fe-member', status: 'committed' }));
else throw new Error(`unknown scenario ${kind}`);
// qa-member has recoverable work: a claim recovery must abandon
write(path.join(mailDir, 'claims', '1abd-qa-member-bbbbbb.json'), JSON.stringify({ id: '1abd-qa-member-bbbbbb', agent: 'qa-member', message_ids: [], files: [], status: 'claimed', created: 'x' }));
const seen: string[] = [];
let heard = false;
const second: Invoker = async (i) => {
  seen.push(i.agent.name);
  if (i.agent.name === 'lead') { if (i.userPrompt.includes('from: qa-member')) heard = true; if (heard) mail(i, 'lead', 'finished', 'done'); } else mail(i, 'lead', `${i.agent.name} replied`, 'reply');
  return { ok: true, text: '', exitCode: 0, timedOut: false };
};
const s2 = await runTeam({ project, resume: loadRunState(runDir), runDir, invoker: second, log: () => {}, sleep: async () => {}, approvalPremise });
const gate = JSON.parse(fs.readFileSync(path.join(runDir, 'approval-gate.json'), 'utf8')).slots;
const qaClaim = JSON.parse(fs.readFileSync(path.join(mailDir, 'claims', '1abd-qa-member-bbbbbb.json'), 'utf8')).status;
console.log(JSON.stringify({ end: s2.endReason, seen, gate, qaClaim }));
env.cleanup();
