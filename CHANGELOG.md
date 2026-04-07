# Changelog

## [1.1.0] - 2026-04-07

### Added
- **Open-ended project analysis**: game engines, custom build systems, non-standard projects now analyzable
- **Protocol evaluation mode**: tool-based evaluation via MCP servers, browser automation, external APIs
- `prepare-protocol.md` template: defines evaluation protocols for projects that cannot be assessed via CLI
- protect-readonly.sh now guards prepare-protocol.md during active experiments

### Changed
- Stage 1-2 analysis switched from hardcoded file lists to open-ended signal-based discovery
- Unknown projects now prompt the user instead of refusing to proceed
- Automatic evaluation mode recommendation (cli/protocol) during analysis

## [1.0.0] - 2026-04-06

### Added
- Initial release
- Conversational init with project deep analysis (5 stages)
- Three prepare.py templates: stdout-parse, test-runner, scenario
- Experiment loop with journal-based atomic state machine
- Diminishing returns detection
- Resume support across sessions
- prepare.py versioning and expansion
- protect-readonly.sh hook for experiment safety (Write/Edit/Bash)
- Completion report with result application options (merge/PR/keep/discard)
- Branch & Clean-Tree Guard for safe rollback
