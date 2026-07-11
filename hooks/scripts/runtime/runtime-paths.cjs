'use strict';
const fs = require('node:fs');
const path = require('node:path');

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function resolvePluginRoot({ scriptPath = __filename, env = process.env } = {}) {
  const explicit = env && (env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT);
  if (explicit) return path.resolve(explicit);
  return path.resolve(path.dirname(scriptPath), '..', '..', '..');
}

function normalizeForComparison(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('path value must be a non-empty string');
  }
  const api = pathApi(platform);
  let normalized = api.resolve(value);
  if (platform === 'win32') normalized = normalized.toLowerCase().replace(/\\/g, '/');
  return normalized;
}

function isPathInside(parent, candidate, platform = process.platform) {
  const api = pathApi(platform);
  let base = api.resolve(parent);
  let child = api.resolve(candidate);
  if (platform === 'win32') {
    base = base.toLowerCase();
    child = child.toLowerCase();
  }
  const relative = api.relative(base, child);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${api.sep}`)
    && !api.isAbsolute(relative)
  );
}

function findProjectRoot(startPath, {
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  if (typeof startPath !== 'string' || startPath.length === 0) return null;
  const api = pathApi(platform);
  let current = api.resolve(startPath);
  for (;;) {
    if (exists(api.join(current, '.deep-evolve')) || exists(api.join(current, '.git'))) {
      return current;
    }
    const parent = api.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

module.exports = {
  resolvePluginRoot,
  findProjectRoot,
  normalizeForComparison,
  isPathInside,
};
