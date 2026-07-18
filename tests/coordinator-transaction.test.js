'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const RUNTIME = path.resolve(__dirname, '..', 'hooks', 'scripts', 'deep-evolve-runtime.cjs');
const { dispatch, OPERATIONS } = require(RUNTIME);
const { deriveFinishEvidence } = require('../hooks/scripts/runtime/coordinator-store.cjs');
const START = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'session-start-v3.5.json'), 'utf8',
));
const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'coordinator-transitions.json'), 'utf8',
));

const FIXED_NOW = Date.parse('2026-07-14T00:00:00Z');

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', shell: false,
  });
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
  assert.equal(response.exitCode, 0, label);
  return response.result;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
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

function spawnCall(projectRoot, operation, payload) {
  const script = `
    const { dispatch } = require(${JSON.stringify(RUNTIME)});
    const response = dispatch({
      schema_version: '1.0', operation: process.argv[1],
      context: { project_root: process.argv[2] }, payload: JSON.parse(process.argv[3]),
    }, { now: () => ${FIXED_NOW} });
    process.stdout.write(JSON.stringify(response));
    process.exitCode = response.exitCode;
  `;
  return waitFor(spawn(process.execPath,
    ['-e', script, operation, projectRoot, JSON.stringify(payload)],
    { stdio: ['ignore', 'pipe', 'pipe'] }));
}

function makeProject(t, {
  nChosen = 1, totalBudget = 12, interval = 20, label = 'coordinator',
} = {}) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-coordinator-'));
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
  const initial = structuredClone(START.initial_state);
  initial.virtual_parallel.n_chosen = nChosen;
  initial.total_budget = totalBudget;
  initial.outer_loop.interval = interval;
  const started = ok(call(projectRoot, 'session.start', {
    goal: `${label} goal`, initial_state: initial,
  }), 'session.start');
  const sessionRoot = fs.realpathSync(started.session_root);
  const project = {
    outer,
    projectRoot: fs.realpathSync(projectRoot),
    sessionId: started.session_id,
    sessionRoot,
    sessionPath: path.join(sessionRoot, 'session.yaml'),
    journalPath: path.join(sessionRoot, 'journal.jsonl'),
    forumPath: path.join(sessionRoot, 'forum.jsonl'),
    resultsPath: path.join(sessionRoot, 'results.tsv'),
    killQueuePath: path.join(sessionRoot, 'kill_queue.jsonl'),
    killRequestsPath: path.join(sessionRoot, 'kill_requests.jsonl'),
    baseCommit,
    seeds: [],
  };
  for (let seedId = 1; seedId <= nChosen; seedId += 1) {
    const created = ok(call(project.projectRoot, 'worktree.create-seed', {
      session_id: project.sessionId, seed_id: seedId, base_commit: baseCommit,
    }), `worktree.create-seed ${seedId}`);
    const before = authority(project);
    ok(call(project.projectRoot, 'virtual.append-seed', {
      session_id: project.sessionId,
      operation_id: `01J${String(20 + seedId).padStart(23, '0')}`,
      expected_session_sha256: before.session_sha256,
      expected_journal_sha256: before.journal_sha256,
      seed_id: seedId,
      worktree_path: created.worktree_path,
      branch: created.branch,
      beta: { direction: `direction ${seedId}`, hypothesis: null, rationale: null },
      creation_kind: 'initial',
    }), `virtual.append-seed ${seedId}`);
    project.seeds.push(created);
  }
  fs.writeFileSync(path.join(sessionRoot, 'prepare.cjs'),
    "'use strict';\nprocess.stdout.write('score: 4\\n');\n");
  fs.writeFileSync(path.join(sessionRoot, 'prepare.config.json'),
    '{"schema_version":"1.0","metric_direction":"maximize","baseline_score":null}\n');
  const before = authority(project);
  ok(call(project.projectRoot, 'session.record-baseline', {
    session_id: project.sessionId,
    operation_id: '01J00000000000000000000030',
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    raw_score: 4,
    normalized_score: 4,
    harness_identity: {
      prepare_sha256: digest(fs.readFileSync(path.join(sessionRoot, 'prepare.cjs'))),
      config_sha256: digest(fs.readFileSync(path.join(sessionRoot, 'prepare.config.json'))),
    },
  }), 'session.record-baseline');
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  return project;
}

function authority(project) {
  const files = {
    session: fs.readFileSync(project.sessionPath),
    journal: fs.readFileSync(project.journalPath),
    forum: fs.readFileSync(project.forumPath),
    results: fs.readFileSync(project.resultsPath),
    kill_queue: fs.readFileSync(project.killQueuePath),
    kill_requests: fs.readFileSync(project.killRequestsPath),
  };
  return {
    files,
    ...Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`${name}_sha256`, digest(bytes)])),
  };
}

function assertAuthority(project, expected, label) {
  const actual = authority(project);
  for (const [name, bytes] of Object.entries(expected.files)) {
    assert.deepEqual(actual.files[name], bytes, `${label}: ${name}`);
  }
}

function beginPayload(project, operationId = FIXTURE.operation_ids.begin, overrides = {}) {
  const before = authority(project);
  return {
    session_id: project.sessionId,
    operation_id: operationId,
    decision_id: FIXTURE.decision_id,
    seed_id: 1,
    block_size: 1,
    pre_dispatch_head: git(project.seeds[0].worktree_path, ['rev-parse', 'HEAD']),
    expected_epoch: 1,
    budget_preimage: 12,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    ...overrides,
  };
}

function finishPayload(project, blockId, summary, operationId = FIXTURE.operation_ids.finish,
  overrides = {}) {
  const before = authority(project);
  return {
    session_id: project.sessionId,
    operation_id: operationId,
    block_id: blockId,
    seed_id: 1,
    status: 'completed',
    returned_head: git(project.seeds[0].worktree_path, ['rev-parse', 'HEAD']),
    summary,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    expected_forum_sha256: before.forum_sha256,
    expected_kill_queue_sha256: before.kill_queue_sha256,
    expected_kill_requests_sha256: before.kill_requests_sha256,
    ...overrides,
  };
}

