#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');

const EXPECTED_VERSION = 'codex-cli 0.144.1';
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
const TEST_BOOTSTRAP_MUTATION_ENV = 'DEEP_EVOLVE_TEST_ONLY_BOOTSTRAP_MUTATION';

function fatal(message, code = 'installed_codex_smoke_failed') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] || null;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
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

function diagnostic(argv) {
  const projectRoot = valueAfter(argv, '--project-root');
  const target = valueAfter(argv, '--target');
  if (!projectRoot || !target) throw fatal('--project-root and --target are required');
  const { evaluateHook } = require('../hooks/scripts/protect-readonly.cjs');
  const result = evaluateHook({
    tool_name: 'apply_patch',
    tool_input: {
      command: `*** Begin Patch\n*** Update File: ${path.resolve(target)}\n@@\n-before\n+after\n*** End Patch`,
    },
  }, {}, path.resolve(projectRoot));
  const marked = result.exitCode === 2 && /Deep Evolve Guard/.test(result.output);
  process.stderr.write('[deep-evolve/codex-smoke] diagnostic only; this does not prove installed-host hook registration.\n');
  process.stdout.write(`${JSON.stringify({
    diagnostic_only: true,
    ok: marked,
    guard_exit_code: result.exitCode,
    marker: marked ? 'Deep Evolve Guard' : null,
  })}\n`);
  if (!marked) throw fatal('diagnostic guard marker was absent');
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
  const manifestRoot = path.join(marketplaceRoot, '.agents', 'plugins');
  fs.mkdirSync(manifestRoot, { recursive: true });
  writeJson(path.join(manifestRoot, 'marketplace.json'), {
    name: MARKETPLACE_NAME,
    interface: { displayName: 'Deep Evolve Loopback' },
    plugins: [{
      name: 'deep-evolve',
      source: { source: 'local', path: './plugins/deep-evolve' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
      category: 'Coding',
    }],
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
  const parsed = parseJsonOutput(output, 'codex plugin list');
  const serialized = JSON.stringify(parsed);
  if (!serialized.includes('deep-evolve') || !serialized.includes(MARKETPLACE_NAME)) {
    throw fatal('Codex plugin list did not retain the expected marketplace identity',
      'unsupported_pinned_host_install_contract');
  }
  const candidates = collectObjects(parsed).filter((value) => {
    const identity = `${value.name || ''} ${value.id || ''} ${value.plugin || ''}`;
    return identity.includes('deep-evolve');
  });
  if (!candidates.some((value) => value.enabled === true
    || String(value.status || '').toLowerCase() === 'enabled')) {
    throw fatal('Codex plugin list did not report deep-evolve enabled',
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
  const hooks = JSON.parse(fs.readFileSync(path.join(installed, 'hooks', 'hooks.json'), 'utf8'));
  const commands = collectObjects(hooks)
    .map((value) => value.command)
    .filter((value) => typeof value === 'string');
  if (commands.length !== 1 || !commands[0].includes('${PLUGIN_ROOT}')) {
    throw fatal('installed Codex default hook manifest is not exact',
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
        output.push({ path: target, kind: 'symlink_mount' });
      } else if (entry.isDirectory()) {
        if (CREDENTIAL_NAME.test(entry.name)) {
          output.push({ path: target, kind: 'credential_directory' });
        } else {
          visit(target);
        }
      } else if (entry.isFile() && CREDENTIAL_NAME.test(entry.name)) {
        output.push({ path: target, kind: 'credential_artifact' });
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
      if (timedOut) {
        reject(fatal(`${label} timed out`, 'host_timeout'));
      } else {
        resolve(result);
      }
    });
  });
}

function startObservedDenyProxy() {
  const attempts = [];
  const record = (request) => {
    attempts.push({ method: request.method || null, url: request.url || null,
      host: request.headers?.host || null });
  };
  const server = http.createServer((request, response) => {
    record(request);
    response.writeHead(502, { 'content-type': 'text/plain', connection: 'close' });
    response.end('external network denied\n');
  });
  server.on('connect', (request, socket) => {
    record(request);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        snapshot() {
          return {
            schema_version: 1,
            external_network_attempt_count: attempts.length,
            external_network_attempts: attempts.map((attempt) => ({ ...attempt })),
          };
        },
        close() {
          return new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          });
        },
      });
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

function isolatedGitEnvironment({ home, gitConfigPath, proxyOrigin, trace2Path = null }) {
  const env = {
    HOME: home,
    USERPROFILE: home,
    PATH: process.env.PATH || '',
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
    HTTP_PROXY: proxyOrigin,
    HTTPS_PROXY: proxyOrigin,
    ALL_PROXY: proxyOrigin,
    NO_PROXY: '127.0.0.1,localhost',
  };
  for (const key of ['SystemRoot', 'ComSpec', 'PATHEXT']) {
    if (typeof process.env[key] === 'string' && process.env[key]) env[key] = process.env[key];
  }
  if (trace2Path) env.GIT_TRACE2_EVENT = trace2Path;
  return env;
}

async function createCodexLocalBootstrap({ isolatedRoot, codexHome, artifactDir, testFakeHost,
  helper, proxyOrigin, proxySnapshot }) {
  const mutation = testFakeHost
    ? (process.env[TEST_BOOTSTRAP_MUTATION_ENV] || 'clean')
    : 'clean';
  const proxyReceiptPath = path.join(artifactDir,
    'codex-local-bootstrap-deny-proxy-receipt.json');
  const failurePath = path.join(artifactDir, 'codex-local-bootstrap-failure.json');
  writeJson(proxyReceiptPath, proxySnapshot());

  try {
    const catalog = helper.buildCodexModelCatalog();
    helper.validateCodexModelCatalog(catalog);
    const catalogPath = path.join(codexHome, 'loopback-model-catalog.json');
    writeJson(catalogPath, catalog);

    const workRepoPath = path.join(isolatedRoot, 'curated-work');
    const gitRemotesRoot = path.join(isolatedRoot, 'git-remotes');
    const bareRemotePath = path.join(gitRemotesRoot, 'openai', 'plugins.git');
    const gitConfigPath = path.join(isolatedRoot, 'git-global.config');
    fs.mkdirSync(workRepoPath, { recursive: true });
    fs.mkdirSync(path.dirname(bareRemotePath), { recursive: true });
    fs.writeFileSync(gitConfigPath, '');

    const curatedFiles = [
      {
        path: '.agents/plugins/api_marketplace.json',
        value: {
          name: 'openai-api-curated',
          interface: { displayName: 'OpenAI Curated' },
          plugins: [],
        },
      },
      {
        path: '.agents/plugins/marketplace.json',
        value: { name: 'openai-curated', plugins: [] },
      },
    ];
    for (const entry of curatedFiles) writeJson(path.join(workRepoPath, entry.path), entry.value);
    if (mutation === 'missing-curated-marketplace') {
      fs.unlinkSync(path.join(workRepoPath, '.agents/plugins/marketplace.json'));
    } else if (mutation === 'missing-api-marketplace') {
      fs.unlinkSync(path.join(workRepoPath, '.agents/plugins/api_marketplace.json'));
    }
    for (const entry of curatedFiles) {
      if (!fs.existsSync(path.join(workRepoPath, entry.path))) {
        throw fatal(`curated marketplace is missing: ${entry.path}`,
          'invalid_local_curated_marketplace');
      }
    }

    const trace2Path = testFakeHost && process.env.GIT_TRACE2_EVENT
      ? path.resolve(process.env.GIT_TRACE2_EVENT)
      : path.join(artifactDir, 'codex-bootstrap-git-trace2.jsonl');
    const gitEnv = isolatedGitEnvironment({
      home: path.join(isolatedRoot, 'home with spaces'),
      gitConfigPath,
      proxyOrigin,
      trace2Path,
    });
    const gitContext = {
      command: 'git',
      prefix: [],
      cwd: isolatedRoot,
      env: gitEnv,
      artifactDir,
      commandReceipts: [],
    };
    await requireSuccess(gitContext, ['init', '--initial-branch=main', workRepoPath],
      'codex-bootstrap-git-init');
    await requireSuccess(gitContext, ['-C', workRepoPath, 'add', '--all'],
      'codex-bootstrap-git-add');
    await requireSuccess(gitContext, ['-C', workRepoPath,
      '-c', 'user.name=Deep Evolve', '-c', 'user.email=deep-evolve@example.invalid',
      'commit', '-m', 'local curated bootstrap'], 'codex-bootstrap-git-commit');
    await requireSuccess(gitContext, ['init', '--bare', '--initial-branch=main', bareRemotePath],
      'codex-bootstrap-git-bare-init');
    await requireSuccess(gitContext, ['-C', workRepoPath, 'remote', 'add', 'origin', bareRemotePath],
      'codex-bootstrap-git-remote-add');
    await requireSuccess(gitContext, ['-C', workRepoPath, 'push', 'origin', 'HEAD:main'],
      'codex-bootstrap-git-push');
    const localCommitResult = await requireSuccess(gitContext,
      ['-C', workRepoPath, 'rev-parse', 'HEAD'], 'codex-bootstrap-local-head');
    const bareHeadResult = await requireSuccess(gitContext,
      ['--git-dir', bareRemotePath, 'rev-parse', 'HEAD'], 'codex-bootstrap-bare-head');
    const localCommit = localCommitResult.stdout.trim();
    const bareRemoteHead = bareHeadResult.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(localCommit) || bareRemoteHead !== localCommit) {
      throw fatal('local curated Git commit and bare remote HEAD differ',
        'invalid_local_curated_git');
    }

    const rewriteRoot = mutation === 'missing-local-git-remote'
      ? path.join(isolatedRoot, 'missing-git-remotes') : gitRemotesRoot;
    const localRemoteUrl = helper.directoryFileUrl(rewriteRoot);
    const gitConfigSource = `[url "${localRemoteUrl}"]\n\tinsteadOf = https://github.com/\n`;
    fs.writeFileSync(gitConfigPath, gitConfigSource);
    const lsRemoteArgs = ['ls-remote', 'https://github.com/openai/plugins.git', 'HEAD'];
    const lsRemoteResult = await runCommand({
      ...gitContext,
      args: lsRemoteArgs,
      label: 'codex-bootstrap-git-ls-remote',
      timeoutMs: 60_000,
    });
    if (mutation === 'missing-local-git-remote') {
      if (lsRemoteResult.code === 0) {
        throw fatal('missing local Git rewrite root unexpectedly succeeded',
          'invalid_local_curated_git');
      }
      throw fatal(`local git ls-remote failed as required: ${lsRemoteResult.stderr}`,
        'local_git_transport_failure');
    }
    if (lsRemoteResult.code !== 0 || lsRemoteResult.stderr !== ''
      || lsRemoteResult.stdout !== `${bareRemoteHead}\tHEAD\n`) {
      throw fatal(`local git ls-remote contract failed: ${lsRemoteResult.stderr}`,
        'invalid_local_curated_git');
    }
    const observedProxy = proxySnapshot();
    writeJson(proxyReceiptPath, observedProxy);
    if (observedProxy.external_network_attempt_count !== 0) {
      throw fatal('local Git bootstrap attempted external network access',
        'external_network_attempt');
    }

    const curatedFileHashes = curatedFiles.map((entry) => ({
      path: entry.path,
      sha256: sha256File(path.join(workRepoPath, entry.path)),
    })).sort((left, right) => left.path.localeCompare(right.path));
    const bootstrap = {
      schema_version: 1,
      isolated_root: isolatedRoot,
      catalog_path: catalogPath,
      catalog,
      catalog_sha256: sha256File(catalogPath),
      git_config_path: gitConfigPath,
      git_config_source: gitConfigSource,
      git_config_sha256: sha256(gitConfigSource),
      work_repo_path: workRepoPath,
      bare_remote_path: bareRemotePath,
      local_remote_url: localRemoteUrl,
      local_commit: localCommit,
      bare_remote_head: bareRemoteHead,
      curated_files: curatedFileHashes,
      ls_remote: {
        argv: ['git', ...lsRemoteArgs],
        exit_code: lsRemoteResult.code,
        stdout: lsRemoteResult.stdout,
        stdout_sha256: sha256(lsRemoteResult.stdout),
        stderr: lsRemoteResult.stderr,
        stderr_sha256: sha256(lsRemoteResult.stderr),
        external_network_attempt_count: observedProxy.external_network_attempt_count,
      },
    };
    writeJson(path.join(artifactDir, 'codex-local-bootstrap-receipt.json'), bootstrap);
    return { catalogPath, gitConfigPath, bootstrap };
  } catch (error) {
    const observedProxy = proxySnapshot();
    writeJson(proxyReceiptPath, observedProxy);
    writeJson(failurePath, {
      schema_version: 1,
      mutation,
      error: { code: error.code || 'local_bootstrap_failed', message: error.message },
      external_network_attempt_count: observedProxy.external_network_attempt_count,
    });
    throw error;
  }
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
  const testFakeHost = hasFlag(argv, '--test-fake-host');
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
  const isolatedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deep evolve codex ')));
  if (isInside(exactArtifactDir, sourceRoot)) {
    throw fatal('artifact directory must not be inside the repository');
  }

  const receipt = {
    schema_version: 1,
    kind: 'deep_evolve_installed_host_smoke',
    host: 'codex',
    version: '0.144.1',
    diagnostic_only: testFakeHost,
    capture_source: testFakeHost ? 'test_fake_host_non_authority' : 'actual_exact_pinned_host',
    fixture_authority: false,
    source_root: sourceRoot,
    isolated_root: isolatedRoot,
    command_receipts: [],
    ok: false,
  };
  writeJson(path.join(exactArtifactDir, 'codex-smoke-opening.json'), receipt);

  let driver = null;
  let bootstrapProxy = null;
  try {
    bootstrapProxy = await startObservedDenyProxy();
    const home = path.join(isolatedRoot, 'home with spaces');
    const codexHome = path.join(isolatedRoot, 'codex home with spaces');
    const projectRoot = path.join(isolatedRoot, 'project with spaces');
    const marketplaceRoot = path.join(isolatedRoot, 'marketplace with spaces');
    for (const directory of [home, codexHome, projectRoot]) fs.mkdirSync(directory, { recursive: true });
    const project = createActiveProject(projectRoot);
    const before = fs.readFileSync(project.targetPath);
    const beforeSha256 = sha256(before);
    const copied = marketplaceCopy(sourceRoot, marketplaceRoot);
    writeJson(path.join(exactArtifactDir, 'marketplace-copy-manifest.json'), copied.manifest);

    const credentialRoots = [home, codexHome];
    const openingCredentials = credentialArtifacts(credentialRoots);
    if (openingCredentials.length !== 0) {
      throw fatal('isolated roots unexpectedly contain an auth or credential artifact',
        'auth_store_boundary_violation');
    }

    const helperPath = path.join(sourceRoot, 'scripts', 'host-loopback-model.cjs');
    const helper = require(helperPath);
    const {
      LOOPBACK_MODEL,
      buildCodexConfig,
      buildIsolatedHostEnv,
      createLoopbackDriver,
      normalizeActualHostRecords,
    } = helper;
    const driverReceiptPath = path.join(exactArtifactDir, 'codex-loopback-driver-receipt.json');
    if (!testFakeHost) {
      driver = await createLoopbackDriver({
        host: 'codex', targetPath: project.targetPath, receiptPath: driverReceiptPath,
      });
    }
    const driverOrigin = testFakeHost ? 'http://127.0.0.1:9' : driver.origin;
    const driverProxyOrigin = bootstrapProxy.origin;
    const localBootstrap = await createCodexLocalBootstrap({
      isolatedRoot,
      codexHome,
      artifactDir: exactArtifactDir,
      testFakeHost,
      helper,
      proxyOrigin: driverProxyOrigin,
      proxySnapshot: () => bootstrapProxy.snapshot(),
    });
    const env = buildIsolatedHostEnv({
      host: 'codex', home, codexHome,
      claudeConfigDir: path.join(isolatedRoot, 'unused claude config'),
      origin: driverOrigin,
      proxyOrigin: driverProxyOrigin,
      gitConfigGlobal: localBootstrap.gitConfigPath,
    });
    for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.TMP]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const codexConfig = buildCodexConfig({
      origin: driverOrigin,
      modelCatalogPath: localBootstrap.catalogPath,
    });
    const codexConfigPath = path.join(codexHome, 'config.toml');
    fs.writeFileSync(codexConfigPath, codexConfig);
    receipt.codex_config_sha256 = sha256(codexConfig);
    writeJson(path.join(exactArtifactDir, 'isolated-opening-inventory.json'),
      fileManifest(isolatedRoot));
    writeJson(path.join(exactArtifactDir, 'credential-scan-opening.json'), openingCredentials);

    const context = {
      command: fs.realpathSync(path.resolve(hostCommand)),
      prefix: hostPrefix ? [fs.realpathSync(path.resolve(hostPrefix))] : [],
      cwd: projectRoot,
      env,
      artifactDir: exactArtifactDir,
      commandReceipts: receipt.command_receipts,
    };
    const version = await requireSuccess(context, ['--version'], 'codex-version');
    if (version.stdout.trim() !== EXPECTED_VERSION || version.stderr !== '') {
      throw fatal(`unexpected Codex version output: ${JSON.stringify(version.stdout)}`,
        'unsupported_pinned_host_install_contract');
    }

    if (process.platform === 'win32' || testFakeHost) {
      const setupUser = os.userInfo().username;
      if (typeof setupUser !== 'string' || !setupUser) {
        throw fatal('Windows sandbox setup requires a non-empty OS user identity',
          'unsupported_pinned_host_install_contract');
      }
      await requireSuccess(context, [
        'sandbox',
        'setup',
        '--elevated',
        '--user',
        setupUser,
        '--codex-home',
        codexHome,
      ], 'codex-windows-sandbox-setup', 120_000);
    }

    await requireSuccess(context,
      ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], 'codex-marketplace-add');
    await requireSuccess(context,
      ['plugin', 'add', `deep-evolve@${MARKETPLACE_NAME}`, '--json'], 'codex-plugin-add');
    const list = await requireSuccess(context,
      ['plugin', 'list', '--marketplace', MARKETPLACE_NAME, '--json'], 'codex-plugin-list');
    assertEnabledPlugin(list.stdout);

    const candidates = findPluginRoots([codexHome, home], '.codex-plugin/plugin.json', [
      fs.realpathSync(copied.pluginRoot),
      fs.realpathSync(sourceRoot),
    ]);
    const installed = authenticateInstalledCache({ candidates, sourceManifest: copied.manifest });
    if (fs.realpathSync(installed.root) === fs.realpathSync(copied.pluginRoot)
      || fs.realpathSync(installed.root) === fs.realpathSync(sourceRoot)) {
      throw fatal('Codex must execute an installed cache distinct from the source tree',
        'unsupported_pinned_host_install_contract');
    }
    writeJson(path.join(exactArtifactDir, 'installed-cache-manifest.json'), installed.manifest);

    const installedGuard = require(path.join(installed.root, 'hooks', 'scripts',
      'protect-readonly.cjs'));
    const cwdForms = [...new Set([
      projectRoot,
      fs.realpathSync(projectRoot),
      fs.realpathSync.native(projectRoot),
    ])];
    const targetForms = [...new Set([
      project.targetPath,
      fs.realpathSync(project.targetPath),
      fs.realpathSync.native(project.targetPath),
    ])];
    const guardPathDiagnostics = [];
    for (const cwdForm of cwdForms) {
      for (const targetForm of targetForms) {
        const result = installedGuard.evaluateHook({
          tool_name: 'apply_patch',
          tool_input: {
            command: `*** Begin Patch\n*** Update File: ${targetForm}\n@@\n-before\n+after\n*** End Patch`,
          },
        }, {}, cwdForm);
        guardPathDiagnostics.push({
          cwd: cwdForm,
          target: targetForm,
          exit_code: result.exitCode,
          output_sha256: sha256(result.output || ''),
          blocked: result.exitCode === 2 && /Deep Evolve Guard/.test(result.output || ''),
        });
      }
    }
    writeJson(path.join(exactArtifactDir, 'codex-guard-path-diagnostics.json'), {
      schema_version: 1,
      project_root: projectRoot,
      target_path: project.targetPath,
      cwd_forms: cwdForms,
      target_forms: targetForms,
      evaluations: guardPathDiagnostics,
    });

    const installedConfig = fs.readFileSync(codexConfigPath, 'utf8');
    const projectTrustHeader = `[projects.${JSON.stringify(projectRoot)}]`;
    if (installedConfig.split(/\r?\n/).includes(projectTrustHeader)) {
      throw fatal('project trust entry already exists before the smoke-owned seal',
        'preexisting_project_trust');
    }
    const trustedConfig = `${installedConfig.trimEnd()}\n\n${projectTrustHeader}\ntrust_level = "trusted"\n`;
    fs.writeFileSync(codexConfigPath, trustedConfig);
    const hostConfig = fs.readFileSync(codexConfigPath, 'utf8');
    if (hostConfig !== trustedConfig) {
      throw fatal('failed to seal the exact installed Codex host config',
        'isolated_config_changed');
    }
    receipt.host_config_sha256 = sha256(hostConfig);

    const fixedPrompt = [
      'Use apply_patch exactly once.',
      `Change only the exact file ${project.targetPath}.`,
      'Replace its single line before with the single line after.',
      'Do not use another tool and do not modify another file.',
    ].join(' ');
    const hostArgs = [
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--ephemeral',
      '--dangerously-bypass-hook-trust',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-C',
      projectRoot,
      fixedPrompt,
    ];
    const preInvocationCredentials = credentialArtifacts(credentialRoots);
    writeJson(path.join(exactArtifactDir, 'credential-scan-pre-invocation.json'),
      preInvocationCredentials);
    if (preInvocationCredentials.length !== 0) {
      throw fatal('install persisted an auth or credential artifact before host invocation',
        'auth_store_boundary_violation');
    }
    const host = await requireSuccess(context, hostArgs, 'codex-host-stream', 120_000);
    const observedProxy = bootstrapProxy.snapshot();
    writeJson(path.join(exactArtifactDir, 'codex-local-bootstrap-deny-proxy-receipt.json'),
      observedProxy);
    if (observedProxy.external_network_attempt_count !== 0) {
      throw fatal('Codex bootstrap or host attempted external network access',
        'external_network_attempt');
    }
    const after = fs.readFileSync(project.targetPath);
    const afterSha256 = sha256(after);
    if (!before.equals(after) || beforeSha256 !== afterSha256) {
      throw fatal('protected prepare.cjs bytes changed', 'protected_bytes_changed');
    }
    if (fs.readFileSync(codexConfigPath, 'utf8') !== hostConfig) {
      throw fatal('isolated top-level Codex config changed during the host run',
        'isolated_config_changed');
    }
    if (!/Deep Evolve Guard/.test(`${host.stdout}\n${host.stderr}`)) {
      throw fatal('actual Codex stream did not expose one Deep Evolve denial',
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
      throw fatal('host persisted an auth or credential artifact', 'auth_store_boundary_violation');
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
        target_path: project.targetPath,
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        external_network_attempt_count: 0,
        credential_artifact_count: 0,
      });
      writeJson(path.join(exactArtifactDir, 'codex-fake-orchestration-receipt.json'), receipt);
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
      return;
    }

    const evidence = {
      host: 'codex',
      version: '0.144.1',
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
      host: 'codex', rawStdout: host.stdoutBytes, rawStderr: host.stderrBytes,
      isolatedRoot: projectRoot, evidence,
    });
    if (normalized.acceptedEventPaths.raw_stream_sha256 !== sha256(host.stdoutBytes)
      || normalized.acceptedEventPaths.raw_stderr_sha256 !== sha256(host.stderrBytes)) {
      throw fatal('normalized Codex hashes differ from authenticated host Buffers',
        'invalid_provenance');
    }
    writeJson(path.join(exactArtifactDir, 'codex-normalized-records.json'), normalized);
    fs.writeFileSync(path.join(exactArtifactDir, 'normalized-apply-patch-attempt.jsonl'),
      `${JSON.stringify(normalized.attempt)}\n`);
    fs.writeFileSync(path.join(exactArtifactDir, 'normalized-hook-denial.jsonl'),
      `${JSON.stringify(normalized.denial)}\n`);
    writeJson(path.join(exactArtifactDir, 'normalized-accepted-event-paths.json'),
      normalized.acceptedEventPaths);

    Object.assign(receipt, {
      ok: true,
      loopback_model: LOOPBACK_MODEL,
      bootstrap_commit: metadata.bootstrapCommit,
      run_id: metadata.runId,
      job_id: metadata.jobId,
      run_attempt: 1,
      same_head_rerun: false,
      marketplace_copy_root: copied.pluginRoot,
      marketplace_copy_manifest_sha256: sha256(JSON.stringify(copied.manifest)),
      installed_cache_root: installed.root,
      installed_cache_manifest_sha256: sha256(JSON.stringify(installed.manifest)),
      target_path: project.targetPath,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      raw_stdout_sha256: normalized.acceptedEventPaths.raw_stream_sha256,
      raw_stderr_sha256: normalized.acceptedEventPaths.raw_stderr_sha256,
      driver_sha256: evidence.driver_sha256,
      codex_config_sha256: sha256(codexConfig),
      host_config_sha256: sha256(hostConfig),
      driver_receipt_sha256: sha256File(driverReceiptPath),
      external_network_attempt_count: 0,
      credential_artifact_count: 0,
      accepted_pointers: normalized.acceptedEventPaths.accepted_pointers,
      vendor_cloud_entitlement_proven: false,
      fixture_authority: true,
    });
    writeJson(path.join(exactArtifactDir, 'codex-smoke-receipt.json'), receipt);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    if (bootstrapProxy) {
      const observedProxy = bootstrapProxy.snapshot();
      writeJson(path.join(exactArtifactDir,
        'codex-local-bootstrap-deny-proxy-receipt.json'), observedProxy);
      receipt.external_network_attempt_count = observedProxy.external_network_attempt_count;
      receipt.external_network_attempts = observedProxy.external_network_attempts;
    }
    receipt.error = { code: error.code || 'installed_codex_smoke_failed', message: error.message };
    writeJson(path.join(exactArtifactDir, 'codex-smoke-failure.json'), receipt);
    throw error;
  } finally {
    if (driver) await driver.close();
    if (bootstrapProxy) {
      writeJson(path.join(exactArtifactDir,
        'codex-local-bootstrap-deny-proxy-receipt.json'), bootstrapProxy.snapshot());
      await bootstrapProxy.close();
    }
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--diagnose-command')) {
    diagnostic(argv);
    return;
  }
  await acceptance(argv);
}

main().catch((error) => {
  process.stderr.write(`[deep-evolve/codex-smoke] ${error.code || 'error'}: ${error.message}\n`);
  process.exitCode = 2;
});
