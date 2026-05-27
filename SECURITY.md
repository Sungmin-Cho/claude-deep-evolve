# Security Policy

## Supported versions

Security fixes are delivered through the latest release of deep-evolve. Check your
installed version with `jq -r .version .claude-plugin/plugin.json` and update via the
[Deep Suite marketplace](https://github.com/Sungmin-Cho/claude-deep-suite) before
reporting.

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub Security Advisories](https://github.com/Sungmin-Cho/claude-deep-evolve/security/advisories/new)
rather than opening a public issue.

We aim to acknowledge reports within a few days and will coordinate a fix and a
disclosure timeline with you.

## Scope

deep-evolve runs **autonomous experiment loops** inside the Claude Code / Codex plugin
runtime. By design it executes project commands on your behalf, so keep the following in
mind:

- **Evaluation harness execution** — `prepare.py` / `prepare-protocol.md` and the
  project's own build/test/lint commands are run repeatedly to score each experiment.
  Review what the generated harness runs before starting a session, especially on an
  untrusted codebase.
- **Branch and worktree isolation** — experiments commit to a dedicated branch (and,
  in virtual-parallel mode, separate seed worktrees); main stays clean and rollback is
  `git reset --hard`. Run experiments in an isolated checkout or sandbox when in doubt,
  and review the completion report before merging.
- **PreToolUse guard** — the `protect-readonly.sh` hook executes shell during tool use
  to keep the evaluation harness immutable mid-experiment. Review `hooks/` before
  enabling, and see the suite's
  [`guides/hook-patterns.md`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/guides/hook-patterns.md)
  for recommended denylist patterns.

When reporting, please indicate which runtime (Claude Code or Codex) is affected.
