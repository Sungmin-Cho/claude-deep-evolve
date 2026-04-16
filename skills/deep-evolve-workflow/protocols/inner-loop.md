# Inner Loop — Experiment Cycle (Section B + C Steps 1-6)

## Section B: Resume Flow

Read `session.yaml` and `results.tsv`.

Display progress summary:
```
Deep Evolve 세션 재개
━━━━━━━━━━━━━━━━━━━━
목표: <goal>
평가 모드: <eval_mode> (<tool/command info>)
실험: <total>회 완료 (keep <kept>, discard <discarded>, crash <crashed>)
Score: <baseline> → <current> (best: <best>)
평가 harness: v<version> (<scenarios/steps count>)
```

If `REQUESTED_COUNT` is set:
- Update `session.yaml.experiments.requested` to current total + REQUESTED_COUNT
- → Go to **Loop** below

Otherwise, ask via AskUserQuestion:
Options:
- "이어서 실험 (30회 추가)"
- "이어서 실험 (50회 추가)"
- "평가 harness 확장 (더 어려운 시나리오/단계 추가)" → Go to **Section D: Prepare Expansion** (below)
- "완료 처리" → Read `protocols/completion.md`

## Section C: Experiment Loop

Read `session.yaml` for configuration. Read `.deep-evolve/strategy.yaml` for strategy parameters.
Read `results.tsv` and `journal.jsonl` for history.

Set `experiment_count` to 0. Set `max_count` to `session.yaml.experiments.requested` (or infinity if null).
Set `inner_count` to `session.yaml.outer_loop.inner_count` (0 for new sessions, restored value for resume).
Set `outer_interval` to `session.yaml.outer_loop.interval` (default 20).

### Branch & Clean-Tree Guard

Before ANY experiment work, verify safety preconditions. This check runs:
- Once at loop start
- Before EVERY `git reset --hard HEAD~1`

```
SAFETY CHECK:
1. Verify current branch matches expected branch:
   CURRENT=$(git branch --show-current)
   EXPECTED = session.yaml.lineage.current_branch (if set) OR session.yaml.git_branch
   if CURRENT != EXPECTED → ABORT with error:
   "⛔ Branch mismatch: expected <expected>, on <current>. /deep-evolve에서 세션을 확인하세요."

2. Verify worktree is clean (excluding .deep-evolve/):
   DIRTY=$(git status --porcelain | grep -v '^\?\? .deep-evolve/')
   if DIRTY is not empty → ABORT with error:
   "⛔ Dirty worktree detected. 실험을 시작하기 전에 uncommitted 변경을 커밋하거나 stash하세요."
```

### Resume Reconciliation

Before starting, check last entry in `journal.jsonl`:
- If last status is `planned` → discard that plan, start fresh
- If last status is `committed` → run evaluation (cli: harness_command / protocol: evaluation steps), continue from evaluation
- If last status is `evaluated` → apply judgment (compare score), continue
- If last status is `kept` → fully resolved, start fresh experiment
- If last status is `discarded` → check if rollback was completed:
  - Look for subsequent `{"id": <same_id>, "status": "rollback_completed"}` entry
  - If NO rollback_completed entry exists:
    → Run Branch & Clean-Tree Guard
    → Verify HEAD commit matches the journal's `commit` field
    → If match: execute `git reset --hard HEAD~1`, then append `{"id": <id>, "status": "rollback_completed"}`
    → If no match: HEAD was already reset (manual intervention), append `rollback_completed`
  - If rollback_completed exists → fully resolved, start fresh experiment

### Loop

Repeat until `experiment_count >= max_count` or diminishing returns detected:

**Step 1 — Idea Selection** (uses `strategy.yaml` parameters):
- Read `results.tsv` to learn from previous keep/discard history
- Read current state of all target_files
- Read `program.md` for experiment strategy guidelines
- Read `strategy.yaml` for idea selection parameters:
  - `idea_selection.method`: how to weight idea categories (weighted/random/sequential)
  - `idea_selection.weights`: category probability distribution
  - `idea_selection.min_novelty_distance`: skip ideas similar to last N attempts
- Avoid approaches that were previously discarded (check description column in results.tsv)
- Generate `candidates_per_step` (from strategy.yaml, default 3) candidate ideas
- For each candidate, analyze: expected improvement, risk (crash/regression likelihood), novelty vs recent attempts
- Select the BEST candidate based on this analysis
- Append to `journal.jsonl`: `{"id": <next_id>, "status": "planned", "idea": "<description>", "candidates_considered": <N>, "timestamp": "<now>"}`

