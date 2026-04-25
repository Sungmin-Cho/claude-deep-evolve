"""commands/deep-evolve.md --kill-seed=<id> → T23 writer delegation.

Behavioral subprocess tests live in test_v31_kill_request.py (G8).
This file verifies the markdown SURFACE — argv shape, terminal exit,
SESSION_ROOT pre-resolution.
"""
import re
from pathlib import Path

import pytest

CMD = (Path(__file__).parents[3] / "commands/deep-evolve.md")


def _step_0_5():
    full = CMD.read_text(encoding="utf-8")
    return full.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]


def test_kill_seed_extracts_numeric_value():
    s = _step_0_5()
    # Must use a regex / parameter expansion that captures only digits
    assert re.search(
        r"(grep\s+-oE.*--kill-seed=\\?\(\?\:\\\?d\)\+|"
        r"\[\[\s+\"\$\w+\"\s+=~.*--kill-seed=\(\\?d\+\)|"
        r"sed.*--kill-seed=)",
        s,
    ) or re.search(
        r"--kill-seed=\$\{\w+#--kill-seed=\}",  # parameter expansion strip
        s,
    ), "Step 0.5 must extract numeric value from --kill-seed=<id>"


def test_kill_seed_rejects_non_numeric_argument():
    """T23 already rc=2 on non-numeric --seed=. T35 should either reject
    at its own boundary (preferred — fail fast) or propagate T23's rc=2."""
    s = _step_0_5()
    # Either local rejection or rc-propagation pattern
    assert (
        re.search(r"--kill-seed.*[^\\]\[0-9\]", s)  # numeric regex
        or re.search(r"if\s+!\s+bash\s+.*kill-request-writer\.sh.*then\s+exit", s, re.DOTALL)
    ), "Step 0.5 must reject non-numeric --kill-seed or propagate T23 rc"


def test_kill_seed_rejects_zero():
    """Seed IDs start at 1. T23 rejects 0 with rc=2; T35 should mirror."""
    s = _step_0_5()
    # Either explicit `> 0` check or rely on T23 rejection (rc-guarded)
    assert (
        re.search(r"-gt\s+0|>\s*0", s)
        or re.search(r"if\s+!\s+bash\s+.*kill-request-writer\.sh", s, re.DOTALL)
    )


def test_kill_seed_rejects_negative():
    """W-5 carry-forward: regex must NOT accept --kill-seed=-1."""
    s = _step_0_5()
    # The numeric extraction regex must anchor digits-only (no `-` allowed)
    assert not re.search(
        r"--kill-seed=\\\?\(\?\:.*-.*\)\?",  # a regex permitting `-` would fail this
        s,
    ), "Step 0.5 numeric extraction must reject negatives"


def test_kill_seed_uses_resolved_session_root():
    """T23 requires SESSION_ROOT in the env. Step 0.5 must resolve first."""
    s = _step_0_5()
    # Must invoke session-helper.sh resolve_current OR check for no-session
    assert "resolve_current" in s or "SESSION_ROOT" in s


def test_kill_seed_no_session_handling():
    """--kill-seed against a project with no active session must print
    a friendly message and exit, not propagate raw T23 SESSION_ROOT-unset
    error (T23 rc=2 stderr would reach the user as 'error: SESSION_ROOT
    must be set' which is opaque)."""
    s = _step_0_5()
    kill_block = s[s.index("--kill-seed"):]
    # Must guard with explicit no-session friendly handler before T23 call
    assert (
        re.search(r"활성\s*세션이?\s*없", kill_block)
        or re.search(r"no\s+active\s+session", kill_block, re.IGNORECASE)
        or re.search(r"if\s+!\s+SESSION_ROOT=", kill_block)
    ), "--kill-seed must handle no-session case before T23 invocation"


def test_kill_seed_passes_seed_argv_format():
    s = _step_0_5()
    # T23 contract: --seed=<integer>
    assert re.search(
        r'kill-request-writer\.sh\s+--seed=["\$\{][^"]*',
        s,
    ), "T23 invocation must use --seed=<val> argv format"


def test_kill_seed_does_not_emit_journal_event_directly():
    """T23 contract: --kill-seed writes kill_requests.jsonl ONLY. The
    seed_killed journal event is emitted by T24 drain_kill_queue when
    the kill applies. T35 must NOT call append_journal_event directly."""
    s = _step_0_5()
    kill_block_match = re.search(
        r"(--kill-seed.*?)(?=--status|## Step 1:)",
        s,
        re.DOTALL,
    )
    assert kill_block_match
    kill_block = kill_block_match.group(1)
    assert "append_journal_event" not in kill_block, \
        "--kill-seed must not emit journal events; that's T24's job"


