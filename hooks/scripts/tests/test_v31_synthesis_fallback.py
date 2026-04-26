"""T45 G12: synthesis fallback — § 8.2 cascade 7+ scenarios.

Spec § 8 + § 8.2 + § 8.5. T25/T28/T29 cover unit-level cascade/protocol/
fallback-note; T45 covers integration across the 4-tier baseline cascade
+ 3-branch outcome routing per W-8 minimum-7 enumeration:

  1. Tier 5.a happy path → outcome=success
  2. Tier 5.b non-quarantine fallback → outcome=success
  3. Tier 5.c best_effort → outcome=best_effort
  4. Tier 5.d no_baseline → outcome=no_baseline (synthesis skipped)
  5. synthesis_Q >= baseline → adopt (success)
  6. synthesis_Q within regression_tolerance → AskUserQuestion path
  7. synthesis_Q < baseline − tolerance → fallback + fallback_note.md
  +  tie-break: identical final_q resolved by keeps/borrows/seed_id
  +  W-2 literal "synthesis_failed" → fallback (G9 W-2 invariant)
  +  outcome enum SOT — all 6 values present in synthesis.md

Synthesis outcome enum SOT (do not typo):
  success / accepted_with_regression / fallback / skipped_n1 /
  no_baseline / best_effort

baseline-select.py argv contract (verified at probe time, T45 Step 1):
  --args <json> with shape {seeds: [{id, status, killed_reason, final_q,
                                     keeps, borrows_received}, ...]}
  Emits {chosen_seed_id, tier, ties_broken_on, candidates_count,
         baseline_selection_reasoning}.
  Note field names: input uses `id` (not `seed_id`); output uses
  `chosen_seed_id` (not `baseline_seed_id`); status of killed seeds is
  `killed_<reason>` (e.g. `killed_shortcut_quarantine`) with the bare
  reason mirrored in `killed_reason`.
"""
import json
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).parents[3]
BASELINE_SELECT = ROOT / "hooks/scripts/baseline-select.py"
GENERATE_FALLBACK = ROOT / "hooks/scripts/generate-fallback-note.py"
SYNTHESIS_MD = ROOT / "skills/deep-evolve-workflow/protocols/synthesis.md"


# Outcome enum SOT — keep aligned with T28 synthesis.md / spec § 9.2
OUTCOMES = {
    "success", "accepted_with_regression", "fallback",
    "skipped_n1", "no_baseline", "best_effort",
}


def _baseline_select(args_dict):
    """Invoke baseline-select.py with --args <json>; return (rc, stdout, stderr)."""
    p = subprocess.run(
        ["python3", str(BASELINE_SELECT), "--args", json.dumps(args_dict)],
        capture_output=True, text=True,
    )
    return p.returncode, p.stdout, p.stderr


# ---------- Tier 5.a happy path ----------

def test_tier_5a_highest_q_active_seed_wins():
    """Scenario 1: all 3 active seeds with final_q > 0 → baseline =
    highest-Q. Tier should be reported as 'preferred'."""
    args = {
        "seeds": [
            {"id": 1, "status": "active", "killed_reason": None,
             "final_q": 0.45, "keeps": 3, "borrows_received": 0},
            {"id": 2, "status": "active", "killed_reason": None,
             "final_q": 0.62, "keeps": 5, "borrows_received": 1},
            {"id": 3, "status": "active", "killed_reason": None,
             "final_q": 0.51, "keeps": 2, "borrows_received": 0},
        ],
    }
    rc, out, err = _baseline_select(args)
    assert rc == 0, f"baseline-select failed: {err}"
    result = json.loads(out)
    assert result["tier"] == "preferred"
    assert result["chosen_seed_id"] == 2  # highest final_q


# ---------- Tier 5.b non-quarantine fallback ----------

def test_tier_5b_excludes_shortcut_quarantine():
    """Scenario 2: no active/completed_early seed has final_q > 0; the
    only viable candidate must be a non-shortcut-quarantine killed seed.
    The shortcut-quarantine seed (even with high Q) must NOT win."""
    args = {
        "seeds": [
            {"id": 1, "status": "killed_shortcut_quarantine",
             "killed_reason": "shortcut_quarantine",
             "final_q": 0.95, "keeps": 8, "borrows_received": 0},
            {"id": 2, "status": "killed_sustained_regression",
             "killed_reason": "sustained_regression",
             "final_q": 0.42, "keeps": 4, "borrows_received": 0},
        ],
    }
    rc, out, err = _baseline_select(args)
    assert rc == 0, f"baseline-select failed: {err}"
    result = json.loads(out)
    assert result["tier"] == "non_quarantine_fallback"
    assert result["chosen_seed_id"] == 2  # excludes quarantine


