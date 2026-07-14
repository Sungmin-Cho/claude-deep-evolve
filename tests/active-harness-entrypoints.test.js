'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const templateRoot = path.join(root, 'templates');
const workflowRoot = path.join(root, 'skills', 'deep-evolve-workflow');
const protocolRoot = path.join(workflowRoot, 'protocols');
const protocolNames = [
  'archive.md',
  'completion.md',
  'coordinator.md',
  'history.md',
  'init.md',
  'inner-loop.md',
  'outer-loop.md',
  'resume.md',
  'runtime-contract.md',
  'synthesis.md',
  'taxonomy.md',
  'transfer.md',
];
const finalActiveHarnessSurfaces = [
  path.join(templateRoot, 'prepare-protocol.md'),
  path.join(root, 'skills', 'deep-evolve', 'SKILL.md'),
  path.join(workflowRoot, 'SKILL.md'),
  ...protocolNames.map((name) => path.join(protocolRoot, name)),
  path.join(root, 'agents', 'evolve-coordinator.md'),
  path.join(root, 'agents', 'evolve-seed.md'),
  path.join(root, 'README.md'),
  path.join(root, 'README.ko.md'),
  path.join(root, 'CLAUDE.md'),
  path.join(root, 'AGENTS.md'),
];

const EXECUTION_VERB = /\b(?:run|execute|invoke|allow)\b/i;
const ACTIVE_WORDING = /\b(?:ground\s+truth|active|supported)\b/i;
const MIGRATION_WORDING = /\b(?:legacy|migrat(?:e|ion|ing)|histor(?:y|ical))\b/i;
const PYTHON_LAUNCHER = /(?:^|[\s`"'[(])(?:python(?:3(?:\.\d+)?)?|py\s+-3)(?=$|[\s`"')\]])/i;
const SHELL_META = /(?:&&|\|\||[;&|<>`$])/;

function commandShape(line) {
  const trimmed = line.trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^`|`$/g, '')
    .trim();
  if (PYTHON_LAUNCHER.test(trimmed)) return { text: trimmed, candidate: true };
  if (/\bprepare\.(?:cjs|py)\b/i.test(trimmed)
      && /(?:^|[\s`"'[(])node(?=$|[\s`"')\]])/i.test(trimmed)) {
    return { text: trimmed, candidate: true };
  }
  return { text: trimmed, candidate: false };
}

function scanHarnessEntrypoints(files) {
  const result = {
    active_prepare_py_instructions: 0,
    legacy_prepare_py_mentions: 0,
    violations: [],
    executable_forms: [],
  };

  for (const file of files) {
    const relative = path.relative(path.resolve(__dirname, '..'), file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      if (/\bprepare\.py\b/i.test(line)) {
        const marked = line.includes('<!-- legacy-migration-only -->');
        const acceptedLegacy = marked
          && MIGRATION_WORDING.test(line)
          && !EXECUTION_VERB.test(line)
          && !ACTIVE_WORDING.test(line)
          && !PYTHON_LAUNCHER.test(line)
          && !SHELL_META.test(line.replace('<!-- legacy-migration-only -->', ''));
        if (acceptedLegacy) result.legacy_prepare_py_mentions += 1;
        else {
          result.active_prepare_py_instructions += 1;
          result.violations.push({ file: relative, line: lineNumber, code: 'active_prepare_py', text: line.trim() });
        }
      }

      const command = commandShape(line);
      if (!command.candidate) return;
      if (PYTHON_LAUNCHER.test(command.text) || /\bprepare\.py\b/i.test(command.text)) {
        result.violations.push({ file: relative, line: lineNumber, code: 'python_harness_command', text: line.trim() });
        return;
      }
      if (SHELL_META.test(command.text)) {
        result.violations.push({ file: relative, line: lineNumber, code: 'shell_harness_command', text: line.trim() });
        return;
      }
      const tokens = command.text.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
      const nodeIndex = tokens.findIndex((token) => token.replace(/^['"]|['"]$/g, '').toLowerCase() === 'node');
      const target = nodeIndex >= 0 ? tokens[nodeIndex + 1] : null;
      const normalizedTarget = target ? target.replace(/^['"]|['"]$/g, '').replace(/\\/g, '/') : '';
      if (nodeIndex !== 0 || path.posix.basename(normalizedTarget).toLowerCase() !== 'prepare.cjs') {
        result.violations.push({ file: relative, line: lineNumber, code: 'noncanonical_harness_command', text: line.trim() });
        return;
      }
      result.executable_forms.push({ file: relative, line: lineNumber, kind: 'node:prepare.cjs' });
    });
  }
  return result;
}

test('Task 7 final active surface has no missing file or active Python harness instruction', () => {
  const missing = finalActiveHarnessSurfaces
    .filter((file) => !fs.existsSync(file))
    .map((file) => path.relative(root, file).split(path.sep).join('/'));
  const scan = scanHarnessEntrypoints(finalActiveHarnessSurfaces.filter((file) => fs.existsSync(file)));
  const evidence = { missing, ...scan };
  assert.deepEqual(missing, [], JSON.stringify(evidence, null, 2));
  assert.equal(scan.active_prepare_py_instructions, 0, JSON.stringify(scan.violations, null, 2));
  assert.deepEqual(scan.violations, []);
  assert.equal(scan.executable_forms.length > 0, true, 'final surface must prescribe direct Node prepare.cjs at least once');
  assert.deepEqual([...new Set(scan.executable_forms.map((form) => form.kind))], ['node:prepare.cjs']);
});

test('scanner distinguishes marked migration history from executable or active Python wording', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'evolve scanner '));
  const fixture = path.join(root, 'surface.md');
  try {
    fs.writeFileSync(fixture, [
      'Archived prepare.py format. <!-- legacy-migration-only --> migration history only.',
      'prepare.py is the ground truth for active CLI evaluation.',
      'Run python3 prepare.py now.',
      'node prepare.cjs',
      'node prepare.cjs && echo injected',
      'node nested/other.cjs',
    ].join('\n'));
    const scan = scanHarnessEntrypoints([fixture]);
    assert.equal(scan.legacy_prepare_py_mentions, 1);
    assert.equal(scan.active_prepare_py_instructions, 2);
    assert.equal(scan.executable_forms.length, 1);
    assert.equal(scan.executable_forms[0].kind, 'node:prepare.cjs');
    assert.deepEqual(new Set(scan.violations.map((row) => row.code)), new Set([
      'active_prepare_py', 'python_harness_command', 'shell_harness_command',
    ]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

module.exports = {
  finalActiveHarnessSurfaces,
  scanActiveHarnessInstructions: scanHarnessEntrypoints,
  scanHarnessEntrypoints,
};
