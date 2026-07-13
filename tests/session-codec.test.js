'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseStateDocument,
  serializeStateDocument,
  validateSession,
  validateStrategy,
} = require('../hooks/scripts/runtime/session-codec.cjs');
const { buildInitialSession } = require('../hooks/scripts/runtime/session-transitions.cjs');

const root = path.resolve(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures', 'runtime');
const startFixture = JSON.parse(fs.readFileSync(
  path.join(fixtureRoot, 'session-start-v3.5.json'),
  'utf8',
));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('legacy init fixtures round-trip to JSON-compatible YAML', () => {
  for (const name of ['init-session-v2.2.yaml', 'init-session-v3.0.yaml', 'init-session-v3.1.yaml', 'strategy-v2.yaml']) {
    const source = fs.readFileSync(path.join(fixtureRoot, name), 'utf8');
    const parsed = parseStateDocument(source, { sourcePath: name });
    assert.deepEqual(JSON.parse(serializeStateDocument(parsed)), parsed);
  }
});

test('schema-limited parser accepts CRLF, nested block lists, inline collections, comments, and quoted Korean', () => {
  const v22 = fs.readFileSync(path.join(fixtureRoot, 'init-session-v2.2.yaml'));
  const strategy = fs.readFileSync(path.join(fixtureRoot, 'strategy-v2.yaml'));
  assert.ok(v22.includes(Buffer.from('\r\n')), 'v2.2 fixture is the CRLF session variant');
  assert.ok(strategy.includes(Buffer.from('\r\n')), 'strategy fixture is the CRLF strategy variant');
  const parsed = parseStateDocument(v22.toString('utf8'), { sourcePath: 'init-session-v2.2.yaml' });
  assert.equal(parsed.goal, '레거시 세션 개선');
  assert.equal(parsed.parent_session, null);
  assert.deepEqual(parsed.outer_loop.q_history, []);
  assert.deepEqual(parsed.metric, { name: 'score', direction: 'maximize', baseline: 1, current: 1, best: 1 });
  assert.equal(parsed.program.history[0].keep_rate, null);
  const strategyParsed = parseStateDocument(strategy.toString('utf8'), { sourcePath: 'strategy-v2.yaml' });
  assert.equal(strategyParsed.judgment.diagnose_retry.enabled, true);
  assert.equal(strategyParsed.shortcut_detection.seal_prepare_read, false);
  assert.equal(strategyParsed.legibility.require_rationale_on_keep, true);
  assert.equal(strategyParsed.entropy_tracking.window_size, 20);
});

test('unsupported YAML fails loud without coercion', () => {
  const source = 'defaults: &defaults\n  status: active\nsession:\n  <<: *defaults\n';
  assert.throws(() => parseStateDocument(source, { sourcePath: 'unsupported-anchor.yaml' }), /unsupported YAML.*anchor/i);
  const rejected = [
    ['alias', 'base: *defaults\n'],
    ['tag', 'value: !secret text\n'],
    ['tag', 'value: !!str hello\n'],
    ['tag', 'value: !!int 5\n'],
    ['tag', 'value: !<tag:x> hello\n'],
    ['tag', 'value: ! hello\n'],
    ['merge key', 'session:\n  <<: defaults\n'],
    ['multiline scalar', 'description: |\n  text\n'],
    ['multiline scalar', 'body: |2\n'],
    ['multiline scalar', 'body: |2-\n'],
    ['multiline scalar', 'body: |+2\n'],
    ['multiline scalar', 'folded: >-\n'],
    ['tab', 'session:\n\tstatus: active\n'],
    ['indentation', 'session:\n   status: active\n'],
    ['duplicate key', 'session:\n  status: active\n  status: paused\n'],
  ];
  for (const [reason, text] of rejected) {
    assert.throws(() => parseStateDocument(text, { sourcePath: `${reason}.yaml` }), new RegExp(reason, 'i'));
  }
});

test('plain scalars containing indicator characters are not misread as YAML nodes', () => {
  const source = [
    'a: foo !bar', 'b: fix ! now', 'c: a | b', 'd: a > b', 'e: a & b', 'f: rate|',
    'g: fix A, & B later', 'h: a,* b', 'i: a,! b', '',
  ].join('\n');
  assert.deepEqual(parseStateDocument(source, { sourcePath: 'plain.yaml' }), {
    a: 'foo !bar', b: 'fix ! now', c: 'a | b', d: 'a > b', e: 'a & b', f: 'rate|',
    g: 'fix A, & B later', h: 'a,* b', i: 'a,! b',
  });
});

test('duplicate-key detection is scoped to one mapping and preserves legacy spellings', () => {
  const source = [
    'virtual_parallel:',
    '  N: 2',
    '  n_current: 2',
    '  seeds:',
    '    - id: 1',
    '      status: active',
    '      created_at: "2026-01-01T00:00:00Z"',
    '    - seed_id: 2',
    '      status: active',
    '      created_at: "2026-01-01T00:00:01Z"',
    '',
  ].join('\n');
  const parsed = parseStateDocument(source, { sourcePath: 'siblings.yaml' });
  assert.equal(parsed.virtual_parallel.N, 2);
  assert.equal(parsed.virtual_parallel.n_current, 2);
  assert.deepEqual(parsed.virtual_parallel.seeds.map((seed) => [seed.id, seed.seed_id]), [[1, undefined], [undefined, 2]]);
  assert.throws(
    () => parseStateDocument('{"status":"active","status":"paused"}', { sourcePath: 'duplicate.json' }),
    /duplicate key status/i,
  );
  assert.deepEqual(
    parseStateDocument('{"left":{"status":"active"},"right":{"status":"paused"}}', { sourcePath: 'siblings.json' }),
    { left: { status: 'active' }, right: { status: 'paused' } },
  );
});

test('legacy copied fixtures retain exact source bytes and recorded SHA before parsing', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'legacy-byte-manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, 15);
  for (const entry of manifest.files) {
    const source = fs.readFileSync(path.join(root, entry.source));
    const copyPath = path.join(fixtureRoot, entry.copy);
    const copy = fs.readFileSync(copyPath);
    assert.deepEqual(copy, source, entry.copy);
    assert.equal(sha256(copy), entry.sha256, entry.copy);
    if (entry.copy.endsWith('.yaml')) {
      parseStateDocument(copy.toString('utf8'), { sourcePath: entry.copy });
    } else if (copy.length > 0) {
      for (const line of copy.toString('utf8').trimEnd().split(/\r?\n/)) {
        assert.equal(Array.isArray(JSON.parse(line)), false, entry.copy);
      }
    }
    assert.deepEqual(fs.readFileSync(copyPath), copy, `${entry.copy} changed during parse`);
    assert.equal(sha256(fs.readFileSync(copyPath)), entry.sha256, `${entry.copy} hash changed during parse`);
  }
});

