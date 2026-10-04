#!/usr/bin/env node
// Pass through the app's own tools, resources, prompts, and protocol messages.
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { createMotionHandler, motionToolDefinitions } from './motion-tools.mjs';

const app = process.env.CREATIVE_MCP_APP || 'Cavalry';
const override = process.env[`${app.toUpperCase()}_MCP_PORT`];
const port = Number(override || process.env.CREATIVE_MCP_PORT || 6768);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[${app}] MCP port must be an integer between 1 and 65535.`);
  process.exit(1);
}

const headers = app === 'Cavalry' ? {
  'X-Cavalry-MCP-Fingerprint': process.env.CREATIVE_MCP_FINGERPRINT || 'codex-cavalry-local-plugin-v1',
  'X-Cavalry-MCP-Client-Name': 'Codex',
  'X-Cavalry-MCP-Client-Version': '0.2.0',
} : {};
const endpoint = new URL(`http://127.0.0.1:${port}/sse`);
const remote = new SSEClientTransport(endpoint, {
  requestInit: { headers },
  eventSourceInit: { fetch: (url, init) => {
    const merged = new Headers(init?.headers);
    for (const [key, value] of Object.entries(headers)) merged.set(key, value);
    return fetch(url, { ...init, headers: merged });
  } },
});
const local = new StdioServerTransport();
let closing = false;
const pendingNative = new Map();
const pendingToolLists = new Set();
const internalPrefix = `codex-motion-${randomUUID()}-`;
let internalSequence = 0;

const callNative = (name, args) => new Promise((resolve, reject) => {
  const id = `${internalPrefix}${++internalSequence}`;
  const timer = setTimeout(() => {
    pendingNative.delete(id);
    reject(new Error(`${name} timed out. The result may be unknown.`));
  }, 175000);
  pendingNative.set(id, { resolve, reject, timer });
  remote.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
    .catch(error => {
      clearTimeout(timer);
      pendingNative.delete(id);
      reject(error);
    });
});
const handleMotion = createMotionHandler(callNative);

const shutdown = async (code = 0) => {
  if (closing) return;
  closing = true;
  clearTimeout(startupTimer);
  for (const pending of pendingNative.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Cavalry connection closed.'));
  }
  pendingNative.clear();
  await Promise.allSettled([remote.close(), local.close()]);
  process.exit(code);
};
const failure = (error) => {
  if (closing) return;
  console.error(`[${app}] MCP connection failed. Keep ${app} open, enable its MCP server, and check port ${port}. ${error.message}`);
  void shutdown(1);
};
remote.onmessage = (message) => {
  if ('id' in message && pendingNative.has(message.id)) {
    const pending = pendingNative.get(message.id);
    pendingNative.delete(message.id);
    clearTimeout(pending.timer);
    if ('error' in message) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
    return;
  }
  if ('id' in message && typeof message.id === 'string' && message.id.startsWith(internalPrefix)) return;
  if ('id' in message && pendingToolLists.has(message.id)) {
    pendingToolLists.delete(message.id);
    if ('result' in message && Array.isArray(message.result?.tools)) {
      message = { ...message, result: { ...message.result,
        tools: [...message.result.tools, ...motionToolDefinitions] } };
    }
  }
  void local.send(message).catch(failure);
};
local.onmessage = (message) => {
  if (message.method === 'tools/list' && message.id !== undefined && !message.params?.cursor) {
    pendingToolLists.add(message.id);
  }
  if (message.method === 'tools/call' &&
      motionToolDefinitions.some(tool => tool.name === message.params?.name)) {
    void handleMotion(message.params.name, message.params.arguments).then(result =>
      local.send({ jsonrpc: '2.0', id: message.id, result })).catch(failure);
    return;
  }
  void remote.send(message).catch(failure);
};
remote.onerror = failure;
local.onerror = failure;
remote.onclose = () => { void shutdown(); };
local.onclose = () => { void shutdown(); };
process.stdin.on('end', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
const startupTimer = setTimeout(() => {
  failure(new Error('Connection timed out. If the app shows a connection prompt, allow the Codex connection you requested.'));
}, 55000);

try {
  await remote.start();
  clearTimeout(startupTimer);
  await local.start();
} catch (error) {
  failure(error);
}
