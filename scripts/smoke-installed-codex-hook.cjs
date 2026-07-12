#!/usr/bin/env node
'use strict';

// Task 2 diagnostic only. Task 8 replaces this with the pinned installed-host
// acceptance smoke; direct handler execution must never be reported as proof
// that Codex discovered or registered the hook.

const path = require('node:path');
const { evaluateHook } = require('../hooks/scripts/protect-readonly.cjs');

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] || null;
}

function fail(message) {
  process.stderr.write(`[deep-evolve/codex-smoke] ${message}\n`);
  process.exitCode = 2;
}

const argv = process.argv.slice(2);
if (!argv.includes('--diagnose-command')) {
  fail('Task 2 supports --diagnose-command only; installed-host acceptance arrives in Task 8.');
} else {
  const projectRoot = valueAfter(argv, '--project-root');
  const target = valueAfter(argv, '--target');
  if (!projectRoot || !target) {
    fail('--project-root and --target are required.');
  } else {
    const result = evaluateHook({
      tool_name: 'apply_patch',
      tool_input: {
        command: `*** Begin Patch\n*** Update File: ${path.resolve(target)}\n@@\n-before\n+after\n*** End Patch`,
      },
    }, {}, path.resolve(projectRoot));
    const marked = result.exitCode === 2 && /Deep Evolve Guard/.test(result.output);
    process.stderr.write('[deep-evolve/codex-smoke] diagnostic only; this does not prove installed-host hook registration.\n');
    process.stdout.write(`${JSON.stringify({
      diagnostic_only: true,
      ok: marked,
      guard_exit_code: result.exitCode,
      marker: marked ? 'Deep Evolve Guard' : null,
    })}\n`);
    process.exitCode = marked ? 0 : 2;
  }
}
