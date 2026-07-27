'use strict';

// tests/protect-readonly-legacy-state.test.js — legacy-session journal fallback.
//
// **Goal**: pin the guard's behavior when `current.json` still points at a
// session whose `session.yaml` predates the strict state codec (free-form
// YAML with wrapped plain scalars → UNSUPPORTED_YAML, or a parseable document
// that fails today's schema → STATE_VALIDATION_FAILED). Without the fallback
// the guard fails closed on EVERY invocation forever, even though the
// runtime's own `sessions.jsonl` lifecycle registry proves the session ended
// months ago (observed in the field: a 3.0.0-era session completed
// 2026-04-30 whose stale pointer kept denying unrelated Bash commands in
// 2026-07).
//
// Contract pinned here:
//   - pointer + unreadable legacy document + journal terminal status
//     (`completed` / `aborted`) for that exact session_id → treated as
//     inactive → allow;
//   - anything weaker (journal missing, malformed, non-terminal, wrong
//     session, or the pointer-less flat layout) → existing fail-closed
//     denial with the `state_invalid:<code>` warning, unchanged;
//   - genuinely active sessions keep full protection.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runProtectReadonly,
} = require('../hooks/scripts/test-helpers/run-protect-readonly');

const SID = 'legacy-2026-04-27-session';

// Mirrors the field incident: a 3.0.0-era free-form YAML document whose
// wrapped plain scalar (`goal:` continuation line) the strict codec rejects.
const LEGACY_UNPARSEABLE_YAML = [
  `session_id: ${SID}`,
  'deep_evolve_version: 3.0.0',
  'status: completed',
  "created_at: '2026-04-27T16:57:00+09:00'",
  'goal: 3-axis deep-evolve — buy_threshold=0.15 + rsi_ovb=60 wrapped narrative',
  '  continuation line that the strict state codec rejects.',
  '',
].join('\n');

// Parses (JSON-compatible) but carries a legacy key unknown to today's
// schema → validateSession throws STATE_VALIDATION_FAILED.
const LEGACY_SCHEMA_INVALID_YAML = `${JSON.stringify({
  session_id: SID,
  deep_evolve_version: '3.0.0',
  status: 'completed',
  created_at: '2026-04-27T16:57:00+09:00',
  eval_command: '.venv/bin/python .deep-evolve/prepare.py',
}, null, 2)}\n`;

// A genuinely valid ACTIVE session is produced by the runtime's own
// session.start operation (hand-built minimal documents do not pass
// validateSession — it requires the full schema). Used by the last test to
// prove the journal fallback can never override a readable active document.
function startRealSession(tmpRoot) {
  const { spawnSync } = require('node:child_process');
  const { dispatch } = require('../hooks/scripts/deep-evolve-runtime.cjs');
  const START = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, 'fixtures', 'runtime', 'session-start-v3.5.json'), 'utf8',
  ));
  const git = (args) => {
    const out = spawnSync('git', args, { cwd: tmpRoot, encoding: 'utf8' });
    assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  };
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'src', 'index.js'), 'module.exports = 1;\n');
  git(['init', '-q']);
  git(['config', 'user.email', 'runtime@example.invalid']);
  git(['config', 'user.name', 'Runtime Test']);
  git(['add', 'src/index.js']);
  git(['commit', '-qm', 'base']);
  const initial = structuredClone(START.initial_state);
  initial.virtual_parallel.n_chosen = 1;
  const response = dispatch({
    schema_version: '1.0',
    operation: 'session.start',
    context: { project_root: tmpRoot },
    payload: { goal: 'legacy-state regression fixture', initial_state: initial },
  }, { now: () => Date.parse('2026-07-27T00:00:00Z') });
  assert.equal(response.ok, true, JSON.stringify(response));
  return fs.realpathSync(response.result.session_root);
}

