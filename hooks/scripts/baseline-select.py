#!/usr/bin/env python3
"""baseline-select.py — § 8.2 Step 5 cascading baseline selector.

Pure function (no git, no LLM, no filesystem mutation). Caller pre-
extracts seed snapshots from session.yaml.virtual_parallel.seeds[] and
passes them via --args.

Contract (single JSON object via --args):
  seeds: list of {
    id: int (positive),
    status: str,                  # one of: active | completed_early |
                                  # killed_<reason>
    killed_reason: str | null,    # one of spec § 5.5 whitelist when status
                                  # starts with killed_; null otherwise
    final_q: number,              # may be 0.0 (excluded from 5.a/5.b)
    keeps: int (>= 0),
    borrows_received: int (>= 0),
  }

Output (stdout, single JSON object):
  {
    "chosen_seed_id": int | null,
    "tier": "preferred" | "non_quarantine_fallback" | "best_effort" | "no_baseline",
    "ties_broken_on": [str, ...],   # cascade depth actually consulted
    "candidates_count": int,        # size of the chosen tier's candidate set
    "baseline_selection_reasoning": {
       "chosen_seed_id": int | null,
       "tier": str,
       "ties_broken_on": [str, ...],
    }
  }

Exit codes:
  0 — selection succeeded (chosen_seed_id may be null in no_baseline case)
  2 — schema/operator error
"""
import argparse
import json
import sys


VALID_KILLED_REASONS = {
    "crash_give_up", "sustained_regression", "shortcut_quarantine",
    "budget_exhausted_underperform", "user_requested",
}
REQUIRED_SEED_FIELDS = {
    "id", "status", "killed_reason",
    "final_q", "keeps", "borrows_received",
}


def _die(msg, rc=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(rc)


def _require_int(obj, key, ctx, allow_negative=False):
    v = obj.get(key)
    if isinstance(v, bool):
        _die(f"{ctx}.{key} must be int (not bool), got bool: {v!r}")
    if isinstance(v, int):
        if not allow_negative and v < 0:
            _die(f"{ctx}.{key} must be non-negative, got: {v}")
        return v
    if isinstance(v, float) and v.is_integer():
        if not allow_negative and v < 0:
            _die(f"{ctx}.{key} must be non-negative, got: {v}")
        return int(v)
    _die(f"{ctx}.{key} must be int, got {type(v).__name__}: {v!r}")


def _require_number(obj, key, ctx):
    v = obj.get(key)
    if isinstance(v, bool):
        _die(f"{ctx}.{key} must be number (not bool), got bool: {v!r}")
    if not isinstance(v, (int, float)):
        _die(f"{ctx}.{key} must be number, got "
             f"{type(v).__name__}: {v!r}")
    return float(v)


def _validate_schema(payload):
    if not isinstance(payload, dict):
        _die("--args must be a JSON object")
    if "seeds" not in payload:
        _die("missing required field: seeds")
    seeds = payload["seeds"]
    if not isinstance(seeds, list):
        _die("seeds must be a list")
    for i, seed in enumerate(seeds):
        if not isinstance(seed, dict):
            _die(f"seeds[{i}] must be an object")
        missing = REQUIRED_SEED_FIELDS - set(seed.keys())
        if missing:
            _die(f"seeds[{i}] missing required fields: {sorted(missing)}")
        _require_int(seed, "id", f"seeds[{i}]", allow_negative=False)
        if not isinstance(seed["status"], str):
            _die(f"seeds[{i}].status must be string")
        kr = seed["killed_reason"]
        if kr is not None:
            if not isinstance(kr, str):
                _die(f"seeds[{i}].killed_reason must be string or null")
            # killed_reason may legitimately be a non-whitelist value
            # only when status doesn't start with killed_ — but we
            # don't enforce that consistency here (caller's job).
        _require_number(seed, "final_q", f"seeds[{i}]")
        _require_int(seed, "keeps", f"seeds[{i}]", allow_negative=False)
        _require_int(seed, "borrows_received", f"seeds[{i}]",
                     allow_negative=False)


def _filter_preferred(seeds):
    """5.a: status ∈ {active, completed_early} AND final_q > 0."""
    return [s for s in seeds
            if s["status"] in ("active", "completed_early")
            and s["final_q"] > 0]


def _filter_non_quarantine(seeds):
    """5.b: killed_reason != shortcut_quarantine AND final_q > 0."""
    return [s for s in seeds
            if s.get("killed_reason") != "shortcut_quarantine"
            and s["final_q"] > 0]


def _filter_best_effort(seeds):
    """5.c: keeps >= 1 (any seed with at least one keep)."""
    return [s for s in seeds if s["keeps"] >= 1]


def _select_with_tiebreak(candidates):
    """Apply the 4-level tiebreak chain. Returns (chosen, ties_broken_on).

    Levels:
      1. final_q (max)
      2. keeps (max)
      3. -borrows_received (min wins)
      4. seed_id (min wins, stable)
    """
    if not candidates:
        return None, []

    # Level 1: final_q
    max_q = max(s["final_q"] for s in candidates)
    pool = [s for s in candidates if s["final_q"] == max_q]
    if len(pool) == 1:
        return pool[0], ["final_q"]

    # Level 2: keeps
    max_keeps = max(s["keeps"] for s in pool)
    pool = [s for s in pool if s["keeps"] == max_keeps]
    if len(pool) == 1:
        return pool[0], ["final_q", "keeps"]

    # Level 3: -borrows_received (min wins)
    min_borrows = min(s["borrows_received"] for s in pool)
    pool = [s for s in pool if s["borrows_received"] == min_borrows]
    if len(pool) == 1:
        return pool[0], ["final_q", "keeps", "borrows_received"]

    # Level 4: seed_id (min wins — stable deterministic tiebreak)
    pool.sort(key=lambda s: s["id"])
    return pool[0], ["final_q", "keeps", "borrows_received", "seed_id"]


def main():
    ap = argparse.ArgumentParser(
        description="§ 8.2 Step 5 cascading baseline selector"
    )
    ap.add_argument("--args", required=True,
                    help="JSON {seeds: [...]}")
    parsed = ap.parse_args()

    try:
        payload = json.loads(parsed.args)
    except json.JSONDecodeError as e:
        _die(f"--args is not valid JSON: {e}")

    _validate_schema(payload)
    seeds = payload["seeds"]

    # Cascade through tiers in order
    pref = _filter_preferred(seeds)
    if pref:
        chosen, ties = _select_with_tiebreak(pref)
        tier = "preferred"
        candidates_count = len(pref)
    else:
        nonquar = _filter_non_quarantine(seeds)
        if nonquar:
            chosen, ties = _select_with_tiebreak(nonquar)
            tier = "non_quarantine_fallback"
            candidates_count = len(nonquar)
        else:
            best = _filter_best_effort(seeds)
            if best:
                chosen, ties = _select_with_tiebreak(best)
                tier = "best_effort"
                candidates_count = len(best)
            else:
                chosen, ties = None, []
                tier = "no_baseline"
                candidates_count = 0

    chosen_id = chosen["id"] if chosen else None
    reasoning = {
        "chosen_seed_id": chosen_id,
        "tier": tier,
        "ties_broken_on": ties,
    }
    print(json.dumps({
        "chosen_seed_id": chosen_id,
        "tier": tier,
        "ties_broken_on": ties,
        "candidates_count": candidates_count,
        "baseline_selection_reasoning": reasoning,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
