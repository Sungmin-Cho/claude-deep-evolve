'use strict';

// Reference integrity for skills/ and agents/ markdown.
//
// Ported from deep-work's guard of the same name. Two adaptations matter here:
// this plugin's executable extension is `.cjs`, and its conditional detail lives
// in `skills/deep-evolve-workflow/protocols/` rather than a `references/` dir,
// so both are part of the recognised plugin surface below.
//
// Fence balance is checked because a `protocols/` split can truncate a fenced
// block: the entry keeps the opening ``` and the first lines, the remainder
// moves behind a pointer, and nothing fails. An odd fence count is the
// machine-detectable signature of that failure class.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const ALWAYS_LOADED = ['AGENTS.md', 'CLAUDE.md'];

function markdownFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) out.push(p);
    }
  };
  walk(path.join(ROOT, 'skills'));
  walk(path.join(ROOT, 'agents'));
  // The always-loaded agent guides are instruction surfaces under the same
  // rule. `ALWAYS_LOADED` is asserted to be in the scan set by its own test, so
  // dropping it here fails loudly instead of silently shrinking coverage.
  for (const doc of ALWAYS_LOADED) {
    const p = path.join(ROOT, doc);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

// Every `.md` under skills/ and agents/ — the documents an attacker would want
// to shadow. A bare `Read(`runtime-contract.md`)` names one of these with no
// basis at all, so it resolves against cwd (the target root).
function pluginDocBasenames() {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) names.add(entry.name);
    }
  };
  walk(path.join(ROOT, 'skills'));
  walk(path.join(ROOT, 'agents'));
  return names;
}
const PLUGIN_DOCS = pluginDocBasenames();

// Workspace-shadow guard.
//
// A bare `Read agents/evolve-seed.md` or `node hooks/scripts/x.cjs` resolves
// against the *target workspace*, not the plugin. A repository under
// experimentation can put a file at that path and have it read as agent policy
// or run with the caller's permissions — and deep-evolve runs its seeds inside
// worktrees of exactly such a repository.
//
// Parent-relative forms (`../protocols/x.md`) are just as shadowable. A markdown
// link resolves against the source file, but a runtime `Read` call has no such
// basis — it resolves against cwd, which is the target root. So this guard must
// NOT reuse the reference-integrity resolution below: integrity asks "does this
// file exist?" and may resolve relative to the source; the shadow guard asks
// "does this instruction name a trustworthy basis?", and only an explicit
// plugin-root anchor does.
//
// The guard has two clauses. Both must hold for every instruction form, or the
// guard is narrower than the invariant it claims to enforce:
//
//   A. anchoring   — the path names the plugin root explicitly.
//   B. containment — the resolved path stays inside the plugin root.
//
// Clause B is not implied by A: `${CLAUDE_PLUGIN_ROOT}/../workspace/evil.cjs`
// carries the anchor and still escapes.
//
// Scope note: the invariant covers paths the plugin tells you to *open or run*.
const PLUGIN_DIRS = 'skills|agents|scripts|hooks|templates|protocols';
// One spelling only. `CLAUDE_PLUGIN_ROOT` is the name this repo's hook bootstrap
// reads first; a second placeholder token would give a reader two things to keep
// in sync and the guard two things to trust.
const ANCHOR = String.raw`\$\{CLAUDE_PLUGIN_ROOT\}`;

// SEPARATOR NORMALISATION — one place, applied the moment a token is recognised.
//
// `node hooks\scripts\deep-evolve-runtime.cjs` is the same instruction as the
// slash form and just as shadowable, but every rule below compares against
// slash-shaped keys. Teaching each rule about backslashes is the losing move:
// `scripts\lib/x.js` mixes both and slips through whichever rule learned only
// one. So the token is normalised once, at recognition, and every consumer —
// deny-by-default, FORMS, bare-basename, containment, the resolver and the
// malicious-workspace fixture — sees the same representation.
//
// The *same* function normalises the PLUGIN_FILES keys. Normalising only the
// lookup side is a real bug, not a theoretical one: on Windows `path.relative`
// yields backslash keys, so a slash-shaped lookup misses every one of them.
// A *run* of separators collapses to one. `hooks\\scripts\\x.cjs` and
// `hooks//scripts//x.cjs` name the same file as the single-separator form, and
// every filesystem treats them that way — but a set keyed on single slashes does
// not, so without collapsing, `resolvesInPlugin` misses and the rules that
// depend on it go quiet while the path stays perfectly reachable.
function normalizeSeparators(value) {
  return typeof value === 'string' ? value.replace(/[\\/]+/g, '/') : value;
}

const ANCHORED_TOKEN = new RegExp(`^(?:${ANCHOR})/`);
const SEP = String.raw`[\\/]`;
const PATH_BODY = String.raw`[A-Za-z0-9._/\\${'{}'}|$-]+`;
const REL = String.raw`\.{1,2}${SEP}`;
const ANY_ROOT = String.raw`(?:(?:${ANCHOR})${SEP}|${REL}|(?:${PLUGIN_DIRS})${SEP})`;
// `.cjs` is this plugin's runtime extension — the dispatcher, every runtime
// module and every evaluator template. Omitting it would leave the single most
// frequently named executable class unchecked.
const EXEC_EXT = 'cjs|mjs|js|sh|py';

// Each pattern captures the path token in group 1, so anchoring and containment
// are judged per token rather than per line — a line mixing an anchored and a
// bare path must still fail on the bare one.
const FORMS = [
  // 1. interpreter exec: `node X`, `bash X`, `python X`
  ['interpreter-exec', new RegExp(String.raw`\b(?:bash|sh|zsh|node|python3?)\s+["'\`]?(${ANY_ROOT}${PATH_BODY})`, 'g')],
  // 2. read verb: `Read X`, `Follow X`, `Read("X")`
  ['read-verb', new RegExp(String.raw`\b(?:Read|Follow|read|follow)\s*\(?\s*["'\`]?(${ANY_ROOT}${PATH_BODY}\.md)`, 'g')],
  // 3. direct exec / source: `source X`, `. X`, `exec X`, `./X`
  ['direct-exec', new RegExp(String.raw`(?:\b(?:source|exec)\s+|^\s*\.\s+)["'\`]?(${ANY_ROOT}${PATH_BODY})`, 'gm')],
  // 4. module load: `require("X")`, `import … from "X"`
  ['module-load', new RegExp(String.raw`(?:\brequire\s*\(|\bfrom\s+)["'\`](${ANY_ROOT}${PATH_BODY})`, 'g')],
  // 5. executable path token anywhere. The trailing boundary matters: without it
  // `.js` matches the prefix of `.json` and the guard reports a file that does
  // not exist.
  ['executable-token', new RegExp(String.raw`(?<![A-Za-z0-9._/\\{}<>$-])((?:${ANCHOR})${SEP}|${REL}|(?:${PLUGIN_DIRS})${SEP})([A-Za-z0-9._/\\-]*\.(?:${EXEC_EXT})(?![A-Za-z0-9]))`, 'g')],
];

// DENY BY DEFAULT.
//
// Enumerating which instruction syntaxes to recognise is the losing half of the
// problem: execution paths, parent-relative reads, traversal, bare basenames and
// JSON attachments each escaped a form list in turn. So the question is not "is
// this a known instruction syntax?" but "does this token name a file inside the
// plugin?". Anything that does must be anchored, whatever the verb, extension or
// sentence around it.
// `docs/` is skipped deliberately, not for speed: it is absent from package.json
// `files`, so it never reaches a user's machine and a mention of it is a
// maintainer instruction executed with the repo as cwd, where the relative path
// is correct and an anchor would be wrong.
//
// `tests/` is NOT skipped, because this package ships it — `files` lists
// `"tests/"`, and `npm pack` puts every one of these files on the user's disk
// next to the skills. A document that names a test file is therefore naming a
// path that exists inside an installed plugin, and an unanchored one resolves
// against the target workspace like any other.
// `toKey` is injectable so the Windows separator behaviour can be emulated on a
// POSIX runner: `path.relative` returns backslash-joined keys there. The
// emulation test patches only this side, which is exactly the asymmetry that
// makes a one-sided normalisation look correct locally and fail on Windows.
function buildPluginFiles({ toKey = (p) => path.relative(ROOT, p) } = {}) {
  const rel = new Set();
  const skip = new Set(['node_modules', '.git', '.claude', '.deep-evolve', '.deep-review',
    '.deep-docs', '.serena', '.v3-venv', '.pytest_cache', '.github', 'docs']);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else rel.add(normalizeSeparators(toKey(p)));
    }
  };
  walk(ROOT);
  return rel;
}
const PLUGIN_FILES = buildPluginFiles();

// A token whose first segment is a plugin directory is a plugin path even when
// it does not resolve — `protocols/init.md` read from the entry skill is both
// broken and shadowable, and resolution alone cannot see it. There is no
// descriptive use for the directory prefix: naming it is only useful for opening
// the file.
const PLUGIN_DIR_PREFIX = new RegExp(`^(?:${PLUGIN_DIRS})/`);

// The only permitted exceptions, each with the reason it is safe.
const ALLOWLIST = new Map();

// Single-segment root metadata named descriptively ("package.json declares
// engines"), never handed to a file tool. Multi-segment paths get no such pass.
const ROOT_METADATA = new Set(['package.json', 'plugin.json', 'AGENTS.md', 'CLAUDE.md',
  'README.md', 'README.ko.md', 'CHANGELOG.md', 'CHANGELOG.ko.md', 'CONTRIBUTING.md',
  'SECURITY.md', 'SKILL.md', 'hooks.json', 'hooks.claude.json', 'pyproject.toml']);

// Path-shaped tokens: multi-segment paths, plus dotted single segments. Either
// separator is a separator — see normalizeSeparators for why this is recognised
// here rather than taught to each rule downstream.
// The `+` on the separator class is load-bearing. Without it a separator run
// breaks the segment repetition, the whole-path alternative fails, and the
// tokeniser falls back to the bare-basename alternative — which resolves to
// nothing, so deny-by-default and the malicious-workspace fixture both go
// silent. FORMS kept firing throughout, because its PATH_BODY is a flat class
// that spans a run, and that split is what made the hole look closed.
const PATH_TOKEN = /[A-Za-z0-9_.@${}<>-]+(?:[\\/]+[A-Za-z0-9_.@{}|*-]+)+|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,6}\b/g;

