'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { OPERATIONS } = require('../hooks/scripts/deep-evolve-runtime.cjs');

const root = path.resolve(__dirname, '..');
const workflowRoot = path.join(root, 'skills', 'deep-evolve-workflow');
const protocolRoot = path.join(workflowRoot, 'protocols');
const entrySkill = path.join(root, 'skills', 'deep-evolve', 'SKILL.md');
const workflowSkill = path.join(workflowRoot, 'SKILL.md');
const coordinatorAgent = path.join(root, 'agents', 'evolve-coordinator.md');
const seedAgent = path.join(root, 'agents', 'evolve-seed.md');
const runtimeContract = path.join(protocolRoot, 'runtime-contract.md');
const operationFixture = path.join(root, 'tests', 'fixtures', 'runtime', 'protocol-operations.json');

const existingProtocolNames = [
  'archive.md',
  'completion.md',
  'coordinator.md',
  'history.md',
  'init.md',
  'inner-loop.md',
  'outer-loop.md',
  'resume.md',
  'synthesis.md',
  'taxonomy.md',
  'transfer.md',
];
const finalProtocolNames = [...existingProtocolNames, 'runtime-contract.md'].sort();
const existingProtocols = existingProtocolNames.map((name) => path.join(protocolRoot, name));
const finalProtocols = finalProtocolNames.map((name) => path.join(protocolRoot, name));
const finalActiveFiles = [entrySkill, workflowSkill, ...finalProtocols, coordinatorAgent, seedAgent];
const documentationFiles = [
  path.join(root, 'README.md'),
  path.join(root, 'README.ko.md'),
  path.join(root, 'CLAUDE.md'),
  path.join(root, 'AGENTS.md'),
];
const harnessTemplate = path.join(root, 'templates', 'prepare-protocol.md');
const finalInventoryFiles = [...finalActiveFiles, ...documentationFiles, harnessTemplate];

