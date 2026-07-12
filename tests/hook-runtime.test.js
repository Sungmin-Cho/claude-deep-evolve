'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  evaluateHook,
  extractPatchPaths,
  normalizeHookPath,
  sameHookPath,
  tokenizeCommand,
} = require('../hooks/scripts/protect-readonly.cjs');

const hookPath = path.resolve(__dirname, '..', 'hooks/scripts/protect-readonly.cjs');
const legacyWrapperPath = path.resolve(__dirname, '..', 'hooks/scripts/protect-readonly.sh');
const diagnosticSmokePath = path.resolve(__dirname, '..', 'scripts/smoke-installed-codex-hook.cjs');
const fixtureRoot = path.join(__dirname, 'fixtures', 'hooks');

function readFixture(name, replacements = {}) {
  const value = JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8'));
  const expand = (input) => {
    if (typeof input === 'string') {
      let output = input;
      for (const [key, replacement] of Object.entries(replacements)) {
        output = output.split(`{{${key}}}`).join(replacement);
      }
      return output;
    }
    if (Array.isArray(input)) return input.map(expand);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, expand(item)]));
    }
    return input;
  };
  return expand(value);
}

function claudeEvent(toolName, toolInput, cwd) {
  return {
    session_id: `claude-${toolName.toLowerCase()}`,
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  };
}

function makeProject({ status = 'active', crlf = false, unsupported = false } = {}) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evolve hook ')));
  const sessionId = 'session-current';
  const sessionRoot = path.join(projectRoot, '.deep-evolve', sessionId);
  fs.mkdirSync(path.join(sessionRoot, 'worktrees', 'seed_1'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.deep-evolve', 'current.json'),
    `${JSON.stringify({ session_id: sessionId })}${crlf ? '\r\n' : '\n'}`,
  );
  const state = unsupported
    ? 'defaults: &defaults\n  status: active\nsession:\n  <<: *defaults\n'
    : JSON.stringify({
      session_id: sessionId,
      deep_evolve_version: '3.4.3',
      status,
      created_at: '2026-07-10T00:00:00Z',
    }, null, 2);
  fs.writeFileSync(
    path.join(sessionRoot, 'session.yaml'),
    crlf ? `${state.replace(/\n/g, '\r\n')}\r\n` : `${state}\n`,
  );
  for (const [relative, contents] of [
    ['prepare.cjs', 'process.stdout.write("score: 1\\n");\n'],
    ['prepare.py', 'print("score: 1")\n'],
    ['prepare-protocol.md', '# protocol\n'],
    ['program.md', '# program\n'],
    ['strategy.yaml', 'version: 1\n'],
    ['worktrees/seed_1/program.md', '# seed program\n'],
  ]) {
    const target = path.join(sessionRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return {
    projectRoot,
    sessionRoot,
    cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function parseBlock(result) {
  assert.equal(result.exitCode, 2);
  const decision = JSON.parse(result.output);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /Deep Evolve Guard/);
  return decision;
}

function withProject(options, fn) {
  const project = makeProject(options);
  try { return fn(project); } finally { project.cleanup(); }
}

test('Claude and Codex host contracts block an equivalent protected edit', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const replacements = { SESSION_ROOT: sessionRoot, PROJECT_ROOT: projectRoot };
  const claude = evaluateHook(
    readFixture('claude-protected-edit.json', replacements),
    {},
    projectRoot,
  );
  const codex = evaluateHook(
    readFixture('codex-pretooluse-apply-patch-command.json', replacements),
    {},
    projectRoot,
  );
  assert.deepEqual(codex, claude);
  parseBlock(codex);
}));

test('official host envelopes take precedence over stale legacy Claude selector variables', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const protectedEdit = evaluateHook(
    claudeEvent('Edit', { file_path: path.join(sessionRoot, 'program.md') }, projectRoot),
    { CLAUDE_TOOL_USE_TOOL_NAME: 'Read', CLAUDE_TOOL_NAME: 'Read' },
    projectRoot,
  );
  parseBlock(protectedEdit);

  const codexPatch = evaluateHook(
    readFixture('codex-pretooluse-apply-patch-command.json', { SESSION_ROOT: sessionRoot }),
    { CLAUDE_TOOL_USE_TOOL_NAME: 'Read', CLAUDE_TOOL_NAME: 'Read' },
    projectRoot,
  );
  parseBlock(codexPatch);
}));

test('real Claude envelopes allow unrelated no-state work and classify protected file tools precisely', () => {
  const noStateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evolve hook no state ')));
  try {
    assert.deepEqual(evaluateHook({
      session_id: 'claude-no-state',
      cwd: noStateRoot,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(noStateRoot, 'src', 'unrelated.js') },
    }, {}, noStateRoot), { exitCode: 0, output: '' });
  } finally {
    fs.rmSync(noStateRoot, { recursive: true, force: true });
  }

  withProject({}, ({ projectRoot, sessionRoot }) => {
    for (const [toolName, filePath] of [
      ['Write', path.join(sessionRoot, 'program.md')],
      ['Edit', path.join(sessionRoot, 'strategy.yaml')],
      ['MultiEdit', path.join(sessionRoot, 'worktrees', 'seed_1', 'program.md')],
    ]) {
      const decision = parseBlock(evaluateHook({
        session_id: `claude-${toolName}`,
        cwd: projectRoot,
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: { file_path: filePath },
      }, {}, projectRoot));
      assert.match(decision.reason, /active sessions protect/, toolName);
    }
    const bash = parseBlock(evaluateHook({
      session_id: 'claude-bash',
      cwd: projectRoot,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `cat "${path.join(sessionRoot, 'prepare.cjs')}"` },
    }, { DEEP_EVOLVE_SEAL_PREPARE: '1' }, projectRoot));
    assert.match(bash.reason, /seal_prepare_read/);
  });
});

test('Claude structured Write Edit and MultiEdit protect root and seed program paths', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  for (const [toolName, filePath] of [
    ['Write', path.join(sessionRoot, 'program.md')],
    ['Edit', path.join(sessionRoot, 'strategy.yaml')],
    ['MultiEdit', path.join(sessionRoot, 'worktrees', 'seed_1', 'program.md')],
  ]) {
    parseBlock(evaluateHook(claudeEvent(toolName, { file_path: filePath }, projectRoot), {}, projectRoot));
  }
}));

test('Codex consumes Bash and apply_patch command text without evaluating it', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const replacements = { SESSION_ROOT: sessionRoot };
  parseBlock(evaluateHook(readFixture('codex-pretooluse-bash-command.json', replacements), {}, projectRoot));
  const multi = evaluateHook(readFixture('codex-pretooluse-apply-patch-add-delete.json', replacements), {}, projectRoot);
  parseBlock(multi);
  assert.deepEqual(
    extractPatchPaths(readFixture('codex-pretooluse-apply-patch-add-delete.json', replacements).tool_input.command),
    [path.join(sessionRoot, 'worktrees', 'seed_2', 'program.md'), path.join(sessionRoot, 'strategy.yaml')],
  );
}));

test('hook path comparison covers Windows spaces, drive casing, and UNC roots', () => {
  assert.equal(normalizeHookPath('C:\\Workspace With Spaces\\Repo\\.deep-evolve\\s\\program.md', 'win32'), 'c:/workspace with spaces/repo/.deep-evolve/s/program.md');
  assert.equal(sameHookPath('C:\\WORKSPACE WITH SPACES\\Repo\\x', 'c:\\workspace with spaces\\repo\\x', 'win32'), true);
  assert.equal(sameHookPath('\\\\server\\share\\repo\\x', '\\\\SERVER\\SHARE\\repo\\x', 'win32'), true);
  assert.equal(sameHookPath('\\\\server\\share\\repo', '\\\\server\\share2\\repo', 'win32'), false);
});

