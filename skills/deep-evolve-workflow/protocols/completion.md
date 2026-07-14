# Completion Report (Section E)

## Protocol Entry — Version Gate

Read the canonical session through `runtime-op: session.read`. Treat the
returned `session` and `session_sha256` as one authenticated snapshot. Do not
reuse shell state from an earlier tool call. The v3 report section is emitted
only when `session.deep_evolve_version` starts with `3.`.

For below-v3.5 compatibility only, `runtime-op: session.mark-status` may expose
the historical lifecycle transition. Strict v3.5 completion must not call it as
a duplicate writer; the single `session.complete` transaction below owns final
status, outcome, Git identity, report/receipt references, synthesis, strategy,
registry, journal, and D0-to-D1 authority.

## Pre-completion: Meta Archive Update

Before generating the report, execute **Meta Archive Update (E.0)** from
`protocols/transfer.md`. This updates transfer learning evidence; it does not
publish the final receipt or complete the session.

## Completion Report

Generate `<session-root>/report.md` from the authenticated session and
`results.tsv`. Detect the results schema from the header: four columns are the
legacy v2 layout and nine columns are the v3 layout. Any other width is fatal.

```markdown
# Deep Evolve Report

**프로젝트**: <project_path>
**목표**: <goal>
**기간**: <created_at> ~ <now>

## 실험 통계
- 총 실험: <total>회 (keep <kept>, discard <discarded>, crash <crashed>)
- Outer Loop: <generations>세대, 최종 Q(v)=<value>
- 전략 진화: strategy.yaml v<version>, program.md v<version>
- 평가 harness: v<version> (<history summary>), epoch <N>
- Score: <baseline> → <best> (<improvement_pct>%)

## Score 변화
<top ten impactful kept experiments>

## 교훈 (Discard 분석)
<approaches that failed and why>

## 적용 방법
<authenticated branch comparison>
```

For v3 sessions append idea-entropy history, shortcut flags, hard rejections,
diagnose retries, rationale gaps, Section-D forcing, and Tier-3 expansions.
The journal remains authoritative for typed events that do not exist in the
TSV schema.

## Final receipt payload

Compose the receipt payload in memory, but do not publish it yet. It retains
the established payload schema and numeric types:

```json
{
  "plugin": "deep-evolve",
  "version": "<session.deep_evolve_version>",
  "receipt_schema_version": 2,
  "timestamp": "<ISO 8601 completion attempt time>",
  "session_id": "<session.session_id>",
  "goal": "<session.goal>",
  "eval_mode": "<cli|protocol>",
  "experiments": {
    "total": 0,
    "kept": 0,
    "discarded": 0,
    "crashed": 0,
    "keep_rate": 0.0
  },
  "score": {
    "baseline": 0,
    "current": 0,
    "best": 0,
    "improvement_pct": 0
  },
  "strategy_evolution": {
    "outer_loop_generations": 0,
    "q_trajectory": [],
    "strategy_versions": 0,
    "best_generation": 0
  },
  "program": { "versions": 1, "meta_analyses": 0 },
  "evaluation_epochs": 1,
  "archives": {
    "strategy_archive_size": 0,
    "code_archive_size": 0,
    "code_forks_used": 0
  },
  "meta_archive_updated": true,
  "transfer": { "received_from": null, "adopted_patterns_kept": null },
  "duration_minutes": null,
  "quality_score": 0,
  "outcome": "<one final semantic outcome>"
}
```

Numbers remain JSON numbers. `keep_rate` is a 0..1 ratio. When baseline is
zero, `improvement_pct` is zero. The extended payload also retains the full
experiment table, up to ten generation snapshots, deduplicated notable keeps,
runtime warnings, and parent-session evidence. The semantic `outcome` must be
non-null before wrapping; the receipt is never edited in place afterward.

## Mandatory completion lifecycle

The following anchors are executable ordering contracts. Each completion
attempt follows them exactly once.

### 1. Resolve one final outcome

<!-- completion-order: outcome-final -->

Ask: “결과를 어떻게 적용할까요?”

- deep-review 후 merge
- deep-review 후 PR 생성
- main에 merge
- PR 생성
- branch 유지
- 폐기

Finish any selected merge, PR, keep, or deep-review decision until `outcome`
is exactly `merged`, `pr_created`, `kept`, or `discarded`. A review failure
returns to the user decision before publication. A discard decision only
authorizes later cleanup; it does not switch branches, move a ref, or delete
anything at this point. Put the resolved non-null value into the final receipt
payload now.

Deep-review paths preserve the existing policy: APPROVE performs the selected
merge or PR action; REQUEST_CHANGES offers fix-and-retry, explicit override,
keep, or discard; evaluator failure offers explicit proceed, keep, or stop.
No receipt exists until that decision is final.

### 2. Authenticate the final Git identity

<!-- completion-order: authenticate-final-ref -->

Read `session.lineage.current_branch` and bind these exact values while the ref
still exists:

```text
final_branch = session.lineage.current_branch
final_ref = `refs/heads/${final_branch}`
final_commit = rev-parse --verify `${final_ref}^{commit}`
```

Use structured Git process data with the authenticated project root and
`shell: false`. Re-read `final_ref` and require the same full commit. For
discard, also authenticate that literal `refs/heads/main^{commit}` exists and
that `main !== final_branch`; failure stops before publication. `final_branch`
and `final_commit` are the values supplied to strict completion even when the
eventual outcome is discard.

### 3. Read the D0 authority epoch

<!-- completion-order: read-d0 -->

Call `runtime-op: session.read` after the outcome and Git identity are fixed.
Define `D0` as its exact `session_sha256`. In the same attempt obtain the
current journal digest used by strict completion. Any authority drift restarts
the attempt; do not guess or refresh individual fields silently.