// Both sides of every comparison go through normalizeSeparators: the token here,
// the key set in buildPluginFiles.
// `rel` is injectable alongside `files` because the `fromSource` normalisation is
// otherwise unpinnable: on POSIX `path.relative` already returns slashes, so
// removing the normalisation is a no-op and no mutation can see it. Only a win32
// `relative` exercises it, and it must be injected into the production call site —
// a copy of the logic in a test pins the test's arithmetic, not the guard's.
function resolvesInPlugin(token, sourceFile, files = PLUGIN_FILES, rel = path.relative) {
  const clean = normalizeSeparators(token).replace(/^\.\//, '');
  if (files.has(clean)) return true;
  try {
    const fromSource = normalizeSeparators(
      rel(ROOT, path.resolve(path.dirname(sourceFile), clean)));
    if (files.has(fromSource)) return true;
  } catch { /* unresolvable token — prose */ }
  return false;
}

// Scope, defined once. Yields the path tokens on a line that the invariant
// governs, with the documented exemptions applied. Both the classifier and the
// malicious-workspace fixture consume this, so they cannot test different rules.
function* scopedTokens(line) {
  PATH_TOKEN.lastIndex = 0;
  let m;
  while ((m = PATH_TOKEN.exec(line))) {
    // `<` sits in PATH_TOKEN's character class only so that an angle-bracketed
    // mention still yields the path inside it. Without trimming the bracket,
    // `<skills/…/x.json 첨부>` extracts with a leading `<`, resolves to nothing,
    // and the token escapes the guard silently — which is how this class of
    // finding stayed invisible in deep-work for a full review round.
    // THE normalisation point. Everything downstream compares slash-shaped
    // tokens, so no other rule needs to know that `\` exists.
    const raw = m[0].startsWith('<') ? m[0].slice(1) : m[0];
    const token = normalizeSeparators(raw);
    if (ALLOWLIST.has(token)) continue;
    if (!token.includes('/') && ROOT_METADATA.has(token)) continue;
    const before = line.slice(Math.max(0, m.index - 30), m.index);
    // Already inside an anchored path. The trailing form covers shell splicing
    // — node "'"${CLAUDE_PLUGIN_ROOT}"'/hooks/x.cjs" is anchored, just quoted.
    if (/\$\{CLAUDE_PLUGIN_ROOT\}["'\s]*[\\/]?$/.test(before)) continue;
    // Markdown link target `](x.md)` — rendered navigation between docs, not an
    // instruction handed to a file tool. Runtime reads use the Read forms above.
    if (/\]\($/.test(before)) continue;
    yield token;
  }
}

// `pluginRequire("runtime/x.cjs")` is anchored *programmatically*: the helper
// resolves against a realpath'd process.env.CLAUDE_PLUGIN_ROOT and throws if the
// result leaves the root, which is stronger than a text anchor because it cannot
// be defeated by a quoting context. It is only accepted where the file actually
// defines that helper with its containment check — otherwise the name would
// become a magic word that turns the guard off.
const PLUGIN_REQUIRE_CALL = /\bpluginRequire\s*\(\s*["'`]([^"'`]+)["'`]/g;
function definesPluginRequire(body) {
  return /const\s+pluginRequire\s*=/.test(body)
    && /realpathSync\s*\(\s*process\.env\.CLAUDE_PLUGIN_ROOT/.test(body)
    && /escapes root/.test(body);
}

function denyByDefaultHits(line, sourceFile, body) {
  const programmatic = new Set();
  if (body && definesPluginRequire(body)) {
    PLUGIN_REQUIRE_CALL.lastIndex = 0;
    let pm;
    while ((pm = PLUGIN_REQUIRE_CALL.exec(line))) programmatic.add(pm[1]);
  }
  const out = [];
  for (const token of scopedTokens(line)) {
    if (programmatic.has(token)) continue;             // anchored by the helper
    if (ANCHORED_TOKEN.test(token)) {
      // Clause B for every anchored token, not only the ones a FORM happens to
      // match. Containment used to run inside the five FORMS, so an anchored
      // path that escaped the root while wearing no recognised verb — a bare
      // `${CLAUDE_PLUGIN_ROOT}/../evil.json` in prose — was checked by nothing.
      if (escapesRoot(token)) out.push({ form: 'anchored-token', token, why: 'escapes plugin root' });
      else if (escapesViaSymlink(token)) out.push({ form: 'anchored-token', token, why: 'escapes via symlink' });
      continue;
    }
    if (resolvesInPlugin(token, sourceFile)) {
      out.push({ form: 'resolves-in-plugin', token, why: 'unanchored' });
    } else if (PLUGIN_DIR_PREFIX.test(token)) {
      out.push({ form: 'plugin-dir-path', token, why: 'unanchored' });
    }
  }
  return out;
}

// bare basename read: `Read(`runtime-contract.md`)`. It resolves to no
// repo-relative path, so the rule above cannot see it — yet it is the weakest
// form of all, resolving straight against cwd. Only basenames that name a real
// plugin document are flagged, so ordinary prose is untouched.
const BARE_BASENAME = /\b(?:Read|Follow|read|follow)\s*\(?\s*["'`]([A-Za-z0-9][A-Za-z0-9._-]*\.md)(?:#[^`"']*)?["'`]/g;

// The executable twin. A read verb on a `.md` was covered; an interpreter on a
// runnable file was not, and that shape is strictly more dangerous: `node
// prep-scout.js` resolves against cwd — the analysed workspace — and running a
// planted file there is arbitrary code execution with the caller's permissions.
// Membership in the shipped set is still required, so prose that merely names a
// script is untouched; it is the interpreter that makes it an instruction.
const BARE_EXEC_BASENAME =
  /\b(?:node|python3?|deno|bun|bash|sh|zsh)\s+["'`]?([A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|cjs|mjs|py|sh))["'`]?/g;

function bareBasenameHits(line) {
  const out = [];
  BARE_BASENAME.lastIndex = 0;
  let m;
  while ((m = BARE_BASENAME.exec(line))) {
    if (PLUGIN_DOCS.has(m[1])) {
      out.push({ form: 'bare-basename', token: m[1], why: 'unanchored' });
    }
  }
  const shippedBasenames = new Set([...PLUGIN_FILES].map((f) => f.split('/').pop()));
  BARE_EXEC_BASENAME.lastIndex = 0;
  let em;
  while ((em = BARE_EXEC_BASENAME.exec(line))) {
    if (shippedBasenames.has(em[1])) {
      out.push({ form: 'bare-exec-basename', token: em[1], why: 'unanchored' });
    }
  }
  return out;
}

// EXPANSION SAFETY.
//
// An anchor is only an anchor if something actually expands it. Inside a
// single-quoted string `${CLAUDE_PLUGIN_ROOT}` survives as a literal, and the
// consumer then reads a path *named* `${CLAUDE_PLUGIN_ROOT}/...` relative to the
// workspace — so anchoring a path into a single-quoted payload converts a fixed
// reference into a shadowable one.
//
// Quote state must be tracked as a small machine, not by counting quotes: in
// `node -e "…require('fs')…"` the single quotes are JS-level, sit inside a
// double-quoted shell word, and expansion still happens.
function expansionState(line, index) {
  let state = 'normal';
  for (let k = 0; k < index; k += 1) {
    const c = line[k];
    // POSIX sh does not treat a backslash as an escape inside single quotes:
    // `'C:\\tmp\\'` is the literal `C:\\tmp\\` and the quote closes. Honouring it
    // there flips the parity, so a Windows path ending in a backslash before an
    // anchor reported `normal` and the non-expanding anchor went unflagged.
    //
    // Consume the escaped character rather than looking back at the previous one.
    // Looking back also fails on `"C:\\tmp\\\\"`: the second backslash of the pair
    // is itself treated as escaped, so the closing quote looks escaped too and
    // the double-quote state never ends — a following single-quoted anchor never
    // reaches `single`. Both spellings are forms this branch legitimised.
    if (state !== 'single' && c === '\\') { k += 1; continue; }
    if (state === 'normal') {
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
    } else if (state === 'single') {
      if (c === "'") state = 'normal';
    } else if (c === '"') state = 'normal';
  }
  return state;
}

// Only a line that is actually a command can suffer this; prose containing an
// apostrophe is not a shell word. This name list is a *fallback* for a bare
// command line — it is not the primary test, because enumerating commands is the
// same losing game as enumerating instruction syntaxes: `cp`, `mv`, `install`,
// `rsync` and any project wrapper all quote paths and none of them are here.
const SHELL_COMMAND = /\b(?:echo|printf|cat|node|bash|sh|zsh|jq|awk|sed|curl|export)\b/;

// The primary test instead. In these documents a command is written inside an
// inline-code span; prose is written outside one. So a `${CLAUDE_PLUGIN_ROOT}`
// that sits inside backticks is in a command context whatever the verb, and an
// apostrophe in "the plugin's root" is outside one and cannot open a quote.
// Yields [start, end) offsets of each inline-code span on the line.
function inlineCodeSpans(line) {
  const spans = [];
  const re = /(`+)([^`]|[^`][\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(line))) spans.push([m.index + m[1].length, m.index + m[0].length - m[1].length]);
  return spans;
}

// An inline span was only half the structure. Commands are mostly written in
// FENCED blocks, and a line inside one carries no backticks of its own — so the
// span test finds nothing there and the code fell back to the verb list it was
// meant to replace. Measured before fixing: a fenced
// `cp '${CLAUDE_PLUGIN_ROOT}/<a shipped script>' /tmp/staged.js` was flagged by
// no layer at all, here and in two sibling repos.
//
// There is deliberately NO list of languages exempted by info string. A first
// version had one, and it was the same defect one level down: exempting `python`,
// `js`, `diff` or `markdown` asserts "an anchor is safe here", and in every one of
// those an anchor inside single quotes is exactly as literal — and as
// workspace-relative — as it is in shell. What decides is not the language but
// whether anything expands the anchor, and `expansionState` already answers that:
// shell double quotes expand, everything else leaves it literal. Removing the list
// produced zero new violations across the shipped documents of three repos.

function fenceBlocks(body) {
  const id = [];
  let open = null;
  let n = 0;
  body.split('\n').forEach((line) => {
    const m = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (m) {
      const ch = m[1][0];
      const len = m[1].length;
      // CommonMark closes a fence only on the SAME marker character, at least as
      // long as the one that opened it. Toggling on anything fence-shaped inverts
      // the state for the whole rest of the document — and wrapping a ```bash
      // example inside a ````markdown block is the standard way to document
      // fenced blocks, which these repos do.
      if (open === null) { open = { ch, len }; n += 1; } else if (ch === open.ch && len >= open.len) open = null;
      id.push(null);                       // the marker line is not content
      return;
    }
    id.push(open === null ? null : n);
  });
  return id;
}

function fencedCommandLines(body) {
  const id = fenceBlocks(body);
  const inside = new Set();
  id.forEach((block, i) => { if (block !== null) inside.add(i); });
  return inside;
}

// The clause comment has promised "single quotes and quoted heredocs" since it was
// written, but only the first half was ever implemented. A quoted delimiter makes
// the whole body literal, and each body line carries no quotes of its own, so the
// quote-state reading returns `normal` and the anchor went unflagged. Checked
// against a real shell:
//
//   cat <<'EOF' … ${ANCHOR}/x.js … EOF     literal   → flag
//   cat <<"EOF" … ${ANCHOR}/x.js … EOF     literal   → flag
//   cat <<\EOF  … ${ANCHOR}/x.js … EOF     literal   → flag
//   cat <<-'EOF' … ${ANCHOR}/x.js … EOF    literal   → flag
//   cat <<EOF   … ${ANCHOR}/x.js … EOF     EXPANDS   → clean
//
// An opener whose delimiter never appears again is not a heredoc — that is not
// valid shell — so it is ignored rather than swallowing the rest of the document.
// Without that, a stray `a << b` in prose would flag everything below it.
const HEREDOC_OPEN = /<<-?[ \t]*(?:'([^']+)'|"([^"]+)"|\\([A-Za-z_]\w*)|([A-Za-z_]\w*))(?!<)/;

function quotedHeredocLines(body) {
  const literal = new Set();
  const lines = body.split('\n');
  const block = fenceBlocks(body);
  for (let i = 0; i < lines.length; i += 1) {
    if (block[i] === null) continue;              // a heredoc outside a fenced block
    const m = HEREDOC_OPEN.exec(lines[i]);        // is prose describing one
    if (!m) continue;
    const delim = m[1] || m[2] || m[3] || m[4];
    const quoted = Boolean(m[1] || m[2] || m[3]);
    const dashed = /<<-/.test(lines[i]);
    const indent = /^[ \t]*/.exec(lines[i])[0];
    let end = -1;
    for (let j = i + 1; j < lines.length && block[j] === block[i]; j += 1) {
      // The terminator must sit at the opener's own indentation. Bash closes only
      // at column 0 and `<<-` strips leading TABS alone, so accepting any
      // indentation ends the body early and leaves everything after it unmarked —
      // fail-open. Matching the opener is what a dedented run does, which is how
      // these documents present commands: deep-work's real heredoc sits three
      // spaces deep inside a numbered list, opener and terminator alike.
      const line = dashed ? lines[j].replace(/^\t+/, indent) : lines[j];
      if (line === `${indent}${delim}`) { end = j; break; }
    }
    if (end === -1) continue;                     // never terminated → not a heredoc
    if (quoted) for (let j = i + 1; j < end; j += 1) literal.add(j);
    i = end;
  }
  return literal;
}

// `${...}` only interpolates in a JS *template literal*. In a quoted string it
// is inert, and a specifier that does not start with ./ ../ or / is a bare
// package specifier — so `require("${CLAUDE_PLUGIN_ROOT}/hooks/x.cjs")` sends
// Node looking in `node_modules/${CLAUDE_PLUGIN_ROOT}/hooks/x.cjs` inside the
// *workspace*. Planting that module is arbitrary code execution, which makes
// this the most severe form of the expansion axis rather than a broken path.
// Backticks included deliberately: a template literal interpolates a *local
// variable* of that name, not the environment — an undefined one is a
// ReferenceError, and a defined one is attacker-influenced.
// `from` alone is not enough once backticks are in play: markdown inline code
// makes "the dispatcher from `${CLAUDE_PLUGIN_ROOT}/hooks/…`" look like an
// import, so `from` must be preceded by `import` on the same line.
const JS_SPECIFIER = /(?:\brequire\s*\(|\bimport\s*\(|\bimport\b[^;\n]*?\bfrom\s+)\s*(["'`])((?:(?!\1).)*\$\{[^}]+\}(?:(?!\1).)*)\1/g;

// JSON and YAML have no interpolation at all: a `${...}` in a value is data.
const JSON_YAML_VALUE = /"[A-Za-z_][A-Za-z0-9_]*"\s*:\s*"[^"]*\$\{CLAUDE_PLUGIN_ROOT\}[^"]*"|^\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*["']?[^"'\n]*\$\{CLAUDE_PLUGIN_ROOT\}/;

// The expansion axis, generalised by language. Each context answers one
// question: given where this anchor sits, does anything expand it?
function nonExpandingAnchors(line, inFence = false, inQuotedHeredoc = false) {
  const out = [];
  const flag = (why) => out.push({ form: 'non-expanding-anchor', token: '${CLAUDE_PLUGIN_ROOT}', why });

  // A line whose single quotes never close is not a command at all — bash refuses
  // to parse it — so the shell clause has nothing to say about it. Checked against
  // a real shell before being pinned:
  //
  //   cp '${A}/x.js'                       literal   → flag
  //   a'b ${A}/a'                          literal   → flag
  //   the plugin's root is ${A}/x          SYNTAX ERROR
  //   don't touch the plugin's ${A}/x      expands   → clean
  //
  // This replaced a narrower rule that skipped an apostrophe flanked by word
  // characters. That rule removed the prose false positives but also silenced
  // `a'b ${A}/a'`, which really does open a quote and really does leave the anchor
  // literal — its justification, that a genuine opening quote is never flanked on
  // both sides, was simply false. Asking whether the line parses is both correct
  // and narrower: prose with an odd number of apostrophes is a syntax error, and
  // prose with an even number closes its own quote and expands.
  //
  // Known limit, unchanged from before: a quoted string continued across fenced
  // lines leaves each line individually unterminated, so an anchor on the second
  // line is not flagged. It was not flagged by the previous verb-list gate either.
  const parsesAsCommand = expansionState(line, line.length) !== 'single';
  // 0. quoted heredoc body — the delimiter decides for the whole body, so no
  // per-line quote state applies. This is the half of the clause comment that
  // was documented from the start and never implemented.
  if (inQuotedHeredoc && line.includes('${CLAUDE_PLUGIN_ROOT}')) {
    flag('quoted heredoc body — the delimiter is quoted, so nothing expands');
  }

  // 1. shell — single quotes and quoted heredocs leave it literal.
  // Two ways to qualify as a command context, so no command name list decides
  // it: inside an inline-code span (quote state is judged within that span), or
  // a bare line naming one of the fallback commands.
  const spans = inlineCodeSpans(line);
  let i = line.indexOf('${CLAUDE_PLUGIN_ROOT}');
  while (i !== -1) {
    const span = spans.find(([s, e]) => i >= s && i < e);
    // Three command contexts, and the answer is their disjunction rather than a
    // first-match. A span narrows the view to the backticks, which loses any
    // quote the span sits *inside* — single-quoted on the line, unquoted within
    // the span — and evaluating only the span called that safe. Either reading
    // finding it literal is enough.
    const literalInSpan = !!span
      && expansionState(line.slice(span[0], span[1]), i - span[0]) === 'single';
    const literalOnLine = parsesAsCommand && (inFence || SHELL_COMMAND.test(line))
      && expansionState(line, i) === 'single';
    if (literalInSpan || literalOnLine) {
      flag('single-quoted shell — literal, so the path resolves against the workspace');
    }
    i = line.indexOf('${CLAUDE_PLUGIN_ROOT}', i + 1);
  }

  // 2. JS quoted string used as a module specifier — bare specifier → node_modules
  JS_SPECIFIER.lastIndex = 0;
  let m;
  while ((m = JS_SPECIFIER.exec(line))) {
    if (m[1] === '`') {
      flag('JS template literal — interpolates a local variable of that name, not the '
        + 'environment; undefined is a ReferenceError and a defined one is attacker-influenced');
    } else {
      flag(`JS ${m[1] === '"' ? 'double' : 'single'}-quoted specifier — not interpolated, `
        + 'so Node resolves it as a bare package name under the workspace node_modules');
    }
  }

  // 3. JSON / YAML value — no interpolation in either format. An
  // angle-bracketed value is this repo's convention for "described, not
  // literal" (`<from ${CLAUDE_PLUGIN_ROOT}/…>` documents where a field comes
  // from), so it is a schema annotation rather than a path anyone resolves.
  const angleDescribed = /<[^<>]*\$\{CLAUDE_PLUGIN_ROOT\}[^<>]*>/.test(line);
  if (JSON_YAML_VALUE.test(line) && !SHELL_COMMAND.test(line) && !angleDescribed) {
    flag('JSON/YAML value — neither format interpolates, so the anchor is stored literally');
  }

  return out;
}

const ROOT_SENTINEL = path.sep === '/' ? '/plugin-root' : 'C:\\plugin-root';

// Clause B. Substitute the anchor with a sentinel root, resolve, and require
// the result to stay inside it. Tokens carrying template placeholders cannot be
// resolved literally, so they are checked lexically for `..` instead.
function escapesRoot(token) {
  const body = normalizeSeparators(token).replace(new RegExp(`^(?:${ANCHOR})/`), '');
  if (/[{}|$]/.test(body)) return body.split('/').includes('..');
  const resolved = path.resolve(ROOT_SENTINEL, body);
  return resolved !== ROOT_SENTINEL && !resolved.startsWith(ROOT_SENTINEL + path.sep);
}

// Symlink escape: an anchored, lexically-contained path can still point out of
// the root if a component is a symlink. Only checkable for targets that exist.
// `root` is injectable so this axis can be exercised on its own: the repository
// contains no escaping symlink (correctly), so without a fixture root the
// function is generated and never asserted, which is precisely how it survived
// mutation.
function escapesViaSymlink(token, root = ROOT) {
  const body = normalizeSeparators(token).replace(new RegExp(`^(?:${ANCHOR})/`), '');
  if (/[{}|$]/.test(body)) return false;
  const target = path.join(root, body);
  if (!fs.existsSync(target)) return false;
  const real = fs.realpathSync(target);
  const realRoot = fs.realpathSync(root);
  return real !== realRoot && !real.startsWith(realRoot + path.sep);
}

// Indented too: fences nested in a list item or a numbered step are still fences.
const FENCE = /^[ \t]*```/gm;

test('every skill and agent markdown file has balanced code fences', () => {
  const unbalanced = [];
  for (const file of markdownFiles()) {
    const fences = (fs.readFileSync(file, 'utf8').match(FENCE) || []).length;
    if (fences % 2 !== 0) unbalanced.push(`${path.relative(ROOT, file)} (${fences})`);
  }
  assert.deepEqual(unbalanced, [],
    `unclosed code fence — a split or edit truncated a fenced block:\n  ${unbalanced.join('\n  ')}`);
});

// Returns violations on a line: {form, token, why}. Empty when the line is clean.
function shadowableTokens(line, sourceFile = path.join(ROOT, 'AGENTS.md'), body = '', inFence = false, inQuotedHeredoc = false) {
  const out = [];
  const programmaticAll = new Set();
  if (body && definesPluginRequire(body)) {
    PLUGIN_REQUIRE_CALL.lastIndex = 0;
    let pm;
    while ((pm = PLUGIN_REQUIRE_CALL.exec(line))) programmaticAll.add(pm[1]);
  }
  for (const [form, re] of FORMS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      // Same normalisation point as scopedTokens — FORMS now recognise either
      // separator, so the captured token is normalised before any comparison.
      const token = normalizeSeparators(m[2] === undefined ? m[1] : m[1] + m[2]);
      if (programmaticAll.has(token)) continue;
      if (!ANCHORED_TOKEN.test(token)) out.push({ form, token, why: 'unanchored' });
      else if (escapesRoot(token)) out.push({ form, token, why: 'escapes plugin root' });
      else if (escapesViaSymlink(token)) out.push({ form, token, why: 'escapes via symlink' });
    }
  }
  out.push(...bareBasenameHits(line));
  out.push(...denyByDefaultHits(line, sourceFile, body));
  out.push(...nonExpandingAnchors(line, inFence, inQuotedHeredoc));
  // One token can match several forms; report each token once per line so the
  // failure message names distinct defects rather than repeating one.
  const seen = new Set();
  return out.filter((v) => {
    const key = `${v.token}|${v.why}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

test('the always-loaded agent guides are in the scan set', () => {
  // Asserting membership means the coverage claim is checked by the suite
  // rather than by a commit message.
  // Root-level entries in ALWAYS_LOADED have no separator, so a Windows
  // emulation over them alone cannot fail — it would be a decorative
  // assertion. The derivation is pinned against a real nested document
  // instead, which is where the spelling actually diverges. `relative` is a
  // seam, not a switch: it defaults to the host's and turns nothing off.
  const scanKeys = (rel = path.relative) =>
    markdownFiles().map((f) => normalizeSeparators(rel(ROOT, f)));
  const scanned = scanKeys();
  for (const doc of ALWAYS_LOADED) {
    assert.ok(fs.existsSync(path.join(ROOT, doc)), `${doc} must exist to be scanned`);
    assert.ok(scanned.includes(doc), `${doc} must be in the shadow-guard scan set`);
  }
  const nested = scanned.find((k) => k.includes('/'));
  assert.ok(nested,
    'the scan set must hold a nested document, or the next assertion proves nothing');
  assert.ok(scanKeys(path.win32.relative).includes(nested),
    `the Windows spelling of ${nested} must be the same key as the host's — `
    + 'otherwise every membership check against a slash literal misses there');
});

test('no read or exec instruction can be shadowed from the target workspace', () => {
  const violations = [];
  for (const file of markdownFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    const fenced = fencedCommandLines(body);
    const heredoc = quotedHeredocLines(body);
    body.split('\n').forEach((line, i) => {
      for (const v of shadowableTokens(line, file, body, fenced.has(i), heredoc.has(i))) {
        violations.push(`${path.relative(ROOT, file)}:${i + 1}  [${v.form}] ${v.token} — ${v.why}`);
      }
    });
  }
  assert.deepEqual(violations, [],
    'plugin path read/executed outside the plugin root — anchor at '
    + `\${CLAUDE_PLUGIN_ROOT} and keep it inside the root:\n  ${violations.join('\n  ')}`);
});

// One positive and one negative per instruction form, so the coverage claim is
// itself tested. A form with no case here is a form the guard does not enforce.
const FORM_CASES = [
  ['interpreter-exec', 'node hooks/scripts/deep-evolve-runtime.cjs --request req.json',
    'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/deep-evolve-runtime.cjs" --request req.json'],
  ['read-verb', 'Read `skills/deep-evolve-workflow/protocols/runtime-contract.md` first',
    'Read `${CLAUDE_PLUGIN_ROOT}/skills/deep-evolve-workflow/protocols/runtime-contract.md` first'],
  ['direct-exec', 'source hooks/scripts/runtime/runtime-paths.cjs',
    'source ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/runtime/runtime-paths.cjs'],
  // The "safe" side is NOT require("${CLAUDE_PLUGIN_ROOT}/…") — that is the
  // node_modules hijack below, since JS does not interpolate a quoted string.
  ['module-load', 'const x = require("hooks/scripts/runtime/session-store.cjs");',
    'const x = pluginRequire("hooks/scripts/runtime/session-store.cjs");'],
  ['executable-token', 'the dispatcher is `hooks/scripts/deep-evolve-runtime.cjs`',
    'the dispatcher is `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/deep-evolve-runtime.cjs`'],
  ['bare-basename', 'Read(`runtime-contract.md`)',
    'Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-evolve-workflow/protocols/runtime-contract.md`)'],
  ['dot-relative', 'Read(`../protocols/inner-loop.md`)',
    'Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-evolve-workflow/protocols/inner-loop.md`)'],
  // The plugin-dir form: a protocol named from a directory prefix that does not
  // resolve anywhere in the plugin is still a plugin path, and still shadowable.
  ['plugin-dir-path', 'route to `protocols/transfer.md` for soft pruning',
    'route to `${CLAUDE_PLUGIN_ROOT}/skills/deep-evolve-workflow/protocols/transfer.md` for soft pruning'],
  // Deny-by-default on files that are neither documents nor executables. No read
  // verb names them and no runnable extension marks them, so every syntax-based
  // form list misses them — they are caught only because they resolve.
  ['resolves-in-plugin (manifest)', 'the Claude manifest is `.claude-plugin/plugin.json`',
    'the Claude manifest is `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`'],
  ['resolves-in-plugin (packaged test)', 'run `tests/plugin-contract.test.js`',
    'run `${CLAUDE_PLUGIN_ROOT}/tests/plugin-contract.test.js`'],
];

// A body that defines the helper with its containment check. pluginRequire is
// only trusted where this definition is present — the name alone must not
// disable the guard, so the negative side is asserted without it.
const HELPER_BODY = [
  'const PLUGIN_ROOT = nodeFs.realpathSync(process.env.CLAUDE_PLUGIN_ROOT || "");',
  'const pluginRequire = (rel) => { throw new Error("plugin path escapes root: " + rel); };',
].join(String.fromCharCode(10));

test('every enumerated instruction form is enforced (positive + negative)', () => {
  for (const [form, bad, good] of FORM_CASES) {
    assert.ok(shadowableTokens(bad, undefined, HELPER_BODY).length > 0,
      `${form}: guard must flag — ${bad}`);
    assert.deepEqual(shadowableTokens(good, undefined, HELPER_BODY), [],
      `${form}: guard must accept — ${good}`);
  }
});

test('pluginRequire is not a magic word — it only counts where the helper is defined', () => {
  const call = 'const x = pluginRequire("hooks/scripts/runtime/session-store.cjs");';
  assert.deepEqual(shadowableTokens(call, undefined, HELPER_BODY), [],
    'accepted when the containment helper is defined in the same document');
  assert.ok(shadowableTokens(call, undefined, '// no helper here').length > 0,
    'rejected when the document never defines the helper');
});

test('anchored paths that escape the plugin root are rejected (containment)', () => {
  // Clause B. Each carries a valid anchor prefix and still leaves the root, so
  // a prefix-only check passes all three.
  const traversals = [
    'Read `${CLAUDE_PLUGIN_ROOT}/../workspace/evil.md`',
    'node "${CLAUDE_PLUGIN_ROOT}/../workspace/evil.cjs"',
    'node ${CLAUDE_PLUGIN_ROOT}/../../tmp/evil.cjs',
  ];
  for (const line of traversals) {
    const hits = shadowableTokens(line);
    assert.ok(hits.length > 0, `containment must reject: ${line}`);
    assert.equal(hits[0].why, 'escapes plugin root', `wrong reason for: ${line}`);
  }
  // A `..` that stays inside the root is fine.
  assert.deepEqual(
    shadowableTokens('Read `${CLAUDE_PLUGIN_ROOT}/skills/a/../deep-evolve/SKILL.md`'), [],
    'in-root traversal must be accepted');
});

test('a malicious workspace cannot shadow any instruction the plugin issues', () => {
  // End-to-end statement of the invariant. Plant shadows in a fake target
  // workspace for every plugin document an instruction names, then confirm that
  // no instruction in the repo would resolve to one of them. Because every
  // instruction is anchored, cwd is irrelevant — which is the property under
  // test, not an accident of this fixture.
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'de-evil-workspace-'));
  try {
    for (const name of ['runtime-contract.md', 'evolve-seed.md', 'SKILL.md']) {
      fs.writeFileSync(path.join(evil, name), '# SHADOW — must never be read\n');
    }
    fs.mkdirSync(path.join(evil, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(evil, 'agents', 'evolve-coordinator.md'),
      '# SHADOW policy — must never be read\n');
    fs.writeFileSync(path.join(evil, 'agents', 'evolve-seed.md'),
      '# SHADOW policy — must never be read\n');
    fs.mkdirSync(path.join(evil, 'hooks', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(evil, 'hooks', 'scripts', 'deep-evolve-runtime.cjs'),
      'process.stdout.write("SHADOW");\n');
    fs.mkdirSync(path.join(evil, 'protocols'), { recursive: true });
    for (const name of ['init.md', 'transfer.md', 'history.md']) {
      fs.writeFileSync(path.join(evil, 'protocols', name), '# SHADOW — must never be read\n');
    }
    // Neither a document nor an executable. This class is why the rule is
    // resolution rather than syntax: a manifest or an attached schema is named
    // by no read verb and carries no runnable extension, so every form list
    // written before it missed it. `tests/` is planted for the same reason —
    // this package ships it, so those paths exist inside an installed plugin.
    fs.mkdirSync(path.join(evil, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(evil, '.claude-plugin', 'plugin.json'),
      '{"name":"SHADOW","version":"0.0.0"}\n');
    fs.mkdirSync(path.join(evil, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(evil, 'hooks', 'hooks.json'), '{"hooks":"SHADOW"}\n');
    fs.mkdirSync(path.join(evil, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(evil, 'tests', 'plugin-contract.test.js'),
      'throw new Error("SHADOW");\n');

    // Derived, not enumerated. A hand-written plant list only covers the paths
    // someone remembered. Planting every shipped
    // file at its repo-relative path makes the coverage follow the tree instead
    // of the memory. Basenames are deliberately NOT planted here: a document that
    // merely mentions `harvest.js` in prose would then "land", and the fixture
    // would report writing about a file as if it were an instruction to run one.
    // The bare-basename shape is caught by its own rule instead.
    for (const rel of PLUGIN_FILES) {
      const dest = path.join(evil, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, '// SHADOW — must never be read\n');
    }

    // Resolve for real, from the evil cwd, exactly as a runtime agent would.
    // Re-running the classifier here would only restate what it already
    // believes; this instead performs the resolution and asks which file the
    // instruction actually lands on.
    const resolveAsAgentWould = (token) => {
      if (/^\$\{CLAUDE_PLUGIN_ROOT\}\//.test(token)) {
        const body = token.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, '');
        return path.resolve(ROOT, body);      // anchored → resolves in the plugin
      }
      return path.resolve(evil, token.replace(/^\.\//, '')); // unanchored → cwd
    };

    const landed = [];
    for (const file of markdownFiles()) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const token of scopedTokens(line)) {
          const target = resolveAsAgentWould(token);
          if (target.startsWith(evil + path.sep) && fs.existsSync(target)) {
            landed.push(`${path.relative(ROOT, file)}:${i + 1}  ${token} → ${target}`);
          }
        }
      });
    }
    assert.deepEqual(landed, [],
      `these instructions resolve onto a planted shadow file:\n  ${landed.join('\n  ')}`);

    // Non-vacuity, per planted class: the same resolution, given an unanchored
    // token, does land on the shadow — so an empty result above is a property of
    // the docs, not of a resolver that never finds anything. Every class the
    // fixture plants is probed, otherwise a plant could rot into decoration
    // without any test noticing.
    for (const probe of ['agents/evolve-seed.md', 'protocols/init.md',
      '.claude-plugin/plugin.json', 'hooks/hooks.json', 'tests/plugin-contract.test.js']) {
      const control = resolveAsAgentWould(probe);
      assert.ok(control.startsWith(evil + path.sep) && fs.existsSync(control),
        `fixture is vacuous for ${probe} — an unanchored token must land on the planted shadow`);
    }
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
  }
});

test('a quoted heredoc body is literal, an unquoted one expands', () => {
  // The clause comment promised "single quotes and quoted heredocs" from the
  // start; only the first half was implemented. A quoted delimiter makes the whole
  // body literal, and a body line carries no quotes of its own, so the quote-state
  // reading returned `normal` and the anchor went unflagged. Every row was checked
  // against a real shell before being pinned.
  const ANCHOR = '${CLAUDE_PLUGIN_ROOT}';
  const payload = `${ANCHOR}/scripts/x.js`;
  const fenced = (...lines) => ['```bash', ...lines, '```'].join('\n');

  for (const [open, literal] of [
    [`cat <<'EOF' > /tmp/x`, true],
    [`cat <<"EOF" > /tmp/x`, true],
    [`cat <<\\EOF > /tmp/x`, true],
    [`cat <<-'EOF' > /tmp/x`, true],
    [`cat <<EOF > /tmp/x`, false],          // unquoted delimiter → bash expands it
  ]) {
    const heredoc = quotedHeredocLines(fenced(open, payload, 'EOF'));
    assert.equal(heredoc.has(2), literal,
      `${open} — body ${literal ? 'is literal' : 'expands'}`);
    assert.equal(nonExpandingAnchors(payload, false, heredoc.has(2)).length > 0, literal,
      `${open} — anchor must ${literal ? 'flag' : 'stay clean'}`);
  }

  // The terminator must sit at the OPENER's indentation. Bash closes only at
  // column 0, so accepting any indentation ends the body early and leaves the
  // lines after it unmarked — fail-open. Matching the opener is what a dedented
  // run does, which is how these documents present commands: this repo's real
  // heredoc sits three spaces deep inside a numbered list, opener and terminator
  // alike, and must still close.
  const listed = quotedHeredocLines(fenced(`   cat <<'EOF'`, `   ${payload}`, '   EOF', '   after'));
  assert.ok(listed.has(2) && !listed.has(4),
    'a heredoc indented as a list item closes at its own indentation');
  const mismatched = quotedHeredocLines(
    fenced(`cat <<'EOF'`, 'BODY-ONE', '   EOF', payload, 'EOF'));
  assert.ok(mismatched.has(4),
    'an indented terminator does not close a column-0 heredoc — bash agrees, and '
    + 'ending the body there would leave this anchor unmarked');

  // Opener and terminator must be in the SAME fenced block. Without that a stray
  // delimiter anywhere later in the document pairs with the opener and marks all
  // the prose between them as a literal body.
  const split = ['```bash', `cat <<'EOF'`, '```', `prose ${payload}`, '```text', 'EOF', '```'];
  assert.equal(quotedHeredocLines(split.join('\n')).size, 0,
    'an opener cannot pair with a delimiter in a different fenced block');
  assert.equal(quotedHeredocLines([`cat <<'EOF'`, payload, 'EOF'].join('\n')).size, 0,
    'a heredoc written outside any fenced block is prose describing one');

  // An opener whose delimiter never reappears is not a heredoc — that is not valid
  // shell. Without this, a stray opener in prose swallows every line below it. The
  // probe must use a QUOTED opener: with an unquoted one the `quoted` guard
  // suppresses the lines anyway, so the case would pass whether or not the
  // termination check exists.
  const stray = fenced(`documented as a heredoc: cat <<'EOF' writes a literal body`,
    payload, 'more prose');
  assert.equal(quotedHeredocLines(stray).size, 0,
    'an unterminated quoted opener must claim no lines');

  // And the terminator ends it: a line after the delimiter is outside the body.
  const closed = quotedHeredocLines(fenced(`cat <<'EOF'`, payload, 'EOF', payload));
  assert.ok(closed.has(2) && !closed.has(4), 'the delimiter line closes the body');
});

test('a fenced code block is a command context, whatever the verb', () => {
  // The gap this pins was live in three repos at once and invisible to every
  // layer: `inlineCodeSpans` finds only INLINE spans, a line inside a ```bash
  // block has no backticks of its own, and the fallback was the very verb list
  // the span rule was introduced to replace. Commands are mostly written in
  // fenced blocks, so that fallback covered the minority case.
  const ANCHOR = '${CLAUDE_PLUGIN_ROOT}';
  const cmd = `cp '${ANCHOR}/x.js' /tmp/staged.js`;   // no backticks, unlisted verb

  assert.equal(nonExpandingAnchors(cmd, false).length, 0,
    'outside a fence this line is prose to the verb list — that is the gap, stated');
  assert.ok(nonExpandingAnchors(cmd, true).length > 0,
    'inside a fence the same line is a command and the anchor is literal');

  // Double quotes DO expand, so the same line must stay clean inside a fence —
  // otherwise this rule would flag every correct command in the documentation.
  assert.equal(nonExpandingAnchors(`cp "${ANCHOR}/x.js" /tmp/staged.js`, true).length, 0,
    'a double-quoted anchor expands; a fence must not turn that into a violation');

  // Prose inside a fence must stay clean, and a real quoted command inside one must
  // not. Both halves are decided by whether the LINE PARSES: bash refuses a line
  // whose single quotes never close, so it can never be an instruction that runs.
  // Every row was checked against a real shell before being pinned here.
  //
  //   cp '${A}/x.js' /tmp/y              literal        → flag
  //   cp "${A}/x.js" /tmp/y              expands        → clean
  //   echo a'b ${A}/a'                   literal        → flag
  //   # the plugin's root is ${A}/x      SYNTAX ERROR   → clean
  //   # don't touch the plugin's ${A}/x  expands        → clean
  //   don't a it's b plugin's ${A}/x     SYNTAX ERROR   → clean
  //
  // Row 3 is why this is not the narrower rule it replaced. Skipping an apostrophe
  // flanked by word characters removed the prose false positives, but it also
  // silenced `a'b …/a'` — which genuinely opens a quote and genuinely leaves the
  // anchor literal. The claim that a real opening quote is never flanked on both
  // sides is false, and bash says so directly.
  for (const [line, mustFlag] of [
    [`cp '${ANCHOR}/x.js' /tmp/y`, true],
    [`cp "${ANCHOR}/x.js" /tmp/y`, false],
    [`echo a'b ${ANCHOR}/a'`, true],
    [`# the plugin's root is ${ANCHOR}/x`, false],
    [`# don't touch the plugin's ${ANCHOR}/x`, false],
    [`don't a it's b plugin's ${ANCHOR}/x`, false],
  ]) {
    assert.equal(nonExpandingAnchors(line, true).length > 0, mustFlag,
      `${mustFlag ? 'must flag' : 'must stay clean'} inside a fence: ${line}`);
  }

  // No language is exempt by info string, and that is deliberate. An earlier
  // version exempted `python`, `js`, `diff`, `markdown` and more — the same
  // enumeration defect one level down, because a single-quoted anchor is exactly
  // as literal in each of them. What decides is expansion, not language.
  for (const info of ['bash', '', 'python', 'js', 'diff', 'markdown', 'json']) {
    const body = ['prose', '```' + info, cmd, '```'].join('\n');
    assert.ok(fencedCommandLines(body).has(2),
      `a line inside a \`\`\`${info || '(unlabelled)'} block is a command line`);
  }

  // Fence marker parity, per CommonMark: a fence closes only on the SAME marker
  // character, at least as long as the one that opened it. Toggling on anything
  // fence-shaped inverts the state for the entire rest of the document, and
  // wrapping a ```bash example in a ````markdown block is the standard way to
  // document fenced blocks — which these repos do.
  const wrapped = ['````markdown', '```bash', cmd, '```', '````', 'prose'].join('\n');
  assert.ok(fencedCommandLines(wrapped).has(2),
    'a shorter inner fence must not close a longer outer one');
  assert.ok(!fencedCommandLines(wrapped).has(5),
    'and the outer fence must still close, or the rest of the file inverts');

  const tilde = ['```bash', '~~~', cmd, '```', 'prose'].join('\n');
  assert.ok(fencedCommandLines(tilde).has(2),
    'a tilde run must not close a backtick fence');
  assert.ok(!fencedCommandLines(tilde).has(4),
    'the matching backtick fence must still close it');

  // And the ordinary case still works, so the parity rule did not break closing.
  const plain = ['prose', '```bash', cmd, '```', 'prose'].join('\n');
  const f = fencedCommandLines(plain);
  assert.ok(f.has(2) && !f.has(0) && !f.has(4), 'a plain fenced block opens and closes');
  assert.ok(![1, 3].some((n) => f.has(n)), 'the fence markers are not content lines');
});

test('an anchor the shell will not expand counts as unanchored', () => {
  // [line, expected reason] — the reason is asserted per case, because the axis
  // spans languages and "single-quoted" is only the shell answer.
  const mustFlag = [
    [`echo '{"request":"\${CLAUDE_PLUGIN_ROOT}/hooks/scripts/deep-evolve-runtime.cjs"}' | node x.cjs`, /single-quoted shell/],
    [`printf '%s' '\${CLAUDE_PLUGIN_ROOT}/hooks/scripts/runtime/runtime-paths.cjs'`, /single-quoted shell/],
    ['const { m } = require(`${CLAUDE_PLUGIN_ROOT}/hooks/scripts/deep-evolve-runtime.cjs`);', /template literal/],
    ['const x = require("${CLAUDE_PLUGIN_ROOT}/hooks/scripts/runtime/session-store.cjs");', /bare package name/],
    ["import x from '${CLAUDE_PLUGIN_ROOT}/hooks/scripts/runtime/session-store.cjs';", /bare package name/],
    // Both escape spellings, because each defeats a different implementation.
    // Looking back at the previous character reads the first as `normal` (the
    // trailing backslash of `'C:\\tmp\\'` looks like an escape, though POSIX sh
    // does not escape inside single quotes) and the second as `double` (the pair's
    // second backslash makes the closing quote look escaped, so the state never
    // ends). Consuming the escaped character reads both as `single`, which is what
    // bash does — it returns each anchor as its own literal.
    [`node 'C:\\tmp\\' '\${CLAUDE_PLUGIN_ROOT}/hooks/scripts/deep-evolve-runtime.cjs'`, /single-quoted shell/],
    [`node "C:\\tmp\\\\" '\${CLAUDE_PLUGIN_ROOT}/hooks/scripts/deep-evolve-runtime.cjs'`, /single-quoted shell/],
  ];
  for (const [line, reason] of mustFlag) {
    const hits = nonExpandingAnchors(line);
    assert.equal(hits.length, 1, `must flag non-expanding anchor: ${line}`);
    assert.match(hits[0].why, reason, `wrong reason for: ${line}`);
  }

  const mustPass = [
    // double-quoted shell word: the inner single quotes are JS-level, and the
    // shell still expands. A naive quote counter gets this one wrong.
    `node -e "JSON.parse(require('fs').readFileSync('\${CLAUDE_PLUGIN_ROOT}/.codex-plugin/plugin.json','utf8'))"`,
    // close-single / open-double splice inside a single-quoted heredoc body
    `  const { x } = require("'"\${CLAUDE_PLUGIN_ROOT}"'/hooks/scripts/runtime/runtime-paths.cjs");`,
    // plain expanding position
    `node "\${CLAUDE_PLUGIN_ROOT}/hooks/scripts/deep-evolve-runtime.cjs"`,
    // prose, not a command
    'Reads `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` for the version',
  ];
  for (const line of mustPass) {
    assert.deepEqual(nonExpandingAnchors(line), [], `must accept: ${line}`);
  }
});

test('the documented dispatcher invocation survives real shell semantics', () => {
  // Runs the shape the runtime contract documents, from a malicious cwd that has
  // planted a file at the literal path a non-expanding anchor would produce.
  // Proves three things at once: the canonical dispatcher is what gets invoked,
  // the planted marker never reaches the output, and an unresolvable root aborts.
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'de-shell-evil-'));
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'de-shell-plugin-'));
  try {
    // The literal path a single-quoted anchor leaves behind.
    const literalDir = path.join(evil, '${CLAUDE_PLUGIN_ROOT}', 'hooks', 'scripts');
    fs.mkdirSync(literalDir, { recursive: true });
    fs.writeFileSync(path.join(literalDir, 'deep-evolve-runtime.cjs'),
      'process.stdout.write("SHADOW-DISPATCHER");\n');
    fs.mkdirSync(path.join(fakeRoot, 'hooks', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, 'hooks', 'scripts', 'deep-evolve-runtime.cjs'),
      'process.stdout.write("CANONICAL-DISPATCHER");\n');

    const script = `
      PLUGIN_ROOT="$(cd "\${CLAUDE_PLUGIN_ROOT:?unset}" 2>/dev/null && pwd -P)"
      [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/hooks/scripts/deep-evolve-runtime.cjs" ] || { echo "ABORT" >&2; exit 1; }
      node "$PLUGIN_ROOT/hooks/scripts/deep-evolve-runtime.cjs"
    `;
    const run = (env, cwd) => require('node:child_process')
      .spawnSync('bash', ['-c', script], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });

    const ok = run({ CLAUDE_PLUGIN_ROOT: fakeRoot }, evil);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'CANONICAL-DISPATCHER',
      'must invoke the canonical plugin dispatcher, not the planted one');
    assert.doesNotMatch(ok.stdout, /SHADOW-DISPATCHER|\$\{CLAUDE_PLUGIN_ROOT\}/,
      'planted marker and literal anchor must never reach the output');

    // Non-vacuity: the planted shadow is genuinely reachable if the anchor stays
    // literal, which is exactly what a single-quoted form would do.
    const literal = require('node:child_process').spawnSync(process.execPath,
      [path.join(literalDir, 'deep-evolve-runtime.cjs')], { encoding: 'utf8' });
    assert.equal(literal.stdout.trim(), 'SHADOW-DISPATCHER');

    // Fail-closed when the root does not resolve.
    const bad = run({ CLAUDE_PLUGIN_ROOT: path.join(evil, 'does-not-exist') }, evil);
    assert.notEqual(bad.status, 0, 'unresolvable plugin root must abort');
    assert.match(bad.stderr, /ABORT/);
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test('the plugin obeys the rules it states', () => {
  // Self-consistency axis: a rule this repo states, violated inside the very
  // file that states it. Writing a rule is not enforcing it, so the
  // mechanically checkable ones are asserted here.
  const violations = [];
  for (const file of markdownFiles()) {
    const rel = path.relative(ROOT, file);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const at = `${rel}:${i + 1}`;

      // "Paths are literal and authenticated" — a plugin root derived from the
      // document's own location resolves against the workspace once the
      // document is read from there, so it authenticates nothing.
      if (/plugin root[^.\n]*from the (?:loaded|current|this) \w+|directory containing this|이 파일이 있는 (?:디렉터리|디렉토리)/i.test(line)
          && !/말 것|하지 마|never|must not|not inferred|is never/i.test(line)) {
        violations.push(`${at}  source-relative plugin-root derivation`);
      }

      // "Preserve unrelated/user bytes" — a blanket stage contradicts it. The
      // statement itself is allowed, an instruction to do it is not.
      if (/git add (?:-A|\.)/.test(line) && !/Never|절대|금지|하지 ?마|must not/i.test(line)) {
        violations.push(`${at}  instructs a blanket 'git add'`);
      }

      // "Use no shell fence, pipeline, operator, or host-variable expansion" —
      // a documented dispatcher invocation that uses one would contradict the
      // contract it is documenting.
      if (/deep-evolve-runtime\.cjs/.test(line) && /\$\(|&&|\|\||\s\|\s/.test(line)) {
        violations.push(`${at}  shell operator in a documented dispatcher invocation`);
      }
    });
  }
  assert.deepEqual(violations, [],
    `the plugin violates a rule it states:\n  ${violations.join('\n  ')}`);
});

test('a planted node_modules shadow cannot hijack a plugin require', () => {
  // `require("${VAR}/x.cjs")` is a *bare* specifier — not absolute — so Node
  // walks node_modules from cwd. Executed rather than argued.
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'de-nm-evil-'));
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'de-nm-plugin-'));
  const { spawnSync } = require('node:child_process');
  try {
    const shadowDir = path.join(evil, 'node_modules', '${CLAUDE_PLUGIN_ROOT}', 'hooks', 'scripts');
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.writeFileSync(path.join(shadowDir, 'deep-evolve-runtime.cjs'),
      'module.exports = { marker: "ATTACKER" };\n');
    fs.mkdirSync(path.join(realRoot, 'hooks', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(realRoot, 'hooks', 'scripts', 'deep-evolve-runtime.cjs'),
      'module.exports = { marker: "CANONICAL" };\n');

    const run = (src) => spawnSync(process.execPath, ['-e', src],
      { cwd: evil, env: { ...process.env, CLAUDE_PLUGIN_ROOT: realRoot }, encoding: 'utf8' });

    // Non-vacuity: the planted module really is reachable via the broken form.
    const vulnerable = run('console.log(require("${CLAUDE_PLUGIN_ROOT}/hooks/scripts/deep-evolve-runtime.cjs").marker)');
    assert.equal(vulnerable.status, 0, vulnerable.stderr);
    assert.equal(vulnerable.stdout.trim(), 'ATTACKER',
      'fixture is vacuous — the planted shadow must be reachable via the unsafe form');

    // The documented pattern resolves from env, with containment.
    const safe = run(`
      const nodePath = require("node:path"), nodeFs = require("node:fs");
      const PLUGIN_ROOT = nodeFs.realpathSync(process.env.CLAUDE_PLUGIN_ROOT || "");
      const pluginRequire = (rel) => {
        const t = nodePath.resolve(PLUGIN_ROOT, rel);
        if (t !== PLUGIN_ROOT && !t.startsWith(PLUGIN_ROOT + nodePath.sep)) {
          throw new Error("plugin path escapes root: " + rel);
        }
        return require(t);
      };
      console.log(pluginRequire("hooks/scripts/deep-evolve-runtime.cjs").marker);
    `);
    assert.equal(safe.status, 0, safe.stderr);
    assert.equal(safe.stdout.trim(), 'CANONICAL',
      'the documented pattern must load the plugin module, never the planted one');

    // Containment: a traversing relative path is refused, not resolved.
    const escaping = run(`
      const nodePath = require("node:path"), nodeFs = require("node:fs");
      const PLUGIN_ROOT = nodeFs.realpathSync(process.env.CLAUDE_PLUGIN_ROOT || "");
      const pluginRequire = (rel) => {
        const t = nodePath.resolve(PLUGIN_ROOT, rel);
        if (t !== PLUGIN_ROOT && !t.startsWith(PLUGIN_ROOT + nodePath.sep)) {
          throw new Error("plugin path escapes root: " + rel);
        }
        return require(t);
      };
      pluginRequire("../evil.cjs");
    `);
    assert.notEqual(escaping.status, 0, 'an escaping path must throw');
    assert.match(escaping.stderr, /escapes root/);
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
    fs.rmSync(realRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Maintainer-only paths named in shipped documents.
//
// A gitignored directory does not exist in an installed plugin, so a path under
// one can only ever resolve against the ANALYSED PROJECT. Naming it in a shipped
// instruction hands that instruction to the project under analysis — the same
// substitution the anchoring rules exist to prevent, arriving by a route
// deny-by-default cannot see, because the path resolves nowhere in the index.
//
// This repo had no such rule. A cross-repo sweep planted
// `See `docs/UNDECLARED_RULES.md` for the rest.` in four sibling guards: two
// flagged it, this one did not. `docs/` is gitignored here, so the class is real
// and was simply unguarded.
//
// Not every gitignored directory qualifies. `.deep-*` is the suite's naming
// convention for a plugin's workspace output root, and for those, resolving
// against the analysed project is the CONTRACT rather than the defect — including
// a SIBLING's root, since telling an agent to read `.deep-review/…` in the project
// is a correct reference. The split asks that convention instead of guessing, and
// is asserted in both directions below.
const IGNORED_DIRS = (() => {
  const body = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  return body.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!') && line.endsWith('/'))
    .map((line) => line.replace(/\/$/, ''));
})();
// Three arms, each with a stated authority, and no list of variable names.
//
// (1) ASK THE CODE — a directory this plugin WRITES into a project is its own output
//     root. Writing is the discriminator, not joining: deep-work's release gate joins
//     `docs` onto `stateCapability.projectRoot` and only READS it, because `docs/`
//     belongs to whatever project is being analysed. An earlier version of this probe
//     matched any join and classified `docs/` as an output root — the rule silencing
//     the exact class it exists for. A variable-name allowlist was then tried to
//     separate them and is what this replaces: it admitted 0 of 8 call sites in a
//     sibling repo, where the project root is simply called `root`.
// (2) ASK THE CONVENTION — `.deep-*` is the suite's name for a plugin output root.
//     This covers a SIBLING's root, which this plugin never writes but a document may
//     correctly tell an agent to read in the project.
// (3) ASK THE HOST — a tool's per-project directory. `.claude` is Claude Code's,
//     `.vscode` and `.idea` are the editors'. None belongs to any plugin, all live in
//     the analysed project, and a document may correctly name one. This arm IS a small
//     enumeration and saying so is the point: its growth condition is known — a new
//     host or editor project directory — and the alternative, treating anything
//     unproven as a workspace output, is fail-open. `.vscode` and `.idea` were found
//     missing by a cross-repo sweep, flagged in a sibling that gitignores both.
const HOST_PROJECT_DIRS = new Set(['.claude', '.vscode', '.idea']);

function pluginWrittenDirs(dirs) {
  const WRITE = /(mkdirSync|writeFileSync|appendFileSync|createWriteStream|rmSync|cpSync|renameSync)/;
  const found = new Set();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.[cm]?js$/.test(e.name) || /\.test\.[cm]?js$/.test(e.name)) continue;
      const body = fs.readFileSync(p, 'utf8');
      for (const d of dirs) {
        if (found.has(d)) continue;
        const re = new RegExp(`['"\`]${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`, 'g');
        let m;
        while ((m = re.exec(body))) {
          if (WRITE.test(body.slice(Math.max(0, m.index - 260), m.index + 260))) { found.add(d); break; }
        }
      }
    }
  };
  ['runtime', 'scripts', 'hooks', 'lib'].forEach((s) => walk(path.join(ROOT, s)));
  return found;
}

const WORKSPACE_OUTPUT_DIRS = new Set([
  ...pluginWrittenDirs(IGNORED_DIRS),
  ...IGNORED_DIRS.filter((d) => d.startsWith('.deep-')),
  ...IGNORED_DIRS.filter((d) => HOST_PROJECT_DIRS.has(d)),
]);
const MAINTAINER_ONLY_DIRS = IGNORED_DIRS
  .filter((d) => !WORKSPACE_OUTPUT_DIRS.has(d) && d !== 'node_modules');

// Declared exceptions: a maintainer-only path a document may name, and the clauses
// that earn the exception. The declaration is not a waiver — the test below makes
// the naming document carry each clause, so an entry here without the sentence is
// a failure, not a bypass.
const NON_SHIPPED_DECLARED = new Map([
  ['docs/DOCS_RULE.md', [
    /ships with nothing/,
    /never try to open it at runtime/,
    /only place that path can resolve in an installed plugin is the project being analysed/,
  ]],
]);

test('a path the plugin never ships carries the sentence that makes it safe', () => {
  const missing = [];
  for (const [declared, clauses] of NON_SHIPPED_DECLARED) {
    for (const file of markdownFiles()) {
      // Whitespace-normalised, blockquote markers dropped: a caveat's meaning does
      // not depend on where it wraps, and a test that breaks on rewrapping teaches
      // people to rewrap rather than to keep the sentence.
      const body = fs.readFileSync(file, 'utf8')
        .replace(/\n\s*>?\s*/g, ' ')
        .replace(/\s+/g, ' ');
      if (!body.includes(declared)) continue;
      for (const clause of clauses) {
        if (!clause.test(body)) {
          missing.push(`${path.relative(ROOT, file)} names ${declared} but is missing: ${clause.source}`);
        }
      }
    }
  }
  assert.deepEqual(missing, [],
    'a document names a path that ships with nothing, without the caveat that keeps a '
    + `reader from opening it in the analysed project:\n  ${missing.join('\n  ')}`);
});

test('the workspace-output split is derived from the convention, and is two-way', () => {
  assert.ok(IGNORED_DIRS.length > 0, '.gitignore yielded no ignored directories');
  assert.ok(MAINTAINER_ONLY_DIRS.includes('docs'),
    'docs must be swept — it is the class this rule exists for');
  for (const dir of MAINTAINER_ONLY_DIRS) {
    assert.ok(!dir.startsWith('.deep-'), `${dir} is an output root but is swept`);
  }
  assert.ok(WORKSPACE_OUTPUT_DIRS.size > 0,
    'no output root was recognised — then the split is doing nothing and every '
    + 'project-relative reference this plugin makes is about to be flagged');
  // The probe's failure mode, pinned. `docs/` IS joined onto a project root in this
  // family — deep-work's release gate reads `docs/DOCS_RULE.md` from the project it
  // is releasing — so a probe that keys on *joining* classifies it as an output root
  // and silences the rule for the exact class it exists for. Writing is what
  // separates them: nothing in this family ever writes `docs/`.
  assert.ok(!WORKSPACE_OUTPUT_DIRS.has('docs'),
    'docs is read, never written — a probe that classes it as an output root has '
    + 'silenced the rule');
  assert.ok(MAINTAINER_ONLY_DIRS.length < IGNORED_DIRS.length,
    'nothing was split off — the rule is unchanged, which is not what its comment claims');
});

test('no undeclared path under a maintainer-only directory is named', () => {
  // Lexical over raw lines, never consulting the resolver: that is what makes it
  // immune to any index blind spot, and why both separators are spelled out —
  // `normalizePath` never reaches here, so with `/` alone the backslash spelling
  // walks straight past.
  //
  // Negative lookbehind rather than a prefix list. Enumerating the characters that
  // may precede a path makes every character nobody thought of a bypass:
  // `**docs/X.md**` and `[docs/Y.md](…)` are ordinary markdown and slip past a
  // space/backtick/quote/paren list.
  const escaped = MAINTAINER_ONLY_DIRS.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(String.raw`(?<![A-Za-z0-9._\\/-])((?:${escaped})[\\/][A-Za-z0-9._\\/-]+)`, 'g');

  // Both spellings and both prefix shapes, pinned on the axis rather than left to
  // whatever the corpus happens to contain today.
  for (const probe of ['See `docs/backlog.md` for the rest.', 'See `docs\\backlog.md` too.',
    '**docs/bold.md** matters', '[docs/link.md](x) matters']) {
    re.lastIndex = 0;
    assert.ok(re.exec(probe), `the sweep must see: ${probe}`);
  }
  re.lastIndex = 0;
  assert.equal(re.exec('nodocs/notapath.md is mid-token'), null,
    'a match must not start mid-token');

  const violations = [];
  for (const file of markdownFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        if (NON_SHIPPED_DECLARED.has(m[1])) continue;   // earned by the caveat test above
        violations.push(`${path.relative(ROOT, file)}:${i + 1}  ${m[1]}`);
      }
    });
  }
  assert.deepEqual(violations, [],
    'a path under a maintainer-only directory is named in a shipped document; it '
    + 'resolves only against the analysed project:\n  ' + violations.join('\n  '));
});

