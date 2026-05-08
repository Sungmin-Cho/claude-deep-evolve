# Cross-Project Transfer — Meta Archive (A.2.5 + E.0 + Section F)

## Meta Archive Lookup (A.2.5 — called from Init)

Check if `~/.claude/deep-evolve/meta-archive.jsonl` exists. If not, skip (return to Init).

If it exists:

1. **Read active entries**: Parse all lines from meta-archive.jsonl. Filter out entries where `"pruned": true`.

2. **LLM-based similarity assessment**: Present the current project's goal, language, framework, and scale alongside the archive entries' `project` and `goal_description` fields. Ask the LLM to select the strategically most similar project based on (priority order):
   a. Goal type similarity (optimization vs quality improvement vs refactoring)
   b. Code stack (language/framework)
   c. Project scale (LOC, target file count)

3. **If a similar entry is found** (LLM confirms relevance):

   **Schema compatibility branch (v3.0.0 / v3.1.0)**:

   Extract `schema_version` safely — v2 entries written before 3.0.0 do NOT
   have this field at all. Treat missing/null as `2`:

   ```bash
   if ! entry_schema=$(echo "$entry" | jq -r '.schema_version // 2'); then
     echo "warning: A.2.5 entry $entry_id schema_version unreadable (jq failed) — skipping" >&2
     continue
   fi
   ```

   Route via numeric comparison + explicit-arm case (W-1 forward-compat lesson —
   every condition explicit, default rejects loudly). C3 fix (deep-review
   2026-04-25 plan-stage): prior implementations used bash GLOB patterns for
   v5+ detection — bash glob `*` after a character class ambiguously matches
   arbitrary trailing chars (e.g., `123abc` passing the version gate).
   Numeric `-ge` comparison eliminates the ambiguity:

   ```bash
   # Step 1: validate entry_schema is a non-negative integer (no leading zeros,
   # no garbage). Reject malformed at the boundary — never let a glob-ambiguous
   # input route silently to the v5+ rejection arm.
   if ! [[ "$entry_schema" =~ ^(0|[1-9][0-9]*)$ ]]; then
     echo "warning: A.2.5 entry $entry_id has malformed schema_version=$entry_schema — skipping" >&2
     continue
   fi

   # Step 2: numeric routing. Each arm explicit; no glob ambiguity.
   if [ "$entry_schema" -ge 5 ]; then
     # Forward-incompatible: v3.1.x code MUST NOT silently process a v3.2+/v4
     # archive entry. Operator error — user is running an older deep-evolve
     # against a future archive. rc=2 (operator), with actionable message
     # pointing to the upgrade path.
     echo "error: A.2.5 schema_version=$entry_schema is from a newer deep-evolve release." >&2
     echo "       This v3.1.x deep-evolve cannot read it; either upgrade deep-evolve" >&2
     echo "       or run /deep-evolve --archive-prune to mark this entry pruned." >&2
     exit 2
   elif [ "$entry_schema" -le 1 ]; then
     # Negative or zero — malformed (the regex above already filters; defense-in-depth).
     echo "warning: A.2.5 entry $entry_id has out-of-range schema_version=$entry_schema — skipping" >&2
     continue
   else
     # entry_schema ∈ {2, 3, 4} — explicit case dispatch
     case "$entry_schema" in
       2)
         # Legacy v2 entry: translate weights via session-scoped mktemp
         # (concurrent v3 inits would race on a hard-coded /tmp path).
         if ! tmpfile=$(mktemp "${TMPDIR:-/tmp}/de-v2weights.XXXXXX"); then
           echo "error: A.2.5 v2 arm mktemp failed (disk full / no /tmp permission)" >&2
           continue
         fi
         trap 'rm -f "$tmpfile"' EXIT
         printf '%s' "$entry_weights_json" > "$tmpfile"
         if ! translated=$(bash "$CLAUDE_PLUGIN_ROOT/hooks/scripts/session-helper.sh" \
             migrate_v2_weights "$tmpfile"); then
           echo "error: A.2.5 v2-weights migration failed" >&2
           rm -f "$tmpfile"; trap - EXIT
           exit 1
         fi
         rm -f "$tmpfile"
         trap - EXIT
         N_PRIOR=1
         SOURCE_SCHEMA=2
         ;;
       3)
         # v3.0.x entry: 10-category weights already, no virtual_parallel block.
         # Read as single-seed (N_prior=1) so transfer-effectiveness comparisons
         # against v3.1 multi-seed sessions remain meaningful (W-8).
         if ! USE_WEIGHTS=$(echo "$entry" | jq -c '.final_strategy.weights'); then
           echo "error: A.2.5 v3 entry $entry_id final_strategy.weights unreadable" >&2
           continue
         fi
         N_PRIOR=1
         SOURCE_SCHEMA=3
         ;;
       4)
         # schema_version=4 (v3.1.x entry): 10-category weights AND full
         # virtual_parallel snapshot. The snapshot may hint N_initial /
         # project_type / eval_parallelizability to A.1.6's classifier as a
         # prior signal — but A.1.6 still consults the AI freshly.
         # (Transfer is suggestion-level, not authoritative.)
         if ! USE_WEIGHTS=$(echo "$entry" | jq -c '.final_strategy.weights'); then
           echo "error: A.2.5 v4 entry $entry_id final_strategy.weights unreadable" >&2
           continue
         fi
         if ! VP_PRIOR=$(echo "$entry" | jq -c '.virtual_parallel // {}'); then
           echo "error: A.2.5 v4 entry $entry_id virtual_parallel block unreadable" >&2
           continue
         fi
         if ! N_PRIOR=$(echo "$VP_PRIOR" | jq -r '.n_initial // 1'); then
           echo "error: A.2.5 v4 entry virtual_parallel.n_initial unreadable" >&2
           exit 1
         fi
         SOURCE_SCHEMA=4
         ;;
       *)
         # Defense-in-depth: outer if-chain should have routed already.
         # If we reach here, the boundary regex + numeric routing has a bug.
         echo "error: A.2.5 internal invariant violated — entry_schema=$entry_schema reached inner case despite outer filter" >&2
         exit 1
         ;;
     esac
   fi
   ```

   - Inject `program_versions` diffs into program.md generation (A.3 step 6)
     under a "검증된 전략 전이" section (existing behavior — applies to all
     non-rejected entries).
   - Record transfer source: `session.yaml.transfer.source_id = <archive_id>`.
   - Record schema version received: `session.yaml.transfer.source_schema_version = $SOURCE_SCHEMA`.
   - For schema_v4 entries: `session.yaml.transfer.source_n_prior = $N_PRIOR`
     (lets E.0 compute transfer effectiveness across N transitions).

