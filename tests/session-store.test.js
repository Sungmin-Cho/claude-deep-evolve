'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  withDirectoryLock,
  atomicWriteFile,
  persistCommitMarker,
  validateCommitMarker,
  syncRenamedDirectoryBestEffort,
  readSession,
  writeSession,
  patchSession,
  commitCoordinationTransaction,
  patchCoordinationFiles,
  readCoordinationFiles,
  recoverTransactions,
} = require('../hooks/scripts/runtime/session-store.cjs');

const storeModule = path.resolve(__dirname, '../hooks/scripts/runtime/session-store.cjs');
const repositoryRoot = path.resolve(__dirname, '..');

function fixture(t, prefix = 'deep evolve task1 ') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync.native(root);
}

function validSession(overrides = {}) {
  return {
    session_id: '01J00000000000000000000000',
    deep_evolve_version: '3.1.0',
    status: 'active',
    created_at: '2026-07-11T12:00:00Z',
    metric: { name: 'score', direction: 'maximize', baseline: 1, current: 1, best: 1 },
    eval_mode: 'cli',
    'x-counter': 0,
    ...overrides,
  };
}

function stateFixture(t) {
  const project = fixture(t, 'deep evolve project with spaces ');
  const stateRoot = path.join(project, '.deep-evolve');
  const sessionPath = path.join(stateRoot, '01J00000000000000000000000', 'session.yaml');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  return { project, stateRoot, sessionPath };
}

