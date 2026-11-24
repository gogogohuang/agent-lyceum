// Scan, then swap a verified file for a FIFO, then recover. Run in its own process so a blocking open cannot hang the test runner.
// Usage: tsx test/approval-recovery-swap-child.ts <with-read-file|legacy>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoveryReadFile, recoverySkipFile, scanRecoveryInputs } from '../src/approval-wake-gate.js';
import { recoverRunMail } from '../src/message-store.js';

const mode = process.argv[2] ?? '';
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-swap-'));
const claims = path.join(runDir, 'mail', 'claims');
fs.mkdirSync(claims, { recursive: true });
const id = '1abc-dev-aaaaaa';
const file = path.join(claims, `${id}.json`);
fs.writeFileSync(file, JSON.stringify({ id, agent: 'dev', message_ids: [], files: [], status: 'committed', created: '2026-11-16T10:00:00.000Z' }));
const scan = scanRecoveryInputs(runDir, ['dev']);
if (!scan.allowed.claims.has(`${id}.json`)) throw new Error('setup: claim not allowed');
fs.rmSync(file);
execFileSync('mkfifo', [file]); // the swap, after the scan and before recovery
const opts = mode === 'with-read-file' ? { skipFile: recoverySkipFile(scan), readFile: recoveryReadFile(scan) } : { skipFile: recoverySkipFile(scan) };
const r = recoverRunMail(runDir, opts);
console.log(JSON.stringify({ finalized: r.finalized.length }));
fs.rmSync(runDir, { recursive: true, force: true });
