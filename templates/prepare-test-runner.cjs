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
  if (!plainObject(value) || value.schema_version !== '1.0' || value.kind !== 'test-runner') throw new Error('invalid test-runner config');
  if (Object.keys(value).some((key) => !['schema_version', 'kind', 'description', 'test_command', 'coverage_command', 'lint_command', 'weights'].includes(key))) throw new Error('unknown config field');
  if (!plainObject(value.weights) || Object.keys(value.weights).some((name) => !['test_pass_rate', 'coverage', 'lint'].includes(name))) throw new Error('invalid weights');
  const weights = {};
  for (const name of ['test_pass_rate', 'coverage', 'lint']) {
    const weight = value.weights[name] === undefined ? 0 : value.weights[name];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) throw new Error('invalid weight');
    weights[name] = weight;
  }
  return {
    ...value,
    weights,
    test_command: command(value.test_command, root),
    coverage_command: value.coverage_command === null ? null : command(value.coverage_command, root),
    lint_command: value.lint_command === null ? null : command(value.lint_command, root),
  };
}

function invoke(value) {
  return spawnSync(value.file, value.args, {
    cwd: value.cwd,
    encoding: 'utf8',
    timeout: value.timeout_ms,
    shell: false,
  });
}

function combined(result) {
  return `${typeof result.stdout === 'string' ? result.stdout : ''}${typeof result.stderr === 'string' ? result.stderr : ''}`;
}

function parseTests(output) {
  let match = /Tests:\s+(\d+)\s+passed,\s+(\d+)\s+total/.exec(output);
  if (match) return [Number(match[1]), Number(match[2])];
  match = /Tests\s+(\d+)\s+passed\s*\((\d+)\)/.exec(output);
  if (match) return [Number(match[1]), Number(match[2])];
  match = /Tests\s+(\d+)\s+passed\s*\|\s*(\d+)\s+failed/.exec(output);
  if (match) return [Number(match[1]), Number(match[1]) + Number(match[2])];
  match = /test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/i.exec(output);
  if (match) return [Number(match[1]), Number(match[1]) + Number(match[2])];
  const goPassed = (output.match(/^--- PASS:/gm) || []).length;
  const goFailed = (output.match(/^--- FAIL:/gm) || []).length;
  if (goPassed || goFailed) return [goPassed, goPassed + goFailed];
  const passed = [...output.matchAll(/(\d+)\s+passed/gi)].reduce((sum, item) => sum + Number(item[1]), 0);
  const failed = [...output.matchAll(/(\d+)\s+failed/gi)].reduce((sum, item) => sum + Number(item[1]), 0);
  const errors = [...output.matchAll(/(\d+)\s+error(?:s)?\b/gi)].reduce((sum, item) => sum + Number(item[1]), 0);
  return passed || failed || errors ? [passed, passed + failed + errors] : [0, 0];
}

function parseCoverage(output) {
  const summary = /(?:TOTAL|Total|All files).*?(\d+(?:\.\d+)?)\s*%/.exec(output);
  if (summary) return Number(summary[1]) / 100;
  const matches = [...output.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) / 100 : null;
}

function parseLint(output) {
  const errors = [...output.matchAll(/(\d+)\s+error(?:s)?\b/gi)].map((item) => Number(item[1]));
  const warnings = [...output.matchAll(/(\d+)\s+warning(?:s)?\b/gi)].map((item) => Number(item[1]));
  if (errors.length || warnings.length) return [errors.length ? Math.max(...errors) : 0, warnings.length ? Math.max(...warnings) : 0];
  return [
    (output.match(/^error(?:\[[^\]]*\])?[:\-\s]/gim) || []).length,
    (output.match(/^warning(?:\[[^\]]*\])?[:\-\s]/gim) || []).length,
  ];
}

function main() {
  const root = fs.realpathSync(projectRoot());
  const config = loadConfig(root);
  const [passed, total] = parseTests(combined(invoke(config.test_command)));
  const testRate = total > 0 ? passed / total : 0;
  const coverage = config.coverage_command ? parseCoverage(combined(invoke(config.coverage_command))) : null;
  const lint = config.lint_command ? parseLint(combined(invoke(config.lint_command))) : null;
  const lintScore = lint ? Math.max(0, 1 - (lint[0] * 0.1 + lint[1] * 0.02)) : null;
  const active = [[testRate, config.weights.test_pass_rate]];
  if (coverage !== null) active.push([coverage, config.weights.coverage]);
  if (lintScore !== null) active.push([lintScore, config.weights.lint]);
  const totalWeight = active.reduce((sum, row) => sum + (row[1] > 0 ? row[1] : 0), 0);
  const score = totalWeight > 0
    ? active.reduce((sum, row) => sum + (row[1] > 0 ? row[0] * row[1] / totalWeight : 0), 0)
    : 0;
  const lines = ['', '---', `score:              ${score.toFixed(6)}`, `test_pass_rate:     ${testRate.toFixed(6)}`];
  if (coverage !== null) lines.push(`coverage:           ${coverage.toFixed(6)}`);
  if (lintScore !== null) lines.push(`lint_score:         ${lintScore.toFixed(6)}`);
  lines.push(`total_scenarios:    ${total}`, `passed_scenarios:   ${passed}`, `failed_scenarios:   ${total - passed}`, '---', '');
  process.stdout.write(lines.join('\n'));
}

try { main(); }
catch (error) {
  process.stderr.write(`[prepare] ${error && error.message ? error.message : 'evaluation failed'}\n`);
  process.exitCode = 1;
}
