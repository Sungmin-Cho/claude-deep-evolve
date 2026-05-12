# Changelog

## [3.3.0] — 2026-05-12 (M5.7.B Reverse Handoff + Compaction Telemetry)

Minor release adopting the M5.7.B leg of the cross-plugin handoff +
dashboard compaction telemetry milestone documented at
`claude-deep-suite/docs/superpowers/plans/2026-05-11-m5.7-plugin-adoption-handoff.md`.
deep-evolve now emits `handoff.json` (`handoff_kind: "evolve-to-deep-work"`,
chaining `parent_run_id` to an upstream forward handoff to close the
round-trip) and `compaction-state.json` (`trigger: loop-epoch-end`,
`strategy: receipt-only`) at each session-completion boundary — the
canonical deep-evolve compaction event.

### Added

- **`hooks/scripts/emit-handoff.js`** — CLI wrapper for reverse handoff
  envelopes. Identity-triplet (`producer = "deep-evolve"`, `artifact_kind = "handoff"`,
  `schema.name = "handoff"`, `schema.version = "1.0"`) set automatically; payload
  required fields enforced before write (`schema_version`, `handoff_kind`,
  `from{producer,completed_at}`, `to{producer,intent}`, `summary`,
  `next_action_brief`) per `claude-deep-suite/schemas/handoff.schema.json`.
  Flags: `--source-parent` (chains `parent_run_id` from upstream envelope —
  forward handoff or evolve-receipt), `--source-evolve-receipt` (alias for
  semantic clarity), `--source` (provenance-only entry).
- **`hooks/scripts/emit-compaction-state.js`** — CLI wrapper for
  compaction-state envelopes. Trigger enum validated against suite schema
  (`phase-transition`, `slice-green`, `loop-epoch-end`, `window-threshold`,
  `manual`, `session-stop`); strategy enum validated. Two input modes: build
  payload from CLI flags (`--trigger`, `--preserved`, `--discarded`,
  `--strategy`, `--pre-tokens`, `--post-tokens`) for protocol-driven emit, OR
  `--payload-file` for skill-composed emit. Powers dashboard metrics
  `suite.compaction.frequency` + `suite.compaction.preserved_artifact_ratio`.
- **`skills/deep-evolve-workflow/protocols/completion.md`** — new
  `M5.7.B — Loop-epoch-end compaction-state emit` section runs after evolve-receipt
  wrap, before apply-path branch. Always-emit on completion to feed dashboard.
  Preserved: evolve-receipt; discarded: code-archive + strategy-archive
  subdirectories. Strategy: receipt-only.
- **`skills/deep-evolve-workflow/protocols/completion.md`** — new
  `M5.7.B — Optional reverse-handoff emit` section. Auto-detects upstream
  forward handoff in `.deep-work/handoffs/*.json` (filters by
  `to.producer === "deep-evolve"`, picks most-recent) and chains `parent_run_id`
  to it. Falls back to evolve-receipt as chain parent when no forward handoff
  exists.
- **`tests/handoff-roundtrip.test.js`** — 14 assertions covering M5.5 #8
  (deep-evolve half): `HANDOFF_REQUIRED`/`COMPACTION_REQUIRED` identical to
  dashboard `PAYLOAD_REQUIRED_FIELDS["deep-evolve/{handoff,compaction-state}"]`,
  reverse-handoff CLI roundtrip producing envelopes that satisfy a mirrored
  `unwrapStrict`, round-trip closure (`reverse-handoff.envelope.parent_run_id
  === forward-handoff.envelope.run_id`), trigger enum coverage (6 values),
  failure paths (missing field → exit 1).

### Changed

- **`hooks/scripts/envelope.js`** — `ALLOWED_ARTIFACT_KINDS` extended from
  `{evolve-receipt, evolve-insights}` to include `handoff` and `compaction-state`.
  Existing identity-triplet semantics preserved for evolve-receipt /
  evolve-insights callers.
- **`scripts/validate-envelope-emit.js`** — `ALLOWED_KINDS` extended symmetrically
  so the CI validator accepts the two new envelope kinds.

### Notes

- This release is **producer-only** for the new artifact kinds. deep-evolve
  does not consume `handoff.json` or `compaction-state.json` from other
  plugins; the dashboard does. Cross-plugin contract is enforced by
  `claude-deep-dashboard/lib/suite-collector.js unwrapStrict`.
