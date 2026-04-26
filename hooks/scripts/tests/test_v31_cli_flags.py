"""commands/deep-evolve.md — v3.1 Step 0.5 CLI flag parsing.

Verifies the v3.1 CLI surface contains:
  - --no-parallel → exports DEEP_EVOLVE_NO_PARALLEL=1
  - --n-min=<k>   → exports DEEP_EVOLVE_N_MIN=<k>  (integer 1..9)
  - --n-max=<k>   → exports DEEP_EVOLVE_N_MAX=<k>  (integer 1..9)
  - --kill-seed=<id> → terminal subcommand: invoke T23 writer, exit
  - --status         → terminal subcommand: invoke status-dashboard.py, exit

T31's test_v31_init_protocol.py covers the CONSUMER side
(test_a26_honors_no_parallel_env_var / test_a26_honors_n_min_n_max_env_vars).
This file covers the PRODUCER side — markdown content + parse-order
invariants. The W-6 trace test below verifies producer/consumer continuity
without duplicating either set.
"""
import re
from pathlib import Path

CMD = (Path(__file__).parents[3] / "commands/deep-evolve.md")


def _content():
    assert CMD.is_file(), f"deep-evolve.md must exist at {CMD}"
    return CMD.read_text(encoding="utf-8")


def _bash_blocks_minus_comments(content):
    """Extract bash code from ```bash ... ``` blocks, strip comment lines.

    Used to filter markdown-prose mentions of env vars from actual bash
    conditionals that EVALUATE them at runtime (W1 G11 fold-in fix —
    pre-W1 test matched comment prose like
    `# DEEP_EVOLVE_NO_PARALLEL=1 forces N=1`)."""
    blocks = re.findall(r"```bash\n(.*?)\n```", content, re.DOTALL)
    out_lines = []
    for b in blocks:
        for line in b.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            out_lines.append(line)
    return "\n".join(out_lines)


# ---------- T35: Step 0.5 section presence ----------

def test_step_0_5_section_header_present():
    """Step 0.5 must be inserted between Step 0 and Step 1."""
    c = _content()
    assert "## Step 0.5" in c, "Step 0.5 section header missing"
    s0_5_idx = c.index("## Step 0.5")
    s0_idx = c.index("## Step 0:")
    s1_idx = c.index("## Step 1:")
    assert s0_idx < s0_5_idx < s1_idx, \
        "Step 0.5 must sit between Step 0 and Step 1"


def test_step_0_5_runs_unconditionally():
    """Step 0.5 must NOT be wrapped in a v3.1-only version gate at the
    section level — env-var exports are no-op for v2/v3.0 sessions
    (A.2.6 doesn't run there), and the terminal subcommands need to be
    available regardless of session version. Per-flag gates inside Step 0.5
    are fine; section-level gating would block --kill-seed against a v3.1
    session that hasn't yet run A.2.6."""
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    # Must not bail out at top with a version check
    first_50_lines = "\n".join(s0_5.splitlines()[:50])
    assert not re.search(
        r"VERSION.*!=.*3\.1\.0.*\n.*(skip|bypass|exit|return)",
        first_50_lines,
        re.IGNORECASE,
    ), "Step 0.5 must not section-level gate on $VERSION"


# ---------- T35: --no-parallel ----------

def test_no_parallel_exports_env_var():
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    # Must contain the export line
    assert re.search(
        r"export\s+DEEP_EVOLVE_NO_PARALLEL\s*=\s*['\"]?1['\"]?",
        s0_5,
    ), "--no-parallel must export DEEP_EVOLVE_NO_PARALLEL=1"


def test_no_parallel_uses_word_boundary_match():
    """W-5 regression-class: --no-parallel substring must not falsely
    trigger on hypothetical future flags like --no-parallel-bound. Match
    must use word-boundary or explicit token equality.

    W1 fix (deep-review 2026-04-25 plan-stage): added 4th alternative
    matching the actual chosen idiom `case " $ARGS_LINE " in *' --no-parallel '*`
    — surrounding-space wrap on ARGS_LINE provides word-boundary safety
    via glob-token matching."""
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    # Either grep -wq, exact case-string match, [[ ]], or surrounding-space-wrapped glob
    assert (
        re.search(r"grep\s+-w[a-z]*\s+", s0_5)
        or re.search(r'\[\[\s+"\$\w+"\s+==\s+"--no-parallel"\s+\]\]', s0_5)
        or re.search(r'case\s+"\$\w+"\s+in\s*\n\s*--no-parallel\)', s0_5)
        # 4th alternative: surrounding-space-wrapped glob (' --no-parallel ' inside *...*)
        or re.search(
            r"case\s+\"\s*\$\w+\s*\"\s+in\s*\n\s*\*'\s+--no-parallel\s+'\*",
            s0_5,
            re.DOTALL,
        )
    ), "--no-parallel match must be word-boundary safe"


