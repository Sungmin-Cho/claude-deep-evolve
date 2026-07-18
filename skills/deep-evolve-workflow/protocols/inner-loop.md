# Inner Loop — Experiment Cycle

The inner loop changes one bounded idea at a time, evaluates it against the
fixed contract, and accepts only measured improvement or policy-proven
score-equivalent simplification. It runs in one authenticated seed worktree.

Every `runtime-op:` call invokes the packaged Node dispatcher at
`hooks/scripts/deep-evolve-runtime.cjs` through the host-neutral runtime contract.

## Section B: resume flow

Read the canonical session, last typed events, assigned block, result rows,
target/seal set, metric, counters, and exact Git identities. Reconcile:

- planned without commit: resume or close the plan without claiming a result;
- commit without evaluation: route through orphan choice and evaluate or return
  to the authenticated pre-commit;
- evaluation without typed terminal: call the typed terminal operation once;
- duplicate/mismatched terminal/result row: stop as corruption;
- expected ancestor mismatch: use explicit rollback choice;
- unrelated/ambiguous HEAD or dirty user bytes: preserve and return to root.

Never call `runtime-op: session.patch` for experiment, metric, seed, counter,
status, Q, or evaluator changes in v3.5; it is transfer-only during initializing
recovery and cannot be a second transition writer.

## Section C: one experiment

### 1. Select and plan

Read the assigned `program.md`, strategy, target allowlist, prior result/event
history, category taxonomy, and bounded forum evidence. Select one mechanism,
one exact category, expected score effect, targets, rollback preimage, and block
identity. Do not repeat an exhausted idea without new evidence.

Use `runtime-op: metrics.retry-budget` over authenticated events and the fixed
cap before any diagnose retry. The returned used/remaining/cap is the only retry
budget. Retry the same idea only for recognized infrastructure/error classes;
never tune against evaluator output.

The diagnose gate is limited to a crash, configured severe drop, or configured
error marker. It permits at most one retry for the experiment and never exceeds
the session cap. Preserve original commit A, its exact pre-commit, replacement
commit B, and one experiment ID. Resume distinguishes A still present, the
pre-commit after rollback, B committed, and an unrelated HEAD; only the first
three enter their matching retry substep. Terminal `diagnose_outcome` is exactly
`recovered`, `failed`, or `gave_up`; a retry does not increment the experiment
count separately.

Use `runtime-op: coord.append-journal` only for non-protected planning,
diagnostic, borrow-intent, and strategy-observation records. It must never
substitute for a typed state-coupled transition.

### 2. Modify and commit

Authenticate exact branch, HEAD, clean status, target set, and protected
evaluator/program/strategy/state seals. Use native structured read/edit/Git
actions only in the assigned worktree. One experiment is one coherent change
and one candidate commit. Record full pre/post IDs; an ambiguous commit stops.

### 3. Evaluate

Call `runtime-op: harness.run` with session and validated options. Require the
fixed harness identity, finite typed score, exit/signal/timeout fields, and no
protected-byte drift. A crash is evidence, not permission to alter the harness.

For each recognized retry, preserve the original idea/commit lineage and append
one non-terminal diagnostic record. Exceeding the cap terminalizes the same
experiment as an infrastructure failure; it does not mint a new idea.

### 4. Judge, rollback, and typed terminal

Higher normalized score is better. A score keep must exceed canonical current
score by the configured minimum delta. A score-equivalent keep is allowed only
for a separately configured, materially smaller and legible simplification;
otherwise it is a discard. Regression/failed evaluation returns exactly to the
authenticated pre-commit before the typed terminal call. Unrelated dirty bytes,
an extra commit, or ancestry drift stops before rollback.

