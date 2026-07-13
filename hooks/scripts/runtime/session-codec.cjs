'use strict';

const SCALAR = Object.freeze({
  nulls: new Set(['null', '~']),
  booleans: new Map([['true', true], ['false', false]]),
  number: /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/,
  key: /^[A-Za-z_][A-Za-z0-9_-]*$/,
});

function stateError(sourcePath, line, reason) {
  const where = sourcePath ? ` in ${sourcePath}` : '';
  const at = line ? ` at line ${line}` : '';
  return Object.assign(new Error(`unsupported YAML${where}${at}: ${reason}`), {
    code: 'UNSUPPORTED_YAML',
    reason,
  });
}

function stripComment(value) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return value.slice(0, i).trimEnd();
  }
  return value.trimEnd();
}

function unquotedProjection(value) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (const char of value) {
    if (quote === '"' && escaped) {
      escaped = false;
      out += ' ';
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      out += ' ';
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      out += ' ';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += ' ';
    } else {
      out += char;
    }
  }
  return out;
}

function forbiddenReason(value) {
  // Anchors (`&`), aliases (`*`), tags (`!`) and block scalars (`|`/`>`) are rejected at the
  // exact value or key position they occupy (parseScalar / parseKey). That is flow-aware and,
  // unlike a whole-line regex, never misfires on an indicator character sitting in the interior
  // of an ordinary plain scalar (e.g. `reason: fix A, & B later`). Only the merge key needs a
  // line-level guard here because it is a mapping key rather than a value.
  const projected = unquotedProjection(value);
  if (/(?:^|\s)<<\s*:/.test(projected)) return 'merge key is not supported';
  return null;
}

function forbiddenValueReason(value) {
  // A plain scalar can never begin with a YAML node-property indicator (`&` anchor, `*` alias,
  // `!` tag) or be a bare block-scalar header (`|`/`>` optionally carrying indentation-indicator
  // digits and/or chomping indicators, e.g. `|2`, `|2-`, `|+2`, `>-`). Matching only the first
  // character both closes the `!!str`/`!<tag>`/`! ` coercion gap and, because inline collection
  // items are re-parsed through parseScalar, catches indicators nested in flow collections.
  if (value[0] === '&') return 'anchor is not supported';
  if (value[0] === '*') return 'alias is not supported';
  if (value[0] === '!') return 'tag is not supported';
  if (/^[|>][0-9+-]*$/.test(value)) return 'multiline scalar is not supported';
  return null;
}

function splitTopLevel(value, separator) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === separator && square === 0 && curly === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
    if (square < 0 || curly < 0) throw new Error('unbalanced inline collection');
  }
  if (quote || square !== 0 || curly !== 0) throw new Error('unbalanced inline collection');
  parts.push(value.slice(start).trim());
  return parts;
}

function findTopLevelColon(value) {
  let quote = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === ':' && square === 0 && curly === 0) return i;
  }
  return -1;
}

function parseKey(raw, context) {
  const key = raw.trim();
  if (key === '<<') throw stateError(context.sourcePath, context.line, 'merge key is not supported');
  if (!SCALAR.key.test(key)) throw stateError(context.sourcePath, context.line, `invalid key ${JSON.stringify(key)}`);
  return key;
}

function parseScalar(raw, context) {
  const value = raw.trim();
  if (value === '') return null;
  const forbidden = forbiddenValueReason(value);
  if (forbidden) throw stateError(context.sourcePath, context.line, forbidden);
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'string') throw new Error('not string');
      return parsed;
    } catch {
      throw stateError(context.sourcePath, context.line, 'invalid quoted scalar');
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw stateError(context.sourcePath, context.line, 'invalid quoted scalar');
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw stateError(context.sourcePath, context.line, 'invalid inline list');
    const body = value.slice(1, -1).trim();
    if (!body) return [];
    try { return splitTopLevel(body, ',').map((item) => parseScalar(item, context)); }
    catch (error) {
      if (error && error.code === 'UNSUPPORTED_YAML') throw error;
      throw stateError(context.sourcePath, context.line, 'invalid inline list');
    }
  }
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) throw stateError(context.sourcePath, context.line, 'invalid inline map');
    const body = value.slice(1, -1).trim();
    const result = {};
    if (!body) return result;
    let parts;
    try { parts = splitTopLevel(body, ','); }
    catch { throw stateError(context.sourcePath, context.line, 'invalid inline map'); }
    for (const part of parts) {
      const colon = findTopLevelColon(part);
      if (colon < 0) throw stateError(context.sourcePath, context.line, 'invalid inline map');
      const key = parseKey(part.slice(0, colon), context);
      if (Object.hasOwn(result, key)) throw stateError(context.sourcePath, context.line, `duplicate key ${key}`);
      result[key] = parseScalar(part.slice(colon + 1), context);
    }
    return result;
  }
  if (SCALAR.nulls.has(value)) return null;
  if (SCALAR.booleans.has(value)) return SCALAR.booleans.get(value);
  if (SCALAR.number.test(value)) return Number(value);
  return value;
}