- Round-trip closure: when `.deep-work/handoffs/*.json` contains a forward
  handoff (`producer = "deep-work"`, `to.producer = "deep-evolve"`) matching
  the current session, the reverse handoff's `parent_run_id` closes it and
  the dashboard's `suite.handoff.roundtrip_success_rate` rises toward 1.0.
- See `claude-deep-suite/docs/superpowers/plans/2026-05-11-m5.7-plugin-adoption-handoff.md`
  §M5.7.B for the M5 acceptance criteria this milestone closes.

## [3.2.0] — 2026-05-08 (M3 Common Artifact Envelope)

Minor release adopting the M3 cross-plugin envelope contract for both
`evolve-receipt.json` and `evolve-insights.json`. New emits are wrapped in
the suite-wide envelope (`schema_version: "1.0"` + `envelope` + `payload`)
defined in [`claude-deep-suite/docs/envelope-migration.md`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/docs/envelope-migration.md).
Pre-3.2.0 receipts continue to read transparently via legacy fall-through —
no session-yaml schema bump, no resume break. Phase 2 #4 in the M3 rollout.

### Added
- **`hooks/scripts/envelope.js`** — zero-dep helper module exposing
  `generateUlid` (MSB-first Crockford Base32 26-char), `detectGit`,
  `loadProducerVersion` (literal-cwd-resolve via module `__dirname`),
  `wrapEnvelope`, `isEnvelope` (loose), `isValidEnvelope` (strict W4 gate),
  `unwrapEnvelope` (3-way identity check: producer/artifact_kind/schema.name).
- **`hooks/scripts/wrap-evolve-envelope.js`** — CLI wrapper invoked from
  `completion.md` and `transfer.md`. Accepts
  `--artifact-kind {evolve-receipt|evolve-insights}`, `--payload-file`,
  `--output`, plus optional `--source-recurring-findings <path>` (chains
  `parent_run_id` for evolve-receipt) and repeatable `--source-artifact`
  (multi-source aggregator semantics for evolve-insights). **Atomic write**
  via temp+rename (`<output>.tmp.<pid>.<ts>`) so concurrent finishers and
  mid-write interruption cannot leave a truncated JSON.
- **`scripts/validate-envelope-emit.js`** — self-test validator mirroring
  the suite-side schema (`additionalProperties: false` on root / envelope /
  git / schema / provenance / source_artifacts items; `^x-` allowed at root
  + envelope only). Strict identity check on `schema.name === artifact_kind`,
  ULID Crockford Base32 26-char regex, SemVer 2.0.0 (with prerelease + build
  metadata), RFC 3339, git head 7-40 hex, kebab-case kind. Used by both new
  test suites.
- **`tests/envelope-emit.test.js`** + **`tests/envelope-chain.test.js`** —
  70 tests covering ULID lex-monotonicity, identity guards, corrupt-payload
  defense, `payload: null/false/array` rejection, fixture validation,
  `additionalProperties` strict-mirror failures, parent_run_id chain (auto-
  detected from envelope-wrapped recurring-findings; explicit override
  preserved; legacy recurring-findings contributes path only), atomic-write
  no-residue check.
- **`tests/fixtures/sample-evolve-receipt.json`** +
  **`tests/fixtures/sample-evolve-insights.json`** — Phase 3 input for the
  suite-side payload-registry replacement (currently placeholder).

### Changed
- **`skills/deep-evolve-workflow/protocols/completion.md` § Evolve Receipt
  Generation** — payload composition unchanged, but the final write now
  goes through `wrap-evolve-envelope.js` with atomic temp+rename and a
  gated cleanup snippet (`set -euo pipefail` + `if helper; then rm tmp;
  else exit 1; fi` so payload temp survives on failure for retry). Outcome
  update post user-selection now uses `jq --arg o ... '.payload.outcome =
  $o'` + atomic rename to preserve `envelope.run_id` (do NOT re-wrap).
- **`skills/deep-evolve-workflow/protocols/transfer.md` § E.1 step 5** —
  `evolve-insights.json` now M3-envelope-wrapped. Multi-source aggregator
  semantics: `parent_run_id` is **omitted**; consumed sources
  (`~/.claude/deep-evolve/meta-archive.jsonl`,
  `.deep-review/recurring-findings.json` when present) land in
  `envelope.provenance.source_artifacts[]`.
