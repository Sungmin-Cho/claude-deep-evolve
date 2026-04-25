#!/usr/bin/env python3
"""status-dashboard.py — render per-seed dashboard per spec § 13.1.

Pure read-only: reads session.yaml + journal.jsonl + forum.jsonl,
aggregates per-seed exp/keep + cross-seed borrow recv/given counts,
prints the dashboard to stdout. Skip-and-warn on malformed JSONL
lines (T22 partial-event tolerance pattern).

Exit codes:
  0  success (dashboard rendered)
  2  operator error (missing args, missing files, malformed yaml)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

# I7 fix (deep-review 2026-04-25 plan-stage): defer PyYAML check from
# module-import to main(), so future unit tests can import this module
# (e.g., to test _aggregate_journal / _aggregate_forum / _is_int directly)
# without crashing when PyYAML is absent or mocked.
try:
    import yaml  # PyYAML; required by other deep-evolve helpers
    _YAML_IMPORT_ERROR = None
except ImportError as _e:
    yaml = None  # type: ignore
    _YAML_IMPORT_ERROR = _e


def _die(msg: str, code: int = 2) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def _warn(msg: str) -> None:
    print(f"warning: {msg}", file=sys.stderr)


def _is_int(v: Any) -> bool:
    """Accept Python int but reject bool (True is 1 in Python) — T26
    borrows_given inflation regression class. Also accept integral floats."""
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return True
    if isinstance(v, float) and v.is_integer():
        return True
    return False


def _read_yaml(path: Path) -> dict:
    if not path.is_file():
        _die(f"session.yaml not found at {path}")
    # I5 fix (deep-review 2026-04-25 plan-stage): catch OSError/PermissionError
    # so unreadable files (EACCES) route through _die rc=2 with the canonical
    # `error: ` prefix instead of an uncaught traceback to rc=1.
    try:
        with path.open(encoding="utf-8") as f:
            data = yaml.safe_load(f)
    except (OSError, PermissionError) as e:
        _die(f"cannot read session.yaml at {path}: {e}")
    except yaml.YAMLError as e:
        _die(f"malformed session.yaml: {e}")
    if not isinstance(data, dict):
        _die("session.yaml must parse to a mapping at the top level")
    return data


def _iter_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        _die(f"file not found: {path}")
    out: list[dict] = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            _warn(f"skip malformed line {path.name}:{i} — {e}")
            continue
        if isinstance(obj, dict):
            out.append(obj)
        else:
            _warn(f"skip non-object line {path.name}:{i}")
    return out


def _aggregate_journal(events: list[dict]) -> dict[int, dict[str, int]]:
    """Per-seed: experiments (kept+discarded+evaluated), keeps."""
    agg: dict[int, dict[str, int]] = {}
    for ev in events:
        sid = ev.get("seed_id")
        if not _is_int(sid):
            continue
        sid = int(sid)
        bucket = agg.setdefault(sid, {"exp": 0, "keep": 0})
        et = ev.get("event") or ev.get("status")
        if et in ("kept", "discarded", "evaluated"):
            bucket["exp"] += 1
        if et == "kept":
            bucket["keep"] += 1
    return agg


def _aggregate_forum(events: list[dict]) -> tuple[
    dict[int, int], dict[int, int], int, int
]:
    """recv[k], given[k], total borrow events, total convergence events."""
    recv: dict[int, int] = {}
    given: dict[int, int] = {}
    n_borrow = 0
    n_conv = 0
    for ev in events:
        et = ev.get("event")
        if et == "cross_seed_borrow":
            n_borrow += 1
            t, f = ev.get("to_seed"), ev.get("from_seed")
            if _is_int(t):
                recv[int(t)] = recv.get(int(t), 0) + 1
            if _is_int(f):
                given[int(f)] = given.get(int(f), 0) + 1
        elif et == "convergence_event":
            n_conv += 1
    return recv, given, n_borrow, n_conv


def _last_event(events: list[dict]) -> str:
    """Render the most recent journal event for the dashboard footer.

    W7 contract (deep-review 2026-04-25 plan-stage): scope is journal-only
    (NOT merged journal+forum). Spec § 13.1 sample shows
    `Last event: seed_scheduled seed=3 block=5 (14:32)` which is a journal
    event. Forum events (cross_seed_borrow, convergence_event) are
    summarized separately on the `Forum: N borrow events, M convergence`
    line per § 13.1. If a future spec revision wants a merged view,
    it should explicitly say so — silently merging here would change the
    sample-output contract.
    """
    if not events:
        return "(none)"
    last = events[-1]
    et = last.get("event") or last.get("status") or "?"
    sid = last.get("seed_id", last.get("chosen_seed_id"))
    blk = last.get("block_id", last.get("block_size"))
    ts = last.get("ts", last.get("timestamp", ""))
    hh_mm = ""
    m = re.search(r"T(\d{2}:\d{2})", str(ts))
    if m:
        hh_mm = f" ({m.group(1)})"
    parts = [et]
    if sid is not None:
        parts.append(f"seed={sid}")
    if blk is not None:
        parts.append(f"block={blk}")
    return " ".join(parts) + hh_mm


def _render(session: dict, journal: list[dict], forum: list[dict]) -> str:
    vp = session.get("virtual_parallel") or {}
    n_current = vp.get("n_current", 1) if _is_int(vp.get("n_current", 1)) else 1
    budget_total = vp.get("budget_total", 0)
    budget_unalloc = vp.get("budget_unallocated", 0)
    budget_used = (
        budget_total - budget_unalloc
        if _is_int(budget_total) and _is_int(budget_unalloc)
        else 0
    )
    epoch = session.get("evaluation_epoch") or {}
    epoch_curr = epoch.get("current", 1)
    epoch_max = (
        len(epoch.get("history") or []) + 1
        if _is_int(epoch.get("current", 1))
        else 1
    )
    sid = session.get("session_id") or session.get("id") or "<unknown>"

    j_agg = _aggregate_journal(journal)
    recv, given, n_borrow, n_conv = _aggregate_forum(forum)

    lines: list[str] = []
    lines.append(
        f"Session {sid} — epoch {epoch_curr}/{epoch_max}, "
        f"budget {budget_used}/{budget_total} used"
    )
    lines.append("")
    lines.append("Seeds (borrow recv/given counts):" if n_current > 1 else "Seed:")
    seeds = vp.get("seeds") or []
    if not isinstance(seeds, list):
        seeds = []
    for s in seeds:
        if not isinstance(s, dict):
            continue
        sid_k = s.get("id")
        if not _is_int(sid_k):
            continue
        sid_k = int(sid_k)
        direction = (s.get("direction") or "").strip()
        status = (s.get("status") or "").strip() or "active"
        final_q = s.get("final_q", s.get("q"))
        q_str = f"{final_q:.2f}" if isinstance(final_q, (int, float)) else "—"
        exp = j_agg.get(sid_k, {}).get("exp", 0)
        keep = j_agg.get(sid_k, {}).get("keep", 0)
        r = recv.get(sid_k, 0)
        g = given.get(sid_k, 0)
        if status.startswith("killed"):
            killed_reason = s.get("killed_reason") or status.split(":", 1)[-1].strip()
            killed_at = s.get("killed_at", "")
            # Strip trailing Z from ISO timestamp so the regex [0-9T:\-\s]+ matches
            killed_at_display = killed_at.rstrip("Z") if killed_at else ""
            lines.append(
                f"  [{sid_k}] (killed: {killed_reason}"
                + (f" at {killed_at_display}" if killed_at_display else "")
                + f")  Q={q_str}  exp={exp}  keep={keep}"
            )
        else:
            lines.append(
                f"  [{sid_k}] {direction[:24]:<24}  {status:<8}  "
                f"Q={q_str}  exp={exp}  keep={keep}  "
                f"borrow recv={r} given={g}"
            )
    lines.append("")
    lines.append(f"Forum: {n_borrow} borrow events, {n_conv} convergence events")
    lines.append(f"Last event: {_last_event(journal)}")
    return "\n".join(lines) + "\n"


def main() -> int:
    # I7 fix (deep-review 2026-04-25 plan-stage): defer PyYAML availability
    # check from module-import to main(), so unit-test harnesses that mock
    # `yaml` can import this module's helpers without crashing.
    if _YAML_IMPORT_ERROR is not None:
        print(f"error: PyYAML not available (pip install pyyaml): {_YAML_IMPORT_ERROR}",
              file=sys.stderr)
        return 2

    p = argparse.ArgumentParser(
        description="Render per-seed dashboard per spec § 13.1."
    )
    p.add_argument("--session-yaml", required=True)
    p.add_argument("--journal", required=True)
    p.add_argument("--forum", required=True)
    args = p.parse_args()

    session = _read_yaml(Path(args.session_yaml))
    journal = _iter_jsonl(Path(args.journal))
    forum = _iter_jsonl(Path(args.forum))

    sys.stdout.write(_render(session, journal, forum))
    return 0


if __name__ == "__main__":
    sys.exit(main())
