"""kill-request-writer.sh — appends pending kill request to kill_requests.jsonl.

Contract (spec § 5.5 user_requested row / W-5 delivery channel):
  Invocation: bash hooks/scripts/kill-request-writer.sh --seed=<id>
  Prereq:     SESSION_ROOT env var set (caller resolves via resolve_current)
  Effect:     append `{"seed_id": <id>, "requested_at": "<ISO>",
                       "confirmed": false}` to $SESSION_ROOT/kill_requests.jsonl
  Exit codes: 0 success
              2 operator error (missing/invalid --seed, SESSION_ROOT unset,
                                 non-numeric seed, lock acquisition failed)
"""
import json
import os
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).parents[3] / "hooks/scripts/kill-request-writer.sh"


def _setup_session_root(tmp_path):
    repo = tmp_path / "proj"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True,
                   capture_output=True)
    sr = repo / ".deep-evolve" / "sess"
    sr.mkdir(parents=True)
    env = os.environ.copy()
    env["SESSION_ROOT"] = str(sr)
    env["EVOLVE_DIR"] = str(repo / ".deep-evolve")
    return repo, sr, env


def test_happy_path_writes_pending_entry(tmp_path):
    repo, sr, env = _setup_session_root(tmp_path)
    r = subprocess.run(
        ["bash", str(SCRIPT), "--seed=3"],
        cwd=repo, env=env, capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    kr = sr / "kill_requests.jsonl"
    assert kr.is_file()
    lines = kr.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["seed_id"] == 3
    assert rec["confirmed"] is False
    assert "requested_at" in rec
    # ISO-8601 with timezone
    assert "T" in rec["requested_at"]


def test_multiple_invocations_append_not_overwrite(tmp_path):
    repo, sr, env = _setup_session_root(tmp_path)
    for sid in (2, 4, 7):
        r = subprocess.run(
            ["bash", str(SCRIPT), f"--seed={sid}"],
            cwd=repo, env=env, capture_output=True, text=True,
        )
        assert r.returncode == 0, r.stderr
    lines = (sr / "kill_requests.jsonl").read_text(encoding="utf-8") \
        .strip().splitlines()
    assert len(lines) == 3
    ids = [json.loads(ln)["seed_id"] for ln in lines]
    assert ids == [2, 4, 7]


def test_missing_seed_flag_rc_2(tmp_path):
    repo, sr, env = _setup_session_root(tmp_path)
    r = subprocess.run(
        ["bash", str(SCRIPT)],
        cwd=repo, env=env, capture_output=True, text=True,
    )
    assert r.returncode == 2
    assert "seed" in r.stderr.lower()


def test_non_numeric_seed_rc_2(tmp_path):
    repo, sr, env = _setup_session_root(tmp_path)
    r = subprocess.run(
        ["bash", str(SCRIPT), "--seed=abc"],
        cwd=repo, env=env, capture_output=True, text=True,
    )
    assert r.returncode == 2
    assert "seed" in r.stderr.lower() or "numeric" in r.stderr.lower()


def test_negative_seed_rc_2(tmp_path):
    """Seed IDs are positive ints. `--seed=-1` must be rejected before
    it reaches the JSONL file."""
    repo, sr, env = _setup_session_root(tmp_path)
    r = subprocess.run(
        ["bash", str(SCRIPT), "--seed=-1"],
        cwd=repo, env=env, capture_output=True, text=True,
    )
    assert r.returncode == 2


def test_zero_seed_rc_2(tmp_path):
    """Seed IDs start at 1. `--seed=0` must be rejected."""
    repo, sr, env = _setup_session_root(tmp_path)
    r = subprocess.run(
        ["bash", str(SCRIPT), "--seed=0"],
        cwd=repo, env=env, capture_output=True, text=True,
    )
    assert r.returncode == 2


def test_session_root_unset_rc_2(tmp_path):
    repo = tmp_path / "proj"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True,
                   capture_output=True)
    env = os.environ.copy()
    env.pop("SESSION_ROOT", None)
    r = subprocess.run(
        ["bash", str(SCRIPT), "--seed=2"],
        cwd=repo, env=env, capture_output=True, text=True,
    )
    assert r.returncode == 2
    assert "SESSION_ROOT" in r.stderr


def test_unknown_flag_rc_2(tmp_path):
    repo, sr, env = _setup_session_root(tmp_path)
    r = subprocess.run(
        ["bash", str(SCRIPT), "--foo=bar"],
        cwd=repo, env=env, capture_output=True, text=True,
    )
    assert r.returncode == 2


def test_does_not_mangle_caller_positionals(tmp_path):
    """W-1 regression: HELPER_SOURCED guard placement above
    `# === Parse global flags ===` ensures sourcing session-helper.sh
    does NOT silently consume T23's own flags (e.g. --dry-run). T23 must
    see --dry-run as 'unknown argument' rather than have it intercepted
    upstream by session-helper's global flag-parse loop."""
    repo, sr, env = _setup_session_root(tmp_path)
    r = subprocess.run(
        ["bash", str(SCRIPT), "--seed=3", "--dry-run"],
        cwd=repo, env=env, capture_output=True, text=True,
    )
    # T23 reaches its own arg loop, sees --dry-run as unknown → rc=2
    assert r.returncode == 2
    assert "--dry-run" in r.stderr or "unknown argument" in r.stderr.lower()


def test_leading_zero_seed_rc_2(tmp_path):
    """W-5 regression: --seed=01 must be rejected at the regex stage
    rather than deferred to a confusing jq parse error (JSON forbids
    leading zeros per ECMA-404)."""
    repo, sr, env = _setup_session_root(tmp_path)
    r = subprocess.run(
        ["bash", str(SCRIPT), "--seed=01"],
        cwd=repo, env=env, capture_output=True, text=True,
    )
    assert r.returncode == 2
    assert "leading zeros" in r.stderr.lower() or \
        "positive integer" in r.stderr.lower()
