'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNTIME = path.resolve(__dirname, '..', 'hooks', 'scripts', 'deep-evolve-runtime.cjs');
const { dispatch } = require(RUNTIME);
const START_FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'session-start-v3.5.json'),
  'utf8',
));
const CASES = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'session-mutation-cases.json'),
  'utf8',
));

const FIXED_NOW = Date.parse('2026-07-13T14:00:00Z');
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function clone(value) {
  return structuredClone(value);
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr || `${args.join(' ')} failed`);
  return result.stdout.trim();
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function operationId(number) {
  return `01J${String(number).padStart(23, '0')}`;
}

function fileDigest(file) {
  return digest(fs.readFileSync(file));
}

function request(projectRoot, operation, payload, dependencies = {}) {
  return dispatch({
    schema_version: '1.0',
    operation,
    context: { project_root: projectRoot },
    payload,
  }, {
    now: () => FIXED_NOW,
    ...dependencies,
  });
}

function expectSuccess(response, label) {
  assert.equal(response.ok, true, `${label}: ${JSON.stringify(response)}`);
  assert.equal(response.exitCode, 0, label);
  return response.result;
}

function makeProject(t, {
  label = 'typed-session',
  direction = 'maximize',
  nChosen = 1,
  totalBudget = 12,
} = {}) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-session-mutation-'));
  const projectRoot = path.join(outer, label);
  fs.mkdirSync(path.join(projectRoot, '.deep-evolve'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'index.js'), 'module.exports = 1;\n');
  git(projectRoot, ['init', '-q']);
  git(projectRoot, ['config', 'user.email', 'runtime@example.invalid']);
  git(projectRoot, ['config', 'user.name', 'Runtime Test']);
  git(projectRoot, ['add', 'src/index.js']);
  git(projectRoot, ['commit', '-qm', 'base']);
  const baseCommit = git(projectRoot, ['rev-parse', 'HEAD']);

  const initialState = clone(START_FIXTURE.initial_state);
  initialState.metric.direction = direction;
  initialState.virtual_parallel.n_chosen = nChosen;
  initialState.total_budget = totalBudget;
  const started = expectSuccess(request(projectRoot, 'session.start', {
    goal: `${label} goal`,
    initial_state: initialState,
  }), 'session.start');
  const sessionRoot = fs.realpathSync(started.session_root);
  const result = {
    outer,
    projectRoot: fs.realpathSync(projectRoot),
    stateRoot: path.join(projectRoot, '.deep-evolve'),
    sessionId: started.session_id,
    sessionRoot,
    sessionPath: path.join(sessionRoot, 'session.yaml'),
    journalPath: path.join(sessionRoot, 'journal.jsonl'),
    forumPath: path.join(sessionRoot, 'forum.jsonl'),
    resultsPath: path.join(sessionRoot, 'results.tsv'),
    registryPath: path.join(projectRoot, '.deep-evolve', 'sessions.jsonl'),
    baseCommit,
    initialState,
  };
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  return result;
}

function authority(project) {
  const files = {
    session: fs.readFileSync(project.sessionPath),
    journal: fs.readFileSync(project.journalPath),
    forum: fs.readFileSync(project.forumPath),
    results: fs.readFileSync(project.resultsPath),
  };
  return {
    files,
    session_sha256: digest(files.session),
    journal_sha256: digest(files.journal),
    forum_sha256: digest(files.forum),
    results_sha256: digest(files.results),
  };
}

function assertAuthorityBytes(project, expected, label) {
  const actual = authority(project).files;
  for (const name of Object.keys(expected.files)) {
    assert.deepEqual(actual[name], expected.files[name], `${label}: ${name} changed`);
  }
}