# ---------- T35: --n-min / --n-max ----------

def test_n_min_extracts_integer_value():
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    assert re.search(
        r"export\s+DEEP_EVOLVE_N_MIN\s*=",
        s0_5,
    ), "--n-min must export DEEP_EVOLVE_N_MIN"


def test_n_max_extracts_integer_value():
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    assert re.search(
        r"export\s+DEEP_EVOLVE_N_MAX\s*=",
        s0_5,
    ), "--n-max must export DEEP_EVOLVE_N_MAX"


def test_n_min_n_max_validate_integer_range():
    """Per A.2.6's contract (test_a26_clamps_to_global_range_then_user_range):
    N_MIN / N_MAX must be integers in [1, 9]. Step 0.5 should validate at
    the CLI boundary so A.2.6's later validation is a defense-in-depth
    layer, not the only check. rc=2 on parse failure (operator error)."""
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    # Must reject non-integer / out-of-range input
    assert re.search(r"(1\s*<=|1\s+to\s+9|range.*1.*9|\[1,\s*9\])", s0_5)
    # rc=2 on parse failure
    assert re.search(r"exit\s+2", s0_5), \
        "Step 0.5 must rc=2 on N_MIN/N_MAX parse failure"


def test_n_min_n_max_reject_leading_zero():
    """W-5 lesson (T23 leading-zero regression): JSON / yaml downstream
    consumers may misparse '01' / '09'. The strict-validate regex `^[1-9]$`
    in Step 0.5 ensures `--n-min=01` produces N_MIN_RAW="01" which fails
    the `=~ ^[1-9]$` check (multi-character) and exits rc=2."""
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    # Implementation must use ^[1-9]$ regex (single-digit anchor) — defends
    # against leading zeros AND multi-digit AND non-numeric in one check
    assert re.search(r"\^\[1-9\]\$", s0_5), \
        "Step 0.5 must use ^[1-9]$ regex to anchor single-digit validation"


def test_n_min_does_not_silently_truncate_multi_digit():
    """C2-class fix (deep-review 2026-04-25 plan-stage W2 escalated 🔴):
    `--n-min=10` must NOT be silently truncated to `1`. Prior regex
    `--n-min=[1-9]` (grep -o single-char match) had this bug; the fix
    extracts permissively (everything up to whitespace) then validates
    strictly. Verify by simulation:
       echo '--n-min=10 ...' | sed -nE 's/.*--n-min=([^[:space:]]*).*/\\1/p'
    must produce '10' (not '1'), then ^[1-9]$ rejects '10'."""
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    # Must use permissive sed extraction (not grep -o on [1-9])
    assert re.search(
        r"sed\s+-nE\s+'s/\.\*--n-min=\(\[\^",
        s0_5,
    ) or "[^[:space:]]" in s0_5, \
        "Step 0.5 must extract --n-min value permissively then validate strictly"
    # Sanity: must NOT use the buggy `--n-min=[1-9]` grep pattern
    assert not re.search(
        r"grep\s+-oE?\s+--?\s+'--n-min=\[1-9\]'\s*\|",
        s0_5,
    ), "Buggy grep regex --n-min=[1-9] silently truncates --n-min=10"


def test_n_max_does_not_silently_truncate_multi_digit():
    """Symmetric defense for --n-max (same regression class as
    test_n_min_does_not_silently_truncate_multi_digit)."""
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    assert not re.search(
        r"grep\s+-oE?\s+--?\s+'--n-max=\[1-9\]'\s*\|",
        s0_5,
    ), "Buggy grep regex --n-max=[1-9] silently truncates --n-max=10"


# ---------- T35: --kill-seed ----------

def test_kill_seed_invokes_t23_writer():
    """--kill-seed=<id> must invoke T23's hooks/scripts/kill-request-writer.sh
    with the seed id as --seed=<id>. T35 is a thin dispatcher; the JSON
    write + flock + ISO timestamp + validation all live in T23 (already
    tested by test_v31_kill_request.py).
    """
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    assert "kill-request-writer.sh" in s0_5
    # Argv form: --seed="$KILL_SEED_VAL" with quoted expansion
    assert re.search(
        r'kill-request-writer\.sh.*--seed=["\$]',
        s0_5,
    ), "--kill-seed must pass --seed=<val> to T23 writer"


