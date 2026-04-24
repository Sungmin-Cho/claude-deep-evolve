# Outer Loop — Strategy Evolution (Step 6.5)

The Outer Loop governs strategy evolution across the 3-tier hierarchy. It fires after every `outer_interval` (default 20) inner iterations, evaluating and adjusting the experimental strategy.

**Auto-trigger gate**: If `session.yaml.outer_loop.auto_trigger` is false, the caller (inner-loop.md Step 6.c) will have already asked the user before entering this protocol. If true, this protocol executes without user confirmation.

## Resume safety (v2.2.2)

Each sub-step of the Outer Loop is idempotent because it can be identified by an
existing journal event. Before executing any step, check whether the step's completion
event is already in `journal.jsonl` for the **current generation** (i.e., after the
most recent `outer_loop` event with `"generation": g-1`, if any, and `<=` the current
generation being computed).

| Step         | Completion check (idempotent-skip condition)                                                           |
|--------------|--------------------------------------------------------------------------------------------------------|
| 6.5.1        | `$SESSION_ROOT/meta-analyses/gen-<g>.md` exists                                                        |
| 6.5.1.ent    | journal has `{"event": "entropy_snapshot", "generation": g, ...}`                                      |
| 6.5.2        | journal has `{"event": "outer_loop", "generation": g, ...}`                                            |
| 6.5.3.keep   | journal has `{"event": "strategy_update", "generation": g, "reason" != "entropy_collapse_response", ...}` |
| 6.5.3.ent    | journal has `{"event": "strategy_update", "generation": g, "reason": "entropy_collapse_response", ...}` |
| 6.5.4        | `session.yaml.program.history` entry with `version >= new_version` OR                                  |
|              | journal has `{"event": "program_skip", "generation": g, ...}` (user declined)                          |
| 6.5.4a       | journal has 1+ `{"event": "notable_marked", "generation": g, ...}` (or 0 kept)                         |
| 6.5.5        | journal has `{"event": "strategy_judgment", "generation": g, ...}`                                     |
| 6.5.6        | journal has `{"event": "strategy_stagnation", ...}` OR 3 gen no improve check                          |
| 6.5.6.tier3r | journal has `{"event": "tier3_flagged_reset", "generation": g, ...}` (only after Tier 3 expansion fired in this generation) |

This removes the need for a separate `current_phase` field. resume.md Step 5 simply
routes paused sessions to outer-loop.md; this protocol self-heals by event replay.

**Step 6.5.4 program_skip event** (when user declines update in Step 6.5.4.1):
Append `{"event": "program_skip", "generation": g, "timestamp": "..."}` to mark the
phase complete without writing program.md — so resume does not re-prompt.

The 3-tier self-evolution hierarchy:
1. **Tier 1** — `strategy.yaml` parameter tuning (low freedom, quantitative adjustment)
2. **Tier 2** — `program.md` strategy text revision (medium freedom, natural language)
3. **Tier 3** — `prepare.py` scenario expansion (high freedom, raises quality ceiling)

**Guarded generation increment** (R-1 resume safety):
1. Compute `target_gen = session.yaml.outer_loop.generation + 1`.
2. Check `journal.jsonl` for any event `{"event": "outer_loop", "generation": <target_gen>}`.
   - If found → generation was already incremented in a crashed prior run. Set
     `current_gen = target_gen` and skip the increment/reset.
   - If NOT found → set `session.yaml.outer_loop.generation = target_gen`,
     `session.yaml.outer_loop.inner_count = 0` (persist).

All subsequent references to "current generation" in this protocol mean `current_gen`.

## Protocol Entry — Version Gate

Every entry to this protocol (from inner-loop.md Step 6.5 OR from resume.md's
paused-session path) MUST initialize `$VERSION` locally. Do NOT rely on shell
state inherited from the caller — Claude Code's Read tool loads a fresh context.

