"""session-helper.sh append_kill_queue_entry / drain_kill_queue — W-9 kill atomicity.

append_kill_queue_entry <seed_id> <condition> <final_q> <experiments_used>
  - appends `{seed_id, condition, final_q, experiments_used, queued_at}`
    to $SESSION_ROOT/kill_queue.jsonl (C-2: final_q + experiments_used
    propagate to seed_killed for synthesis baseline-select cascading
    selection per spec § 8.2; spec § 9.2 lists both as seed_killed key
    fields).
  - rc=0 on success
  - rc=2 on missing args, SESSION_ROOT unset, invalid seed_id (non-
    positive-integer or leading-zero), invalid final_q (non-numeric),
    invalid experiments_used (non-non-negative-int), or condition not
    in the spec § 5.5 whitelist (I-5: prevents typo'd condition strings
    from polluting downstream consumers)
  - rc=3 on lock acquisition failure (transient — caller may retry)

drain_kill_queue <completed_seed_id>
  - reads $SESSION_ROOT/kill_queue.jsonl; for each entry whose seed_id
    matches, emits a `seed_killed` journal event with queued_at +
    applied_at + final_q + experiments_used + reasoning, then rewrites
    the file excluding those entries
  - C-1/W-9 atomicity: snapshot under lock → process snapshot WITHOUT
    lock → re-acquire lock for merge-and-replace. Concurrent appends
    during the unlocked Phase 2 are detected via a set-difference of
    current $queue vs $snapshot and re-merged into survivors. Lock
    hold-time is bounded to the snapshot copy + the merge step, never
    the O(N · jq-startup-time) per-entry parse loop.
  - C-3 dead-letter: malformed/parse-failed lines are PRESERVED in the
    survivors set (never silently deleted) so operators can inspect.
  - rc=0 on success (no-op if file missing or no match)
  - rc=2 on missing completed_seed_id, SESSION_ROOT unset, SESSION_ID
    unset (W-2: required for cmd_append_journal_event downstream), or
    invalid completed_seed_id (non-positive-integer or leading-zero)
  - rc=3 on lock acquisition failure (transient — caller may retry)
  - no-op if the queue is empty
  - runs cmd_append_journal_event inside `(unset SEED_ID; ...)` subshell
    so the coordinator's ambient SEED_ID does not corrupt the seed_killed
    event's seed_id (T16 auto-inject prevention)
"""
import json
import os
import subprocess
from pathlib import Path

HELPER = Path(__file__).parents[3] / "hooks/scripts/session-helper.sh"


def _setup(tmp_path):
    repo = tmp_path / "p"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True,
                   capture_output=True)
    sr = repo / ".deep-evolve" / "s"
    sr.mkdir(parents=True)
    env = os.environ.copy()
    env.update({
        "EVOLVE_DIR": str(repo / ".deep-evolve"),
        "SESSION_ID": "s",
        "SESSION_ROOT": str(sr),
    })
    # Remove any ambient SEED_ID from the parent process — test must be
    # deterministic regardless of caller state.
    env.pop("SEED_ID", None)
    return repo, sr, env


def _run(subcmd_args, repo, env, extra_env=None):
    e = dict(env)
    if extra_env:
        e.update(extra_env)
    return subprocess.run(
        ["bash", str(HELPER), *subcmd_args],
        cwd=repo, env=e, capture_output=True, text=True,
    )


# ---- append_kill_queue_entry -------------------------------------------

def test_append_kill_queue_happy_path(tmp_path):
    repo, sr, env = _setup(tmp_path)
    r = _run(["append_kill_queue_entry", "3", "sustained_regression",
              "0.42", "8"], repo, env)
    assert r.returncode == 0, r.stderr
    q = sr / "kill_queue.jsonl"
    assert q.is_file()
    lines = q.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["seed_id"] == 3
    assert rec["condition"] == "sustained_regression"
    assert rec["final_q"] == 0.42
    assert rec["experiments_used"] == 8
    assert "queued_at" in rec


def test_append_kill_queue_multiple_calls_append(tmp_path):
    repo, sr, env = _setup(tmp_path)
    for sid, cond, fq, eu in [
        (2, "crash_give_up", "0.10", "5"),
        (4, "shortcut_quarantine", "0.30", "7"),
    ]:
        r = _run(["append_kill_queue_entry", str(sid), cond, fq, eu],
                 repo, env)
        assert r.returncode == 0, r.stderr
    lines = (sr / "kill_queue.jsonl").read_text(encoding="utf-8") \
        .strip().splitlines()
    assert len(lines) == 2
    assert [json.loads(ln)["seed_id"] for ln in lines] == [2, 4]


