#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  findProjectRoot,
  isPathInside,
  normalizeForComparison,
} = require('./runtime/runtime-paths.cjs');
const {
  readCoordinationFiles,
} = require('./runtime/session-store.cjs');
const {
  parseStateDocument,
  validateSession,
} = require('./runtime/session-codec.cjs');

const CLAUDE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Bash']);
const RECOGNIZED_INACTIVE = new Set(['initializing', 'paused', 'completed', 'aborted']);
const LOCK_OPTIONS = Object.freeze({ timeoutMs: 250, recoveryTimeoutMs: 250 });
const PROTECTED_BASENAME = /(?:^|[\\/\s"'])(?:prepare\.(?:cjs|py)|prepare\.config\.json|prepare-protocol\.md|program\.md|strategy\.yaml)(?=$|[\\/\s"':])/i;
const PROTECTED_NAME_KINDS = Object.freeze([
  ['prepare', ['prepare.cjs', 'prepare.config.json', 'prepare.py', 'prepare-protocol.md']],
  ['program', ['program.md']],
  ['strategy', ['strategy.yaml']],
]);
const POSIX_CHARACTER_CLASSES = new Set([
  'alnum', 'alpha', 'blank', 'cntrl', 'digit', 'graph',
  'lower', 'print', 'punct', 'space', 'upper', 'xdigit',
]);
const POSIX_SHELL_EXECUTABLES = new Set([
  'ash', 'ash.exe',
  'bash', 'bash.exe',
  'dash', 'dash.exe',
  'ksh', 'ksh.exe',
  'sh', 'sh.exe',
  'zsh', 'zsh.exe',
]);
const MAX_INSPECTION_BYTES = 65_536;
const MAX_INSPECTION_WORDS = 256;
const MAX_INSPECTION_SEGMENTS = 64;
const MAX_NESTED_SHELL_PAYLOADS = 2;
const MAX_TRANSPARENT_WRAPPERS = 8;

const REASONS = Object.freeze({
  protected: 'Deep Evolve Guard: active sessions protect prepare.cjs, prepare.config.json, legacy prepare.py, prepare-protocol.md, program.md, and strategy.yaml. Use the matching meta mode for an authorized policy update.',
  sealed: 'Deep Evolve Guard (seal_prepare_read): active-session reads of prepare.cjs, prepare.config.json, legacy prepare.py, and prepare-protocol.md are sealed.',
  legacy: 'Deep Evolve Guard (legacy_prepare_regeneration_required): prepare.py is a migration input only. Regenerate prepare.cjs instead of executing Python.',
  malformed: 'Deep Evolve Guard (malformed_input): the hook received an invalid or unsupported host event and denied it safely.',
  ambiguous: 'Deep Evolve Guard (ambiguous_protected_reference): the request mentions a protected file but does not contain a supported structured path.',
  state: 'Deep Evolve Guard (state_invalid): active-session state could not be read safely, so a possibly protected request was denied.',
  internal: 'Deep Evolve Guard (internal_error): the request was denied because the guard could not evaluate it safely.',
});

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function allow() {
  return { exitCode: 0, output: '' };
}

function block(reason) {
  return {
    exitCode: 2,
    output: JSON.stringify({ decision: 'block', reason }),
  };
}

function inferPathPlatform(value) {
  return typeof value === 'string' && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value))
    ? 'win32'
    : process.platform;
}

function normalizeHookPath(value, platform = inferPathPlatform(value)) {
  return normalizeForComparison(value, platform);
}

function canonicalWindowsPath(value) {
  const api = path.win32;
  let cursor = api.resolve(value);
  const missing = [];
  for (;;) {
    try {
      return api.resolve(fs.realpathSync.native(cursor), ...missing);
    } catch {
      const parent = api.dirname(cursor);
      if (parent === cursor) return api.resolve(value);
      missing.unshift(api.basename(cursor));
      cursor = parent;
    }
  }
}

function sameHookPath(left, right, platform = inferPathPlatform(`${left || ''}${right || ''}`)) {
  try {
    const normalizedLeft = normalizeHookPath(left, platform);
    const normalizedRight = normalizeHookPath(right, platform);
    if (normalizedLeft === normalizedRight) return true;
    if (platform !== 'win32') return false;
    return normalizeHookPath(canonicalWindowsPath(left), platform)
      === normalizeHookPath(canonicalWindowsPath(right), platform);
  } catch {
    return false;
  }
}

function relativeHookPath(parent, candidate, platform = inferPathPlatform(`${parent || ''}${candidate || ''}`)) {
  try {
    const api = platform === 'win32' ? path.win32 : path.posix;
    const base = platform === 'win32' ? canonicalWindowsPath(parent) : parent;
    const child = platform === 'win32' ? canonicalWindowsPath(candidate) : candidate;
    if (!isPathInside(base, child, platform)) return null;
    return api.relative(base, child).replace(/\\/g, '/');
  } catch {
    return null;
  }
}

