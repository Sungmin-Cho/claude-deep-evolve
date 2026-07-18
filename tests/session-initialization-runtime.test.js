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
const {
  parseStateDocument,
  validateSession,
} = require('../hooks/scripts/runtime/session-codec.cjs');
const { validateCommitMarker } = require('../hooks/scripts/runtime/session-store.cjs');
const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'session-start-v3.5.json'),
  'utf8',
));

const FIXED_NOW = Date.parse('2026-07-13T12:34:56Z');
const RESULTS_HEADER = 'commit\tscore\tstatus\tcategory\tscore_delta\tloc_delta\tflagged\trationale\tdescription\n';
const STATE_FILES = [
  'session.yaml',
  'journal.jsonl',
  'forum.jsonl',
  'kill_queue.jsonl',
  'kill_requests.jsonl',
  'results.tsv',
];

function clone(value) {
  return structuredClone(value);
}

function makeProject(label = 'canonical start project') {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-initial-state-'));
  const root = path.join(outer, label);
  fs.mkdirSync(path.join(root, '.deep-evolve'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'module.exports = 1;\n');
  return { outer, root: fs.realpathSync(root) };
}

function request(projectRoot, payload) {
  return {
    schema_version: '1.0',
    operation: 'session.start',
    context: { project_root: projectRoot },
    payload,
  };
}

function start(projectRoot, overrides = {}, dependencies = {}) {
  const initialState = clone(FIXTURE.initial_state);
  const payload = {
    goal: 'native start',
    initial_state: initialState,
    ...overrides,
  };
  return dispatch(request(projectRoot, payload), {
    now: () => FIXED_NOW,
    ...dependencies,
  });
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function snapshotTree(root) {
  const snapshot = {};
  if (!fs.existsSync(root)) return snapshot;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = '<directory>';
        visit(absolute);
      } else if (entry.isSymbolicLink()) {
        snapshot[relative] = `<link:${fs.readlinkSync(absolute)}>`;
      } else {
        snapshot[relative] = fs.readFileSync(absolute).toString('base64');
      }
    }
  };
  visit(root);
  return snapshot;
}

function expectedSession(sessionId, goal = 'native start', parentSessionId = null,
  initialState = FIXTURE.initial_state) {
  const result = {
    session_id: sessionId,
    deep_evolve_version: '3.5.0',
    status: 'initializing',
    created_at: '2026-07-13T12:34:56Z',
    goal,
    parent_session: parentSessionId === null ? null : {
      id: parentSessionId,
      inherited_at: '2026-07-13T12:34:56Z',
    },
    experiments: { total: 0, kept: 0, discarded: 0, crashed: 0 },
    program: {
      version: 1,
      history: [{
        version: 1,
        experiments: '0-',
        keep_rate: null,
        reason: 'initial',
        created_at: '2026-07-13T12:34:56Z',
      }],
    },
    outer_loop: {
      generation: 0,
      interval: initialState.outer_loop.interval,
      inner_count: 0,
      auto_trigger: initialState.outer_loop.auto_trigger,
      q_history: [],
    },
    evaluation_epoch: {
      current: 1,
      history: [{
        epoch: 1,
        prepare_version: 1,
        generations: [],
        best_Q: null,
        created_at: '2026-07-13T12:34:56Z',
      }],
    },
    lineage: {
      current_branch: `evolve/${sessionId}`,
      forked_from: parentSessionId,
      previous_branches: [],
    },
    shortcut: { cumulative_flagged: 0, flagged_since_last_tier3: 0, total_flagged: 0 },
    diagnose_retry: { session_retries_used: 0, gave_up_count: 0 },
    legibility: { missing_rationale_count: 0 },
    entropy: { last_collapse_generation: null },
    metric: clone(initialState.metric),
    eval_mode: initialState.eval_mode,
    protocol_tools: clone(initialState.protocol_tools),
    total_budget: initialState.total_budget,
    target_files: clone(initialState.target_files),
    transfer: initialState.transfer === null ? null : {
      ...clone(initialState.transfer),
      adopted_at: '2026-07-13T12:34:56Z',
    },
    virtual_parallel: {
      enabled: true,
      n_initial: initialState.virtual_parallel.n_chosen,
      n_range: { min: 1, max: 9 },
      project_type: initialState.virtual_parallel.project_type,
      eval_parallelizability: initialState.virtual_parallel.eval_parallelizability,
      selection_reason: initialState.virtual_parallel.selection_reason,
      budget_total: initialState.total_budget,
      budget_unallocated: initialState.total_budget,
      synthesis: {
        budget_allocated: Math.min(2 * initialState.virtual_parallel.n_chosen, 10),
        regression_tolerance: 0.05,
      },
      seeds: [],
      'x-active-seed-count': 0,
    },
  };
  return result;
}

