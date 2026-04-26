"""Scheduler soft fairness + in-flight kill atomicity."""
import json, subprocess
from pathlib import Path

DECIDE = Path(__file__).parents[3] / "hooks/scripts/scheduler-decide.py"


def test_fairness_ok_when_all_seeds_have_exp_this_epoch():
    decision = {"decision": "schedule", "chosen_seed_id": 1,
                "block_size": 3, "reasoning": "", "signals_used": []}
    signals = {
        "seeds": [
            {"id": 1, "status": "active", "experiments_used_this_epoch": 2},
            {"id": 2, "status": "active", "experiments_used_this_epoch": 1},
        ]
    }
    r = subprocess.run(["python3", str(DECIDE),
                        "--decision", json.dumps(decision),
                        "--signals", json.dumps(signals)],
                       capture_output=True, text=True)
    assert r.returncode == 0
    out = json.loads(r.stdout)
    assert out["fairness_violation"] is False


def test_fairness_violation_detected():
    """seed_2 has 0 experiments this epoch but is active; scheduler should signal violation."""
    decision = {"decision": "schedule", "chosen_seed_id": 1,
                "block_size": 3, "reasoning": "", "signals_used": []}
    signals = {
        "seeds": [
            {"id": 1, "status": "active", "experiments_used_this_epoch": 2},
            {"id": 2, "status": "active", "experiments_used_this_epoch": 0},
        ]
    }
    r = subprocess.run(["python3", str(DECIDE),
                        "--decision", json.dumps(decision),
                        "--signals", json.dumps(signals)],
                       capture_output=True, text=True)
    # Not a hard reject — but must surface fairness_violation + starved_seed_ids
    assert r.returncode == 0
    out = json.loads(r.stdout)
    assert out["fairness_violation"] is True
    assert 2 in out["starved_seed_ids"]


def test_kill_under_inflight_defers_to_queue():
    decision = {"decision": "kill_then_schedule", "chosen_seed_id": 2,
                "kill_target": 1, "block_size": 3, "reasoning": "",
                "signals_used": []}
    signals = {"seeds": [
        {"id": 1, "status": "active", "in_flight_block": True,
         "experiments_used_this_epoch": 2},
        {"id": 2, "status": "active", "in_flight_block": False,
         "experiments_used_this_epoch": 1},
    ]}
    r = subprocess.run(["python3", str(DECIDE),
                        "--decision", json.dumps(decision),
                        "--signals", json.dumps(signals)],
                       capture_output=True, text=True)
    assert r.returncode == 0
    out = json.loads(r.stdout)
    # Kill deferred to queue, not applied immediately
    assert out["kill_deferred"] is True
    assert out["kill_target"] == 1
    # Still schedules the non-kill seed
    assert out["chosen_seed_id"] == 2
