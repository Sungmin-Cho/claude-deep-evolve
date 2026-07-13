"""pytest suite for v3 session-helper subcommands."""

import json
import os
import re
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).parents[3]
HELPER = ROOT / "hooks/scripts/session-helper.sh"
ORACLE = ROOT / "legacy/session-helper-v3.4.3.sh"
RUNTIME = ROOT / "hooks/scripts/deep-evolve-runtime.cjs"

NATIVE_TASK3_ARMS = {
    "help": [],
    "compute_session_id": ["Compatibility Goal"],
    "resolve_current": [],
    "list_sessions": [],
    "start_new_session": ["--dry-run", "Compatibility Goal"],
    "mark_session_status": ["--dry-run", "missing-session", "active"],
    "append_sessions_jsonl": ["--dry-run", "event", "session-1", "--detail=value"],
    "migrate_legacy": [],
    "check_branch_alignment": ["."],
    "detect_orphan_experiment": ["."],
    "append_meta_archive_local": ["missing-session"],
    "render_inherited_context": ["missing-parent"],
    "lineage_tree": [],
    "resolve_helper_path": [],
    "append_seed_to_session_yaml": ["1", "/tmp/worktree", "branch", "{}"],
    "set_virtual_parallel_field": ["n_current", "2"],
    "init_virtual_parallel_block": [
        '{"project_type":"standard","eval_parallelizability":"parallel"}', "2", "10",
    ],
    "rebuild_seeds_from_journal": [],
}

TASK5_NATIVE_ARMS = [
    "create_seed_worktree",
    "validate_seed_worktree",
    "remove_seed_worktree",
    "create_synthesis_worktree",
    "cleanup_failed_synthesis_worktree",
]


def _tree_snapshot(root: Path):
    result = {}
    for path_ in sorted(root.rglob("*")):
        relative = path_.relative_to(root).as_posix()
        if path_.is_dir():
            result[relative + "/"] = "<directory>"
        elif path_.is_file():
            result[relative] = path_.read_bytes()
        else:
            result[relative] = "<special>"
    return result


def _normalize_jq_diagnostic(text: str):
    """Canonicalize only the two jq renderer dialects exercised by v3 parity."""
    index_error = None
    for key_form in (r'"(?P<key>[^"\n]+)"', r'\("(?P<key>[^"\n]+)"\)'):
        index_error = re.fullmatch(
            r'jq: error \(at (?P<path>.+):(?P<line>\d+)\): '
            r'Cannot index (?P<kind>[A-Za-z]+) with string '
            f'{key_form}\\n?',
            text,
        )
        if index_error:
            break
    if index_error:
        fields = index_error.groupdict()
        return (
            f'jq: error (at {fields["path"]}:{fields["line"]}): '
            f'Cannot index {fields["kind"]} with string "{fields["key"]}"\n'
        )

    compile_error = None
    compile_dialects = (
        (
            r'jq: error: (?P<key>[A-Za-z_][A-Za-z0-9_-]*)/0 is not defined '
            r'at <top-level>, line (?P<line>\d+):\n'
            r'\{event:\$event, ts:\$ts, session_id:\$sid\}[ \t]+\+ '
            r'\{\((?P=key)\): \$(?P=key)\}[ \t]*\n'
            r'jq: (?P<count>\d+) compile error\n?'
        ),
        (
            r'jq: error: (?P<key>[A-Za-z_][A-Za-z0-9_-]*)/0 is not defined '
            r'at <top-level>, line (?P<line>\d+), column \d+:\n'
            r'[ \t]+\{event:\$event, ts:\$ts, session_id:\$sid\}[ \t]+\+ '
            r'\{\((?P=key)\): \$(?P=key)\}[ \t]*\n'
            r'[ \t]+\^+[ \t]*\n'
            r'jq: (?P<count>\d+) compile error\n?'
        ),
    )
    for dialect in compile_dialects:
        compile_error = re.fullmatch(dialect, text)
        if compile_error:
            break
    if compile_error:
        fields = compile_error.groupdict()
        return (
            f'jq: error: {fields["key"]}/0 is not defined at <top-level>, '
            f'line {fields["line"]}\n'
            f'jq: {fields["count"]} compile error\n'
        )
    return text


def _normalize_probe(text: str, root: Path):
    import re

    normalized = text.replace(str(root), "<PROJECT>")
    normalized = normalized.replace(str(HELPER), "<HELPER>")
    normalized = normalized.replace(str(ORACLE), "<HELPER>")
    normalized = re.sub(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z",
        "<TIMESTAMP>",
        normalized,
    )
    normalized = re.sub(
        r"legacy-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[A-Za-z0-9._-]+",
        "<LEGACY_SESSION>",
        normalized,
    )
    return _normalize_jq_diagnostic(normalized)