- **`skills/deep-evolve-workflow/protocols/init.md` § Stage 3.5** —
  envelope-aware read of `.deep-review/recurring-findings.json`. Bash-only
  fast path detection (two grep anchors — `"schema_version": "1.0"` and
  `"envelope":`), then `jq -e` 3-way identity guard before unwrapping
  `.payload.findings`. Captures `envelope.run_id` to `session.yaml`
  `cross_plugin.recurring_findings_run_id` so completion's wrap helper can
  chain `parent_run_id` later. Pre-1.4.0 deep-review emits (top-level
  `findings` array) continue to work via fall-through.
- **`hooks/scripts/session-helper.sh` —
  `cmd_append_meta_archive_local` + `cmd_render_inherited_context`** —
  envelope-aware receipt reads via shared `_RECEIPT_QUERY_BASE` jq
  expression. Identity-checked unwrap (producer/artifact_kind/schema.name
  three-way). Foreign-producer envelopes at the same path fall through to
  root, so legacy-shape queries return null rather than leaking another
  plugin's payload.
- **`skills/deep-evolve-workflow/protocols/history.md` § Step 1 detail
  mode** — documented envelope-aware receipt query pattern (same
  `_RECEIPT_QUERY_BASE` jq expression).
- **`package.json` `files` array** — now includes `hooks/scripts/*.js`,
  `scripts/`, and `tests/` so envelope helpers + validator + fixtures ship
  with the plugin.
- **Version bump** — `plugin.json.version` and `package.json.version`
  3.1.1 → 3.2.0 (minor — envelope adoption = new contract). Existing v3.1
  sessions continue to emit `session.yaml.deep_evolve_version: "3.1.0"` and
  resume unchanged; the version literal recorded in the receipt **payload**
  still reflects the session's recorded version, not the plugin version.

### Cross-plugin chain
- **deep-review → deep-evolve**: `evolve-receipt.envelope.parent_run_id`
  chains to `recurring-findings.envelope.run_id` (automatic when the
  consumed file is itself an envelope; helper uses `isValidEnvelope`
  strict gate to reject corrupt envelopes from contributing trace data —
  handoff §4 W4 lesson).
- **deep-evolve → deep-work**: deep-work v6.5.0+ already detects the
  envelope at `.deep-evolve/<sid>/evolve-insights.json` via
  `gather-signals.sh`'s identity-guarded `read_json_safe` — no consumer
  change required.

### Compatibility
- Legacy receipts (pre-3.2.0) read transparently — `isEnvelope` returns
  false, `unwrapEnvelope` passes through, jq base falls through to root.
- Foreign-producer envelopes at receipt path → identity guard rejects
  silently (warns on stderr in `unwrapEnvelope`, jq falls through to root).
- No worktree migration required; sessions started under 3.1.x complete
  cleanly under 3.2.0.

## [3.1.1] — 2026-04-26 (Runtime Hardening)

Patch release hardening v3.1.0 runtime guards. No protocol or session
schema changes; `session.yaml.deep_evolve_version` remains `"3.1.0"` and
all v3.1.0 sessions resume cleanly under v3.1.1 (forward-compatible).
This release bumps only the package and helper version
(`HELPER_VERSION` 3.1.0 → 3.1.1; `package.json` / `plugin.json` /
`SKILL.md` 3.1.0 → 3.1.1).

### Fixed
- **`protect-readonly.sh` — Bash-side seal_prepare_read coverage**
  (hooks/scripts/protect-readonly.sh): `seal_prepare_read=1` sessions
  previously blocked Read-tool access to `prepare.py` /
  `prepare-protocol.md` but allowed Bash bypasses
  (`cat prepare.py`, `less prepare.py`, etc.). Bash references now route
  through the same guard via new `command_references` /
  `is_direct_prepare_execution` helpers. Direct execution
  (`python prepare.py`) remains the single allowed exception.
- **`protect-readonly.sh` — protected-file matching**
  (hooks/scripts/protect-readonly.sh): replaced the fragile
  write-detection regex with a deny-by-default match — every Bash
  reference to a protected file blocks unless the direct-execution
  exception applies. Fixes edge cases (`tee -a`, `perl -i`, shell
  substitutions into protected paths) the old regex did not catch.
