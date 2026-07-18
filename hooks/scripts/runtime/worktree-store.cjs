'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync: defaultSpawnSync } = require('node:child_process');
const {
  atomicWriteFile,
  syncRenamedDirectoryBestEffort,
  withDirectoryLock,
} = require('./session-store.cjs');
const { parseStateDocument, serializeStateDocument } = require('./session-codec.cjs');

const SCRATCH_DIRECTORIES = new Set(['.deep-evolve', '.deep-docs', '.deep-review', '.serena']);

function runtimeError(code, message, rc = 2, details) {
  return Object.assign(new Error(message), { code, rc, ...(details === undefined ? {} : { details }) });
}

function compareText(left, right) {
  const a = Array.from(String(left), (value) => value.codePointAt(0));
  const b = Array.from(String(right), (value) => value.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw runtimeError('invalid_field_type', `${label} must be a non-empty string`);
  }
  return value;
}

function requireDirectory(value, label, missingCode = `${label}_missing`) {
  requireString(value, label);
  let stat;
  try { stat = fs.lstatSync(value); }
  catch { throw runtimeError(missingCode, `${label} does not exist: ${value}`); }
  if (stat.isSymbolicLink()) throw runtimeError(`${label}_symlink`, `${label} must not be a symlink: ${value}`);
  if (!stat.isDirectory()) throw runtimeError(`${label}_invalid`, `${label} must be a directory: ${value}`);
  return fs.realpathSync(value);
}

function requireSeedId(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw runtimeError('invalid_seed_id', 'seedId must be a positive integer');
  }
  return value;
}

function commandResult(result, label, allowed = [0]) {
  if (result && typeof result.status === 'number' && allowed.includes(result.status)) return result;
  const stderr = result && result.stderr != null ? String(result.stderr).trim() : '';
  throw runtimeError('git_failed', `${label} failed${stderr ? `: ${stderr}` : ''}`);
}

function git(projectRoot, args, options = {}) {
  const spawn = options.spawnSync || defaultSpawnSync;
  const encoding = Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8';
  return spawn('git', ['-C', projectRoot, ...args], {
    encoding,
    input: options.input,
    stdio: options.stdio,
    shell: false,
  });
}

function gitOk(projectRoot, args, options = {}) {
  return commandResult(git(projectRoot, args, options), `git ${args.join(' ')}`);
}

function branchExists(projectRoot, branch, options = {}) {
  const result = git(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], options);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  commandResult(result, `inspect branch ${branch}`);
  return false;
}

function targetCollision(target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function requireRegularDirectoryPath(directory, label, { create = false, code = 'directory_invalid' } = {}) {
  let stat = targetCollision(directory);
  if (!stat && create) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    stat = targetCollision(directory);
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw runtimeError(code, `${label} must be a regular directory: ${directory}`);
  }
  return directory;
}

function ensureWorktreeParent(target) {
  const parent = path.dirname(target);
  const collision = targetCollision(parent);
  if (collision && !collision.isDirectory()) {
    throw runtimeError('worktree_parent_collision', `worktree parent is not a directory: ${parent}`, 1);
  }
  fs.mkdirSync(parent, { recursive: true });
}

function createSeedWorktree(options) {
  const projectRoot = requireDirectory(options.projectRoot, 'projectRoot');
  const sessionRoot = requireDirectory(options.sessionRoot, 'sessionRoot');
  const sessionId = requireString(options.sessionId, 'sessionId');
  const seedId = requireSeedId(options.seedId);
  const worktreePath = path.join(sessionRoot, 'worktrees', `seed_${seedId}`);
  const branch = `evolve/${sessionId}/seed-${seedId}`;
  const base = options.baseCommit || 'HEAD';
  if (branchExists(projectRoot, branch, options)) {
    throw runtimeError('branch_collision', `pre-existing branch '${branch}' preserved; investigate orphan state`, 1);
  }
  if (targetCollision(worktreePath)) {
    throw runtimeError('worktree_collision', `seed worktree already exists at ${worktreePath}`, 1);
  }
  ensureWorktreeParent(worktreePath);
  const result = git(projectRoot, ['worktree', 'add', worktreePath, '-b', branch, base], options);
  if (result.status !== 0) commandResult(result, `create seed worktree ${seedId}`);
  const head = String(gitOk(worktreePath, ['rev-parse', 'HEAD'], options).stdout).trim();
  return { seed_id: seedId, worktree_path: worktreePath, branch, head };
}

function ignoredScratchEntry(record) {
  if (!record.startsWith('?? ')) return false;
  const value = record.slice(3).replace(/\\/g, '/');
  const first = value.split('/')[0];
  return SCRATCH_DIRECTORIES.has(first);
}

