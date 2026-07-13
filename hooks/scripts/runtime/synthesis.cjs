'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteFile, withDirectoryLock } = require('./session-store.cjs');
const { migrateV2Weights } = require('./scheduler.cjs');
const { wrapEvolveArtifact } = require('../wrap-evolve-envelope.js');

const SIMILARITY_THRESHOLD = 0.70;
const MAX_RETRIES = 2;
const BETA_FIELDS = ['seed_id', 'direction', 'hypothesis', 'rationale'];
const SYNTHESIS_INTERACTION_CHOICES = new Set([
  'accept-regression',
  'keep-baseline',
  'stop',
]);
const SYNTHESIS_FALLBACK_CLASSIFICATIONS = new Set([
  'keep-baseline',
  'automatic-fallback',
  'no-baseline',
]);

function runtimeError(code, message, rc = 2, details) {
  return Object.assign(new Error(message), { code, rc, ...(details === undefined ? {} : { details }) });
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requireObject(value, label) {
  if (!plainObject(value)) throw runtimeError('invalid_object', `${label} must be a JSON object`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw runtimeError('invalid_array', `${label} must be a list`);
  return value;
}

function requireInteger(value, label, { positive = false, nonnegative = false } = {}) {
  if (!Number.isInteger(value) || (positive && value <= 0) || (nonnegative && value < 0)) {
    throw runtimeError('invalid_integer', `${label} must be ${positive ? 'a positive' : nonnegative ? 'a non-negative' : 'an'} integer`);
  }
  return value;
}

function requireNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw runtimeError('invalid_number', `${label} must be a finite number`);
  return value;
}

function validateSynthesisChoice(value, usage) {
  if (usage === 'finalize') {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !SYNTHESIS_INTERACTION_CHOICES.has(value)) {
      throw runtimeError('invalid_synthesis_choice',
        'user_choice must be accept-regression, keep-baseline, or stop');
    }
    return value;
  }
  if (usage === 'fallback-note') {
    if (typeof value !== 'string' || !SYNTHESIS_FALLBACK_CLASSIFICATIONS.has(value)) {
      throw runtimeError('invalid_synthesis_classification',
        'user_choice must be keep-baseline, automatic-fallback, or no-baseline');
    }
    return value;
  }
  throw runtimeError('invalid_synthesis_choice_usage',
    'synthesis choice usage must be finalize or fallback-note');
}

function processBeta(n, payload) {
  requireInteger(n, 'n', { positive: true });
  if (n === 1) {
    return {
      skipped: true,
      reason: 'N=1 short-circuit (§ 5.1a)',
      directions: [],
      retries_used: 0,
      max_similarity_observed: 0,
      warning_emitted: null,
    };
  }
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); }
    catch { throw runtimeError('invalid_json', `input is not valid JSON for N=${n}`); }
  }
  requireObject(payload, 'input');
  if (n <= 4) {
    requireArray(payload.directions, 'directions');
    return {
      skipped: false,
      directions: payload.directions,
      retries_used: 0,
      max_similarity_observed: 0,
      warning_emitted: null,
    };
  }
  const attempts = requireArray(payload.attempts, 'attempts');
  if (attempts.length === 0) throw runtimeError('attempts_empty', `N=${n} payload missing non-empty attempts list`);
  let best = null;
  let validCount = 0;
  for (const attempt of attempts) {
    if (!plainObject(attempt) || !Array.isArray(attempt.directions)
        || typeof attempt.max_similarity !== 'number' || !Number.isFinite(attempt.max_similarity)) continue;
    validCount += 1;
    const similarity = Number(attempt.max_similarity);
    if (similarity <= SIMILARITY_THRESHOLD) {
      return {
        skipped: false,
        directions: attempt.directions,
        retries_used: validCount - 1,
        max_similarity_observed: similarity,
        warning_emitted: null,
      };
    }
    if (!best || similarity < Number(best.max_similarity)) best = attempt;
    if (validCount >= 1 + MAX_RETRIES) break;
  }
  if (!best) throw runtimeError('attempts_malformed', `N=${n}: all ${attempts.length} attempts were malformed`);
  return {
    skipped: false,
    directions: best.directions,
    retries_used: MAX_RETRIES,
    max_similarity_observed: Number(best.max_similarity),
    warning_emitted: 'beta_diversity_warning',
  };
}

function processBetaGrowth(existing, payload) {
  requireArray(existing, 'existing seeds');
  requireObject(payload, 'growth input');
  const attempts = requireArray(payload.attempts, 'growth attempts');
  if (attempts.length === 0) throw runtimeError('attempts_empty', 'growth attempts must be non-empty');
  let best = null;
  let validCount = 0;
  for (const attempt of attempts) {
    if (!plainObject(attempt) || !plainObject(attempt.direction)
        || typeof attempt.max_similarity_to_existing !== 'number'
        || !Number.isFinite(attempt.max_similarity_to_existing)) continue;
    validCount += 1;
    const similarity = Number(attempt.max_similarity_to_existing);
    if (similarity <= SIMILARITY_THRESHOLD) {
      return {
        direction: attempt.direction,
        retries_used: validCount - 1,
        max_similarity_observed: similarity,
        warning_emitted: null,
        warning_context: null,
      };
    }
    if (!best || similarity < Number(best.max_similarity_to_existing)) best = attempt;
    if (validCount >= 1 + MAX_RETRIES) break;
  }
  if (!best) throw runtimeError('attempts_malformed', `growth: all ${attempts.length} attempts were malformed`);
  return {
    direction: best.direction,
    retries_used: MAX_RETRIES,
    max_similarity_observed: Number(best.max_similarity_to_existing),
    warning_emitted: 'beta_diversity_warning',
    warning_context: 'epoch_growth',
  };
}

function validateBaselineSeeds(payload) {
  requireObject(payload, 'baseline payload');
  const seeds = requireArray(payload.seeds, 'seeds');
  for (const [index, seed] of seeds.entries()) {
    requireObject(seed, `seeds[${index}]`);
    for (const key of ['id', 'status', 'killed_reason', 'final_q', 'keeps', 'borrows_received']) {
      if (!Object.hasOwn(seed, key)) throw runtimeError('missing_field', `seeds[${index}] missing required field ${key}`);
    }
    requireInteger(seed.id, `seeds[${index}].id`, { positive: true });
    if (typeof seed.status !== 'string') throw runtimeError('invalid_status', `seeds[${index}].status must be string`);
    if (seed.killed_reason !== null && typeof seed.killed_reason !== 'string') {
      throw runtimeError('invalid_killed_reason', `seeds[${index}].killed_reason must be string or null`);
    }
    requireNumber(seed.final_q, `seeds[${index}].final_q`);
    requireInteger(seed.keeps, `seeds[${index}].keeps`, { nonnegative: true });
    requireInteger(seed.borrows_received, `seeds[${index}].borrows_received`, { nonnegative: true });
  }
  return seeds;
}

