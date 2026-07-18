'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { atomicWriteFile } = require('./session-store.cjs');
const { isPathInside } = require('./runtime-paths.cjs');

const CONFIG_NAME = 'prepare.config.json';
const HARNESS_NAME = 'prepare.cjs';
const LEGACY_NAME = 'prepare.py';
const ENGINE_MARKER = '# ── Evaluation Engine';
const TEMPLATE_NAMES = Object.freeze({
  'stdout-parser': 'prepare-stdout-parse.cjs',
  'test-runner': 'prepare-test-runner.cjs',
  scenario: 'prepare-scenario.cjs',
});
const LEGACY_ENGINES = Object.freeze({
  '4da96e3d3ba62aee3c70c024516e3b38ff315d57942f5b0ec0930aaa82c362a5': 'stdout-parser',
  '136356b086e085355d5c0fb867330836be9a88750c37eb7c23d8cc98369d51ee': 'test-runner',
  '0e5fb544c06e92c19b28fb073bf3cf12e9e6509f9ef8015fcbc45ceba77fa2c0': 'scenario',
});
const FORBIDDEN_EXECUTABLES = /^(?:python(?:3(?:\.\d+)?)?|py|bash|sh|zsh|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/i;

class HarnessError extends Error {
  constructor(code, message, rc = 2, details) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.rc = rc;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new HarnessError(code, message, 2, details);
}

function regenerate(message, details) {
  throw new HarnessError('legacy_harness_requires_regeneration', message, 1, details);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validatePlainTree(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePlainTree(item, `${label}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (!plainObject(value)) fail('invalid_harness_config', `${label} must contain only plain JSON objects`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor') {
      fail('invalid_harness_config', `${label} contains an unsafe field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      fail('invalid_harness_config', `${label}.${key} must be an enumerable data property`);
    }
    validatePlainTree(descriptor.value, `${label}.${key}`);
  }
}

function object(value, label) {
  if (!plainObject(value)) fail('invalid_harness_config', `${label} must be an object`);
  validatePlainTree(value, label);
  return value;
}

function onlyKeys(value, keys, label) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('invalid_harness_config', `${label} contains unknown field ${JSON.stringify(key)}`);
  }
}