def test_jq_diagnostic_canonicalization_is_narrow_and_semantic():
    """Portable parity ignores jq renderer drift, not error class/key/path/line."""
    node_index = (
        'jq: error (at <PROJECT>/.deep-evolve/sessions.jsonl:1): '
        'Cannot index array with string "event"\n'
    )
    macos_index = (
        'jq: error (at <PROJECT>/.deep-evolve/sessions.jsonl:1): '
        'Cannot index array with string ("event")\n'
    )
    node_compile = (
        'jq: error: detail/0 is not defined at <top-level>, line 1:\n'
        '{event:$event, ts:$ts, session_id:$sid}  + {(detail): $detail}                                             \n'
        'jq: 1 compile error\n'
    )
    macos_compile = (
        'jq: error: detail/0 is not defined at <top-level>, line 1, column 46:\n'
        '    {event:$event, ts:$ts, session_id:$sid}  + {(detail): $detail}\n'
        '                                                 ^^^^^^\n'
        'jq: 1 compile error\n'
    )

    assert _normalize_jq_diagnostic(node_index) == _normalize_jq_diagnostic(macos_index)
    assert _normalize_jq_diagnostic(node_compile) == _normalize_jq_diagnostic(macos_compile)
    assert 'sessions.jsonl:1' in _normalize_jq_diagnostic(node_index)
    assert 'array' in _normalize_jq_diagnostic(node_index)
    assert '"event"' in _normalize_jq_diagnostic(node_index)
    assert 'detail/0' in _normalize_jq_diagnostic(node_compile)
    assert 'line 1' in _normalize_jq_diagnostic(node_compile)

    unrelated_key = node_index.replace('"event"', '"status"')
    unrelated_type = node_index.replace('array', 'object')
    unrelated_path = node_index.replace('sessions.jsonl:1', 'other.jsonl:1')
    unrelated_line = node_compile.replace('line 1', 'line 2')
    unrelated_class = node_compile.replace('is not defined', 'has invalid type')
    opening_only_index = node_index.replace('string "event"', 'string ("event"')
    closing_only_index = node_index.replace('string "event"', 'string "event")')
    column_without_caret = node_compile.replace('line 1:', 'line 1, column 46:')
    caret_without_column = node_compile.replace(
        'jq: 1 compile error\n',
        '                                                 ^^^^^^\n'
        'jq: 1 compile error\n',
    )
    assert _normalize_jq_diagnostic(node_index) != _normalize_jq_diagnostic(unrelated_key)
    assert _normalize_jq_diagnostic(node_index) != _normalize_jq_diagnostic(unrelated_type)
    assert _normalize_jq_diagnostic(node_index) != _normalize_jq_diagnostic(unrelated_path)
    assert _normalize_jq_diagnostic(node_compile) != _normalize_jq_diagnostic(unrelated_line)
    assert _normalize_jq_diagnostic(node_compile) != _normalize_jq_diagnostic(unrelated_class)
    assert _normalize_jq_diagnostic(opening_only_index) != _normalize_jq_diagnostic(node_index)
    assert _normalize_jq_diagnostic(closing_only_index) != _normalize_jq_diagnostic(node_index)
    assert _normalize_jq_diagnostic(column_without_caret) != _normalize_jq_diagnostic(node_compile)
    assert _normalize_jq_diagnostic(caret_without_column) != _normalize_jq_diagnostic(node_compile)


def _run_compatibility(script: Path, root: Path, args, env):
    return subprocess.run(
        ["bash", str(script), *args],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )


def _valid_native_session(session_id="s1"):
    return {
        "session_id": session_id,
        "deep_evolve_version": "3.4.3",
        "status": "active",
        "created_at": "2026-07-12T00:00:00Z",
        "goal": "Compatibility Goal",
        "lineage": {"current_branch": "main"},
    }


def _write_native_session(root: Path, session_id="s1"):
    evolve = root / ".deep-evolve"
    session_root = evolve / session_id
    session_root.mkdir(parents=True, exist_ok=True)
    (session_root / "session.yaml").write_text(
        "\n".join([
            f"session_id: {session_id}",
            'deep_evolve_version: "3.4.3"',
            "status: active",
            'created_at: "2026-07-12T00:00:00Z"',
            'goal: "Compatibility Goal"',
            "lineage:",
            "  current_branch: main",
            "",
        ]),
    )
    return session_root


