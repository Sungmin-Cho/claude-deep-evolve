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
    assert s1["convergence_indicators"] is None, \
        "placeholder field must exist for T10 consumer schema stability"
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


def test_in_flight_block_synthesized_for_scheduled_without_completion(tmp_path):
    """Gap 1 closure: T11 expects in_flight_block per seed; T9 must populate it.

    Synthesis rule (spec § 6.3): a seed is in-flight iff the most recent
    event keyed to it is `seed_scheduled` (via chosen_seed_id) with NO
    subsequent `seed_block_completed` / `seed_block_failed` (via seed_id).
    """
    import json, subprocess, yaml
    sy = tmp_path / "session.yaml"
    sy.write_text(yaml.safe_dump({
        "deep_evolve_version": "3.1.0",
        "virtual_parallel": {
            "n_current": 2,
            "budget_unallocated": 0,
            "seeds": [
                {"id": 1, "status": "active", "experiments_used": 3,
                 "allocated_budget": 10, "current_q": 0.4, "keeps": 1,
                 "borrows_given": 0, "borrows_received": 0},
                {"id": 2, "status": "active", "experiments_used": 5,
                 "allocated_budget": 10, "current_q": 0.3, "keeps": 2,
                 "borrows_given": 0, "borrows_received": 0},
            ],
        },
    }))
    journal = tmp_path / "journal.jsonl"
    events = [
        {"event": "seed_scheduled", "chosen_seed_id": 1,
         "block_size": 3, "ts": "2026-04-24T10:00:00Z"},
        {"event": "seed_scheduled", "chosen_seed_id": 2,
         "block_size": 3, "ts": "2026-04-24T10:05:00Z"},
        {"event": "seed_block_completed", "seed_id": 2,
         "experiments_executed": 3, "final_q": 0.3,
         "ts": "2026-04-24T10:15:00Z"},
    ]
    journal.write_text("\n".join(json.dumps(e) for e in events) + "\n")
    forum = tmp_path / "forum.jsonl"
    forum.write_text("")

    script = Path(__file__).parents[3] / "hooks/scripts/scheduler-signals.py"
    r = subprocess.run(
        ["python3", str(script),
         "--session-yaml", str(sy),
         "--journal", str(journal),
         "--forum", str(forum)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    by_id = {s["id"]: s for s in out["seeds"]}
    assert by_id[1]["in_flight_block"] is True
    assert by_id[2]["in_flight_block"] is False


def test_in_flight_block_handles_seed_block_failed(tmp_path):
    """seed_block_failed must also clear in_flight_block."""
    import json, subprocess, yaml
    sy = tmp_path / "session.yaml"
    sy.write_text(yaml.safe_dump({
        "deep_evolve_version": "3.1.0",
        "virtual_parallel": {
            "n_current": 1,
            "budget_unallocated": 0,
            "seeds": [{"id": 1, "status": "active", "experiments_used": 1,
                       "allocated_budget": 5, "current_q": 0.0, "keeps": 0,
                       "borrows_given": 0, "borrows_received": 0}],
        },
    }))
    journal = tmp_path / "journal.jsonl"
    events = [
        {"event": "seed_scheduled", "chosen_seed_id": 1,
         "block_size": 2, "ts": "2026-04-24T10:00:00Z"},
        {"event": "seed_block_failed", "seed_id": 1,
         "failure_type": "crash_give_up", "partial_progress": 1,
         "ts": "2026-04-24T10:10:00Z"},
    ]
    journal.write_text("\n".join(json.dumps(e) for e in events) + "\n")
    (tmp_path / "forum.jsonl").write_text("")

    script = Path(__file__).parents[3] / "hooks/scripts/scheduler-signals.py"
    r = subprocess.run(
        ["python3", str(script),
         "--session-yaml", str(sy),
         "--journal", str(journal),
         "--forum", str(tmp_path / "forum.jsonl")],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["seeds"][0]["in_flight_block"] is False


def test_in_flight_block_defaults_false_when_no_events(tmp_path):
    """A fresh seed with no scheduler events must report in_flight_block=False."""
    import json, subprocess, yaml
    sy = tmp_path / "session.yaml"
    sy.write_text(yaml.safe_dump({
        "deep_evolve_version": "3.1.0",
        "virtual_parallel": {
            "n_current": 1,
            "budget_unallocated": 0,
            "seeds": [{"id": 1, "status": "active", "experiments_used": 0,
                       "allocated_budget": 5, "current_q": 0.0, "keeps": 0,
                       "borrows_given": 0, "borrows_received": 0}],
        },
    }))
    journal = tmp_path / "journal.jsonl"
    journal.write_text("")
    (tmp_path / "forum.jsonl").write_text("")

    script = Path(__file__).parents[3] / "hooks/scripts/scheduler-signals.py"
    r = subprocess.run(
        ["python3", str(script),
         "--session-yaml", str(sy),
         "--journal", str(journal),
         "--forum", str(tmp_path / "forum.jsonl")],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["seeds"][0]["in_flight_block"] is False