function advancePayload(project, blockIds, operationId = FIXTURE.operation_ids.advance,
  reason = 'manual_boundary', overrides = {}) {
  const before = authority(project);
  return {
    session_id: project.sessionId,
    operation_id: operationId,
    expected_epoch: 1,
    completed_block_ids: blockIds,
    reason,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    expected_results_sha256: before.results_sha256,
    ...overrides,
  };
}

function finishOneKeep(project, blockId) {
  const worktree = project.seeds[0].worktree_path;
  const pre = git(worktree, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(worktree, 'src', 'index.js'), 'module.exports = 2;\n');
  git(worktree, ['add', 'src/index.js']);
  git(worktree, ['commit', '-qm', 'kept experiment']);
  const commit = git(worktree, ['rev-parse', 'HEAD']);
  const before = authority(project);
  ok(call(project.projectRoot, 'session.finish-experiment', {
    session_id: project.sessionId,
    operation_id: FIXTURE.operation_ids.experiment,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    expected_forum_sha256: before.forum_sha256,
    expected_results_sha256: before.results_sha256,
    seed_id: 1,
    experiment: {
      id: 1,
      category: 'algorithm_swap',
      description: 'Unicode\u2003tokens improve score',
      rationale: 'typed coordinator evidence',
      pre_commit: pre,
      commit,
      status: 'kept',
      raw_score: 5,
      normalized_score: 5,
      score_delta: 1,
      loc_delta: 1,
      flagged: false,
    },
  }), 'session.finish-experiment');
  const summary = { ...structuredClone(FIXTURE.summary), commits: [commit] };
  return { commit, summary, payload: finishPayload(project, blockId, summary) };
}

function assertProjectionRebuild(project, priorProjection, operationId, label, expectedChanged = true) {
  const expectedSession = fs.readFileSync(project.sessionPath);
  const repaired = JSON.parse(expectedSession);
  repaired.virtual_parallel = priorProjection;
  fs.writeFileSync(project.sessionPath, `${JSON.stringify(repaired, null, 2)}\n`);
  const before = authority(project);
  const rebuilt = ok(call(project.projectRoot, 'virtual.rebuild-seeds', {
    session_id: project.sessionId,
    operation_id: operationId,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    expected_results_sha256: before.results_sha256,
  }), label);
  assert.equal(rebuilt.changed, expectedChanged, label);
  assert.deepEqual(fs.readFileSync(project.sessionPath), expectedSession, label);
}

test('Prerequisite 4 publishes exactly the three typed coordinator operations', () => {
  for (const operation of [
    'coord.begin-seed-block', 'coord.finish-seed-block', 'coord.advance-epoch',
  ]) assert.equal(OPERATIONS.includes(operation), true, operation);
});

test('block Q normalizes against every kept delta in the current evaluation epoch', () => {
  const prior = {
    event: 'kept', operation_id: '01J00000000000000000000500', id: 1, seed_id: 1,
    description: 'large delta', score_delta: 2, commit: '1'.repeat(40), status: 'kept',
    pre_commit: '0'.repeat(40), ts: '2026-07-14T00:01:00Z',
  };
  const current = {
    event: 'kept', operation_id: '01J00000000000000000000501', id: 2, seed_id: 1,
    description: 'smaller delta', score_delta: 1, commit: '2'.repeat(40), status: 'kept',
    pre_commit: '1'.repeat(40), ts: '2026-07-14T00:04:00Z',
  };
  const priorSchedule = {
    event: 'seed_scheduled', operation_id: '01J00000000000000000000502',
    block_id: 'prior-block', decision_id: 'prior-decision', seed_id: 1, epoch: 1,
    pre_dispatch_head: '0'.repeat(40), block_size: 1, budget_preimage: 12,
    ts: '2026-07-14T00:00:00Z',
  };
  const priorTerminal = {
    event: 'seed_block_completed', operation_id: '01J00000000000000000000503',
    block_id: 'prior-block', schedule_operation_id: priorSchedule.operation_id,
    seed_id: 1, experiment_ids: [1], commits: [prior.commit],
    forum_entry_ids: [`experiment:${prior.operation_id}`], borrows_given: 0,
    borrows_received: 0, q_components: FIXTURE.expected_components, final_q: 0.85,
    returned_head: prior.commit, status: 'completed', ts: '2026-07-14T00:02:00Z',
  };
  const schedule = {
    ...priorSchedule,
    operation_id: '01J00000000000000000000504',
    block_id: 'current-block',
    decision_id: 'current-decision',
    pre_dispatch_head: prior.commit,
    budget_preimage: 11,
    ts: '2026-07-14T00:03:00Z',
  };
  const forumEvents = [{
    event: 'experiment_kept', operation_id: current.operation_id, session_id: 'session',
    seed_id: 1, experiment_id: 2, commit: current.commit, score_delta: 1,
    ts: '2026-07-14T00:04:00Z',
  }];
  const evidence = deriveFinishEvidence({
    events: [priorSchedule, prior, priorTerminal, schedule, current],
    forumEvents,
    sessionId: 'session',
    blockId: schedule.block_id,
    seedId: 1,
    status: 'completed',
    now: '2026-07-14T00:05:00Z',
  });
  assert.equal(evidence.components.normalized_delta, 0.5);
  assert.equal(evidence.Q, 0.7);
});

test('begin-seed-block authenticates the real worktree and emits one deterministic schedule', (t) => {
  const project = makeProject(t, { label: 'begin happy' });
  const payload = beginPayload(project);
  const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', payload), 'begin');
  assert.equal(begun.seed_id, 1);
  assert.equal(begun.epoch, 1);
  assert.equal(begun.block_size, 1);
  assert.equal(begun.budget_preimage, 12);
  assert.equal(begun.replayed, false);
  assert.match(begun.block_id, /^block:sha256:[0-9a-f]{64}$/);
  const schedules = readJsonl(project.journalPath).filter((entry) => entry.event === 'seed_scheduled');
  assert.deepEqual(schedules, [{
    event: 'seed_scheduled',
    operation_id: FIXTURE.operation_ids.begin,
    block_id: begun.block_id,
    decision_id: FIXTURE.decision_id,
    seed_id: 1,
    epoch: 1,
    pre_dispatch_head: project.baseCommit,
    block_size: 1,
    budget_preimage: 12,
    ts: '2026-07-14T00:00:00Z',
  }]);
  const beforeReplay = authority(project);
  const replayed = ok(call(project.projectRoot, 'coord.begin-seed-block', payload), 'begin replay');
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.block_id, begun.block_id);
  assertAuthority(project, beforeReplay, 'begin replay');
  const conflict = call(project.projectRoot, 'coord.begin-seed-block', {
    ...payload, decision_id: 'conflicting-retry',
  });
  assert.notEqual(conflict.exitCode, 0, JSON.stringify(conflict));
  assertAuthority(project, beforeReplay, 'begin conflicting replay');
});