test('markdown link destinations are never environment variables', () => {
  // The mirror image of the anchor rule. Markdown does not interpolate, so an
  // anchored link destination is a literal broken URL.
  const broken = [];
  for (const file of markdownFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const re = /\]\((\$\{[^)]*)\)/g;
      let m;
      while ((m = re.exec(line))) {
        broken.push(`${path.relative(ROOT, file)}:${i + 1}  ](${m[1]})`);
      }
    });
  }
  assert.deepEqual(broken, [],
    'markdown link destination uses a variable that nothing expands — use a '
    + `source-relative path instead:\n  ${broken.join('\n  ')}`);
});

test('pluginRequire refuses a symlink that leaves the plugin root', () => {
  // path.resolve is lexical, so a symlink inside the root pointing outside
  // passes a prefix check and require then follows it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'de-symlink-plugin-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'de-symlink-outside-'));
  const { spawnSync } = require('node:child_process');
  try {
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'evil.cjs'), 'module.exports={marker:"OUTSIDE"};\n');
    fs.writeFileSync(path.join(root, 'hooks', 'ok.cjs'), 'module.exports={marker:"INSIDE"};\n');
    fs.symlinkSync(path.join(outside, 'evil.cjs'), path.join(root, 'hooks', 'evil.cjs'));

    const helper = `
      const nodePath = require("node:path"), nodeFs = require("node:fs");
      const PLUGIN_ROOT = nodeFs.realpathSync(process.env.CLAUDE_PLUGIN_ROOT || "");
      const pluginRequire = (rel) => {
        const target = nodeFs.realpathSync(nodePath.resolve(PLUGIN_ROOT, rel));
        if (target !== PLUGIN_ROOT && !target.startsWith(PLUGIN_ROOT + nodePath.sep)) {
          throw new Error("plugin path escapes root: " + rel);
        }
        return require(target);
      };`;
    const run = (src) => spawnSync(process.execPath, ['-e', helper + src],
      { env: { ...process.env, CLAUDE_PLUGIN_ROOT: root }, encoding: 'utf8' });

    const escaped = run('console.log(pluginRequire("hooks/evil.cjs").marker);');
    assert.notEqual(escaped.status, 0, 'a symlink out of the root must be refused');
    assert.match(escaped.stderr, /escapes root/);

    const inside = run('console.log(pluginRequire("hooks/ok.cjs").marker);');
    assert.equal(inside.status, 0, inside.stderr);
    assert.equal(inside.stdout.trim(), 'INSIDE', 'an in-root module must still load');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the documented pluginRequire helpers realpath their target', () => {
  // The runtime behaviour above is only protective if the documents state it.
  const missing = [];
  for (const file of markdownFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    if (!/const\s+pluginRequire\s*=/.test(body)) continue;
    if (!/realpathSync\s*\(\s*nodePath\.resolve\s*\(\s*PLUGIN_ROOT/.test(body)) {
      missing.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(missing, [],
    'pluginRequire resolves lexically without realpath — a symlink out of the '
    + `root would be followed:\n  ${missing.join('\n  ')}`);
});

test('mixed lines fail on the bare token', () => {
  // A line-level anchor check passes this; the token-level check must not.
  const line = 'Read `${CLAUDE_PLUGIN_ROOT}/agents/evolve-seed.md` then Read `../protocols/init.md`';
  const hits = shadowableTokens(line);
  assert.equal(hits.length, 1, 'exactly the bare token must be flagged');
  assert.equal(hits[0].why, 'unanchored');
});

test('every referenced skill path resolves', () => {
  const patterns = [
    // Trailing boundary, same reason as the guard: without it `.js` matches the
    // prefix of `.json` and the resolver reports files that never existed.
    [/\$\{CLAUDE_PLUGIN_ROOT\}[\\/]([A-Za-z0-9._\\/-]+\.(?:md|cjs|mjs|js|sh|json|yaml)(?![A-Za-z0-9]))/g, false],
    [/`(\.\.[\\/][A-Za-z0-9._\\/-]+\.md)(?:#[a-z0-9-]+)?`/g, true],
    // Markdown link destinations are renderer-resolved and must exist relative
    // to the source file — with or without a `./` prefix.
    [/\]\(((?:\.\.?[\\/])?[A-Za-z0-9._\\/-]+\.md)\)/g, true],
    [/Read\("(\.\.[\\/][A-Za-z0-9._\\/-]+\.md)(?:#[a-z0-9-]+)?"\)/g, true],
  ];

  // Either separator in every pattern. This resolver reads the raw body on
  // purpose, so `normalizeSeparators` never reaches it and each pattern has to
  // accept `\` itself. Slash-only left the backslash spelling of an out-of-root
  // reference visible to the classifier but INVISIBLE here — the layer that
  // actually checks containment — and a failure count hides that, because the
  // classifier keeps the total non-zero. One sample per pattern, both spellings,
  // so a revert fails on the axis rather than on whatever is in the tree.
  const samples = [
    ['${CLAUDE_PLUGIN_ROOT}/../workspace/evil.json',
      '${CLAUDE_PLUGIN_ROOT}\\..\\workspace\\evil.json'],
    ['`../shared/x.md`', '`..\\shared\\x.md`'],
    ['[l](../shared/x.md)', '[l](..\\shared\\x.md)'],
    ['Read("../shared/x.md")', 'Read("..\\shared\\x.md")'],
  ];
  patterns.forEach(([re], i) => {
    for (const spelling of samples[i]) {
      re.lastIndex = 0;
      assert.ok(re.exec(spelling), `pattern ${i} must see both spellings: ${spelling}`);
    }
  });
  const broken = [];
  let resolved = 0;
  const realRoot = fs.realpathSync(ROOT);
  for (const file of markdownFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    for (const [re, isRelative] of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(body))) {
        // Normalising the capture is load-bearing but NOT pinned: removing it
        // breaks no test, because no shipped document uses the backslash
        // spelling yet. The failure would first appear as a false `missing` on
        // a file that exists. Recorded, not claimed.
        const target = isRelative
          ? path.resolve(path.dirname(file), normalizeSeparators(m[1]))
          : path.join(ROOT, normalizeSeparators(m[1]));
        if (!fs.existsSync(target)) {
          broken.push(`${path.relative(ROOT, file)} -> ${m[1]} (missing)`);
          continue;
        }
        // Existing is not enough: a target that resolves outside the plugin root
        // — lexically or through a symlinked component — is exactly the file an
        // attacker wants us to accept. Containment is checked here too, so the
        // two tests cannot disagree about what counts as in-root.
        const real = fs.realpathSync(target);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          broken.push(`${path.relative(ROOT, file)} -> ${m[1]} (resolves outside the plugin root: ${real})`);
          continue;
        }
        resolved += 1;
      }
    }
  }
  assert.deepEqual(broken, [], `unresolvable or out-of-root reference:\n  ${broken.join('\n  ')}`);
  assert.ok(resolved > 0, 'sweep matched no references at all — the patterns have rotted');
});