function readSession(project) {
  return JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'));
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function installHarness(project, { direction = project.initialState.metric.direction, rawBaseline = null } = {}) {
  const prepare = path.join(project.sessionRoot, 'prepare.cjs');
  const config = path.join(project.sessionRoot, 'prepare.config.json');
  fs.writeFileSync(prepare, "'use strict';\nprocess.stdout.write('score: 1\\n');\n");
  fs.writeFileSync(config, `${JSON.stringify({
    schema_version: '1.0',
    metric_direction: direction,
    baseline_score: rawBaseline,
  }, null, 2)}\n`);
  return {
    prepare_sha256: fileDigest(prepare),
    config_sha256: fileDigest(config),
  };
}

function createAndAppendSeed(project, {
  seedId = 1,
  operationId = '01J00000000000000000000040',
  creationKind = 'initial',
} = {}) {
  const created = expectSuccess(request(project.projectRoot, 'worktree.create-seed', {
    session_id: project.sessionId,
    seed_id: seedId,
    base_commit: project.baseCommit,
  }), 'worktree.create-seed');
  const before = authority(project);
  const payload = {
    session_id: project.sessionId,
    operation_id: operationId,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    seed_id: seedId,
    worktree_path: created.worktree_path,
    branch: created.branch,
    beta: {
      direction: seedId === 1 ? null : `direction-${seedId}`,
      hypothesis: seedId === 1 ? null : `hypothesis-${seedId}`,
      rationale: seedId === 1 ? null : `rationale-${seedId}`,
    },
    creation_kind: creationKind,
  };
  const appended = expectSuccess(request(project.projectRoot, 'virtual.append-seed', payload),
    'virtual.append-seed');
  return { created, payload, appended };
}

function recordBaseline(project, {
  operationId = CASES.operation_ids.baseline,
  rawScore = 4,
  normalizedScore = 4,
  harnessIdentity = installHarness(project, {
    direction: project.initialState.metric.direction,
    rawBaseline: project.initialState.metric.direction === 'minimize' ? rawScore : null,
  }),
} = {}) {
  const before = authority(project);
  const payload = {
    session_id: project.sessionId,
    operation_id: operationId,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    raw_score: rawScore,
    normalized_score: normalizedScore,
    harness_identity: harnessIdentity,
  };
  return {
    before,
    payload,
    result: expectSuccess(request(project.projectRoot, 'session.record-baseline', payload),
      'session.record-baseline'),
  };
}

function commitSeedChange(project, seed, text = 'module.exports = 2;\n') {
  const pre = git(seed.created.worktree_path, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(seed.created.worktree_path, 'src', 'index.js'), text);
  git(seed.created.worktree_path, ['add', 'src/index.js']);
  git(seed.created.worktree_path, ['commit', '-qm', 'experiment']);
  const commit = git(seed.created.worktree_path, ['rev-parse', 'HEAD']);
  return { pre, commit };
}

function finishExperiment(project, seed, commits, overrides = {}) {
  const before = authority(project);
  const experiment = {
    ...clone(CASES.experiment),
    pre_commit: commits.pre,
    commit: commits.commit,
    ...overrides,
  };
  const payload = {
    session_id: project.sessionId,
    operation_id: CASES.operation_ids.experiment,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    expected_forum_sha256: before.forum_sha256,
    expected_results_sha256: before.results_sha256,
    seed_id: 1,
    experiment,
  };
  return {
    before,
    payload,
    result: expectSuccess(request(project.projectRoot, 'session.finish-experiment', payload),
      'session.finish-experiment'),
  };
}

test('strict v3.5 session.patch permits only initial transfer adoption and is CAS/idempotency bound', (t) => {
  const project = makeProject(t, { label: 'transfer patch' });
  const before = authority(project);
  const payload = {
    session_id: project.sessionId,
    operation_id: CASES.operation_ids.patch,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    path: '/transfer',
    value: clone(CASES.transfer),
  };
  const first = expectSuccess(request(project.projectRoot, 'session.patch', payload), 'session.patch');
  assert.deepEqual(first.session.transfer, {
    ...CASES.transfer,
    adopted_at: '2026-07-13T14:00:00Z',
  });
  assert.match(first.session_sha256, HASH_PATTERN);
  assert.match(first.journal_sha256, HASH_PATTERN);
  assert.equal(first.replayed, false);
  const afterFirst = authority(project);

  const replay = expectSuccess(request(project.projectRoot, 'session.patch', payload), 'session.patch replay');
  assert.deepEqual(replay, { ...first, replayed: true });
  assertAuthorityBytes(project, afterFirst, 'exact replay');

  const conflict = request(project.projectRoot, 'session.patch', {
    ...payload,
    value: null,
  });
  assert.equal(conflict.exitCode, 2, JSON.stringify(conflict));
  assert.equal(conflict.error.code, 'operation_id_conflict');
  assertAuthorityBytes(project, afterFirst, 'operation-id conflict');
});

test('strict v3.5 patch rejects every former owner, wildcards, array fields, bools, NaN, and stale digests byte-for-byte', (t) => {
  for (const [index, pointer] of CASES.rejected_patch_paths.entries()) {
    const project = makeProject(t, { label: `reject-path-${index}` });
    const before = authority(project);
    const rejected = request(project.projectRoot, 'session.patch', {
      session_id: project.sessionId,
      operation_id: operationId(100 + index),
      expected_session_sha256: before.session_sha256,
      expected_journal_sha256: before.journal_sha256,
      path: pointer,
      value: pointer === '/status' ? 'active' : 1,
    });
    assert.equal(rejected.exitCode, 2, `${pointer}: ${JSON.stringify(rejected)}`);
    assert.equal(rejected.error.code, 'patch_path_not_allowed', pointer);
    assertAuthorityBytes(project, before, pointer);
  }

  for (const [index, value] of [true, Number.NaN, { ...CASES.transfer, adopted_at: 'forged' }].entries()) {
    const project = makeProject(t, { label: `reject-transfer-${index}` });
    const before = authority(project);
    const rejected = request(project.projectRoot, 'session.patch', {
      session_id: project.sessionId,
      operation_id: `01J0000000000000000000020${index}`,
      expected_session_sha256: before.session_sha256,
      expected_journal_sha256: before.journal_sha256,
      path: '/transfer',
      value,
    });
    assert.equal(rejected.exitCode, 2, JSON.stringify(rejected));
    assertAuthorityBytes(project, before, `invalid transfer ${index}`);
  }

  const staleProject = makeProject(t, { label: 'stale-transfer' });
  const before = authority(staleProject);
  const stale = request(staleProject.projectRoot, 'session.patch', {
    session_id: staleProject.sessionId,
    operation_id: '01J00000000000000000000210',
    expected_session_sha256: `sha256:${'0'.repeat(64)}`,
    expected_journal_sha256: before.journal_sha256,
    path: '/transfer',
    value: null,
  });
  assert.equal(stale.exitCode, 1, JSON.stringify(stale));
  assert.equal(stale.error.code, 'stale_preimage');
  assertAuthorityBytes(staleProject, before, 'stale preimage');
});

test('record-baseline authenticates harness bytes, normalization, activation, replay, and single-owner semantics', (t) => {
  const maximize = makeProject(t, { label: 'maximize baseline' });
  createAndAppendSeed(maximize);
  const recorded = recordBaseline(maximize);
  assert.deepEqual(recorded.result.session.metric, {
    name: 'score', direction: 'maximize', baseline: 4, current: 4, best: 4,
  });
  assert.equal(recorded.result.session.status, 'active');
  assert.equal(recorded.result.replayed, false);
  const baselineEvents = readJsonl(maximize.journalPath).filter((event) => event.event === 'baseline_recorded');
  assert.equal(baselineEvents.length, 1);
  assert.equal(baselineEvents[0].normalized_score, 4);
  const after = authority(maximize);
  const replay = expectSuccess(request(maximize.projectRoot, 'session.record-baseline', recorded.payload),
    'baseline replay');
  assert.deepEqual(replay, { ...recorded.result, replayed: true });
  assertAuthorityBytes(maximize, after, 'baseline replay');

  const second = request(maximize.projectRoot, 'session.record-baseline', {
    ...recorded.payload,
    operation_id: '01J00000000000000000000220',
    expected_session_sha256: after.session_sha256,
    expected_journal_sha256: after.journal_sha256,
  });
  assert.equal(second.exitCode, 2, JSON.stringify(second));
  assert.equal(second.error.code, 'baseline_already_recorded');
  assertAuthorityBytes(maximize, after, 'second baseline');

  const minimize = makeProject(t, { label: 'minimize baseline', direction: 'minimize' });
  createAndAppendSeed(minimize, { operationId: '01J00000000000000000000221' });
  const normalized = recordBaseline(minimize, { rawScore: 8, normalizedScore: 1 });
  assert.equal(normalized.result.session.metric.baseline, 1);
  assert.equal(normalized.result.session.metric.current, 1);

  const mismatch = makeProject(t, { label: 'harness mismatch' });
  createAndAppendSeed(mismatch, { operationId: '01J00000000000000000000222' });
  const harness = installHarness(mismatch);
  const mismatchBefore = authority(mismatch);
  const rejected = request(mismatch.projectRoot, 'session.record-baseline', {
    session_id: mismatch.sessionId,
    operation_id: '01J00000000000000000000223',
    expected_session_sha256: mismatchBefore.session_sha256,
    expected_journal_sha256: mismatchBefore.journal_sha256,
    raw_score: 4,
    normalized_score: 4,
    harness_identity: { ...harness, prepare_sha256: `sha256:${'f'.repeat(64)}` },
  });
  assert.equal(rejected.exitCode, 2, JSON.stringify(rejected));
  assert.equal(rejected.error.code, 'harness_identity_mismatch');
  assertAuthorityBytes(mismatch, mismatchBefore, 'harness mismatch');
});

test('finish-experiment owns terminal state, result row, forum projection, counters, Git identity, and replay', (t) => {
  const project = makeProject(t, { label: 'kept experiment' });
  const seed = createAndAppendSeed(project);
  recordBaseline(project);
  const commits = commitSeedChange(project, seed);
  const finished = finishExperiment(project, seed, commits);
  const session = finished.result.session;
  assert.deepEqual(session.experiments, { total: 1, kept: 1, discarded: 0, crashed: 0 });
  assert.equal(session.metric.current, 5);
  assert.equal(session.metric.best, 5);
  assert.equal(session.virtual_parallel.seeds[0].experiments_used, 1);
  assert.equal(session.virtual_parallel.seeds[0].experiments_used_this_epoch, 1);
  assert.equal(session.virtual_parallel.seeds[0].keeps, 1);
  assert.equal(finished.result.experiment_id, 1);
  assert.equal(finished.result.replayed, false);

  const rows = fs.readFileSync(project.resultsPath, 'utf8').trimEnd().split('\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].split('\t'), [
    commits.commit, '5', 'kept', 'add_guard', '1', '4', 'false',
    CASES.experiment.rationale, CASES.experiment.description,
  ]);
  const terminal = readJsonl(project.journalPath).filter((event) => event.event === 'kept');
  assert.equal(terminal.length, 1);
  const forum = readJsonl(project.forumPath);
  assert.equal(forum.length, 1);
  assert.equal(forum[0].event, 'experiment_kept');

  const after = authority(project);
  const replay = expectSuccess(request(project.projectRoot, 'session.finish-experiment', finished.payload),
    'finish replay');
  assert.deepEqual(replay, { ...finished.result, replayed: true });
  assertAuthorityBytes(project, after, 'finish replay');

  const duplicate = request(project.projectRoot, 'session.finish-experiment', {
    ...finished.payload,
    operation_id: '01J00000000000000000000230',
    expected_session_sha256: after.session_sha256,
    expected_journal_sha256: after.journal_sha256,
    expected_forum_sha256: after.forum_sha256,
    expected_results_sha256: after.results_sha256,
  });
  assert.equal(duplicate.exitCode, 2, JSON.stringify(duplicate));
  assert.equal(duplicate.error.code, 'experiment_already_terminal');
  assertAuthorityBytes(project, after, 'duplicate terminal');
});

