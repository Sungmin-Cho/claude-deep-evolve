'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const RUNTIME = path.resolve(__dirname, '..', 'hooks', 'scripts', 'deep-evolve-runtime.cjs');
const {
  appendTypedEventAndReceipt,
  requestSha256,
  sessionNonProjectionSha256,
} = require('../hooks/scripts/runtime/session-transitions.cjs');
const { dispatch } = require(RUNTIME);
const START = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'session-start-v3.5.json'), 'utf8',
));
const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'user-kill-lifecycle.json'), 'utf8',
));

const FIXED_NOW = Date.parse('2026-07-13T16:05:00Z');
const RESULTS_HEADER = 'commit\tscore\tstatus\tcategory\tscore_delta\tloc_delta\tflagged\trationale\tdescription\n';

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

function writeJsonl(file, records) {
  fs.writeFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
}

function makeProject(t, { nChosen = 1, totalBudget = 12, label = 'user-kill' } = {}) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-user-kill-'));
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
  const started = ok(call(projectRoot, 'session.start', {
    goal: `${label} goal`, initial_state: initial,
  }), 'session.start');
  const sessionRoot = fs.realpathSync(started.session_root);
  const project = {
    outer,
    projectRoot: fs.realpathSync(projectRoot),
    stateRoot: fs.realpathSync(path.join(projectRoot, '.deep-evolve')),
    sessionId: started.session_id,
    sessionRoot,
    sessionPath: path.join(sessionRoot, 'session.yaml'),
    journalPath: path.join(sessionRoot, 'journal.jsonl'),
    forumPath: path.join(sessionRoot, 'forum.jsonl'),
    resultsPath: path.join(sessionRoot, 'results.tsv'),
    killQueuePath: path.join(sessionRoot, 'kill_queue.jsonl'),
    killRequestsPath: path.join(sessionRoot, 'kill_requests.jsonl'),
    baseCommit,
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
      beta: { direction: null, hypothesis: null, rationale: null },
      creation_kind: 'initial',
    }), `virtual.append-seed ${seedId}`);
  }
  fs.writeFileSync(path.join(sessionRoot, 'prepare.cjs'), "'use strict';\nprocess.stdout.write('score: 4\\n');\n");
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
    kill_queue: fs.readFileSync(project.killQueuePath),
    kill_requests: fs.readFileSync(project.killRequestsPath),
  };
  return {
    files,
    session_sha256: digest(files.session),
    journal_sha256: digest(files.journal),
    forum_sha256: digest(files.forum),
    kill_queue_sha256: digest(files.kill_queue),
    kill_requests_sha256: digest(files.kill_requests),
  };
}

function assertAuthority(project, expected, label) {
  const actual = authority(project);
  for (const [name, bytes] of Object.entries(expected.files)) {
    assert.deepEqual(actual.files[name], bytes, `${label}: ${name}`);
  }
}

function ackPayload(project, requestId, choiceId, operationId) {
  const before = authority(project);
  return {
    session_id: project.sessionId,
    operation_id: operationId,
    request_id: requestId,
    choice_id: choiceId,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    expected_forum_sha256: before.forum_sha256,
    expected_kill_queue_sha256: before.kill_queue_sha256,
    expected_kill_requests_sha256: before.kill_requests_sha256,
  };
}

function drainPayload(project, operationId = FIXTURE.operation_ids.drain) {
  const before = authority(project);
  return {
    session_id: project.sessionId,
    operation_id: operationId,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    expected_kill_queue_sha256: before.kill_queue_sha256,
    expected_kill_requests_sha256: before.kill_requests_sha256,
  };
}

function queueRequest(project, requestId, seedId = 1, now = FIXED_NOW) {
  return ok(call(project.projectRoot, 'coord.queue-user-kill', {
    session_id: project.sessionId, seed_id: seedId,
  }, { now: () => now, randomUUID: () => requestId }), 'coord.queue-user-kill');
}

