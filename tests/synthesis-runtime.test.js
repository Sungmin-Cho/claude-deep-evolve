'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  processBeta,
  processBetaGrowth,
  selectBaseline,
  buildSeedPrompt,
  writeSeedProgram,
  renderForumSummary,
  renderCrossSeedAudit,
  renderFallbackNote,
  renderStatus,
  collectSynthesis,
  finalizeSynthesis,
} = require('../hooks/scripts/runtime/synthesis.cjs');
const { OPERATIONS, dispatch } = require('../hooks/scripts/deep-evolve-runtime.cjs');

const fixturePath = path.join(__dirname, 'fixtures', 'runtime', 'synthesis-cases.json');
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

test('frozen beta fixtures preserve N=1, N>1, collision retry, and growth oracle outputs', () => {
  for (const row of cases.beta) {
    const actual = row.mode === 'growth'
      ? processBetaGrowth(row.existing, row.input)
      : processBeta(row.n, row.input);
    assert.deepEqual(actual, row.expected, row.name);
  }
});

test('baseline cascade preserves preferred, non-quarantine, best-effort, and no-baseline oracle outputs', () => {
  for (const row of cases.baseline) {
    assert.deepEqual(selectBaseline({ seeds: row.seeds }), row.expected, row.name);
  }
  assert.throws(() => selectBaseline({ seeds: [{ id: true }] }), (error) => error.rc === 2);
});

test('seed prompt is byte-stable, pins absolute paths, and accepts POSIX and Windows absolute paths', () => {
  const input = {
    seed_id: 2,
    worktree_path: '/tmp/project with spaces/seed_2',
    session_root: '/tmp/project with spaces/.deep-evolve/s1',
    branch: 'evolve/s1/seed-2',
    n_block: 4,
    helper_path: '/tmp/plugin with spaces/hooks/scripts/session-helper.sh',
  };
  const first = buildSeedPrompt(input);
  const second = buildSeedPrompt(structuredClone(input));
  assert.equal(first, second);
  assert.ok(first.startsWith('You are running as seed_2. Your first two actions MUST be:'));
  for (const value of [input.worktree_path, input.session_root, input.branch, input.helper_path]) {
    assert.match(first, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(first, /Step 5\.f/);
  assert.throws(() => buildSeedPrompt({ ...input, worktree_path: 'relative/path' }), /absolute/i);
  assert.doesNotThrow(() => buildSeedPrompt({
    ...input,
    worktree_path: 'C:\\Project With Spaces\\seed_2',
    session_root: 'C:\\Project With Spaces\\.deep-evolve\\s1',
    helper_path: 'C:\\Plugin With Spaces\\session-helper.sh',
  }, { platform: 'win32' }));
});

test('seed program preserves N=1 base bytes and prefixes N>1 beta deterministically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task5 seed program '));
  const basePath = path.join(root, 'base.md');
  const worktree = path.join(root, 'seed worktree');
  fs.mkdirSync(worktree);
  fs.writeFileSync(basePath, Buffer.from('# Base\r\nbytes\r\n'));
  const n1 = writeSeedProgram({ baseProgramPath: basePath, worktreePath: worktree, beta: null });
  assert.equal(fs.readFileSync(n1.output_path).equals(fs.readFileSync(basePath)), true);
  const beta = { seed_id: 2, direction: '방향', hypothesis: '가설', rationale: '이유' };
  const n2 = writeSeedProgram({ baseProgramPath: basePath, worktreePath: worktree, beta });
  const content = fs.readFileSync(n2.output_path, 'utf8');
  assert.ok(content.startsWith('## Initial Research Direction (seed-specific)\n\n**Seed ID**: 2'));
  assert.ok(content.endsWith('# Base\r\nbytes\r\n'));
  assert.throws(() => writeSeedProgram({ baseProgramPath: basePath, worktreePath: worktree, beta: { seed_id: 2 } }), /missing/i);
});

test('forum summary matches the retained Python ordering and markdown bytes', () => {
  const events = [
    { event: 'seed_discard', seed_id: 1 },
    { event: 'seed_keep', seed_id: 2, commit: 'abcdef123456', description: 'faster', score_delta: 0.2 },
    { event: 'cross_seed_borrow', from_seed: 2, to_seed: 1 },
    { event: 'convergence_event', seed_ids: [1, 2], direction: 'shared', judged_as: 'duplicate' },
  ];
  assert.equal(renderForumSummary(events, 4), [
    '# Generation 4 Forum Summary', '',
    '## Seed-1',
    '- 0 keeps, 1 discards',
    '- Borrow given: 0',
    '- Borrow received: 1 (from seed-2)', '',
    '## Seed-2',
    '- 1 keeps, 0 discards',
    '  - keep abcdef12: faster (Δ=0.2)',
    '- Borrow given: 1 (to seed-1)',
    '- Borrow received: 0', '',
    '## Convergence Events',
    "- seed-1, seed-2: direction='shared', judged_as=duplicate",
  ].join('\n'));
});

