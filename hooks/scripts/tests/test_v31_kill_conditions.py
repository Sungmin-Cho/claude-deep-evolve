"""kill-conditions.py — 5 hard-kill whitelist evaluator per spec § 5.5.

Classifier inputs (pure function; no git / no LLM inside the script):
  seed:              dict with id, experiments_used, current_q, q_history,
                     evaluated_events (last 5 in id order; caller pre-extracts
                     from journal), flagged_keeps_count,
                     diagnosed_gave_up_experiment_count, budget_remaining
  session:           dict with median_q, std_q, shortcut_quarantine_threshold
  ai_judgments:      dict with direction_unrecoverable (bool), shortcut_prone (bool)
  user_kill_request: dict {requested_at, confirmed} or null

Output (stdout, single JSON object):
  {"seed_id": <int>,
   "killable": <bool — true iff len(conditions_met) >= 1>,
   "conditions_met": [<condition_name>, ...],
   "details": {<condition_name>: {triggered, reasoning, ...}, ...}}

Conditions (§ 5.5 table):
  crash_give_up                 : diagnosed_gave_up_experiment_count >= 2 AND
                                  ai_judgments.direction_unrecoverable
  sustained_regression          : 4-clause algorithm per § 5.5a
  shortcut_quarantine           : flagged_keeps_count >=
                                  session.shortcut_quarantine_threshold AND
                                  ai_judgments.shortcut_prone
  budget_exhausted_underperform : seed.budget_remaining <= 0 AND
                                  seed.current_q < (session.median_q -
                                                    2 * session.std_q)
  user_requested                : user_kill_request is not null AND
                                  user_kill_request.confirmed == true

Exit codes:
  0 — evaluation completed successfully (killable may be true or false)
  2 — schema / operator error (missing required field, malformed --args,
      bool leaked into numeric field)
"""
import json
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).parents[3] / "hooks/scripts/kill-conditions.py"


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


def _base_seed(**overrides):
    base = {
        "id": 2,
        "experiments_used": 5,
        "current_q": 0.30,
        "q_history": [0.30, 0.35, 0.40, 0.35, 0.30],
        "evaluated_events": [
            {"id": 1, "status": "kept"},
            {"id": 2, "status": "kept"},
            {"id": 3, "status": "kept"},
            {"id": 4, "status": "kept"},
            {"id": 5, "status": "kept"},
        ],
        "flagged_keeps_count": 0,
        "diagnosed_gave_up_experiment_count": 0,
        "budget_remaining": 10,
    }
    base.update(overrides)
    return base


def _base_session(**overrides):
    base = {"median_q": 0.35, "std_q": 0.05,
            "shortcut_quarantine_threshold": 3}
    base.update(overrides)
    return base


def _base_payload(**overrides):
    payload = {
        "seed": _base_seed(),
        "session": _base_session(),
        "ai_judgments": {"direction_unrecoverable": False,
                         "shortcut_prone": False},
        "user_kill_request": None,
    }
    payload.update(overrides)
    return payload


# ---- Healthy seed -----------------------------------------------------

def test_healthy_seed_yields_no_conditions():
    out = _run_ok(_base_payload())
    assert out["seed_id"] == 2
    assert out["killable"] is False
    assert out["conditions_met"] == []


# ---- crash_give_up ----------------------------------------------------

def test_crash_give_up_fires_when_two_pairs_and_ai_agrees():
    out = _run_ok(_base_payload(
        seed=_base_seed(diagnosed_gave_up_experiment_count=2),
        ai_judgments={"direction_unrecoverable": True,
                      "shortcut_prone": False},
    ))
    assert "crash_give_up" in out["conditions_met"]
    assert out["killable"] is True


def test_crash_give_up_requires_ai_judgment():
    """Threshold met but AI disagrees → NOT killable. Matches § 5.5
    'AI judges the seed's direction unrecoverable' co-requirement."""
    out = _run_ok(_base_payload(
        seed=_base_seed(diagnosed_gave_up_experiment_count=5),
        ai_judgments={"direction_unrecoverable": False,
                      "shortcut_prone": False},
    ))
    assert "crash_give_up" not in out["conditions_met"]


