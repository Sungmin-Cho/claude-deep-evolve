# Synthesis Protocol (v3.1.0+)

> **Version Gate** — Entry point for v3.1+ session-end synthesis.
> v2 / v3.0.x sessions MUST exit immediately and continue with
> `completion.md`. This file orchestrates the spec § 8.2 7-step
> sequence + spec § 8.5 N=1 short-circuit.

## Protocol Entry — Version Gate

Every entry to this protocol MUST initialize `$VERSION` locally.

```bash
VERSION=$(grep '^deep_evolve_version:' "$SESSION_ROOT/session.yaml" | head -1 | sed 's/^deep_evolve_version:[[:space:]]*//; s/"//g')
```

Then gate (W-1 fix: explicit pre-3.1 vs forward-compatible v3.1+ branches; future v3.2/v4 should NOT silently bail):

```bash
case "$VERSION" in
  2.*|3.0*)
    echo "synthesis.md: VERSION=$VERSION is pre-v3.1 — exiting; caller must continue with completion.md" >&2
    exit 0
    ;;
  3.*|4.*)
    # v3.1+ and forward proceed
    ;;
  *)
    echo "synthesis.md: VERSION=$VERSION unrecognized — treating as pre-v3.1; caller must continue with completion.md" >&2
    exit 0
    ;;
esac
```

Then resolve the helper-scripts directory (C-1 fix: `$DEEP_EVOLVE_HELPER_PATH` is the path to `session-helper.sh` itself, NOT a directory — every Python helper invocation must use `$HELPER_SCRIPTS_DIR` (= `dirname` of the helper) and every session-helper subcommand call must use `bash "$DEEP_EVOLVE_HELPER_PATH" <subcommand>` directly without an extra `/session-helper.sh` segment):

```bash
HELPER_SCRIPTS_DIR="$(dirname "$DEEP_EVOLVE_HELPER_PATH")"
```

The N=1 short-circuit (spec § 8.5) is checked BEFORE Step 1 to skip
the multi-seed sequence entirely:

```bash
if ! N_CURRENT=$(python3 -c '
import yaml, sys
with open(sys.argv[1]) as f:
    s = yaml.safe_load(f)
print(s.get("virtual_parallel", {}).get("n_current", 1))
' "$SESSION_ROOT/session.yaml"); then
  echo "synthesis.md Step 0: failed to read N_CURRENT from session.yaml" >&2
  exit 1
fi

if [ "$N_CURRENT" = "1" ]; then
  # Single-seed session: emit minimal report + synthesis_commit event,
  # skip Steps 2-6, jump directly to Step 7 (session_summary).
  goto_n1_branch=true
else
  goto_n1_branch=false
fi
```

When `goto_n1_branch=true`: skip to **§ N=1 Short-Circuit** below.
Otherwise proceed to Step 1.

## Step 1 — Collect final state (coordinator, no AI)

For each seed in `session.yaml.virtual_parallel.seeds`, gather:
- HEAD commit of `evolve/<sid>/seed-<k>` branch
- Notable keeps (from journal `kept` events filtered by seed_id)
- Final Q (from session.yaml.virtual_parallel.seeds[k].final_q OR last
  `kept` event q value)
- program.md content (read from `<seed_worktree>/program.md`)
- Key journal events (seed_initialized, seed_killed, n_adjusted)

Coordinator stores per-seed snapshots in memory for downstream steps.
No AI involvement.

## Step 2 — Generate per-seed reports (N subagent dispatches)

For each active or completed_early seed, dispatch a subagent in that
seed's worktree to write `completion/seed_reports/seed_<k>.md`.

The subagent prompt template (constructed via prose-contract per Q11/Q12;
no Task tool's `isolation: "worktree"` parameter — coordinator pre-cd's
to the worktree path before dispatch):

```
You are generating seed_<k>.md for the v3.1 session-end synthesis.

Working directory: <SESSION_ROOT>/worktrees/seed_<k>/
Output file: <SESSION_ROOT>/completion/seed_reports/seed_<k>.md

Read this seed's:
- journal.jsonl filtered by seed_id == <k>
- forum.jsonl events involving this seed
- All keep commits in this branch's git log
- Initial β direction from session.yaml.virtual_parallel.seeds[<k>].direction

Write seed_<k>.md with these sections (markdown):

1. **Initial β direction** — 1-paragraph summary of the seed's hypothesis
2. **Journey narrative** — 3-5 key keeps and their meaning, in chronological order
3. **Cross-seed exchange** — borrows given (this seed → other) + borrows received (other → this seed), with brief rationale
4. **Final status** — one of: active | killed_<reason> | completed_early
5. **Unique contributions** — what concepts this seed introduced that other seeds did not

Output ONLY the markdown file content. Do not modify code in this worktree.
```