function appendSealedEvent(project, operation, event) {
  const journal = fs.readFileSync(project.journalPath, 'utf8');
  const session = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'));
  const prior = {
    session_sha256: digest(fs.readFileSync(project.sessionPath)),
    journal_sha256: digest(Buffer.from(journal)),
    results_sha256: digest(fs.readFileSync(project.resultsPath)),
  };
  const appended = appendTypedEventAndReceipt(journal, event, {
    operation,
    operationId: event.operation_id,
    requestDigest: requestSha256(operation, { fixture: event.block_id }),
    prior,
    postSessionSha256: prior.session_sha256,
    postResultsSha256: prior.results_sha256,
    postNonProjectionSha256: sessionNonProjectionSha256(session),
    result: { fixture: event.block_id },
    ts: event.ts,
  });
  fs.writeFileSync(project.journalPath, appended.journalText);
}

function scheduleInFlight(project) {
  appendSealedEvent(project, 'coord.begin-seed-block', {
    event: 'seed_scheduled',
    operation_id: FIXTURE.operation_ids.schedule,
    block_id: 'block-user-kill-1',
    decision_id: 'decision-user-kill-1',
    seed_id: 1,
    epoch: 1,
    pre_dispatch_head: project.baseCommit,
    block_size: 1,
    budget_preimage: 12,
    ts: '2026-07-13T16:01:00Z',
  });
}