test('finish-experiment rejects forged score, taxonomy, bools, TSV text, and wrong Git HEAD without mutation', (t) => {
  const cases = [
    ['score delta', { score_delta: 99 }],
    ['taxonomy', { category: 'unknown' }],
    ['bool loc', { loc_delta: true }],
    ['nonfinite', { normalized_score: Number.NaN }],
    ['tab text', { description: 'escape\tcolumn' }],
  ];
  for (const [index, [label, change]] of cases.entries()) {
    const project = makeProject(t, { label: `invalid experiment ${index}` });
    const seed = createAndAppendSeed(project, { operationId: `01J0000000000000000000024${index}` });
    recordBaseline(project, { operationId: `01J0000000000000000000025${index}` });
    const commits = commitSeedChange(project, seed, `module.exports = ${index + 2};\n`);
    const before = authority(project);
    const experiment = { ...clone(CASES.experiment), pre_commit: commits.pre, commit: commits.commit, ...change };
    const rejected = request(project.projectRoot, 'session.finish-experiment', {
      session_id: project.sessionId,
      operation_id: `01J0000000000000000000026${index}`,
      expected_session_sha256: before.session_sha256,
      expected_journal_sha256: before.journal_sha256,
      expected_forum_sha256: before.forum_sha256,
      expected_results_sha256: before.results_sha256,
      seed_id: 1,
      experiment,
    });
    assert.equal(rejected.exitCode, 2, `${label}: ${JSON.stringify(rejected)}`);
    assertAuthorityBytes(project, before, label);
  }

  const wrongHead = makeProject(t, { label: 'wrong experiment head' });
  const seed = createAndAppendSeed(wrongHead, { operationId: '01J00000000000000000000270' });
  recordBaseline(wrongHead, { operationId: '01J00000000000000000000271' });
  const commits = commitSeedChange(wrongHead, seed);
  fs.writeFileSync(path.join(seed.created.worktree_path, 'src', 'index.js'), 'module.exports = 3;\n');
  git(seed.created.worktree_path, ['add', 'src/index.js']);
  git(seed.created.worktree_path, ['commit', '-qm', 'unexpected head']);
  const before = authority(wrongHead);
  const experiment = { ...clone(CASES.experiment), pre_commit: commits.pre, commit: commits.commit };
  const rejected = request(wrongHead.projectRoot, 'session.finish-experiment', {
    session_id: wrongHead.sessionId,
    operation_id: '01J00000000000000000000272',
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    expected_forum_sha256: before.forum_sha256,
    expected_results_sha256: before.results_sha256,
    seed_id: 1,
    experiment,
  });
  assert.equal(rejected.exitCode, 1, JSON.stringify(rejected));
  assert.equal(rejected.error.code, 'worktree_head_mismatch');
  assertAuthorityBytes(wrongHead, before, 'wrong head');
});

