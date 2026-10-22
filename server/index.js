#!/usr/bin/env node
/**
 * tialink-mcp — a stdio ↔ Streamable HTTP bridge for TiaLink.
 *
 * Why this exists
 * ---------------
 * TiaLink is a TIA Portal MCP gateway that speaks **Streamable HTTP** on
 * `http://<gateway-host>:<port>/mcp`. Several MCP clients (and every `.mcpb`
 * desktop bundle) can only launch **stdio** servers. This bridge connects the
 * two: it reads newline-delimited JSON-RPC on stdin, forwards each message to
 * the gateway over HTTP, and writes the gateway's replies back to stdout.
 *
 * It is a transport adapter and nothing else. It does not contain, wrap,
 * reimplement or unlock TiaLink — a licensed TiaLink installation with a
 * running gateway is a hard prerequisite.
 *
 * Configuration (environment variables)
 * -------------------------------------
 *   TIALINK_URL         Gateway endpoint. Default: http://127.0.0.1:8080/mcp
 *   TIALINK_TOKEN       Bearer token, if the gateway was configured with one.
 *   TIALINK_TIMEOUT_MS  Per-request timeout. Default: 600000 (10 min).
 *                       Compile / download / simulation calls can be slow;
 *                       keep this generous.
 *   TIALINK_QUIET       Set to "1" to silence diagnostic logs on stderr.
 *
 * Usage
 * -----
 *   npx tialink-mcp                 # run the bridge (what MCP clients call)
 *   npx tialink-mcp --check         # pre-flight: connect, list tools, report
 *   npx tialink-mcp --help
 *
 * stdout carries the MCP protocol. All diagnostics go to stderr, so they can
 * never corrupt the stream.
 *
 * License
 * -------
 * MIT — see ../LICENSE-BRIDGE. That license covers this bridge and its
 * packaging only. The TiaLink engine itself is commercial software and is
 * not covered by it; the repository documentation is CC BY 4.0 (../LICENSE).
 */

'use strict';

const VERSION = '0.1.0';
const DEFAULT_URL = 'http://127.0.0.1:8080/mcp';
const DEFAULT_TIMEOUT_MS = 600000;