function unquote(value) {
  const text = String(value || '').trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

function parsePatchCommand(command) {
  if (typeof command !== 'string') return { valid: false, paths: [] };
  const paths = [];
  let currentSection = null;
  let began = false;
  let ended = false;
  let valid = true;
  for (const line of command.split(/\r?\n/)) {
    if (!line.startsWith('***')) continue;
    if (line === '*** Begin Patch') {
      if (began || ended) valid = false;
      began = true;
      continue;
    }
    if (line === '*** End Patch') {
      if (!began || ended) valid = false;
      ended = true;
      currentSection = null;
      continue;
    }
    const fileHeader = line.match(/^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/);
    if (fileHeader) {
      const candidate = unquote(fileHeader[2]);
      if (!began || ended || !candidate) valid = false;
      else {
        paths.push(candidate);
        currentSection = fileHeader[1].toLowerCase();
      }
      continue;
    }
    const moveHeader = line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
    if (moveHeader) {
      const candidate = unquote(moveHeader[1]);
      if (!began || ended || currentSection !== 'update' || !candidate) valid = false;
      else paths.push(candidate);
      continue;
    }
    if (line === '*** End of File') {
      if (!began || ended || currentSection !== 'update') valid = false;
      continue;
    }
    valid = false;
  }
  return { valid: valid && began && ended && paths.length > 0, paths };
}

function extractPatchPaths(command) {
  const parsed = parsePatchCommand(command);
  return parsed.valid ? parsed.paths.map((candidate) => {
    const api = inferPathPlatform(candidate) === 'win32' ? path.win32 : path.posix;
    return api.normalize(candidate);
  }) : [];
}

function tokenizeCommand(command, platform = process.platform) {
  if (typeof command !== 'string') return { valid: false, words: [], controls: [] };
  const powershell = platform === 'powershell';
  const posixShell = platform !== 'win32' && !powershell;
  const words = [];
  const controls = [];
  let current = '';
  let quote = null;
  let valid = true;
  const pushWord = () => {
    if (current) {
      words.push(current);
      current = '';
    }
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (powershell && char === '`' && quote !== "'") {
        const next = command[index + 1];
        if (next === undefined) {
          valid = false;
          current += char;
        } else if (next === '\n') index += 1;
        else if (next === '\r' && command[index + 2] === '\n') index += 2;
        else {
          current += next;
          index += 1;
        }
      }
      else if (posixShell && char === '\\' && quote === '"') {
        const next = command[index + 1];
        if (next === '\n') index += 1;
        else if (next === '\r' && command[index + 2] === '\n') index += 2;
        else if (['"', '\\', '$', String.fromCharCode(96)].includes(next)) {
          current += next;
          index += 1;
        } else current += char;
      }
      else current += char;
      continue;
    }
    if (char === '"' || (platform !== 'win32' && char === "'")) {
      quote = char;
      continue;
    }
    if (posixShell && char === '\\') {
      const next = command[index + 1];
      if (next === '\n') index += 1;
      else if (next === '\r' && command[index + 2] === '\n') index += 2;
      else if (next !== undefined) {
        current += next;
        index += 1;
      } else current += char;
      continue;
    }
    if (powershell && char === '`') {
      const next = command[index + 1];
      if (next === undefined) {
        valid = false;
        current += char;
      } else if (next === '\n') {
        index += 1;
      } else if (next === '\r' && command[index + 2] === '\n') {
        index += 2;
      } else {
        current += next;
        index += 1;
      }
      continue;
    }
    if (platform === 'win32' && char === '^') {
      const next = command[index + 1];
      if (next === undefined) {
        valid = false;
        current += char;
      } else if (next === '\n') {
        index += 1;
      } else if (next === '\r' && command[index + 2] === '\n') {
        index += 2;
      } else {
        current += next;
        index += 1;
      }
      continue;
    }
    if (char === '\r' || char === '\n') {
      pushWord();
      if (char === '\r' && command[index + 1] === '\n') index += 1;
      controls.push('newline');
      continue;
    }
    if (';&|()<>'.includes(char)) {
      pushWord();
      const pair = `${char}${command[index + 1] || ''}`;
      if (pair === '&&' || pair === '||' || pair === '<<' || pair === '>>') index += 1;
      controls.push(pair === '&&' || pair === '||' || pair === '<<' || pair === '>>' ? pair : char);
      continue;
    }
    if (/\s/.test(char)) {
      pushWord();
      continue;
    }
    current += char;
  }
  pushWord();
  return { valid: valid && quote === null, words, controls };
}

function posixCharacterClassMatches(name, character) {
  const code = character.codePointAt(0);
  const alpha = /[A-Za-z]/.test(character);
  const digit = /[0-9]/.test(character);
  if (name === 'alnum') return alpha || digit;
  if (name === 'alpha') return alpha;
  if (name === 'blank') return character === ' ' || character === '\t';
  if (name === 'cntrl') return code <= 0x1f || code === 0x7f;
  if (name === 'digit') return digit;
  if (name === 'graph') return code >= 0x21 && code <= 0x7e;
  if (name === 'lower') return /[a-z]/.test(character);
  if (name === 'print') return code >= 0x20 && code <= 0x7e;
  if (name === 'punct') return code >= 0x21 && code <= 0x7e && !alpha && !digit;
  if (name === 'space') return /[\t\n\v\f\r ]/.test(character);
  if (name === 'upper') return /[A-Z]/.test(character);
  if (name === 'xdigit') return /[A-Fa-f0-9]/.test(character);
  return false;
}