function validateSeedWorktree(options) {
  const sessionRoot = requireDirectory(options.sessionRoot, 'sessionRoot');
  const sessionId = requireString(options.sessionId, 'sessionId');
  const seedId = requireSeedId(options.seedId);
  const worktreePath = path.join(sessionRoot, 'worktrees', `seed_${seedId}`);
  requireDirectory(worktreePath, 'seed worktree', 'worktree_missing');
  const expectedBranch = `evolve/${sessionId}/seed-${seedId}`;
  const branchResult = git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], options);
  if (branchResult.status === 1) {
    throw runtimeError('worktree_off_branch', `worktree checked out detached HEAD, expected ${expectedBranch}`, 1);
  }
  commandResult(branchResult, 'read seed branch');
  const branch = String(branchResult.stdout).trim();
  if (branch !== expectedBranch) {
    throw runtimeError('worktree_off_branch', `worktree checked out ${branch || 'detached HEAD'}, expected ${expectedBranch}`, 1);
  }
  const status = gitOk(worktreePath, ['status', '--porcelain=v1', '-z'], {
    ...options, encoding: null,
  }).stdout;
  const dirty = Buffer.from(status || Buffer.alloc(0)).toString('utf8').split('\0')
    .filter(Boolean).filter((record) => !ignoredScratchEntry(record));
  if (dirty.length > 0) {
    throw runtimeError('worktree_dirty', `worktree not clean: ${dirty.join(', ')}`, 1, { entries: dirty });
  }
  const head = String(gitOk(worktreePath, ['rev-parse', 'HEAD'], options).stdout).trim();
  if (options.preDispatchHead && head !== options.preDispatchHead) {
    const ancestry = git(worktreePath, ['merge-base', '--is-ancestor', options.preDispatchHead, head], options);
    if (ancestry.status === 1) {
      throw runtimeError('worktree_history_rewritten', `current HEAD ${head} is not a descendant of pre-dispatch HEAD ${options.preDispatchHead}`, 1);
    }
    commandResult(ancestry, 'validate seed ancestry');
  }
  return { clean: true, branch, head, worktree_path: worktreePath };
}

