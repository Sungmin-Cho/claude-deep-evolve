'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  generateHarness,
  migrateLegacyHarness,
  runHarness,
  writeBaseline,
} = require('../hooks/scripts/runtime/harness-runtime.cjs');
const { dispatch, OPERATIONS } = require('../hooks/scripts/deep-evolve-runtime.cjs');
const { evaluateHook } = require('../hooks/scripts/protect-readonly.cjs');

const repoRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures', 'runtime', 'harness');
const childFixture = path.join(fixtureRoot, 'child-command.cjs');
const legacyRoot = path.join(repoRoot, 'legacy', 'templates');
const templateRoot = path.join(repoRoot, 'templates');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeProject() {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evolve harness project with spaces ')));
  const sessionId = 'session-current';
  const sessionRoot = path.join(projectRoot, '.deep-evolve', sessionId);
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, 'session.yaml'), `${JSON.stringify({
    session_id: sessionId,
    deep_evolve_version: '3.4.3',
    status: 'active',
    created_at: '2026-07-13T00:00:00Z',
  }, null, 2)}\n`);
  return {
    projectRoot,
    sessionId,
    sessionRoot,
    cleanup() { fs.rmSync(projectRoot, { recursive: true, force: true }); },
  };
}

function command(mode, args = [], timeout = 2_000, cwd) {
  return {
    file: process.execPath,
    args: [childFixture, mode, ...args],
    ...(cwd === undefined ? {} : { cwd }),
    timeout_ms: timeout,
  };
}

function stdoutSpec(stdout, metrics, {
  direction = 'maximize', baseline = null, timeout = 2_000,
} = {}) {
  return {
    kind: 'stdout-parser',
    command: command('emit', stdout.replace(/\n$/, '').split('\n'), timeout),
    metric_direction: direction,
    baseline_score: baseline,
    metrics,
  };
}

function execute(sessionRoot, options) {
  const result = runHarness(sessionRoot, options);
  assert.equal(result.exit_code, 0, JSON.stringify(result));
  assert.equal(result.signal, null);
  assert.equal(result.timed_out, false);
  return result.stdout;
}

function pythonString(value) {
  return JSON.stringify(value);
}

