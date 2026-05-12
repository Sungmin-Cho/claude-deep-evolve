'use strict';

// Test-isolation helper for protect-readonly.sh (M5.5 #3 deep-evolve side).
//
// **Why this exists** — protect-readonly.sh's behavior is steered by several
// env vars that can leak from a developer's interactive shell or a CI
// runner and silently flip the decision path:
//
//   - CLAUDE_TOOL_USE_TOOL_NAME / CLAUDE_TOOL_NAME (line 10)
//       Both are consulted with CLAUDE_TOOL_USE_TOOL_NAME taking precedence.
//       A stale value from the host shell would mis-classify the tool and
//       route Write/Edit through the Bash branch (or vice versa).
//
//   - DEEP_EVOLVE_HELPER (line 86)
//       "1" + non-Bash tool unlocks the current.json/sessions.jsonl/session.yaml
//       registry-write bypass. Test runs MUST NOT silently inherit "1" from a
//       host environment that just finished a /deep-evolve helper invocation.
//
//   - DEEP_EVOLVE_META_MODE (line 111)
//       program_update | outer_loop | prepare_update — each unlocks a
//       different subset of protected paths. Leakage = false-allow in
//       block fixtures.
//
//   - DEEP_EVOLVE_SEAL_PREPARE (line 150)
//       "1" upgrades the hook to Read/Bash sealing on prepare.py and
//       prepare-protocol.md. Leakage = false-block in allow fixtures.
//
// Sibling reference: deep-work's hooks/scripts/test-helpers/run-phase-guard.js
// established this scrub pattern. We mirror it here so the deep-evolve golden
// driver gets the same host-independence guarantee.
//
// **Note** — protect-readonly.sh does NOT consume a DEEP_EVOLVE_SESSION_ID
// or CLAUDE_PROJECT_DIR env var (the suite handoff doc was speculative).
// Session resolution walks PWD upward looking for `.deep-evolve/` and reads
// the session id from `.deep-evolve/current.json`. PWD isolation is achieved
// via `cwd: tmpRoot` in spawnSync — no env var scrubbing needed for that
// path. If a future revision of the hook adds an env-var override, update
// HOST_LEAK_VARS below AND the comment block above.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const DEFAULT_HOOK = path.resolve(__dirname, '..', 'protect-readonly.sh');

// Verified consumer list (grep hooks/scripts/protect-readonly.sh as of v3.3.0).
// Update this list AND the comment block above when a new env consumer is
// added or removed — a stale list silently weakens isolation.
const HOST_LEAK_VARS = [
  'CLAUDE_TOOL_USE_TOOL_NAME',
  'CLAUDE_TOOL_NAME',
  'DEEP_EVOLVE_HELPER',
  'DEEP_EVOLVE_META_MODE',
  'DEEP_EVOLVE_SEAL_PREPARE',
];

/**
 * Return a copy of process.env with the known host-leak vars removed,
 * then merged with caller-supplied overrides.
 *
 * @param {object} extra — env vars to merge AFTER scrub (test-specific)
 * @returns {object}
 */
function scrubHostEnv(extra = {}) {
  const scrubbed = { ...process.env };
  for (const k of HOST_LEAK_VARS) delete scrubbed[k];
  return { ...scrubbed, ...extra };
}

/**
 * Spawn protect-readonly.sh under test isolation. Centralizes the spawn
 * convention so a future change to the JSON stdin contract or the bash
 * invocation pattern is updated in one place.
 *
 * @param {object} opts
 * @param {string} opts.cwd          — tmpRoot containing .deep-evolve/<sid>/
 * @param {object} [opts.env]        — extra env vars (merged after scrub)
 * @param {string} [opts.toolName]   — shorthand for CLAUDE_TOOL_USE_TOOL_NAME
 * @param {any}    [opts.toolInput]  — payload JSON-stringified onto stdin
 * @param {string} [opts.script]     — defaults to protect-readonly.sh
 * @param {number} [opts.timeout]    — defaults to 8000ms
 * @returns {{status:number,stdout:string,stderr:string,signal:string|null,error:Error|undefined}}
 */
function runProtectReadonly({
  cwd,
  env: extraEnv = {},
  toolName,
  toolInput,
  script = DEFAULT_HOOK,
  timeout = 8000,
} = {}) {
  const env = scrubHostEnv({
    ...(toolName ? { CLAUDE_TOOL_USE_TOOL_NAME: toolName } : {}),
    ...extraEnv,
  });
  const input = typeof toolInput === 'undefined' ? '' : JSON.stringify(toolInput);
  return spawnSync('bash', [script], {
    input,
    cwd,
    env,
    encoding: 'utf8',
    timeout,
  });
}

/**
 * Parse the JSON object embedded in protect-readonly.sh stdout. The hook
 * emits decisions via HEREDOC (`cat <<JSON ... JSON`), so slicing from the
 * first `{` to trimmed end and feeding to JSON.parse handles the shape.
 * Allow paths emit no stdout (just exit 0) so this returns null then.
 *
 * @param {string} stdout
 * @returns {object|null} parsed decision object, or null if no JSON found
 */
function parseGuardOutput(stdout) {
  if (!stdout) return null;
  const start = stdout.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(stdout.slice(start).trim());
  } catch (_) {
    return null;
  }
}

module.exports = {
  scrubHostEnv,
  runProtectReadonly,
  parseGuardOutput,
  HOST_LEAK_VARS,
  DEFAULT_HOOK,
};