test('LF and CRLF active state both block protected paths', () => {
  for (const crlf of [false, true]) {
    withProject({ crlf }, ({ projectRoot, sessionRoot }) => {
      parseBlock(evaluateHook(
        claudeEvent('Write', { file_path: path.join(sessionRoot, 'prepare-protocol.md') }, projectRoot),
        {},
        projectRoot,
      ));
    });
  }
});

test('missing state and recognized inactive state allow requests', () => {
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evolve no state ')));
  try {
    assert.deepEqual(evaluateHook(
      claudeEvent('Edit', { file_path: path.join(empty, 'prepare.cjs') }, empty), {}, empty,
    ), { exitCode: 0, output: '' });
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  withProject({ status: 'paused' }, ({ projectRoot, sessionRoot }) => {
    assert.deepEqual(evaluateHook(
      claudeEvent('Edit', { file_path: path.join(sessionRoot, 'prepare.cjs') }, projectRoot), {}, projectRoot,
    ), { exitCode: 0, output: '' });
  });
});

test('meta modes preserve the exact prepare program and strategy write bypasses', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const evaluate = (file, mode) => evaluateHook(
    claudeEvent('Edit', { file_path: path.join(sessionRoot, file) }, projectRoot),
    { DEEP_EVOLVE_META_MODE: mode },
    projectRoot,
  );
  assert.deepEqual(evaluate('prepare.cjs', 'prepare_update'), { exitCode: 0, output: '' });
  assert.deepEqual(evaluate('prepare-protocol.md', 'prepare_update'), { exitCode: 0, output: '' });
  assert.deepEqual(evaluate('program.md', 'program_update'), { exitCode: 0, output: '' });
  assert.deepEqual(evaluate('program.md', 'outer_loop'), { exitCode: 0, output: '' });
  assert.deepEqual(evaluate('strategy.yaml', 'outer_loop'), { exitCode: 0, output: '' });
  parseBlock(evaluate('strategy.yaml', 'program_update'));
}));

test('seal mode blocks Claude Read and shell reads while direct Node prepare.cjs remains allowed', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const env = { DEEP_EVOLVE_SEAL_PREPARE: '1' };
  const read = evaluateHook(
    claudeEvent('Read', { file_path: path.join(sessionRoot, 'prepare.cjs') }, projectRoot),
    env,
    projectRoot,
  );
  assert.match(parseBlock(read).reason, /seal_prepare_read/);
  const shellRead = evaluateHook({
    tool_name: 'Bash',
    tool_input: { command: `cat "${path.join(sessionRoot, 'prepare-protocol.md')}"` },
  }, env, projectRoot);
  assert.match(parseBlock(shellRead).reason, /seal_prepare_read/);
  assert.deepEqual(evaluateHook({
    tool_name: 'Bash',
    tool_input: { command: `node "${path.join(sessionRoot, 'prepare.cjs')}"` },
  }, env, projectRoot), { exitCode: 0, output: '' });
}));

test('legacy prepare.py execution is blocked with a typed regeneration requirement', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  for (const prefix of ['python', 'python3', 'py -3']) {
    const decision = parseBlock(evaluateHook({
      tool_name: 'Bash',
      tool_input: { command: `${prefix} "${path.join(sessionRoot, 'prepare.py')}"` },
    }, {}, projectRoot));
    assert.match(decision.reason, /legacy_prepare_regeneration_required/);
  }
}));

test('legacy prepare.py execution stays typed-blocked through interpreter flags and launcher selectors', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const target = path.join(sessionRoot, 'prepare.py');
  for (const command of [
    `python -u "${target}"`,
    `python3 -B "${target}"`,
    `python3.11 -I -u "${target}"`,
    `python -- "${target}"`,
    `py -3.11 "${target}"`,
    `py.exe -V:3.11 "${target}"`,
    `python -c "exec(open('${target}').read())"`,
    `py -3 -c "import runpy; runpy.run_path('${target}', run_name='__main__')"`,
  ]) {
    const decision = parseBlock(evaluateHook({
      tool_name: 'Bash',
      tool_input: { command },
    }, { DEEP_EVOLVE_META_MODE: 'prepare_update' }, projectRoot));
    assert.match(decision.reason, /legacy_prepare_regeneration_required/, command);
  }
  for (const command of [
    `python -c "print('notprepare.py')"`,
    `python "${path.join(sessionRoot, 'prepare.py.bak')}"`,
  ]) {
    assert.deepEqual(evaluateHook({
      tool_name: 'Bash',
      tool_input: { command },
    }, { DEEP_EVOLVE_META_MODE: 'prepare_update' }, projectRoot), { exitCode: 0, output: '' }, command);
  }
}));

test('legacy prepare.py execution stays typed-blocked through wrappers assignments and compounds', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const target = path.join(sessionRoot, 'prepare.py');
  const windowsEnv = 'C:\\Program Files\\Git\\usr\\bin\\env.exe';
  for (const command of [
    `env python "${target}"`,
    `/usr/bin/env python3 -u "${target}"`,
    `"${windowsEnv}" py -3 "${target}"`,
    `env -i DEEP_EVOLVE_TEST=1 /usr/bin/python3 "${target}"`,
    `command python3 "${target}"`,
    `command -- python3 "${target}"`,
    `exec py -3.11 "${target}"`,
    `exec -a evolve-python python3 "${target}"`,
    `DEEP_EVOLVE_TEST=1 python "${target}"`,
    `echo ready; python3 "${target}"`,
    `echo ready && py -3 "${target}"`,
    `set DEEP_EVOLVE_TEST=1 && py -3 "${target}"`,
    `cmd.exe /d /c python3 "${target}"`,
    `sh -c "python3 '${target}'"`,
    `env py""thon3 "${target.slice(0, -3)}".py`,
  ]) {
    const decision = parseBlock(evaluateHook({
      tool_name: 'Bash',
      tool_input: { command },
    }, { DEEP_EVOLVE_META_MODE: 'prepare_update' }, projectRoot));
    assert.match(decision.reason, /legacy_prepare_regeneration_required/, command);
  }
}));

test('POSIX lexical reconstruction blocks escaped legacy Python execution in active and invalid state', {
  skip: process.platform === 'win32',
}, () => {
  const classify = (options, expectedReason) => withProject(options, ({ projectRoot, sessionRoot }) => {
    const target = path.join(sessionRoot, 'prepare.py').replaceAll(' ', '\\ ');
    const escapedLetter = target.replace('prepare.py', 'pre\\pare.py');
    const escapedDot = target.replace('prepare.py', 'prepare\\.py');
    const escapedBoth = target.replace('prepare.py', 'pre\\pare\\.py');
    const continued = target.replace('prepare.py', `pre\\${'\n'}pare.py`);
    const continuedLauncher = `py\\${'\n'}thon3`;
    const quotedConcat = `py""thon3 ${target.slice(0, -3)}"".py`;
    for (const command of [
      `python ${escapedLetter}`,
      `python ${escapedDot}`,
      `python ${escapedBoth}`,
      `py\\thon3 ${escapedBoth}`,
      `python ${continued}`,
      `${continuedLauncher} ${continued}`,
      quotedConcat,
    ]) {
      const decision = parseBlock(evaluateHook({
        tool_name: 'Bash',
        tool_input: { command },
      }, { DEEP_EVOLVE_META_MODE: 'prepare_update' }, projectRoot));
      assert.match(decision.reason, expectedReason, command);
    }
    for (const command of [
      `python ${target.replace('prepare.py', 'notprepare.py')}`,
      `python ${target.replace('prepare.py', 'prepare.py.bak')}`,
    ]) {
      assert.deepEqual(evaluateHook({
        tool_name: 'Bash',
        tool_input: { command },
      }, { DEEP_EVOLVE_META_MODE: 'prepare_update' }, projectRoot), { exitCode: 0, output: '' }, command);
    }
  });

  classify({}, /legacy_prepare_regeneration_required/);
  classify({ unsupported: true }, /state_invalid/);
});

