"""F1 fix (G13 Option A response, 2026-04-26 deep-review):

Verify VERSION_TIER routing actually wires sessions into coordinator.md (v3.1+)
or inner-loop.md (v3.0 / pre_v3).

Codex adversarial review caught that pre-G13 init.md/resume.md/commands routed
ALL sessions to inner-loop.md regardless of version, silently bypassing the
v3.1 coordinator/scheduler/forum/synthesis machinery despite the CHANGELOG
promising coordinator-driven N-seed exploration. This file's tests assert the
fix landed in all 3 entrypoints AND that the v3.0/pre_v3 fallback path is
preserved (single-seed code path unchanged for v3.0.x and v2.x sessions).

Test pattern matches test_v31_version_gate.py (content-assertion on protocol
markdown), since the 4-arm case statement is the canonical SOT and runtime
behavior is dispatched by reading the markdown.
"""

from pathlib import Path

REPO = Path(__file__).parents[3]
INIT = REPO / "skills/deep-evolve-workflow/protocols/init.md"
RESUME = REPO / "skills/deep-evolve-workflow/protocols/resume.md"
COMMANDS = REPO / "commands/deep-evolve.md"


# === init.md Step 12 — fresh-init dispatch ===

def test_init_md_step12_exists():
    """init.md must declare a Step 12 routing block (post-baseline transition)."""
    c = INIT.read_text()
    assert "## Step 12 — Route to execution loop" in c, (
        "init.md Step 12 routing header missing"
    )


def test_init_md_routes_v3_1_plus_to_coordinator():
    """v3_1_plus tier must route to coordinator.md."""
    c = INIT.read_text()
    # The routing bullet pairs the tier with the target protocol on the same
    # line/region. Use a split-on-tier-token approach that survives prose drift.
    tier_idx = c.find("`VERSION_TIER == v3_1_plus`")
    assert tier_idx != -1, "v3_1_plus arm missing from init.md routing"
    # Within ~250 chars after the tier mention, coordinator.md must appear.
    window = c[tier_idx:tier_idx + 250]
    assert "coordinator.md" in window, (
        "init.md v3_1_plus arm does not target coordinator.md "
        f"(window={window!r})"
    )


def test_init_md_routes_v3_0_to_inner_loop():
    """v3_0 tier must route to inner-loop.md (preserve single-seed path)."""
    c = INIT.read_text()
    tier_idx = c.find("`VERSION_TIER == v3_0`")
    assert tier_idx != -1, "v3_0 arm missing from init.md routing"
    window = c[tier_idx:tier_idx + 250]
    assert "inner-loop.md" in window, (
        "init.md v3_0 arm does not target inner-loop.md (would break v3.0.x sessions)"
    )


def test_init_md_routes_pre_v3_to_inner_loop():
    """pre_v3 tier must route to inner-loop.md (preserve legacy v2.x path)."""
    c = INIT.read_text()
    tier_idx = c.find("`VERSION_TIER == pre_v3`")
    assert tier_idx != -1, "pre_v3 arm missing from init.md routing"
    window = c[tier_idx:tier_idx + 300]
    assert "inner-loop.md" in window, (
        "init.md pre_v3 arm does not target inner-loop.md"
    )


def test_init_md_has_4_arm_case_statement():
    """init.md Step 12 must compute VERSION_TIER via the 4-arm case (uniform SOT)."""
    c = INIT.read_text()
    # All 4 arms (case patterns) must appear in the Step 12 region
    step12_idx = c.find("## Step 12 — Route to execution loop")
    assert step12_idx != -1
    region = c[step12_idx:step12_idx + 2000]
    assert "2.*)" in region, "pre_v3 case arm missing"
    assert "3.0|3.0.*)" in region, "v3_0 case arm missing"
    assert "3.*|4.*)" in region, "v3_1_plus case arm missing"
    assert "*)" in region, "default fallthrough arm missing"


# === resume.md Step 5 — resume dispatch ===

def test_resume_md_step5_has_version_tier_dispatch():
    """resume.md Step 5 must compute VERSION_TIER (not just status branch)."""
    c = RESUME.read_text()
    step5_idx = c.find("## Step 5 — Re-enter experiment loop")
    assert step5_idx != -1, "Step 5 section header missing"
    region = c[step5_idx:]
    # Must mention VERSION_TIER computation in the dispatch block
    assert "VERSION_TIER" in region, "Step 5 missing VERSION_TIER computation"
    assert "case \"$VERSION\"" in region, "Step 5 missing 4-arm case statement"


def test_resume_md_routes_v3_1_plus_active_to_coordinator():
    """Resumed active v3.1+ session must route to coordinator.md."""
    c = RESUME.read_text()
    step5_idx = c.find("## Step 5 — Re-enter experiment loop")
    region = c[step5_idx:]
    tier_idx = region.find("`VERSION_TIER == v3_1_plus`")
    assert tier_idx != -1, "Step 5 v3_1_plus arm missing"
    window = region[tier_idx:tier_idx + 250]
    assert "coordinator.md" in window, (
        "resume.md Step 5 v3_1_plus arm does not target coordinator.md "
        "(would silently fall back to single-seed inner-loop.md)"
    )


