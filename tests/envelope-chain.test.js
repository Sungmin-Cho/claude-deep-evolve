'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ULID_RE } = require('../scripts/validate-envelope-emit.js');
const {
  parseSourceArtifactSpec,
  tryReadEnvelopeRunId,
} = require('../hooks/scripts/wrap-evolve-envelope.js');
const {
  wrapEnvelope,
  generateUlid,
  isEnvelope,
} = require('../hooks/scripts/envelope.js');

const WRAP_CLI = path.resolve(
  __dirname,
  '..',
  'hooks',
  'scripts',
  'wrap-evolve-envelope.js',
);
const VALIDATE_CLI = path.resolve(
  __dirname,
  '..',
  'scripts',
  'validate-envelope-emit.js',
);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'de-chain-'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function runWrap(args) {
  return execFileSync('node', [WRAP_CLI, ...args], {
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

function buildRecurringFindingsEnvelope(runId) {
  return {
    $schema: 'https://example/envelope.schema.json',
    schema_version: '1.0',
    envelope: {
      producer: 'deep-review',
      producer_version: '1.3.4',
      artifact_kind: 'recurring-findings',
      run_id: runId,
      generated_at: new Date().toISOString(),
      schema: { name: 'recurring-findings', version: '1.0' },
      git: { head: 'aaa1111', branch: 'main', dirty: false },
      provenance: { source_artifacts: [], tool_versions: { node: process.version } },
    },
    payload: {
      findings: [
        { category: 'error-handling', occurrences: 3 },
        { category: 'test-coverage', occurrences: 4 },
      ],
    },
  };
}

describe('envelope-chain — evolve-receipt wrapped via wrap-evolve-envelope.js', () => {
  it('emits a valid envelope and survives the validator', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'evolve-receipt.json');
    writeJson(payload, {
      plugin: 'deep-evolve',
      version: '3.2.0',
      receipt_schema_version: 2,
      goal: 'optimize',
      experiments: { total: 1, kept: 1, discarded: 0, crashed: 0, keep_rate: 1.0 },
    });

    runWrap([
      '--artifact-kind', 'evolve-receipt',
      '--payload-file', payload,
      '--output', out,
    ]);

    runValidate(out);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(obj.envelope.producer, 'deep-evolve');
    assert.equal(obj.envelope.artifact_kind, 'evolve-receipt');
    assert.equal(obj.envelope.schema.name, 'evolve-receipt');
    assert.match(obj.envelope.run_id, ULID_RE);
    assert.equal(obj.payload.goal, 'optimize');
  });

  it('emits a valid envelope for evolve-insights and survives the validator', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'evolve-insights.json');
    writeJson(payload, {
      updated_at: new Date().toISOString(),
      insights_for_deep_work: [],
      insights_for_deep_review: [],
    });

    runWrap([
      '--artifact-kind', 'evolve-insights',
      '--payload-file', payload,
      '--output', out,
    ]);

    runValidate(out);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(obj.envelope.artifact_kind, 'evolve-insights');
    assert.equal(obj.envelope.schema.name, 'evolve-insights');
    assert.ok(!('parent_run_id' in obj.envelope), 'evolve-insights must omit parent_run_id by default (multi-source aggregator)');
  });
});

