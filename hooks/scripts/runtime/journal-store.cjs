'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  atomicWriteFile,
  mutateCoordinationFiles,
  persistCommitMarker,
  renameWithRetry,
  syncRenamedDirectoryBestEffort,
  validateCommitMarker,
  withDirectoryLock,
} = require('./session-store.cjs');
const { isPathInside } = require('./runtime-paths.cjs');

const JSONL_FILES = new Set(['journal.jsonl', 'forum.jsonl', 'kill_queue.jsonl', 'kill_requests.jsonl']);
const REPAIR_FILES = new Set(['journal.jsonl', 'forum.jsonl', 'kill_queue.jsonl', 'kill_requests.jsonl']);
const KILL_CONDITIONS = new Set([
  'crash_give_up',
  'sustained_regression',
  'shortcut_quarantine',
  'budget_exhausted_underperform',
  'user_requested',
]);

function runtimeError(code, message, rc = 2, details) {
  const error = Object.assign(new Error(message), { code, rc });
  if (details !== undefined) error.details = details;
  return error;
}

function fail(code, message, details) {
  throw runtimeError(code, message, 2, details);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requirePlainObject(value, label) {
  if (!plainObject(value)) fail('invalid_object', `${label} must be a plain object`);
  return value;
}

function requireInteger(value, label, { min } = {}) {
  if (!Number.isInteger(value) || typeof value === 'boolean' || (min !== undefined && value < min)) {
    fail('invalid_field_type', `${label} must be ${min === 1 ? 'a positive ' : ''}integer (not bool)`);
  }
  return value;
}

function requireNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('invalid_field_type', `${label} must be a finite number (not bool)`);
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
    return output;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function isoNow(now = Date.now) {
  const value = typeof now === 'function' ? now() : now;
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function resolveRelativeJsonl(stateRoot, relativePath, allowed = JSONL_FILES) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    fail('invalid_coordination_path', 'coordination file path must be a non-empty relative path');
  }
  const normalized = path.normalize(relativePath);
  const segments = normalized.split(path.sep);
  if (segments.includes('..') || segments.length !== 2 || !allowed.has(path.basename(normalized))) {
    fail('invalid_coordination_path', `coordination file is not allowlisted: ${relativePath}`);
  }
  const root = path.resolve(stateRoot);
  const target = path.resolve(root, normalized);
  if (!isPathInside(root, target, process.platform)) fail('invalid_coordination_path', `coordination file escapes state root: ${relativePath}`);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fail('invalid_coordination_path', `coordination file cannot be a symlink: ${relativePath}`);
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) throw error;
  }
  return { target, relativePath: normalized.split(path.sep).join('/') };
}

function splitJsonl(buffer) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const lines = [];
  let start = 0;
  let position = 1;
  for (let index = 0; index <= input.length; index += 1) {
    if (index !== input.length && input[index] !== 0x0a) continue;
    if (index === input.length && start === input.length) break;
    const hasLf = index < input.length;
    const body = input.subarray(start, index);
    const full = input.subarray(start, hasLf ? index + 1 : index);
    const blank = body.toString('utf8').trim() === '';
    let value = null;
    let malformed = false;
    if (!blank) {
      try {
        value = JSON.parse(body.toString('utf8'));
        if (!plainObject(value)) malformed = true;
      } catch {
        malformed = true;
      }
    }
    lines.push({ position, body: Buffer.from(body), full: Buffer.from(full), blank, value, malformed });
    position += 1;
    start = index + 1;
  }
  return lines;
}

function warningsFor(lines, relativePath) {
  return lines.filter((line) => line.malformed).map((line) => ({
    code: 'malformed_jsonl_skipped',
    file: relativePath,
    line: line.position,
    sha256: sha256(line.body),
  }));
}

function assertValidJsonl(lines, relativePath) {
  const malformed = lines.find((line) => line.malformed);
  if (malformed) fail('invalid_jsonl', `${relativePath} line ${malformed.position} is malformed`, {
    line: malformed.position,
    sha256: sha256(malformed.body),
  });
}

