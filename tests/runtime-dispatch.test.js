'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNTIME = path.resolve(__dirname, '..', 'hooks', 'scripts', 'deep-evolve-runtime.cjs');
const START_FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'session-start-v3.5.json'),
  'utf8',
));
const {
  OPERATIONS,
  LEGACY_ROUTES,
  RUNTIME_VERSION,
  dispatch,
  main,
} = require(RUNTIME);

const TASK4_OPERATIONS = [
  'session.resolve-current',
  'session.read',
  'session.list',
  'session.start',
  'session.mark-status',
  'session.migrate-legacy',
  'session.check-alignment',
  'session.detect-orphan',
  'session.append-local-archive',
  'session.render-inherited-context',
  'session.lineage-tree',
  'session.patch',
  'session.record-baseline',
  'session.finish-experiment',
  'session.record-evaluator-expansion',
  'session.complete',
  'virtual.init',
  'virtual.append-seed',
  'virtual.rebuild-seeds',
  'virtual.set-field',
  'metrics.entropy',
  'metrics.migrate-v2-weights',
  'metrics.count-flagged',
  'metrics.retry-budget',
  'metrics.init-budget-split',
  'metrics.grow-allocation',
  'coord.append-journal',
  'coord.append-forum',
  'coord.tail-forum',
  'coord.quarantine-malformed',
  'coord.queue-user-kill',
  'coord.queue-kill',
  'coord.list-user-kill-requests',
  'coord.ack-user-kill-request',
  'coord.drain-kill-queue',
  'coord.begin-seed-block',
  'coord.finish-seed-block',
  'coord.advance-epoch',
  'scheduler.signals',
  'scheduler.decide',
  'scheduler.kill-conditions',
  'scheduler.borrow-preflight',
  'scheduler.borrow-abandoned',
  'scheduler.classify-convergence',
  'coord.build-seed-prompt',
  'coord.write-seed-program',
  'coord.status',
  'worktree.create-seed',
  'worktree.validate-seed',
  'worktree.remove-seed',
  'worktree.create-synthesis',
  'worktree.cleanup-failed-synthesis',
  'archive.backtrack',
  'archive.save-strategy',
  'archive.restore-strategy',
  'archive.fork-strategy',
  'synthesis.process-beta',
  'synthesis.select-baseline',
  'synthesis.forum-summary',
  'synthesis.cross-seed-audit',
  'synthesis.write-fallback-note',
  'synthesis.collect',
  'synthesis.finalize',
  'transfer.lookup',
  'transfer.record',
  'transfer.prune',
  'transfer.export-feedback',
  'artifact.wrap-receipt',
  'artifact.wrap-insights',
  'artifact.emit-compaction',
  'artifact.emit-handoff',
];

const LEGACY_ARMS = [
  'help',
  'compute_session_id',
  'resolve_current',
  'list_sessions',
  'start_new_session',
  'mark_session_status',
  'append_sessions_jsonl',
  'migrate_legacy',
  'check_branch_alignment',
  'detect_orphan_experiment',
  'append_meta_archive_local',
  'render_inherited_context',
  'lineage_tree',
  'entropy_compute',
  'migrate_v2_weights',
  'count_flagged_since_last_expansion',
  'retry_budget_remaining',
  'resolve_helper_path',
  'create_seed_worktree',
  'validate_seed_worktree',
  'remove_seed_worktree',
  'append_seed_to_session_yaml',
  'set_virtual_parallel_field',
  'init_virtual_parallel_block',
  'rebuild_seeds_from_journal',
  'compute_init_budget_split',
  'compute_grow_allocation',
  'append_forum_event',
  'tail_forum',
  'append_journal_event',
  'append_kill_queue_entry',
  'drain_kill_queue',
  'create_synthesis_worktree',
  'cleanup_failed_synthesis_worktree',
];

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-dispatch-'));
  fs.mkdirSync(path.join(root, '.deep-evolve', '.runtime-requests'), { recursive: true });
  return fs.realpathSync(root);
}

function bareTempDirectory(label = 'evolve-dispatch-bare-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), label)));
}

function request(projectRoot, operation = 'session.list', payload = {}) {
  return {
    schema_version: '1.0',
    operation,
    context: { project_root: projectRoot },
    payload,
  };
}

