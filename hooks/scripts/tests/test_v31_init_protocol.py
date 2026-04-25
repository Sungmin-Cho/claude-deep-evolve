"""init.md A.1.6 / A.2 / A.3 v3.1 extensions — content + behavioral checks.

Verifies the v3.1 init protocol additions contain:
  - A.1.6 virtual-parallel analysis section (T30)
  - W-7 verbatim AI prompt for project_type / eval_parallelizability classification
  - JSON contract for AI return shape
  - N=1 short-circuit acknowledgement
  - Version gate ($VERSION == "3.1.0") so v2.x / v3.0.x bypass cleanly
  - W-6 trace: variables produced by A.1.6 (project_type, eval_parallelizability,
    n_suggested) flow into A.2's AskUserQuestion prompt and A.3's worktree loop —
    not just appear somewhere in the file.

T31 + T32 + T33 reuse this file. T30 owns scenarios 1–14 below.
"""
import re
import pytest
from pathlib import Path

PROTOCOL = (Path(__file__).parents[3]
            / "skills/deep-evolve-workflow/protocols/init.md")


def _content():
    assert PROTOCOL.is_file(), f"init.md must exist at {PROTOCOL}"
    return PROTOCOL.read_text(encoding="utf-8")


# ---------- T30: A.1.6 section ----------

def test_a16_section_header_present():
    """A.1.6 must be inserted between Stage 5 and A.2."""
    c = _content()
    assert "## A.1.6" in c, "A.1.6 section header missing"
    # Ordering invariant — A.1.6 comes after Stage 5 confirmation, before A.2
    a16_idx = c.index("## A.1.6")
    a2_idx = c.index("## A.2:")
    stage5_confirm_idx = c.index("Wait for user confirmation before proceeding.")
    assert stage5_confirm_idx < a16_idx < a2_idx, \
        "A.1.6 must sit between Stage 5 confirmation and A.2"


def test_a16_version_gate_present():
    """A.1.6 must be gated by $VERSION == '3.1.0' so v2 / v3.0 bypass cleanly."""
    c = _content()
    a16 = c.split("## A.1.6", 1)[1].split("## A.2:", 1)[0]
    # Version-gate idiom mirrors completion.md / synthesis.md (T28)
    assert "deep_evolve_version" in a16
    assert '"3.1.0"' in a16 or '3.1.0' in a16
    # Must explicitly skip when not 3.1.0 (mirrors v3.1 extension at A.3)
    assert re.search(r"(skip|bypass|not\s+3\.1)", a16, re.IGNORECASE), \
        "A.1.6 must say what to do for non-3.1 versions"


def test_a16_emits_three_axis_classification():
    """The section must instruct the AI to classify on project_type AND
    eval_parallelizability AND emit n_suggested."""
    c = _content()
    a16 = c.split("## A.1.6", 1)[1].split("## A.2:", 1)[0]
    assert "project_type" in a16
    assert "eval_parallelizability" in a16
    assert "n_suggested" in a16


def test_a16_project_type_enum_present():
    """W-7 lock: the three project_type values must appear verbatim."""
    c = _content()
    a16 = c.split("## A.1.6", 1)[1].split("## A.2:", 1)[0]
    for v in ("narrow_tuning", "standard_optimization", "open_research"):
        assert v in a16, f"project_type value '{v}' missing"


def test_a16_eval_parallelizability_enum_present():
    """W-7 lock: the two eval_parallelizability values must appear verbatim."""
    c = _content()
    a16 = c.split("## A.1.6", 1)[1].split("## A.2:", 1)[0]
    for v in ("serialized", "parallel_capable"):
        assert v in a16, f"eval_parallelizability value '{v}' missing"


