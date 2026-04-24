#!/usr/bin/env python3
"""kill-conditions.py — 5 hard-kill whitelist evaluator (spec § 5.5 + § 5.5a).

Pure function: no git, no LLM, no session.yaml access. Caller pre-extracts
last 5 `evaluated` events per seed from journal (diagnose-retry events
excluded — matches v3.0 `session_retries_used` semantics), pre-computes
session-wide median/std, and pre-provides AI judgments (direction
unrecoverable / shortcut prone) as booleans.

Contract (single JSON object via --args):
  seed: {
    id: int,
    experiments_used: int,
    current_q: float,
    q_history: [float, ...],
    evaluated_events: [{id: int, status: str}, ...],   # last 5 in id order
    flagged_keeps_count: int,
    diagnosed_gave_up_experiment_count: int,
    budget_remaining: int,
  }
  session: {
    median_q: float,
    std_q: float,
    shortcut_quarantine_threshold: int,
  }
  ai_judgments: {
    direction_unrecoverable: bool,
    shortcut_prone: bool,
  }
  user_kill_request: {requested_at: str, confirmed: bool} | null

Output (stdout, single JSON object):
  {"seed_id": int,
   "killable": bool,                 # true iff len(conditions_met) >= 1
   "conditions_met": [str, ...],     # preserves § 5.5 table order
   "details": {
      "crash_give_up":                 {"triggered": bool, "reasoning": str},
      "sustained_regression":          {"triggered": bool, "failed_clause": int|None,
                                        "reasoning": str, "peak_q": float, "drop_pct": float},
      "shortcut_quarantine":           {"triggered": bool, "reasoning": str},
      "budget_exhausted_underperform": {"triggered": bool, "reasoning": str,
                                        "threshold_q": float},
      "user_requested":                {"triggered": bool, "requested_at": str|None}
   }}

Exit codes:
  0 — evaluation succeeded
  2 — schema/operator error (missing required field, bool in numeric field,
      q_history non-numeric element, invalid JSON)
"""
import argparse
import json
import sys


FAILED_STATUSES = {"discarded", "diagnosed_gave_up", "flagged_unexplained"}
CONDITION_ORDER = [
    "crash_give_up",
    "sustained_regression",
    "shortcut_quarantine",
    "budget_exhausted_underperform",
    "user_requested",
]
REQUIRED_TOP = {"seed", "session", "ai_judgments"}
REQUIRED_SEED = {
    "id", "experiments_used", "current_q", "q_history",
    "evaluated_events", "flagged_keeps_count",
    "diagnosed_gave_up_experiment_count", "budget_remaining",
}
REQUIRED_SESSION = {"median_q", "std_q", "shortcut_quarantine_threshold"}
REQUIRED_AI = {"direction_unrecoverable", "shortcut_prone"}


