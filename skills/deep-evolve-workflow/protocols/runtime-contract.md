# Host-Neutral Runtime Contract

This file is the single authority for dispatcher invocation, response/rc
handling, stable interactions, and Claude/Codex dispatch adapters. Protocols
name operations as `runtime-op:` references and never replace a rejected
request with direct state mutation.

## Literal request and dispatcher paths

Derive the literal absolute plugin root from the loaded skill file. Derive and
authenticate the literal project root from the loaded workspace. Store each
complete request below literal `PROJECT_ROOT/.deep-evolve/.runtime-requests/`
with a unique JSON name. The request has exactly `schema_version`, `operation`,
`context`, and `payload`; schema version is `1.0`, and context carries the
literal absolute project root.

Invoke Node with discrete arguments. These examples are literal path-shape
contracts, including spaces:

- `node "C:\Users\dev\Deep Evolve Plugin\hooks\scripts\deep-evolve-runtime.cjs" --request "C:\Users\dev\Project With Spaces\.deep-evolve\.runtime-requests\01J00000000000000000000000.json"`
- `node "/Users/dev/Deep Evolve Plugin/hooks/scripts/deep-evolve-runtime.cjs" --request "/Users/dev/Project With Spaces/.deep-evolve/.runtime-requests/01J00000000000000000000000.json"`

Write one request, invoke once, and parse stdout as exactly one JSON object.
Verify schema, operation, `ok`, and the documented result/error fields before
using them. Preserve warnings as diagnostics, never as permission.

## Exit and envelope contract

- rc 0 requires `ok: true`; consume only authenticated result fields.
- rc 1 requires `ok: false`; follow only the documented business branch.
- rc 2 is an operator, schema, integrity, or runtime failure and stops.

Malformed JSON, empty/multiple envelopes, operation mismatch, or rc/envelope
mismatch must stop. No guessed state or direct write may substitute.

## Canonical authority and operation IDs

Mutations use a fresh stable operation ID plus every required preimage digest.
Exact replay returns the original projection with `replayed: true`. Reusing an
ID with different input, malformed digests, unknown fields, stale authority,
path escape, symlink ambiguity, or non-finite data fails closed. State-coupled
events are written only by their typed owner.

For v3.5, `session.start.initial_state` owns immutable initialization;
`virtual.append-seed` owns absent-seed initialization; experiment, kill, block,
epoch, and completion transitions each have one typed owner; strict rebuild
derives only the shared projection. Compatibility operations are version-gated.

## Host-owned structured operations

Ordinary source/Git actions use a host-owned structured tool adapter with a
literal authenticated cwd, discrete argv or typed fields, and an explicit `--` path boundary when supported. There is no user-string interpolation.
Use no shell fence, pipeline, operator, or host-variable expansion.
If the tool is missing, the target/cwd is ambiguous, or the result cannot be
authenticated, return to the root task before mutation.

A read-only artifact uses the native Read adapter and never becomes state authority; it may not infer or patch state. `artifact.wrap-receipt` is
regenerated in full and patching a prior receipt is forbidden.
`artifact.wrap-insights` publishes local classified insights, while
`transfer.export-feedback` publishes cross-plugin feedback; neither substitutes
for the other.

## Maintainer quarantine route

`runtime-op: coord.quarantine-malformed` is maintainer-only after a normal
reader reports exact malformed line digests. Payload fields are `session_id`,
allowlisted `file`, and exact `malformed` records. Require the durable audit,
source preimage, staged artifact identity, recovered/installed result, and rc.
Ordinary workflows never invoke it. A source change or ambiguous recovery
stops without guessed retry.

## Stable interaction adapters

Every caller passes the table's stable ID and one listed option without
renaming, translating, reordering, or default inference.

