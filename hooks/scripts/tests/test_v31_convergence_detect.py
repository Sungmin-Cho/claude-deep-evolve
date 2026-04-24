"""convergence-detect.py — 3-class classifier per spec § 7.5.

Classifier inputs (pure function; no git / no LLM inside the script):
  keeps: list of {commit, seed_id, ts, experiments_used_before_keep}
  similarities: list of {commit_a, commit_b, score} (pre-computed AI judgments)
  inspired_by_map: dict commit → parent_source_commit or null
                   (pre-extracted by caller from git log trailers)
  cross_seed_borrow_events: list of forum events (provides alt ancestry path)
  threshold: float, default 0.85
  p3_floor: int, default 3

Output: list of convergence_event dicts, each with seed_ids, cluster_commits,
direction, trigger, judged_as, shared_ancestors, epoch.

Classification rule (spec § 7.5):
  evidence_based:           shared_ancestors empty AND all seeds satisfied P3
                            (experiments_used_before_keep >= p3_floor) before K_i
  borrow_chain_convergence: shared_ancestors non-empty AND all P3 satisfied
  contagion_suspected:      at least one K_i had experiments_used < p3_floor
"""
import json
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).parents[3] / "hooks/scripts/convergence-detect.py"


def _run_ok(payload):
    r = subprocess.run(
        ["python3", str(SCRIPT), "--args", json.dumps(payload)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, f"stderr: {r.stderr}"
    return json.loads(r.stdout)


def _base(**overrides):
    base = {
        "keeps": [],
        "similarities": [],
        "inspired_by_map": {},
        "cross_seed_borrow_events": [],
        "threshold": 0.85,
        "p3_floor": 3,
        "epoch": 2,
    }
    base.update(overrides)
    return base


def test_no_keeps_yields_no_events():
    out = _run_ok(_base())
    assert out["convergence_events"] == []


def test_single_seed_only_yields_no_cluster():
    """Cluster requires ≥2 seeds (spec § 7.5 step 4)."""
    out = _run_ok(_base(
        keeps=[
            {"commit": "a1", "seed_id": 1, "ts": "2026-04-24T10:00:00Z",
             "experiments_used_before_keep": 5, "description": "x", "rationale": "y"},
            {"commit": "a2", "seed_id": 1, "ts": "2026-04-24T10:05:00Z",
             "experiments_used_before_keep": 6, "description": "x", "rationale": "y"},
        ],
        similarities=[{"commit_a": "a1", "commit_b": "a2", "score": 0.95}],
    ))
    assert out["convergence_events"] == []


def test_similarity_below_threshold_no_cluster():
    out = _run_ok(_base(
        keeps=[
            {"commit": "a", "seed_id": 1, "ts": "t1",
             "experiments_used_before_keep": 5, "description": "x", "rationale": "y"},
            {"commit": "b", "seed_id": 2, "ts": "t2",
             "experiments_used_before_keep": 5, "description": "x", "rationale": "y"},
        ],
        similarities=[{"commit_a": "a", "commit_b": "b", "score": 0.80}],
    ))
    assert out["convergence_events"] == []


def test_evidence_based_classification():
    """2 seeds, high similarity, no shared ancestor, both clear P3."""
    out = _run_ok(_base(
        keeps=[
            {"commit": "a", "seed_id": 1, "ts": "t1",
             "experiments_used_before_keep": 5,
             "description": "moving average feature", "rationale": "smooths noise"},
            {"commit": "b", "seed_id": 2, "ts": "t2",
             "experiments_used_before_keep": 4,
             "description": "moving average filter", "rationale": "reduces variance"},
        ],
        similarities=[{"commit_a": "a", "commit_b": "b", "score": 0.92}],
    ))
    assert len(out["convergence_events"]) == 1
    ev = out["convergence_events"][0]
    assert ev["event"] == "convergence_event"
    assert sorted(ev["seed_ids"]) == [1, 2]
    assert ev["judged_as"] == "evidence_based"
    assert ev["shared_ancestors"] == []
    assert ev["epoch"] == 2


def test_borrow_chain_convergence_via_inspired_by_trailer():
    """Same idea but one commit derived from the other via `inspired_by`."""
    out = _run_ok(_base(
        keeps=[
            {"commit": "src", "seed_id": 1, "ts": "t1",
             "experiments_used_before_keep": 5,
             "description": "feature X", "rationale": "r1"},
            {"commit": "borrow", "seed_id": 2, "ts": "t2",
             "experiments_used_before_keep": 4,
             "description": "feature X adapted", "rationale": "r2"},
        ],
        similarities=[{"commit_a": "src", "commit_b": "borrow", "score": 0.90}],
        inspired_by_map={"borrow": "src"},
    ))
    ev = out["convergence_events"][0]
    assert ev["judged_as"] == "borrow_chain_convergence"
    assert "src" in ev["shared_ancestors"]


def test_borrow_chain_convergence_via_cross_seed_borrow_event():
    """Ancestry also traces through forum cross_seed_borrow when no commit trailer available."""
    out = _run_ok(_base(
        keeps=[
            {"commit": "src", "seed_id": 1, "ts": "t1",
             "experiments_used_before_keep": 5,
             "description": "feature Y", "rationale": "r1"},
            {"commit": "borrow", "seed_id": 2, "ts": "t2",
             "experiments_used_before_keep": 5,
             "description": "feature Y adapted", "rationale": "r2"},
        ],
        similarities=[{"commit_a": "src", "commit_b": "borrow", "score": 0.88}],
        cross_seed_borrow_events=[
            {"event": "cross_seed_borrow", "from_seed": 1, "to_seed": 2,
             "source_commit": "src", "target_commit": "borrow"},
        ],
    ))
    ev = out["convergence_events"][0]
    assert ev["judged_as"] == "borrow_chain_convergence"
    assert "src" in ev["shared_ancestors"]


def test_contagion_suspected_when_p3_floor_violated():
    """One seed kept before its 3rd experiment — P3 floor bypassed."""
    out = _run_ok(_base(
        keeps=[
            {"commit": "a", "seed_id": 1, "ts": "t1",
             "experiments_used_before_keep": 5,
             "description": "x", "rationale": "y"},
            {"commit": "b", "seed_id": 2, "ts": "t2",
             "experiments_used_before_keep": 2,
             "description": "x", "rationale": "y"},
        ],
        similarities=[{"commit_a": "a", "commit_b": "b", "score": 0.90}],
    ))
    ev = out["convergence_events"][0]
    assert ev["judged_as"] == "contagion_suspected"


def test_union_find_merges_transitive_clusters():
    """Three seeds, pair-wise similarities all ≥ threshold in a chain."""
    out = _run_ok(_base(
        keeps=[
            {"commit": "a", "seed_id": 1, "ts": "t1",
             "experiments_used_before_keep": 5, "description": "x", "rationale": "y"},
            {"commit": "b", "seed_id": 2, "ts": "t2",
             "experiments_used_before_keep": 5, "description": "x", "rationale": "y"},
            {"commit": "c", "seed_id": 3, "ts": "t3",
             "experiments_used_before_keep": 5, "description": "x", "rationale": "y"},
        ],
        similarities=[
            {"commit_a": "a", "commit_b": "b", "score": 0.90},
            {"commit_a": "b", "commit_b": "c", "score": 0.88},
        ],
    ))
    ev = out["convergence_events"][0]
    assert sorted(ev["seed_ids"]) == [1, 2, 3]


def test_schema_error_missing_keeps_rc_2():
    r = subprocess.run(
        ["python3", str(SCRIPT), "--args",
         json.dumps({"similarities": [], "inspired_by_map": {},
                     "cross_seed_borrow_events": []})],
        capture_output=True, text=True,
    )
    assert r.returncode == 2
    assert "error:" in r.stderr


def test_p3_floor_boundary_inclusive():
    """Spec § 7.5: 'experiments_used >= p3_floor' is inclusive."""
    out = _run_ok(_base(
        keeps=[
            {"commit": "a", "seed_id": 1, "ts": "t1",
             "experiments_used_before_keep": 3,
             "description": "x", "rationale": "y"},
            {"commit": "b", "seed_id": 2, "ts": "t2",
             "experiments_used_before_keep": 3,
             "description": "x", "rationale": "y"},
        ],
        similarities=[{"commit_a": "a", "commit_b": "b", "score": 0.90}],
    ))
    assert out["convergence_events"][0]["judged_as"] == "evidence_based"


def test_mixed_p3_cluster_classifies_as_contagion():
    """3-seed cluster with 2 above floor and 1 below — whole cluster demoted."""
    out = _run_ok(_base(
        keeps=[
            {"commit": "a", "seed_id": 1, "ts": "t1",
             "experiments_used_before_keep": 5,
             "description": "x", "rationale": "y"},
            {"commit": "b", "seed_id": 2, "ts": "t2",
             "experiments_used_before_keep": 4,
             "description": "x", "rationale": "y"},
            {"commit": "c", "seed_id": 3, "ts": "t3",
             "experiments_used_before_keep": 2,
             "description": "x", "rationale": "y"},
        ],
        similarities=[
            {"commit_a": "a", "commit_b": "b", "score": 0.90},
            {"commit_a": "b", "commit_b": "c", "score": 0.90},
        ],
    ))
    assert out["convergence_events"][0]["judged_as"] == "contagion_suspected"


def test_bool_threshold_rejected():
    """W-2 fix: bool excluded from numeric fields (Python bool subclasses int)."""
    r = subprocess.run(
        ["python3", str(SCRIPT), "--args",
         json.dumps({"keeps": [], "similarities": [], "inspired_by_map": {},
                     "cross_seed_borrow_events": [], "threshold": True})],
        capture_output=True, text=True,
    )
    assert r.returncode == 2
    assert "bool" in r.stderr.lower() or "number" in r.stderr.lower()