test('coordinator Git authentication always uses argv with shell disabled', (t) => {
  const project = makeProject(t, { label: 'git argv seam' });
  const calls = [];
  const injectedSpawnSync = (command, args, options) => {
    calls.push({ command, args: structuredClone(args), options: { ...options } });
    return spawnSync(command, args, options);
  };
  const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project), {
    spawnSync: injectedSpawnSync,
  }), 'begin with injected Git');
  const prepared = finishOneKeep(project, begun.block_id);
  ok(call(project.projectRoot, 'coord.finish-seed-block', prepared.payload, {
    spawnSync: injectedSpawnSync,
  }), 'finish with injected Git');
  assert.equal(calls.length > 0, true);
  for (const invocation of calls) {
    assert.equal(invocation.command, 'git');
    assert.equal(Array.isArray(invocation.args), true);
    assert.equal(invocation.options.shell, false);
  }
  assert.equal(calls.some((invocation) => invocation.args.includes('merge-base')), true);
});

test('finish rejects a branch tip changed after its first authenticated summary scan', (t) => {
  const project = makeProject(t, { label: 'stale head after summary' });
  const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)), 'begin');
  const prepared = finishOneKeep(project, begun.block_id);
  const worktree = project.seeds[0].worktree_path;
  let changed = false;
  const injectedSpawnSync = (command, args, options) => {
    const result = spawnSync(command, args, options);
    if (!changed && command === 'git' && args.includes('merge-base')) {
      changed = true;
      fs.writeFileSync(path.join(worktree, 'src', 'index.js'), 'module.exports = 4;\n');
      git(worktree, ['add', 'src/index.js']);
      git(worktree, ['commit', '-qm', 'late branch movement']);
    }
    return result;
  };
  const before = authority(project);
  const response = call(project.projectRoot, 'coord.finish-seed-block', prepared.payload, {
    spawnSync: injectedSpawnSync,
  });
  assert.equal(changed, true);
  assert.notEqual(response.exitCode, 0, JSON.stringify(response));
  assertAuthority(project, before, 'stale HEAD after summary');
});

test('begin fails closed for stale authority, wrong HEAD, wrong epoch/budget, terminal seed, and a second in-flight block', (t) => {
  const mutations = [
    ['stale', { expected_session_sha256: `sha256:${'0'.repeat(64)}` }, 1],
    ['head', { pre_dispatch_head: '0'.repeat(40) }, 1],
    ['epoch', { expected_epoch: 2 }, 1],
    ['budget', { budget_preimage: 11 }, 1],
    ['bool block', { block_size: true }, 2],
    ['oversized', { block_size: 13 }, 1],
  ];
  for (const [index, [label, mutation, exitCode]] of mutations.entries()) {
    const project = makeProject(t, { label: `begin ${label}` });
    const before = authority(project);
    const response = call(project.projectRoot, 'coord.begin-seed-block',
      beginPayload(project, `01J${String(200 + index).padStart(23, '0')}`, mutation));
    assert.equal(response.exitCode, exitCode, `${label}: ${JSON.stringify(response)}`);
    assertAuthority(project, before, label);
  }
  const project = makeProject(t, { label: 'double begin' });
  ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)), 'first begin');
  const before = authority(project);
  const second = call(project.projectRoot, 'coord.begin-seed-block', beginPayload(
    project, '01J00000000000000000000220', { decision_id: 'decision-2' },
  ));
  assert.notEqual(second.exitCode, 0, JSON.stringify(second));
  assertAuthority(project, before, 'double begin');

  const terminal = makeProject(t, { label: 'terminal begin' });
  ok(call(terminal.projectRoot, 'coord.queue-user-kill', {
    session_id: terminal.sessionId, seed_id: 1,
  }, { randomUUID: () => 'request-terminal-seed' }), 'queue terminal request');
  let terminalBefore = authority(terminal);
  ok(call(terminal.projectRoot, 'coord.ack-user-kill-request', {
    session_id: terminal.sessionId,
    operation_id: '01J00000000000000000000221',
    request_id: 'request-terminal-seed',
    choice_id: 'confirm-kill',
    expected_session_sha256: terminalBefore.session_sha256,
    expected_journal_sha256: terminalBefore.journal_sha256,
    expected_forum_sha256: terminalBefore.forum_sha256,
    expected_kill_queue_sha256: terminalBefore.kill_queue_sha256,
    expected_kill_requests_sha256: terminalBefore.kill_requests_sha256,
  }), 'kill terminal seed');
  terminalBefore = authority(terminal);
  const terminalResponse = call(terminal.projectRoot, 'coord.begin-seed-block', beginPayload(
    terminal, '01J00000000000000000000222', { budget_preimage: 0 },
  ));
  assert.notEqual(terminalResponse.exitCode, 0, JSON.stringify(terminalResponse));
  assertAuthority(terminal, terminalBefore, 'terminal seed begin');
});

