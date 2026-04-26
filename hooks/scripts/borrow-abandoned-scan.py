#!/usr/bin/env python3
"""Scan journal for stale borrow_planned events and emit borrow_abandoned.

Spec § 7.4 P1: coordinator cleans `borrow_planned` older than 2 blocks without
matching `cross_seed_borrow`. Called from coordinator main loop after each block
completes (T12 coordinator.md step 7.5).

Inputs (two modes, mutually exclusive, one required):
  --journal-path PATH       production: read journal.jsonl from session
  --journal-json JSON       testing: inline events array

Common:
  --current-block-id N      the just-completed block's id
  --staleness-blocks K      threshold (default 2 per spec)

Output (JSON on stdout):
  {"abandoned_events": [<event to append via append_journal_event>, ...]}

Matching semantics:
  (seed_id, source_commit) is the join key for borrow lifecycle events.
  borrow_planned       → planned (tracked with latest block_id)
  cross_seed_borrow    → matches via (to_seed, source_commit) → executed
  borrow_abandoned     → pre-existing marker, suppresses re-emission (idempotent)
"""
import argparse
import json
import sys
from pathlib import Path


def _die(msg, rc=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(rc)


def load_events(path: Path | None, inline: str | None):
    """Load journal events from file OR inline JSON array."""
    if path is not None:
        if not path.is_file():
            _die(f"journal file not found: {path}")
        events = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    # Malformed line: skip silently (defensive per T5-T11)
                    continue
        return events
    try:
        events = json.loads(inline)
    except json.JSONDecodeError as e:
        _die(f"--journal-json is not valid JSON: {e}")
    if not isinstance(events, list):
        _die("--journal-json must be a JSON array")
    return events


def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--journal-path", type=Path)
    src.add_argument("--journal-json")
    ap.add_argument("--current-block-id", type=int, required=True)
    ap.add_argument("--staleness-blocks", type=int, default=2)
    args = ap.parse_args()

    events = load_events(args.journal_path, args.journal_json)

    # Index: (seed_id, source_commit) → state
    planned = {}   # key → most recent block_id
    executed = set()
    abandoned = set()

    for e in events:
        if not isinstance(e, dict):
            continue
        et = e.get("event")
        if et == "borrow_planned":
            key = (e.get("seed_id"), e.get("source_commit"))
            planned[key] = max(planned.get(key, -1), e.get("block_id", -1))
        elif et == "cross_seed_borrow":
            # Matching key is (to_seed, source_commit): who executed the borrow
            executed.add((e.get("to_seed"), e.get("source_commit")))
        elif et == "borrow_abandoned":
            abandoned.add((e.get("seed_id"), e.get("source_commit")))

    emit = []
    for key, plan_block in planned.items():
        seed_id, source_commit = key
        if key in executed:       # P1 phase 2 completed — skip
            continue
        if key in abandoned:      # already cleaned up — skip (idempotent)
            continue
        age = args.current_block_id - plan_block
        if age > args.staleness_blocks:
            emit.append({
                "event": "borrow_abandoned",
                "seed_id": seed_id,
                "source_commit": source_commit,
                "reason": "stale_no_execution",
                "originally_planned_at_block": plan_block,
                "detected_at_block": args.current_block_id,
            })

    print(json.dumps({"abandoned_events": emit}, ensure_ascii=False))


if __name__ == "__main__":
    main()
