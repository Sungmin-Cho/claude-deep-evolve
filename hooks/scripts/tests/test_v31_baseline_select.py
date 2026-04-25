"""baseline-select.py — § 8.2 Step 5 cascading baseline selector.

Pure function (no git, no LLM, no filesystem mutation). Caller pre-
extracts seed snapshots from session.yaml.virtual_parallel.seeds[] and
passes them via --args. The script emits the chosen baseline + the
cascade-tier + the tiebreak chain consulted (for audit logging).

Cascade (spec § 8.2 Step 5):
  5.a preferred:                seeds where status ∈ {active, completed_early}
                                 AND final_q > 0
  5.b non_quarantine_fallback:  seeds where killed_reason != shortcut_quarantine
                                 AND final_q > 0  (only consulted if 5.a empty)
  5.c best_effort:              seeds where keeps >= 1
                                 (only consulted if 5.b empty;
                                  emits synthesis_outcome_hint == "best_effort")
  5.d no_baseline:              all candidate sets empty
                                 (emits chosen_seed_id == null,
                                  synthesis_outcome == "no_baseline")

Tiebreak chain (applied within non-empty candidate set):
  1. final_q (max)
  2. keeps (max)
  3. -borrows_received (min wins; baseline-specific anti-double-counting per spec)
  4. seed_id (min wins — stable deterministic tiebreak)

ties_broken_on output captures the cascade depth actually consulted
(e.g. ["final_q"] when one seed had max final_q outright;
["final_q", "keeps", "borrows_received", "seed_id"] when all three
prior levels tied and the lowest seed_id won).
"""
import json
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).parents[3] / "hooks/scripts/baseline-select.py"