function finishInFlight(project) {
  appendSealedEvent(project, 'coord.finish-seed-block', {
    event: 'seed_block_failed',
    operation_id: FIXTURE.operation_ids.terminal,
    block_id: 'block-user-kill-1',
    schedule_operation_id: FIXTURE.operation_ids.schedule,
    seed_id: 1,
    experiment_ids: [],
    commits: [],
    forum_entry_ids: [],
    borrows_given: 0,
    borrows_received: 0,
    q_components: { keep_rate: 0, normalized_delta: 0, crash_rate: 1, idea_diversity: 0 },
    final_q: 0,
    returned_head: project.baseCommit,
    status: 'failed',
    ts: '2026-07-13T16:02:00Z',
  });
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

test('list-user-kill-requests validates exact records, orders pending requests, and returns five authority digests', (t) => {
  const project = makeProject(t, { nChosen: 2, totalBudget: 24, label: 'list ordering' });
  writeJsonl(project.killRequestsPath, FIXTURE.pending);
  const listed = ok(call(project.projectRoot, 'coord.list-user-kill-requests', {
    session_id: project.sessionId,
  }), 'coord.list-user-kill-requests');
  assert.deepEqual(listed.pending.map((entry) => entry.entry_id), ['request-earlier', 'request-later']);
  assert.deepEqual(listed.acknowledged, []);
  assert.deepEqual(listed.authority_digests, {
    session_sha256: authority(project).session_sha256,
    journal_sha256: authority(project).journal_sha256,
    forum_sha256: authority(project).forum_sha256,
    kill_queue_sha256: authority(project).kill_queue_sha256,
    kill_requests_sha256: authority(project).kill_requests_sha256,
  });
  assert.deepEqual(Object.keys(listed).sort(), ['acknowledged', 'authority_digests', 'pending']);
});

test('list rejects malformed, non-object, duplicate, missing-seed, and terminal-seed requests without touching any authority file', (t) => {
  const cases = [
    ['malformed', '{"entry_id":\n'],
    ['non-object', '[]\n'],
    ['duplicate', `${JSON.stringify(FIXTURE.pending[0])}\n${JSON.stringify(FIXTURE.pending[0])}\n`],
    ['missing seed', `${JSON.stringify({ ...FIXTURE.pending[0], seed_id: 9 })}\n`],
    ['invalid calendar timestamp', `${JSON.stringify({
      ...FIXTURE.pending[0], requested_at: '2026-02-31T00:00:00Z',
    })}\n`],
  ];
  for (const [label, bytes] of cases) {
    const project = makeProject(t, { label: `reject ${label}` });
    fs.writeFileSync(project.killRequestsPath, bytes);
    const before = authority(project);
    const response = call(project.projectRoot, 'coord.list-user-kill-requests', {
      session_id: project.sessionId,
    });
    assert.equal(response.exitCode, 2, `${label}: ${JSON.stringify(response)}`);
    assertAuthority(project, before, label);
  }

  const terminal = makeProject(t, { label: 'terminal request' });
  queueRequest(terminal, 'request-terminal');
  ok(call(terminal.projectRoot, 'coord.ack-user-kill-request',
    ackPayload(terminal, 'request-terminal', 'confirm-kill', FIXTURE.operation_ids.ack_idle)), 'kill terminal seed');
  fs.appendFileSync(terminal.killRequestsPath, `${JSON.stringify({
    entry_id: 'request-after-terminal', seed_id: 1, requested_at: '2026-07-13T16:10:00Z',
    acknowledged_at: null, choice_id: null, kill_entry_id: null,
  })}\n`);
  const before = authority(terminal);
  const response = call(terminal.projectRoot, 'coord.list-user-kill-requests', {
    session_id: terminal.sessionId,
  });
  assert.equal(response.exitCode, 2, JSON.stringify(response));
  assertAuthority(terminal, before, 'terminal seed');
});

test('queue-user-kill writes the exact pending request schema', (t) => {
  const project = makeProject(t, { label: 'pending schema' });
  const request = queueRequest(project, 'request-schema');
  assert.deepEqual(request, {
    entry_id: 'request-schema',
    seed_id: 1,
    requested_at: '2026-07-13T16:05:00Z',
    acknowledged_at: null,
    choice_id: null,
    kill_entry_id: null,
  });
  assert.deepEqual(readJsonl(project.killRequestsPath), [request]);
});

test('list rejects orphaned and contradictory user-kill event authority without mutation', (t) => {
  for (const mutation of ['missing request', 'keep-seed rewrite']) {
    const project = makeProject(t, { label: `event binding ${mutation}` });
    queueRequest(project, `request-binding-${mutation}`);
    ok(call(project.projectRoot, 'coord.ack-user-kill-request', ackPayload(
      project,
      `request-binding-${mutation}`,
      'confirm-kill',
      FIXTURE.operation_ids.ack_idle,
    )), `confirm ${mutation}`);
    const [request] = readJsonl(project.killRequestsPath);
    writeJsonl(project.killRequestsPath, mutation === 'missing request' ? [] : [{
      ...request,
      choice_id: 'keep-seed',
      kill_entry_id: null,
    }]);
    const before = authority(project);
    const response = call(project.projectRoot, 'coord.list-user-kill-requests', {
      session_id: project.sessionId,
    });
    assert.equal(response.exitCode, 2, `${mutation}: ${JSON.stringify(response)}`);
    assertAuthority(project, before, mutation);
  }
});

test('keep-seed acknowledges once, appends no kill, and exact-operation replay is byte-identical', (t) => {
  const project = makeProject(t, { label: 'keep seed' });
  queueRequest(project, 'request-keep');
  const payload = ackPayload(project, 'request-keep', 'keep-seed', FIXTURE.operation_ids.ack_keep);
  const first = ok(call(project.projectRoot, 'coord.ack-user-kill-request', payload), 'keep seed');
  assert.equal(first.applied, false);
  assert.equal(first.queued, false);
  assert.equal(first.replayed, false);
  assert.deepEqual(readJsonl(project.killQueuePath), []);
  assert.equal(readJsonl(project.journalPath).some((event) => event.event === 'seed_killed'), false);
  assert.deepEqual(readJsonl(project.killRequestsPath)[0], {
    entry_id: 'request-keep', seed_id: 1, requested_at: '2026-07-13T16:05:00Z',
    acknowledged_at: '2026-07-13T16:05:00Z', choice_id: 'keep-seed', kill_entry_id: null,
  });
  const beforeReplay = authority(project);
  const replay = ok(call(project.projectRoot, 'coord.ack-user-kill-request', payload), 'keep replay');
  assert.equal(replay.replayed, true);
  assertAuthority(project, beforeReplay, 'keep replay');

  const conflict = call(project.projectRoot, 'coord.ack-user-kill-request', {
    ...payload, choice_id: 'confirm-kill',
  });
  assert.equal(conflict.exitCode, 2, JSON.stringify(conflict));
  assertAuthority(project, beforeReplay, 'conflicting replay');
});

test('invalid choices and unknown payload fields fail before any of five authority files change', (t) => {
  for (const [index, choice] of FIXTURE.invalid_choices.entries()) {
    const project = makeProject(t, { label: `invalid choice ${index}` });
    queueRequest(project, `request-invalid-${index}`);
    const before = authority(project);
    const response = call(project.projectRoot, 'coord.ack-user-kill-request',
      ackPayload(project, `request-invalid-${index}`, choice,
        `01J${String(200 + index).padStart(23, '0')}`));
    assert.equal(response.exitCode, 2, `${JSON.stringify(choice)}: ${JSON.stringify(response)}`);
    assertAuthority(project, before, `choice ${JSON.stringify(choice)}`);
  }
  const project = makeProject(t, { label: 'unknown payload' });
  queueRequest(project, 'request-extra');
  const before = authority(project);
  const response = call(project.projectRoot, 'coord.ack-user-kill-request', {
    ...ackPayload(project, 'request-extra', 'confirm-kill', FIXTURE.operation_ids.ack_idle),
    completed_seed_id: 1,
  });
  assert.equal(response.exitCode, 2, JSON.stringify(response));
  assertAuthority(project, before, 'unknown payload');
});

test('idle confirmation atomically acknowledges, applies one exact protected kill, reclaims budget, and rebuilds byte-identically', (t) => {
  const project = makeProject(t, { label: 'idle confirm' });
  queueRequest(project, 'request-idle');
  const preKillSession = fs.readFileSync(project.sessionPath);
  const result = ok(call(project.projectRoot, 'coord.ack-user-kill-request',
    ackPayload(project, 'request-idle', 'confirm-kill', FIXTURE.operation_ids.ack_idle)), 'idle confirm');
  assert.equal(result.applied, true);
  assert.equal(result.queued, false);
  assert.match(result.kill_entry_id, new RegExp(FIXTURE.kill_entry_pattern));
  assert.deepEqual(readJsonl(project.killQueuePath), []);
  const acknowledged = readJsonl(project.killRequestsPath)[0];
  assert.equal(acknowledged.choice_id, 'confirm-kill');
  assert.equal(acknowledged.kill_entry_id, result.kill_entry_id);
  const killed = readJsonl(project.journalPath).filter((event) => event.event === 'seed_killed');
  assert.deepEqual(killed, [{
    event: 'seed_killed',
    operation_id: FIXTURE.operation_ids.ack_idle,
    source: 'user_request',
    request_id: 'request-idle',
    kill_entry_id: result.kill_entry_id,
    seed_id: 1,
    condition: 'user_requested',
    ts: '2026-07-13T16:05:00Z',
    applied_at: '2026-07-13T16:05:00Z',
  }]);
  const postKillSession = fs.readFileSync(project.sessionPath);
  const session = JSON.parse(postKillSession);
  assert.equal(session.virtual_parallel.seeds[0].status, 'killed:user_requested');
  assert.equal(session.virtual_parallel.seeds[0].allocated_budget, 0);
  assert.equal(session.virtual_parallel.budget_unallocated, 12);
  assert.equal(session.virtual_parallel['x-active-seed-count'], 0);
  assert.equal(Object.hasOwn(session.virtual_parallel, 'n_current'), false);

  fs.writeFileSync(project.sessionPath, preKillSession);
  const beforeRebuild = authority(project);
  const rebuilt = ok(call(project.projectRoot, 'virtual.rebuild-seeds', {
    session_id: project.sessionId,
    operation_id: FIXTURE.operation_ids.rebuild,
    expected_session_sha256: beforeRebuild.session_sha256,
    expected_journal_sha256: beforeRebuild.journal_sha256,
    expected_results_sha256: digest(fs.readFileSync(project.resultsPath)),
  }), 'rebuild killed seed');
  assert.equal(rebuilt.changed, true);
  assert.deepEqual(fs.readFileSync(project.sessionPath), postKillSession);
});

test('in-flight confirmation keeps one stable queue row until terminal authority and drain apply it once', (t) => {
  const project = makeProject(t, { label: 'in flight' });
  queueRequest(project, 'request-flight');
  scheduleInFlight(project);
  const acked = ok(call(project.projectRoot, 'coord.ack-user-kill-request',
    ackPayload(project, 'request-flight', 'confirm-kill', FIXTURE.operation_ids.ack_in_flight)), 'in-flight ack');
  assert.equal(acked.applied, false);
  assert.equal(acked.queued, true);
  const queued = readJsonl(project.killQueuePath);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0], {
    entry_id: acked.kill_entry_id,
    request_id: 'request-flight',
    seed_id: 1,
    condition: 'user_requested',
    final_q: 0,
    experiments_used: 0,
    queued_at: '2026-07-13T16:05:00Z',
  });
  finishInFlight(project);
  const preDrainSession = fs.readFileSync(project.sessionPath);
  const drained = ok(call(project.projectRoot, 'coord.drain-kill-queue',
    drainPayload(project)), 'drain');
  assert.equal(drained.applied, 1);
  assert.equal(drained.remaining, 0);
  assert.deepEqual(readJsonl(project.killQueuePath), []);
  assert.equal(readJsonl(project.journalPath).filter((event) => event.event === 'seed_killed').length, 1);
  const postDrain = fs.readFileSync(project.sessionPath);
  fs.writeFileSync(project.sessionPath, preDrainSession);
  const beforeRebuild = authority(project);
  ok(call(project.projectRoot, 'virtual.rebuild-seeds', {
    session_id: project.sessionId,
    operation_id: '01J00000000000000000000108',
    expected_session_sha256: beforeRebuild.session_sha256,
    expected_journal_sha256: beforeRebuild.journal_sha256,
    expected_results_sha256: digest(fs.readFileSync(project.resultsPath)),
  }), 'rebuild deferred kill');
  assert.deepEqual(fs.readFileSync(project.sessionPath), postDrain);

  const replayBytes = authority(project);
  const replay = ok(call(project.projectRoot, 'coord.drain-kill-queue',
    drainPayload(project, '01J00000000000000000000109')), 'empty drain');
  assert.equal(replay.applied, 0);
  assert.equal(replay.remaining, 0);
  assert.equal(readJsonl(project.journalPath).filter((event) => event.event === 'seed_killed').length, 1);
  assert.notDeepEqual(authority(project).files.journal, replayBytes.files.journal,
    'an idempotency receipt may be appended for a distinct drain operation');
});