<!-- interaction-table:start -->
| Stable choice ID | Option IDs | Claude adapter | Codex adapter | Tool-unavailable fallback |
| --- | --- | --- | --- | --- |
| `active-session-action` | `resume`, `complete`, `abort` | `AskUserQuestion id=active-session-action` | `request_user_input id=active-session-action` | Ask a plain root-task question and stop before mutation. |
| `analysis-confirmation` | `confirm`, `revise`, `cancel` | `AskUserQuestion id=analysis-confirmation` | `request_user_input id=analysis-confirmation` | Ask a plain root-task question and stop before mutation. |
| `archive-cleanup` | `remove-owned`, `preserve`, `cancel` | `AskUserQuestion id=archive-cleanup` | `request_user_input id=archive-cleanup` | Ask a plain root-task question and stop before mutation. |
| `archive-prune` | `preview`, `prune-selected`, `cancel` | `AskUserQuestion id=archive-prune` | `request_user_input id=archive-prune` | Ask a plain root-task question and stop before mutation. |
| `branch-alignment-resolution` | `switch-expected`, `inspect-current`, `abort` | `AskUserQuestion id=branch-alignment-resolution` | `request_user_input id=branch-alignment-resolution` | Ask a plain root-task question and stop before mutation. |
| `completion-outcome` | `apply`, `create-pr`, `preserve-or-discard` | `AskUserQuestion id=completion-outcome` | `request_user_input id=completion-outcome` | Ask a plain root-task question and stop before mutation. |
| `completion-preserve-or-discard` | `preserve-branch`, `discard-branch`, `cancel` | `AskUserQuestion id=completion-preserve-or-discard` | `request_user_input id=completion-preserve-or-discard` | Ask a plain root-task question and stop before mutation. |
| `completion-reverse-handoff` | `emit`, `skip`, `cancel` | `AskUserQuestion id=completion-reverse-handoff` | `request_user_input id=completion-reverse-handoff` | Ask a plain root-task question and stop before mutation. |
| `contagion-action` | `quarantine`, `continue-isolated`, `stop` | `AskUserQuestion id=contagion-action` | `request_user_input id=contagion-action` | Ask a plain root-task question and stop before mutation. |
| `diminishing-returns-action` | `continue`, `expand-evaluator`, `finish` | `AskUserQuestion id=diminishing-returns-action` | `request_user_input id=diminishing-returns-action` | Ask a plain root-task question and stop before mutation. |
| `dirty-worktree-resolution` | `preserve-and-stop`, `stash-owned`, `cancel` | `AskUserQuestion id=dirty-worktree-resolution` | `request_user_input id=dirty-worktree-resolution` | Ask a plain root-task question and stop before mutation. |
| `evaluation-method` | `cli`, `protocol`, `cancel` | `AskUserQuestion id=evaluation-method` | `request_user_input id=evaluation-method` | Ask a plain root-task question and stop before mutation. |
| `experiment-count` | `confirm-count`, `change-count`, `cancel` | `AskUserQuestion id=experiment-count` | `request_user_input id=experiment-count` | Ask a plain root-task question and stop before mutation. |
| `finished-session-action` | `show-history`, `start-new`, `cancel` | `AskUserQuestion id=finished-session-action` | `request_user_input id=finished-session-action` | Ask a plain root-task question and stop before mutation. |
| `goal-selection` | `confirm-goal`, `revise-goal`, `cancel` | `AskUserQuestion id=goal-selection` | `request_user_input id=goal-selection` | Ask a plain root-task question and stop before mutation. |
| `harness-regeneration` | `regenerate`, `stop` | `AskUserQuestion id=harness-regeneration` | `request_user_input id=harness-regeneration` | Ask a plain root-task question and stop before mutation. |
| `harness-confirmation` | `approve`, `revise`, `cancel` | `AskUserQuestion id=harness-confirmation` | `request_user_input id=harness-confirmation` | Ask a plain root-task question and stop before mutation. |
| `head-mismatch-resolution` | `validate-descendant`, `return-recorded`, `abort` | `AskUserQuestion id=head-mismatch-resolution` | `request_user_input id=head-mismatch-resolution` | Ask a plain root-task question and stop before mutation. |
| `init-recovery` | `retry`, `resume-existing`, `stop` | `AskUserQuestion id=init-recovery` | `request_user_input id=init-recovery` | Ask a plain root-task question and stop before mutation. |
| `inner-resume-action` | `resume-block`, `restart-block`, `stop` | `AskUserQuestion id=inner-resume-action` | `request_user_input id=inner-resume-action` | Ask a plain root-task question and stop before mutation. |
| `legacy-layout-migration` | `migrate`, `stop` | `AskUserQuestion id=legacy-layout-migration` | `request_user_input id=legacy-layout-migration` | Ask a plain root-task question and stop before mutation. |
| `lineage-adoption` | `adopt`, `skip`, `inspect` | `AskUserQuestion id=lineage-adoption` | `request_user_input id=lineage-adoption` | Ask a plain root-task question and stop before mutation. |
| `n-confirmation` | `confirm-n`, `change-n`, `cancel` | `AskUserQuestion id=n-confirmation` | `request_user_input id=n-confirmation` | Ask a plain root-task question and stop before mutation. |
| `orphan-experiment-resolution` | `evaluate-orphan`, `discard-orphan`, `stop` | `AskUserQuestion id=orphan-experiment-resolution` | `request_user_input id=orphan-experiment-resolution` | Ask a plain root-task question and stop before mutation. |
| `outer-loop-trigger` | `run-outer`, `skip-outer`, `finish` | `AskUserQuestion id=outer-loop-trigger` | `request_user_input id=outer-loop-trigger` | Ask a plain root-task question and stop before mutation. |
| `paused-session-action` | `resume`, `inspect`, `abort` | `AskUserQuestion id=paused-session-action` | `request_user_input id=paused-session-action` | Ask a plain root-task question and stop before mutation. |
| `post-outer-action` | `continue-inner`, `complete`, `pause` | `AskUserQuestion id=post-outer-action` | `request_user_input id=post-outer-action` | Ask a plain root-task question and stop before mutation. |
| `program-update` | `apply`, `keep-current`, `stop` | `AskUserQuestion id=program-update` | `request_user_input id=program-update` | Ask a plain root-task question and stop before mutation. |
| `program-update-after-view` | `apply-viewed`, `revise`, `keep-current` | `AskUserQuestion id=program-update-after-view` | `request_user_input id=program-update-after-view` | Ask a plain root-task question and stop before mutation. |
| `review-change-action` | `apply-fixes`, `keep-current`, `stop` | `AskUserQuestion id=review-change-action` | `request_user_input id=review-change-action` | Ask a plain root-task question and stop before mutation. |
| `review-failure-merge` | `retry-review`, `preserve-branch`, `stop` | `AskUserQuestion id=review-failure-merge` | `request_user_input id=review-failure-merge` | Ask a plain root-task question and stop before mutation. |
| `review-failure-pr` | `update-pr`, `preserve-pr`, `stop` | `AskUserQuestion id=review-failure-pr` | `request_user_input id=review-failure-pr` | Ask a plain root-task question and stop before mutation. |
| `rollback-ancestor` | `rollback`, `keep-current`, `cancel` | `AskUserQuestion id=rollback-ancestor` | `request_user_input id=rollback-ancestor` | Ask a plain root-task question and stop before mutation. |
| `seed-kill-confirmation` | `confirm-kill`, `keep-seed`, `stop` | `AskUserQuestion id=seed-kill-confirmation` | `request_user_input id=seed-kill-confirmation` | Ask a plain root-task question and stop before mutation. |
| `seed-worktree-recovery` | `restore-tip`, `terminalize-seed`, `abort` | `AskUserQuestion id=seed-worktree-recovery` | `request_user_input id=seed-worktree-recovery` | Ask a plain root-task question and stop before mutation. |
| `session-route` | `resume-current`, `choose-session`, `start-new` | `AskUserQuestion id=session-route` | `request_user_input id=session-route` | Ask a plain root-task question and stop before mutation. |
| `synthesis-regression-action` | `keep-baseline`, `accept-regression`, `stop` | `AskUserQuestion id=synthesis-regression-action` | `request_user_input id=synthesis-regression-action` | Ask a plain root-task question and stop before mutation. |
| `target-file-selection` | `confirm-targets`, `revise-targets`, `cancel` | `AskUserQuestion id=target-file-selection` | `request_user_input id=target-file-selection` | Ask a plain root-task question and stop before mutation. |
| `transfer-adoption` | `adopt`, `skip`, `inspect` | `AskUserQuestion id=transfer-adoption` | `request_user_input id=transfer-adoption` | Ask a plain root-task question and stop before mutation. |
| `unexpected-head-recovery` | `preserve-and-reconcile`, `return-expected`, `stop` | `AskUserQuestion id=unexpected-head-recovery` | `request_user_input id=unexpected-head-recovery` | Ask a plain root-task question and stop before mutation. |
<!-- interaction-table:end -->

Codex parity is verified in `codex exec`. If its interactive tool is absent,
use the same ID/options in a plain root-task question and stop before mutation.
This degraded-but-safe fallback is the sole host behavior difference.

## Dispatch adapters

Every route passes literal project/session/worktree context.

- Claude names `deep-evolve:evolve-coordinator` or `deep-evolve:evolve-seed`.
- Codex dispatches a generic subagent; action one reads the matching checked-in
  agent policy and action two verifies the exact literal worktree.

Both execute the same policy. A route that cannot authenticate context returns
to the root task without mutation.
