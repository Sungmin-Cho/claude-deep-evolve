# History Protocol

History is read-only. It renders canonical responses and authenticated receipt
bytes without repairing, normalizing, pruning, or patching state.

## Parse and load

- No ID or `list`: call `runtime-op: session.list` with optional exact status.
- Literal session ID: call `runtime-op: session.read` for detail.
- `--lineage`: call `runtime-op: session.lineage-tree` and render returned lines.
- Status view: call `runtime-op: coord.status` and render its dashboard/warnings.
- Export mode accepts only a literal contained destination and `md` or `json`.

Do not enumerate state directories as fallback. rc 1 means unavailable; rc 2,
unknown schema, malformed response, containment failure, or digest mismatch
stops the requested view.

## Strict completion receipt resolution

For v3.5, resolve only `completion.receipt.relative_path` beneath the
authenticated session root and require `completion.receipt.sha256`. Reject a
missing file, symlink, path escape, mismatched digest, or envelope identity.
Strict v3.5 never falls back to `evolve-receipt.json`; it also never guesses the
newest receipt.

Below v3.5 compatibility may display `evolve-receipt.json` only when the session
schema explicitly lacks a strict completion reference. The native Read adapter
yields display evidence only and never state authority.

## Rendered views

List mode includes session/goal/date, lifecycle, experiment totals, keep rate,
Q/score movement, outcome, and warning marker. Detail mode includes:

- goal, targets, dates, lineage, final branch/full commit, and outcome;
- top/bottom or full experiment table from the authenticated result schema;
- generation and evaluation-epoch snapshots, Q components/history, entropy,
  shortcuts, diagnoses, legibility, notable keeps, and evaluator expansions;
- seed allocations/status/borrow evidence, synthesis selection/fallback;
- report, receipt, archive, transfer, handoff, and runtime warning identities.

Detail/export also carries local code/strategy archive sizes, transfer source
and first-block effectiveness, meta-archive total/active/pruned and usage/success
statistics, soft-prune reasons, and completion snapshot identities when present.
Missing optional older-version fields render as compatibility gaps, never
fabricated zeroes in an authenticated strict-v3.5 record.

Aggregates count only schema-valid sessions and preserve unknown/newer entries
as warnings. Exports are newly rendered views; they never replace source
records or become completion authority.
