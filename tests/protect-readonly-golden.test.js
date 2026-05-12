'use strict';

// tests/protect-readonly-golden.test.js — M5.5 #3 hook golden test
// (deep-evolve side).
//
// **Goal**: pin protect-readonly.sh's stdout JSON + exit code on a fixture
// corpus so the contract (decision + reason regex match) is regression-
// protected across the representative tool × session-state × meta-mode
// combinations. Adding a new scenario = adding a `<name>.input.json` +
// `<name>.expected.json` pair under `tests/fixtures/golden/`. The loader
// fails loud if one side is missing (catches accidental half-commits).
//
// Spec: claude-deep-suite/docs/superpowers/plans/2026-05-12-m5.5-remaining-tests-handoff.md §2 #3
// Pattern reference: claude-deep-work tests/phase-guard-golden.test.js
// (PR #29). Same loader shape, adapted for protect-readonly.sh's
// `.deep-evolve/<session_id>/` state convention instead of deep-work's
// `.claude/deep-work.<sid>.md` frontmatter.
//
// Helper rationale: see hooks/scripts/test-helpers/run-protect-readonly.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runProtectReadonly,
  parseGuardOutput,
} = require('../hooks/scripts/test-helpers/run-protect-readonly');

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'golden');

function loadFixtureCorpus() {
  const entries = fs.readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.input.json') || f.endsWith('.expected.json'));
  const map = new Map();
  for (const file of entries) {
    const m = file.match(/^(.+)\.(input|expected)\.json$/);
    if (!m) continue;
    const [, name, kind] = m;
    if (!map.has(name)) map.set(name, { name });
    map.get(name)[kind] = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'),
    );
  }
  for (const [name, fixture] of map) {
    if (!fixture.input || !fixture.expected) {
      const missing = fixture.input ? '.expected' : '.input';
      throw new Error(
        `Golden fixture "${name}" is missing ${missing}.json — half-commit?`,
      );
    }
  }
  // Stable test order (sort by basename) so CI diff output is deterministic
  // when a new fixture is added mid-list.
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Materialize the .deep-evolve/<sid>/ namespace inside tmpRoot.
 *
 * Mirrors hooks/scripts/tests/test_v31_protect_readonly.py::_active_session
 * so the hook's session-root resolution (current.json → SESSION_ID →
 * SESSION_ROOT) finds the file tree it expects.
 *
 * @param {string} tmpRoot
 * @param {object} state — fixture state block (see fixtures/golden/README.md)
 * @returns {string} session_root absolute path (for resolving protected paths)
 */
function writeSessionState(tmpRoot, state) {
  const sessionId = state.session_id || 'golden-default';
  const sessionRoot = path.join(tmpRoot, '.deep-evolve', sessionId);
  fs.mkdirSync(sessionRoot, { recursive: true });

  // current.json — points at this session
  fs.writeFileSync(
    path.join(tmpRoot, '.deep-evolve', 'current.json'),
    JSON.stringify({ session_id: sessionId }),
  );

  // session.yaml — status field controls active-experiment detection
  const status = state.status || 'active';
  fs.writeFileSync(
    path.join(sessionRoot, 'session.yaml'),
    `status: ${status}\n`,
  );

  // Realize the protected files so fixtures can reference them as bash targets
  // (truncate / cat / etc.). For Write/Edit on file_path the hook only checks
  // string equality, so creation is optional — but cheap and matches the
  // pytest helper.
  if (state.create_protected !== false) {
    fs.writeFileSync(path.join(sessionRoot, 'prepare.py'), 'SECRET = 1\n');
    fs.writeFileSync(path.join(sessionRoot, 'prepare-protocol.md'), 'SECRET\n');
    fs.writeFileSync(path.join(sessionRoot, 'program.md'), 'program\n');
    fs.writeFileSync(path.join(sessionRoot, 'strategy.yaml'), 'strategy: noop\n');
    fs.mkdirSync(path.join(sessionRoot, 'worktrees', 'seed_1'), { recursive: true });
    fs.writeFileSync(
      path.join(sessionRoot, 'worktrees', 'seed_1', 'program.md'),
      'seed program\n',
    );
  }

  return sessionRoot;
}

/**
 * Recursively walk a structure and substitute `{{SESSION_ROOT}}` /
 * `{{PROJECT_ROOT}}` template strings with their resolved absolute paths.
 * Lets fixtures stay portable without baking in tmpdir paths.
 */
function expandTemplates(obj, replacements) {
  if (typeof obj === 'string') {
    let out = obj;
    for (const [k, v] of Object.entries(replacements)) {
      out = out.split(`{{${k}}}`).join(v);
    }
    return out;
  }
  if (Array.isArray(obj)) return obj.map((x) => expandTemplates(x, replacements));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = expandTemplates(v, replacements);
    }
    return out;
  }
  return obj;
}

const CORPUS = loadFixtureCorpus();
if (CORPUS.length === 0) {
  throw new Error('No golden fixtures discovered under tests/fixtures/golden/');
}

describe('protect-readonly golden fixtures (M5.5 #3)', () => {
  for (const [name, fixture] of CORPUS) {
    const desc = fixture.input.description || '(no description)';
    it(`${name} — ${desc}`, () => {
      // realpathSync resolves macOS `/var` → `/private/var` so string-equality
      // checks inside protect-readonly.sh match regardless of host OS.
      const tmpRoot = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'pr-golden-')),
      );
      try {
        let sessionRoot = tmpRoot;
        if (fixture.input.state) {
          sessionRoot = writeSessionState(tmpRoot, fixture.input.state);
        }
        const replacements = {
          SESSION_ROOT: sessionRoot,
          PROJECT_ROOT: tmpRoot,
        };
        const toolInput = expandTemplates(
          fixture.input.tool_input || {},
          replacements,
        );

        const result = runProtectReadonly({
          cwd: tmpRoot,
          env: fixture.input.env || {},
          toolName: fixture.input.tool_name,
          toolInput,
        });

        const expected = fixture.expected;
        assert.equal(
          result.status,
          expected.exit_code,
          `exit code mismatch in ${name}: status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`,
        );

        if (expected.decision || expected.reason_match) {
          const parsed = parseGuardOutput(result.stdout);
          assert.ok(
            parsed,
            `expected JSON decision in stdout for ${name}; got: ${result.stdout}`,
          );
          if (expected.decision) {
            assert.equal(
              parsed.decision,
              expected.decision,
              `decision mismatch in ${name}`,
            );
          }
          if (expected.reason_match) {
            assert.ok(
              typeof parsed.reason === 'string' && parsed.reason.length > 0,
              `expected reason text in ${name}; got ${JSON.stringify(parsed)}`,
            );
            assert.match(parsed.reason, new RegExp(expected.reason_match));
          }
        } else {
          // Allow path: protect-readonly.sh emits no stdout, just exit 0.
          assert.equal(
            result.stdout.trim(),
            '',
            `allow fixtures should emit no stdout; got: ${result.stdout}`,
          );
        }
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  }
});
