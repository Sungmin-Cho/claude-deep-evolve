#!/usr/bin/env python3
"""cross-seed-audit.py — § 8.2 Step 3 forum aggregator.

Pure function: reads forum.jsonl + journal.jsonl, writes
completion/cross_seed_audit.md with:
  - Borrow matrix (from × to, counts)
  - Convergence event tally (per judged_as class)
  - Per-seed forum activity summary

Malformed JSONL lines are skipped with stderr warn (matches T5
forum-summary never-brick pattern). Self-borrows + missing-required-
field events are skipped silently (P5 paranoid guards).

N=1 case (only one distinct seed in journal) emits 'N/A — single seed
session' marker per spec § 8.5.

Exit codes:
  0 — audit written
  2 — operator error (missing arg, missing input file)
"""
import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def _die(msg, rc=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(rc)


def _load_jsonl(path, label):
    """Parse JSONL; skip + warn on malformed lines."""
    if not path.is_file():
        _die(f"{label} file not found: {path}")
    out = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            print(f"warn: skipping malformed {label} line {i}", file=sys.stderr)
            continue
    return out


def _build_borrow_matrix(forum_events):
    """Returns {(from_seed, to_seed): count} dict, skipping self-borrows
    and entries missing required fields."""
    matrix = Counter()
    for e in forum_events:
        if e.get("event") != "cross_seed_borrow":
            continue
        from_s = e.get("from_seed")
        to_s = e.get("to_seed")
        if from_s is None or to_s is None:
            continue   # missing field, skip
        if from_s == to_s:
            continue   # self-borrow paranoid skip (matches T17 P5 guard)
        matrix[(from_s, to_s)] += 1
    return matrix


def _build_convergence_tally(forum_events):
    """Returns {judged_as: count}."""
    tally = Counter()
    for e in forum_events:
        if e.get("event") != "convergence_event":
            continue
        judged = e.get("judged_as")
        if judged:
            tally[judged] += 1
    return tally


def _build_per_seed_activity(forum_events, journal_events):
    """Returns {seed_id: {keeps, discards, borrows_given, borrows_received,
    convergence_participations}}."""
    activity = defaultdict(lambda: {
        "keeps": 0, "discards": 0,
        "borrows_given": 0, "borrows_received": 0,
        "convergence_participations": 0,
    })
    for e in forum_events:
        et = e.get("event")
        sid = e.get("seed_id")
        if et == "seed_keep" and sid is not None:
            activity[sid]["keeps"] += 1
        elif et == "seed_discard" and sid is not None:
            activity[sid]["discards"] += 1
        elif et == "cross_seed_borrow":
            from_s, to_s = e.get("from_seed"), e.get("to_seed")
            if from_s is not None and from_s != to_s:
                activity[from_s]["borrows_given"] += 1
            if to_s is not None and to_s != from_s:
                activity[to_s]["borrows_received"] += 1
        elif et == "convergence_event":
            for s in e.get("seed_ids", []) or []:
                activity[s]["convergence_participations"] += 1
    # Also include seeds that only appear in journal (no forum activity)
    for e in journal_events:
        if e.get("event") == "seed_initialized":
            sid = e.get("seed_id")
            if sid is not None:
                _ = activity[sid]   # touch to add empty entry
    return dict(activity)


def _count_distinct_seeds(journal_events):
    seeds = set()
    for e in journal_events:
        if e.get("event") == "seed_initialized":
            sid = e.get("seed_id")
            if sid is not None:
                seeds.add(sid)
    return len(seeds)


def _format_borrow_matrix(matrix):
    if not matrix:
        return "_No cross-seed exchanges (0 borrows recorded)._\n"
    lines = ["| from → to | count |", "|---|---|"]
    for (from_s, to_s) in sorted(matrix.keys()):
        lines.append(f"| {from_s} → {to_s} | {matrix[(from_s, to_s)]} |")
    return "\n".join(lines) + "\n"


def _format_convergence(tally):
    if not tally:
        return "_No convergence events recorded._\n"
    lines = ["| judged_as | count |", "|---|---|"]
    for judged in sorted(tally.keys()):
        lines.append(f"| {judged} | {tally[judged]} |")
    return "\n".join(lines) + "\n"


def _format_per_seed(activity):
    if not activity:
        return "_No seed activity recorded._\n"
    lines = ["| seed | keeps | discards | borrows_given | borrows_received | convergence |",
             "|---|---|---|---|---|---|"]
    for sid in sorted(activity.keys()):
        a = activity[sid]
        lines.append(
            f"| Seed {sid} | {a['keeps']} | {a['discards']} | "
            f"{a['borrows_given']} | {a['borrows_received']} | "
            f"{a['convergence_participations']} |"
        )
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(
        description="§ 8.2 Step 3 forum aggregator"
    )
    ap.add_argument("--forum", required=True, type=Path)
    ap.add_argument("--journal", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    args = ap.parse_args()

    forum_events = _load_jsonl(args.forum, "forum")
    journal_events = _load_jsonl(args.journal, "journal")

    n_seeds = _count_distinct_seeds(journal_events)

    # N=1 short-circuit per spec § 8.5
    if n_seeds == 1:
        body = (
            "# Cross-Seed Audit\n\n"
            "## Status\n\n"
            "**N/A — single seed session.** Cross-seed exchanges, "
            "convergence events, and inter-seed borrows do not apply "
            "when N=1. See `seed_reports/seed_<k>.md` for this seed's "
            "individual journey.\n\n"
            "## Borrow Matrix\n\n_N/A — single seed session._\n\n"
            "## Convergence Events\n\n_N/A — single seed session._\n\n"
            "## Per-Seed Forum Activity\n\n_N/A — single seed session._\n"
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(body, encoding="utf-8")
        return

    # Multi-seed path
    matrix = _build_borrow_matrix(forum_events)
    convergence = _build_convergence_tally(forum_events)
    activity = _build_per_seed_activity(forum_events, journal_events)

    body = (
        "# Cross-Seed Audit\n\n"
        f"_Multi-seed session — N={n_seeds}._\n\n"
        "## Borrow Matrix\n\n"
        + _format_borrow_matrix(matrix) + "\n"
        "## Convergence Events\n\n"
        + _format_convergence(convergence) + "\n"
        "## Per-Seed Forum Activity\n\n"
        + _format_per_seed(activity)
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(body, encoding="utf-8")


if __name__ == "__main__":
    main()