function selectWithTiebreak(candidates) {
  if (candidates.length === 0) return { chosen: null, ties: [] };
  let pool = candidates.filter((seed) => seed.final_q === Math.max(...candidates.map((item) => item.final_q)));
  if (pool.length === 1) return { chosen: pool[0], ties: ['final_q'] };
  pool = pool.filter((seed) => seed.keeps === Math.max(...pool.map((item) => item.keeps)));
  if (pool.length === 1) return { chosen: pool[0], ties: ['final_q', 'keeps'] };
  pool = pool.filter((seed) => seed.borrows_received === Math.min(...pool.map((item) => item.borrows_received)));
  if (pool.length === 1) return { chosen: pool[0], ties: ['final_q', 'keeps', 'borrows_received'] };
  pool.sort((left, right) => left.id - right.id);
  return { chosen: pool[0], ties: ['final_q', 'keeps', 'borrows_received', 'seed_id'] };
}

function selectBaseline(payload) {
  const seeds = validateBaselineSeeds(payload);
  let candidates = seeds.filter((seed) => ['active', 'completed_early'].includes(seed.status) && seed.final_q > 0);
  let tier = 'preferred';
  if (candidates.length === 0) {
    candidates = seeds.filter((seed) => seed.killed_reason !== 'shortcut_quarantine'
      && seed.status !== 'killed_shortcut_quarantine' && seed.final_q > 0);
    tier = 'non_quarantine_fallback';
  }
  if (candidates.length === 0) {
    candidates = seeds.filter((seed) => seed.keeps >= 1);
    tier = 'best_effort';
  }
  if (candidates.length === 0) tier = 'no_baseline';
  const { chosen, ties } = selectWithTiebreak(candidates);
  const chosenId = chosen ? chosen.id : null;
  return {
    chosen_seed_id: chosenId,
    tier,
    ties_broken_on: ties,
    candidates_count: candidates.length,
    baseline_selection_reasoning: { chosen_seed_id: chosenId, tier, ties_broken_on: ties },
  };
}

const SEED_POLICY_REF = 'agents/evolve-seed.md';
const SEED_FIRST_ACTIONS = Object.freeze(['read-policy', 'verify-worktree']);
const SEED_RUNTIME_OPERATIONS = Object.freeze([
  'coord.tail-forum',
  'session.finish-experiment',
  'scheduler.borrow-preflight',
  'harness.run',
]);
const SEED_FINAL_RESPONSE_FIELDS = Object.freeze([
  'experiments_executed',
  'commits',
  'final_q',
  'forum_events_appended',
  'borrows_planned',
  'borrows_executed',
  'status',
  'notes',
]);
const SEED_DISPATCH_INPUT_FIELDS = new Set([
  'project_root', 'session_root', 'session', 'events',
  'session_id', 'seed_id', 'block_id', 'decision_id', 'n_block',
]);
const SEED_DISPATCH_REQUIRED_FIELDS = new Set([
  'project_root', 'session_root', 'session', 'events',
  'seed_id', 'block_id', 'decision_id', 'n_block',
]);

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw runtimeError('invalid_string', `${label} must be a non-empty string`);
  }
  return value;
}

function requireSafePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw runtimeError('invalid_integer', `${label} must be a positive safe integer`);
  }
  return value;
}

function platformPath(platform) {
  if (platform === 'win32') return path.win32;
  if (platform === 'posix') return path.posix;
  throw runtimeError('invalid_platform', 'platform must be win32 or posix');
}

function requireCanonicalAbsolute(value, label, pathApi) {
  requireNonEmptyString(value, label);
  if (value.includes('\0') || !pathApi.isAbsolute(value) || pathApi.normalize(value) !== value) {
    throw runtimeError('seed_worktree_path_invalid', `${label} must be a normalized absolute path`);
  }
  return value;
}

function pathWithin(pathApi, parent, candidate) {
  const relative = pathApi.relative(parent, candidate);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}

function findDispatchSchedule(events, requested) {
  requireArray(events, 'events');
  const blocks = new Set();
  const decisions = new Set();
  let matched = null;
  let terminal = false;
  for (const event of events) {
    if (!plainObject(event)) {
      throw runtimeError('seed_dispatch_authority_conflict',
        'canonical journal contains a non-object event');
    }
    if (event.event === 'seed_scheduled') {
      if (typeof event.block_id !== 'string' || event.block_id.length === 0
          || typeof event.decision_id !== 'string' || event.decision_id.length === 0
          || blocks.has(event.block_id) || decisions.has(event.decision_id)) {
        throw runtimeError('seed_dispatch_authority_conflict',
          'canonical seed schedule identity is malformed or duplicated');
      }
      blocks.add(event.block_id);
      decisions.add(event.decision_id);
      if (event.block_id === requested.block_id) matched = event;
    } else if ((event.event === 'seed_block_completed'
        || event.event === 'seed_block_failed') && event.block_id === requested.block_id) {
      terminal = true;
    }
  }
  if (!matched || terminal
      || matched.decision_id !== requested.decision_id
      || matched.seed_id !== requested.seed_id
      || matched.block_size !== requested.n_block
      || matched.epoch !== requested.epoch) {
    throw runtimeError('seed_dispatch_authority_conflict',
      'requested seed block differs from canonical in-flight schedule', 1);
  }
  return matched;
}

