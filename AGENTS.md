# deep-evolve — Codex Project Guide

deep-evolve provides goal-driven measured improvement loops. The repository
remains Claude Code compatible and carries Codex-native metadata plus shared
checked-in coordinator/seed policies.

Read the current version with
`node -p "require('./package.json').version"`. Release history is in
[`CHANGELOG.md`](CHANGELOG.md) and [`CHANGELOG.ko.md`](CHANGELOG.ko.md).

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
responses. The supported runtime is zero-dependency Node 22 CommonJS on Ubuntu,
macOS, and native Windows, with no bundled MCP server. Preserve user work and
unrelated dirty bytes.

## Release boundary

Keep the Claude manifest, Codex manifest, package metadata, workflow skill
frontmatter, and runtime version synchronized. Update the bilingual changelogs,
run the local rulebook validator, and leave marketplace pinning to deep-suite
after the release merges.

## Verification

Run `npm test` and `npm pack --dry-run`. Use the focused four-file Node contract
suite documented in `CLAUDE.md` for cross-host instruction changes.
