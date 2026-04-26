# Resume Protocol (v2.2.2)

Resumes an interrupted deep-evolve session. Restores context from persisted state
and re-enters the experiment loop.

## Step 1 — Load current session

Run `session-helper.sh resolve_current` → `session_id`, `$SESSION_ROOT`.
Read `$SESSION_ROOT/session.yaml`. Branch by `status`:
- **terminal** (`completed` / `aborted`):
  "재개할 세션이 없습니다. `/deep-evolve`로 새 세션을 시작하세요." Stop here.
- **initializing** (v2.2.2): baseline writeback 전 중단 → dispatch back to
  `protocols/init.md` Step 11 (dispatcher에서 이미 처리됨; resume.md는 이 상태를
  직접 다루지 않는다).
- **active** / **paused**: continue to Step 2.

## Step 2 — Load session state

Read the following files for context restoration:
- `$SESSION_ROOT/session.yaml` — full configuration
- `$SESSION_ROOT/strategy.yaml` — current strategy parameters
- `$SESSION_ROOT/results.tsv` — last 20 rows (experiment history)
- `$SESSION_ROOT/journal.jsonl` — last 50 events (recent activity)
- `$SESSION_ROOT/program.md` — experiment instructions (including Inherited Context if present)

## Step 3 — Integrity check

### 3.a Branch alignment (Q4-B + AH3)

```bash
session-helper.sh check_branch_alignment "$SESSION_ROOT"
```

If exit 1 (mismatch):
  AskUserQuestion: "현재 브랜치가 세션 브랜치와 다릅니다. (expected: <X>, actual: <Y>)"
  Options:
  - "checkout and continue": `git checkout <expected_branch>`, then continue
  - "proceed on current (branch rebind)":
    **AH1 safety gate**: Before rebinding, verify that HEAD contains the last experiment commit:
    ```bash
    last_exp_commit=$(grep -v '^---' "$SESSION_ROOT/results.tsv" | tail -n1 | cut -f1)
    git merge-base --is-ancestor "$last_exp_commit" HEAD
    ```
    If the last experiment commit is NOT an ancestor of HEAD: **block rebind** — "현재 브랜치에 세션의 마지막 실험이 포함되어 있지 않습니다. checkout을 사용하세요." → abort or checkout only.
    If verified:
    1. Update `session.yaml.lineage.current_branch` to current branch
    2. Append to journal.jsonl: `{"event": "branch_mismatch_accepted", ...}` and `{"event": "branch_rebound", "from": "<expected>", "to": "<actual>", ...}`
    3. Record in runtime_warnings for receipt (X13)
    → Inner-loop's branch guard will now pass (invariant restored)
  - "abort resume": Stop

### 3.b Dirty tree

```bash
git status --porcelain
```

If non-empty: warn user → AskUserQuestion: [stash 후 계속 / abort]

### 3.c HEAD vs last experiment

```bash
# CR2: tail -n1은 separator 행일 수 있으므로, 마지막 실제 실험 행을 찾음
last_commit=$(grep -v '^---' "$SESSION_ROOT/results.tsv" | tail -n1 | cut -f1)
head_commit=$(git rev-parse HEAD)
```

If different: "HEAD가 마지막 실험 커밋과 다릅니다." 경고 → [계속 / abort]

### 3.d Orphan experiment detection (X1)

```bash
orphan_commit=$(session-helper.sh detect_orphan_experiment "$SESSION_ROOT")
```

If non-empty (orphan found):
  AskUserQuestion: "실험 #<N>이 평가되지 않은 채 중단되었습니다. (commit: <hash>)"
  Options:
  - "재평가": Run evaluation harness on this commit, record result
  - "discard로 기록": Append discarded event to journal, proceed
  - "무시하고 다음 실험부터": Skip, continue with next experiment number

### 3.e Counter consistency

