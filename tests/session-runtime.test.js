'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { parseStateDocument } = require('../hooks/scripts/runtime/session-codec.cjs');

const RUNTIME = path.resolve(__dirname, '..', 'hooks', 'scripts', 'deep-evolve-runtime.cjs');
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'runtime');
const { dispatch, main } = require(RUNTIME);
let requestCounter = 0;

function makeProject(label = 'project with spaces') {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-session-'));
  const root = path.join(outer, label);
  fs.mkdirSync(path.join(root, '.deep-evolve'), { recursive: true });
  return { outer, root: fs.realpathSync(root) };
}

function validSession(sessionId, overrides = {}) {
  return {
    session_id: sessionId,
    deep_evolve_version: '3.4.3',
    status: 'active',
    created_at: '2026-07-12T00:00:00Z',
    goal: 'Improve the signal path',
    ...overrides,
  };
}

function writeSession(projectRoot, sessionId, value = validSession(sessionId)) {
  const sessionRoot = path.join(projectRoot, '.deep-evolve', sessionId);
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, 'session.yaml'), `${JSON.stringify(value, null, 2)}\n`);
  return sessionRoot;
}

function writeCurrent(projectRoot, sessionId) {
  fs.writeFileSync(
    path.join(projectRoot, '.deep-evolve', 'current.json'),
    `${JSON.stringify({ session_id: sessionId, started_at: '2026-07-12T00:00:00Z' })}\n`,
  );
}

function request(projectRoot, operation, payload = {}) {
  return {
    schema_version: '1.0',
    operation,
    context: { project_root: projectRoot },
    payload,
  };
}

function runRequest(projectRoot, operation, payload = {}) {
  requestCounter += 1;
  const requestPath = path.join(projectRoot, `request-${process.pid}-${requestCounter}.json`);
  fs.writeFileSync(requestPath, JSON.stringify(request(projectRoot, operation, payload)));
  const result = spawnSync(process.execPath, [RUNTIME, '--request', requestPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 15_000,
  });
  let response;
  try { response = JSON.parse(result.stdout); }
  catch (error) {
    throw new Error(`invalid runtime stdout (${operation}): ${result.stdout}\nstderr: ${result.stderr}`, { cause: error });
  }
  return { ...result, response, requestPath };
}

function expectSuccess(result, operation) {
  assert.equal(result.status, 0, `${operation}: ${result.stderr}\n${result.stdout}`);
  assert.equal(result.response.schema_version, '1.0');
  assert.equal(result.response.ok, true);
  assert.equal(result.response.operation, operation);
  assert.deepEqual(result.response.warnings, result.response.warnings || []);
  return result.response.result;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function publicStartReservation(sessionId, requestDigest, createdAt = '2026-07-12T12:34:56Z') {
  const body = {
    kind: 'deep-evolve-start-reservation',
    session_id: sessionId,
    request_digest: requestDigest,
    created_at: createdAt,
    expected_children: ['runs', 'code-archive', 'strategy-archive', 'meta-analyses'],
    marker_schema_version: '1.0',
  };
  return {
    ...body,
    marker_checksum: `sha256:${sha256(canonicalJson(body))}`,
  };
}

function boundStartReservation(sessionId, goal, reservationNonce, namespaceIdentity) {
  const body = {
    kind: 'deep-evolve-start-reservation',
    session_id: sessionId,
    request_digest: startRequestDigestForTest(goal),
    created_at: '2026-07-12T12:34:56Z',
    reservation_nonce: reservationNonce,
    namespace_identity: namespaceIdentity,
    expected_children: ['runs', 'code-archive', 'strategy-archive', 'meta-analyses'],
    marker_schema_version: '1.0',
  };
  return {
    ...body,
    marker_checksum: `sha256:${sha256(canonicalJson(body))}`,
  };
}

function startRequestDigestForTest(goal, parent = null) {
  return `sha256:${sha256(JSON.stringify({ goal, parent_session_id: parent }))}`;
}

function writeForgedStartReservation(stateRoot, sessionId, goal, sidecarRoot = null) {
  const reservationRoot = sidecarRoot || path.join(stateRoot, '.start-reservations');
  fs.mkdirSync(reservationRoot, { recursive: true });
  const namespace = path.join(stateRoot, sessionId);
  fs.mkdirSync(namespace);
  for (const child of ['runs', 'code-archive', 'strategy-archive', 'meta-analyses']) {
    fs.mkdirSync(path.join(namespace, child));
  }
  const marker = publicStartReservation(sessionId, startRequestDigestForTest(goal));
  const bytes = `${JSON.stringify(marker, null, 2)}\n`;
  fs.writeFileSync(path.join(namespace, '.start-reservation.json'), bytes);
  fs.writeFileSync(path.join(reservationRoot, `${sessionId}.json`), bytes);
  return { marker, bytes, namespace, reservationRoot };
}

function snapshotTree(root) {
  const result = {};
  if (!fs.existsSync(root)) return result;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        result[`${relative}/`] = '<directory>';
        visit(absolute);
      } else if (entry.isFile()) result[relative] = fs.readFileSync(absolute).toString('base64');
      else result[relative] = '<special>';
    }
  };
  visit(root);
  return result;
}

function statIdentity(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
  };
}

function assertSameFilesystemObject(actual, expected, message) {
  assert.deepEqual({ dev: actual.dev, ino: actual.ino, mode: actual.mode }, {
    dev: expected.dev, ino: expected.ino, mode: expected.mode,
  }, message);
}

function copyFixtureDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyFixtureDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

function legacyFixtureGroups() {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'legacy-byte-manifest.json')));
  const groups = new Map();
  for (const entry of manifest.files) {
    const parts = entry.copy.split('/');
    const group = parts[1] === 'kill' ? parts.slice(0, 3).join('/') : parts.slice(0, 2).join('/');
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  }
  return { manifest, groups };
}

function fixedMigrationDependencies(extra = {}) {
  return {
    now: () => Date.parse('2026-07-12T12:34:56Z'),
    ...extra,
  };
}

