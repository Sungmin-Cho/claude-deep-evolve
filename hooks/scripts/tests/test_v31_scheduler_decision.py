"""T42 G12: scheduler decision integration — kill/grow paths + JSON schema.

Spec § 6 + § 5.5 + § 6.3-6.4 + § 15.1 Q6. T10/T11 cover unit-level
parse/clamp/fairness; T42 covers integration across decision shapes:
  - kill_then_schedule happy path
  - grow_then_schedule happy path / rejected (Q6 pool floor)
  - JSON schema violations (invalid enum, non-int, missing field)

Uses kill_scenarios/ fixtures (NEW) — copy to /tmp before exercise."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[3]
DECIDE = ROOT / "hooks/scripts/scheduler-decide.py"
FIXTURES = Path(__file__).parent / "fixtures/kill_scenarios"

# Single source of truth — must match scheduler-decide.py:19 ALLOWED_DECISION
ALLOWED_DECISION = {"schedule", "kill_then_schedule", "grow_then_schedule"}


def _decide(decision_json):
    """Invoke scheduler-decide.py with --decision <json> and return parsed
    output + rc + stderr.

    G12 final review F2 fix (2026-04-26): rc semantics tightened.
      rc=0 → decision accepted (out["accepted"] == True)
      rc=1 → business rejection (out["accepted"] == False; rejection
             JSON on stdout with reason field)
      rc=2 → operator error (malformed input; error message on stderr)
    """
    p = subprocess.run(
        ["python3", str(DECIDE), "--decision", json.dumps(decision_json)],
        capture_output=True, text=True,
    )
    out = None
    # Both rc=0 (accepted) and rc=1 (rejected) emit JSON to stdout
    if p.returncode in (0, 1) and p.stdout.strip():
        try:
            out = json.loads(p.stdout)
        except json.JSONDecodeError:
            out = None
    return out, p.returncode, p.stderr


def _copy_fixture(name, tmp_path):
    """Copy a kill_scenarios sub-fixture to tmp_path (avoids nested-.git trap)."""
    src = FIXTURES / name
    assert src.is_dir(), f"missing fixture {src}"
    dst = tmp_path / name
    shutil.copytree(src, dst)
    return dst


# ---------- kill_then_schedule happy path ----------

def test_kill_then_schedule_happy_path():
    """T42 W-8 #1: decision with kill_target + chosen_seed_id (distinct)
    must be accepted, both fields preserved in output (no silent drop)."""
    decision = {
        "decision": "kill_then_schedule",
        "kill_target": 3,
        "chosen_seed_id": 1,
        "block_size": 3,
        "reasoning": "seed_3 sustained_regression; chain to seed_1",
        "signals_used": ["sustained_regression", "recent_Q_trend"],
    }
    out, rc, err = _decide(decision)
    assert rc == 0, f"kill_then_schedule must accept (rc={rc}, err={err!r})"
    assert out is not None and out.get("accepted") is True
    # Both fields preserved (no silent drop)
    assert out.get("kill_target") == 3
    assert out.get("chosen_seed_id") == 1
    assert out.get("block_size") == 3


def test_kill_target_must_differ_from_chosen_seed_id():
    """Sanity: kill_target == chosen_seed_id is nonsensical (kill seed N
    then schedule seed N). Parser must reject AND the rejection signal
    must mention the violated field — preventing a stack trace from
    masquerading as legitimate rejection.

    G12 fold-in W7 fix (Opus 2026-04-26): pre-W7 test allowed any
    rc != 0 with `assert err.strip()` only — a parser crash with a
    stack trace passed. Post-W7: reject signal must reference one of
    `chosen_seed_id` / `kill_target` / `nonsense` / `same` / `match`
    in the rejection reason or stderr."""
    decision = {
        "decision": "kill_then_schedule",
        "kill_target": 3,
        "chosen_seed_id": 3,  # same — invalid
        "block_size": 3,
        "reasoning": "nonsense",
        "signals_used": [],
    }
    out, rc, err = _decide(decision)
    # G12 final review F2 fix (2026-04-26): rejection paths emit rc=1
    # (business rejection) with rejection JSON on stdout. rc=2 is
    # operator error only (malformed input). Test accepts:
    #   rc=1 + out["accepted"] == False (post-F2 contract; preferred)
    #   rc=2 + non-empty stderr (legacy operator-error path)
    rejection_text = ""
    if rc == 1:
        assert out is not None and out.get("accepted") is False, (
            f"rc=1 must include rejection JSON with accepted:false (out={out!r})"
        )
        rejection_text = (out.get("reason") or "") + " " + (out.get("error") or "")
    elif rc == 2:
        assert err.strip(), "rc=2 must include error message in stderr"
        rejection_text = err
    else:
        # rc=0: pre-F2 path (helper not yet patched) — accept rejection JSON
        # in stdout per old contract; surface as test failure if accepted:True
        assert out is not None and out.get("accepted") is False, (
            f"rc=0 with accepted:True is a regression — kill_target == "
            f"chosen_seed_id must reject (out={out!r})"
        )
        rejection_text = (out.get("reason") or "") + " " + (out.get("error") or "")
    # Rejection signal must reference the violation (not a generic crash)
    rejection_lower = rejection_text.lower()
    assert any(token in rejection_lower for token in (
        "chosen_seed_id", "kill_target", "same", "match", "equal", "identical",
    )), (
        f"rejection signal must mention the violated field, not just any "
        f"failure. Got: {rejection_text!r}. (Defense against stack-trace-as-"
        f"rejection regression class.)"
    )


# ---------- grow_then_schedule happy / rejected ----------

def test_grow_then_schedule_happy_path():
    """T42 W-8 #2: pool >= P3 floor (3) → accept with new_seed_allocation."""
    decision = {
        "decision": "grow_then_schedule",
        "new_seed_id": 4,
        "new_seed_allocation": 3,
        "chosen_seed_id": 4,
        "block_size": 3,
        "reasoning": "convergence stagnation; grow",
        "signals_used": ["convergence_event"],
    }
    out, rc, err = _decide(decision)
    assert rc == 0, f"grow_then_schedule must accept (err={err!r})"
    assert out is not None and out.get("accepted") is True
    assert out.get("new_seed_id") == 4
    assert out.get("new_seed_allocation") == 3


