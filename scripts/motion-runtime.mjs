// This function is serialized into Cavalry's JavaScript context. Keep it self-contained.
export function motionRuntime(api, request) {
  let phase = 'planning';
  let originalFrame;
  let originalEnd;
  let comp;
  let widened = false;
  const fail = message => { throw new Error(message); };
  const integer = value => Number.isInteger(value);
  const same = (a, b) => Math.abs(a - b) <= 1e-6;

  try {
    if (!['stagger', 'retime', 'loop'].includes(request.action)) fail('Unknown motion action.');
    if (!['plan', 'apply'].includes(request.mode)) fail('Mode must be plan or apply.');
    comp = api.getActiveComp();
    if (!comp) fail('Open a Cavalry composition first.');
    const compStart = api.get(comp, 'startFrame');
    const compEnd = api.get(comp, 'endFrame');
    if (!integer(compStart) || !integer(compEnd) || compEnd < compStart) {
      fail('The composition has an invalid frame range.');
    }
    originalFrame = api.getFrame();
    originalEnd = compEnd;

    const ids = request.layerIds === undefined ? api.getSelection() : request.layerIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 ||
        ids.some(id => typeof id !== 'string' || !id)) {
      fail('Select 1–100 layers or supply their layer IDs.');
    }
    if (new Set(ids).size !== ids.length) fail('Layer IDs must be unique.');
    const present = new Set(api.getAllSceneLayers());
    for (const id of ids) if (!present.has(id)) fail('Layer no longer exists: ' + id);

    if (request.action === 'stagger') {
      if (!integer(request.stepFrames) || request.stepFrames < 1 || request.stepFrames > 120) {
        fail('stepFrames must be an integer from 1 to 120.');
      }
      if (ids.length < 2) fail('Stagger needs at least two layers.');
    }
    if (request.action === 'retime' &&
        (typeof request.factor !== 'number' || !Number.isFinite(request.factor) ||
         request.factor < 0.1 || request.factor > 8 || request.factor === 1)) {
      fail('factor must be between 0.1 and 8, excluding 1.');
    }

    const layers = [];
    let totalKeys = 0;
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      const attrs = [...new Set(api.getAnimatedAttributes(id) || [])];
      if (!attrs.length) fail('No keyframed Attributes on ' + api.getNiceName(id) + '.');
      const connected = new Set(api.getInConnectedAttributes(id) || []);
      const entries = [];
      for (const attr of attrs) {
        if ([...connected].some(input => input === attr || attr.startsWith(input + '.') || input.startsWith(attr + '.'))) {
          fail(id + '.' + attr + ' is driven by a connection.');
        }
        const times = [...(api.getKeyframeTimes(id, attr) || [])].sort((a, b) => a - b);
        if (!times.length || times.some(t => !integer(t))) fail('Invalid keyframe times on ' + id + '.' + attr);
        if (new Set(times).size !== times.length) fail('Duplicate keyframe times on ' + id + '.' + attr);
        totalKeys += times.length;
        if (totalKeys > 2000) fail('Limit this action to 2,000 keyframes.');
        entries.push({ attr, times });
      }
      layers.push({ id, name: api.getNiceName(id), index, entries });
    }

    const plan = {
      action: request.action,
      mode: request.mode,
      composition: { startFrame: compStart, endFrame: compEnd },
      layers: [],
      keyframeCount: totalKeys,
      warnings: [],
    };

    if (request.action === 'stagger' || request.action === 'retime') {
      for (const layer of layers) {
        const anchor = Math.min(...layer.entries.flatMap(entry => entry.times));
        const offset = request.action === 'stagger' ? layer.index * request.stepFrames : 0;
        const attributes = [];
        for (const entry of layer.entries) {
          const moves = entry.times.map(from => ({
            from,
            to: request.action === 'stagger'
              ? from + offset
              : anchor + Math.round((from - anchor) * request.factor),
          }));
          if (new Set(moves.map(move => move.to)).size !== moves.length) {
            fail('Retiming would merge keyframes on ' + layer.id + '.' + entry.attr + '.');
          }
          if (moves.some(move => move.to < compStart || move.to > compEnd)) {
            fail('Keyframes on ' + layer.id + '.' + entry.attr + ' would leave the composition range.');
          }
          attributes.push({ attr: entry.attr, moves });
        }
        plan.layers.push({ id: layer.id, name: layer.name, offsetFrames: offset, anchorFrame: anchor, attributes });
      }
      if (!plan.layers.some(layer => layer.attributes.some(entry => entry.moves.some(move => move.from !== move.to)))) {
        fail('The requested timing leaves every keyframe unchanged.');
      }
      if (request.mode === 'apply') {
        phase = 'applying';
        for (const layer of plan.layers) {
          for (const entry of layer.attributes) {
            const changed = entry.moves.filter(move => move.from !== move.to);
            const ordered = request.action === 'retime' && request.factor < 1
              ? changed.sort((a, b) => a.from - b.from)
              : changed.sort((a, b) => b.from - a.from);
            for (const move of ordered) {
              api.modifyKeyframe(layer.id, { [entry.attr]: { frame: move.from, newFrame: move.to } });
            }
          }
        }
        phase = 'verifying';
        for (const layer of plan.layers) {
          for (const entry of layer.attributes) {
            const expected = entry.moves.map(move => move.to).sort((a, b) => a - b);
            const actual = [...api.getKeyframeTimes(layer.id, entry.attr)].sort((a, b) => a - b);
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              fail('Keyframe timing verification failed on ' + layer.id + '.' + entry.attr + '.');
            }
          }
        }
      }
    } else {
      const closureFrame = compEnd + 1;
      plan.closureFrame = closureFrame;
      for (const layer of layers) {
        const attributes = [];
        for (const entry of layer.entries) {
          if (entry.times.includes(closureFrame)) {
            fail('A keyframe already exists at the loop closure on ' + layer.id + '.' + entry.attr + '.');
          }
          if (entry.times.some(time => time > closureFrame)) {
            fail('Keyframes beyond the loop closure exist on ' + layer.id + '.' + entry.attr + '.');
          }
          api.setFrame(compStart);
          const startValue = api.get(layer.id, entry.attr);
          if (typeof startValue !== 'number' || !Number.isFinite(startValue)) {
            fail('Loop closure currently supports numeric Attributes only: ' + layer.id + '.' + entry.attr + '.');
          }
          const lastFrame = entry.times[entry.times.length - 1];
          api.setFrame(lastFrame);
          const lastValue = api.get(layer.id, entry.attr);
          if (closureFrame - lastFrame < 6 && typeof lastValue === 'number' && !same(startValue, lastValue)) {
            plan.warnings.push(layer.name + '.' + entry.attr + ' has fewer than six frames to return to its start value.');
          }
          attributes.push({ attr: entry.attr, startValue, addStartKey: !entry.times.includes(compStart), lastFrame });
        }
        plan.layers.push({ id: layer.id, name: layer.name, attributes });
      }
      api.setFrame(originalFrame);
      if (request.mode === 'apply') {
        phase = 'applying';
        api.set(comp, { endFrame: closureFrame });
        widened = true;
        for (const layer of plan.layers) {
          for (const entry of layer.attributes) {
            if (entry.addStartKey) api.keyframe(layer.id, compStart, { [entry.attr]: entry.startValue });
            api.keyframe(layer.id, closureFrame, { [entry.attr]: entry.startValue });
          }
        }
        phase = 'verifying';
        const seams = [];
        for (const layer of plan.layers) {
          for (const entry of layer.attributes) {
            api.setFrame(compStart);
            const atStart = api.get(layer.id, entry.attr);
            api.setFrame(Math.min(compStart + 1, closureFrame));
            const afterStart = api.get(layer.id, entry.attr);
            api.setFrame(Math.max(compStart, closureFrame - 1));
            const beforeClosure = api.get(layer.id, entry.attr);
            api.setFrame(closureFrame);
            const atClosure = api.get(layer.id, entry.attr);
            const verified = typeof atStart === 'number' && typeof atClosure === 'number' && same(atStart, atClosure);
            const entryStep = afterStart - atStart;
            const exitStep = atClosure - beforeClosure;
            const velocityMatches = Math.abs(entryStep - exitStep) <= Math.max(0.001, Math.max(Math.abs(entryStep), Math.abs(exitStep)) * 0.01);
            seams.push({ id: layer.id, attr: entry.attr, atStart, atClosure, verified, entryStep, exitStep, velocityMatches });
          }
        }
        plan.seams = seams;
        plan.valuesMatch = seams.every(seam => seam.verified);
        plan.velocityMatches = seams.every(seam => seam.velocityMatches);
        if (!plan.valuesMatch) fail('Loop values did not match at the closure frame.');
        if (!plan.velocityMatches) plan.warnings.push('Some loop velocities differ at the seam; adjust easing or tangents for a fully smooth cycle.');
      }
      plan.warnings.push('Loop check covers selected numeric Attributes; inspect the full composition for other motion and visual seams.');
    }

    return { ok: true, ...plan };
  } catch (error) {
    return { ok: false, action: request.action, mode: request.mode, phase, error: String(error.message || error) };
  } finally {
    if (widened) api.set(comp, { endFrame: originalEnd });
    if (originalFrame !== undefined) api.setFrame(originalFrame);
  }
}

export function buildMotionScript(request) {
  return `const result = (${motionRuntime.toString()})(api, ${JSON.stringify(request)});\nconsole.log('CODEX_MOTION_RESULT:' + JSON.stringify(result));`;
}
