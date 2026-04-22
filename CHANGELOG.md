# Changelog

## [3.0.0] — 2026-04-22 (AAR-Inspired Evidence-Rich Hill-Climbing)

Major release adding four AAR-inspired behavioral layers to the Inner/Outer Loop,
gated on `session.yaml.deep_evolve_version: "3.0.0"`. v2.2.2 sessions remain fully
supported via soft migration.

### Added
- **Idea-category entropy tracking** (§7.1): 10-category taxonomy
  (`protocols/taxonomy.md`); Shannon entropy computed on each Outer Loop via new
  `session-helper.sh entropy_compute` subcommand; `entropy_snapshot` /
  `entropy_collapse` journal events; Tier 1 entropy overlay in 6.5.3.
- **Legibility Gate** (§6 Step 5.d): mandatory rationale on every `kept` event
  (Medium), hard-promoted to forced-discard on flagged keeps. Missing-rationale
  counter exposed in completion report.
- **Shortcut Detector** (§6 Step 5.c + 6.a.5): flags keeps with
  `score_delta ≥ 0.05 AND loc_delta ≤ 5`. Three cumulative flagged keeps force
  Section D prepare expansion with flagged-commit diffs injected into the
  regeneration prompt (§7.3). Forensic row written even when hard-rejected.
  End-to-end opt-in `seal_prepare_read` in strategy.yaml wires through
  `DEEP_EVOLVE_SEAL_PREPARE=1` (exported by inner-loop from strategy.yaml) to
  PreToolUse hook that blocks Read on prepare.py / prepare-protocol.md.
- **Diagnose-and-Retry** (§6 Step 5.a): one-shot recovery on crash, severe drop
  (>5% below baseline), or log error keywords. Session cap 10 retries. Retry
  uses reset + new commit with `retry_of` linkage. `give_up` path recorded
  distinctly. Per-experiment retry is capped at 1, enforced via journal replay.
- **10-category taxonomy**: `parameter_tune, refactor_simplify, add_guard,
  algorithm_swap, data_preprocessing, caching_memoization, error_handling,
  api_redesign, test_expansion, other`.
- **v2→v3 deterministic mapping** in meta-archive A.2.5 lookup (§8.2).
  `session-helper.sh migrate_v2_weights` subcommand performs the translation.
- **New `session-helper.sh` subcommands**: `entropy_compute`, `migrate_v2_weights`,
  `count_flagged_since_last_expansion`, `retry_budget_remaining`.
- **pytest test suite** at `hooks/scripts/tests/` (9 tests).
- **Fixtures** at `hooks/scripts/tests/fixtures/`: `shortcut_bait/` (Scenario B),
  `legibility_medium/` (Scenario A), `dogfood_target/` (self-dogfooding).

### Changed
- `strategy.yaml` schema `version: 2` (v3 sessions) — 10-category weights + new
  `shortcut_detection`, `legibility`, `entropy_tracking` sections, plus
  `judgment.diagnose_retry` sub-block.
- `session.yaml` gains `shortcut`, `diagnose_retry`, `legibility`, `entropy`
  tracking blocks for v3 sessions. `deep_evolve_version` upgraded to `"3.0.0"`.
- `results.tsv` v3 sessions use 9 columns (adds `category`, `score_delta`,
  `loc_delta`, `flagged`, `rationale`). v2 sessions keep 4 columns. Column
  count auto-detected by completion.md/resume.md from the header line.
- `journal.jsonl` extended events: `planned.idea_category`,
  `committed.retry_of`, `kept.{rationale, score_delta, loc_delta, flagged}`,
  `discarded.reason` (extended). New events: `diagnose_retry_started/completed`,
  `shortcut_flagged`, `shortcut_escalation`, `entropy_snapshot`,
  `entropy_collapse`, `rationale_missing`, `tier3_flagged_reset`.
- Completion report gains a "v3.0.0 Signals" section.
- `hooks.json` matcher extended with `Read` (gated behind
  `DEEP_EVOLVE_SEAL_PREPARE=1`; default off preserves v2 behavior).
- `protect-readonly.sh` adds opt-in Read branch with relative-path
  normalization matching the existing Write/Edit branch.

### Migration
- v2.2.2 sessions resume with v2 code paths unchanged. Warning banner printed
  via `resume.md` Step 4.
- v2 meta-archive entries translated on A.2.5 read via deterministic mapping
  (floor is pre-normalize seed, not post-normalize invariant — see spec §5.1).
- Deprecation roadmap: 3.0.x full v2 support → 3.1.0 warning → 3.2.0 read-only
  completion → 4.0.0 v2 schema removed.

### Not in 3.0.0 (deferred to 3.1.0)
- Virtual parallel N-seed per epoch.
- Upstream-signal validation gate for cross-project transfer.

---

## v2.2.2

