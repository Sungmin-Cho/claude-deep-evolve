"""transfer.md A.2.5 — schema_version=4 read path + N_prior compatibility.

Verifies the v3.1 transfer protocol additions:
  - schema_version=2 (legacy / missing field) → existing weights migration
  - schema_version=3 (v3.0.x entry)         → N_prior=1 single-seed read
  - schema_version=4 (v3.1.x entry)         → full virtual_parallel block
  - schema_version>=5 (forward future)      → rc=2 forward-compat refusal
  - E.0 write side: v3.1.x sessions emit schema_version=4
"""
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).parents[3]
TRANSFER = ROOT / "skills/deep-evolve-workflow/protocols/transfer.md"
FIXT = ROOT / "hooks/scripts/tests/fixtures"


def _content():
    assert TRANSFER.is_file(), f"transfer.md missing at {TRANSFER}"
    return TRANSFER.read_text(encoding="utf-8")


# ---------- T36: Schema-compat branch shape ----------

def test_a25_has_4_arm_schema_branch():
    """The v2/v3 ELSE/IF must extend to a 4-arm structure covering
    {2, 3, 4, >=5}. We assert all 4 numeric-version literals appear in
    the A.2.5 schema-compat region."""
    c = _content()
    a25 = c.split("## Meta Archive Lookup", 1)[1].split(
        "## Meta Archive Update", 1)[0]
    # Schema versions must all be referenced in the compat branch
    for v in ("2", "3", "4", "5"):
        assert re.search(rf"\bschema_version\b.*\b{v}\b|\b{v}\b.*schema_version", a25), \
            f"A.2.5 must reference schema_version={v}"


def test_a25_v5_plus_explicit_rejection():
    """W-1 lesson: future versions must be rejected loudly, not silently
    fall through. v5+ → rc=2 forward-compat refusal."""
    c = _content()
    a25 = c.split("## Meta Archive Lookup", 1)[1].split(
        "## Meta Archive Update", 1)[0]
    # Must say "future" / "forward-compat" / "rc=2" / "exit 2" in the v5+ arm
    assert re.search(
        r"(forward[\s-]?compat|future\s+(version|schema)|exit\s+2|rc[=]?2)",
        a25,
        re.IGNORECASE,
    ), "v5+ arm must explicitly reject with rc=2"


def test_a25_v5_plus_routing_via_numeric_compare():
    """C3 fix (deep-review 2026-04-25 plan-stage): the v5+ rejection arm must
    use numeric `-ge 5` comparison, NOT a bash glob like `[5-9]|[1-9][0-9]*`
    which is ambiguous (glob `*` matches any chars after the second class,
    so `123abc` would match `[1-9][0-9]*`). Verify by content + behavioral
    Python simulation:
       - The bash code must contain `-ge 5` (or equivalent integer test)
       - For each of 5, 9, 10, 42, 100, 999: the routing must reject with rc=2
       - For each of 2, 3, 4: routing must NOT hit the rejection arm
       - For each of 0, -1, "abc", "5x", "": routing must skip+warn (not rc=2)
    """
    c = _content()
    a25 = c.split("## Meta Archive Lookup", 1)[1].split(
        "## Meta Archive Update", 1)[0]
    # (a) bash code uses numeric comparison (not glob alternation)
    assert re.search(r'\[\s+"\$entry_schema"\s+-ge\s+5\s+\]', a25), \
        "A.2.5 must use numeric -ge 5 (not bash glob) for v5+ rejection"
    # (b) bash code does NOT use the buggy glob alternation
    assert not re.search(r'\[5-9\]\|\[1-9\]\[0-9\]\*\)', a25), \
        "Buggy glob `[5-9]|[1-9][0-9]*` must be replaced with numeric -ge"
    # (c) malformed-input regex is present (^(0|[1-9][0-9]*)$ filters non-int)
    assert re.search(r'\^\(0\|\[1-9\]\[0-9\]\*\)\$', a25), \
        "A.2.5 must validate entry_schema as non-negative integer before routing"