function ambiguousBracketEnd(pattern, start) {
  const doubledClose = pattern.indexOf(']]', start + 1);
  if (doubledClose !== -1) return doubledClose + 1;
  const close = pattern.indexOf(']', start + 1);
  return close === -1 ? start : close;
}

function parseBracketExpression(pattern, start) {
  let cursor = start + 1;
  let negated = false;
  let sawSpecial = false;
  const members = [];
  if (pattern[cursor] === '!' || pattern[cursor] === '^') {
    negated = true;
    cursor += 1;
  }
  // POSIX: a right bracket in the first member position is literal.
  if (pattern[cursor] === ']') {
    members.push({ kind: 'literal', value: ']' });
    cursor += 1;
  }
  for (; cursor < pattern.length; cursor += 1) {
    const character = pattern[cursor];
    if (character === ']' && members.length > 0) {
      const normalized = [];
      for (let index = 0; index < members.length; index += 1) {
        const left = members[index];
        const dash = members[index + 1];
        const right = members[index + 2];
        if (left?.kind === 'literal' && dash?.kind === 'literal' && dash.value === '-'
          && right?.kind === 'literal') {
          normalized.push({ kind: 'range', start: left.value, end: right.value });
          index += 2;
        } else normalized.push(left);
      }
      return { kind: 'class', close: cursor, negated, members: normalized };
    }
    if (character === '[') {
      const marker = pattern[cursor + 1];
      if (marker === ':' || marker === '.' || marker === '=') {
        sawSpecial = true;
        const specialClose = pattern.indexOf(`${marker}]`, cursor + 2);
        if (specialClose === -1) {
          return { kind: 'ambiguous', close: ambiguousBracketEnd(pattern, start) };
        }
        const value = pattern.slice(cursor + 2, specialClose);
        if (marker !== ':' || !POSIX_CHARACTER_CLASSES.has(value)) {
          const outerClose = pattern[specialClose + 2] === ']' ? specialClose + 2 : specialClose + 1;
          return { kind: 'ambiguous', close: outerClose };
        }
        members.push({ kind: 'named', value });
        cursor = specialClose + 1;
        continue;
      }
      return { kind: 'ambiguous', close: ambiguousBracketEnd(pattern, start) };
    }
    members.push({ kind: 'literal', value: character });
  }
  return sawSpecial
    ? { kind: 'ambiguous', close: ambiguousBracketEnd(pattern, start) }
    : { kind: 'literal' };
}

function bracketClassMatches(token, character) {
  let matched = false;
  for (const member of token.members) {
    if (member.kind === 'literal' && member.value === character) matched = true;
    else if (member.kind === 'range' && character >= member.start && character <= member.end) matched = true;
    else if (member.kind === 'named' && posixCharacterClassMatches(member.value, character)) matched = true;
  }
  return token.negated ? !matched : matched;
}

function parseGlobTokens(pattern) {
  const tokens = [];
  let ambiguous = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' });
      continue;
    }
    if (character === '?') {
      tokens.push({ kind: 'any' });
      continue;
    }
    if (character === '[') {
      const parsed = parseBracketExpression(pattern, index);
      if (parsed.kind === 'class') {
        tokens.push(parsed);
        index = parsed.close;
        continue;
      }
      if (parsed.kind === 'ambiguous') {
        tokens.push({ kind: 'any' });
        ambiguous = true;
        index = parsed.close;
        continue;
      }
    }
    tokens.push({ kind: 'literal', value: character });
  }
  return { tokens, ambiguous };
}

function ambiguousGlobCouldMatch(pattern, name) {
  const firstBracket = pattern.indexOf('[');
  if (firstBracket === -1) return false;
  const prefix = pattern.slice(0, firstBracket);
  const suffix = pattern.match(/[A-Za-z0-9_.-]+$/)?.[0] || '';
  return prefix.length + suffix.length <= name.length
    && name.startsWith(prefix)
    && name.endsWith(suffix);
}

function globPatternMatchesName(pattern, name, caseInsensitive = false) {
  const candidate = caseInsensitive ? pattern.toLowerCase() : pattern;
  const target = caseInsensitive ? name.toLowerCase() : name;
  const parsed = parseGlobTokens(candidate);
  const { tokens } = parsed;
  let previous = new Array(target.length + 1).fill(false);
  previous[0] = true;
  for (const token of tokens) {
    const current = new Array(target.length + 1).fill(false);
    if (token.kind === 'star') current[0] = previous[0];
    for (let index = 1; index <= target.length; index += 1) {
      if (token.kind === 'star') current[index] = previous[index] || current[index - 1];
      else if (token.kind === 'any') current[index] = previous[index - 1];
      else if (token.kind === 'literal') {
        current[index] = previous[index - 1] && token.value === target[index - 1];
      } else if (token.kind === 'class') {
        current[index] = previous[index - 1] && bracketClassMatches(token, target[index - 1]);
      }
    }
    previous = current;
  }
  return previous[target.length]
    || (parsed.ambiguous && ambiguousGlobCouldMatch(candidate, target));
}

