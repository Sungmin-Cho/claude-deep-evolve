'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { wrapEvolveArtifact } = require('../hooks/scripts/wrap-evolve-envelope.js');
const { buildHandoffArtifact } = require('../hooks/scripts/emit-handoff.js');
const { buildCompactionArtifact } = require('../hooks/scripts/emit-compaction-state.js');
const { exportFeedback } = require('../hooks/scripts/runtime/synthesis.cjs');
const { dispatch } = require('../hooks/scripts/deep-evolve-runtime.cjs');
const { validateSession } = require('../hooks/scripts/runtime/session-codec.cjs');
const { isPathInside } = require('../hooks/scripts/runtime/runtime-paths.cjs');

const START_FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'session-start-v3.5.json'),
  'utf8',
));
const CASES = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'artifact-publication-cases.json'),
  'utf8',
));
const FIXED_NOW = Date.parse('2026-07-14T00:00:00Z');
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function digest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr || `${args.join(' ')} failed`);
  return result.stdout.trim();
}

function request(projectRoot, operation, payload, dependencies = {}) {
  return dispatch({
    schema_version: '1.0',
    operation,
    context: { project_root: projectRoot },
    payload,
  }, {
    now: () => FIXED_NOW,
    ...dependencies,
  });
}

function expectSuccess(response, label) {
  assert.equal(response.ok, true, `${label}: ${JSON.stringify(response)}`);
  assert.equal(response.exitCode, 0, label);
  return response.result;
}

function makeProject(t, label = 'artifact project with spaces') {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-artifact-publication-'));
  const projectRoot = path.join(outer, label);
  fs.mkdirSync(path.join(projectRoot, '.deep-evolve'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'index.js'), 'module.exports = 1;\n');
  git(projectRoot, ['init', '-q']);
  git(projectRoot, ['config', 'user.email', 'artifact@example.invalid']);
  git(projectRoot, ['config', 'user.name', 'Artifact Test']);
  git(projectRoot, ['add', 'src/index.js']);
  git(projectRoot, ['commit', '-qm', 'base']);
  const started = expectSuccess(request(projectRoot, 'session.start', {
    goal: 'immutable artifacts',
    initial_state: structuredClone(START_FIXTURE.initial_state),
  }), 'session.start');
  const sessionRoot = fs.realpathSync(started.session_root);
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const physicalProjectRoot = fs.realpathSync(projectRoot);
  return {
    projectRoot: physicalProjectRoot,
    stateRoot: path.join(physicalProjectRoot, '.deep-evolve'),
    sessionId: started.session_id,
    sessionRoot,
    sessionPath: path.join(sessionRoot, 'session.yaml'),
  };
}

function sessionDigest(project) {
  return digest(fs.readFileSync(project.sessionPath));
}

function activateSession(project) {
  const session = JSON.parse(fs.readFileSync(project.sessionPath, 'utf8'));
  session.status = 'active';
  session.metric = { ...session.metric, baseline: 1, current: 1, best: 1 };
  validateSession(session);
  fs.writeFileSync(project.sessionPath, `${JSON.stringify(session, null, 2)}\n`);
  return session;
}

function tree(root) {
  const values = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        values.push(`${relative}/`);
        visit(absolute);
      } else if (entry.isFile()) values.push(`${relative}:${digest(fs.readFileSync(absolute))}`);
      else values.push(`${relative}:special`);
    }
  };
  visit(root);
  return values;
}

test('artifact builders remain write-free when deterministic identity is injected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-pure-builders-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source envelope.json');
  fs.writeFileSync(source, '{"source":true}\n');
  const options = {
    runId: CASES.publication_ids.receipt,
    generatedAt: '2026-07-14T00:00:00.000Z',
    git: { head: '0'.repeat(40), branch: 'main', dirty: false },
    producerVersion: '3.4.3',
    toolVersions: { node: 'v22.23.1' },
  };
  const before = tree(root);
  wrapEvolveArtifact({
    artifactKind: 'evolve-receipt',
    payload: structuredClone(CASES.receipt_payload),
    sessionId: 'session-1',
    sourceArtifacts: [{ path: source }],
    envelopeOptions: options,
  });
  buildHandoffArtifact({
    payload: structuredClone(CASES.handoff_payload),
    sessionId: 'session-1',
    sourceArtifacts: [{ path: source }],
    envelopeOptions: options,
  });
  buildCompactionArtifact({
    payload: structuredClone(CASES.compaction_payload),
    sessionId: 'session-1',
    sourceArtifacts: [{ path: source }],
    envelopeOptions: options,
  });
  exportFeedback({
    payload: structuredClone(CASES.feedback_payload),
    sessionId: 'session-1',
    sourceArtifacts: [{ path: source }],
    envelopeOptions: options,
  });
  assert.deepEqual(tree(root), before);
});

