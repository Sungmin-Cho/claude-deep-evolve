'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const RELEASE_VERSION = '3.6.0';

// Both host surfaces pin the identical env-bootstrap guard command (E2 fix).
// Double-quoted so the embedded single quotes stay literal.
const GUARD_BOOTSTRAP_COMMAND = "node -e \"const{spawn}=require('node:child_process');const{existsSync}=require('node:fs');const{join}=require('node:path');const r=process.env.CLAUDE_PLUGIN_ROOT||process.env.PLUGIN_ROOT||'';if(r===''){console.error('deep-evolve protect-readonly bootstrap: CLAUDE_PLUGIN_ROOT/PLUGIN_ROOT unset; fail-closed');process.exit(2);}const s=join(r,'hooks','scripts','protect-readonly.cjs');if(existsSync(s)===false){console.error('deep-evolve protect-readonly bootstrap: missing '+s+'; fail-closed');process.exit(2);}const w=process.platform==='win32';const c=spawn(process.execPath,[s],{stdio:'inherit',detached:w===false});let z=false;let k=false;let g;const f=(code)=>{if(z){return;}z=true;clearTimeout(t);clearTimeout(g);process.exit(code);};const t=setTimeout(()=>{k=true;console.error('deep-evolve protect-readonly bootstrap: deadline 4000ms exceeded; killing tree; fail-closed');try{if(w){const tk=spawn('taskkill',['/PID',String(c.pid),'/T','/F']);tk.on('error',()=>{});}else{process.kill(-c.pid,'SIGKILL');}}catch(e){}g=setTimeout(()=>{console.error('deep-evolve protect-readonly bootstrap: kill grace 800ms expired; fail-closed');f(2);},800);},4000);c.on('error',(e)=>{console.error('deep-evolve protect-readonly bootstrap: spawn error '+e.message+'; fail-closed');f(2);});c.on('exit',(code,sig)=>{if(k){f(2);return;}if(code===0){f(0);return;}if(code===2){f(2);return;}console.error('deep-evolve protect-readonly bootstrap: child exit '+code+' signal '+sig+'; fail-closed');f(2);});\"";

function frontmatterVersion(source) {
  const match = source.match(/^version:\s*"([^"]+)"\s*$/m);
  assert.ok(match, 'workflow skill must declare a quoted frontmatter version');
  return match[1];
}

function runtimeVersion(source) {
  const match = source.match(/^const RUNTIME_VERSION = '([^']+)';\s*$/m);
  assert.ok(match, 'runtime must declare an explicit release version');
  return match[1];
}