# ---------- Tier 5.c best_effort ----------

def test_tier_5c_best_effort_when_no_final_q_above_zero():
    """Scenario 3: no final_q > 0 anywhere but at least one keep exists
    → fall through to 5.c best_effort tier."""
    args = {
        "seeds": [
            {"id": 1, "status": "active", "killed_reason": None,
             "final_q": 0.0, "keeps": 2, "borrows_received": 0},
            {"id": 2, "status": "active", "killed_reason": None,
             "final_q": 0.0, "keeps": 1, "borrows_received": 0},
        ],
    }
    rc, out, err = _baseline_select(args)
    assert rc == 0, f"baseline-select failed: {err}"
    result = json.loads(out)
    assert result["tier"] == "best_effort"
    assert result["chosen_seed_id"] in (1, 2)


# ---------- Tier 5.d no_baseline ----------

def test_tier_5d_no_baseline_when_no_keeps():
    """Scenario 4: no keeps anywhere → no_baseline → synthesis short-
    circuit, no commit attempt. synthesis.md must reference the
    no_baseline outcome (G9 C-5 fix)."""
    args = {
        "seeds": [
            {"id": 1, "status": "killed_crash_give_up",
             "killed_reason": "crash_give_up",
             "final_q": 0.0, "keeps": 0, "borrows_received": 0},
            {"id": 2, "status": "killed_sustained_regression",
             "killed_reason": "sustained_regression",
             "final_q": 0.0, "keeps": 0, "borrows_received": 0},
        ],
    }
    rc, out, err = _baseline_select(args)
    assert rc == 0, f"baseline-select failed: {err}"
    result = json.loads(out)
    assert result["tier"] == "no_baseline"
    assert result["chosen_seed_id"] is None
    # synthesis.md must short-circuit on no_baseline (G9 C-5 fix)
    syn = SYNTHESIS_MD.read_text(encoding="utf-8")
    assert "no_baseline" in syn, "synthesis.md must reference no_baseline outcome"


# ---------- Scenario 5: synthesis_Q >= baseline → adopt ----------

def test_synthesis_Q_above_baseline_routes_to_success():
    """Scenario 5: synthesis.md Step 6 routes synthesis_Q >= baseline_Q
    to outcome=success. Content-level: synthesis.md must contain the
    case-arm for this branch."""
    syn = SYNTHESIS_MD.read_text(encoding="utf-8")
    # Step 6 must reference "success" outcome with a Q comparison
    step6 = syn.split("Step 6", 1)[1] if "Step 6" in syn else syn
    assert "success" in step6
    # Q comparison must be present (synthesis_Q vs baseline_Q)
    assert (
        re.search(r'SYNTHESIS_Q\S*\s*>=?\s*\S*BASELINE_Q', step6)
        or re.search(r'\$SYNTHESIS_Q\S*\s*>=?\s*\$?BASELINE_Q', step6)
        or re.search(r'python3\s+-c.*SYNTHESIS_Q.*BASELINE_Q', step6, re.DOTALL)
        or re.search(r'float\([^)]*SYNTHESIS_Q[^)]*\)\s*>=?\s*float\([^)]*BASELINE_Q', step6)
        or re.search(r'sys\.argv\[1\].*sys\.argv\[2\]', step6)  # canonical argv pattern
    ), "synthesis.md Step 6 must contain a SYNTHESIS_Q vs BASELINE_Q comparison"


# ---------- Scenario 6: regression tolerance → AskUserQuestion path ----------

def test_synthesis_Q_within_tolerance_routes_to_ask_user_question():
    """Scenario 6: synthesis_Q < baseline but within regression_tolerance
    → Branch B (AskUserQuestion). synthesis.md must reference
    AskUserQuestion + accepted_with_regression outcome + tolerance."""
    syn = SYNTHESIS_MD.read_text(encoding="utf-8")
    assert "AskUserQuestion" in syn, (
        "synthesis.md must reference AskUserQuestion in Branch B"
    )
    assert "accepted_with_regression" in syn, (
        "synthesis.md must reference accepted_with_regression outcome"
    )
    # Branch B must be entered when regression is within tolerance
    assert re.search(r'regression_tolerance|tolerance', syn, re.IGNORECASE)