def test_a16_w7_prompt_verbatim_matrix():
    """W-7 lock: the n_suggested derivation matrix must appear verbatim with
    all 6 (project_type × eval_parallelizability) cells. The plan locked this
    text — content drift would defeat the lock."""
    c = _content()
    a16 = c.split("## A.1.6", 1)[1].split("## A.2:", 1)[0]
    # All 6 matrix cells, each on the form '<combo> → <range>'
    pairs = [
        ("narrow_tuning + serialized", "1"),
        ("narrow_tuning + parallel_capable", "2"),
        ("standard_optimization + serialized", "2-3"),
        ("standard_optimization + parallel_capable", "3-5"),
        ("open_research + serialized", "3-4"),
        ("open_research + parallel_capable", "5-9"),
    ]
    for combo, expected in pairs:
        assert combo in a16, f"matrix cell '{combo}' missing"
        # The arrow + range must be on the same line as the combo
        line_with_combo = next((ln for ln in a16.splitlines() if combo in ln), "")
        assert expected in line_with_combo, \
            f"matrix cell '{combo}' missing range '{expected}'"


def test_a16_json_contract_present():
    """The JSON return contract must enumerate all 4 keys + n_suggested int range."""
    c = _content()
    a16 = c.split("## A.1.6", 1)[1].split("## A.2:", 1)[0]
    # 4 keys
    for k in ("project_type", "eval_parallelizability", "n_suggested", "reasoning"):
        assert f'"{k}"' in a16, f"JSON contract missing key '{k}'"
    # n_suggested int range explicit
    assert re.search(r"int\s*1[\s\-–]*9|integer.*1.*9|1-9|1.*to.*9", a16, re.IGNORECASE), \
        "n_suggested integer range 1-9 must be explicit"


def test_a16_n1_shortcircuit_acknowledged():
    """§ 5.1a — N=1 must be allowed as a valid AI suggestion; the section must
    NOT silently force N>=2 (would defeat single-seed sessions)."""
    c = _content()
    a16 = c.split("## A.1.6", 1)[1].split("## A.2:", 1)[0]
    # The matrix already includes 'narrow_tuning + serialized → 1', so just
    # verify the prose acknowledges N=1 is a legitimate outcome
    assert re.search(r"N\s*=\s*1|n[_\-]suggested.*1\b", a16, re.IGNORECASE)


def test_a16_validates_ai_return_before_consumption():
    """W-6 lesson: A.1.6 must validate the AI's JSON return (project_type in
    enum, eval_parallelizability in enum, n_suggested integer in [1,9]) BEFORE
    A.2 / A.3 consume the values. Without validation, malformed AI output
    propagates to session.yaml + worktree loop and corrupts state."""
    c = _content()
    a16 = c.split("## A.1.6", 1)[1].split("## A.2:", 1)[0]
    # Validation prose must mention checking each field
    assert re.search(r"valid|reject|sanitize|verify", a16, re.IGNORECASE), \
        "A.1.6 must validate AI return — W-6 trace lesson"
    # The fallback / re-prompt path must exist (don't silently accept malformed)
    assert re.search(r"re-?prompt|fallback|retry|abort", a16, re.IGNORECASE), \
        "A.1.6 must define what happens on malformed AI return"


def test_a16_outputs_ai_analysis_object_named():
    """W-6 trace setup: the validated AI return must be assigned to a named
    variable (e.g. AI_ANALYSIS / vp_analysis) that A.2 + A.3 reference. A free-
    floating description without a named handle defeats trace tests."""
    c = _content()
    a16 = c.split("## A.1.6", 1)[1].split("## A.2:", 1)[0]
    # The output handle must be explicitly named in the section. We accept
    # either of the two conventions used in v3.0 init.md (UPPER_SNAKE bash
    # var, or YAML-style key for the prose contract).
    assert re.search(
        r"AI_VP_ANALYSIS|VP_ANALYSIS|ai_vp_analysis|vp_analysis",
        a16,
    ), "A.1.6 must assign the validated AI return to a named handle"


