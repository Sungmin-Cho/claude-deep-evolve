"""Cleanup of borrow_planned events older than 2 block boundaries (spec § 7.4 P1)."""
import json, subprocess
from pathlib import Path

SCAN = Path(__file__).parents[3] / "hooks/scripts/borrow-abandoned-scan.py"


def _run(journal_events):
    """Invoke scanner with an inline journal fixture; return emitted events + new journal."""
    r = subprocess.run(
        ["python3", str(SCAN),
         "--journal-json", json.dumps(journal_events),
         "--current-block-id", "10",
         "--staleness-blocks", "2"],
        capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_borrow_planned_under_threshold_not_abandoned():
    events = [
        {"event": "borrow_planned", "seed_id": 1, "source_commit": "abc",
         "plan_rationale": "r", "planned_for_experiment_id": 5,
         "block_id": 9},  # only 1 block old
    ]
    out = _run(events)
    assert out["abandoned_events"] == []


def test_borrow_planned_stale_without_execution_emits_abandoned():
    events = [
        {"event": "borrow_planned", "seed_id": 1, "source_commit": "abc",
         "plan_rationale": "r", "planned_for_experiment_id": 5,
         "block_id": 7},  # 3 blocks old — > threshold (2)
    ]
    out = _run(events)
    assert len(out["abandoned_events"]) == 1
    ab = out["abandoned_events"][0]
    assert ab["event"] == "borrow_abandoned"
    assert ab["seed_id"] == 1
    assert ab["source_commit"] == "abc"
    assert ab["reason"] in ("stale_no_execution", "timeout")


def test_borrow_planned_with_matching_cross_seed_borrow_not_abandoned():
    events = [
        {"event": "borrow_planned", "seed_id": 1, "source_commit": "abc",
         "plan_rationale": "r", "planned_for_experiment_id": 5,
         "block_id": 7},
        # Execution landed; cross_seed_borrow is matched via (to_seed, source_commit).
        # Test data is intentionally simple — to_seed=1 (same seed id as the planner).
        {"event": "cross_seed_borrow", "from_seed": 1, "to_seed": 1,
         "source_commit": "abc", "target_commit": "def", "block_id": 8},
    ]
    out = _run(events)
    assert out["abandoned_events"] == []


def test_already_emitted_abandoned_not_re_emitted():
    """Idempotent: running scan twice shouldn't emit duplicate abandoned events."""
    events = [
        {"event": "borrow_planned", "seed_id": 1, "source_commit": "abc",
         "plan_rationale": "r", "planned_for_experiment_id": 5,
         "block_id": 7},
        {"event": "borrow_abandoned", "seed_id": 1, "source_commit": "abc",
         "reason": "stale_no_execution", "block_id": 10},
    ]
    out = _run(events)
    assert out["abandoned_events"] == []