const FENCE = /```(?:bash|sh|shell)\b/i;
const COLUMN_ZERO_FENCE = /^```(?:bash|sh|shell)\b/i;
const FORBIDDEN = [FENCE, /\.sh\b/, /\b(?:jq|yq|flock)\b/];
const PYTHON_REFERENCE = /\bpython(?:3)?\b|\.py\b|\bpy\s+-3\b/i;
const EXECUTION_VERB = /\b(?:run|execute|invoke|allow)\b/i;
const ACTIVE_WORDING = /\b(?:ground\s+truth|active|supported)\b/i;
const MIGRATION_WORDING = /\b(?:legacy|migrat(?:e|ion|ing)|histor(?:y|ical))\b/i;
const PYTHON_LAUNCHER = /(?:^|[\s`"'[(])(?:python(?:3(?:\.\d+)?)?|py\s+-3)(?=$|[\s`"')\]])/i;
const SHELL_META = /(?:&&|\|\||[;&|<>`$])/;

const REQUIRED_INTERACTION_IDS = [
  'active-session-action',
  'analysis-confirmation',
  'archive-cleanup',
  'archive-prune',
  'branch-alignment-resolution',
  'completion-outcome',
  'completion-preserve-or-discard',
  'completion-reverse-handoff',
  'contagion-action',
  'diminishing-returns-action',
  'dirty-worktree-resolution',
  'evaluation-method',
  'experiment-count',
  'finished-session-action',
  'goal-selection',
  'harness-regeneration',
  'harness-confirmation',
  'head-mismatch-resolution',
  'init-recovery',
  'inner-resume-action',
  'legacy-layout-migration',
  'lineage-adoption',
  'n-confirmation',
  'orphan-experiment-resolution',
  'outer-loop-trigger',
  'paused-session-action',
  'post-outer-action',
  'program-update',
  'program-update-after-view',
  'review-change-action',
  'review-failure-merge',
  'review-failure-pr',
  'rollback-ancestor',
  'seed-kill-confirmation',
  'seed-worktree-recovery',
  'session-route',
  'synthesis-regression-action',
  'target-file-selection',
  'transfer-adoption',
  'unexpected-head-recovery',
];

const EXPECTED_INPUT_FIELDS = Object.freeze({
  "session.resolve-current": [],
  "session.read": [
    "session_id"
  ],
  "session.list": [
    "status"
  ],
  "session.start": [
    "goal",
    "parent_session_id",
    "initial_state"
  ],
  "session.mark-status": [
    "session_id",
    "status"
  ],
  "session.migrate-legacy": [],
  "session.check-alignment": [
    "session_id"
  ],
  "session.detect-orphan": [
    "session_id"
  ],
  "session.append-local-archive": [
    "session_id"
  ],
  "session.render-inherited-context": [
    "parent_session_id"
  ],
  "session.lineage-tree": [],
  "session.patch": [
    "session_id",
    "operation_id",
    "expected_session_sha256",
    "expected_journal_sha256",
    "path",
    "value"
  ],
  "session.record-baseline": [
    "session_id",
    "operation_id",
    "expected_session_sha256",
    "expected_journal_sha256",
    "raw_score",
    "normalized_score",
    "harness_identity"
  ],
  "session.finish-experiment": [
    "session_id",
    "operation_id",
    "expected_session_sha256",
    "expected_journal_sha256",
    "expected_forum_sha256",
    "expected_results_sha256",
    "seed_id",
    "experiment"
  ],
  "session.record-evaluator-expansion": [
    "session_id",
    "operation_id",
    "expected_session_sha256",
    "expected_journal_sha256",
    "harness_identity",
    "reason",
    "trigger_generation"
  ],
  "session.complete": [
    "session_id",
    "operation_id",
    "expected_session_sha256",
    "expected_journal_sha256",
    "outcome",
    "final_branch",
    "final_commit",
    "report",
    "receipt",
    "synthesis",
    "final_strategy"
  ],
  "virtual.init": [
    "session_id",
    "analysis",
    "n_chosen",
    "total_budget"
  ],
  "virtual.append-seed": [
    "session_id",
    "operation_id",
    "expected_session_sha256",
    "expected_journal_sha256",
    "seed_id",
    "worktree_path",
    "branch",
    "beta",
    "creation_kind"
  ],
  "virtual.rebuild-seeds": [
    "session_id",
    "operation_id",
    "expected_session_sha256",
    "expected_journal_sha256",
    "expected_results_sha256"
  ],
  "virtual.set-field": [
    "session_id",
    "key",
    "value"
  ],
  "metrics.entropy": [
    "events",
    "window_size"
  ],
  "metrics.migrate-v2-weights": [
    "weights"
  ],
  "metrics.count-flagged": [
    "events"
  ],
  "metrics.retry-budget": [
    "events",
    "cap"
  ],
  "metrics.init-budget-split": [
    "total",
    "n"
  ],
  "metrics.grow-allocation": [
    "pool",
    "n_current"
  ],
  "coord.append-journal": [
    "session_id",
    "event",
    "seed_id"
  ],
  "coord.append-forum": [
    "session_id",
    "event",
    "seed_id"
  ],
  "coord.tail-forum": [
    "session_id",
    "limit"
  ],
  "coord.quarantine-malformed": [
    "session_id",
    "file",
    "malformed"
  ],
  "coord.queue-user-kill": [
    "session_id",
    "seed_id"
  ],
  "coord.queue-kill": [
    "session_id",
    "seed_id",
    "condition",
    "final_q",
    "experiments_used"
  ],
  "coord.list-user-kill-requests": [
    "session_id"
  ],
  "coord.ack-user-kill-request": [
    "session_id",
    "operation_id",
    "request_id",
    "choice_id",
    "expected_session_sha256",
    "expected_journal_sha256",
    "expected_forum_sha256",
    "expected_kill_queue_sha256",
    "expected_kill_requests_sha256"
  ],
  "coord.drain-kill-queue": [
    "session_id",
    "operation_id",
    "expected_session_sha256",
    "expected_journal_sha256",
    "expected_kill_queue_sha256",
    "expected_kill_requests_sha256"
  ],
  "coord.begin-seed-block": [
    "session_id",
    "operation_id",
    "decision_id",
    "seed_id",
    "block_size",
    "pre_dispatch_head",
    "expected_epoch",
    "budget_preimage",
    "expected_session_sha256",
    "expected_journal_sha256"
  ],
  "coord.finish-seed-block": [
    "session_id",
    "operation_id",
    "block_id",
    "seed_id",
    "status",
    "returned_head",
    "summary",
    "expected_session_sha256",
    "expected_journal_sha256",
    "expected_forum_sha256",
    "expected_kill_queue_sha256",
    "expected_kill_requests_sha256"
  ],
  "coord.advance-epoch": [
    "session_id",
    "operation_id",
    "expected_epoch",
    "completed_block_ids",
    "reason",
    "expected_session_sha256",
    "expected_journal_sha256",
    "expected_results_sha256"
  ],
  "scheduler.signals": [
    "session_id"
  ],
  "scheduler.decide": [
    "decision",
    "signals"
  ],
  "scheduler.kill-conditions": [
    "seed",
    "session",
    "ai_judgments",
    "user_kill_request"
  ],
  "scheduler.borrow-preflight": [
    "self_seed_id",
    "self_experiments_used",
    "candidates",
    "journal",
    "forum"
  ],
  "scheduler.borrow-abandoned": [
    "events",
    "current_block_id",
    "staleness_blocks"
  ],
  "scheduler.classify-convergence": [
    "keeps",
    "similarities",
    "inspired_by_map",
    "cross_seed_borrow_events",
    "threshold",
    "p3_floor",
    "epoch"
  ],
  "coord.build-seed-prompt": [
    "session_id",
    "seed_id",
    "block_id",
    "decision_id",
    "n_block"
  ],
  "coord.write-seed-program": [
    "session_id",
    "seed_id",
    "beta"
  ],
  "coord.status": [
    "session_id"
  ],
  "worktree.create-seed": [
    "session_id",
    "seed_id",
    "base_commit"
  ],
  "worktree.validate-seed": [
    "session_id",
    "seed_id",
    "pre_dispatch_head"
  ],
  "worktree.remove-seed": [
    "session_id",
    "seed_id"
  ],
  "worktree.create-synthesis": [
    "session_id",
    "baseline_commit"
  ],
  "worktree.cleanup-failed-synthesis": [
    "session_id"
  ],
  "archive.backtrack": [
    "session_id",
    "candidates",
    "strategy",
    "fork_number",
    "reason",
    "program_context"
  ],
  "archive.save-strategy": [
    "session_id",
    "generation",
    "metrics"
  ],
  "archive.restore-strategy": [
    "session_id",
    "generation"
  ],
  "archive.fork-strategy": [
    "session_id",
    "generations"
  ],
  "synthesis.process-beta": [
    "mode",
    "n",
    "project_analysis",
    "existing_seeds",
    "input"
  ],
  "synthesis.select-baseline": [
    "seeds"
  ],
  "synthesis.forum-summary": [
    "session_id",
    "generation"
  ],
  "synthesis.cross-seed-audit": [
    "session_id"
  ],
  "synthesis.write-fallback-note": [
    "session_id",
    "baseline_reasoning",
    "synthesis_q",
    "baseline_q",
    "user_choice"
  ],
  "synthesis.collect": [
    "seed_reports",
    "baseline_selection",
    "cross_seed_audit"
  ],
  "synthesis.finalize": [
    "n",
    "baseline_q",
    "synthesis_q",
    "regression_tolerance",
    "user_choice"
  ],
  "transfer.lookup": [
    "selected_id"
  ],
  "transfer.record": [
    "entry",
    "source_id",
    "this_session_success"
  ],
  "transfer.prune": [
    "selected_ids"
  ],
  "transfer.export-feedback": [
    "payload",
    "source_artifacts",
    "session_id",
    "publication_id",
    "expected_session_sha256"
  ],
  "artifact.wrap-receipt": [
    "payload",
    "parent_run_id",
    "session_id",
    "source_artifacts",
    "source_recurring_findings",
    "publication_id",
    "expected_session_sha256",
    "legacy_artifact_sha256"
  ],
  "artifact.wrap-insights": [
    "payload",
    "session_id",
    "source_artifacts",
    "publication_id",
    "expected_session_sha256",
    "legacy_artifact_sha256"
  ],
  "artifact.emit-compaction": [
    "payload",
    "parent_run_id",
    "session_id",
    "source_artifacts",
    "publication_id",
    "expected_session_sha256"
  ],
  "artifact.emit-handoff": [
    "payload",
    "parent_run_id",
    "session_id",
    "source_artifacts",
    "publication_id",
    "expected_session_sha256"
  ],
  "harness.generate": [
    "session_id",
    "spec"
  ],
  "harness.migrate-legacy": [
    "session_id"
  ],
  "harness.run": [
    "session_id",
    "options"
  ],
  "harness.write-baseline": [
    "session_id",
    "raw_score"
  ]
});

const EXPECTED_OUTPUT_FIELDS = Object.freeze({
  "session.resolve-current": [
    "session_id",
    "session_root"
  ],
  "session.read": [
    "session",
    "session_sha256"
  ],
  "session.list": [
    "sessions"
  ],
  "session.start": [
    "session_id",
    "session_root",
    "session",
    "session_sha256",
    "initialization_id",
    "replayed"
  ],
  "session.mark-status": [
    "session_id",
    "status"
  ],
  "session.migrate-legacy": [
    "session_id",
    "session_root",
    "status"
  ],
  "session.check-alignment": [
    "aligned",
    "expected",
    "actual"
  ],
  "session.detect-orphan": [
    "commit",
    "experiment_id"
  ],
  "session.append-local-archive": [
    "archive_path",
    "entry"
  ],
  "session.render-inherited-context": [
    "markdown",
    "parent_receipt_schema_version"
  ],
  "session.lineage-tree": [
    "lines"
  ],
  "session.patch": [
    "session",
    "session_sha256",
    "replayed",
    "journal_sha256"
  ],
  "session.record-baseline": [
    "session",
    "session_sha256",
    "replayed",
    "journal_sha256"
  ],
  "session.finish-experiment": [
    "experiment_id",
    "status",
    "session",
    "session_sha256",
    "forum_sha256",
    "results_sha256",
    "replayed",
    "journal_sha256"
  ],
  "session.record-evaluator-expansion": [
    "session",
    "session_sha256",
    "prepare_version",
    "replayed",
    "journal_sha256"
  ],
  "session.complete": [
    "session_id",
    "status",
    "outcome",
    "session",
    "session_sha256",
    "replayed",
    "journal_sha256"
  ],
  "virtual.init": [
    "session"
  ],
  "virtual.append-seed": [
    "seed",
    "active_seed_count",
    "budget_unallocated",
    "session_sha256",
    "replayed",
    "journal_sha256"
  ],
  "virtual.rebuild-seeds": [
    "session",
    "session_sha256",
    "projection_sha256",
    "changed",
    "replayed"
  ],
  "virtual.set-field": [
    "session"
  ],
  "metrics.entropy": [
    "entropy_bits",
    "active_categories",
    "sample_size",
    "reason"
  ],
  "metrics.migrate-v2-weights": [
    "weights",
    "pre_normalize_sum"
  ],
  "metrics.count-flagged": [
    "count",
    "last_reset_idx"
  ],
  "metrics.retry-budget": [
    "used",
    "remaining",
    "cap"
  ],
  "metrics.init-budget-split": [
    "allocations"
  ],
  "metrics.grow-allocation": [
    "allocation"
  ],
  "coord.append-journal": [
    "event",
    "ts",
    "session_id",
    "seed_id"
  ],
  "coord.append-forum": [
    "event",
    "ts",
    "session_id",
    "seed_id"
  ],
  "coord.tail-forum": [
    "records"
  ],
  "coord.quarantine-malformed": [
    "ok",
    "rc",
    "audit_identity",
    "source_relative_path",
    "source_preimage_sha256",
    "staged_artifact_path",
    "staged_artifact_sha256",
    "staged_artifact_identity",
    "malformed_lines",
    "recovered",
    "installed"
  ],
  "coord.queue-user-kill": [
    "entry_id",
    "seed_id",
    "requested_at",
    "acknowledged_at",
    "choice_id",
    "kill_entry_id"
  ],
  "coord.queue-kill": [
    "entry_id",
    "seed_id",
    "condition",
    "final_q",
    "experiments_used",
    "queued_at"
  ],
  "coord.list-user-kill-requests": [
    "pending",
    "acknowledged",
    "authority_digests"
  ],
  "coord.ack-user-kill-request": [
    "request_id",
    "seed_id",
    "choice_id",
    "kill_entry_id",
    "applied",
    "queued",
    "replayed",
    "journal_sha256"
  ],
  "coord.drain-kill-queue": [
    "applied",
    "remaining",
    "applied_seed_ids",
    "replayed",
    "journal_sha256"
  ],
  "coord.begin-seed-block": [
    "block_id",
    "seed_id",
    "epoch",
    "pre_dispatch_head",
    "block_size",
    "budget_preimage",
    "session_sha256",
    "replayed",
    "journal_sha256"
  ],
  "coord.finish-seed-block": [
    "block_id",
    "seed_id",
    "status",
    "returned_head",
    "final_q",
    "components",
    "experiment_ids",
    "commits",
    "forum_entry_ids",
    "borrows_given",
    "borrows_received",
    "killed_seed_ids",
    "session_sha256",
    "forum_sha256",
    "kill_queue_sha256",
    "kill_requests_sha256",
    "replayed",
    "journal_sha256"
  ],
  "coord.advance-epoch": [
    "route",
    "from_epoch",
    "to_epoch",
    "generation",
    "Q",
    "components",
    "session_sha256",
    "replayed",
    "journal_sha256"
  ],
  "scheduler.signals": [
    "seeds",
    "session_Q_trend",
    "entropy_current",
    "flagged_rate",
    "forum_activity",
    "budget_unallocated",
    "n_current",
    "active_seed_count",
    "schedulable_seed_ids",
    "zero_active"
  ],
  "scheduler.decide": [
    "accepted",
    "decision",
    "chosen_seed_id",
    "block_size",
    "original_block_size",
    "clamped",
    "reasoning",
    "signals_used",
    "kill_target",
    "new_seed_id",
    "new_seed_allocation",
    "new_seed_direction",
    "journal_events_to_append",
    "fairness_violation",
    "starved_seed_ids",
    "kill_deferred"
  ],
  "scheduler.kill-conditions": [
    "seed_id",
    "killable",
    "conditions_met",
    "details"
  ],
  "scheduler.borrow-preflight": [
    "eligible",
    "skipped",
    "p3_gate_open",
    "self_seed_id"
  ],
  "scheduler.borrow-abandoned": [
    "abandoned_events"
  ],
  "scheduler.classify-convergence": [
    "convergence_events"
  ],
  "coord.build-seed-prompt": [
    "schema_version",
    "policy_ref",
    "project_root",
    "session_id",
    "session_root",
    "seed_id",
    "worktree_path",
    "branch",
    "block",
    "first_actions",
    "runtime_operations",
    "final_response_schema"
  ],
  "coord.write-seed-program": [
    "output_path",
    "bytes",
    "beta_applied"
  ],
  "coord.status": [
    "dashboard"
  ],
  "worktree.create-seed": [
    "seed_id",
    "worktree_path",
    "branch",
    "head"
  ],
  "worktree.validate-seed": [
    "clean",
    "branch",
    "head",
    "worktree_path"
  ],
  "worktree.remove-seed": [
    "removed",
    "pruned",
    "worktree_path"
  ],
  "worktree.create-synthesis": [
    "worktree_path",
    "branch",
    "baseline_commit"
  ],
  "worktree.cleanup-failed-synthesis": [
    "cleaned",
    "noop",
    "orphan",
    "resumed",
    "failed_branch",
    "recovery_path"
  ],
  "archive.backtrack": [
    "selected",
    "branch",
    "previous_branch",
    "commit",
    "metadata_path"
  ],
  "archive.save-strategy": [
    "generation",
    "archive_path"
  ],
  "archive.restore-strategy": [
    "generation",
    "restored"
  ],
  "archive.fork-strategy": [
    "selected",
    "restored",
    "children_count"
  ],
  "synthesis.process-beta": [
    "skipped",
    "reason",
    "directions",
    "direction",
    "retries_used",
    "max_similarity_observed",
    "warning_emitted",
    "warning_context"
  ],
  "synthesis.select-baseline": [
    "chosen_seed_id",
    "tier",
    "ties_broken_on",
    "candidates_count",
    "baseline_selection_reasoning"
  ],
  "synthesis.forum-summary": [
    "output_path",
    "markdown"
  ],
  "synthesis.cross-seed-audit": [
    "output_path",
    "markdown"
  ],
  "synthesis.write-fallback-note": [
    "output_path",
    "markdown"
  ],
  "synthesis.collect": [
    "seed_reports",
    "baseline_selection",
    "cross_seed_audit"
  ],
  "synthesis.finalize": [
    "outcome",
    "fallback_triggered",
    "classification",
    "choice_id"
  ],
  "transfer.lookup": [
    "entries",
    "source_id",
    "source_schema_version",
    "n_prior",
    "weights",
    "virtual_parallel",
    "program_versions",
    "warnings"
  ],
  "transfer.record": [
    "pending",
    "records",
    "recorded_id",
    "source_updated"
  ],
  "transfer.prune": [
    "candidates",
    "pruned",
    "total"
  ],
  "transfer.export-feedback": [
    "envelope",
    "artifact_path",
    "artifact_sha256",
    "publication_id",
    "replayed"
  ],
  "artifact.wrap-receipt": [
    "envelope",
    "artifact_path",
    "artifact_sha256",
    "publication_id",
    "replayed"
  ],
  "artifact.wrap-insights": [
    "envelope",
    "artifact_path",
    "artifact_sha256",
    "publication_id",
    "replayed"
  ],
  "artifact.emit-compaction": [
    "envelope",
    "artifact_path",
    "artifact_sha256",
    "publication_id",
    "replayed"
  ],
  "artifact.emit-handoff": [
    "envelope",
    "artifact_path",
    "artifact_sha256",
    "publication_id",
    "replayed"
  ],
  "harness.generate": [
    "kind",
    "harness_path",
    "config_path"
  ],
  "harness.migrate-legacy": [
    "migrated",
    "kind",
    "engine_sha256",
    "harness_path",
    "config_path"
  ],
  "harness.run": [
    "exit_code",
    "signal",
    "stdout",
    "stderr",
    "timed_out",
    "error_code"
  ],
  "harness.write-baseline": [
    "baseline_score",
    "config_path"
  ]
});

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function countFences(files) {
  let total = 0;
  let column0 = 0;
  let filesWithFences = 0;
  for (const file of files) {
    let fileTotal = 0;
    for (const line of read(file).split(/\r?\n/)) {
      if (!FENCE.test(line)) continue;
      total += 1;
      fileTotal += 1;
      if (COLUMN_ZERO_FENCE.test(line)) column0 += 1;
    }
    if (fileTotal > 0) filesWithFences += 1;
  }
  return {
    files_scanned: files.length,
    files_with_fences: filesWithFences,
    total,
    column0,
    indented_or_blockquote: total - column0,
  };
}

function isAllowedLegacyPreparePyLine(line) {
  const marker = '<!-- legacy-migration-only -->';
  return line.includes(marker)
    && /\bprepare\.py\b/i.test(line)
    && MIGRATION_WORDING.test(line)
    && !EXECUTION_VERB.test(line)
    && !ACTIVE_WORDING.test(line)
    && !PYTHON_LAUNCHER.test(line)
    && !SHELL_META.test(line.replace(marker, ''));
}

function extractRuntimeOps(files) {
  const rows = [];
  const expression = /\bruntime-op:\s*([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)/g;
  for (const file of files.filter((candidate) => fs.existsSync(candidate))) {
    const text = read(file);
    for (const match of text.matchAll(expression)) rows.push({ operation: match[1], file: relative(file) });
  }
  return rows;
}

function interactionTable(text) {
  const start = text.indexOf('<!-- interaction-table:start -->');
  const end = text.indexOf('<!-- interaction-table:end -->');
  if (start < 0 || end <= start) return [];
  return text.slice(start, end).split(/\r?\n/).flatMap((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 5 || !/^`[a-z0-9-]+`$/.test(cells[0])) return [];
    return [{
      id: cells[0].slice(1, -1),
      options: cells[1],
      claude: cells[2],
      codex: cells[3],
      fallback: cells[4],
    }];
  });
}

test('Task 7 RED baseline and final fence contract use one unanchored scanner', () => {
  const runtimeExists = fs.existsSync(runtimeContract);
  const protocolFiles = runtimeExists ? finalProtocols : existingProtocols;
  const protocolOnly = countFences(protocolFiles);
  const entryOnly = countFences([entrySkill]);
  const combined = countFences([...protocolFiles, entrySkill]);
  process.stdout.write(JSON.stringify({ scope: 'protocol-only', ...protocolOnly }) + '\n');
  process.stdout.write(JSON.stringify({ scope: 'entry-skill', ...entryOnly }) + '\n');
  process.stdout.write(JSON.stringify({ scope: 'combined-with-entry', ...combined }) + '\n');

  if (!runtimeExists) {
    assert.deepEqual(protocolOnly, {
      files_scanned: 11,
      files_with_fences: 9,
      total: 91,
      column0: 63,
      indented_or_blockquote: 28,
    });
    assert.deepEqual(entryOnly, {
      files_scanned: 1,
      files_with_fences: 1,
      total: 1,
      column0: 1,
      indented_or_blockquote: 0,
    });
    assert.deepEqual(combined, {
      files_scanned: 12,
      files_with_fences: 10,
      total: 92,
      column0: 64,
      indented_or_blockquote: 28,
    });
    assert.fail('missing Task 7 runtime contract: ' + relative(runtimeContract));
  }

  assert.deepEqual(protocolOnly, {
    files_scanned: 12,
    files_with_fences: 0,
    total: 0,
    column0: 0,
    indented_or_blockquote: 0,
  });
  assert.deepEqual(entryOnly, {
    files_scanned: 1,
    files_with_fences: 0,
    total: 0,
    column0: 0,
    indented_or_blockquote: 0,
  });
  assert.deepEqual(combined, {
    files_scanned: 13,
    files_with_fences: 0,
    total: 0,
    column0: 0,
    indented_or_blockquote: 0,
  });
});

test('the complete Task 7 surface exists and active instructions are host-neutral', () => {
  const missing = finalInventoryFiles
    .filter((file) => !fs.existsSync(file))
    .map(relative);
  const violations = [];
  for (const file of finalActiveFiles.filter((candidate) => fs.existsSync(candidate))) {
    const text = read(file);
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) violations.push(relative(file) + ' contains ' + String(pattern));
    }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (PYTHON_REFERENCE.test(line) && !isAllowedLegacyPreparePyLine(line)) {
        violations.push(relative(file) + ':' + (index + 1)
          + ' contains active/unclassified Python: ' + line.trim());
      }
    }
  }
  assert.deepEqual(
    { missing, violations },
    { missing: [], violations: [] },
    JSON.stringify({ missing, violations }, null, 2),
  );
});

test('the 75-operation fixture is parse-valid and exact before product reconciliation', () => {
  const fixture = JSON.parse(read(operationFixture));
  assert.deepEqual(Object.keys(fixture), ['schema_version', 'operations']);
  assert.equal(fixture.schema_version, '1.0');
  assert.equal(Array.isArray(fixture.operations), true);
  assert.equal(fixture.operations.length, 75);

  const fixtureOperations = [];
  for (const row of fixture.operations) {
    assert.deepEqual(Object.keys(row), [
      'operation', 'owning_protocol', 'trigger', 'input_fields', 'output_fields',
      'legacy_source_function',
    ], row.operation);
    assert.match(row.operation, /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);
    assert.equal(finalProtocolNames.includes(path.basename(row.owning_protocol)), true, row.operation);
    assert.equal(path.dirname(row.owning_protocol),
      'skills/deep-evolve-workflow/protocols', row.operation);
    assert.equal(typeof row.trigger, 'string');
    assert.notEqual(row.trigger.trim(), '');
    assert.equal(Array.isArray(row.input_fields), true);
    assert.equal(Array.isArray(row.output_fields), true);
    assert.equal(new Set(row.input_fields).size, row.input_fields.length,
      row.operation + ' input fields must be unique');
    assert.equal(new Set(row.output_fields).size, row.output_fields.length,
      row.operation + ' output fields must be unique');
    assert.notEqual(row.output_fields.length, 0, row.operation + ' output fields are unauthenticated');
    assert.deepEqual(row.input_fields, EXPECTED_INPUT_FIELDS[row.operation],
      row.operation + ' input fields drifted');
    assert.deepEqual(row.output_fields, EXPECTED_OUTPUT_FIELDS[row.operation],
      row.operation + ' output fields drifted');
    assert.equal(typeof row.legacy_source_function, 'string');
    assert.notEqual(row.legacy_source_function.trim(), '');
    fixtureOperations.push(row.operation);
  }

  assert.equal(new Set(fixtureOperations).size, 75);
  assert.deepEqual(fixtureOperations, [...OPERATIONS]);
  assert.deepEqual(Object.keys(EXPECTED_INPUT_FIELDS), [...OPERATIONS]);
  assert.deepEqual(Object.keys(EXPECTED_OUTPUT_FIELDS), [...OPERATIONS]);

  const prerequisiteOperations = [
    'session.record-baseline',
    'session.finish-experiment',
    'session.record-evaluator-expansion',
    'coord.list-user-kill-requests',
    'coord.ack-user-kill-request',
    'coord.begin-seed-block',
    'coord.finish-seed-block',
    'coord.advance-epoch',
  ];
  for (const operation of prerequisiteOperations) {
    assert.equal(fixtureOperations.includes(operation), true, operation);
  }

  assert.deepEqual(EXPECTED_INPUT_FIELDS['session.start'],
    ['goal', 'parent_session_id', 'initial_state']);
  assert.deepEqual(EXPECTED_INPUT_FIELDS['virtual.append-seed'], [
    'session_id', 'operation_id', 'expected_session_sha256',
    'expected_journal_sha256', 'seed_id', 'worktree_path', 'branch', 'beta',
    'creation_kind',
  ]);
  assert.deepEqual(EXPECTED_OUTPUT_FIELDS['virtual.append-seed'], [
    'seed', 'active_seed_count', 'budget_unallocated', 'session_sha256',
    'replayed', 'journal_sha256',
  ]);
  assert.deepEqual(EXPECTED_INPUT_FIELDS['virtual.rebuild-seeds'], [
    'session_id', 'operation_id', 'expected_session_sha256',
    'expected_journal_sha256', 'expected_results_sha256',
  ]);
  assert.deepEqual(EXPECTED_OUTPUT_FIELDS['virtual.rebuild-seeds'], [
    'session', 'session_sha256', 'projection_sha256', 'changed', 'replayed',
  ]);
  for (const operation of [
    'transfer.export-feedback',
    'artifact.wrap-receipt',
    'artifact.wrap-insights',
    'artifact.emit-compaction',
    'artifact.emit-handoff',
  ]) {
    assert.deepEqual(EXPECTED_OUTPUT_FIELDS[operation],
      ['envelope', 'artifact_path', 'artifact_sha256', 'publication_id', 'replayed']);
  }

  const quarantine = fixture.operations.find(
    (row) => row.operation === 'coord.quarantine-malformed',
  );
  assert.equal(quarantine.owning_protocol,
    'skills/deep-evolve-workflow/protocols/runtime-contract.md');
  assert.match(quarantine.trigger, /maintainer/i);
  assert.deepEqual(quarantine.input_fields, ['session_id', 'file', 'malformed']);
});

test('every registered operation has its declared owner and at least one active consumer', () => {
  const fixture = JSON.parse(read(operationFixture));
  const issues = [];
  for (const row of fixture.operations) {
    const owner = path.join(root, row.owning_protocol);
    if (!fs.existsSync(owner)) {
      issues.push(row.operation + ' owner missing: ' + row.owning_protocol);
      continue;
    }
    const expression = new RegExp(
      '\\bruntime-op:\\s*' + row.operation.replaceAll('.', '\\.') + '\\b',
    );
    if (!expression.test(read(owner))) {
      issues.push(row.operation + ' is not consumed by ' + row.owning_protocol);
    }
  }

  const references = extractRuntimeOps(finalActiveFiles);
  for (const row of references) {
    if (!OPERATIONS.includes(row.operation)) {
      issues.push('unknown runtime operation ' + row.operation + ' in ' + row.file);
    }
  }
  const referenced = new Set(references.map((row) => row.operation));
  for (const operation of OPERATIONS) {
    if (!referenced.has(operation)) issues.push(operation + ' has no active consumer');
  }
  assert.deepEqual(issues, [], JSON.stringify(issues, null, 2));
});

test('v3.5 protected transitions have typed owners and no second active writer', () => {
  const activeInvocation = (file, operation) => {
    if (!fs.existsSync(file)) return [];
    const expression = new RegExp(
      '\\bruntime-op:\\s*' + operation.replaceAll('.', '\\.') + '\\b',
    );
    return read(file).split(/\r?\n\r?\n/).filter((paragraph) => (
      expression.test(paragraph)
      && !/\b(?:never|must not|forbidden|rejects?|do not|legacy-only|below v3\.5)\b/i.test(paragraph)
    ));
  };

  const requirements = [
    [path.join(protocolRoot, 'init.md'), 'session.record-baseline'],
    [path.join(protocolRoot, 'inner-loop.md'), 'session.finish-experiment'],
    [path.join(protocolRoot, 'outer-loop.md'), 'session.record-evaluator-expansion'],
    [path.join(protocolRoot, 'coordinator.md'), 'coord.list-user-kill-requests'],
    [path.join(protocolRoot, 'coordinator.md'), 'coord.ack-user-kill-request'],
    [path.join(protocolRoot, 'coordinator.md'), 'coord.drain-kill-queue'],
    [path.join(protocolRoot, 'coordinator.md'), 'coord.begin-seed-block'],
    [path.join(protocolRoot, 'coordinator.md'), 'coord.finish-seed-block'],
    [path.join(protocolRoot, 'coordinator.md'), 'coord.advance-epoch'],
    [path.join(protocolRoot, 'init.md'), 'virtual.append-seed'],
    [path.join(protocolRoot, 'outer-loop.md'), 'virtual.append-seed'],
    [path.join(protocolRoot, 'resume.md'), 'virtual.rebuild-seeds'],
  ];
  const issues = [];
  for (const [file, operation] of requirements) {
    if (activeInvocation(file, operation).length === 0) {
      issues.push(relative(file) + ' lacks active typed owner ' + operation);
    }
  }

  for (const file of finalActiveFiles) {
    for (const operation of ['virtual.init', 'virtual.set-field']) {
      if (activeInvocation(file, operation).length > 0) {
        issues.push(relative(file) + ' actively invokes forbidden v3.5 ' + operation);
      }
    }
  }

  const protectedEvents = [
    'baseline_recorded',
    'kept',
    'discarded',
    'failed',
    'evaluator_expanded',
    'session_completed',
    'seed_initialized',
    'seed_killed',
    'seed_scheduled',
    'seed_block_completed',
    'seed_block_failed',
    'outer_loop',
    'evaluation_epoch_advanced',
    'experiment_kept',
    'experiment_discarded',
  ];
  for (const file of finalActiveFiles.filter((candidate) => fs.existsSync(candidate))) {
    for (const paragraph of read(file).split(/\r?\n\r?\n/)) {
      if (!/\bruntime-op:\s*coord\.append-(?:journal|forum)\b/.test(paragraph)) continue;
      if (/\b(?:never|must not|forbidden|rejects?|do not)\b/i.test(paragraph)) continue;
      for (const event of protectedEvents) {
        const expression = new RegExp('\\b' + event + '\\b');
        if (expression.test(paragraph)) {
          issues.push(relative(file) + ' generically writes protected event ' + event);
        }
      }
    }
  }
  assert.deepEqual(issues, [], JSON.stringify(issues, null, 2));
});

test('P7 synthesis choices preserve stable IDs, rc classes, and fallback classifications', () => {
  const os = require('node:os');
  const { dispatch } = require('../hooks/scripts/deep-evolve-runtime.cjs');
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-task7-contract-'));
  fs.mkdirSync(path.join(projectRoot, '.deep-evolve', '.runtime-requests'), {
    recursive: true,
  });
  const request = (payload) => dispatch({
    schema_version: '1.0',
    operation: 'synthesis.finalize',
    context: { project_root: projectRoot },
    payload,
  });
  try {
    const accepted = request({
      n: 2,
      baseline_q: 0.8,
      synthesis_q: 0.77,
      regression_tolerance: 0.05,
      user_choice: 'accept-regression',
    });
    assert.equal(accepted.exitCode, 0, JSON.stringify(accepted));
    assert.deepEqual(accepted.result, {
      outcome: 'accepted_with_regression',
      fallback_triggered: false,
      choice_id: 'accept-regression',
    });

    const kept = request({
      n: 2,
      baseline_q: 0.8,
      synthesis_q: 0.77,
      regression_tolerance: 0.05,
      user_choice: 'keep-baseline',
    });
    assert.equal(kept.exitCode, 0, JSON.stringify(kept));
    assert.deepEqual(kept.result, {
      outcome: 'fallback_user_kept_baseline',
      fallback_triggered: true,
      choice_id: 'keep-baseline',
    });

    const stopped = request({
      n: 2,
      baseline_q: 0.8,
      synthesis_q: 0.77,
      regression_tolerance: 0.05,
      user_choice: 'stop',
    });
    assert.equal(stopped.exitCode, 1, JSON.stringify(stopped));
    assert.equal(stopped.error.code, 'synthesis_stopped');

    const missing = request({
      n: 2,
      baseline_q: 0.8,
      synthesis_q: 0.77,
      regression_tolerance: 0.05,
    });
    assert.equal(missing.exitCode, 1, JSON.stringify(missing));
    assert.equal(missing.error.code, 'synthesis_choice_required');

    const stale = request({
      n: 2,
      baseline_q: 0.8,
      synthesis_q: 0.81,
      regression_tolerance: 0.05,
      user_choice: 'keep-baseline',
    });
    assert.equal(stale.exitCode, 2, JSON.stringify(stale));
    assert.equal(stale.error.code, 'synthesis_choice_not_applicable');

    const automatic = request({
      n: 2,
      baseline_q: 0.8,
      synthesis_q: 'synthesis_failed',
      regression_tolerance: 0.05,
    });
    assert.deepEqual(automatic.result, {
      outcome: 'fallback',
      fallback_triggered: true,
      classification: 'automatic-fallback',
    });

    const noBaseline = request({
      n: 2,
      baseline_q: null,
      synthesis_q: 0.7,
      regression_tolerance: 0.05,
    });
    assert.deepEqual(noBaseline.result, {
      outcome: 'no_baseline',
      fallback_triggered: false,
      classification: 'no-baseline',
    });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('P6 completion remains D0 to D1 ordered with immutable publication results', () => {
  const completion = read(path.join(protocolRoot, 'completion.md'));
  const history = read(path.join(protocolRoot, 'history.md'));
  const transfer = read(path.join(protocolRoot, 'transfer.md'));
  const anchors = [
    'completion-order: outcome-final',
    'completion-order: authenticate-final-ref',
    'completion-order: read-d0',
    'completion-order: publish-receipt-d0',
    'completion-order: emit-telemetry-d0',
    'completion-order: session-complete-d0-to-d1',
    'completion-order: archive-d1',
    'completion-order: destructive-cleanup-d1',
  ];
  let prior = -1;
  for (const anchor of anchors) {
    assert.equal(completion.split(anchor).length - 1, 1,
      anchor + ' must occur exactly once');
    const offset = completion.indexOf(anchor);
    assert.ok(offset > prior, anchor + ' is out of lifecycle order');
    prior = offset;
  }

  const transition = completion.indexOf(
    'completion-order: session-complete-d0-to-d1',
  );
  const beforeD1 = completion.slice(0, transition);
  const afterD1 = completion.slice(transition);
  for (const operation of [
    'artifact.wrap-receipt',
    'artifact.emit-compaction',
    'artifact.emit-handoff',
    'session.complete',
  ]) {
    assert.match(beforeD1, new RegExp(
      'runtime-op:\\s*' + operation.replaceAll('.', '\\.') + '\\b',
    ));
  }
  assert.match(beforeD1, /expected_session_sha256:\s*D0/);
  assert.match(afterD1, /runtime-op:\s*session\.append-local-archive\b/);
  assert.match(afterD1, /D1 returned by that exact session\.complete response/);
  assert.doesNotMatch(afterD1, /expected_session_sha256:\s*D0/);
  assert.match(completion, /stale_preimage[^\n]*fatal/i);
  assert.match(completion, /\['update-ref', '-d', final_ref, final_commit\]/);
  assert.match(completion, /shell:\s*false/);
  assert.doesNotMatch(completion, /git\s+branch\s+-[dD]\b/);
  assert.match(history, /completion\.receipt\.relative_path/);
  assert.match(history, /completion\.receipt\.sha256/);
  assert.match(transfer, /runtime-op:\s*transfer\.export-feedback\b/);
  assert.match(transfer, /publication_id/);
  assert.match(transfer, /expected_session_sha256/);
});

test('runtime invocation, interaction adapters, and fail-closed Codex fallback are explicit', () => {
  assert.equal(fs.existsSync(runtimeContract), true,
    'missing ' + relative(runtimeContract));
  const source = read(runtimeContract);
  assert.match(source, /derive.*literal absolute plugin root.*loaded skill file/is);
  assert.match(source, /PROJECT_ROOT\/\.deep-evolve\/\.runtime-requests\//);
  assert.match(source, /node "C:\\Users\\dev\\Deep Evolve Plugin\\hooks\\scripts\\deep-evolve-runtime\.cjs" --request "C:\\Users\\dev\\Project With Spaces\\\.deep-evolve\\\.runtime-requests\\01J00000000000000000000000\.json"/);
  assert.match(source, /node "\/Users\/dev\/Deep Evolve Plugin\/hooks\/scripts\/deep-evolve-runtime\.cjs" --request "\/Users\/dev\/Project With Spaces\/\.deep-evolve\/\.runtime-requests\/01J00000000000000000000000\.json"/);
  assert.match(source, /rc 0[\s\S]*rc 1[\s\S]*rc 2/i);
  assert.match(source, /malformed JSON[\s\S]*stop/i);
  assert.match(source, /codex exec/i);
  assert.match(source, /degraded-but-safe fallback/i);
  assert.match(source, /plain root-task question[\s\S]*stop before mutation/i);
  assert.match(source, /host-owned structured tool adapter/i);
  assert.match(source, /literal authenticated (?:working directory|cwd)/i);
  assert.match(source, /discrete argv or typed fields/i);
  assert.match(source, /explicit \x60--\x60 path boundary/i);
  assert.match(source, /no user-string interpolation/i);
  assert.match(source, /no shell fence, pipeline, operator, or host-variable expansion/i);
  assert.match(source, /tool is missing[\s\S]*ambiguous[\s\S]*root task[\s\S]*before mutation/i);
  assert.match(source, /read-only artifact[\s\S]*native Read adapter[\s\S]*never becomes state authority[\s\S]*may not infer or patch state/i);
  assert.match(source, /artifact\.wrap-receipt[\s\S]*regenerated in full[\s\S]*patching a prior receipt is forbidden/i);
  assert.match(source, /artifact\.wrap-insights[\s\S]*local classified insights[\s\S]*transfer\.export-feedback[\s\S]*cross-plugin feedback/i);

  const table = interactionTable(source);
  const ids = table.map((row) => row.id);
  assert.deepEqual([...ids].sort(), [...REQUIRED_INTERACTION_IDS].sort());
  assert.equal(new Set(ids).size, ids.length);
  for (const row of table) {
    assert.notEqual(row.options, '');
    assert.match(row.claude, /AskUserQuestion/);
    assert.match(row.claude, new RegExp(row.id));
    assert.match(row.codex, /request_user_input/);
    assert.match(row.codex, new RegExp(row.id));
    assert.match(row.fallback, /plain root-task question/i);
    assert.match(row.fallback, /stop before mutation/i);
  }

  const nonContractFiles = finalActiveFiles.filter(
    (file) => file !== runtimeContract && fs.existsSync(file),
  );
  const referencedIds = [];
  for (const file of nonContractFiles) {
    const text = read(file);
    assert.doesNotMatch(text, /\b(?:AskUserQuestion|request_user_input)\b/,
      relative(file) + ' must use stable interaction IDs through runtime-contract.md');
    for (const match of text.matchAll(/\binteraction-id:\s*([a-z0-9-]+)/g)) {
      referencedIds.push(match[1]);
    }
  }
  assert.deepEqual([...new Set(referencedIds)].sort(),
    [...REQUIRED_INTERACTION_IDS].sort());
});

test('coordinator, seed, and synthesis policies expose both host dispatch routes', () => {
  const issues = [];
  for (const [file, agentName, agentPath] of [
    [coordinatorAgent, 'deep-evolve:evolve-coordinator', 'agents/evolve-coordinator.md'],
    [seedAgent, 'deep-evolve:evolve-seed', 'agents/evolve-seed.md'],
  ]) {
    if (!fs.existsSync(file)) {
      issues.push('missing ' + relative(file));
      continue;
    }
    const source = read(file);
    if (!new RegExp(agentName.replace(':', '\\:')).test(source)) {
      issues.push(relative(file) + ' lacks named Claude route');
    }
    if (!/generic subagent/i.test(source)) {
      issues.push(relative(file) + ' lacks Codex generic-subagent route');
    }
    if (!new RegExp('first action[^\\n]*Read ' + agentPath.replaceAll('.', '\\.'), 'i').test(source)) {
      issues.push(relative(file) + ' lacks first policy read');
    }
    if (!/second action[^\n]*verif(?:y|ies)[^\n]*worktree/i.test(source)) {
      issues.push(relative(file) + ' lacks second worktree verification');
    }
    if (!/literal worktree path/i.test(source)) {
      issues.push(relative(file) + ' lacks literal worktree binding');
    }
    if (!/must not (?:change|edit|mutate) another seed branch/i.test(source)) {
      issues.push(relative(file) + ' lacks cross-seed mutation prohibition');
    }
  }

  for (const name of ['coordinator.md', 'synthesis.md']) {
    const source = read(path.join(protocolRoot, name));
    for (const expression of [
      /host-route: claude/,
      /host-route: codex/,
      /deep-evolve:evolve-coordinator/,
      /generic subagent/i,
    ]) {
      if (!expression.test(source)) {
        issues.push(name + ' lacks ' + String(expression));
      }
    }
  }
  assert.deepEqual(issues, [], JSON.stringify(issues, null, 2));
});

test('Codex prompts route through the public entry skill and manifests remain MCP-free', () => {
  const codex = JSON.parse(read(path.join(root, '.codex-plugin', 'plugin.json')));
  const claude = JSON.parse(read(path.join(root, '.claude-plugin', 'plugin.json')));
  assert.equal(Array.isArray(codex.interface.defaultPrompt), true);
  assert.equal(codex.interface.defaultPrompt.length > 0, true);
  for (const prompt of codex.interface.defaultPrompt) {
    assert.match(prompt, /^\$deep-evolve:deep-evolve(?:\s|$)/);
    assert.doesNotMatch(prompt, /deep-evolve-workflow/);
  }
  assert.equal(Object.hasOwn(codex, 'mcpServers'), false);
  assert.equal(Object.hasOwn(claude, 'mcpServers'), false);
});