function buildSeedDispatchContext(args, options = {}) {
  requireObject(args, 'seed dispatch args');
  for (const key of Object.keys(args)) {
    if (!SEED_DISPATCH_INPUT_FIELDS.has(key)) {
      throw runtimeError('unknown_field', `unknown seed dispatch arg ${JSON.stringify(key)}`);
    }
  }
  for (const key of SEED_DISPATCH_REQUIRED_FIELDS) {
    if (!Object.hasOwn(args, key)) {
      throw runtimeError('missing_field', `missing required seed dispatch arg ${key}`);
    }
  }

  const platform = options.platform || (process.platform === 'win32' ? 'win32' : 'posix');
  const pathApi = platformPath(platform);
  const projectRoot = requireCanonicalAbsolute(args.project_root, 'project_root', pathApi);
  const sessionRoot = requireCanonicalAbsolute(args.session_root, 'session_root', pathApi);
  const session = requireObject(args.session, 'session');
  const sessionId = requireNonEmptyString(
    args.session_id === undefined ? session.session_id : args.session_id,
    'session_id',
  );
  const seedId = requireSafePositiveInteger(args.seed_id, 'seed_id');
  const blockId = requireNonEmptyString(args.block_id, 'block_id');
  const decisionId = requireNonEmptyString(args.decision_id, 'decision_id');
  const nBlock = requireSafePositiveInteger(args.n_block, 'n_block');
  if (session.session_id !== sessionId) {
    throw runtimeError('session_identity_mismatch',
      'canonical session identity differs from dispatch request');
  }
  if (!new Set(['cli', 'protocol']).has(session.eval_mode)) {
    throw runtimeError('seed_dispatch_authority_conflict',
      'canonical session evaluation mode is unsupported');
  }
  const epoch = session.evaluation_epoch && session.evaluation_epoch.current;
  requireSafePositiveInteger(epoch, 'evaluation_epoch.current');
  const stateRoot = pathApi.join(projectRoot, '.deep-evolve');
  if (!pathWithin(pathApi, stateRoot, sessionRoot)) {
    throw runtimeError('seed_worktree_path_invalid',
      'canonical session root must remain below the project state root');
  }
  const virtual = requireObject(session.virtual_parallel, 'session.virtual_parallel');
  const seeds = requireArray(virtual.seeds, 'session.virtual_parallel.seeds');
  const matches = seeds.filter((seed) => plainObject(seed) && seed.id === seedId);
  if (matches.length === 0) {
    throw runtimeError('seed_not_found', `canonical seed ${seedId} is missing`, 1);
  }
  if (matches.length !== 1) {
    throw runtimeError('seed_dispatch_authority_conflict',
      `canonical seed ${seedId} is duplicated`);
  }
  const seed = matches[0];
  if (session.status !== 'active') {
    throw runtimeError('session_not_active', 'seed dispatch requires an active session', 1);
  }
  if (seed.status !== 'active') {
    throw runtimeError('seed_not_active', `canonical seed ${seedId} is terminal`, 1);
  }
  const worktreePath = requireCanonicalAbsolute(
    seed.worktree_path, 'seed.worktree_path', pathApi,
  );
  const expectedWorktree = pathApi.join(sessionRoot, 'worktrees', `seed_${seedId}`);
  if (worktreePath !== expectedWorktree || !pathWithin(pathApi, sessionRoot, worktreePath)) {
    throw runtimeError('seed_worktree_path_invalid',
      'canonical seed worktree differs from its derived session path');
  }
  const expectedBranch = `evolve/${sessionId}/seed-${seedId}`;
  if (seed.branch !== expectedBranch) {
    throw runtimeError('seed_branch_invalid',
      'canonical seed branch differs from its derived identity');
  }
  findDispatchSchedule(args.events, {
    block_id: blockId,
    decision_id: decisionId,
    seed_id: seedId,
    n_block: nBlock,
    epoch,
  });

  return {
    schema_version: '1.0',
    policy_ref: SEED_POLICY_REF,
    project_root: projectRoot,
    session_id: sessionId,
    session_root: sessionRoot,
    seed_id: seedId,
    worktree_path: worktreePath,
    branch: expectedBranch,
    block: {
      block_id: blockId,
      decision_id: decisionId,
      experiments: nBlock,
    },
    first_actions: [...SEED_FIRST_ACTIONS],
    runtime_operations: [...SEED_RUNTIME_OPERATIONS],
    final_response_schema: { required: [...SEED_FINAL_RESPONSE_FIELDS] },
  };
}

function buildSeedPrompt(args, options = {}) {
  return buildSeedDispatchContext(args, options);
}

function betaPrefix(beta) {
  const missing = BETA_FIELDS.filter((field) => !Object.hasOwn(beta, field));
  if (missing.length > 0) throw runtimeError('beta_missing_fields', `beta missing required fields: ${JSON.stringify(missing)}`);
  return `## Initial Research Direction (seed-specific)\n\n**Seed ID**: ${beta.seed_id}\n**Direction**: ${beta.direction}\n**Hypothesis**: ${beta.hypothesis}\n**Rationale**: ${beta.rationale}\n\nThis direction is 'intentionally ambiguous' (AAR methodology):\nuse it to bias exploration, not as a rigid constraint. Other seeds\nexplore different directions in parallel; see forum.jsonl for cross-seed context.\n\n---\n\n`;
}

function regularFile(filePath, label) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch { throw runtimeError(`${label}_missing`, `${label} not found: ${filePath}`); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw runtimeError(`${label}_invalid`, `${label} must be a regular file: ${filePath}`);
  return fs.readFileSync(filePath);
}

function regularDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw runtimeError(`${label}_invalid`, `${label} must be a regular directory: ${directory}`);
  return directory;
}

function writeSeedProgram({ baseProgramPath, worktreePath, beta }) {
  const base = regularFile(baseProgramPath, 'base program');
  regularDirectory(worktreePath, 'worktree');
  const outputPath = path.join(worktreePath, 'program.md');
  const bytes = beta === null ? base : Buffer.concat([Buffer.from(betaPrefix(requireObject(beta, 'beta'))), base]);
  atomicWriteFile(outputPath, bytes);
  return { output_path: outputPath, bytes: bytes.length, beta_applied: beta !== null };
}

function keySort(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return compareText(left, right);
}

