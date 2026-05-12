'use strict';

/**
 * handoff-roundtrip.test.js — M5.5 #8 (deep-evolve half) + M5.7.B test target.
 *
 * Verifies emit-handoff.js + emit-compaction-state.js produce envelope-wrapped
 * artifacts that satisfy the claude-deep-dashboard suite-collector's
 * `unwrapStrict` contract (cf. claude-deep-dashboard/lib/suite-collector.js).
 *
 * Symmetric counterpart to claude-deep-work/tests/handoff-roundtrip.test.js —
 * exercises the reverse-handoff scenario (`handoff_kind: "evolve-to-deep-work"`)
 * with `envelope.parent_run_id` chaining to an upstream forward handoff so
 * the dashboard's `suite.handoff.roundtrip_success_rate` reads 1.0.
 *
 * Required-field contract (must mirror deep-work side):
 *   deep-evolve/handoff:           schema_version, handoff_kind, from, to,
 *                                  summary, next_action_brief
 *   deep-evolve/compaction-state:  schema_version, compacted_at, trigger,
 *                                  preserved_artifact_paths
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ULID_RE } = require('../scripts/validate-envelope-emit.js');
const {
  wrapEnvelope,
  generateUlid,
  isValidEnvelope,
} = require('../hooks/scripts/envelope.js');
const {
  validateHandoffPayload,
  HANDOFF_REQUIRED,
  VALID_HANDOFF_KINDS,
  KIND_DIRECTIONS,
  DE_PARENT_IDENTITIES,
  tryReadEnvelopeRunId,
} = require('../hooks/scripts/emit-handoff.js');
const {
  validateCompactionPayload,
  VALID_TRIGGERS,
  VALID_STRATEGIES,
  COMPACTION_REQUIRED,
} = require('../hooks/scripts/emit-compaction-state.js');

const EMIT_HANDOFF = path.resolve(__dirname, '..', 'hooks', 'scripts', 'emit-handoff.js');
const EMIT_COMPACTION = path.resolve(__dirname, '..', 'hooks', 'scripts', 'emit-compaction-state.js');
const VALIDATE_CLI = path.resolve(__dirname, '..', 'scripts', 'validate-envelope-emit.js');

// Dashboard's PAYLOAD_REQUIRED_FIELDS — must match
// claude-deep-dashboard/lib/suite-constants.js exactly.
const DASHBOARD_HANDOFF_REQUIRED = [
  'schema_version', 'handoff_kind', 'from', 'to', 'summary', 'next_action_brief',
];
const DASHBOARD_COMPACTION_REQUIRED = [
  'schema_version', 'compacted_at', 'trigger', 'preserved_artifact_paths',
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'de-handoff-'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function runEmit(script, args) {
  return execFileSync('node', [script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runValidate(file) {
  return execFileSync('node', [VALIDATE_CLI, file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Mirror of claude-deep-dashboard/lib/suite-collector.js `unwrapStrict`. Kept
 * zero-dep so deep-evolve doesn't import dashboard code.
 *
 * R1 review C3 (Opus): the real dashboard checks `schema.name === expectedKind`
 * but NOT `schema.version`. The mirror previously was a strict superset (also
 * checked schema.version === '1.0') which defeats its drift-sensor purpose.
 * Now a true mirror — additive future evolution (schema.version='1.1') would
 * pass both real and mirrored checks identically.
 *
 * If dashboard contract drifts, M5.5 #8 cross-plugin CI in suite repo catches it.
 */
