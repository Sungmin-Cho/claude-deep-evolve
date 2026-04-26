"""Scheduler soft fairness + in-flight kill atomicity."""
import json, subprocess
from pathlib import Path

DECIDE = Path(__file__).parents[3] / "hooks/scripts/scheduler-decide.py"
SIGNALS = Path(__file__).parents[3] / "hooks/scripts/scheduler-signals.py"


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


def test_scheduler_signals_do_not_false_starve_active_seeds(tmp_path):
    """Producer/consumer integration: scheduler-signals must populate
    experiments_used_this_epoch so scheduler-decide does not default every
    non-chosen active seed to 0 and report a false fairness violation.
    """
    session_yaml = tmp_path / "session.yaml"
    session_yaml.write_text("""
deep_evolve_version: "3.1.0"
virtual_parallel:
  n_current: 2
  budget_total: 20
  budget_unallocated: 0
  seeds:
    - id: 1
      status: active
      direction: A
      experiments_used: 4
      keeps: 1
      borrows_given: 0
      borrows_received: 0
      current_q: 0.4
      allocated_budget: 10
    - id: 2
      status: active
      direction: B
      experiments_used: 3
      keeps: 1
      borrows_given: 0
      borrows_received: 0
      current_q: 0.3
      allocated_budget: 10
""")
    journal = tmp_path / "journal.jsonl"
    journal.write_text(
        '{"event":"kept","seed_id":1,"q":0.4,"ts":"2026-04-23T10:00:00"}\n'
        '{"event":"kept","seed_id":2,"q":0.3,"ts":"2026-04-23T10:01:00"}\n'
    )
    forum = tmp_path / "forum.jsonl"
    forum.write_text("")
    sig = subprocess.run(["python3", str(SIGNALS),
                          "--session-yaml", str(session_yaml),
                          "--journal", str(journal),
                          "--forum", str(forum)],
                         capture_output=True, text=True)
    assert sig.returncode == 0, sig.stderr
    decision = {"decision": "schedule", "chosen_seed_id": 1,
                "block_size": 3, "reasoning": "", "signals_used": []}
    r = subprocess.run(["python3", str(DECIDE),
                        "--decision", json.dumps(decision),
                        "--signals", sig.stdout],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["fairness_violation"] is False