```bash
VERSION=$(grep '^deep_evolve_version:' "$SESSION_ROOT/session.yaml" | head -1 | sed 's/^deep_evolve_version:[[:space:]]*//; s/"//g')
```

All v3-gated sub-steps below (6.5.1 entropy snapshot, 6.5.3 entropy overlay,
6.5.6 flagged-density stagnation, Tier 3 flagged evidence injection) check
`$VERSION` locally.

## Step 6.5.0 — Epoch Boundary Sync (v3.1 only; v2 and v3.0.x skip this step)

Spec references: § 7.2 (coordinator epoch-boundary writes), § 7.5 (3-class
convergence detection), § 6.3–§ 6.4 (adaptive N re-evaluation).

This step runs at the **start** of every epoch boundary transition, BEFORE
Step 6.5.1 Meta Analysis. It is gated on `$VERSION` starting with "3.1";
v2 and v3.0.x sessions skip to 6.5.1 without executing any substeps below.

### 6.5.0.1 Forum summary generation (wires T5)

Emit `$SESSION_ROOT/meta-analyses/gen-<g>/forum-summary.md` capturing this
epoch's cross-seed activity:

```bash
HELPER_SCRIPTS_DIR="$(dirname "$DEEP_EVOLVE_HELPER_PATH")"
CURRENT_GEN=$(python3 -c "import yaml; \
  d=yaml.safe_load(open('$SESSION_ROOT/session.yaml')); \
  print(d['evaluation_epoch']['current'])")
OUT_DIR="$SESSION_ROOT/meta-analyses/gen-$CURRENT_GEN"
mkdir -p "$OUT_DIR"
if ! python3 "$HELPER_SCRIPTS_DIR/generate-forum-summary.py" \
  --forum "$SESSION_ROOT/forum.jsonl" \
  --gen "$CURRENT_GEN" \
  --out "$OUT_DIR/forum-summary.md"; then
  rc=$?
  echo "error: generate-forum-summary.py failed (rc=$rc) in epoch $CURRENT_GEN — forum-summary.md NOT written" >&2
  # Non-fatal: Step 6.5.0.2 and downstream can still proceed. Missing
  # summary is a user-visible degradation, not a coordinator abort.
fi
```

If the forum is empty (`forum.jsonl` does not exist OR contains zero
`seed_keep` events for this epoch), `generate-forum-summary.py` already
emits a placeholder `_no events recorded this epoch_` line and exits 0.
Do NOT abort the epoch transition.

### 6.5.0.2 Convergence detection (wires T19)

Compute pair-wise AI similarity among THIS EPOCH'S cross-seed `seed_keep`
events, extract `inspired_by` trailers from the kept commits, then invoke
`convergence-detect.py`:

1. **Collect this epoch's keeps** (depends on G6.5 `8752ee4` foundation
   patch that added `epoch` field to the seed_keep forum schema):
   ```bash
   EPOCH_KEEPS=$(jq -s --argjson gen "$CURRENT_GEN" \
     '[.[] | select(.event=="seed_keep" and (.epoch // null) == $gen)]' \
     "$SESSION_ROOT/forum.jsonl" 2>/dev/null || echo '[]')
   ```
   If `EPOCH_KEEPS` has fewer than 2 entries from distinct seeds, skip
   to 6.5.0.3 (no convergence possible this epoch).

   **T19 expects `experiments_used_before_keep`** per keep for P3 gating.
   Compute it from journal (count prior kept events per seed):
   ```bash
   EPOCH_KEEPS=$(printf '%s' "$EPOCH_KEEPS" | python3 -c '
   import json, sys
   keeps = json.load(sys.stdin)
   import pathlib
   journal = pathlib.Path("'"$SESSION_ROOT"'/journal.jsonl")
   events = []
   if journal.exists():
       for line in journal.read_text().splitlines():
           line = line.strip()
           if not line:
               continue
           try:
               events.append(json.loads(line))
           except Exception:
               continue
   for k in keeps:
       sid = k.get("seed_id")
       ts = k.get("ts", "")
       k["experiments_used_before_keep"] = sum(
           1 for e in events
           if e.get("event") == "kept"
           and e.get("seed_id") == sid
           and e.get("ts", "") < ts
       )
   json.dump(keeps, sys.stdout)
   ')
   ```

