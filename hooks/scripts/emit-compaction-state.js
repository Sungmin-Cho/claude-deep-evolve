#!/usr/bin/env node
'use strict';

/**
 * emit-compaction-state.js — Wrap a compaction-state payload in the deep-evolve
 * M3 envelope and write to disk. Primary trigger: loop-epoch-end (the
 * canonical deep-evolve compaction boundary — each epoch terminates with a
 * receipt that subsumes intermediate experiment state). Also emitted on
 * window-threshold and session-stop boundaries.
 *
 * Identity-triplet contract enforced by the dashboard's unwrapStrict:
 *   - envelope.producer === 'deep-evolve'
 *   - envelope.artifact_kind === 'compaction-state'
 *   - envelope.schema.name === 'compaction-state'
 *   - envelope.schema.version === '1.0'
 * Payload required fields (cf. claude-deep-suite/schemas/compaction-state.schema.json):
 *   schema_version, compacted_at, trigger, preserved_artifact_paths
 *
 * Trigger enum (must match schemas/compaction-state.schema.json):
 *   phase-transition, slice-green, loop-epoch-end, window-threshold,
 *   manual, session-stop
 *
 * Strategy enum (must match schema):
 *   key-artifacts-only, receipt-only, summary-only, selective-message-drop,
 *   full-reset, custom
 *
 * Usage:
 *   node emit-compaction-state.js \
 *     --trigger <enum>                  required
 *     --output <path>                   required
 *     [--session-id <id>]               recommended
 *     [--preserved <p1,p2,...>]         comma-separated artifact paths
 *     [--discarded <p1,p2,...>]         drives preserved_artifact_ratio
 *     [--discarded-summary <text>]      audit-only
 *     [--pre-tokens <n>]                producer-side estimate
 *     [--post-tokens <n>]               producer-side estimate
 *     [--strategy <enum>]               compaction_strategy
 *     [--source-parent <p>]             upstream envelope (evolve-receipt, handoff) — fills parent_run_id
 *     [--source-evolve-receipt <p>]     alias for --source-parent
 *     [--parent-run-id <ULID>]          explicit override
 *
 *   OR --payload-file <p> --output <p> [...]  (when SKILL composes payload)
 *
 * Exit codes:
 *   0 — wrote envelope-wrapped compaction-state
 *   1 — payload validation failed (bad trigger, missing required field, etc.)
 *   2 — usage / IO / argv error
 */

const fs = require('node:fs');
const path = require('node:path');

const env = require('./envelope');

const KNOWN_FLAGS = new Set([
  'trigger',
  'output',
  'session-id',
  'preserved',
  'discarded',
  'discarded-summary',
  'pre-tokens',
  'post-tokens',
  'strategy',
  'source-parent',
  'source-evolve-receipt',
  'parent-run-id',
  'payload-file',
]);

const COMPACTION_REQUIRED = [
  'schema_version',
  'compacted_at',
  'trigger',
  'preserved_artifact_paths',
];

const VALID_TRIGGERS = new Set([
  'phase-transition',
  'slice-green',
  'loop-epoch-end',
  'window-threshold',
  'manual',
  'session-stop',
]);

const VALID_STRATEGIES = new Set([
  'key-artifacts-only',
  'receipt-only',
  'summary-only',
  'selective-message-drop',
  'full-reset',
  'custom',
]);

function usage(extra) {
  if (extra) process.stderr.write(`error: ${extra}\n`);
  process.stderr.write(
    'usage: emit-compaction-state.js --trigger <enum> --output <p>\n' +
      '                                 [--session-id <id>] [--preserved <p,...>]\n' +
      '                                 [--discarded <p,...>] [--discarded-summary <t>]\n' +
      '                                 [--pre-tokens <n>] [--post-tokens <n>]\n' +
      '                                 [--strategy <enum>]\n' +
      '                                 [--source-parent <p>] [--parent-run-id <ULID>]\n' +
      '                                 OR --payload-file <p> --output <p> [...]\n',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) usage(`unexpected positional argument: ${a}`);
    let key, value;
    if (a.includes('=')) {
      const eq = a.indexOf('=');
      key = a.slice(2, eq);
      value = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        usage(`flag --${key} expects a value`);
      }
      value = next;
      i++;
    }
    if (!KNOWN_FLAGS.has(key)) usage(`unknown flag --${key}`);
    args[key] = value;
  }
  return args;
}

