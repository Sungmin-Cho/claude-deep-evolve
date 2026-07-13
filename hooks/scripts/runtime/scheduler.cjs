'use strict';

const ALLOWED_BLOCK = Object.freeze([1, 2, 3, 5, 8]);
const ALLOWED_DECISION = new Set(['schedule', 'kill_then_schedule', 'grow_then_schedule']);
const FAILED_STATUSES = new Set(['discarded', 'diagnosed_gave_up', 'flagged_unexplained']);
const CONDITION_ORDER = Object.freeze([
  'crash_give_up',
  'sustained_regression',
  'shortcut_quarantine',
  'budget_exhausted_underperform',
  'user_requested',
]);

function runtimeError(code, message, rc = 2, details) {
  const error = Object.assign(new Error(message), { code, rc });
  if (details !== undefined) error.details = details;
  return error;
}

function operatorError(code, message, details) {
  throw runtimeError(code, message, 2, details);
}

function businessError(code, message, details) {
  throw runtimeError(code, message, 1, details);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requireObject(value, label) {
  if (!plainObject(value)) operatorError('invalid_object', `${label} must be a plain object`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) operatorError('invalid_field_type', `${label} must be a list`);
  return value;
}

function requireInteger(value, label, { min, allowIntegral = true } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)
      || (!allowIntegral && !Number.isSafeInteger(value))
      || (min !== undefined && value < min)) {
    operatorError('invalid_field_type', `${label} must be ${min === 0 ? 'a non-negative ' : min === 1 ? 'a positive ' : 'an '}integer (not bool)`);
  }
  return value;
}

function requireNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    operatorError('invalid_field_type', `${label} must be a finite number (not bool)`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') operatorError('invalid_field_type', `${label} must be bool`);
  return value;
}

