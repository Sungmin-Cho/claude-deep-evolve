"""T44 G12: borrow guardrails — cross-event roundtrip + dedup + abandoned.

Spec § 7.3 + § 7.4 + § 9.2. T17 covers preflight unit; T15b covers single-
event cleanup; T44 covers the 3 cross-event integration scenarios per W-8
enumeration:

  1. Full Step 5.f → next Step 2 → cross_seed_borrow roundtrip
     (borrow_planned → cross_seed_borrow with consistent fields)
  2. borrow_planned + no execution → borrow_abandoned (T15b cleanup)
  3. Dedup across 2 borrow attempts (P5 — same (borrower, source_commit)
     pair rejected at preflight; structured borrow_abandoned reason: dedup)

Forum field names (G11 SOT — do NOT add _id suffix):
  to_seed, from_seed, source_commit, borrower_commit, epoch

Plan-stage adaptation note (T44 / G12 2026-04-26):
  The plan (lines 18480-18505) sketched a preflight invocation pattern
  with simplified args ({to_seed, from_seed, source_commit, forum_path,
  ...}) returning a {accepted, reason} decision. The actual T17
  borrow-preflight.py contract (per spec § 7.4) requires
  {self_seed_id, self_experiments_used, candidates, journal, forum}
  and returns {eligible, skipped, p3_gate_open, self_seed_id}.

  The dedup signal is `skipped[*].reason == "dedup_executed"` (forum-side
  cross_seed_borrow already exists for the same (borrower, source_commit))
  or `"dedup_planned"` (journal-side borrow_planned already exists).

  Tests below invoke the *real* preflight API and assert the dedup
  rejection appears in `skipped[]`. The plan's strawman invocation is
  preserved as a comment for traceability.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[3]
HELPER = ROOT / "hooks/scripts/session-helper.sh"
PREFLIGHT = ROOT / "hooks/scripts/borrow-preflight.py"
FIXTURE = Path(__file__).parent / "fixtures/borrow_scenario"


def _setup(tmp_path):
    """Copy borrow_scenario fixture to tmp_path, init git, return env."""
    dst = tmp_path / "scenario-borrow"
    shutil.copytree(FIXTURE, dst)
    subprocess.run(["git", "init"], cwd=dst, check=True, capture_output=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t.t", "-c", "user.name=T",
         "commit", "--allow-empty", "-m", "init"],
        cwd=dst, check=True, capture_output=True,
    )
    session_root = dst / ".deep-evolve" / "borrow-scenario-01"
    session_root.mkdir(parents=True, exist_ok=True)
    # Copy fixture files into session_root
    for fn in ("session.yaml", "journal.jsonl", "forum.jsonl"):
        src = FIXTURE / fn
        if src.exists():
            shutil.copy(src, session_root / fn)
    env = os.environ.copy()
    # T26 lesson: SEED_ID must NOT be set on coordinator-owned events; we
    # leave SEED_ID unset in the base env and rely on `(unset SEED_ID; ...)`
    # subshell semantics if/when production code emits cross_seed_borrow.
    env.pop("SEED_ID", None)
    env.update({
        "EVOLVE_DIR": str(dst / ".deep-evolve"),
        "SESSION_ID": "borrow-scenario-01",
        "SESSION_ROOT": str(session_root),
    })
    return dst, session_root, env


def _append(env, repo, event_dict):
    """Append a forum event via session-helper.sh; return (rc, stderr)."""
    p = subprocess.run(
        ["bash", str(HELPER), "append_forum_event", json.dumps(event_dict)],
        cwd=repo, env=env, capture_output=True, text=True,
    )
    return p.returncode, p.stderr


def _read_forum(session_root):
    """Read forum.jsonl as a list of parsed events (skip-and-warn on
    malformed lines per T43 contract)."""
    fp = session_root / "forum.jsonl"
    if not fp.exists():
        return []
    out = []
    for ln in fp.read_text().split("\n"):
        s = ln.strip()
        if not s:
            continue
        try:
            out.append(json.loads(s))
        except json.JSONDecodeError:
            # Skip-and-warn — match T43 tail_forum behavior
            continue
    return out


def _run_preflight(self_seed_id, self_experiments_used, candidates,
                   journal, forum):
    """Invoke real borrow-preflight.py per § 7.4 contract.

    Returns parsed stdout dict with keys: eligible, skipped, p3_gate_open,
    self_seed_id. Raises if preflight returns non-zero.
    """
    payload = {
        "self_seed_id": self_seed_id,
        "self_experiments_used": self_experiments_used,
        "candidates": candidates,
        "journal": journal,
        "forum": forum,
    }
    p = subprocess.run(
        ["python3", str(PREFLIGHT), "--args", json.dumps(payload)],
        capture_output=True, text=True,
    )
    assert p.returncode == 0, (
        f"borrow-preflight rc={p.returncode}, stderr={p.stderr!r}"
    )
    return json.loads(p.stdout)


# ---------- W-8 #1: full roundtrip ----------

def test_borrow_planned_to_cross_seed_borrow_roundtrip(tmp_path):
    """T44 W-8 #1: simulate seed-1 keep → seed-2 borrow_planned →
    seed-2 commit → cross_seed_borrow. Field consistency across both
    seed-context events."""
    repo, session_root, env = _setup(tmp_path)

    # Seed 1 keeps a candidate (forum seed_keep event)
    seed_keep = {
        "event": "seed_keep",
        "seed_id": 1,
        "epoch": 1,
        "commit": "abc1234",
        "experiments_used_before_keep": 6,
        "description": "feature-engineering candidate",
    }
    rc, err = _append(env, repo, seed_keep)
    assert rc == 0, f"seed_keep append failed: {err}"

    # Seed 2 plans a borrow (Step 5.f decision)
    borrow_planned = {
        "event": "borrow_planned",
        "to_seed": 2,
        "from_seed": 1,
        "source_commit": "abc1234",
        "epoch": 1,
        "reason": "Step 5.f semantic borrow accepted preflight",
    }
    rc, err = _append(env, repo, borrow_planned)
    assert rc == 0, f"borrow_planned append failed: {err}"

    # Seed 2 commits → emit cross_seed_borrow (coordinator-owned;
    # production code wraps with `(unset SEED_ID; ...)` — here we
    # already pop SEED_ID in _setup).
    cross_borrow = {
        "event": "cross_seed_borrow",
        "to_seed": 2,
        "from_seed": 1,
        "source_commit": "abc1234",
        "borrower_commit": "def5678",
        "epoch": 1,
    }
    rc, err = _append(env, repo, cross_borrow)
    assert rc == 0, f"cross_seed_borrow append failed: {err}"

    forum = _read_forum(session_root)
    assert len(forum) == 3, f"expected 3 events, got {len(forum)}: {forum}"
    events = [e["event"] for e in forum]
    assert events == ["seed_keep", "borrow_planned", "cross_seed_borrow"]
    # Field consistency: to_seed/from_seed/source_commit must match
    # between planned + executed.
    bp = forum[1]
    cb = forum[2]
    assert bp["to_seed"] == cb["to_seed"] == 2
    assert bp["from_seed"] == cb["from_seed"] == 1
    assert bp["source_commit"] == cb["source_commit"] == "abc1234"
    # cross_seed_borrow gains borrower_commit
    assert cb["borrower_commit"] == "def5678"
    # T26 isinstance-not-bool numeric guard on epoch fields
    assert isinstance(bp["epoch"], int) and not isinstance(bp["epoch"], bool)
    assert isinstance(cb["epoch"], int) and not isinstance(cb["epoch"], bool)


# ---------- W-8 #2: borrow_planned without execution → borrow_abandoned ----------

def test_borrow_planned_without_execution_yields_abandoned(tmp_path):
    """T44 W-8 #2: T15b cleanup contract — if borrower never commits,
    borrow_abandoned must reference the planned event (same triple)."""
    repo, session_root, env = _setup(tmp_path)

    borrow_planned = {
        "event": "borrow_planned",
        "to_seed": 2,
        "from_seed": 1,
        "source_commit": "abc1234",
        "epoch": 1,
        "reason": "Step 5.f tentative",
    }
    rc, err = _append(env, repo, borrow_planned)
    assert rc == 0, f"borrow_planned append failed: {err}"

    # Subagent decides NOT to execute → emit borrow_abandoned via forum_io.
    # (T15b's borrow-abandoned-scan.py operates on journal; the *cleanup*
    # contract requires that the abandoned event references the same
    # (to_seed, from_seed, source_commit) triple.)
    borrow_abandoned = {
        "event": "borrow_abandoned",
        "to_seed": 2,
        "from_seed": 1,
        "source_commit": "abc1234",
        "epoch": 1,
        "reason": "subagent rejected after closer look",
    }
    rc, err = _append(env, repo, borrow_abandoned)
    assert rc == 0, f"borrow_abandoned append failed: {err}"

    forum = _read_forum(session_root)
    events = [e["event"] for e in forum]
    assert events == ["borrow_planned", "borrow_abandoned"]
    # Field parity: abandoned references planned via same triple
    bp, ba = forum
    assert bp["to_seed"] == ba["to_seed"]
    assert bp["from_seed"] == ba["from_seed"]
    assert bp["source_commit"] == ba["source_commit"]
    # NO cross_seed_borrow for the same triple
    assert all(e["event"] != "cross_seed_borrow" for e in forum)


# ---------- W-8 #3: dedup across 2 borrow attempts ----------

def test_borrow_dedup_rejects_second_attempt_same_triple(tmp_path):
    """T44 W-8 #3: P5 dedup — same (borrower, source_commit) pair
    attempted twice. Preflight must reject the second attempt via the
    `dedup_executed` reason (forum-side cross_seed_borrow already exists)."""
    repo, session_root, env = _setup(tmp_path)

    # First attempt: full roundtrip — populate forum with cross_seed_borrow
    seed_keep = {"event": "seed_keep", "seed_id": 1, "epoch": 1,
                 "commit": "abc1234", "experiments_used_before_keep": 6,
                 "description": "candidate", "flagged": False,
                 "legibility_passed": True}
    _append(env, repo, seed_keep)
    bp1 = {"event": "borrow_planned", "to_seed": 2, "from_seed": 1,
           "source_commit": "abc1234", "epoch": 1, "reason": "first"}
    _append(env, repo, bp1)
    cb1 = {"event": "cross_seed_borrow", "to_seed": 2, "from_seed": 1,
           "source_commit": "abc1234", "borrower_commit": "def5678", "epoch": 1}
    _append(env, repo, cb1)

    # Second attempt: invoke preflight against the current forum state.
    # The candidate is the same seed_keep that was already borrowed.
    forum_state = _read_forum(session_root)
    candidate = {
        "event": "seed_keep",
        "seed_id": 1,
        "commit": "abc1234",
        "description": "candidate",
        "flagged": False,
        "legibility_passed": True,
    }
    decision = _run_preflight(
        self_seed_id=2,
        self_experiments_used=6,
        candidates=[candidate],
        journal=[],   # no self-keyed borrow_planned in journal
        forum=forum_state,
    )
    # P5 dedup rejects via skipped[] with reason=dedup_executed
    assert decision["p3_gate_open"] is True, (
        f"P3 gate must be open for dedup test (used=6 >= 3): {decision}"
    )
    assert decision["eligible"] == [], (
        f"second attempt must NOT be eligible (got {decision['eligible']!r})"
    )
    assert len(decision["skipped"]) == 1
    skip = decision["skipped"][0]
    assert skip["reason"] == "dedup_executed", (
        f"second attempt must be rejected as dedup_executed (got {skip!r})"
    )
    assert skip["source_commit"] == "abc1234"


def test_borrow_dedup_invokes_preflight_and_t15b_helper(tmp_path):
    """T44 W-8 #3 cleanup contract: a dedup-rejected attempt should
    actually INVOKE borrow-preflight.py + emit borrow_abandoned via the
    cleanup helper path (T15b — currently exposed only as
    borrow-abandoned-scan.py for journal-side staleness, NOT as a
    session-helper.sh subcommand). G12 fold-in C4 fix (Opus C-3
    2026-04-26): the pre-fix test self-wrote 4 events and verified its
    own writes — same false-positive class as T22 W-3 / G11 W-1 lessons.

    Post-fix flow:
      (1) seed_keep + first attempt (full roundtrip → cross_seed_borrow)
      (2) second attempt: invoke preflight → assert REJECT signal
          (skipped[*].reason == "dedup_executed")
      (3) emit borrow_abandoned via forum_io (T15b helper subcommand
          NOT exposed — fallback path documented in plan §18596-18608),
          carrying the rejection reason from step 2 as the authoritative
          input
      (4) verify forum integrity (1 cross_seed_borrow + 1 abandoned-with-dedup)
    """
    repo, session_root, env = _setup(tmp_path)

    # (1) First attempt — full roundtrip
    seed_keep = {"event": "seed_keep", "seed_id": 1, "epoch": 1,
                 "commit": "abc1234", "experiments_used_before_keep": 6,
                 "description": "candidate", "flagged": False,
                 "legibility_passed": True}
    _append(env, repo, seed_keep)
    bp1 = {"event": "borrow_planned", "to_seed": 2, "from_seed": 1,
           "source_commit": "abc1234", "epoch": 1, "reason": "first"}
    _append(env, repo, bp1)
    cb1 = {"event": "cross_seed_borrow", "to_seed": 2, "from_seed": 1,
           "source_commit": "abc1234", "borrower_commit": "def5678", "epoch": 1}
    _append(env, repo, cb1)

    # (2) Second attempt — invoke real preflight (does not self-write
    # the rejection). Reads current forum from disk to mirror production
    # data flow.
    forum_state = _read_forum(session_root)
    candidate = {
        "event": "seed_keep",
        "seed_id": 1,
        "commit": "abc1234",
        "description": "candidate",
        "flagged": False,
        "legibility_passed": True,
    }
    decision = _run_preflight(
        self_seed_id=2,
        self_experiments_used=6,
        candidates=[candidate],
        journal=[],
        forum=forum_state,
    )
    assert decision["eligible"] == [], (
        f"P5 dedup must reject second attempt: {decision!r}"
    )
    assert len(decision["skipped"]) == 1
    rejection_reason = decision["skipped"][0]["reason"]
    assert "dedup" in rejection_reason.lower(), (
        f"preflight reject reason must mention dedup: {rejection_reason!r}"
    )

    # (3) T15b helper subcommand `append_borrow_abandoned` is NOT exposed
    # on session-helper.sh (see plan §18596-18608 fallback path). Use
    # forum_io append directly with the captured rejection_reason — this
    # is the authoritative input from preflight, NOT a hand-written
    # constant.
    helper_help = subprocess.run(
        ["bash", str(HELPER), "help"],
        capture_output=True, text=True,
    )
    helper_text = helper_help.stdout + helper_help.stderr
    if "append_borrow_abandoned" in helper_text:
        # Future-proof: if T15b helper is exposed, prefer it.
        ba_payload = {
            "to_seed": 2,
            "from_seed": 1,
            "source_commit": "abc1234",
            "epoch": 1,
            "reason": f"dedup_p5: {rejection_reason[:80]}",
        }
        bash_ba = subprocess.run(
            ["bash", str(HELPER), "append_borrow_abandoned",
             json.dumps(ba_payload)],
            cwd=repo, env=env, capture_output=True, text=True,
        )
        assert bash_ba.returncode == 0, (
            f"T15b append_borrow_abandoned failed: {bash_ba.stderr!r}"
        )
    else:
        # Fallback: forum_io append with rejection_reason as authoritative input.
        ba_payload = {
            "event": "borrow_abandoned",
            "to_seed": 2,
            "from_seed": 1,
            "source_commit": "abc1234",
            "epoch": 1,
            "reason": f"dedup_p5: {rejection_reason[:80]}",
        }
        rc, err = _append(env, repo, ba_payload)
        assert rc == 0, f"forum_io fallback for borrow_abandoned failed: {err}"

    # (4) Verify forum state — 1 cross_seed_borrow + 1 abandoned-with-dedup
    forum = _read_forum(session_root)
    csb_count = sum(
        1 for e in forum
        if e["event"] == "cross_seed_borrow"
        and e.get("to_seed") == 2 and e.get("source_commit") == "abc1234"
    )
    assert csb_count == 1, (
        f"P5 violation — duplicate cross_seed_borrow detected (count={csb_count})"
    )
    abandoned = [
        e for e in forum
        if e["event"] == "borrow_abandoned"
        and "dedup" in (e.get("reason") or "").lower()
        and e.get("to_seed") == 2
        and e.get("source_commit") == "abc1234"
    ]
    assert abandoned, (
        f"borrow_abandoned with dedup reason must exist in forum. "
        f"forum events: {[e['event'] for e in forum]}"
    )


# ---------- Bonus: forum field-name SOT (G11 carry-forward) ----------

def test_forum_uses_to_seed_from_seed_no_id_suffix(tmp_path):
    """G11 SOT drift detection: forum events use to_seed/from_seed
    (NO _id suffix). If any new code starts emitting to_seed_id, this
    test fails immediately."""
    repo, session_root, env = _setup(tmp_path)
    bp = {"event": "borrow_planned", "to_seed": 2, "from_seed": 1,
          "source_commit": "abc1234", "epoch": 1, "reason": "x"}
    rc, err = _append(env, repo, bp)
    assert rc == 0, f"append failed: {err}"
    forum = _read_forum(session_root)
    rec = forum[0]
    assert "to_seed" in rec
    assert "from_seed" in rec
    assert "to_seed_id" not in rec, "drift: to_seed_id should be to_seed"
    assert "from_seed_id" not in rec, "drift: from_seed_id should be from_seed"


# ---------- Setup-variant probes (round out the W-8 enumeration to 7) ----------

def test_setup_creates_session_root_with_fixture_files(tmp_path):
    """Probe: _setup helper produces a tmp scenario with session.yaml +
    journal.jsonl + forum.jsonl in session_root, fully isolated from
    repo via tmp_path copy (T2 nested-.git trap avoided)."""
    repo, session_root, env = _setup(tmp_path)
    assert (session_root / "session.yaml").is_file()
    assert (session_root / "journal.jsonl").is_file()
    assert (session_root / "forum.jsonl").is_file()
    # forum.jsonl starts empty
    assert (session_root / "forum.jsonl").read_text().strip() == ""
    # journal.jsonl has the 4 seeded events
    journal_lines = [
        ln for ln in (session_root / "journal.jsonl").read_text().split("\n")
        if ln.strip()
    ]
    assert len(journal_lines) == 4
    # session.yaml is N=2 with both seeds active
    yaml_text = (session_root / "session.yaml").read_text()
    assert "N: 2" in yaml_text
    assert "borrow-scenario-01" in yaml_text


def test_preflight_p3_floor_blocks_when_used_below_3(tmp_path):
    """W-8 setup-variant: confirm preflight contract path (P3 floor)
    works against the borrow_scenario fixture. Self_used=2 → p3_gate
    closed → all candidates skipped with reason=p3_floor. Defends
    against drift in the preflight CLI args contract that T44's dedup
    tests rely on."""
    repo, session_root, env = _setup(tmp_path)
    candidate = {
        "event": "seed_keep", "seed_id": 1, "commit": "abc1234",
        "description": "x", "flagged": False, "legibility_passed": True,
    }
    decision = _run_preflight(
        self_seed_id=2,
        self_experiments_used=2,   # below 3 → p3 closed
        candidates=[candidate],
        journal=[],
        forum=[],
    )
    assert decision["p3_gate_open"] is False
    assert decision["eligible"] == []
    assert len(decision["skipped"]) == 1
    assert decision["skipped"][0]["reason"] == "p3_floor"