**Step 2 — Code Modification:**
- Modify ONLY files listed in `session.yaml.target_files`
- Apply one idea per modification

**Step 3 — Git Commit:**
```bash
git add <target_files>
git commit -m "experiment: <idea description>"
```
- Get commit hash: `COMMIT=$(git rev-parse --short HEAD)`
- Append to `journal.jsonl`: `{"id": <id>, "status": "committed", "commit": "<COMMIT>", "timestamp": "<now>"}`

**Step 4 — Evaluation:**

**If eval_mode is `cli`:**
- Run: `<harness_command> > .deep-evolve/runs/run-<NNN>.log 2>&1`
- Parse score from output (grep for `^score:` line)

**If eval_mode is `protocol`:**
- Read `.deep-evolve/prepare-protocol.md` for the fixed evaluation steps
- Execute each step using the specified tools (MCP, browser, etc.)
- Record all tool outputs to `.deep-evolve/runs/run-<NNN>.log`
- Compute score using the protocol's formula
- IMPORTANT: Follow the protocol EXACTLY as written. Do not deviate, skip steps, or "improve" the evaluation. The protocol is the ground truth — same as prepare.py in cli mode.

- Append to `journal.jsonl`: `{"id": <id>, "status": "evaluated", "score": <score>, "timestamp": "<now>"}`

**Step 5 — Judgment:**

Compare `score` with `session.yaml.metric.current`:

**Scoring contract: prepare.py / prepare-protocol.md는 항상 higher-is-better score를 출력합니다.**

minimize 메트릭의 반전은 evaluation harness 내부에서 처리됩니다.
- cli 모드: prepare.py가 minimize 메트릭에 `score = BASELINE_SCORE / raw_score` 변환 적용 (baseline=1.0, 개선 시 >1.0, 악화 시 <1.0 — clamp 없음, 1.0 초과 허용)
- protocol 모드: prepare-protocol.md가 동일한 변환 적용

judgment는 항상 단일 규칙을 따릅니다: **score_new > score_old + min_delta → keep**

**If score_new > score_old + min_delta** (where `min_delta` = `strategy.yaml.judgment.min_delta`, default 0.001):
- Append to `journal.jsonl`: `{"id": <id>, "status": "kept", "timestamp": "<now>"}`
- Append to `results.tsv`: `<COMMIT>\t<score>\tkept\t<idea description>`
- Update `session.yaml`: `metric.current = score`, `metric.best = max(best, score)`, increment `experiments.total` and `experiments.kept`
- **Code Archive**: Record the kept commit in `.deep-evolve/code-archive/`:
  Create or update `keep_<NNN>/` with:
  ```yaml
  commit: <COMMIT>
  score: <score>
  description: "<idea description>"
  children_explored: 0
  branch: "<session.yaml.lineage.current_branch>"
  ```

**If score same or worse:**
- Append to `journal.jsonl`: `{"id": <id>, "status": "discarded", "timestamp": "<now>"}`
- Append to `results.tsv`: `<COMMIT>\t<score>\tdiscarded\t<idea description>`
- Update `session.yaml`: increment `experiments.total` and `experiments.discarded`
- Run **Branch & Clean-Tree Guard** (verify branch + clean worktree)
- Run: `git reset --hard HEAD~1`
- Append to `journal.jsonl`: `{"id": <id>, "status": "rollback_completed", "timestamp": "<now>"}`

**If evaluation crashed:**
- Attempt a simple fix (1 attempt only)
- If fix works, re-evaluate
- If fix fails:
  - Append to `journal.jsonl`: `{"id": <id>, "status": "discarded", "reason": "crash", "timestamp": "<now>"}`
  - Append to `results.tsv`: `<COMMIT>\t0\tcrash\t<idea description>`
  - Update `session.yaml`: increment `experiments.total` and `experiments.crashed`
  - Run **Branch & Clean-Tree Guard** (verify branch + clean worktree)
  - Run: `git reset --hard HEAD~1`
  - Append to `journal.jsonl`: `{"id": <id>, "status": "rollback_completed", "timestamp": "<now>"}`

Increment `experiment_count`.

**Step 6 — Continuation Check** (uses `strategy.yaml.convergence` parameters):