function escapedShellTextMatchesName(source, name, caseInsensitive = false, platform = process.platform) {
  const text = String(source || '');
  const deescaped = text.replace(/[\^`]/g, '');
  if (deescaped === text) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = caseInsensitive ? 'i' : '';
  const target = `(?:^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_.-])`;
  if (!new RegExp(target, flags).test(deescaped)) return false;
  const redirected = new RegExp(
    `>{1,2}\\s*["']?(?:[^\\s"'<>]*[\\\\/])?${escaped}(?=$|[^A-Za-z0-9_.-])`, flags,
  );
  const mutators = new Set([
    'set-content', 'add-content', 'clear-content', 'out-file', 'remove-item',
    'move-item', 'copy-item', 'rename-item', 'new-item', 'rm', 'del', 'erase',
    'move', 'copy', 'ren', 'tee', 'sed',
  ]);
  const split = splitCommandSegments(deescaped, platform);
  if (!split.valid) return true;
  for (const segment of split.segments) {
    if (!new RegExp(target, flags).test(segment)) continue;
    const parsed = tokenizeCommand(segment, platform);
    if (!parsed.valid) return true;
    const executable = parsedExecutable(parsed.words);
    if (executable.ambiguous) return true;
    if (mutators.has(executable.executable || '')) return true;
    if (parsed.controls.some((control) => control === '>' || control === '>>')
      && redirected.test(segment)) return true;
  }
  return false;
}

function splitCommandSegments(command, platform) {
  const powershell = platform === 'powershell';
  const posixShell = platform !== 'win32' && !powershell;
  const segments = [];
  let current = '';
  let quote = null;
  let valid = true;
  const push = () => {
    const candidate = current.trim();
    if (candidate) segments.push(candidate);
    current = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      else if ((powershell && character === '`' && quote !== "'")
        || (posixShell && character === '\\' && quote === '"')) {
        if (command[index + 1] === undefined) valid = false;
        else {
          current += command[index + 1];
          index += 1;
        }
      }
      continue;
    }
    if (character === '"' || (platform !== 'win32' && character === "'")) {
      quote = character;
      current += character;
      continue;
    }
    if ((posixShell && character === '\\') || (powershell && character === '`')
      || (platform === 'win32' && character === '^')) {
      current += character;
      if (command[index + 1] === undefined) valid = false;
      else {
        current += command[index + 1];
        index += 1;
      }
      continue;
    }
    if (character === '\r' || character === '\n' || ';&|()'.includes(character)) {
      push();
      const pair = `${character}${command[index + 1] || ''}`;
      if (pair === '&&' || pair === '||' || (character === '\r' && command[index + 1] === '\n')) index += 1;
      if (segments.length > MAX_INSPECTION_SEGMENTS) return { valid: false, segments: [] };
      continue;
    }
    current += character;
  }
  push();
  return { valid: valid && quote === null, segments };
}

function parsedExecutable(words) {
  let index = 0;
  const shellAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
  while (shellAssignment.test(words[index] || '')) index += 1;
  let wrapperCount = 0;
  for (;;) {
    const executable = executableName(words[index]);
    if (!executable) return wrapperCount > 0 ? { ambiguous: true } : { ambiguous: false };
    const transparent = executable === 'env' || executable === 'env.exe'
      || executable === 'command' || executable === 'exec' || executable === 'nohup';
    if (!transparent) return { index, executable, ambiguous: false };
    wrapperCount += 1;
    if (wrapperCount > MAX_TRANSPARENT_WRAPPERS) return { ambiguous: true };

    if (executable === 'env' || executable === 'env.exe') {
      index += 1;
      let optionsActive = true;
      while (index < words.length) {
        const word = words[index];
        if (optionsActive && word === '--') {
          optionsActive = false;
          index += 1;
          continue;
        }
        if (word.includes('=') && (!optionsActive || !word.startsWith('-'))) {
          optionsActive = false;
          index += 1;
          continue;
        }
        if (!optionsActive) break;
        if (word === '-S' || word === '--split-string' || /^--split-string=/.test(word)) {
          // `env -S` contains a second argv grammar. Keep this bounded guard
          // non-evaluating and deny rather than guess how the host will split it.
          return { ambiguous: true };
        }
        if (word === '-u' || word === '--unset' || word === '-c' || word === '--chdir') {
          if (words[index + 1] === undefined) return { ambiguous: true };
          index += 2;
          continue;
        }
        if (/^(?:--unset|--chdir)=/.test(word)
          || /^(?:-i|--ignore-environment|-0|--null|--debug)$/.test(word)) {
          index += 1;
          continue;
        }
        if (word.startsWith('-')) return { ambiguous: true };
        break;
      }
      continue;
    }

    if (executable === 'command') {
      index += 1;
      while (index < words.length) {
        const word = words[index];
        if (word === '--' || word === '-p') {
          index += 1;
          continue;
        }
        if (word === '-v' || word === '-V') return { ambiguous: false };
        if (word.startsWith('-')) return { ambiguous: true };
        break;
      }
      continue;
    }

    if (executable === 'exec') {
      index += 1;
      while (index < words.length) {
        const word = words[index];
        if (word === '--' || word === '-c' || word === '-l') {
          index += 1;
          continue;
        }
        if (word === '-a') {
          if (words[index + 1] === undefined) return { ambiguous: true };
          index += 2;
          continue;
        }
        if (word.startsWith('-')) return { ambiguous: true };
        break;
      }
      continue;
    }

    index += 1;
    if (words[index] === '--') index += 1;
    else if (/^--(?:help|version)$/.test(words[index] || '')) return { ambiguous: false };
    else if ((words[index] || '').startsWith('-')) return { ambiguous: true };
  }
}

