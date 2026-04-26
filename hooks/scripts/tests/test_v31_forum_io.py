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
    writes, no lost writes due to lock contention)."""
    repo, session_root, env = setup_session(tmp_path)
    helper = HELPER

    N_WRITERS = 4
    EVENTS_PER = 5
    payloads = []
    for w in range(N_WRITERS):
        for e in range(EVENTS_PER):
            seed = w * 100 + e + 1  # distinct ids
            payloads.append(
                f'{{"event":"seed_keep","seed_id":{seed},"commit":"c-{w}-{e}"}}'
            )

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
    # guarantees atomicity per write but NOT FIFO across racing writers)
    sent_ids = sorted(int(p.split('"seed_id":')[1].split(',')[0]) for p in payloads)
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
        events = [
            f'{{"event":"seed_keep","seed_id":{iteration * 1000 + i},"commit":"c{i}"}}'
            for i in range(N * 3)
        ]
        args_list = [(helper, repo, env, e) for e in events]
        with ProcessPoolExecutor(max_workers=N) as ex:
            results = list(ex.map(_spawn_appender, args_list))

        for rc, err in results:
            assert rc == 0, f"iter {iteration}: rc={rc}, err={err!r}"

        lines = (session_root / "forum.jsonl").read_text().strip().split("\n")
        assert len(lines) == len(events), (
            f"iter {iteration}: lost writes ({len(lines)}/{len(events)})"
        )


# ---------- T43 W-8 #2: forum.jsonl corruption recovery ----------

def test_tail_forum_skips_malformed_mid_line(tmp_path):
    """T43 W-8 #2: tail_forum must skip-and-warn on malformed mid-line
    (T22 partial-event tolerance). Existing forum_malformed/ fixture
    has a malformed mid-line — tail_forum reads surrounding well-formed
    lines without crashing."""
    fixture = FIXTURES / "forum_malformed"
    assert fixture.is_dir(), f"missing fixture {fixture}"
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
    # Stderr may include a warn; that's the contract
    # Each output line must be valid JSON (skip-and-warn yielded only well-formed)
    if out.strip():
        for ln in out.strip().split("\n"):
            try:
                json.loads(ln)
            except json.JSONDecodeError as ex:
                pytest.fail(f"tail_forum returned malformed line: {ln!r} ({ex})")


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