function readFileBuffer(filePath, io = fs) {
  try { return io.readFileSync(filePath); }
  catch (error) {
    if (error && error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}

function readJsonl({ stateRoot, relativePath, skipMalformed = false, io = fs }) {
  const resolved = resolveRelativeJsonl(stateRoot, relativePath);
  const lines = splitJsonl(readFileBuffer(resolved.target, io));
  if (!skipMalformed) assertValidJsonl(lines, resolved.relativePath);
  return {
    records: lines.filter((line) => !line.blank && !line.malformed).map((line) => line.value),
    warnings: skipMalformed ? warningsFor(lines, resolved.relativePath) : [],
  };
}

function tailJsonl({ stateRoot, relativePath, limit = 20, io = fs }) {
  requireInteger(limit, 'limit', { min: 0 });
  const resolved = resolveRelativeJsonl(stateRoot, relativePath);
  const lines = splitJsonl(readFileBuffer(resolved.target, io));
  const tail = lines.filter((line) => !line.blank).slice(-limit);
  return {
    records: tail.filter((line) => !line.malformed).map((line) => line.value),
    warnings: warningsFor(tail, resolved.relativePath),
  };
}

function appendText(text, record) {
  const prefix = text && !text.endsWith('\n') ? `${text}\n` : text;
  return `${prefix || ''}${JSON.stringify(record)}\n`;
}

function appendJsonl({
  stateRoot,
  relativePath,
  event,
  sessionId,
  seedId,
  now = Date.now,
  options = {},
}) {
  requirePlainObject(event, 'event');
  const resolved = resolveRelativeJsonl(stateRoot, relativePath);
  const record = { ...event };
  if (!Object.hasOwn(record, 'ts')) record.ts = isoNow(now);
  if (sessionId !== undefined && !Object.hasOwn(record, 'session_id')) record.session_id = sessionId;
  if (seedId !== undefined) record.seed_id = requireInteger(seedId, 'seed_id', { min: 1 });
  // Fail malformed ordinary mutations before Task 1 transaction recovery can
  // clean or roll forward any unrelated transaction artifacts. The locked
  // callback validates the same source again before committing.
  readJsonl({ stateRoot, relativePath: resolved.relativePath });
  mutateCoordinationFiles(stateRoot, [resolved.relativePath], (files) => {
    assertValidJsonl(splitJsonl(Buffer.from(files[resolved.relativePath])), resolved.relativePath);
    return { [resolved.relativePath]: appendText(files[resolved.relativePath], record) };
  }, options);
  return { record };
}

function invokePhase(options, phase, context = {}) {
  if (typeof options.onPhase === 'function') options.onPhase(phase, context);
}

function ioExists(io, target) {
  try { return io.existsSync(target); }
  catch { return false; }
}

function readJsonFile(io, target) {
  return JSON.parse(io.readFileSync(target, 'utf8'));
}

function quarantinePaths(stateRoot) {
  const root = path.join(stateRoot, 'quarantine');
  const transactions = path.join(root, 'transactions');
  return { root, transactions, staged: path.join(transactions, 'staged') };
}

function normalizeMalformed(value) {
  if (!Array.isArray(value) || value.length === 0) fail('invalid_malformed_selection', 'malformed must be a non-empty array');
  const seen = new Set();
  return value.map((entry, index) => {
    requirePlainObject(entry, `malformed[${index}]`);
    const line = requireInteger(entry.line, `malformed[${index}].line`, { min: 1 });
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      fail('invalid_malformed_digest', `malformed[${index}].sha256 must be a lowercase SHA-256 digest`);
    }
    if (seen.has(line)) fail('invalid_malformed_selection', `duplicate malformed line position: ${line}`);
    seen.add(line);
    return { line, sha256: entry.sha256 };
  }).sort((left, right) => left.line - right.line);
}

function auditBody(marker) {
  return {
    source_relative_path: marker.source_relative_path,
    source_preimage_sha256: marker.source_preimage_sha256,
    malformed_lines: marker.malformed_lines,
    staged_artifact_identity: marker.staged_artifact_identity,
    staged_artifact_path: marker.staged_artifact_path,
    staged_artifact_sha256: marker.staged_artifact_sha256,
  };
}

function validQuarantineMarker(marker, expectedName) {
  if (!validateCommitMarker(marker).valid || marker.kind !== 'deep-evolve-quarantine') return false;
  const identity = sha256(Buffer.from(canonicalJson(auditBody(marker))));
  return marker.audit_identity === identity && expectedName === `${identity}.commit.json`;
}

function markerMatchesRequest(marker, relativePath, malformed) {
  return marker.source_relative_path === relativePath
    && canonicalJson(marker.malformed_lines) === canonicalJson(malformed);
}

function markerResult(marker, extra = {}) {
  return {
    ok: true,
    rc: 0,
    audit_identity: marker.audit_identity,
    source_relative_path: marker.source_relative_path,
    source_preimage_sha256: marker.source_preimage_sha256,
    staged_artifact_path: marker.staged_artifact_path,
    staged_artifact_sha256: marker.staged_artifact_sha256,
    staged_artifact_identity: marker.staged_artifact_identity,
    malformed_lines: marker.malformed_lines,
    ...extra,
  };
}

function verifyEvidence(marker, paths, io) {
  for (const malformed of marker.malformed_lines) {
    const evidence = path.join(paths.root, `${malformed.sha256}.jsonl`);
    const bytes = readFileBuffer(evidence, io);
    if (!ioExists(io, evidence) || sha256(bytes) !== malformed.sha256) {
      fail('quarantine_evidence_ambiguous', `quarantine evidence checksum mismatch for line ${malformed.line}`);
    }
  }
}

function recoverMarker(stateRoot, marker, markerName, options, projectHandle) {
  const io = options.io || fs;
  const platform = options.platform || process.platform;
  const paths = quarantinePaths(stateRoot);
  if (!validQuarantineMarker(marker, markerName)) fail('quarantine_marker_invalid', `invalid canonical quarantine marker: ${markerName}`);
  verifyEvidence(marker, paths, io);
  const source = resolveRelativeJsonl(stateRoot, marker.source_relative_path, REPAIR_FILES).target;
  const stage = path.resolve(paths.transactions, marker.staged_artifact_path);
  if (!isPathInside(paths.transactions, stage, platform)) fail('quarantine_stage_escape', 'staged artifact escaped transaction recovery root');
  const expectedStagedIdentity = sha256(Buffer.from(canonicalJson({
    path: marker.staged_artifact_path,
    sha256: marker.staged_artifact_sha256,
  })));
  if (marker.staged_artifact_identity !== expectedStagedIdentity) fail('quarantine_stage_identity_invalid', 'staged artifact identity mismatch');
  let current = readFileBuffer(source, io);
  const currentHash = sha256(current);
  if (currentHash === marker.staged_artifact_sha256) {
    invokePhase(options, 'cleanup', { auditIdentity: marker.audit_identity, marker });
    return markerResult(marker, { recovered: 1, installed: true });
  }
  if (currentHash !== marker.source_preimage_sha256) {
    fail('quarantine_source_changed', 'source preimage changed after quarantine commit marker');
  }
  const staged = readFileBuffer(stage, io);
  if (!ioExists(io, stage) || sha256(staged) !== marker.staged_artifact_sha256) {
    fail('quarantine_stage_ambiguous', 'staged artifact is missing or has the wrong checksum');
  }
  invokePhase(options, 'before-install', { auditIdentity: marker.audit_identity, marker });
  if (typeof options.beforeInstall === 'function') options.beforeInstall({ source, marker, stage });
  projectHandle.assertOwned();
  current = readFileBuffer(source, io);
  if (sha256(current) !== marker.source_preimage_sha256) {
    fail('quarantine_source_changed', 'source changed immediately before quarantine install CAS');
  }
  renameWithRetry(stage, source, {
    io,
    platform,
    sleep: options.sleep,
  });
  syncRenamedDirectoryBestEffort(path.dirname(source), platform, {
    io,
    onDiagnostic: options.onDiagnostic,
  });
  invokePhase(options, 'after-install', { auditIdentity: marker.audit_identity, marker });
  if (sha256(readFileBuffer(source, io)) !== marker.staged_artifact_sha256) {
    fail('quarantine_install_ambiguous', 'installed source checksum mismatch');
  }
  invokePhase(options, 'cleanup', { auditIdentity: marker.audit_identity, marker });
  return markerResult(marker, { recovered: 1, installed: true });
}

function lockOptions(options) {
  return {
    io: options.io || fs,
    platform: options.platform || process.platform,
    sleep: options.sleep,
    now: options.now,
    randomNonce: options.randomNonce,
    onDiagnostic: options.onDiagnostic,
    timeoutMs: options.timeoutMs,
    retryDelayMs: options.retryDelayMs,
  };
}

function listCanonicalMarkers(paths, io) {
  let names;
  try { names = io.readdirSync(paths.transactions); }
  catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => /^[0-9a-f]{64}\.commit\.json$/.test(name)).sort();
}