- **`protect-readonly.sh` — per-seed `program.md` protection**
  (hooks/scripts/protect-readonly.sh): worktree paths
  `$SESSION_ROOT/worktrees/seed_*/program.md` now share the same
  `program_update` / `outer_loop` META_MODE gate as the session-root
  `program.md`. Closes a virtual-parallel hole where inner-loop
  subagents could write per-seed `program.md` outside meta-mode.
- **`scheduler-signals.py` — legacy `status`-key tolerance**
  (hooks/scripts/scheduler-signals.py): journal events authored by
  older helpers used `status` rather than `event`; signals now read
  both via a new `event_type()` canonicalizer, preventing the scheduler
  from silently dropping pre-3.1 events on resume.
- **`scheduler-signals.py` — score lookup fallback**
  (hooks/scripts/scheduler-signals.py): `kept` events without an inline
  `q`/`score` field now fall back to a `(seed_id, id)` lookup against
  `evaluated` events. New `numeric_q()` enforces
  `isinstance(x, (int, float)) and not isinstance(x, bool)` to prevent
  boolean-as-numeric coercion.
- **`scheduler-signals.py` — `experiments_used_this_epoch` signal**
  (hooks/scripts/scheduler-signals.py): per-seed signal added so the
  scheduler can distinguish lifetime experiments from current-epoch
  experiments — relevant for kill/grow decisions after a fairness reset.
- **`baseline-select.py` — killed-shortcut-quarantine recognition**
  (hooks/scripts/baseline-select.py): § 8.2 5.b non-quarantine filter
  now also rejects seeds whose `status == "killed_shortcut_quarantine"`,
  in addition to the existing `killed_reason == "shortcut_quarantine"`
  check. Closes a hole where status-only sessions could leak
  quarantined seeds into baseline selection.
- **`status-dashboard.py` — terminal-experiment dedup**
  (hooks/scripts/status-dashboard.py): per-seed experiment counter now
  counts only `kept` / `discarded` events (not `evaluated`) and dedups
  by `(seed_id, experiment_id)` to prevent double-counting when the
  journal contains both `evaluated` and a subsequent `kept` / `discarded`
  for the same experiment.
- **`session-helper.sh` — kill-event field robustness**
  (hooks/scripts/session-helper.sh): `seed_killed` parsing tolerates
  null / non-string `condition`, splits `killed_reason` (raw condition,
  `killed_` prefix stripped) from `killed_reasoning` (free-text
  rationale), and preserves optional `final_q` / `experiments_used`
  from the event.
- **`templates/prepare-stdout-parse.py` — missing-metric scoring**
  (templates/prepare-stdout-parse.py): when fewer metrics than declared
  in `METRICS` are parsed from stdout, score now collapses to `0.0`
  instead of falling into the `score <= 0` ceiling branch (which would
  award `2.0`, treating a partial-parse failure as an infinite improvement).

### Added
- **`hooks/scripts/tests/test_v31_protect_readonly.py`** (119 lines):
  exhaustive coverage of the hardened guard — Bash bypass attempts,
  direct-execution allowance, per-seed `program.md` protection,
  META_MODE interaction.
- **`hooks/scripts/tests/test_v31_scheduler_fairness.py`** (57 lines):
  scheduler-signals fairness including `experiments_used_this_epoch`.
- **`hooks/scripts/tests/test_v31_scheduler_signals.py`** (43 lines):
  legacy `status`-key tolerance, `numeric_q` fallback, score lookup
  against `evaluated` events.
- **`hooks/scripts/tests/test_package_manifest.py`** (18 lines):
  asserts `package.json` / `plugin.json` / `SKILL.md` / `HELPER_VERSION`
  stay in sync — prevents the version drift this release patches.
- **`hooks/scripts/tests/test_prepare_stdout_parse_template.py`**
  (61 lines): partial-parse → `score = 0.0` invariant + existing scoring paths.
- **`hooks/scripts/tests/test_v31_baseline_select.py`** (14 lines):
  `killed_shortcut_quarantine` status-path coverage.
- **`hooks/scripts/tests/test_v31_status_subcommand.py`** (+38 lines):
  per-seed terminal-experiment dedup verification.

