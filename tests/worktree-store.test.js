'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const RUNTIME = path.resolve(__dirname, '..', 'hooks', 'scripts', 'deep-evolve-runtime.cjs');
const BASH_ORACLE = path.resolve(__dirname, '..', 'legacy', 'session-helper-v3.4.3.sh');

const {
  createSeedWorktree,
  validateSeedWorktree,
  removeSeedWorktree,
  createSynthesisWorktree,
  cleanupFailedSynthesisWorktree,
  backtrackArchive,
  validateRecoveryBundle,
  saveStrategyArchive,
  restoreStrategyArchive,
  forkStrategyArchive,
  selectBacktrack,
  selectStrategyFork,
} = require('../hooks/scripts/runtime/worktree-store.cjs');

function git(cwd, args, options = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    shell: false,
  });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

function repository() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'deep evolve task5 '));
  const projectRoot = path.join(parent, 'project with spaces');
  fs.mkdirSync(projectRoot);
  git(projectRoot, ['init', '-q']);
  git(projectRoot, ['config', 'user.email', 'task5@example.invalid']);
  git(projectRoot, ['config', 'user.name', 'Task Five']);
  fs.writeFileSync(path.join(projectRoot, 'tracked.txt'), 'base text\n');
  fs.writeFileSync(path.join(projectRoot, 'staged.txt'), 'base staged\n');
  fs.writeFileSync(path.join(projectRoot, 'tracked.bin'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(projectRoot, 'staged.bin'), Buffer.from([4, 5, 6, 7]));
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-qm', 'initial']);
  const baseline = git(projectRoot, ['rev-parse', 'HEAD']).trim();
  const sessionId = 'session-space';
  const sessionRoot = path.join(projectRoot, '.deep-evolve', sessionId);
  fs.mkdirSync(sessionRoot, { recursive: true });
  return { parent, projectRoot, sessionRoot, sessionId, baseline };
}

function recordingSpawn(log) {
  return (command, args, options) => {
    log.push({ command, args: [...args], options: { ...options } });
    return spawnSync(command, args, options);
  };
}

function seedOptions(repo, seedId = 1, extra = {}) {
  return {
    projectRoot: repo.projectRoot,
    sessionRoot: repo.sessionRoot,
    sessionId: repo.sessionId,
    seedId,
    ...extra,
  };
}

function synthesisOptions(repo, extra = {}) {
  return {
    projectRoot: repo.projectRoot,
    sessionRoot: repo.sessionRoot,
    sessionId: repo.sessionId,
    baselineCommit: repo.baseline,
    ...extra,
  };
}

function validateSeedCliPair(repo, preDispatchHead) {
  const args = ['validate_seed_worktree', '1'];
  if (preDispatchHead) args.push(preDispatchHead);
  const options = {
    cwd: repo.projectRoot,
    env: {
      ...process.env,
      SESSION_ROOT: repo.sessionRoot,
      SESSION_ID: repo.sessionId,
    },
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
  };
  return {
    node: spawnSync(process.execPath, [RUNTIME, '--legacy-session-helper', ...args], options),
    bash: spawnSync('bash', [BASH_ORACLE, ...args], options),
  };
}

function makeDirty(repo) {
  const worktree = path.join(repo.sessionRoot, 'worktrees', 'synthesis');
  fs.writeFileSync(path.join(worktree, 'tracked.txt'), 'unstaged text\n');
  fs.writeFileSync(path.join(worktree, 'tracked.bin'), Buffer.from([0, 255, 9, 0, 8]));
  fs.writeFileSync(path.join(worktree, 'staged.txt'), 'staged text\n');
  fs.writeFileSync(path.join(worktree, 'staged.bin'), Buffer.from([4, 0, 250, 7, 1]));
  git(worktree, ['add', 'staged.txt', 'staged.bin']);
  const nested = path.join(worktree, 'untracked dir');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'bytes.bin'), Buffer.from([0, 10, 13, 255, 128]));
  return {
    worktree,
    status: spawnSync('git', ['-C', worktree, 'status', '--porcelain=v1', '-z'], {
      encoding: null,
      shell: false,
    }).stdout,
  };
}

