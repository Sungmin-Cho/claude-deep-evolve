'use strict';

const crypto = require('node:crypto');
const { deriveQ: deriveCoordinatorQ } = require('./coordinator-store.cjs');

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT_TYPES = new Set([
  'narrow_tuning',
  'standard_optimization',
  'open_research',
]);
const PARALLELIZABILITY = new Set(['serialized', 'parallel_capable']);
const METRIC_DIRECTIONS = new Set(['minimize', 'maximize']);
const INITIAL_KEYS = new Set([
  'schema_version',
  'initialization_id',
  'target_files',
  'eval_mode',
  'protocol_tools',
  'total_budget',
  'metric',
  'outer_loop',
  'virtual_parallel',
  'transfer',
]);
const METRIC_KEYS = new Set(['name', 'direction']);
const OUTER_LOOP_KEYS = new Set(['interval', 'auto_trigger']);
const VIRTUAL_KEYS = new Set([
  'n_chosen',
  'project_type',
  'eval_parallelizability',
  'selection_reason',
]);
const TRANSFER_KEYS = new Set([
  'source_id',
  'source_schema_version',
  'source_artifacts',
]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RESULTS_HEADER = 'commit\tscore\tstatus\tcategory\tscore_delta\tloc_delta\tflagged\trationale\tdescription';
const TAXONOMY = new Set([
  'parameter_tune',
  'refactor_simplify',
  'add_guard',
  'algorithm_swap',
  'data_preprocessing',
  'caching_memoization',
  'error_handling',
  'api_redesign',
  'test_expansion',
  'other',
]);
const PROJECTION_KEYS = new Set([
  'seeds', 'n_current', 'x-active-seed-count', 'budget_unallocated',
]);
const PROTECTED_JOURNAL_EVENTS = new Set([
  'transfer_adopted', 'seed_initialized', 'baseline_recorded', 'kept', 'discarded',
  'failed', 'seed_scheduled', 'seed_block_completed', 'seed_block_failed',
  'seed_killed', 'outer_loop', 'evaluation_epoch_advanced', 'evaluator_expanded',
  'session_completed',
]);
const SEED_IMMUTABLE_KEYS = Object.freeze([
  'id', 'direction', 'hypothesis', 'initial_rationale', 'worktree_path', 'branch',
  'created_at', 'created_by',
]);

function initialStateError(code, message) {
  return Object.assign(new TypeError(message), { code });
}

function transitionError(code, message, rc = 2, details) {
  return Object.assign(new Error(message), {
    code,
    rc,
    ...(details === undefined ? {} : { details }),
  });
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

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function requestSha256(operation, payload) {
  return sha256(Buffer.from(canonicalJson({ operation, payload })));
}

function isStrictSessionVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version || '');
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 5);
}

function requireOperationId(value, label = 'operation_id') {
  if (typeof value !== 'string' || !ULID.test(value)) {
    throw transitionError('invalid_operation_id', `${label} must be a canonical ULID`);
  }
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw transitionError('invalid_digest', `${label} must be sha256:<64 lowercase hex>`);
  }
  return value;
}

function requireFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw transitionError('invalid_field_type', `${label} must be a finite number`);
  }
  return value;
}

function requireSafeInteger(value, label, { min = Number.MIN_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw transitionError('invalid_field_type', `${label} must be a safe integer >= ${min}`);
  }
  return value;
}

function requireNullableString(value, label) {
  if (value !== null && typeof value !== 'string') {
    throw transitionError('invalid_field_type', `${label} must be null or a string`);
  }
  return value;
}

function requireUtc(value, label) {
  if (typeof value !== 'string' || !UTC_ISO.test(value)) {
    throw transitionError('invalid_field_type', `${label} must be UTC ISO 8601`);
  }
  return value;
}

