"""borrow-preflight.py — P1–P5 enforcement before the AI borrow prompt (§ 7.4).

Contract (C-2 fix: journal AND forum separately per spec § 7.1):
  Input (all via --args JSON):
    self_seed_id: int
    self_experiments_used: int
    candidates: list of forum `seed_keep` events from OTHER seeds
    journal:    list of journal events (scanned for self-keyed
                `borrow_planned` → `dedup_planned`)
    forum:      list of forum events (scanned for self-`to_seed`
                `cross_seed_borrow` → `dedup_executed`)
  Output (stdout JSON):
    {"eligible": [...], "skipped": [{"source_commit":..., "reason":...}, ...],
     "p3_gate_open": bool, "self_seed_id": int}
  Exit codes:
    0 — success (even if eligible is empty; p3_gate_open may be false)
    2 — operator/schema error (malformed JSON, missing required fields)
"""
import json
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).parents[3] / "hooks/scripts/borrow-preflight.py"


def _run(args):
    r = subprocess.run(
        ["python3", str(SCRIPT), "--args", json.dumps(args)],
        capture_output=True, text=True,
    )
    return r


def _ok(args):
    r = _run(args)
    assert r.returncode == 0, f"stderr: {r.stderr}"
    return json.loads(r.stdout)


def _base_payload(**overrides):
    base = {
        "self_seed_id": 2,
        "self_experiments_used": 5,
        "candidates": [],
        "journal": [],
        "forum": [],
    }
    base.update(overrides)
    return base


def test_p3_floor_blocks_borrow_under_3_experiments():
    out = _ok(_base_payload(
        self_experiments_used=2,
        candidates=[{"event": "seed_keep", "seed_id": 1, "commit": "abc",
                     "description": "feature A", "flagged": False,
                     "legibility_passed": True}],
    ))
    assert out["p3_gate_open"] is False
    assert out["eligible"] == []
    assert len(out["skipped"]) == 1
    assert out["skipped"][0]["reason"] == "p3_floor"


def test_p2_flagged_candidate_filtered():
    out = _ok(_base_payload(
        candidates=[{"event": "seed_keep", "seed_id": 1, "commit": "abc",
                     "description": "shortcut suspect", "flagged": True,
                     "legibility_passed": True}],
    ))
    assert out["p3_gate_open"] is True
    assert out["eligible"] == []
    assert out["skipped"][0]["reason"] == "p2_flagged"


def test_p2_legibility_failed_filtered():
    out = _ok(_base_payload(
        candidates=[{"event": "seed_keep", "seed_id": 1, "commit": "abc",
                     "description": "no rationale",
                     "flagged": False, "legibility_passed": False}],
    ))
    assert out["eligible"] == []
    assert out["skipped"][0]["reason"] == "p2_legibility"


def test_dedup_skips_prior_borrow_planned_for_same_source():
    """`borrow_planned` is journal-side."""
    out = _ok(_base_payload(
        candidates=[{"event": "seed_keep", "seed_id": 1, "commit": "abc",
                     "description": "x", "flagged": False, "legibility_passed": True}],
        journal=[{"event": "borrow_planned", "seed_id": 2, "source_commit": "abc",
                  "plan_rationale": "...", "planned_for_experiment_id": 4,
                  "block_id": 3}],
    ))
    assert out["eligible"] == []
    assert out["skipped"][0]["reason"] == "dedup_planned"


def test_dedup_skips_prior_cross_seed_borrow_in_forum():
    """C-2 fix: cross_seed_borrow is forum-side (spec § 7.1)."""
    out = _ok(_base_payload(
        candidates=[{"event": "seed_keep", "seed_id": 1, "commit": "abc",
                     "description": "x", "flagged": False, "legibility_passed": True}],
        forum=[{"event": "cross_seed_borrow", "from_seed": 1, "to_seed": 2,
                "source_commit": "abc", "target_commit": "def", "block_id": 4}],
    ))
    assert out["eligible"] == []
    assert out["skipped"][0]["reason"] == "dedup_executed"


