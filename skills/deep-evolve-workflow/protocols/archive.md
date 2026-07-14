# Archive Management — Code and Strategy Stepping Stones

Archive operations preserve recoverable code/strategy states. Every mutation is
dispatcher-owned; callers identify an archive by authenticated ID, never display
order. Backtracking changes no unrelated branch and never deletes its source.

## Code archive backtrack

1. Read canonical session evidence and the bounded candidate inventory.
2. Call `runtime-op: archive.backtrack` with `session_id`, authenticated
   `candidates`, `strategy`, `fork_number`, `reason`, and `program_context`.
3. Require `selected`, `branch`, `previous_branch`, full `commit`, and
   `metadata_path`. Authenticate the returned Git identity before evaluation.
4. Evaluate the restored candidate through `runtime-op: harness.run`; apply the
   same keep/discard and target/seal rules as the inner loop.

The operation owns exactly one backtrack journal effect. A retry replays it;
callers must not add a duplicate generic event. Reset/re-entry always returns to
the authenticated selected commit and preserves the abandoned tip as archive
evidence until the new result is accepted.

The selected code-archive entry's child count advances once, the returned branch
records its parent commit/reason, and only the documented diminishing-return
counters reset. Experiment totals, score history, budget, evaluator identity,
and prior archive bytes remain unchanged. Re-entry begins at idea selection with
the restored commit as its new authenticated reference point.

## Strategy save, restore, and fork

- `runtime-op: archive.save-strategy` stores the canonical strategy/program at
  a validated generation with typed metrics. Require `generation` and
  `archive_path` from the response.
- `runtime-op: archive.restore-strategy` restores one positive generation
  atomically. Require the same generation and complete `restored` inventory;
  partial restoration is failure.
- `runtime-op: archive.fork-strategy` selects from authenticated `generations`
  and returns `selected`, `restored`, and `children_count`. It restores a
  stepping stone; a child session is created separately by atomic init and
  lineage context, never by copying canonical state.

Save retains the complete strategy, matching program snapshot, Q/components,
generation/evaluation epoch, parent and child-count metadata. Restore/fork
requires all members and their digests; no partial strategy-only restore is a
successful re-entry.

Archive identity, generation, metric snapshot, program/strategy digests, source
branch, and reason remain report/history evidence. Unknown/newer records are
preserved and rejected, not normalized in place.

## Owned worktree cleanup

After explicit completion cleanup consent, `runtime-op: worktree.remove-seed`
may remove one terminal seed worktree by `session_id` and numeric `seed_id`.
The dispatcher authenticates branch/path and reports retained pre-existing
branches. Never remove the selected final branch, another session, dirty
unrecoverable bytes, or an unrelated worktree.