2. **Compute pair-wise similarity via AI**: for each unordered pair
   `(keep_a, keep_b)` where `keep_a.seed_id != keep_b.seed_id`, prompt
   yourself with the § 7.5 step 2 template:
   ```
   Compare these two kept commits' description + rationale. Return a single
   number in [0,1] representing semantic similarity (0 = unrelated,
   1 = same idea).

   Commit A (seed {a.seed_id}): {a.description}
   Rationale A: {a.rationale}

   Commit B (seed {b.seed_id}): {b.description}
   Rationale B: {b.rationale}
   ```
   Record the AI answers into a shell variable `SIMILARITIES_JSON` as a
   JSON array (bind this exact name — step 5 below consumes it). If there
   are zero eligible pairs, bind `SIMILARITIES_JSON='[]'` and skip to step 5:
   ```bash
   SIMILARITIES_JSON='[{"commit_a":"<sha_a>","commit_b":"<sha_b>","score":<float>}, ...]'
   ```

3. **Extract `inspired_by` trailers**: for each keep commit, run
   `git log -1 --format=%B <commit>` from within `$SESSION_ROOT` (git's
   parent-walk locates the project repo; the session root is always
   `<project>/.deep-evolve/<sid>/`):
   ```bash
   INSPIRED_BY_MAP='{}'
   for commit in $(printf '%s' "$EPOCH_KEEPS" | jq -r '.[].commit'); do
     trailer=$(git -C "$SESSION_ROOT" log -1 --format=%B "$commit" 2>/dev/null \
               | awk 'BEGIN{IGNORECASE=1} /^inspired[_-]by:/ {print $2; exit}')
     INSPIRED_BY_MAP=$(printf '%s' "$INSPIRED_BY_MAP" | \
       jq --arg c "$commit" --arg p "$trailer" \
       '. + { ($c): ($p | select(. != "") // null) }')
   done
   ```

4. **Collect this epoch's cross_seed_borrow events** (fallback ancestry path):
   ```bash
   CROSS_SEED_BORROWS=$(jq -s --argjson gen "$CURRENT_GEN" \
     '[.[] | select(.event=="cross_seed_borrow" and (.epoch // null) == $gen)]' \
     "$SESSION_ROOT/forum.jsonl" 2>/dev/null || echo '[]')
   ```

5. **Invoke the classifier**:
   ```bash
   if ! CLASSIFY=$(python3 "$HELPER_SCRIPTS_DIR/convergence-detect.py" \
       --args "$(jq -nc \
         --argjson keeps "$EPOCH_KEEPS" \
         --argjson sims "$SIMILARITIES_JSON" \
         --argjson ibm "$INSPIRED_BY_MAP" \
         --argjson csb "$CROSS_SEED_BORROWS" \
         --argjson epoch "$CURRENT_GEN" \
         '{keeps:$keeps, similarities:$sims, inspired_by_map:$ibm,
           cross_seed_borrow_events:$csb, threshold:0.85, p3_floor:3,
           epoch:$epoch}')"); then
     rc=$?
     echo "error: convergence-detect.py failed (rc=$rc) in epoch $CURRENT_GEN — skipping 6.5.0.2 this epoch" >&2
     # rc=2 operator/schema error or rc=1 business failure: do NOT emit
     # any convergence_event this epoch. Coordinator proceeds to 6.5.0.3
     # (N re-eval) with empty convergence signal. This preserves progress
     # without masking the fact that classification failed — the stderr
     # line is load-bearing for operator debugging.
     CLASSIFY='{"convergence_events": []}'
   fi
   ```

