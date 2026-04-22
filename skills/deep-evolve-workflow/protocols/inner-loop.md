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

> **$SESSION_ID / $SESSION_ROOT resolution**: The dispatcher or `resume.md` has already
> resolved the active session via `session-helper.sh resolve_current`. Its output is a
> tab-separated line `<session_id>\t<session_root>`. Bind both:
>
> ```bash
> read -r SESSION_ID SESSION_ROOT < <(session-helper.sh resolve_current)
> ```
>
> All `.deep-evolve/` paths in this protocol refer to `$SESSION_ROOT/`. Use `$SESSION_ID`
> for any `session-helper.sh` subcommand that takes a session id argument
> (e.g., `mark_session_status`, `append_sessions_jsonl`).

### v3 Version Gate

Before entering the loop, read the session's deep_evolve_version:

```bash
VERSION=$(grep '^deep_evolve_version:' "$SESSION_ROOT/session.yaml" | head -1 | sed 's/^deep_evolve_version:[[:space:]]*//; s/"//g')
```

All v3-gated sub-steps below check `$VERSION`. If `$VERSION` starts with `"3."` (i.e., `3.0.0` or later), execute the v3 sub-step; otherwise skip it (v2 behavior preserved).

### v3 Environment Propagation (only when $VERSION starts with "3.")

IF $VERSION starts with "3.":

```bash
seal_flag=$(grep -A 10 "^shortcut_detection:" "$SESSION_ROOT/strategy.yaml" | grep '^\s*seal_prepare_read:' | head -1 | sed 's/.*:[[:space:]]*//; s/\s*$//')
if [[ "$seal_flag" == "true" ]]; then
  export DEEP_EVOLVE_SEAL_PREPARE=1
else
  # Deterministic clear — prevents cross-session leak if a prior session's
  # export persisted in the parent Claude Code process environment.
  unset DEEP_EVOLVE_SEAL_PREPARE
fi
```

The export/unset pair runs on every inner-loop entry (including resumes), so
one session enabling the seal cannot poison a later session that disabled it.
ELSE (v2): always `unset DEEP_EVOLVE_SEAL_PREPARE` (v2 has no seal concept).

Read `session.yaml` for configuration. Read `$SESSION_ROOT/strategy.yaml` for strategy parameters.
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

2. Verify worktree is clean, allowing only `.deep-evolve/` untracked (R-3 fix):
   ```bash
   DIRTY=$(git status --porcelain | awk '$1 != "??" || $2 !~ /^\.deep-evolve\//')
   ```
   If `$DIRTY` is non-empty → ABORT with error:
   "⛔ Dirty worktree detected. 실험을 시작하기 전에 uncommitted 변경을 커밋하거나 stash하세요."

   Rationale: `git reset --hard HEAD~1` only rolls back tracked changes, but untracked
   user files in the worktree could silently influence evaluation output (e.g., a stray
   config file). Only `.deep-evolve/` (session state, gitignored) is exempt.
