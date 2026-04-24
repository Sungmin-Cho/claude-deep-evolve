#!/usr/bin/env python3
"""β direction generator for v3.1 init (spec § 5.1 Step 3).

Contract: the AI call happens ONE LAYER UP (coordinator dispatches a subagent
via the Task tool; that subagent emits an 'attempts' or 'directions' JSON).
Coordinator then calls this script with --input pointing at the JSON (either
a file path or an inline JSON string). This script does NOT make any AI call;
it implements the deterministic post-processing (similarity gate, retry
accounting, N=1 short-circuit).

Modes:
  N == 1 → emit skip marker (N=1 short-circuit per § 5.1a)
  N <= 4 → single-turn acceptance of directions from --input
  N >= 5 → iterative with pairwise similarity gate; ≤0.70 target; 2 retries max

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
                    "of a subagent's direction-generation output (spec § 5.1 Step 3).")
    ap.add_argument("--n", type=int, required=True,
                    help="Number of seeds decided by Project Deep Analysis.")
    ap.add_argument("--project-analysis", required=True,
                    help="JSON string from Section A.1 Project Deep Analysis. "
                         "Used by the upstream subagent prompt; this script does "
                         "not consume it but requires it for traceability.")
    ap.add_argument("--input", required=True,
                    help="Path to JSON file OR inline JSON string containing the "
                         "AI subagent's 'attempts' list (N>=5) or 'directions' "
                         "list (N<=4), or the literal 'skip' sentinel for N=1.")
    args = ap.parse_args()

    if args.n < 1:
        _die(f"--n must be >= 1 (got {args.n})")

    payload = _load_input(args.input)
    result = process(args.n, payload)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
