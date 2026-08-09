// @ts-check
// Pont MCP : expose le registre d'outils NetsuRush aux CLI agents (claude/codex) via un serveur MCP
// stdio. L'agent SPAWN le serveur lui-même (config .mcp.json) ; ce serveur (mcp/stdio.js) est THIN :
// il reforwarde tools/list + tools/call vers le core HTTP (/rpc agent:toolList / agent:toolCall) →
// les outils s'exécutent dans LE process core (pont Python unique), permission appliquée.

const fs = require('fs');
const path = require('path');

/** @param {{ registry:any, permissions:any, dataDir:string }} _deps */
function createMcpBridge(_deps) {
  const mcpDir = path.join(_deps.dataDir, 'mcp');
  try { fs.mkdirSync(mcpDir, { recursive: true }); } catch { /* noop */ }
  const stdioScript = path.join(__dirname, 'stdio.js');
  const configPath = path.join(mcpDir, 'netsurush.mcp.json');
  let written = false;

  function writeConfig() {
    const coreUrl = process.env.NR_CORE_URL || `http://127.0.0.1:${process.env.NR_CORE_PORT || 8730}`;
    const token = process.env.NR_CORE_TOKEN || '';
    const cfg = {
      mcpServers: {
        netsurush: {
          command: process.execPath, // node courant (portable en bundle)
          args: [stdioScript],
          env: { NR_CORE_URL: coreUrl, NR_CORE_TOKEN: token },
        },
      },
    };
    try { fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2)); written = true; } catch { /* noop */ }
  }

  // Chemin du .mcp.json à passer à `claude --mcp-config`. Écrit paresseusement au 1er usage.
  function mcpConfigPath() {
    if (!written) writeConfig();
    return configPath;
  }

  return { mcpConfigPath };
}

module.exports = { createMcpBridge };