function compareText(left, right) {
  const a = Array.from(String(left), (value) => value.codePointAt(0));
  const b = Array.from(String(right), (value) => value.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (value === true) return 'True';
  if (value === false) return 'False';
  return String(value);
}

function renderForumSummary(events, generation) {
  requireArray(events, 'forum events');
  requireInteger(generation, 'generation');
  const stats = new Map();
  const bucket = (id) => {
    if (!stats.has(id)) stats.set(id, { keeps: [], discards: [], borrows_given: [], borrows_received: [] });
    return stats.get(id);
  };
  for (const event of events) {
    if (!plainObject(event)) continue;
    if (event.event === 'seed_keep' && event.seed_id !== undefined) bucket(event.seed_id).keeps.push(event);
    else if (event.event === 'seed_discard' && event.seed_id !== undefined) bucket(event.seed_id).discards.push(event);
    else if (event.event === 'cross_seed_borrow' && event.from_seed !== undefined && event.to_seed !== undefined) {
      bucket(event.from_seed).borrows_given.push(event);
      bucket(event.to_seed).borrows_received.push(event);
    }
  }
  const convergence = events.filter((event) => plainObject(event) && event.event === 'convergence_event');
  const lines = [`# Generation ${generation} Forum Summary`, ''];
  if (stats.size === 0 && convergence.length === 0) return `${lines.join('\n')}_no events recorded this epoch_`;
  for (const id of [...stats.keys()].sort(keySort)) {
    const value = stats.get(id);
    lines.push(`## Seed-${id}`, `- ${value.keeps.length} keeps, ${value.discards.length} discards`);
    for (const keep of value.keeps.slice(0, 3)) {
      const description = keep.description === undefined ? '(no description)' : keep.description;
      const delta = keep.score_delta === undefined ? '?' : keep.score_delta;
      const commit = keep.commit || '????????';
      lines.push(`  - keep ${String(commit).slice(0, 8)}: ${description} (Δ=${delta})`);
    }
    const given = value.borrows_given.map((event) => `to seed-${event.to_seed}`).join(', ');
    const received = value.borrows_received.map((event) => `from seed-${event.from_seed}`).join(', ');
    lines.push(`- Borrow given: ${value.borrows_given.length}${given ? ` (${given})` : ''}`);
    lines.push(`- Borrow received: ${value.borrows_received.length}${received ? ` (${received})` : ''}`, '');
  }
  if (convergence.length > 0) {
    lines.push('## Convergence Events');
    for (const event of convergence) {
      const ids = (Array.isArray(event.seed_ids) ? event.seed_ids : []).map((id) => `seed-${id}`).join(', ');
      lines.push(`- ${ids}: direction=${pyRepr(event.direction)}, judged_as=${event.judged_as === undefined ? 'undefined' : event.judged_as}`);
    }
  }
  return lines.join('\n');
}

function renderCrossSeedAudit(forumEvents, journalEvents, warnings = []) {
  requireArray(forumEvents, 'forum events');
  requireArray(journalEvents, 'journal events');
  const distinct = new Set(journalEvents.filter((event) => plainObject(event) && event.event === 'seed_initialized' && event.seed_id !== undefined)
    .map((event) => event.seed_id));
  if (distinct.size === 1) {
    return { markdown: '# Cross-Seed Audit\n\n## Status\n\n**N/A — single seed session.** Cross-seed exchanges, convergence events, and inter-seed borrows do not apply when N=1. See `seed_reports/seed_<k>.md` for this seed\'s individual journey.\n\n## Borrow Matrix\n\n_N/A — single seed session._\n\n## Convergence Events\n\n_N/A — single seed session._\n\n## Per-Seed Forum Activity\n\n_N/A — single seed session._\n', warnings };
  }
  const matrix = new Map();
  const convergence = new Map();
  const activity = new Map();
  const touch = (id) => {
    if (!activity.has(id)) activity.set(id, { keeps: 0, discards: 0, borrows_given: 0, borrows_received: 0, convergence_participations: 0 });
    return activity.get(id);
  };
  for (const event of forumEvents) {
    if (!plainObject(event)) continue;
    if (event.event === 'seed_keep' && event.seed_id !== undefined) touch(event.seed_id).keeps += 1;
    else if (event.event === 'seed_discard' && event.seed_id !== undefined) touch(event.seed_id).discards += 1;
    else if (event.event === 'cross_seed_borrow') {
      const from = event.from_seed;
      const to = event.to_seed;
      if (from === undefined || to === undefined || from === to) continue;
      const key = JSON.stringify([from, to]);
      matrix.set(key, (matrix.get(key) || 0) + 1);
      touch(from).borrows_given += 1;
      touch(to).borrows_received += 1;
    } else if (event.event === 'convergence_event') {
      if (event.judged_as) convergence.set(event.judged_as, (convergence.get(event.judged_as) || 0) + 1);
      for (const id of Array.isArray(event.seed_ids) ? event.seed_ids : []) touch(id).convergence_participations += 1;
    }
  }
  for (const event of journalEvents) if (plainObject(event) && event.event === 'seed_initialized' && event.seed_id !== undefined) touch(event.seed_id);
  const matrixLines = matrix.size === 0 ? ['_No cross-seed exchanges (0 borrows recorded)._']
    : ['| from → to | count |', '|---|---|', ...[...matrix.entries()].sort(([left], [right]) => {
      const [lf, lt] = JSON.parse(left); const [rf, rt] = JSON.parse(right);
      return compareText(lf, rf) || compareText(lt, rt);
    }).map(([key, count]) => { const [from, to] = JSON.parse(key); return `| ${from} → ${to} | ${count} |`; })];
  const convergenceLines = convergence.size === 0 ? ['_No convergence events recorded._']
    : ['| judged_as | count |', '|---|---|', ...[...convergence.entries()].sort(([a], [b]) => compareText(a, b)).map(([name, count]) => `| ${name} | ${count} |`)];
  const activityLines = activity.size === 0 ? ['_No seed activity recorded._']
    : ['| seed | keeps | discards | borrows_given | borrows_received | convergence |', '|---|---|---|---|---|---|',
      ...[...activity.entries()].sort(([a], [b]) => compareText(a, b)).map(([id, value]) => `| Seed ${id} | ${value.keeps} | ${value.discards} | ${value.borrows_given} | ${value.borrows_received} | ${value.convergence_participations} |`)];
  const markdown = `# Cross-Seed Audit\n\n_Multi-seed session — N=${distinct.size}._\n\n## Borrow Matrix\n\n${matrixLines.join('\n')}\n\n## Convergence Events\n\n${convergenceLines.join('\n')}\n\n## Per-Seed Forum Activity\n\n${activityLines.join('\n')}\n`;
  return { markdown, warnings };
}

function sortedSeeds(session) {
  const virtual = plainObject(session.virtual_parallel) ? session.virtual_parallel : {};
  const seeds = Array.isArray(virtual.seeds) ? virtual.seeds : [];
  return [...seeds].sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
}

function signedFixed(value, places) {
  const fixed = Number(value).toFixed(places);
  return Number(value) >= 0 ? `+${fixed}` : fixed;
}

function renderFallbackNote(options) {
  const classification = validateSynthesisChoice(options.user_choice, 'fallback-note');
  const reasoning = requireObject(options.baseline_reasoning, 'baseline reasoning');
  if (reasoning.ties_broken_on !== undefined && reasoning.ties_broken_on !== null && !Array.isArray(reasoning.ties_broken_on)) {
    throw runtimeError('invalid_ties', `baseline reasoning ties_broken_on must be a list, got ${typeof reasoning.ties_broken_on}`);
  }
  const finiteSynthesis = typeof options.synthesis_q === 'number' && Number.isFinite(options.synthesis_q);
  const finiteBaseline = typeof options.baseline_q === 'number' && Number.isFinite(options.baseline_q);
  const validShape = (classification === 'keep-baseline' && finiteSynthesis && finiteBaseline)
    || (classification === 'automatic-fallback' && finiteBaseline
      && (finiteSynthesis || options.synthesis_q === 'synthesis_failed'))
    || (classification === 'no-baseline' && options.synthesis_q === null && options.baseline_q === null);
  if (!validShape) {
    throw runtimeError('invalid_fallback_q_shape',
      `Q values do not match fallback classification ${classification}`);
  }
  const descriptions = {
    'keep-baseline': 'User selected the authenticated baseline after a within-tolerance synthesis regression.',
    'automatic-fallback': 'The runtime selected the authenticated baseline without a user choice.',
    'no-baseline': 'No eligible authenticated baseline was available.',
  };
  const synthesisText = finiteSynthesis ? options.synthesis_q.toFixed(4)
    : options.synthesis_q === 'synthesis_failed' ? 'synthesis_failed' : 'N/A';
  const baselineText = finiteBaseline ? options.baseline_q.toFixed(4) : 'N/A';
  const deltaText = finiteSynthesis && finiteBaseline
    ? signedFixed(options.synthesis_q - options.baseline_q, 4) : 'N/A';
  const seeds = sortedSeeds(requireObject(options.session, 'session'));
  const table = seeds.length === 0 ? ['_No seeds in session.yaml._']
    : ['| seed | status | final_q |', '|---|---|---|',
      ...seeds.map((seed) => `| Seed ${seed.id === undefined ? '?' : seed.id} | ${seed.status === undefined ? 'unknown' : seed.status} | ${seed.final_q === undefined ? 0 : seed.final_q} |`)];
  return `${[
    '# Fallback Note', '',
    '## Classification', '',
    `- **classification**: ${classification}`,
    `- **description**: ${descriptions[classification]}`, '',
    '## Q Delta', '',
    `- **synthesis_Q**: ${synthesisText}`,
    `- **baseline_Q**: ${baselineText}`,
    `- **delta**: ${deltaText}`, '',
    '## Baseline Selection Reasoning', '',
    `- **chosen_seed_id**: ${reasoning.chosen_seed_id === null ? 'None' : reasoning.chosen_seed_id}`,
    `- **tier**: ${reasoning.tier}`,
    `- **ties_broken_on**: ${(reasoning.ties_broken_on || []).join(', ') || '(none)'}`, '',
    '## Per-Seed Snapshot', '',
    ...table, '',
    '_See also_: `synthesis.md` (AI integration narrative), `cross_seed_audit.md` (forum activity), `seed_reports/` (per-seed journeys).',
  ].join('\n')}\n`;
}

function parseJsonl(text, label) {
  const events = [];
  const warnings = [];
  for (const [index, line] of String(text || '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (plainObject(value)) events.push(value);
      else warnings.push({ code: 'non_object_jsonl', file: label, line: index + 1 });
    } catch {
      warnings.push({ code: 'malformed_jsonl', file: label, line: index + 1 });
    }
  }
  return { events, warnings };
}

function normalizedSeedIdentity(seed) {
  const ids = ['id', 'seed_id'].filter((key) => Object.hasOwn(seed, key)).map((key) => seed[key]);
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0) || ids.some((id) => id !== ids[0])) {
    throw runtimeError('invalid_seed_identity', 'seed id/seed_id must be one positive consistent integer');
  }
  return ids[0];
}

