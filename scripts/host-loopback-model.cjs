#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { TextDecoder } = require('node:util');

const LOOPBACK_MODEL = 'deep-evolve-loopback-contract-v1';
const PUBLIC_CLAUDE_HEADER = 'deep-evolve-loopback-public-v1';

const EXACT_CODEX_MODEL_CATALOG = Object.freeze({
  models: [Object.freeze({
    slug: LOOPBACK_MODEL,
    display_name: 'Deep Evolve loopback contract',
    description: 'Deterministic local hook contract model',
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: 'disabled',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    availability_nux: null,
    upgrade: null,
    base_instructions: 'Use the requested apply_patch tool exactly once.',
    supports_reasoning_summaries: false,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    truncation_policy: Object.freeze({ mode: 'bytes', limit: 10_000 }),
    supports_parallel_tool_calls: false,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_search_tool: false,
    use_responses_lite: false,
    tool_mode: 'direct',
  })],
});

const MAX_BODY_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 15_000;
const CODEX_CALL_ID = 'call_loopback_1';
const CODEX_ITEM_ID = 'ctc_loopback_1';
const CLAUDE_TOOL_ID = 'toolu_loopback_1';
const CAPTURE_SOURCE = 'actual_exact_pinned_host';
const MODEL_SOURCE = 'deterministic_loopback_protocol_v1';
const PINNED_CODEX_GUARD_DENIAL = 'Deep Evolve Guard: active sessions protect prepare.cjs, '
  + 'prepare.config.json, legacy prepare.py, prepare-protocol.md, program.md, and strategy.yaml. '
  + 'Use the matching meta mode for an authorized policy update.';
const PINNED_CODEX_HOOK_TRUST_WARNING = '`--dangerously-bypass-hook-trust` is enabled. '
  + 'Enabled hooks may run without review for this invocation.';

const ACCEPTED_POINTERS = Object.freeze({
  codex: Object.freeze(['/tool_name', '/tool_input/command']),
  claude: Object.freeze([
    '/hook_event_name',
    '/tool_name',
    '/tool_input/file_path',
    '/tool_input/content',
  ]),
});

function fail(message, code = 'loopback_contract_invalid') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw fail(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function loopbackOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw fail(`${label} must be a valid loopback URL`);
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
    || !parsed.port || parsed.username || parsed.password
    || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw fail(`${label} must be an uncredentialed 127.0.0.1 HTTP origin`);
  }
  return parsed.origin;
}

function constantTimeTextEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left), 'utf8').digest();
  const rightDigest = crypto.createHash('sha256').update(String(right), 'utf8').digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function buildCodexModelCatalog() {
  return JSON.parse(JSON.stringify(EXACT_CODEX_MODEL_CATALOG));
}

function exactObjectKeys(value, expected, label) {
  if (!plainObject(value)) throw fail(`${label} must be a plain object`);
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) throw fail(`${label} is missing ${key}`);
  }
  for (const key of actualKeys) {
    if (!Object.hasOwn(expected, key)) throw fail(`${label} has unexpected key ${key}`);
  }
}

function validateCodexModelCatalog(value) {
  exactObjectKeys(value, EXACT_CODEX_MODEL_CATALOG, 'model catalog');
  if (!Array.isArray(value.models) || value.models.length !== 1) {
    throw fail('model catalog models must contain exactly one model');
  }
  const actual = value.models[0];
  const expected = EXACT_CODEX_MODEL_CATALOG.models[0];
  exactObjectKeys(actual, expected, 'model');
  for (const [key, exact] of Object.entries(expected)) {
    if (key === 'truncation_policy') {
      exactObjectKeys(actual[key], exact, 'truncation_policy');
    }
    if (JSON.stringify(actual[key]) !== JSON.stringify(exact)) {
      throw fail(`model ${key} must equal the exact pinned value`);
    }
  }
  return value;
}

function absolutePlatformPath(value, label) {
  if (typeof value !== 'string' || (!path.isAbsolute(value) && !path.win32.isAbsolute(value))) {
    throw fail(`${label} must be an absolute path`);
  }
  return value;
}

function directoryFileUrl(value, { windows = process.platform === 'win32' } = {}) {
  absolutePlatformPath(value, 'directory');
  const separator = windows ? path.win32.sep : path.posix.sep;
  const directory = value.endsWith(separator) ? value : `${value}${separator}`;
  return pathToFileURL(directory, { windows }).href;
}