test('two same-operation acknowledgers race to one request state, one queue decision, and one kill event', async (t) => {
  const project = makeProject(t, { label: 'ack race' });
  queueRequest(project, 'request-race');
  const payload = ackPayload(project, 'request-race', 'confirm-kill', '01J00000000000000000000120');
  const script = `
    const runtime = require(${JSON.stringify(RUNTIME)});
    const response = runtime.dispatch(${JSON.stringify({
      schema_version: '1.0', operation: 'coord.ack-user-kill-request',
      context: { project_root: project.projectRoot }, payload,
    })}, { now: () => ${FIXED_NOW} });
    process.stdout.write(JSON.stringify(response));
  `;
  const children = [0, 1].map(() => waitFor(spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })));
  const results = await Promise.all(children);
  const responses = results.map((result) => {
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  assert.equal(responses.every((response) => response.ok), true, JSON.stringify(responses));
  assert.deepEqual(responses.map((response) => response.result.replayed).sort(), [false, true]);
  assert.equal(readJsonl(project.killRequestsPath).length, 1);
  assert.equal(readJsonl(project.killQueuePath).length, 0);
  assert.equal(readJsonl(project.journalPath).filter((event) => event.event === 'seed_killed').length, 1);
});

test('strict drain racing a scheduler append consumes only its snapshot and preserves the append once', async (t) => {
  const project = makeProject(t, { nChosen: 2, totalBudget: 24, label: 'drain append race' });
  ok(call(project.projectRoot, 'coord.queue-kill', {
    session_id: project.sessionId,
    seed_id: 1,
    condition: 'sustained_regression',
    final_q: 0,
    experiments_used: 0,
  }, { randomUUID: () => 'scheduler-before' }), 'queue before drain');
  const payload = drainPayload(project, '01J00000000000000000000121');
  const script = `
    const runtime = require(${JSON.stringify(RUNTIME)});
    const response = runtime.dispatch({
      schema_version: '1.0', operation: 'coord.queue-kill',
      context: { project_root: ${JSON.stringify(project.projectRoot)} },
      payload: {
        session_id: ${JSON.stringify(project.sessionId)}, seed_id: 2,
        condition: 'crash_give_up', final_q: 0, experiments_used: 0,
      },
    }, { now: () => ${FIXED_NOW}, randomUUID: () => 'scheduler-concurrent' });
    process.stdout.write(JSON.stringify(response));
  `;
  let child;
  const result = call(project.projectRoot, 'coord.drain-kill-queue', payload, {
    onTransitionPhase(phase) {
      if (!child && phase.includes('after-stage:') && phase.endsWith('/journal.jsonl')) {
        child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const appended = await waitFor(child);
  assert.equal(appended.code, 0, appended.stderr);
  assert.equal(JSON.parse(appended.stdout).ok, true, appended.stdout);
  assert.deepEqual(readJsonl(project.killQueuePath).map((entry) => entry.entry_id),
    ['scheduler-concurrent']);
  const kills = readJsonl(project.journalPath).filter((event) => event.event === 'seed_killed');
  assert.deepEqual(kills.map((event) => [event.kill_entry_id, event.seed_id, event.source]),
    [['scheduler-before', 1, 'scheduler']]);
});

test('stale CAS and queue snapshot mismatches fail closed across all five authority files', (t) => {
  const project = makeProject(t, { label: 'stale authorities' });
  queueRequest(project, 'request-stale');
  const payload = ackPayload(project, 'request-stale', 'confirm-kill', '01J00000000000000000000130');
  fs.appendFileSync(project.forumPath, '{"event":"note"}\n');
  const before = authority(project);
  const stale = call(project.projectRoot, 'coord.ack-user-kill-request', payload);
  assert.equal(stale.exitCode, 1, JSON.stringify(stale));
  assert.equal(stale.error.code, 'stale_preimage');
  assertAuthority(project, before, 'stale forum');

  const queued = makeProject(t, { label: 'forged queue snapshot' });
  queueRequest(queued, 'request-queue');
  scheduleInFlight(queued);
  ok(call(queued.projectRoot, 'coord.ack-user-kill-request',
    ackPayload(queued, 'request-queue', 'confirm-kill', '01J00000000000000000000131')), 'queue ack');
  finishInFlight(queued);
  const rows = readJsonl(queued.killQueuePath);
  rows[0].final_q = 99;
  writeJsonl(queued.killQueuePath, rows);
  const queueBefore = authority(queued);
  const response = call(queued.projectRoot, 'coord.drain-kill-queue',
    drainPayload(queued, '01J00000000000000000000132'));
  assert.equal(response.exitCode, 2, JSON.stringify(response));
  assertAuthority(queued, queueBefore, 'forged queue snapshot');
});

test('ack transaction crash cutpoints recover to the complete pre-state or complete post-state', (t) => {
  const cutpointsFor = (project) => {
    const sessionRelative = path.relative(project.stateRoot, project.sessionRoot)
      .split(path.sep).join('/');
    return [
    `after-stage:${sessionRelative}/session.yaml`,
    `after-stage:${sessionRelative}/journal.jsonl`,
    `after-stage:${sessionRelative}/kill_queue.jsonl`,
    `after-stage:${sessionRelative}/kill_requests.jsonl`,
    'after-transaction',
    'after-commit-marker',
    `after-install:${sessionRelative}/session.yaml`,
    `after-install:${sessionRelative}/journal.jsonl`,
    `after-install:${sessionRelative}/kill_queue.jsonl`,
    `after-install:${sessionRelative}/kill_requests.jsonl`,
    ];
  };
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const project = makeProject(t, { label: `crash ${index}` });
    queueRequest(project, `request-crash-${index}`);
    if (index === 8) scheduleInFlight(project);
    const payload = ackPayload(project, `request-crash-${index}`, 'confirm-kill',
      `01J${String(300 + index).padStart(23, '0')}`);
    const cutpoint = cutpointsFor(project)[index];
    const script = `
      const runtime = require(${JSON.stringify(RUNTIME)});
      runtime.dispatch(${JSON.stringify({
        schema_version: '1.0', operation: 'coord.ack-user-kill-request',
        context: { project_root: project.projectRoot }, payload,
      })}, { now: () => ${FIXED_NOW}, crashAt: ${JSON.stringify(cutpoint)} });
    `;
    const crashed = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(crashed.status, 86, `${cutpoint}: ${crashed.stderr}`);
    const recovered = call(project.projectRoot, 'coord.list-user-kill-requests', {
      session_id: project.sessionId,
    });
    assert.equal(recovered.ok, true, `${cutpoint}: ${JSON.stringify(recovered)}`);
    const requests = readJsonl(project.killRequestsPath);
    const kills = readJsonl(project.journalPath).filter((event) => event.event === 'seed_killed');
    const queue = readJsonl(project.killQueuePath);
    const seed = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8')).virtual_parallel.seeds[0];
    const completePre = requests[0].acknowledged_at === null && kills.length === 0
      && queue.length === 0 && seed.status === 'active';
    const completePost = requests[0].choice_id === 'confirm-kill'
      && ((kills.length === 1 && queue.length === 0 && seed.status === 'killed:user_requested')
        || (kills.length === 0 && queue.length === 1 && seed.status === 'active'));
    assert.equal(completePre || completePost, true, `${cutpoint}: mixed recovered state`);
  }
});

test('win32 transient rename sharing failures retry, while directory open/fsync is never required', (t) => {
  const project = makeProject(t, { label: 'win32 ack' });
  queueRequest(project, 'request-win32');
  const io = Object.create(fs);
  let failures = 2;
  let directoryOpens = 0;
  io.renameSync = (...args) => {
    if (failures > 0) {
      failures -= 1;
      throw Object.assign(new Error('sharing violation'), { code: failures === 1 ? 'EPERM' : 'EACCES' });
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
  const response = call(project.projectRoot, 'coord.ack-user-kill-request',
    ackPayload(project, 'request-win32', 'confirm-kill', '01J00000000000000000000140'), {
      platform: 'win32', io, sleep: () => {},
    });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(failures, 0);
  assert.equal(directoryOpens, 0);
  assert.equal(readJsonl(project.journalPath).filter((event) => event.event === 'seed_killed').length, 1);
});

test('canonical drain rejects the completed_seed_id legacy field and requires exact kill authority CAS', (t) => {
  const project = makeProject(t, { label: 'canonical drain payload' });
  const before = authority(project);
  const legacy = call(project.projectRoot, 'coord.drain-kill-queue', {
    session_id: project.sessionId, completed_seed_id: 1,
  });
  assert.equal(legacy.exitCode, 2, JSON.stringify(legacy));
  assertAuthority(project, before, 'legacy completed_seed_id');

  const missing = call(project.projectRoot, 'coord.drain-kill-queue', {
    session_id: project.sessionId,
    operation_id: FIXTURE.operation_ids.drain,
  });
  assert.equal(missing.exitCode, 2, JSON.stringify(missing));
  assertAuthority(project, before, 'missing digest');
});

test('fixture remains internally exact and exhaustive for user choices and kill conditions', () => {
  assert.deepEqual(FIXTURE.choices, ['confirm-kill', 'keep-seed']);
  assert.equal(FIXTURE.invalid_choices.includes('stop'), true);
  assert.deepEqual(FIXTURE.conditions, [
    'crash_give_up', 'sustained_regression', 'shortcut_quarantine',
    'budget_exhausted_underperform', 'user_requested',
  ]);
  assert.equal(RESULTS_HEADER.endsWith('\n'), true);
});