function headings(source) {
  let fenced = false;
  return source.split(/\r?\n/).filter((line) => {
    if (/^```/.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced && /^#{1,3}\s/.test(line);
  });
}

function headingDepths(source) {
  return headings(source).map((line) => line.match(/^#+/)[0].length);
}

function currentRelease(source) {
  const start = source.indexOf(`## [${RELEASE_VERSION}]`);
  assert.notEqual(start, -1, `CHANGELOG must contain ${RELEASE_VERSION}`);
  const next = source.indexOf('\n## ', start + 4);
  return source.slice(start, next === -1 ? source.length : next);
}

test('3.6.0 is synchronized across all five supported release sources', () => {
  const versions = {
    claude: readJson('.claude-plugin/plugin.json').version,
    codex: readJson('.codex-plugin/plugin.json').version,
    package: readJson('package.json').version,
    workflow: frontmatterVersion(read('skills/deep-evolve-workflow/SKILL.md')),
    runtime: runtimeVersion(read('hooks/scripts/deep-evolve-runtime.cjs')),
  };
  assert.deepEqual(versions, {
    claude: RELEASE_VERSION,
    codex: RELEASE_VERSION,
    package: RELEASE_VERSION,
    workflow: RELEASE_VERSION,
    runtime: RELEASE_VERSION,
  });
});

test('evergreen bilingual READMEs document the same supported cross-host surface', () => {
  const english = read('README.md');
  const korean = read('README.ko.md');

  assert.equal(english.split(/\r?\n/, 1)[0], '**English** | [한국어](./README.ko.md)');
  assert.equal(korean.split(/\r?\n/, 1)[0], '[English](./README.md) | **한국어**');
  assert.deepEqual(headingDepths(english), headingDepths(korean));
  assert.equal(headingDepths(english).length, headingDepths(korean).length);
  assert.deepEqual(headings(english), [
    '# deep-evolve',
    '## Role in deep-suite',
    '## Inspiration',
    '## Install',
    '### Via the Deep Suite marketplace (recommended)',
    '### Standalone',
    '## Quick start',
    '## The methodology',
    '### Three files that matter',
    '### The experiment loop',
    '### One metric, one truth',
    '### Simplicity criterion',
    '### Diminishing returns',
    '### Self-evolution',
    '### Virtual parallel exploration',
    '## How deep-evolve works',
    '## Supported domains',
    '## Links',
    '## License',
  ]);
  assert.deepEqual(headings(korean), [
    '# deep-evolve',
    '## deep-suite에서의 역할',
    '## 영감',
    '## 설치',
    '### Deep Suite 마켓플레이스 (권장)',
    '### 단독 설치',
    '## 빠른 시작',
    '## 방법론',
    '### 중요한 세 가지 파일',
    '### 실험 루프',
    '### 하나의 메트릭, 하나의 진실',
    '### 간결함 기준',
    '### 감소 수익',
    '### 자기 진화',
    '### Virtual parallel 탐색',
    '## deep-evolve 작동 방식',
    '## 지원 도메인',
    '## 링크',
    '## 라이선스',
  ]);

  for (const source of [english, korean]) {
    assert.match(source, /Node 22/);
    assert.match(source, /Windows 11/);
    assert.match(source, /\/deep-evolve/);
    assert.match(source, /\$deep-evolve:deep-evolve/);
    assert.match(source, /`prepare\.cjs`/);
    assert.match(source, /`prepare\.config\.json`/);
    assert.doesNotMatch(source, /^## What's New/im);
    for (const line of source.split(/\r?\n/).filter((entry) => /prepare\.py/.test(entry))) {
      assert.match(line, /<!-- legacy-migration-only -->/,
        'README prepare.py history must be explicitly migration-only');
    }
  }

  assert.match(english, /native Windows 11/i);
  assert.match(english, /does not require Git Bash or Python/i);
  assert.match(english, /legacy sessions? (?:is|are) migrated/i);
  assert.match(english, /user-provided tools/i);
  assert.match(english, /does not bundle an MCP server/i);

  assert.match(korean, /네이티브 Windows 11/i);
  assert.match(korean, /Git Bash나 Python이 필요하지 않습니다/i);
  assert.match(korean, /레거시 세션[\s\S]{0,120}마이그레이션/i);
  assert.match(korean, /사용자가 제공한 도구/i);
  assert.match(korean, /MCP 서버를 번들하지 않습니다/i);
});

test('3.6.0 changelogs are concise, bilingual, and user-observable', () => {
  const english = currentRelease(read('CHANGELOG.md'));
  const korean = currentRelease(read('CHANGELOG.ko.md'));
  assert.match(english, /^## \[3\.6\.0\] — 2026-07-19$/m);
  assert.match(korean, /^## \[3\.6\.0\] — 2026-07-19$/m);
  assert.deepEqual(headingDepths(english), headingDepths(korean));
  assert.deepEqual(headingDepths(english), [2, 3, 3, 3]);
  assert.match(english, /^### Added$/m);
  assert.match(english, /^### Changed$/m);
  assert.match(english, /^### Fixed$/m);
  assert.match(korean, /^### Added$/m);
  assert.match(korean, /^### Changed$/m);
  assert.match(korean, /^### Fixed$/m);
  for (const release of [english, korean]) {
    assert.doesNotMatch(release,
      /(?:\.cjs|\.js|\.json|\.md|\.sh|\.py|deep-review|REQUEST_CHANGES|APPROVE|\bcommit\b|\bPR\b|\btests?\b|\b[0-9a-f]{40}\b)/i);
    for (const bullet of release.split(/\r?\n/).filter((line) => line.startsWith('- '))) {
      assert.equal(bullet.includes('\n'), false);
    }
  }
});

test('maintainer and security guides describe only the supported Node runtime', () => {
  const agents = read('AGENTS.md');
  const claude = read('CLAUDE.md');
  const contributing = read('CONTRIBUTING.md');
  const security = read('SECURITY.md');

  for (const guide of [agents, claude]) {
    assert.match(guide, /docs\/DOCS_RULE\.md/);
    assert.match(guide, /Node 22/);
    assert.doesNotMatch(guide, /\b(?:Bash|Python|pytest)\b/);
  }
  assert.match(contributing, /Node 22/);
  assert.match(contributing, /Ubuntu.*macOS.*Windows|Ubuntu[\s\S]*macOS[\s\S]*Windows/i);
  assert.match(contributing, /optional[\s\S]*Unix-only[\s\S]*legacy-oracle/i);
  assert.doesNotMatch(contributing, /Bash 3\.2|supported runtime[\s\S]*Python/i);

  assert.match(security, /Node readonly guard/i);
  assert.match(security, /structured argv/i);
  assert.match(security, /protect-readonly\.cjs/);
  assert.doesNotMatch(security, /protect-readonly\.sh|prepare\.py/);
});

test('Codex uses one default-discovered Node guard and no plugin-level hook supplement', () => {
  const manifest = readJson('.codex-plugin/plugin.json');
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
  assert.equal(Object.hasOwn(manifest, 'mcpServers'), false);

  const hookManifest = readJson('hooks/hooks.json');
  assert.deepEqual(Object.keys(hookManifest), ['hooks']);
  assert.deepEqual(Object.keys(hookManifest.hooks), ['PreToolUse']);
  assert.equal(hookManifest.hooks.PreToolUse.length, 1);
  const registration = hookManifest.hooks.PreToolUse[0];
  assert.equal(registration.matcher, 'Bash|apply_patch');
  assert.equal(registration.hooks.length, 1);
  assert.deepEqual(registration.hooks[0], {
    type: 'command',
    command: GUARD_BOOTSTRAP_COMMAND,
    commandWindows: 'node "${PLUGIN_ROOT}\\hooks\\scripts\\protect-readonly.cjs" ; exit $LASTEXITCODE',
    timeout: 5,
  });
  assert.doesNotMatch(registration.hooks[0].commandWindows, /%PLUGIN_ROOT%/,
    'Codex runs Windows hooks through PowerShell, so cmd.exe-only expansion would fail open');
  assert.match(registration.hooks[0].commandWindows, /" ; exit \$LASTEXITCODE$/,
    'PowerShell must propagate the native Node guard exit code to Codex');
  assert.equal(Object.hasOwn(registration.hooks[0], 'args'), false);
  assert.doesNotMatch(registration.matcher, /Read|Write|Edit|MultiEdit/);
});

test('Claude uses one custom-path env-bootstrap Node guard without Codex-only fields', () => {
  const manifest = readJson('.claude-plugin/plugin.json');
  assert.equal(manifest.hooks, './hooks/hooks.claude.json');
  assert.equal(Object.hasOwn(manifest, 'mcpServers'), false);

  const hookManifest = readJson('hooks/hooks.claude.json');
  assert.deepEqual(Object.keys(hookManifest), ['hooks']);
  assert.deepEqual(Object.keys(hookManifest.hooks), ['PreToolUse']);
  assert.equal(hookManifest.hooks.PreToolUse.length, 1);
  const registration = hookManifest.hooks.PreToolUse[0];
  assert.equal(registration.matcher, 'Read|Write|Edit|MultiEdit|Bash');
  assert.equal(registration.hooks.length, 1);
  assert.deepEqual(registration.hooks[0], {
    type: 'command',
    command: GUARD_BOOTSTRAP_COMMAND,
    timeout: 5,
  });
  assert.equal(Object.hasOwn(registration.hooks[0], 'args'), false);
  assert.equal(Object.hasOwn(registration.hooks[0], 'commandWindows'), false);
  assert.doesNotMatch(registration.matcher, /apply_patch/);
});

test('the intermediate package ships both host manifests and the shared CommonJS guard', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.js');
  assert.ok(pkg.files.includes('hooks/hooks.json'));
  assert.ok(pkg.files.includes('hooks/hooks.claude.json'));
  assert.ok(pkg.files.includes('hooks/scripts/*.cjs'));
  assert.ok(pkg.files.includes('hooks/scripts/runtime/'));
});

test('Task 2 golden documentation matches the runner template-expansion contract', () => {
  const goldenReadme = fs.readFileSync(path.join(root, 'tests/fixtures/golden/README.md'), 'utf8');
  assert.match(goldenReadme, /Values inside `tool_input` are walked/);
  assert.doesNotMatch(goldenReadme, /`tool_input` and `env`/);
});