Coordinator writes the per-seed reports sequentially (per Q11 prose
contract — no parallel Task dispatch in v3.1.0).

Killed seeds (status starts with `killed_`) are also dispatched a per-
seed report — the report explains why the kill fired + final Q at kill.

## Step 3 — Cross-seed audit (coordinator, no AI)

Invoke T26 cross-seed-audit.py:

```bash
python3 "$HELPER_SCRIPTS_DIR/cross-seed-audit.py" \
  --forum   "$SESSION_ROOT/forum.jsonl" \
  --journal "$SESSION_ROOT/journal.jsonl" \
  --output  "$SESSION_ROOT/completion/cross_seed_audit.md"
```

rc-guard:

```bash
if ! python3 "$HELPER_SCRIPTS_DIR/cross-seed-audit.py" \
    --forum "$SESSION_ROOT/forum.jsonl" \
    --journal "$SESSION_ROOT/journal.jsonl" \
    --output "$SESSION_ROOT/completion/cross_seed_audit.md"; then
  echo "synthesis.md Step 3: cross-seed-audit.py failed" >&2
  exit 1
fi
```

## Step 4 — Candidate selection (coordinator + AI)

From all seeds' notable keeps (collected in Step 1), AI picks top K
candidates balancing Q and diversity. K default = `min(3 * N, 15)`.

Build the candidate-selection prompt:

```
You are selecting integration candidates for the v3.1 session-end synthesis.

Session: <sid>
N: <n_current>
K (target candidate count): <min(3 * n_current, 15)>

For each seed, here are the notable keeps:
[list per seed: commit hash, q value, description, rationale]

Pick K candidates that:
- Cover diverse strategies (avoid 3 candidates that all do the same thing)
- Have evidence of working (high q, kept across multiple gens)
- Span seeds (don't pick all from one seed unless that seed dominates)

Return JSON: {"candidates": [{"commit": "<sha>", "seed_id": <k>, "rationale": "<1 sentence>"}, ...]}
```

Coordinator parses the AI response into `CANDIDATES` array (passed
to Step 5 as the integration set).

## Step 5 — AI synthesis execution

### 5.1 Baseline selection (deterministic, calls T25)

Build the seed snapshot list from session.yaml + journal:

```bash
if ! SEEDS_JSON=$(python3 -c '
import yaml, sys, json
with open(sys.argv[1]) as f:
    s = yaml.safe_load(f) or {}
seeds = s.get("virtual_parallel", {}).get("seeds", []) or []
out = []
for sd in seeds:
    out.append({
        "id": sd["id"],
        "status": sd.get("status", "active"),
        "killed_reason": sd.get("killed_reason"),
        "final_q": float(sd.get("final_q", 0.0)),
        "keeps": int(sd.get("keeps", 0)),
        "borrows_received": int(sd.get("borrows_received", 0)),
    })
print(json.dumps({"seeds": out}))
' "$SESSION_ROOT/session.yaml"); then
  echo "synthesis.md Step 5.1: failed to build SEEDS_JSON from session.yaml" >&2
  exit 1
fi

if ! BASELINE=$(python3 "$HELPER_SCRIPTS_DIR/baseline-select.py" --args "$SEEDS_JSON"); then
  echo "synthesis.md Step 5.1: baseline-select.py failed" >&2
  exit 1
fi
```

Parse the result:

```bash
if ! CHOSEN_SEED_ID=$(echo "$BASELINE" | jq -r '.chosen_seed_id'); then
  echo "synthesis.md Step 5.1: failed to parse CHOSEN_SEED_ID from BASELINE" >&2
  exit 1
fi
if ! TIER=$(echo "$BASELINE" | jq -r '.tier'); then
  echo "synthesis.md Step 5.1: failed to parse TIER from BASELINE" >&2
  exit 1
fi
if ! BASELINE_REASONING=$(echo "$BASELINE" | jq -c '.baseline_selection_reasoning'); then
  echo "synthesis.md Step 5.1: failed to parse BASELINE_REASONING from BASELINE" >&2
  exit 1
fi
```

