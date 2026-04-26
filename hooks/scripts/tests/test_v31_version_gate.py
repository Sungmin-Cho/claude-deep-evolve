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
import subprocess
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


def _coordinator_gate_subprocess(version_str, session_root="/tmp/t38-mock"):
    """Simulate coordinator.md's gate with a fixed VERSION value.

    Strategy: read the gate's bash block from coordinator.md, replace the
    dynamic `VERSION=$(grep ... session.yaml | sed ...)` line with a literal
    `VERSION="<version_str>"` assignment, then exec the resulting block under
    /bin/bash. Returns (rc, stderr_text)."""
    c = _read("coordinator.md")
    gate_start = c.index("## Version Gate")
    gate_end = c.index("\n## ", gate_start + 1)
    block = c[gate_start:gate_end]
    bash_blocks = re.findall(r"```bash\n(.*?)\n```", block, re.DOTALL)
    assert bash_blocks, "coordinator.md Version Gate must contain at least one bash block"
    bash = "\n".join(bash_blocks)
    # Replace the dynamic VERSION extraction with a literal
    bash = re.sub(
        r'VERSION=\$\([^)]*\)(?:[^\n]*)',
        f'VERSION="{version_str}"',
        bash,
        count=1,
    )
    full = f'export SESSION_ROOT={session_root!s}\n{bash}\n'
    p = subprocess.run(
        ["/bin/bash", "-c", full],
        capture_output=True, text=True,
    )
    return p.returncode, p.stderr


# ---------- T38 (W2 G11 fold-in): forward-compat tier-based gate ----------

def test_coordinator_uses_unified_version_tier_with_forward_compat():
    """T38 W2: coordinator.md must use the same 4-arm VERSION_TIER pattern as
    T37 in inner-loop / outer-loop / synthesis. The strict `3.1.*)` arm is
    replaced with the unified pattern, then a tier == v3_1_plus check
    enforces coordinator-only entry. This is the content-shape test; the 6
    routing-behavior tests below exercise the runtime semantics."""
    c = _read("coordinator.md")
    # Must contain VERSION_TIER export (T37 W6 lesson)
    assert re.search(r'\bexport\s+VERSION_TIER\b', c), \
        "coordinator.md must `export VERSION_TIER`"
    # Must contain all 3 tier values (uniform with T37)
    for tier in ("pre_v3", "v3_0", "v3_1_plus"):
        assert tier in c, f"VERSION_TIER value '{tier}' missing from coordinator.md"
    # Must contain the tier-equality check (the coordinator-only addition)
    assert re.search(
        r'\[\s+"\$VERSION_TIER"\s+!=\s+"v3_1_plus"\s+\]',
        c,
    ), "coordinator.md must check VERSION_TIER != v3_1_plus and exit"


def test_coordinator_accepts_v3_1_session():
    """Baseline: v3.1.0 must pass through coordinator gate."""
    rc, _ = _coordinator_gate_subprocess("3.1.0")
    assert rc == 0, "v3.1.0 must pass through coordinator gate"


def test_coordinator_accepts_v3_2_session_forward_compat():
    """W2 fix: v3.2.0 sessions must route through coordinator (was: rc=1 reject
    on the strict `3.1.*)` arm). This is the regression-class test that fails
    on the pre-W2 gate and passes on the post-W2 unified-tier gate."""
    rc, _ = _coordinator_gate_subprocess("3.2.0")
    assert rc == 0, "coordinator.md must accept v3.2 sessions (forward-compat W2)"


def test_coordinator_accepts_v4_session_forward_compat():
    """W2 fix continuation: v4.x must also be accepted as v3_1_plus tier."""
    rc, _ = _coordinator_gate_subprocess("4.0.0")
    assert rc == 0, "coordinator.md must accept v4.x sessions (forward-compat W2)"


def test_coordinator_rejects_v3_0_session():
    """Defense-in-depth (W2 design choice B): v3.0 routes through legacy
    inner-loop/outer-loop directly via dispatcher; entering coordinator means
    dispatcher bug. Coordinator must NOT silently proceed under v3.0."""
    rc, err = _coordinator_gate_subprocess("3.0.5")
    assert rc != 0, "coordinator.md must reject v3.0.x sessions"
    assert "v3" in err.lower() or "tier" in err.lower(), \
        f"coordinator.md must explain rejection in stderr (got: {err!r})"


def test_coordinator_rejects_v2_session():
    """v2.x sessions must be rejected at coordinator-gate level."""
    rc, err = _coordinator_gate_subprocess("2.4.0")
    assert rc != 0
    assert err.strip(), "coordinator.md must emit error message on v2 entry"


def test_coordinator_rejects_garbage_version():
    """Default arm catches malformed VERSION (per T37 W-1 lesson — never
    silent fallthrough). Treats as pre_v3 → tier check fails → exit 1."""
    rc, _ = _coordinator_gate_subprocess("not-a-version")
    assert rc != 0, "coordinator.md default arm must route garbage to pre_v3 → exit 1"


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