```bash
sess_inner=$(grep 'inner_count:' "$SESSION_ROOT/session.yaml" | head -1 | sed 's/.*inner_count:[[:space:]]*//')
# CR1: inner_count는 세대별 카운터. results.tsv 전체 행이 아닌 현재 generation의 실험 수와 비교.
# 현재 generation 시작 실험 번호는 outer_loop.q_history의 마지막 entry 또는 0.
# 간이 방법: session.yaml.experiments.total - (이전 generation들의 총 실험 수)
# 실용적 접근: inner_count가 outer_interval보다 크면 이미 이상 → 경고만 표시
if [ "$sess_inner" -gt "$(grep 'interval:' "$SESSION_ROOT/session.yaml" | head -1 | sed 's/.*interval:[[:space:]]*//')" ] 2>/dev/null; then
  echo "inner_count($sess_inner) > interval — counter may be stale" >&2
  # Reset to 0, outer loop will re-evaluate
  # Update session.yaml and journal
fi
```

If counter appears inconsistent: warn and adopt safe default (0 if generation just changed, or tsv-derived if not). Append `counter_reconciled` event to journal.

## Step 3.5 — v3.1 virtual-parallel reconciliation

> **Version gate**: This step runs ONLY when
> `$SESSION_ROOT/session.yaml` has `deep_evolve_version: "3.1.0"` (or any
> v3.1.x). For v2.x / v3.0.x sessions — which lack the `virtual_parallel`
> block entirely — skip 3.5.a–3.5.d entirely and proceed directly to Step 4
> (the v2 compatibility banner there handles them).

**Gate (run once at Step 3.5 entry — self-contained, no straddling `fi`):**

W-5 fix (Opus review 2026-04-25-161635): the prior plan wrapped 3.5.a–3.5.d
inside a single `if ... else ... fi` block whose closing `fi` straddled
multiple markdown code-fences. A future editor inserting a new sub-stage
could easily forget to keep the `fi` matched. New design: declare a plain
shell flag `IS_V31` here once, and each sub-stage 3.5.a–3.5.d begins with a
one-line `[ "${IS_V31:-0}" = "1" ] || return 0` (or `continue` / explicit
skip — coordinator's choice based on its containing context).

```bash
VERSION=$(grep '^deep_evolve_version:' "$SESSION_ROOT/session.yaml" \
  | head -1 | sed 's/^deep_evolve_version:[[:space:]]*//; s/"//g')

if echo "$VERSION" | grep -q '^3\.1'; then
  IS_V31=1
else
  IS_V31=0
  echo "Step 3.5: v$VERSION session — virtual_parallel block absent; skipping reconciliation, proceeding to Step 4." >&2
fi
export IS_V31
```

If `IS_V31=0`: **skip 3.5.a–3.5.d entirely and jump to Step 4 below**. Each
sub-stage's own gate check below is defensive (and lets a future executor
run the sub-stages independently for testing).

### 3.5.a — Read virtual_parallel.seeds + last-snapshot

The session.yaml `virtual_parallel.seeds[]` block is the **declared** state
of the session. It was populated by init.md A.3.6 (T32) and updated by the
inner / outer loops as seeds were killed or grown. The journal is the
**actual** state — events appended in order. Step 3.5 cross-checks them.

```bash
# W-A fix (Opus review 2026-04-25-172243): wrap entire body in explicit
# if/then/else/fi — prior `[ ... ] || { echo ... }` only echoed the skip
# message but did NOT actually skip the body (fail-open hazard). Each
# sub-stage now self-contained per W-5 discipline (no straddling fi).
if [ "${IS_V31:-0}" != "1" ]; then
  echo "3.5.a: skipping (IS_V31=0)" >&2
else
  # W-B fix (Opus review 2026-04-25-172243): rc-guard python3 -c calls per
  # the aff23c9 contract. Capture seed IDs from yaml + n_current declaration.
  if ! DECLARED_SEEDS_JSON=$(python3 -c '
import yaml, json, sys
with open(sys.argv[1]) as f:
    sy = yaml.safe_load(f) or {}
vp = sy.get("virtual_parallel", {})
print(json.dumps({
    "n_current": vp.get("n_current"),
    "seeds": [{"id": s.get("id"),
               "status": s.get("status"),
               "branch": s.get("branch"),
               "worktree_path": s.get("worktree_path")}
              for s in vp.get("seeds", [])],
}))
' "$SESSION_ROOT/session.yaml"); then
    echo "error: resume Step 3.5.a DECLARED_SEEDS_JSON extraction failed" >&2
    exit 1
  fi

  # Capture seeds the journal actually saw initialized
  if ! JOURNAL_SEEDS_JSON=$(python3 -c '
import json, sys
seeds = []
seen = set()
with open(sys.argv[1]) as f:
    for ln in f:
        try: ev = json.loads(ln)
        except json.JSONDecodeError: continue   # skip+warn class
        if ev.get("event") == "seed_initialized":
            sid = ev.get("seed_id")
            if isinstance(sid, int) and sid not in seen:
                seen.add(sid)
                seeds.append({"id": sid,
                              "branch": ev.get("branch"),
                              "worktree_path": ev.get("worktree_path")})
print(json.dumps({"seeds": seeds}))
' "$SESSION_ROOT/journal.jsonl"); then
    echo "error: resume Step 3.5.a JOURNAL_SEEDS_JSON extraction failed" >&2
    exit 1
  fi
fi
```