### 4. Publish the final receipt under D0

<!-- completion-order: publish-receipt-d0 -->

Generate one stable `publication_id` for this attempt and call:

```yaml
runtime-op: artifact.wrap-receipt
payload:
  payload: <final receipt payload including outcome>
  parent_run_id: <validated recurring-findings run id, if present>
  session_id: <session id>
  source_artifacts: <ordered authenticated source records>
  source_recurring_findings: <path, if present>
  publication_id: <stable ULID>
  expected_session_sha256: D0
  legacy_artifact_sha256: <exact fixed legacy digest, only when migration is required>
```

Retain only the returned `artifact_path`, `artifact_sha256`, `publication_id`,
and `envelope.envelope.run_id`. The runtime chooses the target and preserves a
legacy fixed artifact at a versioned path. Exact retry reuses the same
publication ID and run ID.

`stale_preimage` is fatal and stops this lifecycle attempt before completion,
archive, or cleanup. Publication conflicts, ambiguity, migration-preimage
failure, containment errors, and receipt errors are also fatal.

### 5. Emit selected telemetry under D0

<!-- completion-order: emit-telemetry-d0 -->

Default compaction and optional reverse handoff run before strict completion.
Each uses a distinct stable publication ID, the receipt return as an ordered
source record, and the same current authority:

```yaml
runtime-op: artifact.emit-compaction
payload:
  payload: <loop-epoch-end compaction payload>
  parent_run_id: <receipt run id>
  session_id: <session id>
  source_artifacts: [{path: <receipt path>, run_id: <receipt run id>}]
  publication_id: <stable compaction ULID>
  expected_session_sha256: D0
```

```yaml
runtime-op: artifact.emit-handoff
payload:
  payload: <evolve-to-deep-work handoff payload>
  parent_run_id: <authenticated forward-handoff run id, else receipt run id>
  session_id: <session id>
  source_artifacts: <ordered forward-handoff and receipt records>
  publication_id: <stable handoff ULID>
  expected_session_sha256: D0
```

The reverse-handoff trigger remains plateau, target miss, budget exhaustion,
or explicit user opt-in. Parent selection remains: exact adopted source ID,
then exact session correlation, then newest identity-valid non-symlink forward
handoff, finally the receipt. Missing or malformed candidates are never chain
authorities.

Warning-only telemetry handling may cover only a genuine non-contract emit failure after current-digest authentication; warning-only handling must never contain `stale_preimage`.
It cannot fabricate a path, digest, or success. All
contract and safety failures listed above are fatal.

### 6. Complete as the final D0-bound operation

Call `runtime-op: session.complete` only after every selected publication has
returned. Supply the current journal digest, authenticated final ref identity,
report reference, and the receipt path relative to the session root plus its
returned digest. The operation changes the session authority and returns
`session_sha256`; name that exact value `D1`.

```yaml
runtime-op: session.complete
payload:
  session_id: <session id>
  operation_id: <stable completion operation id>
  expected_session_sha256: D0
  expected_journal_sha256: <journal digest captured with D0>
  outcome: <the final semantic outcome>
  final_branch: <authenticated final_branch>
  final_commit: <authenticated final_commit>
  report: {relative_path: <report path beneath session root>, sha256: <report digest>}
  receipt: {relative_path: <returned receipt path beneath session root>, sha256: <returned artifact_sha256>}
```

<!-- completion-order: session-complete-d0-to-d1 -->

No later step reconstructs a receipt path or mutates the receipt. An exact
replay of a publication already committed in the previous epoch remains
historical evidence, but a new publication must bind the current epoch.

### 7. Run strict receipt consumers under D1

<!-- completion-order: archive-d1 -->

Call `runtime-op: session.append-local-archive` only after D1 exists. The
consumer follows `session.completion.receipt.relative_path` and authenticates
its recorded digest; it never prefers a fixed-path decoy. D1 returned by that exact session.complete response is the only authority for any deliberately
post-completion publication. Preserve report, code archive, strategy archive,
and immutable publication evidence.

### 8. Perform discard cleanup last

<!-- completion-order: destructive-cleanup-d1 -->

Only `if (outcome === 'discarded')` may enter this block. Merged, PR-created,
and kept outcomes are non-loss outcomes and never delete the session ref.

For discard, require successful strict completion and local archive, switch to
the already authenticated literal `main`, and verify checkout. Re-read
`final_ref` read-only and require `final_commit`. Missing or any different OID
stops without invoking deletion. Then construct exactly one process request:

```js
const deletion = {
  executable: 'git',
  argv: ['update-ref', '-d', final_ref, final_commit],
  cwd: authenticated_project_root,
  shell: false,
};
assert(invocation_count === 1);
```

Classify that single invocation:

- Exit zero: authenticate that `final_ref` is absent. Absence succeeds; a
  present OID is incomplete.
- Explicit nonzero: cleanup is incomplete even if a later lookup sees absence.
  Do not retry or adopt it as a known deletion response.
- Transport-level response loss: perform one read-only ref lookup. Authenticated
  absence may be adopted only after the matching pre-CAS lookup and exactly one
  invocation. Presence at the old commit or any replacement X is incomplete.
- No invocation because the pre-CAS lookup was missing or mismatched: incomplete;
  response-loss adoption is unavailable.

There is no second mutation. Expected-old mismatch preserves a moved or
recreated foreign ref. Cleanup status never rewrites the immutable receipt or
completed session outcome.

## Completion result

Report the final outcome, authenticated receipt path/digest/run ID, D1 session
digest, archive result, optional telemetry results, and discard cleanup status.
Retain all artifact publication evidence for crash recovery and audit.