def test_kill_seed_terminates_after_writer_call():
    """--kill-seed is TERMINAL (per followup doc 'don't re-litigate'):
    parse → invoke T23 → exit. Must NOT fall through to Step 1
    state-detection routing."""
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    # The kill-seed branch must end with exit (0 on success, T23 already
    # rc=2 on its own validation failures, propagated via if !...; then exit 1)
    kill_branch = re.search(
        r"--kill-seed.*?(exit\s+\d+|\bexit\b)",
        s0_5,
        re.DOTALL,
    )
    assert kill_branch, "--kill-seed branch must terminate with exit"


def test_kill_seed_rc_guards_t23_invocation():
    """aff23c9 contract: rc-guard around external tool invocation.
    If T23 returns rc=2 (validation failure), Step 0.5 must NOT silently
    swallow the failure and continue to Step 1 — propagate."""
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    # Must wrap T23 call in if !...; then ...; fi
    assert re.search(
        r"if\s+!\s+bash\s+.*kill-request-writer\.sh",
        s0_5,
    ) or re.search(
        r"bash\s+.*kill-request-writer\.sh.*\|\|\s*exit",
        s0_5,
    ), "T23 invocation must be rc-guarded"


# ---------- T35: --status ----------

def test_status_invokes_dashboard_helper():
    """--status subcommand must invoke hooks/scripts/status-dashboard.py."""
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    assert "status-dashboard.py" in s0_5


def test_status_terminates_after_dashboard_call():
    """--status is TERMINAL (per § 13)."""
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    status_branch = re.search(
        r"--status.*?(exit\s+\d+|\bexit\b)",
        s0_5,
        re.DOTALL,
    )
    assert status_branch, "--status branch must terminate with exit"


def test_status_passes_session_yaml_journal_forum_paths():
    """W-6 trace: status-dashboard.py needs all 3 inputs to render
    per § 13.1 sample (epoch + budget from session.yaml; per-seed exp/keep
    from journal; borrow/convergence from forum). Step 0.5 must pass all
    three."""
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    status_block = c[c.index("--status"):c.index("## Step 1:")]
    for path in ("session.yaml", "journal", "forum"):
        assert path in status_block, \
            f"--status invocation must reference {path}"


def test_status_resolves_session_root_before_dashboard():
    """The dashboard helper needs $SESSION_ROOT. Step 0.5 must resolve
    via session-helper.sh resolve_current BEFORE invoking the dashboard
    (otherwise dashboard fails with 'no active session' for a fresh
    install). Alternatively, --status without an active session must
    print a friendly 'no active session' message rc=0, not crash rc=1."""
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    status_block = s0_5[s0_5.index("--status"):]
    # Either resolve_current invocation or explicit no-session friendly path
    assert (
        "resolve_current" in status_block
        or re.search(r"활성\s*세션이?\s*없", status_block)
        or re.search(r"no\s+active\s+session", status_block, re.IGNORECASE)
    ), "Step 0.5 --status must resolve session or handle no-session"


# ---------- T35: W-6 trace-variable-propagation ----------

# ---------- T39 (W1 G11 fold-in): bash-semantic-tight W-6 trace ----------

def _w6_alias_candidates(bash, env_var):
    """Return list of variable names traceable from env_var in this bash text.

    Includes env_var itself plus any local alias assigned from it via
    `ALIAS="${ENV_VAR:-default}"` or `ALIAS="$ENV_VAR"` patterns.

    G12 G11 fold-in C1 fix (Codex adversarial 2026-04-26 F1): A.2.6 currently
    aliases env vars before runtime check (`NO_PARALLEL="${DEEP_EVOLVE_NO_PARALLEL:-0}"`
    then `[ "$NO_PARALLEL" = "1" ]`). The pre-fix W-6 trace only checked
    literal `$DEEP_EVOLVE_NO_PARALLEL` in the conditional and would have
    falsely failed against the correct alias-flow consumer code, pushing
    executor to unnecessarily edit A.2.6. This helper makes the trace
    alias-aware: we recognize both direct usage AND the alias indirection
    that A.2.6 actually uses today."""
    candidates = [env_var]
    alias_re = rf'(\w+)="\$\{{?{re.escape(env_var)}(?::-[^}}"]*)?\}}?"'
    candidates.extend(m.group(1) for m in re.finditer(alias_re, bash))
    return candidates