### 3.5.b — Drift detection (W-3 of G10 — yaml vs journal)

If the seed-id sets disagree, **prefer journal** snapshot (resolution: W-3 of G10).
Rationale: the journal is append-only and journal-authoritative (T15 / aff23c9
contract); the yaml can be overwritten by a partial-init failure that left orphan
seeds[] entries. Emit `resume_drift_detected` so the audit trail records what
happened.

```bash
# W-A fix (Opus review 2026-04-25-172243): wrap entire body in explicit
# if/then/else/fi — see 3.5.a for rationale. No straddling fi (W-5).
if [ "${IS_V31:-0}" != "1" ]; then
  echo "3.5.b: skipping (IS_V31=0)" >&2
else
  # W-4 fix (Opus review 2026-04-25-161635): rc-guard both python3 -c calls
  # per the aff23c9 contract. Without guards, a json parse failure here would
  # either error-and-mask under set -Eeuo pipefail or compare empty string to
  # "True" and silently skip drift handling — losing Scenario 5.
  if ! DRIFT=$(python3 -c '
import json, sys
d = json.loads(sys.argv[1]); j = json.loads(sys.argv[2])
declared = {s["id"] for s in d.get("seeds") or []}
actual   = {s["id"] for s in j.get("seeds") or []}
if declared != actual:
    print(json.dumps({
        "drift": True,
        "declared_only": sorted(declared - actual),
        "actual_only": sorted(actual - declared),
    }))
else:
    print(json.dumps({"drift": False}))
' "$DECLARED_SEEDS_JSON" "$JOURNAL_SEEDS_JSON"); then
    echo "error: resume Step 3.5.b drift detection failed — DECLARED/JOURNAL handles malformed" >&2
    exit 1
  fi

  # I-7 nit (same review): use .get() with default for defensive trust-boundary
  # read; converts python None / missing key to literal "False" for shell test.
  if ! DRIFT_FLAG=$(echo "$DRIFT" | python3 -c '
import json, sys
print(str(json.load(sys.stdin).get("drift", False)))'); then
    echo "error: resume Step 3.5.b drift flag extraction failed" >&2
    exit 1
  fi
  if [ "$DRIFT_FLAG" = "True" ]; then
    echo "warn: resume Step 3.5.b detected drift between session.yaml and journal: $DRIFT" >&2
    # W-B fix (Opus review 2026-04-25-172243): wrap (unset SEED_ID; ...)
    # subshell in rc-guard. Prefer the journal snapshot — overwrite seeds[]
    # to match. This is a one-shot reconciliation; the journal stays
    # authoritative going forward.
    if ! (unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" \
      append_journal_event "$(jq -cn \
        --argjson dr "$DRIFT" \
        '{event: "resume_drift_detected", drift: $dr,
          resolution: "prefer_journal_snapshot"}')"); then
      echo "error: resume Step 3.5.b failed to append resume_drift_detected event" >&2
      exit 1
    fi
    # Reconciliation: rebuild yaml seeds[] from journal events that the journal
    # produced (covers seeds added at epoch_growth and seeds killed mid-session).
    bash "$DEEP_EVOLVE_HELPER_PATH" rebuild_seeds_from_journal \
      || echo "warn: rebuild_seeds_from_journal failed; proceeding with yaml as-is" >&2
  fi
fi
```

### 3.5.c — Per-seed worktree validation (calls T2)