// ---------------------------------------------------------------------------
// Per-axis cases. Each block exists because a mutation of the axis it covers
// survived the suite: the behaviour was generated but never asserted. A test
// that only runs the whole scanner over a clean repository cannot tell a live
// rule from a dead one.
// ---------------------------------------------------------------------------

test('separator: a backslash path is the same instruction as the slash form', () => {
  // The scanner reported zero failures for this line before normalisation,
  // while rejecting the identical slash form.
  const back = 'node hooks\\scripts\\deep-evolve-runtime.cjs --request req.json';
  const fwd = 'node hooks/scripts/deep-evolve-runtime.cjs --request req.json';
  for (const line of [back, fwd]) {
    assert.ok(shadowableTokens(line).length > 0, `must flag: ${line}`);
  }
  // Mixed separators are the reason normalisation lives at recognition rather
  // than inside each rule: a rule taught only about `\` still misses this.
  assert.ok(shadowableTokens('node skills\\deep-evolve/SKILL.md').length > 0,
    'mixed separators must flag');
  // Normalisation must not turn an anchored path into a violation.
  assert.deepEqual(
    shadowableTokens('node "${CLAUDE_PLUGIN_ROOT}\\hooks\\scripts\\deep-evolve-runtime.cjs"'), [],
    'an anchored backslash path is still anchored');

  // Deny-by-default must see the backslash form too. These carry no verb and no
  // interpreter, so no FORM matches and the tokeniser is the only thing that
  // can. Both basenames are in ROOT_METADATA, so a slash-blind tokeniser
  // extracts just the exempt tail (`plugin.json`, `SKILL.md`) and reports
  // nothing — which is exactly how a separator-only mutation survived until
  // this case existed.
  for (const line of ['The Claude manifest is `.claude-plugin\\plugin.json`.',
    'The public entry is `skills\\deep-evolve\\SKILL.md`.']) {
    assert.ok(shadowableTokens(line).length > 0, `deny-by-default must flag: ${line}`);
  }
});