4. **If no similar entry found**: proceed with default strategy.yaml.

## Meta Archive Update (E.0 — called before Completion Report)

Before generating the completion report, attempt to record this session's strategy evolution to the global meta-archive.

### Recording Gate

Both conditions must be met to record:
1. Outer Loop ran at least 2 generations (`session.yaml.outer_loop.generation >= 2`)
2. Q(v) improved in at least 1 generation (check `q_history` for any increase)

If either condition is not met, skip recording.

### Recording Process

1. **Ensure directory exists**:
   ```bash
   mkdir -p ~/.claude/deep-evolve
   ```

2. **Extract session data**:
   - `strategy_evolution`: strategy.yaml version history, Q(v) trajectory from `q_history`, program.md version diffs
   - `outcome`: total experiments, keep/discard/crash counts, improvement percentage from results.tsv + session.yaml
   - `transfer`: if `session.yaml.transfer.source_id` is set, compute transfer effectiveness:
     - `initial_keep_rate_10`: keep rate of first 10 experiments (indicator of transfer quality)
     - `adopted_patterns_kept`: which transferred strategy patterns survived to final strategy.yaml

3. **Write to meta-archive** (flock protocol):
   ```bash
   (
     flock -x -w 5 200 || { echo "LOCK_FAILED"; exit 1; }
     # Append new entry to meta-archive.jsonl
     # If transfer.source_id is set, also update source entry
   ) 200>~/.claude/deep-evolve/meta-archive.lock
   ```

   **New entry format** (append to `~/.claude/deep-evolve/meta-archive.jsonl`):

   **TEMPLATE — fill placeholders before writing** (I6 note: this is the JSON
   SHAPE only — do NOT copy `<session.yaml.virtual_parallel.*>` literals into
   the actual JSONL output; use the jq construction snippet below instead):

   ```jsonl
   {
     "id": "archive_<timestamp_hash>",
     "schema_version": 4,
     "timestamp": "<now>",
     "project": {
       "path_hash": "<sha256(project_path)[:8]>",
       "type": "<detected project type>",
       "goal_description": "<session goal>",
       "eval_mode": "<cli|protocol>",
       "template_type": "<stdout_parse|test_runner|scenario|protocol>",
       "code_characteristics": {
         "languages": ["<lang>"],
         "frameworks": ["<framework>"],
         "loc_estimate": <N>,
         "target_files_count": <N>
       }
     },
     "strategy_evolution": {
       "initial_strategy": { <strategy.yaml v1 snapshot> },
       "final_strategy": { <strategy.yaml final snapshot> },
       "generations": <N>,
       "q_trajectory": [<Q values per generation>],
       "best_generation": <N>,
       "program_versions": [
         {"version": 1, "keep_rate": <v>, "summary": "<reason>"},
         {"version": 2, "keep_rate": <v>, "diff_from_prev": "<diff>", "meta_analysis_reasoning": "<reason>"}
       ]
     },
     "outcome": {
       "total_experiments": <N>,
       "total_outer_generations": <N>,
       "final_keep_rate": <v>,
       "improvement_pct": <v>,
       "crashed_rate": <v>
     },
     "virtual_parallel": {
       "n_initial": <session.yaml.virtual_parallel.n_initial>,
       "n_current": <session.yaml.virtual_parallel.n_current>,
       "project_type": "<session.yaml.virtual_parallel.project_type>",
       "eval_parallelizability": "<session.yaml.virtual_parallel.eval_parallelizability>",
       "selection_reason": "<session.yaml.virtual_parallel.selection_reason>",
       "budget_total": <session.yaml.virtual_parallel.budget_total>,
       "budget_unallocated": <session.yaml.virtual_parallel.budget_unallocated>,
       "synthesis": {
         "budget_allocated": <session.yaml.virtual_parallel.synthesis.budget_allocated>,
         "regression_tolerance": <session.yaml.virtual_parallel.synthesis.regression_tolerance>
       }
     },
     "transfer": {
       "source_id": "<id or null>",
       "adopted_patterns_kept": <count or null>,
       "initial_keep_rate_10": <v or null>
     },
     "usage_count": 0,
     "transfer_success_rate": null
   }
   ```

   **Concrete jq construction** (I3 fix — this is the actual bash that E.0 runs,
   rc-guarded per aff23c9 contract):

   ```bash
   # Read virtual_parallel block from session.yaml as JSON via yq, then pass to jq.
   # Falls back to empty object if virtual_parallel is missing (v3.0 sessions
   # emitting schema_v3 entries don't have this block — never reaches this branch
   # because E.0 already routed by version, but defense-in-depth).
   if ! VP_JSON=$(yq -o json '.virtual_parallel // {}' "$SESSION_ROOT/session.yaml"); then
     echo "error: E.0 cannot read virtual_parallel from session.yaml" >&2
     exit 1
   fi

   # Construct the new entry, substituting schema_version=4 + injecting virtual_parallel.
   # argv-safe: VP_JSON is interpolated via --argjson (typed), schema_version via --argjson.
   if ! NEW_ENTRY=$(jq -n -c \
       --arg id "$ARCHIVE_ID" \
       --arg ts "$NOW_ISO" \
       --argjson sv 4 \
       --argjson project "$PROJECT_JSON" \
       --argjson strategy "$STRATEGY_EVOLUTION_JSON" \
       --argjson outcome "$OUTCOME_JSON" \
       --argjson vp "$VP_JSON" \
       --argjson transfer "$TRANSFER_JSON" \
       '{
          id: $id, schema_version: $sv, timestamp: $ts,
          project: $project,
          strategy_evolution: $strategy,
          outcome: $outcome,
          virtual_parallel: $vp,
          transfer: $transfer,
          usage_count: 0, transfer_success_rate: null
        }'); then
     echo "error: E.0 jq construction of v3.1 entry failed" >&2
     exit 1
   fi

   # Append to meta-archive under flock (existing pattern from transfer.md).
   printf '%s\n' "$NEW_ENTRY" >> "$HOME/.claude/deep-evolve/meta-archive.jsonl"
   ```

   **v3.0.x sessions** continue using their existing E.0 jq construction without
   the `--argjson vp` arg — they emit `schema_version: 3` and no `virtual_parallel`
   key. The router in transfer.md selects the correct construction per session
   version.

   **v3.0.0 / v3.1.0 note**: v3.0.x sessions emit `"schema_version": 3` (no
   `virtual_parallel` block). v3.1.x sessions emit `"schema_version": 4` AND
   the `virtual_parallel` snapshot. v2.x sessions wrote entries without
   `schema_version`; A.2.5's compat branch treats missing as `2`. All three
   coexist in the same `meta-archive.jsonl` file — A.2.5's case statement
   routes correctly. Forward versions (5+) MUST be rejected with rc=2 by the
   reader to prevent silent misinterpretation.