def test_a16_non31_version_skips_to_a2():
    """v2.x / v3.0.x sessions: A.1.6 prose must explicitly say 'proceed to A.2'
    without performing the AI call. Without this, v3.0 sessions either crash
    on the unknown AI prompt or silently get a virtual_parallel block they
    can't consume."""
    c = _content()
    a16 = c.split("## A.1.6", 1)[1].split("## A.2:", 1)[0]
    # Must explicitly route non-3.1 to A.2 / skip
    assert re.search(
        r"proceed\s+to\s+A\.?2|skip\s+(this|to)|continue\s+to\s+A\.?2",
        a16,
        re.IGNORECASE,
    )


def test_a16_emits_journal_event_or_records_to_session_yaml():
    """The AI's analysis must be recorded — either as a journal event
    (init_vp_analysis) or as a session.yaml virtual_parallel field — so resume
    can re-derive intent without re-asking the AI. Otherwise the analysis is
    transient and re-init produces drift."""
    c = _content()
    a16 = c.split("## A.1.6", 1)[1].split("## A.2:", 1)[0]
    assert re.search(
        r"session\.ya?ml|virtual_parallel|init_vp_analysis|journal",
        a16,
        re.IGNORECASE,
    )


def test_a16_w6_trace_to_a2_prompt():
    """W-6 trace: the n_suggested value produced in A.1.6 must flow into A.2's
    AskUserQuestion prompt — not just appear in A.1.6 text. We verify by
    structural search: the validated handle name (or n_suggested literal) must
    appear in the A.2 section that follows."""
    c = _content()
    a2 = c.split("## A.2:", 1)[1].split("## A.2.5:", 1)[0]
    # T31 expansion will guarantee this — but we assert here in T30 because
    # the T30 author owns the contract from A.1.6 → A.2. If T31 is missing,
    # T30 is incomplete; the test should fail on either side.
    assert re.search(
        r"n_suggested|n[_\-]?suggested|VP_ANALYSIS|vp_analysis",
        a2,
        re.IGNORECASE,
    ), "A.2 must consume n_suggested / VP_ANALYSIS from A.1.6 (W-6 trace)"


@pytest.mark.xfail(strict=False, reason="T31/T32 will satisfy")
def test_a16_w6_trace_to_a3_loop():
    """W-6 trace: project_type + eval_parallelizability + N flow into A.3's
    worktree creation loop. Verified at the A.3 section level."""
    c = _content()
    # A.3 may have v3.1 extension subsection (T32 expansion)
    a3 = c.split("## A.3:", 1)[1].split("→ Proceed to Inner Loop", 1)[0]
    assert re.search(
        r"project_type|VP_ANALYSIS|virtual_parallel|n_current",
        a3,
        re.IGNORECASE,
    ), "A.3 must consume A.1.6's analysis (W-6 trace)"


# ---------- T31: A.2.6 N confirmation ----------

def test_a26_section_header_present():
    """A.2.6 must be inserted at the end of A.2, before A.2.5."""
    c = _content()
    assert "### A.2.6" in c, "A.2.6 sub-section header missing"
    a26_idx = c.index("### A.2.6")
    a25_idx = c.index("## A.2.5:")
    a2_idx = c.index("## A.2:")
    assert a2_idx < a26_idx < a25_idx, \
        "A.2.6 must sit inside A.2 (after A.2 prose, before A.2.5)"


def test_a26_version_gate_present():
    """A.2.6 must be gated by $VERSION == '3.1.0'."""
    c = _content()
    a26 = c.split("### A.2.6", 1)[1].split("## A.2.5:", 1)[0]
    assert "deep_evolve_version" in a26 or "VERSION" in a26
    assert '"3.1.0"' in a26 or '3.1.0' in a26


def test_a26_consumes_vp_analysis_handle():
    """W-6 trace: A.2.6 must consume the $VP_ANALYSIS handle from A.1.6 —
    not re-call the AI or read $AI_VP_ANALYSIS_RAW."""
    c = _content()
    a26 = c.split("### A.2.6", 1)[1].split("## A.2.5:", 1)[0]
    assert "$VP_ANALYSIS" in a26 or "VP_ANALYSIS" in a26
    # Must NOT re-call AI for n_suggested
    assert "AI_VP_ANALYSIS_RAW" not in a26, \
        "A.2.6 must consume the validated $VP_ANALYSIS, not re-call the AI"


