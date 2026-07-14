# deep-evolve — Codex Project Guide

deep-evolve provides goal-driven measured improvement loops. The repository
remains Claude Code compatible and carries Codex-native metadata plus shared
checked-in coordinator/seed policies.

Read the current version from `.claude-plugin/plugin.json`. Release history is
in [`CHANGELOG.md`](CHANGELOG.md) and [`CHANGELOG.ko.md`](CHANGELOG.ko.md).

> 📄 Documentation in this repo follows `docs/DOCS_RULE.md` (local maintainer guide).

## Runtime surfaces

- Public Codex skill: `$deep-evolve:deep-evolve`
- Codex manifest/default hook: `.codex-plugin/plugin.json`, `hooks/hooks.json`
- Claude manifest/custom hook: `.claude-plugin/plugin.json`, `hooks/hooks.claude.json`
- Shared workflow: `skills/deep-evolve-workflow/`
- Shared policies: `agents/evolve-coordinator.md`, `agents/evolve-seed.md`
- Runtime contract: `skills/deep-evolve-workflow/protocols/runtime-contract.md`
- Dispatcher/modules: `hooks/scripts/deep-evolve-runtime.cjs`, `hooks/scripts/runtime/`
- Target-project state: `.deep-evolve/`

Codex generic subagents first read their matching policy and then authenticate
the exact literal worktree. Canonical state comes only from registered runtime
responses. The supported runtime is zero-dependency Node CommonJS, with no MCP
server. Preserve user work and unrelated dirty bytes.

## Verification

Validate both manifests with the host JSON reader, then run `npm test`. Use the
focused four-file Node contract suite documented in `CLAUDE.md` for cross-host
instruction changes.