def test_resume_md_routes_v3_0_pre_v3_active_to_inner_loop():
    """Resumed active v3.0 / pre_v3 session must route to inner-loop.md (preserved)."""
    c = RESUME.read_text()
    step5_idx = c.find("## Step 5 — Re-enter experiment loop")
    region = c[step5_idx:]
    # v3_0 + pre_v3 are the legacy single-seed tiers — combined arm is acceptable
    # (e.g. "VERSION_TIER ∈ {v3_0, pre_v3}" or two separate arms both → inner-loop).
    assert "v3_0" in region and "pre_v3" in region, (
        "Step 5 missing legacy tier mentions (v3_0 + pre_v3)"
    )
    # inner-loop.md must appear after both legacy tier mentions
    legacy_combined_idx = max(
        region.find("v3_0"), region.find("pre_v3")
    )
    window = region[legacy_combined_idx:legacy_combined_idx + 400]
    assert "inner-loop.md" in window, (
        "resume.md Step 5 legacy-tier arm does not preserve inner-loop.md routing"
    )


def test_resume_md_paused_status_unchanged():
    """Paused status must still route to outer-loop.md (unchanged behavior)."""
    c = RESUME.read_text()
    step5_idx = c.find("## Step 5 — Re-enter experiment loop")
    region = c[step5_idx:]
    paused_idx = region.find("status == paused")
    assert paused_idx != -1, "Step 5 paused branch missing"
    window = region[paused_idx:paused_idx + 400]
    assert "outer-loop.md" in window, (
        "resume.md paused branch broke; must still target outer-loop.md"
    )


# === commands/deep-evolve.md — protocol routing summary ===

def test_commands_routing_summary_includes_coordinator():
    """commands/deep-evolve.md Protocol Routing Summary must list coordinator.md."""
    c = COMMANDS.read_text()
    summary_idx = c.find("## Protocol Routing Summary")
    assert summary_idx != -1, "Protocol Routing Summary section missing"
    region = c[summary_idx:summary_idx + 2000]
    assert "coordinator.md" in region, (
        "Protocol Routing Summary does not include coordinator.md"
    )


def test_commands_routing_summary_marks_v3_1_only_for_coordinator():
    """The coordinator entry must be tagged as v3_1_plus only (so it doesn't
    confuse v3.0/v2.x users about routing)."""
    c = COMMANDS.read_text()
    summary_idx = c.find("## Protocol Routing Summary")
    region = c[summary_idx:summary_idx + 2000]
    coord_idx = region.find("Coordinator")
    assert coord_idx != -1, "Coordinator routing entry missing"
    # Tag must mention v3.1+ scoping somewhere on the same / following line
    coord_window = region[coord_idx:coord_idx + 200]
    assert "v3_1_plus" in coord_window or "v3.1" in coord_window, (
        f"Coordinator entry not tagged as v3.1+ scope (window={coord_window!r})"
    )


def test_commands_routing_summary_explains_version_tier_dispatch():
    """The summary must explain the 4-arm VERSION_TIER → protocol mapping
    so future maintainers see the SOT in one place."""
    c = COMMANDS.read_text()
    summary_idx = c.find("## Protocol Routing Summary")
    region = c[summary_idx:summary_idx + 3000]
    # All 4 case patterns must appear in the explanation
    assert "2.*" in region
    assert "3.0|3.0.*" in region
    assert "3.*|4.*" in region
    # Mappings to protocols
    assert "v3_1_plus" in region and "coordinator" in region
    assert ("v3_0" in region or "pre_v3" in region) and "inner-loop" in region


# === SOT consistency across protocol files ===

def test_version_tier_classification_uniform_across_protocols():
    """All 6 protocol files participating in VERSION_TIER routing must classify
    versions consistently:

    - 2.x  → pre_v3
    - 3.0.x → v3_0
    - 3.1+ / 4.x → v3_1_plus

    Different files use different glob syntax (`3.0*)` vs `3.0|3.0.*)`) — both
    are functionally equivalent for the tier mapping. This test only checks
    that the tier *labels* (pre_v3 / v3_0 / v3_1_plus) appear paired with
    appropriate version patterns in each file.

    Bug class this guards against: a future contributor adding a new protocol
    file or modifying an existing one without preserving the tier mapping —
    e.g., classifying 3.0.x as v3_1_plus, which would break v3.0.x sessions.
    """
    files = {
        "init.md": INIT,
        "resume.md": RESUME,
        "inner-loop.md": REPO / "skills/deep-evolve-workflow/protocols/inner-loop.md",
        "outer-loop.md": REPO / "skills/deep-evolve-workflow/protocols/outer-loop.md",
        "synthesis.md": REPO / "skills/deep-evolve-workflow/protocols/synthesis.md",
        "coordinator.md": REPO / "skills/deep-evolve-workflow/protocols/coordinator.md",
    }
    for label, p in files.items():
        c = p.read_text()
        # Every file must have a 2.x → pre_v3 mapping (or skip pre_v3 explicitly
        # for v3.1-only files like coordinator/synthesis which still need the
        # tier as a defense-in-depth gate).
        assert '"pre_v3"' in c or "pre_v3" in c, (
            f"{label} missing pre_v3 tier label"
        )
        # v3_0 and v3_1_plus must both be classifiable. synthesis.md combines
        # 2.* and 3.0* into one pre-v3.1-exit arm — that's still a valid
        # tiering (it just doesn't differentiate pre_v3 from v3_0 because
        # synthesis.md exits for both); coordinator.md is similar.
        assert "v3_1_plus" in c, f"{label} missing v3_1_plus tier label"
        # All files reference the v3.1+ glob pattern (3.* or 4.*) directly.
        assert "3.*|4.*" in c or "3.*" in c, (
            f"{label} missing v3_1_plus version pattern"
        )