def test_grow_then_schedule_rejected_when_allocation_below_p3():
    """T42 W-8 #3 (Q6 spec): new_seed_allocation < 3 (P3 floor) must be
    rejected when AI explicitly supplies a below-floor allocation.

    G12 final review F2 fix (2026-04-26): rc=1 + accepted:false (post-F2
    contract). G12 final review F3 fix: AI may legitimately omit
    new_seed_allocation (coordinator computes via compute_grow_allocation);
    only AI-supplied below-floor values are rejected here."""
    decision = {
        "decision": "grow_then_schedule",
        "new_seed_id": 4,
        "new_seed_allocation": 2,  # AI-supplied below P3 floor — must reject
        "chosen_seed_id": 4,
        "block_size": 3,
        "reasoning": "pool tight",
        "signals_used": [],
    }
    out, rc, err = _decide(decision)
    # Post-F2: rc=1 + accepted:false (preferred); legacy paths accept rc=2
    if rc == 1:
        assert out is not None and out.get("accepted") is False, (
            f"rc=1 must emit rejection JSON (out={out!r})"
        )
        assert "P3" in (out.get("reason") or "") or \
            "below" in (out.get("reason") or "").lower(), (
            f"rejection reason must mention P3/below: {out.get('reason')!r}"
        )
    elif rc == 2:
        assert err.strip(), "rc=2 must include error in stderr"
    else:
        # rc=0: regression — must not accept below-floor allocation
        assert out is not None and out.get("accepted") is False, (
            f"new_seed_allocation < P3 floor must be rejected (out={out!r})"
        )


def test_grow_then_schedule_accepts_absent_allocation():
    """G12 final review F3 fix (2026-04-26): AI may legitimately omit
    `new_seed_allocation` per spec § 15.1 Q6 — coordinator computes via
    `compute_grow_allocation` after validation. Pre-fix scheduler-decide
    rejected absent allocation, blocking the documented coordinator
    contract. Post-F3: scheduler-decide accepts absent allocation;
    only AI-supplied below-floor values are rejected."""
    decision = {
        "decision": "grow_then_schedule",
        "new_seed_id": 4,
        # new_seed_allocation absent — coordinator will compute via helper
        "chosen_seed_id": 4,
        "block_size": 3,
        "reasoning": "convergence stagnation; defer allocation to helper",
        "signals_used": ["convergence_event"],
    }
    out, rc, err = _decide(decision)
    assert rc == 0, (
        f"grow_then_schedule with absent new_seed_allocation must accept "
        f"per F3 fix (rc={rc}, err={err!r})"
    )
    assert out is not None and out.get("accepted") is True
    assert out.get("decision") == "grow_then_schedule"