function dashboardUnwrapStrict(obj, expectedProducer, expectedKind, requiredFields) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { failure: 'not-envelope-shape' };
  }
  if (obj.schema_version !== '1.0') return { failure: 'not-envelope-shape' };
  if (!obj.envelope || typeof obj.envelope !== 'object' || Array.isArray(obj.envelope)) {
    return { failure: 'not-envelope-shape' };
  }
  if (obj.payload === undefined) return { failure: 'not-envelope-shape' };
  const env = obj.envelope;
  if (
    env.producer !== expectedProducer ||
    env.artifact_kind !== expectedKind ||
    !env.schema ||
    typeof env.schema !== 'object' ||
    Array.isArray(env.schema) ||
    env.schema.name !== expectedKind
  ) {
    return { failure: 'identity-mismatch' };
  }
  const pl = obj.payload;
  if (pl === null || typeof pl !== 'object' || Array.isArray(pl)) {
    return { failure: 'payload-shape-violation' };
  }
  const missing = requiredFields.filter((k) => !(k in pl));
  if (missing.length > 0) {
    return { failure: `missing-required-fields:${missing.join(',')}` };
  }
  return { ok: true, envelope: env, payload: pl };
}

/**
 * Build a fake **upstream forward handoff** (as deep-work Phase 5 → deep-evolve
 * would emit it). The reverse handoff emitted in these tests chains
 * `parent_run_id` to this artifact's `envelope.run_id`.
 *
 * Constructs the envelope by hand because deep-evolve's wrapEnvelope (correctly)
 * sets producer='deep-evolve'; the upstream artifact has producer='deep-work'.
 */
function makeForwardHandoffEnvelope(dir) {
  const forwardRunId = generateUlid();
  const forwardHandoff = {
    $schema: 'https://raw.githubusercontent.com/Sungmin-Cho/claude-deep-suite/main/schemas/artifact-envelope.schema.json',
    schema_version: '1.0',
    envelope: {
      producer: 'deep-work',
      producer_version: '6.6.0',
      artifact_kind: 'handoff',
      run_id: forwardRunId,
      generated_at: new Date().toISOString(),
      schema: { name: 'handoff', version: '1.0' },
      git: { head: 'abc1234', branch: 'main', dirty: false },
      provenance: { source_artifacts: [], tool_versions: { node: process.version } },
    },
    payload: {
      schema_version: '1.0',
      handoff_kind: 'phase-5-to-evolve',
      from: {
        producer: 'deep-work',
        completed_at: '2026-05-12T10:00:00Z',
      },
      to: {
        producer: 'deep-evolve',
        intent: 'performance-optimization',
      },
      summary: 'Phase 5 closes; baton to deep-evolve.',
      next_action_brief: 'Optimize JWT verify p99 from 180ms toward <50ms.',
    },
  };
  const p = path.join(dir, 'forward-handoff.json');
  writeJson(p, forwardHandoff);
  return { path: p, runId: forwardRunId };
}

function makeReverseHandoffPayload() {
  return {
    schema_version: '1.0',
    handoff_kind: 'evolve-to-deep-work',
    from: {
      producer: 'deep-evolve',
      session_id: '2026-05-12-evolve-test',
      phase: 'epoch-3-plateau',
      completed_at: '2026-05-12T11:00:00Z',
    },
    to: {
      producer: 'deep-work',
      intent: 'structural-refactor',
      scope_hint: 'src/auth/jwt.ts:120-145 (inner verify loop)',
    },
    summary: 'p99 dropped 180→90ms (target <50ms). Further gains need restructure outside evolve budget.',
    next_action_brief: 'deep-work session to refactor inner verify loop in src/auth/jwt.ts:120-145; goal: reduce branch count, hoist constants, evaluate batched verify.',
    completed_actions: ['ran 3 epochs', 'achieved 50% p99 reduction'],
  };
}

// ---------------------------------------------------------------------------
// emit-handoff.js — payload validation (unit)
// ---------------------------------------------------------------------------

