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

### Version Gate (W-1 4-arm pattern, T37 unified)

Read the session's `deep_evolve_version` and route via 4-arm case:

```bash
VERSION=$(grep '^deep_evolve_version:' "$SESSION_ROOT/session.yaml" \
  | head -1 | sed 's/^deep_evolve_version:[[:space:]]*//; s/"//g')

case "$VERSION" in
  2.*)
    export VERSION_TIER="pre_v3"
    echo "inner-loop.md: VERSION=$VERSION — routing as pre-v3 (legacy single-seed, no virtual_parallel)" >&2
    ;;
  3.0*)
    export VERSION_TIER="v3_0"
    # v3.0 retains all v3 features (shortcut_detection, seal_prepare_read,
    # 10-cat weights) but lacks virtual_parallel block — sub-steps that
    # depend on it MUST gate on VERSION_TIER == "v3_1_plus".
    ;;
  3.*|4.*)
    export VERSION_TIER="v3_1_plus"
    # v3.1+ and forward proceed through the virtual_parallel-aware paths.
    ;;
  *)
    export VERSION_TIER="pre_v3"
    echo "inner-loop.md: VERSION=$VERSION unrecognized — treating as pre-v3 (legacy)" >&2
    ;;
esac
```

All v3-gated sub-steps below check `$VERSION_TIER`. The legacy `$VERSION starts with "3."` checks have been replaced with explicit tier checks.

### v3 Environment Propagation (only when $VERSION_TIER != "pre_v3")

IF $VERSION_TIER != "pre_v3":

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

**v3.1 additional contract**: when `$VERSION_TIER == "v3_1_plus"`, every journal
event appended from within the inner loop MUST carry `"seed_id": <int>`. See
the Block-Parameters Intake step (Section C, first sub-step below) for the
`SEED_ID` derivation and the `append_journal_event` invocation pattern.
`scheduler-signals.py` relies on this tag for per-seed recent_Q_trend and
forum_activity computation (foundation Gap 4 closure).

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

**Step 0.5 — v3.1 Block-Parameters Intake** (only when `$VERSION_TIER == "v3_1_plus"`; v2 and v3.0 sessions skip this step entirely):

At the very top of every inner-loop iteration inside a v3.1 session, the
subagent MUST confirm its block-level parameters before touching code or state.
This step is the contract enforcement point for § 4.1 worktree isolation and
§ 5.7 per-seed state separation.

1. **CWD pin check (prose-contract § 4.1)**: run `pwd`. The output MUST equal
   exactly the `worktree_path` printed in your dispatch prompt. If mismatched:
   emit a final JSON summary with `"status": "failed"` and `"notes": "CWD
   mismatch: expected <worktree_path>, got <pwd>"`, and exit without appending
   any journal events. CWD mismatch is a contract violation — do not attempt
   self-recovery via `cd`.
2. **`N_block` readout**: your dispatch prompt contains the sentence "run
   exactly N experiments" (see T13 subagent prompt builder). Record this N
   as `N_block`; your block MUST execute exactly N iterations of Steps 1–5
   unless a `crash_give_up` condition (Step 5.a fallback) or user-initiated
   kill halts the block early.
3. **Seed identity**: derive `SEED_ID` from `pwd` (the CWD you just pinned
   in step 1). This keeps Step 0.5 self-contained — the prose contract
   never exports `$worktree_path`, so deriving from a pinned `pwd` is the
   only portable path:
   ```bash
   SEED_ID=$(basename "$(pwd)" | sed 's/^seed_//')
   export SEED_ID
   ```
   Because step 1 already verified `pwd == worktree_path` and the path is
   always `.deep-evolve/<sid>/worktrees/seed_<k>`, `basename` yields
   `seed_<k>` and the `sed` strips the prefix to yield `<k>`.
4. **Per-seed program.md**: read `"$worktree_path/program.md"`. This is the
   SEED-SPECIFIC program.md written by the coordinator at init (see T8
   `write-seed-program.py`), NOT the base `$SESSION_ROOT/program.md`. It
   contains this seed's β direction, hypothesis, and initial rationale.
   For N=1 sessions the seed program.md is a verbatim copy of the base (per
   § 5.1a short-circuit) — this step reads the same content in both cases, so
   downstream Steps 1–5 have uniform scaffolding.
