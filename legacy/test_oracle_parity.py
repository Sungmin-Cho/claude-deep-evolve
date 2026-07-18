"""Unix-only oracle checks for the retired Python evaluation surface.

The supported plugin runtime never imports or executes this module.  CI runs it
only in the isolated ``legacy-oracle`` job to retain evidence for migrations.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LEGACY_TEMPLATES = ROOT / "legacy" / "templates"
HOOK_SCRIPTS = ROOT / "hooks" / "scripts"
GOLDEN = ROOT / "tests" / "fixtures" / "runtime" / "harness" / "approved-legacy-score-golden.json"
ENGINE_MARKER = "# ── Evaluation Engine"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _load_module(filename: str):
    path = HOOK_SCRIPTS / filename
    name = f"deep_evolve_legacy_{filename.replace('-', '_').removesuffix('.py')}"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _replace_block(source: str, name: str, value: object, next_heading: str) -> str:
    replacement = f"{name} = {value!r}\n\n{next_heading}"
    pattern = rf"{re.escape(name)} = \{{[\s\S]*?\n\}}\n\n{re.escape(next_heading)}"
    rendered, count = re.subn(pattern, replacement, source, count=1)
    assert count == 1, f"unable to materialize {name}"
    return rendered


def _materialize_stdout(source: str, *, command: str, timeout: int, direction: str,
                        baseline_score: float | None, metrics: dict) -> str:
    rendered = source.replace('RAW_COMMAND = "{{RAW_COMMAND}}"', f"RAW_COMMAND = {command!r}", 1)
    rendered = rendered.replace("TIMEOUT = {{TIMEOUT}}  # seconds", f"TIMEOUT = {timeout}  # seconds", 1)
    rendered = rendered.replace('METRIC_DIRECTION = "{{DIRECTION}}"',
                                f"METRIC_DIRECTION = {direction!r}", 1)
    rendered = rendered.replace("BASELINE_SCORE = None",
                                f"BASELINE_SCORE = {baseline_score!r}", 1)
    return _replace_block(rendered, "METRICS", metrics, ENGINE_MARKER)


def _materialize_test_runner(source: str, *, command: str) -> str:
    rendered = source.replace('TEST_COMMAND = "{{TEST_COMMAND}}"',
                              f"TEST_COMMAND = {command!r}", 1)
    rendered = rendered.replace('COVERAGE_COMMAND = "{{COVERAGE_COMMAND}}"',
                                "COVERAGE_COMMAND = 'null'", 1)
    rendered = rendered.replace('LINT_COMMAND = "{{LINT_COMMAND}}"',
                                "LINT_COMMAND = 'null'", 1)
    rendered = rendered.replace("TIMEOUT = {{TIMEOUT}}", "TIMEOUT = 10", 1)
    return _replace_block(rendered, "WEIGHTS",
                          {"test_pass_rate": 1, "coverage": 0, "lint": 0},
                          ENGINE_MARKER)


def _materialize_scenario(source: str) -> str:
    rendered = source.replace('PROJECT_ROOT / "{{TARGET_DIR}}"',
                              "PROJECT_ROOT / '.'", 1)
    rendered, weight_count = re.subn(
        r"WEIGHTS = \{[\s\S]*?\n\}\n# Normalize",
        "WEIGHTS = {'compatibility': 1}\n# Normalize",
        rendered,
        count=1,
    )
    assert weight_count == 1
    scenario = "\n".join([
        "    Scenario(",
        "        name='legacy-smoke',",
        "        category='compatibility',",
        "        description='oracle-only shell characterization',",
        "        test_command='printf legacy-ok',",
        "        expected_exit=0,",
        "        expected_output='legacy-ok',",
        "    ),",
    ])
    pattern = r"SCENARIOS = \[[\s\S]*?\n\]\n\n# ── Node\.js Module Tests"
    replacement = f"SCENARIOS = [\n{scenario}\n]\n\n# ── Node.js Module Tests"
    rendered, count = re.subn(pattern, replacement, rendered, count=1)
    assert count == 1
    return rendered


def _run_materialized(tmp_path: Path, source: str) -> subprocess.CompletedProcess[str]:
    session = tmp_path / ".deep-evolve" / "session-current"
    session.mkdir(parents=True, exist_ok=True)
    target = session / "prepare.py"
    target.write_text(source, encoding="utf-8", newline="\n")
    return subprocess.run(
        [sys.executable, str(target)],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )


def _render_golden_candidate(candidate: dict) -> bytes:
    """Render the approved fixture's intentionally compact metric rows."""
    assert set(candidate) == {"schema_version", "provenance", "cases"}
    lines = [
        "{",
        f'  "schema_version": {json.dumps(candidate["schema_version"], ensure_ascii=False)},',
        f'  "provenance": {json.dumps(candidate["provenance"], ensure_ascii=False)},',
        '  "cases": [',
    ]
    for case_index, case in enumerate(candidate["cases"]):
        assert list(case) == [
            "name", "direction", "baseline_score", "metrics", "stdout", "expected",
        ]
        lines.extend([
            "    {",
            f'      "name": {json.dumps(case["name"], ensure_ascii=False)},',
            f'      "direction": {json.dumps(case["direction"], ensure_ascii=False)},',
            f'      "baseline_score": {json.dumps(case["baseline_score"])},',
            '      "metrics": {',
        ])
        metrics = list(case["metrics"].items())
        for metric_index, (name, config) in enumerate(metrics):
            assert list(config) == ["pattern", "weight"]
            comma = "," if metric_index + 1 < len(metrics) else ""
            lines.append(
                f'        {json.dumps(name, ensure_ascii=False)}: '
                f'{{ "pattern": {json.dumps(config["pattern"], ensure_ascii=False)}, '
                f'"weight": {json.dumps(config["weight"])} }}{comma}'
            )
        case_comma = "," if case_index + 1 < len(candidate["cases"]) else ""
        lines.extend([
            "      },",
            f'      "stdout": {json.dumps(case["stdout"], ensure_ascii=False)},',
            f'      "expected": {json.dumps(case["expected"], ensure_ascii=False)}',
            f"    }}{case_comma}",
        ])
    lines.extend(["  ]", "}"])
    return ("\n".join(lines) + "\n").encode()