function journalLines(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

const JOURNAL_COMPLETED = journalLines([
  { event: 'created', ts: '2026-04-27T07:57:13Z', session_id: SID, goal: 'legacy goal' },
  { event: 'reconciled', ts: '2026-04-30T04:51:50Z', session_id: SID, from: 'initializing', to: 'active' },
  { event: 'status_change', ts: '2026-04-30T04:58:47Z', session_id: SID, status: 'completed' },
]);

const JOURNAL_ABORTED_VIA_RECONCILED = journalLines([
  { event: 'created', ts: '2026-04-27T07:57:13Z', session_id: SID, goal: 'legacy goal' },
  { event: 'reconciled', ts: '2026-04-30T04:58:47Z', session_id: SID, from: 'active', to: 'aborted' },
]);

const JOURNAL_STILL_ACTIVE = journalLines([
  { event: 'created', ts: '2026-04-27T07:57:13Z', session_id: SID, goal: 'legacy goal' },
  { event: 'status_change', ts: '2026-04-27T08:00:00Z', session_id: SID, status: 'active' },
]);

const JOURNAL_OTHER_SESSION = journalLines([
  { event: 'created', ts: '2026-04-27T04:50:01Z', session_id: 'some-other-session', goal: 'x' },
  { event: 'status_change', ts: '2026-04-27T05:14:51Z', session_id: 'some-other-session', status: 'completed' },
]);

const JOURNAL_MALFORMED = `${JOURNAL_COMPLETED}{not json\n`;

/**
 * Materialize a project whose pointer names SID.
 *
 * @param {object} opts
 * @param {string} [opts.sessionYaml] — raw session.yaml body for the SID dir
 * @param {string} [opts.journal]    — raw sessions.jsonl body (omit = absent)
 * @param {boolean} [opts.pointer]   — write current.json (default true)
 * @param {string} [opts.flatYaml]   — raw flat `.deep-evolve/session.yaml`
 * @returns {string} tmpRoot
 */
function writeProject({ sessionYaml, journal, pointer = true, flatYaml } = {}) {
  const tmpRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pr-legacy-')),
  );
  const stateRoot = path.join(tmpRoot, '.deep-evolve');
  fs.mkdirSync(path.join(stateRoot, SID), { recursive: true });
  if (pointer) {
    fs.writeFileSync(
      path.join(stateRoot, 'current.json'),
      `${JSON.stringify({ session_id: SID, started_at: '2026-04-27T07:57:13Z' })}\n`,
    );
  }
  if (typeof sessionYaml === 'string') {
    fs.writeFileSync(path.join(stateRoot, SID, 'session.yaml'), sessionYaml);
  }
  if (typeof flatYaml === 'string') {
    fs.writeFileSync(path.join(stateRoot, 'session.yaml'), flatYaml);
  }
  if (typeof journal === 'string') {
    fs.writeFileSync(path.join(stateRoot, 'sessions.jsonl'), journal);
  }
  // A realized protected file so `cat strategy.yaml` style commands are
  // meaningful targets under an active session.
  fs.writeFileSync(path.join(stateRoot, SID, 'strategy.yaml'), 'strategy: noop\n');
  return tmpRoot;
}

function runProtectedLookingCommand(tmpRoot) {
  return runProtectReadonly({
    cwd: tmpRoot,
    toolName: 'Bash',
    toolInput: { command: 'cat strategy.yaml' },
  });
}