test('all five artifact operations publish one durable runtime-derived artifact', (t) => {
  const project = makeProject(t);
  const expectedSessionSha256 = sessionDigest(project);
  const rows = [
    {
      operation: 'artifact.wrap-receipt',
      publicationId: CASES.publication_ids.receipt,
      kind: 'evolve-receipt',
      payload: {
        payload: structuredClone(CASES.receipt_payload),
        session_id: project.sessionId,
        source_artifacts: [],
        publication_id: CASES.publication_ids.receipt,
        expected_session_sha256: expectedSessionSha256,
      },
      expected: path.join(project.sessionRoot, 'evolve-receipt.json'),
    },
    {
      operation: 'artifact.wrap-insights',
      publicationId: CASES.publication_ids.insights,
      kind: 'evolve-insights',
      payload: {
        payload: structuredClone(CASES.insights_payload),
        session_id: project.sessionId,
        source_artifacts: [],
        publication_id: CASES.publication_ids.insights,
        expected_session_sha256: expectedSessionSha256,
      },
      expected: path.join(project.sessionRoot, 'evolve-insights.json'),
    },
    {
      operation: 'artifact.emit-compaction',
      publicationId: CASES.publication_ids.compaction,
      kind: 'compaction-state',
      payload: {
        payload: structuredClone(CASES.compaction_payload),
        session_id: project.sessionId,
        source_artifacts: [],
        publication_id: CASES.publication_ids.compaction,
        expected_session_sha256: expectedSessionSha256,
      },
      expected: path.join(project.stateRoot, 'compaction-states',
        `${CASES.publication_ids.compaction}-${project.sessionId}.json`),
    },
    {
      operation: 'artifact.emit-handoff',
      publicationId: CASES.publication_ids.handoff,
      kind: 'handoff',
      payload: {
        payload: structuredClone(CASES.handoff_payload),
        session_id: project.sessionId,
        source_artifacts: [],
        publication_id: CASES.publication_ids.handoff,
        expected_session_sha256: expectedSessionSha256,
      },
      expected: path.join(project.stateRoot, 'handoffs',
        `${CASES.publication_ids.handoff}-${project.sessionId}.json`),
    },
    {
      operation: 'transfer.export-feedback',
      publicationId: CASES.publication_ids.feedback,
      kind: 'evolve-insights',
      payload: {
        payload: structuredClone(CASES.feedback_payload),
        session_id: project.sessionId,
        source_artifacts: [],
        publication_id: CASES.publication_ids.feedback,
        expected_session_sha256: expectedSessionSha256,
      },
      expected: path.join(project.stateRoot, 'feedback-exports',
        `${CASES.publication_ids.feedback}-${project.sessionId}.json`),
    },
  ];

  for (const row of rows) {
    const result = expectSuccess(request(project.projectRoot, row.operation, row.payload), row.operation);
    assert.deepEqual(Object.keys(result).sort(), [
      'artifact_path', 'artifact_sha256', 'envelope', 'publication_id', 'replayed',
    ]);
    assert.equal(result.artifact_path, row.expected);
    assert.equal(result.publication_id, row.publicationId);
    assert.equal(result.replayed, false);
    assert.match(result.artifact_sha256, HASH_RE);
    assert.equal(fs.existsSync(result.artifact_path), true);
    assert.equal(digest(fs.readFileSync(result.artifact_path)), result.artifact_sha256);
    assert.equal(result.envelope.envelope.artifact_kind, row.kind);
    assert.equal(result.envelope.envelope.run_id, row.publicationId);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.artifact_path, 'utf8')), result.envelope);
  }
});