For each seed in the post-reconciliation list, call T2's worktree validator.
RC contract: rc=0 (clean), rc=3 (worktree missing — § 11.1 W-11.1 row),
rc=4 (branch mismatch), rc=5 (dirty), rc=6 (HEAD not descendant of pre-dispatch).

```bash
# W-A fix (Opus review 2026-04-25-172243): wrap entire body in explicit
# if/then/else/fi — see 3.5.a for rationale. No straddling fi (W-5).
if [ "${IS_V31:-0}" != "1" ]; then
  echo "3.5.c: skipping (IS_V31=0)" >&2
else
  # W-B fix (Opus review 2026-04-25-172243): rc-guard the SEED_IDS python3 -c.
  # Build the iteration list from the (possibly-reconciled) yaml.
  if ! SEED_IDS=$(python3 -c '
import yaml, sys
with open(sys.argv[1]) as f:
    sy = yaml.safe_load(f) or {}
for s in (sy.get("virtual_parallel", {}).get("seeds") or []):
    if s.get("status") == "active":   # killed / completed seeds skip validation
        print(s.get("id"))
' "$SESSION_ROOT/session.yaml"); then
    echo "error: resume Step 3.5.c SEED_IDS extraction failed" >&2
    exit 1
  fi

  if ! [ -z "${SEED_IDS:-}" ]; then
  for SID in $SEED_IDS; do
    if ! bash "$DEEP_EVOLVE_HELPER_PATH" validate_seed_worktree "$SID"; then
      rc=$?
      case "$rc" in
        3) # Scenario 4 — worktree missing → § 11.1 W-11.1 recovery
           echo "warn: resume Step 3.5.c seed $SID worktree missing (rc=3)" >&2
           # W-B fix (Opus review 2026-04-25-172243): wrap (unset SEED_ID; ...)
           # subshell in rc-guard.
           if ! (unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" \
             append_journal_event "$(jq -cn \
               --argjson sid "$SID" \
               '{event: "resume_worktree_missing", seed_id: $sid}')"); then
             echo "error: resume Step 3.5.c failed to append resume_worktree_missing for seed $SID" >&2
             exit 1
           fi
           # Coordinator must AskUserQuestion: "Restore from branch tip / Skip seed / Abort?"
           # The prose pattern matches synthesis.md Branch B — coordinator
           # captures USER_CHOICE and re-enters at Step 3.5.d below.
           echo "Step 3.5.c: AskUserQuestion required for seed $SID — see § 11.1 W-11.1" >&2
           ;;
        4|5|6)
           # W-6 fix (Opus review 2026-04-25-161635): per-seed contamination
           # is now operator-decides via AskUserQuestion (mirrors rc=3 path),
           # not session-wide hard-abort. Rationale: in an N=5 init where
           # seed-3 is dirty (rc=5) but seeds 1, 2, 4, 5 are clean, hard-abort
           # prevents salvage of the 4 clean seeds — § 11.1 W-11.x tables
           # explicitly mark these as "operator decides" recovery paths.
           echo "warn: resume Step 3.5.c seed $SID worktree contaminated (rc=$rc — branch mismatch / dirty / HEAD divergence)" >&2
           # W-B fix (Opus review 2026-04-25-172243): wrap (unset SEED_ID; ...)
           # subshell in rc-guard.
           if ! (unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" \
             append_journal_event "$(jq -cn \
               --argjson sid "$SID" \
               --argjson r "$rc" \
               '{event: "resume_worktree_contaminated", seed_id: $sid, rc: $r}')"); then
             echo "error: resume Step 3.5.c failed to append resume_worktree_contaminated for seed $SID" >&2
             exit 1
           fi
           # Coordinator AskUserQuestion: "Skip seed / Restore from branch tip /
           # Abort all of resume?" — same prose pattern as rc=3 above.
           echo "Step 3.5.c: AskUserQuestion required for seed $SID (contamination) — see § 11.1 W-11.x" >&2
           ;;
        *)
           # Unknown rc class — this IS a coordinator-internal contract violation
           # (validate_seed_worktree's rc taxonomy is fixed); hard-abort all of
           # resume rather than guess the recovery path. Same discipline as G9
           # W-3/W-4: do not silently coerce unknown error states.
           echo "error: resume Step 3.5.c validate_seed_worktree unexpected rc=$rc — contract violation, aborting resume" >&2
           exit 1
           ;;
      esac
    fi
  done
  fi  # end: if ! [ -z "${SEED_IDS:-}" ]
fi
```

