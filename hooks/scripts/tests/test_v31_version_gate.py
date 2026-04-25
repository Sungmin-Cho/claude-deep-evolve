"""Version-gate uniformization across protocol files.

Per spec § 10.1, the 4 protocol files inner-loop.md / outer-loop.md /
synthesis.md / coordinator.md must:
  - All initialize $VERSION + $VERSION_TIER from session.yaml
  - All use the W-1 4-arm case pattern (v2.* / v3.0* / v3.* / *)
  - All have an explicit default arm with descriptive prose
  - Differentiate $VERSION_TIER ∈ {"pre_v3", "v3_0", "v3_1_plus"} so
    sub-steps can gate on tier rather than version-string substring

Tests are content/regex-level. Behavioral simulation (running v3.0
session under v3.1 code routes to legacy path) is exercised by G12's
test_v31_resume_v31.py scenario 6.
"""
import re
from pathlib import Path

ROOT = Path(__file__).parents[3]
PROTOCOLS = ROOT / "skills/deep-evolve-workflow/protocols"

TARGET_FILES = ["inner-loop.md", "outer-loop.md",
                "synthesis.md", "coordinator.md"]


def _read(name):
    p = PROTOCOLS / name
    assert p.is_file(), f"missing protocol file {p}"
    return p.read_text(encoding="utf-8")


# ---------- T37: Version + VERSION_TIER initialization ----------

def test_inner_loop_initializes_version_tier():
    c = _read("inner-loop.md")
    # Must have a 4-arm case + VERSION_TIER export
    assert "VERSION_TIER" in c, \
        "inner-loop.md must export VERSION_TIER"
    assert re.search(r'case\s+"?\$VERSION"?\s+in', c)


def test_outer_loop_initializes_version_tier():
    c = _read("outer-loop.md")
    assert "VERSION_TIER" in c
    assert re.search(r'case\s+"?\$VERSION"?\s+in', c)


def test_synthesis_initializes_version_tier():
    """T28 already has the W-1 4-arm case; T37 adds VERSION_TIER export
    for downstream consistency (synthesis-internal sub-steps can gate
    on tier instead of re-running the case)."""
    c = _read("synthesis.md")
    assert "VERSION_TIER" in c, \
        "synthesis.md must export VERSION_TIER alongside its existing case"


def test_coordinator_keeps_strict_v3_1_only_gate():
    """coordinator.md is v3.1+ exclusive (per file header line 1).
    T37 leaves the gate code unchanged but adds an annotation comment."""
    c = _read("coordinator.md")
    # Must still bail on non-3.1
    assert re.search(r'\b3\.1\.\*\)\s*;;', c) or \
        re.search(r'starts with "3\.1', c)
    # Annotation comment T37 adds
    assert re.search(
        r"v3\.1\+\s+only|see\s+synthesis\.md|legacy.*fallback",
        c,
        re.IGNORECASE,
    ), "coordinator.md must annotate its v3.1+-only stance"


# ---------- T37: 4-arm pattern (W-1 lesson) ----------

def _gate_block(content):
    """Extract the version-gate region near the top of the file."""
    # First case statement on $VERSION — heuristic: from 'case "$VERSION"' to
    # the next 'esac' (inclusive)
    m = re.search(r'(case\s+"?\$VERSION"?.*?esac)', content, re.DOTALL)
    return m.group(1) if m else ""


def test_inner_loop_has_4_arm_pattern():
    g = _gate_block(_read("inner-loop.md"))
    assert g, "inner-loop.md missing case-on-VERSION block"
    assert re.search(r'\b2\.\*', g), "v2.* arm missing"
    assert re.search(r'\b3\.0', g), "v3.0* arm missing"
    assert re.search(r'\b3\.\*|3\.1', g), "v3.* / v3.1 arm missing"
    assert re.search(r'\*\)', g), "default *) arm missing"


def test_outer_loop_has_4_arm_pattern():
    g = _gate_block(_read("outer-loop.md"))
    assert g, "outer-loop.md missing case-on-VERSION block"
    assert re.search(r'\b2\.\*', g)
    assert re.search(r'\b3\.0', g)
    assert re.search(r'\b3\.\*|3\.1', g)
    assert re.search(r'\*\)', g)


# ---------- T37: VERSION_TIER value semantics ----------

def test_inner_loop_tier_values():
    """VERSION_TIER must be one of pre_v3 / v3_0 / v3_1_plus — these
    are the literal values consumed downstream."""
    c = _read("inner-loop.md")
    for tier in ("pre_v3", "v3_0", "v3_1_plus"):
        assert tier in c, f"VERSION_TIER value '{tier}' missing from inner-loop.md"


