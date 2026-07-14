# deep-evolve — Claude Project Guide

deep-evolve is a goal-driven autonomous experimentation plugin. The repository
contains shared Claude Code/Codex skills, checked-in agent policies, manifests,
zero-dependency Node runtime, hooks, evaluator templates, and tests.

Read the current version from `.claude-plugin/plugin.json`. Release history
belongs in [`CHANGELOG.md`](CHANGELOG.md) and [`CHANGELOG.ko.md`](CHANGELOG.ko.md).

> 📄 Documentation in this repo follows `docs/DOCS_RULE.md` (local maintainer guide).

## Runtime surfaces

- Public skill: `skills/deep-evolve/SKILL.md`
- Shared workflow: `skills/deep-evolve-workflow/`
- Agent policies: `agents/evolve-coordinator.md`, `agents/evolve-seed.md`
- Claude manifest/hook: `.claude-plugin/plugin.json`, `hooks/hooks.claude.json`
- Codex manifest/hook: `.codex-plugin/plugin.json`, `hooks/hooks.json`
- Dispatcher/modules: `hooks/scripts/deep-evolve-runtime.cjs`, `hooks/scripts/runtime/`
- Evaluator templates: `templates/*.cjs`
- Target-project state: `.deep-evolve/`

Claude uses named `deep-evolve:evolve-coordinator` and
`deep-evolve:evolve-seed`. Codex generic subagents first read the matching agent
policy and then verify their exact worktree. Both follow
`skills/deep-evolve-workflow/protocols/runtime-contract.md`.

## Core contracts

- Supported runtime is zero-dependency Node CommonJS; do not fetch code or add
  an MCP server.
- Canonical state/coordination/artifacts use registered `runtime-op:` requests.
- CLI evaluation uses only `prepare.cjs` plus validated config; protocol mode
  uses its fixed configured tool sequence.
- Paths are literal and authenticated. Runtime Git uses discrete argv with
  `shell: false`; host source/Git actions use structured fields.
- rc 0 is success, rc 1 a typed business rejection, rc 2 an operator/schema/
  integrity failure. Malformed output is fail-closed.
- Missing Codex interaction capability returns to the root task before mutation;
  this is the sole host behavior difference.
- Preserve unrelated/user bytes and never weaken safety tests for migration.

## Documentation and release boundaries

README files describe evergreen usage and remain structurally bilingual.
Release narration belongs only in the changelogs. Version synchronization,
package membership, CI, release, and suite pins are performed only in their
owned release task.

## Verification

Run `npm test`. For the cross-host instruction contract, run Node's test runner
over `tests/protocol-runtime-contract.test.js`, `tests/runtime-dispatch.test.js`,
`tests/plugin-contract.test.js`, and `tests/active-harness-entrypoints.test.js`.
