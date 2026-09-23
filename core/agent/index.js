// @ts-check
// Façade du module agent (Chat IA). Assemble : registre d'outils (modules NetsuRush existants +,
// plus tard, catalogue Resolve), porte de permission, session (CLI + BYOK), serveur MCP (exposition
// aux CLI agents) et persistance des conversations. Consommé par core/rpc.js.

const { createToolRegistry } = require('./tools/registry');
const { createNetsuRushTools } = require('./tools/netsurush');
const { createPermissions } = require('./permissions');
const { createSession } = require('./session');
const { createChatStore } = require('./store');
const { openAgentLogin, openAgentInstall } = require('./login'); // terminal interactif
const { createResolveTools } = require('./tools/resolve'); // catalogue Resolve (compound dispatchers)
const { createReferenceTools } = require('./tools/reference'); // board de référence (mood-board)
const { createFlowTools } = require('./tools/flow'); // NetsuFlow : lecture + PROPOSITION, jamais d'écriture
const { createResolveMcp } = require('./tools/resolveMcp'); // serveur MCP officiel Blackmagic, replié dans le registre
const { createMcpBridge } = require('./mcp/server'); // serveur MCP stdio exposant le registry aux CLI
const { t } = require('../i18n');

/**
 * @param {{
 *   broadcast:(ch:string,p:any)=>void, ev:any, dataDir:string,
 *   modules:{ resolveMod:any, timeline:any, sidecars:any, thumbs:any, proxy:any, ffmpeg:any,
 *             aeExporter:any, refStore:any, flow:any,
 *             guarded:(fn:Function)=>Function, rOp:(fn:Function)=>Function }
 * }} deps
 */
function createAgent(deps) {
  const { broadcast, ev, dataDir, modules } = deps;

  const registry = createToolRegistry();
  registry.registerAll(createNetsuRushTools({ ...modules, ev }));
  registry.registerAll(createResolveTools({ ...modules, ev }));
  registry.registerAll(createReferenceTools({ refStore: modules.refStore, broadcast }));
  // Surface `flow` uniquement : le catalogue Resolve n'a rien à faire dans un
  // éditeur de composition, et réciproquement.
  registry.registerAll(createFlowTools({ flow: modules.flow }));

  // Serveur MCP officiel de Blackmagic (livré avec Resolve Studio 21.1+). Ses
  // outils sont DÉCOUVERTS, pas déclarés ici : ils arrivent donc dans le
  // registre après coup, et `send` attend `ready()` avant de composer sa liste.
  // Absent (Resolve pas installé, édition gratuite) : le reste fonctionne.
  const resolveMcp = createResolveMcp({ registry });
  void resolveMcp.ready();

  const permissions = createPermissions({ broadcast });
  // Numerote les appels venus du pont MCP, pour que chaque resultat retrouve la
  // ligne qui l'attend dans la trace.
  let mcpCallSeq = 0;
  const store = createChatStore(dataDir);

  // Serveur MCP : écrit un .mcp.json pointant sur lui-même et l'expose aux CLI agents (claude --mcp-config).
  const mcp = createMcpBridge({ registry, permissions, dataDir });

  const session = createSession({
    registry, permissions, broadcast, dataDir, resolveMcp,
    mcpConfigPath: (surface) => mcp.mcpConfigPath(surface),
  });

  return {
    // Session / moteur
    configure: session.configure,
    listAgents: session.listAgents,
    /// Modeles d'un fournisseur, tires de son API quand une cle est en place et
    /// du catalogue public d'OpenRouter sinon — jamais d'une liste tapee a la main.
    listModels: (/** @type {any} */ request) => session.listModels(request || {}),
    send: session.send,
    cancel: session.cancel,
    /// Arrêt du core : le serveur MCP de Blackmagic est un processus enfant, et
    /// le laisser derrière garderait une connexion ouverte sur Resolve.
    cancelAll: () => { session.cancelAll(); resolveMcp.close(); },
    respondApproval: session.respondApproval,
    // Outils (debug / UI)
    describeTools: () => registry.describe(),
    /// Le test de connexion. Les clés vivent dans la session (en RAM) : le
    /// panneau n'a pas à les renvoyer pour tester celle qui est déjà en place.
    probe: (/** @type {any} */ request) => session.probe(request || {}),
    login: (/** @type {any} */ request) => openAgentLogin(request || {}),
    install: (/** @type {any} */ request) => openAgentInstall(request || {}),

    // Pont MCP (serveur stdio thin) : liste + exécution sous permission (contexte CLI).
    // Narrowed rather than trusted: the surface arrives from a spawned process's
    // environment, so an unknown value falls back instead of filtering to none.
    toolList: (/** @type {string|undefined} */ surface) => registry.toMcpTools(
      registry.SURFACES.includes(/** @type {any} */ (surface)) ? /** @type {any} */ (surface) : 'pilot',
    ),
    ///
    /// Diffuse `tool_use` puis `tool_result`, exactement comme la boucle BYOK.
    /// Il ne diffusait rien : avec un agent CLI, l'interface ne voyait donc ni
    /// l'appel ni son resultat. Dans NetsuFlow, ou la proposition de montage
    /// VOYAGE dans le resultat de `flow_propose`, cela voulait dire un agent qui
    /// repond « proposition prete » sans qu'aucune carte n'apparaisse et sans
    /// bouton pour l'appliquer — la fonction entiere hors service.
    toolCall: async (/** @type {string} */ name, /** @type {any} */ input) => {
      const tool = registry.get(name);
      const risk = (tool && (tool.riskFor ? tool.riskFor(input) : tool.risk)) || 'read';
      const runId = session.currentCliRun();
      // Un identifiant d'appel stable, pour que le resultat retrouve sa ligne.
      const callId = `mcp-${Date.now().toString(36)}-${(mcpCallSeq += 1)}`;
      const emit = (/** @type {any} */ ev) => { if (runId) broadcast('chat:event', { runId, ev }); };

      emit({ type: 'tool_use', id: callId, name, input });
      const perm = await permissions.check('cli', { name, input, risk });
      if (!perm.approved) {
        const refused = { ok: false, error: perm.reason || t('agentActionRefused') };
        emit({ type: 'tool_result', id: callId, ok: false, content: refused });
        return refused;
      }
      const result = await registry.execute(name, input, { runId: runId || 'cli' });
      // `ok` vient du resultat quand il en porte un : un outil qui echoue sans
      // lever doit s'afficher en echec, pas en succes silencieux.
      emit({
        type: 'tool_result', id: callId,
        ok: !(result && typeof result === 'object' && result.ok === false),
        content: result,
      });
      return result;
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