function buildCodexConfig({ origin, modelCatalogPath }) {
  const exactOrigin = loopbackOrigin(origin, 'origin');
  const exactCatalogPath = absolutePlatformPath(modelCatalogPath, 'modelCatalogPath');
  return [
    `model = "${LOOPBACK_MODEL}"`,
    'model_provider = "deep_evolve_loopback"',
    `model_catalog_json = ${JSON.stringify(exactCatalogPath)}`,
    'chatgpt_base_url = "http://127.0.0.1:9"',
    'check_for_update_on_startup = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[windows]',
    'sandbox = "elevated"',
    '',
    '[model_providers.deep_evolve_loopback]',
    'name = "Deep Evolve loopback contract"',
    `base_url = "${exactOrigin}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n');
}

function buildIsolatedHostEnv({ host, home, codexHome, claudeConfigDir, origin, proxyOrigin,
  gitConfigGlobal }) {
  if (!['codex', 'claude'].includes(host)) throw fail('host must be codex or claude');
  const exactHome = requireAbsolutePath(home, 'home');
  const exactOrigin = loopbackOrigin(origin, 'origin');
  const exactProxyOrigin = loopbackOrigin(proxyOrigin, 'proxyOrigin');
  const temp = path.join(exactHome, 'temporary files');
  const env = {
    HOME: exactHome,
    USERPROFILE: exactHome,
    APPDATA: path.join(exactHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(exactHome, 'AppData', 'Local'),
    TMP: temp,
    TEMP: temp,
    PATH: process.env.PATH || '',
    HTTP_PROXY: exactProxyOrigin,
    HTTPS_PROXY: exactProxyOrigin,
    ALL_PROXY: exactProxyOrigin,
    NO_PROXY: '127.0.0.1,localhost',
  };

  for (const key of ['SystemRoot', 'ComSpec', 'PATHEXT']) {
    if (typeof process.env[key] === 'string' && process.env[key]) env[key] = process.env[key];
  }

  if (host === 'codex') {
    env.CODEX_HOME = requireAbsolutePath(codexHome, 'codexHome');
    env.GIT_CONFIG_GLOBAL = requireAbsolutePath(gitConfigGlobal, 'gitConfigGlobal');
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_ALLOW_PROTOCOL = 'file';
    env.GIT_TERMINAL_PROMPT = '0';
  } else {
    env.CLAUDE_CONFIG_DIR = requireAbsolutePath(claudeConfigDir, 'claudeConfigDir');
    env.ANTHROPIC_BASE_URL = exactOrigin;
    env.ANTHROPIC_API_KEY = PUBLIC_CLAUDE_HEADER;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = '1';
  }
  return env;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeJsonAtomic(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, target);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      finish(reject, fail('provider request deadline exceeded', 'request_timeout'));
      request.destroy();
    });
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        finish(reject, fail('provider request body exceeds limit', 'request_body_too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (settled) return;
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        finish(reject, fail('provider request body must be JSON', 'invalid_json'));
        return;
      }
      if (!plainObject(value)) {
        finish(reject, fail('provider request body must be an object', 'invalid_json'));
        return;
      }
      finish(resolve, value);
    });
    request.once('error', (error) => finish(reject, error));
  });
}

function sendError(response, status, code) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(`${JSON.stringify({ error: { code, message: code } })}\n`);
}

function sendSse(response, events, includeDone = false) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  });
  for (const event of events) {
    if (event.event) response.write(`event: ${event.event}\n`);
    response.write(`data: ${JSON.stringify(event.data)}\n\n`);
  }
  if (includeDone) response.write('data: [DONE]\n\n');
  response.end();
}

function allObjects(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) allObjects(item, output);
  } else if (plainObject(value)) {
    output.push(value);
    for (const item of Object.values(value)) allObjects(item, output);
  }
  return output;
}

function bodyContainsExactPath(value, targetPath) {
  if (typeof value === 'string') return value.includes(targetPath);
  if (Array.isArray(value)) return value.some((item) => bodyContainsExactPath(item, targetPath));
  if (plainObject(value)) return Object.values(value)
    .some((item) => bodyContainsExactPath(item, targetPath));
  return false;
}

function codexToolOutput(body) {
  const outputs = allObjects(body)
    .filter((value) => value.type === 'custom_tool_call_output');
  const candidates = outputs.filter((value) => value.call_id === CODEX_CALL_ID);
  if (outputs.length !== 1 || candidates.length !== 1) return null;
  const text = typeof candidates[0].output === 'string'
    ? candidates[0].output
    : JSON.stringify(candidates[0].output);
  if (!/Deep Evolve Guard/.test(text) || !/(?:denied|block|protect)/i.test(text)) return null;
  return candidates[0];
}

function claudeDeniedResult(body, targetPath) {
  const objects = allObjects(body);
  const results = objects.filter((value) => value.type === 'tool_result');
  const candidates = results.filter((value) => value.tool_use_id === CLAUDE_TOOL_ID);
  if (results.length !== 1 || candidates.length !== 1 || candidates[0].is_error !== true) return null;
  const toolUses = objects.filter((value) => value.type === 'tool_use');
  const calls = toolUses.filter((value) => value.type === 'tool_use'
    && value.id === CLAUDE_TOOL_ID && value.name === 'Write'
    && plainObject(value.input) && value.input.file_path === targetPath
    && value.input.content === 'after');
  if (toolUses.length !== 1 || calls.length !== 1) return null;
  const text = typeof candidates[0].content === 'string'
    ? candidates[0].content
    : JSON.stringify(candidates[0].content);
  if (!/Deep Evolve Guard/.test(text) || !/(?:denied|block|protect)/i.test(text)) return null;
  return candidates[0];
}

function codexToolCall(targetPath, complete) {
  const patch = [
    '*** Begin Patch',
    `*** Update File: ${targetPath}`,
    '@@',
    '-before',
    '+after',
    '*** End Patch',
  ].join('\n');
  return {
    type: 'custom_tool_call',
    id: CODEX_ITEM_ID,
    call_id: CODEX_CALL_ID,
    name: 'apply_patch',
    input: complete ? patch : '',
    ...(complete ? { status: 'completed' } : {}),
  };
}

function codexResponse({ output, status = 'completed' }) {
  return {
    id: 'resp_loopback_1',
    object: 'response',
    created_at: 0,
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: LOOPBACK_MODEL,
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: 0,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
    user: null,
    metadata: {},
  };
}

function firstCodexEvents(targetPath) {
  const pending = codexResponse({ output: [], status: 'in_progress' });
  const added = codexToolCall(targetPath, false);
  const complete = codexToolCall(targetPath, true);
  const finished = codexResponse({ output: [complete] });
  return [
    { event: 'response.created',
      data: { type: 'response.created', response: pending, sequence_number: 0 } },
    { event: 'response.output_item.added',
      data: { type: 'response.output_item.added', output_index: 0,
      item: added, sequence_number: 1 } },
    { event: 'response.output_item.done',
      data: { type: 'response.output_item.done', output_index: 0,
      item: complete, sequence_number: 2 } },
    { event: 'response.completed',
      data: { type: 'response.completed', response: finished, sequence_number: 3 } },
  ];
}

function terminalCodexEvents() {
  const item = {
    type: 'message',
    id: 'msg_loopback_1',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'The protected edit was denied.',
      annotations: [], logprobs: [] }],
  };
  return [
    { event: 'response.created',
      data: { type: 'response.created', response: codexResponse({ output: [], status: 'in_progress' }),
      sequence_number: 0 } },
    { event: 'response.output_item.added',
      data: { type: 'response.output_item.added', output_index: 0,
      item: { ...item, status: 'in_progress', content: [] }, sequence_number: 1 } },
    { event: 'response.output_item.done',
      data: { type: 'response.output_item.done', output_index: 0, item, sequence_number: 2 } },
    { event: 'response.completed',
      data: { type: 'response.completed', response: codexResponse({ output: [item] }),
      sequence_number: 3 } },
  ];
}

function firstClaudeEvents(targetPath) {
  const input = JSON.stringify({
    file_path: targetPath,
    content: 'after',
  });
  return [
    { event: 'message_start', data: {
      type: 'message_start',
      message: {
        id: 'msg_loopback_1', type: 'message', role: 'assistant', model: LOOPBACK_MODEL,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } },
    { event: 'content_block_start', data: {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', name: 'Write', id: CLAUDE_TOOL_ID, input: {} },
    } },
    { event: 'content_block_delta', data: {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: input },
    } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: {
      type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 1 },
    } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

function terminalClaudeEvents() {
  return [
    { event: 'message_start', data: {
      type: 'message_start',
      message: {
        id: 'msg_loopback_2', type: 'message', role: 'assistant', model: LOOPBACK_MODEL,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } },
    { event: 'content_block_start', data: {
      type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' },
    } },
    { event: 'content_block_delta', data: {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'The protected edit was denied.' },
    } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

async function createLoopbackDriver({ host, targetPath, receiptPath }) {
  if (!['codex', 'claude'].includes(host)) throw fail('host must be codex or claude');
  const exactTarget = requireAbsolutePath(targetPath, 'targetPath');
  const exactReceipt = requireAbsolutePath(receiptPath, 'receiptPath');
  if (host === 'codex') {
    if (!fs.existsSync(exactTarget) || !fs.statSync(exactTarget).isFile()) {
      throw fail('Codex targetPath must identify the prepared protected file');
    }
  } else {
    const parent = path.dirname(exactTarget);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()
      || (fs.existsSync(exactTarget) && !fs.statSync(exactTarget).isFile())) {
      throw fail('Claude targetPath must be an absent or existing file in a prepared directory');
    }
  }

  const receipt = {
    schema_version: 1,
    kind: 'deep_evolve_loopback_driver_receipt',
    host,
    model: LOOPBACK_MODEL,
    target_path: exactTarget,
    request_limit: 2,
    provider_requests: [],
    external_network_attempts: [],
    errors: [],
    completed: false,
  };
  let requestCount = 0;
  let closed = false;
  let resolveCompleted;
  const completedReceipt = new Promise((resolve) => { resolveCompleted = resolve; });

  const recordError = (error) => {
    const code = error && error.code ? error.code : 'provider_contract_invalid';
    receipt.errors.push({ code });
    return code;
  };

  const provider = http.createServer(async (request, response) => {
    const remoteAddress = request.socket.remoteAddress;
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
      receipt.external_network_attempts.push({
        kind: 'external_network_attempt', protocol: 'provider', remote_address: remoteAddress || null,
      });
      sendError(response, 403, 'external_network_attempt');
      return;
    }
    requestCount += 1;
    const requestRecord = { index: requestCount, method: request.method, path: request.url };
    receipt.provider_requests.push(requestRecord);
    if (requestCount > 2) {
      requestRecord.result = 'rejected_request_limit';
      sendError(response, 409, 'provider_request_limit_exceeded');
      return;
    }
    try {
      if (request.method !== 'POST') throw fail('provider requires POST', 'invalid_method');
      const expectedPath = host === 'codex' ? '/v1/responses' : '/v1/messages?beta=true';
      if (request.url !== expectedPath) throw fail('unexpected provider route', 'invalid_route');
      const body = await readJsonBody(request);
      requestRecord.body_sha256 = sha256(JSON.stringify(body));
      requestRecord.advertised_tool_names = Array.isArray(body.tools)
        ? body.tools.map((tool) => plainObject(tool) && typeof tool.name === 'string'
          ? tool.name : null)
        : [];
      if (body.model !== LOOPBACK_MODEL || body.stream !== true) {
        throw fail('model and streaming fields must match exactly', 'invalid_model_request');
      }

      if (host === 'codex') {
        if (request.headers.authorization || request.headers['x-api-key']
          || request.headers['openai-api-key']) {
          throw fail('Codex loopback requests must not carry an authentication header',
            'unexpected_authentication_header');
        }
        if (requestCount === 1) {
          const tools = Array.isArray(body.tools) ? body.tools : [];
          const matches = tools.filter((tool) => plainObject(tool)
            && tool.name === 'apply_patch' && tool.type === 'custom');
          if (matches.length !== 1 || !bodyContainsExactPath(body, exactTarget)) {
            throw fail('first Codex request must advertise apply_patch and the fixed target',
              'unsupported_pinned_codex_provider_contract');
          }
          requestRecord.result = 'one_apply_patch_emitted';
          sendSse(response, firstCodexEvents(exactTarget), true);
          return;
        }
        if (!codexToolOutput(body)) {
          throw fail('second Codex request must contain the real denied tool result',
            'invalid_denied_tool_result');
        }
        requestRecord.result = 'terminal_message_emitted';
        sendSse(response, terminalCodexEvents(), true);
        return;
      }

      const apiKey = Array.isArray(request.headers['x-api-key'])
        ? request.headers['x-api-key'][0]
        : request.headers['x-api-key'];
      if (request.headers.authorization
        || !constantTimeTextEqual(apiKey || '', PUBLIC_CLAUDE_HEADER)) {
        throw fail('Claude request requires only the fixed public loopback header',
          'invalid_public_loopback_header');
      }
      if (requestCount === 1) {
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const writeTools = tools.filter((tool) => plainObject(tool) && tool.name === 'Write');
        if (tools.length !== 1 || writeTools.length !== 1
          || !bodyContainsExactPath(body.messages, exactTarget)) {
          throw fail('first Claude request must advertise only Write and the fixed target',
            'unsupported_pinned_claude_provider_contract');
        }
        requestRecord.result = 'one_write_emitted';
        sendSse(response, firstClaudeEvents(exactTarget));
        return;
      }
      if (!claudeDeniedResult(body, exactTarget)) {
        throw fail('second Claude request must contain the real denied tool result',
          'invalid_denied_tool_result');
      }
      requestRecord.result = 'terminal_message_emitted';
      sendSse(response, terminalClaudeEvents());
    } catch (error) {
      requestRecord.result = 'rejected';
      requestRecord.error = recordError(error);
      const status = error && error.code === 'request_body_too_large' ? 413 : 400;
      sendError(response, status, requestRecord.error);
    }
  });
  provider.requestTimeout = REQUEST_TIMEOUT_MS;
  provider.headersTimeout = REQUEST_TIMEOUT_MS;

  const recordProxyAttempt = (request, protocol) => {
    receipt.external_network_attempts.push({
      kind: 'external_network_attempt',
      protocol,
      method: request.method || null,
      destination: request.url || null,
      host: request.headers && request.headers.host ? request.headers.host : null,
    });
  };
  const proxy = http.createServer((request, response) => {
    recordProxyAttempt(request, 'http_proxy');
    sendError(response, 403, 'external_network_attempt');
  });
  proxy.on('connect', (request, socket) => {
    recordProxyAttempt(request, 'http_connect');
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  proxy.requestTimeout = REQUEST_TIMEOUT_MS;
  proxy.headersTimeout = REQUEST_TIMEOUT_MS;

  let origin;
  let proxyOrigin;
  try {
    [origin, proxyOrigin] = await Promise.all([listen(provider), listen(proxy)]);
  } catch (error) {
    await Promise.allSettled([closeServer(provider), closeServer(proxy)]);
    throw error;
  }

  const close = async () => {
    if (closed) return completedReceipt;
    closed = true;
    await Promise.allSettled([closeServer(provider), closeServer(proxy)]);
    receipt.completed = true;
    receipt.provider_request_count = requestCount;
    receipt.external_network_attempt_count = receipt.external_network_attempts.length;
    receipt.success = requestCount === 2
      && receipt.errors.length === 0
      && receipt.external_network_attempts.length === 0;
    writeJsonAtomic(exactReceipt, receipt);
    resolveCompleted(Object.freeze(structuredClone(receipt)));
    return completedReceipt;
  };

  return { origin, proxyOrigin, close, completedReceipt };
}

function normalizeTransportNewlines(source, label) {
  const normalized = source.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) {
    throw fail(`${label} contains a non-CRLF carriage return`, 'invalid_host_stream');
  }
  return normalized;
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw fail(`${label} must be valid UTF-8`, 'invalid_host_stream');
  }
}

function parseJsonl(rawJsonl) {
  if (typeof rawJsonl !== 'string' || !rawJsonl.endsWith('\n')) {
    throw fail('rawJsonl must contain the complete actual-host stream', 'invalid_host_stream');
  }
  const lines = rawJsonl.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw fail('rawJsonl must contain only complete nonempty JSON lines', 'invalid_host_stream');
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw fail(`rawJsonl line ${index + 1} is not JSON`, 'invalid_host_stream');
    }
  });
}

function exactCodexWarning(record, id) {
  return JSON.stringify(record) === JSON.stringify({
    type: 'item.completed',
    item: { id, type: 'error', message: PINNED_CODEX_HOOK_TRUST_WARNING },
  });
}

function validateCodexStdout(records) {
  const threadId = records[0]?.thread_id;
  if (typeof threadId !== 'string' || !threadId) {
    throw fail('Codex stdout is missing its typed thread ID', 'invalid_host_stream');
  }
  const expected = [
    { type: 'thread.started', thread_id: threadId },
    { type: 'item.completed', item: { id: 'item_0', type: 'error',
      message: PINNED_CODEX_HOOK_TRUST_WARNING } },
    { type: 'item.completed', item: { id: 'item_1', type: 'error',
      message: PINNED_CODEX_HOOK_TRUST_WARNING } },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message',
      text: 'The protected edit was denied.' } },
    { type: 'turn.completed', usage: { input_tokens: 2, cached_input_tokens: 0,
      output_tokens: 2, reasoning_output_tokens: 0 } },
  ];
  if (JSON.stringify(records) !== JSON.stringify(expected)) {
    throw fail('Codex stdout differs from the exact pinned stream grammar',
      'invalid_host_stream');
  }
  return threadId;
}

function validIsoTimestamp(timestamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/
    .exec(timestamp);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseCodexRouter(rawStderr, targetPath, threadId, rawStderrSha256) {
  let stream = normalizeTransportNewlines(rawStderr, 'Codex stderr');
  const readingPrefix = 'Reading additional input from stdin...\n';
  if (stream.startsWith(readingPrefix)) stream = stream.slice(readingPrefix.length);
  const firstNewline = stream.indexOf('\n');
  if (firstNewline === -1) {
    throw fail('Codex stderr is missing the complete router record', 'invalid_host_stream');
  }
  const header = stream.slice(0, firstNewline);
  const timestampEnd = header.indexOf(' ');
  const timestamp = timestampEnd === -1 ? '' : header.slice(0, timestampEnd);
  if (!validIsoTimestamp(timestamp)) {
    throw fail('Codex router timestamp is not an exact valid ISO UTC timestamp',
      'invalid_host_stream');
  }
  const marker = ' ERROR codex_core::tools::router: error=Command blocked by PreToolUse hook: '
    + `${PINNED_CODEX_GUARD_DENIAL}. Command: *** Begin Patch`;
  if (header !== `${timestamp}${marker}`) {
    throw fail('Codex stderr differs from the exact pinned router denial',
      'invalid_host_stream');
  }
  const command = [
    '*** Begin Patch',
    `*** Update File: ${targetPath}`,
    '@@',
    '-before',
    '+after',
    '*** End Patch',
  ].join('\n');
  const expectedTail = `${command.split('\n').slice(1).join('\n')}\n`;
  if (stream.slice(firstNewline + 1) !== expectedTail) {
    throw fail('Codex stderr patch body differs from the exact calculated target',
      'invalid_host_stream');
  }
  const provenance = {
    source: 'actual_exact_pinned_host_stderr',
    raw_stderr_sha256: rawStderrSha256,
  };
  return {
    attempt: {
      thread_id: threadId,
      tool_name: 'apply_patch',
      tool_input: { command },
      provenance: { ...provenance },
    },
    denial: {
      thread_id: threadId,
      type: 'hook_denial',
      message: PINNED_CODEX_GUARD_DENIAL,
      provenance: { ...provenance },
    },
  };
}

function exactClaudeWriteInput(value, targetPath) {
  return plainObject(value)
    && Object.keys(value).length === 2
    && value.file_path === targetPath
    && value.content === 'after';
}

function parseClaudeLifecycle(records, targetPath, rawStreamSha256) {
  const invalid = () => {
    throw fail('actual host stream differs from the exact pinned Claude lifecycle',
      'invalid_host_stream');
  };
  if (!Array.isArray(records) || records.length !== 7) invalid();
  const [init, firstAssistant, hookStarted, hookResponse, userResult,
    terminalAssistant, result] = records;
  const sessionId = init && init.session_id;
  const projectRoot = path.dirname(path.dirname(path.dirname(targetPath)));
  if (typeof sessionId !== 'string' || !sessionId
    || records.some((record) => !plainObject(record) || record.session_id !== sessionId)
    || init.type !== 'system' || init.subtype !== 'init' || init.cwd !== projectRoot
    || !Array.isArray(init.tools) || init.tools.length !== 1 || init.tools[0] !== 'Write'
    || init.model !== LOOPBACK_MODEL || init.permissionMode !== 'bypassPermissions'
    || init.claude_code_version !== '2.1.207'
    || !Array.isArray(init.plugins) || init.plugins.length !== 1
    || !plainObject(init.plugins[0]) || init.plugins[0].name !== 'deep-evolve'
    || init.plugins[0].source !== 'deep-evolve@deep-evolve-loopback') invalid();

  const firstMessage = firstAssistant.message;
  const firstContent = plainObject(firstMessage) && Array.isArray(firstMessage.content)
    ? firstMessage.content : [];
  const toolUse = firstContent[0];
  if (firstAssistant.type !== 'assistant' || !plainObject(firstMessage)
    || firstMessage.id !== 'msg_loopback_1' || firstMessage.type !== 'message'
    || firstMessage.role !== 'assistant' || firstMessage.model !== LOOPBACK_MODEL
    || firstMessage.stop_reason !== null || firstContent.length !== 1
    || !plainObject(toolUse) || toolUse.type !== 'tool_use' || toolUse.name !== 'Write'
    || toolUse.id !== CLAUDE_TOOL_ID || !exactClaudeWriteInput(toolUse.input, targetPath)) invalid();

  const hookId = hookStarted.hook_id;
  if (hookStarted.type !== 'system' || hookStarted.subtype !== 'hook_started'
    || typeof hookId !== 'string' || !hookId
    || hookStarted.hook_name !== 'PreToolUse:Write'
    || hookStarted.hook_event !== 'PreToolUse') invalid();
  const hookOutput = `${PINNED_CODEX_GUARD_DENIAL}\n`;
  if (hookResponse.type !== 'system' || hookResponse.subtype !== 'hook_response'
    || hookResponse.hook_id !== hookId || hookResponse.hook_name !== 'PreToolUse:Write'
    || hookResponse.hook_event !== 'PreToolUse' || hookResponse.output !== hookOutput
    || hookResponse.stdout !== '' || hookResponse.stderr !== hookOutput
    || hookResponse.exit_code !== 2 || hookResponse.outcome !== 'error') invalid();

  const toolResultText = `PreToolUse:Write hook error: [node \${CLAUDE_PLUGIN_ROOT}`
    + `/hooks/scripts/protect-readonly.cjs]: ${hookOutput}`;
  const userMessage = userResult.message;
  const userContent = plainObject(userMessage) && Array.isArray(userMessage.content)
    ? userMessage.content : [];
  const deniedResult = userContent[0];
  if (userResult.type !== 'user' || !plainObject(userMessage) || userMessage.role !== 'user'
    || userContent.length !== 1 || !plainObject(deniedResult)
    || deniedResult.type !== 'tool_result' || deniedResult.tool_use_id !== CLAUDE_TOOL_ID
    || deniedResult.is_error !== true || deniedResult.content !== toolResultText
    || userResult.tool_use_result !== `Error: ${toolResultText}`) invalid();

  const terminalMessage = terminalAssistant.message;
  const terminalContent = plainObject(terminalMessage) && Array.isArray(terminalMessage.content)
    ? terminalMessage.content : [];
  if (terminalAssistant.type !== 'assistant' || !plainObject(terminalMessage)
    || terminalMessage.id !== 'msg_loopback_2' || terminalMessage.type !== 'message'
    || terminalMessage.role !== 'assistant' || terminalMessage.model !== LOOPBACK_MODEL
    || terminalMessage.stop_reason !== null || terminalContent.length !== 1
    || !plainObject(terminalContent[0]) || terminalContent[0].type !== 'text'
    || terminalContent[0].text !== 'The protected edit was denied.') invalid();

  const permissionDenials = Array.isArray(result.permission_denials)
    ? result.permission_denials : [];
  const terminalDenial = permissionDenials[0];
  if (result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false
    || result.result !== 'The protected edit was denied.' || result.stop_reason !== 'end_turn'
    || result.terminal_reason !== 'completed' || permissionDenials.length !== 1
    || !plainObject(terminalDenial) || terminalDenial.tool_name !== 'Write'
    || terminalDenial.tool_use_id !== CLAUDE_TOOL_ID
    || !exactClaudeWriteInput(terminalDenial.tool_input, targetPath)) invalid();

  const objects = allObjects(records);
  if (objects.filter((value) => value.type === 'tool_use').length !== 1
    || objects.filter((value) => value.type === 'tool_result').length !== 1
    || objects.filter((value) => value.subtype === 'hook_started').length !== 1
    || objects.filter((value) => value.subtype === 'hook_response').length !== 1
    || objects.filter((value) => Object.hasOwn(value, 'tool_name')
      && Object.hasOwn(value, 'tool_use_id') && Object.hasOwn(value, 'tool_input')).length !== 1) {
    invalid();
  }

  const provenance = {
    source: 'actual_exact_pinned_host_stdout',
    raw_stream_sha256: rawStreamSha256,
  };
  return {
    attempt: {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: targetPath, content: 'after' },
      provenance: { ...provenance },
    },
    denial: {
      session_id: sessionId,
      type: 'hook_denial',
      message: PINNED_CODEX_GUARD_DENIAL,
      provenance: { ...provenance },
    },
  };
}

function replaceLiteral(source, from, to) {
  return from ? source.split(from).join(to) : source;
}

function normalizeValue(value, replacements, typedIds = new Map()) {
  if (typeof value === 'string') {
    let output = value;
    for (const [from, to] of replacements) output = replaceLiteral(output, from, to);
    for (const placeholder of ['{{SESSION_ROOT}}', '{{PROJECT_ROOT}}']) {
      output = replaceLiteral(output, `${placeholder}\\`, `${placeholder}/`);
    }
    return output;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, replacements, typedIds));
  }
  if (plainObject(value)) return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => {
      const typed = typedIds.get(key);
      if (typed && item === typed.value) return [key, typed.placeholder];
      return [key, normalizeValue(item, replacements, typedIds)];
    }));
  return value;
}

function recordHasTool(record, host, targetPath) {
  return allObjects(record).some((value) => {
    const toolName = value.tool_name;
    const input = value.tool_input;
    if (host === 'codex') {
      const command = plainObject(input) ? input.command : null;
      return toolName === 'apply_patch' && typeof command === 'string'
        && command === [
          '*** Begin Patch',
          `*** Update File: ${targetPath}`,
          '@@',
          '-before',
          '+after',
          '*** End Patch',
        ].join('\n');
    }
    return value.hook_event_name === 'PreToolUse' && toolName === 'Write' && plainObject(input)
      && input.file_path === targetPath
      && input.content === 'after';
  });
}

function recordHasDenial(record) {
  const serialized = JSON.stringify(record);
  return /Deep Evolve Guard/.test(serialized) && /(?:denied|block|protect)/i.test(serialized);
}

function recordHasHostToolEnvelope(record) {
  return allObjects(record).some((value) => typeof value.tool_name === 'string'
    && plainObject(value.tool_input));
}

function recordIsUnexplainedError(record) {
  if (recordHasDenial(record)) return false;
  return allObjects(record).some((value) => value.type === 'error'
    || (value.error !== null && value.error !== undefined)
    || ['failed', 'failure'].includes(String(value.status || '').toLowerCase()));
}

function collectTypedSessionIds(value, host, output = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) collectTypedSessionIds(item, host, output);
    return output;
  }
  if (!plainObject(value)) return output;
  const labels = host === 'codex'
    ? new Map([['thread_id', 'CODEX_THREAD_ID'], ['threadId', 'CODEX_THREAD_ID']])
    : new Map([['session_id', 'CLAUDE_SESSION_ID'], ['sessionId', 'CLAUDE_SESSION_ID']]);
  for (const [key, item] of Object.entries(value)) {
    const label = labels.get(key);
    if (label && typeof item === 'string' && item && item !== 'session-current') {
      if (output.has(label) && output.get(label) !== item) {
        throw fail(`multiple ephemeral IDs found for ${label}`, 'invalid_host_stream');
      }
      output.set(label, item);
    }
    collectTypedSessionIds(item, host, output);
  }
  return output;
}

function typedSessionFields(host, typedIds) {
  const fields = host === 'codex'
    ? new Map([['thread_id', 'CODEX_THREAD_ID'], ['threadId', 'CODEX_THREAD_ID']])
    : new Map([['session_id', 'CLAUDE_SESSION_ID'], ['sessionId', 'CLAUDE_SESSION_ID']]);
  const output = new Map();
  for (const [key, label] of fields) {
    if (!typedIds.has(label)) continue;
    output.set(key, {
      value: typedIds.get(label),
      placeholder: `{{${label}}}`,
    });
  }
  return output;
}

function assertProtectedNormalization(host, attempt, denial) {
  const attemptText = JSON.stringify(attempt);
  const denialText = JSON.stringify(denial);
  const protectedAttempt = host === 'codex'
    ? /apply_patch/.test(attemptText)
    : /PreToolUse/.test(attemptText) && /Write/.test(attemptText);
  const protectedTarget = host === 'codex' ? /prepare\.cjs/.test(attemptText)
    : /program\.md/.test(attemptText);
  if (!protectedAttempt || !protectedTarget
    || !/Deep Evolve Guard/.test(denialText)
    || !/(?:denied|block|protect)/i.test(denialText)) {
    throw fail('normalization changed a protected host contract discriminator',
      'invalid_host_stream');
  }
}

function validateEvidence(host, evidence) {
  if (!plainObject(evidence)) throw fail('evidence must be an object', 'invalid_provenance');
  for (const key of ['session_ids', 'provenance', 'replacement', 'replacements',
    'attempt', 'denial']) {
    if (Object.hasOwn(evidence, key)) {
      const label = key === 'session_ids' ? 'session ID normalization' : key;
      throw fail(`caller-supplied ${label} is forbidden`, 'invalid_provenance');
    }
  }
  const version = host === 'codex' ? '0.144.1' : '2.1.207';
  const exact = {
    host,
    version,
    capture_source: CAPTURE_SOURCE,
    model_source: MODEL_SOURCE,
    vendor_cloud_entitlement_proven: false,
    run_attempt: 1,
    same_head_rerun: false,
  };
  for (const [key, value] of Object.entries(exact)) {
    if (evidence[key] !== value) throw fail(`invalid provenance field: ${key}`, 'invalid_provenance');
  }
  for (const [key, pattern] of [
    ['bootstrap_commit', /^[0-9a-f]{40}$/],
    ['driver_sha256', /^[0-9a-f]{64}$/],
    ['raw_stream_sha256', /^[0-9a-f]{64}$/],
    ['raw_stderr_sha256', /^[0-9a-f]{64}$/],
  ]) {
    if (!pattern.test(String(evidence[key] || ''))) {
      throw fail(`invalid provenance field: ${key}`, 'invalid_provenance');
    }
  }
  if (!String(evidence.run_id || '') || !String(evidence.job_id || '')) {
    throw fail('run_id and job_id are required', 'invalid_provenance');
  }
  if (!Buffer.isBuffer(evidence.raw_stream_bytes)
    || !Buffer.isBuffer(evidence.raw_stderr_bytes)) {
    throw fail('raw stdout and stderr evidence must be Buffers', 'invalid_provenance');
  }
  if (evidence.raw_stream_sha256 !== sha256(evidence.raw_stream_bytes)
    || evidence.raw_stderr_sha256 !== sha256(evidence.raw_stderr_bytes)) {
    throw fail('raw stdout or stderr hash is not authenticated', 'invalid_provenance');
  }
  if (evidence.attempt_count !== 1 || evidence.denial_count !== 1
    || evidence.successful_mutation_count !== 0) {
    throw fail('attempt, denial, and mutation counts are invalid', 'invalid_provenance');
  }
}

function normalizeActualHostRecords({ host, rawStdout, rawStderr, isolatedRoot, evidence }) {
  if (!['codex', 'claude'].includes(host)) throw fail('host must be codex or claude');
  const exactRoot = requireAbsolutePath(isolatedRoot, 'isolatedRoot');
  validateEvidence(host, evidence);
  if (!Buffer.isBuffer(rawStdout) || !Buffer.isBuffer(rawStderr)) {
    throw fail('raw stdout and stderr inputs must be Buffers', 'invalid_provenance');
  }
  if (!evidence.raw_stream_bytes.equals(rawStdout)
    || !evidence.raw_stderr_bytes.equals(rawStderr)) {
    throw fail('raw stdout or stderr bytes differ from authenticated evidence',
      'invalid_provenance');
  }
  const decodedStdout = normalizeTransportNewlines(decodeUtf8(rawStdout, 'raw stdout'),
    'raw stdout');
  const decodedStderr = normalizeTransportNewlines(decodeUtf8(rawStderr, 'raw stderr'),
    'raw stderr');
  let records = parseJsonl(decodedStdout);
  const sessionRoot = requireAbsolutePath(evidence.session_root, 'evidence.session_root');
  const sessionRelative = path.relative(exactRoot, sessionRoot);
  if (!sessionRelative || sessionRelative === '..' || sessionRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(sessionRelative)) {
    throw fail('evidence.session_root must be a child of isolatedRoot', 'invalid_provenance');
  }
  const targetPath = path.join(sessionRoot, host === 'codex' ? 'prepare.cjs' : 'program.md');
  if (host === 'claude' && rawStderr.length !== 0) {
    throw fail('Claude stderr must be empty for the exact pinned host stream',
      'invalid_host_stream');
  }
  if (host === 'codex') {
    const threadId = validateCodexStdout(records);
    const derived = parseCodexRouter(decodedStderr, targetPath, threadId,
      evidence.raw_stderr_sha256);
    records = [...records, derived.attempt, derived.denial];
  }
  const claudeDerived = host === 'claude'
    ? parseClaudeLifecycle(records, targetPath, evidence.raw_stream_sha256) : null;
  const attempts = claudeDerived ? [claudeDerived.attempt]
    : records.filter((record) => recordHasTool(record, host, targetPath));
  const denials = claudeDerived ? [claudeDerived.denial] : records.filter(recordHasDenial);
  const hostToolEnvelopes = claudeDerived ? [claudeDerived.attempt]
    : records.filter(recordHasHostToolEnvelope);
  const unexplainedErrors = records.filter((record) => {
    if (host === 'codex'
      && (exactCodexWarning(record, 'item_0') || exactCodexWarning(record, 'item_1'))) {
      return false;
    }
    return recordIsUnexplainedError(record);
  });
  const successfulMutation = records.some((record) => allObjects(record)
    .some((value) => value.mutation_succeeded === true));
  if (attempts.length !== 1 || denials.length !== 1 || hostToolEnvelopes.length !== 1
    || unexplainedErrors.length !== 0 || successfulMutation) {
    throw fail('actual host stream must retain exactly one attempt and one denial',
      'invalid_host_stream');
  }

  const replacements = [[exactRoot, '{{PROJECT_ROOT}}']];
  const normalizationMap = { project_root: '{{PROJECT_ROOT}}' };
  replacements.unshift([sessionRoot, '{{SESSION_ROOT}}']);
  normalizationMap.session_root = '{{SESSION_ROOT}}';
  const typedIds = collectTypedSessionIds(records, host);
  for (const [label, sessionId] of typedIds) {
    const placeholder = `{{${label}}}`;
    normalizationMap[label.toLowerCase()] = placeholder;
  }
  const typedFields = typedSessionFields(host, typedIds);
  const normalizedAttempt = normalizeValue(attempts[0], replacements, typedFields);
  const normalizedDenial = normalizeValue(denials[0], replacements, typedFields);
  assertProtectedNormalization(host, normalizedAttempt, normalizedDenial);

  const acceptedEventPaths = {
    host,
    version: evidence.version,
    capture_source: CAPTURE_SOURCE,
    model_source: MODEL_SOURCE,
    bootstrap_commit: evidence.bootstrap_commit,
    run_id: evidence.run_id,
    job_id: evidence.job_id,
    run_attempt: 1,
    same_head_rerun: false,
    driver_sha256: evidence.driver_sha256,
    raw_stream_sha256: evidence.raw_stream_sha256,
    raw_stderr_sha256: evidence.raw_stderr_sha256,
    normalization_map: normalizationMap,
    accepted_pointers: [...ACCEPTED_POINTERS[host]],
    attempt_count: 1,
    denial_count: 1,
    successful_mutation_count: 0,
    vendor_cloud_entitlement_proven: false,
  };
  return {
    attempt: normalizedAttempt,
    denial: normalizedDenial,
    acceptedEventPaths,
  };
}

module.exports = {
  LOOPBACK_MODEL,
  PUBLIC_CLAUDE_HEADER,
  createLoopbackDriver,
  buildCodexModelCatalog,
  validateCodexModelCatalog,
  buildCodexConfig,
  buildIsolatedHostEnv,
  directoryFileUrl,
  normalizeActualHostRecords,
};