function cleanup(tmpRoot) {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

describe('protect-readonly legacy-state journal fallback', () => {
  it('allows when the pointed legacy YAML is unparseable and the journal proves completed', () => {
    const tmpRoot = writeProject({ sessionYaml: LEGACY_UNPARSEABLE_YAML, journal: JOURNAL_COMPLETED });
    try {
      const result = runProtectedLookingCommand(tmpRoot);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(result.stderr, '');
    } finally { cleanup(tmpRoot); }
  });

  it('allows when the journal proves aborted via a reconciled event', () => {
    const tmpRoot = writeProject({ sessionYaml: LEGACY_UNPARSEABLE_YAML, journal: JOURNAL_ABORTED_VIA_RECONCILED });
    try {
      const result = runProtectedLookingCommand(tmpRoot);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    } finally { cleanup(tmpRoot); }
  });

  it('allows when a parseable legacy document fails schema validation but the journal proves completed', () => {
    const tmpRoot = writeProject({ sessionYaml: LEGACY_SCHEMA_INVALID_YAML, journal: JOURNAL_COMPLETED });
    try {
      const result = runProtectedLookingCommand(tmpRoot);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    } finally { cleanup(tmpRoot); }
  });

  it('still denies when the journal is absent', () => {
    const tmpRoot = writeProject({ sessionYaml: LEGACY_UNPARSEABLE_YAML });
    try {
      const result = runProtectedLookingCommand(tmpRoot);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /state_invalid:UNSUPPORTED_YAML/);
      assert.match(result.stderr, /Deep Evolve Guard \(state_invalid\)/);
    } finally { cleanup(tmpRoot); }
  });

  it('still denies when the journal last records a non-terminal status', () => {
    const tmpRoot = writeProject({ sessionYaml: LEGACY_UNPARSEABLE_YAML, journal: JOURNAL_STILL_ACTIVE });
    try {
      const result = runProtectedLookingCommand(tmpRoot);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /state_invalid:UNSUPPORTED_YAML/);
    } finally { cleanup(tmpRoot); }
  });

  it('still denies when only a different session has a terminal journal status', () => {
    const tmpRoot = writeProject({ sessionYaml: LEGACY_UNPARSEABLE_YAML, journal: JOURNAL_OTHER_SESSION });
    try {
      const result = runProtectedLookingCommand(tmpRoot);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /state_invalid:UNSUPPORTED_YAML/);
    } finally { cleanup(tmpRoot); }
  });

  it('still denies when the journal contains a malformed line', () => {
    const tmpRoot = writeProject({ sessionYaml: LEGACY_UNPARSEABLE_YAML, journal: JOURNAL_MALFORMED });
    try {
      const result = runProtectedLookingCommand(tmpRoot);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /state_invalid:UNSUPPORTED_YAML/);
    } finally { cleanup(tmpRoot); }
  });

  it('keeps the flat pointer-less layout fail-closed even with a terminal journal', () => {
    const tmpRoot = writeProject({ pointer: false, flatYaml: LEGACY_UNPARSEABLE_YAML, journal: JOURNAL_COMPLETED });
    try {
      const result = runProtectedLookingCommand(tmpRoot);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /state_invalid:UNSUPPORTED_YAML/);
    } finally { cleanup(tmpRoot); }
  });

  it('keeps protecting a genuinely active session even when the journal claims completed', () => {
    const tmpRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pr-legacy-active-')),
    );
    try {
      const sessionRoot = startRealSession(tmpRoot);
      const sessionId = path.basename(sessionRoot);
      // session.start leaves status 'initializing'; flip the (JSON-serialized)
      // document to 'active' while keeping every other schema field valid.
      const sessionPath = path.join(sessionRoot, 'session.yaml');
      const document = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      document.status = 'active';
      fs.writeFileSync(sessionPath, `${JSON.stringify(document, null, 2)}\n`);
      // Contradictory journal: the readable ACTIVE document must win — the
      // fallback only ever runs when the document itself is unreadable.
      fs.writeFileSync(
        path.join(tmpRoot, '.deep-evolve', 'sessions.jsonl'),
        journalLines([
          { event: 'created', ts: '2026-07-27T00:00:00Z', session_id: sessionId, goal: 'g' },
          { event: 'status_change', ts: '2026-07-27T00:01:00Z', session_id: sessionId, status: 'completed' },
        ]),
      );
      const result = runProtectReadonly({
        cwd: tmpRoot,
        toolName: 'Bash',
        toolInput: { command: `cat ${path.join(sessionRoot, 'strategy.yaml')}` },
      });
      assert.equal(result.status, 2, `stderr: ${result.stderr}`);
      assert.match(result.stderr, /Deep Evolve Guard/);
    } finally { cleanup(tmpRoot); }
  });

  it('still allows a non-protected command under unreadable state, with the warning', () => {
    const tmpRoot = writeProject({ sessionYaml: LEGACY_UNPARSEABLE_YAML });
    try {
      const result = runProtectReadonly({
        cwd: tmpRoot,
        toolName: 'Bash',
        toolInput: { command: 'echo hello' },
      });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(result.stderr, /state_invalid:UNSUPPORTED_YAML/);
    } finally { cleanup(tmpRoot); }
  });
});