function findMatchingMarker(stateRoot, relativePath, malformed, options, projectHandle) {
  const io = options.io || fs;
  const paths = quarantinePaths(stateRoot);
  for (const name of listCanonicalMarkers(paths, io)) {
    let marker;
    try { marker = readJsonFile(io, path.join(paths.transactions, name)); }
    catch { continue; }
    if (!validQuarantineMarker(marker, name) || !markerMatchesRequest(marker, relativePath, malformed)) continue;
    return recoverMarker(stateRoot, marker, name, options, projectHandle);
  }
  return null;
}

function quarantineMalformed({
  stateRoot,
  relativePath,
  malformed: malformedInput,
  ...rawOptions
}) {
  const resolved = resolveRelativeJsonl(stateRoot, relativePath, REPAIR_FILES);
  const malformed = normalizeMalformed(malformedInput);
  const options = { ...rawOptions };
  const io = options.io || fs;
  const platform = options.platform || process.platform;
  const paths = quarantinePaths(stateRoot);
  io.mkdirSync(paths.transactions, { recursive: true });
  const result = withDirectoryLock(path.join(stateRoot, '.coordination-lock'), (projectHandle) => {
    const prior = findMatchingMarker(stateRoot, resolved.relativePath, malformed, options, projectHandle);
    if (prior) return prior;
    const source = readFileBuffer(resolved.target, io);
    const lines = splitJsonl(source);
    const actualMalformed = lines.filter((line) => line.malformed);
    const actual = actualMalformed.map((line) => ({ line: line.position, sha256: sha256(line.body) }));
    if (canonicalJson(actual) !== canonicalJson(malformed)) {
      fail('quarantine_digest_stale', 'requested malformed line positions/digests do not match the source preimage');
    }
    const atomicOptions = {
      io,
      platform,
      sleep: options.sleep,
      onDiagnostic: options.onDiagnostic,
    };
    for (const line of actualMalformed) {
      const digest = sha256(line.body);
      const evidence = path.join(paths.root, `${digest}.jsonl`);
      if (ioExists(io, evidence)) {
        if (sha256(readFileBuffer(evidence, io)) !== digest) {
          fail('quarantine_evidence_ambiguous', `existing evidence checksum mismatch: ${digest}`);
        }
      } else {
        atomicWriteFile(evidence, line.body, atomicOptions);
      }
      invokePhase(options, 'after-evidence', { digest, line: line.position });
    }
    const replacement = Buffer.concat(lines.filter((line) => !line.malformed).map((line) => line.full));
    const sourcePreimage = sha256(source);
    const stagedHash = sha256(replacement);
    const stagedRelative = `staged/${sourcePreimage}.${stagedHash}.replacement`;
    const stagedPath = path.join(paths.transactions, ...stagedRelative.split('/'));
    if (ioExists(io, stagedPath)) {
      if (sha256(readFileBuffer(stagedPath, io)) !== stagedHash) fail('quarantine_stage_ambiguous', 'existing staged artifact checksum mismatch');
    } else {
      atomicWriteFile(stagedPath, replacement, atomicOptions);
    }
    const stagedIdentity = sha256(Buffer.from(canonicalJson({ path: stagedRelative, sha256: stagedHash })));
    const body = {
      source_relative_path: resolved.relativePath,
      source_preimage_sha256: sourcePreimage,
      malformed_lines: malformed,
      staged_artifact_identity: stagedIdentity,
      staged_artifact_path: stagedRelative,
      staged_artifact_sha256: stagedHash,
    };
    const auditIdentity = sha256(Buffer.from(canonicalJson(body)));
    invokePhase(options, 'after-stage', { auditIdentity });
    const markerName = `${auditIdentity}.commit.json`;
    const markerPath = path.join(paths.transactions, markerName);
    let marker;
    if (ioExists(io, markerPath)) {
      marker = readJsonFile(io, markerPath);
      if (!validQuarantineMarker(marker, markerName) || canonicalJson(auditBody(marker)) !== canonicalJson(body)) {
        fail('quarantine_marker_ambiguous', 'existing canonical marker is invalid or mismatched');
      }
    } else {
      marker = persistCommitMarker(markerPath, {
        kind: 'deep-evolve-quarantine',
        audit_identity: auditIdentity,
        nonce: projectHandle.nonce,
        ...body,
      }, atomicOptions);
    }
    invokePhase(options, 'after-marker', { auditIdentity, marker });
    return recoverMarker(stateRoot, marker, markerName, options, projectHandle);
  }, lockOptions(options));
  if (result && result.ok === false) fail(result.code || 'lock_held', 'coordination lock held');
  return result;
}