function assertPublishedState(result, expectedGoal = 'native start', parentSessionId = null,
  initialState = FIXTURE.initial_state) {
  assert.equal(result.ok, true, JSON.stringify(result));
  const started = result.result;
  assert.deepEqual(Object.keys(started).sort(), [
    'initialization_id', 'replayed', 'session', 'session_id', 'session_root', 'session_sha256',
  ]);
  const sessionId = started.session_id;
  const publicRoot = started.session_root;
  const privateRoot = fs.realpathSync(publicRoot);
  const sessionBytes = fs.readFileSync(path.join(privateRoot, 'session.yaml'));
  const session = parseStateDocument(sessionBytes.toString('utf8'));
  assert.deepEqual(session, expectedSession(sessionId, expectedGoal, parentSessionId, initialState));
  assert.deepEqual(started.session, session);
  assert.equal(started.session_sha256, sha256(sessionBytes));
  assert.equal(started.initialization_id, initialState.initialization_id);
  assert.strictEqual(validateSession(session), session);
  assert.equal(fs.readFileSync(path.join(privateRoot, 'journal.jsonl'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(privateRoot, 'forum.jsonl'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(privateRoot, 'kill_queue.jsonl'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(privateRoot, 'kill_requests.jsonl'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(privateRoot, 'results.tsv'), 'utf8'), RESULTS_HEADER);

  const marker = JSON.parse(fs.readFileSync(path.join(privateRoot, '.start-state.commit.json'), 'utf8'));
  assert.equal(validateCommitMarker(marker).valid, true);
  assert.equal(marker.kind, 'deep-evolve-start-state');
  assert.equal(marker.session_id, sessionId);
  assert.equal(marker.initialization_id, initialState.initialization_id);
  assert.deepEqual(marker.files.map((entry) => entry.relative_path), STATE_FILES);
  for (const entry of marker.files) {
    const bytes = fs.readFileSync(path.join(privateRoot, entry.relative_path));
    assert.equal(entry.sha256, sha256(bytes), entry.relative_path);
    assert.equal(entry.bytes, bytes.length, entry.relative_path);
  }
  const pointer = JSON.parse(fs.readFileSync(
    path.join(path.dirname(publicRoot), 'current.json'),
    'utf8',
  ));
  assert.equal(pointer.session_id, sessionId);
  return { started, session, publicRoot, privateRoot, marker };
}

test('dispatcher session.start atomically publishes one complete strict v3.5 initial state', () => {
  const { outer, root } = makeProject();
  try {
    const published = assertPublishedState(start(root));
    assert.equal(published.started.replayed, false);
    assert.equal(published.started.session_root,
      path.join(root, '.deep-evolve', '2026-07-13_native-start'));
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('session.start derives parent lineage and stamps transfer adoption itself', () => {
  const { outer, root } = makeProject('parent derivation');
  try {
    const parent = assertPublishedState(start(root));
    const childInitial = clone(FIXTURE.initial_state);
    childInitial.initialization_id = '01J00000000000000000000001';
    childInitial.transfer = {
      source_id: '01J00000000000000000000002',
      source_schema_version: '4',
      source_artifacts: ['recurring-findings.json'],
    };
    const childResult = start(root, {
      goal: 'child start',
      parent_session_id: parent.started.session_id,
      initial_state: childInitial,
    });
    const child = assertPublishedState(
      childResult,
      'child start',
      parent.started.session_id,
      childInitial,
    );
    assert.equal(child.session.lineage.current_branch, `evolve/${child.started.session_id}`);
    assert.equal(Object.hasOwn(childInitial.transfer, 'adopted_at'), false,
      'caller input must not be mutated or trusted for the runtime timestamp');
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('session.start validates cross-fields, canonical target paths, bool-as-int, and symlink escapes before mutation', () => {
  const invalidCases = [
    ['cli protocol tools', (value) => { value.protocol_tools = ['tool']; }],
    ['protocol requires tools', (value) => { value.eval_mode = 'protocol'; }],
    ['protocol tools unique', (value) => {
      value.eval_mode = 'protocol';
      value.protocol_tools = ['mcp.read', 'mcp.read'];
    }],
    ['budget floor', (value) => { value.total_budget = 2; }],
    ['bool total budget', (value) => { value.total_budget = true; }],
    ['bool n chosen', (value) => { value.virtual_parallel.n_chosen = true; }],
    ['bool outer interval', (value) => { value.outer_loop.interval = true; }],
    ['bool auto trigger', (value) => { value.outer_loop.auto_trigger = 1; }],
    ['duplicate target', (value) => { value.target_files = ['src/index.js', 'src/index.js']; }],
    ['parent escape', (value) => { value.target_files = ['../outside.js']; }],
    ['dot segment', (value) => { value.target_files = ['src/./index.js']; }],
    ['empty segment', (value) => { value.target_files = ['src//index.js']; }],
    ['absolute target', (value) => { value.target_files = ['/tmp/index.js']; }],
    ['drive target', (value) => { value.target_files = ['C:\\Project\\index.js']; }],
    ['UNC target', (value) => { value.target_files = ['\\\\server\\share\\index.js']; }],
    ['NUL target', (value) => { value.target_files = ['src/\0index.js']; }],
    ['unknown field', (value) => { value.untrusted = true; }],
  ];
  for (const [name, mutate] of invalidCases) {
    const { outer, root } = makeProject(`invalid ${name}`);
    try {
      const stateRoot = path.join(root, '.deep-evolve');
      const before = snapshotTree(stateRoot);
      const initialState = clone(FIXTURE.initial_state);
      mutate(initialState);
      const result = start(root, { initial_state: initialState });
      assert.equal(result.ok, false, `${name}: ${JSON.stringify(result)}`);
      assert.equal(result.exitCode, 2, name);
      assert.deepEqual(snapshotTree(stateRoot), before, `${name}: rejected input mutated state`);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }

  const { outer, root } = makeProject('symlink target');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-initial-outside-'));
  try {
    fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const before = snapshotTree(path.join(root, '.deep-evolve'));
    const initialState = clone(FIXTURE.initial_state);
    initialState.target_files = ['linked/secret.js'];
    const result = start(root, { initial_state: initialState });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.exitCode, 2);
    assert.match(result.error.code, /target|path|symlink/);
    assert.deepEqual(snapshotTree(path.join(root, '.deep-evolve')), before);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('session.start requires initial_state and treats initialization_id as immutable idempotency authority', () => {
  const { outer, root } = makeProject('idempotent start');
  try {
    const missing = dispatch(request(root, { goal: 'native start' }), { now: () => FIXED_NOW });
    assert.equal(missing.ok, false, JSON.stringify(missing));
    assert.equal(missing.exitCode, 2);
    assert.equal(missing.error.code, 'initial_state_required');

    const first = assertPublishedState(start(root));
    const stateRoot = path.join(root, '.deep-evolve');
    const beforeReplay = snapshotTree(stateRoot);
    const replay = start(root, {}, { now: () => Date.parse('2026-07-14T01:02:03Z') });
    const replayed = assertPublishedState(replay);
    assert.equal(replayed.started.replayed, true);
    assert.equal(replayed.started.session_id, first.started.session_id);
    assert.deepEqual(snapshotTree(stateRoot), beforeReplay, 'exact replay performed a write');

    const conflictingInitial = clone(FIXTURE.initial_state);
    conflictingInitial.target_files = ['src/other.js'];
    const conflict = start(root, { initial_state: conflictingInitial });
    assert.equal(conflict.ok, false, JSON.stringify(conflict));
    assert.equal(conflict.exitCode, 2);
    assert.equal(conflict.error.code, 'initialization_id_conflict');
    assert.deepEqual(snapshotTree(stateRoot), beforeReplay, 'conflicting reuse mutated state');

    const distinctInitial = clone(FIXTURE.initial_state);
    distinctInitial.initialization_id = '01J00000000000000000000003';
    const distinct = start(root, { initial_state: distinctInitial });
    assert.equal(distinct.ok, true, JSON.stringify(distinct));
    assert.notEqual(distinct.result.session_id, first.started.session_id);
    assert.equal(distinct.result.replayed, false);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

function crashStart(projectRoot, cutpoint) {
  const script = [
    "const fs=require('node:fs');",
    "const runtime=require(process.argv[1]);",
    "const root=process.argv[2];",
    "const cutpoint=process.argv[3];",
    "const initial=JSON.parse(fs.readFileSync(process.argv[4],'utf8')).initial_state;",
    "const request={schema_version:'1.0',operation:'session.start',",
    "context:{project_root:root},payload:{goal:'native start',initial_state:initial}};",
    "const result=runtime.dispatch(request,{now:()=>Date.parse('2026-07-13T12:34:56Z'),",
    "coordinationOptions:{crashAt:cutpoint,crashExitCode:86}});",
    "process.stdout.write(JSON.stringify(result));",
  ].join('');
  return spawnSync(process.execPath, [
    '-e', script, RUNTIME, projectRoot, cutpoint,
    path.join(__dirname, 'fixtures', 'runtime', 'session-start-v3.5.json'),
  ], { encoding: 'utf8', timeout: 15_000 });
}

function assertPointerNeverOutrunsState(root, cutpoint) {
  const stateRoot = path.join(root, '.deep-evolve');
  const pointerPath = path.join(stateRoot, 'current.json');
  if (!fs.existsSync(pointerPath)) return;
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  const publicRoot = path.join(stateRoot, pointer.session_id);
  assert.equal(fs.existsSync(publicRoot), true, `${cutpoint}: pointer has no namespace`);
  const privateRoot = fs.realpathSync(publicRoot);
  assert.equal(fs.existsSync(path.join(privateRoot, '.start-state.commit.json')), true,
    `${cutpoint}: pointer outran state marker`);
  const session = parseStateDocument(fs.readFileSync(path.join(privateRoot, 'session.yaml'), 'utf8'));
  assert.strictEqual(validateSession(session), session, `${cutpoint}: pointer session is invalid`);
  for (const name of STATE_FILES) {
    assert.equal(fs.existsSync(path.join(privateRoot, name)), true,
      `${cutpoint}: pointer outran ${name}`);
  }
}

test('unfinished recovery verifies committed file hashes before registry adoption or finalization', () => {
  for (const cutpoint of ['after-start-state-marker', 'after-install:sessions.jsonl']) {
    const { outer, root } = makeProject(`corrupt recovery ${cutpoint.replaceAll(':', '-')}`);
    try {
      const crashed = crashStart(root, cutpoint);
      assert.equal(crashed.status, 86, `${cutpoint}: ${crashed.stderr}\n${crashed.stdout}`);
      const reservationRoot = path.join(root, '.deep-evolve', '.start-reservations');
      const privateName = fs.readdirSync(reservationRoot)
        .find((name) => name.startsWith('.namespace-'));
      assert.ok(privateName, `${cutpoint}: private start namespace is missing`);
      const privateRoot = path.join(reservationRoot, privateName);
      const journalPath = path.join(privateRoot, 'journal.jsonl');
      const corruptBytes = Buffer.from(`foreign-${cutpoint}\n`);
      fs.writeFileSync(journalPath, corruptBytes);

      const recovered = start(root);
      assert.equal(recovered.ok, false, `${cutpoint}: ${JSON.stringify(recovered)}`);
      assert.equal(recovered.exitCode, 2);
      assert.equal(recovered.error.code, 'start_state_ambiguous');
      assert.deepEqual(fs.readFileSync(journalPath), corruptBytes,
        `${cutpoint}: recovery changed the third-digest bytes`);
      assert.equal(fs.existsSync(path.join(privateRoot, '.start-finalized.json')), false,
        `${cutpoint}: corrupt state was finalized`);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('session.start crash cutpoints recover only no pointer or a complete schema-valid namespace', () => {
  const cutpoints = [
    ...STATE_FILES.map((name) => `after-start-state-file:${name}`),
    'after-start-state-marker',
    'before-start-public-install',
    'after-start-public-claim',
    'before-commit-marker',
    'after-commit-marker',
    'before-install:current.json',
    'after-install:current.json',
    'before-install:sessions.jsonl',
    'after-install:sessions.jsonl',
    'after-start-finalization',
  ];
  for (const cutpoint of cutpoints) {
    const { outer, root } = makeProject(`crash ${cutpoint.replaceAll(':', '-')}`);
    try {
      const crashed = crashStart(root, cutpoint);
      assert.equal(crashed.status, 86,
        `${cutpoint}: child did not stop at cutpoint\n${crashed.stderr}\n${crashed.stdout}`);
      assertPointerNeverOutrunsState(root, cutpoint);
      const recovered = start(root);
      const published = assertPublishedState(recovered);
      assert.equal(published.started.session_id, '2026-07-13_native-start');
      assertPointerNeverOutrunsState(root, `${cutpoint}:recovered`);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});