function shellDialect(executable) {
  if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(executable)) return 'powershell';
  if (/^cmd(?:\.exe)?$/.test(executable)) return 'win32';
  if (POSIX_SHELL_EXECUTABLES.has(executable)) return 'posix';
  return null;
}

function shellPayload(words, executableIndex, dialect) {
  const args = words.slice(executableIndex + 1);
  if (dialect === 'win32') {
    if (args.some((word) => /^\/[ck].+/i.test(word))) return { kind: 'ambiguous' };
    const marker = args.findIndex((word) => /^\/[ck]$/i.test(word));
    if (marker === -1) return { kind: 'ambiguous' };
    const payload = args.slice(marker + 1).join(' ');
    return payload ? { kind: 'payload', payload } : { kind: 'ambiguous' };
  }
  if (dialect === 'powershell') {
    if (args.some((word) => {
      const flag = /^-([A-Za-z]+)$/.exec(word)?.[1]?.toLowerCase();
      return Boolean(flag) && 'encodedcommand'.startsWith(flag);
    })) {
      return { kind: 'ambiguous' };
    }
    const marker = args.findIndex((word) => {
      const flag = /^-([A-Za-z]+)$/.exec(word)?.[1]?.toLowerCase();
      return Boolean(flag) && 'command'.startsWith(flag);
    });
    if (marker === -1) return { kind: 'ambiguous' };
    const payload = args.slice(marker + 1).join(' ');
    return payload && payload !== '-' ? { kind: 'payload', payload } : { kind: 'ambiguous' };
  }
  const marker = args.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
  if (marker === -1) return { kind: 'ambiguous' };
  const payload = args[marker + 1];
  return payload ? { kind: 'payload', payload } : { kind: 'ambiguous' };
}

function lexicalReconstructions(command, primaryPlatform) {
  const reconstructions = [];
  const seen = new Set();
  let ambiguous = false;
  const add = (source, platform, shellPayload = false) => {
    if (Buffer.byteLength(source, 'utf8') > MAX_INSPECTION_BYTES) {
      ambiguous = true;
      return null;
    }
    const parsed = tokenizeCommand(source, platform);
    if (parsed.words.length > MAX_INSPECTION_WORDS) {
      ambiguous = true;
      return null;
    }
    const key = `${platform}\0${shellPayload}\0${parsed.valid}\0${parsed.words.join('\0')}\0${parsed.controls.join('\0')}`;
    if (!seen.has(key)) {
      seen.add(key);
      reconstructions.push({ platform, parsed, shellPayload, source });
    }
    return parsed;
  };
  const inspect = (source, platform, depth) => {
    const parsed = add(source, platform, depth > 0);
    if (!parsed) return;
    const split = splitCommandSegments(source, platform);
    if (!split.valid || split.segments.length > MAX_INSPECTION_SEGMENTS) {
      ambiguous = true;
      return;
    }
    for (const segment of split.segments) {
      const outerParsed = tokenizeCommand(segment, platform);
      if (outerParsed.words.length > MAX_INSPECTION_WORDS) {
        ambiguous = true;
        continue;
      }
      const outerExecutable = parsedExecutable(outerParsed.words);
      if (outerExecutable.ambiguous) {
        ambiguous = true;
        continue;
      }
      const dialect = shellDialect(outerExecutable.executable || '');
      if (!dialect) continue;
      const shellParsed = dialect === platform ? outerParsed : add(segment, dialect, depth > 0);
      if (!shellParsed || !shellParsed.valid) {
        ambiguous = true;
        continue;
      }
      const shellExecutable = parsedExecutable(shellParsed.words);
      if (shellExecutable.ambiguous || !shellDialect(shellExecutable.executable || '')) {
        ambiguous = true;
        continue;
      }
      const nested = shellPayload(shellParsed.words, shellExecutable.index, dialect);
      if (nested.kind === 'ambiguous') {
        ambiguous = true;
        continue;
      }
      if (nested.kind !== 'payload') continue;
      if (depth >= MAX_NESTED_SHELL_PAYLOADS) {
        ambiguous = true;
        continue;
      }
      inspect(nested.payload, dialect, depth + 1);
    }
  };

  inspect(String(command || ''), primaryPlatform, 0);
  if (primaryPlatform !== 'posix') add(String(command || ''), 'posix');
  if (ambiguous) reconstructions.push({
    platform: 'ambiguous',
    ambiguous: true,
    shellPayload: false,
    source: '',
    parsed: { valid: false, words: [], controls: [] },
  });
  return reconstructions;
}