def _run_ok(payload):
    r = subprocess.run(
        ["python3", str(SCRIPT), "--args", json.dumps(payload)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, f"stderr: {r.stderr}"
    return json.loads(r.stdout)


def _run_err(payload):
    return subprocess.run(
        ["python3", str(SCRIPT), "--args", json.dumps(payload)],
        capture_output=True, text=True,
    )


def _seed(**overrides):
    """Default seed snapshot — active, healthy, no borrows."""
    base = {
        "id": 1,
        "status": "active",
        "killed_reason": None,
        "final_q": 0.30,
        "keeps": 2,
        "borrows_received": 0,
    }
    base.update(overrides)
    return base


# ---- Cascade tier 5.a — preferred ------------------------------------

def test_preferred_tier_single_active_seed():
    out = _run_ok({"seeds": [_seed(id=1, final_q=0.42)]})
    assert out["chosen_seed_id"] == 1
    assert out["tier"] == "preferred"
    assert out["candidates_count"] == 1


def test_preferred_tier_picks_highest_final_q():
    out = _run_ok({"seeds": [
        _seed(id=1, final_q=0.30, keeps=2),
        _seed(id=2, final_q=0.42, keeps=1),
        _seed(id=3, final_q=0.35, keeps=3),
    ]})
    assert out["chosen_seed_id"] == 2
    assert out["tier"] == "preferred"
    assert out["ties_broken_on"] == ["final_q"]


def test_preferred_tier_completed_early_eligible():
    """status: completed_early seeds are part of the preferred set."""
    out = _run_ok({"seeds": [
        _seed(id=1, status="active", final_q=0.30),
        _seed(id=2, status="completed_early", final_q=0.50),
    ]})
    assert out["chosen_seed_id"] == 2


def test_preferred_tier_excludes_killed():
    out = _run_ok({"seeds": [
        _seed(id=1, status="killed_crash_give_up",
              killed_reason="crash_give_up", final_q=0.50),
        _seed(id=2, status="active", final_q=0.20),
    ]})
    # Killed seed is NOT in 5.a preferred set — active wins
    assert out["chosen_seed_id"] == 2
    assert out["tier"] == "preferred"


def test_preferred_tier_excludes_zero_final_q():
    """Spec § 8.2: 5.a requires final_q > 0 (strict)."""
    out = _run_ok({"seeds": [
        _seed(id=1, status="active", final_q=0.0),
        _seed(id=2, status="active", final_q=0.10),
    ]})
    assert out["chosen_seed_id"] == 2


# ---- Cascade tier 5.b — non_quarantine_fallback ---------------------

def test_non_quarantine_fallback_when_all_active_killed():
    """All active killed → fall to 5.b which allows non-shortcut-killed."""
    out = _run_ok({"seeds": [
        _seed(id=1, status="killed_crash_give_up",
              killed_reason="crash_give_up", final_q=0.40),
        _seed(id=2, status="killed_sustained_regression",
              killed_reason="sustained_regression", final_q=0.30),
    ]})
    assert out["chosen_seed_id"] == 1
    assert out["tier"] == "non_quarantine_fallback"


def test_non_quarantine_fallback_excludes_shortcut_quarantine():
    """Spec § 8.2 Step 5.b explicitly excludes shortcut_quarantine."""
    out = _run_ok({"seeds": [
        _seed(id=1, status="killed_shortcut_quarantine",
              killed_reason="shortcut_quarantine", final_q=0.95),  # sky-high but tainted
        _seed(id=2, status="killed_crash_give_up",
              killed_reason="crash_give_up", final_q=0.20),
    ]})
    assert out["chosen_seed_id"] == 2  # not the shortcut seed
    assert out["tier"] == "non_quarantine_fallback"


def test_non_quarantine_fallback_requires_final_q_positive():
    """5.b also requires final_q > 0; killed seeds with final_q=0 don't count."""
    out = _run_ok({"seeds": [
        _seed(id=1, status="killed_crash_give_up",
              killed_reason="crash_give_up", final_q=0.0, keeps=2),
        _seed(id=2, status="killed_sustained_regression",
              killed_reason="sustained_regression", final_q=0.10),
    ]})
    # Seed 1 fails final_q > 0 → only seed 2 in 5.b set
    assert out["chosen_seed_id"] == 2


# ---- Cascade tier 5.c — best_effort ---------------------------------

def test_best_effort_when_all_final_q_zero_but_keeps_exist():
    """No seed satisfies final_q > 0; 5.c picks any seed with keeps >= 1."""
    out = _run_ok({"seeds": [
        _seed(id=1, status="active", final_q=0.0, keeps=1),
        _seed(id=2, status="killed_crash_give_up",
              killed_reason="crash_give_up", final_q=0.0, keeps=3),
    ]})
    assert out["chosen_seed_id"] == 2  # 5.c tiebreaks on keeps (3 > 1)
    assert out["tier"] == "best_effort"


def test_best_effort_includes_shortcut_quarantine():
    """5.c is the broadest catch-all; shortcut_quarantine is allowed
    here as a last resort. Spec wording: 'any seed with at least one
    keep'."""
    out = _run_ok({"seeds": [
        _seed(id=1, status="killed_shortcut_quarantine",
              killed_reason="shortcut_quarantine",
              final_q=0.0, keeps=5),
    ]})
    assert out["chosen_seed_id"] == 1
    assert out["tier"] == "best_effort"


# ---- Cascade tier 5.d — no_baseline ---------------------------------

def test_no_baseline_when_no_keeps_anywhere():
    out = _run_ok({"seeds": [
        _seed(id=1, status="active", final_q=0.0, keeps=0),
        _seed(id=2, status="killed_crash_give_up",
              killed_reason="crash_give_up", final_q=0.0, keeps=0),
    ]})
    assert out["chosen_seed_id"] is None
    assert out["tier"] == "no_baseline"
    assert out["candidates_count"] == 0


def test_no_baseline_with_empty_seeds_list():
    out = _run_ok({"seeds": []})
    assert out["chosen_seed_id"] is None
    assert out["tier"] == "no_baseline"


# ---- Tiebreak chain --------------------------------------------------

def test_tiebreak_keeps_when_final_q_tied():
    out = _run_ok({"seeds": [
        _seed(id=1, status="active", final_q=0.40, keeps=2),
        _seed(id=2, status="active", final_q=0.40, keeps=5),
    ]})
    assert out["chosen_seed_id"] == 2
    assert out["ties_broken_on"] == ["final_q", "keeps"]


def test_tiebreak_borrows_received_when_keeps_tied():
    """Lower borrows_received wins (anti-double-counting per spec)."""
    out = _run_ok({"seeds": [
        _seed(id=1, status="active", final_q=0.40, keeps=3, borrows_received=4),
        _seed(id=2, status="active", final_q=0.40, keeps=3, borrows_received=1),
    ]})
    assert out["chosen_seed_id"] == 2
    assert out["ties_broken_on"] == ["final_q", "keeps", "borrows_received"]


def test_tiebreak_seed_id_when_all_tied():
    """Stable tiebreak: lowest seed_id wins when everything else equal."""
    out = _run_ok({"seeds": [
        _seed(id=2, status="active", final_q=0.40, keeps=3, borrows_received=1),
        _seed(id=3, status="active", final_q=0.40, keeps=3, borrows_received=1),
        _seed(id=1, status="active", final_q=0.40, keeps=3, borrows_received=1),
    ]})
    assert out["chosen_seed_id"] == 1
    assert out["ties_broken_on"] == \
        ["final_q", "keeps", "borrows_received", "seed_id"]


def test_baseline_selection_reasoning_emitted():
    """Output must include baseline_selection_reasoning per spec § 8.2."""
    out = _run_ok({"seeds": [
        _seed(id=2, final_q=0.50, keeps=4, borrows_received=0),
    ]})
    assert "baseline_selection_reasoning" in out
    reasoning = out["baseline_selection_reasoning"]
    assert reasoning["chosen_seed_id"] == 2
    assert reasoning["tier"] == "preferred"
    assert isinstance(reasoning["ties_broken_on"], list)


# ---- Schema / type-safety guards ------------------------------------

def test_missing_seeds_field_rc_2():
    r = _run_err({})
    assert r.returncode == 2
    assert "error:" in r.stderr


def test_seed_missing_required_field_rc_2():
    bad = _seed()
    del bad["final_q"]
    r = _run_err({"seeds": [bad]})
    assert r.returncode == 2
    assert "final_q" in r.stderr


def test_bool_final_q_rejected_rc_2():
    """T17 BLOCKER class — isinstance(True, int) is True."""
    bad = _seed()
    bad["final_q"] = True
    r = _run_err({"seeds": [bad]})
    assert r.returncode == 2
    assert "bool" in r.stderr.lower() or "number" in r.stderr.lower()


def test_invalid_json_rc_2():
    r = subprocess.run(
        ["python3", str(SCRIPT), "--args", "not-json"],
        capture_output=True, text=True,
    )
    assert r.returncode == 2


def test_integral_float_id_returns_canonical_int():
    """I-1 regression: a seed with id=2.0 (float-as-int from a JSON layer
    that float-ifies whole numbers) must produce chosen_seed_id=2 (int) in
    the output, not 2.0. Otherwise downstream consumers (T28 jq parse +
    git rev-parse) get string "2.0" and fail."""
    out = _run_ok({"seeds": [_seed(id=2.0, final_q=0.42)]})
    assert out["chosen_seed_id"] == 2
    assert isinstance(out["chosen_seed_id"], int)
    # Also verify the reasoning's chosen_seed_id is canonical int
    assert out["baseline_selection_reasoning"]["chosen_seed_id"] == 2
    assert isinstance(out["baseline_selection_reasoning"]["chosen_seed_id"], int)


def test_seed_id_zero_rejected_rc_2():
    """M-2: seed_id must be >= 1 per session.yaml.virtual_parallel contract.
    id=0 is excluded everywhere else in the codebase (T23/T24 ^[1-9][0-9]*$);
    enforce here too for consistency."""
    bad = _seed(id=0)
    r = _run_err({"seeds": [bad]})
    assert r.returncode == 2
    assert "positive" in r.stderr.lower() or "id" in r.stderr.lower()
