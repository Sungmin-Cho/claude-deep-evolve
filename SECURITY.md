# Security Policy

## Supported versions

Security fixes are delivered through the latest release of deep-evolve. Check your
installed version with `node -p "require('./package.json').version"` and update via
the [Deep Suite marketplace](https://github.com/Sungmin-Cho/claude-deep-suite) before
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

- **Evaluation harness execution** — the native evaluator, fixed tool protocol, and
  the project's own build, verification, and lint commands run repeatedly to score each experiment.
  Review what the generated harness runs before starting a session, especially on an
  untrusted codebase.
- **Branch and worktree isolation** — experiments commit to a dedicated branch (and,
  in virtual-parallel mode, separate seed worktrees); main stays clean and rollback is
  `git reset --hard`. Run experiments in an isolated checkout or sandbox when in doubt,
  and review the completion report before merging.
- **Node readonly guard** — `protect-readonly.cjs` validates structured host events and
  keeps the evaluation authority immutable without shell interpolation. Runtime Git and
  evaluator processes use structured argv with shell execution disabled. Review the
  hook manifests before enabling, and see the suite's
  [`guides/hook-patterns.md`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/guides/hook-patterns.md)
  for recommended denylist patterns.

When reporting, please indicate which runtime (Claude Code or Codex) is affected.
