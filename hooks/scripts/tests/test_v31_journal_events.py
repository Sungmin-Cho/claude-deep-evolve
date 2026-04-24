"""Journal event helpers for v3.1-specific events."""
import json, subprocess, os
from pathlib import Path

HELPER = Path(__file__).parents[3] / "hooks/scripts/session-helper.sh"


def setup(tmp_path):
    repo = tmp_path / "p"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    sr = repo / ".deep-evolve" / "s"
    sr.mkdir(parents=True)
    env = os.environ.copy()
    env.update({"EVOLVE_DIR": str(repo / ".deep-evolve"),
                "SESSION_ID": "s", "SESSION_ROOT": str(sr)})
    return repo, sr, env


def test_append_seed_scheduled_event(tmp_path):
    repo, sr, env = setup(tmp_path)
    event = {
        "event": "seed_scheduled",
        "chosen_seed_id": 2,
        "block_size": 3,
        "decision_type": "schedule",
        "reasoning": "test",
        "signals_used": ["recent_Q_trend"],
        "all_seeds_snapshot": {"1": {"Q": 0.3}, "2": {"Q": 0.4}},
    }
    r = subprocess.run(
        ["bash", str(HELPER), "append_journal_event", json.dumps(event)],
        cwd=repo, env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    lines = (sr / "journal.jsonl").read_text().strip().split("\n")
    rec = json.loads(lines[-1])
    assert rec["event"] == "seed_scheduled"
    assert rec["chosen_seed_id"] == 2
    assert "ts" in rec
    assert "session_id" in rec


def test_append_validates_json(tmp_path):
    repo, sr, env = setup(tmp_path)
    r = subprocess.run(
        ["bash", str(HELPER), "append_journal_event", "not-json"],
        cwd=repo, env=env, capture_output=True, text=True)
    assert r.returncode != 0
