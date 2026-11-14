# Approval store API (stage 1 + stage 2a helpers)

**Unreleased API reference.** The stage-1 store and stage-2a part-1 helpers are
implemented, following the [stage-1 plan](superpowers/plans/2026-11-14-approval-store-stage1.md)
and [v12/v12.1 spec](superpowers/specs/2026-11-13-approval-gate-design.md).
Examples below illustrate the TypeScript ESM API; they are not verified runtime examples.

Everything here is default-off. The only existing code path that uses these modules is
`doctor`: it loads `executors.yaml` and runs read-only diagnostics (see
[Doctor checks (stage 2a)](#doctor-checks-stage-2a); `src/doctor.ts:235`,
`src/doctor-approval.ts:32`). There is no integration with `settle()`, `call`,
`run-session`, wake, adapters or other CLI commands, and no import-time I/O. No approvals
commands or executor runner are delivered. `ResolvedAgent` has an optional `enrolled` field
(`src/config.ts:64`) that only `doctor` sets; `WakeInput` has no enrollment field, and nothing
is enforced at wake, run or call.

## Modules and direct calls

Names below identify source modules in `src/`.

| Module (`approval-*.ts`) | Exports by responsibility |
|---|---|
| `types`, `error`, `schema`, `paths` | Readonly record/state/source/output types; `ApprovalError`; strict `parseApprovalRecord`, `parseApprovalState`; pure `storePaths`, `requestPaths`, `recordPaths`. |
| `id` | Pure `encodeSourceKey(key): Buffer`, `approvalId(key): ApprovalId`. |
| `executors` | Pure `parseExecutors`, `qualificationOf`; explicitly called `loadExecutors(home, userHome, io?)`. |
| `origin` | Pure `staticWritable`, `qualificationHash`; injected `resolveOrigin`, `revalidateOrigin`. |
| `io`, `store` | Read-only `assertRealDir`, `readApprovalFile`, `readRecord`, `listCommittedIds`; mutations `publishExclusive`, `publishRecord`. |
| `transition`, `liveness`, `state` | Pure `decideTransition`; probing `creatorLiveness`; read-only `readCurrent`; mutating `transition`. |
| `display`, `json` | Pure `computeDisplay`, `serializeApprovalList`; `Display`, `ApprovalListItemV1`, `ApprovalListV1`, `ApprovalListProblem` and aliases `ApprovalListItem`, `ApprovalListJson`. |
| `high-water` | `readHighWater`, `maxCollectedSequence`, `nextCollectedSequence`; mutating `advanceHighWater`. |
| `rotation` | Type-only `Rotate`, `Park`, `ProposalsOf`, `RotationDestination`, `RotationResult`, `ParkResult`; no implementation or runtime exports. |

Identity example (relative imports assume a caller in `src/`):

```ts
import { createHash } from "node:crypto";
import { approvalId, encodeSourceKey } from "./approval-id.js";
const key = {
  kind: "call", source_id: "call-1", slot: "writer", seq: 1,
  variant: "payload", filename: "note.req",
  payload_sha256: createHash("sha256").update(Buffer.from("hello\n")).digest("hex"),
} as const;
const id = approvalId(key);
const encoded = encodeSourceKey(key); // Buffer; id hashes these exact bytes
```

Explicit, in-memory config parsing example (no file read or executor launch):

```ts
import { parseExecutors, qualificationOf } from "./approval-executors.js";
const config = parseExecutors(`executors:
  local:
    command: ["/opt/trusted/local-executor"]
    allow: [{call: writer}]
    timeout_sec: 60
`, "in-memory.yaml", "/Users/operator");
const qualification = qualificationOf(config, { project: null, role: "writer" });
```

`loadExecutors` reads only when directly called. Missing file yields
`{ enabled: false, config: null }`; other I/O/YAML/schema errors are reported.
All-empty allow union disables enrollment; one empty executor does not disable others.
`command` is one absolute path; `timeout_sec` is required, positive, with no default.
Defaults: env `{}`, expiry 7 days, per-executor pending limit 10, payload 4096 bytes
(maximum 65536), global pending limit 50, scan entries 200, retention 90 days.
Env values expand only `~`/`~/` using injected `userHome`, never `$VAR`.
Shape validation does not check executable safety, containment or sandbox enforcement.

## Identity and persisted data

`lp(s) = ASCII(decimal(UTF8 byte length)) + ":" + UTF8(s)`; concatenate fields
without LF, NUL, BOM, normalization or trailing separator; lengths have no leading zeros.
Reject lone surrogates.
The fixed tuple is `["agent-lyceum/approval-source/v1", variant, kind, source_id,
slot, decimal(seq), ...suffix]`. ID is the first 24 lowercase hex digits of SHA-256
of that encoding. Call keys use the role as slot. Changing sequence creates a new ID.

| Variant | Ordered suffix |
|---|---|
| `payload` | filename, payload_sha256 |
| `denied_bytes` | filename, reason, request_sha256 (complete bounded request bytes) |
| `denied_entry` | filename, `not_regular` |
| `denied_size` | filename, `too_large`, decimal(size); never hash a truncated buffer |
| `denied_scan` | `scan_limit`; one aggregate per sequence, count excluded from identity |

There are **eight denied codes covering nine denial cases**: `not_regular`,
`too_large` (global read limit or executor payload limit), `bad_content`,
`bad_executor`, `bad_header`, `not_allowed`, `quota`, `scan_limit`.
Executor-limit rejection uses `denied_bytes`; global oversize uses `denied_size`.

Records live at `<home>/approvals/<id>/record.json`, with `payload`, `state/<n>.json`
and a reserved `work/` path. Request slot roots are
`<home>/requests/projects/<project>/<run-id>/<slot>` or
`<home>/requests/calls/<call-id>` (no extra call slot layer), containing
`proposals/`, `collected/<seq>/`, sibling `collected/<seq>.done`, `parked/` and
`collected.seq`; call roots also reserve `ok.json`. Layout helpers do not create them.

Record, state and list schemas require `schema_version: 1`, strict keys, canonical
UTC times and safe integers. Unknown versions fail closed; no migration is inferred.
Records contain source key, origin, qualification snapshot, proposer, timestamps and
immutable `disposition: pending|denied`. Denied fields may be null where unavailable.
States carry `n`, `previous`, `updated_at`, actor and transition-specific evidence/result.
Without state, disposition supplies status at sequence 0; denied never gains state.
Numeric maximum wins (`10 > 2`); invalid numeric aliases, corrupt highest state or
required predecessors fail closed, without falling back to an earlier state.
Metadata/executors are capped at 1 MiB, payload at 65536 bytes, high-water at 32 bytes.

## Publication, transitions and display

`listCommittedIds(home, io?)` returns `{ ids, problems }`, with IDs sorted. It skips
non-ID names and incomplete entries without `record.json`; a missing approvals root
returns empty arrays. It checks that the root is a real directory before enumeration;
an unsafe/unreadable root throws. Per-record `ApprovalError`s become
`{ id, path, code, hint }` problems without hiding valid records. It reads records,
not state: a listed ID does not establish that its current state is readable.
`readCurrent` likewise checks its state directory before enumeration and still
throws on unsafe paths or corrupt state; it does not turn failures into problems.

`publishRecord(home, record, payload, deps?)` returns `{ kind: "created"|"existing",
record }`. Payload and record use same-directory exclusive temp files, fsync, then
`linkSync`: first writer wins. Existing payload bytes must match before record commit;
`record.json` is the commit point. A committed record replays unchanged, skipping all
payload/state writes and preserving timestamps, snapshot and advanced state.
EEXIST on record publication adopts the valid first record after source validation.
Unsupported hard links, mismatches and corruption fail closed; no rename fallback.
A successful link survives cleanup failure; diagnostics report cleanup errors.

`transition(home, id, callback, deps?, maxConflicts?)` reads latest state, calls
`callback(latest)` for fresh `{ event, context }`, decides, then exclusively links
`state/<n+1>.json`. EEXIST re-reads and re-decides with fresh time/proof/liveness;
default conflict budget is 32, then result is `contended`. Other results are
`committed` or `unchanged` (noop/refusal). Pure decisions do no I/O, TTY checks or spawn.

For pending approve, check clock rollback, expiry, payload hash, then qualification
and confirmation proof. Expiry is `now > expires_at`; equality still permits approval.
Approve against executing must first probe its latest creator: live is unchanged;
dead commits `unknown`, including after CAS retries. Recovery ends that operation.
Unknown never returns to executing; manual resolve only records executed/failed.
**A committed result alone is not authorization to spawn.** A future trusted runner
would require this call's newly committed executing state owned by that process;
committed unknown/expired/tampered, unchanged and contended never authorize execution.
No such runner exists in stage 1; proof booleans are trusted-caller assertions.

`creatorLiveness(owner, executingAt, timeoutSec, nowMs, probe?)` reports missing PID
or comparable start mismatch dead immediately; matching start stays alive even past
timeout. Unverifiable start is alive only before
`now >= executingAt + (timeoutSec + 60) * 1000`; at equality it is dead.
It uses exported `pidStart()` but does not reuse fail-open `lockHolderAlive` or assume
its quarter-hour tolerance proves a match. Incomparable locale/TZ results are unverifiable.

`computeDisplay(current: Current, nowMs: number, creator: Liveness | null): Display`
returns `Display` with `persisted`,
`computed`, `unrecorded`, `n` and `updated_at`. Pending becomes computed expired
only when `nowMs > expires_at`; executing becomes computed unknown only with
supplied dead-creator evidence. Executing without evidence throws `INVALID_INPUT`;
the helper never probes a PID. Other statuses stay as persisted. `unrecorded` means
computed differs from persisted; `n` and `updated_at` remain the persisted sequence
and time (0 and record creation time without state). No transition is written.

`serializeApprovalList(value: unknown): string` validates the versioned envelope
`{ schema_version: 1, requests, problems }` and returns JSON plus LF, with fixed key
order, requests sorted by ID and problems by `(id,path,code)`. `ApprovalListV1`
(alias `ApprovalListJson`) contains `ApprovalListItemV1[]` (alias item type
`ApprovalListItem`) and `ApprovalListProblem[]`, all readonly. Items contain only
id, origin, proposer, executor, creation/expiry times, display, reason and payload
hash/size. Payload content, summary, qualification snapshot/env and executor output
are excluded; extra item fields make the item invalid rather than being emitted.

Invalid request items are omitted from requests and reported as `CORRUPT_RECORD`
problems with path `requests[index]`, a valid ID if available (otherwise `<unknown>`),
and fixed hint `Invalid approval list item`; raw invalid fields/exception messages
are not copied. Invalid envelopes or problem metadata throw `INVALID_INPUT`;
unsupported versions throw `UNSUPPORTED_VERSION`. Caller-supplied problem strings
must already be safe metadata. The serializer neither scans the store nor selects
CLI filters. These helpers support a future `approvals list --json`; no approvals
CLI is delivered and existing `status --json` is unchanged.

`approval-rotation.ts` provides only these type contracts:

```ts
type RotationDestination =
  | { readonly kind: "collected"; readonly seq: Sequence }
  | { readonly kind: "parked"; readonly attempt_id: string };
type RotationResult =
  | { readonly kind: "rotated"; readonly destination: string; readonly proposals: string }
  | { readonly kind: "empty"; readonly proposals: string };
type ParkResult = RotationResult;
type Rotate = (home: string, slot: SlotRef, dest: RotationDestination) => RotationResult;
type Park = (home: string, slot: SlotRef, attemptId: string) => ParkResult;
type ProposalsOf = (agent: string) => string | undefined;
```

`Sequence` and `SlotRef` are existing types from `approval-types.ts` and
`approval-paths.ts`. The comments specify future coordinated directory rotation,
park-before-abandon recovery and a trusted proposals-path lookup (undefined when
absent). They supply no callable exports, collection, rotation, parking or recovery
implementation, and no wake enforcement.

## Origin, coordination and trust limits

`resolveOrigin(origin, executor, resolver)` and `revalidateOrigin(record, resolver)`
use injected current configuration/canonical paths, never original run/call files,
attempts, worktrees or task memory. Thus clear does not remove required origin inputs.
`staticWritable({effective, run_only, static_duplicates})` computes exact
`(effective - run_only) union static_duplicates`, preserving duplicate static grants;
no path heuristic or static-grant allowlist. Caller supplies canonical provenance.
Snapshot hashes include ordered runtime candidates with each candidate's effective
sandbox/web settings, static writable set, canonical project directory and full
executor entry. Model/tier/session, run-only grants, display-only full writable set
and executor binary hash are excluded. Only hash/premise codes are persisted, not env values.

High-water helpers require **common caller-held exclusive coordination keyed by the
canonical slot root**, shared by rotation and manual gc, including orphan/run/call
slots. Hold it from selection through directory mutation, high-water advance and
removals (gc advances first, removes directory before `.done`). A run lease alone is
not proof. Helpers supply no lock or concurrent allocator: next is
`max(persisted, numeric directories, .done sequences) + 1`, not a reservation.
`collected.seq` is canonical decimal plus LF; corrupt content fails closed.
Replace-rename for advancing this file is not an atomic concurrent maximum.

Errors are separate domains. `ApprovalError` carries `code`, `path` and an optional `cause`
(`src/approval-error.ts:7-13`). Its generated messages are fixed diagnostics, but it also keeps
caller-supplied strings, and `cause` can be a raw underlying error: for a record that is not
valid JSON, `src/approval-store.ts:35-37` wraps the original `JSON.parse` error, which can
contain file content. Treat `cause` and caller strings as potentially sensitive; do not log or
display them unfiltered. Codes:
`UNSUPPORTED_PLATFORM`, `UNSUPPORTED_LINK`, `UNSUPPORTED_VERSION`, `UNSAFE_PATH`,
`IO_ERROR`, `CORRUPT_RECORD`, `CORRUPT_STATE`, `CORRUPT_HIGH_WATER`, `PAYLOAD_MISMATCH`,
`SOURCE_MISMATCH`, `SEQUENCE_OVERFLOW`, `INVALID_INPUT`.
Origin failures return `{ok:false,code,hint}`: `PROJECT_MISSING`, `PROJECT_PATH_MISMATCH`,
`AGENT_MISSING`, `EXECUTOR_MISSING`, `NOT_ALLOWED`, `PREMISE_FAILED`, `SNAPSHOT_MISMATCH`,
`CONFIG_INVALID`, `ORIGIN_UNREADABLE`; revalidation failure leaves pending unchanged.
Transition refusals: `ALREADY_HANDLED`, `NOT_APPLICABLE`, `CLOCK_ROLLBACK`,
`QUALIFICATION_FAILED`, `CONFIRMATION_REQUIRED`, `INVALID_PROOF`, `NOT_CREATOR`.

Canonical home, private trusted parents, ancestor lstat and capped no-follow/nonblocking
reads do not prevent hostile same-UID ancestor replacement or provide read isolation.
Durability covers process crashes only, not power loss/OS crashes. Windows writes
are unsupported. Pure proofs do not enforce sandbox, containment or human confirmation.
The spec §8 records human-run macOS observations, not new verification here; Linux
and remaining real sandbox/login release conditions remain unverified. This API
reference supplies no release-readiness evidence.

## Doctor checks (stage 2a)

`diagnoseApproval(project, opts?)` (`src/doctor-approval.ts`) is called only from `doctor`
(`src/doctor.ts:235`). It is read-only diagnostics, not enforcement.

- **Default off.** With no `<home>/executors.yaml`, or one whose `allow` lists are all empty,
  it returns no checks and `doctor` output does not change (`src/approval-executors.ts:73-75`).
- **Invalid file.** One error: `Approval executors configuration is invalid: <file>: <why>`
  (`src/doctor-approval.ts:40`). `command` must be one absolute path (`src/approval-executors.ts:28`).
- **Enrolled.** An agent is enrolled when its role appears in some executor's `allow`, matched
  by exact project (or `call`) and role; instance names map to their role through `roleOfName`,
  not a name pattern (`src/approval-enrollment.ts:13-16`). A same-named agent in a project that is
  not in `allow` is not enrolled.
- **Instance cap.** `instanceCap` returns 1 for an enrolled role (`src/instances.ts:47`). Only
  `doctor` sets the `enrolled` flag (`applyEnrollment`, `src/approval-enrollment.ts:19-27`), so
  real runs are unchanged today.

Checks (subject `approval`; stems copied from source). Per enrolled agent, per candidate
(primary, then each fallback) at its effective settings, `src/doctor-approval-premises.ts:20-37`:

| Level | Message stem |
|---|---|
| error | `Approval enrollment is unsupported on Windows:` |
| error | `Approval enrollment requires an OS sandbox:` |
| error | `Approval-enrolled candidate permits sandbox.unix_sockets:` / `sandbox.network:` / `sandbox.local_binding:` |
| error | `Approval-enrolled candidate permits allow_web=` (`search` or `fetch`) |
| error | `Approval-enrolled candidate uses Codex:` |
| warn | `Approval-enrolled agent has can_edit_agent_md:` |

The capability and Codex errors are reported per candidate; the Windows, OS-sandbox and
`can_edit_agent_md` checks once per agent.

Once per project that has an enrolled agent (`src/doctor-approval-premises.ts:43-56`):

| Level | Message stem |
|---|---|
| error | `Approval-enrolled project has verify.commands:` |
| warn | `Approval-enrolled project lead may request open_pr:` |
| warn | `Approval-enrolled role has effective instance cap 1:` (whenever the effective `dispatcher.max_instances` is not 1; an omitted value means the default 4, so it warns too) |

For any project, also one without an enrolled agent (`src/doctor-approval-premises.ts:57-69`):

| Level | Message stem |
|---|---|
| warn | `Agent is not approval-enrolled despite matching an enrolled role name:` |

Containment (stems at `src/doctor-approval-containment.ts:32-35`), compared on canonical paths
in both directions across all projects and global call agents:

| Level | Message stem |
|---|---|
| error | `Approval protected path overlaps an agent writable range:` |
| error | `Approval executable or path cannot be verified:` |
| error | `Approval containment scan is incomplete:` |
| warn | `Approval containment does not validate future call --dir values:` |

Protected set (`src/doctor-approval-containment.ts`; source locations below name functions, since line numbers move): the `approvals directory`,
`requests directory` and `executors.yaml` paths, plus, for each executor, its `command`, real path,
directory and real directory, and its direct absolute shebang interpreter with the same four kinds.
Every symlink hop on those paths (and the hop's directory) is added as `<kind> symlink hop` and
`<kind> symlink hop directory` (`symlinkHops`). Hops compare one way only: a grant that equals or
contains the hop or its directory matches; a grant strictly inside does not (`Protected.oneWay`).
More than 40 links is "cannot be verified".
A `command` or interpreter with more than one hard link is "cannot be verified".
A `command`, shebang interpreter or home path whose spelling contains a `.` or `..` component, or an
empty one (`//`, trailing `/`), is "cannot be verified" without being resolved (`hasDotComponent`):
`link/..` would otherwise be shortened before `link` is followed. Spell such paths without them.

Writable ranges: per agent and candidate, the write policy dirs/files, the project dir, the project
`worktrees` root and `sandbox.write`. The envelopes of each project's `runs`,
`task-memory`, git common dir and the home `calls` root are walked for symlink aliases, following symlinked directories
transitively, within 20000 entries and depth 8 (`MAX_WALK_ENTRIES`, `MAX_WALK_DEPTH`, `aliasesBelow`); exceeding a bound is a
`scan is incomplete` error. The project `worktrees` envelope and the git checkouts (project dir,
worktrees) are not alias-walked.
All approval messages escape control characters as `\uXXXX` (`escapeControl`, applied again to every
approval message at `src/doctor-approval.ts:40,49`).

Limits:

- No enforcement at wake, run or call; that is stage 2b.
- On Linux, premise 1 only checks that `bwrap` exists (`osSandboxAvailable`); the message says backend startup is unverified.
- A future `call --dir` is not checked (the warning above).
- Overlaps are conservative: the message states it is not proof the agent can change the path.
- No same-UID TOCTOU guarantee.
- Runtime or user settings and MCP configuration are not checked.
- Linux and a real sandbox are unverified.
- Git checkouts are not alias-walked: an agent-made symlink there relies on the OS sandbox resolving symlink writes; Claude Edit-tool write-through is unverified.
- Executor `env` values are not checked.
- Hard links are detected only on the command or interpreter itself; other hard links are not searched for.
- Links or hard links created after `doctor` runs are not seen.