test('command lexical reconstruction is host-aware without collapsing Windows separators', () => {
  assert.deepEqual(
    tokenizeCommand(String.raw`py\thon3 /tmp/pre\pare\.py`, 'posix').words,
    ['python3', '/tmp/prepare.py'],
  );
  assert.deepEqual(
    tokenizeCommand(`python /tmp/pre\\${'\n'}pare.py`, 'posix').words,
    ['python', '/tmp/prepare.py'],
  );

  const driveTarget = String.raw`C:\Workspace With Spaces\repo\.deep-evolve\session-current\prepare.cjs`;
  const uncTarget = String.raw`\\server\share\repo\.deep-evolve\session-current\prepare.py`;
  assert.deepEqual(tokenizeCommand(`node "${driveTarget}"`, 'win32').words, ['node', driveTarget]);
  assert.deepEqual(tokenizeCommand(`python "${uncTarget}"`, 'win32').words, ['python', uncTarget]);
  assert.ok(
    tokenizeCommand(String.raw`cmd.exe /d /c echo changed > C:\repo\.deep-evolve\s\pre^pare.cjs`, 'win32')
      .words.includes(String.raw`C:\repo\.deep-evolve\s\prepare.cjs`),
  );
  assert.ok(
    tokenizeCommand(`pwsh.exe -NoProfile -Command "Set-Content C:\\repo\\.deep-evolve\\s\\pre${String.fromCharCode(96)}pare.cjs changed"`, 'powershell')
      .words.includes(String.raw`Set-Content C:\repo\.deep-evolve\s\prepare.cjs changed`),
  );
  assert.ok(
    tokenizeCommand("cmd.exe /d /c echo 'marker & powershell.exe -Command safe'", 'win32')
      .controls.includes('&'),
    'cmd.exe treats single quotes as ordinary bytes, not grouping quotes',
  );
  assert.equal(
    tokenizeCommand("powershell.exe -Command Write-Output 'cmd.exe & safe'", 'powershell').controls.length,
    0,
    'PowerShell still treats single quotes as grouping quotes',
  );
});

test('native cmd caret spelling cannot bypass an active protected target', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const decision = parseBlock(evaluateHook({
    tool_name: 'Bash',
    tool_input: {
      command: `cmd.exe /d /c cd /d "${sessionRoot}" && echo changed > pre^pare.cjs`,
    },
  }, {}, projectRoot));
  assert.match(decision.reason, /ambiguous_protected_reference|active sessions protect/);
}));

test('PowerShell backtick spelling cannot bypass an active protected target', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const decision = parseBlock(evaluateHook({
    tool_name: 'Bash',
    tool_input: {
      command: `pwsh.exe -NoProfile -Command "Set-Location -LiteralPath '${sessionRoot}'; Set-Content -LiteralPath pre${String.fromCharCode(96)}pare.cjs -Value changed"`,
    },
  }, {}, projectRoot));
  assert.match(decision.reason, /ambiguous_protected_reference|active sessions protect/);
}));

test('shell pathname patterns that can resolve to protected basenames fail closed without false suffix matches', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  for (const command of [
    `printf compromised | tee "${path.join(sessionRoot, 'pre?are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre*are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre[p]are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre[a-z]are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre[!x]are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre[]p]are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre[!]]are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre[^]]are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre[[:alpha:]]are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre[[:lower:][:digit:]]are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre[![:digit:]]are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre[[:notaclass:]]are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre[[=p=]]are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre[[.p.]]are.cjs')}"`,
    `printf compromised | tee "${path.join(sessionRoot, 'pre[[:alpha:]are.cjs')}"`,
    `pwsh.exe -NoProfile -Command "Set-Location -LiteralPath '${sessionRoot}'; Set-Content -Path pre?are.cjs -Value compromised"`,
    `pwsh.exe -NoProfile -Command "Set-Location -LiteralPath '${sessionRoot}'; Set-Content -Path PRE?ARE.CJS -Value compromised"`,
  ]) {
    const decision = parseBlock(evaluateHook(claudeEvent('Bash', { command }, projectRoot), {}, projectRoot));
    assert.match(decision.reason, /ambiguous_protected_reference/, command);
  }

  for (const command of [
    `printf safe | tee "${path.join(sessionRoot, 'notprepare.cjs')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'prepare.cjs.bak')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'notpre?are.cjs')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'pre?are.cjs.bak')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'pre[!p]are.cjs')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'pre[]]are.cjs')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'pre[]are.cjs')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'pre[!are.cjs')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'pre[[:digit:]]are.cjs')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'pre[[:upper:]]are.cjs')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'pre[![:alpha:]]are.cjs')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'pre[[:alpha:]]are.cjs.bak')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'notpre[[:alpha:]]are.cjs')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'pre[[:notaclass:]]are.cjs.bak')}"`,
    `printf safe | tee "${path.join(sessionRoot, 'notpre[[:notaclass:]]are.cjs')}"`,
  ]) {
    assert.deepEqual(
      evaluateHook(claudeEvent('Bash', { command }, projectRoot), {}, projectRoot),
      { exitCode: 0, output: '' },
      command,
    );
  }
}));

test('POSIX named-character-class probe cannot change protected bytes', {
  skip: process.platform === 'win32',
}, () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const target = path.join(sessionRoot, 'prepare.cjs');
  const before = fs.readFileSync(target);
  const shellScript = `cd "${sessionRoot}" && printf compromised | tee pre[[:alpha:]]are.cjs >/dev/null`;
  const command = `sh -c '${shellScript.replaceAll("'", "'\\''")}'`;
  const guard = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(claudeEvent('Bash', { command }, projectRoot)),
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (guard.status === 0) spawnSync('sh', ['-c', shellScript], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(guard.status, 2, guard.stderr);
  assert.equal(guard.stdout, '');
  assert.match(guard.stderr, /ambiguous_protected_reference/);
  assert.deepEqual(fs.readFileSync(target), before);
}));

test('POSIX leading-right-bracket class probe cannot change protected bytes', {
  skip: process.platform === 'win32',
}, () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const target = path.join(sessionRoot, 'prepare.cjs');
  const before = fs.readFileSync(target);
  const shellScript = `cd "${sessionRoot}" && printf compromised | tee pre[]p]are.cjs >/dev/null`;
  const command = `sh -c '${shellScript.replaceAll("'", "'\\''")}'`;
  const guard = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(claudeEvent('Bash', { command }, projectRoot)),
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (guard.status === 0) spawnSync('sh', ['-c', shellScript], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(guard.status, 2, guard.stderr);
  assert.equal(guard.stdout, '');
  assert.match(guard.stderr, /ambiguous_protected_reference/);
  assert.deepEqual(fs.readFileSync(target), before);
}));

