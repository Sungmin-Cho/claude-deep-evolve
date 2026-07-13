#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  parseStateDocument,
  serializeStateDocument,
} = require('./runtime/session-codec.cjs');
const {
  FULL_COMMIT,
  appendOperationReceipt,
  appendTypedEventAndReceipt,
  appendTypedEventsAndReceipt,
  applyBaseline,
  applyCompletion,
  applyEvaluatorExpansion,
  applyExperiment,
  assertRepairableProjection,
  buildInitialSession,
  findOperationReceipt,
  installProjection,
  isStrictSessionVersion,
  parseResultsTsv,
  parseStrictJsonl,
  projectionFromVirtual,
  projectionSha256,
  reduceVirtualProjection,
  requestSha256,
  requireDigest: requireAuthorityDigest,
  requireOperationId,
  resultRowForExperiment,
  serializeResultRow,
  sessionNonProjectionSha256,
  transitionError,
  validateCommittedJournal,
  validateBeta,
  validateExperiment,
  validateInitialStateSpec,
  validateTransferPatch,
} = require('./runtime/session-transitions.cjs');
const {
  atomicWriteFile,
  mutateCoordinationFiles,
  patchSession,
  persistCommitMarker,
  readCoordinationFiles,
  recoverTransactions,
  syncRenamedDirectoryBestEffort,
  validateCommitMarker,
  validateStoredSession,
  withDirectoryLock,
  sha256Digest,
} = require('./runtime/session-store.cjs');
const {
  appendJsonl: appendJournalJsonl,
  readJsonl: readJournalJsonl,
  tailJsonl,
  quarantineMalformed,
  queueKill,
  queueUserKill,
  drainKillQueue,
  stableUserKillEntryId,
  prepareEligibleKills,
  validateKillQueue,
  validateUserKillRequests,
  assertGenericEventAllowed,
} = require('./runtime/journal-store.cjs');
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
  deriveInFlightSeedIds,
} = require('./runtime/scheduler.cjs');
const {
  applyEpochBoundary,
  assertSummaryMatches,
  beginSeedBlock,
  buildFinishEvent,
  deriveEpochBoundary,
  deriveFinishEvidence,
} = require('./runtime/coordinator-store.cjs');
const {
  createSeedWorktree,
  validateSeedWorktree,
  removeSeedWorktree,
  createSynthesisWorktree,
  cleanupFailedSynthesisWorktree,
  backtrackArchive,
  saveStrategyArchive,
  restoreStrategyArchive,
  forkStrategyArchive,
} = require('./runtime/worktree-store.cjs');
const {
  processBeta,
  processBetaGrowth,
  selectBaseline,
  buildSeedDispatchContext,
  writeSeedProgram,
  renderForumSummary,
  renderCrossSeedAudit,
  renderFallbackNote,
  renderStatus,
  collectSynthesis,
  validateSynthesisChoice,
  finalizeSynthesis,
  resolveDataRoot,
  lookupTransfer,
  recordTransfer,
  pruneTransfer,
  exportFeedback,
} = require('./runtime/synthesis.cjs');
const {
  generateHarness,
  migrateLegacyHarness,
  runHarness,
  writeBaseline,
} = require('./runtime/harness-runtime.cjs');
const { wrapEvolveArtifact } = require('./wrap-evolve-envelope.js');
const { buildHandoffArtifact } = require('./emit-handoff.js');
const { buildCompactionArtifact } = require('./emit-compaction-state.js');
const {
  BUILDER_VERSION: ARTIFACT_BUILDER_VERSION,
  DIGEST_RE: ARTIFACT_DIGEST_RE,
  PUBLICATION_ID_RE,
  authenticateSourceArtifacts,
  publishArtifact,
  readPublication,
  stableReadRegular,
} = require('./runtime/artifact-store.cjs');
const { findProjectRoot, isPathInside } = require('./runtime/runtime-paths.cjs');

const RUNTIME_VERSION = require('../../package.json').version;

const OPERATIONS = Object.freeze([
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
  'harness.generate',
  'harness.migrate-legacy',
  'harness.run',
  'harness.write-baseline',
]);

const TASK4_OWNS_RECOVERY = new Set(OPERATIONS.filter((operation) =>
  operation.startsWith('metrics.')
  || operation.startsWith('coord.')
  || operation.startsWith('scheduler.')));

const NATIVE_LEGACY_ARMS = [
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
  'resolve_helper_path',
  'append_seed_to_session_yaml',
  'set_virtual_parallel_field',
  'init_virtual_parallel_block',
  'rebuild_seeds_from_journal',
  'entropy_compute',
  'migrate_v2_weights',
  'count_flagged_since_last_expansion',
  'retry_budget_remaining',
  'compute_init_budget_split',
  'compute_grow_allocation',
  'append_forum_event',
  'tail_forum',
  'append_journal_event',
  'append_kill_queue_entry',
  'drain_kill_queue',
  'create_seed_worktree',
  'validate_seed_worktree',
  'remove_seed_worktree',
  'create_synthesis_worktree',
  'cleanup_failed_synthesis_worktree',
];

const DEFERRED_LEGACY_ARMS = [];

const LEGACY_ROUTES = Object.freeze(Object.fromEntries([
  ...NATIVE_LEGACY_ARMS.map((name) => [name, 'native']),
  ...DEFERRED_LEGACY_ARMS.map((name) => [name, 'legacy']),
]));

const STATUS_VALUES = new Set(['initializing', 'active', 'paused', 'completed', 'aborted']);
const ROOT_REQUEST_KEYS = new Set(['schema_version', 'operation', 'context', 'payload']);
const CONTEXT_KEYS = new Set(['project_root']);
const RECEIPT_FILE = 'evolve-receipt.json';
const SESSION_FILES = [
  'session.yaml',
  'strategy.yaml',
  'program.md',
  'prepare.cjs',
  'prepare.config.json',
  'prepare.py',
  'prepare-protocol.md',
  'results.tsv',
  'journal.jsonl',
  'forum.jsonl',
  'standalone-forum.jsonl',
  'kill_queue.jsonl',
  'kill_requests.jsonl',
  'report.md',
  RECEIPT_FILE,
];
const SESSION_DIRECTORIES = ['runs', 'code-archive', 'strategy-archive'];

class RuntimeError extends Error {
  constructor(code, message, rc = 2, details) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.rc = rc;
    if (details !== undefined) this.details = details;
  }
}

function operatorError(code, message, details) {
  return new RuntimeError(code, message, 2, details);
}

function businessError(code, message, details) {
  return new RuntimeError(code, message, 1, details);
}

function plainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainTree(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainTree(item, `${label}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (!plainObject(value)) throw operatorError('nonplain_object', `${label} must contain only plain JSON objects`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw operatorError('unsafe_field', `${label} contains a symbol field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw operatorError('nonplain_object', `${label}.${key} must be an enumerable data property`);
    }
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw operatorError('unsafe_field', `${label} contains an unsafe field`);
    }
    assertPlainTree(descriptor.value, `${label}.${key}`);
  }
}

function requirePlainObject(value, label) {
  if (!plainObject(value)) throw operatorError('invalid_object', `${label} must be a plain object`);
  assertPlainTree(value, label);
  return value;
}

function rejectUnknownKeys(value, allowed, label, code = 'unknown_field') {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw operatorError(code, `unknown ${label} symbol field`);
    if (!allowed.has(key)) throw operatorError(code, `unknown ${label} field ${JSON.stringify(key)}`);
  }
}

function payloadFor(request, fields) {
  const payload = requirePlainObject(request.payload, 'payload');
  rejectUnknownKeys(payload, new Set(fields), 'payload', 'unknown_payload_field');
  return payload;
}

function requireString(value, label, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && value.length === 0)) {
    throw operatorError('invalid_field_type', `${label} must be ${empty ? 'a string' : 'a non-empty string'}`);
  }
  return value;
}

function requireInteger(value, label, { min, max } = {}) {
  if (!Number.isInteger(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    const range = min !== undefined || max !== undefined
      ? ` from ${min === undefined ? '-infinity' : min} to ${max === undefined ? 'infinity' : max}`
      : '';
    throw operatorError('invalid_field_type', `${label} must be an integer${range}`);
  }
  return value;
}

function isoNow(dependencies = {}) {
  const value = dependencies.now ? dependencies.now() : Date.now();
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function appendJsonLine(text, value) {
  if (!text) return jsonLine(value);
  return `${text}${text.endsWith('\n') ? '' : '\n'}${jsonLine(value)}`;
}

function parseJson(text, label, { missing = false } = {}) {
  if (text === '' && missing) return null;
  try {
    const value = JSON.parse(text);
    assertPlainTree(value, label);
    return value;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw operatorError('invalid_json', `${label} is not valid JSON`);
  }
}

function parseJsonl(text, label, { skipMalformed = false, warnings = [] } = {}) {
  if (!text) return [];
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue;
    try {
      const value = JSON.parse(lines[index]);
      if (!plainObject(value)) throw new Error('record is not an object');
      assertPlainTree(value, `${label} line ${index + 1}`);
      records.push(value);
    } catch (error) {
      if (!skipMalformed) throw operatorError('invalid_jsonl', `${label} line ${index + 1} is malformed`);
      warnings.push({ code: 'malformed_jsonl_skipped', file: label, line: index + 1 });
    }
  }
  return records;
}

function makeResponse(operation, body, exitCode) {
  const response = {
    schema_version: '1.0',
    ...body,
    operation: typeof operation === 'string' ? operation : null,
  };
  if (body.ok) response.warnings = body.warnings || [];
  Object.defineProperty(response, 'exitCode', {
    value: exitCode,
    enumerable: false,
    writable: false,
  });
  return response;
}

function successResponse(operation, result, warnings = []) {
  return makeResponse(operation, { ok: true, result, warnings }, 0);
}

function failureResponse(operation, error) {
  const rc = error && error.rc === 1 ? 1 : 2;
  const body = {
    ok: false,
    error: {
      code: error && typeof error.code === 'string' ? error.code.toLowerCase() : 'runtime_failure',
      message: error && typeof error.message === 'string' ? error.message : 'runtime operation failed',
    },
  };
  if (error && error.details !== undefined) body.error.details = error.details;
  return makeResponse(operation, body, rc);
}

function validateRequest(request) {
  requirePlainObject(request, 'request');
  rejectUnknownKeys(request, ROOT_REQUEST_KEYS, 'request');
  for (const key of ROOT_REQUEST_KEYS) {
    if (!Object.hasOwn(request, key)) throw operatorError('missing_request_field', `request field ${key} is required`);
  }
  if (request.schema_version !== '1.0') throw operatorError('unsupported_schema', 'schema_version must be "1.0"');
  requireString(request.operation, 'operation');
  requirePlainObject(request.context, 'context');
  rejectUnknownKeys(request.context, CONTEXT_KEYS, 'context');
  requirePlainObject(request.payload, 'payload');
  if (!OPERATIONS.includes(request.operation)) {
    throw operatorError('unknown_operation', `unknown operation ${JSON.stringify(request.operation)}`);
  }
  return request;
}

function resolveProject(context) {
  const supplied = requireString(context.project_root, 'context.project_root');
  if (!path.isAbsolute(supplied)) throw operatorError('project_root_not_absolute', 'context.project_root must be absolute');
  let projectRoot;
  try { projectRoot = fs.realpathSync(supplied); }
  catch { throw operatorError('project_root_missing', `project root does not exist: ${supplied}`); }
  if (!fs.statSync(projectRoot).isDirectory()) throw operatorError('project_root_invalid', 'project root must be a directory');
  const statePath = path.join(projectRoot, '.deep-evolve');
  let stateRoot = statePath;
  if (fs.existsSync(statePath)) {
    try { stateRoot = fs.realpathSync(statePath); }
    catch { throw operatorError('state_root_unreadable', 'cannot resolve .deep-evolve'); }
    if (!isPathInside(projectRoot, stateRoot)) {
      throw operatorError('state_path_escape', '.deep-evolve resolves outside the project root');
    }
  }
  return { projectRoot, stateRoot };
}

function ensureSessionId(value, label = 'session_id') {
  requireString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === '.' || value === '..') {
    throw operatorError('invalid_session_id', `${label} contains unsafe path characters`);
  }
  return value;
}

function assertPhysicalContainment(parent, candidate, code = 'state_path_escape') {
  let stat;
  try { stat = fs.lstatSync(candidate); }
  catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw operatorError('state_path_unreadable', `cannot inspect state path: ${candidate}`);
  }
  let resolved;
  try { resolved = fs.realpathSync(candidate); }
  catch { throw operatorError('state_path_unreadable', `cannot resolve state path: ${candidate}`); }
  if (!isPathInside(parent, resolved)) {
    throw operatorError(code, `state path resolves outside its root: ${candidate}`);
  }
  if (stat.isSymbolicLink() && !isPathInside(parent, resolved)) {
    throw operatorError(code, `state symlink resolves outside its root: ${candidate}`);
  }
}

function sessionInfo(project, sessionId, { requireDirectory = false } = {}) {
  const id = ensureSessionId(sessionId);
  const lexical = path.join(project.stateRoot, id);
  let sessionRoot = lexical;
  const directoryExists = fs.existsSync(lexical);
  let lexicalStat = null;
  if (directoryExists) {
    try { lexicalStat = fs.lstatSync(lexical); }
    catch { throw operatorError('session_path_unreadable', `cannot inspect session path for ${id}`); }
    try { sessionRoot = fs.realpathSync(lexical); }
    catch { throw operatorError('session_path_unreadable', `cannot resolve session path for ${id}`); }
    if (!isPathInside(project.stateRoot, sessionRoot)) {
      throw operatorError('session_path_escape', `session ${id} resolves outside .deep-evolve`);
    }
    if (lexicalStat.isSymbolicLink()) {
      verifyOwnedStartedSessionLink(project.stateRoot, id, lexical, sessionRoot);
    }
  } else if (requireDirectory) {
    throw businessError('orphan_pointer', `session directory is missing: ${lexical}`);
  }
  if (directoryExists) {
    for (const name of [
      'session.yaml', 'strategy.yaml', 'journal.jsonl', 'forum.jsonl', 'kill_queue.jsonl',
      'kill_requests.jsonl',
      '.session.yaml.lock', '.strategy.yaml.lock', '.journal.jsonl.lock', '.forum.jsonl.lock',
      '.kill_queue.jsonl.lock', '.kill_requests.jsonl.lock',
    ]) {
      assertPhysicalContainment(sessionRoot, path.join(sessionRoot, name));
    }
  }
  return {
    sessionId: id,
    sessionRoot,
    publicSessionRoot: lexical,
    sessionPath: path.join(sessionRoot, 'session.yaml'),
    relativeSessionRoot: path.relative(project.stateRoot, sessionRoot)
      .split(path.sep).join('/'),
    relativeSession: path.relative(project.stateRoot, path.join(sessionRoot, 'session.yaml'))
      .split(path.sep).join('/'),
    directoryExists,
  };
}

function relativeSessionSibling(info, name) {
  return path.posix.join(info.relativeSessionRoot, name);
}

function ensureContainedExisting(project, candidate, label) {
  let resolved;
  try { resolved = fs.realpathSync(candidate); }
  catch { throw businessError(`${label}_missing`, `${label} not found: ${candidate}`); }
  if (!isPathInside(project.projectRoot, resolved)) {
    throw operatorError('path_escape', `${label} resolves outside the project root`);
  }
  return resolved;
}

function recoverProject(project, dependencies = {}) {
  for (const name of [
    'current.json', 'sessions.jsonl', 'session.yaml', 'strategy.yaml', 'journal.jsonl',
    'forum.jsonl', 'kill_queue.jsonl', 'kill_requests.jsonl', 'meta-archive-local.jsonl',
    '.transactions',
    '.migration-transactions',
    '.coordination-lock', '.meta-archive-lock', '.legacy-migration-lock',
    '.current.json.lock', '.sessions.jsonl.lock',
  ]) {
    assertPhysicalContainment(project.stateRoot, path.join(project.stateRoot, name));
  }
  ensureStartReservationDirectory(project.stateRoot);
  const coordination = recoverTransactions(project.stateRoot);
  if (coordination && coordination.ok === false) {
    throw operatorError(coordination.error ? coordination.error.code : 'recovery_failed',
      coordination.error ? coordination.error.message : 'coordination recovery failed');
  }
  const migrations = recoverMigrations(project, dependencies);
  return { coordination, migrations };
}

function registryStatus(records, sessionId) {
  let status = null;
  for (const event of records) {
    if (event.session_id !== sessionId) continue;
    if (event.event === 'reconciled' && typeof event.to === 'string') status = event.to;
    else if (['created', 'migrated', 'status_change', 'finished'].includes(event.event)
      && typeof event.status === 'string') status = event.status;
  }
  return status;
}

function resolveCurrent(project, dependencies = {}) {
  const first = readCoordinationFiles(project.stateRoot, ['current.json'])['current.json'];
  if (!first) throw businessError('current_missing', 'no active session (current.json missing)');
  const pointer = parseJson(first, 'current.json');
  if (typeof pointer.session_id !== 'string' || pointer.session_id.length === 0) {
    throw businessError('session_id_null', 'no active session (session_id null)');
  }
  const info = sessionInfo(project, pointer.session_id);
  let resolvedSession;
  mutateCoordinationFiles(
    project.stateRoot,
    ['current.json', info.relativeSession, 'sessions.jsonl'],
    (files) => {
      const current = parseJson(files['current.json'], 'current.json');
      if (current.session_id !== info.sessionId) {
        throw businessError('current_changed', 'current session changed while resolving');
      }
      if (!files[info.relativeSession]) {
        if (!info.directoryExists) {
          throw businessError('orphan_pointer', `orphan pointer — session dir missing: ${info.sessionRoot}`);
        }
        throw businessError('session_yaml_missing', `session dir exists but session.yaml missing: ${info.sessionRoot}`);
      }
      resolvedSession = validateStoredSession(parseStateDocument(files[info.relativeSession], {
        sourcePath: info.sessionPath,
      }));
      assertSessionIdentity(resolvedSession, info.sessionId);
      const records = parseJsonl(files['sessions.jsonl'], 'sessions.jsonl');
      const recorded = registryStatus(records, info.sessionId);
      if (!recorded || recorded === resolvedSession.status) return null;
      const event = {
        event: 'reconciled',
        ts: isoNow(dependencies),
        session_id: info.sessionId,
        from: recorded,
        to: resolvedSession.status,
      };
      return {
        'current.json': files['current.json'],
        [info.relativeSession]: files[info.relativeSession],
        'sessions.jsonl': appendJsonLine(files['sessions.jsonl'], event),
      };
    },
  );
  return { info, session: resolvedSession };
}

function foldSessions(records) {
  const sessions = [];
  for (const event of records) {
    if (event.event === 'created' || event.event === 'migrated') {
      sessions.push(structuredClone(event));
      continue;
    }
    for (let index = 0; index < sessions.length; index += 1) {
      if (sessions[index].session_id !== event.session_id) continue;
      if (event.event === 'status_change') sessions[index].status = event.status;
      else if (event.event === 'reconciled') sessions[index].status = event.to;
      else if (event.event === 'lineage_set') sessions[index].parent_session_id = event.parent_session_id;
      else if (event.event === 'finished') {
        const additions = structuredClone(event);
        delete additions.event;
        delete additions.ts;
        sessions[index] = { ...sessions[index], ...additions };
      }
    }
  }
  return sessions;
}

function operationList(project, payload) {
  const records = parseJsonl(
    readCoordinationFiles(project.stateRoot, ['sessions.jsonl'])['sessions.jsonl'],
    'sessions.jsonl',
  );
  let sessions = foldSessions(records);
  if (payload.status !== undefined) {
    requireString(payload.status, 'payload.status');
    sessions = sessions.filter((session) => session.status === payload.status);
  }
  return { sessions };
}