function customizeStdoutTemplate(source, fixture) {
  return source
    .replace('RAW_COMMAND = "{{RAW_COMMAND}}"', `RAW_COMMAND = ${pythonString(fixture.raw_command)}`)
    .replace('TIMEOUT = {{TIMEOUT}}  # seconds', `TIMEOUT = ${fixture.timeout}  # seconds`)
    .replace('METRIC_DIRECTION = "{{DIRECTION}}"', `METRIC_DIRECTION = ${pythonString(fixture.direction)}`)
    .replace('BASELINE_SCORE = None', `BASELINE_SCORE = ${fixture.baseline_score === null ? 'None' : fixture.baseline_score}`)
    .replace(/METRICS = \{[\s\S]*?\n\}\n\n# ── Evaluation Engine/, `METRICS = ${JSON.stringify(fixture.metrics, null, 4)}\n\n# ── Evaluation Engine`);
}

function customizeTestRunnerTemplate(source, fixture) {
  return source
    .replace('TEST_COMMAND = "{{TEST_COMMAND}}"', `TEST_COMMAND = ${pythonString(fixture.test_command)}`)
    .replace('COVERAGE_COMMAND = "{{COVERAGE_COMMAND}}"', `COVERAGE_COMMAND = ${pythonString(fixture.coverage_command)}`)
    .replace('LINT_COMMAND = "{{LINT_COMMAND}}"', `LINT_COMMAND = ${pythonString(fixture.lint_command)}`)
    .replace('TIMEOUT = {{TIMEOUT}}', `TIMEOUT = ${fixture.timeout}`)
    .replace(/WEIGHTS = \{[\s\S]*?\n\}\n\n# ── Evaluation Engine/, `WEIGHTS = ${JSON.stringify(fixture.weights, null, 4)}\n\n# ── Evaluation Engine`);
}

function customizeScenarioTemplate(source, fixture) {
  const scenario = fixture.scenarios[0];
  const call = [
    '    Scenario(',
    `        name=${pythonString(scenario.name)},`,
    `        category=${pythonString(scenario.category)},`,
    `        description=${pythonString(scenario.description)},`,
    `        test_command=${pythonString(scenario.test_command)},`,
    `        expected_exit=${scenario.expected_exit},`,
    `        expected_output=${pythonString(scenario.expected_output)},`,
    '    ),',
  ].join('\n');
  return source
    .replace('PROJECT_ROOT / "{{TARGET_DIR}}"', `PROJECT_ROOT / ${pythonString(fixture.target_dir)}`)
    .replace(/WEIGHTS = \{[\s\S]*?\n\}\n# Normalize/, `WEIGHTS = ${JSON.stringify(fixture.weights, null, 4)}\n# Normalize`)
    .replace(/SCENARIOS = \[[\s\S]*?\n\]\n\n# ── Node\.js Module Tests/, `SCENARIOS = [\n${call}\n]\n\n# ── Node.js Module Tests`);
}

test('generation copies checked-in templates and keeps configuration out of executable source', () => {
  const project = makeProject();
  try {
    const specs = [
      stdoutSpec('metric: 1\n', { metric: { pattern: '^metric:\\s+([\\d.]+)', weight: 1 } }),
      {
        kind: 'test-runner',
        test_command: command('emit', ['Tests: 1 passed, 1 total']),
        coverage_command: null,
        lint_command: null,
        weights: { test_pass_rate: 1, coverage: 0, lint: 0 },
      },
      {
        kind: 'scenario',
        weights: { safety: 1 },
        scenarios: [{
          name: 'one', category: 'safety', description: 'literal',
          command: command('exit', ['0', 'ok']), expected_exit: 0, expected_output: 'ok',
        }],
      },
    ];
    const names = ['prepare-stdout-parse.cjs', 'prepare-test-runner.cjs', 'prepare-scenario.cjs'];
    for (let index = 0; index < specs.length; index += 1) {
      const marker = `USER_VALUE_${index}_한글_& echo injected`;
      const spec = structuredClone(specs[index]);
      spec.description = marker;
      const generated = generateHarness(spec, project.sessionRoot);
      assert.equal(generated.kind, spec.kind);
      assert.deepEqual(
        fs.readFileSync(path.join(project.sessionRoot, 'prepare.cjs')),
        fs.readFileSync(path.join(templateRoot, names[index])),
      );
      assert.doesNotMatch(fs.readFileSync(path.join(project.sessionRoot, 'prepare.cjs'), 'utf8'), new RegExp(marker));
      assert.equal(JSON.parse(fs.readFileSync(path.join(project.sessionRoot, 'prepare.config.json'), 'utf8')).kind, spec.kind);
    }
  } finally { project.cleanup(); }
});

test('stdout harness preserves metacharacters Windows paths quotes and Korean as literal argv', () => {
  const project = makeProject();
  try {
    const captured = path.join(project.projectRoot, 'captured argv.json');
    const injected = path.join(project.projectRoot, 'injected');
    const literals = [
      '& echo injected', '$()', '`touch injected`', '"double quotes"', "'single quotes'",
      String.raw`C:\Program Files\테스트\input.txt`, '한글 인자', String.raw`\\server\share\경로`,
    ];
    generateHarness({
      kind: 'stdout-parser',
      command: command('argv', [captured, ...literals]),
      metric_direction: 'maximize',
      baseline_score: null,
      metrics: { metric: { pattern: '^metric:\\s+([\\d.]+)', weight: 1 } },
    }, project.sessionRoot);
    const stdout = execute(project.sessionRoot);
    assert.match(stdout, /^\n---\nscore:\s+0\.750000\n/);
    const record = JSON.parse(fs.readFileSync(captured, 'utf8'));
    assert.deepEqual(record.argv, literals);
    assert.equal(record.cwd, project.projectRoot);
    assert.equal(fs.existsSync(injected), false);
  } finally { project.cleanup(); }
});

test('default command cwd follows prepare.cjs project-root discovery after a project move', () => {
  const project = makeProject();
  const movedRoot = `${project.projectRoot} moved`;
  const captured = path.join(os.tmpdir(), `evolve-cwd-${process.pid}-${Date.now()}.json`);
  let moved = false;
  try {
    generateHarness({
      kind: 'stdout-parser',
      command: command('argv', [captured, 'literal']),
      metric_direction: 'maximize', baseline_score: null,
      metrics: { metric: { pattern: '^metric:\\s+([\\d.]+)', weight: 1 } },
    }, project.sessionRoot);
    const config = JSON.parse(fs.readFileSync(path.join(project.sessionRoot, 'prepare.config.json'), 'utf8'));
    assert.equal(Object.hasOwn(config.command, 'cwd'), false, 'default cwd must not hard-code the generation root');
    fs.renameSync(project.projectRoot, movedRoot);
    moved = true;
    const movedSession = path.join(movedRoot, '.deep-evolve', project.sessionId);
    assert.match(execute(movedSession), /score:\s+0\.750000/);
    assert.equal(JSON.parse(fs.readFileSync(captured, 'utf8')).cwd, fs.realpathSync(movedRoot));
  } finally {
    fs.rmSync(captured, { force: true });
    if (moved) fs.rmSync(movedRoot, { recursive: true, force: true });
    else project.cleanup();
  }
});

test('approved legacy stdout characterization remains byte-exact for complete partial missing and minimize cases', () => {
  const project = makeProject();
  try {
    const goldenPath = path.join(fixtureRoot, 'approved-legacy-score-golden.json');
    const before = fs.readFileSync(goldenPath);
    const golden = JSON.parse(before);
    const legacyTemplate = fs.readFileSync(path.join(legacyRoot, 'prepare-stdout-parse.py'), 'utf8');
    for (const fixture of golden.cases) {
      generateHarness(stdoutSpec(fixture.stdout, fixture.metrics, {
        direction: fixture.direction, baseline: fixture.baseline_score,
      }), project.sessionRoot);
      assert.equal(execute(project.sessionRoot), fixture.expected, fixture.name);

      const rawCommand = [process.execPath, childFixture, 'emit', ...fixture.stdout.replace(/\n$/, '').split('\n')]
        .map((arg) => JSON.stringify(arg)).join(' ');
      const customized = customizeStdoutTemplate(legacyTemplate, {
        raw_command: rawCommand,
        timeout: 2,
        direction: fixture.direction,
        baseline_score: fixture.baseline_score,
        metrics: fixture.metrics,
      });
      fs.writeFileSync(path.join(project.sessionRoot, 'prepare.py'), customized);
      migrateLegacyHarness(project.sessionRoot);
      assert.equal(execute(project.sessionRoot), fixture.expected, `${fixture.name}:migrated`);
    }
    assert.deepEqual(fs.readFileSync(goldenPath), before, 'supported Node tests must not rewrite approved golden');
  } finally { project.cleanup(); }
});

test('stdout timeout and nonzero commands produce deterministic missing-metric output', () => {
  const project = makeProject();
  try {
    generateHarness({
      kind: 'stdout-parser', command: command('sleep', ['250'], 30),
      metric_direction: 'maximize', baseline_score: null,
      metrics: { metric: { pattern: '^metric:\\s+([\\d.]+)', weight: 1 } },
    }, project.sessionRoot);
    assert.equal(execute(project.sessionRoot), '\n---\nscore:              0.000000\ntotal_scenarios:    1\npassed_scenarios:   0\nfailed_scenarios:   1\n---\n');
  } finally { project.cleanup(); }
});

test('test-runner parses Jest Vitest Pytest Cargo and Go summaries', () => {
  const cases = [
    ['Jest', 'Tests: 8 passed, 10 total', [8, 10]],
    ['Vitest totals', 'Tests  7 passed (9)', [7, 9]],
    ['Vitest failures', 'Tests  6 passed | 2 failed', [6, 8]],
    ['Pytest', '7 passed, 2 failed, 1 error, 4 skipped', [7, 10]],
    ['Cargo', 'test result: FAILED. 5 passed; 2 failed; 0 ignored;', [5, 7]],
    ['Go', '--- PASS: TestOne (0.00s)\n--- FAIL: TestTwo (0.00s)', [1, 2]],
  ];
  for (const [name, output, [passed, total]] of cases) {
    const project = makeProject();
    try {
      generateHarness({
        kind: 'test-runner', test_command: command('emit', output.split('\n')),
        coverage_command: null, lint_command: null,
        weights: { test_pass_rate: 1, coverage: 0, lint: 0 },
      }, project.sessionRoot);
      const stdout = execute(project.sessionRoot);
      assert.match(stdout, new RegExp(`score:\\s+${(passed / total).toFixed(6)}`), name);
      assert.match(stdout, new RegExp(`total_scenarios:\\s+${total}`), name);
      assert.match(stdout, new RegExp(`passed_scenarios:\\s+${passed}`), name);
    } finally { project.cleanup(); }
  }
});

test('test-runner combines coverage and lint with only available positive weights', () => {
  const project = makeProject();
  try {
    generateHarness({
      kind: 'test-runner',
      test_command: command('emit', ['Tests: 8 passed, 10 total']),
      coverage_command: command('emit', ['All files | 75%']),
      lint_command: command('emit', ['1 error 2 warnings']),
      weights: { test_pass_rate: 0.5, coverage: 0.3, lint: 0.2 },
    }, project.sessionRoot);
    assert.equal(execute(project.sessionRoot), [
      '', '---', 'score:              0.797000', 'test_pass_rate:     0.800000',
      'coverage:           0.750000', 'lint_score:         0.860000',
      'total_scenarios:    10', 'passed_scenarios:   8', 'failed_scenarios:   2', '---', '',
    ].join('\n'));
  } finally { project.cleanup(); }
});

test('scenario harness honors expected exit and stdout by weighted category', () => {
  const project = makeProject();
  try {
    generateHarness({
      kind: 'scenario', weights: { reliability: 0.6, behavior: 0.4 },
      scenarios: [
        { name: 'ok', category: 'reliability', description: 'passes', command: command('exit', ['0', 'expected']), expected_exit: 0, expected_output: 'expected' },
        { name: 'bad-output', category: 'reliability', description: 'fails output', command: command('exit', ['0', 'different']), expected_exit: 0, expected_output: 'expected' },
        { name: 'expected-failure', category: 'behavior', description: 'nonzero expected', command: command('exit', ['7', 'known']), expected_exit: 7, expected_output: 'known' },
      ],
    }, project.sessionRoot);
    assert.equal(execute(project.sessionRoot), [
      '', '---', 'score:              0.700000', 'reliability:         0.500000',
      'behavior:            1.000000', 'total_scenarios:    3', 'passed_scenarios:   2',
      'failed_scenarios:   1', '---', '',
    ].join('\n'));
  } finally { project.cleanup(); }
});

test('writeBaseline atomically establishes minimize baseline inversion', () => {
  const project = makeProject();
  try {
    generateHarness(stdoutSpec('latency: 8\n', {
      latency: { pattern: '^latency:\\s+([\\d.]+)', weight: 1 },
    }, { direction: 'minimize' }), project.sessionRoot);
    const result = writeBaseline(project.sessionRoot, 10);
    assert.equal(result.baseline_score, 10);
    assert.match(execute(project.sessionRoot), /score:\s+1\.250000/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(project.sessionRoot, 'prepare.config.json'), 'utf8')).baseline_score, 10);
  } finally { project.cleanup(); }
});

test('runHarness rejects caller-controlled child runner fields', () => {
  const project = makeProject();
  try {
    generateHarness(stdoutSpec('metric: 1\n', {
      metric: { pattern: '^metric:\\s+([\\d.]+)', weight: 1 },
    }), project.sessionRoot);
    assert.throws(
      () => runHarness(project.sessionRoot, { spawnSync: 'caller-controlled' }),
      (error) => error.code === 'invalid_harness_config',
    );
  } finally { project.cleanup(); }
});

test('generation rejects shell strings invalid regex unsafe cwd and unsupported fields', () => {
  const project = makeProject();
  try {
    const invalid = [
      { kind: 'stdout-parser', command: 'node test.js', metric_direction: 'maximize', metrics: {} },
      { kind: 'stdout-parser', command: command('emit'), metric_direction: 'sideways', metrics: {} },
      { kind: 'stdout-parser', command: command('emit'), metric_direction: 'maximize', metrics: { x: { pattern: '(', weight: 1 } } },
      { kind: 'stdout-parser', command: { ...command('emit'), cwd: path.dirname(project.projectRoot) }, metric_direction: 'maximize', metrics: {} },
      { kind: 'test-runner', test_command: command('emit'), coverage_command: null, lint_command: null, weights: { test_pass_rate: 1 }, extra: true },
    ];
    for (const spec of invalid) assert.throws(() => generateHarness(spec, project.sessionRoot), (error) => typeof error.code === 'string');
    assert.equal(fs.existsSync(path.join(project.sessionRoot, 'prepare.cjs')), false);
  } finally { project.cleanup(); }
});

test('standalone generated template rejects POSIX shell and Python paths before spawn', () => {
  const project = makeProject();
  try {
    generateHarness(stdoutSpec('metric: 1\n', {
      metric: { pattern: '^metric:\\s+([\\d.]+)', weight: 1 },
    }), project.sessionRoot);
    const configPath = path.join(project.sessionRoot, 'prepare.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const file of ['/definitely-missing/python3', '/definitely-missing/bash']) {
      config.command.file = file;
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const direct = spawnSync(process.execPath, [path.join(project.sessionRoot, 'prepare.cjs')], {
        cwd: project.projectRoot, encoding: 'utf8', timeout: 2_000, shell: false,
      });
      assert.equal(direct.status, 1, `${file}: ${direct.stdout} ${direct.stderr}`);
      assert.match(direct.stderr, /unsupported executable/);
    }
  } finally { project.cleanup(); }
});

test('standalone generated template rejects unknown root config fields', () => {
  const project = makeProject();
  try {
    generateHarness(stdoutSpec('metric: 1\n', {
      metric: { pattern: '^metric:\\s+([\\d.]+)', weight: 1 },
    }), project.sessionRoot);
    const configPath = path.join(project.sessionRoot, 'prepare.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.shell = true;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const direct = spawnSync(process.execPath, [path.join(project.sessionRoot, 'prepare.cjs')], {
      cwd: project.projectRoot, encoding: 'utf8', timeout: 2_000, shell: false,
    });
    assert.equal(direct.status, 1, `${direct.stdout} ${direct.stderr}`);
    assert.match(direct.stderr, /unknown config field/);
  } finally { project.cleanup(); }
});

test('standalone generated template rejects unsafe metric keys', () => {
  const project = makeProject();
  try {
    generateHarness(stdoutSpec('metric: 1\n', {
      metric: { pattern: '^metric:\\s+([\\d.]+)', weight: 1 },
    }), project.sessionRoot);
    const configPath = path.join(project.sessionRoot, 'prepare.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.metrics = JSON.parse('{"__proto__":{"pattern":"^metric: ([0-9.]+)","weight":1}}');
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const direct = spawnSync(process.execPath, [path.join(project.sessionRoot, 'prepare.cjs')], {
      cwd: project.projectRoot, encoding: 'utf8', timeout: 2_000, shell: false,
    });
    assert.equal(direct.status, 1, `${direct.stdout} ${direct.stderr}`);
    assert.match(direct.stderr, /unsafe metric/);
  } finally { project.cleanup(); }
});

test('bare and config-customized legacy templates migrate by invariant engine signature without Python execution', () => {
  const migration = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'legacy-migration-cases.json'), 'utf8'));
  const cases = [
    ['prepare-stdout-parse.py', 'stdout-parser', (source) => customizeStdoutTemplate(source, migration.stdout)],
    ['prepare-test-runner.py', 'test-runner', (source) => customizeTestRunnerTemplate(source, migration.test_runner)],
    ['prepare-scenario.py', 'scenario', (source) => customizeScenarioTemplate(source, migration.scenario)],
  ];
  for (const [name, kind, customize] of cases) {
    const source = fs.readFileSync(path.join(legacyRoot, name), 'utf8');
    for (const [variant, contents] of [['bare', source], ['customized', customize(source)]]) {
      const project = makeProject();
      try {
        fs.writeFileSync(path.join(project.sessionRoot, 'prepare.py'), contents);
        const result = migrateLegacyHarness(project.sessionRoot);
        assert.equal(result.migrated, true, `${name}:${variant}`);
        assert.equal(result.kind, kind, `${name}:${variant}`);
        assert.equal(JSON.parse(fs.readFileSync(path.join(project.sessionRoot, 'prepare.config.json'), 'utf8')).kind, kind);
        assert.deepEqual(fs.readFileSync(path.join(project.sessionRoot, 'prepare.py')), Buffer.from(contents));
        assert.equal(fs.readFileSync(path.join(project.sessionRoot, 'prepare.cjs'), 'utf8').includes('subprocess'), false);
      } finally { project.cleanup(); }
    }
  }
});