function recoverQuarantine(stateRoot, rawOptions = {}) {
  const options = { ...rawOptions };
  const io = options.io || fs;
  const paths = quarantinePaths(stateRoot);
  if (!ioExists(io, paths.transactions)) return { ok: true, rc: 0, recovered: 0, audit_identities: [] };
  let result;
  try {
    result = withDirectoryLock(path.join(stateRoot, '.coordination-lock'), (projectHandle) => {
      const names = options.auditIdentity
        ? [`${options.auditIdentity}.commit.json`]
        : listCanonicalMarkers(paths, io);
      const recovered = [];
      for (const name of names) {
        const markerPath = path.join(paths.transactions, name);
        if (!ioExists(io, markerPath)) continue;
        let marker;
        try { marker = readJsonFile(io, markerPath); }
        catch { fail('quarantine_marker_invalid', `canonical marker is not valid JSON: ${name}`); }
        recovered.push(recoverMarker(stateRoot, marker, name, options, projectHandle));
      }
      if (recovered.length === 1) return recovered[0];
      return { ok: true, rc: 0, recovered: recovered.length, audit_identities: recovered.map((entry) => entry.audit_identity) };
    }, lockOptions(options));
  } catch (error) {
    return {
      ok: false,
      rc: 2,
      error: {
        code: error && error.code ? error.code : 'quarantine_recovery_failed',
        message: error && error.message ? error.message : 'quarantine recovery failed',
      },
    };
  }
  if (result && result.ok === false) return { ok: false, rc: 2, error: { code: result.code || 'lock_held', message: 'coordination lock held' } };
  return result;
}