def test_append_kill_queue_missing_seed_id_rc_2(tmp_path):
    repo, sr, env = _setup(tmp_path)
    r = _run(["append_kill_queue_entry"], repo, env)
    assert r.returncode == 2
    assert "seed" in r.stderr.lower() or "usage" in r.stderr.lower()


def test_append_kill_queue_missing_condition_rc_2(tmp_path):
    repo, sr, env = _setup(tmp_path)
    r = _run(["append_kill_queue_entry", "3"], repo, env)
    assert r.returncode == 2


def test_append_kill_queue_missing_final_q_rc_2(tmp_path):
    """C-2: final_q is required for downstream synthesis baseline cascade."""
    repo, sr, env = _setup(tmp_path)
    r = _run(["append_kill_queue_entry", "3", "crash_give_up"], repo, env)
    assert r.returncode == 2


def test_append_kill_queue_missing_experiments_used_rc_2(tmp_path):
    """C-2: experiments_used required for meta-archive aggregation."""
    repo, sr, env = _setup(tmp_path)
    r = _run(["append_kill_queue_entry", "3", "crash_give_up", "0.4"],
             repo, env)
    assert r.returncode == 2


def test_append_kill_queue_non_numeric_final_q_rc_2(tmp_path):
    """C-2: final_q must be numeric — non-numeric input must fail rc=2,
    not propagate to a confusing jq parse error downstream."""
    repo, sr, env = _setup(tmp_path)
    r = _run(["append_kill_queue_entry", "3", "crash_give_up", "not-a-num", "5"],
             repo, env)
    assert r.returncode == 2


def test_append_kill_queue_non_numeric_experiments_used_rc_2(tmp_path):
    repo, sr, env = _setup(tmp_path)
    r = _run(["append_kill_queue_entry", "3", "crash_give_up", "0.4", "abc"],
             repo, env)
    assert r.returncode == 2


def test_append_kill_queue_unknown_condition_rc_2(tmp_path):
    """I-5: condition arg must match one of the spec § 5.5 whitelisted
    strings. A typo'd condition would otherwise pollute seed_killed
    events downstream."""
    repo, sr, env = _setup(tmp_path)
    r = _run(["append_kill_queue_entry", "3", "totally_made_up_condition",
              "0.4", "8"], repo, env)
    assert r.returncode == 2
    assert "condition" in r.stderr.lower()


def test_append_kill_queue_non_numeric_seed_rc_2(tmp_path):
    repo, sr, env = _setup(tmp_path)
    r = _run(["append_kill_queue_entry", "abc", "crash_give_up", "0.4", "8"],
             repo, env)
    assert r.returncode == 2


def test_append_kill_queue_leading_zero_seed_rc_2(tmp_path):
    """W-5 mirrored: seed_id `01` rejected at regex stage."""
    repo, sr, env = _setup(tmp_path)
    r = _run(["append_kill_queue_entry", "01", "crash_give_up", "0.4", "8"],
             repo, env)
    assert r.returncode == 2


def test_append_kill_queue_session_root_unset_rc_2(tmp_path):
    repo, sr, env = _setup(tmp_path)
    env.pop("SESSION_ROOT", None)
    r = _run(["append_kill_queue_entry", "3", "crash_give_up", "0.4", "8"],
             repo, env)
    assert r.returncode == 2
    assert "SESSION_ROOT" in r.stderr


# ---- drain_kill_queue --------------------------------------------------

def test_drain_kill_queue_missing_file_is_noop(tmp_path):
    """No kill_queue.jsonl → rc=0, no journal events emitted."""
    repo, sr, env = _setup(tmp_path)
    r = _run(["drain_kill_queue", "3"], repo, env)
    assert r.returncode == 0, r.stderr
    j = sr / "journal.jsonl"
    assert not j.exists() or j.read_text(encoding="utf-8") == ""


def test_drain_kill_queue_empty_file_is_noop(tmp_path):
    repo, sr, env = _setup(tmp_path)
    (sr / "kill_queue.jsonl").write_text("", encoding="utf-8")
    r = _run(["drain_kill_queue", "3"], repo, env)
    assert r.returncode == 0


def test_drain_kill_queue_no_match_queue_unchanged(tmp_path):
    """Queued kill for seed 2; block completes for seed 3 → queue
    unchanged, no journal event for seed 2."""
    repo, sr, env = _setup(tmp_path)
    r = _run(["append_kill_queue_entry", "2", "crash_give_up", "0.4", "8"],
             repo, env)
    assert r.returncode == 0
    before = (sr / "kill_queue.jsonl").read_text(encoding="utf-8")

    r = _run(["drain_kill_queue", "3"], repo, env)
    assert r.returncode == 0
    after = (sr / "kill_queue.jsonl").read_text(encoding="utf-8")
    assert before == after
    # No seed_killed event emitted
    j = sr / "journal.jsonl"
    if j.exists():
        assert "seed_killed" not in j.read_text(encoding="utf-8")