function tokenise(text, sourcePath) {
  if (text.includes('\t')) throw stateError(sourcePath, null, 'tab indentation is not supported');
  const tokens = [];
  const lines = text.replace(/\r/g, '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const indent = /^ */.exec(raw)[0].length;
    if (indent % 2 !== 0) throw stateError(sourcePath, index + 1, 'indentation must be divisible by two');
    const content = stripComment(raw.slice(indent));
    if (!content.trim()) continue;
    const reason = forbiddenReason(content);
    if (reason) throw stateError(sourcePath, index + 1, reason);
    tokens.push({ indent, text: content.trim(), line: index + 1 });
  }
  return tokens;
}

function setMappingValue(target, key, value, token, sourcePath) {
  if (Object.hasOwn(target, key)) throw stateError(sourcePath, token.line, `duplicate key ${key}`);
  target[key] = value;
}

function parseMapping(tokens, start, indent, sourcePath, initial = {}) {
  const value = initial;
  let index = start;
  while (index < tokens.length && tokens[index].indent === indent && !tokens[index].text.startsWith('-')) {
    const token = tokens[index];
    const colon = findTopLevelColon(token.text);
    if (colon < 0) throw stateError(sourcePath, token.line, 'mapping entry requires a colon');
    const key = parseKey(token.text.slice(0, colon), { sourcePath, line: token.line });
    const rest = token.text.slice(colon + 1).trim();
    index += 1;
    if (rest !== '') {
      setMappingValue(value, key, parseScalar(rest, { sourcePath, line: token.line }), token, sourcePath);
      continue;
    }
    if (index < tokens.length && tokens[index].indent > indent) {
      if (tokens[index].indent !== indent + 2) throw stateError(sourcePath, tokens[index].line, 'invalid indentation jump');
      const child = parseBlock(tokens, index, indent + 2, sourcePath);
      setMappingValue(value, key, child.value, token, sourcePath);
      index = child.index;
    } else {
      setMappingValue(value, key, null, token, sourcePath);
    }
  }
  return { value, index };
}

function parseSequence(tokens, start, indent, sourcePath) {
  const value = [];
  let index = start;
  while (index < tokens.length && tokens[index].indent === indent && tokens[index].text.startsWith('-')) {
    const token = tokens[index];
    const rest = token.text.slice(1).trim();
    index += 1;
    if (!rest) {
      if (index >= tokens.length || tokens[index].indent !== indent + 2) {
        throw stateError(sourcePath, token.line, 'list item requires a value');
      }
      const child = parseBlock(tokens, index, indent + 2, sourcePath);
      value.push(child.value);
      index = child.index;
      continue;
    }
    const colon = findTopLevelColon(rest);
    if (colon < 0) {
      value.push(parseScalar(rest, { sourcePath, line: token.line }));
      continue;
    }
    const item = {};
    const key = parseKey(rest.slice(0, colon), { sourcePath, line: token.line });
    const scalar = rest.slice(colon + 1).trim();
    if (scalar) {
      setMappingValue(item, key, parseScalar(scalar, { sourcePath, line: token.line }), token, sourcePath);
    } else if (index < tokens.length && tokens[index].indent === indent + 4) {
      const child = parseBlock(tokens, index, indent + 4, sourcePath);
      setMappingValue(item, key, child.value, token, sourcePath);
      index = child.index;
    } else {
      setMappingValue(item, key, null, token, sourcePath);
    }
    if (index < tokens.length && tokens[index].indent === indent + 2) {
      const continuation = parseMapping(tokens, index, indent + 2, sourcePath, item);
      index = continuation.index;
    } else if (index < tokens.length && tokens[index].indent > indent) {
      throw stateError(sourcePath, tokens[index].line, 'invalid indentation jump');
    }
    value.push(item);
  }
  return { value, index };
}

function parseBlock(tokens, start, indent, sourcePath) {
  if (!tokens[start] || tokens[start].indent !== indent) {
    throw stateError(sourcePath, tokens[start] && tokens[start].line, 'invalid indentation');
  }
  return tokens[start].text.startsWith('-')
    ? parseSequence(tokens, start, indent, sourcePath)
    : parseMapping(tokens, start, indent, sourcePath);
}