function validateKillFields({ seedId, condition, finalQ, experimentsUsed }) {
  requireInteger(seedId, 'seed_id', { min: 1 });
  if (!KILL_CONDITIONS.has(condition)) fail('invalid_kill_condition', `condition must be one of: ${[...KILL_CONDITIONS].join(', ')}`);
  requireNumber(finalQ, 'final_q');
  requireInteger(experimentsUsed, 'experiments_used', { min: 0 });
}

function queueKill({
  stateRoot,
  sessionId,
  seedId,
  condition,
  finalQ,
  experimentsUsed,
  randomUUID = crypto.randomUUID,
  now = Date.now,
  options = {},
}) {
  validateKillFields({ seedId, condition, finalQ, experimentsUsed });
  const entry = {
    entry_id: randomUUID(),
    seed_id: seedId,
    condition,
    final_q: finalQ,
    experiments_used: experimentsUsed,
    queued_at: isoNow(now),
  };
  appendJsonl({ stateRoot, relativePath: `${sessionId}/kill_queue.jsonl`, event: entry, options });
  return entry;
}

function queueUserKill({
  stateRoot,
  sessionId,
  seedId,
  randomUUID = crypto.randomUUID,
  now = Date.now,
  options = {},
}) {
  requireInteger(seedId, 'seed_id', { min: 1 });
  const entry = {
    entry_id: randomUUID(),
    seed_id: seedId,
    requested_at: isoNow(now),
    confirmed: false,
  };
  appendJsonl({ stateRoot, relativePath: `${sessionId}/kill_requests.jsonl`, event: entry, options });
  return entry;
}