test('custom stdout migration preserves literal metrics direction timeout and written baseline', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'legacy-migration-cases.json'), 'utf8')).stdout;
  const project = makeProject();
  try {
    const source = fs.readFileSync(path.join(legacyRoot, 'prepare-stdout-parse.py'), 'utf8');
    fs.writeFileSync(path.join(project.sessionRoot, 'prepare.py'), customizeStdoutTemplate(source, fixture));
    migrateLegacyHarness(project.sessionRoot);
    const config = JSON.parse(fs.readFileSync(path.join(project.sessionRoot, 'prepare.config.json'), 'utf8'));
    assert.equal(config.command.file, 'node');
    assert.deepEqual(config.command.args, ['child-command.cjs', 'emit', 'accuracy: 0.8', 'latency: 9']);
    assert.equal(config.command.timeout_ms, 17_000);
    assert.equal(config.metric_direction, 'minimize');
    assert.equal(config.baseline_score, 10);
    assert.deepEqual(config.metrics, fixture.metrics);
  } finally { project.cleanup(); }
});

test('legacy literal parser preserves raw regex strings containing escaped quote delimiters', () => {
  const project = makeProject();
  try {
    const source = fs.readFileSync(path.join(legacyRoot, 'prepare-stdout-parse.py'), 'utf8');
    const customized = customizeStdoutTemplate(source, {
      raw_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(childFixture)} emit ${JSON.stringify('value: "8')}`,
      timeout: 2,
      direction: 'maximize',
      baseline_score: null,
      metrics: { temporary: { pattern: '^temporary: ([\\d.]+)', weight: 1 } },
    }).replace(/METRICS = \{[\s\S]*?\n\}\n\n# ── Evaluation Engine/, `${String.raw`METRICS = {
    "value": {"pattern": r"^value:\s+\"?([\d.]+)", "weight": 1.0},
}`}\n\n# ── Evaluation Engine`);
    fs.writeFileSync(path.join(project.sessionRoot, 'prepare.py'), customized);
    migrateLegacyHarness(project.sessionRoot);
    const config = JSON.parse(fs.readFileSync(path.join(project.sessionRoot, 'prepare.config.json'), 'utf8'));
    assert.equal(config.metrics.value.pattern, String.raw`^value:\s+\"?([\d.]+)`);
    assert.match(execute(project.sessionRoot), /score:\s+8\.000000/);
  } finally { project.cleanup(); }
});

test('altered and unrecognized legacy harnesses fail typed without mutating or executing either harness file', () => {
  const original = fs.readFileSync(path.join(legacyRoot, 'prepare-stdout-parse.py'), 'utf8');
  for (const contents of [original.replace('def compute_score(values):', 'def compute_score_altered(values):'), 'print("unrecognized")\n']) {
    const project = makeProject();
    try {
      const pythonPath = path.join(project.sessionRoot, 'prepare.py');
      const nodePath = path.join(project.sessionRoot, 'prepare.cjs');
      const configPath = path.join(project.sessionRoot, 'prepare.config.json');
      fs.writeFileSync(pythonPath, contents);
      fs.writeFileSync(nodePath, 'sentinel node bytes\n');
      fs.writeFileSync(configPath, '{"sentinel":true}\n');
      const before = [pythonPath, nodePath, configPath].map((file) => fs.readFileSync(file));
      assert.throws(() => migrateLegacyHarness(project.sessionRoot), (error) => error.code === 'legacy_harness_requires_regeneration' && error.rc === 1);
      assert.deepEqual([pythonPath, nodePath, configPath].map((file) => fs.readFileSync(file)), before);
    } finally { project.cleanup(); }
  }
});

test('recognized legacy engines with remaining shell expansion syntax require regeneration', () => {
  const project = makeProject();
  try {
    const source = fs.readFileSync(path.join(legacyRoot, 'prepare-stdout-parse.py'), 'utf8');
    const customized = customizeStdoutTemplate(source, {
      raw_command: 'node tests/*.cjs', timeout: 2, direction: 'maximize', baseline_score: null,
      metrics: { metric: { pattern: '^metric: ([0-9.]+)', weight: 1 } },
    });
    const legacyPath = path.join(project.sessionRoot, 'prepare.py');
    fs.writeFileSync(legacyPath, customized);
    const before = fs.readFileSync(legacyPath);
    assert.throws(() => migrateLegacyHarness(project.sessionRoot), (error) => error.code === 'legacy_harness_requires_regeneration');
    assert.deepEqual(fs.readFileSync(legacyPath), before);
    assert.equal(fs.existsSync(path.join(project.sessionRoot, 'prepare.cjs')), false);
  } finally { project.cleanup(); }
});

test('legacy manifest proves whole-file bytes and normalized engine bodies for all moved templates', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(legacyRoot, 'prepare-template-manifest.json'), 'utf8'));
  assert.equal(manifest.schema_version, '1.0');
  assert.deepEqual(Object.keys(manifest.templates).sort(), [
    'prepare-scenario.py', 'prepare-stdout-parse.py', 'prepare-test-runner.py',
  ]);
  for (const [name, record] of Object.entries(manifest.templates)) {
    const bytes = fs.readFileSync(path.join(legacyRoot, name));
    const text = bytes.toString('utf8').replace(/\r\n/g, '\n');
    const marker = text.indexOf('# ── Evaluation Engine');
    assert.notEqual(marker, -1, name);
    assert.equal(record.sha256, sha256(bytes), name);
    assert.equal(record.engine_sha256, sha256(text.slice(marker)), name);
  }
});

