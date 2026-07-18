'use strict';

const fs = require('node:fs');

const [mode, ...args] = process.argv.slice(2);

if (mode === 'argv') {
  const [outputPath, ...literalArgs] = args;
  fs.writeFileSync(outputPath, `${JSON.stringify({ argv: literalArgs, cwd: process.cwd() })}\n`);
  process.stdout.write('metric: 0.750000\n');
} else if (mode === 'emit') {
  process.stdout.write(args.join('\n'));
  if (args.length > 0) process.stdout.write('\n');
} else if (mode === 'emit-stderr') {
  process.stderr.write(args.join('\n'));
  if (args.length > 0) process.stderr.write('\n');
} else if (mode === 'exit') {
  const [code, stdout = '', stderr = ''] = args;
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = Number(code);
} else if (mode === 'sleep') {
  const milliseconds = Number(args[0]);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  process.stdout.write('metric: 1\n');
} else {
  process.stderr.write(`unknown fixture mode: ${String(mode)}\n`);
  process.exitCode = 64;
}