### Changed
- `session-helper.sh` `HELPER_VERSION` 3.1.0 → 3.1.1.
- `package.json` / `.claude-plugin/plugin.json` /
  `skills/deep-evolve-workflow/SKILL.md` version 3.1.0 → 3.1.1.
- `session-helper.sh` C-2 / C-3-A / C-3-B "Known limitations" comments
  now reference "future release" rather than "v3.1.1" (since this IS
  v3.1.1; those structural fixes remain on the backlog).

### Migration
None. v3.1.0 sessions resume under v3.1.1 unchanged. New guards apply
automatically to in-flight sessions on next protect-readonly hook fire.

## [3.1.0] — 2026-04-26 (Virtual Parallel N-seed)

Major release adding parallel N-seed exploration to the v3.0 AAR-Inspired
Inner/Outer Loop. Each session now runs N=1..9 independent seed worktrees
coordinated by an adaptive scheduler over a shared forum, with session-end
synthesis merging the per-seed results into a single best branch. Gated on
`session.yaml.deep_evolve_version: "3.1.0"`. v3.0.x sessions remain fully
supported via VERSION_TIER routing — `pre_v3` / `v3_0` / `v3_1_plus` arms
across 4 protocol files (inner-loop.md, outer-loop.md, synthesis.md,
coordinator.md).

### Added
- **Virtual parallel N-seed** (§ 4 Architecture, § 5 Seed Lifecycle):
  N=1..9 seed worktrees under `.deep-evolve/<sid>/seeds/<seed_id>/worktree/`.
  Coordinator dispatches subagents via prose contract; per-seed inner loop
  runs unchanged with `seed_id` injected into journal events.
- **β/γ seed differentiation** (§ 5): β seeds (init-time intentionally-
  ambiguous directions, generated once at A.3), γ seeds (mid-session
  AI-replacement via `grow_then_schedule` decision). `seed_origin ∈ {β, γ}`
  in seed schema.
- **Adaptive scheduler** (§ 6): `hooks/scripts/scheduler-decide.py` returns
  one of `ALLOWED_DECISION = {schedule, kill_then_schedule, grow_then_schedule}`.
  `REQUIRED_BY_DECISION` per-decision required-field schema enforced
  (kill_then_schedule: kill_target; grow_then_schedule: new_seed_id).
  Drift-detector test asserts dict-key parity with `ALLOWED_DECISION` to
  catch future contributors who add a decision type without updating the
  schema. Per-seed signals — Q, in_flight_block, borrows_received MIN-wins,
  last_keep_age. Session-wide signals — P3 allocation floor (default 3),
  fairness deficit. Soft fairness floor (§ 6.6).
- **Forum + borrow exchange** (§ 7): `.deep-evolve/<sid>/forum.jsonl`
  append-only, flock-protected. 2-phase borrow lifecycle —
  `borrow_planned` (journal-side, Step 5.f intent marker) →
  `cross_seed_borrow` (forum-side, emitted when borrow is executed in
  the next kept commit), with `borrow_abandoned` (journal-side janitor)
  cleaning stale planned events older than 2 blocks without a matching
  `cross_seed_borrow`. Forum field SOT — `to_seed`/`from_seed` (no `_id`
  suffix) across all 8+ codebase sites. `dedup_planned` keyed on
  journal-side `borrow_planned`; `dedup_executed` keyed on forum-side
  `cross_seed_borrow` (data-source contract per spec § 7.1).
  `borrows_received` MIN-wins per § 7.4 P1.
- **Borrow guardrails** (§ 7.4 P2/P3): `hooks/scripts/borrow-preflight.py`
  enforces P2 flagged-filter (no shortcut/legibility-failed sources) +
  P3 allocation floor + per-(borrower, source_commit) dedup.
- **Convergence classifier** (§ 7.5): `hooks/scripts/convergence-detect.py`
  3-class borrow-ancestry-closure classifier — `evidence_based`,
  `borrow_chain_convergence`, `contagion_suspected`. Outer Loop weights
  them 2× / 1× / 0 stagnation credit.
- **Kill management** (§ 5.5): `hooks/scripts/kill-conditions.py`
  5-condition whitelist (faithful § 5.5a 4-clause `sustained_regression`
  pseudocode); `hooks/scripts/kill-request-writer.sh` for `--kill-seed`
  CLI; `session-helper.sh` `append_kill_queue_entry` /
  `drain_kill_queue` with W-9 in-flight deferral + Phase 2/3
  snapshot-then-process atomicity. `seed_killed` events carry
  `queued_at`/`applied_at`/`final_q`/`experiments_used`.
