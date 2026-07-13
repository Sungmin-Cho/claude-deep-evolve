#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function projectRoot() {
  let current = path.dirname(fs.realpathSync(__filename));
  for (;;) {
    if (path.basename(current) === '.deep-evolve') return path.dirname(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`.deep-evolve not found above ${__filename}`);
    current = parent;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function command(value, root) {
  if (!plainObject(value)) throw new Error('command must be an object');
  if (Object.keys(value).some((key) => !['file', 'args', 'cwd', 'timeout_ms'].includes(key))) throw new Error('unknown command field');
  if (typeof value.file !== 'string' || !value.file || value.file.includes('\0')) throw new Error('invalid command.file');
  const executable = path.win32.basename(value.file).replace(/\.exe$/i, '');
  if (/^(?:python(?:3(?:\.\d+)?)?|py|bash|sh|zsh|fish|cmd|powershell|pwsh)$/i.test(executable)) throw new Error('unsupported executable');
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('invalid command.args');
  if (!Number.isInteger(value.timeout_ms) || value.timeout_ms < 1 || value.timeout_ms > 3_600_000) throw new Error('invalid command.timeout_ms');
  const cwd = value.cwd === undefined
    ? root
    : (path.isAbsolute(value.cwd) ? path.resolve(value.cwd) : path.resolve(root, value.cwd));
  const resolved = fs.realpathSync(cwd);
  if (!inside(root, resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('command.cwd escapes project root');
  return { file: value.file, args: [...value.args], cwd: resolved, timeout_ms: value.timeout_ms };
}

function loadConfig(root) {
  const value = JSON.parse(fs.readFileSync(path.join(__dirname, 'prepare.config.json'), 'utf8'));
  if (!plainObject(value) || value.schema_version !== '1.0' || value.kind !== 'scenario') throw new Error('invalid scenario config');
  if (Object.keys(value).some((key) => !['schema_version', 'kind', 'description', 'weights', 'scenarios'].includes(key))) throw new Error('unknown config field');
  if (!plainObject(value.weights) || !Array.isArray(value.scenarios)) throw new Error('invalid scenario fields');
  const weights = {};
  for (const [name, weight] of Object.entries(value.weights)) {
    if (name === '__proto__' || name === 'prototype' || name === 'constructor') throw new Error('unsafe scenario weight');
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) throw new Error('invalid scenario weight');
    weights[name] = weight;
  }
  const names = new Set();
  const scenarios = value.scenarios.map((scenario) => {
    if (!plainObject(scenario) || Object.keys(scenario).some((key) => !['name', 'category', 'description', 'command', 'expected_exit', 'expected_output'].includes(key))) throw new Error('invalid scenario');
    if (typeof scenario.name !== 'string' || !scenario.name || names.has(scenario.name)) throw new Error('invalid scenario name');
    names.add(scenario.name);
    if (typeof scenario.category !== 'string' || !Object.hasOwn(weights, scenario.category)) throw new Error('invalid scenario category');
    if (typeof scenario.description !== 'string' || !Number.isInteger(scenario.expected_exit) || typeof scenario.expected_output !== 'string') throw new Error('invalid scenario expectation');
    return { ...scenario, command: command(scenario.command, root) };
  });
  return { weights, scenarios };
}

function invoke(value) {
  return spawnSync(value.file, value.args, {
    cwd: value.cwd,
    encoding: 'utf8',
    timeout: value.timeout_ms,
    shell: false,
  });
}

function main() {
  const root = fs.realpathSync(projectRoot());
  const config = loadConfig(root);
  const categories = Object.fromEntries(Object.keys(config.weights).map((name) => [name, { passed: 0, total: 0 }]));
  let passed = 0;
  for (const scenario of config.scenarios) {
    const result = invoke(scenario.command);
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const ok = result.status === scenario.expected_exit
      && (!scenario.expected_output || stdout.includes(scenario.expected_output));
    categories[scenario.category].total += 1;
    if (ok) { categories[scenario.category].passed += 1; passed += 1; }
  }
  const weightSum = Object.values(config.weights).reduce((sum, weight) => sum + weight, 0);
  let score = 0;
  for (const [name, weight] of Object.entries(config.weights)) {
    const data = categories[name];
    const categoryScore = data.total > 0 ? data.passed / data.total : 0;
    if (weightSum > 0) score += (weight / weightSum) * categoryScore;
  }
  const lines = ['', '---', `score:              ${score.toFixed(6)}`];
  for (const name of Object.keys(config.weights)) {
    const data = categories[name];
    const value = data.total > 0 ? data.passed / data.total : 0;
    lines.push(`${name}:${' '.repeat(Math.max(0, 20 - name.length))}${value.toFixed(6)}`);
  }
  const total = config.scenarios.length;
  lines.push(`total_scenarios:    ${total}`, `passed_scenarios:   ${passed}`, `failed_scenarios:   ${total - passed}`, '---', '');
  process.stdout.write(lines.join('\n'));
}

try { main(); }
catch (error) {
  process.stderr.write(`[prepare] ${error && error.message ? error.message : 'evaluation failed'}\n`);
  process.exitCode = 1;
}
