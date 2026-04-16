# Outer Loop — Strategy Evolution (Step 6.5)

The Outer Loop governs strategy evolution across the 3-tier hierarchy. It fires after every `outer_interval` (default 20) inner iterations, evaluating and adjusting the experimental strategy.

**Auto-trigger gate**: If `session.yaml.outer_loop.auto_trigger` is false, the caller (inner-loop.md Step 6.c) will have already asked the user before entering this protocol. If true, this protocol executes without user confirmation.

The 3-tier self-evolution hierarchy:
1. **Tier 1** — `strategy.yaml` parameter tuning (low freedom, quantitative adjustment)
2. **Tier 2** — `program.md` strategy text revision (medium freedom, natural language)
3. **Tier 3** — `prepare.py` scenario expansion (high freedom, raises quality ceiling)

Reset `inner_count` to 0. **Persist**: update `session.yaml.outer_loop.inner_count` to 0. Increment `session.yaml.outer_loop.generation`.

## Step 6.5.1 — Meta Analysis

Analyze experiment results for the current generation's interval:

1. **패턴 추출**: Read `results.tsv` and `journal.jsonl` for the current generation's experiment range:

   a. **keep 비율 분석**:
      - Classify each experiment's description into categories matching `strategy.yaml.idea_selection.weights` keys (parameter_tuning, structural_change, algorithm_swap, simplification, etc.)
      - Compute keep rate per category

   b. **discard 패턴 분류**:
      - Categorize failure types: crash, regression, marginal (improved but < min_delta)
      - Detect repeated attempts of the same approach (description similarity)

   c. **score 개선 폭 분석**:
      - Identify common traits of experiments with the largest positive delta
      - Characterize score plateau intervals

2. **메타 분석 기록**: Write to `$SESSION_ROOT/meta-analyses/gen-<N>.md` where N = `session.yaml.outer_loop.generation`. Write to per-generation file (do not overwrite previous generations).
   ```markdown
   # Meta Analysis — Generation <g>, Experiments <start>-<end>
   **Generated**: <timestamp>
   **Strategy**: v<version> | **Program**: v<version> | **Epoch**: <epoch>

   ## 카테고리별 Keep Rate
   | 카테고리 | 시도 | keep | rate |
   |----------|------|------|------|
   | parameter tuning | 12 | 7 | 58% |
   | structural change | 8 | 1 | 13% |

   ## Discard 패턴
   - crash: <count>회 — <common cause>
   - regression: <count>회 — <pattern>
   - marginal: <count>회 — <observation>

   ## Score 개선 분석
   - 최대 delta: <description> (+<delta>)
   - 정체 구간: experiment <N>-<M>

   ## Q(v) = <value>
   - keep_rate: <value>
   - normalized_delta: <value>
   - crash_rate: <value>
   - idea_diversity: <value>
   ```

## Step 6.5.2 — Q(v) Meta-Metric Computation

Compute the strategy quality metric (fixed formula — part of Core Protocol, not modifiable by strategy.yaml):

```
Q(v) = 0.35 × keep_rate
     + 0.30 × normalized_delta
     + 0.20 × (1 - crash_rate)
     + 0.15 × idea_diversity

where:
  keep_rate(v):         kept / total experiments in this generation's interval
  normalized_delta(v):  if max_delta == 0: 0.0
                        else: mean_delta / max_delta
                        (max_delta = max score delta across current evaluation epoch)
  crash_rate(v):        crashed / total experiments in this generation's interval
  idea_diversity(v):    mean pairwise Jaccard distance of experiment descriptions
                        (tokenize descriptions → word sets, compute 1 - |A∩B|/|A∪B|
                         for all pairs, take mean; range 0-1)
```

> **W-4 guard**: `normalized_delta` uses `max_delta` as denominator. If `max_delta == 0` (no kept experiments in this epoch), `normalized_delta = 0.0` — never divide by zero.

Record Q(v) in:
- `session.yaml.outer_loop.q_history`: append `{generation: <g>, Q: <value>, epoch: <e>}`
- `session.yaml.evaluation_epoch.history[current].generations`: append generation number
- Update `session.yaml.evaluation_epoch.history[current].best_Q` if improved
- `journal.jsonl`: `{"event": "outer_loop", "generation": <g>, "Q": <value>, "epoch": <e>, "timestamp": "..."}`

## Step 6.5.3 — Tier 1: strategy.yaml Parameter Adjustment

Set `DEEP_EVOLVE_META_MODE=outer_loop` before modifying strategy.yaml (allows writes past protect-readonly hook).

Based on meta analysis results, adjust `strategy.yaml` parameters:

- **Idea selection weights**: Shift toward high keep-rate categories.
  Example: if `parameter_tuning` keep rate is 60% and `structural_change` is 10%:
  → Increase `parameter_tuning` weight, decrease `structural_change` weight.
  Always normalize weights to sum to 1.0.

- **Judgment thresholds**: If marginal improvements dominate → increase `min_delta`.
  If too many discards → decrease `min_delta` slightly.

- **Convergence parameters**: If consecutive discards were frequent → lower `consecutive_discard_limit`.

- **Exploration**: If idea diversity is low → increase `min_novelty_distance`.
  If `candidates_per_step` selection failures are high → increase `candidates_per_step`.

Increment `strategy.yaml.version`. Record changes in journal.jsonl:
`{"event": "strategy_update", "generation": <g>, "version": <new>, "changes": {...}, "timestamp": "..."}`

## Step 6.5.4 — Tier 2: program.md Revision

Based on meta analysis, propose program.md revision:

1. **사용자 확인**: AskUserQuestion:
   "메타 분석 완료 (Q(v)=<value>) — 실험 전략을 업데이트할까요?"
   Options:
   - "자동 업데이트 적용" → proceed with update
   - "내용 확인 후 결정" → Display `$SESSION_ROOT/meta-analyses/gen-<N>.md`, then re-ask with "적용" / "유지"
   - "현재 전략 유지" → skip program.md update

2. **If approved** — Program Update:
   a. Set `DEEP_EVOLVE_META_MODE=outer_loop` (allows both strategy.yaml and program.md writes past protect-readonly hook).
   b. Read current `$SESSION_ROOT/program.md`.
   c. Generate updated `program.md`:
      - Preserve overall structure and project-specific context
      - Strengthen sections for effective strategies (high keep-rate categories)
      - Add explicit "avoid" list from discard pattern analysis
      - Add new exploration directions as suggestions
      - Append version footer: `<!-- program v<new_version> — meta_analysis at experiment <N> -->`
   d. Write updated `$SESSION_ROOT/program.md`.
   e. Unset `DEEP_EVOLVE_META_MODE` (restore protection for both strategy.yaml and program.md).
   f. Update `session.yaml.program`: increment version, append to history with keep_rate and reason.
      Close previous history entry's experiment range: `"<start>-<end>"`.
   g. Insert separator in `results.tsv`: `--- program v<old> -> v<new> (meta_analysis: <reason>) ---`

## Step 6.5.4a — Notable Keep 마킹

> 이 스텝은 Step 6.5.4의 program.md 수정 승인 여부와 무관하게 항상 실행한다.

현재 generation의 kept 실험 중 score_delta 기준 상위 3개를 자동으로 notable 마킹한다.

1. **Kept 실험 추출**: results.tsv에서 현재 generation 구간 (이전 outer_loop 이벤트 이후 ~ 현재)의 `kept` 행을 추출
2. **score_delta 계산**: 각 kept 실험에 대해:
   ```
   score_delta = experiment_score - previous_kept_score
   ```
   - `previous_kept_score`: 해당 실험 직전에 keep된 실험의 score
   - generation 내 첫 keep이면: generation 시작 시점의 `session.yaml.metric.current` 사용
3. **Top-3 선정**: score_delta 상위 3개 선정 (kept가 3개 미만이면 전부)
4. **Journal 기록**: 각각 journal.jsonl에 기록:
   ```json
   {"event": "notable_marked", "id": <experiment_id>, "commit": "<hash>", "description": "<idea description>", "score_delta": <value>, "source": "auto_top_n", "generation": <g>, "timestamp": "<now>"}
   ```
5. 에이전트가 추가로 전략적으로 중요한 keep을 `source: "marked"`로 마킹 가능 (optional)

## Step 6.5.5 — Strategy Keep/Discard Judgment

> **W-2 guard**: If `q_history` has fewer than 2 entries, there is no prior generation to compare against. Auto-keep the current strategy and archive it as baseline. Skip comparison logic below.

Compare Q(v_g) with Q(v_g-1). **Both generations must belong to the same `evaluation_epoch`**; if epoch changed between them, skip comparison (no valid reference point).

- **Q(v_g) > Q(v_g-1)**: **keep** — strategy changes were beneficial.
  **Strategy Archive**: Read `protocols/archive.md`, execute **Strategy Archive Save** section with result=kept.

- **Q(v_g) ≈ Q(v_g-1) (± 0.02)**: **marginal** — keep but attempt bolder changes next generation.
  Save to strategy archive (same as keep). Set a flag to increase exploration in next Tier 1 adjustment.
  Log: `{"event": "strategy_judgment", "result": "marginal", ...}`

- **Q(v_g) < Q(v_g-1) - 0.02**: **discard** — revert strategy.yaml and program.md to previous generation's versions.
  Read `protocols/archive.md`, execute **Strategy Archive Restore** from `gen_<g-1>`.
  (Requires `DEEP_EVOLVE_META_MODE=outer_loop` for the write)
  Try a different direction of modification next generation.
  Log: `{"event": "strategy_judgment", "result": "discarded", ...}`

## Step 6.5.6 — Stagnation Detection & Tier 3

Check for Outer Loop stagnation:

**3 consecutive generations without Q improvement** (check `q_history`):

→ **Strategy Archive Fork**: Read `protocols/archive.md`, execute **Strategy Archive Fork** section.

→ If strategy archive is empty (generation 0 or 1): report stagnation to user, continue.

→ Log: `{"event": "strategy_stagnation", "consecutive_no_improve": <N>, "action": "<fork|continue>", "parent_gen": <g>, "timestamp": "..."}`

**Post-fork stagnation (3 more generations without improvement after any archive fork)**:
→ **Tier 3: Automatic Prepare Expansion with Epoch Transition** — execute inline (NOT Section D):

1. **Prepare expansion**: Re-analyze the project (Stage 3 code analysis only). Generate expanded prepare.py/protocol with new scenarios or stricter criteria. Increment `session.yaml.prepare.version`.

2. **Epoch transition**:
   a. Close current epoch: finalize `session.yaml.evaluation_epoch.history[current]`
   b. Increment `evaluation_epoch.current`
   c. Create new epoch entry:
      ```yaml
      epoch: <new>
      prepare_version: <new_prepare_version>
      generations: []
      best_Q: null
      ```
   d. Re-measure baseline with expanded harness
   e. Reset `max_delta` for new epoch (Q(v) normalized_delta denominator restarts)
   f. Q(v) comparisons only valid within the new epoch going forward

3. **Record**: Insert epoch transition separator in `results.tsv`:
   `--- epoch <old> -> <new> (prepare v<old> -> v<new>, Tier 3 auto-expansion) ---`

4. Resume Inner Loop with expanded harness (back to `protocols/inner-loop.md` Step 1)

→ Return to Inner Loop (back to Step 1 in `protocols/inner-loop.md`).