test('publication replay is byte-identical and conflicting reuse preserves all evidence', (t) => {
  const project = makeProject(t, 'artifact replay');
  const payload = {
    payload: structuredClone(CASES.receipt_payload),
    session_id: project.sessionId,
    source_artifacts: [],
    publication_id: CASES.publication_ids.receipt,
    expected_session_sha256: sessionDigest(project),
  };
  const first = expectSuccess(request(project.projectRoot, 'artifact.wrap-receipt', payload),
    'initial receipt publication');
  const artifactBytes = fs.readFileSync(first.artifact_path);
  const beforeReplay = tree(project.stateRoot);
  const replay = expectSuccess(request(project.projectRoot, 'artifact.wrap-receipt',
    structuredClone(payload)), 'receipt replay');
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.deepEqual(fs.readFileSync(first.artifact_path), artifactBytes);
  assert.deepEqual(tree(project.stateRoot), beforeReplay);

  const conflict = request(project.projectRoot, 'artifact.wrap-receipt', {
    ...structuredClone(payload),
    payload: { ...structuredClone(payload.payload), outcome: 'discarded' },
  });
  assert.equal(conflict.exitCode, 2, JSON.stringify(conflict));
  assert.equal(conflict.error.code, 'publication_id_conflict');
  assert.deepEqual(fs.readFileSync(first.artifact_path), artifactBytes);
  assert.deepEqual(tree(project.stateRoot), beforeReplay);
});

test('stale session authority and provisional receipt outcomes fail before publication', (t) => {
  const project = makeProject(t, 'artifact stale preimage');
  const before = tree(project.stateRoot);
  const stale = request(project.projectRoot, 'artifact.wrap-receipt', {
    payload: structuredClone(CASES.receipt_payload),
    session_id: project.sessionId,
    source_artifacts: [],
    publication_id: CASES.publication_ids.receipt,
    expected_session_sha256: `sha256:${'0'.repeat(64)}`,
  });
  assert.equal(stale.exitCode, 1, JSON.stringify(stale));
  assert.equal(stale.error.code, 'stale_preimage');
  assert.deepEqual(tree(project.stateRoot), before);

  const provisional = request(project.projectRoot, 'artifact.wrap-receipt', {
    payload: { ...structuredClone(CASES.receipt_payload), outcome: null },
    session_id: project.sessionId,
    source_artifacts: [],
    publication_id: CASES.publication_ids.receipt,
    expected_session_sha256: sessionDigest(project),
  });
  assert.equal(provisional.exitCode, 2, JSON.stringify(provisional));
  assert.equal(provisional.error.code, 'receipt_outcome_required');
  assert.deepEqual(tree(project.stateRoot), before);

  const invalidOutcome = request(project.projectRoot, 'artifact.wrap-receipt', {
    payload: { ...structuredClone(CASES.receipt_payload), outcome: 'pending' },
    session_id: project.sessionId,
    source_artifacts: [],
    publication_id: CASES.publication_ids.receipt,
    expected_session_sha256: sessionDigest(project),
  });
  assert.equal(invalidOutcome.exitCode, 2, JSON.stringify(invalidOutcome));
  assert.equal(invalidOutcome.error.code, 'receipt_outcome_invalid');
  assert.deepEqual(tree(project.stateRoot), before);
});

test('legacy fixed artifacts require an exact migration preimage and are never replaced', (t) => {
  const project = makeProject(t, 'artifact legacy migration');
  const legacyPath = path.join(project.sessionRoot, 'evolve-receipt.json');
  const legacyBytes = Buffer.from('{"receipt_schema_version":2,"outcome":"kept"}\n');
  fs.writeFileSync(legacyPath, legacyBytes);
  const payload = {
    payload: structuredClone(CASES.receipt_payload),
    session_id: project.sessionId,
    source_artifacts: [],
    publication_id: CASES.publication_ids.receipt,
    expected_session_sha256: sessionDigest(project),
  };
  const before = tree(project.stateRoot);
  const omitted = request(project.projectRoot, 'artifact.wrap-receipt', payload);
  assert.equal(omitted.exitCode, 2, JSON.stringify(omitted));
  assert.equal(omitted.error.code, 'legacy_artifact_requires_migration');
  assert.deepEqual(tree(project.stateRoot), before);

  const mismatch = request(project.projectRoot, 'artifact.wrap-receipt', {
    ...payload,
    legacy_artifact_sha256: `sha256:${'f'.repeat(64)}`,
  });
  assert.equal(mismatch.exitCode, 2, JSON.stringify(mismatch));
  assert.equal(mismatch.error.code, 'legacy_artifact_requires_migration');
  assert.deepEqual(tree(project.stateRoot), before);

  const migrated = expectSuccess(request(project.projectRoot, 'artifact.wrap-receipt', {
    ...payload,
    legacy_artifact_sha256: digest(legacyBytes),
  }), 'legacy receipt migration');
  assert.equal(migrated.artifact_path, path.join(project.sessionRoot, 'artifacts',
    'evolve-receipt', `${CASES.publication_ids.receipt}.json`));
  assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes);
  assert.notDeepEqual(fs.readFileSync(migrated.artifact_path), legacyBytes);
});