function assertNoDuplicateJsonKeys(text, sourcePath) {
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(text[index] || '')) index += 1;
  };
  const readString = () => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const char = text[index++];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') return JSON.parse(text.slice(start, index));
    }
    throw stateError(sourcePath, null, 'invalid JSON-compatible YAML');
  };
  const readValue = () => {
    skipWhitespace();
    if (text[index] === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        if (text[index] !== '"') throw stateError(sourcePath, null, 'invalid JSON-compatible YAML');
        const key = readString();
        if (keys.has(key)) throw stateError(sourcePath, null, `duplicate key ${key}`);
        keys.add(key);
        skipWhitespace();
        if (text[index++] !== ':') throw stateError(sourcePath, null, 'invalid JSON-compatible YAML');
        readValue();
        skipWhitespace();
        const delimiter = text[index++];
        if (delimiter === '}') return;
        if (delimiter !== ',') throw stateError(sourcePath, null, 'invalid JSON-compatible YAML');
      }
    }
    if (text[index] === '[') {
      index += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      for (;;) {
        readValue();
        skipWhitespace();
        const delimiter = text[index++];
        if (delimiter === ']') return;
        if (delimiter !== ',') throw stateError(sourcePath, null, 'invalid JSON-compatible YAML');
      }
    }
    if (text[index] === '"') {
      readString();
      return;
    }
    const start = index;
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
    if (start === index) throw stateError(sourcePath, null, 'invalid JSON-compatible YAML');
  };
  readValue();
  skipWhitespace();
  if (index !== text.length) throw stateError(sourcePath, null, 'invalid JSON-compatible YAML');
}

function parseStateDocument(text, { sourcePath = '<state>' } = {}) {
  if (typeof text !== 'string') throw new TypeError('state document must be a string');
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r/g, '');
  const trimmed = normalized.trim();
  if (!trimmed) throw stateError(sourcePath, null, 'empty document');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed;
    try { parsed = JSON.parse(trimmed); }
    catch { throw stateError(sourcePath, null, 'invalid JSON-compatible YAML'); }
    assertNoDuplicateJsonKeys(trimmed, sourcePath);
    return parsed;
  }
  const tokens = tokenise(normalized, sourcePath);
  if (tokens.length === 0) throw stateError(sourcePath, null, 'empty document');
  if (tokens[0].indent !== 0) throw stateError(sourcePath, tokens[0].line, 'root indentation must be zero');
  const parsed = parseBlock(tokens, 0, 0, sourcePath);
  if (parsed.index !== tokens.length) {
    throw stateError(sourcePath, tokens[parsed.index].line, 'invalid indentation or trailing content');
  }
  return parsed.value;
}

function serializeStateDocument(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validationError(message) {
  return Object.assign(new Error(`state validation failed: ${message}`), { code: 'STATE_VALIDATION_FAILED' });
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) && !key.startsWith('x-')) throw validationError(`unknown ${label} key ${key}`);
  }
}

function rejectKnownObject(value, allowed, label) {
  if (value === undefined || value === null) return;
  if (!plainObject(value)) throw validationError(`${label} must be an object`);
  rejectUnknown(value, allowed, label);
}

const SESSION_KEYS = new Set([
  'session_id', 'deep_evolve_version', 'status', 'created_at', 'goal', 'parent_session',
  'program', 'outer_loop', 'evaluation_epoch', 'lineage', 'shortcut', 'diagnose_retry',
  'legibility', 'entropy', 'metric', 'eval_mode', 'protocol_tools', 'virtual_parallel',
  'total_budget', 'target_files', 'transfer', 'final_strategy', 'experiments',
]);
const VP_KEYS = new Set([
  'enabled', 'N', 'n_current', 'n_initial', 'n_range', 'project_type',
  'eval_parallelizability', 'selection_reason', 'budget_total', 'budget_unallocated',
  'unallocated_pool', 'synthesis', 'seeds',
]);
const SEED_KEYS = new Set([
  'id', 'seed_id', 'seed_origin', 'status', 'direction', 'hypothesis', 'initial_rationale',
  'worktree_path', 'branch', 'created_at', 'created_by', 'experiments_used', 'keeps',
  'experiments_used_this_epoch',
  'borrows_given', 'borrows_received', 'current_q', 'final_q', 'q_history',
  'allocated_budget', 'killed_at', 'killed_reason', 'best_score',
]);
const METRIC_KEYS = new Set(['name', 'direction', 'baseline', 'current', 'best']);
const PROGRAM_KEYS = new Set(['version', 'history']);
const PROGRAM_HISTORY_KEYS = new Set(['version', 'experiments', 'keep_rate', 'reason', 'created_at']);
const OUTER_LOOP_KEYS = new Set(['generation', 'interval', 'inner_count', 'auto_trigger', 'q_history']);
const Q_HISTORY_KEYS = new Set(['generation', 'Q', 'epoch', 'score', 'created_at']);
const EVALUATION_EPOCH_KEYS = new Set(['current', 'history']);
const EPOCH_HISTORY_KEYS = new Set(['epoch', 'prepare_version', 'generations', 'best_Q', 'created_at']);
const PARENT_SESSION_KEYS = new Set(['id', 'parent_receipt_schema_version', 'seed_source', 'inherited_at']);
const SEED_SOURCE_KEYS = new Set(['strategy_version', 'program_version', 'notable_keep_commit_refs']);
const LINEAGE_KEYS = new Set(['current_branch', 'forked_from', 'previous_branches']);
const SHORTCUT_STATE_KEYS = new Set(['cumulative_flagged', 'flagged_since_last_tier3', 'total_flagged']);
const DIAGNOSE_STATE_KEYS = new Set(['session_retries_used', 'gave_up_count']);
const LEGIBILITY_STATE_KEYS = new Set(['missing_rationale_count']);
const ENTROPY_STATE_KEYS = new Set(['last_collapse_generation']);
const RANGE_KEYS = new Set(['min', 'max']);
const SYNTHESIS_KEYS = new Set(['budget_allocated', 'regression_tolerance']);
const EXPERIMENTS_KEYS = new Set(['total', 'kept', 'discarded', 'crashed']);
const TRANSFER_KEYS = new Set([
  'source_id', 'source_schema_version', 'source_artifacts', 'adopted_at',
]);
const STRICT_SESSION_KEYS = new Set([
  'session_id', 'deep_evolve_version', 'status', 'created_at', 'goal', 'parent_session',
  'experiments', 'program', 'outer_loop', 'evaluation_epoch', 'lineage', 'shortcut',
  'diagnose_retry', 'legibility', 'entropy', 'metric', 'eval_mode', 'protocol_tools',
  'total_budget', 'target_files', 'transfer', 'virtual_parallel',
]);
const STRICT_PARENT_SESSION_KEYS = new Set(['id', 'inherited_at']);
const STRICT_VP_KEYS = new Set([
  'enabled', 'n_current', 'n_initial', 'n_range', 'project_type',
  'eval_parallelizability', 'selection_reason', 'budget_total', 'budget_unallocated',
  'synthesis', 'seeds',
]);

