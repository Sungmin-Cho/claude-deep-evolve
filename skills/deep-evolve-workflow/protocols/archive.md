# Archive Management — Code & Strategy Archives

## Code Archive Backtrack

Fork from a previous keep commit when plateau is detected in Inner Loop.

1. Read `$SESSION_ROOT/code-archive/` to find all keep entries with their `children_explored` counts.
2. Compute backtrack score for each keep entry:
   ```
   backtrack_score(keep) = score × exp(-(children_explored / 6)^3)
   ```
   Selection by `strategy.yaml.exploration.backtrack_strategy`:
   - `"least_explored"`: lowest `children_explored` first
   - `"highest_score"`: highest `score` (with `children_explored` penalty applied)
   - `"random"`: probabilistic (proportional to `backtrack_score`)

3. Fork from selected commit using **named branch** (never use tag checkout — avoids detached HEAD):
   ```bash
   git checkout -b evolve/<session-id>/fork-<NNN> <selected_commit>
   ```

4. Update session.yaml lineage:
   ```yaml
   lineage:
     current_branch: "evolve/<session-id>/fork-<NNN>"
     forked_from:
       commit: <selected_commit>
       keep_id: "keep_<NNN>"
       reason: "plateau detected after <N> consecutive discards"
     previous_branches:
       - "<previous branch>"
   ```

5. Increment `children_explored` for the selected keep entry in code-archive.

6. Record in journal.jsonl:
   `{"event": "branch_fork", "from_commit": "<commit>", "to_branch": "evolve/<session-id>/fork-<NNN>", "reason": "plateau", "timestamp": "..."}`

7. Add context to program.md (via META_MODE): "이 지점에서 이전에 <previous directions>을 시도했으나 정체됨. 다른 접근법을 시도하라."

8. Reset diminishing returns counters and continue Inner Loop from Step 1.

## Strategy Archive Save

Save a generation snapshot to `$SESSION_ROOT/strategy-archive/gen_<g>/`:
```
strategy.yaml          — current strategy.yaml copy
program.md.snapshot    — current program.md copy
metrics.json           — {"Q": <value>, "keep_rate": <v>, "experiments": "<range>",
                          "epoch": <e>, "parent": "gen_<g-1>", "children_count": 0}
```
Log: `{"event": "strategy_judgment", "result": "kept", "Q_old": <v>, "Q_new": <v>, "timestamp": "..."}`

## Strategy Archive Restore

Revert strategy.yaml and program.md to a previous generation's versions:

1. Set `DEEP_EVOLVE_META_MODE=outer_loop` (allows writes past protect-readonly hook).
2. Copy `strategy.yaml` from `$SESSION_ROOT/strategy-archive/gen_<target>/strategy.yaml` → `$SESSION_ROOT/strategy.yaml`
3. Copy `program.md.snapshot` from `$SESSION_ROOT/strategy-archive/gen_<target>/program.md.snapshot` → `$SESSION_ROOT/program.md`
4. Unset `DEEP_EVOLVE_META_MODE`.

## Strategy Archive Fork

Select a parent generation from `$SESSION_ROOT/strategy-archive/` and fork when 3 consecutive generations show no Q improvement:

1. Collect all archived generations' Q(v) and `children_count` (same epoch only).
2. Compute candidate score for each:
   ```
   candidate_score(gen) = Q(v_gen) × exp(-(children_count / 4)^3)
   ```
   - `children_count=0` → penalty=1.0 (unexplored, highest priority)
   - `children_count=4` → penalty≈0.37 (sufficiently explored)
   - `children_count=8` → penalty≈0 (over-explored)

3. Select generation with highest `candidate_score` as parent.

4. Restore parent's strategy.yaml + program.md from archive (via **Strategy Archive Restore** above).

5. Increment parent's `children_count` in archive.

6. Generate a **different** direction of variation:
   - Read parent's meta analysis reasoning
   - Check what directions children already tried (diff archived children)
   - Choose an untried direction for the next Tier 1/2 adjustments

→ Return to Outer Loop caller.
