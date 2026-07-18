#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');

const EXPECTED_VERSION = '2.1.207 (Claude Code)';
const MARKETPLACE_NAME = 'deep-evolve-loopback';
const COPY_ENTRIES = [
  'package.json',
  '.codex-plugin',
  '.claude-plugin',
  'hooks',
  'agents',
  'skills',
  'templates',
];
const CREDENTIAL_NAME = /(?:^auth\.json$|oauth|credential|token|keychain)/i;
const TEST_FAKE_HOST_ENV = 'DEEP_EVOLVE_TEST_ONLY_FAKE_HOST';

function fatal(message, code = 'installed_claude_smoke_failed') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] || null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(target) {
  return sha256(fs.readFileSync(target));
}

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function assertSourceEntry(sourceRoot, relative) {
  const target = path.join(sourceRoot, relative);
  if (!fs.existsSync(target)) throw fatal(`source entry is missing: ${relative}`);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw fatal(`source entry must not be a symlink: ${relative}`);
  return target;
}

function copyEntry(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw fatal(`marketplace copy refuses symlink: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source).sort()) {
      copyEntry(path.join(source, name), path.join(destination, name));
    }
    return;
  }
  if (!stat.isFile()) throw fatal(`marketplace copy refuses non-file: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function fileManifest(root) {
  const output = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const relative = path.relative(root, target).split(path.sep).join('/');
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw fatal(`manifest refuses symlink: ${relative}`);
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile()) output.push({ path: relative, sha256: sha256File(target) });
      else throw fatal(`manifest refuses non-file: ${relative}`);
    }
  };
  visit(root);
  return output;
}

function marketplaceCopy(sourceRoot, marketplaceRoot) {
  const pluginRoot = path.join(marketplaceRoot, 'plugins', 'deep-evolve');
  fs.mkdirSync(pluginRoot, { recursive: true });
  for (const relative of COPY_ENTRIES) {
    copyEntry(assertSourceEntry(sourceRoot, relative), path.join(pluginRoot, relative));
  }
  const manifestRoot = path.join(marketplaceRoot, '.claude-plugin');
  fs.mkdirSync(manifestRoot, { recursive: true });
  writeJson(path.join(manifestRoot, 'marketplace.json'), {
    name: MARKETPLACE_NAME,
    owner: { name: MARKETPLACE_NAME },
    plugins: [{ name: 'deep-evolve', source: './plugins/deep-evolve' }],
  });
  return { pluginRoot, manifest: fileManifest(pluginRoot) };
}

function createActiveProject(projectRoot) {
  const sessionId = 'session-current';
  const sessionRoot = path.join(projectRoot, '.deep-evolve', sessionId);
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.deep-evolve', 'current.json'),
    `${JSON.stringify({ session_id: sessionId })}\n`);
  fs.writeFileSync(path.join(sessionRoot, 'session.yaml'), `${JSON.stringify({
    session_id: sessionId,
    deep_evolve_version: '3.4.3',
    status: 'active',
    created_at: '2026-07-14T00:00:00Z',
  }, null, 2)}\n`);
  const targetPath = path.join(sessionRoot, 'prepare.cjs');
  fs.writeFileSync(targetPath, 'before\n');
  return { sessionId, sessionRoot, targetPath };
}

function collectObjects(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, output);
  } else if (value && typeof value === 'object') {
    output.push(value);
    for (const item of Object.values(value)) collectObjects(item, output);
  }
  return output;
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output.trim());
  } catch {
    throw fatal(`${label} did not emit one JSON document`,
      'unsupported_pinned_host_install_contract');
  }
}