describe('envelope-chain — evolve-receipt parent_run_id matches consumed recurring-findings', () => {
  it('cross-plugin chain: evolve-receipt.envelope.parent_run_id === recurring-findings.envelope.run_id', () => {
    const dir = tmpDir();

    // Stand up a deep-review recurring-findings envelope as deep-review would emit it.
    const recRunId = generateUlid();
    const recEnvelope = buildRecurringFindingsEnvelope(recRunId);
    const recPath = path.join(dir, 'recurring-findings.json');
    writeJson(recPath, recEnvelope);
    assert.equal(isEnvelope(recEnvelope), true);
    assert.equal(tryReadEnvelopeRunId(recPath), recRunId);

    // evolve-receipt: parent_run_id auto-detected from consumed recurring-findings.
    const payload = path.join(dir, 'evolve-payload.json');
    const out = path.join(dir, 'evolve-receipt.json');
    writeJson(payload, {
      plugin: 'deep-evolve',
      version: '3.2.0',
      receipt_schema_version: 2,
      goal: 'optimize hot path',
      experiments: { total: 5, kept: 2, discarded: 3, crashed: 0, keep_rate: 0.4 },
    });
    runWrap([
      '--artifact-kind', 'evolve-receipt',
      '--payload-file', payload,
      '--output', out,
      '--source-recurring-findings', recPath,
    ]);

    runValidate(out);

    const evolve = JSON.parse(fs.readFileSync(out, 'utf8'));

    // CONTRACT TEST (handoff §3.3): evolve-receipt.parent_run_id ===
    // consumed recurring-findings.envelope.run_id.
    assert.equal(
      evolve.envelope.parent_run_id,
      recRunId,
      'evolve-receipt.parent_run_id must equal consumed recurring-findings.envelope.run_id',
    );

    // recurring-findings path must also be in source_artifacts with its run_id.
    const sa = evolve.envelope.provenance.source_artifacts;
    const recSa = sa.find((s) => s.path === recPath);
    assert.ok(recSa, 'recurring-findings path missing from source_artifacts');
    assert.equal(recSa.run_id, recRunId, 'recurring-findings source_artifact run_id mismatch');
  });

  it('honors explicit --parent-run-id over auto-detected recurring-findings run_id', () => {
    const dir = tmpDir();
    const recRunId = generateUlid();
    const recEnvelope = buildRecurringFindingsEnvelope(recRunId);
    const recPath = path.join(dir, 'recurring-findings.json');
    writeJson(recPath, recEnvelope);

    const explicit = generateUlid();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'evolve-receipt.json');
    writeJson(payload, { goal: 'x', plugin: 'deep-evolve' });
    runWrap([
      '--artifact-kind', 'evolve-receipt',
      '--payload-file', payload,
      '--output', out,
      '--source-recurring-findings', recPath,
      '--parent-run-id', explicit,
    ]);
    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(obj.envelope.parent_run_id, explicit);
    // recurring-findings still in source_artifacts with its actual run_id.
    const sa = obj.envelope.provenance.source_artifacts;
    const recSa = sa.find((s) => s.path === recPath);
    assert.equal(recSa.run_id, recRunId);
  });

  it('legacy (non-envelope) recurring-findings.json contributes path only, no run_id, no parent_run_id', () => {
    const dir = tmpDir();
    const recPath = path.join(dir, 'recurring-findings.json');
    // Legacy shape — no envelope wrapper.
    writeJson(recPath, { findings: [{ category: 'error-handling', occurrences: 3 }] });

    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'evolve-receipt.json');
    writeJson(payload, { goal: 'x', plugin: 'deep-evolve' });
    runWrap([
      '--artifact-kind', 'evolve-receipt',
      '--payload-file', payload,
      '--output', out,
      '--source-recurring-findings', recPath,
    ]);
    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(!('parent_run_id' in obj.envelope), 'parent_run_id must be absent for legacy recurring-findings');
    const sa = obj.envelope.provenance.source_artifacts;
    const recSa = sa.find((s) => s.path === recPath);
    assert.ok(recSa, 'legacy recurring-findings path must still be in source_artifacts');
    assert.ok(!('run_id' in recSa), 'legacy recurring-findings must not contribute a run_id');
  });
});

describe('envelope-chain — evolve-insights multi-source aggregator', () => {
  it('records --source-artifact entries in source_artifacts (no parent_run_id)', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'evolve-insights.json');
    writeJson(payload, { updated_at: new Date().toISOString(), insights_for_deep_work: [] });

    runWrap([
      '--artifact-kind', 'evolve-insights',
      '--payload-file', payload,
      '--output', out,
      '--source-artifact', '~/.claude/deep-evolve/meta-archive.jsonl',
      '--source-artifact', '.deep-review/recurring-findings.json',
    ]);

    runValidate(out);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(!('parent_run_id' in obj.envelope), 'evolve-insights must not auto-set parent_run_id');
    const sa = obj.envelope.provenance.source_artifacts;
    assert.equal(sa.length, 2);
    assert.deepEqual(
      sa.map((s) => s.path).sort(),
      ['.deep-review/recurring-findings.json', '~/.claude/deep-evolve/meta-archive.jsonl'].sort(),
    );
  });
});