test('finish derives experiment, commit, forum, borrow, Q, and Git ancestry authority atomically', (t) => {
  const project = makeProject(t, { label: 'finish happy' });
  const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)), 'begin');
  const prepared = finishOneKeep(project, begun.block_id);
  const preFinishProjection = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8')).virtual_parallel;
  const finished = ok(call(project.projectRoot, 'coord.finish-seed-block', prepared.payload), 'finish');
  assert.equal(finished.block_id, begun.block_id);
  assert.equal(finished.final_q, 0.85);
  assert.deepEqual(finished.components, FIXTURE.expected_components);
  assert.deepEqual(finished.experiment_ids, [1]);
  assert.deepEqual(finished.commits, [prepared.commit]);
  assert.equal(finished.forum_entry_ids.length, 1);
  assert.equal(finished.replayed, false);
  const terminal = readJsonl(project.journalPath).find((entry) => entry.event === 'seed_block_completed');
  assert.equal(terminal.schedule_operation_id, FIXTURE.operation_ids.begin);
  assert.deepEqual(terminal.q_components, FIXTURE.expected_components);
  assert.equal(terminal.final_q, 0.85);
  assert.equal(terminal.returned_head, prepared.commit);
  assert.equal(terminal.status, 'completed');
  const session = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'));
  assert.equal(session.virtual_parallel.seeds[0].current_q, 0.85);
  assert.equal(session.virtual_parallel.seeds[0].experiments_used, 1);
  assert.equal(session.virtual_parallel.seeds[0].experiments_used_this_epoch, 1);

  const beforeReplay = authority(project);
  const replayed = ok(call(project.projectRoot, 'coord.finish-seed-block', prepared.payload),
    'finish replay');
  assert.equal(replayed.replayed, true);
  assertAuthority(project, beforeReplay, 'finish replay');
  const conflicting = call(project.projectRoot, 'coord.finish-seed-block', {
    ...prepared.payload,
    summary: { ...prepared.payload.summary, final_q: 0.84 },
  });
  assert.notEqual(conflicting.exitCode, 0, JSON.stringify(conflicting));
  assertAuthority(project, beforeReplay, 'finish conflicting replay');

  const postFinish = fs.readFileSync(project.sessionPath);
  const repair = JSON.parse(postFinish);
  repair.virtual_parallel = preFinishProjection;
  fs.writeFileSync(project.sessionPath, `${JSON.stringify(repair, null, 2)}\n`);
  const beforeRebuild = authority(project);
  const rebuilt = ok(call(project.projectRoot, 'virtual.rebuild-seeds', {
    session_id: project.sessionId,
    operation_id: FIXTURE.operation_ids.rebuild,
    expected_session_sha256: beforeRebuild.session_sha256,
    expected_journal_sha256: beforeRebuild.journal_sha256,
    expected_results_sha256: beforeRebuild.results_sha256,
  }), 'rebuild terminal');
  assert.equal(rebuilt.changed, true);
  assert.deepEqual(fs.readFileSync(project.sessionPath), postFinish);
});

test('finish rejects forged summary, returned HEAD, duplicate terminal, and partial authority without writes', (t) => {
  for (const [label, change] of [
    ['final Q', (payload) => { payload.summary.final_q = 0.84; }],
    ['near final Q', (payload) => { payload.summary.final_q += 5e-13; }],
    ['experiment count', (payload) => { payload.summary.experiments_executed = 2; }],
    ['commits', (payload) => { payload.summary.commits = ['0'.repeat(40)]; }],
    ['forum count', (payload) => { payload.summary.forum_events_appended = 0; }],
    ['borrow planned', (payload) => { payload.summary.borrows_planned = 1; }],
    ['borrow executed', (payload) => { payload.summary.borrows_executed = 1; }],
    ['returned head', (payload, project) => { payload.returned_head = project.baseCommit; }],
  ]) {
    const project = makeProject(t, { label: `finish forged ${label}` });
    const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)), 'begin');
    const prepared = finishOneKeep(project, begun.block_id);
    const payload = structuredClone(prepared.payload);
    change(payload, project);
    const before = authority(project);
    const response = call(project.projectRoot, 'coord.finish-seed-block', payload);
    assert.notEqual(response.exitCode, 0, `${label}: ${JSON.stringify(response)}`);
    assertAuthority(project, before, label);
  }
});

test('finish rejects an authenticated branch tip that is not reproduced by typed experiment authority', (t) => {
  const project = makeProject(t, { label: 'unrecorded head' });
  const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)), 'begin');
  const prepared = finishOneKeep(project, begun.block_id);
  const worktree = project.seeds[0].worktree_path;
  fs.writeFileSync(path.join(worktree, 'src', 'index.js'), 'module.exports = 3;\n');
  git(worktree, ['add', 'src/index.js']);
  git(worktree, ['commit', '-qm', 'unrecorded commit']);
  const unrecorded = git(worktree, ['rev-parse', 'HEAD']);
  const payload = finishPayload(project, begun.block_id, prepared.summary,
    '01J00000000000000000000299', { returned_head: unrecorded });
  const before = authority(project);
  const response = call(project.projectRoot, 'coord.finish-seed-block', payload);
  assert.notEqual(response.exitCode, 0, JSON.stringify(response));
  assertAuthority(project, before, 'unrecorded head');
});

test('finish rejects a forum projection whose operation ID matches but typed experiment fields are forged', (t) => {
  for (const [index, [label, mutation]] of [
    ['commit', { commit: '0'.repeat(40) }],
    ['session', { session_id: '01J00000000000000000009999' }],
    ['timestamp', { ts: '2026-07-13T23:59:59Z' }],
  ].entries()) {
    const project = makeProject(t, { label: `forged forum ${label}` });
    const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)), 'begin');
    const prepared = finishOneKeep(project, begun.block_id);
    const [forum] = readJsonl(project.forumPath);
    fs.writeFileSync(project.forumPath, `${JSON.stringify({ ...forum, ...mutation })}\n`);
    const payload = finishPayload(project, begun.block_id, prepared.summary,
      `01J${String(298 + index).padStart(23, '0')}`);
    const before = authority(project);
    const response = call(project.projectRoot, 'coord.finish-seed-block', payload);
    assert.equal(response.exitCode, 2, `${label}: ${JSON.stringify(response)}`);
    assertAuthority(project, before, `forged forum ${label}`);
  }
});

