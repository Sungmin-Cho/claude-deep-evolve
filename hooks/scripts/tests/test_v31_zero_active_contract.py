"""Canonical zero-active state is consumed consistently across every v3.1 surface."""

import json
import shutil
import subprocess
from pathlib import Path

import yaml


ROOT = Path(__file__).parents[3]
STATUS = ROOT / "hooks/scripts/status-dashboard.py"
SIGNALS = ROOT / "hooks/scripts/scheduler-signals.py"
DECIDE = ROOT / "hooks/scripts/scheduler-decide.py"
ACTIVE_STATE = ROOT / "hooks/scripts/active_seed_state.py"
PROTOCOLS = ROOT / "skills/deep-evolve-workflow/protocols"
LEGACY_FIXTURES = ROOT / "tests/fixtures/runtime/legacy"


def _terminal_session(tmp_path):
    session = {
        "session_id": "zero-active",
        "deep_evolve_version": "3.4.3",
        "status": "active",
        "created_at": "2026-07-12T00:00:00Z",
        "virtual_parallel": {
            "n_initial": 2,
            "x-active-seed-count": 0,
            "budget_total": 8,
            "budget_unallocated": 2,
            "seeds": [
                {
                    "id": 1, "status": "killed_budget_exhausted_underperform",
                    "direction": "A", "allocated_budget": 4, "experiments_used": 4,
                },
                {
                    "id": 2, "status": "completed_early", "direction": "B",
                    "allocated_budget": 4, "experiments_used": 2,
                },
            ],
        },
        "evaluation_epoch": {"current": 2, "history": []},
    }
    session_path = tmp_path / "session.yaml"
    session_path.write_text(yaml.safe_dump(session, sort_keys=False), encoding="utf-8")
    journal = tmp_path / "journal.jsonl"
    journal.write_text("", encoding="utf-8")
    forum = tmp_path / "forum.jsonl"
    forum.write_text("", encoding="utf-8")
    return session_path, journal, forum


def _run(script, session_path, journal, forum):
    return subprocess.run(
        ["python3", str(script), "--session-yaml", str(session_path),
         "--journal", str(journal), "--forum", str(forum)],
        capture_output=True, text=True,
    )