test('foreign shell names in POSIX argument text cannot select a weaker lexer', {
  skip: process.platform === 'win32',
}, () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const target = path.join(sessionRoot, 'prepare.cjs');
  const before = fs.readFileSync(target);
  for (const [marker, lane] of [
    ['powershell', 'official'],
    ['cmd', 'legacy'],
  ]) {
    const command = `sh -c 'echo ${marker} >/dev/null && printf safe | tee PRE?ARE.CJS >/dev/null'`;
    const event = lane === 'official' ? claudeEvent('Bash', { command }, projectRoot) : { command };
    const selectorEnv = lane === 'legacy' ? { CLAUDE_TOOL_USE_TOOL_NAME: 'Bash' } : {};
    assert.deepEqual(
      evaluateHook(event, selectorEnv, projectRoot),
      { exitCode: 0, output: '' },
      `${marker}:${lane}:POSIX case semantics`,
    );
  }
  for (const [marker, lane] of [
    ['powershell', 'official'],
    ['cmd', 'legacy'],
  ]) {
    const shellScript = `cd "${sessionRoot}" && echo ${marker} >/dev/null && printf compromised | tee pre${'\\'}pare.cjs >/dev/null`;
    const command = `sh -c '${shellScript.replaceAll("'", "'\\''")}'`;
    const event = lane === 'official'
      ? claudeEvent('Bash', { command }, projectRoot)
      : { command };
    const selectorEnv = lane === 'legacy' ? { CLAUDE_TOOL_USE_TOOL_NAME: 'Bash' } : {};

    const libraryDecision = parseBlock(evaluateHook(event, selectorEnv, projectRoot));
    assert.match(libraryDecision.reason, /ambiguous_protected_reference|active sessions protect/, `${marker}:${lane}`);

    const guard = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(event),
      cwd: projectRoot,
      env: { ...process.env, ...selectorEnv },
      encoding: 'utf8',
    });
    if (guard.status === 0) spawnSync('sh', ['-c', shellScript], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(guard.status, 2, `${marker}:${lane}:${guard.stderr}`);
    assert.equal(guard.stdout, '', `${marker}:${lane}`);
    assert.match(guard.stderr, /Deep Evolve Guard/, `${marker}:${lane}`);
    assert.deepEqual(fs.readFileSync(target), before, `${marker}:${lane}`);
  }
}));

test('parsed secondary shell executables select the payload dialect without trusting marker text', () => withProject({}, ({ projectRoot }) => {
  const backtick = String.fromCharCode(96);
  const nestedCommands = [
    `cmd.exe /d /s /c powershell.exe -NoProfile -Command "Set-Content -LiteralPath pre${backtick}pare.cjs -Value compromised"`,
    `powershell.exe -NoProfile -Command "cmd.exe /d /c echo compromised>pre^pare.cjs"`,
    `sh -c 'pwsh.exe -NoProfile -Command "Set-Content -LiteralPath pre${backtick}pare.cjs -Value compromised"'`,
    `env pwsh.exe -NoProfile -Command "Set-Content -LiteralPath pre${backtick}pare.cjs -Value compromised"`,
    `env -S "pwsh.exe -NoProfile -Command Set-Content pre${backtick}pare.cjs"`,
    `exec -a evolve-guard pwsh.exe -NoProfile -Command "Set-Content -LiteralPath pre${backtick}pare.cjs -Value compromised"`,
  ];
  for (const command of nestedCommands) {
    const officialResult = evaluateHook(
      claudeEvent('Bash', { command }, projectRoot),
      { CLAUDE_TOOL_USE_TOOL_NAME: 'Read', CLAUDE_TOOL_NAME: 'Read' },
      projectRoot,
    );
    assert.equal(officialResult.exitCode, 2, `official:${command}`);
    const official = parseBlock(officialResult);
    assert.match(official.reason, /ambiguous_protected_reference|active sessions protect/, `official:${command}`);

    const legacyResult = evaluateHook(
      { command },
      { CLAUDE_TOOL_USE_TOOL_NAME: 'Bash' },
      projectRoot,
    );
    assert.equal(legacyResult.exitCode, 2, `legacy:${command}`);
    const legacy = parseBlock(legacyResult);
    assert.match(legacy.reason, /ambiguous_protected_reference|active sessions protect/, `legacy:${command}`);
  }

  const malformedOwned = parseBlock(evaluateHook(
    { tool_name: null, tool_input: { command: nestedCommands[0] } },
    { CLAUDE_TOOL_USE_TOOL_NAME: 'Bash' },
    projectRoot,
  ));
  assert.match(malformedOwned.reason, /malformed_input/);

  for (const command of [
    `cmd.exe /d /c echo powershell.exe pre${backtick}pare.cjs`,
    `powershell.exe -NoProfile -Command "Write-Output cmd.exe pre^pare.cjs"`,
    `sh -c 'printf "%s\\n" powershell.exe pre${backtick}pare.cjs >/dev/null'`,
  ]) {
    assert.deepEqual(
      evaluateHook(claudeEvent('Bash', { command }, projectRoot), {}, projectRoot),
      { exitCode: 0, output: '' },
      `non-executable marker:${command}`,
    );
  }
}));

test('transparent wrapper chains reach the parsed secondary shell or fail closed at the wrapper budget', () => withProject({}, ({ projectRoot }) => {
  const backtick = String.fromCharCode(96);
  const payload = `pwsh.exe -NoProfile -Command "Set-Content -LiteralPath pre${backtick}pare.cjs -Value compromised"`;
  const guarded = [
    `command env ${payload}`,
    `exec env ${payload}`,
    `nohup env ${payload}`,
    `command nohup ${payload}`,
  ];
  for (const command of guarded) {
    for (const [lane, event, selectorEnv] of [
      ['official', claudeEvent('Bash', { command }, projectRoot), {}],
      ['legacy', { command }, { CLAUDE_TOOL_USE_TOOL_NAME: 'Bash' }],
    ]) {
      const decision = parseBlock(evaluateHook(event, selectorEnv, projectRoot));
      assert.match(decision.reason, /ambiguous_protected_reference|active sessions protect/, `${lane}:${command}`);
    }
  }

  for (const command of [
    'command env pwsh.exe -NoProfile -EncodedCommand Zm9v',
    'command nohup pwsh.exe -NoProfile -Command',
    `${Array.from({ length: 9 }, () => 'command').join(' ')} pwsh.exe -NoProfile -Command "Write-Output safe"`,
  ]) {
    const decision = parseBlock(evaluateHook(
      claudeEvent('Bash', { command }, projectRoot),
      {},
      projectRoot,
    ));
    assert.match(decision.reason, /ambiguous_protected_reference/, command);
  }

  for (const command of [
    `printf '%s\\n' command env pwsh.exe pre${backtick}pare.cjs >/dev/null`,
    `echo command nohup pwsh.exe -Command pre${backtick}pare.cjs`,
  ]) {
    assert.deepEqual(
      evaluateHook(claudeEvent('Bash', { command }, projectRoot), {}, projectRoot),
      { exitCode: 0, output: '' },
      `ordinary argument text must not select a secondary shell: ${command}`,
    );
  }
}));