test('separator: prose containing backslashes is not promoted to a path', () => {
  // Negatives. Each is paired with a positive on the next line, so an
  // over-broad PATH_TOKEN fails the negative and a dead one fails the control.
  const prose = [
    'Escape a literal backslash as \\\\ when writing the pattern.',
    'Columns are separated by \\t and rows by \\n.',
    'Match with the expression [A-Za-z]+\\d+ before comparing identities.',
    'Windows absolute paths stay literal: node "C:\\Users\\dev\\Plugin\\hooks\\x.cjs"',
  ];
  for (const line of prose) {
    assert.deepEqual(shadowableTokens(line), [], `prose must not be flagged: ${line}`);
  }
  // Non-vacuity: the scanner is awake on lines of the same shape.
  assert.ok(shadowableTokens('Run node hooks\\scripts\\deep-evolve-runtime.cjs now.').length > 0,
    'fixture is vacuous — a real backslash plugin path must still be flagged');
  assert.ok(shadowableTokens('Match [A-Za-z]+ inside agents/evolve-seed.md first.').length > 0,
    'fixture is vacuous — a real path beside a regex must still be flagged');
});

test('containment applies to every anchored token, not only the five FORMS', () => {
  // No read verb, no interpreter, no recognised form — containment used to be
  // reachable only from inside a FORM, so this line was checked by nothing.
  const hits = shadowableTokens('The registry lives at `${CLAUDE_PLUGIN_ROOT}/../workspace/evil.json`.');
  assert.equal(hits.length, 1, 'a bare anchored escaping token must be flagged');
  assert.equal(hits[0].why, 'escapes plugin root');
  // The in-root counterpart stays clean, so the rule is containment and not a
  // blanket rejection of `..`.
  assert.deepEqual(
    shadowableTokens('The policy lives at `${CLAUDE_PLUGIN_ROOT}/skills/../agents/evolve-seed.md`.'), [],
    'in-root traversal outside a FORM must be accepted');
});

