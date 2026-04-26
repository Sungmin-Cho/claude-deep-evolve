"""npm package manifest hygiene."""
import json
from pathlib import Path


ROOT = Path(__file__).parents[3]


def test_package_files_exclude_tests_and_pycache_from_hooks_payload():
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    files = pkg["files"]
    assert "hooks/" not in files, (
        "broad hooks/ include ships tests and __pycache__; include hooks.json "
        "and runtime scripts explicitly"
    )
    assert "hooks/hooks.json" in files
    assert "hooks/scripts/*.py" in files
    assert "hooks/scripts/*.sh" in files