test('env terminators retain assignment operands before discovering the real executable', () => withProject({}, ({ projectRoot }) => {
  const backtick = String.fromCharCode(96);
  const payload = `pwsh.exe -NoProfile -Command "Set-Content -LiteralPath pre${backtick}pare.cjs -Value compromised"`;
  for (const prefix of [
    'env -- X=1',
    'env X=1 Y=2',
    'env -i -- X=1',
    'env -u OLD -- X=1',
    'command env -- X=1',
    'exec env -- X=1',
    'nohup env -- X=1',
  ]) {
    const command = `${prefix} ${payload}`;
    for (const [lane, event, selectorEnv] of [
      ['official', claudeEvent('Bash', { command }, projectRoot), {}],
      ['legacy', { command }, { CLAUDE_TOOL_USE_TOOL_NAME: 'Bash' }],
    ]) {
      const decision = parseBlock(evaluateHook(event, selectorEnv, projectRoot));
      assert.match(decision.reason, /ambiguous_protected_reference|active sessions protect/, `${lane}:${command}`);
    }
  }

  for (const command of ['env -- X=1', 'command env -- X=1']) {
    const decision = parseBlock(evaluateHook(claudeEvent('Bash', { command }, projectRoot), {}, projectRoot));
    assert.match(decision.reason, /ambiguous_protected_reference/, `missing utility:${command}`);
  }

  const ordinary = `printf '%s\\n' env -- X=1 pwsh.exe pre${backtick}pare.cjs >/dev/null`;
  assert.deepEqual(
    evaluateHook(claudeEvent('Bash', { command: ordinary }, projectRoot), {}, projectRoot),
    { exitCode: 0, output: '' },
    'env and shell words in ordinary argument positions must not select a lane',
  );
}));

test('env environment entries do not reuse shell identifier assignment grammar', () => withProject({}, ({ projectRoot }) => {
  const backtick = String.fromCharCode(96);
  const payload = `pwsh.exe -NoProfile -Command "Set-Content -LiteralPath pre${backtick}pare.cjs -Value compromised"`;
  const prefixes = [
    'env A-B=1',
    'env -- A-B=1',
    'command env 1A=1',
    'command env -- 1A=1',
    'exec env A.B=1',
    'exec env -- A.B=1',
    'nohup env 한=1',
    'nohup env -- 한=1',
    'command exec env "space name=1"',
    'command exec env -- "space name=1"',
  ];
  for (const prefix of prefixes) {
    const command = `${prefix} ${payload}`;
    for (const [lane, event, selectorEnv] of [
      ['official', claudeEvent('Bash', { command }, projectRoot), {}],
      ['legacy', { command }, { CLAUDE_TOOL_USE_TOOL_NAME: 'Bash' }],
    ]) {
      const decision = parseBlock(evaluateHook(event, selectorEnv, projectRoot));
      assert.match(decision.reason, /ambiguous_protected_reference|active sessions protect/, `${lane}:${command}`);
    }
  }

  if (fs.existsSync('/usr/bin/env') && fs.existsSync('/usr/bin/printenv')) {
    for (const entry of ['A-B=1', '1A=1', 'A.B=1', '한=1', 'space name=1']) {
      const name = entry.slice(0, entry.indexOf('='));
      for (const terminator of [[], ['--']]) {
        const result = spawnSync('/usr/bin/env', [
          ...terminator,
          entry,
          '/usr/bin/printenv',
          name,
        ], { encoding: 'utf8' });
        assert.equal(result.status, 0, `${terminator.join(' ')}:${entry}:${result.stderr}`);
        assert.equal(result.stdout, '1\n', `${terminator.join(' ')}:${entry}`);
      }
    }
  }

  for (const command of [
    'env -- A-B=1',
    'command exec env "space name=1"',
  ]) {
    const decision = parseBlock(evaluateHook(claudeEvent('Bash', { command }, projectRoot), {}, projectRoot));
    assert.match(decision.reason, /ambiguous_protected_reference/, `missing utility:${command}`);
  }

  const ordinary = `printf '%s\\n' env -- A-B=1 pwsh.exe pre${backtick}pare.cjs >/dev/null`;
  assert.deepEqual(
    evaluateHook(claudeEvent('Bash', { command: ordinary }, projectRoot), {}, projectRoot),
    { exitCode: 0, output: '' },
    'env entries and shell words in ordinary argument positions must not select a lane',
  );
}));

test('ash is an explicit POSIX shell boundary in direct and composed commands', () => withProject({}, ({ projectRoot }) => {
  const protectedPayload = "cat pre\\pare.cjs";
  for (const prefix of ['ash', 'env ash', 'command env ash', 'exec nohup ash']) {
    const command = `${prefix} -c '${protectedPayload}'`;
    for (const [lane, event, selectorEnv] of [
      ['official', claudeEvent('Bash', { command }, projectRoot), {}],
      ['legacy', { command }, { CLAUDE_TOOL_USE_TOOL_NAME: 'Bash' }],
    ]) {
      const decision = parseBlock(evaluateHook(event, selectorEnv, projectRoot));
      assert.match(decision.reason, /ambiguous_protected_reference|active sessions protect/, `${lane}:${command}`);
    }
  }

  for (const command of ['ash', 'ash -s', 'ash script.sh', 'command env ash -s']) {
    for (const [lane, event, selectorEnv] of [
      ['official', claudeEvent('Bash', { command }, projectRoot), {}],
      ['legacy', { command }, { CLAUDE_TOOL_USE_TOOL_NAME: 'Bash' }],
    ]) {
      const decision = parseBlock(evaluateHook(event, selectorEnv, projectRoot));
      assert.match(decision.reason, /ambiguous_protected_reference/, `${lane}:${command}`);
    }
  }

  for (const command of [
    `ash -c 'printf "%s\\n" safe >/dev/null'`,
    `env ash -c 'printf "%s\\n" safe >/dev/null'`,
    `printf '%s\\n' ash -c safe >/dev/null`,
  ]) {
    assert.deepEqual(
      evaluateHook(claudeEvent('Bash', { command }, projectRoot), {}, projectRoot),
      { exitCode: 0, output: '' },
      `safe visible or ordinary argument text:${command}`,
    );
  }

  const ashProbe = spawnSync('ash', ['-c', 'printf ash-ready'], { encoding: 'utf8' });
  if (!ashProbe.error) {
    assert.equal(ashProbe.status, 0, ashProbe.stderr);
    assert.equal(ashProbe.stdout, 'ash-ready');
    const reconstruction = spawnSync('ash', ['-c', 'printf %s pre\\pare.cjs'], { encoding: 'utf8' });
    assert.equal(reconstruction.status, 0, reconstruction.stderr);
    assert.equal(reconstruction.stdout, 'prepare.cjs');
  } else {
    assert.equal(ashProbe.error.code, 'ENOENT');
  }
}));

test('recognized shells fail closed when their command text is opaque or attached', () => withProject({}, ({ projectRoot }) => {
  const backtick = String.fromCharCode(96);
  for (const command of [
    'command env pwsh.exe -NoProfile -Command -',
    'exec nohup sh -s',
    'pwsh.exe -NoProfile -File script.ps1',
    'sh script.sh',
    'pwsh.exe -NoProfile',
    'cmd.exe /d',
    `cmd.exe /d /s /c"powershell.exe -NoProfile -Command Write-Output pre${backtick}pare.cjs"`,
  ]) {
    for (const [lane, event, selectorEnv] of [
      ['official', claudeEvent('Bash', { command }, projectRoot), {}],
      ['legacy', { command }, { CLAUDE_TOOL_USE_TOOL_NAME: 'Bash' }],
    ]) {
      const decision = parseBlock(evaluateHook(event, selectorEnv, projectRoot));
      assert.match(decision.reason, /ambiguous_protected_reference/, `${lane}:${command}`);
    }
  }

  for (const command of [
    `printf '%s\\n' pwsh.exe -Command - pre${backtick}pare.cjs >/dev/null`,
    `echo cmd.exe /c"pwsh.exe pre${backtick}pare.cjs"`,
  ]) {
    assert.deepEqual(
      evaluateHook(claudeEvent('Bash', { command }, projectRoot), {}, projectRoot),
      { exitCode: 0, output: '' },
      `ordinary argument text must remain non-selecting: ${command}`,
    );
  }
}));