test('legacy fixture semantics remain unnormalized', () => {
  const readYaml = (relative) => parseStateDocument(
    fs.readFileSync(path.join(fixtureRoot, 'legacy', relative), 'utf8'),
    { sourcePath: relative },
  );
  const v30 = readYaml('v3_0_resume/session.yaml');
  assert.equal(v30.deep_evolve_version, '3.0.0');
  assert.equal(Object.hasOwn(v30, 'virtual_parallel'), false);
  const borrow = readYaml('borrow/session.yaml');
  assert.equal(borrow.virtual_parallel.N, 2);
  assert.equal(borrow.virtual_parallel.seeds[0].seed_id, 1);
  const multi = readYaml('multi_seed/session.yaml');
  assert.equal(multi.virtual_parallel.n_current, 5);
  assert.equal(multi.virtual_parallel.seeds[0].id, 1);
  const journal = fs.readFileSync(path.join(fixtureRoot, 'legacy/multi_seed/journal.jsonl'), 'utf8')
    .trimEnd().split('\n').map(JSON.parse);
  assert.equal(journal[0].seed_id, 1);
});

test('session and strategy validation enforce known shapes while preserving x-* extensions', () => {
  const session = parseStateDocument(
    fs.readFileSync(path.join(fixtureRoot, 'init-session-v3.1.yaml'), 'utf8'),
    { sourcePath: 'init-session-v3.1.yaml' },
  );
  assert.strictEqual(validateSession(session), session);
  assert.equal(session['x-session-note'], 'preserved extension');
  assert.equal(session.virtual_parallel['x-host-note'], 'preserved extension');
  assert.throws(() => validateSession({ ...session, status: 'unknown' }), /status/i);
  assert.throws(() => validateSession({ ...session, surprise: true }), /unknown.*surprise/i);
  assert.throws(() => validateSession({ ...session, metric: { ...session.metric, direction: 'sideways' } }), /metric.*direction/i);
  assert.throws(() => validateSession({ ...session, metric: { ...session.metric, surprise: true } }), /unknown.*metric.*surprise/i);
  assert.throws(() => validateSession({ ...session, program: { ...session.program, surprise: true } }), /unknown.*program.*surprise/i);
  assert.throws(() => validateSession({ ...session, virtual_parallel: { ...session.virtual_parallel, n_current: 10 } }), /n_current/i);

  const zeroActive = structuredClone(session);
  delete zeroActive.virtual_parallel.n_current;
  zeroActive.virtual_parallel['x-active-seed-count'] = 0;
  zeroActive.virtual_parallel.seeds = zeroActive.virtual_parallel.seeds.map((seed) => ({
    ...seed,
    status: 'completed_early',
  }));
  assert.strictEqual(validateSession(zeroActive), zeroActive,
    'the exact zero-active sentinel is strict canonical state');
  for (const invalidMarker of ['0', false, 1, -1]) {
    assert.throws(() => validateSession({
      ...zeroActive,
      virtual_parallel: {
        ...zeroActive.virtual_parallel,
        'x-active-seed-count': invalidMarker,
      },
    }), /x-active-seed-count/i, `invalid zero-active marker ${JSON.stringify(invalidMarker)}`);
  }
  assert.throws(() => validateSession({
    ...zeroActive,
    virtual_parallel: { ...zeroActive.virtual_parallel, n_current: 1 },
  }), /x-active-seed-count.*n_current|n_current.*x-active-seed-count/i,
  'zero-active sentinel and positive n_current must not coexist');
  assert.throws(() => validateSession({
    ...zeroActive,
    virtual_parallel: {
      ...zeroActive.virtual_parallel,
      seeds: [{ ...zeroActive.virtual_parallel.seeds[0], status: 'active' }],
    },
  }), /x-active-seed-count.*active|active.*x-active-seed-count/i,
  'zero-active sentinel cannot coexist with an active seed');
  const missingStatusSeed = { ...zeroActive.virtual_parallel.seeds[0] };
  delete missingStatusSeed.status;
  assert.throws(() => validateSession({
    ...zeroActive,
    virtual_parallel: { ...zeroActive.virtual_parallel, seeds: [missingStatusSeed] },
  }), /x-active-seed-count.*status|status.*x-active-seed-count/i,
  'zero-active sentinel requires explicit terminal statuses');
  assert.throws(() => validateSession({
    ...session,
    virtual_parallel: {
      ...session.virtual_parallel,
      seeds: [{ ...session.virtual_parallel.seeds[0], status: 'invented' }],
    },
  }), /seed.*status/i);

  const strategy = parseStateDocument(
    fs.readFileSync(path.join(fixtureRoot, 'strategy-v2.yaml'), 'utf8'),
    { sourcePath: 'strategy-v2.yaml' },
  );
  assert.strictEqual(validateStrategy(strategy), strategy);
  assert.equal(strategy['x-description'], '레거시 전략');
  assert.throws(() => validateStrategy({ ...strategy, mystery: true }), /unknown.*mystery/i);
  assert.throws(() => validateStrategy({
    ...strategy,
    idea_selection: { ...strategy.idea_selection, mystery: true },
  }), /unknown.*idea_selection.*mystery/i);
});