### 3.5.d — Per-seed journal replay (git-log-is-truth, § 11.3)

Per § 11.3: subagents commit FIRST then append `committed` / `kept` /
`discarded`. Resume reconciles by treating worktree git log as authoritative.

For each active seed, tail its `seed_*` journal events to find the latest
`planned` event (if any). Then:
- If a matching commit exists on the seed's branch → synthesize
  `committed` event (with the actual commit SHA) and continue.
- If no matching commit exists → the subagent crashed before commit;
  discard the plan (no synthesis).
- If the latest event is already `committed` / `kept` / `discarded` /
  `seed_block_completed` → no reconciliation needed (Scenario 1: clean
  block boundary).

```bash
# W-A fix (Opus review 2026-04-25-172243): wrap entire body in explicit
# if/then/else/fi — see 3.5.a for rationale. No straddling fi (W-5).
if [ "${IS_V31:-0}" != "1" ]; then
  echo "3.5.d: skipping (IS_V31=0)" >&2
else
  # Loop guard symmetry (Opus review 2026-04-25-172243): mirror 3.5.c's
  # `if ! [ -z "${SEED_IDS:-}" ]` guard around the for loop.
  if ! [ -z "${SEED_IDS:-}" ]; then
  for SID in $SEED_IDS; do
    # W-B fix (Opus review 2026-04-25-172243): rc-guard WT_PATH python3 -c.
    if ! WT_PATH=$(python3 -c '
import yaml, sys
with open(sys.argv[1]) as f:
    sy = yaml.safe_load(f) or {}
for s in sy.get("virtual_parallel", {}).get("seeds", []):
    if s.get("id") == int(sys.argv[2]):
        print(s.get("worktree_path") or ""); break
' "$SESSION_ROOT/session.yaml" "$SID"); then
      echo "error: resume Step 3.5.d WT_PATH extraction failed for seed $SID" >&2
      exit 1
    fi
    [ -n "$WT_PATH" ] || continue   # skipped above

    # W-B fix: rc-guard TAIL python3 -c.
    if ! TAIL=$(python3 -c '
import json, sys
sid = int(sys.argv[2])
events = []
with open(sys.argv[1]) as f:
    for ln in f:
        try: ev = json.loads(ln)
        except json.JSONDecodeError: continue
        if ev.get("seed_id") == sid:
            events.append(ev)
if events:
    print(json.dumps(events[-1]))
else:
    print("{}")
' "$SESSION_ROOT/journal.jsonl" "$SID"); then
      echo "error: resume Step 3.5.d TAIL extraction failed for seed $SID" >&2
      exit 1
    fi

    # W-B fix: rc-guard TAIL_EVENT python3 -c.
    if ! TAIL_EVENT=$(echo "$TAIL" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("event",""))'); then
      echo "error: resume Step 3.5.d TAIL_EVENT extraction failed for seed $SID" >&2
      exit 1
    fi

    case "$TAIL_EVENT" in
      seed_block_completed|seed_block_failed|kept|discarded|committed|seed_killed)
        # Scenario 1: clean boundary — no reconciliation needed
        :
        ;;
      planned)
        # Scenario 2 or 3: check if the planned experiment was committed
        # W-B fix: rc-guard EXPECTED_SHA python3 -c.
        if ! EXPECTED_SHA=$(echo "$TAIL" | python3 -c '
import json,sys
print(json.load(sys.stdin).get("planned_commit_sha","") or "")'); then
          echo "error: resume Step 3.5.d EXPECTED_SHA extraction failed for seed $SID" >&2
          exit 1
        fi
        if [ -z "$EXPECTED_SHA" ]; then
          # No planned SHA recorded → use HEAD-vs-pre-plan delta as the test
          # C-1 fix (Opus review 2026-04-25-161635): WT_PATH is already absolute
          # (T2 cmd_create_seed_worktree returns "$SESSION_ROOT/worktrees/seed_K");
          # T32's append_seed_to_session_yaml stores it absolute. Prepending
          # $SESSION_ROOT here doubled the path → git -C silently failed → resume
          # always misclassified Scenario-2 as Scenario-3 (lost commits). Same
          # pattern as cmd_validate_seed_worktree (session-helper.sh:886) which
          # uses git -C "$wt_path" directly.
          # W-B fix: rc-guard git -C ... rev-parse HEAD.
          if ! HEAD_SHA=$(git -C "$WT_PATH" rev-parse HEAD); then
            echo "error: resume Step 3.5.d git rev-parse HEAD failed for seed $SID at $WT_PATH" >&2
            exit 1
          fi
          # W-B fix: rc-guard PRE_SHA python3 -c.
          if ! PRE_SHA=$(echo "$TAIL" | python3 -c '
import json,sys
print(json.load(sys.stdin).get("pre_plan_head_sha","") or "")'); then
            echo "error: resume Step 3.5.d PRE_SHA extraction failed for seed $SID" >&2
            exit 1
          fi
          if [ -n "$PRE_SHA" ] && [ "$HEAD_SHA" != "$PRE_SHA" ]; then
            # New commit since planned → synthesize committed (Scenario 2)
            # W-B fix: wrap (unset SEED_ID; ...) subshell in rc-guard.
            if ! (unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" \
              append_journal_event "$(jq -cn \
                --argjson sid "$SID" \
                --arg sha "$HEAD_SHA" \
                '{event: "committed", seed_id: $sid, commit: $sha,
                  synthesized_by: "resume_step_3_5_d"}')"); then
              echo "error: resume Step 3.5.d failed to append synthetic committed for seed $SID" >&2
              exit 1
            fi
          else
            # Plan abandoned (Scenario 3)
            # W-B fix: wrap (unset SEED_ID; ...) subshell in rc-guard.
            if ! (unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" \
              append_journal_event "$(jq -cn \
                --argjson sid "$SID" \
                '{event: "discarded", seed_id: $sid,
                  reason: "resume_no_matching_commit",
                  synthesized_by: "resume_step_3_5_d"}')"); then
              echo "error: resume Step 3.5.d failed to append synthetic discarded for seed $SID" >&2
              exit 1
            fi
          fi
        else
          # planned_commit_sha was recorded — check it exists
          # C-1 fix (Opus review 2026-04-25-161635): see HEAD_SHA above for the
          # path-doubling bug. WT_PATH is absolute; do not prepend $SESSION_ROOT.
          if git -C "$WT_PATH" cat-file -e "$EXPECTED_SHA" 2>/dev/null; then
            # Scenario 2 — synthesize committed
            # W-B fix: wrap (unset SEED_ID; ...) subshell in rc-guard.
            if ! (unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" \
              append_journal_event "$(jq -cn \
                --argjson sid "$SID" \
                --arg sha "$EXPECTED_SHA" \
                '{event: "committed", seed_id: $sid, commit: $sha,
                  synthesized_by: "resume_step_3_5_d"}')"); then
              echo "error: resume Step 3.5.d failed to append synthetic committed (planned_commit_sha path) for seed $SID" >&2
              exit 1
            fi
          else
            # Scenario 3
            # W-B fix: wrap (unset SEED_ID; ...) subshell in rc-guard.
            if ! (unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" \
              append_journal_event "$(jq -cn \
                --argjson sid "$SID" \
                '{event: "discarded", seed_id: $sid,
                  reason: "resume_no_matching_commit",
                  synthesized_by: "resume_step_3_5_d"}')"); then
              echo "error: resume Step 3.5.d failed to append synthetic discarded (planned_commit_sha path) for seed $SID" >&2
              exit 1
            fi
          fi
        fi
        ;;
      *)
        # Unknown / no events for this seed (newborn epoch_growth seed never
        # dispatched) → skip+warn
        echo "warn: resume Step 3.5.d seed $SID has no recognized tail event ($TAIL_EVENT); skipping" >&2
        ;;
    esac
  done
  fi  # end: if ! [ -z "${SEED_IDS:-}" ]
fi
# (W-5 fix: no straddling `fi` across markdown code-fences — gate is
# per-sub-stage and self-contained, with explicit if/else/fi inside this block.)
```

