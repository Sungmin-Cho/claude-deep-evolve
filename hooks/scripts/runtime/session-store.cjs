'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseStateDocument,
  serializeStateDocument,
  validateSession,
} = require('./session-codec.cjs');
const { isPathInside } = require('./runtime-paths.cjs');

const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const TRANSIENT_WINDOWS_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
const COORDINATION_FILES = new Set([
  'current.json',
  'sessions.jsonl',
  'session.yaml',
  'strategy.yaml',
  'journal.jsonl',
  'forum.jsonl',
  'kill_queue.jsonl',
  'kill_requests.jsonl',
  'results.tsv',
]);

function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

function isoNow(now = Date.now()) {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Digest(value) {
  return `sha256:${sha256(value)}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function fsyncFile(io, fd, {
  platform = process.platform,
  sleep = sleepSync,
  attempts = 10,
} = {}) {
  const delays = [10, 20, 40, 80, 120, 150, 180, 200, 200];
  for (let attempt = 0; ; attempt += 1) {
    try {
      io.fsyncSync(fd);
      return;
    } catch (error) {
      if (platform !== 'win32'
          || !TRANSIENT_WINDOWS_RENAME.has(error && error.code)
          || attempt >= attempts - 1) {
        throw error;
      }
      sleep(delays[Math.min(attempt, delays.length - 1)]);
    }
  }
}

function renameWithRetry(from, to, {
  io = fs,
  platform = process.platform,
  sleep = sleepSync,
  attempts = 10,
} = {}) {
  const delays = [10, 20, 40, 80, 120, 150, 180, 200, 200];
  for (let attempt = 0; ; attempt += 1) {
    try {
      io.renameSync(from, to);
      return;
    } catch (error) {
      if (platform !== 'win32' || !TRANSIENT_WINDOWS_RENAME.has(error && error.code) || attempt >= attempts - 1) {
        throw error;
      }
      sleep(delays[Math.min(attempt, delays.length - 1)]);
    }
  }
}

function syncRenamedDirectoryBestEffort(directoryPath, platform = process.platform, {
  io = fs,
  onDiagnostic = () => {},
} = {}) {
  if (platform === 'win32') return { synced: false, reason: 'windows_marker_durability' };
  let fd;
  try {
    fd = io.openSync(directoryPath, 'r');
    io.fsyncSync(fd);
    return { synced: true };
  } catch (error) {
    onDiagnostic({ code: 'directory_sync_unavailable', error_code: error && error.code });
    return { synced: false, reason: 'directory_sync_unavailable' };
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch {}
    }
  }
}

function atomicWriteFile(filePath, data, {
  io = fs,
  platform = process.platform,
  sleep = sleepSync,
  tempNonce = nonce(),
  mode = 0o600,
  onDiagnostic = () => {},
} = {}) {
  const directory = path.dirname(filePath);
  io.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.tmp.${process.pid}.${tempNonce}`);
  let fd;
  let installed = false;
  try {
    fd = io.openSync(tempPath, 'wx', mode);
    io.writeFileSync(fd, data);
    fsyncFile(io, fd, { platform, sleep });
    io.closeSync(fd);
    fd = undefined;
    renameWithRetry(tempPath, filePath, { io, platform, sleep });
    installed = true;
    syncRenamedDirectoryBestEffort(directory, platform, { io, onDiagnostic });
    return { committed: true, file_path: filePath };
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch {}
    }
    if (!installed) {
      try { io.unlinkSync(tempPath); } catch {}
    }
  }
}

function markerPayload(value) {
  const {
    marker_schema_version: _markerSchemaVersion,
    marker_checksum: _markerChecksum,
    ...payload
  } = value || {};
  const body = { ...payload, marker_schema_version: '1.0' };
  return {
    ...body,
    marker_checksum: `sha256:${sha256(canonicalJson(body))}`,
  };
}

function validateCommitMarker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, reason: 'marker_not_object' };
  if (value.marker_schema_version !== '1.0' || typeof value.marker_checksum !== 'string') {
    return { valid: false, reason: 'marker_schema_invalid' };
  }
  const { marker_checksum: actual, ...body } = value;
  const expected = `sha256:${sha256(canonicalJson(body))}`;
  return actual === expected ? { valid: true, value } : { valid: false, reason: 'marker_checksum_invalid' };
}

function persistCommitMarker(markerPath, value, options = {}) {
  const marker = markerPayload(value);
  atomicWriteFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, options);
  return marker;
}