function requireKeys(value, keys, label) {
  if (!plainObject(value)) throw validationError(`${label} must be an object`);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw validationError(`${label}.${key} is required`);
  }
}

function requireSafeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw validationError(`${label} must be an integer from ${min} to ${max}`);
  }
}

function normalizedProjectRelativeTarget(value) {
  if (typeof value !== 'string' || value.length === 0
      || value.includes('\0')
      || value.startsWith('/')
      || value.startsWith('\\')
      || /^[A-Za-z]:/.test(value)
      || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
    && segments.join('/') === value;
}

function isStrictSessionVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version || '');
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 5);
}

function validateStrictSession(value) {
  requireKeys(value, STRICT_SESSION_KEYS, 'session');
  if (typeof value.goal !== 'string') throw validationError('goal must be a string');
  if (value.parent_session !== null) {
    rejectKnownObject(value.parent_session, STRICT_PARENT_SESSION_KEYS, 'parent_session');
    requireKeys(value.parent_session, STRICT_PARENT_SESSION_KEYS, 'parent_session');
    if (typeof value.parent_session.id !== 'string' || value.parent_session.id.length === 0) {
      throw validationError('parent_session.id must be a non-empty string');
    }
    if (typeof value.parent_session.inherited_at !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.parent_session.inherited_at)) {
      throw validationError('parent_session.inherited_at must be UTC ISO 8601');
    }
  }

  rejectKnownObject(value.experiments, EXPERIMENTS_KEYS, 'experiments');
  requireKeys(value.experiments, EXPERIMENTS_KEYS, 'experiments');
  for (const key of EXPERIMENTS_KEYS) requireSafeInteger(value.experiments[key], `experiments.${key}`);
  if (value.experiments.total
      !== value.experiments.kept + value.experiments.discarded + value.experiments.crashed) {
    throw validationError('experiments.total must equal terminal experiment counters');
  }

  requireKeys(value.program, new Set(['version', 'history']), 'program');
  requireSafeInteger(value.program.version, 'program.version', { min: 1 });
  if (value.program.history.length === 0) throw validationError('program.history must not be empty');
  for (const [index, entry] of value.program.history.entries()) {
    requireKeys(entry, new Set(['version', 'experiments', 'keep_rate', 'reason', 'created_at']),
      `program.history ${index}`);
    requireSafeInteger(entry.version, `program.history ${index}.version`, { min: 1 });
    if (typeof entry.experiments !== 'string' || entry.experiments.length === 0) {
      throw validationError(`program.history ${index}.experiments must be a non-empty string`);
    }
    if (entry.keep_rate !== null && !Number.isFinite(entry.keep_rate)) {
      throw validationError(`program.history ${index}.keep_rate must be null or finite`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.length === 0) {
      throw validationError(`program.history ${index}.reason must be a non-empty string`);
    }
    if (typeof entry.created_at !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(entry.created_at)) {
      throw validationError(`program.history ${index}.created_at must be UTC ISO 8601`);
    }
  }

  requireKeys(value.outer_loop,
    new Set(['generation', 'interval', 'inner_count', 'auto_trigger', 'q_history']),
    'outer_loop');
  requireSafeInteger(value.outer_loop.generation, 'outer_loop.generation');
  requireSafeInteger(value.outer_loop.interval, 'outer_loop.interval', { min: 1 });
  requireSafeInteger(value.outer_loop.inner_count, 'outer_loop.inner_count');
  if (typeof value.outer_loop.auto_trigger !== 'boolean') {
    throw validationError('outer_loop.auto_trigger must be boolean');
  }

  requireKeys(value.evaluation_epoch, new Set(['current', 'history']), 'evaluation_epoch');
  requireSafeInteger(value.evaluation_epoch.current, 'evaluation_epoch.current', { min: 1 });
  if (value.evaluation_epoch.history.length === 0) {
    throw validationError('evaluation_epoch.history must not be empty');
  }
  const epochs = new Set();
  for (const [index, entry] of value.evaluation_epoch.history.entries()) {
    requireKeys(entry,
      new Set(['epoch', 'prepare_version', 'generations', 'best_Q', 'created_at']),
      `evaluation_epoch.history ${index}`);
    requireSafeInteger(entry.epoch, `evaluation_epoch.history ${index}.epoch`, { min: 1 });
    if (epochs.has(entry.epoch)) throw validationError('evaluation_epoch.history epochs must be unique');
    epochs.add(entry.epoch);
    requireSafeInteger(entry.prepare_version,
      `evaluation_epoch.history ${index}.prepare_version`, { min: 1 });
    if (!Array.isArray(entry.generations)
        || entry.generations.some((generation) => !Number.isSafeInteger(generation) || generation < 0)) {
      throw validationError(`evaluation_epoch.history ${index}.generations must be nonnegative integers`);
    }
    if (entry.best_Q !== null && !Number.isFinite(entry.best_Q)) {
      throw validationError(`evaluation_epoch.history ${index}.best_Q must be null or finite`);
    }
    if (typeof entry.created_at !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(entry.created_at)) {
      throw validationError(`evaluation_epoch.history ${index}.created_at must be UTC ISO 8601`);
    }
  }
  if (!epochs.has(value.evaluation_epoch.current)
      || value.evaluation_epoch.history[value.evaluation_epoch.history.length - 1].epoch
        !== value.evaluation_epoch.current) {
    throw validationError('evaluation_epoch.current must match the current history entry');
  }

  requireKeys(value.lineage, new Set(['current_branch', 'forked_from', 'previous_branches']),
    'lineage');
  if (typeof value.lineage.current_branch !== 'string' || value.lineage.current_branch.length === 0) {
    throw validationError('lineage.current_branch must be a non-empty string');
  }
  if (value.lineage.forked_from !== null
      && (typeof value.lineage.forked_from !== 'string' || value.lineage.forked_from.length === 0)) {
    throw validationError('lineage.forked_from must be null or a non-empty string');
  }
  if (!Array.isArray(value.lineage.previous_branches)
      || value.lineage.previous_branches.some((branch) => typeof branch !== 'string' || branch.length === 0)) {
    throw validationError('lineage.previous_branches must be a string array');
  }

  requireKeys(value.shortcut,
    new Set(['cumulative_flagged', 'flagged_since_last_tier3', 'total_flagged']),
    'shortcut');
  for (const key of SHORTCUT_STATE_KEYS) requireSafeInteger(value.shortcut[key], `shortcut.${key}`);
  requireKeys(value.diagnose_retry, DIAGNOSE_STATE_KEYS, 'diagnose_retry');
  for (const key of DIAGNOSE_STATE_KEYS) {
    requireSafeInteger(value.diagnose_retry[key], `diagnose_retry.${key}`);
  }
  requireKeys(value.legibility, LEGIBILITY_STATE_KEYS, 'legibility');
  requireSafeInteger(value.legibility.missing_rationale_count,
    'legibility.missing_rationale_count');
  requireKeys(value.entropy, ENTROPY_STATE_KEYS, 'entropy');
  if (value.entropy.last_collapse_generation !== null) {
    requireSafeInteger(value.entropy.last_collapse_generation,
      'entropy.last_collapse_generation');
  }

  requireKeys(value.metric, new Set(['name', 'direction']), 'metric');
  if (typeof value.metric.name !== 'string' || value.metric.name.length === 0) {
    throw validationError('metric.name must be a non-empty string');
  }
  const scoreKeys = ['baseline', 'current', 'best'];
  const presentScores = scoreKeys.filter((key) => Object.hasOwn(value.metric, key));
  if (presentScores.length !== 0 && presentScores.length !== scoreKeys.length) {
    throw validationError('metric baseline, current, and best must be present together');
  }
  if (value.status !== 'initializing' && presentScores.length !== scoreKeys.length) {
    throw validationError('metric baseline, current, and best are required before activation');
  }

  if (!Array.isArray(value.protocol_tools)
      || value.protocol_tools.some((tool) => typeof tool !== 'string' || tool.length === 0)
      || new Set(value.protocol_tools).size !== value.protocol_tools.length) {
    throw validationError('protocol_tools must be a unique string array');
  }
  if ((value.eval_mode === 'cli' && value.protocol_tools.length !== 0)
      || (value.eval_mode === 'protocol' && value.protocol_tools.length === 0)) {
    throw validationError('protocol_tools must be empty for cli and non-empty for protocol');
  }
  requireSafeInteger(value.total_budget, 'total_budget', { min: 1 });
  if (!Array.isArray(value.target_files) || value.target_files.length === 0
      || value.target_files.some((entry) => !normalizedProjectRelativeTarget(entry))
      || new Set(value.target_files).size !== value.target_files.length) {
    throw validationError('target_files must be unique normalized project-relative paths');
  }

  if (value.transfer !== null) {
    rejectKnownObject(value.transfer, TRANSFER_KEYS, 'transfer');
    requireKeys(value.transfer, TRANSFER_KEYS, 'transfer');
    if (typeof value.transfer.source_id !== 'string' || value.transfer.source_id.length === 0) {
      throw validationError('transfer.source_id must be a non-empty string');
    }
    if (!(typeof value.transfer.source_schema_version === 'string'
          && value.transfer.source_schema_version.length > 0)
        && !Number.isSafeInteger(value.transfer.source_schema_version)) {
      throw validationError('transfer.source_schema_version must be a string or integer');
    }
    if (!Array.isArray(value.transfer.source_artifacts)
        || value.transfer.source_artifacts.some((entry) => typeof entry !== 'string' || entry.length === 0)
        || new Set(value.transfer.source_artifacts).size !== value.transfer.source_artifacts.length) {
      throw validationError('transfer.source_artifacts must be a unique string array');
    }
    if (typeof value.transfer.adopted_at !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.transfer.adopted_at)) {
      throw validationError('transfer.adopted_at must be UTC ISO 8601');
    }
  }

  const virtual = value.virtual_parallel;
  rejectKnownObject(virtual, STRICT_VP_KEYS, 'virtual_parallel');
  requireKeys(virtual, new Set([
    'enabled', 'n_initial', 'n_range', 'project_type', 'eval_parallelizability',
    'selection_reason', 'budget_total', 'budget_unallocated', 'synthesis', 'seeds',
  ]), 'virtual_parallel');
  if (virtual.enabled !== true) throw validationError('virtual_parallel.enabled must be true');
  requireSafeInteger(virtual.n_initial, 'virtual_parallel.n_initial', { min: 1, max: 9 });
  requireKeys(virtual.n_range, RANGE_KEYS, 'virtual_parallel.n_range');
  if (virtual.n_range.min !== 1 || virtual.n_range.max !== 9) {
    throw validationError('virtual_parallel.n_range must be exactly 1 to 9');
  }
  if (!new Set(['narrow_tuning', 'standard_optimization', 'open_research'])
    .has(virtual.project_type)) {
    throw validationError('virtual_parallel.project_type is invalid');
  }
  if (!new Set(['serialized', 'parallel_capable']).has(virtual.eval_parallelizability)) {
    throw validationError('virtual_parallel.eval_parallelizability is invalid');
  }
  if (typeof virtual.selection_reason !== 'string' || virtual.selection_reason.length === 0) {
    throw validationError('virtual_parallel.selection_reason must be a non-empty string');
  }
  requireSafeInteger(virtual.budget_total, 'virtual_parallel.budget_total', { min: 1 });
  requireSafeInteger(virtual.budget_unallocated, 'virtual_parallel.budget_unallocated');
  if (virtual.budget_total !== value.total_budget) {
    throw validationError('virtual_parallel.budget_total must equal total_budget');
  }
  if (value.total_budget < 3 * virtual.n_initial) {
    throw validationError('total_budget must preserve the per-seed floor');
  }
  requireKeys(virtual.synthesis, SYNTHESIS_KEYS, 'virtual_parallel.synthesis');
  requireSafeInteger(virtual.synthesis.budget_allocated,
    'virtual_parallel.synthesis.budget_allocated');
  if (!Number.isFinite(virtual.synthesis.regression_tolerance)
      || virtual.synthesis.regression_tolerance < 0) {
    throw validationError('virtual_parallel.synthesis.regression_tolerance must be nonnegative');
  }

  const ids = new Set();
  let activeCount = 0;
  let allocated = 0;
  for (const [index, seed] of virtual.seeds.entries()) {
    const id = seed.id === undefined ? seed.seed_id : seed.id;
    if (ids.has(id)) throw validationError('virtual_parallel seed identities must be unique');
    ids.add(id);
    if (seed.status === 'active') activeCount += 1;
    requireSafeInteger(seed.allocated_budget, `seed ${index}.allocated_budget`);
    allocated += seed.allocated_budget;
  }
  if (allocated + virtual.budget_unallocated !== virtual.budget_total) {
    throw validationError('virtual_parallel budget must equal allocated plus unallocated');
  }
  if (activeCount === 0) {
    if (virtual['x-active-seed-count'] !== 0 || Object.hasOwn(virtual, 'n_current')) {
      throw validationError('zero active seeds require only x-active-seed-count: 0');
    }
  } else if (virtual.n_current !== activeCount
      || Object.hasOwn(virtual, 'x-active-seed-count')) {
    throw validationError('n_current must equal the number of active seeds');
  }
}