test('record-evaluator-expansion authenticates prepare/config and owns version metadata and resets', (t) => {
  const project = makeProject(t, { label: 'evaluator expansion' });
  createAndAppendSeed(project);
  recordBaseline(project);
  const harness = installHarness(project);
  const before = authority(project);
  const payload = {
    session_id: project.sessionId,
    operation_id: CASES.operation_ids.evaluator,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    harness_identity: harness,
    reason: 'tier3 coverage expansion',
    trigger_generation: 0,
  };
  const expanded = expectSuccess(request(project.projectRoot,
    'session.record-evaluator-expansion', payload), 'record-evaluator-expansion');
  assert.equal(expanded.session.evaluation_epoch.history.at(-1).prepare_version, 2);
  assert.deepEqual(expanded.session.evaluation_epoch.history.at(-1).evaluator, {
    prepare_sha256: harness.prepare_sha256,
    config_sha256: harness.config_sha256,
    reason: payload.reason,
    trigger_generation: 0,
    expanded_at: '2026-07-13T14:00:00Z',
  });
  assert.equal(expanded.session.shortcut.flagged_since_last_tier3, 0);
  assert.equal(expanded.session.entropy.last_collapse_generation, null);
  assert.equal(readJsonl(project.journalPath).filter((event) => event.event === 'evaluator_expanded').length, 1);

  const after = authority(project);
  const replay = expectSuccess(request(project.projectRoot,
    'session.record-evaluator-expansion', payload), 'evaluator replay');
  assert.deepEqual(replay, { ...expanded, replayed: true });
  assertAuthorityBytes(project, after, 'evaluator replay');
});

