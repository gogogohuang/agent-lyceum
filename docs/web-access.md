# Web access (`allow_web`)

By default no agent can use the web. Claude Code agents are woken in headless `dontAsk` mode, where anything not explicitly allowed is refused, so `WebSearch` and `WebFetch` are denied unless you opt in per agent with `allow_web` (in `team.yaml` or `project.yaml`; the project value wins). It only decides whether the agent may use the web tools; the [write scope](write-scope.md) is unchanged.

| Value | Claude Code | Codex |
|---|---|---|
| unset | no web tools (as before) | nothing is passed: Codex keeps its own default |
| `none` | no web tools | `-c web_search="disabled"` |
| `search` | `WebSearch` | `-c web_search="cached"` |
| `fetch` | `WebSearch` and `WebFetch` | `-c web_search="live"` |

## `search` or `fetch`?

- **`search`**: the agent can run a search and gets a list of results (typically titles, links and short snippets). It cannot open a page, so it only knows what the results say. That is enough for "which Node versions are still supported?", "what is the latest release of this library?" or "is this API deprecated?".
- **`fetch`**: everything `search` does, plus reading the page behind a URL, so the page's text goes into the agent's context. You need it when the answer is inside a page: a specification, one section of an API reference, an issue thread, or a URL you put in the task.

The two are separate levels because the risk is different. Text read from a page can carry instructions written for the agent ("ignore your rules and ..."), known as prompt injection. With `fetch` that text arrives in full; with `search` only snippets do. The more an agent can do (edit your repository, run commands), the more this matters.

**Which agents to give it to.** Start with nothing. Give `search` to roles that look things up. Give `fetch` only to roles that really must read specific pages and do little editing, such as a requirements or research role like `pm`. Keep the members that edit your repo (for example `fe-member`, `qa-member`) off, and have the lead or the pm look things up and put the result in the task.

## Things to know

- **Unset is not `none`.** Unset leaves each runtime's own default alone: Claude Code has no web tools, but Codex may already have web search on. Set `none` to turn it off explicitly.
- **Codex has one `web_search` setting, not two tools**, so `search` and `fetch` map to `cached` and `live`. As Codex describes them, `cached` answers from an index instead of browsing, and `live` searches the web in real time; this is an approximation by risk. `codex exec` takes no `--search` flag, so agent-lyceum passes `-c web_search="..."`.
- **Not run end to end.** The Codex setting and its allowed values were checked against Codex 0.160.0, but the behaviour of `cached` / `live` and of Claude's two tools was not exercised against the real CLIs (that costs tokens). Try it once on the agent before relying on it.
- `call` reads the field from `team.yaml`, and `run --agent` keeps it.

```yaml
# team.yaml
agents:
  pm:
    runtime: claude-code
    allow_web: fetch        # may search and read pages; agents without the field have no web tools
```
