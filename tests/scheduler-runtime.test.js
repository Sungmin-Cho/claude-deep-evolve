'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  entropy,
  migrateV2Weights,
  countFlagged,
  retryBudget,
  initBudgetSplit,
  growAllocation,
  collectSchedulerSignals,
  decideScheduler,
  evaluateKillConditions,
  borrowPreflight,
  findBorrowAbandoned,
  classifyConvergence,
} = require('../hooks/scripts/runtime/scheduler.cjs');
const { parseStateDocument } = require('../hooks/scripts/runtime/session-codec.cjs');
const { OPERATIONS, LEGACY_ROUTES, dispatch } = require('../hooks/scripts/deep-evolve-runtime.cjs');

const FIXTURES = path.join(__dirname, 'fixtures', 'runtime');
const schedulerCases = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'scheduler-cases.json')));
const borrowCases = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'borrow-cases.json')));
const killCases = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'kill-cases.json')));

function expectRuntimeError(fn, expectedRc, fragment) {
  assert.throws(fn, (error) => {
    assert.equal(error.rc, expectedRc);
    assert.match(error.message, new RegExp(fragment, 'i'));
    return true;
  });
}

function mergeDeep(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeDeep(base[key] || {}, value)
      : value;
  }
  return result;
}

function baseKillPayload() {
  return {
    seed: {
      id: 1,
      experiments_used: 2,
      current_q: 0.5,
      q_history: [0.5],
      evaluated_events: [],
      flagged_keeps_count: 0,
      diagnosed_gave_up_experiment_count: 0,
      budget_remaining: 5,
    },
    session: { median_q: 0.4, std_q: 0.05, shortcut_quarantine_threshold: 3 },
    ai_judgments: { direction_unrecoverable: false, shortcut_prone: false },
    user_kill_request: null,
  };
}

