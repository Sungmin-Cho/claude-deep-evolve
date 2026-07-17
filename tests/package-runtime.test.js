'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));

const EXPECTED_FILES = [
  '.claude-plugin/',
  '.codex-plugin/',
  'hooks/hooks.json',
  'hooks/hooks.claude.json',
  'hooks/scripts/*.cjs',
  'hooks/scripts/*.js',
  'hooks/scripts/runtime/',
  'agents/',
  'skills/',
  'templates/',
  'tests/',
  'scripts/validate-envelope-emit.js',
];

const MAINTAINER_SCRIPTS = [
  'scripts/host-loopback-model.cjs',
  'scripts/smoke-installed-codex-hook.cjs',
  'scripts/smoke-installed-claude-hook.cjs',
  'scripts/validate-codex-plugin.cjs',
  'scripts/validate-docs-rulebooks.cjs',
];

const HOST_JOBS = [
  ['Codex', '.github/workflows/codex-release-smoke.yml',
    'windows-codex-host-smoke', '0.144.1'],
  ['Claude', '.github/workflows/claude-release-smoke.yml',
    'windows-claude-host-smoke', '2.1.207'],
];

const LOOPBACK_MODEL = 'deep-evolve-loopback-contract-v1';
const PUBLIC_CLAUDE_HEADER = 'deep-evolve-loopback-public-v1';

const FORBIDDEN_ENVIRONMENT_KEYS = [
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID',
  'XDG_CONFIG_HOME',
];

const EXACT_ACCEPTED_POINTERS = {
  Codex: ['/tool_name', '/tool_input/command'],
  Claude: [
    '/hook_event_name',
    '/tool_name',
    '/tool_input/file_path',
    '/tool_input/old_string',
    '/tool_input/new_string',
  ],
};

function loadLoopbackHelper() {
  const relative = 'scripts/host-loopback-model.cjs';
  const target = path.join(root, relative);
  assert.equal(fs.existsSync(target), true, `${relative} must exist`);
  return require(target);
}

