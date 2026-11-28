# Task file template

Copy this to `spec.md` and fill it in, then run `agent-lyceum run --task-file spec.md`. A task that states its scope, acceptance criteria and verification command up front lets the lead send all independent work in one wake-up and skip the QA layer for a small fix (see [Saving tokens](configuration.md#saving-tokens)). A task file without an Acceptance criteria or a Verification section gets a warning (it still runs). Delete the hints in parentheses.

```markdown
# <One-line title>

## Scope
(What to change and why, in a few sentences. List the files or modules you expect to touch; the lead uses this to decide what can run in parallel.)

## Acceptance criteria
- `npm test`
- src/web/feature.txt

## Out of scope
(Files, modules or behaviour that must not change.)

## Verification
- `npm test`

## If blocked
(Stop, send a reply listing what was tried, and do not guess.)

## Needs approval
(Actions that need the user's yes first, for example touching production.)

## Small change?
(yes / no. Answer yes only when it is a few lines, has a test that fails before and passes after, and changes no user-visible behaviour. A yes lets the lead skip QA after an approving code review.)
```

An acceptance line that is only `None`, `` `None` ``, `as stated` or `同上` is sent back. `verify.bind_task` extracts a command only when the bullet is that command and nothing else, or when the line sits in a fence opened by a line of three backticks, optionally followed by a language name such as `bash`. A backtick inside a sentence is not extracted. A fence looks like this, with the opening line of three backticks on its own:

    npm run typecheck

The line above is the command. Put it between a line of three backticks and a closing line of three backticks under `## Verification`.