function registeredWorktree(projectRoot, worktreePath, options = {}) {
  const output = String(gitOk(projectRoot, ['worktree', 'list', '--porcelain'], options).stdout);
  const canonical = (value) => {
    let resolved = path.resolve(value);
    const missing = [];
    let current = resolved;
    for (;;) {
      try {
        const physical = fs.realpathSync.native(current);
        resolved = path.join(physical, ...missing);
        break;
      } catch (error) {
        if (!error || !['ENOENT', 'ENOTDIR'].includes(error.code)) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        missing.unshift(path.basename(current));
        current = parent;
      }
    }
    const normalized = resolved.replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const expected = canonical(worktreePath);
  return output.split(/\r?\n/).some((line) => line.startsWith('worktree ')
    && canonical(line.slice('worktree '.length)) === expected);
}

function removeSeedWorktree(options) {
  const projectRoot = requireDirectory(options.projectRoot, 'projectRoot');
  const sessionRoot = requireDirectory(options.sessionRoot, 'sessionRoot');
  const seedId = requireSeedId(options.seedId);
  const worktreePath = path.join(sessionRoot, 'worktrees', `seed_${seedId}`);
  const existed = Boolean(targetCollision(worktreePath));
  const registered = registeredWorktree(projectRoot, worktreePath, options);
  if (existed || registered) {
    const result = git(projectRoot, ['worktree', 'remove', '--force', worktreePath], options);
    if (result.status !== 0 && existed) commandResult(result, `remove seed worktree ${seedId}`);
  }
  gitOk(projectRoot, ['worktree', 'prune'], options);
  return { removed: existed, pruned: registered && !existed, worktree_path: worktreePath };
}

function createSynthesisWorktree(options) {
  const projectRoot = requireDirectory(options.projectRoot, 'projectRoot');
  const sessionRoot = requireDirectory(options.sessionRoot, 'sessionRoot');
  const sessionId = requireString(options.sessionId, 'sessionId');
  const baseline = requireString(options.baselineCommit, 'baselineCommit');
  const valid = git(projectRoot, ['rev-parse', '--verify', '--quiet', `${baseline}^{commit}`], options);
  if (valid.status !== 0) {
    if (valid.status !== 1) commandResult(valid, 'validate synthesis baseline');
    throw runtimeError('invalid_baseline', `invalid baseline commit: ${baseline}`);
  }
  const worktreePath = path.join(sessionRoot, 'worktrees', 'synthesis');
  const branch = `evolve/${sessionId}/synthesis`;
  if (targetCollision(worktreePath)) {
    throw runtimeError('worktree_collision', `synthesis worktree already exists at ${worktreePath}`);
  }
  if (branchExists(projectRoot, branch, options)) {
    throw runtimeError('branch_collision', `synthesis branch ${branch} already exists; run cleanup first`);
  }
  ensureWorktreeParent(worktreePath);
  const result = git(projectRoot, ['worktree', 'add', '--quiet', worktreePath, '-b', branch, baseline], options);
  if (result.status !== 0) commandResult(result, 'create synthesis worktree');
  return { worktree_path: worktreePath, branch, baseline_commit: String(valid.stdout).trim() };
}

function invokePhase(options, phase, context = {}) {
  if (typeof options.onPhase === 'function') options.onPhase(phase, context);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function durableArtifact(filePath, bytes, options, context) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    invokePhase(options, 'artifact:fsync', { ...context, filePath });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function recoveryName(options) {
  const raw = String((options.randomUUID || crypto.randomUUID)());
  return raw.replace(/[^A-Za-z0-9._-]/g, '-');
}

function uniqueDirectory(parent, preferred) {
  let candidate = path.join(parent, preferred);
  let suffix = 2;
  while (targetCollision(candidate)) {
    candidate = path.join(parent, `${preferred}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function untrackedBundle(worktreePath, options) {
  const output = gitOk(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'], {
    ...options, encoding: null,
  }).stdout;
  const names = Buffer.from(output || Buffer.alloc(0)).toString('utf8').split('\0').filter(Boolean).sort();
  return names.map((name) => {
    const absolute = path.join(worktreePath, name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      return { path: name, type: 'symlink', mode: stat.mode & 0o777, target_base64: Buffer.from(fs.readlinkSync(absolute)).toString('base64') };
    }
    if (!stat.isFile()) throw runtimeError('unsupported_untracked_type', `untracked path is not a file or symlink: ${name}`);
    return { path: name, type: 'file', mode: stat.mode & 0o777, content_base64: fs.readFileSync(absolute).toString('base64') };
  });
}

function safeRelative(value) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

function unpackUntracked(target, entries) {
  for (const entry of entries) {
    if (!safeRelative(entry.path)) throw runtimeError('unsafe_recovery_path', `unsafe untracked recovery path: ${entry.path}`);
    const absolute = path.join(target, entry.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (entry.type === 'symlink') fs.symlinkSync(Buffer.from(entry.target_base64, 'base64').toString(), absolute);
    else {
      fs.writeFileSync(absolute, Buffer.from(entry.content_base64, 'base64'), { mode: entry.mode });
      fs.chmodSync(absolute, entry.mode);
    }
  }
}

function artifactBytes(recoveryPath, manifest, name) {
  const record = manifest.artifacts && manifest.artifacts[name];
  if (!record || !safeRelative(record.path)) throw runtimeError('recovery_manifest_invalid', `missing recovery artifact ${name}`);
  const absolute = path.join(recoveryPath, record.path);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw runtimeError('recovery_artifact_invalid', `recovery artifact must be a regular file: ${absolute}`);
  const bytes = fs.readFileSync(absolute);
  if (!Number.isInteger(record.size) || record.size !== bytes.length) {
    throw runtimeError('recovery_size_mismatch', `recovery size mismatch: ${name}`);
  }
  if (sha256(bytes) !== record.sha256) throw runtimeError('recovery_checksum_mismatch', `recovery checksum mismatch: ${name}`);
  return bytes;
}

function reconstructBundle(recoveryPath, manifest, options = {}) {
  const projectRoot = requireDirectory(options.projectRoot, 'projectRoot');
  const staged = artifactBytes(recoveryPath, manifest, 'staged_patch');
  const unstaged = artifactBytes(recoveryPath, manifest, 'unstaged_patch');
  const status = artifactBytes(recoveryPath, manifest, 'status');
  const untracked = JSON.parse(artifactBytes(recoveryPath, manifest, 'untracked').toString('utf8'));
  artifactBytes(recoveryPath, manifest, 'refs');
  const validationParent = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-evolve-recovery-'));
  const validationRoot = path.join(validationParent, 'reconstructed');
  try {
    const clone = (options.spawnSync || defaultSpawnSync)('git', ['clone', '--quiet', '--no-hardlinks', projectRoot, validationRoot], {
      encoding: 'utf8', shell: false,
    });
    commandResult(clone, 'clone recovery validation repository');
    gitOk(validationRoot, ['checkout', '--quiet', '--detach', manifest.base_commit], options);
    if (staged.length > 0) gitOk(validationRoot, ['apply', '--binary', '--index', '--whitespace=nowarn', '-'], { ...options, input: staged });
    if (unstaged.length > 0) gitOk(validationRoot, ['apply', '--binary', '--whitespace=nowarn', '-'], { ...options, input: unstaged });
    if (!Array.isArray(untracked)) throw runtimeError('recovery_manifest_invalid', 'untracked bundle must be an array');
    unpackUntracked(validationRoot, untracked);
    const actualStaged = Buffer.from(gitOk(validationRoot, ['diff', '--binary', '--cached', '--no-ext-diff'], {
      ...options, encoding: null,
    }).stdout || Buffer.alloc(0));
    const actualUnstaged = Buffer.from(gitOk(validationRoot, ['diff', '--binary', '--no-ext-diff'], {
      ...options, encoding: null,
    }).stdout || Buffer.alloc(0));
    const actualStatus = Buffer.from(gitOk(validationRoot, ['status', '--porcelain=v1', '-z'], {
      ...options, encoding: null,
    }).stdout || Buffer.alloc(0));
    if (!actualStaged.equals(staged) || !actualUnstaged.equals(unstaged) || !actualStatus.equals(status)) {
      throw runtimeError('recovery_not_reconstructable', 'recovery bundle does not reconstruct exact tracked and untracked state');
    }
    return { valid: true, tracked: staged.length + unstaged.length > 0, untracked: untracked.length };
  } finally {
    fs.rmSync(validationParent, { recursive: true, force: true });
  }
}

function validateRecoveryBundle(recoveryPath, options = {}) {
  const root = requireDirectory(recoveryPath, 'recovery bundle');
  const manifestPath = path.join(root, 'manifest.json');
  const stat = fs.lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw runtimeError('recovery_manifest_invalid', 'recovery manifest must be a regular file');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema_version !== 1 || manifest.ready !== true || !['ready', 'complete'].includes(manifest.phase)) {
    throw runtimeError('recovery_not_ready', 'recovery manifest is not ready');
  }
  return reconstructBundle(root, manifest, options);
}

function captureRecoveryState(options, worktreePath, branch) {
  const head = String(gitOk(worktreePath, ['rev-parse', 'HEAD'], options).stdout).trim();
  const branchSha = String(gitOk(options.projectRoot, ['rev-parse', '--verify', `refs/heads/${branch}`], options).stdout).trim();
  const staged = Buffer.from(gitOk(worktreePath, ['diff', '--binary', '--cached', '--no-ext-diff'], {
    ...options, encoding: null,
  }).stdout || Buffer.alloc(0));
  const unstaged = Buffer.from(gitOk(worktreePath, ['diff', '--binary', '--no-ext-diff'], {
    ...options, encoding: null,
  }).stdout || Buffer.alloc(0));
  const status = Buffer.from(gitOk(worktreePath, ['status', '--porcelain=v1', '-z'], {
    ...options, encoding: null,
  }).stdout || Buffer.alloc(0));
  const untracked = Buffer.from(`${JSON.stringify(untrackedBundle(worktreePath, options), null, 2)}\n`);
  const refs = Buffer.from(String(gitOk(options.projectRoot, ['show-ref', '--heads'], options).stdout));
  return { head, branchSha, values: { staged_patch: staged, unstaged_patch: unstaged, status, untracked, refs } };
}

function buildRecoveryBundle(options, worktreePath, branch, captured = captureRecoveryState(options, worktreePath, branch)) {
  const recoveryParent = path.join(options.sessionRoot, 'synthesis-recovery');
  requireRegularDirectoryPath(recoveryParent, 'recovery parent', {
    create: true, code: 'recovery_parent_invalid',
  });
  const nonce = recoveryName(options);
  const recoveryPath = uniqueDirectory(recoveryParent, nonce);
  invokePhase(options, 'bundle:create', { recoveryPath });
  fs.mkdirSync(recoveryPath, { recursive: false, mode: 0o700 });
  syncRenamedDirectoryBestEffort(recoveryParent, options.platform || process.platform, options);
  const { head, branchSha, values } = captured;
  const fileNames = {
    staged_patch: 'staged.patch', unstaged_patch: 'unstaged.patch', status: 'status.bin',
    untracked: 'untracked-files.json', refs: 'refs.txt',
  };
  const artifacts = {};
  for (const [name, bytes] of Object.entries(values)) {
    const fileName = fileNames[name];
    durableArtifact(path.join(recoveryPath, fileName), bytes, options, { recoveryPath, artifact: name });
    artifacts[name] = { path: fileName, sha256: sha256(bytes), size: bytes.length };
  }
  const draft = {
    schema_version: 1,
    cleanup_nonce: nonce,
    phase: 'preparing',
    ready: false,
    created_at: new Date(typeof options.now === 'function' ? options.now() : Date.now()).toISOString(),
    base_commit: head,
    refs: { original_branch: branch, original_branch_sha: branchSha },
    status_porcelain_v1_z_base64: values.status.toString('base64'),
    reconstruction_scope: 'tracked staged and unstaged changes plus non-ignored untracked files; gitignored files excluded',
    artifacts,
  };
  atomicWriteFile(path.join(recoveryPath, 'manifest.json'), `${JSON.stringify(draft, null, 2)}\n`);
  reconstructBundle(recoveryPath, draft, options);
  invokePhase(options, 'manifest:commit', { recoveryPath });
  const manifest = { ...draft, phase: 'ready', ready: true };
  atomicWriteFile(path.join(recoveryPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { recoveryPath, manifest };
}

function recoveryMatchesCapture(manifest, captured) {
  if (!captured || manifest.base_commit !== captured.head
      || !manifest.refs || manifest.refs.original_branch_sha !== captured.branchSha) return false;
  for (const [name, bytes] of Object.entries(captured.values)) {
    const artifact = manifest.artifacts && manifest.artifacts[name];
    if (!artifact || artifact.sha256 !== sha256(bytes) || artifact.size !== bytes.length) return false;
  }
  return true;
}

function capturesEqual(left, right) {
  if (!left || !right || left.head !== right.head || left.branchSha !== right.branchSha) return false;
  return Object.keys(left.values).every((name) => right.values[name]
    && left.values[name].equals(right.values[name]));
}

function findReadyRecovery(sessionRoot, branch, captured = null) {
  const parent = path.join(sessionRoot, 'synthesis-recovery');
  if (!targetCollision(parent)) return null;
  requireRegularDirectoryPath(parent, 'recovery parent', { code: 'recovery_parent_invalid' });
  const candidates = [];
  for (const name of fs.readdirSync(parent).sort()) {
    const recoveryPath = path.join(parent, name);
    const manifestPath = path.join(recoveryPath, 'manifest.json');
    try {
      const rootStat = fs.lstatSync(recoveryPath);
      const stat = fs.lstatSync(manifestPath);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || stat.isSymbolicLink() || !stat.isFile()) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.ready === true && manifest.refs && manifest.refs.original_branch === branch
          && (!captured || recoveryMatchesCapture(manifest, captured))) {
        candidates.push({ recoveryPath, manifest, modified: stat.mtimeMs, name });
      }
    } catch {}
  }
  candidates.sort((left, right) => {
    const created = Date.parse(left.manifest.created_at) - Date.parse(right.manifest.created_at);
    if (Number.isFinite(created) && created !== 0) return created;
    if (left.modified !== right.modified) return left.modified - right.modified;
    return compareText(left.name, right.name);
  });
  return candidates.at(-1) || null;
}

function safeTimestamp(options) {
  const millis = typeof options.now === 'function' ? options.now() : Date.now();
  return new Date(millis).toISOString().replace(/:/g, '-').replace('T', '_').replace(/\.\d{3}Z$/, 'Z');
}

function uniqueFailedBranch(projectRoot, sessionId, options) {
  const nonce = recoveryName(options);
  const base = `evolve/${sessionId}/synthesis-failed-${safeTimestamp(options)}-${nonce}`;
  let branch = base;
  let suffix = 2;
  while (branchExists(projectRoot, branch, options)) {
    branch = `${base}-${suffix}`;
    suffix += 1;
  }
  return branch;
}

function renameSynthesisBranch(options, branch, context) {
  if (!branchExists(options.projectRoot, branch, options)) return null;
  const failedBranch = uniqueFailedBranch(options.projectRoot, options.sessionId, options);
  invokePhase(options, 'branch:remove', { ...context, branch, failedBranch });
  gitOk(options.projectRoot, ['branch', '-m', branch, failedBranch], options);
  return failedBranch;
}

function cleanupFailedSynthesisWorktree(options) {
  const projectRoot = requireDirectory(options.projectRoot, 'projectRoot');
  const sessionRoot = requireDirectory(options.sessionRoot, 'sessionRoot');
  const sessionId = requireString(options.sessionId, 'sessionId');
  const normalized = { ...options, projectRoot, sessionRoot, sessionId };
  const worktreePath = path.join(sessionRoot, 'worktrees', 'synthesis');
  const branch = `evolve/${sessionId}/synthesis`;
  const present = targetCollision(worktreePath);
  if (present && (!present.isDirectory() || present.isSymbolicLink())) {
    throw runtimeError('worktree_collision', `synthesis worktree path is not an owned directory: ${worktreePath}`);
  }
  const captured = present ? captureRecoveryState(normalized, worktreePath, branch) : null;
  const ready = findReadyRecovery(sessionRoot, branch, captured);
  if (!present) {
    if (ready) validateRecoveryBundle(ready.recoveryPath, { ...normalized, projectRoot });
    gitOk(projectRoot, ['worktree', 'prune'], normalized);
    const failedBranch = renameSynthesisBranch(normalized, branch, {
      recoveryPath: ready && ready.recoveryPath,
    });
    if (!failedBranch) return { cleaned: false, noop: true, resumed: Boolean(ready) };
    return {
      cleaned: true,
      orphan: !ready,
      resumed: Boolean(ready),
      failed_branch: failedBranch,
      ...(ready ? { recovery_path: ready.recoveryPath } : {}),
    };
  }
  const status = captured.values.status;
  let recovery = ready;
  if (status.length > 0 && !recovery) recovery = buildRecoveryBundle(normalized, worktreePath, branch, captured);
  if (recovery) validateRecoveryBundle(recovery.recoveryPath, { ...normalized, projectRoot });
  invokePhase(normalized, 'worktree:remove', { recoveryPath: recovery && recovery.recoveryPath, worktreePath });
  const finalCapture = captureRecoveryState(normalized, worktreePath, branch);
  const stable = recovery
    ? recoveryMatchesCapture(recovery.manifest, finalCapture)
    : capturesEqual(captured, finalCapture);
  if (!stable) {
    throw runtimeError('worktree_changed_after_recovery', 'synthesis worktree changed after recovery capture; cleanup aborted', 2);
  }
  gitOk(projectRoot, ['worktree', 'remove', '--force', worktreePath], normalized);
  const failedBranch = renameSynthesisBranch(normalized, branch, { recoveryPath: recovery && recovery.recoveryPath });
  return {
    cleaned: true,
    resumed: Boolean(ready),
    failed_branch: failedBranch,
    ...(recovery ? { recovery_path: recovery.recoveryPath } : {}),
  };
}

function selectBacktrack(candidates, strategy = 'highest_score', random = Math.random) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw runtimeError('archive_empty', 'backtrack candidates are required', 1);
  const normalized = candidates.map((candidate) => ({
    ...candidate,
    backtrack_score: Number(candidate.score) * Math.exp(-((Number(candidate.children_explored) / 6) ** 3)),
  }));
  if (strategy === 'least_explored') {
    return normalized.sort((a, b) => Number(a.children_explored) - Number(b.children_explored) || compareText(a.id, b.id))[0];
  }
  if (strategy === 'highest_score') {
    return normalized.sort((a, b) => b.backtrack_score - a.backtrack_score || compareText(a.id, b.id))[0];
  }
  if (strategy === 'random') {
    const total = normalized.reduce((sum, candidate) => sum + Math.max(0, candidate.backtrack_score), 0);
    if (total <= 0) return normalized.sort((a, b) => compareText(a.id, b.id))[0];
    let cursor = random() * total;
    for (const candidate of normalized) {
      cursor -= Math.max(0, candidate.backtrack_score);
      if (cursor <= 0) return candidate;
    }
    return normalized.at(-1);
  }
  throw runtimeError('invalid_backtrack_strategy', `unknown backtrack strategy: ${strategy}`);
}

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readBacktrackMetadata(sessionRoot, candidate) {
  const codeArchive = requireDirectory(path.join(sessionRoot, 'code-archive'), 'codeArchive');
  let metadataPath = candidate.metadata_path;
  if (metadataPath === undefined && typeof candidate.archive_path === 'string') {
    const directory = path.resolve(candidate.archive_path);
    for (const name of ['metadata.json', 'metadata.yaml', 'keep.json', 'keep.yaml']) {
      const possible = path.join(directory, name);
      if (targetCollision(possible)) { metadataPath = possible; break; }
    }
  }
  if (metadataPath === undefined) metadataPath = path.join(codeArchive, String(candidate.id), 'metadata.json');
  const lexical = path.resolve(requireString(metadataPath, 'metadata_path'));
  const stat = fs.lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isFile()) throw runtimeError('archive_file_invalid', `code archive metadata must be regular: ${lexical}`);
  const physical = fs.realpathSync(lexical);
  if (!pathInside(codeArchive, physical)) throw runtimeError('archive_path_escape', `code archive metadata escapes ${codeArchive}`);
  const bytes = fs.readFileSync(physical);
  let metadata;
  try { metadata = parseStateDocument(bytes.toString('utf8'), { sourcePath: physical }); }
  catch (error) { throw runtimeError('archive_metadata_invalid', `cannot parse code archive metadata ${physical}: ${error.message}`); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || !Number.isInteger(metadata.children_explored) || metadata.children_explored < 0
      || typeof metadata.commit !== 'string' || metadata.commit.length === 0) {
    throw runtimeError('archive_metadata_invalid', `invalid code archive metadata: ${physical}`);
  }
  if (metadata.commit !== candidate.commit || metadata.children_explored !== Number(candidate.children_explored)) {
    throw runtimeError('archive_selection_stale', `code archive selection is stale for ${candidate.id}`, 1);
  }
  return { path: physical, bytes, metadata };
}

function nextForkBranch(projectRoot, sessionId, requested, options) {
  const prefix = `evolve/${sessionId}/fork-`;
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested <= 0) throw runtimeError('invalid_fork_number', 'forkNumber must be a positive integer');
    const branch = `${prefix}${String(requested).padStart(3, '0')}`;
    if (branchExists(projectRoot, branch, options)) throw runtimeError('branch_collision', `fork branch already exists: ${branch}`, 1);
    return branch;
  }
  const output = String(gitOk(projectRoot, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`], options).stdout);
  let number = 1;
  for (const branch of output.split(/\r?\n/)) {
    if (!branch.startsWith(prefix)) continue;
    const suffix = branch.slice(prefix.length);
    if (/^\d+$/.test(suffix)) number = Math.max(number, Number(suffix) + 1);
  }
  let branch = `${prefix}${String(number).padStart(3, '0')}`;
  while (branchExists(projectRoot, branch, options)) {
    number += 1;
    branch = `${prefix}${String(number).padStart(3, '0')}`;
  }
  return branch;
}

function restoreBacktrackFiles(metadata, programPath, programBytes) {
  try { atomicWriteFile(metadata.path, metadata.bytes); } catch {}
  try { atomicWriteFile(programPath, programBytes); } catch {}
}

function rollbackBacktrackGit(projectRoot, previousBranch, branch, expectedCommit, options) {
  try { gitOk(projectRoot, ['checkout', '--quiet', previousBranch], options); } catch {}
  try {
    const current = git(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], options);
    if (current.status === 0 && String(current.stdout).trim() === expectedCommit) {
      git(projectRoot, ['branch', '-D', branch], options);
    }
  } catch {}
}