function assertEnabledPlugin(output) {
  const parsed = parseJsonOutput(output, 'claude plugin list');
  const serialized = JSON.stringify(parsed);
  if (!serialized.includes('deep-evolve') || !serialized.includes(MARKETPLACE_NAME)) {
    throw fatal('Claude plugin list did not retain the expected marketplace identity',
      'unsupported_pinned_host_install_contract');
  }
  const candidates = collectObjects(parsed).filter((value) => {
    const identity = `${value.name || ''} ${value.id || ''} ${value.plugin || ''}`;
    return identity.includes('deep-evolve');
  });
  if (!candidates.some((value) => value.enabled === true
    || String(value.status || '').toLowerCase() === 'enabled')) {
    throw fatal('Claude plugin list did not report deep-evolve enabled',
      'unsupported_pinned_host_install_contract');
  }
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

function findPluginRoots(searchRoots, marker, excluded) {
  const found = new Set();
  const visit = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    if (fs.existsSync(path.join(directory, marker))) {
      const real = fs.realpathSync(directory);
      if (!excluded.some((root) => isInside(real, root))) found.add(real);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      visit(path.join(directory, entry.name));
    }
  };
  for (const root of searchRoots) visit(root);
  return [...found].sort();
}

function authenticateInstalledCache({ candidates, sourceManifest }) {
  const expected = JSON.stringify(sourceManifest);
  const matches = candidates.filter((candidate) => JSON.stringify(fileManifest(candidate)) === expected)
    .filter((candidate) => candidate.split(path.sep)
    .some((component) => component.toLowerCase() === 'cache'));
  if (matches.length !== 1) {
    throw fatal(`expected one authenticated installed cache, found ${matches.length}`,
      'unsupported_pinned_host_install_contract');
  }
  const installed = matches[0];
  const plugin = JSON.parse(fs.readFileSync(path.join(installed, '.claude-plugin', 'plugin.json'),
    'utf8'));
  if (plugin.hooks !== './hooks/hooks.claude.json' || plugin.hooks === './hooks/hooks.json') {
    throw fatal('installed Claude plugin does not point only to hooks.claude.json',
      'unsupported_pinned_host_install_contract');
  }
  const hooks = JSON.parse(fs.readFileSync(path.join(installed, 'hooks', 'hooks.claude.json'),
    'utf8'));
  const commands = collectObjects(hooks)
    .filter((value) => value.type === 'command')
    .map((value) => ({ command: value.command, args: value.args }));
  if (commands.length !== 1 || commands[0].command !== 'node'
    || !Array.isArray(commands[0].args) || commands[0].args.length !== 1
    || !commands[0].args[0].includes('${CLAUDE_PLUGIN_ROOT}')) {
    throw fatal('installed Claude hook command is not the shell-free shared Node guard',
      'unsupported_pinned_host_install_contract');
  }
  return { root: installed, manifest: fileManifest(installed) };
}

function credentialArtifacts(roots) {
  const output = [];
  const visit = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        output.push({ path: target, kind: 'keychain_mount_or_symlink' });
      } else if (entry.isDirectory()) {
        if (CREDENTIAL_NAME.test(entry.name)) {
          output.push({ path: target, kind: 'credential_or_OAuth_directory' });
        } else {
          visit(target);
        }
      } else if (entry.isFile() && CREDENTIAL_NAME.test(entry.name)) {
        output.push({ path: target, kind: 'credential_or_OAuth_artifact' });
      }
    }
  };
  for (const root of roots) visit(root);
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function commandRecord(command, args, result) {
  return {
    command,
    argv: [...args],
    exit_code: result.code,
    signal: result.signal,
    stdout_sha256: result.stdoutSha256,
    stderr_sha256: result.stderrSha256,
    stdout_bytes: result.stdoutBytes.length,
    stderr_bytes: result.stderrBytes.length,
  };
}

