"""coordinator.md presence + required section anchors."""
import re
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


def test_coordinator_md_scripts_use_plugin_root_not_cwd_relative():
    """Every hooks/scripts invocation (and bare session-helper.sh call) must be
    rooted at ${CLAUDE_PLUGIN_ROOT} — a cwd-relative path breaks once the
    coordinator's cwd is a seed worktree instead of the plugin root."""
    c = COORD.read_text()
    # `bash|python3|node <space> hooks/scripts/...` with no ${CLAUDE_PLUGIN_ROOT}/
    assert re.search(r"(?:bash|python3|node)\s+hooks/scripts/", c) is None, (
        "coordinator.md still has a cwd-relative `<runner> hooks/scripts/...` call"
    )
    # `$(hooks/scripts/...)` command substitution without the plugin root
    assert "$(hooks/scripts/" not in c, (
        "coordinator.md still has a cwd-relative `$(hooks/scripts/...)` call"
    )
    # bare `session-helper.sh <subcmd>` (line-leading or inside $( )) w/o root
    assert re.search(r"^\s*session-helper\.sh\s", c, re.M) is None
    assert "$(session-helper.sh " not in c
    # positive anchor: the rooted form is actually present
    assert "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/session-helper.sh" in c


def test_coordinator_md_defines_section_8_1_termination():
    """§ 8.1 must be a real, inlined section (not a dangling placeholder) that
    the Main Loop's `termination_trigger` resolves to, and it must enumerate the
    four deterministic conditions."""
    c = COORD.read_text()
    assert "§ 8.1" in c and "Termination Conditions" in c, (
        "coordinator.md references § 8.1 but never defines the section"
    )
    # Main Loop wiring: termination_trigger must reference the section, not a
    # bare undefined placeholder.
    assert "termination_trigger" in c
    # The four conditions the section must cover.
    m = re.search(r"## § 8\.1 Termination Conditions(.*?)(?=^## )", c,
                  re.DOTALL | re.MULTILINE)
    assert m, "could not extract the § 8.1 section body"
    body = m.group(1)
    assert "seeds" in body and "killed_" in body, "§ 8.1 missing all-seeds-killed condition"
    assert "budget" in body, "§ 8.1 missing budget-exhaustion condition"
    assert "max_epochs" in body, "§ 8.1 missing epoch-cap condition"
    assert "wall" in body.lower() and "created_at" in body, "§ 8.1 missing wall-clock cap condition"
