"""synthesis.md protocol — § 8.2 7-step orchestration content checks.

Verifies the v3.1 synthesis protocol file contains the required
sections, version gate, step definitions, fallback ladder, N=1 short-
circuit, and integration points with T25 (baseline-select.py),
T26 (cross-seed-audit.py), T27 (create/cleanup synthesis worktree),
T29 (generate-fallback-note.py).
"""
import re
from pathlib import Path

PROTOCOL = (Path(__file__).parents[3]
            / "skills/deep-evolve-workflow/protocols/synthesis.md")


def _content():
    assert PROTOCOL.is_file(), f"synthesis.md must exist at {PROTOCOL}"
    return PROTOCOL.read_text(encoding="utf-8")


def test_protocol_file_exists():
    _content()


def test_version_gate_present():
    """v3.1+ only — v2/v3.0 sessions bail to completion.md."""
    c = _content()
    # Must match the foundation pattern from completion.md / outer-loop.md
    assert "deep_evolve_version" in c
    assert "VERSION" in c
    # Must explicitly bail to completion.md for non-3.1 sessions
    assert "completion.md" in c.lower() or "completion" in c.lower()


def test_step_1_collect_final_state_present():
    c = _content()
    assert re.search(r"## Step 1.*Collect", c, re.IGNORECASE)
    assert "final_q" in c.lower()
    assert "program.md" in c


def test_step_2_per_seed_report_subagent_dispatch():
    c = _content()
    assert re.search(r"## Step 2.*Per-seed", c, re.IGNORECASE)
    assert "seed_reports/seed_" in c
    # Must mention subagent dispatch (Q11 prose-contract)
    assert "subagent" in c.lower() or "Task tool" in c


def test_step_3_cross_seed_audit_invokes_t26():
    c = _content()
    assert re.search(r"## Step 3.*Cross-seed audit", c, re.IGNORECASE)
    assert "cross-seed-audit.py" in c
    assert "cross_seed_audit.md" in c


def test_step_4_candidate_selection_present():
    c = _content()
    assert re.search(r"## Step 4.*Candidate", c, re.IGNORECASE)
    # Spec wording: K = min(3 * N, 15)
    assert "min(3 * N, 15)" in c or "min(3*N, 15)" in c \
        or "3 * N" in c


def test_step_5_baseline_select_invokes_t25_and_t27():
    c = _content()
    assert re.search(r"## Step 5.*synthesis", c, re.IGNORECASE)
    assert "baseline-select.py" in c
    assert "create_synthesis_worktree" in c
    # Synthesis subagent dispatch
    assert "synthesis_budget" in c.lower() or "synthesis budget" in c.lower()


def test_step_6_validation_fallback_ladder_present():
    """Spec § 8.2 Step 6: 3-branch ladder
       (synthesis_Q >= baseline_Q → adopt
        synthesis_Q >= baseline_Q − tolerance → AskUserQuestion
        else → fallback to winner-take-all + fallback_note.md)
    """
    c = _content()
    assert re.search(r"## Step 6.*alidation|Fallback", c, re.IGNORECASE)
    # All three branches must be documented
    assert "regression_tolerance" in c
    assert "AskUserQuestion" in c
    assert "fallback_note.md" in c
    assert "fallback_triggered" in c
    # Both 'adopt' / 'success' and the fallback path
    assert "winner-take-all" in c.lower() or "winner take all" in c.lower()


def test_step_6_invokes_t27_cleanup_on_fallback():
    """Step 6 fallback branch must invoke cleanup_failed_synthesis_worktree."""
    c = _content()
    assert "cleanup_failed_synthesis_worktree" in c


def test_step_6_invokes_t29_generate_fallback_note():
    """Step 6 fallback branch must invoke T29's generate-fallback-note.py."""
    c = _content()
    assert "generate-fallback-note.py" in c


def test_step_7_session_summary_present():
    c = _content()
    assert re.search(r"## Step 7.*session summary|Session summary", c, re.IGNORECASE)
    assert "session_summary.md" in c


def test_synthesis_commit_journal_event_emitted():
    """Spec § 8.2 Step 5/6: synthesis_commit event with all required fields."""
    c = _content()
    assert "synthesis_commit" in c
    # Must mention key fields per spec § 9.2
    assert "synthesis_outcome" in c
    assert "baseline_seed_id" in c or "baseline_selection_reasoning" in c
    # All 6 outcome enum values must appear
    for outcome in ("success", "accepted_with_regression", "fallback",
                    "skipped_n1", "no_baseline", "best_effort"):
        assert outcome in c, f"missing synthesis_outcome value: {outcome}"


def test_n1_short_circuit_present():
    """Spec § 8.5: N=1 case skips Steps 2 (multi-)/4/5/6; Step 3 emits N/A."""
    c = _content()
    assert re.search(r"N=1|n_current.*1|single seed", c, re.IGNORECASE)
    # The N=1 path should explicitly bypass synthesis
    assert "skipped_n1" in c


