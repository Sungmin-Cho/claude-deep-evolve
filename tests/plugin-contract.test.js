'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

test('Codex uses one default-discovered Node guard and no plugin-level hook supplement', () => {
  const manifest = readJson('.codex-plugin/plugin.json');
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
  assert.equal(Object.hasOwn(manifest, 'mcpServers'), false);

  const hookManifest = readJson('hooks/hooks.json');
  assert.deepEqual(Object.keys(hookManifest), ['hooks']);
  assert.deepEqual(Object.keys(hookManifest.hooks), ['PreToolUse']);
  assert.equal(hookManifest.hooks.PreToolUse.length, 1);
  const registration = hookManifest.hooks.PreToolUse[0];
  assert.equal(registration.matcher, 'Bash|apply_patch');
  assert.equal(registration.hooks.length, 1);
  assert.deepEqual(registration.hooks[0], {
    type: 'command',
    command: 'node "${PLUGIN_ROOT}/hooks/scripts/protect-readonly.cjs"',
    commandWindows: 'node "${PLUGIN_ROOT}\\hooks\\scripts\\protect-readonly.cjs" ; exit $LASTEXITCODE',
    timeout: 5,
  });
  assert.doesNotMatch(registration.hooks[0].commandWindows, /%PLUGIN_ROOT%/,
    'Codex runs Windows hooks through PowerShell, so cmd.exe-only expansion would fail open');
  assert.match(registration.hooks[0].commandWindows, /" ; exit \$LASTEXITCODE$/,
    'PowerShell must propagate the native Node guard exit code to Codex');
  assert.equal(Object.hasOwn(registration.hooks[0], 'args'), false);
  assert.doesNotMatch(registration.matcher, /Read|Write|Edit|MultiEdit/);
});

test('Claude uses one custom-path shell-free Node guard without Codex-only fields', () => {
  const manifest = readJson('.claude-plugin/plugin.json');
  assert.equal(manifest.hooks, './hooks/hooks.claude.json');
  assert.equal(Object.hasOwn(manifest, 'mcpServers'), false);

  const hookManifest = readJson('hooks/hooks.claude.json');
  assert.deepEqual(Object.keys(hookManifest), ['hooks']);
  assert.deepEqual(Object.keys(hookManifest.hooks), ['PreToolUse']);
  assert.equal(hookManifest.hooks.PreToolUse.length, 1);
  const registration = hookManifest.hooks.PreToolUse[0];
  assert.equal(registration.matcher, 'Read|Write|Edit|MultiEdit|Bash');
  assert.equal(registration.hooks.length, 1);
  assert.deepEqual(registration.hooks[0], {
    type: 'command',
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/hooks/scripts/protect-readonly.cjs'],
    timeout: 5,
  });
  assert.equal(Object.hasOwn(registration.hooks[0], 'commandWindows'), false);
  assert.doesNotMatch(registration.matcher, /apply_patch/);
});

test('the intermediate package ships both host manifests and the shared CommonJS guard', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.js');
  assert.ok(pkg.files.includes('hooks/hooks.json'));
  assert.ok(pkg.files.includes('hooks/hooks.claude.json'));
  assert.ok(pkg.files.includes('hooks/scripts/*.cjs'));
  assert.ok(pkg.files.includes('hooks/scripts/runtime/'));
});

test('Task 2 golden documentation matches the runner template-expansion contract', () => {
  const goldenReadme = fs.readFileSync(path.join(root, 'tests/fixtures/golden/README.md'), 'utf8');
  assert.match(goldenReadme, /Values inside `tool_input` are walked/);
  assert.doesNotMatch(goldenReadme, /`tool_input` and `env`/);
});