Critical fix (T28 review): derive BASELINE_Q from SEEDS_JSON via CHOSEN_SEED_ID.
baseline-select.py only returns the chosen id (+ tier + reasoning), NOT the
final_q value — the actual final_q lives in session.yaml. Without this
derivation, BASELINE_Q would remain a literal placeholder string in Step 6
and any `float($BASELINE_Q)` / `--argjson bq $BASELINE_Q` call would fail
with ValueError / Invalid literal at EOF.

```bash
if ! BASELINE_Q=$(echo "$SEEDS_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin)
chosen = sys.argv[1]
if chosen in ("null", ""):
    print("0.0")
else:
    seed = next((s for s in d["seeds"] if str(s["id"]) == str(chosen)), None)
    print(seed["final_q"] if seed else 0.0)
' "$CHOSEN_SEED_ID" 2>&1); then
  echo "synthesis.md Step 5.1: failed to derive BASELINE_Q for chosen_seed_id=$CHOSEN_SEED_ID" >&2
  exit 1
fi
```

### 5.2 Handle no_baseline / best_effort tiers

```bash
# Initialize the variables Step 6 reads (C-4 fix: FALLBACK_TRIGGERED was
# unset on Branch B option 1 path → set -Eeuo pipefail abort at jq emit)
goto_step_7=false
goto_no_baseline=false
BEST_EFFORT_BASELINE=false
FALLBACK_TRIGGERED=false
# ITEM-2 Part A fix: preserve USER_CHOICE on re-entry — only initialize to
# empty when the variable has never been set. If the coordinator agent
# exported USER_CHOICE after AskUserQuestion and re-entered the protocol,
# the unconditional `USER_CHOICE=""` would silently discard the user's
# selection before the §6.1 case can read it.
if [ -z "${USER_CHOICE+x}" ]; then USER_CHOICE=""; fi

if [ "$TIER" = "no_baseline" ]; then
  # Spec § 8.2 Step 5.d: skip synthesis entirely; jump to no_baseline short-circuit.
  # C-5 fix: previously fell through to Step 6 with SYNTHESIS_Q/BASELINE_Q/
  # BASELINE_BRANCH all undefined → set -u abort. Now jumps to a dedicated
  # short-circuit section that sets all required synthesis_commit fields.
  goto_no_baseline=true
elif [ "$TIER" = "best_effort" ]; then
  # C-4 fix: prior plan stored "best_effort" in SYNTHESIS_OUTCOME_HINT only,
  # which Step 6 never read — so the "best_effort" enum value listed in
  # spec § 9.2 line 888 was never emitted. Use a flag the success path
  # consults to set SYNTHESIS_OUTCOME=best_effort instead of "success".
  BEST_EFFORT_BASELINE=true
fi
```

When `goto_no_baseline=true`: skip to **§ no_baseline Short-Circuit** below.

### 5.3 Resolve baseline HEAD commit + create synthesis worktree (calls T27)

Skip this step entirely on the no_baseline short-circuit (`goto_no_baseline=true`).

```bash
if [ "$goto_no_baseline" != "true" ]; then
  BASELINE_BRANCH="evolve/${SESSION_ID}/seed-${CHOSEN_SEED_ID}"

  # T28 review fix I-3: rc-guard git rev-parse so a missing/deleted baseline
  # branch produces a protocol-contextualized error instead of a raw git
  # message, and short-circuits before create_synthesis_worktree gets a
  # bogus argument.
  if ! BASELINE_HEAD=$(git rev-parse "$BASELINE_BRANCH" 2>&1); then
    echo "synthesis.md Step 5.3: branch $BASELINE_BRANCH not found: $BASELINE_HEAD" >&2
    exit 1
  fi

  if ! bash "$DEEP_EVOLVE_HELPER_PATH" \
      create_synthesis_worktree "$BASELINE_HEAD"; then
    echo "synthesis.md Step 5.3: create_synthesis_worktree failed" >&2
    exit 1
  fi
fi
```

### 5.4 Dispatch synthesis subagent (in synthesis worktree)

Coordinator pre-cd's to `$SESSION_ROOT/worktrees/synthesis` and
dispatches the AI synthesis subagent (prose-contract per Q11):

