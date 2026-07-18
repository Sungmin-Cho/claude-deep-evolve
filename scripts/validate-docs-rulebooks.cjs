#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function diagnostic(code, rule, filePath, detail) {
  return {
    type: 'docs_rulebook_error',
    code,
    rule,
    path: filePath,
    detail,
  };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--evolve-rule', '--suite-rule'].includes(flag) || !value || values.has(flag)) {
      return null;
    }
    values.set(flag, value);
  }
  if (values.size !== 2) return null;
  return {
    evolve: values.get('--evolve-rule'),
    suite: values.get('--suite-rule'),
  };
}

function readRule(rule, filePath, errors) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    errors.push(diagnostic('missing_rulebook', rule, filePath,
      error && error.code === 'ENOENT' ? 'rulebook is missing' : 'rulebook is unreadable'));
    return null;
  }
}

function validateCommon(rule, filePath, source, errors) {
  if (/\bjq\b/i.test(source)) {
    errors.push(diagnostic('outdated_jq_version_read', rule, filePath,
      'version and pin reads must use Node-only tooling'));
  }

  const mentionsLegacyVersionTokens = /session-helper\.sh|HELPER_VERSION/.test(source);
  const legacyVersionParagraphs = source.split(/\r?\n\s*\r?\n/)
    .filter((paragraph) => /session-helper\.sh|HELPER_VERSION/.test(paragraph));
  const hasLegacyVersionExclusion = legacyVersionParagraphs.some((paragraph) =>
    /(?:explicitly\s+excluded|never|not\s+a)[\s\S]{0,80}release\s+version\s+sources?/i.test(paragraph));
  const hasPositiveLegacyVersionPolicy = legacyVersionParagraphs.some((paragraph) =>
    /(?:lockstep|version\s+sync|release\s+version\s+sources?)/i.test(paragraph)
      && !/(?:explicitly\s+excluded|never|not\s+a)[\s\S]{0,80}release\s+version\s+sources?/i.test(paragraph));
  if (mentionsLegacyVersionTokens
      && (!hasLegacyVersionExclusion || hasPositiveLegacyVersionPolicy)) {
    errors.push(diagnostic('outdated_legacy_version_source', rule, filePath,
      'the thin session helper and removed HELPER_VERSION must be excluded from release versions'));
  }

  if (!/ordinary CI is Node-only/i.test(source)) {
    errors.push(diagnostic('supported_ci_uses_python', rule, filePath,
      'ordinary supported CI must be explicitly Node-only'));
  }

  if (!/Node 22/i.test(source)
      || !/Ubuntu/i.test(source)
      || !/macOS/i.test(source)
      || !/Windows/i.test(source)) {
    errors.push(diagnostic('missing_node22_three_os_matrix', rule, filePath,
      'supported CI must name Node 22 on Ubuntu, macOS, and Windows'));
  }

  if (!/isolated\s+Unix-only[\s\S]{0,80}legacy-oracle|legacy-oracle[\s\S]{0,80}isolated\s+Unix-only/i.test(source)) {
    errors.push(diagnostic('missing_isolated_unix_legacy_oracle', rule, filePath,
      'Python compatibility evidence must be limited to the isolated Unix-only legacy-oracle'));
  }

  if (!/maintainer Codex validator[\s\S]{0,100}outside\s+supported\s+runtime\s+and\s+ordinary\s+CI/i.test(source)) {
    errors.push(diagnostic('missing_maintainer_codex_boundary', rule, filePath,
      'the Codex validator must remain a maintainer-only gate outside supported runtime and CI'));
  }
}

function validateEvolve(filePath, source, errors) {
  const hasFiveSources = /five release sources/i.test(source)
    && /Claude manifest/i.test(source)
    && /Codex manifest/i.test(source)
    && /package metadata|package\.json/i.test(source)
    && /workflow skill frontmatter/i.test(source)
    && /RUNTIME_VERSION/.test(source);
  if (!hasFiveSources) {
    errors.push(diagnostic('missing_five_release_sources', 'evolve', filePath,
      'the five Node-era release version sources must be named explicitly'));
  }
}

function validateSuite(filePath, source, errors) {
  if (!/Node-only tooling/i.test(source)
      || !/(?:no|does not use a) plugin version triple/i.test(source)) {
    errors.push(diagnostic('missing_suite_node_pin_policy', 'suite', filePath,
      'suite pin maintenance must be Node-only and must not invent a plugin version triple'));
  }
}

function main(argv) {
  const paths = parseArguments(argv);
  if (!paths) {
    process.stderr.write(`${JSON.stringify(diagnostic(
      'invalid_arguments', 'cli', '',
      'usage: validate-docs-rulebooks.cjs --evolve-rule PATH --suite-rule PATH',
    ))}\n`);
    return 1;
  }

  const errors = [];
  const evolve = readRule('evolve', paths.evolve, errors);
  const suite = readRule('suite', paths.suite, errors);
  if (evolve !== null) {
    validateCommon('evolve', paths.evolve, evolve, errors);
    validateEvolve(paths.evolve, evolve, errors);
  }
  if (suite !== null) {
    validateCommon('suite', paths.suite, suite, errors);
    validateSuite(paths.suite, suite, errors);
  }

  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`${JSON.stringify(error)}\n`);
    return 1;
  }

  process.stdout.write(`${JSON.stringify({
    type: 'docs_rulebooks_valid',
    evolve_rule: paths.evolve,
    suite_rule: paths.suite,
  })}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
