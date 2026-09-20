// @ts-check
// Pont MCP : expose le registre d'outils NetsuRush aux CLI agents (claude/codex) via un serveur MCP
// stdio. L'agent SPAWN le serveur lui-même (config .mcp.json) ; ce serveur (mcp/stdio.js) est THIN :
// il reforwarde tools/list + tools/call vers le core HTTP (/rpc agent:toolList / agent:toolCall) →
// les outils s'exécutent dans LE process core (pont Python unique), permission appliquée.

const fs = require('fs');
const path = require('path');

const DEFAULT_SURFACE = 'pilot';

/** @param {{ registry:any, permissions:any, dataDir:string }} _deps */
function createMcpBridge(_deps) {
  const mcpDir = path.join(_deps.dataDir, 'mcp');
  try { fs.mkdirSync(mcpDir, { recursive: true }); } catch { /* noop */ }
  const stdioScript = path.join(__dirname, 'stdio.js');
  /** @type {Set<string>} */
  const written = new Set();

  const configFor = (surface) => path.join(mcpDir, `netsurush.${surface}.mcp.json`);

  /// One config per surface, and the surface rides in the child's environment.
  ///
  /// The CLI agent spawns this server itself, so nothing about the run reaches
  /// it except what the config carries. Without it, a composition editor got
  /// the whole registry — the Resolve catalogue included — and had to be told
  /// in prose to ignore most of it.
  function writeConfig(surface) {
    const coreUrl = process.env.NR_CORE_URL || `http://127.0.0.1:${process.env.NR_CORE_PORT || 8730}`;
    const token = process.env.NR_CORE_TOKEN || '';
    const cfg = {
      mcpServers: {
        netsurush: {
          command: process.execPath, // node courant (portable en bundle)
          args: [stdioScript],
          env: { NR_CORE_URL: coreUrl, NR_CORE_TOKEN: token, NR_SURFACE: surface },
        },
      },
    };
    try {
      fs.writeFileSync(configFor(surface), JSON.stringify(cfg, null, 2));
      written.add(surface);
    } catch { /* noop */ }
  }

  // Chemin du .mcp.json à passer à `claude --mcp-config`. Écrit paresseusement au 1er usage.
  /** @param {string} [surface] */
  function mcpConfigPath(surface) {
    const which = surface || DEFAULT_SURFACE;
    if (!written.has(which)) writeConfig(which);
    return configFor(which);
  }

  return { mcpConfigPath };
}

module.exports = { createMcpBridge };