→ Proceed to Step 4 (Display resume summary).

## Step 4 — Display resume summary

### v2 Compatibility Banner (v3 code path)

Read `$SESSION_ROOT/session.yaml` and extract `deep_evolve_version`:

```bash
VERSION=$(grep '^deep_evolve_version:' "$SESSION_ROOT/session.yaml" | head -1 | sed 's/^deep_evolve_version:[[:space:]]*//; s/"//g')
```

IF `$VERSION` does NOT start with `3.` (i.e., `"2.2.2"` or earlier):
Display the following banner to the user before the progress summary:

```
⚠ This session uses v2.2.2 schema. v3 features (entropy tracking,
legibility enforcement, shortcut detection, diagnose-retry) are not
applied. Start a new session to enable them.
```

Then continue with the existing Step 4 flow (progress summary etc.).

ELSE ($VERSION starts with "3."):
No banner. Proceed directly to progress summary.

**Column-count auto-detect (v3 addition)**:

Read the first line of `$SESSION_ROOT/results.tsv`:

```bash
header_cols=$(head -1 "$SESSION_ROOT/results.tsv" | awk -F'\t' '{print NF}')
```

IF `$header_cols == 4`: v2 schema — columns are `commit score status description`.
IF `$header_cols == 9`: v3 schema — columns are `commit score status category score_delta loc_delta flagged rationale description`.
ELSE: abort with error: "Unexpected results.tsv column count: $header_cols. Expected 4 (v2) or 9 (v3)."

