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
  if (!plainObject(value) || value.schema_version !== '1.0' || value.kind !== 'stdout-parser') throw new Error('invalid stdout-parser config');
  if (Object.keys(value).some((key) => !['schema_version', 'kind', 'description', 'command', 'metric_direction', 'baseline_score', 'metrics'].includes(key))) throw new Error('unknown config field');
  if (value.metric_direction !== 'maximize' && value.metric_direction !== 'minimize') throw new Error('invalid metric direction');
  if (value.baseline_score !== null && (typeof value.baseline_score !== 'number' || !Number.isFinite(value.baseline_score))) throw new Error('invalid baseline');
  if (!plainObject(value.metrics)) throw new Error('invalid metrics');
  const metrics = {};
  for (const [name, metric] of Object.entries(value.metrics)) {
    if (name === '__proto__' || name === 'prototype' || name === 'constructor') throw new Error('unsafe metric name');
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || !plainObject(metric)) throw new Error('invalid metric');
    if (Object.keys(metric).some((key) => !['pattern', 'weight'].includes(key))) throw new Error('unknown metric field');
    if (typeof metric.pattern !== 'string' || typeof metric.weight !== 'number' || !Number.isFinite(metric.weight) || metric.weight < 0) throw new Error('invalid metric field');
    metrics[name] = { pattern: new RegExp(metric.pattern, 'm'), weight: metric.weight };
  }
  return { ...value, command: command(value.command, root), metrics };
}

function invoke(value) {
  return spawnSync(value.file, value.args, {
    cwd: value.cwd,
    encoding: 'utf8',
    timeout: value.timeout_ms,
    shell: false,
  });
}

function render(config, stdout) {
  const values = {};
  for (const [name, metric] of Object.entries(config.metrics)) {
    const match = metric.pattern.exec(stdout);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) values[name] = parsed;
    }
  }
  const totalWeight = Object.values(config.metrics).reduce((sum, metric) => sum + (metric.weight > 0 ? metric.weight : 0), 0);
  let score = 0;
  if (totalWeight > 0) {
    for (const [name, metric] of Object.entries(config.metrics)) {
      if (Object.hasOwn(values, name) && metric.weight > 0) score += (metric.weight / totalWeight) * values[name];
    }
  }
  const missing = Object.keys(values).length !== Object.keys(config.metrics).length;
  if (config.metric_direction === 'minimize') {
    if (missing) score = 0;
    else if (score <= 0) score = config.baseline_score === null ? 1 : 2;
    else if (config.baseline_score !== null && config.baseline_score > 0) score = config.baseline_score / score;
  }
  const lines = ['', '---', `score:              ${score.toFixed(6)}`];
  for (const [name, value] of Object.entries(values)) lines.push(`${name}:${' '.repeat(Math.max(0, 20 - name.length))}${value.toFixed(6)}`);
  const total = Object.keys(config.metrics).length;
  const passed = Object.keys(values).length;
  lines.push(`total_scenarios:    ${total}`, `passed_scenarios:   ${passed}`, `failed_scenarios:   ${total - passed}`, '---', '');
  return lines.join('\n');
}

function main() {
  const root = fs.realpathSync(projectRoot());
  const config = loadConfig(root);
  const result = invoke(config.command);
  process.stdout.write(render(config, typeof result.stdout === 'string' ? result.stdout : ''));
  if (process.argv.includes('--verbose') && result.error) process.stderr.write(`[prepare] ${result.error.code || result.error.message}\n`);
}

try { main(); }
catch (error) {
  process.stderr.write(`[prepare] ${error && error.message ? error.message : 'evaluation failed'}\n`);
  process.exitCode = 1;
}