function activeState(session) {
  const virtual = session.virtual_parallel || {};
  if (!plainObject(virtual)) throw runtimeError('invalid_virtual_parallel', 'virtual_parallel must be a mapping');
  const seeds = virtual.seeds || [];
  if (!Array.isArray(seeds)) throw runtimeError('invalid_seeds', 'virtual_parallel.seeds must be a list');
  const marker = Object.hasOwn(virtual, 'x-active-seed-count');
  if (marker && (!Number.isInteger(virtual['x-active-seed-count']) || virtual['x-active-seed-count'] !== 0)) {
    throw runtimeError('invalid_zero_active', 'x-active-seed-count must be the integer 0');
  }
  if (marker && Object.hasOwn(virtual, 'n_current')) {
    throw runtimeError('invalid_zero_active', 'x-active-seed-count and n_current cannot coexist');
  }
  const active = [];
  const seen = new Set();
  let missingStatus = false;
  for (const seed of seeds) {
    if (!plainObject(seed)) throw runtimeError('invalid_seed', 'seed entry must be a mapping');
    const identity = normalizedSeedIdentity(seed);
    if (seen.has(identity)) throw runtimeError('duplicate_seed_identity', `duplicate seed identity: ${identity}`);
    seen.add(identity);
    if (!Object.hasOwn(seed, 'status')) missingStatus = true;
    if ((Object.hasOwn(seed, 'status') ? seed.status : 'active') === 'active') active.push(identity);
  }
  if (marker && (active.length > 0 || missingStatus)) {
    throw runtimeError('invalid_zero_active', 'x-active-seed-count: 0 requires explicit non-active seed statuses');
  }
  const legacyZero = Number.isInteger(virtual.n_current) && virtual.n_current === 0;
  const zero = marker || legacyZero || active.length === 0;
  return { active_seed_count: zero ? 0 : active.length, zero_active: zero };
}