```
You are integrating N seeds' parallel-exploration results into a final deliverable.

Working directory: <SESSION_ROOT>/worktrees/synthesis/
You are starting from baseline seed <CHOSEN_SEED_ID> (final_q=<baseline_q>)
selected via the spec § 8.2 cascade (tier=<TIER>, ties_broken_on=<...>).

Integration candidates from Step 4:
[CANDIDATES with commit hash + rationale]

Per-seed summaries (from completion/seed_reports/):
[seed_<k>.md content for each seed]

Original goal: <session goal>

Tasks:
- Select mutually complementary candidates (exclude overlaps/conflicts).
- Re-implement selected concepts in this worktree (semantic integration,
  NOT cherry-pick — re-derive each idea in this codebase).
- Each integration commit: prefix with "synthesis:" + integration rationale.
- After integration, measure the worktree's final Q(v) using the
  evaluator pipeline.
- On failure to find a viable integration, return "synthesis_failed".

Budget: <synthesis_budget> experiments (default min(2*N, 10)),
        SEPARATE from session budget.
Early-fallback rule: if >50% budget spent without reaching baseline_q,
                     return "synthesis_failed" early.

Return: SYNTHESIS_Q=<final q value> (numeric) on success,
        or the literal string "synthesis_failed" on failure.
```

Coordinator captures `SYNTHESIS_Q` from the subagent's response.

## Step 6 — Validation & fallback ladder

Spec § 8.2 Step 6 3-branch decision. The outer `if [ "$goto_no_baseline" = "true" ]`
guard handles two distinct paths inline (R-1 fix from 2026-04-25-110xxx re-verify:
the prior `:` placeholder + dedicated `## § no_baseline Short-Circuit` section
was unreachable because §6.1/§6.2 ran unconditionally before reaching it,
hitting set -u on undefined `$FINAL_BRANCH`/`$SYNTHESIS_Q`/etc.):

1. **`goto_no_baseline=true` path**: set all synthesis_commit fields directly
   + emit synthesis_commit + fall through to Step 7 (session_summary). §6.1
   and §6.2 below are guarded with `if [ "$goto_no_baseline" != "true" ]` so
   they don't double-emit / no-op-cleanup on this path.
2. **Else path**: the full Branch A/B/C ladder + Step 6.1 + Step 6.2 below.