function splitGlobFragments(source) {
  const fragments = [];
  let current = '';
  let bracketDepth = 0;
  const push = () => {
    if (current && /[*?[]/.test(current)) fragments.push(current);
    current = '';
  };
  for (const character of String(source || '')) {
    if (character === '[') {
      bracketDepth += 1;
      current += character;
    } else if (character === ']') {
      if (bracketDepth > 0) bracketDepth -= 1;
      current += character;
    } else if (bracketDepth === 0 && /[\s"'`;|&()<>{}=,:/\\]/.test(character)) push();
    else current += character;
  }
  push();
  return fragments;
}

function commandPatternTargets(command, platform = inferCommandPlatform(command)) {
  const targets = new Set();
  const reconstructions = lexicalReconstructions(command, platform);
  for (let lane = 0; lane < reconstructions.length; lane += 1) {
    const {
      platform: lanePlatform, parsed, ambiguous, shellPayload, source,
    } = reconstructions[lane];
    if (ambiguous) {
      targets.add('ambiguous');
      continue;
    }
    const fragments = new Set();
    const sources = lane === 0 || shellPayload
      ? [String(source || command || ''), ...parsed.words] : parsed.words;
    for (const source of sources) {
      for (const fragment of splitGlobFragments(source)) fragments.add(fragment);
    }
    const caseInsensitive = lanePlatform === 'win32' || lanePlatform === 'powershell';
    for (const [kind, names] of PROTECTED_NAME_KINDS) {
      if (names.some((name) => [...fragments].some(
        (fragment) => globPatternMatchesName(fragment, name, caseInsensitive),
      ))) targets.add(kind);
      if (shellPayload && names.some((name) => escapedShellTextMatchesName(
        source, name, caseInsensitive, lanePlatform,
      ))) targets.add('ambiguous');
    }
  }
  return targets;
}

function executableName(value) {
  return String(value || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
}

function resolveRequestedPath(value, projectRoot) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const platform = process.platform;
  const api = platform === 'win32' ? path.win32 : path.posix;
  return api.isAbsolute(value) ? api.normalize(value) : api.resolve(projectRoot, value);
}

function findEvolveRoot(cwd) {
  let cursor = path.resolve(cwd || process.cwd());
  for (;;) {
    const discovered = findProjectRoot(cursor);
    if (!discovered) return null;
    if (fs.existsSync(path.join(discovered, '.deep-evolve'))) return discovered;
    const parent = path.dirname(discovered);
    if (parent === discovered) return null;
    cursor = parent;
  }
}

function loadSessionContext(cwd) {
  const projectRoot = findEvolveRoot(cwd);
  if (!projectRoot) return { kind: 'absent' };
  const stateRoot = path.join(projectRoot, '.deep-evolve');
  const currentRaw = readCoordinationFiles(stateRoot, ['current.json'], LOCK_OPTIONS)['current.json'];
  let sessionRoot;
  let sessionPath;
  let sessionRaw;
  if (currentRaw) {
    let current;
    try { current = JSON.parse(currentRaw); }
    catch { throw Object.assign(new Error('current.json is not valid JSON'), { code: 'current_invalid' }); }
    if (!plainObject(current) || typeof current.session_id !== 'string' || current.session_id.length === 0) {
      throw Object.assign(new Error('current.json has no valid session_id'), { code: 'current_invalid' });
    }
    sessionRoot = path.resolve(stateRoot, current.session_id);
    if (!isPathInside(stateRoot, sessionRoot) || sameHookPath(stateRoot, sessionRoot)) {
      throw Object.assign(new Error('current.json session_id escapes state root'), { code: 'current_invalid' });
    }
    sessionPath = path.join(sessionRoot, 'session.yaml');
    const relativeSession = path.relative(stateRoot, sessionPath);
    const snapshot = readCoordinationFiles(stateRoot, ['current.json', relativeSession], LOCK_OPTIONS);
    let snapshotCurrent;
    try { snapshotCurrent = JSON.parse(snapshot['current.json']); }
    catch { throw Object.assign(new Error('current.json changed during state read'), { code: 'current_invalid' }); }
    if (!plainObject(snapshotCurrent) || snapshotCurrent.session_id !== current.session_id) {
      throw Object.assign(new Error('current session changed during state read'), { code: 'state_changed' });
    }
    sessionRaw = snapshot[relativeSession];
  } else {
    sessionRoot = stateRoot;
    sessionPath = path.join(stateRoot, 'session.yaml');
    const snapshot = readCoordinationFiles(stateRoot, ['current.json', 'session.yaml'], LOCK_OPTIONS);
    if (snapshot['current.json']) {
      throw Object.assign(new Error('current session appeared during flat state read'), { code: 'state_changed' });
    }
    sessionRaw = snapshot['session.yaml'];
  }
  if (!sessionRaw) return { kind: 'absent' };
  const session = validateSession(parseStateDocument(sessionRaw, { sourcePath: sessionPath }));
  if (session.status !== 'active') {
    if (!RECOGNIZED_INACTIVE.has(session.status)) {
      throw Object.assign(new Error(`unsupported session status ${JSON.stringify(session.status)}`), { code: 'state_invalid' });
    }
    return { kind: 'inactive', projectRoot, stateRoot, sessionRoot, session };
  }
  return { kind: 'active', projectRoot, stateRoot, sessionRoot, session };
}

function parseInvocation(event, env) {
  if (!plainObject(event)) throw Object.assign(new Error('event must be an object'), { code: 'malformed_input' });
  const ownsOfficialTool = Object.hasOwn(event, 'tool_name');
  const ownsOfficialInput = Object.hasOwn(event, 'tool_input');
  if (ownsOfficialTool || ownsOfficialInput) {
    if (typeof event.tool_name !== 'string') {
      throw Object.assign(new Error('host event requires a string tool_name'), { code: 'malformed_input' });
    }
    const officialTool = event.tool_name;
    if (!plainObject(event.tool_input)) {
      throw Object.assign(new Error('host event requires tool_input'), { code: 'malformed_input' });
    }
    if (CLAUDE_TOOLS.has(officialTool)) {
      if (officialTool === 'Bash') {
        if (typeof event.tool_input.command !== 'string') {
          throw Object.assign(new Error('Bash input requires command'), { code: 'malformed_input' });
        }
        return {
          host: 'claude', kind: 'shell', toolName: officialTool,
          command: event.tool_input.command, paths: [],
          platform: inferCommandPlatform(event.tool_input.command),
        };
      }
      if (typeof event.tool_input.file_path !== 'string' || event.tool_input.file_path.length === 0) {
        throw Object.assign(new Error('Claude file tool input requires file_path'), { code: 'malformed_input' });
      }
      return {
        host: 'claude',
        kind: officialTool === 'Read' ? 'read' : 'write',
        toolName: officialTool,
        command: '',
        paths: [event.tool_input.file_path],
        platform: process.platform,
      };
    }
    if (officialTool !== 'apply_patch' || typeof event.tool_input.command !== 'string') {
      throw Object.assign(new Error('unsupported host PreToolUse shape'), { code: 'malformed_input' });
    }
    return {
      host: 'codex',
      kind: 'patch',
      toolName: 'apply_patch',
      command: event.tool_input.command,
      paths: extractPatchPaths(event.tool_input.command),
      platform: process.platform,
    };
  }

  // Compatibility with the pre-envelope Claude wrapper. Official events above
  // always win, so an inherited selector cannot misclassify Codex stdin.
  const claudeTool = env.CLAUDE_TOOL_USE_TOOL_NAME || env.CLAUDE_TOOL_NAME;
  if (claudeTool) {
    if (!CLAUDE_TOOLS.has(claudeTool)) throw Object.assign(new Error('unsupported Claude tool'), { code: 'malformed_input' });
    if (claudeTool === 'Bash') {
      if (typeof event.command !== 'string') throw Object.assign(new Error('Claude Bash input requires command'), { code: 'malformed_input' });
      return {
        host: 'claude', kind: 'shell', toolName: claudeTool, command: event.command,
        paths: [], platform: inferCommandPlatform(event.command),
      };
    }
    if (typeof event.file_path !== 'string' || event.file_path.length === 0) {
      throw Object.assign(new Error('Claude file tool input requires file_path'), { code: 'malformed_input' });
    }
    return {
      host: 'claude',
      kind: claudeTool === 'Read' ? 'read' : 'write',
      toolName: claudeTool,
      command: '',
      paths: [event.file_path],
      platform: process.platform,
    };
  }
  throw Object.assign(new Error('unsupported PreToolUse shape'), { code: 'malformed_input' });
}

function inferCommandPlatform(command) {
  const nativePlatform = process.platform === 'win32' ? 'win32' : 'posix';
  const [leading] = tokenizeCommand(command, nativePlatform).words;
  const executable = executableName(leading);
  if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(executable)) return 'powershell';
  if (/^cmd(?:\.exe)?$/.test(executable)) return 'win32';
  return nativePlatform;
}

function requestCouldBeProtected(request) {
  if (request.kind === 'patch') {
    return request.paths.some((candidate) => PROTECTED_BASENAME.test(candidate));
  }
  return request.paths.some((candidate) => PROTECTED_BASENAME.test(candidate))
    || commandTargets(request.command || '', request.platform).size > 0
    || commandPatternTargets(request.command || '', request.platform).size > 0;
}

function protectedKind(candidate, context) {
  const requested = resolveRequestedPath(candidate, context.projectRoot);
  if (!requested) return null;
  const platform = process.platform;
  const same = (relative) => sameHookPath(requested, path.join(context.sessionRoot, relative), platform);
  if (same('prepare.cjs') || same('prepare.config.json') || same('prepare.py') || same('prepare-protocol.md')) return 'prepare';
  if (same('program.md')) return 'program';
  if (same('strategy.yaml')) return 'strategy';

  const worktreesRoot = path.join(context.sessionRoot, 'worktrees');
  const relative = relativeHookPath(worktreesRoot, requested, platform);
  if (relative && /^seed_[^/]+\/program\.md$/i.test(relative)) return 'program';
  return null;
}

function registryHelperPath(candidate, context) {
  const requested = resolveRequestedPath(candidate, context.projectRoot);
  if (!requested) return false;
  return [
    path.join(context.stateRoot, 'current.json'),
    path.join(context.stateRoot, 'sessions.jsonl'),
    path.join(context.sessionRoot, 'session.yaml'),
  ].some((target) => sameHookPath(requested, target, process.platform));
}

function permittedByMeta(kind, metaMode) {
  if (kind === 'prepare') return metaMode === 'prepare_update';
  if (kind === 'program') return metaMode === 'program_update' || metaMode === 'outer_loop';
  if (kind === 'strategy') return metaMode === 'outer_loop';
  return true;
}

function containsCommandBasename(command, basename, parsed = tokenizeCommand(command)) {
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_.-])`, 'i');
  return pattern.test(String(command || '')) || parsed.words.some((word) => pattern.test(word));
}

function commandTargets(command, platform = inferCommandPlatform(command)) {
  const targets = new Set();
  const parsedVariants = lexicalReconstructions(command, platform).map(({ parsed }) => parsed);
  for (const [kind, names] of PROTECTED_NAME_KINDS) {
    if (names.some((name) => parsedVariants.some(
      (parsed) => containsCommandBasename(command, name, parsed),
    ))) targets.add(kind);
  }
  return targets;
}

function pythonLauncherMentioned(parsed) {
  const isPythonLauncher = (value) => {
    const executable = executableName(value);
    return /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/.test(executable)
      || executable === 'py'
      || executable === 'py.exe';
  };
  return parsed.words.some((word) => {
    if (isPythonLauncher(word)) return true;
    return word.split(/[\s;|&()<>`"'=,:]+/).some(isPythonLauncher);
  });
}