test('failed block derives crash Q without caller counts and closes its in-flight authority', (t) => {
  const project = makeProject(t, { label: 'failed block' });
  const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)), 'begin');
  const priorProjection = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8')).virtual_parallel;
  const summary = {
    experiments_executed: 0,
    commits: [],
    final_q: 0,
    forum_events_appended: 0,
    borrows_planned: 0,
    borrows_executed: 0,
  };
  const payload = finishPayload(project, begun.block_id, summary,
    '01J00000000000000000000300', { status: 'failed' });
  const result = ok(call(project.projectRoot, 'coord.finish-seed-block', payload), 'failed finish');
  assert.deepEqual(result.components, FIXTURE.failed_components);
  assert.equal(result.final_q, 0);
  assert.equal(readJsonl(project.journalPath).filter((entry) => entry.event === 'seed_block_failed').length, 1);
  assertProjectionRebuild(project, priorProjection, '01J00000000000000000000301',
    'rebuild failed block', false);
});

test('finish refreshes an authenticated deferred kill snapshot and applies it through the shared reducer', (t) => {
  const project = makeProject(t, { label: 'finish deferred kill' });
  const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)), 'begin');
  ok(call(project.projectRoot, 'coord.queue-user-kill', {
    session_id: project.sessionId, seed_id: 1,
  }, { randomUUID: () => 'request-during-block' }), 'queue request');
  let before = authority(project);
  const ack = ok(call(project.projectRoot, 'coord.ack-user-kill-request', {
    session_id: project.sessionId,
    operation_id: FIXTURE.operation_ids.ack,
    request_id: 'request-during-block',
    choice_id: 'confirm-kill',
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    expected_forum_sha256: before.forum_sha256,
    expected_kill_queue_sha256: before.kill_queue_sha256,
    expected_kill_requests_sha256: before.kill_requests_sha256,
  }), 'ack deferred');
  assert.equal(ack.queued, true);
  assert.deepEqual(readJsonl(project.killQueuePath)[0].final_q, 0);
  const prepared = finishOneKeep(project, begun.block_id);
  const priorProjection = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8')).virtual_parallel;
  const finished = ok(call(project.projectRoot, 'coord.finish-seed-block', prepared.payload),
    'finish and kill');
  assert.deepEqual(finished.killed_seed_ids, [1]);
  assert.deepEqual(readJsonl(project.killQueuePath), []);
  const session = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'));
  assert.equal(session.virtual_parallel.seeds[0].status, 'killed:user_requested');
  assert.equal(session.virtual_parallel.seeds[0].experiments_used, 1);
  assert.equal(session.virtual_parallel.seeds[0].allocated_budget, 1);
  assert.equal(session.virtual_parallel.budget_unallocated, 11);
  const events = readJsonl(project.journalPath);
  const terminalIndex = events.findIndex((entry) => entry.event === 'seed_block_completed');
  assert.equal(events[terminalIndex + 1].event, 'seed_killed');
  assert.equal(events[terminalIndex + 1].operation_id, FIXTURE.operation_ids.finish);
  assert.equal(events[terminalIndex + 2].event, 'operation_receipt');
  assertProjectionRebuild(project, priorProjection, '01J00000000000000000000302',
    'rebuild terminal plus deferred kill');
});

test('advance-epoch requires the exact gap-free block boundary and writes both typed events with one projection', (t) => {
  const project = makeProject(t, { label: 'advance happy' });
  const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)), 'begin');
  const prepared = finishOneKeep(project, begun.block_id);
  ok(call(project.projectRoot, 'coord.finish-seed-block', prepared.payload), 'finish');
  const priorProjection = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8')).virtual_parallel;
  const payload = advancePayload(project, [begun.block_id]);
  const advanced = ok(call(project.projectRoot, 'coord.advance-epoch', payload), 'advance');
  assert.deepEqual(advanced, {
    route: 'outer-loop',
    from_epoch: 1,
    to_epoch: 2,
    generation: 1,
    Q: 0.85,
    components: FIXTURE.expected_components,
    session_sha256: advanced.session_sha256,
    journal_sha256: advanced.journal_sha256,
    replayed: false,
  });
  const session = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'));
  assert.equal(session.status, 'paused');
  assert.equal(session.outer_loop.generation, 1);
  assert.equal(session.evaluation_epoch.current, 2);
  assert.deepEqual(session.outer_loop.q_history, [{ generation: 1, Q: 0.85, epoch: 1 }]);
  assert.deepEqual(session.evaluation_epoch.history[0].generations, [1]);
  assert.equal(session.evaluation_epoch.history[0].best_Q, 0.85);
  assert.equal(session.evaluation_epoch.history[1].epoch, 2);
  assert.equal(session.virtual_parallel.seeds[0].experiments_used_this_epoch, 0);
  const tail = readJsonl(project.journalPath).slice(-3);
  assert.deepEqual(tail.map((entry) => entry.event), [
    'outer_loop', 'evaluation_epoch_advanced', 'operation_receipt',
  ]);
  assert.deepEqual(tail[1].completed_block_ids, [begun.block_id]);
  const beforeReplay = authority(project);
  assert.equal(ok(call(project.projectRoot, 'coord.advance-epoch', payload), 'advance replay').replayed, true);
  assertAuthority(project, beforeReplay, 'advance replay');
  assertProjectionRebuild(project, priorProjection, '01J00000000000000000000303',
    'rebuild epoch reset');
  const pausedBefore = authority(project);
  const paused = call(project.projectRoot, 'coord.advance-epoch', advancePayload(
    project, [begun.block_id], '01J00000000000000000000304', 'manual_boundary', {
      expected_epoch: 2,
    },
  ));
  assert.notEqual(paused.exitCode, 0, JSON.stringify(paused));
  assertAuthority(project, pausedBefore, 'paused lifecycle boundary');
});