test('dispatcher registers and executes exactly the Task 6 harness operations', () => {
  const expected = ['harness.generate', 'harness.migrate-legacy', 'harness.run', 'harness.write-baseline'];
  assert.deepEqual(OPERATIONS.filter((operation) => operation.startsWith('harness.')), expected);
  const project = makeProject();
  try {
    const request = (operation, payload) => dispatch({
      schema_version: '1.0', operation, context: { project_root: project.projectRoot }, payload,
    });
    const generated = request('harness.generate', {
      session_id: project.sessionId,
      spec: stdoutSpec('metric: 0.5\n', { metric: { pattern: '^metric:\\s+([\\d.]+)', weight: 1 } }),
    });
    assert.equal(generated.ok, true, JSON.stringify(generated));
    const baseline = request('harness.write-baseline', { session_id: project.sessionId, raw_score: 1 });
    assert.equal(baseline.ok, true, JSON.stringify(baseline));
    const ran = request('harness.run', { session_id: project.sessionId, options: { args: [] } });
    assert.equal(ran.ok, true, JSON.stringify(ran));
    assert.match(ran.result.stdout, /score:\s+0\.500000/);
    const invalidOptions = request('harness.run', { session_id: project.sessionId, options: false });
    assert.equal(invalidOptions.ok, false);
    assert.equal(invalidOptions.exitCode, 2);
    const unknown = request('harness.generate', { session_id: project.sessionId, spec: { kind: 'unknown' } });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.exitCode, 2);
  } finally { project.cleanup(); }
});