- **Session-end synthesis** (§ 8): `synthesis.md` 7-step orchestration +
  N=1 short-circuit per § 8.5. `baseline-select.py` 4-step cascade
  (5.a preferred → 5.b non-quarantine → 5.c best-effort → 5.d no-baseline)
  + 4-level tiebreak (final_q → keeps → borrows → seed_id).
  `cross-seed-audit.py` Step 3 forum aggregator (borrow matrix +
  convergence tally + per-seed activity). `generate-fallback-note.py`
  structured fallback explanation with verbatim Korean AskUserQuestion
  options per spec § 8.2.
- **Synthesis worktree helpers** (§ 4.1, § 8.2 Step 5): `session-helper.sh`
  `cmd_create_synthesis_worktree` + `cmd_cleanup_failed_synthesis_worktree`
  (renames branch to `synthesis-failed-<ts>` for audit trail).
- **Init flow** (§ 5, § 13): A.1.6 AI classification along
  (project_type, eval_parallelizability) → `n_suggested` (1..9 matrix).
  A.2.6 AskUserQuestion N confirmation (honors `DEEP_EVOLVE_NO_PARALLEL` /
  `DEEP_EVOLVE_N_MIN` / `DEEP_EVOLVE_N_MAX` env vars from CLI flags).
  A.3.6 per-seed worktree creation + β generator + per-seed program.md
  + session.yaml seeds[] population. New `init_vp_analysis` /
  `seed_initialized` journal events (in `(unset SEED_ID; ...)` subshells
  to scope coordinator-side events away from per-seed SEED_ID).
- **Resume reconciliation** (§ 11): resume.md Step 3.5 v3.1 reconciliation —
  3.5.a yaml + journal seed-set read; 3.5.b W-3 drift detection with
  prefer-journal resolution + `resume_drift_detected` event +
  `rebuild_seeds_from_journal` helper; 3.5.c per-seed
  `validate_seed_worktree` with rc=3 → AskUserQuestion W-11.1 recovery,
  rc=4/5/6 → exit 1; 3.5.d git-log-is-truth replay per § 11.3 with
  `planned_commit_sha` / `pre_plan_head_sha` matching → synthesized
  `committed`/`discarded` events.
- **CLI flags** (§ 13): `--no-parallel`, `--n-min=<k>`, `--n-max=<k>`,
  `--kill-seed=<id>`, `--status` subcommand. Cross-flag invariant
  N_MIN ≤ N_MAX enforced (rc=2 on violation). `--status` is a thin
  terminal dispatcher invoking new pure-function helper
  `hooks/scripts/status-dashboard.py` rendering per-seed dashboard
  per § 13.1.
- **Meta-archive schema_v4** (§ 10, § 9.4): `transfer.md` 4-arm version
  gate (`2` / `3` / `4` / `>=5`) with v3 entries → `N_prior=1`,
  v4 entries → full `virtual_parallel` snapshot as prior signal to A.1.6
  classifier. Section F prune candidates extended with v3-schema
  270-day rule (paralleling v2-schema 180-day rule).
- **VERSION_TIER routing**: `$VERSION_TIER ∈ {pre_v3, v3_0, v3_1_plus}`
  + `IS_V31` boolean canonical across 4 protocol files (inner-loop.md,
  outer-loop.md, synthesis.md, coordinator.md). 4-arm case statement
  pattern uniform — virtual_parallel-DEPENDENT sub-steps gated on
  `v3_1_plus`; virtual_parallel-INDEPENDENT (shortcut_detection,
  seal_prepare) gated on `!= pre_v3`.