test('frozen metric golden rows preserve Python oracle outputs', () => {
  for (const row of schedulerCases.entropy) {
    assert.deepEqual(entropy(row.events, row.window_size), row.expected, row.name);
  }
  for (const row of schedulerCases.weights) {
    const actual = migrateV2Weights(row.input);
    assert.equal(actual.pre_normalize_sum, row.pre_normalize_sum, row.name);
    assert.equal(Object.keys(actual.weights).length, 10, row.name);
    assert.ok(Math.abs(Object.values(actual.weights).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  }
  for (const row of schedulerCases.count_flagged) {
    assert.deepEqual(countFlagged(row.events), row.expected, row.name);
  }
  for (const row of schedulerCases.retry_budget) {
    assert.deepEqual(retryBudget(row.events, row.cap), row.expected, row.name);
  }
});

test('budget allocation preserves last-seed remainder and rc 1/2 boundary', () => {
  for (const row of schedulerCases.init_budget) {
    if (row.rc) expectRuntimeError(() => initBudgetSplit(row.total, row.n), row.rc, row.error);
    else assert.deepEqual(initBudgetSplit(row.total, row.n), row.expected, row.name);
  }
  for (const row of schedulerCases.grow_budget) {
    if (row.rc) expectRuntimeError(() => growAllocation(row.pool, row.n_current), row.rc, row.error);
    else assert.equal(growAllocation(row.pool, row.n_current), row.expected, row.name);
  }
});

test('scheduler decisions preserve enums, clamp ties, floors, fairness, and kill deferral', () => {
  for (const row of schedulerCases.decisions) {
    if (row.rc === 2) {
      expectRuntimeError(() => decideScheduler(row.input), row.rc, row.error);
      continue;
    }
    const actual = decideScheduler(row.input);
    assert.equal(actual.accepted, row.accepted, row.name);
    if (row.block_size !== undefined) assert.equal(actual.block_size, row.block_size, row.name);
    if (row.clamped !== undefined) assert.equal(actual.clamped, row.clamped, row.name);
    if (row.error) assert.match(actual.reason, new RegExp(row.error, 'i'), row.name);
  }

  const decision = {
    decision: 'kill_then_schedule', kill_target: 2, chosen_seed_id: 1,
    block_size: 3, reasoning: 'kill', signals_used: [],
  };
  const signals = {
    schedulable_seed_ids: [1, 2, 3],
    seeds: [
      { id: 1, status: 'active', experiments_used_this_epoch: 1 },
      { id: 2, status: 'active', experiments_used_this_epoch: 1, in_flight_block: true },
      { id: 3, status: 'active', experiments_used_this_epoch: 0 },
    ],
  };
  const actual = decideScheduler(decision, signals);
  assert.equal(actual.fairness_violation, true);
  assert.deepEqual(actual.starved_seed_ids, [3]);
  assert.equal(actual.kill_deferred, true);

  const terminal = { ...signals, schedulable_seed_ids: [] };
  const rejected = decideScheduler({ ...decision, decision: 'schedule' }, terminal);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.rc, 1);
});

test('scheduler signals preserve N/n_current, id/seed_id, canonical zero, trends, and in-flight state', () => {
  for (const row of schedulerCases.signals) {
    const actual = collectSchedulerSignals(row.session, row.journal, row.forum);
    for (const [key, value] of Object.entries(row.expected)) assert.deepEqual(actual[key], value, `${row.name}: ${key}`);
  }
  const actual = collectSchedulerSignals(
    schedulerCases.signals[0].session,
    schedulerCases.signals[0].journal,
    schedulerCases.signals[0].forum,
  );
  assert.equal(actual.seeds[0].recent_Q_trend, 'up');
  assert.equal(actual.seeds[1].independent_exploration_satisfied, false);
  assert.equal(actual.seeds[1].in_flight_block, true);
  assert.equal(actual.seeds[1].experiments_used_this_epoch, 0);

  expectRuntimeError(() => collectSchedulerSignals({
    virtual_parallel: { n_current: 2, seeds: [{ id: 1, seed_id: 2, status: 'active' }] },
  }, [], []), 2, 'conflict');
  expectRuntimeError(() => collectSchedulerSignals({
    virtual_parallel: { n_current: 2, seeds: [{ id: true, status: 'active' }] },
  }, [], []), 2, 'integral');
});

test('all borrow preflight and abandonment oracle rows are frozen', () => {
  for (const row of borrowCases.preflight) {
    if (row.rc) {
      expectRuntimeError(() => borrowPreflight(row.input), row.rc, row.error);
      continue;
    }
    const actual = borrowPreflight(row.input);
    assert.equal(actual.eligible.length, row.eligible, row.name);
    if (row.p3_gate_open !== undefined) assert.equal(actual.p3_gate_open, row.p3_gate_open, row.name);
    if (row.reason) assert.equal(actual.skipped[0].reason, row.reason, row.name);
  }
  for (const row of borrowCases.abandoned) {
    const actual = findBorrowAbandoned(row.events, row.current_block_id, 2);
    assert.equal(actual.abandoned_events.length, row.expected, row.name);
    if (row.planned !== undefined) {
      assert.equal(actual.abandoned_events[0].originally_planned_at_block, row.planned);
      assert.equal(actual.abandoned_events[0].detected_at_block, row.current_block_id);
    }
  }
});

test('convergence golden rows preserve threshold, P3, ancestry, and transitive union-find', () => {
  for (const row of schedulerCases.convergence) {
    if (row.rc) {
      expectRuntimeError(() => classifyConvergence(row.input), row.rc, row.error);
      continue;
    }
    const actual = classifyConvergence(row.input);
    if (row.judged === null) {
      assert.deepEqual(actual.convergence_events, [], row.name);
      continue;
    }
    assert.equal(actual.convergence_events[0].judged_as, row.judged, row.name);
    if (row.ancestor) assert.ok(actual.convergence_events[0].shared_ancestors.includes(row.ancestor), row.name);
    if (row.seed_ids) assert.deepEqual(actual.convergence_events[0].seed_ids, row.seed_ids, row.name);
  }
});

test('kill condition rows preserve order, thresholds, canonical ints, and bool rejection', () => {
  for (const row of killCases.conditions) {
    const payload = mergeDeep(baseKillPayload(), row.overrides);
    if (row.rc) {
      expectRuntimeError(() => evaluateKillConditions(payload), row.rc, row.error);
      continue;
    }
    const actual = evaluateKillConditions(payload);
    assert.deepEqual(actual.conditions_met, row.conditions, row.name);
    assert.equal(actual.killable, row.conditions.length > 0, row.name);
    assert.equal(actual.seed_id, row.seed_id || 1, row.name);
  }
});

test('all four legacy kill fixtures preserve N, pool, and seed identity aliases', () => {
  for (const row of killCases.legacy_fixtures) {
    const file = path.join(FIXTURES, 'legacy', 'kill', row.name, 'session.yaml');
    const session = parseStateDocument(fs.readFileSync(file, 'utf8'), { sourcePath: file });
    assert.equal(session.virtual_parallel.N, row.N, row.name);
    assert.equal(session.virtual_parallel.unallocated_pool, row.pool, row.name);
    const actual = collectSchedulerSignals(session, [], []);
    assert.deepEqual(actual.schedulable_seed_ids, row.seed_ids, row.name);
    assert.equal(actual.n_current, row.N, row.name);
  }
});

test('Task 4 operations remain registered and Task 5 coordination operations are now native', () => {
  const expected = [
    'metrics.entropy', 'metrics.migrate-v2-weights', 'metrics.count-flagged',
    'metrics.retry-budget', 'metrics.init-budget-split', 'metrics.grow-allocation',
    'scheduler.signals', 'scheduler.decide', 'scheduler.kill-conditions',
    'scheduler.borrow-preflight', 'scheduler.borrow-abandoned', 'scheduler.classify-convergence',
    'coord.append-journal', 'coord.append-forum', 'coord.tail-forum',
    'coord.quarantine-malformed', 'coord.queue-user-kill', 'coord.queue-kill',
    'coord.drain-kill-queue',
  ];
  for (const operation of expected) assert.ok(OPERATIONS.includes(operation), operation);
  for (const operation of ['coord.build-seed-prompt', 'coord.write-seed-program', 'coord.status']) {
    assert.equal(OPERATIONS.includes(operation), true, operation);
  }
  for (const arm of [
    'entropy_compute', 'migrate_v2_weights', 'count_flagged_since_last_expansion',
    'retry_budget_remaining', 'compute_init_budget_split', 'compute_grow_allocation',
    'append_forum_event', 'tail_forum', 'append_journal_event',
    'append_kill_queue_entry', 'drain_kill_queue',
  ]) assert.equal(LEGACY_ROUTES[arm], 'native', arm);
});

test('dispatcher metrics and scheduler operations preserve rc 0/1/2 envelopes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-scheduler-dispatch-'));
  const request = (operation, payload) => dispatch({
    schema_version: '1.0', operation, context: { project_root: root }, payload,
  });
  const ok = request('metrics.init-budget-split', { total: 14, n: 3 });
  assert.equal(ok.exitCode, 0);
  assert.deepEqual(ok.result.allocations, [4, 5, 5]);
  const rejected = request('metrics.grow-allocation', { pool: 2, n_current: 3 });
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.ok, false);
  const invalid = request('scheduler.decide', {
    decision: { decision: 'schedule', chosen_seed_id: true, block_size: 3, reasoning: 'x', signals_used: [] },
  });
  assert.equal(invalid.exitCode, 2);
  assert.equal(invalid.ok, false);
});