test('cross-seed audit preserves N=1 short circuit, matrices, paranoid skips, and deterministic string sorting', () => {
  const one = renderCrossSeedAudit([], [{ event: 'seed_initialized', seed_id: 1 }]);
  assert.match(one.markdown, /N\/A — single seed session/);
  const forum = [
    { event: 'seed_keep', seed_id: 10 },
    { event: 'seed_discard', seed_id: 2 },
    { event: 'cross_seed_borrow', from_seed: 10, to_seed: 2 },
    { event: 'cross_seed_borrow', from_seed: 2, to_seed: 2 },
    { event: 'cross_seed_borrow', from_seed: 2 },
    { event: 'convergence_event', seed_ids: [2, 10], judged_as: 'shared_ancestor' },
  ];
  const journal = [{ event: 'seed_initialized', seed_id: 10 }, { event: 'seed_initialized', seed_id: 2 }];
  const audit = renderCrossSeedAudit(forum, journal);
  assert.match(audit.markdown, /\| 10 → 2 \| 1 \|/);
  assert.doesNotMatch(audit.markdown, /\| 2 → 2 \|/);
  assert.ok(audit.markdown.indexOf('| Seed 10 |') < audit.markdown.indexOf('| Seed 2 |'), 'Python key=str sorting');
  assert.deepEqual(audit.warnings, []);
});

test('fallback note preserves Q formatting, baseline reasoning, user choices, and sorted seed snapshot', () => {
  const markdown = renderFallbackNote({
    session: { virtual_parallel: { seeds: [
      { id: 2, status: 'killed_plateau', final_q: 0.4 },
      { id: 1, status: 'active', final_q: 0.8 },
    ] } },
    baseline_reasoning: { chosen_seed_id: 1, tier: 'preferred', ties_broken_on: ['final_q'] },
    synthesis_q: 0.76,
    baseline_q: 0.8,
    user_choice: '2',
  });
  assert.match(markdown, /Branch B option 2 — user-driven fallback/);
  assert.match(markdown, /\*\*delta\*\*: -0\.0400/);
  assert.match(markdown, /최고 seed 채택/);
  assert.ok(markdown.indexOf('| Seed 1 |') < markdown.indexOf('| Seed 2 |'));
  assert.throws(() => renderFallbackNote({
    session: {}, baseline_reasoning: { ties_broken_on: 'final_q' },
    synthesis_q: 0, baseline_q: 0, user_choice: 'none',
  }), /ties_broken_on.*list/i);
});

test('status is read-only, skips malformed JSONL with warnings, dedupes terminal ids, and preserves zero-active state', () => {
  const session = {
    session_id: 's1',
    evaluation_epoch: { current: 2, history: [{}] },
    virtual_parallel: {
      budget_total: 10,
      budget_unallocated: 3,
      'x-active-seed-count': 0,
      seeds: [{ id: 1, status: 'killed_plateau', killed_reason: 'plateau', killed_at: '2026-07-13T10:11:12Z', final_q: 0.4 }],
    },
  };
  const result = renderStatus({
    session,
    journal_text: '{"event":"kept","seed_id":1,"id":7}\nBAD\n{"event":"kept","seed_id":1,"id":7}\n',
    forum_text: '{"event":"cross_seed_borrow","from_seed":1,"to_seed":2}\n[]\n',
  });
  assert.match(result.dashboard, /Active seeds: 0/);
  assert.match(result.dashboard, /Terminal seeds:/);
  assert.match(result.dashboard, /exp=1  keep=1/);
  assert.match(result.dashboard, /Forum: 1 borrow events/);
  assert.equal(result.warnings.length, 2);
});

test('status preserves the active-seed oracle defaults and rejects contradictory identity state', () => {
  const implicitActive = renderStatus({
    session: {
      session_id: 'implicit-active',
      virtual_parallel: { n_current: 1, seeds: [{ id: 1, direction: 'implicit status' }] },
    },
    journal_text: '',
    forum_text: '',
  });
  assert.match(implicitActive.dashboard, /Active seeds: 1/);

  assert.throws(() => renderStatus({
    session: { virtual_parallel: { n_current: 2, seeds: [{ id: 1 }, { seed_id: 1 }] } },
    journal_text: '', forum_text: '',
  }), /duplicate seed identity/i);
  assert.throws(() => renderStatus({
    session: { virtual_parallel: { 'x-active-seed-count': 0, seeds: [{ id: 1 }] } },
    journal_text: '', forum_text: '',
  }), /explicit non-active seed statuses/i);
  assert.throws(() => renderStatus({
    session: { virtual_parallel: { seeds: {} } }, journal_text: '', forum_text: '',
  }), /seeds must be a list/i);
});

