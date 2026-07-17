'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
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

const exactStep = (...lines) => lines.join('\n');

const CODEX_RELEASE_STEP_NAMES = [
  'Checkout exact event head',
  'Authenticate exact PR/main provenance',
  'Set up Node 22',
  'Assert Node 22',
  'Install exact Codex 0.144.1',
  'Resolve host and native executable paths',
  'Establish Internet firewall block',
  'Run one secret-free loopback Codex host smoke',
  'Remove Internet firewall block',
  'Upload secret-free raw Codex evidence',
];

const CLAUDE_RELEASE_STEP_NAMES = [
  'Checkout exact event head',
  'Authenticate exact PR/main provenance',
  'Set up Node 22',
  'Assert Node 22',
  'Install exact Claude Code 2.1.207',
  'Resolve host launcher and native child paths',
  'Establish Internet firewall block',
  'Run one secret-free loopback Claude host smoke',
  'Remove Internet firewall block',
  'Upload secret-free raw Claude evidence',
];

const EXACT_CODEX_RESOLVE_STEP = exactStep(
  '      - name: Resolve host and native executable paths',
  '        shell: pwsh',
  '        run: |',
  "          $ErrorActionPreference = 'Stop'",
  "          $artifact = Join-Path $env:RUNNER_TEMP 'deep evolve codex evidence'",
  '          New-Item -ItemType Directory -Force -Path $artifact | Out-Null',
  '          $globalRoot = (& npm root --global).Trim()',
  "          $packageRoot = Join-Path $globalRoot '@openai\\codex'",
  "          $packageJsonPath = Join-Path $packageRoot 'package.json'",
  '          if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {',
  "            throw 'exact Codex npm package is absent after installation'",
  '          }',
  '          $packageJson = Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json',
  "          if ($packageJson.version -ne '0.144.1') {",
  '            throw "unexpected Codex package version: $($packageJson.version)"',
  '          }',
  "          $native = @(Get-ChildItem -LiteralPath $globalRoot -Recurse -File -Filter 'codex.exe' |",
  "            Where-Object { $_.FullName -match '@openai' })",
  '          if ($native.Count -ne 1) {',
  '            throw "expected one exact Codex native child binary, found $($native.Count)"',
  '          }',
  '          $node = (Get-Command node.exe -ErrorAction Stop).Source',
  '          $git = (Get-Command git.exe -ErrorAction Stop).Source',
  '          $gitSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $git).Hash.ToLowerInvariant()',
  '          $programs = @($native[0].FullName, $node, $git) | Sort-Object -Unique',
  '          $record = [ordered]@{',
  '            package_root = $packageRoot',
  '            package_version = $packageJson.version',
  '            package_json_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $packageJsonPath).Hash.ToLowerInvariant()',
  '            host_executable = $native[0].FullName',
  '            host_executable_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $native[0].FullName).Hash.ToLowerInvariant()',
  '            node_launcher = $node',
  '            node_launcher_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $node).Hash.ToLowerInvariant()',
  '            git_executable = $git',
  '            git_executable_sha256 = $gitSha256',
  '            native_child_binary = $native[0].FullName',
  '            program_paths = $programs',
  '          }',
  "          $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $artifact 'host-paths.json')",
  '          "DEEP_EVOLVE_ARTIFACT_DIR=$artifact" | Out-File -FilePath $env:GITHUB_ENV -Append',
  '          "DEEP_EVOLVE_HOST_COMMAND=$($native[0].FullName)" | Out-File -FilePath $env:GITHUB_ENV -Append',
);

const EXACT_CLAUDE_RESOLVE_STEP = exactStep(
  '      - name: Resolve host launcher and native child paths',
  '        shell: pwsh',
  '        run: |',
  "          $ErrorActionPreference = 'Stop'",
  "          $artifact = Join-Path $env:RUNNER_TEMP 'deep evolve claude evidence'",
  '          New-Item -ItemType Directory -Force -Path $artifact | Out-Null',
  '          $globalRootRaw = (& npm root --global).Trim()',
  '          $globalRoot = (Resolve-Path -LiteralPath $globalRootRaw).Path',
  "          $packageRoot = (Resolve-Path -LiteralPath (Join-Path $globalRoot '@anthropic-ai\\claude-code')).Path",
  "          $packageJsonPath = (Resolve-Path -LiteralPath (Join-Path $packageRoot 'package.json')).Path",
  '          $packageJson = Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json',
  "          if ($packageJson.version -ne '2.1.207') {",
  '            throw "unexpected Claude package version: $($packageJson.version)"',
  '          }',
  "          if ($packageJson.bin.claude -ne 'bin/claude.exe') {",
  "            throw 'unexpected Claude package bin mapping'",
  '          }',
  "          $wrapper = (Resolve-Path -LiteralPath (Join-Path $packageRoot 'cli-wrapper.cjs')).Path",
  "          $packageBin = (Resolve-Path -LiteralPath (Join-Path $packageRoot 'bin\\claude.exe')).Path",
  '          $node = (Get-Command node.exe -ErrorAction Stop).Source',
  "          $optionalPackageName = '@anthropic-ai/claude-code-win32-x64'",
  "          $optionalPackageJsonPath = (& $node -e 'const { createRequire } = require(\"node:module\"); const resolver = createRequire(process.argv[1]); process.stdout.write(resolver.resolve(process.argv[2]));' $packageJsonPath \"$optionalPackageName/package.json\").Trim()",
  '          $optionalPackageJsonPath = (Resolve-Path -LiteralPath $optionalPackageJsonPath).Path',
  '          $optionalPackageRoot = Split-Path -Parent $optionalPackageJsonPath',
  '          $optionalPackageJson = Get-Content -Raw -LiteralPath $optionalPackageJsonPath | ConvertFrom-Json',
  "          if ($optionalPackageJson.version -ne '2.1.207') {",
  '            throw "unexpected Claude optional package version: $($optionalPackageJson.version)"',
  '          }',
  "          if (@($optionalPackageJson.os).Count -ne 1 -or @($optionalPackageJson.os)[0] -ne 'win32') {",
  "            throw 'unexpected Claude optional package os metadata'",
  '          }',
  "          if (@($optionalPackageJson.cpu).Count -ne 1 -or @($optionalPackageJson.cpu)[0] -ne 'x64') {",
  "            throw 'unexpected Claude optional package cpu metadata'",
  '          }',
  "          $optionalNative = (Resolve-Path -LiteralPath (Join-Path $optionalPackageRoot 'claude.exe')).Path",
  '          $expectedNative = @($packageBin, $optionalNative) | Sort-Object -Unique',
  "          $claudeNative = @(Get-ChildItem -LiteralPath $globalRoot -Recurse -File -Filter 'claude.exe' |",
  '            ForEach-Object { $_.FullName } | Sort-Object -Unique)',
  '          if ($claudeNative.Count -ne 2) {',
  '            throw "expected exactly two Claude native executables, found $($claudeNative.Count)"',
  '          }',
  '          if (@(Compare-Object -ReferenceObject $expectedNative -DifferenceObject $claudeNative).Count -ne 0) {',
  "            throw 'Claude native executable paths differ from the authenticated expected set'",
  '          }',
  '          $undersized = @($claudeNative | Where-Object { (Get-Item -LiteralPath $_).Length -le 1MB })',
  '          if ($undersized.Count -ne 0) {',
  "            throw 'Claude native executable is unexpectedly small'",
  '          }',
  '          $claudeNativeHashes = @($claudeNative | ForEach-Object { (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLowerInvariant() })',
  '          if (@($claudeNativeHashes | Sort-Object -Unique).Count -ne 1) {',
  "            throw 'Claude native executable hashes differ'",
  '          }',
  '          $hostCommand = $node',
  '          $hostPrefix = $wrapper',
  '          $programs = @($node, $packageBin, $optionalNative) | Sort-Object -Unique',
  '          $record = [ordered]@{',
  '            global_root = $globalRoot',
  '            package_root = $packageRoot',
  '            package_json_path = $packageJsonPath',
  '            package_version = $packageJson.version',
  '            package_json_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $packageJsonPath).Hash.ToLowerInvariant()',
  '            optional_package_root = $optionalPackageRoot',
  '            optional_package_json_path = $optionalPackageJsonPath',
  '            optional_package_version = $optionalPackageJson.version',
  '            optional_package_json_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $optionalPackageJsonPath).Hash.ToLowerInvariant()',
  '            host_executable = $hostCommand',
  '            host_executable_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $hostCommand).Hash.ToLowerInvariant()',
  '            node_launcher = $node',
  '            node_launcher_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $node).Hash.ToLowerInvariant()',
  '            package_bin = $packageBin',
  '            package_bin_bytes = (Get-Item -LiteralPath $packageBin).Length',
  '            package_bin_sha256 = $claudeNativeHashes[0]',
  '            optional_native = $optionalNative',
  '            optional_native_bytes = (Get-Item -LiteralPath $optionalNative).Length',
  '            optional_native_sha256 = $claudeNativeHashes[1]',
  '            host_prefix = $wrapper',
  '            host_prefix_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $wrapper).Hash.ToLowerInvariant()',
  '            program_paths = $programs',
  '          }',
  "          $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $artifact 'host-paths.json')",
  '          "DEEP_EVOLVE_ARTIFACT_DIR=$artifact" | Out-File -FilePath $env:GITHUB_ENV -Append',
  '          "DEEP_EVOLVE_HOST_COMMAND=$($hostCommand)" | Out-File -FilePath $env:GITHUB_ENV -Append',
  '          "DEEP_EVOLVE_HOST_PREFIX=$($hostPrefix)" | Out-File -FilePath $env:GITHUB_ENV -Append',
);

