'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  appendJsonl,
  readJsonl,
  tailJsonl,
  quarantineMalformed,
  recoverQuarantine,
  queueKill,
  queueUserKill,
  drainKillQueue,
} = require('../hooks/scripts/runtime/journal-store.cjs');
const {
  syncRenamedDirectoryBestEffort,
  validateCommitMarker,
} = require('../hooks/scripts/runtime/session-store.cjs');
const { OPERATIONS, dispatch } = require('../hooks/scripts/deep-evolve-runtime.cjs');

const RUNTIME = path.join(__dirname, '..', 'hooks', 'scripts', 'deep-evolve-runtime.cjs');
const JOURNAL_STORE = path.join(__dirname, '..', 'hooks', 'scripts', 'runtime', 'journal-store.cjs');
const MALFORMED = path.join(__dirname, 'fixtures', 'runtime', 'malformed-jsonl');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeProject(t, label = 'evolve-journal-') {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), label));
  const stateRoot = path.join(projectRoot, '.deep-evolve');
  const sessionId = 's1';
  const sessionRoot = path.join(stateRoot, sessionId);
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, 'session.yaml'), `${JSON.stringify({
    session_id: sessionId,
    deep_evolve_version: '3.4.3',
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
    metric: { direction: 'maximize', baseline: 0, current: 0, best: 0 },
    experiments: { total: 0, kept: 0 },
  }, null, 2)}\n`);
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  return { projectRoot, stateRoot, sessionId, sessionRoot };
}

function request(projectRoot, operation, payload) {
  return dispatch({ schema_version: '1.0', operation, context: { project_root: projectRoot }, payload });
}

function treeSnapshot(root) {
  const result = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (entry.isDirectory()) visit(target);
      else result[relative] = fs.readFileSync(target).toString('base64');
    }
  }
  if (fs.existsSync(root)) visit(root);
  return result;
}

function malformedDescriptor(line = '{"event":') {
  return { line: 2, sha256: sha256(Buffer.from(line)) };
}

