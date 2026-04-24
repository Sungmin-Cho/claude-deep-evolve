"""forum.jsonl atomic append + tail-read for cross-seed communication."""
import subprocess, json, os
from pathlib import Path

HELPER = Path(__file__).parents[3] / "hooks/scripts/session-helper.sh"


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