@pytest.mark.xfail(
    strict=False,
    reason=(
        "T22 polling not yet wired as bash-tagged code in coordinator.md. "
        "T35's strengthened W-6 trace test (deep-review 2026-04-25 plan-stage "
        "C4 fix) surfaces this gap rather than masking it via prose pseudocode "
        "presence. When T22 polling lands as actual ```bash``` block in "
        "coordinator.md (with action verb tail/while read/jq/flock/>>/cat "
        "co-located with kill_requests.jsonl), this test will auto-activate. "
        "Removing the xfail decorator IS the activation point."
    ),
)
def test_kill_seed_w6_trace_to_t22_polling():
    """W-6 trace continuation (deep-review 2026-04-25 plan-stage C4 fix):
    kill_requests.jsonl is the contract handle between T35 (writer) and T22
    (poller). Both must reference the same filename — AND coordinator.md must
    actually have BASH polling code, not just prose pseudocode. The G10 final
    integration review lesson: substring presence in pseudocode comments is
    insufficient evidence that the consumer is wired. We require:
       (a) literal `kill_requests.jsonl` token,
       (b) inside a `^```bash` fenced code block (not the `^``` ` plain block
           which holds pseudocode only),
       (c) co-located with one of the action verbs `tail`/`while read`/`jq`/
           `flock`/`>>`/`cat` within 5 lines (real I/O — not just a comment).
    If T22's actual bash polling has not landed in coordinator.md yet, this
    test fails loudly so the gap is surfaced rather than masked.
    """
    cmd_text = CMD.read_text(encoding="utf-8")
    assert "kill_requests.jsonl" in cmd_text, \
        "T35 (commands/deep-evolve.md) must reference kill_requests.jsonl"
    coordinator_path = (Path(__file__).parents[3]
                        / "skills/deep-evolve-workflow/protocols/coordinator.md")
    coord_text = coordinator_path.read_text(encoding="utf-8")
    # Extract every ```bash ... ``` fenced region (not language-tag-less ``` blocks)
    bash_blocks = re.findall(r"```bash\n(.*?)\n```", coord_text, re.DOTALL)
    found_in_bash = False
    for block in bash_blocks:
        if "kill_requests.jsonl" not in block:
            continue
        # Must co-locate with an action verb within 5 lines
        lines = block.splitlines()
        for i, line in enumerate(lines):
            if "kill_requests.jsonl" in line:
                window = "\n".join(lines[max(0, i - 5):i + 6])
                if re.search(r"\b(tail|while\s+read|jq|flock|>>|cat\s+)\b", window):
                    found_in_bash = True
                    break
        if found_in_bash:
            break
    assert found_in_bash, (
        "coordinator.md must have ACTUAL bash polling of kill_requests.jsonl "
        "(not just prose pseudocode). Required: literal token inside ```bash``` "
        "code block, co-located with tail/while read/jq/flock/>>/cat within 5 lines. "
        "If this fails, T22's polling implementation has not landed — surface the gap."
    )


def test_kill_seed_does_not_silently_truncate_garbage_tail():
    """🟡 regression test (deep-review code-quality 2026-04-25): W2 regression
    class for sibling flag. `--kill-seed=12abc` must NOT silently extract `12`
    and proceed (silently kill seed_12 due to typo). Permissive extract +
    strict validate idiom required, mirroring the W2 fix for --n-min/--n-max."""
    s = _step_0_5()
    # Implementation must use permissive sed extraction (not grep -o on [1-9][0-9]*)
    assert re.search(
        r"sed\s+-nE\s+'s/\.\*--kill-seed=\(\[\^",
        s,
    ) or "[^[:space:]]" in s, \
        "Step 0.5 must extract --kill-seed value permissively then validate strictly"
    # Sanity: must NOT use the buggy grep regex form
    assert not re.search(
        r"grep\s+-oE?\s+--?\s+'--kill-seed=\[1-9\]\[0-9\]\*'\s*\|",
        s,
    ), "Buggy grep regex --kill-seed=[1-9][0-9]* silently truncates --kill-seed=12abc"