test('real Git seed lifecycle handles paths with spaces, collisions, validation, scratch, and off-branch commits', () => {
  const repo = repository();
  const calls = [];
  const spawn = recordingSpawn(calls);
  const created = createSeedWorktree(seedOptions(repo, 1, { spawnSync: spawn }));
  assert.equal(created.branch, 'evolve/session-space/seed-1');
  assert.equal(created.worktree_path, path.join(fs.realpathSync(repo.sessionRoot), 'worktrees', 'seed_1'));
  assert.equal(validateSeedWorktree(seedOptions(repo, 1, { spawnSync: spawn })).clean, true);

  for (const name of ['.deep-evolve', '.deep-docs', '.deep-review', '.serena']) {
    fs.mkdirSync(path.join(created.worktree_path, name), { recursive: true });
    fs.writeFileSync(path.join(created.worktree_path, name, 'scratch'), 'ok');
  }
  assert.equal(validateSeedWorktree(seedOptions(repo, 1, { spawnSync: spawn })).clean, true);
  assert.throws(() => createSeedWorktree(seedOptions(repo, 1)), /exist/i);

  git(created.worktree_path, ['checkout', '-qb', 'wrong-branch']);
  assert.throws(() => validateSeedWorktree(seedOptions(repo, 1)), /branch|expected/i);
  assert.ok(calls.length > 0);
  for (const call of calls) assert.equal(call.options.shell, false, JSON.stringify(call));
});

test('legacy validate_seed_worktree maps stable error codes without inspecting error messages', () => {
  const source = fs.readFileSync(RUNTIME, 'utf8');
  const start = source.indexOf('function runTask5Legacy');
  const end = source.indexOf('\nfunction runNativeLegacy', start);
  const adapter = source.slice(start, end);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.doesNotMatch(adapter, /\.test\(error\.message\)/);
  for (const [code, exitCode] of [
    ['worktree_missing', 3],
    ['worktree_off_branch', 4],
    ['worktree_dirty', 5],
    ['worktree_history_rewritten', 6],
  ]) {
    assert.match(adapter, new RegExp(`${code}[^\\n]{0,120}${exitCode}`), code);
  }
});

test('Node legacy validator matches Bash rc 3 for a missing seed worktree', {
  skip: process.platform === 'win32' ? 'the frozen Bash oracle is Unix-only' : false,
}, () => {
  const repo = repository();
  try {
    const result = validateSeedCliPair(repo);
    assert.equal(result.bash.status, 3, result.bash.stderr);
    assert.equal(result.node.status, result.bash.status, result.node.stderr);
  } finally {
    fs.rmSync(repo.parent, { recursive: true, force: true });
  }
});

test('Node legacy validator matches Bash rc 4 for an off-branch seed worktree', {
  skip: process.platform === 'win32' ? 'the frozen Bash oracle is Unix-only' : false,
}, () => {
  const repo = repository();
  try {
    const created = createSeedWorktree(seedOptions(repo));
    git(created.worktree_path, ['checkout', '-qb', 'other']);
    const result = validateSeedCliPair(repo);
    assert.equal(result.bash.status, 4, result.bash.stderr);
    assert.equal(result.node.status, result.bash.status, result.node.stderr);
  } finally {
    fs.rmSync(repo.parent, { recursive: true, force: true });
  }
});

test('Node legacy validator matches Bash rc 4 for a detached seed worktree', {
  skip: process.platform === 'win32' ? 'the frozen Bash oracle is Unix-only' : false,
}, () => {
  const repo = repository();
  try {
    const created = createSeedWorktree(seedOptions(repo));
    git(created.worktree_path, ['checkout', '--detach', '--quiet']);
    const result = validateSeedCliPair(repo);
    assert.equal(result.bash.status, 4, result.bash.stderr);
    assert.equal(result.node.status, result.bash.status, result.node.stderr);
  } finally {
    fs.rmSync(repo.parent, { recursive: true, force: true });
  }
});

test('Node legacy validator matches Bash rc 5 for a dirty seed worktree', {
  skip: process.platform === 'win32' ? 'the frozen Bash oracle is Unix-only' : false,
}, () => {
  const repo = repository();
  try {
    const created = createSeedWorktree(seedOptions(repo));
    fs.writeFileSync(path.join(created.worktree_path, 'dirty.txt'), 'dirty\n');
    const result = validateSeedCliPair(repo);
    assert.equal(result.bash.status, 5, result.bash.stderr);
    assert.equal(result.node.status, result.bash.status, result.node.stderr);
  } finally {
    fs.rmSync(repo.parent, { recursive: true, force: true });
  }
});