test('crash cutpoints recover one immutable publication without minting another run id', (t) => {
  for (const [index, phase] of [
    'after-preparation-temp-open',
    'after-preparation-temp-write',
    'after-preparation-temp-flush',
    'after-preparation-install',
    'after-preparation-cleanup',
    'after-artifact-temp-open',
    'after-artifact-temp-write',
    'after-artifact-temp-flush',
    'after-artifact-install',
    'after-artifact-cleanup',
    'after-marker-temp-open',
    'after-marker-temp-write',
    'after-marker-temp-flush',
    'after-marker-install',
    'after-marker-cleanup',
    'before-success-response',
  ].entries()) {
    const project = makeProject(t, `artifact low-level cutpoint ${index}`);
    const publicationId = `01J${String(650 + index).padStart(23, '0')}`;
    const payload = {
      payload: structuredClone(CASES.receipt_payload),
      session_id: project.sessionId,
      source_artifacts: [],
      publication_id: publicationId,
      expected_session_sha256: sessionDigest(project),
    };
    let triggered = 0;
    let preparedArtifactBytes = null;
    const interrupted = request(project.projectRoot, 'artifact.wrap-receipt', payload, {
      artifactOptions: {
        onPhase(current, context) {
          if (current === phase) {
            triggered += 1;
            if (phase === 'after-preparation-temp-flush') {
              const preparation = JSON.parse(fs.readFileSync(context.tempPath, 'utf8'));
              preparedArtifactBytes = Buffer.from(preparation.artifact_bytes_base64, 'base64');
            }
            throw Object.assign(new Error(`simulated ${phase}`), { code: 'simulated_crash' });
          }
        },
      },
    });
    assert.equal(interrupted.ok, false, `${phase}: ${JSON.stringify(interrupted)}`);
    assert.equal(triggered, 1, phase);
    const recovered = expectSuccess(request(project.projectRoot, 'artifact.wrap-receipt', payload, {
      now: () => FIXED_NOW + 60_000,
    }), `${phase} recovery`);
    assert.equal(recovered.envelope.envelope.run_id, publicationId, phase);
    assert.equal(digest(fs.readFileSync(recovered.artifact_path)), recovered.artifact_sha256, phase);
    if (preparedArtifactBytes) {
      assert.deepEqual(fs.readFileSync(recovered.artifact_path), preparedArtifactBytes,
        'preparation-temp retry must not change generatedAt or artifact bytes');
    }
    const second = expectSuccess(request(project.projectRoot, 'artifact.wrap-receipt', payload, {
      now: () => FIXED_NOW + 120_000,
    }), `${phase} replay`);
    assert.equal(second.replayed, true, phase);
    assert.deepEqual(second, { ...recovered, replayed: true }, phase);
  }

});

test('a parent swap after temp flush cannot redirect install or delete foreign cleanup bytes', {
  skip: process.platform === 'win32'
    ? 'Windows does not permit renaming this live publication parent without elevated filesystem privileges'
    : false,
}, (t) => {
  const project = makeProject(t, 'artifact swapped parent');
  const targetParent = path.join(project.stateRoot, 'handoffs');
  const displacedParent = path.join(project.stateRoot, 'handoffs.displaced');
  const foreignMarker = path.join(targetParent, 'foreign.txt');
  let swapped = false;
  const response = request(project.projectRoot, 'artifact.emit-handoff', {
    payload: structuredClone(CASES.handoff_payload),
    session_id: project.sessionId,
    source_artifacts: [],
    publication_id: CASES.publication_ids.handoff,
    expected_session_sha256: sessionDigest(project),
  }, {
    artifactOptions: {
      onPhase(phase) {
        if (phase !== 'after-artifact-temp-flush' || swapped) return;
        swapped = true;
        fs.renameSync(targetParent, displacedParent);
        fs.mkdirSync(targetParent);
        fs.writeFileSync(foreignMarker, 'foreign bytes');
      },
    },
  });
  assert.equal(swapped, true);
  assert.equal(response.exitCode, 2, JSON.stringify(response));
  assert.equal(response.error.code, 'artifact_path_escape');
  assert.deepEqual(fs.readdirSync(targetParent), ['foreign.txt']);
  assert.equal(fs.readFileSync(foreignMarker, 'utf8'), 'foreign bytes');
  assert.ok(fs.readdirSync(displacedParent).some((name) => name.includes('.tmp.')),
    'an unreachable owned temp is safer than deleting through the replacement path');
});