def test_shared_contract_reports_exact_zero_and_no_schedulable_ids(tmp_path):
    session_path, _, _ = _terminal_session(tmp_path)
    result = subprocess.run(
        ["python3", str(ACTIVE_STATE), "--session-yaml", str(session_path), "--json"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    state = json.loads(result.stdout)
    assert state == {
        "active_seed_count": 0,
        "schedulable_seed_ids": [],
        "zero_active": True,
    }


def test_status_explicitly_reports_zero_while_retaining_terminal_history(tmp_path):
    session_path, journal, forum = _terminal_session(tmp_path)
    result = _run(STATUS, session_path, journal, forum)
    assert result.returncode == 0, result.stderr
    assert "Active seeds: 0" in result.stdout
    assert "Terminal seeds:" in result.stdout
    assert "[1]" in result.stdout and "[2]" in result.stdout
    assert "\nSeed:\n" not in result.stdout


def test_scheduler_emits_zero_and_validator_rejects_every_terminal_choice(tmp_path):
    session_path, journal, forum = _terminal_session(tmp_path)
    result = _run(SIGNALS, session_path, journal, forum)
    assert result.returncode == 0, result.stderr
    signals = json.loads(result.stdout)
    assert signals["n_current"] == 0
    assert signals["active_seed_count"] == 0
    assert signals["schedulable_seed_ids"] == []
    assert [seed["status"] for seed in signals["seeds"]] == [
        "killed_budget_exhausted_underperform", "completed_early",
    ]

    for decision_type in ("schedule", "kill_then_schedule", "grow_then_schedule"):
        decision = {
            "decision": decision_type,
            "chosen_seed_id": 1,
            "block_size": 1,
            "reasoning": "must not dispatch",
            "signals_used": [],
        }
        if decision_type == "kill_then_schedule":
            decision["kill_target"] = 2
        if decision_type == "grow_then_schedule":
            decision["new_seed_id"] = 3
        rejected = subprocess.run(
            ["python3", str(DECIDE), "--decision", json.dumps(decision),
             "--signals", json.dumps(signals)],
            capture_output=True, text=True,
        )
        assert rejected.returncode == 1, (decision_type, rejected.stderr, rejected.stdout)
        payload = json.loads(rejected.stdout)
        assert payload["accepted"] is False
        assert "active" in payload["reason"].lower()


def test_coordinator_checks_zero_before_ai_or_dispatch():
    content = (PROTOCOLS / "coordinator.md").read_text(encoding="utf-8")
    collect = content.index("# 1. Collect signals")
    zero_gate = content.index("signals.active_seed_count == 0", collect)
    ai = content.index("invoke_AI_for_decision", collect)
    dispatch = content.index("dispatch_seed", collect)
    assert collect < zero_gate < ai < dispatch
    gate = content[zero_gate:ai]
    assert "synthesis" in gate.lower()


def test_synthesis_zero_branch_precedes_n1_and_cannot_select_seed_one():
    content = (PROTOCOLS / "synthesis.md").read_text(encoding="utf-8")
    assert "active_seed_state.py" in content
    zero_start = content.index("## § N=0 / No-active Short-Circuit")
    n1_start = content.index("## § N=1 Short-Circuit")
    assert zero_start < n1_start
    zero = content[zero_start:n1_start]
    assert 'SYNTHESIS_OUTCOME="no_baseline"' in zero
    assert 'FINAL_BRANCH="main"' in zero
    assert "baseline_seed_id: null" in zero
    assert "seed-1" not in zero
    assert "CHOSEN_SEED_ID=1" not in zero
    top_gate = content[:content.index("## Step 1")]
    assert top_gate.index('N_CURRENT" = "0"') < top_gate.index('N_CURRENT" = "1"')


def test_single_active_synthesis_selects_the_actual_nonfirst_seed(tmp_path):
    session = {
        "session_id": "single-active-two",
        "virtual_parallel": {
            "n_current": 1,
            "seeds": [
                {"id": 1, "status": "killed_budget_exhausted_underperform", "final_q": 0.91},
                {"seed_id": 2, "status": "active", "final_q": 0.42},
            ],
        },
    }
    session_path = tmp_path / "session.yaml"
    session_path.write_text(yaml.safe_dump(session, sort_keys=False), encoding="utf-8")
    result = subprocess.run(
        ["python3", str(ACTIVE_STATE), "--session-yaml", str(session_path), "--single-json"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"seed_id": 2, "final_q": 0.42}

    content = (PROTOCOLS / "synthesis.md").read_text(encoding="utf-8")
    n1_start = content.index("## § N=1 Short-Circuit")
    n1_end = content.index("## § no_baseline Short-Circuit", n1_start)
    n1 = content[n1_start:n1_end]
    assert "--single-json" in n1
    assert 'FINAL_BRANCH="evolve/${SESSION_ID}/seed-${CHOSEN_SEED_ID}"' in n1
    assert "seeds[0]" not in n1
    assert 'CHOSEN_SEED_ID=1' not in n1
    assert '--argjson bid "$CHOSEN_SEED_ID"' in n1


def test_positive_legacy_seed_id_fixtures_remain_schedulable_across_consumers(tmp_path):
    fixture_sessions = [LEGACY_FIXTURES / "borrow/session.yaml"]
    fixture_sessions.extend(sorted((LEGACY_FIXTURES / "kill").glob("*/session.yaml")))
    assert fixture_sessions

    for index, source in enumerate(fixture_sessions):
        case = tmp_path / f"case-{index}"
        case.mkdir()
        session_path = case / "session.yaml"
        shutil.copyfile(source, session_path)
        source_journal = source.with_name("journal.jsonl")
        source_forum = source.with_name("forum.jsonl")
        journal = case / "journal.jsonl"
        forum = case / "forum.jsonl"
        if source_journal.exists():
            shutil.copyfile(source_journal, journal)
        else:
            journal.write_text("", encoding="utf-8")
        if source_forum.exists():
            shutil.copyfile(source_forum, forum)
        else:
            forum.write_text("", encoding="utf-8")

        before = session_path.read_bytes()
        parsed = yaml.safe_load(before)
        expected_ids = [int(seed["seed_id"])
                        for seed in parsed["virtual_parallel"]["seeds"]]

        active_result = subprocess.run(
            ["python3", str(ACTIVE_STATE), "--session-yaml", str(session_path), "--json"],
            capture_output=True, text=True,
        )
        assert active_result.returncode == 0, (source, active_result.stderr)
        active = json.loads(active_result.stdout)
        assert active == {
            "active_seed_count": len(expected_ids),
            "schedulable_seed_ids": expected_ids,
            "zero_active": False,
        }

        signals_result = _run(SIGNALS, session_path, journal, forum)
        assert signals_result.returncode == 0, (source, signals_result.stderr)
        signals = json.loads(signals_result.stdout)
        assert signals["active_seed_count"] == len(expected_ids)
        assert signals["schedulable_seed_ids"] == expected_ids
        assert [seed["id"] for seed in signals["seeds"]] == expected_ids

        status_result = _run(STATUS, session_path, journal, forum)
        assert status_result.returncode == 0, (source, status_result.stderr)
        assert f"Active seeds: {len(expected_ids)}" in status_result.stdout
        for seed_id in expected_ids:
            assert f"[{seed_id}]" in status_result.stdout
        assert "Terminal seeds:" not in status_result.stdout

        decision = {
            "decision": "schedule",
            "chosen_seed_id": expected_ids[0],
            "block_size": 1,
            "reasoning": "legacy positive fixture remains schedulable",
            "signals_used": ["active_seed_count"],
        }
        decided = subprocess.run(
            ["python3", str(DECIDE), "--decision", json.dumps(decision),
             "--signals", json.dumps(signals)],
            capture_output=True, text=True,
        )
        assert decided.returncode == 0, (source, decided.stderr, decided.stdout)
        assert json.loads(decided.stdout)["accepted"] is True
        assert session_path.read_bytes() == before

    coordinator = (PROTOCOLS / "coordinator.md").read_text(encoding="utf-8")
    resume = (PROTOCOLS / "resume.md").read_text(encoding="utf-8")
    synthesis = (PROTOCOLS / "synthesis.md").read_text(encoding="utf-8")
    assert "scheduler-signals.py" in coordinator
    assert "signals.active_seed_count == 0" in coordinator
    assert "active_seed_state.py" in resume
    assert "ACTIVE_SEED_COUNT > 0" in resume
    assert "protocols/coordinator.md" in resume[resume.index("ACTIVE_SEED_COUNT > 0"):]
    assert "--single-json" in synthesis


def test_seed_identity_aliases_are_integral_unique_and_fail_closed(tmp_path):
    def run_active(seeds):
        session_path = tmp_path / "session.yaml"
        session_path.write_text(yaml.safe_dump({
            "session_id": "identity-aliases",
            "virtual_parallel": {"seeds": seeds},
        }, sort_keys=False), encoding="utf-8")
        return subprocess.run(
            ["python3", str(ACTIVE_STATE), "--session-yaml", str(session_path), "--json"],
            capture_output=True, text=True,
        )

    integral = run_active([
        {"seed_id": 2.0, "status": "active"},
        {"id": 3, "seed_id": 3.0, "status": "active"},
    ])
    assert integral.returncode == 0, integral.stderr
    assert json.loads(integral.stdout)["schedulable_seed_ids"] == [2, 3]

    conflicting = run_active([{"id": 1, "seed_id": 2, "status": "active"}])
    assert conflicting.returncode == 2
    assert "conflict" in conflicting.stderr.lower()

    duplicate = run_active([
        {"id": 1, "status": "active"},
        {"seed_id": 1, "status": "active"},
    ])
    assert duplicate.returncode == 2
    assert "duplicate" in duplicate.stderr.lower()


def test_consumer_entrypoints_sanitize_identity_errors_as_rc2(tmp_path):
    cases = [
        ([{"status": "active"}], "seed entry is missing id/seed_id"),
        ([{"id": 1, "seed_id": 2, "status": "active"}],
         "seed id and seed_id conflict"),
        ([{"id": 1, "status": "active"},
          {"seed_id": 1, "status": "active"}],
         "duplicate seed identity: 1"),
    ]
    journal = tmp_path / "journal.jsonl"
    forum = tmp_path / "forum.jsonl"
    journal.write_text("", encoding="utf-8")
    forum.write_text("", encoding="utf-8")

    for index, (seeds, diagnostic) in enumerate(cases):
        session_path = tmp_path / f"session-{index}.yaml"
        session_path.write_text(yaml.safe_dump({
            "session_id": f"bad-identity-{index}",
            "virtual_parallel": {"seeds": seeds},
        }, sort_keys=False), encoding="utf-8")
        for script in (STATUS, SIGNALS):
            result = _run(script, session_path, journal, forum)
            assert result.returncode == 2, (script, result.stderr, result.stdout)
            assert result.stdout == ""
            assert result.stderr == f"error: {diagnostic}\n"
            assert "Traceback" not in result.stderr


def test_resume_adaptive_n_and_transfer_share_the_zero_contract():
    resume = (PROTOCOLS / "resume.md").read_text(encoding="utf-8")
    assert "active_seed_state.py" in resume
    assert "ACTIVE_SEED_COUNT" in resume
    assert re_order(resume, "ACTIVE_SEED_COUNT", "protocols/coordinator.md")
    assert "synthesis.md" in resume[resume.index("ACTIVE_SEED_COUNT"):]

    outer = (PROTOCOLS / "outer-loop.md").read_text(encoding="utf-8")
    section = outer[outer.index("### 6.5.0.3"):outer.index("### 6.5.0 Summary")]
    assert "active_seed_state.py" in section
    assert 'ACTIVE_SEED_COUNT" = "0"' in section
    assert "skip adaptive N" in section

    transfer = (PROTOCOLS / "transfer.md").read_text(encoding="utf-8")
    assert "x-active-seed-count" in transfer
    assert "exactly one" in transfer.lower()
    assert "n_current" in transfer


def re_order(content, first, second):
    return content.index(first) < content.index(second)