function readJson(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    process.stderr.write(`error: cannot read ${p}: ${err.message}\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`error: cannot parse ${p} as JSON: ${err.message}\n`);
    process.exit(2);
  }
}

function tryReadEnvelopeRunId(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (env.isValidEnvelope(obj) && typeof obj.envelope.run_id === 'string') {
      return obj.envelope.run_id;
    }
    return null;
  } catch (_err) {
    return null;
  }
}

function splitCsv(s) {
  if (typeof s !== 'string' || s.length === 0) return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function buildPayloadFromFlags(args) {
  if (!args.trigger) usage('missing required flag --trigger (or --payload-file)');
  if (!VALID_TRIGGERS.has(args.trigger)) {
    process.stderr.write(
      `error: --trigger must be one of ${[...VALID_TRIGGERS].join(', ')}, got "${args.trigger}"\n`,
    );
    process.exit(1);
  }

  const payload = {
    schema_version: '1.0',
    compacted_at: new Date().toISOString(),
    trigger: args.trigger,
    preserved_artifact_paths: splitCsv(args.preserved),
  };
  if (args['session-id']) payload.session_id = args['session-id'];
  const discarded = splitCsv(args.discarded);
  if (discarded.length > 0) payload.discarded_artifact_paths = discarded;
  if (args['discarded-summary']) payload.discarded_summary = args['discarded-summary'];
  if (args['pre-tokens'] != null) {
    const n = Number.parseInt(args['pre-tokens'], 10);
    if (Number.isFinite(n) && n >= 0) payload.pre_compaction_tokens = n;
  }
  if (args['post-tokens'] != null) {
    const n = Number.parseInt(args['post-tokens'], 10);
    if (Number.isFinite(n) && n >= 0) payload.post_compaction_tokens = n;
  }
  if (args.strategy) {
    if (!VALID_STRATEGIES.has(args.strategy)) {
      process.stderr.write(
        `error: --strategy must be one of ${[...VALID_STRATEGIES].join(', ')}, got "${args.strategy}"\n`,
      );
      process.exit(1);
    }
    payload.compaction_strategy = args.strategy;
  }
  return payload;
}

function validateCompactionPayload(payload) {
  const errors = [];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('payload must be a non-null, non-array object');
    return errors;
  }
  for (const f of COMPACTION_REQUIRED) {
    if (!(f in payload)) errors.push(`payload missing required field "${f}"`);
  }
  if ('schema_version' in payload && payload.schema_version !== '1.0') {
    errors.push(
      `payload.schema_version must be "1.0", got ${JSON.stringify(payload.schema_version)}`,
    );
  }
  if ('trigger' in payload && !VALID_TRIGGERS.has(payload.trigger)) {
    errors.push(
      `payload.trigger must be one of ${[...VALID_TRIGGERS].join(', ')}, got ${JSON.stringify(payload.trigger)}`,
    );
  }
  if (
    'preserved_artifact_paths' in payload &&
    !Array.isArray(payload.preserved_artifact_paths)
  ) {
    errors.push('payload.preserved_artifact_paths must be array');
  }
  // R1 review C2: enforce compaction_strategy enum in --payload-file mode too
  // (buildPayloadFromFlags validates at CLI level but file-mode bypassed it).
  if ('compaction_strategy' in payload && !VALID_STRATEGIES.has(payload.compaction_strategy)) {
    errors.push(
      `payload.compaction_strategy must be one of ${[...VALID_STRATEGIES].join(', ')}, ` +
        `got ${JSON.stringify(payload.compaction_strategy)}`,
    );
  }
  return errors;
}

function atomicWriteJson(targetPath, obj) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, targetPath);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.output) usage('missing required flag --output');

  let payload;
  if (args['payload-file']) {
    const p = path.resolve(process.cwd(), args['payload-file']);
    payload = readJson(p);
  } else {
    payload = buildPayloadFromFlags(args);
  }

  const errors = validateCompactionPayload(payload);
  if (errors.length > 0) {
    process.stderr.write('compaction-state payload validation failed:\n');
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }

  let parentRunId = args['parent-run-id'] || undefined;
  const sourceArtifacts = [];
  // R1 review W1: warn on dual supply (--source-parent precedence).
  if (args['source-parent'] && args['source-evolve-receipt']) {
    process.stderr.write(
      'warning: both --source-parent and --source-evolve-receipt set; ' +
        'using --source-parent (precedence)\n',
    );
  }
  const parentFlag = args['source-parent'] || args['source-evolve-receipt'];
  if (parentFlag) {
    const srPath = path.resolve(process.cwd(), parentFlag);
    const srRunId = tryReadEnvelopeRunId(srPath);
    sourceArtifacts.push({
      path: parentFlag,
      ...(srRunId ? { run_id: srRunId } : {}),
    });
    if (!parentRunId && srRunId) parentRunId = srRunId;
    // R1 review W2: stderr-warn on invalid envelope parent.
    if (!parentRunId && !srRunId && !args['parent-run-id']) {
      process.stderr.write(
        `warning: ${args['source-parent'] ? '--source-parent' : '--source-evolve-receipt'} ` +
          `${parentFlag} is not a valid envelope (parent_run_id omitted; ` +
          `compaction-state will appear orphan in dashboard view)\n`,
      );
    }
  }

  let wrapped;
  try {
    wrapped = env.wrapEnvelope({
      artifactKind: 'compaction-state',
      payload,
      parentRunId,
      sessionId: args['session-id'] || undefined,
      sourceArtifacts,
    });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }

  const outputPath = path.resolve(process.cwd(), args.output);
  try {
    atomicWriteJson(outputPath, wrapped);
  } catch (err) {
    process.stderr.write(`error: cannot write ${outputPath}: ${err.message}\n`);
    process.exit(2);
  }

  process.stdout.write(
    `emitted: ${outputPath} (run_id=${wrapped.envelope.run_id}, trigger=${payload.trigger})\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  COMPACTION_REQUIRED,
  VALID_TRIGGERS,
  VALID_STRATEGIES,
  validateCompactionPayload,
  buildPayloadFromFlags,
  tryReadEnvelopeRunId,
};
