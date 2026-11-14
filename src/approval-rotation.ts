import type { SlotRef } from './approval-paths.js';
import type { Sequence } from './approval-types.js';

/** Destination below the canonical slot root; never an arbitrary caller-supplied path. */
export type RotationDestination =
  | { readonly kind: 'collected'; readonly seq: Sequence }
  | { readonly kind: 'parked'; readonly attempt_id: string };

/** Describes a completed rename/recreation, or a missing proposals directory recreated without rotation. */
export type RotationResult =
  | { readonly kind: 'rotated'; readonly destination: string; readonly proposals: string }
  | { readonly kind: 'empty'; readonly proposals: string };

/**
 * Future implementation: caller holds exclusive canonical-slot coordination shared with requests gc,
 * from sequence selection through rename, recreation and high-water advance (including orphan/call slots).
 * lstat slot/proposals, reject symlinks/non-directories; missing proposals is rebuilt, not an error.
 * Rename the whole proposals directory to dest, recreate proposals (0700), and lstat it again.
 * Unsafe/I/O failures must suspend this slot's collection AND wake, report its reason, and leave other slots running.
 * Skip empty proposals; advance collected high-water only after rename. Never mark done or parse requests.
 * No implementation or automatic sequence allocation is supplied here.
 */
export type Rotate = (home: string, slot: SlotRef, dest: RotationDestination) => RotationResult;

/** Parked output is never collected or used as redoContext drafts. */
export type ParkResult = RotationResult;

/**
 * Future failure/cancellation/recovery hook: rotate(slot, parked/<attempt-id>) under the same coordination.
 * Recovery parks started attempts and newly abandoned claimed/output_ready attempts BEFORE saving abandoned;
 * do not re-park every historical abandoned claim on each resume. Call fallback attempts use their attempt number.
 */
export type Park = (home: string, slot: SlotRef, attemptId: string) => ParkResult;

/**
 * Future recoverRunMail hook: return the canonical proposals path for an enrolled slot, or undefined when absent
 * (including tidy/verify/format policy wakes). Resolve from trusted request layout, never agent output.
 * Only a type contract: no recovery/wake integration is implemented.
 */
export type ProposalsOf = (agent: string) => string | undefined;
