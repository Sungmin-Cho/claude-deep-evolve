#!/usr/bin/env python3
"""Validate + clamp AI scheduler decisions (spec section 6.2).

Accepts a decision JSON (structure per section 6.2), validates required fields,
clamps block_size to allowed set {1,2,3,5,8} with lower-tie-break, emits
a block_size_adjusted journal event if clamping occurred.

Exit codes:
  0 -- decision accepted (possibly clamped)
  2 -- operator error (invalid JSON, missing required fields, unknown decision
       type, non-int block_size). Stderr carries 'error: ...' message.
"""
import argparse
import json
import sys


ALLOWED_BLOCK = [1, 2, 3, 5, 8]
ALLOWED_DECISION = {"schedule", "kill_then_schedule", "grow_then_schedule"}
REQUIRED_FIELDS = {"decision", "chosen_seed_id", "block_size", "reasoning", "signals_used"}


def _die(msg, rc=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(rc)


def nearest_allowed(x):
    """Clamp to nearest value in ALLOWED_BLOCK using strict-less tie-break.

    Strict `<` means equal distances favor the first-encountered (lower) value.
    Example: 4 is distance-1 from both 3 and 5; best starts at 3 (distance 1),
    then iterates to 5 which has the same distance -- `<` false -> best stays 3.
    6 -> 5 (distance 1 < distance 2 from 8). 7 -> 8 (distance 1 < distance 2).
    """
    if x < ALLOWED_BLOCK[0]:
        return ALLOWED_BLOCK[0]
    if x > ALLOWED_BLOCK[-1]:
        return ALLOWED_BLOCK[-1]
    best = ALLOWED_BLOCK[0]
    best_dist = abs(x - best)
    for v in ALLOWED_BLOCK[1:]:
        d = abs(x - v)
        if d < best_dist:
            best = v
            best_dist = d
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--decision", required=True, help="JSON decision from AI scheduler")
    ap.add_argument("--signals", default=None,
                    help="(optional) JSON signals object from scheduler-signals.py -- "
                         "enables fairness_violation and kill_deferred checks")
    args = ap.parse_args()

    try:
        d = json.loads(args.decision)
    except json.JSONDecodeError as e:
        _die(f"invalid JSON: {e}")

    if not isinstance(d, dict):
        _die("decision must be a JSON object")

    missing = REQUIRED_FIELDS - set(d.keys())
    if missing:
        _die(f"missing required fields: {sorted(missing)}")

    if d["decision"] not in ALLOWED_DECISION:
        _die(f"invalid decision type: {d['decision']!r} (allowed: {sorted(ALLOWED_DECISION)})")

    try:
        bs = int(d["block_size"])
    except (TypeError, ValueError):
        _die(f"block_size must be int, got {d['block_size']!r}")

    clamped = False
    original = bs
    if bs not in ALLOWED_BLOCK:
        bs = nearest_allowed(bs)
        clamped = True

    result = {
        "accepted": True,
        "decision": d["decision"],
        "chosen_seed_id": d["chosen_seed_id"],
        "block_size": bs,
        "original_block_size": original,
        "clamped": clamped,
        "reasoning": d["reasoning"],
        "signals_used": d["signals_used"],
        "kill_target": d.get("kill_target"),
        "new_seed_direction": d.get("new_seed_direction"),
    }
    journal_events = []
    if clamped:
        journal_events.append({
            "event": "block_size_adjusted",
            "seed_id": d["chosen_seed_id"],
            "original": original,
            "clamped": bs,
            "decision_id": None,  # filled by caller if known
        })
    result["journal_events_to_append"] = journal_events

    # Optional fairness + kill-atomicity checks (spec section 6.6, 5.5 W-9)
    if args.signals is not None:
        try:
            signals = json.loads(args.signals)
        except json.JSONDecodeError as e:
            _die(f"--signals is not valid JSON: {e}")
        if not isinstance(signals, dict):
            _die("--signals must be a JSON object")

        seeds = signals.get("seeds", []) or []

        # Soft fairness floor: any active seed with 0 experiments_used_this_epoch
        # (other than the chosen seed itself) triggers a warning.
        starved = []
        for s in seeds:
            if not isinstance(s, dict):
                continue
            sid = s.get("id")
            if sid is None or sid == d["chosen_seed_id"]:
                continue
            if s.get("status") == "active" and s.get("experiments_used_this_epoch", 0) == 0:
                starved.append(sid)
        result["fairness_violation"] = len(starved) > 0
        result["starved_seed_ids"] = starved

        # Kill atomicity (W-9): if kill_target is currently running a block,
        # defer the kill to the queue instead of applying immediately.
        kill_deferred = False
        if d["decision"] == "kill_then_schedule" and d.get("kill_target") is not None:
            kt = d["kill_target"]
            target = next((s for s in seeds
                           if isinstance(s, dict) and s.get("id") == kt),
                          None)
            if target and target.get("in_flight_block"):
                kill_deferred = True
        result["kill_deferred"] = kill_deferred

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
