#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(resolve(root, '.mcp.json'), 'utf8'));
const [app, settings] = Object.entries(config.mcpServers)[0];
const env = { ...process.env, ...settings.env };
for (const key of settings.env_vars || []) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
const client = new Client({ name: 'Codex Plugin Verification', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [resolve(root, 'scripts/bridge.mjs')],
  cwd: root, env, stderr: 'inherit',
});
const timer = setTimeout(() => {
  console.error('Connection test timed out. Check that the app is open and its MCP server is enabled.');
  void transport.close().finally(() => process.exit(1));
}, 55000);
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  if (!tools.some(tool => tool.name === 'execute_script')) throw new Error('Native scripting tool not found.');
  const docs = await client.callTool(app === 'cavalry'
    ? { name: 'read_preamble', arguments: {} }
    : { name: 'read_sdk_documentation_topic', arguments: { filename: 'preamble' } });
  if (docs.isError) throw new Error('Unable to read native documentation.');
  const marker = `Codex ${app} connection verified`;
  const script = `console.log(${JSON.stringify(marker)});`;
  if (app === 'cavalry') {
    const check = await client.callTool({ name: 'preflight_script', arguments: { script } });
    if (check.isError) throw new Error('Harmless test script did not compile.');
  }
  const result = await client.callTool({ name: 'execute_script', arguments: { script } });
  if (result.isError || !JSON.stringify(result).includes(marker)) throw new Error('Script execution was not confirmed.');
  console.log(JSON.stringify({ app, server: client.getServerVersion(), toolCount: tools.length,
    documentationRead: true, harmlessScriptVerified: true }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.close();
}