function round(value, places) {
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function eventType(event) {
  return plainObject(event) ? (event.event || event.status) : undefined;
}

function entropy(events, windowSize = 20) {
  requireArray(events, 'events');
  requireInteger(windowSize, 'window_size', { min: 0 });
  const planned = [];
  for (const event of events) {
    if (plainObject(event) && event.status === 'planned' && event.idea_category) planned.push(event.idea_category);
  }
  const recent = planned.slice(-windowSize);
  const active = new Set(recent).size;
  if (recent.length < 5) {
    return { entropy_bits: null, active_categories: active, reason: 'insufficient_sample', sample_size: recent.length };
  }
  const counts = new Map();
  for (const category of recent) counts.set(category, (counts.get(category) || 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / recent.length;
    bits -= probability * Math.log2(probability);
  }
  return { entropy_bits: round(bits, 6), active_categories: counts.size, sample_size: recent.length };
}

function migrateV2Weights(value) {
  const v2 = requireObject(value, 'weights');
  for (const key of ['parameter_tuning', 'simplification', 'algorithm_swap', 'structural_change']) {
    if (v2[key] !== undefined) requireNumber(v2[key], key);
  }
  const floor = 0.05;
  const structural = v2.structural_change || 0;
  const pre = {
    parameter_tune: v2.parameter_tuning || 0,
    refactor_simplify: v2.simplification || 0,
    algorithm_swap: v2.algorithm_swap || 0,
    add_guard: structural / 3,
    api_redesign: structural / 3,
    error_handling: structural / 3,
    data_preprocessing: floor,
    caching_memoization: floor,
    test_expansion: floor,
    other: floor,
  };
  const total = Object.values(pre).reduce((sum, number) => sum + number, 0);
  const weights = {};
  for (const [key, number] of Object.entries(pre)) weights[key] = total > 0 ? number / total : 0.1;
  return { weights, pre_normalize_sum: round(total, 6) };
}

function countFlagged(events) {
  requireArray(events, 'events');
  let lastReset = -1;
  for (let index = 0; index < events.length; index += 1) {
    const type = plainObject(events[index]) ? events[index].event : undefined;
    if (type === 'shortcut_escalation' || type === 'tier3_flagged_reset') lastReset = index;
  }
  let count = 0;
  for (const event of events.slice(lastReset + 1)) {
    if (plainObject(event) && event.event === 'shortcut_flagged') count += 1;
  }
  return { count, last_reset_idx: lastReset };
}

function retryBudget(events, cap = 10) {
  requireArray(events, 'events');
  requireInteger(cap, 'cap', { min: 0 });
  const used = events.filter((event) => plainObject(event) && event.event === 'diagnose_retry_started').length;
  return { used, remaining: Math.max(0, cap - used), cap };
}

function initBudgetSplit(total, n) {
  requireInteger(total, 'total', { min: 0 });
  requireInteger(n, 'N', { min: 1 });
  const base = Math.floor(total / n);
  if (base < 3) businessError('insufficient_budget', `insufficient: each seed would get ${base} experiments (below P3 floor 3)`);
  const remainder = total - (base * n);
  return Array.from({ length: n }, (_, index) => index < n - remainder ? base : base + 1);
}

function growAllocation(pool, nCurrent) {
  requireInteger(pool, 'pool', { min: 0 });
  requireInteger(nCurrent, 'current_N', { min: 1 });
  const allocation = Math.max(Math.ceil(pool / (2 * nCurrent)), 3);
  if (pool < 3 || pool < allocation) businessError('insufficient_budget', `insufficient: pool=${pool} is below P3 floor or allocation=${allocation}`);
  return allocation;
}

function normalizeSeedIdentity(seed) {
  requireObject(seed, 'seed entry');
  const aliases = [];
  for (const key of ['id', 'seed_id']) {
    if (!Object.hasOwn(seed, key)) continue;
    const value = seed[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      operatorError('invalid_seed_identity', `seed ${key} must be an integral number`);
    }
    if (value <= 0) operatorError('invalid_seed_identity', `seed ${key} must be positive`);
    aliases.push(value);
  }
  if (aliases.length === 0) operatorError('invalid_seed_identity', 'seed entry is missing id/seed_id');
  if (aliases.some((value) => value !== aliases[0])) operatorError('invalid_seed_identity', 'seed id and seed_id conflict');
  return aliases[0];
}

function activeSeedState(session) {
  requireObject(session, 'session');
  const vp = session.virtual_parallel || {};
  requireObject(vp, 'virtual_parallel');
  const seeds = vp.seeds || [];
  requireArray(seeds, 'virtual_parallel.seeds');
  const markerPresent = Object.hasOwn(vp, 'x-active-seed-count');
  if (markerPresent && vp['x-active-seed-count'] !== 0) {
    operatorError('invalid_active_seed_state', 'x-active-seed-count must be the integer 0');
  }
  if (markerPresent && Object.hasOwn(vp, 'n_current')) {
    operatorError('invalid_active_seed_state', 'x-active-seed-count and n_current cannot coexist');
  }
  const seen = new Set();
  let missingStatus = false;
  let schedulable = [];
  for (const seed of seeds) {
    const identity = normalizeSeedIdentity(seed);
    if (seen.has(identity)) operatorError('duplicate_seed_identity', `duplicate seed identity: ${identity}`);
    seen.add(identity);
    if (!Object.hasOwn(seed, 'status')) missingStatus = true;
    if ((seed.status || 'active') === 'active') schedulable.push(identity);
  }
  if (markerPresent && (schedulable.length > 0 || missingStatus)) {
    operatorError('invalid_active_seed_state', 'x-active-seed-count: 0 requires explicit non-active seed statuses');
  }
  const legacyZero = vp.n_current === 0;
  const zeroActive = markerPresent || legacyZero || schedulable.length === 0;
  if (zeroActive) schedulable = [];
  return {
    active_seed_count: schedulable.length,
    schedulable_seed_ids: schedulable,
    zero_active: zeroActive,
  };
}

function firstLastDeltaTrend(values) {
  if (values.length < 2) return 'flat';
  const delta = values[values.length - 1] - values[0];
  if (delta > 0.02) return 'up';
  if (delta < -0.02) return 'down';
  return 'flat';
}

function numericQ(event, evaluatedByKey) {
  const q = event.q !== undefined ? event.q : event.score;
  if (typeof q === 'number' && Number.isFinite(q)) return q;
  const fallback = evaluatedByKey.get(`${event.seed_id}\u0000${event.id}`);
  return typeof fallback === 'number' ? fallback : 0;
}

function collectSchedulerSignals(session, journalEvents, forumEvents) {
  requireObject(session, 'session');
  requireArray(journalEvents, 'journal');
  requireArray(forumEvents, 'forum');
  const vp = session.virtual_parallel || {};
  requireObject(vp, 'virtual_parallel');
  const seeds = vp.seeds || [];
  requireArray(seeds, 'virtual_parallel.seeds');
  const canonical = activeSeedState(session);
  const evaluated = new Map();
  for (const event of journalEvents) {
    if (!plainObject(event) || eventType(event) !== 'evaluated') continue;
    const score = event.score !== undefined ? event.score : event.q;
    if (event.seed_id !== undefined && event.id !== undefined && typeof score === 'number' && Number.isFinite(score)) {
      evaluated.set(`${event.seed_id}\u0000${event.id}`, score);
    }
  }
  const perSeed = [];
  for (const seed of seeds) {
    const identity = normalizeSeedIdentity(seed);
    const kept = journalEvents.filter((event) => plainObject(event) && eventType(event) === 'kept' && event.seed_id === identity);
    const qValues = kept.map((event) => numericQ(event, evaluated)).slice(-5);
    const lastEvents = journalEvents.filter((event) => plainObject(event) && event.seed_id === identity).slice(-3).map(eventType);
    const experiments = seed.experiments_used || 0;
    perSeed.push({
      id: identity,
      status: seed.status || 'active',
      direction: seed.direction === undefined ? null : seed.direction,
      recent_Q_trend: firstLastDeltaTrend(qValues),
      last_events: lastEvents,
      experiments_used: experiments,
      experiments_used_this_epoch: seed.experiments_used_this_epoch === undefined ? experiments : seed.experiments_used_this_epoch,
      keeps: seed.keeps || 0,
      borrows_given: seed.borrows_given || 0,
      borrows_received: seed.borrows_received || 0,
      current_q: seed.current_q || 0,
      allocated_budget: seed.allocated_budget || 0,
      remaining_budget: (seed.allocated_budget || 0) - experiments,
      independent_exploration_satisfied: experiments >= 3,
      convergence_indicators: null,
    });
  }
  const inFlight = new Map();
  for (const event of journalEvents) {
    if (!plainObject(event)) continue;
    const type = eventType(event);
    if (type === 'seed_scheduled' && event.chosen_seed_id !== undefined) inFlight.set(event.chosen_seed_id, true);
    if ((type === 'seed_block_completed' || type === 'seed_block_failed') && event.seed_id !== undefined) inFlight.set(event.seed_id, false);
  }
  for (const seed of perSeed) seed.in_flight_block = inFlight.get(seed.id) || false;

  const times = [...new Set(journalEvents.filter(plainObject).map((event) => event.ts).filter(Boolean))].sort().slice(-10);
  const bestSeries = [];
  for (const timestamp of times) {
    const perId = new Map();
    for (const event of journalEvents) {
      if (!plainObject(event) || (event.ts || '') > timestamp || eventType(event) !== 'kept') continue;
      const q = numericQ(event, evaluated);
      perId.set(event.seed_id, Math.max(perId.get(event.seed_id) || 0, q));
    }
    if (perId.size > 0) bestSeries.push(Math.max(...perId.values()));
  }
  const schedules = journalEvents.filter((event) => plainObject(event) && eventType(event) === 'seed_scheduled');
  const recentBoundary = schedules.slice(-5)[0];
  const recentForum = recentBoundary
    ? forumEvents.filter((event) => plainObject(event) && (event.ts || '') >= (recentBoundary.ts || ''))
    : forumEvents.filter(plainObject);
  return {
    seeds: perSeed,
    session_Q_trend: firstLastDeltaTrend(bestSeries),
    entropy_current: null,
    flagged_rate: journalEvents.filter((event) => plainObject(event) && eventType(event) === 'shortcut_flagged').length,
    forum_activity: recentForum.length,
    budget_unallocated: vp.budget_unallocated || 0,
    n_current: canonical.zero_active ? 0 : (vp.n_current === undefined ? seeds.length : vp.n_current),
    ...canonical,
  };
}

function nearestAllowed(number) {
  if (number < ALLOWED_BLOCK[0]) return ALLOWED_BLOCK[0];
  if (number > ALLOWED_BLOCK[ALLOWED_BLOCK.length - 1]) return ALLOWED_BLOCK[ALLOWED_BLOCK.length - 1];
  let best = ALLOWED_BLOCK[0];
  let distance = Math.abs(number - best);
  for (const candidate of ALLOWED_BLOCK.slice(1)) {
    const next = Math.abs(number - candidate);
    if (next < distance) { best = candidate; distance = next; }
  }
  return best;
}

function coerceBlockInteger(value, label) {
  if (value === null || !['number', 'string', 'boolean'].includes(typeof value)) {
    operatorError('invalid_field_type', `${label} must be int`);
  }
  if (typeof value === 'string' && !/^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) {
    operatorError('invalid_field_type', `${label} must be int`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) operatorError('invalid_field_type', `${label} must be int`);
  return Math.trunc(number);
}

function decisionRejection(decision, reason) {
  return { accepted: false, decision, reason, rc: 1 };
}

function decideScheduler(value, signals = null) {
  const decision = requireObject(value, 'decision');
  const required = ['decision', 'chosen_seed_id', 'block_size', 'reasoning', 'signals_used'];
  const missing = required.filter((key) => !Object.hasOwn(decision, key));
  if (missing.length) operatorError('missing_required_field', `missing required fields: ${missing.join(', ')}`);
  if (!ALLOWED_DECISION.has(decision.decision)) operatorError('invalid_decision', `invalid decision type: ${String(decision.decision)}`);
  requireInteger(decision.chosen_seed_id, 'chosen_seed_id');
  if (decision.decision === 'kill_then_schedule') {
    if (decision.kill_target === null || decision.kill_target === undefined) operatorError('missing_required_field', 'kill_then_schedule requires non-null kill_target');
    requireInteger(decision.kill_target, 'kill_then_schedule.kill_target');
  }
  if (decision.decision === 'grow_then_schedule') {
    if (decision.new_seed_id === null || decision.new_seed_id === undefined) operatorError('missing_required_field', 'grow_then_schedule requires non-null new_seed_id');
    requireInteger(decision.new_seed_id, 'grow_then_schedule.new_seed_id');
  }
  if (signals !== null) {
    requireObject(signals, 'signals');
    let ids = signals.schedulable_seed_ids;
    if (ids === undefined) {
      ids = Array.isArray(signals.seeds) ? signals.seeds.filter((seed) => plainObject(seed) && seed.status === 'active').map((seed) => seed.id) : [];
    }
    requireArray(ids, 'signals.schedulable_seed_ids');
    if (!ids.includes(decision.chosen_seed_id)) {
      return decisionRejection(decision.decision, `chosen_seed_id (${decision.chosen_seed_id}) is not an active schedulable seed; active ids are ${JSON.stringify(ids)}`);
    }
  }
  if (decision.decision === 'kill_then_schedule' && decision.kill_target === decision.chosen_seed_id) {
    return decisionRejection(decision.decision, `kill_target (${decision.kill_target}) must differ from chosen_seed_id (${decision.chosen_seed_id})`);
  }
  if (decision.decision === 'grow_then_schedule' && decision.new_seed_allocation !== null && decision.new_seed_allocation !== undefined) {
    if (!Number.isInteger(decision.new_seed_allocation) || decision.new_seed_allocation < 3) {
      return decisionRejection(decision.decision, `new_seed_allocation (${String(decision.new_seed_allocation)}) below P3_floor (3)`);
    }
  }
  const original = coerceBlockInteger(decision.block_size, 'block_size');
  const blockSize = ALLOWED_BLOCK.includes(original) ? original : nearestAllowed(original);
  const result = {
    accepted: true,
    decision: decision.decision,
    chosen_seed_id: decision.chosen_seed_id,
    block_size: blockSize,
    original_block_size: original,
    clamped: blockSize !== original,
    reasoning: decision.reasoning,
    signals_used: decision.signals_used,
    kill_target: decision.kill_target === undefined ? null : decision.kill_target,
    new_seed_id: decision.new_seed_id === undefined ? null : decision.new_seed_id,
    new_seed_allocation: decision.new_seed_allocation === undefined ? null : decision.new_seed_allocation,
    new_seed_direction: decision.new_seed_direction === undefined ? null : decision.new_seed_direction,
    journal_events_to_append: [],
  };
  if (result.clamped) {
    result.journal_events_to_append.push({
      event: 'block_size_adjusted', seed_id: decision.chosen_seed_id,
      original, clamped: blockSize, decision_id: null,
    });
  }
  if (signals !== null) {
    const seeds = Array.isArray(signals.seeds) ? signals.seeds : [];
    const starved = seeds.filter((seed) => plainObject(seed)
      && seed.id !== decision.chosen_seed_id
      && seed.status === 'active'
      && (seed.experiments_used_this_epoch || 0) === 0).map((seed) => seed.id);
    result.fairness_violation = starved.length > 0;
    result.starved_seed_ids = starved;
    const target = decision.decision === 'kill_then_schedule'
      ? seeds.find((seed) => plainObject(seed) && seed.id === decision.kill_target)
      : null;
    result.kill_deferred = Boolean(target && target.in_flight_block);
  }
  return result;
}

function requireKillPayload(payload) {
  requireObject(payload, 'args');
  for (const key of ['seed', 'session', 'ai_judgments']) {
    if (!Object.hasOwn(payload, key)) operatorError('missing_required_field', `missing required top-level field: ${key}`);
  }
  const seed = requireObject(payload.seed, 'seed');
  const session = requireObject(payload.session, 'session');
  const ai = requireObject(payload.ai_judgments, 'ai_judgments');
  for (const key of ['id', 'experiments_used', 'current_q', 'q_history', 'evaluated_events', 'flagged_keeps_count', 'diagnosed_gave_up_experiment_count', 'budget_remaining']) {
    if (!Object.hasOwn(seed, key)) operatorError('missing_required_field', `missing required seed field: ${key}`);
  }
  for (const key of ['median_q', 'std_q', 'shortcut_quarantine_threshold']) {
    if (!Object.hasOwn(session, key)) operatorError('missing_required_field', `missing required session field: ${key}`);
  }
  for (const key of ['direction_unrecoverable', 'shortcut_prone']) {
    if (!Object.hasOwn(ai, key)) operatorError('missing_required_field', `missing required ai_judgments field: ${key}`);
  }
  for (const key of ['id', 'experiments_used', 'flagged_keeps_count', 'diagnosed_gave_up_experiment_count', 'budget_remaining']) requireInteger(seed[key], `seed.${key}`);
  requireNumber(seed.current_q, 'seed.current_q');
  requireArray(seed.q_history, 'seed.q_history').forEach((value, index) => requireNumber(value, `seed.q_history[${index}]`));
  requireArray(seed.evaluated_events, 'seed.evaluated_events').forEach((event, index) => {
    requireObject(event, `seed.evaluated_events[${index}]`);
    if (typeof event.status !== 'string') operatorError('invalid_field_type', `seed.evaluated_events[${index}].status must be string`);
  });
  requireNumber(session.median_q, 'session.median_q');
  requireNumber(session.std_q, 'session.std_q');
  requireInteger(session.shortcut_quarantine_threshold, 'session.shortcut_quarantine_threshold');
  requireBoolean(ai.direction_unrecoverable, 'ai_judgments.direction_unrecoverable');
  requireBoolean(ai.shortcut_prone, 'ai_judgments.shortcut_prone');
  if (payload.user_kill_request !== null && payload.user_kill_request !== undefined) {
    requireObject(payload.user_kill_request, 'user_kill_request');
    if (!Object.hasOwn(payload.user_kill_request, 'confirmed')) operatorError('missing_required_field', 'user_kill_request.confirmed is required');
    requireBoolean(payload.user_kill_request.confirmed, 'user_kill_request.confirmed');
  }
}

function sustainedRegression(seed) {
  const peak = seed.q_history.length ? Math.max(...seed.q_history) : 0;
  if (seed.experiments_used < 5) return { triggered: false, failed_clause: 1, reasoning: `experiments_used=${seed.experiments_used} < 5 (Clause 1)`, peak_q: peak, drop_pct: 0 };
  const last = seed.evaluated_events.slice(-5);
  if (last.length < 5) operatorError('invalid_kill_snapshot', `seed.experiments_used=${seed.experiments_used} >= 5 but caller must aggregate at least 5 evaluated events`);
  if (!last.every((event) => FAILED_STATUSES.has(event.status))) {
    const bad = last.filter((event) => !FAILED_STATUSES.has(event.status)).map((event) => event.status);
    return { triggered: false, failed_clause: 2, reasoning: `last 5 evaluated events include non-failed statuses: ${JSON.stringify(bad)}`, peak_q: peak, drop_pct: 0 };
  }
  const drop = (peak - seed.current_q) / Math.max(peak, 1e-9);
  if (seed.current_q >= peak) return { triggered: false, failed_clause: 4, reasoning: 'recovery observed', peak_q: peak, drop_pct: drop };
  if (drop <= 0.2) return { triggered: false, failed_clause: 3, reasoning: 'Q drop is <= 20%', peak_q: peak, drop_pct: drop };
  return { triggered: true, failed_clause: null, reasoning: 'all 4 clauses satisfied', peak_q: peak, drop_pct: drop };
}

function evaluateKillConditions(payload) {
  requireKillPayload(payload);
  const { seed, session, ai_judgments: ai } = payload;
  const crash = seed.diagnosed_gave_up_experiment_count >= 2 && ai.direction_unrecoverable;
  const regression = sustainedRegression(seed);
  const shortcut = seed.flagged_keeps_count >= session.shortcut_quarantine_threshold && ai.shortcut_prone;
  const threshold = round(session.median_q - (2 * session.std_q), 10);
  const exhausted = seed.budget_remaining <= 0 && seed.current_q < threshold;
  const requested = payload.user_kill_request === null || payload.user_kill_request === undefined
    ? false : payload.user_kill_request.confirmed;
  const details = {
    crash_give_up: { triggered: crash, reasoning: crash ? 'threshold and AI judgment satisfied' : 'threshold or AI judgment not satisfied' },
    sustained_regression: regression,
    shortcut_quarantine: { triggered: shortcut, reasoning: shortcut ? 'threshold and AI judgment satisfied' : 'threshold or AI judgment not satisfied' },
    budget_exhausted_underperform: { triggered: exhausted, reasoning: exhausted ? 'budget exhausted and Q below threshold' : 'condition not satisfied', threshold_q: threshold },
    user_requested: { triggered: requested, requested_at: payload.user_kill_request ? payload.user_kill_request.requested_at || null : null },
  };
  const conditions = CONDITION_ORDER.filter((name) => details[name].triggered);
  return { seed_id: seed.id, killable: conditions.length > 0, conditions_met: conditions, details };
}

function borrowPreflight(payload) {
  requireObject(payload, 'args');
  for (const key of ['self_seed_id', 'self_experiments_used', 'candidates', 'journal', 'forum']) {
    if (!Object.hasOwn(payload, key)) operatorError('missing_required_field', `missing required field: ${key}`);
  }
  const self = requireInteger(payload.self_seed_id, 'self_seed_id');
  const used = requireInteger(payload.self_experiments_used, 'self_experiments_used');
  const candidates = requireArray(payload.candidates, 'candidates');
  const journal = requireArray(payload.journal, 'journal');
  const forum = requireArray(payload.forum, 'forum');
  const output = { eligible: [], skipped: [], p3_gate_open: used >= 3, self_seed_id: self };
  if (!output.p3_gate_open) {
    for (const candidate of candidates) {
      requireObject(candidate, 'candidate');
      output.skipped.push({ source_commit: candidate.commit, candidate_seed: candidate.seed_id, reason: 'p3_floor' });
    }
    return output;
  }
  const planned = new Set(journal.filter(plainObject).filter((event) => event.event === 'borrow_planned' && event.seed_id === self && event.source_commit).map((event) => event.source_commit));
  const executed = new Set(forum.filter(plainObject).filter((event) => event.event === 'cross_seed_borrow' && event.to_seed === self && event.source_commit).map((event) => event.source_commit));
  for (const candidate of candidates) {
    requireObject(candidate, 'candidate');
    let reason = null;
    if (candidate.seed_id === self) reason = 'self_seed';
    else if (!candidate.commit) reason = 'missing_source_commit';
    else if (candidate.flagged) reason = 'p2_flagged';
    else if (!candidate.legibility_passed) reason = 'p2_legibility';
    else if (planned.has(candidate.commit)) reason = 'dedup_planned';
    else if (executed.has(candidate.commit)) reason = 'dedup_executed';
    if (reason) output.skipped.push({ source_commit: candidate.commit, candidate_seed: candidate.seed_id, reason });
    else output.eligible.push(candidate);
  }
  return output;
}

function findBorrowAbandoned(events, currentBlockId, stalenessBlocks = 2) {
  requireArray(events, 'events');
  requireInteger(currentBlockId, 'current_block_id');
  requireInteger(stalenessBlocks, 'staleness_blocks', { min: 0 });
  const planned = new Map();
  const executed = new Set();
  const abandoned = new Set();
  const keyFor = (seed, commit) => `${String(seed)}\u0000${String(commit)}`;
  for (const event of events) {
    if (!plainObject(event)) continue;
    if (event.event === 'borrow_planned') {
      const key = keyFor(event.seed_id, event.source_commit);
      planned.set(key, { seed: event.seed_id, commit: event.source_commit, block: Math.max(planned.get(key)?.block ?? -1, event.block_id ?? -1) });
    } else if (event.event === 'cross_seed_borrow') executed.add(keyFor(event.to_seed, event.source_commit));
    else if (event.event === 'borrow_abandoned') abandoned.add(keyFor(event.seed_id, event.source_commit));
  }
  const output = [];
  for (const [key, plan] of planned) {
    if (executed.has(key) || abandoned.has(key) || currentBlockId - plan.block <= stalenessBlocks) continue;
    output.push({
      event: 'borrow_abandoned', seed_id: plan.seed, source_commit: plan.commit,
      reason: 'stale_no_execution', originally_planned_at_block: plan.block,
      detected_at_block: currentBlockId,
    });
  }
  return { abandoned_events: output };
}

class UnionFind {
  constructor() { this.parent = new Map(); }
  add(value) { if (!this.parent.has(value)) this.parent.set(value, value); }
  find(value) {
    this.add(value);
    let root = value;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let current = value;
    while (this.parent.get(current) !== root) {
      const next = this.parent.get(current);
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }
  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(leftRoot, rightRoot);
  }
  groups() {
    const groups = new Map();
    for (const item of this.parent.keys()) {
      const root = this.find(item);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(item);
    }
    return [...groups.values()];
  }
}

function ancestrySet(commit, inspired, forum) {
  const visited = new Set([commit]);
  const frontier = [commit];
  const edges = new Map();
  for (const event of forum) if (plainObject(event) && event.target_commit && event.source_commit) edges.set(event.target_commit, event.source_commit);
  while (frontier.length) {
    const current = frontier.pop();
    for (const parent of [inspired[current], edges.get(current)]) {
      if (parent && !visited.has(parent)) { visited.add(parent); frontier.push(parent); }
    }
  }
  return visited;
}

function classifyConvergence(payload) {
  requireObject(payload, 'args');
  for (const key of ['keeps', 'similarities', 'inspired_by_map', 'cross_seed_borrow_events']) {
    if (!Object.hasOwn(payload, key)) operatorError('missing_required_field', `missing required field: ${key}`);
  }
  const keeps = requireArray(payload.keeps, 'keeps');
  const similarities = requireArray(payload.similarities, 'similarities');
  const inspired = requireObject(payload.inspired_by_map, 'inspired_by_map');
  const forum = requireArray(payload.cross_seed_borrow_events, 'cross_seed_borrow_events');
  const threshold = payload.threshold === undefined ? 0.85 : requireNumber(payload.threshold, 'threshold');
  const p3 = payload.p3_floor === undefined ? 3 : requireInteger(payload.p3_floor, 'p3_floor');
  const epoch = payload.epoch === undefined ? 0 : requireInteger(payload.epoch, 'epoch');
  const byCommit = new Map();
  for (let index = 0; index < keeps.length; index += 1) {
    const keep = requireObject(keeps[index], `keeps[${index}]`);
    requireInteger(keep.seed_id, `keeps[${index}].seed_id`);
    if (typeof keep.commit !== 'string' || !keep.commit) operatorError('invalid_field_type', `keeps[${index}].commit must be non-empty string`);
    byCommit.set(keep.commit, keep);
  }
  const union = new UnionFind();
  for (const commit of byCommit.keys()) union.add(commit);
  for (let index = 0; index < similarities.length; index += 1) {
    const similarity = requireObject(similarities[index], `similarities[${index}]`);
    if (!byCommit.has(similarity.commit_a) || !byCommit.has(similarity.commit_b)) continue;
    if (byCommit.get(similarity.commit_a).seed_id === byCommit.get(similarity.commit_b).seed_id) continue;
    const score = similarity.score === undefined ? 0 : requireNumber(similarity.score, `similarities[${index}].score`);
    if (score >= threshold) union.union(similarity.commit_a, similarity.commit_b);
  }
  const events = [];
  for (const group of union.groups()) {
    const cluster = group.map((commit) => byCommit.get(commit));
    const seedIds = [...new Set(cluster.map((keep) => keep.seed_id))].sort((a, b) => a - b);
    if (seedIds.length < 2) continue;
    const ancestries = cluster.map((keep) => ancestrySet(keep.commit, inspired, forum));
    let shared = new Set(ancestries[0]);
    for (const ancestry of ancestries.slice(1)) shared = new Set([...shared].filter((item) => ancestry.has(item)));
    const allP3 = cluster.every((keep) => (keep.experiments_used_before_keep || 0) >= p3);
    const judged = !allP3 ? 'contagion_suspected' : shared.size ? 'borrow_chain_convergence' : 'evidence_based';
    events.push({
      event: 'convergence_event', seed_ids: seedIds,
      cluster_commits: cluster.map((keep) => keep.commit),
      direction: (cluster[0].description || '').trim() || null,
      trigger: `semantic similarity >= ${threshold}`,
      judged_as: judged,
      shared_ancestors: [...shared].sort(),
      epoch,
    });
  }
  return { convergence_events: events };
}

module.exports = {
  ALLOWED_BLOCK,
  ALLOWED_DECISION,
  CONDITION_ORDER,
  entropy,
  migrateV2Weights,
  countFlagged,
  retryBudget,
  initBudgetSplit,
  growAllocation,
  collectSchedulerSignals,
  decideScheduler,
  evaluateKillConditions,
  borrowPreflight,
  findBorrowAbandoned,
  classifyConvergence,
};
