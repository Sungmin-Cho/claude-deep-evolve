"""Budget allocation helpers for init split and n_adjusted growth."""
import subprocess, os
from pathlib import Path

HELPER = Path(__file__).parents[3] / "hooks/scripts/session-helper.sh"


def run_helper(subcmd, *args):
    cmd = ["bash", str(HELPER), subcmd, *args]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.stdout.strip(), r.stderr, r.returncode


def test_init_budget_split_equal():
    # 50 budget / 5 seeds → 10 each
    out, err, rc = run_helper("compute_init_budget_split", "50", "5")
    assert rc == 0
    assert out == "10 10 10 10 10", f"got {out!r}"


def test_init_budget_split_non_divisible():
    # 50 / 3 = 16 17 17 (remainder goes to last seed deterministically)
    out, err, rc = run_helper("compute_init_budget_split", "50", "3")
    assert rc == 0
    parts = list(map(int, out.split()))
    assert sum(parts) == 50
    assert len(parts) == 3
    assert max(parts) - min(parts) <= 1  # near-equal


def test_init_budget_split_rejects_total_below_p3_floor():
    """S-6 fix: total < N*3 means at least one seed has <3 budget (below P3);
    reject rather than silently create an un-killable seed."""
    # total=6, N=3 → each gets 2, below P3 floor (3). Must reject.
    out, err, rc = run_helper("compute_init_budget_split", "6", "3")
    assert rc == 1, f"must reject total < N*P3_floor; rc={rc}"
    assert "below P3" in (out + err) or "insufficient" in (out + err).lower()


def test_init_budget_split_accepts_total_exactly_n_times_p3():
    """Boundary: total == N*3 gives each seed exactly the P3 floor."""
    out, err, rc = run_helper("compute_init_budget_split", "9", "3")
    assert rc == 0, err
    parts = list(map(int, out.split()))
    assert parts == [3, 3, 3]


def test_grow_allocation_sufficient_pool():
    # pool=20, current_N=3 → ceil(20/6)=4, max(4,3)=4
    out, err, rc = run_helper("compute_grow_allocation", "20", "3")
    assert rc == 0
    assert out == "4", f"got {out!r}"


def test_grow_allocation_below_p3_floor_rejects():
    # pool=5, current_N=9 → ceil(5/18)=1, max(1,3)=3; but pool=5>=3 so allocation=3
    out, err, rc = run_helper("compute_grow_allocation", "5", "9")
    assert rc == 0, f"pool sufficient for P3 floor; got rc={rc}, err={err}"
    assert out == "3"


def test_grow_allocation_pool_insufficient_for_floor():
    # pool=2, current_N=9 → ceil(2/18)=1, max(1,3)=3, but pool=2<3 → reject
    out, err, rc = run_helper("compute_grow_allocation", "2", "9")
    assert rc == 1, "must reject when pool < P3 floor"
    assert "insufficient" in (out + err).lower()
