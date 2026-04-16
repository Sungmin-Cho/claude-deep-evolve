# Changelog

## v2.2.0

### Features
- **Session namespace**: `.deep-evolve/<session-id>/` per-session 격리, 세션 간 데이터 보존
- **`/deep-evolve resume`**: 중단된 세션 재개, integrity check, orphan experiment 감지
- **`/deep-evolve history`**: 프로젝트 내 세션 목록, lineage tree, aggregate 통계
- **Session lineage**: 선행 세션의 strategy/program/notable keeps를 새 세션에 상속 (informational only)
- **Inherited Context**: program.md에 선행 세션 결론 자동 삽입
- **Immutable receipt v2.2.0**: experiments_table, generation_snapshots(cap 10), notable_keeps, runtime_warnings, parent_session
- **Shell helper**: `hooks/scripts/session-helper.sh` with 12 subcommands, --dry-run support

### Breaking Changes
- `.deep-evolve/` 디렉터리 구조 변경: flat → per-session namespace
- 기존 flat layout 프로젝트는 첫 실행 시 자동 migration 프롬프트
- `Delete .deep-evolve/` 동작 제거 — 세션은 보존됨 (cleanup은 v2.3+)
- `sessions.json` → `sessions.jsonl` (event-sourced)
- receipt schema: `receipt_schema_version: 2` 필드 추가

### Migration
- **자동**: `/deep-evolve` 실행 시 legacy layout 감지 → archive 이관 프롬프트
- **수동 rollback 불가**: v2.2.0 layout은 v2.1.x hook과 호환 불가 (v2.1.2 shim이 경고)

## v2.1.2

### Improvements
- **3.A** inner-loop Step 6 재구조화: outer loop 자동 트리거 우선, AskUserQuestion은 outer 완료 후 조건부
- **3.B** `session.yaml.outer_loop.auto_trigger` 플래그 (default true)
- **3.C** program.md 템플릿에 Automation Policy 단락 자동 삽입 (sentinel 주석 포함)
- inner_count를 session.yaml에 persist (향후 resume 지원 기반)

### Fixes
- v2.2.0 forward-compat shim: v2.2.0 layout 감지 시 업그레이드 안내 (X16)

## [2.1.0] — 2026-04-14

### Added
- **Cross-plugin feedback (Phase 3A):**
  - `evolve-receipt.json` generation in completion report for deep-dashboard consumption
  - Deep-review trigger before merge/PR with failure fallback
  - `recurring-findings.json` consumption from deep-review during init (Stage 3.5)
  - `evolve-insights.json` export from meta-archive for deep-work/deep-review (Section E.1)
  - Unified 6-option completion menu (merge, PR, deep-review+merge, deep-review+PR, keep, discard)
  - `outcome` field in receipt tracking session disposition (merged/pr_created/kept/discarded)

## [2.0.0] - 2026-04-13

### Added
- Self-Evolutionary Experiment Loop (2-Tier architecture)
- strategy.yaml: evolvable strategy parameter layer
- Outer Loop: automatic strategy evolution with Q(v) meta-metric
- 3-layer self-evolution: parameters + strategy text + evaluation expansion
- Strategy archive with stepping stones and parent selection
- Code archive with named-branch-based backtracking
- Idea ensemble (multi-candidate selection per experiment)
- Cross-project strategy transfer via meta-archive
- Evaluation Epoch separation for prepare.py versioning
- flock-based concurrency safety for meta-archive

### Fixed
- protect-readonly.sh: grep pipe logic error (P0-1)
- prepare-stdout-parse.py: minimize metric inversion (P0-2)
- Unified scoring contract: score is always higher-is-better
- package.json/plugin.json: repository URL corrected

### Changed
- Meta Analysis: automatic program.md revision (Phase 1)
- Section D (Prepare Expansion): manual → auto-triggered on convergence

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
