"""Doc-anchor guard for the evolve-receipt payload template in completion.md.

The suite payload schema (payload-registry/deep-evolve/evolve-receipt/v1.0)
lists `session_id` in its `required` set. The completion.md payload template —
which the agent follows verbatim when composing the receipt body — must
therefore carry a `session_id` field sourced from session.yaml. The
envelope-level `--session-id` injection is a separate concern and must remain.
"""
import re
from pathlib import Path

COMPLETION = Path(__file__).parents[3] / "skills/deep-evolve-workflow/protocols/completion.md"


def _payload_block() -> str:
    """Return the ```json payload template body (the block containing the
    "plugin": "deep-evolve" receipt shape)."""
    c = COMPLETION.read_text(encoding="utf-8")
    for m in re.finditer(r"```json\n(.*?)\n```", c, re.DOTALL):
        body = m.group(1)
        if '"plugin": "deep-evolve"' in body:
            return body
    raise AssertionError("could not locate the evolve-receipt payload json block")


def test_payload_template_declares_session_id():
    body = _payload_block()
    assert '"session_id"' in body, (
        "evolve-receipt payload template omits session_id — suite schema "
        "requires it (payload would fail validation)"
    )
    # Sourced from session.yaml, not hardcoded.
    assert "session.yaml.session_id" in body, (
        "session_id must be sourced from session.yaml.session_id"
    )


def test_payload_session_id_sits_by_timestamp():
    """session_id belongs next to timestamp per the schema's required order
    (timestamp -> session_id -> goal)."""
    body = _payload_block()
    lines = body.splitlines()
    ts = next(i for i, ln in enumerate(lines) if '"timestamp"' in ln)
    sid = next(i for i, ln in enumerate(lines) if '"session_id"' in ln)
    assert sid == ts + 1, "session_id should immediately follow timestamp"


def test_envelope_level_session_id_injection_preserved():
    """The wrap-args `--session-id` path must survive alongside the new payload
    field (they are independent contracts)."""
    c = COMPLETION.read_text(encoding="utf-8")
    assert "--session-id" in c, "envelope-level --session-id injection was removed"