function renderStatus({ session, journal_text, forum_text }) {
  requireObject(session, 'session');
  const journal = parseJsonl(journal_text, 'journal.jsonl');
  const forum = parseJsonl(forum_text, 'forum.jsonl');
  const state = activeState(session);
  const virtual = plainObject(session.virtual_parallel) ? session.virtual_parallel : {};
  const journalAgg = new Map();
  const seenTerminal = new Set();
  for (const event of journal.events) {
    if (!Number.isInteger(event.seed_id)) continue;
    if (!journalAgg.has(event.seed_id)) journalAgg.set(event.seed_id, { exp: 0, keep: 0 });
    const kind = event.event || event.status;
    if (['kept', 'discarded'].includes(kind)) {
      const key = event.id === undefined ? null : JSON.stringify([event.seed_id, event.id]);
      if (key === null || !seenTerminal.has(key)) {
        if (key !== null) seenTerminal.add(key);
        journalAgg.get(event.seed_id).exp += 1;
        if (kind === 'kept') journalAgg.get(event.seed_id).keep += 1;
      }
    }
  }
  const received = new Map(); const given = new Map();
  let borrowCount = 0; let convergenceCount = 0;
  for (const event of forum.events) {
    if (event.event === 'cross_seed_borrow') {
      borrowCount += 1;
      if (Number.isInteger(event.to_seed)) received.set(event.to_seed, (received.get(event.to_seed) || 0) + 1);
      if (Number.isInteger(event.from_seed)) given.set(event.from_seed, (given.get(event.from_seed) || 0) + 1);
    } else if (event.event === 'convergence_event') convergenceCount += 1;
  }
  const budgetTotal = Number.isInteger(virtual.budget_total) ? virtual.budget_total : 0;
  const budgetUnallocated = Number.isInteger(virtual.budget_unallocated) ? virtual.budget_unallocated : 0;
  const epoch = plainObject(session.evaluation_epoch) ? session.evaluation_epoch : {};
  const epochCurrent = epoch.current || 1;
  const epochMax = Number.isInteger(epoch.current) ? (Array.isArray(epoch.history) ? epoch.history.length : 0) + 1 : 1;
  const lines = [
    `Session ${session.session_id || session.id || '<unknown>'} — epoch ${epochCurrent}/${epochMax}, budget ${budgetTotal - budgetUnallocated}/${budgetTotal} used`,
    `Active seeds: ${state.active_seed_count}`, '',
    state.zero_active ? 'Terminal seeds:' : ((virtual.n_current || 1) > 1 ? 'Seeds (borrow recv/given counts):' : 'Seed:'),
  ];
  for (const seed of Array.isArray(virtual.seeds) ? virtual.seeds : []) {
    if (!plainObject(seed)) continue;
    const id = normalizedSeedIdentity(seed);
    const status = String(seed.status || 'active').trim();
    const finalQ = seed.final_q ?? seed.q;
    const q = typeof finalQ === 'number' ? finalQ.toFixed(2) : '—';
    const aggregate = journalAgg.get(id) || { exp: 0, keep: 0 };
    if (status.startsWith('killed')) {
      const reason = seed.killed_reason || status.split(':').at(-1).trim();
      const killedAt = seed.killed_at ? String(seed.killed_at).replace(/Z$/, '') : '';
      lines.push(`  [${id}] (killed: ${reason}${killedAt ? ` at ${killedAt}` : ''})  Q=${q}  exp=${aggregate.exp}  keep=${aggregate.keep}`);
    } else {
      const direction = String(seed.direction || '').trim().slice(0, 24).padEnd(24);
      lines.push(`  [${id}] ${direction}  ${status.slice(0, 8).padEnd(8)}  Q=${q}  exp=${aggregate.exp}  keep=${aggregate.keep}  borrow recv=${received.get(id) || 0} given=${given.get(id) || 0}`);
    }
  }
  lines.push('', `Forum: ${borrowCount} borrow events, ${convergenceCount} convergence events`);
  const last = journal.events.at(-1);
  let lastText = '(none)';
  if (last) {
    const parts = [last.event || last.status || '?'];
    const id = last.seed_id ?? last.chosen_seed_id;
    const block = last.block_id ?? last.block_size;
    if (id !== undefined) parts.push(`seed=${id}`);
    if (block !== undefined) parts.push(`block=${block}`);
    const match = /T(\d{2}:\d{2})/.exec(String(last.ts ?? last.timestamp ?? ''));
    lastText = `${parts.join(' ')}${match ? ` (${match[1]})` : ''}`;
  }
  lines.push(`Last event: ${lastText}`);
  return { dashboard: `${lines.join('\n')}\n`, warnings: [...journal.warnings, ...forum.warnings] };
}

function collectSynthesis(payload) {
  requireObject(payload, 'synthesis collection');
  const reports = requireArray(payload.seed_reports || [], 'seed reports').map((report) => requireObject(report, 'seed report'));
  return {
    seed_reports: [...reports].sort((left, right) => Number(left.seed_id) - Number(right.seed_id)),
    baseline_selection: payload.baseline_selection || null,
    cross_seed_audit: payload.cross_seed_audit || null,
  };
}

function finalizeSynthesis(payload) {
  requireObject(payload, 'synthesis finalization');
  const n = requireInteger(payload.n, 'n', { nonnegative: true });
  const choice = validateSynthesisChoice(payload.user_choice, 'finalize');
  const rejectInapplicableChoice = () => {
    if (choice !== undefined) {
      throw runtimeError('synthesis_choice_not_applicable',
        'user_choice is allowed only inside the synthesis regression prompt window');
    }
  };
  if (n === 0) {
    rejectInapplicableChoice();
    return { outcome: 'skipped_zero_active', fallback_triggered: false, classification: 'no-baseline' };
  }
  if (n === 1) {
    rejectInapplicableChoice();
    return { outcome: 'skipped_n1', fallback_triggered: false };
  }
  if (payload.baseline_q === null) {
    rejectInapplicableChoice();
    return { outcome: 'no_baseline', fallback_triggered: false, classification: 'no-baseline' };
  }
  requireNumber(payload.baseline_q, 'baseline_q');
  if (payload.synthesis_q === 'synthesis_failed') {
    rejectInapplicableChoice();
    return { outcome: 'fallback', fallback_triggered: true, classification: 'automatic-fallback' };
  }
  requireNumber(payload.synthesis_q, 'synthesis_q');
  const tolerance = requireNumber(payload.regression_tolerance, 'regression_tolerance');
  if (tolerance < 0) {
    throw runtimeError('invalid_regression_tolerance',
      'regression_tolerance must be a non-negative finite number');
  }
  if (payload.synthesis_q >= payload.baseline_q) {
    rejectInapplicableChoice();
    return { outcome: 'success', fallback_triggered: false };
  }
  if (payload.synthesis_q < payload.baseline_q - tolerance) {
    rejectInapplicableChoice();
    return { outcome: 'fallback', fallback_triggered: true, classification: 'automatic-fallback' };
  }
  if (choice === undefined) {
    throw runtimeError('synthesis_choice_required',
      'user_choice is required inside the synthesis regression prompt window', 1);
  }
  if (choice === 'stop') {
    throw runtimeError('synthesis_stopped', 'synthesis was stopped by user choice', 1);
  }
  if (choice === 'accept-regression') {
    return { outcome: 'accepted_with_regression', fallback_triggered: false, choice_id: choice };
  }
  return { outcome: 'fallback_user_kept_baseline', fallback_triggered: true, choice_id: choice };
}