const EXACT_CLAUDE_SMOKE_STEP = exactStep(
  '      - name: Run one secret-free loopback Claude host smoke',
  '        shell: pwsh',
  '        env:',
  '          ANTHROPIC_API_KEY: deep-evolve-loopback-public-v1',
  '        run: |',
  "          $ErrorActionPreference = 'Stop'",
  '          $arguments = @(',
  "            'scripts/smoke-installed-claude-hook.cjs',",
  "            '--host-command', $env:DEEP_EVOLVE_HOST_COMMAND,",
  "            '--artifact-dir', $env:DEEP_EVOLVE_ARTIFACT_DIR,",
  "            '--bootstrap-commit', $env:DEEP_EVOLVE_BOOTSTRAP_COMMIT,",
  "            '--run-id', $env:GITHUB_RUN_ID,",
  "            '--job-id', $env:GITHUB_JOB,",
  "            '--run-attempt', $env:GITHUB_RUN_ATTEMPT",
  '          )',
  '          if ($env:DEEP_EVOLVE_HOST_PREFIX) {',
  "            $arguments += @('--host-prefix', $env:DEEP_EVOLVE_HOST_PREFIX)",
  '          }',
  '          & node @arguments',
  '          if ($LASTEXITCODE -ne 0) {',
  '            throw "Claude host smoke exited $LASTEXITCODE"',
  '          }',
);

function exactFirewallStep(host) {
  return exactStep(
    '      - name: Establish Internet firewall block',
    '        shell: pwsh',
    '        run: |',
    "          $ErrorActionPreference = 'Stop'",
    "          $record = Get-Content -Raw -LiteralPath (Join-Path $env:DEEP_EVOLVE_ARTIFACT_DIR 'host-paths.json') | ConvertFrom-Json",
    '          $rules = @()',
    '          $index = 0',
    '          foreach ($program in $record.program_paths) {',
    '            if (-not (Test-Path -LiteralPath $program -PathType Leaf)) {',
    '              throw "resolved firewall program is absent: $program"',
    '            }',
    `            $name = "deep-evolve-${host}-$env:GITHUB_RUN_ID-$index"`,
    '            New-NetFirewallRule -DisplayName $name -Direction Outbound -Program $program -Action Block -RemoteAddress Internet -Profile Any | Out-Null',
    '            $rules += $name',
    '            $index += 1',
    '          }',
    '          if ($rules.Count -lt 2) {',
    `            throw '${host === 'codex' ? 'host and Node' : 'host, Node, and native child'} firewall programs were not sealed'`,
    '          }',
    "          $rules | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $env:DEEP_EVOLVE_ARTIFACT_DIR 'firewall-rule-names.json')",
    '          [ordered]@{',
    '            established = $true',
    "            direction = 'Outbound'",
    "            action = 'Block'",
    "            remote_address = 'Internet'",
    '            program_paths = @($record.program_paths)',
    '            rule_names = $rules',
    "          } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $env:DEEP_EVOLVE_ARTIFACT_DIR 'firewall-receipt.json')",
  );
}

const LOOPBACK_MODEL = 'deep-evolve-loopback-contract-v1';
const PUBLIC_CLAUDE_HEADER = 'deep-evolve-loopback-public-v1';

const EXACT_CODEX_MODEL_CATALOG = {
  models: [{
    slug: LOOPBACK_MODEL,
    display_name: 'Deep Evolve loopback contract',
    description: 'Deterministic local hook contract model',
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: 'disabled',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    availability_nux: null,
    upgrade: null,
    base_instructions: 'Use the requested apply_patch tool exactly once.',
    supports_reasoning_summaries: false,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    supports_parallel_tool_calls: false,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_search_tool: false,
    use_responses_lite: false,
    tool_mode: 'direct',
  }],
};

const EXACT_CURATED_MARKETPLACE_FILES = [
  {
    path: '.agents/plugins/api_marketplace.json',
    source: `${JSON.stringify({
      name: 'openai-api-curated',
      interface: { displayName: 'OpenAI Curated' },
      plugins: [],
    }, null, 2)}\n`,
  },
  {
    path: '.agents/plugins/marketplace.json',
    source: `${JSON.stringify({ name: 'openai-curated', plugins: [] }, null, 2)}\n`,
  },
];

const REQUIRED_CODEX_MODEL_FIELDS = Object.keys(EXACT_CODEX_MODEL_CATALOG.models[0]);

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

const sha256 = (source) => crypto.createHash('sha256').update(source).digest('hex');