function string(value, label, { empty = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || (!empty && value.length === 0)) {
    fail('invalid_harness_config', `${label} must be ${empty ? 'a string' : 'a non-empty string'} without NUL`);
  }
  return value;
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid_harness_config', `${label} must be a finite number`);
  }
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('invalid_harness_config', `${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function projectForSession(sessionRoot) {
  string(sessionRoot, 'sessionRoot');
  if (!path.isAbsolute(sessionRoot)) fail('invalid_session_root', 'sessionRoot must be absolute');
  let resolved;
  try { resolved = fs.realpathSync(sessionRoot); }
  catch { fail('invalid_session_root', `sessionRoot does not exist: ${sessionRoot}`); }
  if (!fs.statSync(resolved).isDirectory()) fail('invalid_session_root', 'sessionRoot must be a directory');
  let current = resolved;
  for (;;) {
    if (path.basename(current) === '.deep-evolve') {
      if (current === resolved) fail('invalid_session_root', 'sessionRoot must be below .deep-evolve');
      return { sessionRoot: resolved, stateRoot: current, projectRoot: path.dirname(current) };
    }
    const parent = path.dirname(current);
    if (parent === current) fail('invalid_session_root', 'sessionRoot must be below a .deep-evolve directory');
    current = parent;
  }
}

function resolveCwd(value, projectRoot, label) {
  if (value === undefined) return projectRoot;
  string(value, label);
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
  if (!isPathInside(projectRoot, candidate)) fail('harness_cwd_escape', `${label} must stay inside the project root`);
  let resolved;
  try { resolved = fs.realpathSync(candidate); }
  catch { fail('invalid_harness_config', `${label} does not exist: ${candidate}`); }
  if (!isPathInside(projectRoot, resolved) || !fs.statSync(resolved).isDirectory()) {
    fail('harness_cwd_escape', `${label} must resolve to a project directory`);
  }
  return resolved;
}

function validateCommand(value, projectRoot, label) {
  object(value, label);
  onlyKeys(value, ['file', 'args', 'cwd', 'timeout_ms'], label);
  const file = string(value.file, `${label}.file`);
  const executable = path.win32.basename(file).replace(/\.exe$/i, '');
  if (FORBIDDEN_EXECUTABLES.test(executable) || FORBIDDEN_EXECUTABLES.test(path.basename(file))) {
    fail('unsupported_harness_executable', `${label}.file cannot select a shell or Python executable`);
  }
  if (!Array.isArray(value.args)) fail('invalid_harness_config', `${label}.args must be an array`);
  const args = value.args.map((item, index) => string(item, `${label}.args[${index}]`, { empty: true }));
  resolveCwd(value.cwd, projectRoot, `${label}.cwd`);
  return {
    file,
    args,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    timeout_ms: integer(value.timeout_ms, `${label}.timeout_ms`, 1, 3_600_000),
  };
}

function validateWeights(value, label, expectedNames) {
  object(value, label);
  const result = {};
  for (const [name, weight] of Object.entries(value)) {
    if (expectedNames && !expectedNames.has(name)) fail('invalid_harness_config', `${label} contains unknown weight ${name}`);
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) fail('invalid_harness_config', `${label} contains unsafe category ${name}`);
    result[name] = finite(weight, `${label}.${name}`);
    if (result[name] < 0) fail('invalid_harness_config', `${label}.${name} must be non-negative`);
  }
  return result;
}

function validateMetrics(value) {
  object(value, 'spec.metrics');
  const result = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) fail('invalid_harness_config', `unsafe metric name ${JSON.stringify(name)}`);
    object(raw, `spec.metrics.${name}`);
    onlyKeys(raw, ['pattern', 'weight'], `spec.metrics.${name}`);
    const pattern = string(raw.pattern, `spec.metrics.${name}.pattern`);
    try { new RegExp(pattern, 'm'); } catch { fail('invalid_harness_config', `invalid metric regex for ${name}`); }
    const weight = finite(raw.weight, `spec.metrics.${name}.weight`);
    if (weight < 0) fail('invalid_harness_config', `metric weight for ${name} must be non-negative`);
    result[name] = { pattern, weight };
  }
  return result;
}

function validateSpec(spec, projectRoot) {
  object(spec, 'spec');
  const common = ['kind', 'description'];
  const kind = string(spec.kind, 'spec.kind');
  if (!Object.hasOwn(TEMPLATE_NAMES, kind)) fail('unknown_harness_kind', `unsupported harness kind ${JSON.stringify(kind)}`);
  const description = spec.description === undefined ? undefined : string(spec.description, 'spec.description', { empty: true });
  if (kind === 'stdout-parser') {
    onlyKeys(spec, [...common, 'command', 'metric_direction', 'baseline_score', 'metrics'], 'spec');
    const direction = spec.metric_direction;
    if (direction !== 'maximize' && direction !== 'minimize') {
      fail('invalid_harness_config', 'spec.metric_direction must be maximize or minimize');
    }
    const baseline = spec.baseline_score === undefined || spec.baseline_score === null
      ? null : finite(spec.baseline_score, 'spec.baseline_score');
    return {
      schema_version: '1.0', kind,
      ...(description === undefined ? {} : { description }),
      command: validateCommand(spec.command, projectRoot, 'spec.command'),
      metric_direction: direction,
      baseline_score: baseline,
      metrics: validateMetrics(spec.metrics),
    };
  }
  if (kind === 'test-runner') {
    onlyKeys(spec, [...common, 'test_command', 'coverage_command', 'lint_command', 'weights'], 'spec');
    const expected = new Set(['test_pass_rate', 'coverage', 'lint']);
    const weights = validateWeights(spec.weights, 'spec.weights', expected);
    for (const name of expected) if (!Object.hasOwn(weights, name)) weights[name] = 0;
    return {
      schema_version: '1.0', kind,
      ...(description === undefined ? {} : { description }),
      test_command: validateCommand(spec.test_command, projectRoot, 'spec.test_command'),
      coverage_command: spec.coverage_command === null || spec.coverage_command === undefined
        ? null : validateCommand(spec.coverage_command, projectRoot, 'spec.coverage_command'),
      lint_command: spec.lint_command === null || spec.lint_command === undefined
        ? null : validateCommand(spec.lint_command, projectRoot, 'spec.lint_command'),
      weights,
    };
  }
  onlyKeys(spec, [...common, 'weights', 'scenarios'], 'spec');
  const weights = validateWeights(spec.weights, 'spec.weights');
  if (!Array.isArray(spec.scenarios)) fail('invalid_harness_config', 'spec.scenarios must be an array');
  const names = new Set();
  const scenarios = spec.scenarios.map((raw, index) => {
    const label = `spec.scenarios[${index}]`;
    object(raw, label);
    onlyKeys(raw, ['name', 'category', 'description', 'command', 'expected_exit', 'expected_output'], label);
    const name = string(raw.name, `${label}.name`);
    if (names.has(name)) fail('invalid_harness_config', `duplicate scenario name ${name}`);
    names.add(name);
    const category = string(raw.category, `${label}.category`);
    if (!Object.hasOwn(weights, category)) fail('invalid_harness_config', `${label}.category has no weight`);
    return {
      name,
      category,
      description: raw.description === undefined ? '' : string(raw.description, `${label}.description`, { empty: true }),
      command: validateCommand(raw.command, projectRoot, `${label}.command`),
      expected_exit: raw.expected_exit === undefined ? 0 : integer(raw.expected_exit, `${label}.expected_exit`, -255, 255),
      expected_output: raw.expected_output === undefined ? '' : string(raw.expected_output, `${label}.expected_output`, { empty: true }),
    };
  });
  return {
    schema_version: '1.0', kind,
    ...(description === undefined ? {} : { description }),
    weights,
    scenarios,
  };
}

function pluginRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function writeGenerated(config, sessionRoot) {
  const templatePath = path.join(pluginRoot(), 'templates', TEMPLATE_NAMES[config.kind]);
  let template;
  try { template = fs.readFileSync(templatePath); }
  catch { fail('harness_template_missing', `native harness template is missing: ${templatePath}`); }
  atomicWriteFile(path.join(sessionRoot, HARNESS_NAME), template, { mode: 0o600 });
  atomicWriteFile(path.join(sessionRoot, CONFIG_NAME), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return {
    kind: config.kind,
    harness_path: path.join(sessionRoot, HARNESS_NAME),
    config_path: path.join(sessionRoot, CONFIG_NAME),
  };
}

function generateHarness(spec, sessionRoot) {
  const context = projectForSession(sessionRoot);
  const config = validateSpec(spec, context.projectRoot);
  return writeGenerated(config, context.sessionRoot);
}

function readConfig(context) {
  const configPath = path.join(context.sessionRoot, CONFIG_NAME);
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); }
  catch { fail('harness_config_missing', `harness config is missing: ${configPath}`); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { fail('invalid_harness_config', 'prepare.config.json is not valid JSON'); }
  if (!plainObject(parsed) || parsed.schema_version !== '1.0') {
    fail('invalid_harness_config', 'prepare.config.json schema_version must be 1.0');
  }
  const { schema_version: _schema, ...spec } = parsed;
  return validateSpec(spec, context.projectRoot);
}

function spawnCommand(command, runner = spawnSync) {
  const result = runner(command.file, command.args, {
    cwd: command.cwd,
    encoding: 'utf8',
    timeout: command.timeout_ms,
    shell: false,
  });
  return {
    exit_code: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal || null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    ...(result.error ? { error_code: result.error.code || 'spawn_failed' } : {}),
  };
}

function runHarness(sessionRoot, options = {}) {
  const context = projectForSession(sessionRoot);
  object(options, 'options');
  onlyKeys(options, ['args'], 'options');
  const args = options.args === undefined ? [] : options.args;
  if (!Array.isArray(args)) fail('invalid_harness_options', 'options.args must be an array');
  const safeArgs = args.map((item, index) => string(item, `options.args[${index}]`, { empty: true }));
  const harnessPath = path.join(context.sessionRoot, HARNESS_NAME);
  let resolvedHarness;
  try { resolvedHarness = fs.realpathSync(harnessPath); }
  catch { fail('harness_missing', `native harness is missing: ${harnessPath}`); }
  if (!isPathInside(context.sessionRoot, resolvedHarness) || path.basename(resolvedHarness) !== HARNESS_NAME) {
    fail('harness_path_escape', 'prepare.cjs must be a regular file inside the session');
  }
  if (!fs.statSync(resolvedHarness).isFile()) fail('harness_missing', 'prepare.cjs must be a file');
  readConfig(context);
  const command = {
    file: process.execPath,
    args: [resolvedHarness, ...safeArgs],
    cwd: context.projectRoot,
    timeout_ms: 3_600_000,
  };
  return spawnCommand(command);
}

function writeBaseline(sessionRoot, rawScore) {
  const context = projectForSession(sessionRoot);
  const score = finite(rawScore, 'rawScore');
  const config = readConfig(context);
  if (config.kind !== 'stdout-parser') fail('baseline_not_supported', 'baseline writeback is only valid for stdout-parser');
  config.baseline_score = score;
  atomicWriteFile(path.join(context.sessionRoot, CONFIG_NAME), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { baseline_score: score, config_path: path.join(context.sessionRoot, CONFIG_NAME) };
}

function engineSignature(source) {
  const normalized = source.replace(/\r\n/g, '\n');
  const marker = normalized.indexOf(ENGINE_MARKER);
  if (marker < 0) return null;
  return crypto.createHash('sha256').update(normalized.slice(marker)).digest('hex');
}

class PythonLiteralParser {
  constructor(source, position = 0) {
    this.source = source;
    this.position = position;
  }

  skip() {
    for (;;) {
      while (/\s/.test(this.source[this.position] || '')) this.position += 1;
      if (this.source[this.position] !== '#') return;
      while (this.position < this.source.length && this.source[this.position] !== '\n') this.position += 1;
    }
  }

  parse() {
    this.skip();
    const value = this.value();
    this.skip();
    return value;
  }

  value() {
    this.skip();
    const char = this.source[this.position];
    if (char === '{') return this.dictionary();
    if (char === '[') return this.sequence('[', ']');
    if (char === '(') return this.sequence('(', ')');
    if (char === '"' || char === "'" || /[rRuUbB]/.test(char || '')
        && (this.source[this.position + 1] === '"' || this.source[this.position + 1] === "'")) {
      return this.string();
    }
    const number = this.source.slice(this.position).match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (number) {
      this.position += number[0].length;
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw new Error('non-finite literal');
      return value;
    }
    const identifier = this.source.slice(this.position).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identifier) {
      this.position += identifier[0].length;
      if (identifier[0] === 'None') return null;
      if (identifier[0] === 'True') return true;
      if (identifier[0] === 'False') return false;
    }
    throw new Error(`unsupported Python literal at offset ${this.position}`);
  }

  string() {
    let raw = false;
    if (/[rRuUbB]/.test(this.source[this.position])
        && (this.source[this.position + 1] === '"' || this.source[this.position + 1] === "'")) {
      raw = /[rR]/.test(this.source[this.position]);
      this.position += 1;
    }
    const quote = this.source[this.position];
    this.position += 1;
    const triple = this.source.slice(this.position, this.position + 2) === quote.repeat(2);
    if (triple) this.position += 2;
    let output = '';
    for (;;) {
      if (this.position >= this.source.length) throw new Error('unterminated string literal');
      if (triple ? this.source.slice(this.position, this.position + 3) === quote.repeat(3)
        : this.source[this.position] === quote) {
        this.position += triple ? 3 : 1;
        return output;
      }
      const char = this.source[this.position];
      this.position += 1;
      if (raw && char === '\\') {
        if (this.source[this.position] === quote) {
          output += `\\${quote}`;
          this.position += 1;
        } else output += char;
        continue;
      }
      if (char !== '\\') {
        output += char;
        continue;
      }
      if (this.position >= this.source.length) throw new Error('unterminated escape');
      const escaped = this.source[this.position];
      this.position += 1;
      const basic = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"' };
      if (Object.hasOwn(basic, escaped)) output += basic[escaped];
      else if (escaped === 'x' && /^[0-9a-fA-F]{2}/.test(this.source.slice(this.position, this.position + 2))) {
        output += String.fromCodePoint(parseInt(this.source.slice(this.position, this.position + 2), 16));
        this.position += 2;
      } else if (escaped === 'u' && /^[0-9a-fA-F]{4}/.test(this.source.slice(this.position, this.position + 4))) {
        output += String.fromCodePoint(parseInt(this.source.slice(this.position, this.position + 4), 16));
        this.position += 4;
      } else output += `\\${escaped}`;
    }
  }

  sequence(open, close) {
    if (this.source[this.position] !== open) throw new Error('sequence expected');
    this.position += 1;
    const result = [];
    this.skip();
    while (this.source[this.position] !== close) {
      result.push(this.value());
      this.skip();
      if (this.source[this.position] === ',') {
        this.position += 1;
        this.skip();
        continue;
      }
      if (this.source[this.position] !== close) throw new Error('sequence comma expected');
    }
    this.position += 1;
    return result;
  }

  dictionary() {
    this.position += 1;
    const result = {};
    this.skip();
    while (this.source[this.position] !== '}') {
      const key = this.value();
      if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error('dictionary key must be a safe string');
      }
      this.skip();
      if (this.source[this.position] !== ':') throw new Error('dictionary colon expected');
      this.position += 1;
      result[key] = this.value();
      this.skip();
      if (this.source[this.position] === ',') {
        this.position += 1;
        this.skip();
        continue;
      }
      if (this.source[this.position] !== '}') throw new Error('dictionary comma expected');
    }
    this.position += 1;
    return result;
  }
}

function assignment(source, name) {
  const match = new RegExp(`^${name}\\s*=\\s*`, 'm').exec(source);
  if (!match) throw new Error(`missing ${name}`);
  return new PythonLiteralParser(source, match.index + match[0].length).parse();
}

function safeLegacyCommand(raw, timeoutSeconds, projectRoot, label) {
  if (typeof raw !== 'string') throw new Error(`${label} is not a string`);
  if (/^\{\{[A-Z0-9_]+\}\}$/.test(raw)) {
    return { file: process.execPath, args: ['-e', ''], timeout_ms: 60_000 };
  }
  if (/[\n\r]/.test(raw)) throw new Error(`${label} requires shell semantics`);
  const tokens = [];
  let token = '';
  let quote = null;
  let active = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote) {
      if (char === quote) { quote = null; active = true; continue; }
      if (char === '\\' && raw[index + 1] === quote) { token += quote; index += 1; continue; }
      token += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; active = true; continue; }
    if (/[;&|<>$`*?\[\]{}~%^!()]/.test(char)) throw new Error(`${label} requires shell semantics`);
    if (/\s/.test(char)) {
      if (active || token) { tokens.push(token); token = ''; active = false; }
      continue;
    }
    if (char === '\\' && /[\s"'\\]/.test(raw[index + 1] || '')) { token += raw[index + 1]; index += 1; active = true; continue; }
    token += char;
    active = true;
  }
  if (quote) throw new Error(`${label} has an unterminated quote`);
  if (active || token) tokens.push(token);
  if (tokens.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) throw new Error(`${label} is not a direct command`);
  const seconds = Number(timeoutSeconds);
  const timeout = Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.round(seconds * 1_000), 3_600_000) : 60_000;
  return validateCommand({ file: tokens[0], args: tokens.slice(1), timeout_ms: timeout }, projectRoot, label);
}