function recordingMigrationIo(events, {
  failStageFile = null,
  failStageCode = 'EIO',
  failStageCount = Number.POSITIVE_INFINITY,
  denyDirectoryOpen = false,
} = {}) {
  const descriptorPaths = new Map();
  let stageFailures = 0;
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (filePath, flags, ...args) => {
          if (flags === 'r' && target.existsSync(filePath) && target.statSync(filePath).isDirectory()) {
            events.push({ kind: 'directory-open', path: String(filePath) });
            if (denyDirectoryOpen) throw Object.assign(new Error('directory handles forbidden'), { code: 'EPERM' });
          }
          const descriptor = target.openSync(filePath, flags, ...args);
          descriptorPaths.set(descriptor, String(filePath));
          events.push({ kind: 'open', path: String(filePath), flags });
          return descriptor;
        };
      }
      if (property === 'fsyncSync') {
        return (descriptor) => {
          const filePath = descriptorPaths.get(descriptor) || `<fd:${descriptor}>`;
          events.push({ kind: 'fsync', path: filePath });
          if (failStageFile
              && filePath.includes(`${path.sep}stage${path.sep}`)
              && filePath.includes(`.${failStageFile}.tmp.`)
              && stageFailures < failStageCount) {
            stageFailures += 1;
            throw Object.assign(new Error(`injected fsync failure for ${failStageFile}`), {
              code: failStageCode,
            });
          }
          return target.fsyncSync(descriptor);
        };
      }
      if (property === 'closeSync') {
        return (descriptor) => {
          try { return target.closeSync(descriptor); }
          finally { descriptorPaths.delete(descriptor); }
        };
      }
      if (property === 'renameSync') {
        return (from, to) => {
          events.push({ kind: 'rename', from: String(from), to: String(to) });
          return target.renameSync(from, to);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function makeFlatLegacyProject(label = 'flat migration fixture') {
  const project = makeProject(label);
  const evolve = path.join(project.root, '.deep-evolve');
  const files = {
    'session.yaml': Buffer.from([
      'session_id: old-flat',
      'deep_evolve_version: "3.0.0"',
      'status: active',
      'created_at: "2026-01-01T00:00:00Z"',
      'goal: "Legacy Goal"',
      '',
    ].join('\r\n')),
    'journal.jsonl': Buffer.from('{"id":1,"status":"planned"}\r\n'),
  };
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(evolve, name), bytes);
  return {
    ...project,
    evolve,
    files,
    sessionId: 'legacy-2026-07-12T12-34-56Z_legacy-goal',
  };
}

function runLegacyRuntime(projectRoot, args, { env = process.env, timeout = 15_000 } = {}) {
  return spawnSync(process.execPath, [RUNTIME, '--legacy-session-helper', ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    timeout,
  });
}

function captureLegacyMain(projectRoot, args, { env = {}, dependencies = {} } = {}) {
  const originalCwd = process.cwd();
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const savedEnv = new Map();
  let stdout = '';
  let stderr = '';
  for (const [key, value] of Object.entries(env)) {
    savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  process.stdout.write = (chunk, ...rest) => {
    stdout += String(chunk);
    const callback = rest.find((value) => typeof value === 'function');
    if (callback) callback();
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    stderr += String(chunk);
    const callback = rest.find((value) => typeof value === 'function');
    if (callback) callback();
    return true;
  };
  try {
    process.chdir(projectRoot);
    const status = main(['--legacy-session-helper', ...args], dependencies);
    return { status, stdout, stderr };
  } finally {
    process.chdir(originalCwd);
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function coordinationLockRaceIo(lockOrdinal, inject) {
  let projectLockAttempts = 0;
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'mkdirSync') {
        return (candidate, ...args) => {
          const options = args[0];
          const recursiveParentEnsure = options && typeof options === 'object' && options.recursive === true;
          if (path.basename(String(candidate)) === '.coordination-lock' && !recursiveParentEnsure) {
            projectLockAttempts += 1;
            if (projectLockAttempts === lockOrdinal) inject();
          }
          return target.mkdirSync(candidate, ...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function seedCommittedTransaction(projectRoot, replacements, crashAt = 'after-commit-marker') {
  const store = path.resolve(__dirname, '..', 'hooks', 'scripts', 'runtime', 'session-store.cjs');
  const stateRoot = path.join(projectRoot, '.deep-evolve');
  const script = [
    "const {commitCoordinationTransaction}=require(process.argv[1]);",
    "const stateRoot=process.argv[2];",
    "const replacements=JSON.parse(process.argv[3]);",
    "const crashAt=process.argv[4];",
    "const result=commitCoordinationTransaction(stateRoot,replacements,{crashAt,crashExitCode:86});",
    "process.stdout.write(JSON.stringify(result));",
  ].join('');
  const result = spawnSync(process.execPath, ['-e', script, store, stateRoot,
    JSON.stringify(replacements), crashAt], { encoding: 'utf8' });
  assert.equal(result.status, 86, `failed to seed committed transaction: ${result.stderr}\n${result.stdout}`);
  const txRoot = path.join(stateRoot, '.transactions');
  assert.equal(fs.existsSync(txRoot), true);
  assert.equal(fs.readdirSync(txRoot).some((name) => name.startsWith('tx-')), true);
}

function waitForPath(candidate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(candidate)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${candidate}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function collectChild(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function assertNoPendingCoordinationTransaction(projectRoot) {
  const txRoot = path.join(projectRoot, '.deep-evolve', '.transactions');
  assert.deepEqual(fs.existsSync(txRoot) ? fs.readdirSync(txRoot) : [] , []);
}

function crashLegacyRuntime(projectRoot, args, crashAt, env = {}) {
  const script = [
    "const runtime=require(process.argv[1]);",
    "process.chdir(process.argv[2]);",
    "Object.assign(process.env,JSON.parse(process.argv[3]));",
    "const args=JSON.parse(process.argv[4]);",
    "const crashAt=process.argv[5];",
    "const rc=runtime.main(['--legacy-session-helper',...args],",
    "{coordinationOptions:{crashAt,crashExitCode:86}});",
    "process.exitCode=rc;",
  ].join('');
  return spawnSync(process.execPath, ['-e', script, RUNTIME, projectRoot, JSON.stringify(env),
    JSON.stringify(args), crashAt], { encoding: 'utf8', timeout: 15_000 });
}

function crashStartSession(projectRoot, crashAt, goal = 'Recoverable Start') {
  const script = [
    "const runtime=require(process.argv[1]);",
    "const root=process.argv[2];",
    "const crashAt=process.argv[3];",
    "const goal=process.argv[4];",
    "const request={schema_version:'1.0',operation:'session.start',",
    "context:{project_root:root},payload:{goal}};",
    "const response=runtime.dispatch(request,{",
    "now:()=>Date.parse('2026-07-12T12:34:56Z'),",
    "coordinationOptions:{crashAt,crashExitCode:86}});",
    "process.stdout.write(JSON.stringify(response));",
  ].join('');
  return spawnSync(process.execPath, ['-e', script, RUNTIME, projectRoot, crashAt, goal], {
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function seedCommittedPrivateStart(projectRoot, {
  sessionId = '2026-07-12_recovery-cutpoint',
  goal = 'Recovery Cutpoint',
  nonce = 'b'.repeat(32),
  children = [],
  includeMarker = true,
} = {}) {
  const stateRoot = path.join(projectRoot, '.deep-evolve');
  const reservationRoot = path.join(stateRoot, '.start-reservations');
  fs.mkdirSync(reservationRoot, { mode: 0o700 });
  const privateRoot = path.join(reservationRoot, `.namespace-${nonce}`);
  fs.mkdirSync(privateRoot, { mode: 0o700 });
  const identity = statIdentity(privateRoot);
  const marker = boundStartReservation(sessionId, goal, nonce, {
    dev: identity.dev,
    ino: identity.ino,
  });
  const markerBytes = `${JSON.stringify(marker, null, 2)}\n`;
  if (includeMarker) fs.writeFileSync(path.join(privateRoot, '.start-reservation.json'), markerBytes);
  for (const child of children) fs.mkdirSync(path.join(privateRoot, child));
  const sidecarPath = path.join(reservationRoot, `${sessionId}.${nonce}.json`);
  fs.writeFileSync(sidecarPath, markerBytes);
  fs.writeFileSync(path.join(stateRoot, 'sessions.jsonl'), `${JSON.stringify({
    event: 'created', ts: '2026-07-12T12:34:56Z', session_id: sessionId,
    goal, status: 'initializing',
  })}\n`);
  fs.writeFileSync(path.join(stateRoot, 'current.json'), `${JSON.stringify({
    session_id: sessionId, started_at: '2026-07-12T12:34:56Z',
  })}\n`);
  return {
    stateRoot,
    reservationRoot,
    privateRoot,
    sidecarPath,
    markerPath: path.join(privateRoot, '.start-reservation.json'),
    marker,
    identity,
    sessionId,
    goal,
    nonce,
  };
}

function crashCommittedRecovery(projectRoot, goal, crashAt) {
  return crashStartSession(projectRoot, crashAt, goal);
}

function replacePathWithForeign(candidate, kind, bytes) {
  const owned = `${candidate}.owned-for-test`;
  fs.renameSync(candidate, owned);
  if (kind === 'directory') {
    fs.mkdirSync(candidate, { mode: 0o751 });
    fs.writeFileSync(path.join(candidate, 'FOREIGN.txt'), bytes);
  } else {
    fs.writeFileSync(candidate, bytes, { mode: 0o640 });
  }
  return { owned, foreign: candidate };
}

function populateStartedSession(projectRoot, started, label = 'populated') {
  const publicRoot = started.session_root;
  const privateRoot = fs.realpathSync(publicRoot);
  fs.writeFileSync(path.join(privateRoot, 'session.yaml'), `${JSON.stringify(validSession(
    started.session_id,
    { goal: `${label} goal`, status: 'active' },
  ), null, 2)}\n`);
  fs.writeFileSync(path.join(privateRoot, 'journal.jsonl'), `${JSON.stringify({
    id: 41, status: 'committed', commit: `${label}-commit`,
  })}\n`);
  fs.writeFileSync(path.join(privateRoot, 'ordinary.txt'), `${label}-ordinary\n`);
  fs.writeFileSync(path.join(privateRoot, 'runs', 'run-1.txt'), `${label}-run\n`);
  fs.writeFileSync(path.join(privateRoot, 'code-archive', 'archive-1.txt'), `${label}-archive\n`);
  return { publicRoot, privateRoot };
}

test('resolve-current and read return canonical native results and reconcile status', () => {
  const { outer, root } = makeProject();
  const sid = 's1';
  const sessionRoot = writeSession(root, sid);
  writeCurrent(root, sid);
  fs.writeFileSync(path.join(root, '.deep-evolve', 'sessions.jsonl'), `${JSON.stringify({
    event: 'created', ts: '2026-07-12T00:00:00Z', session_id: sid, status: 'initializing', goal: 'g',
  })}\n`);
  try {
    const resolved = expectSuccess(runRequest(root, 'session.resolve-current'), 'session.resolve-current');
    assert.deepEqual(resolved, { session_id: sid, session_root: sessionRoot });
    const lines = fs.readFileSync(path.join(root, '.deep-evolve', 'sessions.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    assert.equal(lines.at(-1).event, 'reconciled');
    assert.equal(lines.at(-1).from, 'initializing');
    assert.equal(lines.at(-1).to, 'active');

    const read = expectSuccess(runRequest(root, 'session.read', { session_id: sid }), 'session.read');
    assert.deepEqual(read.session, validSession(sid));
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('list reduces lifecycle envelopes, applies filters, and lineage preserves event order', () => {
  const { outer, root } = makeProject('registry project');
  const records = [
    { event: 'created', ts: 't1', session_id: 'a', goal: 'A', status: 'initializing' },
    { event: 'created', ts: 't2', session_id: 'b', goal: 'B', status: 'active' },
    { event: 'lineage_set', ts: 't3', session_id: 'b', parent_session_id: 'a' },
    { event: 'status_change', ts: 't4', session_id: 'a', status: 'completed' },
    { event: 'reconciled', ts: 't5', session_id: 'b', from: 'active', to: 'paused' },
    { event: 'finished', ts: 't6', session_id: 'a', status: 'completed', outcome: 'kept' },
  ];
  fs.writeFileSync(
    path.join(root, '.deep-evolve', 'sessions.jsonl'),
    `${records.map(JSON.stringify).join('\n')}\n`,
  );
  try {
    const listed = expectSuccess(runRequest(root, 'session.list'), 'session.list').sessions;
    assert.deepEqual(listed.map((entry) => entry.session_id), ['a', 'b']);
    assert.equal(listed[0].status, 'completed');
    assert.equal(listed[0].outcome, 'kept');
    assert.equal(listed[1].status, 'paused');
    assert.equal(listed[1].parent_session_id, 'a');

    const filtered = expectSuccess(
      runRequest(root, 'session.list', { status: 'paused' }),
      'session.list',
    ).sessions;
    assert.deepEqual(filtered.map((entry) => entry.session_id), ['b']);

    const lineage = expectSuccess(runRequest(root, 'session.lineage-tree'), 'session.lineage-tree');
    assert.deepEqual(lineage.lines, ['a <- (root)', 'b <- a']);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('start, mark-status, typed patch, and complete use atomic state transitions', () => {
  const { outer, root } = makeProject('lifecycle with spaces');
  try {
    const started = expectSuccess(runRequest(root, 'session.start', {
      goal: 'Improve Signals!',
      parent_session_id: 'parent-1',
    }), 'session.start');
    assert.match(started.session_id, /^\d{4}-\d{2}-\d{2}_improve-signals(?:-\d+)?$/);
    assert.equal(started.session_root, path.join(root, '.deep-evolve', started.session_id));
    assert.equal(fs.statSync(started.session_root).isDirectory(), true,
      'the public session_root contract remains directory-like to every consumer');
    assert.equal(fs.lstatSync(started.session_root).isSymbolicLink(), true,
      'publication must be one atomic no-replace directory link/junction');
    assert.equal(path.isAbsolute(fs.readlinkSync(started.session_root)), true,
      'the backing target must be absolute on both POSIX and Windows junctions');
    const privateRoot = fs.realpathSync(started.session_root);
    assert.equal(fs.statSync(privateRoot, { bigint: true }).dev,
      fs.statSync(path.join(root, '.deep-evolve'), { bigint: true }).dev,
      'public and private authorities must stay on the same filesystem volume');
    for (const name of ['runs', 'code-archive', 'strategy-archive', 'meta-analyses']) {
      assert.equal(fs.statSync(path.join(started.session_root, name)).isDirectory(), true);
    }
    const pointer = JSON.parse(fs.readFileSync(path.join(root, '.deep-evolve', 'current.json')));
    assert.equal(pointer.session_id, started.session_id);

    writeSession(root, started.session_id, validSession(started.session_id, {
      status: 'initializing',
      goal: 'Improve Signals!',
      lineage: { current_branch: 'main' },
    }));

    const resolvedStarted = expectSuccess(
      runRequest(root, 'session.resolve-current'), 'session.resolve-current',
    );
    assert.equal(resolvedStarted.session_root, started.session_root,
      'public API must not leak the private retained backing path');

    const marked = expectSuccess(runRequest(root, 'session.mark-status', {
      session_id: started.session_id,
      status: 'active',
    }), 'session.mark-status');
    assert.deepEqual(marked, { session_id: started.session_id, status: 'active' });

    const patched = expectSuccess(runRequest(root, 'session.patch', {
      session_id: started.session_id,
      path: '/goal',
      value: 'A safer goal',
    }), 'session.patch');
    assert.equal(patched.session.goal, 'A safer goal');

    const invalidPatch = runRequest(root, 'session.patch', {
      session_id: started.session_id,
      path: '/session_id',
      value: 'hijacked',
    });
    assert.equal(invalidPatch.status, 2);
    assert.equal(invalidPatch.response.error.code, 'patch_path_not_allowed');
    assert.equal(parseStateDocument(
      fs.readFileSync(path.join(started.session_root, 'session.yaml'), 'utf8'),
    ).session_id, started.session_id);

    const invalidType = runRequest(root, 'session.patch', {
      session_id: started.session_id,
      path: '/goal',
      value: { arbitrary: 'object' },
    });
    assert.equal(invalidType.status, 2);
    assert.equal(invalidType.response.error.code, 'patch_type_invalid');

    const completed = expectSuccess(runRequest(root, 'session.complete', {
      session_id: started.session_id,
      outcome: 'kept',
    }), 'session.complete');
    assert.equal(completed.status, 'completed');
    const finalSession = parseStateDocument(
      fs.readFileSync(path.join(started.session_root, 'session.yaml'), 'utf8'),
    );
    assert.equal(finalSession.status, 'completed');
    const events = fs.readFileSync(path.join(root, '.deep-evolve', 'sessions.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).event, 'finished');
    assert.equal(events.at(-1).outcome, 'kept');
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('session.start crash reservations retry to one deterministic unsuffixed namespace', () => {
  const fixedNow = () => Date.parse('2026-07-12T12:34:56Z');
  const expectedId = '2026-07-12_recoverable-start';
  for (const crashAt of [
    'after-start-root-before-marker',
    'after-start-root',
    'after-start-children',
    'before-commit-marker',
    'after-commit-marker',
  ]) {
    const { outer, root } = makeProject(`start crash ${crashAt}`);
    try {
      const crashed = crashStartSession(root, crashAt);
      assert.equal(crashed.status, 86,
        `${crashAt}: child did not stop at the requested real-process cutpoint\n${crashed.stderr}\n${crashed.stdout}`);

      const retry = dispatch(request(root, 'session.start', { goal: 'Recoverable Start' }), {
        now: fixedNow,
      });
      assert.equal(retry.ok, true, `${crashAt}: ${JSON.stringify(retry)}`);
      assert.equal(retry.result.session_id, expectedId, `${crashAt}: retry drifted to a suffixed id`);

      const stateRoot = path.join(root, '.deep-evolve');
      const namespaces = fs.readdirSync(stateRoot).filter((name) => name.startsWith(expectedId));
      assert.deepEqual(namespaces, [expectedId], `${crashAt}: orphan or suffixed namespace remains`);
      for (const name of ['runs', 'code-archive', 'strategy-archive', 'meta-analyses']) {
        assert.equal(fs.statSync(path.join(stateRoot, expectedId, name)).isDirectory(), true,
          `${crashAt}: missing child ${name}`);
      }
      const reservationRoot = path.join(stateRoot, '.start-reservations');
      const publicRoot = path.join(stateRoot, expectedId);
      assert.equal(fs.lstatSync(publicRoot).isSymbolicLink(), true,
        `${crashAt}: public namespace must be an atomic directory link`);
      const privateRoot = fs.realpathSync(publicRoot);
      assert.equal(path.dirname(privateRoot), reservationRoot,
        `${crashAt}: public namespace escaped its private same-volume authority`);
      const evidence = fs.readdirSync(reservationRoot).sort();
      assert.equal(evidence.filter((name) => name.startsWith('.namespace-')).length, 1,
        `${crashAt}: authenticated backing namespace was not retained exactly once`);
      assert.equal(evidence.filter((name) => name.endsWith('.json')).length, 1,
        `${crashAt}: immutable sidecar was not retained exactly once`);
      assert.equal(fs.existsSync(path.join(privateRoot, '.start-reservation.json')), true,
        `${crashAt}: namespace reservation evidence is missing`);
      assert.equal(fs.existsSync(path.join(privateRoot, '.start-publication.json')), true,
        `${crashAt}: public-entry identity evidence is missing`);
      assert.equal(fs.existsSync(path.join(privateRoot, '.start-finalized.json')), true,
        `${crashAt}: finalization evidence is missing`);
      assertNoPendingCoordinationTransaction(root);

      const records = fs.readFileSync(path.join(stateRoot, 'sessions.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(JSON.parse);
      assert.deepEqual(records.filter((event) => event.event === 'created')
        .map((event) => event.session_id), [expectedId],
      `${crashAt}: retry registered anything other than one original namespace`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(stateRoot, 'current.json'), 'utf8')).session_id,
        expectedId);

      const next = dispatch(request(root, 'session.start', { goal: 'Recoverable Start' }), {
        now: fixedNow,
      });
      assert.equal(next.ok, true, `${crashAt}/next: ${JSON.stringify(next)}`);
      assert.equal(next.result.session_id, `${expectedId}-2`,
        `${crashAt}: a completed retry left a stale reservation that was adopted again`);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('session.start survives the real-process cutpoint immediately after the atomic public claim', () => {
  const { outer, root } = makeProject('start public claim crash');
  const expectedId = '2026-07-12_public-claim-crash';
  try {
    const crashed = crashStartSession(root, 'after-start-public-claim', 'Public Claim Crash');
    assert.equal(crashed.status, 86,
      `public claim cutpoint was not reached\n${crashed.stderr}\n${crashed.stdout}`);

    const retry = dispatch(request(root, 'session.start', { goal: 'Public Claim Crash' }), {
      now: () => Date.parse('2026-07-12T12:34:56Z'),
    });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(retry.result.session_id, expectedId);
    assert.equal(fs.existsSync(path.join(root, '.deep-evolve', `${expectedId}-2`)), false);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('legacy and canonical start routes share registry collision and pending-recovery authority', () => {
  const fixed = () => Date.parse('2026-07-12T12:34:56Z');
  const sessionId = '2026-07-12_cross-route';

  {
    const { outer, root } = makeProject('legacy then canonical start');
    try {
      const legacy = captureLegacyMain(root, ['start_new_session', 'Cross Route'], {
        dependencies: { now: fixed },
      });
      assert.equal(legacy.status, 0, legacy.stderr);
      assert.equal(legacy.stdout, `${sessionId}\t${path.join(root, '.deep-evolve', sessionId)}\n`);
      assert.equal(fs.lstatSync(path.join(root, '.deep-evolve', sessionId)).isDirectory(), true);

      const canonical = dispatch(request(root, 'session.start', { goal: 'Cross Route' }), {
        now: fixed,
      });
      assert.equal(canonical.ok, true, JSON.stringify(canonical));
      assert.equal(canonical.result.session_id, `${sessionId}-2`);
      assert.equal(fs.lstatSync(canonical.result.session_root).isSymbolicLink(), true);
      const records = fs.readFileSync(path.join(root, '.deep-evolve', 'sessions.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(JSON.parse);
      assert.deepEqual(records.filter((event) => event.event === 'created')
        .map((event) => event.session_id), [sessionId, `${sessionId}-2`]);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  }

  {
    const { outer, root } = makeProject('canonical then legacy start');
    try {
      const canonical = dispatch(request(root, 'session.start', { goal: 'Cross Route' }), {
        now: fixed,
      });
      assert.equal(canonical.ok, true, JSON.stringify(canonical));
      assert.equal(canonical.result.session_id, sessionId);
      const legacy = captureLegacyMain(root, ['start_new_session', 'Cross Route'], {
        dependencies: { now: fixed },
      });
      assert.equal(legacy.status, 0, legacy.stderr);
      assert.match(legacy.stdout, new RegExp(`^${sessionId}-2\\t`));
      assert.equal(fs.lstatSync(path.join(root, '.deep-evolve', `${sessionId}-2`)).isDirectory(), true);
      const records = fs.readFileSync(path.join(root, '.deep-evolve', 'sessions.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(JSON.parse);
      assert.deepEqual(records.filter((event) => event.event === 'created')
        .map((event) => event.session_id), [sessionId, `${sessionId}-2`]);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  }

  {
    const { outer, root } = makeProject('canonical pending then legacy retry');
    try {
      const crashed = crashStartSession(root, 'after-start-public-claim', 'Cross Route');
      assert.equal(crashed.status, 86, crashed.stderr);
      const legacyRetry = captureLegacyMain(root, ['start_new_session', 'Cross Route'], {
        dependencies: { now: fixed },
      });
      assert.equal(legacyRetry.status, 0, legacyRetry.stderr);
      assert.equal(legacyRetry.stdout, `${sessionId}\t${path.join(root, '.deep-evolve', sessionId)}\n`);
      assert.equal(fs.lstatSync(path.join(root, '.deep-evolve', sessionId)).isSymbolicLink(), true,
        'legacy retry must finish the existing canonical owner, not create a second protocol owner');
      const records = fs.readFileSync(path.join(root, '.deep-evolve', 'sessions.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(JSON.parse);
      assert.deepEqual(records.filter((event) => event.event === 'created')
        .map((event) => event.session_id), [sessionId]);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  }
});

test('populated finalized sessions do not block later canonical and legacy route starts', () => {
  const fixed = () => Date.parse('2026-07-12T12:34:56Z');
  const baseId = '2026-07-12_populated-route';
  for (const order of [
    ['canonical', 'legacy'],
    ['legacy', 'canonical'],
  ]) {
    const { outer, root } = makeProject(`populated ${order.join(' then ')}`);
    try {
      let first;
      if (order[0] === 'canonical') {
        const response = dispatch(request(root, 'session.start', { goal: 'Populated Route' }), {
          now: fixed,
        });
        assert.equal(response.ok, true, JSON.stringify(response));
        first = response.result;
      } else {
        const response = captureLegacyMain(root, ['start_new_session', 'Populated Route'], {
          dependencies: { now: fixed },
        });
        assert.equal(response.status, 0, response.stderr);
        const [sessionId, sessionRoot] = response.stdout.trim().split('\t');
        first = { session_id: sessionId, session_root: sessionRoot };
      }
      assert.equal(first.session_id, baseId);
      const populated = populateStartedSession(root, first, order.join('-'));
      const firstPublicIdentity = statIdentity(populated.publicRoot);
      const firstPrivateIdentity = statIdentity(populated.privateRoot);
      const firstPrivateTree = snapshotTree(populated.privateRoot);

      let second;
      if (order[1] === 'canonical') {
        const response = dispatch(request(root, 'session.start', { goal: 'Populated Route' }), {
          now: fixed,
        });
        assert.equal(response.ok, true, `${order.join('->')}: ${JSON.stringify(response)}`);
        second = response.result;
      } else {
        const response = captureLegacyMain(root, ['start_new_session', 'Populated Route'], {
          dependencies: { now: fixed },
        });
        assert.equal(response.status, 0, `${order.join('->')}: ${response.stderr}`);
        const [sessionId, sessionRoot] = response.stdout.trim().split('\t');
        second = { session_id: sessionId, session_root: sessionRoot };
      }

      assert.equal(second.session_id, `${baseId}-2`, order.join('->'));
      assertSameFilesystemObject(statIdentity(populated.publicRoot), firstPublicIdentity,
        `${order.join('->')}: first public namespace identity changed`);
      assertSameFilesystemObject(statIdentity(populated.privateRoot), firstPrivateIdentity,
        `${order.join('->')}: first backing namespace identity changed`);
      assert.deepEqual(snapshotTree(populated.privateRoot), firstPrivateTree,
        `${order.join('->')}: retained live contents or immutable evidence changed`);
      const records = fs.readFileSync(path.join(root, '.deep-evolve', 'sessions.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(JSON.parse);
      assert.deepEqual(records.filter((event) => event.event === 'created')
        .map((event) => event.session_id), [baseId, `${baseId}-2`]);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('committed recovery survives every child, bind, marker, and old-inode real-process cutpoint', () => {
  const phases = [
    ...['runs', 'code-archive', 'strategy-archive', 'meta-analyses']
      .map((name) => `after-start-recovery-child:${name}`),
    'after-start-recovery-sidecar-bind',
    'after-start-recovery-marker-durable',
    'before-start-recovery-old-inode-cleanup',
    'after-start-recovery-old-inode-cleanup',
  ];
  for (const phase of phases) {
    const { outer, root } = makeProject(`recovery cutpoint ${phase}`);
    const seeded = seedCommittedPrivateStart(root, {
      sessionId: '2026-07-12_recovery-cutpoint',
      goal: 'Recovery Cutpoint',
      children: [],
      includeMarker: phase !== 'after-start-recovery-marker-durable',
    });
    try {
      const crashed = crashCommittedRecovery(root, seeded.goal, phase);
      assert.equal(crashed.status, 86,
        `${phase}: real-process cutpoint was not reached\n${crashed.stderr}\n${crashed.stdout}`);

      const retry = dispatch(request(root, 'session.start', { goal: seeded.goal }), {
        now: () => Date.parse('2026-07-12T12:34:56Z'),
      });
      assert.equal(retry.ok, true, `${phase}: ${JSON.stringify(retry)}`);
      assert.equal(retry.result.session_id, seeded.sessionId);
      assertSameFilesystemObject(statIdentity(seeded.privateRoot), seeded.identity,
        `${phase}: authenticated private inode was replaced or removed`);
      for (const child of ['runs', 'code-archive', 'strategy-archive', 'meta-analyses']) {
        assert.equal(fs.statSync(path.join(seeded.privateRoot, child)).isDirectory(), true,
          `${phase}: missing recovery child ${child}`);
      }
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('post-claim public replacement is never populated during initial start or committed recovery', () => {
  const cases = [
    {
      label: 'initial',
      phase: 'after-start-public-claim',
      prepare() {},
      goal: 'Initial Public Replacement',
    },
    {
      label: 'recovery',
      phase: 'after-start-recovery-public-claim',
      prepare(root) {
        seedCommittedPrivateStart(root, {
          sessionId: '2026-07-12_recovery-public-replacement',
          goal: 'Recovery Public Replacement',
          children: [],
        });
      },
      goal: 'Recovery Public Replacement',
    },
  ];
  for (const fixture of cases) {
    const { outer, root } = makeProject(`${fixture.label} post claim replacement`);
    let injected = false;
    let foreignRoot;
    let foreignIdentity;
    let foreignTree;
    try {
      fixture.prepare(root);
      const result = dispatch(request(root, 'session.start', { goal: fixture.goal }), {
        now: () => Date.parse('2026-07-12T12:34:56Z'),
        coordinationOptions: {
          onPhase(phase, context = {}) {
            if (injected || phase !== fixture.phase || !context.publicRoot) return;
            injected = true;
            foreignRoot = context.publicRoot;
            replacePathWithForeign(foreignRoot, 'directory', `foreign-${fixture.label}`);
            foreignIdentity = statIdentity(foreignRoot);
            foreignTree = snapshotTree(foreignRoot);
          },
        },
      });
      assert.equal(injected, true, `${fixture.label}: post-claim seam was not reached`);
      assert.equal(result.ok, false, `${fixture.label}: ${JSON.stringify(result)}`);
      assert.equal(result.error.code, 'start_reservation_ambiguous');
      assert.deepEqual(statIdentity(foreignRoot), foreignIdentity,
        `${fixture.label}: foreign public identity changed`);
      assert.deepEqual(snapshotTree(foreignRoot), foreignTree,
        `${fixture.label}: foreign public tree was populated or changed`);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('a byte-equivalent post-claim link replacement is foreign and never adopted', () => {
  for (const fixture of [
    { label: 'initial', phase: 'after-start-public-claim', goal: 'Same Target Initial' },
    {
      label: 'recovery',
      phase: 'after-start-recovery-public-claim',
      goal: 'Same Target Recovery',
      prepare(root) {
        seedCommittedPrivateStart(root, {
          sessionId: '2026-07-12_same-target-recovery',
          goal: 'Same Target Recovery',
          children: [],
        });
      },
    },
  ]) {
    const { outer, root } = makeProject(`same target replacement ${fixture.label}`);
    let injected = false;
    let foreignIdentity;
    let foreignRoot;
    try {
      if (fixture.prepare) fixture.prepare(root);
      const result = dispatch(request(root, 'session.start', { goal: fixture.goal }), {
        now: () => Date.parse('2026-07-12T12:34:56Z'),
        coordinationOptions: {
          onPhase(phase, context = {}) {
            if (injected || phase !== fixture.phase) return;
            injected = true;
            foreignRoot = context.publicRoot;
            fs.renameSync(foreignRoot, `${foreignRoot}.owned-for-test`);
            fs.symlinkSync(
              context.privateRoot,
              foreignRoot,
              process.platform === 'win32' ? 'junction' : 'dir',
            );
            foreignIdentity = statIdentity(foreignRoot);
          },
        },
      });
      assert.equal(injected, true);
      assert.equal(result.ok, false, `${fixture.label}: ${JSON.stringify(result)}`);
      assert.equal(result.error.code, 'start_reservation_ambiguous');
      assert.deepEqual(statIdentity(foreignRoot), foreignIdentity,
        `${fixture.label}: same-target foreign link changed`);
      assert.equal(fs.realpathSync(foreignRoot).includes('.start-reservations'), true);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('start finalization performs no path-replacing or destructive cleanup syscall', () => {
  const syscallCases = [
    { kind: 'namespace-claim', syscall: 'renameSync', matches: (from, to) =>
      String(to).includes('.cleanup-namespace-') },
    { kind: 'marker-claim', syscall: 'renameSync', matches: (from, to) =>
      path.basename(String(from)) === '.start-reservation.json' && String(to).includes('.claim-') },
    { kind: 'sidecar-claim', syscall: 'renameSync', matches: (from, to) =>
      String(from).includes('.start-reservations') && String(to).includes('.json.claim-') },
    { kind: 'marker-delete', syscall: 'unlinkSync', matches: (target) =>
      String(target).includes('.start-reservation.json.claim-') },
    { kind: 'sidecar-delete', syscall: 'unlinkSync', matches: (target) =>
      String(target).includes('.json.claim-') },
    { kind: 'namespace-delete', syscall: 'rmdirSync', matches: (target) =>
      path.basename(String(target)).startsWith('.cleanup-namespace-') },
  ];

  for (const fixture of syscallCases) {
    const { outer, root } = makeProject(`destructive cleanup ${fixture.kind}`);
    const seeded = seedCommittedPrivateStart(root, {
      sessionId: `2026-07-12_${fixture.kind}`,
      goal: fixture.kind,
      children: [],
    });
    const original = fs[fixture.syscall];
    let intercepted = 0;
    let foreignPath = null;
    let foreignIdentity = null;
    let foreignBytes = null;
    fs[fixture.syscall] = function injectedDestructiveBoundary(...args) {
      if (fixture.matches(...args)) {
        intercepted += 1;
        const target = fixture.syscall === 'renameSync' ? args[1] : args[0];
        foreignPath = String(target);
        if (fs.existsSync(foreignPath)) {
          const owned = `${foreignPath}.owned-boundary-${intercepted}`;
          original.call(fs, foreignPath, owned);
        }
        if (fixture.kind.startsWith('namespace')) {
          fs.mkdirSync(foreignPath, { mode: 0o751 });
          foreignIdentity = statIdentity(foreignPath);
        } else {
          foreignBytes = `foreign-${fixture.kind}`;
          fs.writeFileSync(foreignPath, foreignBytes, { mode: 0o640 });
          foreignIdentity = statIdentity(foreignPath);
        }
      }
      return original.apply(fs, args);
    };
    try {
      const result = dispatch(request(root, 'session.start', { goal: seeded.goal }), {
        now: () => Date.parse('2026-07-12T12:34:56Z'),
      });
      assert.equal(result.ok, true, `${fixture.kind}: ${JSON.stringify(result)}`);
      assert.equal(intercepted, 0,
        `${fixture.kind}: start finalization reached a forbidden path cleanup syscall`);
      assert.equal(foreignPath, null);
      assert.equal(foreignIdentity, null);
      assert.equal(foreignBytes, null);
      assertSameFilesystemObject(statIdentity(seeded.privateRoot), seeded.identity,
        `${fixture.kind}: the authenticated namespace must remain the live backing store`);
    } finally {
      fs[fixture.syscall] = original;
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('session.start reservation persists a private nonce and captured namespace identity', () => {
  const { outer, root } = makeProject('private start reservation identity');
  try {
    const crashed = crashStartSession(root, 'after-start-root');
    assert.equal(crashed.status, 86, crashed.stderr);
    const stateRoot = path.join(root, '.deep-evolve');
    const reservationRoot = path.join(stateRoot, '.start-reservations');
    const sidecars = fs.readdirSync(reservationRoot).filter((name) => name.endsWith('.json'));
    assert.equal(sidecars.length, 1);
    const sidecar = JSON.parse(fs.readFileSync(path.join(reservationRoot, sidecars[0]), 'utf8'));
    assert.match(sidecar.reservation_nonce, /^[a-f0-9]{32,}$/);
    assert.match(sidecar.namespace_identity.dev, /^\d+$/);
    assert.match(sidecar.namespace_identity.ino, /^\d+$/);
    const candidates = [
      path.join(stateRoot, sidecar.session_id),
      path.join(reservationRoot, `.namespace-${sidecar.reservation_nonce}`),
    ];
    const namespace = candidates.find((candidate) => fs.existsSync(candidate));
    assert.ok(namespace, 'reserved namespace must remain in a contained private or public location');
    const marker = JSON.parse(fs.readFileSync(path.join(namespace, '.start-reservation.json'), 'utf8'));
    assert.equal(marker.reservation_nonce, sidecar.reservation_nonce);
    assert.deepEqual(marker.namespace_identity, sidecar.namespace_identity);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('session.start rejects a forged public-checksum reservation without changing foreign bytes', () => {
  const { outer, root } = makeProject('forged start reservation');
  const stateRoot = path.join(root, '.deep-evolve');
  const sessionId = '2026-07-12_foreign-start';
  try {
    writeForgedStartReservation(stateRoot, sessionId, 'Foreign Start');
    const before = snapshotTree(stateRoot);
    const result = dispatch(request(root, 'session.start', { goal: 'Foreign Start' }), {
      now: () => Date.parse('2026-07-12T12:34:56Z'),
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error.code, /^start_reservation_/);
    assert.deepEqual(snapshotTree(stateRoot), before);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('session.start rejects reservation parent and sidecar symlink escapes without touching targets', () => {
  for (const kind of ['parent', 'sidecar']) {
    const { outer, root } = makeProject(`start reservation ${kind} symlink`);
    const stateRoot = path.join(root, '.deep-evolve');
    const sessionId = `2026-07-12_${kind}-escape`;
    const goal = `${kind} escape`;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-start-outside-'));
    try {
      if (kind === 'parent') {
        const forged = writeForgedStartReservation(stateRoot, sessionId, goal, outside);
        fs.rmSync(path.join(stateRoot, '.start-reservations'), { recursive: true, force: true });
        fs.symlinkSync(outside, path.join(stateRoot, '.start-reservations'),
          process.platform === 'win32' ? 'junction' : 'dir');
        assert.ok(forged.bytes);
      } else {
        const local = writeForgedStartReservation(stateRoot, sessionId, goal);
        const sidecar = path.join(local.reservationRoot, `${sessionId}.json`);
        const target = path.join(outside, 'foreign-reservation.json');
        fs.writeFileSync(target, local.bytes);
        fs.unlinkSync(sidecar);
        fs.symlinkSync(target, sidecar, 'file');
      }
      const beforeState = snapshotTree(stateRoot);
      const beforeOutside = snapshotTree(outside);
      const result = dispatch(request(root, 'session.start', { goal }), {
        now: () => Date.parse('2026-07-12T12:34:56Z'),
      });
      assert.equal(result.ok, false, `${kind}: ${JSON.stringify(result)}`);
      assert.match(result.error.code, /^start_reservation_/);
      assert.deepEqual(snapshotTree(stateRoot), beforeState, `${kind}: state bytes changed`);
      assert.deepEqual(snapshotTree(outside), beforeOutside, `${kind}: escaped target bytes changed`);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test('retained start evidence rejects and preserves every public, marker, publication, sidecar, and finalization replacement', () => {
  for (const kind of ['public-link', 'namespace-marker', 'publication', 'sidecar', 'finalization']) {
    const { outer, root } = makeProject(`retained start replacement ${kind}`);
    try {
      const started = dispatch(request(root, 'session.start', { goal: 'Retained Evidence' }), {
        now: () => Date.parse('2026-07-12T12:34:56Z'),
      });
      assert.equal(started.ok, true, `${kind}: ${JSON.stringify(started)}`);
      const stateRoot = path.join(root, '.deep-evolve');
      const publicRoot = path.join(stateRoot, started.result.session_id);
      const privateRoot = fs.realpathSync(publicRoot);
      const reservationRoot = path.join(stateRoot, '.start-reservations');
      const sidecar = fs.readdirSync(reservationRoot)
        .find((name) => name.endsWith('.json'));
      const target = {
        'public-link': publicRoot,
        'namespace-marker': path.join(privateRoot, '.start-reservation.json'),
        publication: path.join(privateRoot, '.start-publication.json'),
        sidecar: path.join(reservationRoot, sidecar),
        finalization: path.join(privateRoot, '.start-finalized.json'),
      }[kind];
      const replacement = replacePathWithForeign(
        target,
        kind === 'public-link' ? 'directory' : 'file',
        `foreign-${kind}`,
      );
      const foreignIdentity = statIdentity(replacement.foreign);
      const foreignTree = kind === 'public-link'
        ? snapshotTree(replacement.foreign)
        : fs.readFileSync(replacement.foreign);

      const result = dispatch(request(root, 'session.start', { goal: 'Retained Evidence' }), {
        now: () => Date.parse('2026-07-12T12:34:56Z'),
      });
      assert.equal(result.ok, false, `${kind}: ${JSON.stringify(result)}`);
      assert.match(result.error.code, /^start_reservation_|^session_path_/);
      assert.deepEqual(statIdentity(replacement.foreign), foreignIdentity,
        `${kind}: foreign identity or metadata changed`);
      if (kind === 'public-link') {
        assert.deepEqual(snapshotTree(replacement.foreign), foreignTree,
          `${kind}: foreign tree changed`);
      } else {
        assert.deepEqual(fs.readFileSync(replacement.foreign), foreignTree,
          `${kind}: foreign bytes changed`);
      }
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('session consumers stay bound to the authenticated private root after public-path validation', () => {
  const { outer, root } = makeProject('consumer private binding');
  const storePath = require.resolve('../hooks/scripts/runtime/session-store.cjs');
  const runtimePath = require.resolve(RUNTIME);
  const store = require(storePath);
  const originalPatchSession = store.patchSession;
  let injected = false;
  let publicRoot;
  let privateRoot;
  let foreignIdentity;
  let foreignTree;
  try {
    const started = dispatch(request(root, 'session.start', { goal: 'Consumer Binding' }), {
      now: () => Date.parse('2026-07-12T12:34:56Z'),
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    publicRoot = started.result.session_root;
    privateRoot = fs.realpathSync(publicRoot);
    writeSession(root, started.result.session_id, validSession(started.result.session_id));

    store.patchSession = function replacePublicAfterValidation(sessionPath, mutator, options) {
      assert.equal(path.dirname(sessionPath), privateRoot,
        'consumer must pass the authenticated physical backing path to storage');
      if (!injected) {
        injected = true;
        replacePathWithForeign(publicRoot, 'directory', 'foreign-consumer-binding');
        foreignIdentity = statIdentity(publicRoot);
        foreignTree = snapshotTree(publicRoot);
      }
      return originalPatchSession(sessionPath, mutator, options);
    };
    delete require.cache[runtimePath];
    const freshRuntime = require(runtimePath);
    const patched = freshRuntime.dispatch(request(root, 'session.patch', {
      session_id: started.result.session_id,
      path: '/goal',
      value: 'private path only',
    }));
    assert.equal(injected, true);
    assert.equal(patched.ok, true, JSON.stringify(patched));
    assert.equal(patched.result.session.goal, 'private path only');
    assert.deepEqual(statIdentity(publicRoot), foreignIdentity);
    assert.deepEqual(snapshotTree(publicRoot), foreignTree,
      'late public replacement must receive no consumer write');
    assert.equal(parseStateDocument(
      fs.readFileSync(path.join(privateRoot, 'session.yaml'), 'utf8'),
    ).goal, 'private path only');
  } finally {
    store.patchSession = originalPatchSession;
    delete require.cache[runtimePath];
    require(runtimePath);
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('journal consumers stay on one authenticated backing transaction after a late public replacement', () => {
  const cases = [
    {
      operation: 'virtual.append-seed',
      payload: {
        seed_id: 7,
        worktree_path: '/private/seed-7',
        branch: 'seed-7',
        beta: { direction: 'private' },
      },
      privateEvents: [{ event: 'seed_initialized', seed_id: 7, ts: 'private-time' }],
      foreignEvents: [{ event: 'seed_initialized', seed_id: 7, ts: 'foreign-time' }],
      assertResult(result) {
        assert.equal(result.session.virtual_parallel.seeds[0].created_at, 'private-time');
      },
    },
    {
      operation: 'virtual.rebuild-seeds',
      payload: {},
      privateEvents: [{ event: 'seed_initialized', seed_id: 17, ts: 'private-time' }],
      foreignEvents: [{ event: 'seed_initialized', seed_id: 902, ts: 'foreign-time' }],
      assertResult(result) {
        assert.deepEqual(result.session.virtual_parallel.seeds.map((seed) => seed.id), [17]);
      },
    },
    {
      operation: 'session.detect-orphan',
      payload: {},
      privateEvents: [{ id: 17, status: 'committed', commit: 'private-commit' }],
      foreignEvents: [{ id: 902, status: 'committed', commit: 'foreign-commit' }],
      assertResult(result) {
        assert.deepEqual(result, { commit: 'private-commit', experiment_id: 17 });
      },
    },
  ];

  for (const fixture of cases) {
    const { outer, root } = makeProject(`late journal replacement ${fixture.operation}`);
    const originalReadFileSync = fs.readFileSync;
    let injected = false;
    let foreignIdentity;
    let foreignTree;
    try {
      const started = dispatch(request(root, 'session.start', {
        goal: `Journal Binding ${fixture.operation}`,
      }), { now: () => Date.parse('2026-07-12T12:34:56Z') });
      assert.equal(started.ok, true, JSON.stringify(started));
      const sid = started.result.session_id;
      const publicRoot = started.result.session_root;
      const privateRoot = fs.realpathSync(publicRoot);
      fs.writeFileSync(path.join(privateRoot, 'session.yaml'), `${JSON.stringify(validSession(sid, {
        virtual_parallel: {
          enabled: true,
          N: 1,
          n_current: 1,
          n_initial: 1,
          budget_total: 4,
          seeds: [],
        },
      }), null, 2)}\n`);
      const privateJournal = path.join(privateRoot, 'journal.jsonl');
      const publicJournal = path.join(publicRoot, 'journal.jsonl');
      const privateJournalBytes = `${fixture.privateEvents.map(JSON.stringify).join('\n')}\n`;
      fs.writeFileSync(privateJournal, privateJournalBytes);

      fs.readFileSync = function injectReplacementOnFirstJournalRead(candidate, ...args) {
        const target = typeof candidate === 'string' ? path.resolve(candidate) : '';
        if (!injected && (target === path.resolve(privateJournal) || target === path.resolve(publicJournal))) {
          injected = true;
          fs.renameSync(publicRoot, `${publicRoot}.captured-backing-link`);
          fs.mkdirSync(publicRoot, { mode: 0o751 });
          fs.writeFileSync(path.join(publicRoot, 'session.yaml'), `${JSON.stringify(validSession(sid, {
            goal: 'foreign session',
            virtual_parallel: { enabled: true, n_initial: 1, budget_total: 999, seeds: [] },
          }), null, 2)}\n`);
          fs.writeFileSync(path.join(publicRoot, 'journal.jsonl'),
            `${fixture.foreignEvents.map(JSON.stringify).join('\n')}\n`);
          fs.writeFileSync(path.join(publicRoot, 'UNRELATED.txt'), 'foreign must remain exact\n');
          foreignIdentity = statIdentity(publicRoot);
          foreignTree = snapshotTree(publicRoot);
        }
        return originalReadFileSync.call(fs, candidate, ...args);
      };

      const response = dispatch(request(root, fixture.operation, {
        session_id: sid,
        ...fixture.payload,
      }), { now: () => Date.parse('2026-07-12T13:00:00Z') });
      assert.equal(injected, true, `${fixture.operation}: late replacement seam was not reached`);
      assert.equal(response.ok, true, `${fixture.operation}: ${JSON.stringify(response)}`);
      fixture.assertResult(response.result);
      assert.deepEqual(statIdentity(publicRoot), foreignIdentity,
        `${fixture.operation}: unrelated public identity changed`);
      assert.deepEqual(snapshotTree(publicRoot), foreignTree,
        `${fixture.operation}: unrelated public tree or bytes changed`);
      assert.equal(originalReadFileSync.call(fs, privateJournal, 'utf8'), privateJournalBytes,
        `${fixture.operation}: authenticated journal bytes changed`);
      if (fixture.operation !== 'session.detect-orphan') {
        const privateSession = parseStateDocument(
          originalReadFileSync.call(fs, path.join(privateRoot, 'session.yaml'), 'utf8'),
        );
        fixture.assertResult({ session: privateSession });
      }
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('native legacy session readers and writers retain the authenticated backing after alias replacement', async (t) => {
  const fixtures = [
    {
      name: 'append',
      args(publicRoot) {
        return {
          argv: ['append_seed_to_session_yaml', '7', '/private/seed-7', 'seed-7', '{"direction":"private"}'],
          env: { SESSION_ROOT: publicRoot },
        };
      },
      privateEvents: [{ event: 'seed_initialized', seed_id: 7, ts: 'private-time' }],
      foreignEvents: [{ event: 'seed_initialized', seed_id: 7, ts: 'foreign-time' }],
      assertOutcome(result, privateRoot) {
        assert.equal(result.status, 0, result.stderr);
        const session = parseStateDocument(fs.readFileSync(path.join(privateRoot, 'session.yaml'), 'utf8'));
        assert.equal(session.virtual_parallel.seeds[0].created_at, 'private-time');
      },
    },
    {
      name: 'rebuild',
      args(publicRoot) {
        return { argv: ['rebuild_seeds_from_journal'], env: { SESSION_ROOT: publicRoot } };
      },
      privateEvents: [{ event: 'seed_initialized', seed_id: 17, ts: 'private-time' }],
      foreignEvents: [{ event: 'seed_initialized', seed_id: 902, ts: 'foreign-time' }],
      assertOutcome(result, privateRoot) {
        assert.equal(result.status, 0, result.stderr);
        const session = parseStateDocument(fs.readFileSync(path.join(privateRoot, 'session.yaml'), 'utf8'));
        assert.deepEqual(session.virtual_parallel.seeds.map((seed) => seed.id), [17]);
      },
    },
    {
      name: 'detect-orphan',
      args(publicRoot) {
        return { argv: ['detect_orphan_experiment', publicRoot], env: {} };
      },
      privateEvents: [{ id: 17, status: 'committed', commit: 'private-commit' }],
      foreignEvents: [{ id: 902, status: 'committed', commit: 'foreign-commit' }],
      assertOutcome(result) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, '"private-commit"');
      },
    },
    {
      name: 'mark-status',
      args(_publicRoot, sid) {
        return { argv: ['mark_session_status', sid, 'paused'], env: {} };
      },
      privateEvents: [],
      foreignEvents: [],
      assertOutcome(result, privateRoot) {
        assert.equal(result.status, 0, result.stderr);
        const session = parseStateDocument(fs.readFileSync(path.join(privateRoot, 'session.yaml'), 'utf8'));
        assert.equal(session.status, 'paused');
      },
    },
    {
      name: 'check-alignment',
      prepare(root, privateRoot) {
        const initialized = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
        assert.equal(initialized.status, 0, initialized.stderr);
        const session = parseStateDocument(
          fs.readFileSync(path.join(privateRoot, 'session.yaml'), 'utf8'),
        );
        session.lineage = { current_branch: 'main' };
        fs.writeFileSync(path.join(privateRoot, 'session.yaml'), `${JSON.stringify(session, null, 2)}\n`);
      },
      args(publicRoot) {
        return { argv: ['check_branch_alignment', publicRoot], env: {} };
      },
      privateEvents: [],
      foreignEvents: [],
      assertOutcome(result) {
        assert.equal(result.status, 0, result.stderr);
      },
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
    const { outer, root } = makeProject(`legacy bound ${fixture.name}`);
    const originalReadFileSync = fs.readFileSync;
    let injected = false;
    let foreignIdentity;
    let foreignTree;
    try {
      const started = dispatch(request(root, 'session.start', { goal: `Legacy ${fixture.name}` }), {
        now: () => Date.parse('2026-07-12T12:34:56Z'),
      });
      assert.equal(started.ok, true, JSON.stringify(started));
      const sid = started.result.session_id;
      const publicRoot = started.result.session_root;
      const privateRoot = fs.realpathSync(publicRoot);
      fs.writeFileSync(path.join(privateRoot, 'session.yaml'), `${JSON.stringify(validSession(sid, {
        virtual_parallel: {
          enabled: true, n_current: 1, n_initial: 1, budget_total: 4, seeds: [],
        },
      }), null, 2)}\n`);
      fs.writeFileSync(path.join(privateRoot, 'journal.jsonl'),
        `${fixture.privateEvents.map(JSON.stringify).join('\n')}${fixture.privateEvents.length ? '\n' : ''}`);
      if (fixture.prepare) fixture.prepare(root, privateRoot);
      const publicSession = path.join(publicRoot, 'session.yaml');
      const privateSession = path.join(privateRoot, 'session.yaml');
      const publicJournal = path.join(publicRoot, 'journal.jsonl');
      const privateJournal = path.join(privateRoot, 'journal.jsonl');

      fs.readFileSync = function replaceAliasAtFirstSessionRead(candidate, ...args) {
        const target = typeof candidate === 'string' ? path.resolve(candidate) : '';
        if (!injected && [publicSession, privateSession, publicJournal, privateJournal]
          .map((entry) => path.resolve(entry)).includes(target)) {
          injected = true;
          fs.renameSync(publicRoot, `${publicRoot}.captured-backing-link`);
          fs.mkdirSync(publicRoot, { mode: 0o751 });
          fs.writeFileSync(path.join(publicRoot, 'session.yaml'), `${JSON.stringify(validSession(sid, {
            status: 'aborted',
            goal: 'foreign session',
            lineage: { current_branch: 'foreign' },
            virtual_parallel: { enabled: true, n_initial: 1, budget_total: 999, seeds: [] },
          }), null, 2)}\n`);
          fs.writeFileSync(path.join(publicRoot, 'journal.jsonl'),
            `${fixture.foreignEvents.map(JSON.stringify).join('\n')}${fixture.foreignEvents.length ? '\n' : ''}`);
          fs.writeFileSync(path.join(publicRoot, 'UNRELATED.txt'), 'foreign must remain exact\n');
          foreignIdentity = statIdentity(publicRoot);
          foreignTree = snapshotTree(publicRoot);
        }
        return originalReadFileSync.call(fs, candidate, ...args);
      };

      const invocation = fixture.args(publicRoot, sid);
      const result = captureLegacyMain(root, invocation.argv, {
        env: invocation.env,
        dependencies: { now: () => Date.parse('2026-07-12T13:00:00Z') },
      });
      assert.equal(injected, true, `${fixture.name}: late replacement seam was not reached`);
      fixture.assertOutcome(result, privateRoot);
      assert.deepEqual(statIdentity(publicRoot), foreignIdentity,
        `${fixture.name}: unrelated public identity changed`);
      assert.deepEqual(snapshotTree(publicRoot), foreignTree,
        `${fixture.name}: unrelated public tree or bytes changed`);
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.rmSync(outer, { recursive: true, force: true });
    }
    });
  }
});

test('session.start public install never replaces a foreign empty destination won at the install seam', () => {
  const { outer, root } = makeProject('start public no-replace race');
  let injected = false;
  let foreignRoot;
  let foreignIdentity;
  try {
    const result = dispatch(request(root, 'session.start', { goal: 'Public Race' }), {
      now: () => Date.parse('2026-07-12T12:34:56Z'),
      coordinationOptions: {
        onPhase(phase, context = {}) {
          if (phase !== 'before-start-public-install' || injected) return;
          injected = true;
          foreignRoot = context.publicRoot;
          fs.mkdirSync(foreignRoot, { mode: 0o751 });
          foreignIdentity = statIdentity(foreignRoot);
        },
      },
    });
    assert.equal(injected, true, 'initial install race seam was not reached');
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, 'start_reservation_ambiguous');
    assert.deepEqual(statIdentity(foreignRoot), foreignIdentity);
    assert.deepEqual(fs.readdirSync(foreignRoot), []);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('public publication fails closed without a mkdir or rename fallback when link authority is denied', () => {
  const { outer, root } = makeProject('start link authority denied');
  const originalSymlink = fs.symlinkSync;
  let attempts = 0;
  fs.symlinkSync = () => {
    attempts += 1;
    throw Object.assign(new Error('junction privilege denied'), { code: 'EPERM' });
  };
  try {
    const result = dispatch(request(root, 'session.start', { goal: 'No Unsafe Fallback' }), {
      now: () => Date.parse('2026-07-12T12:34:56Z'),
    });
    assert.equal(attempts, 1);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, 'start_reservation_ambiguous');
    const publicRoot = path.join(root, '.deep-evolve', '2026-07-12_no-unsafe-fallback');
    assert.equal(fs.existsSync(publicRoot), false,
      'EPERM must not fall back to an adoptable public directory or replacing rename');
    const reservationRoot = path.join(root, '.deep-evolve', '.start-reservations');
    assert.equal(fs.readdirSync(reservationRoot)
      .filter((name) => name.startsWith('.namespace-')).length, 1,
    'failure evidence must retain exactly one authenticated private namespace');
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('native Windows publishes one absolute same-volume junction and rejects a foreign reparse target', {
  skip: process.platform !== 'win32' ? 'native Windows junction contract' : false,
}, () => {
  const { outer, root } = makeProject('native Windows junction');
  try {
    const result = dispatch(request(root, 'session.start', { goal: 'Windows Junction' }), {
      now: () => Date.parse('2026-07-12T12:34:56Z'),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const publicRoot = result.result.session_root;
    const privateRoot = fs.realpathSync(publicRoot);
    assert.equal(fs.lstatSync(publicRoot).isSymbolicLink(), true);
    assert.equal(fs.statSync(publicRoot).isDirectory(), true);
    assert.equal(path.isAbsolute(fs.readlinkSync(publicRoot)), true);
    assert.equal(fs.statSync(privateRoot, { bigint: true }).dev,
      fs.statSync(path.dirname(publicRoot), { bigint: true }).dev);

    const foreignRoot = path.join(root, '.deep-evolve', '.foreign-junction-target');
    fs.mkdirSync(foreignRoot);
    fs.writeFileSync(path.join(foreignRoot, 'FOREIGN.txt'), 'foreign-windows-junction');
    const foreignBefore = snapshotTree(foreignRoot);
    fs.unlinkSync(publicRoot);
    fs.symlinkSync(foreignRoot, publicRoot, 'junction');
    const rejected = dispatch(request(root, 'session.read'));
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.match(rejected.error.code, /^session_path_|^start_reservation_/);
    assert.deepEqual(snapshotTree(foreignRoot), foreignBefore);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('committed start recovery never replaces a foreign empty destination won at the install seam', () => {
  const { outer, root } = makeProject('recovery public no-replace race');
  let injected = false;
  let foreignRoot;
  let foreignIdentity;
  try {
    const crashed = crashStartSession(root, 'after-commit-marker', 'Recovery Public Race');
    assert.equal(crashed.status, 86, crashed.stderr);
    const stateRoot = path.join(root, '.deep-evolve');
    const reservationRoot = path.join(stateRoot, '.start-reservations');
    const sidecarName = fs.readdirSync(reservationRoot).find((name) => name.endsWith('.json'));
    assert.ok(sidecarName);
    const reservation = JSON.parse(fs.readFileSync(path.join(reservationRoot, sidecarName), 'utf8'));
    const publicRoot = path.join(stateRoot, reservation.session_id);
    const privateRoot = path.join(reservationRoot, `.namespace-${reservation.reservation_nonce}`);
    assert.equal(fs.realpathSync(publicRoot), privateRoot);
    fs.unlinkSync(publicRoot);

    const result = dispatch(request(root, 'session.start', { goal: 'Recovery Public Race' }), {
      now: () => Date.parse('2026-07-12T12:34:56Z'),
      coordinationOptions: {
        onPhase(phase, context = {}) {
          if (phase !== 'before-start-public-recovery-install' || injected) return;
          injected = true;
          foreignRoot = context.publicRoot;
          fs.mkdirSync(foreignRoot, { mode: 0o751 });
          foreignIdentity = statIdentity(foreignRoot);
        },
      },
    });
    assert.equal(injected, true, 'committed recovery install race seam was not reached');
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, 'start_reservation_ambiguous');
    assert.deepEqual(statIdentity(foreignRoot), foreignIdentity);
    assert.deepEqual(fs.readdirSync(foreignRoot), []);
    assert.equal(statIdentity(privateRoot).ino, reservation.namespace_identity.ino);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('supported session.start and committed recovery are self-contained Node with child spawning forbidden', () => {
  const source = fs.readFileSync(RUNTIME, 'utf8');
  const authorityStart = source.indexOf('function createPublicStartNamespaceExclusive');
  const authorityEnd = source.indexOf('function ensureCommittedStartNamespace', authorityStart);
  assert.ok(authorityStart >= 0 && authorityEnd > authorityStart);
  const authority = source.slice(authorityStart, authorityEnd);
  assert.doesNotMatch(authority, /python|ctypes|renameat2|renamex_np|spawnSync/i);
  const publication = source.slice(
    authorityStart,
    source.indexOf('function fsyncExclusiveStartMarker', authorityStart),
  );
  assert.match(publication, /symlinkSync\(privateRoot, destination,[\s\S]*'junction'/);
  assert.doesNotMatch(publication, /mkdirSync|renameSync|spawnSync/,
    'public publication must have no replacing or privilege-fallback path');

  const childProcess = require('node:child_process');
  const originalSpawnSync = childProcess.spawnSync;
  const runtimeKey = require.resolve(RUNTIME);
  const projects = [];
  let childAttempts = 0;
  childProcess.spawnSync = () => {
    childAttempts += 1;
    throw new Error('child process authority is forbidden for supported session.start');
  };
  delete require.cache[runtimeKey];
  try {
    const freshRuntime = require(RUNTIME);
    const initial = makeProject('node only initial start');
    projects.push(initial.outer);
    const initialResult = freshRuntime.dispatch(
      request(initial.root, 'session.start', { goal: 'Node Only Initial' }),
      { now: () => Date.parse('2026-07-12T12:34:56Z') },
    );
    assert.equal(initialResult.ok, true, JSON.stringify(initialResult));

    const recovery = makeProject('node only committed recovery');
    projects.push(recovery.outer);
    const stateRoot = path.join(recovery.root, '.deep-evolve');
    const reservationRoot = path.join(stateRoot, '.start-reservations');
    fs.mkdirSync(reservationRoot, { mode: 0o700 });
    const sessionId = '2026-07-12_node-only-recovery';
    const goal = 'Node Only Recovery';
    const nonce = 'a'.repeat(32);
    const privateRoot = path.join(reservationRoot, `.namespace-${nonce}`);
    fs.mkdirSync(privateRoot, { mode: 0o700 });
    const identity = statIdentity(privateRoot);
    const marker = boundStartReservation(sessionId, goal, nonce, {
      dev: identity.dev,
      ino: identity.ino,
    });
    const markerBytes = `${JSON.stringify(marker, null, 2)}\n`;
    fs.writeFileSync(path.join(privateRoot, '.start-reservation.json'), markerBytes);
    for (const child of ['runs', 'code-archive', 'strategy-archive', 'meta-analyses']) {
      fs.mkdirSync(path.join(privateRoot, child));
    }
    fs.writeFileSync(path.join(reservationRoot, `${sessionId}.${nonce}.json`), markerBytes);
    fs.writeFileSync(path.join(stateRoot, 'sessions.jsonl'), `${JSON.stringify({
      event: 'created', ts: '2026-07-12T12:34:56Z', session_id: sessionId,
      goal, status: 'initializing',
    })}\n`);
    fs.writeFileSync(path.join(stateRoot, 'current.json'), `${JSON.stringify({
      session_id: sessionId, started_at: '2026-07-12T12:34:56Z',
    })}\n`);

    const recovered = freshRuntime.dispatch(
      request(recovery.root, 'session.start', { goal }),
      { now: () => Date.parse('2026-07-12T12:34:56Z') },
    );
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.result.session_id, sessionId);

    const legacy = makeProject('node only legacy projection');
    projects.push(legacy.outer);
    const previousCwd = process.cwd();
    const previousStdout = process.stdout.write;
    let legacyStdout = '';
    process.stdout.write = (chunk) => {
      legacyStdout += String(chunk);
      return true;
    };
    let legacyRc;
    try {
      process.chdir(legacy.root);
      legacyRc = freshRuntime.main(
        ['--legacy-session-helper', 'start_new_session', 'Node Only Legacy'],
        { now: () => Date.parse('2026-07-12T12:34:56Z') },
      );
    } finally {
      process.chdir(previousCwd);
      process.stdout.write = previousStdout;
    }
    assert.equal(legacyRc, 0);
    assert.match(legacyStdout, /^2026-07-12_node-only-legacy\t/);
    assert.equal(childAttempts, 0);
  } finally {
    delete require.cache[runtimeKey];
    childProcess.spawnSync = originalSpawnSync;
    require(RUNTIME);
    for (const outer of projects) fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('every namespace-sensitive reader and mutator rejects mismatched embedded identity under lock', () => {
  const cases = [
    ['session.resolve-current', {}],
    ['session.mark-status', { session_id: 'namespace-a', status: 'paused' }],
    ['session.patch', { session_id: 'namespace-a', path: '/goal', value: 'changed' }],
    ['session.complete', { session_id: 'namespace-a', outcome: 'kept' }],
    ['session.check-alignment', { session_id: 'namespace-a' }],
    ['virtual.init', {
      session_id: 'namespace-a',
      analysis: { project_type: 'standard', eval_parallelizability: 'parallel', reasoning: '' },
      n_chosen: 1,
      total_budget: 1,
    }],
    ['virtual.append-seed', {
      session_id: 'namespace-a', seed_id: 1, worktree_path: '/tmp/seed', branch: 'seed-1', beta: {},
    }],
    ['virtual.rebuild-seeds', { session_id: 'namespace-a' }],
    ['virtual.set-field', { session_id: 'namespace-a', key: 'n_current', value: 1 }],
  ];
  for (const [operation, payload] of cases) {
    const { outer, root } = makeProject(`identity ${operation}`);
    writeSession(root, 'namespace-a', validSession('different-b'));
    writeCurrent(root, 'namespace-a');
    fs.writeFileSync(path.join(root, '.deep-evolve', 'sessions.jsonl'), `${JSON.stringify({
      event: 'created', ts: 't0', session_id: 'namespace-a', status: 'active', goal: 'g',
    })}\n`);
    fs.writeFileSync(path.join(root, '.deep-evolve', 'namespace-a', 'journal.jsonl'), `${JSON.stringify({
      event: 'seed_initialized', seed_id: 1, ts: 't1',
    })}\n`);
    const before = snapshotTree(path.join(root, '.deep-evolve'));
    try {
      const result = runRequest(root, operation, payload);
      assert.equal(result.status, 2, `${operation}: ${result.stderr}\n${result.stdout}`);
      assert.equal(result.response.error.code, 'session_identity_mismatch', operation);
      assert.deepEqual(snapshotTree(path.join(root, '.deep-evolve')), before, `${operation} changed state`);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('resolve-current dangling pointer is a business rejection and preserves state', () => {
  const { outer, root } = makeProject();
  writeCurrent(root, 'missing-session');
  const before = fs.readFileSync(path.join(root, '.deep-evolve', 'current.json'));
  try {
    const result = runRequest(root, 'session.resolve-current');
    assert.equal(result.status, 1);
    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, 'orphan_pointer');
    assert.deepEqual(fs.readFileSync(path.join(root, '.deep-evolve', 'current.json')), before);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('branch alignment uses argv Git execution and orphan detection uses exact numeric ids', () => {
  const { outer, root } = makeProject('git project');
  const init = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const sid = 'branch-session';
  const sessionRoot = writeSession(root, sid, validSession(sid, {
    lineage: { current_branch: 'main' },
  }));
  fs.writeFileSync(path.join(sessionRoot, 'journal.jsonl'), [
    { id: 1, status: 'committed', commit: 'old' },
    { id: 1, status: 'kept' },
    { id: 11, status: 'committed', commit: 'exact-eleven' },
  ].map(JSON.stringify).join('\n') + '\n');
  try {
    const aligned = expectSuccess(runRequest(root, 'session.check-alignment', { session_id: sid }), 'session.check-alignment');
    assert.deepEqual(aligned, { aligned: true, expected: 'main', actual: 'main' });

    const orphan = expectSuccess(runRequest(root, 'session.detect-orphan', { session_id: sid }), 'session.detect-orphan');
    assert.deepEqual(orphan, { commit: 'exact-eleven', experiment_id: 11 });

    const changed = validSession(sid, { lineage: { current_branch: 'other' } });
    fs.writeFileSync(path.join(sessionRoot, 'session.yaml'), `${JSON.stringify(changed, null, 2)}\n`);
    const mismatch = runRequest(root, 'session.check-alignment', { session_id: sid });
    assert.equal(mismatch.status, 1);
    assert.equal(mismatch.response.error.code, 'branch_mismatch');
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('receipt operations unwrap only the deep-evolve evolve-receipt identity', () => {
  const { outer, root } = makeProject('receipt project');
  const parent = 'parent-session';
  const parentRoot = writeSession(root, parent);
  const payload = {
    receipt_schema_version: 2,
    session_id: parent,
    goal: 'Parent goal',
    timestamp: '2026-07-11T00:00:00Z',
    outcome: 'kept',
    experiments: { total: 4, kept: 2 },
    score: { baseline: 1, best: 2, improvement_pct: 100 },
    strategy_evolution: { q_trajectory: [0.1, { Q: 0.2 }], outer_loop_generations: 1 },
    generation_snapshots: [{
      strategy_yaml_content: 'alpha: 1\nBeta: ignored\ngamma: 2\n',
      meta_analysis_content: 'First lesson.\n\nSecond paragraph.',
    }],
    notable_keeps: [{ commit: 'abc123', score_delta: 0.5, source: 'seed-1', description: 'Useful keep' }],
  };
  const envelope = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-evolve',
      artifact_kind: 'evolve-receipt',
      schema: { name: 'evolve-receipt', version: '1.0' },
    },
    payload,
  };
  fs.writeFileSync(path.join(parentRoot, 'evolve-receipt.json'), JSON.stringify(envelope));
  try {
    const inherited = expectSuccess(runRequest(root, 'session.render-inherited-context', {
      parent_session_id: parent,
    }), 'session.render-inherited-context');
    assert.equal(inherited.parent_receipt_schema_version, 2);
    assert.match(inherited.markdown, /Inherited Context \(from parent-session\)/);
    assert.match(inherited.markdown, /- alpha: 1/);
    assert.match(inherited.markdown, /commit abc123/);
    assert.match(inherited.markdown, /First lesson\./);

    const archived = expectSuccess(runRequest(root, 'session.append-local-archive', {
      session_id: parent,
    }), 'session.append-local-archive');
    assert.deepEqual(archived.entry.q_trajectory, [0.1, 0.2]);
    assert.equal(archived.entry.experiments.keep_rate, 0.5);
    const archiveLine = JSON.parse(fs.readFileSync(archived.archive_path, 'utf8').trim());
    assert.deepEqual(archiveLine, archived.entry);

    const foreign = {
      ...envelope,
      envelope: { ...envelope.envelope, producer: 'other-producer' },
    };
    fs.writeFileSync(path.join(parentRoot, 'evolve-receipt.json'), JSON.stringify(foreign));
    const safe = expectSuccess(runRequest(root, 'session.append-local-archive', {
      session_id: parent,
    }), 'session.append-local-archive');
    assert.equal(safe.entry.session_id, null);
    assert.deepEqual(safe.entry.q_trajectory, []);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('virtual init, append, set-field, and rebuild preserve legacy spellings and journal truth', () => {
  const { outer, root } = makeProject('virtual state');
  const sid = 'virtual-session';
  const sessionRoot = writeSession(root, sid, validSession(sid));
  writeCurrent(root, sid);
  try {
    const initialized = expectSuccess(runRequest(root, 'virtual.init', {
      session_id: sid,
      analysis: {
        project_type: 'standard_optimization',
        eval_parallelizability: 'parallel_capable',
        reasoning: 'independent seeds',
      },
      n_chosen: 3,
      total_budget: 12,
    }), 'virtual.init').session;
    assert.equal(initialized.virtual_parallel.n_current, 3);
    assert.equal(initialized.virtual_parallel.n_initial, 3);
    assert.equal(initialized.virtual_parallel.synthesis.budget_allocated, 6);

    fs.writeFileSync(path.join(sessionRoot, 'journal.jsonl'), [
      '{malformed',
      JSON.stringify({ event: 'seed_initialized', seed_id: 2, ts: '2026-07-12T01:00:00Z' }),
      JSON.stringify({ event: 'seed_initialized', seed_id: 2, ts: '2026-07-12T02:00:00Z' }),
    ].join('\n') + '\n');
    const appended = expectSuccess(runRequest(root, 'virtual.append-seed', {
      session_id: sid,
      seed_id: 2,
      worktree_path: path.join(root, 'worktrees', 'seed 2'),
      branch: 'evolve/session/seed-2',
      beta: { direction: 'cache', hypothesis: 'faster', rationale: 'profiled' },
    }), 'virtual.append-seed').session;
    assert.equal(appended.virtual_parallel.seeds[0].id, 2);
    assert.equal(appended.virtual_parallel.seeds[0].created_at, '2026-07-12T02:00:00Z');
    assert.equal(appended.virtual_parallel.seeds[0].allocated_budget, 4);

    const set = expectSuccess(runRequest(root, 'virtual.set-field', {
      session_id: sid,
      key: 'N',
      value: 3,
    }), 'virtual.set-field').session;
    assert.equal(set.virtual_parallel.N, 3);
    assert.equal(set.virtual_parallel.n_current, 3, 'N and n_current are distinct legacy fields');

    const injection = runRequest(root, 'virtual.set-field', {
      session_id: sid,
      key: '__proto__',
      value: { polluted: true },
    });
    assert.equal(injection.status, 2);
    assert.equal(injection.response.error.code, 'virtual_field_not_allowed');

    fs.writeFileSync(path.join(sessionRoot, 'journal.jsonl'), [
      JSON.stringify({ event: 'seed_initialized', seed_id: 7, direction: 'A', ts: '2026-07-12T03:00:00Z' }),
      JSON.stringify({ event: 'seed_initialized', seed_id: 3, direction: 'B', ts: '2026-07-12T03:01:00Z' }),
      JSON.stringify({
        event: 'seed_killed', seed_id: 7, condition: 'user_requested',
        final_q: 0.25, experiments_used: 2, ts: '2026-07-12T04:00:00Z',
      }),
    ].join('\n') + '\n');
    const rebuilt = expectSuccess(runRequest(root, 'virtual.rebuild-seeds', {
      session_id: sid,
    }), 'virtual.rebuild-seeds').session;
    assert.deepEqual(rebuilt.virtual_parallel.seeds.map((seed) => seed.id), [3, 7]);
    assert.equal(rebuilt.virtual_parallel.seeds[1].status, 'killed_user_requested');
    assert.equal(rebuilt.virtual_parallel.seeds[1].killed_reason, 'user_requested');
    assert.equal(Object.hasOwn(rebuilt.virtual_parallel.seeds[1], 'killed_reasoning'), false);
    assert.equal(rebuilt.virtual_parallel.n_current, 1);
    assert.equal(rebuilt.virtual_parallel.N, 3, 'rebuild must not normalize or erase N');
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('canonical rebuild preserves kill reasoning in a schema-valid extension field', () => {
  const { outer, root } = makeProject('canonical kill reasoning');
  const sid = 'reasoning-session';
  const sessionRoot = writeSession(root, sid, validSession(sid, {
    virtual_parallel: { N: 2, n_current: 2, n_initial: 2, budget_total: 4, seeds: [] },
  }));
  fs.writeFileSync(path.join(sessionRoot, 'journal.jsonl'), [
    JSON.stringify({ event: 'seed_initialized', seed_id: 1, ts: '2026-07-12T01:00:00Z' }),
    JSON.stringify({ event: 'seed_initialized', seed_id: 2, ts: '2026-07-12T01:01:00Z' }),
    JSON.stringify({
      event: 'seed_killed', seed_id: 2, condition: 'user_requested',
      reasoning: 'operator stopped the duplicate path', ts: '2026-07-12T02:00:00Z',
    }),
  ].join('\n') + '\n');
  try {
    const rebuilt = expectSuccess(runRequest(root, 'virtual.rebuild-seeds', { session_id: sid }),
      'virtual.rebuild-seeds').session;
    const killed = rebuilt.virtual_parallel.seeds.find((seed) => seed.id === 2);
    assert.equal(killed.status, 'killed_user_requested');
    assert.equal(killed['x-killed-reasoning'], 'operator stopped the duplicate path');
    assert.equal(Object.hasOwn(killed, 'killed_reasoning'), false,
      'canonical state must not emit the legacy schema-invalid key');
    assert.equal(rebuilt.virtual_parallel.n_current, 1);

    const consumed = expectSuccess(runRequest(root, 'virtual.set-field', {
      session_id: sid, key: 'enabled', value: true,
    }), 'virtual.set-field').session;
    assert.equal(consumed.virtual_parallel.seeds[1]['x-killed-reasoning'],
      'operator stopped the duplicate path', 'a strict canonical consumer must retain the extension');
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('canonical all-killed rebuild records zero active seeds without invalid n_current', () => {
  const { outer, root } = makeProject('canonical all killed');
  const sid = 'all-killed-session';
  const sessionRoot = writeSession(root, sid, validSession(sid, {
    virtual_parallel: { N: 1, n_current: 1, n_initial: 1, budget_total: 2, seeds: [] },
  }));
  fs.writeFileSync(path.join(sessionRoot, 'journal.jsonl'), [
    JSON.stringify({ event: 'seed_initialized', seed_id: 1, ts: '2026-07-12T01:00:00Z' }),
    JSON.stringify({
      event: 'seed_killed', seed_id: 1, condition: 'budget_exhausted_underperform',
      ts: '2026-07-12T02:00:00Z',
    }),
  ].join('\n') + '\n');
  try {
    const rebuilt = expectSuccess(runRequest(root, 'virtual.rebuild-seeds', { session_id: sid }),
      'virtual.rebuild-seeds').session;
    assert.equal(rebuilt.virtual_parallel.seeds[0].status, 'killed_budget_exhausted_underperform');
    assert.equal(Object.hasOwn(rebuilt.virtual_parallel, 'n_current'), false,
      'zero must not be written into the schema-bounded n_current field');
    assert.equal(rebuilt.virtual_parallel['x-active-seed-count'], 0);

    const consumed = expectSuccess(runRequest(root, 'virtual.set-field', {
      session_id: sid, key: 'enabled', value: false,
    }), 'virtual.set-field').session;
    assert.equal(consumed.virtual_parallel['x-active-seed-count'], 0,
      'a strict canonical consumer must retain the zero-active extension');

    fs.appendFileSync(path.join(sessionRoot, 'journal.jsonl'),
      `${JSON.stringify({ event: 'seed_initialized', seed_id: 2, ts: '2026-07-12T03:00:00Z' })}\n`);
    const revived = expectSuccess(runRequest(root, 'virtual.append-seed', {
      session_id: sid,
      seed_id: 2,
      worktree_path: '/tmp/seed-2',
      branch: 'evolve/all-killed-session/seed-2',
      beta: { direction: 'new active direction' },
    }), 'virtual.append-seed').session;
    assert.equal(revived.virtual_parallel.n_current, 1,
      'adding an active seed must leave canonical positive state');
    assert.equal(Object.hasOwn(revived.virtual_parallel, 'x-active-seed-count'), false,
      'adding an active seed must clear the zero-active sentinel');
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('every legacy compatibility state surface recovers the canonical project transaction before observing state', () => {
  const today = new Date().toISOString().slice(0, 10);
  const base = `${today}_compatibility-goal`;

  {
    const { outer, root } = makeProject('recover compute');
    try {
      seedCommittedTransaction(root, {
        'sessions.jsonl': `${JSON.stringify({ event: 'created', session_id: base })}\n`,
      });
      const result = runLegacyRuntime(root, ['compute_session_id', 'Compatibility Goal']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${base}-2`);
      assertNoPendingCoordinationTransaction(root);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  }

  {
    const { outer, root } = makeProject('recover list');
    try {
      seedCommittedTransaction(root, {
        'sessions.jsonl': `${JSON.stringify({
          event: 'created', ts: 't1', session_id: 'listed', status: 'active', goal: 'g',
        })}\n`,
      });
      const result = runLegacyRuntime(root, ['list_sessions']);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).map((entry) => entry.session_id), ['listed']);
      assertNoPendingCoordinationTransaction(root);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  }

  {
    const { outer, root } = makeProject('recover resolve');
    const sid = 'resolved';
    try {
      seedCommittedTransaction(root, {
        'current.json': `${JSON.stringify({ session_id: sid })}\n`,
        [`${sid}/session.yaml`]: `${JSON.stringify(validSession(sid), null, 2)}\n`,
        'sessions.jsonl': `${JSON.stringify({
          event: 'created', ts: 't1', session_id: sid, status: 'active', goal: 'g',
        })}\n`,
      });
      const result = runLegacyRuntime(root, ['resolve_current']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${sid}\t${path.join(root, '.deep-evolve', sid)}\n`);
      assertNoPendingCoordinationTransaction(root);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  }

  {
    const { outer, root } = makeProject('recover status');
    const sid = 'status-session';
    try {
      seedCommittedTransaction(root, {
        [`${sid}/session.yaml`]: `${JSON.stringify(validSession(sid), null, 2)}\n`,
        'sessions.jsonl': `${JSON.stringify({
          event: 'created', ts: 't1', session_id: sid, status: 'active', goal: 'g',
        })}\n`,
      });
      const result = runLegacyRuntime(root, ['mark_session_status', sid, 'paused']);
      assert.equal(result.status, 0, result.stderr);
      const session = parseStateDocument(fs.readFileSync(path.join(root, '.deep-evolve', sid, 'session.yaml'), 'utf8'));
      assert.equal(session.status, 'paused');
      const records = fs.readFileSync(path.join(root, '.deep-evolve', 'sessions.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(JSON.parse);
      assert.equal(records.at(-1).status, 'paused');
      assertNoPendingCoordinationTransaction(root);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  }

  for (const dryRun of [true, false]) {
    const { outer, root } = makeProject(`recover start ${dryRun}`);
    try {
      seedCommittedTransaction(root, {
        'sessions.jsonl': `${JSON.stringify({ event: 'created', session_id: base })}\n`,
      });
      const args = ['start_new_session', 'Compatibility Goal'];
      if (dryRun) args.splice(1, 0, '--dry-run');
      const result = runLegacyRuntime(root, args);
      assert.equal(result.status, 0, `${dryRun}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`^${base}-2\\t`));
      assertNoPendingCoordinationTransaction(root);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  }

  {
    const { outer, root } = makeProject('recover alignment');
    const init = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const sid = 'alignment-session';
    try {
      seedCommittedTransaction(root, {
        [`${sid}/session.yaml`]: `${JSON.stringify(validSession(sid, {
          lineage: { current_branch: 'other' },
        }), null, 2)}\n`,
      });
      const result = runLegacyRuntime(root, ['check_branch_alignment', path.join(root, '.deep-evolve', sid)]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /branch mismatch: expected 'other', actual 'main'/);
      assertNoPendingCoordinationTransaction(root);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  }

  {
    const { outer, root } = makeProject('recover orphan');
    const sid = 'orphan-session';
    try {
      seedCommittedTransaction(root, {
        [`${sid}/journal.jsonl`]: `${JSON.stringify({ id: 7, status: 'committed', commit: 'abc123' })}\n`,
      });
      const result = runLegacyRuntime(root, ['detect_orphan_experiment', path.join(root, '.deep-evolve', sid)]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '"abc123"');
      assertNoPendingCoordinationTransaction(root);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  }

  const virtualCases = [
    ['append_seed_to_session_yaml', ['1', '/tmp/worktree', 'branch', '{}']],
    ['set_virtual_parallel_field', ['n_current', '2']],
    ['init_virtual_parallel_block', ['{"project_type":"standard","eval_parallelizability":"parallel"}', '2', '10']],
    ['rebuild_seeds_from_journal', []],
  ];
  for (const [arm, args] of virtualCases) {
    const { outer, root } = makeProject(`recover ${arm}`);
    const sid = 'virtual-session';
    const sessionRoot = path.join(root, '.deep-evolve', sid);
    const session = validSession(sid, {
      virtual_parallel: { N: 1, n_current: 1, n_initial: 1, budget_total: 2, seeds: [] },
    });
    try {
      seedCommittedTransaction(root, {
        [`${sid}/session.yaml`]: `${JSON.stringify(session, null, 2)}\n`,
        [`${sid}/journal.jsonl`]: `${JSON.stringify({
          event: 'seed_initialized', seed_id: 1, ts: '2026-07-12T01:00:00Z',
        })}\n`,
      });
      const result = runLegacyRuntime(root, [arm, ...args], {
        env: { ...process.env, SESSION_ROOT: sessionRoot, SESSION_ID: sid },
      });
      assert.equal(result.status, 0, `${arm}: ${result.stderr}`);
      assert.equal(fs.existsSync(path.join(sessionRoot, 'session.yaml')), true);
      assertNoPendingCoordinationTransaction(root);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  }
});

test('legacy status derives optional session membership after acquiring the project lock', () => {
  const { outer, root } = makeProject('status absent to created race');
  const sid = 'late-status-session';
  const stateRoot = path.join(root, '.deep-evolve');
  const sessionPath = path.join(stateRoot, sid, 'session.yaml');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'sessions.jsonl'), `${JSON.stringify({
    event: 'created', ts: 't0', session_id: sid, status: 'active', goal: 'g',
  })}\n`);
  let injected = 0;
  const io = coordinationLockRaceIo(1, () => {
    injected += 1;
    fs.writeFileSync(sessionPath, `${JSON.stringify(validSession(sid), null, 2)}\n`);
  });
  try {
    const result = captureLegacyMain(root, ['mark_session_status', sid, 'paused'], {
      dependencies: { coordinationOptions: { io } },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(injected, 1, 'the canonical publisher race must run before the mutation lock is acquired');
    assert.equal(parseStateDocument(fs.readFileSync(sessionPath, 'utf8')).status, 'paused',
      'the session created at lock acquisition must join the same status transaction');
    const records = fs.readFileSync(path.join(stateRoot, 'sessions.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(records.at(-1).status, 'paused');
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('every virtual compatibility arm checks session and journal preconditions from its locked snapshot', () => {
  const cases = [
    ['append_seed_to_session_yaml', ['1', '/tmp/worktree', 'branch', '{}']],
    ['set_virtual_parallel_field', ['budget_unallocated', '3']],
    ['init_virtual_parallel_block', [
      '{"project_type":"standard","eval_parallelizability":"parallel"}', '2', '10',
    ]],
    ['rebuild_seeds_from_journal', []],
  ];
  for (const [arm, args] of cases) {
    const { outer, root } = makeProject(`virtual absent to created ${arm}`);
    const sid = 'late-virtual-session';
    const sessionRoot = path.join(root, '.deep-evolve', sid);
    const sessionPath = path.join(sessionRoot, 'session.yaml');
    const journalPath = path.join(sessionRoot, 'journal.jsonl');
    fs.mkdirSync(sessionRoot, { recursive: true });
    let injected = 0;
    const io = coordinationLockRaceIo(2, () => {
      injected += 1;
      fs.writeFileSync(sessionPath, `${JSON.stringify(validSession(sid, {
        virtual_parallel: { N: 1, n_current: 1, n_initial: 1, budget_total: 2, seeds: [] },
      }), null, 2)}\n`);
      fs.writeFileSync(journalPath, `${JSON.stringify({
        event: 'seed_initialized', seed_id: 1, ts: '2026-07-12T01:00:00Z',
      })}\n`);
    });
    try {
      const result = captureLegacyMain(root, [arm, ...args], {
        env: { SESSION_ROOT: sessionRoot, SESSION_ID: sid },
        dependencies: {
          now: () => Date.parse('2026-07-12T09:00:00Z'),
          coordinationOptions: { io },
        },
      });
      assert.equal(result.status, 0, `${arm}: ${result.stderr}`);
      assert.equal(injected, 1, `${arm}: the publication race did not execute at the mutation lock`);
      const session = parseStateDocument(fs.readFileSync(sessionPath, 'utf8'));
      if (arm === 'append_seed_to_session_yaml') {
        assert.equal(session.virtual_parallel.seeds[0].created_at, '2026-07-12T01:00:00Z');
      } else if (arm === 'set_virtual_parallel_field') {
        assert.equal(session.virtual_parallel.budget_unallocated, 3);
      } else if (arm === 'init_virtual_parallel_block') {
        assert.equal(session.virtual_parallel.n_current, 2);
      } else {
        assert.deepEqual(session.virtual_parallel.seeds.map((seed) => seed.id), [1]);
      }
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('virtual append and rebuild include a journal published at project-lock acquisition', () => {
  for (const arm of ['append_seed_to_session_yaml', 'rebuild_seeds_from_journal']) {
    const { outer, root } = makeProject(`late journal ${arm}`);
    const sid = 'late-journal-session';
    const sessionRoot = writeSession(root, sid, validSession(sid, {
      virtual_parallel: { N: 1, n_current: 1, n_initial: 1, budget_total: 2, seeds: [] },
    }));
    const journalPath = path.join(sessionRoot, 'journal.jsonl');
    const io = coordinationLockRaceIo(2, () => {
      fs.writeFileSync(journalPath, `${JSON.stringify({
        event: 'seed_initialized', seed_id: 1, ts: '2026-07-12T01:00:00Z',
      })}\n`);
    });
    const args = arm === 'append_seed_to_session_yaml'
      ? [arm, '1', '/tmp/worktree', 'branch', '{}'] : [arm];
    try {
      const result = captureLegacyMain(root, args, {
        env: { SESSION_ROOT: sessionRoot, SESSION_ID: sid },
        dependencies: {
          now: () => Date.parse('2026-07-12T09:00:00Z'),
          coordinationOptions: { io },
        },
      });
      assert.equal(result.status, 0, `${arm}: ${result.stderr}`);
      const session = parseStateDocument(fs.readFileSync(path.join(sessionRoot, 'session.yaml'), 'utf8'));
      assert.equal(session.virtual_parallel.seeds[0].created_at, '2026-07-12T01:00:00Z',
        `${arm}: the locked journal timestamp must win over now()`);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('legacy migrate, migrate dry-run, and lineage recover committed coordination markers before decisions', () => {
  for (const dryRun of [false, true]) {
    const { outer, root } = makeProject(`recover migrate decision ${dryRun}`);
    const flat = [
      'session_id: old-flat',
      'deep_evolve_version: "3.0.0"',
      'status: active',
      'created_at: "2026-01-01T00:00:00Z"',
      'goal: "Recovered Legacy Goal"',
      '',
    ].join('\n');
    try {
      seedCommittedTransaction(root, { 'session.yaml': flat });
      const args = dryRun ? ['--dry-run', 'migrate_legacy'] : ['migrate_legacy'];
      const result = runLegacyRuntime(root, args);
      assert.equal(result.status, 0, `${dryRun}: ${result.stderr}`);
      assert.match(result.stderr + result.stdout, dryRun ? /would execute: migrate flat layout/ : /migrated to/);
      assertNoPendingCoordinationTransaction(root);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }

  const { outer, root } = makeProject('recover lineage decision');
  try {
    seedCommittedTransaction(root, {
      'sessions.jsonl': [
        JSON.stringify({ event: 'created', ts: 't1', session_id: 'parent', status: 'active', goal: 'g' }),
        JSON.stringify({ event: 'created', ts: 't2', session_id: 'child', status: 'active', goal: 'g' }),
        JSON.stringify({ event: 'lineage_set', ts: 't3', session_id: 'child', parent_session_id: 'parent' }),
      ].join('\n') + '\n',
    });
    const result = runLegacyRuntime(root, ['lineage_tree']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'parent <- (root)\nchild <- parent\n');
    assertNoPendingCoordinationTransaction(root);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('canonical and legacy status or virtual writers serialize in one project lock domain without lost state', async () => {
  const store = path.resolve(__dirname, '..', 'hooks', 'scripts', 'runtime', 'session-store.cjs');

  {
    const { outer, root } = makeProject('canonical legacy status race');
    const sid = 'race-status';
    const sessionRoot = writeSession(root, sid, validSession(sid));
    const registryPath = path.join(root, '.deep-evolve', 'sessions.jsonl');
    fs.writeFileSync(registryPath, `${JSON.stringify({
      event: 'created', ts: 't0', session_id: sid, status: 'active', goal: 'g',
    })}\n`);
    const signal = path.join(root, 'canonical-staged.signal');
    const release = path.join(root, 'canonical-release.signal');
    const sessionRelative = `${sid}/session.yaml`;
    const script = [
      "const fs=require('node:fs');",
      "const {mutateCoordinationFiles}=require(process.argv[1]);",
      "const [stateRoot,sid,signal,release,relative]=process.argv.slice(2);",
      "const result=mutateCoordinationFiles(stateRoot,[relative,'sessions.jsonl'],files=>{",
      "const session=JSON.parse(files[relative]);session.status='paused';",
      "const event=JSON.stringify({event:'canonical_test',ts:'t1',session_id:sid,status:'paused'});",
      "return {[relative]:JSON.stringify(session,null,2)+'\\n','sessions.jsonl':files['sessions.jsonl']+event+'\\n'};",
      "},{onPhase(phase){if(phase==='after-stage:sessions.jsonl'){fs.writeFileSync(signal,'ready');",
      "while(!fs.existsSync(release))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}});",
      "process.stdout.write(JSON.stringify(result));",
    ].join('');
    let canonical;
    let legacy;
    try {
      canonical = spawn(process.execPath, ['-e', script, store, path.join(root, '.deep-evolve'), sid,
        signal, release, sessionRelative], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      const canonicalDone = collectChild(canonical);
      await waitForPath(signal);
      legacy = spawn(process.execPath, [RUNTIME, '--legacy-session-helper', 'mark_session_status', sid, 'completed'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const legacyDone = collectChild(legacy);
      const legacyExitedWhileCanonicalHeldLock = await Promise.race([
        legacyDone.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 750)),
      ]);
      fs.writeFileSync(release, 'release');
      const [canonicalResult, legacyResult] = await Promise.all([canonicalDone, legacyDone]);
      assert.equal(legacyExitedWhileCanonicalHeldLock, false,
        'legacy status writer ignored the canonical project lock');
      assert.equal(canonicalResult.status, 0, canonicalResult.stderr);
      assert.equal(legacyResult.status, 0, legacyResult.stderr);
      const session = parseStateDocument(fs.readFileSync(path.join(sessionRoot, 'session.yaml'), 'utf8'));
      assert.equal(session.status, 'completed');
      const records = fs.readFileSync(registryPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
      assert.equal(records.some((entry) => entry.event === 'canonical_test'), true);
      assert.equal(records.at(-1).event, 'status_change');
      assert.equal(records.at(-1).status, 'completed');
    } finally {
      if (!fs.existsSync(release)) fs.writeFileSync(release, 'release');
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }

  {
    const { outer, root } = makeProject('canonical legacy virtual race');
    const sid = 'race-virtual';
    const sessionRoot = writeSession(root, sid, validSession(sid, {
      virtual_parallel: { N: 1, n_current: 1, n_initial: 1, budget_total: 2, seeds: [] },
    }));
    const signal = path.join(root, 'virtual-staged.signal');
    const release = path.join(root, 'virtual-release.signal');
    const relative = `${sid}/session.yaml`;
    const script = [
      "const fs=require('node:fs');",
      "const {mutateCoordinationFiles}=require(process.argv[1]);",
      "const [stateRoot,signal,release,relative]=process.argv.slice(2);",
      "const result=mutateCoordinationFiles(stateRoot,[relative],files=>{",
      "const session=JSON.parse(files[relative]);session.goal='canonical goal';",
      "return {[relative]:JSON.stringify(session,null,2)+'\\n'};",
      "},{onPhase(phase){if(phase==='after-stage:'+relative){fs.writeFileSync(signal,'ready');",
      "while(!fs.existsSync(release))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}});",
      "process.stdout.write(JSON.stringify(result));",
    ].join('');
    try {
      const canonical = spawn(process.execPath, ['-e', script, store, path.join(root, '.deep-evolve'),
        signal, release, relative], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      const canonicalDone = collectChild(canonical);
      await waitForPath(signal);
      const legacy = spawn(process.execPath, [RUNTIME, '--legacy-session-helper',
        'set_virtual_parallel_field', 'n_current', '2'], {
        cwd: root,
        env: { ...process.env, SESSION_ROOT: sessionRoot, SESSION_ID: sid },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const legacyDone = collectChild(legacy);
      const legacyExitedWhileCanonicalHeldLock = await Promise.race([
        legacyDone.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 750)),
      ]);
      fs.writeFileSync(release, 'release');
      const [canonicalResult, legacyResult] = await Promise.all([canonicalDone, legacyDone]);
      assert.equal(legacyExitedWhileCanonicalHeldLock, false,
        'legacy virtual writer ignored the canonical project lock');
      assert.equal(canonicalResult.status, 0, canonicalResult.stderr);
      assert.equal(legacyResult.status, 0, legacyResult.stderr);
      const session = parseStateDocument(fs.readFileSync(path.join(sessionRoot, 'session.yaml'), 'utf8'));
      assert.equal(session.goal, 'canonical goal');
      assert.equal(session.virtual_parallel.n_current, 2);
    } finally {
      if (!fs.existsSync(release)) fs.writeFileSync(release, 'release');
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('legacy status and virtual crash cutpoints recover canonical markers before the next compatibility read', () => {
  {
    const { outer, root } = makeProject('legacy status crash recovery');
    const sid = 'crash-status';
    const sessionRoot = writeSession(root, sid, validSession(sid));
    writeCurrent(root, sid);
    fs.writeFileSync(path.join(root, '.deep-evolve', 'sessions.jsonl'), `${JSON.stringify({
      event: 'created', ts: 't0', session_id: sid, status: 'active', goal: 'g',
    })}\n`);
    try {
      const crashed = crashLegacyRuntime(root, ['mark_session_status', sid, 'paused'],
        `after-install:${sid}/session.yaml`);
      assert.equal(crashed.status, 86, `${crashed.stderr}\n${crashed.stdout}`);
      const recovered = runLegacyRuntime(root, ['list_sessions']);
      assert.equal(recovered.status, 0, recovered.stderr);
      const session = parseStateDocument(fs.readFileSync(path.join(sessionRoot, 'session.yaml'), 'utf8'));
      const records = fs.readFileSync(path.join(root, '.deep-evolve', 'sessions.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(JSON.parse);
      assert.equal(session.status, 'paused');
      assert.equal(records.at(-1).status, 'paused');
      assertNoPendingCoordinationTransaction(root);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  }

  {
    const { outer, root } = makeProject('legacy virtual crash recovery');
    const sid = 'crash-virtual';
    const sessionRoot = writeSession(root, sid, validSession(sid, {
      virtual_parallel: { N: 1, n_current: 1, n_initial: 1, budget_total: 2, seeds: [] },
    }));
    try {
      const crashed = crashLegacyRuntime(root, ['set_virtual_parallel_field', 'n_current', '2'],
        'after-commit-marker', { SESSION_ROOT: sessionRoot, SESSION_ID: sid });
      assert.equal(crashed.status, 86, `${crashed.stderr}\n${crashed.stdout}`);
      const recovered = runLegacyRuntime(root, ['list_sessions']);
      assert.equal(recovered.status, 0, recovered.stderr);
      const session = parseStateDocument(fs.readFileSync(path.join(sessionRoot, 'session.yaml'), 'utf8'));
      assert.equal(session.virtual_parallel.n_current, 2);
      assertNoPendingCoordinationTransaction(root);
    } finally { fs.rmSync(outer, { recursive: true, force: true }); }
  }
});

test('flat v2 migration copies and verifies bytes before removing originals', () => {
  const { outer, root } = makeProject('legacy migration');
  const evolve = path.join(root, '.deep-evolve');
  const sessionBytes = Buffer.from([
    'session_id: old-flat',
    'deep_evolve_version: "3.0.0"',
    'status: active',
    'created_at: "2026-01-01T00:00:00Z"',
    'goal: "Legacy Goal"',
    '',
  ].join('\r\n'));
  const journalBytes = Buffer.from('{"id":1,"status":"planned"}\r\n');
  fs.writeFileSync(path.join(evolve, 'session.yaml'), sessionBytes);
  fs.writeFileSync(path.join(evolve, 'journal.jsonl'), journalBytes);
  fs.mkdirSync(path.join(evolve, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(evolve, 'runs', 'one.txt'), Buffer.from([0, 1, 2, 255]));
  try {
    const migrated = expectSuccess(runRequest(root, 'session.migrate-legacy'), 'session.migrate-legacy');
    assert.match(migrated.session_id, /^legacy-/);
    assert.deepEqual(fs.readFileSync(path.join(migrated.session_root, 'session.yaml')), sessionBytes);
    assert.deepEqual(fs.readFileSync(path.join(migrated.session_root, 'journal.jsonl')), journalBytes);
    assert.deepEqual(fs.readFileSync(path.join(migrated.session_root, 'runs', 'one.txt')), Buffer.from([0, 1, 2, 255]));
    assert.equal(fs.existsSync(path.join(evolve, 'session.yaml')), false);
    assert.equal(fs.existsSync(path.join(evolve, 'current.json')), false);
    const registry = fs.readFileSync(path.join(evolve, 'sessions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(registry.at(-1).status, 'archived');
    assert.equal(registry.at(-1).goal, 'Legacy Goal');
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('rejected legacy migration is byte-preserving and creates no partial namespace', () => {
  const { outer, root } = makeProject('rejected migration');
  const evolve = path.join(root, '.deep-evolve');
  const unsupported = Buffer.from('defaults: &defaults\n  status: active\nsession:\n  <<: *defaults\n');
  fs.writeFileSync(path.join(evolve, 'session.yaml'), unsupported);
  fs.writeFileSync(path.join(evolve, 'journal.jsonl'), Buffer.from('{bad\n'));
  const before = new Map([
    ['session.yaml', fs.readFileSync(path.join(evolve, 'session.yaml'))],
    ['journal.jsonl', fs.readFileSync(path.join(evolve, 'journal.jsonl'))],
  ]);
  try {
    const result = runRequest(root, 'session.migrate-legacy');
    assert.equal(result.status, 2);
    assert.match(result.response.error.code, /yaml|state|migration/);
    for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(evolve, name)), bytes);
    assert.deepEqual(
      fs.readdirSync(evolve).filter((name) => name.startsWith('legacy-')),
      [],
    );
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('legacy migration reuses a complete retry destination and replaces an incomplete retry safely', () => {
  for (const complete of [true, false]) {
    const fixture = makeFlatLegacyProject(complete ? 'complete retry' : 'incomplete retry');
    const destination = path.join(fixture.evolve, fixture.sessionId);
    fs.mkdirSync(path.join(destination, 'meta-analyses'), { recursive: true });
    if (complete) {
      for (const [name, bytes] of Object.entries(fixture.files)) fs.writeFileSync(path.join(destination, name), bytes);
    } else {
      fs.writeFileSync(path.join(destination, 'partial.txt'), 'incomplete destination\n');
    }
    try {
      const response = dispatch(request(fixture.root, 'session.migrate-legacy'), fixedMigrationDependencies());
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(response.result.session_id, fixture.sessionId);
      for (const [name, bytes] of Object.entries(fixture.files)) {
        assert.deepEqual(fs.readFileSync(path.join(destination, name)), bytes, `${complete}:${name}`);
        assert.equal(fs.existsSync(path.join(fixture.evolve, name)), false, `${complete}:${name} source remained`);
      }
      assert.equal(fs.existsSync(path.join(destination, 'partial.txt')), false);
      const migrated = fs.readFileSync(path.join(fixture.evolve, 'sessions.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(JSON.parse)
        .filter((entry) => entry.event === 'migrated' && entry.session_id === fixture.sessionId);
      assert.equal(migrated.length, 1);
    } finally {
      fs.rmSync(fixture.outer, { recursive: true, force: true });
    }
  }
});

test('legacy migration crash cutpoints recover committed work and roll back uncommitted work deterministically', () => {
  const cutpoints = [
    ['after-migration-manifest', false],
    ['after-copy:session.yaml', false],
    ['after-copy-verification', false],
    ['after-migration-commit-marker', true],
    ['after-registry-install', true],
    ['before-source-cleanup:session.yaml', true],
    ['after-source-cleanup:session.yaml', true],
  ];
  for (const [cutpoint, committed] of cutpoints) {
    const fixture = makeFlatLegacyProject(`migration cutpoint ${cutpoint}`);
    let injected = false;
    try {
      const first = dispatch(request(fixture.root, 'session.migrate-legacy'), fixedMigrationDependencies({
        onMigrationPhase(phase) {
          if (!injected && phase === cutpoint) {
            injected = true;
            throw Object.assign(new Error(`injected migration crash at ${phase}`), { code: 'injected_migration_crash' });
          }
        },
      }));
      assert.equal(injected, true, `${cutpoint} was not reached`);
      assert.equal(first.ok, false, `${cutpoint} unexpectedly returned success`);

      const recovery = dispatch(request(fixture.root, 'session.list'), fixedMigrationDependencies());
      assert.equal(recovery.ok, true, `${cutpoint}: ${JSON.stringify(recovery)}`);
      if (!committed) {
        assert.deepEqual(fs.readFileSync(path.join(fixture.evolve, 'session.yaml')), fixture.files['session.yaml']);
        const retry = dispatch(request(fixture.root, 'session.migrate-legacy'), fixedMigrationDependencies());
        assert.equal(retry.ok, true, `${cutpoint}: ${JSON.stringify(retry)}`);
      }
      assert.equal(fs.existsSync(path.join(fixture.evolve, 'session.yaml')), false, cutpoint);
      const destination = path.join(fixture.evolve, fixture.sessionId);
      assert.deepEqual(fs.readFileSync(path.join(destination, 'session.yaml')), fixture.files['session.yaml']);
      const registryText = fs.readFileSync(path.join(fixture.evolve, 'sessions.jsonl'), 'utf8');
      const migrated = registryText.trim().split(/\r?\n/).map(JSON.parse)
        .filter((entry) => entry.event === 'migrated' && entry.session_id === fixture.sessionId);
      assert.equal(migrated.length, 1, cutpoint);
      const transactionRoot = path.join(fixture.evolve, '.migration-transactions');
      assert.deepEqual(fs.existsSync(transactionRoot) ? fs.readdirSync(transactionRoot) : [], [], cutpoint);
    } finally {
      fs.rmSync(fixture.outer, { recursive: true, force: true });
    }
  }
});

test('legacy migration retries transient Windows rename/open-target failures and leaves cleanup recoverable', () => {
  const fixture = makeFlatLegacyProject('Windows open target');
  let renameAttempts = 0;
  let removeAttempts = 0;
  try {
    const response = dispatch(request(fixture.root, 'session.migrate-legacy'), fixedMigrationDependencies({
      platform: 'win32',
      migrationRename(from, to) {
        renameAttempts += 1;
        if (renameAttempts < 3) throw Object.assign(new Error('target briefly open'), { code: 'EBUSY' });
        fs.renameSync(from, to);
      },
      migrationRemove(target, options) {
        if (path.basename(target) === 'session.yaml'
            || target.includes('.session.yaml.migration-cleanup-claim-')) {
          removeAttempts += 1;
          if (removeAttempts < 3) throw Object.assign(new Error('target briefly open'), { code: 'EACCES' });
        }
        fs.rmSync(target, options);
      },
      sleep: () => {},
    }));
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(renameAttempts >= 3, true, 'destination rename was not retried');
    assert.equal(removeAttempts >= 3, true, 'source cleanup was not retried');

    const pending = makeFlatLegacyProject('Windows persistent open target');
    let persistentAttempts = 0;
    try {
      const pendingResponse = dispatch(request(pending.root, 'session.migrate-legacy'), fixedMigrationDependencies({
        platform: 'win32',
        migrationRemove(target, options) {
          if (path.basename(target) === 'session.yaml'
              || target.includes('.session.yaml.migration-cleanup-claim-')) {
            persistentAttempts += 1;
            throw Object.assign(new Error('still open'), { code: 'EPERM' });
          }
          fs.rmSync(target, options);
        },
        sleep: () => {},
      }));
      assert.equal(pendingResponse.ok, true, JSON.stringify(pendingResponse));
      const pendingWarning = pendingResponse.warnings.find((warning) => warning.code === 'migration_cleanup_pending'
        && warning.source === 'session.yaml');
      assert.ok(pendingWarning);
      assert.equal(fs.existsSync(pendingWarning.recovery_path), true);
      assert.equal(fs.existsSync(path.join(pending.evolve, 'session.yaml')), false);
      assert.equal(persistentAttempts > 1, true);
      const recovered = dispatch(request(pending.root, 'session.list'), fixedMigrationDependencies());
      assert.equal(recovered.ok, true, JSON.stringify(recovered));
      assert.equal(fs.existsSync(path.join(pending.evolve, 'session.yaml')), false);
    } finally {
      fs.rmSync(pending.outer, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(fixture.outer, { recursive: true, force: true });
  }
});

test('cleanup-pending committed migration is adopted across retries and clock changes', () => {
  const fixture = makeFlatLegacyProject('persistent cleanup adoption');
  let cleanupAttempts = 0;
  const persistentOpen = (timestamp) => fixedMigrationDependencies({
    now: () => Date.parse(timestamp),
    sleep: () => {},
    migrationRemove(target, options) {
      if (path.basename(target) === 'session.yaml'
          || target.includes('.session.yaml.migration-cleanup-claim-')) {
        cleanupAttempts += 1;
        throw Object.assign(new Error('source remains open'), { code: 'EPERM' });
      }
      fs.rmSync(target, options);
    },
  });
  try {
    const first = dispatch(
      request(fixture.root, 'session.migrate-legacy'),
      persistentOpen('2026-07-12T12:34:56Z'),
    );
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.warnings.some((warning) => warning.code === 'migration_cleanup_pending'), true);

    const second = dispatch(
      request(fixture.root, 'session.migrate-legacy'),
      persistentOpen('2026-07-12T12:35:56Z'),
    );
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.result.session_id, first.result.session_id, 'retry must adopt the committed migration');
    assert.equal(second.result.session_root, first.result.session_root);
    assert.equal(second.warnings.some((warning) => warning.code === 'migration_cleanup_pending'), true);

    const migrated = fs.readFileSync(path.join(fixture.evolve, 'sessions.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(JSON.parse).filter((entry) => entry.event === 'migrated');
    assert.deepEqual(migrated.map((entry) => entry.session_id), [first.result.session_id]);
    assert.deepEqual(
      fs.readdirSync(fixture.evolve).filter((name) => name.startsWith('legacy-')),
      [first.result.session_id],
    );
    assert.deepEqual(
      fs.readdirSync(path.join(fixture.evolve, '.migration-transactions')),
      [first.result.session_id],
    );
    const pendingWarning = second.warnings.find((warning) => warning.code === 'migration_cleanup_pending'
      && warning.source === 'session.yaml');
    assert.ok(pendingWarning);
    assert.equal(fs.existsSync(pendingWarning.recovery_path), true);
    assert.equal(fs.existsSync(path.join(fixture.evolve, 'session.yaml')), false);
    assert.equal(cleanupAttempts >= 10, true, 'both calls retry the persistent open target');
  } finally {
    fs.rmSync(fixture.outer, { recursive: true, force: true });
  }
});

test('post-commit transaction-directory cleanup failure is warning-only housekeeping', () => {
  const fixture = makeFlatLegacyProject('transaction directory cleanup warning');
  let housekeepingAttempts = 0;
  try {
    const response = dispatch(request(fixture.root, 'session.migrate-legacy'), fixedMigrationDependencies({
      sleep: () => {},
      migrationRemove(target, options) {
        if (target.includes(`${path.sep}.migration-transactions${path.sep}`)
            && path.basename(target) === fixture.sessionId) {
          housekeepingAttempts += 1;
          throw Object.assign(new Error('transaction directory remains open'), { code: 'EPERM' });
        }
        fs.rmSync(target, options);
      },
    }));
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.result.session_id, fixture.sessionId);
    assert.equal(response.warnings.some((warning) => warning.code === 'migration_housekeeping_pending'), true);
    assert.equal(housekeepingAttempts, 5);
    assert.equal(fs.existsSync(path.join(fixture.evolve, 'session.yaml')), false);
    assert.equal(fs.existsSync(path.join(fixture.evolve, fixture.sessionId, 'session.yaml')), true);
    const migrated = fs.readFileSync(path.join(fixture.evolve, 'sessions.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(JSON.parse).filter((entry) => entry.event === 'migrated');
    assert.equal(migrated.length, 1);
  } finally {
    fs.rmSync(fixture.outer, { recursive: true, force: true });
  }
});

test('committed migration cleanup preserves file replacements at every private-claim seam', () => {
  const scenarios = [
    {
      name: 'before-claim',
      phase: 'before-source-cleanup:session.yaml',
      inject(sourcePath) {
        fs.renameSync(sourcePath, `${sourcePath}.original-by-test`);
        fs.writeFileSync(sourcePath, 'EXTERNAL-BEFORE-CLAIM\n');
      },
      expected: Buffer.from('EXTERNAL-BEFORE-CLAIM\n'),
    },
    {
      name: 'between-claim-and-verify',
      phase: 'after-source-claim:session.yaml',
      inject(_sourcePath, context) {
        assert.equal(typeof context.claim_path, 'string');
        fs.writeFileSync(context.claim_path, 'EXTERNAL-CLAIM-MISMATCH\n');
      },
      expected: Buffer.from('EXTERNAL-CLAIM-MISMATCH\n'),
    },
    {
      name: 'after-claim-before-private-delete',
      phase: 'before-source-claim-delete:session.yaml',
      inject(sourcePath) {
        fs.writeFileSync(sourcePath, 'EXTERNAL-AFTER-CLAIM\n');
      },
      expected: Buffer.from('EXTERNAL-AFTER-CLAIM\n'),
      publicMustSurvive: true,
    },
  ];
  for (const scenario of scenarios) {
    const fixture = makeFlatLegacyProject(`cleanup file claim ${scenario.name}`);
    const sourcePath = path.join(fixture.evolve, 'session.yaml');
    let injected = 0;
    try {
      const response = dispatch(request(fixture.root, 'session.migrate-legacy'), fixedMigrationDependencies({
        onMigrationPhase(phase, context = {}) {
          if (phase !== scenario.phase || injected > 0) return;
          injected += 1;
          scenario.inject(sourcePath, context);
        },
      }));
      assert.equal(response.ok, true, `${scenario.name}: ${JSON.stringify(response)}`);
      assert.equal(injected, 1, `${scenario.name}: injection seam was not reached`);
      const warning = response.warnings.find((entry) => entry.code === 'migration_cleanup_pending'
        && entry.source === 'session.yaml');
      assert.ok(warning, `${scenario.name}: missing typed cleanup warning`);
      const survivors = [sourcePath, warning.recovery_path]
        .filter((candidate) => typeof candidate === 'string' && fs.existsSync(candidate));
      assert.equal(survivors.some((candidate) => fs.readFileSync(candidate).equals(scenario.expected)), true,
        `${scenario.name}: replacement bytes were not preserved`);
      if (scenario.publicMustSurvive) assert.deepEqual(fs.readFileSync(sourcePath), scenario.expected);
    } finally {
      fs.rmSync(fixture.outer, { recursive: true, force: true });
    }
  }
});

test('committed migration cleanup preserves directory replacements at every private-claim seam', () => {
  const scenarios = [
    {
      name: 'before-claim',
      phase: 'before-source-cleanup:runs',
      inject(runs) {
        fs.renameSync(runs, `${runs}.original-by-test`);
        fs.mkdirSync(runs);
        fs.writeFileSync(path.join(runs, 'external.txt'), 'EXTERNAL-DIRECTORY-BEFORE\n');
      },
      expected: Buffer.from('EXTERNAL-DIRECTORY-BEFORE\n'),
    },
    {
      name: 'between-claim-and-verify',
      phase: 'after-source-claim:runs',
      inject(_runs, context) {
        fs.rmSync(context.claim_path, { recursive: true, force: true });
        fs.mkdirSync(context.claim_path);
        fs.writeFileSync(path.join(context.claim_path, 'external.txt'), 'EXTERNAL-DIRECTORY-CLAIM\n');
      },
      expected: Buffer.from('EXTERNAL-DIRECTORY-CLAIM\n'),
    },
    {
      name: 'after-claim-before-private-delete',
      phase: 'before-source-claim-delete:runs',
      inject(runs) {
        fs.mkdirSync(runs);
        fs.writeFileSync(path.join(runs, 'external.txt'), 'EXTERNAL-DIRECTORY-AFTER\n');
      },
      expected: Buffer.from('EXTERNAL-DIRECTORY-AFTER\n'),
      publicMustSurvive: true,
    },
  ];
  for (const scenario of scenarios) {
    const fixture = makeFlatLegacyProject(`cleanup directory claim ${scenario.name}`);
    const runs = path.join(fixture.evolve, 'runs');
    fs.mkdirSync(runs);
    fs.writeFileSync(path.join(runs, 'migrated.bin'), Buffer.from([0, 1, 2, 255]));
    let injected = 0;
    try {
      const response = dispatch(request(fixture.root, 'session.migrate-legacy'), fixedMigrationDependencies({
        onMigrationPhase(phase, context = {}) {
          if (phase !== scenario.phase || injected > 0) return;
          injected += 1;
          scenario.inject(runs, context);
        },
      }));
      assert.equal(response.ok, true, `${scenario.name}: ${JSON.stringify(response)}`);
      assert.equal(injected, 1, `${scenario.name}: injection seam was not reached`);
      const warning = response.warnings.find((entry) => entry.code === 'migration_cleanup_pending'
        && entry.source === 'runs');
      assert.ok(warning, `${scenario.name}: directory mismatch must remain recoverable`);
      const candidates = [runs, warning.recovery_path]
        .filter((candidate) => candidate && fs.existsSync(candidate));
      assert.equal(candidates.some((candidate) => {
        const nested = path.join(candidate, 'external.txt');
        return fs.existsSync(nested) && fs.readFileSync(nested).equals(scenario.expected);
      }), true, `${scenario.name}: replacement directory bytes were not preserved`);
      if (scenario.publicMustSurvive) {
        assert.deepEqual(fs.readFileSync(path.join(runs, 'external.txt')), scenario.expected);
      }
    } finally {
      fs.rmSync(fixture.outer, { recursive: true, force: true });
    }
  }
});

test('migration rebinds verified private file and directory claims under the project lock on first run and retry', () => {
  for (const platform of ['darwin', 'win32']) {
    for (const kind of ['file', 'directory']) {
      const fixture = makeFlatLegacyProject(`private claim rebind ${platform} ${kind}`);
      const sourceName = kind === 'file' ? 'session.yaml' : 'runs';
      const sourcePath = path.join(fixture.evolve, sourceName);
      if (kind === 'directory') {
        fs.mkdirSync(sourcePath);
        fs.writeFileSync(path.join(sourcePath, 'owned.bin'), Buffer.from([0, 1, 2, 255]));
      }
      let movedOriginal = null;
      let replacementClaim = null;
      let injected = 0;
      let sawCoordinationLock = false;
      const dependencies = fixedMigrationDependencies({
        platform,
        sleep: () => {},
        onMigrationPhase(phase, context = {}) {
          if (phase !== `before-source-claim-delete:${sourceName}` || injected > 0) return;
          injected += 1;
          sawCoordinationLock = fs.existsSync(path.join(fixture.evolve, '.coordination-lock'));
          replacementClaim = context.claim_path;
          movedOriginal = `${context.claim_path}.verified-original-by-test`;
          fs.renameSync(context.claim_path, movedOriginal);
          if (kind === 'file') fs.writeFileSync(context.claim_path, 'UNRELATED-PRIVATE-FILE\n');
          else {
            fs.mkdirSync(context.claim_path);
            fs.writeFileSync(path.join(context.claim_path, 'unrelated.txt'), 'UNRELATED-PRIVATE-DIRECTORY\n');
          }
        },
      });
      try {
        const first = dispatch(request(fixture.root, 'session.migrate-legacy'), dependencies);
        assert.equal(first.ok, true, `${platform}/${kind}: ${JSON.stringify(first)}`);
        assert.equal(injected, 1, `${platform}/${kind}: deletion-boundary seam not reached`);
        assert.equal(sawCoordinationLock, true, `${platform}/${kind}: project lock absent at rebind seam`);
        const warning = first.warnings.find((entry) => entry.code === 'migration_cleanup_pending'
          && entry.source === sourceName
          && entry.reason === 'private_claim_identity_changed');
        assert.ok(warning, `${platform}/${kind}: ${JSON.stringify(first.warnings)}`);
        assert.equal(warning.recovery_path, replacementClaim);
        if (kind === 'file') {
          assert.deepEqual(fs.readFileSync(movedOriginal), fixture.files['session.yaml']);
          assert.equal(fs.readFileSync(replacementClaim, 'utf8'), 'UNRELATED-PRIVATE-FILE\n');
        } else {
          assert.deepEqual(fs.readFileSync(path.join(movedOriginal, 'owned.bin')), Buffer.from([0, 1, 2, 255]));
          assert.equal(fs.readFileSync(path.join(replacementClaim, 'unrelated.txt'), 'utf8'),
            'UNRELATED-PRIVATE-DIRECTORY\n');
        }

        const retry = dispatch(request(fixture.root, 'session.migrate-legacy'), dependencies);
        assert.equal(retry.ok, true, `${platform}/${kind} retry: ${JSON.stringify(retry)}`);
        assert.equal(retry.result.session_id, first.result.session_id);
        assert.equal(retry.warnings.some((entry) => entry.code === 'migration_cleanup_pending'
          && entry.source === sourceName), true, JSON.stringify(retry.warnings));
        assert.equal(fs.existsSync(movedOriginal), true, `${platform}/${kind}: original claim lost on retry`);
        assert.equal(fs.existsSync(replacementClaim), true, `${platform}/${kind}: replacement lost on retry`);
      } finally {
        fs.rmSync(fixture.outer, { recursive: true, force: true });
      }
    }
  }
});

test('native Windows migration cleanup retries a momentarily open source claim target', () => {
  const fixture = makeFlatLegacyProject('Windows cleanup claim retry');
  let claimAttempts = 0;
  try {
    const response = dispatch(request(fixture.root, 'session.migrate-legacy'), fixedMigrationDependencies({
      platform: 'win32',
      sleep: () => {},
      migrationRename(from, to) {
        if (path.basename(from) === 'session.yaml' && to.includes('.migration-cleanup-claim-')) {
          claimAttempts += 1;
          if (claimAttempts < 3) throw Object.assign(new Error('source briefly open'), { code: 'EBUSY' });
        }
        fs.renameSync(from, to);
      },
    }));
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(claimAttempts, 3, 'source claim did not use bounded Windows retry');
    assert.equal(fs.existsSync(path.join(fixture.evolve, 'session.yaml')), false);
  } finally {
    fs.rmSync(fixture.outer, { recursive: true, force: true });
  }
});

test('migration flushes every staged regular file before its marker and syncs renamed directories only on POSIX', () => {
  for (const platform of ['darwin', 'win32']) {
    const fixture = makeFlatLegacyProject(`durable migration ${platform}`);
    const events = [];
    const io = recordingMigrationIo(events, { denyDirectoryOpen: platform === 'win32' });
    try {
      const response = dispatch(request(fixture.root, 'session.migrate-legacy'), fixedMigrationDependencies({
        platform,
        migrationIo: io,
        sleep: () => {},
      }));
      assert.equal(response.ok, true, `${platform}: ${JSON.stringify(response)}`);
      const stagedFsyncs = events.filter((event) => event.kind === 'fsync'
        && event.path.includes(`${path.sep}stage${path.sep}`));
      for (const name of ['session.yaml', 'journal.jsonl']) {
        assert.equal(stagedFsyncs.some((event) => event.path.includes(`.${name}.tmp.`)), true,
          `${platform}: ${name} was not flushed while staged`);
      }
      const markerRename = events.findIndex((event) => event.kind === 'rename'
        && path.basename(event.to) === 'commit.json');
      assert.notEqual(markerRename, -1, `${platform}: canonical marker was not observed`);
      assert.equal(events.every((event, index) => event.kind !== 'fsync'
        || !event.path.includes(`${path.sep}stage${path.sep}`) || index < markerRename), true,
      `${platform}: marker preceded a staged-file flush`);
      const destinationRename = events.findIndex((event) => event.kind === 'rename'
        && path.basename(event.from) === 'stage' && path.basename(event.to) === fixture.sessionId);
      assert.notEqual(destinationRename, -1, `${platform}: staged directory install was not observed`);
      const renamedDirectorySync = events.findIndex((event, index) => index > destinationRename
        && event.kind === 'directory-open' && path.resolve(event.path) === path.resolve(fixture.evolve));
      if (platform === 'win32') {
        assert.equal(events.some((event) => event.kind === 'directory-open'), false,
          'Windows migration attempted directory open/fsync');
      } else {
        assert.notEqual(renamedDirectorySync, -1, 'POSIX install rename lacked best-effort directory sync');
        assert.equal(renamedDirectorySync < markerRename, true, 'POSIX directory sync happened after marker publish');
      }
    } finally {
      fs.rmSync(fixture.outer, { recursive: true, force: true });
    }
  }
});

test('staged-file flush failure prevents marker, registry commit, and source cleanup', () => {
  const fixture = makeFlatLegacyProject('migration stage fsync failure');
  const events = [];
  const io = recordingMigrationIo(events, { failStageFile: 'session.yaml' });
  try {
    const response = dispatch(request(fixture.root, 'session.migrate-legacy'), fixedMigrationDependencies({
      platform: 'darwin',
      migrationIo: io,
      sleep: () => {},
    }));
    assert.equal(response.ok, false, JSON.stringify(response));
    assert.equal(response.error.code, 'eio');
    assert.deepEqual(fs.readFileSync(path.join(fixture.evolve, 'session.yaml')), fixture.files['session.yaml']);
    assert.deepEqual(fs.readFileSync(path.join(fixture.evolve, 'journal.jsonl')), fixture.files['journal.jsonl']);
    assert.equal(fs.existsSync(path.join(fixture.evolve, 'sessions.jsonl')), false);
    const transactionRoot = path.join(fixture.evolve, '.migration-transactions');
    const markers = fs.existsSync(transactionRoot)
      ? fs.readdirSync(transactionRoot, { recursive: true }).filter((name) => path.basename(String(name)) === 'commit.json')
      : [];
    assert.deepEqual(markers, []);
  } finally {
    fs.rmSync(fixture.outer, { recursive: true, force: true });
  }
});

test('Windows staged regular-file fsync retries EPERM EACCES and EBUSY then aborts persistently before publication', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const transient = makeFlatLegacyProject(`transient ${code} file fsync`);
    const transientEvents = [];
    try {
      const response = dispatch(request(transient.root, 'session.migrate-legacy'), fixedMigrationDependencies({
        platform: 'win32',
        migrationIo: recordingMigrationIo(transientEvents, {
          failStageFile: 'session.yaml',
          failStageCode: code,
          failStageCount: 2,
          denyDirectoryOpen: true,
        }),
        sleep: () => {},
      }));
      assert.equal(response.ok, true, `${code}: ${JSON.stringify(response)}`);
      const attempts = transientEvents.filter((event) => event.kind === 'fsync'
        && event.path.includes(`${path.sep}stage${path.sep}`)
        && event.path.includes('.session.yaml.tmp.'));
      assert.equal(attempts.length, 3, `${code}: regular-file fsync was not retried twice`);
      assert.equal(transientEvents.some((event) => event.kind === 'directory-open'), false,
        `${code}: Windows opened a directory for fsync`);
    } finally {
      fs.rmSync(transient.outer, { recursive: true, force: true });
    }

    const persistent = makeFlatLegacyProject(`persistent ${code} file fsync`);
    const persistentEvents = [];
    try {
      const response = dispatch(request(persistent.root, 'session.migrate-legacy'), fixedMigrationDependencies({
        platform: 'win32',
        migrationIo: recordingMigrationIo(persistentEvents, {
          failStageFile: 'session.yaml',
          failStageCode: code,
          denyDirectoryOpen: true,
        }),
        sleep: () => {},
      }));
      assert.equal(response.ok, false, `${code}: persistent fsync failure was accepted`);
      assert.equal(response.error.code, code.toLowerCase());
      const attempts = persistentEvents.filter((event) => event.kind === 'fsync'
        && event.path.includes(`${path.sep}stage${path.sep}`)
        && event.path.includes('.session.yaml.tmp.'));
      assert.equal(attempts.length, 10, `${code}: retry budget is not the bounded Windows budget`);
      assert.deepEqual(fs.readFileSync(path.join(persistent.evolve, 'session.yaml')),
        persistent.files['session.yaml']);
      assert.deepEqual(fs.readFileSync(path.join(persistent.evolve, 'journal.jsonl')),
        persistent.files['journal.jsonl']);
      assert.equal(fs.existsSync(path.join(persistent.evolve, 'sessions.jsonl')), false);
      const transactionRoot = path.join(persistent.evolve, '.migration-transactions');
      const markers = fs.existsSync(transactionRoot)
        ? fs.readdirSync(transactionRoot, { recursive: true })
          .filter((name) => path.basename(String(name)) === 'commit.json')
        : [];
      assert.deepEqual(markers, [], `${code}: marker published despite failed regular-file flush`);
      assert.equal(persistentEvents.some((event) => event.kind === 'directory-open'), false,
        `${code}: Windows opened a directory for fsync`);
    } finally {
      fs.rmSync(persistent.outer, { recursive: true, force: true });
    }
  }
});

test('complete legacy fixture groups migrate together with original relative paths and hashes', () => {
  const { manifest, groups } = legacyFixtureGroups();
  for (const [index, [group, entries]] of [...groups.entries()].entries()) {
    const sourceDirectory = path.join(FIXTURE_ROOT, group);
    const { outer, root } = makeProject(`complete migration ${group.replaceAll('/', '-')}`);
    const evolve = path.join(root, '.deep-evolve');
    copyFixtureDirectory(sourceDirectory, evolve);
    const sourceHashes = new Map(entries.map((entry) => [
      entry.copy,
      sha256(fs.readFileSync(path.join(FIXTURE_ROOT, entry.copy))),
    ]));
    try {
      const response = dispatch(request(root, 'session.migrate-legacy'), {
        now: () => Date.parse('2026-07-12T12:34:56Z') + index * 60_000,
      });
      assert.equal(response.ok, true, `${group}: ${JSON.stringify(response)}`);
      for (const entry of entries) {
        const sourcePath = path.join(FIXTURE_ROOT, entry.copy);
        const relative = path.relative(sourceDirectory, sourcePath);
        const destinationPath = path.join(response.result.session_root, relative);
        assert.deepEqual(fs.readFileSync(destinationPath), fs.readFileSync(sourcePath), `${group}:${relative}`);
        assert.equal(sha256(fs.readFileSync(sourcePath)), sourceHashes.get(entry.copy), entry.copy);
        assert.equal(fs.existsSync(path.join(evolve, relative)), false, `${group}:${relative} flat source remains`);
      }
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
  assert.equal(manifest.files.length, [...groups.values()].reduce((sum, entries) => sum + entries.length, 0));
});

test('complete multi-file legacy group rejection preserves every related source byte', () => {
  const sourceDirectory = path.join(FIXTURE_ROOT, 'legacy', 'borrow');
  const { outer, root } = makeProject('complete rejected borrow migration');
  const evolve = path.join(root, '.deep-evolve');
  copyFixtureDirectory(sourceDirectory, evolve);
  const related = ['journal.jsonl', 'forum.jsonl'];
  const before = new Map(related.map((name) => [name, fs.readFileSync(path.join(evolve, name))]));
  fs.writeFileSync(path.join(evolve, 'session.yaml'), 'defaults: &defaults\n  status: active\nsession:\n  <<: *defaults\n');
  const invalidBefore = fs.readFileSync(path.join(evolve, 'session.yaml'));
  try {
    const response = dispatch(request(root, 'session.migrate-legacy'), fixedMigrationDependencies());
    assert.equal(response.ok, false);
    assert.deepEqual(fs.readFileSync(path.join(evolve, 'session.yaml')), invalidBefore);
    for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(evolve, name)), bytes, name);
    assert.deepEqual(fs.readdirSync(evolve).filter((name) => name.startsWith('legacy-')), []);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('the complete Task 1 byte manifest survives dispatcher migration routes byte-for-byte', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'legacy-byte-manifest.json')));
  for (const [index, entry] of manifest.files.entries()) {
    const sourcePath = path.join(FIXTURE_ROOT, entry.copy);
    const sourceBefore = fs.readFileSync(sourcePath);
    assert.equal(sha256(sourceBefore), entry.sha256, entry.copy);

    const { outer, root } = makeProject(`manifest-${index}`);
    const evolve = path.join(root, '.deep-evolve');
    const basename = path.basename(entry.copy);
    const fixtureSession = entry.copy.endsWith('/session.yaml')
      ? sourceBefore
      : Buffer.from(`${JSON.stringify(validSession(`manifest-${index}`), null, 2)}\n`);
    fs.writeFileSync(path.join(evolve, 'session.yaml'), fixtureSession);
    if (basename !== 'session.yaml') fs.writeFileSync(path.join(evolve, basename), sourceBefore);
    try {
      const migrated = runRequest(root, 'session.migrate-legacy');
      assert.equal(migrated.status, 0, `${entry.copy}: ${migrated.stderr}\n${migrated.stdout}`);
      const migratedRoot = migrated.response.result.session_root;
      assert.deepEqual(
        fs.readFileSync(path.join(migratedRoot, basename)),
        basename === 'session.yaml' ? fixtureSession : sourceBefore,
        entry.copy,
      );
      assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore, `source fixture changed: ${entry.copy}`);
      assert.equal(sha256(fs.readFileSync(sourcePath)), entry.sha256);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('every complete Task 1 legacy fixture is readable through the dispatcher without weakening source bytes', () => {
  const { manifest, groups } = legacyFixtureGroups();
  const originalHashes = new Map(manifest.files.map((entry) => [
    entry.copy,
    sha256(fs.readFileSync(path.join(FIXTURE_ROOT, entry.copy))),
  ]));
  for (const [group, entries] of groups) {
    const sourceDirectory = path.join(FIXTURE_ROOT, group);
    const parsed = parseStateDocument(fs.readFileSync(path.join(sourceDirectory, 'session.yaml'), 'utf8'), {
      sourcePath: path.join(sourceDirectory, 'session.yaml'),
    });
    const { outer, root } = makeProject(`compat read ${group.replaceAll('/', '-')}`);
    const namespace = path.join(root, '.deep-evolve', parsed.session_id);
    copyFixtureDirectory(sourceDirectory, namespace);
    try {
      const read = runRequest(root, 'session.read', { session_id: parsed.session_id });
      assert.equal(read.status, 0, `${group}: ${read.stderr}\n${read.stdout}`);
      assert.deepEqual(read.response.result.session, parsed, group);
      if (group === 'legacy/borrow') {
        assert.equal(read.response.result.session.virtual_parallel.N, 2);
        assert.equal(Object.hasOwn(read.response.result.session.virtual_parallel.seeds[0], 'seed_id'), true);
        assert.equal(Object.hasOwn(read.response.result.session.virtual_parallel.seeds[0], 'id'), false);
      }
      if (group === 'legacy/multi_seed') {
        assert.equal(read.response.result.session.virtual_parallel.n_current, 5);
        assert.equal(Object.hasOwn(read.response.result.session.virtual_parallel.seeds[0], 'id'), true);
      }
      const journal = path.join(namespace, 'journal.jsonl');
      if (fs.existsSync(journal)) {
        const text = fs.readFileSync(journal, 'utf8');
        if (text.includes('seed_id')) assert.match(text, /"seed_id"/);
      }
      for (const entry of entries) {
        const fixturePath = path.join(FIXTURE_ROOT, entry.copy);
        assert.equal(sha256(fs.readFileSync(fixturePath)), originalHashes.get(entry.copy), entry.copy);
      }
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('compatibility read accepts CRLF legacy YAML while strict mutations still require live schema', () => {
  const sourcePath = path.join(FIXTURE_ROOT, 'legacy', 'borrow', 'session.yaml');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const crlf = Buffer.from(source.replace(/\n/g, '\r\n'));
  const parsed = parseStateDocument(crlf.toString('utf8'), { sourcePath: 'borrow-crlf.yaml' });
  const { outer, root } = makeProject('CRLF compatibility read');
  const sessionRoot = path.join(root, '.deep-evolve', parsed.session_id);
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, 'session.yaml'), crlf);
  try {
    const read = runRequest(root, 'session.read', { session_id: parsed.session_id });
    assert.equal(read.status, 0, read.stdout);
    assert.deepEqual(read.response.result.session, parsed);
    assert.deepEqual(fs.readFileSync(path.join(sessionRoot, 'session.yaml')), crlf);

    const mutation = runRequest(root, 'session.mark-status', {
      session_id: parsed.session_id,
      status: 'active',
    });
    assert.equal(mutation.status, 2);
    assert.equal(mutation.response.error.code, 'state_validation_failed');
    assert.deepEqual(fs.readFileSync(path.join(sessionRoot, 'session.yaml')), crlf);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('implicit-current session.read uses the compatibility parser and preserves coordination bytes', () => {
  const invalidShapes = [
    ['n-current-zero', {
      N: 1,
      n_current: 0,
      n_initial: 1,
      budget_total: 2,
      seeds: [{ id: 1, status: 'active' }],
    }],
    ['killed-reasoning', {
      N: 1,
      n_current: 1,
      n_initial: 1,
      budget_total: 2,
      seeds: [{ id: 1, status: 'active', killed_reasoning: 'legacy audit text' }],
    }],
  ];
  for (const [shapeName, virtualParallel] of invalidShapes) {
    const { outer, root } = makeProject(`implicit compatibility ${shapeName}`);
    const sid = 'compat-current';
    writeSession(root, sid, validSession(sid, { virtual_parallel: virtualParallel }));
    writeCurrent(root, sid);
    fs.writeFileSync(path.join(root, '.deep-evolve', 'sessions.jsonl'), `${JSON.stringify({
      event: 'created', ts: 't0', session_id: sid, status: 'initializing', goal: 'g',
    })}\n`);
    const expected = validSession(sid, { virtual_parallel: virtualParallel });
    try {
      const before = snapshotTree(path.join(root, '.deep-evolve'));
      const explicit = runRequest(root, 'session.read', { session_id: sid });
      assert.equal(explicit.status, 0, `${shapeName}/explicit: ${explicit.stdout}`);
      assert.deepEqual(explicit.response.result.session, expected);
      assert.deepEqual(snapshotTree(path.join(root, '.deep-evolve')), before,
        `${shapeName}/explicit changed coordination state`);

      const implicit = runRequest(root, 'session.read', {});
      assert.equal(implicit.status, 0, `${shapeName}/implicit: ${implicit.stderr}\n${implicit.stdout}`);
      assert.deepEqual(implicit.response.result.session, expected);
      assert.deepEqual(snapshotTree(path.join(root, '.deep-evolve')), before,
        `${shapeName}/implicit changed coordination state or reconciled the stale registry`);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }
});

test('only session.read tolerates otherwise-valid n_current zero and killed_reasoning legacy shapes', () => {
  const invalidShapes = [
    ['n-current-zero', {
      N: 1,
      n_current: 0,
      n_initial: 1,
      budget_total: 2,
      seeds: [{ id: 1, status: 'active' }],
    }],
    ['killed-reasoning', {
      N: 1,
      n_current: 1,
      n_initial: 1,
      budget_total: 2,
      seeds: [{ id: 1, status: 'active', killed_reasoning: 'legacy audit text' }],
    }],
  ];
  const operations = [
    ['session.resolve-current', {}],
    ['session.mark-status', { session_id: 'strict-session', status: 'paused' }],
    ['session.patch', { session_id: 'strict-session', path: '/goal', value: 'changed' }],
    ['session.complete', { session_id: 'strict-session', outcome: 'kept' }],
    ['virtual.init', {
      session_id: 'strict-session',
      analysis: { project_type: 'standard', eval_parallelizability: 'parallel', reasoning: '' },
      n_chosen: 1,
      total_budget: 2,
    }],
    ['virtual.append-seed', {
      session_id: 'strict-session', seed_id: 1, worktree_path: '/tmp/seed', branch: 'seed-1', beta: {},
    }],
    ['virtual.rebuild-seeds', { session_id: 'strict-session' }],
    ['virtual.set-field', { session_id: 'strict-session', key: 'N', value: 1 }],
  ];

  for (const [shapeName, virtualParallel] of invalidShapes) {
    for (const [operation, payload] of operations) {
      const { outer, root } = makeProject(`strict ${shapeName} ${operation}`);
      const sid = 'strict-session';
      const sessionRoot = writeSession(root, sid, validSession(sid, { virtual_parallel: virtualParallel }));
      writeCurrent(root, sid);
      fs.writeFileSync(path.join(root, '.deep-evolve', 'sessions.jsonl'), `${JSON.stringify({
        event: 'created', ts: 't0', session_id: sid, status: 'active', goal: 'g',
      })}\n`);
      fs.writeFileSync(path.join(sessionRoot, 'journal.jsonl'), `${JSON.stringify({
        event: 'seed_initialized', seed_id: 1, ts: '2026-07-12T01:00:00Z',
      })}\n`);
      try {
        const compatibilityRead = runRequest(root, 'session.read', { session_id: sid });
        assert.equal(compatibilityRead.status, 0, `${shapeName}: session.read lost compatibility`);
        assert.deepEqual(compatibilityRead.response.result.session,
          validSession(sid, { virtual_parallel: virtualParallel }));

        const before = snapshotTree(path.join(root, '.deep-evolve'));
        const result = runRequest(root, operation, payload);
        assert.equal(result.status, 2, `${shapeName}/${operation}: ${result.stderr}\n${result.stdout}`);
        assert.equal(result.response.error.code, 'state_validation_failed', `${shapeName}/${operation}`);
        assert.deepEqual(snapshotTree(path.join(root, '.deep-evolve')), before,
          `${shapeName}/${operation} did not preserve every state byte`);
      } finally {
        fs.rmSync(outer, { recursive: true, force: true });
      }
    }
  }
});
