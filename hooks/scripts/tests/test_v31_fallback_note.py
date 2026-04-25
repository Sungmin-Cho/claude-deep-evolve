"""generate-fallback-note.py — § 8.2 Step 6 fallback explanation generator.

Invoked by synthesis.md when synthesis_Q < baseline_Q − regression_tolerance
OR when the user chose option 2/3 in the AskUserQuestion ladder. Produces
structured completion/fallback_note.md with:
  - Synthesis vs baseline Q delta
  - Baseline selection reasoning (T25 cascade tier + tiebreak chain)
  - Per-seed final_q snapshot
  - User choice (if applicable — branch B options 2/3)
"""
import json
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).parents[3] / "hooks/scripts/generate-fallback-note.py"


def _make_session_yaml(tmp_path, seeds):
    """Helper: write a minimal session.yaml with given seeds."""
    import yaml
    p = tmp_path / "session.yaml"
    content = {
        "deep_evolve_version": "3.1.0",
        "session_id": "test",
        "goal": "test goal",
        "virtual_parallel": {
            "n_current": len(seeds),
            "seeds": seeds,
        },
    }
    p.write_text(yaml.safe_dump(content), encoding="utf-8")
    return p


def _run(args):
    return subprocess.run(
        ["python3", str(SCRIPT), *args],
        capture_output=True, text=True,
    )


def _baseline_reasoning(chosen_seed_id, tier="preferred",
                       ties_broken_on=None):
    return json.dumps({
        "chosen_seed_id": chosen_seed_id,
        "tier": tier,
        "ties_broken_on": ties_broken_on or ["final_q"],
    })


def test_fallback_note_writes_output(tmp_path):
    sy = _make_session_yaml(tmp_path, [
        {"id": 1, "status": "active", "final_q": 0.42},
        {"id": 2, "status": "active", "final_q": 0.35},
    ])
    output = tmp_path / "fallback_note.md"
    r = _run([
        "--session-yaml", str(sy),
        "--baseline-reasoning", _baseline_reasoning(1),
        "--synthesis-q", "0.20",
        "--baseline-q", "0.42",
        "--user-choice", "none",
        "--output", str(output),
    ])
    assert r.returncode == 0, r.stderr
    assert output.is_file()


def test_fallback_note_includes_q_delta(tmp_path):
    sy = _make_session_yaml(tmp_path, [
        {"id": 1, "status": "active", "final_q": 0.50},
    ])
    output = tmp_path / "fallback_note.md"
    _run([
        "--session-yaml", str(sy),
        "--baseline-reasoning", _baseline_reasoning(1),
        "--synthesis-q", "0.30",
        "--baseline-q", "0.50",
        "--user-choice", "none",
        "--output", str(output),
    ])
    content = output.read_text(encoding="utf-8")
    assert "0.50" in content   # baseline
    assert "0.30" in content   # synthesis
    assert "-0.20" in content or "0.20" in content   # delta


def test_fallback_note_includes_baseline_reasoning(tmp_path):
    sy = _make_session_yaml(tmp_path, [
        {"id": 2, "status": "active", "final_q": 0.40},
    ])
    output = tmp_path / "fallback_note.md"
    _run([
        "--session-yaml", str(sy),
        "--baseline-reasoning", _baseline_reasoning(
            2, tier="non_quarantine_fallback",
            ties_broken_on=["final_q", "keeps", "borrows_received"],
        ),
        "--synthesis-q", "0.10",
        "--baseline-q", "0.40",
        "--user-choice", "none",
        "--output", str(output),
    ])
    content = output.read_text(encoding="utf-8")
    assert "non_quarantine_fallback" in content
    assert "borrows_received" in content


