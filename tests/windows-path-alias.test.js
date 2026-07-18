'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  relativeHookPath,
  sameHookPath,
} = require('../hooks/scripts/protect-readonly.cjs');

test('Windows hook path comparison resolves short-name aliases and missing leaves', () => {
  const originalRealpath = fs.realpathSync.native;
  const shortRoot = String.raw`C:\Users\RUNNER~1\project`;
  const longRoot = String.raw`C:\Users\runneradmin\project`;
  const existingShort = path.win32.join(shortRoot, '.deep-evolve', 'session-current', 'prepare.cjs');
  const existingLong = path.win32.join(longRoot, '.deep-evolve', 'session-current', 'prepare.cjs');
  const parentShort = path.win32.dirname(existingShort);
  const parentLong = path.win32.dirname(existingLong);

  fs.realpathSync.native = (candidate) => {
    const normalized = path.win32.normalize(candidate);
    const basename = path.win32.basename(normalized).toLowerCase();
    if (basename === 'program.md' || basename === 'strategy.yaml') {
      const error = new Error(`ENOENT: ${candidate}`);
      error.code = 'ENOENT';
      throw error;
    }
    if (normalized.toLowerCase().startsWith(shortRoot.toLowerCase())) {
      return `${longRoot}${normalized.slice(shortRoot.length)}`;
    }
    if (normalized.toLowerCase().startsWith(longRoot.toLowerCase())) return normalized;
    const error = new Error(`ENOENT: ${candidate}`);
    error.code = 'ENOENT';
    throw error;
  };

  try {
    assert.equal(sameHookPath(existingShort, existingLong, 'win32'), true);

    const missingShort = path.win32.join(parentShort, 'program.md');
    const missingLong = path.win32.join(parentLong, 'program.md');
    assert.equal(sameHookPath(missingShort, missingLong, 'win32'), true);
    assert.equal(sameHookPath(missingShort, path.win32.join(parentLong, 'strategy.yaml'), 'win32'), false);

    const shortWorktrees = path.win32.join(shortRoot, '.deep-evolve', 'session-current', 'worktrees');
    const longSeedProgram = path.win32.join(longRoot, '.deep-evolve', 'session-current',
      'worktrees', 'seed_1', 'program.md');
    assert.equal(relativeHookPath(shortWorktrees, longSeedProgram, 'win32'),
      'seed_1/program.md');
    assert.equal(relativeHookPath(shortWorktrees,
      path.win32.join(longRoot, '.deep-evolve', 'session-current', 'program.md'), 'win32'), null);
  } finally {
    fs.realpathSync.native = originalRealpath;
  }
});
