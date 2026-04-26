"""session-helper.sh create_synthesis_worktree / cleanup_failed_synthesis_worktree.

create_synthesis_worktree <baseline_commit>
  - creates `git worktree add $SESSION_ROOT/worktrees/synthesis
                              -b evolve/<sid>/synthesis <baseline_commit>`
  - rc=2 on missing arg, SESSION_ROOT unset, SESSION_ID unset, pre-existing
    worktree at the synthesis path, pre-existing branch evolve/<sid>/synthesis,
    invalid baseline_commit
  - rc=0 on success

cleanup_failed_synthesis_worktree
  - renames branch evolve/<sid>/synthesis → evolve/<sid>/synthesis-failed-<ts>
  - removes the worktree (preserves the renamed branch for audit)
  - rc=0 on success or no-op when no synthesis worktree exists
  - rc=2 on SESSION_ROOT/SESSION_ID unset
"""
import os
import subprocess
from pathlib import Path

HELPER = Path(__file__).parents[3] / "hooks/scripts/session-helper.sh"


def _setup(tmp_path):
    repo = tmp_path / "p"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"],
                   cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "test"],
                   cwd=repo, check=True)
    # Initial commit so we have a baseline to pass to create_synthesis_worktree
    (repo / "README.md").write_text("init", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, check=True)
    initial_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=True,
        capture_output=True, text=True).stdout.strip()

    sid = "sess-test"
    sr = repo / ".deep-evolve" / sid
    sr.mkdir(parents=True)
    env = os.environ.copy()
    env.update({
        "EVOLVE_DIR": str(repo / ".deep-evolve"),
        "SESSION_ID": sid,
        "SESSION_ROOT": str(sr),
    })
    env.pop("SEED_ID", None)
    return repo, sr, env, initial_sha


def _run(args, repo, env):
    return subprocess.run(
        ["bash", str(HELPER), *args],
        cwd=repo, env=env, capture_output=True, text=True,
    )


# ---- create_synthesis_worktree --------------------------------------

def test_create_synthesis_worktree_happy_path(tmp_path):
    repo, sr, env, baseline = _setup(tmp_path)
    r = _run(["create_synthesis_worktree", baseline], repo, env)
    assert r.returncode == 0, r.stderr
    wt_path = sr / "worktrees" / "synthesis"
    assert wt_path.is_dir()
    # Verify the branch was created
    branches = subprocess.run(
        ["git", "branch", "--list", "evolve/sess-test/synthesis"],
        cwd=repo, capture_output=True, text=True,
    ).stdout
    assert "evolve/sess-test/synthesis" in branches


def test_create_synthesis_worktree_missing_baseline_arg_rc_2(tmp_path):
    repo, sr, env, _ = _setup(tmp_path)
    r = _run(["create_synthesis_worktree"], repo, env)
    assert r.returncode == 2
    assert "baseline" in r.stderr.lower() or "usage" in r.stderr.lower()


def test_create_synthesis_worktree_invalid_baseline_rc_2(tmp_path):
    repo, sr, env, _ = _setup(tmp_path)
    r = _run(["create_synthesis_worktree", "deadbeef" * 5], repo, env)
    assert r.returncode == 2


def test_create_synthesis_worktree_session_root_unset_rc_2(tmp_path):
    repo, sr, env, baseline = _setup(tmp_path)
    env.pop("SESSION_ROOT", None)
    r = _run(["create_synthesis_worktree", baseline], repo, env)
    assert r.returncode == 2
    assert "SESSION_ROOT" in r.stderr


def test_create_synthesis_worktree_session_id_unset_rc_2(tmp_path):
    repo, sr, env, baseline = _setup(tmp_path)
    env.pop("SESSION_ID", None)
    r = _run(["create_synthesis_worktree", baseline], repo, env)
    assert r.returncode == 2
    assert "SESSION_ID" in r.stderr


def test_create_synthesis_worktree_rejects_pre_existing_worktree(tmp_path):
    repo, sr, env, baseline = _setup(tmp_path)
    r = _run(["create_synthesis_worktree", baseline], repo, env)
    assert r.returncode == 0
    # Second call must reject
    r2 = _run(["create_synthesis_worktree", baseline], repo, env)
    assert r2.returncode == 2
    assert "exist" in r2.stderr.lower() or "already" in r2.stderr.lower()


def test_create_synthesis_worktree_rejects_pre_existing_branch(tmp_path):
    """Branch exists without worktree (e.g., orphan from a prior
    git worktree remove that left the branch behind) — create must
    reject + tell operator to cleanup_failed first."""
    repo, sr, env, baseline = _setup(tmp_path)
    subprocess.run(["git", "branch", "evolve/sess-test/synthesis", baseline],
                   cwd=repo, check=True)
    r = _run(["create_synthesis_worktree", baseline], repo, env)
    assert r.returncode == 2
    assert "branch" in r.stderr.lower() or "already" in r.stderr.lower()


