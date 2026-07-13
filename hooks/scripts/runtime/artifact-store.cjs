'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  installFileExclusive,
  withDirectoryLock,
} = require('./session-store.cjs');
const { isPathInside } = require('./runtime-paths.cjs');

const PUBLICATION_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const BUILDER_VERSION = '1.0';
const TRANSIENT_CONFLICT_CODES = new Set(['EEXIST']);

function artifactError(code, message, rc = 2, details) {
  const error = Object.assign(new Error(message), { code, rc });
  if (details !== undefined) error.details = details;
  return error;
}

function sha256Digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function checksummedRecord(kind, value) {
  const body = {
    record_schema_version: '1.0',
    kind,
    ...value,
  };
  return {
    ...body,
    record_checksum: sha256Digest(Buffer.from(canonicalJson(body))),
  };
}

function validateRecord(value, kind, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw artifactError('artifact_publication_ambiguous', `${label} is not an object`);
  }
  const { record_checksum: actual, ...body } = value;
  if (value.record_schema_version !== '1.0'
      || value.kind !== kind
      || typeof actual !== 'string'
      || actual !== sha256Digest(Buffer.from(canonicalJson(body)))) {
    throw artifactError('artifact_publication_ambiguous', `${label} checksum or identity is invalid`);
  }
  return value;
}

function sameStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function stableReadRegular(filePath, {
  io = fs,
  missingCode = 'artifact_missing',
  symlinkCode = 'artifact_path_escape',
  invalidCode = 'artifact_not_regular',
  changedCode = 'artifact_changed_during_read',
  label = 'artifact',
} = {}) {
  let initial;
  try { initial = io.lstatSync(filePath); }
  catch (error) {
    if (error && error.code === 'ENOENT') {
      throw artifactError(missingCode, `${label} is missing: ${filePath}`);
    }
    throw error;
  }
  if (initial.isSymbolicLink()) {
    throw artifactError(symlinkCode, `${label} must not be a symlink: ${filePath}`);
  }
  if (!initial.isFile()) {
    throw artifactError(invalidCode, `${label} must be a regular file: ${filePath}`);
  }
  let fd;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    fd = io.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = io.fstatSync(fd);
    if (!sameStat(initial, opened)) {
      throw artifactError(changedCode, `${label} changed before it was opened: ${filePath}`);
    }
    const bytes = io.readFileSync(fd);
    const after = io.fstatSync(fd);
    if (!sameStat(opened, after)) {
      throw artifactError(changedCode, `${label} changed while it was read: ${filePath}`);
    }
    const final = io.lstatSync(filePath);
    if (final.isSymbolicLink() || !sameStat(after, final)) {
      throw artifactError(changedCode, `${label} identity changed after it was read: ${filePath}`);
    }
    return { bytes, sha256: sha256Digest(bytes), stat: after };
  } catch (error) {
    if (error && error.code === 'ELOOP') {
      throw artifactError(symlinkCode, `${label} must not be a symlink: ${filePath}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch {}
    }
  }
}

function pathExists(candidate, io = fs) {
  try {
    io.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertContainedPath(root, candidate, {
  io = fs,
  code = 'artifact_path_escape',
  finalMayBeMissing = true,
  finalMustBeFile = false,
} = {}) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  if (!isPathInside(base, target)) {
    throw artifactError(code, `artifact path escapes its root: ${candidate}`);
  }
  let rootPhysical;
  try { rootPhysical = io.realpathSync(base); }
  catch { throw artifactError(code, `artifact root is unreadable: ${base}`); }
  if (rootPhysical !== base) {
    throw artifactError(code, `artifact root must be a physical path: ${base}`);
  }
  const relative = path.relative(base, target);
  let current = base;
  const components = relative ? relative.split(path.sep) : [];
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let stat;
    try { stat = io.lstatSync(current); }
    catch (error) {
      if (error && error.code === 'ENOENT') {
        if (!finalMayBeMissing && index === components.length - 1) {
          throw artifactError(code, `artifact path is missing: ${current}`);
        }
        break;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw artifactError(code, `artifact path contains a symlink: ${current}`);
    }
    const resolved = io.realpathSync(current);
    if (!isPathInside(rootPhysical, resolved)) {
      throw artifactError(code, `artifact path resolves outside its root: ${current}`);
    }
    if (index < components.length - 1 && !stat.isDirectory()) {
      throw artifactError(code, `artifact parent is not a directory: ${current}`);
    }
    if (index === components.length - 1 && finalMustBeFile && !stat.isFile()) {
      throw artifactError(code, `artifact target is not a regular file: ${current}`);
    }
  }
  return target;
}

function ensureDirectoryTree(root, candidate, { io = fs } = {}) {
  const base = path.resolve(root);
  const target = assertContainedPath(base, candidate, { io });
  const relative = path.relative(base, target);
  let current = base;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { io.mkdirSync(current, { mode: 0o700 }); }
    catch (error) {
      if (!(error && error.code === 'EEXIST')) throw error;
    }
    const stat = io.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || io.realpathSync(current) !== current) {
      throw artifactError('artifact_path_escape', `artifact directory is not private: ${current}`);
    }
  }
  return target;
}

function parseJsonRecord(filePath, kind, label, options = {}) {
  if (!pathExists(filePath, options.io || fs)) return null;
  const read = stableReadRegular(filePath, {
    ...options,
    missingCode: 'artifact_publication_ambiguous',
    symlinkCode: 'artifact_publication_ambiguous',
    invalidCode: 'artifact_publication_ambiguous',
    changedCode: 'artifact_publication_ambiguous',
    label,
  });
  let value;
  try { value = JSON.parse(read.bytes.toString('utf8')); }
  catch {
    throw artifactError('artifact_publication_ambiguous', `${label} is not valid JSON`);
  }
  return validateRecord(value, kind, label);
}

function publicationPaths(stateRoot, publicationId) {
  const root = path.join(stateRoot, '.artifact-publications');
  return {
    root,
    locks: path.join(root, '.locks'),
    preparation: path.join(root, `${publicationId}.prepare.json`),
    marker: path.join(root, `${publicationId}.commit.json`),
    lock: path.join(root, '.locks', `${publicationId}.lock`),
  };
}

function targetFromRelative(stateRoot, relativePath, io = fs) {
  if (typeof relativePath !== 'string' || relativePath.length === 0
      || path.isAbsolute(relativePath)) {
    throw artifactError('artifact_publication_ambiguous', 'publication target path is invalid');
  }
  const target = path.resolve(stateRoot, relativePath);
  return assertContainedPath(stateRoot, target, { io });
}

function expectedEnvelopeKind(kind) {
  return {
    receipt: 'evolve-receipt',
    insights: 'evolve-insights',
    compaction: 'compaction-state',
    handoff: 'handoff',
    feedback: 'evolve-insights',
  }[kind];
}

function canonicalTargets({ stateRoot, sessionRoot, sessionId, kind, publicationId }) {
  if (kind === 'receipt') {
    return [
      path.join(sessionRoot, 'evolve-receipt.json'),
      path.join(sessionRoot, 'artifacts', 'evolve-receipt', `${publicationId}.json`),
    ];
  }
  if (kind === 'insights') {
    return [
      path.join(sessionRoot, 'evolve-insights.json'),
      path.join(sessionRoot, 'artifacts', 'evolve-insights', `${publicationId}.json`),
    ];
  }
  if (kind === 'compaction') {
    return [path.join(stateRoot, 'compaction-states', `${publicationId}-${sessionId}.json`)];
  }
  if (kind === 'handoff') {
    return [path.join(stateRoot, 'handoffs', `${publicationId}-${sessionId}.json`)];
  }
  if (kind === 'feedback') {
    return [path.join(stateRoot, 'feedback-exports', `${publicationId}-${sessionId}.json`)];
  }
  return [];
}

function validatePreparation(record, {
  stateRoot,
  sessionRoot,
  sessionId,
  kind,
  publicationId,
  requestDigest,
  io = fs,
}) {
  if (record.publication_id !== publicationId) {
    throw artifactError('artifact_publication_ambiguous', 'preparation publication identity changed');
  }
  if (record.request_digest !== requestDigest) {
    throw artifactError('publication_id_conflict',
      'publication_id is already bound to a different canonical request');
  }
  if (record.builder_version !== BUILDER_VERSION
      || record.artifact_kind !== kind
      || record.session_id !== sessionId
      || typeof record.generated_at !== 'string'
      || typeof record.artifact_bytes_base64 !== 'string'
      || !DIGEST_RE.test(record.artifact_sha256)
      || !PUBLICATION_ID_RE.test(record.run_id)) {
    throw artifactError('artifact_publication_ambiguous', 'preparation fields are invalid');
  }
  const bytes = Buffer.from(record.artifact_bytes_base64, 'base64');
  if (bytes.toString('base64') !== record.artifact_bytes_base64
      || sha256Digest(bytes) !== record.artifact_sha256) {
    throw artifactError('artifact_publication_ambiguous', 'preparation artifact bytes are inconsistent');
  }
  const target = targetFromRelative(stateRoot, record.target_relative_path, io);
  const expectedTargets = canonicalTargets({
    stateRoot, sessionRoot, sessionId, kind, publicationId,
  }).map((candidate) => path.resolve(candidate));
  if (!expectedTargets.includes(target)) {
    throw artifactError('artifact_publication_ambiguous',
      'preparation target is not canonical for its artifact kind');
  }
  let artifact;
  try { artifact = JSON.parse(bytes.toString('utf8')); }
  catch {
    throw artifactError('artifact_publication_ambiguous',
      'preparation artifact bytes are not valid JSON');
  }
  const envelopeKind = expectedEnvelopeKind(kind);
  const envelope = artifact && artifact.envelope;
  if (!envelopeKind || !envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || envelope.producer !== 'deep-evolve'
      || envelope.run_id !== publicationId
      || envelope.generated_at !== record.generated_at
      || envelope.session_id !== sessionId
      || envelope.artifact_kind !== envelopeKind
      || !envelope.schema || envelope.schema.name !== envelopeKind) {
    throw artifactError('artifact_publication_ambiguous',
      'preparation artifact identity disagrees with publication evidence');
  }
  return { record, bytes, target };
}

function validateMarker(record, preparation, { stateRoot, publicationId, requestDigest, io = fs }) {
  if (record.publication_id !== publicationId) {
    throw artifactError('artifact_publication_ambiguous', 'publication marker identity changed');
  }
  if (record.request_digest !== requestDigest) {
    throw artifactError('publication_id_conflict',
      'publication_id is already bound to a different canonical request');
  }
  if (!preparation
      || record.preparation_checksum !== preparation.record.record_checksum
      || record.target_relative_path !== preparation.record.target_relative_path
      || record.artifact_sha256 !== preparation.record.artifact_sha256
      || record.run_id !== preparation.record.run_id) {
    throw artifactError('artifact_publication_ambiguous',
      'publication marker and preparation evidence disagree');
  }
  const target = targetFromRelative(stateRoot, record.target_relative_path, io);
  const artifact = stableReadRegular(target, {
    io,
    missingCode: 'artifact_publication_ambiguous',
    symlinkCode: 'artifact_publication_ambiguous',
    invalidCode: 'artifact_publication_ambiguous',
    changedCode: 'artifact_publication_ambiguous',
    label: 'published artifact',
  });
  if (artifact.sha256 !== record.artifact_sha256
      || !artifact.bytes.equals(preparation.bytes)) {
    throw artifactError('artifact_publication_ambiguous',
      'published artifact does not match committed evidence');
  }
  let envelope;
  try { envelope = JSON.parse(artifact.bytes.toString('utf8')); }
  catch {
    throw artifactError('artifact_publication_ambiguous', 'published artifact is not valid JSON');
  }
  return {
    envelope,
    artifact_path: target,
    artifact_sha256: record.artifact_sha256,
    publication_id: publicationId,
    replayed: true,
  };
}

function readPublication({
  stateRoot,
  sessionRoot,
  sessionId,
  kind,
  publicationId,
  requestDigest,
  options = {},
}) {
  const io = options.io || fs;
  const paths = publicationPaths(stateRoot, publicationId);
  const marker = parseJsonRecord(paths.marker, 'deep-evolve-artifact-publication',
    'publication marker', { io });
  if (!marker) return null;
  const rawPreparation = parseJsonRecord(paths.preparation, 'deep-evolve-artifact-preparation',
    'publication preparation', { io });
  const preparation = rawPreparation
    ? validatePreparation(rawPreparation, {
      stateRoot, sessionRoot, sessionId, kind, publicationId, requestDigest, io,
    })
    : null;
  return validateMarker(marker, preparation, {
    stateRoot, publicationId, requestDigest, io,
  });
}

function inspectOptionalRegular(filePath, options = {}) {
  if (!pathExists(filePath, options.io || fs)) return null;
  return stableReadRegular(filePath, options);
}

function fixedTargetFor(kind, sessionRoot) {
  if (kind === 'receipt') return path.join(sessionRoot, 'evolve-receipt.json');
  if (kind === 'insights') return path.join(sessionRoot, 'evolve-insights.json');
  return null;
}

function versionedTargetFor(kind, sessionRoot, publicationId) {
  const directory = kind === 'receipt' ? 'evolve-receipt' : 'evolve-insights';
  return path.join(sessionRoot, 'artifacts', directory, `${publicationId}.json`);
}

function routeTarget({ stateRoot, sessionRoot, sessionId, kind, publicationId,
  legacyArtifactSha256, io = fs }) {
  const fixed = fixedTargetFor(kind, sessionRoot);
  if (fixed) {
    assertContainedPath(sessionRoot, fixed, { io });
    const existing = inspectOptionalRegular(fixed, {
      io,
      missingCode: 'legacy_artifact_requires_migration',
      symlinkCode: 'artifact_path_escape',
      invalidCode: 'artifact_path_escape',
      changedCode: 'artifact_publication_ambiguous',
      label: `legacy ${kind}`,
    });
    if (!existing) return fixed;
    if (!DIGEST_RE.test(legacyArtifactSha256 || '')
        || existing.sha256 !== legacyArtifactSha256) {
      throw artifactError('legacy_artifact_requires_migration',
        `existing fixed ${kind} requires its exact stable digest before versioned publication`);
    }
    const versioned = versionedTargetFor(kind, sessionRoot, publicationId);
    assertContainedPath(sessionRoot, versioned, { io });
    return versioned;
  }
  let target;
  if (kind === 'compaction') {
    target = path.join(stateRoot, 'compaction-states', `${publicationId}-${sessionId}.json`);
  } else if (kind === 'handoff') {
    target = path.join(stateRoot, 'handoffs', `${publicationId}-${sessionId}.json`);
  } else if (kind === 'feedback') {
    target = path.join(stateRoot, 'feedback-exports', `${publicationId}-${sessionId}.json`);
  } else {
    throw artifactError('invalid_artifact_kind', `unknown publication kind: ${kind}`);
  }
  return assertContainedPath(stateRoot, target, { io });
}

function invokePhase(options, phase, context = {}) {
  if (typeof options.onPhase === 'function') options.onPhase(phase, context);
}

function installEvidence(pathname, record, options, phasePrefix) {
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  installFileExclusive(pathname, bytes, {
    ...options,
    phasePrefix,
    beforeInstall: () => assertContainedPath(options.stateRoot, pathname, { io: options.io }),
  });
}

function installArtifact(target, bytes, expectedDigest, options) {
  const current = inspectOptionalRegular(target, {
    io: options.io,
    missingCode: 'artifact_publication_ambiguous',
    symlinkCode: 'artifact_path_escape',
    invalidCode: 'artifact_publication_ambiguous',
    changedCode: 'artifact_publication_ambiguous',
    label: 'artifact target',
  });
  if (current) {
    if (current.sha256 !== expectedDigest || !current.bytes.equals(bytes)) {
      throw artifactError('artifact_publication_ambiguous',
        'artifact target contains contradictory immutable evidence');
    }
    return false;
  }
  invokePhase(options, 'before-artifact-install', { target });
  assertContainedPath(options.stateRoot, target, { io: options.io });
  const raced = inspectOptionalRegular(target, {
    io: options.io,
    missingCode: 'artifact_publication_ambiguous',
    symlinkCode: 'artifact_path_escape',
    invalidCode: 'artifact_publication_ambiguous',
    changedCode: 'artifact_publication_ambiguous',
    label: 'artifact target',
  });
  if (raced) {
    if (raced.sha256 !== expectedDigest || !raced.bytes.equals(bytes)) {
      throw artifactError('artifact_publication_ambiguous',
        'artifact target won the install race with different bytes');
    }
    return false;
  }
  try {
    installFileExclusive(target, bytes, {
      ...options,
      phasePrefix: 'artifact',
      beforeInstall: () => assertContainedPath(options.stateRoot, target, { io: options.io }),
    });
  } catch (error) {
    if (!TRANSIENT_CONFLICT_CODES.has(error && error.code)) throw error;
    const winner = stableReadRegular(target, {
      io: options.io,
      missingCode: 'artifact_publication_ambiguous',
      symlinkCode: 'artifact_path_escape',
      invalidCode: 'artifact_publication_ambiguous',
      changedCode: 'artifact_publication_ambiguous',
      label: 'artifact install winner',
    });
    if (winner.sha256 !== expectedDigest || !winner.bytes.equals(bytes)) {
      throw artifactError('artifact_publication_ambiguous',
        'artifact target won the install race with different bytes');
    }
    return false;
  }
  return true;
}

function publishArtifact({
  stateRoot,
  sessionRoot,
  sessionId,
  kind,
  publicationId,
  requestDigest,
  bytes,
  legacyArtifactSha256,
  sourceEvidence = [],
  options = {},
}) {
  if (!PUBLICATION_ID_RE.test(publicationId || '')) {
    throw artifactError('invalid_publication_id', 'publication_id must be a valid ULID');
  }
  if (!DIGEST_RE.test(requestDigest || '')) {
    throw artifactError('invalid_request_digest', 'publication request digest is invalid');
  }
  const io = options.io || fs;
  const normalized = {
    ...options,
    io,
    platform: options.platform || process.platform,
    stateRoot,
  };
  const committed = readPublication({ stateRoot, sessionRoot, sessionId, kind,
    publicationId, requestDigest,
    options: normalized });
  if (committed) return committed;

  const paths = publicationPaths(stateRoot, publicationId);
  const preexistingPreparation = parseJsonRecord(paths.preparation,
    'deep-evolve-artifact-preparation', 'publication preparation', { io });
  let freshTarget = null;
  if (!preexistingPreparation) {
    freshTarget = routeTarget({ stateRoot, sessionRoot, sessionId, kind, publicationId,
      legacyArtifactSha256, io });
    const parentRoot = isPathInside(sessionRoot, freshTarget) ? sessionRoot : stateRoot;
    assertContainedPath(parentRoot, freshTarget, { io });
  }

  ensureDirectoryTree(stateRoot, paths.root, { io });
  ensureDirectoryTree(stateRoot, paths.locks, { io });
  const locked = withDirectoryLock(paths.lock, () => {
    const racedCommit = readPublication({ stateRoot, sessionRoot, sessionId, kind,
      publicationId, requestDigest,
      options: normalized });
    if (racedCommit) return racedCommit;

    let preparationRecord = parseJsonRecord(paths.preparation,
      'deep-evolve-artifact-preparation', 'publication preparation', { io });
    const recovering = Boolean(preparationRecord);
    let preparation;
    if (preparationRecord) {
      preparation = validatePreparation(preparationRecord, {
        stateRoot, sessionRoot, sessionId, kind, publicationId, requestDigest, io,
      });
    } else {
      const artifactBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      let envelope;
      try { envelope = JSON.parse(artifactBytes.toString('utf8')); }
      catch { throw artifactError('invalid_artifact_bytes', 'artifact bytes must be valid JSON'); }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
          || !envelope.envelope || envelope.envelope.run_id !== publicationId) {
        throw artifactError('invalid_artifact_bytes',
          'artifact bytes must contain the publication run identity');
      }
      for (const evidence of sourceEvidence) {
        const reread = stableReadRegular(evidence.absolute_path, {
          io,
          missingCode: 'source_artifact_missing',
          symlinkCode: 'source_artifact_symlink',
          invalidCode: 'source_artifact_invalid',
          changedCode: 'source_artifact_changed',
          label: 'source artifact',
        });
        if (reread.sha256 !== evidence.sha256) {
          throw artifactError('source_artifact_changed',
            `source artifact changed before publication: ${evidence.absolute_path}`);
        }
      }
      const target = freshTarget || routeTarget({ stateRoot, sessionRoot, sessionId, kind,
        publicationId, legacyArtifactSha256, io });
      ensureDirectoryTree(stateRoot, path.dirname(target), { io });
      const targetRelative = path.relative(stateRoot, target).split(path.sep).join('/');
      preparationRecord = checksummedRecord('deep-evolve-artifact-preparation', {
        publication_id: publicationId,
        request_digest: requestDigest,
        artifact_kind: kind,
        session_id: sessionId,
        target_relative_path: targetRelative,
        artifact_sha256: sha256Digest(artifactBytes),
        artifact_bytes_base64: artifactBytes.toString('base64'),
        run_id: publicationId,
        generated_at: envelope.envelope.generated_at,
        builder_version: BUILDER_VERSION,
      });
      installEvidence(paths.preparation, preparationRecord, normalized, 'preparation');
      preparation = { record: preparationRecord, bytes: artifactBytes, target };
    }

    const parentRoot = isPathInside(sessionRoot, preparation.target) ? sessionRoot : stateRoot;
    assertContainedPath(parentRoot, preparation.target, { io });
    ensureDirectoryTree(stateRoot, path.dirname(preparation.target), { io });
    installArtifact(preparation.target, preparation.bytes,
      preparation.record.artifact_sha256, normalized);

    const marker = checksummedRecord('deep-evolve-artifact-publication', {
      publication_id: publicationId,
      request_digest: requestDigest,
      preparation_checksum: preparation.record.record_checksum,
      target_relative_path: preparation.record.target_relative_path,
      artifact_sha256: preparation.record.artifact_sha256,
      run_id: preparation.record.run_id,
      committed_at: preparation.record.generated_at,
    });
    try { installEvidence(paths.marker, marker, normalized, 'marker'); }
    catch (error) {
      if (!TRANSIENT_CONFLICT_CODES.has(error && error.code)) throw error;
      const raced = readPublication({ stateRoot, sessionRoot, sessionId, kind,
        publicationId, requestDigest,
        options: normalized });
      if (!raced) throw artifactError('artifact_publication_ambiguous',
        'publication marker install raced with contradictory evidence');
      return raced;
    }
    const result = validateMarker(marker, preparation, {
      stateRoot, publicationId, requestDigest, io,
    });
    result.replayed = recovering;
    invokePhase(normalized, 'before-success-response', { result });
    return result;
  }, normalized);
  if (locked && locked.ok === false) {
    throw artifactError(locked.code || 'artifact_lock_held',
      'artifact publication lock is held', locked.rc || 2);
  }
  return locked;
}

function envelopeRunId(bytes, expectedIdentity = null) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { return null; }
  const envelope = value && value.envelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || !PUBLICATION_ID_RE.test(envelope.run_id || '')
      || !envelope.schema || typeof envelope.schema !== 'object') return null;
  if (expectedIdentity) {
    if (envelope.producer !== expectedIdentity.producer
        || envelope.artifact_kind !== expectedIdentity.artifact_kind
        || envelope.schema.name !== expectedIdentity.artifact_kind) return null;
  } else if (typeof envelope.producer !== 'string'
      || envelope.artifact_kind !== envelope.schema.name) return null;
  return envelope.run_id;
}

function authenticateSourceArtifacts(sourceArtifacts, {
  cwd,
  io = fs,
  expectedIdentity = null,
} = {}) {
  if (!Array.isArray(sourceArtifacts)) {
    throw artifactError('invalid_source_artifacts', 'source_artifacts must be an array');
  }
  const records = [];
  const evidence = [];
  for (let index = 0; index < sourceArtifacts.length; index += 1) {
    const source = sourceArtifacts[index];
    if (!source || typeof source !== 'object' || Array.isArray(source)
        || Object.getPrototypeOf(source) !== Object.prototype) {
      throw artifactError('invalid_source_artifact',
        `source_artifacts[${index}] must be a plain object`);
    }
    const keys = Object.keys(source);
    if (!keys.includes('path') || keys.some((key) => !['path', 'run_id'].includes(key))
        || typeof source.path !== 'string' || source.path.length === 0
        || (source.run_id !== undefined && !PUBLICATION_ID_RE.test(source.run_id))) {
      throw artifactError('invalid_source_artifact',
        `source_artifacts[${index}] must contain only path and optional valid run_id`);
    }
    const absolute = path.isAbsolute(source.path) ? path.resolve(source.path)
      : path.resolve(cwd, source.path);
    const read = stableReadRegular(absolute, {
      io,
      missingCode: 'source_artifact_missing',
      symlinkCode: 'source_artifact_symlink',
      invalidCode: 'source_artifact_invalid',
      changedCode: 'source_artifact_changed',
      label: `source_artifacts[${index}]`,
    });
    const harvested = source.run_id || envelopeRunId(read.bytes, expectedIdentity);
    records.push({ path: source.path, ...(harvested ? { run_id: harvested } : {}) });
    evidence.push({ absolute_path: absolute, sha256: read.sha256 });
  }
  return { records, evidence };
}

module.exports = {
  PUBLICATION_ID_RE,
  DIGEST_RE,
  BUILDER_VERSION,
  artifactError,
  authenticateSourceArtifacts,
  envelopeRunId,
  publishArtifact,
  readPublication,
  sha256Digest,
  stableReadRegular,
};