test('Node legacy validator matches Bash rc 6 for rewritten seed history', {
  skip: process.platform === 'win32' ? 'the frozen Bash oracle is Unix-only' : false,
}, () => {
  const repo = repository();
  try {
    createSeedWorktree(seedOptions(repo));
    fs.writeFileSync(path.join(repo.projectRoot, 'main-only.txt'), 'main advance\n');
    git(repo.projectRoot, ['add', 'main-only.txt']);
    git(repo.projectRoot, ['commit', '-qm', 'main advance']);
    const preDispatchHead = git(repo.projectRoot, ['rev-parse', 'HEAD']).trim();
    const result = validateSeedCliPair(repo, preDispatchHead);
    assert.equal(result.bash.status, 6, result.bash.stderr);
    assert.equal(result.node.status, result.bash.status, result.node.stderr);
  } finally {
    fs.rmSync(repo.parent, { recursive: true, force: true });
  }
});

test('seed create preserves pre-existing branches and blocking worktree paths', () => {
  const repo = repository();
  const branch = 'evolve/session-space/seed-7';
  git(repo.projectRoot, ['branch', branch, repo.baseline]);
  const target = path.join(repo.sessionRoot, 'worktrees', 'seed_7');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'operator bytes');
  assert.throws(() => createSeedWorktree(seedOptions(repo, 7)), /branch|exist|collision/i);
  assert.equal(git(repo.projectRoot, ['rev-parse', branch]).trim(), repo.baseline);
  assert.equal(fs.readFileSync(target, 'utf8'), 'operator bytes');
});

test('failed worktree creation never deletes a branch won by a concurrent creator', () => {
  const repo = repository();
  const cases = [
    {
      branch: 'evolve/session-space/seed-8',
      run: (spawn) => createSeedWorktree(seedOptions(repo, 8, { spawnSync: spawn })),
    },
    {
      branch: 'evolve/session-space/synthesis',
      run: (spawn) => createSynthesisWorktree(synthesisOptions(repo, { spawnSync: spawn })),
    },
  ];
  for (const entry of cases) {
    let injected = false;
    const spawn = (command, args, options) => {
      if (!injected && args.includes('worktree') && args.includes('add')) {
        injected = true;
        git(repo.projectRoot, ['branch', entry.branch, repo.baseline]);
        return { status: 128, stdout: '', stderr: 'injected concurrent branch winner' };
      }
      return spawnSync(command, args, options);
    };
    assert.throws(() => entry.run(spawn), /injected concurrent branch winner/);
    assert.equal(git(repo.projectRoot, ['rev-parse', entry.branch]).trim(), repo.baseline);
    git(repo.projectRoot, ['branch', '-D', entry.branch]);
  }
});

test('seed remove is idempotent and prunes a manually deleted worktree registration without deleting its branch', () => {
  const repo = repository();
  const created = createSeedWorktree(seedOptions(repo, 2));
  fs.rmSync(created.worktree_path, { recursive: true, force: true });
  const first = removeSeedWorktree(seedOptions(repo, 2));
  assert.equal(first.removed, false);
  assert.equal(first.pruned, true);
  assert.equal(removeSeedWorktree(seedOptions(repo, 2)).removed, false);
  assert.equal(git(repo.projectRoot, ['rev-parse', created.branch]).trim(), repo.baseline);
});