describe('envelope-chain — parseSourceArtifactSpec', () => {
  it('parses path-only spec', () => {
    assert.deepEqual(
      parseSourceArtifactSpec('.deep-review/recurring-findings.json'),
      { path: '.deep-review/recurring-findings.json' },
    );
  });

  it('parses path:run_id spec when run_id is a valid ULID', () => {
    const ulid = '01JTKGZQ7NABCDEFGHJKMNPQRS';
    assert.deepEqual(
      parseSourceArtifactSpec(`some/path.json:${ulid}`),
      { path: 'some/path.json', run_id: ulid },
    );
  });

  it('treats trailing colon segment that is not a ULID as part of the path', () => {
    // Defense against URL-like or drive-letter-style paths.
    assert.deepEqual(
      parseSourceArtifactSpec('https://example.com/x.json:not-a-ulid'),
      { path: 'https://example.com/x.json:not-a-ulid' },
    );
  });

  it('returns null on empty', () => {
    assert.equal(parseSourceArtifactSpec(''), null);
    assert.equal(parseSourceArtifactSpec(null), null);
  });
});

describe('envelope-chain — tryReadEnvelopeRunId rejects corrupt envelope (W4)', () => {
  it('returns null for envelope with payload: null', () => {
    const dir = tmpDir();
    const corrupt = path.join(dir, 'corrupt.json');
    writeJson(corrupt, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-review',
        artifact_kind: 'recurring-findings',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'recurring-findings', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: null,
    });
    assert.strictEqual(tryReadEnvelopeRunId(corrupt), null);
  });

  it('returns null for envelope with payload: array', () => {
    const dir = tmpDir();
    const corrupt = path.join(dir, 'corrupt.json');
    writeJson(corrupt, {
      schema_version: '1.0',
      envelope: { run_id: '01JTKEV0NHABCDEFGHJKMNPQRS' },
      payload: [1, 2, 3],
    });
    assert.strictEqual(tryReadEnvelopeRunId(corrupt), null);
  });

  it('returns the run_id for valid envelope', () => {
    const dir = tmpDir();
    const valid = path.join(dir, 'valid.json');
    writeJson(valid, {
      schema_version: '1.0',
      envelope: { run_id: '01JTKEV0NHABCDEFGHJKMNPQRS' },
      payload: { x: 1 },
    });
    assert.strictEqual(tryReadEnvelopeRunId(valid), '01JTKEV0NHABCDEFGHJKMNPQRS');
  });

  it('returns null for non-existent file', () => {
    assert.strictEqual(tryReadEnvelopeRunId('/non-existent/foo.json'), null);
  });

  it('returns null for invalid JSON file', () => {
    const dir = tmpDir();
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not valid json');
    assert.strictEqual(tryReadEnvelopeRunId(bad), null);
  });
});

describe('envelope-chain — atomic write (C1)', () => {
  it('does not leave a .tmp file after successful write', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'evolve-receipt.json');
    writeJson(payload, { goal: 'x', plugin: 'deep-evolve' });
    runWrap([
      '--artifact-kind', 'evolve-receipt',
      '--payload-file', payload,
      '--output', out,
    ]);
    assert.ok(fs.existsSync(out), 'final output must exist');
    const tmpResidue = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    assert.deepEqual(tmpResidue, [], `tmp residue left behind: ${JSON.stringify(tmpResidue)}`);
  });
});

describe('envelope-chain — wrapEnvelope intra-plugin chain via lib', () => {
  it('builds evolve-insights envelope with multiple source_artifacts', () => {
    const meta = '~/.claude/deep-evolve/meta-archive.jsonl';
    const review = '.deep-review/recurring-findings.json';
    const reviewRunId = generateUlid();
    const env = wrapEnvelope({
      artifactKind: 'evolve-insights',
      payload: { updated_at: '2026-05-08T03:00:00Z', insights_for_deep_work: [] },
      sourceArtifacts: [
        { path: meta },
        { path: review, run_id: reviewRunId },
      ],
      git: { head: 'abc1234', branch: 'main', dirty: false },
    });
    assert.ok(!('parent_run_id' in env.envelope), 'evolve-insights default omits parent_run_id');
    const ids = env.envelope.provenance.source_artifacts.map((sa) => ({ path: sa.path, run_id: sa.run_id }));
    assert.deepEqual(ids, [
      { path: meta, run_id: undefined },
      { path: review, run_id: reviewRunId },
    ]);
  });
});
