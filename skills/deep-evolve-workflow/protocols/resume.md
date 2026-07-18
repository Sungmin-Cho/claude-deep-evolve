# Resume Protocol

Resume authenticates session bytes, coordination order, result authority,
worktrees, branches, commits, evaluator/program/strategy seals, counters, and
materialized projection before re-entering any mutation loop.

## Load and legacy routing

Resolve the intended session and call `runtime-op: session.read` with its literal
ID. Bind returned session/root/digest and reject unknown lifecycle/version.

For an old flat layout, explicit consent may call
`runtime-op: session.migrate-legacy`; require returned session/root/status and
resolve/read again. Migration never overwrites a strict session or guesses a
future schema.

Before CLI evaluation call `runtime-op: harness.migrate-legacy`. Require either
the direct Node evaluator identity, an exact completed migration, or typed
`legacy_harness_requires_regeneration`. The latter requires stable regeneration
consent and stops before generation/evaluation until received.

For old taxonomy weights call `runtime-op: metrics.migrate-v2-weights`; preserve
the returned pre-normalization sum and exact ten-token result. No ad-hoc mapping
or in-place archive rewrite is allowed.

## Integrity checks

### Branch and dirty worktree

Call `runtime-op: session.check-alignment` with session ID. Require aligned or
exact expected/actual identities. A mismatch uses explicit branch alignment or
unexpected-HEAD recovery; no automatic switch/reset occurs.

Inspect authenticated worktree status through structured Git. Preserve user or
unowned changes and stop. Only a proven plugin-owned incomplete operation may
enter its typed recovery/replay path.

### Orphan experiment

Call `runtime-op: session.detect-orphan` with session ID. A returned commit and
experiment ID must match the assigned branch, planned event, target-only diff,
and full ancestry. Explicit orphan choice evaluates it, returns exactly to the
recorded pre-commit, or stops. Never drop an unrelated commit.

### Event/result/counter order

Validate every JSONL record and every result row before deriving state. Require:

- one initialization per seed before any seed-dependent event;
- planned/commit/evaluation/typed terminal order per experiment;
- one result row per terminal experiment and no duplicate ID;
- schedule before block terminal, no overlapping block per seed;
- kill/epoch/completion after their exact parents only;
- experiment totals/status counts, block summaries, Q/borrow counters, budget,
  active-count shape, generation/epoch history, and journal/result digests agree;
- protected evaluator/program/strategy/target/lineage seals and Git identities.

Malformed, duplicate, out-of-order, unknown protected, post-terminal, forged Q,
or mismatched result authority stops without write.

## v3.5 strict virtual projection rebuild

For each canonical seed call `runtime-op: worktree.validate-seed` with session,
numeric seed, and recorded pre-dispatch HEAD when applicable. Require literal
path/branch/full HEAD and cleanliness; mismatch follows explicit recovery.

Re-read exact session, journal, and results digests. Call
`runtime-op: virtual.rebuild-seeds` with session/operation ID plus
`expected_session_sha256`, `expected_journal_sha256`, and
`expected_results_sha256`.

The runtime strictly parses the same event/result prefix used by typed writers
and calls the identical pure reducer. Require session, session digest,
projection digest, changed flag, and replay. A recognized stale materialization
may replace only seeds, optional positive N or zero-active sentinel, and
unallocated budget under CAS. A current projection stays byte-identical except
its operation receipt.

Mismatch in immutable virtual metadata, seed identity/order, initialization,
experiment/result pairing, block/Q/borrow summary, kill reclamation, epoch
reset, budget conservation, post-terminal event, or unrelated session field is
`virtual_projection_conflict` and preserves every authority byte. The obsolete
one-field rebuild payload is legacy-only and never used for v3.5.

## Resume summary and routes

Display session/goal/version/lifecycle; branch/head/clean state; baseline/current/
best; experiment/generation/epoch counts; seed status/allocation/Q/borrows;
pending/open/orphan evidence; projection changed/replayed; evaluator identity;
warnings and next safe route.

- active v3.5 with seeds → coordinator;
- active older/single seed → inner loop;
- paused with a complete epoch boundary → outer loop at its first missing step;
- initializing → init recovery and typed baseline;
- zero active → synthesis;
- terminal → history or explicit new lineage.

Any unresolved mismatch, ambiguous path, or malformed authority keeps mutation
stopped. Resume never silently repairs or skips evidence.