test('prepare meta-mode and seal cover cjs and config while direct Node evaluation remains allowed', () => {
  const project = makeProject();
  try {
    fs.writeFileSync(path.join(project.projectRoot, '.deep-evolve', 'current.json'), `${JSON.stringify({ session_id: project.sessionId })}\n`);
    fs.writeFileSync(path.join(project.sessionRoot, 'prepare.cjs'), 'process.stdout.write("score: 1\\n");\n');
    fs.writeFileSync(path.join(project.sessionRoot, 'prepare.config.json'), '{}\n');
    const event = (toolName, toolInput) => ({
      session_id: 'task6-hook', cwd: project.projectRoot, hook_event_name: 'PreToolUse',
      tool_name: toolName, tool_input: toolInput,
    });
    for (const name of ['prepare.cjs', 'prepare.config.json']) {
      const target = path.join(project.sessionRoot, name);
      assert.equal(evaluateHook(event('Edit', { file_path: target }), {}, project.projectRoot).exitCode, 2, name);
      assert.equal(evaluateHook(event('Edit', { file_path: target }), { DEEP_EVOLVE_META_MODE: 'prepare_update' }, project.projectRoot).exitCode, 0, name);
      assert.equal(evaluateHook(event('Read', { file_path: target }), { DEEP_EVOLVE_SEAL_PREPARE: '1' }, project.projectRoot).exitCode, 2, name);
    }
    assert.equal(evaluateHook(event('Bash', { command: `node "${path.join(project.sessionRoot, 'prepare.cjs')}"` }), {}, project.projectRoot).exitCode, 0);
  } finally { project.cleanup(); }
});