function placeholder(source, name) {
  return source.includes(`{{${name}}}`);
}

function legacyStdoutSpec(source, projectRoot) {
  if (placeholder(source, 'RAW_COMMAND') || placeholder(source, 'METRICS_DICT')) {
    return {
      kind: 'stdout-parser', command: safeLegacyCommand('{{RAW_COMMAND}}', 60, projectRoot, 'RAW_COMMAND'),
      metric_direction: 'maximize', baseline_score: null, metrics: {},
    };
  }
  const timeout = assignment(source, 'TIMEOUT');
  return {
    kind: 'stdout-parser',
    command: safeLegacyCommand(assignment(source, 'RAW_COMMAND'), timeout, projectRoot, 'RAW_COMMAND'),
    metric_direction: assignment(source, 'METRIC_DIRECTION'),
    baseline_score: assignment(source, 'BASELINE_SCORE'),
    metrics: assignment(source, 'METRICS'),
  };
}

function optionalLegacyCommand(raw, timeout, projectRoot, label) {
  if (raw === null || raw === 'null' || /^\{\{/.test(raw)) return null;
  return safeLegacyCommand(raw, timeout, projectRoot, label);
}

function legacyTestRunnerSpec(source, projectRoot) {
  if (placeholder(source, 'TEST_COMMAND') || placeholder(source, 'TEST_WEIGHT')) {
    return {
      kind: 'test-runner',
      test_command: safeLegacyCommand('{{TEST_COMMAND}}', 60, projectRoot, 'TEST_COMMAND'),
      coverage_command: null, lint_command: null,
      weights: { test_pass_rate: 1, coverage: 0, lint: 0 },
    };
  }
  const timeout = assignment(source, 'TIMEOUT');
  return {
    kind: 'test-runner',
    test_command: safeLegacyCommand(assignment(source, 'TEST_COMMAND'), timeout, projectRoot, 'TEST_COMMAND'),
    coverage_command: optionalLegacyCommand(assignment(source, 'COVERAGE_COMMAND'), timeout, projectRoot, 'COVERAGE_COMMAND'),
    lint_command: optionalLegacyCommand(assignment(source, 'LINT_COMMAND'), timeout, projectRoot, 'LINT_COMMAND'),
    weights: assignment(source, 'WEIGHTS'),
  };
}

function balancedCall(source, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return { body: source.slice(start + 1, index), end: index + 1 };
    }
  }
  throw new Error('unterminated call');
}

