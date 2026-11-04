# Task file template

Copy this to `spec.md` and fill it in, then run `agent-lyceum run --task-file spec.md`. A task that states its scope, acceptance criteria and verification command up front lets the lead send all independent work in one wake-up and skip the QA layer for a small fix (see [Saving tokens](configuration.md#saving-tokens)). Delete the hints in parentheses.

```markdown
# <One-line title>

## Scope
(What to change and why, in a few sentences. List the files or modules you expect to touch; the lead uses this to decide what can run in parallel.)

## Acceptance criteria
- (Each item is checkable: a command's output, a test name, a visible behaviour.)

## Out of scope
(Files, modules or behaviour that must not change.)

## Verification
(The exact commands that must pass, for example `npm run lint && npm run typecheck && npm test`.)

## Small change?
(yes / no. Answer yes only when it is a few lines, has a test that fails before and passes after, and changes no user-visible behaviour. A yes lets the lead skip QA.)
```
