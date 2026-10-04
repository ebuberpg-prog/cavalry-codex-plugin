#!/usr/bin/env python3
"""Copy this plugin into the current user's personal Codex marketplace."""
import json
from pathlib import Path
import shutil
import subprocess
from datetime import datetime, timezone

source = Path(__file__).resolve().parent.parent
manifest = json.loads((source / '.codex-plugin/plugin.json').read_text())
name = manifest['name']
destination = Path.home() / 'plugins' / name
codex = shutil.which('codex')
if not codex:
    raise SystemExit('Install the Codex CLI and make codex available on PATH first.')
if not (source / 'node_modules/@modelcontextprotocol/sdk/package.json').is_file():
    raise SystemExit('Run npm ci --ignore-scripts in the repository first.')
if source.resolve() == destination.resolve():
    raise SystemExit('Run this installer from a separate checkout, not the installed plugin source.')
if destination.exists():
    existing = destination / '.codex-plugin/plugin.json'
    if not existing.is_file() or json.loads(existing.read_text()).get('name') != name:
        raise SystemExit(f'Refusing to replace an unrelated directory: {destination}')

catalog = Path.home() / '.agents/plugins/marketplace.json'
marketplace = json.loads(catalog.read_text()) if catalog.exists() else {
    'name': 'personal', 'interface': {'displayName': 'Personal'}, 'plugins': []
}
entry = {'name': name, 'source': {'source': 'local', 'path': f'./plugins/{name}'},
         'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'},
         'category': 'Creativity'}
for item in marketplace['plugins']:
    if item['name'] == name and item.get('source') != entry['source']:
        raise SystemExit(f'A different {name} source is already registered in the personal marketplace.')

catalog.parent.mkdir(parents=True, exist_ok=True)
if catalog.exists():
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    shutil.copy2(catalog, catalog.with_name(f'marketplace.{timestamp}.backup.json'))
shutil.copytree(source, destination, dirs_exist_ok=True,
                ignore=shutil.ignore_patterns('.git', '.DS_Store', '__pycache__', '.env', '.env.*', '*.log'))
marketplace['plugins'] = [item for item in marketplace['plugins'] if item['name'] != name] + [entry]
temporary = catalog.with_suffix('.json.new')
temporary.write_text(json.dumps(marketplace, indent=2) + '\n')
temporary.replace(catalog)
subprocess.run([codex, 'plugin', 'add', f"{name}@{marketplace['name']}", '--json'], check=True)
print(f'Installed {name}. Restart Codex and open a new chat. Keep the app and its MCP server running.')