def test_fallback_note_includes_per_seed_snapshot(tmp_path):
    sy = _make_session_yaml(tmp_path, [
        {"id": 1, "status": "active", "final_q": 0.42},
        {"id": 2, "status": "killed_crash_give_up",
         "killed_reason": "crash_give_up", "final_q": 0.10},
        {"id": 3, "status": "active", "final_q": 0.35},
    ])
    output = tmp_path / "fallback_note.md"
    _run([
        "--session-yaml", str(sy),
        "--baseline-reasoning", _baseline_reasoning(1),
        "--synthesis-q", "0.20",
        "--baseline-q", "0.42",
        "--user-choice", "none",
        "--output", str(output),
    ])
    content = output.read_text(encoding="utf-8")
    # All 3 seeds must appear
    for sid in (1, 2, 3):
        assert f"Seed {sid}" in content or f"seed_{sid}" in content.lower() \
            or f"seed {sid}" in content.lower()
    # Killed seed's status must be documented
    assert "killed" in content.lower() or "crash_give_up" in content


def test_fallback_note_records_user_choice_branch_b_option_2(tmp_path):
    """Branch B option 2: user explicitly chose winner seed over synthesis."""
    sy = _make_session_yaml(tmp_path, [
        {"id": 1, "status": "active", "final_q": 0.42},
    ])
    output = tmp_path / "fallback_note.md"
    _run([
        "--session-yaml", str(sy),
        "--baseline-reasoning", _baseline_reasoning(1),
        "--synthesis-q", "0.40",
        "--baseline-q", "0.42",
        "--user-choice", "2",
        "--output", str(output),
    ])
    content = output.read_text(encoding="utf-8")
    assert "user" in content.lower()
    # The "2" choice in Step 6 Branch B is "최고 seed 채택"
    assert "user choice" in content.lower() or "사용자 선택" in content


def test_fallback_note_records_user_choice_branch_b_option_3(tmp_path):
    """Branch B option 3: user discards synthesis, returns to main."""
    sy = _make_session_yaml(tmp_path, [
        {"id": 1, "status": "active", "final_q": 0.42},
    ])
    output = tmp_path / "fallback_note.md"
    _run([
        "--session-yaml", str(sy),
        "--baseline-reasoning", _baseline_reasoning(1),
        "--synthesis-q", "0.41",
        "--baseline-q", "0.42",
        "--user-choice", "3",
        "--output", str(output),
    ])
    content = output.read_text(encoding="utf-8")
    assert "discard" in content.lower() or "main" in content.lower() \
        or "폐기" in content


def test_fallback_note_handles_no_user_choice_branch_c(tmp_path):
    """Branch C: pure regression, no user prompt fired."""
    sy = _make_session_yaml(tmp_path, [
        {"id": 1, "status": "active", "final_q": 0.50},
    ])
    output = tmp_path / "fallback_note.md"
    _run([
        "--session-yaml", str(sy),
        "--baseline-reasoning", _baseline_reasoning(1),
        "--synthesis-q", "0.20",
        "--baseline-q", "0.50",
        "--user-choice", "none",
        "--output", str(output),
    ])
    content = output.read_text(encoding="utf-8")
    # Branch C is automatic — note should NOT claim user fired
    assert "automatic" in content.lower() or "regression" in content.lower() \
        or "branch c" in content.lower()


def test_fallback_note_missing_required_arg_rc_2(tmp_path):
    sy = _make_session_yaml(tmp_path, [{"id": 1, "status": "active",
                                        "final_q": 0.42}])
    r = _run([
        "--session-yaml", str(sy),
        "--baseline-reasoning", _baseline_reasoning(1),
        "--synthesis-q", "0.20",
        # missing --baseline-q
        "--user-choice", "none",
        "--output", str(tmp_path / "out.md"),
    ])
    assert r.returncode != 0


def test_fallback_note_invalid_baseline_reasoning_json_rc_2(tmp_path):
    sy = _make_session_yaml(tmp_path, [{"id": 1, "status": "active",
                                        "final_q": 0.42}])
    r = _run([
        "--session-yaml", str(sy),
        "--baseline-reasoning", "not-valid-json",
        "--synthesis-q", "0.20",
        "--baseline-q", "0.42",
        "--user-choice", "none",
        "--output", str(tmp_path / "out.md"),
    ])
    assert r.returncode == 2
    assert "error:" in r.stderr
