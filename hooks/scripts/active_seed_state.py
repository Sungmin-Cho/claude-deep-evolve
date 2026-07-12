#!/usr/bin/env python3
"""Read the v3.1 canonical zero-active contract from session.yaml.

Canonical strict state represents zero active seeds as an absent ``n_current``
plus ``x-active-seed-count: 0``.  ``n_current: 0`` is accepted only as a
legacy compatibility spelling so read-only workflow consumers do not revive a
terminal session while it is being migrated.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover - exercised by installed runtime
    print(f"error: PyYAML required: {exc}", file=sys.stderr)
    raise SystemExit(2)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def normalized_seed_identity(seed: dict) -> int:
    """Return one supported seed identity without mutating its stored shape."""
    if not isinstance(seed, dict):
        raise ValueError("seed entry must be a mapping")

    aliases = []
    for key in ("id", "seed_id"):
        if key not in seed:
            continue
        value = seed[key]
        if isinstance(value, bool) or not (
            isinstance(value, int)
            or (isinstance(value, float) and value.is_integer())
        ):
            raise ValueError(f"seed {key} must be an integral number")
        identity = int(value)
        if identity <= 0:
            raise ValueError(f"seed {key} must be positive")
        aliases.append((key, identity))

    if not aliases:
        raise ValueError("seed entry is missing id/seed_id")
    if any(identity != aliases[0][1] for _, identity in aliases[1:]):
        raise ValueError("seed id and seed_id conflict")
    return aliases[0][1]


def active_seed_state(session: dict) -> dict:
    """Return the canonical schedulability view for one parsed session."""
    vp = session.get("virtual_parallel") or {}
    if not isinstance(vp, dict):
        raise ValueError("virtual_parallel must be a mapping")
    seeds = vp.get("seeds") or []
    if not isinstance(seeds, list):
        raise ValueError("virtual_parallel.seeds must be a list")

    marker_present = "x-active-seed-count" in vp
    marker = vp.get("x-active-seed-count")
    if marker_present and (not _is_int(marker) or marker != 0):
        raise ValueError("x-active-seed-count must be the integer 0")
    if marker_present and "n_current" in vp:
        raise ValueError("x-active-seed-count and n_current cannot coexist")

    schedulable = []
    seen_identities = set()
    missing_status = False
    for seed in seeds:
        identity = normalized_seed_identity(seed)
        if identity in seen_identities:
            raise ValueError(f"duplicate seed identity: {identity}")
        seen_identities.add(identity)
        if "status" not in seed:
            missing_status = True
        if seed.get("status", "active") == "active":
            schedulable.append(identity)

    legacy_zero = vp.get("n_current") == 0 and _is_int(vp.get("n_current"))
    if marker_present and (schedulable or missing_status):
        raise ValueError(
            "x-active-seed-count: 0 requires explicit non-active seed statuses"
        )
    zero_active = marker_present or legacy_zero or not schedulable
    if zero_active:
        schedulable = []

    return {
        "active_seed_count": len(schedulable),
        "schedulable_seed_ids": schedulable,
        "zero_active": zero_active,
    }


def single_active_seed(session: dict) -> dict:
    """Return identity and score for the actual sole schedulable seed."""
    state = active_seed_state(session)
    if state["active_seed_count"] != 1:
        raise ValueError("single active seed required")
    chosen = state["schedulable_seed_ids"][0]
    seeds = (session.get("virtual_parallel") or {}).get("seeds") or []
    row = next(
        seed for seed in seeds
        if normalized_seed_identity(seed) == chosen and seed.get("status", "active") == "active"
    )
    final_q = row.get("final_q", row.get("q", row.get("current_q", 0.0)))
    if isinstance(final_q, bool) or not isinstance(final_q, (int, float)):
        final_q = 0.0
    return {"seed_id": chosen, "final_q": final_q}


def load_session(path: Path) -> dict:
    try:
        parsed = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        raise ValueError(f"cannot read session.yaml: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("session.yaml must be a mapping")
    return parsed


def load_active_seed_state(path: Path) -> dict:
    return active_seed_state(load_session(path))


def main() -> int:
    parser = argparse.ArgumentParser(description="Read canonical active-seed state")
    parser.add_argument("--session-yaml", required=True, type=Path)
    output = parser.add_mutually_exclusive_group(required=True)
    output.add_argument("--json", action="store_true")
    output.add_argument("--count", action="store_true")
    output.add_argument("--single-json", action="store_true")
    args = parser.parse_args()
    try:
        parsed = load_session(args.session_yaml)
        state = active_seed_state(parsed)
        single = None
        if args.single_json:
            single = single_active_seed(parsed)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.single_json:
        print(json.dumps(single, ensure_ascii=False, sort_keys=False))
    elif args.count:
        print(state["active_seed_count"])
    else:
        print(json.dumps(state, ensure_ascii=False, sort_keys=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
