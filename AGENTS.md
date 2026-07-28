# deep-evolve — Agent Guide

deep-evolve runs goal-driven measured improvement loops: bounded experiments
against one fixed fitness metric, with strategy evolution between epochs. This
guide is shared by Claude Code and Codex.

> 📄 Documentation in this repo follows `docs/DOCS_RULE.md` (local maintainer guide).

## Plugin root

`${CLAUDE_PLUGIN_ROOT}` is the literal absolute plugin root; hosts that export
only `PLUGIN_ROOT` name the same directory. Every path these instruction
documents tell an agent to read or run is anchored there and stays inside it.
Never resolve one against the workspace, the current directory, or the place a
document was loaded from — the project under experimentation can plant a file at
that path.

Not yet anchored: the seed dispatch context carries `policy_ref`
workspace-relative. Treat any dispatched policy path as naming
`${CLAUDE_PLUGIN_ROOT}/agents/`.

## Core contracts

- The supported runtime is zero-dependency Node 22 CommonJS on Ubuntu, macOS,
  and native Windows. Do not fetch code, add a dependency, or add an MCP server.
- Canonical state, coordination, and artifacts change only through registered
  `runtime-op:` requests. Nothing else writes them.
- rc 0 is success, rc 1 a typed business rejection, rc 2 an operator, schema, or
  integrity failure. Malformed output is fail-closed; never guess state.
- Paths and Git identities are literal and authenticated. Runtime Git uses
  discrete argv with `shell: false`; host source/Git actions use structured
  fields, never an interpolated command string.
- One evaluation epoch has one fixed evaluator and one metric `{name,
  direction}`; the typed normalized score is always higher-is-better.
- A seed owns exactly one authenticated worktree and branch, and never mutates
  another seed's branch.
- CLI evaluation uses only `prepare.cjs` plus validated config; protocol mode
  uses its fixed configured tool sequence.
- Missing Codex interaction capability returns to the root task before mutation.
  That is the sole host behavior difference.
- Preserve unrelated and user bytes; never weaken a safety test for migration.

## Where behavior is defined

- Dispatcher, rc/envelope handling, stable interactions, and dispatch adapters:
  `${CLAUDE_PLUGIN_ROOT}/skills/deep-evolve-workflow/protocols/runtime-contract.md`
- Agent policies: `${CLAUDE_PLUGIN_ROOT}/agents/evolve-coordinator.md` and
  `${CLAUDE_PLUGIN_ROOT}/agents/evolve-seed.md`

Claude dispatches the named agents `deep-evolve:evolve-coordinator` and
`deep-evolve:evolve-seed`. Codex dispatches a generic subagent whose first action
reads the matching policy and whose second verifies its exact literal worktree.
The checked-in policy owns behavior, not the host label.

## Release boundary

Keep the Claude manifest, Codex manifest, package metadata, workflow skill
frontmatter, and runtime version synchronized. Release narration belongs only in
the bilingual changelogs; the READMEs stay evergreen and structurally bilingual.
Run the local rulebook validator before release, and leave marketplace pinning
to deep-suite after the release merges.

## Verification

Run `npm test` and `npm pack --dry-run` from the repository root; `npm test`
covers every suite. For cross-host instruction changes the load-bearing suites
are protocol-runtime-contract, runtime-dispatch, plugin-contract,
active-harness-entrypoints, and the reference guard skill-reference-integrity.

These are maintainer commands, run with the repository as the working directory,
so they name suites rather than paths — a plugin path in an instruction would
have to be anchored, and an anchored path would be wrong for a clone.