test('secondary shell inspection fails closed at ambiguous or overflowing payload boundaries', () => withProject({}, ({ projectRoot }) => {
  for (const command of [
    'cmd.exe /d /c powershell.exe -NoProfile -EncodedCommand Zm9v',
    'cmd.exe /d /c powershell.exe -NoProfile -Encode Zm9v',
    'cmd.exe /d /c powershell.exe -NoProfile -Encoded Zm9v',
    'cmd.exe /d /c powershell.exe -NoProfile -EncodedCom Zm9v',
    'cmd.exe /d /c powershell.exe -NoProfile -Command',
    `cmd.exe /d /c powershell.exe -NoProfile -Command "cmd.exe /d /c powershell.exe -NoProfile -Command 'Write-Output safe'"`,
  ]) {
    const decision = parseBlock(evaluateHook(
      claudeEvent('Bash', { command }, projectRoot),
      {},
      projectRoot,
    ));
    assert.match(decision.reason, /ambiguous_protected_reference/, command);
  }
}));

test('POSIX wildcard mutation probe cannot change protected bytes', {
  skip: process.platform === 'win32',
}, () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const target = path.join(sessionRoot, 'prepare.cjs');
  const before = fs.readFileSync(target);
  const shellScript = `cd "${sessionRoot}" && printf compromised | tee pre?are.cjs >/dev/null`;
  const command = `sh -c '${shellScript.replaceAll("'", "'\\''")}'`;
  const guard = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(claudeEvent('Bash', { command }, projectRoot)),
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (guard.status === 0) spawnSync('sh', ['-c', shellScript], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(guard.status, 2, guard.stderr);
  assert.equal(guard.stdout, '');
  assert.match(guard.stderr, /ambiguous_protected_reference/);
  assert.deepEqual(fs.readFileSync(target), before);
}));

test('native Windows cmd caret probe cannot mutate protected bytes', {
  skip: process.platform !== 'win32',
}, () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const target = path.join(sessionRoot, 'prepare.cjs');
  const before = fs.readFileSync(target);
  const command = `cmd.exe /d /c cd /d "${sessionRoot}" && echo compromised>pre^pare.cjs`;
  const guard = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      session_id: 'native-caret-probe',
      cwd: projectRoot,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
    }),
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (guard.status === 0) {
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
      cwd: projectRoot, encoding: 'utf8', windowsHide: true,
    });
  }
  assert.equal(guard.status, 2, guard.stderr);
  assert.equal(guard.stdout, '');
  assert.match(guard.stderr, /Deep Evolve Guard/);
  assert.deepEqual(fs.readFileSync(target), before);
}));

test('native Windows PowerShell backtick probe cannot mutate protected bytes', {
  skip: process.platform !== 'win32',
}, () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const target = path.join(sessionRoot, 'prepare.cjs');
  const before = fs.readFileSync(target);
  const script = `Set-Location -LiteralPath '${sessionRoot}'; Set-Content -LiteralPath pre${String.fromCharCode(96)}pare.cjs -Value compromised`;
  const command = `powershell.exe -NoProfile -NonInteractive -Command "${script}"`;
  const guard = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(claudeEvent('Bash', { command }, projectRoot)),
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (guard.status === 0) {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: projectRoot, encoding: 'utf8', windowsHide: true,
    });
  }
  assert.equal(guard.status, 2, guard.stderr);
  assert.equal(guard.stdout, '');
  assert.match(guard.stderr, /Deep Evolve Guard/);
  assert.deepEqual(fs.readFileSync(target), before);
}));

test('native Windows PowerShell wildcard probe cannot mutate protected bytes', {
  skip: process.platform !== 'win32',
}, () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const target = path.join(sessionRoot, 'prepare.cjs');
  const before = fs.readFileSync(target);
  const script = `Set-Location -LiteralPath '${sessionRoot}'; Set-Content -Path pre?are.cjs -Value compromised`;
  const command = `powershell.exe -NoProfile -NonInteractive -Command "${script}"`;
  const guard = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(claudeEvent('Bash', { command }, projectRoot)),
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (guard.status === 0) {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: projectRoot, encoding: 'utf8', windowsHide: true,
    });
  }
  assert.equal(guard.status, 2, guard.stderr);
  assert.equal(guard.stdout, '');
  assert.match(guard.stderr, /ambiguous_protected_reference/);
  assert.deepEqual(fs.readFileSync(target), before);
}));

test('native Windows cmd to PowerShell probe cannot mutate protected bytes', {
  skip: process.platform !== 'win32',
}, () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const target = path.join(sessionRoot, 'prepare.cjs');
  const before = fs.readFileSync(target);
  const backtick = String.fromCharCode(96);
  const script = `Set-Location -LiteralPath '${sessionRoot}'; Set-Content -LiteralPath pre${backtick}pare.cjs -Value compromised`;
  const command = `cmd.exe /d /s /c powershell.exe -NoProfile -NonInteractive -Command "${script}"`;
  const guard = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(claudeEvent('Bash', { command }, projectRoot)),
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (guard.status === 0) {
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
      cwd: projectRoot, encoding: 'utf8', windowsHide: true,
    });
  }
  assert.equal(guard.status, 2, guard.stderr);
  assert.equal(guard.stdout, '');
  assert.match(guard.stderr, /ambiguous_protected_reference/);
  assert.deepEqual(fs.readFileSync(target), before);
}));

test('native Windows PowerShell to cmd legacy-envelope probe cannot mutate protected bytes', {
  skip: process.platform !== 'win32',
}, () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const target = path.join(sessionRoot, 'prepare.cjs');
  const before = fs.readFileSync(target);
  const script = `Set-Location -LiteralPath '${sessionRoot}'; cmd.exe /d /c 'echo compromised>pre^pare.cjs'`;
  const command = `powershell.exe -NoProfile -NonInteractive -Command "${script}"`;
  const selectorEnv = { ...process.env, CLAUDE_TOOL_USE_TOOL_NAME: 'Bash' };
  const guard = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ command }),
    cwd: projectRoot,
    env: selectorEnv,
    encoding: 'utf8',
  });
  if (guard.status === 0) {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: projectRoot, encoding: 'utf8', windowsHide: true,
    });
  }
  assert.equal(guard.status, 2, guard.stderr);
  assert.equal(guard.stdout, '');
  assert.match(guard.stderr, /ambiguous_protected_reference/);
  assert.deepEqual(fs.readFileSync(target), before);
}));