function readOwner(lockPath, io = fs) {
  const ownerPath = path.join(lockPath, 'owner.json');
  try {
    const raw = io.readFileSync(ownerPath, 'utf8');
    const value = JSON.parse(raw);
    const valid = value && typeof value === 'object' && !Array.isArray(value)
      && Number.isInteger(value.pid) && value.pid > 0
      && typeof value.created_at === 'string'
      && typeof value.heartbeat_at === 'string'
      && Number.isFinite(Date.parse(value.created_at))
      && Number.isFinite(Date.parse(value.heartbeat_at))
      && typeof value.nonce === 'string' && value.nonce.length > 0;
    return { exists: true, valid, raw, value: valid ? value : null };
  } catch (error) {
    return { exists: !(error && error.code === 'ENOENT'), valid: false, raw: null, value: null, error };
  }
}

function lockSnapshot(lockPath, io = fs) {
  let stat;
  try { stat = io.lstatSync(lockPath); }
  catch { return null; }
  const ownerState = readOwner(lockPath, io);
  return {
    mtimeMs: stat.mtimeMs,
    ino: stat.ino,
    raw: ownerState.raw,
    exists: ownerState.exists,
    owner: ownerState.value,
    valid: ownerState.valid,
  };
}

function sameSnapshot(left, right) {
  return Boolean(left && right)
    && left.ino === right.ino
    && left.raw === right.raw
    && left.exists === right.exists;
}

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function recoveryReason(snapshot, now, staleMs, isPidAlive) {
  if (!snapshot) return null;
  if (!snapshot.valid) return now - snapshot.mtimeMs >= staleMs ? 'owner_missing_or_corrupt' : null;
  const heartbeat = Date.parse(snapshot.owner.heartbeat_at);
  if (!isPidAlive(snapshot.owner.pid)) return 'owner_pid_dead';
  if (Number.isFinite(heartbeat) && now - heartbeat >= staleMs) return 'owner_heartbeat_stale';
  return null;
}

function makeOwner(pid, ownerNonce, now) {
  const at = isoNow(now);
  return { pid, created_at: at, heartbeat_at: at, nonce: ownerNonce };
}

function ownershipError() {
  return Object.assign(new Error('lock ownership lost'), { code: 'lock_ownership_lost', rc: 2 });
}

function createLockHandle(lockPath, ownerValue, options) {
  const { io, platform, sleep, onDiagnostic } = options;
  const handle = {
    lockPath,
    nonce: ownerValue.nonce,
    assertOwned() {
      const current = readOwner(lockPath, io);
      if (!(current.valid && current.value.nonce === ownerValue.nonce)) throw ownershipError();
      return true;
    },
    heartbeat() {
      handle.assertOwned();
      const current = readOwner(lockPath, io).value;
      const updated = { ...current, heartbeat_at: isoNow(options.now()) };
      atomicWriteFile(path.join(lockPath, 'owner.json'), `${JSON.stringify(updated)}\n`, {
        io, platform, sleep, onDiagnostic,
      });
      handle.assertOwned();
      return updated;
    },
    release() {
      const current = readOwner(lockPath, io);
      if (!(current.valid && current.value.nonce === ownerValue.nonce)) return false;
      const releasePath = `${lockPath}.release.${ownerValue.nonce}`;
      try { renameWithRetry(lockPath, releasePath, { io, platform, sleep }); }
      catch (error) {
        if (error && error.code === 'ENOENT') return false;
        throw error;
      }
      const moved = readOwner(releasePath, io);
      if (!(moved.valid && moved.value.nonce === ownerValue.nonce)) {
        try {
          if (!io.existsSync(lockPath)) renameWithRetry(releasePath, lockPath, { io, platform, sleep });
        } catch {}
        return false;
      }
      io.rmSync(releasePath, { recursive: true, force: true });
      return true;
    },
  };
  return handle;
}

function tryCreateLock(lockPath, options) {
  const { io, platform, sleep, onDiagnostic } = options;
  const ownerNonce = options.randomNonce();
  try { io.mkdirSync(lockPath); }
  catch (error) {
    if (error && error.code === 'EEXIST') return null;
    throw error;
  }
  const ownerValue = makeOwner(options.pid, ownerNonce, options.now());
  try {
    atomicWriteFile(path.join(lockPath, 'owner.json'), `${JSON.stringify(ownerValue)}\n`, {
      io, platform, sleep, onDiagnostic,
    });
  } catch (error) {
    try { io.rmSync(lockPath, { recursive: true, force: true }); } catch {}
    throw error;
  }
  return createLockHandle(lockPath, ownerValue, options);
}

function releaseClaim(claimPath, claimNonce, options) {
  const current = readOwner(claimPath, options.io);
  if (current.valid && current.value.nonce === claimNonce) {
    options.io.rmSync(claimPath, { recursive: true, force: true });
  }
}

