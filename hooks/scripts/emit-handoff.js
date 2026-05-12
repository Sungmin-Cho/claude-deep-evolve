#!/usr/bin/env node
'use strict';

/**
 * emit-handoff.js — Wrap a handoff payload in the deep-evolve M3 envelope
 * and write to disk. Primary scenario: reverse handoff (`evolve-to-deep-work`)
 * at epoch end (plateau / target reached / budget exhausted), chaining back
 * to an upstream forward handoff (`handoff_kind = "phase-5-to-evolve"`) so
 * the dashboard's `suite.handoff.roundtrip_success_rate` metric sees the
 * round-trip closed.
 *
 * Identity-triplet contract enforced by the dashboard's unwrapStrict:
 *   - envelope.producer === 'deep-evolve'
 *   - envelope.artifact_kind === 'handoff'
 *   - envelope.schema.name === 'handoff'
 *   - envelope.schema.version === '1.0'
 * Payload required fields (cf. claude-deep-suite/schemas/handoff.schema.json):
 *   schema_version, handoff_kind, from, to, summary, next_action_brief
 *
 * Cross-plugin chain (closes via envelope.parent_run_id):
 *   reverse-handoff.envelope.parent_run_id === forward-handoff.envelope.run_id
 * Set automatically when --source-parent is provided.
 *
 * Usage:
 *   node emit-handoff.js \
 *     --payload-file <path>           handoff payload JSON (built by SKILL)
 *     --output <path>                 final envelope-wrapped artifact
 *     [--source-parent <p>]           upstream envelope (forward handoff, evolve-receipt, etc) — fills parent_run_id
 *     [--source-evolve-receipt <p>]   alias for --source-parent (semantic clarity)
 *     [--source <p>]                  additional provenance entry (no chain)
 *     [--parent-run-id <ULID>]        explicit override (wins over --source-*)
 *     [--session-id <id>]             higher-level session marker
 *
 * Exit codes:
 *   0 — wrote envelope-wrapped handoff
 *   1 — payload missing required fields per handoff schema
 *   2 — usage / IO / argv error
 */

const fs = require('node:fs');
const path = require('node:path');

const env = require('./envelope');

const KNOWN_FLAGS = new Set([
  'payload-file',
  'output',
  'source-parent',
  'source-evolve-receipt',
  'source',
  'parent-run-id',
  'session-id',
]);

// Dashboard's PAYLOAD_REQUIRED_FIELDS['deep-evolve/handoff'] mirrored here.
const HANDOFF_REQUIRED = [
  'schema_version',
  'handoff_kind',
  'from',
  'to',
  'summary',
  'next_action_brief',
];

function usage(extra) {
  if (extra) process.stderr.write(`error: ${extra}\n`);
  process.stderr.write(
    'usage: emit-handoff.js --payload-file <p> --output <p>\n' +
      '                       [--source-parent <p>] [--source-evolve-receipt <p>] [--source <p>]\n' +
      '                       [--parent-run-id <ULID>] [--session-id <id>]\n',
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

function validateHandoffPayload(payload) {
  const errors = [];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('payload must be a non-null, non-array object');
    return errors;
  }
  for (const f of HANDOFF_REQUIRED) {
    if (!(f in payload)) errors.push(`payload missing required field "${f}"`);
  }
  if ('schema_version' in payload && payload.schema_version !== '1.0') {
    errors.push(
      `payload.schema_version must be "1.0", got ${JSON.stringify(payload.schema_version)}`,
    );
  }
  if (
    'from' in payload &&
    (payload.from === null ||
      typeof payload.from !== 'object' ||
      Array.isArray(payload.from) ||
      typeof payload.from.producer !== 'string' ||
      typeof payload.from.completed_at !== 'string')
  ) {
    errors.push('payload.from must include string producer + completed_at');
  }
  if (
    'to' in payload &&
    (payload.to === null ||
      typeof payload.to !== 'object' ||
      Array.isArray(payload.to) ||
      typeof payload.to.producer !== 'string' ||
      typeof payload.to.intent !== 'string')
  ) {
    errors.push('payload.to must include string producer + intent');
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
  for (const r of ['payload-file', 'output']) {
    if (!args[r]) usage(`missing required flag --${r}`);
  }

  const payloadPath = path.resolve(process.cwd(), args['payload-file']);
  const outputPath = path.resolve(process.cwd(), args['output']);
  const payload = readJson(payloadPath);

  const errors = validateHandoffPayload(payload);
  if (errors.length > 0) {
    process.stderr.write('handoff payload validation failed:\n');
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }

  let parentRunId = args['parent-run-id'] || undefined;
  const sourceArtifacts = [];

  // --source-parent and --source-evolve-receipt are functional aliases (the
  // latter exists for semantic clarity in receipts that chain to upstream
  // evolve-receipts rather than handoffs).
  const parentFlag = args['source-parent'] || args['source-evolve-receipt'];
  if (parentFlag) {
    const srPath = path.resolve(process.cwd(), parentFlag);
    const srRunId = tryReadEnvelopeRunId(srPath);
    sourceArtifacts.push({
      path: parentFlag,
      ...(srRunId ? { run_id: srRunId } : {}),
    });
    if (!parentRunId && srRunId) parentRunId = srRunId;
  }

  if (args.source) {
    sourceArtifacts.push({ path: args.source });
  }

  let wrapped;
  try {
    wrapped = env.wrapEnvelope({
      artifactKind: 'handoff',
      payload,
      parentRunId,
      sessionId: args['session-id'] || undefined,
      sourceArtifacts,
    });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }

  try {
    atomicWriteJson(outputPath, wrapped);
  } catch (err) {
    process.stderr.write(`error: cannot write ${outputPath}: ${err.message}\n`);
    process.exit(2);
  }

  process.stdout.write(
    `emitted: ${outputPath} (run_id=${wrapped.envelope.run_id}, parent_run_id=${
      wrapped.envelope.parent_run_id || '∅'
    })\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  HANDOFF_REQUIRED,
  validateHandoffPayload,
  tryReadEnvelopeRunId,
};