function writeFakeHost({ directory, host, tracePath, mutation = 'clean' }) {
  const target = path.join(directory, `${host}-fake-host.cjs`);
  const source = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const host = ${JSON.stringify(host)};`,
    `const tracePath = ${JSON.stringify(tracePath)};`,
    `const mutation = ${JSON.stringify(mutation)};`,
    'const argv = process.argv.slice(2);',
    "fs.appendFileSync(tracePath, `${JSON.stringify(argv)}\\n`);",
    "const configRoot = host === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;",
    "const statePath = path.join(configRoot, 'fake-marketplace-root.txt');",
    "const cacheRoot = path.join(configRoot, 'cache', 'deep-evolve');",
    "if (argv.length === 1 && argv[0] === '--version') {",
    "  process.stdout.write(host === 'codex' ? 'codex-cli 0.144.1\\n' : '2.1.207 (Claude Code)\\n');",
    '  process.exit(0);',
    '}',
    "if (argv[0] === 'plugin' && argv[1] === 'marketplace' && argv[2] === 'add') {",
    "  fs.writeFileSync(statePath, `${argv[3]}\\n`);",
    "  process.stdout.write('{}\\n');",
    '  process.exit(0);',
    '}',
    "const install = argv[0] === 'plugin'",
    "  && ((host === 'codex' && argv[1] === 'add') || (host === 'claude' && argv[1] === 'install'));",
    'if (install) {',
    "  const marketplaceRoot = fs.readFileSync(statePath, 'utf8').trim();",
    "  fs.mkdirSync(path.dirname(cacheRoot), { recursive: true });",
    "  fs.cpSync(path.join(marketplaceRoot, 'plugins', 'deep-evolve'), cacheRoot, { recursive: true });",
    "  if (mutation === 'unexpected-file') fs.writeFileSync(path.join(cacheRoot, 'unexpected.txt'), 'x');",
    "  if (mutation === 'missing-file') fs.rmSync(path.join(cacheRoot, 'package.json'));",
    "  if (mutation === 'changed-file') fs.appendFileSync(path.join(cacheRoot, 'package.json'), ' ');",
    "  if (mutation === 'credential') fs.writeFileSync(path.join(configRoot, 'auth.json'), '{}\\n');",
    "  process.stdout.write('{}\\n');",
    '  process.exit(0);',
    '}',
    "if (host === 'claude' && argv[0] === 'plugin' && argv[1] === 'enable') {",
    "  process.stdout.write('{}\\n');",
    '  process.exit(0);',
    '}',
    "if (argv[0] === 'plugin' && argv[1] === 'list') {",
    "  process.stdout.write(`${JSON.stringify({ plugins: [{ name: 'deep-evolve', marketplace: 'deep-evolve-loopback', enabled: true }] })}\\n`);",
    '  process.exit(0);',
    '}',
    "fs.appendFileSync(`${tracePath}.host-invoked`, `${JSON.stringify(argv)}\\n`);",
    "process.stdout.write('Deep Evolve Guard denied prepare.cjs\\n');",
  ].join('\n');
  fs.writeFileSync(target, `${source}\n`);
  return target;
}

function runFakeHostSmoke({ host, mutation = 'clean' }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `deep-evolve ${host} fake smoke `));
  const tracePath = path.join(directory, 'trace.jsonl');
  const artifactDir = path.join(directory, 'artifacts');
  fs.mkdirSync(artifactDir);
  const fakeHost = writeFakeHost({ directory, host, tracePath, mutation });
  const smoke = path.join(root, 'scripts', `smoke-installed-${host}-hook.cjs`);
  const result = spawnSync(process.execPath, [
    smoke,
    '--source-root', root,
    '--host-command', process.execPath,
    '--host-prefix', fakeHost,
    '--artifact-dir', artifactDir,
    '--bootstrap-commit', '0'.repeat(40),
    '--run-id', 'fake-run',
    '--job-id', 'fake-job',
    '--run-attempt', '1',
    '--test-fake-host',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    shell: false,
    env: { ...process.env, DEEP_EVOLVE_TEST_ONLY_FAKE_HOST: '1' },
  });
  return { directory, tracePath, artifactDir, result };
}

function parseSse(source) {
  return source.split(/\r?\n\r?\n/)
    .flatMap((block) => block.split(/\r?\n/))
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data));
}

async function postJson(origin, pathname, body, headers = {}) {
  const response = await fetch(new URL(pathname, origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function proxyRequest(proxyOrigin) {
  const proxy = new URL(proxyOrigin);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: proxy.hostname,
      port: proxy.port,
      method: 'GET',
      path: 'http://example.invalid/forbidden',
      headers: { host: 'example.invalid' },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

function parseJsonl(source, label) {
  const lines = source.trim().split(/\r?\n/).filter(Boolean);
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      assert.fail(`${label} contains invalid JSONL: ${error.message}`);
    }
  });
}

function assertFixtureBundle({ host, version, attemptSource, denialSource, provenance }) {
  const attempts = parseJsonl(attemptSource, `${host} attempt`);
  const denials = parseJsonl(denialSource, `${host} denial`);
  assert.equal(attempts.length, 1, `${host} must retain exactly one tool attempt`);
  assert.equal(denials.length, 1, `${host} must retain exactly one hook denial`);
  assert.equal(attempts.some((record) => record.mutation_succeeded === true), false);
  assert.equal(denials.some((record) => record.mutation_succeeded === true), false);

  assert.equal(provenance.host, host.toLowerCase());
  assert.equal(provenance.version, version);
  assert.equal(provenance.capture_source, 'actual_exact_pinned_host');
  assert.equal(provenance.model_source, 'deterministic_loopback_protocol_v1');
  assert.match(provenance.bootstrap_commit, /^[0-9a-f]{40}$/);
  assert.match(provenance.driver_sha256, /^[0-9a-f]{64}$/);
  assert.match(provenance.raw_stream_sha256, /^[0-9a-f]{64}$/);
  assert.ok(String(provenance.run_id).length > 0);
  assert.ok(String(provenance.job_id).length > 0);
  assert.equal(provenance.run_attempt, 1);
  assert.equal(provenance.same_head_rerun, false);
  assert.equal(provenance.attempt_count, 1);
  assert.equal(provenance.denial_count, 1);
  assert.equal(provenance.successful_mutation_count, 0);
  assert.deepEqual(provenance.accepted_pointers, EXACT_ACCEPTED_POINTERS[host]);
  assert.ok(provenance.normalization_map && typeof provenance.normalization_map === 'object');
  assert.equal(Array.isArray(provenance.normalization_map), false);
  assert.equal(provenance.vendor_cloud_entitlement_proven, false);
}

test('package manifest pins Node 22 and the exact self-contained runtime boundary', () => {
  const pkg = readJson('package.json');
  assert.deepEqual(pkg.engines, { node: '>=22' });
  assert.deepEqual(pkg.files, EXPECTED_FILES);
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.js');
  assert.equal(pkg.scripts['test:legacy'],
    'pytest legacy/test_oracle_parity.py hooks/scripts/tests/test_package_manifest.py -q');
  assert.equal(pkg.scripts['validate:codex'], 'node scripts/validate-codex-plugin.cjs');
  assert.equal(pkg.scripts.verify, 'npm test && npm pack --dry-run');
});

test('npm artifact contains both policies and no legacy, Python, shell, or maintainer runtime', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    shell: false,
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const rows = JSON.parse(packed.stdout);
  assert.equal(rows.length, 1);
  const files = rows[0].files.map(({ path: file }) => file).sort();
  for (const required of [
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    'agents/evolve-coordinator.md',
    'agents/evolve-seed.md',
    'hooks/hooks.json',
    'hooks/hooks.claude.json',
    'hooks/scripts/protect-readonly.cjs',
    'scripts/validate-envelope-emit.js',
    'skills/deep-evolve/SKILL.md',
    'skills/deep-evolve-workflow/SKILL.md',
  ]) assert.equal(files.includes(required), true, required);
  assert.equal(files.some((file) => file.startsWith('legacy/')), false);
  assert.equal(files.some((file) => file.endsWith('.py')), false);
  assert.equal(files.some((file) => file.endsWith('.sh')), false);
  for (const excluded of MAINTAINER_SCRIPTS) {
    assert.equal(files.includes(excluded), false, excluded);
  }
});

test('ordinary CI is secret-free Node 22 on exactly Ubuntu, macOS, and native Windows', () => {
  const workflow = read('.github/workflows/tests.yml');
  assert.match(workflow, /os:\s*\[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(workflow, /node-version:\s*['"]22['"]/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm pack --dry-run/);
  assert.match(workflow, /legacy-oracle:/);
  assert.match(workflow, /npm run test:legacy/);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|ANTHROPIC_API_KEY|CODEX_HOOK_SMOKE_MODEL|CLAUDE_HOOK_SMOKE_MODEL/);
});

for (const [host, relative, job, version] of HOST_JOBS) {
  test(`${host} secret-free workflow authenticates exact PR/main heads and pinned host`, () => {
    assert.equal(fs.existsSync(path.join(root, relative)), true, `${relative} must exist`);
    const workflow = read(relative);
    assert.match(workflow, new RegExp(job));
    assert.match(workflow, /^\s*pull_request:\s*$/m);
    assert.match(workflow, /^\s*push:\s*$/m);
    assert.match(workflow, /branches:\s*\[?\s*main\s*\]?/);
    assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
    assert.match(workflow, /permissions:\s*\r?\n\s+contents:\s*read/);
    assert.match(workflow, /runs-on:\s*windows-latest/);
    assert.match(workflow, /actions\/setup-node@v4/);
    assert.match(workflow, /node-version:\s*['"]22['"]/);
    assert.match(workflow, new RegExp(version.replace(/\./g, '\\.')));
    assert.match(workflow, /pull_request\.head\.sha/i);
    assert.match(workflow, /pull_request\.head\.repo\.full_name/i);
    assert.match(workflow, /pull_request\.base\.ref/i);
    assert.match(workflow, /GITHUB_SHA|github\.sha/);
    assert.match(workflow, /refs\/heads\/main/);
    assert.match(workflow, /origin\/main/);
    assert.match(workflow, /ref_protected/i);
    const provenanceStep = workflow.split(/^\s{6}- name:/m)
      .find((step) => /provenance/i.test(step));
    assert.ok(provenanceStep, 'workflow must have an executable provenance step');
    assert.match(provenanceStep, /PR_HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/i);
    assert.match(provenanceStep,
      /PR_HEAD_REPOSITORY:\s*\$\{\{\s*github\.event\.pull_request\.head\.repo\.full_name\s*\}\}/i);
    assert.match(provenanceStep, /EVENT_NAME\s+-eq\s+['"]pull_request['"][\s\S]*PR_HEAD_REPOSITORY\s+-ne\s+\$canonical/i);
    assert.match(provenanceStep, /EVENT_NAME\s+-eq\s+['"]pull_request['"][\s\S]*\$head\s+-ne\s+\$env:PR_HEAD_SHA/i);
    assert.match(provenanceStep, /EVENT_NAME\s+-eq\s+['"]push['"][\s\S]*\$head\s+-ne\s+\$env:EVENT_SHA/i);
    assert.match(provenanceStep, /refs\/heads\/main[\s\S]*origin\/main/i);
    assert.match(workflow, new RegExp(`smoke-installed-${host.toLowerCase()}-hook\\.cjs`));
    assert.match(workflow, /New-NetFirewallRule/);
    assert.match(workflow, /RemoteAddress\s+Internet|-RemoteAddress\s+['"]?Internet/i);
    assert.match(workflow, /Remove-NetFirewallRule/);
    assert.match(workflow, /if:\s*always\(\)/);
    assert.doesNotMatch(workflow, /^\s*environment:/m);
    assert.doesNotMatch(workflow, /\$\{\{\s*(?:secrets|vars)\./);
    assert.doesNotMatch(workflow, /\b(?:codex|claude)\s+login\b/i);
    assert.doesNotMatch(workflow, /--test-fake-host|DEEP_EVOLVE_TEST_ONLY_FAKE_HOST/);

    const withoutPublicSentinel = workflow.replace(
      /ANTHROPIC_API_KEY:\s*deep-evolve-loopback-public-v1/g, '');
    assert.doesNotMatch(withoutPublicSentinel,
      /OPENAI_API_KEY|CODEX_ACCESS_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_MODEL|ANTHROPIC_MODEL|CLAUDE_MODEL|CODEX_HOOK_SMOKE_MODEL|CLAUDE_HOOK_SMOKE_MODEL/);

    if (host === 'Codex') {
      assert.match(workflow, /@openai\/codex@0\.144\.1/);
      assert.doesNotMatch(workflow, /deep-evolve-loopback-public-v1/);
    } else {
      assert.match(workflow, /@anthropic-ai\/claude-code@2\.1\.207/);
      assert.equal((workflow.match(/deep-evolve-loopback-public-v1/g) || []).length, 1);
      const hostStep = workflow.split(/^\s{6}- name:/m)
        .find((step) => step.includes(PUBLIC_CLAUDE_HEADER));
      assert.ok(hostStep, 'public Claude sentinel must be scoped to one host step');
      assert.match(hostStep, /smoke-installed-claude-hook\.cjs/);
      assert.match(hostStep, /ANTHROPIC_API_KEY:\s*deep-evolve-loopback-public-v1/);
    }
  });
}

test('maintainer host smokes use exact argv arrays, installed caches, and the shared driver', () => {
  for (const relative of [
    'scripts/smoke-installed-codex-hook.cjs',
    'scripts/smoke-installed-claude-hook.cjs',
  ]) assert.equal(fs.existsSync(path.join(root, relative)), true, relative);
  const codex = read('scripts/smoke-installed-codex-hook.cjs');
  const claude = read('scripts/smoke-installed-claude-hook.cjs');

  assert.match(codex, /0\.144\.1/);
  assert.match(codex, /apply_patch/);
  assert.match(codex, /diagnostic_only/);
  assert.match(codex, /host-loopback-model\.cjs/);
  assert.match(codex,
    /\[\s*['"]--ask-for-approval['"]\s*,\s*['"]never['"]\s*,\s*['"]exec['"]\s*,\s*['"]--json['"]\s*,\s*['"]--ephemeral['"]\s*,\s*['"]--dangerously-bypass-hook-trust['"]\s*,\s*['"]--sandbox['"]\s*,\s*['"]workspace-write['"]\s*,\s*['"]--skip-git-repo-check['"]\s*,\s*['"]-C['"]\s*,/);
  for (const flag of [
    '--json',
    '--ephemeral',
    '--dangerously-bypass-hook-trust',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '-C',
  ]) assert.match(codex, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(codex, /--profile/);
  assert.match(codex, /shell:\s*false/);

  assert.match(claude, /2\.1\.207/);
  assert.match(claude, /host-loopback-model\.cjs/);
  assert.match(claude,
    /\[\s*['"]-p['"]\s*,\s*['"]--output-format['"]\s*,\s*['"]stream-json['"]\s*,\s*['"]--include-hook-events['"]\s*,\s*['"]--no-session-persistence['"]\s*,\s*['"]--no-chrome['"]\s*,\s*['"]--disable-slash-commands['"]\s*,\s*['"]--permission-mode['"]\s*,\s*['"]bypassPermissions['"]\s*,\s*['"]--tools['"]\s*,\s*['"]Edit,Write,MultiEdit['"]\s*,\s*['"]--model['"]\s*,\s*LOOPBACK_MODEL\s*,\s*['"]--setting-sources['"]\s*,\s*['"]user['"]\s*,/);
  for (const fragment of [
    '-p',
    '--output-format',
    'stream-json',
    '--include-hook-events',
    '--no-session-persistence',
    '--no-chrome',
    '--disable-slash-commands',
    '--permission-mode',
    'bypassPermissions',
    '--tools',
    'Edit,Write,MultiEdit',
    '--model',
    '--setting-sources',
    'user',
  ]) assert.match(claude, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(claude, /['"]--model['"]\s*,\s*LOOPBACK_MODEL/);
  assert.doesNotMatch(claude, /--safe-mode|--bare|--plugin-dir/);
  assert.match(claude, /shell:\s*false/);

  for (const source of [codex, claude]) {
    assert.match(source, /auth(?:\\)?\.json/);
    assert.match(source, /credential|OAuth/i);
    assert.match(source,
      /(?:auth(?:\\)?\.json|credential|OAuth)[\s\S]{0,800}(?:throw|fail|reject|fatal)|(?:throw|fail|reject|fatal)[\s\S]{0,800}(?:auth(?:\\)?\.json|credential|OAuth)/i);
    assert.match(source, /installed.*cache|cache.*installed/is);
    assert.match(source, /external_network_attempt|deny.?proxy/i);
    assert.match(source, /credential-scan-pre-invocation\.json/);
    assert.doesNotMatch(source, /AUTHENTICATED_PREFIXES/);
  }
});

for (const host of ['codex', 'claude']) {
  test(`${host} fake host exercises installed-cache orchestration without fixture authority`, () => {
    const run = runFakeHostSmoke({ host });
    try {
      assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
      const receipt = JSON.parse(run.result.stdout.trim());
      assert.equal(receipt.ok, true);
      assert.equal(receipt.diagnostic_only, true);
      assert.equal(receipt.capture_source, 'test_fake_host_non_authority');
      assert.equal(receipt.fixture_authority, false);
      assert.equal(receipt.network_authority, false);
      assert.equal(receipt.external_network_attempt_count, 0);
      assert.equal(receipt.credential_artifact_count, 0);
      assert.equal(fs.existsSync(receipt.isolated_root), false, 'isolated root must be cleaned');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run.artifactDir,
        'credential-scan-pre-invocation.json'), 'utf8')), []);
      assert.equal(fs.existsSync(path.join(run.artifactDir,
        `${host}-fake-orchestration-receipt.json`)), true);
      assert.equal(fs.existsSync(path.join(run.artifactDir, `${host}-smoke-receipt.json`)), false);
      assert.equal(fs.readdirSync(run.artifactDir)
        .some((name) => name.startsWith('normalized-')), false);

      const trace = fs.readFileSync(run.tracePath, 'utf8').trim().split(/\r?\n/)
        .map((line) => JSON.parse(line));
      const expectedCommands = host === 'codex'
        ? ['--version', 'marketplace', 'add', 'list', '--ask-for-approval']
        : ['--version', 'marketplace', 'install', 'enable', 'list', '-p'];
      for (const fragment of expectedCommands) {
        assert.equal(trace.some((argv) => argv.includes(fragment)), true, fragment);
      }
      assert.equal(fs.existsSync(`${run.tracePath}.host-invoked`), true);
      const hostArgv = JSON.parse(fs.readFileSync(`${run.tracePath}.host-invoked`, 'utf8').trim());
      if (host === 'codex') {
        assert.deepEqual(hostArgv.slice(0, 10), [
          '--ask-for-approval', 'never', 'exec', '--json', '--ephemeral',
          '--dangerously-bypass-hook-trust', '--sandbox', 'workspace-write',
          '--skip-git-repo-check', '-C',
        ]);
      } else {
        assert.deepEqual(hostArgv.slice(0, 4), ['-p', '--output-format', 'stream-json',
          '--include-hook-events']);
      }
      assert.equal(receipt.command_receipts.at(-1).exit_code, 0);
    } finally {
      fs.rmSync(run.directory, { recursive: true, force: true });
    }
  });

  test(`${host} rejects missing, changed, and unexpected installed-cache files`, () => {
    for (const mutation of ['missing-file', 'changed-file', 'unexpected-file']) {
      const run = runFakeHostSmoke({ host, mutation });
      try {
        assert.equal(run.result.status, 2, `${mutation}: ${run.result.stdout}`);
        assert.match(run.result.stderr, /authenticated installed cache/i);
        assert.equal(fs.existsSync(`${run.tracePath}.host-invoked`), false, mutation);
      } finally {
        fs.rmSync(run.directory, { recursive: true, force: true });
      }
    }
  });

  test(`${host} rescans credentials after install and fails before host invocation`, () => {
    const run = runFakeHostSmoke({ host, mutation: 'credential' });
    try {
      assert.equal(run.result.status, 2, run.result.stdout);
      assert.match(run.result.stderr, /before host invocation/i);
      assert.equal(fs.existsSync(`${run.tracePath}.host-invoked`), false);
      const artifacts = JSON.parse(fs.readFileSync(path.join(run.artifactDir,
        'credential-scan-pre-invocation.json'), 'utf8'));
      assert.equal(artifacts.some(({ path: artifact }) => /auth\.json$/i.test(artifact)), true);
    } finally {
      fs.rmSync(run.directory, { recursive: true, force: true });
    }
  });
}

test('shared loopback helper exports the exact interface and complete Codex provider config', () => {
  const helper = loadLoopbackHelper();
  assert.deepEqual(Object.keys(helper).sort(), [
    'LOOPBACK_MODEL',
    'PUBLIC_CLAUDE_HEADER',
    'buildCodexConfig',
    'buildIsolatedHostEnv',
    'createLoopbackDriver',
    'normalizeActualHostRecords',
  ].sort());
  assert.equal(helper.LOOPBACK_MODEL, LOOPBACK_MODEL);
  assert.equal(helper.PUBLIC_CLAUDE_HEADER, PUBLIC_CLAUDE_HEADER);

  const origin = 'http://127.0.0.1:43123';
  assert.equal(helper.buildCodexConfig({ origin }), [
    `model = "${LOOPBACK_MODEL}"`,
    'model_provider = "deep_evolve_loopback"',
    '',
    '[model_providers.deep_evolve_loopback]',
    'name = "Deep Evolve loopback contract"',
    `base_url = "${origin}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n'));
  assert.doesNotMatch(helper.buildCodexConfig({ origin }), /\[profiles\.|--profile/);
  assert.throws(() => helper.buildCodexConfig({ origin: 'https://api.openai.com' }),
    /127\.0\.0\.1|loopback/i);
});