test('advance fails closed for missing/out-of-order blocks, in-flight work, stale epoch, bad reason, and forged results', (t) => {
  const project = makeProject(t, { label: 'advance failures' });
  const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)), 'begin');
  const beforeInFlight = authority(project);
  const inFlight = call(project.projectRoot, 'coord.advance-epoch', advancePayload(project, []));
  assert.notEqual(inFlight.exitCode, 0, JSON.stringify(inFlight));
  assertAuthority(project, beforeInFlight, 'in flight');
  const prepared = finishOneKeep(project, begun.block_id);
  ok(call(project.projectRoot, 'coord.finish-seed-block', prepared.payload), 'finish');
  for (const [label, overrides] of [
    ['missing', { completed_block_ids: [] }],
    ['unknown', { completed_block_ids: ['block:sha256:not-real'] }],
    ['epoch', { expected_epoch: 2 }],
    ['reason', { reason: 'automatic' }],
    ['results', { expected_results_sha256: `sha256:${'0'.repeat(64)}` }],
    ['premature interval', { reason: 'block_interval' }],
  ]) {
    const before = authority(project);
    const response = call(project.projectRoot, 'coord.advance-epoch',
      advancePayload(project, [begun.block_id], `01J${String(400 + label.length).padStart(23, '0')}`,
        'manual_boundary', overrides));
    assert.notEqual(response.exitCode, 0, `${label}: ${JSON.stringify(response)}`);
    assertAuthority(project, before, label);
  }
});

test('each authenticated epoch reason reaches the same exact boundary transaction', (t) => {
  for (const [index, reason] of [
    'block_interval', 'tier3_expansion', 'termination_boundary',
  ].entries()) {
    const project = makeProject(t, {
      label: `advance reason ${reason}`,
      ...(reason === 'block_interval' ? { interval: 1 } : {}),
    });
    const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(
      project, `01J${String(430 + index * 4).padStart(23, '0')}`,
    )), `${reason}: begin`);
    const prepared = finishOneKeep(project, begun.block_id);
    prepared.payload.operation_id = `01J${String(431 + index * 4).padStart(23, '0')}`;
    ok(call(project.projectRoot, 'coord.finish-seed-block', prepared.payload), `${reason}: finish`);
    if (reason === 'tier3_expansion') {
      const before = authority(project);
      ok(call(project.projectRoot, 'session.record-evaluator-expansion', {
        session_id: project.sessionId,
        operation_id: `01J${String(432 + index * 4).padStart(23, '0')}`,
        expected_session_sha256: before.session_sha256,
        expected_journal_sha256: before.journal_sha256,
        harness_identity: {
          prepare_sha256: digest(fs.readFileSync(path.join(project.sessionRoot, 'prepare.cjs'))),
          config_sha256: digest(fs.readFileSync(
            path.join(project.sessionRoot, 'prepare.config.json'),
          )),
        },
        reason: 'tier3 coordinator boundary',
        trigger_generation: 0,
      }), 'record tier3 authority');
    }
    const advanced = ok(call(project.projectRoot, 'coord.advance-epoch', advancePayload(
      project,
      [begun.block_id],
      `01J${String(433 + index * 4).padStart(23, '0')}`,
      reason,
    )), `${reason}: advance`);
    assert.equal(advanced.route, 'outer-loop');
    const epoch = readJsonl(project.journalPath)
      .find((event) => event.event === 'evaluation_epoch_advanced');
    assert.equal(epoch.reason, reason);
  }
  assert.deepEqual(FIXTURE.reasons, [
    'block_interval', 'tier3_expansion', 'manual_boundary', 'termination_boundary',
  ]);
});

test('all coordinator payloads reject unknown fields and bool-as-int without touching authority', (t) => {
  const project = makeProject(t, { label: 'exact payloads' });
  for (const [operation, payload] of [
    ['coord.begin-seed-block', { ...beginPayload(project), extra: true }],
    ['coord.begin-seed-block', { ...beginPayload(project), seed_id: true }],
  ]) {
    const before = authority(project);
    const response = call(project.projectRoot, operation, payload);
    assert.equal(response.exitCode, 2, JSON.stringify(response));
    assertAuthority(project, before, operation);
  }

  const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)),
    'begin exact payload setup');
  const prepared = finishOneKeep(project, begun.block_id);
  for (const [label, payload] of [
    ['finish unknown', { ...prepared.payload, extra: true }],
    ['finish bool seed', { ...prepared.payload, seed_id: true }],
    ['finish summary unknown', {
      ...prepared.payload, summary: { ...prepared.payload.summary, extra: 1 },
    }],
  ]) {
    const before = authority(project);
    const response = call(project.projectRoot, 'coord.finish-seed-block', payload);
    assert.equal(response.exitCode, 2, `${label}: ${JSON.stringify(response)}`);
    assertAuthority(project, before, label);
  }
  ok(call(project.projectRoot, 'coord.finish-seed-block', prepared.payload),
    'finish exact payload setup');
  for (const [label, payload] of [
    ['advance unknown', { ...advancePayload(project, [begun.block_id]), extra: true }],
    ['advance bool epoch', { ...advancePayload(project, [begun.block_id]), expected_epoch: true }],
    ['advance unsafe epoch', {
      ...advancePayload(project, [begun.block_id]),
      expected_epoch: Number.MAX_SAFE_INTEGER + 1,
    }],
    ['advance bool block id', { ...advancePayload(project, [begun.block_id]), completed_block_ids: [true] }],
  ]) {
    const before = authority(project);
    const response = call(project.projectRoot, 'coord.advance-epoch', payload);
    assert.equal(response.exitCode, 2, `${label}: ${JSON.stringify(response)}`);
    assertAuthority(project, before, label);
  }
});

test('two coordinators sharing one CAS preimage serialize to one schedule without duplicate authority', async (t) => {
  const project = makeProject(t, { nChosen: 2, totalBudget: 24, label: 'begin race' });
  const before = authority(project);
  const payloads = project.seeds.map((seed, index) => ({
    session_id: project.sessionId,
    operation_id: `01J${String(600 + index).padStart(23, '0')}`,
    decision_id: `race-decision-${index + 1}`,
    seed_id: index + 1,
    block_size: 1,
    pre_dispatch_head: git(seed.worktree_path, ['rev-parse', 'HEAD']),
    expected_epoch: 1,
    budget_preimage: 12,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
  }));
  const script = `
    const { dispatch } = require(${JSON.stringify(RUNTIME)});
    const payload = JSON.parse(process.argv[1]);
    const response = dispatch({schema_version:'1.0', operation:'coord.begin-seed-block',
      context:{project_root:${JSON.stringify(project.projectRoot)}}, payload});
    process.stdout.write(JSON.stringify(response));
    process.exitCode = response.exitCode;
  `;
  const children = payloads.map((payload) => waitFor(spawn(process.execPath,
    ['-e', script, JSON.stringify(payload)], { stdio: ['ignore', 'pipe', 'pipe'] })));
  const outcomes = await Promise.all(children);
  const responses = outcomes.map((outcome) => JSON.parse(outcome.stdout));
  assert.equal(responses.filter((response) => response.ok).length, 1, JSON.stringify(responses));
  assert.equal(responses.filter((response) => response.error
    && response.error.code === 'stale_preimage').length, 1, JSON.stringify(responses));
  const events = readJsonl(project.journalPath);
  assert.equal(events.filter((event) => event.event === 'seed_scheduled').length, 1);
  assert.equal(events.filter((event) => event.event === 'operation_receipt'
    && event.operation === 'coord.begin-seed-block').length, 1);
});

