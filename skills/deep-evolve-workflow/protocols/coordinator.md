# Coordinator Loop (v3.5)

The coordinator is the sole cross-seed scheduler and transaction owner. It
reconciles state, handles user kills, opens/closes blocks, advances epochs,
validates worktrees, and routes outer evolution/synthesis/completion. It never
performs seed experiment work.

Every `runtime-op:` call invokes the packaged Node dispatcher at
`hooks/scripts/deep-evolve-runtime.cjs` through the host-neutral runtime contract.

## Version and session gate

Read canonical session/digests and require v3.5 active or a reviewed recovery
state. Older tiers route to their single-seed protocol; unknown versions stop.
Authenticate project/session root, coordinator branch, every seed worktree,
budget, epoch, lifecycle, target/seal set, and five coordination digests.

Never call `runtime-op: virtual.set-field` for v3.5. It is forbidden
legacy-only compatibility and cannot write N, budget, status, Q, counters,
allocation, or seed fields.

## Reconciliation and signals

1. Call the read-only status operation for warnings and canonical dashboard.
2. Call `runtime-op: coord.tail-forum` with session/limit; consume only returned
   records and cursor after success.
3. Call `runtime-op: scheduler.signals` with session ID. Require seeds, Q trend,
   entropy, flagged rate, forum activity, pool, N/active/schedulable identities,
   zero-active marker, and all authority digests.
4. If the materialized projection drifts from valid event/result authority,
   stop dispatch and enter strict resume rebuild. Malformed bytes use only the
   maintainer quarantine route.

## User-kill lifecycle

`runtime-op: coord.queue-user-kill` records one user request intent by session
and numeric seed. It does not apply a kill.

At every turn call `runtime-op: coord.list-user-kill-requests` with session ID.
Require strictly validated pending/acknowledged arrays plus five authority
digests. No hidden/malformed line may be skipped.

For each pending request, obtain the stable confirm/keep/stop choice. Stop means
no request mutation. Otherwise call `runtime-op: coord.ack-user-kill-request`
with operation/request/choice IDs and exact session/journal/forum/queue/request
digests. Require request/seed/choice, optional kill ID, applied/queued flags,
replay, and journal digest. `keep-seed` records acknowledgement only;
`confirm-kill` queues exactly one stable user-origin kill or applies it if idle.

Scheduler retirement first calls `runtime-op: scheduler.kill-conditions` with
authenticated seed/session/AI judgments and nullable user request. Only a
returned killable condition may call `runtime-op: coord.queue-kill` with
runtime-derived Q/counters. Queue entries are intent/preconditions, not state.

Call `runtime-op: coord.drain-kill-queue` with session/operation ID and exact
session/journal/queue/request digests. It derives in-flight state and applies all
eligible idle rows once. It owns the typed terminal transition, shared reducer,
allocation reclamation, active-count shape, queue consumption, and replay. The
v3.5 payload is the strict six-field authority form and excludes a caller-supplied
completed seed ID.

## Scheduler decision and growth

Call `runtime-op: scheduler.borrow-abandoned` with authenticated events,
current block ID, and staleness; preserve returned abandoned identities as
non-terminal evidence.

Call `runtime-op: scheduler.decide` with one complete decision proposal and the
current signals. Require accepted decision, chosen seed/block size or typed
growth/kill fields, reasoning, signals used, fairness/starvation result, and
journal projections. rc 1 starts a fresh reconciled turn; rc 2 stops.

For growth, call `runtime-op: metrics.grow-allocation` with canonical pool and
N. Require allocation and preserve the minimum-three formula. Generate a typed
direction, create a seed worktree/program, and let outer-loop's CAS append own
canonical state. Failure removes only uncommitted owned worktrees.

## Begin one seed block

Before dispatch call `runtime-op: coord.begin-seed-block` with session,
operation/decision/seed IDs, block size, full pre-dispatch HEAD, expected epoch,
budget preimage, and exact session/journal digests. Require block ID, seed,
epoch, HEAD, size, budget preimage, session/journal digests, and replay.

The runtime authenticates actual worktree/branch/full HEAD, active seed, budget,
epoch, one in-flight block, and deterministic block identity, then owns the
schedule transition. A stale HEAD, terminal seed, insufficient budget,
concurrent open block, or replay conflict stops dispatch.

Build the host-neutral context through `runtime-op: coord.build-seed-prompt`
using session, seed, block, decision, and block experiment count. Require schema,
policy ref, literal roots/worktree/branch, block object, first actions, allowed
operations, and final response schema. No executable prose or caller-supplied
path is accepted.

Write the complete beta-bound program through
`runtime-op: coord.write-seed-program`; require output path, bytes, and applied
beta before dispatch.

## Dispatch adapters

host-route: claude

Dispatch `deep-evolve:evolve-coordinator` for coordinator continuation and
named `deep-evolve:evolve-seed` for the open block, passing literal typed context.

host-route: codex

Dispatch a generic subagent. Its first action reads the matching agent policy;
its second verifies the exact literal worktree before mutation. The block,
budget, operation allowlist, and final schema are identical to Claude.

Missing/ambiguous host capability returns to the root task with the open block
unresolved. It does not become a completed block or consume unproven budget.

## Finish the exact block

After return, authenticate the literal worktree, expected branch, returned full
HEAD, descendant relation, target-only diff, protected seals, typed experiment
terminals/results, forum identities, and borrow evidence.

Call `runtime-op: coord.finish-seed-block` with session/operation/block/seed,
completed-or-failed status, returned HEAD, exact summary, and all required
session/journal/forum/queue/request digests. Summary fields are experiment count,
ordered commits, final Q, forum count, planned/executed borrow counts.

The runtime derives all identities/counts/Q components, writes one block
terminal, invokes the shared projection and eligible-kill reducer, and returns
digests/projection/replay. Forged summary, missing/extra terminal, ancestry
drift, post-kill evidence, or partial authority fails closed.

If dispatch response is lost, re-read the operation receipt and authenticate
the block plus returned HEAD before retrying the same operation ID. If no typed
terminal exists, keep the block open and use the stable block-resume choice;
never synthesize a failed terminal from agent absence. Rollback may return only
to the recorded pre-dispatch full HEAD after proving target-only ownership, and
preserves any divergent/unowned tip for explicit recovery.

## Advance one evaluation epoch

At a boundary call `runtime-op: coord.advance-epoch` with session/operation ID,
expected epoch, exact gap-free ordered completed block IDs, allowed reason, and
session/journal/result digests. Require outer route, from/to epoch, generation,
recomputed Q/components, session/journal digests, and replay.

The operation rejects unresolved blocks or lifecycle drift and atomically owns
paused lifecycle, generation/Q history, epoch history, both boundary events,
per-epoch seed-counter reset, and shared projection. Route to outer loop only
after this exact response.

## Termination and error handling

Termination is replay-stable: zero active seeds, exhausted pool/allocations,
configured epoch/wall cap, goal attainment, or explicit terminal choice. Absent
caps are inactive. Zero schedulable seeds always routes to synthesis.

rc 1 follows only its typed business branch. rc 2, malformed output, missing
field, unauthenticated path, fairness contradiction, or unknown state stops.
Synthesis/completion receive canonical responses, never coordinator prose.
