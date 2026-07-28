@AGENTS.md

# deep-evolve — Claude Project Guide

Claude Code loads the shared guide above. Claude-only note: the two agent
policies are installed as the named subagents `deep-evolve:evolve-coordinator`
and `deep-evolve:evolve-seed`, and the Claude hook manifest is
`${CLAUDE_PLUGIN_ROOT}/hooks/hooks.claude.json` (Codex uses
`${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json`). Both hosts run the same policies,
protocols, and runtime operations.