6. **Emit each convergence_event** to BOTH journal and forum per spec § 7.2.
   Wrap the writes in `(unset SEED_ID; ...)` subshells — the coordinator
   runs in the main session shell, where SEED_ID MUST NOT leak into
   coordinator-owned events. T16's `cmd_append_journal_event` auto-injects
   `seed_id` from `$SEED_ID` if set, which would corrupt the
   `convergence_event` payload (plural `seed_ids: [...]` array schema +
   a spurious scalar `seed_id` field):
   ```bash
   printf '%s' "$CLASSIFY" | jq -c '.convergence_events[]' | while read -r ev; do
     (unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" append_journal_event "$ev")
     (unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" append_forum_event "$ev")
   done
   ```

   The events are also automatically surfaced inside `forum-summary.md`:
   T5 re-reads `forum.jsonl` and includes any convergence events that
   landed during Step 6.5.0.1 or 6.5.0.2. (If a convergence event fires
   AFTER 6.5.0.1 ran, the summary won't include it this epoch — it'll
   appear in next epoch's summary. Acceptable drift for a per-epoch
   artifact.)

### 6.5.0.3 N re-evaluation (adaptive hook; § 6.3)

After convergence processing, ask the Adaptive Scheduler whether N should
change for the NEXT epoch. This is AI-judged; the output feeds
`session.yaml.virtual_parallel.n_current` via an `n_adjusted` event.

Prompt yourself:
```
Current N: {session.yaml.virtual_parallel.n_current}
Budget remaining: {signals.budget_unallocated + sum(seed.remaining_budget)}
Convergence events this epoch: {count by judged_as}
Active seeds: {count where status == "active"}
Killed seeds: {count where status.startswith("killed_")}

Should N change for the next epoch?
  - Keep current N: if exploration diversity remains high and budget sustains
  - Grow N (if budget_unallocated + kill-freed budget >= budget_total / n_current):
    justified when no convergence or only contagion_suspected
  - Shrink N via kill: justified when budget tight + multiple seeds stuck

Return JSON: {"decision": "keep|grow|shrink", "new_n": <int>, "reasoning": "..."}
```

If decision is `keep`, continue to Step 6.5.1. Otherwise append (wrap in
`(unset SEED_ID; ...)` — same coordinator-context reasoning as 6.5.0.2 step 6):
```bash
(unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" append_journal_event '{
  "event":"n_adjusted","from_n":<old>,"to_n":<new>,
  "reason":"<AI reasoning>","new_seed_ids":[...]
}')
```
then execute the seed creation (grow — invoke `session-helper.sh
create_seed_worktree` plus β generator from T7) or kill (shrink — emit
`seed_killed` per § 5.5 `budget_exhausted_underperform` heuristic).

**Note on n-adjust validation**: Step 6.5.0 does NOT add a dedicated
`n-adjust-preflight.py` helper. Rationale: the AI answering the prompt
already sees budget_remaining + n_current + seed counts; rejecting invalid
decisions (grow when budget insufficient, shrink below min) is enforced at
the prompt level via explicit constraints. If budget reality differs from
the AI's judgment, the grow path's existing `compute_grow_allocation`
helper (T3) returns rc=1 "insufficient pool" and the coordinator logs
`grow_rejected_insufficient_pool` without creating a seed — the hard guard
sits downstream. Defer a dedicated preflight to v3.1.1 if this proves
insufficient in practice.

### 6.5.0 Summary / Gate

After 6.5.0.1, 6.5.0.2, and 6.5.0.3 complete, proceed to Step 6.5.1. Note
that 6.5.1–6.5.6 continue to operate on the SESSION's Q metric (not per-seed),
so the existing Outer Loop logic still applies; G6/G7 additions only WIDEN
the signal set, they do not replace it.

**v2 and v3.0.x sessions: skip Step 6.5.0 entirely.** The version gate at
the top of this protocol (see § "Protocol Entry — Version Gate") routes
non-v3.1 sessions directly to Step 6.5.1 without executing any substep above.

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

### 6.5.1 (v3 addendum) — Entropy Snapshot

