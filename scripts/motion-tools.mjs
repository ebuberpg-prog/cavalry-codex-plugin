import { randomUUID } from 'node:crypto';
import { buildMotionScript } from './motion-runtime.mjs';

const motionArgs = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['stagger', 'retime', 'loop'] },
    layerIds: { type: 'array', items: { type: 'string' }, description: 'Omit to use the current selection, in selection order.' },
    stepFrames: { type: 'integer', minimum: 1, maximum: 120, description: 'Stagger: additional frames per selected layer.' },
    factor: { type: 'number', minimum: 0.1, maximum: 8, description: 'Retime: scale keyframe spacing per layer; below 1 is faster.' },
  },
  required: ['action'],
  additionalProperties: false,
};

export const motionToolDefinitions = [
  {
    name: 'codex_motion_catalog',
    description: 'List the three editable Cavalry keyframe actions and their exact scope. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'codex_motion_plan',
    description: 'Inspect selected keyframed layers and prepare a stagger, retime, or loop edit without changing the final scene. Returns a session-scoped planId for codex_motion_apply.',
    inputSchema: motionArgs,
  },
  {
    name: 'codex_motion_apply',
    description: 'Apply a previously inspected motion plan if the scene still matches it. Keyframe moves retain their values and interpolation; the loop action closes selected numeric Attributes at one frame past the current composition end.',
    inputSchema: {
      type: 'object',
      properties: { planId: { type: 'string' } },
      required: ['planId'],
      additionalProperties: false,
    },
  },
];

const catalog = {
  stagger: 'Move all existing keyframes on selected layers by 0, stepFrames, 2×stepFrames, etc. Uses selection order. Does not create layers or change values/easing.',
  retime: 'Scale each selected layer’s keyframe spacing around its first keyframe. Preserves keyframe values/easing. Rejects collisions and moves outside the composition.',
  loop: 'At the current composition start/end range, key the selected numeric animated Attributes to their starting values one frame after the end. Reports value and velocity continuity. Other motion and visual seams still need inspection.',
};

function resultText(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError };
}

function readMotionResult(result) {
  const allText = (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  const marker = 'CODEX_MOTION_RESULT:';
  const index = allText.lastIndexOf(marker);
  if (index < 0) throw new Error('Cavalry did not return a motion result. Inspect the scene before retrying.');
  return JSON.parse(allText.slice(index + marker.length).split(/\r?\n/)[0]);
}

export function createMotionHandler(callNative) {
  const plans = new Map();
  let preambleRead = false;

  async function run(request) {
    if (!preambleRead) {
      const preamble = await callNative('read_preamble', {});
      if (preamble.isError) throw new Error('Cavalry preamble could not be read.');
      preambleRead = true;
    }
    const script = buildMotionScript(request);
    const preflight = await callNative('preflight_script', { script });
    if (preflight.isError) throw new Error('Cavalry rejected the motion script during preflight.');
    const response = await callNative('execute_script', { script });
    if (response.isError) throw new Error('Cavalry could not run the motion script. Inspect the scene before retrying.');
    return readMotionResult(response);
  }

  return async function handleMotion(name, args = {}) {
    try {
      if (name === 'codex_motion_catalog') return resultText(catalog);
      if (name === 'codex_motion_plan') {
        for (const [id, saved] of plans) if (Date.now() - saved.createdAt > 10 * 60 * 1000) plans.delete(id);
        if (plans.size >= 100) return resultText({ error: 'Too many active motion plans. Apply an existing plan or reconnect.' }, true);
        const request = { ...args, mode: 'plan' };
        const plan = await run(request);
        if (!plan.ok) return resultText(plan, true);
        const planId = randomUUID();
        plans.set(planId, { request, plan, createdAt: Date.now() });
        return resultText({ planId, ...plan });
      }
      if (name === 'codex_motion_apply') {
        const saved = plans.get(args.planId);
        if (!saved) return resultText({ error: 'Plan not found in this connection. Plan the action again.' }, true);
        plans.delete(args.planId);
        if (Date.now() - saved.createdAt > 10 * 60 * 1000) {
          return resultText({ error: 'Plan expired. Plan the action again.' }, true);
        }
        const current = await run(saved.request);
        if (!current.ok || JSON.stringify(current) !== JSON.stringify(saved.plan)) {
          return resultText({ error: 'The scene changed since planning. Plan the action again.', current }, true);
        }
        const applied = await run({ ...saved.request, mode: 'apply' });
        return resultText(applied, !applied.ok);
      }
      return resultText({ error: 'Unknown motion tool.' }, true);
    } catch (error) {
      return resultText({ error: String(error.message || error), retry: 'Inspect the Cavalry scene before retrying.' }, true);
    }
  };
}