def test_drain_kill_queue_match_emits_and_removes(tmp_path):
    """W-8: also asserts applied_at >= queued_at (strict timestamp
    ordering invariant — synthesis uses this for time-to-kill metric)."""
    import time
    repo, sr, env = _setup(tmp_path)
    _run(["append_kill_queue_entry", "3", "crash_give_up", "0.42", "8"],
         repo, env)
    # iso_now has second precision; a 1.1s sleep guarantees applied_at
    # strictly exceeds queued_at.
    time.sleep(1.1)
    r = _run(["drain_kill_queue", "3"], repo, env)
    assert r.returncode == 0, r.stderr
    # queue should now be empty (file may exist but with no lines)
    q_content = (sr / "kill_queue.jsonl").read_text(encoding="utf-8").strip()
    assert q_content == ""
    # journal should contain exactly one seed_killed event for seed 3
    events = [json.loads(ln)
              for ln in (sr / "journal.jsonl").read_text(encoding="utf-8")
              .strip().splitlines()]
    killed = [e for e in events if e.get("event") == "seed_killed"]
    assert len(killed) == 1
    assert killed[0]["seed_id"] == 3
    assert killed[0]["condition"] == "crash_give_up"
    assert "queued_at" in killed[0]
    assert "applied_at" in killed[0]
    # W-8: strict ordering
    assert killed[0]["queued_at"] < killed[0]["applied_at"], \
        f"applied_at must be strictly after queued_at: {killed[0]}"


def test_drain_kill_queue_emits_final_q_and_experiments_used(tmp_path):
    """C-2: seed_killed must include final_q + experiments_used
    (spec § 9.2 key fields; § 5.5 list). Synthesis baseline-select
    cascade in § 8.2 reads final_q to distinguish 'killed at high Q'
    vs 'killed at zero Q'."""
    repo, sr, env = _setup(tmp_path)
    _run(["append_kill_queue_entry", "3", "sustained_regression",
          "0.27", "10"], repo, env)
    r = _run(["drain_kill_queue", "3"], repo, env)
    assert r.returncode == 0, r.stderr
    events = [json.loads(ln)
              for ln in (sr / "journal.jsonl").read_text(encoding="utf-8")
              .strip().splitlines()]
    killed = [e for e in events if e.get("event") == "seed_killed"]
    assert len(killed) == 1
    assert killed[0]["final_q"] == 0.27
    assert killed[0]["experiments_used"] == 10


def test_drain_kill_queue_multiple_entries_same_seed_all_applied(tmp_path):
    """Edge: two queued kills for the same seed (scheduler flip-flopped).
    Both must apply — then queue is empty."""
    repo, sr, env = _setup(tmp_path)
    _run(["append_kill_queue_entry", "3", "crash_give_up", "0.2", "5"],
         repo, env)
    _run(["append_kill_queue_entry", "3", "sustained_regression", "0.15", "8"],
         repo, env)
    r = _run(["drain_kill_queue", "3"], repo, env)
    assert r.returncode == 0, r.stderr
    q_content = (sr / "kill_queue.jsonl").read_text(encoding="utf-8").strip()
    assert q_content == ""
    events = [json.loads(ln)
              for ln in (sr / "journal.jsonl").read_text(encoding="utf-8")
              .strip().splitlines()]
    killed = [e for e in events if e.get("event") == "seed_killed"]
    assert len(killed) == 2


def test_drain_kill_queue_mixed_seeds_only_match_removed(tmp_path):
    repo, sr, env = _setup(tmp_path)
    _run(["append_kill_queue_entry", "2", "crash_give_up", "0.1", "5"],
         repo, env)
    _run(["append_kill_queue_entry", "3", "sustained_regression", "0.3", "8"],
         repo, env)
    _run(["append_kill_queue_entry", "5", "shortcut_quarantine", "0.2", "6"],
         repo, env)

    r = _run(["drain_kill_queue", "3"], repo, env)
    assert r.returncode == 0
    # Only seed 3 should be removed; seeds 2 and 5 remain
    remaining = [json.loads(ln)
                 for ln in (sr / "kill_queue.jsonl")
                 .read_text(encoding="utf-8").strip().splitlines()]
    assert sorted(e["seed_id"] for e in remaining) == [2, 5]
    # Only one seed_killed event, for seed 3
    events = [json.loads(ln)
              for ln in (sr / "journal.jsonl")
              .read_text(encoding="utf-8").strip().splitlines()]
    killed = [e for e in events if e.get("event") == "seed_killed"]
    assert len(killed) == 1
    assert killed[0]["seed_id"] == 3