function assertExactKeys(value, keys, label, code = 'invalid_field_shape') {
  if (!plainObject(value)) throw transitionError(code, `${label} must be a plain object`);
  const expected = new Set(keys);
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw transitionError(code, `${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw transitionError(code, `${label}.${key} is unknown`);
  }
  return value;
}

function assertNoTsvControl(value, label) {
  if (typeof value !== 'string' || /[\t\r\n\0]/.test(value)) {
    throw transitionError('invalid_tsv_field', `${label} must be a string without TSV control characters`);
  }
  return value;
}

function plainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) {
    throw initialStateError('initial_state_invalid', `${label} must be a plain object`);
  }
  const actual = Object.keys(value);
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw initialStateError('initial_state_invalid', `${label} is missing ${missing.join(', ')}`);
  }
  const unknown = actual.filter((key) => !expected.has(key));
  if (unknown.length > 0) {
    throw initialStateError('initial_state_invalid', `${label} has unknown field ${unknown[0]}`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw initialStateError('initial_state_invalid', `${label} must be a non-empty string`);
  }
  return value;
}

function boundedInteger(value, label, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw initialStateError('initial_state_invalid', `${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function validateTargetPath(value, label) {
  nonEmptyString(value, label);
  if (value.includes('\0')
      || value.startsWith('/')
      || value.startsWith('\\')
      || /^[A-Za-z]:/.test(value)
      || value.includes('\\')) {
    throw initialStateError('initial_target_path_invalid', `${label} must be a normalized project-relative path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')
      || segments.join('/') !== value) {
    throw initialStateError('initial_target_path_invalid', `${label} must not contain empty, dot, or parent segments`);
  }
  return value;
}

function validateTransfer(value) {
  if (value === null) return null;
  exactKeys(value, TRANSFER_KEYS, 'initial_state.transfer');
  nonEmptyString(value.source_id, 'initial_state.transfer.source_id');
  if (!(typeof value.source_schema_version === 'string' && value.source_schema_version.length > 0)
      && !Number.isSafeInteger(value.source_schema_version)) {
    throw initialStateError('initial_state_invalid',
      'initial_state.transfer.source_schema_version must be a non-empty string or integer');
  }
  if (!Array.isArray(value.source_artifacts)
      || value.source_artifacts.some((entry) => typeof entry !== 'string' || entry.length === 0)
      || new Set(value.source_artifacts).size !== value.source_artifacts.length) {
    throw initialStateError('initial_state_invalid',
      'initial_state.transfer.source_artifacts must be a unique string array');
  }
  return value;
}

function validateInitialStateSpec(value) {
  exactKeys(value, INITIAL_KEYS, 'initial_state');
  if (value.schema_version !== '1.0') {
    throw initialStateError('initial_state_invalid', 'initial_state.schema_version must be "1.0"');
  }
  if (typeof value.initialization_id !== 'string' || !ULID.test(value.initialization_id)) {
    throw initialStateError('initial_state_invalid', 'initial_state.initialization_id must be a ULID');
  }
  if (!Array.isArray(value.target_files) || value.target_files.length === 0) {
    throw initialStateError('initial_state_invalid', 'initial_state.target_files must be a non-empty array');
  }
  value.target_files.forEach((entry, index) => validateTargetPath(
    entry,
    `initial_state.target_files[${index}]`,
  ));
  if (new Set(value.target_files).size !== value.target_files.length) {
    throw initialStateError('initial_target_path_invalid', 'initial_state.target_files must be unique');
  }
  if (!new Set(['cli', 'protocol']).has(value.eval_mode)) {
    throw initialStateError('initial_state_invalid', 'initial_state.eval_mode must be cli or protocol');
  }
  if (!Array.isArray(value.protocol_tools)
      || value.protocol_tools.some((entry) => typeof entry !== 'string' || entry.length === 0)
      || new Set(value.protocol_tools).size !== value.protocol_tools.length) {
    throw initialStateError('initial_state_invalid', 'initial_state.protocol_tools must be a unique string array');
  }
  if ((value.eval_mode === 'cli' && value.protocol_tools.length !== 0)
      || (value.eval_mode === 'protocol' && value.protocol_tools.length === 0)) {
    throw initialStateError('initial_state_invalid',
      'initial_state.protocol_tools must be empty for cli and non-empty for protocol');
  }

  exactKeys(value.metric, METRIC_KEYS, 'initial_state.metric');
  nonEmptyString(value.metric.name, 'initial_state.metric.name');
  if (!METRIC_DIRECTIONS.has(value.metric.direction)) {
    throw initialStateError('initial_state_invalid',
      'initial_state.metric.direction must be minimize or maximize');
  }

  exactKeys(value.outer_loop, OUTER_LOOP_KEYS, 'initial_state.outer_loop');
  boundedInteger(value.outer_loop.interval, 'initial_state.outer_loop.interval', 1);
  if (typeof value.outer_loop.auto_trigger !== 'boolean') {
    throw initialStateError('initial_state_invalid',
      'initial_state.outer_loop.auto_trigger must be boolean');
  }

  exactKeys(value.virtual_parallel, VIRTUAL_KEYS, 'initial_state.virtual_parallel');
  const nChosen = boundedInteger(
    value.virtual_parallel.n_chosen,
    'initial_state.virtual_parallel.n_chosen',
    1,
    9,
  );
  if (!PROJECT_TYPES.has(value.virtual_parallel.project_type)) {
    throw initialStateError('initial_state_invalid', 'initial_state.virtual_parallel.project_type is invalid');
  }
  if (!PARALLELIZABILITY.has(value.virtual_parallel.eval_parallelizability)) {
    throw initialStateError('initial_state_invalid',
      'initial_state.virtual_parallel.eval_parallelizability is invalid');
  }
  nonEmptyString(value.virtual_parallel.selection_reason,
    'initial_state.virtual_parallel.selection_reason');
  const totalBudget = boundedInteger(value.total_budget, 'initial_state.total_budget', 1);
  if (totalBudget < 3 * nChosen) {
    throw initialStateError('initial_state_invalid',
      'initial_state.total_budget must preserve the three-experiment per-seed floor');
  }
  validateTransfer(value.transfer);
  return value;
}

function buildInitialSession({
  sessionId,
  goal,
  parent,
  initialState,
  createdAt,
  runtimeVersion,
}) {
  validateInitialStateSpec(initialState);
  nonEmptyString(sessionId, 'sessionId');
  if (typeof goal !== 'string') throw initialStateError('initial_state_invalid', 'goal must be a string');
  if (parent !== null && parent !== undefined) nonEmptyString(parent, 'parent');
  nonEmptyString(createdAt, 'createdAt');
  nonEmptyString(runtimeVersion, 'runtimeVersion');
  const nChosen = initialState.virtual_parallel.n_chosen;
  return {
    session_id: sessionId,
    deep_evolve_version: runtimeVersion,
    status: 'initializing',
    created_at: createdAt,
    goal,
    parent_session: parent ? { id: parent, inherited_at: createdAt } : null,
    experiments: { total: 0, kept: 0, discarded: 0, crashed: 0 },
    program: {
      version: 1,
      history: [{
        version: 1,
        experiments: '0-',
        keep_rate: null,
        reason: 'initial',
        created_at: createdAt,
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
        created_at: createdAt,
      }],
    },
    lineage: {
      current_branch: `evolve/${sessionId}`,
      forked_from: parent || null,
      previous_branches: [],
    },
    shortcut: { cumulative_flagged: 0, flagged_since_last_tier3: 0, total_flagged: 0 },
    diagnose_retry: { session_retries_used: 0, gave_up_count: 0 },
    legibility: { missing_rationale_count: 0 },
    entropy: { last_collapse_generation: null },
    metric: structuredClone(initialState.metric),
    eval_mode: initialState.eval_mode,
    protocol_tools: structuredClone(initialState.protocol_tools),
    total_budget: initialState.total_budget,
    target_files: structuredClone(initialState.target_files),
    transfer: initialState.transfer === null ? null : {
      ...structuredClone(initialState.transfer),
      adopted_at: createdAt,
    },
    virtual_parallel: {
      enabled: true,
      n_initial: nChosen,
      n_range: { min: 1, max: 9 },
      project_type: initialState.virtual_parallel.project_type,
      eval_parallelizability: initialState.virtual_parallel.eval_parallelizability,
      selection_reason: initialState.virtual_parallel.selection_reason,
      budget_total: initialState.total_budget,
      budget_unallocated: initialState.total_budget,
      synthesis: {
        budget_allocated: Math.min(2 * nChosen, 10),
        regression_tolerance: 0.05,
      },
      seeds: [],
      'x-active-seed-count': 0,
    },
  };
}

function validateTransferPatch(value) {
  if (value === null) return null;
  assertExactKeys(value, TRANSFER_KEYS, 'transfer', 'patch_type_invalid');
  if (typeof value.source_id !== 'string' || value.source_id.length === 0) {
    throw transitionError('patch_type_invalid', 'transfer.source_id must be a non-empty string');
  }
  if (!(typeof value.source_schema_version === 'string' && value.source_schema_version.length > 0)
      && !Number.isSafeInteger(value.source_schema_version)) {
    throw transitionError('patch_type_invalid',
      'transfer.source_schema_version must be a non-empty string or safe integer');
  }
  if (!Array.isArray(value.source_artifacts)
      || value.source_artifacts.some((entry) => typeof entry !== 'string' || entry.length === 0)
      || new Set(value.source_artifacts).size !== value.source_artifacts.length) {
    throw transitionError('patch_type_invalid',
      'transfer.source_artifacts must be a unique non-empty string array');
  }
  return structuredClone(value);
}

function validateBeta(value) {
  assertExactKeys(value, ['direction', 'hypothesis', 'rationale'], 'beta');
  for (const key of ['direction', 'hypothesis', 'rationale']) {
    requireNullableString(value[key], `beta.${key}`);
  }
  return structuredClone(value);
}

function parseStrictJsonl(text, label = 'journal.jsonl') {
  if (typeof text !== 'string') throw transitionError('virtual_projection_conflict', `${label} must be text`);
  const records = [];
  let offset = 0;
  const lines = text.split(/(?<=\n)/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw === '') continue;
    const withoutNewline = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    const line = withoutNewline.endsWith('\r') ? withoutNewline.slice(0, -1) : withoutNewline;
    const end = offset + Buffer.byteLength(raw);
    if (line.trim() === '') {
      offset = end;
      continue;
    }
    let value;
    try { value = JSON.parse(line); }
    catch {
      throw transitionError('virtual_projection_conflict', `${label} line ${index + 1} is malformed`);
    }
    if (!plainObject(value)) {
      throw transitionError('virtual_projection_conflict', `${label} line ${index + 1} must be an object`);
    }
    records.push({ value, start: offset, end, line: index + 1 });
    offset = end;
  }
  return records;
}

function parseResultsTsv(text) {
  if (typeof text !== 'string') throw transitionError('virtual_projection_conflict', 'results.tsv must be text');
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines[0] !== RESULTS_HEADER) {
    throw transitionError('virtual_projection_conflict', 'results.tsv has an invalid nine-column header');
  }
  const rows = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '') {
      throw transitionError('virtual_projection_conflict', `results.tsv line ${index + 1} is empty`);
    }
    const columns = lines[index].split('\t');
    if (columns.length !== 9) {
      throw transitionError('virtual_projection_conflict', `results.tsv line ${index + 1} must have nine columns`);
    }
    const [commit, scoreText, status, category, deltaText, locText, flaggedText,
      rationale, description] = columns;
    if (!FULL_COMMIT.test(commit)
        || !new Set(['kept', 'discarded', 'failed']).has(status)
        || !TAXONOMY.has(category)
        || scoreText.length === 0 || deltaText.length === 0 || locText.length === 0) {
      throw transitionError('virtual_projection_conflict',
        `results.tsv line ${index + 1} has invalid typed authority`);
    }
    const score = Number(scoreText);
    const scoreDelta = Number(deltaText);
    const locDelta = Number(locText);
    if (!Number.isFinite(score) || !Number.isFinite(scoreDelta)
        || !Number.isSafeInteger(locDelta) || !new Set(['true', 'false']).has(flaggedText)) {
      throw transitionError('virtual_projection_conflict', `results.tsv line ${index + 1} has invalid scalar authority`);
    }
    rows.push({
      commit,
      score,
      status,
      category,
      score_delta: scoreDelta,
      loc_delta: locDelta,
      flagged: flaggedText === 'true',
      rationale,
      description,
    });
  }
  return rows;
}

function serializeResultRow(row) {
  return [
    row.commit,
    String(row.score),
    row.status,
    row.category,
    String(row.score_delta),
    String(row.loc_delta),
    String(row.flagged),
    row.rationale,
    row.description,
  ].join('\t');
}

function resultRowForExperiment(experiment) {
  return {
    commit: experiment.commit,
    score: experiment.normalized_score,
    status: experiment.status,
    category: experiment.category,
    score_delta: experiment.score_delta,
    loc_delta: experiment.loc_delta,
    flagged: experiment.flagged,
    rationale: experiment.rationale,
    description: experiment.description,
  };
}

function resultRowEqual(left, right) {
  return left.commit === right.commit
    && Object.is(left.score, right.score)
    && left.status === right.status
    && left.category === right.category
    && Object.is(left.score_delta, right.score_delta)
    && left.loc_delta === right.loc_delta
    && left.flagged === right.flagged
    && left.rationale === right.rationale
    && left.description === right.description;
}

function seedFromInitialization(event) {
  return {
    id: event.seed_id,
    status: 'active',
    direction: event.direction,
    hypothesis: event.hypothesis,
    initial_rationale: event.initial_rationale,
    worktree_path: event.worktree_path,
    branch: event.branch,
    created_at: event.ts,
    created_by: event.created_by,
    experiments_used: 0,
    experiments_used_this_epoch: 0,
    keeps: 0,
    borrows_given: 0,
    borrows_received: 0,
    current_q: 0,
    allocated_budget: event.allocated_budget,
    killed_at: null,
    killed_reason: null,
  };
}

function validateSeedInitialization(event, virtual, state) {
  assertExactKeys(event, [
    'event', 'operation_id', 'seed_id', 'creation_kind', 'direction', 'hypothesis',
    'initial_rationale', 'worktree_path', 'branch', 'ts', 'created_by', 'allocated_budget',
  ], 'seed_initialized', 'virtual_projection_conflict');
  requireOperationId(event.operation_id, 'seed_initialized.operation_id');
  const seedId = requireSafeInteger(event.seed_id, 'seed_initialized.seed_id', { min: 1 });
  if (plainObject(virtual.n_range) && Number.isSafeInteger(virtual.n_range.max)
      && seedId > virtual.n_range.max) {
    throw transitionError('virtual_projection_conflict',
      `seed ${seedId} exceeds virtual_parallel.n_range.max`);
  }
  if (state.seeds.has(seedId)) {
    throw transitionError('virtual_projection_conflict', `seed ${seedId} is initialized more than once`);
  }
  if (!new Set(['initial', 'growth']).has(event.creation_kind)) {
    throw transitionError('virtual_projection_conflict', 'seed creation_kind is invalid');
  }
  for (const key of ['direction', 'hypothesis', 'initial_rationale']) {
    requireNullableString(event[key], `seed_initialized.${key}`);
  }
  if (typeof event.worktree_path !== 'string' || event.worktree_path.length === 0
      || typeof event.branch !== 'string' || event.branch.length === 0) {
    throw transitionError('virtual_projection_conflict', 'seed worktree_path and branch are required');
  }
  requireUtc(event.ts, 'seed_initialized.ts');
  const expectedCreator = event.creation_kind === 'initial' ? 'init_batch' : 'epoch_growth';
  if (event.created_by !== expectedCreator) {
    throw transitionError('virtual_projection_conflict', 'seed created_by does not match creation_kind');
  }
  let expectedAllocation;
  if (event.creation_kind === 'initial') {
    if (seedId > virtual.n_initial) {
      throw transitionError('virtual_projection_conflict', 'initial seed_id is outside 1..n_initial');
    }
    const base = Math.floor(virtual.budget_total / virtual.n_initial);
    const remainder = virtual.budget_total - base * virtual.n_initial;
    expectedAllocation = base + (seedId > virtual.n_initial - remainder ? 1 : 0);
  } else {
    const activeCount = [...state.seeds.values()].filter((seed) => seed.status === 'active').length;
    if (activeCount < 1 || seedId <= Math.max(0, ...state.seeds.keys())) {
      throw transitionError('virtual_projection_conflict', 'growth seed identity is not the next absent seed');
    }
    expectedAllocation = Math.max(Math.ceil(state.pool / (2 * activeCount)), 3);
  }
  if (event.allocated_budget !== expectedAllocation || state.pool < expectedAllocation) {
    throw transitionError('virtual_projection_conflict', 'seed allocation does not match deterministic authority');
  }
  state.pool -= expectedAllocation;
  state.seeds.set(seedId, seedFromInitialization(event));
}

function validateTerminalEvent(event, state, resultRows, consumedRows) {
  const allowed = [
    'event', 'operation_id', 'id', 'seed_id', 'category', 'description', 'rationale',
    'pre_commit', 'commit', 'status', 'raw_score', 'normalized_score', 'score_delta',
    'loc_delta', 'flagged', 'ts',
  ];
  if (Object.hasOwn(event, 'diagnose_outcome')) allowed.push('diagnose_outcome');
  assertExactKeys(event, allowed, event.event, 'virtual_projection_conflict');
  requireOperationId(event.operation_id, `${event.event}.operation_id`);
  const id = requireSafeInteger(event.id, `${event.event}.id`, { min: 1 });
  const seedId = requireSafeInteger(event.seed_id, `${event.event}.seed_id`, { min: 1 });
  const seed = state.seeds.get(seedId);
  if (!seed) throw transitionError('virtual_projection_conflict', `experiment ${id} has no initialized seed`);
  if (seed.status !== 'active') {
    throw transitionError('virtual_projection_conflict', `experiment ${id} occurs after seed terminalization`);
  }
  if (state.experimentIds.has(id)) {
    throw transitionError('virtual_projection_conflict', `experiment ${id} is terminal more than once`);
  }
  if (id <= state.lastExperimentId) {
    throw transitionError('virtual_projection_conflict',
      `experiment ${id} is out of terminal order`);
  }
  if (event.status !== event.event || !new Set(['kept', 'discarded', 'failed']).has(event.status)) {
    throw transitionError('virtual_projection_conflict', 'experiment terminal status is invalid');
  }
  if (!TAXONOMY.has(event.category)) {
    throw transitionError('virtual_projection_conflict', 'experiment category is invalid');
  }
  for (const key of ['description', 'rationale']) assertNoTsvControl(event[key], `${event.event}.${key}`);
  if (!FULL_COMMIT.test(event.pre_commit) || !FULL_COMMIT.test(event.commit)) {
    throw transitionError('virtual_projection_conflict', 'experiment commits must be full hex IDs');
  }
  for (const key of ['raw_score', 'normalized_score', 'score_delta']) {
    requireFinite(event[key], `${event.event}.${key}`);
  }
  requireSafeInteger(event.loc_delta, `${event.event}.loc_delta`);
  if (typeof event.flagged !== 'boolean') {
    throw transitionError('virtual_projection_conflict', 'experiment flagged must be boolean');
  }
  requireUtc(event.ts, `${event.event}.ts`);
  if (Object.hasOwn(event, 'diagnose_outcome')
      && !new Set(['recovered', 'failed', 'gave_up']).has(event.diagnose_outcome)) {
    throw transitionError('virtual_projection_conflict', 'diagnose_outcome is invalid');
  }
  const expected = resultRowForExperiment(event);
  const matches = [];
  for (let index = 0; index < resultRows.length; index += 1) {
    if (!consumedRows.has(index) && resultRowEqual(resultRows[index], expected)) matches.push(index);
  }
  if (matches.length !== 1) {
    throw transitionError('virtual_projection_conflict',
      `experiment ${id} must match exactly one results.tsv row`);
  }
  if (matches[0] <= state.lastResultIndex) {
    throw transitionError('virtual_projection_conflict',
      `experiment ${id} results.tsv row is out of order`);
  }
  consumedRows.add(matches[0]);
  state.lastResultIndex = matches[0];
  state.lastExperimentId = id;
  state.experimentIds.add(id);
  seed.experiments_used += 1;
  seed.experiments_used_this_epoch += 1;
  if (seed.experiments_used > seed.allocated_budget) {
    throw transitionError('virtual_projection_conflict',
      `experiment ${id} exceeds seed ${seedId} allocation`);
  }
  if (event.status === 'kept') seed.keeps += 1;
  state.terminals.push({
    id,
    seed_id: seedId,
    operation_id: event.operation_id,
    pre_commit: event.pre_commit,
    commit: event.commit,
    status: event.status,
    event: event.event,
    description: event.description,
    score_delta: event.score_delta,
  });
}

function qFromComponents(components) {
  assertExactKeys(components,
    ['keep_rate', 'normalized_delta', 'crash_rate', 'idea_diversity'],
    'q_components', 'virtual_projection_conflict');
  for (const key of Object.keys(components)) requireFinite(components[key], `q_components.${key}`);
  const value = 0.35 * components.keep_rate
    + 0.30 * components.normalized_delta
    + 0.20 * (1 - components.crash_rate)
    + 0.15 * components.idea_diversity;
  return Number(value.toPrecision(15));
}

function validateBlockEvent(event, state) {
  if (event.event === 'seed_scheduled') {
    assertExactKeys(event, [
      'event', 'operation_id', 'block_id', 'decision_id', 'seed_id', 'epoch',
      'pre_dispatch_head', 'block_size', 'budget_preimage', 'ts',
    ], 'seed_scheduled', 'virtual_projection_conflict');
    requireOperationId(event.operation_id, 'seed_scheduled.operation_id');
    for (const key of ['block_id', 'decision_id']) {
      if (typeof event[key] !== 'string' || event[key].length === 0) {
        throw transitionError('virtual_projection_conflict',
          `seed_scheduled.${key} must be non-empty`);
      }
    }
    requireSafeInteger(event.seed_id, 'seed_scheduled.seed_id', { min: 1 });
    requireSafeInteger(event.epoch, 'seed_scheduled.epoch', { min: 1 });
    requireSafeInteger(event.block_size, 'seed_scheduled.block_size', { min: 1 });
    requireSafeInteger(event.budget_preimage, 'seed_scheduled.budget_preimage', { min: 0 });
    requireUtc(event.ts, 'seed_scheduled.ts');
    const seed = state.seeds.get(event.seed_id);
    if (!seed || seed.status !== 'active') {
      throw transitionError('virtual_projection_conflict', 'scheduled seed is missing or terminal');
    }
    if (!FULL_COMMIT.test(event.pre_dispatch_head) || event.epoch !== state.epoch
        || event.budget_preimage !== seed.allocated_budget - seed.experiments_used
        || event.block_size > event.budget_preimage) {
      throw transitionError('virtual_projection_conflict',
        'seed_scheduled head, epoch, or budget authority is inconsistent');
    }
    if (state.blocks.has(event.block_id)) {
      throw transitionError('virtual_projection_conflict', 'block is scheduled more than once');
    }
    if ([...state.blocks.values()].some((block) => !block.terminal
      && block.event.seed_id === event.seed_id)) {
      throw transitionError('virtual_projection_conflict',
        'seed has more than one in-flight block');
    }
    state.blocks.set(event.block_id, {
      event,
      terminal: false,
      terminalStart: state.terminals.length,
    });
    state.blockOrder.push(event.block_id);
    return;
  }
  const keys = [
    'event', 'operation_id', 'block_id', 'schedule_operation_id', 'seed_id',
    'experiment_ids', 'commits', 'forum_entry_ids', 'borrows_given', 'borrows_received',
    'q_components', 'final_q', 'returned_head', 'status', 'ts',
  ];
  assertExactKeys(event, keys, event.event, 'virtual_projection_conflict');
  requireOperationId(event.operation_id, `${event.event}.operation_id`);
  requireOperationId(event.schedule_operation_id, `${event.event}.schedule_operation_id`);
  requireUtc(event.ts, `${event.event}.ts`);
  if (typeof event.block_id !== 'string' || event.block_id.length === 0
      || !FULL_COMMIT.test(event.returned_head)) {
    throw transitionError('virtual_projection_conflict',
      'block terminal identity or returned HEAD is invalid');
  }
  const block = state.blocks.get(event.block_id);
  if (!block || block.terminal) {
    throw transitionError('virtual_projection_conflict', 'block terminal is missing its unique schedule');
  }
  if (block.event.operation_id !== event.schedule_operation_id
      || block.event.seed_id !== event.seed_id) {
    throw transitionError('virtual_projection_conflict', 'block terminal parent identity is inconsistent');
  }
  const expectedStatus = event.event === 'seed_block_completed' ? 'completed' : 'failed';
  if (event.status !== expectedStatus) {
    throw transitionError('virtual_projection_conflict', 'block terminal status is inconsistent');
  }
  for (const [key, value] of Object.entries({
    experiment_ids: event.experiment_ids, commits: event.commits,
    forum_entry_ids: event.forum_entry_ids,
  })) {
    if (!Array.isArray(value) || new Set(value).size !== value.length) {
      throw transitionError('virtual_projection_conflict', `${key} must be a unique array`);
    }
  }
  if (event.experiment_ids.some((id) => !Number.isSafeInteger(id) || id < 1)
      || event.commits.some((commit) => !FULL_COMMIT.test(commit))
      || event.forum_entry_ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw transitionError('virtual_projection_conflict',
      'block terminal summary contains malformed identities');
  }
  const terminals = state.terminals.slice(block.terminalStart)
    .filter((terminal) => terminal.seed_id === event.seed_id);
  let expectedReturnedHead = block.event.pre_dispatch_head;
  for (const terminal of terminals) {
    if (terminal.pre_commit !== expectedReturnedHead) {
      throw transitionError('virtual_projection_conflict',
        'block experiment commit chain is discontinuous');
    }
    expectedReturnedHead = terminal.status === 'kept'
      ? terminal.commit : terminal.pre_commit;
  }
  if (JSON.stringify(event.experiment_ids) !== JSON.stringify(terminals.map((entry) => entry.id))
      || JSON.stringify(event.commits) !== JSON.stringify(terminals.map((entry) => entry.commit))
      || (event.event === 'seed_block_completed'
        && terminals.length !== block.event.block_size)
      || (event.event === 'seed_block_failed' && terminals.length > block.event.block_size)
      || event.returned_head !== expectedReturnedHead) {
    throw transitionError('virtual_projection_conflict',
      'block terminal experiment or forum summary is inconsistent with typed authority');
  }
  requireSafeInteger(event.borrows_given, 'borrows_given', { min: 0 });
  requireSafeInteger(event.borrows_received, 'borrows_received', { min: 0 });
  const expectedExperimentForums = new Set(terminals
    .filter((entry) => entry.status !== 'failed')
    .map((entry) => `experiment:${entry.operation_id}`));
  const actualExperimentForums = new Set(event.forum_entry_ids
    .filter((identity) => typeof identity === 'string' && identity.startsWith('experiment:')));
  const given = event.forum_entry_ids.filter((identity) => (
    typeof identity === 'string' && /^borrow:given:[0-9a-f]{64}$/.test(identity)
  ));
  const received = event.forum_entry_ids.filter((identity) => (
    typeof identity === 'string' && /^borrow:received:[0-9a-f]{64}$/.test(identity)
  ));
  if (event.forum_entry_ids.some((identity) => typeof identity !== 'string'
      || (!identity.startsWith('experiment:')
        && !/^borrow:(?:given|received):[0-9a-f]{64}$/.test(identity)))
      || actualExperimentForums.size !== expectedExperimentForums.size
      || [...expectedExperimentForums].some((identity) => !actualExperimentForums.has(identity))
      || given.length !== event.borrows_given
      || received.length !== event.borrows_received) {
    throw transitionError('virtual_projection_conflict',
      'block terminal forum and borrow identities are inconsistent');
  }
  const epochTerminals = state.terminals.slice(state.epochTerminalStart);
  const derivedQ = deriveCoordinatorQ(terminals, epochTerminals,
    event.event === 'seed_block_failed' ? 'failed' : 'completed');
  assertExactKeys(event.q_components,
    ['keep_rate', 'normalized_delta', 'crash_rate', 'idea_diversity'],
    `${event.event}.q_components`, 'virtual_projection_conflict');
  for (const key of ['keep_rate', 'normalized_delta', 'crash_rate', 'idea_diversity']) {
    if (!Object.hasOwn(event.q_components, key)
        || !Object.is(event.q_components[key], derivedQ.components[key])) {
      throw transitionError('virtual_projection_conflict',
        `block Q component ${key} is not reproduced from terminal authority`);
    }
  }
  const q = qFromComponents(event.q_components);
  requireFinite(event.final_q, 'final_q');
  if (!Object.is(q, event.final_q) || !Object.is(q, derivedQ.Q)) {
    throw transitionError('virtual_projection_conflict', 'block final Q is forged');
  }
  const seed = state.seeds.get(event.seed_id);
  if (!seed || seed.status !== 'active') {
    throw transitionError('virtual_projection_conflict', 'block terminal seed is missing or terminal');
  }
  seed.current_q = q;
  seed.borrows_given += event.borrows_given;
  seed.borrows_received += event.borrows_received;
  block.terminal = true;
  block.terminalEvent = event;
}

function validateQAuthority(event, expected, label) {
  assertExactKeys(event.q_components,
    ['keep_rate', 'normalized_delta', 'crash_rate', 'idea_diversity'],
    `${label}.q_components`, 'virtual_projection_conflict');
  for (const key of ['keep_rate', 'normalized_delta', 'crash_rate', 'idea_diversity']) {
    requireFinite(event.q_components[key], `${label}.q_components.${key}`);
    if (!Object.is(event.q_components[key], expected.components[key])) {
      throw transitionError('virtual_projection_conflict',
        `${label} Q component ${key} is forged`);
    }
  }
  requireFinite(event.Q, `${label}.Q`);
  if (!Object.is(event.Q, expected.Q)) {
    throw transitionError('virtual_projection_conflict', `${label} Q is forged`);
  }
}

function completedEpochAuthority(state) {
  const ids = state.blockOrder.filter((blockId) => {
    const block = state.blocks.get(blockId);
    return block.event.epoch === state.epoch;
  });
  if (ids.length === 0 || ids.some((blockId) => !state.blocks.get(blockId).terminal)) {
    throw transitionError('virtual_projection_conflict',
      'epoch boundary requires a non-empty gap-free completed block set');
  }
  const experimentIds = new Set(ids.flatMap((blockId) => (
    state.blocks.get(blockId).terminalEvent.experiment_ids
  )));
  const terminals = state.terminals.filter((entry) => experimentIds.has(entry.id));
  if (terminals.length !== experimentIds.size) {
    throw transitionError('virtual_projection_conflict',
      'epoch boundary terminal set is inconsistent');
  }
  return { ids, terminals };
}

function validateOuterLoopEvent(event, state) {
  assertExactKeys(event, [
    'event', 'operation_id', 'completed_block_ids', 'generation', 'q_components',
    'Q', 'reason', 'ts', 'epoch',
  ], 'outer_loop', 'virtual_projection_conflict');
  requireOperationId(event.operation_id, 'outer_loop.operation_id');
  requireSafeInteger(event.generation, 'outer_loop.generation', { min: 1 });
  requireUtc(event.ts, 'outer_loop.ts');
  if (!new Set([
    'block_interval', 'tier3_expansion', 'manual_boundary', 'termination_boundary',
  ]).has(event.reason) || event.epoch !== state.epoch
      || event.generation !== state.generation + 1 || state.pendingOuter !== null) {
    throw transitionError('virtual_projection_conflict', 'outer-loop identity is malformed');
  }
  const authority = completedEpochAuthority(state);
  if (canonicalJson(event.completed_block_ids) !== canonicalJson(authority.ids)) {
    throw transitionError('virtual_projection_conflict',
      'outer-loop completed block IDs are not gap-free authority');
  }
  const q = deriveCoordinatorQ(authority.terminals, authority.terminals,
    authority.terminals.length === 0 ? 'failed' : 'completed');
  validateQAuthority(event, q, 'outer_loop');
  state.pendingOuter = { event, authority, q };
}

function validateEpochEvent(event, state) {
  assertExactKeys(event, [
    'event', 'operation_id', 'completed_block_ids', 'generation', 'q_components',
    'Q', 'reason', 'ts', 'from_epoch', 'to_epoch',
  ], 'evaluation_epoch_advanced', 'virtual_projection_conflict');
  requireOperationId(event.operation_id, 'evaluation_epoch_advanced.operation_id');
  requireSafeInteger(event.generation, 'evaluation_epoch_advanced.generation', { min: 1 });
  requireUtc(event.ts, 'evaluation_epoch_advanced.ts');
  const outer = state.pendingOuter;
  if (!outer || event.operation_id !== outer.event.operation_id
      || event.from_epoch !== state.epoch || event.to_epoch !== state.epoch + 1
      || event.generation !== outer.event.generation
      || event.reason !== outer.event.reason || event.ts !== outer.event.ts
      || canonicalJson(event.completed_block_ids)
        !== canonicalJson(outer.event.completed_block_ids)
      || canonicalJson(event.q_components) !== canonicalJson(outer.event.q_components)
      || !Object.is(event.Q, outer.event.Q)) {
    throw transitionError('virtual_projection_conflict',
      'evaluation epoch event lacks its exact paired outer-loop authority');
  }
  validateQAuthority(event, outer.q, 'evaluation_epoch_advanced');
  for (const seed of state.seeds.values()) seed.experiments_used_this_epoch = 0;
  state.epochTerminalStart = state.terminals.length;
  state.epoch = event.to_epoch;
  state.generation = event.generation;
  state.pendingOuter = null;
}

function validateKillEvent(event, state) {
  assertExactKeys(event, [
    'event', 'operation_id', 'source', 'request_id', 'kill_entry_id', 'seed_id',
    'condition', 'ts', 'applied_at',
  ], 'seed_killed', 'virtual_projection_conflict');
  requireOperationId(event.operation_id, 'seed_killed.operation_id');
  if (typeof event.kill_entry_id !== 'string' || event.kill_entry_id.length === 0) {
    throw transitionError('virtual_projection_conflict',
      'seed kill entry identity must be non-empty');
  }
  const seedId = requireSafeInteger(event.seed_id, 'seed_killed.seed_id', { min: 1 });
  const seed = state.seeds.get(seedId);
  if (!seed || seed.status !== 'active') {
    throw transitionError('virtual_projection_conflict', 'seed kill is duplicate or missing its active seed');
  }
  if ([...state.blocks.values()].some((block) => !block.terminal
    && block.event.seed_id === seedId)) {
    throw transitionError('virtual_projection_conflict',
      'seed kill cannot overtake an in-flight block');
  }
  if (!new Set(['user_request', 'scheduler']).has(event.source)
      || !new Set([
        'crash_give_up', 'sustained_regression', 'shortcut_quarantine',
        'budget_exhausted_underperform', 'user_requested',
      ]).has(event.condition)) {
    throw transitionError('virtual_projection_conflict', 'seed kill source or condition is invalid');
  }
  if ((event.source === 'user_request') !== (event.condition === 'user_requested')) {
    throw transitionError('virtual_projection_conflict',
      'seed kill source and condition are inconsistent');
  }
  if ((event.source === 'user_request') !== (typeof event.request_id === 'string')) {
    if (!(event.source === 'scheduler' && event.request_id === null)) {
      throw transitionError('virtual_projection_conflict', 'seed kill request identity is inconsistent');
    }
  }
  if (event.source === 'user_request' && event.request_id.length === 0) {
    throw transitionError('virtual_projection_conflict',
      'user seed kill request identity must be non-empty');
  }
  requireUtc(event.ts, 'seed_killed.ts');
  if (event.applied_at !== event.ts) {
    throw transitionError('virtual_projection_conflict', 'seed kill timestamps must match');
  }
  const reclaimed = seed.allocated_budget - seed.experiments_used;
  if (reclaimed < 0) throw transitionError('virtual_projection_conflict', 'seed consumed beyond allocation');
  seed.allocated_budget = seed.experiments_used;
  seed.status = `killed:${event.condition}`;
  seed.killed_at = event.applied_at;
  seed.killed_reason = event.condition;
  state.pool += reclaimed;
}

function reduceVirtualProjection({ initialVirtual, events, resultRows }) {
  if (!plainObject(initialVirtual)) {
    throw transitionError('virtual_projection_conflict', 'initialVirtual must be an object');
  }
  requireSafeInteger(initialVirtual.n_initial, 'virtual_parallel.n_initial', { min: 1 });
  requireSafeInteger(initialVirtual.budget_total, 'virtual_parallel.budget_total', { min: 1 });
  if (!Array.isArray(events) || !Array.isArray(resultRows)) {
    throw transitionError('virtual_projection_conflict', 'events and resultRows must be arrays');
  }
  const state = {
    pool: initialVirtual.budget_total,
    seeds: new Map(),
    experimentIds: new Set(),
    lastExperimentId: 0,
    lastResultIndex: -1,
    terminals: [],
    blocks: new Map(),
    blockOrder: [],
    epoch: 1,
    epochTerminalStart: 0,
    generation: 0,
    pendingOuter: null,
  };
  const consumedRows = new Set();
  for (const event of events) {
    if (!plainObject(event) || typeof event.event !== 'string') {
      throw transitionError('virtual_projection_conflict', 'journal event is not a typed object');
    }
    if (event.event === 'operation_receipt'
        || event.event === 'baseline_recorded'
        || event.event === 'evaluator_expanded'
        || event.event === 'session_completed') continue;
    if (event.event === 'seed_initialized') validateSeedInitialization(event, initialVirtual, state);
    else if (new Set(['kept', 'discarded', 'failed']).has(event.event)) {
      validateTerminalEvent(event, state, resultRows, consumedRows);
    } else if (event.event === 'seed_killed') validateKillEvent(event, state);
    else if (new Set(['seed_scheduled', 'seed_block_completed', 'seed_block_failed']).has(event.event)) {
      validateBlockEvent(event, state);
    } else if (event.event === 'outer_loop') validateOuterLoopEvent(event, state);
    else if (event.event === 'evaluation_epoch_advanced') validateEpochEvent(event, state);
  }
  if (state.pendingOuter !== null) {
    throw transitionError('virtual_projection_conflict',
      'outer-loop event is missing its paired epoch advancement');
  }
  for (let index = 0; index < resultRows.length; index += 1) {
    const status = resultRows[index] && resultRows[index].status;
    if (new Set(['kept', 'discarded', 'failed']).has(status) && !consumedRows.has(index)) {
      throw transitionError('virtual_projection_conflict', 'results.tsv has an unmatched terminal row');
    }
    if (!new Set(['kept', 'discarded', 'failed']).has(status)) {
      throw transitionError('virtual_projection_conflict', `results.tsv has unknown status ${String(status)}`);
    }
  }
  const seeds = [...state.seeds.values()].sort((left, right) => left.id - right.id);
  const allocated = seeds.reduce((sum, seed) => sum + seed.allocated_budget, 0);
  if (state.pool < 0 || state.pool + allocated !== initialVirtual.budget_total) {
    throw transitionError('virtual_projection_conflict', 'virtual budget equation is inconsistent');
  }
  const activeCount = seeds.filter((seed) => seed.status === 'active').length;
  return {
    seeds,
    ...(activeCount > 0 ? { n_current: activeCount } : { 'x-active-seed-count': 0 }),
    budget_unallocated: state.pool,
  };
}

function projectionFromVirtual(virtual) {
  return {
    seeds: structuredClone(virtual.seeds),
    ...(Object.hasOwn(virtual, 'n_current') ? { n_current: virtual.n_current } : {}),
    ...(Object.hasOwn(virtual, 'x-active-seed-count')
      ? { 'x-active-seed-count': virtual['x-active-seed-count'] } : {}),
    budget_unallocated: virtual.budget_unallocated,
  };
}

function installProjection(virtual, projection) {
  const next = structuredClone(virtual);
  for (const key of PROJECTION_KEYS) delete next[key];
  return { ...next, ...structuredClone(projection) };
}

function projectionSha256(projection) {
  return sha256(Buffer.from(canonicalJson(projection)));
}

function sessionNonProjectionSha256(session) {
  const value = structuredClone(session);
  if (plainObject(value.virtual_parallel)) {
    for (const key of PROJECTION_KEYS) delete value.virtual_parallel[key];
  }
  return sha256(Buffer.from(canonicalJson(value)));
}

function assertRepairableProjection(currentVirtual, projection) {
  if (!plainObject(currentVirtual)) {
    throw transitionError('virtual_projection_conflict', 'current virtual projection is missing');
  }
  const currentMetadata = {};
  for (const [key, value] of Object.entries(currentVirtual)) {
    if (!PROJECTION_KEYS.has(key)) currentMetadata[key] = value;
  }
  const rebuiltMetadata = {};
  for (const [key, value] of Object.entries(installProjection(currentVirtual, projection))) {
    if (!PROJECTION_KEYS.has(key)) rebuiltMetadata[key] = value;
  }
  if (canonicalJson(currentMetadata) !== canonicalJson(rebuiltMetadata)) {
    throw transitionError('virtual_projection_conflict', 'immutable virtual metadata drifted');
  }
  if (!Array.isArray(currentVirtual.seeds) || currentVirtual.seeds.length !== projection.seeds.length) {
    throw transitionError('virtual_projection_conflict', 'seed identity set differs from journal authority');
  }
  const currentById = new Map(currentVirtual.seeds.map((seed) => [seed.id, seed]));
  for (const expected of projection.seeds) {
    const current = currentById.get(expected.id);
    if (!current) throw transitionError('virtual_projection_conflict', 'seed identity is missing');
    for (const key of SEED_IMMUTABLE_KEYS) {
      if (canonicalJson(current[key]) !== canonicalJson(expected[key])) {
        throw transitionError('virtual_projection_conflict', `seed immutable field ${key} drifted`);
      }
    }
  }
}

function makeOperationReceipt({
  operation,
  operationId,
  requestDigest,
  prior,
  postSessionSha256,
  postResultsSha256,
  postNonProjectionSha256,
  journalEventSha256,
  result,
  ts,
}) {
  return {
    event: 'operation_receipt',
    operation,
    operation_id: operationId,
    request_sha256: requestDigest,
    prior: structuredClone(prior),
    post: {
      session_sha256: postSessionSha256,
      results_sha256: postResultsSha256,
      non_projection_sha256: postNonProjectionSha256,
      journal_event_sha256: journalEventSha256,
    },
    result: structuredClone(result),
    ts,
  };
}

const EVENT_OWNERS = Object.freeze({
  transfer_adopted: new Set(['session.patch']),
  seed_initialized: new Set(['virtual.append-seed']),
  baseline_recorded: new Set(['session.record-baseline']),
  kept: new Set(['session.finish-experiment']),
  discarded: new Set(['session.finish-experiment']),
  failed: new Set(['session.finish-experiment']),
  seed_scheduled: new Set(['coord.begin-seed-block']),
  seed_block_completed: new Set(['coord.finish-seed-block']),
  seed_block_failed: new Set(['coord.finish-seed-block']),
  seed_killed: new Set([
    'coord.ack-user-kill-request', 'coord.drain-kill-queue', 'coord.finish-seed-block',
  ]),
  outer_loop: new Set(['coord.advance-epoch']),
  evaluation_epoch_advanced: new Set(['coord.advance-epoch']),
  evaluator_expanded: new Set(['session.record-evaluator-expansion']),
  session_completed: new Set(['session.complete']),
});

function validateReceiptRecord(record, journalText) {
  const receipt = assertExactKeys(record.value, [
    'event', 'operation', 'operation_id', 'request_sha256', 'prior', 'post',
    'result', 'ts',
  ], 'operation_receipt', 'virtual_projection_conflict');
  if (receipt.event !== 'operation_receipt'
      || typeof receipt.operation !== 'string' || receipt.operation.length === 0) {
    throw transitionError('virtual_projection_conflict',
      'operation receipt identity is malformed');
  }
  requireOperationId(receipt.operation_id, 'operation_receipt.operation_id');
  requireDigest(receipt.request_sha256, 'operation_receipt.request_sha256');
  requireUtc(receipt.ts, 'operation_receipt.ts');
  if (!plainObject(receipt.result)) {
    throw transitionError('virtual_projection_conflict',
      'operation receipt result must be an object');
  }
  if (!plainObject(receipt.prior)) {
    throw transitionError('virtual_projection_conflict',
      'operation receipt prior authority must be an object');
  }
  const priorAllowed = new Set([
    'session_sha256', 'journal_sha256', 'results_sha256', 'forum_sha256',
    'kill_queue_sha256', 'kill_requests_sha256',
  ]);
  for (const key of ['session_sha256', 'journal_sha256', 'results_sha256']) {
    if (!Object.hasOwn(receipt.prior, key)) {
      throw transitionError('virtual_projection_conflict',
        `operation receipt prior.${key} is required`);
    }
  }
  for (const [key, digest] of Object.entries(receipt.prior)) {
    if (!priorAllowed.has(key)) {
      throw transitionError('virtual_projection_conflict',
        `operation receipt prior.${key} is unknown`);
    }
    requireDigest(digest, `operation_receipt.prior.${key}`);
  }
  assertExactKeys(receipt.post, [
    'session_sha256', 'results_sha256', 'non_projection_sha256',
    'journal_event_sha256',
  ], 'operation_receipt.post', 'virtual_projection_conflict');
  for (const [key, digest] of Object.entries(receipt.post)) {
    requireDigest(digest, `operation_receipt.post.${key}`);
  }
  const expectedPrefix = sha256(Buffer.from(journalText).subarray(0, record.start));
  if (receipt.post.journal_event_sha256 !== expectedPrefix) {
    throw transitionError('virtual_projection_conflict',
      'operation receipt journal prefix digest is inconsistent');
  }
  return receipt;
}

function validateCommittedJournal(journalText) {
  const records = parseStrictJsonl(journalText);
  let pending = [];
  for (const record of records) {
    const event = record.value;
    if (PROTECTED_JOURNAL_EVENTS.has(event.event)) {
      requireOperationId(event.operation_id, `${event.event}.operation_id`);
      if (pending.length > 0 && pending[0].operation_id !== event.operation_id) {
        throw transitionError('virtual_projection_conflict',
          'protected events from different operations are interleaved');
      }
      pending.push(event);
      continue;
    }
    if (event.event === 'operation_receipt') {
      const receipt = validateReceiptRecord(record, journalText);
      if (pending.length === 0) {
        if (!new Set([
          'virtual.rebuild-seeds',
          'coord.ack-user-kill-request',
          'coord.drain-kill-queue',
        ]).has(receipt.operation)) {
          throw transitionError('virtual_projection_conflict',
            'operation receipt is missing its protected typed event');
        }
      } else {
        if (pending[0].operation_id !== receipt.operation_id
            || pending.some((typed) => !EVENT_OWNERS[typed.event].has(receipt.operation))) {
          throw transitionError('virtual_projection_conflict',
            'operation receipt does not own its protected typed event group');
        }
        pending = [];
      }
      continue;
    }
    if (pending.length > 0) {
      throw transitionError('virtual_projection_conflict',
        'protected typed event is not immediately sealed by its operation receipt');
    }
  }
  if (pending.length > 0) {
    throw transitionError('virtual_projection_conflict',
      'protected typed event has no committed operation receipt');
  }
  return records;
}

function findOperationReceipt(journalText, operationId, operation, requestDigestValue) {
  const records = validateCommittedJournal(journalText);
  const matches = records.filter(({ value }) => value.event === 'operation_receipt'
    && value.operation_id === operationId);
  if (matches.length > 1) {
    throw transitionError('operation_id_conflict', 'operation_id has multiple receipts');
  }
  if (matches.length === 0) return null;
  const match = matches[0];
  if (match.value.operation !== operation || match.value.request_sha256 !== requestDigestValue) {
    throw transitionError('operation_id_conflict', 'operation_id was already used for different input');
  }
  return {
    receipt: match.value,
    journal_sha256: sha256(Buffer.from(journalText).subarray(0, match.end)),
  };
}

function appendTypedEventAndReceipt(journalText, event, receiptInput) {
  return appendTypedEventsAndReceipt(journalText, [event], receiptInput);
}

function appendTypedEventsAndReceipt(journalText, events, receiptInput) {
  if (!Array.isArray(events) || events.length === 0) {
    throw transitionError('virtual_projection_conflict',
      'typed event group must contain at least one event');
  }
  const prefix = `${journalText}${journalText && !journalText.endsWith('\n') ? '\n' : ''}`;
  const eventJournal = events.reduce((text, event) => `${text}${JSON.stringify(event)}\n`, prefix);
  const receipt = makeOperationReceipt({
    ...receiptInput,
    journalEventSha256: sha256(Buffer.from(eventJournal)),
  });
  return {
    journalText: `${eventJournal}${JSON.stringify(receipt)}\n`,
    receipt,
  };
}

function appendOperationReceipt(journalText, receiptInput) {
  const receipt = makeOperationReceipt({
    ...receiptInput,
    journalEventSha256: sha256(Buffer.from(journalText)),
  });
  return {
    journalText: `${journalText}${journalText && !journalText.endsWith('\n') ? '\n' : ''}`
      + `${JSON.stringify(receipt)}\n`,
    receipt,
  };
}

function validateExperiment(value) {
  const keys = [
    'id', 'category', 'description', 'rationale', 'pre_commit', 'commit', 'status',
    'raw_score', 'normalized_score', 'score_delta', 'loc_delta', 'flagged',
  ];
  if (plainObject(value) && Object.hasOwn(value, 'diagnose_outcome')) keys.push('diagnose_outcome');
  assertExactKeys(value, keys, 'experiment');
  requireSafeInteger(value.id, 'experiment.id', { min: 1 });
  if (!TAXONOMY.has(value.category)) throw transitionError('invalid_experiment_category', 'experiment.category is invalid');
  assertNoTsvControl(value.description, 'experiment.description');
  assertNoTsvControl(value.rationale, 'experiment.rationale');
  if (!FULL_COMMIT.test(value.pre_commit) || !FULL_COMMIT.test(value.commit)) {
    throw transitionError('invalid_commit', 'experiment commits must be full 40/64-hex IDs');
  }
  if (!new Set(['kept', 'discarded', 'failed']).has(value.status)) {
    throw transitionError('invalid_experiment_status', 'experiment.status is invalid');
  }
  for (const key of ['raw_score', 'normalized_score', 'score_delta']) {
    requireFinite(value[key], `experiment.${key}`);
  }
  requireSafeInteger(value.loc_delta, 'experiment.loc_delta');
  if (typeof value.flagged !== 'boolean') throw transitionError('invalid_field_type', 'experiment.flagged must be boolean');
  if (Object.hasOwn(value, 'diagnose_outcome')
      && !new Set(['recovered', 'failed', 'gave_up']).has(value.diagnose_outcome)) {
    throw transitionError('invalid_diagnose_outcome', 'experiment.diagnose_outcome is invalid');
  }
  return structuredClone(value);
}

function applyBaseline(session, payload, now) {
  if (Object.hasOwn(session.metric, 'baseline')) {
    throw transitionError('baseline_already_recorded', 'baseline has already been recorded');
  }
  if (session.status !== 'initializing') {
    throw transitionError('baseline_activation_invalid', 'baseline requires an initializing session');
  }
  const activeSeeds = session.virtual_parallel.seeds.filter((seed) => seed.status === 'active');
  if (activeSeeds.length !== session.virtual_parallel.n_initial) {
    throw transitionError('baseline_activation_invalid', 'every initial seed must be initialized before activation');
  }
  const next = structuredClone(session);
  next.metric = {
    ...next.metric,
    baseline: payload.normalized_score,
    current: payload.normalized_score,
    best: payload.normalized_score,
  };
  next.status = 'active';
  return {
    session: next,
    event: {
      event: 'baseline_recorded',
      operation_id: payload.operation_id,
      raw_score: payload.raw_score,
      normalized_score: payload.normalized_score,
      harness_identity: structuredClone(payload.harness_identity),
      ts: now,
    },
  };
}

function applyExperiment(session, payload, event, projection) {
  if (session.status !== 'active') {
    throw transitionError('session_not_active', 'experiment terminal requires active lifecycle', 1);
  }
  const next = structuredClone(session);
  next.experiments.total += 1;
  if (event.status === 'kept') next.experiments.kept += 1;
  else if (event.status === 'discarded') next.experiments.discarded += 1;
  else next.experiments.crashed += 1;
  if (event.status === 'kept') {
    next.metric.current = event.normalized_score;
    next.metric.best = Math.max(next.metric.best, event.normalized_score);
  }
  if (event.flagged) {
    next.shortcut.cumulative_flagged += 1;
    next.shortcut.flagged_since_last_tier3 += 1;
    next.shortcut.total_flagged += 1;
  }
  if (event.status === 'kept' && event.rationale.length === 0) {
    next.legibility.missing_rationale_count += 1;
  }
  if (Object.hasOwn(event, 'diagnose_outcome')) {
    next.diagnose_retry.session_retries_used += 1;
    if (event.diagnose_outcome === 'gave_up') next.diagnose_retry.gave_up_count += 1;
  }
  next.virtual_parallel = installProjection(next.virtual_parallel, projection);
  return next;
}

function applyEvaluatorExpansion(session, payload, now) {
  if (!new Set(['active', 'paused']).has(session.status)) {
    throw transitionError('evaluator_expansion_invalid', 'evaluator expansion requires active or paused lifecycle', 1);
  }
  if (payload.trigger_generation !== session.outer_loop.generation) {
    throw transitionError('trigger_generation_mismatch', 'trigger_generation is stale', 1);
  }
  const next = structuredClone(session);
  const epoch = next.evaluation_epoch.history.at(-1);
  epoch.prepare_version += 1;
  epoch.evaluator = {
    prepare_sha256: payload.harness_identity.prepare_sha256,
    config_sha256: payload.harness_identity.config_sha256,
    reason: payload.reason,
    trigger_generation: payload.trigger_generation,
    expanded_at: now,
  };
  next.shortcut.flagged_since_last_tier3 = 0;
  next.entropy.last_collapse_generation = null;
  return {
    session: next,
    event: {
      event: 'evaluator_expanded',
      operation_id: payload.operation_id,
      harness_identity: structuredClone(payload.harness_identity),
      prepare_version: epoch.prepare_version,
      epoch: next.evaluation_epoch.current,
      reason: payload.reason,
      trigger_generation: payload.trigger_generation,
      ts: now,
    },
  };
}

function applyCompletion(session, payload, now) {
  if (!new Set(['active', 'paused']).has(session.status)) {
    throw transitionError('completion_lifecycle_invalid', 'completion requires active or paused lifecycle', 1);
  }
  if (Object.hasOwn(session, 'completion')) {
    throw transitionError('session_already_completed', 'session completion already exists');
  }
  const completion = {
    outcome: payload.outcome,
    final_branch: payload.final_branch,
    final_commit: payload.final_commit,
    report: structuredClone(payload.report),
    receipt: structuredClone(payload.receipt),
    synthesis: structuredClone(payload.synthesis),
    final_strategy: structuredClone(payload.final_strategy),
    completed_at: now,
  };
  return {
    session: { ...structuredClone(session), status: 'completed', completion },
    event: {
      event: 'session_completed',
      operation_id: payload.operation_id,
      outcome: payload.outcome,
      final_branch: payload.final_branch,
      final_commit: payload.final_commit,
      report: structuredClone(payload.report),
      receipt: structuredClone(payload.receipt),
      synthesis: structuredClone(payload.synthesis),
      ts: now,
    },
  };
}

module.exports = {
  DIGEST,
  FULL_COMMIT,
  RESULTS_HEADER,
  TAXONOMY,
  appendOperationReceipt,
  appendTypedEventAndReceipt,
  appendTypedEventsAndReceipt,
  applyBaseline,
  applyCompletion,
  applyEvaluatorExpansion,
  applyExperiment,
  assertRepairableProjection,
  buildInitialSession,
  canonicalJson,
  findOperationReceipt,
  installProjection,
  isStrictSessionVersion,
  parseResultsTsv,
  parseStrictJsonl,
  projectionFromVirtual,
  projectionSha256,
  reduceVirtualProjection,
  requestSha256,
  requireDigest,
  requireOperationId,
  resultRowForExperiment,
  serializeResultRow,
  sessionNonProjectionSha256,
  sha256,
  transitionError,
  validateBeta,
  validateCommittedJournal,
  validateExperiment,
  validateInitialStateSpec,
  validateTransferPatch,
};