- **Pytest test suite** (§ 12.1 W-8 per-file enumeration): 40
  `test_v31_*.py` files exercising every v3.1 surface — borrow lifecycle
  (`borrow_abandoned`, `borrow_guardrails`, `borrow_preflight`),
  scheduler (`scheduler_decide`, `scheduler_decision`,
  `scheduler_signals`, `scheduler_fairness`), kill management
  (`kill_conditions`, `kill_queue`, `kill_request`, `kill_seed_cli`),
  forum + cross-seed (`forum_io`, `forum_summary`, `cross_seed_audit`,
  `convergence_detect`, `step_5e_forum_emission`), synthesis
  (`baseline_select`, `synthesis_protocol`, `synthesis_worktree`,
  `synthesis_fallback`, `fallback_note`), seed lifecycle (`beta_init`,
  `beta_growth`, `budget_alloc`, `worktree_manager`, `worktree_helpers`,
  `write_seed_program`), init + resume (`init_protocol`, `resume_v31`,
  `session_yaml_schema`, `journal_events`, `transfer_schema_v4`),
  CLI + status (`cli_flags`, `status_subcommand`, `helper_locator`),
  protocol fixtures (`coordinator_protocol_exists`, `version_gate`,
  `inner_loop_updates`, `outer_loop_updates`, `subagent_prompt`).
  Total: 517 passed, 1 xfailed (T22 polling gap intentionally surfaced).
- **New fixtures**: `multi_seed_mock/`, `synthesis_regression/`,
  `forum_multi_seed/`, `forum_malformed/`, `v3_0_resume_sample/`,
  `transfer_schema_v3/`, `transfer_schema_v4/`, `kill_scenarios/`
  (4 sub-fixtures), `borrow_scenario/`.

