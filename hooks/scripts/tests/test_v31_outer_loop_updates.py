"""v3.1 Outer Loop protocol extensions — normative content assertions.

Parses skills/deep-evolve-workflow/protocols/outer-loop.md and asserts that
v3.1-gated content exists without disturbing v2/v3.0 paths.
"""
import re
from pathlib import Path

OUTER_LOOP = Path(__file__).parents[3] / "skills/deep-evolve-workflow/protocols/outer-loop.md"


def _content():
    return OUTER_LOOP.read_text(encoding="utf-8")


def test_step_6_5_0_epoch_sync_exists():
    c = _content()
    assert re.search(r"Step 6\.5\.0.*v3\.1", c, re.IGNORECASE | re.DOTALL), (
        "outer-loop.md missing 'Step 6.5.0' section with v3.1 marker"
    )


def test_step_6_5_0_invokes_forum_summary_generator():
    c = _content()
    m = re.search(r"(Step 6\.5\.0.*?)(?=^## Step 6\.5\.1\b)", c,
                  re.DOTALL | re.MULTILINE)
    assert m, "could not extract Step 6.5.0 body"
    body = m.group(1)
    assert "generate-forum-summary.py" in body, (
        "Step 6.5.0 must invoke T5 generate-forum-summary.py at epoch boundary"
    )


def test_step_6_5_0_invokes_convergence_detect():
    c = _content()
    m = re.search(r"(Step 6\.5\.0.*?)(?=^## Step 6\.5\.1\b)", c,
                  re.DOTALL | re.MULTILINE)
    body = m.group(1)
    assert "convergence-detect.py" in body, (
        "Step 6.5.0 must invoke T19 convergence-detect.py"
    )


def test_step_6_5_0_emits_convergence_event_to_journal_and_forum():
    c = _content()
    m = re.search(r"(Step 6\.5\.0.*?)(?=^## Step 6\.5\.1\b)", c,
                  re.DOTALL | re.MULTILINE)
    body = m.group(1)
    assert "append_journal_event" in body, (
        "Step 6.5.0 must emit convergence_event to journal via helper"
    )
    assert "append_forum_event" in body, (
        "Step 6.5.0 must also append convergence_event to forum per spec § 7.2"
    )


def test_step_6_5_0_n_reeval_documented():
    c = _content()
    m = re.search(r"(Step 6\.5\.0.*?)(?=^## Step 6\.5\.1\b)", c,
                  re.DOTALL | re.MULTILINE)
    body = m.group(1)
    assert re.search(r"n_adjusted|n_current|N re-eval|re-evaluate N",
                     body, re.IGNORECASE), (
        "Step 6.5.0 must document N re-evaluation (§ 6.3 adaptive scheduler hook)"
    )


def test_step_6_5_0_is_v31_gated_not_always_on():
    c = _content()
    m = re.search(r"(Step 6\.5\.0.*?)(?=^## Step 6\.5\.1\b)", c,
                  re.DOTALL | re.MULTILINE)
    body = m.group(1)
    assert re.search(r"(v2.*skip|3\.0.*skip|only when.*3\.1|\$VERSION.*3\.1)",
                     body, re.IGNORECASE), (
        "Step 6.5.0 must explicitly gate on v3.1 and document v2/v3.0 skip"
    )
