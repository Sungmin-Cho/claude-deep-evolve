"""Verify session-helper.sh exposes v3.1 worktree lifecycle functions."""
import subprocess
import tempfile
import os
from pathlib import Path

HELPER = Path(__file__).parents[3] / "hooks/scripts/session-helper.sh"


def run_helper(subcmd, *args, cwd=None, env=None):
    """Invoke session-helper.sh subcommand, return (stdout, stderr, returncode)."""
    cmd = ["bash", str(HELPER), subcmd, *args]
    full_env = os.environ.copy()
    if env:
        full_env.update(env)
    result = subprocess.run(cmd, cwd=cwd, env=full_env, capture_output=True, text=True)
    return result.stdout, result.stderr, result.returncode


def test_create_seed_worktree_subcommand_exists():
    """session-helper.sh must expose `create_seed_worktree` subcommand."""
    stdout, stderr, rc = run_helper("help")
    # Combined output (help may go to stderr)
    assert "create_seed_worktree" in (stdout + stderr), (
        "session-helper.sh help output should list create_seed_worktree"
    )


def test_validate_seed_worktree_subcommand_exists():
    stdout, stderr, rc = run_helper("help")
    assert "validate_seed_worktree" in (stdout + stderr)


def test_create_seed_worktree_creates_worktree_and_branch(tmp_path, monkeypatch):
    """Integration: create_seed_worktree should create the worktree dir + branch."""
    # Setup a fresh git repo
    repo = tmp_path / "proj"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "-c", "user.email=t@t.t", "-c", "user.name=T",
                    "commit", "--allow-empty", "-m", "init"],
                   cwd=repo, check=True, capture_output=True)

    session_root = repo / ".deep-evolve" / "sess-001"
    session_root.mkdir(parents=True)

    env = {
        "EVOLVE_DIR": str(repo / ".deep-evolve"),
        "SESSION_ID": "sess-001",
        "SESSION_ROOT": str(session_root),
    }
    stdout, stderr, rc = run_helper(
        "create_seed_worktree", "1",
        cwd=str(repo), env=env,
    )
    assert rc == 0, f"create_seed_worktree failed: stderr={stderr}"

    # Worktree directory must exist
    wt_path = session_root / "worktrees" / "seed_1"
    assert wt_path.is_dir(), f"worktree not created: {wt_path}"

    # Branch must exist
    branches = subprocess.run(["git", "branch", "--list"], cwd=repo,
                              capture_output=True, text=True, check=True).stdout
    assert "evolve/sess-001/seed-1" in branches, f"branch not created: {branches}"


def test_validate_seed_worktree_clean_returns_ok(tmp_path):
    """validate_seed_worktree on a clean worktree should return 0."""
    repo = tmp_path / "proj"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "-c", "user.email=t@t.t", "-c", "user.name=T",
                    "commit", "--allow-empty", "-m", "init"],
                   cwd=repo, check=True, capture_output=True)

    session_root = repo / ".deep-evolve" / "sess-001"
    session_root.mkdir(parents=True)
    env = {
        "EVOLVE_DIR": str(repo / ".deep-evolve"),
        "SESSION_ID": "sess-001",
        "SESSION_ROOT": str(session_root),
    }
    run_helper("create_seed_worktree", "1", cwd=str(repo), env=env)

    stdout, stderr, rc = run_helper(
        "validate_seed_worktree", "1",
        cwd=str(repo), env=env,
    )
    assert rc == 0, f"validate_seed_worktree failed on clean tree: stderr={stderr}"
    assert "clean" in stdout.lower() or rc == 0
