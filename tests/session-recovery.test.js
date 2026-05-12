'use strict';

// tests/session-recovery.test.js — M5.5 #5 (deep-evolve side).
//
// Pins the post-crash recovery semantics of `session-helper.sh
// resolve_current` and `session-helper.sh detect_orphan_experiment`
// against artificially-dangled state (interrupted session — current.json
// without a session dir, session.yaml missing, journal.jsonl with an
// orphan committed experiment, etc.).
//
// **Why these contracts matter** — `/deep-resume` reads `current.json`
// via `resolve_current` and reconciles `journal.jsonl` via
// `detect_orphan_experiment`. A regression that silently passes when
// either function encounters dangling state would cause `/deep-resume`
// to either re-enter a phantom session or skip orphan-experiment
// recovery. Both modes lose user work or corrupt the lineage.
//
// **Existing coverage gap** — `hooks/scripts/tests/test_v31_resume_v31.py`
// exercises the v3.1 reconciliation path of `/deep-resume` but assumes
// `resolve_current` has already succeeded; it does not test the
// dangling-state error paths. This file is the integration counterpart.
//
// Spec: claude-deep-suite/docs/superpowers/plans/
// 2026-05-12-m5.5-remaining-tests-handoff.md §2 #5 (deep-evolve row).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SESSION_HELPER = path.resolve(
  __dirname, '..', 'hooks', 'scripts', 'session-helper.sh',
);

if (!fs.existsSync(SESSION_HELPER)) {
  throw new Error(`session-helper.sh missing at ${SESSION_HELPER}`);
}

// Scrub env vars that could redirect session resolution away from tmpRoot.
// `find_project_root` walks $PWD upward; we run with `cwd: tmpRoot` and
// scrub any DEEP_EVOLVE_* var that might short-circuit normal resolution.
function scrubbedEnv(extra = {}) {
  const env = { ...process.env };
  delete env.DEEP_EVOLVE_META_MODE;
  delete env.DEEP_EVOLVE_SEAL_PREPARE;
  delete env.DEEP_EVOLVE_HELPER;
  delete env.PROJECT_ROOT;
  return { ...env, ...extra };
}

function runHelper(tmpRoot, subcmd, ...args) {
  return spawnSync('bash', [SESSION_HELPER, subcmd, ...args], {
    cwd: tmpRoot,
    env: scrubbedEnv(),
    encoding: 'utf8',
    timeout: 8000,
  });
}

function makeTmpRoot() {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-rec-')),
  );
  fs.mkdirSync(path.join(tmp, '.deep-evolve'), { recursive: true });
  return tmp;
}

function writeCurrent(tmpRoot, sessionId, opts = {}) {
  const payload = sessionId === null
    ? { session_id: null, started_at: opts.startedAt || '2026-05-12T00:00:00Z' }
    : { session_id: sessionId, started_at: opts.startedAt || '2026-05-12T00:00:00Z' };
  fs.writeFileSync(
    path.join(tmpRoot, '.deep-evolve', 'current.json'),
    JSON.stringify(payload),
  );
}

function writeSessionDir(tmpRoot, sessionId, sessionYaml) {
  const dir = path.join(tmpRoot, '.deep-evolve', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  if (typeof sessionYaml === 'string') {
    fs.writeFileSync(path.join(dir, 'session.yaml'), sessionYaml);
  }
  return dir;
}

function writeJournal(sessionDir, events) {
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(sessionDir, 'journal.jsonl'), lines + '\n');
}

describe('session-helper resolve_current — dangling state error paths (M5.5 #5)', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpRoot(); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  // Test A: current.json file does not exist → exit 1, stderr names the
  // missing file so the user knows what to fix.
  it('A: missing current.json → exit 1 with descriptive stderr', () => {
    const r = runHelper(tmpRoot, 'resolve_current');
    assert.equal(r.status, 1, `expected exit 1, got ${r.status} (stdout=${r.stdout})`);
    assert.match(r.stderr, /current\.json missing/);
  });

  // Test B: current.json with explicit null session_id (mid-write crash
  // before the field was filled) → exit 1, stderr explains.
  it('B: current.json with null session_id → exit 1 with descriptive stderr', () => {
    writeCurrent(tmpRoot, null);
    const r = runHelper(tmpRoot, 'resolve_current');
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /session_id null/);
  });

  // Test C: current.json references a session_id whose dir was deleted
  // (e.g. user removed `.deep-evolve/<sid>` manually but forgot the
  // pointer). resolve_current must NOT silently fall back to PWD; it
  // must surface the orphan pointer.
  it('C: orphan pointer (session dir missing) → exit 1 + "orphan pointer"', () => {
    writeCurrent(tmpRoot, 's-dangling-001');
    // NB: deliberately do NOT create .deep-evolve/s-dangling-001/
    const r = runHelper(tmpRoot, 'resolve_current');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /orphan pointer.*session dir missing/);
  });

  // Test D: session dir exists but session.yaml is missing — partial
  // crash during `start_new_session` (atomic-write contract violated).
  it('D: session dir without session.yaml → exit 1', () => {
    writeCurrent(tmpRoot, 's-dangling-002');
    writeSessionDir(tmpRoot, 's-dangling-002');  // no yaml arg → no file
    const r = runHelper(tmpRoot, 'resolve_current');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /session\.yaml missing/);
  });

  // Test E: happy path — fully-formed session resolves successfully.
  // Sanity guard so the test file isn't all error paths (which could mask
  // a regression that fails ALL invocations).
  it('E: valid session resolves → exit 0 + stdout = "<sid>\\t<root>"', () => {
    const sid = 's-happy-001';
    writeCurrent(tmpRoot, sid);
    const sessionDir = writeSessionDir(tmpRoot, sid, 'status: active\n');
    const r = runHelper(tmpRoot, 'resolve_current');
    assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
    const [out_sid, out_root] = r.stdout.trim().split('\t');
    assert.equal(out_sid, sid);
    // The helper may return realpath-resolved path which on macOS prefixes
    // /private/. Compare against realpath of expected for portability.
    const expected = fs.realpathSync(sessionDir);
    const actual = fs.realpathSync(out_root);
    assert.equal(actual, expected);
  });
});