def test_crash_give_up_boundary_inclusive_at_two():
    """Spec § 5.5 says '≥2 experiments'. Exactly 2 with AI agreement
    MUST trigger."""
    out = _run_ok(_base_payload(
        seed=_base_seed(diagnosed_gave_up_experiment_count=2),
        ai_judgments={"direction_unrecoverable": True,
                      "shortcut_prone": False},
    ))
    assert "crash_give_up" in out["conditions_met"]


# ---- sustained_regression (§ 5.5a 4-clause pseudocode) ----------------

def test_sustained_regression_all_clauses_pass():
    """10 experiments; last 5 all failed; Q peaked 0.50, now 0.20; not recovered."""
    out = _run_ok(_base_payload(
        seed=_base_seed(
            experiments_used=10,
            current_q=0.20,
            q_history=[0.20, 0.30, 0.50, 0.45, 0.20],
            evaluated_events=[
                {"id": 6, "status": "discarded"},
                {"id": 7, "status": "diagnosed_gave_up"},
                {"id": 8, "status": "flagged_unexplained"},
                {"id": 9, "status": "discarded"},
                {"id": 10, "status": "discarded"},
            ],
        ),
    ))
    assert "sustained_regression" in out["conditions_met"]
    assert out["details"]["sustained_regression"]["triggered"] is True


def test_sustained_regression_clause_1_fail_experiments_below_5():
    """Spec § 5.5a Clause 1: experiments_used < 5 → NOT killable."""
    out = _run_ok(_base_payload(
        seed=_base_seed(
            experiments_used=4,
            current_q=0.10,
            q_history=[0.50, 0.40, 0.20, 0.15, 0.10],
            evaluated_events=[
                {"id": 1, "status": "discarded"},
                {"id": 2, "status": "discarded"},
                {"id": 3, "status": "discarded"},
                {"id": 4, "status": "discarded"},
            ],
        ),
    ))
    assert "sustained_regression" not in out["conditions_met"]
    assert out["details"]["sustained_regression"]["failed_clause"] == 1


def test_sustained_regression_clause_2_fail_one_event_is_kept():
    """Clause 2: any of last 5 evaluated events NOT in failed_statuses
    → NOT killable. A single `kept` in the window blocks the condition."""
    out = _run_ok(_base_payload(
        seed=_base_seed(
            experiments_used=10,
            current_q=0.20,
            q_history=[0.20, 0.30, 0.50, 0.45, 0.20],
            evaluated_events=[
                {"id": 6, "status": "discarded"},
                {"id": 7, "status": "kept"},   # spoils the window
                {"id": 8, "status": "discarded"},
                {"id": 9, "status": "discarded"},
                {"id": 10, "status": "discarded"},
            ],
        ),
    ))
    assert "sustained_regression" not in out["conditions_met"]
    assert out["details"]["sustained_regression"]["failed_clause"] == 2


def test_sustained_regression_clause_3_fail_drop_at_exactly_20pct():
    """Clause 3: '> 20%' is strict inequality. Exactly 20% drop does
    NOT trigger (matches spec's `> 0.20` literal)."""
    out = _run_ok(_base_payload(
        seed=_base_seed(
            experiments_used=10,
            current_q=0.40,
            q_history=[0.50, 0.48, 0.45, 0.42, 0.40],   # peak 0.50, 20.0% drop
            evaluated_events=[
                {"id": i, "status": "discarded"} for i in range(6, 11)
            ],
        ),
    ))
    assert "sustained_regression" not in out["conditions_met"]
    assert out["details"]["sustained_regression"]["failed_clause"] == 3


def test_sustained_regression_clause_4_fail_recovered_equals_peak():
    """Clause 4: current_q >= peak_q → NOT killable (recovery observed)."""
    out = _run_ok(_base_payload(
        seed=_base_seed(
            experiments_used=10,
            current_q=0.50,
            q_history=[0.50, 0.40, 0.30, 0.40, 0.50],   # recovered back to peak
            evaluated_events=[
                {"id": i, "status": "discarded"} for i in range(6, 11)
            ],
        ),
    ))
    assert "sustained_regression" not in out["conditions_met"]
    assert out["details"]["sustained_regression"]["failed_clause"] == 4


# ---- shortcut_quarantine ----------------------------------------------