def _setup_native_parity_case(root: Path, arm: str, variant: str):
    env = os.environ.copy()
    for key in ("SESSION_ROOT", "SESSION_ID", "DEEP_EVOLVE_HELPER_PATH"):
        env.pop(key, None)
    args = []

    if arm == "help":
        if variant == "dry-run":
            args = ["--dry-run"]
    elif arm == "compute_session_id":
        args = ["Compatibility Goal"]
        (root / ".deep-evolve").mkdir()
        if variant in {"directory-collision", "registry-collision", "registry-directory-collision"}:
            today = subprocess.run(
                ["date", "-u", "+%Y-%m-%d"], capture_output=True, text=True, check=True,
            ).stdout.strip()
            base = f"{today}_compatibility-goal"
            if variant in {"directory-collision", "registry-directory-collision"}:
                (root / ".deep-evolve" / base).mkdir()
            if variant in {"registry-collision", "registry-directory-collision"}:
                (root / ".deep-evolve" / "sessions.jsonl").write_text(
                    json.dumps({"event": "created", "session_id": base}, separators=(",", ":")) + "\n",
                )
    elif arm == "resolve_current":
        (root / ".deep-evolve").mkdir()
        if variant in {"success", "identity-mismatch", "status-reconcile"}:
            _write_native_session(root)
            (root / ".deep-evolve" / "current.json").write_text(json.dumps({"session_id": "s1"}))
            if variant == "identity-mismatch":
                session = root / ".deep-evolve" / "s1" / "session.yaml"
                session.write_text(session.read_text().replace("session_id: s1", "session_id: different-b"))
            elif variant == "status-reconcile":
                session = root / ".deep-evolve" / "s1" / "session.yaml"
                session.write_text(session.read_text().replace("status: active", "status: paused"))
                (root / ".deep-evolve" / "sessions.jsonl").write_text(
                    '{"event":"created","ts":"t1","session_id":"s1","status":"active"}\n',
                )
        elif variant == "null-current":
            (root / ".deep-evolve" / "current.json").write_text('{"session_id":null}\n')
        elif variant == "malformed-current":
            (root / ".deep-evolve" / "current.json").write_text('{"session_id":')
        elif variant == "orphan-pointer":
            (root / ".deep-evolve" / "current.json").write_text('{"session_id":"missing"}\n')
        elif variant == "missing-session-yaml":
            (root / ".deep-evolve" / "current.json").write_text('{"session_id":"s1"}\n')
            (root / ".deep-evolve" / "s1").mkdir()
    elif arm == "list_sessions":
        (root / ".deep-evolve").mkdir()
        if variant == "success":
            records = [
                {"event": "created", "ts": "t1", "session_id": "s1", "status": "active", "goal": "g"},
                {"event": "status_change", "ts": "t2", "session_id": "s1", "status": "paused"},
            ]
            (root / ".deep-evolve" / "sessions.jsonl").write_text(
                "\n".join(json.dumps(value, separators=(",", ":")) for value in records) + "\n",
            )
            args = ["--status=paused"]
        elif variant == "malformed-registry":
            (root / ".deep-evolve" / "sessions.jsonl").write_text("{bad\n")
        elif variant == "non-object-record":
            (root / ".deep-evolve" / "sessions.jsonl").write_text("[]\n")
    elif arm == "start_new_session":
        args = ["Compatibility Goal"]
        if variant == "dry-run":
            args.insert(0, "--dry-run")
        elif variant in {"collision-exhaustion", "dry-run-collision-exhaustion"}:
            evolve = root / ".deep-evolve"
            evolve.mkdir()
            today = subprocess.run(
                ["date", "-u", "+%Y-%m-%d"], capture_output=True, text=True, check=True,
            ).stdout.strip()
            base = f"{today}_compatibility-goal"
            for candidate in [base, *(f"{base}-{suffix}" for suffix in range(2, 1000))]:
                (evolve / candidate).mkdir()
            if variant == "dry-run-collision-exhaustion":
                args.insert(0, "--dry-run")
        elif variant in {"registry-collision", "directory-collision", "registry-directory-collision"}:
            evolve = root / ".deep-evolve"
            evolve.mkdir()
            today = subprocess.run(
                ["date", "-u", "+%Y-%m-%d"], capture_output=True, text=True, check=True,
            ).stdout.strip()
            base = f"{today}_compatibility-goal"
            if variant in {"registry-collision", "registry-directory-collision"}:
                (evolve / "sessions.jsonl").write_text(
                    json.dumps({"event": "created", "session_id": base}, separators=(",", ":")) + "\n",
                )
            if variant == "directory-collision":
                (evolve / base).mkdir()
            elif variant == "registry-directory-collision":
                (evolve / f"{base}-2").mkdir()
        elif variant == "parent":
            args.append("--parent=parent-1")
        elif variant == "malformed-registry":
            evolve = root / ".deep-evolve"
            evolve.mkdir()
            (evolve / "sessions.jsonl").write_text("{bad\n")
    elif arm == "mark_session_status":
        (root / ".deep-evolve").mkdir()
        args = ["s1", "paused"]
        if variant == "dry-run":
            args.insert(0, "--dry-run")
        elif variant == "success":
            _write_native_session(root)
    elif arm == "append_sessions_jsonl":
        (root / ".deep-evolve").mkdir()
        args = ["event", "s1"] if variant == "success" else ["event", "s1", "--detail=value"]
        if variant == "dry-run":
            args = ["--dry-run", "event", "s1"]
    elif arm == "migrate_legacy":
        (root / ".deep-evolve").mkdir()
        if variant in {"success", "dry-run"}:
            (root / ".deep-evolve" / "session.yaml").write_text(
                "session_id: old-flat\ndeep_evolve_version: '3.0.0'\nstatus: active\n"
                "created_at: '2026-01-01T00:00:00Z'\ngoal: Compatibility Goal\n",
            )
            (root / ".deep-evolve" / "journal.jsonl").write_text('{"id":1,"status":"planned"}\n')
        if variant == "dry-run":
            args = ["--dry-run"]
    elif arm == "check_branch_alignment":
        subprocess.run(["git", "init", "-b", "main"], cwd=root, capture_output=True, check=True)
        session_root = root / "session"
        session_root.mkdir()
        expected = "other" if variant == "rejected" else "main"
        (session_root / "session.yaml").write_text(f"lineage:\n  current_branch: {expected}\n")
        args = [str(session_root)]
    elif arm == "detect_orphan_experiment":
        session_root = root / "session"
        session_root.mkdir()
        args = [str(session_root)]
        if variant == "success":
            (session_root / "journal.jsonl").write_text(
                '{"id":1,"status":"committed","commit":"abc123"}\n',
            )
        elif variant == "spaced-json":
            (session_root / "journal.jsonl").write_text(
                json.dumps({"id": 1, "status": "committed", "commit": "abc123"}) + "\n",
            )
    elif arm in {"append_meta_archive_local", "render_inherited_context"}:
        (root / ".deep-evolve").mkdir()
        session_id = "s1"
        args = [session_id]
        if variant in {"success", "dry-run"}:
            session_root = root / ".deep-evolve" / session_id
            session_root.mkdir()
            receipt = {
                "receipt_schema_version": 1,
                "session_id": session_id,
                "goal": "g",
                "timestamp": "2026-07-12T00:00:00Z",
                "outcome": "kept",
                "experiments": {"total": 2, "kept": 1},
                "score": {"baseline": 1, "best": 2, "improvement_pct": 100},
                "strategy_evolution": {"q_trajectory": [0.1, {"Q": 0.2}], "outer_loop_generations": 1},
                "generation_snapshots": [{
                    "strategy_yaml_content": "alpha: 1\nbeta: 2\n",
                    "meta_analysis_content": "First lesson.\n\nSecond.",
                }],
                "notable_keeps": [{
                    "commit": "abc", "score_delta": 0.5, "source": "seed-1", "description": "keep",
                }],
            }
            (session_root / "evolve-receipt.json").write_text(json.dumps(receipt))
        elif variant == "invalid-receipt":
            session_root = root / ".deep-evolve" / session_id
            session_root.mkdir()
            (session_root / "evolve-receipt.json").write_text("{bad\n")
        if variant == "dry-run":
            args.insert(0, "--dry-run")
    elif arm == "lineage_tree":
        (root / ".deep-evolve").mkdir()
        if variant == "success":
            (root / ".deep-evolve" / "sessions.jsonl").write_text(
                '{"event":"created","ts":"t1","session_id":"s1","status":"active","goal":"g"}\n',
            )
    elif arm == "resolve_helper_path":
        if variant == "success":
            fake = root / "same-helper.sh"
            fake.write_text("#!/bin/sh\nexit 0\n")
            fake.chmod(0o755)
            env["DEEP_EVOLVE_HELPER_PATH"] = str(fake)
        else:
            env["DEEP_EVOLVE_HELPER_PATH"] = str(root / "missing-helper.sh")
    elif arm in {
        "append_seed_to_session_yaml", "set_virtual_parallel_field",
        "init_virtual_parallel_block", "rebuild_seeds_from_journal",
    }:
        if variant == "missing-precondition":
            if arm == "append_seed_to_session_yaml":
                args = ["1", "/tmp/worktree", "branch", "{}"]
            elif arm == "set_virtual_parallel_field":
                args = ["n_current", "2"]
            elif arm == "init_virtual_parallel_block":
                args = ['{"project_type":"standard","eval_parallelizability":"parallel"}', "2", "10"]
            return args, env
        session_root = root / "session"
        session_root.mkdir()
        session = _valid_native_session("s1")
        session["virtual_parallel"] = {
            "N": 2, "n_current": 2, "n_initial": 2, "budget_total": 10, "seeds": [],
        }
        (session_root / "session.yaml").write_text(json.dumps(session, indent=2) + "\n")
        if variant == "empty-session":
            (session_root / "session.yaml").write_text("")
        env["SESSION_ROOT"] = str(session_root)
        env["SESSION_ID"] = "s1"
        if arm == "append_seed_to_session_yaml":
            (session_root / "journal.jsonl").write_text(
                '{"event":"seed_initialized","seed_id":1,"ts":"2026-07-12T01:00:00Z"}\n',
            )
            args = ["1", str(root / "worktree"), "branch", '{"direction":"d"}']
            if variant == "invalid-seed":
                args[0] = "not-an-int"
            elif variant == "null-beta":
                args[3] = "null"
            elif variant == "unsafe-integer":
                args[0] = "9007199254740993"
                (session_root / "journal.jsonl").write_text(
                    '{"event":"seed_initialized","seed_id":9007199254740993,'
                    '"ts":"2026-07-12T01:00:00Z"}\n',
                )
            elif variant in {
                "block-safe-boundary", "block-unsafe-boundary",
                "inline-safe-boundary", "inline-unsafe-boundary",
            }:
                boundary = (
                    "9007199254740991"
                    if variant in {"block-safe-boundary", "inline-safe-boundary"}
                    else "9007199254740993"
                )
                if variant.startswith("inline-"):
                    session_text = "\n".join([
                        "session_id: s1",
                        "status: active",
                        "virtual_parallel: {N: 2, n_current: 2, n_initial: 1, "
                        f"budget_total: {boundary}, seeds: []}}",
                        "",
                    ])
                else:
                    session_text = "\n".join([
                        "session_id: s1",
                        "status: active",
                        "virtual_parallel:",
                        "  N: 2",
                        "  n_current: 2",
                        "  n_initial: 1",
                        f"  budget_total: {boundary}",
                        "  seeds: []",
                        "",
                    ])
                (session_root / "session.yaml").write_text(session_text)
            elif variant in {"nested-beta-safe-boundary", "nested-beta-unsafe-boundary"}:
                boundary = (
                    9007199254740991 if variant == "nested-beta-safe-boundary"
                    else 9007199254740993
                )
                args[3] = json.dumps({
                    "direction": {"rank": boundary},
                    "hypothesis": [{"value": boundary}],
                    "rationale": {"nested": {"value": boundary}},
                }, separators=(",", ":"))
        elif arm == "set_virtual_parallel_field":
            args = ["budget_unallocated", "+1"]
            if variant == "unsafe-integer":
                args[1] = "9007199254740993"
        elif arm == "init_virtual_parallel_block":
            args = ['{"project_type":"standard","eval_parallelizability":"parallel"}', "2", "10"]
            if variant == "rejected":
                args[0] = "{bad"
            elif variant == "semantic-rejected":
                args[0] = "{}"
            elif variant == "missing-eval-field":
                args[0] = '{"project_type":"standard"}'
            elif variant == "null-analysis":
                args[0] = "null"
            elif variant == "python-int-spelling":
                args[1] = "+2"
            elif variant == "explicit-null-reasoning":
                args[0] = '{"project_type":"standard","eval_parallelizability":"parallel","reasoning":null}'
            elif variant == "unsafe-budget":
                args[2] = "9007199254740993"
            elif variant in {"nested-analysis-safe-boundary", "nested-analysis-unsafe-boundary"}:
                boundary = (
                    9007199254740991 if variant == "nested-analysis-safe-boundary"
                    else 9007199254740993
                )
                args[0] = json.dumps({
                    "project_type": {"rank": boundary},
                    "eval_parallelizability": [{"limit": boundary}],
                    "reasoning": {"nested": {"value": boundary}},
                }, separators=(",", ":"))
        else:
            seed_token = "1"
            if variant == "integral-float-seed-id":
                seed_token = "1.0"
            elif variant == "boolean-seed-id":
                seed_token = "true"
            events = [
                f'{{"event":"seed_initialized","seed_id":{seed_token},"ts":"2026-07-12T01:00:00Z"}}',
                f'{{"event":"seed_killed","seed_id":{seed_token},"condition":"killedLegacy","ts":"2026-07-12T02:00:00Z"}}',
            ]
            if variant == "boolean-integer-alias":
                events = [
                    '{"event":"seed_initialized","seed_id":true,"direction":"boolean"}',
                    '{"event":"seed_initialized","seed_id":1,"direction":"integer"}',
                ]
            elif variant == "adjacent-unsafe-integers":
                events = [
                    '{"event":"seed_initialized","seed_id":9007199254740992,"direction":"lower"}',
                    '{"event":"seed_initialized","seed_id":9007199254740993,"direction":"upper"}',
                ]
            (session_root / "journal.jsonl").write_text('\n'.join(events) + "\n")
    else:
        raise AssertionError((arm, variant))
    return args, env