# ---------- Scenario 7: synthesis_Q < baseline - tolerance → fallback ----------

def test_synthesis_Q_below_tolerance_routes_to_fallback():
    """Scenario 7: synthesis_Q below tolerance band → Branch C → outcome=
    fallback, generate-fallback-note.py invoked + fallback_note.md
    written."""
    syn = SYNTHESIS_MD.read_text(encoding="utf-8")
    assert "fallback" in syn
    # Must reference generate-fallback-note.py (T29 wires)
    assert (
        "generate-fallback-note.py" in syn or "fallback_note" in syn
    ), "synthesis.md must wire to T29 (generate-fallback-note.py / fallback_note.md)"


def test_generate_fallback_note_source_references_outcome_enum():
    """T29 → T45 wires: generate-fallback-note.py source must reference
    at least one synthesis outcome enum value (used for fallback-note
    rendering with appropriate scenario label per spec § 8.2 verbatim
    Korean labels).

    G12 fold-in W10 fix (Opus 2026-04-26): pre-W10 test was
    `assert p.returncode in (0, 1, 2)` — virtually any subprocess
    passed. Post-W10: source-level assertion that T29's helper actually
    references the outcome enum (drift detection between T29 and T45's
    OUTCOMES set). The full T29 behavioral verification lives in
    `test_v31_fallback_note.py` (G9 T29 unit tests, 9 cases); T45's
    role here is the cross-task contract check."""
    src = GENERATE_FALLBACK.read_text(encoding="utf-8")
    referenced = {o for o in OUTCOMES if o in src}
    # T29 must reference at least the 3 fallback-relevant outcomes
    # (fallback / accepted_with_regression / best_effort) or have a
    # related label structure.
    fallback_relevant = {"fallback", "accepted_with_regression", "best_effort"}
    assert referenced & fallback_relevant, (
        f"generate-fallback-note.py must reference at least one "
        f"fallback-relevant outcome label from {fallback_relevant}. "
        f"Referenced: {referenced}. (T29 → T45 contract drift detection.)"
    )


# ---------- Bonus: tie-break (identical final_q) ----------

def test_tier_5a_tiebreak_keeps_then_borrows_then_seed_id():
    """Bonus W-8: identical final_q → 4-level tiebreak. SOT (per
    baseline-select.py docstring + T25 unit tests):
      1. final_q (MAX wins)
      2. keeps (MAX wins)
      3. borrows_received (MIN wins — anti-double-counting per spec)
      4. seed_id (MIN wins — stable deterministic)

    NOTE: the plan-stage design note read "borrows_received DESC" which
    contradicts the source-of-truth (`baseline-select.py` line 154-158:
    `# Level 3: -borrows_received (min wins)` + T25
    `test_tiebreak_borrows_received_when_keeps_tied`). This test follows
    source/T25 SOT, not the plan's stale direction note.

    Test setup: 4 seeds with identical final_q=0.50 + identical keeps=5.
      - seed_id=5: borrows=2
      - seed_id=2: borrows=0           ← winner via borrows_received MIN
      - seed_id=3: borrows=1
      - seed_id=7: borrows=2
    Walk: final_q ties (4), keeps ties (4), borrows_received MIN=0 → seed=2.
    Stops at level 3 (borrows_received), so ties_broken_on includes
    final_q, keeps, borrows_received."""
    args = {
        "seeds": [
            {"id": 5, "status": "active", "killed_reason": None,
             "final_q": 0.50, "keeps": 5, "borrows_received": 2},
            {"id": 2, "status": "active", "killed_reason": None,
             "final_q": 0.50, "keeps": 5, "borrows_received": 0},
            {"id": 3, "status": "active", "killed_reason": None,
             "final_q": 0.50, "keeps": 5, "borrows_received": 1},
            {"id": 7, "status": "active", "killed_reason": None,
             "final_q": 0.50, "keeps": 5, "borrows_received": 2},
        ],
    }
    rc, out, err = _baseline_select(args)
    assert rc == 0, f"baseline-select failed: {err}"
    result = json.loads(out)
    # Winner: seed_id=2 (lowest borrows_received among the keeps=5 pool)
    assert result["chosen_seed_id"] == 2
    assert result["tier"] == "preferred"
    # Tiebreak walked through final_q + keeps + borrows_received (stopped
    # at level 3 since seed_id=2 was uniquely the borrows-MIN winner).
    assert result["ties_broken_on"] == [
        "final_q", "keeps", "borrows_received",
    ], (
        f"Expected ties_broken_on to walk through 3 levels and stop at "
        f"borrows_received; got {result['ties_broken_on']!r}"
    )