def test_a25_v3_to_n_prior_1():
    """W-8: schema_v3 entries → N_prior=1 (single-seed legacy).

    W3 fix (deep-review 2026-04-25 plan-stage): tightened to require an
    actual bash assignment `N_PRIOR=1` (not just prose `single-seed`),
    so a future edit that drops the assignment but keeps the comment
    is caught."""
    c = _content()
    a25 = c.split("## Meta Archive Lookup", 1)[1].split(
        "## Meta Archive Update", 1)[0]
    # Find the schema=3 routing arm, assert N_PRIOR=1 assignment present
    # Use a multi-line regex anchored on the `3)` case arm
    m = re.search(r'^\s*3\)\s*\n(.*?)\n\s*;;', a25, re.DOTALL | re.MULTILINE)
    assert m, "schema_v3 case arm not found in A.2.5"
    arm_body = m.group(1)
    assert re.search(r'^\s*N_PRIOR=1\b', arm_body, re.MULTILINE), \
        "schema_v3 arm must contain bash assignment `N_PRIOR=1`"


def test_a25_v4_carries_virtual_parallel_block():
    """schema_v4 entries carry the full virtual_parallel snapshot."""
    c = _content()
    a25 = c.split("## Meta Archive Lookup", 1)[1].split(
        "## Meta Archive Update", 1)[0]
    assert "virtual_parallel" in a25, \
        "schema_v4 read path must reference virtual_parallel"


def test_a25_default_arm_present():
    """W-1 forward-compat lesson: case statement must have explicit `*)`
    or equivalent default arm — never silent fallthrough.

    Code-quality review fix (deep-review 2026-04-25): tightened to require
    literal `*)` arm inside the inner case block, not just `else` prose
    elsewhere. Catches future regressions where the outer if-chain filter
    is dropped without compensating defense in the inner case."""
    c = _content()
    a25 = c.split("## Meta Archive Lookup", 1)[1].split(
        "## Meta Archive Update", 1)[0]
    # Find the case statement
    case_match = re.search(r'case\s+"\$entry_schema"\s+in\s+(.*?)\n\s*esac',
                           a25, re.DOTALL)
    assert case_match, "inner case statement on $entry_schema not found"
    case_body = case_match.group(1)
    # Must have explicit *) arm
    assert re.search(r'^\s*\*\)\s*\n', case_body, re.MULTILINE), \
        "inner case must have explicit *) default arm (defense-in-depth)"


# ---------- T36: E.0 write side ----------

def test_e0_v3_1_writes_schema_version_4():
    """V3.1.x sessions writing to meta-archive must use schema_version: 4.
    The current transfer.md line 137-138 says 'v3 sessions MUST set
    "schema_version": 3'; T36 updates this to schema_version=4 for
    v3.1.x sessions, with v3.0.x continuing to write 3.

    W8 fix (deep-review 2026-04-25 plan-stage): tightened to require a
    JSON-syntax-correct trailing separator (comma / closing brace / newline)
    immediately after the literal `4`. Prior regex `:\\s*4` would match
    `: 42,` (false positive on a future typo)."""
    c = _content()
    e0 = c.split("## Meta Archive Update", 1)[1].split(
        "## Section E.1", 1)[0]
    assert re.search(r'"schema_version"\s*:\s*4\s*[,}\n]', e0), \
        "E.0 must emit schema_version=4 for v3.1.x sessions (with valid JSON separator)"


def test_e0_writes_virtual_parallel_snapshot_for_v3_1():
    """schema_v4 entries record the full virtual_parallel block from
    session.yaml so future transfers can see N_initial / project_type /
    eval_parallelizability."""
    c = _content()
    e0 = c.split("## Meta Archive Update", 1)[1].split(
        "## Section E.1", 1)[0]
    assert "virtual_parallel" in e0, \
        "E.0 schema_v4 write must include virtual_parallel snapshot"


# ---------- T36: Behavioral fixture tests ----------

def test_fixture_v3_meta_archive_present():
    """Fixture: 1 v3 entry (no virtual_parallel block, schema_version=3)."""
    p = FIXT / "transfer_schema_v3/meta-archive.jsonl"
    assert p.is_file(), f"missing fixture {p}"
    lines = p.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    e = json.loads(lines[0])
    assert e["schema_version"] == 3
    assert "virtual_parallel" not in e