def test_unset_seed_id_subshell_for_synthesis_commit():
    """Coordinator-owned synthesis_commit event must wrap append in
    `(unset SEED_ID; ...)` subshell per T16 auto-inject prevention
    (matches T20 convergence_event + T24 seed_killed)."""
    c = _content()
    # Must mention the unset SEED_ID pattern explicitly
    assert "unset SEED_ID" in c


# ---- W-6 fix: behavioral tests (assert routing, not just substring) ----

def test_helper_path_used_as_file_not_directory():
    """C-1 regression: $DEEP_EVOLVE_HELPER_PATH is the helper FILE
    (session-helper.sh path), NOT a directory. The protocol must NOT
    use $DEEP_EVOLVE_HELPER_PATH/<script>.py — the correct pattern is
    $HELPER_SCRIPTS_DIR/<script>.py (with HELPER_SCRIPTS_DIR computed
    via dirname). Mirrors inner-loop.md / outer-loop.md established
    pattern."""
    c = _content()
    import re
    # The misuse pattern: $DEEP_EVOLVE_HELPER_PATH followed by /
    # (which would generate a path like .../session-helper.sh/foo.py).
    misuse_pattern = re.compile(r'\$DEEP_EVOLVE_HELPER_PATH/')
    matches = misuse_pattern.findall(c)
    assert not matches, \
        f"C-1 regression: found {len(matches)} occurrences of " \
        f"$DEEP_EVOLVE_HELPER_PATH/ — must use $HELPER_SCRIPTS_DIR/<script>.py"
    # Confirm the corrected pattern IS present (no false-pass via empty file)
    assert "HELPER_SCRIPTS_DIR" in c, \
        "Must compute HELPER_SCRIPTS_DIR via dirname"
    assert 'dirname "$DEEP_EVOLVE_HELPER_PATH"' in c, \
        "Must use the established dirname pattern from inner-loop.md / outer-loop.md"


def test_no_python_dash_c_interpolates_synthesis_q():
    """C-2 regression: SYNTHESIS_Q (subagent-controlled output) must NOT
    be interpolated into a python3 -c source string. The safe pattern
    passes via sys.argv. Same regression class as G8 C-R1 (queued_at
    code injection)."""
    c = _content()
    import re
    # The misuse pattern: python3 -c "...'$SYNTHESIS_Q'..." (single-
    # quoted shell-interpolation inside python3 source)
    misuse_pattern = re.compile(
        r"python3 -c [\"'].*'\$SYNTHESIS_Q'", re.DOTALL,
    )
    matches = misuse_pattern.findall(c)
    assert not matches, \
        f"C-2 regression: SYNTHESIS_Q interpolated into python3 -c source — " \
        f"use argv (python3 -c '...' \"$SYNTHESIS_Q\") instead"


def test_no_fictional_coordinator_ask_user_question_function():
    """C-3 regression: AskUserQuestion is a Claude Code TOOL CALL, not a
    bash function. The PRIOR PLAN invented a `coordinator_ask_user_question`
    helper that does not exist anywhere in the repo. Branch B must use
    PROSE INSTRUCTION pattern (mirroring completion.md), not bash $()
    capture of a fictional helper."""
    c = _content()
    import re
    # The misuse pattern: USER_CHOICE=$(coordinator_ask_user_question ...
    misuse_pattern = re.compile(
        r"USER_CHOICE\s*=\s*\$\(coordinator_ask_user_question",
    )
    matches = misuse_pattern.findall(c)
    assert not matches, \
        f"C-3 regression: USER_CHOICE assigned via fictional bash helper — " \
        f"AskUserQuestion is a tool call, restructure as prose instruction"
    # Positive assertion: the protocol must reference AskUserQuestion as
    # an instruction to the coordinator agent (not as a callable)
    assert "AskUserQuestion" in c, "Branch B must instruct AskUserQuestion"


def test_fallback_triggered_initialized_before_step_6():
    """C-4 regression: FALLBACK_TRIGGERED must be initialized to false
    BEFORE Step 6 (or any branch within it). Without initialization,
    Branch B option 1 leaves it unset → set -u abort at jq emit."""
    c = _content()
    # The initialization should appear in Step 5.2 (before Step 6 entry)
    # or at the top of Step 6 itself
    assert "FALLBACK_TRIGGERED=false" in c, \
        "C-4: FALLBACK_TRIGGERED must be explicitly initialized to false"