IF $VERSION starts with "3.":
- Check journal for an existing `entropy_snapshot` event with the current
  generation's `g` value. If present, skip (idempotent).
- Otherwise, invoke:

```bash
# Extract window_size from strategy.yaml using grep/sed (matches existing
# deep_evolve_version extraction pattern from Task 9 Step 1; no yq dependency).
window_size=$(grep -A 10 "^entropy_tracking:" "$SESSION_ROOT/strategy.yaml" | \
  grep '^\s*window_size:' | head -1 | sed 's/.*:[[:space:]]*//; s/\s*$//')
# Default to 20 if the field is missing or empty.
[[ -z "$window_size" ]] && window_size=20

result=$(bash "$CLAUDE_PLUGIN_ROOT/hooks/scripts/session-helper.sh" entropy_compute \
  "$SESSION_ROOT/journal.jsonl" "$window_size")
H=$(echo "$result" | jq -r '.entropy_bits')
K=$(echo "$result" | jq -r '.active_categories')
```

- Append to journal:
  `{"event": "entropy_snapshot", "generation": <g>, "entropy_bits": <H or null>, "active_categories": <K>, "timestamp": "..."}`
- IF `H` is not null AND `H < strategy.entropy_tracking.collapse_threshold_bits`:
  - Append: `{"event": "entropy_collapse", "generation": <g>, "entropy_bits": <H>, "threshold": <T>, "timestamp": "..."}`
  - Update `session.yaml.entropy.last_collapse_generation = <g>`

ELSE (v2): skip.

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

### 6.5.3 (v3 addendum) — Entropy Overlay

IF $VERSION starts with "3." AND the most recent `entropy_snapshot` event shows
`entropy_bits < strategy.entropy_tracking.collapse_threshold_bits`:

Apply AFTER the keep-rate adjustment above, AFTER the weights are intermediate
but BEFORE final renormalize:

1. Identify underexplored categories: `{c for c in CATEGORIES if dist[c] == 0 or dist[c] < 0.05}`
   where `dist` is the distribution of `idea_category` over the current
   generation's `planned` events.
2. For each underexplored `c`: `weights[c] = max(weights[c], 0.08)` (floor up).
3. Identify top-3 explored categories by `dist[c]`. For each: `weights[c] *= 0.9`.
4. Renormalize once: `weights[c] /= sum(weights.values())` for all c.
5. Append `strategy_update` journal event with **both** `generation: g` AND
   `reason: "entropy_collapse_response"` — the two-field identity is the
   idempotency key (see outer-loop.md Resume table row `6.5.3.ent`). Before
   appending, check journal for an existing event matching both fields; skip
   if found.

The keep-rate adjustment touches categories with data; the overlay touches
categories without data — disjoint sets. Single final renormalize avoids
cross-coupling drift.

ELSE: skip.

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
   - `previous_kept_score`: results.tsv에서 해당 실험 직전에 keep된 실험의 score 값
   - generation 내 첫 keep이면: results.tsv에서 현재 generation 구간 시작 직전의 마지막 kept 행의 score 사용 (generation 시작 전 score를 반영. `session.yaml.metric.current`는 inner-loop에서 매 keep마다 갱신되므로 사용하지 않는다)
3. **Top-3 선정**: score_delta 상위 3개 선정 (kept가 3개 미만이면 전부)
4. **Journal 기록**: 각각 journal.jsonl에 기록:
   ```json
   {"event": "notable_marked", "id": <experiment_id>, "commit": "<hash>", "description": "<idea description>", "score_delta": <value>, "source": "auto_top_n", "generation": <g>, "timestamp": "<now>"}
   ```
5. 에이전트가 추가로 전략적으로 중요한 keep을 `source: "marked"`로 마킹 가능 (optional)

## Step 6.5.5 — Strategy Keep/Discard Judgment

> **W-2 guard**: If `q_history` has fewer than 2 entries, there is no prior generation to compare against. Auto-keep the current strategy and archive it as baseline. Skip comparison logic below.