function executablePowerShell(source) {
  const normalizedSource = source
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
  let inBlockComment = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let hereStringEnd = null;
  return normalizedSource.split(/\r?\n/).map((line) => {
    if (hereStringEnd) {
      if (line.trim() === hereStringEnd) hereStringEnd = null;
      return '';
    }

    let executable = '';
    let suppressCarriedString = inSingleQuote || inDoubleQuote;
    for (let index = 0; index < line.length; index += 1) {
      const pair = line.slice(index, index + 2);
      if (inBlockComment) {
        if (pair === '#>') {
          inBlockComment = false;
          index += 1;
        }
        continue;
      }

      const character = line[index];
      if (inSingleQuote) {
        if (character === "'" && line[index + 1] === "'") {
          if (!suppressCarriedString) executable += "''";
          index += 1;
        } else if (character === "'") {
          if (!suppressCarriedString) executable += character;
          inSingleQuote = false;
          suppressCarriedString = false;
        } else if (!suppressCarriedString) {
          executable += character;
        }
        continue;
      }
      if (inDoubleQuote) {
        if (character === '`' && index + 1 < line.length) {
          if (!suppressCarriedString) executable += `${character}${line[index + 1]}`;
          index += 1;
        } else if (character === '"') {
          if (!suppressCarriedString) executable += character;
          inDoubleQuote = false;
          suppressCarriedString = false;
        } else if (!suppressCarriedString) {
          executable += character;
        }
        continue;
      }
      if (!inSingleQuote && !inDoubleQuote && pair === '<#') {
        inBlockComment = true;
        index += 1;
        continue;
      }

      if (character === '#') break;
      executable += character;
      if (character === "'") {
        inSingleQuote = true;
      } else if (character === '"') {
        inDoubleQuote = true;
      }
    }

    const hereString = executable.match(/@(['"])\s*$/);
    if (hereString) {
      hereStringEnd = `${hereString[1]}@`;
      inSingleQuote = false;
      inDoubleQuote = false;
    }
    return executable;
  }).join('\n');
}

function powerShellExecutionRecords(source) {
  const executable = executablePowerShell(source);
  const records = [];
  const blockStack = [];
  let arrayName = null;
  let topLevelTerminated = false;
  let offset = 0;
  for (const line of executable.split('\n')) {
    const trimmed = line.trim();
    let leading = trimmed;
    while (leading.startsWith('}')) {
      assert.notEqual(blockStack.length, 0, `PowerShell oracle found an unmatched block close: ${line}`);
      blockStack.pop();
      leading = leading.slice(1).trimStart();
    }
    if (arrayName !== null && /^\)/.test(leading)) arrayName = null;

    records.push({
      line,
      offset,
      end: offset + line.length,
      controlPath: blockStack.filter(({ kind }) => kind === 'control').map(({ owner }) => owner),
      dataPath: blockStack.filter(({ kind }) => kind === 'data').map(({ name }) => name),
      arrayName,
      reachable: !topLevelTerminated,
    });

    if (blockStack.length === 0 && /^(?:return|exit|throw)\b/i.test(leading)) {
      topLevelTerminated = true;
    }

    const arrayStart = trimmed.match(/^\$([A-Za-z_][\w]*)\s*=\s*@\(\s*$/i);
    if (arrayStart) {
      assert.equal(arrayName, null, 'PowerShell oracle does not allow nested named argv arrays');
      arrayName = arrayStart[1].toLowerCase();
    }

    if (/\{\s*$/.test(leading)) {
      const dataOwner = leading.match(/^(?:\$([A-Za-z_][\w]*)\s*=\s*)?(?:\[ordered\]\s*)?@\{\s*$/i);
      blockStack.push({
        kind: dataOwner ? 'data' : 'control',
        name: dataOwner ? (dataOwner[1]?.toLowerCase() ?? '<anonymous>') : null,
        owner: leading,
      });
    }
    offset += line.length + 1;
  }
  assert.equal(blockStack.length, 0, 'PowerShell oracle found an unclosed block');
  assert.equal(arrayName, null, 'PowerShell oracle found an unclosed named argv array');
  return { executable, records };
}

function assertContractsAndMutants(source, contracts, label) {
  const { executable } = powerShellExecutionRecords(source);
  const assertLocation = (records, contract, match, absoluteOffset) => {
    const nonWhitespace = match[0].search(/\S/);
    const executableOffset = absoluteOffset + (nonWhitespace < 0 ? 0 : nonWhitespace);
    const record = records.find(({ offset, end }) => executableOffset >= offset && executableOffset <= end);
    assert.ok(record, `${label}: cannot locate execution record for ${contract.label}`);
    assert.equal(record.reachable, true,
      `${label}: ${contract.label} must be reachable before an unconditional terminator`);
    const expectedPath = contract.controlPath ?? [];
    assert.equal(record.controlPath.length, expectedPath.length,
      `${label}: ${contract.label} must be reachable through the declared control path`);
    for (let index = 0; index < expectedPath.length; index += 1) {
      assert.match(record.controlPath[index], expectedPath[index],
        `${label}: ${contract.label} has an unexpected control-flow owner`);
    }
    if (contract.arrayName) {
      assert.equal(record.arrayName, contract.arrayName.toLowerCase(),
        `${label}: ${contract.label} must belong to the $${contract.arrayName} array`);
    }
    const expectedDataPath = contract.hashtableName
      ? [contract.hashtableName.toLowerCase()]
      : [];
    assert.deepEqual(record.dataPath, expectedDataPath,
      `${label}: ${contract.label} must belong to the declared live hashtable`);
    assert.doesNotMatch(match[0], /'(?:[^']|'')*\$[A-Za-z_(][^']*'/,
      `${label}: ${contract.label} cannot use a single-quoted variable argument`);
  };
  const assertContracts = (candidate) => {
    const { records } = powerShellExecutionRecords(candidate);
    let offset = 0;
    for (const contract of contracts) {
      const flags = contract.pattern.flags.replace(/[gy]/g, '');
      const orderedPattern = new RegExp(contract.pattern.source, flags);
      const match = orderedPattern.exec(candidate.slice(offset));
      assert.ok(match, `${label}: ${contract.label}`);
      assertLocation(records, contract, match, offset + match.index);
      offset += match.index + match[0].length;
    }
  };
  assertContracts(executable);
  for (const contract of contracts) {
    const match = executable.match(contract.pattern);
    assert.ok(match, `${label}: missing mutation seed for ${contract.label}`);
    const mutant = executable.replace(match[0], `$null = '${contract.label} removed by mutant'`);
    assert.throws(() => assertContracts(mutant), assert.AssertionError,
      `${label}: removing ${contract.label} must fail the contract`);
  }
}

function receiptContract(label, pattern, hashtableName = 'record') {
  return { label, pattern, hashtableName };
}

function workflowStepSection(source, namePattern) {
  const starts = [...source.matchAll(/^ {6}-(?:[ \t]+[^\r\n]*)?$/gm)];
  const steps = starts.map((entry, index) => {
    const end = starts[index + 1]?.index ?? source.length;
    const section = source.slice(entry.index, end);
    const named = section.match(/^ {6}- name:[ \t]*(.+?)[ \t]*$/m);
    return { name: named?.[1] ?? null, section };
  });
  const matches = steps.filter(({ name }) => {
    if (name === null) return false;
    namePattern.lastIndex = 0;
    return namePattern.test(name);
  });
  assert.equal(matches.length, 1,
    `workflow must contain exactly one step matching ${namePattern}, found ${matches.length}`);
  const { section } = matches[0];
  return section.replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

function canonicalWorkflowJob(source, { jobName, expectedStepNames }) {
  const normalized = source.replace(/\r\n/g, '\n');
  const jobsHeader = normalized.match(/^jobs:\s*$/m);
  assert.ok(jobsHeader, 'canonical release-evidence section requires a jobs mapping');
  const jobs = normalized.slice(jobsHeader.index + jobsHeader[0].length);
  const starts = [...jobs.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm)];
  const matches = starts.filter((entry) => entry[1] === jobName);
  assert.equal(matches.length, 1,
    `canonical release-evidence section requires exactly one ${jobName} job`);
  const entry = matches[0];
  const entryIndex = starts.indexOf(entry);
  const end = starts[entryIndex + 1]?.index ?? jobs.length;
  const section = jobs.slice(entry.index, end).replace(/\n+$/, '');
  const stepHeader = section.indexOf('\n    steps:');
  assert.notEqual(stepHeader, -1,
    `canonical release-evidence section requires ${jobName}.steps`);
  assert.equal(section.slice(0, stepHeader + '\n    steps:'.length), exactStep(
    `  ${jobName}:`,
    '    runs-on: windows-latest',
    '    timeout-minutes: 20',
    '',
    '    steps:',
  ), `canonical release-evidence section requires the exact ${jobName} preamble`);

  const stepItems = [...section.matchAll(/^ {6}-(?:[ \t]+[^\r\n]*)?$/gm)];
  const actualNames = stepItems.map((item) => {
    const match = item[0].match(/^ {6}- name:[ \t]*(.+?)[ \t]*$/);
    return match?.[1] ?? null;
  });
  assert.deepEqual(actualNames, expectedStepNames,
    `canonical release-evidence section requires the exact ${jobName} step sequence`);
  return section;
}

function assertExactWorkflowStep(source, namePattern, expectedSection, jobOptions = null) {
  const scope = jobOptions ? canonicalWorkflowJob(source, jobOptions) : source;
  assert.equal(workflowStepSection(scope, namePattern), expectedSection,
    `workflow step matching ${namePattern} must equal the canonical release-evidence section`);
}

function workflowStep(source, namePattern) {
  const section = workflowStepSection(source, namePattern);
  assert.doesNotMatch(section, /^ {8}(?:if|['"]if['"])[ \t]*:[ \t]*.+$/im,
    `workflow step matching ${namePattern} must be active and have no if guard`);
  const runHeaders = [...section.matchAll(/^ {8}run:[ \t]*\|[ \t]*$/gm)];
  assert.equal(runHeaders.length, 1,
    `workflow step matching ${namePattern} must contain exactly one run: | block`);
  const tail = section.slice(runHeaders[0].index + runHeaders[0][0].length);
  const block = [];
  for (const line of tail.split(/\r?\n/).slice(1)) {
    if (line.trim() === '') {
      block.push('');
    } else if (line.startsWith('          ')) {
      block.push(line.slice(10));
    } else {
      break;
    }
  }
  assert.equal(block.some((line) => line.trim() !== ''), true,
    `workflow step matching ${namePattern} must have a non-empty run block`);
  return block.join('\n');
}

function workflowUsesStep(source, namePattern, { always = false } = {}) {
  const section = workflowStepSection(source, namePattern);
  if (always) {
    assert.match(section, /^ {8}if:[ \t]*always\(\)[ \t]*$/m,
      `workflow step matching ${namePattern} must run under exactly always()`);
  } else {
    assert.doesNotMatch(section, /^ {8}(?:if|['"]if['"])[ \t]*:/im,
      `workflow step matching ${namePattern} must be active and have no if guard`);
  }
  assert.equal((section.match(/^ {8}uses:[ \t]*\S+[ \t]*$/gm) || []).length, 1,
    `workflow step matching ${namePattern} must contain exactly one uses action`);
  assert.doesNotMatch(section, /^ {8}run:/m,
    `workflow action step matching ${namePattern} must not replace uses with run`);
  return section;
}

function workflowAlwaysRunStep(source, namePattern) {
  const section = workflowStepSection(source, namePattern);
  assert.match(section, /^ {8}if:[ \t]*always\(\)[ \t]*$/m,
    `workflow step matching ${namePattern} must run under exactly always()`);
  const withoutAlways = section.replace(/^ {8}if:[ \t]*always\(\)[ \t]*\r?\n/m, '');
  return workflowStep(withoutAlways, namePattern);
}

test('PowerShell workflow contracts reject comment and here-string decoys', () => {
  const contract = [{
    label: 'resolved git.exe path',
    pattern: /^\s*\$git\s*=\s*\(Get-Command\s+git\.exe\s+-ErrorAction\s+Stop\)\.Source\s*$/im,
  }];
  const required = '$git = (Get-Command git.exe -ErrorAction Stop).Source';
  for (const decoy of [
    `# ${required}`,
    `$unrelated = 1 # ${required}`,
    `<# ${required} #>`,
    `@'\n${required}\n'@`,
    `@"\n${required}\n"@`,
    `$decoy = "\n${required}\n"`,
    `$decoy = '\n${required}\n'`,
    `$decoy = “\n${required}\n”`,
    `$decoy = ‘\n${required}\n’`,
  ]) {
    assert.throws(() => assertContractsAndMutants(decoy, contract, 'comment oracle'),
      /comment oracle|does not match|expected/i, decoy);
  }
  assert.doesNotThrow(() => assertContractsAndMutants(`${required} # authenticated`,
    contract, 'comment oracle'));

  const firewallContract = [{
    label: 'exact authenticated firewall rule',
    pattern: /^\s*New-NetFirewallRule\s+-DisplayName\s+\$name\s+-Direction\s+Outbound\s+-Program\s+\$program\s+-Action\s+Block\s+-RemoteAddress\s+Internet\s+-Profile\s+Any\s*\|\s*Out-Null\s*$/im,
  }];
  assert.throws(() => assertContractsAndMutants(
    "New-NetFirewallRule -Program C:\\wrong.exe -RemoteAddress LocalSubnet; $decoy = '-Program $program -RemoteAddress Internet'",
    firewallContract, 'firewall oracle'), /firewall oracle|does not match|expected/i);
  assert.doesNotThrow(() => assertContractsAndMutants(
    'New-NetFirewallRule -DisplayName $name -Direction Outbound -Program $program -Action Block -RemoteAddress Internet -Profile Any | Out-Null',
    firewallContract, 'firewall oracle'));
});

test('workflow contract extraction is bound to exactly one named executable step', () => {
  const source = [
    '    steps:',
    '      - name: Resolve authenticated paths',
    '        shell: pwsh',
    '        run: |',
    '          $programs = @($git)',
    '      - name: Establish firewall',
    '        shell: pwsh',
    '        run: |',
    '          New-NetFirewallRule -Program $program',
  ].join('\n');
  assert.match(workflowStep(source, /^Resolve authenticated paths$/), /\$programs/);
  assert.doesNotMatch(workflowStep(source, /^Resolve authenticated paths$/), /New-NetFirewallRule/);
  assert.throws(() => workflowStep(source, /missing/i), /exactly one/i);
  assert.throws(() => workflowStep(source, /authenticated|firewall/i), /exactly one/i);

  const ordered = [
    { label: 'source', pattern: /^\s*\$source\s*=\s*1\s*$/im },
    { label: 'consumer', pattern: /^\s*\$consumer\s*=\s*\$source\s*$/im },
  ];
  assert.throws(() => assertContractsAndMutants(
    '$consumer = $source\n$source = 1', ordered, 'ordered oracle'), /ordered oracle/i);
  assert.doesNotThrow(() => assertContractsAndMutants(
    '$source = 1\n$consumer = $source', ordered, 'ordered oracle'));

  const inert = [
    '    steps:',
    '      - name: Disabled authenticated step',
    '        if: false',
    '        env:',
    '          PAYLOAD: |',
    '            $source = 1',
    '        run: |',
    '          $null = 1',
    '      - uses: example/action@v1',
    '        with:',
    '          payload: |',
    '            $consumer = $source',
  ].join('\n');
  assert.throws(() => workflowStep(inert, /^Disabled authenticated step$/),
    /disabled|active|if: false/i);

  const scoped = inert.replace('        if: false\n', '');
  const runBlock = workflowStep(scoped, /^Disabled authenticated step$/);
  assert.match(runBlock, /^\s*\$null\s*=\s*1\s*$/m);
  assert.doesNotMatch(runBlock, /\$source|\$consumer/);
});

test('workflow contract extraction rejects bare-dash ownership and every explicit if guard', () => {
  const bareDashOwner = [
    '    steps:',
    '      - name: Resolve authenticated paths',
    '        shell: pwsh',
    '      -',
    '        run: |',
    '          $programs = @($git)',
  ].join('\n');
  assert.throws(() => workflowStep(bareDashOwner, /^Resolve authenticated paths$/),
    /step|run block|ownership/i);

  const compoundFalseGuard = [
    '    steps:',
    '      - name: Resolve authenticated paths',
    '        if: ${{ false && always() }}',
    '        shell: pwsh',
    '        run: |',
    '          $programs = @($git)',
  ].join('\n');
  assert.throws(() => workflowStep(compoundFalseGuard, /^Resolve authenticated paths$/),
    /active|if guard|unguarded/i);

  const quotedFalseGuard = compoundFalseGuard.replace(
    '        if: ${{ false && always() }}', '        "if": false');
  assert.throws(() => workflowStep(quotedFalseGuard, /^Resolve authenticated paths$/),
    /active|if guard|unguarded/i);
});

test('PowerShell ordered contracts reject conditionally dead and uncalled-function bodies', () => {
  const contracts = [
    { label: 'source', pattern: /^\s*\$source\s*=\s*1\s*$/im },
    { label: 'consumer', pattern: /^\s*\$consumer\s*=\s*\$source\s*$/im },
  ];
  for (const deadSource of [
    'if ($false) {\n  $source = 1\n  $consumer = $source\n}',
    'function Set-DeadContract {\n  $source = 1\n  $consumer = $source\n}',
    'return\n$source = 1\n$consumer = $source',
  ]) {
    assert.throws(() => assertContractsAndMutants(deadSource, contracts, 'live contract'),
      /live contract|control flow|reachable|top-level/i);
  }
});

test('PowerShell resolver contracts reject single-quoted variable arguments', () => {
  const resolverContract = [{
    label: 'expandable optional package request',
    pattern: /^\s*\$optionalPackageJsonPath\s*=\s*\(&\s*\$node\s+-e\s+['"]resolver['"]\s+\$packageJsonPath\s+['"]\$optionalPackageName\/package\.json['"]\)\.Trim\(\)\s*$/im,
  }];
  const literalVariable = "$optionalPackageJsonPath = (& $node -e 'resolver' $packageJsonPath '$optionalPackageName/package.json').Trim()";
  assert.throws(() => assertContractsAndMutants(literalVariable, resolverContract,
    'expandable resolver argument'), /expandable resolver argument|double-quoted|variable/i);
});

test('PowerShell smoke contracts bind host flags to the invoked arguments array', () => {
  const smokeContracts = [
    { label: 'smoke consumes authenticated host command', pattern: /^\s*['"]--host-command['"]\s*,\s*\$env:DEEP_EVOLVE_HOST_COMMAND\s*,?\s*$/im, arrayName: 'arguments' },
    { label: 'smoke consumes authenticated wrapper prefix', pattern: /^\s*\$arguments\s*\+=\s*@\(['"]--host-prefix['"]\s*,\s*\$env:DEEP_EVOLVE_HOST_PREFIX\)\s*$/im, controlPath: [/^if\s*\(\$env:DEEP_EVOLVE_HOST_PREFIX\)\s*\{$/i] },
    { label: 'smoke invokes the authenticated argv', pattern: /^\s*&\s*node\s+@arguments\s*$/im },
  ];
  const decoy = [
    '$decoy = @(',
    "  '--host-command', $env:DEEP_EVOLVE_HOST_COMMAND,",
    ')',
    "$arguments = @('scripts/smoke-installed-claude-hook.cjs')",
    "if ($env:DEEP_EVOLVE_HOST_PREFIX) {",
    "  $arguments += @('--host-prefix', $env:DEEP_EVOLVE_HOST_PREFIX)",
    '}',
    '& node @arguments',
  ].join('\n');
  assert.throws(() => assertContractsAndMutants(decoy, smokeContracts,
    'bound smoke invocation'), /bound smoke invocation|arguments array|host-command/i);
});

test('canonical workflow sections reject condition, reachability, and consumer-flow mutations', () => {
  const canonical = exactStep(
    '      - name: Canonical evidence',
    '        shell: pwsh',
    '        run: |',
    '          $record = [ordered]@{ program_paths = $programs }',
    "          $arguments = @('--host-command', $env:DEEP_EVOLVE_HOST_COMMAND)",
    '          $record | ConvertTo-Json | Set-Content receipt.json',
    '          & node @arguments',
  );
  const options = {
    jobName: 'windows-evidence',
    expectedStepNames: ['Canonical evidence', 'Next step'],
  };
  const source = `jobs:\n  windows-evidence:\n    runs-on: windows-latest\n    timeout-minutes: 20\n\n    steps:\n${canonical}\n      - name: Next step\n        run: echo next`;
  assert.doesNotThrow(() => assertExactWorkflowStep(source, /^Canonical evidence$/, canonical,
    options));

  for (const mutated of [
    source.replace('        shell: pwsh', '        "if": false\n        shell: pwsh'),
    source.replace('          $record =', "          & { throw 'stop' }\n          $record ="),
    source.replace('          $record |', "          $record = [ordered]@{ program_paths = @('unsafe') }\n          $record |"),
    source.replace('          & node', "          $arguments = @('scripts/unsafe.cjs')\n          & node"),
    source.replace('          & node', "          $env:DEEP_EVOLVE_HOST_PREFIX = ''\n          & node"),
    source.replace('    runs-on: windows-latest', '    "if": false\n    runs-on: windows-latest'),
    source.replace(canonical, '      - name: Wrong target\n        run: echo wrong')
      .replace('jobs:\n', `jobs:\n  disabled-evidence:\n    "if": false\n    runs-on: windows-latest\n    steps:\n${canonical}\n`),
    source.replace('      - name: Next step', "      - name: Overwrite evidence\n        run: Set-Content host-paths.json unsafe\n      - name: Next step"),
  ]) {
    assert.throws(() => assertExactWorkflowStep(mutated, /^Canonical evidence$/, canonical,
      options),
      /canonical release-evidence section/i);
  }
});

test('canonical Claude resolver matches the pinned package bin metadata', () => {
  assert.match(EXACT_CLAUDE_RESOLVE_STEP,
    /if \(\$packageJson\.bin\.claude -ne 'bin\/claude\.exe'\)/);
  assert.match(EXACT_CLAUDE_RESOLVE_STEP,
    /\$wrapper = \(Resolve-Path -LiteralPath \(Join-Path \$packageRoot 'cli-wrapper\.cjs'\)\)\.Path/);
});

function assertAbsoluteChild(parent, candidate, label) {
  assert.equal(path.isAbsolute(candidate), true, `${label} must be absolute`);
  const relative = path.relative(parent, candidate);
  assert.equal(relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'),
    true, `${label} must remain inside the isolated root`);
}

function assertCodexBootstrapReceipt({ bootstrap, isolatedRoot }) {
  assert.equal(bootstrap.schema_version, 1);
  assert.equal(bootstrap.isolated_root, isolatedRoot);
  for (const field of [
    'catalog_path',
    'git_config_path',
    'work_repo_path',
    'bare_remote_path',
  ]) assertAbsoluteChild(isolatedRoot, bootstrap[field], field);

  assert.equal(bootstrap.catalog_path,
    path.join(isolatedRoot, 'codex home with spaces', 'loopback-model-catalog.json'));
  assert.equal(bootstrap.git_config_path, path.join(isolatedRoot, 'git-global.config'));
  assert.equal(bootstrap.work_repo_path, path.join(isolatedRoot, 'curated-work'));
  assert.equal(bootstrap.bare_remote_path,
    path.join(isolatedRoot, 'git-remotes', 'openai', 'plugins.git'));

  const catalogBytes = `${JSON.stringify(EXACT_CODEX_MODEL_CATALOG, null, 2)}\n`;
  assert.deepEqual(bootstrap.catalog, EXACT_CODEX_MODEL_CATALOG);
  assert.equal(bootstrap.catalog_sha256, sha256(catalogBytes));

  const localRemoteUrl = pathToFileURL(
    `${path.join(isolatedRoot, 'git-remotes')}${path.sep}`).href;
  const gitConfigBytes = `[url "${localRemoteUrl}"]\n\tinsteadOf = https://github.com/\n`;
  assert.equal(bootstrap.local_remote_url, localRemoteUrl);
  assert.equal(bootstrap.git_config_source, gitConfigBytes);
  assert.equal(bootstrap.git_config_sha256, sha256(gitConfigBytes));

  assert.deepEqual(bootstrap.curated_files, EXACT_CURATED_MARKETPLACE_FILES.map((entry) => ({
    path: entry.path,
    sha256: sha256(entry.source),
  })));

  assert.match(bootstrap.local_commit, /^[0-9a-f]{40}$/);
  assert.equal(bootstrap.bare_remote_head, bootstrap.local_commit);
  assert.deepEqual(bootstrap.ls_remote.argv,
    ['git', 'ls-remote', 'https://github.com/openai/plugins.git', 'HEAD']);
  assert.equal(bootstrap.ls_remote.exit_code, 0);
  assert.equal(bootstrap.ls_remote.stdout, `${bootstrap.bare_remote_head}\tHEAD\n`);
  assert.equal(bootstrap.ls_remote.stdout_sha256, sha256(bootstrap.ls_remote.stdout));
  assert.equal(bootstrap.ls_remote.stderr, '');
  assert.equal(bootstrap.ls_remote.stderr_sha256, sha256(''));
  assert.equal(bootstrap.ls_remote.external_network_attempt_count, 0);
}

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
    "const http = require('node:http');",
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
    "if (mutation === 'proxy-attempt') {",
    "  const proxy = new URL(process.env.HTTP_PROXY);",
    "  const request = http.request({ hostname: proxy.hostname, port: proxy.port, method: 'GET', path: 'http://example.invalid/forbidden' }, (response) => {",
    "    response.resume();",
    "    response.once('end', () => process.exit(2));",
    "  });",
    "  request.once('error', () => process.exit(2));",
    "  request.end();",
    "} else {",
    "  fs.writeFileSync(`${tracePath}.host-invoked-time`, `${new Date().toISOString()}\\n`);",
    "  fs.appendFileSync(`${tracePath}.host-invoked`, `${JSON.stringify(argv)}\\n`);",
    "  process.stdout.write('Deep Evolve Guard denied prepare.cjs\\n');",
    "}",
  ].join('\n');
  fs.writeFileSync(target, `${source}\n`);
  return target;
}

function runFakeHostSmoke({ host, mutation = 'clean', bootstrapMutation = 'clean' }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `deep-evolve ${host} fake smoke `));
  const tracePath = path.join(directory, 'trace.jsonl');
  const gitTracePath = path.join(directory, 'git-trace2.jsonl');
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
    env: {
      ...process.env,
      DEEP_EVOLVE_TEST_ONLY_FAKE_HOST: '1',
      DEEP_EVOLVE_TEST_ONLY_BOOTSTRAP_MUTATION: bootstrapMutation,
      GIT_TRACE2_EVENT: gitTracePath,
    },
  });
  return { directory, tracePath, gitTracePath, artifactDir, result };
}

function assertObservedGitRewriteProbe(gitTracePath, { expectSuccess }) {
  assert.equal(fs.existsSync(gitTracePath), true,
    'real Git must author an independent trace2 event stream');
  const events = fs.readFileSync(gitTracePath, 'utf8').trim().split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const probes = events.filter((event) => event.event === 'start'
    && Array.isArray(event.argv)
    && event.argv.length === 4
    && event.argv.slice(1).join('\0') === [
      'ls-remote', 'https://github.com/openai/plugins.git', 'HEAD',
    ].join('\0'));
  assert.equal(probes.length, 1,
    'real Git must execute the exact curated ls-remote probe once');
  const exit = events.find((event) => event.event === 'exit' && event.sid === probes[0].sid);
  assert.ok(exit, 'real Git trace must record the exact probe exit');
  assert.equal(Number.isFinite(Date.parse(exit.time)), true,
    'real Git trace exit must have a comparable timestamp');
  if (expectSuccess) assert.equal(exit.code, 0, 'local rewrite probe must succeed');
  else assert.notEqual(exit.code, 0, 'missing local rewrite root must fail in real Git');
  return { start: probes[0], exit };
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
    const jobOptions = host === 'Codex'
      ? { jobName: 'windows-codex-host-smoke', expectedStepNames: CODEX_RELEASE_STEP_NAMES }
      : { jobName: 'windows-claude-host-smoke', expectedStepNames: CLAUDE_RELEASE_STEP_NAMES };
    const workflowJob = canonicalWorkflowJob(workflow, jobOptions);
    assert.match(workflow, new RegExp(job));
    assert.match(workflow, /^\s*pull_request:\s*$/m);
    assert.match(workflow, /^\s*push:\s*$/m);
    assert.match(workflow, /branches:\s*\[?\s*main\s*\]?/);
    assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
    assert.match(workflow, /permissions:\s*\r?\n\s+contents:\s*read/);
    assert.match(workflowJob, /runs-on:\s*windows-latest/);
    const checkoutStep = workflowUsesStep(workflowJob, /^Checkout exact event head$/);
    assert.match(checkoutStep, /^ {8}uses:\s*actions\/checkout@v4\s*$/m);
    const provenanceSection = workflowStepSection(workflowJob,
      /^Authenticate exact PR\/main provenance$/);
    const provenanceRun = workflowStep(workflowJob,
      /^Authenticate exact PR\/main provenance$/);
    assert.match(provenanceSection, /PR_HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/i);
    assert.match(provenanceSection,
      /PR_HEAD_REPOSITORY:\s*\$\{\{\s*github\.event\.pull_request\.head\.repo\.full_name\s*\}\}/i);
    assert.match(provenanceRun, /EVENT_NAME\s+-eq\s+['"]pull_request['"][\s\S]*PR_HEAD_REPOSITORY\s+-ne\s+\$canonical/i);
    assert.match(provenanceRun, /EVENT_NAME\s+-eq\s+['"]pull_request['"][\s\S]*\$head\s+-ne\s+\$env:PR_HEAD_SHA/i);
    assert.match(provenanceRun, /EVENT_NAME\s+-eq\s+['"]push['"][\s\S]*\$head\s+-ne\s+\$env:EVENT_SHA/i);
    assert.match(provenanceRun, /refs\/heads\/main[\s\S]*origin\/main/i);
    const setupStep = workflowUsesStep(workflowJob, /^Set up Node 22$/);
    assert.match(setupStep, /^ {8}uses:\s*actions\/setup-node@v4\s*$/m);
    assert.match(setupStep, /node-version:\s*['"]22['"]/);
    const assertNodeStep = workflowStep(workflowJob, /^Assert Node 22$/);
    assert.match(assertNodeStep, /node --version|node\.exe --version/i);
    const installStep = workflowStep(workflowJob,
      new RegExp(`^Install exact .*${version.replace(/\./g, '\\.')}.*$`));
    assert.match(installStep, new RegExp(version.replace(/\./g, '\\.')));
    const hostSmokeStep = workflowStep(workflowJob,
      new RegExp(`^Run one secret-free loopback ${host} host smoke$`));
    assert.match(hostSmokeStep,
      new RegExp(`smoke-installed-${host.toLowerCase()}-hook\\.cjs`));
    const cleanupStep = workflowAlwaysRunStep(workflowJob,
      /^Remove Internet firewall block$/);
    assert.match(cleanupStep, /Remove-NetFirewallRule/);
    const uploadStep = workflowUsesStep(workflowJob,
      new RegExp(`^Upload secret-free raw ${host} evidence$`), { always: true });
    assert.match(uploadStep, /^ {8}uses:\s*actions\/upload-artifact@v4\s*$/m);
    assert.match(workflowJob, /New-NetFirewallRule/);
    assert.match(workflowJob, /RemoteAddress\s+Internet|-RemoteAddress\s+['"]?Internet/i);
    assert.match(workflowJob, /Remove-NetFirewallRule/);
    assert.match(workflowJob, /if:\s*always\(\)/);
    assert.doesNotMatch(workflow, /^\s*environment:/m);
    assert.doesNotMatch(workflow, /\$\{\{\s*(?:secrets|vars)\./);
    assert.doesNotMatch(workflow, /\b(?:codex|claude)\s+login\b/i);
    assert.doesNotMatch(workflow, /--test-fake-host|DEEP_EVOLVE_TEST_ONLY_FAKE_HOST/);

    const withoutPublicSentinel = workflow.replace(
      /ANTHROPIC_API_KEY:\s*deep-evolve-loopback-public-v1/g, '');
    assert.doesNotMatch(withoutPublicSentinel,
      /OPENAI_API_KEY|CODEX_ACCESS_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_MODEL|ANTHROPIC_MODEL|CLAUDE_MODEL|CODEX_HOOK_SMOKE_MODEL|CLAUDE_HOOK_SMOKE_MODEL/);

    if (host === 'Codex') {
      assert.match(workflowJob, /@openai\/codex@0\.144\.1/);
      assert.doesNotMatch(workflow, /deep-evolve-loopback-public-v1/);
      assertExactWorkflowStep(workflow, /^Resolve host and native executable paths$/,
        EXACT_CODEX_RESOLVE_STEP, jobOptions);
      assertExactWorkflowStep(workflow, /^Establish Internet firewall block$/,
        exactFirewallStep('codex'), jobOptions);
      const resolveStep = workflowStep(workflowJob, /^Resolve host and native executable paths$/);
      const firewallStep = workflowStep(workflowJob, /^Establish Internet firewall block$/);
      assertContractsAndMutants(resolveStep, [
        { label: 'resolved git.exe path', pattern: /^\s*\$git\s*=\s*\(Get-Command\s+git\.exe\s+-ErrorAction\s+Stop\)\.Source\s*$/im },
        { label: 'git.exe byte hash', pattern: /^\s*\$gitSha256\s*=\s*\(Get-FileHash\s+-Algorithm\s+SHA256\s+-LiteralPath\s+\$git\)\.Hash\.ToLowerInvariant\(\)\s*$/im },
        { label: 'git.exe in authenticated programs', pattern: /^\s*\$programs\s*=\s*@\(\$native\[0\]\.FullName,\s*\$node,\s*\$git\)\s*\|\s*Sort-Object\s+-Unique\s*$/im },
        receiptContract('git.exe path in host receipt', /^\s*git_executable\s*=\s*\$git\s*$/im),
        receiptContract('git.exe hash in host receipt', /^\s*git_executable_sha256\s*=\s*\$gitSha256\s*$/im),
        receiptContract('authenticated programs in host receipt', /^\s*program_paths\s*=\s*\$programs\s*$/im),
      ], 'Codex authenticated host-path step');
      assertContractsAndMutants(firewallStep, [
        { label: 'authenticated program firewall loop', pattern: /^\s*foreach\s*\(\$program\s+in\s+\$record\.program_paths\)\s*\{\s*$/im },
        { label: 'firewall rule bound to program', pattern: /^\s*New-NetFirewallRule\s+-DisplayName\s+\$name\s+-Direction\s+Outbound\s+-Program\s+\$program\s+-Action\s+Block\s+-RemoteAddress\s+Internet\s+-Profile\s+Any\s*\|\s*Out-Null\s*$/im, controlPath: [/^foreach\s*\(\$program\s+in\s+\$record\.program_paths\)\s*\{$/i] },
        receiptContract('firewall receipt bound to authenticated programs', /^\s*program_paths\s*=\s*@\(\$record\.program_paths\)\s*$/im, '<anonymous>'),
      ], 'Codex authenticated firewall step');
    } else {
      assert.match(workflowJob, /@anthropic-ai\/claude-code@2\.1\.207/);
      assert.equal((workflow.match(/deep-evolve-loopback-public-v1/g) || []).length, 1);
      const hostStep = workflowJob.split(/^\s{6}- name:/m)
        .find((step) => step.includes(PUBLIC_CLAUDE_HEADER));
      assert.ok(hostStep, 'public Claude sentinel must be scoped to one host step');
      assert.match(hostStep, /smoke-installed-claude-hook\.cjs/);
      assert.match(hostStep, /ANTHROPIC_API_KEY:\s*deep-evolve-loopback-public-v1/);
      assertExactWorkflowStep(workflow, /^Resolve host launcher and native child paths$/,
        EXACT_CLAUDE_RESOLVE_STEP, jobOptions);
      assertExactWorkflowStep(workflow, /^Run one secret-free loopback Claude host smoke$/,
        EXACT_CLAUDE_SMOKE_STEP, jobOptions);
      assertExactWorkflowStep(workflow, /^Establish Internet firewall block$/,
        exactFirewallStep('claude'), jobOptions);
      const resolveStep = workflowStep(workflowJob, /^Resolve host launcher and native child paths$/);
      const smokeStep = hostSmokeStep;
      const firewallStep = workflowStep(workflowJob, /^Establish Internet firewall block$/);
      assertContractsAndMutants(resolveStep, [
        { label: 'global npm root source', pattern: /^\s*\$globalRootRaw\s*=\s*\(&\s*npm\s+root\s+--global\)\.Trim\(\)\s*$/im },
        { label: 'canonical global npm root', pattern: /^\s*\$globalRoot\s*=\s*\(Resolve-Path\s+-LiteralPath\s+\$globalRootRaw\)\.Path\s*$/im },
        { label: 'official package root path', pattern: /^\s*\$packageRoot\s*=\s*\(Resolve-Path\s+-LiteralPath\s+\(Join-Path\s+\$globalRoot\s+['"]@anthropic-ai\\claude-code['"]\)\)\.Path\s*$/im },
        { label: 'official package JSON path', pattern: /^\s*\$packageJsonPath\s*=\s*\(Resolve-Path\s+-LiteralPath\s+\(Join-Path\s+\$packageRoot\s+['"]package\.json['"]\)\)\.Path\s*$/im },
        { label: 'official package JSON source', pattern: /^\s*\$packageJson\s*=\s*Get-Content\s+-Raw\s+-LiteralPath\s+\$packageJsonPath\s*\|\s*ConvertFrom-Json\s*$/im },
        { label: 'official package exact version', pattern: /^\s*if\s*\(\$packageJson\.version\s+-ne\s+['"]2\.1\.207['"]\)\s*\{\s*$/im },
        { label: 'package bin is exact native path', pattern: /^\s*if\s*\(\$packageJson\.bin\.claude\s+-ne\s+['"]bin\/claude\.exe['"]\)\s*\{\s*$/im },
        { label: 'exact cli-wrapper path', pattern: /^\s*\$wrapper\s*=\s*\(Resolve-Path\s+-LiteralPath\s+\(Join-Path\s+\$packageRoot\s+['"]cli-wrapper\.cjs['"]\)\)\.Path\s*$/im },
        { label: 'exact package native path', pattern: /^\s*\$packageBin\s*=\s*\(Resolve-Path\s+-LiteralPath\s+\(Join-Path\s+\$packageRoot\s+['"]bin\\claude\.exe['"]\)\)\.Path\s*$/im },
        { label: 'authenticated Node source', pattern: /^\s*\$node\s*=\s*\(Get-Command\s+node\.exe\s+-ErrorAction\s+Stop\)\.Source\s*$/im },
        { label: 'exact optional package name', pattern: /^\s*\$optionalPackageName\s*=\s*['"]@anthropic-ai\/claude-code-win32-x64['"]\s*$/im },
        { label: 'optional package resolved from official package by authenticated Node', pattern: /^\s*\$optionalPackageJsonPath\s*=\s*\(&\s*\$node\s+-e\s+['"]const \{ createRequire \} = require\(['"]node:module['"]\); const resolver = createRequire\(process\.argv\[1\]\); process\.stdout\.write\(resolver\.resolve\(process\.argv\[2\]\)\);['"]\s+\$packageJsonPath\s+"\$optionalPackageName\/package\.json"\)\.Trim\(\)\s*$/im },
        { label: 'optional package JSON canonical path', pattern: /^\s*\$optionalPackageJsonPath\s*=\s*\(Resolve-Path\s+-LiteralPath\s+\$optionalPackageJsonPath\)\.Path\s*$/im },
        { label: 'optional package root binding', pattern: /^\s*\$optionalPackageRoot\s*=\s*Split-Path\s+-Parent\s+\$optionalPackageJsonPath\s*$/im },
        { label: 'optional package JSON source', pattern: /^\s*\$optionalPackageJson\s*=\s*Get-Content\s+-Raw\s+-LiteralPath\s+\$optionalPackageJsonPath\s*\|\s*ConvertFrom-Json\s*$/im },
        { label: 'optional package exact version', pattern: /^\s*if\s*\(\$optionalPackageJson\.version\s+-ne\s+['"]2\.1\.207['"]\)\s*\{\s*$/im },
        { label: 'optional package win32 metadata', pattern: /^\s*if\s*\(@\(\$optionalPackageJson\.os\)\.Count\s+-ne\s+1\s+-or\s+@\(\$optionalPackageJson\.os\)\[0\]\s+-ne\s+['"]win32['"]\)\s*\{\s*$/im },
        { label: 'optional package x64 metadata', pattern: /^\s*if\s*\(@\(\$optionalPackageJson\.cpu\)\.Count\s+-ne\s+1\s+-or\s+@\(\$optionalPackageJson\.cpu\)\[0\]\s+-ne\s+['"]x64['"]\)\s*\{\s*$/im },
        { label: 'optional native rooted in optional package', pattern: /^\s*\$optionalNative\s*=\s*\(Resolve-Path\s+-LiteralPath\s+\(Join-Path\s+\$optionalPackageRoot\s+['"]claude\.exe['"]\)\)\.Path\s*$/im },
        { label: 'exact expected executable set', pattern: /^\s*\$expectedNative\s*=\s*@\(\$packageBin,\s*\$optionalNative\)\s*\|\s*Sort-Object\s+-Unique\s*$/im },
        { label: 'installed executable discovery', pattern: /^\s*\$claudeNative\s*=\s*@\(Get-ChildItem\s+-LiteralPath\s+\$globalRoot\s+-Recurse\s+-File\s+-Filter\s+['"]claude\.exe['"]\s*\|[\s\S]*?ForEach-Object\s*\{\s*\$_\.FullName\s*\}\s*\|\s*Sort-Object\s+-Unique\)\s*$/im },
        { label: 'exact executable count', pattern: /^\s*if\s*\(\$claudeNative\.Count\s+-ne\s+2\)\s*\{\s*$/im },
        { label: 'installed executable exact-set equality', pattern: /^\s*if\s*\(@\(Compare-Object\s+-ReferenceObject\s+\$expectedNative\s+-DifferenceObject\s+\$claudeNative\)\.Count\s+-ne\s+0\)\s*\{\s*$/im },
        { label: 'both executable sizes', pattern: /^\s*\$undersized\s*=\s*@\(\$claudeNative\s*\|\s*Where-Object\s*\{\s*\(Get-Item\s+-LiteralPath\s+\$_\)\.Length\s+-le\s+1MB\s*\}\)\s*$/im },
        { label: 'undersized executable rejection', pattern: /^\s*if\s*\(\$undersized\.Count\s+-ne\s+0\)\s*\{\s*$/im },
        { label: 'hashes derived from both executables', pattern: /^\s*\$claudeNativeHashes\s*=\s*@\(\$claudeNative\s*\|\s*ForEach-Object\s*\{\s*\(Get-FileHash\s+-Algorithm\s+SHA256\s+-LiteralPath\s+\$_\)\.Hash\.ToLowerInvariant\(\)\s*\}\)\s*$/im },
        { label: 'identical executable hashes', pattern: /^\s*if\s*\(@\(\$claudeNativeHashes\s*\|\s*Sort-Object\s+-Unique\)\.Count\s+-ne\s+1\)\s*\{\s*$/im },
        { label: 'Node host command', pattern: /^\s*\$hostCommand\s*=\s*\$node\s*$/im },
        { label: 'wrapper host prefix', pattern: /^\s*\$hostPrefix\s*=\s*\$wrapper\s*$/im },
        { label: 'Node and both executables firewalled', pattern: /^\s*\$programs\s*=\s*@\(\$node,\s*\$packageBin,\s*\$optionalNative\)\s*\|\s*Sort-Object\s+-Unique\s*$/im },
        receiptContract('global root receipt binding', /^\s*global_root\s*=\s*\$globalRoot\s*$/im),
        receiptContract('package root receipt binding', /^\s*package_root\s*=\s*\$packageRoot\s*$/im),
        receiptContract('package JSON path receipt binding', /^\s*package_json_path\s*=\s*\$packageJsonPath\s*$/im),
        receiptContract('package version receipt binding', /^\s*package_version\s*=\s*\$packageJson\.version\s*$/im),
        receiptContract('package JSON hash receipt binding', /^\s*package_json_sha256\s*=\s*\(Get-FileHash\s+-Algorithm\s+SHA256\s+-LiteralPath\s+\$packageJsonPath\)\.Hash\.ToLowerInvariant\(\)\s*$/im),
        receiptContract('optional package root receipt binding', /^\s*optional_package_root\s*=\s*\$optionalPackageRoot\s*$/im),
        receiptContract('optional package JSON path receipt binding', /^\s*optional_package_json_path\s*=\s*\$optionalPackageJsonPath\s*$/im),
        receiptContract('optional package version receipt binding', /^\s*optional_package_version\s*=\s*\$optionalPackageJson\.version\s*$/im),
        receiptContract('optional package JSON hash receipt binding', /^\s*optional_package_json_sha256\s*=\s*\(Get-FileHash\s+-Algorithm\s+SHA256\s+-LiteralPath\s+\$optionalPackageJsonPath\)\.Hash\.ToLowerInvariant\(\)\s*$/im),
        receiptContract('host executable receipt binding', /^\s*host_executable\s*=\s*\$hostCommand\s*$/im),
        receiptContract('host executable hash receipt binding', /^\s*host_executable_sha256\s*=\s*\(Get-FileHash\s+-Algorithm\s+SHA256\s+-LiteralPath\s+\$hostCommand\)\.Hash\.ToLowerInvariant\(\)\s*$/im),
        receiptContract('Node receipt binding', /^\s*node_launcher\s*=\s*\$node\s*$/im),
        receiptContract('Node hash receipt binding', /^\s*node_launcher_sha256\s*=\s*\(Get-FileHash\s+-Algorithm\s+SHA256\s+-LiteralPath\s+\$node\)\.Hash\.ToLowerInvariant\(\)\s*$/im),
        receiptContract('package executable receipt binding', /^\s*package_bin\s*=\s*\$packageBin\s*$/im),
        receiptContract('package executable size receipt binding', /^\s*package_bin_bytes\s*=\s*\(Get-Item\s+-LiteralPath\s+\$packageBin\)\.Length\s*$/im),
        receiptContract('package executable hash receipt binding', /^\s*package_bin_sha256\s*=\s*\$claudeNativeHashes\[0\]\s*$/im),
        receiptContract('optional executable receipt binding', /^\s*optional_native\s*=\s*\$optionalNative\s*$/im),
        receiptContract('optional executable size receipt binding', /^\s*optional_native_bytes\s*=\s*\(Get-Item\s+-LiteralPath\s+\$optionalNative\)\.Length\s*$/im),
        receiptContract('optional executable hash receipt binding', /^\s*optional_native_sha256\s*=\s*\$claudeNativeHashes\[1\]\s*$/im),
        receiptContract('wrapper receipt binding', /^\s*host_prefix\s*=\s*\$wrapper\s*$/im),
        receiptContract('wrapper hash receipt binding', /^\s*host_prefix_sha256\s*=\s*\(Get-FileHash\s+-Algorithm\s+SHA256\s+-LiteralPath\s+\$wrapper\)\.Hash\.ToLowerInvariant\(\)\s*$/im),
        receiptContract('authenticated programs in host receipt', /^\s*program_paths\s*=\s*\$programs\s*$/im),
        { label: 'host command exported to smoke', pattern: /^\s*['"]DEEP_EVOLVE_HOST_COMMAND=\$\(\$hostCommand\)['"]\s*\|\s*Out-File\s+-FilePath\s+\$env:GITHUB_ENV\s+-Append\s*$/im },
        { label: 'host prefix exported to smoke', pattern: /^\s*['"]DEEP_EVOLVE_HOST_PREFIX=\$\(\$hostPrefix\)['"]\s*\|\s*Out-File\s+-FilePath\s+\$env:GITHUB_ENV\s+-Append\s*$/im },
      ], 'Claude authenticated host-path step');
      const executableResolveStep = executablePowerShell(resolveStep);
      assert.doesNotMatch(executableResolveStep,
        /ambiguous Claude native executable count|\$claudeNative\.Count\s+-(?:gt|eq)\s+1/i);
      assert.equal((executableResolveStep.match(/^\s*\$hostCommand\s*=/gim) || []).length, 1,
        'Claude host command must have exactly one assignment');
      assert.equal((executableResolveStep.match(/^\s*\$hostPrefix\s*=/gim) || []).length, 1,
        'Claude host prefix must have exactly one assignment');
      assertContractsAndMutants(smokeStep, [
        { label: 'smoke consumes authenticated host command', pattern: /^\s*['"]--host-command['"]\s*,\s*\$env:DEEP_EVOLVE_HOST_COMMAND\s*,?\s*$/im, arrayName: 'arguments' },
        { label: 'smoke consumes authenticated wrapper prefix', pattern: /^\s*\$arguments\s*\+=\s*@\(['"]--host-prefix['"]\s*,\s*\$env:DEEP_EVOLVE_HOST_PREFIX\)\s*$/im, controlPath: [/^if\s*\(\$env:DEEP_EVOLVE_HOST_PREFIX\)\s*\{$/i] },
        { label: 'smoke invokes the authenticated argv', pattern: /^\s*&\s*node\s+@arguments\s*$/im },
      ], 'Claude authenticated smoke invocation step');
      assertContractsAndMutants(firewallStep, [
        { label: 'authenticated program firewall loop', pattern: /^\s*foreach\s*\(\$program\s+in\s+\$record\.program_paths\)\s*\{\s*$/im },
        { label: 'firewall rule bound to program', pattern: /^\s*New-NetFirewallRule\s+-DisplayName\s+\$name\s+-Direction\s+Outbound\s+-Program\s+\$program\s+-Action\s+Block\s+-RemoteAddress\s+Internet\s+-Profile\s+Any\s*\|\s*Out-Null\s*$/im, controlPath: [/^foreach\s*\(\$program\s+in\s+\$record\.program_paths\)\s*\{$/i] },
        receiptContract('firewall receipt bound to authenticated programs', /^\s*program_paths\s*=\s*@\(\$record\.program_paths\)\s*$/im, '<anonymous>'),
      ], 'Claude authenticated firewall step');
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
      if (host === 'codex') {
        const bootstrap = JSON.parse(fs.readFileSync(path.join(run.artifactDir,
          'codex-local-bootstrap-receipt.json'), 'utf8'));
        assertCodexBootstrapReceipt({ bootstrap, isolatedRoot: receipt.isolated_root });
        const gitProbe = assertObservedGitRewriteProbe(run.gitTracePath,
          { expectSuccess: true });
        const hostInvokedAt = Date.parse(fs.readFileSync(
          `${run.tracePath}.host-invoked-time`, 'utf8').trim());
        assert.equal(Number.isFinite(hostInvokedAt), true,
          'fake host must record an independently comparable invocation time');
        assert.ok(Date.parse(gitProbe.exit.time) <= hostInvokedAt,
          'real Git rewrite probe must complete before the first host invocation');
        const proxy = JSON.parse(fs.readFileSync(path.join(run.artifactDir,
          'codex-local-bootstrap-deny-proxy-receipt.json'), 'utf8'));
        assert.equal(proxy.schema_version, 1);
        assert.equal(proxy.external_network_attempt_count, 0);
        assert.deepEqual(proxy.external_network_attempts, []);
      }
    } finally {
      fs.rmSync(run.directory, { recursive: true, force: true });
    }
  });

  if (host === 'codex') {
    test('codex local curated bootstrap rejects manifest and rewrite mutations offline', () => {
      for (const bootstrapMutation of [
        'missing-curated-marketplace',
        'missing-api-marketplace',
        'missing-local-git-remote',
      ]) {
        const run = runFakeHostSmoke({ host, bootstrapMutation });
        try {
          assert.equal(run.result.status, 2,
            `${bootstrapMutation}: ${run.result.stderr || run.result.stdout}`);
          assert.match(run.result.stderr, /curated|marketplace|ls-remote|local git/i);
          assert.equal(fs.existsSync(`${run.tracePath}.host-invoked`), false);
          const proxy = JSON.parse(fs.readFileSync(path.join(run.artifactDir,
            'codex-local-bootstrap-deny-proxy-receipt.json'), 'utf8'));
          assert.equal(proxy.schema_version, 1);
          assert.equal(proxy.external_network_attempt_count, 0);
          assert.deepEqual(proxy.external_network_attempts, []);
          const failure = JSON.parse(fs.readFileSync(path.join(run.artifactDir,
            'codex-local-bootstrap-failure.json'), 'utf8'));
          assert.equal(failure.schema_version, 1);
          assert.equal(failure.mutation, bootstrapMutation);
          assert.equal(failure.external_network_attempt_count, 0);
          if (bootstrapMutation === 'missing-local-git-remote') {
            assertObservedGitRewriteProbe(run.gitTracePath, { expectSuccess: false });
          }
        } finally {
          fs.rmSync(run.directory, { recursive: true, force: true });
        }
      }

      const run = runFakeHostSmoke({ host, mutation: 'proxy-attempt' });
      try {
        assert.equal(run.result.status, 2, run.result.stdout);
        const proxy = JSON.parse(fs.readFileSync(path.join(run.artifactDir,
          'codex-local-bootstrap-deny-proxy-receipt.json'), 'utf8'));
        assert.equal(proxy.schema_version, 1);
        assert.equal(proxy.external_network_attempt_count, 1);
        assert.equal(proxy.external_network_attempts.length, 1);
        assert.equal(proxy.external_network_attempts[0].url,
          'http://example.invalid/forbidden');
        const failure = JSON.parse(fs.readFileSync(path.join(run.artifactDir,
          'codex-smoke-failure.json'), 'utf8'));
        assert.equal(failure.external_network_attempt_count, 1);
        assert.deepEqual(failure.external_network_attempts,
          proxy.external_network_attempts);
      } finally {
        fs.rmSync(run.directory, { recursive: true, force: true });
      }
    });
  }

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
    'buildCodexModelCatalog',
    'validateCodexModelCatalog',
    'buildCodexConfig',
    'buildIsolatedHostEnv',
    'createLoopbackDriver',
    'directoryFileUrl',
    'normalizeActualHostRecords',
  ].sort());
  assert.equal(helper.LOOPBACK_MODEL, LOOPBACK_MODEL);
  assert.equal(helper.PUBLIC_CLAUDE_HEADER, PUBLIC_CLAUDE_HEADER);

  assert.deepEqual(helper.buildCodexModelCatalog(), EXACT_CODEX_MODEL_CATALOG);
  assert.doesNotThrow(() => helper.validateCodexModelCatalog(EXACT_CODEX_MODEL_CATALOG));
  for (const field of REQUIRED_CODEX_MODEL_FIELDS) {
    const mutated = structuredClone(EXACT_CODEX_MODEL_CATALOG);
    delete mutated.models[0][field];
    assert.throws(() => helper.validateCodexModelCatalog(mutated),
      new RegExp(field, 'i'), `missing ${field}`);
  }

  const invalidShapes = [
    ['null outer value', null],
    ['array outer value', []],
    ['missing models', {}],
    ['models is not an array', { models: {} }],
    ['empty model catalog', { models: [] }],
    ['multiple model catalog', {
      models: [
        structuredClone(EXACT_CODEX_MODEL_CATALOG.models[0]),
        structuredClone(EXACT_CODEX_MODEL_CATALOG.models[0]),
      ],
    }],
    ['model is not a plain object', { models: [[]] }],
    ['unknown outer key', { ...structuredClone(EXACT_CODEX_MODEL_CATALOG), extra: true }],
  ];
  for (const [label, mutated] of invalidShapes) {
    assert.throws(() => helper.validateCodexModelCatalog(mutated),
      undefined, label);
  }

  for (const [field, expected] of Object.entries(EXACT_CODEX_MODEL_CATALOG.models[0])) {
    const wrongType = structuredClone(EXACT_CODEX_MODEL_CATALOG);
    if (expected === null) wrongType.models[0][field] = 'not-null';
    else if (Array.isArray(expected)) wrongType.models[0][field] = {};
    else if (typeof expected === 'boolean') wrongType.models[0][field] = String(expected);
    else if (typeof expected === 'number') wrongType.models[0][field] = String(expected);
    else if (typeof expected === 'string') wrongType.models[0][field] = { value: expected };
    else wrongType.models[0][field] = [];
    assert.throws(() => helper.validateCodexModelCatalog(wrongType),
      undefined, `wrong type for ${field}`);
  }

  for (const [field, expected] of Object.entries(EXACT_CODEX_MODEL_CATALOG.models[0])) {
    if (expected === null) continue;
    const wrongValue = structuredClone(EXACT_CODEX_MODEL_CATALOG);
    if (Array.isArray(expected)) {
      wrongValue.models[0][field] = expected.length === 0 ? ['unexpected'] : ['different'];
    } else if (typeof expected === 'boolean') {
      wrongValue.models[0][field] = !expected;
    } else if (typeof expected === 'number') {
      wrongValue.models[0][field] = expected + 1;
    } else if (typeof expected === 'string') {
      wrongValue.models[0][field] = `${expected}-different`;
    } else {
      wrongValue.models[0][field] = { ...expected, mode: 'tokens' };
    }
    assert.throws(() => helper.validateCodexModelCatalog(wrongValue),
      undefined, `same-type wrong value for ${field}`);
  }

  for (const [field, replacement] of [
    ['slug', 'other-model'],
    ['shell_type', 'shell'],
    ['visibility', 'hidden'],
    ['supported_in_api', false],
    ['priority', 2],
    ['base_instructions', 'Ignore the requested tool.'],
    ['supports_reasoning_summaries', true],
    ['support_verbosity', true],
    ['apply_patch_tool_type', 'json'],
    ['supports_parallel_tool_calls', true],
    ['experimental_supported_tools', ['web_search']],
    ['input_modalities', ['audio']],
    ['supports_search_tool', true],
    ['use_responses_lite', true],
    ['tool_mode', 'auto'],
  ]) {
    const wrongValue = structuredClone(EXACT_CODEX_MODEL_CATALOG);
    wrongValue.models[0][field] = replacement;
    assert.throws(() => helper.validateCodexModelCatalog(wrongValue),
      undefined, `wrong value for ${field}`);
  }

  for (const [label, truncationPolicy] of [
    ['missing truncation mode', { limit: 10_000 }],
    ['missing truncation limit', { mode: 'bytes' }],
    ['unknown truncation key', { mode: 'bytes', limit: 10_000, extra: true }],
    ['wrong truncation mode', { mode: 'tokens', limit: 10_000 }],
    ['wrong truncation limit', { mode: 'bytes', limit: 9_999 }],
    ['wrong truncation limit type', { mode: 'bytes', limit: '10000' }],
  ]) {
    const mutated = structuredClone(EXACT_CODEX_MODEL_CATALOG);
    mutated.models[0].truncation_policy = truncationPolicy;
    assert.throws(() => helper.validateCodexModelCatalog(mutated),
      undefined, label);
  }
  const unknown = structuredClone(EXACT_CODEX_MODEL_CATALOG);
  unknown.models[0].unexpected_cloud_capability = true;
  assert.throws(() => helper.validateCodexModelCatalog(unknown), /unexpected_cloud_capability|key/i);

  assert.equal(helper.directoryFileUrl('C:\\Users\\runner admin\\git remotes\\',
    { windows: true }), 'file:///C:/Users/runner%20admin/git%20remotes/');
  assert.equal(helper.directoryFileUrl('/tmp/runner admin/git remotes/',
    { windows: false }), 'file:///tmp/runner%20admin/git%20remotes/');
  assert.throws(() => helper.directoryFileUrl('relative/git remotes', { windows: false }),
    /absolute/i);

  const origin = 'http://127.0.0.1:43123';
  const catalogPath = 'C:\\Users\\runner admin\\codex home\\loopback-model-catalog.json';
  assert.equal(helper.buildCodexConfig({ origin, modelCatalogPath: catalogPath }), [
    `model = "${LOOPBACK_MODEL}"`,
    'model_provider = "deep_evolve_loopback"',
    'model_catalog_json = "C:\\\\Users\\\\runner admin\\\\codex home\\\\loopback-model-catalog.json"',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.deep_evolve_loopback]',
    'name = "Deep Evolve loopback contract"',
    `base_url = "${origin}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n'));
  assert.doesNotMatch(helper.buildCodexConfig({ origin, modelCatalogPath: catalogPath }),
    /\[profiles\.|--profile/);
  assert.throws(() => helper.buildCodexConfig({
    origin,
    modelCatalogPath: 'relative/catalog.json',
  }), /absolute/i);
  assert.throws(() => helper.buildCodexConfig({
    origin: 'https://api.openai.com',
    modelCatalogPath: catalogPath,
  }),
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
  const gitConfigGlobal = path.join(isolatedRoot, 'git rewrite config');
  const inherited = [...FORBIDDEN_ENVIRONMENT_KEYS, 'ANTHROPIC_API_KEY'];
  const previous = new Map(inherited.map((key) => [key, process.env[key]]));

  try {
    for (const key of inherited) process.env[key] = `inherited-${key}`;
    const common = {
      home, codexHome, claudeConfigDir, origin, proxyOrigin, gitConfigGlobal,
    };
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
    assert.equal(codex.GIT_CONFIG_GLOBAL, gitConfigGlobal);
    assert.equal(codex.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(codex.GIT_ALLOW_PROTOCOL, 'file');
    assert.equal(codex.GIT_TERMINAL_PROMPT, '0');
    assert.equal(Object.hasOwn(codex, 'ANTHROPIC_API_KEY'), false);
    assert.equal(Object.hasOwn(codex, 'ANTHROPIC_BASE_URL'), false);
    assert.equal(claude.CLAUDE_CONFIG_DIR, claudeConfigDir);
    for (const key of [
      'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ALLOW_PROTOCOL', 'GIT_TERMINAL_PROMPT',
    ]) assert.equal(Object.hasOwn(claude, key), false, key);
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
