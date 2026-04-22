"""Shared pytest fixtures for session-helper.sh v3 subcommand tests."""
import json
import subprocess
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[1] / "session-helper.sh"


def _run_helper(subcmd: str, *args, **env_overrides) -> dict:
    """Invoke session-helper.sh <subcmd> <args...> and parse JSON stdout.

    The v3 subcommands are expected to emit a single JSON object on stdout.
    """
    import os
    env = os.environ.copy()
    env.update(env_overrides)
    cp = subprocess.run(
        ["bash", str(HELPER), subcmd, *args],
        capture_output=True, text=True, env=env, check=False,
    )
    if cp.returncode != 0:
        raise AssertionError(
            f"helper {subcmd} failed: rc={cp.returncode}\n"
            f"stdout: {cp.stdout}\nstderr: {cp.stderr}"
        )
    return json.loads(cp.stdout.strip() or "{}")


@pytest.fixture
def run_helper():
    return _run_helper


@pytest.fixture
def make_journal(tmp_path):
    """Write a journal.jsonl from a list of (category, count) or event dicts."""
    def _make(entries):
        lines = []
        next_id = 1
        for entry in entries:
            if isinstance(entry, tuple):
                category, count = entry
                for _ in range(count):
                    lines.append(json.dumps({
                        "id": next_id,
                        "status": "planned",
                        "idea_category": category,
                        "idea": f"test idea {next_id}",
                        "timestamp": "2026-04-22T00:00:00Z",
                    }))
                    next_id += 1
            else:  # already a dict
                lines.append(json.dumps(entry))
        path = tmp_path / "journal.jsonl"
        path.write_text("\n".join(lines) + "\n")
        return path
    return _make


@pytest.fixture
def make_session_yaml(tmp_path):
    """Write a minimal session.yaml."""
    def _make(**overrides):
        content = {
            "session_id": "test-session",
            "deep_evolve_version": "3.0.0",
            "status": "active",
            "diagnose_retry": {"session_retries_used": 0, "gave_up_count": 0},
            "shortcut": {
                "cumulative_flagged": 0,
                "flagged_since_last_tier3": 0,
                "total_flagged": 0,
            },
        }
        content.update(overrides)
        import yaml
        path = tmp_path / "session.yaml"
        path.write_text(yaml.safe_dump(content))
        return path
    return _make
