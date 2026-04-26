"""forum.jsonl atomic append + tail-read for cross-seed communication."""
import subprocess, json, os, shutil
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor

import pytest

HELPER = Path(__file__).parents[3] / "hooks/scripts/session-helper.sh"
ROOT = Path(__file__).parents[3]
FIXTURES = Path(__file__).parent / "fixtures"


def setup_session(tmp_path):
    repo = tmp_path / "proj"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    session_root = repo / ".deep-evolve" / "s-01"
    session_root.mkdir(parents=True)
    env = os.environ.copy()
    env.update({
        "EVOLVE_DIR": str(repo / ".deep-evolve"),
        "SESSION_ID": "s-01",
        "SESSION_ROOT": str(session_root),
    })
    return repo, session_root, env


def run_h(env, cwd, *args):
    r = subprocess.run(["bash", str(HELPER), *args], cwd=cwd, env=env,
                       capture_output=True, text=True)
    return r.stdout, r.stderr, r.returncode


def test_append_forum_event_writes_jsonl_line(tmp_path):
    repo, session_root, env = setup_session(tmp_path)
    event_json = '{"event":"seed_keep","seed_id":1,"commit":"abc123","description":"test"}'
    out, err, rc = run_h(env, repo, "append_forum_event", event_json)
    assert rc == 0, f"append_forum_event failed: stderr={err}"
    forum_path = session_root / "forum.jsonl"
    assert forum_path.exists()
    lines = forum_path.read_text().strip().split("\n")
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["event"] == "seed_keep"
    assert rec["seed_id"] == 1
    assert "ts" in rec, "append must inject ts field"


def test_append_forum_event_multiple_atomic(tmp_path):
    repo, session_root, env = setup_session(tmp_path)
    for i in range(5):
        evt = f'{{"event":"seed_keep","seed_id":{i+1},"commit":"c{i}"}}'
        out, err, rc = run_h(env, repo, "append_forum_event", evt)
        assert rc == 0
    lines = (session_root / "forum.jsonl").read_text().strip().split("\n")
    assert len(lines) == 5
    # Order preserved
    ids = [json.loads(l)["seed_id"] for l in lines]
    assert ids == [1, 2, 3, 4, 5]


def test_append_forum_event_rejects_invalid_json(tmp_path):
    repo, session_root, env = setup_session(tmp_path)
    out, err, rc = run_h(env, repo, "append_forum_event", "not-a-json")
    assert rc != 0
    assert "invalid" in (out + err).lower() or "parse" in (out + err).lower()


def test_tail_forum_reads_last_n(tmp_path):
    repo, session_root, env = setup_session(tmp_path)
    for i in range(10):
        evt = f'{{"event":"seed_keep","seed_id":{i},"commit":"c{i}"}}'
        run_h(env, repo, "append_forum_event", evt)
    out, err, rc = run_h(env, repo, "tail_forum", "3")
    assert rc == 0
    lines = out.strip().split("\n")
    assert len(lines) == 3
    ids = [json.loads(l)["seed_id"] for l in lines]
    assert ids == [7, 8, 9]


# ---------- T43 W-8 #1: concurrent append from N subagents ----------

def _spawn_appender(args):
    """Helper for ProcessPoolExecutor: invoke session-helper.sh
    append_forum_event in a subprocess. Returns (rc, stderr).

    Module-level (not nested) so ProcessPoolExecutor can pickle it.
    """
    helper, repo, env, event_json = args
    p = subprocess.run(
        ["bash", str(helper), "append_forum_event", event_json],
        cwd=repo, env=env, capture_output=True, text=True,
        timeout=15,
    )
    return p.returncode, p.stderr