function validateSession(value) {
  if (!plainObject(value)) throw validationError('session must be an object');
  rejectUnknown(value, SESSION_KEYS, 'session');
  if (typeof value.session_id !== 'string' || value.session_id.length === 0) throw validationError('session_id must be a string');
  if (typeof value.deep_evolve_version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.deep_evolve_version)) {
    throw validationError('deep_evolve_version must be SemVer');
  }
  if (!new Set(['initializing', 'active', 'paused', 'completed', 'aborted']).has(value.status)) {
    throw validationError(`invalid status ${JSON.stringify(value.status)}`);
  }
  if (typeof value.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.created_at)) {
    throw validationError('created_at must be UTC ISO 8601');
  }
  if (value.eval_mode !== undefined && !new Set(['cli', 'protocol']).has(value.eval_mode)) {
    throw validationError('eval_mode must be cli or protocol');
  }
  if (value.metric !== undefined) {
    rejectKnownObject(value.metric, METRIC_KEYS, 'metric');
    if (value.metric.direction !== undefined && !new Set(['minimize', 'maximize']).has(value.metric.direction)) {
      throw validationError('metric.direction must be minimize or maximize');
    }
    for (const key of ['baseline', 'current', 'best']) {
      if (value.metric[key] !== undefined && !Number.isFinite(value.metric[key])) throw validationError(`metric.${key} must be finite`);
    }
  }
  rejectKnownObject(value.program, PROGRAM_KEYS, 'program');
  if (value.program && value.program.history !== undefined) {
    if (!Array.isArray(value.program.history)) throw validationError('program.history must be an array');
    value.program.history.forEach((entry, index) => rejectKnownObject(entry, PROGRAM_HISTORY_KEYS, `program.history ${index}`));
  }
  rejectKnownObject(value.outer_loop, OUTER_LOOP_KEYS, 'outer_loop');
  if (value.outer_loop && value.outer_loop.q_history !== undefined) {
    if (!Array.isArray(value.outer_loop.q_history)) throw validationError('outer_loop.q_history must be an array');
    value.outer_loop.q_history.forEach((entry, index) => rejectKnownObject(entry, Q_HISTORY_KEYS, `outer_loop.q_history ${index}`));
  }
  rejectKnownObject(value.evaluation_epoch, EVALUATION_EPOCH_KEYS, 'evaluation_epoch');
  if (value.evaluation_epoch && value.evaluation_epoch.history !== undefined) {
    if (!Array.isArray(value.evaluation_epoch.history)) throw validationError('evaluation_epoch.history must be an array');
    value.evaluation_epoch.history.forEach((entry, index) => rejectKnownObject(entry, EPOCH_HISTORY_KEYS, `evaluation_epoch.history ${index}`));
  }
  rejectKnownObject(value.parent_session, PARENT_SESSION_KEYS, 'parent_session');
  if (value.parent_session) rejectKnownObject(value.parent_session.seed_source, SEED_SOURCE_KEYS, 'parent_session.seed_source');
  rejectKnownObject(value.lineage, LINEAGE_KEYS, 'lineage');
  rejectKnownObject(value.shortcut, SHORTCUT_STATE_KEYS, 'shortcut');
  rejectKnownObject(value.diagnose_retry, DIAGNOSE_STATE_KEYS, 'diagnose_retry');
  rejectKnownObject(value.legibility, LEGIBILITY_STATE_KEYS, 'legibility');
  rejectKnownObject(value.entropy, ENTROPY_STATE_KEYS, 'entropy');
  if (value.virtual_parallel !== undefined) {
    if (!plainObject(value.virtual_parallel)) throw validationError('virtual_parallel must be an object');
    rejectUnknown(value.virtual_parallel, VP_KEYS, 'virtual_parallel');
    for (const key of ['N', 'n_current', 'n_initial']) {
      if (value.virtual_parallel[key] !== undefined && (!Number.isInteger(value.virtual_parallel[key]) || value.virtual_parallel[key] < 1 || value.virtual_parallel[key] > 9)) {
        throw validationError(`virtual_parallel.${key} must be an integer from 1 to 9`);
      }
    }
    if (Object.hasOwn(value.virtual_parallel, 'x-active-seed-count')) {
      if (value.virtual_parallel['x-active-seed-count'] !== 0) {
        throw validationError('virtual_parallel.x-active-seed-count must be the integer 0');
      }
      if (Object.hasOwn(value.virtual_parallel, 'n_current')) {
        throw validationError('virtual_parallel.x-active-seed-count cannot coexist with n_current');
      }
    }
    rejectKnownObject(value.virtual_parallel.n_range, RANGE_KEYS, 'virtual_parallel.n_range');
    rejectKnownObject(value.virtual_parallel.synthesis, SYNTHESIS_KEYS, 'virtual_parallel.synthesis');
    if (value.virtual_parallel.seeds !== undefined) {
      if (!Array.isArray(value.virtual_parallel.seeds)) throw validationError('virtual_parallel.seeds must be an array');
      for (const [index, seed] of value.virtual_parallel.seeds.entries()) {
        if (!plainObject(seed)) throw validationError(`seed ${index} must be an object`);
        rejectUnknown(seed, SEED_KEYS, `seed ${index}`);
        const id = seed.id === undefined ? seed.seed_id : seed.id;
        if (!Number.isInteger(id) || id < 1) throw validationError(`seed ${index} id must be positive`);
        if (seed.status !== undefined && (typeof seed.status !== 'string'
          || !/^(?:active|paused|completed|completed_early|killed(?::|_)[A-Za-z0-9_-]+)$/.test(seed.status))) {
          throw validationError(`seed ${index} status is invalid`);
        }
        if (Object.hasOwn(value.virtual_parallel, 'x-active-seed-count')
          && (seed.status === undefined || seed.status === 'active')) {
          throw validationError(`virtual_parallel.x-active-seed-count requires seed ${index} to have explicit non-active status`);
        }
      }
    }
  }
  if (isStrictSessionVersion(value.deep_evolve_version)) validateStrictSession(value);
  return value;
}

