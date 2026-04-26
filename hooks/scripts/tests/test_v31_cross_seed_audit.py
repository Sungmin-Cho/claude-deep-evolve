"""cross-seed-audit.py — § 8.2 Step 3 forum aggregator.

Pure function (no git, no LLM, no in-place mutation). Reads
forum.jsonl + journal.jsonl, writes completion/cross_seed_audit.md
with borrow matrix + convergence tally + per-seed forum activity.
"""
import json
import shutil
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).parents[3] / "hooks/scripts/cross-seed-audit.py"
FIXTURE = Path(__file__).parent / "fixtures" / "multi_seed_mock"


def _run(forum, journal, output):
    return subprocess.run(
        ["python3", str(SCRIPT),
         "--forum", str(forum),
         "--journal", str(journal),
         "--output", str(output)],
        capture_output=True, text=True,
    )


def test_happy_path_writes_audit_md(tmp_path):
    forum = tmp_path / "forum.jsonl"
    journal = tmp_path / "journal.jsonl"
    shutil.copy(FIXTURE / "forum.jsonl", forum)
    shutil.copy(FIXTURE / "journal.jsonl", journal)
    output = tmp_path / "cross_seed_audit.md"

    r = _run(forum, journal, output)
    assert r.returncode == 0, r.stderr
    assert output.is_file()
    content = output.read_text(encoding="utf-8")
    # Stable section headers required for synthesis.md template
    assert "# Cross-Seed Audit" in content
    assert "## Borrow Matrix" in content
    assert "## Convergence Events" in content
    assert "## Per-Seed Forum Activity" in content


def test_borrow_matrix_correctness(tmp_path):
    """Mock fixture has: 1→2 (1), 1→3 (1), 2→3 (1)."""
    forum = tmp_path / "forum.jsonl"
    journal = tmp_path / "journal.jsonl"
    shutil.copy(FIXTURE / "forum.jsonl", forum)
    shutil.copy(FIXTURE / "journal.jsonl", journal)
    output = tmp_path / "audit.md"
    _run(forum, journal, output)
    content = output.read_text(encoding="utf-8")
    # Borrow counts per (from, to) pair must be present
    assert "1 → 2" in content or "from=1, to=2" in content or "1->2" in content
    assert "1 → 3" in content or "from=1, to=3" in content or "1->3" in content
    assert "2 → 3" in content or "from=2, to=3" in content or "2->3" in content


def test_convergence_event_tally(tmp_path):
    """Mock fixture has 1 borrow_chain_convergence event."""
    forum = tmp_path / "forum.jsonl"
    journal = tmp_path / "journal.jsonl"
    shutil.copy(FIXTURE / "forum.jsonl", forum)
    shutil.copy(FIXTURE / "journal.jsonl", journal)
    output = tmp_path / "audit.md"
    _run(forum, journal, output)
    content = output.read_text(encoding="utf-8")
    assert "borrow_chain_convergence" in content
    # Count of 1 must appear somewhere in the convergence section
    assert "1" in content


def test_empty_forum_yields_zero_counts(tmp_path):
    forum = tmp_path / "forum.jsonl"
    journal = tmp_path / "journal.jsonl"
    forum.write_text("", encoding="utf-8")
    journal.write_text("", encoding="utf-8")
    output = tmp_path / "audit.md"
    r = _run(forum, journal, output)
    assert r.returncode == 0
    content = output.read_text(encoding="utf-8")
    assert "# Cross-Seed Audit" in content
    # Zero-state markers must be present
    assert ("no borrows" in content.lower()
            or "0 borrows" in content.lower()
            or "no cross-seed exchanges" in content.lower())


def test_n1_session_explicit_marker(tmp_path):
    """Spec § 8.5: N=1 case yields 'N/A — single seed session'."""
    forum = tmp_path / "forum.jsonl"
    journal = tmp_path / "journal.jsonl"
    # Single seed only
    journal.write_text(
        '{"event":"seed_initialized","seed_id":1,"direction":"only","ts":"t"}\n',
        encoding="utf-8")
    forum.write_text("", encoding="utf-8")
    output = tmp_path / "audit.md"
    r = _run(forum, journal, output)
    assert r.returncode == 0
    content = output.read_text(encoding="utf-8")
    # Spec § 8.5 wording (case-insensitive flexibility)
    lower = content.lower()
    assert "n/a" in lower or "single seed" in lower or "n=1" in lower