def test_best_effort_outcome_actually_emitted():
    """C-4 regression: spec § 9.2 lists 'best_effort' as a valid
    synthesis_outcome. The protocol must have a code path that sets
    SYNTHESIS_OUTCOME='best_effort' (not just SYNTHESIS_OUTCOME_HINT)."""
    c = _content()
    assert 'SYNTHESIS_OUTCOME="best_effort"' in c, \
        "C-4: must emit synthesis_outcome=best_effort when baseline-select " \
        "tier=best_effort and synthesis succeeds"
    # The hint variable should NOT be the only place best_effort is set
    # (it was the bug — hint set but never consulted at emit time)
    assert "BEST_EFFORT_BASELINE" in c, \
        "C-4: must use BEST_EFFORT_BASELINE flag consulted at success path"


def test_no_baseline_short_circuit_inlined_in_step_6():
    """C-5 + R-1 regression: no_baseline must be handled INLINE inside
    Step 6's outer `if [ "$goto_no_baseline" = "true" ]` guard, NOT as
    a separate section after §6.1/§6.2/Step 7. The prior C-5 fix had a
    dedicated section but it was placed AFTER the Step 6.2 emit, which
    runs unconditionally on the no_baseline path with undefined
    variables → set -u abort BEFORE reaching the section that would
    set them. R-1 fix inlines the no_baseline emit into the `then`
    arm of Step 6's outer guard, then guards §6.1 and §6.2 with
    `if [ "$goto_no_baseline" != "true" ]` to skip them on this path."""
    c = _content()
    assert "goto_no_baseline" in c, \
        "C-5: must use goto_no_baseline flag (not goto_step_7) to gate Step 6"
    # Step 6 must explicitly check goto_no_baseline at entry
    assert 'if [ "$goto_no_baseline" = "true" ]' in c, \
        "C-5: Step 6 must guard on goto_no_baseline before any q-comparison"
    # The inline emit must contain SYNTHESIS_OUTCOME="no_baseline" + the
    # synthesis_commit append, all WITHIN the Step 6 outer guard's then arm
    # (i.e., NOT in a section that comes after §6.1/§6.2/Step 7).
    step_6_to_step_7 = c.split("## Step 6 — Validation")[1].split("## Step 7 —")[0]
    assert 'SYNTHESIS_OUTCOME="no_baseline"' in step_6_to_step_7, \
        "R-1: SYNTHESIS_OUTCOME=\"no_baseline\" must be set INSIDE Step 6 (not in a later section)"
    assert 'synthesis_outcome: "no_baseline"' in step_6_to_step_7, \
        "R-1: synthesis_commit emit with outcome=no_baseline must be INSIDE Step 6"
    # §6.1 and §6.2 must guard against no_baseline path (avoid double-emit
    # / undefined-variable abort)
    assert '[ "$goto_no_baseline" != "true" ]' in step_6_to_step_7, \
        "R-1: §6.1 and §6.2 must guard with `if [ \"$goto_no_baseline\" != \"true\" ]` " \
        "so they skip on the no_baseline path"


def test_step_6_handles_synthesis_failed_literal():
    """W-2 regression: subagent may return literal 'synthesis_failed'
    string. Step 6 must check for this BEFORE any float() interpolation,
    otherwise float('synthesis_failed') ValueError silently routes
    through the wrong branch with cryptic stderr."""
    c = _content()
    assert '"$SYNTHESIS_Q" = "synthesis_failed"' in c \
        or 'SYNTHESIS_Q == "synthesis_failed"' in c, \
        "W-2: must explicitly check for synthesis_failed literal"


def test_step_6_case_has_default_arm():
    """W-3 regression: Step 6.1 USER_CHOICE case must have *) default
    arm. Once C-3 is fixed and the case is reachable, an empty/malformed
    USER_CHOICE without a default arm leaves SYNTHESIS_OUTCOME unset →
    set -u abort at jq emit."""
    c = _content()
    # The case statement should have a *) arm with a defaulting comment
    assert "*)" in c and "defaulting" in c.lower(), \
        "W-3: case statement on USER_CHOICE must have *) default arm"


def test_n1_synthesis_commit_includes_commit_field():
    """W-5 regression: spec § 9.2 line 888 lists 'commit' as a required
    synthesis_commit field. The N=1 short-circuit's emit must include
    it (the main path's emit at Step 6.2 already does)."""
    c = _content()
    # Find the N=1 short-circuit section + verify it computes SYNTHESIS_HEAD
    assert "## § N=1 Short-Circuit" in c
    n1_section = c.split("## § N=1 Short-Circuit", 1)[1]
    # The emit in N=1 must include both SYNTHESIS_HEAD computation
    # and the commit field in the jq -cn build
    assert "SYNTHESIS_HEAD" in n1_section, \
        "W-5: N=1 must compute SYNTHESIS_HEAD via git rev-parse"
    assert "commit: $commit" in n1_section, \
        "W-5: N=1 synthesis_commit jq build must include `commit: $commit`"