On a prospective keep, set `flagged` exactly when score delta meets the
shortcut auto-flag threshold while target-only LOC delta is at or below its
minimum-LOC threshold. The legibility gate is medium for an ordinary keep and
hard for a flagged keep. Medium missing/description-identical rationale records
the configured warning after one retry; hard failure after one retry becomes a
flagged discard, while retaining the suspicious counters. Rationale respects
the configured length cap. The typed experiment object carries the final
flagged/rationale/LOC decision on first write—no later amendment.

Re-read session, journal, forum, and result preimages. Call
`runtime-op: session.finish-experiment` once with session/operation/digests,
seed ID, and exact experiment object: ID, category, description, rationale,
pre/full commit, terminal status, raw/normalized score, delta, LOC delta,
flagged bit, and optional diagnose outcome.

Terminal status is exactly `kept`, `discarded`, or `failed`. A crash uses
`failed`; policy regression, diagnosed give-up, and hard legibility rejection
use `discarded`. The final HEAD is the experiment commit only for `kept` and the
authenticated pre-commit otherwise.

The operation alone verifies branch/HEAD/ancestry and owns the terminal state,
one result row, journal/forum projections, metric/best, experiment/seed counters,
shortcut/diagnose/legibility state, digests, and replay. Duplicate ID, forged
score/taxonomy/commit, stale preimage, terminal-after-kill, or inconsistent row
stops with preimage preservation.

Use `runtime-op: coord.append-forum` only for non-terminal shared hypotheses,
citations, and borrow observations. Typed experiment publication is not
duplicated by a generic forum request.

### 5. Borrowing and notable evidence

Tail bounded forum evidence and call `runtime-op: scheduler.borrow-preflight`
with self seed/use count plus authenticated candidates/journal/forum. Only rows
in `eligible` may become a later adaptation; `skipped` rows remain excluded.
Track planned/executed borrow identity, progenitor credit, contamination risk,
and whether the adaptation survived a later typed terminal.

The first phase records only an eligible `borrow_planned` identity. Execution
is credited only when the later adapted experiment reaches its typed terminal
and matches the source commit/seed; abandoned plans are coordinator-classified.
Seed `borrows_given`/`borrows_received` counters are reducer output at block
finish, never incremented by the planning or forum caller.

Call `runtime-op: metrics.count-flagged` over authenticated events to obtain
count and last reset. This is evaluator-expansion pressure, not edit authority.
Mark notable improvements with mechanism, category, commit, score/LOC delta,
and independent corroboration so outer/synthesis can distinguish convergence
from contagion.

After each terminal, preserve an after-action record of hypothesis, observed
mechanism, failure class, rollback result, and next exclusion/adaptation. It is
learning evidence only and cannot change score, terminal status, or counters.

## Boundaries and diminishing returns

Stop at assigned block size, goal attainment, budget exhaustion, explicit
completion, safety failure, or outer interval. Never silently increase budget.
At an outer boundary, the coordinator closes the block and owns epoch advance.
Single-seed compatibility pauses only through its versioned lifecycle owner.

No-improvement streak uses the stable diminishing-returns choice: continue with
a bounded explicit allocation, enter evaluator expansion, or finish. After a
completed outer cycle, the post-outer choice controls continue/complete/pause.

When the configured cumulative shortcut threshold is reached, record one
non-terminal escalation observation and force Section D at the next safe
between-experiment boundary. Do not reset any flagged counter there; only the
successful typed evaluator-expansion transition owns the Tier-3 reset.

## Section D: evaluator expansion

Evaluator expansion occurs only between experiments after stable consent or a
typed Tier-3 trigger. Preserve metric direction and target/evaluator separation:

1. Read fixed evaluator/config identity and accumulated flagged/coverage gaps.
2. Generate a complete replacement through the harness generator operation;
   never patch executable evaluator bytes.
3. Run a fresh baseline and deterministic repeat under the same score semantics.
4. Hand exact old/new harness identity, reason, and generation to the outer-loop
   typed evaluator-expansion transition.

The prior evaluator remains active until the outer transition succeeds. Failure
preserves it, its baseline, program/strategy seals, and all earlier result rows.
