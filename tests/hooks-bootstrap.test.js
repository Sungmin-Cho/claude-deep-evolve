'use strict';

// tests/hooks-bootstrap.test.js — E2 env-bootstrap 계약 (design rev.6 §5).
// 유닛 A: 두 surface의 POSIX command가 동일한 env-bootstrap 단일 문자열임을
// 고정하고(${ 부재), 가드 fail-closed exit 매핑·async 1회-settle·deadline
// 그룹-킬을 부수효과로 검증한다. 유닛 B 단언은 post-G4 랜딩 커밋에서만 켠다.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scrubHostEnv } = require('../hooks/scripts/test-helpers/run-protect-readonly');

const root = path.resolve(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const IS_WINDOWS = process.platform === 'win32';

// post-G4 유닛 B 랜딩 커밋에서만 true로 바꾼다 (design rev.6 §5.1②).
const UNIT_B_LANDED = false;

function bootstrapScript() {
  const command = readJson('hooks/hooks.json').hooks.PreToolUse[0].hooks[0].command;
  assert.match(command, /^node -e "/);
  assert.equal(command.endsWith('"'), true);
  return command.slice('node -e "'.length, -1);
}

function cleanEnv(extra = {}) {
  const env = scrubHostEnv();
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.PLUGIN_ROOT;
  return { ...env, ...extra };
}

function runBootstrap({ env = {}, cwd = root, input = '', timeout = 15000 } = {}) {
  return spawnSync(process.execPath, ['-e', bootstrapScript()], {
    input, cwd, encoding: 'utf8', timeout, env: cleanEnv(env),
  });
}

function makeFixtureRoot(stubSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-bootstrap-'));
  const scripts = path.join(dir, 'hooks', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  if (stubSource !== null) {
    fs.writeFileSync(path.join(scripts, 'protect-readonly.cjs'), stubSource);
  }
  return dir;
}

// ── 유닛 A: 파일-형태 ─────────────────────────────────────────────

test('unit A: both surfaces share one identical env-bootstrap POSIX command', () => {
  const codex = readJson('hooks/hooks.json').hooks.PreToolUse[0];
  const claude = readJson('hooks/hooks.claude.json').hooks.PreToolUse[0];
  const codexHook = codex.hooks[0];
  const claudeHook = claude.hooks[0];
  assert.equal(codexHook.command, claudeHook.command);
  assert.match(codexHook.command, /^node -e "/);
  assert.doesNotMatch(codexHook.command, /\$\{/);
  assert.doesNotMatch(claudeHook.command, /\$\{/);
  assert.match(codexHook.command, /CLAUDE_PLUGIN_ROOT/);
  assert.match(codexHook.command, /process\.env\.PLUGIN_ROOT/);
  assert.match(codexHook.command, /4000/);
  const script = codexHook.command.slice('node -e "'.length, -1);
  for (const forbidden of ['$', '"', '`', '!', '%']) {
    assert.equal(script.includes(forbidden), false,
      'bootstrap script must not contain shell-unsafe character ' + forbidden);
  }
  assert.equal(codex.matcher, 'Bash|apply_patch');
  assert.equal(claude.matcher, 'Read|Write|Edit|MultiEdit|Bash');
  assert.equal(codexHook.timeout, 5);
  assert.equal(claudeHook.timeout, 5);
  assert.equal(Object.hasOwn(claudeHook, 'args'), false);
  assert.equal(Object.hasOwn(claudeHook, 'commandWindows'), false);
  assert.equal(readJson('.claude-plugin/plugin.json').hooks, './hooks/hooks.claude.json');
});

// ── 유닛 B (post-G4에서만 활성화 — design §5.1②) ──────────────────

test('unit B: hooks.json commandWindows carries no template expansion',
  { skip: UNIT_B_LANDED === false }, () => {
    const codexHook = readJson('hooks/hooks.json').hooks.PreToolUse[0].hooks[0];
    assert.doesNotMatch(codexHook.commandWindows, /\$\{/);
    assert.doesNotMatch(codexHook.commandWindows, /%PLUGIN_ROOT%/);
    assert.match(codexHook.commandWindows, /; exit \$LASTEXITCODE$/);
    const claudeHook = readJson('hooks/hooks.claude.json').hooks.PreToolUse[0].hooks[0];
    assert.equal(Object.hasOwn(claudeHook, 'commandWindows'), false);
  });

// ── bootstrap 동작: env 조합 4종 ──────────────────────────────────

test('bootstrap resolves CLAUDE_PLUGIN_ROOT', () => {
  const fixture = makeFixtureRoot('process.exit(0);\n');
  assert.equal(runBootstrap({ env: { CLAUDE_PLUGIN_ROOT: fixture } }).status, 0);
});

test('bootstrap falls back to PLUGIN_ROOT', () => {
  const fixture = makeFixtureRoot('process.exit(0);\n');
  assert.equal(runBootstrap({ env: { PLUGIN_ROOT: fixture } }).status, 0);
});

test('CLAUDE_PLUGIN_ROOT wins over PLUGIN_ROOT', () => {
  const claudeRoot = makeFixtureRoot('process.exit(0);\n');
  const codexRoot = makeFixtureRoot('process.exit(1);\n');
  const result = runBootstrap({
    env: { CLAUDE_PLUGIN_ROOT: claudeRoot, PLUGIN_ROOT: codexRoot },
  });
  assert.equal(result.status, 0);
});

test('no root env fails closed with diagnostics', () => {
  const result = runBootstrap();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CLAUDE_PLUGIN_ROOT\/PLUGIN_ROOT unset/);
});

// ── bootstrap 동작: infra·verdict 매핑 ────────────────────────────

test('missing guard script fails closed with the path in stderr', () => {
  const fixture = makeFixtureRoot(null);
  const result = runBootstrap({ env: { CLAUDE_PLUGIN_ROOT: fixture } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /protect-readonly\.cjs/);
});

test('guard child exit 1 maps to fail-closed exit 2', () => {
  const fixture = makeFixtureRoot('process.exit(1);\n');
  const result = runBootstrap({ env: { CLAUDE_PLUGIN_ROOT: fixture } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /child exit 1/);
});

test('syntactically broken guard maps to fail-closed exit 2', () => {
  const fixture = makeFixtureRoot('this is not javascript\n');
  assert.equal(runBootstrap({ env: { CLAUDE_PLUGIN_ROOT: fixture } }).status, 2);
});

test('signal-terminated guard maps to fail-closed exit 2', { skip: IS_WINDOWS }, () => {
  const fixture = makeFixtureRoot(
    'process.kill(process.pid, "SIGTERM");\nsetInterval(() => {}, 1000);\n',
  );
  const result = runBootstrap({ env: { CLAUDE_PLUGIN_ROOT: fixture } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /signal SIGTERM/);
});

// ── end-to-end: 실제 가드 차단 (골든 03 시나리오 재사용) ──────────

test('end-to-end: real guard blocks Edit on sealed prepare.py through the bootstrap', () => {
  // realpathSync canonicalizes macOS `/var` → `/private/var` so the guard's
  // string-equality path check matches (mirrors protect-readonly-golden.test.js).
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-e2e-')));
  const sessionRoot = path.join(tmpRoot, '.deep-evolve', 's-active');
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, '.deep-evolve', 'current.json'),
    JSON.stringify({ session_id: 's-active' }),
  );
  fs.writeFileSync(path.join(sessionRoot, 'session.yaml'), `${JSON.stringify({
    session_id: 's-active',
    deep_evolve_version: '3.4.3',
    status: 'active',
    created_at: '2026-07-10T00:00:00Z',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(sessionRoot, 'prepare.py'), 'SECRET = 1\n');
  const event = {
    session_id: 'bootstrap-e2e',
    cwd: tmpRoot,
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(sessionRoot, 'prepare.py') },
  };
  const result = runBootstrap({
    env: { CLAUDE_PLUGIN_ROOT: root },
    cwd: tmpRoot,
    input: JSON.stringify(event),
  });
  assert.equal(result.status, 2);
});

// ── async settle 상태기계 (spec §4.2 — 단독 error / error+exit 경합) ──

test('injected spawn error alone settles exactly once as fail-closed', () => {
  const harness = [
    "const cp = require('node:child_process');",
    "const { EventEmitter } = require('node:events');",
    'cp.spawn = () => {',
    '  const child = new EventEmitter();',
    '  child.pid = 99999;',
    "  setImmediate(() => { child.emit('error', new Error('injected')); });",
    '  return child;',
    '};',
    'const settles = [];',
    'process.exit = (code) => { settles.push(code); };',
    "process.on('beforeExit', () => { console.log('SETTLED:' + JSON.stringify(settles)); });",
    '',
  ].join('\n');
  const started = Date.now();
  const result = spawnSync(process.execPath, ['-e', harness + bootstrapScript()], {
    encoding: 'utf8',
    timeout: 15000,
    env: cleanEnv({ CLAUDE_PLUGIN_ROOT: root }),
  });
  assert.match(result.stdout, /SETTLED:\[2\]/);
  assert.ok(Date.now() - started < 3000,
    'settle must clear both timers so the event loop drains immediately');
});

test('injected error/exit race settles exactly once and clears the deadline timer', () => {
  const harness = [
    "const cp = require('node:child_process');",
    "const { EventEmitter } = require('node:events');",
    'cp.spawn = () => {',
    '  const child = new EventEmitter();',
    '  child.pid = 99999;',
    '  setImmediate(() => {',
    "    child.emit('error', new Error('injected'));",
    "    child.emit('exit', 1, null);",
    '  });',
    '  return child;',
    '};',
    'const settles = [];',
    'process.exit = (code) => { settles.push(code); };',
    "process.on('beforeExit', () => { console.log('SETTLED:' + JSON.stringify(settles)); });",
    '',
  ].join('\n');
  const started = Date.now();
  const result = spawnSync(process.execPath, ['-e', harness + bootstrapScript()], {
    encoding: 'utf8',
    timeout: 15000,
    env: cleanEnv({ CLAUDE_PLUGIN_ROOT: root }),
  });
  assert.match(result.stdout, /SETTLED:\[2\]/);
  assert.ok(Date.now() - started < 3000,
    'cleared deadline timer must let the event loop drain immediately');
});

// ── deadline 그룹-킬 (POSIX — 신호-저항 grandchild; spec §4.2) ────

function isDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

// bounded polling: kill 발행과 커널 reaping 사이 창(시스템 부하에 따라 가변)을
// 고정 sleep 대신 최대 maxMs까지 stepMs 간격으로 기다려 flaky를 제거한다.
async function waitDead(pid, maxMs = 3000, stepMs = 50) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (isDead(pid)) return;
    await new Promise((resolve) => { setTimeout(resolve, stepMs); });
  }
  assert.ok(isDead(pid), 'process ' + pid + ' is still alive after the group kill');
}

test('deadline kills the whole process group and fails closed', { skip: IS_WINDOWS }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-late-'));
  const lateFile = path.join(workDir, 'late.txt');
  const stubPidFile = path.join(workDir, 'stub.pid');
  const bashPidFile = path.join(workDir, 'bash.pid');
  const stub = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    'fs.writeFileSync(process.env.STUB_PID_FILE, String(process.pid));',
    "spawn('bash', ['-c',",
    "  'echo $$ > \"' + process.env.BASH_PID_FILE + '\"; trap \"\" TERM INT; sleep 6; echo late > \"' + process.env.LATE_FILE + '\"'],",
    "  { stdio: 'ignore' });",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const fixture = makeFixtureRoot(stub);
  const started = Date.now();
  const result = runBootstrap({
    env: {
      CLAUDE_PLUGIN_ROOT: fixture,
      LATE_FILE: lateFile,
      STUB_PID_FILE: stubPidFile,
      BASH_PID_FILE: bashPidFile,
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /deadline 4000ms/);
  assert.ok(Date.now() - started < 8000, 'bootstrap must settle at its own 4000ms deadline');
  const stubPid = Number(fs.readFileSync(stubPidFile, 'utf8').trim());
  const bashPid = Number(fs.readFileSync(bashPidFile, 'utf8').trim());
  assert.ok(Number.isInteger(stubPid) && stubPid > 0, 'stub must have recorded its pid');
  assert.ok(Number.isInteger(bashPid) && bashPid > 0, 'bash wrapper must have recorded its pid');
  await waitDead(stubPid);
  await waitDead(bashPid);
  await new Promise((resolve) => { setTimeout(resolve, 3000); });
  assert.equal(fs.existsSync(lateFile), false, 'group kill must prevent the late write');
});

// ── Windows taskkill 기동-실패 주입 (BLK-N1 회귀 가드; spawn 모킹) ──
// process.platform='win32' + taskkill spawn이 async 'error'를 emit하도록 주입.
// error listener가 없으면 unhandled throw로 exit 1(계약 우회) → 이 테스트가 RED.
// listener가 있으면 grace 800ms 백스톱이 exit 2로 settle → GREEN.

test('windows taskkill spawn failure still fails closed via the grace backstop', () => {
  const harness = [
    "const cp = require('node:child_process');",
    "const { EventEmitter } = require('node:events');",
    "Object.defineProperty(process, 'platform', { value: 'win32' });",
    'const realSpawn = cp.spawn;',
    'let call = 0;',
    'cp.spawn = (cmd, spawnArgs, opts) => {',
    '  call = call + 1;',
    '  if (call === 1) {',
    '    const child = new EventEmitter();',
    '    child.pid = 4242;',
    '    return child;',            // guard child: never exits → deadline fires
    '  }',
    '  const killer = new EventEmitter();',
    '  killer.pid = 4243;',
    "  setImmediate(() => { killer.emit('error', new Error('spawn taskkill ENOENT')); });",
    '  return killer;',
    '};',
    'const settles = [];',
    'const realExit = process.exit;',
    'process.exit = (code) => { settles.push(code); };',
    "process.on('beforeExit', () => { console.log('SETTLED:' + JSON.stringify(settles)); });",
    '',
  ].join('\n');
  const started = Date.now();
  const result = spawnSync(process.execPath, ['-e', harness + bootstrapScript()], {
    encoding: 'utf8',
    timeout: 15000,
    env: cleanEnv({ CLAUDE_PLUGIN_ROOT: root }),
  });
  // unhandled 'error'가 throw되면 stderr에 스택이 찍히고 SETTLED가 안 나온다.
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
  assert.match(result.stdout, /SETTLED:\[2\]/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4000 && elapsed < 6000,
    'must settle via the 4000ms deadline + 800ms grace, not crash early');
});