All downstream parsing in this report must use the detected column layout.

```
Deep Evolve 세션을 재개합니다

작업: <goal>
세션: <session_id>
진행: <inner_count>/<outer_interval> (generation <N>)
최근 실험: <last experiment n> <status> (score=<x>)
Q(v) 추이: <q_history values>
경고: <integrity check에서 발생한 이슈 요약>
다음: 실험 <n+1> 준비
```

## Step 5 — Re-enter experiment loop (VERSION_TIER dispatch)

Compute `VERSION_TIER` from `session.yaml.deep_evolve_version` (4-arm pattern
uniform with `init.md` Step 12 / `inner-loop.md` / `outer-loop.md` /
`synthesis.md` / `coordinator.md` — single source-of-truth):

```bash
VERSION=$(grep '^deep_evolve_version:' "$SESSION_ROOT/session.yaml" | sed 's/.*"\(.*\)".*/\1/')
case "$VERSION" in
  2.*)            VERSION_TIER="pre_v3" ;;
  3.0|3.0.*)      VERSION_TIER="v3_0" ;;
  3.*|4.*)        VERSION_TIER="v3_1_plus" ;;
  *)
    echo "warn: unrecognized VERSION='${VERSION:-<unset>}' — treating as pre_v3" >&2
    VERSION_TIER="pre_v3"
    ;;
esac
export VERSION_TIER
```

Then route based on `session.yaml.status` ⨯ `VERSION_TIER`:

If `session.yaml.status == paused`:
  → A crash occurred during an Outer Loop run (see `inner-loop.md` Step 6.5, which wraps
    Outer Loop in `mark_session_status paused/active`). Read `protocols/outer-loop.md`
    and execute from the beginning. Outer Loop's **Resume safety** section inspects
    `journal.jsonl` for each sub-step's completion event and skips already-completed
    phases, so restart is idempotent — no additional work required here. (Outer Loop
    branches internally on `VERSION_TIER`; v3.1+ paused sessions still resume their
    coordinator state via outer-loop.md → coordinator.md re-entry on next epoch
    boundary.)

If `session.yaml.status == active`:

- **`VERSION_TIER == v3_1_plus`** → **Read `protocols/coordinator.md`** (resume the
  multi-seed coordinator. Coordinator's main loop is journal-event idempotent;
  `scheduler-signals.py` synthesizes `in_flight_block` from journal so resume
  detects partially-dispatched seeds and skips already-completed blocks. Step 3.5
  reconciliation above has already validated yaml/journal seed-set drift via
  prefer-journal SOT.)

- **`VERSION_TIER ∈ {v3_0, pre_v3}`** → **Read `protocols/inner-loop.md`**, enter
  Section C with restored `inner_count`. Single-seed code path preserved unchanged
  for v3.0.x and v2.x sessions.
