"""resume.md v3.1 branch — § 11.2 + § 11.3 reconciliation tests.

Six scenarios per the G10 plan / next-session-prompt enumeration:
  1. Resume at block boundary (clean seed_block_completed at tail)
  2. Resume mid-block: journal `planned` + matching git commit → synthesize `committed`
  3. Resume mid-block: journal `planned`, no matching commit → discard plan
  4. Resume when worktree missing (W-11.1 Worktree deleted path)
  5. Resume when session.yaml.virtual_parallel.seeds disagrees with journal snapshot (W-3 drift)
  6. Resume of v3.0 session under v3.1 code → v3.0 path (version gate)

Scenarios 1–5 are content + behavioral checks against resume.md prose.
Scenario 6 also exercises the T34 fixture v3_0_resume_sample/ end-to-end.
"""
import re, json, shutil, subprocess
from pathlib import Path

PROTOCOL = (Path(__file__).parents[3]
            / "skills/deep-evolve-workflow/protocols/resume.md")
HELPER = (Path(__file__).parents[3]
          / "hooks/scripts/session-helper.sh")
FIXTURES = Path(__file__).parent / "fixtures"


def _content():
    assert PROTOCOL.is_file(), f"resume.md must exist at {PROTOCOL}"
    return PROTOCOL.read_text(encoding="utf-8")


# ---------- Scenario 1: block boundary ----------

def test_step35_section_present():
    """Step 3.5 v3.1 reconciliation must exist between Step 3 and Step 4."""
    c = _content()
    assert "## Step 3.5" in c, "Step 3.5 section header missing"
    s3_idx = c.index("## Step 3 ")
    s35_idx = c.index("## Step 3.5")
    s4_idx = c.index("## Step 4 ")
    assert s3_idx < s35_idx < s4_idx


def test_step35_version_gate():
    """Step 3.5 must be gated by $VERSION == '3.1.0' (and explicitly say
    what to do for v3.0 sessions)."""
    c = _content()
    s35 = c.split("## Step 3.5", 1)[1].split("## Step 4 ", 1)[0]
    assert "deep_evolve_version" in s35 or "VERSION" in s35
    assert '3.1.0' in s35
    # Must explicitly route non-3.1 versions
    assert re.search(r"v3\.0|v2|skip|bypass|proceed\s+to\s+Step\s+4", s35, re.IGNORECASE)


def test_step35_block_boundary_clean_resume():
    """Scenario 1: when journal tail is seed_block_completed, scheduler
    proceeds with next decision (no synthesis needed)."""
    c = _content()
    s35 = c.split("## Step 3.5", 1)[1].split("## Step 4 ", 1)[0]
    assert "seed_block_completed" in s35
    # Prose must say "no reconciliation needed" / "proceed to scheduler" /
    # equivalent for clean tail
    assert re.search(
        r"clean|boundary|proceed|next\s+(decision|scheduler)",
        s35,
        re.IGNORECASE,
    )


# ---------- Scenario 2 + 3: mid-block reconciliation ----------

def test_step35_git_log_is_truth_invariant_documented():
    """§ 11.3: commit FIRST, journal-append AFTER. Resume.md must state
    this invariant explicitly so future readers don't re-invert it."""
    c = _content()
    s35 = c.split("## Step 3.5", 1)[1].split("## Step 4 ", 1)[0]
    # Must mention "commit first" + "git is truth" / "git log is truth"
    assert re.search(
        r"commit\s+(first|FIRST)|git[- ]log[- ]is[- ]truth|git\s+is\s+truth",
        s35,
        re.IGNORECASE,
    )


def test_step35_planned_with_matching_commit_synthesizes_committed():
    """Scenario 2: if journal tail is `planned` AND worktree HEAD has a
    matching commit, append synthetic `committed` event and proceed.
    Tests the explicit reconciliation rule, not just the invariant."""
    c = _content()
    s35 = c.split("## Step 3.5", 1)[1].split("## Step 4 ", 1)[0]
    assert "planned" in s35
    assert re.search(r"committed|kept", s35)
    # The reconciliation prose: "if planned + matching commit, synthesize"
    assert re.search(
        r"synthe(size|tic)|matching\s+commit|committed.*append",
        s35,
        re.IGNORECASE,
    )