### Changed
- `session.yaml` schema: `deep_evolve_version: "3.1.0"`; new
  `virtual_parallel` block. Top-level fields: `n_current` (int, active seed
  count), `n_initial` (int, value at session init), `n_range`
  (`{min: 1, max: 9}`, AI's allowed N range), `budget_total` (int,
  total experiment budget shared across seeds). Per-seed entries in
  `seeds[]` carry: `id` (int, seed identifier), `status ∈ {active, killed,
  completed}`, `direction` (str, β/γ direction summary), `hypothesis` (str,
  initial hypothesis), `initial_rationale` (str), `worktree_path`,
  `branch`, `created_at` (ISO 8601), `created_by ∈ {init_batch,
  grow_then_schedule}` (init-time vs mid-session γ replacement —
  serves the same role as the spec's β/γ distinction at runtime),
  `experiments_used`, `keeps`, `borrows_given`, `borrows_received`
  (MIN-wins per § 7.4 P1), `current_q` (float, latest Q score),
  `allocated_budget` (int, this seed's share of `budget_total`),
  `killed_at` (null|ISO), `killed_reason` (null|str). Block size
  (`{1, 2, 3, 5, 8}`) is an AI Q3 judgment per scheduler turn — NOT
  a session.yaml field; it lives in `seed_scheduled` journal events.
- `journal.jsonl` extended events for v3.1 (journal-side):
  `seed_initialized`, `seed_block_completed`, `seed_block_failed`,
  `seed_killed` (with `queued_at`/`applied_at`/`final_q`/`experiments_used`),
  `init_vp_analysis`, `resume_drift_detected`, `synthesis_commit`,
  `synthesis_failed`, `borrow_planned`, `borrow_abandoned`,
  `seed_scheduled`. All v3.1-specific events are emitted in
  `(unset SEED_ID; ...)` subshells when written by the coordinator
  (vs per-seed inner-loop subagents which inherit the seed-scoped
  SEED_ID). Forum-side events (`cross_seed_borrow`, `convergence_event`)
  are written separately to `forum.jsonl` per § 7.1 data-source contract.
- `forum.jsonl` (new) — `.deep-evolve/<sid>/forum.jsonl`, append-only,
  flock-protected. Field SOT: `to_seed`/`from_seed` (NO `_id` suffix).
  Tail-skip-and-warn on malformed lines (data-flow direction:
  consumer-tolerance for partial-event resilience).
- `kill_requests.jsonl` (new) — pending kill queue. Coordinator drains
  via `drain_kill_queue` at next scheduler turn + AskUserQuestion
  confirmation; W-9 in-flight deferral; W-1 HELPER_SOURCED guard.
- `meta-archive.jsonl` schema_v4 — adds `virtual_parallel` snapshot to
  E.0 recording. v3.0.x sessions continue emitting schema_version=3
  (no snapshot); all three (v2/v3/v4) coexist.
- `protocols/inner-loop.md` Step 0.5 (block params intake +
  seed_id tagging contract — closes Gap 4); v3.1 forum consultation in
  Step 1; Step 5.f borrow evaluation (calls borrow-preflight.py).
- `protocols/outer-loop.md` Step 6.5.0 (epoch boundary sync:
  forum-summary.md generation, convergence detection, AI-driven N
  re-evaluation) + 6.5.6 v3.1 addendum (evidence_based −2 /
  borrow_chain_convergence −1 / contagion_suspected 0 + WARN +
  AskUserQuestion escalation). Per-substep VERSION_TIER gates.
- `protocols/synthesis.md` (new) — 7-step orchestration + N=1 short-
  circuit + Step 6 3-branch fallback ladder per spec § 8.2 verbatim
  AskUserQuestion options.
- `protocols/coordinator.md` (new) — coordinator dispatch protocol +
  scheduler-decide invocation contract + forward-compat VERSION_TIER
  gate.
- `commands/deep-evolve.md` Step 0.5 — 4 new flags (`--no-parallel`,
  `--n-min`, `--n-max`, `--kill-seed`) + `--status` subcommand. Env-var
  flags propagate to A.2.6 in init.md.
- `transfer.md` schema_version=4 read path with W-1 forward-compat
  default `*)` skip + warn; v5+ rejected loudly with rc=2.
- `session-helper.sh` HELPER_VERSION 3.0.0 → 3.1.0; new subcommands
  `append_seed_to_session_yaml`, `set_virtual_parallel_field`,
  `cmd_create_synthesis_worktree`, `cmd_cleanup_failed_synthesis_worktree`,
  `append_kill_queue_entry`, `drain_kill_queue`,
  `rebuild_seeds_from_journal`.

### Migration
- v3.0.x sessions resume under v3.1 code via VERSION_TIER routing —
  `v3_0` arm preserves single-seed code paths unchanged. No schema
  migration; v3.0 sessions stay schema_version=3 in meta-archive.
- v3.1 sessions write schema_version=4 entries with `virtual_parallel`
  snapshot. v3.0 readers ignore unknown blocks (additive schema; § 9.4 R12
  mitigation).
- N=1 path: v3.1 sessions can run with N=1 via `--no-parallel` or AI
  decision; behaves equivalently to v3.0 single-seed but uses v3.1
  schema and event names. Resume detects N=1 short-circuit via
  `session.yaml.virtual_parallel.N == 1`.
- Deprecation roadmap (unchanged): 3.0.x v2 full support → 3.1.0 warning
  → 3.2.0 read-only completion → 4.0.0 v2 schema removed. v3.1 retains
  v3.0's v2-warning banner via VERSION_TIER `pre_v3` arm.

### Known Issues (deferred to 3.1.x)
Five non-blocking polish items deferred during G12 review iterations
2026-04-26. Each was empirically verified as non-blocking and is
ticketed for the v3.1.x patch backlog.

- **H1**: `--signals` JSON parse runs after business rejections in
  `scheduler-decide.py` (extends G3 ordering pattern but to the signals
  path). Cosmetic — signals are AI-side input, less likely malformed
  than decision JSON. Patch will move parse before business rejections.
- **H2**: `nsa < 3` numeric guard combines type+business in single rc=1
  exit. Misclassifies type errors (non-int) as below-P3-floor business
  rejection. Coordinator still rejects appropriately, just with
  misleading message. Patch will split type-validation (rc=2) from
  business rejection (rc=1).
- **I1**: `coordinator.md:134-139` pseudocode shows
  `append_kill_queue_entry(validated.kill_target, reasoning)` (2 args)
  but helper requires 4. Pseudocode-only (not directly-executed bash) —
  AI agent reads `session-helper.sh` to derive correct signature. Patch
  will align pseudocode with helper signature.
- **I2c**: Cross-validation of scheduler decision fields (`kill_target`,
  `new_seed_id`) against `--signals.seeds` requires signals-correlation
  complexity — e.g. detecting `kill_target=999` for a seed that does not
  exist in signals, or `new_seed_id=1` collision with existing seed.
  Design discussion needed before implementation. Patch may extend
  `scheduler-decide.py` cross-field validators.
- **info-2**: Pseudocode-only banner in `coordinator.md` — doc clarity
  polish, not functional. Patch will add explicit "PSEUDOCODE — see
  session-helper.sh for actual signatures" header above the affected
  block.

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