Compare Q(v_g) with Q(v_g-1). **Both generations must belong to the same `evaluation_epoch`**.

**Epoch transition handling (H-2 fix)**: If the previous generation belongs to a
different `evaluation_epoch` (e.g., Tier 3 auto-expansion just advanced the epoch),
treat the current generation as the new epoch's baseline:
- **Auto-keep** the current strategy
- **Strategy Archive Save** with `parent: null` and `epoch: <new>` (baseline for
  comparisons in this epoch)
- Log: `{"event": "strategy_judgment", "result": "epoch_baseline", "epoch": <new>,
  "Q": <value>, "timestamp": "..."}`
- Skip the Q comparison cases below.

**Same-epoch comparison**:

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

**Stagnation triggers (v3 extended)**:

IF $VERSION starts with "3.":
  stagnation fires if ANY of:
  - 3 consecutive generations without Q improvement   (existing)
  - `session.shortcut.flagged_since_last_tier3 >= strategy.shortcut_detection.tier3_flagged_threshold`
    (sustained flagged density since the last Tier 3 — prevents perpetual re-fire
    by using a counter that resets, not the lifetime `total_flagged`)
ELSE (v2):
  stagnation fires only on the 3-consecutive-no-improve criterion.

(Check `q_history` and, when on v3, also `session.shortcut.flagged_since_last_tier3`.)

→ **Strategy Archive Fork**: Read `protocols/archive.md`, execute **Strategy Archive Fork** section.

→ If strategy archive is empty (generation 0 or 1): report stagnation to user, continue.

→ Log: `{"event": "strategy_stagnation", "consecutive_no_improve": <N>, "action": "<fork|continue>", "parent_gen": <g>, "timestamp": "..."}`

**Post-fork stagnation (3 more generations without improvement after any archive fork)**:
→ **Tier 3: Automatic Prepare Expansion with Epoch Transition** — execute inline (NOT Section D):

1. **Prepare expansion** (v3 extension — flagged evidence injection):

   IF $VERSION starts with "3." AND `session.shortcut.total_flagged > 0`:
     Collect flagged evidence:
     ```python
     flagged_events = journal.select(event=="shortcut_flagged")
     evidence = []
     for evt in flagged_events:
         try:
             diff = run(["git", "show", "--stat", "--patch", evt.commit,
                         "--", *target_files], check=True).stdout
             source = "git_show"
         except (CalledProcessError, FileNotFoundError):
             diff = None
             source = "journal_only"
         evidence.append({
             "commit": evt.commit,
             "diff": diff[:2048] if diff else None,
             "description": evt.description,
             "score_jump": evt.score_delta,
             "loc_delta": evt.loc_delta,
             "source": source,
         })
     ```

     Append the evidence to the LLM prompt used for re-generating prepare.py /
     prepare-protocol.md as a suffix:
     ```
     This session flagged N suspicious score jumps. The new evaluation
     harness MUST include adversarial scenarios that catch these patterns.
     For each pattern below (diff may be null if source=journal_only — infer
     from description + score_jump + loc_delta), design a held-out case that
     breaks the shortcut if the target code relied on it:
       {evidence}
     ```

   Then re-analyze the project (Stage 3 code analysis only) and generate the
   expanded prepare.py/protocol as before. Increment `session.yaml.prepare.version`.

   **Protection bypass**: Before writing the updated prepare.py / prepare-protocol.md,
   set `DEEP_EVOLVE_META_MODE=prepare_update` so the PreToolUse hook allows the
   Write; unset after. Required for the same reason documented in inner-loop.md
   Section D — `$PROTECTED_PREPARE` / `$PROTECTED_PROTOCOL` are otherwise blocked
   while session status is `active`.

   **After Tier 3 expansion completes**, reset
   `session.shortcut.flagged_since_last_tier3 = 0`. Append:
   `{"event": "tier3_flagged_reset", "generation": <g>, "timestamp": "..."}`

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
