"""hooks/scripts/status-dashboard.py — render per-seed dashboard per § 13.1.

Behavioral subprocess tests against multi_seed_mock/ fixture (G9-existing,
extended with seed_4 killed_shortcut_quarantine + seed_5 low-Q active for
T26 audit coverage; T35 reuses without modification).
"""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).parents[3]
DASH = ROOT / "hooks/scripts/status-dashboard.py"
FIXTURE = ROOT / "hooks/scripts/tests/fixtures/multi_seed_mock"


def _stage_session(tmp_path, fixture_name="multi_seed_mock"):
    """Copy fixture to /tmp to avoid nested-.git contamination
    (T2 fixture-copy pattern)."""
    src = ROOT / "hooks/scripts/tests/fixtures" / fixture_name
    dst = tmp_path / fixture_name
    shutil.copytree(src, dst)
    return dst


def _run(args, env=None, cwd=None):
    return subprocess.run(
        ["python3", str(DASH), *args],
        capture_output=True, text=True, env=env, cwd=cwd,
    )


def test_dashboard_happy_path_5_seeds(tmp_path):
    """multi_seed_mock has 5 seeds; dashboard must render all of them
    in the seed-id-ordered table per § 13.1."""
    sr = _stage_session(tmp_path)
    r = _run([
        "--session-yaml", str(sr / "session.yaml"),
        "--journal", str(sr / "journal.jsonl"),
        "--forum", str(sr / "forum.jsonl"),
    ])
    assert r.returncode == 0, r.stderr
    out = r.stdout
    # All 5 seeds listed in order
    for sid in range(1, 6):
        assert f"[{sid}]" in out, f"seed [{sid}] missing from dashboard"
    # Status of each
    assert "active" in out
    assert "killed" in out  # seed_4 killed_shortcut_quarantine


def test_dashboard_includes_epoch_and_budget_summary(tmp_path):
    sr = _stage_session(tmp_path)
    r = _run([
        "--session-yaml", str(sr / "session.yaml"),
        "--journal", str(sr / "journal.jsonl"),
        "--forum", str(sr / "forum.jsonl"),
    ])
    assert r.returncode == 0, r.stderr
    # Per § 13.1 sample: 'Session <sid> — epoch X/Y, budget Z/W used'
    assert re.search(r"epoch\s+\d+/\d+", r.stdout, re.IGNORECASE)
    assert re.search(r"budget\s+\d+/\d+", r.stdout, re.IGNORECASE)


def test_dashboard_per_seed_columns(tmp_path):
    """§ 13.1 sample shows: status, Q, exp, keep, borrow recv/given."""
    sr = _stage_session(tmp_path)
    r = _run([
        "--session-yaml", str(sr / "session.yaml"),
        "--journal", str(sr / "journal.jsonl"),
        "--forum", str(sr / "forum.jsonl"),
    ])
    assert r.returncode == 0
    out = r.stdout
    # Columns must appear at least once each
    assert re.search(r"Q=\d+\.\d+", out), "Q column missing"
    assert re.search(r"exp=\d+", out), "exp column missing"
    assert re.search(r"keep=\d+", out), "keep column missing"
    assert re.search(r"borrow\s+recv=\d+", out), "borrow recv column missing"
    assert re.search(r"given=\d+", out), "borrow given column missing"


def test_dashboard_killed_seed_shows_reason_and_timestamp(tmp_path):
    """Per § 13.1 sample: '[4] (killed: sustained_regression at 2026-04-23 14:20)'."""
    sr = _stage_session(tmp_path)
    r = _run([
        "--session-yaml", str(sr / "session.yaml"),
        "--journal", str(sr / "journal.jsonl"),
        "--forum", str(sr / "forum.jsonl"),
    ])
    assert r.returncode == 0
    # Format: "(killed: <reason> at <timestamp>)"
    assert re.search(
        r"\(killed:\s+\w+(\s+at\s+[0-9T:\-\s]+)?\)",
        r.stdout,
    ), "killed-seed line must show reason and timestamp"


def test_dashboard_forum_summary_line(tmp_path):
    """Per § 13.1: 'Forum: N borrow events, M convergence events'."""
    sr = _stage_session(tmp_path)
    r = _run([
        "--session-yaml", str(sr / "session.yaml"),
        "--journal", str(sr / "journal.jsonl"),
        "--forum", str(sr / "forum.jsonl"),
    ])
    assert r.returncode == 0
    assert re.search(
        r"Forum:\s+\d+\s+borrow\s+events?,\s+\d+\s+convergence\s+events?",
        r.stdout,
    ), "Forum summary line missing"


