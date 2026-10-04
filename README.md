<img src="assets/icon.png" width="96" alt="Cavalry Codex plugin icon">

# Cavalry Codex Plugin

Connect Codex to Cavalry's native local MCP server to inspect compositions, build procedural motion graphics, and edit existing keyframe timing.

This independent community plugin forwards Cavalry's own MCP tools through a local SSE-to-stdio adapter. It also adds three structured motion tools for planning and applying stagger, retime, and loop closure edits. No cloud server or API key is needed for the local connection.

## Motion actions

Use `codex_motion_catalog` to see the action scopes. `codex_motion_plan` reads the current composition and returns a plan ID; `codex_motion_apply` rechecks the scene before editing. A plan expires after ten minutes or one apply attempt. The actions use the selected layers in selection order unless layer IDs are supplied.

| Action | Effect |
| --- | --- |
| `stagger` | Moves all existing keyframes on each selected layer by an increasing number of frames. |
| `retime` | Scales each layer's keyframe spacing around its first keyframe. A factor below 1 speeds it up; above 1 slows it down. |
| `loop` | Adds a keyframe one frame past the current composition end to match each selected numeric animated Attribute's starting value. Reports value and velocity continuity. |

Stagger and retime preserve the keyframe values and easing. They reject timing collisions or moves outside the composition. Loop closure checks only the selected numeric Attributes; inspect the full composition for other motion and visual seams. For repeated elements and procedural systems, use Cavalry's native Duplicator and behaviour nodes.

## Requirements

- macOS with Cavalry installed, open, and its native MCP server enabled.
- Node.js 20 or newer and npm.
- Python 3 and a recent Codex CLI with `codex plugin add`, available on PATH.
- Codex desktop for the plugin UI.

## Install globally

```sh
git clone https://github.com/ebuberpg-prog/cavalry-codex-plugin.git
cd cavalry-codex-plugin
npm ci --ignore-scripts
python3 scripts/install-global.py
```

The installer copies the package and dependencies into `~/plugins/cavalry`, adds it to the existing personal marketplace at `~/.agents/plugins/marketplace.json`, and installs/enables `cavalry@personal`. Other marketplace entries are preserved, and a timestamped catalog backup is saved before updating it. Git history, environment files, and logs are excluded from the installed copy.

Restart Codex and open a new chat. Keep Cavalry open and enable **Preferences → Enable MCP Server**. The default port is **6768**. Cavalry may ask whether ChatGPT or Codex can connect and run scripts for the session; allow the connection you initiated.

Try: **“Use Cavalry to inspect my current composition.”**

## Verify and update

```sh
npm run check
npm run verify
npm run verify:motion
```

`npm run verify` performs the native handshake, discovers tools, reads the preamble, compiles a harmless script, and executes only `console.log`. It does not edit artwork. `npm run verify:motion` creates two temporary Null layers, checks all three actions and easing preservation, and removes those layers afterward. It requires an open composition. The tested native server exposed 17 tools; this plugin adds three motion tools.

For updates:

```sh
git pull --ff-only
npm ci --ignore-scripts
python3 scripts/install-global.py
```

Restart Codex afterward. For local development, edit this checkout, check the connection, and rerun the installer to refresh the global copy. `node_modules` is ignored by Git and installed from the lockfile.

## Connection details

The adapter connects only to `http://127.0.0.1:6768/sse` by default. To use a different app port, pass `CAVALRY_MCP_PORT` in the MCP process environment. For a command-line verification, use `CAVALRY_MCP_PORT=YOUR_PORT npm run verify`.

The adapter provides the `X-Cavalry-MCP-Client-Name`, version, and fingerprint headers required by Cavalry. The stable fingerprint is a client identifier, not a credential. Cavalry controls session approval. Tool definitions, messages, results, and application instructions pass through without rewriting them.

The bundled skill reads `read_preamble` before execution and uses native documentation and script preflight checks. Normal user authorization and the application's restrictions continue to apply.

## Package contents

- `.codex-plugin/plugin.json`: plugin identity, icon, and skill/MCP declarations.
- `.mcp.json`: local transport launch configuration.
- `scripts/bridge.mjs`: transport adapter and motion-tool routing using the pinned official MCP SDK.
- `scripts/motion-runtime.mjs`: scene-side planning, keyframe edits, and verification.
- `scripts/motion-tools.mjs`: motion tool definitions and session-scoped plans.
- `scripts/install-global.py`: personal marketplace installer.
- `scripts/verify.mjs`: non-mutating smoke check.
- `scripts/verify-motion.mjs`: reversible live motion check.
- `skills/cavalry/SKILL.md`: Cavalry workflow guidance.

The package follows [OpenAI's plugin format](https://developers.openai.com/plugins/build/plugins). Plugin code, authored documentation, and the original plugin icon are MIT-licensed. See [NOTICE.md](NOTICE.md) for the independence notice.