function backtrackArchive(options) {
  const projectRoot = requireDirectory(options.projectRoot, 'projectRoot');
  const sessionRoot = requireDirectory(options.sessionRoot, 'sessionRoot');
  const sessionId = requireString(options.sessionId, 'sessionId');
  const selected = selectBacktrack(options.candidates, options.strategy, options.random);
  requireString(selected.id, 'selected.id');
  requireString(selected.commit, 'selected.commit');
  if (typeof selected.score !== 'number' || !Number.isFinite(selected.score)
      || !Number.isInteger(selected.children_explored) || selected.children_explored < 0) {
    throw runtimeError('archive_candidate_invalid', `invalid code archive candidate: ${selected.id}`);
  }
  const metadata = readBacktrackMetadata(sessionRoot, selected);
  const programPath = path.join(sessionRoot, 'program.md');
  const programStat = fs.lstatSync(programPath);
  if (programStat.isSymbolicLink() || !programStat.isFile()) throw runtimeError('program_invalid', `program must be regular: ${programPath}`);
  const programBytes = fs.readFileSync(programPath);
  const status = Buffer.from(gitOk(projectRoot, ['status', '--porcelain=v1', '-z'], { ...options, encoding: null }).stdout || Buffer.alloc(0));
  const dirty = status.toString('utf8').split('\0').filter(Boolean).filter((record) => !ignoredScratchEntry(record));
  if (dirty.length > 0) throw runtimeError('worktree_dirty', `cannot backtrack a dirty project worktree: ${dirty.join(', ')}`, 1);
  const previous = git(projectRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], options);
  commandResult(previous, 'read current branch');
  const previousBranch = String(previous.stdout).trim();
  const commit = git(projectRoot, ['rev-parse', '--verify', '--quiet', `${selected.commit}^{commit}`], options);
  if (commit.status !== 0) {
    if (commit.status !== 1) commandResult(commit, 'validate backtrack commit');
    throw runtimeError('invalid_backtrack_commit', `invalid backtrack commit: ${selected.commit}`, 1);
  }
  const expectedCommit = String(commit.stdout).trim();
  const branch = nextForkBranch(projectRoot, sessionId, options.forkNumber, options);
  const context = options.programContext === undefined
    ? `이 지점에서 이전에 ${selected.description || selected.id}을 시도했으나 정체됨. 다른 접근법을 시도하라.`
    : requireString(options.programContext, 'programContext');
  const separator = programBytes.length > 0 && !programBytes.toString('utf8').endsWith('\n') ? '\n' : '';
  const nextProgram = Buffer.concat([programBytes, Buffer.from(`${separator}\n${context}\n`)]);
  const checkout = git(projectRoot, ['checkout', '--quiet', '-b', branch, expectedCommit], options);
  commandResult(checkout, `create backtrack branch ${branch}`);
  try {
    atomicWriteFile(metadata.path, serializeStateDocument({
      ...metadata.metadata, children_explored: metadata.metadata.children_explored + 1,
    }));
    atomicWriteFile(programPath, nextProgram);
    if (typeof options.commitState !== 'function') throw runtimeError('backtrack_state_callback_missing', 'backtrack requires a state commit callback');
    options.commitState({
      selected, branch, previous_branch: previousBranch, commit: expectedCommit,
      reason: options.reason || 'plateau', program_context: context,
    });
  } catch (error) {
    restoreBacktrackFiles(metadata, programPath, programBytes);
    rollbackBacktrackGit(projectRoot, previousBranch, branch, expectedCommit, options);
    throw error;
  }
  return {
    selected: { ...selected, children_explored: selected.children_explored + 1 },
    branch,
    previous_branch: previousBranch,
    commit: expectedCommit,
    metadata_path: metadata.path,
  };
}