```bash
if [ "$goto_no_baseline" = "true" ]; then
  # R-1 fix (inlined from former § no_baseline Short-Circuit section):
  # set all required synthesis_commit fields directly so §6.1/§6.2/Step 7
  # below see well-defined variables (or are skipped via their guards).
  echo "synthesis.md Step 6: no_baseline tier — inline short-circuit (no synthesis attempted)" >&2

  SYNTHESIS_OUTCOME="no_baseline"
  SYNTHESIS_Q="0.0"
  SYNTHESIS_Q_NUMERIC="0.0"
  BASELINE_Q="0.0"
  CHOSEN_SEED_ID="null"
  FINAL_BRANCH="main"   # no synthesis branch produced — user keeps existing main
  FALLBACK_TRIGGERED=true
  USER_CHOICE=""
  SYNTHESIS_HEAD=""     # no synthesis HEAD; commit field is empty string

  # Emit synthesis_commit (subshell wraps SEED_ID per T16 auto-inject prevention).
  # spec § 9.2 line 888 lists `commit` as a required field — empty string is
  # the canonical "no commit produced" value (validated by downstream consumers).
  (unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" \
    append_journal_event "$(jq -nc \
      --arg branch "$FINAL_BRANCH" \
      --arg commit "" \
      --argjson sq 0 \
      --argjson bq 0 \
      --argjson reasoning "$BASELINE_REASONING" \
      '{event: "synthesis_commit",
        branch: $branch,
        commit: $commit,
        synthesis_q: $sq,
        baseline_q: $bq,
        baseline_seed_id: null,
        baseline_selection_reasoning: $reasoning,
        fallback_triggered: true,
        synthesis_outcome: "no_baseline"}')")

  # Continue to Step 7 (session_summary) — §6.1/§6.2 are guarded below to
  # be no-ops on this path.
else

# C-5 + W-2 fix: handle the synthesis_failed literal-string return from the
# subagent BEFORE attempting Q comparison. SYNTHESIS_Q="synthesis_failed"
# means subagent gave up early (>50% budget without reaching baseline_q,
# or no viable integration found). Route directly to Branch C without
# attempting `float("synthesis_failed")`.
if [ "$SYNTHESIS_Q" = "synthesis_failed" ]; then
  echo "synthesis.md Step 6: subagent returned synthesis_failed — routing to Branch C fallback" >&2
  SYNTHESIS_OUTCOME="fallback"
  FALLBACK_TRIGGERED=true
  FINAL_BRANCH="$BASELINE_BRANCH"
  SYNTHESIS_Q_NUMERIC="0.0"   # for downstream jq emit
else
  # C-2 fix: validate SYNTHESIS_Q is numeric immediately — if subagent
  # returned malformed output (anything other than a numeric string or
  # the literal "synthesis_failed"), reject before any python3 call
  # interpolates it. Without this, ANY further `float($SYNTHESIS_Q)`
  # interpolation could be a code-injection vector.
  if ! python3 -c 'import sys; float(sys.argv[1])' "$SYNTHESIS_Q" 2>/dev/null; then
    echo "synthesis.md Step 6: SYNTHESIS_Q=$SYNTHESIS_Q is not numeric and not synthesis_failed — treating as fallback" >&2
    SYNTHESIS_OUTCOME="fallback"
    FALLBACK_TRIGGERED=true
    FINAL_BRANCH="$BASELINE_BRANCH"
    SYNTHESIS_Q_NUMERIC="0.0"
  else
    SYNTHESIS_Q_NUMERIC="$SYNTHESIS_Q"
  fi
fi
# C-1 fix: normalize SYNTHESIS_Q to SYNTHESIS_Q_NUMERIC for ALL downstream
# consumers (§6.1 generate-fallback-note.py --synthesis-q, §6.2 jq --argjson sq).
# All three branches above (synthesis_failed, non-numeric, valid) set
# SYNTHESIS_Q_NUMERIC; reassign SYNTHESIS_Q here so that any future sink
# referencing $SYNTHESIS_Q is also safe automatically.
SYNTHESIS_Q="$SYNTHESIS_Q_NUMERIC"

# BASELINE_Q derived from session.yaml in Step 5.1 (above); reused here.
if ! REGRESSION_TOLERANCE=$(python3 -c '
import yaml, sys
with open(sys.argv[1]) as f:
    s = yaml.safe_load(f) or {}
print(s.get("virtual_parallel", {}).get("synthesis", {}).get("regression_tolerance", 0.05))
' "$SESSION_ROOT/session.yaml"); then
  echo "synthesis.md Step 6: failed to read REGRESSION_TOLERANCE from session.yaml" >&2
  exit 1
fi

if [ "${FALLBACK_TRIGGERED:-false}" != "true" ]; then
  # Branch A — synthesis succeeded (>= baseline)
  if python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) >= float(sys.argv[2]) else 1)" "$SYNTHESIS_Q_NUMERIC" "$BASELINE_Q"; then
    # C-4 fix: when baseline-select returned tier=best_effort, the success
    # outcome must be "best_effort" (per spec § 9.2 enum), NOT "success".
    if [ "$BEST_EFFORT_BASELINE" = "true" ]; then
      SYNTHESIS_OUTCOME="best_effort"
    else
      SYNTHESIS_OUTCOME="success"
    fi
    FALLBACK_TRIGGERED=false
    FINAL_BRANCH="evolve/${SESSION_ID}/synthesis"

  # Branch B — within regression tolerance (AskUserQuestion ladder)
  elif python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) >= (float(sys.argv[2]) - float(sys.argv[3])) else 1)" "$SYNTHESIS_Q_NUMERIC" "$BASELINE_Q" "$REGRESSION_TOLERANCE"; then
    # C-2 fix: compute the delta safely via argv — NOT via shell-interpolated
    # source string. The previous plan interpolated $SYNTHESIS_Q into the
    # python3 -c source; subagent-controlled output could contain quote
    # payloads that escape the literal (same C-R1 class as G8 queued_at).
    DELTA=$(python3 -c "import sys; print(f'{float(sys.argv[1]) - float(sys.argv[2]):+.4f}')" "$SYNTHESIS_Q_NUMERIC" "$BASELINE_Q")

    # C-3 fix: AskUserQuestion is a Claude Code TOOL CALL, not a bash
    # function. The PRIOR PLAN invoked `coordinator_ask_user_question` as
    # if it were a shell command — that helper does not exist anywhere in
    # the repo (verified by `grep -rn coordinator_ask_user_question`).
    # The correct pattern is PROSE INSTRUCTION to the coordinator agent
    # (mirroring `completion.md:178-237`). The bash block records the
    # delta + branch context; the coordinator agent (NOT this bash) then
    # invokes AskUserQuestion in its tool-use turn and exports USER_CHOICE
    # back into the bash environment for Step 6.1 to consume.
    cat <<EOM >&2
synthesis.md Step 6 Branch B — coordinator agent must invoke AskUserQuestion:

  Prompt:
    합성 결과 Q=${SYNTHESIS_Q_NUMERIC} 베이스라인 대비 ${DELTA}. 선택:
    (1) 합성 채택
    (2) 최고 seed 채택
    (3) 합성 폐기 + 원래 main 유지

  After the user responds, export USER_CHOICE=1 | 2 | 3 then re-enter
  this protocol at section "§ Step 6.1 (post-AskUserQuestion)".
EOM
    # Pause here for the agent to handle the tool call.
    # Tests can simulate by setting USER_CHOICE in the env before re-entry.
    SYNTHESIS_OUTCOME=""   # set by post-AskUserQuestion section below

  # Branch C — fallback to winner-take-all (regression beyond tolerance)
  else
    SYNTHESIS_OUTCOME="fallback"
    FALLBACK_TRIGGERED=true
    FINAL_BRANCH="$BASELINE_BRANCH"
  fi
fi

# ----------------------------------------------------------------------------
# § Step 6.1 (post-AskUserQuestion) — applies USER_CHOICE from Branch B
# ----------------------------------------------------------------------------
# T28 review fix I-1 (Option A): this section was previously its own
# separate fenced bash block, but the outer guard
# (if "$goto_no_baseline" = "true" ; then ... else ... fi) opened in the
# prior block and closed here — split across fences. If a runner
# concatenates each fence as a standalone script, the trailing fi would
# be a syntax error. Merged into the SAME fence as the Step 6 entry guard
# so the if/else/fi balances within one script.
#
# When the coordinator agent has captured USER_CHOICE via AskUserQuestion and
# re-entered this protocol, USER_CHOICE is exported in the environment and
# this case statement consumes it. Tests provide USER_CHOICE via env var.

# ITEM-2 Part B fix: remove the `[ -n "$USER_CHOICE" ]` outer guard — it
# blocked entry when USER_CHOICE is empty (dismissed/timed-out AskUserQuestion),
# leaving SYNTHESIS_OUTCOME="" and causing §6.2 to emit schema-invalid
# synthesis_outcome: "" + `git rev-parse ""` failure.
# `case "${USER_CHOICE:-}"` safely routes empty/dismissed values to the
# existing *) arm which already defaults to (3) discard (W-3 fix).
if [ -z "$SYNTHESIS_OUTCOME" ]; then
  case "${USER_CHOICE:-}" in
    1) SYNTHESIS_OUTCOME="accepted_with_regression"
       FINAL_BRANCH="evolve/${SESSION_ID}/synthesis"
       FALLBACK_TRIGGERED=false ;;
    2) SYNTHESIS_OUTCOME="fallback"
       FINAL_BRANCH="$BASELINE_BRANCH"
       FALLBACK_TRIGGERED=true ;;
    3) SYNTHESIS_OUTCOME="fallback"
       FINAL_BRANCH="main"
       FALLBACK_TRIGGERED=true ;;
    *)
      # W-3 fix: prior plan had no default arm — an unexpected USER_CHOICE
      # (empty, dismissed, malformed tool response) left both
      # SYNTHESIS_OUTCOME and FINAL_BRANCH unset → set -u abort at jq emit.
      # Conservative default: treat as discard (option 3) + log.
      echo "synthesis.md Step 6.1: unexpected USER_CHOICE='$USER_CHOICE' — defaulting to (3) discard" >&2
      SYNTHESIS_OUTCOME="fallback"
      FINAL_BRANCH="main"
      FALLBACK_TRIGGERED=true ;;
  esac
fi

fi   # close `if [ "$goto_no_baseline" = "true" ]; then : else ...` from Step 6 entry
```

