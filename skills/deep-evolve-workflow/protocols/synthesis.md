# Synthesis Protocol (v3.5)

Synthesis authenticates terminal seed evidence, selects a deterministic
baseline, attempts bounded integration in an isolated worktree, and applies the
exact P7 fallback ladder. It never merges unauthenticated prose or defaults an
unknown interaction to mutation.

## Entry and final-state collection

Read canonical session, scheduler signals, typed experiment/block/result
evidence, seed branches/heads/Q/status, budget/synthesis policy, and current
authority digests. Require no open block and a terminal coordinator route.

Call `runtime-op: synthesis.collect` with authenticated seed reports, baseline
selection, and cross-seed audit inputs. Require returned reports sorted by
numeric seed ID plus exact baseline/audit objects. Prose cannot add a candidate.

Generate bounded epoch/forum evidence through
`runtime-op: synthesis.forum-summary`; require output path/markdown and preserve
warnings. Generate the canonical contamination/provenance review through
`runtime-op: synthesis.cross-seed-audit`; require exact output and stop or
exclude candidates for uncredited borrow, flagged propagation, target/seal
drift, missing commit provenance, or inconsistent baseline.

## Per-seed report adapters

host-route: claude

Dispatch named `deep-evolve:evolve-seed` with literal project/session/seed/
worktree/head context and a report-only allocation.

host-route: codex

Dispatch a generic subagent whose first action reads `agents/evolve-seed.md`
and second verifies the exact literal worktree before read or mutation. The
report-only contract is identical. Missing capability returns to root.

## Deterministic baseline and K/budget policy

Preserve the configured eligible tiers, quarantine rules, best-effort boundary,
K cap, integration budget, regression tolerance, and selection provenance.
Call `runtime-op: synthesis.select-baseline` with exact seed candidates. Require
chosen numeric seed ID, tier, ties-broken-on, candidate count, and reasoning.

Eligibility requires schema-valid terminal evidence, clean/authenticated branch
and full commit, evaluator/target/seal identity, finite Q, and audit acceptance.
Tie order is deterministic; array position and literal seed 1 are never identity.
No eligible baseline selects the explicit no-baseline route.

## Isolated integration

For N>=2 with an eligible baseline, authenticate its full commit and call
`runtime-op: worktree.create-synthesis` with session and baseline commit.
Require literal worktree, branch, and baseline identity. Collision, dirty path,
or mismatched existing branch stops.

host-route: claude

Dispatch `deep-evolve:evolve-coordinator` with synthesis worktree, baseline,
bounded candidate heads, allowed targets, K/budget, audit, and stop conditions.

host-route: codex

Dispatch a generic subagent whose first action reads
`agents/evolve-coordinator.md` and second verifies the exact synthesis worktree
before mutation. It receives the identical integration contract.

The integration may inspect only authenticated commits, modify only allowed
targets, preserve evaluator/program/strategy/state seals, stay within budget,
record source provenance for each change, and create one coherent candidate
commit. It never mutates a seed branch.

Evaluate through `runtime-op: harness.run`; require fixed harness identity,
finite score or the exact failure sentinel, target-only diff, clean worktree,
audit acceptance, full commit, and ancestry. Dirty/ambiguous failure retains a
checksummed recovery path before cleanup.

## Exact P7 finalization

Call `runtime-op: synthesis.finalize` with exactly N, baseline Q, synthesis Q,
nonnegative finite tolerance, and `user_choice` only when the prompt window
requires it.

Deterministic branches:

- N=0 → `skipped_zero_active`, no fallback mutation, `no-baseline` classification;
- N=1 → `skipped_n1`, selecting the sole eligible seed by identity;
- literal null baseline → `no_baseline`, `no-baseline` classification;
- exact synthesis-failure sentinel → baseline fallback with
  `automatic-fallback` classification;
- numeric synthesis at/above baseline → success;
- numeric synthesis below `baseline - tolerance` → `automatic-fallback`.

The prompt window is `baseline - tolerance <= synthesis < baseline`. Use the
stable choices `accept-regression`, `keep-baseline`, or `stop`:

- accept → `accepted_with_regression`, no fallback, matching choice ID;
- keep → `fallback_user_kept_baseline`, fallback true, matching choice ID;
- stop → rc 1 `synthesis_stopped`, no mutation/publication;
- missing choice → rc 1 `synthesis_choice_required`;
- a valid choice outside the prompt window → rc 2
  `synthesis_choice_not_applicable`;
- numeric/ordinal/label/translated/empty/unknown choice → rc 2.

No unknown, dismissed, or stale value defaults to acceptance or fallback
mutation. Result fields are exactly the runtime's branch-specific shape; no
commit or extra classification is invented.

## Fallback note and cleanup

When a non-selected synthesis needs explanation, call
`runtime-op: synthesis.write-fallback-note` with session, authenticated baseline
reasoning, exact synthesis/baseline Q shape, and one classification only:
`keep-baseline`, `automatic-fallback`, or `no-baseline`.

Require output path and deterministic markdown. Keep-baseline uses two finite Q
values; automatic fallback uses finite or failure-sentinel synthesis plus finite
baseline; no-baseline uses null/null. Any other shape is rc 2 and writes nothing.

Call `runtime-op: worktree.cleanup-failed-synthesis` only after final selection
and recovery readiness. Require cleaned/noop/orphan/resumed/failed-branch/
recovery-path result. Never delete dirty unrecoverable evidence, a selected
commit, a pre-existing branch, or a seed worktree.

## Provenance, event, and completion handoff

Authenticate the selected final branch/full commit, baseline/synthesis Q,
choice/classification, K/budget use, source commits, audit, fallback note, and
recovery result. Append one non-state synthesis provenance record through
`runtime-op: coord.append-journal`; typed session completion remains completion-owned.

Render one summary with per-seed journeys, Q trajectory, audit, selection
reasoning, integration sources, fallback, final Git identity, and warnings.
Enter completion without marking status or publishing a provisional receipt.