test('seed validation accepts descendants and rejects rewritten off-branch history', () => {
  const repo = repository();
  const created = createSeedWorktree(seedOptions(repo, 3));
  const before = git(created.worktree_path, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(created.worktree_path, 'descendant.txt'), 'x');
  git(created.worktree_path, ['add', 'descendant.txt']);
  git(created.worktree_path, ['commit', '-qm', 'descendant']);
  assert.equal(validateSeedWorktree(seedOptions(repo, 3, { preDispatchHead: before })).clean, true);

  const tree = git(repo.projectRoot, ['rev-parse', `${before}^{tree}`]).trim();
  const rewritten = spawnSync('git', ['-C', repo.projectRoot, 'commit-tree', tree, '-m', 'parallel root'], {
    encoding: 'utf8', shell: false,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Task', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Task', GIT_COMMITTER_EMAIL: 't@t' },
  });
  assert.equal(rewritten.status, 0, rewritten.stderr);
  git(repo.projectRoot, ['update-ref', `refs/heads/${created.branch}`, rewritten.stdout.trim()]);
  assert.throws(() => validateSeedWorktree(seedOptions(repo, 3, { preDispatchHead: before })), /descendant|history/i);
});

test('synthesis creation rejects branch/path collisions and creates from the exact baseline', () => {
  const repo = repository();
  const created = createSynthesisWorktree(synthesisOptions(repo));
  assert.equal(git(created.worktree_path, ['rev-parse', 'HEAD']).trim(), repo.baseline);
  assert.throws(() => createSynthesisWorktree(synthesisOptions(repo)), /exist/i);

  spawnSync('git', ['-C', repo.projectRoot, 'worktree', 'remove', '--force', created.worktree_path], { shell: false });
  assert.throws(() => createSynthesisWorktree(synthesisOptions(repo)), /branch|exist/i);
});

test('dirty synthesis cleanup writes a ready checksummed reconstructable bundle before removal and never commits dirt', () => {
  const repo = repository();
  createSynthesisWorktree(synthesisOptions(repo));
  const dirty = makeDirty(repo);
  const beforeHead = git(dirty.worktree, ['rev-parse', 'HEAD']).trim();
  const result = cleanupFailedSynthesisWorktree(synthesisOptions(repo, {
    now: () => Date.parse('2026-07-13T01:02:03Z'),
    randomUUID: () => 'fixed-cleanup-nonce',
  }));
  assert.equal(result.cleaned, true);
  assert.equal(fs.existsSync(dirty.worktree), false);
  assert.match(result.failed_branch, /^evolve\/session-space\/synthesis-failed-/);
  assert.equal(git(repo.projectRoot, ['rev-parse', result.failed_branch]).trim(), beforeHead);

  const manifestPath = path.join(result.recovery_path, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.ready, true);
  assert.equal(manifest.phase, 'ready');
  assert.equal(manifest.cleanup_nonce, 'fixed-cleanup-nonce');
  assert.equal(manifest.base_commit, beforeHead);
  assert.equal(
    Buffer.from(manifest.status_porcelain_v1_z_base64, 'base64').equals(dirty.status),
    true,
    `${Buffer.from(manifest.status_porcelain_v1_z_base64, 'base64').toString('hex')} != ${dirty.status.toString('hex')}`,
  );
  for (const [name, record] of Object.entries(manifest.artifacts)) {
    const bytes = fs.readFileSync(path.join(result.recovery_path, record.path));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), record.sha256, name);
  }
  assert.equal(validateRecoveryBundle(result.recovery_path, { projectRoot: repo.projectRoot }).valid, true);
});

for (const phase of ['bundle:create', 'artifact:fsync', 'manifest:commit']) {
  test(`dirty cleanup failure at ${phase} leaves the original worktree and branch untouched`, () => {
    const repo = repository();
    createSynthesisWorktree(synthesisOptions(repo));
    const { worktree } = makeDirty(repo);
    assert.throws(() => cleanupFailedSynthesisWorktree(synthesisOptions(repo, {
      randomUUID: () => `failure-${phase.replace(':', '-')}`,
      onPhase(current) { if (current === phase) throw new Error(`injected ${phase}`); },
    })), /injected/);
    assert.equal(fs.existsSync(worktree), true);
    assert.equal(git(repo.projectRoot, ['rev-parse', '--verify', 'refs/heads/evolve/session-space/synthesis']).trim(), repo.baseline);
    const recovery = path.join(repo.sessionRoot, 'synthesis-recovery');
    const ready = fs.existsSync(recovery)
      ? fs.readdirSync(recovery).some((name) => {
        const p = path.join(recovery, name, 'manifest.json');
        return fs.existsSync(p) && JSON.parse(fs.readFileSync(p)).ready === true;
      })
      : false;
    assert.equal(ready, false);
  });
}

