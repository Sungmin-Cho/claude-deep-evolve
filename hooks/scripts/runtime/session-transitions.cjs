'use strict';

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

function initialStateError(code, message) {
  return Object.assign(new TypeError(message), { code });
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

module.exports = {
  buildInitialSession,
  validateInitialStateSpec,
};