test('cross-seed ordering follows the Python oracle code-point order without locale collation', () => {
  const rendered = renderCrossSeedAudit([
    { event: 'convergence_event', judged_as: 'alpha', seed_ids: [1, 2] },
    { event: 'convergence_event', judged_as: 'Zeta', seed_ids: [1, 2] },
    { event: 'convergence_event', judged_as: '\u{1F600}', seed_ids: [1, 2] },
    { event: 'convergence_event', judged_as: '\uE000', seed_ids: [1, 2] },
  ], [
    { event: 'seed_initialized', seed_id: 1 },
    { event: 'seed_initialized', seed_id: 2 },
  ]).markdown;
  assert.ok(rendered.indexOf('| Zeta | 1 |') < rendered.indexOf('| alpha | 1 |'));
  assert.ok(rendered.indexOf('| \uE000 | 1 |') < rendered.indexOf('| \u{1F600} | 1 |'));
});

test('synthesis collection and finalization are deterministic across N=1, success, prompt-window, regression, and no-baseline', () => {
  const collected = collectSynthesis({
    seed_reports: [{ seed_id: 2, final_q: 0.4 }, { seed_id: 1, final_q: 0.8 }],
    baseline_selection: { chosen_seed_id: 1 },
    cross_seed_audit: { exchanges: 1 },
  });
  assert.deepEqual(collected.seed_reports.map((row) => row.seed_id), [1, 2]);
  assert.equal(finalizeSynthesis({ n: 1 }).outcome, 'skipped_n1');
  assert.equal(finalizeSynthesis({ n: 0 }).outcome, 'skipped_zero_active');
  assert.equal(finalizeSynthesis({ n: 2, baseline_q: null }).outcome, 'no_baseline');
  assert.equal(finalizeSynthesis({ n: 2, baseline_q: 0.8, synthesis_q: 0.81, regression_tolerance: 0.05 }).outcome, 'success');
  assert.equal(finalizeSynthesis({ n: 2, baseline_q: 0.8, synthesis_q: 0.77, regression_tolerance: 0.05, user_choice: '1' }).outcome, 'accepted_with_regression');
  assert.equal(finalizeSynthesis({ n: 2, baseline_q: 0.8, synthesis_q: 0.77, regression_tolerance: 0.05, user_choice: '2' }).outcome, 'fallback');
  assert.equal(finalizeSynthesis({ n: 2, baseline_q: 0.8, synthesis_q: 'synthesis_failed', regression_tolerance: 0.05 }).outcome, 'fallback');
});

test('Task 5 and exact Task 6 harness operations are registered while later operations stay absent', () => {
  const expected = [
    'coord.build-seed-prompt', 'coord.write-seed-program', 'coord.status',
    'worktree.create-seed', 'worktree.validate-seed', 'worktree.remove-seed',
    'worktree.create-synthesis', 'worktree.cleanup-failed-synthesis',
    'archive.backtrack', 'archive.save-strategy', 'archive.restore-strategy', 'archive.fork-strategy',
    'synthesis.process-beta', 'synthesis.select-baseline', 'synthesis.forum-summary',
    'synthesis.cross-seed-audit', 'synthesis.write-fallback-note', 'synthesis.collect', 'synthesis.finalize',
    'transfer.lookup', 'transfer.record', 'transfer.prune', 'transfer.export-feedback',
    'artifact.wrap-receipt', 'artifact.wrap-insights', 'artifact.emit-compaction', 'artifact.emit-handoff',
  ];
  for (const operation of expected) assert.equal(OPERATIONS.includes(operation), true, operation);
  const harnessOperations = ['harness.generate', 'harness.migrate-legacy', 'harness.run', 'harness.write-baseline'];
  assert.deepEqual(OPERATIONS.filter((operation) => operation.startsWith('harness.')), harnessOperations);

  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'task5 dispatch '));
  const response = dispatch({
    schema_version: '1.0', operation: 'synthesis.select-baseline',
    context: { project_root: project }, payload: { seeds: cases.baseline[0].seeds },
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.chosen_seed_id, 1);
});

test('supported synthesis module is Python-free and wrapper-CLI-free', () => {
  const source = fs.readFileSync(require.resolve('../hooks/scripts/runtime/synthesis.cjs'), 'utf8');
  assert.doesNotMatch(source, /python(?:3)?|child_process|spawnSync|execFile|session-helper\.sh/);
});