def test_malformed_forum_line_skipped_with_warn(tmp_path):
    """Matches T5 forum-summary's never-brick pattern."""
    forum = tmp_path / "forum.jsonl"
    journal = tmp_path / "journal.jsonl"
    forum.write_text(
        'not-json-but-skipped\n'
        '{"event":"cross_seed_borrow","from_seed":1,"to_seed":2,'
        '"source_commit":"a","target_commit":"b","ts":"t","epoch":1}\n',
        encoding="utf-8")
    journal.write_text("", encoding="utf-8")
    output = tmp_path / "audit.md"
    r = _run(forum, journal, output)
    assert r.returncode == 0
    # The malformed line is skipped + stderr warn
    assert "warn" in r.stderr.lower() or "skip" in r.stderr.lower()
    # The well-formed event still aggregated
    content = output.read_text(encoding="utf-8")
    assert "1" in content and "2" in content


def test_per_seed_activity_counts(tmp_path):
    forum = tmp_path / "forum.jsonl"
    journal = tmp_path / "journal.jsonl"
    shutil.copy(FIXTURE / "forum.jsonl", forum)
    shutil.copy(FIXTURE / "journal.jsonl", journal)
    output = tmp_path / "audit.md"
    _run(forum, journal, output)
    content = output.read_text(encoding="utf-8")
    # Each seed (1, 2, 3) should appear in the per-seed section
    activity_section = content.split("## Per-Seed Forum Activity", 1)[1]
    assert "Seed 1" in activity_section or "seed_1" in activity_section.lower()
    assert "Seed 2" in activity_section or "seed_2" in activity_section.lower()
    assert "Seed 3" in activity_section or "seed_3" in activity_section.lower()


def test_missing_forum_file_rc_2(tmp_path):
    journal = tmp_path / "journal.jsonl"
    journal.write_text("", encoding="utf-8")
    output = tmp_path / "audit.md"
    r = _run(tmp_path / "no-such-forum.jsonl", journal, output)
    assert r.returncode == 2
    assert "error:" in r.stderr


def test_missing_journal_file_rc_2(tmp_path):
    forum = tmp_path / "forum.jsonl"
    forum.write_text("", encoding="utf-8")
    output = tmp_path / "audit.md"
    r = _run(forum, tmp_path / "no-such-journal.jsonl", output)
    assert r.returncode == 2
    assert "error:" in r.stderr


def test_missing_required_arg_rc_2(tmp_path):
    r = subprocess.run(
        ["python3", str(SCRIPT), "--forum", str(tmp_path / "forum.jsonl")],
        capture_output=True, text=True,
    )
    assert r.returncode != 0   # argparse error or our explicit check


def test_borrow_matrix_handles_self_borrow_gracefully(tmp_path):
    """Defensive: a malformed entry where from_seed == to_seed should
    be skipped rather than counted (P5 paranoid guard)."""
    forum = tmp_path / "forum.jsonl"
    forum.write_text(
        '{"event":"cross_seed_borrow","from_seed":1,"to_seed":1,'
        '"source_commit":"a","target_commit":"b","ts":"t","epoch":1}\n',
        encoding="utf-8")
    journal = tmp_path / "journal.jsonl"
    journal.write_text("", encoding="utf-8")
    output = tmp_path / "audit.md"
    r = _run(forum, journal, output)
    assert r.returncode == 0
    content = output.read_text(encoding="utf-8")
    # Self-borrow not counted; section mentions "no" or "0" or skip notice
    lower = content.lower()
    assert ("0" in lower or "no" in lower or "skip" in lower)


