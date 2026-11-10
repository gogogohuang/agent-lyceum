# Web console: every CLI command from the browser

Date: 2026-11-10 · Status: draft, awaiting review

## Goal

`status --web` today is a read-only monitor (plus `POST /quota` and `POST /summary`). Make the web page able to run **every CLI command**, with dangerous actions gated by confirmation. Local, single-user use only: no accounts, no remote access, no multi-user. The console runs on localhost for now and is never exposed to the internet; exposing it (reverse proxy, tunnel, `--host 0.0.0.0`) is unsupported and the write API refuses it (see section 2). Real remote access would need authentication and its own design, and is out of scope.

## Decisions (agreed in discussion)

1. **Scope B**: all commands are operable from the page; dangerous ones are tiered and need confirmation.
2. **Detached execution**: `run`, `resume`, `call`, `tidy`, `demo` started from the page keep running if the page or the web server goes away. The page is a launcher and a viewer, not the owner of the process.
3. **Approach 1**: the server spawns the CLI as a child process. No second implementation of command logic, no refactor of `cli.ts`.

## Non-goals

Multi-user or login, remote exposure, editing `AGENT.md` / `project.yaml` in the browser, interactive terminal or WebSocket shell, changing the CLI's behaviour or flags.

## 1. Server: command layer

New `web/src/server/commands.ts` (pure: table + validation, no sockets).

Each entry: `{ id, tier, mode, validate(body) -> argv }`.

- `tier`: `normal` | `confirm` | `typed`.
- `mode`:
  - `short`: runs to completion with a timeout; response `{ exit, stdout, stderr }`. Commands: `doctor`, `project` (list), `project add`, `project remove`, `clear`, `init`, `status --task-list/--task-id --json`.
  - `detached`: response `{ jobId, pid }` at once. Child is `detached` + `unref`; stdout/stderr go to `<home>/web-jobs/<jobId>/out.log`; `job.json` records argv, start time, exit code (written by a small wrapper on exit). Commands: `run`, `resume`, `call`, `tidy`, `demo`.
- The child is `process.execPath` + the local `dist/cli.js`, argv is an **array, never a shell string**. `--home` and `-p` are always passed; `cwd` is the project directory, never inferred.
- `validate` accepts a whitelist of fields per command and reuses the CLI's own format rules (run name, project name). Free-text values (task, follow-up) are single argv elements. Body size limit 256 KB.
- Interactive CLI parts become non-interactive:
  - `resume --answer`: the page renders the questions, writes answers into `ask-reply.md` through the existing `ask-answer.ts` parser/validator, then spawns `resume <run> --answer --no-edit`.
  - `resume` without a run (picker): the page always sends the run id.
  - `init`, `demo`: always `-y`; confirmation is the page's dialog.
- `status` (read-only) keeps using the existing hub. `status --web` itself is the server and is not exposed as a command.

HTTP:
- `POST /api/cmd/<id>` run a command.
- `GET /api/jobs`, `GET /api/jobs/<id>` list jobs, read the tail of `out.log` (SSE or polling).

## 2. Security and confirmation

Gap today: `guard.ts` checks Origin only for `POST /quota`, and a missing Origin passes.

For every `POST /api/*`:
1. Host check (existing, DNS rebinding).
2. `Origin` must be present and same-origin (missing → 403). `/quota` behaviour unchanged.
3. CSRF token: random per server start, injected into `index.html` as a `<meta>`, sent as `X-Lyceum-Token`, compared in constant time. A stale token after a server restart yields 403 and the page asks the user to reload.

Non-loopback `--host`: the existing code disables all checks because the user chose to expose the server. The write API is **always disabled** in that case (403 with an explanation). There is no flag to enable it; the console is local-only.