```

### Resume Reconciliation

Before starting, check last entry in `journal.jsonl`:
- If last status is `planned` → discard that plan, start fresh
- If last status is `committed` → run evaluation (cli: harness_command / protocol: evaluation steps), continue from evaluation
- If last status is `evaluated` → apply judgment (compare score), continue
- If last status is `kept` → fully resolved, start fresh experiment
- If last status is `discarded` → check if rollback was completed:
  - Look for subsequent `{"id": <same_id>, "status": "rollback_completed"}` entry
  - If rollback_completed exists → fully resolved, start fresh experiment
  - If NO rollback_completed entry exists:
    → Run Branch & Clean-Tree Guard
    → Read `journal_commit` (the `commit` field of the discarded entry). It may be a
       full 40-char SHA (v2.2.2+) or a 7-12 char short SHA (legacy v2.2.1 or earlier).
    → Resolve `journal_commit` to a canonical full SHA (R-2 legacy compat):
       ```bash
       if [ "${#journal_commit}" -ge 40 ]; then
         canonical=$journal_commit
       else
         canonical=$(git rev-parse "$journal_commit" 2>/dev/null) || canonical=""
       fi
       ```
    → If `canonical` is empty, the commit no longer exists (pruned / force-pushed) →
       append `rollback_completed` with `"note": "commit unresolvable"` and skip reset.
    → Compare `git rev-parse HEAD` with `canonical`:
       - **Exact match** → run `git reset --hard HEAD~1`, append `rollback_completed`.
       - **No match** → run `git merge-base --is-ancestor "$canonical" HEAD`:
         - **exit 0 (ancestor=true)** — journal commit is still in HEAD's ancestry, an
           unrelated commit sits on top. R-4 fix: rollback IS possible but not via
           `HEAD~1`. AskUserQuestion: "실험 커밋 <short>이 HEAD 계보에 남아있고 그 위에
           다른 커밋이 쌓여 있습니다." Options:
             - "자동 reset (위 커밋 삭제)" → `git reset --hard "$canonical^"` then
               `rollback_completed`
             - "수동 처리" → abort
         - **exit 1 (ancestor=false)** — commit is not in HEAD's history at all → already
           rolled back (or branch-switched) → append `rollback_completed` with
           `"note": "already removed from HEAD ancestry"`.

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

**Step 1.5 — Category Tagging (v3 only):**

**Ordering invariant (v3)**: the `planned` journal event MUST be appended AFTER
category tagging completes, not before. This preserves the append-only invariant
that the entire idempotent-resume mechanism depends on. For v3 sessions, the
final append line of Step 1 is **deferred** until Step 1.5 has assigned a
category; v2 sessions append immediately as before.

Concretely for v3:
- After ranking `candidates_per_step` candidates in Step 1, do NOT yet append
  the `planned` event — continue to Step 1.5.
- Read `protocols/taxonomy.md` for the 10-category list.
- Classify each ranked candidate into one of the 10 categories; unclassifiable → `other`.
- From the ranked list, select the highest-ranked candidate whose category
  differs from every `planned` event in the last
  `strategy.yaml.idea_selection.min_novelty_distance` attempts.
- If no candidate clears the category filter, pick the highest-ranked candidate
  regardless (soft-fail with a warning — forward progress guaranteed).
- Compute `idea_category = <selected>`.
- THEN append the `planned` event with `idea_category` included from the start:
  `{id, status:"planned", idea, idea_category, timestamp}`

For v2 sessions: skip Step 1.5 entirely and use the existing Step 1 flow (append
`planned` event without `idea_category`).

No journal rewrite ever happens — the `idea_category` field is present on first
write or not at all.

**Step 2 — Code Modification:**
- Modify ONLY files listed in `session.yaml.target_files`
- Apply one idea per modification

**Step 3 — Git Commit:**
```bash
git add <target_files>
git commit -m "experiment: <idea description>"
```
- Get commit hash: `COMMIT=$(git rev-parse HEAD)` (full 40-char SHA — C-6)
- Append to `journal.jsonl`: `{"id": <id>, "status": "committed", "commit": "<COMMIT>", "timestamp": "<now>"}`

**Step 4 — Evaluation:**

**If eval_mode is `cli`:**
- Run: `<harness_command> > $SESSION_ROOT/runs/run-<NNN>.log 2>&1`
- Parse score from output (grep for `^score:` line)

**If eval_mode is `protocol`:**
- Read `$SESSION_ROOT/prepare-protocol.md` for the fixed evaluation steps
- Execute each step using the specified tools (MCP, browser, etc.)
- Record all tool outputs to `$SESSION_ROOT/runs/run-<NNN>.log`
- Compute score using the protocol's formula
- IMPORTANT: Follow the protocol EXACTLY as written. Do not deviate, skip steps, or "improve" the evaluation. The protocol is the ground truth — same as prepare.py in cli mode.

- Append to `journal.jsonl`: `{"id": <id>, "status": "evaluated", "score": <score>, "timestamp": "<now>"}`

**Step 4.5 — Delta Measurement (v3 only):**

IF $VERSION starts with "3.":
- Compute `score_delta = score - (last kept score OR session.yaml.metric.baseline)`
- Compute `loc_delta = abs(added + deleted)` over target_files only:

```bash
loc_delta=$(git diff --numstat HEAD~1..HEAD -- <target_file_1> <target_file_2> ... |
  awk '{ a+=$1; d+=$2 } END { print a+d }')