test('supported runtime and tests have no Python or shell child-process edge', () => {
  const supported = [
    path.join(repoRoot, 'hooks', 'scripts', 'runtime', 'harness-runtime.cjs'),
    path.join(templateRoot, 'prepare-stdout-parse.cjs'),
    path.join(templateRoot, 'prepare-test-runner.cjs'),
    path.join(templateRoot, 'prepare-scenario.cjs'),
    __filename,
  ];
  for (const file of supported) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /(?:spawnSync|execFileSync|execSync)\s*\([^\n]*(?:python(?:3)?|py\s+-3)/i, file);
    if (!file.endsWith('harness-runtime.test.js')) {
      assert.doesNotMatch(source, /shell\s*:\s*true|(?:execSync|execFileSync)\s*\(/, file);
    }
  }
});

test('package contains native harnesses and excludes Task 6 legacy templates and every Python file', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 30_000, shell: false,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const rows = JSON.parse(packed.stdout);
  const files = rows[0].files.map((entry) => entry.path).sort();
  for (const required of [
    'hooks/scripts/runtime/harness-runtime.cjs',
    'templates/prepare-stdout-parse.cjs',
    'templates/prepare-test-runner.cjs',
    'templates/prepare-scenario.cjs',
  ]) assert.equal(files.includes(required), true, required);
  assert.deepEqual(files.filter((file) => file.startsWith('legacy/')), ['legacy/session-helper-v3.4.3.sh']);
  assert.equal(files.some((file) => file.startsWith('legacy/templates/')), false);
  assert.equal(files.some((file) => file.endsWith('.py')), false);
});
