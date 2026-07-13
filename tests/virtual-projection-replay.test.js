'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const RUNTIME = path.resolve(__dirname, '..', 'hooks', 'scripts', 'deep-evolve-runtime.cjs');
const { dispatch } = require(RUNTIME);
const {
  parseResultsTsv,
  reduceVirtualProjection,
} = require('../hooks/scripts/runtime/session-transitions.cjs');
const START_FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'session-start-v3.5.json'), 'utf8',
));
const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'virtual-projection-replay.json'), 'utf8',
));

const FIXED_NOW = Date.parse('2026-07-13T15:00:00Z');
const RESULTS_HEADER = 'commit\tscore\tstatus\tcategory\tscore_delta\tloc_delta\tflagged\trationale\tdescription\n';

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || args.join(' '));
  return result.stdout.trim();
}

function call(projectRoot, operation, payload, dependencies = {}) {
  return dispatch({
    schema_version: '1.0', operation, context: { project_root: projectRoot }, payload,
  }, { now: () => FIXED_NOW, ...dependencies });
}

function ok(response, label) {
  assert.equal(response.ok, true, `${label}: ${JSON.stringify(response)}`);
  return response.result;
}

function makeProject(t, { nChosen = 3, totalBudget = 16, label = 'projection' } = {}) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-projection-'));
  const root = path.join(outer, label);
  fs.mkdirSync(path.join(root, '.deep-evolve'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'module.exports = 1;\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'runtime@example.invalid']);
  git(root, ['config', 'user.name', 'Runtime Test']);
  git(root, ['add', 'src/index.js']);
  git(root, ['commit', '-qm', 'base']);
  const baseCommit = git(root, ['rev-parse', 'HEAD']);
  const initialState = structuredClone(START_FIXTURE.initial_state);
  initialState.virtual_parallel.n_chosen = nChosen;
  initialState.total_budget = totalBudget;
  const started = ok(call(root, 'session.start', {
    goal: `${label} goal`, initial_state: initialState,
  }), 'start');
  const sessionRoot = fs.realpathSync(started.session_root);
  const project = {
    outer,
    root: fs.realpathSync(root),
    stateRoot: path.join(root, '.deep-evolve'),
    sessionId: started.session_id,
    sessionRoot,
    sessionPath: path.join(sessionRoot, 'session.yaml'),
    journalPath: path.join(sessionRoot, 'journal.jsonl'),
    forumPath: path.join(sessionRoot, 'forum.jsonl'),
    resultsPath: path.join(sessionRoot, 'results.tsv'),
    baseCommit,
  };
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  return project;
}

function hashes(project) {
  return {
    session: digest(fs.readFileSync(project.sessionPath)),
    journal: digest(fs.readFileSync(project.journalPath)),
    forum: digest(fs.readFileSync(project.forumPath)),
    results: digest(fs.readFileSync(project.resultsPath)),
  };
}

function snapshot(project) {
  return Object.fromEntries(['sessionPath', 'journalPath', 'forumPath', 'resultsPath']
    .map((key) => [key, fs.readFileSync(project[key])]));
}

function assertSnapshot(project, before, label) {
  for (const [key, bytes] of Object.entries(before)) {
    assert.deepEqual(fs.readFileSync(project[key]), bytes, `${label}: ${key}`);
  }
}

function createSeedWorktree(project, seedId) {
  return ok(call(project.root, 'worktree.create-seed', {
    session_id: project.sessionId, seed_id: seedId, base_commit: project.baseCommit,
  }), `create seed ${seedId}`);
}

function appendSeed(project, seedId, operationId, creationKind = 'initial') {
  const created = createSeedWorktree(project, seedId);
  const before = hashes(project);
  const payload = {
    session_id: project.sessionId,
    operation_id: operationId,
    expected_session_sha256: before.session,
    expected_journal_sha256: before.journal,
    seed_id: seedId,
    worktree_path: created.worktree_path,
    branch: created.branch,
    beta: {
      direction: `direction-${seedId}`,
      hypothesis: `hypothesis-${seedId}`,
      rationale: `rationale-${seedId}`,
    },
    creation_kind: creationKind,
  };
  return { created, payload, result: ok(call(project.root, 'virtual.append-seed', payload), `append ${seedId}`) };
}

function installHarness(project) {
  const prepare = path.join(project.sessionRoot, 'prepare.cjs');
  const config = path.join(project.sessionRoot, 'prepare.config.json');
  fs.writeFileSync(prepare, "'use strict';\nprocess.stdout.write('score: 4\\n');\n");
  fs.writeFileSync(config, '{"schema_version":"1.0","metric_direction":"maximize","baseline_score":null}\n');
  return { prepare_sha256: digest(fs.readFileSync(prepare)), config_sha256: digest(fs.readFileSync(config)) };
}

function baseline(project, operationId = '01J00000000000000000000050') {
  const before = hashes(project);
  return ok(call(project.root, 'session.record-baseline', {
    session_id: project.sessionId,
    operation_id: operationId,
    expected_session_sha256: before.session,
    expected_journal_sha256: before.journal,
    raw_score: 4,
    normalized_score: 4,
    harness_identity: installHarness(project),
  }), 'baseline');
}

function waitFor(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('pure virtual reducer derives deterministic allocation and terminal counters from strict event/result authority', () => {
  const events = structuredClone(FIXTURE.seed_events);
  const initialized = reduceVirtualProjection({
    initialVirtual: structuredClone(FIXTURE.initial_virtual),
    events,
    resultRows: [],
  });
  assert.deepEqual(initialized.seeds.map((seed) => seed.allocated_budget),
    FIXTURE.initial_allocations);
  assert.deepEqual(initialized.seeds.map((seed) => seed.id), [1, 2, 3]);
  assert.equal(initialized.n_current, 3);
  assert.equal(initialized.budget_unallocated, 0);
  assert.equal(Object.hasOwn(initialized, 'x-active-seed-count'), false);

  const withTerminal = reduceVirtualProjection({
    initialVirtual: structuredClone(FIXTURE.initial_virtual),
    events: [...events, structuredClone(FIXTURE.terminal_event)],
    resultRows: [structuredClone(FIXTURE.terminal_result_row)],
  });
  assert.equal(withTerminal.seeds[0].experiments_used, 1);
  assert.equal(withTerminal.seeds[0].experiments_used_this_epoch, 1);
  assert.equal(withTerminal.seeds[0].keeps, 1);
  assert.equal(withTerminal.budget_unallocated, 0);

  const rows = parseResultsTsv(`${RESULTS_HEADER}${[
    FIXTURE.terminal_result_row.commit,
    FIXTURE.terminal_result_row.score,
    FIXTURE.terminal_result_row.status,
    FIXTURE.terminal_result_row.category,
    FIXTURE.terminal_result_row.score_delta,
    FIXTURE.terminal_result_row.loc_delta,
    FIXTURE.terminal_result_row.flagged,
    FIXTURE.terminal_result_row.rationale,
    FIXTURE.terminal_result_row.description,
  ].join('\t')}\n`);
  assert.deepEqual(rows, [FIXTURE.terminal_result_row]);
});

test('strict reducer rejects duplicate, missing-parent, mismatched TSV, post-terminal, bool, unsafe, and forged-Q authority', () => {
  assert.equal(typeof reduceVirtualProjection, 'function',
    'the strict shared reducer must exist before rejection behavior can be exercised');
  const initialVirtual = structuredClone(FIXTURE.initial_virtual);
  const seed = structuredClone(FIXTURE.seed_events[0]);
  const terminal = structuredClone(FIXTURE.terminal_event);
  const row = structuredClone(FIXTURE.terminal_result_row);
  const cases = [
    ['duplicate initialization', [seed, seed], []],
    ['missing parent', [terminal], [row]],
    ['terminal without row', [seed, terminal], []],
    ['mismatched row', [seed, terminal], [{ ...row, score: 99 }]],
    ['bool id', [{ ...seed, seed_id: true }], []],
    ['unsafe id', [{ ...seed, seed_id: Number.MAX_SAFE_INTEGER + 1 }], []],
    ['post terminal', [seed, {
      event: 'seed_killed', operation_id: '01J00000000000000000000060', source: 'scheduler',
      request_id: null, kill_entry_id: 'kill-1', seed_id: 1, condition: 'sustained_regression',
      ts: '2026-07-13T15:01:00Z', applied_at: '2026-07-13T15:01:00Z',
    }, terminal], [row]],
    ['forged Q', [seed, {
      event: 'seed_scheduled', operation_id: '01J00000000000000000000061',
      block_id: 'block-1', decision_id: 'decision-1', seed_id: 1, epoch: 1,
      pre_dispatch_head: '0'.repeat(40), block_size: 1, budget_preimage: 5,
      ts: '2026-07-13T15:01:00Z',
    }, {
      event: 'seed_block_completed', operation_id: '01J00000000000000000000062',
      block_id: 'block-1', schedule_operation_id: '01J00000000000000000000061', seed_id: 1,
      experiment_ids: [], commits: [], forum_entry_ids: [], borrows_given: 0, borrows_received: 0,
      q_components: { keep_rate: 1, normalized_delta: 1, crash_rate: 0, idea_diversity: 1 },
      final_q: 99, returned_head: '0'.repeat(40), status: 'completed',
      ts: '2026-07-13T15:02:00Z',
    }], []],
  ];
  for (const [label, events, rows] of cases) {
    assert.throws(() => reduceVirtualProjection({ initialVirtual, events, resultRows: rows }),
      /virtual|projection|event|result|seed|Q|authority/i, label);
  }
});

test('v3.5 forbids legacy virtual.init/set-field while below-v3.5 dispatcher contracts remain byte-compatible', (t) => {
  const strict = makeProject(t, { label: 'version gate', nChosen: 1, totalBudget: 12 });
  const strictBefore = snapshot(strict);
  const init = call(strict.root, 'virtual.init', {
    session_id: strict.sessionId,
    analysis: { project_type: 'standard_optimization', eval_parallelizability: 'serialized', reasoning: '' },
    n_chosen: 1,
    total_budget: 12,
  });
  assert.equal(init.exitCode, 2, JSON.stringify(init));
  assert.equal(init.error.code, 'legacy_virtual_init_forbidden');
  for (const key of ['enabled', 'N', 'n_current', 'budget_total', 'budget_unallocated', 'unallocated_pool']) {
    const set = call(strict.root, 'virtual.set-field', {
      session_id: strict.sessionId, key, value: key === 'enabled' ? true : 1,
    });
    assert.equal(set.exitCode, 2, `${key}: ${JSON.stringify(set)}`);
    assert.equal(set.error.code, 'legacy_virtual_set_field_forbidden');
  }
  assertSnapshot(strict, strictBefore, 'strict version gate');

  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-projection-legacy-'));
  t.after(() => fs.rmSync(legacyRoot, { recursive: true, force: true }));
  const legacySession = path.join(legacyRoot, '.deep-evolve', 'legacy');
  fs.mkdirSync(legacySession, { recursive: true });
  fs.writeFileSync(path.join(legacySession, 'session.yaml'), `${JSON.stringify({
    session_id: 'legacy', deep_evolve_version: '3.4.3', status: 'initializing',
    created_at: '2026-01-01T00:00:00Z', metric: { direction: 'maximize' },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(legacySession, 'journal.jsonl'), '');
  const legacyInit = ok(call(legacyRoot, 'virtual.init', {
    session_id: 'legacy',
    analysis: { project_type: 'standard_optimization', eval_parallelizability: 'serialized', reasoning: 'legacy' },
    n_chosen: 1,
    total_budget: 9,
  }), 'legacy init');
  assert.equal(legacyInit.session.virtual_parallel.n_current, 1);
  const legacySet = ok(call(legacyRoot, 'virtual.set-field', {
    session_id: 'legacy', key: 'budget_unallocated', value: 3,
  }), 'legacy set');
  assert.equal(legacySet.session.virtual_parallel.budget_unallocated, 3);
});

test('v3.5 append-seed derives quotient/remainder allocations, writes one exact event atomically, and replays without writes', (t) => {
  const project = makeProject(t);
  const appended = [];
  for (let seedId = 1; seedId <= 3; seedId += 1) {
    appended.push(appendSeed(project, seedId, `01J0000000000000000000007${seedId}`));
    assert.equal(appended.at(-1).result.seed.allocated_budget, FIXTURE.initial_allocations[seedId - 1]);
    assert.equal(appended.at(-1).result.active_seed_count, seedId);
    assert.equal(appended.at(-1).result.budget_unallocated,
      16 - FIXTURE.initial_allocations.slice(0, seedId).reduce((sum, value) => sum + value, 0));
  }
  const session = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'));
  assert.deepEqual(session.virtual_parallel.seeds.map((seed) => seed.id), [1, 2, 3]);
  assert.equal(session.virtual_parallel.n_current, 3);
  assert.equal(Object.hasOwn(session.virtual_parallel, 'x-active-seed-count'), false);
  const seedEvents = fs.readFileSync(project.journalPath, 'utf8').split('\n').filter(Boolean)
    .map(JSON.parse).filter((event) => event.event === 'seed_initialized');
  assert.equal(seedEvents.length, 3);
  assert.deepEqual(Object.keys(seedEvents[0]).sort(), [
    'allocated_budget', 'branch', 'created_by', 'creation_kind', 'direction', 'event',
    'hypothesis', 'initial_rationale', 'operation_id', 'seed_id', 'ts', 'worktree_path',
  ]);

  const beforeReplay = snapshot(project);
  const replay = ok(call(project.root, 'virtual.append-seed', appended[0].payload), 'append replay');
  assert.deepEqual(replay, { ...appended[0].result, replayed: true });
  assertSnapshot(project, beforeReplay, 'append replay');

  const differentWriter = call(project.root, 'virtual.append-seed', {
    ...appended[0].payload,
    operation_id: '01J00000000000000000000080',
    expected_session_sha256: hashes(project).session,
    expected_journal_sha256: hashes(project).journal,
  });
  assert.equal(differentWriter.exitCode, 2, JSON.stringify(differentWriter));
  assert.equal(differentWriter.error.code, 'seed_already_initialized');
  assertSnapshot(project, beforeReplay, 'second seed writer');
});

test('append-seed validates exact canonical worktree/branch/beta and stale preimages without replacing seed identity', (t) => {
  const mutations = [
    ['worktree', (payload) => { payload.worktree_path = path.dirname(payload.worktree_path); }],
    ['branch', (payload) => { payload.branch = `${payload.branch}-forged`; }],
    ['beta field', (payload) => { payload.beta.extra = 'forged'; }],
    ['beta type', (payload) => { payload.beta.direction = 1; }],
    ['creation', (payload) => { payload.creation_kind = 'replacement'; }],
    ['stale', (payload) => { payload.expected_session_sha256 = `sha256:${'0'.repeat(64)}`; }],
  ];
  for (const [index, [label, mutate]] of mutations.entries()) {
    const project = makeProject(t, { nChosen: 1, totalBudget: 12, label: `append-${label}` });
    const created = createSeedWorktree(project, 1);
    const before = snapshot(project);
    const authority = hashes(project);
    const payload = {
      session_id: project.sessionId,
      operation_id: `01J0000000000000000000009${index}`,
      expected_session_sha256: authority.session,
      expected_journal_sha256: authority.journal,
      seed_id: 1,
      worktree_path: created.worktree_path,
      branch: created.branch,
      beta: { direction: null, hypothesis: null, rationale: null },
      creation_kind: 'initial',
    };
    mutate(payload);
    const rejected = call(project.root, 'virtual.append-seed', payload);
    assert.notEqual(rejected.exitCode, 0, `${label}: ${JSON.stringify(rejected)}`);
    if (label === 'stale') assert.equal(rejected.exitCode, 1);
    assertSnapshot(project, before, label);
  }
});

test('two appenders sharing one CAS preimage serialize so only one different operation can commit', async (t) => {
  const project = makeProject(t, { nChosen: 2, totalBudget: 12, label: 'append race' });
  const first = createSeedWorktree(project, 1);
  const second = createSeedWorktree(project, 2);
  const before = hashes(project);
  const payloads = [first, second].map((created, index) => ({
    session_id: project.sessionId,
    operation_id: `01J0000000000000000000010${index}`,
    expected_session_sha256: before.session,
    expected_journal_sha256: before.journal,
    seed_id: index + 1,
    worktree_path: created.worktree_path,
    branch: created.branch,
    beta: { direction: null, hypothesis: null, rationale: null },
    creation_kind: 'initial',
  }));
  const script = `
    const { dispatch } = require(${JSON.stringify(RUNTIME)});
    const input = JSON.parse(process.argv[1]);
    const response = dispatch({schema_version:'1.0', operation:'virtual.append-seed',
      context:{project_root:${JSON.stringify(project.root)}}, payload:input});
    process.stdout.write(JSON.stringify(response));
    process.exitCode = response.exitCode;
  `;
  const children = payloads.map((payload) => waitFor(spawn(process.execPath,
    ['-e', script, JSON.stringify(payload)], { stdio: ['ignore', 'pipe', 'pipe'] })));
  const results = await Promise.all(children);
  const responses = results.map((result) => JSON.parse(result.stdout));
  assert.equal(responses.filter((response) => response.ok).length, 1, JSON.stringify(responses));
  assert.equal(responses.filter((response) => response.error && response.error.code === 'stale_preimage').length, 1,
    JSON.stringify(responses));
  const session = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'));
  assert.equal(session.virtual_parallel.seeds.length, 1);
  assert.equal(fs.readFileSync(project.journalPath, 'utf8').split('\n').filter(Boolean)
    .map(JSON.parse).filter((event) => event.event === 'seed_initialized').length, 1);
});

test('strict rebuild reproduces experiment projection, leaves no-drift session bytes intact, and rejects legacy payload', (t) => {
  const project = makeProject(t, { nChosen: 1, totalBudget: 12, label: 'strict rebuild' });
  const seed = appendSeed(project, 1, '01J00000000000000000000110');
  baseline(project, '01J00000000000000000000111');
  const pre = git(seed.created.worktree_path, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(seed.created.worktree_path, 'src', 'index.js'), 'module.exports = 2;\n');
  git(seed.created.worktree_path, ['add', 'src/index.js']);
  git(seed.created.worktree_path, ['commit', '-qm', 'kept']);
  const commit = git(seed.created.worktree_path, ['rev-parse', 'HEAD']);
  const beforeFinish = hashes(project);
  ok(call(project.root, 'session.finish-experiment', {
    session_id: project.sessionId,
    operation_id: '01J00000000000000000000112',
    expected_session_sha256: beforeFinish.session,
    expected_journal_sha256: beforeFinish.journal,
    expected_forum_sha256: beforeFinish.forum,
    expected_results_sha256: beforeFinish.results,
    seed_id: 1,
    experiment: {
      id: 1, category: 'add_guard', description: 'strict rebuild', rationale: 'same reducer',
      pre_commit: pre, commit, status: 'kept', raw_score: 5, normalized_score: 5,
      score_delta: 1, loc_delta: 2, flagged: false,
    },
  }), 'finish');
  const canonical = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'));
  const canonicalProjection = structuredClone(canonical.virtual_parallel);

  const stale = structuredClone(canonical);
  stale.virtual_parallel.seeds[0].experiments_used = 0;
  stale.virtual_parallel.seeds[0].experiments_used_this_epoch = 0;
  stale.virtual_parallel.seeds[0].keeps = 0;
  fs.writeFileSync(project.sessionPath, `${JSON.stringify(stale, null, 2)}\n`);
  const drifted = hashes(project);
  const rebuildPayload = {
    session_id: project.sessionId,
    operation_id: '01J00000000000000000000113',
    expected_session_sha256: drifted.session,
    expected_journal_sha256: drifted.journal,
    expected_results_sha256: drifted.results,
  };
  const rebuilt = ok(call(project.root, 'virtual.rebuild-seeds', rebuildPayload), 'rebuild');
  assert.equal(rebuilt.changed, true);
  assert.deepEqual(rebuilt.session.virtual_parallel, canonicalProjection);
  assert.match(rebuilt.projection_sha256, /^sha256:[0-9a-f]{64}$/);

  const beforeNoDrift = fs.readFileSync(project.sessionPath);
  const current = hashes(project);
  const noDriftPayload = {
    session_id: project.sessionId,
    operation_id: '01J00000000000000000000114',
    expected_session_sha256: current.session,
    expected_journal_sha256: current.journal,
    expected_results_sha256: current.results,
  };
  const noDrift = ok(call(project.root, 'virtual.rebuild-seeds', noDriftPayload), 'no-drift rebuild');
  assert.equal(noDrift.changed, false);
  assert.deepEqual(fs.readFileSync(project.sessionPath), beforeNoDrift);
  const afterNoDrift = snapshot(project);
  const replay = ok(call(project.root, 'virtual.rebuild-seeds', noDriftPayload), 'rebuild replay');
  assert.deepEqual(replay, { ...noDrift, replayed: true });
  assertSnapshot(project, afterNoDrift, 'rebuild replay');

  const legacyPayload = call(project.root, 'virtual.rebuild-seeds', { session_id: project.sessionId });
  assert.equal(legacyPayload.exitCode, 2, JSON.stringify(legacyPayload));
  assert.match(legacyPayload.error.code, /payload|preimage|legacy/);
});

test('strict rebuild fails closed for immutable seed identity, malformed JSONL/TSV, duplicate terminals, and unrelated session drift', (t) => {
  const cases = [
    ['seed identity', (project, session) => { session.virtual_parallel.seeds[0].branch += '-forged'; }],
    ['unrelated session', (project, session) => { session.goal = 'forged goal'; }],
    ['malformed journal', (project) => { fs.appendFileSync(project.journalPath, '{bad\n'); }],
    ['malformed results', (project) => { fs.appendFileSync(project.resultsPath, 'too\tfew\n'); }],
  ];
  for (const [index, [label, corrupt]] of cases.entries()) {
    const project = makeProject(t, { nChosen: 1, totalBudget: 12, label: `rebuild-${index}` });
    appendSeed(project, 1, `01J0000000000000000000012${index}`);
    const session = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'));
    corrupt(project, session);
    if (label === 'seed identity' || label === 'unrelated session') {
      fs.writeFileSync(project.sessionPath, `${JSON.stringify(session, null, 2)}\n`);
    }
    const before = snapshot(project);
    const authority = hashes(project);
    const rejected = call(project.root, 'virtual.rebuild-seeds', {
      session_id: project.sessionId,
      operation_id: `01J0000000000000000000013${index}`,
      expected_session_sha256: authority.session,
      expected_journal_sha256: authority.journal,
      expected_results_sha256: authority.results,
    });
    assert.equal(rejected.exitCode, 2, `${label}: ${JSON.stringify(rejected)}`);
    assert.equal(rejected.error.code, 'virtual_projection_conflict', label);
    assertSnapshot(project, before, label);
  }
});