test('worktree-removal failure retains both the original and a durable ready recovery bundle', () => {
  const repo = repository();
  createSynthesisWorktree(synthesisOptions(repo));
  const { worktree } = makeDirty(repo);
  let recoveryPath;
  assert.throws(() => cleanupFailedSynthesisWorktree(synthesisOptions(repo, {
    randomUUID: () => 'remove-failure',
    onPhase(phase, context) {
      if (context && context.recoveryPath) recoveryPath = context.recoveryPath;
      if (phase === 'worktree:remove') throw new Error('injected worktree remove');
    },
  })), /injected worktree remove/);
  assert.equal(fs.existsSync(worktree), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(recoveryPath, 'manifest.json')));
  assert.equal(manifest.ready, true);
  assert.equal(validateRecoveryBundle(recoveryPath, { projectRoot: repo.projectRoot }).valid, true);
});

test('dirty state added at the removal seam aborts cleanup and preserves the worktree plus ready bundle', () => {
  const repo = repository();
  createSynthesisWorktree(synthesisOptions(repo));
  const { worktree } = makeDirty(repo);
  let recoveryPath;
  assert.throws(() => cleanupFailedSynthesisWorktree(synthesisOptions(repo, {
    randomUUID: () => 'late-dirt',
    onPhase(phase, context) {
      if (context && context.recoveryPath) recoveryPath = context.recoveryPath;
      if (phase === 'worktree:remove') fs.writeFileSync(path.join(worktree, 'late.txt'), 'late bytes');
    },
  })), /changed|recovery/i);
  assert.equal(fs.existsSync(path.join(worktree, 'late.txt')), true);
  assert.equal(git(repo.projectRoot, ['rev-parse', '--verify', 'refs/heads/evolve/session-space/synthesis']).trim(), repo.baseline);
  assert.equal(JSON.parse(fs.readFileSync(path.join(recoveryPath, 'manifest.json'))).ready, true);
});

test('branch-removal failure retains the ready bundle and resume completes deterministically', () => {
  const repo = repository();
  createSynthesisWorktree(synthesisOptions(repo));
  makeDirty(repo);
  assert.throws(() => cleanupFailedSynthesisWorktree(synthesisOptions(repo, {
    randomUUID: () => 'branch-failure',
    onPhase(phase) { if (phase === 'branch:remove') throw new Error('injected branch remove'); },
  })), /injected branch remove/);
  assert.equal(fs.existsSync(path.join(repo.sessionRoot, 'worktrees', 'synthesis')), false);
  assert.equal(git(repo.projectRoot, ['rev-parse', '--verify', 'refs/heads/evolve/session-space/synthesis']).trim(), repo.baseline);
  const resumed = cleanupFailedSynthesisWorktree(synthesisOptions(repo, {
    now: () => Date.parse('2026-07-13T01:02:03Z'),
    randomUUID: () => 'branch-failure',
  }));
  assert.equal(resumed.cleaned, true);
  assert.equal(resumed.resumed, true);
  assert.match(resumed.failed_branch, /synthesis-failed/);
});

test('resume refuses a tampered ready bundle and preserves the synthesis branch', () => {
  const repo = repository();
  createSynthesisWorktree(synthesisOptions(repo));
  makeDirty(repo);
  let recoveryPath;
  assert.throws(() => cleanupFailedSynthesisWorktree(synthesisOptions(repo, {
    randomUUID: () => 'tampered-resume',
    onPhase(phase, context) {
      if (context && context.recoveryPath) recoveryPath = context.recoveryPath;
      if (phase === 'branch:remove') throw new Error('injected branch remove');
    },
  })), /injected branch remove/);
  fs.appendFileSync(path.join(recoveryPath, 'staged.patch'), 'tampered');

  assert.throws(() => cleanupFailedSynthesisWorktree(synthesisOptions(repo)), /recovery (?:size|checksum) mismatch/);
  assert.equal(
    git(repo.projectRoot, ['rev-parse', '--verify', 'refs/heads/evolve/session-space/synthesis']).trim(),
    repo.baseline,
  );
});

