# Approval store API (stages 1–3)

**Unreleased API reference.** The store, doctor helpers, runtime enrollment and
per-wake gate follow the [stage-1 plan](superpowers/plans/2026-11-14-approval-store-stage1.md),
[stage-2b-1 plan](superpowers/plans/2026-11-14-approval-stage2b1.md),
[stage-2b-2 plan](superpowers/plans/2026-11-16-approval-stage2b2.md)
and [v12/v12.1 spec](superpowers/specs/2026-11-13-approval-gate-design.md).
Examples below illustrate the TypeScript ESM API; they are not verified runtime examples.

Enrollment is default-off: a missing `executors.yaml` or all-empty `allow` lists
leave agents unenrolled. Runtime resolution now loads that file; `run`, resume,
solo (`run --agent`), `call` and tidy stop before invoking agents if it is invalid
or unreadable. Doctor remains diagnostic, not an enforcer; its D8 probe does write temporary files (see [Doctor checks (stage 2a)](#doctor-checks-stage-2a));
status does not enforce qualification.
`ResolvedAgent.enrolled` and its minimal approval context travel through
`WakeInput.agent`; they are not new team/project YAML or run-state fields
(`src/approval-runtime.ts:16–40`, `src/cli.ts:272,350,653`, `src/call.ts:55–62`).

Stage 2b-2 gates enrolled run/resume/solo slots before claims, and checks enrolled
calls before creating their directory or lease. It does not deliver the full approval
workflow. That historical slice had no proposals grant, collection or rotation; stage 3 now delivers those (see [Request collection](#request-collection-stage-3-not-releasable)). Approval CLI and executor launch remain future work.
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
(`src/doctor.ts:257`). It is diagnostic, not enforcement. Stage 3 adds temporary writes for the D8 hard-link probe: when enabled, it chooses the first plain directory among `approvals/`, `requests/`, otherwise home, creates one exclusive scratch file and a hard link, then unlinks only those two names. If unlinking one of them fails, the probe reports `IO_ERROR` and that name can remain. Failures report fixed `UNSUPPORTED_LINK`, `UNSAFE_PATH` or `IO_ERROR` text (`src/doctor-approval.ts:23-38,53-67`; `src/approval-link-check.ts:43-77`). Default-off returns before probing (zero probes).

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
`proposals/` also withheld wakes in stage 2b-2; stage 3 now classifies and collects or parks attributable residual output before waking (see [Request collection](#request-collection-stage-3-not-releasable))
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
`executors.yaml`, and never reads this side file or collection storage. Run-detail output (`status <run-id>`) and per-run monitor details do not show
these reasons; the monitor's current-project header uses the human status formatter.
With a readable side file, human current-run status also prints `已收走的核可請求（已提交紀錄）：N`, or `無法讀取（未知，非 0）` on a failed/over-budget count. N counts committed records for this project/run, including denied and later states, excluding payload-only directories; it is not pending quota, denial-event count or source count. A missing gate file hides the section; an unreadable one warns instead (`src/status.ts:672-690`; `src/approval-collect.ts:468-494`). The `DIR_ANOMALY` status text is: `request directory needs repair, see the "approval_collect" class in log.jsonl (symlink or not_directory: make proposals and collected plain directories; corrupt: fix collected.seq; held: stop all runs, then remove a stale .coord directory; unsupported: use a filesystem with hard links)` (`src/approval-wake-gate.ts:59-61`).
The JSON-driven status-monitor pane lacks them
(`src/status.ts:564–591,633,668–689,718`, `src/cli.ts:839–854`).

Entries are **recorded observations**, not proof of an active refusal. They can
survive a resume with no enrolled agents or a failed reset. `at` records the reason's
observation time; it does not prove current blocking or freshness. The human `status`
formatter says so: each entry reads "<slot> 記錄於 <time>：當時判定…", a verdict recorded
at that time, not the present state. After rollback, read that text as history.

Recovery on an enrolled resume parses the text its pre-scan verified (`recoveryReadFile`) and
never opens an attempt or claim file again, so a name swapped for a FIFO or symlink after the
scan cannot be followed or block the resume. With scan-verified input, recovery also finishes the loaded attempt through `finishLoadedAttempt`, rather than `finishAttempt` re-reading it (`src/message-store.ts:494-500`). This is a recovery-read contract, not a same-UID TOCTOU safety proof.

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
Stage 2b-2 did not deliver proposals grants, collect/settle integration or request parking; stage 3 now delivers those (see [Request collection](#request-collection-stage-3-not-releasable)). Call `ok.json`, approvals CLI, executor, feedback and gc remain future work.

Keep enrollment off until the security corrections and independent review are complete.
Only then stage a trial in a dedicated temporary home/repository, initially with one
unenrolled lead and one enrolled member, no verifier commands, followed by resume.
Do not use production homes or credentials for that trial. Roll back by removing
allow entries (or `executors.yaml`) and resuming; enrollment is recalculated, while
historical diagnostic entries may remain. This adds no team/project YAML or run-state
migration. The existing no-enrollment byte fixtures remain the compatibility contract;
this documentation change neither modifies them nor supplies fresh fixture/runtime proof.

## Request collection (stage 3, not releasable)

**Not releasable: step 0 unverified** (「非可發布：第 0 步未驗證」). F3 (the user settings layer), Linux and enforcement by the real OS sandbox are **UNVERIFIED**; no run of the real Claude CLI with the `proposals/` grant was made. This section describes the current lifecycle wiring on this branch. It is not a release and it is not QA-verified. Operator-facing steps (the `approval_collect` class table, `.coord`, budget starvation) are in [Write scope](write-scope.md#approval-request-collection-stage-3-not-releasable). Nothing here is approve, execute, feedback, gc or `call` collection: those are **not implemented**.

### Request location, format and limits

- Slot root: `<home>/requests/projects/<project>/<run-id>/<slot>/` for a run; `<home>/requests/calls/<call-id>/` for a call. Inside: `proposals/` (agent writes), `collected/<seq>/` and `collected/<seq>.done`, `parked/<attempt-id>/`, `collected.seq` (high-water), `.coord/` (lock) (`src/approval-paths.ts:52-65`).
- File name (`REQUEST_FILENAME_RE`, `src/approval-id.ts:19`): the name does not start with `.`, then 1 to 64 characters from `A-Za-z0-9._-`, then the suffix `.req`, then the end. Anything else in the directory costs one work unit and is neither stat'ed nor recorded.
- `parseRequest(bytes, config)` is pure (`src/approval-request.ts:40-70`). Order of checks: size over `GLOBAL_READ_CAP` (65536 + 2048) → `too_large`; invalid UTF-8 or a forbidden character → `bad_content`; header shape (header and payload split at the first two consecutive LF bytes, `bytes.indexOf` of that pair, and those two bytes count toward the 2048-byte header limit; header lines are separated by one LF; at most two `key: value` lines; keys `executor` and `summary` once each; summary at most 300 code points) → `bad_header`; unknown executor → `bad_executor`; payload over the executor's `max_payload_bytes` → `too_large`. A bad header is reported before a missing executor. Allowed text: printable characters plus LF, TAB, U+0020 and U+3000; control, format, separator, variation-selector, default-ignorable and the listed filler characters are refused (`src/approval-request.ts:27-35,51-52`).
- A non-regular candidate becomes `denied_entry`/`not_regular`; a file larger than the read cap `denied_size`/`too_large`. The first `max_scan_entries` candidates by `(mtime, name bytes)` are processed; if more exist, one `denied_scan`/`scan_limit` record carries the exact `ignored_count` (`src/approval-collect.ts:320-385`).

### Rotation, recovery and sequence numbers

- `createRotation(deps)` returns `{ rotate, park, withSlotCoord }` (`src/approval-rotation.ts:68-72`). `rotate` lstat-checks the slot chain (a symlink, file or FIFO is `UNSAFE_PATH`), reads the high-water file (a corrupt one fails even with nothing to move), never moves an **empty** `proposals/`, refuses an existing destination, renames the whole directory, recreates `proposals/` with mode 0700, lstats it, and only then advances the high-water for a `collected` destination (`:106-141`).
- Sequence: `max(collected.seq, every numeric name in collected/ and every <n>.done) + 1`, compared as numbers (`src/approval-collect.ts:394-416`). A name with a leading zero or beyond the safe-integer range is `CORRUPT_HIGH_WATER`; a slot at the maximum is `SEQUENCE_OVERFLOW`. A crash between the rename and the high-water update therefore never reuses a sequence: the next pass raises the high-water from the directory names.
- A pass first finishes every `collected/<n>` without `<n>.done` in ascending order, then rotates the current `proposals/` (`:416-440`). Fault points for crash tests: `rotation:renamed`, `rotation:recreated`, `collection:enumerated`, `collection:high-water`, `collection:before-done`, `collection:done`, plus the store's publication points.
- **Record commit point:** `record.json` linked exclusively into `approvals/<id>/` (id = first 24 hex of the SHA-256 of the source key, deterministic). `.done` is written last. An existing record is adopted on re-entry, so quota is never re-applied to it (`src/approval-collect.ts:24-30,272-300`). The link-capability check block runs once per pass before the first record is read and probes both the slot root and `approvals/` with `checkApprovalLinks`; failures include `UNSUPPORTED_LINK`, `UNSAFE_PATH` and `IO_ERROR` (`src/approval-link-check.ts`, `src/approval-collect.ts:153-163`).
- **`.coord`:** `mkdir <slot root>/.coord` is the exclusive lock, taken and released on the unbudgeted io so running out of budget cannot leave it behind. An existing `.coord` throws `CoordHeldError` (class `held`) and is never stolen or aged out (`src/approval-rotation.ts:56-61,150-170`). Removing a stale one is a manual step; confirm first that no run of the project is live and no gc runs (gc does not exist in this stage).

### Work budget and verdicts

- `SCAN_WORK_BUDGET = 65_536` units per slot per pass (`src/approval-budget.ts:20`): one per charged call (lstat, mkdir, open, fstat, read, write, fsync, link, unlink, rename, rmdir, file close, opendir) and one per directory entry returned. `readdirSync` is never called; entries are read one by one from an `opendir` handle that is always closed. Not charged: closing a directory, the end-of-directory read, and taking/releasing the slot lock through unbudgeted I/O. File close runs before its charge (`src/approval-budget.ts:85-86`). The overflowing entry has already been fetched, so the bound is on units, not on exact call counts, and not on wall-clock time (`:1-12,60-80`).
- Overflow: `ScanBudgetExceeded` ends the pass. It does not roll back: earlier rotation renames and publications persist for recovery, even if recreation or high-water update did not finish (`src/approval-rotation.ts:139-144`). Earlier directories may already have `.done` or `scan_limit`/`ignored_count`; processing that has not reached those publication points creates neither (`src/approval-collect.ts:385-389,394-453`). Committed records are adopted on re-entry. Verdict `skipped RESIDUAL_OUTPUT`, or `skipped UNDETERMINABLE` when it happened in the `inventory` phase (the quota count; the quota is not guessed).
- The quota inventory is built lazily by the first request that passes the executor check, once per pass. It counts committed records whose disposition is still `pending` and whose current status is non-expired `pending`, `executing` or `unknown`, per (kind, project, role, executor) and in total. It reads each record and current state and may perform a lazy transition. This reference states no fixed per-record unit cost (`src/approval-collect.ts:168-209`).
- Failure mapping: premises not ok return skipped `PREMISE_FAILED` before any store I/O (`src/approval-collect.ts:145`). `verdictFor` (`:116-127`): an error the module cannot explain → `UNDETERMINABLE`; every `inventory`-phase failure → `UNDETERMINABLE`; otherwise budget or race → `RESIDUAL_OUTPUT`; a directory-phase failure (`coord`, `high_water`, `link_probe`, `rotate`, `park`, `list`) or class `held`, `not_directory`, `symlink`, `unsupported` → `DIR_ANOMALY`; anything else → `RESIDUAL_OUTPUT`. `prepare` refuses a nonempty `proposals/` it cannot attribute with `UNDETERMINABLE` (`:429-431`).
- Log line `approval_collect` carries only `slot`, `op`, `class`, `seq?`, `id?`, `count?`. `op` is one of `coord`, `high_water`, `link_probe`, `rotate`, `park`, `list`, `scan`, `read`, `publish`, `done`, `inventory`, `counter`, `pass`. `class` is one of `held`, `not_directory`, `symlink`, `missing`, `corrupt`, `unsupported`, `permission`, `race`, `mismatch`, `budget`, `cancelled`, `io`; the mapping is `classOf` (`:88-113`). `missing` is declared but returned by no code path. Nothing path-, errno- or payload-derived is logged.

### Records, rejection and counts

- Outcomes per candidate: valid → `pending` record with a qualification snapshot; otherwise a `denied` record with a fixed reason (`bad_content`, `bad_header`, `bad_executor`, `too_large`, `not_allowed`, `quota`, `not_regular`, `scan_limit`). Directory anomalies and failed premises create no record.
- Soft quota: `max_pending` per (project or call, role, executor) and `max_total_pending`, both from `executors.yaml` (defaults 10 and 50, `src/approval-executors.ts:33,38`). The inventory is taken once per slot pass and not locked across slots, so concurrent passes may exceed it.
- Denied records: the counter file `approvals/.denied-count/{run/<project>|call}/<role>` holds a decimal number and LF, written by temp file and rename. While it is below `DENIED_FULL_RECORDS` (100) a denied request also gets a full record; afterwards only the counter grows. It counts denial publication/aggregate events, not refused files: one `scan_limit` event carries `ignored_count`. An existing record returns before the counter increments. Past the cap there is no record: a directory that already has `.done` is not scanned again, so that replay leaves the counter unchanged; reprocessing an unfinished directory increments it again. A crash after a record is published and before the increment can undercount, and unlocked read-add-write can lose concurrent updates (`src/approval-collect.ts:252-268,385-389`). An unparsable counter is `corrupt`, not 0.
- **Parked requests** are never collected and never become redo drafts (`src/approval-rotation.ts` `Park`; spec 4.4); the agent has to ask again.

### Wiring in a run

This is the current S3 wiring on this branch (not a release, not QA-verified).

- **Collection points.** `settle()` calls `collectApprovals(batch)` after `routeOutboxes` and before the claim commit, so it also covers `resume`'s `settle([], [])`. It visits every enrolled, non-quarantined slot (not only the batch), checks the abort signal before each one, and a failure in one slot gates it with a fixed reason and does not stop the others. Unexpected exceptions or a failed fresh view retain output and invoke `retainedOutput`: fixed log, gate reason, terminal diagnostic and lead notice, never mail to the lead itself (`src/run-session.ts:898-993`). A slot whose qualification no longer matches is judged by the existing gate verdict instead.
- **Before a claim wake** the gate's directory check runs `prepareSlot`: older collected-but-unfinished directories are finished, a non-empty `proposals/` is collected if the slot's latest attempt says its claim is `output_ready` or `committed`, parked if that attempt failed or its claim is `abandoned`, and otherwise the slot is not woken (`UNDETERMINABLE`). Only an existing, empty, canonical `proposals/` lets the wake go on.
- **Grant and prompt.** `proposalsDir` is set on a claim wake of an enrolled slot only, and is added last to the allowed directories (`writePolicy(project, agent, proposalsDir)`); `policy` wakes (tidy), verify, format and `call` never carry it. The system and user prompts get the fixed text from `approvalRequestsBlock`. `proposals/` is re-checked before the first call, each retry and each fallback.
- **`origin.full_writable`** is `slotGrants(invocationProject, …).full` at collection time (`invocationProject()` is the same project object a wake uses). On the normal path that equals the grant of the wake just finished; after a crash it is the grant when the resume collected, not the original wake's. It is displayed and not compared.
- **Failure and cancel.** After `parkOutbox` and before `finishAttempt`, `proposals/` is parked under the attempt id. For a failed attempt, a parking failure produces a `config` failure, which is never retried and never falls back (`src/fallback.ts:117`), and only that slot is gated; requests and unread input are kept, the claim is abandoned, and the lead is notified except by self-mail. Other slots continue. Dispatch passes or resume can recheck the cause; no automatic repair or background retry is promised (`src/run-session.ts:1253-1286,949-993`). A cancelled wake also attempts that park. If parking throws, the failure is logged and then ignored: the attempt is still finished `failed` with error `cancelled`, the claim is abandoned, unread input stays for resume, and this path does not use the `config` stop (`src/run-session.ts:1245-1251`; `src/fallback.ts:236`; `src/run-session.ts:1288-1294`). `call` slots and instance slots (`<role>--N`) are not collected yet.
- **Recovery (`recoverRunMail`), b-window ordering.** For a `started` latest attempt: park outbox, park proposals, then finish the attempt `failed`. For a `claimed` claim whose newest attempt may own the directory: park proposals first, then save `abandoned`; only claims turned from `claimed` to `abandoned` in this pass are handled, so historical abandoned claims are not parked again on every resume. Each slot is wrapped separately; if parking throws, neither the attempt nor the claim of that slot is finished and the slot is quarantined for this process. The recovery hook logs the park failure and quarantines the slot; later gate evaluation returns `UNDETERMINABLE` and uses the usual reason-file, terminal and lead-notice path (no self-mail), not `retainedOutput` directly (`src/run-session.ts:754-757,949-993,1770-1788`; `src/message-store.ts:494-527`). With scan-verified input recovery finishes the already verified attempt record (`finishLoadedAttempt`) and does not reopen the file.

### Residual risks and trade-offs

- **Residual process or descriptor (spec 4.4):** an escaped background process can write into the new `proposals/` after rotation (seen at the next pass; it can only add requests, bounded by quota). A descriptor held on a rotated file can still change that file under `collected/<seq>/`; the collector compares device and inode before and after the read only. The copy stored under `approvals/` is not touched by it. The assumption that the agent cannot replace `proposals/` itself was measured as false on macOS (spec section 8), so the first line of defense is the lstat check at rotation.
- **Write scope is not read isolation.** The `proposals/` grant concerns writing only. No code in this stage restricts reading; do not describe requests or their payloads as confidential.
- **Trade-offs recorded:** work budget instead of a time bound; a permanently over-budget `collected/<seq>` or store inventory blocks its slot (or all slots) until the operator acts, because dropping or half-marking requests would lose them; the quota and the denied count are soft/approximate; a failed attempt whose requests cannot be parked gates only that slot rather than risking a mix of two attempts' output.
- **Not implemented:** approve, execute, feedback, `requests gc`/`approvals gc`, collection for `call`, collection for instances.