function recoverStaleLock(lockPath, snapshot, reason, options) {
  const claimPath = `${lockPath}.recovery`;
  const deadline = options.now() + options.recoveryTimeoutMs;
  let claim;
  while (options.now() <= deadline) {
    claim = tryCreateLock(claimPath, options);
    if (claim) break;
    const claimSnapshot = lockSnapshot(claimPath, options.io);
    const claimReason = recoveryReason(claimSnapshot, options.now(), options.staleMs, options.isPidAlive);
    if (claimReason) {
      const current = lockSnapshot(claimPath, options.io);
      if (sameSnapshot(claimSnapshot, current)) {
        const stalePath = `${claimPath}.recovered.${Date.now()}.${options.randomNonce()}`;
        try {
          renameWithRetry(claimPath, stalePath, options);
          const moved = lockSnapshot(stalePath, options.io);
          if (!sameSnapshot(claimSnapshot, moved)) {
            if (!options.io.existsSync(claimPath)) renameWithRetry(stalePath, claimPath, options);
          }
        } catch {}
      }
    }
    options.sleep(options.retryDelayMs);
  }
  if (!claim) return { recovered: false, raced: false };
  try {
    if (typeof options.beforeRecoveryQuarantine === 'function') {
      options.beforeRecoveryQuarantine({ lockPath, snapshot, reason });
    }
    const current = lockSnapshot(lockPath, options.io);
    if (!sameSnapshot(snapshot, current)) return { recovered: false, raced: true };
    const recoveryNonce = claim.nonce;
    const quarantinePath = `${lockPath}.recovered.${Date.now()}.${recoveryNonce}`;
    renameWithRetry(lockPath, quarantinePath, options);
    options.onRecoveryWarning({
      code: 'stale_lock_recovered',
      reason,
      quarantine_path: quarantinePath,
      recovery_nonce: recoveryNonce,
    });
    return { recovered: true, raced: false, quarantinePath };
  } finally {
    claim.release();
  }
}

function normalizeLockOptions(options = {}) {
  return {
    io: options.io || fs,
    platform: options.platform || process.platform,
    sleep: options.sleep || sleepSync,
    now: options.now || Date.now,
    pid: options.pid || process.pid,
    randomNonce: options.randomNonce || nonce,
    randomWaiterNonce: options.randomWaiterNonce || nonce,
    isPidAlive: options.isPidAlive || defaultIsPidAlive,
    timeoutMs: options.timeoutMs === undefined ? LOCK_TIMEOUT_MS : options.timeoutMs,
    staleMs: options.staleMs === undefined ? STALE_LOCK_MS : options.staleMs,
    recoveryTimeoutMs: options.recoveryTimeoutMs === undefined
      ? (options.staleMs === undefined ? STALE_LOCK_MS : options.staleMs)
      : options.recoveryTimeoutMs,
    retryDelayMs: options.retryDelayMs === undefined ? 25 : options.retryDelayMs,
    onRecoveryWarning: options.onRecoveryWarning || (() => {}),
    onDiagnostic: options.onDiagnostic || (() => {}),
    beforeRecoveryQuarantine: options.beforeRecoveryQuarantine,
  };
}

