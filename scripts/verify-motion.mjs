#!/usr/bin/env node
// Live integration check. Creates two temporary Null layers and removes them in finally.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const settings = JSON.parse(await readFile(resolve(root, '.mcp.json'), 'utf8')).mcpServers.cavalry;
const env = { ...process.env, ...settings.env };
for (const key of settings.env_vars || []) if (process.env[key] !== undefined) env[key] = process.env[key];
const client = new Client({ name: 'Cavalry Motion Verification', version: '0.2.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [resolve(root, 'scripts/bridge.mjs')], cwd: root, env, stderr: 'inherit',
});
const prefix = `Codex Motion Check ${randomUUID().slice(0, 8)}`;
let scratchIds = [];
let range;

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return result;
}

function output(result) {
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

function marked(result, marker) {
  const text = output(result);
  const index = text.lastIndexOf(marker);
  if (index < 0) throw new Error(`Missing ${marker} in Cavalry output.`);
  return JSON.parse(text.slice(index + marker.length).split(/\r?\n/)[0]);
}

async function motion(action, options) {
  const plan = JSON.parse(output(await call('codex_motion_plan', { action, ...options })));
  if (!plan.planId) throw new Error(`No ${action} plan ID.`);
  const applied = JSON.parse(output(await call('codex_motion_apply', { planId: plan.planId })));
  if (!applied.ok) throw new Error(`${action} did not apply: ${JSON.stringify(applied)}`);
  return applied;
}

try {
  await client.connect(transport);
  console.log('Connected to Cavalry bridge.');
  await call('read_preamble');
  console.log('Read Cavalry preamble.');
  const inspectedRange = await call('execute_script', { script: `
    const comp = api.getActiveComp();
    console.log('CODEX_COMP_RANGE:' + JSON.stringify({
      start: api.get(comp, 'startFrame'), end: api.get(comp, 'endFrame')
    }));
  ` });
  range = marked(inspectedRange, 'CODEX_COMP_RANGE:');
  if (range.end - range.start < 50) throw new Error('Open a composition with at least 51 frames for the motion check.');
  const firstFrame = range.start + 10;
  const lastFrame = range.start + 20;
  const created = await call('execute_script', { script: `
    const first = api.create('null', ${JSON.stringify(prefix + ' A')});
    const second = api.create('null', ${JSON.stringify(prefix + ' B')});
    for (const id of [first, second]) {
      api.keyframe(id, ${firstFrame}, { 'position.x': 0 });
      api.keyframe(id, ${lastFrame}, { 'position.x': 100 });
      api.magicEasing(id, 'position.x', ${firstFrame}, 'SlowInSlowOut');
    }
    console.log('CODEX_SCRATCH_IDS:' + JSON.stringify([first, second]));
  ` });
  scratchIds = marked(created, 'CODEX_SCRATCH_IDS:');
  await motion('stagger', { layerIds: scratchIds, stepFrames: 3 });
  await motion('retime', { layerIds: scratchIds, factor: 2 });
  const loop = await motion('loop', { layerIds: [scratchIds[0]] });
  if (!loop.valuesMatch) throw new Error('Loop closure values do not match.');
  const inspected = await call('execute_script', { script: `
    const ids = ${JSON.stringify(scratchIds)};
    console.log('CODEX_MOTION_CHECK:' + JSON.stringify(ids.map(id => ({
      id,
      times: api.getKeyframeTimes(id, 'position.x'),
      easing: api.getMagicEasing(id, 'position.x', id === ids[0] ? ${firstFrame} : ${firstFrame + 3}),
    }))));
  ` });
  const state = marked(inspected, 'CODEX_MOTION_CHECK:');
  if (JSON.stringify(state[0].times) !== JSON.stringify([range.start, firstFrame, range.start + 30, range.end + 1]) ||
      JSON.stringify(state[1].times) !== JSON.stringify([firstFrame + 3, range.start + 33]) ||
      state.some(item => item.easing?.easingName !== 'SlowInSlowOut')) {
    throw new Error(`Unexpected keyframes or easing: ${JSON.stringify(state)}`);
  }
  console.log(JSON.stringify({ verified: ['stagger', 'retime', 'loop'], state }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (scratchIds.length) {
    try {
      await call('execute_script', { script: `
        for (const id of ${JSON.stringify(scratchIds)}) {
          if (api.getAllSceneLayers().includes(id)) api.deleteLayer(id);
        }
        console.log('CODEX_SCRATCH_CLEANED');
      ` });
    } catch (error) {
      console.error(`Scratch cleanup failed for ${scratchIds.join(', ')}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  await client.close();
}