def _normalize_native_value(value, root: Path):
    if isinstance(value, dict):
        return {key: _normalize_native_value(item, root) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize_native_value(item, root) for item in value]
    if isinstance(value, str):
        return _normalize_probe(value, root)
    return value


def _native_semantic_tree(root: Path):
    import yaml

    result = {}
    ignored_segments = {".transactions", ".migration-transactions", ".coordination-lock"}
    for path_ in sorted(root.rglob("*")):
        relative = path_.relative_to(root).as_posix()
        if any(segment in ignored_segments or segment.endswith(".lock") for segment in relative.split("/")):
            continue
        normalized_relative = re.sub(
            r"legacy-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[^/]+",
            "<LEGACY_SESSION>",
            relative,
        )
        normalized_relative = re.sub(
            r"\d{4}-\d{2}-\d{2}_compatibility-goal(?:-\d+)?",
            "<SESSION>",
            normalized_relative,
        )
        if path_.is_dir():
            result[normalized_relative + "/"] = "<directory>"
            continue
        if path_.suffix in {".yaml", ".yml"}:
            try:
                value = yaml.safe_load(path_.read_text())
            except yaml.YAMLError:
                value = {"__raw__": path_.read_text()}
        elif path_.suffix == ".json":
            try:
                value = json.loads(path_.read_text())
            except json.JSONDecodeError:
                value = {"__raw__": path_.read_text()}
        elif path_.suffix == ".jsonl":
            value = []
            for line in path_.read_text().splitlines():
                if not line.strip():
                    continue
                try:
                    value.append(json.loads(line))
                except json.JSONDecodeError:
                    value.append({"__raw__": line})
        else:
            value = path_.read_text(errors="replace")
        result[normalized_relative] = _normalize_native_value(value, root)
    return result


