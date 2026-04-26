#!/usr/bin/env python3
"""Validate + clamp AI scheduler decisions (spec section 6.2).

Accepts a decision JSON (structure per section 6.2), validates required fields,
clamps block_size to allowed set {1,2,3,5,8} with lower-tie-break, emits
a block_size_adjusted journal event if clamping occurred.

Exit codes:
  0 -- decision accepted (possibly clamped). stdout: result JSON with
       accepted:true.
  1 -- decision rejected (business rule violation, e.g., kill_target ==
       chosen_seed_id, new_seed_allocation below P3 floor). stdout:
       rejection JSON with accepted:false and reason field. Coordinator
       should log + continue (next AI proposal). G12 final review F2
       fix (2026-04-26): added rc=1 distinction so shell callers using
       `if scheduler-decide ...; then` correctly treat rejection as
       failure. Coordinator wraps in errexit-safe `if/else` per re-review
       G1 fix (2026-04-26).
  2 -- operator error (invalid JSON, missing required fields, unknown
       decision type, non-int block_size, missing decision-specific
       required field per REQUIRED_BY_DECISION). Stderr carries
       'error: ...' message.
"""
import argparse
import json
import sys


ALLOWED_BLOCK = [1, 2, 3, 5, 8]
ALLOWED_DECISION = {"schedule", "kill_then_schedule", "grow_then_schedule"}
REQUIRED_FIELDS = {"decision", "chosen_seed_id", "block_size", "reasoning", "signals_used"}

# G12 re-review G2 fix (2026-04-26): per-decision required fields. The
# coordinator case statement consumes these fields directly:
#   kill_then_schedule → apply_kill(validated.kill_target)
#   grow_then_schedule → dispatch_seed(new_seed_id=validated.new_seed_id)
# Pre-G2 scheduler-decide accepted decisions with these fields omitted /
# null, propagating null operations downstream. Empirical verification
# (re-review 2026-04-26-152334): kill decision without kill_target
# returned rc=0 + accepted:true + kill_target:null. Post-G2: missing/
# null/non-int required fields rejected at rc=2 (operator error).
REQUIRED_BY_DECISION = {
    "schedule": [],  # only base REQUIRED_FIELDS needed
    "kill_then_schedule": ["kill_target"],
    "grow_then_schedule": ["new_seed_id"],
}


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

    # G12 iteration #3 review I2a/I2b fix (2026-04-26): base required-field
    # null/type validation. Pre-fix `missing = REQUIRED_FIELDS - set(d.keys())`
    # at line 92 only checked KEY PRESENCE, not value-non-null-int. Decision
    # with `chosen_seed_id: null` or `chosen_seed_id: "1"` (string) passed
    # through to coordinator's `dispatch_seed(validated.chosen_seed_id, ...)`
    # → silent downstream failure. Empirical verification (iteration #3
    # 2026-04-26-154050): both shapes returned rc=0 + accepted:true.
    # Same regression class as G2 (per-decision REQUIRED_BY_DECISION) but
    # for the BASE required field consumed by all 3 decision types.
    csid = d.get("chosen_seed_id")
    if csid is None:
        _die("chosen_seed_id must be non-null integer (got: null/missing)")
    if not isinstance(csid, int) or isinstance(csid, bool):
        _die(f"chosen_seed_id must be integer (got: {csid!r})")

    # G12 re-review G2 fix (2026-04-26): per-decision required fields.
    # The coordinator case statement consumes these fields directly
    # (apply_kill(validated.kill_target), dispatch_seed(new_seed_id=...)).
    # Pre-G2 scheduler-decide accepted decisions with these fields
    # omitted/null, propagating null operations downstream. Validate
    # schema BEFORE business rejections (G3 ordering fix) — malformed
    # operator/AI inputs must rc=2 (abort), not rc=1 (continue retry).
    decision_required = REQUIRED_BY_DECISION.get(d["decision"], [])
    for field in decision_required:
        v = d.get(field)
        if v is None:
            _die(f"{d['decision']} requires non-null {field} (got: missing or null)")
        if not isinstance(v, int) or isinstance(v, bool):
            _die(f"{d['decision']}.{field} must be integer (got: {v!r})")

    # T42 W-7 hardening: kill_target must differ from chosen_seed_id for
    # kill_then_schedule (killing seed N then scheduling the same seed N is
    # nonsensical -- no kill effect). Rejection signal MUST mention
    # kill_target/chosen_seed_id so per-task review test can verify the
    # violated field, not just any failure (defense against
    # stack-trace-as-rejection regression class).
    #
    # G12 final review F2 fix (2026-04-26): rejection paths must signal
    # FAILURE to shell callers via rc != 0. Pre-fix `return` (implicit
    # rc=0) violated the rc=0=accepted contract and let coordinator
    # case-statement route rejected decisions as executable. Post-fix:
    # rc=1 = business rejection (accepted:false), distinct from rc=2 =
    # operator error (malformed input). Shell `if scheduler-decide ...`
    # now correctly treats rejection as failure.
    if d["decision"] == "kill_then_schedule":
        kill_t = d.get("kill_target")
        chosen = d.get("chosen_seed_id")
        if kill_t is not None and kill_t == chosen:
            rejection = {
                "accepted": False,
                "decision": d["decision"],
                "reason": (
                    f"kill_target ({kill_t}) must differ from chosen_seed_id "
                    f"({chosen}) -- killing seed N then scheduling the same "
                    f"seed N is nonsensical (no kill effect)"
                ),
            }
            print(json.dumps(rejection, ensure_ascii=False, indent=2))
            sys.exit(1)  # F2 fix: rc=1 = business rejection

    # T42 Q6 spec enforcement: P3_floor (3) on new_seed_allocation for
    # grow_then_schedule. Below-floor allocations would silently create an
    # un-killable seed; instead, scheduler must chain kill_then_schedule first
    # to free pool capacity. isinstance-not-bool guard prevents True == 1
    # regression (T26 borrows_given lesson).
    #
    # G12 final review F3 fix (2026-04-26): coordinator.md grow_then_schedule
    # case (line 102-110) calls compute_grow_allocation AFTER validation —
    # AI scheduler may legitimately omit `new_seed_allocation` per spec
    # § 15.1 Q6 (helper computes via ceil() formula). Pre-fix check
    # rejected absent allocation, blocking the documented coordinator
    # contract. Post-fix: only validate IF AI supplied allocation; absent
    # → defer to compute_grow_allocation. The original below-floor
    # rejection class (AI proposes allocation=1 explicitly) is preserved.
    if d["decision"] == "grow_then_schedule":
        nsa = d.get("new_seed_allocation")
        if nsa is not None:
            # AI supplied allocation — must be int (not bool) and >= P3 floor
            if (not isinstance(nsa, int)) or isinstance(nsa, bool) or nsa < 3:
                rejection = {
                    "accepted": False,
                    "decision": d["decision"],
                    "reason": (
                        f"new_seed_allocation ({nsa!r}) below P3_floor (3) -- "
                        f"scheduler must chain kill_then_schedule first to free "
                        f"pool capacity"
                    ),
                }
                print(json.dumps(rejection, ensure_ascii=False, indent=2))
                sys.exit(1)  # F2 fix: rc=1 = business rejection
        # If nsa is None: AI omitted allocation; coordinator computes via
        # compute_grow_allocation post-validation (spec § 15.1 Q6).

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
        "new_seed_id": d.get("new_seed_id"),
        "new_seed_allocation": d.get("new_seed_allocation"),
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
