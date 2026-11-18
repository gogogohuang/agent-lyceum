import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, expectTypeOf, it } from 'vitest';
import type { SlotRef } from '../src/approval-paths.js';
import type { Rotate, Park, ProposalsOf, RotationDestination, RotationResult } from '../src/approval-rotation.js';

it('keeps the compile-only Rotate, Park, ProposalsOf contracts; runtime exports are only the stage-3 implementations', async () => {
  expectTypeOf<Rotate>().toEqualTypeOf<(home: string, slot: SlotRef, dest: RotationDestination) => RotationResult>();
  expectTypeOf<Park>().toEqualTypeOf<(home: string, slot: SlotRef, attempt: string) => RotationResult>();
  expectTypeOf<ProposalsOf>().toEqualTypeOf<(slot: string) => string | undefined>();
  expect(Object.keys(await import('../src/approval-rotation.js')).sort())
    .toEqual(['CoordHeldError', 'createRotation', 'park', 'rotate', 'withSlotCoord']);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-types-')));
  try {
    const source = path.join(dir, 'contracts.mts');
    fs.writeFileSync(source, `
import type { Rotate, Park, ProposalsOf, RotationDestination, RotationResult } from ${JSON.stringify(path.join(root, 'src/approval-rotation.js'))};
import type { SlotRef } from ${JSON.stringify(path.join(root, 'src/approval-paths.js'))};
// These checks are compiled by tsc, independently of Vitest's type erasure.
const rotate: Rotate = (home: string, slot: SlotRef, dest: RotationDestination): RotationResult => ({kind:'empty', proposals: home});
const park: Park = (home: string, slot: SlotRef, attempt: string): RotationResult => ({kind:'rotated', destination: attempt, proposals: home});
const proposals: ProposalsOf = (slot: string): string | undefined => undefined;
// @ts-expect-error types must never be callable runtime exports
const runtime = Rotate;
// @ts-expect-error arbitrary paths are not valid destinations
const bad: RotationDestination = '../elsewhere';
void [rotate, park, proposals, runtime, bad];
`);
    const config = path.join(dir, 'tsconfig.json');
    fs.writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, noEmit: true,
      skipLibCheck: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022',
      types: ['node'], typeRoots: [path.join(root, 'node_modules/@types')] }, files: [source] }));
    expect(() => execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', config], { encoding: 'utf8' })).not.toThrow();
    const output = path.join(dir, 'emitted');
    const emitConfig = path.join(dir, 'emit.json');
    fs.writeFileSync(emitConfig, JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext',
      target: 'ES2022', skipLibCheck: true, outDir: output, rootDir: path.join(root, 'src'),
      types: ['node'], typeRoots: [path.join(root, 'node_modules/@types')] }, files: [path.join(root, 'src/approval-rotation.ts')] }));
    execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', emitConfig], { encoding: 'utf8' });
    expect(fs.existsSync(path.join(output, 'approval-rotation.js'))).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