function runRequest(requestPath, cwd) {
  return spawnSync(process.execPath, [RUNTIME, '--request', requestPath], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function parseSingleResponse(result) {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1, result.stdout);
  return JSON.parse(result.stdout);
}

function captureMain(argv, dependencies = {}) {
  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, ...args) => {
    stdout += String(chunk);
    const callback = args.find((value) => typeof value === 'function');
    if (callback) callback();
    return true;
  };
  try {
    const status = main(argv, dependencies);
    return { status, stdout, response: JSON.parse(stdout) };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test('exports the immutable Prerequisite 4 registry and runtime version without later operations', () => {
  const task6HarnessOperations = [
    'harness.generate',
    'harness.migrate-legacy',
    'harness.run',
    'harness.write-baseline',
  ];
  assert.deepEqual([...OPERATIONS].sort(), [...TASK4_OPERATIONS, ...task6HarnessOperations].sort());
  assert.equal(Object.isFrozen(OPERATIONS), true);
  assert.throws(() => OPERATIONS.push('metrics.entropy'), TypeError);
  assert.equal(RUNTIME_VERSION, require('../package.json').version);
});

test('session.read returns the exact canonical session digest without mutating authority', () => {
  const root = tempProject();
  try {
    const started = dispatch(request(root, 'session.start', {
      goal: 'digest read',
      initial_state: structuredClone(START_FIXTURE.initial_state),
    }), { now: () => Date.parse('2026-07-13T16:00:00Z') });
    assert.equal(started.ok, true, JSON.stringify(started));
    const sessionPath = path.join(fs.realpathSync(started.result.session_root), 'session.yaml');
    const before = fs.readFileSync(sessionPath);
    const read = dispatch(request(root, 'session.read', { session_id: started.result.session_id }));
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.deepEqual(Object.keys(read.result).sort(), ['session', 'session_sha256']);
    assert.equal(read.result.session_sha256,
      `sha256:${require('node:crypto').createHash('sha256').update(before).digest('hex')}`);
    assert.deepEqual(fs.readFileSync(sessionPath), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('seed dispatch owns the exact five-field payload before canonical authority lookup', () => {
  const root = tempProject();
  try {
    const started = dispatch(request(root, 'session.start', {
      goal: 'seed dispatch payload',
      initial_state: structuredClone(START_FIXTURE.initial_state),
    }), { now: () => Date.parse('2026-07-14T00:00:00Z') });
    assert.equal(started.ok, true, JSON.stringify(started));
    const payload = {
      session_id: started.result.session_id,
      seed_id: 1,
      block_id: 'block-missing-seed',
      decision_id: 'decision-missing-seed',
      n_block: 1,
    };
    const missing = dispatch(request(root, 'coord.build-seed-prompt', payload));
    assert.equal(missing.exitCode, 1, JSON.stringify(missing));
    assert.equal(missing.error.code, 'seed_not_found');

    for (const [field, value] of [
      ['worktree_path', '/caller/worktree'],
      ['branch', 'caller/branch'],
      ['helper_path', '/caller/helper'],
      ['session_root', '/caller/session'],
      ['project_root', '/caller/project'],
    ]) {
      const rejected = dispatch(request(root, 'coord.build-seed-prompt', {
        ...payload, [field]: value,
      }));
      assert.equal(rejected.exitCode, 2, `${field}: ${JSON.stringify(rejected)}`);
      assert.equal(rejected.error.code, 'unknown_payload_field');
    }

    for (const nBlock of [0, -1, true, false]) {
      const rejected = dispatch(request(root, 'coord.build-seed-prompt', {
        ...payload, n_block: nBlock,
      }));
      assert.equal(rejected.exitCode, 2, `${String(nBlock)}: ${JSON.stringify(rejected)}`);
      assert.equal(rejected.error.code, 'invalid_field_type');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Task 4 active protocols route retired scheduling oracles through exact dispatcher operations', () => {
  const protocols = path.resolve(__dirname, '..', 'skills', 'deep-evolve-workflow', 'protocols');
  const routes = [
    ['coordinator.md', 'scheduler-signals.py', 'scheduler.signals'],
    ['coordinator.md', 'scheduler-decide.py', 'scheduler.decide'],
    ['coordinator.md', 'borrow-abandoned-scan.py', 'scheduler.borrow-abandoned'],
    ['outer-loop.md', 'convergence-detect.py', 'scheduler.classify-convergence'],
    ['inner-loop.md', 'borrow-preflight.py', 'scheduler.borrow-preflight'],
  ];
  const retired = [...routes.map(([, oracle]) => oracle), 'kill-conditions.py'];
  const activeFiles = fs.readdirSync(protocols)
    .filter((name) => name.endsWith('.md'))
    .map((name) => [name, fs.readFileSync(path.join(protocols, name), 'utf8')]);
  const activeText = activeFiles.map(([, text]) => text).join('\n');

  for (const oracle of retired) {
    assert.doesNotMatch(activeText, new RegExp(oracle.replace('.', '\\.'), 'g'), oracle);
  }
  for (const [file, , operation] of routes) {
    assert.equal(OPERATIONS.includes(operation), true, operation);
    const source = fs.readFileSync(path.join(protocols, file), 'utf8');
    assert.match(source, new RegExp(`runtime-op:\\s*${operation.replace('.', '\\.')}(?:\\s|\x60|$)`), `${file} must route ${operation}`);
    assert.match(source, /deep-evolve-runtime\.cjs/, `${file} must invoke the packaged Node dispatcher`);
  }

  const packaged = JSON.stringify(require('../package.json').files);
  for (const oracle of retired) assert.doesNotMatch(packaged, new RegExp(oracle.replace('.', '\\.')));
});

test('packaged artifact workflows bind D0 and D1 around immutable runtime publication', () => {
  const protocols = path.resolve(__dirname, '..', 'skills', 'deep-evolve-workflow', 'protocols');
  const completion = fs.readFileSync(path.join(protocols, 'completion.md'), 'utf8');
  const transfer = fs.readFileSync(path.join(protocols, 'transfer.md'), 'utf8');
  const history = fs.readFileSync(path.join(protocols, 'history.md'), 'utf8');
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
    assert.equal(completion.split(anchor).length - 1, 1, `${anchor} must occur exactly once`);
    const offset = completion.indexOf(anchor);
    assert.ok(offset > prior, `${anchor} is out of lifecycle order`);
    prior = offset;
  }
  const beforeD1 = completion.slice(0,
    completion.indexOf('completion-order: session-complete-d0-to-d1'));
  const afterD1 = completion.slice(
    completion.indexOf('completion-order: session-complete-d0-to-d1'));
  for (const operation of [
    'artifact.wrap-receipt',
    'artifact.emit-compaction',
    'artifact.emit-handoff',
    'session.complete',
  ]) {
    assert.match(beforeD1, new RegExp(`runtime-op:\\s*${operation.replace('.', '\\.')}\\b`));
  }
  assert.match(beforeD1, /expected_session_sha256:\s*D0/g);
  assert.match(afterD1, /runtime-op:\s*session\.append-local-archive\b/);
  assert.match(afterD1, /D1 returned by that exact session\.complete response/);
  assert.doesNotMatch(afterD1, /expected_session_sha256:\s*D0/);
  assert.match(completion, /stale_preimage[^\n]*fatal/i);
  assert.match(completion, /warning-only[^\n]*never[^\n]*stale_preimage/i);
  assert.match(completion, /outcome === ['"]discarded['"]/);
  assert.match(completion, /final_ref = `refs\/heads\/\$\{final_branch\}`/);
  assert.match(completion, /\['update-ref', '-d', final_ref, final_commit\]/);
  assert.match(completion, /shell:\s*false/);
  assert.match(completion, /invocation_count === 1/);
  assert.match(completion, /response loss[^\n]*read-only/i);
  assert.doesNotMatch(completion, /git\s+branch\s+-[dD]\b/);
  assert.doesNotMatch(completion, /\.payload\.outcome\s*=/);
  assert.doesNotMatch(completion, /--output\b/);
  assert.doesNotMatch(completion, /node\s+[^\n]*(?:wrap-evolve-envelope|emit-compaction-state|emit-handoff)\.js/);

  assert.match(transfer, /runtime-op:\s*transfer\.export-feedback\b/);
  assert.match(transfer, /publication_id/);
  assert.match(transfer, /expected_session_sha256/);
  assert.doesNotMatch(transfer, /--output\b/);
  assert.doesNotMatch(transfer, /node\s+[^\n]*wrap-evolve-envelope\.js/);
  assert.doesNotMatch(transfer, /\$SESSION_ROOT\/evolve-insights\.json/);

  assert.match(history, /runtime-op:\s*session\.read\b/);
  assert.match(history, /completion\.receipt\.relative_path/);
  assert.match(history, /completion\.receipt\.sha256/);
  assert.match(history, /strict[^\n]*never[^\n]*evolve-receipt\.json/i);
  assert.match(history, /below v3\.5[^\n]*evolve-receipt\.json/i);
});

test('discard cleanup uses one expected-old update-ref CAS and preserves a moved ref', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-discard-cas-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (args) => spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(run(['init', '-q', '-b', 'main']).status, 0);
  assert.equal(run(['config', 'user.email', 'cas@example.invalid']).status, 0);
  assert.equal(run(['config', 'user.name', 'CAS Test']).status, 0);
  fs.writeFileSync(path.join(root, 'value.txt'), 'A\n');
  assert.equal(run(['add', 'value.txt']).status, 0);
  assert.equal(run(['commit', '-qm', 'A']).status, 0);
  const expected = run(['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(run(['branch', 'evolve/exact', expected]).status, 0);
  assert.equal(run(['branch', 'evolve/moved', expected]).status, 0);
  assert.equal(run(['branch', 'evolve/lost-response', expected]).status, 0);
  fs.writeFileSync(path.join(root, 'value.txt'), 'B\n');
  assert.equal(run(['add', 'value.txt']).status, 0);
  assert.equal(run(['commit', '-qm', 'B']).status, 0);
  const replacement = run(['rev-parse', 'HEAD']).stdout.trim();

  const movedRef = 'refs/heads/evolve/moved';
  assert.equal(run(['update-ref', movedRef, replacement, expected]).status, 0);
  const movedDelete = run(['update-ref', '-d', movedRef, expected]);
  assert.notEqual(movedDelete.status, 0);
  assert.equal(run(['rev-parse', '--verify', movedRef]).stdout.trim(), replacement);

  const exactRef = 'refs/heads/evolve/exact';
  const exactDelete = run(['update-ref', '-d', exactRef, expected]);
  assert.equal(exactDelete.status, 0, exactDelete.stderr);
  assert.notEqual(run(['rev-parse', '--verify', exactRef]).status, 0);

  const responseLossRef = 'refs/heads/evolve/lost-response';
  let invocationCount = 0;
  const ambiguousResponse = (() => {
    invocationCount += 1;
    run(['update-ref', '-d', responseLossRef, expected]);
    return { status: null, signal: 'SIGKILL', stdout: '', stderr: '' };
  })();
  assert.equal(ambiguousResponse.status, null);
  assert.equal(invocationCount, 1);
  assert.notEqual(run(['rev-parse', '--verify', responseLossRef]).status, 0);
  assert.equal(invocationCount, 1, 'response-loss adoption must not mutate twice');
});

test('routes all 33 legacy subcommands plus help through native arms', () => {
  assert.deepEqual(Object.keys(LEGACY_ROUTES).sort(), [...LEGACY_ARMS].sort());
  assert.equal(Object.isFrozen(LEGACY_ROUTES), true);
  for (const arm of LEGACY_ARMS) {
    assert.match(LEGACY_ROUTES[arm], /^(?:native|legacy)$/);
  }
  for (const arm of [
    'resolve_current',
    'resolve_helper_path',
    'append_seed_to_session_yaml',
    'set_virtual_parallel_field',
    'init_virtual_parallel_block',
    'rebuild_seeds_from_journal',
    'migrate_v2_weights',
    'compute_init_budget_split',
    'append_forum_event',
    'create_seed_worktree',
    'validate_seed_worktree',
    'remove_seed_worktree',
    'create_synthesis_worktree',
    'cleanup_failed_synthesis_worktree',
  ]) {
    assert.equal(LEGACY_ROUTES[arm], 'native');
  }
});

test('the compatibility split is exactly 34 native arms and no retained-oracle routes', () => {
  const native = LEGACY_ARMS.filter((arm) => LEGACY_ROUTES[arm] === 'native');
  const deferred = LEGACY_ARMS.filter((arm) => LEGACY_ROUTES[arm] === 'legacy');
  assert.deepEqual(native, [
    'help',
    'compute_session_id',
    'resolve_current',
    'list_sessions',
    'start_new_session',
    'mark_session_status',
    'append_sessions_jsonl',
    'migrate_legacy',
    'check_branch_alignment',
    'detect_orphan_experiment',
    'append_meta_archive_local',
    'render_inherited_context',
    'lineage_tree',
    'entropy_compute',
    'migrate_v2_weights',
    'count_flagged_since_last_expansion',
    'retry_budget_remaining',
    'resolve_helper_path',
    'create_seed_worktree',
    'validate_seed_worktree',
    'remove_seed_worktree',
    'append_seed_to_session_yaml',
    'set_virtual_parallel_field',
    'init_virtual_parallel_block',
    'rebuild_seeds_from_journal',
    'compute_init_budget_split',
    'compute_grow_allocation',
    'append_forum_event',
    'tail_forum',
    'append_journal_event',
    'append_kill_queue_entry',
    'drain_kill_queue',
    'create_synthesis_worktree',
    'cleanup_failed_synthesis_worktree',
  ]);
  assert.deepEqual(deferred, []);
});

test('rejects malformed, prototype-bearing, and unknown request fields', () => {
  const root = tempProject();
  try {
    const cases = [
      null,
      [],
      { schema_version: '1.0', operation: 'session.list', context: { project_root: root } },
      { ...request(root), extra: true },
      { ...request(root), schema_version: '2.0' },
      { ...request(root), context: [] },
      { ...request(root), payload: [] },
    ];
    for (const value of cases) {
      const response = dispatch(value);
      assert.equal(response.ok, false, JSON.stringify(value));
      assert.equal(response.exitCode, 2);
      assert.match(response.error.code, /request|schema|field|object/);
    }

    const inheritedRoot = Object.assign(Object.create({ inherited: true }), request(root));
    assert.equal(dispatch(inheritedRoot).ok, false);

    const inheritedPayload = Object.create({ polluted: true });
    const nested = request(root);
    nested.payload = inheritedPayload;
    assert.equal(dispatch(nested).ok, false);

    const nullPrototypeContext = Object.assign(Object.create(null), { project_root: root });
    const nullPrototype = request(root);
    nullPrototype.context = nullPrototypeContext;
    assert.equal(dispatch(nullPrototype).ok, false);

    const hiddenExtra = request(root);
    Object.defineProperty(hiddenExtra, 'hidden_extra', { value: true, enumerable: false });
    assert.equal(dispatch(hiddenExtra).ok, false);

    let getterCalls = 0;
    const accessorPayload = {};
    Object.defineProperty(accessorPayload, 'session_id', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 's1';
      },
    });
    const accessorRequest = request(root, 'session.read');
    accessorRequest.payload = accessorPayload;
    assert.equal(dispatch(accessorRequest).ok, false);
    assert.equal(getterCalls, 0, 'validation must reject accessors without invoking them');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical session.start exposes only the required atomic initialization payload', () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'module.exports = 1;\n');
  const initialState = structuredClone(START_FIXTURE.initial_state);
  try {
    const unknown = dispatch(request(root, 'session.start', {
      goal: 'dispatcher start',
      initial_state: initialState,
      caller_session_id: 'forbidden',
    }));
    assert.equal(unknown.ok, false);
    assert.equal(unknown.exitCode, 2);
    assert.equal(unknown.error.code, 'unknown_payload_field');

    const missing = dispatch(request(root, 'session.start', { goal: 'dispatcher start' }));
    assert.equal(missing.ok, false);
    assert.equal(missing.exitCode, 2);
    assert.equal(missing.error.code, 'initial_state_required');
    assert.deepEqual(fs.readdirSync(path.join(root, '.deep-evolve')), ['.runtime-requests'],
      'rejected dispatcher payloads must not reserve or publish a session');

    const started = dispatch(request(root, 'session.start', {
      goal: 'dispatcher start',
      initial_state: initialState,
    }), { now: () => Date.parse('2026-07-13T12:34:56Z') });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.deepEqual(Object.keys(started.result).sort(), [
      'initialization_id', 'replayed', 'session', 'session_id', 'session_root', 'session_sha256',
    ]);
    assert.equal(started.result.initialization_id, initialState.initialization_id);
    assert.equal(started.result.session.status, 'initializing');
    assert.equal(started.result.session.session_id, started.result.session_id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unknown operation is an operator error with one JSON response', () => {
  const root = tempProject();
  const requestPath = path.join(root, 'unknown.json');
  fs.writeFileSync(requestPath, JSON.stringify(request(root, 'session.not-real')));
  try {
    const result = runRequest(requestPath, root);
    assert.equal(result.status, 2, result.stderr);
    const response = parseSingleResponse(result);
    assert.equal(response.ok, false);
    assert.equal(response.operation, 'session.not-real');
    assert.equal(response.error.code, 'unknown_operation');
    assert.equal(fs.existsSync(requestPath), true, 'failed requests must be preserved');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('successful request deletion is limited to the physical runtime request directory', () => {
  const root = tempProject();
  const inside = path.join(root, '.deep-evolve', '.runtime-requests', 'inside.json');
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(inside, JSON.stringify(request(root)));
  fs.writeFileSync(outside, JSON.stringify(request(root)));
  try {
    const insideResult = runRequest(inside, root);
    assert.equal(insideResult.status, 0, insideResult.stderr);
    assert.deepEqual(parseSingleResponse(insideResult).result, { sessions: [] });
    assert.equal(fs.existsSync(inside), false);

    const outsideResult = runRequest(outside, root);
    assert.equal(outsideResult.status, 0, outsideResult.stderr);
    parseSingleResponse(outsideResult);
    assert.equal(fs.existsSync(outside), true, 'outside request must never be deleted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('successful request deletion follows physical project aliases with spaces and Unicode', {
  skip: process.platform === 'win32' ? 'directory symlink creation is privilege-dependent on Windows' : false,
}, () => {
  const outer = bareTempDirectory('evolve-request-alias-');
  const realRoot = path.join(outer, '실제 project with spaces');
  const aliasRoot = path.join(outer, 'alias project');
  fs.mkdirSync(path.join(realRoot, '.deep-evolve', '.runtime-requests'), { recursive: true });
  fs.symlinkSync(realRoot, aliasRoot, 'dir');
  const requestPath = path.join(aliasRoot, '.deep-evolve', '.runtime-requests', '요청 file.json');
  fs.writeFileSync(requestPath, JSON.stringify(request(aliasRoot)));
  try {
    const result = runRequest(requestPath, aliasRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseSingleResponse(result).result, { sessions: [] });
    assert.equal(fs.existsSync(requestPath), false, 'physically contained aliased request must be deleted');
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('request deletion rechecks file identity and preserves a raced replacement', () => {
  const root = tempProject();
  const requestPath = path.join(root, '.deep-evolve', '.runtime-requests', 'replace-race.json');
  const consumedPath = `${requestPath}.consumed`;
  const replacement = Buffer.from('{"replacement":true}\n');
  fs.writeFileSync(requestPath, JSON.stringify(request(root)));
  let hookCalls = 0;
  try {
    const result = captureMain(['--request', requestPath], {
      beforeRequestDelete(candidate) {
        hookCalls += 1;
        assert.equal(candidate, requestPath);
        fs.renameSync(requestPath, consumedPath);
        fs.writeFileSync(requestPath, replacement);
      },
    });
    assert.equal(result.status, 0);
    assert.equal(hookCalls, 1);
    assert.deepEqual(fs.readFileSync(requestPath), replacement);
    assert.equal(result.response.warnings.some((warning) => warning.code === 'request_identity_changed'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('request consumption captures identity before reading and preserves a post-read replacement', () => {
  const root = tempProject();
  const requestPath = path.join(root, '.deep-evolve', '.runtime-requests', 'post-read-race.json');
  const consumedPath = `${requestPath}.consumed-by-test`;
  const replacement = Buffer.from('{"replacement":"after-read"}\n');
  fs.writeFileSync(requestPath, JSON.stringify(request(root)));
  let hookCalls = 0;
  try {
    const result = captureMain(['--request', requestPath], {
      afterRequestRead(candidate) {
        hookCalls += 1;
        assert.equal(candidate, requestPath);
        fs.renameSync(requestPath, consumedPath);
        fs.writeFileSync(requestPath, replacement);
      },
    });
    assert.equal(result.status, 0);
    assert.equal(hookCalls, 1);
    assert.deepEqual(fs.readFileSync(requestPath), replacement);
    assert.equal(result.response.warnings.some((warning) => warning.code === 'request_identity_changed'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('request consumption claims atomically and deletes only the private consumed object', () => {
  const root = tempProject();
  const requestPath = path.join(root, '.deep-evolve', '.runtime-requests', 'claim-race.json');
  const originalMoved = `${requestPath}.original-moved-by-test`;
  const replacement = Buffer.from('{"replacement":"before-claim"}\n');
  fs.writeFileSync(requestPath, JSON.stringify(request(root)));
  let renameCalls = 0;
  try {
    const result = captureMain(['--request', requestPath], {
      requestRename(from, to) {
        renameCalls += 1;
        assert.equal(from, requestPath);
        fs.renameSync(requestPath, originalMoved);
        fs.writeFileSync(requestPath, replacement);
        fs.renameSync(requestPath, to);
      },
    });
    assert.equal(result.status, 0);
    assert.equal(renameCalls, 1);
    assert.deepEqual(fs.readFileSync(requestPath), replacement);
    assert.equal(result.response.warnings.some((warning) => warning.code === 'request_identity_changed'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a replacement created after claim survives private claim cleanup', () => {
  const root = tempProject();
  const requestPath = path.join(root, '.deep-evolve', '.runtime-requests', 'after-claim.json');
  const replacement = Buffer.from('{"replacement":"after-claim"}\n');
  fs.writeFileSync(requestPath, JSON.stringify(request(root)));
  let claimedPath = null;
  try {
    const result = captureMain(['--request', requestPath], {
      afterRequestClaim(candidate, claim) {
        assert.equal(candidate, requestPath);
        claimedPath = claim;
        assert.equal(fs.existsSync(requestPath), false);
        assert.equal(fs.existsSync(claim), true);
        fs.writeFileSync(requestPath, replacement);
      },
    });
    assert.equal(result.status, 0);
    assert.ok(claimedPath);
    assert.deepEqual(fs.readFileSync(requestPath), replacement);
    assert.equal(fs.existsSync(claimedPath), false, 'only the private consumed claim is deleted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a private request-claim replacement after verification preserves both objects and warns', () => {
  const root = tempProject();
  const requestPath = path.join(root, '.deep-evolve', '.runtime-requests', 'private-claim-rebind.json');
  const originalBytes = Buffer.from(JSON.stringify(request(root)));
  const replacement = Buffer.from('{"replacement":"private-claim"}\n');
  fs.writeFileSync(requestPath, originalBytes);
  let claimPath = null;
  let movedOriginal = null;
  try {
    const result = captureMain(['--request', requestPath], {
      afterRequestClaim(candidate, claim) {
        assert.equal(candidate, requestPath);
        claimPath = claim;
        movedOriginal = `${claim}.verified-original-by-test`;
        fs.renameSync(claim, movedOriginal);
        fs.writeFileSync(claim, replacement);
      },
    });
    assert.equal(result.status, 0);
    assert.equal(result.response.ok, true);
    assert.ok(claimPath);
    assert.deepEqual(fs.readFileSync(movedOriginal), originalBytes,
      'the consumed request object must remain recoverable');
    assert.deepEqual(fs.readFileSync(claimPath), replacement,
      'the private-path replacement must not be unlinked');
    assert.equal(result.response.warnings.some((warning) => (
      warning.code === 'request_claim_cleanup_pending'
      && warning.reason === 'private_claim_identity_changed'
      && warning.recovery_path === claimPath
    )), true, JSON.stringify(result.response.warnings));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a private replacement after mismatched-claim restoration link survives cleanup', () => {
  const root = tempProject();
  const requestPath = path.join(root, '.deep-evolve', '.runtime-requests', 'restore-link-rebind.json');
  const consumedOriginal = `${requestPath}.consumed-original-by-test`;
  const mismatchedBytes = Buffer.from('{"replacement":"mismatched-claim"}\n');
  const privateReplacement = Buffer.from('{"replacement":"after-restore-link"}\n');
  fs.writeFileSync(requestPath, JSON.stringify(request(root)));
  let claimPath = null;
  let movedMismatch = null;
  let seamCalls = 0;
  try {
    const result = captureMain(['--request', requestPath], {
      requestRename(from, claim) {
        claimPath = claim;
        fs.renameSync(from, consumedOriginal);
        fs.writeFileSync(from, mismatchedBytes);
        fs.renameSync(from, claim);
      },
      afterRequestRestoreLink(candidate, claim) {
        seamCalls += 1;
        assert.equal(candidate, requestPath);
        assert.equal(claim, claimPath);
        assert.deepEqual(fs.readFileSync(candidate), mismatchedBytes,
          'the mismatched claim must already be restored at the public path');
        movedMismatch = `${claim}.linked-mismatch-by-test`;
        fs.renameSync(claim, movedMismatch);
        fs.writeFileSync(claim, privateReplacement);
      },
    });
    assert.equal(result.status, 0);
    assert.equal(result.response.ok, true);
    assert.equal(seamCalls, 1, 'the post-restoration-link rebind seam must execute');
    assert.deepEqual(fs.readFileSync(consumedOriginal), Buffer.from(JSON.stringify(request(root))));
    assert.deepEqual(fs.readFileSync(requestPath), mismatchedBytes,
      'the public restoration path must retain the mismatched claim bytes');
    assert.deepEqual(fs.readFileSync(movedMismatch), mismatchedBytes,
      'the restored claim object must remain recoverable after the private rename');
    assert.deepEqual(fs.readFileSync(claimPath), privateReplacement,
      'an unrelated private-path replacement must not be unlinked');
    assert.equal(result.response.warnings.some((warning) => (
      warning.code === 'request_claim_cleanup_pending'
      && warning.reason === 'restored_private_claim_identity_changed'
      && warning.recovery_path === claimPath
      && warning.restored_path === requestPath
    )), true, JSON.stringify(result.response.warnings));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native Windows request containment accepts project path case aliases', {
  skip: process.platform !== 'win32' ? 'native Windows case-alias evidence only' : false,
}, () => {
  const root = tempProject();
  const requestPath = path.join(root, '.deep-evolve', '.runtime-requests', 'case.json');
  const caseAlias = `${root[0].toUpperCase()}${root.slice(1)}`;
  fs.writeFileSync(requestPath, JSON.stringify(request(caseAlias)));
  try {
    const result = runRequest(requestPath, caseAlias);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(requestPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a request symlink escaping .runtime-requests fails closed and preserves both paths', {
  skip: process.platform === 'win32' ? 'symlink creation is privilege-dependent on Windows' : false,
}, () => {
  const root = tempProject();
  const outside = path.join(root, 'escaped-target.json');
  const link = path.join(root, '.deep-evolve', '.runtime-requests', 'escaped.json');
  fs.writeFileSync(outside, JSON.stringify(request(root)));
  fs.symlinkSync(outside, link);
  try {
    const result = runRequest(link, root);
    assert.equal(result.status, 2, result.stderr);
    const response = parseSingleResponse(result);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'request_path_escape');
    assert.equal(fs.existsSync(link), true);
    assert.equal(fs.existsSync(outside), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a symlinked .runtime-requests directory cannot authorize deletion outside state', {
  skip: process.platform === 'win32' ? 'symlink creation is privilege-dependent on Windows' : false,
}, () => {
  const root = tempProject();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-request-root-escape-'));
  const runtimeRequests = path.join(root, '.deep-evolve', '.runtime-requests');
  const outsideRequest = path.join(outsideDir, 'request.json');
  fs.rmSync(runtimeRequests, { recursive: true });
  fs.symlinkSync(outsideDir, runtimeRequests);
  fs.writeFileSync(outsideRequest, JSON.stringify(request(root)));
  try {
    const result = runRequest(path.join(runtimeRequests, 'request.json'), root);
    assert.equal(result.status, 2, result.stderr);
    const response = parseSingleResponse(result);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'request_path_escape');
    assert.equal(fs.existsSync(outsideRequest), true);
    assert.equal(fs.existsSync(runtimeRequests), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('a coordination-file symlink escaping the project fails closed without reading or deleting it', {
  skip: process.platform === 'win32' ? 'symlink creation is privilege-dependent on Windows' : false,
}, () => {
  const root = tempProject();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-state-escape-'));
  const outside = path.join(outsideDir, 'sessions.jsonl');
  const link = path.join(root, '.deep-evolve', 'sessions.jsonl');
  const requestPath = path.join(root, 'state-escape-request.json');
  fs.writeFileSync(outside, `${JSON.stringify({ event: 'created', session_id: 'secret' })}\n`);
  fs.symlinkSync(outside, link);
  fs.writeFileSync(requestPath, JSON.stringify(request(root)));
  try {
    const before = fs.readFileSync(outside);
    const result = runRequest(requestPath, root);
    assert.equal(result.status, 2, result.stderr);
    const response = parseSingleResponse(result);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'state_path_escape');
    assert.deepEqual(fs.readFileSync(outside), before);
    assert.equal(fs.existsSync(link), true);
    assert.equal(fs.existsSync(requestPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('invalid JSON request is rc 2, emits one response, and is never deleted', () => {
  const root = tempProject();
  const requestPath = path.join(root, '.deep-evolve', '.runtime-requests', 'invalid.json');
  fs.writeFileSync(requestPath, '{"schema_version":');
  try {
    const result = runRequest(requestPath, root);
    assert.equal(result.status, 2, result.stderr);
    const response = parseSingleResponse(result);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'invalid_request_json');
    assert.equal(fs.existsSync(requestPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy help is native and unknown legacy arms retain rc 1', () => {
  const root = tempProject();
  try {
    const help = spawnSync(process.execPath, [RUNTIME, '--legacy-session-helper', 'help'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /session-helper\.sh v3\.4\.3/);
    assert.match(help.stdout, /entropy_compute/);
    assert.match(help.stdout, /rebuild_seeds_from_journal/);

    const unknown = spawnSync(process.execPath, [RUNTIME, '--legacy-session-helper', 'not_a_real_arm'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown subcommand/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native help preserves the frozen 3.4.3 bytes and creates no project state', () => {
  const root = bareTempDirectory('evolve-help-no-state-');
  const expected = [
    'session-helper.sh v3.4.3',
    '',
    'Session lifecycle:',
    '  compute_session_id, resolve_current, list_sessions,',
    '  start_new_session, mark_session_status, append_sessions_jsonl,',
    '  migrate_legacy, check_branch_alignment, detect_orphan_experiment,',
    '  append_meta_archive_local, render_inherited_context, lineage_tree',
    '',
    'v3.0.0 subcommands (AAR-inspired):',
    '  entropy_compute <journal> [window_size]         — Shannon entropy over recent planned events',
    '  migrate_v2_weights <v2_json>                    — Translate 4-cat v2 weights to 10-cat v3',
    '  count_flagged_since_last_expansion <journal>    — Count shortcut_flagged since last reset',
    '  retry_budget_remaining <journal> [cap]          — Diagnose-retry budget remaining',
    '',
    'v3.1.0 subcommands (Virtual Parallel N-seed):',
    '  resolve_helper_path                             — Print absolute path of session-helper.sh',
    '  create_seed_worktree, validate_seed_worktree, remove_seed_worktree',
    '  compute_init_budget_split, compute_grow_allocation',
    '  append_forum_event, tail_forum',
    '  append_journal_event                            — Append validated event to journal.jsonl (§ 6.5, § 9.2)',
    '  append_kill_queue_entry, drain_kill_queue       — In-flight kill deferral (§ 5.5 W-9)',
    '  create_synthesis_worktree, cleanup_failed_synthesis_worktree',
    '  rebuild_seeds_from_journal                      — Resume reconciliation (§ 11 + T46 fold-in)',
    '',
  ].join('\n');
  try {
    const help = spawnSync(process.execPath, [RUNTIME, '--legacy-session-helper', 'help'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stdout, expected);
    assert.equal(help.stderr, '');
    assert.deepEqual(fs.readdirSync(root), [], 'read-only help must not create .deep-evolve');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native virtual arms preserve the oracle SESSION_ROOT precondition and side effects', () => {
  const cases = [
    ['append_seed_to_session_yaml', '1', '/tmp/wt', 'branch', '{}'],
    ['set_virtual_parallel_field', 'n_current', '2'],
    ['init_virtual_parallel_block', '{"project_type":"x","eval_parallelizability":"y"}', '2', '10'],
    ['rebuild_seeds_from_journal'],
  ];
  for (const args of cases) {
    const root = bareTempDirectory(`evolve-${args[0]}-`);
    try {
      const env = { ...process.env };
      delete env.SESSION_ROOT;
      delete env.SESSION_ID;
      const result = spawnSync(process.execPath, [RUNTIME, '--legacy-session-helper', ...args], {
        cwd: root,
        env,
        encoding: 'utf8',
      });
      assert.equal(result.status, 2, `${args[0]}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'SESSION_ROOT not set\n');
      assert.deepEqual(fs.readdirSync(root), [], `${args[0]} created project state`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('legacy native dry-run retains 3.4.3 no-mutation behavior', () => {
  const root = tempProject();
  try {
    const before = fs.readdirSync(path.join(root, '.deep-evolve')).sort();
    const result = spawnSync(process.execPath, [
      RUNTIME,
      '--legacy-session-helper',
      '--dry-run',
      'start_new_session',
      'Dry Run Goal',
    ], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /^\[dry-run\] would execute: create session /);
    assert.match(result.stdout, /^\d{4}-\d{2}-\d{2}_dry-run-goal\t/);
    assert.deepEqual(fs.readdirSync(path.join(root, '.deep-evolve')).sort(), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the public shell adapter contains no state discovery or lock implementation', () => {
  const wrapperPath = path.join(__dirname, '..', 'hooks', 'scripts', 'session-helper.sh');
  const source = fs.readFileSync(wrapperPath, 'utf8');
  for (const forbidden of [
    'find_project_root', 'acquire_project_lock', 'release_project_lock',
    'mkdir ', 'rmdir ', 'sleep ', 'date -u', '.session-lock',
  ]) {
    assert.equal(source.includes(forbidden), false, `public wrapper still contains ${forbidden}`);
  }
  assert.match(source, /legacy\/session-helper-v3\.4\.3\.sh/,
    'source-only compatibility must route to the frozen oracle');
  assert.match(source, /exec node .*deep-evolve-runtime\.cjs.*--legacy-session-helper/);
});