NATIVE_PARITY_CASES = [
    ("help", "success"), ("help", "dry-run"),
    ("compute_session_id", "success"), ("compute_session_id", "directory-collision"),
    ("compute_session_id", "registry-collision"),
    ("compute_session_id", "registry-directory-collision"),
    ("resolve_current", "rejected"), ("resolve_current", "null-current"),
    ("resolve_current", "malformed-current"),
    ("resolve_current", "orphan-pointer"), ("resolve_current", "missing-session-yaml"),
    ("resolve_current", "success"), ("resolve_current", "identity-mismatch"),
    ("resolve_current", "status-reconcile"),
    ("list_sessions", "empty"), ("list_sessions", "success"),
    ("list_sessions", "malformed-registry"), ("list_sessions", "non-object-record"),
    ("start_new_session", "dry-run"), ("start_new_session", "success"),
    ("start_new_session", "collision-exhaustion"),
    ("start_new_session", "dry-run-collision-exhaustion"),
    ("start_new_session", "registry-collision"), ("start_new_session", "directory-collision"),
    ("start_new_session", "registry-directory-collision"), ("start_new_session", "parent"),
    ("start_new_session", "malformed-registry"),
    ("mark_session_status", "dry-run"), ("mark_session_status", "missing-namespace"),
    ("mark_session_status", "success"),
    ("append_sessions_jsonl", "rejected"), ("append_sessions_jsonl", "dry-run"),
    ("append_sessions_jsonl", "success"),
    ("migrate_legacy", "rejected"), ("migrate_legacy", "dry-run"), ("migrate_legacy", "success"),
    ("check_branch_alignment", "success"), ("check_branch_alignment", "rejected"),
    ("detect_orphan_experiment", "empty"), ("detect_orphan_experiment", "success"),
    ("detect_orphan_experiment", "spaced-json"),
    ("append_meta_archive_local", "rejected"), ("append_meta_archive_local", "dry-run"),
    ("append_meta_archive_local", "success"), ("append_meta_archive_local", "invalid-receipt"),
    ("render_inherited_context", "rejected"), ("render_inherited_context", "success"),
    ("render_inherited_context", "invalid-receipt"),
    ("lineage_tree", "empty"), ("lineage_tree", "success"),
    ("resolve_helper_path", "success"), ("resolve_helper_path", "rejected"),
    ("append_seed_to_session_yaml", "missing-precondition"), ("append_seed_to_session_yaml", "success"),
    ("append_seed_to_session_yaml", "invalid-seed"), ("append_seed_to_session_yaml", "null-beta"),
    ("append_seed_to_session_yaml", "empty-session"), ("append_seed_to_session_yaml", "unsafe-integer"),
    ("append_seed_to_session_yaml", "block-safe-boundary"),
    ("append_seed_to_session_yaml", "block-unsafe-boundary"),
    ("append_seed_to_session_yaml", "inline-safe-boundary"),
    ("append_seed_to_session_yaml", "inline-unsafe-boundary"),
    ("append_seed_to_session_yaml", "nested-beta-safe-boundary"),
    ("append_seed_to_session_yaml", "nested-beta-unsafe-boundary"),
    ("set_virtual_parallel_field", "missing-precondition"), ("set_virtual_parallel_field", "success"),
    ("set_virtual_parallel_field", "empty-session"), ("set_virtual_parallel_field", "unsafe-integer"),
    ("init_virtual_parallel_block", "missing-precondition"), ("init_virtual_parallel_block", "rejected"),
    ("init_virtual_parallel_block", "semantic-rejected"),
    ("init_virtual_parallel_block", "missing-eval-field"), ("init_virtual_parallel_block", "null-analysis"),
    ("init_virtual_parallel_block", "python-int-spelling"), ("init_virtual_parallel_block", "success"),
    ("init_virtual_parallel_block", "empty-session"),
    ("init_virtual_parallel_block", "explicit-null-reasoning"),
    ("init_virtual_parallel_block", "unsafe-budget"),
    ("init_virtual_parallel_block", "nested-analysis-safe-boundary"),
    ("init_virtual_parallel_block", "nested-analysis-unsafe-boundary"),
    ("rebuild_seeds_from_journal", "missing-precondition"), ("rebuild_seeds_from_journal", "success"),
    ("rebuild_seeds_from_journal", "integral-float-seed-id"),
    ("rebuild_seeds_from_journal", "boolean-seed-id"),
    ("rebuild_seeds_from_journal", "empty-session"),
    ("rebuild_seeds_from_journal", "boolean-integer-alias"),
    ("rebuild_seeds_from_journal", "adjacent-unsafe-integers"),
]

