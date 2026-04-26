#!/usr/bin/env python3
"""Generate per-epoch forum summary (spec § 7.1, § 7.2).

Consumes forum.jsonl events; emits markdown with per-seed sections and
convergence events. Called from Outer Loop Step 6.5.0 at epoch boundary.
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path


def load_events(forum_path: Path):
    """Parse forum.jsonl; skip malformed lines with a stderr warning."""
    if not forum_path.exists() or forum_path.stat().st_size == 0:
        return []
    events = []
    for line in forum_path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as e:
            print(f"warn: skipping malformed line: {e}", file=sys.stderr)
    return events


def per_seed_stats(events):
    """Group keeps/discards/borrows by seed_id."""
    stats = defaultdict(lambda: {
        "keeps": [], "discards": [], "borrows_given": [], "borrows_received": [],
    })
    for e in events:
        et = e.get("event")
        if et == "seed_keep":
            sid = e.get("seed_id")
            if sid is None:
                print(f"warn: skipping seed_keep missing seed_id: {e}", file=sys.stderr)
                continue
            stats[sid]["keeps"].append(e)
        elif et == "seed_discard":
            sid = e.get("seed_id")
            if sid is None:
                print(f"warn: skipping seed_discard missing seed_id: {e}", file=sys.stderr)
                continue
            stats[sid]["discards"].append(e)
        elif et == "cross_seed_borrow":
            from_seed = e.get("from_seed")
            to_seed = e.get("to_seed")
            if from_seed is None or to_seed is None:
                print(f"warn: skipping cross_seed_borrow missing endpoints: {e}", file=sys.stderr)
                continue
            stats[from_seed]["borrows_given"].append(e)
            stats[to_seed]["borrows_received"].append(e)
    return stats


def convergence_events(events):
    return [e for e in events if e.get("event") == "convergence_event"]


def _format_borrow_list(borrows, direction_word, key):
    """Build 'given/received' suffix without nested-quote f-strings (Python 3.11-safe).

    direction_word: 'to' (for borrows given) or 'from' (for borrows received).
    """
    if not borrows:
        return ""
    targets = ", ".join(f"{direction_word} seed-{b[key]}" for b in borrows)
    return targets


def render(stats, convs, gen_n):
    lines = [f"# Generation {gen_n} Forum Summary", ""]
    if not stats and not convs:
        lines.append("_no events recorded this epoch_")
        return "\n".join(lines)

    for seed_id in sorted(stats.keys()):
        s = stats[seed_id]
        lines.append(f"## Seed-{seed_id}")
        lines.append(f"- {len(s['keeps'])} keeps, {len(s['discards'])} discards")
        for k in s["keeps"][:3]:
            desc = k.get("description", "(no description)")
            delta = k.get("score_delta", "?")
            commit = k.get("commit") or "????????"
            lines.append(f"  - keep {commit[:8]}: {desc} (Δ={delta})")
        given_suffix = _format_borrow_list(s['borrows_given'], "to", "to_seed")
        recv_suffix = _format_borrow_list(s['borrows_received'], "from", "from_seed")
        given_line = f"- Borrow given: {len(s['borrows_given'])}"
        if given_suffix:
            given_line += f" ({given_suffix})"
        recv_line = f"- Borrow received: {len(s['borrows_received'])}"
        if recv_suffix:
            recv_line += f" ({recv_suffix})"
        lines.append(given_line)
        lines.append(recv_line)
        lines.append("")

    if convs:
        lines.append("## Convergence Events")
        for c in convs:
            sids = ", ".join(f"seed-{sid}" for sid in c.get("seed_ids", []))
            direction = c.get("direction")
            lines.append(f"- {sids}: direction={direction!r}, "
                         f"judged_as={c.get('judged_as')}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--forum", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--gen", required=True, type=int)
    args = ap.parse_args()
    events = load_events(args.forum)
    stats = per_seed_stats(events)
    convs = convergence_events(events)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(render(stats, convs, args.gen))


if __name__ == "__main__":
    main()