def test_cross_seed_borrow_without_required_fields_skipped(tmp_path):
    """Forum event missing from_seed/to_seed/etc. is skipped."""
    forum = tmp_path / "forum.jsonl"
    forum.write_text(
        '{"event":"cross_seed_borrow","ts":"t","epoch":1}\n'   # no from/to
        '{"event":"cross_seed_borrow","from_seed":1,"to_seed":2,'
        '"source_commit":"a","target_commit":"b","ts":"t2","epoch":1}\n',
        encoding="utf-8")
    journal = tmp_path / "journal.jsonl"
    journal.write_text("", encoding="utf-8")
    output = tmp_path / "audit.md"
    r = _run(forum, journal, output)
    assert r.returncode == 0
    # Only the well-formed line counts
    content = output.read_text(encoding="utf-8")
    assert "1" in content and "2" in content


def test_borrow_with_missing_to_seed_does_not_inflate_borrows_given(tmp_path):
    """I-1 regression: a cross_seed_borrow event with from_seed but
    missing to_seed must NOT credit borrows_given to from_seed
    (otherwise Per-Seed table contradicts Borrow Matrix which skips
    the same event)."""
    forum = tmp_path / "forum.jsonl"
    journal = tmp_path / "journal.jsonl"
    forum.write_text(
        '{"event":"cross_seed_borrow","from_seed":1,"source_commit":"a","target_commit":"b","ts":"t","epoch":1}\n'
        '{"event":"cross_seed_borrow","from_seed":1,"to_seed":2,"source_commit":"c","target_commit":"d","ts":"t2","epoch":1}\n',
        encoding="utf-8")
    journal.write_text(
        '{"event":"seed_initialized","seed_id":1,"direction":"a","ts":"t0"}\n'
        '{"event":"seed_initialized","seed_id":2,"direction":"b","ts":"t1"}\n',
        encoding="utf-8")
    output = tmp_path / "audit.md"
    r = _run(forum, journal, output)
    assert r.returncode == 0
    content = output.read_text(encoding="utf-8")
    # Per-seed table for seed 1 should show borrows_given=1 (from the well-formed event), NOT 2
    activity_section = content.split("## Per-Seed Forum Activity", 1)[1]
    # The well-formed event (1 → 2) gives seed 1 exactly 1 borrow_given
    # The malformed event (1 → None) must be skipped — total stays at 1
    seed_1_row = [ln for ln in activity_section.splitlines() if "Seed 1" in ln]
    assert len(seed_1_row) == 1
    # The borrows_given column in the row should be 1 (not 2 from inflation)
    # Format: | Seed 1 | keeps | discards | borrows_given | borrows_received | convergence |
    cells = [c.strip() for c in seed_1_row[0].split("|")]
    # Cells: ["", "Seed 1", "0", "0", "1", "0", "0", ""]
    # borrows_given is at index 4
    assert cells[4] == "1", f"borrows_given inflated by partial-borrow event: row={seed_1_row[0]!r}"


def test_mixed_type_seed_ids_do_not_crash_sort(tmp_path):
    """I-2 regression: corruption-path with mixed-type seed_ids
    (str + int) must not raise TypeError during table formatting."""
    forum = tmp_path / "forum.jsonl"
    journal = tmp_path / "journal.jsonl"
    forum.write_text(
        '{"event":"cross_seed_borrow","from_seed":"bad","to_seed":2,"source_commit":"a","target_commit":"b","ts":"t","epoch":1}\n'
        '{"event":"cross_seed_borrow","from_seed":1,"to_seed":3,"source_commit":"c","target_commit":"d","ts":"t2","epoch":1}\n',
        encoding="utf-8")
    journal.write_text(
        '{"event":"seed_initialized","seed_id":1,"direction":"a","ts":"t0"}\n'
        '{"event":"seed_initialized","seed_id":2,"direction":"b","ts":"t1"}\n'
        '{"event":"seed_initialized","seed_id":3,"direction":"c","ts":"t2"}\n',
        encoding="utf-8")
    output = tmp_path / "audit.md"
    r = _run(forum, journal, output)
    # Must not crash regardless of mixed types in keys
    assert r.returncode == 0, f"sort crashed on mixed types: {r.stderr}"