NATIVE_REQUIRED_VARIANTS = {
    "help": {"success", "dry-run"},
    "compute_session_id": {"success", "directory-collision", "registry-collision", "registry-directory-collision"},
    "resolve_current": {"rejected", "null-current", "malformed-current", "orphan-pointer", "missing-session-yaml", "success", "identity-mismatch", "status-reconcile"},
    "list_sessions": {"empty", "success", "malformed-registry", "non-object-record"},
    "start_new_session": {"dry-run", "success", "collision-exhaustion", "dry-run-collision-exhaustion", "registry-collision", "directory-collision", "registry-directory-collision", "parent", "malformed-registry"},
    "mark_session_status": {"dry-run", "missing-namespace", "success"},
    "append_sessions_jsonl": {"rejected", "dry-run", "success"},
    "migrate_legacy": {"rejected", "dry-run", "success"},
    "check_branch_alignment": {"success", "rejected"},
    "detect_orphan_experiment": {"empty", "success", "spaced-json"},
    "append_meta_archive_local": {"rejected", "dry-run", "success", "invalid-receipt"},
    "render_inherited_context": {"rejected", "success", "invalid-receipt"},
    "lineage_tree": {"empty", "success"},
    "resolve_helper_path": {"success", "rejected"},
    "append_seed_to_session_yaml": {
        "missing-precondition", "success", "invalid-seed", "null-beta", "empty-session",
        "unsafe-integer", "block-safe-boundary", "block-unsafe-boundary",
        "inline-safe-boundary", "inline-unsafe-boundary",
        "nested-beta-safe-boundary", "nested-beta-unsafe-boundary",
    },
    "set_virtual_parallel_field": {"missing-precondition", "success", "empty-session", "unsafe-integer"},
    "init_virtual_parallel_block": {
        "missing-precondition", "rejected", "semantic-rejected", "missing-eval-field",
        "null-analysis", "python-int-spelling", "success", "empty-session",
        "explicit-null-reasoning", "unsafe-budget", "nested-analysis-safe-boundary",
        "nested-analysis-unsafe-boundary",
    },
    "rebuild_seeds_from_journal": {"missing-precondition", "success", "integral-float-seed-id", "boolean-seed-id", "empty-session", "boolean-integer-alias", "adjacent-unsafe-integers"},
}


def test_entropy_compute_mixed_categories(run_helper, make_journal):
    journal = make_journal([
        ("parameter_tune", 3),
        ("algorithm_swap", 2),
        ("add_guard", 2),
    ])
    result = run_helper("entropy_compute", str(journal))
    # Shannon entropy of distribution {3/7, 2/7, 2/7} ≈ 1.557 bits
    assert 1.3 < result["entropy_bits"] < 1.6
    assert result["active_categories"] == 3


def test_entropy_compute_insufficient_sample(run_helper, make_journal):
    # Only 4 tagged planned events — threshold is < 5
    journal = make_journal([("parameter_tune", 4)])
    result = run_helper("entropy_compute", str(journal))
    assert result.get("reason") == "insufficient_sample"
    assert result.get("entropy_bits") is None


def test_entropy_compute_window_respected(run_helper, make_journal):
    # 25 events total, default window is 20 — last 20 should be 100% algorithm_swap
    journal = make_journal([
        ("parameter_tune", 5),   # oldest 5 (outside window)
        ("algorithm_swap", 20),  # newest 20 (inside window)
    ])
    result = run_helper("entropy_compute", str(journal))
    # Single category within window → entropy = 0, active_categories = 1
    assert result["entropy_bits"] == 0.0
    assert result["active_categories"] == 1


def test_migrate_v2_weights_normalized(run_helper, tmp_path):
    v2 = {
        "parameter_tuning": 0.2,
        "structural_change": 0.4,
        "algorithm_swap": 0.2,
        "simplification": 0.2,
    }
    input_file = tmp_path / "v2.json"
    input_file.write_text(json.dumps(v2))
    result = run_helper("migrate_v2_weights", str(input_file))
    weights = result["weights"]
    assert len(weights) == 10
    assert abs(sum(weights.values()) - 1.0) < 1e-9
    assert abs(weights["parameter_tune"] - 0.2 / 1.20) < 1e-6
    assert abs(weights["refactor_simplify"] - 0.2 / 1.20) < 1e-6
    assert abs(weights["algorithm_swap"] - 0.2 / 1.20) < 1e-6
    assert abs(weights["add_guard"] - (0.4 / 3) / 1.20) < 1e-6
    assert abs(weights["other"] - 0.05 / 1.20) < 1e-6