test('strict v3.5 sessions enforce complete metric, epoch, counter, seed, and budget invariants', () => {
  const initial = buildInitialSession({
    sessionId: '2026-07-13_codec-contract',
    goal: 'strict codec contract',
    parent: null,
    initialState: structuredClone(startFixture.initial_state),
    createdAt: '2026-07-13T12:34:56Z',
    runtimeVersion: '3.5.0',
  });
  assert.strictEqual(validateSession(initial), initial);

  const active = structuredClone(initial);
  active.status = 'active';
  active.metric = { ...active.metric, baseline: 1, current: 1, best: 1 };
  assert.strictEqual(validateSession(active), active);

  const cases = [
    ['partial metric authority', () => {
      const value = structuredClone(active);
      delete value.metric.best;
      return value;
    }, /baseline.*current.*best|baseline, current, and best/],
    ['activation without metric authority', () => {
      const value = structuredClone(initial);
      value.status = 'active';
      return value;
    }, /required before activation/],
    ['experiment counter drift', () => {
      const value = structuredClone(initial);
      value.experiments.total = 1;
      return value;
    }, /terminal experiment counters/],
    ['epoch pointer drift', () => {
      const value = structuredClone(initial);
      value.evaluation_epoch.current = 2;
      return value;
    }, /current.*history/],
    ['non-canonical target path', () => {
      const value = structuredClone(initial);
      value.target_files = ['src/../outside.js'];
      return value;
    }, /normalized project-relative paths/],
    ['duplicate seed identity', () => {
      const value = structuredClone(initial);
      value.virtual_parallel.seeds = [
        { id: 1, status: 'active', allocated_budget: 3 },
        { id: 1, status: 'paused', allocated_budget: 3 },
      ];
      value.virtual_parallel.n_current = 1;
      delete value.virtual_parallel['x-active-seed-count'];
      value.virtual_parallel.budget_unallocated = 24;
      return value;
    }, /identities.*unique/],
    ['active count drift', () => {
      const value = structuredClone(initial);
      value.virtual_parallel.seeds = [{ id: 1, status: 'active', allocated_budget: 3 }];
      value.virtual_parallel.n_current = 2;
      delete value.virtual_parallel['x-active-seed-count'];
      value.virtual_parallel.budget_unallocated = 27;
      return value;
    }, /n_current.*active seeds/],
    ['allocation equation drift', () => {
      const value = structuredClone(initial);
      value.virtual_parallel.seeds = [{ id: 1, status: 'active', allocated_budget: 3 }];
      value.virtual_parallel.n_current = 1;
      delete value.virtual_parallel['x-active-seed-count'];
      return value;
    }, /allocated plus unallocated/],
    ['legacy virtual spelling', () => {
      const value = structuredClone(initial);
      value.virtual_parallel.N = 1;
      return value;
    }, /unknown virtual_parallel key N/],
    ['legacy parent projection', () => {
      const value = structuredClone(initial);
      value.parent_session = {
        id: 'parent-1',
        inherited_at: '2026-07-13T12:34:56Z',
        parent_receipt_schema_version: '1.0',
      };
      return value;
    }, /unknown parent_session key parent_receipt_schema_version/],
    ['per-seed budget floor', () => {
      const value = structuredClone(initial);
      value.total_budget = 2;
      value.virtual_parallel.budget_total = 2;
      value.virtual_parallel.budget_unallocated = 2;
      return value;
    }, /per-seed floor/],
  ];
  for (const [label, makeValue, pattern] of cases) {
    assert.throws(() => validateSession(makeValue()), pattern, label);
  }
});

test('serialization is deterministic pretty JSON with one trailing newline', () => {
  const value = { status: 'active', nested: { seeds: [{ id: 1 }] } };
  const serialized = serializeStateDocument(value);
  assert.equal(serialized, `${JSON.stringify(value, null, 2)}\n`);
  assert.equal(serialized.endsWith('\n\n'), false);
});
