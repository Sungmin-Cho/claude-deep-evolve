"""Regression guard for the Outer Loop stagnation `consecutive_no_improve`
computation (outer-loop.md Step 6.5.6).

The stagnation snippet embedded in outer-loop.md reads `q_history` from
session.yaml and counts how many recent generations have failed to beat the
best Q. A P0 bug read `q_history` from the **top level** of session.yaml, but
the real schema nests it under `outer_loop` (init.md, SKILL.md, and Step 6.5.2
of outer-loop.md all write `session.yaml.outer_loop.q_history`) with each
element a `{generation, Q, epoch}` dict. The buggy read therefore always
returned `[]`, pinning `consecutive_no_improve` at 0 so stagnation detection
(and the strategy fork / Tier 3 auto-expansion gated on it) could never fire.

To keep the test in lock-step with the doc, we EXTRACT the actual python block
from outer-loop.md (rather than copy it) and execute it against fixture
session.yaml files. If the doc drifts back to the buggy form these tests fail.
"""
import re
import subprocess
import sys
from pathlib import Path

import yaml

OUTER_LOOP = Path(__file__).parents[3] / "skills/deep-evolve-workflow/protocols/outer-loop.md"

# Matches:  consecutive_no_improve=$(python3 -c "
#             <python body>
#           ")
_BLOCK_RE = re.compile(
    r'consecutive_no_improve=\$\(python3 -c "\n(?P<body>.*?)\n"\)',
    re.DOTALL,
)


def _extract_block() -> str:
    """Return the raw python body of the stagnation snippet from outer-loop.md."""
    m = _BLOCK_RE.search(OUTER_LOOP.read_text(encoding="utf-8"))
    assert m, (
        "could not locate the `consecutive_no_improve=$(python3 -c \"...\")` "
        "block in outer-loop.md — the extraction anchor drifted"
    )
    return m.group("body")


def _run_block(session_dir: Path) -> int:
    """Execute the extracted block against a session.yaml under session_dir.

    The doc block hard-codes `open('$SESSION_ROOT/session.yaml')`; we substitute
    the shell var with the fixture directory, matching how the coordinator
    expands it at runtime.
    """
    code = _extract_block().replace("$SESSION_ROOT", str(session_dir))
    cp = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True, text=True, check=False,
    )
    assert cp.returncode == 0, (
        f"stagnation block raised: rc={cp.returncode}\n"
        f"stdout: {cp.stdout}\nstderr: {cp.stderr}"
    )
    return int(cp.stdout.strip())


def _write_session(tmp_path: Path, q_values, *, extra_top_level=None) -> Path:
    """Write a session.yaml whose outer_loop.q_history holds {generation,Q,epoch}
    dicts for the given Q values. `extra_top_level` lets a test also plant a
    (bogus) top-level `q_history` to prove the reader ignores it."""
    content = {
        "session_id": "stagnation-fixture",
        "deep_evolve_version": "3.1.0",
        "outer_loop": {
            "generation": len(q_values),
            "q_history": [
                {"generation": i + 1, "Q": q, "epoch": 1}
                for i, q in enumerate(q_values)
            ],
        },
    }
    if extra_top_level is not None:
        content["q_history"] = extra_top_level
    path = tmp_path / "session.yaml"
    path.write_text(yaml.safe_dump(content))
    return path


# ---------- doc/test drift anchors ----------

def test_block_reads_nested_outer_loop_q_history():
    """The extracted block must read the NESTED path and project the Q floats."""
    body = _extract_block()
    assert "(d.get('outer_loop') or {}).get('q_history'" in body, (
        "stagnation block no longer reads the nested outer_loop.q_history path"
    )
    # The buggy top-level read must not reappear.
    assert "d.get('q_history'" not in body, (
        "stagnation block reads a TOP-LEVEL q_history — regression to the P0 bug"
    )
    assert "e['Q']" in body, (
        "stagnation block must project Q out of each {generation,Q,epoch} dict"
    )


# ---------- behavioural regression ----------

def test_stagnation_fires_after_three_no_improve(tmp_path):
    """Best Q at gen 1, then three strictly-lower generations → count == 3,
    which meets the >= 3 stagnation threshold. Under the old top-level bug this
    was pinned at 0 and stagnation never fired."""
    _write_session(tmp_path, [0.80, 0.50, 0.40, 0.30])
    assert _run_block(tmp_path) == 3


def test_partial_no_improve_counts_from_last_best(tmp_path):
    """Best is mid-history (0.70); two later generations underperform → 2."""
    _write_session(tmp_path, [0.50, 0.70, 0.60, 0.55])
    assert _run_block(tmp_path) == 2


def test_monotonic_improvement_is_not_stagnation(tmp_path):
    """Strictly increasing Q → most-recent is the best → count == 0."""
    _write_session(tmp_path, [0.30, 0.50, 0.70])
    assert _run_block(tmp_path) == 0


def test_empty_history_is_zero(tmp_path):
    """No generations recorded yet → count == 0 (no crash on empty list)."""
    _write_session(tmp_path, [])
    assert _run_block(tmp_path) == 0


def test_nested_read_ignores_bogus_top_level_q_history(tmp_path):
    """Even with a (buggy-path) top-level q_history present, the reader must use
    the nested list. Old code would read the top-level [] and return 0; the fix
    reads the real nested stagnation data and returns 3."""
    _write_session(tmp_path, [0.80, 0.50, 0.40, 0.30], extra_top_level=[])
    assert _run_block(tmp_path) == 3