5. **Tagging contract (closes foundation Gap 4)**: EVERY journal event you
   append during this block — `planned`, `committed`, `evaluated`, `kept`,
   `discarded`, `rollback_completed`, `diagnose_retry_started`,
   `diagnose_retry_completed`, `shortcut_flagged`, `rationale_missing`,
   `borrow_planned` — MUST include `"seed_id": <SEED_ID>`. Enforcement is
   dual-layer (defense-in-depth):
   - Layer 1 (this prose contract): pass seed_id explicitly in every event JSON.
   - Layer 2 (`session-helper.sh` enforcement — T16 Step 6 below): when
     `$SEED_ID` is exported, `append_journal_event` auto-injects seed_id
     into the enriched event, **overriding any stale value** in the payload.
     This is the actual Gap 4 closure — prose alone was insufficient.

   Subagent invocation pattern (explicit layer 1):
   ```bash
   bash "$DEEP_EVOLVE_HELPER_PATH" append_journal_event "$(
     jq -nc --arg sid "$SEED_ID" --argjson rest "$EVENT_JSON" \
       '$rest + {seed_id: ($sid|tonumber)}'
   )"
   ```
   Note jq merge order: `$rest + {seed_id: ...}`. In jq, object `+` makes
   the RHS win on key conflict — so the auto-injected seed_id overrides
   any seed_id that drifted into `$EVENT_JSON`. If the order were reversed
   (`{seed_id:...} + $rest`), a stale seed_id in the payload would silently
   defeat the auto-inject.

   `scheduler-signals.py` keys `recent_Q_trend` off of `kept.seed_id`; a
   missing or wrong tag silently returns neutral trend and the Adaptive
   Scheduler makes blind decisions. Tag at emission; never post-hoc.

v2 / v3.0.x sessions: skip Step 0.5 entirely. These sessions have no worktree,
no N_block, and no SEED_ID. The `$VERSION` gate at the top of Section C
already enforces this separation; Step 0.5 only runs when that gate matches
`3.1.*`.

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
- **v3.1 forum consultation (only when `$VERSION_TIER` == "v3_1_plus")**:
  before the "Append to `journal.jsonl`" step below, run
  ```bash
  bash "$DEEP_EVOLVE_HELPER_PATH" tail_forum 20 > /tmp/recent_forum_$$.jsonl
  ```
  to read the last 20 forum events across all seeds. For each candidate idea
  you ranked above, compare against the other seeds' recent non-flagged
  `seed_keep` descriptions. If a candidate duplicates (semantically or
  verbatim) another seed's recent keep, demote it unless your direction
  genuinely differs — the goal is independent exploration (§ 3 AAR Q1),
  not convergent reinvention. Do NOT block selection outright; this is a
  soft-filter used to nudge the ranked list. Cleanup: `rm -f /tmp/recent_forum_$$.jsonl`
  before leaving Step 1.

  This consultation is distinct from the post-keep borrow (see later step
  5.f): Step 1 is "avoid already kept ideas before exploring"; the post-keep
  borrow is "after a keep, evaluate adapting others' ideas". Both honor P2
  (no flagged propagation): Step 1 filters by `flagged=false`; the borrow
  step is enforced via `borrow-preflight.py`.

  v2 and v3.0.x sessions: `$VERSION_TIER` is not "v3_1_plus" so forum.jsonl does not exist; skip this bullet.
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

- **For v2 sessions only**: Append to `journal.jsonl`:
  `{"id": <id>, "status": "evaluated", "score": <score>, "timestamp": "<now>"}`
  
  **For v3 sessions (`$VERSION` starts with "3.")**: do NOT append yet —
  Step 4.5 below defers the `evaluated` event until `score_delta` and
  `loc_delta` are computed. Mirror the Step 1 / Step 1.5 deferral pattern.

**Step 4.5 — Delta Measurement (v3 only):**