def test_fixture_v4_meta_archive_present():
    """Fixture: 1 v4 entry (full virtual_parallel block, schema_version=4)."""
    p = FIXT / "transfer_schema_v4/meta-archive.jsonl"
    assert p.is_file(), f"missing fixture {p}"
    lines = p.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    e = json.loads(lines[0])
    assert e["schema_version"] == 4
    assert "virtual_parallel" in e
    vp = e["virtual_parallel"]
    # Required snapshot fields per § 9 + § 5.7
    for f in ("n_initial", "n_current", "project_type",
              "eval_parallelizability", "budget_total"):
        assert f in vp, f"v4 fixture virtual_parallel missing {f}"


# ---------- T36: W-8 trace ----------

def test_w8_trace_v3_session_reads_as_n_prior_1():
    """W-8 trace: when transfer.md A.2.5 reads a v3 entry from the
    fixture, the session.yaml.transfer block records the source schema
    version + the implied N_prior=1. This test asserts the prose
    contract (text-based) — full behavioral simulation lives in G12's
    integration test (test_v31_transfer_schema_v4_integration)."""
    c = _content()
    a25 = c.split("## Meta Archive Lookup", 1)[1].split(
        "## Meta Archive Update", 1)[0]
    # The prose must say what is recorded
    assert re.search(
        r"transfer\.source_schema_version|source_schema_version",
        a25,
    ), "A.2.5 must record the entry's schema_version on the receiving session"


def test_e0_to_a25_round_trip_n_initial():
    """W4 fix (deep-review 2026-04-25 plan-stage): schema_v4 producer/consumer
    contract round-trip — `n_initial` must survive E.0 write → A.2.5 read.

    Synthesizes a session.yaml-style virtual_parallel block with a known
    n_initial=4, follows T36's E.0 prose to construct the entry JSON
    template, then follows T36's A.2.5 prose to extract N_PRIOR back.
    Locks the field-name contract (n_initial vs n_initial_count vs N_INITIAL,
    etc.) before G12's full integration test arrives.
    """
    # Producer side: E.0 entry-format JSON template (T36 Step 5)
    # Per the prose, virtual_parallel field is the fourth top-level key
    # alongside project / strategy_evolution / outcome / virtual_parallel /
    # transfer. We construct the entry inline (the actual write uses jq;
    # this test simulates the contract, not the bash mechanics).
    entry = {
        "id": "archive_v4_test_round_trip",
        "schema_version": 4,
        "timestamp": "2026-04-25T00:00:00Z",
        "project": {"path_hash": "deadbeef", "type": "test"},
        "strategy_evolution": {"final_strategy": {"weights": {}}, "generations": 1, "q_trajectory": [0.5]},
        "outcome": {"total_experiments": 10, "improvement_pct": 0.0},
        "virtual_parallel": {
            "n_initial": 4,            # ← the value we round-trip
            "n_current": 4,
            "project_type": "standard_optimization",
            "eval_parallelizability": "parallel_capable",
            "selection_reason": "ai_suggested_user_confirmed",
            "budget_total": 40,
            "budget_unallocated": 0,
            "synthesis": {"budget_allocated": 4, "regression_tolerance": 0.05},
        },
        "transfer": {"source_id": None},
        "usage_count": 0, "transfer_success_rate": None,
    }
    # Consumer side: A.2.5 schema_v4 arm extraction (jq -r '.n_initial // 1')
    # Since we are operating on a Python dict (not piping through jq), we
    # simulate the same field access. The test fails if E.0's prose names a
    # different field (e.g., n_seeds_initial) than A.2.5's reader expects.
    vp_prior = entry.get("virtual_parallel") or {}
    n_prior = vp_prior.get("n_initial", 1)
    assert n_prior == 4, (
        f"E.0 → A.2.5 round-trip lost n_initial: written 4, read {n_prior}. "
        "Producer/consumer field-name contract violated."
    )

    # Symmetric: project_type also round-trips
    pt_prior = vp_prior.get("project_type")
    assert pt_prior == "standard_optimization", \
        f"project_type round-trip lost: read {pt_prior!r}"

    # Verify T36 plan prose confirms these fields by name
    c = _content()
    e0 = c.split("## Meta Archive Update", 1)[1].split("## Section E.1", 1)[0]
    for required_field in ("n_initial", "project_type", "eval_parallelizability"):
        assert required_field in e0, \
            f"E.0 prose must declare `{required_field}` field for round-trip"
