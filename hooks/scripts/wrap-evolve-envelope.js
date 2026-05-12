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

    // Round-1 deep-review W3 (Opus): boundary validation. Reject malformed
    // values at the CLI layer rather than deferring to downstream consumers.
    if (key === 'parent-run-id' && !env.ULID_RE.test(value)) {
      usage(
        `--parent-run-id must be 26-char Crockford Base32 ULID, got "${value}"`,
      );
    }
    if (
      (key === 'session-id' ||
        key === 'source-recurring-findings' ||
        key === 'payload-file' ||
        key === 'output' ||
        key === 'artifact-kind') &&
      value.length === 0
    ) {
      usage(`--${key} value must be non-empty`);
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
 * Strict-gated extraction of envelope.run_id with identity verification.
 *
 * Round-1 deep-review C2 (Codex adversarial high): the prior loose form
 * accepted any envelope-shaped file's run_id, so a foreign-producer
 * envelope at e.g. `.deep-review/recurring-findings.json` would silently
 * chain into evolve-receipt's parent_run_id, corrupting M4 telemetry.
 *
 * Identity contract:
 *   - With { producer, artifactKind } → strict 3-way check + ULID format.
 *   - With { selfConsistent: true } → producer === schema.name ===
 *     artifact_kind self-consistency + ULID format. Used for generic
 *     auto-harvest from --source-artifact path-only entries: we don't
 *     know which producer to expect, but we require the file to be
 *     internally consistent (no half-formed envelopes contributing
 *     trace data).
 *
 * Returns the envelope.run_id when all gates pass, null otherwise.
 * Builds atop env.isValidEnvelope (loose envelope detection + payload
 * non-null/non-array object — handoff §4 W4 lesson).
 */
function tryReadEnvelopeRunId(filePath, opts) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
  if (!env.isValidEnvelope(obj)) return null;
  const e = obj.envelope;
  if (typeof e.run_id !== 'string' || !env.ULID_RE.test(e.run_id)) return null;
  if (!e.schema || typeof e.schema !== 'object' || Array.isArray(e.schema)) return null;

  if (opts && opts.producer !== undefined) {
    if (
      e.producer !== opts.producer ||
      e.artifact_kind !== opts.artifactKind ||
      e.schema.name !== opts.artifactKind
    ) {
      return null;
    }
  } else if (opts && opts.selfConsistent === true) {
    // Self-consistency: producer/artifact_kind/schema.name must agree.
    // Doesn't bind to a specific producer (unknown for generic
    // --source-artifact auto-harvest), but requires the envelope to be
    // internally well-formed.
    if (
      typeof e.producer !== 'string' ||
      typeof e.artifact_kind !== 'string' ||
      e.artifact_kind !== e.schema.name
    ) {
      return null;
    }
  } else {
    // No identity gate provided — refuse to extract. Forces caller
    // intent. Defense against future regression where a new code path
    // forgets the identity gate.
    return null;
  }

  return e.run_id;
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
  // R2 review fix (Codex adversarial HIGH): restrict this legacy wrapper to its
  // original 2 artifact kinds. envelope.js#ALLOWED_ARTIFACT_KINDS was extended
  // in v3.3.0 to also include 'handoff' and 'compaction-state'; without this
  // guard, wrap-evolve-envelope.js could mint envelope-valid but domain-invalid
  // handoff/compaction-state artifacts (it lacks payload-required-field
  // validation for those kinds). Force callers to use the dedicated
  // emit-handoff.js / emit-compaction-state.js helpers.
  const LEGACY_EVOLVE_KINDS = new Set(['evolve-receipt', 'evolve-insights']);
  if (!LEGACY_EVOLVE_KINDS.has(artifactKind)) {
    usage(
      `--artifact-kind must be one of ${[...LEGACY_EVOLVE_KINDS].join(', ')}, got "${artifactKind}" ` +
        '(use emit-handoff.js / emit-compaction-state.js for handoff/compaction-state)',
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

  // deep-review recurring-findings → identity-checked extraction.
  // Round-1 deep-review C2 (Codex adversarial): tryReadEnvelopeRunId now
  // requires identity gate. Pass {producer, artifactKind} so a foreign
  // envelope at the recurring-findings path is rejected (returns null →
  // path-only source_artifact, no parent_run_id chain).
  //
  // Round-1 deep-review I3 (Opus): symmetric for evolve-insights — record
  // path + run_id without setting parent_run_id (multi-source aggregator
  // semantics).
  if (args['source-recurring-findings']) {
    const recPath = path.resolve(process.cwd(), args['source-recurring-findings']);
    const recRunId = tryReadEnvelopeRunId(recPath, {
      producer: 'deep-review',
      artifactKind: 'recurring-findings',
    });
    sourceArtifacts.push({
      path: args['source-recurring-findings'],
      ...(recRunId ? { run_id: recRunId } : {}),
    });
    if (artifactKind === 'evolve-receipt' && !parentRunId && recRunId) {
      parentRunId = recRunId;
    }
  }

  // Generic --source-artifact entries (repeatable).
  // Round-1 deep-review W4 (Codex adversarial medium): for path-only
  // entries (no `:run_id` suffix), auto-harvest the envelope's run_id IF
  // the file at path is a self-consistent envelope (producer ===
  // schema.name === artifact_kind, valid ULID). This restores the
  // multi-source trace that transfer.md's `--source-artifact $REC_PATH`
  // was silently losing. Caller can override by passing `path:run_id`
  // explicitly.
  if (Array.isArray(args['source-artifact'])) {
    for (const spec of args['source-artifact']) {
      const parsed = parseSourceArtifactSpec(spec);
      if (!parsed) continue;
      if (!parsed.run_id) {
        // Auto-harvest with self-consistency check.
        const abs = path.isAbsolute(parsed.path)
          ? parsed.path
          : path.resolve(process.cwd(), parsed.path);
        const harvested = tryReadEnvelopeRunId(abs, { selfConsistent: true });
        if (harvested) {
          parsed.run_id = harvested;
        }
      }
      sourceArtifacts.push(parsed);
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