def test_migrate_v2_weights_pathological_all_structural(run_helper, tmp_path):
    v2 = {"structural_change": 1.0}
    input_file = tmp_path / "v2.json"
    input_file.write_text(json.dumps(v2))
    result = run_helper("migrate_v2_weights", str(input_file))
    weights = result["weights"]
    assert weights["parameter_tune"] == 0.0
    assert weights["refactor_simplify"] == 0.0
    assert weights["algorithm_swap"] == 0.0
    assert abs(weights["add_guard"] - (1.0 / 3) / 1.20) < 1e-6
    assert abs(weights["other"] - 0.05 / 1.20) < 1e-6
    assert abs(sum(weights.values()) - 1.0) < 1e-9


def test_count_flagged_respects_escalation_reset(run_helper, make_journal):
    journal = make_journal([
        {"event": "shortcut_flagged", "id": 1, "commit": "a", "timestamp": "t1"},
        {"event": "shortcut_flagged", "id": 2, "commit": "b", "timestamp": "t2"},
        {"event": "shortcut_flagged", "id": 3, "commit": "c", "timestamp": "t3"},
        {"event": "shortcut_escalation", "cumulative": 3, "timestamp": "t4"},
        {"event": "shortcut_flagged", "id": 4, "commit": "d", "timestamp": "t5"},
    ])
    result = run_helper("count_flagged_since_last_expansion", str(journal))
    assert result["count"] == 1


def test_count_flagged_no_escalation_yet(run_helper, make_journal):
    journal = make_journal([
        {"event": "shortcut_flagged", "id": 1, "commit": "a", "timestamp": "t1"},
        {"event": "shortcut_flagged", "id": 2, "commit": "b", "timestamp": "t2"},
    ])
    result = run_helper("count_flagged_since_last_expansion", str(journal))
    assert result["count"] == 2


def test_retry_budget_ignores_crashes(run_helper, make_journal):
    journal = make_journal([
        {"event": "diagnose_retry_started", "id": 1, "timestamp": "t1"},
        {"event": "diagnose_retry_completed", "id": 1, "outcome": "recovered", "timestamp": "t2"},
        {"event": "diagnose_retry_started", "id": 2, "timestamp": "t3"},
        {"event": "diagnose_retry_completed", "id": 2, "outcome": "gave_up", "timestamp": "t4"},
        {"event": "diagnose_retry_started", "id": 3, "timestamp": "t5"},
        {"event": "diagnose_retry_completed", "id": 3, "outcome": "failed", "timestamp": "t6"},
        {"id": 4, "status": "discarded", "reason": "crash", "timestamp": "t7"},
        {"id": 5, "status": "discarded", "reason": "crash", "timestamp": "t8"},
    ])
    result = run_helper("retry_budget_remaining", str(journal), "10")
    assert result["used"] == 3
    assert result["remaining"] == 7


def test_retry_budget_exhausted(run_helper, make_journal):
    entries = [
        {"event": "diagnose_retry_started", "id": i, "timestamp": f"t{i}"}
        for i in range(1, 11)
    ]
    journal = make_journal(entries)
    result = run_helper("retry_budget_remaining", str(journal), "10")
    assert result["used"] == 10
    assert result["remaining"] == 0


@pytest.mark.skipif(os.name == "nt", reason="frozen Bash/Python oracle is Unix-only")
def test_task4_native_metric_arms_match_frozen_v343_oracle_semantics(tmp_path):
    """Task 4 native metrics preserve the frozen 3.4.3 JSON semantics."""
    journal = tmp_path / "journal.jsonl"
    journal.write_text("\n".join([
        json.dumps({"id": 1, "status": "planned", "idea_category": "parameter_tune"}),
        json.dumps({"id": 2, "status": "planned", "idea_category": "algorithm_swap"}),
        json.dumps({"id": 3, "status": "planned", "idea_category": "algorithm_swap"}),
        json.dumps({"id": 4, "status": "planned", "idea_category": "add_guard"}),
        json.dumps({"id": 5, "status": "planned", "idea_category": "add_guard"}),
        json.dumps({"event": "shortcut_flagged", "id": 6}),
        json.dumps({"event": "diagnose_retry_started", "id": 7}),
    ]) + "\n")
    weights = tmp_path / "weights.json"
    weights.write_text(json.dumps({
        "parameter_tuning": 0.2,
        "structural_change": 0.4,
        "algorithm_swap": 0.2,
        "simplification": 0.2,
    }))

    cases = [
        ("entropy_compute", str(journal), "20"),
        ("migrate_v2_weights", str(weights)),
        ("count_flagged_since_last_expansion", str(journal)),
        ("retry_budget_remaining", str(journal), "10"),
    ]
    for args in cases:
        wrapper = subprocess.run(
            ["bash", str(HELPER), *args], cwd=tmp_path,
            capture_output=True, text=True, check=False,
        )
        oracle = subprocess.run(
            ["bash", str(ORACLE), *args], cwd=tmp_path,
            capture_output=True, text=True, check=False,
        )
        assert wrapper.returncode == oracle.returncode, (args, wrapper.stderr, oracle.stderr)
        wrapper_json = json.loads(wrapper.stdout)
        oracle_json = json.loads(oracle.stdout)
        if args[0] == "migrate_v2_weights":
            assert wrapper_json["pre_normalize_sum"] == oracle_json["pre_normalize_sum"]
            assert wrapper_json["weights"].keys() == oracle_json["weights"].keys()
            for key, value in oracle_json["weights"].items():
                assert wrapper_json["weights"][key] == pytest.approx(value)
        else:
            assert wrapper_json == oracle_json, args
        assert wrapper.stderr == oracle.stderr, args


