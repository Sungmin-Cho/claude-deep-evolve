#!/usr/bin/env python3
"""β direction generator for v3.1 init (spec § 5.1 Step 3) + growth (§ 5.2).

Contract: the AI call happens ONE LAYER UP (coordinator dispatches a subagent
via the Task tool; that subagent emits an 'attempts' or 'directions' JSON).
Coordinator then calls this script with --input pointing at the JSON (either
a file path or an inline JSON string). This script does NOT make any AI call;
it implements the deterministic post-processing (similarity gate, retry
accounting, N=1 short-circuit).

Modes (select via --mode, default=init):
  init:
    N == 1 → emit skip marker (N=1 short-circuit per § 5.1a)
    N <= 4 → single-turn acceptance of directions from --input
    N >= 5 → iterative with pairwise similarity gate; ≤0.70 target; 2 retries max
  growth (spec § 5.2):
    Generate ONE new direction that doesn't overlap with existing seeds.
    Inherits § 5.1's 0.70 similarity threshold and 2-retry exhaustion policy,
    but compares against existing active seeds' directions (passed via
    --existing-seeds) and tags the warning with context=epoch_growth on
    exhaustion.

Defensive programming (per T5 review pattern):
  - Malformed top-level JSON → exit rc=2 with stderr message (no KeyError)
  - Missing 'directions' (N<=4) or 'attempts' (N>=5) → exit rc=2
  - Individual attempt missing 'max_similarity'/'directions' → skip + stderr warn
  - All attempts malformed → exit rc=2
"""
import argparse
import json
import sys
from pathlib import Path

SIMILARITY_THRESHOLD = 0.70
MAX_RETRIES = 2  # total attempts = 1 initial + 2 retries = 3


def _die(msg, rc=2):
    """Emit clear error to stderr and exit non-zero."""
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(rc)


def _valid_attempt(attempt, idx):
    """Return True if attempt has required fields; warn + skip otherwise."""
    if not isinstance(attempt, dict):
        print(f"warn: attempt[{idx}] is not an object; skipping", file=sys.stderr)
        return False
    if "directions" not in attempt or not isinstance(attempt["directions"], list):
        print(f"warn: attempt[{idx}] missing 'directions' list; skipping",
              file=sys.stderr)
        return False
    if "max_similarity" not in attempt or not isinstance(
            attempt["max_similarity"], (int, float)):
        print(f"warn: attempt[{idx}] missing numeric 'max_similarity'; skipping",
              file=sys.stderr)
        return False
    return True


def process(n, payload):
    """Apply N-tier post-processing logic to the AI subagent's payload.

    payload is either:
      - the literal string "skip" (only valid when n == 1)
      - a dict with 'directions' (n <= 4) or 'attempts' (n >= 5)
    """
    # N=1 short-circuit (§ 5.1a)
    if n == 1:
        if payload != "skip":
            print("warn: N=1 received non-'skip' input; honoring skip anyway",
                  file=sys.stderr)
        return {
            "skipped": True,
            "reason": "N=1 short-circuit (§ 5.1a)",
            "directions": [],
            "retries_used": 0,
            "max_similarity_observed": 0.0,
            "warning_emitted": None,
        }

    # N >= 2: payload must parse as JSON dict
    if not isinstance(payload, (dict, str)):
        _die(f"invalid payload type for N={n}: {type(payload).__name__}")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as e:
            _die(f"--input is not valid JSON: {e}")
    if not isinstance(payload, dict):
        _die(f"parsed --input is not a JSON object (got {type(payload).__name__})")

    # N <= 4: single-turn accept
    if n <= 4:
        directions = payload.get("directions")
        if not isinstance(directions, list):
            _die(f"N={n} payload missing 'directions' list")
        return {
            "skipped": False,
            "directions": directions,
            "retries_used": 0,
            "max_similarity_observed": 0.0,
            "warning_emitted": None,
        }

    # N >= 5: iterative similarity gate
    attempts = payload.get("attempts")
    if not isinstance(attempts, list) or not attempts:
        _die(f"N={n} payload missing non-empty 'attempts' list")

    best = None  # attempt with the lowest max_similarity seen so far
    valid_count = 0
    for idx, attempt in enumerate(attempts):
        if not _valid_attempt(attempt, idx):
            continue
        valid_count += 1
        sim = float(attempt["max_similarity"])
        if sim <= SIMILARITY_THRESHOLD:
            return {
                "skipped": False,
                "directions": attempt["directions"],
                "retries_used": valid_count - 1,  # 0 on first-try success
                "max_similarity_observed": sim,
                "warning_emitted": None,
            }
        if best is None or sim < float(best["max_similarity"]):
            best = attempt
        # Stop after initial + MAX_RETRIES valid attempts
        if valid_count >= 1 + MAX_RETRIES:
            break

    if best is None:
        _die(f"N={n}: all {len(attempts)} attempts were malformed")

    # Exhausted retries → emit diversity warning with best-of-3 batch
    return {
        "skipped": False,
        "directions": best["directions"],
        "retries_used": MAX_RETRIES,
        "max_similarity_observed": float(best["max_similarity"]),
        "warning_emitted": "beta_diversity_warning",
    }