def test_shortcut_quarantine_threshold_met_with_ai_agreement():
    """Strictly above threshold + AI agreement → fires."""
    out = _run_ok(_base_payload(
        seed=_base_seed(flagged_keeps_count=5),       # > threshold
        session=_base_session(shortcut_quarantine_threshold=3),
        ai_judgments={"direction_unrecoverable": False,
                      "shortcut_prone": True},
    ))
    assert "shortcut_quarantine" in out["conditions_met"]


def test_shortcut_quarantine_boundary_inclusive():
    """Exactly at threshold (`>=` inclusive) + AI agreement → fires."""
    out = _run_ok(_base_payload(
        seed=_base_seed(flagged_keeps_count=3),       # == threshold
        session=_base_session(shortcut_quarantine_threshold=3),
        ai_judgments={"direction_unrecoverable": False,
                      "shortcut_prone": True},
    ))
    assert "shortcut_quarantine" in out["conditions_met"]


def test_shortcut_quarantine_requires_ai_judgment():
    out = _run_ok(_base_payload(
        seed=_base_seed(flagged_keeps_count=10),
        ai_judgments={"direction_unrecoverable": False,
                      "shortcut_prone": False},
    ))
    assert "shortcut_quarantine" not in out["conditions_met"]


# ---- budget_exhausted_underperform ------------------------------------

def test_budget_exhausted_underperform_fires():
    """budget_remaining <= 0 AND current_q < median − 2σ."""
    out = _run_ok(_base_payload(
        seed=_base_seed(budget_remaining=0, current_q=0.10),
        session=_base_session(median_q=0.40, std_q=0.05),  # threshold 0.30
    ))
    assert "budget_exhausted_underperform" in out["conditions_met"]


def test_budget_exhausted_underperform_not_fire_if_q_at_threshold():
    """Strict `<` — Q exactly at (median − 2σ) does NOT trigger."""
    out = _run_ok(_base_payload(
        seed=_base_seed(budget_remaining=0, current_q=0.30),
        session=_base_session(median_q=0.40, std_q=0.05),
    ))
    assert "budget_exhausted_underperform" not in out["conditions_met"]


def test_budget_exhausted_underperform_not_fire_if_budget_remains():
    out = _run_ok(_base_payload(
        seed=_base_seed(budget_remaining=3, current_q=0.05),
        session=_base_session(median_q=0.40, std_q=0.05),
    ))
    assert "budget_exhausted_underperform" not in out["conditions_met"]


# ---- user_requested ---------------------------------------------------

def test_user_requested_fires_when_confirmed():
    out = _run_ok(_base_payload(
        user_kill_request={"requested_at": "2026-04-24T10:00:00Z",
                           "confirmed": True},
    ))
    assert "user_requested" in out["conditions_met"]
    assert out["details"]["user_requested"]["requested_at"] == \
        "2026-04-24T10:00:00Z"


def test_user_requested_unconfirmed_does_not_fire():
    """Spec § 5.5: AskUserQuestion must confirm before firing.
    unconfirmed requests are pending, not yet kill triggers."""
    out = _run_ok(_base_payload(
        user_kill_request={"requested_at": "2026-04-24T10:00:00Z",
                           "confirmed": False},
    ))
    assert "user_requested" not in out["conditions_met"]


# ---- Multiple conditions ----------------------------------------------

def test_multiple_conditions_all_reported_and_killable():
    """Every met condition must appear in conditions_met; killable is a
    single boolean (any >=1 met)."""
    out = _run_ok(_base_payload(
        seed=_base_seed(
            experiments_used=10,
            current_q=0.05,
            q_history=[0.05, 0.20, 0.50, 0.40, 0.05],
            evaluated_events=[
                {"id": i, "status": "discarded"} for i in range(6, 11)
            ],
            flagged_keeps_count=3,
            budget_remaining=0,
        ),
        session=_base_session(median_q=0.40, std_q=0.05),
        ai_judgments={"direction_unrecoverable": False,
                      "shortcut_prone": True},
        user_kill_request={"requested_at": "2026-04-24T10:00:00Z",
                           "confirmed": True},
    ))
    names = set(out["conditions_met"])
    # Exact equality (NOT subset) — a regression that wrongly triggered
    # crash_give_up (which has direction_unrecoverable=False here) must
    # fail this assertion (I-6 fix).
    assert names == {"sustained_regression", "shortcut_quarantine",
                     "budget_exhausted_underperform", "user_requested"}
    assert "crash_give_up" not in names, \
        "crash_give_up must not trigger when direction_unrecoverable=False"
    assert out["killable"] is True


