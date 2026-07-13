'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  resolveDataRoot,
  lookupTransfer,
  recordTransfer,
  mergePendingArchive,
  pruneTransfer,
  exportFeedback,
} = require('../hooks/scripts/runtime/synthesis.cjs');
const { wrapEvolveArtifact } = require('../hooks/scripts/wrap-evolve-envelope.js');
const { buildHandoffArtifact } = require('../hooks/scripts/emit-handoff.js');
const { buildCompactionArtifact } = require('../hooks/scripts/emit-compaction-state.js');
const { withDirectoryLock } = require('../hooks/scripts/runtime/session-store.cjs');

const RUN_ID = '01JTKGZQ7NABCDEFGHJKMNPQRS';
const PARENT_ID = '01JTKGZQ7NABCDEFGHJKMNPQRT';

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task5 archive root '));
}

function writeArchive(dataRoot, entries) {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'meta-archive.jsonl'), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

function envelopeOptions() {
  return {
    runId: RUN_ID,
    generatedAt: '2026-07-13T00:00:00.000Z',
    producerVersion: '3.4.3',
    git: { head: 'abcdef0', branch: 'main', dirty: false },
    toolVersions: { node: 'v22.23.1' },
  };
}

test('data root preserves the shared ~/.claude/deep-evolve default and explicit override', () => {
  assert.equal(resolveDataRoot({}, () => '/home/codex'), path.join('/home/codex', '.claude', 'deep-evolve'));
  assert.equal(resolveDataRoot({ DEEP_EVOLVE_DATA_ROOT: '/shared/archive' }, () => '/ignored'), path.resolve('/shared/archive'));
});

test('meta lookup preserves missing-schema v2 compatibility plus v3/v4 exact branches', () => {
  const dataRoot = root();
  const entries = [
    {
      id: 'v2', project: { goal_description: 'old' },
      final_strategy: { weights: { breadth: 0.4, depth: 0.3, novelty: 0.2, safety: 0.1 } },
      usage_count: 0, transfer_success_rate: null,
    },
    {
      id: 'v3', schema_version: 3, project: { goal_description: 'three' },
      final_strategy: { weights: { exploitation: 0.7, exploration: 0.3 } },
      usage_count: 0, transfer_success_rate: null,
    },
    {
      id: 'v4', schema_version: 4, project: { goal_description: 'four' },
      final_strategy: { weights: { exploitation: 0.6, exploration: 0.4 } },
      virtual_parallel: { n_initial: 4, project_type: 'modular' },
      usage_count: 0, transfer_success_rate: null,
    },
  ];
  writeArchive(dataRoot, entries);
  const v2 = lookupTransfer({ dataRoot, selectedId: 'v2' });
  assert.equal(v2.source_schema_version, 2);
  assert.equal(v2.n_prior, 1);
  assert.equal(Object.keys(v2.weights).length, 10);
  const v3 = lookupTransfer({ dataRoot, selectedId: 'v3' });
  assert.equal(v3.source_schema_version, 3);
  assert.deepEqual(v3.weights, entries[1].final_strategy.weights);
  assert.equal(v3.n_prior, 1);
  const v4 = lookupTransfer({ dataRoot, selectedId: 'v4' });
  assert.equal(v4.source_schema_version, 4);
  assert.equal(v4.n_prior, 4);
  assert.deepEqual(v4.virtual_parallel, entries[2].virtual_parallel);
});

test('meta lookup rejects v5 forward incompatibility, skips malformed versions, filters pruned rows, and rejects symlinks', () => {
  const dataRoot = root();
  writeArchive(dataRoot, [
    { id: 'bad', schema_version: '04', final_strategy: { weights: {} } },
    { id: 'pruned', schema_version: 4, pruned: true, final_strategy: { weights: {} } },
    { id: 'future', schema_version: 5, final_strategy: { weights: {} } },
  ]);
  assert.throws(() => lookupTransfer({ dataRoot, selectedId: 'future' }), (error) => error.rc === 2 && /newer|schema/i.test(error.message));
  const listed = lookupTransfer({ dataRoot });
  assert.deepEqual(listed.entries.map((entry) => entry.id), ['future']);
  assert.equal(listed.warnings.length, 1);

  const outside = root();
  writeArchive(outside, [{ id: 'outside', schema_version: 4, final_strategy: { weights: {} } }]);
  const linked = root();
  fs.symlinkSync(path.join(outside, 'meta-archive.jsonl'), path.join(linked, 'meta-archive.jsonl'));
  assert.throws(() => lookupTransfer({ dataRoot: linked }), /symlink/i);
});

