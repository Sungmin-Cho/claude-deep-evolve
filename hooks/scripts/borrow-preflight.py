#!/usr/bin/env python3
"""borrow-preflight.py — filter borrow candidates by P2/P3 and dedup (spec § 7.4).

This runs BEFORE the AI's Step 5.f semantic-borrow prompt so the prompt never
sees flagged candidates, never runs when the seed hasn't cleared P3 floor, and
never gets a candidate the borrower already planned or executed on.

Invocation (from inner-loop Step 5.f):
  python3 hooks/scripts/borrow-preflight.py --args '<json>'

Args (single JSON object):
  self_seed_id            : int, the borrowing seed's id
  self_experiments_used   : int, seed.experiments_used snapshot at call time
  candidates              : list of forum `seed_keep` events from OTHER seeds
  journal                 : list of journal events (for self-keyed
                            `borrow_planned` → `dedup_planned`)
  forum                   : list of forum events (for self-`to_seed`
                            `cross_seed_borrow` → `dedup_executed`)

Output (stdout, single JSON object):
  {
    "eligible":      [<candidate event>, ...],
    "skipped":       [{"source_commit": str, "reason": str, "candidate_seed": int}, ...],
    "p3_gate_open":  bool,
    "self_seed_id":  int
  }

Exit codes:
  0  — success (eligible may be empty; p3_gate_open may be false)
  2  — operator / schema error

Defensive patterns (T3/T5/T15 lessons):
  - rc=2 for operator errors
  - stderr error messages prefixed with 'error:'
  - .get() with defaults when reading event fields
  - Does NOT mutate files; pure stdin→stdout transform
"""
import argparse
import json
import sys


def _die(msg, rc=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(rc)


REQUIRED_KEYS = {"self_seed_id", "self_experiments_used",
                 "candidates", "journal", "forum"}


def build_dedup_sets(journal, forum, self_seed_id):
    """Return (planned_commits, executed_commits) — source_commits already
    planned or executed by self_seed_id. Dedup is per-(borrower, source_commit).

    Data-source contract (spec § 7.1): `borrow_planned` is journal-side;
    `cross_seed_borrow` is forum-side. Reading from the wrong source
    silently breaks dedup_executed — this split enforces the contract.
    """
    planned = set()
    for e in journal or []:
        if not isinstance(e, dict):
            continue
        et = e.get("event")
        src = e.get("source_commit")
        if not src:
            continue
        if et == "borrow_planned" and e.get("seed_id") == self_seed_id:
            planned.add(src)

    executed = set()
    for e in forum or []:
        if not isinstance(e, dict):
            continue
        et = e.get("event")
        src = e.get("source_commit")
        if not src:
            continue
        if et == "cross_seed_borrow" and e.get("to_seed") == self_seed_id:
            executed.add(src)
    return planned, executed


def classify_candidate(c, self_seed_id, planned, executed):
    """Return (accept: bool, reason_if_rejected: str or None)."""
    cand_seed = c.get("seed_id")
    src = c.get("commit")
    if cand_seed == self_seed_id:
        return False, "self_seed"
    if not src:
        return False, "missing_source_commit"
    if c.get("flagged", False):
        return False, "p2_flagged"
    if not c.get("legibility_passed", False):
        return False, "p2_legibility"
    if src in planned:
        return False, "dedup_planned"
    if src in executed:
        return False, "dedup_executed"
    return True, None


def main():
    ap = argparse.ArgumentParser(description="Filter borrow candidates per § 7.4 P2/P3 + dedup")
    ap.add_argument("--args", required=True,
                    help="JSON {self_seed_id, self_experiments_used, candidates, journal, forum}")
    args = ap.parse_args()

    try:
        payload = json.loads(args.args)
    except json.JSONDecodeError as e:
        _die(f"--args is not valid JSON: {e}")

    if not isinstance(payload, dict):
        _die("--args must be a JSON object")

    missing = REQUIRED_KEYS - set(payload.keys())
    if missing:
        _die(f"missing required fields: {sorted(missing)}")

    self_seed_id = payload["self_seed_id"]
    if not isinstance(self_seed_id, int) or isinstance(self_seed_id, bool):
        _die(f"self_seed_id must be int (not bool), got {type(self_seed_id).__name__}")

    self_used = payload["self_experiments_used"]
    if not isinstance(self_used, int) or isinstance(self_used, bool):
        _die(f"self_experiments_used must be int (not bool), got {type(self_used).__name__}")

    candidates = payload["candidates"]
    if not isinstance(candidates, list):
        _die("candidates must be a list")

    journal = payload["journal"]
    if not isinstance(journal, list):
        _die("journal must be a list")

    forum = payload["forum"]
    if not isinstance(forum, list):
        _die("forum must be a list")

    p3_open = self_used >= 3

    output = {
        "eligible": [],
        "skipped": [],
        "p3_gate_open": p3_open,
        "self_seed_id": self_seed_id,
    }

    if not p3_open:
        for c in candidates:
            output["skipped"].append({
                "source_commit": c.get("commit"),
                "candidate_seed": c.get("seed_id"),
                "reason": "p3_floor",
            })
        print(json.dumps(output, ensure_ascii=False))
        return

    planned, executed = build_dedup_sets(journal, forum, self_seed_id)

    for c in candidates:
        accept, reason = classify_candidate(c, self_seed_id, planned, executed)
        if accept:
            output["eligible"].append(c)
        else:
            output["skipped"].append({
                "source_commit": c.get("commit"),
                "candidate_seed": c.get("seed_id"),
                "reason": reason,
            })

    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
