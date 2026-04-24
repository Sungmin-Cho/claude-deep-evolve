"""coordinator.md presence + required section anchors."""
from pathlib import Path

COORD = Path(__file__).parents[3] / "skills/deep-evolve-workflow/protocols/coordinator.md"


def test_coordinator_md_exists():
    assert COORD.exists(), "coordinator.md must exist for v3.1 sessions"


def test_coordinator_md_has_version_gate():
    c = COORD.read_text()
    assert 'deep_evolve_version' in c
    assert '"3.1' in c or "3\\.1" in c


def test_coordinator_md_has_main_loop_section():
    c = COORD.read_text()
    assert "## Coordinator Loop" in c or "## Main Loop" in c


def test_coordinator_md_has_dispatch_section():
    c = COORD.read_text()
    assert "## Subagent Dispatch" in c or "## Dispatch" in c


def test_coordinator_md_references_scheduler_signals_and_decide():
    c = COORD.read_text()
    assert "scheduler-signals" in c
    assert "scheduler-decide" in c


def test_coordinator_md_has_post_dispatch_validation():
    c = COORD.read_text()
    assert "validate_seed_worktree" in c
