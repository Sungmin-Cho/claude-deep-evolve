"""protect-readonly.sh active-session guard regressions."""
import json
import os
import subprocess
from pathlib import Path


GUARD = Path(__file__).parents[3] / "hooks/scripts/protect-readonly.sh"


def _active_session(tmp_path):
    project = tmp_path / "p"
    session_root = project / ".deep-evolve" / "s"
    (session_root / "worktrees" / "seed_1").mkdir(parents=True)
    (project / ".deep-evolve" / "current.json").write_text(
        json.dumps({"session_id": "s"}), encoding="utf-8"
    )
    (session_root / "session.yaml").write_text("status: active\n", encoding="utf-8")
    (session_root / "prepare.py").write_text("SECRET = 1\n", encoding="utf-8")
    (session_root / "prepare-protocol.md").write_text("SECRET\n", encoding="utf-8")
    (session_root / "worktrees" / "seed_1" / "program.md").write_text(
        "seed program\n", encoding="utf-8"
    )
    return project, session_root


def _run_guard(project, payload, tool_name, extra_env=None):
    env = os.environ.copy()
    env.update(extra_env or {})
    env["CLAUDE_TOOL_USE_TOOL_NAME"] = tool_name
    return subprocess.run(
        ["bash", str(GUARD)],
        input=json.dumps(payload),
        cwd=project,
        env=env,
        capture_output=True,
        text=True,
    )


def test_seal_prepare_blocks_bash_cat_of_prepare(tmp_path):
    project, session_root = _active_session(tmp_path)
    r = _run_guard(
        project,
        {"command": f"cat {session_root}/prepare.py"},
        "Bash",
        {"DEEP_EVOLVE_SEAL_PREPARE": "1"},
    )
    assert r.returncode == 2
    assert "seal_prepare_read" in r.stdout


def test_seal_prepare_blocks_bash_dd_read_of_prepare(tmp_path):
    project, session_root = _active_session(tmp_path)
    r = _run_guard(
        project,
        {"command": f"dd if={session_root}/prepare.py of=/dev/null bs=1 count=1"},
        "Bash",
        {"DEEP_EVOLVE_SEAL_PREPARE": "1"},
    )
    assert r.returncode == 2
    assert "seal_prepare_read" in r.stdout


def test_seal_prepare_blocks_python_open_read_of_prepare(tmp_path):
    project, session_root = _active_session(tmp_path)
    r = _run_guard(
        project,
        {"command": (
            "python3 -c \"from pathlib import Path; "
            f"Path(r'{session_root}/prepare.py').read_text()\""
        )},
        "Bash",
        {"DEEP_EVOLVE_SEAL_PREPARE": "1"},
    )
    assert r.returncode == 2
    assert "seal_prepare_read" in r.stdout


def test_active_session_blocks_write_to_seed_program_md(tmp_path):
    project, session_root = _active_session(tmp_path)
    seed_program = session_root / "worktrees" / "seed_1" / "program.md"
    r = _run_guard(project, {"file_path": str(seed_program)}, "Write")
    assert r.returncode == 2
    assert "program.md" in r.stdout or "평가 harness" in r.stdout


def test_active_session_blocks_bash_truncate_of_seed_program_md(tmp_path):
    project, session_root = _active_session(tmp_path)
    seed_program = session_root / "worktrees" / "seed_1" / "program.md"
    r = _run_guard(project, {"command": f"truncate -s 0 {seed_program}"}, "Bash")
    assert r.returncode == 2
    assert "program.md" in r.stdout or "평가 harness" in r.stdout


def test_active_session_blocks_bash_python_write_to_seed_program_md(tmp_path):
    project, session_root = _active_session(tmp_path)
    seed_program = session_root / "worktrees" / "seed_1" / "program.md"
    r = _run_guard(
        project,
        {"command": (
            "python3 -c \"from pathlib import Path; "
            f"Path(r'{seed_program}').write_text('x')\""
        )},
        "Bash",
    )
    assert r.returncode == 2
    assert "program.md" in r.stdout or "평가 harness" in r.stdout


def test_seal_prepare_allows_executing_prepare_py(tmp_path):
    project, session_root = _active_session(tmp_path)
    r = _run_guard(
        project,
        {"command": f"python3 {session_root}/prepare.py"},
        "Bash",
        {"DEEP_EVOLVE_SEAL_PREPARE": "1"},
    )
    assert r.returncode == 0