test('expansion: a literal anchor is caught whatever the command is called', () => {
  // The command allowlist had no cp/mv/install/rsync and no project wrapper, so
  // each of these passed while the identical `echo` line failed.
  for (const cmd of ['cp', 'mv', 'install', 'rsync', 'deep-evolve-wrap']) {
    const line = `Run \`${cmd} '\${CLAUDE_PLUGIN_ROOT}/agents/evolve-seed.md' /tmp/x\` first.`;
    const hits = nonExpandingAnchors(line);
    assert.equal(hits.length, 1, `must flag literal anchor under ${cmd}: ${line}`);
    assert.match(hits[0].why, /single-quoted shell/);
  }
  // Prose apostrophes must not open a quote state. This is what the command
  // allowlist was protecting against, and why the replacement is the inline-code
  // span rather than no gate at all.
  for (const line of [
    "The plugin's root is `${CLAUDE_PLUGIN_ROOT}` and it isn't derived from cwd.",
    "Don't resolve `${CLAUDE_PLUGIN_ROOT}/agents/evolve-seed.md` against the workspace.",
  ]) {
    assert.deepEqual(nonExpandingAnchors(line), [], `prose must not be flagged: ${line}`);
  }
  // An expanding position inside the same span shape stays clean.
  assert.deepEqual(
    nonExpandingAnchors('Run `cp "${CLAUDE_PLUGIN_ROOT}/agents/evolve-seed.md" /tmp/x` first.'), [],
    'a double-quoted anchor expands and must be accepted');
});

