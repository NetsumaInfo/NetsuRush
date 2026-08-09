// @ts-check
// Façade du module agent (Chat IA). Assemble : registre d'outils (modules NetsuRush existants +,
// plus tard, catalogue Resolve), porte de permission, session (CLI + BYOK), serveur MCP (exposition
// aux CLI agents) et persistance des conversations. Consommé par core/rpc.js.

const { createToolRegistry } = require('./tools/registry');
const { createNetsuRushTools } = require('./tools/netsurush');
const { createPermissions } = require('./permissions');
const { createSession } = require('./session');
const { createChatStore } = require('./store');
const { createResolveTools } = require('./tools/resolve'); // catalogue Resolve (compound dispatchers)
const { createReferenceTools } = require('./tools/reference'); // board de référence (mood-board)
const { createMcpBridge } = require('./mcp/server'); // serveur MCP stdio exposant le registry aux CLI

/**
 * @param {{
 *   broadcast:(ch:string,p:any)=>void, ev:any, dataDir:string,
 *   modules:{ resolveMod:any, timeline:any, sidecars:any, thumbs:any, proxy:any, ffmpeg:any,
 *             aeExporter:any, refStore:any, guarded:(fn:Function)=>Function, rOp:(fn:Function)=>Function }
 * }} deps
 */
function createAgent(deps) {
  const { broadcast, ev, dataDir, modules } = deps;

  const registry = createToolRegistry();
  registry.registerAll(createNetsuRushTools({ ...modules, ev }));
  registry.registerAll(createResolveTools({ ...modules, ev }));
  registry.registerAll(createReferenceTools({ refStore: modules.refStore, broadcast }));

  const permissions = createPermissions({ broadcast });
  const store = createChatStore(dataDir);

  // Serveur MCP : écrit un .mcp.json pointant sur lui-même et l'expose aux CLI agents (claude --mcp-config).
  const mcp = createMcpBridge({ registry, permissions, dataDir });

  const session = createSession({
    registry, permissions, broadcast,
    mcpConfigPath: () => mcp.mcpConfigPath(),
  });

  return {
    // Session / moteur
    configure: session.configure,
    listAgents: session.listAgents,
    send: session.send,
    cancel: session.cancel,
    cancelAll: session.cancelAll,
    respondApproval: session.respondApproval,
    // Outils (debug / UI)
    describeTools: () => registry.describe(),
    // Pont MCP (serveur stdio thin) : liste + exécution sous permission (contexte CLI).
    toolList: () => registry.toMcpTools(),
    toolCall: async (/** @type {string} */ name, /** @type {any} */ input) => {
      const t = registry.get(name);
      const risk = (t && (t.riskFor ? t.riskFor(input) : t.risk)) || 'read';
      const perm = await permissions.check('cli', { name, input, risk });
      if (!perm.approved) return { ok: false, error: perm.reason || 'action refusée' };
      return registry.execute(name, input, { runId: 'cli' });
    },
    // Historique
    listConversations: store.listConversations,
    loadConversation: store.loadConversation,
    saveConversation: store.saveConversation,
    deleteConversation: store.deleteConversation,
    // Exposés pour le serveur MCP autonome (sidecar) si besoin
    registry, permissions,
  };
}

module.exports = { createAgent };
