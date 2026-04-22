"""pytest suite for v3 session-helper subcommands."""


def test_entropy_compute_mixed_categories(run_helper, make_journal):
    journal = make_journal([
        ("parameter_tune", 3),
        ("algorithm_swap", 2),
        ("add_guard", 2),
    ])
    result = run_helper("entropy_compute", str(journal))
    # Shannon entropy of distribution {3/7, 2/7, 2/7} ≈ 1.557 bits
    assert 1.3 < result["entropy_bits"] < 1.6
    assert result["active_categories"] == 3


def test_entropy_compute_insufficient_sample(run_helper, make_journal):
    # Only 4 tagged planned events — threshold is < 5
    journal = make_journal([("parameter_tune", 4)])
    result = run_helper("entropy_compute", str(journal))
    assert result.get("reason") == "insufficient_sample"
    assert result.get("entropy_bits") is None


def test_entropy_compute_window_respected(run_helper, make_journal):
    # 25 events total, default window is 20 — last 20 should be 100% algorithm_swap
    journal = make_journal([
        ("parameter_tune", 5),   # oldest 5 (outside window)
        ("algorithm_swap", 20),  # newest 20 (inside window)
    ])
    result = run_helper("entropy_compute", str(journal))
    # Single category within window → entropy = 0, active_categories = 1
    assert result["entropy_bits"] == 0.0
    assert result["active_categories"] == 1


import json


def test_migrate_v2_weights_normalized(run_helper, tmp_path):
    v2 = {
        "parameter_tuning": 0.2,
        "structural_change": 0.4,
        "algorithm_swap": 0.2,
        "simplification": 0.2,
    }
    input_file = tmp_path / "v2.json"
    input_file.write_text(json.dumps(v2))
    result = run_helper("migrate_v2_weights", str(input_file))
    weights = result["weights"]
    assert len(weights) == 10
    assert abs(sum(weights.values()) - 1.0) < 1e-9
    assert abs(weights["parameter_tune"] - 0.2 / 1.20) < 1e-6
    assert abs(weights["refactor_simplify"] - 0.2 / 1.20) < 1e-6
    assert abs(weights["algorithm_swap"] - 0.2 / 1.20) < 1e-6
    assert abs(weights["add_guard"] - (0.4 / 3) / 1.20) < 1e-6
    assert abs(weights["other"] - 0.05 / 1.20) < 1e-6


def test_migrate_v2_weights_pathological_all_structural(run_helper, tmp_path):
    v2 = {"structural_change": 1.0}
    input_file = tmp_path / "v2.json"
    input_file.write_text(json.dumps(v2))
    result = run_helper("migrate_v2_weights", str(input_file))
    weights = result["weights"]
    assert weights["parameter_tune"] == 0.0
    assert weights["refactor_simplify"] == 0.0
    assert weights["algorithm_swap"] == 0.0
    assert abs(weights["add_guard"] - (1.0 / 3) / 1.20) < 1e-6
    assert abs(weights["other"] - 0.05 / 1.20) < 1e-6
    assert abs(sum(weights.values()) - 1.0) < 1e-9