const cfg = {
  url: process.env.TIALINK_URL || DEFAULT_URL,
  token: process.env.TIALINK_TOKEN || '',
  timeoutMs: Number.parseInt(process.env.TIALINK_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS,
  quiet: process.env.TIALINK_QUIET === '1',
};

function log(...args) {
  if (!cfg.quiet) process.stderr.write('[tialink-mcp] ' + args.join(' ') + '\n');
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

let sessionId = null;
let protocolVersion = null;

function endpointSummary() {
  try {
    const u = new URL(cfg.url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return cfg.url;
  }
}

async function gatewayFetch(body, { signal } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;

  return fetch(cfg.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

/** AbortSignal that fires after the configured timeout, plus the timer to clear. */
function requestSignal() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

// ---------------------------------------------------------------------------
// Server-Sent Events: the gateway may answer a request with text/event-stream
// ---------------------------------------------------------------------------

function sseChunkToMessages(chunk) {
  const dataLines = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return [];
  const payload = dataLines.join('\n').trim();
  if (!payload) return [];
  try {
    return [JSON.parse(payload)];
  } catch {
    log('ignoring unparsable SSE payload:', payload.slice(0, 120));
    return [];
  }
}

/**
 * Drain an SSE response, emitting each message. `onMessage` returns true once
 * the caller has what it needs, and the stream is cancelled at that point
 * instead of being left open.
 */
async function drainSse(response, onMessage) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const msg of sseChunkToMessages(chunk)) {
          if (onMessage(msg)) return;
        }
      }
    }
    if (buffer.trim()) {
      for (const msg of sseChunkToMessages(buffer)) onMessage(msg);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// One JSON-RPC message in, zero or more messages out
// ---------------------------------------------------------------------------

function hasId(msg) {
  return Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null && msg.id !== undefined;
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleMessage(msg) {
  const isRequest = hasId(msg);

  if (msg.method === 'initialize' && msg.params && typeof msg.params.protocolVersion === 'string') {
    protocolVersion = msg.params.protocolVersion;
  }

  const { signal, done } = requestSignal();
  try {
    const response = await gatewayFetch(msg, { signal });

    const returnedSession = response.headers.get('mcp-session-id');
    if (returnedSession) sessionId = returnedSession;

    // 202 = accepted notification, 204 = no content. Nothing to forward.
    if (response.status === 202 || response.status === 204) return;

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `gateway returned HTTP ${response.status} ${response.statusText}` +
          (detail ? ` — ${detail.slice(0, 300)}` : '')
      );
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    if (contentType.includes('text/event-stream')) {
      await drainSse(response, (out) => {
        send(out);
        return isRequest && out && out.id === msg.id;
      });
      return;
    }

    const text = await response.text();
    if (!text.trim()) return;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`gateway returned non-JSON body: ${text.slice(0, 200)}`);
    }
    if (Array.isArray(parsed)) parsed.forEach(send);
    else send(parsed);
  } catch (error) {
    const reason = error && error.name === 'AbortError'
      ? `gateway did not answer within ${cfg.timeoutMs} ms`
      : String((error && error.message) || error);

    if (isRequest) {
      send(rpcError(msg.id, -32603, `${reason} (endpoint: ${endpointSummary()})`));
    }
    log(`request failed: ${reason}`);
  } finally {
    done();
  }
}

// ---------------------------------------------------------------------------
// stdin: newline-delimited JSON-RPC
// ---------------------------------------------------------------------------

function runBridge() {
  let buffer = '';

  // Requests may overlap (the client matches replies by id), but stdin closing
  // must not truncate them — so every in-flight handler is tracked and awaited
  // before the process exits.
  const inFlight = new Set();

  const dispatch = (msg) => {
    const promise = handleMessage(msg).finally(() => inFlight.delete(promise));
    inFlight.add(promise);
  };

  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send(rpcError(null, -32700, 'Parse error: stdin line is not valid JSON'));
        continue;
      }
      dispatch(msg);
    }
  });

  process.stdin.on('end', async () => {
    if (buffer.trim()) {
      try {
        dispatch(JSON.parse(buffer));
      } catch {
        send(rpcError(null, -32700, 'Parse error: trailing input is not valid JSON'));
      }
    }
    buffer = '';

    if (inFlight.size > 0) {
      log(`stdin closed, waiting for ${inFlight.size} in-flight request(s)`);
      await Promise.allSettled([...inFlight]);
    }
    log('stdin closed, exiting');
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// --check: does a reachable, authenticated gateway actually answer?
// ---------------------------------------------------------------------------

async function runCheck() {
  log(`bridge ${VERSION} -> ${endpointSummary()}`);

  const { signal, done } = requestSignal();
  try {
    const response = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'tialink-mcp --check', version: VERSION },
        },
      }),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`✗ gateway responded HTTP ${response.status} ${response.statusText}`);
      if (response.status === 401 || response.status === 403) {
        console.error('  Auth rejected — check TIALINK_TOKEN (the header must be "Authorization: Bearer <token>").');
      }
      if (response.status === 404) {
        console.error('  Wrong path — the MCP endpoint is /mcp, not the host root.');
      }
      if (detail) console.error('  ' + detail.slice(0, 300));
      process.exitCode = 1;
      return;
    }

    const sid = response.headers.get('mcp-session-id');
    if (sid) sessionId = sid;

    let info = null;
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
      await drainSse(response, (msg) => {
        if (msg && msg.id === 1) { info = msg; return true; }
        return false;
      });
    } else {
      info = JSON.parse(await response.text());
    }

    if (info && info.error) {
      console.error('✗ gateway rejected initialize:', info.error.message);
      process.exitCode = 1;
      return;
    }

    const result = (info && info.result) || {};
    const server = result.serverInfo || {};
    console.log('✓ gateway reachable');
    console.log(`  server      : ${server.name || '(unnamed)'} ${server.version || ''}`.trimEnd());
    console.log(`  protocol    : ${result.protocolVersion || protocolVersion || '(not reported)'}`);
    console.log(`  capabilities: ${Object.keys(result.capabilities || {}).join(', ') || '(none reported)'}`);
    if (sid) console.log(`  session id  : ${sid}`);

    const tools = (result.capabilities || {}).tools;
    if (tools) {
      const listSignal = requestSignal();
      try {
        const listed = await gatewayFetch(
          { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
          { signal: listSignal.signal }
        );
        if (listed.ok) {
          const body = (listed.headers.get('content-type') || '').includes('text/event-stream')
            ? await (async () => {
                let found = null;
                await drainSse(listed, (msg) => {
                  if (msg && msg.id === 2) { found = msg; return true; }
                  return false;
                });
                return found;
              })()
            : JSON.parse(await listed.text());
          const list = (body && body.result && body.result.tools) || [];
          console.log(`  tools       : ${list.length}`);
          for (const tool of list.slice(0, 40)) {
            console.log(`    - ${tool.name}`);
          }
          if (list.length > 40) console.log(`    ... and ${list.length - 40} more`);
        }
      } finally {
        listSignal.done();
      }
    }
  } catch (error) {
    const reason = error && error.name === 'AbortError'
      ? `no answer within ${cfg.timeoutMs} ms`
      : String((error && error.message) || error);
    console.error(`✗ cannot reach ${endpointSummary()} — ${reason}`);
    console.error('  Is TiaLink installed and is its gateway running on this machine?');
    console.error('  Set TIALINK_URL if the gateway listens on another host or port.');
    process.exitCode = 1;
  } finally {
    done();
  }
}

// ---------------------------------------------------------------------------

function printHelp() {
  const lines = [
    `tialink-mcp ${VERSION} — stdio <-> Streamable HTTP bridge for TiaLink`,
    '',
    'This package is a transport adapter only. It needs a licensed, running',
    'TiaLink gateway; it does not include the gateway.',
    '',
    'Usage:',
    '  tialink-mcp              run the bridge (MCP clients launch this)',
    '  tialink-mcp --check      connect to the gateway and report tools',
    '  tialink-mcp --help       show this text',
    '  tialink-mcp --version    print the version',
    '',
    'Environment:',
    `  TIALINK_URL         gateway endpoint (default ${DEFAULT_URL})`,
    '  TIALINK_TOKEN       bearer token, if the gateway requires one',
    `  TIALINK_TIMEOUT_MS  per-request timeout (default ${DEFAULT_TIMEOUT_MS})`,
    '  TIALINK_QUIET       set to 1 to silence stderr diagnostics',
    '',
    'Example:',
    '  TIALINK_URL=http://192.168.1.78:8080/mcp TIALINK_TOKEN=... npx tialink-mcp --check',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(VERSION + '\n');
    return;
  }
  if (argv.includes('--check')) {
    await runCheck();
    return;
  }
  log(`${VERSION} -> ${endpointSummary()}${cfg.token ? ' (token set)' : ''}`);
  runBridge();
}

main().catch((error) => {
  log('fatal:', String((error && error.stack) || error));
  process.exit(1);
});