function keywordArguments(body) {
  const result = {};
  const parser = new PythonLiteralParser(body);
  for (;;) {
    parser.skip();
    if (parser.position >= body.length) return result;
    const name = body.slice(parser.position).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!name) throw new Error('keyword name expected');
    parser.position += name[0].length;
    parser.skip();
    if (body[parser.position] !== '=') throw new Error('keyword assignment expected');
    parser.position += 1;
    result[name[0]] = parser.value();
    parser.skip();
    if (body[parser.position] === ',') { parser.position += 1; continue; }
    if (parser.position < body.length) throw new Error('keyword comma expected');
  }
}

function calls(source, constructor) {
  const result = [];
  const needle = `${constructor}(`;
  let offset = 0;
  for (;;) {
    const index = source.indexOf(needle, offset);
    if (index < 0) return result;
    const lineStart = source.lastIndexOf('\n', index) + 1;
    if (source.slice(lineStart, index).trimStart().startsWith('#')) { offset = index + needle.length; continue; }
    const call = balancedCall(source, index + constructor.length);
    result.push(keywordArguments(call.body));
    offset = call.end;
  }
}

function legacyScenarioSpec(source, projectRoot) {
  if (placeholder(source, 'WEIGHTS_DICT')) return { kind: 'scenario', weights: {}, scenarios: [] };
  const weights = assignment(source, 'WEIGHTS');
  const scenarios = calls(source.slice(0, source.indexOf(ENGINE_MARKER)), 'Scenario').map((row, index) => ({
    name: row.name,
    category: row.category,
    description: row.description || '',
    command: safeLegacyCommand(row.test_command, 10, projectRoot, `SCENARIOS[${index}].test_command`),
    expected_exit: row.expected_exit === undefined ? 0 : row.expected_exit,
    expected_output: row.expected_output || '',
  }));
  const nodeTests = calls(source.slice(0, source.indexOf(ENGINE_MARKER)), 'NodeTest').map((row, index) => ({
    name: row.name,
    category: row.category,
    description: row.description || '',
    command: validateCommand({
      file: process.execPath, args: ['-e', row.js_expression], cwd: projectRoot, timeout_ms: 10_000,
    }, projectRoot, `NODE_TESTS[${index}]`),
    expected_exit: 0,
    expected_output: '',
  }));
  return { kind: 'scenario', weights, scenarios: [...scenarios, ...nodeTests] };
}