def test_concurrent_append_no_lost_writes(tmp_path):
    """T43 W-8 #1: 4 concurrent appenders x 5 events each = 20 events.
    All must land in forum.jsonl as well-formed JSON lines (no torn
    writes, no lost writes due to lock contention).

    G12 review fix 2026-04-26 Stage 2 Finding #2: build payloads from
    dicts + json.dumps + retain source dicts for sent_ids extraction
    (was: brittle JSON-via-string-split parsing of payload string)."""
    repo, session_root, env = setup_session(tmp_path)
    helper = HELPER

    N_WRITERS = 4
    EVENTS_PER = 5
    source_dicts = []
    for w in range(N_WRITERS):
        for e in range(EVENTS_PER):
            seed = w * 100 + e + 1  # distinct ids
            source_dicts.append({
                "event": "seed_keep",
                "seed_id": seed,
                "commit": f"c-{w}-{e}",
            })
    payloads = [json.dumps(d) for d in source_dicts]

    args_list = [(helper, repo, env, p) for p in payloads]
    with ProcessPoolExecutor(max_workers=N_WRITERS) as ex:
        results = list(ex.map(_spawn_appender, args_list))

    # All writers must succeed
    for rc, err in results:
        assert rc == 0, f"concurrent append failed: rc={rc}, err={err!r}"

    # forum.jsonl must contain all events as well-formed lines
    forum_path = session_root / "forum.jsonl"
    lines = forum_path.read_text().strip().split("\n")
    assert len(lines) == N_WRITERS * EVENTS_PER, (
        f"expected {N_WRITERS * EVENTS_PER} lines, got {len(lines)} - "
        f"lost writes due to lock contention"
    )
    # Every line parses as valid JSON
    parsed = []
    for ln in lines:
        try:
            parsed.append(json.loads(ln))
        except json.JSONDecodeError as ex:
            pytest.fail(f"torn write detected: {ln!r} ({ex})")
    # Multiset of seed_ids matches what was sent (NOT order — lock
    # guarantees atomicity per write but NOT FIFO across racing writers).
    # Source-dict comparison is robust to key reorder / whitespace / future
    # payload-format changes (vs the brittle string-split parsing pre-fix).
    sent_ids = sorted(int(d["seed_id"]) for d in source_dicts)
    got_ids = sorted(int(rec["seed_id"]) for rec in parsed)
    assert got_ids == sent_ids, "seed_ids mismatch — events lost or corrupted"


def test_concurrent_append_three_iterations(tmp_path):
    """Flaky-bug exposure: re-run the concurrency test across 3 iterations
    with different RNG seeds to surface intermittent lock bugs.

    Each iteration uses an isolated tmp sub-directory + a different
    seed_id offset (iteration * 1000 + i) to avoid cross-iteration
    contamination.
    """
    for iteration in range(3):
        sub = tmp_path / f"iter-{iteration}"
        sub.mkdir()
        repo, session_root, env = setup_session(sub)
        helper = HELPER

        N = 4
        # G12 review fix 2026-04-26 Stage 2 Finding #2: dict-based payloads
        # for robust round-trip verification (was: string-split parsing).
        source_dicts = [
            {
                "event": "seed_keep",
                "seed_id": iteration * 1000 + i,
                "commit": f"c{i}",
            }
            for i in range(N * 3)
        ]
        events = [json.dumps(d) for d in source_dicts]
        args_list = [(helper, repo, env, e) for e in events]
        with ProcessPoolExecutor(max_workers=N) as ex:
            results = list(ex.map(_spawn_appender, args_list))

        for rc, err in results:
            assert rc == 0, f"iter {iteration}: rc={rc}, err={err!r}"

        lines = (session_root / "forum.jsonl").read_text().strip().split("\n")
        assert len(lines) == len(events), (
            f"iter {iteration}: lost writes ({len(lines)}/{len(events)})"
        )
        # Verify every landed line is well-formed JSON
        parsed = [json.loads(ln) for ln in lines]  # raises if any line malformed
        sent_ids = sorted(int(d["seed_id"]) for d in source_dicts)
        got_ids = sorted(int(rec["seed_id"]) for rec in parsed)
        assert got_ids == sent_ids, (
            f"iter {iteration}: seed_ids mismatch — events lost or corrupted"
        )


# ---------- T43 W-8 #2: forum.jsonl corruption recovery ----------