**6.a** Increment `inner_count`. Persist: update `session.yaml.outer_loop.inner_count` to the new value.

**6.b** Check for **interval-based Outer Loop trigger**:
If `inner_count >= outer_interval`:
  If `session.yaml.outer_loop.auto_trigger` is **false**: AskUserQuestion "주기적 Outer Loop 실행할까요?" → "실행" / "건너뛰기"
  If approved (or auto_trigger=true): execute Step 6.5.
  After Step 6.5 returns, continue to 6.c (diminishing returns may still apply within same check).

**6.c** Check for diminishing returns using strategy.yaml thresholds:
- 0 keeps in last `consecutive_discard_limit` (default 10) → report: "<N>회 연속 discard. Score가 수렴한 것 같습니다."
- keeps exist but max score delta < `min_delta` in last `plateau_window` (default 15) → report: "개선폭이 미미합니다."
- `crash_tolerance`+ crashes in last 10 → report: "안정성 문제가 감지되었습니다."

If any diminishing-returns signal triggered:

  First, check **Code Archive Backtrack**: If `strategy.yaml.convergence.plateau_action` is `"branch"` AND `strategy.yaml.exploration.backtrack_enabled` is true AND code-archive has eligible entries:
  → Execute backtrack (Read `protocols/archive.md`). Then proceed to Outer Loop below.

  If backtrack not applicable (disabled or no eligible entries), proceed directly to Outer Loop:

  If `session.yaml.outer_loop.auto_trigger` is **true** (default):
  → **IMMEDIATELY** run Step 6.5 (Outer Loop Evaluation). Do NOT AskUserQuestion before Outer Loop completes.

  If `session.yaml.outer_loop.auto_trigger` is **false**:
  → AskUserQuestion first: "diminishing returns 감지됨. Outer Loop를 실행할까요?"
    - "실행" → Step 6.5
    - "건너뛰기" → Step 6.d로 이동

**6.d** Continuation decision:

  If Outer Loop was NOT run (no trigger in 6.b or 6.c):
  → auto-continue to Step 1.

  If Outer Loop ran:
  - Q(v) improved and no convergence flag → auto-continue to Step 1
  - Q(v) degraded or session-level stop criteria met → AskUserQuestion:
    Options:
    - "계속 (N회 추가)"
    - "평가 harness 확장 (더 어려운 시나리오/단계 추가)" → Go to **Section D: Prepare Expansion** (below)
    - "여기서 완료" → Read `protocols/completion.md`

**Step 6.5 — Outer Loop Evaluation** (triggers: `inner_count >= outer_interval` OR diminishing returns detected in Step 6):

Approval has already been resolved by the caller (Step 6.b or 6.c). Execute without additional confirmation.

→ Read `protocols/outer-loop.md`, execute Outer Loop.

If `experiment_count >= max_count`:
→ Read `protocols/completion.md`

Otherwise: → Back to Step 1

## Section D: Prepare Expansion

**If eval_mode is `cli`:**
1. Read current `.deep-evolve/prepare.py`
2. Re-analyze the project (Stage 3 only — code has changed since last analysis)
3. Identify new scenarios or harder test cases based on:
   - Areas where score plateaued
   - Patterns in discarded experiments
   - Code regions not covered by current scenarios
4. Generate updated `prepare.py` with new scenarios
5. Increment `session.yaml.prepare.version`
6. Append to `session.yaml.prepare.history`: `{version, scenarios, reason}`
7. Insert separator in `results.tsv`: `--- prepare v<old> -> v<new> (<old_count>-><new_count> scenarios) ---`
8. Run new baseline with expanded prepare.py
9. → Resume Loop

**If eval_mode is `protocol`:**
1. Read current `.deep-evolve/prepare-protocol.md`
2. Re-analyze the project (Stage 3 only — code has changed since last analysis)
3. Identify new evaluation steps or stricter criteria based on:
   - Areas where score plateaued
   - Patterns in discarded experiments
   - Aspects not covered by current protocol steps
4. Generate updated `prepare-protocol.md` with expanded evaluation
5. Increment `session.yaml.prepare.version`
6. Append to `session.yaml.prepare.history`: `{version, steps, reason}`
7. Insert separator in `results.tsv`: `--- prepare v<old> -> v<new> (<old_steps>-><new_steps> steps) ---`
8. Run new baseline with expanded protocol
9. → Resume Loop
