# Outer Loop — Strategy Evolution

The outer loop evolves experiment strategy, program instructions, and—only at
Tier 3—the fixed evaluator. It starts from one coordinator-owned completed epoch
boundary and is idempotent by typed event plus authority digest.

Every `runtime-op:` call invokes the packaged Node dispatcher at
`hooks/scripts/deep-evolve-runtime.cjs` through the host-neutral runtime contract.

## Resume safety and checkpoint map

Read the exact session, journal, result, strategy, program, evaluator/config,
forum, seed worktrees, and Git identity. Bind a checkpoint map containing every
digest and current generation/evaluation epoch. A substep may replay/skip only
when its completion evidence and expected post-digests match. A marker with
different bytes, a missing parent, or a partially applied generation stops.

Status remains paused during outer evolution. The three freedoms stay ordered:

1. Tier 1 changes strategy parameters/weights within schema.
2. Tier 2 replaces complete `program.md` instructions after explicit policy.
3. Tier 3 replaces complete evaluator/config between experiments and rebaselines.

Protected evaluator, program, strategy, target, seal, and historical result
bytes are never edited by an unowned step.

## Epoch boundary and forum summary

For v3.5, require the coordinator's returned gap-free epoch transition: from/to
epochs, generation, completed block IDs, Q, components, session/journal digests,
and replay. No active block may remain. Older tiers use their explicit
versioned boundary and never impersonate the v3.5 transaction.

Produce bounded forum/audit summaries through synthesis read operations. Empty
evidence is explicit. Malformed authoritative rows block mutation; they are not
filtered into a convenient summary.

## Convergence, contagion, and credit

Call `runtime-op: scheduler.classify-convergence` with this-epoch keeps,
pairwise similarities, inspired-by map, cross-seed borrow events, configured
threshold/floor, and epoch. Require exact convergence events.

Classify evidence as independent corroboration, borrow-chain convergence, or
contagion suspected. Credit is +2, +1, or 0 respectively. Apply credit only to
the current epoch's stagnation offset; cumulative contagion remains a separate
warning. A suspicious cluster uses the stable contagion choice to quarantine,
continue isolated, or stop. Never copy a flagged/uncorroborated idea across
seeds.

## Q(v) meta-metric and history

Compute Q only from authenticated typed experiment/block evidence with the
runtime's exact components:

`0.35 * keep_rate + 0.30 * normalized_delta + 0.20 * (1 - crash_rate) + 0.15 * idea_diversity`.

Zero maximum delta yields normalized delta zero. Diversity is mean pairwise
Jaccard distance over normalized word sets. Preserve finite Q, component map,
generation, epoch, completed block IDs, score/keep/crash windows, and prior Q
history. A caller-provided Q never overrides recomputation.

Call `runtime-op: metrics.entropy` with authenticated category events and
window size. Preserve `entropy_bits`, `active_categories`, `sample_size`, and
reason. Low sample size is not collapse. Entropy informs strategy, not score.

## Tier 1 — strategy parameters

Analyze per-category keep rate, Q components, score velocity, failures,
diagnose/legibility/shortcut signals, borrow credit, and entropy. Propose one
complete schema-valid strategy update with normalized ten-token weights,
bounded mutation size, focus/avoid lists, idea bank, retry/shortcut thresholds,
and rationale. Preserve the old strategy until the complete replacement and
its archive identity are authenticated.

Save a stepping stone through `runtime-op: archive.save-strategy` when Q reaches
a new best or policy requests an archive. Strategy discard restores the exact
prior version and records no duplicate archive/event.

## Tier 2 — program revision

Trigger only for convergence, repeated mechanism failure, low legibility, or
explicit meta-analysis. Present the complete proposed program plus diff/rationale
through stable program-update choices. Apply a full versioned replacement, not
fragments. Keep goal, targets, evaluator contract, safety constraints, block
response schema, and rollback rules. A viewed revision may be revised once or
rejected without changing current bytes.

## Notable keeps, stagnation, and Tier 3

Mark improvements that are large, simplifying, independently reproduced,
mechanistically novel, or resolve a known failure class. Preserve full commit,
score/LOC delta, category, seed, epoch, mechanism, and evidence. Notable status
does not change the keep decision.

Detect stagnation from the authenticated Q history and no-improvement window.
Apply only this-epoch convergence credit and never erase the raw streak. Tier 3
requires the configured threshold plus flagged/coverage evidence or explicit
consent; it cannot run during an experiment.

At the configured plateau, a strategy fork selects an authenticated same-epoch
archive parent, increments that parent's child count once, restores its complete
strategy/program pair, records source generation/commit, and resets only the
documented diminishing-return exploration counters. It never resets experiment,
budget, Q-history, lifetime shortcut, or lineage authority. A post-fork plateau
uses the configured additional window before Tier 3; an empty archive continues
without inventing a parent.

Generate a complete new evaluator/config, exercise a raw baseline and repeat,
then call `runtime-op: session.record-evaluator-expansion` with operation ID,
session/journal preimages, exact harness identity, reason, and trigger generation.
Require returned session/digests/version/replay. This typed owner alone activates
the evaluator identity, resets Tier-3/entropy counters, and records expansion.
Failure retains the old evaluator and baseline.

## Adaptive N and growth

At the completed boundary, use scheduler signals and current canonical pool.
Zero-active routes to synthesis. Growth requires policy evidence, a distinct
direction, sufficient pool, and scheduler acceptance. Obtain allocation from
the coordinator-owned growth calculation and create/authenticate the worktree
and seed program before state mutation.

Call `runtime-op: virtual.append-seed` with fresh operation ID, exact
session/journal digests, absent numeric seed ID, authenticated worktree/branch,
typed beta, and `creation_kind: growth`. The runtime derives
`max(ceil(budget_unallocated / (2*n_current)), 3)`, returns a typed
insufficient-pool error when required,
owns the initialization transition, and returns seed/active/pool digests/replay.

Do not reset an existing seed or append a second generic initialization event.

Forking direction uses archive strategy evidence and lineage rules; it never
copies mutable canonical state or grants one seed access to another worktree.

## Final judgment and route

Preserve Q/history, chosen tier, old/new strategy/program/evaluator identities,
notable keeps, contagion/credit, budget/N decision, and warnings. Resume active
only after every selected substep and digest validates. Then continue inner
work, complete, pause, or route zero-active state to synthesis according to the
stable post-outer choice and policy. Any contradiction leaves paused state and
returns to explicit recovery.
