# Protect-Readonly Golden Fixtures (M5.5 #3)

Each scenario is a pair of files:

- `<name>.input.json`  — describes session state + tool invocation + env
- `<name>.expected.json` — pins exit code + decision + optional reason regex

Driver: `tests/protect-readonly-golden.test.js` discovers pairs by basename,
materializes the `.deep-evolve/<session_id>/` namespace inside a tmpdir
(when `state` is present), spawns `protect-readonly.sh` via the
`runProtectReadonly` helper, and asserts each expected field.

Pattern reference: claude-deep-work
[`tests/fixtures/golden/`](https://github.com/Sungmin-Cho/claude-deep-work/tree/main/tests/fixtures/golden)
(PR #29). Adapted for deep-evolve's protect-readonly contract.

## `.input.json` schema

```jsonc
{
  "description": "human-readable scenario",
  "state": {                          // optional — materialize .deep-evolve/<sid>/
    "session_id": "s-active",         // becomes current.json.session_id and dir name
    "status": "active",               // session.yaml status field (active | initializing | ...)
    "create_protected": true          // optional, defaults true — writes prepare.py
                                      // / prepare-protocol.md / program.md / strategy.yaml
                                      // / worktrees/seed_1/program.md
  },
  "tool_name": "Edit",                // CLAUDE_TOOL_USE_TOOL_NAME
  "tool_input": {                     // payload JSON-stringified onto stdin
    "file_path": "{{SESSION_ROOT}}/prepare.py"
  },
  "env": {                            // optional — merged AFTER host-env scrub
    "DEEP_EVOLVE_META_MODE": "prepare_update"
  }
}
```

### Template variables

Values inside `tool_input` and `env` are walked for these substrings:

- `{{SESSION_ROOT}}` → `<tmpRoot>/.deep-evolve/<session_id>`
- `{{PROJECT_ROOT}}` → `<tmpRoot>` itself

This lets fixtures reference protected paths portably.

## `.expected.json` schema

```jsonc
{
  "exit_code": 0,                     // 0 allow, 2 block
  "decision": "allow",                // optional — "allow" | "block"
  "reason_match": "Deep Evolve Guard" // optional — JS regex source string,
                                       // matched against parsed JSON `reason`
}
```

Allow fixtures (no `decision`/`reason_match`) additionally assert that the
hook emitted no stdout — protect-readonly.sh's allow path is silent.

## When adding fixtures

- Use kebab-case basenames so test names sort sensibly:
  `09-meta-mode-outer-loop-allow.input.json`.
- Keep `description` short — it's prefixed onto the `it()` name.
- Run `node --test tests/protect-readonly-golden.test.js` after adding.
- If a pair is missing one half, the driver throws at load time (fail loud).

## Current corpus

| # | Name | What it pins |
|---|---|---|
| 01 | no-deep-evolve-allow | Walk-up finds no `.deep-evolve/` → unconditional allow |
| 02 | inactive-session-edit-prepare-allow | `status: initializing` → harness writable |
| 03 | active-edit-prepare-block | Active run + Edit on prepare.py → block |
| 04 | active-edit-program-block | Active run + Edit on program.md → block |
| 05 | active-edit-strategy-block | Active run + Edit on strategy.yaml → block |
| 06 | active-edit-unrelated-allow | Active run + Edit on unrelated file → allow |
| 07 | meta-mode-prepare-update-allow | `DEEP_EVOLVE_META_MODE=prepare_update` bypass |
| 08 | seal-prepare-bash-cat-block | `DEEP_EVOLVE_SEAL_PREPARE=1` + Bash `cat prepare.py` |