# ---- cleanup_failed_synthesis_worktree ------------------------------

def test_cleanup_failed_renames_branch_and_removes_worktree(tmp_path):
    repo, sr, env, baseline = _setup(tmp_path)
    _run(["create_synthesis_worktree", baseline], repo, env)
    r = _run(["cleanup_failed_synthesis_worktree"], repo, env)
    assert r.returncode == 0, r.stderr
    # Worktree dir gone
    assert not (sr / "worktrees" / "synthesis").exists()
    # Original branch gone
    branches = subprocess.run(
        ["git", "branch", "--list"],
        cwd=repo, capture_output=True, text=True,
    ).stdout
    assert "evolve/sess-test/synthesis" not in [
        b.strip().lstrip("* ") for b in branches.splitlines()
    ]
    # Renamed branch present (synthesis-failed-<ts>)
    assert "evolve/sess-test/synthesis-failed-" in branches


def test_cleanup_failed_no_op_when_no_synthesis_worktree(tmp_path):
    repo, sr, env, _ = _setup(tmp_path)
    r = _run(["cleanup_failed_synthesis_worktree"], repo, env)
    assert r.returncode == 0   # no-op success


def test_cleanup_failed_session_root_unset_rc_2(tmp_path):
    repo, sr, env, _ = _setup(tmp_path)
    env.pop("SESSION_ROOT", None)
    r = _run(["cleanup_failed_synthesis_worktree"], repo, env)
    assert r.returncode == 2


def test_cleanup_failed_session_id_unset_rc_2(tmp_path):
    repo, sr, env, _ = _setup(tmp_path)
    env.pop("SESSION_ID", None)
    r = _run(["cleanup_failed_synthesis_worktree"], repo, env)
    assert r.returncode == 2


def test_create_then_cleanup_then_create_succeeds(tmp_path):
    """Cleanup must restore a clean slate so a follow-up
    create_synthesis_worktree works (without manual intervention)."""
    repo, sr, env, baseline = _setup(tmp_path)
    _run(["create_synthesis_worktree", baseline], repo, env)
    _run(["cleanup_failed_synthesis_worktree"], repo, env)
    r = _run(["create_synthesis_worktree", baseline], repo, env)
    assert r.returncode == 0, r.stderr
    assert (sr / "worktrees" / "synthesis").is_dir()


# ---- W-1 fix: preserve uncommitted state (ITEM-2) -----------------------

def test_cleanup_preserves_uncommitted_state(tmp_path):
    """W-1 fix: cleanup must commit uncommitted worktree edits as a final
    preservation commit BEFORE removing the worktree, so the renamed audit
    branch HEAD reflects the agent's last attempted state."""
    repo, sr, env, baseline = _setup(tmp_path)
    # Create the synthesis worktree
    r = _run(["create_synthesis_worktree", baseline], repo, env)
    assert r.returncode == 0, r.stderr

    wt_path = sr / "worktrees" / "synthesis"
    # Add an uncommitted file to the worktree
    (wt_path / "agent_attempt.txt").write_text(
        "agent was here", encoding="utf-8"
    )

    # Run cleanup
    r = _run(["cleanup_failed_synthesis_worktree"], repo, env)
    assert r.returncode == 0, r.stderr

    # Worktree dir must be gone
    assert not wt_path.exists()

    # Find the renamed audit branch
    branches = subprocess.run(
        ["git", "branch", "--list", "evolve/sess-test/synthesis-failed-*"],
        cwd=repo, capture_output=True, text=True,
    ).stdout.strip()
    assert branches, "expected a synthesis-failed-* audit branch after cleanup"

    audit_branch = branches.splitlines()[0].strip().lstrip("* ")

    # The preserved file must appear in the audit branch HEAD commit
    show_out = subprocess.run(
        ["git", "show", "--name-only", "--format=", f"{audit_branch}"],
        cwd=repo, capture_output=True, text=True,
    ).stdout
    assert "agent_attempt.txt" in show_out, (
        f"uncommitted file not found in audit branch {audit_branch} HEAD;\n"
        f"git show output:\n{show_out}"
    )


# ---- W-2 fix: orphan branch recovery (ITEM-3) ---------------------------

