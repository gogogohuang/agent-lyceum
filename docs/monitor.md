# Monitor mod (Claude Code)

`plugins/status-monitor` is a Claude Code **mod**, not an ordinary plugin: it is written against Claude Code's mod hooks API (`import type { Register } from 'claude-code'`) and runs inside the Claude Code session, where it adds toasts and a `/status-monitor` pane that poll `agent-lyceum status --json`. It needs a Claude Code build that supports mods; it does not change how agent-lyceum itself runs. It shows live run status for one or several projects.

**Load it.** Build first (`npm run build`; the mod runs `dist/cli.js`), then start a session with:

```
claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor
```

`--plugin-dir` only applies when a session starts; an already-open session must be restarted (`claude --resume --plugin-dir ...` keeps the conversation). To load it every time, add `alias claude='claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor'` to your shell rc, or, for hosts where you cannot pass a flag (desktop app, SDK), set `CLAUDE_CODE_PLUGIN_DIRS` to the mod folder. While a session is running, saving a file in the mod folder hot-reloads it.

**Use it.**
- **Toasts:** a message pops up when a run finishes, is interrupted, or an agent's wake fails (prefixed `[project]` when several are watched). Nothing to do.
- **`/status-monitor`:** type it to open (or, if already open, close) the pane. It is off at session start unless `autoOpen` is set. In the **fullscreen layout** (`"tui": "fullscreen"` in `~/.claude/settings.json`, restart the session to apply; `/tui fullscreen` does the same) from 110 terminal columns it docks on the right at half the terminal width, and tabs and **關閉** (Close) can be clicked. Otherwise it shows above the prompt; the layout is fixed when the session starts, so a session started on the main screen stays that way. Keyboard (works in both): `x` closes, `v` switches graph/text, `e` expands or collapses the details, `1`-`9` or Tab/Enter switch task, Esc returns to the prompt, running the command again also closes. It draws one block per agent, with the links between the lead and each member taken from `can_message` (`▼` the lead may write to the member, `▲` the member to the lead, `↕` both; yellow marks the latest hand-off). Each block shows what that agent is doing now, the mail it is handling and the mail queued for it as one key line each: the point of the mail by type (task: the goal; reply: the changes; done: the result), plus any open item, risk or unfinished part it reports (none when it says None) — not the start of the text cut short. Press `e` to expand: every section of every mail (task: goal and acceptance criteria; reply: changes, verification, open items, risks; done: result and what is not done) and the full checklist; collapsed, the checklist is only the progress bar and the current step. Each block also shows its wake count and output tokens. An agent that is working right now is drawn larger: its block gets a row of its own at the full width, and its text wraps instead of being cut; idle and queued blocks stay compact. Above the graph: the run id and state, task, progress bar and checklist; below it: blocked integrations, notes and the result summary. `v` switches to the plain text list (per-runtime tokens, per-agent statistics, the last 8 wakes). Every block lists the agents it may message in a "→" line, with the latest hand-off marked "●" (this also covers member-to-member targets, which get no glyph). When the graph area is narrower than 70 columns (compared with the pane's own width, as the host reports it), the blocks stack in one column and the link glyphs are left out. Each running task is a tab, newest first; finished and interrupted runs are not listed. It refreshes with the polling interval while open.

**Configure it.** In `~/.claude/settings.json` under `pluginConfigs."status-monitor@inline"` (`options`):

| Option | Meaning | Default |
|---|---|---|
| `command` | CLI to run, split on spaces, e.g. `node /path/to/agent-lyceum/dist/cli.js` | `agent-lyceum` |
| `project` | Registered project name(s) (`-p`); comma-separate to watch several; empty infers from the session's directory | empty |
| `intervalSeconds` | How often status is polled | `1` |
| `autoOpen` | Open the pane when a session starts (it seats only from 144 columns when opened unasked) | `false` |

Changes take effect on the next session start. If the pane shows `無法取得狀態：...`, the `command` could not run (usually `dist/cli.js` was not built) or the project name is not registered.

**Fallback badge.** When an agent that has a fallback chain is running on a backup model, its block title carries a small `備援中` (on a fallback) mark; nothing else in the layout changes. Which model it fell back from and why, and any cooldown, are in `agent-lyceum status`.