function archiveDirectory(sessionRoot, generation) {
  if (!Number.isInteger(generation) || generation < 1) throw runtimeError('invalid_generation', 'generation must be a positive integer');
  return path.join(sessionRoot, 'strategy-archive', `gen_${generation}`);
}

function requireStrategyArchiveDirectory(sessionRoot, generation, { create = false } = {}) {
  const root = path.join(sessionRoot, 'strategy-archive');
  requireRegularDirectoryPath(root, 'strategy archive root', {
    create, code: 'strategy_archive_invalid',
  });
  const directory = archiveDirectory(sessionRoot, generation);
  requireRegularDirectoryPath(directory, 'strategy archive generation', {
    create, code: 'strategy_archive_invalid',
  });
  return directory;
}

function saveStrategyArchive(options) {
  const sessionRoot = requireDirectory(options.sessionRoot, 'sessionRoot');
  const directory = requireStrategyArchiveDirectory(sessionRoot, options.generation, { create: true });
  atomicWriteFile(path.join(directory, 'strategy.yaml'), requireString(options.strategyText, 'strategyText'));
  atomicWriteFile(path.join(directory, 'program.md.snapshot'), requireString(options.programText, 'programText'));
  atomicWriteFile(path.join(directory, 'metrics.json'), `${JSON.stringify(options.metrics || {}, null, 2)}\n`);
  return { generation: options.generation, archive_path: directory };
}

function regularArchiveFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw runtimeError('archive_file_invalid', `archive file must be regular: ${filePath}`);
  return fs.readFileSync(filePath);
}

function restoreStrategyArchive(options) {
  const sessionRoot = requireDirectory(options.sessionRoot, 'sessionRoot');
  const directory = requireStrategyArchiveDirectory(sessionRoot, options.generation);
  const strategy = regularArchiveFile(path.join(directory, 'strategy.yaml'));
  const program = regularArchiveFile(path.join(directory, 'program.md.snapshot'));
  atomicWriteFile(path.join(sessionRoot, 'strategy.yaml'), strategy);
  atomicWriteFile(path.join(sessionRoot, 'program.md'), program);
  return { generation: options.generation, restored: ['strategy.yaml', 'program.md'] };
}

function selectStrategyFork(generations) {
  if (!Array.isArray(generations) || generations.length === 0) throw runtimeError('archive_empty', 'strategy generations are required', 1);
  return generations.map((generation) => ({
    ...generation,
    candidate_score: Number(generation.Q) * Math.exp(-((Number(generation.children_count) / 4) ** 3)),
  })).sort((a, b) => b.candidate_score - a.candidate_score || Number(a.generation) - Number(b.generation))[0];
}

function forkStrategyArchive(options) {
  const sessionRoot = requireDirectory(options.sessionRoot, 'sessionRoot');
  const selected = selectStrategyFork(options.generations);
  const directory = requireStrategyArchiveDirectory(sessionRoot, selected.generation);
  const lockRoot = path.dirname(directory);
  const result = withDirectoryLock(path.join(lockRoot, '.archive.lock'), () => {
    const metricsPath = path.join(directory, 'metrics.json');
    let metrics;
    try { metrics = JSON.parse(regularArchiveFile(metricsPath).toString('utf8')); }
    catch (error) {
      if (error && error.code) throw error;
      throw runtimeError('archive_metrics_invalid', `strategy archive metrics are not valid JSON: ${metricsPath}`);
    }
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)
        || !Number.isInteger(metrics.children_count) || metrics.children_count < 0
        || typeof metrics.Q !== 'number' || !Number.isFinite(metrics.Q)) {
      throw runtimeError('archive_metrics_invalid', `strategy archive metrics are invalid: ${metricsPath}`);
    }
    if (Number(selected.children_count) !== metrics.children_count || Number(selected.Q) !== metrics.Q) {
      throw runtimeError('archive_selection_stale', `strategy archive selection is stale for generation ${selected.generation}`, 1);
    }
    const restored = restoreStrategyArchive({ sessionRoot, generation: selected.generation });
    atomicWriteFile(metricsPath, `${JSON.stringify({ ...metrics, children_count: metrics.children_count + 1 }, null, 2)}\n`);
    return { selected, restored, children_count: metrics.children_count + 1 };
  }, options.lockOptions || {});
  if (result && result.ok === false && result.code === 'lock_held') {
    throw runtimeError('lock_held', 'strategy archive lock is held');
  }
  return result;
}

module.exports = {
  SCRATCH_DIRECTORIES,
  createSeedWorktree,
  validateSeedWorktree,
  removeSeedWorktree,
  createSynthesisWorktree,
  cleanupFailedSynthesisWorktree,
  validateRecoveryBundle,
  selectBacktrack,
  backtrackArchive,
  saveStrategyArchive,
  restoreStrategyArchive,
  selectStrategyFork,
  forkStrategyArchive,
};