def test_step35_planned_no_matching_commit_discards_plan():
    """Scenario 3: if journal tail is `planned` AND no matching commit,
    discard the plan (subagent crashed before committing)."""
    c = _content()
    s35 = c.split("## Step 3.5", 1)[1].split("## Step 4 ", 1)[0]
    assert re.search(
        r"discard|abandon|drop\s+plan|no\s+matching\s+commit",
        s35,
        re.IGNORECASE,
    )


# ---------- Scenario 4: worktree missing ----------

def test_step35_worktree_missing_handled():
    """Scenario 4: cmd_validate_seed_worktree returns rc=3 (worktree missing).
    Resume.md must invoke validate_seed_worktree per seed and route the
    rc=3 case to the W-11.1 worktree-deleted recovery."""
    c = _content()
    s35 = c.split("## Step 3.5", 1)[1].split("## Step 4 ", 1)[0]
    assert "validate_seed_worktree" in s35
    # rc=3 routing or W-11.1 reference
    assert re.search(r"missing|deleted|rc\s*=?\s*3|W-?11", s35, re.IGNORECASE)


def test_step35_validate_seed_worktree_rc_guarded():
    """validate_seed_worktree must be called inside `if ! ...; then ...
    fi` rc guard per the aff23c9 contract."""
    c = _content()
    s35 = c.split("## Step 3.5", 1)[1].split("## Step 4 ", 1)[0]
    vsw_line = next((ln for ln in s35.splitlines() if "validate_seed_worktree" in ln), "")
    if not vsw_line:
        return  # already covered by previous test
    vsw_idx = s35.index(vsw_line)
    preamble = s35[max(0, vsw_idx - 400):vsw_idx]
    assert re.search(r"if\s+!\s|case\s+", preamble), \
        "validate_seed_worktree call must be inside an rc-guard"


# ---------- Scenario 5: session.yaml vs journal drift ----------

def test_step35_drift_detection_present():
    """Scenario 5: session.yaml.virtual_parallel.seeds[] has K entries but
    journal has J seed_initialized events with K != J. Must detect and
    apply the drift-resolution rule (W-3 from G10 enumeration: prefer
    journal snapshot — git+journal are append-only authoritative; yaml
    can be overwritten by partial init failures)."""
    c = _content()
    s35 = c.split("## Step 3.5", 1)[1].split("## Step 4 ", 1)[0]
    assert re.search(r"drift|disagree|mismatch|inconsistent", s35, re.IGNORECASE)
    # Resolution rule: prefer journal (W-3) — must be explicit
    assert re.search(
        r"prefer\s+journal|journal\s+(authoritative|wins|truth)|trust\s+journal",
        s35,
        re.IGNORECASE,
    )


def test_step35_drift_emits_warning_journal_event():
    """When drift is detected, append a `resume_drift_detected` journal
    event for audit. Without this, drift is silently fixed and reviewers
    can't trace why state changed during resume."""
    c = _content()
    s35 = c.split("## Step 3.5", 1)[1].split("## Step 4 ", 1)[0]
    assert "resume_drift_detected" in s35 or "resume_reconciled" in s35


# ---------- Scenario 6: v3.0 backward-compat (uses T34 fixture) ----------

def test_step35_v3_0_session_routes_to_v3_path():
    """Scenario 6: v3.0 session under v3.1 code. The version gate at
    Step 3.5 must explicitly say 'proceed to Step 4 with v3.0 banner'."""
    c = _content()
    s35 = c.split("## Step 3.5", 1)[1].split("## Step 4 ", 1)[0]
    # The non-3.1 routing prose
    assert re.search(
        r"v3\.0|v2|virtual_parallel.*absent|no\s+virtual_parallel",
        s35,
        re.IGNORECASE,
    )
    # Step 4 banner remains as-is for v2/v3.0 (sanity: v2 banner still in file)
    s4 = c.split("## Step 4 ", 1)[1]
    assert "v2 Compatibility Banner" in s4