function migrateLegacyHarness(sessionRoot) {
  const context = projectForSession(sessionRoot);
  const legacyPath = path.join(context.sessionRoot, LEGACY_NAME);
  let source;
  try { source = fs.readFileSync(legacyPath, 'utf8'); }
  catch { regenerate(`legacy harness is missing: ${legacyPath}`); }
  const signature = engineSignature(source);
  const kind = signature && LEGACY_ENGINES[signature];
  if (!kind) regenerate('legacy harness engine is altered or unrecognized', { engine_sha256: signature });
  let spec;
  try {
    if (kind === 'stdout-parser') spec = legacyStdoutSpec(source, context.projectRoot);
    else if (kind === 'test-runner') spec = legacyTestRunnerSpec(source, context.projectRoot);
    else spec = legacyScenarioSpec(source, context.projectRoot);
    validateSpec(spec, context.projectRoot);
  } catch (error) {
    if (error instanceof HarnessError && error.code === 'legacy_harness_requires_regeneration') throw error;
    regenerate('legacy harness configuration requires host-neutral regeneration', {
      kind,
      reason: error && error.message ? error.message : 'literal_parse_failed',
    });
  }
  const generated = generateHarness(spec, context.sessionRoot);
  return { migrated: true, kind, engine_sha256: signature, ...generated };
}

module.exports = {
  HarnessError,
  generateHarness,
  migrateLegacyHarness,
  runHarness,
  writeBaseline,
};