test('only an exact direct Node prepare.cjs command receives the shell execution exception', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const target = path.join(sessionRoot, 'prepare.cjs');
  const windowsEnv = 'C:\\Program Files\\Git\\usr\\bin\\env.exe';
  for (const launcher of ['node', 'node.exe']) {
    assert.deepEqual(evaluateHook({
      tool_name: 'Bash',
      tool_input: { command: `${launcher} "${target}"` },
    }, { DEEP_EVOLVE_META_MODE: 'prepare_update' }, projectRoot), { exitCode: 0, output: '' }, launcher);
    for (const protectedName of ['prepare.py', 'prepare-protocol.md']) {
      const command = `${launcher} "${path.join(sessionRoot, protectedName)}"`;
      const decision = parseBlock(evaluateHook({
        tool_name: 'Bash',
        tool_input: { command },
      }, { DEEP_EVOLVE_META_MODE: 'prepare_update' }, projectRoot));
      assert.match(decision.reason, /ambiguous_protected_reference/, command);
    }
  }

  for (const command of [
    `env node "${target}"`,
    `/usr/bin/env node "${target}"`,
    `"${windowsEnv}" node.exe "${target}"`,
    `command node "${target}"`,
    `exec node "${target}"`,
    `DEEP_EVOLVE_TEST=1 node "${target}"`,
    `node "${target}"; echo complete`,
    `echo ready && node "${target}"`,
    `node "${target}" || echo failed`,
    `node "${target}" | cat`,
    `cmd.exe /d /c node "${target}"`,
    `powershell.exe -NoProfile -Command "node '${target}'"`,
    `sh -c "node '${target}'"`,
    `env no""de "${target.slice(0, -4)}".cjs`,
  ]) {
    const decision = parseBlock(evaluateHook({
      tool_name: 'Bash',
      tool_input: { command },
    }, { DEEP_EVOLVE_META_MODE: 'prepare_update' }, projectRoot));
    assert.match(decision.reason, /ambiguous_protected_reference/, command);
  }
}));

test('ambiguous protected prepare shell references fail closed before prepare_update permission', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  for (const command of [
    `cat "${path.join(sessionRoot, 'prepare.cjs')}"`,
    `printf '%s' "${path.join(sessionRoot, 'prepare-protocol.md')}"`,
    `node "${path.join(sessionRoot, 'prepare.cjs')}" && echo "${path.join(sessionRoot, 'prepare.py')}"`,
    `node "${path.join(sessionRoot, 'prepare.cjs')}`,
  ]) {
    const decision = parseBlock(evaluateHook({
      tool_name: 'Bash',
      tool_input: { command },
    }, { DEEP_EVOLVE_META_MODE: 'prepare_update' }, projectRoot));
    assert.match(decision.reason, /ambiguous_protected_reference/, command);
  }
}));

test('shell classification does not alias non-target prepare-like basenames', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  for (const command of [
    `env python -c "print('notprepare.py')"`,
    `command python "${path.join(sessionRoot, 'prepare.py.bak')}"`,
    `env node "${path.join(sessionRoot, 'notprepare.cjs')}"`,
    `node "${path.join(sessionRoot, 'prepare.cjs.bak')}" && echo complete`,
  ]) {
    assert.deepEqual(evaluateHook({
      tool_name: 'Bash',
      tool_input: { command },
    }, { DEEP_EVOLVE_META_MODE: 'prepare_update' }, projectRoot), { exitCode: 0, output: '' }, command);
  }
}));

test('structured Claude prepare updates keep their Edit and Write meta-mode bypasses', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  for (const toolName of ['Edit', 'Write']) {
    assert.deepEqual(evaluateHook(
      claudeEvent(toolName, { file_path: path.join(sessionRoot, 'prepare.cjs') }, projectRoot),
      { DEEP_EVOLVE_META_MODE: 'prepare_update' },
      projectRoot,
    ), { exitCode: 0, output: '' }, toolName);
  }
}));

test('helper mode bypasses only registry writes from a known non-Bash Claude tool', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const env = { DEEP_EVOLVE_HELPER: '1' };
  assert.deepEqual(evaluateHook(
    claudeEvent('Write', { file_path: path.join(sessionRoot, 'session.yaml') }, projectRoot), env, projectRoot,
  ), { exitCode: 0, output: '' });
  parseBlock(evaluateHook(
    claudeEvent('Write', { file_path: path.join(sessionRoot, 'program.md') }, projectRoot), env, projectRoot,
  ));
}));

test('unsupported YAML fails closed only for a possibly protected target', () => withProject({ unsupported: true }, ({ projectRoot, sessionRoot }) => {
  const protectedResult = evaluateHook(
    claudeEvent('Edit', { file_path: path.join(sessionRoot, 'program.md') }, projectRoot),
    {},
    projectRoot,
  );
  assert.match(parseBlock(protectedResult).reason, /state_invalid/);
  assert.deepEqual(evaluateHook(
    claudeEvent('Edit', { file_path: path.join(projectRoot, 'src', 'unrelated.js') }, projectRoot),
    {},
    projectRoot,
  ), { exitCode: 0, output: '' });
  const splitPrepare = path.join(sessionRoot, 'prepare.cjs');
  const shellResult = evaluateHook({
    tool_name: 'Bash',
    tool_input: { command: `env node "${splitPrepare.slice(0, -4)}".cjs` },
  }, { DEEP_EVOLVE_META_MODE: 'prepare_update' }, projectRoot);
  assert.match(parseBlock(shellResult).reason, /state_invalid/);

  const child = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(claudeEvent(
      'Edit', { file_path: path.join(projectRoot, 'src', 'unrelated.js') }, projectRoot,
    )),
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /state_invalid/);
  assert.doesNotMatch(child.stderr, /\n\s*at\s|stack/i);
}));

test('ambiguous protected references fail closed without parsing or executing command text', () => withProject({}, ({ projectRoot }) => {
  const result = evaluateHook({
    tool_name: 'apply_patch',
    tool_input: { command: 'unrecognized patch syntax mentioning prepare.cjs' },
  }, {}, projectRoot);
  assert.match(parseBlock(result).reason, /ambiguous_protected_reference/);
}));

test('a drifted apply_patch event with no supported file header always fails closed', () => withProject({}, ({ projectRoot }) => {
  const result = evaluateHook({
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Rename File: src/unrelated.js\n*** End Patch' },
  }, {}, projectRoot);
  assert.match(parseBlock(result).reason, /ambiguous_protected_reference/);
}));

test('apply_patch move destinations are protected even after an unrelated recognized header', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const result = evaluateHook({
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        '*** Begin Patch',
        '*** Update File: src/unrelated.js',
        `*** Move to: ${path.join(sessionRoot, 'program.md')}`,
        '@@',
        '-before',
        '+after',
        '*** End Patch',
      ].join('\n'),
    },
  }, {}, projectRoot);
  assert.match(parseBlock(result).reason, /active sessions protect/);
}));

test('apply_patch fails closed on an unrecognized control after a recognized header', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const result = evaluateHook({
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        '*** Begin Patch',
        '*** Update File: src/unrelated.js',
        `*** Copy to: ${path.join(sessionRoot, 'program.md')}`,
        '@@',
        '-before',
        '+after',
        '*** End Patch',
      ].join('\n'),
    },
  }, {}, projectRoot);
  assert.match(parseBlock(result).reason, /ambiguous_protected_reference/);
}));

test('apply_patch protection derives paths only from headers, never diff body text', () => withProject({ unsupported: true }, ({ projectRoot }) => {
  const result = evaluateHook({
    tool_name: 'apply_patch',
    tool_input: {
      command: '*** Begin Patch\n*** Update File: src/unrelated.js\n@@\n-before\n+the text prepare.cjs is documentation\n*** End Patch',
    },
  }, {}, projectRoot);
  assert.deepEqual(result, { exitCode: 0, output: '' });
}));

