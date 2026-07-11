'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  resolvePluginRoot,
  findProjectRoot,
  normalizeForComparison,
  isPathInside,
} = require('../hooks/scripts/runtime/runtime-paths.cjs');

test('Windows paths compare case-insensitively without collapsing UNC roots', () => {
  assert.equal(normalizeForComparison('C:\\Work Space\\Repo\\.deep-evolve', 'win32'), 'c:/work space/repo/.deep-evolve');
  assert.equal(isPathInside('\\\\server\\share\\repo', '\\\\server\\share\\repo\\.deep-evolve\\s', 'win32'), true);
  assert.equal(isPathInside('C:\\repo', 'D:\\repo\\file', 'win32'), false);
  assert.equal(isPathInside('C:\\repo', 'C:\\repo2\\session.yaml', 'win32'), false);
  assert.equal(isPathInside('C:\\repo', 'C:\\repo\\..\\repo2\\session.yaml', 'win32'), false);
  assert.equal(isPathInside('\\\\server\\share', '\\\\server\\share2\\repo', 'win32'), false);
  assert.equal(isPathInside('\\\\server\\share\\repo', '\\\\server\\share\\repo2', 'win32'), false);
  assert.equal(isPathInside('C:\\', 'C:\\repo\\.deep-evolve', 'win32'), true);
  assert.equal(isPathInside('C:\\', 'D:\\repo\\.deep-evolve', 'win32'), false);
  assert.equal(normalizeForComparison('/Repo/CASE', 'posix'), '/Repo/CASE');
  assert.equal(isPathInside('/repo/A', '/repo/a/x', 'posix'), false);
});

test('path containment accepts equality and rejects lexical prefix traps', () => {
  assert.equal(isPathInside('/repo', '/repo', 'posix'), true);
  assert.equal(isPathInside('/repo', '/repo/sub/file', 'posix'), true);
  assert.equal(isPathInside('/repo', '/repository/file', 'posix'), false);
  assert.equal(isPathInside('/repo', '/repo/../outside', 'posix'), false);
});

test('project-root walking terminates at POSIX, drive, and UNC roots', () => {
  const absent = () => false;
  assert.equal(findProjectRoot('/', { platform: 'posix', exists: absent }), null);
  assert.equal(findProjectRoot('C:\\', { platform: 'win32', exists: absent }), null);
  assert.equal(findProjectRoot('\\\\server\\share', { platform: 'win32', exists: absent }), null);
});

test('project-root walking finds the nearest state or git marker without crossing roots', () => {
  const seen = [];
  const exists = (candidate) => {
    seen.push(candidate);
    return normalizeForComparison(candidate, 'win32') === 'c:/work space/repo/.deep-evolve';
  };
  assert.equal(
    normalizeForComparison(findProjectRoot('C:\\Work Space\\Repo\\src\\nested', { platform: 'win32', exists }), 'win32'),
    'c:/work space/repo',
  );
  assert.ok(seen.length < 20, 'root walk must terminate');
});

test('plugin root resolves explicit host roots before the runtime script fallback', () => {
  const scriptPath = path.join('/Plugin With Spaces', 'hooks', 'scripts', 'runtime', 'runtime-paths.cjs');
  assert.equal(resolvePluginRoot({ scriptPath, env: { PLUGIN_ROOT: '/Explicit Plugin' } }), path.resolve('/Explicit Plugin'));
  assert.equal(resolvePluginRoot({ scriptPath, env: { CLAUDE_PLUGIN_ROOT: '/Claude Plugin' } }), path.resolve('/Claude Plugin'));
  assert.equal(resolvePluginRoot({ scriptPath, env: {} }), path.resolve('/Plugin With Spaces'));
});