test('symlink escape is asserted, not merely generated', () => {
  // The repository correctly contains no escaping symlink, so this axis had no
  // fixture and its mutation survived. The root is injected instead.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'de-axis-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'de-axis-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'evil.md'), 'SHADOW\n');
    fs.writeFileSync(path.join(root, 'agents', 'ok.md'), 'fine\n');
    fs.symlinkSync(path.join(outside, 'evil.md'), path.join(root, 'agents', 'evil.md'));

    assert.equal(escapesViaSymlink('${CLAUDE_PLUGIN_ROOT}/agents/evil.md', root), true,
      'a symlink leaving the root must be reported');
    assert.equal(escapesViaSymlink('${CLAUDE_PLUGIN_ROOT}/agents/ok.md', root), false,
      'an in-root file must not be reported');
    assert.equal(escapesViaSymlink('${CLAUDE_PLUGIN_ROOT}/agents/missing.md', root), false,
      'a target that does not exist is not checkable and must not be reported');
    // Backslash form reaches the same verdict — the axis consumes normalised
    // tokens like every other.
    assert.equal(escapesViaSymlink('${CLAUDE_PLUGIN_ROOT}/agents\\evil.md', root), true,
      'separator form must not change the verdict');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('lexical containment is asserted independently of the scanner', () => {
  assert.equal(escapesRoot('${CLAUDE_PLUGIN_ROOT}/../evil.md'), true);
  assert.equal(escapesRoot('${CLAUDE_PLUGIN_ROOT}/agents/../agents/evolve-seed.md'), false);
  assert.equal(escapesRoot('${CLAUDE_PLUGIN_ROOT}\\..\\evil.md'), true,
    'backslash traversal escapes just as lexically as the slash form');
  // Template placeholders cannot be resolved literally, so the check is lexical.
  assert.equal(escapesRoot('${CLAUDE_PLUGIN_ROOT}/skills/{a|b}/../../evil.md'), true);
  assert.equal(escapesRoot('${CLAUDE_PLUGIN_ROOT}/skills/{a|b}/SKILL.md'), false);
});

test('normalisation is applied to both sides of every comparison (Windows emulation)', () => {
  // On Windows `path.relative` returns backslash-joined keys. Patching only the
  // key side reproduces that, and a guard that normalises only the lookup side
  // compares two different spellings and misses every key. Both sides must pass
  // through the same function.
  const winKeys = buildPluginFiles({
    toKey: (f) => path.relative(ROOT, f).split(path.sep).join('\\'),
  });
  assert.ok(winKeys.has('agents/evolve-seed.md'),
    'key generation must normalise, not merely store what the platform produced');

  // Nested source on purpose: from a root-level document `dirname` is ROOT, so the
  // source-relative branch reproduces the direct branch and would rescue an
  // un-normalised token, hiding what this assertion claims to pin.
  const nestedSource = path.join(ROOT, 'skills', 'deep-evolve-workflow', 'protocols', 'coordinator.md');
  assert.equal(resolvesInPlugin('agents/evolve-seed.md', nestedSource, winKeys), true,
    'a slash-shaped lookup must resolve against Windows-shaped keys');
  assert.equal(resolvesInPlugin('agents\\evolve-seed.md', nestedSource, winKeys), true,
    'a backslash-shaped lookup must resolve too');

  // The `fromSource` half, driven through the production call site with a win32
  // `relative`. Nothing else can see it: on POSIX `relative()` already returns
  // slashes, so removing that normalisation is a no-op here.
  {
    const nestedTarget = [...winKeys].find((k) => k.includes('/'));
    const dir = nestedTarget.slice(0, nestedTarget.lastIndexOf('/'));
    const base = nestedTarget.slice(nestedTarget.lastIndexOf('/') + 1);
    const winRel = (from, to) => path.relative(from, to).split('/').join('\\');
    // This pin is vacuous unless the DIRECT branch misses. `resolvesInPlugin`
    // strips the leading `./` and looks the bare basename up first; if a file of
    // that name sits at the repo root it returns there and the source-relative
    // branch — the thing being pinned — never runs, while the assertion still sees
    // `true`. Deriving the target from the shipped set protects against the target
    // MOVING, which fails loudly; it does nothing about this, which fails silently.
    assert.equal(winKeys.has(base), false,
      `a root-level ${base} would make the next assertion vacuous`);
    assert.equal(
      resolvesInPlugin(`./${base}`, path.join(ROOT, dir, 'sibling.md'), winKeys, winRel),
      true,
      'the source-relative branch must normalise its own result before looking it up',
    );
  }

  // Non-vacuity, with a backslash token on purpose. A slash token makes this pair
  // decorative — the un-normalised key set misses either way, so it passes however
  // the token was handled (measured: with the slash spelling, removing the token
  // normalisation fails nothing). The backslash spelling discriminates.
  //
  // It is *dominated* in the current arrangement: the backslash lookup above fails
  // first on the same mutation, so this line does not execute and adds no detection
  // today. It is kept as a backstop, because the assertion that dominates it is an
  // enumeration of spellings — and enumerations get trimmed. Neutralise the spelling
  // above and remove the token normalisation, and this is what fails.
  const rawKeys = new Set([...winKeys].map((k) => k.split('/').join('\\')));
  assert.equal(resolvesInPlugin('agents\\evolve-seed.md', nestedSource, rawKeys), false,
    'un-normalised keys must not be reachable by an un-normalised token');
});

test('a separator run is seen by the fixture layer, not only the classifier', () => {
  // The defect this pins was invisible to a failure count. With `hooks\\scripts\\…`
  // the classifier still reported a violation — FORMS' PATH_BODY is a flat class
  // that spans a run — while the tokeniser fell back to the bare basename, so
  // deny-by-default and the malicious-workspace fixture saw nothing. One layer
  // covering for another looks like "caught" until the covering layer is
  // bypassed, and the fixture is the only layer that proves a planted file is
  // actually reached. So both layers are asserted here by name.
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'de-run-evil-'));
  try {
    fs.mkdirSync(path.join(evil, 'hooks', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(evil, 'hooks', 'scripts', 'deep-evolve-runtime.cjs'),
      'process.stdout.write("SHADOW");\n');

    const landsOnShadow = (line) => {
      for (const token of scopedTokens(line)) {
        if (/^\$\{CLAUDE_PLUGIN_ROOT\}\//.test(token)) continue;
        const target = path.resolve(evil, token.replace(/^\.\//, ''));
        if (target.startsWith(evil + path.sep) && fs.existsSync(target)) return true;
      }
      return false;
    };

    // Every separator spelling of the same instruction. The run forms are the
    // regression; the single forms are the control that already worked.
    for (const line of [
      'node hooks/scripts/deep-evolve-runtime.cjs',
      'node hooks\\scripts\\deep-evolve-runtime.cjs',
      'node hooks\\\\scripts\\\\deep-evolve-runtime.cjs',
      'node hooks//scripts//deep-evolve-runtime.cjs',
      'node hooks\\/scripts/\\deep-evolve-runtime.cjs',
    ]) {
      assert.ok(shadowableTokens(line).length > 0,
        `classifier layer must flag: ${line}`);
      assert.ok(landsOnShadow(line),
        `fixture layer must resolve onto the planted shadow: ${line}`);
    }

    // The resolver is the layer that separator-run collapsing actually
    // protects, and the two assertions above cannot see it: `path.resolve`
    // happens to fold `//` for the fixture, and FORMS' flat class spans a run
    // for the classifier. A Set keyed on single slashes folds nothing, so
    // without collapsing this is where the run form goes quiet.
    // The source file must be a nested one. From a root-level document the
    // source-relative branch resolves the token with `path.resolve`, which folds
    // runs for free and hides whether the repo-relative lookup works at all —
    // that masking is why the first version of this assertion passed against a
    // guard with no run collapsing.
    const nested = path.join(ROOT, 'skills', 'deep-evolve-workflow', 'protocols', 'coordinator.md');
    for (const token of ['hooks//scripts//deep-evolve-runtime.cjs',
      'hooks\\\\scripts\\\\deep-evolve-runtime.cjs',
      'hooks\\/scripts/\\deep-evolve-runtime.cjs']) {
      assert.equal(resolvesInPlugin(token, nested), true,
        `resolver must fold the separator run: ${token}`);
    }
    // And deny-by-default must reach a run form on its own. `.json` matches no
    // FORM, so this line is caught by resolution or by nothing.
    assert.ok(shadowableTokens('The Claude manifest is `.claude-plugin\\\\plugin.json`.').length > 0,
      'deny-by-default must flag a separator run with no recognised form');

    // Non-vacuity: the fixture layer really can come back false, so the
    // assertions above are not passing on a resolver that says yes to anything.
    assert.equal(landsOnShadow('node hooks/scripts/not-planted.cjs'), false,
      'fixture is vacuous — an unplanted path must not report a landing');
    assert.equal(landsOnShadow('node "${CLAUDE_PLUGIN_ROOT}//hooks//scripts//deep-evolve-runtime.cjs"'),
      false, 'an anchored run form must not land in the workspace');
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
  }
});
