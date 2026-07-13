'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const RUNTIME = path.resolve(__dirname, '..', 'hooks', 'scripts', 'deep-evolve-runtime.cjs');
const { dispatch } = require(RUNTIME);
const synthesis = require('../hooks/scripts/runtime/synthesis.cjs');
const { serializeStateDocument } = require('../hooks/scripts/runtime/session-codec.cjs');
const START = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'session-start-v3.5.json'), 'utf8',
));

const FIXED_NOW = Date.parse('2026-07-14T00:00:00Z');
const DECISION_ID = 'decision-seed-dispatch';
const N_BLOCK = 3;

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

function call(projectRoot, operation, payload) {
  return dispatch({
    schema_version: '1.0', operation, context: { project_root: projectRoot }, payload,
  }, { now: () => FIXED_NOW });
}

function ok(response, label) {
  assert.equal(response.ok, true, `${label}: ${JSON.stringify(response)}`);
  assert.equal(response.exitCode, 0, label);
  return response.result;
}

function authority(project) {
  return Object.fromEntries([
    ['session', project.sessionPath],
    ['journal', project.journalPath],
    ['forum', project.forumPath],
    ['results', project.resultsPath],
    ['kill_queue', project.killQueuePath],
    ['kill_requests', project.killRequestsPath],
  ].map(([name, file]) => [name, fs.readFileSync(file)]));
}

function assertAuthority(project, expected, label) {
  const paths = {
    session: project.sessionPath,
    journal: project.journalPath,
    forum: project.forumPath,
    results: project.resultsPath,
    kill_queue: project.killQueuePath,
    kill_requests: project.killRequestsPath,
  };
  for (const [name, bytes] of Object.entries(expected)) {
    assert.deepEqual(fs.readFileSync(paths[name]), bytes, `${label}: ${name}`);
  }
}

function authorityDigests(project) {
  const files = authority(project);
  return Object.fromEntries(Object.entries(files)
    .map(([name, bytes]) => [`${name}_sha256`, digest(bytes)]));
}

function makeProject(t, label = 'seed dispatch') {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-seed-dispatch-'));
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
  initial.total_budget = 12;
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
  };
  project.seed = ok(call(project.projectRoot, 'worktree.create-seed', {
    session_id: project.sessionId, seed_id: 1, base_commit: baseCommit,
  }), 'worktree.create-seed');
  let before = authorityDigests(project);
  ok(call(project.projectRoot, 'virtual.append-seed', {
    session_id: project.sessionId,
    operation_id: '01J00000000000000000000020',
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
    seed_id: 1,
    worktree_path: project.seed.worktree_path,
    branch: project.seed.branch,
    beta: { direction: 'host neutral', hypothesis: null, rationale: null },
    creation_kind: 'initial',
  }), 'virtual.append-seed');
  fs.writeFileSync(path.join(sessionRoot, 'prepare.cjs'),
    "'use strict';\nprocess.stdout.write('score: 4\\n');\n");
  fs.writeFileSync(path.join(sessionRoot, 'prepare.config.json'),
    '{"schema_version":"1.0","metric_direction":"maximize","baseline_score":null}\n');
  before = authorityDigests(project);
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
  before = authorityDigests(project);
  const scheduled = ok(call(project.projectRoot, 'coord.begin-seed-block', {
    session_id: project.sessionId,
    operation_id: '01J00000000000000000000100',
    decision_id: DECISION_ID,
    seed_id: 1,
    block_size: N_BLOCK,
    pre_dispatch_head: git(project.seed.worktree_path, ['rev-parse', 'HEAD']),
    expected_epoch: 1,
    budget_preimage: 12,
    expected_session_sha256: before.session_sha256,
    expected_journal_sha256: before.journal_sha256,
  }), 'coord.begin-seed-block');
  project.blockId = scheduled.block_id;
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  return project;
}

function payload(project, overrides = {}) {
  return {
    session_id: project.sessionId,
    seed_id: 1,
    block_id: project.blockId,
    decision_id: DECISION_ID,
    n_block: N_BLOCK,
    ...overrides,
  };
}