test('two coordinators racing the same seed serialize to one schedule', async (t) => {
  const project = makeProject(t, { label: 'same seed begin race' });
  const before = authority(project);
  const payloads = [0, 1].map((index) => ({
    session_id: project.sessionId,
    operation_id: `01J${String(610 + index).padStart(23, '0')}`,
    decision_id: `same-seed-race-${index + 1}`,
    seed_id: 1,
    block_size: 1,
    pre_dispatch_head: git(project.seeds[0].worktree_path, ['rev-parse', 'HEAD']),
    expected_epoch: 1,
    budget_preimage: 12,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
  }));
  const outcomes = await Promise.all(payloads.map((payload) => (
    spawnCall(project.projectRoot, 'coord.begin-seed-block', payload)
  )));
  const responses = outcomes.map((outcome) => JSON.parse(outcome.stdout));
  assert.equal(responses.filter((response) => response.ok).length, 1, JSON.stringify(responses));
  assert.equal(responses.filter((response) => response.error
    && response.error.code === 'stale_preimage').length, 1, JSON.stringify(responses));
  const events = readJsonl(project.journalPath);
  assert.equal(events.filter((event) => event.event === 'seed_scheduled').length, 1);
});

test('finish racing a user-kill acknowledgement converges through one terminal and shared kill reducer', async (t) => {
  const project = makeProject(t, { label: 'finish ack race' });
  const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)), 'begin');
  ok(call(project.projectRoot, 'coord.queue-user-kill', {
    session_id: project.sessionId, seed_id: 1,
  }, { randomUUID: () => 'request-finish-race' }), 'queue user request');
  const prepared = finishOneKeep(project, begun.block_id);
  const before = authority(project);
  const ackPayload = {
    session_id: project.sessionId,
    operation_id: '01J00000000000000000000620',
    request_id: 'request-finish-race',
    choice_id: 'confirm-kill',
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    expected_forum_sha256: before.forum_sha256,
    expected_kill_queue_sha256: before.kill_queue_sha256,
    expected_kill_requests_sha256: before.kill_requests_sha256,
  };
  const [finishOutcome, ackOutcome] = await Promise.all([
    spawnCall(project.projectRoot, 'coord.finish-seed-block', prepared.payload),
    spawnCall(project.projectRoot, 'coord.ack-user-kill-request', ackPayload),
  ]);
  let finishResponse = JSON.parse(finishOutcome.stdout);
  let ackResponse = JSON.parse(ackOutcome.stdout);
  assert.equal([finishResponse, ackResponse].filter((response) => response.ok).length, 1,
    JSON.stringify([finishResponse, ackResponse]));
  if (!finishResponse.ok) {
    const current = authority(project);
    finishResponse = call(project.projectRoot, 'coord.finish-seed-block', {
      ...prepared.payload,
      expected_session_sha256: current.session_sha256,
      expected_journal_sha256: current.journal_sha256,
      expected_forum_sha256: current.forum_sha256,
      expected_kill_queue_sha256: current.kill_queue_sha256,
      expected_kill_requests_sha256: current.kill_requests_sha256,
    });
  } else {
    const current = authority(project);
    ackResponse = call(project.projectRoot, 'coord.ack-user-kill-request', {
      ...ackPayload,
      expected_session_sha256: current.session_sha256,
      expected_journal_sha256: current.journal_sha256,
      expected_forum_sha256: current.forum_sha256,
      expected_kill_queue_sha256: current.kill_queue_sha256,
      expected_kill_requests_sha256: current.kill_requests_sha256,
    });
  }
  assert.equal(finishResponse.ok, true, JSON.stringify(finishResponse));
  assert.equal(ackResponse.ok, true, JSON.stringify(ackResponse));
  const events = readJsonl(project.journalPath);
  assert.equal(events.filter((event) => event.event === 'seed_block_completed').length, 1);
  assert.equal(events.filter((event) => event.event === 'seed_killed').length, 1);
  assert.deepEqual(readJsonl(project.killQueuePath), []);
  assert.equal(JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'))
    .virtual_parallel.seeds[0].status, 'killed:user_requested');
});

test('epoch boundary racing a late block completion never publishes the epoch first', async (t) => {
  const project = makeProject(t, { label: 'finish boundary race' });
  const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)), 'begin');
  const prepared = finishOneKeep(project, begun.block_id);
  const boundary = advancePayload(project, [begun.block_id],
    '01J00000000000000000000630');
  const [finishOutcome, boundaryOutcome] = await Promise.all([
    spawnCall(project.projectRoot, 'coord.finish-seed-block', prepared.payload),
    spawnCall(project.projectRoot, 'coord.advance-epoch', boundary),
  ]);
  const finishResponse = JSON.parse(finishOutcome.stdout);
  const boundaryResponse = JSON.parse(boundaryOutcome.stdout);
  assert.equal(finishResponse.ok, true, JSON.stringify(finishResponse));
  assert.equal(boundaryResponse.ok, false, JSON.stringify(boundaryResponse));
  let events = readJsonl(project.journalPath);
  assert.equal(events.filter((event) => event.event === 'seed_block_completed').length, 1);
  assert.equal(events.filter((event) => event.event === 'evaluation_epoch_advanced').length, 0);
  const advanced = ok(call(project.projectRoot, 'coord.advance-epoch', advancePayload(
    project, [begun.block_id], '01J00000000000000000000631', 'manual_boundary',
  )), 'retry boundary after terminal');
  assert.equal(advanced.to_epoch, 2);
  events = readJsonl(project.journalPath);
  assert.equal(events.filter((event) => event.event === 'evaluation_epoch_advanced').length, 1);
});