IF $VERSION starts with "3.":
- Compute `score_delta = score - (last kept score OR session.yaml.metric.baseline)`
- Compute `loc_delta = abs(added + deleted)` over target_files only:

```bash
loc_delta=$(git diff --numstat HEAD~1..HEAD -- <target_file_1> <target_file_2> ... |
  awk '{ a+=$1; d+=$2 } END { print a+d }')
```

- **Extract `target_files` from session.yaml** for the diff:
  ```bash
  target_files=$(python3 -c "import yaml; print(' '.join(yaml.safe_load(open('$SESSION_ROOT/session.yaml'))['target_files']))")
  loc_delta=$(git diff --numstat HEAD~1..HEAD -- $target_files |
    awk '{ a+=$1; d+=$2 } END { print (a+d)+0 }')
  ```
  (The earlier bash snippet above is illustrative; the target_files list must
  actually come from session.yaml.)
- Append the `evaluated` event now, with both delta fields on first write:
  `{"event": "evaluated", "id": <id>, "score": <score>, "score_delta": <score_delta>, "loc_delta": <loc_delta>, "timestamp": "<now>"}`
  (No journal amendment — the event is written once, here, at the end of Step 4.5.)

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
    Append journal event (explicit event key form — consumed by
    `session-helper.sh retry_budget_remaining`):
    `{"event": "diagnose_retry_started", "id": <id>, "trigger": "<reason>", "timestamp": "<now>"}`
    Agent reads run log + target files diff, proposes diagnosis:
      a) "idea itself flawed" → gave_up:
         - Append `{"event": "diagnose_retry_completed", "id": <id>, "outcome": "gave_up", "timestamp": "<now>"}`.
         - `session.diagnose_retry.session_retries_used++`, `gave_up_count++`.
         - `experiment_count` increments normally.
         - GO TO discard path with `reason="diagnosed_gave_up"` (5.e persist+reset,
           skipping 5.b/5.c/5.d).
      b) "environment or hyperparameter issue" → retry:
         - Branch & Clean-Tree Guard.
         - `git reset --hard HEAD~1` (removes original failing commit SHA_A).
         - Apply proposed fix to target files.
         - `git add + git commit` (new SHA_B).
         - Append `{"id": <same>, "status": "committed", "commit": "<SHA_B>", "retry_of": "<SHA_A>", "timestamp": "<now>"}`.
         - `session.diagnose_retry.session_retries_used++`.
         - `experiment_count` NOT incremented (retry is the same experiment).
         - Jump back to Step 4 (re-evaluate SHA_B).
         - On return: if still triggers, append
           `{"event": "diagnose_retry_completed", "id": <id>, "outcome": "failed", "timestamp": "<now>"}` + go to 5.a-fallback;
           otherwise `{"event": "diagnose_retry_completed", "id": <id>, "outcome": "recovered", "timestamp": "<now>"}` + continue to 5.b.

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
    Append journal event — **explicit `event` key required** so that
    `session-helper.sh count_flagged_since_last_expansion` and outer-loop.md
    Tier 3 flagged-evidence injection can consume it:
    `{"event": "shortcut_flagged", "id": <id>, "commit": "<COMMIT>", "score_delta": <score_delta>, "loc_delta": <loc_delta>, "description": "<idea description>", "timestamp": "<now>"}`
    (The `description` field is read by outer-loop.md Step 6.5.6 Tier 3
    evidence injection when the commit has been gc'd.)
    `session.shortcut.cumulative_flagged++`.
    `session.shortcut.flagged_since_last_tier3++`.
    `session.shortcut.total_flagged++`.

  **Step 5.d — Legibility Gate** (keep branch only):
  `level = "hard" if flagged else "medium"`.
  Agent supplies rationale (≤ `strategy.legibility.max_rationale_chars`, default 120).
  Validation:
    Empty:
      medium → append journal event
               `{"event": "rationale_missing", "id": <id>, "timestamp": "<now>"}`
               then `session.legibility.missing_rationale_count++`, proceed to 5.e keep branch.
      hard   → re-prompt once; if still empty, convert to discard:
                 `status="discarded"`, `reason="flagged_unexplained"`.
                 Write 9-column results.tsv row BEFORE reset (`rationale=""`, `flagged=true`)
                 — forensic data preserved even if commit is gc'd later.
                 Append journal event BEFORE reset — §5.5 contract:
                 `{"id": <id>, "status": "discarded", "reason": "flagged_unexplained", "rationale": "", "timestamp": "<now>"}`
                 Branch & Clean-Tree Guard + `git reset --hard HEAD~1`.
                 Append `{"id": <id>, "status": "rollback_completed", "timestamp": "<now>"}`.
                 Update `session.yaml`: `experiments.total++`, `experiments.discarded++`.
                 Counter preservation: `cumulative_flagged`, `flagged_since_last_tier3`,
                 `total_flagged` all NOT decremented (intentional — suspicious pattern
                 still contributes to escalation signal even when rejected).
                 **SKIP 5.e** — persistence already completed here.
    Identical to description (`block_identical_to_description=true`):
      medium → re-prompt once; if still identical, warn and proceed to 5.e keep branch.
      hard   → re-prompt once; if still identical, same discard path as empty+hard
               (results.tsv row with `rationale=<last submitted>` — identical to
               description — preserves evidence).
  On pass: continue to Step 5.e keep branch with rationale.

  **Step 5.e — Persist**:

  **Keep branch** (score improved, rationale passed 5.d OR flagged not applicable):
    - Append journal: `{"id": <id>, "status": "kept", "rationale": "<text>", "score_delta": <n>, "loc_delta": <n>, "flagged": <bool>, "timestamp": "<now>"}`
    - Append 9-column results.tsv row: `<COMMIT>\t<score>\tkept\t<idea_category>\t<score_delta>\t<loc_delta>\t<flagged>\t<rationale>\t<idea description>`
    - Update `session.yaml`:
      - `metric.current = score`
      - `metric.best = max(metric.best, score)`
      - `experiments.total++`
      - `experiments.kept++`
    - **Code Archive**: record the kept commit in `$SESSION_ROOT/code-archive/keep_<NNN>/` (as per v2 behavior).
    - **v3.1 forum emission** (only when `$VERSION_TIER == "v3_1_plus"`):
      emit the `seed_keep` event to the shared forum so other seeds can see
      it at Step 1 consultation + the cross-seed borrow evaluation below
      (spec § 7.2). Include `epoch` so Outer Loop Step 6.5.0 can filter by
      generation.
      ```bash
      CURRENT_EPOCH=$(python3 -c "import yaml; \
        d=yaml.safe_load(open('$SESSION_ROOT/session.yaml')); \
        print(d.get('evaluation_epoch', {}).get('current', 0))")
      bash "$DEEP_EVOLVE_HELPER_PATH" append_forum_event "$(jq -nc \
        --argjson sid "$SEED_ID" --arg commit "$COMMIT" \
        --arg desc "$IDEA_DESCRIPTION" --arg rat "$RATIONALE" \
        --argjson sd "$SCORE_DELTA" --argjson flg "$FLAGGED_BOOL" \
        --argjson lp "$LEGIBILITY_PASSED_BOOL" --argjson ep "$CURRENT_EPOCH" \
        '{"event":"seed_keep","seed_id":$sid,"commit":$commit,"description":$desc,
          "rationale":$rat,"score_delta":$sd,"flagged":$flg,
          "legibility_passed":$lp,"epoch":$ep}')"
      ```
      where `$COMMIT`, `$IDEA_DESCRIPTION`, `$RATIONALE`, `$SCORE_DELTA`,
      `$FLAGGED_BOOL`, `$LEGIBILITY_PASSED_BOOL` are the same values you just
      wrote to journal and results.tsv — do not recompute them.
      v2 and v3.0.x sessions: skip this bullet (no forum).

  **Discard branch** (from 5.b `reason="regression"`, OR 5.a `reason="crash"`, OR 5.a `reason="diagnosed_gave_up"`):
    - Append journal: `{"id": <id>, "status": "discarded", "reason": "<regression|crash|diagnosed_gave_up>", "timestamp": "<now>"}`
    - Append 9-column results.tsv row: `<COMMIT>\t<score>\tdiscarded\t<idea_category>\t<score_delta>\t<loc_delta>\t<flagged>\t\t<idea description>`
      (empty `rationale` for discard branch — rationale is only required on keep)
    - Update `session.yaml`:
      - `experiments.total++`
      - `experiments.discarded++` (or `experiments.crashed++` when `reason="crash"`)
    - Run **Branch & Clean-Tree Guard**.
    - Run: `git reset --hard HEAD~1`.
    - Append `{"id": <id>, "status": "rollback_completed", "timestamp": "<now>"}`.
    - **v3.1 forum emission** (only when `$VERSION_TIER == "v3_1_plus"`):
      emit the `seed_discard` event to the shared forum so other seeds can
      factor this in during Step 1 consultation (spec § 7.2). Include
      `epoch` for Outer Loop Step 6.5.0 epoch-filtered aggregation.
      ```bash
      CURRENT_EPOCH=$(python3 -c "import yaml; \
        d=yaml.safe_load(open('$SESSION_ROOT/session.yaml')); \
        print(d.get('evaluation_epoch', {}).get('current', 0))")
      bash "$DEEP_EVOLVE_HELPER_PATH" append_forum_event "$(jq -nc \
        --argjson sid "$SEED_ID" --arg commit "$COMMIT" \
        --arg desc "$IDEA_DESCRIPTION" --arg reason "$DISCARD_REASON" \
        --argjson sd "$SCORE_DELTA" --argjson ep "$CURRENT_EPOCH" \
        '{"event":"seed_discard","seed_id":$sid,"commit":$commit,
          "description":$desc,"reason":$reason,"score_delta":$sd,"epoch":$ep}')"
      ```
      where `$DISCARD_REASON` is the reason already written to journal
      (one of: `"regression"`, `"crash"`, `"diagnosed_gave_up"`).
      v2 and v3.0.x sessions: skip this bullet.

  **Note**: for 5.d hard-reject, persistence was already performed inside 5.d
  (results.tsv row + journal `discarded` event + reset + `rollback_completed` +
  counter increments) — do NOT duplicate in 5.e.

  **Step 5.f — Cross-Seed Semantic Borrow** (v3.1 only — `$VERSION_TIER` == "v3_1_plus"; keep branch only; runs after Step 5.e Keep finishes persisting):

  Rationale: your seed has just accepted an experiment. Other seeds' recent keeps
  may contain ideas you can productively adapt. Step 5.f decides (this turn)
  whether to plan a `semantic_borrow` for your NEXT experiment, enforced by
  `hooks/scripts/borrow-preflight.py` to prevent § 7.4 P2 flagged propagation and
  P3 under-exploration borrow cascades.

  1. **Pre-condition gate** (cheap local checks before any subprocess):
     - `self.experiments_used >= 3` (P3 floor — mirrored in preflight as a
       defense-in-depth check).
     - If N=1 (you are the only seed), skip Step 5.f entirely — there is nothing
       to borrow.

  2. **Collect candidates** (from the shared forum). Derive the preflight
     script path directly from `$DEEP_EVOLVE_HELPER_PATH` (they share the
     `hooks/scripts/` directory), avoiding a `DEEP_EVOLVE_REPO` indirection
     that is easy to get wrong by dirname-count. Guard the `tail_forum`
     invocation against transient failures (empty/missing forum.jsonl is a
     valid state):
     ```bash
     HELPER_SCRIPTS_DIR="$(dirname "$DEEP_EVOLVE_HELPER_PATH")"  # <repo>/hooks/scripts
     PREFLIGHT_SCRIPT="$HELPER_SCRIPTS_DIR/borrow-preflight.py"
     CANDIDATES_JSON=$(bash "$DEEP_EVOLVE_HELPER_PATH" tail_forum 40 2>/dev/null \
       | jq -s --argjson sid "$SEED_ID" \
         '[.[] | select(.event=="seed_keep" and .seed_id != $sid)] | .[-10:]' \
       || echo '[]')
     ```
     Take the last 10 non-self seed_keep events from the last 40 forum lines.
     If `CANDIDATES_JSON` is `[]`, skip Step 5.f.

  3. **Preflight filter** (enforces P2 flagged + P2 legibility + dedup; only runs when `$VERSION_TIER` == "v3_1_plus"). The
     preflight needs BOTH the journal (for self-keyed `borrow_planned` dedup —
     phase 1 of the § 7.4 P1 state machine) AND the forum (for self-`to_seed`
     `cross_seed_borrow` dedup — phase 2; per spec § 7.1 that event lives in
     forum.jsonl, NOT journal). Guard the subprocess call so operator
     errors surface as warnings rather than masquerading as "no eligible
     candidates":
     ```bash
     JOURNAL_RELEVANT=$(jq -s --argjson sid "$SEED_ID" \
       '[.[] | select(.event=="borrow_planned" and .seed_id==$sid)
             , .[] | select(.event=="borrow_abandoned" and .seed_id==$sid)]' \
       "$SESSION_ROOT/journal.jsonl" 2>/dev/null || echo '[]')
     FORUM_RELEVANT=$(jq -s --argjson sid "$SEED_ID" \
       '[.[] | select(.event=="cross_seed_borrow" and .to_seed==$sid)]' \
       "$SESSION_ROOT/forum.jsonl" 2>/dev/null || echo '[]')
     if ! PREFLIGHT=$(python3 "$PREFLIGHT_SCRIPT" \
         --args "$(jq -nc \
           --argjson sid "$SEED_ID" \
           --argjson used "$SELF_EXPERIMENTS_USED" \
           --argjson cands "$CANDIDATES_JSON" \
           --argjson journal "$JOURNAL_RELEVANT" \
           --argjson forum "$FORUM_RELEVANT" \
           '{self_seed_id:$sid, self_experiments_used:$used, candidates:$cands, journal:$journal, forum:$forum}')"); then
       echo "warn: borrow-preflight.py exited non-zero — skipping Step 5.f this turn" >&2
       return 0 2>/dev/null || :
     fi
     ```
     `$SELF_EXPERIMENTS_USED` must be derived before this block from session.yaml
     (requires `$VERSION_TIER` == "v3_1_plus" — virtual_parallel block exists):
     ```bash
     SELF_EXPERIMENTS_USED=$(python3 -c "import yaml,sys; \
       d=yaml.safe_load(open('$SESSION_ROOT/session.yaml')); \
       print(next(s['experiments_used'] for s in \
         d['virtual_parallel']['seeds'] if s['id']==int('$SEED_ID')))")
     ```
     Parse `eligible` and `p3_gate_open`. If `p3_gate_open` is `false` or
     `eligible` is empty, skip Step 5.f (no borrow this turn).

  4. **AI evaluation** (only runs if eligible is non-empty): prompt yourself
     with the candidate list and decide — for each candidate — whether the idea
     is semantically relevant to your direction and worth re-implementing. The
     AI judgement is § 7.3's prompt verbatim (includes "re-implement, do not
     cherry-pick").

  5. **Phase 1: `borrow_planned`** (journal, § 7.4 P1 state machine). For each
     candidate you commit to borrow, append:
     ```json
     {"event":"borrow_planned","seed_id":<SEED_ID>,"source_commit":"<sha>",
      "source_seed":<n>,"plan_rationale":"<≤200 chars>",
      "planned_for_experiment_id":<next_experiment_id>,"block_id":<current_block_id>}
     ```
     via `bash "$DEEP_EVOLVE_HELPER_PATH" append_journal_event <json>`.
     Counters `borrows_given` / `borrows_received` in session.yaml MUST NOT
     increment yet — this is intent only (P1 Phase 1).

  6. **Phase 2 deferred to next experiment's Step 2 (Code Modification)** (requires `$VERSION_TIER` == "v3_1_plus"): when
     the next experiment runs, Step 2 re-implements the borrowed idea. The
     subsequent Step 3 Git Commit MUST include a trailer
     `inspired_by: <source_commit>`. Immediately after the successful commit
     (before Step 4 evaluation), recover the planned-event context and append
     a `cross_seed_borrow` event to `forum.jsonl`:
     ```bash
     TARGET_COMMIT=$(git rev-parse HEAD)
     CURRENT_EXP_ID=<id of the experiment you just committed>
     PLANNED=$(jq -s --argjson sid "$SEED_ID" --argjson eid "$CURRENT_EXP_ID" \
       '[.[] | select(.event=="borrow_planned" and .seed_id==$sid
                      and .planned_for_experiment_id==$eid)] | .[-1]' \
       "$SESSION_ROOT/journal.jsonl" 2>/dev/null)
     if [ -z "$PLANNED" ] || [ "$PLANNED" = "null" ]; then
       echo "warn: no matching borrow_planned found for seed $SEED_ID exp $CURRENT_EXP_ID" >&2
     else
       SOURCE_COMMIT=$(printf '%s' "$PLANNED" | jq -r '.source_commit')
       SOURCE_SEED=$(printf '%s' "$PLANNED"  | jq -r '.source_seed')
       PLAN_RATIONALE=$(printf '%s' "$PLANNED" | jq -r '.plan_rationale')
       bash "$DEEP_EVOLVE_HELPER_PATH" append_forum_event "$(jq -nc \
         --argjson src "$SOURCE_SEED" --argjson tgt "$SEED_ID" \
         --arg sc "$SOURCE_COMMIT" --arg tc "$TARGET_COMMIT" \
         --arg mode "semantic_borrow" --arg reason "$PLAN_RATIONALE" \
         '{event:"cross_seed_borrow",from_seed:$src,to_seed:$tgt,
           source_commit:$sc,target_commit:$tc,mode:$mode,
           inspired_by:$sc,reason:$reason}')"
     fi
     ```
     Only on this forum Phase 2 append do the counters
     `source_seed.borrows_given` / `self.borrows_received` increment (handled
     by coordinator at epoch boundary from forum scan).

  7. **Abandonment**: if you never execute Phase 2 within 2 blocks of the
     `borrow_planned`, `borrow-abandoned-scan.py` (T15b) emits a
     `borrow_abandoned` event at the coordinator's post-dispatch turn. You do
     not need to emit it yourself.

  v2 and v3.0.x sessions: there is no Step 5.f — the shared forum does not
  exist in those session types. Skip entirely.

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

**Protection bypass**: Section D must Write to `prepare.py` or `prepare-protocol.md`
which are normally protected by `protect-readonly.sh`. Export the `prepare_update`
meta mode BEFORE the Write and unset it AFTER:

```bash
export DEEP_EVOLVE_META_MODE=prepare_update
# ... perform Write / Edit on prepare.py or prepare-protocol.md ...
unset DEEP_EVOLVE_META_MODE
```

This applies to BOTH the user-initiated Section D (via AskUserQuestion
"평가 harness 확장") AND the v3 forced Section D (triggered by Step 6.a.5
`shortcut_escalation`). Without this wrapper, the PreToolUse hook will block
the Write even though the section is authorized to modify the harness.

**If eval_mode is `cli`:**
1. Read current `$SESSION_ROOT/prepare.py`
2. Re-analyze the project (Stage 3 only — code has changed since last analysis)
3. Identify new scenarios or harder test cases based on:
   - Areas where score plateaued
   - Patterns in discarded experiments
   - Code regions not covered by current scenarios
4. Generate updated `prepare.py` with new scenarios
   (Set `DEEP_EVOLVE_META_MODE=prepare_update` before this step; unset after.)
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
   (Set `DEEP_EVOLVE_META_MODE=prepare_update` before this step; unset after.)
5. Increment `session.yaml.prepare.version`
6. Append to `session.yaml.prepare.history`: `{version, steps, reason}`
7. Insert separator in `results.tsv`: `--- prepare v<old> -> v<new> (<old_steps>-><new_steps> steps) ---`
8. Run new baseline with expanded protocol
9. → Resume Loop
