#!/usr/bin/env node
'use strict';

/**
 * wrap-evolve-envelope.js — CLI to wrap a deep-evolve payload (evolve-receipt
 * or evolve-insights) in the M3 cross-plugin envelope (cf. claude-deep-suite/
 * docs/envelope-migration.md §1).
 *
 * Designed to be called from markdown agent prompts (skills/deep-evolve-workflow/
 * protocols/{completion,transfer}.md) via the Bash tool. The agent writes the
 * domain payload to a temp file, then invokes this helper to produce the final
 * artifact at the canonical path.
 *
 * Usage:
 *   node wrap-evolve-envelope.js \
 *     --artifact-kind <evolve-receipt|evolve-insights> \
 *     --payload-file <path-to-payload.json> \
 *     --output <path-to-final-artifact.json> \
 *     [--parent-run-id <ULID>] \
 *     [--session-id <id>] \
 *     [--source-recurring-findings <path>] (evolve-receipt only — chains parent_run_id)
 *     [--source-artifact <path[:run_id]>]   (repeatable — generic source ref)
 *
 * Cross-plugin chain semantics (handoff §3.3):
 *   - evolve-receipt: parent_run_id := <recurring-findings envelope.run_id>
 *     when --source-recurring-findings points at an envelope-wrapped
 *     deep-review recurring-findings file. The recurring-findings path is
 *     also added to provenance.source_artifacts[] with its run_id.
 *   - evolve-insights: multi-source aggregator — parent_run_id is omitted by
 *     default; only --source-artifact entries land in source_artifacts.
 *
 * Exit codes:
 *   0 — wrote envelope-wrapped artifact
 *   2 — usage / IO / argv error
 *
 * Self-contained: no external deps. The envelope shape is enforced by the
 * companion validator (scripts/validate-envelope-emit.js).
 */

const fs = require('node:fs');
const path = require('node:path');

const env = require('./envelope');

function usage(extra) {
  if (extra) process.stderr.write(`error: ${extra}\n`);
  process.stderr.write(
    'usage: wrap-evolve-envelope.js --artifact-kind <evolve-receipt|evolve-insights>\n' +
      '                                --payload-file <payload.json>\n' +
      '                                --output <artifact.json>\n' +
      '                                [--parent-run-id <ULID>]\n' +
      '                                [--session-id <id>]\n' +
      '                                [--source-recurring-findings <path>]\n' +
      '                                [--source-artifact <path[:run_id]>] (repeatable)\n',
  );
  process.exit(2);
}

const SINGLE_VALUE_FLAGS = new Set([
  'artifact-kind',
  'payload-file',
  'output',
  'parent-run-id',
  'session-id',
  'source-recurring-findings',
]);
const REPEATABLE_FLAGS = new Set(['source-artifact']);
const KNOWN_FLAGS = new Set([...SINGLE_VALUE_FLAGS, ...REPEATABLE_FLAGS]);