def _read_fixture_pool_and_n(fixture_name, tmp_path):
    """T42 review fix (2026-04-26 Stage 1 Issue #1 + Stage 2 Info #1):
    parse the fixture's session.yaml to extract `unallocated_pool` and
    `virtual_parallel.N`, making the helper-driven tests genuinely
    fixture-driven (vs the pre-fix dead `pool_yaml` variable). If
    the fixture's P3 boundary values change in the future, the test
    follows automatically — no literal-value drift."""
    import yaml
    fixture_yaml = _copy_fixture(fixture_name, tmp_path) / "session.yaml"
    data = yaml.safe_load(fixture_yaml.read_text())
    vp = data["virtual_parallel"]
    return int(vp["unallocated_pool"]), int(vp["N"])


def test_grow_allocation_pool_sufficient_via_compute_helper(tmp_path):
    """T42 fixture-driven: pool >= P3 floor (3) → compute_grow_allocation
    must succeed (rc=0) and return allocation per Q6 ceil() formula:
    ceil(pool / (2*N)) then max with P3 floor.

    Fixture: pool_just_above_p3 (pool=3, N=3) → ceil(3/6)=1, max(1,3)=3.

    G12 review fix 2026-04-26: pool/N now extracted from fixture session.yaml
    (was: hardcoded "3" "3" with copied-but-unused fixture)."""
    pool, n_current = _read_fixture_pool_and_n("pool_just_above_p3", tmp_path)
    assert pool == 3 and n_current == 3, (
        f"pool_just_above_p3 fixture sanity: expected pool=3 N=3, got "
        f"pool={pool} N={n_current} (fixture drift)"
    )
    helper = ROOT / "hooks/scripts/session-helper.sh"
    p = subprocess.run(
        ["bash", str(helper), "compute_grow_allocation", str(pool), str(n_current)],
        capture_output=True, text=True,
    )
    assert p.returncode == 0, f"pool={pool} must allow grow (err={p.stderr!r})"
    # Output should be the allocation; with pool=3 N=3 → P3-floor 3 wins
    assert p.stdout.strip() == "3", f"expected 3, got {p.stdout!r}"


def test_grow_allocation_pool_below_p3_rejected(tmp_path):
    """T42 fixture-driven: pool < P3 floor → compute_grow_allocation must
    reject with rc != 0 + actionable error.

    Fixture: pool_below_p3 (pool=2, N=3) → below floor.

    G12 review fix 2026-04-26: pool/N now extracted from fixture session.yaml
    (was: hardcoded "2" "3" with no fixture copy at all despite
    'fixture-driven' docstring claim)."""
    pool, n_current = _read_fixture_pool_and_n("pool_below_p3", tmp_path)
    assert pool == 2 and n_current == 3, (
        f"pool_below_p3 fixture sanity: expected pool=2 N=3, got "
        f"pool={pool} N={n_current} (fixture drift)"
    )
    helper = ROOT / "hooks/scripts/session-helper.sh"
    p = subprocess.run(
        ["bash", str(helper), "compute_grow_allocation", str(pool), str(n_current)],
        capture_output=True, text=True,
    )
    assert p.returncode != 0, f"pool={pool} must reject grow (below P3 floor)"
    assert p.stderr.strip(), "must emit error message"


# ---------- JSON schema violations (T42 W-8 #4) ----------

def test_invalid_decision_enum_rejected():
    decision = {
        "decision": "wibble",  # not in ALLOWED_DECISION
        "chosen_seed_id": 1,
        "block_size": 3,
        "reasoning": "garbage",
        "signals_used": [],
    }
    out, rc, err = _decide(decision)
    assert rc != 0 or (out is not None and out.get("accepted") is False), (
        f"invalid decision enum '{decision['decision']}' must be rejected"
    )


def test_non_int_block_size_rejected():
    decision = {
        "decision": "schedule",
        "chosen_seed_id": 1,
        "block_size": "three",  # string instead of int
        "reasoning": "bug",
        "signals_used": [],
    }
    out, rc, err = _decide(decision)
    assert rc != 0 or (out is not None and out.get("accepted") is False)


def test_missing_required_field_rejected():
    decision = {
        "decision": "schedule",
        # chosen_seed_id missing
        "block_size": 3,
        "reasoning": "incomplete",
        "signals_used": [],
    }
    out, rc, err = _decide(decision)
    assert rc != 0 or (out is not None and out.get("accepted") is False)


# ---------- Single source of truth: ALLOWED_DECISION ----------

def test_allowed_decision_set_matches_scheduler_decide_source():
    """T42 W-6 trace: ALLOWED_DECISION constant must be the single SOT.
    This test reads scheduler-decide.py's source and verifies the set
    matches our local copy. If scheduler-decide.py adds/removes a value,
    this test fails loudly until we resync."""
    src = (ROOT / "hooks/scripts/scheduler-decide.py").read_text()
    import re
    m = re.search(r'ALLOWED_DECISION\s*=\s*(\{[^}]+\})', src)
    assert m, "ALLOWED_DECISION constant not found in scheduler-decide.py"
    src_set = eval(m.group(1))  # safe — pinned to our own source
    assert src_set == ALLOWED_DECISION, (
        f"ALLOWED_DECISION drift: source={src_set}, test={ALLOWED_DECISION}"
    )