function spawnNode(code, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (codeValue, signal) => resolve({ code: codeValue, signal, stdout, stderr }));
  });
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function owner(pid, nonce, heartbeatAt = new Date().toISOString()) {
  return { pid, created_at: heartbeatAt, heartbeat_at: heartbeatAt, nonce };
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeOwner(lockPath, value) {
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify(value)}\n`);
}

test('atomic writes use exclusive same-directory temps, file fsync, and leave no temp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve atomic '));
  try {
    const target = path.join(root, 'state.json');
    const result = atomicWriteFile(target, '{"value":1}\n');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"value":1}\n');
    assert.equal(result.committed, true);
    assert.deepEqual(fs.readdirSync(root), ['state.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows rename retries bounded transient EPERM EACCES EBUSY failures', (t) => {
  const root = fixture(t, 'evolve windows rename ');
  const target = path.join(root, 'state.json');
  const errors = ['EPERM', 'EACCES', 'EBUSY'];
  let attempts = 0;
  const io = Object.create(fs);
  io.renameSync = (from, to) => {
    const code = errors[attempts++];
    if (code) throw Object.assign(new Error(code), { code });
    return fs.renameSync(from, to);
  };
  atomicWriteFile(target, 'ok', { io, platform: 'win32', sleep: () => {} });
  assert.equal(attempts, 4);
  assert.equal(fs.readFileSync(target, 'utf8'), 'ok');
});

test('Windows durability never opens or fsyncs a directory handle', (t) => {
  const root = fixture(t, 'evolve no dir fsync ');
  const io = Object.create(fs);
  io.openSync = () => { throw new Error('directory open forbidden'); };
  io.fsyncSync = () => { throw new Error('directory fsync forbidden'); };
  assert.deepEqual(syncRenamedDirectoryBestEffort(root, 'win32', { io }), {
    synced: false,
    reason: 'windows_marker_durability',
  });
});

test('commit marker is canonical and checksum-valid while temp files never define commit', (t) => {
  const root = fixture(t, 'evolve marker ');
  const markerPath = path.join(root, 'transaction.commit.json');
  const marker = persistCommitMarker(markerPath, { kind: 'transaction', transaction_id: 'tx-1' });
  assert.equal(validateCommitMarker(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).valid, true);
  assert.equal(marker.marker_checksum.startsWith('sha256:'), true);
  fs.writeFileSync(path.join(root, '.transaction.commit.json.tmp.1.fake'), '{"kind":"transaction"}');
  assert.equal(validateCommitMarker({ kind: 'transaction' }).valid, false);
  const reserved = persistCommitMarker(path.join(root, 'reserved.commit.json'), {
    kind: 'transaction',
    marker_schema_version: 'spoofed',
    marker_checksum: 'spoofed',
  });
  assert.equal(reserved.marker_schema_version, '1.0');
  assert.equal(validateCommitMarker(reserved).valid, true);
});

test('directory lock records an owner nonce and releases only its own lock', (t) => {
  const root = fixture(t, 'evolve lock ');
  const lockPath = path.join(root, '.lock');
  const result = withDirectoryLock(lockPath, (handle) => {
    const recorded = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    assert.equal(recorded.pid, process.pid);
    assert.equal(recorded.nonce, handle.nonce);
    assert.equal(typeof recorded.created_at, 'string');
    assert.equal(typeof recorded.heartbeat_at, 'string');
    handle.heartbeat();
    return 'held';
  });
  assert.equal(result, 'held');
  assert.equal(fs.existsSync(lockPath), false);
});

test('ordinary live contention has a distinct five-second-budget lock_held result', (t) => {
  const root = fixture(t, 'evolve contention ');
  const lockPath = path.join(root, '.lock');
  writeOwner(lockPath, owner(process.pid, 'live-owner'));
  const started = Date.now();
  const result = withDirectoryLock(lockPath, () => assert.fail('must not acquire'), {
    timeoutMs: 25,
    retryDelayMs: 1,
    staleMs: 30_000,
    isPidAlive: () => true,
  });
  assert.deepEqual(result, { ok: false, retryable: true, code: 'lock_held' });
  assert.ok(Date.now() - started < 1000, 'ordinary acquisition must not wait for the stale window');
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'))).nonce, 'live-owner');
});

test('stale recovery handles missing, corrupt, dead, and old-heartbeat owners but preserves live owners', (t) => {
  const root = fixture(t, 'evolve stale ');
  const cases = [
    { name: 'missing', setup(lock) { fs.mkdirSync(lock); fs.utimesSync(lock, new Date(0), new Date(0)); } },
    { name: 'corrupt', setup(lock) { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), '{'); fs.utimesSync(lock, new Date(0), new Date(0)); } },
    { name: 'dead', setup(lock) { writeOwner(lock, owner(999999, 'dead')); } },
    { name: 'old-heartbeat', setup(lock) { writeOwner(lock, owner(process.pid, 'old', '2000-01-01T00:00:00Z')); } },
  ];
  for (const entry of cases) {
    const lockPath = path.join(root, entry.name);
    entry.setup(lockPath);
    const warnings = [];
    const result = withDirectoryLock(lockPath, () => 'recovered', {
      timeoutMs: 50,
      staleMs: 10,
      retryDelayMs: 1,
      isPidAlive: (pid) => entry.name === 'dead' ? false : pid === process.pid,
      onRecoveryWarning: (warning) => warnings.push(warning),
    });
    assert.equal(result, 'recovered', entry.name);
    assert.equal(warnings.length, 1, entry.name);
    assert.equal(warnings[0].code, 'stale_lock_recovered');
    assert.ok(fs.existsSync(warnings[0].quarantine_path), entry.name);
  }
});

test('changed owner during stale recovery wins and is never quarantined', (t) => {
  const root = fixture(t, 'evolve stale race ');
  const lockPath = path.join(root, '.lock');
  writeOwner(lockPath, owner(999999, 'stale', '2000-01-01T00:00:00Z'));
  let changed = false;
  const result = withDirectoryLock(lockPath, () => assert.fail('must not acquire'), {
    timeoutMs: 20,
    retryDelayMs: 1,
    staleMs: 10,
    isPidAlive: () => false,
    beforeRecoveryQuarantine() {
      if (changed) return;
      changed = true;
      fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify(owner(process.pid, 'replacement'))}\n`);
    },
  });
  assert.deepEqual(result, { ok: false, retryable: true, code: 'lock_held' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'))).nonce, 'replacement');
});

test('invalid owner timestamps are corrupt state and recover only after directory staleness', (t) => {
  const root = fixture(t, 'evolve invalid owner timestamp ');
  const lockPath = path.join(root, '.lock');
  writeOwner(lockPath, {
    pid: process.pid,
    created_at: 'not-a-time',
    heartbeat_at: 'not-a-time',
    nonce: 'corrupt-time-owner',
  });
  fs.utimesSync(lockPath, new Date(0), new Date(0));
  const result = withDirectoryLock(lockPath, () => 'recovered', {
    timeoutMs: 50,
    retryDelayMs: 1,
    staleMs: 10,
    isPidAlive: () => true,
  });
  assert.equal(result, 'recovered');
});

