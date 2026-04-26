"""Subagent prompt builder: enforces § 4.1 prose-contract leading lines."""
import json, subprocess
from pathlib import Path

BUILDER = Path(__file__).parents[3] / "hooks/scripts/build-subagent-prompt.py"


def test_prompt_starts_with_cd_instruction(tmp_path):
    args = {
        "seed_id": 3,
        "worktree_path": "/abs/path/to/seed_3",
        "session_root": "/abs/path/to/.deep-evolve/sid",
        "helper_path": "/abs/path/to/hooks/scripts/session-helper.sh",
        "branch": "evolve/sid/seed-3",
        "n_block": 3,
    }
    r = subprocess.run(["python3", str(BUILDER),
                        "--args", json.dumps(args)],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    p = r.stdout
    # First ~3 lines must contain the cd instruction
    head = "\n".join(p.split("\n")[:5])
    assert "cd /abs/path/to/seed_3" in head
    assert "pwd" in head
    assert "/abs/path/to/seed_3" in head
    # Branch explicitly named
    assert "evolve/sid/seed-3" in p
    # N_block explicitly named
    assert "3 experiments" in p or "N_block=3" in p or "exactly 3" in p
    # Session root absolute reference
    assert "/abs/path/to/.deep-evolve/sid" in p
    # Helper path absolute (C-2, C-4 fix)
    assert "/abs/path/to/hooks/scripts/session-helper.sh" in p
    # No literal token leakage
    assert "{helper_path}" not in p
    assert "SESSION_ROOT_rel" not in p


def test_prompt_mentions_forum_and_borrow_steps():
    args = {"seed_id": 1, "worktree_path": "/w", "session_root": "/s",
            "helper_path": "/h/session-helper.sh",
            "branch": "evolve/sid/seed-1", "n_block": 2}
    r = subprocess.run(["python3", str(BUILDER), "--args", json.dumps(args)],
                       capture_output=True, text=True)
    p = r.stdout
    assert "tail_forum" in p or "forum" in p.lower()
    assert "Step 5.f" in p or "cross-seed borrow" in p.lower()


def test_prompt_rejects_relative_helper_path():
    """C-4 fix: relative paths in helper_path must be rejected."""
    args = {"seed_id": 1, "worktree_path": "/w", "session_root": "/s",
            "helper_path": "hooks/scripts/session-helper.sh",  # relative!
            "branch": "evolve/sid/seed-1", "n_block": 2}
    r = subprocess.run(["python3", str(BUILDER), "--args", json.dumps(args)],
                       capture_output=True, text=True)
    assert r.returncode != 0
    assert "must be absolute path" in r.stderr
