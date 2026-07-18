'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SYNTHESIS_PATH = require.resolve('../hooks/scripts/runtime/synthesis.cjs');
const {
  validateSynthesisChoice,
  renderFallbackNote,
  finalizeSynthesis,
} = require(SYNTHESIS_PATH);
const { dispatch, OPERATIONS } = require('../hooks/scripts/deep-evolve-runtime.cjs');

const CASES = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'synthesis-choice-cases.json'),
  'utf8',
));
const START_FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'runtime', 'session-start-v3.5.json'),
  'utf8',
));

function makeProject(t, label = 'evolve synthesis choices ') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), label)));
  fs.mkdirSync(path.join(root, '.deep-evolve', '.runtime-requests'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function request(projectRoot, operation, payload) {
  return dispatch({
    schema_version: '1.0',
    operation,
    context: { project_root: projectRoot },
    payload,
  });
}

function startSession(projectRoot) {
  const started = request(projectRoot, 'session.start', {
    goal: 'semantic synthesis choices',
    initial_state: structuredClone(START_FIXTURE.initial_state),
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  return started.result;
}

function capturedError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected an error');
}

test('the interaction contract exposes only three stable semantic option IDs', () => {
  assert.equal(CASES.interaction_id, 'synthesis-regression-action');
  assert.deepEqual(CASES.options, ['accept-regression', 'keep-baseline', 'stop']);
  assert.equal(typeof validateSynthesisChoice, 'function');
  for (const choice of CASES.options) {
    assert.equal(validateSynthesisChoice(choice, 'finalize'), choice);
  }
});

test('pure finalization returns every exact deterministic and prompt-window result', () => {
  for (const row of CASES.finalize_cases) {
    assert.deepEqual(finalizeSynthesis(structuredClone(row.input)), row.expected, row.name);
  }
});

test('dispatcher finalization preserves exact result and rc boundaries without state writes', (t) => {
  const projectRoot = makeProject(t);
  const before = fs.readdirSync(path.join(projectRoot, '.deep-evolve')).sort();
  for (const row of CASES.finalize_cases) {
    const response = request(projectRoot, 'synthesis.finalize', structuredClone(row.input));
    assert.equal(response.exitCode, 0, `${row.name}: ${JSON.stringify(response)}`);
    assert.deepEqual(response.result, row.expected, row.name);
  }
  for (const row of CASES.error_cases) {
    const response = request(projectRoot, 'synthesis.finalize', structuredClone(row.input));
    assert.equal(response.exitCode, row.exit_code, `${row.name}: ${JSON.stringify(response)}`);
    assert.equal(response.error.code, row.code, row.name);
  }
  assert.deepEqual(fs.readdirSync(path.join(projectRoot, '.deep-evolve')).sort(), before);
});

test('numeric, ordinal, translated, padded, empty, and non-string choices are rc 2', (t) => {
  const invalid = [...CASES.invalid_choices, 1, 2, 3, null, true, [], {}];
  const prompt = {
    n: 2,
    baseline_q: 0.8,
    synthesis_q: 0.77,
    regression_tolerance: 0.05,
  };
  const projectRoot = makeProject(t);
  for (const choice of invalid) {
    const pure = capturedError(() => finalizeSynthesis({ ...prompt, user_choice: choice }));
    assert.equal(pure.rc, 2, JSON.stringify(choice));
    assert.equal(pure.code, 'invalid_synthesis_choice', JSON.stringify(choice));
    const response = request(projectRoot, 'synthesis.finalize', {
      ...prompt,
      user_choice: structuredClone(choice),
    });
    assert.equal(response.exitCode, 2, `${JSON.stringify(choice)}: ${JSON.stringify(response)}`);
    assert.equal(response.error.code, 'invalid_synthesis_choice', JSON.stringify(choice));
  }
});

test('malformed numeric authority and stale semantic choices fail with exact operator codes', (t) => {
  for (const n of [true, -1, 1.5]) {
    const error = capturedError(() => finalizeSynthesis({ n }));
    assert.equal(error.rc, 2);
    assert.equal(error.code, 'invalid_integer');
  }
  for (const input of [
    { n: 2, baseline_q: Number.NaN, synthesis_q: 0.7, regression_tolerance: 0.05 },
    { n: 2, baseline_q: 0.8, synthesis_q: Number.POSITIVE_INFINITY, regression_tolerance: 0.05 },
  ]) {
    const error = capturedError(() => finalizeSynthesis(input));
    assert.equal(error.rc, 2);
    assert.equal(error.code, 'invalid_number');
  }
  const projectRoot = makeProject(t);
  const unknown = request(projectRoot, 'synthesis.finalize', {
    n: 2,
    baseline_q: 0.8,
    synthesis_q: 0.77,
    regression_tolerance: 0.05,
    choice_id: 'accept-regression',
  });
  assert.equal(unknown.exitCode, 2, JSON.stringify(unknown));
  assert.equal(unknown.error.code, 'unknown_payload_field');
});

test('fallback note classifications render exact deterministic markdown bytes', () => {
  for (const row of CASES.fallback_notes) {
    const first = renderFallbackNote({
      session: structuredClone(CASES.session),
      ...structuredClone(row.input),
    });
    const second = renderFallbackNote({
      session: structuredClone(CASES.session),
      ...structuredClone(row.input),
    });
    assert.equal(first, row.expected_markdown, row.name);
    assert.equal(second, row.expected_markdown, `${row.name} replay`);
    assert.equal(first.endsWith('\n'), true, row.name);
    assert.doesNotMatch(first, /Branch B option|option [123]|\([123]\)|합성 채택|최고 seed 채택|원래 main 유지/);
  }
});

test('fallback note rejects non-classifications and incompatible Q shapes without coercion', () => {
  const base = {
    session: structuredClone(CASES.session),
    baseline_reasoning: { chosen_seed_id: 1, tier: 'preferred', ties_broken_on: [] },
  };
  for (const user_choice of [undefined, 'accept-regression', 'stop', '1', 1, '', null]) {
    const error = capturedError(() => renderFallbackNote({
      ...base,
      synthesis_q: 0.7,
      baseline_q: 0.8,
      ...(user_choice === undefined ? {} : { user_choice }),
    }));
    assert.equal(error.rc, 2, JSON.stringify(user_choice));
    assert.equal(error.code, 'invalid_synthesis_classification', JSON.stringify(user_choice));
  }
  for (const row of [
    { user_choice: 'keep-baseline', synthesis_q: null, baseline_q: 0.8 },
    { user_choice: 'automatic-fallback', synthesis_q: null, baseline_q: 0.8 },
    { user_choice: 'automatic-fallback', synthesis_q: 'synthesis_failed', baseline_q: null },
    { user_choice: 'no-baseline', synthesis_q: 0, baseline_q: 0 },
  ]) {
    const error = capturedError(() => renderFallbackNote({ ...base, ...row }));
    assert.equal(error.rc, 2, JSON.stringify(row));
    assert.equal(error.code, 'invalid_fallback_q_shape', JSON.stringify(row));
  }
});

test('dispatcher validates fallback classification before session lookup and preserves note bytes', (t) => {
  const projectRoot = makeProject(t);
  const invalidBeforeLookup = request(projectRoot, 'synthesis.write-fallback-note', {
    session_id: '01J00000000000000000000000',
    baseline_reasoning: { chosen_seed_id: 1, tier: 'preferred', ties_broken_on: [] },
    synthesis_q: 0.7,
    baseline_q: 0.8,
    user_choice: 'accept-regression',
  });
  assert.equal(invalidBeforeLookup.exitCode, 2, JSON.stringify(invalidBeforeLookup));
  assert.equal(invalidBeforeLookup.error.code, 'invalid_synthesis_classification');

  const started = startSession(projectRoot);
  const output = path.join(fs.realpathSync(started.session_root), 'completion', 'fallback_note.md');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, 'preserve-existing-note\n');
  const before = fs.readFileSync(output);
  const invalid = request(projectRoot, 'synthesis.write-fallback-note', {
    session_id: started.session_id,
    baseline_reasoning: { chosen_seed_id: null, tier: 'no_baseline', ties_broken_on: [] },
    synthesis_q: null,
    baseline_q: null,
    user_choice: '1',
  });
  assert.equal(invalid.exitCode, 2, JSON.stringify(invalid));
  assert.equal(invalid.error.code, 'invalid_synthesis_classification');
  assert.deepEqual(fs.readFileSync(output), before);
});

test('dispatcher writes the exact no-baseline note and returns only output path plus markdown', (t) => {
  const projectRoot = makeProject(t);
  const started = startSession(projectRoot);
  const response = request(projectRoot, 'synthesis.write-fallback-note', {
    session_id: started.session_id,
    baseline_reasoning: { chosen_seed_id: null, tier: 'no_baseline', ties_broken_on: [] },
    synthesis_q: null,
    baseline_q: null,
    user_choice: 'no-baseline',
  });
  assert.equal(response.exitCode, 0, JSON.stringify(response));
  assert.deepEqual(Object.keys(response.result).sort(), ['markdown', 'output_path']);
  assert.equal(response.result.output_path,
    path.join(fs.realpathSync(started.session_root), 'completion', 'fallback_note.md'));
  assert.equal(fs.readFileSync(response.result.output_path, 'utf8'), response.result.markdown);
  assert.match(response.result.markdown, /\*\*classification\*\*: no-baseline/);
  assert.match(response.result.markdown, /\*\*synthesis_Q\*\*: N\/A/);
});

test('active Node synthesis code contains no ordinal choice compatibility branch', () => {
  const source = fs.readFileSync(SYNTHESIS_PATH, 'utf8');
  assert.doesNotMatch(source, /Branch B option|option [123]|\([123]\) 합성|\([123]\) 최고|String\((?:options|payload)\.user_choice\)/);
  assert.doesNotMatch(source, /user_choice[^\n]{0,100}(?:===|includes\()[^\n]{0,100}['"](?:1|2|3|none)['"]/);
  assert.equal(OPERATIONS.filter((operation) => operation.startsWith('synthesis.')).length, 7);
  assert.equal(new Set(OPERATIONS).size, 75);
});