def _die(msg, rc=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(rc)


def _require_int(obj, key, ctx):
    """Accept int, integral float (e.g. 5.0 from a JSON layer that
    float-ifies whole numbers), reject bool/non-integral-float/other.
    The bool-not-int guard remains primary (T17 BLOCKER class).
    """
    v = obj.get(key)
    if isinstance(v, bool):
        _die(f"{ctx}.{key} must be int (not bool), got bool: {v!r}")
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    _die(f"{ctx}.{key} must be int, got {type(v).__name__}: {v!r}")


def _require_number(obj, key, ctx):
    v = obj.get(key)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        _die(f"{ctx}.{key} must be number (not bool), got "
             f"{type(v).__name__}: {v!r}")
    return float(v)


def _require_bool(obj, key, ctx):
    v = obj.get(key)
    if not isinstance(v, bool):
        _die(f"{ctx}.{key} must be bool, got {type(v).__name__}: {v!r}")
    return v


def _validate_schema(payload):
    if not isinstance(payload, dict):
        _die("--args must be a JSON object")
    missing = REQUIRED_TOP - set(payload.keys())
    if missing:
        _die(f"missing required top-level fields: {sorted(missing)}")

    seed = payload["seed"]
    if not isinstance(seed, dict):
        _die("seed must be an object")
    missing = REQUIRED_SEED - set(seed.keys())
    if missing:
        _die(f"missing required seed fields: {sorted(missing)}")

    session = payload["session"]
    if not isinstance(session, dict):
        _die("session must be an object")
    missing = REQUIRED_SESSION - set(session.keys())
    if missing:
        _die(f"missing required session fields: {sorted(missing)}")

    ai = payload["ai_judgments"]
    if not isinstance(ai, dict):
        _die("ai_judgments must be an object")
    missing = REQUIRED_AI - set(ai.keys())
    if missing:
        _die(f"missing required ai_judgments fields: {sorted(missing)}")

    # Numeric field guards (bool-not-int)
    _require_int(seed, "id", "seed")
    _require_int(seed, "experiments_used", "seed")
    _require_number(seed, "current_q", "seed")
    _require_int(seed, "flagged_keeps_count", "seed")
    _require_int(seed, "diagnosed_gave_up_experiment_count", "seed")
    _require_int(seed, "budget_remaining", "seed")

    q_history = seed["q_history"]
    if not isinstance(q_history, list):
        _die("seed.q_history must be a list")
    for i, x in enumerate(q_history):
        if isinstance(x, bool) or not isinstance(x, (int, float)):
            _die(f"seed.q_history[{i}] must be number (not bool), got "
                 f"{type(x).__name__}: {x!r}")

    evaluated = seed["evaluated_events"]
    if not isinstance(evaluated, list):
        _die("seed.evaluated_events must be a list")
    for i, e in enumerate(evaluated):
        if not isinstance(e, dict):
            _die(f"seed.evaluated_events[{i}] must be an object")
        if "status" not in e:
            _die(f"seed.evaluated_events[{i}] missing 'status' field")

    _require_number(session, "median_q", "session")
    _require_number(session, "std_q", "session")
    _require_int(session, "shortcut_quarantine_threshold", "session")

    _require_bool(ai, "direction_unrecoverable", "ai_judgments")
    _require_bool(ai, "shortcut_prone", "ai_judgments")

    ukr = payload.get("user_kill_request")
    if ukr is not None:
        if not isinstance(ukr, dict):
            _die("user_kill_request must be an object or null")
        if "confirmed" in ukr and not isinstance(ukr["confirmed"], bool):
            _die("user_kill_request.confirmed must be bool")


def evaluate_crash_give_up(seed, ai):
    cnt = seed["diagnosed_gave_up_experiment_count"]
    ai_agrees = ai["direction_unrecoverable"]
    triggered = cnt >= 2 and ai_agrees
    if triggered:
        reasoning = (f"{cnt} diagnose-retry gave-up experiments and AI "
                     f"judges direction unrecoverable")
    elif cnt >= 2:
        reasoning = (f"{cnt} gave-up experiments met threshold but AI "
                     f"does not judge direction unrecoverable")
    else:
        reasoning = f"only {cnt} gave-up experiments (< 2 threshold)"
    return {"triggered": triggered, "reasoning": reasoning}


def evaluate_sustained_regression(seed):
    """§ 5.5a 4-clause algorithm."""
    exp = seed["experiments_used"]
    cur_q = seed["current_q"]
    q_hist = seed["q_history"]
    evaluated = seed["evaluated_events"]

    # Clause 1: experience gate
    if exp < 5:
        return {"triggered": False, "failed_clause": 1,
                "reasoning": f"experiments_used={exp} < 5 (Clause 1)",
                "peak_q": (max(q_hist) if q_hist else 0.0),
                "drop_pct": 0.0}

    # Clause 2: last 5 all failed.
    # Caller-side invariant: experiments_used >= 5 (Clause 1) implies the
    # caller has supplied >= 5 evaluated events (per spec § 5.5 v3.0
    # session_retries_used semantics — experiments_used IS the count of
    # evaluated events excluding diagnose-retry). If fewer than 5 events
    # are present after Clause 1 passed, the caller's snapshot is
    # malformed; surface it as a schema error rather than silently
    # returning failed_clause=2 (W-3 fix — silent-masking class).
    last_five = evaluated[-5:]
    if len(last_five) < 5:
        _die(f"seed.experiments_used={exp} >= 5 but seed.evaluated_events "
             f"has only {len(evaluated)} entries — caller must aggregate at "
             f"least 5 evaluated events when experiments_used >= 5 (matches "
             f"v3.0 session_retries_used semantics)")
    if not all(e.get("status") in FAILED_STATUSES for e in last_five):
        bad = [e.get("status") for e in last_five
               if e.get("status") not in FAILED_STATUSES]
        return {"triggered": False, "failed_clause": 2,
                "reasoning": (f"last 5 evaluated events include non-failed "
                              f"statuses: {bad}"),
                "peak_q": (max(q_hist) if q_hist else 0.0),
                "drop_pct": 0.0}

    peak_q = max(q_hist) if q_hist else 0.0
    denominator = max(peak_q, 1e-9)
    drop = (peak_q - cur_q) / denominator

    # Clause 4: no recovery (current still below peak) — checked before
    # Clause 3 so that recovery-at-peak scenarios return failed_clause=4
    # rather than falling into the drop <= 20% branch (which would be
    # mathematically unreachable for cur_q >= peak_q anyway, but checking
    # here makes the ordering explicit and matches spec intent).
    if cur_q >= peak_q:
        return {"triggered": False, "failed_clause": 4,
                "reasoning": (f"current_q {cur_q:.4f} >= peak_q {peak_q:.4f} "
                              "— recovery observed"),
                "peak_q": peak_q, "drop_pct": drop}

    # Clause 3: peak_q drop > 20%
    if drop <= 0.20:
        return {"triggered": False, "failed_clause": 3,
                "reasoning": (f"Q drop {drop:.1%} is <= 20% from peak "
                              f"{peak_q:.4f}"),
                "peak_q": peak_q, "drop_pct": drop}

    return {"triggered": True, "failed_clause": None,
            "reasoning": (f"all 4 clauses satisfied: experiments_used={exp}, "
                          f"last 5 failed, drop={drop:.1%} from peak "
                          f"{peak_q:.4f}, current_q={cur_q:.4f}"),
            "peak_q": peak_q, "drop_pct": drop}


def evaluate_shortcut_quarantine(seed, session, ai):
    flagged = seed["flagged_keeps_count"]
    threshold = session["shortcut_quarantine_threshold"]
    ai_agrees = ai["shortcut_prone"]
    triggered = flagged >= threshold and ai_agrees
    if triggered:
        reasoning = (f"flagged_keeps_count={flagged} >= threshold={threshold} "
                     f"and AI judges direction shortcut-prone")
    elif flagged >= threshold:
        reasoning = (f"flagged_keeps_count={flagged} met threshold "
                     f"{threshold} but AI disagrees")
    else:
        reasoning = f"flagged_keeps_count={flagged} < threshold={threshold}"
    return {"triggered": triggered, "reasoning": reasoning}


def evaluate_budget_exhausted(seed, session):
    budget_remaining = seed["budget_remaining"]
    cur_q = seed["current_q"]
    # Round to 10 decimal places to avoid floating-point residuals
    # (e.g. 0.40 - 2*0.05 = 0.30000000000000004 in IEEE 754).
    threshold_q = round(session["median_q"] - 2.0 * session["std_q"], 10)
    triggered = budget_remaining <= 0 and cur_q < threshold_q
    if triggered:
        reasoning = (f"budget_remaining={budget_remaining} (<= 0) and "
                     f"current_q={cur_q:.4f} < (median − 2σ)={threshold_q:.4f}")
    elif budget_remaining > 0:
        reasoning = (f"budget_remaining={budget_remaining} > 0 — budget "
                     "still available")
    else:
        reasoning = (f"budget_remaining={budget_remaining} but "
                     f"current_q={cur_q:.4f} >= threshold={threshold_q:.4f}")
    return {"triggered": triggered, "reasoning": reasoning,
            "threshold_q": threshold_q}


def evaluate_user_requested(ukr):
    if ukr is None:
        return {"triggered": False, "requested_at": None}
    # confirmed has already passed _validate_schema's bool guard when the
    # field is present. Don't bool()-coerce here — explicit code prevents
    # silent acceptance of `confirmed: 1` if someone removes the schema
    # guard later (I-3).
    confirmed = ukr.get("confirmed", False)
    return {"triggered": confirmed,
            "requested_at": ukr.get("requested_at")}


def main():
    ap = argparse.ArgumentParser(
        description="Evaluate 5 hard-kill whitelist conditions (spec § 5.5)"
    )
    ap.add_argument("--args", required=True,
                    help="JSON {seed, session, ai_judgments, user_kill_request?}")
    parsed = ap.parse_args()

    try:
        payload = json.loads(parsed.args)
    except json.JSONDecodeError as e:
        _die(f"--args is not valid JSON: {e}")

    _validate_schema(payload)

    seed = payload["seed"]
    session = payload["session"]
    ai = payload["ai_judgments"]
    ukr = payload.get("user_kill_request")

    details = {
        "crash_give_up": evaluate_crash_give_up(seed, ai),
        "sustained_regression": evaluate_sustained_regression(seed),
        "shortcut_quarantine": evaluate_shortcut_quarantine(seed, session, ai),
        "budget_exhausted_underperform": evaluate_budget_exhausted(seed, session),
        "user_requested": evaluate_user_requested(ukr),
    }

    conditions_met = [name for name in CONDITION_ORDER
                      if details[name]["triggered"]]

    print(json.dumps({
        "seed_id": seed["id"],
        "killable": len(conditions_met) >= 1,
        "conditions_met": conditions_met,
        "details": details,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