test('every Task 4 metric and scheduler operation executes through the dispatcher', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-task4-dispatch-all-'));
  const state = path.join(root, '.deep-evolve', 's1');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'session.yaml'), `${JSON.stringify({
    session_id: 's1',
    virtual_parallel: {
      n_current: 1,
      budget_unallocated: 3,
      seeds: [{ id: 1, status: 'active', experiments_used: 3, allocated_budget: 6 }],
    },
  })}\n`);
  const call = (operation, payload) => dispatch({
    schema_version: '1.0', operation, context: { project_root: root }, payload,
  });
  const calls = [
    ['metrics.entropy', { events: [], window_size: 20 }],
    ['metrics.migrate-v2-weights', { weights: {} }],
    ['metrics.count-flagged', { events: [] }],
    ['metrics.retry-budget', { events: [], cap: 10 }],
    ['metrics.init-budget-split', { total: 9, n: 3 }],
    ['metrics.grow-allocation', { pool: 3, n_current: 1 }],
    ['scheduler.signals', { session_id: 's1' }],
    ['scheduler.decide', { decision: { decision: 'schedule', chosen_seed_id: 1, block_size: 3, reasoning: 'x', signals_used: [] } }],
    ['scheduler.kill-conditions', baseKillPayload()],
    ['scheduler.borrow-preflight', { self_seed_id: 1, self_experiments_used: 3, candidates: [], journal: [], forum: [] }],
    ['scheduler.borrow-abandoned', { events: [], current_block_id: 2 }],
    ['scheduler.classify-convergence', { keeps: [], similarities: [], inspired_by_map: {}, cross_seed_borrow_events: [] }],
  ];
  try {
    for (const [operation, payload] of calls) {
      const response = call(operation, payload);
      assert.equal(response.exitCode, 0, `${operation}: ${JSON.stringify(response)}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('supported Node scheduler module never imports or spawns Python', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'scripts', 'runtime', 'scheduler.cjs'), 'utf8');
  assert.doesNotMatch(source, /python|spawnSync|execFileSync|child_process/i);
});