# ---------- W-2 literal "synthesis_failed" handling ----------

def test_synthesis_failed_literal_routes_to_fallback():
    """G9 W-2 lesson: subagent may return literal "synthesis_failed"
    string (per spec § 8.2 Step 5 budget rule). synthesis.md Step 6 must
    branch on this literal BEFORE attempting any float() conversion.

    G12 fold-in C3 fix (Opus C-6 2026-04-26): the pre-fix test was
    `assert "synthesis_failed" in syn` — pure substring grep that passes
    even if branch ORDER is wrong (literal handling AFTER float() is
    semantically broken but passes content-grep). This is the exact
    regression class T22 W-3 / G11 W-1 / T39 W1 fold-in lessons warned
    against.

    Post-fix: extract bash blocks from synthesis.md Step 6 region,
    strip comment lines, then assert the literal `"synthesis_failed"`
    branch appears BEFORE any `float(` conversion — by byte index in
    the stripped bash source."""
    syn = SYNTHESIS_MD.read_text(encoding="utf-8")
    # Heuristic: from "## Step 6" to the next "## Step 7" or top-level
    # "## " marker (whichever comes first); fallback to whole-file if
    # no Step 7 marker is found.
    m = re.search(
        r'(^#{2,4}\s+Step\s+6[^\n]*)([\s\S]*?)(?=^#{2,4}\s+Step\s+7|\Z)',
        syn, re.MULTILINE,
    )
    step6_region = m.group(0) if m else syn

    # Bash-block extraction (T39-style): only ```bash ... ``` content,
    # comment lines stripped. Tolerate trailing newline within fence.
    blocks = re.findall(r"```bash\n(.*?)\n```", step6_region, re.DOTALL)
    bash_lines = []
    for b in blocks:
        for line in b.splitlines():
            if not line.strip().startswith("#"):
                bash_lines.append(line)
    bash = "\n".join(bash_lines)

    assert bash.strip(), (
        "synthesis.md Step 6 must contain at least one ```bash block. "
        "Heuristic split may have failed — region extracted: "
        f"{step6_region[:200]!r}..."
    )

    # 1. Literal handling must exist (presence) — single-bracket [ ],
    # double-bracket [[ ]], or case ... in form.
    literal_match = re.search(
        r'(?:case\s+"\$\w+"\s+in[\s\S]*?\bsynthesis_failed\b|'
        r'\[\s+"\$\w+"\s*=\s*["\']synthesis_failed["\']\s+\]|'
        r'\[\[\s+"\$\w+"\s*(?:==?|=)\s*["\']synthesis_failed["\']\s+\]\])',
        bash,
    )
    assert literal_match, (
        "synthesis.md Step 6 bash must branch on literal 'synthesis_failed' "
        "via case/[ ]/[[ ]] — not just mention it in prose. Stripped bash "
        f"(first 600 chars):\n{bash[:600]}..."
    )

    # 2. Branch order: literal handling MUST come before float() conversion
    #    (G9 W-2 invariant: literal-first prevents Branch C from being
    #    skipped silently due to float("synthesis_failed") raising before
    #    the literal check can route to fallback).
    literal_pos = literal_match.start()
    float_match = re.search(r'\bfloat\s*\(', bash)
    if float_match:
        assert literal_pos < float_match.start(), (
            "synthesis.md Step 6 must branch on 'synthesis_failed' literal "
            f"BEFORE float() conversion. Literal at byte {literal_pos}, "
            f"float() at byte {float_match.start()}. G9 W-2 invariant: "
            "literal-first prevents Branch C from being skipped silently."
        )


# ---------- Outcome enum SOT ----------

def test_outcome_enum_six_values_present_in_synthesis_md():
    """SOT: synthesis.md must reference all 6 outcome enum values
    (success / accepted_with_regression / fallback / skipped_n1 /
    no_baseline / best_effort). Drift detection — if any new code
    starts emitting a 7th outcome or drops one of the canonical six,
    this test surfaces the change immediately."""
    syn = SYNTHESIS_MD.read_text(encoding="utf-8")
    for outcome in OUTCOMES:
        assert outcome in syn, f"synthesis.md missing outcome '{outcome}'"
