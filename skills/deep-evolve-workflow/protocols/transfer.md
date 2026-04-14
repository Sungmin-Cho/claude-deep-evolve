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
   - Use its `final_strategy` as initial values for `strategy.yaml` in A.3 step 9
   - Inject its `program_versions` diffs into program.md generation (A.3 step 6) under a "검증된 전략 전이" section:
     ```markdown
     ## 전이된 전략 (유사 프로젝트에서 검증됨)
     - 소스: <goal_description> (<project type>)
     - Q 궤적: <q_trajectory summary>
     - 핵심 교훈: <program diff summary>
     ```
   - Record transfer source: set `session.yaml.transfer.source_id = <archive_id>`
   - Do NOT increment `usage_count` here — it is updated only in Section E.0 after session completion.

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
   ```jsonl
   {
     "id": "archive_<timestamp_hash>",
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
     "transfer": {
       "source_id": "<id or null>",
       "adopted_patterns_kept": <count or null>,
       "initial_keep_rate_10": <v or null>
     },
     "usage_count": 0,
     "transfer_success_rate": null
   }
   ```

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
   - If flock times out (5 seconds): save to `~/.claude/deep-evolve/.pending-archive.jsonl` instead.
     Display warning: "메타 아카이브 잠금 실패 — .pending-archive.jsonl에 임시 저장됨. 다음 세션에서 자동 병합됩니다."
   - On next session init (A.2.5), check for `.pending-archive.jsonl` and merge (with flock).

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
5. Generate `.deep-evolve/evolve-insights.json`:

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

6. Each insight's `source_archive_ids` must reference actual archive entry IDs for traceability.
7. This file is "suggestion-level" — consuming plugins decide independently whether to use it.

---

## Section F: Archive Prune

Triggered by `/deep-evolve --archive-prune`.

Manages the global meta-archive at `~/.claude/deep-evolve/meta-archive.jsonl`.

### Steps

1. **Check archive exists**:
   If `~/.claude/deep-evolve/meta-archive.jsonl` does not exist, report "메타 아카이브가 비어 있습니다." and exit.

2. **Merge pending entries**:
   If `~/.claude/deep-evolve/.pending-archive.jsonl` exists, merge its entries into the main archive (via flock).

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