function expectedContext(project) {
  return {
    schema_version: '1.0',
    policy_ref: 'agents/evolve-seed.md',
    project_root: project.projectRoot,
    session_id: project.sessionId,
    session_root: project.sessionRoot,
    seed_id: 1,
    worktree_path: project.seed.worktree_path,
    branch: project.seed.branch,
    block: {
      block_id: project.blockId,
      decision_id: DECISION_ID,
      experiments: N_BLOCK,
    },
    first_actions: ['read-policy', 'verify-worktree'],
    runtime_operations: [
      'coord.tail-forum',
      'session.finish-experiment',
      'scheduler.borrow-preflight',
      'harness.run',
    ],
    final_response_schema: {
      required: [
        'experiments_executed',
        'commits',
        'final_q',
        'forum_events_appended',
        'borrows_planned',
        'borrows_executed',
        'status',
        'notes',
      ],
    },
  };
}

function directAuthority(projectRoot, sessionId, platform = 'posix') {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const sessionRoot = pathApi.join(projectRoot, '.deep-evolve', sessionId);
  return {
    project_root: projectRoot,
    session_root: sessionRoot,
    session: {
      session_id: sessionId,
      status: 'active',
      eval_mode: 'cli',
      evaluation_epoch: { current: 1 },
      virtual_parallel: { seeds: [{
        id: 1,
        status: 'active',
        worktree_path: pathApi.join(sessionRoot, 'worktrees', 'seed_1'),
        branch: `evolve/${sessionId}/seed-1`,
      }] },
    },
    events: [{
      event: 'seed_scheduled',
      block_id: 'block-windows',
      decision_id: 'decision-windows',
      seed_id: 1,
      epoch: 1,
      block_size: 3,
    }],
    seed_id: 1,
    block_id: 'block-windows',
    decision_id: 'decision-windows',
    n_block: 3,
  };
}

