# Approval store API (stage 1)

**Unreleased contract reference.** This describes the independently approved
[stage-1 plan](superpowers/plans/2026-11-14-approval-store-stage1.md), based on the
[v12/v12.1 spec](superpowers/specs/2026-11-13-approval-gate-design.md).
Implementation delivery, final export reconciliation and test evidence are pending.
Examples below target the planned TypeScript ESM API; they are not verified runtime examples.

Stage 1 is a self-contained, default-off module set. No existing runtime imports it:
there is no integration with `settle()`, `doctor`, `call`, `run-session`, adapters or
CLI, no automatic config read and no import-time I/O. No approvals commands or
executor runner are delivered. Existing `ResolvedAgent`/`WakeInput` membership
integration is deferred; `ApprovalQualification` is a standalone wrapper.

## Modules and direct calls

Names below are module names, not links to undelivered source files.

| Module (`approval-*.ts`) | Exports by responsibility |
|---|---|
| `types`, `schema`, `paths` | Readonly record/state/source/output types; `ApprovalError`; strict `parseApprovalRecord`, `parseApprovalState`; pure `storePaths`, `requestPaths`, `recordPaths`. |
| `id` | Pure `encodeSourceKey(key): Buffer`, `approvalId(key): ApprovalId`. |
| `executors` | Pure `parseExecutors`, `qualificationOf`; explicitly called `loadExecutors(home, userHome, io?)`. |
| `origin` | Pure `staticWritable`, `qualificationHash`; injected `resolveOrigin`, `revalidateOrigin`. |
| `io`, `store` | Read-only `readApprovalFile`, `readRecord`; mutations `publishExclusive`, `publishRecord`. |
| `transition`, `liveness`, `state` | Pure `decideTransition`; probing `creatorLiveness`; read-only `readCurrent`; mutating `transition`. |
| `display`, `json` | Pure `computeDisplay`, `serializeApprovalList`; versioned list types, no scanner or CLI. |
| `high-water` | `readHighWater`, `maxCollectedSequence`, `nextCollectedSequence`; mutating `advanceHighWater`. |
| `rotation` | **Types only:** `Rotate`, `Park`, `ProposalsOf`, destination/result types. No callable rotate/park/proposalsOf implementation or stub. |

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

`computeDisplay(current, nowMs, creator)` computes unwritten expired/unknown without
changing persisted sequence/time; executing requires supplied liveness evidence.
`serializeApprovalList({ schema_version: 1, requests, problems })` validates and sorts
requests by ID and problems by `(id,path,code)`, returning JSON plus LF. Items include
origin, proposer, executor, timestamps, display, reason and payload hash/size; omit
payload, summary, snapshot/env and executor output. Problems explicitly report corruption.
This is only the future list output contract; existing `status --json` is unchanged.

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

Errors are separate domains. `ApprovalError` carries code/path/cause without secrets:
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