function strictlyLater(nowText, queuedAt) {
  const queued = Date.parse(queuedAt);
  const now = Date.parse(nowText);
  if (!Number.isFinite(queued)) return null;
  return new Date(Math.max(now, queued + 1_000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function validQueueEntry(entry) {
  return plainObject(entry)
    && typeof entry.entry_id === 'string' && entry.entry_id.length > 0
    && Number.isInteger(entry.seed_id) && entry.seed_id > 0
    && KILL_CONDITIONS.has(entry.condition)
    && typeof entry.final_q === 'number' && Number.isFinite(entry.final_q)
    && Number.isInteger(entry.experiments_used) && entry.experiments_used >= 0
    && typeof entry.queued_at === 'string';
}

function drainKillQueue({
  stateRoot,
  sessionId,
  completedSeedId,
  now = Date.now,
  onPhase,
  options = {},
}) {
  requireInteger(completedSeedId, 'completed_seed_id', { min: 1 });
  const queueRelative = `${sessionId}/kill_queue.jsonl`;
  const journalRelative = `${sessionId}/journal.jsonl`;
  resolveRelativeJsonl(stateRoot, queueRelative);
  resolveRelativeJsonl(stateRoot, journalRelative);
  // The fail-closed availability tradeoff is deliberate: one malformed line
  // blocks drain before recovery or cleanup; explicit quarantine is the sole
  // repair route. Both files are revalidated again under the project lock.
  readJsonl({ stateRoot, relativePath: queueRelative });
  readJsonl({ stateRoot, relativePath: journalRelative });
  let summary = { drained: 0, seed_id: completedSeedId, emit_failed: 0 };
  mutateCoordinationFiles(stateRoot, [queueRelative, journalRelative], (files) => {
    const queueLines = splitJsonl(Buffer.from(files[queueRelative]));
    const journalLines = splitJsonl(Buffer.from(files[journalRelative]));
    assertValidJsonl(queueLines, queueRelative);
    assertValidJsonl(journalLines, journalRelative);
    if (typeof onPhase === 'function') onPhase('drain-snapshot', { queue: queueLines.map((line) => line.value) });
    const journal = journalLines.filter((line) => !line.blank).map((line) => line.value);
    const already = new Set(journal.filter((entry) => entry.event === 'seed_killed' && typeof entry.entry_id === 'string').map((entry) => entry.entry_id));
    const survivors = [];
    const additions = [];
    for (const line of queueLines) {
      if (line.blank) continue;
      const entry = line.value;
      if (entry.seed_id !== completedSeedId) { survivors.push(entry); continue; }
      if (!validQueueEntry(entry)) {
        survivors.push(entry);
        summary.emit_failed += 1;
        continue;
      }
      summary.drained += 1;
      if (already.has(entry.entry_id)) continue;
      const applied = strictlyLater(isoNow(now), entry.queued_at);
      if (!applied) {
        survivors.push(entry);
        summary.drained -= 1;
        summary.emit_failed += 1;
        continue;
      }
      const killed = {
        event: 'seed_killed',
        entry_id: entry.entry_id,
        seed_id: entry.seed_id,
        condition: entry.condition,
        final_q: entry.final_q,
        experiments_used: entry.experiments_used,
        queued_at: entry.queued_at,
        applied_at: applied,
        reasoning: `queued kill drained at block completion: ${entry.condition}`,
        ts: isoNow(now),
        session_id: sessionId,
      };
      additions.push(killed);
      already.add(entry.entry_id);
    }
    if (summary.drained === 0 && additions.length === 0 && survivors.length === queueLines.filter((line) => !line.blank).length) return null;
    const queueText = survivors.map((entry) => `${JSON.stringify(entry)}\n`).join('');
    const journalText = additions.reduce((text, entry) => appendText(text, entry), files[journalRelative]);
    return { [queueRelative]: queueText, [journalRelative]: journalText };
  }, options);
  return summary;
}

module.exports = {
  appendJsonl,
  readJsonl,
  tailJsonl,
  quarantineMalformed,
  recoverQuarantine,
  queueKill,
  queueUserKill,
  drainKillQueue,
};
