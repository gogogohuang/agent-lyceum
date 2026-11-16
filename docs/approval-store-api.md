# Approval store API (stages 1–2b-2)

**Unreleased API reference.** The store, doctor helpers, runtime enrollment and
per-wake gate follow the [stage-1 plan](superpowers/plans/2026-11-14-approval-store-stage1.md),
[stage-2b-1 plan](superpowers/plans/2026-11-14-approval-stage2b1.md),
[stage-2b-2 plan](superpowers/plans/2026-11-16-approval-stage2b2.md)
and [v12/v12.1 spec](superpowers/specs/2026-11-13-approval-gate-design.md).
Examples below illustrate the TypeScript ESM API; they are not verified runtime examples.

Enrollment is default-off: a missing `executors.yaml` or all-empty `allow` lists
leave agents unenrolled. Runtime resolution now loads that file; `run`, resume,
solo (`run --agent`), `call` and tidy stop before invoking agents if it is invalid
or unreadable. Doctor remains diagnostic (see [Doctor checks (stage 2a)](#doctor-checks-stage-2a));
status does not enforce qualification.
`ResolvedAgent.enrolled` and its minimal approval context travel through
`WakeInput.agent`; they are not new team/project YAML or run-state fields
(`src/approval-runtime.ts:16–40`, `src/cli.ts:272,350,653`, `src/call.ts:55–62`).

Stage 2b-2 gates enrolled run/resume/solo slots before claims, and checks enrolled
calls before creating their directory or lease. It does not deliver the full approval
workflow: no proposals grant, collection, rotation, approval CLI or executor launch.
The corrective containment/retained-configuration contract below is **pending final
implementation verification**; it must not be read as a security-release claim.

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
| `enrollment`, `runtime` | Role-based enrollment; initial configuration refusal; fresh configuration/enrollment loading. |
| `policy` | Itemized raw/canonical deny inventory; strict invocation-boundary refusal on incomplete inventory. |
| `wake-gate` | Qualification baselines/verdicts, fresh bounded loading, request-directory checks, recovery allowed-name scan and diagnostic side-file I/O. |
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
implementation; the separate wake gate only withholds wakes.

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
- **Instance cap.** `instanceCap` returns 1 for an enrolled role (`src/instances.ts:47`). The
  `applyEnrollment` helper sets the `enrolled` flag (`src/approval-enrollment.ts:19-27`);
  runtime resolution also applies enrollment (`src/approval-runtime.ts:30`).

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

- Doctor itself does not enforce; the runtime gate is described below.
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


## Runtime enrollment and wake gate (stages 2b-1 and 2b-2)

Enrolled Claude invocations use strict empty MCP configuration, retain
`--setting-sources user`, set `sandbox.failIfUnavailable: true`, disable hooks and
unsandboxed commands, and inherit only present `PATH`, `HOME`, `LANG`, `TERM`,
`TMPDIR`, `USER` values. Enrolled Codex is refused, including as a fallback.
The adapter unions fixed raw/canonical denies and other request-slot roots with
its policy, including when a policy override is supplied. An incomplete request
inventory prevents invocation; it is not permission to use a partial deny list
(`src/adapters/claude.ts:13–15,35–39,65–67,108–123`,
`src/adapters/env.ts:4–16`, `src/adapters/codex.ts:64–66`,
`src/approval-policy.ts:152–186`). These settings are construction behavior,
not proof that user settings, Edit aliases or OS sandbox enforcement are safe.

For enrolled run/resume/solo slots with pending mail, the dispatcher compares the
current qualification and canonical origin against the session baseline, using
`revalidateQualification` and `qualificationHash`. It checks each baseline executor
and the current allow union. Fresh YAML is capped at 1 MiB per file; failed,
non-regular, symlink or oversized reads fail closed with fixed categories.
A fresh view is shared within a dispatch pass; verdicts are evaluated before
`claimMessages`, not atomically with spawn or again for every fallback candidate
(`src/approval-wake-gate.ts:112–195`, `src/run-session.ts:655–721,773–800,836,1550`).

A qualification/premise refusal enters the existing in-memory `refused` set for
the rest of this run session. Fixing configuration alone does not clear it;
a new run or resume revalidates. A refused lead ends the run with `lead_failed`.
Skipped directory/residual-output verdicts withhold a wake before claiming mail;
slot-local exceptions do not reject the whole batch. Unread mail remains unread.
Member notices, terminal output and log events use fixed reason categories rather
than raw parser errors, paths or executor values (`src/run-session.ts:707–800`).
**Open classification:** the treatment of uncertain foreign configuration, git
inventory failures and scan limits as retryable skips versus persistent refusals
is under architectural review (K1); this reference does not establish its final
classification. Consult the final implementation review before enabling enrollment.

### Attempts and resume recovery

`latestSlotAttempt` uses parsed `started_at` descending, then numeric `AttemptRecord.n`
descending, never lexical filename order: at equal start times, `a10` follows `a2`.
An equal `(started_at, n)` pair is ambiguous. Matching damaged JSON, invalid fields,
unsafe/oversized files, unreadable claims or scan failure return `undeterminable`,
without falling back to an older attempt. Reads are no-follow, nonblocking regular-file
reads capped at 64 KiB; the entry scan is capped. This is stricter than legacy
`listAttempts`, which silently skips parse failures (`src/message-store.ts:285–400`).

Before enrolled resume recovery, `scanRecoveryInputs` builds allowed filename sets
for attempts and claims. It checks dispatcher-shaped names and bounded plain files;
enrolled records also have consumed fields and ownership/identity validated. Unknown
names and unsafe files are excluded. A damaged enrolled slot is quarantined for
that session; its files are removed from the allowed sets. Scan failure/overflow
allows no files and quarantines all enrolled slots. `recoverRunMail` receives a
skip predicate before opening excluded names; other verified slots can recover.
Quarantine does not collect, park or delete proposals, and needs repair plus resume
for another recovery scan (`src/approval-wake-gate.ts:286–396`,
`src/run-session.ts:684–688,1508–1509`). Request-directory anomalies and nonempty
`proposals/` also withhold wakes; stage-3 collection/parking is not implemented here
(`src/approval-wake-gate.ts:198–238`).

### Diagnostic side file and human status

`<runDir>/approval-gate.json` is a separate diagnostic file, not run state. Its v1
shape is `{ schema_version: 1, slots: { <slot>: { class, code, at } } }`, where
`class` is `refused` or `skipped`. The reader caps it at 64 KiB and rejects symlinks,
FIFOs, truncation, bad JSON, unknown versions or invalid fields. Human formatting
shows a fixed unreadable-file warning on failure. Writes use `atomicWrite`;
that is not fsync or power-loss durability proof. Reset/update failures leave
in-memory blocking intact and emit `approval_gate_file_error` plus fixed terminal
text (`src/approval-wake-gate.ts:242–280`, `src/run-session.ts:693–704`).

Only the current-run human status formatter reads these reasons, even if enrollment
has since been removed. `status --json` adds **no fields**, with or without
`executors.yaml`, and never reads this side file. Run-detail output (`status <run-id>`) and per-run monitor details do not show
these reasons; the monitor's current-project header uses the human status formatter.
The JSON-driven status-monitor pane lacks them
(`src/status.ts:564–591,633,668–689,718`, `src/cli.ts:839–854`).

Entries are **recorded observations**, not proof of an active refusal. They can
survive a resume with no enrolled agents or a failed reset. `at` records the reason's
observation time; it does not prove current blocking or freshness. Current formatter
wording still describes an active refusal/skip; its historical-observation wording
correction is pending. After rollback, read that text with this limitation.

### Containment correction pending final verification (Amendment A)

Amendment A distinguishes doctor's conservative descendant-alias diagnostics from
wake-time validation of granted authority. Its C1/C2 corrections must be rechecked
against final source before being described as delivered:

- Doctor keeps its existing alias walk and diagnostics. Wake validation uses configured
  or actual invocation grant roots and their canonical targets, not arbitrary mutable
  descendants as additional grants. New links/deep directories inside memory alone
  must not create cross-slot or cross-project refusal authority.
- Canonical roots, ancestor resolution, protected command/interpreter symlink hops
  and hop directories remain checked; real protected grant overlaps and canonical
  resolution failures remain failures. This does not relax root/hop checks.
- Both retained execution configuration (**actual**) and freshly loaded/bound
  configuration (**fresh**) must pass premises. Containment inventories their union,
  including teammates, candidates, instances and run-only grants, in addition to
  all-project/global-call disk inventory. A repaired disk file cannot erase actual
  retained `verify.commands` or unsafe grants. This does not hot-reload the session.
- Enrolled call checks must use actual `--dir` and the same call binding later used
  for invocation, plus the fresh global role's premises/grants. Calls are new, so
  they have no prior qualification hash or request-directory recovery check.

The inspected pre-correction code uses fresh-only project premises/full diagnostic
containment and does not pass the actual call binding into its gate
(`src/approval-wake-gate.ts:181–186,399–412`, `src/call.ts:166–185`).
The pending correction is therefore not evidence of those gaps being closed.

### Limits, trial and rollback

The lead scoped tidy, verify, format and web-summary spawning outside the 2b-2 gate;
these are implementation scope interpretations, not explicit exclusions in the
original user request. Stage-2b-1 adapter hardening still applies to enrolled adapter
invocations. An unenrolled lead's existing shell verifier is not disabled by this
change; withholding an enrolled wake is not proof that no verifier runs.

After the containment correction, all-project YAML reads and synchronous git-common-dir
inventory remain a cost; this is not a fixed whole-home work/time bound. Ctrl-C is
best-effort while synchronous checks run and is handled after control returns.
Doctor's 20000-entry descendant limit is per walk, counted after `readdirSync`
allocation, not a wake-time total-work guarantee. Amendment A removes that
mutable-descendant walk from wake validation, not the all-project/git inventory
(`src/doctor-approval-containment.ts:242–294,392–445`; Amendment A above).

There is no atomic gate-to-spawn/fallback guarantee, same-UID ancestor-replacement
protection proof, read isolation, or new Linux/real OS sandbox safety evidence.
`--setting-sources user` remains unchanged; user-settings merging/allowlisting and
Claude Edit alias behavior remain unverified safety blockers. Do not infer stage-3
readiness from a clean doctor report, fixture, example or fake runtime.
No proposals grant, collect/settle integration, request parking, call `ok.json`,
approvals CLI, executor, feedback or gc is delivered by stage 2b-2.

Keep enrollment off until the security corrections and independent review are complete.
Only then stage a trial in a dedicated temporary home/repository, initially with one
unenrolled lead and one enrolled member, no verifier commands, followed by resume.
Do not use production homes or credentials for that trial. Roll back by removing
allow entries (or `executors.yaml`) and resuming; enrollment is recalculated, while
historical diagnostic entries may remain. This adds no team/project YAML or run-state
migration. The existing no-enrollment byte fixtures remain the compatibility contract;
this documentation change neither modifies them nor supplies fresh fixture/runtime proof.