function runCommand({ command, prefix, args, cwd, env, timeoutMs, artifactDir, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const stdoutBytes = Buffer.concat(stdout);
      const stderrBytes = Buffer.concat(stderr);
      const stdoutSha256 = sha256(stdoutBytes);
      const stderrSha256 = sha256(stderrBytes);
      fs.writeFileSync(path.join(artifactDir, `${label}.stdout.log`), stdoutBytes);
      fs.writeFileSync(path.join(artifactDir, `${label}.stderr.log`), stderrBytes);
      let stdoutText;
      let stderrText;
      try {
        stdoutText = new TextDecoder('utf-8', { fatal: true }).decode(stdoutBytes);
        stderrText = new TextDecoder('utf-8', { fatal: true }).decode(stderrBytes);
      } catch {
        reject(fatal(`${label} emitted invalid UTF-8`, 'invalid_host_stream'));
        return;
      }
      const result = {
        code,
        signal,
        stdout: stdoutText,
        stderr: stderrText,
        stdoutBytes,
        stderrBytes,
        stdoutSha256,
        stderrSha256,
      };
      if (timedOut) reject(fatal(`${label} timed out`, 'host_timeout'));
      else resolve(result);
    });
  });
}

async function requireSuccess(context, args, label, timeoutMs = 60_000) {
  const result = await runCommand({ ...context, args, label, timeoutMs });
  context.commandReceipts.push(commandRecord(context.command, [...context.prefix, ...args], result));
  if (result.code !== 0) {
    throw fatal(`${label} exited ${result.code}: ${result.stderr || result.stdout}`,
      'unsupported_pinned_host_install_contract');
  }
  return result;
}

function requireMetadata(argv) {
  const bootstrapCommit = valueAfter(argv, '--bootstrap-commit');
  const runId = valueAfter(argv, '--run-id');
  const jobId = valueAfter(argv, '--job-id');
  const runAttempt = Number(valueAfter(argv, '--run-attempt'));
  if (!/^[0-9a-f]{40}$/.test(bootstrapCommit || '') || !runId || !jobId || runAttempt !== 1) {
    throw fatal('bootstrap commit, run/job IDs, and first run attempt are required',
      'invalid_provenance');
  }
  return { bootstrapCommit, runId, jobId, runAttempt };
}

