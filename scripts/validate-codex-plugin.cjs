#!/usr/bin/env node
'use strict';

// Maintainer-only advisory validation. This file is deliberately excluded from
// the published package and is never part of plugin runtime acceptance.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pluginRoot = path.resolve(__dirname, '..');
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));

function existingFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function walkForValidator(root, depth = 0) {
  if (depth > 7) return [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && entry.name === 'validate_plugin.py'
      && path.basename(path.dirname(candidate)) === 'scripts') {
      found.push(candidate);
    } else if (entry.isDirectory()) {
      found.push(...walkForValidator(candidate, depth + 1));
    }
  }
  return found;
}

function validators() {
  const preferred = path.join(
    codexHome, 'skills', '.system', 'plugin-creator', 'scripts', 'validate_plugin.py',
  );
  const cacheRoot = path.join(codexHome, 'plugins', 'cache', 'openai-bundled', 'plugin-creator');
  return [...new Set([
    ...(existingFile(preferred) ? [preferred] : []),
    ...walkForValidator(cacheRoot).sort().reverse(),
  ])];
}

function invoke(command, args) {
  return spawnSync(command, args, {
    cwd: pluginRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
}

function redactMaintainerPaths(source) {
  let output = String(source || '');
  const replacements = [
    [pluginRoot, '<PLUGIN_ROOT>'],
    [codexHome, '<CODEX_HOME>'],
    [path.resolve(os.homedir()), '<HOME>'],
  ].sort(([left], [right]) => right.length - left.length);
  for (const [sensitive, replacement] of replacements) {
    for (const spelling of new Set([sensitive, sensitive.replace(/\\/g, '/')])) {
      output = output.split(spelling).join(replacement);
    }
  }
  return output;
}

function relay(result) {
  if (result.stdout) process.stdout.write(redactMaintainerPaths(result.stdout));
  if (result.stderr) process.stderr.write(redactMaintainerPaths(result.stderr));
  if (result.error) {
    process.stderr.write(`${redactMaintainerPaths(result.error.message)}\n`);
    return 2;
  }
  if (result.signal) {
    process.stderr.write(`validator terminated by signal ${result.signal}\n`);
    return 2;
  }
  return Number.isInteger(result.status) ? result.status : 2;
}

function main() {
  const [validator] = validators();
  if (!validator) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: 'validator_not_installed',
      maintainer_only: true,
    })}\n`);
    return 0;
  }

  if (process.platform !== 'win32') {
    return relay(invoke('python3', [validator, pluginRoot]));
  }

  const launcher = invoke('py', ['-3', validator, pluginRoot]);
  if (!launcher.error || launcher.error.code !== 'ENOENT') return relay(launcher);
  process.stderr.write('py -3 is unavailable; falling back to python for maintainer validation\n');
  return relay(invoke('python', [validator, pluginRoot]));
}

process.exitCode = main();