test('dirty cleanup rejects a symlinked recovery root before writing or removing state', () => {
  const repo = repository();
  createSynthesisWorktree(synthesisOptions(repo));
  const { worktree } = makeDirty(repo);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-evolve-outside-recovery-'));
  fs.symlinkSync(outside, path.join(repo.sessionRoot, 'synthesis-recovery'));

  assert.throws(() => cleanupFailedSynthesisWorktree(synthesisOptions(repo)), /recovery parent.*regular directory/i);
  assert.equal(fs.existsSync(worktree), true);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(
    git(repo.projectRoot, ['rev-parse', '--verify', 'refs/heads/evolve/session-space/synthesis']).trim(),
    repo.baseline,
  );
});

test('a prior ready bundle is never reused for a later synthesis worktree with different dirt', () => {
  const repo = repository();
  createSynthesisWorktree(synthesisOptions(repo));
  makeDirty(repo);
  const first = cleanupFailedSynthesisWorktree(synthesisOptions(repo, { randomUUID: () => 'first-ready' }));

  createSynthesisWorktree(synthesisOptions(repo));
  const secondDirty = makeDirty(repo);
  fs.writeFileSync(path.join(secondDirty.worktree, 'tracked.txt'), 'different second synthesis bytes\n');
  const second = cleanupFailedSynthesisWorktree(synthesisOptions(repo, { randomUUID: () => 'second-ready' }));
  assert.notEqual(second.recovery_path, first.recovery_path);
  assert.equal(path.basename(second.recovery_path), 'second-ready');
  assert.equal(validateRecoveryBundle(second.recovery_path, { projectRoot: repo.projectRoot }).valid, true);
});

test('orphan synthesis branches are renamed and fixed-clock cleanups use unique suffixes', () => {
  const repo = repository();
  git(repo.projectRoot, ['branch', 'evolve/session-space/synthesis', repo.baseline]);
  const first = cleanupFailedSynthesisWorktree(synthesisOptions(repo, {
    now: () => Date.parse('2026-07-13T01:02:03Z'), randomUUID: () => 'same',
  }));
  createSynthesisWorktree(synthesisOptions(repo));
  const second = cleanupFailedSynthesisWorktree(synthesisOptions(repo, {
    now: () => Date.parse('2026-07-13T01:02:03Z'), randomUUID: () => 'same',
  }));
  assert.notEqual(first.failed_branch, second.failed_branch);
  assert.equal(first.orphan, true);
});

test('archive selectors and atomic save/restore preserve deterministic scores and exact bytes', () => {
  const repo = repository();
  const candidates = [
    { id: 'keep_2', commit: 'b', score: 0.9, children_explored: 6 },
    { id: 'keep_1', commit: 'a', score: 0.8, children_explored: 0 },
  ];
  assert.equal(selectBacktrack(candidates, 'least_explored').id, 'keep_1');
  assert.equal(selectBacktrack(candidates, 'highest_score').id, 'keep_1');
  assert.equal(selectStrategyFork([{ generation: 1, Q: 0.8, children_count: 0 }, { generation: 2, Q: 1, children_count: 4 }]).generation, 1);
  assert.equal(selectBacktrack([
    { id: 'alpha', commit: 'a', score: 1, children_explored: 0 },
    { id: 'Zeta', commit: 'b', score: 1, children_explored: 0 },
  ]).id, 'Zeta');

  const saved = saveStrategyArchive({
    sessionRoot: repo.sessionRoot, generation: 2,
    strategyText: 'strategy bytes\n', programText: 'program bytes\n',
    metrics: { Q: 0.7, keep_rate: 0.5, experiments: '1-3', epoch: 2, parent: 'gen_1', children_count: 0 },
  });
  fs.writeFileSync(path.join(repo.sessionRoot, 'strategy.yaml'), 'changed');
  fs.writeFileSync(path.join(repo.sessionRoot, 'program.md'), 'changed');
  restoreStrategyArchive({ sessionRoot: repo.sessionRoot, generation: 2 });
  assert.equal(fs.readFileSync(path.join(repo.sessionRoot, 'strategy.yaml'), 'utf8'), 'strategy bytes\n');
  assert.equal(fs.readFileSync(path.join(repo.sessionRoot, 'program.md'), 'utf8'), 'program bytes\n');
  assert.equal(saved.generation, 2);
  const forked = forkStrategyArchive({
    sessionRoot: repo.sessionRoot,
    generations: [{ generation: 2, Q: 0.7, children_count: 0 }],
  });
  assert.equal(forked.selected.generation, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(saved.archive_path, 'metrics.json'))).children_count, 1);
});