def test_drain_kill_queue_missing_completed_seed_rc_2(tmp_path):
    repo, sr, env = _setup(tmp_path)
    r = _run(["drain_kill_queue"], repo, env)
    assert r.returncode == 2


def test_drain_kill_queue_session_id_unset_rc_2(tmp_path):
    """W-2: cmd_drain_kill_queue needs SESSION_ID for the downstream
    cmd_append_journal_event call. Fail fast rather than silently
    preserving the queue entry after the inner call fails."""
    repo, sr, env = _setup(tmp_path)
    _run(["append_kill_queue_entry", "3", "crash_give_up", "0.4", "8"], repo, env)
    env.pop("SESSION_ID", None)
    r = _run(["drain_kill_queue", "3"], repo, env)
    assert r.returncode == 2
    assert "SESSION_ID" in r.stderr


def test_drain_kill_queue_ambient_seed_id_does_not_corrupt(tmp_path):
    """T16's append_journal_event auto-injects SEED_ID when set. The
    coordinator's drain_kill_queue must emit seed_killed with the
    QUEUED seed_id (3), not any ambient SEED_ID (99). Enforced by
    `(unset SEED_ID; ...)` subshell wrapping the journal append."""
    repo, sr, env = _setup(tmp_path)
    _run(["append_kill_queue_entry", "3", "crash_give_up", "0.4", "8"], repo, env)
    # Simulate coordinator running with ambient SEED_ID (as if drain is
    # called from within a block-dispatch code path)
    r = _run(["drain_kill_queue", "3"], repo, env, extra_env={"SEED_ID": "99"})
    assert r.returncode == 0, r.stderr
    events = [json.loads(ln)
              for ln in (sr / "journal.jsonl")
              .read_text(encoding="utf-8").strip().splitlines()]
    killed = [e for e in events if e.get("event") == "seed_killed"]
    assert len(killed) == 1
    assert killed[0]["seed_id"] == 3   # NOT 99


def test_drain_kill_queue_malformed_line_preserved(tmp_path):
    """C-3: malformed lines must be PRESERVED across drain (never
    silently deleted — dead-letter partition). The well-formed matching
    entry still drains; the bogus line survives in the queue for
    operator inspection."""
    repo, sr, env = _setup(tmp_path)
    (sr / "kill_queue.jsonl").write_text(
        'not-json-but-looks-like-garbage\n'
        '{"seed_id": 3, "condition": "crash_give_up", "queued_at": "2026-04-24T10:00:00Z", '
        '"final_q": 0.4, "experiments_used": 8}\n',
        encoding="utf-8",
    )
    r = _run(["drain_kill_queue", "3"], repo, env)
    assert r.returncode == 0
    # Journal got the seed-3 kill
    events = [json.loads(ln)
              for ln in (sr / "journal.jsonl")
              .read_text(encoding="utf-8").strip().splitlines()]
    killed = [e for e in events if e.get("event") == "seed_killed"]
    assert len(killed) == 1
    assert killed[0]["seed_id"] == 3
    # Malformed line is preserved; the seed-3 well-formed line is gone
    remaining = (sr / "kill_queue.jsonl").read_text(encoding="utf-8")
    assert "not-json-but-looks-like-garbage" in remaining, \
        "malformed line must be preserved (dead-letter) — never silently dropped"
    assert '"seed_id": 3' not in remaining


def test_drain_kill_queue_concurrent_append_not_dropped(tmp_path):
    """C-1 regression: during drain's unlocked Phase 2, a concurrent
    cmd_append_kill_queue_entry may land a new entry. The merge phase
    must detect it via set-difference vs snapshot and preserve it in
    the rewritten queue — otherwise the W-9 atomicity invariant is
    violated."""
    import threading
    import time
    repo, sr, env = _setup(tmp_path)
    _run(["append_kill_queue_entry", "3", "crash_give_up", "0.4", "8"],
         repo, env)

    drain_rc = {}

    def drain():
        r = _run(["drain_kill_queue", "3"], repo, env)
        drain_rc["rc"] = r.returncode
        drain_rc["stderr"] = r.stderr

    t = threading.Thread(target=drain)
    t.start()
    # Let drain enter its read loop before appending
    time.sleep(0.1)
    r = _run(["append_kill_queue_entry", "5", "shortcut_quarantine", "0.3", "6"],
             repo, env)
    assert r.returncode == 0, r.stderr
    t.join(timeout=30)
    assert drain_rc.get("rc") == 0, drain_rc

    # Seed 5's concurrent-append must survive the drain
    remaining = (sr / "kill_queue.jsonl").read_text(encoding="utf-8").strip()
    seeds_remaining = [json.loads(ln)["seed_id"]
                       for ln in remaining.splitlines() if ln]
    assert 5 in seeds_remaining, \
        f"concurrent append lost — W-9 atomicity violated: {remaining!r}"
    # Seed 3 is drained
    assert 3 not in seeds_remaining


