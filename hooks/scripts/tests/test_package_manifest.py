"""npm package manifest hygiene + cross-file version drift guard.

Asserts the supported version sources stay in lockstep:

  * package.json                                            → "version"
  * .claude-plugin/plugin.json                              → "version"
  * skills/deep-evolve-workflow/SKILL.md frontmatter        → "version"
  * hooks/scripts/deep-evolve-runtime.cjs                  → RUNTIME_VERSION

Drift in any of these caused the v3.3.0–v3.3.2 release-window incident where
SKILL.md frontmatter advertised v3.2.0 while the plugin manifest had moved on.
This test is the safety net the README already promised but had not been
implemented.
"""
import json
import re
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
    assert "hooks/scripts/*.py" not in files
    assert "hooks/scripts/*.sh" not in files
    for adapter in (
        "hooks/scripts/kill-request-writer.sh",
        "hooks/scripts/protect-readonly.sh",
        "hooks/scripts/session-helper.sh",
    ):
        assert adapter in files
    for oracle in (
        "scheduler-signals.py",
        "scheduler-decide.py",
        "kill-conditions.py",
        "borrow-preflight.py",
        "borrow-abandoned-scan.py",
        "convergence-detect.py",
    ):
        assert not any(entry.endswith(oracle) for entry in files)


# === Cross-file version drift guard ============================================


def _read_package_version() -> str:
    return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]


def _read_plugin_manifest_version() -> str:
    return json.loads(
        (ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8")
    )["version"]


_SKILL_VERSION_RE = re.compile(r'^version:\s*"([^"]+)"\s*$', re.MULTILINE)


def _read_skill_version() -> str:
    skill_md = (ROOT / "skills" / "deep-evolve-workflow" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    # SKILL.md frontmatter is between two `---` lines at the file head.
    head, _, _ = skill_md.partition("\n---\n")  # drop body after the second '---'
    # `head` now contains the leading '---' and the YAML frontmatter.
    m = _SKILL_VERSION_RE.search(head)
    assert m, "SKILL.md frontmatter must declare a quoted `version: \"X.Y.Z\"` field"
    return m.group(1)


_RUNTIME_VERSION_RE = re.compile(
    r"^const RUNTIME_VERSION = require\('\.\./\.\./package\.json'\)\.version;\s*$",
    re.MULTILINE,
)


def _read_runtime_version() -> str:
    runtime = (ROOT / "hooks" / "scripts" / "deep-evolve-runtime.cjs").read_text(
        encoding="utf-8"
    )
    m = _RUNTIME_VERSION_RE.search(runtime)
    assert m, "deep-evolve-runtime.cjs must declare RUNTIME_VERSION"
    return _read_package_version()


def test_plugin_and_package_versions_match():
    plugin_v = _read_plugin_manifest_version()
    pkg_v = _read_package_version()
    assert plugin_v == pkg_v, (
        f".claude-plugin/plugin.json version={plugin_v!r} drifted from "
        f"package.json version={pkg_v!r}; bump both together."
    )


def test_skill_md_version_matches_plugin_manifest():
    plugin_v = _read_plugin_manifest_version()
    skill_v = _read_skill_version()
    assert skill_v == plugin_v, (
        f"skills/deep-evolve-workflow/SKILL.md frontmatter version={skill_v!r} "
        f"drifted from .claude-plugin/plugin.json version={plugin_v!r}; bump "
        f"SKILL.md frontmatter whenever the plugin ships."
    )


def test_runtime_version_matches_plugin_manifest():
    plugin_v = _read_plugin_manifest_version()
    runtime_v = _read_runtime_version()
    assert runtime_v == plugin_v, (
        f"hooks/scripts/deep-evolve-runtime.cjs RUNTIME_VERSION={runtime_v!r} drifted "
        f"from .claude-plugin/plugin.json version={plugin_v!r}; bump "
        f"RUNTIME_VERSION whenever the plugin ships."
    )
