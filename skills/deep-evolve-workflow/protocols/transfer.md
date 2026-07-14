# Cross-Project Transfer and Meta Archive

Transfer uses dispatcher-owned locks, normalization, immutable publication, and
soft pruning. Protocol text never edits the shared archive directly.

## Lookup and adoption

1. Call `runtime-op: transfer.lookup` without `selected_id` for bounded entries.
2. Rank goal/domain/stack/scale applicability using authenticated read-only
   evidence; display ranking is not selection authority.
3. After explicit adoption, call the same operation with exact `selected_id`.
4. Require source ID/schema, normalized weights, prior N, virtual context,
   program versions, and warnings. Unsupported/newer/malformed entries stop.
5. Convert legacy weights only through the taxonomy-owned migration operation.
6. During atomic init, include consented transfer in `initial_state.transfer`.
   `runtime-op: session.patch` is transfer-only for initializing recovery and
   accepts exact CAS authority; the runtime stamps adoption time.
7. Render bounded inherited context through
   `runtime-op: session.render-inherited-context`; it remains guidance, not
   canonical field authority.

## Recording gate and normalization

Record only after at least two outer generations and at least one authenticated
Q improvement. The session must have schema-valid terminal score/result,
reusable learning, resolved source identity, and no contamination. Preserve:

- project/goal/targets/evaluation identity and metric direction;
- initial/final strategy, Q trajectory, program versions, generation/epoch data;
- experiment outcomes, category/entropy evidence, virtual allocation/synthesis;
- transfer source, first-block effectiveness, adopted patterns, lineage/outcome;
- positive `n_current` or the zero-active sentinel, never both.

Call `runtime-op: transfer.record` with complete `entry`, optional `source_id`,
and binary `this_session_success`. `pending: false` identifies a committed
record; `pending: true` is a durable deferred record. Exact retry cannot create
a second logical entry. Pending records retain new-entry/source-update identity
and merge atomically on a later dispatcher transaction.

Normalization preserves legacy missing schema as v2, v3.0 as schema 3 without
virtual shape, and strict virtual sessions with the positive-`n_current` versus
zero-active-sentinel exclusive shape. Newer unsupported schemas fail closed.
Source effectiveness updates exactly once using its prior usage count; a null
rate becomes the binary result, otherwise use the weighted prior-rate formula.

## Cross-plugin feedback

Call `runtime-op: transfer.export-feedback` with complete payload, ordered
authenticated `source_artifacts`, `session_id`, stable `publication_id`, and
`expected_session_sha256`. Require immutable envelope/path/digest/publication
and replay result. This operation alone owns cross-plugin feedback; local
classified insights remain taxonomy-owned.

## Soft prune

1. Call `runtime-op: transfer.prune` with empty `selected_ids` for preview.
2. Display candidates, reasons, total/active/pruned counts, usage count, success
   rates, and oldest/newest use. Preserve pending, child-lineage, PR/handoff,
   unknown/newer, and explicitly retained entries.
3. After explicit stable selection, call the operation with exact IDs and
   require returned candidates, `pruned`, and `total`.

Pruning marks records; it never semantically deletes history. Candidates are
90+ days unused with success rate below 0.3, an all-failed source, fewer than
two outer generations, v2/missing schema older than 180 days, or schema 3 older
than 270 days. A deferred merge is completed before preview, deduplicates
by stable ID, updates source effectiveness exactly once, and preserves every
unrecognized line for fail-closed inspection.
