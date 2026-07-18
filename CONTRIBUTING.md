# Contributing to deep-evolve

Thanks for your interest in improving **deep-evolve** — the autonomous-experimentation
plugin of the [Deep Suite](https://github.com/Sungmin-Cho/claude-deep-suite) for Claude
Code and Codex.

## Getting started

```bash
git clone https://github.com/Sungmin-Cho/claude-deep-evolve.git
cd claude-deep-evolve
```

Supported development uses Node 22 on Ubuntu, macOS, or native Windows.

## Local checks

```bash
npm test                       # node:test — envelope, handoff roundtrip,
                               # protect-readonly golden fixtures, session recovery
npm pack --dry-run             # package membership and release boundary
```

Ordinary CI runs the same Node 22 checks on Ubuntu, macOS, and Windows. Maintainers
may optionally run the separately named Unix-only `legacy-oracle` compatibility job;
it is not part of the supported runtime path.

## Conventions

- **Documentation** follows [`docs/DOCS_RULE.md`](docs/DOCS_RULE.md) (local maintainer
  guide): the README is evergreen, the CHANGELOG owns release history, and `CLAUDE.md` /
  `AGENTS.md` stay short.
- **Version synchronization** — the Claude manifest, Codex manifest, package metadata,
  workflow skill frontmatter, and Node runtime constant carry the same release version.
- **CHANGELOG** follows [Keep a Changelog](https://keepachangelog.com/) — add a concise,
  user-observable entry to both `CHANGELOG.md` and `CHANGELOG.ko.md`.
- **Cross-platform process safety** — pass executable arguments as discrete values and
  preserve literal paths on every supported operating system.

## Pull requests

1. Branch from `main`.
2. Keep changes focused; update both changelogs and make sure the Node checks are green.
3. Explain what changed and why.

## Reporting issues

Open a GitHub issue. For security reports, see [`SECURITY.md`](SECURITY.md).