### Step 6.1 (post-AskUserQuestion) — applies USER_CHOICE from Branch B

This is the same `case "$USER_CHOICE"` block embedded inside the Step 6
fence above. It is documented here as a separate logical section so that
Branch B re-entry has a named anchor (`§ Step 6.1 (post-AskUserQuestion)`)
referenced in the `cat <<EOM` instruction. The bash itself lives in the
single Step 6 fence — re-entry restarts the protocol from Step 5.1 with
USER_CHOICE pre-exported, so this case re-runs as part of the merged
Step 6 script (no mid-fence jump-in).

### 6.1 Fallback cleanup (Branch B option 2/3 + Branch C)

Skipped on the no_baseline path (the inline emit in Step 6 already
handled cleanup-equivalence: there's no synthesis worktree to clean up
because Step 5.3 was skipped). When `FALLBACK_TRIGGERED=true` AND we
took the normal Branch A/B/C path:

```bash
if [ "$goto_no_baseline" != "true" ] && [ "${FALLBACK_TRIGGERED:-false}" = "true" ]; then
  # Cleanup the failed synthesis worktree (preserves branch as
  # evolve/<sid>/synthesis-failed-<ts> for audit) — calls T27
  if ! bash "$DEEP_EVOLVE_HELPER_PATH" \
      cleanup_failed_synthesis_worktree; then
    echo "synthesis.md Step 6.1: cleanup_failed_synthesis_worktree failed" >&2
    # Non-fatal — continue to fallback note generation
  fi

  # Generate the fallback_note.md explaining why synthesis was discarded
  # (calls T29)
  if ! python3 "$HELPER_SCRIPTS_DIR/generate-fallback-note.py" \
      --session-yaml "$SESSION_ROOT/session.yaml" \
      --baseline-reasoning "$BASELINE_REASONING" \
      --synthesis-q "$SYNTHESIS_Q" \
      --baseline-q "$BASELINE_Q" \
      --user-choice "${USER_CHOICE:-none}" \
      --output "$SESSION_ROOT/completion/fallback_note.md"; then
    echo "synthesis.md Step 6.1: generate-fallback-note.py failed" >&2
    exit 1
  fi
fi
```