```

- Amend the `evaluated` event with both fields (produce a single `evaluated` event
  that carries `score_delta` + `loc_delta` on first write — do NOT rewrite a
  prior event; Step 4's v3 path emits the evaluated event AFTER these deltas are
  computed, just as Step 1.5 defers the planned event).

**Reference-point contract after diagnose-retry**: when a retry via 5.a produces a
new commit SHA_B (the original SHA_A was reset), `HEAD~1` for SHA_B is the
pre-experiment baseline, not SHA_A. Therefore `loc_delta` on SHA_B measures the
retry's total diff against the pre-experiment state — which is the correct
"experiment-level" diff under the one-experiment-one-commit invariant.

ELSE (v2): skip this step.

**Step 5 — Judgment:**

IF $VERSION starts with "3.":

  **Step 5.a — Crash/Severe-drop Diagnose Gate**:

  Trigger conditions (any): crashed flag set by Step 4; OR
  `score < session.yaml.metric.baseline - strategy.yaml.judgment.diagnose_retry.severe_drop_delta`;
  OR `run-<NNN>.log` contains any `strategy.judgment.diagnose_retry.error_keywords`.

  Per-experiment retry cap: 1. Check journal for an earlier `diagnose_retry_started`
  with the same experiment id; if found, skip the gate (go to 5.a-fallback).

  Session-wide cap: `strategy.judgment.diagnose_retry.max_per_session` (default 10).
  If `session.diagnose_retry.session_retries_used >= cap`, skip (go to 5.a-fallback).

  If gated in:
    Append `diagnose_retry_started {id, trigger, timestamp}`.
    Agent reads run log + target files diff, proposes diagnosis:
      a) "idea itself flawed" → gave_up:
         - Append `diagnose_retry_completed {id, outcome:"gave_up"}`.
         - `session.diagnose_retry.session_retries_used++`, `gave_up_count++`.
         - `experiment_count` increments normally.
         - GO TO discard path with `reason="diagnosed_gave_up"` (5.e persist+reset,
           skipping 5.b/5.c/5.d).
      b) "environment or hyperparameter issue" → retry:
         - Branch & Clean-Tree Guard.
         - `git reset --hard HEAD~1` (removes original failing commit SHA_A).
         - Apply proposed fix to target files.
         - `git add + git commit` (new SHA_B).
         - Append `committed {id: same, commit: SHA_B, retry_of: SHA_A}`.
         - `session.diagnose_retry.session_retries_used++`.
         - `experiment_count` NOT incremented (retry is the same experiment).
         - Jump back to Step 4 (re-evaluate SHA_B).
         - On return: if still triggers, append
           `diagnose_retry_completed {outcome:"failed"}` + go to 5.a-fallback;
           otherwise `diagnose_retry_completed {outcome:"recovered"}` + continue to 5.b.

  **5.a-fallback** (gate skipped or retry exhausted):
  Invariant assert: `session_retries_used >= max_per_session` OR a prior
  `diagnose_retry_started` exists for this experiment id — if neither,
  raise hard error + prompt user.
  If `crashed` was the original trigger: go to discard(`reason="crash"`).
  Otherwise (severe-drop/error-keyword, non-crashing score): continue to 5.b.

  **Resume rule for 5.a** (4 branches):
  If last event is `diagnose_retry_started` without matching `_completed`:
    1. HEAD == SHA_B (recorded as `committed` with `retry_of`): re-enter Step 4.
    2. HEAD == SHA_A (original committed SHA): reset never happened; re-enter
       at diagnosis proposal step.
    3. HEAD == parent(SHA_A): *expected mid-retry window* — reset succeeded but
       new commit didn't land. Re-enter at "apply proposed fix to target files".
    4. HEAD matches none of the three: unexpected. Prompt user with the three
       SHAs + current HEAD for manual recovery.

  **Step 5.b — Score Comparison** (only reached if 5.a did not force discard):
  `score_new > score_old + strategy.judgment.min_delta` → keep branch (continue 5.c).
  Else → discard branch with `reason="regression"` → persist+reset (5.e).

  **Step 5.c — Shortcut Detector** (keep branch only):
  `flagged = (score_delta >= strategy.shortcut_detection.auto_flag_delta) AND (loc_delta <= strategy.shortcut_detection.min_loc)`.
  If flagged:
    Append `shortcut_flagged {id, commit, score_delta, loc_delta, timestamp}`.
    `session.shortcut.cumulative_flagged++`.
    `session.shortcut.flagged_since_last_tier3++`.
    `session.shortcut.total_flagged++`.

  **Step 5.d — Legibility Gate** (keep branch only):
  `level = "hard" if flagged else "medium"`.
  Agent supplies rationale (≤ `strategy.legibility.max_rationale_chars`, default 120).
  Validation:
    Empty:
      medium → append `rationale_missing`, `session.legibility.missing_rationale_count++`, proceed.
      hard   → re-prompt once; if still empty, convert to discard:
                 `status="discarded"`, `reason="flagged_unexplained"`.
                 Write results.tsv row BEFORE reset (9 cols, `rationale=""`, `flagged=true`)
                 — forensic data preserved even if commit is gc'd later.
                 Append `discarded {id, status:"discarded", reason, rationale, timestamp}`
                 BEFORE reset — §5.5 contract.
                 Branch & Clean-Tree Guard + `git reset --hard HEAD~1`.
                 Append `rollback_completed`.
                 Counter preservation: `cumulative_flagged`, `flagged_since_last_tier3`,
                 `total_flagged` all NOT decremented (intentional — suspicious pattern
                 still contributes to escalation signal even when rejected).
    Identical to description (`block_identical_to_description=true`):
      medium → re-prompt once; if still identical, warn and proceed.
      hard   → re-prompt once; if still identical, same discard path as empty+hard
               (results.tsv row with `rationale=<last submitted>` — identical to
               description — preserves evidence).
  On pass: kept event includes `rationale` field.

  **Step 5.e — Persist**:
  Keep branch: write 9-column results.tsv row (`commit score status category score_delta loc_delta flagged rationale description`, tab-separated), Code Archive update (existing).
  Discard branch (from 5.b regression OR 5.a crash/gave_up): write 9-col results.tsv row, then Branch & Clean-Tree Guard + `git reset --hard HEAD~1`, append `rollback_completed`.
  Note: for 5.d hard-reject, the results.tsv row + `discarded` + `rollback_completed` were already written in 5.d — do NOT duplicate.

ELSE (v2):
  
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
  - **Code Archive**: Record the kept commit in `$SESSION_ROOT/code-archive/`:
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

**6.a.5 — Shortcut Escalation (v3 only):**

IF $VERSION starts with "3.":
  IF `session.shortcut.cumulative_flagged >= strategy.shortcut_detection.cumulative_threshold`:
    - Append `shortcut_escalation` event: `{"event": "shortcut_escalation", "cumulative": <N>, "action": "section_d_forced", "timestamp": "..."}`
    - Reset `session.shortcut.cumulative_flagged = 0` (persist)
    - Execute **Section D: Prepare Expansion** (below) inline, BEFORE Step 6.b-6.d.
    - After Section D returns, continue at Step 1 (skip 6.b-6.d this cycle).

    **IMPORTANT**: inner_count is NOT reset by 6.a.5. If inner_count had already
    crossed outer_interval, the Outer Loop trigger is preserved — the next
    iteration's 6.b will see the still-high inner_count and fire the Outer Loop
    normally. This guarantees no silent drop of pending outer-loop generations.

ELSE (v2): skip this step.

**6.b** Check for **interval-based Outer Loop trigger**:
If `inner_count >= outer_interval`:
  If `session.yaml.outer_loop.auto_trigger` is **false**: AskUserQuestion "주기적 Outer Loop 실행할까요?" → "실행" / "건너뛰기 (→ 6.d)"
  If approved (or auto_trigger=true): execute Step 6.5.
  After Step 6.5 returns, **skip 6.c** (outer loop already ran this cycle — do not run twice) → go to 6.d.
If interval not reached → continue to 6.c.

**6.c** Check for diminishing returns using strategy.yaml thresholds (only reached if 6.b did NOT trigger outer loop):
- 0 keeps in last `consecutive_discard_limit` (default 10) → report: "<N>회 연속 discard. Score가 수렴한 것 같습니다."
- keeps exist but max score delta < `min_delta` in last `plateau_window` (default 15) → report: "개선폭이 미미합니다."
- `crash_tolerance`+ crashes in last 10 → report: "안정성 문제가 감지되었습니다."

If any diminishing-returns signal triggered:

  First, check **Code Archive Backtrack**: If `strategy.yaml.convergence.plateau_action` is `"branch"` AND `strategy.yaml.exploration.backtrack_enabled` is true AND code-archive has eligible entries:
  → Execute backtrack (Read `protocols/archive.md`). Then proceed to Outer Loop below.

  If backtrack not applicable (disabled or no eligible entries), proceed directly to Outer Loop:

  If `session.yaml.outer_loop.auto_trigger` is **true** (default):
  → **IMMEDIATELY** run Step 6.5 (Outer Loop Evaluation). Do NOT AskUserQuestion before Outer Loop completes. → go to 6.d.

  If `session.yaml.outer_loop.auto_trigger` is **false**:
  → AskUserQuestion first: "diminishing returns 감지됨. Outer Loop를 실행할까요?"
    - "실행" → Step 6.5 → go to 6.d
    - "건너뛰기" → go to 6.d (user declined outer loop)

**6.d** Continuation decision:

  If Outer Loop was NOT run (no trigger, or user declined in 6.b/6.c):
  If diminishing returns were detected but outer loop was skipped:
  → AskUserQuestion: "계속 (N회 추가)" / "평가 harness 확장" / "여기서 완료"
  Otherwise (no signal at all):
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

1. **Mark paused** (C-1/R-1): `session-helper.sh mark_session_status "$SESSION_ID" paused`
   — indicates that a crash during Outer Loop should re-enter via `resume.md` Step 5's
   outer-loop branch rather than re-running inner experiments.
2. → Read `protocols/outer-loop.md`, execute Outer Loop. Outer Loop itself uses journal
   events as checkpoints (see outer-loop.md "Resume safety" section) so restart is
   idempotent per-phase.
3. **Mark active**: on normal return (Outer Loop did not trigger completion),
   `session-helper.sh mark_session_status "$SESSION_ID" active`. If Outer Loop terminated
   the session (e.g., session-level stop criteria), completion.md will set the final
   status to `completed`.

If `experiment_count >= max_count`:
→ Read `protocols/completion.md`

Otherwise: → Back to Step 1

## Section D: Prepare Expansion

**If eval_mode is `cli`:**
1. Read current `$SESSION_ROOT/prepare.py`
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
1. Read current `$SESSION_ROOT/prepare-protocol.md`
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