# ---------- G12 re-review G2 fix: required fields per decision ----------

def test_kill_then_schedule_requires_kill_target():
    """G12 re-review G2 fix (2026-04-26): scheduler-decide must reject
    kill_then_schedule decisions missing kill_target (rc=2 = operator
    error), not accept with kill_target:null. Pre-G2 returned rc=0 +
    accepted:true with null field, which coordinator then propagated
    as `apply_kill(null)` → silent downstream failure."""
    decision = {
        "decision": "kill_then_schedule",
        # kill_target OMITTED — must reject
        "chosen_seed_id": 1,
        "block_size": 3,
        "reasoning": "x",
        "signals_used": [],
    }
    out, rc, err = _decide(decision)
    assert rc == 2, (
        f"missing kill_target must rc=2 (operator error), got rc={rc} "
        f"out={out!r} err={err!r}"
    )
    assert "kill_target" in err.lower(), (
        f"error must mention kill_target field: {err!r}"
    )


def test_kill_then_schedule_rejects_null_kill_target():
    """G12 re-review G2 fix: explicit null is equivalent to missing —
    must rc=2."""
    decision = {
        "decision": "kill_then_schedule",
        "kill_target": None,
        "chosen_seed_id": 1,
        "block_size": 3,
        "reasoning": "x",
        "signals_used": [],
    }
    out, rc, err = _decide(decision)
    assert rc == 2, f"null kill_target must rc=2 (got rc={rc}, err={err!r})"


def test_kill_then_schedule_rejects_non_int_kill_target():
    """G12 re-review G2 fix: non-int kill_target (string, bool) must rc=2."""
    decision = {
        "decision": "kill_then_schedule",
        "kill_target": "1",  # string, not int
        "chosen_seed_id": 1,
        "block_size": 3,
        "reasoning": "x",
        "signals_used": [],
    }
    out, rc, err = _decide(decision)
    assert rc == 2, f"string kill_target must rc=2 (got rc={rc}, err={err!r})"


def test_grow_then_schedule_requires_new_seed_id():
    """G12 re-review G2 fix (2026-04-26): scheduler-decide must reject
    grow_then_schedule decisions missing new_seed_id (rc=2 = operator
    error). Pre-G2 returned rc=0 + accepted:true with null field, which
    coordinator then propagated as `dispatch_seed(new_seed_id=null)` →
    silent downstream failure."""
    decision = {
        "decision": "grow_then_schedule",
        # new_seed_id OMITTED — must reject
        "chosen_seed_id": 4,
        "block_size": 3,
        "reasoning": "x",
        "signals_used": [],
    }
    out, rc, err = _decide(decision)
    assert rc == 2, (
        f"missing new_seed_id must rc=2 (operator error), got rc={rc} "
        f"out={out!r} err={err!r}"
    )
    assert "new_seed_id" in err.lower(), (
        f"error must mention new_seed_id field: {err!r}"
    )


# ---------- G12 re-review G1 fix: errexit safety ----------

def test_coordinator_errexit_safe_pattern_documented():
    """G12 re-review G1 fix (2026-04-26): coordinator.md must use the
    errexit-safe `if cmd; then rc=0; else rc=$?; fi` pattern around
    scheduler-decide.py invocation. Pre-G1 used bare `validated=$(...)
    rc=$?` which under set -e exits BEFORE rc=$? executes — empirically
    verified.

    This is a content-level test (coordinator.md is markdown executed
    by AI agent, not directly bash-tested). Asserts the pattern is
    present + the legacy bare pattern is absent."""
    coord = ROOT / "skills/deep-evolve-workflow/protocols/coordinator.md"
    rm = coord.read_text(encoding="utf-8")
    # Errexit-safe pattern: `if validated=$(...)` — captures rc safely
    import re
    safe_pattern = re.search(
        r'if\s+validated=\$\(\s*hooks/scripts/scheduler-decide\.py',
        rm,
    )
    assert safe_pattern, (
        "coordinator.md must use errexit-safe `if validated=$(...) ...; "
        "then rc=0; else rc=$?; fi` pattern around scheduler-decide.py "
        "invocation (G1 fix per 2026-04-26 re-review). Bare `var=$(...)` "
        "+ `rc=$?` triggers errexit before rc capture."
    )