function installMalformedForum(sessionRoot) {
  const source = fs.readFileSync(path.join(MALFORMED, 'forum.jsonl'));
  fs.writeFileSync(path.join(sessionRoot, 'forum.jsonl'), source);
  return source;
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('append/read/tail validate plain objects and inject deterministic coordination fields', (t) => {
  const { stateRoot, sessionRoot } = makeProject(t);
  const relative = 's1/journal.jsonl';
  const first = appendJsonl({
    stateRoot, relativePath: relative, event: { event: 'planned' },
    sessionId: 's1', seedId: 2, now: () => Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.deepEqual(first.record, {
    event: 'planned', ts: '2026-01-01T00:00:00Z', session_id: 's1', seed_id: 2,
  });
  appendJsonl({
    stateRoot, relativePath: relative,
    event: { event: 'kept', ts: '2025-12-31T00:00:00Z', session_id: 'kept' },
    sessionId: 's1', now: () => Date.parse('2026-01-02T00:00:00Z'),
  });
  assert.deepEqual(readJsonl({ stateRoot, relativePath: relative }).records.map((row) => row.event), ['planned', 'kept']);
  assert.deepEqual(tailJsonl({ stateRoot, relativePath: relative, limit: 1 }).records.map((row) => row.event), ['kept']);
  assert.equal(fs.readFileSync(path.join(sessionRoot, 'journal.jsonl'), 'utf8').endsWith('\n'), true);
  assert.throws(() => appendJsonl({ stateRoot, relativePath: relative, event: [] }), /plain object/i);
  assert.throws(() => appendJsonl({ stateRoot, relativePath: relative, event: null }), /plain object/i);
});

test('four processes append forum records without loss or duplication', async (t) => {
  const { stateRoot, sessionRoot } = makeProject(t, 'evolve-forum-race-');
  const children = [];
  for (let worker = 0; worker < 4; worker += 1) {
    const script = `
      const { appendJsonl } = require(${JSON.stringify(JOURNAL_STORE)});
      for (let i = 0; i < 25; i += 1) appendJsonl({
        stateRoot: ${JSON.stringify(stateRoot)}, relativePath: 's1/forum.jsonl',
        event: { event: 'seed_keep', worker: ${worker}, sequence: i },
        sessionId: 's1', seedId: ${worker + 1}, now: () => 1767225600000,
      });
    `;
    children.push(waitForChild(spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })));
  }
  const results = await Promise.all(children);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const lines = fs.readFileSync(path.join(sessionRoot, 'forum.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 100);
  assert.equal(new Set(lines.map((row) => `${row.worker}:${row.sequence}`)).size, 100);
});

test('four-process forum append is starvation-free under deterministic transaction load', async (t) => {
  const { stateRoot, sessionRoot } = makeProject(t, 'evolve-forum-loaded-race-');
  const readyRoot = path.join(stateRoot, 'load-ready');
  const start = path.join(stateRoot, 'load-start');
  fs.mkdirSync(readyRoot);
  const children = [];
  for (let worker = 0; worker < 4; worker += 1) {
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const { appendJsonl } = require(${JSON.stringify(JOURNAL_STORE)});
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      fs.writeFileSync(path.join(${JSON.stringify(readyRoot)}, String(${worker})), 'ready');
      while (!fs.existsSync(${JSON.stringify(start)})) Atomics.wait(sleeper, 0, 0, 2);
      for (let i = 0; i < 16; i += 1) appendJsonl({
        stateRoot: ${JSON.stringify(stateRoot)}, relativePath: 's1/forum.jsonl',
        event: { event: 'seed_keep', worker: ${worker}, sequence: i },
        sessionId: 's1', seedId: ${worker + 1}, now: () => 1767225600000,
        options: {
          timeoutMs: 1_000,
          retryDelayMs: 25,
          onPhase(phase) {
            if (phase === 'after-commit-marker') Atomics.wait(sleeper, 0, 0, 20);
          },
        },
      });
    `;
    children.push(waitForChild(spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })));
  }
  const readyDeadline = Date.now() + 5_000;
  while (fs.readdirSync(readyRoot).length !== 4) {
    assert.ok(Date.now() < readyDeadline, 'loaded append workers did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  fs.writeFileSync(start, 'start');
  const results = await Promise.all(children);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const lines = fs.readFileSync(path.join(sessionRoot, 'forum.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 64);
  assert.equal(new Set(lines.map((row) => `${row.worker}:${row.sequence}`)).size, 64);
  assert.deepEqual(fs.readdirSync(stateRoot).filter((name) => name.includes('.wait.')), []);
});

test('forum append preserves genuine lock_held when a live owner exceeds its deadline', (t) => {
  const { stateRoot } = makeProject(t, 'evolve-forum-held-');
  const lockPath = path.join(stateRoot, '.coordination-lock');
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
    pid: process.pid,
    created_at: '2026-01-01T00:00:00Z',
    heartbeat_at: new Date().toISOString(),
    nonce: 'genuine-live-holder',
  })}\n`);
  assert.throws(() => appendJsonl({
    stateRoot,
    relativePath: 's1/forum.jsonl',
    event: { event: 'seed_keep' },
    sessionId: 's1',
    seedId: 1,
    options: { timeoutMs: 40, retryDelayMs: 5, isPidAlive: () => true },
  }), (error) => error && error.code === 'lock_held');
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).nonce, 'genuine-live-holder');
  assert.deepEqual(fs.readdirSync(stateRoot).filter((name) => name.includes('.wait.')), []);
});

test('ordinary malformed mutation fails closed byte-for-byte and read-only tail warns without repair', (t) => {
  const { projectRoot, stateRoot, sessionRoot, sessionId } = makeProject(t);
  installMalformedForum(sessionRoot);
  fs.writeFileSync(path.join(sessionRoot, 'journal.jsonl'), '{"event":"existing"}\n');
  fs.writeFileSync(path.join(sessionRoot, 'kill_requests.jsonl'), '');
  const before = treeSnapshot(stateRoot);

  const failed = request(projectRoot, 'coord.append-forum', {
    session_id: sessionId, event: { event: 'seed_keep', seed_id: 3, commit: 'ccc' },
  });
  assert.equal(failed.exitCode, 2);
  assert.equal(failed.error.code, 'invalid_jsonl');
  assert.deepEqual(treeSnapshot(stateRoot), before);

  const tailed = request(projectRoot, 'coord.tail-forum', { session_id: sessionId, limit: 10 });
  assert.equal(tailed.exitCode, 0);
  assert.deepEqual(tailed.result.records.map((row) => row.seed_id), [1, 2]);
  assert.deepEqual(tailed.warnings.map((warning) => [warning.code, warning.line]), [['malformed_jsonl_skipped', 2]]);
  assert.deepEqual(treeSnapshot(stateRoot), before);

  const direct = readJsonl({ stateRoot, relativePath: 's1/forum.jsonl', skipMalformed: true });
  assert.equal(direct.records.length, 2);
  assert.equal(direct.warnings[0].sha256, malformedDescriptor().sha256);
  assert.deepEqual(treeSnapshot(stateRoot), before);
});

test('malformed mutation and read-only tail do not run eager transaction cleanup', (t) => {
  const { projectRoot, stateRoot, sessionRoot, sessionId } = makeProject(t);
  installMalformedForum(sessionRoot);
  const uncommitted = path.join(stateRoot, '.transactions', 'tx-uncommitted', 'staged');
  fs.mkdirSync(uncommitted, { recursive: true });
  fs.writeFileSync(path.join(uncommitted, 'survivor'), 'uncommitted bytes');
  const before = treeSnapshot(stateRoot);

  const failed = request(projectRoot, 'coord.append-forum', {
    session_id: sessionId, event: { event: 'seed_keep', seed_id: 3 },
  });
  assert.equal(failed.exitCode, 2);
  assert.deepEqual(treeSnapshot(stateRoot), before);

  const tailed = request(projectRoot, 'coord.tail-forum', { session_id: sessionId, limit: 10 });
  assert.equal(tailed.exitCode, 0);
  assert.equal(tailed.warnings.length, 1);
  assert.deepEqual(treeSnapshot(stateRoot), before);
});

test('quarantine dispatcher rejects arbitrary files and stale raw-line digests', (t) => {
  const { projectRoot, stateRoot, sessionRoot, sessionId } = makeProject(t);
  installMalformedForum(sessionRoot);
  const before = treeSnapshot(stateRoot);
  const arbitrary = request(projectRoot, 'coord.quarantine-malformed', {
    session_id: sessionId, file: '../../package.json', malformed: [malformedDescriptor()],
  });
  assert.equal(arbitrary.exitCode, 2);
  assert.match(arbitrary.error.code, /path|file/);
  assert.deepEqual(treeSnapshot(stateRoot), before);

  const stale = request(projectRoot, 'coord.quarantine-malformed', {
    session_id: sessionId, file: 'forum.jsonl',
    malformed: [{ line: 2, sha256: '0'.repeat(64) }],
  });
  assert.equal(stale.exitCode, 2);
  assert.match(stale.error.code, /digest|preimage/);
  assert.deepEqual(treeSnapshot(stateRoot), before);
});

test('quarantine writes digest evidence, stable staged identity, and sole canonical marker before CAS install', (t) => {
  const { projectRoot, stateRoot, sessionRoot, sessionId } = makeProject(t);
  const original = installMalformedForum(sessionRoot);
  const payload = { session_id: sessionId, file: 'forum.jsonl', malformed: [malformedDescriptor()] };
  const response = request(projectRoot, 'coord.quarantine-malformed', payload);
  assert.equal(response.exitCode, 0, JSON.stringify(response));
  const result = response.result;
  assert.match(result.audit_identity, /^[0-9a-f]{64}$/);
  assert.equal(result.source_preimage_sha256, sha256(original));
  const evidence = path.join(stateRoot, 'quarantine', `${malformedDescriptor().sha256}.jsonl`);
  assert.equal(sha256(fs.readFileSync(evidence)), malformedDescriptor().sha256);
  assert.equal(fs.readFileSync(evidence, 'utf8'), '{"event":');
  const markerPath = path.join(stateRoot, 'quarantine', 'transactions', `${result.audit_identity}.commit.json`);
  const marker = JSON.parse(fs.readFileSync(markerPath));
  assert.equal(validateCommitMarker(marker).valid, true);
  assert.equal(marker.audit_identity, result.audit_identity);
  assert.equal(marker.source_relative_path, 's1/forum.jsonl');
  assert.equal(marker.staged_artifact_identity, sha256(Buffer.from(JSON.stringify({
    path: marker.staged_artifact_path, sha256: marker.staged_artifact_sha256,
  }))));
  assert.deepEqual(fs.readFileSync(path.join(sessionRoot, 'forum.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map((row) => row.seed_id), [1, 2]);
  assert.deepEqual(fs.readdirSync(path.join(stateRoot, 'quarantine', 'transactions')).filter((name) => name.endsWith('.commit.json')), [`${result.audit_identity}.commit.json`]);

  const completedSnapshot = treeSnapshot(stateRoot);
  const repeated = request(projectRoot, 'coord.quarantine-malformed', payload);
  assert.equal(repeated.exitCode, 0);
  assert.equal(repeated.result.audit_identity, result.audit_identity);
  assert.deepEqual(treeSnapshot(stateRoot), completedSnapshot);
  assert.deepEqual(fs.readdirSync(path.join(stateRoot, 'quarantine')).filter((name) => name.endsWith('.jsonl')), [`${malformedDescriptor().sha256}.jsonl`]);
});

test('quarantine crash cutpoints classify by canonical marker and recover idempotently', (t) => {
  const cases = [
    ['after-evidence', false],
    ['after-stage', false],
    ['after-marker', true],
    ['before-install', true],
    ['after-install', true],
    ['cleanup', true],
  ];
  for (const [phase, committed] of cases) {
    const { stateRoot, sessionRoot } = makeProject(t, `evolve-quarantine-${phase}-`);
    const original = installMalformedForum(sessionRoot);
    let auditIdentity = null;
    assert.throws(() => quarantineMalformed({
      stateRoot,
      relativePath: 's1/forum.jsonl',
      malformed: [malformedDescriptor()],
      randomNonce: () => `nonce-${phase}`,
      onPhase(name, context) {
        if (context && context.auditIdentity) auditIdentity = context.auditIdentity;
        if (name === phase) throw Object.assign(new Error(`crash at ${phase}`), { code: 'injected_crash', rc: 2 });
      },
    }), /crash at/);
    const current = fs.readFileSync(path.join(sessionRoot, 'forum.jsonl'));
    if (!committed) assert.deepEqual(current, original, phase);
    const recovery = recoverQuarantine(stateRoot, { auditIdentity });
    if (committed) {
      assert.equal(recovery.ok, true, phase);
      assert.equal(readJsonl({ stateRoot, relativePath: 's1/forum.jsonl' }).records.length, 2, phase);
      assert.deepEqual(recoverQuarantine(stateRoot, { auditIdentity }), recovery, phase);
    } else {
      assert.equal(recovery.recovered, 0, phase);
      assert.deepEqual(fs.readFileSync(path.join(sessionRoot, 'forum.jsonl')), original, phase);
    }
    const evidence = path.join(stateRoot, 'quarantine', `${malformedDescriptor().sha256}.jsonl`);
    assert.equal(fs.existsSync(evidence), true, phase);
    assert.equal(sha256(fs.readFileSync(evidence)), malformedDescriptor().sha256, phase);
  }
});

test('faults after evidence or marker file flush but before rename never create a false commit', (t) => {
  for (const targetKind of ['evidence', 'marker']) {
    const { stateRoot, sessionRoot } = makeProject(t, `evolve-quarantine-rename-${targetKind}-`);
    const original = installMalformedForum(sessionRoot);
    const io = Object.create(fs);
    io.renameSync = (from, to) => {
      const isEvidence = to.endsWith(`${malformedDescriptor().sha256}.jsonl`);
      const isMarker = to.endsWith('.commit.json');
      if ((targetKind === 'evidence' && isEvidence) || (targetKind === 'marker' && isMarker)) {
        throw Object.assign(new Error('rename cutpoint'), { code: 'EIO' });
      }
      return fs.renameSync(from, to);
    };
    assert.throws(() => quarantineMalformed({
      stateRoot, relativePath: 's1/forum.jsonl', malformed: [malformedDescriptor()], io,
    }), /rename cutpoint/);
    assert.deepEqual(fs.readFileSync(path.join(sessionRoot, 'forum.jsonl')), original);
    const markers = path.join(stateRoot, 'quarantine', 'transactions');
    const markerNames = fs.existsSync(markers) ? fs.readdirSync(markers).filter((name) => name.endsWith('.commit.json')) : [];
    assert.deepEqual(markerNames, []);
  }
});

test('post-marker external writes before recovery or immediate install CAS are preserved as rc 2', (t) => {
  for (const mode of ['before-recovery', 'immediate-cas']) {
    const { stateRoot, sessionRoot } = makeProject(t, `evolve-quarantine-cas-${mode}-`);
    installMalformedForum(sessionRoot);
    const sourcePath = path.join(sessionRoot, 'forum.jsonl');
    const external = Buffer.from(`external-${mode}\n`);
    let auditIdentity;
    if (mode === 'before-recovery') {
      assert.throws(() => quarantineMalformed({
        stateRoot, relativePath: 's1/forum.jsonl', malformed: [malformedDescriptor()],
        onPhase(name, context) {
          if (context && context.auditIdentity) auditIdentity = context.auditIdentity;
          if (name === 'after-marker') throw Object.assign(new Error('stop after marker'), { rc: 2 });
        },
      }));
      fs.writeFileSync(sourcePath, external);
      const recovery = recoverQuarantine(stateRoot, { auditIdentity });
      assert.equal(recovery.ok, false);
      assert.equal(recovery.rc, 2);
    } else {
      assert.throws(() => quarantineMalformed({
        stateRoot, relativePath: 's1/forum.jsonl', malformed: [malformedDescriptor()],
        beforeInstall() { fs.writeFileSync(sourcePath, external); },
      }), (error) => error.rc === 2 && /preimage|changed|CAS/i.test(error.message));
    }
    assert.deepEqual(fs.readFileSync(sourcePath), external);
    const transactionRoot = path.join(stateRoot, 'quarantine', 'transactions');
    assert.ok(fs.readdirSync(transactionRoot).some((name) => name.endsWith('.commit.json')));
    assert.ok(fs.readdirSync(path.join(stateRoot, 'quarantine')).some((name) => name.endsWith('.jsonl')));
    assert.ok(fs.existsSync(path.join(transactionRoot, 'staged')));
  }
});

test('Windows recovery opens and syncs files but never directory handles; POSIX attempts best-effort directory sync', (t) => {
  for (const platform of ['win32', 'linux']) {
    const { stateRoot, sessionRoot } = makeProject(t, `evolve-quarantine-${platform}-`);
    installMalformedForum(sessionRoot);
    let fileFsyncs = 0;
    let directoryOpens = 0;
    const io = Object.create(fs);
    io.openSync = (target, flags, mode) => {
      if (flags === 'r' && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        directoryOpens += 1;
        if (platform === 'win32') throw new Error('directory open forbidden on Windows');
      }
      return fs.openSync(target, flags, mode);
    };
    io.fsyncSync = (fd) => { fileFsyncs += 1; return fs.fsyncSync(fd); };
    const result = quarantineMalformed({
      stateRoot, relativePath: 's1/forum.jsonl', malformed: [malformedDescriptor()], io, platform,
    });
    assert.equal(result.ok, true);
    assert.ok(fileFsyncs >= 3, platform);
    if (platform === 'win32') assert.equal(directoryOpens, 0);
    else assert.ok(directoryOpens >= 3);
  }

  let opened = false;
  const result = syncRenamedDirectoryBestEffort('/never-open', 'win32', {
    io: { openSync() { opened = true; throw new Error('must not open'); } },
  });
  assert.equal(opened, false);
  assert.equal(result.synced, false);
  const source = fs.readFileSync(JOURNAL_STORE, 'utf8');
  assert.doesNotMatch(source, /openSync\([^\n]+['"]r['"]\)/);
  assert.doesNotMatch(source, /fsyncSync\(/);
});

test('Windows staged-source install uses the bounded transient rename retry path', (t) => {
  const { stateRoot, sessionRoot } = makeProject(t, 'evolve-quarantine-win-retry-');
  installMalformedForum(sessionRoot);
  let installAttempts = 0;
  let sleeps = 0;
  const io = Object.create(fs);
  io.renameSync = (from, to) => {
    if (to.endsWith(`${path.sep}forum.jsonl`) && from.includes(`${path.sep}staged${path.sep}`)) {
      installAttempts += 1;
      if (installAttempts < 3) throw Object.assign(new Error('transient Windows rename'), { code: 'EPERM' });
    }
    return fs.renameSync(from, to);
  };
  const result = quarantineMalformed({
    stateRoot,
    relativePath: 's1/forum.jsonl',
    malformed: [malformedDescriptor()],
    io,
    platform: 'win32',
    sleep() { sleeps += 1; },
  });
  assert.equal(result.ok, true);
  assert.equal(installAttempts, 3);
  assert.equal(sleeps, 2);
});

test('queue kills get unique entry ids and drain exactly once with monotonic applied_at', (t) => {
  const { stateRoot, sessionRoot } = makeProject(t);
  const first = queueKill({
    stateRoot, sessionId: 's1', seedId: 2, condition: 'user_requested', finalQ: 0.4,
    experimentsUsed: 3, randomUUID: () => 'entry-a', now: () => Date.parse('2026-01-01T00:00:00Z'),
  });
  const second = queueKill({
    stateRoot, sessionId: 's1', seedId: 3, condition: 'crash_give_up', finalQ: 0.1,
    experimentsUsed: 4, randomUUID: () => 'entry-b', now: () => Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.equal(first.entry_id, 'entry-a');
  assert.equal(second.entry_id, 'entry-b');
  const drained = drainKillQueue({
    stateRoot, sessionId: 's1', completedSeedId: 2, now: () => Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.deepEqual(drained, { drained: 1, seed_id: 2, emit_failed: 0 });
  const journal = readJsonl({ stateRoot, relativePath: 's1/journal.jsonl' }).records;
  assert.equal(journal.length, 1);
  assert.equal(journal[0].entry_id, 'entry-a');
  assert.ok(journal[0].applied_at > journal[0].queued_at);
  assert.equal(readJsonl({ stateRoot, relativePath: 's1/kill_queue.jsonl' }).records[0].entry_id, 'entry-b');
  assert.deepEqual(drainKillQueue({ stateRoot, sessionId: 's1', completedSeedId: 2 }), {
    drained: 0, seed_id: 2, emit_failed: 0,
  });
  assert.equal(readJsonl({ stateRoot, relativePath: 's1/journal.jsonl' }).records.length, 1);
  assert.equal(fs.existsSync(path.join(sessionRoot, 'kill_queue.jsonl')), true);
});

test('drain deduplicates a previously emitted entry_id and removes only that queue row', (t) => {
  const { stateRoot, sessionRoot } = makeProject(t);
  const entry = { entry_id: 'same', seed_id: 2, condition: 'user_requested', final_q: 0.2, experiments_used: 3, queued_at: '2026-01-01T00:00:00Z' };
  fs.writeFileSync(path.join(sessionRoot, 'kill_queue.jsonl'), `${JSON.stringify(entry)}\n`);
  fs.writeFileSync(path.join(sessionRoot, 'journal.jsonl'), `${JSON.stringify({ event: 'seed_killed', entry_id: 'same', seed_id: 2 })}\n`);
  const result = drainKillQueue({ stateRoot, sessionId: 's1', completedSeedId: 2 });
  assert.equal(result.drained, 1);
  assert.equal(readJsonl({ stateRoot, relativePath: 's1/journal.jsonl' }).records.length, 1);
  assert.deepEqual(readJsonl({ stateRoot, relativePath: 's1/kill_queue.jsonl' }).records, []);
});

test('drain versus append race preserves the concurrent append exactly once', async (t) => {
  const { stateRoot } = makeProject(t, 'evolve-drain-race-');
  queueKill({
    stateRoot, sessionId: 's1', seedId: 2, condition: 'user_requested', finalQ: 0.2,
    experimentsUsed: 3, randomUUID: () => 'drained-entry',
  });
  const script = `
    const { queueKill } = require(${JSON.stringify(JOURNAL_STORE)});
    queueKill({stateRoot:${JSON.stringify(stateRoot)},sessionId:'s1',seedId:3,
      condition:'crash_give_up',finalQ:0.1,experimentsUsed:4,randomUUID:()=> 'concurrent-entry'});
  `;
  let child;
  drainKillQueue({
    stateRoot, sessionId: 's1', completedSeedId: 2,
    onPhase(name) {
      if (name === 'drain-snapshot') {
        child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
    },
  });
  const completed = await waitForChild(child);
  assert.equal(completed.code, 0, completed.stderr);
  const queue = readJsonl({ stateRoot, relativePath: 's1/kill_queue.jsonl' }).records;
  assert.deepEqual(queue.map((row) => row.entry_id), ['concurrent-entry']);
  const journal = readJsonl({ stateRoot, relativePath: 's1/journal.jsonl' }).records;
  assert.deepEqual(journal.map((row) => row.entry_id), ['drained-entry']);
});

test('malformed kill queue drain is fail-closed and byte-identical', (t) => {
  const { stateRoot, sessionRoot } = makeProject(t);
  const raw = fs.readFileSync(path.join(MALFORMED, 'kill_queue.jsonl'));
  fs.writeFileSync(path.join(sessionRoot, 'kill_queue.jsonl'), raw);
  const before = treeSnapshot(stateRoot);
  assert.throws(() => drainKillQueue({ stateRoot, sessionId: 's1', completedSeedId: 1 }), (error) => error.rc === 2);
  assert.deepEqual(treeSnapshot(stateRoot), before);
});

test('queue-user-kill and all coordination dispatcher operations preserve envelopes', (t) => {
  const { projectRoot, stateRoot, sessionId } = makeProject(t);
  const queued = request(projectRoot, 'coord.queue-user-kill', { session_id: sessionId, seed_id: 2 });
  assert.equal(queued.exitCode, 0);
  assert.equal(queued.result.confirmed, false);
  const records = readJsonl({ stateRoot, relativePath: 's1/kill_requests.jsonl' }).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].seed_id, 2);
  assert.match(records[0].entry_id, /^[0-9a-f-]{36}$/);

  const direct = queueUserKill({ stateRoot, sessionId, seedId: 3, randomUUID: () => 'u-2' });
  assert.equal(direct.entry_id, 'u-2');
  const invalid = request(projectRoot, 'coord.queue-user-kill', { session_id: sessionId, seed_id: true });
  assert.equal(invalid.exitCode, 2);
  for (const operation of [
    'coord.append-journal', 'coord.append-forum', 'coord.tail-forum',
    'coord.quarantine-malformed', 'coord.queue-user-kill', 'coord.queue-kill',
    'coord.drain-kill-queue',
  ]) assert.ok(OPERATIONS.includes(operation), operation);
});

test('every Task 4 coordination operation executes through the dispatcher', (t) => {
  const { projectRoot, stateRoot, sessionRoot, sessionId } = makeProject(t, 'evolve-coord-dispatch-all-');
  const call = (operation, payload) => request(projectRoot, operation, { session_id: sessionId, ...payload });
  assert.equal(call('coord.append-journal', { event: { event: 'planned' }, seed_id: 1 }).exitCode, 0);
  assert.equal(call('coord.append-forum', { event: { event: 'seed_keep', commit: 'a' }, seed_id: 1 }).exitCode, 0);
  assert.equal(call('coord.tail-forum', { limit: 5 }).exitCode, 0);
  assert.equal(call('coord.queue-user-kill', { seed_id: 2 }).exitCode, 0);
  const queued = call('coord.queue-kill', {
    seed_id: 2, condition: 'user_requested', final_q: 0.2, experiments_used: 3,
  });
  assert.equal(queued.exitCode, 0);
  assert.equal(call('coord.drain-kill-queue', { completed_seed_id: 2 }).exitCode, 0);

  fs.writeFileSync(path.join(sessionRoot, 'forum.jsonl'), fs.readFileSync(path.join(MALFORMED, 'forum.jsonl')));
  const quarantined = call('coord.quarantine-malformed', {
    file: 'forum.jsonl', malformed: [malformedDescriptor()],
  });
  assert.equal(quarantined.exitCode, 0, JSON.stringify(quarantined));
  assert.equal(readJsonl({ stateRoot, relativePath: 's1/forum.jsonl' }).records.length, 2);
});

test('kill-request shell is a thin dispatcher adapter and package excludes six Python oracles and broad shell/Python globs', () => {
  const wrapper = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'scripts', 'kill-request-writer.sh'), 'utf8');
  assert.match(wrapper, /deep-evolve-runtime\.cjs/);
  assert.match(wrapper, /coord\.queue-user-kill/);
  for (const forbidden of ['jq ', 'flock', 'acquire_project_lock', 'printf ', 'kill_requests.jsonl', 'mkdir ', 'find_project_root']) {
    assert.doesNotMatch(wrapper, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json')));
  assert.equal(manifest.files.includes('hooks/scripts/*.py'), false);
  assert.equal(manifest.files.includes('hooks/scripts/*.sh'), false);
  assert.ok(manifest.files.includes('hooks/scripts/kill-request-writer.sh'));
  assert.ok(manifest.files.includes('hooks/scripts/session-helper.sh'));
});

test('supported Node journal store never imports or spawns Python', () => {
  const source = fs.readFileSync(JOURNAL_STORE, 'utf8');
  assert.doesNotMatch(source, /python|spawnSync|execFileSync|child_process/i);
});