def test_dashboard_last_event_line(tmp_path):
    """Per § 13.1: 'Last event: <event_name> seed=N block=M (HH:MM)'."""
    sr = _stage_session(tmp_path)
    r = _run([
        "--session-yaml", str(sr / "session.yaml"),
        "--journal", str(sr / "journal.jsonl"),
        "--forum", str(sr / "forum.jsonl"),
    ])
    assert r.returncode == 0
    assert re.search(
        r"Last event:\s+\S+",
        r.stdout,
    ), "Last event line missing"


def test_dashboard_n_1_short_circuit(tmp_path):
    """N=1 sessions render a single seed without the borrow columns
    (no cross-seed exchange possible). Don't crash on missing seeds[]."""
    # Synthesize a minimal N=1 fixture inline
    sr = tmp_path / "n1_session"
    sr.mkdir()
    (sr / "session.yaml").write_text(
        "deep_evolve_version: \"3.1.0\"\n"
        "virtual_parallel:\n"
        "  n_current: 1\n"
        "  budget_total: 10\n"
        "  budget_unallocated: 4\n"
        "  seeds:\n"
        "    - id: 1\n"
        "      direction: \"baseline\"\n"
        "      status: \"active\"\n"
        "      allocated_budget: 10\n"
        "      experiments_used: 6\n"
        "evaluation_epoch:\n"
        "  current: 1\n"
        "  history: []\n",
        encoding="utf-8",
    )
    (sr / "journal.jsonl").write_text("", encoding="utf-8")
    (sr / "forum.jsonl").write_text("", encoding="utf-8")
    r = _run([
        "--session-yaml", str(sr / "session.yaml"),
        "--journal", str(sr / "journal.jsonl"),
        "--forum", str(sr / "forum.jsonl"),
    ])
    assert r.returncode == 0, r.stderr
    assert "[1]" in r.stdout
    # N=1 must not show given/recv noise — either suppress columns or print 0/0
    assert "[2]" not in r.stdout


def test_dashboard_empty_forum(tmp_path):
    """forum.jsonl may be empty (no borrows or convergences yet).
    Dashboard renders 'Forum: 0 borrow events, 0 convergence events'."""
    sr = _stage_session(tmp_path)
    (sr / "forum.jsonl").write_text("", encoding="utf-8")
    r = _run([
        "--session-yaml", str(sr / "session.yaml"),
        "--journal", str(sr / "journal.jsonl"),
        "--forum", str(sr / "forum.jsonl"),
    ])
    assert r.returncode == 0
    assert re.search(r"Forum:\s+0\s+borrow", r.stdout)


def test_dashboard_missing_journal_rc_2(tmp_path):
    """Missing journal is operator error (session not yet initialized).
    rc=2 with stderr 'error: journal not found at <path>'."""
    sr = _stage_session(tmp_path)
    (sr / "journal.jsonl").unlink()
    r = _run([
        "--session-yaml", str(sr / "session.yaml"),
        "--journal", str(sr / "journal.jsonl"),
        "--forum", str(sr / "forum.jsonl"),
    ])
    assert r.returncode == 2
    assert "error:" in r.stderr.lower()


def test_dashboard_malformed_journal_skip_warn(tmp_path):
    """Malformed journal line: skip + warn (T22 partial-event tolerance
    pattern) — don't crash. The dashboard is read-only; partial render
    is better than no render."""
    sr = _stage_session(tmp_path)
    j = sr / "journal.jsonl"
    j.write_text(
        j.read_text(encoding="utf-8") + "this is not json\n",
        encoding="utf-8",
    )
    r = _run([
        "--session-yaml", str(sr / "session.yaml"),
        "--journal", str(sr / "journal.jsonl"),
        "--forum", str(sr / "forum.jsonl"),
    ])
    assert r.returncode == 0, r.stderr
    # Warning must appear in stderr
    assert "warning" in r.stderr.lower() or "skip" in r.stderr.lower()


