# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.4.2] — 2026-05-18 (Codex-native plugin manifest and AGENTS guide)

### Added

- `.codex-plugin/plugin.json` — Codex-native plugin manifest pointing at the same skill and hook surfaces as the Claude Code manifest, keeping the existing `claude-deep-*` repository identity.
- `AGENTS.md` — Codex project guide covering runtime surfaces and verification commands.

### Changed

- README now documents Codex compatibility alongside the existing Claude Code surface.

## [3.4.1] — 2026-05-18 (Codex 1024-char description limit fix)

### Fixed

- Trimmed the `deep-evolve-workflow` skill description to fit Codex's 1024-character limit; Codex was silently skipping the skill at load time, breaking the cross-platform parity shipped in v3.4.0. Behavior unchanged.

## [3.4.0] — 2026-05-18 (command → skill conversion: cross-platform parity)

### Changed

- `/deep-evolve` is now a `user-invocable: true` skill instead of a slash command. Claude Code users keep typing `/deep-evolve [args…]` unchanged; Codex / Copilot CLI / Gemini CLI / Agent SDK callers can now invoke the same workflow via `Skill({ skill: "deep-evolve:deep-evolve", args: "…" })`.

### Migration

No user action required. Existing sessions, `.deep-evolve/` state, and journal events are unaffected; resume works transparently.

## [3.3.3] — 2026-05-13 (plugin-dev validation cleanup + manifest drift CI guard)

### Added

- Cross-file version drift guard asserting `.claude-plugin/plugin.json`, `package.json`, the workflow skill frontmatter, and `session-helper.sh` `HELPER_VERSION` stay in lockstep.
- `pytest` step added to the CI matrix on `ubuntu-latest` + `macos-latest`.

### Changed

- Workflow skill `SKILL.md` rewritten with a full routing table (all 11 protocols), state-machine table, and CLI argument matrix so the workflow can be entered from the skill alone.
- Plugin guard `hooks.json` description updated to reflect current v3.0+ behavior; PreToolUse hook timeout raised from 2s to 5s for cold-cache headroom on macOS (protected file set and deny-by-default behavior unchanged).
- `package.json` description aligned with the plugin manifest.

## [3.3.2] — 2026-05-12 (interrupted-session recovery test)

### Added

- Session-recovery test pinning the dangling-state contract of `session-helper.sh` `resolve_current` and `detect_orphan_experiment` against corrupted state. Production code unchanged.

## [3.3.1] — 2026-05-12 (protect-readonly hook golden test)

### Added

- Golden-fixture regression coverage for the `protect-readonly` PreToolUse hook across the tool × session-state × meta-mode matrix, pinning exit code, decision, and reason. No hook behavior change.

## [3.3.0] — 2026-05-12 (reverse handoff + compaction telemetry)

### Added

- `emit-handoff.js` — emits a reverse handoff envelope (`handoff_kind: evolve-to-deep-work`) at session completion, chaining `parent_run_id` to an upstream forward handoff to close the round-trip.
- `emit-compaction-state.js` — emits a `compaction-state` envelope (`trigger: loop-epoch-end`, `strategy: receipt-only`) at each session-completion boundary, powering the dashboard's compaction metrics.

### Changed

- Envelope helper and CI validator extended to allow the `handoff` and `compaction-state` artifact kinds.

### Notes

- Producer-only: deep-evolve emits these artifacts but does not consume them.

## [3.2.0] — 2026-05-08 (M3 common artifact envelope)

Adopts the M3 cross-plugin envelope contract for `evolve-receipt.json` and `evolve-insights.json`. Pre-3.2.0 receipts continue to read transparently; no `session.yaml` schema bump, no resume break.

### Added

- `envelope.js` — zero-dep helper for ULID generation, git detection, envelope wrap/unwrap, and a strict identity check (producer / artifact_kind / schema.name).
- `wrap-evolve-envelope.js` — CLI wrapper that wraps receipts/insights with atomic temp-then-rename write so concurrent finishers and mid-write interruption cannot leave truncated JSON.
- Self-test validator mirroring the suite-side schema (ULID, SemVer 2.0.0, RFC 3339, kebab-case, `additionalProperties` strict).

