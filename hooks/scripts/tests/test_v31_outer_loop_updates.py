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


def test_step_6_5_0_t5_invocation_is_rc_guarded():
    """Opus code review fix: T5 must be guarded with if-then-fi + error:
    stderr line, not invoked bare. Matches the aff23c9 rc-propagation
    contract established for T14-class silent-masking prevention."""
    c = _content()
    m = re.search(r"(Step 6\.5\.0.*?)(?=^## Step 6\.5\.1\b)", c,
                  re.DOTALL | re.MULTILINE)
    body = m.group(1)
    assert re.search(r"if\s*!\s*python3.*generate-forum-summary\.py",
                     body, re.DOTALL), (
        "Step 6.5.0.1 must wrap generate-forum-summary.py in `if ! ...; then` "
        "rc guard (T5 non-zero exit must surface, not be silently swallowed)"
    )
    assert "error: generate-forum-summary.py failed" in body, (
        "T5 failure must emit an `error:` prefixed stderr line for operator "
        "debugging (foundation pattern)"
    )


def test_step_6_5_0_t19_invocation_is_rc_guarded():
    """Same rc-propagation contract for T19."""
    c = _content()
    m = re.search(r"(Step 6\.5\.0.*?)(?=^## Step 6\.5\.1\b)", c,
                  re.DOTALL | re.MULTILINE)
    body = m.group(1)
    assert re.search(r"if\s*!\s*CLASSIFY=\$\(python3.*convergence-detect\.py",
                     body, re.DOTALL), (
        "Step 6.5.0.2 step 5 must wrap convergence-detect.py in "
        "`if ! CLASSIFY=$(...); then` rc guard"
    )
    assert "error: convergence-detect.py failed" in body, (
        "T19 failure must emit an `error:` prefixed stderr line"
    )


def test_step_6_5_6_v31_addendum_exists():
    c = _content()
    step_6_5_6 = re.search(
        r"(## Step 6\.5\.6.*?)(?=^## |\Z)", c, re.DOTALL | re.MULTILINE
    )
    assert step_6_5_6, "could not locate Step 6.5.6"
    body = step_6_5_6.group(1)
    assert re.search(r"v3\.1.*convergence|convergence.*v3\.1", body,
                     re.IGNORECASE | re.DOTALL), (
        "Step 6.5.6 must contain a v3.1-gated convergence-credit clause"
    )


def test_step_6_5_6_names_all_three_convergence_classes():
    c = _content()
    step_6_5_6 = re.search(
        r"(## Step 6\.5\.6.*?)(?=^## |\Z)", c, re.DOTALL | re.MULTILINE
    ).group(1)
    assert "evidence_based" in step_6_5_6
    assert "borrow_chain_convergence" in step_6_5_6
    assert "contagion_suspected" in step_6_5_6


def test_step_6_5_6_specifies_credit_magnitudes():
    c = _content()
    step_6_5_6 = re.search(
        r"(## Step 6\.5\.6.*?)(?=^## |\Z)", c, re.DOTALL | re.MULTILINE
    ).group(1)
    # evidence_based -2, borrow_chain -1, contagion 0 — § 7.5 Outer Loop interpretation
    assert re.search(r"evidence_based.*(-\s*2|decrement.*2|by\s*2|\+\s*2|\+2)",
                     step_6_5_6, re.IGNORECASE | re.DOTALL), (
        "Step 6.5.6 must specify evidence_based gets +2/-2 credit magnitude"
    )
    assert re.search(r"borrow_chain_convergence.*(-\s*1|decrement.*1|by\s*1|\+\s*1|\+1)",
                     step_6_5_6, re.IGNORECASE | re.DOTALL), (
        "Step 6.5.6 must specify borrow_chain_convergence gets +1/-1 credit magnitude"
    )
    assert re.search(r"contagion_suspected.*(no.*credit|0\s|warn)",
                     step_6_5_6, re.IGNORECASE | re.DOTALL), (
        "Step 6.5.6 must specify contagion_suspected gets 0 credit + warning"
    )


def test_step_6_5_6_recurring_contagion_escalates_to_askuser():
    c = _content()
    step_6_5_6 = re.search(
        r"(## Step 6\.5\.6.*?)(?=^## |\Z)", c, re.DOTALL | re.MULTILINE
    ).group(1)
    assert re.search(r"(AskUserQuestion|prompt.*user|ask.*user|recurring)",
                     step_6_5_6, re.IGNORECASE | re.DOTALL), (
        "Step 6.5.6 must mention AskUserQuestion escalation for recurring contagion"
    )
