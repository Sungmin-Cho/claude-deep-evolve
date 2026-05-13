"""npm package manifest hygiene + cross-file version drift guard.

Asserts the four version sources stay in lockstep, as promised in README §
3.1.1 ("test_package_manifest.py asserts package.json / plugin.json /
SKILL.md / HELPER_VERSION synchronization"):

  * package.json                                            → "version"
  * .claude-plugin/plugin.json                              → "version"
  * skills/deep-evolve-workflow/SKILL.md frontmatter        → "version"
  * hooks/scripts/session-helper.sh                         → HELPER_VERSION

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
    assert "hooks/scripts/*.py" in files
    assert "hooks/scripts/*.sh" in files


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


_HELPER_VERSION_RE = re.compile(r'^HELPER_VERSION="([^"]+)"\s*$', re.MULTILINE)


def _read_helper_version() -> str:
    helper = (ROOT / "hooks" / "scripts" / "session-helper.sh").read_text(
        encoding="utf-8"
    )
    m = _HELPER_VERSION_RE.search(helper)
    assert m, "session-helper.sh must declare HELPER_VERSION=\"X.Y.Z\""
    return m.group(1)


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


def test_helper_version_matches_plugin_manifest():
    plugin_v = _read_plugin_manifest_version()
    helper_v = _read_helper_version()
    assert helper_v == plugin_v, (
        f"hooks/scripts/session-helper.sh HELPER_VERSION={helper_v!r} drifted "
        f"from .claude-plugin/plugin.json version={plugin_v!r}; bump "
        f"HELPER_VERSION whenever the plugin ships."
    )