const STRATEGY_KEYS = new Set([
  'version', 'schema_version', 'idea_selection', 'judgment', 'convergence',
  'exploration', 'mutation', 'weights', 'strategy_version', 'shortcut_detection',
  'legibility', 'entropy_tracking',
]);
const IDEA_SELECTION_KEYS = new Set(['method', 'weights', 'candidates_per_step', 'min_novelty_distance']);
const IDEA_WEIGHT_KEYS = new Set([
  'parameter_tune', 'refactor_simplify', 'add_guard', 'algorithm_swap',
  'data_preprocessing', 'caching_memoization', 'error_handling', 'api_redesign',
  'test_expansion', 'other',
]);
const JUDGMENT_KEYS = new Set(['min_delta', 'crash_tolerance', 'marginal_policy', 'diagnose_retry']);
const JUDGMENT_RETRY_KEYS = new Set(['enabled', 'max_per_session', 'severe_drop_delta', 'error_keywords']);
const CONVERGENCE_KEYS = new Set(['consecutive_discard_limit', 'plateau_window', 'plateau_action']);
const EXPLORATION_KEYS = new Set(['radical_threshold', 'backtrack_enabled', 'backtrack_strategy']);
const SHORTCUT_DETECTION_KEYS = new Set([
  'enabled', 'auto_flag_delta', 'min_loc', 'cumulative_threshold',
  'tier3_flagged_threshold', 'seal_prepare_read',
]);
const LEGIBILITY_KEYS = new Set(['enabled', 'require_rationale_on_keep', 'max_rationale_chars', 'block_identical_to_description']);
const ENTROPY_TRACKING_KEYS = new Set(['enabled', 'window_size', 'collapse_threshold_bits']);

