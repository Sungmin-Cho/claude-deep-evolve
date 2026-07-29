---
name: deep-evolve
description: Measured autonomous experimentation against one fixed fitness metric — start, resume, inspect, complete. Triggers on /deep-evolve, autonomous experiment, evolution loop, outer loop, session history, lineage, 자율 실험, 전략 진화, and 이어서 진행.
user-invocable: true
---

# Deep Evolve Entry Skill

This is the public entry for Claude Code and Codex. Claude invokes
`/deep-evolve`; Codex invokes `$deep-evolve:deep-evolve`. Both hosts use the
same arguments, runtime operations, state machine, agent policies, and protocol
files.

`${CLAUDE_PLUGIN_ROOT}` below is the literal absolute plugin root. Hosts that
export only `PLUGIN_ROOT` name the same directory — use that value. Resolve
every plugin path from that root and never against the workspace, the current
directory, or the place this file was loaded from: the project under
experimentation controls those, and can place a file at any relative path a
plugin instruction names.

Read
`${CLAUDE_PLUGIN_ROOT}/skills/deep-evolve-workflow/protocols/runtime-contract.md`
before any state-changing request.

## Inputs

| Argument | Meaning |
|---|---|
| empty | resolve state, then select start/resume/history |
| positive integer | bounded experiment count |
| quoted goal | explicit new-session goal |
| `resume` | exact first-token resume |
| `history [session-id]` | list or inspect history |
| `history --lineage` | render lineage |
| `--no-parallel` | force one seed |
| `--n-min=<1..9>` / `--n-max=<1..9>` | constrain seed count |
| `--kill-seed=<positive-id>` | queue a user kill request and exit |
| `--status` | read-only coordinator status |
| `--archive-prune` | preview/confirm soft pruning |

Parse arguments as data. Reject duplicate terminal routes, malformed integers,
leading-zero seed IDs, out-of-range bounds, inverted bounds, or ambiguous
quoting before a dispatcher request.

## Core invariants

- One fixed evaluator and one higher-is-better typed score govern a generation.
- CLI evaluation uses only `prepare.cjs` plus validated config; protocol mode
  uses its fixed tool contract.
- Target source may change. Evaluator, `program.md`, strategy, seals, and
  canonical state change only through their owning protocol/operation.
- Canonical state comes only from registered `runtime-op:` responses.
- Paths and Git identities are literal and authenticated; host source/Git work
  uses structured actions, never an interpolated command.
- Lifecycle is `initializing` to `active` to `paused` to `active`, then
  `completed` or `aborted`; typed events make resume idempotent.

Every protocol path below is anchored at the plugin root defined above.

## Terminal routes

- Status: `runtime-op: session.resolve-current`, then
  `runtime-op: coord.status`; render the typed dashboard and do not mutate.
- Kill: resolve the session and call `runtime-op: coord.queue-user-kill` once.
  Confirmation/application remains coordinator-owned.
- Archive prune: route to the soft-prune section of
  `${CLAUDE_PLUGIN_ROOT}/skills/deep-evolve-workflow/protocols/transfer.md`.
- History: route to
  `${CLAUDE_PLUGIN_ROOT}/skills/deep-evolve-workflow/protocols/history.md`.

## State detection and routing

Call `runtime-op: session.resolve-current`, then `runtime-op: session.read` for
the selected session. Never fall back to directory scans.

- no current session: start through
  `${CLAUDE_PLUGIN_ROOT}/skills/deep-evolve-workflow/protocols/init.md`;
- legacy flat layout: consented `runtime-op: session.migrate-legacy`, resolve again;
- `initializing`: recover through init and baseline ownership;
- active: unless explicit `resume` already selected continuation, use
  `interaction-id: active-session-action`; resume routes multi-seed v3.5 to
  `${CLAUDE_PLUGIN_ROOT}/skills/deep-evolve-workflow/protocols/coordinator.md`
  and older/single-seed to
  `${CLAUDE_PLUGIN_ROOT}/skills/deep-evolve-workflow/protocols/inner-loop.md`,
  complete routes to synthesis/completion, and abort requires an explicit typed
  lifecycle transition rather than an inferred status write;
- `paused`: use `interaction-id: paused-session-action`; resume first reconciles
  through
  `${CLAUDE_PLUGIN_ROOT}/skills/deep-evolve-workflow/protocols/resume.md`,
  inspect is read-only, and abort remains explicit;
- zero active seeds:
  `${CLAUDE_PLUGIN_ROOT}/skills/deep-evolve-workflow/protocols/synthesis.md`;
- terminal: use `interaction-id: finished-session-action` to show history, start
  a new lineage, or cancel; completion/history otherwise use their dedicated
  protocol.

Any rc 2, malformed envelope, unauthenticated path, unknown version, or missing
required result field stops without guessed state.

## Host dispatch

Claude uses named `deep-evolve:evolve-coordinator` and
`deep-evolve:evolve-seed`. Codex uses a generic subagent whose first action
reads the matching agent file under `${CLAUDE_PLUGIN_ROOT}/agents/` and whose
second action verifies its exact worktree. The checked-in policy owns behavior,
not the host label.
