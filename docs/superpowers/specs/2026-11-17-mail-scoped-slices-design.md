# Mail-scoped implementation slices (design)

Date: 2026-11-17  
Repo impact: `agent-lyceum-config` personas only (no dispatcher / no `ship` changes)

## Problem

Cross-mail session resume was fixed so a new mail starts a fresh session. Within one wake, implementers still burn large cache_read (e.g. one node-engineer wake at ~11.8M) when a single task mail packs a whole stage and the agent runs the full suite inside the conversation.

## Goals

- Lead dispatches **one independently mergeable feature or bugfix per implementation mail** (not a whole stage/ADR, and not a three-line trickle).
- Full project test / lint / typecheck evidence comes from a **separate integration-verification mail**, not from the implementer's coding wake.
- **Do not change** `ship` / `ship.verify` config, CLI, or when ship runs.

## Non-goals

- Harness rejection of oversized mails, wake token caps, or Bash denylists.
- Changing agent-lyceum runtime code.
- Changing report-lead mail bundling (non-implementation flow).

## Rules

### Implementation mail (product-lead)

Each implementation task must include:

- Related acceptance criteria for **one** independently mergeable slice (a few related ACs and files are fine).
- Allowed files/modules and out of scope (including: do not run the full suite in this wake).
- Slice-level verification command(s) for this wake.

Dispatch **one such mail at a time**; wait for the handoff (or an explicit stop) before the next slice. Existing `parallel: true` rules stay: only independent slices may run in parallel, and each mail is still one mergeable slice. Assign the reviewer as today.

Remove the instruction to “bundle related work into one task” for implementation mail.

### Integration verification

After the relevant slices (or before `done` when DoD needs suite green), lead sends an integration-verification mail (typically to `qa`, or the implementer when no qa) to run the project's full test / lint / typecheck as applicable and report evidence.

DoD item “lint, type-check, and tests pass” is satisfied by **that** evidence, not by requiring every implementation wake to run the full suite.

### Implementers

In the wake: red/green on the task's named verification only; keep output tails. Do not dump the full suite into the conversation. Ship / `ship.verify` remain as configured—do not disable them.

### Architects

Designs may list multiple slices (each an independently mergeable feature/bugfix with file boundaries). Lead still dispatches them one mail at a time.

## Flow

```mermaid
sequenceDiagram
  participant U as User
  participant L as product-lead
  participant A as architect
  participant I as implementer
  participant R as reviewer
  participant Q as qa / integrate

  U->>L: large task
  L->>A: design (optional; may list many slices)
  A-->>L: slice list
  loop one mergeable slice per mail
    L->>I: implementation mail
    Note over I: ship unchanged; no full suite in chat
    I-->>L: reply
    L->>R: review
    R-->>L: verdict
  end
  L->>Q: integration verification
  Q-->>L: full suite evidence
  L->>U: done
```

## Files to change (config)

- Lead: `agents/product-lead/AGENT.md`, `projects/linego/agents/product-lead/AGENT.md`
- Implementers (global + project overrides that copy the “whole suite” line)
- Architects / architect-reviewers: sliceable wording
- QA: accept / perform integration-verification mails for the full suite

## Success signal

Later runs show implementer wakes without “full suite inside the chat” growth patterns, while `ship.verify` still runs as before, and DoD still has suite evidence via the integration mail.