def test_outer_loop_tier_values():
    c = _read("outer-loop.md")
    for tier in ("pre_v3", "v3_0", "v3_1_plus"):
        assert tier in c, f"VERSION_TIER value '{tier}' missing from outer-loop.md"


def test_synthesis_tier_values():
    c = _read("synthesis.md")
    for tier in ("pre_v3", "v3_0", "v3_1_plus"):
        assert tier in c, f"VERSION_TIER value '{tier}' missing from synthesis.md"


# ---------- T37: virtual_parallel-dependent sub-step gating ----------

def test_inner_loop_virtual_parallel_substeps_gated_on_tier():
    """Sub-steps that read session.yaml.virtual_parallel (T16 seed_id
    tagging, T17 borrow preflight, T18 forum consultation) MUST gate on
    VERSION_TIER == 'v3_1_plus', not on '$VERSION starts with "3."' —
    a v3.0 session would crash trying to read virtual_parallel."""
    c = _read("inner-loop.md")
    # Find regions that mention virtual_parallel or forum or seed_id and
    # verify they're inside a v3_1_plus gate (not a bare prefix match).
    # Heuristic: every line referencing 'virtual_parallel' or 'forum.jsonl'
    # appears within 30 lines of a 'v3_1_plus' check.
    lines = c.splitlines()
    for i, line in enumerate(lines):
        if "virtual_parallel" in line or "forum.jsonl" in line:
            window = "\n".join(lines[max(0, i - 30):i + 5])
            assert "v3_1_plus" in window or "VERSION_TIER" in window, \
                f"line {i} references v3.1-only state without v3_1_plus gate: {line!r}"


def test_outer_loop_step_6_5_0_gated_on_tier():
    """Step 6.5.0 (T20) emits convergence_event which doesn't exist in
    v3.0 — must be inside v3_1_plus gate.

    W5 fix (deep-review 2026-04-25 plan-stage): replaced silent `if m:`
    pattern with `assert m, ...` so the test fails loudly if the Step 6.5.0
    anchor is renamed (e.g., to `Step 6.5.0.0` or dropped). Previously the
    test silently passed when the regex didn't match."""
    c = _read("outer-loop.md")
    # Find Step 6.5.0 region — fail loudly if absent
    m = re.search(r'Step\s+6\.5\.0.*?(?=Step\s+6\.5\.\d|^##\s)',
                  c, re.DOTALL | re.MULTILINE)
    assert m, "Step 6.5.0 anchor not found in outer-loop.md (renamed or removed?)"
    region = m.group(0)
    assert "v3_1_plus" in region or "VERSION_TIER" in region, \
        "Step 6.5.0 must gate on VERSION_TIER == v3_1_plus"


def test_version_tier_is_exported_in_inner_loop():
    """W6 fix (deep-review 2026-04-25 plan-stage): VERSION_TIER must be
    `export`ed (not just assigned), so subagent dispatch under set -u
    inherits it. Other version-related env vars (DEEP_EVOLVE_HELPER_PATH,
    DEEP_EVOLVE_SEAL_PREPARE, DEEP_EVOLVE_NO_PARALLEL) are all exported
    for exactly this reason."""
    c = _read("inner-loop.md")
    assert re.search(r'\bexport\s+VERSION_TIER\b', c), \
        "inner-loop.md must `export VERSION_TIER` (not just assign)"


def test_version_tier_is_exported_in_outer_loop():
    """Symmetric W6 defense for outer-loop.md."""
    c = _read("outer-loop.md")
    assert re.search(r'\bexport\s+VERSION_TIER\b', c), \
        "outer-loop.md must `export VERSION_TIER`"


def test_version_tier_is_exported_in_synthesis():
    """Symmetric W6 defense for synthesis.md (T37 alongside existing 4-arm)."""
    c = _read("synthesis.md")
    assert re.search(r'\bexport\s+VERSION_TIER\b', c), \
        "synthesis.md must `export VERSION_TIER` for downstream consistency"


# ---------- T37: Default arm prose ----------

def test_inner_loop_default_arm_descriptive():
    """Default arm must say what is happening (treat as pre-v3, exit, etc.)
    — never silent fallthrough per W-1 lesson."""
    g = _gate_block(_read("inner-loop.md"))
    # Default arm region (after `*)`)
    m = re.search(r'\*\)\s*\n\s*([^;]+);;', g, re.DOTALL)
    assert m, "default arm body missing"
    body = m.group(1)
    assert re.search(r"echo|warn|treat\s+as|pre[\s-]?v3",
                     body, re.IGNORECASE), \
        "default arm must have descriptive prose"
