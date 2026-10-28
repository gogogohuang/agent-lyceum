# Status liveness and watcher restart contract

Status: implemented against the approved revision 1 contract (2026-10-28); automated implementation review and QA are pending. Source inspection below does not certify real Claude Code mod/macOS behavior. See the [monitor guide](../monitor.md) and [繁體中文指南](../monitor.zh-TW.md).

## Liveness

Implementation: `src/project-lock.ts:133–191` (offset rule `:164–171`, verdict `:177–191`, UTC fallback `:189–191`); C/Chinese parsing is at `src/project-lock.ts:109–123` and legacy equality at `:125–131`. It is consumed by `src/status.ts` and existing lock callers.

- Keep legacy raw/canonical start-time equality, including C and Chinese `ps lstart` text, as the first alive exit. Only ESRCH establishes death from the signal probe; unknown errors stay alive.
- On non-Linux, only after the legacy comparison would report dead, read `ps` with `TZ=UTC0 LANG=C LC_ALL=C`. Interpret valid C/Chinese wall-clock fields as naive UTC. A difference divisible by 900 seconds within ±26 hours is also alive. Missing, failed or unparseable observations stay alive.
- The 26-hour bound accommodates writer/reader offsets from −12 to +14 hours even if `ps` ignores the UTC request. The same-holder recognition contract covers conventional quarter-hour UTC offsets, not arbitrary POSIX `TZ` strings. An odd offset such as `TZ=XYZ-3:17` with a different-zone reader remains a legacy false-dead limitation; legacy equality still protects the same-zone case. No universal timezone guarantee is made.
- New dead verdicts must be a subset of legacy dead verdicts: the change adds alive exits, rather than introducing a new reason to take over a lock. This invariant does not require an enumeration of all timezone offsets.
- Linux `proc:<ticks>` comparison stays unchanged; unreadable `/proc` stays alive. Linux text locks conservatively stay alive rather than applying the offset rule. The design's concern that procps text may move with a clock step is not independently verified here.

Accepted cost: PID reuse at an exact quarter-hour start-time difference can pass the offset test within the bound, leaving a stale lock apparently alive. Linux text locks also lose reuse detection. Inspect the named PID before any explicit force-clear; a conservative alive verdict does not authorize deleting a live lock.

Rejected: comparing start time with `acquired_at` plus 60 seconds of slack. A backward clock step between fork and lock acquisition can put a live process start after that threshold and permit takeover. The approved rule never reads `acquired_at`. Writing UTC/epoch or adding a field was rejected to preserve old-reader compatibility; heartbeat age is not liveness evidence for a busy holder.

## Writer locale

Since v0.29.0 (`fd09848`) the writer recorded C-locale `ps` text. An older agent-lyceum in a Chinese locale compares `pid_started` raw against its own Chinese `ps` text, judges the live holder dead and may take over the run's lock. Follow-up (task c8a026): the writer goes back to inherited-locale and inherited-timezone `ps -o lstart=` text. The reader in this branch is unchanged (legacy equality for C/zh, then the UTC0/C offset rule, unknown = alive).

- Older readers in the same locale/TZ accept the lock; v0.29.0 readers accept C and zh text.
- Accepted trade-off: a v0.29.0 reader against a lock written in another locale (e.g. Japanese) can misjudge it.
- The user's real-Mac run found the original bug; the fix on real macOS `ps` is not yet verified.

## Watch replacement

Implementation: `src/code-change.ts:4–37`, the `--watch` branch at `src/cli.ts:770–808`, the supervisor at `plugins/status-monitor/hooks/watch-restart.ts:1–38`, and wiring at `plugins/status-monitor/hooks/register.tsx:82–119`.

The watcher fingerprints sorted relative paths, sizes and mtimes of files matching its entrypoint extension, recursively within its existing code directory (`src/code-change.ts:8–25`, `src/cli.ts:782–795`). Unreadable trees yield an empty fingerprint and do not trigger replacement. A nonempty changed fingerprint equal on two consecutive reads triggers exit 75 and this stderr line:

```text
status --watch: agent-lyceum code changed on disk; restart to load it
```

This is a debounce, not a build-completion check: a build can pause between writes and the replacement can fail to load. The mod uses the child-end stderr marker, not an assumed mod exit-code API, to request replacement. It awaits each child before starting another, allowing at most five restarts per rolling 60 seconds measured by a monotonic clock. A rejected spawn, ordinary end, failed replacement or exhausted bound starts polling once and stays there until session restart. A thrown error whose text matches the marker does not request restart. Unbounded restarts and a retry timer to return from polling are rejected/deferred.

A new watcher starts with empty completion tracking (`src/status-watch.ts`), so completion during replacement may miss its toast. Old running CLI/mod processes have no new mechanism: after installing both updates, restart the Claude Code session once. A new `npx agent-lyceum@latest` cache directory is outside the old watcher's directory and also requires session restart. New mod/old CLI falls back to polling on child end; old mod/new CLI polls after the new exit.

## Compatibility and verification boundary

Required invariants: lock format unchanged (on macOS and the Linux fallback the writer records `pid_started` as `ps -o lstart=` in the process's inherited locale and timezone, as agent-lyceum < 0.29.0 did; on Linux with a readable `/proc` it records `proc:<ticks>`, `src/project-lock.ts:74–80`; see Writer locale below); config/state formats and run layout unchanged; non-watch `status --json` shape and watch frame shape unchanged; no new dependencies. Keep `isOpen` in `plugins/status-monitor/hooks/summary.ts` and `isFinishedRun`/`isCompletedRun` in `src/status.ts` unchanged. Liveness-derived values may move toward alive, including accepted conservative false-alive cases.

Automatic code replacement for `status --web`, `status --monitor` and running dispatchers is out of scope; these long-lived readers still need restarting to load new code. No migration of stored data is required by this contract.

Source inspection confirms the liveness branches (`src/project-lock.ts:177–191`, including the UTC fallback and final verdict at `:188–191`), the two-read debounce (`src/code-change.ts:29–37`), exit/marker handling (`src/cli.ts:782–803`), and sequential bounded restarts with persistent polling fallback (`plugins/status-monitor/hooks/watch-restart.ts:15–38`, `plugins/status-monitor/hooks/register.tsx:107–119`). The mod reads the first stderr line after the child ends (`plugins/status-monitor/hooks/register.tsx:82–104`); its clock is `performance.now()` (`plugins/status-monitor/hooks/register.tsx:117`). Automated implementation review and QA remain pending; no full-suite pass is claimed here. Real mod replacement and real macOS timezone/clock/sleep checks remain unverified.