test('a dead stale recovery claim cannot permanently block lock recovery', (t) => {
  const root = fixture(t, 'evolve stale recovery claim ');
  const lockPath = path.join(root, '.lock');
  writeOwner(lockPath, owner(999998, 'stale-owner', '2000-01-01T00:00:00Z'));
  const claimPath = `${lockPath}.recovery`;
  writeOwner(claimPath, owner(999997, 'dead-recovery', '2000-01-01T00:00:00Z'));
  const result = withDirectoryLock(lockPath, () => 'recovered', {
    timeoutMs: 100,
    recoveryTimeoutMs: 50,
    retryDelayMs: 1,
    staleMs: 10,
    isPidAlive: () => false,
  });
  assert.equal(result, 'recovered');
});

test('an old process cannot release a replacement owner lock', async (t) => {
  const root = fixture(t, 'evolve nonce processes ');
  const lockPath = path.join(root, '.lock');
  const ready = path.join(root, 'ready');
  const resume = path.join(root, 'resume');
  const code = `
    const fs = require('node:fs');
    const { withDirectoryLock } = require(${JSON.stringify(storeModule)});
    const lock = ${JSON.stringify(lockPath)};
    const ready = ${JSON.stringify(ready)};
    const resume = ${JSON.stringify(resume)};
    const result = withDirectoryLock(lock, () => {
      fs.writeFileSync(ready, 'ready');
      while (!fs.existsSync(resume)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      return 'done';
    }, { timeoutMs: 2000 });
    if (result !== 'done') process.exit(3);
  `;
  const childPromise = spawnNode(code);
  await waitFor(() => fs.existsSync(ready), 'lock holder never became ready');
  const oldPath = `${lockPath}.old`;
  fs.renameSync(lockPath, oldPath);
  writeOwner(lockPath, owner(process.pid, 'replacement-owner'));
  fs.writeFileSync(resume, 'go');
  const child = await childPromise;
  assert.equal(child.code, 0, child.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'))).nonce, 'replacement-owner');
});

test('session writes and patches validate, recover, and serialize as JSON-compatible YAML', (t) => {
  const { sessionPath } = stateFixture(t);
  writeSession(sessionPath, validSession());
  assert.equal(fs.readFileSync(sessionPath, 'utf8').startsWith('{\n'), true);
  patchSession(sessionPath, (value) => ({ ...value, 'x-counter': value['x-counter'] + 1 }));
  assert.equal(readSession(sessionPath)['x-counter'], 1);
});

test('patchSession rejects parse and validation errors before mutation and preserves original bytes', (t) => {
  const { stateRoot, sessionPath } = stateFixture(t);
  const invalid = Buffer.from('defaults: &defaults\n  status: active\n');
  fs.writeFileSync(sessionPath, invalid);
  assert.throws(() => patchSession(sessionPath, (value) => value), /unsupported YAML.*anchor/i);
  assert.deepEqual(fs.readFileSync(sessionPath), invalid);
  assert.equal(fs.existsSync(path.join(stateRoot, '.coordination-lock')), false);

  writeSession(sessionPath, validSession());
  const before = fs.readFileSync(sessionPath);
  assert.throws(() => patchSession(sessionPath, (value) => ({ ...value, status: 'invalid' })), /status/i);
  assert.deepEqual(fs.readFileSync(sessionPath), before);
});

test('patchSession runs committed transaction recovery before its pre-lock parse', async (t) => {
  const { stateRoot, sessionPath } = stateFixture(t);
  fs.writeFileSync(sessionPath, '{');
  const relative = path.relative(stateRoot, sessionPath).split(path.sep).join('/');
  const replacement = `${JSON.stringify(validSession({ 'x-counter': 5 }), null, 2)}\n`;
  const code = `
    const { commitCoordinationTransaction } = require(${JSON.stringify(storeModule)});
    commitCoordinationTransaction(${JSON.stringify(stateRoot)}, {
      ${JSON.stringify(relative)}: ${JSON.stringify(replacement)}
    }, { crashAt: 'after-commit-marker', crashExitCode: 86, timeoutMs: 10000 });
  `;
  const child = await spawnNode(code);
  assert.equal(child.code, 86, child.stderr);
  const next = patchSession(sessionPath, (value) => ({ ...value, 'x-counter': value['x-counter'] + 1 }));
  assert.equal(next['x-counter'], 6);
  assert.equal(readSession(sessionPath)['x-counter'], 6);
});

test('every legacy fixture stays byte-identical after a rejected mutation attempt', (t) => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures/runtime/legacy-byte-manifest.json'),
    'utf8',
  ));
  const { sessionPath } = stateFixture(t);
  for (const entry of manifest.files) {
    const source = fs.readFileSync(path.join(repositoryRoot, 'tests/fixtures/runtime', entry.copy));
    fs.writeFileSync(sessionPath, source);
    assert.throws(
      () => patchSession(sessionPath, (value) => ({ ...value, status: 'invented' })),
      undefined,
      entry.copy,
    );
    const after = fs.readFileSync(sessionPath);
    assert.deepEqual(after, source, entry.copy);
    assert.equal(digest(after), entry.sha256, entry.copy);
  }
});

