# Contributing to deep-evolve

Thanks for your interest in improving **deep-evolve** — the autonomous-experimentation
plugin of the [Deep Suite](https://github.com/Sungmin-Cho/claude-deep-suite) for Claude
Code and Codex.

## Getting started

```bash
git clone https://github.com/Sungmin-Cho/claude-deep-evolve.git
cd claude-deep-evolve
```

The Node test runner needs Node 20+. The Python hook tests need Python 3 with
`pytest` (and `pyyaml`).

## Local checks

```bash
npm test                       # node:test — envelope, handoff roundtrip,
                               # protect-readonly golden fixtures, session recovery
pytest hooks/scripts/tests/ -q # Python hook suite (scheduler, kill, synthesis, …)
```

CI runs both on `ubuntu-latest` and `macos-latest`. Everything must be green before a
PR is merged.

## Conventions

- **Documentation** follows [`docs/DOCS_RULE.md`](docs/DOCS_RULE.md) (local maintainer
  guide): the README is evergreen, the CHANGELOG owns release history, and `CLAUDE.md` /
  `AGENTS.md` stay short.
- **Version triple-sync** — `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
  and `package.json` must always carry the same version. A drift guard also keeps the
  workflow skill frontmatter and `session-helper.sh` `HELPER_VERSION` in lockstep.
- **CHANGELOG** follows [Keep a Changelog](https://keepachangelog.com/) — add a concise,
  user-observable entry to both `CHANGELOG.md` and `CHANGELOG.ko.md`.
- **Bash 3.2 portability** — macOS ships `/bin/bash` 3.2; avoid `declare -A`, `mapfile`,
  `${var,,}`, `globstar`, etc. (see `CLAUDE.md` for the full list).

## Pull requests

1. Branch from `main`.
2. Keep changes focused; update the CHANGELOG and make sure `npm test` and the pytest
   suite are green.
3. Explain what changed and why.

## Reporting issues

Open a GitHub issue. For security reports, see [`SECURITY.md`](SECURITY.md).