test('strategy archive rejects a symlinked archive root without writing outside the session', () => {
  const repo = repository();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-evolve-outside-strategy-'));
  fs.symlinkSync(outside, path.join(repo.sessionRoot, 'strategy-archive'));

  assert.throws(() => saveStrategyArchive({
    sessionRoot: repo.sessionRoot,
    generation: 1,
    strategyText: 'strategy bytes\n',
    programText: 'program bytes\n',
    metrics: { Q: 0.7, children_count: 0 },
  }), /strategy archive root.*regular directory/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('code-archive backtrack checks out a named fork, marks the parent, and appends program context', () => {
  const repo = repository();
  const keepRoot = path.join(repo.sessionRoot, 'code-archive', 'keep_001');
  fs.mkdirSync(keepRoot, { recursive: true });
  const metadataPath = path.join(keepRoot, 'metadata.json');
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    commit: repo.baseline, score: 0.8, description: 'old direction', children_explored: 0,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(repo.sessionRoot, 'program.md'), 'base program\n');
  const calls = [];
  let state;
  const initialBranch = git(repo.projectRoot, ['branch', '--show-current']).trim();
  const result = backtrackArchive({
    projectRoot: repo.projectRoot,
    sessionRoot: repo.sessionRoot,
    sessionId: repo.sessionId,
    candidates: [{
      id: 'keep_001', commit: repo.baseline, score: 0.8, description: 'old direction',
      children_explored: 0, metadata_path: metadataPath,
    }],
    strategy: 'highest_score',
    programContext: 'Try a different direction.',
    spawnSync: recordingSpawn(calls),
    commitState(value) { state = value; },
  });
  assert.equal(result.branch, 'evolve/session-space/fork-001');
  assert.equal(git(repo.projectRoot, ['branch', '--show-current']).trim(), result.branch);
  assert.equal(JSON.parse(fs.readFileSync(metadataPath)).children_explored, 1);
  assert.match(fs.readFileSync(path.join(repo.sessionRoot, 'program.md'), 'utf8'), /Try a different direction\./);
  assert.equal(state.selected.id, 'keep_001');
  assert.equal(state.previous_branch, initialBranch);
  for (const call of calls) assert.equal(call.options.shell, false, JSON.stringify(call));
});

test('code-archive backtrack rolls Git and archive bytes back when state commit fails', () => {
  const repo = repository();
  const keepRoot = path.join(repo.sessionRoot, 'code-archive', 'keep_001');
  fs.mkdirSync(keepRoot, { recursive: true });
  const metadataPath = path.join(keepRoot, 'metadata.json');
  const metadata = `${JSON.stringify({ commit: repo.baseline, score: 0.8, children_explored: 0 }, null, 2)}\n`;
  fs.writeFileSync(metadataPath, metadata);
  fs.writeFileSync(path.join(repo.sessionRoot, 'program.md'), 'base program\n');
  const initialBranch = git(repo.projectRoot, ['branch', '--show-current']).trim();
  assert.throws(() => backtrackArchive({
    projectRoot: repo.projectRoot,
    sessionRoot: repo.sessionRoot,
    sessionId: repo.sessionId,
    candidates: [{ id: 'keep_001', commit: repo.baseline, score: 0.8, children_explored: 0, metadata_path: metadataPath }],
    commitState() { throw new Error('injected state commit'); },
  }), /injected state commit/);
  assert.equal(git(repo.projectRoot, ['branch', '--show-current']).trim(), initialBranch);
  assert.equal(fs.readFileSync(metadataPath, 'utf8'), metadata);
  assert.equal(fs.readFileSync(path.join(repo.sessionRoot, 'program.md'), 'utf8'), 'base program\n');
  const branch = spawnSync('git', ['-C', repo.projectRoot, 'rev-parse', '--verify', '--quiet', 'refs/heads/evolve/session-space/fork-001'], {
    encoding: 'utf8', shell: false,
  });
  assert.equal(branch.status, 1);
});