Tiers, enforced by the server, not only the UI:
- `normal`: run directly. `status`, `doctor`, `project`, `project add`, `run`, `call`, `resume`, `demo`, `init`.
- `confirm`: request must carry `confirm: true`. `clear`, `project remove`, `tidy`. The UI first runs `--dry-run` (where the CLI has it) and shows what would be deleted and kept.
- `typed`: request must carry `confirmText` equal to the target name (project name or run id). `project remove --purge`, `clear --lock --force`.
- Missing confirmation field → `428` with the required kind; the UI upgrades to the matching dialog.

Other: project-lock conflicts are left to the CLI; the page shows its exit code and stderr as is. `call --dir` keeps the CLI's restriction (not inside the home).

## 3. Front end

Existing stack kept: React 19, Tailwind 4, the ops-console tokens in `styles.css` (`--c-signal`, `--c-failed`, `--c-warn`, light/dark by OS). No new palette or fonts. Guidance from the ui-ux-pro-max skill: confirm before irreversible actions; loading → success/error feedback on submit; visible focus ring on every control; focus never hidden by sticky UI; whole flow usable by keyboard.

- **Dialogs** use native `<dialog>` (focus trap, Esc, backdrop). Focus goes to the first field on open and back to the trigger on close. The submit button disables immediately after press (a duplicate submit would start a second agent run).
- **`CommandDialog`**: one generic component driven by field definitions shared with the server (types in `web/src/types.ts`). Visible labels, errors next to the field (server 400 mapped to fields). Result stays in the dialog with CLI output: running / success / failure. Exit codes: `0` success, `2` partial/blocked (warn colour), `3` waiting (points to answering), others failed colour. Colour is never the only signal; text and icon are always present.
- **Danger styling**: `confirm` shows action, target, and the dry-run result; confirm button in failed colour; Cancel is the default focus. `typed` adds an input that must match before the button enables.
- **Layout**:
  - In `ProjectView`: toolbar (New task, tidy, doctor) and a per-run action menu (resume / follow-up, clear, task details). A run in `waiting` shows a clear marker and an "Answer questions" button opening `AnswerDialog` (options, free text, suggested values, "use all suggestions" = `--assume-defaults`).
  - New tab **Tools**: `project add/remove`, `call`, `init`, `demo`, `clear --lock --force`.
  - New tab **Jobs**: detached jobs from `job.json`, with the `out.log` tail and exit code.
- Touch targets at least 44 px, 8 px+ spacing, no horizontal scroll on narrow widths. Motion only on dialog open/close, short, off under `prefers-reduced-motion`, no width/height animation.
- Implementation runs ui-ux-pro-max's pre-delivery checklist (contrast, focus ring, keyboard path) and exercises the page in a real browser before calling it done.

## 4. Testing and docs

Tests (vitest, style of `test/web-*.test.ts`):
- `commands.ts` table-driven: fields → argv; missing/invalid fields → 400; values containing spaces, quotes, `;`, leading `--` stay one argv element; `confirm`/`typed` missing or wrong → 428/rejected.
- `guard.ts`: `/api/*` with missing/cross-site Origin, missing/wrong token → 403; non-loopback bind → write API 403; `/quota` unchanged.
- Integration with a fake CLI entry: short command returns `{ exit, stdout, stderr }` and times out; detached returns `jobId` at once, writes `job.json`/`out.log`, survives server close, listed after restart.
- Answer flow: answers written to `ask-reply.md` pass `ask-answer.ts`; option, free text, suggested paths.
- `CommandDialog` state machine (running, success, failure, 428 upgrade).
- **Coverage test**: compare the commands registered in `cli.ts` with `commands.ts`; a CLI command with no web entry and no explicit "unsupported, reason" entry fails the test.

Docs:
- `docs/commands.md` `status --web`: write API, token, local-only rule. Mark as a **behaviour change** (write API disabled on non-loopback binds).
- New `docs/web-console.md` (+ `.zh-TW.md`) for per-command location, tiers, security model; `docs/web-access.md` untouched (different topic). `README.zh-TW.md` synced.
- Version bump and changelog are left to the release step.

## Open items

None. (Version bump and release notes are intentionally deferred to the maintainer.)
