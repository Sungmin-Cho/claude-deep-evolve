# deep-evolve - Codex Project Guide

Autonomous Experimentation Protocol for goal-driven, measured improvement
loops. The repo remains Claude Code compatible and now carries Codex-native
plugin metadata beside the Claude manifest.

To check the current version: `jq -r .version .claude-plugin/plugin.json`. For version history, see [`CHANGELOG.md`](CHANGELOG.md) / [`CHANGELOG.ko.md`](CHANGELOG.ko.md).

> 📄 **Docs maintenance**: this repo's documentation follows `docs/DOCS_RULE.md` (local maintainer guide — single-source-of-truth rules for README / CHANGELOG / this file).

## Runtime Surfaces

- Codex manifest: `.codex-plugin/plugin.json`
- Claude Code manifest: `.claude-plugin/plugin.json`
- Workflow skills: `skills/deep-evolve-workflow/`
- Hooks: `hooks/hooks.json` and `hooks/scripts/`
- Runtime state: `.deep-evolve/` in target projects, not this plugin repo

Local `.claude/` state is runtime-only and should not be committed.

## Verification

```bash
node -e "JSON.parse(require('fs').readFileSync('.codex-plugin/plugin.json','utf8'))"
npm test
```

After a release, update both suite marketplace manifests in
`/Users/sungmin/Dev/claude-plugins/deep-suite/`.
