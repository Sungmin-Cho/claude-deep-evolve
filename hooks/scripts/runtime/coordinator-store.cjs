'use strict';

const crypto = require('node:crypto');

const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TERMINALS = new Set(['kept', 'discarded', 'failed']);
const FINISH_STATUSES = new Set(['completed', 'failed']);
const EPOCH_REASONS = new Set([
  'block_interval', 'tier3_expansion', 'manual_boundary', 'termination_boundary',
]);
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SUMMARY_KEYS = new Set([
  'experiments_executed', 'commits', 'final_q', 'forum_events_appended',
  'borrows_planned', 'borrows_executed',
]);

function coordinatorError(code, message, rc = 2, details) {
  return Object.assign(new Error(message), {
    code,
    rc,
    ...(details === undefined ? {} : { details }),
  });
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys, label) {
  if (!plainObject(value)) throw coordinatorError('invalid_object', `${label} must be a plain object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) {
    throw coordinatorError('invalid_record_schema',
      `${label} must contain exactly: ${[...keys].join(', ')}`);
  }
  return value;
}

function safeInteger(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || typeof value === 'boolean' || value < min) {
    throw coordinatorError('invalid_field_type', `${label} must be a safe integer >= ${min}`);
  }
  return value;
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw coordinatorError('invalid_field_type', `${label} must be a finite number`);
  }
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw coordinatorError('invalid_field_type', `${label} must be a non-empty string`);
  }
  return value;
}

function utc(value, label) {
  const parsed = typeof value === 'string' && UTC_ISO.test(value)
    ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)
      || new Date(parsed).toISOString().replace(/\.000Z$/, 'Z') !== value) {
    throw coordinatorError('invalid_field_type', `${label} must be canonical UTC ISO 8601`);
  }
  return value;
}

function operationId(value, label = 'operation_id') {
  if (typeof value !== 'string' || !ULID.test(value)) {
    throw coordinatorError('invalid_operation_id', `${label} must be a canonical ULID`);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function deterministicBlockId(payload) {
  return `block:${sha256(Buffer.from(canonicalJson({
    session_id: payload.session_id,
    decision_id: payload.decision_id,
    seed_id: payload.seed_id,
    block_size: payload.block_size,
    pre_dispatch_head: payload.pre_dispatch_head,
    expected_epoch: payload.expected_epoch,
    budget_preimage: payload.budget_preimage,
  })))}`;
}

function scanBlocks(events) {
  if (!Array.isArray(events)) throw coordinatorError('invalid_journal', 'events must be an array');
  const schedules = new Map();
  const terminals = new Map();
  const ordered = [];
  const decisions = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!plainObject(event)) continue;
    if (event.event === 'seed_scheduled') {
      if (typeof event.block_id !== 'string' || schedules.has(event.block_id)) {
        throw coordinatorError('coordinator_authority_conflict',
          'seed schedule identity is malformed or duplicated');
      }
      if (decisions.has(event.decision_id)) {
        throw coordinatorError('coordinator_authority_conflict',
          'scheduler decision identity is reused');
      }
      schedules.set(event.block_id, { event, index });
      ordered.push(event.block_id);
      decisions.add(event.decision_id);
    } else if (event.event === 'seed_block_completed' || event.event === 'seed_block_failed') {
      const schedule = schedules.get(event.block_id);
      if (!schedule || terminals.has(event.block_id)
          || event.schedule_operation_id !== schedule.event.operation_id
          || event.seed_id !== schedule.event.seed_id) {
        throw coordinatorError('coordinator_authority_conflict',
          'block terminal lacks one matching schedule');
      }
      terminals.set(event.block_id, { event, index });
    }
  }
  return { schedules, terminals, ordered, decisions };
}

function beginSeedBlock({ session, payload, events, worktree, now }) {
  if (!plainObject(session) || session.status !== 'active') {
    throw coordinatorError('session_not_active', 'seed scheduling requires active lifecycle', 1);
  }
  operationId(payload.operation_id, 'payload.operation_id');
  nonEmpty(payload.decision_id, 'payload.decision_id');
  const seedId = safeInteger(payload.seed_id, 'payload.seed_id', 1);
  const blockSize = safeInteger(payload.block_size, 'payload.block_size', 1);
  const epoch = safeInteger(payload.expected_epoch, 'payload.expected_epoch', 1);
  const budget = safeInteger(payload.budget_preimage, 'payload.budget_preimage', 0);
  if (!FULL_COMMIT.test(payload.pre_dispatch_head)) {
    throw coordinatorError('invalid_commit', 'payload.pre_dispatch_head must be a full commit ID');
  }
  const currentEpoch = session.evaluation_epoch && session.evaluation_epoch.current;
  if (epoch !== currentEpoch) {
    throw coordinatorError('epoch_conflict', 'expected epoch differs from canonical session', 1);
  }
  const seed = session.virtual_parallel && session.virtual_parallel.seeds
    && session.virtual_parallel.seeds.find((entry) => entry.id === seedId);
  if (!seed || seed.status !== 'active') {
    throw coordinatorError('seed_not_active', `seed ${seedId} is missing or terminal`, 1);
  }
  const remaining = seed.allocated_budget - seed.experiments_used;
  if (budget !== remaining || blockSize > remaining) {
    throw coordinatorError('budget_preimage_conflict',
      'block size or budget preimage differs from canonical allocation', 1);
  }
  if (!plainObject(worktree) || worktree.branch !== seed.branch
      || worktree.head !== payload.pre_dispatch_head) {
    throw coordinatorError('worktree_identity_mismatch',
      'seed worktree branch or HEAD differs from canonical authority', 1);
  }
  const blocks = scanBlocks(events);
  if (blocks.decisions.has(payload.decision_id)) {
    throw coordinatorError('decision_already_consumed', 'decision_id already scheduled');
  }
  if ([...blocks.schedules.entries()].some(([blockId, schedule]) => (
    schedule.event.seed_id === seedId && !blocks.terminals.has(blockId)
  ))) {
    throw coordinatorError('seed_block_in_flight', `seed ${seedId} already has an in-flight block`, 1);
  }
  const blockId = deterministicBlockId(payload);
  if (blocks.schedules.has(blockId)) {
    throw coordinatorError('block_already_scheduled', `block ${blockId} already exists`);
  }
  const event = {
    event: 'seed_scheduled',
    operation_id: payload.operation_id,
    block_id: blockId,
    decision_id: payload.decision_id,
    seed_id: seedId,
    epoch,
    pre_dispatch_head: payload.pre_dispatch_head,
    block_size: blockSize,
    budget_preimage: budget,
    ts: now,
  };
  return { event, blockId, seed };
}

function validateSummary(value) {
  exactKeys(value, SUMMARY_KEYS, 'summary');
  safeInteger(value.experiments_executed, 'summary.experiments_executed');
  if (!Array.isArray(value.commits) || new Set(value.commits).size !== value.commits.length
      || value.commits.some((commit) => !FULL_COMMIT.test(commit))) {
    throw coordinatorError('invalid_summary', 'summary.commits must be unique full commit IDs');
  }
  finite(value.final_q, 'summary.final_q');
  for (const key of ['forum_events_appended', 'borrows_planned', 'borrows_executed']) {
    safeInteger(value[key], `summary.${key}`);
  }
  return structuredClone(value);
}

function wordSet(description) {
  return new Set(String(description).toLowerCase().trim().split(/\s+/u).filter(Boolean));
}

function ideaDiversity(terminals) {
  if (terminals.length < 2) return 0;
  const sets = terminals.map((event) => wordSet(event.description));
  let total = 0;
  let pairs = 0;
  for (let left = 0; left < sets.length; left += 1) {
    for (let right = left + 1; right < sets.length; right += 1) {
      const union = new Set([...sets[left], ...sets[right]]);
      const intersection = [...sets[left]].filter((word) => sets[right].has(word)).length;
      total += union.size === 0 ? 0 : 1 - intersection / union.size;
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : total / pairs;
}

function qFromComponents(components) {
  const value = 0.35 * components.keep_rate
    + 0.30 * components.normalized_delta
    + 0.20 * (1 - components.crash_rate)
    + 0.15 * components.idea_diversity;
  return Number(value.toPrecision(15));
}

function deriveQ(blockTerminals, epochTerminals, status = 'completed') {
  const kept = blockTerminals.filter((event) => event.event === 'kept');
  const crashed = blockTerminals.filter((event) => event.event === 'failed');
  const total = blockTerminals.length;
  const epochKept = epochTerminals.filter((event) => event.event === 'kept');
  const maxDelta = epochKept.reduce((maximum, event) => Math.max(maximum, event.score_delta), 0);
  const meanDelta = kept.length === 0 ? 0
    : kept.reduce((sum, event) => sum + event.score_delta, 0) / kept.length;
  const components = {
    keep_rate: total === 0 ? 0 : kept.length / total,
    normalized_delta: maxDelta === 0 ? 0 : meanDelta / maxDelta,
    crash_rate: total === 0 ? (status === 'failed' ? 1 : 0) : crashed.length / total,
    idea_diversity: ideaDiversity(blockTerminals),
  };
  for (const [key, value] of Object.entries(components)) finite(value, `q_components.${key}`);
  return { components, Q: qFromComponents(components) };
}

function forumIdentity(event, direction = null) {
  if (event.event === 'experiment_kept' || event.event === 'experiment_discarded') {
    operationId(event.operation_id, `${event.event}.operation_id`);
    return `experiment:${event.operation_id}`;
  }
  const suffix = sha256(Buffer.from(canonicalJson(event))).slice('sha256:'.length);
  return `borrow:${direction}:${suffix}`;
}

function deriveFinishEvidence({ events, forumEvents, sessionId, blockId, seedId, status, now }) {
  if (!FINISH_STATUSES.has(status)) {
    throw coordinatorError('invalid_block_status', 'status must be completed or failed');
  }
  nonEmpty(sessionId, 'sessionId');
  utc(now, 'finish timestamp');
  const blocks = scanBlocks(events);
  const scheduleRecord = blocks.schedules.get(blockId);
  if (!scheduleRecord || blocks.terminals.has(blockId)) {
    throw coordinatorError('block_terminal_conflict',
      'block is missing its unique unterminated schedule', 1);
  }
  const schedule = scheduleRecord.event;
  if (schedule.seed_id !== seedId) {
    throw coordinatorError('block_seed_conflict', 'block seed differs from schedule');
  }
  const tail = events.slice(scheduleRecord.index + 1);
  const terminals = tail.filter((event) => plainObject(event)
    && TERMINALS.has(event.event) && event.seed_id === seedId);
  let epochStart = 0;
  for (let index = 0; index < events.length; index += 1) {
    if (plainObject(events[index]) && events[index].event === 'evaluation_epoch_advanced') {
      epochStart = index + 1;
    }
  }
  const epochTerminals = events.slice(epochStart).filter((event) => plainObject(event)
    && TERMINALS.has(event.event));
  if (status === 'completed' && terminals.length !== schedule.block_size) {
    throw coordinatorError('block_experiment_count_conflict',
      'completed block must contain exactly block_size terminal experiments', 1);
  }
  if (status === 'failed' && terminals.length > schedule.block_size) {
    throw coordinatorError('block_experiment_count_conflict',
      'failed block cannot exceed block_size terminal experiments', 1);
  }
  let expectedReturnedHead = schedule.pre_dispatch_head;
  for (const terminal of terminals) {
    if (terminal.pre_commit !== expectedReturnedHead) {
      throw coordinatorError('block_commit_chain_conflict',
        'experiment pre-commit does not continue the scheduled block chain');
    }
    expectedReturnedHead = terminal.status === 'kept'
      ? terminal.commit : terminal.pre_commit;
  }
  const planned = tail.filter((event) => plainObject(event)
    && event.event === 'borrow_planned' && event.seed_id === seedId
    && event.block_id === blockId);
  const experimentOperationIds = new Set(terminals
    .filter((event) => event.event !== 'failed').map((event) => event.operation_id));
  const terminalByOperation = new Map(terminals
    .filter((event) => event.event !== 'failed').map((event) => [event.operation_id, event]));
  const terminalCommits = new Set(terminals.map((event) => event.commit));
  const seedKeepCommits = new Set(events.filter((event) => plainObject(event)
    && event.event === 'kept' && event.seed_id === seedId).map((event) => event.commit));
  const relevantForum = [];
  for (const event of forumEvents) {
    if (!plainObject(event)) {
      throw coordinatorError('invalid_forum_authority', 'forum event must be a plain object');
    }
    if (experimentOperationIds.has(event.operation_id)) {
      const terminal = terminalByOperation.get(event.operation_id);
      exactKeys(event, new Set([
        'event', 'operation_id', 'session_id', 'seed_id', 'experiment_id', 'commit',
        'score_delta', 'ts',
      ]), 'experiment forum event');
      const expectedEvent = terminal.event === 'kept'
        ? 'experiment_kept' : 'experiment_discarded';
      if (event.event !== expectedEvent || event.seed_id !== seedId
          || event.experiment_id !== terminal.id || event.commit !== terminal.commit
          || !Object.is(event.score_delta, terminal.score_delta)
          || event.session_id !== sessionId) {
        throw coordinatorError('forum_authority_conflict',
          'experiment forum projection differs from its typed terminal');
      }
      utc(event.ts, 'experiment forum event.ts');
      if (event.ts < schedule.ts || event.ts > now) {
        throw coordinatorError('forum_authority_conflict',
          'experiment forum projection is outside its scheduled block interval');
      }
      relevantForum.push({ event, direction: null });
      continue;
    }
    if (event.event !== 'cross_seed_borrow') continue;
    utc(event.ts, 'cross_seed_borrow.ts');
    if (event.ts < schedule.ts || event.ts > now) continue;
    exactKeys(event, new Set([
      'event', 'from_seed', 'to_seed', 'source_commit', 'target_commit', 'mode',
      'inspired_by', 'reason', 'ts', 'session_id',
    ]), 'cross_seed_borrow forum event');
    safeInteger(event.from_seed, 'cross_seed_borrow.from_seed', 1);
    safeInteger(event.to_seed, 'cross_seed_borrow.to_seed', 1);
    if (!FULL_COMMIT.test(event.source_commit) || !FULL_COMMIT.test(event.target_commit)
        || event.mode !== 'semantic_borrow' || event.inspired_by !== event.source_commit
        || typeof event.reason !== 'string' || event.session_id !== sessionId) {
      throw coordinatorError('invalid_borrow_authority',
        'cross-seed borrow record is malformed');
    }
    if (event.from_seed === seedId && event.to_seed === seedId) {
      throw coordinatorError('invalid_borrow_authority', 'self borrow is not a cross-seed event');
    }
    if (event.from_seed === seedId) {
      if (!seedKeepCommits.has(event.source_commit)) {
        throw coordinatorError('invalid_borrow_authority',
          'borrow-given source is not a typed keep from this seed');
      }
      relevantForum.push({ event, direction: 'given' });
    } else if (event.to_seed === seedId) {
      if (!terminalCommits.has(event.target_commit)) {
        throw coordinatorError('invalid_borrow_authority',
          'borrow-received target is not a typed block experiment commit');
      }
      relevantForum.push({ event, direction: 'received' });
    }
  }
  const experimentForums = relevantForum.filter((entry) => entry.direction === null);
  if (experimentForums.length !== experimentOperationIds.size
      || new Set(experimentForums.map((entry) => entry.event.operation_id)).size
        !== experimentOperationIds.size) {
    throw coordinatorError('forum_authority_conflict',
      'terminal experiment forum projections are missing or duplicated');
  }
  const forumEntryIds = relevantForum.map(({ event, direction }) => forumIdentity(event, direction));
  if (new Set(forumEntryIds).size !== forumEntryIds.length) {
    throw coordinatorError('forum_authority_conflict', 'forum projection identities are duplicated');
  }
  const borrowsGiven = relevantForum.filter((entry) => entry.direction === 'given').length;
  const borrowsReceived = relevantForum.filter((entry) => entry.direction === 'received').length;
  const q = deriveQ(terminals, epochTerminals, status);
  return {
    schedule,
    terminals,
    experimentIds: terminals.map((event) => event.id),
    commits: terminals.map((event) => event.commit),
    forumEntryIds,
    forumEventsAppended: relevantForum.length,
    borrowsPlanned: planned.length,
    borrowsExecuted: borrowsReceived,
    borrowsGiven,
    borrowsReceived,
    expectedReturnedHead,
    ...q,
  };
}

function assertSummaryMatches(summary, evidence) {
  const checked = validateSummary(summary);
  const pairs = [
    ['experiments_executed', evidence.terminals.length],
    ['forum_events_appended', evidence.forumEventsAppended],
    ['borrows_planned', evidence.borrowsPlanned],
    ['borrows_executed', evidence.borrowsExecuted],
  ];
  for (const [key, expected] of pairs) {
    if (checked[key] !== expected) {
      throw coordinatorError('block_summary_conflict',
        `summary.${key} differs from typed authority`, 1);
    }
  }
  if (canonicalJson(checked.commits) !== canonicalJson(evidence.commits)) {
    throw coordinatorError('block_summary_conflict',
      'summary.commits differs from typed authority', 1);
  }
  if (!Object.is(checked.final_q, evidence.Q)) {
    throw coordinatorError('block_summary_conflict',
      'summary.final_q differs from recomputed Q', 1);
  }
  return checked;
}

function buildFinishEvent({ payload, evidence, now }) {
  const eventName = payload.status === 'completed'
    ? 'seed_block_completed' : 'seed_block_failed';
  return {
    event: eventName,
    operation_id: payload.operation_id,
    block_id: payload.block_id,
    schedule_operation_id: evidence.schedule.operation_id,
    seed_id: payload.seed_id,
    experiment_ids: evidence.experimentIds,
    commits: evidence.commits,
    forum_entry_ids: evidence.forumEntryIds,
    borrows_given: evidence.borrowsGiven,
    borrows_received: evidence.borrowsReceived,
    q_components: evidence.components,
    final_q: evidence.Q,
    returned_head: payload.returned_head,
    status: payload.status,
    ts: now,
  };
}

function currentEpochBlockIds(events, epoch) {
  const blocks = scanBlocks(events);
  const ordered = blocks.ordered.filter((blockId) => blocks.schedules.get(blockId).event.epoch === epoch);
  return { blocks, ordered, terminals: ordered.map((blockId) => blocks.terminals.get(blockId)) };
}

function deriveEpochBoundary({ session, events, completedBlockIds, reason }) {
  if (!plainObject(session) || session.status !== 'active') {
    throw coordinatorError('epoch_lifecycle_invalid',
      'epoch advancement requires active lifecycle', 1);
  }
  if (!EPOCH_REASONS.has(reason)) {
    throw coordinatorError('invalid_epoch_reason', 'epoch reason is invalid');
  }
  if (!Array.isArray(completedBlockIds) || completedBlockIds.length === 0
      || completedBlockIds.some((entry) => typeof entry !== 'string')
      || new Set(completedBlockIds).size !== completedBlockIds.length) {
    throw coordinatorError('invalid_completed_blocks',
      'completed_block_ids must be a non-empty unique string array');
  }
  const epoch = session.evaluation_epoch.current;
  const scanned = currentEpochBlockIds(events, epoch);
  if (scanned.terminals.some((terminal) => !terminal)) {
    throw coordinatorError('epoch_block_in_flight',
      'epoch cannot advance with unresolved in-flight blocks', 1);
  }
  if (canonicalJson(completedBlockIds) !== canonicalJson(scanned.ordered)) {
    throw coordinatorError('epoch_block_gap',
      'completed_block_ids must be the exact ordered gap-free epoch block set', 1);
  }
  const terminalEvents = scanned.terminals.map((entry) => entry.event);
  const experimentIds = new Set(terminalEvents.flatMap((event) => event.experiment_ids));
  const blockTerminals = events.filter((event) => plainObject(event)
    && TERMINALS.has(event.event) && experimentIds.has(event.id));
  if (blockTerminals.length !== experimentIds.size) {
    throw coordinatorError('epoch_terminal_conflict',
      'epoch block terminals do not match experiment authority');
  }
  if (reason === 'block_interval'
      && blockTerminals.length < session.outer_loop.interval) {
    throw coordinatorError('epoch_boundary_not_reached',
      'block_interval requires the configured experiment interval', 1);
  }
  if (reason === 'tier3_expansion'
      && !events.some((event) => plainObject(event)
        && event.event === 'evaluator_expanded' && event.epoch === epoch
        && event.trigger_generation === session.outer_loop.generation)) {
    throw coordinatorError('epoch_boundary_not_reached',
      'tier3_expansion requires authenticated evaluator expansion authority', 1);
  }
  const q = deriveQ(blockTerminals, blockTerminals,
    blockTerminals.length === 0 ? 'failed' : 'completed');
  return { epoch, scanned, terminalEvents, blockTerminals, ...q };
}

function applyEpochBoundary(session, boundary, { operationId: operationIdentity, reason, now }) {
  operationId(operationIdentity);
  const next = structuredClone(session);
  const generation = next.outer_loop.generation + 1;
  const fromEpoch = boundary.epoch;
  const toEpoch = fromEpoch + 1;
  next.status = 'paused';
  next.outer_loop.generation = generation;
  next.outer_loop.inner_count = 0;
  next.outer_loop.q_history.push({ generation, Q: boundary.Q, epoch: fromEpoch });
  const currentHistory = next.evaluation_epoch.history.at(-1);
  currentHistory.generations.push(generation);
  currentHistory.best_Q = currentHistory.best_Q === null
    ? boundary.Q : Math.max(currentHistory.best_Q, boundary.Q);
  next.evaluation_epoch.current = toEpoch;
  next.evaluation_epoch.history.push({
    epoch: toEpoch,
    prepare_version: currentHistory.prepare_version,
    generations: [],
    best_Q: null,
    created_at: now,
  });
  const common = {
    operation_id: operationIdentity,
    completed_block_ids: structuredClone(boundary.scanned.ordered),
    generation,
    q_components: structuredClone(boundary.components),
    Q: boundary.Q,
    reason,
    ts: now,
  };
  return {
    session: next,
    events: [{
      event: 'outer_loop',
      ...common,
      epoch: fromEpoch,
    }, {
      event: 'evaluation_epoch_advanced',
      ...common,
      from_epoch: fromEpoch,
      to_epoch: toEpoch,
    }],
    result: {
      route: 'outer-loop',
      from_epoch: fromEpoch,
      to_epoch: toEpoch,
      generation,
      Q: boundary.Q,
      components: structuredClone(boundary.components),
    },
  };
}

module.exports = {
  EPOCH_REASONS,
  FINISH_STATUSES,
  applyEpochBoundary,
  assertSummaryMatches,
  beginSeedBlock,
  buildFinishEvent,
  coordinatorError,
  deriveEpochBoundary,
  deriveFinishEvidence,
  deriveQ,
  deterministicBlockId,
  qFromComponents,
  scanBlocks,
  validateSummary,
};