@pytest.mark.skipif(os.name == "nt", reason="frozen Bash/Python oracle is Unix-only")
def test_full_native_success_and_rejection_matrix_matches_frozen_v343(tmp_path):
    """Every native arm compares real success/rejection observables, not route labels alone."""
    assert {arm for arm, _ in NATIVE_PARITY_CASES} == set(NATIVE_TASK3_ARMS)
    actual_variants = {
        arm: {variant for candidate, variant in NATIVE_PARITY_CASES if candidate == arm}
        for arm in NATIVE_TASK3_ARMS
    }
    assert actual_variants == NATIVE_REQUIRED_VARIANTS
    mismatches = []
    for index, (arm, variant) in enumerate(NATIVE_PARITY_CASES):
        wrapper_root = tmp_path / f"wrapper-{index}-{arm}-{variant}"
        oracle_root = tmp_path / f"oracle-{index}-{arm}-{variant}"
        wrapper_root.mkdir()
        oracle_root.mkdir()
        wrapper_args, wrapper_env = _setup_native_parity_case(wrapper_root, arm, variant)
        oracle_args, oracle_env = _setup_native_parity_case(oracle_root, arm, variant)

        wrapper = _run_compatibility(HELPER, wrapper_root, [arm, *wrapper_args], wrapper_env)
        oracle = _run_compatibility(ORACLE, oracle_root, [arm, *oracle_args], oracle_env)
        label = f"{arm}:{variant}"
        wrapper_observable = (
            wrapper.returncode,
            _normalize_probe(wrapper.stdout, wrapper_root),
            _normalize_probe(wrapper.stderr, wrapper_root),
            _native_semantic_tree(wrapper_root),
        )
        oracle_observable = (
            oracle.returncode,
            _normalize_probe(oracle.stdout, oracle_root),
            _normalize_probe(oracle.stderr, oracle_root),
            _native_semantic_tree(oracle_root),
        )
        if wrapper_observable != oracle_observable:
            mismatches.append((label, wrapper_observable, oracle_observable))
    assert mismatches == [], [item[0] for item in mismatches]


@pytest.mark.skipif(os.name == "nt", reason="frozen Bash/Python oracle is Unix-only")
def test_all_18_task3_native_arms_match_frozen_v343_observables(tmp_path):
    """Every native arm pins rc/stdout/stderr and its relative filesystem side effects."""
    assert len(NATIVE_TASK3_ARMS) == 18
    for arm, args in NATIVE_TASK3_ARMS.items():
        wrapper_root = tmp_path / f"wrapper-{arm}"
        oracle_root = tmp_path / f"oracle-{arm}"
        wrapper_root.mkdir()
        oracle_root.mkdir()
        if arm in {"mark_session_status"}:
            (wrapper_root / ".deep-evolve").mkdir()
            (oracle_root / ".deep-evolve").mkdir()

        wrapper_env = os.environ.copy()
        oracle_env = os.environ.copy()
        for env in (wrapper_env, oracle_env):
            env.pop("SESSION_ROOT", None)
            env.pop("SESSION_ID", None)
            env.pop("DEEP_EVOLVE_HELPER_PATH", None)
        if arm == "resolve_helper_path":
            wrapper_fake = wrapper_root / "same-helper.sh"
            oracle_fake = oracle_root / "same-helper.sh"
            for fake in (wrapper_fake, oracle_fake):
                fake.write_text("#!/bin/sh\nexit 0\n")
                fake.chmod(0o755)
            wrapper_env["DEEP_EVOLVE_HELPER_PATH"] = str(wrapper_fake)
            oracle_env["DEEP_EVOLVE_HELPER_PATH"] = str(oracle_fake)

        wrapper = _run_compatibility(HELPER, wrapper_root, [arm, *args], wrapper_env)
        oracle = _run_compatibility(ORACLE, oracle_root, [arm, *args], oracle_env)
        assert wrapper.returncode == oracle.returncode, (arm, wrapper.stderr, oracle.stderr)
        assert _normalize_probe(wrapper.stdout, wrapper_root) == _normalize_probe(
            oracle.stdout, oracle_root,
        ), arm
        assert _normalize_probe(wrapper.stderr, wrapper_root) == _normalize_probe(
            oracle.stderr, oracle_root,
        ), arm
        assert _tree_snapshot(wrapper_root) == _tree_snapshot(oracle_root), arm


def test_all_5_task5_arms_are_registered_and_execute_natively(tmp_path):
    """Task 5 intentionally replaced the five frozen-oracle worktree arms."""
    registry = subprocess.run(
        [
            "node", "-e",
            (
                "const {LEGACY_ROUTES}=require(process.argv[1]);"
                "process.stdout.write(JSON.stringify(LEGACY_ROUTES));"
            ),
            str(RUNTIME),
        ],
        cwd=tmp_path, capture_output=True, text=True, check=False,
    )
    assert registry.returncode == 0, registry.stderr
    routes = json.loads(registry.stdout)
    assert len(TASK5_NATIVE_ARMS) == 5
    assert len(routes) == 34
    assert set(routes.values()) == {"native"}
    assert {arm: routes.get(arm) for arm in TASK5_NATIVE_ARMS} == {
        arm: "native" for arm in TASK5_NATIVE_ARMS
    }

    env = os.environ.copy()
    env.pop("SESSION_ROOT", None)
    env.pop("SESSION_ID", None)
    for arm in TASK5_NATIVE_ARMS:
        result = subprocess.run(
            ["node", str(RUNTIME), "--legacy-session-helper", arm],
            cwd=tmp_path, env=env, capture_output=True, text=True, check=False,
        )
        assert result.returncode == 2, (arm, result.stderr)
        assert result.stdout == "", arm
        assert result.stderr == f"{arm}: SESSION_ROOT not set\n", arm