function resolveDataRoot(environment = process.env, homedir = os.homedir) {
  return path.resolve(environment.DEEP_EVOLVE_DATA_ROOT || path.join(homedir(), '.claude', 'deep-evolve'));
}

function archivePaths(dataRoot) {
  return {
    root: path.resolve(dataRoot),
    archive: path.join(path.resolve(dataRoot), 'meta-archive.jsonl'),
    pending: path.join(path.resolve(dataRoot), '.pending-archive.jsonl'),
    lock: path.join(path.resolve(dataRoot), '.meta-archive.lock'),
    pendingLock: path.join(path.resolve(dataRoot), '.pending-archive.lock'),
  };
}

function nonSymlinkFile(filePath, { missing = false } = {}) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) {
    if (missing && error && error.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink()) throw runtimeError('archive_symlink', `archive path must not be a symlink: ${filePath}`);
  if (!stat.isFile()) throw runtimeError('archive_invalid', `archive path must be a regular file: ${filePath}`);
  return true;
}

function readArchive(dataRoot) {
  const paths = archivePaths(dataRoot);
  if (!nonSymlinkFile(paths.archive, { missing: true })) return { entries: [], warnings: [], paths };
  const entries = [];
  const warnings = [];
  for (const [index, line] of fs.readFileSync(paths.archive, 'utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); }
    catch { warnings.push({ code: 'malformed_archive_line', line: index + 1 }); continue; }
    if (!plainObject(entry)) { warnings.push({ code: 'non_object_archive_line', line: index + 1 }); continue; }
    const version = entry.schema_version == null ? 2 : entry.schema_version;
    if (!Number.isInteger(version) || version < 2) {
      warnings.push({ code: 'malformed_schema_version', line: index + 1, id: entry.id || null });
      continue;
    }
    if (entry.pruned === true) continue;
    entries.push({ entry, version });
  }
  return { entries, warnings, paths };
}

function lookupTransfer({ dataRoot = resolveDataRoot(), selectedId } = {}) {
  const archive = readArchive(dataRoot);
  if (selectedId === undefined) return { entries: archive.entries.map((row) => row.entry), warnings: archive.warnings };
  const row = archive.entries.find((item) => item.entry.id === selectedId);
  if (!row) throw runtimeError('archive_entry_missing', `archive entry not found: ${selectedId}`, 1);
  if (row.version >= 5) throw runtimeError('archive_forward_incompatible', `schema_version=${row.version} is from a newer deep-evolve release`);
  const strategy = plainObject(row.entry.final_strategy)
    ? row.entry.final_strategy
    : (plainObject(row.entry.strategy_evolution) && plainObject(row.entry.strategy_evolution.final_strategy)
      ? row.entry.strategy_evolution.final_strategy : null);
  if (!strategy || !plainObject(strategy.weights)) throw runtimeError('archive_weights_missing', `archive entry ${selectedId} final_strategy.weights missing`, 1);
  if (row.version === 2) {
    return {
      source_id: row.entry.id,
      source_schema_version: 2,
      n_prior: 1,
      weights: migrateV2Weights(strategy.weights).weights,
      program_versions: (row.entry.strategy_evolution && row.entry.strategy_evolution.program_versions) || [],
      warnings: archive.warnings,
    };
  }
  const virtual = row.version === 4 && plainObject(row.entry.virtual_parallel) ? row.entry.virtual_parallel : {};
  return {
    source_id: row.entry.id,
    source_schema_version: row.version,
    n_prior: row.version === 4 && Number.isInteger(virtual.n_initial) ? virtual.n_initial : 1,
    weights: structuredClone(strategy.weights),
    ...(row.version === 4 ? { virtual_parallel: structuredClone(virtual) } : {}),
    program_versions: (row.entry.strategy_evolution && row.entry.strategy_evolution.program_versions) || [],
    warnings: archive.warnings,
  };
}

function updateSource(entries, sourceId, success) {
  const source = entries.find((entry) => entry.id === sourceId);
  if (!source) return false;
  const usage = Number.isInteger(source.usage_count) && source.usage_count >= 0 ? source.usage_count : 0;
  const previous = typeof source.transfer_success_rate === 'number' && Number.isFinite(source.transfer_success_rate)
    ? source.transfer_success_rate : null;
  source.transfer_success_rate = previous === null ? success : ((previous * usage) + success) / (usage + 1);
  source.usage_count = usage + 1;
  return true;
}

function readAllArchiveEntries(paths) {
  if (!nonSymlinkFile(paths.archive, { missing: true })) return [];
  const entries = [];
  for (const line of fs.readFileSync(paths.archive, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const value = JSON.parse(line);
    if (!plainObject(value)) throw runtimeError('archive_invalid', 'meta archive line must be an object');
    entries.push(value);
  }
  return entries;
}

function writeArchiveEntries(paths, entries) {
  fs.mkdirSync(paths.root, { recursive: true });
  atomicWriteFile(paths.archive, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

function requireAcquiredLock(result, label) {
  if (result && result.ok === false && result.code === 'lock_held') {
    throw runtimeError('lock_held', `${label} lock is held`);
  }
  return result;
}

function appendPending(paths, records) {
  fs.mkdirSync(paths.root, { recursive: true });
  const result = withDirectoryLock(paths.pendingLock, () => {
    const existing = nonSymlinkFile(paths.pending, { missing: true }) ? fs.readFileSync(paths.pending, 'utf8') : '';
    atomicWriteFile(paths.pending, `${existing}${records.map((record) => `${JSON.stringify(record)}\n`).join('')}`);
  });
  requireAcquiredLock(result, 'pending archive');
}

function pendingTransferRecords(entry, sourceId, thisSessionSuccess) {
  const timestamp = entry.timestamp || new Date().toISOString();
  const records = [{ type: 'new_entry', timestamp, data: entry }];
  if (sourceId) records.push({ type: 'update_source', timestamp, id: sourceId, this_session_success: thisSessionSuccess });
  return records;
}

function recordTransfer({ dataRoot = resolveDataRoot(), entry, sourceId = null, thisSessionSuccess = 0, lockOptions = {} }) {
  requireObject(entry, 'archive entry');
  if (typeof entry.id !== 'string' || entry.id.length === 0) throw runtimeError('archive_id_missing', 'archive entry id is required');
  if (![0, 1].includes(thisSessionSuccess)) throw runtimeError('invalid_success', 'thisSessionSuccess must be 0 or 1');
  const paths = archivePaths(dataRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  const apply = () => {
    const entries = readAllArchiveEntries(paths);
    if (!entries.some((value) => value.id === entry.id)) entries.push(structuredClone(entry));
    if (sourceId) updateSource(entries, sourceId, thisSessionSuccess);
    writeArchiveEntries(paths, entries);
  };
  if (lockOptions.forceTimeout) {
    const records = pendingTransferRecords(entry, sourceId, thisSessionSuccess);
    appendPending(paths, records);
    return { pending: true, records: records.length };
  }
  try {
    const result = withDirectoryLock(paths.lock, apply, lockOptions);
    requireAcquiredLock(result, 'meta archive');
    return { pending: false, recorded_id: entry.id, source_updated: Boolean(sourceId) };
  } catch (error) {
    if (error && error.code !== 'lock_held') throw error;
    const records = pendingTransferRecords(entry, sourceId, thisSessionSuccess);
    appendPending(paths, records);
    return { pending: true, records: records.length };
  }
}

function mergePendingArchive({ dataRoot = resolveDataRoot(), lockOptions = {} } = {}) {
  const paths = archivePaths(dataRoot);
  if (!nonSymlinkFile(paths.pending, { missing: true })) return { new_entries: 0, source_updates: 0, duplicates: 0 };
  const result = withDirectoryLock(paths.lock, () => {
    const pendingResult = withDirectoryLock(paths.pendingLock, () => {
      if (!nonSymlinkFile(paths.pending, { missing: true })) return { new_entries: 0, source_updates: 0, duplicates: 0 };
      const entries = readAllArchiveEntries(paths);
      let newEntries = 0; let sourceUpdates = 0; let duplicates = 0;
      for (const [index, line] of fs.readFileSync(paths.pending, 'utf8').split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); }
        catch { throw runtimeError('pending_malformed', `pending archive line ${index + 1} is malformed`); }
        if (!plainObject(record)) throw runtimeError('pending_invalid', `pending archive line ${index + 1} must be an object`);
        if (record.type === 'update_source') {
          if (updateSource(entries, record.id, record.this_session_success)) sourceUpdates += 1;
          continue;
        }
        const value = record.type === 'new_entry' ? record.data : record;
        requireObject(value, `pending line ${index + 1} data`);
        if (entries.some((entry) => entry.id === value.id)) duplicates += 1;
        else { entries.push(value); newEntries += 1; }
      }
      writeArchiveEntries(paths, entries);
      fs.unlinkSync(paths.pending);
      return { new_entries: newEntries, source_updates: sourceUpdates, duplicates };
    }, lockOptions);
    return requireAcquiredLock(pendingResult, 'pending archive');
  }, lockOptions);
  return requireAcquiredLock(result, 'meta archive');
}

function daysBetween(now, timestamp) {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? (now - parsed) / 86_400_000 : 0;
}

function pruneReasons(entry, now) {
  const reasons = [];
  const age = daysBetween(now, entry.timestamp);
  const rate = entry.transfer_success_rate;
  if (age >= 90 && typeof rate === 'number' && rate < 0.3) reasons.push('90+ days unused with low transfer success');
  if (rate === 0) reasons.push('all transfers failed');
  if (plainObject(entry.outcome) && Number(entry.outcome.total_outer_generations) < 2) reasons.push('insufficient Outer Loop data');
  const version = entry.schema_version == null ? 2 : entry.schema_version;
  if (version < 3 && age >= 180) reasons.push('legacy v2 entry older than 180 days');
  if (version === 3 && age >= 270) reasons.push('v3 entry older than 270 days');
  return reasons;
}

function pruneTransfer({ dataRoot = resolveDataRoot(), now = Date.now(), selectedIds = [], lockOptions = {} } = {}) {
  mergePendingArchive({ dataRoot, lockOptions });
  const paths = archivePaths(dataRoot);
  const entries = readAllArchiveEntries(paths);
  const candidates = entries.filter((entry) => entry.pruned !== true)
    .map((entry) => ({ id: entry.id, reasons: pruneReasons(entry, now) }))
    .filter((row) => row.reasons.length > 0)
    .sort((left, right) => compareText(left.id, right.id));
  const selected = new Set(requireArray(selectedIds, 'selected ids'));
  if (selected.size === 0) return { candidates, pruned: 0, total: entries.length };
  let count = 0;
  const result = withDirectoryLock(paths.lock, () => {
    const current = readAllArchiveEntries(paths);
    for (const entry of current) {
      const candidate = candidates.find((row) => row.id === entry.id);
      if (!candidate || !selected.has(entry.id) || entry.pruned === true) continue;
      entry.pruned = true;
      entry.pruned_reason = candidate.reasons.join('; ');
      count += 1;
    }
    writeArchiveEntries(paths, current);
  }, lockOptions);
  requireAcquiredLock(result, 'meta archive');
  return { candidates, pruned: count, total: entries.length };
}

function exportFeedback({
  payload,
  sourceArtifacts = [],
  envelopeOptions = {},
  sessionId,
  sourceArtifactsAuthenticated = false,
} = {}) {
  requireObject(payload, 'feedback payload');
  for (const key of ['insights_for_deep_work', 'insights_for_deep_review']) requireArray(payload[key], key);
  return wrapEvolveArtifact({
    artifactKind: 'evolve-insights', payload, sourceArtifacts, sessionId, envelopeOptions,
    sourceArtifactsAuthenticated,
  });
}

module.exports = {
  SIMILARITY_THRESHOLD,
  MAX_RETRIES,
  processBeta,
  processBetaGrowth,
  selectBaseline,
  buildSeedDispatchContext,
  buildSeedPrompt,
  writeSeedProgram,
  renderForumSummary,
  renderCrossSeedAudit,
  renderFallbackNote,
  renderStatus,
  collectSynthesis,
  validateSynthesisChoice,
  finalizeSynthesis,
  resolveDataRoot,
  lookupTransfer,
  recordTransfer,
  mergePendingArchive,
  pruneTransfer,
  exportFeedback,
};