4. **Update source entry** (if transfer was used):
   Within the same flock:
   - Read all lines from meta-archive.jsonl
   - Find the source entry by `transfer.source_id`
   - Compute `this_session_success = 1 if improvement_pct > 0 else 0`
   - Update its `transfer_success_rate`:
     ```
     If transfer_success_rate is null:
       new_rate = this_session_success (0 or 1)
     Else:
       new_rate = (old_rate × usage_count + this_session_success) / (usage_count + 1)
     ```
   - Increment its `usage_count`
   - Rewrite the full file (within flock)

5. **Flock failure handling**:
   - If flock times out (5 seconds), **append one or two tagged records** to
     `~/.claude/deep-evolve/.pending-archive.jsonl`:
     - New entry: `{"type": "new_entry", "timestamp": "<now>", "data": { <full new entry object> }}`
     - Source update (only if transfer was used): `{"type": "update_source", "timestamp": "<now>",
       "id": "<source_id>", "this_session_success": <0|1>}`
   - Display warning: "메타 아카이브 잠금 실패 — .pending-archive.jsonl에 임시 저장됨.
     다음 세션에서 자동 병합됩니다."
   - Legacy untagged lines (written by v2.2.1 or earlier) are merged as if they were
     `type: "new_entry"` — see Section F step 2. (H-3 fix)