def _valid_growth_attempt(attempt, idx):
    """Return True if a growth attempt has required fields; warn + skip otherwise."""
    if not isinstance(attempt, dict):
        print(f"warn: growth attempt[{idx}] is not an object; skipping",
              file=sys.stderr)
        return False
    if "direction" not in attempt or not isinstance(attempt["direction"], dict):
        print(f"warn: growth attempt[{idx}] missing 'direction' object; skipping",
              file=sys.stderr)
        return False
    if "max_similarity_to_existing" not in attempt or not isinstance(
            attempt["max_similarity_to_existing"], (int, float)):
        print(f"warn: growth attempt[{idx}] missing numeric "
              f"'max_similarity_to_existing'; skipping", file=sys.stderr)
        return False
    return True


def process_growth(existing, payload):
    """Iterate through fixture attempts; accept first under 0.70 sim, else best-of-3.

    Spec § 5.2: growth β generates ONE new direction that doesn't overlap
    with existing active seeds. Shares the 0.70 similarity threshold and
    2-retry-max policy with init mode (§ 5.1 Step 3), but reports
    warning_context='epoch_growth' on exhaustion.

    Input schema:
      {"attempts": [
        {"direction": {seed_id, direction, hypothesis, rationale},
         "max_similarity_to_existing": float,
         "closest_existing_seed_id": int},
        ...
      ]}

    'existing' (list of {seed_id, direction}) is passed through for upstream
    traceability; the upstream subagent has already computed
    max_similarity_to_existing against this list, so this script does not
    recompute similarity.
    """
    if not isinstance(payload, dict) or "attempts" not in payload:
        _die("growth input missing 'attempts' key")
    attempts = payload["attempts"]
    if not isinstance(attempts, list) or not attempts:
        _die("growth 'attempts' must be a non-empty list")

    best = None  # attempt with the lowest max_similarity_to_existing seen so far
    valid_count = 0
    for idx, attempt in enumerate(attempts):
        if not _valid_growth_attempt(attempt, idx):
            continue
        valid_count += 1
        sim = float(attempt["max_similarity_to_existing"])
        if sim <= SIMILARITY_THRESHOLD:
            return {
                "direction": attempt["direction"],
                "retries_used": valid_count - 1,  # 0 on first-try success
                "max_similarity_observed": sim,
                "warning_emitted": None,
                "warning_context": None,
            }
        if best is None or sim < float(best["max_similarity_to_existing"]):
            best = attempt
        # Stop after initial + MAX_RETRIES valid attempts
        if valid_count >= 1 + MAX_RETRIES:
            break

    if best is None:
        _die(f"growth: all {len(attempts)} attempts were malformed")

    # Exhausted retries → emit diversity warning tagged with epoch_growth context
    return {
        "direction": best["direction"],
        "retries_used": MAX_RETRIES,
        "max_similarity_observed": float(best["max_similarity_to_existing"]),
        "warning_emitted": "beta_diversity_warning",
        "warning_context": "epoch_growth",
    }


def _load_input(raw):
    """--input may be a path to a JSON file OR inline JSON string OR the
    literal 'skip' sentinel. Return the payload as a string (leaving JSON
    parsing to process() so 'skip' stays opaque)."""
    p = Path(raw)
    try:
        if p.exists() and p.is_file():
            return p.read_text()
    except OSError:
        # e.g. filename too long on some platforms → treat as inline
        pass
    return raw


def main():
    ap = argparse.ArgumentParser(
        description="v3.1 β direction generator: deterministic post-processing "
                    "of a subagent's direction-generation output "
                    "(spec § 5.1 Step 3 for init, § 5.2 for growth).")
    ap.add_argument("--mode", choices=["init", "growth"], default="init",
                    help="init (default): N-tier init β generation (§ 5.1). "
                         "growth: single new direction check against existing "
                         "seeds for mid-session N growth (§ 5.2).")
    ap.add_argument("--n", type=int,
                    help="(init mode) Number of seeds decided by Project Deep "
                         "Analysis. Required when --mode=init.")
    ap.add_argument("--project-analysis",
                    help="(init mode) JSON string from Section A.1 Project Deep "
                         "Analysis. Required when --mode=init. Used by the "
                         "upstream subagent prompt; this script does not "
                         "consume it but requires it for traceability.")
    ap.add_argument("--existing-seeds",
                    help="(growth mode) JSON array of {seed_id, direction} for "
                         "existing active seeds. Required when --mode=growth.")
    ap.add_argument("--input", required=True,
                    help="Path to JSON file OR inline JSON string. For init: "
                         "AI subagent's 'attempts' list (N>=5) or 'directions' "
                         "list (N<=4), or literal 'skip' sentinel for N=1. For "
                         "growth: object with 'attempts' list of growth candidates.")
    args = ap.parse_args()

    if args.mode == "growth":
        if not args.existing_seeds:
            _die("--mode growth requires --existing-seeds")
        try:
            existing = json.loads(args.existing_seeds)
        except json.JSONDecodeError as e:
            _die(f"--existing-seeds is not valid JSON: {e}")
        input_raw = _load_input(args.input)
        try:
            payload = json.loads(input_raw)
        except json.JSONDecodeError as e:
            _die(f"--input is not valid JSON: {e}")
        result = process_growth(existing, payload)
        print(json.dumps(result, ensure_ascii=False))
        return

    # init mode (default)
    if args.n is None:
        _die("--mode init requires --n")
    if not args.project_analysis:
        _die("--mode init requires --project-analysis")
    if args.n < 1:
        _die(f"--n must be >= 1 (got {args.n})")

    payload = _load_input(args.input)
    result = process(args.n, payload)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
