"""v3.1 Inner Loop protocol extensions — normative content assertions.

These tests parse skills/deep-evolve-workflow/protocols/inner-loop.md and assert
that v3.1-gated content exists without disturbing v2/v3.0 paths. They do NOT
execute the protocol; they only lock the prose contract in place so future edits
can't silently drop a required instruction.
"""
import re
from pathlib import Path

INNER_LOOP = Path(__file__).parents[3] / "skills/deep-evolve-workflow/protocols/inner-loop.md"


def _content():
    return INNER_LOOP.read_text(encoding="utf-8")


def test_step_0_5_block_parameters_intake_exists():
    c = _content()
    assert re.search(r"Step 0\.5.*v3\.1", c, re.IGNORECASE), (
        "inner-loop.md missing 'Step 0.5' section with v3.1 marker"
    )


def test_step_0_5_pins_cwd_via_pwd_check():
    c = _content()
    m = re.search(r"(Step 0\.5.*?)(?=\*\*Step\s+1\b|### )", c, re.DOTALL)
    assert m, "could not extract Step 0.5 body"
    body = m.group(1)
    assert "pwd" in body
    assert "worktree_path" in body
    assert re.search(r"(abort|failed|contract violation)", body, re.IGNORECASE), (
        "Step 0.5 must name the consequence of CWD mismatch"
    )


def test_step_0_5_extracts_n_block_from_prompt():
    c = _content()
    m = re.search(r"(Step 0\.5.*?)(?=\*\*Step\s+1\b|### )", c, re.DOTALL)
    body = m.group(1)
    assert "N_block" in body or "n_block" in body.lower()
    assert re.search(r"exactly\s+\w*\s*experiments?", body, re.IGNORECASE)


def test_step_0_5_derives_seed_id_and_exports_it():
    c = _content()
    m = re.search(r"(Step 0\.5.*?)(?=\*\*Step\s+1\b|### )", c, re.DOTALL)
    body = m.group(1)
    assert "SEED_ID" in body
    assert "seed_" in body.lower()


def test_step_0_5_reads_per_seed_program_md_not_base():
    c = _content()
    m = re.search(r"(Step 0\.5.*?)(?=\*\*Step\s+1\b|### )", c, re.DOTALL)
    body = m.group(1)
    assert "program.md" in body
    assert re.search(r"(per-seed|seed-specific|your worktree|\$worktree_path)",
                     body, re.IGNORECASE)


def test_v31_journal_events_require_seed_id_tag():
    c = _content()
    pattern = re.compile(
        r"seed_id.*(every|all).*(journal event|event you append|v3\.1)",
        re.IGNORECASE | re.DOTALL,
    )
    assert pattern.search(c), (
        "inner-loop.md must contain an explicit seed_id tagging contract for v3.1"
    )


def test_v2_step_1_content_preserved():
    c = _content()
    assert "**Step 1 — Idea Selection**" in c
    assert "**Step 1.5 — Category Tagging (v3 only):**" in c
    assert "candidates_per_step" in c


def test_step_0_5_is_v31_gated_not_always_on():
    c = _content()
    m = re.search(r"(Step 0\.5.*?)(?=\*\*Step\s+1\b|### )", c, re.DOTALL)
    body = m.group(1)
    assert re.search(r"(v2.*skip|skip.*v3\.0|3\.0.*skip|only when.*3\.1)",
                     body, re.IGNORECASE), (
        "Step 0.5 must explicitly state that v2/v3.0 sessions skip it"
    )


def test_step_5_f_cross_seed_borrow_exists():
    c = _content()
    assert re.search(r"Step 5\.f.*(semantic borrow|cross-seed)",
                     c, re.IGNORECASE), (
        "inner-loop.md missing Step 5.f cross-seed borrow section"
    )


def test_step_5_f_preflight_invocation_referenced():
    c = _content()
    assert "borrow-preflight.py" in c, (
        "Step 5.f must invoke borrow-preflight.py (P2/P3 enforcement)"
    )


def test_step_5_f_two_phase_state_machine_documented():
    c = _content()
    assert "borrow_planned" in c
    assert "cross_seed_borrow" in c
    assert "inspired_by" in c


def test_step_5_f_keep_branch_only_and_v31_gate():
    c = _content()
    m = re.search(r"(Step 5\.f.*?)(?=\*\*Step|### |ELSE \(v2\))", c, re.DOTALL)
    assert m, "could not extract Step 5.f body"
    body = m.group(1)
    assert "keep branch only" in body.lower() or "keep-branch only" in body.lower()
    assert "3.1" in body and ("v2" in body.lower() or "v3.0" in body.lower())