function computeSlug(goal, timestamp) {
  const slug = String(goal || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (slug) return slug;
  const hash = crypto.createHash('sha256').update(`${goal || ''}${timestamp}`).digest('hex').slice(0, 6);
  return `session-${hash}`;
}

function candidateSessionId(goal, timestamp, records, stateRoot) {
  const base = `${timestamp.slice(0, 10)}_${computeSlug(goal, timestamp)}`;
  const used = new Set(records.map((record) => record.session_id).filter((value) => typeof value === 'string'));
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate) || fs.existsSync(path.join(stateRoot, candidate))) {
    if (suffix > 1000) throw businessError('session_id_collision', 'session_id collision retry exhausted');
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function legacyComputedSessionId(goal, timestamp, sessionsText) {
  const base = `${timestamp.slice(0, 10)}_${computeSlug(goal, timestamp)}`;
  let candidate = base;
  let suffix = 2;
  while (sessionsText.includes(`"session_id":"${candidate}"`)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

const START_CHILD_DIRECTORIES = Object.freeze([
  'runs', 'code-archive', 'strategy-archive', 'meta-analyses',
]);
const START_RESERVATION_FILE = '.start-reservation.json';
const START_PUBLICATION_FILE = '.start-publication.json';
const START_FINALIZATION_FILE = '.start-finalized.json';
const START_STATE_FILE = '.start-state.commit.json';
const CANONICAL_SESSION_VERSION = '3.5.0';
const RESULTS_V3_HEADER = 'commit\tscore\tstatus\tcategory\tscore_delta\tloc_delta\tflagged\trationale\tdescription\n';
const START_STATE_FILES = Object.freeze([
  'session.yaml',
  'journal.jsonl',
  'forum.jsonl',
  'kill_queue.jsonl',
  'kill_requests.jsonl',
  'results.tsv',
]);

function canonicalStartValue(value) {
  if (Array.isArray(value)) return value.map(canonicalStartValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalStartValue(value[key]);
    return result;
  }
  return value;
}

function startCommitMarker(value) {
  const {
    marker_schema_version: _schemaVersion,
    marker_checksum: _checksum,
    ...payload
  } = value;
  const body = { ...payload, marker_schema_version: '1.0' };
  return {
    ...body,
    marker_checksum: `sha256:${crypto.createHash('sha256')
      .update(JSON.stringify(canonicalStartValue(body))).digest('hex')}`,
  };
}

function startRequestDigest(goal, parent, initialState = undefined) {
  const request = {
    goal,
    parent_session_id: parent,
  };
  if (initialState !== undefined) request.initial_state = canonicalStartValue(initialState);
  return `sha256:${crypto.createHash('sha256')
    .update(JSON.stringify(canonicalStartValue(request))).digest('hex')}`;
}

function startReservationDirectory(stateRoot) {
  return path.join(stateRoot, '.start-reservations');
}

function ensureStartReservationDirectory(stateRoot, { create = false } = {}) {
  const directory = startReservationDirectory(stateRoot);
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if (!(error && error.code === 'ENOENT')) throw error;
    if (!create) return null;
    fs.mkdirSync(directory, { mode: 0o700 });
    stat = fs.lstatSync(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw operatorError('start_reservation_path_escape',
      'start reservation directory must be a private non-symlink directory');
  }
  const physical = fs.realpathSync(directory);
  if (physical !== path.resolve(directory) || !isPathInside(stateRoot, physical)) {
    throw operatorError('start_reservation_path_escape',
      'start reservation directory must remain physically contained');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw operatorError('start_reservation_untrusted',
      'start reservation directory permissions are not private');
  }
  return directory;
}

function assertStartPathComponents(stateRoot, candidate) {
  const relative = path.relative(stateRoot, candidate);
  if (!relative || relative === '.' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw operatorError('start_reservation_path_escape',
      `start reservation path escapes state root: ${candidate}`);
  }
  let current = stateRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error && error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw operatorError('start_reservation_path_escape',
        `start reservation path contains a symlink: ${current}`);
    }
  }
}

function startReservationSidecar(stateRoot, sessionId, reservationNonce) {
  return path.join(startReservationDirectory(stateRoot), `${sessionId}.${reservationNonce}.json`);
}

function startNamespaceIdentity(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw operatorError('start_reservation_ambiguous',
      `reserved namespace is not a private directory: ${candidate}`);
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function sameStartNamespaceIdentity(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino;
}

function readStartCommitRecord(stateRoot, markerPath, expectedKind) {
  assertStartPathComponents(stateRoot, markerPath);
  let marker;
  let descriptor;
  try {
    const lexical = fs.lstatSync(markerPath, { bigint: true });
    if (!lexical.isFile() || lexical.isSymbolicLink()) {
      throw operatorError('start_reservation_path_escape',
        `start reservation marker must be a regular non-symlink file: ${markerPath}`);
    }
    const physical = fs.realpathSync(markerPath);
    if (!isPathInside(stateRoot, physical)) {
      throw operatorError('start_reservation_path_escape',
        `start reservation marker escapes state root: ${markerPath}`);
    }
    descriptor = fs.openSync(markerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== lexical.dev || before.ino !== lexical.ino) {
      throw operatorError('start_reservation_ambiguous',
        `start reservation marker changed before read: ${markerPath}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw operatorError('start_reservation_ambiguous',
        `start reservation marker changed during read: ${markerPath}`);
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    marker = JSON.parse(bytes.toString('utf8'));
  }
  catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (error instanceof RuntimeError) throw error;
    throw operatorError('start_reservation_invalid',
      `cannot read start reservation ${markerPath}: ${error && error.message ? error.message : error}`);
  }
  const checked = validateCommitMarker(marker);
  if (!checked.valid
      || marker.kind !== expectedKind) {
    throw operatorError('start_reservation_invalid', `invalid start record: ${markerPath}`);
  }
  return marker;
}

function readStartReservation(stateRoot, markerPath) {
  const marker = readStartCommitRecord(
    stateRoot, markerPath, 'deep-evolve-start-reservation',
  );
  if (typeof marker.session_id !== 'string'
      || typeof marker.request_digest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(marker.request_digest)
      || typeof marker.reservation_nonce !== 'string'
      || !/^[a-f0-9]{32,}$/.test(marker.reservation_nonce)
      || !plainObject(marker.namespace_identity)
      || !/^\d+$/.test(marker.namespace_identity.dev || '')
      || !/^\d+$/.test(marker.namespace_identity.ino || '')
      || !Array.isArray(marker.expected_children)
      || marker.expected_children.join('\0') !== START_CHILD_DIRECTORIES.join('\0')) {
    throw operatorError('start_reservation_invalid', `invalid start reservation: ${markerPath}`);
  }
  const hasInitializationId = Object.hasOwn(marker, 'initialization_id');
  const hasInitialStateDigest = Object.hasOwn(marker, 'initial_state_digest');
  if (hasInitializationId !== hasInitialStateDigest
      || (hasInitializationId
        && (typeof marker.initialization_id !== 'string'
          || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(marker.initialization_id)
          || typeof marker.initial_state_digest !== 'string'
          || !/^sha256:[a-f0-9]{64}$/.test(marker.initial_state_digest)))) {
    throw operatorError('start_reservation_invalid', `invalid canonical start reservation: ${markerPath}`);
  }
  ensureSessionId(marker.session_id, 'start reservation session_id');
  return marker;
}

function sameStartReservation(left, right) {
  return left.kind === right.kind
    && left.session_id === right.session_id
    && left.request_digest === right.request_digest
    && left.created_at === right.created_at
    && left.reservation_nonce === right.reservation_nonce
    && sameStartNamespaceIdentity(left.namespace_identity, right.namespace_identity)
    && left.marker_checksum === right.marker_checksum;
}

function startNamespaceCandidates(stateRoot, marker) {
  const directory = startReservationDirectory(stateRoot);
  return [
    path.join(stateRoot, marker.session_id),
    path.join(directory, `.namespace-${marker.reservation_nonce}`),
  ];
}

function locateStartNamespace(stateRoot, marker) {
  const locations = startNamespaceCandidates(stateRoot, marker)
    .filter((candidate) => fs.existsSync(candidate))
    .filter((candidate) => {
      try {
        return sameStartNamespaceIdentity(
          startNamespaceIdentity(candidate), marker.namespace_identity,
        );
      } catch {
        return false;
      }
    });
  if (locations.length !== 1) {
    throw operatorError('start_reservation_ambiguous',
      `reserved namespace location is missing or duplicated for ${marker.session_id}`);
  }
  const root = locations[0];
  assertStartPathComponents(stateRoot, root);
  const before = startNamespaceIdentity(root);
  if (!sameStartNamespaceIdentity(before, marker.namespace_identity)) {
    throw operatorError('start_reservation_ambiguous',
      `reserved namespace identity changed: ${root}`);
  }
  return { root, before };
}

function inspectStartNamespace(stateRoot, marker) {
  const { root, before } = locateStartNamespace(stateRoot, marker);
  const allowed = new Set([
    ...START_CHILD_DIRECTORIES,
    START_RESERVATION_FILE,
    START_PUBLICATION_FILE,
    START_FINALIZATION_FILE,
    START_STATE_FILE,
    ...START_STATE_FILES,
  ]);
  let namespaceMarkerPath = null;
  for (const name of fs.readdirSync(root)) {
    if (!allowed.has(name)) {
      throw operatorError('start_reservation_ambiguous',
        `reserved namespace contains unexpected entry ${name}: ${root}`);
    }
    const candidate = path.join(root, name);
    const stat = fs.lstatSync(candidate);
    if (name === START_RESERVATION_FILE) {
      if (namespaceMarkerPath) {
        throw operatorError('start_reservation_ambiguous',
          `reserved namespace contains duplicate markers: ${root}`);
      }
      if (!stat.isFile() || stat.isSymbolicLink()
          || !sameStartReservation(readStartReservation(stateRoot, candidate), marker)) {
        throw operatorError('start_reservation_ambiguous',
          `namespace reservation marker does not match sidecar: ${candidate}`);
      }
      namespaceMarkerPath = candidate;
      continue;
    }
    if (name === START_FINALIZATION_FILE) {
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw operatorError('start_reservation_ambiguous',
          `start finalization is not a private file: ${candidate}`);
      }
      readStartFinalization(stateRoot, root, marker);
      continue;
    }
    if (name === START_PUBLICATION_FILE) {
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw operatorError('start_reservation_ambiguous',
          `start publication is not a private file: ${candidate}`);
      }
      readStartPublication(stateRoot, root, marker);
      continue;
    }
    if (name === START_STATE_FILE) {
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw operatorError('start_state_ambiguous',
          `start state marker is not a private file: ${candidate}`);
      }
      readStartStateCommit(stateRoot, root, marker);
      continue;
    }
    if (START_STATE_FILES.includes(name)) {
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw operatorError('start_state_ambiguous',
          `canonical start state entry is not a private file: ${candidate}`);
      }
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(candidate).length !== 0) {
      throw operatorError('start_reservation_ambiguous',
        `reserved namespace child is not an empty private directory: ${candidate}`);
    }
  }
  const after = startNamespaceIdentity(root);
  if (!sameStartNamespaceIdentity(before, after)) {
    throw operatorError('start_reservation_ambiguous',
      `reserved namespace changed during inspection: ${root}`);
  }
  return { root, markerPath: namespaceMarkerPath };
}

function inspectFinalizedStartNamespace(stateRoot, marker) {
  const { root, before } = locateStartNamespace(stateRoot, marker);
  const markerPath = path.join(root, START_RESERVATION_FILE);
  let markerStat;
  try { markerStat = fs.lstatSync(markerPath); }
  catch {
    throw operatorError('start_reservation_ambiguous',
      `finalized namespace reservation marker is missing: ${markerPath}`);
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink()
      || !sameStartReservation(readStartReservation(stateRoot, markerPath), marker)) {
    throw operatorError('start_reservation_ambiguous',
      `finalized namespace reservation marker does not match sidecar: ${markerPath}`);
  }
  const publication = readStartPublication(stateRoot, root, marker);
  const finalized = readStartFinalization(stateRoot, root, marker);
  if (!publication || !finalized
      || !sameStartPublicEntryIdentity(
        publication.public_entry_identity, finalized.public_entry_identity,
      )) {
    throw operatorError('start_reservation_ambiguous',
      `finalized namespace evidence is incomplete or inconsistent: ${marker.session_id}`);
  }
  verifyPublicStartNamespace(
    stateRoot,
    marker,
    path.join(stateRoot, marker.session_id),
    root,
    publication.public_entry_identity,
  );
  const after = startNamespaceIdentity(root);
  if (!sameStartNamespaceIdentity(before, after)) {
    throw operatorError('start_reservation_ambiguous',
      `finalized namespace changed during inspection: ${root}`);
  }
  return { root, markerPath, publication, finalized };
}

function startPublicEntryIdentity(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    kind: stat.isSymbolicLink() ? 'link' : (stat.isDirectory() ? 'directory' : 'other'),
  };
}

function sameStartPublicEntryIdentity(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.kind === right.kind;
}

function verifyPublicStartNamespace(stateRoot, marker, destination, privateRoot,
  expectedPublicIdentity = null) {
  let lexical;
  try { lexical = fs.lstatSync(destination, { bigint: true }); }
  catch (error) {
    if (error && error.code === 'ENOENT') {
      throw operatorError('start_reservation_ambiguous',
        `session namespace public path is missing: ${destination}`);
    }
    throw error;
  }
  const publicIdentity = startPublicEntryIdentity(destination);
  if (expectedPublicIdentity
      && !sameStartPublicEntryIdentity(publicIdentity, expectedPublicIdentity)) {
    throw operatorError('start_reservation_ambiguous',
      `session namespace public entry changed: ${destination}`);
  }
  if (lexical.isSymbolicLink()) {
    let physical;
    try { physical = fs.realpathSync(destination); }
    catch {
      throw operatorError('start_reservation_ambiguous',
        `session namespace public link is unreadable: ${destination}`);
    }
    if (!isPathInside(stateRoot, physical)
        || !sameStartNamespaceIdentity(startNamespaceIdentity(physical), marker.namespace_identity)) {
      throw operatorError('start_reservation_ambiguous',
        `session namespace public link target changed: ${destination}`);
    }
    return publicIdentity;
  }
  if (path.resolve(destination) !== path.resolve(privateRoot)
      || !sameStartNamespaceIdentity(startNamespaceIdentity(destination), marker.namespace_identity)) {
    throw operatorError('start_reservation_ambiguous',
      `session namespace public path is foreign: ${destination}`);
  }
  return publicIdentity;
}

function createPublicStartNamespaceExclusive(destination, privateRoot) {
  try {
    // A directory link/junction is the only Node-22-built-in publication that
    // both exposes a complete pre-populated namespace and atomically refuses
    // to replace an existing public entry. All later writes use privateRoot,
    // never the replaceable public pathname. Windows receives an absolute,
    // same-volume junction (not a privilege-gated symbolic-link request).
    fs.symlinkSync(privateRoot, destination, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error && ['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM'].includes(error.code)) {
      throw operatorError('start_reservation_ambiguous',
        `session namespace public path is occupied: ${destination}`);
    }
    throw operatorError('start_reservation_install_failed',
      'cannot claim session namespace with an exclusive directory link');
  }
  return startPublicEntryIdentity(destination);
}

function fsyncExclusiveStartMarker(descriptor) {
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
  const delays = [10, 20, 40, 80, 120, 150, 180, 200, 200];
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.fsyncSync(descriptor);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !transient.has(error && error.code)
          || attempt >= delays.length) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
    }
  }
}

function writeExclusiveStartMarker(markerPath, marker) {
  let descriptor;
  try {
    descriptor = fs.openSync(markerPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(marker, null, 2)}\n`);
    fsyncExclusiveStartMarker(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    syncRenamedDirectoryBestEffort(path.dirname(markerPath), process.platform);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    throw operatorError('start_reservation_install_failed',
      'cannot persist the exclusive public namespace marker');
  }
}

function readStableStartFile(stateRoot, filePath) {
  assertStartPathComponents(stateRoot, filePath);
  let descriptor;
  try {
    const lexical = fs.lstatSync(filePath, { bigint: true });
    if (!lexical.isFile() || lexical.isSymbolicLink()) {
      throw operatorError('start_state_ambiguous',
        `canonical start state must be a regular non-symlink file: ${filePath}`);
    }
    const physical = fs.realpathSync(filePath);
    if (!isPathInside(stateRoot, physical)) {
      throw operatorError('start_state_ambiguous',
        `canonical start state escaped its state root: ${filePath}`);
    }
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== lexical.dev || before.ino !== lexical.ino) {
      throw operatorError('start_state_ambiguous',
        `canonical start state changed before read: ${filePath}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw operatorError('start_state_ambiguous',
        `canonical start state changed during read: ${filePath}`);
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    return bytes;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function writeExclusiveStartStateFile(stateRoot, filePath, bytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fsyncExclusiveStartMarker(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    syncRenamedDirectoryBestEffort(path.dirname(filePath), process.platform);
    return { created: true };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (!(error && error.code === 'EEXIST')) {
      throw operatorError('start_state_install_failed',
        `cannot persist canonical start state: ${path.basename(filePath)}`);
    }
    const existing = readStableStartFile(stateRoot, filePath);
    if (!existing.equals(bytes)) {
      throw operatorError('start_state_ambiguous',
        `canonical start state has a third digest: ${filePath}`);
    }
    return { created: false };
  }
}

function digestStartBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalStartStateFiles(session) {
  validateStoredSession(session);
  return new Map([
    ['session.yaml', Buffer.from(serializeStateDocument(session))],
    ['journal.jsonl', Buffer.alloc(0)],
    ['forum.jsonl', Buffer.alloc(0)],
    ['kill_queue.jsonl', Buffer.alloc(0)],
    ['kill_requests.jsonl', Buffer.alloc(0)],
    ['results.tsv', Buffer.from(RESULTS_V3_HEADER)],
  ]);
}

function readStartStateCommit(stateRoot, privateRoot, reservation) {
  const markerPath = path.join(privateRoot, START_STATE_FILE);
  if (!fs.existsSync(markerPath)) return null;
  const record = readStartCommitRecord(
    stateRoot,
    markerPath,
    'deep-evolve-start-state',
  );
  if (record.session_id !== reservation.session_id
      || typeof record.initialization_id !== 'string'
      || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(record.initialization_id)
      || typeof record.request_digest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(record.request_digest)
      || record.reservation_nonce !== reservation.reservation_nonce
      || !sameStartNamespaceIdentity(record.namespace_identity, reservation.namespace_identity)
      || (reservation.initialization_id !== undefined
        && (record.initialization_id !== reservation.initialization_id
          || record.request_digest !== reservation.request_digest))
      || !Array.isArray(record.files)
      || record.files.length !== START_STATE_FILES.length) {
    throw operatorError('start_state_ambiguous',
      `canonical start state marker does not match its reservation: ${markerPath}`);
  }
  for (let index = 0; index < START_STATE_FILES.length; index += 1) {
    const entry = record.files[index];
    if (!plainObject(entry)
        || Object.keys(entry).sort().join('\0') !== ['bytes', 'relative_path', 'sha256'].join('\0')
        || entry.relative_path !== START_STATE_FILES[index]
        || typeof entry.sha256 !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256)
        || !Number.isSafeInteger(entry.bytes)
        || entry.bytes < 0) {
      throw operatorError('start_state_ambiguous',
        `canonical start state marker has an invalid file record: ${markerPath}`);
    }
  }
  return record;
}

function verifyStartStateFiles(stateRoot, privateRoot, record, expectedFiles = null) {
  for (const entry of record.files) {
    const bytes = readStableStartFile(stateRoot, path.join(privateRoot, entry.relative_path));
    if (bytes.length !== entry.bytes || digestStartBytes(bytes) !== entry.sha256) {
      throw operatorError('start_state_ambiguous',
        `canonical start state digest changed: ${entry.relative_path}`);
    }
    if (expectedFiles && !bytes.equals(expectedFiles.get(entry.relative_path))) {
      throw operatorError('start_state_ambiguous',
        `canonical start state does not match the requested projection: ${entry.relative_path}`);
    }
  }
}

function ensureStartTargetContainment(projectRoot, initialState) {
  for (const relative of initialState.target_files) {
    let current = projectRoot;
    for (const component of relative.split('/')) {
      current = path.join(current, component);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) {
        if (error && error.code === 'ENOENT') break;
        throw operatorError('initial_target_path_unreadable',
          `cannot inspect initial target path: ${relative}`);
      }
      if (stat.isSymbolicLink()) {
        throw operatorError('initial_target_symlink',
          `initial target path contains a symlink: ${relative}`);
      }
      const physical = fs.realpathSync(current);
      if (!isPathInside(projectRoot, physical)) {
        throw operatorError('initial_target_path_escape',
          `initial target path escapes the project root: ${relative}`);
      }
    }
  }
}

function ensureCanonicalStartState(project, reservation, privateRoot, request, options = {}, {
  verifyFiles = true,
} = {}) {
  if (reservation.initialization_id !== undefined
      && reservation.initialization_id !== request.initializationId) {
    throw operatorError('initialization_id_conflict',
      'start reservation initialization_id conflicts with the canonical request');
  }
  if (reservation.initial_state_digest !== undefined
      && reservation.initial_state_digest !== request.initialStateDigest) {
    throw operatorError('initialization_id_conflict',
      'start reservation initial_state digest conflicts with the canonical request');
  }
  const session = buildInitialSession({
    sessionId: reservation.session_id,
    goal: request.goal,
    parent: request.parent,
    initialState: request.initialState,
    createdAt: reservation.created_at,
    runtimeVersion: CANONICAL_SESSION_VERSION,
  });
  const expectedFiles = canonicalStartStateFiles(session);
  let record = readStartStateCommit(project.stateRoot, privateRoot, reservation);
  if (record) {
    if (record.initialization_id === request.initializationId
        && record.request_digest !== request.requestDigest) {
      throw operatorError('initialization_id_conflict',
        'initialization_id was already bound to different canonical input');
    }
    if (record.initialization_id !== request.initializationId
        || record.request_digest !== request.requestDigest) {
      throw operatorError('start_state_ambiguous',
        'canonical start state marker conflicts with the requested initialization');
    }
    if (verifyFiles) verifyStartStateFiles(project.stateRoot, privateRoot, record, expectedFiles);
    return { record, session, files: expectedFiles, created: false };
  }

  if (!sameStartNamespaceIdentity(startNamespaceIdentity(privateRoot), reservation.namespace_identity)) {
    throw operatorError('start_state_ambiguous',
      'reserved namespace identity changed before state publication');
  }
  for (const [name, bytes] of expectedFiles) {
    writeExclusiveStartStateFile(project.stateRoot, path.join(privateRoot, name), bytes);
    invokeStartPhase(options, `after-start-state-file:${name}`, {
      sessionId: reservation.session_id,
      privateRoot,
      relativePath: name,
    });
  }
  const marker = startCommitMarker({
    kind: 'deep-evolve-start-state',
    session_id: reservation.session_id,
    initialization_id: request.initializationId,
    request_digest: request.requestDigest,
    reservation_nonce: reservation.reservation_nonce,
    namespace_identity: reservation.namespace_identity,
    files: [...expectedFiles].map(([relativePath, bytes]) => ({
      relative_path: relativePath,
      sha256: digestStartBytes(bytes),
      bytes: bytes.length,
    })),
  });
  const markerPath = path.join(privateRoot, START_STATE_FILE);
  try {
    writeExclusiveStartMarker(markerPath, marker);
  } catch (error) {
    if (!fs.existsSync(markerPath)) throw error;
    const raced = readStartStateCommit(project.stateRoot, privateRoot, reservation);
    if (!raced || raced.marker_checksum !== marker.marker_checksum) {
      throw operatorError('start_state_ambiguous',
        'canonical start state marker was occupied by a foreign record');
    }
  }
  invokeStartPhase(options, 'after-start-state-marker', {
    sessionId: reservation.session_id,
    privateRoot,
    markerPath,
  });
  record = readStartStateCommit(project.stateRoot, privateRoot, reservation);
  verifyStartStateFiles(project.stateRoot, privateRoot, record, expectedFiles);
  return { record, session, files: expectedFiles, created: true };
}

function startFinalizationPath(privateRoot) {
  return path.join(privateRoot, START_FINALIZATION_FILE);
}

function startPublicationPath(privateRoot) {
  return path.join(privateRoot, START_PUBLICATION_FILE);
}

function readStartPublication(stateRoot, privateRoot, marker) {
  const publicationPath = startPublicationPath(privateRoot);
  if (!fs.existsSync(publicationPath)) return null;
  const record = readStartCommitRecord(
    stateRoot, publicationPath, 'deep-evolve-start-publication',
  );
  if (record.session_id !== marker.session_id
      || record.request_digest !== marker.request_digest
      || record.reservation_nonce !== marker.reservation_nonce
      || !sameStartNamespaceIdentity(record.namespace_identity, marker.namespace_identity)
      || !plainObject(record.public_entry_identity)
      || !['link', 'directory'].includes(record.public_entry_identity.kind)) {
    throw operatorError('start_reservation_ambiguous',
      `start publication does not match its reservation: ${publicationPath}`);
  }
  return record;
}

function persistStartPublication(stateRoot, marker, privateRoot, publicIdentity) {
  const current = readStartPublication(stateRoot, privateRoot, marker);
  if (current) {
    if (!sameStartPublicEntryIdentity(current.public_entry_identity, publicIdentity)) {
      throw operatorError('start_reservation_ambiguous',
        `start publication identity changed: ${startPublicationPath(privateRoot)}`);
    }
    return current;
  }
  const record = startCommitMarker({
    kind: 'deep-evolve-start-publication',
    session_id: marker.session_id,
    request_digest: marker.request_digest,
    reservation_nonce: marker.reservation_nonce,
    namespace_identity: marker.namespace_identity,
    public_entry_identity: publicIdentity,
  });
  const publicationPath = startPublicationPath(privateRoot);
  try {
    writeExclusiveStartMarker(publicationPath, record);
  } catch (error) {
    if (!fs.existsSync(publicationPath)) throw error;
    const raced = readStartPublication(stateRoot, privateRoot, marker);
    if (!raced || raced.marker_checksum !== record.marker_checksum) {
      throw operatorError('start_reservation_ambiguous',
        `start publication path was occupied by a foreign record: ${publicationPath}`);
    }
    return raced;
  }
  return record;
}

function readStartFinalization(stateRoot, privateRoot, marker) {
  const finalPath = startFinalizationPath(privateRoot);
  if (!fs.existsSync(finalPath)) return null;
  const record = readStartCommitRecord(
    stateRoot, finalPath, 'deep-evolve-start-finalization',
  );
  if (record.session_id !== marker.session_id
      || record.request_digest !== marker.request_digest
      || record.reservation_nonce !== marker.reservation_nonce
      || !sameStartNamespaceIdentity(record.namespace_identity, marker.namespace_identity)
      || !plainObject(record.public_entry_identity)
      || !['link', 'directory'].includes(record.public_entry_identity.kind)) {
    throw operatorError('start_reservation_ambiguous',
      `start finalization does not match its reservation: ${finalPath}`);
  }
  return record;
}

function finalizeStartReservation(stateRoot, marker, privateRoot, publicRoot) {
  const current = readStartFinalization(stateRoot, privateRoot, marker);
  if (current) {
    verifyPublicStartNamespace(
      stateRoot, marker, publicRoot, privateRoot, current.public_entry_identity,
    );
    return { record: current, created: false };
  }
  const publicIdentity = verifyPublicStartNamespace(
    stateRoot, marker, publicRoot, privateRoot,
  );
  const publication = persistStartPublication(
    stateRoot, marker, privateRoot, publicIdentity,
  );
  const record = startCommitMarker({
    kind: 'deep-evolve-start-finalization',
    session_id: marker.session_id,
    request_digest: marker.request_digest,
    reservation_nonce: marker.reservation_nonce,
    namespace_identity: marker.namespace_identity,
    public_entry_identity: publication.public_entry_identity,
    retained_evidence: [START_RESERVATION_FILE, START_PUBLICATION_FILE,
      path.basename(startReservationSidecar(stateRoot, marker.session_id, marker.reservation_nonce))],
  });
  const finalPath = startFinalizationPath(privateRoot);
  try {
    writeExclusiveStartMarker(finalPath, record);
  } catch (error) {
    if (!fs.existsSync(finalPath)) throw error;
    const raced = readStartFinalization(stateRoot, privateRoot, marker);
    if (!raced || raced.marker_checksum !== record.marker_checksum) {
      throw operatorError('start_reservation_ambiguous',
        `start finalization path was occupied by a foreign record: ${finalPath}`);
    }
    verifyPublicStartNamespace(
      stateRoot, marker, publicRoot, privateRoot, raced.public_entry_identity,
    );
    return { record: raced, created: false };
  }
  verifyPublicStartNamespace(
    stateRoot, marker, publicRoot, privateRoot, record.public_entry_identity,
  );
  return { record, created: true };
}

function verifyOwnedStartedSessionLink(stateRoot, sessionId, publicRoot, physicalRoot) {
  const reservationRoot = ensureStartReservationDirectory(stateRoot);
  if (!reservationRoot) {
    throw operatorError('session_path_ambiguous',
      `linked session has no ownership evidence: ${sessionId}`);
  }
  const matches = [];
  for (const name of fs.readdirSync(reservationRoot).sort()) {
    if (!name.startsWith(`${sessionId}.`) || !name.endsWith('.json')) continue;
    const candidate = path.join(reservationRoot, name);
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const marker = readStartReservation(stateRoot, candidate);
    if (marker.session_id === sessionId) matches.push(marker);
  }
  if (matches.length !== 1) {
    throw operatorError('session_path_ambiguous',
      `linked session ownership evidence is missing or duplicated: ${sessionId}`);
  }
  const marker = matches[0];
  if (!sameStartNamespaceIdentity(startNamespaceIdentity(physicalRoot), marker.namespace_identity)) {
    throw operatorError('session_path_ambiguous',
      `linked session backing identity changed: ${sessionId}`);
  }
  const publication = readStartPublication(stateRoot, physicalRoot, marker);
  if (!publication) {
    throw operatorError('session_path_ambiguous',
      `linked session has no authenticated publication record: ${sessionId}`);
  }
  const finalized = readStartFinalization(stateRoot, physicalRoot, marker);
  if (finalized && !sameStartPublicEntryIdentity(
    finalized.public_entry_identity, publication.public_entry_identity,
  )) {
    throw operatorError('session_path_ambiguous',
      `linked session publication/finalization identity drifted: ${sessionId}`);
  }
  verifyPublicStartNamespace(
    stateRoot,
    marker,
    publicRoot,
    physicalRoot,
    publication.public_entry_identity,
  );
  return { marker, finalized };
}

function installCommittedStartNamespaceExclusive(stateRoot, marker, inspected, options) {
  const root = path.join(stateRoot, marker.session_id);
  const privateRoot = inspected.root;

  for (const child of START_CHILD_DIRECTORIES) {
    const childPath = path.join(privateRoot, child);
    if (fs.existsSync(childPath)) {
      const stat = fs.lstatSync(childPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw operatorError('start_reservation_ambiguous',
          `committed namespace child is not a private directory: ${childPath}`);
      }
    } else {
      if (!sameStartNamespaceIdentity(startNamespaceIdentity(privateRoot), marker.namespace_identity)) {
        throw operatorError('start_reservation_ambiguous',
          `committed namespace changed before child creation: ${privateRoot}`);
      }
      fs.mkdirSync(childPath);
      invokeStartPhase(options, `after-start-recovery-child:${child}`, {
        sessionId: marker.session_id,
        privateRoot,
        childPath,
      });
    }
  }

  const privateMarkerPath = path.join(privateRoot, START_RESERVATION_FILE);
  if (inspected.markerPath) {
    if (!sameStartReservation(readStartReservation(stateRoot, inspected.markerPath), marker)) {
      throw operatorError('start_reservation_ambiguous',
        `committed namespace marker changed: ${inspected.markerPath}`);
    }
  } else {
    if (!sameStartNamespaceIdentity(startNamespaceIdentity(privateRoot), marker.namespace_identity)) {
      throw operatorError('start_reservation_ambiguous',
        `committed namespace changed before marker creation: ${privateRoot}`);
    }
    writeExclusiveStartMarker(privateMarkerPath, marker);
  }
  invokeStartPhase(options, 'after-start-recovery-marker-durable', {
    sessionId: marker.session_id,
    privateRoot,
    markerPath: privateMarkerPath,
  });

  const sidecars = reservationSidecarCandidates(stateRoot, marker);
  if (sidecars.length !== 1
      || !sameStartReservation(readStartReservation(stateRoot, sidecars[0]), marker)) {
    throw operatorError('start_reservation_ambiguous',
      `start reservation sidecar is missing, duplicated, or changed for ${marker.session_id}`);
  }
  // The sidecar is immutable. Recovery binds it by validation rather than a
  // path-replacing rewrite, so a crash cannot lose the authenticated old inode.
  invokeStartPhase(options, 'after-start-recovery-sidecar-bind', {
    sessionId: marker.session_id,
    privateRoot,
    sidecarPath: sidecars[0],
  });

  if (typeof options.preparePrivate === 'function') {
    options.preparePrivate(privateRoot, marker);
  }

  invokeStartPhase(options, 'before-start-public-recovery-install', {
    sessionId: marker.session_id,
    privateRoot,
    publicRoot: root,
  });
  let publication = readStartPublication(stateRoot, privateRoot, marker);
  let publicIdentity;
  if (publication) {
    publicIdentity = verifyPublicStartNamespace(
      stateRoot, marker, root, privateRoot, publication.public_entry_identity,
    );
  } else if (path.resolve(privateRoot) === path.resolve(root)) {
    publicIdentity = verifyPublicStartNamespace(stateRoot, marker, root, privateRoot);
  } else if (fs.existsSync(root)) {
    throw operatorError('start_reservation_ambiguous',
      `public namespace exists without an authenticated publication record: ${root}`);
  } else {
    publicIdentity = createPublicStartNamespaceExclusive(root, privateRoot);
  }
  if (!publication) {
    publication = persistStartPublication(stateRoot, marker, privateRoot, publicIdentity);
  }
  invokeStartPhase(options, 'after-start-recovery-public-claim', {
    sessionId: marker.session_id,
    privateRoot,
    publicRoot: root,
  });
  verifyPublicStartNamespace(
    stateRoot, marker, root, privateRoot, publication.public_entry_identity,
  );

  // Node 22 has no cross-platform fd-relative unlink/rmdir or directory
  // rename-no-replace primitive. The authenticated private inode therefore
  // remains the live backing store and is durably referenced by the public
  // link, sidecar, and finalization record. Retention is the safe cleanup.
  invokeStartPhase(options, 'before-start-recovery-old-inode-cleanup', {
    sessionId: marker.session_id,
    privateRoot,
    publicRoot: root,
  });
  if (!sameStartNamespaceIdentity(startNamespaceIdentity(privateRoot), marker.namespace_identity)) {
    throw operatorError('start_reservation_ambiguous',
      `authenticated private namespace changed at retention boundary: ${privateRoot}`);
  }
  invokeStartPhase(options, 'after-start-recovery-old-inode-cleanup', {
    sessionId: marker.session_id,
    privateRoot,
    publicRoot: root,
  });
  return { root, privateRoot, marker };
}

function ensureCommittedStartNamespace(stateRoot, marker, options = {}) {
  const inspected = inspectStartNamespace(stateRoot, marker);
  return installCommittedStartNamespaceExclusive(stateRoot, marker, inspected, options);
}

function reservationSidecarCandidates(stateRoot, marker) {
  const normal = startReservationSidecar(stateRoot, marker.session_id, marker.reservation_nonce);
  return fs.existsSync(normal) ? [normal] : [];
}

function recoverStartReservations(project, files, request, options = {}, {
  legacyCollisionSemantics = false,
} = {}) {
  const directory = ensureStartReservationDirectory(project.stateRoot);
  if (!directory) return null;
  let names;
  try { names = fs.readdirSync(directory); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  const records = parseJsonl(files['sessions.jsonl'], 'sessions.jsonl');
  const pointer = files['current.json'] ? parseJson(files['current.json'], 'current.json') : null;
  const sidecars = [];
  const namespaceNames = new Set();
  for (const name of names.sort()) {
    const candidate = path.join(directory, name);
    const stat = fs.lstatSync(candidate);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      namespaceNames.add(name);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || !name.endsWith('.json')) {
      throw operatorError('start_reservation_invalid',
        `unexpected start reservation entry: ${candidate}`);
    }
    const marker = readStartReservation(project.stateRoot, candidate);
    const normal = `${marker.session_id}.${marker.reservation_nonce}.json`;
    if (name !== normal) {
      throw operatorError('start_reservation_invalid',
        `start reservation filename does not match identity: ${candidate}`);
    }
    sidecars.push({ marker, path: candidate });
  }
  const allowedNamespaceNames = new Set();
  for (const { marker } of sidecars) {
    allowedNamespaceNames.add(`.namespace-${marker.reservation_nonce}`);
  }
  for (const name of namespaceNames) {
    if (!allowedNamespaceNames.has(name)) {
      const candidate = path.join(directory, name);
      throw operatorError('start_reservation_invalid',
        `unowned start reservation namespace: ${candidate}`);
    }
  }
  const nonces = new Set();
  let adopted = null;
  for (const { marker } of sidecars) {
    if (nonces.has(marker.reservation_nonce)) {
      throw operatorError('start_reservation_ambiguous',
        `duplicate start reservation sidecar for ${marker.session_id}`);
    }
    nonces.add(marker.reservation_nonce);
    const created = records.find((record) => record.event === 'created'
      && record.session_id === marker.session_id);
    const located = locateStartNamespace(project.stateRoot, marker);
    const finalizedRecord = readStartFinalization(project.stateRoot, located.root, marker);
    const stateRecord = readStartStateCommit(project.stateRoot, located.root, marker);
    if (stateRecord && !finalizedRecord) {
      verifyStartStateFiles(project.stateRoot, located.root, stateRecord);
    }
    const markerInitializationId = marker.initialization_id
      || (stateRecord && stateRecord.initialization_id)
      || null;
    let matches = marker.request_digest === request.requestDigest;
    if (legacyCollisionSemantics && stateRecord && !finalizedRecord) {
      const sessionPath = path.join(located.root, 'session.yaml');
      const pendingSession = validateStoredSession(parseStateDocument(
        readStableStartFile(project.stateRoot, sessionPath).toString('utf8'),
        { sourcePath: sessionPath },
      ));
      assertSessionIdentity(pendingSession, marker.session_id);
      const pendingParent = pendingSession.parent_session === null
        ? null
        : pendingSession.parent_session.id;
      matches = pendingSession.goal === request.goal && pendingParent === request.parent;
    } else if (!legacyCollisionSemantics) {
      if (markerInitializationId === request.initializationId
          && stateRecord && stateRecord.request_digest !== request.requestDigest) {
        throw operatorError('initialization_id_conflict',
          'initialization_id was already committed with different canonical input');
      }
      if (markerInitializationId === request.initializationId
          && marker.initialization_id
          && marker.request_digest !== request.requestDigest) {
        throw operatorError('initialization_id_conflict',
          'initialization_id was already reserved with different canonical input');
      }
      if (markerInitializationId === request.initializationId
          && marker.initial_state_digest
          && marker.initial_state_digest !== request.initialStateDigest) {
        throw operatorError('initialization_id_conflict',
          'initialization_id was already reserved with a different initial_state digest');
      }
      const exactCanonical = markerInitializationId === request.initializationId
        && (marker.request_digest === request.requestDigest
          || (stateRecord && stateRecord.request_digest === request.requestDigest));
      const legacyUpgrade = markerInitializationId === null
        && marker.request_digest === request.legacyRequestDigest;
      matches = exactCanonical || legacyUpgrade;
      if (markerInitializationId !== null
          && markerInitializationId !== request.initializationId
          && !created && !finalizedRecord) {
        throw operatorError('start_reservation_pending',
          `a different start reservation is pending: ${marker.session_id}`);
      }
    }
    if (legacyCollisionSemantics && matches && !stateRecord) {
      throw operatorError('legacy_start_requires_initialization',
        `legacy start reservation requires canonical initial_state: ${marker.session_id}`);
    }
    if (finalizedRecord) {
      inspectFinalizedStartNamespace(project.stateRoot, marker);
      if (!created) {
        throw operatorError('start_reservation_ambiguous',
          `finalized start reservation has no registry event: ${marker.session_id}`);
      }
      if (matches) {
        if (adopted) {
          throw operatorError('start_reservation_ambiguous',
            'multiple matching finalized start reservations exist');
        }
        let startState = null;
        if (!legacyCollisionSemantics) {
          startState = ensureCanonicalStartState(
            project,
            marker,
            located.root,
            request,
            options,
            { verifyFiles: false },
          );
        }
        adopted = {
          session_id: marker.session_id,
          session_root: path.join(project.stateRoot, marker.session_id),
          private_root: located.root,
          marker,
          start_state: startState,
          needs_commit: false,
          replayed: true,
        };
      }
      continue;
    }
    const inspected = inspectStartNamespace(project.stateRoot, marker);
    if (created) {
      if (!stateRecord && !matches) {
        throw operatorError('start_reservation_pending',
          `an initialized state is required before finalizing reservation: ${marker.session_id}`);
      }
      const canAdopt = !adopted
        && matches
        && pointer && pointer.session_id === marker.session_id;
      let startState = null;
      const committedNamespace = ensureCommittedStartNamespace(
        project.stateRoot,
        marker,
        canAdopt && !legacyCollisionSemantics ? {
          ...options,
          preparePrivate(privateRoot) {
            startState = ensureCanonicalStartState(
              project,
              marker,
              privateRoot,
              request,
              options,
            );
          },
        } : options,
      );
      finalizeStartReservation(
        project.stateRoot,
        committedNamespace.marker,
        committedNamespace.privateRoot,
        committedNamespace.root,
      );
      if (canAdopt) adopted = {
        session_id: marker.session_id,
        session_root: committedNamespace.root,
        private_root: committedNamespace.privateRoot,
        marker,
        start_state: startState,
        needs_commit: false,
        replayed: true,
      };
      continue;
    }
    if (!matches) {
      throw operatorError('start_reservation_pending',
        `a different start reservation is pending: ${marker.session_id}`);
    }
    if (adopted) {
      throw operatorError('start_reservation_ambiguous',
        'multiple matching uncommitted start reservations exist');
    }
    let startState = null;
    const preparedNamespace = ensureCommittedStartNamespace(
      project.stateRoot,
      marker,
      legacyCollisionSemantics ? options : {
        ...options,
        preparePrivate(privateRoot) {
          startState = ensureCanonicalStartState(
            project,
            marker,
            privateRoot,
            request,
            options,
          );
        },
      },
    );
    adopted = {
      session_id: marker.session_id,
      session_root: preparedNamespace.root,
      private_root: preparedNamespace.privateRoot,
      marker,
      start_state: startState,
      needs_commit: true,
      replayed: false,
    };
  }
  return adopted;
}

function invokeStartPhase(options, phase, context = {}) {
  if (typeof options.onPhase === 'function') options.onPhase(phase, context);
  if (options.crashAt === phase) process.exit(options.crashExitCode || 86);
}

function startSession(project, payload, dependencies = {}, { legacyCollisionSemantics = false } = {}) {
  const goal = payload.goal === undefined ? '' : requireString(payload.goal, 'payload.goal', { empty: true });
  const parent = payload.parent_session_id === undefined
    ? null
    : ensureSessionId(payload.parent_session_id, 'payload.parent_session_id');
  let initialState = null;
  if (!legacyCollisionSemantics) {
    if (!Object.hasOwn(payload, 'initial_state')) {
      throw operatorError('initial_state_required', 'payload.initial_state is required');
    }
    try { initialState = validateInitialStateSpec(payload.initial_state); }
    catch (error) {
      throw operatorError(error && error.code ? error.code : 'initial_state_invalid',
        error && error.message ? error.message : 'payload.initial_state is invalid');
    }
    ensureStartTargetContainment(project.projectRoot, initialState);
  }
  const timestamp = isoNow(dependencies);
  const requestDigest = startRequestDigest(
    goal,
    parent,
    legacyCollisionSemantics ? undefined : initialState,
  );
  const startRequest = {
    goal,
    parent,
    initialState,
    initializationId: initialState && initialState.initialization_id,
    initialStateDigest: initialState && digestStartBytes(Buffer.from(JSON.stringify(
      canonicalStartValue(initialState),
    ))),
    requestDigest,
    legacyRequestDigest: startRequestDigest(goal, parent),
  };
  const coordinationOptions = legacyCoordinationOptions(dependencies);
  let sessionId;
  let root;
  let privateRoot;
  let reservation;
  let startState = null;
  let replayed = false;
  let adopted = null;
  mutateCoordinationFiles(project.stateRoot, ['current.json', 'sessions.jsonl'], (files) => {
    adopted = recoverStartReservations(project, files, startRequest, coordinationOptions, {
      legacyCollisionSemantics,
    });
    if (adopted) {
      sessionId = adopted.session_id;
      root = adopted.session_root;
      privateRoot = adopted.private_root;
      reservation = adopted.marker;
      startState = adopted.start_state;
      replayed = adopted.replayed === true;
      if (!adopted.needs_commit) return null;
    } else {
      if (legacyCollisionSemantics) {
        sessionId = legacyComputedSessionId(goal, timestamp, files['sessions.jsonl']);
        const directoryBase = sessionId;
        let suffix = 2;
        while (fs.existsSync(path.join(project.stateRoot, sessionId))) {
          sessionId = `${directoryBase}-${suffix}`;
          suffix += 1;
          if (suffix > 1000) throw businessError('session_id_collision', 'session_id collision retry exhausted');
        }
      } else {
        const records = parseJsonl(files['sessions.jsonl'], 'sessions.jsonl');
        sessionId = candidateSessionId(goal, timestamp, records, project.stateRoot);
      }
      root = path.join(project.stateRoot, sessionId);
      if (legacyCollisionSemantics) {
        // The Unix-only 3.4.3 CLI adapter preserves the frozen observable tree
        // exactly. Supported cross-host callers use the canonical dispatcher
        // path below, including the crash-safe publication protocol.
        fs.mkdirSync(root, { mode: 0o700 });
        for (const name of START_CHILD_DIRECTORIES) fs.mkdirSync(path.join(root, name));
        privateRoot = root;
      } else {
        const reservationRoot = ensureStartReservationDirectory(project.stateRoot, { create: true });
        const reservationNonce = crypto.randomBytes(16).toString('hex');
        privateRoot = path.join(reservationRoot, `.namespace-${reservationNonce}`);
        try { fs.mkdirSync(privateRoot, { mode: 0o700 }); }
        catch (error) {
          throw operatorError('start_reservation_install_failed',
            `cannot claim private start namespace: ${error && error.code ? error.code : 'unknown'}`);
        }
        const namespaceIdentity = startNamespaceIdentity(privateRoot);
        reservation = startCommitMarker({
          kind: 'deep-evolve-start-reservation',
          session_id: sessionId,
          request_digest: requestDigest,
          created_at: timestamp,
          reservation_nonce: reservationNonce,
          namespace_identity: namespaceIdentity,
          expected_children: START_CHILD_DIRECTORIES,
          ...(!legacyCollisionSemantics ? {
            initialization_id: initialState.initialization_id,
            initial_state_digest: startRequest.initialStateDigest,
          } : {}),
        });
        writeExclusiveStartMarker(
          startReservationSidecar(project.stateRoot, sessionId, reservationNonce), reservation,
        );
        invokeStartPhase(coordinationOptions, 'after-start-root-before-marker', {
          sessionId, root: privateRoot, publicRoot: root,
        });
        writeExclusiveStartMarker(path.join(privateRoot, START_RESERVATION_FILE), reservation);
        invokeStartPhase(coordinationOptions, 'after-start-root', {
          sessionId, root: privateRoot, publicRoot: root,
        });
        for (const name of START_CHILD_DIRECTORIES) fs.mkdirSync(path.join(privateRoot, name));
        invokeStartPhase(coordinationOptions, 'after-start-children', {
          sessionId, root: privateRoot, publicRoot: root,
        });
        startState = ensureCanonicalStartState(
          project,
          reservation,
          privateRoot,
          startRequest,
          coordinationOptions,
        );
        if (!sameStartNamespaceIdentity(startNamespaceIdentity(privateRoot), namespaceIdentity)) {
          throw operatorError('start_reservation_ambiguous',
            `private session namespace changed during install: ${privateRoot}`);
        }
        invokeStartPhase(coordinationOptions, 'before-start-public-install', {
          sessionId,
          privateRoot,
          publicRoot: root,
        });
        const publicIdentity = createPublicStartNamespaceExclusive(root, privateRoot);
        const publication = persistStartPublication(
          project.stateRoot, reservation, privateRoot, publicIdentity,
        );
        invokeStartPhase(coordinationOptions, 'after-start-public-claim', {
          sessionId,
          privateRoot,
          publicRoot: root,
        });
        verifyPublicStartNamespace(
          project.stateRoot,
          reservation,
          root,
          privateRoot,
          publication.public_entry_identity,
        );
      }
    }
    const eventTimestamp = reservation ? reservation.created_at : timestamp;
    const event = {
      event: 'created',
      ts: eventTimestamp,
      session_id: sessionId,
      goal,
      status: 'initializing',
    };
    if (parent) event.parent_session_id = parent;
    return {
      'current.json': jsonLine({ session_id: sessionId, started_at: eventTimestamp }),
      'sessions.jsonl': appendJsonLine(files['sessions.jsonl'], event),
    };
  }, coordinationOptions);
  if (reservation && privateRoot) {
    finalizeStartReservation(project.stateRoot, reservation, privateRoot, root);
    invokeStartPhase(coordinationOptions, 'after-start-finalization', {
      sessionId,
      privateRoot,
      publicRoot: root,
    });
  }
  if (legacyCollisionSemantics) return { session_id: sessionId, session_root: root };
  if (!startState) {
    startState = ensureCanonicalStartState(
      project,
      reservation,
      privateRoot,
      startRequest,
      coordinationOptions,
      { verifyFiles: !replayed },
    );
  }
  const sessionBytes = readStableStartFile(project.stateRoot, path.join(privateRoot, 'session.yaml'));
  const session = validateStoredSession(parseStateDocument(sessionBytes.toString('utf8'), {
    sourcePath: path.join(privateRoot, 'session.yaml'),
  }));
  assertSessionIdentity(session, sessionId);
  return {
    session_id: sessionId,
    session_root: root,
    session,
    session_sha256: digestStartBytes(sessionBytes),
    initialization_id: initialState.initialization_id,
    replayed,
  };
}

function updateSessionStatus(project, sessionId, status, eventKind, dependencies = {}, extras = {}) {
  if (!STATUS_VALUES.has(status)) throw operatorError('invalid_status', `invalid session status ${JSON.stringify(status)}`);
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  let session;
  mutateCoordinationFiles(project.stateRoot, [info.relativeSession, 'sessions.jsonl'], (files) => {
    if (!files[info.relativeSession]) throw businessError('session_missing', `session.yaml missing for ${sessionId}`);
    session = validateStoredSession(parseStateDocument(files[info.relativeSession], { sourcePath: info.sessionPath }));
    assertSessionIdentity(session, info.sessionId);
    session = { ...session, status };
    validateStoredSession(session);
    const event = {
      event: eventKind,
      ts: isoNow(dependencies),
      session_id: sessionId,
      status,
      ...extras,
    };
    return {
      [info.relativeSession]: serializeStateDocument(session),
      'sessions.jsonl': appendJsonLine(files['sessions.jsonl'], event),
    };
  });
  return session;
}

function appendRegistryEvent(project, eventName, sessionId, extras, dependencies = {}) {
  let record;
  mutateCoordinationFiles(project.stateRoot, ['sessions.jsonl'], (files) => {
    parseJsonl(files['sessions.jsonl'], 'sessions.jsonl');
    record = { event: eventName, ts: isoNow(dependencies), session_id: sessionId, ...extras };
    return { 'sessions.jsonl': appendJsonLine(files['sessions.jsonl'], record) };
  });
  return record;
}

const PATCH_RULES = Object.freeze({
  '/goal': (value) => typeof value === 'string',
  '/status': (value) => STATUS_VALUES.has(value),
  '/eval_mode': (value) => value === 'cli' || value === 'protocol',
  '/metric/current': Number.isFinite,
  '/metric/best': Number.isFinite,
  '/outer_loop/generation': (value) => Number.isInteger(value) && value >= 0,
  '/evaluation_epoch/current': (value) => Number.isInteger(value) && value >= 0,
  '/lineage/current_branch': (value) => typeof value === 'string' && value.length > 0,
  '/virtual_parallel/N': (value) => Number.isInteger(value) && value >= 1 && value <= 9,
  '/virtual_parallel/n_current': (value) => Number.isInteger(value) && value >= 1 && value <= 9,
  '/virtual_parallel/budget_unallocated': (value) => Number.isInteger(value) && value >= 0,
  '/virtual_parallel/unallocated_pool': (value) => Number.isFinite(value) && value >= 0,
  '/virtual_parallel/enabled': (value) => typeof value === 'boolean',
  '/final_strategy': (value) => typeof value === 'string' || value === null,
  '/transfer': (value) => plainObject(value) || value === null,
});

function applyPointerPatch(session, pointer, value) {
  const validator = PATCH_RULES[pointer];
  if (!validator) throw operatorError('patch_path_not_allowed', `patch path is not allowed: ${pointer}`);
  if (!validator(value)) throw operatorError('patch_type_invalid', `replacement type is invalid for ${pointer}`);
  assertPlainTree(value, 'payload.value');
  const next = structuredClone(session);
  const parts = pointer.slice(1).split('/');
  let target = next;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (target[key] === undefined) target[key] = {};
    if (!plainObject(target[key])) throw operatorError('patch_parent_invalid', `patch parent ${key} is not an object`);
    target = target[key];
  }
  target[parts.at(-1)] = structuredClone(value);
  return next;
}

function rejectSymlinks(root, candidate) {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) throw operatorError('migration_symlink_rejected', `migration source is a symlink: ${candidate}`);
  if (!isPathInside(root, path.resolve(candidate))) throw operatorError('migration_path_escape', 'migration source escapes state root');
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(candidate)) rejectSymlinks(root, path.join(candidate, name));
  }
}

function collectMigrationEntries(candidate) {
  const entries = [];
  function visit(current, relative) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw operatorError('migration_symlink_rejected', `migration path is a symlink: ${current}`);
    }
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: 'directory' });
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    if (!stat.isFile()) throw operatorError('migration_special_file_rejected', `migration path is not a regular file: ${current}`);
    const bytes = fs.readFileSync(current);
    entries.push({
      path: relative,
      type: 'file',
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  }
  visit(candidate, '');
  return entries;
}

function migrationManifestChecksum(value) {
  const { manifest_checksum: ignored, ...body } = value;
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
}

function migrationDestinationEntries(sources) {
  const entries = new Map([['meta-analyses', { path: 'meta-analyses', type: 'directory' }]]);
  for (const source of sources) {
    for (const entry of source.entries) {
      const relative = entry.path
        ? `${source.destination_relative}/${entry.path}`
        : source.destination_relative;
      entries.set(relative, { ...entry, path: relative });
      let parent = path.posix.dirname(relative);
      while (parent !== '.') {
        if (!entries.has(parent)) entries.set(parent, { path: parent, type: 'directory' });
        parent = path.posix.dirname(parent);
      }
    }
  }
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function readMigrationManifest(manifestPath) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { throw operatorError('migration_manifest_invalid', `migration manifest is unreadable: ${manifestPath}`); }
  if (!plainObject(manifest)
      || manifest.schema_version !== '1.0'
      || !Array.isArray(manifest.sources)
      || manifest.manifest_checksum !== migrationManifestChecksum(manifest)) {
    throw operatorError('migration_manifest_invalid', `migration manifest is invalid: ${manifestPath}`);
  }
  return manifest;
}

function migrationTreeMatches(candidate, expected) {
  if (!fs.existsSync(candidate)) return false;
  try { return JSON.stringify(collectMigrationEntries(candidate)) === JSON.stringify(expected); }
  catch { return false; }
}

function migrationClaimIdentity(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    birthtimeNs: stat.birthtimeNs,
  };
}

function sameMigrationClaimIdentity(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function inspectMigrationClaim(candidate, expected) {
  if (!fs.existsSync(candidate)) return { matches: false, identity: null };
  try {
    const before = migrationClaimIdentity(candidate);
    const entries = collectMigrationEntries(candidate);
    const after = migrationClaimIdentity(candidate);
    return {
      matches: sameMigrationClaimIdentity(before, after)
        && JSON.stringify(entries) === JSON.stringify(expected),
      identity: after,
    };
  } catch {
    return { matches: false, identity: null };
  }
}

function migrationDestinationMatches(destination, manifest) {
  if (!fs.existsSync(destination)) return false;
  let actual;
  try {
    actual = collectMigrationEntries(destination)
      .filter((entry) => entry.path !== '')
      .sort((left, right) => left.path.localeCompare(right.path));
  } catch { return false; }
  return JSON.stringify(actual) === JSON.stringify(manifest.destination_entries);
}

function migrationSleep(dependencies, attempt) {
  if (dependencies.sleep) dependencies.sleep(attempt);
  else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(20 * attempt, 100));
}

function migrationIo(action, dependencies = {}, { attempts = 5 } = {}) {
  const transient = new Set(['EACCES', 'EBUSY', 'EPERM']);
  for (let attempt = 1; ; attempt += 1) {
    try { return action(); }
    catch (error) {
      if (attempt >= attempts || !transient.has(error && error.code)) throw error;
      migrationSleep(dependencies, attempt);
    }
  }
}

function migrationStorageOptions(dependencies = {}, extra = {}) {
  const options = {
    io: dependencies.migrationIo || fs,
    platform: dependencies.platform || process.platform,
    onDiagnostic: dependencies.onMigrationDiagnostic || (() => {}),
    ...extra,
  };
  if (dependencies.sleep) options.sleep = dependencies.sleep;
  return options;
}

function migrationRename(from, to, dependencies = {}) {
  const rename = dependencies.migrationRename
    || (dependencies.migrationIo && dependencies.migrationIo.renameSync)
    || fs.renameSync;
  return migrationIo(() => rename(from, to), dependencies);
}

function migrationRemove(target, options, dependencies = {}) {
  const remove = dependencies.migrationRemove
    || (dependencies.migrationIo && dependencies.migrationIo.rmSync)
    || fs.rmSync;
  return migrationIo(() => remove(target, options), dependencies);
}

function migrationPhase(dependencies, phase, context = {}) {
  if (dependencies.onMigrationPhase) dependencies.onMigrationPhase(phase, context);
}

function stageMigrationPath(sourcePath, destinationPath, dependencies = {}) {
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) {
    throw operatorError('migration_symlink_rejected', `migration path is a symlink: ${sourcePath}`);
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true, mode: stat.mode & 0o777 });
    for (const name of fs.readdirSync(sourcePath).sort()) {
      stageMigrationPath(path.join(sourcePath, name), path.join(destinationPath, name), dependencies);
    }
    return;
  }
  if (!stat.isFile()) {
    throw operatorError('migration_special_file_rejected', `migration path is not a regular file: ${sourcePath}`);
  }
  atomicWriteFile(destinationPath, fs.readFileSync(sourcePath), migrationStorageOptions(dependencies, {
    mode: stat.mode & 0o777,
  }));
  migrationPhase(dependencies, `after-stage-file-flush:${path.basename(destinationPath)}`, {
    source_path: sourcePath,
    staged_path: destinationPath,
  });
}

function migrationRegistryText(text, manifest) {
  const records = parseJsonl(text, 'sessions.jsonl');
  if (records.some((record) => record.event === 'migrated' && record.session_id === manifest.session_id)) {
    return text;
  }
  return appendJsonLine(text, {
    event: 'migrated',
    ts: manifest.timestamp,
    session_id: manifest.session_id,
    from: 'flat_layout',
    status: manifest.status,
    goal: manifest.goal,
    legacy_recovery: 'unavailable',
  });
}

function installMigrationRegistry(project, manifest) {
  mutateCoordinationFiles(project.stateRoot, ['current.json', 'sessions.jsonl'], (files, snapshot) => {
    if (snapshot.exists['current.json']) {
      throw businessError('legacy_became_active', 'current.json appeared during legacy migration');
    }
    const next = migrationRegistryText(files['sessions.jsonl'], manifest);
    if (next === files['sessions.jsonl']) return null;
    return { 'sessions.jsonl': next };
  });
}

function migrationCleanupClaimPath(project, source, manifest) {
  const sourcePath = path.join(project.stateRoot, ...source.source_relative.split('/'));
  const expectedPrefix = `.${path.basename(sourcePath)}.migration-cleanup-claim-`;
  const fallbackIdentity = crypto.createHash('sha256')
    .update(`${manifest.transaction_id}\0${source.source_relative}`)
    .digest('hex').slice(0, 16);
  const claimName = source.cleanup_claim_name || `${expectedPrefix}${fallbackIdentity}`;
  if (path.basename(claimName) !== claimName
      || !claimName.startsWith(expectedPrefix)
      || !/^[A-Za-z0-9._-]+$/.test(claimName)) {
    throw operatorError('migration_manifest_invalid', `invalid cleanup claim for ${source.source_relative}`);
  }
  return path.join(path.dirname(sourcePath), claimName);
}

function cleanupMigrationSources(project, txDir, manifest, dependencies = {}) {
  const warnings = [];
  for (const source of manifest.sources) {
    const sourcePath = path.join(project.stateRoot, ...source.source_relative.split('/'));
    const claimPath = migrationCleanupClaimPath(project, source, manifest);
    if (!fs.existsSync(claimPath) && fs.existsSync(sourcePath)) {
      const claimContext = { source_path: sourcePath, claim_path: claimPath };
      migrationPhase(dependencies, `before-source-cleanup:${path.posix.basename(source.source_relative)}`, claimContext);
      migrationPhase(dependencies, `before-source-claim:${path.posix.basename(source.source_relative)}`, claimContext);
      try {
        migrationRename(sourcePath, claimPath, dependencies);
      } catch (error) {
        warnings.push({
          code: 'migration_cleanup_pending',
          source: source.source_relative,
          reason: 'source_claim_failed',
          error_code: error && error.code,
        });
        continue;
      }
      migrationPhase(dependencies, `after-source-claim:${path.posix.basename(source.source_relative)}`, claimContext);
    }

    if (!fs.existsSync(claimPath)) continue;
    const verifiedClaim = inspectMigrationClaim(claimPath, source.entries);
    if (!verifiedClaim.matches) {
      warnings.push({
        code: 'migration_cleanup_pending',
        source: source.source_relative,
        reason: 'source_identity_changed',
        recovery_path: claimPath,
      });
      continue;
    }
    const deleteContext = { source_path: sourcePath, claim_path: claimPath };
    let cleanupWarning = null;
    const lockOptions = { platform: dependencies.platform || process.platform };
    if (dependencies.sleep) lockOptions.sleep = dependencies.sleep;
    const cleanup = withDirectoryLock(path.join(project.stateRoot, '.coordination-lock'), () => {
      migrationPhase(dependencies,
        `before-source-claim-delete:${path.posix.basename(source.source_relative)}`, deleteContext);
      const rebound = inspectMigrationClaim(claimPath, source.entries);
      if (!rebound.matches || !sameMigrationClaimIdentity(verifiedClaim.identity, rebound.identity)) {
        cleanupWarning = {
          code: 'migration_cleanup_pending',
          source: source.source_relative,
          reason: 'private_claim_identity_changed',
          recovery_path: claimPath,
        };
        return false;
      }
      try {
        // Node has no object-bound unlink/rm primitive. The identity+manifest
        // rebind is therefore intentionally the final cooperative-workspace
        // check immediately before pathname removal; the last scheduler gap is
        // a documented platform limitation, not an object-ownership claim.
        migrationRemove(claimPath, { recursive: true, force: true }, dependencies);
        return true;
      } catch (error) {
        cleanupWarning = {
          code: 'migration_cleanup_pending',
          source: source.source_relative,
          reason: 'private_claim_cleanup_failed',
          recovery_path: claimPath,
          error_code: error && error.code,
        };
        return false;
      }
    }, lockOptions);
    if (cleanup && cleanup.ok === false) {
      cleanupWarning = {
        code: 'migration_cleanup_pending',
        source: source.source_relative,
        reason: 'coordination_lock_held',
        recovery_path: claimPath,
      };
    }
    if (cleanupWarning) {
      warnings.push(cleanupWarning);
      continue;
    }
    if (cleanup !== true) {
      warnings.push({
        code: 'migration_cleanup_pending',
        source: source.source_relative,
        reason: 'private_claim_cleanup_incomplete',
        recovery_path: claimPath,
      });
      continue;
    }
    migrationPhase(dependencies, `after-source-cleanup:${path.posix.basename(source.source_relative)}`, deleteContext);
    if (fs.existsSync(sourcePath)) {
      warnings.push({
        code: 'migration_cleanup_pending',
        source: source.source_relative,
        reason: 'source_identity_changed',
      });
    }
  }
  if (warnings.length === 0) {
    try {
      migrationRemove(txDir, { recursive: true, force: true }, dependencies);
    } catch (error) {
      warnings.push({
        code: 'migration_housekeeping_pending',
        target: 'transaction_directory',
        recovery_path: txDir,
        error_code: error && error.code,
      });
    }
  }
  return warnings;
}

function recoverMigrationTransaction(project, txDir, dependencies = {}) {
  const manifest = readMigrationManifest(path.join(txDir, 'migration.json'));
  const destination = path.join(project.stateRoot, manifest.destination_name);
  const stage = path.join(txDir, 'stage');
  const quarantine = path.join(txDir, 'quarantine');
  const markerPath = path.join(txDir, 'commit.json');
  let marker = null;
  if (fs.existsSync(markerPath)) {
    try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); }
    catch { throw operatorError('migration_commit_invalid', `migration commit marker is unreadable: ${markerPath}`); }
    const checked = validateCommitMarker(marker);
    if (!checked.valid
        || marker.kind !== 'legacy-migration'
        || marker.manifest_checksum !== manifest.manifest_checksum
        || marker.session_id !== manifest.session_id) {
      throw operatorError('migration_commit_invalid', `migration commit marker is invalid: ${markerPath}`);
    }
  }
  if (!marker) {
    if (fs.existsSync(stage)) migrationRemove(stage, { recursive: true, force: true }, dependencies);
    if (!manifest.destination_preexisting && fs.existsSync(destination)) {
      if (!migrationDestinationMatches(destination, manifest)) {
        throw operatorError('migration_rollback_ambiguous', `uncommitted destination identity changed: ${destination}`);
      }
      migrationRemove(destination, { recursive: true, force: true }, dependencies);
    }
    if (fs.existsSync(quarantine)) {
      if (fs.existsSync(destination)) {
        if (!migrationDestinationMatches(destination, manifest)) {
          throw operatorError('migration_rollback_ambiguous', `uncommitted destination identity changed: ${destination}`);
        }
        migrationRemove(destination, { recursive: true, force: true }, dependencies);
      }
      migrationRename(quarantine, destination, dependencies);
    }
    migrationRemove(txDir, { recursive: true, force: true }, dependencies);
    return { committed: false, warnings: [], manifest };
  }
  if (!migrationDestinationMatches(destination, manifest)) {
    throw operatorError('migration_destination_invalid', `committed migration destination failed verification: ${destination}`);
  }
  installMigrationRegistry(project, manifest);
  const warnings = cleanupMigrationSources(project, txDir, manifest, dependencies);
  return { committed: true, warnings, manifest };
}

function recoverMigrations(project, dependencies = {}) {
  const root = path.join(project.stateRoot, '.migration-transactions');
  if (!fs.existsSync(root)) return { recovered: 0, warnings: [], committed: [] };
  const lockPath = path.join(project.stateRoot, '.legacy-migration-lock');
  const outcome = withDirectoryLock(lockPath, () => {
    const warnings = [];
    const committed = [];
    let recovered = 0;
    for (const name of fs.readdirSync(root).sort()) {
      const txDir = path.join(root, name);
      if (!fs.lstatSync(txDir).isDirectory()) {
        throw operatorError('migration_transaction_invalid', `unexpected migration transaction entry: ${txDir}`);
      }
      const transaction = recoverMigrationTransaction(project, txDir, dependencies);
      warnings.push(...transaction.warnings);
      if (transaction.committed) committed.push(transaction);
      recovered += 1;
    }
    return { recovered, warnings, committed };
  });
  if (outcome && outcome.ok === false) {
    throw businessError('migration_lock_held', 'legacy migration recovery is already running');
  }
  return outcome;
}

function migrationSources(project, dependencies = {}) {
  const sources = [];
  for (const name of SESSION_FILES) {
    const source = path.join(project.stateRoot, name);
    if (fs.existsSync(source)) sources.push({ source_relative: name, destination_relative: name });
  }
  for (const name of SESSION_DIRECTORIES) {
    const source = path.join(project.stateRoot, name);
    if (fs.existsSync(source)) sources.push({ source_relative: name, destination_relative: name });
  }
  if (fs.existsSync(path.join(project.stateRoot, 'meta-analysis.md'))) {
    sources.push({ source_relative: 'meta-analysis.md', destination_relative: 'meta-analyses/gen-legacy.md' });
  }
  return sources.map((source) => {
    const sourcePath = path.join(project.stateRoot, source.source_relative);
    rejectSymlinks(project.stateRoot, sourcePath);
    const claimNonce = dependencies.migrationClaimNonce
      ? dependencies.migrationClaimNonce(source.source_relative)
      : crypto.randomBytes(16).toString('hex');
    if (typeof claimNonce !== 'string' || !/^[A-Za-z0-9_-]{16,}$/.test(claimNonce)) {
      throw operatorError('migration_claim_nonce_invalid', 'migration cleanup claim nonce is invalid');
    }
    return {
      ...source,
      cleanup_claim_name: `.${path.basename(sourcePath)}.migration-cleanup-claim-${claimNonce}`,
      entries: collectMigrationEntries(sourcePath),
    };
  });
}

function migrateLegacyUnlocked(project, dependencies = {}, locked = null) {
  const flatSession = path.join(project.stateRoot, 'session.yaml');
  const currentPath = path.join(project.stateRoot, 'current.json');
  const flatExists = locked ? locked.exists['session.yaml'] : fs.existsSync(flatSession);
  const currentExists = locked ? locked.exists['current.json'] : fs.existsSync(currentPath);
  if (!flatExists || currentExists) {
    throw businessError('no_legacy_layout', 'no legacy layout to migrate');
  }
  rejectSymlinks(project.stateRoot, flatSession);
  const flatText = locked ? locked.files['session.yaml'] : fs.readFileSync(flatSession, 'utf8');
  const parsed = parseStateDocument(flatText, { sourcePath: flatSession });
  if (!plainObject(parsed)) throw operatorError('migration_state_invalid', 'legacy session.yaml must contain a mapping');
  const timestamp = isoNow(dependencies);
  const goal = typeof parsed.goal === 'string' && parsed.goal ? parsed.goal : 'unknown';
  const sessionId = `legacy-${timestamp.replace(/:/g, '-')}_${computeSlug(goal, timestamp)}`;
  const destination = path.join(project.stateRoot, sessionId);
  const sources = migrationSources(project, dependencies);
  const originalStatus = typeof parsed.status === 'string' ? parsed.status : 'legacy';
  const status = originalStatus === 'completed' || originalStatus === 'aborted' ? originalStatus : 'archived';
  const txRoot = path.join(project.stateRoot, '.migration-transactions');
  const txDir = path.join(txRoot, sessionId);
  if (fs.existsSync(txDir)) throw operatorError('migration_transaction_exists', `migration transaction already exists: ${txDir}`);
  fs.mkdirSync(txDir, { recursive: true });

  const destinationPreexisting = fs.existsSync(destination);
  const manifestBody = {
    schema_version: '1.0',
    kind: 'legacy-migration',
    transaction_id: sessionId,
    timestamp,
    session_id: sessionId,
    destination_name: sessionId,
    destination_preexisting: destinationPreexisting,
    goal,
    status,
    sources,
    destination_entries: migrationDestinationEntries(sources),
  };
  const manifest = { ...manifestBody, manifest_checksum: migrationManifestChecksum(manifestBody) };
  atomicWriteFile(path.join(txDir, 'migration.json'), `${JSON.stringify(manifest, null, 2)}\n`,
    migrationStorageOptions(dependencies));
  migrationPhase(dependencies, 'after-migration-manifest');

  let reuseDestination = destinationPreexisting && migrationDestinationMatches(destination, manifest);
  const quarantine = path.join(txDir, 'quarantine');
  if (destinationPreexisting && !reuseDestination) migrationRename(destination, quarantine, dependencies);
  if (!reuseDestination) {
    const stage = path.join(txDir, 'stage');
    fs.mkdirSync(path.join(stage, 'meta-analyses'), { recursive: true });
    for (const source of sources) {
      const from = path.join(project.stateRoot, ...source.source_relative.split('/'));
      const to = path.join(stage, ...source.destination_relative.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      stageMigrationPath(from, to, dependencies);
      migrationPhase(dependencies, `after-copy:${path.posix.basename(source.source_relative)}`);
    }
    if (!migrationDestinationMatches(stage, manifest)) {
      throw operatorError('migration_verification_failed', 'migration staging copy failed verification');
    }
    migrationPhase(dependencies, 'after-copy-verification');
    migrationRename(stage, destination, dependencies);
    syncRenamedDirectoryBestEffort(path.dirname(destination), dependencies.platform || process.platform,
      migrationStorageOptions(dependencies));
    migrationPhase(dependencies, 'after-destination-install-sync', { destination });
  }
  if (!migrationDestinationMatches(destination, manifest)) {
    throw operatorError('migration_verification_failed', 'migration destination failed verification');
  }
  persistCommitMarker(path.join(txDir, 'commit.json'), {
    kind: 'legacy-migration',
    transaction_id: sessionId,
    manifest_checksum: manifest.manifest_checksum,
    session_id: sessionId,
    committed_at: isoNow(dependencies),
  }, migrationStorageOptions(dependencies));
  migrationPhase(dependencies, 'after-migration-commit-marker');
  let registryText = null;
  let warnings = [];
  if (locked) registryText = migrationRegistryText(locked.files['sessions.jsonl'], manifest);
  else {
    installMigrationRegistry(project, manifest);
    migrationPhase(dependencies, 'after-registry-install');
    warnings = cleanupMigrationSources(project, txDir, manifest, dependencies);
  }
  return {
    result: { session_id: sessionId, session_root: destination, status },
    warnings,
    manifest,
    registryText,
    txDir,
  };
}

function migrateLegacy(project, dependencies = {}) {
  const lockPath = path.join(project.stateRoot, '.legacy-migration-lock');
  const outcome = withDirectoryLock(lockPath, () => {
    let staged;
    mutateCoordinationFiles(
      project.stateRoot,
      ['session.yaml', 'current.json', 'sessions.jsonl'],
      (files, snapshot) => {
        staged = migrateLegacyUnlocked(project, dependencies, { files, exists: snapshot.exists });
        return { 'sessions.jsonl': staged.registryText };
      },
      legacyCoordinationOptions(dependencies),
    );
    migrationPhase(dependencies, 'after-registry-install');
    const warnings = cleanupMigrationSources(project, staged.txDir, staged.manifest, dependencies);
    return { result: staged.result, warnings };
  });
  if (outcome && outcome.ok === false) throw businessError('migration_lock_held', 'legacy migration is already running');
  return outcome;
}

function strictReceiptPath(info, reference, label) {
  if (!plainObject(reference)
      || typeof reference.relative_path !== 'string'
      || reference.relative_path.length === 0
      || !ARTIFACT_DIGEST_RE.test(reference.sha256 || '')) {
    throw operatorError('receipt_reference_missing',
      `${label} has no valid strict completion reference`);
  }
  const relative = reference.relative_path.split('/').join(path.sep);
  if (path.isAbsolute(relative)) {
    throw operatorError('receipt_path_escape', `${label} reference must be session-relative`);
  }
  const receiptPath = path.resolve(info.sessionRoot, relative);
  if (!isPathInside(info.sessionRoot, receiptPath) || receiptPath === info.sessionRoot) {
    throw operatorError('receipt_path_escape', `${label} reference escapes its session`);
  }
  let current = info.sessionRoot;
  const components = path.relative(info.sessionRoot, receiptPath).split(path.sep);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error && error.code === 'ENOENT') {
        throw operatorError('receipt_missing', `${label} not found: ${receiptPath}`);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw operatorError('receipt_path_escape', `${label} path contains a symlink`);
    }
    if (index < components.length - 1 && !stat.isDirectory()) {
      throw operatorError('receipt_path_escape', `${label} parent is not a directory`);
    }
    if (index === components.length - 1 && !stat.isFile()) {
      throw operatorError('receipt_path_escape', `${label} is not a regular file`);
    }
    const resolved = fs.realpathSync(current);
    if (!isPathInside(info.sessionRoot, resolved)) {
      throw operatorError('receipt_path_escape', `${label} resolves outside its session`);
    }
  }
  return receiptPath;
}

function readReceipt(project, sessionId, label = 'receipt') {
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  let receiptPath;
  let expectedDigest = null;
  let receiptBytes;
  mutateCoordinationFiles(project.stateRoot, [info.relativeSession], (files) => {
    const compatible = parseCompatibleSessionText(
      files[info.relativeSession], info.sessionPath, info.sessionId,
    );
    if (isStrictSessionVersion(compatible.deep_evolve_version)) {
      const strict = parseSessionText(files[info.relativeSession], info.sessionPath);
      assertSessionIdentity(strict, info.sessionId);
      if (strict.status !== 'completed' || !plainObject(strict.completion)) {
        throw operatorError('receipt_reference_missing',
          `${label} strict session is not completed with a receipt reference`);
      }
      receiptPath = strictReceiptPath(info, strict.completion.receipt, label);
      expectedDigest = strict.completion.receipt.sha256;
    } else {
      receiptPath = path.join(info.sessionRoot, RECEIPT_FILE);
      if (!fs.existsSync(receiptPath)) {
        throw operatorError('receipt_missing', `${label} not found: ${receiptPath}`);
      }
      const stat = fs.lstatSync(receiptPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw operatorError('receipt_path_escape', `${label} must be a regular file`);
      }
    }
    let stable;
    try {
      stable = stableReadRegular(receiptPath, {
        missingCode: 'receipt_missing',
        symlinkCode: 'receipt_path_escape',
        invalidCode: 'receipt_path_escape',
        changedCode: 'receipt_changed_during_read',
        label,
      });
    } catch (error) {
      if (error && error.rc) throw error;
      throw operatorError('receipt_changed_during_read',
        `${label} changed during authentication`);
    }
    if (expectedDigest && stable.sha256 !== expectedDigest) {
      throw operatorError('receipt_digest_mismatch',
        `${label} does not match its recorded completion digest`);
    }
    receiptBytes = stable.bytes;
    return null;
  });
  let root;
  try { root = JSON.parse(receiptBytes.toString('utf8')); }
  catch { throw operatorError('invalid_receipt_json', `${label} is not valid JSON`); }
  if (!plainObject(root)) throw operatorError('invalid_receipt', `${label} must be a JSON object`);
  assertPlainTree(root, label);
  const envelope = root.envelope;
  const payload = root.payload;
  const unwrapped = root.schema_version === '1.0'
    && plainObject(envelope)
    && plainObject(payload)
    && envelope.producer === 'deep-evolve'
    && envelope.artifact_kind === 'evolve-receipt'
    && plainObject(envelope.schema)
    && envelope.schema.name === envelope.artifact_kind
    ? payload
    : root;
  return { info, receiptPath, receipt: unwrapped };
}

function archiveEntry(receipt, dependencies = {}) {
  const experiments = plainObject(receipt.experiments) ? receipt.experiments : {};
  const score = plainObject(receipt.score) ? receipt.score : {};
  const evolution = plainObject(receipt.strategy_evolution) ? receipt.strategy_evolution : {};
  const total = Number.isFinite(experiments.total) ? experiments.total : null;
  const kept = Number.isFinite(experiments.kept) ? experiments.kept : null;
  const trajectory = Array.isArray(evolution.q_trajectory)
    ? evolution.q_trajectory.map((entry) => (plainObject(entry) ? entry.Q : entry)).filter(Number.isFinite)
    : [];
  return {
    session_id: receipt.session_id ?? null,
    goal: receipt.goal ?? null,
    started_at: receipt.timestamp ?? null,
    finished_at: isoNow(dependencies),
    status: receipt.outcome ?? null,
    outcome: receipt.outcome ?? null,
    parent_session_id: plainObject(receipt.parent_session) ? (receipt.parent_session.id ?? null) : null,
    experiments: {
      total,
      kept,
      keep_rate: total === null || kept === null ? null : kept / (total === 0 ? 1 : total),
    },
    score: {
      baseline: score.baseline ?? null,
      best: score.best ?? null,
      improvement_pct: score.improvement_pct ?? null,
    },
    q_trajectory: trajectory,
    generations: evolution.outer_loop_generations ?? null,
  };
}

function appendLocalArchive(project, sessionId, dependencies = {}) {
  const { receipt } = readReceipt(project, sessionId);
  const entry = archiveEntry(receipt, dependencies);
  const archivePath = path.join(project.stateRoot, 'meta-archive-local.jsonl');
  const lockPath = path.join(project.stateRoot, '.meta-archive-lock');
  const result = withDirectoryLock(lockPath, () => {
    let current = '';
    try { current = fs.readFileSync(archivePath, 'utf8'); }
    catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    atomicWriteFile(archivePath, appendJsonLine(current, entry));
    return true;
  });
  if (result && result.ok === false) throw operatorError('lock_held', 'meta archive lock is held');
  return { archive_path: archivePath, entry };
}

function renderInheritedContext(project, parentSessionId) {
  const { receipt } = readReceipt(project, parentSessionId, 'parent receipt');
  const snapshots = Array.isArray(receipt.generation_snapshots) ? receipt.generation_snapshots : [];
  const last = plainObject(snapshots.at(-1)) ? snapshots.at(-1) : {};
  const strategy = typeof last.strategy_yaml_content === 'string'
    ? last.strategy_yaml_content.split(/\r?\n/).filter((line) => /^[a-z].*:/.test(line)).slice(0, 5).map((line) => `- ${line}`).join('\n')
    : '(전략 스냅샷 없음)';
  const keeps = Array.isArray(receipt.notable_keeps) ? receipt.notable_keeps : [];
  const notable = keeps.length
    ? keeps.map((keep) => `- commit ${keep.commit} (Δ+${keep.score_delta}, source=${keep.source}): ${keep.description}`).join('\n')
    : '(notable keeps 없음)';
  const lesson = typeof last.meta_analysis_content === 'string'
    ? last.meta_analysis_content.split(/\r?\n\r?\n/)[0]
    : '(meta-analysis 없음)';
  const markdown = `<!-- inherited-context-v1 -->\n## Inherited Context (from ${parentSessionId})\n\n`
    + `이 세션은 선행 세션 \`${parentSessionId}\`의 결과를 이어받는다.\n\n`
    + `### 이어받은 전략 패턴\n${strategy}\n\n`
    + `### 선행 세션에서 참조할 만한 개선 (informational only, NOT replayed)\n${notable}\n\n`
    + `### 선행 세션의 최종 교훈\n${lesson}\n\n---\n\n<!-- /inherited-context-v1 -->\n`;
  return {
    markdown,
    parent_receipt_schema_version: receipt.receipt_schema_version ?? 1,
  };
}

function sessionIdFromPayload(project, payload) {
  if (payload.session_id !== undefined) return ensureSessionId(payload.session_id);
  return resolveCurrent(project).info.sessionId;
}

function parseSessionText(text, sourcePath) {
  if (!text) throw businessError('session_missing', `session file missing: ${sourcePath}`);
  return validateStoredSession(parseStateDocument(text, { sourcePath }));
}

function assertSessionIdentity(session, expectedSessionId) {
  if (!plainObject(session) || session.session_id !== expectedSessionId) {
    throw operatorError('session_identity_mismatch', 'session.yaml session_id does not match its namespace');
  }
  return session;
}

function parseCompatibleSessionText(text, sourcePath, expectedSessionId) {
  if (!text) throw businessError('session_missing', `session file missing: ${sourcePath}`);
  const session = parseStateDocument(text, { sourcePath });
  if (!plainObject(session)) throw operatorError('session_state_invalid', 'session.yaml must contain a mapping');
  return assertSessionIdentity(session, expectedSessionId);
}

function readNamespaceSession(project, sessionId, { compatibility = false } = {}) {
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  let session;
  let sessionText;
  mutateCoordinationFiles(project.stateRoot, [info.relativeSession], (files) => {
    sessionText = files[info.relativeSession];
    session = compatibility
      ? parseCompatibleSessionText(sessionText, info.sessionPath, info.sessionId)
      : assertSessionIdentity(parseSessionText(sessionText, info.sessionPath), info.sessionId);
    return null;
  });
  return { info, session, sessionText };
}

function readCurrentNamespaceSessionCompatibility(project) {
  // The unlocked read is only a path hint used to build the complete lock
  // membership. The pointer and embedded namespace identity are both checked
  // again under the project coordination lock before any value is returned.
  const first = readCoordinationFiles(project.stateRoot, ['current.json'])['current.json'];
  if (!first) throw businessError('current_missing', 'no active session (current.json missing)');
  const hintedPointer = parseJson(first, 'current.json');
  if (typeof hintedPointer.session_id !== 'string' || hintedPointer.session_id.length === 0) {
    throw businessError('session_id_null', 'no active session (session_id null)');
  }
  const info = sessionInfo(project, hintedPointer.session_id);
  let session;
  let sessionText;
  mutateCoordinationFiles(
    project.stateRoot,
    ['current.json', info.relativeSession],
    (files, snapshot) => {
      if (!snapshot.exists['current.json']) {
        throw businessError('current_missing', 'no active session (current.json missing)');
      }
      const current = parseJson(files['current.json'], 'current.json');
      if (current.session_id !== info.sessionId) {
        throw businessError('current_changed', 'current session changed while resolving');
      }
      if (!snapshot.exists[info.relativeSession]) {
        if (!fs.existsSync(info.sessionRoot)) {
          throw businessError('orphan_pointer', `orphan pointer — session dir missing: ${info.sessionRoot}`);
        }
        throw businessError('session_yaml_missing', `session dir exists but session.yaml missing: ${info.sessionRoot}`);
      }
      sessionText = files[info.relativeSession];
      session = parseCompatibleSessionText(sessionText, info.sessionPath, info.sessionId);
      return null;
    },
  );
  return { info, session, sessionText };
}

function requireExactPayload(payload, keys, label = 'payload') {
  const expected = new Set(keys);
  for (const key of expected) {
    if (!Object.hasOwn(payload, key)) {
      throw operatorError('missing_payload_field', `${label}.${key} is required`);
    }
  }
  rejectUnknownKeys(payload, expected, label, 'unknown_payload_field');
  return payload;
}

function transitionOptions(dependencies = {}) {
  const explicit = plainObject(dependencies.transactionOptions)
    ? dependencies.transactionOptions : {};
  return {
    ...explicit,
    ...(dependencies.crashAt === undefined ? {} : { crashAt: dependencies.crashAt }),
    ...(dependencies.onTransitionPhase === undefined
      ? {} : { onPhase: dependencies.onTransitionPhase }),
    ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
    ...(dependencies.io === undefined ? {} : { io: dependencies.io }),
    ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
  };
}

function authorityDigests(files, relative) {
  return {
    session_sha256: sha256Digest(Buffer.from(files[relative.session])),
    journal_sha256: sha256Digest(Buffer.from(files[relative.journal])),
    results_sha256: sha256Digest(Buffer.from(files[relative.results])),
    ...(relative.forum === undefined ? {} : {
      forum_sha256: sha256Digest(Buffer.from(files[relative.forum])),
    }),
  };
}

function requireCas(payload, actual, names) {
  for (const name of names) {
    const payloadKey = `expected_${name}_sha256`;
    requireAuthorityDigest(payload[payloadKey], `payload.${payloadKey}`);
    const actualKey = `${name}_sha256`;
    if (payload[payloadKey] !== actual[actualKey]) {
      throw businessError('stale_preimage', `${name} preimage is stale`, {
        expected: payload[payloadKey],
        actual: actual[actualKey],
      });
    }
  }
}

function typedPaths(info, { forum = false, registry = false } = {}) {
  return {
    session: info.relativeSession,
    journal: relativeSessionSibling(info, 'journal.jsonl'),
    results: relativeSessionSibling(info, 'results.tsv'),
    ...(forum ? { forum: relativeSessionSibling(info, 'forum.jsonl') } : {}),
    ...(registry ? { registry: 'sessions.jsonl' } : {}),
  };
}

function typedKillPaths(info) {
  return {
    session: info.relativeSession,
    journal: relativeSessionSibling(info, 'journal.jsonl'),
    results: relativeSessionSibling(info, 'results.tsv'),
    forum: relativeSessionSibling(info, 'forum.jsonl'),
    killQueue: relativeSessionSibling(info, 'kill_queue.jsonl'),
    killRequests: relativeSessionSibling(info, 'kill_requests.jsonl'),
  };
}

function killAuthorityDigests(files, relative) {
  return {
    session_sha256: sha256Digest(Buffer.from(files[relative.session])),
    journal_sha256: sha256Digest(Buffer.from(files[relative.journal])),
    results_sha256: sha256Digest(Buffer.from(files[relative.results])),
    forum_sha256: sha256Digest(Buffer.from(files[relative.forum])),
    kill_queue_sha256: sha256Digest(Buffer.from(files[relative.killQueue])),
    kill_requests_sha256: sha256Digest(Buffer.from(files[relative.killRequests])),
  };
}

function publicKillAuthorityDigests(digests) {
  return {
    session_sha256: digests.session_sha256,
    journal_sha256: digests.journal_sha256,
    forum_sha256: digests.forum_sha256,
    kill_queue_sha256: digests.kill_queue_sha256,
    kill_requests_sha256: digests.kill_requests_sha256,
  };
}

function requireKillCas(payload, actual, { forum = false } = {}) {
  const names = ['session', 'journal', ...(forum ? ['forum'] : []), 'kill_queue', 'kill_requests'];
  for (const name of names) {
    const payloadKey = `expected_${name}_sha256`;
    requireAuthorityDigest(payload[payloadKey], `payload.${payloadKey}`);
    const actualKey = `${name}_sha256`;
    if (payload[payloadKey] !== actual[actualKey]) {
      throw businessError('stale_preimage', `${name} preimage is stale`, {
        expected: payload[payloadKey],
        actual: actual[actualKey],
      });
    }
  }
}

function serializeJsonlRecords(records) {
  return records.map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

function requireStrictTypedSession(files, relative, info) {
  const session = assertSessionIdentity(
    parseSessionText(files[relative.session], info.sessionPath),
    info.sessionId,
  );
  if (!isStrictSessionVersion(session.deep_evolve_version)) {
    throw operatorError('typed_transition_requires_v35', 'typed transition requires a v3.5 session');
  }
  return session;
}

function replayResult(found, { journalDigest = true } = {}) {
  const result = structuredClone(found.receipt.result);
  if (journalDigest) result.journal_sha256 = found.journal_sha256;
  result.replayed = true;
  return result;
}

function stableRegularFile(root, relativePath, expectedDigest, label) {
  requireAuthorityDigest(expectedDigest, `${label}.sha256`);
  if (typeof relativePath !== 'string' || relativePath.length === 0
      || path.isAbsolute(relativePath) || relativePath.includes('\0')
      || relativePath.includes('\\')) {
    throw operatorError('artifact_path_invalid', `${label} path must be normalized and relative`);
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw operatorError('artifact_path_invalid', `${label} path contains an unsafe segment`);
  }
  let current = root;
  let expectedTarget;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current, { bigint: true }); }
    catch (error) {
      if (error && error.code === 'ENOENT') throw operatorError('artifact_missing', `${label} is missing`);
      throw error;
    }
    if (stat.isSymbolicLink()) throw operatorError('artifact_path_symlink', `${label} contains a symlink`);
    expectedTarget = stat;
  }
  const target = path.join(root, ...segments);
  if (!isPathInside(root, target)) throw operatorError('artifact_path_escape', `${label} escapes session root`);
  if (!expectedTarget || !expectedTarget.isFile()) {
    throw operatorError('artifact_not_regular', `${label} must be a regular file`);
  }
  let physicalBefore;
  try { physicalBefore = fs.realpathSync(target); }
  catch { throw operatorError('artifact_missing', `${label} cannot be resolved`); }
  if (!isPathInside(root, physicalBefore)) {
    throw operatorError('artifact_path_escape', `${label} resolves outside session root`);
  }
  let descriptor;
  try {
    descriptor = fs.openSync(target,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error && new Set(['ELOOP', 'EMLINK']).has(error.code)) {
      throw operatorError('artifact_path_symlink', `${label} became a symlink`);
    }
    throw error;
  }
  let before;
  let after;
  let bytes;
  try {
    before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw operatorError('artifact_not_regular', `${label} must be a regular file`);
    bytes = fs.readFileSync(descriptor);
    after = fs.fstatSync(descriptor, { bigint: true });
  } finally {
    fs.closeSync(descriptor);
  }
  let pathAfter;
  let physicalAfter;
  try {
    pathAfter = fs.lstatSync(target, { bigint: true });
    physicalAfter = fs.realpathSync(target);
  } catch {
    throw operatorError('artifact_changed_during_read', `${label} changed during stable read`);
  }
  if (pathAfter.isSymbolicLink() || !isPathInside(root, physicalAfter)
      || physicalBefore !== physicalAfter
      || expectedTarget.dev !== before.dev || expectedTarget.ino !== before.ino
      || expectedTarget.size !== before.size || expectedTarget.mtimeNs !== before.mtimeNs
      || expectedTarget.ctimeNs !== before.ctimeNs
      || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino
      || pathAfter.size !== after.size || pathAfter.mtimeNs !== after.mtimeNs
      || pathAfter.ctimeNs !== after.ctimeNs
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw operatorError('artifact_changed_during_read', `${label} changed during stable read`);
  }
  const actual = sha256Digest(bytes);
  if (actual !== expectedDigest) {
    throw operatorError(label.startsWith('harness') ? 'harness_identity_mismatch'
      : 'artifact_digest_mismatch', `${label} digest does not match`, { expected: expectedDigest, actual });
  }
  return { path: target, bytes, sha256: actual };
}

function validateHarnessIdentity(info, identity) {
  requirePlainObject(identity, 'harness_identity');
  rejectUnknownKeys(identity, new Set(['prepare_sha256', 'config_sha256']), 'harness_identity');
  for (const key of ['prepare_sha256', 'config_sha256']) {
    if (!Object.hasOwn(identity, key)) throw operatorError('missing_payload_field', `harness_identity.${key} is required`);
    requireAuthorityDigest(identity[key], `harness_identity.${key}`);
  }
  const prepare = stableRegularFile(info.sessionRoot, 'prepare.cjs', identity.prepare_sha256,
    'harness prepare.cjs');
  const configFile = stableRegularFile(info.sessionRoot, 'prepare.config.json', identity.config_sha256,
    'harness prepare.config.json');
  let config;
  try { config = JSON.parse(configFile.bytes.toString('utf8')); }
  catch { throw operatorError('harness_config_invalid', 'prepare.config.json is not valid JSON'); }
  requirePlainObject(config, 'prepare.config.json');
  return { identity: structuredClone(identity), prepare, configFile, config };
}

function normalizeBaseline(session, payload, harness) {
  for (const key of ['raw_score', 'normalized_score']) {
    if (typeof payload[key] !== 'number' || !Number.isFinite(payload[key])) {
      throw operatorError('invalid_field_type', `payload.${key} must be a finite number`);
    }
  }
  if (harness.config.metric_direction !== session.metric.direction) {
    throw operatorError('harness_direction_mismatch', 'harness direction differs from session metric');
  }
  if (session.metric.direction === 'maximize') {
    if (!Object.is(payload.raw_score, payload.normalized_score)) {
      throw operatorError('baseline_normalization_mismatch', 'maximize baseline must preserve raw score');
    }
  } else {
    if (!Number.isFinite(harness.config.baseline_score)
        || !Object.is(harness.config.baseline_score, payload.raw_score)
        || Math.abs(payload.normalized_score - 1) > Number.EPSILON * 8) {
      throw operatorError('baseline_normalization_mismatch',
        'minimize baseline must bind raw baseline and normalize to 1');
    }
  }
}

function operationPatchStrict(project, payload, dependencies = {}) {
  requireExactPayload(payload, [
    'session_id', 'operation_id', 'expected_session_sha256',
    'expected_journal_sha256', 'path', 'value',
  ]);
  const sessionId = ensureSessionId(payload.session_id);
  requireOperationId(payload.operation_id, 'payload.operation_id');
  if (payload.path !== '/transfer') {
    throw operatorError('patch_path_not_allowed', `patch path is not allowed: ${String(payload.path)}`);
  }
  const transfer = validateTransferPatch(payload.value);
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const relative = typedPaths(info);
  const requestDigest = requestSha256('session.patch', payload);
  let result;
  let replayed = false;
  const outcome = mutateCoordinationFiles(
    project.stateRoot,
    Object.values(relative),
    (files) => {
      const current = requireStrictTypedSession(files, relative, info);
      const found = findOperationReceipt(files[relative.journal], payload.operation_id,
        'session.patch', requestDigest);
      if (found) {
        result = replayResult(found);
        replayed = true;
        return null;
      }
      const before = authorityDigests(files, relative);
      requireCas(payload, before, ['session', 'journal']);
      const events = parseStrictJsonl(files[relative.journal]).map((entry) => entry.value);
      if (current.status !== 'initializing'
          || events.some((event) => event.event === 'baseline_recorded')) {
        throw operatorError('patch_lifecycle_closed', 'transfer may be patched only before baseline activation');
      }
      const now = isoNow(dependencies);
      const next = structuredClone(current);
      next.transfer = transfer === null ? null : { ...transfer, adopted_at: now };
      validateStoredSession(next);
      const sessionText = serializeStateDocument(next);
      const event = {
        event: 'transfer_adopted',
        operation_id: payload.operation_id,
        transfer: structuredClone(next.transfer),
        ts: now,
      };
      const core = {
        session: structuredClone(next),
        session_sha256: sha256Digest(Buffer.from(sessionText)),
      };
      const appended = appendTypedEventAndReceipt(files[relative.journal], event, {
        operation: 'session.patch',
        operationId: payload.operation_id,
        requestDigest,
        prior: before,
        postSessionSha256: core.session_sha256,
        postResultsSha256: before.results_sha256,
        postNonProjectionSha256: sessionNonProjectionSha256(next),
        result: core,
        ts: now,
      });
      result = { ...core, replayed: false };
      return {
        [relative.session]: sessionText,
        [relative.journal]: appended.journalText,
      };
    },
    transitionOptions(dependencies),
  );
  if (!replayed) result.journal_sha256 = sha256Digest(Buffer.from(outcome.files[relative.journal]));
  return { result, warnings: [] };
}

function operationRecordBaseline(project, payload, dependencies = {}) {
  requireExactPayload(payload, [
    'session_id', 'operation_id', 'expected_session_sha256',
    'expected_journal_sha256', 'raw_score', 'normalized_score', 'harness_identity',
  ]);
  const sessionId = ensureSessionId(payload.session_id);
  requireOperationId(payload.operation_id, 'payload.operation_id');
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const relative = typedPaths(info, { registry: true });
  const requestDigest = requestSha256('session.record-baseline', payload);
  let result;
  let replayed = false;
  const outcome = mutateCoordinationFiles(project.stateRoot, Object.values(relative), (files) => {
    const current = requireStrictTypedSession(files, relative, info);
    const found = findOperationReceipt(files[relative.journal], payload.operation_id,
      'session.record-baseline', requestDigest);
    if (found) {
      result = replayResult(found);
      replayed = true;
      return null;
    }
    const before = authorityDigests(files, relative);
    requireCas(payload, before, ['session', 'journal']);
    const harness = validateHarnessIdentity(info, payload.harness_identity);
    normalizeBaseline(current, payload, harness);
    parseResultsTsv(files[relative.results]);
    parseJsonl(files[relative.registry], 'sessions.jsonl');
    const now = isoNow(dependencies);
    const applied = applyBaseline(current, payload, now);
    validateStoredSession(applied.session);
    const sessionText = serializeStateDocument(applied.session);
    const core = {
      session: structuredClone(applied.session),
      session_sha256: sha256Digest(Buffer.from(sessionText)),
    };
    const appended = appendTypedEventAndReceipt(files[relative.journal], applied.event, {
      operation: 'session.record-baseline', operationId: payload.operation_id, requestDigest,
      prior: before,
      postSessionSha256: core.session_sha256,
      postResultsSha256: before.results_sha256,
      postNonProjectionSha256: sessionNonProjectionSha256(applied.session),
      result: core,
      ts: now,
    });
    result = { ...core, replayed: false };
    return {
      [relative.session]: sessionText,
      [relative.journal]: appended.journalText,
      [relative.registry]: appendJsonLine(files[relative.registry], {
        event: 'status_change', ts: now, session_id: sessionId, status: 'active',
      }),
    };
  }, transitionOptions(dependencies));
  if (!replayed) result.journal_sha256 = sha256Digest(Buffer.from(outcome.files[relative.journal]));
  return { result, warnings: [] };
}

function gitLiteral(cwd, args, dependencies = {}, label = 'git') {
  const result = (dependencies.spawnSync || spawnSync)('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    shell: false,
  });
  if (!result || typeof result.status !== 'number' || result.status !== 0) {
    const stderr = result && result.stderr ? String(result.stderr).trim() : '';
    throw businessError('git_identity_mismatch', `${label} failed${stderr ? `: ${stderr}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function verifyExperimentGit(project, info, seed, experiment, dependencies = {}) {
  const expectedWorktree = path.join(info.sessionRoot, 'worktrees', `seed_${seed.id}`);
  if (path.resolve(seed.worktree_path) !== path.resolve(expectedWorktree)) {
    throw operatorError('seed_worktree_identity_mismatch', 'canonical seed worktree path is inconsistent');
  }
  const validated = validateSeedWorktree({
    ...task5WorktreeOptions(project, info, dependencies),
    seedId: seed.id,
  });
  if (validated.worktree_path !== expectedWorktree || validated.branch !== seed.branch) {
    throw businessError('worktree_branch_mismatch', 'seed worktree branch differs from canonical state');
  }
  const pre = gitLiteral(expectedWorktree,
    ['rev-parse', '--verify', `${experiment.pre_commit}^{commit}`], dependencies,
    'verify experiment pre-commit');
  const commit = gitLiteral(expectedWorktree,
    ['rev-parse', '--verify', `${experiment.commit}^{commit}`], dependencies,
    'verify experiment commit');
  if (pre !== experiment.pre_commit || commit !== experiment.commit) {
    throw operatorError('git_identity_mismatch', 'Git resolved a non-identical commit object');
  }
  const ancestry = (dependencies.spawnSync || spawnSync)('git', [
    '-C', expectedWorktree, 'merge-base', '--is-ancestor', experiment.pre_commit, experiment.commit,
  ], { encoding: 'utf8', shell: false });
  if (!ancestry || ancestry.status !== 0) {
    if (ancestry && ancestry.status === 1) {
      throw businessError('git_ancestry_mismatch', 'experiment commit is not a descendant of pre-commit');
    }
    throw businessError('git_identity_mismatch', 'Git ancestry verification failed');
  }
  const expectedHead = experiment.status === 'kept' ? experiment.commit : experiment.pre_commit;
  if (validated.head !== expectedHead) {
    throw businessError('worktree_head_mismatch',
      `seed worktree HEAD ${validated.head} differs from terminal ${expectedHead}`);
  }
}

function operationFinishExperiment(project, payload, dependencies = {}) {
  requireExactPayload(payload, [
    'session_id', 'operation_id', 'expected_session_sha256',
    'expected_journal_sha256', 'expected_forum_sha256', 'expected_results_sha256',
    'seed_id', 'experiment',
  ]);
  const sessionId = ensureSessionId(payload.session_id);
  requireOperationId(payload.operation_id, 'payload.operation_id');
  const seedId = requireInteger(payload.seed_id, 'payload.seed_id', { min: 1 });
  const experiment = validateExperiment(payload.experiment);
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const relative = typedPaths(info, { forum: true });
  const requestDigest = requestSha256('session.finish-experiment', payload);
  let result;
  let replayed = false;
  const outcome = mutateCoordinationFiles(project.stateRoot, Object.values(relative), (files) => {
    const current = requireStrictTypedSession(files, relative, info);
    const found = findOperationReceipt(files[relative.journal], payload.operation_id,
      'session.finish-experiment', requestDigest);
    if (found) {
      result = replayResult(found);
      replayed = true;
      return null;
    }
    const before = authorityDigests(files, relative);
    requireCas(payload, before, ['session', 'journal', 'forum', 'results']);
    const journalEntries = parseStrictJsonl(files[relative.journal]);
    const events = journalEntries.map((entry) => entry.value);
    const resultRows = parseResultsTsv(files[relative.results]);
    requireCurrentProjection(current, events, resultRows);
    if (events.some((event) => new Set(['kept', 'discarded', 'failed']).has(event.event)
      && event.id === experiment.id)) {
      throw operatorError('experiment_already_terminal', `experiment ${experiment.id} is already terminal`);
    }
    const seed = current.virtual_parallel.seeds.find((entry) => entry.id === seedId);
    if (!seed || seed.status !== 'active') {
      throw businessError('seed_not_active', `seed ${seedId} is missing or terminal`);
    }
    const expectedDelta = experiment.normalized_score - current.metric.current;
    if (Math.abs(experiment.score_delta - expectedDelta) > 1e-12) {
      throw operatorError('score_delta_mismatch', 'experiment.score_delta differs from canonical current score');
    }
    verifyExperimentGit(project, info, seed, experiment, dependencies);
    parseJsonl(files[relative.forum], 'forum.jsonl');
    const now = isoNow(dependencies);
    const event = {
      event: experiment.status,
      operation_id: payload.operation_id,
      ...structuredClone(experiment),
      seed_id: seedId,
      ts: now,
    };
    const row = resultRowForExperiment(experiment);
    const resultsText = `${files[relative.results]}${serializeResultRow(row)}\n`;
    const projection = reduceVirtualProjection({
      initialVirtual: current.virtual_parallel,
      events: [...events, event],
      resultRows: [...resultRows, row],
    });
    const next = applyExperiment(current, payload, event, projection);
    validateStoredSession(next);
    const sessionText = serializeStateDocument(next);
    const forumEvent = experiment.status === 'failed' ? null : {
      event: experiment.status === 'kept' ? 'experiment_kept' : 'experiment_discarded',
      operation_id: payload.operation_id,
      session_id: sessionId,
      seed_id: seedId,
      experiment_id: experiment.id,
      commit: experiment.commit,
      score_delta: experiment.score_delta,
      ts: now,
    };
    const forumText = forumEvent === null
      ? files[relative.forum] : appendJsonLine(files[relative.forum], forumEvent);
    const core = {
      experiment_id: experiment.id,
      status: experiment.status,
      session: structuredClone(next),
      session_sha256: sha256Digest(Buffer.from(sessionText)),
      forum_sha256: sha256Digest(Buffer.from(forumText)),
      results_sha256: sha256Digest(Buffer.from(resultsText)),
    };
    const appended = appendTypedEventAndReceipt(files[relative.journal], event, {
      operation: 'session.finish-experiment', operationId: payload.operation_id, requestDigest,
      prior: before,
      postSessionSha256: core.session_sha256,
      postResultsSha256: core.results_sha256,
      postNonProjectionSha256: sessionNonProjectionSha256(next),
      result: core,
      ts: now,
    });
    result = { ...core, replayed: false };
    return {
      [relative.session]: sessionText,
      [relative.journal]: appended.journalText,
      [relative.forum]: forumText,
      [relative.results]: resultsText,
    };
  }, transitionOptions(dependencies));
  if (!replayed) result.journal_sha256 = sha256Digest(Buffer.from(outcome.files[relative.journal]));
  return { result, warnings: [] };
}

function operationRecordEvaluatorExpansion(project, payload, dependencies = {}) {
  requireExactPayload(payload, [
    'session_id', 'operation_id', 'expected_session_sha256',
    'expected_journal_sha256', 'harness_identity', 'reason', 'trigger_generation',
  ]);
  const sessionId = ensureSessionId(payload.session_id);
  requireOperationId(payload.operation_id, 'payload.operation_id');
  requireString(payload.reason, 'payload.reason');
  requireInteger(payload.trigger_generation, 'payload.trigger_generation', { min: 0 });
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const relative = typedPaths(info);
  const requestDigest = requestSha256('session.record-evaluator-expansion', payload);
  let result;
  let replayed = false;
  const outcome = mutateCoordinationFiles(project.stateRoot, Object.values(relative), (files) => {
    const current = requireStrictTypedSession(files, relative, info);
    const found = findOperationReceipt(files[relative.journal], payload.operation_id,
      'session.record-evaluator-expansion', requestDigest);
    if (found) {
      result = replayResult(found);
      replayed = true;
      return null;
    }
    const before = authorityDigests(files, relative);
    requireCas(payload, before, ['session', 'journal']);
    validateHarnessIdentity(info, payload.harness_identity);
    parseResultsTsv(files[relative.results]);
    parseStrictJsonl(files[relative.journal]);
    const now = isoNow(dependencies);
    const applied = applyEvaluatorExpansion(current, payload, now);
    validateStoredSession(applied.session);
    const sessionText = serializeStateDocument(applied.session);
    const core = {
      session: structuredClone(applied.session),
      session_sha256: sha256Digest(Buffer.from(sessionText)),
      prepare_version: applied.session.evaluation_epoch.history.at(-1).prepare_version,
    };
    const appended = appendTypedEventAndReceipt(files[relative.journal], applied.event, {
      operation: 'session.record-evaluator-expansion',
      operationId: payload.operation_id,
      requestDigest,
      prior: before,
      postSessionSha256: core.session_sha256,
      postResultsSha256: before.results_sha256,
      postNonProjectionSha256: sessionNonProjectionSha256(applied.session),
      result: core,
      ts: now,
    });
    result = { ...core, replayed: false };
    return { [relative.session]: sessionText, [relative.journal]: appended.journalText };
  }, transitionOptions(dependencies));
  if (!replayed) result.journal_sha256 = sha256Digest(Buffer.from(outcome.files[relative.journal]));
  return { result, warnings: [] };
}

function validateArtifactReference(value, label) {
  requirePlainObject(value, label);
  rejectUnknownKeys(value, new Set(['relative_path', 'sha256']), label);
  if (!Object.hasOwn(value, 'relative_path') || !Object.hasOwn(value, 'sha256')) {
    throw operatorError('invalid_artifact_reference', `${label} requires relative_path and sha256`);
  }
  requireString(value.relative_path, `${label}.relative_path`);
  requireAuthorityDigest(value.sha256, `${label}.sha256`);
  return structuredClone(value);
}

function validateCompletionPayload(info, payload, project, dependencies = {}) {
  if (!new Set(['merged', 'pr_created', 'kept', 'discarded']).has(payload.outcome)) {
    throw operatorError('invalid_completion_outcome', 'payload.outcome is invalid');
  }
  requireString(payload.final_branch, 'payload.final_branch');
  if (!FULL_COMMIT.test(payload.final_commit)) {
    throw operatorError('invalid_commit', 'payload.final_commit must be a full 40/64-hex ID');
  }
  const report = validateArtifactReference(payload.report, 'payload.report');
  const receipt = validateArtifactReference(payload.receipt, 'payload.receipt');
  stableRegularFile(info.sessionRoot, report.relative_path, report.sha256, 'report artifact');
  stableRegularFile(info.sessionRoot, receipt.relative_path, receipt.sha256, 'receipt artifact');
  requirePlainObject(payload.synthesis, 'payload.synthesis');
  rejectUnknownKeys(payload.synthesis, new Set(['outcome', 'commit']), 'payload.synthesis');
  if (!Object.hasOwn(payload.synthesis, 'outcome') || !Object.hasOwn(payload.synthesis, 'commit')) {
    throw operatorError('invalid_synthesis_result', 'payload.synthesis requires outcome and commit');
  }
  requireString(payload.synthesis.outcome, 'payload.synthesis.outcome');
  if (payload.synthesis.commit !== null && !FULL_COMMIT.test(payload.synthesis.commit)) {
    throw operatorError('invalid_commit', 'payload.synthesis.commit must be null or full hex');
  }
  requirePlainObject(payload.final_strategy, 'payload.final_strategy');
  const resolved = gitLiteral(project.projectRoot,
    ['rev-parse', '--verify', `refs/heads/${payload.final_branch}^{commit}`], dependencies,
    'verify final branch');
  if (resolved !== payload.final_commit) {
    throw businessError('git_identity_mismatch', 'final branch does not resolve to final_commit');
  }
}

function operationCompleteStrict(project, payload, dependencies = {}) {
  requireExactPayload(payload, [
    'session_id', 'operation_id', 'expected_session_sha256',
    'expected_journal_sha256', 'outcome', 'final_branch', 'final_commit', 'report',
    'receipt', 'synthesis', 'final_strategy',
  ]);
  const sessionId = ensureSessionId(payload.session_id);
  requireOperationId(payload.operation_id, 'payload.operation_id');
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const relative = typedPaths(info, { registry: true });
  const requestDigest = requestSha256('session.complete', payload);
  let result;
  let replayed = false;
  const outcome = mutateCoordinationFiles(project.stateRoot, Object.values(relative), (files) => {
    const current = requireStrictTypedSession(files, relative, info);
    const found = findOperationReceipt(files[relative.journal], payload.operation_id,
      'session.complete', requestDigest);
    if (found) {
      result = replayResult(found);
      replayed = true;
      return null;
    }
    const before = authorityDigests(files, relative);
    requireCas(payload, before, ['session', 'journal']);
    validateCompletionPayload(info, payload, project, dependencies);
    parseResultsTsv(files[relative.results]);
    parseJsonl(files[relative.registry], 'sessions.jsonl');
    const now = isoNow(dependencies);
    const applied = applyCompletion(current, payload, now);
    validateStoredSession(applied.session);
    const sessionText = serializeStateDocument(applied.session);
    const core = {
      session_id: sessionId,
      status: 'completed',
      outcome: payload.outcome,
      session: structuredClone(applied.session),
      session_sha256: sha256Digest(Buffer.from(sessionText)),
    };
    const appended = appendTypedEventAndReceipt(files[relative.journal], applied.event, {
      operation: 'session.complete', operationId: payload.operation_id, requestDigest,
      prior: before,
      postSessionSha256: core.session_sha256,
      postResultsSha256: before.results_sha256,
      postNonProjectionSha256: sessionNonProjectionSha256(applied.session),
      result: core,
      ts: now,
    });
    const registry = appendJsonLine(files[relative.registry], {
      event: 'finished', ts: now, session_id: sessionId, status: 'completed',
      outcome: payload.outcome, final_branch: payload.final_branch,
      final_commit: payload.final_commit,
    });
    result = { ...core, replayed: false };
    return {
      [relative.session]: sessionText,
      [relative.journal]: appended.journalText,
      [relative.registry]: registry,
    };
  }, transitionOptions(dependencies));
  if (!replayed) result.journal_sha256 = sha256Digest(Buffer.from(outcome.files[relative.journal]));
  return { result, warnings: [] };
}

function patchSessionWithJournal(project, sessionId, mutator) {
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const journalRelative = relativeSessionSibling(info, 'journal.jsonl');
  let session;
  let warnings = [];
  mutateCoordinationFiles(project.stateRoot, [info.relativeSession, journalRelative], (files) => {
    const current = parseSessionText(files[info.relativeSession], info.sessionPath);
    assertSessionIdentity(current, info.sessionId);
    const outcome = mutator(structuredClone(current), files[journalRelative]);
    session = outcome.session;
    warnings = outcome.warnings || [];
    validateStoredSession(session);
    return {
      [info.relativeSession]: serializeStateDocument(session),
      [journalRelative]: files[journalRelative],
    };
  });
  return { session, warnings };
}

const VIRTUAL_FIELDS = Object.freeze({
  enabled: (value) => typeof value === 'boolean',
  N: (value) => Number.isInteger(value) && value >= 1 && value <= 9,
  n_current: (value) => Number.isInteger(value) && value >= 1 && value <= 9,
  n_initial: (value) => Number.isInteger(value) && value >= 1 && value <= 9,
  project_type: (value) => typeof value === 'string',
  eval_parallelizability: (value) => typeof value === 'string',
  selection_reason: (value) => typeof value === 'string',
  budget_total: (value) => Number.isInteger(value) && value >= 0,
  budget_unallocated: (value) => Number.isInteger(value) && value >= 0,
  unallocated_pool: (value) => Number.isFinite(value) && value >= 0,
});

function operationVirtualInitLegacy(project, payload) {
  const sessionId = sessionIdFromPayload(project, payload);
  const analysis = requirePlainObject(payload.analysis, 'payload.analysis');
  rejectUnknownKeys(analysis, new Set(['project_type', 'eval_parallelizability', 'reasoning']), 'analysis');
  const projectType = requireString(analysis.project_type, 'payload.analysis.project_type');
  const parallel = requireString(analysis.eval_parallelizability, 'payload.analysis.eval_parallelizability');
  const reasoning = analysis.reasoning === undefined ? '' : requireString(analysis.reasoning, 'payload.analysis.reasoning', { empty: true });
  const n = requireInteger(payload.n_chosen, 'payload.n_chosen', { min: 1, max: 9 });
  const budget = requireInteger(payload.total_budget, 'payload.total_budget', { min: n });
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const session = patchSession(info.sessionPath, (current) => {
    assertSessionIdentity(current, info.sessionId);
    const next = structuredClone(current);
    const virtual = plainObject(next.virtual_parallel) ? next.virtual_parallel : {};
    const nextVirtual = {
      ...virtual,
      enabled: true,
      n_current: n,
      n_initial: n,
      n_range: { min: 1, max: 9 },
      project_type: projectType,
      eval_parallelizability: parallel,
      selection_reason: reasoning,
      budget_total: budget,
      budget_unallocated: 0,
      synthesis: {
        ...(plainObject(virtual.synthesis) ? virtual.synthesis : {}),
        budget_allocated: Math.min(2 * n, 10),
        regression_tolerance: 0.05,
      },
      seeds: Array.isArray(virtual.seeds) ? virtual.seeds : [],
    };
    delete nextVirtual['x-active-seed-count'];
    next.virtual_parallel = nextVirtual;
    return next;
  }, { stateRoot: project.stateRoot });
  return { result: { session }, warnings: [] };
}

function operationVirtualAppendLegacy(project, payload, dependencies = {}) {
  const sessionId = sessionIdFromPayload(project, payload);
  const seedId = requireInteger(payload.seed_id, 'payload.seed_id', { min: 1 });
  const worktreePath = requireString(payload.worktree_path, 'payload.worktree_path');
  const branch = requireString(payload.branch, 'payload.branch');
  const beta = payload.beta === undefined || payload.beta === null ? {} : requirePlainObject(payload.beta, 'payload.beta');
  rejectUnknownKeys(beta, new Set(['direction', 'hypothesis', 'rationale']), 'beta');
  const patched = patchSessionWithJournal(project, sessionId, (session, journalText) => {
    const warnings = [];
    const events = parseJsonl(journalText, 'journal.jsonl', { skipMalformed: true, warnings });
    let createdAt = null;
    for (const event of events) {
      if (event.event === 'seed_initialized' && event.seed_id === seedId && typeof event.ts === 'string') {
        createdAt = event.ts;
      }
    }
    if (!createdAt) {
      createdAt = isoNow(dependencies);
      warnings.push({ code: 'seed_initialized_missing', seed_id: seedId, used: 'current_time' });
    }
    const virtual = plainObject(session.virtual_parallel) ? session.virtual_parallel : {};
    const seeds = Array.isArray(virtual.seeds) ? [...virtual.seeds] : [];
    const total = Number.isFinite(Number(virtual.budget_total)) ? Math.trunc(Number(virtual.budget_total)) : 0;
    const initial = Number.isFinite(Number(virtual.n_initial)) && Number(virtual.n_initial) > 0
      ? Math.trunc(Number(virtual.n_initial)) : 1;
    const entry = {
      id: seedId,
      status: 'active',
      direction: beta.direction ?? null,
      hypothesis: beta.hypothesis ?? null,
      initial_rationale: beta.rationale ?? null,
      worktree_path: worktreePath,
      branch,
      created_at: createdAt,
      created_by: 'init_batch',
      experiments_used: 0,
      keeps: 0,
      borrows_given: 0,
      borrows_received: 0,
      current_q: 0,
      allocated_budget: Math.floor(total / Math.max(initial, 1)),
      killed_at: null,
      killed_reason: null,
    };
    const index = seeds.findIndex((seed) => seed && seed.id === seedId);
    if (index >= 0) seeds[index] = entry;
    else seeds.push(entry);
    const nextVirtual = { ...virtual, seeds };
    if (Object.hasOwn(nextVirtual, 'x-active-seed-count')) {
      delete nextVirtual['x-active-seed-count'];
      nextVirtual.n_current = seeds.filter((seed) => seed && seed.status === 'active').length;
    }
    session.virtual_parallel = nextVirtual;
    return { session, warnings };
  });
  return { result: { session: patched.session }, warnings: patched.warnings };
}

function operationVirtualSetFieldLegacy(project, payload) {
  const sessionId = sessionIdFromPayload(project, payload);
  const key = requireString(payload.key, 'payload.key');
  if (!Object.hasOwn(VIRTUAL_FIELDS, key)) {
    throw operatorError('virtual_field_not_allowed', `virtual field is not allowed: ${key}`);
  }
  const validator = VIRTUAL_FIELDS[key];
  if (!validator(payload.value)) throw operatorError('virtual_field_type_invalid', `invalid value for virtual field ${key}`);
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const session = patchSession(info.sessionPath, (current) => {
    assertSessionIdentity(current, info.sessionId);
    const next = structuredClone(current);
    const virtual = { ...(plainObject(next.virtual_parallel) ? next.virtual_parallel : {}), [key]: payload.value };
    if (key === 'n_current') delete virtual['x-active-seed-count'];
    next.virtual_parallel = virtual;
    return next;
  }, { stateRoot: project.stateRoot });
  return { result: { session }, warnings: [] };
}

function operationVirtualRebuildLegacy(project, payload) {
  const sessionId = sessionIdFromPayload(project, payload);
  const patched = patchSessionWithJournal(project, sessionId, (session, journalText) => {
    if (!journalText) throw businessError('journal_missing', 'journal.jsonl missing');
    const warnings = [];
    const events = parseJsonl(journalText, 'journal.jsonl', { skipMalformed: true, warnings });
    const seeds = new Map();
    for (const event of events) {
      if (!Number.isInteger(event.seed_id)) continue;
      const seedId = event.seed_id;
      if (event.event === 'seed_initialized') {
        seeds.set(seedId, {
          id: seedId,
          status: 'active',
          direction: event.direction ?? null,
          hypothesis: event.hypothesis ?? null,
          initial_rationale: event.initial_rationale ?? null,
          worktree_path: event.worktree_path ?? null,
          branch: event.branch ?? null,
          created_by: event.created_by ?? 'init_batch',
          experiments_used: 0,
          keeps: 0,
          borrows_given: 0,
          borrows_received: 0,
          current_q: 0,
          killed_at: null,
          killed_reason: null,
          created_at: event.ts ?? null,
        });
      } else if (event.event === 'seed_killed' && seeds.has(seedId)) {
        const seed = seeds.get(seedId);
        const raw = event.condition === undefined || event.condition === null ? 'killed' : String(event.condition);
        seed.status = raw.startsWith('killed_') || raw.startsWith('killed:') ? raw : `killed_${raw}`;
        seed.killed_at = event.ts ?? null;
        seed.killed_reason = raw.startsWith('killed_') ? raw.slice('killed_'.length) : raw;
        if (event.reasoning !== undefined && event.reasoning !== null) {
          seed['x-killed-reasoning'] = String(event.reasoning);
        }
        if (Object.hasOwn(event, 'final_q')) seed.final_q = event.final_q;
        if (Object.hasOwn(event, 'experiments_used')) seed.experiments_used = event.experiments_used;
      }
    }
    const rebuilt = [...seeds.entries()].sort(([left], [right]) => left - right).map(([, seed]) => seed);
    const virtual = plainObject(session.virtual_parallel) ? session.virtual_parallel : {};
    const activeCount = rebuilt.filter((seed) => seed.status === 'active').length;
    const nextVirtual = { ...virtual, seeds: rebuilt };
    delete nextVirtual.n_current;
    delete nextVirtual['x-active-seed-count'];
    if (activeCount > 0) nextVirtual.n_current = activeCount;
    else nextVirtual['x-active-seed-count'] = 0;
    session.virtual_parallel = nextVirtual;
    return { session, warnings };
  });
  return { result: { session: patched.session }, warnings: patched.warnings };
}

function projectionEquals(left, right) {
  return projectionSha256(left) === projectionSha256(right);
}

function requireCurrentProjection(current, events, resultRows) {
  const derived = reduceVirtualProjection({
    initialVirtual: current.virtual_parallel,
    events,
    resultRows,
  });
  const materialized = projectionFromVirtual(current.virtual_parallel);
  if (!projectionEquals(materialized, derived)) {
    throw transitionError('virtual_projection_conflict',
      'materialized virtual projection differs from committed authority');
  }
  return derived;
}

function authenticateSeedWorktree(project, info, payload, dependencies = {}) {
  const expectedWorktree = path.join(info.sessionRoot, 'worktrees', `seed_${payload.seed_id}`);
  const expectedBranch = `evolve/${info.sessionId}/seed-${payload.seed_id}`;
  if (payload.worktree_path !== expectedWorktree || payload.branch !== expectedBranch) {
    throw operatorError('seed_worktree_identity_mismatch',
      'seed worktree path and branch must equal their canonical identities');
  }
  const validated = validateSeedWorktree({
    ...task5WorktreeOptions(project, info, dependencies),
    seedId: payload.seed_id,
  });
  if (validated.worktree_path !== payload.worktree_path || validated.branch !== payload.branch) {
    throw businessError('worktree_branch_mismatch',
      'seed worktree path or branch differs from canonical state');
  }
}

function operationVirtualAppendStrict(project, payload, dependencies = {}) {
  requireExactPayload(payload, [
    'session_id', 'operation_id', 'expected_session_sha256',
    'expected_journal_sha256', 'seed_id', 'worktree_path', 'branch', 'beta',
    'creation_kind',
  ]);
  const sessionId = ensureSessionId(payload.session_id);
  requireOperationId(payload.operation_id, 'payload.operation_id');
  if (!Number.isSafeInteger(payload.seed_id) || payload.seed_id < 1 || payload.seed_id > 9) {
    throw operatorError('invalid_field_type',
      'payload.seed_id must be a positive safe integer no greater than 9');
  }
  requireString(payload.worktree_path, 'payload.worktree_path');
  requireString(payload.branch, 'payload.branch');
  const beta = validateBeta(payload.beta);
  if (!new Set(['initial', 'growth']).has(payload.creation_kind)) {
    throw operatorError('invalid_creation_kind', 'payload.creation_kind must be initial or growth');
  }
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const relative = typedPaths(info);
  const requestDigest = requestSha256('virtual.append-seed', payload);
  let result;
  let replayed = false;
  const outcome = mutateCoordinationFiles(project.stateRoot, Object.values(relative), (files) => {
    const current = requireStrictTypedSession(files, relative, info);
    const found = findOperationReceipt(files[relative.journal], payload.operation_id,
      'virtual.append-seed', requestDigest);
    if (found) {
      result = replayResult(found);
      replayed = true;
      return null;
    }
    const before = authorityDigests(files, relative);
    requireCas(payload, before, ['session', 'journal']);
    const events = parseStrictJsonl(files[relative.journal]).map((entry) => entry.value);
    const resultRows = parseResultsTsv(files[relative.results]);
    const currentProjection = requireCurrentProjection(current, events, resultRows);
    if (currentProjection.seeds.some((seed) => seed.id === payload.seed_id)) {
      throw operatorError('seed_already_initialized', `seed ${payload.seed_id} is already initialized`);
    }
    if (payload.creation_kind === 'initial') {
      if (current.status !== 'initializing' || payload.seed_id > current.virtual_parallel.n_initial) {
        throw operatorError('initial_seed_identity_invalid',
          'initial seed requires initializing lifecycle and an ID in 1..n_initial');
      }
    } else if (current.status !== 'active') {
      throw businessError('growth_seed_lifecycle_invalid', 'growth seed requires active lifecycle');
    }
    authenticateSeedWorktree(project, info, payload, dependencies);
    const activeCount = currentProjection.seeds.filter((seed) => seed.status === 'active').length;
    let allocation;
    if (payload.creation_kind === 'initial') {
      const base = Math.floor(current.virtual_parallel.budget_total
        / current.virtual_parallel.n_initial);
      const remainder = current.virtual_parallel.budget_total
        - base * current.virtual_parallel.n_initial;
      allocation = base + (payload.seed_id > current.virtual_parallel.n_initial - remainder ? 1 : 0);
    } else {
      if (activeCount < 1) {
        throw businessError('growth_seed_unavailable', 'growth requires at least one active seed');
      }
      allocation = Math.max(Math.ceil(currentProjection.budget_unallocated / (2 * activeCount)), 3);
    }
    if (currentProjection.budget_unallocated < allocation) {
      throw businessError('insufficient_budget', 'unallocated budget cannot fund the seed');
    }
    const now = isoNow(dependencies);
    const event = {
      event: 'seed_initialized',
      operation_id: payload.operation_id,
      seed_id: payload.seed_id,
      creation_kind: payload.creation_kind,
      direction: beta.direction,
      hypothesis: beta.hypothesis,
      initial_rationale: beta.rationale,
      worktree_path: payload.worktree_path,
      branch: payload.branch,
      ts: now,
      created_by: payload.creation_kind === 'initial' ? 'init_batch' : 'epoch_growth',
      allocated_budget: allocation,
    };
    const projection = reduceVirtualProjection({
      initialVirtual: current.virtual_parallel,
      events: [...events, event],
      resultRows,
    });
    const next = structuredClone(current);
    next.virtual_parallel = installProjection(next.virtual_parallel, projection);
    validateStoredSession(next);
    const sessionText = serializeStateDocument(next);
    const seed = projection.seeds.find((entry) => entry.id === payload.seed_id);
    const core = {
      seed: structuredClone(seed),
      active_seed_count: projection.n_current || 0,
      budget_unallocated: projection.budget_unallocated,
      session_sha256: sha256Digest(Buffer.from(sessionText)),
    };
    const appended = appendTypedEventAndReceipt(files[relative.journal], event, {
      operation: 'virtual.append-seed', operationId: payload.operation_id, requestDigest,
      prior: before,
      postSessionSha256: core.session_sha256,
      postResultsSha256: before.results_sha256,
      postNonProjectionSha256: sessionNonProjectionSha256(next),
      result: core,
      ts: now,
    });
    result = { ...core, replayed: false };
    return {
      [relative.session]: sessionText,
      [relative.journal]: appended.journalText,
    };
  }, transitionOptions(dependencies));
  if (!replayed) result.journal_sha256 = sha256Digest(Buffer.from(outcome.files[relative.journal]));
  return { result, warnings: [] };
}

function lastReceiptNonProjection(entries) {
  const receipts = entries.map((entry) => entry.value)
    .filter((event) => event.event === 'operation_receipt');
  if (receipts.length === 0) return null;
  const latest = receipts.at(-1);
  if (!plainObject(latest.post)
      || typeof latest.post.non_projection_sha256 !== 'string') {
    throw transitionError('virtual_projection_conflict',
      'latest operation receipt lacks non-projection authority');
  }
  requireAuthorityDigest(latest.post.non_projection_sha256,
    'operation_receipt.post.non_projection_sha256');
  return latest.post.non_projection_sha256;
}

function operationVirtualRebuildStrict(project, payload, dependencies = {}) {
  requireExactPayload(payload, [
    'session_id', 'operation_id', 'expected_session_sha256',
    'expected_journal_sha256', 'expected_results_sha256',
  ]);
  const sessionId = ensureSessionId(payload.session_id);
  requireOperationId(payload.operation_id, 'payload.operation_id');
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const relative = typedPaths(info);
  const requestDigest = requestSha256('virtual.rebuild-seeds', payload);
  let result;
  let replayed = false;
  mutateCoordinationFiles(project.stateRoot, Object.values(relative), (files) => {
    const current = requireStrictTypedSession(files, relative, info);
    const found = findOperationReceipt(files[relative.journal], payload.operation_id,
      'virtual.rebuild-seeds', requestDigest);
    if (found) {
      result = replayResult(found, { journalDigest: false });
      replayed = true;
      return null;
    }
    const before = authorityDigests(files, relative);
    requireCas(payload, before, ['session', 'journal', 'results']);
    const entries = parseStrictJsonl(files[relative.journal]);
    const previousNonProjection = lastReceiptNonProjection(entries);
    if (previousNonProjection !== null
        && sessionNonProjectionSha256(current) !== previousNonProjection) {
      throw transitionError('virtual_projection_conflict',
        'session non-projection state differs from the latest committed receipt');
    }
    const resultRows = parseResultsTsv(files[relative.results]);
    const projection = reduceVirtualProjection({
      initialVirtual: current.virtual_parallel,
      events: entries.map((entry) => entry.value),
      resultRows,
    });
    assertRepairableProjection(current.virtual_parallel, projection);
    const changed = !projectionEquals(projectionFromVirtual(current.virtual_parallel), projection);
    const next = structuredClone(current);
    if (changed) next.virtual_parallel = installProjection(next.virtual_parallel, projection);
    validateStoredSession(next);
    const sessionText = changed ? serializeStateDocument(next) : files[relative.session];
    const core = {
      session: structuredClone(next),
      session_sha256: sha256Digest(Buffer.from(sessionText)),
      projection_sha256: projectionSha256(projection),
      changed,
    };
    const now = isoNow(dependencies);
    const appended = appendOperationReceipt(files[relative.journal], {
      operation: 'virtual.rebuild-seeds', operationId: payload.operation_id, requestDigest,
      prior: before,
      postSessionSha256: core.session_sha256,
      postResultsSha256: before.results_sha256,
      postNonProjectionSha256: sessionNonProjectionSha256(next),
      result: core,
      ts: now,
    });
    result = { ...core, replayed: false };
    return {
      ...(changed ? { [relative.session]: sessionText } : {}),
      [relative.journal]: appended.journalText,
    };
  }, transitionOptions(dependencies));
  return { result, warnings: [] };
}

function validateKillSemanticState(files, relative, info) {
  const session = requireStrictTypedSession(files, relative, info);
  const journalEntries = validateCommittedJournal(files[relative.journal]);
  const events = journalEntries.map((entry) => entry.value);
  const resultRows = parseResultsTsv(files[relative.results]);
  const projection = requireCurrentProjection(session, events, resultRows);
  const requests = validateUserKillRequests(
    parseStrictJsonl(files[relative.killRequests]).map((entry) => entry.value),
  );
  const queue = validateKillQueue(
    parseStrictJsonl(files[relative.killQueue]).map((entry) => entry.value),
  );
  const seeds = new Map(projection.seeds.map((seed) => [seed.id, seed]));
  const requestById = new Map(requests.map((entry) => [entry.entry_id, entry]));
  const queuedByRequest = new Map(queue.filter((entry) => Object.hasOwn(entry, 'request_id'))
    .map((entry) => [entry.request_id, entry]));
  const killedByRequest = new Map();
  for (const event of events.filter((entry) => entry.event === 'seed_killed'
    && entry.source === 'user_request')) {
    const request = requestById.get(event.request_id);
    if (!request || request.choice_id !== 'confirm-kill'
        || request.kill_entry_id !== event.kill_entry_id
        || request.seed_id !== event.seed_id) {
      throw transitionError('user_kill_authority_conflict',
        `user kill event ${event.kill_entry_id} lacks its acknowledged request`);
    }
    if (killedByRequest.has(event.request_id)) {
      throw transitionError('user_kill_authority_conflict',
        `user kill request ${event.request_id} has multiple event authorities`);
    }
    killedByRequest.set(event.request_id, event);
  }
  for (const request of requests) {
    const seed = seeds.get(request.seed_id);
    if (!seed) {
      throw transitionError('user_kill_seed_missing',
        `user kill request ${request.entry_id} references a missing seed`);
    }
    if (request.acknowledged_at === null) {
      if (seed.status !== 'active') {
        throw transitionError('user_kill_seed_terminal',
          `pending user kill request ${request.entry_id} targets a terminal seed`);
      }
      continue;
    }
    if (request.choice_id !== 'confirm-kill') continue;
    const queued = queuedByRequest.get(request.entry_id);
    const killed = killedByRequest.get(request.entry_id);
    if ((queued ? 1 : 0) + (killed ? 1 : 0) !== 1) {
      throw transitionError('user_kill_authority_conflict',
        `confirmed user kill request ${request.entry_id} must have one queue or event authority`);
    }
    const authority = queued || killed;
    if (authority.seed_id !== request.seed_id
        || (queued && queued.entry_id !== request.kill_entry_id)
        || (killed && killed.kill_entry_id !== request.kill_entry_id)) {
      throw transitionError('user_kill_authority_conflict',
        `confirmed user kill request ${request.entry_id} has mismatched authority`);
    }
  }
  for (const entry of queue) {
    const seed = seeds.get(entry.seed_id);
    if (!seed || seed.status !== 'active') {
      throw transitionError('kill_queue_seed_terminal',
        `queued kill ${entry.entry_id} targets a missing or terminal seed`);
    }
    if (Object.hasOwn(entry, 'request_id')) {
      const request = requestById.get(entry.request_id);
      if (!request || request.choice_id !== 'confirm-kill'
          || request.kill_entry_id !== entry.entry_id
          || request.seed_id !== entry.seed_id) {
        throw transitionError('user_kill_authority_conflict',
          `queued user kill ${entry.entry_id} lacks its acknowledged request`);
      }
    }
  }
  return {
    session,
    events,
    resultRows,
    projection,
    requests,
    queue,
    requestById,
  };
}

function operationListUserKillRequests(project, payload) {
  requireExactPayload(payload, ['session_id']);
  const sessionId = ensureSessionId(payload.session_id);
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const relative = typedKillPaths(info);
  let result;
  mutateCoordinationFiles(project.stateRoot, Object.values(relative), (files) => {
    const state = validateKillSemanticState(files, relative, info);
    const pending = state.requests.filter((entry) => entry.acknowledged_at === null)
      .sort((left, right) => left.requested_at.localeCompare(right.requested_at)
        || left.entry_id.localeCompare(right.entry_id));
    const acknowledged = state.requests.filter((entry) => entry.acknowledged_at !== null)
      .sort((left, right) => left.acknowledged_at.localeCompare(right.acknowledged_at)
        || left.entry_id.localeCompare(right.entry_id));
    result = {
      pending,
      acknowledged,
      authority_digests: publicKillAuthorityDigests(killAuthorityDigests(files, relative)),
    };
    return null;
  });
  return { result, warnings: [] };
}

function operationAckUserKillRequest(project, payload, dependencies = {}) {
  requireExactPayload(payload, [
    'session_id', 'operation_id', 'request_id', 'choice_id',
    'expected_session_sha256', 'expected_journal_sha256',
    'expected_forum_sha256', 'expected_kill_queue_sha256',
    'expected_kill_requests_sha256',
  ]);
  const sessionId = ensureSessionId(payload.session_id);
  requireOperationId(payload.operation_id, 'payload.operation_id');
  requireString(payload.request_id, 'payload.request_id');
  if (!new Set(['confirm-kill', 'keep-seed']).has(payload.choice_id)) {
    throw operatorError('invalid_user_kill_choice',
      'payload.choice_id must be confirm-kill or keep-seed');
  }
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const relative = typedKillPaths(info);
  const requestDigest = requestSha256('coord.ack-user-kill-request', payload);
  let result;
  let replayed = false;
  const outcome = mutateCoordinationFiles(project.stateRoot, Object.values(relative), (files) => {
    const state = validateKillSemanticState(files, relative, info);
    const found = findOperationReceipt(files[relative.journal], payload.operation_id,
      'coord.ack-user-kill-request', requestDigest);
    if (found) {
      result = replayResult(found);
      replayed = true;
      return null;
    }
    const before = killAuthorityDigests(files, relative);
    requireKillCas(payload, before, { forum: true });
    const requestIndex = state.requests.findIndex((entry) => entry.entry_id === payload.request_id);
    if (requestIndex < 0) {
      throw operatorError('user_kill_request_missing',
        `user kill request not found: ${payload.request_id}`);
    }
    const priorRequest = state.requests[requestIndex];
    if (priorRequest.acknowledged_at !== null
        && priorRequest.choice_id !== payload.choice_id) {
      throw operatorError('user_kill_choice_conflict',
        `user kill request ${payload.request_id} was acknowledged with another choice`);
    }
    const priorQueue = state.queue.find((entry) => Object.hasOwn(entry, 'request_id')
      && entry.request_id === payload.request_id);
    const priorKill = state.events.find((event) => event.event === 'seed_killed'
      && event.source === 'user_request' && event.request_id === payload.request_id);
    const now = isoNow(dependencies);
    let request = priorRequest;
    let queue = state.queue;
    let killEvent = null;
    let nextProjection = state.projection;
    let applied = Boolean(priorKill);
    let queued = Boolean(priorQueue);
    let killEntryId = priorRequest.kill_entry_id;
    if (priorRequest.acknowledged_at === null) {
      if (payload.choice_id === 'keep-seed') {
        request = {
          ...priorRequest,
          acknowledged_at: now,
          choice_id: 'keep-seed',
          kill_entry_id: null,
        };
      } else {
        if (state.queue.some((entry) => entry.seed_id === priorRequest.seed_id)) {
          throw transitionError('kill_queue_seed_conflict',
            `seed ${priorRequest.seed_id} already has a queued kill`);
        }
        killEntryId = stableUserKillEntryId(priorRequest);
        request = {
          ...priorRequest,
          acknowledged_at: now,
          choice_id: 'confirm-kill',
          kill_entry_id: killEntryId,
        };
        const seed = state.projection.seeds.find((entry) => entry.id === priorRequest.seed_id);
        const queueEntry = {
          entry_id: killEntryId,
          request_id: priorRequest.entry_id,
          seed_id: priorRequest.seed_id,
          condition: 'user_requested',
          final_q: seed.current_q,
          experiments_used: seed.experiments_used,
          queued_at: now,
        };
        const inFlight = deriveInFlightSeedIds(state.events);
        const eligible = prepareEligibleKills({
          queue: [queueEntry],
          inFlightSeedIds: inFlight,
          preProjection: state.projection,
          postProjection: state.projection,
          operationId: payload.operation_id,
          now,
        });
        if (eligible.deferred.length === 1) {
          queue = [...state.queue, queueEntry];
          queued = true;
        } else {
          [killEvent] = eligible.killEvents;
          nextProjection = reduceVirtualProjection({
            initialVirtual: state.session.virtual_parallel,
            events: [...state.events, killEvent],
            resultRows: state.resultRows,
          });
          applied = true;
        }
      }
    }
    const requests = state.requests.map((entry, index) => (
      index === requestIndex ? request : entry
    ));
    const next = structuredClone(state.session);
    if (killEvent) next.virtual_parallel = installProjection(next.virtual_parallel, nextProjection);
    validateStoredSession(next);
    const sessionText = killEvent ? serializeStateDocument(next) : files[relative.session];
    const core = {
      request_id: request.entry_id,
      seed_id: request.seed_id,
      choice_id: request.choice_id,
      kill_entry_id: request.kill_entry_id,
      applied,
      queued,
      replayed: false,
    };
    const receiptInput = {
      operation: 'coord.ack-user-kill-request',
      operationId: payload.operation_id,
      requestDigest,
      prior: before,
      postSessionSha256: sha256Digest(Buffer.from(sessionText)),
      postResultsSha256: before.results_sha256,
      postNonProjectionSha256: sessionNonProjectionSha256(next),
      result: core,
      ts: now,
    };
    const appended = killEvent
      ? appendTypedEventAndReceipt(files[relative.journal], killEvent, receiptInput)
      : appendOperationReceipt(files[relative.journal], receiptInput);
    result = core;
    return {
      [relative.session]: sessionText,
      [relative.journal]: appended.journalText,
      [relative.killQueue]: serializeJsonlRecords(queue),
      [relative.killRequests]: serializeJsonlRecords(requests),
    };
  }, transitionOptions(dependencies));
  if (!replayed) {
    result.journal_sha256 = sha256Digest(Buffer.from(outcome.files[relative.journal]));
  }
  return { result, warnings: [] };
}

function operationDrainKillQueueStrict(project, payload, dependencies = {}) {
  requireExactPayload(payload, [
    'session_id', 'operation_id', 'expected_session_sha256',
    'expected_journal_sha256', 'expected_kill_queue_sha256',
    'expected_kill_requests_sha256',
  ]);
  const sessionId = ensureSessionId(payload.session_id);
  requireOperationId(payload.operation_id, 'payload.operation_id');
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const relative = typedKillPaths(info);
  const requestDigest = requestSha256('coord.drain-kill-queue', payload);
  let result;
  let replayed = false;
  const outcome = mutateCoordinationFiles(project.stateRoot, Object.values(relative), (files) => {
    const state = validateKillSemanticState(files, relative, info);
    const found = findOperationReceipt(files[relative.journal], payload.operation_id,
      'coord.drain-kill-queue', requestDigest);
    if (found) {
      result = replayResult(found);
      replayed = true;
      return null;
    }
    const before = killAuthorityDigests(files, relative);
    requireKillCas(payload, before);
    const now = isoNow(dependencies);
    const decision = prepareEligibleKills({
      queue: state.queue,
      inFlightSeedIds: deriveInFlightSeedIds(state.events),
      preProjection: state.projection,
      postProjection: state.projection,
      operationId: payload.operation_id,
      now,
    });
    const killEvents = decision.killEvents;
    const projection = killEvents.length === 0 ? state.projection : reduceVirtualProjection({
      initialVirtual: state.session.virtual_parallel,
      events: [...state.events, ...killEvents],
      resultRows: state.resultRows,
    });
    const next = structuredClone(state.session);
    if (killEvents.length > 0) next.virtual_parallel = installProjection(next.virtual_parallel, projection);
    validateStoredSession(next);
    const sessionText = killEvents.length > 0
      ? serializeStateDocument(next) : files[relative.session];
    const core = {
      applied: killEvents.length,
      remaining: decision.deferred.length,
      applied_seed_ids: killEvents.map((event) => event.seed_id),
      replayed: false,
    };
    const receiptInput = {
      operation: 'coord.drain-kill-queue',
      operationId: payload.operation_id,
      requestDigest,
      prior: before,
      postSessionSha256: sha256Digest(Buffer.from(sessionText)),
      postResultsSha256: before.results_sha256,
      postNonProjectionSha256: sessionNonProjectionSha256(next),
      result: core,
      ts: now,
    };
    const appended = killEvents.length > 0
      ? appendTypedEventsAndReceipt(files[relative.journal], killEvents, receiptInput)
      : appendOperationReceipt(files[relative.journal], receiptInput);
    result = core;
    return {
      [relative.session]: sessionText,
      [relative.journal]: appended.journalText,
      [relative.killQueue]: serializeJsonlRecords(decision.deferred),
      [relative.killRequests]: files[relative.killRequests],
    };
  }, transitionOptions(dependencies));
  if (!replayed) {
    result.journal_sha256 = sha256Digest(Buffer.from(outcome.files[relative.journal]));
  }
  return { result, warnings: [] };
}

function requireSafeCoordinatorInteger(value, label, { min = 0 } = {}) {
  requireInteger(value, label, { min });
  if (!Number.isSafeInteger(value)) {
    throw operatorError('invalid_field_type', `${label} must be a safe integer`);
  }
  return value;
}

function coordinatorSeedWorktree(project, info, seed, dependencies = {}) {
  const expectedWorktree = path.join(info.sessionRoot, 'worktrees', `seed_${seed.id}`);
  if (path.resolve(seed.worktree_path) !== path.resolve(expectedWorktree)) {
    throw operatorError('seed_worktree_identity_mismatch',
      'canonical seed worktree path is inconsistent');
  }
  const validated = validateSeedWorktree({
    ...task5WorktreeOptions(project, info, dependencies),
    seedId: seed.id,
  });
  if (path.resolve(validated.worktree_path) !== path.resolve(expectedWorktree)
      || validated.branch !== seed.branch || !FULL_COMMIT.test(validated.head)) {
    throw businessError('worktree_identity_mismatch',
      'seed worktree branch or HEAD differs from canonical state');
  }
  return validated;
}

function verifyCoordinatorReturnedHead(project, info, seed, schedule, returnedHead,
  dependencies = {}) {
  if (!FULL_COMMIT.test(returnedHead)) {
    throw operatorError('invalid_commit', 'payload.returned_head must be a full commit ID');
  }
  const worktree = coordinatorSeedWorktree(project, info, seed, dependencies);
  const resolvedPre = gitLiteral(worktree.worktree_path,
    ['rev-parse', '--verify', `${schedule.pre_dispatch_head}^{commit}`], dependencies,
    'verify block pre-dispatch HEAD');
  const resolvedReturned = gitLiteral(worktree.worktree_path,
    ['rev-parse', '--verify', `${returnedHead}^{commit}`], dependencies,
    'verify block returned HEAD');
  if (resolvedPre !== schedule.pre_dispatch_head || resolvedReturned !== returnedHead
      || worktree.head !== returnedHead) {
    throw businessError('worktree_head_mismatch',
      'returned HEAD is not the authenticated seed branch tip');
  }
  const ancestry = (dependencies.spawnSync || spawnSync)('git', [
    '-C', worktree.worktree_path, 'merge-base', '--is-ancestor',
    schedule.pre_dispatch_head, returnedHead,
  ], { encoding: 'utf8', shell: false });
  if (!ancestry || ancestry.status !== 0) {
    if (ancestry && ancestry.status === 1) {
      throw businessError('git_ancestry_mismatch',
        'returned HEAD is not a descendant of pre-dispatch HEAD');
    }
    throw businessError('git_identity_mismatch', 'Git ancestry verification failed');
  }
  return worktree;
}

function operationBeginSeedBlock(project, payload, dependencies = {}) {
  requireExactPayload(payload, [
    'session_id', 'operation_id', 'decision_id', 'seed_id', 'block_size',
    'pre_dispatch_head', 'expected_epoch', 'budget_preimage',
    'expected_session_sha256', 'expected_journal_sha256',
  ]);
  const sessionId = ensureSessionId(payload.session_id);
  requireOperationId(payload.operation_id, 'payload.operation_id');
  requireString(payload.decision_id, 'payload.decision_id');
  requireSafeCoordinatorInteger(payload.seed_id, 'payload.seed_id', { min: 1 });
  requireSafeCoordinatorInteger(payload.block_size, 'payload.block_size', { min: 1 });
  requireSafeCoordinatorInteger(payload.expected_epoch, 'payload.expected_epoch', { min: 1 });
  requireSafeCoordinatorInteger(payload.budget_preimage, 'payload.budget_preimage');
  if (!FULL_COMMIT.test(payload.pre_dispatch_head)) {
    throw operatorError('invalid_commit', 'payload.pre_dispatch_head must be a full commit ID');
  }
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const relative = typedPaths(info);
  const requestDigest = requestSha256('coord.begin-seed-block', payload);
  let result;
  let replayed = false;
  const outcome = mutateCoordinationFiles(project.stateRoot, Object.values(relative), (files) => {
    const current = requireStrictTypedSession(files, relative, info);
    const found = findOperationReceipt(files[relative.journal], payload.operation_id,
      'coord.begin-seed-block', requestDigest);
    if (found) {
      result = replayResult(found);
      replayed = true;
      return null;
    }
    const before = authorityDigests(files, relative);
    requireCas(payload, before, ['session', 'journal']);
    const entries = validateCommittedJournal(files[relative.journal]);
    const events = entries.map((entry) => entry.value);
    const resultRows = parseResultsTsv(files[relative.results]);
    requireCurrentProjection(current, events, resultRows);
    const seed = current.virtual_parallel.seeds.find((entry) => entry.id === payload.seed_id);
    if (!seed) throw businessError('seed_not_active', `seed ${payload.seed_id} is missing`);
    const worktree = coordinatorSeedWorktree(project, info, seed, dependencies);
    const now = isoNow(dependencies);
    const begun = beginSeedBlock({ session: current, payload, events, worktree, now });
    // Re-authenticate immediately before publication so a summary-time HEAD
    // drift cannot be converted into a durable schedule.
    const stable = coordinatorSeedWorktree(project, info, seed, dependencies);
    if (stable.head !== worktree.head || stable.branch !== worktree.branch) {
      throw businessError('worktree_changed_during_validation',
        'seed worktree changed during block begin validation');
    }
    reduceVirtualProjection({
      initialVirtual: current.virtual_parallel,
      events: [...events, begun.event],
      resultRows,
    });
    const core = {
      block_id: begun.blockId,
      seed_id: payload.seed_id,
      epoch: payload.expected_epoch,
      pre_dispatch_head: payload.pre_dispatch_head,
      block_size: payload.block_size,
      budget_preimage: payload.budget_preimage,
      session_sha256: before.session_sha256,
    };
    const appended = appendTypedEventAndReceipt(files[relative.journal], begun.event, {
      operation: 'coord.begin-seed-block',
      operationId: payload.operation_id,
      requestDigest,
      prior: before,
      postSessionSha256: before.session_sha256,
      postResultsSha256: before.results_sha256,
      postNonProjectionSha256: sessionNonProjectionSha256(current),
      result: core,
      ts: now,
    });
    result = { ...core, replayed: false };
    return { [relative.journal]: appended.journalText };
  }, transitionOptions(dependencies));
  if (!replayed) result.journal_sha256 = sha256Digest(Buffer.from(outcome.files[relative.journal]));
  return { result, warnings: [] };
}

function operationFinishSeedBlock(project, payload, dependencies = {}) {
  requireExactPayload(payload, [
    'session_id', 'operation_id', 'block_id', 'seed_id', 'status', 'returned_head',
    'summary', 'expected_session_sha256', 'expected_journal_sha256',
    'expected_forum_sha256', 'expected_kill_queue_sha256',
    'expected_kill_requests_sha256',
  ]);
  const sessionId = ensureSessionId(payload.session_id);
  requireOperationId(payload.operation_id, 'payload.operation_id');
  requireString(payload.block_id, 'payload.block_id');
  requireSafeCoordinatorInteger(payload.seed_id, 'payload.seed_id', { min: 1 });
  requireString(payload.status, 'payload.status');
  if (!FULL_COMMIT.test(payload.returned_head)) {
    throw operatorError('invalid_commit', 'payload.returned_head must be a full commit ID');
  }
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const relative = typedKillPaths(info);
  const requestDigest = requestSha256('coord.finish-seed-block', payload);
  let result;
  let replayed = false;
  const outcome = mutateCoordinationFiles(project.stateRoot, Object.values(relative), (files) => {
    const state = validateKillSemanticState(files, relative, info);
    const found = findOperationReceipt(files[relative.journal], payload.operation_id,
      'coord.finish-seed-block', requestDigest);
    if (found) {
      result = replayResult(found);
      replayed = true;
      return null;
    }
    const before = killAuthorityDigests(files, relative);
    requireKillCas(payload, before, { forum: true });
    const forumEvents = parseStrictJsonl(files[relative.forum]).map((entry) => entry.value);
    const now = isoNow(dependencies);
    const evidence = deriveFinishEvidence({
      events: state.events,
      forumEvents,
      sessionId,
      blockId: payload.block_id,
      seedId: payload.seed_id,
      status: payload.status,
      now,
    });
    assertSummaryMatches(payload.summary, evidence);
    if (payload.returned_head !== evidence.expectedReturnedHead) {
      throw businessError('worktree_head_authority_conflict',
        'returned HEAD is not reproduced by the ordered typed experiment chain');
    }
    const seed = state.projection.seeds.find((entry) => entry.id === payload.seed_id);
    if (!seed || seed.status !== 'active') {
      throw businessError('seed_not_active', `seed ${payload.seed_id} is missing or terminal`);
    }
    verifyCoordinatorReturnedHead(project, info, seed, evidence.schedule,
      payload.returned_head, dependencies);
    const terminalEvent = buildFinishEvent({ payload, evidence, now });
    const terminalEvents = [...state.events, terminalEvent];
    const terminalProjection = reduceVirtualProjection({
      initialVirtual: state.session.virtual_parallel,
      events: terminalEvents,
      resultRows: state.resultRows,
    });
    const prefixStart = seed.allocated_budget - evidence.schedule.budget_preimage;
    if (!Number.isSafeInteger(prefixStart) || prefixStart < 0
        || prefixStart > seed.experiments_used) {
      throw transitionError('kill_queue_snapshot_conflict',
        'block schedule cannot derive canonical kill snapshot prefixes');
    }
    const blockPrefixSnapshots = [];
    for (let experiments = prefixStart; experiments <= seed.experiments_used; experiments += 1) {
      blockPrefixSnapshots.push({
        status: 'active',
        current_q: seed.current_q,
        experiments_used: experiments,
      });
    }
    const killDecision = prepareEligibleKills({
      queue: state.queue,
      inFlightSeedIds: deriveInFlightSeedIds(terminalEvents),
      preProjection: state.projection,
      postProjection: terminalProjection,
      preSnapshotCandidates: new Map([[seed.id, blockPrefixSnapshots]]),
      operationId: payload.operation_id,
      now,
    });
    const typedEvents = [terminalEvent, ...killDecision.killEvents];
    const projection = killDecision.killEvents.length === 0 ? terminalProjection
      : reduceVirtualProjection({
        initialVirtual: state.session.virtual_parallel,
        events: [...state.events, ...typedEvents],
        resultRows: state.resultRows,
      });
    // Authenticate the branch a second time after every caller summary and
    // derived-file scan but before any transaction bytes are staged.
    verifyCoordinatorReturnedHead(project, info, seed, evidence.schedule,
      payload.returned_head, dependencies);
    const next = structuredClone(state.session);
    next.virtual_parallel = installProjection(next.virtual_parallel, projection);
    validateStoredSession(next);
    const sessionText = serializeStateDocument(next);
    const queueText = serializeJsonlRecords(killDecision.deferred);
    const core = {
      block_id: payload.block_id,
      seed_id: payload.seed_id,
      status: payload.status,
      returned_head: payload.returned_head,
      final_q: evidence.Q,
      components: structuredClone(evidence.components),
      experiment_ids: evidence.experimentIds,
      commits: evidence.commits,
      forum_entry_ids: evidence.forumEntryIds,
      borrows_given: evidence.borrowsGiven,
      borrows_received: evidence.borrowsReceived,
      killed_seed_ids: killDecision.killEvents.map((event) => event.seed_id),
      session_sha256: sha256Digest(Buffer.from(sessionText)),
      forum_sha256: before.forum_sha256,
      kill_queue_sha256: sha256Digest(Buffer.from(queueText)),
      kill_requests_sha256: before.kill_requests_sha256,
    };
    const appended = appendTypedEventsAndReceipt(files[relative.journal], typedEvents, {
      operation: 'coord.finish-seed-block',
      operationId: payload.operation_id,
      requestDigest,
      prior: before,
      postSessionSha256: core.session_sha256,
      postResultsSha256: before.results_sha256,
      postNonProjectionSha256: sessionNonProjectionSha256(next),
      result: core,
      ts: now,
    });
    result = { ...core, replayed: false };
    return {
      [relative.session]: sessionText,
      [relative.journal]: appended.journalText,
      [relative.forum]: files[relative.forum],
      [relative.killQueue]: queueText,
      [relative.killRequests]: files[relative.killRequests],
    };
  }, transitionOptions(dependencies));
  if (!replayed) result.journal_sha256 = sha256Digest(Buffer.from(outcome.files[relative.journal]));
  return { result, warnings: [] };
}

function operationAdvanceEpoch(project, payload, dependencies = {}) {
  requireExactPayload(payload, [
    'session_id', 'operation_id', 'expected_epoch', 'completed_block_ids', 'reason',
    'expected_session_sha256', 'expected_journal_sha256', 'expected_results_sha256',
  ]);
  const sessionId = ensureSessionId(payload.session_id);
  requireOperationId(payload.operation_id, 'payload.operation_id');
  requireSafeCoordinatorInteger(payload.expected_epoch, 'payload.expected_epoch', { min: 1 });
  if (!Array.isArray(payload.completed_block_ids)) {
    throw operatorError('invalid_field_type', 'payload.completed_block_ids must be an array');
  }
  requireString(payload.reason, 'payload.reason');
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const relative = typedPaths(info);
  const requestDigest = requestSha256('coord.advance-epoch', payload);
  let result;
  let replayed = false;
  const outcome = mutateCoordinationFiles(project.stateRoot, Object.values(relative), (files) => {
    const current = requireStrictTypedSession(files, relative, info);
    const found = findOperationReceipt(files[relative.journal], payload.operation_id,
      'coord.advance-epoch', requestDigest);
    if (found) {
      result = replayResult(found);
      replayed = true;
      return null;
    }
    const before = authorityDigests(files, relative);
    requireCas(payload, before, ['session', 'journal', 'results']);
    if (payload.expected_epoch !== current.evaluation_epoch.current) {
      throw businessError('epoch_conflict', 'expected epoch differs from canonical session');
    }
    const entries = validateCommittedJournal(files[relative.journal]);
    const events = entries.map((entry) => entry.value);
    const resultRows = parseResultsTsv(files[relative.results]);
    requireCurrentProjection(current, events, resultRows);
    const boundary = deriveEpochBoundary({
      session: current,
      events,
      completedBlockIds: payload.completed_block_ids,
      reason: payload.reason,
    });
    const now = isoNow(dependencies);
    const applied = applyEpochBoundary(current, boundary, {
      operationId: payload.operation_id,
      reason: payload.reason,
      now,
    });
    const projection = reduceVirtualProjection({
      initialVirtual: current.virtual_parallel,
      events: [...events, ...applied.events],
      resultRows,
    });
    applied.session.virtual_parallel = installProjection(
      applied.session.virtual_parallel, projection,
    );
    validateStoredSession(applied.session);
    const sessionText = serializeStateDocument(applied.session);
    const core = {
      ...applied.result,
      session_sha256: sha256Digest(Buffer.from(sessionText)),
    };
    const appended = appendTypedEventsAndReceipt(files[relative.journal], applied.events, {
      operation: 'coord.advance-epoch',
      operationId: payload.operation_id,
      requestDigest,
      prior: before,
      postSessionSha256: core.session_sha256,
      postResultsSha256: before.results_sha256,
      postNonProjectionSha256: sessionNonProjectionSha256(applied.session),
      result: core,
      ts: now,
    });
    result = { ...core, replayed: false };
    return {
      [relative.session]: sessionText,
      [relative.journal]: appended.journalText,
    };
  }, transitionOptions(dependencies));
  if (!replayed) result.journal_sha256 = sha256Digest(Buffer.from(outcome.files[relative.journal]));
  return { result, warnings: [] };
}

function compatibleSessionForDispatch(project, payload) {
  const sessionId = ensureSessionId(payload.session_id);
  return readNamespaceSession(project, sessionId, { compatibility: true }).session;
}

function strictVersionForGenericAppend(info) {
  let text;
  try { text = fs.readFileSync(info.sessionPath, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') {
      throw businessError('session_missing', `session file missing: ${info.sessionPath}`);
    }
    throw error;
  }
  const session = parseCompatibleSessionText(text, info.sessionPath, info.sessionId);
  return isStrictSessionVersion(session.deep_evolve_version);
}

function operationVirtualInit(project, payload) {
  const session = compatibleSessionForDispatch(project, payload);
  if (isStrictSessionVersion(session.deep_evolve_version)) {
    throw operatorError('legacy_virtual_init_forbidden',
      'virtual.init is forbidden for v3.5 canonical sessions');
  }
  requireExactPayload(payload, ['session_id', 'analysis', 'n_chosen', 'total_budget']);
  return operationVirtualInitLegacy(project, payload);
}

function operationVirtualAppend(project, payload, dependencies = {}) {
  const session = compatibleSessionForDispatch(project, payload);
  if (isStrictSessionVersion(session.deep_evolve_version)) {
    return operationVirtualAppendStrict(project, payload, dependencies);
  }
  requireExactPayload(payload, ['session_id', 'seed_id', 'worktree_path', 'branch', 'beta']);
  return operationVirtualAppendLegacy(project, payload, dependencies);
}

function operationVirtualSetField(project, payload) {
  const session = compatibleSessionForDispatch(project, payload);
  if (isStrictSessionVersion(session.deep_evolve_version)) {
    throw operatorError('legacy_virtual_set_field_forbidden',
      'virtual.set-field is forbidden for v3.5 canonical sessions');
  }
  requireExactPayload(payload, ['session_id', 'key', 'value']);
  return operationVirtualSetFieldLegacy(project, payload);
}

function operationVirtualRebuild(project, payload, dependencies = {}) {
  const session = compatibleSessionForDispatch(project, payload);
  if (isStrictSessionVersion(session.deep_evolve_version)) {
    return operationVirtualRebuildStrict(project, payload, dependencies);
  }
  requireExactPayload(payload, ['session_id']);
  return operationVirtualRebuildLegacy(project, payload);
}

function task5WorktreeOptions(project, info, dependencies = {}) {
  return {
    projectRoot: project.projectRoot,
    sessionRoot: info.sessionRoot,
    sessionId: info.sessionId,
    spawnSync: dependencies.spawnSync,
    now: dependencies.now,
    randomUUID: dependencies.randomUUID,
    onPhase: dependencies.onWorktreePhase,
  };
}

function task5OutputPath(info, parts) {
  let current = info.sessionRoot;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw operatorError('output_path_invalid', `output parent must be a regular directory: ${current}`);
      }
    } else fs.mkdirSync(current);
  }
  const output = path.join(info.sessionRoot, ...parts);
  if (!isPathInside(info.sessionRoot, output)) throw operatorError('output_path_escape', 'output path escapes session root');
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) {
    throw operatorError('output_path_symlink', `output path must not be a symlink: ${output}`);
  }
  return output;
}

function task5SessionTexts(project, info, names) {
  const relatives = names.map((name) => relativeSessionSibling(info, name));
  const files = readCoordinationFiles(project.stateRoot, relatives);
  return Object.fromEntries(names.map((name, index) => [name, files[relatives[index]]]));
}

function task5DataRoot(dependencies = {}) {
  const environment = plainObject(dependencies.env) ? dependencies.env : process.env;
  return resolveDataRoot(environment, dependencies.homedir);
}

function authenticateSeedDispatchWorktree(info, context) {
  const expected = path.join(info.sessionRoot, 'worktrees', `seed_${context.seed_id}`);
  if (context.session_root !== info.sessionRoot || context.worktree_path !== expected
      || !isPathInside(info.sessionRoot, expected)) {
    throw operatorError('seed_worktree_path_invalid',
      'derived seed worktree differs from the authenticated session namespace');
  }
  let current = info.sessionRoot;
  for (const segment of ['worktrees', `seed_${context.seed_id}`]) {
    current = path.join(current, segment);
    let before;
    try { before = fs.lstatSync(current, { bigint: true }); }
    catch (error) {
      if (error && error.code === 'ENOENT') {
        throw businessError('seed_worktree_missing',
          `canonical seed worktree is missing: ${current}`);
      }
      throw error;
    }
    if (before.isSymbolicLink()) {
      throw operatorError('seed_worktree_symlink',
        `canonical seed worktree contains a symlink: ${current}`);
    }
    if (!before.isDirectory()) {
      throw operatorError('seed_worktree_path_invalid',
        `canonical seed worktree component is not a directory: ${current}`);
    }
    let resolved;
    try { resolved = fs.realpathSync(current); }
    catch {
      throw operatorError('seed_worktree_path_invalid',
        `canonical seed worktree cannot be resolved: ${current}`);
    }
    if (!isPathInside(info.sessionRoot, resolved)) {
      throw operatorError('seed_worktree_path_invalid',
        'canonical seed worktree resolves outside the session namespace');
    }
    const after = fs.lstatSync(current, { bigint: true });
    if (after.isSymbolicLink() || !after.isDirectory()
        || before.dev !== after.dev || before.ino !== after.ino) {
      throw operatorError('seed_worktree_changed',
        'canonical seed worktree changed during authentication');
    }
  }
}

function requirePublicationSourceList(value, label = 'payload.source_artifacts') {
  if (!Array.isArray(value)) {
    throw operatorError('invalid_source_artifacts', `${label} must be an array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const source = requirePlainObject(value[index], `${label}[${index}]`);
    rejectUnknownKeys(source, new Set(['path', 'run_id']), `${label}[${index}]`,
      'invalid_source_artifact');
    requireString(source.path, `${label}[${index}].path`);
    if (source.run_id !== undefined && !PUBLICATION_ID_RE.test(source.run_id)) {
      throw operatorError('invalid_source_artifact',
        `${label}[${index}].run_id must be a valid ULID`);
    }
  }
  return value;
}

function validatePublicationPayload(payload, {
  requireOutcome = false,
  allowParent = false,
  allowRecurring = false,
  allowLegacy = false,
} = {}) {
  requirePlainObject(payload.payload, 'payload.payload');
  const sessionId = ensureSessionId(payload.session_id);
  requirePublicationSourceList(payload.source_artifacts);
  if (!PUBLICATION_ID_RE.test(payload.publication_id || '')) {
    throw operatorError('invalid_publication_id', 'payload.publication_id must be a valid ULID');
  }
  if (!ARTIFACT_DIGEST_RE.test(payload.expected_session_sha256 || '')) {
    throw operatorError('invalid_digest',
      'payload.expected_session_sha256 must be sha256:<64 lowercase hex>');
  }
  if (payload.parent_run_id !== undefined) {
    if (!allowParent || !PUBLICATION_ID_RE.test(payload.parent_run_id)) {
      throw operatorError('invalid_parent_run_id',
        'payload.parent_run_id is not allowed or is not a valid ULID');
    }
  }
  if (payload.source_recurring_findings !== undefined) {
    if (!allowRecurring) {
      throw operatorError('unknown_payload_field',
        'payload.source_recurring_findings is not allowed for this operation');
    }
    requireString(payload.source_recurring_findings,
      'payload.source_recurring_findings');
  }
  if (payload.legacy_artifact_sha256 !== undefined) {
    if (!allowLegacy || !ARTIFACT_DIGEST_RE.test(payload.legacy_artifact_sha256)) {
      throw operatorError('invalid_legacy_artifact_digest',
        'payload.legacy_artifact_sha256 is not allowed or is malformed');
    }
  }
  if (requireOutcome
      && (typeof payload.payload.outcome !== 'string'
        || payload.payload.outcome.length === 0)) {
    throw operatorError('receipt_outcome_required',
      'receipt payload requires one final non-null semantic outcome');
  }
  if (requireOutcome
      && !new Set(['merged', 'pr_created', 'kept', 'discarded'])
        .has(payload.payload.outcome)) {
    throw operatorError('receipt_outcome_invalid',
      'receipt payload outcome must be merged, pr_created, kept, or discarded');
  }
  return sessionId;
}

function publicationRequestDigest(operation, payload) {
  return requestSha256(operation, {
    ...structuredClone(payload),
    builder_version: ARTIFACT_BUILDER_VERSION,
  });
}

function publicationOptions(dependencies = {}) {
  const explicit = plainObject(dependencies.artifactOptions)
    ? dependencies.artifactOptions : {};
  return {
    ...explicit,
    ...(explicit.now === undefined
      ? { now: dependencies.now || Date.now }
      : {}),
  };
}

function publicationGeneratedAt(publicationId) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let timestamp = 0;
  for (const character of publicationId.slice(0, 10)) {
    timestamp = (timestamp * 32) + alphabet.indexOf(character);
  }
  const maxFourDigitTimestamp = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
  return new Date(timestamp % (maxFourDigitTimestamp + 1)).toISOString();
}

function publicationGit(project, dependencies = {}) {
  const run = dependencies.spawnSync || spawnSync;
  const execute = (args) => run('git', ['-C', project.projectRoot, ...args], {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const head = execute(['rev-parse', 'HEAD']);
  if (head.status !== 0) return { head: '0000000', branch: 'HEAD', dirty: 'unknown' };
  const branch = execute(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = execute(['status', '--porcelain']);
  return {
    head: head.stdout.trim(),
    branch: branch.status === 0 && branch.stdout.trim() !== 'HEAD'
      ? branch.stdout.trim() : 'HEAD',
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : 'unknown',
  };
}

function authenticatePublicationSources(project, payload, options) {
  const ordinary = authenticateSourceArtifacts(payload.source_artifacts, {
    cwd: project.projectRoot,
    io: options.io || fs,
  });
  if (payload.source_recurring_findings === undefined) return ordinary;
  const recurring = authenticateSourceArtifacts([
    { path: payload.source_recurring_findings },
  ], {
    cwd: project.projectRoot,
    io: options.io || fs,
    expectedIdentity: {
      producer: 'deep-review',
      artifact_kind: 'recurring-findings',
    },
  });
  return {
    records: [...recurring.records, ...ordinary.records],
    evidence: [...recurring.evidence, ...ordinary.evidence],
    recurringRunId: recurring.records[0] && recurring.records[0].run_id,
  };
}

function buildPublicationEnvelope(operation, payload, sources, project, dependencies) {
  const envelopeOptions = {
    runId: payload.publication_id,
    generatedAt: publicationGeneratedAt(payload.publication_id),
    git: publicationGit(project, dependencies),
    producerVersion: RUNTIME_VERSION,
    toolVersions: { node: process.version },
  };
  const common = {
    payload: payload.payload,
    sessionId: payload.session_id,
    sourceArtifacts: sources.records,
    envelopeOptions,
  };
  if (operation === 'artifact.wrap-receipt') {
    return wrapEvolveArtifact({
      ...common,
      artifactKind: 'evolve-receipt',
      parentRunId: payload.parent_run_id || sources.recurringRunId,
      sourceRecurringFindings: undefined,
      sourceArtifactsAuthenticated: true,
    });
  }
  if (operation === 'artifact.wrap-insights') {
    return wrapEvolveArtifact({
      ...common,
      artifactKind: 'evolve-insights',
      sourceArtifactsAuthenticated: true,
    });
  }
  if (operation === 'artifact.emit-compaction') {
    return buildCompactionArtifact({
      ...common,
      parentRunId: payload.parent_run_id,
    });
  }
  if (operation === 'artifact.emit-handoff') {
    return buildHandoffArtifact({
      ...common,
      parentRunId: payload.parent_run_id,
    });
  }
  if (operation === 'transfer.export-feedback') {
    return exportFeedback({
      ...common,
      sourceArtifactsAuthenticated: true,
    });
  }
  throw operatorError('invalid_artifact_operation',
    `unsupported artifact publication operation: ${operation}`);
}

function artifactKindForOperation(operation) {
  return {
    'artifact.wrap-receipt': 'receipt',
    'artifact.wrap-insights': 'insights',
    'artifact.emit-compaction': 'compaction',
    'artifact.emit-handoff': 'handoff',
    'transfer.export-feedback': 'feedback',
  }[operation];
}

function publishArtifactOperation(operation, project, payload, dependencies = {}) {
  const requestDigest = publicationRequestDigest(operation, payload);
  const options = publicationOptions(dependencies);
  const kind = artifactKindForOperation(operation);
  const info = sessionInfo(project, payload.session_id, { requireDirectory: true });
  const existing = readPublication({
    stateRoot: project.stateRoot,
    sessionRoot: info.sessionRoot,
    sessionId: info.sessionId,
    kind,
    publicationId: payload.publication_id,
    requestDigest,
    options,
  });
  if (existing) return { result: existing, warnings: [] };

  let result;
  mutateCoordinationFiles(project.stateRoot, [info.relativeSession], (files) => {
    const session = parseSessionText(files[info.relativeSession], info.sessionPath);
    assertSessionIdentity(session, info.sessionId);
    const actualDigest = sha256Digest(Buffer.from(files[info.relativeSession]));
    if (actualDigest !== payload.expected_session_sha256) {
      const raced = readPublication({
        stateRoot: project.stateRoot,
        sessionRoot: info.sessionRoot,
        sessionId: info.sessionId,
        kind,
        publicationId: payload.publication_id,
        requestDigest,
        options,
      });
      if (raced) {
        result = raced;
        return null;
      }
      throw businessError('stale_preimage',
        'expected_session_sha256 does not match current session authority');
    }
    const sources = authenticatePublicationSources(project, payload, options);
    const envelope = buildPublicationEnvelope(operation, payload, sources,
      project, dependencies);
    const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`);
    result = publishArtifact({
      stateRoot: project.stateRoot,
      sessionRoot: info.sessionRoot,
      sessionId: info.sessionId,
      kind,
      publicationId: payload.publication_id,
      requestDigest,
      bytes,
      legacyArtifactSha256: payload.legacy_artifact_sha256,
      sourceEvidence: sources.evidence,
      options,
    });
    return null;
  }, transitionOptions(dependencies));
  return { result, warnings: [] };
}

const HANDLERS = Object.freeze({
  'session.resolve-current': (request, project, dependencies) => {
    payloadFor(request, []);
    const resolved = resolveCurrent(project, dependencies);
    return {
      result: {
        session_id: resolved.info.sessionId,
        session_root: resolved.info.publicSessionRoot,
      },
      warnings: [],
    };
  },
  'session.read': (request, project) => {
    const payload = payloadFor(request, ['session_id']);
    const { session, sessionText } = payload.session_id === undefined
      ? readCurrentNamespaceSessionCompatibility(project)
      : readNamespaceSession(project, ensureSessionId(payload.session_id), { compatibility: true });
    return {
      result: { session, session_sha256: sha256Digest(Buffer.from(sessionText)) },
      warnings: [],
    };
  },
  'session.list': (request, project) => {
    const payload = payloadFor(request, ['status']);
    return { result: operationList(project, payload), warnings: [] };
  },
  'session.start': (request, project, dependencies) => {
    const payload = payloadFor(request, ['goal', 'parent_session_id', 'initial_state']);
    return { result: startSession(project, payload, dependencies), warnings: [] };
  },
  'session.mark-status': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id', 'status']);
    const sessionId = ensureSessionId(payload.session_id);
    const session = compatibleSessionForDispatch(project, payload);
    if (isStrictSessionVersion(session.deep_evolve_version)) {
      throw operatorError('legacy_mark_status_forbidden',
        'session.mark-status is forbidden for v3.5 canonical sessions');
    }
    const status = requireString(payload.status, 'payload.status');
    updateSessionStatus(project, sessionId, status, 'status_change', dependencies);
    return { result: { session_id: sessionId, status }, warnings: [] };
  },
  'session.migrate-legacy': (request, project, dependencies, recovery) => {
    payloadFor(request, []);
    const committed = recovery && recovery.migrations && Array.isArray(recovery.migrations.committed)
      ? recovery.migrations.committed : [];
    if (committed.length > 1) {
      throw operatorError('migration_multiple_committed', 'multiple committed legacy migrations require manual recovery');
    }
    if (committed.length === 1) {
      const transaction = committed[0];
      const manifest = transaction.manifest;
      return {
        result: {
          session_id: manifest.session_id,
          session_root: path.join(project.stateRoot, manifest.destination_name),
          status: manifest.status,
        },
        warnings: transaction.warnings,
      };
    }
    return migrateLegacy(project, dependencies);
  },
  'session.check-alignment': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id']);
    const sessionId = sessionIdFromPayload(project, payload);
    const { session } = readNamespaceSession(project, sessionId);
    const expected = plainObject(session.lineage) && typeof session.lineage.current_branch === 'string'
      ? session.lineage.current_branch : '';
    const git = (dependencies.spawnSync || spawnSync)('git', ['branch', '--show-current'], {
      cwd: project.projectRoot,
      encoding: 'utf8',
      shell: false,
    });
    const actual = git.status === 0 ? git.stdout.trim() : '';
    if (expected && expected !== actual) {
      throw businessError('branch_mismatch', `branch mismatch: expected '${expected}', actual '${actual}'`, { expected, actual });
    }
    return { result: { aligned: true, expected, actual }, warnings: [] };
  },
  'session.detect-orphan': (request, project) => {
    const payload = payloadFor(request, ['session_id']);
    const sessionId = sessionIdFromPayload(project, payload);
    const info = sessionInfo(project, sessionId, { requireDirectory: true });
    const relative = relativeSessionSibling(info, 'journal.jsonl');
    const text = readCoordinationFiles(project.stateRoot, [relative])[relative];
    const warnings = [];
    const events = parseJsonl(text, 'journal.jsonl', { skipMalformed: true, warnings });
    const committed = [...events].reverse().find((event) => event.status === 'committed' && Number.isFinite(event.id));
    if (!committed) return { result: { commit: null, experiment_id: null }, warnings };
    const resolved = events.some((event) => event.id === committed.id
      && ['evaluated', 'kept', 'discarded', 'rollback_completed'].includes(event.status));
    if (resolved) return { result: { commit: null, experiment_id: null }, warnings };
    const first = events.find((event) => event.id === committed.id && event.status === 'committed');
    return { result: { commit: first && typeof first.commit === 'string' ? first.commit : null, experiment_id: committed.id }, warnings };
  },
  'session.append-local-archive': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id']);
    return { result: appendLocalArchive(project, ensureSessionId(payload.session_id), dependencies), warnings: [] };
  },
  'session.render-inherited-context': (request, project) => {
    const payload = payloadFor(request, ['parent_session_id']);
    return { result: renderInheritedContext(project, ensureSessionId(payload.parent_session_id, 'parent_session_id')), warnings: [] };
  },
  'session.lineage-tree': (request, project) => {
    payloadFor(request, []);
    const sessions = operationList(project, {}).sessions;
    return {
      result: { lines: sessions.map((session) => `${session.session_id} <- ${session.parent_session_id || '(root)'}`) },
      warnings: [],
    };
  },
  'session.patch': (request, project, dependencies) => {
    const payload = payloadFor(request, [
      'session_id', 'operation_id', 'expected_session_sha256',
      'expected_journal_sha256', 'path', 'value',
    ]);
    const sessionId = ensureSessionId(payload.session_id);
    const compatible = compatibleSessionForDispatch(project, payload);
    if (isStrictSessionVersion(compatible.deep_evolve_version)) {
      return operationPatchStrict(project, payload, dependencies);
    }
    requireExactPayload(payload, ['session_id', 'path', 'value']);
    const pointer = requireString(payload.path, 'payload.path');
    const info = sessionInfo(project, sessionId, { requireDirectory: true });
    const session = patchSession(info.sessionPath, (current) => {
      assertSessionIdentity(current, info.sessionId);
      return applyPointerPatch(current, pointer, payload.value);
    }, {
      stateRoot: project.stateRoot,
    });
    return { result: { session }, warnings: [] };
  },
  'session.record-baseline': (request, project, dependencies) => operationRecordBaseline(
    project,
    payloadFor(request, [
      'session_id', 'operation_id', 'expected_session_sha256',
      'expected_journal_sha256', 'raw_score', 'normalized_score', 'harness_identity',
    ]),
    dependencies,
  ),
  'session.finish-experiment': (request, project, dependencies) => operationFinishExperiment(
    project,
    payloadFor(request, [
      'session_id', 'operation_id', 'expected_session_sha256',
      'expected_journal_sha256', 'expected_forum_sha256', 'expected_results_sha256',
      'seed_id', 'experiment',
    ]),
    dependencies,
  ),
  'session.record-evaluator-expansion': (request, project, dependencies) => (
    operationRecordEvaluatorExpansion(project, payloadFor(request, [
      'session_id', 'operation_id', 'expected_session_sha256',
      'expected_journal_sha256', 'harness_identity', 'reason', 'trigger_generation',
    ]), dependencies)
  ),
  'session.complete': (request, project, dependencies) => {
    const payload = payloadFor(request, [
      'session_id', 'operation_id', 'expected_session_sha256',
      'expected_journal_sha256', 'outcome', 'final_branch', 'final_commit', 'report',
      'receipt', 'synthesis', 'final_strategy',
    ]);
    const sessionId = ensureSessionId(payload.session_id);
    const compatible = compatibleSessionForDispatch(project, payload);
    if (isStrictSessionVersion(compatible.deep_evolve_version)) {
      return operationCompleteStrict(project, payload, dependencies);
    }
    requireExactPayload(payload, ['session_id', 'outcome']);
    const outcome = payload.outcome === undefined ? null : requireString(payload.outcome, 'payload.outcome');
    updateSessionStatus(project, sessionId, 'completed', 'finished', dependencies, { outcome });
    return { result: { session_id: sessionId, status: 'completed', outcome }, warnings: [] };
  },
  'virtual.init': (request, project) => operationVirtualInit(project,
    payloadFor(request, ['session_id', 'analysis', 'n_chosen', 'total_budget'])),
  'virtual.append-seed': (request, project, dependencies) => operationVirtualAppend(project,
    payloadFor(request, [
      'session_id', 'operation_id', 'expected_session_sha256',
      'expected_journal_sha256', 'seed_id', 'worktree_path', 'branch', 'beta',
      'creation_kind',
    ]), dependencies),
  'virtual.rebuild-seeds': (request, project, dependencies) => operationVirtualRebuild(project,
    payloadFor(request, [
      'session_id', 'operation_id', 'expected_session_sha256',
      'expected_journal_sha256', 'expected_results_sha256',
    ]), dependencies),
  'virtual.set-field': (request, project) => operationVirtualSetField(project,
    payloadFor(request, ['session_id', 'key', 'value'])),
  'metrics.entropy': (request) => {
    const payload = payloadFor(request, ['events', 'window_size']);
    return { result: entropy(payload.events, payload.window_size === undefined ? 20 : payload.window_size), warnings: [] };
  },
  'metrics.migrate-v2-weights': (request) => {
    const payload = payloadFor(request, ['weights']);
    return { result: migrateV2Weights(payload.weights), warnings: [] };
  },
  'metrics.count-flagged': (request) => {
    const payload = payloadFor(request, ['events']);
    return { result: countFlagged(payload.events), warnings: [] };
  },
  'metrics.retry-budget': (request) => {
    const payload = payloadFor(request, ['events', 'cap']);
    return { result: retryBudget(payload.events, payload.cap === undefined ? 10 : payload.cap), warnings: [] };
  },
  'metrics.init-budget-split': (request) => {
    const payload = payloadFor(request, ['total', 'n']);
    return { result: { allocations: initBudgetSplit(payload.total, payload.n) }, warnings: [] };
  },
  'metrics.grow-allocation': (request) => {
    const payload = payloadFor(request, ['pool', 'n_current']);
    return { result: { allocation: growAllocation(payload.pool, payload.n_current) }, warnings: [] };
  },
  'coord.append-journal': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id', 'event', 'seed_id']);
    const sessionId = ensureSessionId(payload.session_id);
    const info = sessionInfo(project, sessionId, { requireDirectory: true });
    if (strictVersionForGenericAppend(info)) {
      assertGenericEventAllowed('journal', payload.event);
    }
    const appended = appendJournalJsonl({
      stateRoot: project.stateRoot,
      relativePath: `${sessionId}/journal.jsonl`,
      event: payload.event,
      sessionId,
      seedId: payload.seed_id,
      now: dependencies.now || Date.now,
    });
    return { result: appended.record, warnings: [] };
  },
  'coord.append-forum': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id', 'event', 'seed_id']);
    const sessionId = ensureSessionId(payload.session_id);
    const info = sessionInfo(project, sessionId, { requireDirectory: true });
    if (strictVersionForGenericAppend(info)) {
      assertGenericEventAllowed('forum', payload.event);
    }
    const appended = appendJournalJsonl({
      stateRoot: project.stateRoot,
      relativePath: `${sessionId}/forum.jsonl`,
      event: payload.event,
      sessionId,
      seedId: payload.seed_id,
      now: dependencies.now || Date.now,
    });
    return { result: appended.record, warnings: [] };
  },
  'coord.tail-forum': (request, project) => {
    const payload = payloadFor(request, ['session_id', 'limit']);
    const sessionId = ensureSessionId(payload.session_id);
    sessionInfo(project, sessionId, { requireDirectory: true });
    const tailed = tailJsonl({
      stateRoot: project.stateRoot,
      relativePath: `${sessionId}/forum.jsonl`,
      limit: payload.limit === undefined ? 20 : payload.limit,
    });
    return { result: { records: tailed.records }, warnings: tailed.warnings };
  },
  'coord.quarantine-malformed': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id', 'file', 'malformed']);
    const sessionId = ensureSessionId(payload.session_id);
    sessionInfo(project, sessionId, { requireDirectory: true });
    const result = quarantineMalformed({
      stateRoot: project.stateRoot,
      relativePath: `${sessionId}/${payload.file}`,
      malformed: payload.malformed,
      now: dependencies.now,
      randomNonce: dependencies.randomNonce,
      platform: dependencies.platform,
      io: dependencies.io,
      onPhase: dependencies.onQuarantinePhase,
      beforeInstall: dependencies.beforeQuarantineInstall,
    });
    return { result, warnings: [] };
  },
  'coord.queue-user-kill': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id', 'seed_id']);
    const sessionId = ensureSessionId(payload.session_id);
    sessionInfo(project, sessionId, { requireDirectory: true });
    return {
      result: queueUserKill({
        stateRoot: project.stateRoot,
        sessionId,
        seedId: payload.seed_id,
        now: dependencies.now || Date.now,
        randomUUID: dependencies.randomUUID || crypto.randomUUID,
      }),
      warnings: [],
    };
  },
  'coord.queue-kill': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id', 'seed_id', 'condition', 'final_q', 'experiments_used']);
    const sessionId = ensureSessionId(payload.session_id);
    sessionInfo(project, sessionId, { requireDirectory: true });
    return {
      result: queueKill({
        stateRoot: project.stateRoot,
        sessionId,
        seedId: payload.seed_id,
        condition: payload.condition,
        finalQ: payload.final_q,
        experimentsUsed: payload.experiments_used,
        now: dependencies.now || Date.now,
        randomUUID: dependencies.randomUUID || crypto.randomUUID,
      }),
      warnings: [],
    };
  },
  'coord.list-user-kill-requests': (request, project) => operationListUserKillRequests(
    project,
    payloadFor(request, ['session_id']),
  ),
  'coord.ack-user-kill-request': (request, project, dependencies) => (
    operationAckUserKillRequest(project, payloadFor(request, [
      'session_id', 'operation_id', 'request_id', 'choice_id',
      'expected_session_sha256', 'expected_journal_sha256',
      'expected_forum_sha256', 'expected_kill_queue_sha256',
      'expected_kill_requests_sha256',
    ]), dependencies)
  ),
  'coord.drain-kill-queue': (request, project, dependencies) => {
    const payload = payloadFor(request, [
      'session_id', 'operation_id', 'expected_session_sha256',
      'expected_journal_sha256', 'expected_kill_queue_sha256',
      'expected_kill_requests_sha256', 'completed_seed_id',
    ]);
    const sessionId = ensureSessionId(payload.session_id);
    const session = compatibleSessionForDispatch(project, payload);
    if (isStrictSessionVersion(session.deep_evolve_version)) {
      return operationDrainKillQueueStrict(project, payload, dependencies);
    }
    requireExactPayload(payload, ['session_id', 'completed_seed_id']);
    sessionInfo(project, sessionId, { requireDirectory: true });
    return {
      result: drainKillQueue({
        stateRoot: project.stateRoot,
        sessionId,
        completedSeedId: payload.completed_seed_id,
        now: dependencies.now || Date.now,
        onPhase: dependencies.onDrainPhase,
      }),
      warnings: [],
    };
  },
  'coord.begin-seed-block': (request, project, dependencies) => (
    operationBeginSeedBlock(project, payloadFor(request, [
      'session_id', 'operation_id', 'decision_id', 'seed_id', 'block_size',
      'pre_dispatch_head', 'expected_epoch', 'budget_preimage',
      'expected_session_sha256', 'expected_journal_sha256',
    ]), dependencies)
  ),
  'coord.finish-seed-block': (request, project, dependencies) => (
    operationFinishSeedBlock(project, payloadFor(request, [
      'session_id', 'operation_id', 'block_id', 'seed_id', 'status', 'returned_head',
      'summary', 'expected_session_sha256', 'expected_journal_sha256',
      'expected_forum_sha256', 'expected_kill_queue_sha256',
      'expected_kill_requests_sha256',
    ]), dependencies)
  ),
  'coord.advance-epoch': (request, project, dependencies) => (
    operationAdvanceEpoch(project, payloadFor(request, [
      'session_id', 'operation_id', 'expected_epoch', 'completed_block_ids', 'reason',
      'expected_session_sha256', 'expected_journal_sha256', 'expected_results_sha256',
    ]), dependencies)
  ),
  'scheduler.signals': (request, project) => {
    const payload = payloadFor(request, ['session_id']);
    const sessionId = ensureSessionId(payload.session_id);
    const info = sessionInfo(project, sessionId, { requireDirectory: true });
    const session = parseStateDocument(fs.readFileSync(info.sessionPath, 'utf8'), { sourcePath: info.sessionPath });
    const journal = readJournalJsonl({ stateRoot: project.stateRoot, relativePath: `${sessionId}/journal.jsonl`, skipMalformed: true });
    const forum = readJournalJsonl({ stateRoot: project.stateRoot, relativePath: `${sessionId}/forum.jsonl`, skipMalformed: true });
    return {
      result: collectSchedulerSignals(session, journal.records, forum.records),
      warnings: [...journal.warnings, ...forum.warnings],
    };
  },
  'scheduler.decide': (request) => {
    const payload = payloadFor(request, ['decision', 'signals']);
    const result = decideScheduler(payload.decision, payload.signals === undefined ? null : payload.signals);
    if (!result.accepted) throw businessError('scheduler_decision_rejected', result.reason, result);
    return { result, warnings: [] };
  },
  'scheduler.kill-conditions': (request) => {
    const payload = payloadFor(request, ['seed', 'session', 'ai_judgments', 'user_kill_request']);
    return { result: evaluateKillConditions(payload), warnings: [] };
  },
  'scheduler.borrow-preflight': (request) => {
    const payload = payloadFor(request, ['self_seed_id', 'self_experiments_used', 'candidates', 'journal', 'forum']);
    return { result: borrowPreflight(payload), warnings: [] };
  },
  'scheduler.borrow-abandoned': (request) => {
    const payload = payloadFor(request, ['events', 'current_block_id', 'staleness_blocks']);
    return {
      result: findBorrowAbandoned(payload.events, payload.current_block_id,
        payload.staleness_blocks === undefined ? 2 : payload.staleness_blocks),
      warnings: [],
    };
  },
  'scheduler.classify-convergence': (request) => {
    const payload = payloadFor(request, [
      'keeps', 'similarities', 'inspired_by_map', 'cross_seed_borrow_events',
      'threshold', 'p3_floor', 'epoch',
    ]);
    return { result: classifyConvergence(payload), warnings: [] };
  },
  'coord.build-seed-prompt': (request, project) => {
    const payload = payloadFor(request, [
      'session_id', 'seed_id', 'block_id', 'decision_id', 'n_block',
    ]);
    const sessionId = ensureSessionId(payload.session_id);
    const seedId = requireInteger(payload.seed_id, 'payload.seed_id', {
      min: 1, max: Number.MAX_SAFE_INTEGER,
    });
    const blockId = requireString(payload.block_id, 'payload.block_id');
    const decisionId = requireString(payload.decision_id, 'payload.decision_id');
    const nBlock = requireInteger(payload.n_block, 'payload.n_block', {
      min: 1, max: Number.MAX_SAFE_INTEGER,
    });
    const info = sessionInfo(project, sessionId, { requireDirectory: true });
    const relativeJournal = relativeSessionSibling(info, 'journal.jsonl');
    let result;
    mutateCoordinationFiles(
      project.stateRoot,
      [info.relativeSession, relativeJournal],
      (files) => {
        const session = assertSessionIdentity(
          parseSessionText(files[info.relativeSession], info.sessionPath),
          info.sessionId,
        );
        if (!isStrictSessionVersion(session.deep_evolve_version)) {
          throw operatorError('seed_dispatch_requires_v35',
            'seed dispatch context requires a v3.5 canonical session');
        }
        const events = validateCommittedJournal(files[relativeJournal])
          .map((record) => record.value);
        result = buildSeedDispatchContext({
          project_root: project.projectRoot,
          session_root: info.sessionRoot,
          session,
          events,
          session_id: sessionId,
          seed_id: seedId,
          block_id: blockId,
          decision_id: decisionId,
          n_block: nBlock,
        }, { platform: process.platform === 'win32' ? 'win32' : 'posix' });
        authenticateSeedDispatchWorktree(info, result);
        return null;
      },
    );
    return { result, warnings: [] };
  },
  'coord.write-seed-program': (request, project) => {
    const payload = payloadFor(request, ['session_id', 'seed_id', 'beta']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    const seedId = requireInteger(payload.seed_id, 'payload.seed_id', { min: 1 });
    const result = writeSeedProgram({
      baseProgramPath: path.join(info.sessionRoot, 'program.md'),
      worktreePath: path.join(info.sessionRoot, 'worktrees', `seed_${seedId}`),
      beta: payload.beta === undefined ? null : payload.beta,
    });
    return { result, warnings: [] };
  },
  'coord.status': (request, project) => {
    const payload = payloadFor(request, ['session_id']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    const texts = task5SessionTexts(project, info, ['session.yaml', 'journal.jsonl', 'forum.jsonl']);
    const session = parseStateDocument(texts['session.yaml'], { sourcePath: info.sessionPath });
    const result = renderStatus({
      session,
      journal_text: texts['journal.jsonl'],
      forum_text: texts['forum.jsonl'],
    });
    return { result: { dashboard: result.dashboard }, warnings: result.warnings };
  },
  'worktree.create-seed': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id', 'seed_id', 'base_commit']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    const result = createSeedWorktree({
      ...task5WorktreeOptions(project, info, dependencies),
      seedId: payload.seed_id,
      baseCommit: payload.base_commit,
    });
    return { result, warnings: [] };
  },
  'worktree.validate-seed': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id', 'seed_id', 'pre_dispatch_head']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    const result = validateSeedWorktree({
      ...task5WorktreeOptions(project, info, dependencies),
      seedId: payload.seed_id,
      preDispatchHead: payload.pre_dispatch_head,
    });
    return { result, warnings: [] };
  },
  'worktree.remove-seed': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id', 'seed_id']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    return {
      result: removeSeedWorktree({
        ...task5WorktreeOptions(project, info, dependencies), seedId: payload.seed_id,
      }),
      warnings: [],
    };
  },
  'worktree.create-synthesis': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id', 'baseline_commit']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    return {
      result: createSynthesisWorktree({
        ...task5WorktreeOptions(project, info, dependencies), baselineCommit: payload.baseline_commit,
      }),
      warnings: [],
    };
  },
  'worktree.cleanup-failed-synthesis': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    return {
      result: cleanupFailedSynthesisWorktree(task5WorktreeOptions(project, info, dependencies)),
      warnings: [],
    };
  },
  'archive.backtrack': (request, project, dependencies) => {
    const payload = payloadFor(request, [
      'session_id', 'candidates', 'strategy', 'fork_number', 'reason', 'program_context',
    ]);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    const journalRelative = relativeSessionSibling(info, 'journal.jsonl');
    const result = backtrackArchive({
      ...task5WorktreeOptions(project, info, dependencies),
      candidates: payload.candidates,
      strategy: payload.strategy,
      forkNumber: payload.fork_number,
      reason: payload.reason,
      programContext: payload.program_context,
      commitState(context) {
        mutateCoordinationFiles(project.stateRoot, [info.relativeSession, journalRelative], (files) => {
          parseJsonl(files[journalRelative], 'journal.jsonl');
          const session = parseStateDocument(files[info.relativeSession], { sourcePath: info.sessionPath });
          const lineage = plainObject(session.lineage) ? { ...session.lineage } : {};
          if (typeof lineage.current_branch === 'string' && lineage.current_branch !== context.previous_branch) {
            throw businessError('branch_mismatch', `session lineage expected '${lineage.current_branch}', actual '${context.previous_branch}'`);
          }
          const previousBranches = Array.isArray(lineage.previous_branches) ? [...lineage.previous_branches] : [];
          previousBranches.push(context.previous_branch);
          session.lineage = {
            ...lineage,
            current_branch: context.branch,
            forked_from: {
              commit: context.commit,
              keep_id: context.selected.id,
              reason: context.reason,
            },
            previous_branches: previousBranches,
          };
          validateStoredSession(session);
          const event = {
            event: 'branch_fork',
            from_commit: context.commit,
            to_branch: context.branch,
            reason: context.reason,
            timestamp: isoNow(dependencies),
          };
          return {
            [info.relativeSession]: serializeStateDocument(session),
            [journalRelative]: appendJsonLine(files[journalRelative], event),
          };
        }, dependencies.storeOptions || {});
      },
    });
    return { result, warnings: [] };
  },
  'archive.save-strategy': (request, project) => {
    const payload = payloadFor(request, ['session_id', 'generation', 'metrics']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    const strategyPath = path.join(info.sessionRoot, 'strategy.yaml');
    const programPath = path.join(info.sessionRoot, 'program.md');
    ensureContainedExisting(project, strategyPath, 'strategy');
    ensureContainedExisting(project, programPath, 'program');
    return {
      result: saveStrategyArchive({
        sessionRoot: info.sessionRoot,
        generation: payload.generation,
        strategyText: fs.readFileSync(strategyPath, 'utf8'),
        programText: fs.readFileSync(programPath, 'utf8'),
        metrics: payload.metrics,
      }),
      warnings: [],
    };
  },
  'archive.restore-strategy': (request, project) => {
    const payload = payloadFor(request, ['session_id', 'generation']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    return { result: restoreStrategyArchive({ sessionRoot: info.sessionRoot, generation: payload.generation }), warnings: [] };
  },
  'archive.fork-strategy': (request, project, dependencies) => {
    const payload = payloadFor(request, ['session_id', 'generations']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    return {
      result: forkStrategyArchive({
        sessionRoot: info.sessionRoot,
        generations: payload.generations,
        lockOptions: dependencies.archiveLockOptions,
      }),
      warnings: [],
    };
  },
  'synthesis.process-beta': (request) => {
    const payload = payloadFor(request, ['mode', 'n', 'project_analysis', 'existing_seeds', 'input']);
    const mode = payload.mode === undefined ? 'init' : payload.mode;
    const result = mode === 'growth'
      ? processBetaGrowth(payload.existing_seeds, payload.input)
      : processBeta(payload.n, payload.input);
    return { result, warnings: [] };
  },
  'synthesis.select-baseline': (request) => {
    const payload = payloadFor(request, ['seeds']);
    return { result: selectBaseline(payload), warnings: [] };
  },
  'synthesis.forum-summary': (request, project) => {
    const payload = payloadFor(request, ['session_id', 'generation']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    const forum = readJournalJsonl({
      stateRoot: project.stateRoot, relativePath: `${info.sessionId}/forum.jsonl`, skipMalformed: true,
    });
    const markdown = renderForumSummary(forum.records, payload.generation);
    const output = task5OutputPath(info, ['meta-analyses', `gen-${payload.generation}`, 'forum-summary.md']);
    atomicWriteFile(output, markdown);
    return { result: { output_path: output, markdown }, warnings: forum.warnings };
  },
  'synthesis.cross-seed-audit': (request, project) => {
    const payload = payloadFor(request, ['session_id']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    const forum = readJournalJsonl({ stateRoot: project.stateRoot, relativePath: `${info.sessionId}/forum.jsonl`, skipMalformed: true });
    const journal = readJournalJsonl({ stateRoot: project.stateRoot, relativePath: `${info.sessionId}/journal.jsonl`, skipMalformed: true });
    const rendered = renderCrossSeedAudit(forum.records, journal.records, [...forum.warnings, ...journal.warnings]);
    const output = task5OutputPath(info, ['completion', 'cross_seed_audit.md']);
    atomicWriteFile(output, rendered.markdown);
    return { result: { output_path: output, markdown: rendered.markdown }, warnings: rendered.warnings };
  },
  'synthesis.write-fallback-note': (request, project) => {
    const payload = payloadFor(request, [
      'session_id', 'baseline_reasoning', 'synthesis_q', 'baseline_q', 'user_choice',
    ]);
    const classification = validateSynthesisChoice(payload.user_choice, 'fallback-note');
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    const text = task5SessionTexts(project, info, ['session.yaml'])['session.yaml'];
    const session = parseStateDocument(text, { sourcePath: info.sessionPath });
    const markdown = renderFallbackNote({
      session,
      baseline_reasoning: payload.baseline_reasoning,
      synthesis_q: payload.synthesis_q,
      baseline_q: payload.baseline_q,
      user_choice: classification,
    });
    const output = task5OutputPath(info, ['completion', 'fallback_note.md']);
    atomicWriteFile(output, markdown);
    return { result: { output_path: output, markdown }, warnings: [] };
  },
  'synthesis.collect': (request) => {
    const payload = payloadFor(request, ['seed_reports', 'baseline_selection', 'cross_seed_audit']);
    return { result: collectSynthesis(payload), warnings: [] };
  },
  'synthesis.finalize': (request) => {
    const payload = payloadFor(request, [
      'n', 'baseline_q', 'synthesis_q', 'regression_tolerance', 'user_choice',
    ]);
    return { result: finalizeSynthesis(payload), warnings: [] };
  },
  'transfer.lookup': (request, _project, dependencies) => {
    const payload = payloadFor(request, ['selected_id']);
    return { result: lookupTransfer({ dataRoot: task5DataRoot(dependencies), selectedId: payload.selected_id }), warnings: [] };
  },
  'transfer.record': (request, _project, dependencies) => {
    const payload = payloadFor(request, ['entry', 'source_id', 'this_session_success']);
    return {
      result: recordTransfer({
        dataRoot: task5DataRoot(dependencies),
        entry: payload.entry,
        sourceId: payload.source_id,
        thisSessionSuccess: payload.this_session_success === undefined ? 0 : payload.this_session_success,
        lockOptions: dependencies.archiveLockOptions,
      }),
      warnings: [],
    };
  },
  'transfer.prune': (request, _project, dependencies) => {
    const payload = payloadFor(request, ['selected_ids']);
    const now = dependencies.now ? dependencies.now() : Date.now();
    return {
      result: pruneTransfer({
        dataRoot: task5DataRoot(dependencies), now,
        selectedIds: payload.selected_ids || [], lockOptions: dependencies.archiveLockOptions,
      }),
      warnings: [],
    };
  },
  'transfer.export-feedback': (request, project, dependencies) => {
    const payload = payloadFor(request, [
      'payload', 'source_artifacts', 'session_id', 'publication_id',
      'expected_session_sha256',
    ]);
    validatePublicationPayload(payload);
    return publishArtifactOperation(request.operation, project, payload, dependencies);
  },
  'artifact.wrap-receipt': (request, project, dependencies) => {
    const payload = payloadFor(request, [
      'payload', 'parent_run_id', 'session_id', 'source_artifacts',
      'source_recurring_findings', 'publication_id', 'expected_session_sha256',
      'legacy_artifact_sha256',
    ]);
    validatePublicationPayload(payload, {
      requireOutcome: true,
      allowParent: true,
      allowRecurring: true,
      allowLegacy: true,
    });
    return publishArtifactOperation(request.operation, project, payload, dependencies);
  },
  'artifact.wrap-insights': (request, project, dependencies) => {
    const payload = payloadFor(request, [
      'payload', 'session_id', 'source_artifacts', 'publication_id',
      'expected_session_sha256', 'legacy_artifact_sha256',
    ]);
    validatePublicationPayload(payload, { allowLegacy: true });
    return publishArtifactOperation(request.operation, project, payload, dependencies);
  },
  'artifact.emit-compaction': (request, project, dependencies) => {
    const payload = payloadFor(request, [
      'payload', 'parent_run_id', 'session_id', 'source_artifacts',
      'publication_id', 'expected_session_sha256',
    ]);
    validatePublicationPayload(payload, { allowParent: true });
    return publishArtifactOperation(request.operation, project, payload, dependencies);
  },
  'artifact.emit-handoff': (request, project, dependencies) => {
    const payload = payloadFor(request, [
      'payload', 'parent_run_id', 'session_id', 'source_artifacts',
      'publication_id', 'expected_session_sha256',
    ]);
    validatePublicationPayload(payload, { allowParent: true });
    return publishArtifactOperation(request.operation, project, payload, dependencies);
  },
  'harness.generate': (request, project) => {
    const payload = payloadFor(request, ['session_id', 'spec']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    return { result: generateHarness(payload.spec, info.sessionRoot), warnings: [] };
  },
  'harness.migrate-legacy': (request, project) => {
    const payload = payloadFor(request, ['session_id']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    return { result: migrateLegacyHarness(info.sessionRoot), warnings: [] };
  },
  'harness.run': (request, project) => {
    const payload = payloadFor(request, ['session_id', 'options']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    return {
      result: runHarness(info.sessionRoot, payload.options === undefined ? {} : payload.options),
      warnings: [],
    };
  },
  'harness.write-baseline': (request, project) => {
    const payload = payloadFor(request, ['session_id', 'raw_score']);
    const info = sessionInfo(project, ensureSessionId(payload.session_id), { requireDirectory: true });
    return { result: writeBaseline(info.sessionRoot, payload.raw_score), warnings: [] };
  },
});

function dispatch(request, dependencies = {}) {
  const operationDescriptor = plainObject(request)
    ? Object.getOwnPropertyDescriptor(request, 'operation')
    : null;
  const operation = operationDescriptor && Object.hasOwn(operationDescriptor, 'value')
    && typeof operationDescriptor.value === 'string'
    ? operationDescriptor.value
    : null;
  try {
    validateRequest(request);
    const project = resolveProject(request.context);
    const recovery = TASK4_OWNS_RECOVERY.has(request.operation)
      ? null
      : recoverProject(project, dependencies);
    const outcome = HANDLERS[request.operation](request, project, dependencies, recovery);
    return successResponse(request.operation, outcome.result, outcome.warnings || []);
  } catch (error) {
    return failureResponse(operation, error);
  }
}

function legacyHelp() {
  return `session-helper.sh v${RUNTIME_VERSION}

Session lifecycle:
  compute_session_id, resolve_current, list_sessions,
  start_new_session, mark_session_status, append_sessions_jsonl,
  migrate_legacy, check_branch_alignment, detect_orphan_experiment,
  append_meta_archive_local, render_inherited_context, lineage_tree

v3.0.0 subcommands (AAR-inspired):
  entropy_compute <journal> [window_size]         — Shannon entropy over recent planned events
  migrate_v2_weights <v2_json>                    — Translate 4-cat v2 weights to 10-cat v3
  count_flagged_since_last_expansion <journal>    — Count shortcut_flagged since last reset
  retry_budget_remaining <journal> [cap]          — Diagnose-retry budget remaining

v3.1.0 subcommands (Virtual Parallel N-seed):
  resolve_helper_path                             — Print absolute path of session-helper.sh
  create_seed_worktree, validate_seed_worktree, remove_seed_worktree
  compute_init_budget_split, compute_grow_allocation
  append_forum_event, tail_forum
  append_journal_event                            — Append validated event to journal.jsonl (§ 6.5, § 9.2)
  append_kill_queue_entry, drain_kill_queue       — In-flight kill deferral (§ 5.5 W-9)
  create_synthesis_worktree, cleanup_failed_synthesis_worktree
  rebuild_seeds_from_journal                      — Resume reconciliation (§ 11 + T46 fold-in)
`;
}

function projectForLegacy(cwd = process.cwd(), { createState = false } = {}) {
  const root = findProjectRoot(cwd) || path.resolve(cwd);
  if (createState && !fs.existsSync(path.join(root, '.deep-evolve'))) {
    fs.mkdirSync(path.join(root, '.deep-evolve'), { recursive: true });
  }
  return fs.realpathSync(root);
}

function castLegacyValue(raw) {
  const original = String(raw ?? '');
  const value = original.trim();
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  if (/^[+-]?\d+$/.test(value)) return legacyIntegerFromToken(value);
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  return original;
}

function legacyIntegerFromToken(token) {
  const integer = BigInt(token);
  if (integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(integer);
  }
  return integer;
}

function legacyIntegerKey(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

function legacyNumericEquals(left, right) {
  const leftInteger = legacyIntegerKey(left);
  const rightInteger = legacyIntegerKey(right);
  if (leftInteger !== null && rightInteger !== null) return leftInteger === rightInteger;
  if (typeof left === 'bigint' && typeof right === 'number') {
    return Number.isFinite(right) && Number.isInteger(right) && left === BigInt(right);
  }
  if (typeof right === 'bigint' && typeof left === 'number') {
    return Number.isFinite(left) && Number.isInteger(left) && right === BigInt(left);
  }
  return left === right;
}

function reviveLegacyIntegerMarkers(value, markers) {
  if (typeof value === 'string' && markers.has(value)) return legacyIntegerFromToken(markers.get(value));
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = reviveLegacyIntegerMarkers(value[index], markers);
    }
  } else if (plainObject(value)) {
    for (const key of Object.keys(value)) value[key] = reviveLegacyIntegerMarkers(value[key], markers);
  }
  return value;
}

function parseLegacyJsonLossless(text) {
  const prefix = `__deep_evolve_integer_${crypto.randomUUID()}_`;
  const markers = new Map();
  let rewritten = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const char = text[index++];
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') break;
      }
      rewritten += text.slice(start, index);
      continue;
    }
    if (text[index] === '-' || /\d/.test(text[index])) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
      if (match) {
        const token = match[0];
        if (/^-?(?:0|[1-9]\d*)$/.test(token)) {
          const marker = `${prefix}${markers.size}`;
          markers.set(marker, token);
          rewritten += JSON.stringify(marker);
        } else rewritten += token;
        index += token.length;
        continue;
      }
    }
    rewritten += text[index];
    index += 1;
  }
  return reviveLegacyIntegerMarkers(JSON.parse(rewritten), markers);
}

function rewriteLegacyInlineIntegers(line, prefix, markers) {
  let rewritten = '';
  let index = 0;
  let quote = null;
  let escaped = false;
  while (index < line.length) {
    const char = line[index];
    if (quote !== null) {
      rewritten += char;
      index += 1;
      if (quote === '"') {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = null;
      } else if (char === quote) {
        if (line[index] === quote) {
          rewritten += line[index];
          index += 1;
        } else quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      rewritten += char;
      index += 1;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      rewritten += line.slice(index);
      break;
    }
    if (char === '+' || char === '-' || /\d/.test(char)) {
      const match = /^[+-]?\d+/.exec(line.slice(index));
      if (match) {
        const token = match[0];
        const immediateAfter = line[index + token.length];
        let beforeIndex = index - 1;
        while (beforeIndex >= 0 && /\s/.test(line[beforeIndex])) beforeIndex -= 1;
        let afterIndex = index + token.length;
        while (afterIndex < line.length && /\s/.test(line[afterIndex])) afterIndex += 1;
        const before = beforeIndex >= 0 ? line[beforeIndex] : '';
        const after = afterIndex < line.length ? line[afterIndex] : '';
        if ('[{,:'.includes(before)
            && (after === '' || ',]}#'.includes(after))
            && !(immediateAfter && /[.eE\w]/.test(immediateAfter))) {
          const marker = `${prefix}${markers.size}`;
          markers.set(marker, token);
          rewritten += JSON.stringify(marker);
          index += token.length;
          continue;
        }
      }
    }
    rewritten += char;
    index += 1;
  }
  return rewritten;
}

function parseLegacyStateDocument(text, sourcePath) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseLegacyJsonLossless(trimmed);
  const prefix = `__deep_evolve_yaml_integer_${crypto.randomUUID()}_`;
  const markers = new Map();
  const rewritten = text.split(/(?<=\n)/).map((line) => {
    const newline = line.endsWith('\n') ? '\n' : '';
    const originalBody = newline ? line.slice(0, -1) : line;
    const body = /[\[{]/.test(originalBody)
      ? rewriteLegacyInlineIntegers(originalBody, prefix, markers)
      : originalBody;
    const match = /^(\s*(?:-\s+)?(?:[A-Za-z_][A-Za-z0-9_-]*\s*:\s*)?)([+-]?\d+)(\s*(?:#.*)?)$/.exec(body);
    if (!match) return `${body}${newline}`;
    const marker = `${prefix}${markers.size}`;
    markers.set(marker, match[2]);
    return `${match[1]}${JSON.stringify(marker)}${match[3]}${newline}`;
  }).join('');
  return reviveLegacyIntegerMarkers(parseStateDocument(rewritten, { sourcePath }), markers);
}

function serializeLegacyStateDocument(value) {
  const marker = `__deep_evolve_bigint_${crypto.randomUUID()}_`;
  const integers = [];
  let text = JSON.stringify(value, (_key, item) => {
    if (typeof item !== 'bigint') return item;
    const placeholder = `${marker}${integers.length}`;
    integers.push({ placeholder, token: item.toString() });
    return placeholder;
  }, 2);
  for (const { placeholder, token } of integers) {
    text = text.split(JSON.stringify(placeholder)).join(token);
  }
  return `${text}\n`;
}

function legacyIntegerCoerce(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    return legacyIntegerFromToken(value.trim());
  }
  throw new TypeError(`cannot convert ${JSON.stringify(value)} to integer`);
}

function legacyFloorDivide(left, right) {
  if (typeof left !== 'bigint' && typeof right !== 'bigint') return Math.floor(left / right);
  const dividend = typeof left === 'bigint' ? left : BigInt(left);
  const divisor = typeof right === 'bigint' ? right : BigInt(right);
  let quotient = dividend / divisor;
  if (dividend % divisor !== 0n && (dividend < 0n) !== (divisor < 0n)) quotient -= 1n;
  return legacyIntegerFromToken(quotient.toString());
}

function legacyCoordinationOptions(dependencies = {}) {
  return plainObject(dependencies.coordinationOptions) ? dependencies.coordinationOptions : {};
}

function legacyCoordinationContextForDirectory(directory) {
  const targetDirectory = path.resolve(directory);
  let current = targetDirectory;
  for (;;) {
    if (path.basename(current) === '.deep-evolve') {
      return {
        stateRoot: current,
        relative(directoryPath) {
          return path.relative(current, directoryPath).split(path.sep).join('/');
        },
      };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return {
    stateRoot: targetDirectory,
    relative(directoryPath) {
      return path.relative(targetDirectory, directoryPath).split(path.sep).join('/');
    },
  };
}

function bindLegacySessionDirectory(directory, { requireDirectory = true } = {}) {
  const publicSessionRoot = path.resolve(directory);
  const lexicalContext = legacyCoordinationContextForDirectory(publicSessionRoot);
  if (path.basename(lexicalContext.stateRoot) !== '.deep-evolve'
      || path.dirname(publicSessionRoot) !== lexicalContext.stateRoot) {
    return {
      sessionRoot: publicSessionRoot,
      publicSessionRoot,
      context: lexicalContext,
    };
  }
  const project = resolveProject({ project_root: path.dirname(lexicalContext.stateRoot) });
  const info = sessionInfo(project, path.basename(publicSessionRoot), { requireDirectory });
  return {
    sessionRoot: info.sessionRoot,
    publicSessionRoot: info.publicSessionRoot,
    context: {
      stateRoot: project.stateRoot,
      relative(candidate) {
        return path.relative(project.stateRoot, candidate).split(path.sep).join('/');
      },
    },
  };
}

function legacyProjectWithRecovery(projectRoot, dependencies = {}) {
  const stateRoot = path.join(projectRoot, '.deep-evolve');
  if (!fs.existsSync(stateRoot)) return { projectRoot, stateRoot, stateExists: false };
  const project = resolveProject({ project_root: projectRoot });
  recoverProject(project, dependencies);
  return { ...project, stateExists: true };
}

function readLegacyVirtualSessionText(text, sessionPath) {
  const session = text === '' ? {} : parseLegacyStateDocument(text, sessionPath);
  if (!plainObject(session)) throw operatorError('session_state_invalid', 'session.yaml must contain a mapping');
  return session;
}

function rebuildLegacyVirtualSeeds(session, journalText) {
  const events = [];
  for (const line of journalText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = parseLegacyJsonLossless(line);
      if (!plainObject(event)) continue;
      const token = /"seed_id"\s*:\s*(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(line);
      const pythonInteger = typeof event.seed_id === 'boolean'
        || typeof event.seed_id === 'bigint'
        || (typeof event.seed_id === 'number' && token && /^-?\d+$/.test(token[1]));
      if (!pythonInteger) continue;
      events.push(event);
    } catch {}
  }
  const seeds = new Map();
  for (const event of events) {
    const seedId = event.seed_id;
    const seedKey = legacyIntegerKey(seedId);
    if (event.event === 'seed_initialized') {
      seeds.set(seedKey, {
        id: seedId,
        status: 'active',
        direction: event.direction ?? event.beta_direction ?? null,
        hypothesis: event.hypothesis ?? null,
        initial_rationale: event.initial_rationale ?? null,
        worktree_path: event.worktree_path ?? null,
        branch: event.branch ?? null,
        created_by: event.created_by ?? 'init_batch',
        experiments_used: 0,
        keeps: 0,
        borrows_given: 0,
        borrows_received: 0,
        current_q: 0,
        killed_at: null,
        killed_reason: null,
        created_at: event.ts ?? null,
      });
    } else if (event.event === 'seed_killed' && seeds.has(seedKey)) {
      const seed = seeds.get(seedKey);
      const raw = event.condition === undefined || event.condition === null ? 'killed' : String(event.condition);
      seed.status = raw.startsWith('killed') ? raw : `killed_${raw}`;
      seed.killed_at = event.ts ?? null;
      seed.killed_reason = raw.startsWith('killed_') ? raw.slice('killed_'.length) : raw;
      if (event.reasoning !== undefined && event.reasoning !== null) seed.killed_reasoning = String(event.reasoning);
      if (Object.hasOwn(event, 'final_q')) seed.final_q = event.final_q;
      if (Object.hasOwn(event, 'experiments_used')) seed.experiments_used = event.experiments_used;
    }
  }
  const rebuilt = [...seeds.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, seed]) => seed);
  const virtual = plainObject(session.virtual_parallel) ? session.virtual_parallel : {};
  session.virtual_parallel = {
    ...virtual,
    seeds: rebuilt,
    n_current: rebuilt.filter((seed) => seed.status === 'active').length,
  };
  return session;
}

function runLegacyVirtualDirect(subcommand, args, env = process.env, dependencies = {}) {
  const publicSessionRoot = path.resolve(env.SESSION_ROOT);
  const recoveryContext = legacyCoordinationContextForDirectory(publicSessionRoot);
  const options = legacyCoordinationOptions(dependencies);
  const recovery = recoverTransactions(recoveryContext.stateRoot, options);
  if (recovery && recovery.ok === false) {
    process.stderr.write(`${recovery.error ? recovery.error.message : 'coordination recovery failed'}\n`);
    return 2;
  }
  const binding = bindLegacySessionDirectory(publicSessionRoot);
  const sessionRoot = binding.sessionRoot;
  const sessionPath = path.join(sessionRoot, 'session.yaml');
  const journalPath = path.join(sessionRoot, 'journal.jsonl');
  const context = binding.context;

  let analysis;
  let n;
  let budget;
  let seedId;
  let beta;
  if (subcommand === 'init_virtual_parallel_block') {
    try { analysis = parseLegacyJsonLossless(args[0]); }
    catch {
      process.stderr.write('error: vp_analysis is not valid JSON\n');
      return 2;
    }
    const nRaw = String(args[1] ?? '').trim();
    const budgetRaw = String(args[2] ?? '').trim();
    const parsedN = /^[+-]?\d+$/.test(nRaw) ? legacyIntegerFromToken(nRaw) : null;
    budget = /^[+-]?\d+$/.test(budgetRaw) ? legacyIntegerFromToken(budgetRaw) : null;
    if (parsedN === null || budget === null) {
      process.stderr.write('error: n_chosen / total_budget must be integers\n');
      return 2;
    }
    const nInteger = typeof parsedN === 'bigint' ? parsedN : BigInt(parsedN);
    if (nInteger < 1n || nInteger > 9n) {
      process.stderr.write(`error: n_chosen=${parsedN} outside [1,9]\n`);
      return 2;
    }
    n = Number(nInteger);
    const budgetInteger = typeof budget === 'bigint' ? budget : BigInt(budget);
    if (budgetInteger < nInteger) {
      process.stderr.write(`error: total_budget=${budget} < n_chosen=${n}\n`);
      return 2;
    }
    if (!plainObject(analysis) || !Object.hasOwn(analysis, 'project_type')) {
      process.stderr.write('Traceback (most recent call last):\n  File "<stdin>", line 22, in <module>\n');
      process.stderr.write(plainObject(analysis)
        ? "KeyError: 'project_type'\n"
        : `TypeError: ${analysis === null ? "'NoneType' object is not subscriptable" : 'list indices must be integers or slices, not str'}\n`);
      return 1;
    }
    if (!Object.hasOwn(analysis, 'eval_parallelizability')) {
      process.stderr.write('Traceback (most recent call last):\n  File "<stdin>", line 23, in <module>\n');
      process.stderr.write("KeyError: 'eval_parallelizability'\n");
      return 1;
    }
  } else if (subcommand === 'append_seed_to_session_yaml') {
    const seedRaw = String(args[0] ?? '').trim();
    seedId = /^[+-]?\d+$/.test(seedRaw) ? legacyIntegerFromToken(seedRaw) : null;
    if (seedId === null) {
      process.stderr.write('Traceback (most recent call last):\n  File "<stdin>", line 4, in <module>\n');
      process.stderr.write(`ValueError: invalid literal for int() with base 10: '${String(args[0] ?? '')}'\n`);
      return 1;
    }
    beta = {};
    try { beta = args[3] ? parseLegacyJsonLossless(args[3]) : {}; }
    catch {
      process.stderr.write('beta_json is not valid JSON\n');
      return 2;
    }
    if (!plainObject(beta)) {
      const typeName = beta === null ? 'NoneType' : Array.isArray(beta) ? 'list' : typeof beta;
      process.stderr.write('Traceback (most recent call last):\n  File "<stdin>", line 36, in <module>\n');
      process.stderr.write(`AttributeError: '${typeName}' object has no attribute 'get'\n`);
      return 1;
    }
  }

  const sessionRelative = context.relative(sessionPath);
  const journalRelative = context.relative(journalPath);
  mutateCoordinationFiles(context.stateRoot, [sessionRelative, journalRelative], (files, snapshot) => {
    if (!snapshot.exists[sessionRelative]) throw operatorError('legacy_session_missing', 'session.yaml missing');
    const journalExists = snapshot.exists[journalRelative];
    if (subcommand === 'rebuild_seeds_from_journal' && !journalExists) {
      throw operatorError('legacy_journal_missing', 'journal.jsonl missing');
    }
    const session = readLegacyVirtualSessionText(files[sessionRelative], sessionPath);
    if (subcommand === 'init_virtual_parallel_block') {
      const virtual = plainObject(session.virtual_parallel) ? session.virtual_parallel : {};
      session.virtual_parallel = {
        ...virtual,
        enabled: true,
        n_current: n,
        n_initial: n,
        n_range: { min: 1, max: 9 },
        project_type: analysis.project_type,
        eval_parallelizability: analysis.eval_parallelizability,
        selection_reason: Object.hasOwn(analysis, 'reasoning') ? analysis.reasoning : '',
        budget_total: budget,
        budget_unallocated: 0,
        synthesis: {
          ...(plainObject(virtual.synthesis) ? virtual.synthesis : {}),
          budget_allocated: Math.min(2 * n, 10),
          regression_tolerance: 0.05,
        },
        seeds: Array.isArray(virtual.seeds) ? virtual.seeds : [],
      };
    } else if (subcommand === 'set_virtual_parallel_field') {
      const virtual = plainObject(session.virtual_parallel) ? session.virtual_parallel : {};
      session.virtual_parallel = { ...virtual, [args[0]]: castLegacyValue(args[1] || '') };
    } else if (subcommand === 'append_seed_to_session_yaml') {
      const virtual = plainObject(session.virtual_parallel) ? session.virtual_parallel : {};
      const seeds = Array.isArray(virtual.seeds) ? [...virtual.seeds] : [];
      let createdAt = null;
      if (journalExists) {
        for (const line of files[journalRelative].split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const event = parseLegacyJsonLossless(line);
            if (plainObject(event) && event.event === 'seed_initialized'
                && legacyNumericEquals(event.seed_id, seedId) && event.ts) createdAt = event.ts;
          } catch {}
        }
      }
      if (!createdAt) {
        createdAt = isoNow(dependencies);
        process.stderr.write(`warn: cmd_append_seed_to_session_yaml: no journal seed_initialized for seed ${seedId}; using now()\n`);
      }
      const total = legacyIntegerCoerce(virtual.budget_total || 0);
      const parsedInitial = legacyIntegerCoerce(virtual.n_initial || 1);
      const initial = (typeof parsedInitial === 'bigint' ? parsedInitial > 0n : parsedInitial > 0)
        ? parsedInitial : 1;
      const entry = {
        id: seedId,
        status: 'active',
        direction: beta.direction !== undefined ? beta.direction : null,
        hypothesis: beta.hypothesis !== undefined ? beta.hypothesis : null,
        initial_rationale: beta.rationale !== undefined ? beta.rationale : null,
        worktree_path: args[1],
        branch: args[2],
        created_at: createdAt,
        created_by: 'init_batch',
        experiments_used: 0,
        keeps: 0,
        borrows_given: 0,
        borrows_received: 0,
        current_q: 0,
        allocated_budget: legacyFloorDivide(total, initial),
        killed_at: null,
        killed_reason: null,
      };
      const index = seeds.findIndex((seed) => seed && legacyNumericEquals(seed.id, seedId));
      if (index >= 0) seeds[index] = entry;
      else seeds.push(entry);
      session.virtual_parallel = { ...virtual, seeds };
    } else if (subcommand === 'rebuild_seeds_from_journal') {
      rebuildLegacyVirtualSeeds(session, files[journalRelative]);
    }
    return { [sessionRelative]: serializeLegacyStateDocument(session) };
  }, options);
  return 0;
}

function legacyRequest(projectRoot, operation, payload, dependencies = {}) {
  return dispatch({ schema_version: '1.0', operation, context: { project_root: projectRoot }, payload }, dependencies);
}

function replaceLegacyStatusText(text, status, sessionPath) {
  const yamlStyle = text.replace(/^status:.*$/gm, `status: ${status}`);
  if (yamlStyle !== text) return yamlStyle;
  try {
    const parsed = parseStateDocument(text, { sourcePath: sessionPath });
    if (plainObject(parsed) && Object.hasOwn(parsed, 'status')) {
      return serializeStateDocument({ ...parsed, status });
    }
  } catch {}
  return text;
}

function runLegacyMarkStatus(projectRoot, sessionId, status, dependencies = {}) {
  const stateRoot = path.join(projectRoot, '.deep-evolve');
  if (!fs.existsSync(stateRoot)) {
    process.stderr.write('session-helper: lock acquisition timeout\n');
    return 1;
  }
  const project = legacyProjectWithRecovery(projectRoot, dependencies);
  const options = legacyCoordinationOptions(dependencies);
  try {
    const binding = bindLegacySessionDirectory(
      path.join(stateRoot, sessionId), { requireDirectory: false },
    );
    const sessionPath = path.join(binding.sessionRoot, 'session.yaml');
    const sessionRelative = binding.context.relative(sessionPath);
    mutateCoordinationFiles(project.stateRoot, [sessionRelative, 'sessions.jsonl'], (files, snapshot) => {
      const record = {
        event: 'status_change',
        ts: isoNow(dependencies),
        session_id: sessionId,
        status,
      };
      const replacements = {
        'sessions.jsonl': appendJsonLine(files['sessions.jsonl'], record),
      };
      if (snapshot.exists[sessionRelative]) {
        replacements[sessionRelative] = replaceLegacyStatusText(files[sessionRelative], status, sessionPath);
      }
      return replacements;
    }, options);
    return 0;
  } catch (error) {
    if (error && error.code === 'lock_held') {
      process.stderr.write('session-helper: lock acquisition timeout\n');
      return 1;
    }
    throw error;
  }
}

function printLegacyFailure(response, subcommand, args = [], projectRoot = process.cwd()) {
  if (subcommand === 'resolve_current') {
    process.stderr.write(`session-helper: ${response.error.message}\n`);
    if (response.error.code === 'orphan_pointer') {
      process.stderr.write("session-helper: run 'list_sessions' to find available sessions\n");
    }
  } else if (subcommand === 'append_meta_archive_local' && response.error.code === 'receipt_missing') {
    process.stderr.write(`session-helper: receipt not found for ${args[0] || ''}\n`);
  } else if (subcommand === 'render_inherited_context' && response.error.code === 'parent receipt_missing') {
    process.stderr.write(`session-helper: parent receipt not found at ${path.join(projectRoot, '.deep-evolve', args[0] || '', RECEIPT_FILE)}\n`);
  } else if (subcommand === 'migrate_legacy' && response.error.code === 'no_legacy_layout') {
    process.stderr.write('session-helper: no legacy layout to migrate\n');
  } else if (subcommand === 'start_new_session' && response.error.code === 'session_id_collision') {
    process.stderr.write(`session-helper: ${response.error.message}\n`);
  } else {
    process.stderr.write(`${response.error.message}\n`);
  }
  return response.exitCode;
}

function runLegacyResolveCurrent(projectRoot, dependencies = {}) {
  const project = legacyProjectWithRecovery(projectRoot, dependencies);
  const stateRoot = project.stateRoot;
  const currentPath = path.join(stateRoot, 'current.json');
  if (!project.stateExists || !fs.existsSync(currentPath)) {
    process.stderr.write('session-helper: no active session (current.json missing)\n');
    return 1;
  }
  const options = legacyCoordinationOptions(dependencies);
  const currentText = readCoordinationFiles(stateRoot, ['current.json'], options)['current.json'];
  let pointer;
  try { pointer = JSON.parse(currentText); }
  catch { return 5; }
  const rawSessionId = pointer && pointer.session_id;
  if (rawSessionId === null || rawSessionId === undefined || rawSessionId === '') {
    process.stderr.write('session-helper: no active session (session_id null)\n');
    return 1;
  }
  const sessionId = String(rawSessionId);
  const publicSessionRoot = path.join(stateRoot, sessionId);
  if (!fs.existsSync(publicSessionRoot) || !fs.statSync(publicSessionRoot).isDirectory()) {
    process.stderr.write(`session-helper: orphan pointer — session dir missing: ${publicSessionRoot}\n`);
    process.stderr.write("session-helper: run 'list_sessions' to find available sessions\n");
    return 1;
  }
  const info = sessionInfo(project, sessionId, { requireDirectory: true });
  const sessionPath = info.sessionPath;
  if (!fs.existsSync(sessionPath) || !fs.statSync(sessionPath).isFile()) {
    process.stderr.write(`session-helper: session dir exists but session.yaml missing: ${publicSessionRoot}\n`);
    return 1;
  }

  const sessionRelative = info.relativeSession;
  mutateCoordinationFiles(stateRoot, ['current.json', sessionRelative, 'sessions.jsonl'], (files) => {
    let lockedPointer;
    try { lockedPointer = JSON.parse(files['current.json']); }
    catch { throw operatorError('invalid_json', 'current.json is not valid JSON'); }
    if (String(lockedPointer && lockedPointer.session_id) !== sessionId) {
      throw businessError('current_changed', 'current session changed while resolving');
    }
    const statusLine = files[sessionRelative].split(/\r?\n/)
      .find((line) => line.startsWith('status:'));
    let actualStatus = statusLine ? statusLine.replace(/^status:\s*/, '') : '';
    if (!actualStatus) {
      try {
        const parsed = parseStateDocument(files[sessionRelative], { sourcePath: sessionPath });
        actualStatus = parsed && parsed.status !== undefined ? String(parsed.status) : '';
      } catch {}
    }
    let recordedStatus = '';
    for (const line of files['sessions.jsonl'].split(/\r?\n/)) {
      if (!line.includes(`"session_id":"${sessionId}"`)
          || !/"event":"(?:status_change|finished|created)"/.test(line)) continue;
      try {
        const event = JSON.parse(line);
        recordedStatus = event.status === null || event.status === undefined ? '' : String(event.status);
      } catch {}
    }
    if (!recordedStatus || !actualStatus || recordedStatus === actualStatus) return null;
    return {
      'current.json': files['current.json'],
      [sessionRelative]: files[sessionRelative],
      'sessions.jsonl': appendJsonLine(files['sessions.jsonl'], {
        event: 'reconciled',
        ts: isoNow(dependencies),
        session_id: sessionId,
        from: recordedStatus,
        to: actualStatus,
      }),
    };
  }, options);
  process.stdout.write(`${sessionId}\t${publicSessionRoot}\n`);
  return 0;
}

function runLegacyListSessions(projectRoot, args, dependencies = {}) {
  const project = legacyProjectWithRecovery(projectRoot, dependencies);
  const registryPath = path.join(project.stateRoot, 'sessions.jsonl');
  if (!project.stateExists || !fs.existsSync(registryPath)) {
    process.stdout.write('[]\n');
    return 0;
  }
  const records = [];
  const registryText = readCoordinationFiles(project.stateRoot, ['sessions.jsonl'],
    legacyCoordinationOptions(dependencies))['sessions.jsonl'];
  const lines = registryText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let value;
    try { value = JSON.parse(lines[index]); }
    catch {
      process.stderr.write(`jq: parse error: Invalid numeric literal at line ${index + 2}, column 0\n`);
      return 5;
    }
    if (!plainObject(value)) {
      const typeName = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      process.stderr.write(`jq: error (at ${registryPath}:${index + 1}): Cannot index ${typeName} with string "event"\n`);
      return 5;
    }
    records.push(value);
  }
  let sessions = foldSessions(records);
  const status = args.find((arg) => arg.startsWith('--status='));
  if (status) sessions = sessions.filter((session) => session.status === status.slice('--status='.length));
  process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
  return 0;
}

function legacyReceiptIsInvalid(receiptPath) {
  try {
    JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    return false;
  } catch {
    return true;
  }
}

function writeLegacyJqParseFailure() {
  process.stderr.write('jq: parse error: Invalid numeric literal at line 2, column 0\n');
  return 5;
}

function task4LegacyEvents(filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const warnings = [];
  return parseJsonl(fs.readFileSync(filePath, 'utf8'), path.basename(filePath), {
    skipMalformed: true,
    warnings,
  });
}

function task4LegacySession(env, cwd) {
  if (!env.SESSION_ROOT) throw operatorError('session_root_missing', 'SESSION_ROOT not set');
  let sessionRoot;
  try { sessionRoot = fs.realpathSync(env.SESSION_ROOT); }
  catch { throw operatorError('session_root_missing', `SESSION_ROOT does not exist: ${env.SESSION_ROOT}`); }
  const stateRoot = path.dirname(sessionRoot);
  if (path.basename(stateRoot) !== '.deep-evolve') {
    throw operatorError('session_root_invalid', 'SESSION_ROOT must be a direct child of .deep-evolve');
  }
  const projectRoot = path.dirname(stateRoot);
  const discovered = findProjectRoot(cwd) || projectRoot;
  if (fs.realpathSync(discovered) !== fs.realpathSync(projectRoot)) {
    throw operatorError('session_root_invalid', 'SESSION_ROOT does not belong to the current project');
  }
  return { projectRoot, stateRoot, sessionRoot, sessionId: path.basename(sessionRoot) };
}

function legacyJsonArgument(raw, label) {
  let value;
  try { value = JSON.parse(raw); }
  catch { throw operatorError('invalid_json', `${label}: invalid JSON`); }
  if (!plainObject(value)) throw operatorError('invalid_object', `${label} must be a JSON object`);
  return value;
}

function legacyPythonJson(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(legacyPythonJson).join(', ')}]`;
  if (plainObject(value)) {
    return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}: ${legacyPythonJson(entry)}`).join(', ')}}`;
  }
  throw operatorError('invalid_json_value', 'legacy JSON output contains an unsupported value');
}

function runTask4Legacy(subcommand, args, env, cwd, dependencies) {
  if (subcommand === 'entropy_compute') {
    const events = task4LegacyEvents(args[0]);
    if (events === null) {
      process.stderr.write('{"error":"missing or nonexistent journal path"}\n');
      return 1;
    }
    const windowSize = args[1] === undefined ? 20 : Number(args[1]);
    if (!Number.isInteger(windowSize)) {
      process.stderr.write('entropy_compute: window_size must be an integer\n');
      return 2;
    }
    process.stdout.write(`${legacyPythonJson(entropy(events, windowSize))}\n`);
    return 0;
  }
  if (subcommand === 'migrate_v2_weights') {
    if (!args[0] || !fs.existsSync(args[0]) || !fs.statSync(args[0]).isFile()) {
      process.stderr.write('{"error":"missing or nonexistent v2 weights JSON"}\n');
      return 1;
    }
    let weights;
    try { weights = JSON.parse(fs.readFileSync(args[0], 'utf8')); }
    catch {
      process.stderr.write('migrate_v2_weights: invalid JSON\n');
      return 2;
    }
    process.stdout.write(`${legacyPythonJson(migrateV2Weights(weights))}\n`);
    return 0;
  }
  if (subcommand === 'count_flagged_since_last_expansion') {
    const events = task4LegacyEvents(args[0]);
    if (events === null) {
      process.stderr.write('{"error":"missing or nonexistent journal path"}\n');
      return 1;
    }
    process.stdout.write(`${legacyPythonJson(countFlagged(events))}\n`);
    return 0;
  }
  if (subcommand === 'retry_budget_remaining') {
    const events = task4LegacyEvents(args[0]);
    if (events === null) {
      process.stderr.write('{"error":"missing or nonexistent journal path"}\n');
      return 1;
    }
    const cap = args[1] === undefined ? 10 : Number(args[1]);
    if (!Number.isInteger(cap) || cap < 0) {
      process.stderr.write('retry_budget_remaining: cap must be a non-negative integer\n');
      return 2;
    }
    process.stdout.write(`${legacyPythonJson(retryBudget(events, cap))}\n`);
    return 0;
  }
  if (subcommand === 'compute_init_budget_split') {
    if (args.length < 2) {
      process.stderr.write('usage: compute_init_budget_split <total> <N>\n');
      return 2;
    }
    if (!/^\d+$/.test(args[0]) || !/^[1-9]\d*$/.test(args[1])) {
      process.stderr.write('compute_init_budget_split: total and N must be non-negative/positive integers\n');
      return 2;
    }
    try {
      process.stdout.write(initBudgetSplit(Number(args[0]), Number(args[1])).join(' '));
      return 0;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      return error.rc === 1 ? 1 : 2;
    }
  }
  if (subcommand === 'compute_grow_allocation') {
    if (args.length < 2) {
      process.stderr.write('usage: compute_grow_allocation <pool> <current_N>\n');
      return 2;
    }
    if (!/^\d+$/.test(args[0]) || !/^[1-9]\d*$/.test(args[1])) {
      process.stderr.write('compute_grow_allocation: pool and current_N must be non-negative/positive integers\n');
      return 2;
    }
    try {
      process.stdout.write(`${growAllocation(Number(args[0]), Number(args[1]))}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      return error.rc === 1 ? 1 : 2;
    }
  }
  if (![
    'append_forum_event', 'tail_forum', 'append_journal_event',
    'append_kill_queue_entry', 'drain_kill_queue',
  ].includes(subcommand)) return null;

  let context;
  try { context = task4LegacySession(env, cwd); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  try {
    if (subcommand === 'append_forum_event') {
      if (!args[0]) throw operatorError('usage', 'usage: append_forum_event <json>');
      const event = legacyJsonArgument(args[0], 'append_forum_event');
      appendJournalJsonl({
        stateRoot: context.stateRoot,
        relativePath: `${context.sessionId}/forum.jsonl`,
        event,
        now: dependencies.now || Date.now,
      });
      return 0;
    }
    if (subcommand === 'tail_forum') {
      const limit = args[0] === undefined ? 20 : Number(args[0]);
      if (!Number.isInteger(limit) || limit < 0) throw operatorError('invalid_field_type', 'tail_forum N must be a non-negative integer');
      const tailed = tailJsonl({
        stateRoot: context.stateRoot,
        relativePath: `${context.sessionId}/forum.jsonl`,
        limit,
      });
      for (const warning of tailed.warnings) process.stderr.write(`warn: tail_forum: skipped malformed JSONL line ${warning.line}\n`);
      for (const event of tailed.records) process.stdout.write(`${JSON.stringify(event)}\n`);
      return 0;
    }
    if (subcommand === 'append_journal_event') {
      if (!args[0]) throw operatorError('usage', 'usage: append_journal_event <json>');
      if (!env.SESSION_ID) throw operatorError('session_id_missing', 'SESSION_ID not set');
      const event = legacyJsonArgument(args[0], 'append_journal_event');
      let seedId;
      if (env.SEED_ID !== undefined && env.SEED_ID !== '') {
        if (!/^[1-9]\d*$/.test(env.SEED_ID)) throw operatorError('invalid_seed_id', 'SEED_ID must be a positive integer');
        seedId = Number(env.SEED_ID);
      }
      appendJournalJsonl({
        stateRoot: context.stateRoot,
        relativePath: `${context.sessionId}/journal.jsonl`,
        event,
        sessionId: env.SESSION_ID,
        seedId,
        now: dependencies.now || Date.now,
      });
      return 0;
    }
    if (subcommand === 'append_kill_queue_entry') {
      if (args.length < 4) throw operatorError('usage', 'usage: append_kill_queue_entry <seed_id> <condition> <final_q> <experiments_used>');
      if (!/^[1-9]\d*$/.test(args[0]) || !/^-?\d+(?:\.\d+)?$/.test(args[2]) || !/^\d+$/.test(args[3])) {
        throw operatorError('invalid_field_type', 'append_kill_queue_entry numeric field is invalid');
      }
      queueKill({
        stateRoot: context.stateRoot,
        sessionId: context.sessionId,
        seedId: Number(args[0]),
        condition: args[1],
        finalQ: Number(args[2]),
        experimentsUsed: Number(args[3]),
        now: dependencies.now || Date.now,
        randomUUID: dependencies.randomUUID || crypto.randomUUID,
      });
      return 0;
    }
    if (!args[0] || !/^[1-9]\d*$/.test(args[0])) throw operatorError('invalid_field_type', 'drain_kill_queue completed_seed_id must be a positive integer');
    if (!env.SESSION_ID) throw operatorError('session_id_missing', 'drain_kill_queue: SESSION_ID not set');
    const result = drainKillQueue({
      stateRoot: context.stateRoot,
      sessionId: context.sessionId,
      completedSeedId: Number(args[0]),
      now: dependencies.now || Date.now,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return error.rc === 1 ? 1 : 2;
  }
}

function runTask5Legacy(subcommand, args, env, cwd, dryRun, dependencies) {
  if (![
    'create_seed_worktree', 'validate_seed_worktree', 'remove_seed_worktree',
    'create_synthesis_worktree', 'cleanup_failed_synthesis_worktree',
  ].includes(subcommand)) return null;
  if (!env.SESSION_ROOT) {
    process.stderr.write(`${subcommand}: SESSION_ROOT not set\n`);
    return 2;
  }
  if (!env.SESSION_ID) {
    process.stderr.write(`${subcommand}: SESSION_ID not set\n`);
    return 2;
  }
  let context;
  try { context = task4LegacySession(env, cwd); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const common = {
    projectRoot: context.projectRoot,
    sessionRoot: context.sessionRoot,
    sessionId: env.SESSION_ID,
    spawnSync: dependencies.spawnSync,
    now: dependencies.now,
    randomUUID: dependencies.randomUUID,
    onPhase: dependencies.onWorktreePhase,
  };
  if (dryRun) {
    process.stderr.write(`[dry-run] would execute native ${subcommand}\n`);
    return 0;
  }
  try {
    if (['create_seed_worktree', 'validate_seed_worktree', 'remove_seed_worktree'].includes(subcommand)) {
      if (!args[0]) {
        process.stderr.write(`usage: ${subcommand} <seed_id>${subcommand === 'validate_seed_worktree' ? ' [pre_head]' : ''}\n`);
        return 2;
      }
      if (!/^[1-9]\d*$/.test(args[0])) throw operatorError('invalid_seed_id', 'seed_id must be a positive integer');
      const seedId = Number(args[0]);
      if (subcommand === 'create_seed_worktree') {
        const result = createSeedWorktree({ ...common, seedId });
        process.stdout.write(`${seedId}\t${result.worktree_path}\t${result.branch}\n`);
      } else if (subcommand === 'validate_seed_worktree') {
        validateSeedWorktree({ ...common, seedId, preDispatchHead: args[1] || undefined });
        process.stdout.write('clean\n');
      } else removeSeedWorktree({ ...common, seedId });
      return 0;
    }
    if (subcommand === 'create_synthesis_worktree') {
      if (!args[0]) {
        process.stderr.write('usage: create_synthesis_worktree <baseline_commit>\n');
        return 2;
      }
      createSynthesisWorktree({ ...common, baselineCommit: args[0] });
      return 0;
    }
    cleanupFailedSynthesisWorktree(common);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (subcommand === 'validate_seed_worktree') {
      const exitCodes = {
        worktree_missing: 3,
        worktree_off_branch: 4,
        worktree_dirty: 5,
        worktree_history_rewritten: 6,
      };
      if (error && Object.hasOwn(exitCodes, error.code)) return exitCodes[error.code];
    }
    return error.rc === 1 ? 1 : 2;
  }
}

function runNativeLegacy(subcommand, args, env = process.env, cwd = process.cwd(), dryRun = false,
  dependencies = {}) {
  let response;
  if (subcommand === 'help') {
    process.stdout.write(legacyHelp());
    return 0;
  }
  if (subcommand === 'compute_session_id') {
    const projectRoot = projectForLegacy(cwd);
    const project = legacyProjectWithRecovery(projectRoot, dependencies);
    let text = '';
    if (project.stateExists) {
      text = readCoordinationFiles(project.stateRoot, ['sessions.jsonl'],
        legacyCoordinationOptions(dependencies))['sessions.jsonl'];
    }
    const timestamp = isoNow(dependencies);
    process.stdout.write(legacyComputedSessionId(args[0] || '', timestamp, text));
    return 0;
  }
  if (subcommand === 'resolve_helper_path') {
    const override = env.DEEP_EVOLVE_HELPER_PATH;
    if (override) {
      try {
        const stat = fs.statSync(override);
        fs.accessSync(override, fs.constants.X_OK);
        if (stat.isFile()) {
          process.stdout.write(`${override}\n`);
          return 0;
        }
      } catch {}
      process.stderr.write(`session-helper: DEEP_EVOLVE_HELPER_PATH=${override} invalid, falling back to realpath\n`);
    }
    process.stdout.write(`${fs.realpathSync(path.join(__dirname, 'session-helper.sh'))}\n`);
    return 0;
  }

  const task4Status = runTask4Legacy(subcommand, args, env, cwd, dependencies);
  if (task4Status !== null) return task4Status;
  const task5Status = runTask5Legacy(subcommand, args, env, cwd, dryRun, dependencies);
  if (task5Status !== null) return task5Status;

  const virtualArm = [
    'append_seed_to_session_yaml',
    'set_virtual_parallel_field',
    'init_virtual_parallel_block',
    'rebuild_seeds_from_journal',
  ].includes(subcommand);
  if (subcommand === 'append_seed_to_session_yaml' && (!args[0] || !args[1] || !args[2])) {
    process.stderr.write('usage: append_seed_to_session_yaml <seed_id> <wt_path> <branch> <beta_json>\n');
    return 2;
  }
  if (subcommand === 'set_virtual_parallel_field' && !args[0]) {
    process.stderr.write('usage: set_virtual_parallel_field <key> <value>\n');
    return 2;
  }
  if (subcommand === 'init_virtual_parallel_block' && (!args[0] || !args[1] || !args[2])) {
    process.stderr.write('usage: init_virtual_parallel_block <vp_analysis_json> <n_chosen> <total_budget>\n');
    return 2;
  }
  if (virtualArm && !env.SESSION_ROOT) {
    process.stderr.write('SESSION_ROOT not set\n');
    return 2;
  }
  if (virtualArm) return runLegacyVirtualDirect(subcommand, args, env, dependencies);
  const projectRoot = projectForLegacy(cwd, { createState: subcommand === 'start_new_session' && !dryRun });
  const legacyStateRoot = path.join(projectRoot, '.deep-evolve');
  if (subcommand === 'resolve_current') return runLegacyResolveCurrent(projectRoot, dependencies);
  if (subcommand === 'list_sessions') return runLegacyListSessions(projectRoot, args, dependencies);
  if (subcommand === 'migrate_legacy' && !fs.existsSync(legacyStateRoot)) {
    process.stderr.write('session-helper: no legacy layout to migrate\n');
    return 1;
  }
  if (subcommand === 'lineage_tree' && !fs.existsSync(legacyStateRoot)) {
    process.stdout.write('(no sessions)\n');
    return 0;
  }
  if (subcommand === 'check_branch_alignment') {
    const sessionDirectory = path.resolve(cwd, args[0] || '');
    const recoveryContext = legacyCoordinationContextForDirectory(sessionDirectory);
    const options = legacyCoordinationOptions(dependencies);
    const recovery = recoverTransactions(recoveryContext.stateRoot, options);
    if (recovery && recovery.ok === false) return 2;
    const binding = bindLegacySessionDirectory(sessionDirectory);
    const coordination = binding.context;
    let expected = '';
    try {
      const sessionPath = path.join(binding.sessionRoot, 'session.yaml');
      const relative = coordination.relative(sessionPath);
      const sessionText = readCoordinationFiles(coordination.stateRoot, [relative], options)[relative];
      const lines = sessionText.split(/\r?\n/);
      let inLineage = false;
      for (const line of lines) {
        if (line === 'lineage:') { inLineage = true; continue; }
        if (/^\S/.test(line)) inLineage = false;
        const match = inLineage ? /^  current_branch:\s*(.*)$/.exec(line) : null;
        if (match) { expected = match[1].replace(/"/g, ''); break; }
      }
      if (!expected && sessionText) {
        const parsed = parseStateDocument(sessionText, { sourcePath: sessionPath });
        if (plainObject(parsed) && plainObject(parsed.lineage)
            && typeof parsed.lineage.current_branch === 'string') {
          expected = parsed.lineage.current_branch;
        }
      }
    } catch {}
    const git = spawnSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (git.status !== 0) return 2;
    const actual = git.stdout.trim();
    if (!expected || expected === actual) return 0;
    process.stderr.write(`branch mismatch: expected '${expected}', actual '${actual}'\n`);
    return 1;
  }
  if (subcommand === 'detect_orphan_experiment') {
    const sessionDirectory = path.resolve(cwd, args[0] || '');
    const recoveryContext = legacyCoordinationContextForDirectory(sessionDirectory);
    const options = legacyCoordinationOptions(dependencies);
    const recovery = recoverTransactions(recoveryContext.stateRoot, options);
    if (recovery && recovery.ok === false) return 2;
    const binding = bindLegacySessionDirectory(sessionDirectory);
    const journal = path.join(binding.sessionRoot, 'journal.jsonl');
    const coordination = binding.context;
    const relative = coordination.relative(journal);
    const journalText = readCoordinationFiles(coordination.stateRoot, [relative], options)[relative];
    if (!journalText) return 0;
    const lines = journalText.split(/\r?\n/).filter((line) => line.trim());
    const committedLine = [...lines].reverse().find((line) => line.includes('"status":"committed"'));
    let committed = null;
    try { committed = committedLine ? JSON.parse(committedLine) : null; } catch {}
    if (!(plainObject(committed) && Number.isFinite(committed.id))) return 0;
    const events = [];
    try {
      for (const line of lines) events.push(JSON.parse(line));
    } catch { return 0; }
    if (!committed) return 0;
    const resolved = events.some((event) => event.id === committed.id
      && ['evaluated', 'kept', 'discarded', 'rollback_completed'].includes(event.status));
    if (resolved) return 0;
    const first = events.find((event) => event.id === committed.id && event.status === 'committed');
    if (first && typeof first.commit === 'string') process.stdout.write(JSON.stringify(first.commit));
    return 0;
  }
  if (subcommand === 'append_meta_archive_local') {
    try {
      readReceipt(resolveProject({ project_root: projectRoot }), args[0] || '');
    } catch (error) {
      if (error && error.code === 'invalid_receipt_json' && !dryRun) {
        fs.closeSync(fs.openSync(path.join(legacyStateRoot, 'meta-archive-local.jsonl'), 'a'));
        return writeLegacyJqParseFailure();
      }
      if (error && ['receipt_missing', 'receipt_reference_missing'].includes(error.code)) {
        process.stderr.write(`session-helper: receipt not found for ${args[0] || ''}\n`);
        return 1;
      }
      process.stderr.write(`${error && error.message ? error.message : 'receipt preflight failed'}\n`);
      return error && error.rc === 1 ? 1 : 2;
    }
  }
  if (subcommand === 'render_inherited_context') {
    try {
      readReceipt(resolveProject({ project_root: projectRoot }), args[0] || '', 'parent receipt');
    } catch (error) {
      if (error && error.code === 'invalid_receipt_json') return writeLegacyJqParseFailure();
      if (error && ['receipt_missing', 'receipt_reference_missing'].includes(error.code)) {
        process.stderr.write(`session-helper: parent receipt not found for ${args[0] || ''}\n`);
        return 1;
      }
      process.stderr.write(`${error && error.message ? error.message : 'parent receipt preflight failed'}\n`);
      return error && error.rc === 1 ? 1 : 2;
    }
  }
  if (subcommand === 'resolve_current') response = legacyRequest(projectRoot, 'session.resolve-current', {}, dependencies);
  else if (subcommand === 'list_sessions') {
    const status = args.find((arg) => arg.startsWith('--status='));
    response = legacyRequest(projectRoot, 'session.list', status ? { status: status.slice('--status='.length) } : {}, dependencies);
  } else if (subcommand === 'start_new_session') {
    const parent = args.find((arg) => arg.startsWith('--parent='));
    const payload = { goal: args[0] || '' };
    if (parent) payload.parent_session_id = parent.slice('--parent='.length);
    if (dryRun) {
      const project = resolveProject({ project_root: projectRoot });
      recoverProject(project, dependencies);
      const sessionsText = readCoordinationFiles(project.stateRoot, ['sessions.jsonl'],
        legacyCoordinationOptions(dependencies))['sessions.jsonl'];
      const timestamp = isoNow(dependencies);
      let sessionId = legacyComputedSessionId(payload.goal, timestamp, sessionsText);
      const directoryBase = sessionId;
      let suffix = 2;
      while (fs.existsSync(path.join(project.stateRoot, sessionId))) {
        sessionId = `${directoryBase}-${suffix}`;
        suffix += 1;
        if (suffix > 1000) {
          process.stderr.write('session-helper: session_id collision retry exhausted\n');
          return 1;
        }
      }
      const sessionRoot = path.join(project.stateRoot, sessionId);
      process.stderr.write(`[dry-run] would execute: create session ${sessionId} at ${sessionRoot}\n`);
      process.stdout.write(`${sessionId}\t${sessionRoot}\n`);
      return 0;
    }
    try {
      const project = resolveProject({ project_root: projectRoot });
      recoverProject(project, dependencies);
      response = successResponse('session.start', startSession(
        project,
        payload,
        dependencies,
        { legacyCollisionSemantics: true },
      ), []);
    } catch (error) {
      response = failureResponse('session.start', error);
    }
  } else if (subcommand === 'mark_session_status') {
    if (dryRun) {
      process.stderr.write(`[dry-run] would execute: mark ${args[0] || ''} as ${args[1] || ''}\n`);
      return 0;
    }
    return runLegacyMarkStatus(projectRoot, args[0], args[1], dependencies);
  } else if (subcommand === 'append_sessions_jsonl') {
    if (!args[0] || !args[1]) {
      process.stderr.write('usage: append_sessions_jsonl <event> <session_id> [--key=value]\n');
      return 1;
    }
    const extras = {};
    for (const arg of args.slice(2)) {
      const match = /^--([^=]+)=(.*)$/.exec(arg);
      if (match) extras[match[1]] = match[2];
    }
    const legacyExtraKeys = Object.keys(extras);
    if (legacyExtraKeys.length > 0) {
      const key = legacyExtraKeys[0];
      const expression = `{event:$event, ts:$ts, session_id:$sid}  + {(${key}): $${key}}`;
      process.stderr.write(`jq: error: ${key}/0 is not defined at <top-level>, line 1:\n`);
      process.stderr.write(`${expression}${' '.repeat(45)}\n`);
      process.stderr.write('jq: 1 compile error\n');
      return 3;
    }
    if (dryRun) {
      const record = { event: args[0], ts: isoNow(), session_id: args[1], ...extras };
      process.stderr.write(`[dry-run] would execute: append to sessions.jsonl: ${JSON.stringify(record)}\n`);
      return 0;
    }
    try {
      appendRegistryEvent(resolveProject({ project_root: projectRoot }), args[0], args[1], extras);
      return 0;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      return error.rc === 2 ? 2 : 1;
    }
  } else if (subcommand === 'migrate_legacy') {
    if (dryRun) {
      const project = resolveProject({ project_root: projectRoot });
      recoverProject(project, dependencies);
      const flat = path.join(project.stateRoot, 'session.yaml');
      let preview = null;
      mutateCoordinationFiles(
        project.stateRoot,
        ['session.yaml', 'current.json'],
        (files, snapshot) => {
          if (!snapshot.exists['session.yaml'] || snapshot.exists['current.json']) return null;
          const parsed = parseStateDocument(files['session.yaml'], { sourcePath: flat });
          const timestamp = isoNow(dependencies);
          const goal = plainObject(parsed) && typeof parsed.goal === 'string' && parsed.goal ? parsed.goal : 'unknown';
          const sessionId = `legacy-${timestamp.replace(/:/g, '-')}_${computeSlug(goal, timestamp)}`;
          preview = path.join(project.stateRoot, sessionId);
          return null;
        },
        legacyCoordinationOptions(dependencies),
      );
      if (!preview) {
        process.stderr.write('session-helper: no legacy layout to migrate\n');
        return 1;
      }
      process.stderr.write(`[dry-run] would execute: migrate flat layout to ${preview}\n`);
      return 0;
    }
    response = legacyRequest(projectRoot, 'session.migrate-legacy', {}, dependencies);
  }
  else if (subcommand === 'check_branch_alignment') {
    const sessionId = args[0] ? path.basename(path.resolve(args[0])) : '';
    response = legacyRequest(projectRoot, 'session.check-alignment', { session_id: sessionId }, dependencies);
  } else if (subcommand === 'detect_orphan_experiment') {
    const sessionId = args[0] ? path.basename(path.resolve(args[0])) : '';
    response = legacyRequest(projectRoot, 'session.detect-orphan', { session_id: sessionId }, dependencies);
  } else if (subcommand === 'append_meta_archive_local') {
    if (dryRun) {
      const project = resolveProject({ project_root: projectRoot });
      const resolved = readReceipt(project, args[0]);
      process.stderr.write(`[dry-run] would execute: append to meta-archive-local.jsonl from ${resolved.receiptPath}\n`);
      return 0;
    }
    response = legacyRequest(projectRoot, 'session.append-local-archive', { session_id: args[0] }, dependencies);
  } else if (subcommand === 'render_inherited_context') {
    response = legacyRequest(projectRoot, 'session.render-inherited-context', { parent_session_id: args[0] }, dependencies);
  } else if (subcommand === 'lineage_tree') response = legacyRequest(projectRoot, 'session.lineage-tree', {}, dependencies);
  else {
    const rootFromEnv = env.SESSION_ROOT;
    const sessionId = rootFromEnv ? path.basename(path.resolve(rootFromEnv)) : undefined;
    if (subcommand === 'append_seed_to_session_yaml') {
      let beta = {};
      try { beta = args[3] ? parseLegacyJsonLossless(args[3]) : {}; }
      catch {
        process.stderr.write('beta_json is not valid JSON\n');
        return 2;
      }
      response = legacyRequest(projectRoot, 'virtual.append-seed', {
        session_id: sessionId,
        seed_id: /^\d+$/.test(args[0] || '') ? Number(args[0]) : args[0],
        worktree_path: args[1],
        branch: args[2],
        beta,
      }, dependencies);
    } else if (subcommand === 'set_virtual_parallel_field') {
      response = legacyRequest(projectRoot, 'virtual.set-field', {
        session_id: sessionId,
        key: args[0],
        value: castLegacyValue(args[1] || ''),
      }, dependencies);
    } else if (subcommand === 'init_virtual_parallel_block') {
      let analysis;
      try { analysis = parseLegacyJsonLossless(args[0]); }
      catch {
        process.stderr.write('error: vp_analysis is not valid JSON\n');
        return 2;
      }
      response = legacyRequest(projectRoot, 'virtual.init', {
        session_id: sessionId,
        analysis,
        n_chosen: /^-?\d+$/.test(args[1] || '') ? Number(args[1]) : args[1],
        total_budget: /^-?\d+$/.test(args[2] || '') ? Number(args[2]) : args[2],
      }, dependencies);
    } else if (subcommand === 'rebuild_seeds_from_journal') {
      response = legacyRequest(projectRoot, 'virtual.rebuild-seeds', { session_id: sessionId }, dependencies);
    }
  }

  if (!response) return 2;
  if (!response.ok) return printLegacyFailure(response, subcommand, args, projectRoot);
  if (subcommand === 'resolve_current' || subcommand === 'start_new_session') {
    process.stdout.write(`${response.result.session_id}\t${response.result.session_root}\n`);
  } else if (subcommand === 'list_sessions') {
    process.stdout.write(`${JSON.stringify(response.result.sessions, null, 2)}\n`);
  } else if (subcommand === 'migrate_legacy') {
    process.stdout.write(`session-helper: migrated to ${response.result.session_root}\n`);
  } else if (subcommand === 'detect_orphan_experiment' && response.result.commit) {
    process.stdout.write(JSON.stringify(response.result.commit));
  } else if (subcommand === 'render_inherited_context') {
    process.stdout.write(response.result.markdown);
  } else if (subcommand === 'lineage_tree') {
    const lines = response.result.lines;
    process.stdout.write(lines.length ? `${lines.join('\n')}\n` : '(no sessions)\n');
  }
  return 0;
}

function runLegacyHelper(argv, dependencies = {}) {
  const dryRun = argv.includes('--dry-run');
  const subcommand = argv.find((arg) => arg !== '--dry-run') || 'help';
  const subcommandIndex = argv.indexOf(subcommand);
  const args = argv.slice(subcommandIndex + 1).filter((arg) => arg !== '--dry-run');
  if (!Object.hasOwn(LEGACY_ROUTES, subcommand)) {
    process.stderr.write(`session-helper: unknown subcommand '${subcommand}'\n`);
    return 1;
  }
  if (LEGACY_ROUTES[subcommand] === 'native') {
    try {
      return runNativeLegacy(subcommand, args, process.env, process.cwd(), dryRun, dependencies);
    }
    catch (error) {
      process.stderr.write(`${error && error.message ? error.message : 'legacy adapter failed'}\n`);
      return error && error.rc === 2 ? 2 : 1;
    }
  }
  if (process.platform === 'win32') {
    process.stderr.write(`session-helper: '${subcommand}' is available only through the Unix 3.4.3 oracle until its Node port lands\n`);
    return 2;
  }
  const oracle = path.resolve(__dirname, '..', '..', 'legacy', 'session-helper-v3.4.3.sh');
  const child = spawnSync('bash', [oracle, subcommand, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (typeof child.status === 'number') return child.status;
  process.stderr.write(`session-helper: legacy oracle terminated by ${child.signal || 'unknown signal'}\n`);
  return 2;
}

function requestIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameRequestIdentity(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function captureRequestFile(requestPath, dependencies = {}) {
  const lexical = path.resolve(requestPath);
  let descriptor;
  try {
    const requestParent = path.dirname(lexical);
    const requestParentStat = fs.lstatSync(requestParent);
    if (path.basename(requestParent) === '.runtime-requests' && requestParentStat.isSymbolicLink()) {
      throw operatorError('request_path_escape', 'request parent directory symlinks are not accepted');
    }
    const lexicalStat = fs.lstatSync(lexical);
    if (lexicalStat.isSymbolicLink()) {
      throw operatorError('request_path_escape', 'request file symlinks are not accepted');
    }
    if (!lexicalStat.isFile()) throw operatorError('request_file_invalid', 'request path must be a regular file');
    const lexicalIdentity = requestIdentity(fs.lstatSync(lexical, { bigint: true }));
    const physical = fs.realpathSync(lexical);
    descriptor = fs.openSync(lexical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = requestIdentity(fs.fstatSync(descriptor, { bigint: true }));
    if (!sameRequestIdentity(lexicalIdentity, before)) {
      throw operatorError('request_identity_changed', 'request file changed before it could be read');
    }
    const bytes = fs.readFileSync(descriptor);
    const text = bytes.toString('utf8');
    const after = requestIdentity(fs.fstatSync(descriptor, { bigint: true }));
    if (!sameRequestIdentity(before, after)) {
      throw operatorError('request_identity_changed', 'request file changed while it was read');
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (dependencies.afterRequestRead) dependencies.afterRequestRead(lexical);
    return {
      lexical,
      physical,
      identity: before,
      isFile: true,
      isSymbolicLink: false,
      contentSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      text,
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (error instanceof RuntimeError) throw error;
    if (error && error.code === 'ENOENT') {
      throw operatorError('request_file_missing', `request file not found: ${requestPath}`);
    }
    throw error;
  }
}

function requestPathPolicy(captured, project) {
  const {
    lexical, physical, identity, isFile, isSymbolicLink, contentSha256,
  } = captured;
  if (!isFile) throw operatorError('request_file_invalid', 'request path must resolve to a file');
  if (isSymbolicLink && !isPathInside(project.projectRoot, physical)) {
    throw operatorError('request_path_escape', 'request symlink resolves outside the project root');
  }
  const runtimeLexical = path.join(project.stateRoot, '.runtime-requests');
  let runtimePhysical = runtimeLexical;
  if (fs.existsSync(runtimeLexical)) {
    runtimePhysical = fs.realpathSync(runtimeLexical);
    if (!isPathInside(project.stateRoot, runtimePhysical)) {
      throw operatorError('request_path_escape', '.runtime-requests resolves outside .deep-evolve');
    }
  }
  const lexicalInside = isPathInside(runtimeLexical, lexical);
  const physicalInside = isPathInside(runtimePhysical, physical);
  if (lexicalInside && !physicalInside) {
    throw operatorError('request_path_escape', 'request path escapes .deep-evolve/.runtime-requests');
  }
  return {
    deletable: physicalInside && isFile && !isSymbolicLink,
    identity,
    lexical,
    contentSha256,
  };
}

function requestClaimPath(lexical) {
  const name = `.${path.basename(lexical)}.consumed-${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
  return path.join(path.dirname(lexical), name);
}

function sameClaimIdentity(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function inspectRequestClaim(claimPath) {
  const before = requestIdentity(fs.lstatSync(claimPath, { bigint: true }));
  const bytes = fs.readFileSync(claimPath);
  const after = requestIdentity(fs.lstatSync(claimPath, { bigint: true }));
  return {
    stable: sameRequestIdentity(before, after),
    identity: after,
    digest: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function restoreMismatchedClaim(policy, claimPath, claimed, dependencies = {}) {
  const link = dependencies.requestLink || fs.linkSync;
  const unlink = dependencies.requestUnlink || fs.unlinkSync;
  try {
    link(claimPath, policy.lexical);
  } catch (error) {
    return {
      code: 'request_identity_changed',
      recovery_path: claimPath,
      restore_error_code: error && error.code,
    };
  }
  if (dependencies.afterRequestRestoreLink) {
    dependencies.afterRequestRestoreLink(policy.lexical, claimPath);
  }
  let rebound;
  try {
    rebound = inspectRequestClaim(claimPath);
  } catch (error) {
    return {
      code: 'request_claim_cleanup_pending',
      reason: 'restored_private_claim_inspection_failed',
      recovery_path: claimPath,
      restored_path: policy.lexical,
      error_code: error && error.code,
    };
  }
  // Creating the restoration hard link updates ctime on the claimed inode.
  // Rebind the stable object fields plus the full digest immediately before
  // touching the private pathname; an object installed after the link is not
  // the request object whose public recovery path we just restored.
  if (!rebound.stable
      || !sameClaimIdentity(claimed.identity, rebound.identity)
      || rebound.digest !== claimed.digest) {
    return {
      code: 'request_claim_cleanup_pending',
      reason: 'restored_private_claim_identity_changed',
      recovery_path: claimPath,
      restored_path: policy.lexical,
    };
  }
  try {
    unlink(claimPath);
  } catch (error) {
    return {
      code: 'request_identity_changed',
      recovery_path: claimPath,
      restored_path: policy.lexical,
      cleanup_error_code: error && error.code,
    };
  }
  return { code: 'request_identity_changed' };
}

function claimAndDeleteConsumedRequest(policy, dependencies = {}) {
  if (dependencies.beforeRequestDelete) dependencies.beforeRequestDelete(policy.lexical);
  const claimPath = requestClaimPath(policy.lexical);
  const rename = dependencies.requestRename || fs.renameSync;
  try {
    rename(policy.lexical, claimPath);
  } catch (error) {
    return { code: 'request_claim_failed', error_code: error && error.code };
  }
  let claimed;
  try {
    claimed = inspectRequestClaim(claimPath);
  } catch (error) {
    return { code: 'request_claim_inspection_failed', recovery_path: claimPath, error_code: error && error.code };
  }
  if (!claimed.stable
      || !sameClaimIdentity(policy.identity, claimed.identity)
      || claimed.digest !== policy.contentSha256) {
    return restoreMismatchedClaim(policy, claimPath, claimed, dependencies);
  }
  if (dependencies.afterRequestClaim) dependencies.afterRequestClaim(policy.lexical, claimPath);
  let rebound;
  try {
    rebound = inspectRequestClaim(claimPath);
  } catch (error) {
    return {
      code: 'request_claim_cleanup_pending',
      reason: 'private_claim_inspection_failed',
      recovery_path: claimPath,
      error_code: error && error.code,
    };
  }
  if (!rebound.stable
      || !sameRequestIdentity(claimed.identity, rebound.identity)
      || rebound.digest !== claimed.digest) {
    return {
      code: 'request_claim_cleanup_pending',
      reason: 'private_claim_identity_changed',
      recovery_path: claimPath,
    };
  }
  try {
    // Node exposes pathname unlink rather than an object-bound unlink. This is
    // the final identity+digest rebind for a cooperative workspace; the final
    // scheduler gap remains an explicit limitation.
    (dependencies.requestUnlink || fs.unlinkSync)(claimPath);
    return null;
  } catch (error) {
    return { code: 'request_claim_cleanup_failed', recovery_path: claimPath, error_code: error && error.code };
  }
}

function writeCliResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function runLegacyOperation(argv, env = process.env) {
  const operation = argv[0];
  const args = argv.slice(1);
  if (operation !== 'coord.queue-user-kill') {
    process.stderr.write(`unsupported legacy operation: ${operation || '(missing)'}\n`);
    return 2;
  }
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write('usage: kill-request-writer.sh --seed=<positive-int>\n');
    return 0;
  }
  if (args.length !== 1 || !args[0].startsWith('--seed=')) {
    const unknown = args.find((arg) => !arg.startsWith('--seed='));
    process.stderr.write(unknown
      ? `error: unknown argument: ${unknown}\n`
      : 'error: --seed=<id> is required\n');
    return 2;
  }
  const token = args[0].slice('--seed='.length);
  if (!/^[1-9][0-9]*$/.test(token)) {
    process.stderr.write(`error: --seed must be a positive integer with no leading zeros, got: ${token}\n`);
    return 2;
  }
  if (!env.SESSION_ROOT) {
    process.stderr.write('error: SESSION_ROOT not set\n');
    return 2;
  }
  let sessionRoot;
  try { sessionRoot = fs.realpathSync(env.SESSION_ROOT); }
  catch {
    process.stderr.write(`error: SESSION_ROOT does not exist: ${env.SESSION_ROOT}\n`);
    return 2;
  }
  const stateRoot = path.dirname(sessionRoot);
  if (path.basename(stateRoot) !== '.deep-evolve') {
    process.stderr.write('error: SESSION_ROOT must be a direct child of .deep-evolve\n');
    return 2;
  }
  const projectRoot = path.dirname(stateRoot);
  const response = dispatch({
    schema_version: '1.0',
    operation,
    context: { project_root: projectRoot },
    payload: { session_id: path.basename(sessionRoot), seed_id: Number(token) },
  });
  if (!response.ok) {
    process.stderr.write(`error: ${response.error.message}\n`);
    return response.exitCode;
  }
  return 0;
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv[0] === '--legacy-session-helper') return runLegacyHelper(argv.slice(1), dependencies);
  if (argv[0] === '--legacy-operation') return runLegacyOperation(argv.slice(1));
  if (argv[0] !== '--request' || argv.length !== 2) {
    const response = failureResponse(null, operatorError('invalid_cli', 'usage: deep-evolve-runtime.cjs --request <path>'));
    writeCliResponse(response);
    return response.exitCode;
  }
  const requestPath = path.resolve(argv[1]);
  let request;
  let captured;
  try {
    captured = captureRequestFile(requestPath, dependencies);
    try { request = JSON.parse(captured.text); }
    catch { throw operatorError('invalid_request_json', 'request file is not valid JSON'); }
  } catch (error) {
    const response = failureResponse(null, error && error.code === 'ENOENT'
      ? operatorError('request_file_missing', `request file not found: ${requestPath}`)
      : error);
    writeCliResponse(response);
    return response.exitCode;
  }

  let policy;
  try {
    if (!plainObject(request) || !plainObject(request.context)) {
      throw operatorError('invalid_object', 'request and context must be plain objects');
    }
    const project = resolveProject(request.context);
    policy = requestPathPolicy(captured, project);
  } catch (error) {
    const response = failureResponse(request && request.operation, error);
    writeCliResponse(response);
    return response.exitCode;
  }

  const response = dispatch(request, dependencies);
  if (response.ok && policy.deletable) {
    const warning = claimAndDeleteConsumedRequest(policy, dependencies);
    if (warning) response.warnings.push(warning);
  }
  writeCliResponse(response);
  return response.exitCode;
}

module.exports = {
  OPERATIONS,
  LEGACY_ROUTES,
  RUNTIME_VERSION,
  dispatch,
  main,
};

if (require.main === module) process.exitCode = main();