def test_w6_trace_no_parallel_consumer_bash_semantic():
    """W1 fix: the pre-W1 W-6 trace matched the env var name in any context
    including comment prose. Tightened to require an *evaluating* bash
    conditional ([ ... ] / [[ ... ]] / case ... in 1)) inside a ```bash
    code block, with comment lines stripped first.

    G12 fold-in C1 fix (Codex adversarial 2026-04-26): alias-aware — we
    recognize `$DEEP_EVOLVE_NO_PARALLEL` directly OR any variable assigned
    from it (e.g., `NO_PARALLEL="${DEEP_EVOLVE_NO_PARALLEL:-0}"; ...
    [ "$NO_PARALLEL" = "1" ]`). The actual A.2.6 implementation uses the
    alias form; the original literal-only patterns falsely failed.

    Regression class this catches: someone removes BOTH the alias
    assignment AND the runtime check from A.2.6 but leaves the doc
    comment behind. Pre-W1 substring match on comment passes; deployment
    crashes. Post-W1 fails loudly."""
    a26_path = (Path(__file__).parents[3]
                / "skills/deep-evolve-workflow/protocols/init.md")
    a26_full = a26_path.read_text(encoding="utf-8")
    a26 = a26_full.split("### A.2.6", 1)[1].split("## A.2.5:", 1)[0]
    bash = _bash_blocks_minus_comments(a26)
    candidates = _w6_alias_candidates(bash, "DEEP_EVOLVE_NO_PARALLEL")
    assert len(candidates) >= 1, "DEEP_EVOLVE_NO_PARALLEL must be referenced in A.2.6 bash"
    matched_via = None
    for var in candidates:
        v = re.escape(var)
        patterns = [
            # POSIX test with single =, both single- and double-quoted forms
            rf'\[\s+"\${v}"\s+=\s+["\']?1["\']?\s+\]',
            # Bash double-bracket
            rf'\[\[\s+"\${v}"\s+(?:==?|=)\s+["\']?1["\']?\s+\]\]',
            # Bash extended-test ==
            rf'\[\s+"\${v}"\s+==\s+["\']?1["\']?\s+\]',
            # case match (whitespace-tolerant)
            rf'case\s+"\${v}"\s+in[\s\S]*?\b1\)',
        ]
        if any(re.search(p, bash) for p in patterns):
            matched_via = var
            break
    assert matched_via, (
        "A.2.6 must contain a bash conditional that *evaluates* "
        "DEEP_EVOLVE_NO_PARALLEL == 1 directly or via a local alias "
        "(e.g., NO_PARALLEL=\"${DEEP_EVOLVE_NO_PARALLEL:-0}\"; "
        "[ \"$NO_PARALLEL\" = \"1\" ]). Candidates probed: "
        f"{candidates}. Searched in stripped bash (first 400 chars):\n"
        f"{bash[:400]}..."
    )


def test_w6_trace_n_min_consumer_bash_arithmetic():
    """W1 continuation: N_MIN consumer must perform actual integer
    comparison (-lt / -le / -gt / -ge) — not just mention the var in a
    comment or assignment.

    Accepts either bash arithmetic test (`[ "$N_MIN" -gt ...]`) or
    Python-level int comparison (`python3 -c '...int(...N_MIN...)...'`),
    matching T35's argv-safe `python3 -c '...' "$VAL"` clamp pattern.

    G12 fold-in C1 fix: alias-aware — recognizes `$DEEP_EVOLVE_N_MIN`,
    `${DEEP_EVOLVE_N_MIN:-...}`, `$N_MIN_USER` (A.2.6 alias name), and
    Python `nmin`/`int(sys.argv[i])` argv flows."""
    a26_path = (Path(__file__).parents[3]
                / "skills/deep-evolve-workflow/protocols/init.md")
    a26_full = a26_path.read_text(encoding="utf-8")
    a26 = a26_full.split("### A.2.6", 1)[1].split("## A.2.5:", 1)[0]
    bash = _bash_blocks_minus_comments(a26)
    candidates = _w6_alias_candidates(bash, "DEEP_EVOLVE_N_MIN")
    matched_via = None
    for var in candidates:
        v = re.escape(var)
        bash_arith = re.search(
            rf'\[\s+"\$\{{?{v}\}}?"\s+-(?:lt|le|gt|ge|eq|ne)\s+',
            bash,
        )
        py_arith = re.search(
            rf'python3\s+-c\s+["\'][^"\']*{v}',
            bash,
        )
        # Python argv-passed value: A.2.6 invokes
        # `python3 -c '...nmin = int(sys.argv[1])...' "$N_MIN_USER" "$N_MAX_USER"`
        # — the test recognizes the inline `nmin` arithmetic on the consumer side.
        py_argv_inline = re.search(
            rf'python3\s+-c\s+["\'][^"\']*int\([^)]*sys\.argv[\s\S]*?\bn?min\b[\s\S]*?["\'][^"\n]*"\${v}"',
            bash,
        )
        if bash_arith or py_arith or py_argv_inline:
            matched_via = var
            break
    assert matched_via, (
        "A.2.6 must arithmetic-compare DEEP_EVOLVE_N_MIN directly, via a "
        "local alias (e.g., N_MIN_USER=\"${DEEP_EVOLVE_N_MIN:-1}\"), or via "
        "a Python `int(sys.argv[i])` clamp invoked with `\"$N_MIN_USER\"`. "
        f"Candidates probed: {candidates}."
    )