function validateStrategy(value) {
  if (!plainObject(value)) throw validationError('strategy must be an object');
  rejectUnknown(value, STRATEGY_KEYS, 'strategy');
  const version = value.version === undefined ? value.strategy_version : value.version;
  if (version !== undefined && !(Number.isInteger(version) && version >= 1) && typeof version !== 'string') {
    throw validationError('strategy version must be a positive integer or string');
  }
  rejectKnownObject(value.idea_selection, IDEA_SELECTION_KEYS, 'idea_selection');
  if (value.idea_selection) rejectKnownObject(value.idea_selection.weights, IDEA_WEIGHT_KEYS, 'idea_selection.weights');
  rejectKnownObject(value.judgment, JUDGMENT_KEYS, 'judgment');
  if (value.judgment) rejectKnownObject(value.judgment.diagnose_retry, JUDGMENT_RETRY_KEYS, 'judgment.diagnose_retry');
  rejectKnownObject(value.convergence, CONVERGENCE_KEYS, 'convergence');
  rejectKnownObject(value.exploration, EXPLORATION_KEYS, 'exploration');
  rejectKnownObject(value.shortcut_detection, SHORTCUT_DETECTION_KEYS, 'shortcut_detection');
  rejectKnownObject(value.legibility, LEGIBILITY_KEYS, 'legibility');
  rejectKnownObject(value.entropy_tracking, ENTROPY_TRACKING_KEYS, 'entropy_tracking');
  return value;
}

module.exports = {
  SCALAR,
  parseStateDocument,
  serializeStateDocument,
  validateSession,
  validateStrategy,
};
