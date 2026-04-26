"""Verify v3.1 session.yaml template contains virtual_parallel block."""
import re
from pathlib import Path

INIT_MD = Path(__file__).parents[3] / "skills/deep-evolve-workflow/protocols/init.md"


def test_session_yaml_template_has_virtual_parallel_block():
    content = INIT_MD.read_text()
    # Must contain the v3.1 block with all required top-level fields
    assert "virtual_parallel:" in content, "missing virtual_parallel block in init.md"
    assert "n_current:" in content
    assert "n_initial:" in content
    assert "n_range:" in content
    assert "project_type:" in content
    assert "eval_parallelizability:" in content
    assert "budget_total:" in content
    assert "budget_unallocated:" in content
    assert "synthesis:" in content
    assert "seeds:" in content


def test_session_yaml_template_seed_entry_has_required_fields():
    content = INIT_MD.read_text()
    required_per_seed = [
        "direction:", "hypothesis:", "initial_rationale:",
        "worktree_path:", "branch:", "created_by:",
        "experiments_used:", "keeps:", "borrows_given:", "borrows_received:",
        "current_q:", "allocated_budget:", "killed_at:", "killed_reason:",
    ]
    for field in required_per_seed:
        assert field in content, f"missing seed field: {field}"


def test_deep_evolve_version_is_3_1_0_in_v31_template():
    content = INIT_MD.read_text()
    # Version must be "3.1.0" in the v3.1 template section
    assert 'deep_evolve_version: "3.1.0"' in content, (
        "init.md must set deep_evolve_version: \"3.1.0\" for new sessions"
    )