test('isolated host env is allowlisted and scopes the sole public sentinel to Claude loopback', () => {
  const { buildIsolatedHostEnv } = loadLoopbackHelper();
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-evolve env '));
  const home = path.join(isolatedRoot, 'home with spaces');
  const codexHome = path.join(isolatedRoot, 'codex home');
  const claudeConfigDir = path.join(isolatedRoot, 'claude config');
  const origin = 'http://127.0.0.1:43124';
  const proxyOrigin = 'http://127.0.0.1:43125';
  const inherited = [...FORBIDDEN_ENVIRONMENT_KEYS, 'ANTHROPIC_API_KEY'];
  const previous = new Map(inherited.map((key) => [key, process.env[key]]));

  try {
    for (const key of inherited) process.env[key] = `inherited-${key}`;
    const common = { home, codexHome, claudeConfigDir, origin, proxyOrigin };
    const codex = buildIsolatedHostEnv({ host: 'codex', ...common });
    const claude = buildIsolatedHostEnv({ host: 'claude', ...common });

    for (const env of [codex, claude]) {
      assert.equal(env.HOME, home);
      assert.equal(env.USERPROFILE, home);
      assert.equal(env.HTTP_PROXY, proxyOrigin);
      assert.equal(env.HTTPS_PROXY, proxyOrigin);
      assert.equal(env.ALL_PROXY, proxyOrigin);
      assert.equal(env.NO_PROXY, '127.0.0.1,localhost');
      for (const key of FORBIDDEN_ENVIRONMENT_KEYS) {
        assert.equal(Object.hasOwn(env, key), false, key);
      }
      assert.equal(Object.values(env).some((value) => String(value).startsWith('inherited-')), false);
    }

    assert.equal(codex.CODEX_HOME, codexHome);
    assert.equal(Object.hasOwn(codex, 'ANTHROPIC_API_KEY'), false);
    assert.equal(Object.hasOwn(codex, 'ANTHROPIC_BASE_URL'), false);
    assert.equal(claude.CLAUDE_CONFIG_DIR, claudeConfigDir);
    assert.equal(claude.ANTHROPIC_BASE_URL, origin);
    assert.equal(claude.ANTHROPIC_API_KEY, PUBLIC_CLAUDE_HEADER);
    assert.deepEqual(Object.entries(claude)
      .filter(([, value]) => value === PUBLIC_CLAUDE_HEADER)
      .map(([key]) => key), ['ANTHROPIC_API_KEY']);

    assert.throws(() => buildIsolatedHostEnv({
      host: 'codex', ...common, origin: 'https://api.openai.com',
    }), /127\.0\.0\.1|loopback/i);
    assert.throws(() => buildIsolatedHostEnv({
      host: 'claude', ...common, origin: 'https://api.anthropic.com',
    }), /127\.0\.0\.1|loopback/i);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test('Codex fake Responses protocol emits one apply_patch and rejects a third request', async () => {
  const { createLoopbackDriver } = loadLoopbackHelper();
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-evolve codex '));
  const targetPath = path.join(isolatedRoot, 'prepare.cjs');
  const receiptPath = path.join(isolatedRoot, 'driver-receipt.json');
  fs.writeFileSync(targetPath, 'before\n');
  const driver = await createLoopbackDriver({ host: 'codex', targetPath, receiptPath });

  try {
    assert.equal(new URL(driver.origin).hostname, '127.0.0.1');
    assert.equal(new URL(driver.proxyOrigin).hostname, '127.0.0.1');
    const first = await postJson(driver.origin, '/v1/responses', {
      model: LOOPBACK_MODEL,
      stream: true,
      tools: [{ type: 'custom', name: 'apply_patch' }],
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `Patch only ${targetPath}` }],
      }],
    });
    assert.equal(first.status, 200, first.text);
    const events = parseSse(first.text);
    assert.deepEqual(events.map(({ type }) => type), [
      'response.created',
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ]);
    const completed = events.at(-1).response;
    assert.equal(completed.output.length, 1);
    assert.deepEqual(completed.output[0], {
      type: 'custom_tool_call',
      id: 'ctc_loopback_1',
      call_id: 'call_loopback_1',
      name: 'apply_patch',
      input: [
        '*** Begin Patch',
        `*** Update File: ${targetPath}`,
        '@@',
        '-before',
        '+after',
        '*** End Patch',
      ].join('\n'),
      status: 'completed',
    });

    const second = await postJson(driver.origin, '/v1/responses', {
      model: LOOPBACK_MODEL,
      stream: true,
      input: [{
        type: 'custom_tool_call_output',
        call_id: 'call_loopback_1',
        output: 'Deep Evolve Guard denied prepare.cjs',
      }],
    });
    assert.equal(second.status, 200, second.text);
    const terminal = parseSse(second.text).find(({ type }) => type === 'response.completed');
    assert.ok(terminal);
    assert.equal(terminal.response.output.length, 1);
    assert.equal(terminal.response.output[0].type, 'message');

    const third = await postJson(driver.origin, '/v1/responses', {
      model: LOOPBACK_MODEL,
      stream: true,
      input: [],
    });
    assert.ok(third.status >= 400, third.text);
  } finally {
    await driver.close();
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test('Claude fake Messages protocol requires the public header and emits one Edit', async () => {
  const { createLoopbackDriver } = loadLoopbackHelper();
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-evolve claude '));
  const targetPath = path.join(isolatedRoot, 'prepare.cjs');
  const receiptPath = path.join(isolatedRoot, 'driver-receipt.json');
  fs.writeFileSync(targetPath, 'before\n');
  const driver = await createLoopbackDriver({ host: 'claude', targetPath, receiptPath });
  const headers = { 'x-api-key': PUBLIC_CLAUDE_HEADER };

  try {
    assert.equal(new URL(driver.origin).hostname, '127.0.0.1');
    const first = await postJson(driver.origin, '/v1/messages', {
      model: LOOPBACK_MODEL,
      stream: true,
      tools: [{ name: 'Edit', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: `Edit only ${targetPath}` }],
    }, headers);
    assert.equal(first.status, 200, first.text);
    const events = parseSse(first.text);
    assert.deepEqual(events.map(({ type }) => type), [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const start = events.find(({ type }) => type === 'content_block_start');
    assert.deepEqual(start.content_block, {
      type: 'tool_use',
      name: 'Edit',
      id: 'toolu_loopback_1',
      input: {},
    });
    const delta = events.find(({ type }) => type === 'content_block_delta');
    assert.deepEqual(JSON.parse(delta.delta.partial_json), {
      file_path: targetPath,
      old_string: 'before',
      new_string: 'after',
    });

    const second = await postJson(driver.origin, '/v1/messages', {
      model: LOOPBACK_MODEL,
      stream: true,
      tools: [{ name: 'Edit', input_schema: { type: 'object' } }],
      messages: [
        { role: 'assistant', content: [{
          type: 'tool_use', id: 'toolu_loopback_1', name: 'Edit', input: {
            file_path: targetPath, old_string: 'before', new_string: 'after',
          },
        }] },
        { role: 'user', content: [{
          type: 'tool_result', tool_use_id: 'toolu_loopback_1', is_error: true,
          content: 'Deep Evolve Guard denied prepare.cjs',
        }] },
      ],
    }, headers);
    assert.equal(second.status, 200, second.text);
    const terminal = parseSse(second.text);
    assert.equal(terminal.filter(({ type }) => type === 'content_block_start').length, 1);
    assert.equal(terminal.find(({ type }) => type === 'message_delta').delta.stop_reason,
      'end_turn');

    const third = await postJson(driver.origin, '/v1/messages', {
      model: LOOPBACK_MODEL,
      stream: true,
      tools: [{ name: 'Edit', input_schema: { type: 'object' } }],
      messages: [],
    }, headers);
    assert.ok(third.status >= 400, third.text);
  } finally {
    await driver.close();
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test('Claude driver rejects a non-public header and deny proxy records external traffic', async () => {
  const { createLoopbackDriver } = loadLoopbackHelper();
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-evolve proxy '));
  const targetPath = path.join(isolatedRoot, 'prepare.cjs');
  const receiptPath = path.join(isolatedRoot, 'driver-receipt.json');
  fs.writeFileSync(targetPath, 'before\n');
  const driver = await createLoopbackDriver({ host: 'claude', targetPath, receiptPath });

  try {
    const rejected = await postJson(driver.origin, '/v1/messages', {
      model: LOOPBACK_MODEL,
      stream: true,
      tools: [{ name: 'Edit', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: `Edit only ${targetPath}` }],
    }, { 'x-api-key': 'not-the-public-sentinel' });
    assert.ok(rejected.status >= 400, rejected.text);
    const proxyStatus = await proxyRequest(driver.proxyOrigin);
    assert.ok(proxyStatus >= 400);
  } finally {
    await driver.close();
  }

  try {
    assert.equal(fs.existsSync(receiptPath), true, 'deny proxy must write a receipt');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.match(JSON.stringify(receipt), /external_network_attempt/);
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test('normalizer refuses fake-host authority before it can produce retained fixtures', () => {
  const { normalizeActualHostRecords } = loadLoopbackHelper();
  const fakeEvidence = {
    capture_source: 'fake_host',
    model_source: 'deterministic_loopback_protocol_v1',
    driver_sha256: 'd'.repeat(64),
    raw_stream_sha256: 'e'.repeat(64),
  };
  assert.throws(() => normalizeActualHostRecords({
    host: 'codex',
    rawJsonl: `${JSON.stringify({
      tool_name: 'apply_patch',
      tool_input: { command: 'synthetic direct-handler transcript' },
    })}\n`,
    isolatedRoot: '/synthetic-root',
    evidence: fakeEvidence,
  }), /actual_exact_pinned_host|fake.?host|provenance/i);
});

test('normalizer rejects caller replacements and scopes mechanical IDs to typed fields', () => {
  const { normalizeActualHostRecords } = loadLoopbackHelper();
  const isolatedRoot = path.join(os.tmpdir(), 'deep-evolve-normalizer-contract');
  const sessionRoot = path.join(isolatedRoot, '.deep-evolve', 'session-current');
  const targetPath = path.join(sessionRoot, 'prepare.cjs');
  const rawJsonl = [
    {
      thread_id: 'Deep Evolve Guard',
      tool_name: 'apply_patch',
      tool_input: {
        command: [
          '*** Begin Patch',
          `*** Update File: ${targetPath}`,
          '@@',
          '-before',
          '+after',
          '*** End Patch',
        ].join('\n'),
      },
    },
    { type: 'hook_denial', message: 'Deep Evolve Guard denied prepare.cjs' },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
  const evidence = {
    host: 'codex',
    version: '0.144.1',
    capture_source: 'actual_exact_pinned_host',
    model_source: 'deterministic_loopback_protocol_v1',
    vendor_cloud_entitlement_proven: false,
    bootstrap_commit: 'a'.repeat(40),
    driver_sha256: 'b'.repeat(64),
    raw_stream_sha256: crypto.createHash('sha256').update(rawJsonl).digest('hex'),
    raw_stream_bytes: rawJsonl,
    run_id: 'run',
    job_id: 'job',
    run_attempt: 1,
    same_head_rerun: false,
    session_root: sessionRoot,
    attempt_count: 1,
    denial_count: 1,
    successful_mutation_count: 0,
  };

  const normalized = normalizeActualHostRecords({
    host: 'codex', rawJsonl, isolatedRoot, evidence,
  });
  assert.equal(normalized.attempt.thread_id, '{{CODEX_THREAD_ID}}');
  assert.equal(normalized.attempt.tool_name, 'apply_patch');
  assert.match(normalized.attempt.tool_input.command, /prepare\.cjs/);
  assert.match(normalized.denial.message, /Deep Evolve Guard denied prepare\.cjs/);
  assert.deepEqual(normalized.acceptedEventPaths.accepted_pointers,
    EXACT_ACCEPTED_POINTERS.Codex);

  assert.throws(() => normalizeActualHostRecords({
    host: 'codex', rawJsonl, isolatedRoot,
    evidence: {
      ...evidence,
      session_ids: { 'Deep Evolve Guard': '{{CALLER_REWRITE}}' },
    },
  }), /caller-supplied session ID normalization is forbidden|invalid_provenance/i);
});

for (const [host, version, files] of [
  ['Codex', '0.144.1', ['apply-patch-attempt.jsonl', 'hook-denial.jsonl', 'accepted-event-paths.json']],
  ['Claude', '2.1.207', ['protected-edit-attempt.jsonl', 'hook-denial.jsonl', 'accepted-event-paths.json']],
]) {
  test(`${host} fixtures retain one actual-host attempt, one denial, and exact provenance`, () => {
    const directory = path.join(root, 'tests', 'fixtures', `${host.toLowerCase()}-cli`, version);
    for (const file of files) {
      const target = path.join(directory, file);
      assert.equal(fs.existsSync(target), true, `${path.relative(root, target)} must exist`);
    }
    assertFixtureBundle({
      host,
      version,
      attemptSource: fs.readFileSync(path.join(directory, files[0]), 'utf8'),
      denialSource: fs.readFileSync(path.join(directory, files[1]), 'utf8'),
      provenance: JSON.parse(fs.readFileSync(path.join(directory, files[2]), 'utf8')),
    });
  });
}

test('fixture provenance oracle fails closed for every forbidden mutation', () => {
  const attempt = `${JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** End Patch' },
    mutation_succeeded: false,
  })}\n`;
  const denial = `${JSON.stringify({
    hook_event_name: 'PreToolUse',
    decision: 'block',
    reason: 'Deep Evolve Guard denied prepare.cjs',
    mutation_succeeded: false,
  })}\n`;
  const provenance = {
    host: 'codex',
    version: '0.144.1',
    capture_source: 'actual_exact_pinned_host',
    model_source: 'deterministic_loopback_protocol_v1',
    bootstrap_commit: 'a'.repeat(40),
    run_id: '123456789',
    job_id: '987654321',
    run_attempt: 1,
    same_head_rerun: false,
    driver_sha256: 'b'.repeat(64),
    raw_stream_sha256: 'c'.repeat(64),
    normalization_map: { project_root: '{{PROJECT_ROOT}}' },
    accepted_pointers: [...EXACT_ACCEPTED_POINTERS.Codex],
    attempt_count: 1,
    denial_count: 1,
    successful_mutation_count: 0,
    vendor_cloud_entitlement_proven: false,
  };
  const valid = { host: 'Codex', version: '0.144.1', attemptSource: attempt,
    denialSource: denial, provenance };
  assert.doesNotThrow(() => assertFixtureBundle(valid));

  const mutated = (change) => {
    const candidate = structuredClone(valid);
    change(candidate);
    return candidate;
  };
  const cases = [
    mutated((candidate) => { candidate.provenance.capture_source = 'fake_host'; }),
    mutated((candidate) => { delete candidate.provenance.driver_sha256; }),
    mutated((candidate) => { candidate.provenance.accepted_pointers.push('/extra'); }),
    mutated((candidate) => { candidate.provenance.version = '0.144.2'; }),
    mutated((candidate) => { candidate.attemptSource += candidate.attemptSource; }),
    mutated((candidate) => { candidate.denialSource += candidate.denialSource; }),
    mutated((candidate) => {
      candidate.attemptSource = `${JSON.stringify({ mutation_succeeded: true })}\n`;
      candidate.provenance.successful_mutation_count = 1;
    }),
    mutated((candidate) => { candidate.provenance.same_head_rerun = true; }),
    mutated((candidate) => { candidate.provenance.run_attempt = 2; }),
    mutated((candidate) => { candidate.provenance.vendor_cloud_entitlement_proven = true; }),
  ];
  for (const candidate of cases) {
    assert.throws(() => assertFixtureBundle(candidate));
  }
});
