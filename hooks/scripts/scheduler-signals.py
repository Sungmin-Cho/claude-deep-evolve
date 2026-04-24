#!/usr/bin/env python3
"""Collect per-seed + session-wide signals for scheduler's decision prompt.

Outputs a JSON structure consumed by the scheduler prompt builder (T10).
Implements § 6.3 per-seed signals and § 6.4 session-wide signals.
"""
import argparse
import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: PyYAML required. Install: pip install pyyaml", file=sys.stderr)
    sys.exit(2)


def first_last_delta_trend(qs):
    """First-to-last delta of Q series; emits 'up'/'flat'/'down'.

    NOT a linear regression — intentionally coarse to match what the scheduler
    needs. For a true regression, use numpy.polyfit; we don't need precision here.
    """
    if len(qs) < 2:
        return "flat"
    delta = qs[-1] - qs[0]
    if delta > 0.02:
        return "up"
    if delta < -0.02:
        return "down"
    return "flat"


def load_jsonl(path):
    """Parse JSONL; skip malformed lines silently (consumer doesn't care)."""
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _die(msg, rc=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(rc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-yaml", required=True, type=Path)
    ap.add_argument("--journal", required=True, type=Path)
    ap.add_argument("--forum", required=True, type=Path)
    args = ap.parse_args()

    if not args.session_yaml.is_file():
        _die(f"session.yaml not found: {args.session_yaml}")

    try:
        session = yaml.safe_load(args.session_yaml.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        _die(f"session.yaml parse error: {e}")
    if not isinstance(session, dict):
        _die("session.yaml must be a mapping at the top level")

    vp = session.get("virtual_parallel", {}) or {}
    seeds_cfg = vp.get("seeds", []) or []
    journal_events = load_jsonl(args.journal)
    forum_events = load_jsonl(args.forum)

    # Build per-seed signals
    per_seed = []
    for s in seeds_cfg:
        if not isinstance(s, dict) or "id" not in s:
            print(f"warn: skipping malformed seed entry: {s}", file=sys.stderr)
            continue
        sid = s["id"]
        # Last 5 Q values for this seed (from journal "kept" events)
        seed_kepts = [e for e in journal_events
                      if e.get("event") == "kept" and e.get("seed_id") == sid]
        qs = [e.get("q", 0.0) for e in seed_kepts][-5:]
        # Last 3 events for this seed
        seed_events = [e for e in journal_events if e.get("seed_id") == sid][-3:]
        per_seed.append({
            "id": sid,
            "status": s.get("status", "active"),
            "direction": s.get("direction"),
            "recent_Q_trend": first_last_delta_trend(qs),
            "last_events": [e.get("event") for e in seed_events],
            "experiments_used": s.get("experiments_used", 0),
            "keeps": s.get("keeps", 0),
            "borrows_given": s.get("borrows_given", 0),
            "borrows_received": s.get("borrows_received", 0),
            "current_q": s.get("current_q", 0.0),
            "allocated_budget": s.get("allocated_budget", 0),
            "remaining_budget": s.get("allocated_budget", 0) - s.get("experiments_used", 0),
            "independent_exploration_satisfied": s.get("experiments_used", 0) >= 3,
        })

    # Session-wide signals
    # Best-seed-so-far Q trend: track max Q across seeds over time (latest 10 timestamps)
    best_q_series = []
    seen_times = sorted({e.get("ts") for e in journal_events if e.get("ts")})
    for t in seen_times[-10:]:
        events_up_to = [e for e in journal_events if e.get("ts", "") <= t]
        qs_per_seed = {}
        for e in events_up_to:
            if e.get("event") == "kept":
                sid = e.get("seed_id")
                q = e.get("q", 0.0)
                qs_per_seed[sid] = max(qs_per_seed.get(sid, 0.0), q)
        if qs_per_seed:
            best_q_series.append(max(qs_per_seed.values()))

    # forum_activity: forum events in last 5 blocks (blocks = seed_scheduled events)
    sched_events = [e for e in journal_events if e.get("event") == "seed_scheduled"]
    last_5_sched_ts = [e.get("ts") for e in sched_events[-5:]]
    if last_5_sched_ts:
        recent_forum = [e for e in forum_events
                        if e.get("ts", "") >= last_5_sched_ts[0]]
    else:
        recent_forum = forum_events

    output = {
        "seeds": per_seed,
        "session_Q_trend": first_last_delta_trend(best_q_series),
        "entropy_current": None,  # wired via v3.0 entropy tracker in T25 integration
        "flagged_rate": sum(1 for e in journal_events
                            if e.get("event") == "shortcut_flagged"),
        "forum_activity": len(recent_forum),
        "budget_unallocated": vp.get("budget_unallocated", 0),
        "n_current": vp.get("n_current", len(seeds_cfg)),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
