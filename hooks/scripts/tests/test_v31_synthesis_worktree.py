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
import base64
import hashlib
import json
import os
import re
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


# ---- Durable recovery bundle for uncommitted state ----------------------

def test_cleanup_preserves_uncommitted_state_in_ready_bundle(tmp_path):
    """Dirty state is reconstructable from a ready bundle, never committed."""
    repo, sr, env, baseline = _setup(tmp_path)
    r = _run(["create_synthesis_worktree", baseline], repo, env)
    assert r.returncode == 0, r.stderr

    wt_path = sr / "worktrees" / "synthesis"
    before_head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=wt_path, check=True,
        capture_output=True, text=True,
    ).stdout.strip()
    (wt_path / "README.md").write_bytes(b"unstaged\x00agent bytes\n")
    (wt_path / "staged.txt").write_bytes(b"staged agent bytes\n")
    subprocess.run(
        ["git", "add", "staged.txt"], cwd=wt_path, check=True,
        capture_output=True,
    )
    untracked_bytes = b"agent was here\x00\xff\n"
    untracked_path = wt_path / "untracked dir" / "agent_attempt.bin"
    untracked_path.parent.mkdir()
    untracked_path.write_bytes(untracked_bytes)
    untracked_mode = untracked_path.stat().st_mode & 0o777

    def git_bytes(*args):
        return subprocess.run(
            ["git", *args], cwd=wt_path, check=True, capture_output=True,
        ).stdout

    expected_staged = git_bytes("diff", "--binary", "--cached", "--no-ext-diff")
    expected_unstaged = git_bytes("diff", "--binary", "--no-ext-diff")
    expected_status = git_bytes("status", "--porcelain=v1", "-z")

    r = _run(["cleanup_failed_synthesis_worktree"], repo, env)
    assert r.returncode == 0, r.stderr
    assert not wt_path.exists()

    branches = subprocess.run(
        ["git", "branch", "--list", "evolve/sess-test/synthesis-failed-*"],
        cwd=repo, capture_output=True, text=True,
    ).stdout.strip()
    assert branches, "expected a synthesis-failed-* audit branch after cleanup"
    audit_branch = branches.splitlines()[0].strip().lstrip("* ")
    audit_head = subprocess.run(
        ["git", "rev-parse", audit_branch], cwd=repo, check=True,
        capture_output=True, text=True,
    ).stdout.strip()
    assert audit_head == before_head == baseline, "cleanup must not create an implicit commit"

    recovery_parent = sr / "synthesis-recovery"
    recovery_dirs = sorted(path for path in recovery_parent.iterdir() if path.is_dir())
    assert len(recovery_dirs) == 1
    recovery = recovery_dirs[0]
    manifest = json.loads((recovery / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema_version"] == 1
    assert manifest["ready"] is True
    assert manifest["phase"] == "ready"
    assert manifest["base_commit"] == before_head
    assert manifest["refs"] == {
        "original_branch": "evolve/sess-test/synthesis",
        "original_branch_sha": before_head,
    }
    assert base64.b64decode(manifest["status_porcelain_v1_z_base64"]) == expected_status
    assert set(manifest["artifacts"]) == {
        "staged_patch", "unstaged_patch", "status", "untracked", "refs",
    }

    artifact_bytes = {}
    for name, record in manifest["artifacts"].items():
        relative = Path(record["path"])
        assert not relative.is_absolute() and ".." not in relative.parts
        artifact = recovery / relative
        assert artifact.is_file() and not artifact.is_symlink()
        payload = artifact.read_bytes()
        assert len(payload) == record["size"], name
        assert hashlib.sha256(payload).hexdigest() == record["sha256"], name
        artifact_bytes[name] = payload

    assert artifact_bytes["staged_patch"] == expected_staged
    assert artifact_bytes["unstaged_patch"] == expected_unstaged
    assert artifact_bytes["status"] == expected_status
    untracked = json.loads(artifact_bytes["untracked"])
    assert len(untracked) == 1
    assert untracked[0] == {
        "path": "untracked dir/agent_attempt.bin",
        "type": "file",
        "mode": untracked_mode,
        "content_base64": base64.b64encode(untracked_bytes).decode("ascii"),
    }

    reconstructed = tmp_path / "reconstructed"
    subprocess.run(
        ["git", "clone", "--quiet", "--no-hardlinks", str(repo), str(reconstructed)],
        check=True, capture_output=True,
    )
    subprocess.run(
        ["git", "checkout", "--quiet", "--detach", manifest["base_commit"]],
        cwd=reconstructed, check=True, capture_output=True,
    )
    for patch_name, extra in (("staged_patch", ["--index"]), ("unstaged_patch", [])):
        if artifact_bytes[patch_name]:
            subprocess.run(
                ["git", "apply", "--binary", *extra, "--whitespace=nowarn", "-"],
                cwd=reconstructed, input=artifact_bytes[patch_name], check=True,
                capture_output=True,
            )
    for entry in untracked:
        target = reconstructed / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(entry["content_base64"]))
        target.chmod(entry["mode"])

    def reconstructed_git(*args):
        return subprocess.run(
            ["git", *args], cwd=reconstructed, check=True, capture_output=True,
        ).stdout

    assert reconstructed_git("diff", "--binary", "--cached", "--no-ext-diff") == expected_staged
    assert reconstructed_git("diff", "--binary", "--no-ext-diff") == expected_unstaged
    assert reconstructed_git("status", "--porcelain=v1", "-z") == expected_status


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


# ---- Collision-safe failed-branch uniqueness -----------------------------

def test_cleanup_uses_collision_safe_uuid_suffixes(tmp_path):
    """Repeated cleanups retain distinct audit branches with UUID nonces."""
    repo, sr, env, baseline = _setup(tmp_path)
    for _ in range(2):
        created = _run(["create_synthesis_worktree", baseline], repo, env)
        assert created.returncode == 0, created.stderr
        cleaned = _run(["cleanup_failed_synthesis_worktree"], repo, env)
        assert cleaned.returncode == 0, cleaned.stderr

    branches = subprocess.run(
        ["git", "branch", "--list", "evolve/sess-test/synthesis-failed-*"],
        cwd=repo, capture_output=True, text=True,
    ).stdout
    names = sorted(line.strip().lstrip("* ") for line in branches.splitlines() if line.strip())
    assert len(names) == 2
    pattern = re.compile(
        r"^evolve/sess-test/synthesis-failed-"
        r"\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}Z-"
        r"([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$"
    )
    nonces = []
    for name in names:
        match = pattern.fullmatch(name)
        assert match, f"audit branch lacks collision-safe UUID suffix: {name!r}"
        nonces.append(match.group(1))
    assert len(set(nonces)) == 2