def test_legacy_template_manifest_authenticates_exact_sources_and_engines():
    manifest = json.loads((LEGACY_TEMPLATES / "prepare-template-manifest.json").read_text())
    assert manifest["schema_version"] == "1.0"
    assert sorted(manifest["templates"]) == [
        "prepare-scenario.py",
        "prepare-stdout-parse.py",
        "prepare-test-runner.py",
    ]
    for name, record in manifest["templates"].items():
        raw = (LEGACY_TEMPLATES / name).read_bytes()
        normalized = raw.decode("utf-8").replace("\r\n", "\n")
        marker = normalized.index(ENGINE_MARKER)
        assert _sha256(raw) == record["sha256"]
        assert _sha256(normalized[marker:].encode()) == record["engine_sha256"]


def test_retained_python_oracle_contract_tables_are_intact(monkeypatch):
    monkeypatch.syspath_prepend(str(HOOK_SCRIPTS))
    decide = _load_module("scheduler-decide.py")
    assert decide.ALLOWED_BLOCK == [1, 2, 3, 5, 8]
    assert decide.ALLOWED_DECISION == {"schedule", "kill_then_schedule", "grow_then_schedule"}
    assert decide.REQUIRED_BY_DECISION == {
        "schedule": [], "kill_then_schedule": ["kill_target"],
        "grow_then_schedule": ["new_seed_id"],
    }

    kill = _load_module("kill-conditions.py")
    assert kill.CONDITION_ORDER == [
        "crash_give_up", "sustained_regression", "shortcut_quarantine",
        "budget_exhausted_underperform", "user_requested",
    ]
    borrow = _load_module("borrow-preflight.py")
    assert borrow.REQUIRED_KEYS == {
        "self_seed_id", "self_experiments_used", "candidates", "journal", "forum",
    }
    convergence = _load_module("convergence-detect.py")
    assert convergence.REQUIRED_KEYS == {
        "keeps", "similarities", "inspired_by_map", "cross_seed_borrow_events",
    }
    for filename in [
        "active_seed_state.py", "scheduler-signals.py", "borrow-abandoned-scan.py",
    ]:
        source = (HOOK_SCRIPTS / filename).read_text(encoding="utf-8")
        compile(source, filename, "exec")


def test_stdout_oracle_reproduces_every_approved_score_fixture(tmp_path):
    source = (LEGACY_TEMPLATES / "prepare-stdout-parse.py").read_text(encoding="utf-8")
    golden_bytes = GOLDEN.read_bytes()
    golden = json.loads(golden_bytes)
    candidate = {
        "schema_version": golden["schema_version"],
        "provenance": golden["provenance"],
        "cases": [],
    }
    for index, case in enumerate(golden["cases"]):
        case_root = tmp_path / f"case-{index}"
        case_root.mkdir()
        emitter = case_root / "emit.py"
        emitter.write_text(f"import sys\nsys.stdout.write({case['stdout']!r})\n", encoding="utf-8")
        command = shlex.join([sys.executable, str(emitter)])
        materialized = _materialize_stdout(
            source,
            command=command,
            timeout=10,
            direction=case["direction"],
            baseline_score=case["baseline_score"],
            metrics=case["metrics"],
        )
        result = _run_materialized(case_root, materialized)
        assert result.returncode == 0, result.stderr
        assert result.stdout == case["expected"], case["name"]
        candidate["cases"].append({**case, "expected": result.stdout})

    candidate_bytes = _render_golden_candidate(candidate)
    assert candidate_bytes == golden_bytes, "generated oracle fixture differs byte-for-byte"


def test_other_legacy_templates_materialize_and_execute_in_oracle_job(tmp_path):
    runner_root = tmp_path / "runner"
    runner_root.mkdir()
    emitter = runner_root / "emit.py"
    emitter.write_text("print('Tests: 2 passed, 2 total')\n", encoding="utf-8")
    runner_source = (LEGACY_TEMPLATES / "prepare-test-runner.py").read_text(encoding="utf-8")
    runner = _run_materialized(
        runner_root,
        _materialize_test_runner(runner_source, command=shlex.join([sys.executable, str(emitter)])),
    )
    assert runner.returncode == 0, runner.stderr
    assert "score:              1.000000" in runner.stdout
    assert "passed_scenarios:   2" in runner.stdout

    scenario_root = tmp_path / "scenario"
    scenario_root.mkdir()
    scenario_source = (LEGACY_TEMPLATES / "prepare-scenario.py").read_text(encoding="utf-8")
    scenario = _run_materialized(scenario_root, _materialize_scenario(scenario_source))
    assert scenario.returncode == 0, scenario.stderr
    assert "score:              1.000000" in scenario.stdout
    assert "passed_scenarios:   1" in scenario.stdout