# ---- Schema / type-safety guards --------------------------------------

def test_missing_required_top_level_field_rc_2():
    r = _run_err({"seed": _base_seed()})   # missing session, ai_judgments
    assert r.returncode == 2
    assert "error:" in r.stderr


def test_missing_seed_subfield_rc_2():
    bad = _base_seed()
    del bad["current_q"]
    r = _run_err(_base_payload(seed=bad))
    assert r.returncode == 2
    assert "error:" in r.stderr


def test_bool_experiments_used_rejected_rc_2():
    """isinstance(True, int) is True — T17 BLOCKER class. Numeric fields
    must reject bool explicitly."""
    bad = _base_seed()
    bad["experiments_used"] = True
    r = _run_err(_base_payload(seed=bad))
    assert r.returncode == 2
    assert "bool" in r.stderr.lower() or "number" in r.stderr.lower()


def test_bool_current_q_rejected_rc_2():
    bad = _base_seed()
    bad["current_q"] = True
    r = _run_err(_base_payload(seed=bad))
    assert r.returncode == 2


def test_q_history_must_be_list_of_numbers():
    """Malformed q_history (non-numeric element) → rc=2, not silent
    coercion. Avoids max(['0.5']) string comparison surprise."""
    bad = _base_seed()
    bad["q_history"] = [0.3, "0.4", 0.2]
    r = _run_err(_base_payload(seed=bad))
    assert r.returncode == 2


def test_empty_q_history_treated_as_peak_zero():
    """§ 5.5a `peak_q = max(seed.q_history) if seed.q_history else 0.0`
    — empty history is legal (new seed) but sustained_regression cannot
    trigger because Clause 1 fails first (experiments_used < 5)."""
    out = _run_ok(_base_payload(
        seed=_base_seed(experiments_used=0, current_q=0.0, q_history=[],
                        evaluated_events=[]),
    ))
    assert out["conditions_met"] == []


def test_invalid_json_rc_2():
    r = subprocess.run(
        ["python3", str(SCRIPT), "--args", "not-json"],
        capture_output=True, text=True,
    )
    assert r.returncode == 2
    assert "error:" in r.stderr


def test_sustained_regression_inconsistent_input_rc_2():
    """W-3 fix: Clause 1 (experiments_used >= 5) implies caller has
    aggregated >= 5 evaluated events per spec § 5.5 v3.0
    session_retries_used semantics. If experiments_used >= 5 but
    fewer than 5 evaluated events are supplied, the caller's snapshot
    is malformed — fail rc=2 instead of silently returning
    failed_clause=2."""
    bad = _base_seed(experiments_used=10, evaluated_events=[
        {"id": 1, "status": "discarded"},
        {"id": 2, "status": "discarded"},
    ])
    r = _run_err(_base_payload(seed=bad))
    assert r.returncode == 2
    assert "evaluated_events" in r.stderr or "experiments_used" in r.stderr


def test_int_field_accepts_integral_float():
    """W-4 fix: JSON layers may emit `5.0` for integer fields (jq's
    --argjson preserves source type; some intermediate hops float-ify
    whole numbers). Integral floats must be accepted (rejecting only
    bool and non-integral floats like 5.5)."""
    payload = _base_payload(seed=_base_seed(experiments_used=5.0))
    out = _run_ok(payload)
    assert out["seed_id"] == 2


def test_int_field_rejects_non_integral_float():
    """W-4 boundary: 5.5 is not integral → rc=2."""
    bad = _base_seed()
    bad["experiments_used"] = 5.5
    r = _run_err(_base_payload(seed=bad))
    assert r.returncode == 2


def test_user_kill_request_missing_confirmed_rc_2():
    """Silent-masking guard: when user_kill_request is provided but
    omits `confirmed`, rc=2 — never silently default to False which
    would suppress a real user kill intent."""
    payload = _base_payload(user_kill_request={"requested_at": "2026-04-24T10:00:00Z"})
    r = _run_err(payload)
    assert r.returncode == 2
    assert "confirmed" in r.stderr
