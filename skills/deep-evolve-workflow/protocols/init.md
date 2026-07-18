# Init Flow (Section A)

Initialization creates one complete canonical session, fixed evaluator, baseline,
and deterministic seed allocation before target mutation. State changes use the
runtime contract; project analysis uses authenticated read-only host tools.

## A.1 Project deep analysis

Perform the original five-stage analysis against a literal project root:

1. **Structure:** tracked/relevant untracked source, manifests, extensionless
   build files, entry points, generated/ignored boundaries, and project scale.
2. **Dependencies/tooling:** build, test, lint, CI, configured tools, and whether
   evaluation is structured CLI or fixed multi-tool protocol.
3. **Deep read:** fully read candidate targets plus constraining interfaces and
   tests; map data flow, safety contracts, target/seal boundaries, and bias.
4. **Recurring evidence:** authenticate any review envelope as read-only evidence;
   use its categories to bias scenarios/strategy but never session authority.
5. **Metric validation:** exercise the proposed evaluator safely, record
   direction, timeout, failure classes, determinism, and baseline interpretation.

Confirm goal, targets, evaluation method, metric/direction, finite budget, and
duration before creating state. Cancellation or unavailable interaction stops.

## A.1.6 Virtual-parallel analysis

For v3.5, validate `project_type` as `narrow_tuning`,
`standard_optimization`, or `open_research`, and
`eval_parallelizability` as `serialized` or `parallel_capable`. Validate N as
integer 1..9 (a boolean is invalid), diversity directions, reasoning, and user
bounds. Older versions retain their explicit compatibility behavior.

Determine a provisional split with `runtime-op: metrics.init-budget-split`
using integer total and N. Require one allocation per seed, every allocation at
least three, and exact total conservation. The typed seed operation below owns
the canonical allocation; this result is planning evidence and a cross-check.

## A.2 Goal, configuration, N, and transfer

- Bind explicit or confirmed goal, unique normalized project-relative targets,
  evaluation mode, metric name/direction, outer interval/automatic trigger,
  total budget, and optional parent.
- Apply `--no-parallel` and valid 1..9 min/max bounds before N confirmation.
- Call `runtime-op: transfer.lookup` for bounded candidates; consented transfer
  becomes the exact initial transfer spec and never silently overrides analysis.
- For compatible old weights, use `runtime-op: metrics.migrate-v2-weights`.

Protected evaluator, config, `program.md`, strategy, target allowlist, lineage,
and transfer source are sealed by the initial specification or their later typed
owner. Ordinary project analysis cannot write them.

## A.3 Atomic session start

First call `runtime-op: session.resolve-current`; do not replace an active
session. Build the exact P1 `initial_state`:

- schema `1.0`, stable initialization ID, ordered unique target files;
- evaluation mode plus empty tools for CLI or a non-empty unique protocol tool set;
- total budget and metric `{name,direction}`;
- outer `{interval,auto_trigger}`;
- virtual `{n_chosen,project_type,eval_parallelizability,selection_reason}`;
- nullable validated transfer adoption.

Call `runtime-op: session.start` exactly once with `goal`, optional
`parent_session_id`, and complete `initial_state`. The runtime stamps session ID,
version, initializing status, timestamps, branch/lineage, parent identity,
experiments/program/outer/evaluation/shortcut/diagnose/legibility/entropy
defaults, metric shell, empty seeds, zero-active sentinel, and the full
unallocated pool. Require returned session/root/digest/initialization ID/replay.

Validate the returned namespace as a unit before creating worktrees: canonical
session schema and immutable lineage fields, empty strict journal/forum/kill
queues, the versioned `results.tsv` header, zero experiment/Q history, no
baseline, and a registry/current pointer that name the same physical session.
The generated evaluator config, complete program, and strategy each receive an
authenticated digest; target/seal inventory records path plus bytes, not merely
a display name. A missing/extra coordination file or mismatched schema is an
incomplete start, never a prompt to manufacture that file from protocol text.

An exact retry may replay. A different initialization under the same identity,
partial namespace, target escape/symlink, invalid cross-field, or exposed pointer
without complete canonical state stops and preserves evidence.

If a parent exists, call `runtime-op: session.render-inherited-context` for a
bounded policy section. It is context only; the start response remains authority.

Never call `runtime-op: virtual.init` for v3.5; it is forbidden legacy-only
compatibility and cannot replace atomic `session.start.initial_state`.

## A.3.4 Fixed evaluator and policy files

Call `runtime-op: harness.generate` with complete structured specification.
CLI mode yields `prepare.cjs` plus validated config; protocol mode yields the
fixed tool contract. Require kind, contained paths, and identities. Generate
complete `program.md` and strategy only from confirmed analysis, preserve
target/evaluator/program/strategy separation, and never patch evaluator source.

For multi-seed direction synthesis, call `runtime-op: synthesis.process-beta`
with mode, N, project analysis, existing seeds, and typed input. Require one
diverse direction per multi-seed ID; N=1 accepts only the documented skipped
result. Retries are bounded and warnings remain visible.

## A.3.6 Seed creation and budget conservation

For numeric seed IDs 1..N in order:

1. Call `runtime-op: worktree.create-seed` with session, seed, and authenticated
   full base commit. Require literal worktree, branch, and HEAD.
2. Persist the complete assigned program through
   `runtime-op: coord.write-seed-program`; require path, bytes, and beta applied.
3. Re-read session/journal digests and call
   `runtime-op: virtual.append-seed` with operation ID, both preimages, seed ID,
   returned path/branch, exact beta, and `creation_kind: initial`.
4. Require seed, active count, remaining budget, session/journal digests, and
   replay. The runtime alone writes the complete seed-initialized transition and
   shared projection.

Initial allocation is quotient/remainder: base is floor(total/N), highest
remainder seed IDs receive one extra, and total allocated plus unallocated must
equal total after every append. Existing seed, reset, replacement, generic
second writer, or non-CAS append is forbidden. A partial attempt removes only
new worktrees after proving no canonical seed was committed; otherwise resume
from typed replay.

Each returned seed preserves numeric ID, active status, exact allocation,
worktree/branch, beta/direction, zero experiment/Q/borrow counters, and creation
kind. Journal initialization is emitted once by the typed append and precedes
all seed scheduling or experiment evidence; callers never add a second
`seed_initialized` record.

## Baseline measurement and activation

1. Confirm the evaluator summary, then call `runtime-op: harness.run` with
   session and typed options. Require finite exit/result fields and fixed
   evaluator identity. Protocol mode follows its fixed steps.
2. For minimize mode, persist raw baseline through
   `runtime-op: harness.write-baseline`, re-run, and require the normalized
   baseline contract. Other directions retain their typed normalization.
3. Re-read exact session/journal preimages and call
   `runtime-op: session.record-baseline` with operation ID, raw/normalized score,
   and harness identity. This operation alone owns baseline/current/best,
   activation, evaluator identity, and its typed event.
4. Require returned active session, session/journal digests, and replay. A
   second different baseline, evaluator drift, stale preimage, non-finite score,
   or partial activation stops.

Initialization is complete only when state validates: evaluator/program/strategy
seals match; baseline/current/best coexist; N worktrees and seeds match; budget
conserves; active-count representation matches statuses; and no target mutation
preceded activation.

## Route

- active v3.5 multi-seed → coordinator;
- active older/single seed → inner loop;
- incomplete initialization → explicit init recovery;
- unknown version or invariant mismatch → stop.