def test_cross_seed_borrow_in_journal_does_NOT_dedup():
    """Regression guard for C-2: misplaced event in journal must be ignored."""
    out = _ok(_base_payload(
        candidates=[{"event": "seed_keep", "seed_id": 1, "commit": "abc",
                     "description": "x", "flagged": False, "legibility_passed": True}],
        journal=[{"event": "cross_seed_borrow", "from_seed": 1, "to_seed": 2,
                  "source_commit": "abc", "target_commit": "def", "block_id": 4}],
        forum=[],
    ))
    assert len(out["eligible"]) == 1


def test_eligible_candidates_pass_through():
    out = _ok(_base_payload(
        candidates=[
            {"event": "seed_keep", "seed_id": 1, "commit": "abc",
             "description": "strong signal", "flagged": False,
             "legibility_passed": True},
            {"event": "seed_keep", "seed_id": 3, "commit": "def",
             "description": "complementary idea", "flagged": False,
             "legibility_passed": True},
        ],
    ))
    assert out["p3_gate_open"] is True
    assert len(out["eligible"]) == 2
    assert {c["commit"] for c in out["eligible"]} == {"abc", "def"}
    assert out["skipped"] == []


def test_invalid_json_returns_rc_2():
    r = subprocess.run(
        ["python3", str(SCRIPT), "--args", "not-json"],
        capture_output=True, text=True,
    )
    assert r.returncode == 2
    assert "error:" in r.stderr


def test_missing_required_field_returns_rc_2():
    r = subprocess.run(
        ["python3", str(SCRIPT), "--args", json.dumps({"self_seed_id": 1})],
        capture_output=True, text=True,
    )
    assert r.returncode == 2


def test_missing_forum_field_specifically_returns_rc_2():
    r = subprocess.run(
        ["python3", str(SCRIPT), "--args",
         json.dumps({"self_seed_id": 2, "self_experiments_used": 5,
                     "candidates": [], "journal": []})],
        capture_output=True, text=True,
    )
    assert r.returncode == 2


def test_cross_seed_borrow_for_different_borrower_does_not_dedup():
    """I-3: dedup is per-(borrower, source_commit)."""
    out = _ok(_base_payload(
        candidates=[{"event": "seed_keep", "seed_id": 1, "commit": "abc",
                     "description": "x", "flagged": False, "legibility_passed": True}],
        forum=[{"event": "cross_seed_borrow", "from_seed": 1, "to_seed": 3,
                "source_commit": "abc", "target_commit": "xyz", "block_id": 4}],
    ))
    assert len(out["eligible"]) == 1
    assert out["eligible"][0]["commit"] == "abc"


# ──── W-4 edge cases ─────────────────────────────

def test_empty_candidates_returns_empty_eligible_rc_0():
    out = _ok(_base_payload(candidates=[]))
    assert out["p3_gate_open"] is True
    assert out["eligible"] == []
    assert out["skipped"] == []


def test_self_borrow_paranoid_guard_fires():
    out = _ok(_base_payload(
        candidates=[{"event": "seed_keep", "seed_id": 2, "commit": "abc",
                     "description": "x", "flagged": False, "legibility_passed": True}],
    ))
    assert out["eligible"] == []
    assert out["skipped"][0]["reason"] == "self_seed"


def test_candidate_missing_commit_field_rejected():
    out = _ok(_base_payload(
        candidates=[{"event": "seed_keep", "seed_id": 1,
                     "description": "x", "flagged": False, "legibility_passed": True}],
    ))
    assert out["eligible"] == []
    assert out["skipped"][0]["reason"] == "missing_source_commit"


def test_malformed_journal_entry_skipped_gracefully():
    out = _ok(_base_payload(
        candidates=[{"event": "seed_keep", "seed_id": 1, "commit": "abc",
                     "description": "x", "flagged": False, "legibility_passed": True}],
        journal=[
            {},
            {"event": "borrow_planned"},
            {"event": "borrow_planned", "seed_id": 99, "source_commit": None},
            {"event": "borrow_planned", "seed_id": 2, "source_commit": "xyz"},
        ],
    ))
    assert len(out["eligible"]) == 1
    assert out["eligible"][0]["commit"] == "abc"