def test_append_kill_queue_zero_seed_rc_2(tmp_path):
    """Seed IDs start at 1; 0 is the 'no seed' sentinel. Regex
    `^[1-9][0-9]*$` rejects it directly."""
    repo, sr, env = _setup(tmp_path)
    r = _run(["append_kill_queue_entry", "0", "crash_give_up", "0.4", "8"],
             repo, env)
    assert r.returncode == 2


def test_drain_kill_queue_non_numeric_completed_seed_rc_2(tmp_path):
    repo, sr, env = _setup(tmp_path)
    r = _run(["drain_kill_queue", "abc"], repo, env)
    assert r.returncode == 2


def test_drain_kill_queue_leading_zero_completed_seed_rc_2(tmp_path):
    """W-5 mirrored: leading-zero completed_seed_id rejected."""
    repo, sr, env = _setup(tmp_path)
    r = _run(["drain_kill_queue", "03"], repo, env)
    assert r.returncode == 2


def test_drain_kill_queue_same_second_applied_at_strictly_after_queued_at(tmp_path):
    """W-6 regression: even without explicit sleep between append
    and drain, applied_at must be strictly > queued_at. The
    implementation bumps applied_ts to queued_at+1s when they
    would otherwise collide at second precision."""
    repo, sr, env = _setup(tmp_path)
    _run(["append_kill_queue_entry", "3", "crash_give_up", "0.42", "8"], repo, env)
    # No sleep — exercise the same-second race directly
    r = _run(["drain_kill_queue", "3"], repo, env)
    assert r.returncode == 0, r.stderr
    events = [json.loads(ln)
              for ln in (sr / "journal.jsonl").read_text(encoding="utf-8").strip().splitlines()]
    killed = [e for e in events if e.get("event") == "seed_killed"]
    assert len(killed) == 1
    # applied_at strictly > queued_at, even with no sleep
    assert killed[0]["queued_at"] < killed[0]["applied_at"], \
        f"applied_at must be strictly after queued_at: {killed[0]}"


def test_drain_kill_queue_preserves_entry_on_field_extraction_failure(tmp_path):
    """Strict condition validation: an entry with valid JSON but missing
    (or non-whitelisted) .condition must be PRESERVED in the queue as a
    dead-letter entry — drain must NOT emit a seed_killed event and must
    NOT substitute a synthetic "unknown" value (§ 5.5 whitelist contract).

    Verifies:
      (a) The entry is still present in kill_queue.jsonl after drain.
      (b) No seed_killed event is written to journal.jsonl.
      (c) drain returns rc=0 (entry preserved, not a fatal error)."""
    repo, sr, env = _setup(tmp_path)
    # Write a line that is valid JSON but missing .condition — this
    # previously triggered the ".condition // 'unknown'" fallback which
    # violated § 5.5. After the fix, jq errors and the dead-letter path
    # fires: entry preserved in queue, no seed_killed emitted.
    (sr / "kill_queue.jsonl").write_text(
        '{"seed_id": 3, "queued_at": "2026-04-24T10:00:00Z"}\n',
        encoding="utf-8",
    )
    r = _run(["drain_kill_queue", "3"], repo, env)
    assert r.returncode == 0, r.stderr
    # (a) Entry preserved in kill_queue.jsonl (dead-letter, not removed)
    queue_lines = (sr / "kill_queue.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(queue_lines) == 1, f"Expected entry preserved in queue, got: {queue_lines}"
    preserved = json.loads(queue_lines[0])
    assert preserved["seed_id"] == 3
    # (b) No seed_killed event in journal
    journal_path = sr / "journal.jsonl"
    if journal_path.exists() and journal_path.stat().st_size > 0:
        events = [json.loads(ln)
                  for ln in journal_path.read_text(encoding="utf-8").strip().splitlines()]
        killed = [e for e in events if e.get("event") == "seed_killed"]
        assert len(killed) == 0, f"Expected no seed_killed event, got: {killed}"