test('record updates source statistics atomically and lock fallback merges tagged plus legacy pending rows once', () => {
  const dataRoot = root();
  writeArchive(dataRoot, [{
    id: 'source', schema_version: 4, final_strategy: { weights: {} },
    usage_count: 1, transfer_success_rate: 1,
  }]);
  const next = {
    id: 'new', schema_version: 4, timestamp: '2026-07-13T00:00:00Z',
    project: {}, strategy_evolution: {}, outcome: {}, virtual_parallel: {}, transfer: { source_id: 'source' },
    usage_count: 0, transfer_success_rate: null,
  };
  const recorded = recordTransfer({ dataRoot, entry: next, sourceId: 'source', thisSessionSuccess: 0 });
  assert.equal(recorded.pending, false);
  let rows = fs.readFileSync(path.join(dataRoot, 'meta-archive.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const source = rows.find((row) => row.id === 'source');
  assert.equal(source.usage_count, 2);
  assert.equal(source.transfer_success_rate, 0.5);
  assert.equal(rows.filter((row) => row.id === 'new').length, 1);

  const pendingEntry = { ...next, id: 'pending-new' };
  const pending = recordTransfer({
    dataRoot, entry: pendingEntry, sourceId: 'source', thisSessionSuccess: 1,
    lockOptions: { timeoutMs: 0, forceTimeout: true },
  });
  assert.equal(pending.pending, true);
  fs.appendFileSync(path.join(dataRoot, '.pending-archive.jsonl'), `${JSON.stringify({ ...next, id: 'legacy-new' })}\n`);
  const merged = mergePendingArchive({ dataRoot });
  assert.equal(merged.new_entries, 2);
  assert.equal(merged.source_updates, 1);
  assert.equal(fs.existsSync(path.join(dataRoot, '.pending-archive.jsonl')), false);
  assert.deepEqual(mergePendingArchive({ dataRoot }), { new_entries: 0, source_updates: 0, duplicates: 0 });
});

test('real archive-lock contention falls back to pending and pending merge honors its own lock', () => {
  const dataRoot = root();
  writeArchive(dataRoot, []);
  const entry = {
    id: 'contended', schema_version: 4, timestamp: '2026-07-13T00:00:00Z',
    final_strategy: { weights: {} }, usage_count: 0, transfer_success_rate: null,
  };
  const lockOptions = { timeoutMs: 0, retryDelayMs: 0 };
  withDirectoryLock(path.join(dataRoot, '.meta-archive.lock'), () => {
    const result = recordTransfer({ dataRoot, entry, lockOptions });
    assert.equal(result.pending, true);
  });
  const pendingPath = path.join(dataRoot, '.pending-archive.jsonl');
  assert.equal(fs.existsSync(pendingPath), true);

  withDirectoryLock(path.join(dataRoot, '.pending-archive.lock'), () => {
    assert.throws(() => mergePendingArchive({ dataRoot, lockOptions }), /lock/i);
    assert.equal(fs.existsSync(pendingPath), true);
  });
  assert.equal(mergePendingArchive({ dataRoot }).new_entries, 1);
});

test('prune merges pending first, computes deterministic candidates, soft-prunes selected ids, and never deletes rows', () => {
  const dataRoot = root();
  writeArchive(dataRoot, [
    { id: 'v2-old', timestamp: '2025-01-01T00:00:00Z', outcome: { total_outer_generations: 3 }, usage_count: 0, transfer_success_rate: null },
    { id: 'failed', schema_version: 4, timestamp: '2026-07-01T00:00:00Z', outcome: { total_outer_generations: 3 }, usage_count: 2, transfer_success_rate: 0 },
    { id: 'healthy', schema_version: 4, timestamp: '2026-07-01T00:00:00Z', outcome: { total_outer_generations: 4 }, usage_count: 2, transfer_success_rate: 1 },
  ]);
  fs.writeFileSync(path.join(dataRoot, '.pending-archive.jsonl'), `${JSON.stringify({ type: 'new_entry', timestamp: '2026-07-13T00:00:00Z', data: { id: 'thin', schema_version: 4, timestamp: '2026-07-12T00:00:00Z', outcome: { total_outer_generations: 1 }, usage_count: 0, transfer_success_rate: null } })}\n`);
  const preview = pruneTransfer({ dataRoot, now: Date.parse('2026-07-13T00:00:00Z'), selectedIds: [] });
  assert.deepEqual(preview.candidates.map((row) => row.id), ['failed', 'thin', 'v2-old']);
  const applied = pruneTransfer({ dataRoot, now: Date.parse('2026-07-13T00:00:00Z'), selectedIds: ['failed', 'v2-old'] });
  assert.equal(applied.pruned, 2);
  const rows = fs.readFileSync(path.join(dataRoot, 'meta-archive.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 4);
  assert.equal(rows.find((row) => row.id === 'failed').pruned, true);
  assert.equal(rows.find((row) => row.id === 'healthy').pruned, undefined);
});

test('receipt and insights wrappers preserve exact identity, parent, provenance, and reject symlink sources', () => {
  const receipt = wrapEvolveArtifact({
    artifactKind: 'evolve-receipt', payload: { receipt_schema_version: 2, session_id: 's1' },
    parentRunId: PARENT_ID, sessionId: 's1', envelopeOptions: envelopeOptions(),
  });
  assert.deepEqual([
    receipt.envelope.producer,
    receipt.envelope.artifact_kind,
    receipt.envelope.schema.name,
    receipt.envelope.parent_run_id,
  ], ['deep-evolve', 'evolve-receipt', 'evolve-receipt', PARENT_ID]);

  const sourceRoot = root();
  const source = path.join(sourceRoot, 'source.json');
  fs.writeFileSync(source, JSON.stringify(receipt));
  const insights = wrapEvolveArtifact({
    artifactKind: 'evolve-insights', payload: { insights_for_deep_work: [], insights_for_deep_review: [] },
    sourceArtifacts: [{ path: source }], envelopeOptions: { ...envelopeOptions(), runId: PARENT_ID },
  });
  assert.equal('parent_run_id' in insights.envelope, false);
  assert.equal(insights.envelope.provenance.source_artifacts[0].run_id, RUN_ID);

  const link = path.join(sourceRoot, 'source-link.json');
  fs.symlinkSync(source, link);
  assert.throws(() => wrapEvolveArtifact({
    artifactKind: 'evolve-insights', payload: {}, sourceArtifacts: [{ path: link }], envelopeOptions: envelopeOptions(),
  }), /symlink/i);
});

test('handoff and compaction builders import envelope logic and preserve exact domain identity', () => {
  const handoffPayload = {
    schema_version: '1.0', handoff_kind: 'evolve-to-deep-work',
    from: { producer: 'deep-evolve', completed_at: '2026-07-13T00:00:00Z' },
    to: { producer: 'deep-work', intent: 'continue' },
    summary: 'done', next_action_brief: 'next',
  };
  const handoff = buildHandoffArtifact({
    payload: handoffPayload, parentRunId: PARENT_ID, sessionId: 's1', envelopeOptions: envelopeOptions(),
  });
  assert.deepEqual([
    handoff.envelope.producer, handoff.envelope.artifact_kind,
    handoff.envelope.schema.name, handoff.envelope.parent_run_id,
  ], ['deep-evolve', 'handoff', 'handoff', PARENT_ID]);

  const compacted = buildCompactionArtifact({
    payload: {
      schema_version: '1.0', compacted_at: '2026-07-13T00:00:00Z',
      trigger: 'loop-epoch-end', preserved_artifact_paths: ['evolve-receipt.json'],
      compaction_strategy: 'receipt-only',
    },
    parentRunId: RUN_ID, sessionId: 's1', envelopeOptions: { ...envelopeOptions(), runId: PARENT_ID },
  });
  assert.deepEqual([
    compacted.envelope.producer, compacted.envelope.artifact_kind,
    compacted.envelope.schema.name, compacted.envelope.parent_run_id,
  ], ['deep-evolve', 'compaction-state', 'compaction-state', RUN_ID]);
});

test('feedback export is a deterministic multi-source insights envelope with archive ids intact', () => {
  const artifact = exportFeedback({
    payload: {
      updated_at: '2026-07-13T00:00:00Z',
      insights_for_deep_work: [{ pattern: 'P', evidence: 'E', source_archive_ids: ['a1'], suggestion: 'S' }],
      insights_for_deep_review: [],
    },
    sourceArtifacts: [{ path: '/archive/meta-archive.jsonl' }],
    envelopeOptions: envelopeOptions(),
  });
  assert.equal(artifact.envelope.artifact_kind, 'evolve-insights');
  assert.equal('parent_run_id' in artifact.envelope, false);
  assert.deepEqual(artifact.payload.insights_for_deep_work[0].source_archive_ids, ['a1']);
});

test('supported transfer path contains no Python or wrapper CLI spawning', () => {
  const source = fs.readFileSync(require.resolve('../hooks/scripts/runtime/synthesis.cjs'), 'utf8');
  assert.doesNotMatch(source, /python(?:3)?|child_process|spawnSync|execFile|session-helper\.sh/);
});