describe('emit-handoff — HANDOFF_REQUIRED matches dashboard contract', () => {
  it('emit-handoff.js HANDOFF_REQUIRED is identical to dashboard PAYLOAD_REQUIRED_FIELDS["deep-evolve/handoff"]', () => {
    assert.deepEqual(HANDOFF_REQUIRED, DASHBOARD_HANDOFF_REQUIRED);
  });

  it('rejects payload missing handoff_kind', () => {
    const payload = makeReverseHandoffPayload();
    delete payload.handoff_kind;
    const errors = validateHandoffPayload(payload);
    assert.ok(errors.some((e) => /handoff_kind/.test(e)), errors.join(';'));
  });

  it('rejects payload with non-1.0 schema_version', () => {
    const payload = makeReverseHandoffPayload();
    payload.schema_version = '2.0';
    const errors = validateHandoffPayload(payload);
    assert.ok(errors.some((e) => /schema_version/.test(e)), errors.join(';'));
  });

  it('rejects payload with to.intent missing', () => {
    const payload = makeReverseHandoffPayload();
    delete payload.to.intent;
    const errors = validateHandoffPayload(payload);
    assert.ok(errors.some((e) => /to/.test(e)), errors.join(';'));
  });

  it('rejects array payload (corrupt-payload defense)', () => {
    const errors = validateHandoffPayload([makeReverseHandoffPayload()]);
    assert.ok(errors.some((e) => /non-array/.test(e)), errors.join(';'));
  });

  // R1 review C2 (Opus): handoff_kind enum validation regression test.
  it('rejects payload with invalid handoff_kind (R1 C2)', () => {
    const payload = makeReverseHandoffPayload();
    payload.handoff_kind = 'evolve-to-deepwork';  // missing hyphen
    const errors = validateHandoffPayload(payload);
    assert.ok(
      errors.some((e) => /handoff_kind must be one of/.test(e)),
      errors.join(';'),
    );
  });

  it('accepts every schema-enum handoff_kind value with matching direction', () => {
    // R2 review fix: direction enforcement requires matching from/to producers
    // for direction-bound kinds.
    for (const kind of VALID_HANDOFF_KINDS) {
      const payload = makeReverseHandoffPayload();
      payload.handoff_kind = kind;
      if (KIND_DIRECTIONS[kind]) {
        payload.from.producer = KIND_DIRECTIONS[kind].from;
        payload.to.producer = KIND_DIRECTIONS[kind].to;
      }
      const errors = validateHandoffPayload(payload);
      assert.deepEqual(errors, [], `${kind} should be valid: ${errors.join(';')}`);
    }
  });

  // R2 review fix (Codex adversarial MEDIUM): direction enforcement.
  it('rejects evolve-to-deep-work with wrong from.producer (R2)', () => {
    const payload = makeReverseHandoffPayload();
    payload.from.producer = 'deep-work';  // wrong — should be deep-evolve
    const errors = validateHandoffPayload(payload);
    assert.ok(
      errors.some((e) => /from\.producer.*must be "deep-evolve"/.test(e)),
      errors.join(';'),
    );
  });

  it('rejects evolve-to-deep-work with wrong to.producer (R2)', () => {
    const payload = makeReverseHandoffPayload();
    payload.to.producer = 'deep-evolve';  // wrong — should be deep-work
    const errors = validateHandoffPayload(payload);
    assert.ok(
      errors.some((e) => /to\.producer.*must be "deep-work"/.test(e)),
      errors.join(';'),
    );
  });

  it('does not enforce direction for custom / slice-to-slice', () => {
    const payload = makeReverseHandoffPayload();
    payload.handoff_kind = 'custom';
    payload.from.producer = 'deep-evolve';
    payload.to.producer = 'deep-evolve';  // intentional same-producer
    assert.deepEqual(validateHandoffPayload(payload), []);
  });

  // R2 review fix (Codex adversarial MEDIUM): tryReadEnvelopeRunId identity check.
  it('tryReadEnvelopeRunId rejects foreign envelope (R2)', () => {
    const dir = tmpDir();
    // Build a deep-wiki page envelope (foreign).
    const foreign = {
      $schema: 'https://example/envelope.schema.json',
      schema_version: '1.0',
      envelope: {
        producer: 'deep-wiki',
        producer_version: '1.5.0',
        artifact_kind: 'index',
        run_id: '01JTKGZQ7NABCDEFGHJKMNPQRS',
        generated_at: new Date().toISOString(),
        schema: { name: 'index', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: { node: 'v20' } },
      },
      payload: { schema_version: '1.0', pages: [] },
    };
    const foreignPath = path.join(dir, 'foreign.json');
    writeJson(foreignPath, foreign);

    const result = tryReadEnvelopeRunId(foreignPath, DE_PARENT_IDENTITIES);
    assert.equal(result, null, 'foreign envelope must not yield a run_id');
  });

  it('tryReadEnvelopeRunId accepts deep-work forward handoff as parent (R2)', () => {
    const dir = tmpDir();
    const fwd = makeForwardHandoffEnvelope(dir);
    const result = tryReadEnvelopeRunId(fwd.path, DE_PARENT_IDENTITIES);
    assert.equal(result, fwd.runId);
  });

  it('VALID_HANDOFF_KINDS contains all 5 schema enum values', () => {
    assert.deepEqual(
      [...VALID_HANDOFF_KINDS].sort(),
      ['custom', 'evolve-to-deep-work', 'phase-5-to-evolve', 'session-resume', 'slice-to-slice'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// emit-handoff.js — CLI roundtrip
// ---------------------------------------------------------------------------

describe('emit-handoff.js — reverse handoff CLI roundtrip satisfies dashboard unwrapStrict', () => {
  it('emits envelope + parent_run_id closes the round-trip back to forward handoff', () => {
    const dir = tmpDir();
    const fwd = makeForwardHandoffEnvelope(dir);

    const payloadPath = path.join(dir, 'reverse-handoff-payload.json');
    writeJson(payloadPath, makeReverseHandoffPayload());

    const outPath = path.join(dir, 'handoffs', 'reverse-handoff.json');
    runEmit(EMIT_HANDOFF, [
      '--payload-file', payloadPath,
      '--output', outPath,
      '--source-parent', fwd.path,
      '--session-id', '2026-05-12-evolve-test',
    ]);

    // envelope shape via the deep-evolve-side validator
    runValidate(outPath);

    // Dashboard contract — the actual production gate.
    const obj = readJson(outPath);
    const result = dashboardUnwrapStrict(
      obj, 'deep-evolve', 'handoff', DASHBOARD_HANDOFF_REQUIRED,
    );
    assert.equal(result.failure, undefined, `unwrapStrict failed: ${result.failure}`);
    assert.ok(result.ok);

    // Round-trip closure: reverse handoff parent_run_id === forward handoff run_id.
    assert.equal(obj.envelope.parent_run_id, fwd.runId);
    assert.match(obj.envelope.run_id, ULID_RE);
    assert.notEqual(obj.envelope.run_id, fwd.runId);

    // Provenance: source_artifacts records the forward handoff with its run_id.
    const provSrc = obj.envelope.provenance.source_artifacts;
    assert.ok(Array.isArray(provSrc));
    const srcEntry = provSrc.find((s) => s.run_id === fwd.runId);
    assert.ok(srcEntry, 'forward handoff source_artifacts entry missing');

    // handoff_kind is the reverse direction.
    assert.equal(obj.payload.handoff_kind, 'evolve-to-deep-work');
    assert.equal(obj.payload.to.producer, 'deep-work');
    assert.equal(obj.payload.from.producer, 'deep-evolve');
  });

  it('accepts --source-evolve-receipt as alias for --source-parent', () => {
    const dir = tmpDir();
    const fwd = makeForwardHandoffEnvelope(dir);

    const payloadPath = path.join(dir, 'p.json');
    writeJson(payloadPath, makeReverseHandoffPayload());

    const outPath = path.join(dir, 'h.json');
    runEmit(EMIT_HANDOFF, [
      '--payload-file', payloadPath,
      '--output', outPath,
      '--source-evolve-receipt', fwd.path,
    ]);

    const obj = readJson(outPath);
    assert.equal(obj.envelope.parent_run_id, fwd.runId);
  });

  it('exits non-zero with payload validation error when summary missing', () => {
    const dir = tmpDir();
    const fwd = makeForwardHandoffEnvelope(dir);
    const bad = makeReverseHandoffPayload();
    delete bad.summary;
    const payloadPath = path.join(dir, 'bad.json');
    writeJson(payloadPath, bad);

    const outPath = path.join(dir, 'h.json');
    try {
      execFileSync('node', [
        EMIT_HANDOFF,
        '--payload-file', payloadPath,
        '--output', outPath,
        '--source-parent', fwd.path,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.fail('should have failed for missing summary');
    } catch (err) {
      assert.equal(err.status, 1);
      assert.match(String(err.stderr), /summary/);
    }
    assert.equal(fs.existsSync(outPath), false);
  });
});

// ---------------------------------------------------------------------------
// emit-compaction-state.js — payload validation
// ---------------------------------------------------------------------------

describe('emit-compaction-state — required + trigger enum match suite schema', () => {
  it('COMPACTION_REQUIRED matches dashboard PAYLOAD_REQUIRED_FIELDS["deep-evolve/compaction-state"]', () => {
    assert.deepEqual(COMPACTION_REQUIRED, DASHBOARD_COMPACTION_REQUIRED);
  });

  it('accepts loop-epoch-end (deep-evolve canonical trigger)', () => {
    const errors = validateCompactionPayload({
      schema_version: '1.0',
      compacted_at: '2026-05-12T11:00:00Z',
      trigger: 'loop-epoch-end',
      preserved_artifact_paths: ['.deep-evolve/foo/evolve-receipt.json'],
    });
    assert.deepEqual(errors, []);
  });

  it('VALID_TRIGGERS contains all 6 schema enum values', () => {
    assert.deepEqual(
      [...VALID_TRIGGERS].sort(),
      [
        'loop-epoch-end',
        'manual',
        'phase-transition',
        'session-stop',
        'slice-green',
        'window-threshold',
      ].sort(),
    );
  });

  // R1 review C2: compaction_strategy enum validation in --payload-file mode.
  it('rejects payload-file with invalid compaction_strategy (R1 C2)', () => {
    const errors = validateCompactionPayload({
      schema_version: '1.0',
      compacted_at: '2026-05-12T11:00:00Z',
      trigger: 'loop-epoch-end',
      preserved_artifact_paths: [],
      compaction_strategy: 'receipt-onnly',  // typo
    });
    assert.ok(
      errors.some((e) => /compaction_strategy must be one of/.test(e)),
      errors.join(';'),
    );
  });

  it('accepts every schema-enum compaction_strategy value', () => {
    for (const strategy of VALID_STRATEGIES) {
      const errors = validateCompactionPayload({
        schema_version: '1.0',
        compacted_at: '2026-05-12T11:00:00Z',
        trigger: 'loop-epoch-end',
        preserved_artifact_paths: [],
        compaction_strategy: strategy,
      });
      assert.deepEqual(errors, [], `${strategy} should be valid: ${errors.join(';')}`);
    }
  });
});

// ---------------------------------------------------------------------------
// emit-compaction-state.js — CLI roundtrip
// ---------------------------------------------------------------------------

describe('emit-compaction-state.js — CLI roundtrip satisfies dashboard unwrapStrict', () => {
  it('loop-epoch-end with receipt-only strategy chains to forward handoff', () => {
    const dir = tmpDir();
    const fwd = makeForwardHandoffEnvelope(dir);

    const outPath = path.join(dir, 'compaction-states', 'cs.json');
    runEmit(EMIT_COMPACTION, [
      '--trigger', 'loop-epoch-end',
      '--output', outPath,
      '--session-id', '2026-05-12-evolve-test',
      '--preserved', '.deep-evolve/foo/evolve-receipt.json',
      '--discarded', '.deep-evolve/foo/epoch-1-trace.jsonl,.deep-evolve/foo/epoch-2-trace.jsonl',
      '--strategy', 'receipt-only',
      '--source-parent', fwd.path,
    ]);

    runValidate(outPath);

    const obj = readJson(outPath);
    const result = dashboardUnwrapStrict(
      obj, 'deep-evolve', 'compaction-state', DASHBOARD_COMPACTION_REQUIRED,
    );
    assert.equal(result.failure, undefined, `unwrapStrict failed: ${result.failure}`);

    assert.equal(obj.envelope.parent_run_id, fwd.runId);
    assert.equal(obj.payload.trigger, 'loop-epoch-end');
    assert.equal(obj.payload.compaction_strategy, 'receipt-only');
    assert.deepEqual(obj.payload.preserved_artifact_paths, [
      '.deep-evolve/foo/evolve-receipt.json',
    ]);
    assert.deepEqual(obj.payload.discarded_artifact_paths, [
      '.deep-evolve/foo/epoch-1-trace.jsonl',
      '.deep-evolve/foo/epoch-2-trace.jsonl',
    ]);
  });

  it('emits valid compaction-state for each trigger enum value', () => {
    const dir = tmpDir();
    for (const trigger of VALID_TRIGGERS) {
      const outPath = path.join(dir, `cs-${trigger}.json`);
      runEmit(EMIT_COMPACTION, [
        '--trigger', trigger,
        '--output', outPath,
        '--preserved', '.deep-evolve/x/y.md',
      ]);
      const obj = readJson(outPath);
      assert.equal(obj.payload.trigger, trigger);
      const r = dashboardUnwrapStrict(
        obj, 'deep-evolve', 'compaction-state', DASHBOARD_COMPACTION_REQUIRED,
      );
      assert.equal(r.failure, undefined, `${trigger}: ${r.failure}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip — forward handoff + reverse handoff + compaction-state
// ---------------------------------------------------------------------------

describe('full round-trip — forward handoff → reverse handoff → compaction-state', () => {
  it('all three artifacts chain via run_id (closes dashboard roundtrip_success_rate)', () => {
    const dir = tmpDir();
    const fwd = makeForwardHandoffEnvelope(dir);

    // Reverse handoff
    const rhPayload = path.join(dir, 'rh-payload.json');
    writeJson(rhPayload, makeReverseHandoffPayload());
    const rhPath = path.join(dir, 'reverse-handoff.json');
    runEmit(EMIT_HANDOFF, [
      '--payload-file', rhPayload,
      '--output', rhPath,
      '--source-parent', fwd.path,
    ]);

    // Compaction-state at epoch end, chains to reverse handoff for full lineage
    const csPath = path.join(dir, 'compaction-state.json');
    runEmit(EMIT_COMPACTION, [
      '--trigger', 'loop-epoch-end',
      '--output', csPath,
      '--preserved', rhPath,
      '--source-parent', rhPath,
      '--strategy', 'receipt-only',
    ]);

    const rh = readJson(rhPath);
    const cs = readJson(csPath);

    assert.equal(rh.envelope.parent_run_id, fwd.runId, 'reverse handoff parents to forward handoff');
    assert.equal(cs.envelope.parent_run_id, rh.envelope.run_id, 'compaction-state parents to reverse handoff');
    assert.notEqual(rh.envelope.run_id, fwd.runId);
    assert.notEqual(cs.envelope.run_id, rh.envelope.run_id);

    assert.ok(isValidEnvelope(rh));
    assert.ok(isValidEnvelope(cs));
    assert.equal(
      dashboardUnwrapStrict(rh, 'deep-evolve', 'handoff', DASHBOARD_HANDOFF_REQUIRED).failure,
      undefined,
    );
    assert.equal(
      dashboardUnwrapStrict(cs, 'deep-evolve', 'compaction-state', DASHBOARD_COMPACTION_REQUIRED)
        .failure,
      undefined,
    );
  });
});