test('an injected parent identity change rejects artifact installation on every platform', (t) => {
  const project = makeProject(t, 'artifact changed parent identity');
  const targetParent = path.join(project.stateRoot, 'handoffs');
  let identityChanged = false;
  const io = new Proxy(fs, {
    get(target, property) {
      if (property === 'lstatSync') {
        return (candidate, ...args) => {
          const stat = target.lstatSync(candidate, ...args);
          if (!identityChanged || path.resolve(candidate) !== path.resolve(targetParent)) return stat;
          return new Proxy(stat, {
            get(statTarget, statProperty) {
              if (statProperty === 'ino') {
                return typeof statTarget.ino === 'bigint' ? statTarget.ino + 1n : statTarget.ino + 1;
              }
              const value = statTarget[statProperty];
              return typeof value === 'function' ? value.bind(statTarget) : value;
            },
          });
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const response = request(project.projectRoot, 'artifact.emit-handoff', {
    payload: structuredClone(CASES.handoff_payload),
    session_id: project.sessionId,
    source_artifacts: [],
    publication_id: CASES.publication_ids.handoff,
    expected_session_sha256: sessionDigest(project),
  }, {
    artifactOptions: {
      io,
      onPhase(phase) {
        if (phase === 'after-artifact-temp-flush') identityChanged = true;
      },
    },
  });
  assert.equal(identityChanged, true);
  assert.equal(response.exitCode, 2, JSON.stringify(response));
  assert.equal(response.error.code, 'artifact_path_escape');
  assert.deepEqual(fs.readdirSync(targetParent), []);
});

test('coherently checksummed preparation evidence cannot change kind or canonical target', (t) => {
  const project = makeProject(t, 'artifact forged preparation');
  let preparationPath;
  const payload = {
    payload: structuredClone(CASES.receipt_payload),
    session_id: project.sessionId,
    source_artifacts: [],
    publication_id: CASES.publication_ids.receipt,
    expected_session_sha256: sessionDigest(project),
  };
  const interrupted = request(project.projectRoot, 'artifact.wrap-receipt', payload, {
    artifactOptions: {
      onPhase(phase, context) {
        if (phase !== 'after-preparation-install') return;
        preparationPath = context.filePath;
        const record = JSON.parse(fs.readFileSync(preparationPath, 'utf8'));
        record.artifact_kind = 'handoff';
        const { record_checksum: _checksum, ...body } = record;
        record.record_checksum = digest(Buffer.from(JSON.stringify(canonicalize(body))));
        fs.writeFileSync(preparationPath, `${JSON.stringify(record, null, 2)}\n`);
        throw Object.assign(new Error('simulated coherent evidence forgery'), {
          code: 'simulated_crash',
        });
      },
    },
  });
  assert.equal(interrupted.ok, false, JSON.stringify(interrupted));
  assert.equal(typeof preparationPath, 'string');
  const before = fs.readFileSync(preparationPath);
  const recovered = request(project.projectRoot, 'artifact.wrap-receipt', payload);
  assert.equal(recovered.exitCode, 2, JSON.stringify(recovered));
  assert.equal(recovered.error.code, 'artifact_publication_ambiguous');
  assert.deepEqual(fs.readFileSync(preparationPath), before);
});

test('a target that wins the install race is preserved as ambiguous evidence', (t) => {
  const project = makeProject(t, 'artifact install race');
  const foreign = Buffer.from('{"foreign":true}\n');
  const target = path.join(project.sessionRoot, 'evolve-receipt.json');
  let installed = false;
  const response = request(project.projectRoot, 'artifact.wrap-receipt', {
    payload: structuredClone(CASES.receipt_payload),
    session_id: project.sessionId,
    source_artifacts: [],
    publication_id: CASES.publication_ids.receipt,
    expected_session_sha256: sessionDigest(project),
  }, {
    artifactOptions: {
      onPhase(phase) {
        if (phase === 'before-artifact-install' && !installed) {
          installed = true;
          fs.writeFileSync(target, foreign, { flag: 'wx' });
        }
      },
    },
  });
  assert.equal(response.exitCode, 2, JSON.stringify(response));
  assert.equal(response.error.code, 'artifact_publication_ambiguous');
  assert.deepEqual(fs.readFileSync(target), foreign);
});

test('source and target symlinks fail closed without writing through them', (t) => {
  const project = makeProject(t, 'artifact symlink containment');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-artifact-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideSource = path.join(outside, 'source.json');
  fs.writeFileSync(outsideSource, '{"source":true}\n');
  const sourceLink = path.join(project.projectRoot, 'source-link.json');
  fs.symlinkSync(outsideSource, sourceLink);
  const sourceRejected = request(project.projectRoot, 'artifact.wrap-receipt', {
    payload: structuredClone(CASES.receipt_payload),
    session_id: project.sessionId,
    source_artifacts: [{ path: sourceLink }],
    publication_id: CASES.publication_ids.receipt,
    expected_session_sha256: sessionDigest(project),
  });
  assert.equal(sourceRejected.exitCode, 2, JSON.stringify(sourceRejected));
  assert.equal(sourceRejected.error.code, 'source_artifact_symlink');

  const handoffOutside = path.join(outside, 'handoffs');
  fs.mkdirSync(handoffOutside);
  fs.symlinkSync(handoffOutside, path.join(project.stateRoot, 'handoffs'));
  const targetRejected = request(project.projectRoot, 'artifact.emit-handoff', {
    payload: structuredClone(CASES.handoff_payload),
    session_id: project.sessionId,
    source_artifacts: [],
    publication_id: CASES.publication_ids.handoff,
    expected_session_sha256: sessionDigest(project),
  });
  assert.equal(targetRejected.exitCode, 2, JSON.stringify(targetRejected));
  assert.equal(targetRejected.error.code, 'artifact_path_escape');
  assert.deepEqual(fs.readdirSync(handoffOutside), []);
});

test('injected win32 publication retries transient links and never opens a directory handle', (t) => {
  const project = makeProject(t, 'artifact injected windows');
  const events = [];
  let transient = 0;
  const descriptors = new Map();
  const io = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (candidate, flags, ...args) => {
          if (flags === 'r' && target.existsSync(candidate) && target.statSync(candidate).isDirectory()) {
            events.push({ kind: 'directory-open', candidate: String(candidate) });
            throw Object.assign(new Error('directory handle forbidden'), { code: 'EPERM' });
          }
          const fd = target.openSync(candidate, flags, ...args);
          descriptors.set(fd, String(candidate));
          events.push({ kind: 'open', candidate: String(candidate), flags });
          return fd;
        };
      }
      if (property === 'fsyncSync') {
        return (fd) => {
          events.push({ kind: 'fsync', candidate: descriptors.get(fd) || String(fd) });
          return target.fsyncSync(fd);
        };
      }
      if (property === 'closeSync') {
        return (fd) => {
          descriptors.delete(fd);
          return target.closeSync(fd);
        };
      }
      if (property === 'linkSync') {
        return (from, to) => {
          if (transient < 3) {
            const codes = ['EPERM', 'EACCES', 'EBUSY'];
            const code = codes[transient];
            transient += 1;
            throw Object.assign(new Error(code), { code });
          }
          return target.linkSync(from, to);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const published = expectSuccess(request(project.projectRoot, 'artifact.wrap-receipt', {
    payload: structuredClone(CASES.receipt_payload),
    session_id: project.sessionId,
    source_artifacts: [],
    publication_id: CASES.publication_ids.receipt,
    expected_session_sha256: sessionDigest(project),
  }, {
    artifactOptions: { io, platform: 'win32', sleep: () => {} },
  }), 'injected win32 publication');
  assert.equal(transient, 3);
  assert.equal(events.some((event) => event.kind === 'directory-open'), false);
  assert.ok(events.some((event) => event.kind === 'fsync'
    && event.candidate.includes('.tmp.')));
  assert.equal(fs.existsSync(published.artifact_path), true);

  assert.equal(isPathInside('C:\\work\\project', 'c:\\WORK\\project\\artifact.json', 'win32'), true);
  assert.equal(isPathInside('C:\\work\\project', 'D:\\work\\project\\artifact.json', 'win32'), false);
  assert.equal(isPathInside('\\\\server\\share\\project',
    '\\\\server\\share\\project\\artifact.json', 'win32'), true);
  assert.equal(isPathInside('\\\\server\\share\\project',
    '\\\\server\\other\\project\\artifact.json', 'win32'), false);
});

test('D0 publications complete to D1, replay historically, and reject fresh stale emits', (t) => {
  const project = makeProject(t, 'artifact digest epochs');
  activateSession(project);
  const d0 = sessionDigest(project);
  const receiptRequest = {
    payload: structuredClone(CASES.receipt_payload),
    session_id: project.sessionId,
    source_artifacts: [],
    publication_id: CASES.publication_ids.receipt,
    expected_session_sha256: d0,
  };
  const receipt = expectSuccess(request(project.projectRoot,
    'artifact.wrap-receipt', receiptRequest), 'receipt under D0');
  const telemetry = expectSuccess(request(project.projectRoot,
    'artifact.emit-compaction', {
      payload: structuredClone(CASES.compaction_payload),
      session_id: project.sessionId,
      source_artifacts: [{
        path: receipt.artifact_path,
        run_id: receipt.envelope.envelope.run_id,
      }],
      publication_id: CASES.publication_ids.compaction,
      expected_session_sha256: d0,
    }), 'telemetry under D0');
  assert.equal(fs.existsSync(telemetry.artifact_path), true);

  const reportBytes = Buffer.from('# Report\n\ncomplete\n');
  fs.writeFileSync(path.join(project.sessionRoot, 'report.md'), reportBytes);
  const beforeJournal = fs.readFileSync(path.join(project.sessionRoot, 'journal.jsonl'));
  const finalBranch = git(project.projectRoot, ['branch', '--show-current']);
  const finalCommit = git(project.projectRoot, ['rev-parse', 'HEAD']);
  const completed = expectSuccess(request(project.projectRoot, 'session.complete', {
    session_id: project.sessionId,
    operation_id: '01J00000000000000000000750',
    expected_session_sha256: d0,
    expected_journal_sha256: digest(beforeJournal),
    outcome: 'merged',
    final_branch: finalBranch,
    final_commit: finalCommit,
    report: { relative_path: 'report.md', sha256: digest(reportBytes) },
    receipt: {
      relative_path: path.relative(project.sessionRoot, receipt.artifact_path)
        .split(path.sep).join('/'),
      sha256: receipt.artifact_sha256,
    },
    synthesis: { outcome: 'baseline', commit: null },
    final_strategy: {},
  }), 'session.complete D0 to D1');
  const d1 = completed.session_sha256;
  assert.notEqual(d1, d0);

  const historicalReplay = expectSuccess(request(project.projectRoot,
    'artifact.wrap-receipt', receiptRequest), 'historical D0 replay');
  assert.deepEqual(historicalReplay, { ...receipt, replayed: true });

  const beforeStale = tree(project.stateRoot);
  const stale = request(project.projectRoot, 'artifact.emit-handoff', {
    payload: structuredClone(CASES.handoff_payload),
    session_id: project.sessionId,
    source_artifacts: [],
    publication_id: '01J00000000000000000000751',
    expected_session_sha256: d0,
  });
  assert.equal(stale.exitCode, 1, JSON.stringify(stale));
  assert.equal(stale.error.code, 'stale_preimage');
  assert.deepEqual(tree(project.stateRoot), beforeStale);

  const postCompletion = expectSuccess(request(project.projectRoot,
    'artifact.emit-handoff', {
      payload: structuredClone(CASES.handoff_payload),
      session_id: project.sessionId,
      source_artifacts: [],
      publication_id: '01J00000000000000000000752',
      expected_session_sha256: d1,
    }), 'post-completion D1 publication');
  assert.equal(fs.existsSync(postCompletion.artifact_path), true);
});