### 6.2 Emit synthesis_commit journal event

Skipped on the no_baseline path (the inline emit in Step 6 already
emitted the no_baseline-flavored synthesis_commit). Runs only on the
normal Branch A/B/C path.

Per spec § 9.2, the `synthesis_commit` event carries:
`branch, commit, synthesis_q, baseline_q, baseline_seed_id,
baseline_selection_reasoning, fallback_triggered, user_choice?,
synthesis_outcome` where outcome ∈ `{success, accepted_with_regression,
fallback, skipped_n1, no_baseline, best_effort}`.

Coordinator emits via `append_journal_event`, wrapped in `(unset SEED_ID; ...)`
because synthesis_commit is a session-wide event (no seed_id) and T16's
auto-inject would corrupt it:

```bash
if [ "$goto_no_baseline" != "true" ]; then
  SYNTHESIS_HEAD=$(git rev-parse "$FINAL_BRANCH" 2>/dev/null || echo "")

  (unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" \
    append_journal_event "$(jq -cn \
      --arg branch "$FINAL_BRANCH" \
      --arg commit "$SYNTHESIS_HEAD" \
      --argjson sq "$SYNTHESIS_Q" \
      --argjson bq "$BASELINE_Q" \
      --argjson bid "$CHOSEN_SEED_ID" \
      --argjson reasoning "$BASELINE_REASONING" \
      --argjson ft "$FALLBACK_TRIGGERED" \
      --arg uc "${USER_CHOICE:-}" \
      --arg outcome "$SYNTHESIS_OUTCOME" \
      '{event: "synthesis_commit",
        branch: $branch,
        commit: $commit,
        synthesis_q: $sq,
        baseline_q: $bq,
        baseline_seed_id: $bid,
        baseline_selection_reasoning: $reasoning,
        fallback_triggered: $ft,
        user_choice: (if $uc == "" then null else $uc end),
        synthesis_outcome: $outcome}')")
fi
```

## Step 7 — Session summary (coordinator, no AI)

Write `$SESSION_ROOT/completion/session_summary.md`:

```bash
mkdir -p "$SESSION_ROOT/completion"
cat > "$SESSION_ROOT/completion/session_summary.md" <<EOM
# Session Summary — $SESSION_ID

**Outcome**: $SYNTHESIS_OUTCOME
**Final branch**: $FINAL_BRANCH
**N**: $N_CURRENT seeds
**Synthesis Q**: $SYNTHESIS_Q (baseline Q: $BASELINE_Q)

## Reports

- [Cross-seed audit](cross_seed_audit.md)
$([ -d "$SESSION_ROOT/completion/seed_reports" ] && echo "- [Per-seed reports](seed_reports/)")
$([ -f "$SESSION_ROOT/completion/synthesis.md" ] && echo "- [Synthesis narrative](synthesis.md)")
$([ "$FALLBACK_TRIGGERED" = "true" ] && echo "- [Fallback rationale](fallback_note.md)")

EOM
```