### Critical Fixes
- **prepare.py cwd regression (C-2)**: v2.2.0 namespace layout made `Path(__file__).parent.parent` resolve to `.deep-evolve/` instead of the project root. All three CLI templates now walk up until they find `.deep-evolve/`'s parent, working for both v2.2.0 namespace and legacy flat layouts.
- **paused session state + journal-event idempotent resume (C-1, R-1)**: Outer Loop entry/exit toggles `mark_session_status paused|active`. Outer Loop itself is now idempotent: each sub-step checks its completion event in `journal.jsonl` and skips if already done. No separate `current_phase` field — reuses existing events (`outer_loop`, `strategy_update`, `strategy_judgment`, `notable_marked`, `program_skip`).
- **migrate_legacy unbound variable (C-3)**: `files_to_copy` and `dirs_to_copy` declared outside the `skip_copy` guard; `set -u` no longer aborts idempotent re-runs.
- **DEEP_EVOLVE_HELPER bypass (C-4, R-6)**: Scoped to file-based tools only, AND empty `TOOL_NAME` is treated as Bash-like (safe default: full inspection).
- **prepare-test-runner.py lint TIMEOUT (C-5)**: `run_lint` honors configured `TIMEOUT` instead of hardcoded 60s.
- **resume commit-hash comparison (C-6, R-2, R-4)**: Journal records full 40-char SHA going forward. Legacy short-hash entries are resolved via `git rev-parse` before comparison. `git merge-base --is-ancestor` semantics corrected — ancestor=true now means "rollback possible via `reset HEAD~1^`" (prompts user), ancestor=false means "already removed from HEAD ancestry" (idempotent skip).
- **baseline writeback for minimize metrics (C-7, R-7, new)**: init.md Step 11 now persists the measured raw baseline into `BASELINE_SCORE`, re-measures (producing score=1.0), and records that 1.0 in `session.yaml.metric.baseline`. Requires session.yaml.status="initializing" during init and transition to "active" at Step 11 end.

### High-Priority Fixes
- **session_id TOCTOU (H-1)**: Collision check inside the project lock; suffix retry handles concurrent init races.
- **epoch transition archive (H-2)**: Generation immediately after a Tier 3 auto-expansion is auto-kept as the new epoch's baseline.
- **pending meta-archive source updates (H-3)**: `.pending-archive.jsonl` carries tagged `new_entry`/`update_source` records so flock-timeout sessions don't lose `transfer_success_rate` updates.
- **multi-framework test parsing (H-4, R-8)**: Added explicit jest, vitest, cargo test, go test, and pytest detection. Unparseable output now reports 0/0 instead of inflating pass_rate via the old `(PASS|ok|\.)` fallback.
- **lint summary + diagnostic fallback (H-5, R-10)**: Counts errors/warnings from `"N errors"` summary lines; when no summary exists, falls back to counting diagnostic lines (`error:`, `warning:`) — catches clippy/rustc-style linters that omit totals.
- **coverage TOTAL anchor (H-6)**: Prefers `TOTAL`/`Total`/`All files` line; falls back to the last `%` in output.
- **pytest skipped exclusion (R-9)**: `passed+failed+errors` for total (skipped neither passed nor failed, per pytest convention).

### Medium/Low Fixes
- **init.md lineage canonical (M-1, R-12)**: `lineage_set` event is the sole canonical path. `--parent=<id>` flag still accepted for backwards compat but not invoked from init.md.
- **`current_branch:` 2-space anchor (M-2, R-11)**: `cmd_check_branch_alignment` matches only the top-level lineage.current_branch (2-space indent) via awk; nested `forked_from.current_branch` is ignored.
- **receipt type annotations (M-3)**: Every field in `evolve-receipt.json` has an explicit number/string/boolean type comment to prevent `cmd_append_meta_archive_local` arithmetic breakage.
- **dirty-tree targeted whitelist (L-1, R-3)**: Replaces the prior dead-code filter with `awk '$1 != "??" || $2 !~ /^\.deep-evolve\//'` — detects real untracked files while exempting session state.

### Template Weighting
- `prepare-test-runner.py` score composition normalizes over active weights only; test-only projects reach score=1.0 when coverage/lint are disabled.
- `prepare-stdout-parse.py` minimize inversion has an explicit `score <= 0` guard.

## v2.2.1

### Improvements
- **Notable keep 마킹 의무화**: Outer Loop Step 6.5.4a — generation별 top-3 kept 실험을 자동으로 notable 마킹. receipt의 notable_keeps 데이터 품질 향상. (originally planned for v2.3)
- **README v2.2 feature 반영**: Session Management, Resume, History, Lineage 기능을 README에 문서화
- **SKILL.md 사용법 확장**: resume/history 커맨드를 사용법 섹션에 추가

## v2.2.0

### Features
- **Session namespace**: `.deep-evolve/<session-id>/` per-session 격리, 세션 간 데이터 보존
- **`/deep-evolve resume`**: 중단된 세션 재개, integrity check, orphan experiment 감지
- **`/deep-evolve history`**: 프로젝트 내 세션 목록, lineage tree, aggregate 통계
- **Session lineage**: 선행 세션의 strategy/program/notable keeps를 새 세션에 상속 (informational only)
- **Inherited Context**: program.md에 선행 세션 결론 자동 삽입
- **Immutable receipt v2.2.0**: experiments_table, generation_snapshots(cap 10), notable_keeps, runtime_warnings, parent_session
- **Shell helper**: `hooks/scripts/session-helper.sh` with 13 subcommands, --dry-run support

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