test('dispatcher returns the exact host-neutral context and both consumer exports agree', (t) => {
  const project = makeProject(t, 'host neutral with spaces');
  const response = call(project.projectRoot, 'coord.build-seed-prompt', payload(project));
  assert.equal(response.exitCode, 0, JSON.stringify(response));
  assert.deepEqual(response.result, expectedContext(project));
  assert.equal(typeof response.result, 'object');

  const rendered = JSON.stringify(response.result);
  for (const forbidden of [
    /\bcd\b/i,
    /\bpwd\b/i,
    /\bbash\b/i,
    /helper_path/i,
    /(?:session\.yaml|journal\.jsonl|forum\.jsonl|kill_queue\.jsonl|kill_requests\.jsonl)/i,
    /(?:&&|\|\||[;`])/,
    /"(?:command|shell|tool_syntax)"/i,
  ]) assert.doesNotMatch(rendered, forbidden);

  assert.equal(typeof synthesis.buildSeedDispatchContext, 'function');
  const session = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'));
  const events = fs.readFileSync(project.journalPath, 'utf8').split(/\r?\n/)
    .filter(Boolean).map(JSON.parse);
  const input = {
    project_root: project.projectRoot,
    session_root: project.sessionRoot,
    session,
    events,
    ...payload(project),
  };
  const claude = synthesis.buildSeedDispatchContext(input);
  const codex = synthesis.buildSeedPrompt(structuredClone(input));
  assert.deepEqual(claude, expectedContext(project));
  assert.deepEqual(codex, claude);
});

test('drive-letter and UNC authorities preserve every literal path byte', () => {
  assert.equal(typeof synthesis.buildSeedDispatchContext, 'function');
  const sessionId = '01J00000000000000000000000';
  for (const projectRoot of [
    'C:\\Project With Spaces',
    '\\\\server\\share\\Project With Spaces',
  ]) {
    const input = directAuthority(projectRoot, sessionId, 'win32');
    const context = synthesis.buildSeedDispatchContext(input, { platform: 'win32' });
    assert.equal(context.project_root, input.project_root);
    assert.equal(context.session_root, input.session_root);
    assert.equal(context.worktree_path,
      input.session.virtual_parallel.seeds[0].worktree_path);
    assert.equal(context.branch, input.session.virtual_parallel.seeds[0].branch);
    assert.deepEqual(synthesis.buildSeedPrompt(structuredClone(input), { platform: 'win32' }),
      context);
  }
});

test('caller path, branch, helper, project, and session authority fields are rejected without writes', (t) => {
  const project = makeProject(t, 'caller authority');
  const before = authority(project);
  const legacy = call(project.projectRoot, 'coord.build-seed-prompt', {
    seed_id: 1,
    worktree_path: path.join(project.outer, 'forged worktree'),
    session_root: project.sessionRoot,
    branch: `${project.seed.branch}-forged`,
    n_block: N_BLOCK,
    helper_path: RUNTIME,
  });
  assert.equal(legacy.exitCode, 2, JSON.stringify(legacy));
  assert.equal(legacy.error.code, 'unknown_payload_field');
  assertAuthority(project, before, 'legacy caller authority');

  for (const [name, value] of [
    ['worktree_path', project.seed.worktree_path],
    ['branch', project.seed.branch],
    ['helper_path', RUNTIME],
    ['session_root', project.sessionRoot],
    ['project_root', project.projectRoot],
  ]) {
    const rejected = call(project.projectRoot, 'coord.build-seed-prompt', {
      ...payload(project), [name]: value,
    });
    assert.equal(rejected.exitCode, 2, `${name}: ${JSON.stringify(rejected)}`);
    assert.equal(rejected.error.code, 'unknown_payload_field', name);
    assertAuthority(project, before, name);
  }
});

test('missing seed and mismatched block, decision, or size authority fail closed', (t) => {
  const project = makeProject(t, 'mismatched authority');
  const before = authority(project);
  const cases = [
    ['missing seed', { seed_id: 99 }, 'seed_not_found'],
    ['block', { block_id: `${project.blockId}-stale` }, 'seed_dispatch_authority_conflict'],
    ['decision', { decision_id: `${DECISION_ID}-stale` }, 'seed_dispatch_authority_conflict'],
    ['size', { n_block: N_BLOCK - 1 }, 'seed_dispatch_authority_conflict'],
  ];
  for (const [label, overrides, code] of cases) {
    const rejected = call(project.projectRoot, 'coord.build-seed-prompt',
      payload(project, overrides));
    assert.notEqual(rejected.exitCode, 0, `${label}: ${JSON.stringify(rejected)}`);
    assert.equal(rejected.error.code, code, label);
    assertAuthority(project, before, label);
  }
});

test('relative, escaping, and mismatched canonical seed paths or branches are rejected', (t) => {
  const mutations = [
    ['relative path', (session) => { session.virtual_parallel.seeds[0].worktree_path = 'relative/seed_1'; }, 'seed_worktree_path_invalid'],
    ['escaping path', (session, project) => { session.virtual_parallel.seeds[0].worktree_path = path.join(project.outer, 'outside'); }, 'seed_worktree_path_invalid'],
    ['branch', (session) => { session.virtual_parallel.seeds[0].branch += '-forged'; }, 'seed_branch_invalid'],
  ];
  for (const [label, mutate, code] of mutations) {
    const project = makeProject(t, `canonical ${label}`);
    const session = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'));
    mutate(session, project);
    fs.writeFileSync(project.sessionPath, serializeStateDocument(session));
    const before = authority(project);
    const rejected = call(project.projectRoot, 'coord.build-seed-prompt', payload(project));
    assert.equal(rejected.exitCode, 2, `${label}: ${JSON.stringify(rejected)}`);
    assert.equal(rejected.error.code, code, label);
    assertAuthority(project, before, label);
  }
});

test('a symlinked canonical worktree is rejected without changing authority', (t) => {
  const project = makeProject(t, 'symlinked worktree');
  const target = `${project.seed.worktree_path}-target`;
  fs.renameSync(project.seed.worktree_path, target);
  fs.symlinkSync(target, project.seed.worktree_path, 'dir');
  const before = authority(project);
  const rejected = call(project.projectRoot, 'coord.build-seed-prompt', payload(project));
  assert.equal(rejected.exitCode, 2, JSON.stringify(rejected));
  assert.equal(rejected.error.code, 'seed_worktree_symlink');
  assertAuthority(project, before, 'symlinked worktree');
});

test('zero, negative, and bool block sizes are rejected as integers before authority reads', (t) => {
  const project = makeProject(t, 'invalid block size');
  const before = authority(project);
  for (const value of [0, -1, true, false]) {
    const rejected = call(project.projectRoot, 'coord.build-seed-prompt',
      payload(project, { n_block: value }));
    assert.equal(rejected.exitCode, 2, `${String(value)}: ${JSON.stringify(rejected)}`);
    assert.equal(rejected.error.code, 'invalid_field_type');
    assertAuthority(project, before, String(value));
  }
});
