"""v3.1 Step 5.e forum emission contract — normative content assertions.

Closes the foundation gap (C-1/C-2 from G7 plan review): G6's Step 5.e
emitted only journal events; spec § 7.2 mandates BOTH journal AND forum
emission for seed_keep and seed_discard. T17 borrow-preflight and T18
Step 1 forum consultation depend on these forum records existing.
"""
import re
from pathlib import Path

INNER_LOOP = Path(__file__).parents[3] / "skills/deep-evolve-workflow/protocols/inner-loop.md"


def _content():
    return INNER_LOOP.read_text(encoding="utf-8")


def _keep_branch_body():
    """Extract Step 5.e Keep branch body (from 'Keep branch' to 'Discard branch')."""
    c = _content()
    m = re.search(
        r"(\*\*Keep branch\*\*.*?)(?=\*\*Discard branch\*\*)",
        c, re.DOTALL,
    )
    assert m, "could not locate Step 5.e Keep branch"
    return m.group(1)


def _discard_branch_body():
    """Extract Step 5.e Discard branch body (from 'Discard branch' to 'Note' / 'ELSE')."""
    c = _content()
    m = re.search(
        r"(\*\*Discard branch\*\*.*?)(?=\*\*Note\*\*|\*\*Step 5\.f|ELSE \(v2\))",
        c, re.DOTALL,
    )
    assert m, "could not locate Step 5.e Discard branch"
    return m.group(1)


def test_keep_branch_emits_seed_keep_to_forum():
    body = _keep_branch_body()
    # Must invoke append_forum_event AND name the seed_keep event
    assert "append_forum_event" in body, (
        "Step 5.e Keep branch must invoke append_forum_event (spec § 7.2)"
    )
    assert '"event":"seed_keep"' in body or '"event": "seed_keep"' in body, (
        "Step 5.e Keep branch must emit an event with event=seed_keep"
    )


def test_discard_branch_emits_seed_discard_to_forum():
    body = _discard_branch_body()
    assert "append_forum_event" in body, (
        "Step 5.e Discard branch must invoke append_forum_event (spec § 7.2)"
    )
    assert '"event":"seed_discard"' in body or '"event": "seed_discard"' in body, (
        "Step 5.e Discard branch must emit an event with event=seed_discard"
    )


def test_seed_keep_event_includes_epoch_field():
    body = _keep_branch_body()
    assert "epoch" in body, (
        "seed_keep event must include epoch field (C-2 fix for G7 Step 6.5.0 filter)"
    )


def test_seed_discard_event_includes_epoch_field():
    body = _discard_branch_body()
    assert "epoch" in body, (
        "seed_discard event must include epoch field"
    )