test('finish crash cutpoints recover only the complete queued pre-state or terminal-plus-kill post-state', (t) => {
  const cutpointsFor = (project) => {
    const relative = path.relative(path.join(project.projectRoot, '.deep-evolve'), project.sessionRoot)
      .split(path.sep).join('/');
    return [
      `after-stage:${relative}/session.yaml`,
      `after-stage:${relative}/journal.jsonl`,
      `after-stage:${relative}/forum.jsonl`,
      `after-stage:${relative}/kill_queue.jsonl`,
      `after-stage:${relative}/kill_requests.jsonl`,
      'after-transaction',
      'after-commit-marker',
      `after-install:${relative}/session.yaml`,
      `after-install:${relative}/journal.jsonl`,
      `after-install:${relative}/kill_queue.jsonl`,
    ];
  };
  for (let index = 0; index < 10; index += 1) {
    const project = makeProject(t, { label: `finish crash ${index}` });
    const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(
      project, `01J${String(700 + index * 4).padStart(23, '0')}`,
    )), 'begin');
    ok(call(project.projectRoot, 'coord.queue-user-kill', {
      session_id: project.sessionId, seed_id: 1,
    }, { randomUUID: () => `request-crash-${index}` }), 'queue user kill');
    let before = authority(project);
    ok(call(project.projectRoot, 'coord.ack-user-kill-request', {
      session_id: project.sessionId,
      operation_id: `01J${String(701 + index * 4).padStart(23, '0')}`,
      request_id: `request-crash-${index}`,
      choice_id: 'confirm-kill',
      expected_session_sha256: before.session_sha256,
      expected_journal_sha256: before.journal_sha256,
      expected_forum_sha256: before.forum_sha256,
      expected_kill_queue_sha256: before.kill_queue_sha256,
      expected_kill_requests_sha256: before.kill_requests_sha256,
    }), 'ack queued kill');
    const prepared = finishOneKeep(project, begun.block_id);
    prepared.payload.operation_id = `01J${String(702 + index * 4).padStart(23, '0')}`;
    const current = authority(project);
    prepared.payload.expected_session_sha256 = current.session_sha256;
    prepared.payload.expected_journal_sha256 = current.journal_sha256;
    prepared.payload.expected_forum_sha256 = current.forum_sha256;
    prepared.payload.expected_kill_queue_sha256 = current.kill_queue_sha256;
    prepared.payload.expected_kill_requests_sha256 = current.kill_requests_sha256;
    const cutpoint = cutpointsFor(project)[index];
    const script = `
      const { dispatch } = require(${JSON.stringify(RUNTIME)});
      dispatch(${JSON.stringify({
        schema_version: '1.0', operation: 'coord.finish-seed-block',
        context: { project_root: project.projectRoot }, payload: prepared.payload,
      })}, { now: () => ${FIXED_NOW}, crashAt: ${JSON.stringify(cutpoint)} });
    `;
    const crashed = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(crashed.status, 86, `${cutpoint}: ${crashed.stderr}`);
    const recovered = call(project.projectRoot, 'coord.list-user-kill-requests', {
      session_id: project.sessionId,
    });
    assert.equal(recovered.ok, true, `${cutpoint}: ${JSON.stringify(recovered)}`);
    const session = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'));
    const seed = session.virtual_parallel.seeds[0];
    const journal = readJsonl(project.journalPath);
    const queue = readJsonl(project.killQueuePath);
    const terminals = journal.filter((event) => event.event === 'seed_block_completed');
    const kills = journal.filter((event) => event.event === 'seed_killed');
    const completePre = terminals.length === 0 && kills.length === 0 && queue.length === 1
      && seed.status === 'active' && seed.current_q === 0 && seed.experiments_used === 1;
    const completePost = terminals.length === 1 && kills.length === 1 && queue.length === 0
      && seed.status === 'killed:user_requested' && seed.current_q === 0.85
      && seed.experiments_used === 1 && seed.allocated_budget === 1;
    assert.equal(completePre || completePost, true, `${cutpoint}: mixed coordinator state`);
    if (completePost) {
      const beforeReplay = authority(project);
      const replayed = ok(call(project.projectRoot, 'coord.finish-seed-block', prepared.payload),
        `${cutpoint}: committed recovery replay`);
      assert.equal(replayed.replayed, true, cutpoint);
      assertAuthority(project, beforeReplay, `${cutpoint}: committed recovery replay`);
    }
  }
});

test('coordinator finish retries transient win32 renames without opening directories', (t) => {
  const project = makeProject(t, { label: 'win32 finish' });
  const begun = ok(call(project.projectRoot, 'coord.begin-seed-block', beginPayload(project)), 'begin');
  const prepared = finishOneKeep(project, begun.block_id);
  const io = Object.create(fs);
  let failures = 2;
  let directoryOpens = 0;
  io.renameSync = (...args) => {
    if (failures > 0) {
      failures -= 1;
      throw Object.assign(new Error('sharing violation'), {
        code: failures === 1 ? 'EPERM' : 'EACCES',
      });
    }
    return fs.renameSync(...args);
  };
  io.openSync = (target, flags, mode) => {
    try {
      if (fs.statSync(target).isDirectory()) {
        directoryOpens += 1;
        throw Object.assign(new Error('directory access forbidden'), { code: 'EPERM' });
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
    }
    return fs.openSync(target, flags, mode);
  };
  const finished = call(project.projectRoot, 'coord.finish-seed-block', prepared.payload, {
    platform: 'win32', io, sleep: () => {},
  });
  assert.equal(finished.ok, true, JSON.stringify(finished));
  assert.equal(failures, 0);
  assert.equal(directoryOpens, 0);
  assert.equal(readJsonl(project.journalPath)
    .filter((event) => event.event === 'seed_block_completed').length, 1);
});