function createWaitTicket(lockPath, options) {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.wait.`;
  for (;;) {
    const createdAt = String(Math.max(0, Math.trunc(options.now()))).padStart(16, '0');
    const name = `${prefix}${createdAt}.${options.pid}.${options.randomWaiterNonce()}`;
    const ticketPath = path.join(directory, name);
    try {
      options.io.mkdirSync(ticketPath);
      return { directory, prefix, name, path: ticketPath };
    } catch (error) {
      if (!(error && error.code === 'EEXIST')) throw error;
    }
  }
}

function removeWaitTicket(ticket, io) {
  try { io.rmdirSync(ticket.path); }
  catch {}
}

function orderedWaitTickets(ticket, options) {
  let names;
  try { names = options.io.readdirSync(ticket.directory); }
  catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => name.startsWith(ticket.prefix) && waitTicketOwner(ticket, name))
    .sort();
}

function waitTicketOwner(ticket, name) {
  const suffix = name.slice(ticket.prefix.length);
  const match = /^(\d{16})\.(\d+)\.([^.]+)$/.exec(suffix);
  if (!match) return null;
  return { createdAt: Number(match[1]), pid: Number(match[2]) };
}

function pruneAbandonedWaitTicket(ticket, name, options) {
  const owner = waitTicketOwner(ticket, name);
  if (!owner || name === ticket.name) return false;
  const abandoned = !options.isPidAlive(owner.pid)
    || options.now() - owner.createdAt >= options.staleMs;
  if (!abandoned) return false;
  try { options.io.rmdirSync(path.join(ticket.directory, name)); }
  catch (error) {
    if (!(error && error.code === 'ENOENT')) return false;
  }
  return true;
}

function acquireDirectoryLock(lockPath, rawOptions = {}) {
  const options = normalizeLockOptions(rawOptions);
  const deadline = options.now() + options.timeoutMs;
  const ticket = createWaitTicket(lockPath, options);
  let recoveryRaced = false;
  try {
    for (;;) {
      const ordered = orderedWaitTickets(ticket, options);
      const head = ordered[0];
      if (head && head !== ticket.name) {
        if (pruneAbandonedWaitTicket(ticket, head, options)) continue;
      } else {
        const handle = tryCreateLock(lockPath, options);
        if (handle) return handle;
        const snapshot = lockSnapshot(lockPath, options.io);
        const reason = recoveryRaced ? null : recoveryReason(snapshot, options.now(), options.staleMs, options.isPidAlive);
        if (reason) {
          const recovered = recoverStaleLock(lockPath, snapshot, reason, options);
          if (recovered.recovered) continue;
          if (recovered.raced) recoveryRaced = true;
        }
      }
      if (options.now() >= deadline) return { ok: false, retryable: true, code: 'lock_held' };
      // FIFO tickets prevent the current owner from cutting back in line.
      // Poll the queue head at a small bounded cadence so handoff latency does
      // not consume the caller's real acquisition budget under suite load.
      options.sleep(Math.min(options.retryDelayMs, 5));
    }
  } finally {
    removeWaitTicket(ticket, options.io);
  }
}

function withDirectoryLock(lockPath, fn, options = {}) {
  if (typeof fn !== 'function') throw new TypeError('withDirectoryLock requires a callback');
  const handle = acquireDirectoryLock(lockPath, options);
  if (handle && handle.ok === false) return handle;
  try { return fn(handle); }
  finally { handle.release(); }
}

function transactionError(code, message, extra = {}) {
  return { ok: false, rc: 2, error: { code, message }, ...extra };
}

function transactionBase(value) {
  const body = { transaction_schema_version: '1.0', ...value };
  return { ...body, transaction_checksum: `sha256:${sha256(canonicalJson(body))}` };
}

function validateTransaction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false };
  const { transaction_checksum: actual, ...body } = value;
  if (value.transaction_schema_version !== '1.0' || typeof actual !== 'string') return { valid: false };
  const expected = `sha256:${sha256(canonicalJson(body))}`;
  if (actual !== expected || !Array.isArray(value.entries) || typeof value.transaction_id !== 'string') return { valid: false };
  return { valid: true, value };
}

function coordinationTarget(stateRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw Object.assign(new Error('invalid coordination path'), { code: 'invalid_coordination_path' });
  }
  const normalized = path.normalize(relativePath);
  const target = path.resolve(stateRoot, normalized);
  if (!isPathInside(path.resolve(stateRoot), target, process.platform) || !COORDINATION_FILES.has(path.basename(target))) {
    throw Object.assign(new Error(`invalid coordination path: ${relativePath}`), { code: 'invalid_coordination_path' });
  }
  return target;
}

function relativeCoordinationPath(stateRoot, target) {
  return path.relative(stateRoot, target).split(path.sep).join('/');
}

function fileState(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return { exists: true, sha256: sha256(data), data };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, sha256: null, data: null };
    throw error;
  }
}

function samePreimage(current, entry) {
  return current.exists === entry.previous_exists
    && (current.exists ? current.sha256 === entry.previous_sha256 : true);
}

function invokePhase(options, phase, context = {}) {
  if (typeof options.onPhase === 'function') options.onPhase(phase, context);
  if (options.crashAt === phase) process.exit(options.crashExitCode || 86);
}

function cleanupTransactionDirectory(txDir) {
  try { fs.rmSync(txDir, { recursive: true, force: true }); } catch {}
}

function markRecoveryAmbiguous(txDir, txRoot) {
  const recoveryPath = path.join(txRoot, `recovery-${path.basename(txDir)}-${nonce()}`);
  try { fs.renameSync(txDir, recoveryPath); }
  catch { return txDir; }
  return recoveryPath;
}

function installTransactionEntries(stateRoot, txDir, transaction, projectHandle, options) {
  for (const entry of transaction.entries) {
    const target = coordinationTarget(stateRoot, entry.relative_path);
    const stage = path.resolve(txDir, entry.staged_path);
    if (!isPathInside(txDir, stage, process.platform)) throw Object.assign(new Error('staged path escaped transaction'), { code: 'transaction_ambiguous' });
    const current = fileState(target);
    if (current.exists && current.sha256 === entry.sha256) {
      try { fs.unlinkSync(stage); } catch {}
      continue;
    }
    if (!samePreimage(current, entry)) {
      throw Object.assign(new Error(`target preimage changed for ${entry.relative_path}`), { code: 'transaction_ambiguous' });
    }
    const staged = fileState(stage);
    if (!(staged.exists && staged.sha256 === entry.sha256)) {
      throw Object.assign(new Error(`staged checksum mismatch for ${entry.relative_path}`), { code: 'transaction_ambiguous' });
    }
    invokePhase(options, `before-install:${entry.relative_path}`, { entry, target, stage });
    projectHandle.assertOwned();
    const fileHandle = Array.isArray(options.fileHandles)
      ? options.fileHandles.find((handle) => handle.relativePath === entry.relative_path)
      : null;
    if (fileHandle) fileHandle.assertOwned();
    const immediate = fileState(target);
    if (!samePreimage(immediate, entry)) {
      throw Object.assign(new Error(`target changed before install for ${entry.relative_path}`), { code: 'transaction_ambiguous' });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // A lease can still expire in the instant between these nonce/CAS checks
    // and rename. The protocol bounds that residual TOCTOU window with the
    // >=30-second reclaim floor; recovery markers keep compliant readers from
    // serving a mixed set if the owner is reclaimed after an earlier install.
    renameWithRetry(stage, target, options);
    syncRenamedDirectoryBestEffort(path.dirname(target), options.platform || process.platform, options);
    invokePhase(options, `after-install:${entry.relative_path}`, { entry, target });
  }
}

function commitLocked(stateRoot, replacements, projectHandle, options) {
  const transactionId = `tx-${Date.now()}-${process.pid}-${nonce()}`;
  const txRoot = path.join(stateRoot, '.transactions');
  const txDir = path.join(txRoot, transactionId);
  const stageDir = path.join(txDir, 'staged');
  fs.mkdirSync(stageDir, { recursive: true });
  const entries = [];
  let markerPersisted = false;
  try {
    const names = Object.keys(replacements).sort();
    for (let index = 0; index < names.length; index += 1) {
      const relativePath = names[index];
      const target = coordinationTarget(stateRoot, relativePath);
      const data = Buffer.isBuffer(replacements[relativePath])
        ? replacements[relativePath]
        : Buffer.from(String(replacements[relativePath]));
      const previous = fileState(target);
      const stagedPath = path.join(stageDir, `${String(index).padStart(4, '0')}.replacement`);
      atomicWriteFile(stagedPath, data, options);
      entries.push({
        relative_path: relativePath,
        staged_path: path.relative(txDir, stagedPath).split(path.sep).join('/'),
        sha256: sha256(data),
        bytes: data.length,
        previous_exists: previous.exists,
        previous_sha256: previous.sha256,
      });
      invokePhase(options, `after-stage:${relativePath}`, { relativePath, stagedPath });
    }
    const transaction = transactionBase({
      transaction_id: transactionId,
      created_at: isoNow(),
      entries,
    });
    atomicWriteFile(path.join(txDir, 'transaction.json'), `${JSON.stringify(transaction, null, 2)}\n`, options);
    invokePhase(options, 'after-transaction', { transaction });
    projectHandle.assertOwned();
    invokePhase(options, 'before-commit-marker', { transaction });
    projectHandle.assertOwned();
    persistCommitMarker(path.join(txDir, 'commit.json'), {
      kind: 'deep-evolve-transaction',
      transaction_id: transactionId,
      transaction_checksum: transaction.transaction_checksum,
    }, options);
    markerPersisted = true;
    invokePhase(options, 'after-commit-marker', { transaction });
    installTransactionEntries(stateRoot, txDir, transaction, projectHandle, options);
    cleanupTransactionDirectory(txDir);
    invokePhase(options, 'after-cleanup', { transaction });
    return { ok: true, rc: 0, transaction_id: transactionId };
  } catch (error) {
    if (error && error.code === 'lock_ownership_lost') {
      if (!markerPersisted) cleanupTransactionDirectory(txDir);
      return transactionError('lock_ownership_lost', 'transaction owner nonce changed before install');
    }
    if (error && error.code === 'transaction_ambiguous') {
      const recoveryPath = markRecoveryAmbiguous(txDir, txRoot);
      return transactionError('transaction_ambiguous', error.message, { recovery_paths: [recoveryPath] });
    }
    if (!markerPersisted) cleanupTransactionDirectory(txDir);
    else markRecoveryAmbiguous(txDir, txRoot);
    return transactionError(error && error.code ? error.code : 'transaction_failed', error && error.message ? error.message : 'transaction failed');
  }
}

function acquireRequiredLocks(stateRoot, relativePaths, options) {
  const handles = [];
  for (const relativePath of [...relativePaths].sort()) {
    const target = coordinationTarget(stateRoot, relativePath);
    const parent = path.dirname(target);
    // The project lock already excludes every compliant publisher. When an
    // optional nested target's parent does not yet exist, place its temporary
    // file-lock identity at the state root instead of creating a visible empty
    // namespace merely to host `<target>.lock`.
    const lockPath = fs.existsSync(parent)
      ? `${target}.lock`
      : path.join(stateRoot, `.coordination-path-${sha256(Buffer.from(relativePath))}.lock`);
    const handle = acquireDirectoryLock(lockPath, options);
    if (handle.ok === false) {
      for (const acquired of handles.reverse()) acquired.release();
      return handle;
    }
    handle.relativePath = relativePath;
    handles.push(handle);
  }
  return handles;
}

function releaseHandles(handles) {
  for (const handle of [...handles].reverse()) {
    try { handle.release(); } catch {}
  }
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function recoverTransactionsUnlocked(stateRoot, projectHandle, options) {
  const txRoot = path.join(stateRoot, '.transactions');
  let names;
  try { names = fs.readdirSync(txRoot, { withFileTypes: true }); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, rc: 0, recovered: 0, rolled_back: 0, recovery_paths: [] };
    throw error;
  }
  let recovered = 0;
  let rolledBack = 0;
  const recoveryPaths = [];
  for (const dirent of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory()) continue;
    if (dirent.name.startsWith('recovery-')) {
      recoveryPaths.push(path.join(txRoot, dirent.name));
      continue;
    }
    if (!dirent.name.startsWith('tx-')) continue;
    const txDir = path.join(txRoot, dirent.name);
    const transactionPath = path.join(txDir, 'transaction.json');
    const markerPath = path.join(txDir, 'commit.json');
    let transactionRaw;
    try { transactionRaw = readJsonFile(transactionPath); }
    catch (error) {
      if (error && error.code === 'ENOENT' && !fs.existsSync(markerPath)) {
        cleanupTransactionDirectory(txDir);
        rolledBack += 1;
        continue;
      }
      recoveryPaths.push(markRecoveryAmbiguous(txDir, txRoot));
      continue;
    }
    const checked = validateTransaction(transactionRaw);
    if (!checked.valid) {
      recoveryPaths.push(markRecoveryAmbiguous(txDir, txRoot));
      continue;
    }
    if (!fs.existsSync(markerPath)) {
      cleanupTransactionDirectory(txDir);
      rolledBack += 1;
      continue;
    }
    let marker;
    try { marker = readJsonFile(markerPath); }
    catch {
      recoveryPaths.push(markRecoveryAmbiguous(txDir, txRoot));
      continue;
    }
    const markerCheck = validateCommitMarker(marker);
    if (!markerCheck.valid
      || marker.kind !== 'deep-evolve-transaction'
      || marker.transaction_id !== transactionRaw.transaction_id
      || marker.transaction_checksum !== transactionRaw.transaction_checksum) {
      recoveryPaths.push(markRecoveryAmbiguous(txDir, txRoot));
      continue;
    }
    try {
      const recoveryHandles = acquireRequiredLocks(
        stateRoot,
        transactionRaw.entries.map((entry) => entry.relative_path),
        options,
      );
      if (recoveryHandles.ok === false) throw Object.assign(new Error('recovery file lock held'), { code: 'lock_held' });
      try {
        installTransactionEntries(stateRoot, txDir, transactionRaw, projectHandle, {
          ...options,
          crashAt: null,
          onPhase: null,
          fileHandles: recoveryHandles,
        });
        cleanupTransactionDirectory(txDir);
        recovered += 1;
      } finally {
        releaseHandles(recoveryHandles);
      }
    } catch {
      recoveryPaths.push(markRecoveryAmbiguous(txDir, txRoot));
    }
  }
  if (recoveryPaths.length > 0) {
    return transactionError('transaction_recovery_ambiguous', 'ambiguous transaction retained for diagnosis', {
      recovered,
      rolled_back: rolledBack,
      recovery_paths: recoveryPaths,
    });
  }
  return { ok: true, rc: 0, recovered, rolled_back: rolledBack, recovery_paths: [] };
}

function commitCoordinationTransaction(stateRoot, replacements, options = {}) {
  fs.mkdirSync(stateRoot, { recursive: true });
  if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements) || Object.keys(replacements).length === 0) {
    return transactionError('invalid_transaction', 'replacements must be a non-empty object');
  }
  try {
    for (const name of Object.keys(replacements)) coordinationTarget(stateRoot, name);
  } catch (error) {
    return transactionError(error.code || 'invalid_coordination_path', error.message);
  }
  const projectHandle = acquireDirectoryLock(path.join(stateRoot, '.coordination-lock'), options);
  if (projectHandle.ok === false) return projectHandle;
  let fileHandles = [];
  try {
    const recovery = recoverTransactionsUnlocked(stateRoot, projectHandle, options);
    if (!recovery.ok) return recovery;
    fileHandles = acquireRequiredLocks(stateRoot, Object.keys(replacements), options);
    if (fileHandles.ok === false) return fileHandles;
    return commitLocked(stateRoot, replacements, projectHandle, { ...options, fileHandles });
  } finally {
    if (Array.isArray(fileHandles)) releaseHandles(fileHandles);
    projectHandle.release();
  }
}

function recoverTransactions(stateRoot, options = {}) {
  fs.mkdirSync(stateRoot, { recursive: true });
  const projectHandle = acquireDirectoryLock(path.join(stateRoot, '.coordination-lock'), options);
  if (projectHandle.ok === false) return projectHandle;
  try { return recoverTransactionsUnlocked(stateRoot, projectHandle, options); }
  finally { projectHandle.release(); }
}

function readCoordinationFiles(stateRoot, relativePaths, options = {}) {
  for (const name of relativePaths) coordinationTarget(stateRoot, name);
  const projectHandle = acquireDirectoryLock(path.join(stateRoot, '.coordination-lock'), options);
  if (projectHandle.ok === false) throw Object.assign(new Error('coordination lock held'), { code: 'lock_held' });
  try {
    const recovery = recoverTransactionsUnlocked(stateRoot, projectHandle, options);
    if (!recovery.ok) throw Object.assign(new Error(recovery.error.message), { code: recovery.error.code, rc: 2 });
    const result = {};
    for (const name of relativePaths) {
      const target = coordinationTarget(stateRoot, name);
      try { result[name] = fs.readFileSync(target, 'utf8'); }
      catch (error) {
        if (error && error.code === 'ENOENT') result[name] = '';
        else throw error;
      }
    }
    return result;
  } finally {
    projectHandle.release();
  }
}

function patchCoordinationFiles(stateRoot, relativePaths, mutator, options = {}) {
  if (typeof mutator !== 'function') throw new TypeError('patchCoordinationFiles requires a mutator');
  const names = [...new Set(relativePaths)].sort();
  for (const name of names) coordinationTarget(stateRoot, name);
  const projectHandle = acquireDirectoryLock(path.join(stateRoot, '.coordination-lock'), options);
  if (projectHandle.ok === false) throw Object.assign(new Error('coordination lock held'), { code: 'lock_held' });
  let fileHandles = [];
  try {
    const recovery = recoverTransactionsUnlocked(stateRoot, projectHandle, options);
    if (!recovery.ok) throw Object.assign(new Error(recovery.error.message), { code: recovery.error.code, rc: 2 });
    fileHandles = acquireRequiredLocks(stateRoot, names, options);
    if (fileHandles.ok === false) throw Object.assign(new Error('file lock held'), { code: 'lock_held' });
    const current = {};
    for (const name of names) {
      try { current[name] = fs.readFileSync(coordinationTarget(stateRoot, name), 'utf8'); }
      catch (error) {
        if (error && error.code === 'ENOENT') current[name] = '';
        else throw error;
      }
    }
    const replacements = mutator(Object.freeze({ ...current }));
    if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements)) {
      throw new TypeError('coordination mutator must return an object');
    }
    if (Object.keys(replacements).length !== names.length || names.some((name) => !Object.hasOwn(replacements, name))) {
      throw new Error('coordination mutator must replace exactly the locked files');
    }
    const result = commitLocked(stateRoot, replacements, projectHandle, { ...options, fileHandles });
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, rc: result.rc });
    return replacements;
  } finally {
    if (Array.isArray(fileHandles)) releaseHandles(fileHandles);
    projectHandle.release();
  }
}

// Task 3 session/history reads occasionally need to reconcile one coordination
// file while inspecting another (for example, session.yaml status versus the
// latest sessions.jsonl event). Keep that decision under the same project and
// file locks used by every other coordination transaction. The second callback
// argument distinguishes a missing optional path from a present zero-byte file.
// A replacement may cover a subset of the locked names, so callers can lock an
// absent potential participant without accidentally creating it. Returning
// null is a true read-only path: recovery still runs, but no replacement/temp/
// marker is created.
function mutateCoordinationFiles(stateRoot, relativePaths, mutator, options = {}) {
  if (typeof mutator !== 'function') throw new TypeError('mutateCoordinationFiles requires a mutator');
  const names = [...new Set(relativePaths)].sort();
  for (const name of names) coordinationTarget(stateRoot, name);
  const projectHandle = acquireDirectoryLock(path.join(stateRoot, '.coordination-lock'), options);
  if (projectHandle.ok === false) throw Object.assign(new Error('coordination lock held'), { code: 'lock_held' });
  let fileHandles = [];
  try {
    const recovery = recoverTransactionsUnlocked(stateRoot, projectHandle, options);
    if (!recovery.ok) throw Object.assign(new Error(recovery.error.message), { code: recovery.error.code, rc: 2 });
    fileHandles = acquireRequiredLocks(stateRoot, names, options);
    if (fileHandles.ok === false) throw Object.assign(new Error('file lock held'), { code: 'lock_held' });
    const current = {};
    const exists = {};
    for (const name of names) {
      try {
        current[name] = fs.readFileSync(coordinationTarget(stateRoot, name), 'utf8');
        exists[name] = true;
      }
      catch (error) {
        if (error && error.code === 'ENOENT') {
          current[name] = '';
          exists[name] = false;
        }
        else throw error;
      }
    }
    const replacements = mutator(Object.freeze({ ...current }), Object.freeze({
      exists: Object.freeze({ ...exists }),
    }));
    if (replacements === null) return { changed: false, files: current };
    if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements)) {
      throw new TypeError('coordination mutator must return an object or null');
    }
    const replacementNames = Object.keys(replacements);
    if (replacementNames.length === 0 || replacementNames.some((name) => !names.includes(name))) {
      throw new Error('coordination mutator must replace one or more locked files');
    }
    const result = commitLocked(stateRoot, replacements, projectHandle, { ...options, fileHandles });
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, rc: result.rc });
    return { changed: true, files: { ...current, ...replacements } };
  } finally {
    if (Array.isArray(fileHandles)) releaseHandles(fileHandles);
    projectHandle.release();
  }
}

function projectStateRootFor(sessionPath) {
  let current = path.dirname(path.resolve(sessionPath));
  for (;;) {
    if (path.basename(current) === '.deep-evolve') return current;
    const parent = path.dirname(current);
    if (parent === current) return path.dirname(path.resolve(sessionPath));
    current = parent;
  }
}

function sessionRelativePath(sessionPath, stateRoot) {
  const target = path.resolve(sessionPath);
  coordinationTarget(stateRoot, relativeCoordinationPath(stateRoot, target));
  return relativeCoordinationPath(stateRoot, target);
}

// Canonical storage validates the actual object. Legacy-shape tolerance is
// deliberately confined to the compatibility-only session.read boundary in
// deep-evolve-runtime.cjs; no canonical reader or mutator validates a projected
// object and then returns or persists different bytes.
function validateStoredSession(value) {
  validateSession(value);
  return value;
}

function readSession(sessionPath, options = {}) {
  const stateRoot = options.stateRoot || projectStateRootFor(sessionPath);
  const relative = sessionRelativePath(sessionPath, stateRoot);
  const text = readCoordinationFiles(stateRoot, [relative], options)[relative];
  if (text === '') throw Object.assign(new Error('session file missing'), { code: 'session_missing' });
  const value = parseStateDocument(text, { sourcePath: sessionPath });
  return validateStoredSession(value);
}

function writeSession(sessionPath, value, options = {}) {
  validateStoredSession(value);
  const stateRoot = options.stateRoot || projectStateRootFor(sessionPath);
  const relative = sessionRelativePath(sessionPath, stateRoot);
  const result = commitCoordinationTransaction(stateRoot, { [relative]: serializeStateDocument(value) }, options);
  if (!result.ok) throw Object.assign(new Error(result.error ? result.error.message : 'session write failed'), {
    code: result.error ? result.error.code : result.code,
    rc: result.rc,
  });
  return value;
}

function patchSession(sessionPath, mutator, options = {}) {
  if (typeof mutator !== 'function') throw new TypeError('patchSession requires a mutator');
  const stateRoot = options.stateRoot || projectStateRootFor(sessionPath);
  const relative = sessionRelativePath(sessionPath, stateRoot);
  const initialText = readCoordinationFiles(stateRoot, [relative], options)[relative];
  validateStoredSession(parseStateDocument(initialText, { sourcePath: sessionPath }));
  let next;
  patchCoordinationFiles(stateRoot, [relative], (files) => {
    const current = validateStoredSession(parseStateDocument(files[relative], { sourcePath: sessionPath }));
    next = mutator(current);
    validateStoredSession(next);
    return { [relative]: serializeStateDocument(next) };
  }, options);
  return next;
}

module.exports = {
  withDirectoryLock,
  renameWithRetry,
  atomicWriteFile,
  persistCommitMarker,
  validateCommitMarker,
  syncRenamedDirectoryBestEffort,
  readSession,
  writeSession,
  patchSession,
  commitCoordinationTransaction,
  patchCoordinationFiles,
  mutateCoordinationFiles,
  readCoordinationFiles,
  recoverTransactions,
  validateStoredSession,
  sha256Digest,
};
