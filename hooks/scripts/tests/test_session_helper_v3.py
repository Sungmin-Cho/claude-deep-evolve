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