def test_cleanup_renames_orphan_branch_when_worktree_dir_gone(tmp_path):
    """W-2 fix: if the worktree directory was removed manually (rm -rf)
    but the synthesis branch still exists, cleanup must rename that branch
    to an audit suffix and return 0 — avoiding the cleanup→create deadlock."""
    repo, sr, env, baseline = _setup(tmp_path)
    # Create worktree then manually remove only the directory
    r = _run(["create_synthesis_worktree", baseline], repo, env)
    assert r.returncode == 0, r.stderr

    wt_path = sr / "worktrees" / "synthesis"
    # Prune the git worktree reference first (simulate deregistered but
    # directory gone scenario the way `git worktree prune` would see it),
    # then rm -rf the directory.
    subprocess.run(["git", "worktree", "remove", "--force", str(wt_path)],
                   cwd=repo, capture_output=True)
    # Restore the branch (worktree remove also deletes branch? No — only
    # the worktree entry is removed; the branch survives)
    # If branch was deleted, recreate it pointing at baseline
    branches = subprocess.run(
        ["git", "branch", "--list", "evolve/sess-test/synthesis"],
        cwd=repo, capture_output=True, text=True,
    ).stdout.strip()
    if not branches:
        subprocess.run(
            ["git", "branch", "evolve/sess-test/synthesis", baseline],
            cwd=repo, check=True,
        )

    assert not wt_path.exists(), "worktree dir should be gone after manual remove"

    # Cleanup should handle orphan branch gracefully
    r = _run(["cleanup_failed_synthesis_worktree"], repo, env)
    assert r.returncode == 0, r.stderr

    # Original synthesis branch must be gone
    orig_branches = subprocess.run(
        ["git", "branch", "--list", "evolve/sess-test/synthesis"],
        cwd=repo, capture_output=True, text=True,
    ).stdout.strip()
    assert not orig_branches, (
        "original synthesis branch should have been renamed to audit suffix"
    )

    # An audit branch must exist
    audit_branches = subprocess.run(
        ["git", "branch", "--list", "evolve/sess-test/synthesis-failed-*"],
        cwd=repo, capture_output=True, text=True,
    ).stdout.strip()
    assert audit_branches, "expected synthesis-failed-* audit branch after orphan cleanup"


def test_cleanup_orphan_branch_then_create_succeeds(tmp_path):
    """After orphan-branch cleanup, create_synthesis_worktree must succeed
    without manual git branch -D intervention."""
    repo, sr, env, baseline = _setup(tmp_path)
    _run(["create_synthesis_worktree", baseline], repo, env)

    wt_path = sr / "worktrees" / "synthesis"
    subprocess.run(["git", "worktree", "remove", "--force", str(wt_path)],
                   cwd=repo, capture_output=True)
    branches = subprocess.run(
        ["git", "branch", "--list", "evolve/sess-test/synthesis"],
        cwd=repo, capture_output=True, text=True,
    ).stdout.strip()
    if not branches:
        subprocess.run(
            ["git", "branch", "evolve/sess-test/synthesis", baseline],
            cwd=repo, check=True,
        )

    _run(["cleanup_failed_synthesis_worktree"], repo, env)

    r = _run(["create_synthesis_worktree", baseline], repo, env)
    assert r.returncode == 0, r.stderr
    assert (sr / "worktrees" / "synthesis").is_dir()


# ---- W-4 fix: PID suffix uniqueness (ITEM-4) ----------------------------

def test_cleanup_iso_now_pid_suffix_unique(tmp_path):
    """W-4 fix: ts variable in cleanup must include a -$$ (PID) suffix to
    guarantee unique branch names within the same second. This test verifies
    the PID suffix is present in the audit branch name rather than attempting
    to trigger a real 1-second collision (which is non-deterministic in CI)."""
    repo, sr, env, baseline = _setup(tmp_path)
    _run(["create_synthesis_worktree", baseline], repo, env)

    r = _run(["cleanup_failed_synthesis_worktree"], repo, env)
    assert r.returncode == 0, r.stderr

    branches = subprocess.run(
        ["git", "branch", "--list", "evolve/sess-test/synthesis-failed-*"],
        cwd=repo, capture_output=True, text=True,
    ).stdout.strip()
    assert branches, "expected a synthesis-failed-* audit branch"

    # The branch name should follow the pattern:
    # evolve/sess-test/synthesis-failed-<date>_<time>-<pid>
    # The PID portion is a numeric suffix after the last '-'.
    branch_name = branches.splitlines()[0].strip().lstrip("* ")
    # Extract the part after 'synthesis-failed-'
    suffix = branch_name.split("synthesis-failed-", 1)[-1]
    # The suffix ends with -<pid> where pid is numeric
    parts = suffix.rsplit("-", 1)
    assert len(parts) == 2 and parts[1].isdigit(), (
        f"Expected audit branch name to end with -<pid> (numeric), "
        f"got: {branch_name!r} (suffix after 'synthesis-failed-': {suffix!r})"
    )