function directCommandKind(command, context, platform = inferCommandPlatform(command)) {
  const parsed = tokenizeCommand(command, platform);
  const [executableToken, targetToken] = parsed.words;
  const executable = executableName(executableToken);
  if (parsed.valid && parsed.controls.length === 0
    && (executable === 'node' || executable === 'node.exe') && parsed.words.length === 2) {
    if (protectedKind(targetToken, context) === 'prepare' && executableName(targetToken) === 'prepare.cjs') {
      return 'node_prepare';
    }
  }
  if (containsCommandBasename(command, 'prepare.py', parsed) && pythonLauncherMentioned(parsed)) {
    return 'legacy_python_prepare';
  }
  if (['prepare.cjs', 'prepare.config.json', 'prepare.py', 'prepare-protocol.md'].some((name) => containsCommandBasename(command, name, parsed))) {
    return 'ambiguous_prepare';
  }
  return null;
}

function evaluateActive(request, env, context) {
  const metaMode = env.DEEP_EVOLVE_META_MODE || '';
  const sealed = env.DEEP_EVOLVE_SEAL_PREPARE === '1';

  if (request.kind === 'read') {
    const kind = protectedKind(request.paths[0], context);
    return sealed && kind === 'prepare' ? block(REASONS.sealed) : allow();
  }

  if (request.kind === 'write' || request.kind === 'patch') {
    if (request.kind === 'write' && env.DEEP_EVOLVE_HELPER === '1'
      && request.host === 'claude' && registryHelperPath(request.paths[0], context)) {
      return allow();
    }
    for (const candidate of request.paths) {
      const kind = protectedKind(candidate, context);
      if (kind && !permittedByMeta(kind, metaMode)) return block(REASONS.protected);
    }
    return allow();
  }

  if (commandPatternTargets(request.command, request.platform).size > 0) {
    return block(REASONS.ambiguous);
  }
  const direct = directCommandKind(request.command, context, request.platform);
  if (direct === 'node_prepare') return allow();
  if (direct === 'legacy_python_prepare') return block(REASONS.legacy);
  const targets = commandTargets(request.command, request.platform);
  if (sealed && targets.has('prepare')) return block(REASONS.sealed);
  if (direct === 'ambiguous_prepare') return block(REASONS.ambiguous);
  for (const kind of targets) {
    if (!permittedByMeta(kind, metaMode)) return block(REASONS.protected);
  }
  return allow();
}