### Changed

- `evolve-receipt` and `evolve-insights` now emit the suite-wide envelope (`schema_version: "1.0"` + `envelope` + `payload`). `evolve-insights` is a multi-source aggregator: it omits `parent_run_id` and records each consumed source in `provenance.source_artifacts[]`.
- Init now reads `recurring-findings.json` envelope-aware (bash fast path + jq identity guard) and records the consumed `run_id` so completion can chain `parent_run_id`.

### Cross-plugin chain

- `evolve-receipt.envelope.parent_run_id` chains to the consumed deep-review `recurring-findings.envelope.run_id` when that file is itself an envelope.

### Compatibility

- Legacy (pre-3.2.0) receipts read transparently via fall-through; foreign-producer envelopes at a receipt path are rejected by the identity guard. No worktree migration required.

## [3.1.1] — 2026-04-26 (runtime hardening)

Patch release hardening v3.1.0 runtime guards. No protocol or session schema changes; v3.1.0 sessions resume unchanged.

### Fixed

- `protect-readonly.sh` now blocks Bash-side reads of `prepare.py` / `prepare-protocol.md` (`cat`, `less`, `tee -a`, `perl -i`, etc.) under deny-by-default matching, while keeping `python prepare.py` execution allowed.
- Per-seed `program.md` under seed worktrees now shares the session-root `program.md` META_MODE gate.
- `scheduler-signals.py` tolerates legacy `status`-keyed journal events, falls back to `evaluated`-event score lookup, rejects boolean-as-numeric coercion, and adds an `experiments_used_this_epoch` per-seed signal.
- `baseline-select.py` non-quarantine filter now also rejects `status == "killed_shortcut_quarantine"`.
- `status-dashboard.py` counts only terminal `kept`/`discarded` events deduped by `(seed_id, experiment_id)`, eliminating double-counts.
- `seed_killed` parsing tolerates null/non-string `condition` and splits raw condition from free-text reasoning.
- `prepare-stdout-parse.py` collapses score to `0.0` when stdout omits declared metrics, instead of awarding the `2.0` ceiling that masked partial-parse failures as infinite improvements.

### Migration

None. New guards apply automatically to in-flight sessions on the next hook fire.

## [3.1.0] — 2026-04-26 (virtual parallel N-seed)

Major release adding parallel N-seed exploration to the v3.0 Inner/Outer Loop. Each session runs N=1–9 independent seed worktrees coordinated by an adaptive scheduler over a shared forum, with session-end synthesis merging per-seed results into a single best branch. v3.0.x sessions remain fully supported via version-tier routing.

### Added

- **Virtual parallel N-seed** — N=1–9 seed worktrees under `.deep-evolve/<sid>/seeds/<seed_id>/worktree/`; a coordinator dispatches subagents and each per-seed inner loop runs unchanged with `seed_id` injected into journal events.
- **β/γ seed differentiation** — β seeds are init-time intentionally-ambiguous directions; γ seeds are mid-session AI replacements via the `grow_then_schedule` decision.
- **Adaptive scheduler** — `scheduler-decide.py` returns `schedule` / `kill_then_schedule` / `grow_then_schedule` from per-seed signals (Q, in-flight block, borrows-received MIN-wins, last-keep age) plus session-wide signals (allocation floor, fairness deficit).
- **Forum + cross-seed borrow exchange** — append-only flock-protected `forum.jsonl` with a two-phase borrow lifecycle (`borrow_planned` → `cross_seed_borrow`, with `borrow_abandoned` janitor cleanup) and borrow preflight guardrails.
- **Convergence classifier** — `convergence-detect.py` classifies borrows as `evidence_based` / `borrow_chain_convergence` / `contagion_suspected`, weighted differently in the Outer Loop.
- **Kill management** — condition whitelist, `--kill-seed` CLI queue, and in-flight-deferred kill draining with AskUserQuestion confirmation.
- **Session-end synthesis** — a synthesis worktree merges seed branches with a 4-step cascade fallback (preferred → non-quarantine → best-effort → no-baseline) and structured fallback notes.
- **Init / resume / meta-archive schema_v4** — AI classifies the project into a suggested N; AskUserQuestion confirms it; resume reconciles yaml/journal drift (prefer-journal); meta-archive entries gain a `virtual_parallel` snapshot (v2/v3/v4 coexist).
- **CLI flags** — `--no-parallel`, `--n-min`, `--n-max` (with N_MIN ≤ N_MAX enforced), `--kill-seed`, and the `--status` per-seed dashboard.