test('session.complete verifies artifacts and Git, atomically owns completion/registry/journal, and replays', (t) => {
  const project = makeProject(t, { label: 'typed completion' });
  createAndAppendSeed(project);
  recordBaseline(project);
  const reportBytes = Buffer.from('# Report\n\ncomplete\n');
  const receiptBytes = Buffer.from('{"schema_version":"1.0","outcome":"merged"}\n');
  fs.writeFileSync(path.join(project.sessionRoot, 'report.md'), reportBytes);
  fs.writeFileSync(path.join(project.sessionRoot, 'evolve-receipt.json'), receiptBytes);
  const finalBranch = git(project.projectRoot, ['branch', '--show-current']);
  const finalCommit = git(project.projectRoot, ['rev-parse', 'HEAD']);
  const before = authority(project);
  const payload = {
    session_id: project.sessionId,
    operation_id: CASES.operation_ids.completion,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    outcome: CASES.completion.outcome,
    final_branch: finalBranch,
    final_commit: finalCommit,
    report: { relative_path: 'report.md', sha256: digest(reportBytes) },
    receipt: { relative_path: 'evolve-receipt.json', sha256: digest(receiptBytes) },
    synthesis: clone(CASES.completion.synthesis),
    final_strategy: clone(CASES.completion.final_strategy),
  };
  const completed = expectSuccess(request(project.projectRoot, 'session.complete', payload),
    'session.complete');
  assert.equal(completed.session.status, 'completed');
  assert.deepEqual(completed.session.completion, {
    outcome: 'merged',
    final_branch: finalBranch,
    final_commit: finalCommit,
    report: payload.report,
    receipt: payload.receipt,
    synthesis: payload.synthesis,
    final_strategy: payload.final_strategy,
    completed_at: '2026-07-13T14:00:00Z',
  });
  assert.equal(readJsonl(project.journalPath).filter((event) => event.event === 'session_completed').length, 1);
  assert.equal(readJsonl(project.registryPath).filter((event) => event.event === 'finished').length, 1);

  const after = authority(project);
  const replay = expectSuccess(request(project.projectRoot, 'session.complete', payload),
    'completion replay');
  assert.deepEqual(replay, { ...completed, replayed: true });
  assertAuthorityBytes(project, after, 'completion replay');

  const badArtifact = makeProject(t, { label: 'bad completion artifact' });
  createAndAppendSeed(badArtifact, { operationId: '01J00000000000000000000280' });
  recordBaseline(badArtifact, { operationId: '01J00000000000000000000281' });
  fs.writeFileSync(path.join(badArtifact.sessionRoot, 'report.md'), reportBytes);
  fs.writeFileSync(path.join(badArtifact.sessionRoot, 'evolve-receipt.json'), receiptBytes);
  const badBefore = authority(badArtifact);
  const rejected = request(badArtifact.projectRoot, 'session.complete', {
    ...payload,
    session_id: badArtifact.sessionId,
    operation_id: '01J00000000000000000000282',
    expected_session_sha256: badBefore.session_sha256,
    expected_journal_sha256: badBefore.journal_sha256,
    final_branch: git(badArtifact.projectRoot, ['branch', '--show-current']),
    final_commit: git(badArtifact.projectRoot, ['rev-parse', 'HEAD']),
    report: { relative_path: 'report.md', sha256: `sha256:${'0'.repeat(64)}` },
  });
  assert.equal(rejected.exitCode, 2, JSON.stringify(rejected));
  assert.equal(rejected.error.code, 'artifact_digest_mismatch');
  assertAuthorityBytes(badArtifact, badBefore, 'completion artifact mismatch');
});
