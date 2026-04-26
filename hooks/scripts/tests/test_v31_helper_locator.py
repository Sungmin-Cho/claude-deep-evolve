"""Helper path resolution must work in both dev-repo and plugin-cache layouts."""
import os, subprocess
from pathlib import Path

HELPER = Path(__file__).parents[3] / "hooks/scripts/session-helper.sh"


def test_env_var_takes_precedence(tmp_path):
    """DEEP_EVOLVE_HELPER_PATH (when set to an existing file) must be returned verbatim."""
    fake = tmp_path / "fake-helper.sh"
    fake.write_text("#!/bin/bash\necho fake")
    fake.chmod(0o755)
    env = os.environ.copy()
    env["DEEP_EVOLVE_HELPER_PATH"] = str(fake)
    r = subprocess.run(["bash", str(HELPER), "resolve_helper_path"],
                       env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == str(fake)


def test_realpath_fallback_finds_self():
    """When env var unset, helper resolves to its own path via realpath."""
    env = os.environ.copy()
    env.pop("DEEP_EVOLVE_HELPER_PATH", None)
    r = subprocess.run(["bash", str(HELPER), "resolve_helper_path"],
                       env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    # Should resolve to session-helper.sh path (absolute)
    resolved = r.stdout.strip()
    assert resolved.endswith("session-helper.sh")
    assert Path(resolved).is_absolute()
    assert Path(resolved).is_file()


def test_env_var_pointing_to_nonexistent_file_falls_back():
    """If env var is set but file doesn't exist, fall back to realpath (don't fail silently)."""
    env = os.environ.copy()
    env["DEEP_EVOLVE_HELPER_PATH"] = "/nonexistent/helper.sh"
    r = subprocess.run(["bash", str(HELPER), "resolve_helper_path"],
                       env=env, capture_output=True, text=True)
    # Implementation choice: warn + fallback (not fail), since dev-repo dogfood
    # may have env var set to a stale path
    assert r.returncode == 0
    resolved = r.stdout.strip()
    assert resolved.endswith("session-helper.sh")
    assert "/nonexistent" not in resolved


def test_env_var_pointing_to_directory_falls_back(tmp_path):
    """Env var pointing to a directory must fall back to realpath (I-1 fix)."""
    env = os.environ.copy()
    env["DEEP_EVOLVE_HELPER_PATH"] = str(tmp_path)  # directory, not file
    r = subprocess.run(["bash", str(HELPER), "resolve_helper_path"],
                       env=env, capture_output=True, text=True)
    assert r.returncode == 0
    resolved = r.stdout.strip()
    assert resolved.endswith("session-helper.sh")
    assert str(tmp_path) not in resolved


def test_env_var_empty_string_falls_back():
    """Empty env var (e.g. from `export FOO=`) must fall through to realpath (M-4)."""
    env = os.environ.copy()
    env["DEEP_EVOLVE_HELPER_PATH"] = ""
    r = subprocess.run(["bash", str(HELPER), "resolve_helper_path"],
                       env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    resolved = r.stdout.strip()
    assert resolved.endswith("session-helper.sh")
    assert Path(resolved).is_file()