### Changed

- `session.yaml` gains a `virtual_parallel` block (`n_current`, `n_initial`, `n_range`, `budget_total`, and per-seed entries); `deep_evolve_version: "3.1.0"`.
- `journal.jsonl` gains v3.1 events (`seed_initialized`, `seed_block_completed/failed`, `seed_killed`, `init_vp_analysis`, `resume_drift_detected`, `synthesis_commit/failed`, `borrow_planned`, `borrow_abandoned`, `seed_scheduled`); forum-side events live in `forum.jsonl`.
- New runtime files `forum.jsonl` and `kill_requests.jsonl`; `session-helper.sh` gains seed/synthesis/kill-queue subcommands.

### Migration

- v3.0.x sessions resume under v3.1 via version-tier routing with single-seed paths unchanged; no schema migration.
- v3.1 sessions can run N=1 (`--no-parallel`), behaving equivalently to v3.0 single-seed.
- Deprecation roadmap (unchanged): 3.0.x full v2 support → 3.1.0 warning → 3.2.0 read-only completion → 4.0.0 v2 schema removed.

### Known Issues (deferred to 3.1.x)

Five non-blocking polish items in `scheduler-decide.py` / `coordinator.md` (signals-parse ordering, type-vs-business exit-code split, pseudocode/signature alignment, scheduler cross-field validation) were verified non-blocking and ticketed for the patch backlog.

## [3.0.0] — 2026-04-22 (AAR-inspired evidence-rich hill-climbing)

Major release adding four AAR-inspired behavioral layers to the Inner/Outer Loop, gated on `deep_evolve_version: "3.0.0"`. v2.2.2 sessions remain fully supported via soft migration. (Reference: Wen et al. 2026, "Automated Weak-to-Strong Researcher".)

### Added

- **Idea-category entropy tracking** — a 10-category taxonomy with Shannon entropy computed each Outer Loop to prevent exploration collapse.
- **Legibility Gate** — mandatory rationale on every `kept` event; flagged keeps without a valid rationale convert to discard.
- **Shortcut Detector** — flags keeps where a tiny code change produces a large score jump; three cumulative flags force a Section D prepare expansion with adversarial scenarios. Opt-in `seal_prepare_read` blocks reads of `prepare.py` during the inner loop.
- **Diagnose-and-Retry** — one-shot recovery on crash, severe drop, or error keywords; session cap of 10 retries, per-experiment retry capped at 1.

### Changed

- `strategy.yaml` schema `version: 2` adds category weights and shortcut/legibility/entropy sections; `session.yaml` gains matching tracking blocks; v3 `results.tsv` uses 9 columns (auto-detected from the header). Completion report gains a "v3.0.0 Signals" section.

### Migration

- v2.2.2 sessions resume with v2 code paths unchanged (warning banner). v2 meta-archive entries are translated on read via deterministic mapping.

---

## v2.2.2

### Fixed

- **prepare.py cwd regression** — all three CLI templates now walk up to find `.deep-evolve/`'s parent, working for both the v2.2.0 namespace and legacy flat layouts.
- **Paused session state + idempotent resume** — the Outer Loop toggles `paused`/`active` and skips already-completed sub-steps by checking their journal events.
- **resume commit-hash comparison** — the journal records full 40-char SHAs; legacy short hashes are resolved before comparison and `--is-ancestor` semantics were corrected.
- **Baseline writeback for minimize metrics** — init persists the measured raw baseline and re-measures so `session.yaml.metric.baseline == 1.0`.
- **session_id collision** — the collision check moved inside the project lock with suffix retry for concurrent init races.
- **Multi-framework test parsing** — explicit jest / vitest / cargo test / go test / pytest detection; unparseable output reports 0/0 instead of inflating the pass rate.
- **Lint + coverage parsing** — counts errors/warnings from summary lines (falling back to diagnostic lines), and anchors coverage on the `TOTAL` line.
- Several `set -u` / lint-timeout / dirty-tree-whitelist robustness fixes.

