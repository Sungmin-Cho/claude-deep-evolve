"""Scheduler decision parser: validates JSON, clamps block_size, emits journal event."""
import json, subprocess
from pathlib import Path

DECIDE = Path(__file__).parents[3] / "hooks/scripts/scheduler-decide.py"
ALLOWED_BLOCK = [1, 2, 3, 5, 8]


def test_valid_decision_accepted():
    decision = {
        "decision": "schedule",
        "chosen_seed_id": 3,
        "block_size": 3,
        "reasoning": "Seed-3 up-trend",
        "signals_used": ["recent_Q_trend"],
    }
    r = subprocess.run(
        ["python3", str(DECIDE), "--decision", json.dumps(decision)],
        capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["accepted"] is True
    assert out["clamped"] is False
    assert out["block_size"] == 3


def test_block_size_4_clamps_to_3_lower_tie_break():
    """Lower tie-break policy: 4 -> 3 (not 5). Locks in the deterministic choice."""
    decision = {
        "decision": "schedule", "chosen_seed_id": 1,
        "block_size": 4, "reasoning": "test", "signals_used": [],
    }
    r = subprocess.run(
        ["python3", str(DECIDE), "--decision", json.dumps(decision)],
        capture_output=True, text=True)
    assert r.returncode == 0
    out = json.loads(r.stdout)
    assert out["clamped"] is True
    assert out["original_block_size"] == 4
    assert out["block_size"] == 3, "lower-tie-break policy: 4 -> 3, not 5"


def test_block_size_6_clamps_to_5_lower_tie_break():
    """6 -> 5 (|6-5|=1 < |6-8|=2 - nearest neighbor, no tie). Verifies ALLOWED_BLOCK gaps."""
    decision = {"decision": "schedule", "chosen_seed_id": 1,
                "block_size": 6, "reasoning": "t", "signals_used": []}
    r = subprocess.run(["python3", str(DECIDE), "--decision", json.dumps(decision)],
                       capture_output=True, text=True)
    out = json.loads(r.stdout)
    assert out["block_size"] == 5


def test_block_size_7_clamps_to_8():
    """7 -> 8 (|7-8|=1 < |7-5|=2)."""
    decision = {"decision": "schedule", "chosen_seed_id": 1,
                "block_size": 7, "reasoning": "t", "signals_used": []}
    r = subprocess.run(["python3", str(DECIDE), "--decision", json.dumps(decision)],
                       capture_output=True, text=True)
    out = json.loads(r.stdout)
    assert out["block_size"] == 8


def test_block_size_10_clamps_to_8():
    decision = {"decision": "schedule", "chosen_seed_id": 1,
                "block_size": 10, "reasoning": "t", "signals_used": []}
    r = subprocess.run(["python3", str(DECIDE), "--decision", json.dumps(decision)],
                       capture_output=True, text=True)
    out = json.loads(r.stdout)
    assert out["clamped"] is True
    assert out["block_size"] == 8


def test_block_size_0_clamps_to_1():
    decision = {"decision": "schedule", "chosen_seed_id": 1,
                "block_size": 0, "reasoning": "t", "signals_used": []}
    r = subprocess.run(["python3", str(DECIDE), "--decision", json.dumps(decision)],
                       capture_output=True, text=True)
    out = json.loads(r.stdout)
    assert out["clamped"] is True
    assert out["block_size"] == 1


def test_invalid_decision_type_rejected():
    decision = {"decision": "bogus", "chosen_seed_id": 1, "block_size": 3,
                "reasoning": "", "signals_used": []}
    r = subprocess.run(["python3", str(DECIDE), "--decision", json.dumps(decision)],
                       capture_output=True, text=True)
    assert r.returncode != 0
    assert "invalid decision" in r.stderr.lower() or "bogus" in r.stderr.lower()


def test_missing_required_field_rejected():
    decision = {"decision": "schedule", "chosen_seed_id": 1}  # missing block_size etc.
    r = subprocess.run(["python3", str(DECIDE), "--decision", json.dumps(decision)],
                       capture_output=True, text=True)
    assert r.returncode != 0


def test_clamped_emits_block_size_adjusted_event():
    """When block_size is clamped, journal_events_to_append must include the event."""
    decision = {"decision": "schedule", "chosen_seed_id": 2,
                "block_size": 6, "reasoning": "t", "signals_used": []}
    r = subprocess.run(["python3", str(DECIDE), "--decision", json.dumps(decision)],
                       capture_output=True, text=True)
    out = json.loads(r.stdout)
    events = out["journal_events_to_append"]
    assert len(events) == 1
    assert events[0]["event"] == "block_size_adjusted"
    assert events[0]["seed_id"] == 2
    assert events[0]["original"] == 6
    assert events[0]["clamped"] == 5