async function acceptance(argv) {
  const sourceRoot = fs.realpathSync(path.resolve(
    valueAfter(argv, '--source-root') || path.join(__dirname, '..')));
  const hostCommand = valueAfter(argv, '--host-command');
  const hostPrefix = valueAfter(argv, '--host-prefix');
  const artifactDir = valueAfter(argv, '--artifact-dir');
  const testFakeHost = argv.includes('--test-fake-host');
  if (!hostCommand || !artifactDir) {
    throw fatal('--host-command and --artifact-dir are required');
  }
  const metadata = requireMetadata(argv);
  if (testFakeHost) {
    if (process.env[TEST_FAKE_HOST_ENV] !== '1' || !hostPrefix
      || metadata.bootstrapCommit !== '0'.repeat(40)
      || metadata.runId !== 'fake-run' || metadata.jobId !== 'fake-job') {
      throw fatal('test fake host requires the explicit non-authoritative test contract',
        'invalid_provenance');
    }
  } else if (process.env[TEST_FAKE_HOST_ENV] === '1') {
    throw fatal('test fake host environment cannot enter an authoritative run',
      'invalid_provenance');
  }
  fs.mkdirSync(path.resolve(artifactDir), { recursive: true });
  const exactArtifactDir = fs.realpathSync(path.resolve(artifactDir));
  const isolatedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deep evolve claude ')));
  if (isInside(exactArtifactDir, sourceRoot)) {
    throw fatal('artifact directory must not be inside the repository');
  }

  const receipt = {
    schema_version: 1,
    kind: 'deep_evolve_installed_host_smoke',
    host: 'claude',
    version: '2.1.207',
    diagnostic_only: testFakeHost,
    capture_source: testFakeHost ? 'test_fake_host_non_authority' : 'actual_exact_pinned_host',
    fixture_authority: false,
    source_root: sourceRoot,
    isolated_root: isolatedRoot,
    command_receipts: [],
    ok: false,
  };
  writeJson(path.join(exactArtifactDir, 'claude-smoke-opening.json'), receipt);

  let driver = null;
  try {
    const home = path.join(isolatedRoot, 'home with spaces');
    const claudeConfigDir = path.join(isolatedRoot, 'claude config with spaces');
    const projectRoot = path.join(isolatedRoot, 'project with spaces');
    const marketplaceRoot = path.join(isolatedRoot, 'marketplace with spaces');
    for (const directory of [home, claudeConfigDir, projectRoot]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const project = createActiveProject(projectRoot);
    const protectedWritePath = path.join(project.sessionRoot, 'program.md');
    if (fs.existsSync(protectedWritePath)) {
      throw fatal('protected program.md must be absent before host invocation',
        'protected_write_target_preexisting');
    }
    const before = fs.readFileSync(project.targetPath);
    const beforeSha256 = sha256(before);
    const copied = marketplaceCopy(sourceRoot, marketplaceRoot);
    writeJson(path.join(exactArtifactDir, 'marketplace-copy-manifest.json'), copied.manifest);

    const credentialRoots = [home, claudeConfigDir];
    const openingCredentials = credentialArtifacts(credentialRoots);
    if (openingCredentials.length !== 0) {
      throw fatal('isolated roots unexpectedly contain an auth or credential artifact',
        'auth_store_boundary_violation');
    }

    const helperPath = path.join(sourceRoot, 'scripts', 'host-loopback-model.cjs');
    const {
      LOOPBACK_MODEL,
      buildIsolatedHostEnv,
      createLoopbackDriver,
      normalizeActualHostRecords,
    } = require(helperPath);
    const driverReceiptPath = path.join(exactArtifactDir, 'claude-loopback-driver-receipt.json');
    if (!testFakeHost) {
      driver = await createLoopbackDriver({
        host: 'claude', targetPath: protectedWritePath, receiptPath: driverReceiptPath,
      });
    }
    const hostEnv = buildIsolatedHostEnv({
      host: 'claude', home,
      codexHome: path.join(isolatedRoot, 'unused codex home'),
      claudeConfigDir,
      origin: testFakeHost ? 'http://127.0.0.1:9' : driver.origin,
      proxyOrigin: testFakeHost ? 'http://127.0.0.1:9' : driver.proxyOrigin,
    });
    for (const directory of [hostEnv.APPDATA, hostEnv.LOCALAPPDATA, hostEnv.TMP]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const installEnv = { ...hostEnv };
    delete installEnv.ANTHROPIC_API_KEY;
    delete installEnv.ANTHROPIC_BASE_URL;
    writeJson(path.join(exactArtifactDir, 'isolated-opening-inventory.json'),
      fileManifest(isolatedRoot));
    writeJson(path.join(exactArtifactDir, 'credential-scan-opening.json'), openingCredentials);

    const baseContext = {
      command: fs.realpathSync(path.resolve(hostCommand)),
      prefix: hostPrefix ? [fs.realpathSync(path.resolve(hostPrefix))] : [],
      cwd: projectRoot,
      artifactDir: exactArtifactDir,
      commandReceipts: receipt.command_receipts,
    };
    const installContext = { ...baseContext, env: installEnv };
    const version = await requireSuccess(installContext, ['--version'], 'claude-version');
    if (version.stdout.trim() !== EXPECTED_VERSION || version.stderr !== '') {
      throw fatal(`unexpected Claude version output: ${JSON.stringify(version.stdout)}`,
        'unsupported_pinned_host_install_contract');
    }

    await requireSuccess(installContext,
      ['plugin', 'marketplace', 'add', marketplaceRoot, '--scope', 'user'],
      'claude-marketplace-add');
    await requireSuccess(installContext,
      ['plugin', 'install', `deep-evolve@${MARKETPLACE_NAME}`, '--scope', 'user'],
      'claude-plugin-install');
    const list = await requireSuccess(installContext,
      ['plugin', 'list', '--json'], 'claude-plugin-list');
    assertEnabledPlugin(list.stdout);

    const candidates = findPluginRoots([claudeConfigDir, home], '.claude-plugin/plugin.json', [
      fs.realpathSync(copied.pluginRoot),
      fs.realpathSync(sourceRoot),
    ]);
    const installed = authenticateInstalledCache({ candidates, sourceManifest: copied.manifest });
    if (fs.realpathSync(installed.root) === fs.realpathSync(copied.pluginRoot)
      || fs.realpathSync(installed.root) === fs.realpathSync(sourceRoot)) {
      throw fatal('Claude must execute an installed cache distinct from the source tree',
        'unsupported_pinned_host_install_contract');
    }
    writeJson(path.join(exactArtifactDir, 'installed-cache-manifest.json'), installed.manifest);

    const fixedPrompt = [
      'Use Write exactly once.',
      `Create only the exact file ${protectedWritePath}.`,
      'Write its content as after.',
      'Do not use another tool and do not modify another file.',
    ].join(' ');
    const hostArgs = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-hook-events',
      '--no-session-persistence',
      '--no-chrome',
      '--disable-slash-commands',
      '--permission-mode',
      'bypassPermissions',
      '--tools',
      'Write',
      '--model',
      LOOPBACK_MODEL,
      '--setting-sources',
      'user',
      fixedPrompt,
    ];
    const hostContext = { ...baseContext, env: hostEnv };
    const preInvocationCredentials = credentialArtifacts(credentialRoots);
    writeJson(path.join(exactArtifactDir, 'credential-scan-pre-invocation.json'),
      preInvocationCredentials);
    if (preInvocationCredentials.length !== 0) {
      throw fatal('install persisted an auth, credential, OAuth, or keychain artifact before host invocation',
        'auth_store_boundary_violation');
    }
    const host = await requireSuccess(hostContext, hostArgs, 'claude-host-stream', 120_000);
    const after = fs.readFileSync(project.targetPath);
    const afterSha256 = sha256(after);
    if (!before.equals(after) || beforeSha256 !== afterSha256) {
      throw fatal('protected prepare.cjs bytes changed', 'protected_bytes_changed');
    }
    if (fs.existsSync(protectedWritePath)) {
      throw fatal('protected program.md was created despite hook denial',
        'protected_write_target_created');
    }
    if (!/Deep Evolve Guard/.test(`${host.stdout}\n${host.stderr}`)) {
      throw fatal('actual Claude stream did not expose one Deep Evolve denial',
        'missing_actual_hook_denial');
    }

    let driverReceipt = null;
    if (!testFakeHost) {
      await driver.close();
      driverReceipt = await driver.completedReceipt;
      driver = null;
      if (!driverReceipt.success || driverReceipt.provider_request_count !== 2
        || driverReceipt.external_network_attempt_count !== 0) {
        throw fatal('loopback driver did not complete the exact two-request state machine',
          'loopback_driver_failed');
      }
    }

    const closingCredentials = credentialArtifacts(credentialRoots);
    if (closingCredentials.length !== 0) {
      throw fatal('host persisted an auth, credential, OAuth, or keychain artifact',
        'auth_store_boundary_violation');
    }
    writeJson(path.join(exactArtifactDir, 'credential-scan-closing.json'), closingCredentials);
    writeJson(path.join(exactArtifactDir, 'isolated-closing-inventory.json'),
      fileManifest(isolatedRoot));

    if (testFakeHost) {
      // This branch proves orchestration only. Direct HTTP tests cover the loopback driver;
      // fake-host output is never normalized and can never become retained fixture authority.
      Object.assign(receipt, {
        ok: true,
        diagnostic_only: true,
        capture_source: 'test_fake_host_non_authority',
        fixture_authority: false,
        network_authority: false,
        marketplace_copy_root: copied.pluginRoot,
        marketplace_copy_manifest_sha256: sha256(JSON.stringify(copied.manifest)),
        installed_cache_root: installed.root,
        installed_cache_manifest_sha256: sha256(JSON.stringify(installed.manifest)),
        target_path: protectedWritePath,
        sealed_prepare_path: project.targetPath,
        protected_target_created: false,
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        external_network_attempt_count: 0,
        credential_artifact_count: 0,
      });
      writeJson(path.join(exactArtifactDir, 'claude-fake-orchestration-receipt.json'), receipt);
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
      return;
    }

    const evidence = {
      host: 'claude',
      version: '2.1.207',
      capture_source: 'actual_exact_pinned_host',
      model_source: 'deterministic_loopback_protocol_v1',
      bootstrap_commit: metadata.bootstrapCommit,
      run_id: metadata.runId,
      job_id: metadata.jobId,
      run_attempt: metadata.runAttempt,
      same_head_rerun: false,
      driver_sha256: sha256File(helperPath),
      raw_stream_sha256: sha256(host.stdoutBytes),
      raw_stream_bytes: host.stdoutBytes,
      raw_stderr_sha256: sha256(host.stderrBytes),
      raw_stderr_bytes: host.stderrBytes,
      session_root: project.sessionRoot,
      attempt_count: 1,
      denial_count: 1,
      successful_mutation_count: 0,
      vendor_cloud_entitlement_proven: false,
    };
    const normalized = normalizeActualHostRecords({
      host: 'claude', rawStdout: host.stdoutBytes, rawStderr: host.stderrBytes,
      isolatedRoot: projectRoot, evidence,
    });
    if (normalized.acceptedEventPaths.raw_stream_sha256 !== sha256(host.stdoutBytes)
      || normalized.acceptedEventPaths.raw_stderr_sha256 !== sha256(host.stderrBytes)) {
      throw fatal('normalized Claude hashes differ from authenticated host Buffers',
        'invalid_provenance');
    }
    writeJson(path.join(exactArtifactDir, 'claude-normalized-records.json'), normalized);
    fs.writeFileSync(path.join(exactArtifactDir, 'normalized-protected-edit-attempt.jsonl'),
      `${JSON.stringify(normalized.attempt)}\n`);
    fs.writeFileSync(path.join(exactArtifactDir, 'normalized-hook-denial.jsonl'),
      `${JSON.stringify(normalized.denial)}\n`);
    writeJson(path.join(exactArtifactDir, 'normalized-accepted-event-paths.json'),
      normalized.acceptedEventPaths);

    Object.assign(receipt, {
      ok: true,
      loopback_model: LOOPBACK_MODEL,
      public_sentinel_scope: 'final_loopback_host_step_only',
      bootstrap_commit: metadata.bootstrapCommit,
      run_id: metadata.runId,
      job_id: metadata.jobId,
      run_attempt: 1,
      same_head_rerun: false,
      marketplace_copy_root: copied.pluginRoot,
      marketplace_copy_manifest_sha256: sha256(JSON.stringify(copied.manifest)),
      installed_cache_root: installed.root,
      installed_cache_manifest_sha256: sha256(JSON.stringify(installed.manifest)),
      target_path: protectedWritePath,
      sealed_prepare_path: project.targetPath,
      protected_target_created: false,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      raw_stdout_sha256: normalized.acceptedEventPaths.raw_stream_sha256,
      raw_stderr_sha256: normalized.acceptedEventPaths.raw_stderr_sha256,
      driver_sha256: evidence.driver_sha256,
      driver_receipt_sha256: sha256File(driverReceiptPath),
      external_network_attempt_count: 0,
      credential_artifact_count: 0,
      accepted_pointers: normalized.acceptedEventPaths.accepted_pointers,
      vendor_cloud_entitlement_proven: false,
      fixture_authority: true,
    });
    writeJson(path.join(exactArtifactDir, 'claude-smoke-receipt.json'), receipt);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    receipt.error = { code: error.code || 'installed_claude_smoke_failed', message: error.message };
    writeJson(path.join(exactArtifactDir, 'claude-smoke-failure.json'), receipt);
    throw error;
  } finally {
    if (driver) await driver.close();
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

acceptance(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`[deep-evolve/claude-smoke] ${error.code || 'error'}: ${error.message}\n`);
  process.exitCode = 2;
});
