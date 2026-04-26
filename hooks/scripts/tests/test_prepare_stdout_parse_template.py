"""prepare-stdout-parse.py template regression tests."""
import re
import subprocess
from pathlib import Path


TEMPLATE = Path(__file__).parents[3] / "templates/prepare-stdout-parse.py"


def _materialize(tmp_path, raw_command, direction="minimize", baseline="1.0",
                 metrics_dict=None):
    """Render the template with a single metric into a session-like path."""
    session_root = tmp_path / ".deep-evolve" / "s"
    session_root.mkdir(parents=True)
    script = session_root / "prepare.py"
    text = TEMPLATE.read_text(encoding="utf-8")
    text = text.replace("{{RAW_COMMAND}}", raw_command)
    text = text.replace("{{TIMEOUT}}", "5")
    text = text.replace("{{DIRECTION}}", direction)
    if metrics_dict is None:
        metrics_dict = '"loss": {"pattern": r"loss: ([0-9.]+)", "weight": 1.0}'
    text = text.replace("{{METRICS_DICT}}", metrics_dict)
    text = re.sub(r"BASELINE_SCORE = None", f"BASELINE_SCORE = {baseline}", text)
    script.write_text(text, encoding="utf-8")
    return script


def _score(output):
    m = re.search(r"^score:\s+([0-9.]+)", output, re.MULTILINE)
    assert m, output
    return float(m.group(1))


def test_minimize_missing_metric_is_failure_not_best_score(tmp_path):
    """A missing parse must not be inverted into a high minimization score."""
    script = _materialize(tmp_path, "printf 'no metric here\\n'")
    r = subprocess.run(["python3", str(script)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert _score(r.stdout) == 0.0
    assert "failed_scenarios:   1" in r.stdout


def test_minimize_positive_metric_still_inverts_against_baseline(tmp_path):
    script = _materialize(tmp_path, "printf 'loss: 0.5\\n'")
    r = subprocess.run(["python3", str(script)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert _score(r.stdout) == 2.0


def test_minimize_partial_metric_parse_is_failure_not_inverted_success(tmp_path):
    metrics = (
        '"loss": {"pattern": r"loss: ([0-9.]+)", "weight": 1.0},\n'
        '    "latency": {"pattern": r"latency: ([0-9.]+)", "weight": 1.0}'
    )
    script = _materialize(tmp_path, "printf 'loss: 0.5\\n'",
                          metrics_dict=metrics)
    r = subprocess.run(["python3", str(script)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert _score(r.stdout) == 0.0
    assert "passed_scenarios:   1" in r.stdout
    assert "failed_scenarios:   1" in r.stdout