test('Task 2 Codex smoke is explicitly diagnostic-only and exercises the shared handler', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const child = spawnSync(process.execPath, [
    diagnosticSmokePath,
    '--diagnose-command',
    '--project-root', projectRoot,
    '--target', path.join(sessionRoot, 'prepare.cjs'),
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result, {
    diagnostic_only: true,
    ok: true,
    guard_exit_code: 2,
    marker: 'Deep Evolve Guard',
  });
  assert.match(child.stderr, /does not prove installed-host hook registration/i);
}));

test('the extracted npm artifact runs its guard and diagnostic without stack or path leakage', () => {
  const packRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evolve packed artifact ')));
  const installRoot = path.join(packRoot, 'installed');
  fs.mkdirSync(installRoot, { recursive: true });
  const npmCli = process.env.npm_execpath;
  const runNpm = (args, options = {}) => npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], options)
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
  let project;
  try {
    const packed = runNpm(['pack', '--json', '--pack-destination', packRoot], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    });
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const packReceipt = JSON.parse(packed.stdout);
    assert.equal(packReceipt.length, 1);
    const tarball = path.join(packRoot, packReceipt[0].filename);
    const installed = runNpm([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--no-save',
      tarball,
    ], {
      cwd: installRoot,
      encoding: 'utf8',
    });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);

    const installedPlugin = path.join(installRoot, 'node_modules', '@deep-evolve', 'deep-evolve');
    const installedGuard = path.join(installedPlugin, 'hooks', 'scripts', 'protect-readonly.cjs');
    const installedSmoke = path.join(installedPlugin, 'scripts', 'smoke-installed-codex-hook.cjs');
    project = makeProject();
    const target = path.join(project.sessionRoot, 'prepare.cjs');
    const guard = spawnSync(process.execPath, [installedGuard], {
      input: JSON.stringify({
        tool_name: 'apply_patch',
        tool_input: {
          command: `*** Begin Patch\n*** Update File: ${target}\n@@\n-before\n+after\n*** End Patch`,
        },
      }),
      cwd: project.projectRoot,
      encoding: 'utf8',
    });
    assert.equal(guard.status, 2, guard.stderr || guard.stdout);
    assert.equal(guard.stdout, '');
    const guardLines = guard.stderr.trim().split(/\r?\n/);
    assert.equal(guardLines.length, 1);
    assert.match(guardLines[0], /Deep Evolve Guard/);

    const smoke = spawnSync(process.execPath, [
      installedSmoke,
      '--diagnose-command',
      '--project-root', project.projectRoot,
      '--target', target,
    ], {
      cwd: project.projectRoot,
      encoding: 'utf8',
    });
    assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
    assert.equal(smoke.stdout.trim().split(/\r?\n/).length, 1);
    assert.deepEqual(JSON.parse(smoke.stdout), {
      diagnostic_only: true,
      ok: true,
      guard_exit_code: 2,
      marker: 'Deep Evolve Guard',
    });
    const combinedOutput = `${guard.stdout}\n${guard.stderr}\n${smoke.stdout}\n${smoke.stderr}`;
    assert.doesNotMatch(combinedOutput, /\n\s*at\s|MODULE_NOT_FOUND|require stack|stack trace/i);
    assert.doesNotMatch(combinedOutput, new RegExp(packRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(combinedOutput, new RegExp(project.projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    if (project) project.cleanup();
    fs.rmSync(packRoot, { recursive: true, force: true });
  }
});

test('the Unix compatibility wrapper delegates to the same Node decision', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const input = JSON.stringify(claudeEvent(
    'Edit', { file_path: path.join(sessionRoot, 'program.md') }, projectRoot,
  ));
  const env = process.env;
  const direct = spawnSync(process.execPath, [hookPath], { input, cwd: projectRoot, env, encoding: 'utf8' });
  const wrapped = spawnSync('sh', [legacyWrapperPath], { input, cwd: projectRoot, env, encoding: 'utf8' });
  assert.equal(wrapped.status, direct.status, wrapped.stderr);
  assert.equal(wrapped.stdout, direct.stdout);
  assert.equal(wrapped.stderr, direct.stderr);
}));

test('malformed input emits one valid decision without a stack trace', () => withProject({}, ({ projectRoot }) => {
  const libraryResult = evaluateHook(null, {}, projectRoot);
  assert.match(parseBlock(libraryResult).reason, /malformed_input/);

  const child = spawnSync(process.execPath, [hookPath], {
    input: '{not json',
    cwd: projectRoot,
    encoding: 'utf8',
  });
  assert.equal(child.status, 2);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /malformed_input/);
  assert.doesNotMatch(`${child.stdout}\n${child.stderr}`, /\n\s*at\s|SyntaxError|stack/i);
}));

test('present malformed official envelope keys cannot fall through stale legacy selectors', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  const protectedPath = path.join(sessionRoot, 'program.md');
  const variants = [
    { tool_name: null, tool_input: { file_path: protectedPath } },
    { tool_name: 42, tool_input: { file_path: protectedPath } },
    { tool_name: {}, tool_input: { file_path: protectedPath } },
    { tool_name: [], tool_input: { file_path: protectedPath } },
    { tool_input: { file_path: protectedPath } },
  ];
  for (const variant of variants) {
    const event = { ...variant, file_path: protectedPath };
    const env = { CLAUDE_TOOL_USE_TOOL_NAME: 'Read', CLAUDE_TOOL_NAME: 'Read' };
    const decision = parseBlock(evaluateHook(event, env, projectRoot));
    assert.match(decision.reason, /malformed_input/, JSON.stringify(variant));

    const child = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(event),
      cwd: projectRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    assert.equal(child.status, 2, JSON.stringify(variant));
    assert.equal(child.stdout, '', JSON.stringify(variant));
    assert.match(child.stderr, /malformed_input/, JSON.stringify(variant));
  }
}));

test('executable exit-2 blocks use stderr only so both hosts receive the guard reason', () => withProject({}, ({ projectRoot, sessionRoot }) => {
  for (const [toolName, toolInput, env] of [
    ['Write', { file_path: path.join(sessionRoot, 'program.md'), content: 'changed' }, {}],
    ['Edit', { file_path: path.join(sessionRoot, 'strategy.yaml'), old_string: 'x', new_string: 'y' }, {}],
    ['MultiEdit', { file_path: path.join(sessionRoot, 'worktrees', 'seed_1', 'program.md'), edits: [] }, {}],
    ['Bash', { command: `cat "${path.join(sessionRoot, 'prepare.cjs')}"` }, { DEEP_EVOLVE_SEAL_PREPARE: '1' }],
  ]) {
    const child = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        session_id: `host-channel-${toolName}`,
        cwd: projectRoot,
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput,
      }),
      cwd: projectRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    assert.equal(child.status, 2, toolName);
    assert.equal(child.stdout, '', toolName);
    assert.match(child.stderr, /Deep Evolve Guard/, toolName);
    assert.doesNotMatch(child.stderr, /\n\s*at\s|stack/i, toolName);
  }
}));

test('real Claude no-state executable envelope allows unrelated work silently', () => {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evolve hook executable no state ')));
  try {
    const child = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        session_id: 'host-no-state',
        cwd: projectRoot,
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(projectRoot, 'src', 'unrelated.js') },
      }),
      cwd: projectRoot,
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, '');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