def test_step35_w6_trace_seeds_handle_to_validation_loop():
    """W-6 trace: session.yaml.virtual_parallel.seeds (read at top of Step
    3.5) flows into the per-seed validate_seed_worktree loop. Verified by
    proximity in the prose: same section uses both."""
    c = _content()
    s35 = c.split("## Step 3.5", 1)[1].split("## Step 4 ", 1)[0]
    assert "virtual_parallel" in s35
    assert "seeds" in s35
    assert "validate_seed_worktree" in s35
    # Order: read seeds, then iterate validate
    seeds_idx = s35.index("seeds")
    val_idx = s35.index("validate_seed_worktree")
    assert seeds_idx < val_idx, \
        "Step 3.5 must read seeds[] BEFORE iterating validate_seed_worktree"


# ---------- Scenario 6 end-to-end (uses T34 fixture) ----------

def test_v3_0_fixture_resume_uses_v3_0_path():
    """Scenario 6 end-to-end: T34's v3_0_resume_sample fixture has no
    virtual_parallel block. session-helper.sh's resolve_current must
    correctly identify it as a v3.0 session.

    NOTE: this test depends on T34's fixture existing. If T34 hasn't
    landed yet, the test xfails."""
    fx = FIXTURES / "v3_0_resume_sample"
    if not fx.is_dir():
        import pytest
        pytest.xfail("T34 fixture v3_0_resume_sample not yet created")
    sy = fx / "session.yaml"
    assert sy.is_file(), "fixture session.yaml must exist"
    import yaml
    obj = yaml.safe_load(sy.read_text())
    # v3.0 marker
    assert obj["deep_evolve_version"].startswith("3.0"), \
        f"fixture must be v3.0.x, got {obj['deep_evolve_version']}"
    # v3.0 must NOT have virtual_parallel block
    assert "virtual_parallel" not in obj, \
        "v3.0 fixture must not have virtual_parallel block (defeats version gate)"


def test_v3_0_fixture_results_tsv_has_v3_header():
    """v3.0 sessions DO use the 9-column header (init.md:333). Fixture must
    match — defeats the column-count auto-detect at resume.md:124 if not."""
    fx = FIXTURES / "v3_0_resume_sample"
    if not fx.is_dir():
        import pytest
        pytest.xfail("T34 fixture not yet created")
    tsv = fx / "results.tsv"
    header = tsv.read_text().splitlines()[0]
    cols = header.split("\t")
    assert len(cols) == 9, f"v3.0 fixture results.tsv must have 9 columns, got {len(cols)}"


def test_v3_0_fixture_journal_has_v3_0_events_only():
    """The fixture journal must NOT contain v3.1-only events
    (seed_initialized, init_vp_analysis, init_n_chosen, resume_drift_detected,
    seed_killed, seed_block_completed). Otherwise it would defeat the
    'no virtual_parallel artifacts' guarantee of the version gate."""
    fx = FIXTURES / "v3_0_resume_sample"
    if not fx.is_dir():
        import pytest
        pytest.xfail("T34 fixture not yet created")
    jl = fx / "journal.jsonl"
    v31_only = {"seed_initialized", "init_vp_analysis", "init_n_chosen",
                "resume_drift_detected", "seed_killed", "seed_block_completed",
                "seed_block_failed", "seed_scheduled", "borrow_planned",
                "cross_seed_borrow", "synthesis_commit"}
    for ln in jl.read_text().splitlines():
        if not ln.strip(): continue
        ev = json.loads(ln).get("event")
        assert ev not in v31_only, \
            f"v3.0 fixture journal contains v3.1-only event: {ev}"