describe('session-helper detect_orphan_experiment — journal-state recovery (M5.5 #5)', () => {
  let tmpRoot;
  let sid;
  let sessionDir;
  beforeEach(() => {
    tmpRoot = makeTmpRoot();
    sid = 's-journal-001';
    writeCurrent(tmpRoot, sid);
    sessionDir = writeSessionDir(tmpRoot, sid, 'status: active\n');
  });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  // Test F: no journal.jsonl yet (fresh session) → no-op, exit 0,
  // empty stdout. Pre-experiment lifecycle must NOT crash recovery.
  it('F: journal missing → exit 0 + empty stdout (no-op)', () => {
    const r = runHelper(tmpRoot, 'detect_orphan_experiment', sessionDir);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
    assert.equal(r.stdout.trim(), '');
  });

  // Test G: journal with a committed experiment lacking any resolution
  // (kept / discarded / evaluated / rollback_completed) → detect_orphan
  // returns the commit hash so /deep-resume can drive the user through
  // recovery. This is the canonical M5.5 #5 dangling-state scenario.
  //
  // **Contract quirk**: `cmd_detect_orphan_experiment` runs `jq -s` WITHOUT
  // `-r` and then `printf '%s'` — so stdout includes the JSON quotes
  // (`"<hash>"`). The single existing consumer (`/deep-resume` Step 3.d in
  // skills/deep-evolve-workflow/protocols/resume.md) currently displays
  // the quoted form ("commit: \"<hash>\"") to the user. Pinning the
  // quoted form here so a future helper fix that adds `-r` is intentional
  // (with consumer-side update) rather than silent.
  it('G: orphan committed → exit 0 + stdout = JSON-quoted commit hash', () => {
    const orphanHash = 'abcdef1234567890abcdef1234567890abcdef12';
    writeJournal(sessionDir, [
      { id: 1, status: 'planned', idea_category: 'parameter_tune' },
      { id: 1, status: 'committed', commit: orphanHash, ts: '2026-05-12T01:00:00Z' },
      // intentionally NO matching evaluated/kept/discarded for id=1
    ]);
    const r = runHelper(tmpRoot, 'detect_orphan_experiment', sessionDir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // Helper-emitted JSON-quoted form (pre-existing contract). Tests both
    // shapes so a future `-r` fix is detected, not silently passed.
    assert.equal(r.stdout, `"${orphanHash}"`,
      `unexpected stdout: ${JSON.stringify(r.stdout)}`);
    // De-quoted form lets downstream consumers do simple `tr -d '"'`.
    assert.equal(r.stdout.replace(/"/g, ''), orphanHash);
  });

  // Test H: journal where every committed experiment has a matching
  // resolution → detect_orphan returns empty (nothing to recover).
  it('H: all committed have resolution → exit 0 + empty stdout', () => {
    writeJournal(sessionDir, [
      { id: 1, status: 'planned', idea_category: 'parameter_tune' },
      { id: 1, status: 'committed', commit: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111', ts: '2026-05-12T01:00:00Z' },
      { id: 1, status: 'kept', ts: '2026-05-12T01:30:00Z' },
      { id: 2, status: 'planned', idea_category: 'algorithm_swap' },
      { id: 2, status: 'committed', commit: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222', ts: '2026-05-12T02:00:00Z' },
      { id: 2, status: 'discarded', ts: '2026-05-12T02:30:00Z' },
    ]);
    const r = runHelper(tmpRoot, 'detect_orphan_experiment', sessionDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  // Test I: ONLY the most recent committed event is checked — older
  // resolved committed experiments must not be mistaken for the orphan.
  // This pins the "last-committed-without-resolution" semantics.
  it('I: only LAST committed matters (older orphans ignored)', () => {
    const recentOrphan = 'ccccffff5555eeee0000aaaaffff9999dddd3333';
    writeJournal(sessionDir, [
      { id: 1, status: 'planned' },
      { id: 1, status: 'committed', commit: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' },
      { id: 1, status: 'kept' },
      { id: 2, status: 'planned' },
      { id: 2, status: 'committed', commit: recentOrphan },
      // no resolution for id=2
    ]);
    const r = runHelper(tmpRoot, 'detect_orphan_experiment', sessionDir);
    // Strip JSON quotes — see contract quirk in Test G.
    assert.equal(r.stdout.replace(/"/g, ''), recentOrphan);
  });
});
