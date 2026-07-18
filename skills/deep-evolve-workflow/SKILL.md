---
name: deep-evolve-workflow
version: "3.5.0"
description: |
  Host-neutral workflow policy for bounded measured code-improvement experiments.
  The public entry is /deep-evolve in Claude Code and $deep-evolve:deep-evolve in Codex.
---

# Deep Evolve: Autonomous Experimentation Protocol

Improve a project through bounded experiments while preserving one fixed score
authority per evaluation epoch. Read `protocols/runtime-contract.md` first.

## Workflow

Entry → analysis/atomic init → fixed evaluator/baseline → inner experiments and
outer strategy evolution → optional cross-seed synthesis → immutable completion.

## Routing table

| Trigger | Protocol | Responsibility |
|---|---|---|
| new/initializing | `protocols/init.md` | analysis, atomic state, evaluator, baseline, seeds |
| active multi-seed | `protocols/coordinator.md` | scheduler, kill, block/epoch transactions |
| assigned/single seed | `protocols/inner-loop.md` | one-idea experiments, typed terminals |
| paused/epoch boundary | `protocols/outer-loop.md` | Q, entropy, strategy/program/evaluator evolution |
| resume | `protocols/resume.md` | migration, alignment, orphan, strict rebuild |
| termination | `protocols/synthesis.md` | audit, baseline, integration, P7 fallback |
| finalization | `protocols/completion.md` | D0 publication, D1 completion, archive/cleanup |
| history/status | `protocols/history.md` | read-only list/detail/lineage/export |
| stepping stone | `protocols/archive.md` | backtrack, save, restore, fork |
| shared knowledge | `protocols/transfer.md` | lookup, record, feedback, soft prune |
| categories/insights | `protocols/taxonomy.md` | ten tokens, migration, local insights |

## State and ownership invariants

1. Atomic initialization owns immutable session metadata and the full budget.
2. Typed operations own baseline, experiment, user-kill, block, epoch, and
   completion transitions; generic append is never a second writer.
3. The shared reducer alone derives seed counters, Q, borrow counts, allocation,
   reclaimed budget, and positive/zero active-count representation.
4. Every mutation uses operation ID, exact preimages, literal paths, and replay.
5. Protected evaluator/program/strategy/seal changes occur only at their meta gate.
6. One experiment is one coherent candidate commit and one typed terminal.
7. Resume validates bytes, Git identity, journal/result order, and projections.
8. Missing interaction capability asks the root and stops before mutation.
9. Claude named agents and Codex generic subagents execute the same policy.

## Stable interaction inventory

The options and adapters live only in `protocols/runtime-contract.md`. Active
callers use these exact references:

- `interaction-id: active-session-action`, `interaction-id: analysis-confirmation`
- `interaction-id: archive-cleanup`, `interaction-id: archive-prune`
- `interaction-id: branch-alignment-resolution`, `interaction-id: completion-outcome`
- `interaction-id: completion-preserve-or-discard`, `interaction-id: completion-reverse-handoff`
- `interaction-id: contagion-action`, `interaction-id: diminishing-returns-action`
- `interaction-id: dirty-worktree-resolution`, `interaction-id: evaluation-method`
- `interaction-id: experiment-count`, `interaction-id: finished-session-action`
- `interaction-id: goal-selection`, `interaction-id: harness-regeneration`
- `interaction-id: harness-confirmation`, `interaction-id: head-mismatch-resolution`
- `interaction-id: init-recovery`, `interaction-id: inner-resume-action`
- `interaction-id: legacy-layout-migration`, `interaction-id: lineage-adoption`
- `interaction-id: n-confirmation`, `interaction-id: orphan-experiment-resolution`
- `interaction-id: outer-loop-trigger`, `interaction-id: paused-session-action`
- `interaction-id: post-outer-action`, `interaction-id: program-update`
- `interaction-id: program-update-after-view`, `interaction-id: review-change-action`
- `interaction-id: review-failure-merge`, `interaction-id: review-failure-pr`
- `interaction-id: rollback-ancestor`, `interaction-id: seed-kill-confirmation`
- `interaction-id: seed-worktree-recovery`, `interaction-id: session-route`
- `interaction-id: synthesis-regression-action`, `interaction-id: target-file-selection`
- `interaction-id: transfer-adoption`, `interaction-id: unexpected-head-recovery`

## Evaluation domains

CLI mode accepts a structured evaluator whose typed output maps to one score.
Protocol mode accepts a fixed already-configured tool sequence. The plugin adds
no MCP server, package dependency, or host-specific state path.
