import subprocess, shutil
from pathlib import Path

GEN = Path(__file__).parents[3] / "hooks/scripts/generate-forum-summary.py"
FIXTURE = Path(__file__).parent / "fixtures/forum_multi_seed"


def test_forum_summary_generates_per_seed_section(tmp_path):
    shutil.copy(FIXTURE / "forum.jsonl", tmp_path / "forum.jsonl")
    out_path = tmp_path / "summary.md"
    r = subprocess.run(
        ["python3", str(GEN),
         "--forum", str(tmp_path / "forum.jsonl"),
         "--out", str(out_path),
         "--gen", "3"],
        capture_output=True, text=True)
    assert r.returncode == 0, f"stderr: {r.stderr}"
    content = out_path.read_text()
    # Per-seed headings
    assert "## Seed-1" in content
    assert "## Seed-2" in content
    # Counts
    assert "1 keeps" in content or "keeps: 1" in content.lower()
    # Borrow record
    assert "borrow" in content.lower()
    assert "from seed-1" in content.lower() or "source_seed: 1" in content.lower() or "from_seed: 1" in content.lower()


def test_forum_summary_tolerates_missing_fields(tmp_path):
    """Malformed events (missing seed_id, commit, borrow endpoints) must be
    skipped with warnings — not crash the coordinator at epoch boundary."""
    import shutil
    shutil.copy(Path(__file__).parent / "fixtures/forum_malformed/forum.jsonl",
                tmp_path / "forum.jsonl")
    out_path = tmp_path / "summary.md"
    r = subprocess.run(
        ["python3", str(GEN),
         "--forum", str(tmp_path / "forum.jsonl"),
         "--out", str(out_path),
         "--gen", "1"],
        capture_output=True, text=True)
    assert r.returncode == 0, f"crashed on malformed events: {r.stderr}"
    content = out_path.read_text()
    # Valid events processed
    assert "## Seed-1" in content  # from valid keep + discard
    assert "## Seed-2" in content  # from valid keep (even though missing commit → "????????")
    # Warnings emitted to stderr
    assert "warn:" in r.stderr
    assert "missing seed_id" in r.stderr
    assert "missing endpoints" in r.stderr
    # Missing commit rendered as placeholder
    assert "????????" in content


def test_forum_summary_handles_empty_forum(tmp_path):
    (tmp_path / "forum.jsonl").write_text("")
    out_path = tmp_path / "summary.md"
    r = subprocess.run(
        ["python3", str(GEN),
         "--forum", str(tmp_path / "forum.jsonl"),
         "--out", str(out_path),
         "--gen", "1"],
        capture_output=True, text=True)
    assert r.returncode == 0
    assert "no events" in out_path.read_text().lower() or out_path.read_text().strip() != ""