def test_a26_askuserquestion_cost_estimate_in_prompt():
    """The AskUserQuestion prompt must include the cost estimate so users
    understand what they are confirming. Without this, users default-accept
    without budget awareness."""
    c = _content()
    a26 = c.split("### A.2.6", 1)[1].split("## A.2.5:", 1)[0]
    # Cost-estimate prose: must mention budget / cost / experiments / 비용
    assert re.search(
        r"cost|budget|experiments?|비용|예상\s*실험|estimate",
        a26,
        re.IGNORECASE,
    ), "A.2.6 prompt must surface cost estimate"


def test_a26_honors_no_parallel_env_var():
    """--no-parallel CLI flag → DEEP_EVOLVE_NO_PARALLEL env var → forces N=1.
    A.2.6 must check this BEFORE the AskUserQuestion call (don't ask user
    a question whose answer is already determined)."""
    c = _content()
    a26 = c.split("### A.2.6", 1)[1].split("## A.2.5:", 1)[0]
    assert "DEEP_EVOLVE_NO_PARALLEL" in a26
    # Env-var check must precede AskUserQuestion call
    no_par_idx = a26.index("DEEP_EVOLVE_NO_PARALLEL")
    ask_idx = a26.index("AskUserQuestion") if "AskUserQuestion" in a26 else len(a26)
    assert no_par_idx < ask_idx, \
        "DEEP_EVOLVE_NO_PARALLEL check must precede AskUserQuestion"


def test_a26_honors_n_min_n_max_env_vars():
    """--n-min / --n-max → DEEP_EVOLVE_N_MIN / DEEP_EVOLVE_N_MAX → clamp the
    AI suggestion + clamp the user's response if they typed a number outside
    the range."""
    c = _content()
    a26 = c.split("### A.2.6", 1)[1].split("## A.2.5:", 1)[0]
    assert "DEEP_EVOLVE_N_MIN" in a26
    assert "DEEP_EVOLVE_N_MAX" in a26


def test_a26_clamps_to_global_range_then_user_range():
    """N must be clamped to [1, 9] (global) AND [N_MIN, N_MAX] (user-override).
    Order: clamp suggestion to user range first, then global range — so user-
    requested 0 doesn't sneak through the global clamp."""
    c = _content()
    a26 = c.split("### A.2.6", 1)[1].split("## A.2.5:", 1)[0]
    # Clamp prose / code must mention both ranges
    assert "1" in a26 and "9" in a26  # global bounds in prose / code
    assert "max(" in a26 or "min(" in a26 or "clamp" in a26.lower()


def test_a26_exports_n_chosen_handle():
    """W-6 trace: A.2.6 must export a $N_CHOSEN (or N_CURRENT) handle that
    A.3 reads as the worktree-loop bound. Without an explicit handle, A.3
    has to re-derive N from session.yaml or re-call the AI."""
    c = _content()
    a26 = c.split("### A.2.6", 1)[1].split("## A.2.5:", 1)[0]
    assert re.search(
        r"\$N_CHOSEN|\bN_CHOSEN\b|\$N_CURRENT|\bN_CURRENT\b",
        a26,
    ), "A.2.6 must export an N handle for A.3 to consume"


def test_a26_w6_trace_n_chosen_to_a3():
    """W-6 trace: $N_CHOSEN flows into A.3's worktree loop. Verified at
    A.3 v3.1 extension level."""
    c = _content()
    a3 = c.split("## A.3:", 1)[1].split("→ Proceed to Inner Loop", 1)[0]
    assert re.search(
        r"\$N_CHOSEN|\bN_CHOSEN\b|\$N_CURRENT|\bN_CURRENT\b|n_current",
        a3,
    ), "A.3 must consume $N_CHOSEN from A.2.6 (W-6 trace)"