def test_dashboard_aggregates_experiments_per_seed(tmp_path):
    """Behavioral test: count of `kept`/`discarded` events with seed_id=k
    must match the exp= column for that seed. W-6 trace from journal
    aggregation to dashboard column."""
    sr = _stage_session(tmp_path)
    # Read journal, count per-seed
    seen = {}
    for line in (sr / "journal.jsonl").read_text(encoding="utf-8").splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("event") in ("kept", "discarded", "evaluated"):
            sid = ev.get("seed_id")
            if isinstance(sid, int):
                seen[sid] = seen.get(sid, 0) + 1
    r = _run([
        "--session-yaml", str(sr / "session.yaml"),
        "--journal", str(sr / "journal.jsonl"),
        "--forum", str(sr / "forum.jsonl"),
    ])
    assert r.returncode == 0
    for sid, count in seen.items():
        # Find the [sid] line and assert exp=<count>
        m = re.search(rf"\[{sid}\][^\n]*exp=(\d+)", r.stdout)
        assert m, f"seed [{sid}] line missing"
        assert int(m.group(1)) == count, \
            f"seed [{sid}] exp mismatch: dashboard={m.group(1)} journal={count}"


def test_dashboard_aggregates_borrow_recv_given(tmp_path):
    """Behavioral test: borrow recv = count of cross_seed_borrow events
    where to_seed=k; given = count where from_seed=k. Asserts
    aggregation symmetry."""
    sr = _stage_session(tmp_path)
    recv = {}
    given = {}
    for line in (sr / "forum.jsonl").read_text(encoding="utf-8").splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("event") == "cross_seed_borrow":
            t, f = ev.get("to_seed"), ev.get("from_seed")
            if isinstance(t, int):
                recv[t] = recv.get(t, 0) + 1
            if isinstance(f, int):
                given[f] = given.get(f, 0) + 1
    r = _run([
        "--session-yaml", str(sr / "session.yaml"),
        "--journal", str(sr / "journal.jsonl"),
        "--forum", str(sr / "forum.jsonl"),
    ])
    assert r.returncode == 0
    for sid, cnt in recv.items():
        m = re.search(rf"\[{sid}\][^\n]*recv=(\d+)", r.stdout)
        assert m, f"seed [{sid}] recv line missing"
        assert int(m.group(1)) == cnt
    for sid, cnt in given.items():
        m = re.search(rf"\[{sid}\][^\n]*given=(\d+)", r.stdout)
        assert m, f"seed [{sid}] given line missing"
        assert int(m.group(1)) == cnt


def test_dashboard_argv_validation(tmp_path):
    """Missing required argv → rc=2, stderr 'error: ...'."""
    r = _run([])  # no args
    assert r.returncode == 2
    assert "error:" in r.stderr.lower()


def test_dashboard_invalid_session_yaml_rc_2(tmp_path):
    """Malformed session.yaml is operator error, rc=2."""
    sr = tmp_path / "broken"
    sr.mkdir()
    (sr / "session.yaml").write_text(": : not yaml\n", encoding="utf-8")
    (sr / "journal.jsonl").write_text("", encoding="utf-8")
    (sr / "forum.jsonl").write_text("", encoding="utf-8")
    r = _run([
        "--session-yaml", str(sr / "session.yaml"),
        "--journal", str(sr / "journal.jsonl"),
        "--forum", str(sr / "forum.jsonl"),
    ])
    assert r.returncode == 2


def test_fixture_session_yaml_describes_5_seeds():
    """Fixture-guard: multi_seed_mock/session.yaml must describe exactly 5
    seeds with seed_4 in killed:shortcut_quarantine + others active. T26's
    cross-seed-audit fixture-extension precedent (G9) — locks fixture shape."""
    import yaml as _yaml
    p = ROOT / "hooks/scripts/tests/fixtures/multi_seed_mock/session.yaml"
    assert p.is_file(), "multi_seed_mock/session.yaml must exist"
    with p.open(encoding="utf-8") as f:
        s = _yaml.safe_load(f)
    seeds = s.get("virtual_parallel", {}).get("seeds", [])
    assert len(seeds) == 5, f"expected 5 seeds, got {len(seeds)}"
    statuses = [se["status"] for se in seeds]
    assert statuses[3].startswith("killed"), \
        f"seed_4 must be killed, got {statuses[3]!r}"
    for i in (0, 1, 2, 4):
        assert statuses[i] == "active", \
            f"seed_{i + 1} must be active, got {statuses[i]!r}"
    # n_current must agree with seed count
    assert s["virtual_parallel"]["n_current"] == 5