## § N=1 Short-Circuit (spec § 8.5)

When `N_CURRENT == 1`, the coordinator entered this branch from the
top-level version gate and bypasses Steps 2-6:

```bash
# Step 1 (collect) is still useful for seed_1
# Skip Step 2 (only one seed; per-seed report still useful but trivial)

# Step 3 — emit minimal cross_seed_audit.md (cross-seed-audit.py
# auto-detects N=1 and writes 'N/A — single seed session')
# T28 review fix I-2: rc-guard matching the multi-seed Step 3 pattern.
if ! python3 "$HELPER_SCRIPTS_DIR/cross-seed-audit.py" \
    --forum "$SESSION_ROOT/forum.jsonl" \
    --journal "$SESSION_ROOT/journal.jsonl" \
    --output "$SESSION_ROOT/completion/cross_seed_audit.md"; then
  echo "synthesis.md § N=1 Short-Circuit: cross-seed-audit.py failed" >&2
  exit 1
fi

# Steps 4-6 — skipped entirely
SYNTHESIS_OUTCOME="skipped_n1"
FALLBACK_TRIGGERED=false
FINAL_BRANCH="evolve/${SESSION_ID}/seed-1"
if ! SYNTHESIS_Q=$(python3 -c '
import yaml, sys
with open(sys.argv[1]) as f:
    s = yaml.safe_load(f) or {}
seeds = s.get("virtual_parallel", {}).get("seeds", [])
print(seeds[0].get("final_q", 0.0) if seeds else 0.0)
' "$SESSION_ROOT/session.yaml"); then
  echo "synthesis.md § N=1 Short-Circuit: failed to read SYNTHESIS_Q from session.yaml" >&2
  exit 1
fi
BASELINE_Q="$SYNTHESIS_Q"
CHOSEN_SEED_ID=1

# W-5 fix: spec § 9.2 line 888 lists `commit` as a required seed_killed
# / synthesis_commit field. The N=1 short-circuit must include it.
SYNTHESIS_HEAD=$(git rev-parse "$FINAL_BRANCH" 2>/dev/null || echo "")

# Emit synthesis_commit event with outcome=skipped_n1
(unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" \
  append_journal_event "$(jq -cn \
    --arg branch "$FINAL_BRANCH" \
    --arg commit "$SYNTHESIS_HEAD" \
    --argjson sq "$SYNTHESIS_Q" \
    --argjson bid 1 \
    '{event: "synthesis_commit",
      branch: $branch,
      commit: $commit,
      synthesis_q: $sq,
      baseline_q: $sq,
      baseline_seed_id: $bid,
      baseline_selection_reasoning: {tier: "skipped_n1"},
      fallback_triggered: false,
      synthesis_outcome: "skipped_n1"}')")

# Continue to Step 7 (session_summary.md)
```

## § no_baseline Short-Circuit (spec § 8.2 Step 5.d)

**Note (R-1 fix from re-verify 2026-04-25)**: this short-circuit is now
**inlined into Step 6**'s outer `if [ "$goto_no_baseline" = "true" ]` guard
rather than living as a separate document section after §6.1/§6.2/Step 7.
The prior structure (separate section AFTER §6.1/§6.2/Step 7) was
unreachable on the no_baseline path because §6.2 ran with undefined
variables before reaching the section that would set them.

The inline implementation (inside Step 6, see above) sets all required
synthesis_commit fields and emits the event with `synthesis_outcome=no_baseline`
+ `fallback_triggered=true`, then falls through to §6.1 / §6.2 (both
guarded with `if [ "$goto_no_baseline" != "true" ]` so they're no-ops on
this path) and Step 7 (which writes session_summary.md unconditionally).

The behavioral test `test_no_baseline_short_circuit_inlined_in_step_6` (W-6)
now asserts the inline structure rather than the standalone section.

## Error handling

Any step's failure logs to stderr + exits non-zero. The coordinator
wrapping this protocol must rc-guard each Step's invocation per the
aff23c9 contract. Partial state (e.g. seed_reports/ written but
cross_seed_audit.md missing) is recoverable on a re-entry — the
protocol is designed to be re-run.

## Exit Back to Caller

On success, this protocol returns exit code 0 with `$FINAL_BRANCH`
pointing to the deliverable branch. Caller (G11 `commands/deep-evolve.md`)
is responsible for any post-synthesis push / PR / archive operations.