test('eight Node processes patch one session under a project path with spaces without lost updates', async (t) => {
  const { stateRoot, sessionPath } = stateFixture(t);
  writeSession(sessionPath, validSession());
  const code = `
    const { patchSession } = require(${JSON.stringify(storeModule)});
    patchSession(${JSON.stringify(sessionPath)}, (value) => ({ ...value, 'x-counter': value['x-counter'] + 1 }), { timeoutMs: 10000 });
  `;
  const children = await Promise.all(Array.from({ length: 8 }, () => spawnNode(code)));
  for (const child of children) assert.equal(child.code, 0, child.stderr);
  assert.equal(JSON.parse(fs.readFileSync(sessionPath, 'utf8'))['x-counter'], 8);
  assert.equal(fs.existsSync(path.join(stateRoot, '.coordination-lock')), false);
  assert.equal(fs.existsSync(`${sessionPath}.lock`), false);
  const leftovers = fs.readdirSync(path.dirname(sessionPath)).filter((name) => name.includes('.tmp.') || name.includes('.txn.'));
  assert.deepEqual(leftovers, []);
});

test('transaction crash cutpoints recover to one coherent pre or post state', async (t) => {
  const phases = [
    'after-stage:current.json',
    'after-stage:sessions/s1/session.yaml',
    'after-transaction',
    'after-commit-marker',
    'after-install:current.json',
    'after-install:sessions/s1/session.yaml',
    'after-cleanup',
  ];
  for (const phase of phases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve tx crash '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateRoot = path.join(root, '.deep-evolve');
    const first = path.join(stateRoot, 'current.json');
    const second = path.join(stateRoot, 'sessions', 's1', 'session.yaml');
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.writeFileSync(first, 'pre-current\n');
    fs.writeFileSync(second, 'pre-session\n');
    const code = `
      const { commitCoordinationTransaction } = require(${JSON.stringify(storeModule)});
      commitCoordinationTransaction(${JSON.stringify(stateRoot)}, {
        'current.json': 'post-current\\n',
        'sessions/s1/session.yaml': 'post-session\\n'
      }, { crashAt: ${JSON.stringify(phase)}, crashExitCode: 86, timeoutMs: 10000 });
    `;
    const child = await spawnNode(code);
    assert.equal(child.code, 86, `${phase}: ${child.stderr}`);
    const recovery = recoverTransactions(stateRoot, { timeoutMs: 10_000 });
    assert.equal(recovery.ok, true, `${phase}: ${JSON.stringify(recovery)}`);
    const pair = [fs.readFileSync(first, 'utf8'), fs.readFileSync(second, 'utf8')];
    assert.ok(
      (pair[0] === 'pre-current\n' && pair[1] === 'pre-session\n') ||
      (pair[0] === 'post-current\n' && pair[1] === 'post-session\n'),
      `${phase}: mixed state ${JSON.stringify(pair)}`,
    );
    assert.equal(fs.existsSync(path.join(stateRoot, '.coordination-lock')), false, phase);
  }
});