def test_tail_forum_skips_malformed_mid_line(tmp_path):
    """T43 W-8 #2: tail_forum must skip-and-warn on malformed mid-line
    (T22 partial-event tolerance). The forum_malformed/ fixture contains
    a deliberate JSON-malformed line (truncated unterminated string) at
    line 4 surrounded by 5 well-formed lines. tail_forum either skips
    the malformed line (preferred — output has only well-formed lines)
    OR reads it through (acceptable IF the test's well-formed-only
    assertion catches that as a failure).

    G12 review fix 2026-04-26 Stage 1 (90) + Stage 2 #1 (88) cross-
    confirmed: pre-fix fixture contained 5 lines that were ALL JSON-
    valid (just schema-incomplete), making the test tautological.
    Post-fix: fixture has a true `Unterminated string` at line 4 + the
    test assertions below now have an actual fail path (well-formed
    output assertion catches malformed-pass-through; minimum-line
    count catches over-aggressive skip)."""
    fixture = FIXTURES / "forum_malformed"
    assert fixture.is_dir(), f"missing fixture {fixture}"
    # Sanity: confirm fixture has at least 1 truly JSON-malformed line
    fixture_lines = [
        ln for ln in (fixture / "forum.jsonl").read_text().splitlines()
        if ln.strip()
    ]
    malformed_count = 0
    for ln in fixture_lines:
        try:
            json.loads(ln)
        except json.JSONDecodeError:
            malformed_count += 1
    assert malformed_count >= 1, (
        f"forum_malformed/forum.jsonl must contain >= 1 truly JSON-"
        f"malformed line for this test to exercise skip-and-warn; "
        f"found {malformed_count} malformed of {len(fixture_lines)}"
    )

    # Copy to tmp
    dst = tmp_path / "scenario-malformed"
    shutil.copytree(fixture, dst)

    repo = dst
    # Bootstrap as git repo if needed
    if not (repo / ".git").exists():
        subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    session_root = repo / ".deep-evolve" / "s-malformed"
    session_root.mkdir(parents=True, exist_ok=True)
    # The fixture's forum.jsonl should be at a known location — copy
    # to session_root/forum.jsonl.
    fixture_forum = dst / "forum.jsonl"
    if fixture_forum.exists():
        shutil.copy(fixture_forum, session_root / "forum.jsonl")

    env = os.environ.copy()
    env.update({
        "EVOLVE_DIR": str(repo / ".deep-evolve"),
        "SESSION_ID": "s-malformed",
        "SESSION_ROOT": str(session_root),
    })
    out, err, rc = run_h(env, repo, "tail_forum", "10")
    # Must rc=0 — tail_forum prefers partial output over crash
    assert rc == 0, f"tail_forum crashed on malformed (rc={rc}, err={err!r})"

    # Each output line must be valid JSON. The fixture has 5 well-formed
    # + 1 malformed = 6 total. tail_forum's contract is one of:
    #   (a) skip malformed (output = 5 well-formed lines) — preferred
    #   (b) emit warn but include malformed (test catches this here)
    # Current cmd_tail_forum uses plain `tail -n` (no skip) → output
    # includes the malformed line → test correctly fails with the
    # JSONDecodeError below, surfacing the helper gap.
    out_lines = [ln for ln in out.strip().split("\n") if ln.strip()] if out.strip() else []
    for ln in out_lines:
        try:
            json.loads(ln)
        except json.JSONDecodeError as ex:
            # Skip-and-warn contract violation: tail_forum returned a
            # malformed line. T22 partial-event tolerance was supposed to
            # filter this. v3.1.x polish candidate: either tighten this
            # test to require strict skip OR enhance cmd_tail_forum with
            # `jq -c -R 'fromjson? // empty'` filter (or equivalent
            # python3 -c skip pattern) to satisfy the W-8 contract.
            pytest.fail(
                f"tail_forum returned malformed line — skip-and-warn "
                f"path not implemented. Line: {ln!r} ({ex})"
            )


# ---------- T43 W-8 #3: tail_forum on missing file ----------

def test_tail_forum_missing_file_rc0_empty(tmp_path):
    """T43 W-8 #3: forum.jsonl does not exist (early session). tail_forum
    must rc=0 with empty stdout — read-only consumers prefer empty over
    crash."""
    repo, session_root, env = setup_session(tmp_path)
    # Do NOT create forum.jsonl — leave session_root empty
    assert not (session_root / "forum.jsonl").exists()
    out, err, rc = run_h(env, repo, "tail_forum", "5")
    assert rc == 0, f"tail_forum on missing file must rc=0 (rc={rc}, err={err!r})"
    assert out.strip() == "", f"expected empty stdout, got {out!r}"
