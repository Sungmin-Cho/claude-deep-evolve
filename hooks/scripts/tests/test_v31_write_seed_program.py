"""Per-seed program.md = base program.md + β direction prefix."""
import json, subprocess
from pathlib import Path

WRITER = Path(__file__).parents[3] / "hooks/scripts/write-seed-program.py"


def test_writes_program_md_with_beta_prefix(tmp_path):
    base = tmp_path / "program.md"
    base.write_text("# Base program\n\nInitial goal: optimize X.\n")
    wt = tmp_path / "seed_2_wt"
    wt.mkdir()
    beta = {
        "seed_id": 2,
        "direction": "노이즈 필터링",
        "hypothesis": "고빈도 노이즈가 score 저하의 주 원인",
        "rationale": "초기 분석 결과 변동성 패턴 발견",
    }
    r = subprocess.run(["python3", str(WRITER),
                        "--base-program", str(base),
                        "--worktree", str(wt),
                        "--beta", json.dumps(beta, ensure_ascii=False)],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    result_path = wt / "program.md"
    assert result_path.exists()
    content = result_path.read_text()
    # Must start with the seed-specific prefix
    assert "## Initial Research Direction (seed-specific)" in content
    assert "노이즈 필터링" in content
    assert "고빈도 노이즈가 score 저하의 주 원인" in content
    # Original base content preserved
    assert "# Base program" in content
    assert "Initial goal: optimize X." in content


def test_n1_null_beta_copies_base_verbatim(tmp_path):
    """For N=1 short-circuit, β is null; program.md = base verbatim."""
    base = tmp_path / "program.md"
    base.write_text("# Base\n\nGoal.\n")
    wt = tmp_path / "seed_1_wt"
    wt.mkdir()
    r = subprocess.run(["python3", str(WRITER),
                        "--base-program", str(base),
                        "--worktree", str(wt),
                        "--beta", "null"],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    content = (wt / "program.md").read_text()
    # No seed-specific prefix for N=1
    assert "Initial Research Direction (seed-specific)" not in content
    assert content == base.read_text()
