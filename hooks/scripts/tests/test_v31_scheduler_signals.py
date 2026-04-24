"""Signal collector builds per-seed + session-wide signals for scheduler prompt."""
import json, subprocess
from pathlib import Path

COLLECTOR = Path(__file__).parents[3] / "hooks/scripts/scheduler-signals.py"


def test_per_seed_signals_computed(tmp_path):
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
      direction: "A"
      experiments_used: 4
      keeps: 2
      borrows_given: 1
      borrows_received: 0
      current_q: 0.42
      allocated_budget: 10
    - id: 2
      status: active
      direction: "B"
      experiments_used: 3
      keeps: 1
      borrows_given: 0
      borrows_received: 1
      current_q: 0.28
      allocated_budget: 10
""")
    journal = tmp_path / "journal.jsonl"
    journal.write_text(
        '{"event":"kept","seed_id":1,"q":0.38,"ts":"2026-04-23T10:00:00"}\n'
        '{"event":"kept","seed_id":1,"q":0.40,"ts":"2026-04-23T10:05:00"}\n'
        '{"event":"kept","seed_id":1,"q":0.42,"ts":"2026-04-23T10:10:00"}\n'
        '{"event":"kept","seed_id":2,"q":0.28,"ts":"2026-04-23T10:15:00"}\n'
    )
    r = subprocess.run(["python3", str(COLLECTOR),
                        "--session-yaml", str(session_yaml),
                        "--journal", str(journal),
                        "--forum", str(tmp_path / "nonexistent.jsonl")],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    data = json.loads(r.stdout)
    # Per-seed
    assert len(data["seeds"]) == 2
    s1 = next(s for s in data["seeds"] if s["id"] == 1)
    assert s1["status"] == "active"
    assert s1["experiments_used"] == 4
    assert s1["remaining_budget"] == 6  # 10 - 4
    assert s1["independent_exploration_satisfied"] is True  # >= 3
    # Q history for seed-1: [0.38, 0.40, 0.42] → delta 0.04 > 0.02 threshold → "up"
    assert s1["recent_Q_trend"] == "up", \
        "seed-1 Q monotonically increasing should yield 'up'"
    # Session-wide
    assert "session_Q_trend" in data
    assert "entropy_current" in data
    assert "forum_activity" in data


def test_seed_with_under_3_experiments_not_independent(tmp_path):
    """P3 floor: experiments_used < 3 → independent_exploration_satisfied=False."""
    session_yaml = tmp_path / "session.yaml"
    session_yaml.write_text("""
deep_evolve_version: "3.1.0"
virtual_parallel:
  n_current: 1
  budget_total: 10
  budget_unallocated: 0
  seeds:
    - id: 1
      status: active
      direction: "A"
      experiments_used: 2
      keeps: 0
      borrows_given: 0
      borrows_received: 0
      current_q: 0.12
      allocated_budget: 10
""")
    journal = tmp_path / "journal.jsonl"
    journal.write_text("")
    r = subprocess.run(["python3", str(COLLECTOR),
                        "--session-yaml", str(session_yaml),
                        "--journal", str(journal),
                        "--forum", str(tmp_path / "nope.jsonl")],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    data = json.loads(r.stdout)
    s1 = data["seeds"][0]
    assert s1["independent_exploration_satisfied"] is False, \
        "experiments_used=2 is below P3 floor (3)"