function parseArgs(argv) {
  const args = {};
  const repeats = {};
  for (const f of REPEATABLE_FLAGS) repeats[f] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      usage(`unexpected positional argument: ${a}`);
    }
    let key;
    let value;
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
    if (!KNOWN_FLAGS.has(key)) {
      usage(`unknown flag --${key}`);
    }
    if (REPEATABLE_FLAGS.has(key)) {
      repeats[key].push(value);
    } else {
      args[key] = value;
    }
  }
  for (const f of REPEATABLE_FLAGS) {
    if (repeats[f].length > 0) args[f] = repeats[f];
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

/**
 * Strict-gated extraction of envelope.run_id (handoff §4 W4 lesson).
 *
 * Uses isValidEnvelope (loose detection + payload non-null/non-array object)
 * to reject corrupt envelopes from contributing chain trace data. A loose
 * isEnvelope check would let `payload: null` pass and downstream readers
 * would chase a broken chain.
 */
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

/**
 * Parse `--source-artifact path[:run_id]` value. The run_id portion is
 * optional and skipped if not a valid ULID (defense against typos / paths
 * containing colons). Returns { path, run_id? } or null on empty path.
 */
function parseSourceArtifactSpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0) return null;
  // Find LAST colon to allow drive letters / URL-like paths in path portion.
  const lastColon = spec.lastIndexOf(':');
  if (lastColon === -1) {
    return { path: spec };
  }
  const candidate = spec.slice(lastColon + 1);
  if (env.ULID_RE.test(candidate)) {
    return { path: spec.slice(0, lastColon), run_id: candidate };
  }
  return { path: spec };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ['artifact-kind', 'payload-file', 'output'];
  for (const r of required) {
    if (!args[r]) usage(`missing required flag --${r}`);
  }

  const artifactKind = args['artifact-kind'];
  if (!env.ALLOWED_ARTIFACT_KINDS.has(artifactKind)) {
    usage(
      `--artifact-kind must be one of ${[...env.ALLOWED_ARTIFACT_KINDS].join(', ')}, got "${artifactKind}"`,
    );
  }

  const payloadPath = path.resolve(process.cwd(), args['payload-file']);
  const outputPath = path.resolve(process.cwd(), args['output']);

  const payload = readJson(payloadPath);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    process.stderr.write(
      `error: payload at ${payloadPath} must be a non-null, non-array object\n`,
    );
    process.exit(2);
  }

  // Cross-plugin chain harvest.
  const sourceArtifacts = [];
  let parentRunId = args['parent-run-id'] || undefined;

  // evolve-receipt: deep-review recurring-findings → parent_run_id chain.
  if (args['source-recurring-findings']) {
    if (artifactKind !== 'evolve-receipt') {
      process.stderr.write(
        `warning: --source-recurring-findings is only meaningful for evolve-receipt; ignoring for ${artifactKind}\n`,
      );
    } else {
      const recPath = path.resolve(process.cwd(), args['source-recurring-findings']);
      const recRunId = tryReadEnvelopeRunId(recPath);
      sourceArtifacts.push({
        path: args['source-recurring-findings'],
        ...(recRunId ? { run_id: recRunId } : {}),
      });
      if (!parentRunId && recRunId) {
        parentRunId = recRunId;
      }
    }
  }

  // Generic --source-artifact entries (repeatable).
  if (Array.isArray(args['source-artifact'])) {
    for (const spec of args['source-artifact']) {
      const parsed = parseSourceArtifactSpec(spec);
      if (parsed) sourceArtifacts.push(parsed);
    }
  }

  let wrapped;
  try {
    wrapped = env.wrapEnvelope({
      artifactKind,
      payload,
      parentRunId,
      sessionId: args['session-id'] || undefined,
      sourceArtifacts,
    });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (err) {
      process.stderr.write(`error: cannot mkdir ${outDir}: ${err.message}\n`);
      process.exit(2);
    }
  }

  // C1 (round 1) — Atomic write: write to a unique temp path then rename.
  // Mid-write interruption (Ctrl-C, OOM, hook timeout) or two concurrent
  // finishers must not leave a truncated artifact that downstream readers
  // (session-helper.sh cmd_append_meta_archive_local, deep-work
  // gather-signals.sh) parse-fail on. Mirrors the temp+rename pattern used
  // by deep-work hooks/scripts/wrap-receipt-envelope.js.
  const tmpPath = `${outputPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(wrapped, null, 2) + '\n', 'utf8');
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    process.stderr.write(`error: cannot write ${tmpPath}: ${err.message}\n`);
    process.exit(2);
  }
  try {
    fs.renameSync(tmpPath, outputPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    process.stderr.write(`error: cannot rename ${tmpPath} → ${outputPath}: ${err.message}\n`);
    process.exit(2);
  }

  process.stdout.write(
    `wrapped: ${outputPath} (run_id=${wrapped.envelope.run_id}, artifact_kind=${wrapped.envelope.artifact_kind})\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { parseSourceArtifactSpec, tryReadEnvelopeRunId };