function inspectHook(event, env = process.env, cwd = process.cwd()) {
  let request;
  try { request = parseInvocation(event, env || {}); }
  catch { return { result: block(REASONS.malformed), warning: null }; }
  if (request.kind === 'patch' && request.paths.length === 0) {
    return { result: block(REASONS.ambiguous), warning: null };
  }

  let context;
  try { context = loadSessionContext(cwd); }
  catch (error) {
    const code = error && error.code ? error.code : 'state_invalid';
    const warning = `state_invalid:${code}`;
    return requestCouldBeProtected(request)
      ? { result: block(REASONS.state), warning }
      : { result: allow(), warning };
  }
  if (context.kind !== 'active') return { result: allow(), warning: null };
  try { return { result: evaluateActive(request, env || {}, context), warning: null }; }
  catch { return { result: block(REASONS.internal), warning: 'internal_error' }; }
}

function evaluateHook(event, env = process.env, cwd = process.cwd()) {
  return inspectHook(event, env, cwd).result;
}

function executableBlockReason(result) {
  try {
    const parsed = JSON.parse(result.output || '');
    if (plainObject(parsed) && typeof parsed.reason === 'string' && parsed.reason.length > 0) {
      return parsed.reason;
    }
  } catch { /* use the fixed internal marker below */ }
  return REASONS.internal;
}

function emitExecutableResult(result) {
  if (result.exitCode === 2) {
    process.stderr.write(`${executableBlockReason(result)}\n`);
  } else if (result.output) {
    process.stdout.write(`${result.output}\n`);
  }
  process.exitCode = result.exitCode;
}

function runExecutable() {
  let event;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) throw new Error('empty stdin');
    event = JSON.parse(raw);
  } catch {
    emitExecutableResult(block(REASONS.malformed));
    return;
  }
  const inspected = inspectHook(event, process.env, process.cwd());
  if (inspected.warning) process.stderr.write(`[deep-evolve/hook] ${inspected.warning}\n`);
  emitExecutableResult(inspected.result);
}

if (require.main === module) {
  try { runExecutable(); }
  catch {
    emitExecutableResult(block(REASONS.internal));
  }
}

module.exports = {
  evaluateHook,
  extractPatchPaths,
  normalizeHookPath,
  relativeHookPath,
  sameHookPath,
  tokenizeCommand,
};