## Section E.1: Cross-Plugin Feedback Export

Execute only if the Recording Gate (E.0) was passed.

Analyze the meta-archive for patterns that could benefit other plugins:

1. If meta-archive has fewer than 2 active entries, skip this step (insufficient data for pattern extraction).
2. Read `~/.claude/deep-evolve/meta-archive.jsonl`
3. Filter for active (non-pruned) entries with similar project characteristics
4. Extract effective patterns from strategy_evolution data:
   - Strategies with high keep_rate (> 0.3)
   - Program.md changes that correlated with Q(v) improvement
   - Idea selection weight distributions that worked well
5. Generate `$SESSION_ROOT/evolve-insights.json` as an **M3 envelope-wrapped
   artifact** (cf. `claude-deep-suite/docs/envelope-migration.md` §1). The
   payload below — preserved verbatim from v3.1.x — becomes the `payload` of
   the wrapped envelope.

   > **Multi-source aggregator (handoff §3.3)**: evolve-insights aggregates
   > the local meta-archive plus optional cross-plugin signals. There is no
   > single dominant parent, so `envelope.parent_run_id` is **omitted**;
   > consumed sources land in `envelope.provenance.source_artifacts[]`
   > instead. (Same pattern as deep-dashboard's `harnessability-report`.)

   **Payload shape** (legacy v3.1.x body, kept identical):

   ```json
   {
     "updated_at": "<ISO 8601 now>",
     "insights_for_deep_work": [
       {
         "pattern": "<pattern name extracted from effective strategies>",
         "evidence": "<keep_rate X.XX across N projects, Q(v) +X.XX improvement>",
         "source_archive_ids": ["<archive entry id>"],
         "suggestion": "<actionable suggestion for Phase 3 implement>"
       }
     ],
     "insights_for_deep_review": [
       {
         "pattern": "<pattern name>",
         "evidence": "<experiment outcome data>",
         "source_archive_ids": ["<archive entry id>"],
         "suggestion": "<review criteria enhancement suggestion>"
       }
     ]
   }
   ```

   ### Envelope wrap (atomic)

   Write the payload to a temp file and invoke the wrap helper (atomic
   temp+rename internally; cleanup gated on success — handoff §4 round-1
   C1+C2 lessons).

   ```bash
   set -euo pipefail

   PAYLOAD_TMP="$SESSION_ROOT/.evolve-insights.payload.json"
   OUT_PATH="$SESSION_ROOT/evolve-insights.json"

   # Write the payload JSON shape above to PAYLOAD_TMP.

   META_ARCHIVE="$HOME/.claude/deep-evolve/meta-archive.jsonl"

   WRAP_ARGS=(
     --artifact-kind evolve-insights
     --payload-file "$PAYLOAD_TMP"
     --output "$OUT_PATH"
   )
   SESSION_ID=$(grep '^session_id:' "$SESSION_ROOT/session.yaml" | head -1 | sed 's/^session_id:[[:space:]]*//; s/"//g')
   [ -n "$SESSION_ID" ] && WRAP_ARGS+=(--session-id "$SESSION_ID")
   [ -f "$META_ARCHIVE" ] && WRAP_ARGS+=(--source-artifact "$META_ARCHIVE")

   # Optional: deep-review recurring-findings as an additional cross-plugin
   # source signal (path-only — evolve-insights does NOT chain via
   # parent_run_id; the run_id is recorded in source_artifacts when the file
   # is envelope-wrapped, via the helper's loose detection).
   REC_PATH="$PROJECT_ROOT/.deep-review/recurring-findings.json"
   [ -f "$REC_PATH" ] && WRAP_ARGS+=(--source-artifact "$REC_PATH")

   if node "$CLAUDE_PLUGIN_ROOT/hooks/scripts/wrap-evolve-envelope.js" "${WRAP_ARGS[@]}"; then
     rm -f "$PAYLOAD_TMP"
   else
     echo "wrap-evolve-envelope failed — preserving $PAYLOAD_TMP for retry; re-run this step to retry." >&2
     exit 1
   fi
   ```

   The helper:
   - Generates `envelope.run_id` (ULID), sets `producer = "deep-evolve"`,
     `artifact_kind = "evolve-insights"`, `schema.name = "evolve-insights"`.
   - **Omits** `envelope.parent_run_id` (multi-source aggregator semantics).
   - Adds each `--source-artifact <path>` to
     `envelope.provenance.source_artifacts[]`. Local meta-archive (jsonl, not
     envelope) contributes path-only; envelope-wrapped sources contribute
     `path + run_id`.

6. Each insight's `source_archive_ids` must reference actual archive entry IDs
   for traceability.
7. This file is "suggestion-level" — consuming plugins decide independently
   whether to use it. Consumers (deep-work `gather-signals.sh` since v6.5.0)
   detect the M3 envelope, validate identity (`producer == "deep-evolve"`,
   `artifact_kind == "evolve-insights"`), unwrap the payload, and fall back to
   legacy pass-through for pre-v3.2.0 emits.

---

## Section F: Archive Prune

Triggered by `/deep-evolve --archive-prune`.

Manages the global meta-archive at `~/.claude/deep-evolve/meta-archive.jsonl`.

### Steps

1. **Check archive exists**:
   If `~/.claude/deep-evolve/meta-archive.jsonl` does not exist, report "메타 아카이브가 비어 있습니다." and exit.

2. **Merge pending entries** (H-3):
   If `~/.claude/deep-evolve/.pending-archive.jsonl` exists, merge entries (via flock):
   - For each line, detect `type`:
     - `type: "new_entry"` — append `data` to main archive (dedupe by `id`).
     - `type: "update_source"` — locate source entry by `id`, recompute
       `transfer_success_rate` using its stored `usage_count`:
       ```
       new_rate = (old_rate * usage_count + this_session_success) / (usage_count + 1)
       # or this_session_success if old_rate is null
       ```
       then `usage_count += 1`.
     - Untagged (legacy v2.2.1 lines, JSON object at root): treat as `new_entry`.
   - Atomically rewrite main archive; remove `.pending-archive.jsonl` after success.

3. **Display archive statistics**:
   ```
   Meta Archive 통계
   ━━━━━━━━━━━━━━━━
   총 항목: <total>
   활성: <active> | pruned: <pruned>
   전이 사용: <total usage_count across all>
   평균 전이 성공률: <mean transfer_success_rate>
   가장 오래된 항목: <oldest timestamp>
   가장 최근 항목: <newest timestamp>
   ```

4. **Identify pruning candidates** (soft pruning — mark as pruned, never delete):
   Entries matching ANY of:
   - 90+ days since last use (`timestamp` and last transfer) AND `transfer_success_rate < 0.3`
   - `transfer_success_rate == 0` (all transfers from this entry failed)
   - `outcome.total_outer_generations < 2` (insufficient Outer Loop data)
   - **v2 schema + 180+ days old**: `(schema_version < 3 OR schema_version missing) AND timestamp older than 180 days` (v3.0.0 deprecation path)
   - **v3 schema + 270+ days old**: `schema_version == 3 AND timestamp older than
     270 days` (v3.1.0 deprecation timeline — 270 days gives v3.0.x users a
     longer runway than v2's 180-day cliff because v3.0 was a stable release).

5. **Display pruning candidates**:
   ```
   Pruning 후보 (<count>건):
   1. <goal_description> (<project type>, <timestamp>)
      사유: <pruning reason>
   2. ...
   ```

6. **User confirmation**: AskUserQuestion:
   "위 항목을 pruning할까요? (조회에서 제외, 데이터 삭제 없음)"
   Options:
   - "전체 적용" → prune all candidates
   - "선택 적용" → let user pick which to prune
   - "취소"

7. **Apply pruning** (via flock):
   ```bash
   (
     flock -x -w 5 200 || { echo "LOCK_FAILED"; exit 1; }
     # Read meta-archive.jsonl
     # Add "pruned": true, "pruned_reason": "<reason>" to selected entries
     # Rewrite file
   ) 200>~/.claude/deep-evolve/meta-archive.lock
   ```

8. Display result: "<N>건 pruned. 아카이브 조회에서 제외됩니다."