test('each install rename rechecks its own file-lock nonce', (t) => {
  const { stateRoot } = stateFixture(t);
  const firstRel = 'current.json';
  const secondRel = 'sessions/s1/session.yaml';
  fs.mkdirSync(path.join(stateRoot, 'sessions', 's1'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, firstRel), 'pre-current\n');
  fs.writeFileSync(path.join(stateRoot, secondRel), 'pre-session\n');
  const result = commitCoordinationTransaction(stateRoot, {
    [firstRel]: 'post-current\n',
    [secondRel]: 'post-session\n',
  }, {
    onPhase(phase) {
      if (phase !== 'before-install:current.json') return;
      const ownerPath = path.join(stateRoot, 'current.json.lock', 'owner.json');
      const value = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      fs.writeFileSync(ownerPath, `${JSON.stringify({ ...value, nonce: 'replacement-file-owner' })}\n`);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.rc, 2);
  assert.equal(result.error.code, 'lock_ownership_lost');
  assert.equal(fs.readFileSync(path.join(stateRoot, firstRel), 'utf8'), 'pre-current\n');
  assert.equal(fs.readFileSync(path.join(stateRoot, secondRel), 'utf8'), 'pre-session\n');
});

test('nonce loss after one install preserves the marker so the next owner recovers a coherent set', (t) => {
  const { stateRoot } = stateFixture(t);
  const firstRel = 'current.json';
  const secondRel = 'sessions/s1/session.yaml';
  fs.mkdirSync(path.join(stateRoot, 'sessions', 's1'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, firstRel), 'pre-current\n');
  fs.writeFileSync(path.join(stateRoot, secondRel), 'pre-session\n');
  const secondLock = path.join(stateRoot, 'sessions', 's1', 'session.yaml.lock');
  const result = commitCoordinationTransaction(stateRoot, {
    [firstRel]: 'post-current\n',
    [secondRel]: 'post-session\n',
  }, {
    onPhase(phase) {
      if (phase !== `before-install:${secondRel}`) return;
      const ownerPath = path.join(secondLock, 'owner.json');
      const value = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      fs.writeFileSync(ownerPath, `${JSON.stringify({ ...value, nonce: 'replacement-second-owner' })}\n`);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'lock_ownership_lost');
  fs.rmSync(secondLock, { recursive: true, force: true });
  const recovery = recoverTransactions(stateRoot);
  assert.equal(recovery.ok, true, JSON.stringify(recovery));
  assert.equal(fs.readFileSync(path.join(stateRoot, firstRel), 'utf8'), 'post-current\n');
  assert.equal(fs.readFileSync(path.join(stateRoot, secondRel), 'utf8'), 'post-session\n');
});

test('ambiguous transaction recovery returns rc 2 and retains a named recovery directory', (t) => {
  const { stateRoot } = stateFixture(t);
  const txRoot = path.join(stateRoot, '.transactions');
  const bad = path.join(txRoot, 'tx-bad');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'transaction.json'), '{');
  const result = recoverTransactions(stateRoot);
  assert.equal(result.ok, false);
  assert.equal(result.rc, 2);
  assert.equal(result.error.code, 'transaction_recovery_ambiguous');
  assert.ok(result.recovery_paths.some((value) => path.basename(value).startsWith('recovery-')));
  assert.ok(result.recovery_paths.every((value) => fs.existsSync(value)));
  const repeated = recoverTransactions(stateRoot);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.rc, 2);
  assert.equal(repeated.error.code, 'transaction_recovery_ambiguous');
  assert.deepEqual(repeated.recovery_paths.sort(), result.recovery_paths.sort());
});

test('session patches and forum/kill mutations share one project transaction lock', async (t) => {
  const { stateRoot, sessionPath } = stateFixture(t);
  writeSession(sessionPath, validSession());
  const forumRel = '01J00000000000000000000000/forum.jsonl';
  const killRel = '01J00000000000000000000000/kill_requests.jsonl';
  fs.writeFileSync(path.join(stateRoot, forumRel), '');
  fs.writeFileSync(path.join(stateRoot, killRel), '');
  const sessionCode = `
    const { patchSession } = require(${JSON.stringify(storeModule)});
    patchSession(${JSON.stringify(sessionPath)}, (value) => ({ ...value, 'x-counter': value['x-counter'] + 1 }), { timeoutMs: 10000 });
  `;
  const mutationCode = (id) => `
    const { patchCoordinationFiles } = require(${JSON.stringify(storeModule)});
    patchCoordinationFiles(${JSON.stringify(stateRoot)}, [${JSON.stringify(forumRel)}, ${JSON.stringify(killRel)}], (files) => ({
      ${JSON.stringify(forumRel)}: files[${JSON.stringify(forumRel)}] + ${JSON.stringify(`${id}-forum\n`)},
      ${JSON.stringify(killRel)}: files[${JSON.stringify(killRel)}] + ${JSON.stringify(`${id}-kill\n`)}
    }), { timeoutMs: 10000 });
  `;
  const jobs = [];
  for (let id = 0; id < 4; id += 1) {
    jobs.push(spawnNode(sessionCode));
    jobs.push(spawnNode(mutationCode(id)));
  }
  const children = await Promise.all(jobs);
  for (const child of children) assert.equal(child.code, 0, child.stderr);
  assert.equal(readSession(sessionPath)['x-counter'], 4);
  const snapshot = readCoordinationFiles(stateRoot, [forumRel, killRel]);
  assert.equal(snapshot[forumRel].trimEnd().split('\n').length, 4);
  assert.equal(snapshot[killRel].trimEnd().split('\n').length, 4);
});

test('a reclaimed owner cannot resume and install over the replacement transaction', async (t) => {
  const { stateRoot } = stateFixture(t);
  const firstRel = 'current.json';
  const secondRel = 'sessions/s1/session.yaml';
  fs.mkdirSync(path.join(stateRoot, 'sessions', 's1'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, firstRel), 'initial-current\n');
  fs.writeFileSync(path.join(stateRoot, secondRel), 'initial-session\n');
  const ready = path.join(stateRoot, 'owner-a-ready');
  const resume = path.join(stateRoot, 'owner-a-resume');
  const resultPath = path.join(stateRoot, 'owner-a-result.json');
  const code = `
    const fs = require('node:fs');
    const { commitCoordinationTransaction } = require(${JSON.stringify(storeModule)});
    const result = commitCoordinationTransaction(${JSON.stringify(stateRoot)}, {
      ${JSON.stringify(firstRel)}: 'owner-a-current\\n',
      ${JSON.stringify(secondRel)}: 'owner-a-session\\n'
    }, {
      timeoutMs: 10000,
      onPhase(phase) {
        if (phase !== 'before-install:current.json') return;
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        while (!fs.existsSync(${JSON.stringify(resume)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    });
    fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
  `;
  const ownerA = spawnNode(code);
  await waitFor(() => fs.existsSync(ready), 'owner A did not reach pre-install phase');
  const stale = '2000-01-01T00:00:00Z';
  for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.lock')) continue;
    const ownerPath = path.join(stateRoot, entry.name, 'owner.json');
    if (!fs.existsSync(ownerPath)) continue;
    const value = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    value.heartbeat_at = stale;
    fs.writeFileSync(ownerPath, `${JSON.stringify(value)}\n`);
  }
  const sessionLock = path.join(stateRoot, 'sessions', 's1', 'session.yaml.lock', 'owner.json');
  if (fs.existsSync(sessionLock)) {
    const value = JSON.parse(fs.readFileSync(sessionLock, 'utf8'));
    value.heartbeat_at = stale;
    fs.writeFileSync(sessionLock, `${JSON.stringify(value)}\n`);
  }
  const replacement = commitCoordinationTransaction(stateRoot, {
    [firstRel]: 'owner-b-current\n',
    [secondRel]: 'owner-b-session\n',
  }, { timeoutMs: 10_000, staleMs: 10, isPidAlive: () => true });
  assert.equal(replacement.ok, true, JSON.stringify(replacement));
  fs.writeFileSync(resume, 'resume');
  const child = await ownerA;
  assert.equal(child.code, 0, child.stderr);
  const oldResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.equal(oldResult.ok, false);
  assert.equal(oldResult.rc, 2);
  assert.equal(oldResult.error.code, 'lock_ownership_lost');
  assert.equal(fs.readFileSync(path.join(stateRoot, firstRel), 'utf8'), 'owner-b-current\n');
  assert.equal(fs.readFileSync(path.join(stateRoot, secondRel), 'utf8'), 'owner-b-session\n');
});

test('native Windows open-target retry probe is bounded', { skip: process.platform !== 'win32' }, async (t) => {
  const root = fixture(t, 'evolve native windows target ');
  const target = path.join(root, 'state.json');
  fs.writeFileSync(target, 'old');
  const childSource = [
    "const fs = require('node:fs');",
    "const fd = fs.openSync(process.argv[1], 'r');",
    "process.stdout.write('ready\\n');",
    'setTimeout(() => { fs.closeSync(fd); }, 100);',
  ].join('\n');
  const holder = spawn(process.execPath, ['-e', childSource, target], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const holderClosed = new Promise((resolve) => holder.once('close', resolve));
  let ready = '';
  for await (const chunk of holder.stdout) {
    ready += chunk.toString('utf8');
    if (ready.includes('ready\n')) break;
  }
  assert.match(ready, /ready/);
  try {
    atomicWriteFile(target, 'new', { platform: 'win32' });
  } finally {
    await holderClosed;
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
});