def test_w6_trace_n_max_consumer_bash_arithmetic():
    """W1 continuation: symmetric for N_MAX. Alias-aware per G12 C1 fix —
    recognizes `$DEEP_EVOLVE_N_MAX`, `$N_MAX_USER`, and Python argv-flow."""
    a26_path = (Path(__file__).parents[3]
                / "skills/deep-evolve-workflow/protocols/init.md")
    a26_full = a26_path.read_text(encoding="utf-8")
    a26 = a26_full.split("### A.2.6", 1)[1].split("## A.2.5:", 1)[0]
    bash = _bash_blocks_minus_comments(a26)
    candidates = _w6_alias_candidates(bash, "DEEP_EVOLVE_N_MAX")
    matched_via = None
    for var in candidates:
        v = re.escape(var)
        bash_arith = re.search(
            rf'\[\s+"\$\{{?{v}\}}?"\s+-(?:lt|le|gt|ge|eq|ne)\s+',
            bash,
        )
        py_arith = re.search(
            rf'python3\s+-c\s+["\'][^"\']*{v}',
            bash,
        )
        py_argv_inline = re.search(
            rf'python3\s+-c\s+["\'][^"\']*int\([^)]*sys\.argv[\s\S]*?\bn?max\b[\s\S]*?["\'][^"\n]*"\${v}"',
            bash,
        )
        if bash_arith or py_arith or py_argv_inline:
            matched_via = var
            break
    assert matched_via, (
        "A.2.6 must arithmetic-compare DEEP_EVOLVE_N_MAX directly or via "
        f"a local alias / argv flow. Candidates probed: {candidates}."
    )


def test_w6_helper_excludes_comment_prose_unit():
    """W1 unit test for the helper itself: _bash_blocks_minus_comments
    must NOT return comment lines, even inside bash code blocks; must NOT
    return prose outside code blocks. Smoke-test discipline so future
    test edits don't silently break the filter."""
    sample = (
        "Some markdown text DEEP_EVOLVE_NO_PARALLEL=1 here.\n"
        "```bash\n"
        "# DEEP_EVOLVE_NO_PARALLEL=1 forces N=1\n"
        '[ "$DEEP_EVOLVE_NO_PARALLEL" = "1" ] && N=1\n'
        "```\n"
        "More markdown prose with N_MIN=2 in it.\n"
    )
    out = _bash_blocks_minus_comments(sample)
    # Must contain the conditional
    assert '[ "$DEEP_EVOLVE_NO_PARALLEL" = "1" ]' in out
    # Must NOT contain the comment line
    assert "# DEEP_EVOLVE_NO_PARALLEL=1 forces N=1" not in out
    # Must NOT contain the markdown prose lines (outside code block)
    assert "Some markdown text" not in out
    assert "More markdown prose" not in out


def test_status_does_not_hijack_bareword_status_in_goal():
    """🔴 regression test (deep-review code-quality 2026-04-25):
    --status subcommand must not falsely match user goal text containing
    the word 'status' anywhere. Step 0's 'first token only' convention
    must be preserved."""
    c = _content()
    s0_5 = c.split("## Step 0.5", 1)[1].split("## Step 1:", 1)[0]
    # The buggy `*' status '*` pattern must NOT be present
    assert "*' status '*" not in s0_5, \
        "--status case must not include bareword `status` alternative — hijacks user goals"