### Changed

- `prepare-test-runner.py` normalizes score over active weights only, so test-only projects can reach 1.0; `prepare-stdout-parse.py` minimize inversion has an explicit `score <= 0` guard.

## v2.2.1

### Added

- Notable keeps are now marked automatically (top-3 kept experiments per generation), improving receipt `notable_keeps` quality.

### Changed

- README documents the v2.2 Session Management / Resume / History / Lineage features; usage docs add the resume/history commands.

## v2.2.0

### Added

- **Session namespace** — per-session isolation under `.deep-evolve/<session-id>/`, preserving data across sessions.
- `/deep-evolve resume` — resume an interrupted session with integrity checks and orphan-experiment detection.
- `/deep-evolve history` — session list, lineage tree, and aggregate stats.
- **Session lineage** — a new session can inherit a prior session's strategy / program / notable keeps (informational), auto-injected into `program.md`.
- **Immutable receipt v2.2.0** — experiments table, generation snapshots, notable keeps, runtime warnings, and parent-session reference.
- `session-helper.sh` shell helper with `--dry-run` support.

### Changed

- **Breaking:** `.deep-evolve/` layout changed from flat to per-session namespace (auto-migration prompt on first run); sessions are now preserved rather than deleted; `sessions.json` → event-sourced `sessions.jsonl`.

## v2.1.2

### Changed

- Inner-loop Step 6 restructured so the Outer Loop auto-triggers first, with AskUserQuestion conditional afterward; added the `outer_loop.auto_trigger` flag (default true) and an Automation Policy block in the `program.md` template. Inner count persisted to `session.yaml`.

### Fixed

- Forward-compat shim that detects the v2.2.0 layout and prints an upgrade notice.

## [2.1.0] — 2026-04-14

### Added

- **Cross-plugin feedback (Phase 3A)** — `evolve-receipt.json` for deep-dashboard, a deep-review trigger before merge/PR with failure fallback, `recurring-findings.json` consumption during init, `evolve-insights.json` export for deep-work/deep-review, a unified 6-option completion menu, and an `outcome` field tracking session disposition.

## [2.0.0] — 2026-04-13

### Added

- **Self-evolutionary experiment loop** — 2-tier architecture with an evolvable `strategy.yaml` parameter layer and an Outer Loop that mutates strategy per a Q(v) meta-metric.
- 3-layer self-evolution (parameters + strategy text + evaluation expansion).
- Strategy archive (stepping stones + parent selection), code archive (named-branch backtracking), and idea ensemble (multi-candidate selection per experiment).
- Cross-project strategy transfer via a flock-protected meta-archive; Evaluation Epoch separation for `prepare.py` versioning.

### Changed

- Meta Analysis now auto-revises `program.md`; Section D (prepare expansion) changed from manual to auto-triggered on convergence.

### Fixed

- `protect-readonly.sh` grep pipe logic; `prepare-stdout-parse.py` minimize inversion; unified scoring contract (always higher-is-better); corrected repository URL.

## [1.1.0] — 2026-04-07

### Added

- **Open-ended project analysis** — game engines, custom build systems, and non-standard projects are now analyzable.
- **Protocol evaluation mode** — tool-based evaluation via MCP servers, browser automation, and external APIs, with a `prepare-protocol.md` template (also guarded by `protect-readonly.sh`).

### Changed

- Stage 1–2 analysis switched from hardcoded file lists to open-ended signal-based discovery; unknown projects now prompt the user instead of refusing to proceed; evaluation mode (cli/protocol) is recommended automatically.

## [1.0.0] — 2026-04-06

### Added

- Initial release.
- Conversational init with 5-stage project deep analysis.
- Three `prepare.py` templates: stdout-parse, test-runner, scenario.
- Experiment loop with a journal-based atomic state machine and diminishing-returns detection.
- Resume support across sessions; `prepare.py` versioning and expansion.
- `protect-readonly.sh` hook for experiment safety (Write/Edit/Bash) and a branch + clean-tree guard for safe rollback.
- Completion report with result-application options (merge/PR/keep/discard).
